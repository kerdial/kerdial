import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "@kerdial/core-decimal";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_CALENDAR_HOLIDAYS } from "./seed-data/market-calendar.js";
import { createDb, createPostgresClient, type Db } from "./client.js";
import {
  fxRateDaily,
  fxRateUser,
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentQuoteLatest,
  manualPricePoint,
  marketCalendar,
  providerFetchLog,
  tenant,
} from "./schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

/**
 * T-7 acceptance: migrations apply cleanly from empty against a real
 * Postgres 17 container; `market_calendar` is seeded from the checked-in
 * static dataset; the shared-vs-tenant-owned
 * `tenant_id` split (FR-45, AC33) holds at the schema level; and the
 * indexes (PK + BRIN on `instrument_price_daily`) exist.
 */
describe("platform/db — market/reference-data schema (T-7, Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: Db;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    client = createPostgresClient(container.getConnectionUri());
    db = createDb(client);
    await migrate(db, { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  it("applies every migration cleanly from an empty database, creating all T-7 tables", async () => {
    const tables = await client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const tableNames = new Set(tables.map((t) => t.table_name));
    for (const expected of [
      "fx_rate_daily",
      "fx_rate_user",
      "instrument_price_daily",
      "manual_price_point",
      "instrument_quote_latest",
      "provider_fetch_log",
      "instrument_backfill_state",
      "market_calendar",
    ]) {
      expect(tableNames.has(expected)).toBe(true);
    }
  });

  describe("tenant_id split — shared reference data vs. tenant-owned data (FR-45, AC33)", () => {
    it("fx_rate_daily and instrument_price_daily carry no tenant_id column (shared reference data)", async () => {
      const rows = await client<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name IN ('fx_rate_daily', 'instrument_price_daily')
      `;
      expect(rows).toHaveLength(0);
    });

    it("instrument_quote_latest and market_calendar also carry no tenant_id column (shared reference data)", async () => {
      const rows = await client<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name IN ('instrument_quote_latest', 'market_calendar')
      `;
      expect(rows).toHaveLength(0);
    });

    it("fx_rate_user and manual_price_point carry tenant_id NOT NULL (tenant-owned)", async () => {
      const rows = await client<{ table_name: string; is_nullable: string }[]>`
        SELECT table_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name IN ('fx_rate_user', 'manual_price_point')
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.is_nullable).toBe("NO");
      }
    });
  });

  describe("market_calendar — static checked-in seed", () => {
    it("is seeded with exactly the checked-in holiday dataset (row-count assertion)", async () => {
      const rows = await db.select().from(marketCalendar);
      expect(rows).toHaveLength(MARKET_CALENDAR_HOLIDAYS.length);
    });

    it("spot-checks 2025-12-25 marked closed for Euronext Paris, NYSE, and NASDAQ", async () => {
      const rows = await client<{ calendar_key: string; is_open: boolean }[]>`
        SELECT calendar_key, is_open FROM market_calendar
        WHERE session_date = '2025-12-25' AND calendar_key IN ('XPAR', 'XNYS', 'XNAS')
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.is_open).toBe(false);
      }
    });

    it("spot-checks the TARGET FX closing-day calendar is also seeded for 2025-12-25", async () => {
      const rows = await client<{ is_open: boolean }[]>`
        SELECT is_open FROM market_calendar
        WHERE session_date = '2025-12-25' AND calendar_key = 'TARGET'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_open).toBe(false);
    });

    it("covers 2024, 2025, and 2026 for every calendar", async () => {
      const rows = await client<{ calendar_key: string; yr: string }[]>`
        SELECT DISTINCT calendar_key, date_part('year', session_date)::text AS yr
        FROM market_calendar
        ORDER BY calendar_key, yr
      `;
      const byCalendar = new Map<string, Set<string>>();
      for (const row of rows) {
        const years = byCalendar.get(row.calendar_key) ?? new Set<string>();
        years.add(row.yr);
        byCalendar.set(row.calendar_key, years);
      }
      for (const calendarKey of ["XPAR", "XNYS", "XNAS", "TARGET"]) {
        const years = byCalendar.get(calendarKey);
        expect(years?.has("2024")).toBe(true);
        expect(years?.has("2025")).toBe(true);
        expect(years?.has("2026")).toBe(true);
      }
    });
  });

  describe("indexing", () => {
    it("instrument_price_daily has a covering PK on (instrument_id, price_date)", async () => {
      const rows = await client<{ column_name: string; ordinal_position: number }[]>`
        SELECT kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'instrument_price_daily'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position
      `;
      expect(rows.map((r) => r.column_name)).toEqual(["instrument_id", "price_date"]);
    });

    it("instrument_price_daily has a BRIN index on ingested_at", async () => {
      const rows = await client<{ indexdef: string; indexname: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'instrument_price_daily'
      `;
      const brinIndex = rows.find((r) => r.indexdef.toLowerCase().includes("using brin"));
      expect(brinIndex).toBeDefined();
      expect(brinIndex?.indexdef.toLowerCase()).toContain("ingested_at");
    });
  });

  describe("decimalCol round-trip on real market-data tables (NFR-12)", () => {
    it("round-trips an fx_rate_daily rate (12dp) and an instrument_price_daily close (18dp) as Decimal", async () => {
      const [createdTenant] = await db
        .insert(tenant)
        .values({ id: "00000000-0000-7000-8000-000000000200" })
        .returning();
      expect(createdTenant?.id).toBe("00000000-0000-7000-8000-000000000200");

      const [createdInstrument] = await db
        .insert(instrument)
        .values({
          id: "00000000-0000-7000-8000-000000000201",
          kind: "CRYPTO",
          displayName: "Ether",
          listingCurrency: "USD",
          symbol: "ETH-T7",
          primaryIdentifier: "SYMBOL",
          quotePolicy: "AUTO",
        })
        .returning();
      expect(createdInstrument?.id).toBe("00000000-0000-7000-8000-000000000201");

      const rate = new Decimal("0.92345678");
      const [insertedRate] = await db
        .insert(fxRateDaily)
        .values({
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2026-07-20",
          rate,
          sourceKey: "ecb",
        })
        .returning();
      expect(insertedRate?.rate).toBeInstanceOf(Decimal);
      expect(insertedRate?.rate.equals(rate)).toBe(true);

      const closeRaw = new Decimal("1234.123456789012345678");
      const [insertedPrice] = await db
        .insert(instrumentPriceDaily)
        .values({
          instrumentId: "00000000-0000-7000-8000-000000000201",
          priceDate: "2026-07-20",
          closeRaw,
          currency: "USD",
          sourceKey: "coingecko",
          quality: "EOD",
        })
        .returning();
      expect(insertedPrice?.closeRaw).toBeInstanceOf(Decimal);
      expect(insertedPrice?.closeRaw.equals(closeRaw)).toBe(true);

      // fx_rate_user, manual_price_point, instrument_quote_latest,
      // provider_fetch_log, instrument_backfill_state — one insert each to
      // prove the FK wiring and decimalCol columns are all sound end to end.
      const [insertedUserRate] = await db
        .insert(fxRateUser)
        .values({
          tenantId: "00000000-0000-7000-8000-000000000200",
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2026-07-20",
          rate: new Decimal("0.9"),
        })
        .returning();
      expect(insertedUserRate?.sourceKey).toBe("user");

      const [insertedManualPrice] = await db
        .insert(manualPricePoint)
        .values({
          tenantId: "00000000-0000-7000-8000-000000000200",
          instrumentId: "00000000-0000-7000-8000-000000000201",
          priceDate: "2026-07-20",
          close: new Decimal("1200.5"),
          currency: "USD",
        })
        .returning();
      expect(insertedManualPrice?.sourceKey).toBe("manual");

      const [insertedQuote] = await db
        .insert(instrumentQuoteLatest)
        .values({
          instrumentId: "00000000-0000-7000-8000-000000000201",
          price: new Decimal("1235.5"),
          currency: "USD",
          asOf: new Date("2026-07-20T12:00:00Z"),
          quality: "REALTIME",
          sourceKey: "coingecko",
        })
        .returning();
      expect(insertedQuote?.price).toBeInstanceOf(Decimal);

      const [insertedFetchLog] = await db
        .insert(providerFetchLog)
        .values({
          id: "00000000-0000-7000-8000-000000000202",
          providerKey: "coingecko",
          endpoint: "/simple/price",
          status: "SUCCESS",
          latencyMs: 120,
          rowsFetched: 1,
        })
        .returning();
      expect(insertedFetchLog?.status).toBe("SUCCESS");

      const [insertedBackfillState] = await db
        .insert(instrumentBackfillState)
        .values({
          instrumentId: "00000000-0000-7000-8000-000000000201",
          requestedFrom: "2016-07-20",
        })
        .returning();
      expect(insertedBackfillState?.status).toBe("PENDING");
    });
  });
});
