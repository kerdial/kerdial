import { and, eq, gte, or, sql } from "drizzle-orm";
import { fxRateDaily, type Db } from "@kerdial/platform-db";
import type { CurrencyPair, FxObservation, FxRateProvider } from "@kerdial/market-ports";
import type { Clock } from "./clock.js";
import { localDateTimeParts } from "./market-hours.js";
import { bumpMarketDataEpoch } from "./market-data-epoch.js";
import {
  assertPlausibleRate,
  findFxSeriesShortfalls,
  type FxSeriesShortfall,
} from "./fx-series-checks.js";

/**
 * ECB FX ingestion — T-35's third acceptance criterion. Two independent
 * halves:
 *
 *  - {@link runFxBackfill}: the bulk ECB history load (now the statistics
 *    API; `eurofxref-hist.csv` before)
 *    (T-15's adapter's `fetchDailyRates`), used both for an initial load and
 *    by the AC47 composite integration test (re-running a backfill over a
 *    range that includes an already-priced transaction's date).
 *  - {@link runFxDailyIncremental}: the daily `eurofxref-daily.xml` pull
 *    (`fetchLatestRates`), run once at 17:30 CET with a 19:00 CET retry — two
 *    `pg-boss` crons on the `fx-daily` queue (`fx-daily-queue.ts`), whose
 *    "has today already been ingested?" decision is read from `fx_rate_daily`
 *    itself ({@link fxDailyRatesAlreadyIngested}).
 *
 * Both write through the same {@link upsertFxRateDailyViaDb} —
 * `INSERT ... ON CONFLICT (base_currency, quote_currency, rate_date) DO
 * UPDATE`, matching `fx_rate_daily`'s own documented "providers revise
 * history, and that is expected" upsert convention (its schema comment).
 *
 * Neither function ever touches `transaction`, `transaction_posting`, or
 * `holding_state` — the reference series (`fx_rate_daily`) is deliberately
 * mutable and the transaction's own stored rate is not (AC47). This
 * is what the AC47 composite integration test
 * (`ledger/src/__tests__/market-ingestion-composition.integration.test.ts`) proves
 * end to end, using this module's real functions (not a stand-in).
 *
 * This module never names a concrete adapter: every function takes an
 * `FxRateProvider` **port**, exactly as `eod-close-job.ts` takes a
 * `QuoteProvider` port — the composition root
 * that wires the real ECB adapter in is the caller (a worker entrypoint, or
 * this package's own integration tests).
 */

/**
 * Defense-in-depth (security review) — mirrors
 * `eod-close-job.ts`'s identical `assertPositivePrice` guard: rejects a
 * non-positive (or NaN) rate before any DB write, regardless of which
 * provider produced it, so a defect in any current or future
 * `FxRateProvider` (a non-ECB provider, or a future ECB code path that
 * bypasses `parseEcbRawRate`) cannot fabricate a zero/negative/NaN value
 * into `fx_rate_daily`. `greaterThan(0)`, not a sign check, for the same
 * signed-zero reason `ecb`'s `parseEcbRawRate` documents — and a Decimal
 * `NaN`'s `greaterThan(0)` is itself `false` (per `@kerdial/core-decimal`'s
 * `Decimal.js` semantics: any comparison against `NaN` is `false`), so `NaN`
 * needs no separate check to be caught by this same guard — confirmed by
 * `fx-ingestion-job.test.ts`'s dedicated case.
 */
function assertPositiveRate(
  rate: { greaterThan(value: number): boolean; toString(): string },
  base: string,
  quote: string,
  rateDate: string,
): void {
  if (!rate.greaterThan(0)) {
    throw new Error(
      `upsertFxRateDailyViaDb: refusing to persist a non-positive rate (${rate.toString()}) for ${base}/${quote} on ${rateDate} — "never fabricate"`,
    );
  }
}

