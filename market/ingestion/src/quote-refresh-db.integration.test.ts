import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  createDb,
  instrument,
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  type Db,
} from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  routeToProviderSymbolsViaDb,
  upsertPriceDailyFromQuotesViaDb,
  upsertQuoteLatestViaDb,
} from "./quote-refresh-db.js";

const EQUITY_PROVIDER_KEY = "quote-refresh-db-equity-provider";
const CRYPTO_PROVIDER_KEY = "quote-refresh-db-crypto-provider";

/**
 * The two live `Db`-backed halves of quote refresh — the routing read
 * `market/composition`'s `quote-refresh-handler.ts` and `eod-close-job.ts`
 * both call, and the `instrument_quote_latest` upsert the handler writes
 * through. Proved against a real Postgres 17 container, through the real
 * `app_ingest` role that runs these jobs in production.
 *
 * These cases were carried over from `quote-refresh-job.integration.test.ts`
 * when the T-34 cycle engine that used to live alongside them was deleted:
 * the two security-review hardenings
 * (non-positive price rejection, no `as_of` regression) were always about
 * `upsertQuoteLatestViaDb` itself, not about the cycle that drove it. The
 * routing cases are new, replacing the coverage the deleted engine's own
 * fan-out test gave `routeToProviderSymbolsViaDb` indirectly.
 */
