import { z } from "zod";
import type { PortfolioIconMeta, PortfolioRecord } from "@kerdial/ledger";
import { createPortfolioBodySchema, patchPortfolioBodySchema } from "@kerdial/api-contracts";
import {
  type InstrumentIconContentType,
  type PortfolioAccentColor,
} from "@kerdial/core-reference-data";
import type {
  PortfolioReturns,
  PortfolioValueSeries,
  TwrOutcome,
  ValuedClosedPosition,
  ValuedClosedPositions,
  ValuedHolding,
  ValuedPortfolioHoldings,
  ValuedRealizedGain,
} from "@kerdial/valuation";
import { problemException } from "../common/problem.js";
import { serializeDecimal } from "../common/decimal.schema.js";
import {
  toProvenanceSummaryResponse,
  toValuedAmountResponse,
} from "../common/valued-amount.schema.js";

/**
 * Zod DTOs for `/portfolios/*` (T-37/T-39
 * FR-14). `portfolio` carries no decimal columns (`ledger/src/portfolio-
 * service.ts`'s own doc comment: "portfolio rows carry no cash columns"), so
 * NFR-12/AC53's decimal-as-string rule has nothing to enforce for the plain
 * `PortfolioResponse` shape above — every derived figure T-39 adds below
 * (`overview`/`holdings`/`performance`) is wrapped in the `ValuedAmount`
 * envelope instead (`../common/valued-amount.schema.ts`).
 */

/**
 * D10 — `createPortfolioBodySchema` moved to
 * `core/api-contracts/src/portfolio-name.schema.ts` (pure move: this
 * re-export keeps every existing import path in this file working, and the
 * runtime object is the same one `web` imports).
 *
 * **The parity assertion this comment used to cite is gone.** `web/src/lib/
 * tester-schema-parity.test.ts` was deleted in a test consolidation.
 * The property still holds by construction — both sides import the same
 * object from `@kerdial/api-contracts` — but nothing would catch a future
 * divergence; that is an open owner question rather than a defect.
 *
 * `updatePortfolioBodySchema` (`PATCH /portfolios/:id`'s body) is built from
 * the same `portfolioNameSchema` there, plus `portfolio-details`' three new
 * field schemas. It replaced `renamePortfolioBodySchema` in PD-T7, when the
 * `PATCH` stopped being a rename. **`renamePortfolioBodySchema` no longer
 * exists anywhere** — PD-T10 deleted it from `@kerdial/api-contracts` once
 * `web`'s call site moved, in this same cycle. An earlier revision of this
 * comment said it "survives only until" that happened; it then happened, and
 * the sentence became the stale-invariant-beside-correct-code shape this
 * cycle calls out elsewhere (security review C2)
 *
 * `portfolio-archive` re-exports `patchPortfolioBodySchema` in
 * its place: the union of `updatePortfolioBodySchema` and the strict
 * `{ archived }` body, which is what the `PATCH` handler now parses.
 */
export { createPortfolioBodySchema, patchPortfolioBodySchema };
export type { CreatePortfolioBody, UpdatePortfolioBody } from "@kerdial/api-contracts";

export const listPortfoliosQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/**
 * The wire shape of one portfolio.
 *
 * **The three new fields are `null` when unset, never an absent key**
 * (`HoldingResponse.symbol`'s precedent: additive, always present,
 * nullable). A client then never has to distinguish "this portfolio has no
 * broker" from "this server predates the field", which an optional key would
 * force it to.
 *
 * **`hasIcon` is presence, never bytes** (L8, FR-467). The bitmap is fetched
 * from `GET /portfolios/:id/icon` only by the surfaces that actually render
 * one; putting up to 256 KiB of base64 on every list page would be the thing
 * L8 exists to refuse.
 *
 * No decimal crosses this boundary — `portfolio` carries no numeric column and
 * this cycle adds none — so there is no `ValuedAmount` envelope here, unlike
 * every other response on this controller. Stated because its absence would
 * otherwise read as an omission.
 */
