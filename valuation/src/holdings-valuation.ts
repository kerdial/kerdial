import { Decimal } from "@kerdial/core-decimal";
import {
  computePmp,
  computeRealizedGains,
  locf,
  mergeProvenance,
  resolvePrice,
  summarizeProvenance,
  valueCash,
  valuePortfolio,
  type CashValuation,
  type CurrencyCode,
  type ProvenanceSummary,
  type DerivedFromFlag,
  type FxRatePoint,
  type IsoDate,
  type PositionTimeline,
  type PriceObservation,
  type PricePoint,
  type ProvenanceSummaryLeaf,
  type RealizedGain,
} from "@kerdial/core-domain";
// IR-12 (DD29): the
// listing country is **derived**, here, in the same assembly step that builds
// the holding — so `exchange_mic` itself never has to appear on the holdings
// wire shape, and the derivation stays the single expression
// `micToCountryCode` (the `instrument-create-ux` DD10 one-application-point
// rule). `core/api-contracts` is framework-free plain data (its own header),
// which is why depending on it here costs `valuation` nothing.
import { micToCountryCode } from "@kerdial/core-reference-data";
import {
  listPortfolios,
  loadPositionTimeline,
  type InstrumentKind,
  type InstrumentSectorCode,
} from "@kerdial/ledger";
import {
  instrument,
  instrumentIcon,
  portfolio,
  tenant,
  transaction,
  withTenant,
  type Db,
  type Tx,
} from "@kerdial/platform-db";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { loadCashAsOf, type CashAsOf } from "./cash-balances.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  fxProvenanceKey,
  loadPricingSeries,
  priceProvenanceKey,
  type DailyPriceQuality,
  type FxRateOrigin,
} from "./pricing-series.js";

/**
 * H2(b) (security review) — the bounded worker-pool width
 * `valueHoldingsForTenant` uses to fan out over a tenant's portfolios, via
 * `./concurrency.ts`'s `mapWithConcurrency`. 4 keeps a meaningful amount of
 * overlap (most of each call's cost is I/O-bound DB reads, not CPU, after
 * H2(c)'s restructuring) while bounding how many pooled connections one
 * tenant's request can hold at once against a pool whose `max` is 10
 * (`platform/db`) — shared, at that size, across every concurrent request
 * from every tenant.
 *
 * Package-internal export (see {@link ResponseCapOverrides}'s A1 note):
 * `./closed-positions-valuation.ts`'s own fan-out **reuses this value** rather
 * than declaring a second 4 that could later drift from it — the two fan-outs
 * contend for the same pool, so one number is the honest one.
 */
export const FAN_OUT_CONCURRENCY = 4;

/**
 * `valueHoldingsAsOf` / `valueHoldingsForTenant` — T-39. Backs `GET /portfolios/:id/holdings` and
 * `GET /portfolios/:id/overview`'s point-in-time figures (total value,
 * unrealized gain/loss), and their tenant-wide combined counterparts,
 * `GET /portfolios/holdings` / `GET /portfolios/overview` (added 2026-07-21
 * by user decision, T-39).
 *
 * ## Why this replays fresh rather than reading `holding_state`/`realized_gain`
 *
 * `holding_state`/`realized_gain` (T-30) are always kept in step with the
 * *latest* transaction timeline — `recomputeAndInvalidate` rewrites them
 * inside the same transaction as every write. That is
 * exactly right for "holdings as of now", but `GET /portfolios/:id/overview
 * ?to=` (and, transitively, this module) must also answer "holdings as of an
 * arbitrary past `to` date" — a snapshot `holding_state` cannot represent (it
 * has no history, only the current state). This module instead calls the
 * same pure engines those materialised tables are themselves built from
 * (`loadPositionTimeline`, `computePmp`, `computeRealizedGains`,
 * `valuePortfolio` — T-24/T-25/T-28, exactly `recomputeAndInvalidate`'s and
 * `materialize.ts`'s own composition), truncating the timeline to
 * `trade_date <= asOfDate`. This is deliberately the **same path**, not a
 * reimplementation: for `asOfDate = today` the result is numerically
 * identical to `holding_state`/`realized_gain`, and for any earlier date it
 * is the historically-correct generalisation those two tables do not store.
 * `portfolio_daily_valuation`'s own lazy materialise-on-read path (T-30,
 * `materializePortfolioValuations`) is untouched by this module — it remains
 * the sole owner of the calc-epoch-guarded daily series `./performance.ts`
 * feeds to `computeTwr`.
 *
 * ## Provenance — one `mergeProvenance` call per aggregation level
 *
 * A holding's `currentValue`/`unrealizedGainLoss` envelope carries the flags
 * its price and FX resolution actually earned (`MANUAL_PRICE`,
 * `DELAYED_QUOTE`, `PINNED_FX`, `CARRIED_FX`, `CRYPTO_QUOTE` — see
 * `#buildPriceFlags`/`#buildFxFlags` below); a holding's `pmp`/`costBasis`
 * envelope carries the flags its **contributing acquisition transactions'**
 * own stored `fx_rate_source` earned (`#mapFxRateSourceToFlags`) — PMP has no
 * live price dependency at all, so its provenance is entirely about how the
 * historical acquisitions' FX legs were resolved, not today's market data.
 * Every aggregate (a portfolio total, a combined cross-portfolio total) is
 * `mergeProvenance` over its constituents' already-computed flag sets —
 * never a bespoke union. See `@kerdial/core-domain`'s `mergeProvenance` for
 * the shared primitive and `#finalize`, immediately below, for the one
 * "default to `AUTOMATED` when nothing else applies" decision every figure's
 * assembly makes.
 */

const ZERO = new Decimal(0);

/** A figure derived from live price/FX data or historical cost-basis data — the pre-JSON-serialisation counterpart of the API's `ValuedAmount`. */
export interface FigureProvenance {
  readonly priceSource?: string;
  readonly priceQuality?: "REALTIME" | "DELAYED" | "MANUAL" | "EOD";
  readonly priceAsOf?: IsoDate;
  readonly priceIsStale?: boolean;
  readonly fxSource?: "USER_PINNED" | "PROVIDER" | "IMPLIED_BASE" | "QUOTE_PROVIDER";
  readonly fxRateObservedOn?: IsoDate;
  readonly derivedFrom: readonly DerivedFromFlag[];
  /**
   * AR-23 (ADR-0010): present on **aggregate** figures only — a
   * portfolio total, a combined cross-portfolio total — never on a leaf,
   * whose singular fields above are already the whole truth. Carries the
   * counters and source set a singular `priceSource`/`fxSource` cannot
   * honestly express for many inputs.
   */
  readonly summary?: ProvenanceSummary;
}

export interface ValuedFigure {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
  readonly provenance: FigureProvenance;
}

export interface ValuedRealizedGain {
  readonly portfolioId: string;
  readonly tradeDate: IsoDate;
  readonly quantitySold: Decimal;
  readonly gainBase: ValuedFigure;
  readonly gainNative: ValuedFigure;
  readonly fxComponentBase: ValuedFigure;
  readonly proceedsBase: ValuedFigure;
}

export interface ValuedHolding {
  readonly instrumentId: string;
  /**
   * `instrument.kind` (a root-cause fix from the `instrument-create-ux`
   * cycle's testing): previously absent from `ValuedHolding`/
   * `HoldingResponse` entirely, which forced the holdings screen to issue one
   * extra `GET /instruments/:id` per distinct holding just to learn it
   * (`web/src/components/HoldingHistoryStatus.tsx`'s now-removed
   * `instrumentKindQueryOptions` lookup). Loaded once per distinct
   * `instrumentId` alongside the rest of this module's own reads
   * (`loadHoldingsInputs`) rather than re-fetched through a separate
   * already-shipped route.
   */
  readonly kind: InstrumentKind;
  /**
   * `instrument.displayName` (OD-9(a), `ui-revamp` UR-8) —
   * loaded the same way and at the same call site as `kind` above (one join
   * against the already-fetched `instrument` row, `loadHoldingsInputs`), for
   * the identical reason: without this, `HoldingResponse` carries only
   * `instrumentId`, forcing the holdings table to re-fetch a name per
   * distinct holding via `GET /instruments/:id`
   * (`web/e2e/holdings-history-status-request-volume.spec.ts`'s own
   * `distinctKindRequests` measurement is what this keeps pinned at 0).
   */
  readonly displayName: string;
  /**
   * `instrument.symbol` — the local ticker (or crypto symbol),
   * `null` when the instrument has none. Read in the same `select()` as
   * `displayName` above, for the same reason: the dashboard's positions pie
   * labels its slices with the code, and the alternative is a per-holding
   * `GET /instruments/:id` from the client, which UR-8 spent a cycle removing.
   * `holdings.css`'s rule still holds on the tile — a monogram is never shown
   * *as* a ticker — but a real ticker from the instrument row is not invented.
   */
  readonly symbol: string | null;
  /**
   * `instrument.sector_code` (IR-12, DD29) — `null` for an unclassified instrument, which is a **normal**
   * state, not a defect (FR-3/FR-5). Read in the same `select()` as `kind` and
   * `displayName` above, over the same `instrumentIds` superset: this is the
   * `ui-revamp` OD-9 precedent applied a third time, so `web`'s exposure
   * breakdown regroups an already-fetched response instead of issuing a
   * per-holding classification lookup.
   */
  readonly sectorCode: InstrumentSectorCode | null;
  /** `instrument.domicile_country` — the issuer's country, `null` when unknown (FR-9). Same load site as {@link sectorCode}. */
  readonly domicileCountry: string | null;
  /**
   * Whether **this tenant** has uploaded an icon for this instrument
   * (IK-10; FR-313, FR-314). A boolean, and deliberately not a URL and not a
   * version token: the URL is derivable from `instrumentId` alone, and under
   * LD-6's `no-store` there is no cached copy a token could bust.
   *
   * Sourced by **one `LEFT JOIN` on the `instrument` read
   * `loadHoldingsInputs` already issues** — the same DD29 rule
   * `sectorCode`/`domicileCountry` above follow: a join adds columns, not
   * statements (the statement-count pin that once measured this was removed
   * in the test diet; NFR-91 is now measured on a clone). The alternative FR-313
   * explicitly forbids is a per-row "does this instrument have an icon?"
   * request, which is the pattern UR-8/UR-9 already spent a cycle removing.
   *
   * `bytes` is **never** selected on this path, so no TOAST detoast happens
   * for a screen that only needs to know whether to render a tile — which is
   * why presence is a joined boolean and not a `length(bytes)`.
   */
  readonly hasIcon: boolean;
  /**
   * **Derived, never stored** (FR-10): `micToCountryCode(exchange_mic)`,
   * applied in the assembly step so `exchangeMic` itself never reaches the
   * wire. `null` for a NULL MIC (CRYPTO) or an uncurated one.
   */
  readonly listingCountry: string | null;
  readonly quantity: Decimal;
  /** The holding's native listing currency (from the resolved price). */
  readonly currency: CurrencyCode;
  /** Weighted-average cost per unit, base currency (FR-27). Recomputed by division, never carried — see `core/domain/pmp.ts`. */
  readonly pmp: ValuedFigure;
  readonly costBasis: ValuedFigure;
  /** Native price per unit, in `currency` — no FX conversion, so its provenance never carries an `fxSource`. */
  readonly currentPrice: ValuedFigure;
  readonly currentValue: ValuedFigure;
  readonly unrealizedGainLoss: ValuedFigure;
  /**
   * FR-263 — the day change, **price-move only**: `quantity ×
   * (current price − previous close) × the current FX rate`. Flows never
   * read as day gains by construction, and FX's own day move is deliberately
   * excluded — FR-30 reports FX attribution as its own line, and mixing it
   * in here would double-report it. The previous close is resolved from the
   * SAME merged, precedence-ordered series the current price came from
   * (`resolvePrice` — manual over automated, LOCF, never look-ahead),
   * for the day before the current price's own observation date: on a
   * weekend the figure is the last session's move (Friday − Thursday), and
   * `priceAsOf` already tells the reader which session that was. Absent —
   * never zero — when no earlier observation exists (a first-ever price
   * point), and absent means the UI renders the unavailable state.
   */
  readonly dayChange?: ValuedFigure;
  /** The same move as a fraction of the previous close (native, so FX-free); shares {@link ValuedHolding.dayChange}'s provenance and its absence. */
  readonly dayChangePercent?: Decimal;
  /** Every disposal ever recorded against this instrument in this portfolio, up to `asOfDate` — empty when none occurred (FR-35). */
  readonly realizedGains: readonly ValuedRealizedGain[];
}

