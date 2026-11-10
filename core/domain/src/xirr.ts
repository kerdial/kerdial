/**
 * `computeXirr` — money-weighted return (MWR) as the irregular-interval
 * internal rate of return over a portfolio's `EXTERNAL` cash flows plus a
 * terminal market value (T-27). MWR/XIRR
 * answers "what constant annual rate, applied to *my* actual deposits and
 * withdrawals on their actual dates, reproduces the ending value" (FR-26) — the
 * complement to TWR, which strips exactly that timing back out.
 *
 * ## Deliberately shares no code with TWR (AC18)
 *
 * `computeXirr` does not call `computeTwr`, does not derive from it, and this
 * file must never import the TWR module (`twr.ts`). AC18 exists precisely to
 * detect an implementation that fakes one metric from the other; the two are
 * always displayed as a labelled pair (FR-33), so a shared code path would let
 * one bug corrupt both identically and the pairing would hide the error rather
 * than reveal it. The mutual `twr-no-xirr` / `xirr-no-twr` dependency-cruiser
 * rules (keyed on this exact file path) make the separation a build-time
 * property. Even the `daysBetween` day-count helper is re-implemented here
 * rather than shared — the independence is total, not "shared utilities only".
 *
 * ## Sign convention — the *opposite* of TWR's
 *
 * XIRR takes cash flows from the **investor's** point of view, which is the
 * reverse of TWR's "capital added grows the invested base" convention:
 *   - a **deposit** is **negative** (money leaves the investor's pocket),
 *   - a **withdrawal** is **positive** (money returns to it),
 *   - the **opening** market value at the range start is **negative** (as if
 *     the investor "bought" the starting portfolio) — passed by the caller as a
 *     flow in `flows`,
 *   - the **terminal** market value at the range end is **positive** (as if the
 *     investor "sold" the ending portfolio) — passed as `terminal`.
 * The caller assembles the signed vector; this module never re-derives a flow's
 * class or sign. That the sign convention is inverted from TWR's is one more
 * reason the two engines share neither inputs nor code.
 *
 * ## Solver: Newton–Raphson with a bisection fallback (R5)
 *
 * NPV(r) = Σ_i CF_i · (1 + r)^(−t_i), with t_i the ACT/365F year-fraction from
 * the earliest date to flow i. The root of NPV is the rate. Newton–Raphson,
 * seeded at 0.10, is tried first; if it diverges (steps outside the search
 * bracket) or the derivative underflows, the solver falls back to **bisection**
 * over `[-0.9999, 10.0]`. Convergence is |NPV| ≤ `1e-10`; the iteration cap is
 * 200 for each phase.
 *
 * On non-convergence the function returns an explicit {@link XirrDidNotConverge}
 * result — **never `0`, never `NaN`, never a silently wrong root** (the R5
 * mitigation, and itself tested). A pathological sign-change sequence with
 * multiple mathematical roots therefore yields either a genuine root (one whose
 * NPV is ≤ tolerance) or an explicit non-convergence, but never a fabricated
 * number. The API surfaces `XirrDidNotConverge` as `null` with a reason.
 *
 * ## Day counting: ACT/365F
 *
 * Year-fractions are actual calendar days divided by a fixed 365 (ACT/365F),
 * documented here because the spec is silent. This is asserted by a fixture
 * where ACT/360 or 30/360 would move the result by more than the 0.01% AC
 * tolerance.
 *
 * ## `Decimal.pow` with a fractional exponent (NFR-12, no-floats posture)
 *
 * Discounting needs `(1 + r)^(days/365)` — a non-integer power. decimal.js has
 * no *exact* fractional `pow`, but `Decimal#pow` with a `Decimal` exponent is
 * deterministic to the configured precision (34 significant digits). That
 * is acceptable here: this is iterative root-finding to a `1e-10` NPV
 * tolerance, not exact ledger arithmetic, and 34 digits is ~24 orders of
 * magnitude of headroom over the tolerance. The working precision is the
 * global 34 — deliberately **not** bumped locally, because mutating
 * `Decimal.set` would be a non-pure global side effect. JS `Math.pow`/floats
 * are never used; the no-floats posture holds end to end.
 *
 * ## Pure and DB-free (D13)
 *
 * Plain arrays in, a plain {@link XirrResult} out: no I/O, no database, no clock
 * (the time origin is the earliest input date, never `Date.now()`).
 * `core/domain` may import nothing but `core/decimal` (the `core-domain-purity`
 * rule); this file imports only `Decimal` and its sibling `IsoDate` type.
 */
import { Decimal } from "@kerdial/core-decimal";
import type { IsoDate } from "./types.js";

const ONE = new Decimal(1);
const NEWTON_SEED = new Decimal("0.10");
/** NPV convergence tolerance. */
const NPV_TOLERANCE = new Decimal("1e-10");
/** Below this the Newton derivative is treated as underflowed → bisection. */
const DERIVATIVE_FLOOR = new Decimal("1e-30");
/** Iteration cap per phase. */
const MAX_ITERATIONS = 200;
/** Bisection bracket: a rate of −0.9999 is a −99.99% loss; 10.0 is +1000%. */
const BRACKET_LOW = new Decimal("-0.9999");
const BRACKET_HIGH = new Decimal("10.0");
/** ACT/365F fixed denominator. */
const DAYS_PER_YEAR = new Decimal(365);