export interface PortfolioResponse {
  readonly id: string;
  readonly name: string;
  /** FR-449 — the bank or broker this portfolio is held at. Free text (L3): no reference table, no CRUD screen. */
  readonly broker: string | null;
  /** FR-449 — free-text notes. */
  readonly description: string | null;
  /** FR-451/L6 — one of the six existing chart-ramp **token identifiers**, never a hex string. */
  readonly accentColor: PortfolioAccentColor | null;
  /** L8 — whether `GET /portfolios/:id/icon` would answer with bytes. */
  readonly hasIcon: boolean;
  /** `portfolio-archive` FR-593, PAD-5 — display-only flag; the instant (`archived_at`) stays server-side. */
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** D8 — the blocking-transaction-count figure, computed only for the ids a given response actually returns (see `countTransactionsByPortfolio`, `@kerdial/ledger`). */
  readonly transactionCount: number;
}

/**
 * `hasIcon` is a **required** third parameter, with deliberately no default.
 * That is the whole mechanism against a call site silently reporting `false`: a
 * default would compile at all four call sites and be wrong at one of them
 * (`create`, whose row comes back from `createPortfolio` as a bare
 * `PortfolioRecord` and therefore carries no join result to read the flag off),
 * and nothing would say so until a freshly created iconed portfolio rendered
 * the wallet fallback. The rejected alternative — widening `createPortfolio`'s
 * return to `PortfolioWithIcon` — would make it read back a row it has just
 * written inside its own transaction to learn a fact its own caller supplied.
 */
export function toPortfolioResponse(
  row: PortfolioRecord,
  transactionCount: number,
  hasIcon: boolean,
): PortfolioResponse {
  return {
    id: row.id,
    name: row.name,
    broker: row.broker,
    description: row.description,
    accentColor: row.accentColor,
    hasIcon,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    transactionCount,
  };
}

/**
 * `PUT /portfolios/:id/icon`'s `200` body.
 *
 * **The metadata, never the bytes.** The caller just sent them, and up to
 * 256 KiB of pure round-trip per upload would buy nothing: the surfaces render
 * from `GET /portfolios/:id/icon`, not from this response.
 *
 * **No `source`**, unlike `InstrumentIconMetaResponse` (FR-462/SD-2/PD-5).
 * There is no column to project: bank logos have no automated-fetch lane, so
 * there is no provenance seam to represent, and inventing the field here would
 * mean a wire contract claiming a distinction the table cannot make.
 *
 * `200` on both set and replace, with no create-vs-overwrite signal — the
 * table's primary key makes them one statement (FR-461), and the client already
 * knows which it did.
 */
export interface PortfolioIconMetaResponse {
  readonly portfolioId: string;
  readonly contentType: InstrumentIconContentType;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** ISO-8601 UTC instant, `Date.toISOString()` — the same wire shape every other timestamp on this API uses. */
  readonly updatedAt: string;
}

/** `PortfolioIconMeta` (the `ledger` row projection) → the wire shape. `tenantId` is dropped: it is the caller's own, and echoing it would put an identifier in a response that has no consumer for it — `toInstrumentIconMetaResponse`'s own rule. */
export function toPortfolioIconMetaResponse(meta: PortfolioIconMeta): PortfolioIconMetaResponse {
  return {
    portfolioId: meta.portfolioId,
    contentType: meta.contentType,
    byteLength: meta.byteLength,
    widthPx: meta.widthPx,
    heightPx: meta.heightPx,
    updatedAt: meta.updatedAt.toISOString(),
  };
}

/**
 * T-39 — `GET /portfolios/:id/overview`, `GET
 * /portfolios/:id/holdings`, `GET /portfolios/:id/performance`, and their
 * combined tenant-wide counterparts (`GET /portfolios/overview`, `GET
 * /portfolios/holdings`, added 2026-07-21 by user decision).
 */

/**
 * F2-style shape check (mirrors `instruments.schema.ts`'s own
 * `isRealCalendarDate`, deliberately re-declared per schema file rather than
 * shared — see that file's own convention): rejects a string like
 * `"2024-02-31"` that passes a bare regex but is not a real calendar date.
 */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO YYYY-MM-DD calendar date")
  .refine(isRealCalendarDate, "must be a real calendar date (e.g. not February 31st)");

