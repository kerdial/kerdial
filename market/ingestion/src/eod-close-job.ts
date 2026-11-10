import { desc, eq, sql } from "drizzle-orm";
import { instrumentPriceDaily, type Db } from "@kerdial/platform-db";
import type {
  InstrumentId,
  IsoDate,
  PriceObservation,
  ProviderKey,
  ProviderSymbol,
  QuoteProvider,
  QuoteQuality,
} from "@kerdial/market-ports";
import type { Clock } from "./clock.js";
import { routeToProviderSymbolsViaDb } from "./quote-refresh-db.js";
import { EQUITY_LIKE_KINDS } from "./holding-fanout.js";
import { fetchRefreshPopulation } from "./watchlist-fanout.js";
import { bumpMarketDataEpoch } from "./market-data-epoch.js";

/**
 * The T-34 EOD close job *body* — the cadence:
 * "EOD price close | once daily, 60 min after each exchange's close | Per
 * exchange | Fills `instrument_price_daily`," and the incremental rule:
 * "the daily EOD job appends only dates after `max(price_date)` per
 * instrument." T-34's fifth acceptance criterion.
 *
 * **When this runs** (the "60 minutes after close" cadence itself) is a
 * `pg-boss` scheduling decision (T-33's mechanism — a per-exchange cron-style
 * trigger converting each `ExchangeSession.closeLocal` + 60 minutes into a
 * UTC schedule), not this module's concern; this module is the job *body*
 * `boss.work()` calls once triggered — its own testable behaviour is
 * exactly AC5: incremental, idempotent per-instrument history fill.
 * Historical backfill on instrument creation is explicitly out of scope
 * (T-35) — an instrument with no prior `instrument_price_daily` row simply
 * gets today's close as its first row, not 10 years of history.
 */

export interface EodCloseJobDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly provider: QuoteProvider;
  readonly providerKey: ProviderKey;
  /** The exchange this run fills — matches `instrument.exchange_mic`, e.g. `"XPAR"`. */
  readonly exchangeMic: string;
}

export interface EodCloseResult {
  readonly attemptedInstrumentIds: readonly InstrumentId[];
  /** Instruments for which at least one new `instrument_price_daily` row was written or revised this run. */
  readonly updatedInstrumentIds: readonly InstrumentId[];
  readonly failedInstrumentIds: readonly InstrumentId[];
  readonly skippedNoMapping: readonly InstrumentId[];
  /** Instrument already has a row for `toDate` (today) or later — nothing to append. */
  readonly skippedUpToDate: readonly InstrumentId[];
}

