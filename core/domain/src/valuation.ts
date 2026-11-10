/**
 * `valuePortfolio` / `resolvePrice` — portfolio-level mark-to-market valuation
 * (T-28). Values each open
 * holding in its native listing currency and converts to the caller-supplied
 * ledger base currency (OQ-3, ADR-0002/AR-5) using the FX rate resolved **for the valuation date** — this is
 * the "mark open positions to market" path (FR-29), deliberately distinct from
 * the transaction-pinned rate used for cost-basis/realized figures (FR-57).
 *
 * ## Pure and DB-free (D13)
 *
 * Like its sibling engines ({@link ./pmp.ts}, {@link ./realized-gains.ts}),
 * this module takes plain arrays of already-loaded records — the holding
 * states, the price series, the FX series — and returns a plain result: no
 * I/O, no database, no HTTP, no clock. `core/domain` may import nothing but
 * `core/decimal` (enforced by the `core-domain-purity` dependency-cruiser
 * rule), and this file imports only `Decimal` plus its own sibling types. In
 * particular `valuation` **cannot** import `market/ports`: a rate
 * reaching this engine is never fetched here, only resolved by LOCF over a
 * series the caller already loaded.
 *
 * ## Two distinct rate types, so they cannot be confused at a call site
 *
 * Rates reaching the engine come from either `transaction.fx_rate` (for
 * anything transaction-derived — FR-57) or `fx_rate_daily` resolved for a
 * *valuation* date (for marking open positions to market — FR-29). The two
 * paths are distinct types in the engine (`PinnedRate` vs `MarketRate`) so they
 * cannot be confused at a call site.
 *
 * This module gives those two paths **structurally incompatible** brands
 * ({@link MarketRate}, {@link PinnedRate}): a `MarketRate` cannot be passed
 * where a `PinnedRate` is expected, and vice versa, and neither accepts a bare
 * `Decimal` without going through its smart constructor. A plain type alias
 * (`type MarketRate = Decimal`) would be structurally identical and thus
 * useless here; the brand is what makes the mix-up a `tsc` error rather than a
 * silently-wrong number (part of what makes AC47 hold — see
 * `valuation.type.test.ts`). Only the *valuation* path is wired through
 * {@link MarketRate} in this module; the transaction-pinned path (T-24/T-25)
 * still threads a bare `Decimal`, so {@link PinnedRate} is introduced here
 * minimally as the counterpart brand and its smart constructor, without forcing
 * a churn through `pmp.ts`/`realized-gains.ts` (T-28 explicitly allows this —
 * "if the pinned-rate side already exists implicitly, introduce the brand
 * minimally and note it").
 *
 * ## Precision (NFR-12)
 *
 * Every arithmetic step is exact `Decimal` at 34 significant digits. The
 * 0.01% tolerance in T-28's AC is for the hand-calculated fixture comparison,
 * not a licence to lose internal precision.
 */
import { Decimal } from "@kerdial/core-decimal";
import { locf } from "./locf.js";
import type { HoldingState } from "./pmp.js";
import type { CurrencyCode, IsoDate } from "./types.js";

const ONE = new Decimal(1);
const ZERO = new Decimal(0);

// AR-5 (ADR-0002): the `BASE_CURRENCY` module constant that used
// to live here is deleted. The ledger base is a **per-tenant fact**
// (`tenant.base_currency`), so this pure, DB-free engine takes it as an
// explicit argument on every entry point that needs it — the only shape
// compatible with per-tenant bases, and what makes a known-answer fixture in
// a non-EUR base expressible. A holding already denominated in the given
// base needs no FX conversion — its market rate is exactly 1.

/**
 * A market FX rate resolved for a **valuation date** — the rate that marks an
 * open position to market (FR-29). Branded so it is structurally incompatible
 * with {@link PinnedRate}: the compiler rejects handing a valuation-date rate
 * to a transaction-derived call site and vice versa. The numeric value
 * is a native→base rate (`amount_base = amount_native × rate`).
 *
 * The brand is a phantom field that exists only in the type system — at runtime
 * a `MarketRate` is an ordinary `Decimal`. Construct one via {@link marketRate}
 * (or {@link resolveMarketRate}); a bare `Decimal` is not assignable to it.
 */