export const overviewQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export const performanceQuerySchema = overviewQuerySchema;
/** FR-262: same `?from=&to=` window contract as the performance read — same bounds, same rejection posture. */
export const valueSeriesQuerySchema = overviewQuerySchema;

/**
 * The default `[from, to]` window when neither is supplied, and the maximum
 * span an explicit range may cover — mirrors `instruments.schema.ts`'s
 * `resolvePriceHistoryWindow` constants **by value, not by import** (that
 * function's own convention: a separately-declared constant of the same
 * value rather than a new cross-schema dependency), and is also
 * enforced *behaviourally*, not just claimed: `history-window.drift.test.ts`'s
 * R3 fails if this value and `PRICE_HISTORY_MAX_SPAN_YEARS` ever diverge
 * again, the way FR-24's first implementation silently let them.
 *
 * Deliberately **not** the same clamping behaviour, though: T-39's own AC
 * requires `GET /portfolios/:id/performance`'s `from`/`to` to be echoed back
 * *exactly* as requested ("start/end dates match the request parameters, not
 * a default range") — silently shifting an over-wide explicit range the way
 * `resolvePriceHistoryWindow` does would violate that AC the moment it
 * actually triggered. So here, an explicit range that is malformed (`from`
 * after `to`) or wider than {@link RETURN_WINDOW_MAX_SPAN_YEARS} is
 * **rejected** (400 `problem+json`), never rewritten — the same DoS bound,
 * reached by a different, AC-compatible mechanism.
 *
 * Raised 15 -> 25 alongside `PRICE_HISTORY_MAX_SPAN_YEARS` (FR-24).
 * Widens the worst-case per-request `materializePortfolioValuations`
 * fan-out (one row per calendar date in range) by the same ~67% the read
 * cap already carries — accepted because H1's absolute floor
 * ({@link RETURN_WINDOW_EPOCH_FLOOR}) already bounds the exploit class this
 * span cap defends against (an ancient-window sweep persisting unbounded
 * orphaned rows, T-39); this only raises the cost of a
 * single legitimate request against a portfolio whose own price history is
 * already up to 25 years deep, not the ceiling on how much history a sweep
 * of requests can touch in total.
 */
export const RETURN_WINDOW_DEFAULT_YEARS = 1;
export const RETURN_WINDOW_MAX_SPAN_YEARS = 25;

/**
 * H1 (security review) — bounding the *span* alone was not enough:
 * `RETURN_WINDOW_MAX_SPAN_YEARS` only bounds how *wide* an explicit range may
 * be, not *where in time* that (at most 15-year-wide) window may sit.
 * `materializePortfolioValuations` (`valuation/src/materialize.ts`) persists
 * one `portfolio_daily_valuation` row per calendar date in whatever range it
 * is asked to materialise, regardless of whether any transaction exists near
 * it, and those rows are only ever invalidated from `min(trade_date)`
 * forward — so a row dated before a
 * portfolio's earliest trade (or before the portfolio exists at all) is
 * never invalidated by anything. An empty portfolio plus a sweep of narrow
 * (<=15-year) windows across, say, years `0001`-`9999` would each pass the
 * old span-only check and each persist a permanent, orphaned row (the
 * "~666 requests -> ~3.65M rows" exploit this finding names). A `to` in the
 * future has the mirror problem: it persists today-priced rows dated ahead
 * of today, later served verbatim once that date actually arrives.
 *
 * The fixed lower bound {@link resolveReturnWindow} never lets a resolved
 * `from` fall below — a fixed calendar date rather than a per-portfolio
 * "first trade" lookup: simpler, and testable with no database at all, at
 * the cost of a small, deliberate, documented imprecision (a portfolio whose
 * first trade genuinely predates 2000 cannot be charted further back than
 * this floor). Phase 1's own FX/price history choices (ECB's `eurofxref-hist.csv` backfill) do not reach meaningfully
 * earlier than this either, so the floor costs nothing real today; a later,
 * strictly tighter per-portfolio "first trade" floor is a compatible future
 * refinement, not a breaking one.
 */