export interface ValuedPortfolioHoldings {
  readonly asOfDate: IsoDate;
  readonly baseCurrency: CurrencyCode;
  readonly holdings: readonly ValuedHolding[];
  /**
   * portfolio-cash (FR-677, PC-L11): the as-of cash, converted to
   * the base at the date's market rate (LOCF). A currency with no rate is in
   * `unconverted` and adds nothing (PC-L2). Empty when the caller asked for
   * `cash: "omit"` (the tenant fan-out, which values the tenant's cash once
   * itself).
   */
  readonly cash: CashValuation;
  /** `Σ holdings[].currentValue + cash.totalValueBase` (FR-678) — cash included, exactly. */
  readonly totalValue: ValuedFigure;
  readonly totalUnrealizedGainLoss: ValuedFigure;
  /**
   * FR-263: the sum of every holding's {@link ValuedHolding.dayChange} —
   * present only when **every** holding carries one (and at least one holding
   * exists). A total standing for "the portfolio's day move" computed from 9
   * of 10 holdings would be the recorded vacuous-green class; absent is the
   * honest state, and the UI renders it as such.
   */
  readonly dayChange?: ValuedFigure;
  /** The single portfolio's `calc_epoch` (T-30), or (for the combined tenant-wide view, `valueHoldingsForTenant`) the sum of every constituent portfolio's own epoch plus the portfolio count (security review finding L5) — see that function's own doc comment. */
  readonly calcEpoch: bigint;
  /** 1 for `valueHoldingsAsOf`; the tenant's portfolio count for `valueHoldingsForTenant`. */
  readonly portfolioCount: number;
}

/**
 * Security review finding L6 — a generous but firm cap on the size of a
 * holdings response, applied by rejecting rather than silently truncating
 * (the same reject-not-clamp posture `resolveReturnWindow`
 * (`api/src/portfolios/portfolios.schema.ts`) already takes for date ranges):
 * a caller that hits either cap gets a clear 4xx, never a multi-megabyte
 * response body or a silently incomplete one. 1,000 holdings and 1,000
 * realized-gain rows *per holding* comfortably exceed what any real
 * phase-1 portfolio holds (the 200-holding/5,000-transaction load-test
 * scale, NFR-10) while still bounding the
 * response Fastify/the client must serialise/parse.
 *
 * @public both are mirrored in `web/src/lib/api-limits.ts` and asserted against these definitions by `web/src/lib/api-limits.drift.test.ts` (OD-6), a cross-workspace deep import the unused-export gate does not scan.
 */
export const MAX_HOLDINGS_PER_VIEW = 1000;

/** @public see {@link MAX_HOLDINGS_PER_VIEW} — mirrored and drift-guarded from `web` the same way. */
export const MAX_REALIZED_GAINS_PER_HOLDING = 1000;

/** Thrown by {@link valueHoldingsAsOf}/{@link valueHoldingsForTenant} when a view's holding count exceeds {@link MAX_HOLDINGS_PER_VIEW} (security review finding L6). Mapped to a 4xx by the API layer, never a raw 500 or a silently truncated body. */
export class TooManyHoldingsError extends Error {
  readonly count: number;
  readonly limit: number;

  constructor(count: number, limit: number = MAX_HOLDINGS_PER_VIEW) {
    super(`This view would return ${count} holdings, exceeding the ${limit}-holding cap.`);
    this.name = "TooManyHoldingsError";
    this.count = count;
    this.limit = limit;
  }
}

/** Thrown when a single holding's realized-gain history exceeds {@link MAX_REALIZED_GAINS_PER_HOLDING} (security review finding L6). */
export class TooManyRealizedGainsError extends Error {
  readonly instrumentId: string;
  readonly count: number;
  readonly limit: number;

  constructor(instrumentId: string, count: number, limit: number = MAX_REALIZED_GAINS_PER_HOLDING) {
    super(
      `Instrument ${instrumentId} has ${count} realized gains in this view, exceeding the ${limit}-row cap.`,
    );
    this.name = "TooManyRealizedGainsError";
    this.instrumentId = instrumentId;
    this.count = count;
    this.limit = limit;
  }
}

/**
 * **A1, measured (T-48, `closed-positions`). The answer is in
 * two parts, and this note governs every package-internal export this module
 * grew for `./closed-positions-valuation.ts`** — {@link finalize},
 * {@link buildRealizedGain}, {@link LoadedHoldingsInputs},
 * {@link loadHoldingsInputs} and {@link FAN_OUT_CONCURRENCY}, **none** of which
 * is added to `valuation/src/index.ts`.
 *
 * Part 1: `pnpm unused-exports-gate` (knip; `knip.jsonc`'s `valuation`
 * workspace is `entry: src/index.ts`, `project: src/**\/*.ts`) does **not**
 * scan only the barrel. A scratch `export const scratchA1Probe = 1` added here,
 * with no importer anywhere, was reported (`Unused exports (1) …
 * holdings-valuation.ts:117`, exit 1).
 *
 * Part 2, which is the part that decides the design: the feared consequence
 * (that a package-internal export would trip the gate) does not follow. The **same** scratch export, imported by one sibling
 * module inside this package, is **not** reported (exit 0). knip flags an
 * export with *no* importer — not an export with no *cross-package* importer.
 * So widening a symbol the sibling actually imports keeps the gate green, and
 * the fallback once considered (relocating `assembleClosedPositions` into this file) is not
 * applied: it would have bought nothing and forced a `holdings-valuation ⇄
 * closed-positions-valuation` import cycle.
 *
 * The corollary is why {@link ResponseCapOverrides} immediately below is
 * **not** widened, though it was a fifth candidate: widening only pays for a
 * symbol that acquires an importer, and this one never does — the closed path
 * has its own *distinct* `ClosedPositionCapOverrides`, so nothing
 * outside this module would ever name it, and exporting it would be exactly the
 * dead export part 1 proves the gate catches.
 */
/** Test-only escape hatch for {@link assertWithinResponseCaps}'s two real constants — mirrors `upsertManualPricePoint`'s own `maxRowsPerTenant` parameter and `createPortfolio`'s own `maxPortfoliosPerTenant` parameter: a real 1,000-holding fixture is impractical to seed in a test, so both entry points accept an override. */
interface ResponseCapOverrides {
  readonly maxHoldings?: number;
  readonly maxRealizedGainsPerHolding?: number;
}

/** Enforces {@link MAX_HOLDINGS_PER_VIEW}/{@link MAX_REALIZED_GAINS_PER_HOLDING} (security review finding L6), or `overrides`' test-only replacements — called once by each of this module's two public entry points, after assembling the full `holdings` array (`valueHoldingsForTenant`'s own concatenation across portfolios is exactly the case a per-portfolio-only check would miss). */
function assertWithinResponseCaps(
  holdings: readonly ValuedHolding[],
  overrides?: ResponseCapOverrides,
): void {
  const maxHoldings = overrides?.maxHoldings ?? MAX_HOLDINGS_PER_VIEW;
  const maxRealizedGainsPerHolding =
    overrides?.maxRealizedGainsPerHolding ?? MAX_REALIZED_GAINS_PER_HOLDING;

  if (holdings.length > maxHoldings) {
    throw new TooManyHoldingsError(holdings.length, maxHoldings);
  }
  for (const holding of holdings) {
    if (holding.realizedGains.length > maxRealizedGainsPerHolding) {
      throw new TooManyRealizedGainsError(
        holding.instrumentId,
        holding.realizedGains.length,
        maxRealizedGainsPerHolding,
      );
    }
  }
}