export type MarketRate = Decimal & { readonly __rateBrand: "MarketRate" };

/**
 * A transaction-pinned FX rate — the value resolved once at write time and
 * stored on the transaction (FR-57), used for cost-basis and realized-gain
 * figures. Branded structurally distinct from {@link MarketRate} so the two
 * cannot be swapped at a call site. Introduced here as the counterpart
 * to `MarketRate`; the existing PMP/realized-gain code (T-24/T-25) still uses a
 * bare `Decimal` for the pinned rate, and wiring this brand through it is left
 * out of T-28's scope on purpose (see this file's header).
 */
export type PinnedRate = Decimal & { readonly __rateBrand: "PinnedRate" };

/**
 * Brands a resolved `Decimal` as a {@link MarketRate}. The only sanctioned way
 * to obtain one — keeps the cast localized to this module rather than scattered
 * across call sites.
 */
export function marketRate(value: Decimal): MarketRate {
  return value as MarketRate;
}

/**
 * Brands a `Decimal` as a {@link PinnedRate}. Counterpart to {@link marketRate};
 * the transaction write/replay path is where a real one originates (T-18/T-24).
 */
export function pinnedRate(value: Decimal): PinnedRate {
  return value as PinnedRate;
}

/** Which table a resolved price came from (the two price sources). */
export type PriceOrigin = "MANUAL" | "DAILY";

/**
 * One dated price for an instrument, projected from either `manual_price_point`
 * (tenant-owned, FR-23/AC12 — `origin: "MANUAL"`) or `instrument_price_daily`
 * (shared reference data — `origin: "DAILY"`). Both sources are passed to
 * {@link resolvePrice} in a single array; `origin` carries the precedence
 * discriminator so a manually entered NAV can override an automated close
 * on the same date. The projection from stored rows to this shape is the caller's concern
 * (T-30 materialisation); this module owns only the resolution.
 */
export interface PricePoint {
  readonly instrumentId: string;
  /** The date the price was actually published (`observed_on`). */
  readonly observedOn: IsoDate;
  /** Price per unit, in `currency`. */
  readonly price: Decimal;
  readonly currency: CurrencyCode;
  /** Provenance (FR-24). */
  readonly sourceKey: string;
  readonly origin: PriceOrigin;
}

/**
 * The result of {@link resolvePrice}: the price that applies to a valuation
 * date, carrying which source and date it actually came from so the
 * `ValuedAmount` envelope and the provenance/staleness surfacing (AC29)
 * can be reconstructed downstream.
 */
export interface PriceObservation {
  readonly price: Decimal;
  readonly currency: CurrencyCode;
  readonly sourceKey: string;
  readonly origin: PriceOrigin;
  /** The date the returned price was published — may predate the valuation date (LOCF). */
  readonly observedOn: IsoDate;
}

/**
 * One dated FX rate observation, projected from `fx_rate_daily` (or the
 * per-tenant `fx_rate_user` table — either is a valuation-date market rate for
 * this path). `rate` converts `currency` to the base currency:
 * `amount_base = amount_native × rate`. The projection is the caller's
 * concern; this module resolves and brands.
 */
export interface FxRatePoint {
  /** The non-base currency this rate converts to the base currency. */
  readonly currency: CurrencyCode;
  /** The date the rate was published (`observed_on`). */
  readonly observedOn: IsoDate;
  /** native→base rate: `amount_base = amount_native × rate`. */
  readonly rate: Decimal;
}

/** The mark-to-market valuation of one open holding. */
export interface HoldingValuation {
  readonly instrumentId: string;
  readonly quantity: Decimal;
  /** The holding's native listing currency (from the resolved price). */
  readonly currency: CurrencyCode;
  /** The price that applied on the valuation date, with its provenance. */
  readonly price: PriceObservation;
  /** Value in the native currency: `quantity × price`. */
  readonly valueNative: Decimal;
  /** The valuation-date market rate used to convert to base (branded). */
  readonly rate: MarketRate;
  /** Value in the base currency: `valueNative × rate`. */
  readonly valueBase: Decimal;
}