export const RETURN_WINDOW_EPOCH_FLOOR = "2000-01-01";

function shiftYears(isoDate: string, years: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

export interface ResolvedReturnWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * Resolves the effective `[from, to]` window for the overview/holdings/
 * performance endpoints' `?from=&to=` query (see this section's own doc
 * comment for why this rejects rather than clamps). `to` defaults to
 * `today`; `from` defaults to {@link RETURN_WINDOW_DEFAULT_YEARS} before the
 * effective `to`. `today` is an injectable parameter, purely for
 * deterministic testing (mirrors `resolvePriceHistoryWindow`'s own
 * parameter).
 *
 * H1 (security review): also enforces two **absolute** bounds against the
 * resolved `to`/`from` — `to` may never be after `today`, and `from` may
 * never be before {@link RETURN_WINDOW_EPOCH_FLOOR} — on top of the
 * pre-existing relative span cap. See {@link RETURN_WINDOW_EPOCH_FLOOR}'s own
 * doc comment for why. An explicit `to`/`from` outside these bounds is
 * rejected (400), matching this function's existing explicit-is-rejected
 * posture; a *defaulted* `from` that would fall below the floor is clamped
 * up to it instead, since a default is a computed value, never a requested
 * one.
 */
export function resolveReturnWindow(
  from: string | undefined,
  to: string | undefined,
  today: string = new Date().toISOString().slice(0, 10),
): ResolvedReturnWindow {
  const effectiveTo = to ?? today;

  if (effectiveTo > today) {
    throw problemException(400, {
      title: "Date range in the future",
      code: "DATE_RANGE_IN_FUTURE",
      detail: `to (${effectiveTo}) must not be after today (${today})`,
    });
  }
  if (effectiveTo < RETURN_WINDOW_EPOCH_FLOOR) {
    throw problemException(400, {
      title: "Date range too early",
      code: "DATE_RANGE_TOO_EARLY",
      detail: `to (${effectiveTo}) must not be before ${RETURN_WINDOW_EPOCH_FLOOR}`,
    });
  }

  if (from === undefined) {
    const defaultFrom = shiftYears(effectiveTo, -RETURN_WINDOW_DEFAULT_YEARS);
    const clampedFrom =
      defaultFrom < RETURN_WINDOW_EPOCH_FLOOR ? RETURN_WINDOW_EPOCH_FLOOR : defaultFrom;
    return { from: clampedFrom, to: effectiveTo };
  }
  if (from > effectiveTo) {
    throw problemException(400, {
      title: "Invalid date range",
      code: "INVALID_DATE_RANGE",
      detail: `from (${from}) must not be after to (${effectiveTo})`,
    });
  }
  if (from < RETURN_WINDOW_EPOCH_FLOOR) {
    throw problemException(400, {
      title: "Date range too early",
      code: "DATE_RANGE_TOO_EARLY",
      detail: `from (${from}) must not be before ${RETURN_WINDOW_EPOCH_FLOOR}`,
    });
  }
  const earliestAllowed = shiftYears(effectiveTo, -RETURN_WINDOW_MAX_SPAN_YEARS);
  if (from < earliestAllowed) {
    throw problemException(400, {
      title: "Date range too wide",
      code: "DATE_RANGE_TOO_WIDE",
      detail:
        `the requested range [${from}, ${effectiveTo}] exceeds the maximum span of ` +
        `${RETURN_WINDOW_MAX_SPAN_YEARS} years; narrow the range rather than widen the server's bound`,
    });
  }
  return { from, to: effectiveTo };
}

/**
 * `bigint` has no JSON representation (`JSON.stringify` throws on one) — every
 * `calcEpoch` crosses the API boundary as a decimal string, the same "never a
 * bare unrepresentable value" posture `zDecimal` takes for `Decimal`.
 *
 * Exported for `cash-accounts.schema.ts` (CA-16): `GET /portfolios/:id/cash`
 * carries the same epoch under FR-162, and a second local copy of this
 * one-liner is how two renderings of one convention come to disagree.
 */