describe("routeToProviderSymbolsViaDb / upsertQuoteLatestViaDb (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const equityId = "00000000-0000-7000-8000-0000007f0101";
  const otherEquityId = "00000000-0000-7000-8000-0000007f0102";
  const cryptoId = "00000000-0000-7000-8000-0000007f0103";
  /** Deliberately has no `instrument_provider_map` row for any provider. */
  const unmappedId = "00000000-0000-7000-8000-0000007f0104";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(instrument).values([
      {
        id: equityId,
        kind: "SHARE",
        displayName: "Equity",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR00007F0101",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: otherEquityId,
        kind: "SHARE",
        displayName: "Other equity",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR00007F0102",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: cryptoId,
        kind: "CRYPTO",
        displayName: "Crypto",
        listingCurrency: "EUR",
        symbol: "COIN7F",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
      {
        id: unmappedId,
        kind: "SHARE",
        displayName: "Unmapped equity",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR00007F0104",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
    ]);

    await ownerDb.insert(instrumentProviderMap).values([
      {
        instrumentId: equityId,
        providerKey: EQUITY_PROVIDER_KEY,
        providerSymbol: "SYM-EQ-0101",
        confidence: "CONFIRMED",
      },
      {
        instrumentId: otherEquityId,
        providerKey: EQUITY_PROVIDER_KEY,
        providerSymbol: "SYM-EQ-0102",
        confidence: "CONFIRMED",
      },
      {
        instrumentId: cryptoId,
        providerKey: CRYPTO_PROVIDER_KEY,
        providerSymbol: "SYM-CR-0103",
        confidence: "CONFIRMED",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function quoteLatestRow(instrumentId: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentQuoteLatest)
      .where(eq(instrumentQuoteLatest.instrumentId, instrumentId));
    return row;
  }

  it("resolves each requested instrument to the provider_symbol mapped for THAT provider_key, and omits an instrument with no mapping", async () => {
    const routed = await routeToProviderSymbolsViaDb(
      appIngestDb,
      [equityId, otherEquityId, unmappedId],
      EQUITY_PROVIDER_KEY,
    );

    expect(routed.get(equityId)).toBe("SYM-EQ-0101");
    expect(routed.get(otherEquityId)).toBe("SYM-EQ-0102");
    // Not a mis-route and not an error: an unmapped instrument is simply absent,
    // which is what lets a caller report it as skipped rather than fetch it
    // under some other provider's symbol.
    expect(routed.has(unmappedId)).toBe(false);
    expect(routed.size).toBe(2);
  });

  it("never crosses provider_key boundaries: another provider's mapping for the same instrument is not returned", async () => {
    const equityLane = await routeToProviderSymbolsViaDb(
      appIngestDb,
      [equityId, cryptoId],
      EQUITY_PROVIDER_KEY,
    );
    expect([...equityLane.keys()]).toEqual([equityId]);

    // Discriminating control: the crypto instrument IS routable — under its own
    // provider_key. The absence above is scoping, not a missing row.
    const cryptoLane = await routeToProviderSymbolsViaDb(
      appIngestDb,
      [equityId, cryptoId],
      CRYPTO_PROVIDER_KEY,
    );
    expect([...cryptoLane.keys()]).toEqual([cryptoId]);
    expect(cryptoLane.get(cryptoId)).toBe("SYM-CR-0103");
  });

  it("returns an empty map for an empty instrument list, issuing no query at all", async () => {
    const routed = await routeToProviderSymbolsViaDb(appIngestDb, [], EQUITY_PROVIDER_KEY);
    expect(routed.size).toBe(0);
  });

  it("upsertQuoteLatestViaDb writes a row and then revises it in place on a second call — one row per instrument, never a duplicate", async () => {
    const firstAsOf = new Date("2024-01-05T12:00:00.000Z");
    await upsertQuoteLatestViaDb(appIngestDb, firstAsOf, [
      {
        instrumentId: cryptoId,
        observation: {
          price: new Decimal("42.500000000000000000"),
          currency: "EUR",
          asOf: firstAsOf.toISOString(),
          quality: "REALTIME",
          sourceKey: CRYPTO_PROVIDER_KEY,
        },
      },
    ]);

    const inserted = await quoteLatestRow(cryptoId);
    expect(inserted?.price.toFixed(18)).toBe("42.500000000000000000");
    expect(inserted?.asOf.toISOString()).toBe(firstAsOf.toISOString());
    expect(inserted?.fetchedAt.toISOString()).toBe(firstAsOf.toISOString());
    expect(inserted?.quality).toBe("REALTIME");
    expect(inserted?.sourceKey).toBe(CRYPTO_PROVIDER_KEY);

    const secondAsOf = new Date("2024-01-05T13:00:00.000Z");
    await upsertQuoteLatestViaDb(appIngestDb, secondAsOf, [
      {
        instrumentId: cryptoId,
        observation: {
          price: new Decimal("43.000000000000000000"),
          currency: "EUR",
          asOf: secondAsOf.toISOString(),
          quality: "REALTIME",
          sourceKey: CRYPTO_PROVIDER_KEY,
        },
      },
    ]);

    const allRows = await ownerDb
      .select()
      .from(instrumentQuoteLatest)
      .where(eq(instrumentQuoteLatest.instrumentId, cryptoId));
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.price.toFixed(18)).toBe("43.000000000000000000");
  });

  it("upsertQuoteLatestViaDb is a no-op on an empty entry list — a zero-length INSERT ... VALUES would be invalid SQL", async () => {
    const before = await quoteLatestRow(cryptoId);
    await expect(
      upsertQuoteLatestViaDb(appIngestDb, new Date("2024-01-06T00:00:00.000Z"), []),
    ).resolves.toBeUndefined();
    const after = await quoteLatestRow(cryptoId);
    expect(after?.asOf.toISOString()).toBe(before?.asOf.toISOString());
  });

  it("upsertQuoteLatestViaDb rejects a non-positive price before any write — the last-good row is left unchanged (security review hardening)", async () => {
    const goodAsOf = new Date("2024-03-01T00:00:00.000Z");
    await upsertQuoteLatestViaDb(appIngestDb, goodAsOf, [
      {
        instrumentId: equityId,
        observation: {
          price: new Decimal("10.000000000000000000"),
          currency: "EUR",
          asOf: goodAsOf.toISOString(),
          quality: "DELAYED",
          sourceKey: EQUITY_PROVIDER_KEY,
        },
      },
    ]);
    const seeded = await quoteLatestRow(equityId);
    expect(seeded?.price.toFixed(18)).toBe("10.000000000000000000");

    await expect(
      upsertQuoteLatestViaDb(appIngestDb, new Date("2024-03-02T00:00:00.000Z"), [
        {
          instrumentId: equityId,
          observation: {
            price: new Decimal("0"),
            currency: "EUR",
            asOf: "2024-03-02T00:00:00.000Z",
            quality: "DELAYED",
            sourceKey: EQUITY_PROVIDER_KEY,
          },
        },
      ]),
    ).rejects.toThrow(/non-positive/);

    const afterZero = await quoteLatestRow(equityId);
    expect(afterZero?.price.toFixed(18)).toBe("10.000000000000000000"); // unchanged
    expect(afterZero?.asOf.toISOString()).toBe(goodAsOf.toISOString());

    await expect(
      upsertQuoteLatestViaDb(appIngestDb, new Date("2024-03-02T00:00:00.000Z"), [
        {
          instrumentId: equityId,
          observation: {
            price: new Decimal("-5"),
            currency: "EUR",
            asOf: "2024-03-02T00:00:00.000Z",
            quality: "DELAYED",
            sourceKey: EQUITY_PROVIDER_KEY,
          },
        },
      ]),
    ).rejects.toThrow(/non-positive/);

    const afterNegative = await quoteLatestRow(equityId);
    expect(afterNegative?.price.toFixed(18)).toBe("10.000000000000000000"); // still unchanged

    // Discriminating control: an otherwise-identical call with a POSITIVE
    // price DOES update — proving the rejections above are specifically
    // about non-positivity, not a general "this row never updates" bug.
    await upsertQuoteLatestViaDb(appIngestDb, new Date("2024-03-03T00:00:00.000Z"), [
      {
        instrumentId: equityId,
        observation: {
          price: new Decimal("11.000000000000000000"),
          currency: "EUR",
          asOf: "2024-03-03T00:00:00.000Z",
          quality: "DELAYED",
          sourceKey: EQUITY_PROVIDER_KEY,
        },
      },
    ]);
    const afterGood = await quoteLatestRow(equityId);
    expect(afterGood?.price.toFixed(18)).toBe("11.000000000000000000");
  });

  it("a single non-positive price rejects the WHOLE batch — the good entries beside it are not partially written", async () => {
    const before = await quoteLatestRow(otherEquityId);
    expect(before).toBeUndefined();

    await expect(
      upsertQuoteLatestViaDb(appIngestDb, new Date("2024-03-04T00:00:00.000Z"), [
        {
          instrumentId: otherEquityId,
          observation: {
            price: new Decimal("99.000000000000000000"),
            currency: "EUR",
            asOf: "2024-03-04T00:00:00.000Z",
            quality: "DELAYED",
            sourceKey: EQUITY_PROVIDER_KEY,
          },
        },
        {
          instrumentId: unmappedId,
          observation: {
            price: new Decimal("0"),
            currency: "EUR",
            asOf: "2024-03-04T00:00:00.000Z",
            quality: "DELAYED",
            sourceKey: EQUITY_PROVIDER_KEY,
          },
        },
      ]),
    ).rejects.toThrow(/non-positive/);

    expect(await quoteLatestRow(otherEquityId)).toBeUndefined();
    expect(await quoteLatestRow(unmappedId)).toBeUndefined();
  });

  it("upsertQuoteLatestViaDb's ON CONFLICT clause never regresses as_of on an out-of-order older observation, but a genuinely newer one still updates (security review INFO hardening)", async () => {
    const newerAsOf = new Date("2024-04-10T12:00:00.000Z");
    await upsertQuoteLatestViaDb(appIngestDb, newerAsOf, [
      {
        instrumentId: equityId,
        observation: {
          price: new Decimal("20.000000000000000000"),
          currency: "EUR",
          asOf: newerAsOf.toISOString(),
          quality: "DELAYED",
          sourceKey: EQUITY_PROVIDER_KEY,
        },
      },
    ]);

    // An older, out-of-order observation arrives afterwards (e.g. a delayed
    // retry resolving after a fresher fetch already landed) — must not
    // regress as_of (or the price) backwards.
    const olderAsOf = new Date("2024-04-10T11:00:00.000Z");
    await upsertQuoteLatestViaDb(appIngestDb, new Date("2024-04-10T12:05:00.000Z"), [
      {
        instrumentId: equityId,
        observation: {
          price: new Decimal("19.000000000000000000"),
          currency: "EUR",
          asOf: olderAsOf.toISOString(),
          quality: "DELAYED",
          sourceKey: EQUITY_PROVIDER_KEY,
        },
      },
    ]);

    const afterOlder = await quoteLatestRow(equityId);
    expect(afterOlder?.asOf.toISOString()).toBe(newerAsOf.toISOString());
    expect(afterOlder?.price.toFixed(18)).toBe("20.000000000000000000");

    // Discriminating control: a genuinely NEWER observation still updates
    // normally — proving the guard is "no regression", not "never updates".
    const evenNewerAsOf = new Date("2024-04-10T13:00:00.000Z");
    await upsertQuoteLatestViaDb(appIngestDb, new Date("2024-04-10T13:00:01.000Z"), [
      {
        instrumentId: equityId,
        observation: {
          price: new Decimal("21.000000000000000000"),
          currency: "EUR",
          asOf: evenNewerAsOf.toISOString(),
          quality: "DELAYED",
          sourceKey: EQUITY_PROVIDER_KEY,
        },
      },
    ]);
    const afterNewer = await quoteLatestRow(equityId);
    expect(afterNewer?.asOf.toISOString()).toBe(evenNewerAsOf.toISOString());
    expect(afterNewer?.price.toFixed(18)).toBe("21.000000000000000000");
  });
});

/**
 * The refresh-button write — the one that reaches a screen. Everything above proves
 * the `instrument_quote_latest` half, which `staleness.ts` reads and no
 * valuation read path does; this block proves the `instrument_price_daily`
 * half, which `loadPricingSeries` reads and therefore every valued holding
 * depends on. Same container, same real `app_ingest` role.
 */
describe("upsertPriceDailyFromQuotesViaDb (Testcontainers, real app_ingest)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const equityId = "00000000-0000-7000-8000-0000007f0201";
  const otherEquityId = "00000000-0000-7000-8000-0000007f0202";
  const PROVIDER_KEY = "quote-refresh-daily-provider";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(instrument).values([
      {
        id: equityId,
        kind: "SHARE",
        displayName: "Daily-write equity",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR00007F0201",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: otherEquityId,
        kind: "SHARE",
        displayName: "Daily-write equity 2",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR00007F0202",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function dailyRow(instrumentId: string, priceDate: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, instrumentId),
          eq(instrumentPriceDaily.priceDate, priceDate),
        ),
      );
    return row;
  }

  /** The job clock, on the same day as `asOf` — the quote write only ever persists the current day. */
  function clockOn(asOf: string): Date {
    return new Date(`${asOf.slice(0, 10)}T18:00:00.000Z`);
  }

  function quote(
    instrumentId: string,
    price: string,
    asOf: string,
    quality: "REALTIME" | "DELAYED" | "EOD" = "DELAYED",
  ) {
    return {
      instrumentId,
      observation: {
        price: new Decimal(price),
        currency: "EUR",
        asOf,
        quality,
        sourceKey: PROVIDER_KEY,
      },
    } as const;
  }

  it("writes the quote into instrument_price_daily under the observation's own UTC date, carrying its quality — the row loadPricingSeries reads", async () => {
    const written = await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-06"), [
      quote(equityId, "101.250000000000000000", "2024-05-06T15:35:00.000Z"),
    ]);

    expect(written).toBe(1);
    const row = await dailyRow(equityId, "2024-05-06");
    expect(row?.closeRaw.toFixed(18)).toBe("101.250000000000000000");
    expect(row?.currency).toBe("EUR");
    expect(row?.sourceKey).toBe(PROVIDER_KEY);
    // Not "EOD": this is an intraday quote, and `buildPriceFlags` turns the
    // DELAYED quality into the DELAYED_QUOTE provenance flag the UI renders.
    expect(row?.quality).toBe("DELAYED");
  });

  it("a later quote for the same day revises that day's row in place — one row per (instrument, date), never a second", async () => {
    await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-06"), [
      quote(equityId, "102.000000000000000000", "2024-05-06T16:05:00.000Z"),
    ]);

    const rows = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, equityId),
          eq(instrumentPriceDaily.priceDate, "2024-05-06"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closeRaw.toFixed(18)).toBe("102.000000000000000000");
  });

  it("an EOD row is never overwritten by a quote, and the call reports zero rows written — so the caller does not bump the epoch for a write that did not happen", async () => {
    // The official close, as `runEodCloseJob` would have written it.
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: equityId,
      priceDate: "2024-05-07",
      closeRaw: new Decimal("110.000000000000000000"),
      currency: "EUR",
      sourceKey: "eod-provider",
      quality: "EOD",
    });

    const written = await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-07"), [
      quote(equityId, "108.000000000000000000", "2024-05-07T15:35:00.000Z"),
    ]);

    expect(written).toBe(0);
    const row = await dailyRow(equityId, "2024-05-07");
    expect(row?.closeRaw.toFixed(18)).toBe("110.000000000000000000");
    expect(row?.quality).toBe("EOD");
    expect(row?.sourceKey).toBe("eod-provider");

    // Discriminating control: the identical call against a DELAYED row for a
    // different day DOES overwrite — proving the refusal above is specifically
    // about the stored EOD quality, not a general "this row never updates".
    await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-08"), [
      quote(equityId, "90.000000000000000000", "2024-05-08T15:35:00.000Z"),
    ]);
    const overwritten = await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-08"), [
      quote(equityId, "91.000000000000000000", "2024-05-08T16:35:00.000Z"),
    ]);
    expect(overwritten).toBe(1);
    expect((await dailyRow(equityId, "2024-05-08"))?.closeRaw.toFixed(18)).toBe(
      "91.000000000000000000",
    );
  });

  it("writes the observation's own day, and only when that day is today — it invents no row for a day the provider said nothing about", async () => {
    await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-09"), [
      quote(otherEquityId, "55.000000000000000000", "2024-05-09T15:35:00.000Z"),
    ]);

    const dates = await ownerDb
      .select({ priceDate: instrumentPriceDaily.priceDate })
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, otherEquityId));
    expect(dates.map((d) => d.priceDate)).toEqual(["2024-05-09"]);
  });

  it("drops a quote about a day that has already ended — a settled day belongs to the daily-history writer, and a pre-open press must not revise it", async () => {
    // What the daily-history path (`runEodCloseJob`, backfill, gap-repair)
    // stored for that day.
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: otherEquityId,
      priceDate: "2024-05-13",
      closeRaw: new Decimal("70.000000000000000000"),
      currency: "EUR",
      sourceKey: "daily-history",
      quality: "DELAYED",
    });

    // 08:00 the next morning: the market has not opened, so the provider's
    // "latest" quote is still the previous session's last trade.
    const written = await upsertPriceDailyFromQuotesViaDb(
      appIngestDb,
      new Date("2024-05-14T06:00:00.000Z"),
      [quote(otherEquityId, "71.000000000000000000", "2024-05-13T15:35:00.000Z")],
    );

    expect(written).toBe(0);
    const settled = await dailyRow(otherEquityId, "2024-05-13");
    expect(settled?.closeRaw.toFixed(18)).toBe("70.000000000000000000");
    expect(settled?.sourceKey).toBe("daily-history");
    // And no row was invented for the day the press happened on.
    expect(await dailyRow(otherEquityId, "2024-05-14")).toBeUndefined();

    // Discriminating control: once the same instrument is quoted for the
    // current day, the write lands.
    const landed = await upsertPriceDailyFromQuotesViaDb(
      appIngestDb,
      new Date("2024-05-14T13:00:00.000Z"),
      [quote(otherEquityId, "72.000000000000000000", "2024-05-14T12:59:00.000Z")],
    );
    expect(landed).toBe(1);
    expect((await dailyRow(otherEquityId, "2024-05-14"))?.closeRaw.toFixed(18)).toBe(
      "72.000000000000000000",
    );
  });

  it("rejects a non-positive price before any write — and one bad entry rejects the whole batch beside it", async () => {
    await expect(
      upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-10"), [
        quote(otherEquityId, "60.000000000000000000", "2024-05-10T15:35:00.000Z"),
        quote(otherEquityId, "0", "2024-05-10T16:35:00.000Z"),
      ]),
    ).rejects.toThrow(/non-positive/);

    // Neither the bad entry nor the good one beside it landed.
    expect(await dailyRow(otherEquityId, "2024-05-10")).toBeUndefined();

    // Discriminating control: the same batch minus the bad entry writes.
    const written = await upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-10"), [
      quote(otherEquityId, "60.000000000000000000", "2024-05-10T15:35:00.000Z"),
    ]);
    expect(written).toBe(1);
  });

  it("is a no-op on an empty entry list — a zero-length INSERT ... VALUES would be invalid SQL", async () => {
    await expect(
      upsertPriceDailyFromQuotesViaDb(appIngestDb, clockOn("2024-05-12"), []),
    ).resolves.toBe(0);
  });
});