/**
 * A figure set with nothing manual/pinned/delayed/carried/crypto-quote about
 * it defaults to `['AUTOMATED']` — the one place every figure's assembly
 * makes that call (see this module's header; `mergeProvenance` itself never
 * injects this default).
 */
/** Package-internal export — see {@link ResponseCapOverrides}'s A1 note. */
export function finalize(flags: readonly DerivedFromFlag[]): DerivedFromFlag[] {
  return flags.length === 0 ? ["AUTOMATED"] : [...flags];
}

/**
 * Security review finding M4: `priceIsStale` (and the `priceAsOf` it
 * qualifies) previously never reached an aggregate figure — `totalValue`/
 * `totalUnrealizedGainLoss` only ever carried `derivedFrom`, so a portfolio
 * whose *every* holding was stale still rendered with no staleness signal at
 * all (the serializer omits `undefined` fields, so the client read "fresh").
 *
 * The rule this applies at every aggregation level (a portfolio total over
 * its holdings, a combined cross-portfolio total over its per-portfolio
 * totals): the aggregate is stale if **any** constituent is, and its
 * `priceAsOf` is the **oldest** (earliest) constituent's — the single date
 * that most understates freshness, which is the conservative choice for a
 * user-facing staleness signal. A constituent with no `priceAsOf` at all
 * (there is nothing to price, e.g. a zero-holding portfolio) is skipped;
 * `undefined` is returned only when *no* constituent contributed a
 * `priceAsOf`, so the aggregate carries neither field rather than a
 * fabricated `false`/date.
 */
function aggregateStaleness(
  provenances: readonly Pick<FigureProvenance, "priceAsOf" | "priceIsStale">[],
): Pick<FigureProvenance, "priceAsOf" | "priceIsStale"> {
  let anyStale = false;
  let oldest: IsoDate | undefined;
  for (const p of provenances) {
    if (p.priceAsOf === undefined) continue;
    if (p.priceIsStale === true) anyStale = true;
    if (oldest === undefined || p.priceAsOf < oldest) oldest = p.priceAsOf;
  }
  return oldest === undefined ? {} : { priceAsOf: oldest, priceIsStale: anyStale };
}

/** Calendar days between two `YYYY-MM-DD` dates — the same `Date.UTC` technique `core/domain/twr.ts`/`xirr.ts` each independently use; not shared with them on purpose (see this module's own concerns, which are provenance, not return computation). */
function daysBetween(from: IsoDate, to: IsoDate): number {
  const epochDay = (date: IsoDate): number => {
    const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10));
    return Math.round(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
  };
  return epochDay(to) - epochDay(from);
}

/**
 * A price observation's `as_of` age past which it is flagged `priceIsStale`.
 * Deliberately generous enough to absorb a normal weekend/holiday
 * LOCF carry (2 days) without a false positive, while still catching a
 * genuine multi-day ingestion gap. NFR-1/NFR-2 pin the
 * *ingestion* cadence budget, not a per-figure staleness formula for this
 * specific envelope field — this constant is a documented local choice,
 * not a value pinned by any requirement.
 */
const STALE_AFTER_DAYS = 3;

/**
 * The equivalent staleness horizon for a **manual** price point (security
 * review finding L3). Manual prices previously never aged at all
 * (`priceIsStale: false`, unconditionally) — reasonable for a NAV entered
 * daily, but wrong for the common OPCVM/fund case where the user enters a
 * price only when the annual statement arrives and nothing is entered for
 * up to a year in between: a stale manual price should still eventually earn
 * the badge. 400 days (a little over one year) covers a normal annual NAV
 * cycle with margin, so a fund priced every year does not falsely flag, while
 * a manual price genuinely abandoned for more than a year does. This is this
 * task's own documented choice, not a value pinned elsewhere in the spec —
 * see {@link STALE_AFTER_DAYS}'s own doc comment for the equivalent automated
 * choice.
 */
const MANUAL_STALE_AFTER_DAYS = 400;

/** Package-internal export (for `watchlist`) — see {@link ResponseCapOverrides}'s A1 note. Widened, not edited. */
export interface PriceFlagResult {
  readonly flags: readonly DerivedFromFlag[];
  readonly priceQuality: "REALTIME" | "DELAYED" | "MANUAL" | "EOD";
  readonly priceSource: string;
  readonly priceAsOf: IsoDate;
  readonly priceIsStale: boolean;
}

/** `date` minus one calendar day, `YYYY-MM-DD` — mirrors `fx-rate-resolver.ts`'s `minusDays` idiom (UTC, integer arithmetic, no floats). */
/** Package-internal export (for `watchlist`) — see {@link ResponseCapOverrides}'s A1 note. Widened, not edited. */
export function dayBefore(date: IsoDate): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10) as IsoDate;
}

/**
 * Package-internal export (for `watchlist`) — see
 * {@link ResponseCapOverrides}'s A1 note. Widened, **not** edited:
 * `./watchlist-valuation.ts` reuses this body verbatim (and with it
 * {@link STALE_AFTER_DAYS}/{@link MANUAL_STALE_AFTER_DAYS}) so the watchlist
 * cannot declare a second answer to "is this price stale" (FR-344).
 */
export function buildPriceFlags(
  instrumentId: string,
  price: PriceObservation,
  asOfDate: IsoDate,
  priceQualityByKey: ReadonlyMap<string, DailyPriceQuality>,
): PriceFlagResult {
  if (price.origin === "MANUAL") {
    return {
      flags: ["MANUAL_PRICE"],
      priceQuality: "MANUAL",
      priceSource: price.sourceKey,
      priceAsOf: price.observedOn,
      // A manual entry is a deliberate point-in-time value, so it is given a
      // much longer horizon than an automated feed (see
      // `MANUAL_STALE_AFTER_DAYS`'s own doc comment) rather than never aging
      // at all.
      priceIsStale: daysBetween(price.observedOn, asOfDate) > MANUAL_STALE_AFTER_DAYS,
    };
  }

  const quality =
    priceQualityByKey.get(priceProvenanceKey(instrumentId, price.observedOn)) ?? "EOD";
  const flags: DerivedFromFlag[] = quality === "DELAYED" ? ["DELAYED_QUOTE"] : [];
  return {
    flags,
    priceQuality: quality,
    priceSource: price.sourceKey,
    priceAsOf: price.observedOn,
    priceIsStale: daysBetween(price.observedOn, asOfDate) > STALE_AFTER_DAYS,
  };
}

interface FxFlagResult {
  readonly flags: readonly DerivedFromFlag[];
  readonly fxSource: "PROVIDER" | "USER_PINNED";
  readonly fxRateObservedOn: IsoDate;
}

/**
 * Re-derives which `FxRatePoint` `resolveMarketRate` (`@kerdial/core-domain`,
 * called internally by `valuePortfolio`) chose, via the same `locf` call —
 * `resolveMarketRate` returns only the resolved rate value (branded
 * `MarketRate`), not which point produced it, so this recovers that point
 * without threading extra fields through T-28's already-reviewed types (see
 * this module's header). Returns `undefined` for a base-currency holding
 * (`resolveMarketRate` never consults `fxRates` for it at all — its rate is
 * always exactly 1).
 */
function buildFxFlags(
  currency: CurrencyCode,
  asOfDate: IsoDate,
  fxRates: readonly FxRatePoint[],
  fxOriginByKey: ReadonlyMap<string, FxRateOrigin>,
  baseCurrency: CurrencyCode,
): FxFlagResult | undefined {
  if (currency === baseCurrency) return undefined;

  const forCurrency = fxRates.filter((r) => r.currency === currency);
  const chosen = locf(forCurrency, asOfDate, (r) => r.observedOn);
  // Cannot happen for a holding `valuePortfolio` successfully valued: it
  // would have thrown `UnresolvableRateError` first. Defensive fallback only.
  if (chosen === undefined) {
    return { flags: [], fxSource: "PROVIDER", fxRateObservedOn: asOfDate };
  }

  const origin = fxOriginByKey.get(fxProvenanceKey(currency, chosen.observedOn)) ?? "PROVIDER";
  const flags: DerivedFromFlag[] = [];
  if (origin === "USER_PINNED") flags.push("PINNED_FX");
  if (chosen.observedOn !== asOfDate) flags.push("CARRIED_FX");
  return { flags, fxSource: origin, fxRateObservedOn: chosen.observedOn };
}

/**
 * Maps a `transaction.fx_rate_source` value (`platform/db`'s
 * `fx_rate_source` enum: `USER_PINNED` | `PROVIDER` | `IMPLIED_BASE` |
 * `QUOTE_PROVIDER`) to the `derivedFrom` flag(s) it earns. `PROVIDER` and
 * `IMPLIED_BASE` are both a plain automated conversion (a market rate, or "no
 * conversion needed") and earn no special flag of their own — `AUTOMATED`
 * applies at the top of the figure's assembly if nothing else does either.
 * `core/domain` cannot import `platform/db`'s enum type (the purity rule),
 * so this takes a plain string, mirroring `platform/db`'s own values
 * by convention rather than by import.
 */
/** Exported for `performance.ts` (AR-24): a flow's stored `fx_rate_source` maps to flags through this one function, the same mapping every holding figure already uses. */
export function mapFxRateSourceToFlags(source: string): DerivedFromFlag[] {
  if (source === "USER_PINNED") return ["PINNED_FX"];
  if (source === "QUOTE_PROVIDER") return ["CRYPTO_QUOTE"];
  return [];
}