/**
 * Idempotent upsert into `fx_rate_daily` — `ON CONFLICT (base_currency,
 * quote_currency, rate_date) DO UPDATE`, mirroring `upsertPriceDailyViaDb`'s
 * (`eod-close-job.ts`) and `upsertQuoteLatestViaDb`'s (`quote-refresh-db.ts`)
 * identical convention. Re-running a backfill/incremental fetch for a
 * pair/date already populated revises the stored value rather than
 * duplicating or erroring — the "all writes idempotent" requirement, and AC11's dedicated "re-running... does not create duplicate
 * rows and does not error" acceptance criterion applied to the FX series.
 *
 * Every observation's rate is validated with {@link assertPositiveRate} and,
 * `assertPlausibleRate` (an order-of-magnitude band per pair)
 * *before* the `INSERT` is ever issued — a single non-positive/NaN rate
 * rejects the whole batch, so a batch containing one bad rate cannot
 * partially write the good ones (mirrors `upsertPriceDailyViaDb`'s identical
 * whole-batch-rejection stance).
 *
 * **Returns the number of rows written** (SH-2) — `0` for an
 * empty batch, mirroring `upsertPriceDailyViaDb`. The epoch bump belongs to
 * the *job run* that called this, not to this function: see
 * `market-data-epoch.ts`.
 */
export async function upsertFxRateDailyViaDb(
  db: Db,
  observations: readonly FxObservation[],
): Promise<number> {
  if (observations.length === 0) return 0;
  for (const observation of observations) {
    assertPositiveRate(observation.rate, observation.base, observation.quote, observation.rateDate);
    assertPlausibleRate(observation);
  }
  await db
    .insert(fxRateDaily)
    .values(
      observations.map((observation) => ({
        baseCurrency: observation.base,
        quoteCurrency: observation.quote,
        rateDate: observation.rateDate,
        rate: observation.rate,
        sourceKey: observation.sourceKey,
      })),
    )
    .onConflictDoUpdate({
      target: [fxRateDaily.baseCurrency, fxRateDaily.quoteCurrency, fxRateDaily.rateDate],
      set: {
        rate: sql`excluded.rate`,
        sourceKey: sql`excluded.source_key`,
      },
    });
  return observations.length;
}

export interface FxBackfillDeps {
  readonly db: Db;
  readonly provider: FxRateProvider;
  readonly pairs: readonly CurrencyPair[];
  readonly from: string;
  readonly to: string;
}

export interface FxIngestionResult {
  readonly written: number;
}

export interface FxBackfillResult extends FxIngestionResult {
  /** Pairs whose returned series is short of `[from, to]`; written anyway, reported for the caller to log. */
  readonly shortfalls: readonly FxSeriesShortfall[];
}

/**
 * The bulk historical load (originally "Backfill from the ECB
 * `eurofxref-hist.csv` bulk file" — the same history now comes from
 * the ECB statistics API, because that file path is intercepted on the
 * owner's network). Unlike the per-instrument equity/crypto
 * backfill (`instrument-backfill-job.ts`), this is not chunked by year or
 * resumed via `instrument_backfill_state` — the ECB source is fetched whole,
 * one request per load, and `fx_rate_daily` carries no
 * analogous per-currency-pair backfill-state row.
 */
export async function runFxBackfill(deps: FxBackfillDeps): Promise<FxBackfillResult> {
  const observations = await deps.provider.fetchDailyRates(
    deps.pairs as CurrencyPair[],
    deps.from,
    deps.to,
  );
  const written = await upsertFxRateDailyViaDb(deps.db, observations);
  // SH-2 — once per job run, and only once the rows are
  // committed (`upsertFxRateDailyViaDb` is a single statement: it either
  // committed all of them or wrote none, so no `finally` is needed here to
  // cover a partial write). See `market-data-epoch.ts`'s ordering rules.
  if (written > 0) await bumpMarketDataEpoch(deps.db);
  const shortfalls = findFxSeriesShortfalls(
    deps.pairs,
    observations,
    deps.from,
    deps.to,
    FX_HISTORY_MAX_GAP_DAYS,
  );
  return { written, shortfalls };
}

