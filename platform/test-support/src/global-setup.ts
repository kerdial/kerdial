import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDb, createPostgresClient } from "@kerdial/platform-db";
import { prepareDatabase, SHARED_TEMPLATE_ENV, SHARED_URI_ENV, SPEED_FLAGS } from "./index.js";

/**
 * Vitest globalSetup (wired in the root vitest.config.ts): boots the ONE
 * Postgres container a `TEST_SHARED_PG=1` run shares, migrates its default
 * database once, fixes the role passwords once, and advertises it to every
 * suite via env (workers are forked after this runs, so they inherit it).
 * `startMigratedPostgres()` then clones per-suite databases from the template.
 *
 * Without `TEST_SHARED_PG=1` this is a no-op — a narrow `npx vitest run
 * some.test.ts` needs neither Docker (for unit suites) nor a shared container
 * (integration suites fall back to booting their own).
 *
 * `max_connections=500`: one instance now carries every parallel suite's
 * pools (owner + app_web + app_ingest + pg-boss), where each container
 * previously had the default 100 to itself.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env["TEST_SHARED_PG"] !== "1") {
    return async () => {};
  }

  const container = await new PostgreSqlContainer("postgres:17-alpine")
    .withCommand(["postgres", ...SPEED_FLAGS, "-c", "max_connections=500"])
    .start();

  const templateUri = container.getConnectionUri();
  const client = createPostgresClient(templateUri);
  try {
    await prepareDatabase(client, createDb(client));
  } finally {
    // The template must hold zero connections or every CREATE ... TEMPLATE
    // clone would fail; suites connect only to their own clones.
    await client.end({ timeout: 5 });
  }

  const admin = new URL(templateUri);
  admin.pathname = "/postgres";
  process.env[SHARED_URI_ENV] = admin.toString();
  process.env[SHARED_TEMPLATE_ENV] = container.getDatabase();

  return async () => {
    await container.stop();
  };
}
