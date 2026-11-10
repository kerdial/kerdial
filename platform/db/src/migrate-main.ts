import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "./client.js";
import { seedPendingInstrumentBackfillState } from "./seed-backfill-state.js";

/**
 * SH-31 (`self-hosted-deploy` FR-47, AC-37) — the one-shot
 * `migrate` service's entrypoint.
 *
 * **Why this file exists rather than `drizzle-kit migrate`.** `scripts/dev-up.sh`
 * migrates with `drizzle-kit`, which is a **devDependency** and is therefore not
 * in the application image at all (`Dockerfile`'s `prod-deps` stage installs
 * `--prod`). `drizzle-orm/postgres-js/migrator` is a production dependency,
 * reads the same `platform/db/migrations` directory and the same
 * `meta/_journal.json`, and is what every Testcontainers suite in this repo
 * already applies migrations with. The migration SQL travels with the image
 * (`Dockerfile`'s explicit `COPY platform/db/migrations`).
 *
 * **Why it connects as the bootstrap superuser and not as `app_owner`.**
 * The obvious design is "one-shot; drizzle-kit migrate as `app_owner`". On a fresh
 * named volume `app_owner` **does not exist yet** — migration `0007` is what
 * creates it, so a role cannot run the migration that creates it. Migration
 * `0007` is written for exactly this: it `ALTER TABLE ... OWNER TO app_owner`s
 * every table so ownership lands on `app_owner` "regardless of which role a
 * given environment happens to connect as" (its own comment). This entrypoint
 * therefore takes the compose stack's Postgres superuser, and the *ownership*
 * half of that intent is preserved by the migrations themselves. Recorded as
 * a deviation, not silently reconciled.
 *
 * **Why it also sets the application roles' passwords.** `0007` creates
 * `app_web`/`app_ingest` deliberately without credentials ("provisioned at
 * deploy time, never checked into a migration"). Nothing else in the compose stack can provision them, and without
 * them `api` and `worker` cannot connect at all — so on a fresh volume the
 * startup chain would stop dead one step after the gate it exists to enforce.
 * This is the same step `scripts/dev-up.sh` does by hand (its step 3), moved to
 * the one service that already has the owner connection. It is idempotent:
 * re-running sets the same passwords again.
 *
 * **Why it also re-asserts the `pgboss` schema** (found by the
 * GATE-6 restore drill): for exactly the same reason. A restored database has no
 * `pgboss` schema (the dump excludes it) and cannot get one from a migration
 * (drizzle's journal restores with it already marked applied) or from the
 * application (`app_ingest` holds no database-level `CREATE`) — so `api` crashed
 * with `pg-boss is not installed` after every restore. See
 * {@link PGBOSS_SCHEMA_STATEMENT}.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `src/../migrations` in the repo and `dist/../migrations` in the image are the
 * same directory — one relative path is correct in both, the same property
 * `static-tier.ts`'s `DEFAULT_WEB_DIST_ROOT` relies on.
 */
export const DEFAULT_MIGRATIONS_FOLDER = join(here, "..", "migrations");

/** The owner/bootstrap connection. Deliberately **not** `DATABASE_URL`, which every other role's service uses for its own, lesser-privileged connection. */
export const MIGRATE_DATABASE_URL_ENV_VAR = "MIGRATE_DATABASE_URL";

/**
 * The roles this step provisions credentials for, and the env var each reads
 * from. `app_owner` is deliberately absent: nothing in the compose stack
 * connects as it, and creating a login credential no service uses would be a
 * standing secret for no purpose.
 *
 * `app_backup` was here too, for the backup sidecar, until the backup
 * pipeline was retired: migration `0045` drops the role, so provisioning a password for it
 * would now fail on a role that does not exist.
 */
export const ROLE_PASSWORD_ENV_VARS: ReadonlyArray<readonly [role: string, envVar: string]> = [
  ["app_web", "APP_WEB_PASSWORD"],
  ["app_ingest", "APP_INGEST_PASSWORD"],
];