/**
 * One signed cash flow. `amount` follows XIRR's investor-perspective sign
 * convention documented in the module header: **deposit negative, withdrawal
 * positive, opening market value negative**. This is the opposite of
 * {@link ./twr.ts}'s `TwrFlow.amount` sign — a deliberate divergence, not an
 * oversight.
 */
export interface XirrFlow {
  readonly date: IsoDate;
  readonly amount: Decimal;
}

/**
 * The terminal market value at the range end — the value of everything still
 * held, treated as a **positive** inflow (as if liquidated). Passed separately
 * from `flows` so the caller cannot forget its sign and so the range end is
 * unambiguous.
 */
export interface TerminalValue {
  readonly date: IsoDate;
  readonly value: Decimal;
}

/**
 * A converged solve. `rate` is the annualised MWR as a decimal fraction (0.10 =
 * 10%). `method` records which phase produced it and `iterations` how many
 * steps that phase took — surfaced for diagnostics, never for control flow.
 */
export interface XirrConverged {
  readonly converged: true;
  readonly rate: Decimal;
  readonly method: "newton" | "bisection";
  readonly iterations: number;
}

/**
 * The explicit non-convergence result (R5). Returned — not thrown — when
 * neither Newton–Raphson nor bisection reaches an NPV within tolerance: the
 * root lies outside `[-0.9999, 10.0]`, the bracket endpoints share a sign so no
 * root can be isolated, or the cash-flow shape has no real root at all. The
 * caller (and ultimately the API) treats this as "MWR unavailable, here
 * is why", never as a numeric `0`/`NaN`.
 */
export interface XirrDidNotConverge {
  readonly converged: false;
  /** What a client may branch on; `reason` stays the English diagnostic. */
  readonly code: ReturnUnavailableCode;
  readonly reason: string;
}

/**
 * Why a TWR or MWR figure is unavailable, as a closed set the
 * web maps to one French line. `reason` beside it is free text for a tooltip,
 * which is why no client may branch on it.
 *
 * - `ZERO_INVESTED_BASE` — a TWR sub-period starts from `V(start) + F = 0`.
 * - `INSUFFICIENT_DATA` — the valuation series or flows cannot support a figure.
 * - `NO_ROOT_IN_BRACKET` — the NPV has one sign over the whole search bracket.
 * - `DID_NOT_CONVERGE` — neither solver reached the tolerance.
 * - `NO_PORTFOLIO` — a combined figure over a tenant with no portfolio.
 */
export type ReturnUnavailableCode =
  | "ZERO_INVESTED_BASE"
  | "INSUFFICIENT_DATA"
  | "NO_ROOT_IN_BRACKET"
  | "DID_NOT_CONVERGE"
  | "NO_PORTFOLIO";

export type XirrResult = XirrConverged | XirrDidNotConverge;

/**
 * Raised for a malformed input the caller must fix (an empty flow list or an
 * unparseable date), as opposed to a well-formed input with no root — that
 * latter, expected case returns {@link XirrDidNotConverge} rather than throwing.
 * Fail-closed, the same stance as {@link ./twr.ts}'s `TwrInputError`.
 */
export class XirrInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XirrInputError";
  }
}

/**
 * Calendar days between two `YYYY-MM-DD` dates (ACT day count). Pure integer
 * arithmetic on `Date.UTC` — no wall-clock read, no `Date.now()` — so the
 * function is a deterministic function of its inputs. Operates on plain
 * numbers/strings, not `Decimal`, so the no-floats rule does not apply.
 * Re-implemented here rather than shared with `twr.ts` to keep the two engines
 * code-disjoint (see module header).
 */
function daysBetween(from: IsoDate, to: IsoDate): number {
  const epochDay = (date: IsoDate): number => {
    const parts = date.split("-");
    const year = Number.parseInt(parts[0] ?? "", 10);
    const month = Number.parseInt(parts[1] ?? "", 10);
    const day = Number.parseInt(parts[2] ?? "", 10);
    const ms = Date.UTC(year, month - 1, day);
    if (Number.isNaN(ms)) {
      throw new XirrInputError(`Not a valid YYYY-MM-DD date: ${JSON.stringify(date)}`);
    }
    return Math.round(ms / 86_400_000);
  };
  return epochDay(to) - epochDay(from);
}

/** A cash flow reduced to its ACT/365F year-fraction from the time origin. */
interface Term {
  readonly cf: Decimal;
  /** t_i — actual days from the origin ÷ 365, as a `Decimal`. */
  readonly years: Decimal;
}

/** NPV(r) = Σ CF_i · (1 + r)^(−t_i). `base` is `1 + r`, always > 0 in-bracket. */
function npv(terms: readonly Term[], onePlusR: Decimal): Decimal {
  let sum = new Decimal(0);
  for (const term of terms) {
    sum = sum.plus(term.cf.times(onePlusR.pow(term.years.negated())));
  }
  return sum;
}