/** Package-internal export — see {@link ResponseCapOverrides}'s A1 note. Reused verbatim by `./closed-positions-valuation.ts` (FR-323/FR-329): one disposal leg serialises identically whichever surface reaches it. */
export function buildRealizedGain(
  portfolioId: string,
  gain: RealizedGain,
  currency: CurrencyCode,
  fxRateSourceByTxnId: ReadonlyMap<string, string>,
  transactionIdBySeq: ReadonlyMap<bigint, string>,
  baseCurrency: CurrencyCode,
): ValuedRealizedGain {
  const txnId = transactionIdBySeq.get(gain.seq);
  const source = txnId !== undefined ? fxRateSourceByTxnId.get(txnId) : undefined;
  const provenance: FigureProvenance = {
    derivedFrom: finalize(source !== undefined ? mapFxRateSourceToFlags(source) : []),
  };
  return {
    portfolioId,
    tradeDate: gain.tradeDate,
    quantitySold: gain.quantitySold,
    gainBase: { amount: gain.gainBase, currency: baseCurrency, provenance },
    gainNative: { amount: gain.gainNative, currency, provenance },
    fxComponentBase: { amount: gain.fxComponentBase, currency: baseCurrency, provenance },
    proceedsBase: { amount: gain.proceedsBase, currency: baseCurrency, provenance },
  };
}

export interface ValueHoldingsAsOfParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** Inclusive — holdings/gains reflect every transaction with `trade_date <= asOfDate`. */
  readonly asOfDate: IsoDate;
  /**
   * portfolio-cash: `"include"` (the default) loads and
   * values this portfolio's as-of cash and adds it to `totalValue`;
   * `"omit"` skips the cash statement entirely and returns an empty `cash` —
   * for {@link valueHoldingsForTenant}, which values the whole tenant's cash in
   * one grouped statement instead of N.
   */
  readonly cash?: "include" | "omit";
  /** L6 (security review) test-only override — see {@link ResponseCapOverrides}. */
  readonly responseCapOverrides?: ResponseCapOverrides;
}

/**
 * Values one portfolio's open holdings, cost basis, and realized-gain
 * history as of `asOfDate` — the shared engine behind
 * `GET /portfolios/:id/holdings` and the point-in-time half of
 * `GET /portfolios/:id/overview` (T-39). See this module's
 * header for why this replays rather than reading `holding_state`/
 * `realized_gain` directly.
 */
/** Everything {@link valueHoldingsAsOf}'s `withTenant` transaction reads, and nothing it computes — see this function's own doc comment (security review finding H2(c)) for why the split lands exactly here. */
/**
 * The three `instrument` columns IR-12 adds to {@link loadHoldingsInputs}'s
 * existing `inArray` read, plus IK-10's one joined boolean. `exchangeMic` is
 * carried **only** as far as {@link assembleHoldings}, which turns it into
 * `listingCountry` and drops it — it is an input to a derivation, not a field
 * of the response.
 */
interface InstrumentReferenceColumns {
  /** The ticker, loaded by the same `select()`; `null` when the instrument has none. */
  readonly symbol: string | null;
  readonly sectorCode: InstrumentSectorCode | null;
  readonly domicileCountry: string | null;
  readonly exchangeMic: string | null;
  /** `instrument-icons` IK-10: not an `instrument` column at all but a `LEFT JOIN`ed presence flag, carried here because it is loaded by the same `select()` and consumed at the same assembly site. */
  readonly hasIcon: boolean;
}

/**
 * The one derivation site in this module (FR-10): a MIC
 * becomes a listing country, and nothing else ever does. Total — an absent
 * row, a NULL MIC and an uncurated MIC all give `null`, never a throw and
 * never a fabricated country.
 */
function listingCountryOf(reference: InstrumentReferenceColumns | undefined): string | null {
  const mic = reference?.exchangeMic;
  if (mic === null || mic === undefined) return null;
  return micToCountryCode(mic) ?? null;
}

/** Package-internal export — see {@link ResponseCapOverrides}'s A1 note. */
export interface LoadedHoldingsInputs {
  /**
   * The tenant's ledger base currency, read from `tenant.base_currency`
   * inside the same transaction as every other input (ADR-0002/AR-5): the
   * engine takes it as an argument now, and this loader is where the
   * per-tenant fact enters the valuation path.
   */
  readonly baseCurrency: CurrencyCode;
  readonly calcEpoch: bigint;
  readonly timeline: PositionTimeline;
  readonly transactionIdBySeq: ReadonlyMap<bigint, string>;
  readonly prices: readonly PricePoint[];
  readonly fxRates: readonly FxRatePoint[];
  readonly priceQualityByKey: ReadonlyMap<string, DailyPriceQuality>;
  readonly fxOriginByKey: ReadonlyMap<string, FxRateOrigin>;
  /** `instrument.kind`, keyed by `instrumentId` — every instrument this portfolio ever traded (same superset `instrumentIds` below already scopes the pricing-series load to). */
  readonly kindByInstrumentId: ReadonlyMap<string, InstrumentKind>;
  /** `instrument.displayName` (UR-8), keyed by `instrumentId` — loaded in the same query as `kindByInstrumentId` above, over the same `instrumentIds` superset. */
  readonly displayNameByInstrumentId: ReadonlyMap<string, string>;
  /** `instrument`'s reference/classification columns (IR-12), keyed by `instrumentId` — loaded in that **same** query too (DD29: zero extra round trips). */
  readonly referenceByInstrumentId: ReadonlyMap<string, InstrumentReferenceColumns>;
  /**
   * `instrument.listing_currency` (`closed-positions` CP-3/A2),
   * keyed by `instrumentId` — **one more column on the same `select()`** the
   * three IR-12 columns and IK-10's joined boolean already ride, so the DD29
   * rule holds (a join adds columns, not statements).
   *
   * Read **only** by `./closed-positions-valuation.ts`, which has no
   * `valuePortfolio` result to take a native currency off and must not label a
   * closed position's `gainNative` with any single leg's `txn_currency`
   * (deliberately free of the listing currency, FR-55/AC44).
   * {@link assembleHoldings} does not read it: the open path's
   * `ValuedHolding.currency` still comes from `valuePortfolio`, unchanged.
   */
  readonly listingCurrencyByInstrumentId: ReadonlyMap<string, CurrencyCode>;
  /** The as-of cash (`loadCashAsOf`), present iff the load ran `withCash`. */
  readonly cash?: CashAsOf;
  /** Every transaction row this portfolio has dated on or before `asOfDate` (superset of what either provenance lookup below needs — see this function's own header). */
  readonly transactionRows: readonly {
    readonly id: string;
    readonly instrumentId: string | null;
    readonly kind: string;
    readonly fxRateSource: string;
  }[];
}

/**
 * H2(c) (security review) — the one DB-reading half of
 * {@link valueHoldingsAsOf}, run inside `withTenant`'s transaction. Loads
 * `calc_epoch` (the T-30 version this response is stamped with — this read
 * stays inside the transaction, alongside every other read, per this
 * function's own "keep queries in one tx" note below), the position
 * timeline, the pricing series, and every transaction row up to `asOfDate` —
 * nothing here calls `computePmp`/`computeRealizedGains`/`valuePortfolio` or
 * builds a single `ValuedHolding`. `instrumentIds` for the pricing-series
 * load is derived directly from `timeline` (every instrument this portfolio
 * ever traded, mirroring `materialize.ts`'s own convention) rather than from
 * `computePmp`'s output (only *currently held* instruments) — a strict
 * superset, and deliberately so: it decouples the pricing-series read from a
 * pure-compute step this function no longer runs, at the cost of loading a
 * handful of prices for fully-divested instruments nothing downstream reads.
 * The `transactionRows` read is similarly widened from this function's
 * original two separate, narrower queries (one for PMP-provenance
 * acquisitions, one for realized-gain-provenance disposals, the second keyed
 * by transaction ids `computeRealizedGains`'s *output* would otherwise have
 * to supply) into one unfiltered-by-`kind` read — removing the same
 * pure-compute-gates-a-read dependency for realized gains, and incidentally
 * turning two round trips into one.
 */
