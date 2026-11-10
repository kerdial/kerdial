import { and, eq, gt, gte, lte, max, sql } from "drizzle-orm";
import {
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentPriceGap,
  marketCalendar,
  type Db,
} from "@kerdial/platform-db";
import {
  DataGap,
  SymbolNotFound,
  type InstrumentId,
  type IsoDate,
  type ProviderSymbol,
  type QuoteProvider,
} from "@kerdial/market-ports";
import type { Clock } from "./clock.js";
import { nextIsoDate, upsertPriceDailyViaDb } from "./eod-close-job.js";
import { bumpMarketDataEpoch } from "./market-data-epoch.js";
import type { IngestionScheduler } from "./scheduler.js";

/**
 * The weekly gap-repair job: "a weekly job scans for
 * missing business days inside an instrument's covered range and enqueues
 * targeted refetches. Gaps are also visible — the API reports coverage..."
 * (T-35's second acceptance criterion).
 *
 * **"Business day" here means an ordinary Monday–Friday weekday** — the same
 * default `market-hours.ts` documents ("a date's absence... means 'ordinary
 * weekday session' by convention"). A real holiday therefore surfaces as a
 * "missing" business day that the provider also has no data for
 * (`stillMissingDates` below). The UI-facing coverage read
 * (`instrument-backfill-job.ts`'s `getInstrumentCoverage`) reports it as "a
 * day with no data", which is true whether the cause is a genuine gap or a
 * market holiday.
 *
 * **What the scan does not re-ask.** Left alone, that simplification
 * cost the whole hourly Yahoo budget for 73 minutes every Sunday: 82
 * `COMPLETE` instruments × ~50 holidays each = ~4.4k `DataGap`s re-fetched
 * weekly with no memory of the answer (`provider_fetch_log`, 2026-08-30).
 * Two exclusions now sit between "missing" and "fetch":
 *
 *  1. **`market_calendar`** — a missing day the instrument's own exchange
 *     (`instrument.exchange_mic` = `calendar_key`) is recorded closed on is a
 *     holiday, not a gap, and is never fetched. The calendar only carries
 *     closures from 2024 on, so this alone would not have been enough.
 *  2. **`instrument_price_gap`** — every missing day the provider answered
 *     `DataGap`/`SymbolNotFound` for (or returned nothing for) is recorded
 *     there with a `last_confirmed_at`, and skipped by every later run until
 *     that confirmation is older than {@link GAP_RECONFIRM_AFTER_DAYS}. A
 *     provider that later publishes a day it once denied therefore gets
 *     re-asked once a year, not never; a transient empty answer cannot poison
 *     a date for good.
 *
 * Both exclusions are still reported in `stillMissingDates` (they *are*
 * missing) and separately in `skippedClosedDates` / `skippedKnownEmptyDates`
 * so the handler's log line says why nothing was fetched.
 */

/** A provider-confirmed empty day is asked about again once its confirmation is this many days old. One year: wide enough that the weekly sweep never re-asks the same holiday twice in a season, narrow enough that a genuinely late-published day is not lost for good. */
export const GAP_RECONFIRM_AFTER_DAYS = 365;

const WEEKEND_DAYS: readonly number[] = [0, 6]; // Sunday, Saturday (UTC)

/**
 * Every Mon–Fri calendar date in `[from, to]` (inclusive) not present in
 * `existingDates` — pure, no DB, no clock. `existingDates` need not be
 * sorted.
 */