export function serializeCalcEpoch(calcEpoch: bigint): string {
  return calcEpoch.toString();
}

function toTwrResponse(outcome: TwrOutcome): Record<string, unknown> {
  if (!outcome.available) {
    return { available: false, reasonCode: outcome.code, reason: outcome.reason };
  }
  return {
    available: true,
    cumulative: outcome.cumulative.toFixed(),
    annualised: outcome.annualised === null ? null : outcome.annualised.toFixed(),
    rangeDays: outcome.rangeDays,
    subPeriodCount: outcome.subPeriodCount,
  };
}

type MwrResult = PortfolioReturns["mwr"];

function toMwrResponse(result: MwrResult): Record<string, unknown> {
  if (!result.converged) {
    return { converged: false, reasonCode: result.code, reason: result.reason };
  }
  return {
    converged: true,
    rate: result.rate.toFixed(),
    method: result.method,
    iterations: result.iterations,
  };
}

/**
 * The `cash` block of the overview and holdings responses (portfolio-cash
 * FR-677, PC-L11): always present, `totalBase` `"0"` when there is
 * no cash. `totalBase` excludes any `unconverted` currency (PC-L2); a
 * currency's `rate`/`rateDate`/`valueBase` are `null` exactly when it is
 * unconverted, and `rateDate` is also `null` for the base currency (rate
 * `"1"`). `byCurrency` omits zero balances. Invariant, string-exact:
 * `totalValue.amount = Σ holdings[].currentValue.amount + totalBase`.
 */
export interface CashBlockResponse {
  readonly totalBase: string;
  readonly currency: string;
  readonly isNegative: boolean;
  readonly unconverted: readonly string[];
  readonly byCurrency: readonly {
    readonly currency: string;
    readonly amount: string;
    readonly rate: string | null;
    readonly rateDate: string | null;
    readonly valueBase: string | null;
  }[];
}

function toCashBlockResponse(holdings: ValuedPortfolioHoldings): CashBlockResponse {
  const { cash, baseCurrency } = holdings;
  return {
    totalBase: serializeDecimal(cash.totalValueBase),
    currency: baseCurrency,
    isNegative: cash.totalValueBase.isNegative() && !cash.totalValueBase.isZero(),
    unconverted: cash.unconverted,
    byCurrency: cash.byCurrency.map((line) => ({
      currency: line.currency,
      amount: serializeDecimal(line.amount),
      rate: line.rate === undefined ? null : serializeDecimal(line.rate),
      rateDate: line.rateObservedOn ?? null,
      valueBase: line.valueBase === undefined ? null : serializeDecimal(line.valueBase),
    })),
  };
}

/** `GET /portfolios/:id/overview` / `GET /portfolios/overview` response — AC24, FR-33/FR-34. Never a bare `return` number: always the labelled `{ twr, mwr }` pair. */
export interface OverviewResponse {
  readonly from: string;
  readonly to: string;
  readonly totalValue: ReturnType<typeof toValuedAmountResponse>;
  readonly unrealizedGainLoss: ReturnType<typeof toValuedAmountResponse>;
  /** FR-263: the dashboard tile's figure — same all-or-absent rule as the holdings total. */
  readonly dayChange?: ReturnType<typeof toValuedAmountResponse>;
  readonly return: {
    readonly twr: Record<string, unknown>;
    readonly mwr: Record<string, unknown>;
    readonly provenance: ReturnType<typeof toProvenanceSummaryResponse>;
  };
  /** portfolio-cash FR-677: the as-of cash `totalValue` includes. */
  readonly cash: CashBlockResponse;
  readonly calcEpoch: string;
  /** 1 for the per-portfolio route; the tenant's portfolio count for the combined route. */
  readonly portfolioCount: number;
}