/**
 * The one statement migration `0031_pgboss-schema.sql` contains, restated here
 * because after a **restore** that migration can never run again.
 *
 * **Found by the GATE-6 restore drill (P1).** The three facts that
 * make this necessary, each verified rather than reasoned:
 *
 * 1. A dump of this database excludes the `pgboss` schema by design,
 *    so a restored database has no `pgboss` schema. That was not merely a
 *    preference for the retired sidecar (which dumped with
 *    `--exclude-schema=pgboss` because its read-only role held no `USAGE`
 *    there): it is queue state, not user data, and any future dump — hand-run
 *    or from the export story — should exclude it for the same reason,
 *    which is why this assertion outlives the pipeline that found the bug.
 * 2. `drizzle`'s migrator is a **watermark**, not a per-migration ledger: it
 *    reads `select id, hash, created_at from drizzle.__drizzle_migrations order
 *    by created_at desc limit 1` and applies only migrations whose folder
 *    timestamp is greater (`drizzle-orm@0.45.2`, `pg-core/dialect.js`). The
 *    journal restores faithfully, so `0031` is below the watermark and is
 *    skipped — and deleting just its row would change nothing, because a later
 *    migration's row is what the watermark reads.
 * 3. `app_ingest` deliberately holds no database-level `CREATE` (migration
 *    `0031`'s own doc comment, proved against a real Postgres as the real role
 *    by `market/ingestion/src/pgboss-schema-app-ingest-grant.integration.test.ts`),
 *    so neither the worker nor the API can create the schema for itself. The
 *    worker's `PgBoss` (`migrate: true`, `createSchema: false`) needs the schema
 *    to already exist; the API's producer instance (`migrate: false`) throws
 *    `pg-boss is not installed` and the process exits 1.
 *
 * So the one-shot `migrate` service — the only step in the stack that holds an
 * owner/superuser connection — asserts the schema, exactly as it already
 * provisions the role passwords the globals dump deliberately omits. Both are
 * the same shape of problem: something a fresh volume gets from a migration and
 * a restored volume can only get from here. `IF NOT EXISTS` makes it a no-op on
 * every normal bring-up.
 *
 * `pgboss-schema-migration-content.test.ts` asserts this string is byte-equal to
 * migration `0031`'s sole statement, so the two cannot drift.
 */
export const PGBOSS_SCHEMA_STATEMENT =
  "CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_ingest";

/** The schema {@link PGBOSS_SCHEMA_STATEMENT} creates — named once, for the existence probe. */
const PGBOSS_SCHEMA = "pgboss";

export type MigrateEnv = Readonly<Record<string, string | undefined>>;

export interface RunMigrationsOptions {
  readonly env: MigrateEnv;
  /** Overrides {@link DEFAULT_MIGRATIONS_FOLDER} — tests only; the image always takes the default. */
  readonly migrationsFolder?: string;
  readonly log?: (message: string) => void;
}

function required(env: MigrateEnv, name: string, why: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`migrate: ${name} is required — ${why}`);
  }
  return value;
}

/**
 * `ALTER ROLE ... PASSWORD` takes a string **literal** in Postgres's own
 * grammar, not a bind parameter (the same constraint `test-app.ts` and
 * `dev-up.sh` both work around). Rather than hand-rolling the quoting for a
 * value that comes from the deployment's `.env`, Postgres is asked to build the
 * statement: `format('%I', ...)`/`format('%L', ...)` are its own identifier and
 * literal quoting, applied to values that *did* travel as bind parameters.
 */
async function setRolePassword(sql: postgres.Sql, role: string, password: string): Promise<void> {
  const rows = await sql<{ statement: string }[]>`
    select format('alter role %I with password %L', ${role}::text, ${password}::text) as statement
  `;
  const statement = rows[0]?.statement;
  if (statement === undefined) {
    throw new Error(`migrate: could not build the ALTER ROLE statement for ${role}`);
  }
  await sql.unsafe(statement);
}

/**
 * Runs {@link PGBOSS_SCHEMA_STATEMENT} and reports whether it had to create the
 * schema. The probe is not decoration: "the migration gate re-created the job
 * queue's schema" is the one line in a restore's own output that says a restored
 * database was repaired, and it must be distinguishable from the no-op every
 * ordinary bring-up produces.
 */
async function ensurePgbossSchema(sql: postgres.Sql): Promise<{ created: boolean; owner: string }> {
  const before = await sql<{ owner: string }[]>`
    select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${PGBOSS_SCHEMA}
  `;
  const existingOwner = before[0]?.owner;
  await sql.unsafe(PGBOSS_SCHEMA_STATEMENT);
  // Read back rather than assume: `CREATE SCHEMA IF NOT EXISTS` is a no-op when
  // the schema exists, so its `AUTHORIZATION` clause says nothing about who owns
  // an already-existing one. Reporting the real owner is what would make a
  // wrong-owner schema visible in the migration step's own output instead of as
  // an unexplained pg-boss permission error in the worker three steps later.
  const after = await sql<{ owner: string }[]>`
    select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${PGBOSS_SCHEMA}
  `;
  return { created: existingOwner === undefined, owner: after[0]?.owner ?? "unknown" };
}