/** `isoDate + 1 calendar day`, in plain UTC-date arithmetic — no `Decimal` or float involved, this is calendar bookkeeping, not a money/quantity value. Exported for reuse by `instrument-backfill-job.ts`/`gap-repair-job.ts` (T-35), which need the identical "next calendar day" step. */
export function nextIsoDate(isoDate: IsoDate): IsoDate {
  const next = new Date(`${isoDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** `isoDate − 1 calendar day`, the mirror of {@link nextIsoDate} — SH-17's catch-up walks backwards day by day looking for the most recent completed session day. Same plain UTC-date arithmetic, no `Decimal` or float involved. */
export function previousIsoDate(isoDate: IsoDate): IsoDate {
  const previous = new Date(`${isoDate}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/**
 * `0` (Sunday) .. `6` (Saturday) for a plain `YYYY-MM-DD` — the weekday
 * {@link isSessionDay} takes, for a date that is *not* "now" and therefore has
 * no `localDateTimeParts` of its own. A calendar date's weekday is
 * zone-independent, so reading it in UTC is correct rather than convenient.
 */
export function weekdayOfIsoDate(isoDate: IsoDate): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

/**
 * The newest `instrument_price_daily` row this instrument has — its date and
 * its `quality` — or `null` if it has none yet.
 *
 * **Why the `quality` half exists.** The quote-refresh handler now writes the current day's row from a latest quote
 * (`DELAYED`/`REALTIME`), so `MAX(price_date) = today` no longer implies
 * "today's close has landed" — it usually means the opposite. Reading the
 * quality in the same statement is what lets {@link runEodCloseJob} tell the
 * two apart without a second round trip.
 *
 * **In practice this means every run re-fetches its `toDate`, and that is the
 * intended outcome, not an oversight.** No adapter stamps `EOD`: `yahoo`'s
 * `fetchDailyHistory` marks every bar `DELAYED`, or `REALTIME` for a crypto
 * pair (CoinGecko, the crypto source before it, also stamped `REALTIME`)
 * (337k such rows and zero `EOD` ones in the live deployment, measured
 * 2026-09-03), so the skip below is currently unreachable and the current day
 * is always re-fetched — which is what makes the day's figure converge on the
 * provider's own daily bar instead of freezing at whichever quote landed
 * first. The clause is written on quality rather than on date because that is
 * the rule that stays correct when a close-quality writer does exist; its
 * unreachable branch is still exercised by this file's integration suite.
 */
async function latestPriceRowFor(
  db: Db,
  instrumentId: InstrumentId,
): Promise<{ priceDate: IsoDate; quality: QuoteQuality } | null> {
  const [row] = await db
    .select({ priceDate: instrumentPriceDaily.priceDate, quality: instrumentPriceDaily.quality })
    .from(instrumentPriceDaily)
    .where(eq(instrumentPriceDaily.instrumentId, instrumentId))
    .orderBy(desc(instrumentPriceDaily.priceDate))
    .limit(1);
  return row ?? null;
}

/**
 * Defense-in-depth (security review) — mirrors
 * `quote-refresh-db.ts`'s identical guard: rejects a non-positive close
 * price before any DB write, regardless of which adapter produced it, so a
 * defect in any current or future `QuoteProvider` cannot fabricate a
 * zero/negative value into `instrument_price_daily`. See
 * `quote-refresh-db.ts`'s `assertPositivePrice` doc comment for the full
 * rationale (`greaterThan(0)`, not a sign check, for the signed-zero reason
 * `ecb`'s `parseEcbRawRate` documents).
 */
function assertPositivePrice(
  price: { greaterThan(value: number): boolean; toString(): string },
  instrumentId: string,
  priceDate: IsoDate,
  context: string,
): void {
  if (!price.greaterThan(0)) {
    throw new Error(
      `${context}: refusing to persist a non-positive close price (${price.toString()}) for instrument ${instrumentId} on ${priceDate} — "never fabricate"`,
    );
  }
}

/**
 * `INSERT ... ON CONFLICT (instrument_id, price_date) DO UPDATE` — AC5's
 * literal idempotency requirement. Re-running for a date range already
 * populated revises the stored value (mirroring `fx_rate_daily`'s own
 * documented "providers revise history, and that is expected" upsert
 * convention) rather than erroring or duplicating.
 *
 * Every observation's close price is validated with
 * {@link assertPositivePrice} *before* the `INSERT` is ever issued — a
 * single non-positive observation rejects the whole call, so a batch
 * containing one bad price cannot partially write the good ones.
 *
 * **Returns the number of rows written** (SH-2) — `0` for an
 * empty batch. Every caller is a market-data job run that must bump
 * `market_data_epoch` exactly once *if it wrote anything at all*, and this
 * return value is how a caller knows. Deliberately **not** bumped here: this
 * function is called once per instrument, so bumping inside it would cost one
 * full cache invalidation per instrument rather than one per job run. See
 * `market-data-epoch.ts`.
 */
export async function upsertPriceDailyViaDb(
  db: Db,
  instrumentId: InstrumentId,
  observations: readonly PriceObservation[],
): Promise<number> {
  if (observations.length === 0) return 0;
  for (const observation of observations) {
    assertPositivePrice(
      observation.close,
      instrumentId,
      observation.priceDate,
      "upsertPriceDailyViaDb",
    );
  }
  await db
    .insert(instrumentPriceDaily)
    .values(
      observations.map((observation) => ({
        instrumentId,
        priceDate: observation.priceDate,
        closeRaw: observation.close,
        currency: observation.currency,
        sourceKey: observation.sourceKey,
        quality: observation.quality,
      })),
    )
    .onConflictDoUpdate({
      target: [instrumentPriceDaily.instrumentId, instrumentPriceDaily.priceDate],
      set: {
        closeRaw: sql`excluded.close_raw`,
        currency: sql`excluded.currency`,
        sourceKey: sql`excluded.source_key`,
        quality: sql`excluded.quality`,
      },
    });
  return observations.length;
}

export async function runEodCloseJob(deps: EodCloseJobDeps): Promise<EodCloseResult> {
  // `fetchRefreshPopulation`, not `fetchHeldInstruments`: `held ∪ watched` as
  // of the `watchlist` cycle (FR-343). The `kinds` narrowing is passed to both halves of the
  // union by that one function, so a watched FUND is excluded here exactly as
  // a held one is; `fetchHeldInstruments` itself is unchanged (FR-381).
  const held = (await fetchRefreshPopulation(deps.db, { kinds: EQUITY_LIKE_KINDS })).filter(
    (heldInstrument) => heldInstrument.exchangeMic === deps.exchangeMic,
  );

  const symbolMap = await routeToProviderSymbolsViaDb(
    deps.db,
    held.map((h) => h.instrumentId),
    deps.providerKey,
  );
  const routed = held.filter((h) => symbolMap.has(h.instrumentId));
  const skippedNoMapping = held
    .filter((h) => !symbolMap.has(h.instrumentId))
    .map((h) => h.instrumentId);

  const toDate: IsoDate = deps.clock.now().toISOString().slice(0, 10);

  const attemptedInstrumentIds: InstrumentId[] = [];
  const updatedInstrumentIds: InstrumentId[] = [];
  const failedInstrumentIds: InstrumentId[] = [];
  const skippedUpToDate: InstrumentId[] = [];
  /**
   * SH-2 — this run's own "did any `instrument_price_daily`
   * row actually land" flag. Not `updatedInstrumentIds.length`: a provider
   * returning an empty observation list still counts as an "updated"
   * instrument for this job's result shape, but writes nothing, and bumping
   * the epoch for it would invalidate every tenant's cached valuations
   * without cause.
   */
  let rowsWritten = 0;

  try {
    for (const heldInstrument of routed) {
      const symbol: ProviderSymbol = symbolMap.get(heldInstrument.instrumentId)!;
      const latest = await latestPriceRowFor(deps.db, heldInstrument.instrumentId);

      // Nothing left for this run to do: the newest row is *today's official
      // close*. Only an `EOD` quality earns the skip — the date
      // alone used to be enough, because only this job and the backfill/gap-repair
      // jobs ever wrote the table, and all three write closes. The
      // quote-refresh handler now writes today's row too, from a latest quote,
      // and skipping on that would mean the official close for today never
      // lands and the day keeps whatever intraday figure was last fetched.
      if (latest !== null && latest.priceDate >= toDate && latest.quality === "EOD") {
        skippedUpToDate.push(heldInstrument.instrumentId);
        continue;
      }

      // Incremental: append only dates after
      // max(price_date) — but never start *after* `toDate`, so the current day
      // is always in the window and its provisional quote row is revised into
      // the official close by `upsertPriceDailyViaDb`'s unconditional upsert.
      // No prior row at all — start from today, never a multi-year backfill
      // (T-35's scope, not this job's).
      const nextUnfilled = latest === null ? toDate : nextIsoDate(latest.priceDate);
      const fromDate = nextUnfilled > toDate ? toDate : nextUnfilled;

      attemptedInstrumentIds.push(heldInstrument.instrumentId);
      try {
        const observations = await deps.provider.fetchDailyHistory(symbol, fromDate, toDate);
        rowsWritten += await upsertPriceDailyViaDb(
          deps.db,
          heldInstrument.instrumentId,
          observations,
        );
        updatedInstrumentIds.push(heldInstrument.instrumentId);
      } catch (error) {
        // Any provider error (`DataGap`, `SymbolNotFound`, `ProviderUnavailable`,
        // ...) for one instrument must not abort the other instruments in this
        // exchange's run — each instrument's close fill is independent (no
        // batching is even possible here: `fetchDailyHistory` is one symbol per
        // call). "Never fabricate" applies here exactly
        // as it does to the latest-quote cycle: a failed instrument's
        // `instrument_price_daily` series is simply left as-is, not backfilled
        // with a synthetic row. Only a non-`Error` thrown value (never expected
        // from a `QuoteProvider`, whose closed error taxonomy is always an
        // `Error` subclass — `market/ports/src/errors.ts`) is treated as
        // unexpected enough to abort the whole run rather than isolate.
        if (!(error instanceof Error)) {
          throw error;
        }
        failedInstrumentIds.push(heldInstrument.instrumentId);
      }
    }

    return {
      attemptedInstrumentIds,
      updatedInstrumentIds,
      failedInstrumentIds,
      skippedNoMapping,
      skippedUpToDate,
    };
  } finally {
    // SH-2 — once per job run, and in a `finally` so the rows this run
    // already committed are still invalidated when a later instrument aborts
    // the run (the non-`Error` rethrow above). Strictly after the writes
    // themselves, never before — see `bumpMarketDataEpoch`'s ordering rules.
    // A failure of the bump itself is deliberately allowed to surface rather
    // than be swallowed: a lost bump is exactly B1, and the job's own retry
    // re-writes and re-bumps.
    if (rowsWritten > 0) await bumpMarketDataEpoch(deps.db);
  }
}