export function toOverviewResponse(
  holdings: ValuedPortfolioHoldings,
  returns: PortfolioReturns,
): OverviewResponse {
  return {
    from: returns.from,
    to: returns.to,
    totalValue: toValuedAmountResponse(holdings.totalValue),
    unrealizedGainLoss: toValuedAmountResponse(holdings.totalUnrealizedGainLoss),
    ...(holdings.dayChange !== undefined
      ? { dayChange: toValuedAmountResponse(holdings.dayChange) }
      : {}),
    return: {
      twr: toTwrResponse(returns.twr),
      mwr: toMwrResponse(returns.mwr),
      provenance: toProvenanceSummaryResponse(returns.provenance),
    },
    cash: toCashBlockResponse(holdings),
    calcEpoch: serializeCalcEpoch(holdings.calcEpoch),
    portfolioCount: holdings.portfolioCount,
  };
}

/** `GET /portfolios/:id/performance` / combined-view TWR/MWR fragment — FR-25, FR-26, FR-30, FR-33. */
export interface PerformanceResponse {
  readonly from: string;
  readonly to: string;
  readonly return: {
    readonly twr: Record<string, unknown>;
    readonly mwr: Record<string, unknown>;
    readonly provenance: ReturnType<typeof toProvenanceSummaryResponse>;
  };
}

export function toPerformanceResponse(returns: PortfolioReturns): PerformanceResponse {
  return {
    from: returns.from,
    to: returns.to,
    return: {
      twr: toTwrResponse(returns.twr),
      mwr: toMwrResponse(returns.mwr),
      provenance: toProvenanceSummaryResponse(returns.provenance),
    },
  };
}

/**
 * `GET /portfolios/:id/value-series` / `GET /portfolios/value-series` —
 * FR-262 (the wire half of FR-36's chart). Points are the
 * materialised daily series verbatim: `value` is a decimal string in the
 * tenant's ledger base (`baseCurrency`), dense over `[from, to]` with
 * pre-first-trade dates carrying the modelled zero, and never interpolated
 * (an unpriceable date fails the whole read loud instead — the same 422 the
 * performance read raises). Points are deliberately **not** `ValuedAmount`
 * envelopes — a 25-year window is ~9,100 points, and per-point provenance
 * does not exist until AR-10's `input_digest`; the series-level
 * `provenance` summary carries what is honestly known, exactly as the
 * TWR/MWR pair's does.
 */
export interface ValueSeriesResponse {
  readonly from: string;
  readonly to: string;
  readonly baseCurrency: string;
  /**
   * `netContributions`: cumulative Σ DEPOSIT − Σ WITHDRAWAL in
   * `baseCurrency`, since inception, as of the same start-of-day pre-flow
   * instant as `value` — the Performance screen's « capital investi » line.
   */
  readonly points: readonly {
    readonly date: string;
    readonly value: string;
    readonly netContributions: string;
  }[];
  readonly provenance: ReturnType<typeof toProvenanceSummaryResponse>;
}

export function toValueSeriesResponse(series: PortfolioValueSeries): ValueSeriesResponse {
  return {
    from: series.from,
    to: series.to,
    baseCurrency: series.baseCurrency,
    points: series.points.map((point) => ({
      date: point.date,
      value: serializeDecimal(point.value),
      netContributions: serializeDecimal(point.netContributions),
    })),
    provenance: toProvenanceSummaryResponse(series.provenance),
  };
}

function toValuedRealizedGainResponse(gain: ValuedRealizedGain) {
  return {
    portfolioId: gain.portfolioId,
    tradeDate: gain.tradeDate,
    // L7 (security review): routed through the shared `serializeDecimal`
    // codec, like every other decimal this API returns — `Decimal#toFixed()`
    // (called directly, previously) is behaviourally identical for the value
    // itself, but this keeps a single, greppable codec boundary rather than
    // an ad hoc exception for quantity fields.
    quantitySold: serializeDecimal(gain.quantitySold),
    gainBase: toValuedAmountResponse(gain.gainBase),
    gainNative: toValuedAmountResponse(gain.gainNative),
    fxComponentBase: toValuedAmountResponse(gain.fxComponentBase),
    proceedsBase: toValuedAmountResponse(gain.proceedsBase),
  };
}

