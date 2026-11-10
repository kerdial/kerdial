import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "@kerdial/core-decimal";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";
import { withFxCorrection, withTenant } from "./tenant-context.js";
import { cashAccount, instrument, portfolio, tenant, transaction } from "./schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/**
 * T-9 acceptance: `withTenant`/`withFxCorrection` against a real Postgres 17
 * container, authenticated as the `app_web` role T-8 created (not the migration-owning superuser), with the
 * underlying `postgres.js` pool pinned to a single physical connection
 * (`max: 1`) so the "same pooled connection" claims below are a fact about
 * the test, not an assumption about postgres.js's default pool behaviour.
 *
 * T-8's roles are deliberately created without a password (real credentials
 * are provisioned at deploy time, T-2/T-3). Setting one via `ALTER ROLE`
 * below is test-only plumbing so this suite can authenticate over the wire
 * as `app_web` the way the real API does, rather than emulating the role
 * with `SET LOCAL ROLE` the way T-8's own test does — that distinction
 * matters here specifically, because T-9 is exactly the code that will sit
 * behind a real, password-authenticated `app_web` connection in production.
 *
 * **Edge case found during T-9, since FIXED by migration 0008:**
 * The fail-closed default is that "queries
 * return zero rows" when `app.tenant_id` is unset, assuming
 * `current_setting('app.tenant_id', true)` is SQL `NULL`. That assumption
 * holds only for the very first transaction a physical connection ever runs.
 * Once any transaction on that connection has called
 * `set_config('app.tenant_id', ..., true)` — which is exactly what
 * `withTenant` does on every request — Postgres keeps a per-session
 * placeholder for the custom GUC whose value, after the LOCAL setting
 * reverts at COMMIT, is the empty string `''`, not `NULL`. Migration 0007's
 * policies cast with `::uuid`, and `''::uuid` raises
 * `invalid input syntax for type uuid` rather than filtering rows. In other
 * words the documented fail-closed contract held on a pristine connection
 * and broke on every pooled connection after its first use.
 *
 * No cross-tenant data was ever exposed — the failure was loud, not silent —
 * but an error path is a worse place to discover a tenancy bug than an empty
 * result set. Migration `0008_rls-fail-closed-nullif.sql` wraps the read in
 * `NULLIF(current_setting('app.tenant_id', true), '')` so both the never-set
 * (`NULL`) and reverted-after-use (`''`) cases collapse to `NULL`, making the
 * policy genuinely fail-closed on every connection in every state. Both
 * states are tested below: a pristine connection and a reused one.
 */
