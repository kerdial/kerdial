import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  DEFAULT_MIGRATIONS_FOLDER,
  ROLE_PASSWORD_ENV_VARS,
  runMigrations,
} from "./migrate-main.js";

/**
 * SH-31 (FR-47, AC-37) — the one-shot `migrate` service's
 * runner, against a real Postgres.
 *
 * The *compose* half of AC-37 (a failing migration leaves `api` never healthy)
 * is proved by bringing the real stack up; what this suite proves is the half it
 * rests on — that this runner **throws** on a failing migration rather than
 * exiting 0, because `condition: service_completed_successfully` is only a gate
 * if the exit code is honest.
 */

const here = dirname(fileURLToPath(import.meta.url));

function connectionUrl(
  container: StartedPostgreSqlContainer,
  role: string,
  password: string,
): string {
  return `postgres://${role}:${password}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`;
}

describe("migrate-main (SH-31)", () => {
  let container: StartedPostgreSqlContainer;
  let superUrl: string;
  let admin: postgres.Sql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    superUrl = container.getConnectionUri();
    admin = postgres(superUrl, { max: 1, onnotice: () => undefined });
  }, 180_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await container?.stop();
  });

  const env = (
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => ({
    MIGRATE_DATABASE_URL: superUrl,
    APP_WEB_PASSWORD: "web-pass-integration",
    APP_INGEST_PASSWORD: "ingest-pass-integration",
    ...overrides,
  });

  it("migrates a fresh database and leaves app_web/app_ingest able to log in", async () => {
    await runMigrations({ env: env(), log: () => undefined });

    const tableCount = await admin<{ count: string }[]>`
      select count(*)::text as count from information_schema.tables where table_schema = 'public'
    `;
    expect(Number(tableCount[0]?.count)).toBeGreaterThan(20);

    // The credential half, proved by actually connecting — a role that exists
    // and cannot log in is exactly what makes the startup chain stall one step
    // after the gate.
    for (const [role, envVar] of ROLE_PASSWORD_ENV_VARS) {
      const password = env()[envVar]!;
      const client = postgres(connectionUrl(container, role, password), {
        max: 1,
        connect_timeout: 5,
        onnotice: () => undefined,
      });
      try {
        const [row] = await client<{ me: string }[]>`select current_user as me`;
        expect(row?.me).toBe(role);
      } finally {
        await client.end({ timeout: 5 });
      }
    }
  }, 120_000);

  it("is idempotent — a second run over an already-migrated database succeeds", async () => {
    await expect(runMigrations({ env: env(), log: () => undefined })).resolves.toBeUndefined();
  }, 60_000);

  /**
   * The defect the GATE-6 restore drill found, reproduced in
   * the small: a database in exactly the state `pg_restore` leaves it in.
   *
   * The restored state is *not* "an old database". It is a **fully migrated**
   * database — 35 journal rows, every table present — with one thing missing:
   * the `pgboss` schema, which any dump of this database excludes on purpose
   * (see `migrate-main.ts`). `DROP SCHEMA pgboss CASCADE` while
   * leaving `drizzle.__drizzle_migrations` untouched is that state exactly.
   *
   * The test does the red half itself, so it can never pass vacuously: it first
   * runs drizzle's own migrator against that state and asserts the schema is
   * **still absent** — the empirically confirmed root cause (the migrator reads
   * only the newest journal row's `created_at` as a watermark, so `0031` is
   * below it and is skipped) — and only then runs the real `migrate` step.
   */
  it("repairs a restored database: recreates the pgboss schema drizzle's journal makes unreachable", async () => {
    const pgbossOwner = async (): Promise<string | undefined> => {
      const rows = await admin<{ owner: string }[]>`
        select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'
      `;
      return rows[0]?.owner;
    };

    // Migration 0031 put it there on the fresh run above.
    expect(await pgbossOwner()).toBe("app_ingest");

    // The restore, simulated: the schema the dump excludes is gone; the journal
    // the dump *does* carry is untouched.
    await admin.unsafe("drop schema pgboss cascade");
    const journal = await admin<{ count: string; watermark: string }[]>`
      select count(*)::text as count, max(created_at)::text as watermark
        from drizzle.__drizzle_migrations
    `;
    expect(Number(journal[0]?.count)).toBeGreaterThan(30);
    expect(await pgbossOwner()).toBeUndefined();

    // Red half — drizzle alone cannot repair this. Exits happily, applies
    // nothing, leaves the schema absent. This is the observation that makes
    // "re-run the migrator" a non-remediation.
    const sql = postgres(superUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(createDb(sql), { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect(await pgbossOwner()).toBeUndefined();
    const afterDrizzle = await admin<{ watermark: string }[]>`
      select max(created_at)::text as watermark from drizzle.__drizzle_migrations
    `;
    expect(afterDrizzle[0]?.watermark).toBe(journal[0]?.watermark);

    // Green half — the `migrate` service's real entrypoint, which is what the
    // compose chain and the restore procedure both run.
    const lines: string[] = [];
    await runMigrations({ env: env(), log: (message) => lines.push(message) });

    expect(await pgbossOwner()).toBe("app_ingest");
    expect(lines).toContainEqual(expect.stringContaining("pgboss schema CREATED"));

    // Ownership proved **as the real role**, never as the container's superuser
    // (which is blind to a missing privilege): `app_ingest` must be able to
    // build objects in that schema, because that is precisely what the worker's
    // `PgBoss` does with `migrate: true, createSchema: false` on its next start.
    const ingest = postgres(connectionUrl(container, "app_ingest", env()["APP_INGEST_PASSWORD"]!), {
      max: 1,
      connect_timeout: 5,
      onnotice: () => undefined,
    });
    try {
      await ingest.unsafe("create table pgboss.restore_probe (x int)");
      await ingest.unsafe("drop table pgboss.restore_probe");
    } finally {
      await ingest.end({ timeout: 5 });
    }

    // Idempotent on the way back: a second run reports the no-op, not a create.
    const second: string[] = [];
    await runMigrations({ env: env(), log: (message) => second.push(message) });
    expect(second).toContainEqual(expect.stringContaining("pgboss schema already present"));
  }, 120_000);

  it("throws on a failing migration instead of exiting 0 (AC-37's precondition)", async () => {
    // A copy of the real migrations directory with one extra, deliberately
    // broken file appended to the journal — the same shape a bad migration
    // would have. Run against the already-migrated database from the first
    // test: drizzle skips every migration whose hash it has already applied, so
    // the *only* statement this run issues is the broken one.
    const folder = await mkdtemp(join(tmpdir(), "migrate-fail-"));
    await cp(DEFAULT_MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
    };
    const lastIdx = journal.entries[journal.entries.length - 1]!.idx;
    journal.entries.push({
      idx: lastIdx + 1,
      when: Date.now(),
      tag: "9999_deliberately-broken",
      breakpoints: true,
    });
    await writeFile(journalPath, JSON.stringify(journal), "utf8");
    await writeFile(
      join(folder, "9999_deliberately-broken.sql"),
      "ALTER TABLE this_table_does_not_exist ADD COLUMN nope text;",
      "utf8",
    );

    await expect(
      runMigrations({ env: env(), migrationsFolder: folder, log: () => undefined }),
    ).rejects.toThrow(/this_table_does_not_exist/);
  }, 120_000);

  it("refuses a migrations directory with no journal rather than reporting success", async () => {
    const empty = await mkdtemp(join(tmpdir(), "migrate-empty-"));
    await mkdir(join(empty, "meta"), { recursive: true });

    await expect(
      runMigrations({ env: env(), migrationsFolder: empty, log: () => undefined }),
    ).rejects.toThrow(/no migration journal/);
  });

  it("refuses to run without the owner connection", async () => {
    await expect(
      runMigrations({ env: env({ MIGRATE_DATABASE_URL: undefined }), log: () => undefined }),
    ).rejects.toThrow(/MIGRATE_DATABASE_URL is required/);
  });

  it("refuses to run without a password for each application role", async () => {
    await expect(
      runMigrations({ env: env({ APP_INGEST_PASSWORD: "  " }), log: () => undefined }),
    ).rejects.toThrow(/APP_INGEST_PASSWORD is required/);
  });

  it("resolves its default migrations folder to the repo's own, in src and in dist alike", () => {
    expect(DEFAULT_MIGRATIONS_FOLDER).toBe(join(here, "..", "migrations"));
  });
});