function toValuedHoldingResponse(holding: ValuedHolding) {
  return {
    instrumentId: holding.instrumentId,
    // Root-cause fix (tester's second
    // finding): additive field — a holding's own `kind`, so the client never
    // has to re-fetch it per instrument via `GET /instruments/:id`
    // (`HoldingHistoryStatus.tsx`'s now-removed `instrumentKindQueryOptions`
    // lookup, `web/src/lib/queries.ts`).
    kind: holding.kind,
    // OD-9(a) (UR-8): additive field, sourced the
    // same way `kind` immediately above was — the holdings table
    // (`web/src/components/HoldingsTable.tsx`) reads this directly instead of
    // joining an instrument name per row via `GET /instruments/:id`
    // (`web/e2e/holdings-history-status-request-volume.spec.ts`'s
    // `distinctKindRequests` stays pinned at 0).
    displayName: holding.displayName,
    // IR-12:
    // three additive fields, sourced exactly the way `kind`/`displayName`
    // above are — `valuation`'s own already-running `instrument` read, never a
    // per-row lookup from the client. `listingCountry` is **derived** from
    // `exchange_mic` inside `valuation`'s assembly step, which is why
    // `exchangeMic` is absent from this wire shape entirely.
    // The ticker, for the dashboard pie's slice labels — the
    // `displayName` precedent (UR-8): an `instrument` property the client would
    // otherwise fetch per holding. Nullable, never invented.
    symbol: holding.symbol,
    sectorCode: holding.sectorCode,
    domicileCountry: holding.domicileCountry,
    listingCountry: holding.listingCountry,
    // `instrument-icons` IK-10 (FR-313, FR-314): one more
    // additive field on the response this screen already issues, sourced by a
    // `LEFT JOIN` on `valuation`'s own already-running `instrument` read —
    // never a per-row "does this instrument have an icon?" request, which is
    // exactly what FR-313 forbids and what `holdings-history-status-request-
    // volume.spec.ts` could not have seen (it matches only two sub-paths).
    // A boolean, not a URL: the URL is `/instruments/{instrumentId}/icon` for
    // every tenant, so putting it on the wire would carry no information.
    hasIcon: holding.hasIcon,
    // L7 (security review): see `toValuedRealizedGainResponse`'s own comment.
    quantity: serializeDecimal(holding.quantity),
    currency: holding.currency,
    pmp: toValuedAmountResponse(holding.pmp),
    costBasis: toValuedAmountResponse(holding.costBasis),
    currentPrice: toValuedAmountResponse(holding.currentPrice),
    currentValue: toValuedAmountResponse(holding.currentValue),
    unrealizedGainLoss: toValuedAmountResponse(holding.unrealizedGainLoss),
    // FR-263: absent — never 0 — when no previous close exists;
    // the percent shares the amount's provenance and its absence.
    ...(holding.dayChange !== undefined
      ? { dayChange: toValuedAmountResponse(holding.dayChange) }
      : {}),
    ...(holding.dayChangePercent !== undefined
      ? { dayChangePercent: serializeDecimal(holding.dayChangePercent) }
      : {}),
    realizedGains: holding.realizedGains.map(toValuedRealizedGainResponse),
  };
}

/** `GET /portfolios/:id/holdings` / `GET /portfolios/holdings` response — AC25, FR-35, FR-27; AC10's combined-listing clause. */
export interface HoldingsResponse {
  readonly asOfDate: string;
  readonly holdings: readonly ReturnType<typeof toValuedHoldingResponse>[];
  readonly totalValue: ReturnType<typeof toValuedAmountResponse>;
  readonly totalUnrealizedGainLoss: ReturnType<typeof toValuedAmountResponse>;
  /** FR-263: present only when every holding's own dayChange is — partial sums are refused, see valuation's `sumDayChanges`. */
  readonly dayChange?: ReturnType<typeof toValuedAmountResponse>;
  /** portfolio-cash FR-677: the as-of cash `totalValue` includes. */
  readonly cash: CashBlockResponse;
  readonly calcEpoch: string;
  readonly portfolioCount: number;
}

