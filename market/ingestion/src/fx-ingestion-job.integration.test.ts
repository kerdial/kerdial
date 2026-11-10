import { fakeFxProvider as baseFxProvider } from "@kerdial/market-test-support";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyPair, FxObservation, FxRateProvider } from "@kerdial/market-ports";
import { createDb, fxRateDaily, type Db } from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeClock } from "@kerdial/platform-test-support";
import {
  FX_HISTORY_BACKFILL_FLOOR,
  FX_HISTORY_MAX_GAP_DAYS,
  ensureFxHistoryCoverage,
  runFxBackfill,
  runFxDailyIncremental,
  runFxDailyWithHistoryCoverage,
  upsertFxRateDailyViaDb,
  type FxCoverageBackfill,
} from "./fx-ingestion-job.js";
import { readMarketDataEpoch } from "./market-data-epoch.js";
import { plausibleFxRateBand } from "./fx-series-checks.js";

const PROVIDER_KEY = "t35-fx-ingestion-test-provider";

function pairKey(pair: CurrencyPair): string {
  return `${pair.base}/${pair.quote}`;
}

/** A minimal `FxRateProvider` port implementation — never a concrete adapter (this package's own doc comments' convention); the real ECB adapter is exercised separately in `ledger/src/__tests__/market-ingestion-composition.integration.test.ts`. */
function fakeFxProvider(series: ReadonlyMap<string, readonly FxObservation[]>): FxRateProvider {
  return baseFxProvider({
    capabilities: {
      key: PROVIDER_KEY,
      publishedPairs: [...series.keys()].map((key) => ({
        base: key.slice(0, 3),
        quote: key.slice(4),
      })),
    },
    fetchDailyRates: async (pairs, from, to) =>
      pairs.flatMap((pair) =>
        (series.get(pairKey(pair)) ?? []).filter((o) => o.rateDate >= from && o.rateDate <= to),
      ),
    fetchLatestRates: async (pairs) =>
      pairs.map((pair) => {
        const forPair = series.get(pairKey(pair)) ?? [];
        const last = forPair[forPair.length - 1];
        if (!last) throw new Error(`fakeFxProvider: no rates configured for ${pairKey(pair)}`);
        return last;
      }),
  });
}