/**
 * SH-14 — **the DB-driven decision**. It replaced an
 * in-memory per-CET-day state machine (`FxDailyIngestionScheduler`, since
 * deleted — it had never been on this path and a
 * retry whose state dies with the process is not a retry):
 *
 * > `if fx_rate_daily already has a row with rate_date >= today_cet` →
 * > complete, no fetch.
 *
 * Reading it from the database rather than from process memory is what makes
 * the 19:00 slot a genuine retry across a container restart — the 17:30
 * attempt's outcome is recorded in the rows it wrote, not in a field that
 * dies with the process.
 *
 * **Every** requested pair must be covered, not merely one: a partially
 * ingested day should still be finished by the retry slot. (In practice
 * `upsertFxRateDailyViaDb` rejects or writes a batch whole, so the two
 * readings coincide — but "all" is the one that stays correct if that ever
 * changes.)
 *
 * Returns `false` for an empty pair list: there is nothing to consider
 * already-ingested, and the caller should decide separately whether a fetch
 * is worth making.
 */
export async function fxDailyRatesAlreadyIngested(
  db: Db,
  pairs: readonly CurrencyPair[],
  isoDate: string,
): Promise<boolean> {
  if (pairs.length === 0) return false;
  const covered = await db
    .selectDistinct({
      baseCurrency: fxRateDaily.baseCurrency,
      quoteCurrency: fxRateDaily.quoteCurrency,
    })
    .from(fxRateDaily)
    .where(
      and(
        gte(fxRateDaily.rateDate, isoDate),
        or(
          ...pairs.map((pair) =>
            and(eq(fxRateDaily.baseCurrency, pair.base), eq(fxRateDaily.quoteCurrency, pair.quote)),
          ),
        ),
      ),
    );
  const coveredKeys = new Set(covered.map((row) => `${row.baseCurrency}/${row.quoteCurrency}`));
  return pairs.every((pair) => coveredKeys.has(`${pair.base}/${pair.quote}`));
}

export interface FxDailyIncrementalDeps {
  readonly db: Db;
  readonly provider: FxRateProvider;
  readonly pairs: readonly CurrencyPair[];
}

/**
 * The incremental daily pull ("Incremental from
 * `eurofxref-daily.xml`... once daily at 17:30 CET"). One attempt — success
 * or failure is the caller's concern (the `fx-daily` handler's, and from
 * there pg-boss's retry/dead-letter policy), not this function's; it simply
 * lets a provider error propagate.
 */
export async function runFxDailyIncremental(
  deps: FxDailyIncrementalDeps,
): Promise<FxIngestionResult> {
  const observations = await deps.provider.fetchLatestRates(deps.pairs as CurrencyPair[]);
  const written = await upsertFxRateDailyViaDb(deps.db, observations);
  // SH-2 — same once-per-run, after-the-write bump as `runFxBackfill`.
  if (written > 0) await bumpMarketDataEpoch(deps.db);
  return { written };
}

/**
 * The euro reference-rate epoch — 1999-01-04, the first publication day of
 * the euro's daily reference rates, and therefore the earliest `rate_date`
 * any EUR-base provider can serve. A domain fact about the currency, not a
 * provider identity: this module still never names a concrete adapter.
 */
export const FX_HISTORY_BACKFILL_FLOOR = "1999-01-04";

/**
 * The width, in calendar days, above which a stretch of a pair's
 * series with no `rate_date` in it is a **hole** rather than a closure.
 *
 * 14, the same value as `valuation`'s `FX_PROVIDER_COVERAGE_HORIZON_DAYS` and
 * `ledger`'s `PROVIDER_LOOKBACK_DAYS` (kept equal by value; this package may
 * depend on neither): it is the staleness the read and write paths already
 * refuse to carry a rate across, so a stretch wider than it is one no other
 * path would accept anyway — and it is well clear of the real ECB series'
 * widest genuine closure, five calendar days (a holiday long weekend).
 *
 * A single missing business day inside a week is *not* detectable this way,
 * by design: without a TARGET calendar it is indistinguishable from a holiday,
 * and the read path's LOCF is exactly what such a day is meant to fall back
 * on.
 */