/** NPV'(r) = Σ CF_i · (−t_i) · (1 + r)^(−t_i − 1). */
function npvDerivative(terms: readonly Term[], onePlusR: Decimal): Decimal {
  let sum = new Decimal(0);
  for (const term of terms) {
    if (term.years.isZero()) continue; // ∂/∂r of a t=0 term is 0
    sum = sum.plus(
      term.cf.times(term.years.negated()).times(onePlusR.pow(term.years.negated().minus(ONE))),
    );
  }
  return sum;
}

/**
 * Computes the money-weighted return (XIRR) of `flows` plus `terminal`.
 *
 * @param flows Signed `EXTERNAL` cash flows over the range, following XIRR's
 *   sign convention (deposits negative, withdrawals positive, opening market
 *   value negative). Must be non-empty.
 * @param terminal The terminal market value at the range end, treated as a
 *   positive inflow.
 * @returns {@link XirrConverged} with the solved `rate`, or
 *   {@link XirrDidNotConverge} when no root can be found in `[-0.9999, 10.0]`.
 */
export function computeXirr(flows: readonly XirrFlow[], terminal: TerminalValue): XirrResult {
  if (flows.length === 0) {
    throw new XirrInputError("computeXirr requires at least one cash flow.");
  }

  // Time origin: the earliest date across flows and terminal. The choice of
  // origin does not change the solved rate (shifting every t_i by a constant
  // only rescales NPV by (1+r)^(−shift), which cannot move a root while
  // 1+r ≠ 0), but anchoring at the earliest date keeps every exponent ≤ 0 and
  // the arithmetic well-conditioned.
  let origin = terminal.date;
  for (const flow of flows) {
    if (flow.date < origin) origin = flow.date;
  }

  const terms: Term[] = [];
  for (const flow of flows) {
    terms.push({
      cf: flow.amount,
      years: new Decimal(daysBetween(origin, flow.date)).dividedBy(DAYS_PER_YEAR),
    });
  }
  terms.push({
    cf: terminal.value,
    years: new Decimal(daysBetween(origin, terminal.date)).dividedBy(DAYS_PER_YEAR),
  });

  // ---- Phase 1: Newton–Raphson, seeded at 0.10 -------------------------------
  let r = NEWTON_SEED;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const onePlusR = ONE.plus(r);
    const value = npv(terms, onePlusR);
    if (value.abs().lessThanOrEqualTo(NPV_TOLERANCE)) {
      return { converged: true, rate: r, method: "newton", iterations: i };
    }
    const slope = npvDerivative(terms, onePlusR);
    if (slope.abs().lessThan(DERIVATIVE_FLOOR)) break; // derivative underflow → bisection
    const next = r.minus(value.dividedBy(slope));
    // A step outside the bracket is Newton diverging → hand off to bisection.
    if (next.lessThan(BRACKET_LOW) || next.greaterThan(BRACKET_HIGH) || !next.isFinite()) break;
    r = next;
  }

  // ---- Phase 2: bisection over [-0.9999, 10.0] -------------------------------
  let a = BRACKET_LOW;
  let b = BRACKET_HIGH;
  let fa = npv(terms, ONE.plus(a));
  let fb = npv(terms, ONE.plus(b));

  // No sign change across the bracket ⇒ no root can be isolated inside it.
  // Fail closed rather than return a fabricated midpoint (R5).
  if (fa.isZero()) return { converged: true, rate: a, method: "bisection", iterations: 0 };
  if (fb.isZero()) return { converged: true, rate: b, method: "bisection", iterations: 0 };
  if (fa.isNegative() === fb.isNegative()) {
    return {
      converged: false,
      code: "NO_ROOT_IN_BRACKET",
      reason:
        `NPV has the same sign at both ends of the search bracket ` +
        `[${BRACKET_LOW.toString()}, ${BRACKET_HIGH.toString()}] ` +
        `(NPV(low)=${fa.toString()}, NPV(high)=${fb.toString()}); no internal-rate-of-return ` +
        `root exists there, so MWR is undefined for these flows (R5).`,
    };
  }

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const m = a.plus(b).dividedBy(2);
    const fm = npv(terms, ONE.plus(m));
    if (fm.abs().lessThanOrEqualTo(NPV_TOLERANCE)) {
      return { converged: true, rate: m, method: "bisection", iterations: i };
    }
    // Keep the sub-interval whose endpoints still straddle the root.
    if (fm.isNegative() === fa.isNegative()) {
      a = m;
      fa = fm;
    } else {
      b = m;
      fb = fm;
    }
  }

  return {
    converged: false,
    code: "DID_NOT_CONVERGE",
    reason:
      `Neither Newton–Raphson (seed 0.10) nor bisection over ` +
      `[${BRACKET_LOW.toString()}, ${BRACKET_HIGH.toString()}] reached an NPV within ` +
      `${NPV_TOLERANCE.toString()} in ${MAX_ITERATIONS} iterations (R5).`,
  };
}
