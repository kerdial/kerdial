import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  createDb,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentQuoteLatest,
  manualPricePoint,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getInstrumentBackfillStatus } from "./instrument-backfill-status-service.js";
import { getInstrumentPriceFreshness } from "./instrument-price-freshness-service.js";
import { createInstrumentByIsin } from "./instrument-service.js";

/**
 * `getInstrumentPriceFreshness` against a real Postgres 17
 * container as `app_web`, the same shape as
 * `instrument-backfill-status-service.integration.test.ts` beside it.
 *
 * The bug this read exists for was not a wrong number, it was the *wrong
 * column being shown*: the Instruments screen rendered
 * `instrument_backfill_state.latest_backfilled_date` under « Mise à jour », and
 * nothing on the quote path writes that column — so the first test below is
 * the load-bearing one. It writes a quote exactly as
 * `market/ingestion`'s quote-refresh handler does, and asserts both halves of
 * the fix: freshness moved, and the bookmark did not.
 *
 * `ownerDb` seeds the rows out of band (the quote and price tables are
 * ingestion-owned; `app_web` reads them and does not write them, which is
 * itself worth exercising — every read below goes through `appWebDb`).
 */
describe("ledger — instrument price freshness read (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000042400a";
  const tenantB = "00000000-0000-7000-8000-00000042400b";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("moves with a quote write while the backfill bookmark stays put — the whole point", async () => {
    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "XS0000424001",
      exchangeMic: "XCSE",
      listingCurrency: "DKK",
      displayName: "quote-vs-bookmark fixture",
    });
    // A backfill that ran a week ago and stopped there: bookmark 2026-09-01,
    // and a daily series that ends on the same day.
    await ownerDb.insert(instrumentBackfillState).values({
      instrumentId: share.id,
      requestedFrom: "2006-08-26",
      status: "COMPLETE",
      earliestBackfilledDate: "2006-08-28",
      latestBackfilledDate: "2026-09-01",
    });
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: share.id,
      priceDate: "2026-09-01",
      closeRaw: new Decimal("39.25"),
      currency: "DKK",
      sourceKey: "yahoo",
      quality: "DELAYED",
    });

    const before = await getInstrumentPriceFreshness(appWebDb, {
      tenantId: tenantA,
      instrumentId: share.id,
    });
    expect(before).toEqual({ lastQuoteAt: null, latestPriceDate: "2026-09-01" });

    // Exactly what one « Actualiser les cours » press produces per instrument:
    // `upsertQuoteLatestViaDb` + `upsertPriceDailyFromQuotesViaDb`, and
    // deliberately nothing at all in `instrument_backfill_state`.
    await ownerDb.insert(instrumentQuoteLatest).values({
      instrumentId: share.id,
      price: new Decimal("39.94"),
      currency: "DKK",
      asOf: new Date("2026-09-07T10:44:43.000Z"),
      quality: "DELAYED",
      sourceKey: "yahoo",
    });
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: share.id,
      priceDate: "2026-09-07",
      closeRaw: new Decimal("39.94"),
      currency: "DKK",
      sourceKey: "yahoo",
      quality: "DELAYED",
    });

    const after = await getInstrumentPriceFreshness(appWebDb, {
      tenantId: tenantA,
      instrumentId: share.id,
    });
    expect(after).toEqual({
      lastQuoteAt: "2026-09-07T10:44:43Z",
      latestPriceDate: "2026-09-07",
    });

    // The other half, and the reason this read had to exist rather than the
    // quote path bumping the bookmark: the bookmark is a *resume* position
    // (the backfill continues from `latest_backfilled_date + 1`), so it is
    // still 2026-09-01 — which is precisely why the screen could not read it
    // as freshness.
    const status = await getInstrumentBackfillStatus(appWebDb, share.id);
    expect(status.latestBackfilledDate).toBe("2026-09-01");
  });

  it("answers the no-observation shape for an instrument nothing was ever fetched for, and for an id that does not exist", async () => {
    const fund = await createInstrumentByIsin(appWebDb, {
      kind: "FUND",
      isin: "XS0000424002",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "never-fetched fixture",
    });

    expect(
      await getInstrumentPriceFreshness(appWebDb, { tenantId: tenantA, instrumentId: fund.id }),
    ).toEqual({ lastQuoteAt: null, latestPriceDate: null });

    // Total over every id: the controller's own `getInstrumentById` pre-check
    // is what turns a nonexistent instrument into a 404, so this read must not
    // throw for one.
    expect(
      await getInstrumentPriceFreshness(appWebDb, {
        tenantId: tenantA,
        instrumentId: "00000000-0000-7000-8000-0000004240ff",
      }),
    ).toEqual({ lastQuoteAt: null, latestPriceDate: null });
  });

  it("merges this tenant's manual points into the series date — and only this tenant's", async () => {
    const fund = await createInstrumentByIsin(appWebDb, {
      kind: "FUND",
      isin: "XS0000424003",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "manual-points-only fixture",
    });

    // An instrument with no quote row and no automated series: the manual
    // half is the only freshness it has.
    await ownerDb.insert(manualPricePoint).values({
      tenantId: tenantA,
      instrumentId: fund.id,
      priceDate: "2026-09-04",
      close: new Decimal("112.50"),
      currency: "EUR",
    });
    // Another tenant's, newer, and invisible here: freshness is answered per
    // reader, and tenant B's point must not widen tenant A's answer.
    await ownerDb.insert(manualPricePoint).values({
      tenantId: tenantB,
      instrumentId: fund.id,
      priceDate: "2026-09-06",
      close: new Decimal("113.00"),
      currency: "EUR",
    });

    expect(
      await getInstrumentPriceFreshness(appWebDb, { tenantId: tenantA, instrumentId: fund.id }),
    ).toEqual({ lastQuoteAt: null, latestPriceDate: "2026-09-04" });
    expect(
      await getInstrumentPriceFreshness(appWebDb, { tenantId: tenantB, instrumentId: fund.id }),
    ).toEqual({ lastQuoteAt: null, latestPriceDate: "2026-09-06" });
  });

  it("takes the later of the automated series and the tenant's manual points, in both directions", async () => {
    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "XS0000424004",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "greatest() fixture",
    });
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: share.id,
      priceDate: "2026-09-03",
      closeRaw: new Decimal("500.00"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "DELAYED",
    });

    // Manual point behind the series: the series date wins.
    await ownerDb.insert(manualPricePoint).values({
      tenantId: tenantA,
      instrumentId: share.id,
      priceDate: "2026-08-20",
      close: new Decimal("490.00"),
      currency: "EUR",
    });
    expect(
      (await getInstrumentPriceFreshness(appWebDb, { tenantId: tenantA, instrumentId: share.id }))
        .latestPriceDate,
    ).toBe("2026-09-03");

    // Manual point ahead of it: the manual one wins. `greatest` is doing the
    // work in both directions, which is why both are asserted — a `coalesce`
    // preferring one table would pass the case above and fail this one.
    await ownerDb.insert(manualPricePoint).values({
      tenantId: tenantA,
      instrumentId: share.id,
      priceDate: "2026-09-05",
      close: new Decimal("505.00"),
      currency: "EUR",
    });
    expect(
      (await getInstrumentPriceFreshness(appWebDb, { tenantId: tenantA, instrumentId: share.id }))
        .latestPriceDate,
    ).toBe("2026-09-05");
  });

  it("reports a quote whose day is ahead of the series, which is a state the quote writer really produces", async () => {
    const share = await createInstrumentByIsin(appWebDb, {
      kind: "SHARE",
      isin: "XS0000424005",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "quote-ahead-of-series fixture",
    });
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: share.id,
      priceDate: "2026-09-04",
      closeRaw: new Decimal("170.36"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "DELAYED",
    });
    // `upsertPriceDailyFromQuotesViaDb` writes **today's row only** and drops
    // an observation about a day that has already settled, so a press over a
    // weekend leaves the quote newer than the newest series point. The two
    // fields say so independently rather than one being derived from the
    // other.
    await ownerDb.insert(instrumentQuoteLatest).values({
      instrumentId: share.id,
      price: new Decimal("170.36"),
      currency: "EUR",
      asOf: new Date("2026-09-06T16:29:00.000Z"),
      quality: "DELAYED",
      sourceKey: "yahoo",
    });

    expect(
      await getInstrumentPriceFreshness(appWebDb, { tenantId: tenantA, instrumentId: share.id }),
    ).toEqual({ lastQuoteAt: "2026-09-06T16:29:00Z", latestPriceDate: "2026-09-04" });
  });
});