export const FX_HISTORY_MAX_GAP_DAYS = 14;

export interface FxHistoryCoverageDeps {
  readonly db: Db;
  readonly provider: FxRateProvider;
  readonly pairs: readonly CurrencyPair[];
  /** Inclusive upper bound of the catch-up fetch — the calling job's own "today". */
  readonly to: string;
  /** Inclusive lower bound; defaults to {@link FX_HISTORY_BACKFILL_FLOOR}. */
  readonly from?: string;
  /** Overrides {@link FX_HISTORY_MAX_GAP_DAYS} — tests only. */
  readonly maxGapDays?: number;
}

/** One range this run asked the provider for — the unit the result reports in. */
export interface FxCoverageBackfill {
  readonly pair: CurrencyPair;
  /**
   * Why the range was fetched. `EMPTY`: no row at all (the original SH-5
   * case). `INTERIOR`: two consecutive `rate_date`s more than
   * {@link FX_HISTORY_MAX_GAP_DAYS} apart. `TAIL`: the newest row is more than
   * that behind `to`.
   */
  readonly kind: "EMPTY" | "INTERIOR" | "TAIL";
  /** Inclusive, already clamped to the caller's `[from, to]`. */
  readonly from: string;
  readonly to: string;
}

export interface FxHistoryCoverageResult {
  /** Every pair that had at least one hole this run fetched — distinct, in `deps.pairs` order; empty when every pair was already covered. */
  readonly backfilledPairs: readonly CurrencyPair[];
  /** The holes themselves, in `deps.pairs` order then chronological — the audit trail of what was asked for and why. */
  readonly backfills: readonly FxCoverageBackfill[];
  readonly written: number;
  /** Every fetched range whose answer was short of what was asked, per pair. */
  readonly shortfalls: readonly FxSeriesShortfall[];
}

/**
 * SH-5 — **the cold-pair mitigation**: before a pair's first
 * incremental write lands, make sure its history exists — and that the
 * history it has is **contiguous**.
 *
 * The coverage decision reads each pair's actual series shape from
 * `fx_rate_daily` in **one query** (a window `lag()` over `rate_date`,
 * partitioned by pair, plus the newest date), never row presence:
 *
 *  - a pair with no row at all is fetched over `[from, to]` (the original
 *    SH-5 case);
 *  - every interior stretch of more than {@link FX_HISTORY_MAX_GAP_DAYS}
 *    calendar days between two consecutive `rate_date`s is fetched over
 *    exactly the missing dates, `[previous + 1, next - 1]`, not the whole
 *    history;
 *  - a series whose newest row is more than that behind `to` is fetched over
 *    `[newest + 1, to]` — the shape a worker that was down for a fortnight
 *    leaves, which `fetchLatestRates` (one published day) can never repair.
 *
 * A pair whose series is contiguous across `[first row, to]` still costs one
 * query and no provider call (the SH-5 cost property, kept). The head —
 * `[from, first row)` — is deliberately **not** a hole: a currency ECB began
 * publishing after the euro epoch has an unfillable head, and treating it as
 * a hole would re-fetch it on every run forever.
 *
 * Holes sharing the same `[from, to]` are fetched in one provider call (so N
 * new pairs still cost one call, as before); distinct ranges cost one call
 * each. The epoch is bumped once per run, after every range is committed
 * (SH-2, `market-data-epoch.ts`).
 *
 * Why this matters: the live EUR/USD series ran 1999-01-05..2010-02-14
 * and then resumed on 2026-08-28. The presence-only decision this replaces
 * saw 2801 rows and never attempted the 16-year hole, so every valuation in
 * it LOCF'd a 2010 rate (the read-side half of the same defect was fixed
 * separately).
 *
 * **Still a mitigation, not the correctness guarantee.** The guarantee is
 * SH-6's two-sided, horizon-bounded coverage test in
 * `valuation/src/pricing-series.ts`, which holds whether or not this function
 * runs, succeeds, or is wired up at all. What this buys is that the ordinary
 * case ends with a *deep, contiguous* series rather than a shallow or holed
 * one, so valuations keep using provider rates instead of degrading to
 * whatever the tenant happened to pin.
 */