describe("platform/db — tenant-scoped connection factory (T-9, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let ownerClient: postgres.Sql; // migrations + seeding, as the Testcontainers superuser
  let ownerDb: Db;
  let appWebSql: postgres.Sql; // pinned to one physical connection, authenticated as app_web
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000000c0000";
  const tenantB = "00000000-0000-7000-8000-0000000d0000";
  const portfolioA = "00000000-0000-7000-8000-0000000c0001";
  const portfolioB = "00000000-0000-7000-8000-0000000d0001";
  const shareInstrumentId = "00000000-0000-7000-8000-0000000000f1";
  const txnA = "00000000-0000-7000-8000-0000000c0002";
  const cashAccountA = "00000000-0000-7000-8000-0000000c0009";

  function appWebConnectionString(): string {
    return `postgres://app_web:tenant-context-test-only@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ownerClient = createPostgresClient(container.getConnectionUri());
    ownerDb = createDb(ownerClient);
    await migrate(ownerDb, { migrationsFolder });

    await ownerClient`ALTER ROLE app_web WITH PASSWORD 'tenant-context-test-only'`;

    // `max: 1` pins the pool to exactly one physical connection.
    appWebSql = postgres(appWebConnectionString(), { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await ownerDb.insert(portfolio).values([
      { id: portfolioA, tenantId: tenantA, name: "Tenant A" },
      { id: portfolioB, tenantId: tenantB, name: "Tenant B" },
    ]);
    await ownerDb.insert(instrument).values({
      id: shareInstrumentId,
      kind: "SHARE",
      displayName: "T-9 Share Co",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin: "FR0000999909",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });
    // CA-9/`0039`: a fiat-settled row names the cash account its money moved
    // through.
    await ownerDb.insert(cashAccount).values({
      id: cashAccountA,
      tenantId: tenantA,
      portfolioId: portfolioA,
      name: "Compte EUR",
      currency: "EUR",
    });
    await ownerDb.insert(transaction).values({
      baseCurrency: "EUR",
      id: txnA,
      tenantId: tenantA,
      portfolioId: portfolioA,
      kind: "BUY",
      tradeDate: "2025-05-01",
      seq: 1n,
      instrumentId: shareInstrumentId,
      quantity: new Decimal("10"),
      unitPrice: new Decimal("100"),
      grossAmount: new Decimal("1000"),
      txnCurrency: "EUR",
      // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
      cashCurrency: "EUR",
      cashAmount: new Decimal("1000"),
      cashAccountId: cashAccountA,
      fxRate: new Decimal("1"),
      fxRateSource: "IMPLIED_BASE",
    });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await ownerClient?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  it("rejects a non-UUID tenantId synchronously, before touching the connection", async () => {
    await expect(withTenant(appWebDb, "not-a-uuid", async () => undefined)).rejects.toThrow(
      TypeError,
    );
  });

  it("fail-closed on a pristine connection (never gone through withTenant): SELECT returns zero rows, not an error, not all rows (AC33)", async () => {
    const freshSql = postgres(appWebConnectionString(), { max: 1 });
    try {
      const rows = await freshSql`SELECT * FROM "portfolio"`;
      expect(rows).toHaveLength(0);
    } finally {
      await freshSql.end({ timeout: 5 });
    }
  });

  describe("cross-tenant isolation on the same pooled connection (FR-45, AC33)", () => {
    it("tenant A's call sees only tenant A's portfolio, tenant B's call sees only tenant B's — both ran on the same backend pid", async () => {
      const seenA = await withTenant(appWebDb, tenantA, async (tx) => {
        const [pidRow] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        const rows = await tx.select({ name: portfolio.name }).from(portfolio);
        return { pid: pidRow?.pid, names: rows.map((r) => r.name) };
      });
      const seenB = await withTenant(appWebDb, tenantB, async (tx) => {
        const [pidRow] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        const rows = await tx.select({ name: portfolio.name }).from(portfolio);
        return { pid: pidRow?.pid, names: rows.map((r) => r.name) };
      });

      expect(seenA.pid).toBeDefined();
      expect(seenA.pid).toBe(seenB.pid); // provably the same underlying connection
      expect(seenA.names).toEqual(["Tenant A"]);
      expect(seenB.names).toEqual(["Tenant B"]);
    });

    it("transaction-local scoping: after COMMIT, a fresh query on the same pooled connection sees app.tenant_id as unset again", async () => {
      await withTenant(appWebDb, tenantA, async () => undefined);

      const [row] = await appWebSql<{ v: string | null }[]>`
        select current_setting('app.tenant_id', true) as v
      `;
      // '' (Postgres' placeholder-GUC default once a custom GUC has been
      // referenced in the session) or null — either way, never tenantA.
      expect(row?.v).toBeFalsy();
      expect(row?.v).not.toBe(tenantA);
    });

    it("fail-closed on a REUSED connection: a direct query right after a withTenant call, without a new one, returns zero rows — not an error, not another tenant's rows (AC33, AC35)", async () => {
      // The regression this pins: before migration 0008 the policies read
      // `current_setting('app.tenant_id', true)::uuid`, and on a connection
      // that had already been through withTenant the reverted GUC is '' (not
      // NULL), so `''::uuid` raised `invalid input syntax for type uuid`.
      // That is every pooled connection after its first request. No data ever
      // leaked, but the documented fail-closed contract said "zero rows", and
      // an error path is a worse place to discover a tenancy bug. 0008 wraps
      // the read in NULLIF(..., '') so both never-set and reverted-after-use
      // collapse to NULL.
      await withTenant(appWebDb, tenantA, async () => undefined);

      const rows = await appWebSql`SELECT * FROM "portfolio"`;
      expect(rows).toHaveLength(0);
    });
  });

  describe("app.fx_correction — the named affordance", () => {
    it("is visible only inside its own transaction and does not persist after COMMIT", async () => {
      const flagDuring = await withTenant(appWebDb, tenantA, (tx) =>
        withFxCorrection(tx, async (tx2) => {
          const [row] = await tx2.execute<{ v: string }>(
            sql`select current_setting('app.fx_correction', true) as v`,
          );
          return row?.v;
        }),
      );
      expect(flagDuring).toBe("on");

      const [after] = await appWebSql<{ v: string | null }[]>`
        select current_setting('app.fx_correction', true) as v
      `;
      expect(after?.v).not.toBe("on");
    });

    it("lets an UPDATE of transaction.fx_rate through T-6's trigger; the identical UPDATE without it is rejected", async () => {
      // drizzle-orm wraps the driver error (`Failed query: ...`); the
      // trigger's own message is on `.cause`.
      await expect(
        withTenant(appWebDb, tenantA, async (tx) => {
          await tx.execute(sql`update "transaction" set fx_rate = '1.5' where id = ${txnA}`);
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/FX legs are immutable/) },
      });

      await withTenant(appWebDb, tenantA, (tx) =>
        withFxCorrection(tx, async (tx2) => {
          await tx2.execute(sql`update "transaction" set fx_rate = '1.5' where id = ${txnA}`);
        }),
      );

      const [row] = await ownerClient<{ fx_rate: string }[]>`
        select fx_rate from "transaction" where id = ${txnA}
      `;
      expect(row?.fx_rate).toBe("1.500000000000");
    });
  });
});