describe("fx-ingestion-job — T-35 (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  /** The role the deployed worker actually connects as — used only by the grant case folded in from the SH-7 gate. */
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function ratesFor(base: string, quote: string) {
    return ownerDb
      .select()
      .from(fxRateDaily)
      .where(and(eq(fxRateDaily.baseCurrency, base), eq(fxRateDaily.quoteCurrency, quote)))
      .orderBy(fxRateDaily.rateDate);
  }

  it("upsertFxRateDailyViaDb: ON CONFLICT (base, quote, rate_date) DO UPDATE — re-running does not duplicate and revises the stored rate", async () => {
    await upsertFxRateDailyViaDb(ownerDb, [
      {
        base: "EUR",
        quote: "USD",
        rate: new Decimal("0.910000000000"),
        rateDate: "2024-02-01",
        sourceKey: PROVIDER_KEY,
      },
    ]);
    const before = await ratesFor("EUR", "USD");
    expect(before).toHaveLength(1);
    expect(before[0]!.rate.toFixed(12)).toBe("0.910000000000");

    await upsertFxRateDailyViaDb(ownerDb, [
      {
        base: "EUR",
        quote: "USD",
        rate: new Decimal("0.925000000000"),
        rateDate: "2024-02-01",
        sourceKey: PROVIDER_KEY,
      },
    ]);
    const after = await ratesFor("EUR", "USD");
    expect(after).toHaveLength(1); // no duplicate row
    expect(after[0]!.rate.toFixed(12)).toBe("0.925000000000"); // revised, matching fx_rate_daily's documented upsert convention
  });

  it("upsertFxRateDailyViaDb rejects a zero, negative, or NaN rate before any write — the last-good row stays untouched, and a subsequent positive-rate call still writes", async () => {
    // Seed the "last-good" row this batch-rejection must leave untouched.
    await upsertFxRateDailyViaDb(ownerDb, [
      {
        base: "EUR",
        quote: "CHF",
        rate: new Decimal("0.950000000000"),
        rateDate: "2024-05-01",
        sourceKey: PROVIDER_KEY,
      },
    ]);
    const lastGoodBefore = await ratesFor("EUR", "CHF");
    expect(lastGoodBefore).toHaveLength(1);

    // zero, negative, and NaN — each must independently be rejected.
    const badRates: readonly Decimal[] = [
      new Decimal("0.000000000000"),
      new Decimal("-0.500000000000"),
      new Decimal(NaN),
    ];

    for (const rate of badRates) {
      await expect(
        upsertFxRateDailyViaDb(ownerDb, [
          // A genuinely good observation in the SAME batch — proves the
          // whole batch is rejected, not just the bad row.
          {
            base: "EUR",
            quote: "CHF",
            rate: new Decimal("0.960000000000"),
            rateDate: "2024-05-02",
            sourceKey: PROVIDER_KEY,
          },
          { base: "EUR", quote: "CHF", rate, rateDate: "2024-05-03", sourceKey: PROVIDER_KEY },
        ]),
      ).rejects.toThrow(/refusing to persist a non-positive rate/);

      const rowsAfterRejection = await ratesFor("EUR", "CHF");
      expect(rowsAfterRejection).toHaveLength(1); // neither the bad row nor the good row in the same batch was written
      expect(rowsAfterRejection[0]!.rate.toFixed(12)).toBe(lastGoodBefore[0]!.rate.toFixed(12)); // last-good row: byte-identical
    }

    // Positive-rate control: an otherwise-identical call with only good
    // rates still writes normally — the guard rejects bad batches, not every
    // batch.
    await upsertFxRateDailyViaDb(ownerDb, [
      {
        base: "EUR",
        quote: "CHF",
        rate: new Decimal("0.955000000000"),
        rateDate: "2024-05-02",
        sourceKey: PROVIDER_KEY,
      },
    ]);
    const rowsAfterControl = await ratesFor("EUR", "CHF");
    expect(rowsAfterControl).toHaveLength(2);
    expect(rowsAfterControl.map((r) => r.rateDate)).toEqual(["2024-05-01", "2024-05-02"]);
  });

  it("runFxBackfill fetches the bulk historical range and upserts every observation", async () => {
    const series = new Map<string, FxObservation[]>([
      [
        "EUR/GBP",
        [
          {
            base: "EUR",
            quote: "GBP",
            rate: new Decimal("0.855000000000"),
            rateDate: "2024-03-01",
            sourceKey: PROVIDER_KEY,
          },
          {
            base: "EUR",
            quote: "GBP",
            rate: new Decimal("0.856000000000"),
            rateDate: "2024-03-04",
            sourceKey: PROVIDER_KEY,
          },
        ],
      ],
    ]);
    const provider = fakeFxProvider(series);

    const result = await runFxBackfill({
      db: ownerDb,
      provider,
      pairs: [{ base: "EUR", quote: "GBP" }],
      from: "2024-03-01",
      to: "2024-03-04",
    });

    expect(result.written).toBe(2);
    const rows = await ratesFor("EUR", "GBP");
    expect(rows.map((r) => r.rateDate)).toEqual(["2024-03-01", "2024-03-04"]);
  });

  it("the intercepted 2010-ending 0.5 stub over [1999-01-04, today]: an implausible pair rejects the whole batch; a plausible one is written and reported short", async () => {
    // The stub: every weekday 1999-01-04..2010-02-12 at 0.5, for every
    // currency. 0.5 EUR per ILS is within an order of magnitude of the
    // shekel's range (like USD); 0.5 EUR per INR is not (like JPY).
    const ils: CurrencyPair = { base: "EUR", quote: "ILS" };
    const inr: CurrencyPair = { base: "EUR", quote: "INR" };
    const stubDates: string[] = [];
    for (
      let t = Date.parse("1999-01-04T00:00:00Z");
      t <= Date.parse("2010-02-12T00:00:00Z");
      t += 86_400_000
    ) {
      const day = new Date(t).getUTCDay();
      if (day !== 0 && day !== 6) stubDates.push(new Date(t).toISOString().slice(0, 10));
    }
    const stubFor = (pair: CurrencyPair): FxObservation[] =>
      stubDates.map((rateDate) => ({
        ...pair,
        rate: new Decimal("0.500000000000"),
        rateDate,
        sourceKey: PROVIDER_KEY,
      }));
    const provider = fakeFxProvider(
      new Map([
        ["EUR/ILS", stubFor(ils)],
        ["EUR/INR", stubFor(inr)],
      ]),
    );
    const epochBefore = await readMarketDataEpoch(ownerDb);

    await expect(
      runFxBackfill({
        db: ownerDb,
        provider,
        pairs: [ils, inr],
        from: "1999-01-04",
        to: "2026-10-07",
      }),
    ).rejects.toThrow(/implausible rate \(0\.5\) for EUR\/INR/);
    expect(await ratesFor("EUR", "ILS")).toEqual([]);
    expect(await readMarketDataEpoch(ownerDb)).toBe(epochBefore);

    const result = await runFxBackfill({
      db: ownerDb,
      provider,
      pairs: [ils],
      from: "1999-01-04",
      to: "2026-10-07",
    });
    expect(result.written).toBe(stubDates.length);
    expect(result.shortfalls).toEqual([
      {
        pair: ils,
        kind: "TAIL",
        requestedFrom: "1999-01-04",
        requestedTo: "2026-10-07",
        observedFrom: "1999-01-04",
        observedTo: "2010-02-12",
        rows: stubDates.length,
      },
    ]);
  });

  it("runFxDailyIncremental fetches only the latest published rate per pair and upserts it", async () => {
    const series = new Map<string, FxObservation[]>([
      [
        "EUR/JPY",
        [
          {
            base: "EUR",
            quote: "JPY",
            rate: new Decimal("0.006100000000"),
            rateDate: "2024-04-01",
            sourceKey: PROVIDER_KEY,
          },
          {
            base: "EUR",
            quote: "JPY",
            rate: new Decimal("0.006200000000"),
            rateDate: "2024-04-02",
            sourceKey: PROVIDER_KEY,
          },
        ],
      ],
    ]);
    const provider = fakeFxProvider(series);

    const result = await runFxDailyIncremental({
      db: ownerDb,
      provider,
      pairs: [{ base: "EUR", quote: "JPY" }],
    });

    expect(result.written).toBe(1);
    const rows = await ratesFor("EUR", "JPY");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rateDate).toBe("2024-04-02"); // the latest, not the whole series
  });

  /**
   * SH-5 — the **cold-pair mitigation**: a pair with no
   * `fx_rate_daily` coverage gets its history loaded *before* the first
   * incremental write, in the same job.
   *
   * The ordering is proved by observation, not by "both rows exist
   * afterwards": the provider records what `fx_rate_daily` actually contained
   * at the instant `fetchLatestRates` was called. A run that wrote today's row
   * first would show an empty (or history-less) table at that instant, exactly
   * as the control case below does.
   *
   * This describe also absorbed the SH-7 release gate's ingestion half
   * (`fx-ingestion-job.sh7-gate.integration.test.ts`, deleted after the gate
   * passed): its STATE A/B/C cases were already asserted here, and its
   * additive ones — the inert catch-up, the sticky one-row series, and the
   * `app_ingest` grant — are marked where they landed.
   */
  describe("ensureFxHistoryCoverage / runFxDailyWithHistoryCoverage (SH-5, cold-pair mitigation)", () => {
    interface Recording {
      readonly calls: string[];
      /** `rate_date`s present for the pair at the moment `fetchLatestRates` was invoked. */
      readonly datesSeenByIncrementalFetch: string[];
      readonly backfillRanges: { from: string; to: string }[];
    }

    /** Wraps a provider so every call is recorded, and so the *incremental* call can read the live DB state at its own call time. */
    function observingProvider(
      inner: FxRateProvider,
      pair: CurrencyPair,
      recording: Recording,
    ): FxRateProvider {
      return {
        capabilities: () => inner.capabilities(),
        fetchDailyRates: async (pairs, from, to) => {
          recording.calls.push("fetchDailyRates");
          recording.backfillRanges.push({ from, to });
          return inner.fetchDailyRates(pairs, from, to);
        },
        fetchLatestRates: async (pairs) => {
          recording.calls.push("fetchLatestRates");
          const rows = await ratesFor(pair.base, pair.quote);
          recording.datesSeenByIncrementalFetch.push(...rows.map((row) => row.rateDate));
          return inner.fetchLatestRates(pairs);
        },
      };
    }

    function newRecording(): Recording {
      return { calls: [], datesSeenByIncrementalFetch: [], backfillRanges: [] };
    }

    /**
     * A rate at the middle of the plausibility band for `EUR/quote`, distinct
     * per row (+1 ppm each) so a re-upsert stays observable. These cases test
     * series shape, not values; a flat `0.5` is ~50× the highest EUR-per-KRW.
     */
    function fixtureRate(quote: string, index: number): Decimal {
      const [low, high] = plausibleFxRateBand({ base: "EUR", quote })!;
      return new Decimal((Math.sqrt(low * high) * (1 + index / 1_000_000)).toFixed(12));
    }

    /** A pair with a deep history and a "today" row, `today` being the fake clock's CET date. */
    function seriesFor(quote: string, dates: readonly string[]): Map<string, FxObservation[]> {
      return new Map<string, FxObservation[]>([
        [
          `EUR/${quote}`,
          dates.map((rateDate, index) => ({
            base: "EUR",
            quote,
            rate: fixtureRate(quote, index),
            rateDate,
            sourceKey: PROVIDER_KEY,
          })),
        ],
      ]);
    }

    // 2026-08-19T12:00:00Z is 14:00 CEST — the same CET calendar date, so the
    // catch-up's upper bound is unambiguous.
    const clock = new FakeClock(new Date("2026-08-19T12:00:00.000Z"));

    it("backfills an uncovered pair's history BEFORE the incremental fetch, in one job — the incremental call already sees the historical rows", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "SEK" };
      const recording = newRecording();
      const provider = observingProvider(
        fakeFxProvider(seriesFor("SEK", ["1999-01-04", "2010-06-01", "2026-08-19"])),
        pair,
        recording,
      );

      const result = await runFxDailyWithHistoryCoverage({
        db: ownerDb,
        provider,
        pairs: [pair],
        clock,
      });

      expect(recording.calls).toEqual(["fetchDailyRates", "fetchLatestRates"]);
      // The ordering property itself: the history was already committed when
      // the incremental half ran.
      expect(recording.datesSeenByIncrementalFetch).toEqual([
        "1999-01-04",
        "2010-06-01",
        "2026-08-19",
      ]);
      expect(result.coverage.backfilledPairs).toEqual([pair]);
      expect(result.coverage.written).toBe(3);
      expect((await ratesFor("EUR", "SEK")).map((row) => row.rateDate)).toEqual([
        "1999-01-04",
        "2010-06-01",
        "2026-08-19",
      ]);
    });

    it("the catch-up defaults to the euro reference-rate epoch and stops at the clock's CET date", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "NOK" };
      const recording = newRecording();
      const provider = observingProvider(
        fakeFxProvider(seriesFor("NOK", ["1999-01-04", "2026-08-19"])),
        pair,
        recording,
      );

      await runFxDailyWithHistoryCoverage({ db: ownerDb, provider, pairs: [pair], clock });

      expect(recording.backfillRanges).toEqual([
        { from: FX_HISTORY_BACKFILL_FLOOR, to: "2026-08-19" },
      ]);
      expect(FX_HISTORY_BACKFILL_FLOOR).toBe("1999-01-04");
    });

    it("a control run without the catch-up shows the failure mode this fixes: the incremental write lands on an empty history", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "PLN" };
      const recording = newRecording();
      const provider = observingProvider(
        fakeFxProvider(seriesFor("PLN", ["1999-01-04", "2010-06-01", "2026-08-19"])),
        pair,
        recording,
      );

      await runFxDailyIncremental({ db: ownerDb, provider, pairs: [pair] });

      expect(recording.calls).toEqual(["fetchLatestRates"]);
      expect(recording.datesSeenByIncrementalFetch).toEqual([]);
      // One row, 2026 — the exact one-row series B2 is about.
      expect((await ratesFor("EUR", "PLN")).map((row) => row.rateDate)).toEqual(["2026-08-19"]);
    });

    it("a pair that already has coverage is a no-op — no provider fetch, no write", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "HUF" };
      await upsertFxRateDailyViaDb(ownerDb, [
        {
          base: "EUR",
          quote: "HUF",
          rate: new Decimal("0.002500000000"),
          rateDate: "2026-08-10",
          sourceKey: PROVIDER_KEY,
        },
      ]);
      const recording = newRecording();
      const provider = observingProvider(
        fakeFxProvider(seriesFor("HUF", ["1999-01-04", "2026-08-19"])),
        pair,
        recording,
      );

      const coverage = await ensureFxHistoryCoverage({
        db: ownerDb,
        provider,
        pairs: [pair],
        to: "2026-08-19",
      });

      expect(coverage).toEqual({ backfilledPairs: [], backfills: [], written: 0, shortfalls: [] });
      expect(recording.calls).toEqual([]);
      expect((await ratesFor("EUR", "HUF")).map((row) => row.rateDate)).toEqual(["2026-08-10"]);
    });

    it("covers only the pairs that need it, leaving the already-covered ones untouched in the same call", async () => {
      const covered: CurrencyPair = { base: "EUR", quote: "DKK" };
      const uncovered: CurrencyPair = { base: "EUR", quote: "CZK" };
      await upsertFxRateDailyViaDb(ownerDb, [
        {
          base: "EUR",
          quote: "DKK",
          rate: new Decimal("0.134000000000"),
          rateDate: "2026-08-10",
          sourceKey: PROVIDER_KEY,
        },
      ]);
      const series = new Map<string, FxObservation[]>([
        ...seriesFor("DKK", ["1999-01-04", "2026-08-19"]),
        ...seriesFor("CZK", ["1999-01-04", "2026-08-19"]),
      ]);

      const coverage = await ensureFxHistoryCoverage({
        db: ownerDb,
        provider: fakeFxProvider(series),
        pairs: [covered, uncovered],
        to: "2026-08-19",
      });

      expect(coverage.backfilledPairs).toEqual([uncovered]);
      expect(coverage.backfills).toEqual([
        { pair: uncovered, kind: "EMPTY", from: FX_HISTORY_BACKFILL_FLOOR, to: "2026-08-19" },
      ]);
      expect((await ratesFor("EUR", "DKK")).map((row) => row.rateDate)).toEqual(["2026-08-10"]);
      expect((await ratesFor("EUR", "CZK")).map((row) => row.rateDate)).toEqual([
        "1999-01-04",
        "2026-08-19",
      ]);
    });

    it("a failed catch-up aborts the job before the incremental write — no one-row series is left behind", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "RON" };
      const inner = fakeFxProvider(seriesFor("RON", ["1999-01-04", "2026-08-19"]));
      const failingBackfill: FxRateProvider = {
        capabilities: () => inner.capabilities(),
        fetchDailyRates: async () => {
          throw new Error("provider is down");
        },
        fetchLatestRates: (pairs) => inner.fetchLatestRates(pairs),
      };
      const recording = newRecording();

      await expect(
        runFxDailyWithHistoryCoverage({
          db: ownerDb,
          provider: observingProvider(failingBackfill, pair, recording),
          pairs: [pair],
          clock,
        }),
      ).rejects.toThrow("provider is down");

      // Folded from the SH-7 release gate (deleted after the gate passed):
      // the specific consequence, not merely that something threw — the
      // incremental fetch was never reached at all.
      expect(recording.calls).toEqual(["fetchDailyRates"]);
      expect(await ratesFor("EUR", "RON")).toEqual([]);
    });

    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("a catch-up that returns nothing still leaves only the one-row series — a provider that cannot serve history changes nothing about the state the read path must handle", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "MXN" };
      const inner = fakeFxProvider(seriesFor("MXN", ["2026-08-19"]));
      // A stubbed-out catch-up: `fetchDailyRates` resolves with no rows at all
      // (the intercepted-HTTPS case degrades to exactly this shape when the
      // served file predates the requested window).
      const inertBackfill: FxRateProvider = {
        capabilities: () => inner.capabilities(),
        fetchDailyRates: async () => [],
        fetchLatestRates: (pairs) => inner.fetchLatestRates(pairs),
      };

      const result = await runFxDailyWithHistoryCoverage({
        db: ownerDb,
        provider: inertBackfill,
        pairs: [pair],
        clock,
      });

      expect(result.coverage).toEqual({
        backfilledPairs: [pair],
        backfills: [{ pair, kind: "EMPTY", from: FX_HISTORY_BACKFILL_FLOOR, to: "2026-08-19" }],
        written: 0,
        // The empty answer is reported, not swallowed.
        shortfalls: [
          {
            pair,
            kind: "TAIL",
            requestedFrom: FX_HISTORY_BACKFILL_FLOOR,
            requestedTo: "2026-08-19",
            rows: 0,
          },
        ],
      });
      expect(result.written).toBe(1);
      expect((await ratesFor("EUR", "MXN")).map((row) => row.rateDate)).toEqual(["2026-08-19"]);
    });

    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("the one-row series an SH-5-less deployment left behind is sticky: the catch-up counts it as covered and never deepens it, even alongside an uncovered pair", async () => {
      const sticky: CurrencyPair = { base: "EUR", quote: "TRY" };
      const uncovered: CurrencyPair = { base: "EUR", quote: "ZAR" };
      const dates = ["1999-01-04", "2010-06-01", "2026-08-19"];

      // The state a deployment that ran the incremental before SH-5 was wired
      // is actually in — produced here by that same job, not hand-seeded.
      await runFxDailyIncremental({
        db: ownerDb,
        provider: fakeFxProvider(seriesFor("TRY", dates)),
        pairs: [sticky],
      });
      expect((await ratesFor("EUR", "TRY")).map((row) => row.rateDate)).toEqual(["2026-08-19"]);

      // Still sticky now that interior holes are healed, deliberately: the missing stretch is the
      // *head* of the series, `[floor, first row)`, and a head is not a hole —
      // a currency ECB began publishing after the euro epoch has an unfillable
      // one, and treating it as a hole would re-fetch it on every run forever.
      // Interior and tail holes are what the coverage step heals; this state is precisely
      // why SH-6, not SH-5, is the guarantee.
      const stickyCoverage = await ensureFxHistoryCoverage({
        db: ownerDb,
        provider: fakeFxProvider(seriesFor("TRY", dates)),
        pairs: [sticky],
        to: "2026-08-19",
      });
      expect(stickyCoverage).toEqual({
        backfilledPairs: [],
        backfills: [],
        written: 0,
        shortfalls: [],
      });

      const batchCoverage = await ensureFxHistoryCoverage({
        db: ownerDb,
        provider: fakeFxProvider(
          new Map<string, FxObservation[]>([
            ...seriesFor("TRY", dates),
            ...seriesFor("ZAR", dates),
          ]),
        ),
        pairs: [sticky, uncovered],
        to: "2026-08-19",
      });
      expect(batchCoverage.backfilledPairs).toEqual([uncovered]);
      expect((await ratesFor("EUR", "TRY")).map((row) => row.rateDate)).toEqual(["2026-08-19"]);
      expect((await ratesFor("EUR", "ZAR")).map((row) => row.rateDate)).toEqual(dates);
    });

    describe("coverage reads the series' shape, not row presence", () => {
      /** Every Monday..Friday in `[from, to]`, inclusive — a contiguous business-day series with only weekend gaps. */
      function weekdays(from: string, to: string): string[] {
        const out: string[] = [];
        for (
          let t = Date.parse(`${from}T00:00:00Z`);
          t <= Date.parse(`${to}T00:00:00Z`);
          t += 86_400_000
        ) {
          const day = new Date(t);
          if (day.getUTCDay() >= 1 && day.getUTCDay() <= 5)
            out.push(day.toISOString().slice(0, 10));
        }
        return out;
      }

      async function seed(quote: string, dates: readonly string[]): Promise<void> {
        await upsertFxRateDailyViaDb(ownerDb, seriesFor(quote, dates).get(`EUR/${quote}`)!);
      }

      const currentEpoch = () => readMarketDataEpoch(ownerDb);

      it("AC4 — the live EUR/USD shape: [1999..2010 weekdays] + [today] is re-fetched over exactly the hole, not the whole history", async () => {
        const pair: CurrencyPair = { base: "EUR", quote: "BRL" };
        // The live series: weekdays to Fri 2010-02-12 plus the stray Sunday row
        // 2010-02-14 (the stray `0.5`), then nothing until today. Seeded
        // on a quote no other case in this file touches — the shape is EUR/USD's.
        const history = [...weekdays("1999-01-05", "2010-02-12"), "2010-02-14"];
        await seed("BRL", [...history, "2026-08-19"]);
        const holeDates = weekdays("2010-02-15", "2026-08-18");
        const recording = newRecording();
        const provider = observingProvider(
          fakeFxProvider(seriesFor("BRL", [...history, ...holeDates, "2026-08-19"])),
          pair,
          recording,
        );

        const coverage = await ensureFxHistoryCoverage({
          db: ownerDb,
          provider,
          pairs: [pair],
          to: "2026-08-19",
        });

        // The provider was asked for the gap range — `[last row + 1, next row - 1]`.
        expect(recording.backfillRanges).toEqual([{ from: "2010-02-15", to: "2026-08-18" }]);
        expect(coverage).toEqual({
          backfilledPairs: [pair],
          backfills: [{ pair, kind: "INTERIOR", from: "2010-02-15", to: "2026-08-18" }],
          written: holeDates.length,
          // The hole came back whole: nothing to report.
          shortfalls: [],
        });
        expect((await ratesFor("EUR", "BRL")).map((row) => row.rateDate)).toEqual([
          ...history,
          ...holeDates,
          "2026-08-19",
        ]);
      });

      it("AC3 — a contiguous business-day series spanning Easter and Christmas closures costs no provider call", async () => {
        const pair: CurrencyPair = { base: "EUR", quote: "KRW" };
        // 2024: Good Friday 03-29 and Easter Monday 04-01 → Thu 03-28 to Tue 04-02 is a 5-day gap;
        // Christmas: Tue 12-24 to Fri 12-27 (25th and 26th closed) — the real series' widest closures.
        const dates = weekdays("2024-03-01", "2026-08-19").filter(
          (d) =>
            !["2024-03-29", "2024-04-01", "2024-12-25", "2024-12-26", "2025-01-01"].includes(d),
        );
        await seed("KRW", dates);
        const recording = newRecording();
        const provider = observingProvider(
          fakeFxProvider(seriesFor("KRW", dates)),
          pair,
          recording,
        );

        const coverage = await ensureFxHistoryCoverage({
          db: ownerDb,
          provider,
          pairs: [pair],
          to: "2026-08-19",
        });

        expect(coverage).toEqual({
          backfilledPairs: [],
          backfills: [],
          written: 0,
          shortfalls: [],
        });
        expect(recording.calls).toEqual([]);
      });

      it("the tolerance is inclusive: consecutive rows 14 days apart are a closure, 15 are a hole", async () => {
        const closure: CurrencyPair = { base: "EUR", quote: "CNY" };
        const hole: CurrencyPair = { base: "EUR", quote: "HKD" };
        expect(FX_HISTORY_MAX_GAP_DAYS).toBe(14);
        await seed("CNY", ["2026-06-01", "2026-06-15", "2026-08-19"]);
        await seed("HKD", ["2026-06-01", "2026-06-16", "2026-08-19"]);
        // Both keep a second gap (06-15/16 → 08-19) — a real hole in both.
        const recording = newRecording();
        const provider = observingProvider(
          fakeFxProvider(
            new Map<string, FxObservation[]>([
              ...seriesFor("CNY", weekdays("2026-06-01", "2026-08-19")),
              ...seriesFor("HKD", weekdays("2026-06-01", "2026-08-19")),
            ]),
          ),
          hole,
          recording,
        );

        const coverage = await ensureFxHistoryCoverage({
          db: ownerDb,
          provider,
          pairs: [closure, hole],
          to: "2026-08-19",
        });

        const expected: FxCoverageBackfill[] = [
          { pair: closure, kind: "INTERIOR", from: "2026-06-16", to: "2026-08-18" },
          { pair: hole, kind: "INTERIOR", from: "2026-06-02", to: "2026-06-15" },
          { pair: hole, kind: "INTERIOR", from: "2026-06-17", to: "2026-08-18" },
        ];
        expect(coverage.backfills).toEqual(expected);
        expect(coverage.backfilledPairs).toEqual([closure, hole]);
        // Three distinct ranges → three provider calls; nothing shared.
        expect(recording.backfillRanges).toEqual([
          { from: "2026-06-16", to: "2026-08-18" },
          { from: "2026-06-02", to: "2026-06-15" },
          { from: "2026-06-17", to: "2026-08-18" },
        ]);
      });

      it("a series whose newest row is more than the tolerance behind `to` is a tail hole — the shape a fortnight of worker downtime leaves", async () => {
        const pair: CurrencyPair = { base: "EUR", quote: "AUD" };
        const before = weekdays("2026-06-01", "2026-07-01");
        await seed("AUD", before);
        const recording = newRecording();
        const provider = observingProvider(
          fakeFxProvider(seriesFor("AUD", weekdays("2026-06-01", "2026-08-19"))),
          pair,
          recording,
        );

        const coverage = await ensureFxHistoryCoverage({
          db: ownerDb,
          provider,
          pairs: [pair],
          to: "2026-08-19",
        });

        expect(coverage.backfills).toEqual([
          { pair, kind: "TAIL", from: "2026-07-02", to: "2026-08-19" },
        ]);
        expect(recording.backfillRanges).toEqual([{ from: "2026-07-02", to: "2026-08-19" }]);
        expect((await ratesFor("EUR", "AUD")).map((row) => row.rateDate)).toEqual(
          weekdays("2026-06-01", "2026-08-19"),
        );
      });

      it("a hole straddling the caller's `from` is fetched from `from`, and a hole entirely before it is not this run's concern", async () => {
        const pair: CurrencyPair = { base: "EUR", quote: "CAD" };
        // Hole A: 2005-01-03 → 2010-02-15 (before `from`). Hole B: 2019-06-03 → 2026-08-17 (straddles `from`).
        await seed("CAD", ["2005-01-03", "2010-02-15", "2019-06-03", "2026-08-17", "2026-08-19"]);
        const recording = newRecording();
        const provider = observingProvider(
          fakeFxProvider(seriesFor("CAD", weekdays("2020-01-01", "2026-08-19"))),
          pair,
          recording,
        );

        const coverage = await ensureFxHistoryCoverage({
          db: ownerDb,
          provider,
          pairs: [pair],
          from: "2020-01-01",
          to: "2026-08-19",
        });

        expect(coverage.backfills).toEqual([
          { pair, kind: "INTERIOR", from: "2020-01-01", to: "2026-08-16" },
        ]);
        expect(recording.backfillRanges).toEqual([{ from: "2020-01-01", to: "2026-08-16" }]);
      });

      it("pairs sharing a range still share one provider call: two empty pairs cost one fetch, and the epoch is bumped once per run", async () => {
        const a: CurrencyPair = { base: "EUR", quote: "NZD" };
        const b: CurrencyPair = { base: "EUR", quote: "SGD" };
        const recording = newRecording();
        const provider = observingProvider(
          fakeFxProvider(
            new Map<string, FxObservation[]>([
              ...seriesFor("NZD", ["1999-01-04", "2026-08-19"]),
              ...seriesFor("SGD", ["1999-01-04", "2026-08-19"]),
            ]),
          ),
          a,
          recording,
        );
        const epochBefore = await currentEpoch();

        const coverage = await ensureFxHistoryCoverage({
          db: ownerDb,
          provider,
          pairs: [a, b],
          to: "2026-08-19",
        });

        expect(recording.backfillRanges).toEqual([
          { from: FX_HISTORY_BACKFILL_FLOOR, to: "2026-08-19" },
        ]);
        expect(coverage.backfilledPairs).toEqual([a, b]);
        expect(coverage.written).toBe(4);
        expect(await currentEpoch()).toBe(epochBefore + 1n);
      });
    });

    // Folded from the SH-7 release gate (deleted after the gate passed) —
    // the one case that keeps its own connection: every other test here runs
    // as the Testcontainers superuser, which makes a missing GRANT on any
    // table this path touches structurally invisible.
    it("runs end to end as the real app_ingest role, which still holds no DELETE on fx_rate_daily", async () => {
      const pair: CurrencyPair = { base: "EUR", quote: "ISK" };

      // As this role the path touches: SELECT DISTINCT + INSERT on
      // `fx_rate_daily`, SELECT + UPDATE on `market_data_epoch`
      // (`bumpMarketDataEpoch`), and the `currency` foreign-key check.
      await expect(
        runFxDailyWithHistoryCoverage({
          db: appIngestDb,
          provider: fakeFxProvider(seriesFor("ISK", ["1999-01-04", "2026-08-19"])),
          pairs: [pair],
          clock,
        }),
      ).resolves.toMatchObject({ written: 1 });
      expect((await ratesFor("EUR", "ISK")).map((row) => row.rateDate)).toEqual([
        "1999-01-04",
        "2026-08-19",
      ]);

      await expect(
        appIngestDb
          .delete(fxRateDaily)
          .where(
            and(eq(fxRateDaily.baseCurrency, pair.base), eq(fxRateDaily.quoteCurrency, pair.quote)),
          ),
        // The specific SQLSTATE and message, not merely "it rejected": a bare
        // `.rejects.toThrow()` here would pass for a syntax error, a dropped
        // table, or a closed connection.
      ).rejects.toMatchObject({
        cause: { code: "42501", message: "permission denied for table fx_rate_daily" },
      });
    });
  });
});