/** Package-internal export — see {@link ResponseCapOverrides}'s A1 note. Reused **unforked** by `./closed-positions-valuation.ts` (CP-2): its `instrumentIds` superset is "every instrument this portfolio ever traded", which is exactly the closed path's subject. */
export async function loadHoldingsInputs(
  tx: Tx,
  params: ValueHoldingsAsOfParams,
  options: {
    /**
     * portfolio-cash: load this portfolio's as-of cash (one
     * statement) and the FX its non-base currencies need, in the same
     * pricing-series load. `false` for closed positions, which value no cash,
     * and for the tenant fan-out, which loads the tenant's cash once.
     */
    readonly withCash: boolean;
  },
): Promise<LoadedHoldingsInputs> {
  const { tenantId, portfolioId, asOfDate } = params;

  const [portfolioRow] = await tx
    .select({ calcEpoch: portfolio.calcEpoch })
    .from(portfolio)
    .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)));
  const calcEpoch = portfolioRow?.calcEpoch ?? 0n;

  // AR-5: the ledger base is the tenant's, not a constant. A missing tenant
  // row here is the same data-integrity impossibility the write factory
  // treats it as — fail loud rather than value against a guessed base.
  const [tenantRow] = await tx
    .select({ baseCurrency: tenant.baseCurrency })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!tenantRow) {
    throw new Error(`loadHoldingsInputs: no tenant row for ${tenantId}`);
  }
  const baseCurrency = tenantRow.baseCurrency as CurrencyCode;

  const { timeline, transactionIdBySeq } = await loadPositionTimeline(tx, tenantId, portfolioId);

  // Every instrument this portfolio ever traded, on or before `asOfDate` —
  // see this function's own header for why this (not `computePmp`'s output)
  // is what the pricing-series load is scoped to.
  const instrumentIds = [
    ...new Set(
      timeline
        .filter((event) => event.txn.tradeDate <= asOfDate)
        .map((event) => event.txn.instrumentId),
    ),
  ];
  // portfolio-cash: as-of postings, not `cash_balance` — one
  // grouped statement, before the pricing load so its currencies' FX rides
  // the same FX statement as the holdings'.
  const cash = options.withCash
    ? await loadCashAsOf(tx, { tenantId, portfolioId, asOfDate })
    : undefined;

  const { prices, fxRates, priceQualityByKey, fxOriginByKey } = await loadPricingSeries(tx, {
    tenantId,
    baseCurrency,
    instrumentIds,
    toDate: asOfDate,
    ...(cash === undefined ? {} : { cashCurrencies: cash.firstPostingDates }),
  });

  // Root-cause fix (from the `instrument-create-ux` cycle's testing): `kind`
  // is loaded once here, alongside the module's other reads,
  // rather than left for the client to re-fetch per holding via
  // `GET /instruments/:id`. `instrument` carries no `tenant_id` (shared
  // catalogue, `platform/db/src/schema/instrument.ts`'s own doc comment), so
  // this is a plain `inArray` lookup, no `withTenant` scoping needed.
  const kindByInstrumentId = new Map<string, InstrumentKind>();
  // UR-8 (OD-9(a)): `displayName` is read alongside `kind` in this same
  // query, over the same `instrumentIds` superset — zero extra round trips.
  const displayNameByInstrumentId = new Map<string, string>();
  // IR-12 (DD29): `sector_code`, `domicile_country` and
  // `exchange_mic` join the **same** `select()` — three more columns on a
  // query that already runs, never a fourth round trip and never a per-row
  // client-side resolver. (The statement-count pin that guarded this was
  // removed in the test diet; NFR-91 is measured on a clone instead.)
  const referenceByInstrumentId = new Map<string, InstrumentReferenceColumns>();
  // `closed-positions` CP-3/A2: `listing_currency` is a **fifth
  // column on this same `select()`**, for the same DD29 reason — see
  // {@link LoadedHoldingsInputs.listingCurrencyByInstrumentId}. Nothing on the
  // open-holdings path reads it.
  const listingCurrencyByInstrumentId = new Map<string, CurrencyCode>();
  if (instrumentIds.length > 0) {
    const instrumentRows = await tx
      .select({
        id: instrument.id,
        kind: instrument.kind,
        displayName: instrument.displayName,
        // The ticker for the positions pie's slice labels — one
        // more column on the read that already runs (DD29), no new statement.
        symbol: instrument.symbol,
        sectorCode: instrument.sectorCode,
        domicileCountry: instrument.domicileCountry,
        exchangeMic: instrument.exchangeMic,
        // `closed-positions` CP-3/A2 (T-48).
        listingCurrency: instrument.listingCurrency,
        // `instrument-icons` IK-10 (FR-313/FR-314): **presence,
        // never bytes.** One more column on the query that already runs — the
        // same DD29 rule the three IR-12 columns above follow, so the
        // statement count this module issues is unchanged and the Positions
        // screen needs no per-row probe. `bytes` is deliberately not selected,
        // so nothing here detoasts a 256 KiB value to answer a boolean.
        hasIcon: sql<boolean>`(${instrumentIcon.instrumentId} is not null)`,
      })
      .from(instrument)
      // `LEFT JOIN`, so an instrument with no icon is still a row (an inner
      // join would silently drop every un-iconed holding — the failure this
      // shape cannot have). There is deliberately **no** `tenant_id` predicate
      // in the SQL: `loadHoldingsInputs` runs inside `withTenant`, so
      // `instrument_icon`'s RLS policy supplies
      // `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
      // and scopes the joined side to the caller's own tenant. Measured, with
      // 500 rows for this tenant and 520 for another present: the visible join
      // yields 10 of 30, never 40.
      //
      // **A4, settled by measurement, and it is NOT the predicted plan.** The
      // prediction was an index lookup per outer row on
      // the primary key. `EXPLAIN (ANALYZE, BUFFERS)` on a 30-holding fixture
      // at SD-5's 500-row ceiling actually gives a **Hash Right Join over a
      // sequential scan of `instrument_icon`** — one pass over a 14-page
      // relation, 23 shared buffer hits and ~0.7 ms for the whole join — with
      // the RLS predicate applied as a Filter rather than as an index
      // qualifier. That is *cheaper* than the predicted shape (O(relation),
      // not O(holdings x lookup)), because the relation is bounded to a few
      // pages by the FR-302 cap. The named fallback — an index on
      // `(instrument_id)` alone — was created and re-measured: the plan is
      // **identical**, same node types, same 23 buffers, same time. The
      // planner does not take it, so it is not added; adding it would cost a
      // second index on every icon write and buy nothing.
      .leftJoin(instrumentIcon, eq(instrumentIcon.instrumentId, instrument.id))
      .where(inArray(instrument.id, instrumentIds));
    for (const row of instrumentRows) {
      kindByInstrumentId.set(row.id, row.kind as InstrumentKind);
      displayNameByInstrumentId.set(row.id, row.displayName);
      referenceByInstrumentId.set(row.id, {
        symbol: row.symbol,
        sectorCode: row.sectorCode,
        domicileCountry: row.domicileCountry,
        exchangeMic: row.exchangeMic,
        hasIcon: row.hasIcon,
      });
      listingCurrencyByInstrumentId.set(row.id, row.listingCurrency as CurrencyCode);
    }
  }

  const transactionRows = await tx
    .select({
      id: transaction.id,
      instrumentId: transaction.instrumentId,
      kind: transaction.kind,
      fxRateSource: transaction.fxRateSource,
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.portfolioId, portfolioId),
        // L2 (security review): truncated to `asOfDate` — a transaction dated
        // after a historical `asOfDate` has not happened yet from this
        // view's perspective, so its FX-leg provenance must not contaminate
        // this snapshot's PMP/realized-gain flags.
        lte(transaction.tradeDate, asOfDate),
      ),
    );

  return {
    baseCurrency,
    calcEpoch,
    timeline,
    transactionIdBySeq,
    prices,
    fxRates,
    priceQualityByKey,
    fxOriginByKey,
    ...(cash === undefined ? {} : { cash }),
    transactionRows,
    kindByInstrumentId,
    displayNameByInstrumentId,
    referenceByInstrumentId,
    listingCurrencyByInstrumentId,
  };
}

/**
 * H2(c) (security review) — the pure-compute half of
 * {@link valueHoldingsAsOf}, run *after* `withTenant`'s transaction has
 * already closed (so the pooled connection it held is released before any of
 * this runs): `computePmp`/`computeRealizedGains`/`valuePortfolio` and the
 * whole per-holding provenance assembly, none of which touches the database.
 * Takes exactly what {@link loadHoldingsInputs} read, nothing more.
 */
