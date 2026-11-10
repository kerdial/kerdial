/**
 * `computeTwr` — true time-weighted return by sub-period chain-linking
 * (T-26). TWR answers "how did the
 * *investments* perform, stripped of the timing and size of the investor's
 * own deposits and withdrawals" (FR-25) — the complement to MWR/XIRR, which
 * keeps that timing in.
 *
 * ## Deliberately shares no code with XIRR (AC18)
 *
 * `computeTwr` does not call `computeXirr`, does not derive from it, and this
 * file must never import the XIRR module (T-27) — the file boundary is part of
 * the design. AC18 exists precisely to detect an implementation that fakes one
 * metric from the other; the two are always displayed as a labelled pair
 * (FR-33), so if they secretly shared a code path a bug in it would corrupt
 * both identically and the pairing would hide rather than reveal it. The
 * `twr-no-xirr` dependency-cruiser rule (keyed on `core/domain/xirr`) makes the
 * separation a build-time property, armed before T-27's file even exists.
 *
 * ## Only EXTERNAL flows split a sub-period (FR-25/AC18)
 *
 * This is the substance of the `flow_class` design ({@link ./flow-class.ts}).
 * Deposits and withdrawals (`EXTERNAL`) are the **only** flows that open a new
 * sub-period. Dividends (`INCOME`) and buys/sells/exchanges (`INTERNAL`) must
 * **never** open a boundary — a dividend is cash the portfolio earned, not
 * money the investor put in, and a trade just moves value between cash and
 * positions inside the portfolio. Getting this wrong is the classic
 * TWR/MWR-disagreement bug. This module therefore **consumes** each flow's
 * `flowClass` and never re-derives "is this external?" — the classifier
 * {@link classifyFlows} made that decision once, upstream.
 *
 * ## Flows occur at start-of-day
 *
 * The spec does not say when within a day an external flow lands; the
 * architecture fixes the convention that it lands at the **start** of its day,
 * so the day's market movement applies to the post-flow capital. Concretely
 * this is why the sub-period return is `V(end) / (V(start) + F) − 1` — the flow
 * `F` is added to the starting capital, not the ending value. The convention is
 * documented here and pinned by the known-answer fixtures in `twr.test.ts`.
 *
 * ## Valuation series convention (pre-flow, start-of-day)
 *
 * Each {@link Valuation} `value` is the portfolio's market value at the
 * **start of its day, before any external flow on that day**. On the vast
 * majority of days (no flow) this is simply the market value. On a flow day it
 * is the value carried in from the previous day, *before* the deposit/
 * withdrawal is applied — which is exactly what `V(start)` in the sub-period
 * formula wants, so the flow is added by the formula and never double-counted.
 * The caller (`valuePortfolio`, T-28) is responsible for producing the series
 * to this convention.
 *
 * ## Pure and DB-free (D13)
 *
 * Plain arrays in, a plain {@link TwrResult} out: no I/O, no database, and **no
 * clock** — the range is `[series[0].date, series[last].date]`, read from the
 * inputs, never from `Date.now()`. `core/domain` may import nothing but
 * `core/decimal` (enforced by the `core-domain-purity` dependency-cruiser
 * rule); this file imports only `Decimal` plus its sibling `FlowClass`/`IsoDate`
 * types. Every arithmetic step is exact `Decimal` at 34 significant digits
 * — the 0.01% AC tolerance is for the hand-calculation comparison, not a
 * licence to lose internal precision (NFR-12).
 */
import { Decimal } from "@kerdial/core-decimal";
import type { FlowClass } from "./flow-class.js";
import type { IsoDate } from "./types.js";

const ONE = new Decimal(1);

/**
 * One point of the daily valuation series `V(d)`. `value` follows
 * the pre-flow start-of-day convention documented in this module's header: the
 * market value at the start of `date`, before any external flow on that date.
 */
export interface Valuation {
  readonly date: IsoDate;
  readonly value: Decimal;
}