/** The whole portfolio's mark-to-market valuation on a date. */
export interface PortfolioValuation {
  readonly date: IsoDate;
  readonly baseCurrency: CurrencyCode;
  readonly holdings: readonly HoldingValuation[];
  /** Σ over holdings of `valueBase`, exact — AC21's valuation half. */
  readonly totalValueBase: Decimal;
}

/**
 * Raised when a holding's price cannot be resolved for the valuation date —
 * neither a manual NAV nor an automated close exists on or before it. A
 * mark-to-market value with a missing price would be silently wrong, so this
 * fails loud (consistent with {@link ./pmp.ts}'s over-sell handling) rather
 * than fabricating a value or looking ahead. Note this is distinct from AC12's
 * "does not block on missing *automated* history": a manual-only holding
 * resolves fine (that is the whole point of the manual override), and only a
 * holding with *no* price at all reaches here.
 */
export class UnresolvablePriceError extends Error {
  readonly instrumentId: string;
  readonly valuationDate: IsoDate;

  constructor(instrumentId: string, valuationDate: IsoDate) {
    super(
      `Cannot value instrument ${instrumentId} on ${valuationDate}: no manual or automated ` +
        `price published on or before that date. Marking to market never looks ahead, ` +
        `so a holding with no prior price cannot be valued.`,
    );
    this.name = "UnresolvablePriceError";
    this.instrumentId = instrumentId;
    this.valuationDate = valuationDate;
  }
}

/**
 * Raised when a non-base-currency holding has no FX rate published on or before
 * the valuation date. Like {@link UnresolvablePriceError} this fails loud: a
 * base-currency conversion with a missing rate would silently misprice the
 * whole portfolio total.
 */
export class UnresolvableRateError extends Error {
  readonly currency: CurrencyCode;
  readonly valuationDate: IsoDate;

  constructor(currency: CurrencyCode, valuationDate: IsoDate, baseCurrency: CurrencyCode) {
    super(
      `Cannot convert ${currency} to ${baseCurrency} on ${valuationDate}: no FX rate published ` +
        `on or before that date. Valuation-date rates never look ahead (OQ-13).`,
    );
    this.name = "UnresolvableRateError";
    this.currency = currency;
    this.valuationDate = valuationDate;
  }
}

/**
 * Resolves the price applying to `instrumentId` on `date`, implementing this
 * precedence exactly:
 *
 * ```
 * manual_price_point(instrument, date)     -- highest precedence (FR-23 override)
 * else instrument_price_daily(instrument, date)
 * else LOCF: most recent prior date from either source (never look-ahead)
 * ```
 *
 * Realised as an LOCF over each source separately, then a precedence rule on the
 * two carried-forward candidates:
 *
 * - a **manual** point wins whenever it is at least as recent as the daily one
 *   (so on the valuation date itself, and on any shared date, the manual NAV
 *   overrides the automated close — FR-23);
 * - a **daily** point wins only when it is *strictly more recent* than the most
 *   recent manual point (never carry a stale manual NAV past a newer close).
 *
 * Never looks ahead: both candidates come from {@link locf}, which only ever
 * returns an observation dated on or before `date`. Returns `undefined` when no
 * price of either kind exists on or before `date` — the caller
 * ({@link valuePortfolio}) turns that into {@link UnresolvablePriceError}.
 *
 * A FUND with only a manually entered NAV (AC12) resolves via the manual
 * candidate alone — the absent automated series does not block it.
 */
