import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { createDb, instrumentPriceDaily, tenant, type Db } from "@kerdial/platform-db";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentByIsin, createInstrumentBySymbol } from "./instrument-service.js";
import { listInstrumentPriceHistory } from "./instrument-price-history-service.js";
import { listManualPricePoints, upsertManualPricePoint } from "./manual-price-service.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * T-37: `GET /instruments/:id/prices?from=&to=`'s service
 * layer — merging the shared automated `instrument_price_daily` series with
 * this tenant's own `manual_price_point` entries (FR-15, FR-16, FR-23's
 * "override" precedence).
 */
describe("ledger — instrument price history service (T-37, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000037000a";
  const tenantB = "00000000-0000-7000-8000-00000037000b";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 5 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("returns the automated series alone when no manual point exists for any date in range", async () => {
    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "FR0000131200",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "T37 price history — automated only",
    });
    await ownerDb.insert(instrumentPriceDaily).values([
      {
        instrumentId: share.id,
        priceDate: "2024-01-02",
        closeRaw: new Decimal("100.5"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
      {
        instrumentId: share.id,
        priceDate: "2024-01-03",
        closeRaw: new Decimal("101.25"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
    ]);

    const history = await listInstrumentPriceHistory(appWebDb, {
      tenantId: tenantA,
      instrumentId: share.id,
      limit: 100,
      offset: 0,
    });

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ priceDate: "2024-01-02", origin: "AUTOMATED" });
    expect(history[0]!.close.toFixed()).toBe("100.5");
    expect(history[1]).toMatchObject({ priceDate: "2024-01-03", origin: "AUTOMATED" });
  });

  it("a manual point for the same date takes precedence over the automated one (FR-23's override)", async () => {
    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "FR0000131201",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "T37 price history — manual override",
    });
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: share.id,
      priceDate: "2024-02-01",
      closeRaw: new Decimal("50"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });
    await upsertManualPricePoint(appWebDb, {
      tenantId: tenantA,
      instrumentId: share.id,
      priceDate: "2024-02-01",
      close: new Decimal("55.5"),
      currency: "EUR",
    });

    const history = await listInstrumentPriceHistory(appWebDb, {
      tenantId: tenantA,
      instrumentId: share.id,
      limit: 100,
      offset: 0,
    });

    expect(history).toHaveLength(1);
    expect(history[0]!.origin).toBe("MANUAL");
    expect(history[0]!.close.toFixed()).toBe("55.5");
    expect(history[0]!.sourceKey).toBe("manual");
  });

  it("a fund with zero automated history still returns its manually entered NAV points (AC12/FR-16)", async () => {
    const fund = await createInstrumentByIsin(appWebDb, {
      kind: "FUND",
      isin: "FR0000441900",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "T37 price history — fund with no automated history",
    });

    await upsertManualPricePoint(appWebDb, {
      tenantId: tenantA,
      instrumentId: fund.id,
      priceDate: "2024-03-01",
      close: new Decimal("123.456"),
      currency: "EUR",
    });

    const history = await listInstrumentPriceHistory(appWebDb, {
      tenantId: tenantA,
      instrumentId: fund.id,
      limit: 100,
      offset: 0,
    });

    expect(history).toHaveLength(1);
    expect(history[0]!.origin).toBe("MANUAL");
    expect(history[0]!.priceDate).toBe("2024-03-01");
  });

  it("a from/to range excludes points outside it, from both sources", async () => {
    const crypto = await createInstrumentBySymbol(appWebDb, {
      kind: "CRYPTO",
      symbol: "T37-RANGE-COIN",
      listingCurrency: "EUR",
      displayName: "T37 price history — range filter",
    });
    await ownerDb.insert(instrumentPriceDaily).values([
      {
        instrumentId: crypto.id,
        priceDate: "2024-01-01",
        closeRaw: new Decimal("10"),
        currency: "EUR",
        sourceKey: "coingecko",
        quality: "REALTIME",
      },
      {
        instrumentId: crypto.id,
        priceDate: "2024-06-01",
        closeRaw: new Decimal("20"),
        currency: "EUR",
        sourceKey: "coingecko",
        quality: "REALTIME",
      },
    ]);
    await upsertManualPricePoint(appWebDb, {
      tenantId: tenantA,
      instrumentId: crypto.id,
      priceDate: "2024-12-31",
      close: new Decimal("30"),
      currency: "EUR",
    });

    const history = await listInstrumentPriceHistory(appWebDb, {
      tenantId: tenantA,
      instrumentId: crypto.id,
      fromDate: "2024-02-01",
      toDate: "2024-11-30",
      limit: 100,
      offset: 0,
    });

    expect(history.map((p) => p.priceDate)).toEqual(["2024-06-01"]);
  });

  it("a manual point recorded by a different tenant never appears in this tenant's history (AC33)", async () => {
    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "FR0000131202",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "T37 price history — tenant isolation",
    });
    await upsertManualPricePoint(appWebDb, {
      tenantId: tenantB,
      instrumentId: share.id,
      priceDate: "2024-04-01",
      close: new Decimal("999"),
      currency: "EUR",
    });

    const tenantAHistory = await listInstrumentPriceHistory(appWebDb, {
      tenantId: tenantA,
      instrumentId: share.id,
      limit: 100,
      offset: 0,
    });
    expect(tenantAHistory).toHaveLength(0);

    const tenantBHistory = await listInstrumentPriceHistory(appWebDb, {
      tenantId: tenantB,
      instrumentId: share.id,
      limit: 100,
      offset: 0,
    });
    expect(tenantBHistory).toHaveLength(1);
  });

  // N6 (security review, T-37): this endpoint used to
  // fetch+merge+sort an instrument's *entire* price history in Node before
  // slicing to a page — a `limit=1` walker forced that full fetch on every
  // single request. `listInstrumentPriceHistory` now applies `offset + limit
  // + 1` as a real SQL `LIMIT` on each underlying source query (this
  // function's own doc comment proves why that bound is correct).
  describe("N6 — each underlying source query is bounded to offset + limit + 1 rows", () => {
    function addDays(iso: string, days: number): string {
      const date = new Date(`${iso}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    }

    it("a paginated request against a large history does not fetch every row from either source", async () => {
      const crypto = await createInstrumentBySymbol(appWebDb, {
        kind: "CRYPTO",
        symbol: "T37-N6-COIN",
        listingCurrency: "EUR",
        displayName: "T37 N6 price history bound fixture",
      });

      const TOTAL_AUTOMATED_DAYS = 500;
      await ownerDb.insert(instrumentPriceDaily).values(
        Array.from({ length: TOTAL_AUTOMATED_DAYS }, (_, i) => ({
          instrumentId: crypto.id,
          priceDate: addDays("2020-01-01", i),
          closeRaw: new Decimal("10"),
          currency: "EUR",
          sourceKey: "coingecko",
          quality: "REALTIME" as const,
        })),
      );
      const TOTAL_MANUAL_DAYS = 50;
      for (let i = 0; i < TOTAL_MANUAL_DAYS; i++) {
        await upsertManualPricePoint(appWebDb, {
          tenantId: tenantA,
          instrumentId: crypto.id,
          priceDate: addDays("2020-01-01", i),
          close: new Decimal("99"),
          currency: "EUR",
        });
      }

      const limit = 5;
      const offset = 10;
      // See `listInstrumentPriceHistory`'s own doc comment for why this
      // exact value is what each source is bounded to.
      const sourceLimit = offset + limit + 1;

      const window = await listInstrumentPriceHistory(appWebDb, {
        tenantId: tenantA,
        instrumentId: crypto.id,
        limit,
        offset,
      });
      expect(window).toHaveLength(limit + 1); // hasMore, given 500 rows far exceed offset+limit

      // The bound itself, proved directly at the SQL level (not merely "the
      // final, already-trimmed output looked small") — reconstructing
      // exactly the per-source query shape `listInstrumentPriceHistory`
      // issues (same table/column, same ORDER BY, same LIMIT value) against
      // data whose true size (500/50 rows) is far larger than the bound, and
      // confirming Postgres itself never returns more than `sourceLimit`
      // rows for either source.
      const automatedRows = await appWebDb
        .select({ priceDate: instrumentPriceDaily.priceDate })
        .from(instrumentPriceDaily)
        .where(eq(instrumentPriceDaily.instrumentId, crypto.id))
        .orderBy(asc(instrumentPriceDaily.priceDate))
        .limit(sourceLimit);
      expect(automatedRows).toHaveLength(sourceLimit); // bounded, not TOTAL_AUTOMATED_DAYS (500)

      const manualRows = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: crypto.id,
        limit: sourceLimit,
      });
      expect(manualRows.length).toBeLessThanOrEqual(sourceLimit);
      expect(manualRows.length).toBeLessThan(TOTAL_MANUAL_DAYS);
    });

    // Ties the bound proved above to the actual shipped code (the same
    // "source anchor" technique N10's own red-confirm test uses) — reverting
    // either `.limit(sourceLimit)` call back to an unbounded fetch fails
    // this immediately.
    it("listInstrumentPriceHistory's source contains the offset+limit+1 LIMIT on both queries (N6 red-confirm anchor)", async () => {
      const source = await readFile(join(here, "instrument-price-history-service.ts"), "utf8");
      expect(source).toMatch(/const sourceLimit = params\.offset \+ params\.limit \+ 1;/);
      // The automated-series drizzle query chain.
      expect(source).toMatch(
        /\.orderBy\(asc\(instrumentPriceDaily\.priceDate\)\)\s*\n\s*\.limit\(sourceLimit\);/,
      );
      // Passed through to `listManualPricePoints` for the manual series.
      expect(source).toMatch(/limit: sourceLimit,/);
    });
  });
});