/**
 * One flow the caller has already classified. Only `flowClass ===
 * "EXTERNAL"` opens a sub-period boundary; every other class is read and
 * ignored here on purpose, so the fixtures can prove a dividend (`INCOME`) or a
 * trade (`INTERNAL`) sharing a date with no deposit does **not** split.
 *
 * `amount` is signed in the direction capital enters the portfolio: a **deposit
 * is positive**, a **withdrawal negative**. This is TWR's own sign convention
 * (capital added grows the invested base in `V(start) + F`); it is the opposite
 * of XIRR's cash-flow sign convention, which is one more reason the two engines
 * do not share inputs, let alone code.
 */
export interface TwrFlow {
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly flowClass: FlowClass;
}

/**
 * The result of {@link computeTwr}. There is deliberately **no single field
 * named `return`** holding a bare number (mirroring the return DTO's reasoning): a
 * caller must choose between `cumulative` and `annualised`, and `annualised`
 * being `null` is the explicit, unmissable flag that the range did not exceed
 * 365 days and so was not annualised (FR-25). A figure can never be shown
 * un-labelled as to whether it is annualised.
 */
export interface TwrResult {
  /** `Π(1 + r_i) − 1` over the sub-periods — the raw cumulative TWR, always. */
  readonly cumulative: Decimal;
  /**
   * The annualised TWR `(1 + cumulative)^(365/rangeDays) − 1`, set **only** when
   * `rangeDays > 365`; `null` otherwise. Non-null is itself the "this is
   * annualised" flag (FR-25).
   */
  readonly annualised: Decimal | null;
  /** Calendar days spanned, `series[last].date − series[0].date` (ACT/365 basis). */
  readonly rangeDays: number;
  /** How many sub-periods the range was split into (1 when no interim EXTERNAL flow). */
  readonly subPeriodCount: number;
}

/**
 * Raised for a malformed input the caller must fix: an empty series, a series
 * not strictly ascending by date, a flow dated outside the valuation range, or
 * an interior EXTERNAL flow with no matching valuation. Fail-closed rather than
 * guess a value that was never supplied (the same stance as {@link ./locf.ts}).
 */
export class TwrInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwrInputError";
  }
}

/**
 * Raised when a sub-period's invested base `V(start) + F` is zero, making its
 * return `V(end) / 0` undefined. This is a genuine mathematical singularity
 * (e.g. a withdrawal that exactly empties the portfolio at a sub-period start),
 * surfaced explicitly rather than as `Infinity`/`NaN` silently poisoning the
 * chained product.
 */
export class DegenerateSubPeriodError extends Error {
  readonly boundary: IsoDate;

  constructor(boundary: IsoDate) {
    super(
      `TWR sub-period starting ${boundary} has an invested base of zero ` +
        `(V(start) + F = 0), so its return is undefined.`,
    );
    this.name = "DegenerateSubPeriodError";
    this.boundary = boundary;
  }
}

/**
 * Calendar days between two `YYYY-MM-DD` dates. Pure integer arithmetic on
 * `Date.UTC` (no wall-clock read, no `Date.now()`), so the function stays a
 * deterministic function of its inputs. Operates on plain numbers/strings, not
 * `Decimal`, so the no-floats rule does not apply.
 */
function daysBetween(from: IsoDate, to: IsoDate): number {
  const epochDay = (date: IsoDate): number => {
    const parts = date.split("-");
    const year = Number.parseInt(parts[0] ?? "", 10);
    const month = Number.parseInt(parts[1] ?? "", 10);
    const day = Number.parseInt(parts[2] ?? "", 10);
    const ms = Date.UTC(year, month - 1, day);
    if (Number.isNaN(ms)) {
      throw new TwrInputError(`Not a valid YYYY-MM-DD date: ${JSON.stringify(date)}`);
    }
    return Math.round(ms / 86_400_000);
  };
  return epochDay(to) - epochDay(from);
}

/**
 * Computes the time-weighted return over `series`' range, chain-linking one
 * sub-period per interval between consecutive EXTERNAL-flow boundaries.
 *
 * @param series Daily valuation series, pre-flow start-of-day
 *   values (see module header). Must be non-empty and strictly ascending by
 *   date. The range is `[series[0].date, series[last].date]`.
 * @param flows All flows over the range, already classified. Only
 *   `EXTERNAL` flows split a sub-period; the rest are ignored. Deposits
 *   positive, withdrawals negative.
 */
