import { and, eq, inArray, sql } from "drizzle-orm";
import { holdingState, instrument, instrumentQuoteLatest, type Db } from "@kerdial/platform-db";
import type { InstrumentKind } from "@kerdial/market-ports";

/**
 * Staleness surfacing — T-34's fourth acceptance criterion:
 * "an automated check flags it as stale once its age exceeds the
 * NFR-1/NFR-2 threshold for its asset kind." NFR-1 budgets 20 minutes total
 * staleness for equities/ETFs/indices; NFR-2 budgets 10 minutes for crypto
 * (both derive from provider delay + poll interval). This module supplies the **mechanism** only — a pure
 * threshold/age computation plus a read of `instrument_quote_latest` — not
 * the human-visible alert (T-3) or the API's provenance envelope (T-39),
 * which consume this.
 */

/** NFR-1: 20 minutes, for SHARE/ETF/INDEX. */
export const EQUITY_STALENESS_THRESHOLD_MS = 20 * 60 * 1000;

/** NFR-2: 10 minutes, for CRYPTO. */
export const CRYPTO_STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

/** FUND (polled since ADR-0018) takes the equity threshold: a NAV is a daily series like a close. The ops-indicator sweep leaves FUND out of its quote-staleness read altogether (`QUOTE_CADENCE_KINDS`), because a fund's quote `as_of` is its last NAV date and would sit past any intraday budget by nature. */
export function stalenessThresholdMsForKind(kind: InstrumentKind): number {
  return kind === "CRYPTO" ? CRYPTO_STALENESS_THRESHOLD_MS : EQUITY_STALENESS_THRESHOLD_MS;
}

export interface StalenessResult {
  readonly instrumentId: string;
  readonly kind: InstrumentKind;
  readonly asOf: Date;
  /** `now - asOf`, in milliseconds. Never negative in practice (`asOf` is never in the future — `market/ports`' own provider-contract suite already asserts this at the adapter boundary) but not clamped here, so a caller sees the raw figure. */
  readonly ageMs: number;
  readonly thresholdMs: number;
  /** `true` once `ageMs` exceeds `thresholdMs` — strictly greater than, not greater-or-equal, so a quote whose age lands exactly on the budget is not yet flagged. */
  readonly stale: boolean;
}

/** The pure computation — no I/O, driven entirely by its arguments so it is provable with a `FakeClock`-driven `now` and zero real waiting. */
export function computeStaleness(
  instrumentId: string,
  kind: InstrumentKind,
  asOf: Date,
  now: Date,
): StalenessResult {
  const ageMs = now.getTime() - asOf.getTime();
  const thresholdMs = stalenessThresholdMsForKind(kind);
  return { instrumentId, kind, asOf, ageMs, thresholdMs, stale: ageMs > thresholdMs };
}

/**
 * SH-36 — the never-fetched staleness fix.
 *
 * The read this replaced (`listInstrumentQuoteStaleness`, since deleted)
 * started from `instrument_quote_latest` and
 * inner-joined `instrument`. Every row it could possibly return was a row that
 * *exists*, so an instrument that has **never been successfully fetched** —
 * no row at all — was not merely reported fresh, it was not reported. As the
 * production source for an alert (FR-48 item 1) that is silent in exactly
 * the total-failure case: a provider outage on the very first fetch, a
 * mis-mapped symbol, a `quote-refresh` job that has been dying since the day it
 * was scheduled, all read `OK`. `staleness.integration.test.ts` keeps that
 * failure mode demonstrated, inner join and all, as raw SQL.
 *
 * That was harmless while nothing wrote the table on a cadence and the check
 * fed no alert. It is not harmless now, and the twice-daily quote cadence
 * makes it worse rather than better: at two scheduled passes a day, an instrument that
 * silently never gets fetched has twelve hours of cover before anything else
 * hints at it.
 *
 * **The fix is the direction of the join.** Staleness is computed over the
 * **held subset of the fan-out population** — the `holding_state.quantity > 0`
 * instruments, which is the set the *ops indicator* promises something about —
 * **left-joined** to `instrument_quote_latest`, with a missing row treated as
 * *maximally* stale ({@link HeldQuoteStaleness.ageMs} `null`,
 * {@link HeldQuoteStaleness.neverFetched} `true`, `stale` `true`), never as
 * absent.
 *
 * **The held subset is strictly smaller than the fan-out population as of the
 * `watchlist` cycle, and that is a decision, not drift.** The fan-out now polls
 * `held ∪ watched` (`fetchRefreshPopulation`, four call sites), while this read
 * stays held-scoped: alerting scope is the money-bearing population, and an
 * operational alert that a *stranger's* watchlist entry has no price is the
 * first alert an owner learns to ignore — the argument
 * `ops-indicator-sweep.ts:256-258` already makes for an empty deployment. A
 * watchlist row's own stale series is visible to the user who added it
 * (FR-344), which is where it belongs. **Revisit trigger:** if the ops
 * indicator is ever asked to cover watched instruments, this query and
 * `ops-indicator-sweep.ts`'s MIC list change together, and the threshold
 * argument below is re-made for a population nobody is exposed to.
 *
 * The threshold is the caller's, and deliberately so: it is
 * **cadence-relative** (roughly 14 hours, one missed 12-hour slot plus
 * margin), not NFR-1/NFR-2's 20/10-minute display budgets, which at
 * a twice-daily cadence are exceeded essentially always and would leave the
 * indicator permanently breached. The number itself belongs to the sweep that
 * publishes the verdict (`market/composition`'s `ops-indicator-sweep.ts`), not
 * to this read.
 */