export async function ensureFxHistoryCoverage(
  deps: FxHistoryCoverageDeps,
): Promise<FxHistoryCoverageResult> {
  if (deps.pairs.length === 0) {
    return { backfilledPairs: [], backfills: [], written: 0, shortfalls: [] };
  }

  const from = deps.from ?? FX_HISTORY_BACKFILL_FLOOR;
  const maxGapDays = deps.maxGapDays ?? FX_HISTORY_MAX_GAP_DAYS;
  const holes = await findFxCoverageHoles(deps.db, deps.pairs, from, deps.to, maxGapDays);
  if (holes.length === 0) return { backfilledPairs: [], backfills: [], written: 0, shortfalls: [] };

  // One provider call per distinct range, in first-appearance order — so N
  // empty pairs still share the single `[from, to]` call they always did.
  const byRange = new Map<string, { from: string; to: string; pairs: CurrencyPair[] }>();
  for (const hole of holes) {
    const key = `${hole.from}..${hole.to}`;
    const group = byRange.get(key);
    if (group) group.pairs.push(hole.pair);
    else byRange.set(key, { from: hole.from, to: hole.to, pairs: [hole.pair] });
  }

  let written = 0;
  const shortfalls: FxSeriesShortfall[] = [];
  for (const group of byRange.values()) {
    const observations = await deps.provider.fetchDailyRates(group.pairs, group.from, group.to);
    written += await upsertFxRateDailyViaDb(deps.db, observations);
    shortfalls.push(
      ...findFxSeriesShortfalls(group.pairs, observations, group.from, group.to, maxGapDays),
    );
  }
  // SH-2 — once per run, after the last range is committed.
  if (written > 0) await bumpMarketDataEpoch(deps.db);

  const seen = new Set<string>();
  const backfilledPairs = holes
    .map((hole) => hole.pair)
    .filter((pair) => {
      const key = `${pair.base}/${pair.quote}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { backfilledPairs, backfills: holes, written, shortfalls };
}

/**
 * The one query behind {@link ensureFxHistoryCoverage}. Returns every hole
 * wider than `maxGapDays` for the given pairs, clamped to `[from, to]`, in
 * `pairs` order then chronological. A pair absent from `fx_rate_daily`
 * produces a single `EMPTY` hole over `[from, to]`.
 */
async function findFxCoverageHoles(
  db: Db,
  pairs: readonly CurrencyPair[],
  from: string,
  to: string,
  maxGapDays: number,
): Promise<FxCoverageBackfill[]> {
  const pairTuples = sql.join(
    pairs.map((pair) => sql`(${pair.base}, ${pair.quote})`),
    sql`, `,
  );
  // Dates cross the driver as ISO text in both directions (`::date` in,
  // `::text` out) for the reason `instrument-backfill-job.ts` records: this
  // function's contract is an `IsoDate` string, not a driver-parsed `Date`.
  // `interior` needs `series` twice, hence the CTE; `newest` is one row per
  // present pair, which is also how absence (`EMPTY`) is detected.
  const rows = (await db.execute(sql`
    with series as (
      select base_currency, quote_currency, rate_date,
             lag(rate_date) over (partition by base_currency, quote_currency order by rate_date) as prev_date
        from fx_rate_daily
       where (base_currency, quote_currency) in (${pairTuples})
    )
    select base_currency as base, quote_currency as quote, 'INTERIOR' as kind,
           (prev_date + 1)::text as hole_from, (rate_date - 1)::text as hole_to
      from series
     where prev_date is not null and rate_date - prev_date > ${maxGapDays}::int
    union all
    select base_currency, quote_currency, 'NEWEST',
           (max(rate_date) + 1)::text, (${to}::date - max(rate_date))::text
      from series
     group by base_currency, quote_currency
  `)) as unknown as readonly {
    base: string;
    quote: string;
    kind: "INTERIOR" | "NEWEST";
    hole_from: string;
    hole_to: string;
  }[];

  const holes: FxCoverageBackfill[] = [];
  for (const pair of pairs) {
    const own = rows.filter((row) => row.base === pair.base && row.quote === pair.quote);
    const newest = own.find((row) => row.kind === "NEWEST");
    if (newest === undefined) {
      holes.push({ pair, kind: "EMPTY", from, to });
      continue;
    }
    const interior = own
      .filter((row) => row.kind === "INTERIOR")
      .map((row): FxCoverageBackfill => ({
        pair,
        kind: "INTERIOR",
        from: row.hole_from,
        to: row.hole_to,
      }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    // For the `NEWEST` row, `hole_to` carries `to - max(rate_date)` in days.
    const daysBehind = Number(newest.hole_to);
    const tail: FxCoverageBackfill[] =
      daysBehind > maxGapDays ? [{ pair, kind: "TAIL", from: newest.hole_from, to }] : [];
    for (const hole of [...interior, ...tail]) {
      // Clamp to the caller's window: a hole straddling `from` is fetched from
      // `from`; one entirely outside `[from, to]` is not this run's concern.
      const clampedFrom = hole.from < from ? from : hole.from;
      const clampedTo = hole.to > to ? to : hole.to;
      if (clampedFrom <= clampedTo) holes.push({ ...hole, from: clampedFrom, to: clampedTo });
    }
  }
  return holes;
}

export interface FxDailyWithHistoryCoverageDeps extends FxDailyIncrementalDeps {
  /** Supplies the catch-up's upper bound — "today" in the same CET zone the ECB publication cadence uses. */
  readonly clock: Clock;
  /** Overrides {@link FX_HISTORY_BACKFILL_FLOOR} — tests, and any deployment that deliberately wants a shallower history. */
  readonly historyFrom?: string;
}

/**
 * The incremental pull with SH-5's catch-up **in the same job, ahead of the
 * write**. The two steps are
 * fused into one function rather than left to the caller to sequence, because
 * "backfill first" is the whole property: a caller that ran them in the other
 * order (or ran only the incremental) would reintroduce exactly the one-row
 * series this ordering exists to prevent.
 *
 * A pair whose history is already contiguous costs one coverage query and
 * nothing else. A backfill failure propagates and the incremental write does **not**
 * happen: writing today's single row on top of a history that failed to load
 * is precisely the state this ordering exists to avoid.
 */
export async function runFxDailyWithHistoryCoverage(
  deps: FxDailyWithHistoryCoverageDeps,
): Promise<FxIngestionResult & { readonly coverage: FxHistoryCoverageResult }> {
  const { isoDate } = localDateTimeParts(deps.clock.now(), FX_DAILY_TIME_ZONE);
  const coverage = await ensureFxHistoryCoverage({
    db: deps.db,
    provider: deps.provider,
    pairs: deps.pairs,
    ...(deps.historyFrom === undefined ? {} : { from: deps.historyFrom }),
    to: isoDate,
  });
  const { written } = await runFxDailyIncremental({
    db: deps.db,
    provider: deps.provider,
    pairs: deps.pairs,
  });
  return { written, coverage };
}

/** The `Europe/Paris` IANA zone — CET/CEST, the same DST rules ECB's own publication clock follows (`market-hours.ts`'s `XPAR` entry uses the identical zone for the same reason). */
export const FX_DAILY_TIME_ZONE = "Europe/Paris";

/** 17:30 local time, in minutes since midnight. */
export const FX_FIRST_ATTEMPT_MINUTES_SINCE_MIDNIGHT = 17 * 60 + 30;