export function computeTwr(series: readonly Valuation[], flows: readonly TwrFlow[]): TwrResult {
  if (series.length === 0) {
    throw new TwrInputError("computeTwr requires a non-empty valuation series.");
  }

  // Strictly-ascending check + date→value index in one pass. Strictness (not
  // merely non-descending) rules out two valuations on the same day, which the
  // pre-flow convention could not disambiguate.
  const valueByDate = new Map<IsoDate, Decimal>();
  for (let i = 0; i < series.length; i++) {
    const point = series[i]!;
    if (i > 0 && point.date <= series[i - 1]!.date) {
      throw new TwrInputError(
        `Valuation series must be strictly ascending by date; ` +
          `${series[i - 1]!.date} is not before ${point.date}.`,
      );
    }
    valueByDate.set(point.date, point.value);
  }

  const rangeStart = series[0]!.date;
  const rangeEnd = series[series.length - 1]!.date;

  // Sum EXTERNAL flow amounts per boundary date. Flows at `rangeEnd` are
  // dropped: no sub-period begins there, so a closing withdrawal cannot affect
  // the range's return (correct — it is money leaving *after* the last measured
  // day). A flow strictly outside the range is a caller error.
  const externalFlowByDate = new Map<IsoDate, Decimal>();
  for (const flow of flows) {
    if (flow.flowClass !== "EXTERNAL") continue;
    if (flow.date < rangeStart || flow.date > rangeEnd) {
      throw new TwrInputError(
        `EXTERNAL flow on ${flow.date} falls outside the valuation range ` +
          `[${rangeStart}, ${rangeEnd}].`,
      );
    }
    if (flow.date === rangeEnd) continue;
    const running = externalFlowByDate.get(flow.date) ?? new Decimal(0);
    externalFlowByDate.set(flow.date, running.plus(flow.amount));
  }

  // Boundary dates: the range start, every interior EXTERNAL-flow date, and the
  // range end — unique and ascending. An EXTERNAL flow exactly at `rangeStart`
  // contributes its amount as F on the first sub-period (the opening-deposit
  // case) but is already a boundary; no need to add it twice.
  const interiorBoundaries = [...externalFlowByDate.keys()]
    .filter((date) => date > rangeStart)
    .sort();
  const boundaries: IsoDate[] = [rangeStart, ...interiorBoundaries];
  if (rangeEnd !== rangeStart) boundaries.push(rangeEnd);

  // Chain-link. Between consecutive boundaries no EXTERNAL cash moves, so the
  // pre-flow valuation at the next boundary is purely the market-driven growth
  // of this boundary's post-flow capital — the multiplicative factor chains
  // regardless of any interim daily points (which is why only boundary
  // valuations are read).
  let product = ONE;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startDate = boundaries[i]!;
    const endDate = boundaries[i + 1]!;

    const startValue = valueByDate.get(startDate);
    const endValue = valueByDate.get(endDate);
    // rangeStart/rangeEnd are series dates by construction; only interior
    // (flow-derived) boundaries can be missing a valuation.
    if (startValue === undefined) {
      throw new TwrInputError(
        `No valuation for EXTERNAL-flow boundary ${startDate}; the series must ` +
          `include a valuation on every date carrying a deposit/withdrawal.`,
      );
    }
    if (endValue === undefined) {
      throw new TwrInputError(
        `No valuation for EXTERNAL-flow boundary ${endDate}; the series must ` +
          `include a valuation on every date carrying a deposit/withdrawal.`,
      );
    }

    const flow = externalFlowByDate.get(startDate) ?? new Decimal(0);
    const investedBase = startValue.plus(flow);
    if (investedBase.isZero()) {
      throw new DegenerateSubPeriodError(startDate);
    }

    product = product.times(endValue.dividedBy(investedBase));
  }

  const cumulative = product.minus(ONE);
  const rangeDays = daysBetween(rangeStart, rangeEnd);

  // Annualise only when the range exceeds a full year (FR-25),
  // ACT/365. `null` when it does not, so the flag can never be misread.
  const annualised =
    rangeDays > 365 ? product.pow(new Decimal(365).dividedBy(rangeDays)).minus(ONE) : null;

  return {
    cumulative,
    annualised,
    rangeDays,
    subPeriodCount: Math.max(boundaries.length - 1, 0),
  };
}
