import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "@kerdial/core-decimal";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPostgresClient, type Db } from "./client.js";
import {
  appUser,
  cashAccount,
  holdingState,
  instrument,
  portfolio,
  tenant,
  transaction,
  transactionPosting,
} from "./schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/**
 * T-8 acceptance: DB roles, grants, and RLS policies against a real Postgres
 * 17 container. Covers AC47 mechanism 1 of 3
 * (app_ingest's privilege separation), RLS as the primary tenancy
 * mechanism (fail-closed when `app.tenant_id` is unset, FORCE mattering for
 * the table owner), and the tenant-column rule (both directions,
 * derived from `pg_class` below; the per-table prose for the shared set is
 * `platform/db/src/schema/README.md`).
 *
 * All role-switching here uses `SET LOCAL ROLE` inside `client.begin(...)` —
 * transaction-scoped, on one pinned connection, auto-reverting at
 * COMMIT/ROLLBACK — rather than opening new authenticated connections, since
 * these roles are deliberately created without a password in this migration
 * (credentials are provisioned at deploy time, T-2/T-3). Postgres'
 * privilege and RLS checks key off `current_user`, which `SET LOCAL ROLE`
 * changes exactly as a real login as that role would, so this is a faithful
 * test of the grants/policies themselves.
 */
describe("platform/db — roles, grants, RLS (T-8, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: Db;

  const tenantA = "00000000-0000-7000-8000-0000000a0000";
  const tenantB = "00000000-0000-7000-8000-0000000b0000";
  const portfolioA = "00000000-0000-7000-8000-0000000a0001";
  const portfolioB = "00000000-0000-7000-8000-0000000b0001";
  const userA = "00000000-0000-7000-8000-0000000a0002";
  const userB = "00000000-0000-7000-8000-0000000b0002";
  const shareInstrumentId = "00000000-0000-7000-8000-0000000000f0";
  const txnA = "00000000-0000-7000-8000-0000000a0003";
  const txnB = "00000000-0000-7000-8000-0000000b0003";
  const cashAccountA = "00000000-0000-7000-8000-0000000a0009";
  const cashAccountB = "00000000-0000-7000-8000-0000000b0009";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    client = createPostgresClient(container.getConnectionUri());
    db = createDb(client);
    await migrate(db, { migrationsFolder });

    await db.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
    await db.insert(appUser).values([
      {
        id: userA,
        tenantId: tenantA,
        email: "a@example.com",
        passwordHash: "argon2id$placeholder",
      },
      {
        id: userB,
        tenantId: tenantB,
        email: "b@example.com",
        passwordHash: "argon2id$placeholder",
      },
    ]);
    await db.insert(portfolio).values([
      { id: portfolioA, tenantId: tenantA, name: "Tenant A portfolio" },
      { id: portfolioB, tenantId: tenantB, name: "Tenant B portfolio" },
    ]);
    await db.insert(instrument).values({
      id: shareInstrumentId,
      kind: "SHARE",
      displayName: "T-8 Share Co",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      isin: "FR0000999908",
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
    });
    // CA-9/`0039`: a fiat-settled row names the cash account its money moved
    // through, and the composite FK scopes that account to the row's own
    // tenant+portfolio — so each tenant needs its own.
    await db.insert(cashAccount).values([
      {
        id: cashAccountA,
        tenantId: tenantA,
        portfolioId: portfolioA,
        name: "Compte EUR",
        currency: "EUR",
      },
      {
        id: cashAccountB,
        tenantId: tenantB,
        portfolioId: portfolioB,
        name: "Compte EUR",
        currency: "EUR",
      },
    ]);
    await db.insert(transaction).values([
      {
        id: txnA,
        tenantId: tenantA,
        baseCurrency: "EUR",
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
      },
      {
        id: txnB,
        tenantId: tenantB,
        baseCurrency: "EUR",
        portfolioId: portfolioB,
        kind: "BUY",
        tradeDate: "2025-05-01",
        seq: 1n,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("5"),
        unitPrice: new Decimal("200"),
        grossAmount: new Decimal("1000"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("1000"),
        cashAccountId: cashAccountB,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      },
    ]);
    await db.insert(transactionPosting).values([
      {
        id: "00000000-0000-7000-8000-0000000a0004",
        tenantId: tenantA,
        baseCurrency: "EUR",
        transactionId: txnA,
        portfolioId: portfolioA,
        seq: 1,
        leg: "POSITION",
        instrumentId: shareInstrumentId,
        quantityDelta: new Decimal("10"),
        amountNative: new Decimal("-1000"),
        amountBase: new Decimal("-1000"),
        fxRateApplied: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        flowClass: "EXTERNAL",
      },
      {
        id: "00000000-0000-7000-8000-0000000b0004",
        tenantId: tenantB,
        baseCurrency: "EUR",
        transactionId: txnB,
        portfolioId: portfolioB,
        seq: 1,
        leg: "POSITION",
        instrumentId: shareInstrumentId,
        quantityDelta: new Decimal("5"),
        amountNative: new Decimal("-1000"),
        amountBase: new Decimal("-1000"),
        fxRateApplied: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        flowClass: "EXTERNAL",
      },
    ]);
    await db.insert(holdingState).values([
      {
        tenantId: tenantA,
        portfolioId: portfolioA,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("10"),
        costBasisBase: new Decimal("1000"),
        pmpUnitBase: new Decimal("100"),
        costBasisNative: new Decimal("1000"),
        pmpUnitNative: new Decimal("100"),
        lastTxnSeq: 1n,
        calcEpoch: 1n,
      },
      {
        tenantId: tenantB,
        portfolioId: portfolioB,
        instrumentId: shareInstrumentId,
        quantity: new Decimal("5"),
        costBasisBase: new Decimal("1000"),
        pmpUnitBase: new Decimal("200"),
        costBasisNative: new Decimal("1000"),
        pmpUnitNative: new Decimal("200"),
        lastTxnSeq: 1n,
        calcEpoch: 1n,
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  describe("roles", () => {
    it("creates app_owner, app_web, app_ingest — none with BYPASSRLS, all LOGIN-capable", async () => {
      const rows = await client<
        { rolname: string; rolbypassrls: boolean; rolcanlogin: boolean; rolsuper: boolean }[]
      >`
        SELECT rolname, rolbypassrls, rolcanlogin, rolsuper
        FROM pg_roles
        WHERE rolname IN ('app_owner', 'app_web', 'app_ingest')
        ORDER BY rolname
      `;
      expect(rows.map((r) => r.rolname)).toEqual(["app_ingest", "app_owner", "app_web"]);
      for (const row of rows) {
        expect(row.rolbypassrls).toBe(false);
        expect(row.rolcanlogin).toBe(true);
        expect(row.rolsuper).toBe(false);
      }
    });

    it("app_owner owns every tenant-owned and shared table", async () => {
      const rows = await client<{ relname: string; owner: string }[]>`
        SELECT c.relname, r.rolname AS owner
        FROM pg_class c
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.owner).toBe("app_owner");
      }
    });
  });

  describe("app_ingest grants — AC47 mechanism 1 of 3", () => {
    it("INSERT and upsert (INSERT ... ON CONFLICT DO UPDATE) succeed on fx_rate_daily and instrument_price_daily", async () => {
      // The schema comment on fx_rate_daily: "Upsertable by
      // the ingestion role: providers revise history, and that is expected."
      // This is the realistic ingestion write shape — INSERT ... ON CONFLICT
      // DO UPDATE SET ... = EXCLUDED.col. Postgres requires SELECT privilege
      // (in addition to INSERT/UPDATE) to use ON CONFLICT DO UPDATE at all —
      // this migration's top-of-file note on the app_ingest GRANT documents
      // that as a deliberate, verified deviation from the originally
      // specified "INSERT, UPDATE" grant, made so this upsert
      // actually works; it does not weaken AC47 (see that note).
      await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_ingest`;
        await sql`
          INSERT INTO "fx_rate_daily" (base_currency, quote_currency, rate_date, rate, source_key)
          VALUES ('USD', 'EUR', '2025-06-01', '0.900000000000', 'ecb')
          ON CONFLICT (base_currency, quote_currency, rate_date)
          DO UPDATE SET rate = EXCLUDED.rate
        `;
        await sql`
          INSERT INTO "fx_rate_daily" (base_currency, quote_currency, rate_date, rate, source_key)
          VALUES ('USD', 'EUR', '2025-06-01', '0.910000000000', 'ecb')
          ON CONFLICT (base_currency, quote_currency, rate_date)
          DO UPDATE SET rate = EXCLUDED.rate
        `;
        await sql`
          INSERT INTO "instrument_price_daily" (instrument_id, price_date, close_raw, currency, source_key, quality)
          VALUES (${shareInstrumentId}, '2025-06-01', '101.500000000000000000', 'EUR', 'yahoo', 'EOD')
          ON CONFLICT (instrument_id, price_date)
          DO UPDATE SET close_raw = EXCLUDED.close_raw
        `;
        await sql`
          INSERT INTO "instrument_price_daily" (instrument_id, price_date, close_raw, currency, source_key, quality)
          VALUES (${shareInstrumentId}, '2025-06-01', '102.000000000000000000', 'EUR', 'yahoo', 'EOD')
          ON CONFLICT (instrument_id, price_date)
          DO UPDATE SET close_raw = EXCLUDED.close_raw
        `;
      });

      const [fxRow] = await client<{ rate: string }[]>`
        SELECT rate FROM "fx_rate_daily" WHERE base_currency = 'USD' AND quote_currency = 'EUR' AND rate_date = '2025-06-01'
      `;
      expect(fxRow?.rate).toBe("0.910000000000");

      const [priceRow] = await client<{ close_raw: string }[]>`
        SELECT close_raw FROM "instrument_price_daily" WHERE instrument_id = ${shareInstrumentId} AND price_date = '2025-06-01'
      `;
      expect(priceRow?.close_raw).toBe("102.000000000000000000");
    });

    it("a plain SELECT and a plain UPDATE ... WHERE also succeed on the five reference tables (SELECT was added to the grant for the ON CONFLICT upsert above to work)", async () => {
      await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_ingest`;
        const [row] = await sql<{ rate: string }[]>`
          SELECT rate FROM "fx_rate_daily" WHERE base_currency = 'USD' AND quote_currency = 'EUR' AND rate_date = '2025-06-01'
        `;
        expect(row?.rate).toBe("0.910000000000");

        await sql`
          UPDATE "fx_rate_daily" SET rate = '0.920000000000'
          WHERE base_currency = 'USD' AND quote_currency = 'EUR' AND rate_date = '2025-06-01'
        `;
      });

      const [row] = await client<{ rate: string }[]>`
        SELECT rate FROM "fx_rate_daily" WHERE base_currency = 'USD' AND quote_currency = 'EUR' AND rate_date = '2025-06-01'
      `;
      expect(row?.rate).toBe("0.920000000000");
    });

    it("SELECT succeeds on transaction, transaction_posting, and holding_state, seeing rows across both tenants (the RLS-exempt read policy)", async () => {
      const rows = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_ingest`;
        const txnRows = await sql<{ id: string }[]>`SELECT id FROM "transaction" ORDER BY id`;
        const postingRows = await sql<{ id: string }[]>`SELECT id FROM "transaction_posting"`;
        const holdingRows = await sql<
          { tenant_id: string }[]
        >`SELECT tenant_id FROM "holding_state"`;
        return { txnRows, postingRows, holdingRows };
      });

      expect(rows.txnRows.map((r) => r.id).sort()).toEqual([txnA, txnB].sort());
      expect(rows.postingRows).toHaveLength(2);
      expect(rows.holdingRows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
    });

    it("UPDATE transaction SET fx_rate = ... raises a Postgres permission-denied error (the explicit AC47 negative test)", async () => {
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`UPDATE "transaction" SET fx_rate = '1.5' WHERE id = ${txnA}`;
        }),
      ).rejects.toThrow(/permission denied/i);

      // Unchanged — the write never landed.
      const [row] = await client<
        { fx_rate: string }[]
      >`SELECT fx_rate FROM "transaction" WHERE id = ${txnA}`;
      expect(row?.fx_rate).toBe("1.000000000000");
    });

    it("INSERT and DELETE on transaction/transaction_posting/holding_state also fail with a permission error", async () => {
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`DELETE FROM "transaction" WHERE id = ${txnA}`;
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`DELETE FROM "transaction_posting" WHERE transaction_id = ${txnA}`;
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`DELETE FROM "holding_state" WHERE tenant_id = ${tenantA}`;
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it("SELECT succeeds on instrument, instrument_provider_map, and market_calendar (T-34's new read grant, migration 0018) — instrument/market_calendar stay read-only; instrument_provider_map also allows INSERT (IC-2, migration 0030) but not UPDATE", async () => {
      const rows = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_ingest`;
        const instrumentRows = await sql<
          { id: string }[]
        >`SELECT id FROM "instrument" WHERE id = ${shareInstrumentId}`;
        const providerMapRows = await sql<
          { instrument_id: string }[]
        >`SELECT instrument_id FROM "instrument_provider_map"`;
        const calendarRows = await sql<
          { calendar_key: string }[]
        >`SELECT calendar_key FROM "market_calendar" LIMIT 1`;
        return { instrumentRows, providerMapRows, calendarRows };
      });
      expect(rows.instrumentRows).toHaveLength(1);
      // Both tables may legitimately be empty in this suite's fixture data —
      // the assertion that matters is that the SELECT itself did not raise a
      // permission error, which the surrounding `client.begin` already proves
      // by not throwing.
      expect(Array.isArray(rows.providerMapRows)).toBe(true);
      expect(Array.isArray(rows.calendarRows)).toBe(true);

      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`UPDATE "instrument" SET display_name = 'hacked' WHERE id = ${shareInstrumentId}`;
        }),
      ).rejects.toThrow(/permission denied/i);

      // IC-2, migration 0030: app_ingest now
      // holds INSERT (only) on instrument_provider_map — the new in-process
      // worker's own HEURISTIC-mapping write. This was a
      // rejected write before that migration; see this same migration's own
      // dedicated `platform/db/src/instrument-provider-map-ingest-insert-grant
      // .integration.test.ts` for the full INSERT-succeeds/UPDATE-still-fails
      // proof against the real app_ingest role. Asserted here too so this
      // suite's own enumeration of app_ingest's privileges does not silently
      // drift out of date with a later grant migration.
      await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_ingest`;
        await sql`
          INSERT INTO "instrument_provider_map" (instrument_id, provider_key, provider_symbol, confidence)
          VALUES (${shareInstrumentId}, 'yahoo', 'ROLES-RLS-TEST.PA', 'HEURISTIC')
        `;
      });
      // Mapping revision/confirmation stays an app_web-only concern (IC-2's
      // migration is INSERT-only) — an UPDATE against the row just inserted
      // is still rejected.
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`
            UPDATE "instrument_provider_map" SET confidence = 'CONFIRMED'
            WHERE instrument_id = ${shareInstrumentId} AND provider_key = 'yahoo'
          `;
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`
            INSERT INTO "market_calendar" (calendar_key, session_date, is_open)
            VALUES ('XPAR', '2099-01-01', false)
          `;
        }),
      ).rejects.toThrow(/permission denied/i);

      // Confirmed unchanged after every rejected write attempt above.
      const [instrumentRow] = await client<
        { display_name: string }[]
      >`SELECT display_name FROM "instrument" WHERE id = ${shareInstrumentId}`;
      expect(instrumentRow?.display_name).toBe("T-8 Share Co");
    });
  });

  describe("row-level security is ENABLEd and FORCEd on every tenant-owned table", () => {
    /**
     * **There is no list here any more, in either direction.**
     *
     * This block used to declare a by-value array of tenant-owned tables and
     * then use that array as its own SQL filter (`relname = ANY(...)`), with a
     * length assertion comparing the result against the list. So a
     * tenant-owned table omitted from the array was **not checked and reddened
     * nothing** — and it had already happened twice: `cash_account` (`0038`)
     * and `portfolio_daily_valuation` were absent while the test's own name
     * said "all twelve tables".
     *
     * What replaces it is the schema's own definition of the two sets, read
     * from the catalogue: **a table is tenant-owned exactly when it has a
     * `tenant_id` column**, which is what every RLS policy in `0007` filters
     * on. That makes the rule expressible without naming anything:
     *
     *   * a table **with** `tenant_id` must have RLS `ENABLE`d **and**
     *     `FORCE`d — otherwise the column exists and nothing enforces it;
     *   * a table **without** `tenant_id` must have neither — RLS on a table
     *     with no tenant column is a predicate with nothing to filter on, and
     *     it would silently pass every row.
     *
     * Both directions are asserted, so a new table is checked the moment it
     * exists, whichever set it belongs to, with nobody having to remember to
     * add it anywhere. `instrument` is the case worth knowing: its
     * `owner_tenant_id` is deliberately a *different* column from `tenant_id`
     * (P2 forward-compat), so it lands in the
     * shared-reference set, as `platform/db/src/schema/README.md` records.
     *
     * A static CI gate (`tools/gates/src/tenant-column`) used to enforce the
     * same rule over the migration SQL with an explicit allowlist; ADR-0016
     * retired it — a green run of it proved nothing for a
     * one-lined or `IF NOT EXISTS` table — and moved its per-table
     * justifications into that README. This suite and
     * `ledger/src/rls-cross-tenant-isolation.integration.test.ts` are the
     * coverage.
     */
    interface CatalogueTable {
      readonly relname: string;
      readonly relrowsecurity: boolean;
      readonly relforcerowsecurity: boolean;
      readonly has_tenant_id: boolean;
    }

    let catalogue: CatalogueTable[] = [];

    beforeAll(async () => {
      catalogue = await client<CatalogueTable[]>`
        SELECT c.relname,
               c.relrowsecurity,
               c.relforcerowsecurity,
               EXISTS (
                 SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
                   AND NOT a.attisdropped
               ) AS has_tenant_id
        FROM pg_class c
        WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        ORDER BY c.relname
      `;
    });

    it("the catalogue read returns the whole public schema, so the checks below have something to be exhaustive over", () => {
      // A guard on the guard: an empty or implausibly small result would make
      // every assertion in this block vacuously true, which is the exact shape
      // the original report was about.
      expect(catalogue.length).toBeGreaterThan(20);
      expect(catalogue.map((t) => t.relname)).toContain("transaction");
      expect(catalogue.filter((t) => t.has_tenant_id).length).toBeGreaterThan(10);
      expect(catalogue.filter((t) => !t.has_tenant_id).length).toBeGreaterThan(5);
    });

    it("every table WITH a tenant_id column has RLS ENABLEd and FORCEd — the set comes from Postgres, not from a list", () => {
      const offenders = catalogue
        .filter((t) => t.has_tenant_id)
        .filter((t) => !t.relrowsecurity || !t.relforcerowsecurity)
        .map((t) => `${t.relname} (enable=${t.relrowsecurity}, force=${t.relforcerowsecurity})`);
      expect(offenders).toEqual([]);
    });

    it("no table WITHOUT a tenant_id column carries RLS — a policy with no tenant column to filter on", () => {
      const offenders = catalogue
        .filter((t) => !t.has_tenant_id)
        .filter((t) => t.relrowsecurity || t.relforcerowsecurity)
        .map((t) => `${t.relname} (enable=${t.relrowsecurity}, force=${t.relforcerowsecurity})`);
      expect(offenders).toEqual([]);
    });

    it("the two tables found missing from the old by-value list are in the derived set and carry both flags", () => {
      // Named explicitly, because they are the evidence that the old shape
      // failed silently rather than the hypothesis that it could.
      for (const relname of ["cash_account", "portfolio_daily_valuation"]) {
        const row = catalogue.find((t) => t.relname === relname);
        expect(row, `${relname} missing from the catalogue read`).toBeDefined();
        expect(row!.has_tenant_id).toBe(true);
        expect(row!.relrowsecurity).toBe(true);
        expect(row!.relforcerowsecurity).toBe(true);
      }
    });

    it("instrument is shared reference data — owner_tenant_id is not tenant_id, and it carries no RLS", () => {
      // The one table where the distinction is a deliberate design decision
      // rather than an absence, so the derived rule is pinned against it.
      const row = catalogue.find((t) => t.relname === "instrument");
      expect(row?.has_tenant_id).toBe(false);
      expect(row?.relrowsecurity).toBe(false);
    });
  });

  describe("fail-closed: app.tenant_id unset (AC33)", () => {
    it("as app_web, SELECT on transaction returns zero rows — not an error, not all rows — even though two rows exist", async () => {
      const rows = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        return sql`SELECT * FROM "transaction"`;
      });
      expect(rows).toHaveLength(0);
    });

    it("as app_owner (the table owner, NOBYPASSRLS) — proving FORCE ROW LEVEL SECURITY matters, not just ENABLE — SELECT also returns zero rows", async () => {
      const rows = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_owner`;
        return sql`SELECT * FROM "transaction"`;
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe("app_web grants on instrument (migrations 0018/0036/0061/0064)", () => {
    /**
     * The grant the delete endpoint needs, asserted here because this
     * is the one role suite left (`instrument-classification-grants` went with
     * the test diet). Behavioural, not a `role_table_grants` read: what
     * matters is that the statement runs, and a privilege listing can be right
     * while a policy still refuses.
     */
    it("may DELETE an instrument — migration 0064", async () => {
      const throwaway = "00000000-0000-7000-8000-00000000d064";
      await client`
        INSERT INTO "instrument" (id, kind, display_name, listing_currency, primary_identifier, quote_policy)
        VALUES (${throwaway}, 'SHARE', '0064 grant probe', 'EUR', 'ISIN', 'AUTO')`;
      const deleted = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        return sql`DELETE FROM "instrument" WHERE id = ${throwaway}`;
      });
      expect(deleted.count).toBe(1);
    });

    /**
     * The other half, and the one that actually protects ledger history.
     *
     * It is **not** a privilege: `app_web` already holds `DELETE` on
     * `holding_state`, `realized_gain` and `transaction_posting`, because the
     * ledger write path needs it. What stops a referenced instrument leaving
     * the catalogue is the `NO ACTION` foreign key, and that is what this
     * asserts — with the grant from `0064` in hand, so it measures the
     * referential graph rather than a permission error standing in for one.
     */
    it("a transaction's NO ACTION foreign key still refuses the delete (23503, not a permission error)", async () => {
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_web`;
          await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await sql`DELETE FROM "instrument" WHERE id = ${shareInstrumentId}`;
        }),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  describe("cross-tenant isolation as app_web (defense-in-depth proof; the full suite is T-23)", () => {
    it("tenant A's session sees only tenant A's transaction, never tenant B's", async () => {
      const rows = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        return sql<{ id: string }[]>`SELECT id FROM "transaction"`;
      });
      expect(rows.map((r) => r.id)).toEqual([txnA]);
    });

    it("tenant B's session sees only tenant B's transaction", async () => {
      const rows = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        await sql`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
        return sql<{ id: string }[]>`SELECT id FROM "transaction"`;
      });
      expect(rows.map((r) => r.id)).toEqual([txnB]);
    });

    it("tenant A's session cannot UPDATE or DELETE tenant B's transaction (RLS silently excludes it — zero rows affected, not an error)", async () => {
      const { updateCount, deleteCount } = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        const updated =
          await sql`UPDATE "transaction" SET note = 'tenant A trying to touch B' WHERE id = ${txnB}`;
        const deleted = await sql`DELETE FROM "transaction" WHERE id = ${txnB}`;
        return { updateCount: updated.count, deleteCount: deleted.count };
      });
      expect(updateCount).toBe(0);
      expect(deleteCount).toBe(0);

      // Tenant B's row is untouched.
      const [row] = await client<
        { note: string | null }[]
      >`SELECT note FROM "transaction" WHERE id = ${txnB}`;
      expect(row?.note).toBeNull();
    });

    it("tenant A's session cannot INSERT a row tagged with tenant B's tenant_id (the WITH CHECK half of the policy)", async () => {
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_web`;
          await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await sql`
            INSERT INTO "portfolio" (id, tenant_id, name)
            VALUES (${"00000000-0000-7000-8000-0000000a00ff"}, ${tenantB}, 'cross-tenant insert attempt')
          `;
        }),
      ).rejects.toThrow();
    });

    it("tenant A's session can INSERT a row tagged with its own tenant_id", async () => {
      const newPortfolioId = "00000000-0000-7000-8000-0000000a00fe";
      await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await sql`
          INSERT INTO "portfolio" (id, tenant_id, name)
          VALUES (${newPortfolioId}, ${tenantA}, 'same-tenant insert')
        `;
      });

      const [row] = await client<
        { name: string }[]
      >`SELECT name FROM "portfolio" WHERE id = ${newPortfolioId}`;
      expect(row?.name).toBe("same-tenant insert");
    });
  });

  /**
   * T-81 — the
   * `app_admin_bypass` role and the four `SECURITY DEFINER` functions
   * migration `0065` adds. AC-356, AC-379, AC-380, AC-382 (DB half),
   * AC-386, AC-387, AC-397; FR-435, FR-436, NFR-47.
   *
   * Every case switches role with `SET LOCAL ROLE` inside `client.begin(...)`,
   * exactly as the rest of this file does, because a statement issued on the
   * container's superuser connection is structurally blind to a missing or an
   * extra grant — the failure mode this repo has already shipped once
   * (`instrument_backfill_state`, migration `0029`).
   *
   * The fixture here is **additive**: it seeds a third tenant whose user is
   * the instance admin, and one `session` row per pre-existing tenant, so the
   * cross-tenant assertions below have a known, positive expected value
   * rather than only an absence to check. No existing case or seed row is
   * modified (AC-387).
   */
  describe("account-setup guard layer — app_admin_bypass and the SECURITY DEFINER functions (0065, narrowed by 0067)", () => {
    const tenantAdmin = "00000000-0000-7000-8000-0000000c0000";
    const userAdmin = "00000000-0000-7000-8000-0000000c0002";
    const sessionA = "00000000-0000-7000-8000-0000000a0004";
    const sessionB = "00000000-0000-7000-8000-0000000b0004";

    // Migration 0067: `admin_list_users` and `admin_reset_password`
    // are gone — household members share one tenant, so those reads and
    // writes are ordinary RLS-scoped statements now. Two functions remain,
    // both first-run concerns that genuinely have no tenant context.
    const FUNCTION_NAMES = ["setup_needed", "provision_account"] as const;

    /**
     * A **real login** as `app_web`, which the rest of this file does not
     * need and this block does.
     *
     * MEASURED 2026-09-19, and the reason this connection exists: on the
     * container's superuser connection, `SET LOCAL ROLE app_web` followed by
     * `SET LOCAL ROLE app_admin_bypass` **succeeds** — Postgres checks
     * `SET ROLE` against the *session* user, which is still the superuser,
     * not against the role `SET LOCAL ROLE` most recently installed. Written
     * that way (as originally specified) AC-380's first
     * half is a test that cannot fail: it passes identically with and
     * without `GRANT app_admin_bypass TO app_web`. Only a connection whose
     * *session* user is `app_web` discriminates the two.
     */
    let appWebClient: postgres.Sql;

    beforeAll(async () => {
      const APP_WEB_PASSWORD = "roles-rls-test-only";
      await client.unsafe(`ALTER ROLE app_web WITH PASSWORD '${APP_WEB_PASSWORD}'`);
      const appWebUri = new URL(container.getConnectionUri());
      appWebUri.username = "app_web";
      appWebUri.password = APP_WEB_PASSWORD;
      appWebClient = createPostgresClient(appWebUri.toString(), { max: 1 });

      await client`INSERT INTO "tenant" (id) VALUES (${tenantAdmin})`;
      await client`
        INSERT INTO "app_user" (id, tenant_id, email, password_hash, is_instance_admin)
        VALUES (${userAdmin}, ${tenantAdmin}, 'admin@example.com', 'argon2id$placeholder', true)
      `;
      // One live session per pre-existing tenant, so AC-380's "only your own
      // tenant's rows" assertion below is a positive identity check on two
      // candidate rows, not a read that would return [] either way.
      await client`
        INSERT INTO "session" (id, tenant_id, user_id, token_hash, expires_at)
        VALUES (${sessionA}, ${tenantA}, ${userA}, '\\x0a0a', now() + interval '1 day'),
               (${sessionB}, ${tenantB}, ${userB}, '\\x0b0b', now() + interval '1 day')
      `;
    });

    afterAll(async () => {
      await appWebClient?.end({ timeout: 5 });
    });

    it("AC-356 — as app_web, a raw INSERT INTO tenant (not through provision_account) is still permission denied", async () => {
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_web`;
          await sql`
            INSERT INTO "tenant" (id) VALUES (${"00000000-0000-7000-8000-0000000cfff0"})
          `;
        }),
      ).rejects.toThrow(/permission denied/i);

      const [row] = await client<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM "tenant" WHERE id = ${"00000000-0000-7000-8000-0000000cfff0"}`;
      expect(row?.n).toBe("0");
    });

    it("AC-380 — app_web cannot assume app_admin_bypass, and a plain read as app_web still sees only its own tenant's app_user/session rows", async () => {
      // (a) `app_web` is never a member of `app_admin_bypass` (FR-436(a)),
      // proven from a connection whose session user really is `app_web` —
      // see `appWebClient`'s own comment for why the superuser connection
      // cannot prove this.
      await expect(
        appWebClient.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_admin_bypass`;
        }),
      ).rejects.toThrow(/permission denied to set role/i);

      // The catalogue half of the same claim: nobody at all is a member of
      // `app_admin_bypass`, so no future role can reach it transitively
      // either.
      const members = await client<{ member: string }[]>`
        SELECT m.member::regrole::text AS member
        FROM pg_auth_members m
        WHERE m.roleid = 'app_admin_bypass'::regrole
      `;
      expect(members).toEqual([]);

      // (b) The read side, unchanged by this cycle. Positive identity
      // assertions: three app_user rows and two session rows exist, and
      // tenant A's session sees exactly one of each, by id.
      const seen = await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        const users = await sql<{ id: string }[]>`SELECT id FROM "app_user" ORDER BY id`;
        const sessions = await sql<{ id: string }[]>`SELECT id FROM "session" ORDER BY id`;
        return { users, sessions };
      });
      expect(seen.users.map((r) => r.id)).toEqual([userA]);
      expect(seen.sessions.map((r) => r.id)).toEqual([sessionA]);

      // The rows the tenant-A session did not see really do exist — without
      // this the assertions above pass on an empty table.
      const [counts] = await client<{ users: string; sessions: string }[]>`
        SELECT (SELECT count(*)::text FROM "app_user") AS users,
               (SELECT count(*)::text FROM "session") AS sessions
      `;
      expect(counts).toEqual({ users: "3", sessions: "2" });
    });

    it("a pg_temp app_user view does NOT shadow public.app_user inside provision_account, and no second admin is minted", async () => {
      // MEASURED 2026-09-19 (MEDIUM-1). With
      // the pre-fix `SET search_path = public`, Postgres still searched this
      // session's temporary schema FIRST for a relation name, so the function
      // read an empty temp view for its emptiness check and inserted through
      // it — auto-updatably, as `app_admin_bypass` — and a provisioned
      // instance gained a second `is_instance_admin` row. `public, pg_temp`
      // (pg_temp last, in `0065`) is what makes the name below resolve to the
      // real table.
      //
      // On the real `app_web` login, not `SET LOCAL ROLE`: a temp schema
      // belongs to a session, and the attack is only an attack if the session
      // that creates the view is the one the API would be running in.
      const admins = async (): Promise<string> => {
        const [row] = await client<
          { n: string }[]
        >`SELECT count(*)::text AS n FROM public."app_user" WHERE is_instance_admin`;
        return row!.n;
      };
      // The precondition, asserted rather than assumed: exactly one admin
      // exists going in, so "still 1" below is a real invariant and not the
      // reading of an empty table.
      expect(await admins()).toBe("1");

      await expect(
        appWebClient.begin(async (sql) => {
          await sql`CREATE TEMP VIEW "app_user" WITH (security_invoker = true) AS
                      SELECT * FROM public."app_user" WHERE false`;
          await sql`GRANT SELECT, INSERT, UPDATE ON "app_user" TO app_admin_bypass`;
          await sql`
            SELECT provision_account(
              ${"00000000-0000-7000-8000-0000000cfff5"}::uuid,
              ${"00000000-0000-7000-8000-0000000cfff6"}::uuid,
              'evil@example.com'::citext,
              ${"argon2id$placeholder"},
              'EUR'::char(3)
            )
          `;
        }),
        // Discriminating on the SQLSTATE, not merely on "it threw": a failure
        // to create the view would also throw, and would prove nothing.
      ).rejects.toMatchObject({ code: "55000" });

      expect(await admins()).toBe("1");
      const [row] = await client<{ n: string }[]>`
        SELECT count(*)::text AS n FROM public."app_user" WHERE email = 'evil@example.com'
      `;
      expect(row!.n).toBe("0");
    });

    it("app_web holds neither UPDATE nor INSERT on app_user.is_instance_admin, and does hold both on the columns it writes", async () => {
      const [privileges] = await client<
        {
          flag_update: boolean;
          flag_insert: boolean;
          email_update: boolean;
          hash_update: boolean;
          last_login_update: boolean;
          email_insert: boolean;
          select_table: boolean;
          delete_table: boolean;
          verified_insert: boolean;
        }[]
      >`
        SELECT has_column_privilege('app_web', 'app_user', 'is_instance_admin', 'UPDATE') AS flag_update,
               has_column_privilege('app_web', 'app_user', 'is_instance_admin', 'INSERT') AS flag_insert,
               has_column_privilege('app_web', 'app_user', 'email', 'UPDATE') AS email_update,
               has_column_privilege('app_web', 'app_user', 'password_hash', 'UPDATE') AS hash_update,
               has_column_privilege('app_web', 'app_user', 'last_login_at', 'UPDATE') AS last_login_update,
               has_column_privilege('app_web', 'app_user', 'email', 'INSERT') AS email_insert,
               has_table_privilege('app_web', 'app_user', 'SELECT') AS select_table,
               has_table_privilege('app_web', 'app_user', 'DELETE') AS delete_table,
               has_column_privilege('app_web', 'app_user', 'email_verified_at', 'INSERT') AS verified_insert
      `;
      // The negatives and the positives in one row, deliberately: a `false`
      // on the flag means "revoked" only if the columns `changeEmail`,
      // `changePassword` and `login` write are still `true` — a blanket
      // REVOKE would satisfy the two negatives on its own.
      expect(privileges).toEqual({
        flag_update: false,
        flag_insert: false,
        email_update: true,
        hash_update: true,
        last_login_update: true,
        email_insert: true,
        select_table: true,
        // NEW-3/NEW-4 (security confirm pass): no DELETE at all, and the
        // INSERT list is exactly the four columns createUser names.
        delete_table: false,
        verified_insert: false,
      });
    });

    it("as app_web, self-promotion by plain UPDATE and by INSERT is permission denied, while the granted columns still write", async () => {
      // The finding itself: before the column-scoped grants, this statement
      // succeeded under `app_web`'s own tenant policy and promoted the caller
      // without going near any of the four functions.
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_web`;
          await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await sql`UPDATE "app_user" SET is_instance_admin = true WHERE id = ${userA}`;
        }),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_web`;
          await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
          await sql`
            INSERT INTO "app_user" (id, tenant_id, email, password_hash, is_instance_admin)
            VALUES (${"00000000-0000-7000-8000-0000000cfff7"}, ${tenantA},
                    'promoted@example.com', 'argon2id$placeholder', true)
          `;
        }),
      ).rejects.toThrow(/permission denied/i);

      // Neither refusal was a policy refusal in disguise: the same role, in
      // the same transaction shape, writes the columns it was granted.
      await client.begin(async (sql) => {
        await sql`SET LOCAL ROLE app_web`;
        await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await sql`UPDATE "app_user" SET last_login_at = now() WHERE id = ${userA}`;
        await sql`
          INSERT INTO "app_user" (id, tenant_id, email, password_hash)
          VALUES (${"00000000-0000-7000-8000-0000000cfff8"}, ${tenantA},
                  'ordinary@example.com', 'argon2id$placeholder')
        `;
      });

      const [row] = await client<{ is_instance_admin: boolean }[]>`
        SELECT is_instance_admin FROM "app_user" WHERE id = ${"00000000-0000-7000-8000-0000000cfff8"}
      `;
      expect(row).toEqual({ is_instance_admin: false });
      // The row the two refusals would have written is absent, and the target
      // of the UPDATE is still not an admin.
      const [after] = await client<{ flag: boolean; promoted: string }[]>`
        SELECT (SELECT is_instance_admin FROM "app_user" WHERE id = ${userA}) AS flag,
               (SELECT count(*)::text FROM "app_user" WHERE email = 'promoted@example.com') AS promoted
      `;
      expect(after).toEqual({ flag: false, promoted: "0" });

      // The positive control's two writes are undone here, on the superuser
      // client: later cases in this describe assert the exact set of
      // `app_user` rows (AC-379's `admin_list_users` identity assertion), and
      // AC-387 asks for a fixture no new case disturbs.
      await client`DELETE FROM "app_user" WHERE id = ${"00000000-0000-7000-8000-0000000cfff8"}`;
      await client`UPDATE "app_user" SET last_login_at = NULL WHERE id = ${userA}`;
    });

    it("provision_account called as app_web on a provisioned instance raises 55000 and creates nothing: first-run only, no caller branch left", async () => {
      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_web`;
          await sql`
            SELECT provision_account(
              ${"00000000-0000-7000-8000-0000000cfff1"},
              ${"00000000-0000-7000-8000-0000000cfff2"},
              'second-tenant@example.com',
              'argon2id$placeholder',
              'EUR'
            )
          `;
        }),
      ).rejects.toMatchObject({ code: "55000" });

      const [row] = await client<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM "tenant" WHERE id = ${"00000000-0000-7000-8000-0000000cfff1"}`;
      expect(row?.n).toBe("0");
      const gone = await client<{ proname: string }[]>`
        SELECT proname FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('admin_list_users', 'admin_reset_password')
      `;
      expect(gone).toEqual([]);
    });

    it("AC-379 (narrowed by 0067) — app_admin_bypass holds SELECT on tenant and app_user only, nothing on session, and no UPDATE on app_user", async () => {
      const tables = await client<{ relname: string; can_select: boolean }[]>`
        SELECT c.relname,
               has_table_privilege('app_admin_bypass', c.oid, 'SELECT') AS can_select
        FROM pg_class c
        WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        ORDER BY c.relname
      `;
      // A guard on the guard: an empty catalogue read would
      // make the offender list below vacuously empty.
      expect(tables.length).toBeGreaterThan(20);

      const granted = new Set(["tenant", "app_user"]);
      const offenders = tables
        .filter((t) => t.can_select !== granted.has(t.relname))
        .map((t) => `${t.relname} (SELECT=${t.can_select})`);
      expect(offenders).toEqual([]);

      const [sessionPrivs] = await client<{ any_priv: boolean }[]>`
        SELECT bool_or(has_table_privilege('app_admin_bypass', 'session', p)) AS any_priv
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p
      `;
      expect(sessionPrivs?.any_priv).toBe(false);
      const [appUserUpdate] = await client<{ ok: boolean }[]>`
        SELECT has_table_privilege('app_admin_bypass', 'app_user', 'UPDATE') AS ok
      `;
      expect(appUserUpdate?.ok).toBe(false);
    });

    it("GATE-1 add-on A1 — app_admin_bypass holds DELETE on none of tenant/app_user/session (FR-448)", async () => {
      // FR-448 grants the owning role exactly what the four function bodies
      // need and no more; DELETE is on none of the three, which is what
      // makes "no route exists to delete a tenant or user" (FR-426/NG4) a
      // privilege fact and not only an absence of code. Named per table, so
      // a failure says which grant leaked.
      const rows = await client<{ relname: string; can_delete: boolean }[]>`
        SELECT c.relname,
               has_table_privilege('app_admin_bypass', c.oid, 'DELETE') AS can_delete
        FROM pg_class c
        WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
          AND c.relname = ANY(ARRAY['tenant', 'app_user', 'session'])
        ORDER BY c.relname
      `;
      // The guard on the guard: three real rows, so an empty read cannot
      // make the offender list below vacuously empty.
      expect(rows.map((r) => r.relname)).toEqual(["app_user", "session", "tenant"]);
      expect(rows.filter((r) => r.can_delete).map((r) => r.relname)).toEqual([]);
    });

    it("AC-380/AC-386 — app_ingest can execute neither remaining function, statically and behaviourally", async () => {
      const rows = await client<{ proname: string; ingest: boolean; web: boolean }[]>`
        SELECT p.proname,
               has_function_privilege('app_ingest', p.oid, 'EXECUTE') AS ingest,
               has_function_privilege('app_web', p.oid, 'EXECUTE') AS web
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = ANY(${[...FUNCTION_NAMES]}::text[])
        ORDER BY p.proname
      `;
      expect(rows.map((r) => r.proname).sort()).toEqual([...FUNCTION_NAMES].sort());
      for (const row of rows) {
        expect({ name: row.proname, ingest: row.ingest }).toEqual({
          name: row.proname,
          ingest: false,
        });
        // The positive half: the same query on the same oid says `true` for
        // app_web, so a `false` above is a real revocation and not an oid
        // that resolved to nothing.
        expect({ name: row.proname, web: row.web }).toEqual({ name: row.proname, web: true });
      }

      await expect(
        client.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_ingest`;
          await sql`SELECT setup_needed()`;
        }),
      ).rejects.toThrow(/permission denied for function/i);
    });

    it("AC-386 — the pg_proc pin covers EVERY SECURITY DEFINER function in public: search_path pinned to 'public, pg_temp', no PUBLIC or app_ingest EXECUTE, owner app_admin_bypass or app_owner", async () => {
      interface ProcRow {
        readonly proname: string;
        readonly owner: string;
        readonly prosecdef: boolean;
        readonly proconfig: readonly string[] | null;
        readonly web: boolean;
        readonly ingest: boolean;
        readonly pub: boolean;
      }
      // Read every function in the schema, then assert the four are present
      // BY NAME before asserting anything about them — "every function found
      // passes" is vacuously true when none is found.
      const all = await client<ProcRow[]>`
        SELECT p.proname,
               p.proowner::regrole::text AS owner,
               p.prosecdef,
               p.proconfig,
               has_function_privilege('app_web', p.oid, 'EXECUTE') AS web,
               has_function_privilege('app_ingest', p.oid, 'EXECUTE') AS ingest,
               has_function_privilege('public', p.oid, 'EXECUTE') AS pub
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        ORDER BY p.proname
      `;
      expect(all.length).toBeGreaterThan(FUNCTION_NAMES.length);

      // A definer function that ships unpinned must
      // turn this red by name, whichever migration adds it. 0055's
      // `trg_tenant_base_currency_immutable_fn` (owned by app_owner, called
      // only by its trigger) got the pg_temp-safe pin in 0067.
      const definers = all.filter((p) => p.prosecdef);
      expect(definers.map((p) => p.proname).sort()).toEqual(
        [...FUNCTION_NAMES, "trg_tenant_base_currency_immutable_fn"].sort(),
      );
      // The owner must be a role that actually bypasses RLS: `app_admin_bypass`
      // (BYPASSRLS) or the migrating superuser (0055's trigger). An
      // `app_owner`-owned definer body sees zero rows under FORCE ROW LEVEL
      // SECURITY, so it is the one owner this assertion must never accept.
      const superusers = new Set(
        (await client<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolsuper`).map(
          (r) => r.rolname,
        ),
      );
      for (const row of definers) {
        expect(
          row.owner === "app_admin_bypass" || superusers.has(row.owner),
          `${row.proname} is owned by ${row.owner}, which bypasses no RLS`,
        ).toBe(true);
        expect(row.owner).not.toBe("app_owner");
        expect(row.proconfig, `${row.proname} is not pinned to 'public, pg_temp'`).toContain(
          "search_path=public, pg_temp",
        );
        expect({ name: row.proname, ingest: row.ingest, pub: row.pub }).toEqual({
          name: row.proname,
          ingest: false,
          pub: false,
        });
      }

      for (const name of FUNCTION_NAMES) {
        const row = all.find((p) => p.proname === name);
        expect(row, `${name} is absent from pg_proc`).toBeDefined();
        expect({ name, ...row! }).toMatchObject({
          name,
          owner: "app_admin_bypass",
          prosecdef: true,
          web: true,
          ingest: false,
          pub: false,
        });
        // The exact stored spelling, probed on postgres:17 (2026-09-19)
        // rather than guessed: `SET search_path = public, pg_temp` is stored
        // in `proconfig` as the single element `search_path=public, pg_temp`,
        // comma-space and all. Asserted whole, because the earlier pin
        // (`= public`) satisfies any substring or prefix form of this check —
        // which is exactly how a search_path assertion can exist and still
        // miss the shadowing this one is here for.
        expect(row!.proconfig, `${name} is not pinned to 'public, pg_temp'`).toContain(
          "search_path=public, pg_temp",
        );
      }
    });

    it("AC-397 — exactly one non-superuser role carries BYPASSRLS, it is app_admin_bypass, and it is NOLOGIN", async () => {
      const rows = await client<{ rolname: string; rolcanlogin: boolean }[]>`
        SELECT rolname, rolcanlogin FROM pg_roles WHERE rolbypassrls AND NOT rolsuper
        ORDER BY rolname
      `;
      expect(rows).toEqual([{ rolname: "app_admin_bypass", rolcanlogin: false }]);

      // D-4, MEASURED here rather than assumed: the catalogue-wide
      // count is 2, not 1, because the bootstrap superuser also carries
      // `rolbypassrls` — which is why the assertion above filters on
      // `NOT rolsuper`. Asserted, so the filter's justification cannot
      // silently stop being true.
      const catalogueWide = await client<{ rolname: string; rolsuper: boolean }[]>`
        SELECT rolname, rolsuper FROM pg_roles WHERE rolbypassrls ORDER BY rolname
      `;
      expect(catalogueWide).toHaveLength(2);
      expect(catalogueWide.filter((r) => r.rolsuper)).toHaveLength(1);
      expect(catalogueWide.filter((r) => !r.rolsuper).map((r) => r.rolname)).toEqual([
        "app_admin_bypass",
      ]);
    });
  });
});