export function findMissingBusinessDays(
  existingDates: readonly IsoDate[],
  from: IsoDate,
  to: IsoDate,
): IsoDate[] {
  const existing = new Set(existingDates);
  const missing: IsoDate[] = [];
  for (
    let cursor = new Date(`${from}T00:00:00.000Z`);
    cursor <= new Date(`${to}T00:00:00.000Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    if (WEEKEND_DAYS.includes(cursor.getUTCDay())) continue;
    const isoDate = cursor.toISOString().slice(0, 10);
    if (!existing.has(isoDate)) missing.push(isoDate);
  }
  return missing;
}

/**
 * Groups a (not necessarily sorted) list of dates into maximal runs of
 * calendar-adjacent dates — so a targeted refetch issues one
 * `fetchDailyHistory` call per contiguous run of missing business days
 * rather than one call per missing date. A weekend between two missing
 * business days (e.g. a missing Friday and the following missing Monday)
 * breaks the run, since the two dates are not calendar-adjacent — a minor,
 * accepted inefficiency (an extra call) rather than fetching the weekend
 * dates too.
 */
export function groupContiguousRanges(
  dates: readonly IsoDate[],
): Array<{ from: IsoDate; to: IsoDate }> {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const ranges: Array<{ from: IsoDate; to: IsoDate }> = [];
  let rangeStart = sorted[0]!;
  let rangeEnd = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const date = sorted[i]!;
    if (nextIsoDate(rangeEnd) === date) {
      rangeEnd = date;
    } else {
      ranges.push({ from: rangeStart, to: rangeEnd });
      rangeStart = date;
      rangeEnd = date;
    }
  }
  ranges.push({ from: rangeStart, to: rangeEnd });
  return ranges;
}

/** The `price_date`s `instrument_price_daily` already carries for `instrumentId` within `[from, to]`. */
export async function listPriceDatesInRange(
  db: Db,
  instrumentId: InstrumentId,
  from: IsoDate,
  to: IsoDate,
): Promise<IsoDate[]> {
  const rows = await db
    .select({ priceDate: instrumentPriceDaily.priceDate })
    .from(instrumentPriceDaily)
    .where(
      and(
        eq(instrumentPriceDaily.instrumentId, instrumentId),
        gte(instrumentPriceDaily.priceDate, from),
        lte(instrumentPriceDaily.priceDate, to),
      ),
    );
  return rows.map((row) => row.priceDate);
}

/** `max(price_date)` for `instrumentId`, or `null` when it has no row at all. */
async function maxPriceDate(db: Db, instrumentId: InstrumentId): Promise<IsoDate | null> {
  const [row] = await db
    .select({ newest: max(instrumentPriceDaily.priceDate) })
    .from(instrumentPriceDaily)
    .where(eq(instrumentPriceDaily.instrumentId, instrumentId));
  return row?.newest ?? null;
}

/** Every instrument with a `COMPLETE` (at least once fully) backfill — the weekly scan's candidate set, mirroring the fan-out discipline `holding-fanout.ts` uses elsewhere: only instruments actually worth re-checking are considered. */
async function scanInstrumentsForGapRepair(db: Db): Promise<InstrumentId[]> {
  const rows = await db
    .selectDistinct({ instrumentId: instrumentBackfillState.instrumentId })
    .from(instrumentBackfillState)
    .where(eq(instrumentBackfillState.status, "COMPLETE"));
  return rows.map((row) => row.instrumentId);
}

/** Enqueues a `history-gap-repair` job for every `COMPLETE`-backfilled instrument — the "weekly job" trigger itself (like `eod-close-job.ts`'s cadence) is a `pg-boss` scheduling decision out of this module's scope; this is the enqueue-side mechanism that scheduling decision calls. */
export async function enqueueWeeklyGapRepair(
  db: Db,
  scheduler: IngestionScheduler,
): Promise<string[]> {
  const instrumentIds = await scanInstrumentsForGapRepair(db);
  const jobIds: string[] = [];
  for (const instrumentId of instrumentIds) {
    const jobId = await scheduler.enqueueGapRepair({ instrumentId });
    if (jobId !== null) jobIds.push(jobId);
  }
  return jobIds;
}

export interface GapRepairJobDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly provider: QuoteProvider;
  readonly instrumentId: InstrumentId;
  readonly symbol: ProviderSymbol;
  /** The instrument's declared listing currency, forwarded as the port's `quoteCurrency` hint. */
  readonly quoteCurrency?: string;
}

export interface GapRepairJobResult {
  readonly scannedFrom: IsoDate | null;
  /** `max(latest_backfilled_date, max(price_date))` — the newest row, so a tail hole above the backfill bookmark is in scope. */
  readonly scannedTo: IsoDate | null;
  readonly missingBeforeRepair: readonly IsoDate[];
  readonly filledDates: readonly IsoDate[];
  /** Every missing business day this run did not fill — fetched-and-empty, known-empty, or calendar-closed alike; typically a market holiday, per this module's header comment. */
  readonly stillMissingDates: readonly IsoDate[];
  /** Missing days `market_calendar` records the instrument's exchange closed on; never fetched. */
  readonly skippedClosedDates: readonly IsoDate[];
  /** Missing days `instrument_price_gap` already holds a fresh provider confirmation for; not fetched this run. */
  readonly skippedKnownEmptyDates: readonly IsoDate[];
  /** The days this run asked the provider for and got nothing back, now recorded (or re-confirmed) in `instrument_price_gap`. */
  readonly recordedEmptyDates: readonly IsoDate[];
}

const EMPTY_RESULT: GapRepairJobResult = {
  scannedFrom: null,
  scannedTo: null,
  missingBeforeRepair: [],
  filledDates: [],
  stillMissingDates: [],
  skippedClosedDates: [],
  skippedKnownEmptyDates: [],
  recordedEmptyDates: [],
};

/**
 * The weekly gap-repair job body: re-scans `instrument_price_daily` fresh
 * against `instrument_backfill_state`'s recorded covered range (mirrors
 * `eod-close-job.ts`/`instrument-backfill-job.ts`'s "resolve fresh state,
 * don't trust a stale payload" convention — the queue payload carries only
 * `instrumentId`, no precomputed gap list), finds missing business days, and
 * issues one targeted `fetchDailyHistory` call per contiguous run of
 * missing dates.
 *
 * **Idempotency.** Every write goes through `upsertPriceDailyViaDb`'s
 * `INSERT ... ON CONFLICT (instrument_id, price_date) DO UPDATE` — re-running
 * this job (the next week, or a `pg-boss` retry) is always safe.
 *
 * A per-range `DataGap`/`SymbolNotFound` is not a job failure (mirrors
 * `instrument-backfill-job.ts`'s identical stance): it means the provider has
 * nothing for that range either, surfaced in `stillMissingDates` rather than
 * thrown. Any other provider error propagates and fails the whole job run
 * (a `pg-boss` retry will re-scan from scratch next attempt, which is safe
 * since the scan itself is idempotent).
 *
 * Returns an empty-range result (no scan performed) when the instrument has
 * no recorded backfilled range yet (`earliestBackfilledDate`/
 * `latestBackfilledDate` both `null`) — nothing to repair before the initial
 * backfill has written anything.
 */
export async function runGapRepairJob(deps: GapRepairJobDeps): Promise<GapRepairJobResult> {
  const [state] = await deps.db
    .select()
    .from(instrumentBackfillState)
    .where(eq(instrumentBackfillState.instrumentId, deps.instrumentId));

  if (!state || !state.earliestBackfilledDate || !state.latestBackfilledDate) {
    return EMPTY_RESULT;
  }

  const from = state.earliestBackfilledDate;
  // The upper bound is the newest row the instrument actually has,
  // not `latest_backfilled_date`: only `history-backfill` advances that
  // bookmark, while `eod-close` and `quote-refresh` keep writing past it for
  // as long as the instrument is held. A tail hole between the two (NVDA's
  // 2026-08-26..09-04) was invisible to this sweep because it lay
  // entirely above the old bound.
  const newest = await maxPriceDate(deps.db, deps.instrumentId);
  const to =
    newest !== null && newest > state.latestBackfilledDate ? newest : state.latestBackfilledDate;
  const existing = await listPriceDatesInRange(deps.db, deps.instrumentId, from, to);
  const missing = findMissingBusinessDays(existing, from, to);
  if (missing.length === 0) {
    return { ...EMPTY_RESULT, scannedFrom: from, scannedTo: to };
  }

  // The two exclusions, read only when there is something to exclude.
  const now = deps.clock.now();
  const closed = new Set(await listClosedDatesInRange(deps.db, deps.instrumentId, from, to));
  const knownEmpty = new Set(
    await listFreshKnownEmptyDates(deps.db, deps.instrumentId, from, to, now),
  );
  const skippedClosedDates = missing.filter((date) => closed.has(date));
  const skippedKnownEmptyDates = missing.filter(
    (date) => !closed.has(date) && knownEmpty.has(date),
  );
  const toFetch = missing.filter((date) => !closed.has(date) && !knownEmpty.has(date));

  const filledDates: IsoDate[] = [];
  /** SH-2 — this run's own "did any row actually land" counter; see the `finally` below. */
  let rowsWritten = 0;

  try {
    for (const range of groupContiguousRanges(toFetch)) {
      try {
        const observations = await deps.provider.fetchDailyHistory(
          deps.symbol,
          range.from,
          range.to,
          deps.quoteCurrency,
        );
        if (observations.length > 0) {
          rowsWritten += await upsertPriceDailyViaDb(deps.db, deps.instrumentId, observations);
          for (const observation of observations) filledDates.push(observation.priceDate);
        }
      } catch (err) {
        if (!(err instanceof DataGap || err instanceof SymbolNotFound)) throw err;
        // The provider genuinely has nothing for this range either — falls
        // through to `stillMissingDates` / `recordedEmptyDates` below.
      }
    }
  } finally {
    // SH-2 — once per job run, after the writes, and in a `finally` so a real
    // provider error on a *later* range still invalidates the rows earlier
    // ranges already committed. Gap repair is the case that most
    // needs the bump: it writes *past* dates, which is precisely the shape
    // `recomputeAndInvalidate`'s `valuation_date >= minTradeDate` delete can
    // never reach. See `market-data-epoch.ts`'s ordering rules.
    if (rowsWritten > 0) await bumpMarketDataEpoch(deps.db);
  }

  const filledSet = new Set(filledDates);
  // Only what this run actually asked about and got nothing for is
  // recorded: a skipped day keeps its earlier confirmation, a filled day is
  // no longer a gap. Recorded after the loop, so a real provider error on a
  // later range (which propagates above) records nothing for this run.
  const recordedEmptyDates = toFetch.filter((date) => !filledSet.has(date));
  await recordKnownEmptyDates(
    deps.db,
    deps.instrumentId,
    deps.provider.capabilities().key,
    recordedEmptyDates,
    now,
  );

  const stillMissingDates = missing.filter((date) => !filledSet.has(date)).sort();

  return {
    scannedFrom: from,
    scannedTo: to,
    missingBeforeRepair: missing,
    filledDates,
    stillMissingDates,
    skippedClosedDates,
    skippedKnownEmptyDates,
    recordedEmptyDates,
  };
}

/** The `market_calendar` closures for the instrument's own exchange within `[from, to]`; empty for an instrument with no `exchange_mic` (crypto) or an exchange the calendar does not carry. Also `ensureInstrumentBackfillRequested`'s tail-hole test. */
export async function listClosedDatesInRange(
  db: Db,
  instrumentId: InstrumentId,
  from: IsoDate,
  to: IsoDate,
): Promise<IsoDate[]> {
  const rows = await db
    .select({ sessionDate: marketCalendar.sessionDate })
    .from(marketCalendar)
    .innerJoin(instrument, eq(instrument.exchangeMic, marketCalendar.calendarKey))
    .where(
      and(
        eq(instrument.id, instrumentId),
        eq(marketCalendar.isOpen, false),
        gte(marketCalendar.sessionDate, from),
        lte(marketCalendar.sessionDate, to),
      ),
    );
  return rows.map((row) => row.sessionDate);
}

/** The `instrument_price_gap` dates within `[from, to]` whose provider confirmation is younger than {@link GAP_RECONFIRM_AFTER_DAYS} as of `now`. */
async function listFreshKnownEmptyDates(
  db: Db,
  instrumentId: InstrumentId,
  from: IsoDate,
  to: IsoDate,
  now: Date,
): Promise<IsoDate[]> {
  const cutoff = new Date(now.getTime() - GAP_RECONFIRM_AFTER_DAYS * 86_400_000);
  const rows = await db
    .select({ priceDate: instrumentPriceGap.priceDate })
    .from(instrumentPriceGap)
    .where(
      and(
        eq(instrumentPriceGap.instrumentId, instrumentId),
        gte(instrumentPriceGap.priceDate, from),
        lte(instrumentPriceGap.priceDate, to),
        gt(instrumentPriceGap.lastConfirmedAt, cutoff),
      ),
    );
  return rows.map((row) => row.priceDate);
}

/** `INSERT ... ON CONFLICT (instrument_id, price_date) DO UPDATE SET last_confirmed_at`: a first sighting and a re-confirmation are the same write. No-op for an empty list. */
async function recordKnownEmptyDates(
  db: Db,
  instrumentId: InstrumentId,
  providerKey: string,
  dates: readonly IsoDate[],
  now: Date,
): Promise<void> {
  if (dates.length === 0) return;
  await db
    .insert(instrumentPriceGap)
    .values(
      dates.map((priceDate) => ({
        instrumentId,
        priceDate,
        providerKey,
        firstSeenAt: now,
        lastConfirmedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [instrumentPriceGap.instrumentId, instrumentPriceGap.priceDate],
      set: {
        providerKey: sql`excluded.provider_key`,
        lastConfirmedAt: sql`excluded.last_confirmed_at`,
      },
    });
}