export function toHoldingsResponse(holdings: ValuedPortfolioHoldings): HoldingsResponse {
  return {
    asOfDate: holdings.asOfDate,
    holdings: holdings.holdings.map(toValuedHoldingResponse),
    totalValue: toValuedAmountResponse(holdings.totalValue),
    totalUnrealizedGainLoss: toValuedAmountResponse(holdings.totalUnrealizedGainLoss),
    ...(holdings.dayChange !== undefined
      ? { dayChange: toValuedAmountResponse(holdings.dayChange) }
      : {}),
    cash: toCashBlockResponse(holdings),
    calcEpoch: serializeCalcEpoch(holdings.calcEpoch),
    portfolioCount: holdings.portfolioCount,
  };
}

/**
 * `GET /portfolios/:id/closed-positions` / `GET /portfolios/closed-positions`
 * (T-54), FR-321–FR-330.
 * The instruments this tenant now holds **zero** of, and what selling out of
 * them realized.
 *
 * **OD-5, and it is the whole point of this block:**
 * {@link toValuedRealizedGainResponse} and `valuedRealizedGainResponseSchema`
 * above are *referenced*, never modified. `RealizedGainResponse`'s bytes are
 * identical whether a leg arrives via `HoldingResponse.realizedGains` or via
 * `ClosedPositionResponse.realizedGains` — asserted, not asserted-in-prose, by
 * `portfolios.schema.closed-positions.test.ts`'s one-fixture-two-paths test.
 * The new `totalDisposedCostBasisBase` figure (FR-326) lives on this type
 * **only**; nothing above gained a field.
 *
 * Deliberately absent, mirroring `ValuedClosedPosition`'s own CP-9 omissions:
 * no `sectorCode`/`domicileCountry`/`listingCountry`, no `pmp`/`costBasis`, no
 * live-price figure of any kind, no `quantity`, no `saleLotCount`, no
 * view-level totals — and **no server-computed percentage string** (FR-327:
 * the wire carries `totalRealizedGainBase` and its denominator
 * `totalDisposedCostBasisBase`, and the client decides what a zero denominator
 * renders as).
 */
function toClosedPositionResponse(position: ValuedClosedPosition) {
  return {
    instrumentId: position.instrumentId,
    kind: position.kind,
    displayName: position.displayName,
    hasIcon: position.hasIcon,
    // CP-3/A2: the instrument's **listing** currency, the same source the open
    // holdings line labels its own native figures with — never a leg's
    // `txn_currency` (see `ValuedClosedPosition.currency`).
    currency: position.currency,
    totalRealizedGainBase: toValuedAmountResponse(position.totalRealizedGainBase),
    totalRealizedGainNative: toValuedAmountResponse(position.totalRealizedGainNative),
    totalFxComponentBase: toValuedAmountResponse(position.totalFxComponentBase),
    totalDisposedCostBasisBase: toValuedAmountResponse(position.totalDisposedCostBasisBase),
    // The existing, unedited mapper (OD-5) — in wire order, never re-sorted
    // here (FR-330: the ordering `@kerdial/valuation` produced is the
    // ordering the client renders).
    realizedGains: position.realizedGains.map(toValuedRealizedGainResponse),
  };
}

/** `GET /portfolios/:id/closed-positions` / `GET /portfolios/closed-positions` response — FR-321, FR-325, FR-326, FR-329, FR-330. Structurally the `HoldingsResponse` shape, minus the view-level totals a closed view deliberately has none of (CP-9). */
export interface ClosedPositionsResponse {
  readonly asOfDate: string;
  readonly closedPositions: readonly ReturnType<typeof toClosedPositionResponse>[];
  readonly calcEpoch: string;
  /** 1 for the per-portfolio route; the tenant's portfolio count for the combined route — the same field, computed the same way, as `HoldingsResponse`'s. */
  readonly portfolioCount: number;
}

export function toClosedPositionsResponse(view: ValuedClosedPositions): ClosedPositionsResponse {
  return {
    asOfDate: view.asOfDate,
    closedPositions: view.closedPositions.map(toClosedPositionResponse),
    calcEpoch: serializeCalcEpoch(view.calcEpoch),
    portfolioCount: view.portfolioCount,
  };
}