function assembleHoldings(
  loaded: LoadedHoldingsInputs,
  params: ValueHoldingsAsOfParams,
): ValuedPortfolioHoldings {
  const { portfolioId, asOfDate } = params;
  const {
    baseCurrency,
    calcEpoch,
    timeline,
    transactionIdBySeq,
    prices,
    fxRates,
    priceQualityByKey,
    fxOriginByKey,
    transactionRows,
    kindByInstrumentId,
    displayNameByInstrumentId,
    referenceByInstrumentId,
  } = loaded;

  const truncated = timeline.filter((event) => event.txn.tradeDate <= asOfDate);
  const holdingStates = computePmp(truncated);
  const gains = computeRealizedGains(truncated);

  const valuation = valuePortfolio(holdingStates, prices, fxRates, asOfDate, baseCurrency);
  const valuationByInstrument = new Map(valuation.holdings.map((h) => [h.instrumentId, h]));

  const pmpFlagsByInstrument = new Map<string, DerivedFromFlag[]>();
  for (const row of transactionRows) {
    if (row.instrumentId === null) continue;
    if (row.kind !== "BUY" && row.kind !== "DRIP") continue;
    const existing = pmpFlagsByInstrument.get(row.instrumentId) ?? [];
    pmpFlagsByInstrument.set(
      row.instrumentId,
      mergeProvenance([existing, mapFxRateSourceToFlags(row.fxRateSource)]),
    );
  }
  // Every loaded row's own FX-leg provenance, keyed by id — a superset of
  // what `buildRealizedGain` below actually looks up (only disposal-related
  // ids), which is exactly what removes this map's construction from
  // depending on `computeRealizedGains`'s output (see `loadHoldingsInputs`'s
  // own header).
  const fxRateSourceByTxnId = new Map(transactionRows.map((r) => [r.id, r.fxRateSource]));

  const holdings: ValuedHolding[] = [];
  for (const state of holdingStates) {
    const val = valuationByInstrument.get(state.instrumentId);
    // `valuePortfolio` values every entry of `holdingStates` or throws —
    // never silently drops one.
    if (val === undefined) continue;

    const priceFlags = buildPriceFlags(state.instrumentId, val.price, asOfDate, priceQualityByKey);
    const fxFlags = buildFxFlags(val.currency, asOfDate, fxRates, fxOriginByKey, baseCurrency);

    const currentPriceProvenance: FigureProvenance = {
      priceSource: priceFlags.priceSource,
      priceQuality: priceFlags.priceQuality,
      priceAsOf: priceFlags.priceAsOf,
      priceIsStale: priceFlags.priceIsStale,
      derivedFrom: finalize(priceFlags.flags),
    };

    const valueFlagSet = mergeProvenance([priceFlags.flags, fxFlags?.flags ?? []]);
    const currentValueProvenance: FigureProvenance = {
      priceSource: priceFlags.priceSource,
      priceQuality: priceFlags.priceQuality,
      priceAsOf: priceFlags.priceAsOf,
      priceIsStale: priceFlags.priceIsStale,
      ...(fxFlags !== undefined
        ? { fxSource: fxFlags.fxSource, fxRateObservedOn: fxFlags.fxRateObservedOn }
        : {}),
      derivedFrom: finalize(valueFlagSet),
    };

    const pmpFlagSet = pmpFlagsByInstrument.get(state.instrumentId) ?? [];
    const pmpProvenance: FigureProvenance = { derivedFrom: finalize(pmpFlagSet) };

    const unrealizedGainLossAmount = val.valueBase.minus(state.costBasisBase);
    const unrealizedFlagSet = mergeProvenance([valueFlagSet, pmpFlagSet]);
    const unrealizedProvenance: FigureProvenance = {
      ...currentValueProvenance,
      derivedFrom: finalize(unrealizedFlagSet),
    };

    // FR-263: the previous close, from the same precedence-resolved
    // series as the current price — see ValuedHolding.dayChange's contract.
    const previous = resolvePrice(prices, state.instrumentId, dayBefore(val.price.observedOn));
    let dayChange: ValuedFigure | undefined;
    let dayChangePercent: Decimal | undefined;
    if (previous !== undefined) {
      const deltaNative = val.price.price.minus(previous.price);
      const previousFlags = buildPriceFlags(
        state.instrumentId,
        previous,
        asOfDate,
        priceQualityByKey,
      );
      dayChange = {
        amount: state.quantity.times(deltaNative).times(val.rate),
        currency: baseCurrency,
        provenance: {
          // The figure's own staleness/source fields are the CURRENT price's
          // (the previous close being older is its nature, not staleness);
          // the flag set folds in the previous observation's flags too, so a
          // manual previous close badges the day change as manual (an FR-263
          // acceptance criterion).
          ...currentValueProvenance,
          derivedFrom: finalize(
            mergeProvenance([priceFlags.flags, previousFlags.flags, fxFlags?.flags ?? []]),
          ),
        },
      };
      dayChangePercent = deltaNative.dividedBy(previous.price);
    }

    const holdingGains = gains
      .filter((g) => g.instrumentId === state.instrumentId)
      .map((g) =>
        buildRealizedGain(
          portfolioId,
          g,
          // val.currency (the market quote currency)
          // was only ever a fallback for the acquisition-mixed case;
          // g.nativeCurrency is the leg's own actual trade currency and is
          // always present when nativeCurrencyMixed is false, by
          // construction (computeRealizedGains sets both together).
          g.nativeCurrencyMixed ? baseCurrency : g.nativeCurrency!,
          fxRateSourceByTxnId,
          transactionIdBySeq,
          baseCurrency,
        ),
      );

    holdings.push({
      instrumentId: state.instrumentId,
      // Cannot happen: `kindByInstrumentId` is loaded for the same
      // `instrumentIds` superset the pricing-series load above already
      // covers (every instrument this portfolio ever traded, on or before
      // `asOfDate`), and `state.instrumentId` is drawn from that same
      // `truncated` timeline. Defensive fallback only, mirroring
      // `buildFxFlags`'s own "cannot happen" comment above.
      kind: kindByInstrumentId.get(state.instrumentId) ?? "SHARE",
      // Cannot happen, same reasoning as `kind` immediately above —
      // `displayNameByInstrumentId` is loaded for the identical
      // `instrumentIds` superset. Falls back to the raw id (never an empty
      // string) rather than a guessed name, so a defensive miss still
      // renders something non-blank instead of silently failing (the "never a
      // blank cell" rule, applied defensively here too).
      displayName: displayNameByInstrumentId.get(state.instrumentId) ?? state.instrumentId,
      // IR-12. A defensive miss here degrades to "unclassified"/"unknown
      // country" — the same honest state an unclassified row genuinely has —
      // rather than to a guess. `listingCountry` is derived from the MIC in
      // this one expression and `exchangeMic` goes no further: it is an input
      // to the derivation, not a field of the response.
      symbol: referenceByInstrumentId.get(state.instrumentId)?.symbol ?? null,
      sectorCode: referenceByInstrumentId.get(state.instrumentId)?.sectorCode ?? null,
      domicileCountry: referenceByInstrumentId.get(state.instrumentId)?.domicileCountry ?? null,
      listingCountry: listingCountryOf(referenceByInstrumentId.get(state.instrumentId)),
      // IK-10, read through the same defensive shape as the IR-12 fields
      // above: a miss degrades to "no icon", i.e. to the fallback tile, which
      // is the honest state — never to a rendered `<img>` for bytes that may
      // not exist.
      hasIcon: referenceByInstrumentId.get(state.instrumentId)?.hasIcon ?? false,
      quantity: state.quantity,
      currency: val.currency,
      pmp: { amount: state.pmpUnitBase, currency: baseCurrency, provenance: pmpProvenance },
      costBasis: {
        amount: state.costBasisBase,
        currency: baseCurrency,
        provenance: pmpProvenance,
      },
      currentPrice: {
        amount: val.price.price,
        currency: val.currency,
        provenance: currentPriceProvenance,
      },
      currentValue: {
        amount: val.valueBase,
        currency: baseCurrency,
        provenance: currentValueProvenance,
      },
      unrealizedGainLoss: {
        amount: unrealizedGainLossAmount,
        currency: baseCurrency,
        provenance: unrealizedProvenance,
      },
      ...(dayChange !== undefined ? { dayChange } : {}),
      ...(dayChangePercent !== undefined ? { dayChangePercent } : {}),
      realizedGains: holdingGains,
    });
  }

  // L6 (security review): reject rather than silently return/truncate an
  // oversized response.
  assertWithinResponseCaps(holdings, params.responseCapOverrides);

  let totalValue = ZERO;
  let totalUnrealized = ZERO;
  const valueFlagSets: (readonly DerivedFromFlag[])[] = [];
  const unrealizedFlagSets: (readonly DerivedFromFlag[])[] = [];
  const valueProvenances: FigureProvenance[] = [];
  const unrealizedProvenances: FigureProvenance[] = [];
  for (const h of holdings) {
    totalValue = totalValue.plus(h.currentValue.amount);
    totalUnrealized = totalUnrealized.plus(h.unrealizedGainLoss.amount);
    valueFlagSets.push(h.currentValue.provenance.derivedFrom);
    unrealizedFlagSets.push(h.unrealizedGainLoss.provenance.derivedFrom);
    valueProvenances.push(h.currentValue.provenance);
    unrealizedProvenances.push(h.unrealizedGainLoss.provenance);
  }
  const totalDayChange = sumDayChanges(holdings, baseCurrency);

  const cash =
    loaded.cash === undefined
      ? EMPTY_CASH
      : valueCash(loaded.cash.balances, fxRates, asOfDate, baseCurrency);
  const cashLeaves = cashProvenanceLeaves(cash, asOfDate, fxRates, fxOriginByKey, baseCurrency);

  return {
    asOfDate,
    baseCurrency: baseCurrency,
    holdings,
    cash,
    totalValue: {
      // FR-678: Σ holdings + cash, exactly.
      amount: totalValue.plus(cash.totalValueBase),
      currency: baseCurrency,
      provenance: {
        // M4 (security review): the aggregate's own staleness signal — see
        // `aggregateStaleness`'s own doc comment.
        ...aggregateStaleness(valueProvenances),
        derivedFrom: finalize(
          mergeProvenance([...valueFlagSets, ...cashLeaves.map((l) => l.derivedFrom)]),
        ),
        // AR-23 (ADR-0010): the per-holding envelopes ARE the summary's
        // leaves, so its counts, source set and observation range cannot
        // disagree with the figures already returned alongside it — plus one
        // leaf per non-base cash currency (portfolio-cash).
        summary: summarizeProvenance([...valueProvenances, ...cashLeaves]),
      },
    },
    totalUnrealizedGainLoss: {
      amount: totalUnrealized,
      currency: baseCurrency,
      provenance: {
        ...aggregateStaleness(unrealizedProvenances),
        derivedFrom: finalize(mergeProvenance(unrealizedFlagSets)),
        summary: summarizeProvenance(unrealizedProvenances),
      },
    },
    ...(totalDayChange !== undefined ? { dayChange: totalDayChange } : {}),
    calcEpoch,
    portfolioCount: 1,
  };
}

/** No cash at all — what a `cash: "omit"` portfolio carries (the tenant path values cash itself). */
const EMPTY_CASH: CashValuation = { byCurrency: [], totalValueBase: ZERO, unconverted: [] };

/**
 * portfolio-cash — the provenance leaves cash adds to a
 * total: one per **non-base** converted currency, carrying its FX source and
 * observation date and the same `PINNED_FX`/`CARRIED_FX` flags a holding's FX
 * earns (`buildFxFlags`), and one `unvalued` leaf per currency left out for
 * lack of a rate, which makes the summary `complete: false` (PC-L2). Base
 * currency cash adds no leaf, so an EUR-only tenant's `leafCount` is unmoved.
 */
function cashProvenanceLeaves(
  cash: CashValuation,
  asOfDate: IsoDate,
  fxRates: readonly FxRatePoint[],
  fxOriginByKey: ReadonlyMap<string, FxRateOrigin>,
  baseCurrency: CurrencyCode,
): ProvenanceSummaryLeaf[] {
  const leaves: ProvenanceSummaryLeaf[] = [];
  for (const line of cash.byCurrency) {
    if (line.valueBase === undefined) {
      leaves.push({ derivedFrom: [], unvalued: true });
      continue;
    }
    const fx = buildFxFlags(line.currency, asOfDate, fxRates, fxOriginByKey, baseCurrency);
    if (fx === undefined) continue; // base currency: no FX, no leaf
    leaves.push({
      derivedFrom: finalize(fx.flags),
      fxSource: fx.fxSource,
      fxRateObservedOn: fx.fxRateObservedOn,
    });
  }
  return leaves;
}

/**
 * FR-263: the portfolio-level day change — the sum of every holding's,
 * present only when every holding has one (see
 * {@link ValuedPortfolioHoldings.dayChange} for why partial sums are refused).
 * Shared verbatim by the single-portfolio and combined paths, so the tile and
 * the column can never disagree about the rule.
 */
function sumDayChanges(
  holdings: readonly ValuedHolding[],
  baseCurrency: CurrencyCode,
): ValuedFigure | undefined {
  if (holdings.length === 0) return undefined;
  const changes: ValuedFigure[] = [];
  for (const h of holdings) {
    if (h.dayChange === undefined) return undefined;
    changes.push(h.dayChange);
  }
  let amount = ZERO;
  for (const c of changes) amount = amount.plus(c.amount);
  const provenances = changes.map((c) => c.provenance);
  return {
    amount,
    currency: baseCurrency,
    provenance: {
      ...aggregateStaleness(provenances),
      derivedFrom: finalize(mergeProvenance(provenances.map((p) => p.derivedFrom))),
      summary: summarizeProvenance(provenances),
    },
  };
}

