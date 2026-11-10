import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresClient } from "./client.js";

/**
 * F5 (T-37): `createPostgresClient` had no
 * `statement_timeout` at all — a runaway query (the unindexed, leading-
 * wildcard `ILIKE` search this same finding covers, or anything else) would
 * run until Postgres finished it. This proves the timeout is actually
 * enforced by a real Postgres connection, and that it is overridable (so a
 * caller needing a longer-running statement — a migration, a backfill batch
 * — is not silently broken by the new default).
 */
describe("platform/db — createPostgresClient statement_timeout (F5, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  }, 30_000);

  it("cancels a statement that runs longer than the configured statement_timeout", async () => {
    const sql = createPostgresClient(container.getConnectionUri(), { statementTimeoutMs: 200 });
    try {
      await expect(sql`select pg_sleep(2)`).rejects.toMatchObject({
        code: "57014", // query_canceled
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("does not cancel a statement that completes within the configured statement_timeout", async () => {
    const sql = createPostgresClient(container.getConnectionUri(), { statementTimeoutMs: 5_000 });
    try {
      const rows = await sql`select 1 as one`;
      expect(rows[0]?.["one"]).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("defaults to a 15s statement_timeout when no override is supplied", async () => {
    const sql = createPostgresClient(container.getConnectionUri());
    try {
      const rows = await sql`show statement_timeout`;
      expect(rows[0]?.["statement_timeout"]).toBe("15s");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("respects DB_STATEMENT_TIMEOUT_MS from the environment when no explicit override is given", async () => {
    const previous = process.env["DB_STATEMENT_TIMEOUT_MS"];
    process.env["DB_STATEMENT_TIMEOUT_MS"] = "5000";
    try {
      const sql = createPostgresClient(container.getConnectionUri());
      try {
        const rows = await sql`show statement_timeout`;
        expect(rows[0]?.["statement_timeout"]).toBe("5s");
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      if (previous === undefined) delete process.env["DB_STATEMENT_TIMEOUT_MS"];
      else process.env["DB_STATEMENT_TIMEOUT_MS"] = previous;
    }
  });

  it("still returns a working postgres.Sql client (unchanged public contract)", async () => {
    const sql = createPostgresClient(container.getConnectionUri());
    try {
      expect(sql).toBeTypeOf("function");
      const rows = await sql`select 1 as one`;
      expect(rows[0]?.["one"]).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
