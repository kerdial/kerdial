import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb, createPostgresClient, type Db } from "@kerdial/platform-db";

/**
 * The one entry point for every integration suite that needs a migrated
 * Postgres. Replaces the per-file boilerplate this repo had 79
 * copies of: `new PostgreSqlContainer(...).start()` + `migrate(...)` +
 * `ALTER ROLE ... PASSWORD` + hand-built role connection strings.
 *
 * Two modes, chosen by environment:
 *
 * - **Shared** — when `global-setup.ts` has run (root `test`/`test:main`/
 *   `test:flake-lane` scripts set `TEST_SHARED_PG=1`, so CI always takes this
 *   path): one Postgres container serves the whole vitest run, and each suite
 *   gets its own database cloned from a pre-migrated template
 *   (`CREATE DATABASE ... TEMPLATE`, ~100 ms) instead of paying container
 *   boot + full migration (~5-10 s). Isolation between suites is by database,
 *   which is what per-container isolation bought too — nothing in these
 *   suites touches cluster-level state except role passwords, which the
 *   global setup fixes once to `TEST_ROLE_PASSWORD`.
 *
 * - **Fallback** — no shared container advertised (e.g. `npx vitest run
 *   one-file.test.ts` straight from a shell): boots a container of its own,
 *   exactly like the boilerplate it replaces. Single-suite dev runs need no
 *   env and no global setup.
 */

export { FakeClock } from "./fake-clock.js";
export { deferred, waitUntil, waitUntilOrThrow } from "./async.js";
export {
  CASH_FIXTURE_CURRENCIES,
  cash,
  ensureCashAccount,
  seedCashAccounts,
  seedCashAccountsForPortfolio,
} from "./cash-account-fixture.js";

export const TEST_ROLE_PASSWORD = "test-only";

/** Set by global-setup.ts: superuser URI to the shared container's `postgres` maintenance DB. */
export const SHARED_URI_ENV = "PORTFOLIO_TEST_PG_URI";
/** Set by global-setup.ts: name of the pre-migrated template database. */
export const SHARED_TEMPLATE_ENV = "PORTFOLIO_TEST_PG_TEMPLATE";

const here = dirname(fileURLToPath(import.meta.url));
/** Same depth from `src/` and from `dist/`, so this resolves in both. */
export const MIGRATIONS_FOLDER = join(here, "..", "..", "db", "migrations");

export interface MigratedPostgres {
  /** Superuser URI to this suite's own database. */
  readonly ownerUri: string;
  /** Superuser client/db, already connected — what `migrate` ran through. */
  readonly ownerClient: postgres.Sql;
  readonly ownerDb: Db;
  /** URI for the restricted `app_web` role against this suite's database. */
  readonly appWebUri: string;
  /** URI for the restricted `app_ingest` role against this suite's database. */
  readonly appIngestUri: string;
  /** Ends the owner client and releases the database (or the whole container in fallback mode). */
  stop(): Promise<void>;
}

function withDatabase(uri: string, dbName: string): string {
  const url = new URL(uri);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function roleUri(uri: string, role: string, dbName: string): string {
  const url = new URL(uri);
  url.username = role;
  url.password = TEST_ROLE_PASSWORD;
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Postgres refuses `CREATE DATABASE ... TEMPLATE x` while another backend is
 * copying from (or connected to) `x`; with many vitest workers cloning the
 * same template concurrently that is an expected transient, not a failure.
 */
function isTemplateBusy(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === "55006" || (e?.message ?? "").includes("is being accessed by other users");
}

async function createFromTemplate(
  admin: postgres.Sql,
  dbName: string,
  template: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
      return;
    } catch (error) {
      if (attempt >= 120 || !isTemplateBusy(error)) throw error;
      await sleep(250);
    }
  }
}

async function startFromShared(adminUri: string, template: string): Promise<MigratedPostgres> {
  const dbName = `t_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUri, { max: 1 });
  try {
    await createFromTemplate(admin, dbName, template);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const ownerUri = withDatabase(adminUri, dbName);
  const ownerClient = createPostgresClient(ownerUri);
  return {
    ownerUri,
    ownerClient,
    ownerDb: createDb(ownerClient),
    appWebUri: roleUri(adminUri, "app_web", dbName),
    appIngestUri: roleUri(adminUri, "app_ingest", dbName),
    async stop() {
      await ownerClient.end({ timeout: 5 });
      // Bound the shared container's disk: drop the clone. `FORCE` because a
      // suite's pools (pg-boss especially) may not have fully drained yet.
      // Best-effort — an undropped clone dies with the container at teardown.
      const dropper = postgres(adminUri, { max: 1 });
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch {
        // Ignored: see above.
      } finally {
        await dropper.end({ timeout: 5 });
      }
    },
  };
}

/** Applied in fallback mode and by global-setup.ts — throwaway data, so durability is pure cost. */
export const SPEED_FLAGS = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
];

export async function prepareDatabase(ownerClient: postgres.Sql, ownerDb: Db): Promise<void> {
  await migrate(ownerDb, { migrationsFolder: MIGRATIONS_FOLDER });
  // ALTER ROLE is a utility statement — no bind parameters; the password is a
  // compile-time constant of this package, never user input.
  await ownerClient.unsafe(`ALTER ROLE app_web WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
  await ownerClient.unsafe(`ALTER ROLE app_ingest WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
}

async function startOwnContainer(): Promise<MigratedPostgres> {
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    .withCommand(["postgres", ...SPEED_FLAGS])
    .start();
  const ownerUri = container.getConnectionUri();
  const ownerClient = createPostgresClient(ownerUri);
  const ownerDb = createDb(ownerClient);
  await prepareDatabase(ownerClient, ownerDb);

  return {
    ownerUri,
    ownerClient,
    ownerDb,
    appWebUri: roleUri(ownerUri, "app_web", container.getDatabase()),
    appIngestUri: roleUri(ownerUri, "app_ingest", container.getDatabase()),
    async stop() {
      await ownerClient.end({ timeout: 5 });
      await container.stop();
    },
  };
}

export async function startMigratedPostgres(): Promise<MigratedPostgres> {
  const sharedUri = process.env[SHARED_URI_ENV];
  const template = process.env[SHARED_TEMPLATE_ENV];
  if (sharedUri !== undefined && sharedUri !== "" && template !== undefined && template !== "") {
    return startFromShared(sharedUri, template);
  }
  return startOwnContainer();
}