/**
 * Values one portfolio's open holdings, cost basis, and realized-gain
 * history as of `asOfDate` — the shared engine behind
 * `GET /portfolios/:id/holdings` and the point-in-time half of
 * `GET /portfolios/:id/overview` (T-39). See this module's
 * header for why this replays rather than reading `holding_state`/
 * `realized_gain` directly.
 *
 * H2(c) (security review): the `withTenant` transaction below
 * (`loadHoldingsInputs`) covers only the DB reads, including the `calc_epoch`
 * read (which must stay inside the same transaction as the position
 * timeline/pricing-series reads it is versioned against — see
 * `loadHoldingsInputs`'s own header); every pure computation
 * (`computePmp`/`computeRealizedGains`/`valuePortfolio` and the whole
 * per-holding provenance assembly, `assembleHoldings`) runs *after* the
 * transaction has closed, so the pooled connection is released before any of
 * that CPU work runs — this is what `valueHoldingsForTenant`'s fan-out over
 * every portfolio a tenant owns no longer holds N connections through.
 */
export async function valueHoldingsAsOf(
  db: Db,
  params: ValueHoldingsAsOfParams,
): Promise<ValuedPortfolioHoldings> {
  const loaded = await withTenant(db, params.tenantId, (tx) =>
    loadHoldingsInputs(tx, params, { withCash: params.cash !== "omit" }),
  );
  return assembleHoldings(loaded, params);
}

export interface ValueHoldingsForTenantParams {
  readonly tenantId: string;
  readonly asOfDate: IsoDate;
  /** L6 (security review) test-only override — see {@link ResponseCapOverrides}. */
  readonly responseCapOverrides?: ResponseCapOverrides;
}

interface HoldingAccumulator {
  quantity: Decimal;
  costBasisBase: Decimal;
  currentValueBase: Decimal;
  unrealizedBase: Decimal;
  currency: CurrencyCode;
  /** An instrument's `kind` never varies per contributing portfolio (it is an `instrument` table property, not a per-holding one) — carried through exactly like `currentPrice` below. */
  kind: InstrumentKind;
  /** UR-8: same "instrument-table property, not per-holding" reasoning as `kind` immediately above. */
  displayName: string;
  /** An `instrument`-table property like `displayName`, carried the same way. */
  symbol: string | null;
  /** IR-12: three more `instrument`-table properties, carried through the merge for the identical reason `kind`/`displayName` are — they cannot vary by contributing portfolio. */
  sectorCode: InstrumentSectorCode | null;
  domicileCountry: string | null;
  listingCountry: string | null;
  /** IK-10: a `(tenant_id, instrument_id)` property, so it cannot vary by contributing portfolio either — same carry-through as the four fields above. */
  hasIcon: boolean;
  currentPrice: ValuedFigure;
  pmpFlagSets: (readonly DerivedFromFlag[])[];
  valueFlagSets: (readonly DerivedFromFlag[])[];
  unrealizedFlagSets: (readonly DerivedFromFlag[])[];
  /** Every contributing portfolio's own `currentValue.provenance` (security review finding L4) — the source `fxSource`/`fxRateObservedOn`/`priceIsStale`/`priceAsOf` are recovered from below, rather than `currentPrice`'s provenance, which never carries the FX fields at all. */
  currentValueProvenances: FigureProvenance[];
  /** FR-263: every contribution's dayChange, or a marker that one was absent — a merged holding's day change exists only when every contribution's does. */
  dayChanges: ValuedFigure[];
  dayChangeMissing: boolean;
  /** Portfolio-invariant for a given (instrumentId, asOfDate) — same series, same delta — so carried like `currentPrice`. */
  dayChangePercent: Decimal | undefined;
  realizedGains: ValuedRealizedGain[];
}

/** Returns `values[0]` iff every element is strictly equal to it (including "all `undefined`"); otherwise `undefined`. Used by L4's "carry a single-valued field through the merge only when every contributing portfolio agrees" rule. */
function uniformValue<T>(values: readonly (T | undefined)[]): T | undefined {
  const [first] = values;
  return values.every((value) => value === first) ? first : undefined;
}

/**
 * The combined, tenant-wide view (added 2026-07-21 by user decision,
 * T-39, closing the AC10 gap that task originally flagged):
 * `GET /portfolios/overview` / `GET /portfolios/holdings`. Runs
 * {@link valueHoldingsAsOf} once per portfolio the tenant owns — the exact
 * same `valuePortfolio` + `mergeProvenance` path as the single-portfolio
 * case — then merges same-instrument holdings across portfolios:
 *
 * - `quantity`/`costBasisBase`/`currentValueBase`/`unrealizedGainLoss` are
 *   summed (all four are additive across portfolios by construction);
 * - `pmpUnitBase` is **recomputed by division** from the summed
 *   `costBasisBase`/`quantity` — never averaged, never carried — mirroring
 *   `core/domain/pmp.ts`'s own "PMP is always `cost_basis / quantity`, never
 *   an average of two PMPs" rule, which is exactly what makes this the
 *   *correctly weighted* average FR-27/AC10 require (a naive mean of two
 *   PMPs would silently ignore that one portfolio might hold ten times the
 *   other's quantity);
 * - `currentPrice` and the single-valued price/FX provenance fields
 *   (`priceSource`, `priceQuality`, `fxSource`, ...) are portfolio-invariant
 *   for a given `(instrumentId, asOfDate)` — `resolvePrice`/
 *   `resolveMarketRate` depend on neither the portfolio nor its holdings —
 *   so any one contributing portfolio's copy is correct; carried from the
 *   first one encountered;
 * - every `derivedFrom` is `mergeProvenance` over every contributing
 *   portfolio's own flags — never a bespoke union;
 * - `realizedGains` lists are concatenated (not merged/summed): each
 *   disposal is independent and already itemised, `portfolioId`-tagged so a
 *   client can tell them apart — and the concatenation is then **stable-sorted
 *   by `tradeDate`**. Before that sort the merged list was
 *   chronological only *within* each portfolio's own run (portfolio A's
 *   2021/2022 legs, then portfolio B's 2019/2020 legs, in fan-out order); the
 *   same rule the closed-positions combined route already applies (CP-10).
 *   `Array.prototype.sort` is stable, so two legs on one `tradeDate` keep the
 *   relative order the fan-out gave them.
 *
 * `calcEpoch` is the **sum of every constituent portfolio's own epoch, plus
 * the portfolio count** (security review finding L5, superseding this
 * function's original "take the max" choice — see the assembly code below
 * for why max was non-monotonic in the sense that matters here: a write to
 * any portfolio other than the current max left the combined epoch
 * unchanged). T-30 does not define a combined-view
 * `calc_epoch` itself — this remains a documented local choice.
 *
 * The fan-out is now bounded two ways (security review finding H2, which
 * superseded this function's original "no separate cap is added here, a
 * tenant can only ever inflate this by creating more of their own
 * portfolios" stance — that argument undersold the actual cost: each
 * `valueHoldingsAsOf` call pins a pooled DB connection for the length of its
 * own reads, against a pool whose `max` is 10, so one tenant with many
 * portfolios *could* starve every other tenant of a connection for the
 * fan-out's duration):
 *
 * - `createPortfolio` (`@kerdial/ledger`) now caps how many portfolios a
 *   single tenant may create at all (a generous, one-time-checked limit —
 *   closing the multiplier at its source);
 * - this call itself now runs through {@link mapWithConcurrency} (H2(b)), a
 *   small bounded worker pool, rather than an uncapped
 *   `Promise.all(portfolios.map(...))` — even a tenant at the portfolio cap
 *   never has more than {@link FAN_OUT_CONCURRENCY} `valueHoldingsAsOf` calls
 *   (each its own `withTenant` transaction/connection) in flight at once.
 *
 * `PortfoliosController`'s `ReadThrottleInterceptor` (H2(a)) additionally
 * caps how many *requests* per tenant may be running this fan-out
 * concurrently in the first place.
 */