export function resolvePrice(
  prices: readonly PricePoint[],
  instrumentId: string,
  date: IsoDate,
): PriceObservation | undefined {
  let bestManual: PricePoint | undefined;
  let bestDaily: PricePoint | undefined;

  // Single pass, LOCF per source: latest observedOn <= date for each origin.
  for (const point of prices) {
    if (point.instrumentId !== instrumentId) continue;
    if (point.observedOn > date) continue; // never look ahead
    if (point.origin === "MANUAL") {
      if (bestManual === undefined || point.observedOn >= bestManual.observedOn) {
        bestManual = point;
      }
    } else if (bestDaily === undefined || point.observedOn >= bestDaily.observedOn) {
      bestDaily = point;
    }
  }

  let chosen: PricePoint | undefined;
  if (bestManual !== undefined && bestDaily !== undefined) {
    // Manual overrides on ties and whenever at least as recent (FR-23); a daily
    // close wins only when strictly newer than the most recent manual NAV.
    chosen = bestManual.observedOn >= bestDaily.observedOn ? bestManual : bestDaily;
  } else {
    chosen = bestManual ?? bestDaily;
  }

  if (chosen === undefined) return undefined;
  return {
    price: chosen.price,
    currency: chosen.currency,
    sourceKey: chosen.sourceKey,
    origin: chosen.origin,
    observedOn: chosen.observedOn,
  };
}

/**
 * Resolves the valuation-date market FX rate converting `currency` to the base
 * currency, returning it **branded** as a {@link MarketRate}. A base-currency
 * holding needs no conversion — its rate is exactly 1. Otherwise the rate is
 * the most recent observation on or before `date` (via {@link locf}, so
 * weekend/holiday gaps carry Friday forward, OQ-13 — never look-ahead).
 *
 * Returns `undefined` when a non-base currency has no rate on or before `date`;
 * the caller turns that into {@link UnresolvableRateError}. This is the *market*
 * rate path — the returned value is a {@link MarketRate}, structurally
 * incompatible with a {@link PinnedRate}, so it cannot be handed to a
 * transaction-derived call site.
 */
export function resolveMarketRate(
  fxRates: readonly FxRatePoint[],
  currency: CurrencyCode,
  date: IsoDate,
  baseCurrency: CurrencyCode,
): MarketRate | undefined {
  if (currency === baseCurrency) return marketRate(ONE);

  const forCurrency = fxRates.filter((r) => r.currency === currency);
  const observation = locf(forCurrency, date, (r) => r.observedOn);
  if (observation === undefined) return undefined;
  return marketRate(observation.rate);
}

/**
 * Values a portfolio's open holdings on `date`, marking each to market
 * (FR-29). For each holding:
 *
 * 1. resolve its price via {@link resolvePrice} (manual-first precedence, LOCF, never
 *    look-ahead) — the price carries the holding's native currency;
 * 2. `valueNative = quantity × price`;
 * 3. resolve the valuation-date market rate via {@link resolveMarketRate}
 *    (branded {@link MarketRate}, never a transaction-pinned rate);
 * 4. `valueBase = valueNative × rate`.
 *
 * `totalValueBase` is the exact sum of every holding's `valueBase`. An
 * unresolvable price or rate fails loud ({@link UnresolvablePriceError} /
 * {@link UnresolvableRateError}) rather than silently mispricing the total.
 *
 * Pure and DB-free: the inputs are plain arrays the caller already loaded, and
 * the result is a fresh immutable {@link PortfolioValuation}.
 */
export function valuePortfolio(
  state: readonly HoldingState[],
  prices: readonly PricePoint[],
  fxRates: readonly FxRatePoint[],
  date: IsoDate,
  baseCurrency: CurrencyCode,
): PortfolioValuation {
  const holdings: HoldingValuation[] = [];
  let totalValueBase = ZERO;

  for (const holding of state) {
    const price = resolvePrice(prices, holding.instrumentId, date);
    if (price === undefined) {
      throw new UnresolvablePriceError(holding.instrumentId, date);
    }
    const rate = resolveMarketRate(fxRates, price.currency, date, baseCurrency);
    if (rate === undefined) {
      throw new UnresolvableRateError(price.currency, date, baseCurrency);
    }

    const valueNative = holding.quantity.times(price.price);
    const valueBase = valueNative.times(rate);
    totalValueBase = totalValueBase.plus(valueBase);

    holdings.push({
      instrumentId: holding.instrumentId,
      quantity: holding.quantity,
      currency: price.currency,
      price,
      valueNative,
      rate,
      valueBase,
    });
  }

  return {
    date,
    baseCurrency,
    holdings,
    totalValueBase,
  };
}