/**
 * Applies every pending migration, seeds the catalogue's `PENDING`
 * instrument-backfill rows (IB9 — see {@link seedPendingInstrumentBackfillState},
 * which runs from here and from nowhere else), re-asserts the `pgboss` schema,
 * then provisions the application roles' passwords.
 * Throws on any failure — which is the whole contract: compose's
 * `condition: service_completed_successfully` turns a non-zero exit into "`api`
 * and `worker` never start", i.e. FR-47/AC-37's "a migration failure blocks
 * the API from ever becoming ready".
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  // SH-38 (FR-32; the `console.*` disposition table) — **this file
  // stays `console.*`, deliberately.** It is the whole program of the one-shot
  // `migrate` compose service, whose entire stdout an operator reads as a
  // sequence of human-readable steps; `SH-31`'s AC-37 evidence is that literal
  // text. There is no request and no job to scope it to, and structuring it
  // would make the migration gate's own output harder to read for no gain in
  // correlation. `platform/db` also cannot import the logger without a
  // bootstrap cycle (see `client.ts`'s own note).
  const log = options.log ?? ((message: string) => console.info(message));
  const databaseUrl = required(
    options.env,
    MIGRATE_DATABASE_URL_ENV_VAR,
    "the migration step needs the owner/bootstrap connection, which is not the same as any " +
      "application role's DATABASE_URL",
  );
  const passwords = ROLE_PASSWORD_ENV_VARS.map(([role, envVar]) => {
    const password = required(
      options.env,
      envVar,
      `the migration that creates ${role} does so without credentials on purpose, so this step must supply them — ` +
        `without it the role exists and cannot log in, and the service that uses it never becomes healthy`,
    );
    return { role, password };
  });

  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  // The stale-`dist` class of failure, guarded explicitly: a runtime image built
  // without `COPY platform/db/migrations` would otherwise reach drizzle's own
  // "no migrations" path and **exit 0**, satisfying the gate while having
  // migrated nothing.
  if (!existsSync(join(migrationsFolder, "meta", "_journal.json"))) {
    throw new Error(
      `migrate: no migration journal at ${join(migrationsFolder, "meta", "_journal.json")} — ` +
        "the migrations directory is missing from this image/checkout. Exiting non-zero rather " +
        "than reporting a successful migration of nothing.",
    );
  }

  // `max: 1` — one connection, one job, then gone. Nothing about this step is
  // concurrent, and a pool would only make the process linger.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    log(`[migrate] applying migrations from ${migrationsFolder}`);
    await migrate(createDb(sql), { migrationsFolder });
    log("[migrate] migrations applied");

    // IB9 — see `seed-backfill-state.ts`'s own doc comment for
    // why these rows are a deploy step's output rather than a migration's, and
    // for the deliberate asymmetry that keeps `dev-up.sh` and the test
    // harness's migrate paths from producing them. The count is logged because
    // "seeded 0 rows" and "every row already had one" are different facts.
    const seeded = await seedPendingInstrumentBackfillState(sql);
    log(
      seeded.inserted === 0
        ? "[migrate] instrument backfill state: no new rows — every shared SHARE/ETF/CRYPTO catalogue row already had one"
        : `[migrate] instrument backfill state: ${String(seeded.inserted)} row(s) seeded PENDING — the hourly reconcile sweep will enqueue their history backfills`,
    );

    const pgboss = await ensurePgbossSchema(sql);
    log(
      pgboss.created
        ? `[migrate] pgboss schema CREATED, owned by ${pgboss.owner} — this database had none, which is what a ` +
            "database restored from a dump looks like (--exclude-schema=pgboss). The worker will rebuild " +
            "pg-boss's own tables and re-upsert every schedule on its next start."
        : `[migrate] pgboss schema already present, owned by ${pgboss.owner}`,
    );

    for (const { role, password } of passwords) {
      await setRolePassword(sql, role, password);
      log(`[migrate] credentials set for ${role}`);
    }
    log("[migrate] done");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function migrateMain(): Promise<void> {
  await runMigrations({ env: process.env });
}

// Runs only when this module *is* the process entrypoint — never on import, the
// same guard `market/composition/src/worker-main.ts` uses.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  migrateMain().catch((error: unknown) => {
    console.error("[migrate] FAILED — api and worker will not start", error);
    process.exitCode = 1;
  });
}