export async function valueHoldingsForTenant(
  db: Db,
  params: ValueHoldingsForTenantParams,
): Promise<ValuedPortfolioHoldings> {
  const { tenantId, asOfDate } = params;

  // AR-5: the merged, all-portfolios response denominates its figures in the
  // tenant's ledger base — read here rather than inferred from the first
  // per-portfolio result, so a zero-portfolio tenant still gets an honest
  // baseCurrency on the empty response.
  const [tenantRow] = await db
    .select({ baseCurrency: tenant.baseCurrency })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!tenantRow) {
    throw new Error(`valueHoldingsForTenant: no tenant row for ${tenantId}`);
  }
  const baseCurrency = tenantRow.baseCurrency as CurrencyCode;

  const portfolios = await listPortfolios(db, tenantId);

  // portfolio-cash (NFR-91): the fan-out omits cash, and
  // the tenant's cash is loaded once below — one grouped statement and one
  // single-date FX load, never one per portfolio. The population is the
  // same: `listPortfolios` returns every portfolio, archived included, and
  // the tenant-wide statement covers every posting (PC-L13).
  const perPortfolio = await mapWithConcurrency(portfolios, FAN_OUT_CONCURRENCY, (p) =>
    valueHoldingsAsOf(db, { tenantId, portfolioId: p.id, asOfDate, cash: "omit" }),
  );
  const cashInputs = await withTenant(db, tenantId, async (tx) => {
    const asOf = await loadCashAsOf(tx, { tenantId, asOfDate });
    const series = await loadPricingSeries(tx, {
      tenantId,
      baseCurrency,
      instrumentIds: [],
      toDate: asOfDate,
      cashCurrencies: asOf.firstPostingDates,
    });
    return { asOf, series };
  });
  const cash = valueCash(
    cashInputs.asOf.balances,
    cashInputs.series.fxRates,
    asOfDate,
    baseCurrency,
  );
  const cashLeaves = cashProvenanceLeaves(
    cash,
    asOfDate,
    cashInputs.series.fxRates,
    cashInputs.series.fxOriginByKey,
    baseCurrency,
  );

  const merged = new Map<string, HoldingAccumulator>();
  for (const pf of perPortfolio) {
    for (const h of pf.holdings) {
      const acc = merged.get(h.instrumentId) ?? {
        quantity: ZERO,
        costBasisBase: ZERO,
        currentValueBase: ZERO,
        unrealizedBase: ZERO,
        currency: h.currency,
        kind: h.kind,
        displayName: h.displayName,
        symbol: h.symbol,
        sectorCode: h.sectorCode,
        domicileCountry: h.domicileCountry,
        listingCountry: h.listingCountry,
        // IK-10: a per-`(tenant, instrument)` fact, so every portfolio
        // contributing the same instrument reports the same value — carried
        // like `kind`/`displayName` above, not merged like a figure.
        hasIcon: h.hasIcon,
        currentPrice: h.currentPrice,
        pmpFlagSets: [],
        valueFlagSets: [],
        unrealizedFlagSets: [],
        currentValueProvenances: [],
        dayChanges: [],
        dayChangeMissing: false,
        dayChangePercent: h.dayChangePercent,
        realizedGains: [],
      };
      acc.quantity = acc.quantity.plus(h.quantity);
      acc.costBasisBase = acc.costBasisBase.plus(h.costBasis.amount);
      acc.currentValueBase = acc.currentValueBase.plus(h.currentValue.amount);
      acc.unrealizedBase = acc.unrealizedBase.plus(h.unrealizedGainLoss.amount);
      acc.pmpFlagSets.push(h.pmp.provenance.derivedFrom);
      acc.valueFlagSets.push(h.currentValue.provenance.derivedFrom);
      acc.unrealizedFlagSets.push(h.unrealizedGainLoss.provenance.derivedFrom);
      acc.currentValueProvenances.push(h.currentValue.provenance);
      if (h.dayChange === undefined) {
        acc.dayChangeMissing = true;
      } else {
        acc.dayChanges.push(h.dayChange);
      }
      acc.realizedGains.push(...h.realizedGains);
      merged.set(h.instrumentId, acc);
    }
  }

  const holdings: ValuedHolding[] = [...merged.entries()].map(([instrumentId, acc]) => {
    const pmpUnitBase = acc.quantity.isZero() ? ZERO : acc.costBasisBase.dividedBy(acc.quantity);
    const pmpProvenance: FigureProvenance = {
      derivedFrom: finalize(mergeProvenance(acc.pmpFlagSets)),
    };
    // L4 (security review): `fxSource`/`fxRateObservedOn` are carried through
    // the merge only when every contributing portfolio agrees on them (they
    // are portfolio-invariant for a given `(instrumentId, asOfDate)` per this
    // function's own header, so in practice they always do — this is a
    // defensive check, not an expected divergence) — never silently dropped
    // the way reading only `currentPrice`'s own provenance did (that
    // provenance never carries an `fxSource` at all: a native price has
    // no FX component). `PINNED_FX`/`CARRIED_FX` still reach `derivedFrom`
    // via `acc.valueFlagSets` regardless of whether the raw fields survive.
    const fxSource = uniformValue(acc.currentValueProvenances.map((p) => p.fxSource));
    const fxRateObservedOn =
      fxSource !== undefined
        ? uniformValue(acc.currentValueProvenances.map((p) => p.fxRateObservedOn))
        : undefined;
    const currentValueProvenance: FigureProvenance = {
      ...(acc.currentPrice.provenance.priceSource !== undefined
        ? { priceSource: acc.currentPrice.provenance.priceSource }
        : {}),
      ...(acc.currentPrice.provenance.priceQuality !== undefined
        ? { priceQuality: acc.currentPrice.provenance.priceQuality }
        : {}),
      // M4 (security review): staleness now reaches the merged holding too.
      ...aggregateStaleness(acc.currentValueProvenances),
      ...(fxSource !== undefined ? { fxSource } : {}),
      ...(fxRateObservedOn !== undefined ? { fxRateObservedOn } : {}),
      derivedFrom: finalize(mergeProvenance(acc.valueFlagSets)),
    };
    return {
      instrumentId,
      kind: acc.kind,
      displayName: acc.displayName,
      symbol: acc.symbol,
      sectorCode: acc.sectorCode,
      domicileCountry: acc.domicileCountry,
      listingCountry: acc.listingCountry,
      hasIcon: acc.hasIcon,
      quantity: acc.quantity,
      currency: acc.currency,
      pmp: { amount: pmpUnitBase, currency: baseCurrency, provenance: pmpProvenance },
      costBasis: { amount: acc.costBasisBase, currency: baseCurrency, provenance: pmpProvenance },
      currentPrice: acc.currentPrice,
      currentValue: {
        amount: acc.currentValueBase,
        currency: baseCurrency,
        provenance: currentValueProvenance,
      },
      unrealizedGainLoss: {
        amount: acc.unrealizedBase,
        currency: baseCurrency,
        // Mirrors `valueHoldingsAsOf`'s own per-portfolio `unrealizedProvenance`
        // (`{ ...currentValueProvenance, derivedFrom: ... }`): the unrealized
        // figure shares the same price/FX dependency as the value figure, so
        // it inherits the same staleness/fxSource fields, only its own
        // `derivedFrom` (which also folds in the PMP flags) differs.
        provenance: {
          ...currentValueProvenance,
          derivedFrom: finalize(mergeProvenance(acc.unrealizedFlagSets)),
        },
      },
      // FR-263: additive across portfolios for the same instrument (same
      // series, same delta per unit — only the quantities differ), so the
      // merged amount is the sum; the percent is portfolio-invariant and
      // carried like `currentPrice`. Absent the moment any contribution's is.
      ...(acc.dayChangeMissing || acc.dayChanges.length === 0
        ? {}
        : {
            dayChange: {
              amount: acc.dayChanges.reduce((sum, c) => sum.plus(c.amount), ZERO),
              currency: baseCurrency,
              provenance: {
                ...aggregateStaleness(acc.dayChanges.map((c) => c.provenance)),
                derivedFrom: finalize(
                  mergeProvenance(acc.dayChanges.map((c) => c.provenance.derivedFrom)),
                ),
              },
            },
            ...(acc.dayChangePercent !== undefined
              ? { dayChangePercent: acc.dayChangePercent }
              : {}),
          }),
      // Chronological across portfolios, not per-portfolio runs; see
      // this function's header.
      realizedGains: [...acc.realizedGains].sort((a, b) =>
        a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
      ),
    };
  });

  // L6 (security review): the combined view's own check — its `realizedGains`
  // concatenate every constituent portfolio's own list for the same
  // instrument (this function's own header), so a per-portfolio-only check
  // would miss a combined total that exceeds the cap even though no single
  // portfolio does.
  assertWithinResponseCaps(holdings, params.responseCapOverrides);

  let totalValue = ZERO;
  let totalUnrealized = ZERO;
  const valueFlagSets: (readonly DerivedFromFlag[])[] = [];
  const unrealizedFlagSets: (readonly DerivedFromFlag[])[] = [];
  const valueProvenances: FigureProvenance[] = [];
  const unrealizedProvenances: FigureProvenance[] = [];
  for (const h of holdings) {
    totalValue = totalValue.plus(h.currentValue.amount);
    totalUnrealized = totalUnrealized.plus(h.unrealizedGainLoss.amount);
    valueFlagSets.push(h.currentValue.provenance.derivedFrom);
    unrealizedFlagSets.push(h.unrealizedGainLoss.provenance.derivedFrom);
    valueProvenances.push(h.currentValue.provenance);
    unrealizedProvenances.push(h.unrealizedGainLoss.provenance);
  }

  // L5 (security review): the combined view's own `calc_epoch` was
  // previously the **max** across every constituent portfolio — non-
  // monotonic in the sense that matters for cache invalidation, because a
  // write to any portfolio *other than* the current max does not change the
  // max at all. Concretely: tenant owns A (epoch 5) and B (epoch 3); the
  // combined epoch is 5; B is then written to (B's epoch becomes 4); the
  // combined epoch is *still* 5 — a client that invalidates its cache only
  // when `calcEpoch` changes would miss B's write entirely, even though the
  // combined total it displays did change. Summing every portfolio's epoch
  // fixes that: any single portfolio's epoch increment changes the sum by
  // exactly that increment, so the combined epoch changes on *every* write to
  // *any* constituent portfolio, which is the actual invalidation contract
  // this field exists to serve. `+ portfolios.length`
  // is added on top so that a brand-new, never-written portfolio (epoch 0,
  // contributing nothing to the sum) still changes the combined epoch the
  // moment it is created — otherwise adding an empty portfolio to a tenant
  // whose other portfolios are all also freshly created (sum staying 0)
  // would be silently invisible to a cache keyed only on this value.
  let calcEpoch = 0n;
  for (const pf of perPortfolio) {
    calcEpoch += pf.calcEpoch;
  }
  calcEpoch += BigInt(portfolios.length);

  return {
    asOfDate,
    baseCurrency: baseCurrency,
    holdings,
    cash,
    totalValue: {
      // FR-678: Σ merged holdings + the tenant's cash, exactly.
      amount: totalValue.plus(cash.totalValueBase),
      currency: baseCurrency,
      provenance: {
        ...aggregateStaleness(valueProvenances),
        derivedFrom: finalize(
          mergeProvenance([...valueFlagSets, ...cashLeaves.map((l) => l.derivedFrom)]),
        ),
        // AR-23 (ADR-0010): summarised over the merged cross-portfolio
        // holdings' own envelopes — same leaves as the flags above — plus the
        // tenant's non-base cash currencies (portfolio-cash).
        summary: summarizeProvenance([...valueProvenances, ...cashLeaves]),
      },
    },
    totalUnrealizedGainLoss: {
      amount: totalUnrealized,
      currency: baseCurrency,
      provenance: {
        ...aggregateStaleness(unrealizedProvenances),
        derivedFrom: finalize(mergeProvenance(unrealizedFlagSets)),
        summary: summarizeProvenance(unrealizedProvenances),
      },
    },
    ...(() => {
      // FR-263: same rule as the per-portfolio total — all-or-absent, via
      // the one shared implementation.
      const combinedDayChange = sumDayChanges(holdings, baseCurrency);
      return combinedDayChange !== undefined ? { dayChange: combinedDayChange } : {};
    })(),
    calcEpoch,
    portfolioCount: portfolios.length,
  };
}