export interface HeldQuoteStaleness {
  readonly instrumentId: string;
  readonly kind: InstrumentKind;
  /** `null` **only** when this held instrument has no `instrument_quote_latest` row at all. */
  readonly asOf: Date | null;
  /** `null` for the never-fetched case — there is no age, which is the point; do not read it as zero. */
  readonly ageMs: number | null;
  readonly thresholdMs: number;
  /** `true` for a row older than `thresholdMs` **and** for the never-fetched case. */
  readonly stale: boolean;
  /** The distinct detail: the row is missing, not old. */
  readonly neverFetched: boolean;
}

export interface ListHeldInstrumentQuoteStalenessOptions {
  /** Narrows the fan-out set, exactly as {@link fetchHeldInstruments}'s own option does. */
  readonly kinds?: readonly InstrumentKind[];
}

/**
 * The B3-fixed read: one left-joined statement over the fan-out set. See
 * {@link HeldQuoteStaleness} for why the join direction is the fix.
 *
 * `DISTINCT` for the same reason `fetchHeldInstruments` uses it — an
 * instrument held by N tenants is one instrument to poll and one instrument to
 * report on, not N. `db` should be the `app_ingest` pool: `holding_state`'s
 * `holding_state_ingest_read` policy grants that role the cross-tenant read,
 * and `instrument`/`instrument_quote_latest` are already readable by it
 * (migrations `0018` and `0007`).
 */
export async function listHeldInstrumentQuoteStaleness(
  db: Db,
  now: Date,
  thresholdMs: number,
  options?: ListHeldInstrumentQuoteStalenessOptions,
): Promise<HeldQuoteStaleness[]> {
  const kinds = options?.kinds;
  const positiveQuantity = sql`${holdingState.quantity} > 0`;
  const where =
    kinds && kinds.length > 0
      ? and(positiveQuantity, inArray(instrument.kind, kinds))
      : positiveQuantity;

  const rows = await db
    .selectDistinct({
      instrumentId: holdingState.instrumentId,
      kind: instrument.kind,
      asOf: instrumentQuoteLatest.asOf,
    })
    .from(holdingState)
    .innerJoin(instrument, eq(instrument.id, holdingState.instrumentId))
    // The whole fix, in one word.
    .leftJoin(
      instrumentQuoteLatest,
      eq(instrumentQuoteLatest.instrumentId, holdingState.instrumentId),
    )
    .where(where);

  return rows.map((row) => {
    if (row.asOf === null) {
      return {
        instrumentId: row.instrumentId,
        kind: row.kind,
        asOf: null,
        ageMs: null,
        thresholdMs,
        stale: true,
        neverFetched: true,
      };
    }
    const ageMs = now.getTime() - row.asOf.getTime();
    return {
      instrumentId: row.instrumentId,
      kind: row.kind,
      asOf: row.asOf,
      ageMs,
      thresholdMs,
      stale: ageMs > thresholdMs,
      neverFetched: false,
    };
  });
}
