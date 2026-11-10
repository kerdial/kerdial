import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import type {
  FigureProvenance,
  FxSource,
  PriceQuality,
  ValuedAmount,
} from "../components/Figure.js";
import type { DeltaSign } from "../components/ui/DeltaValue.js";
import type { RealizedGainResponse } from "./api-client.js";
import { CLOSED_POSITIONS_COPY } from "./copy/closed-positions.js";
import { resolveMinorUnit } from "./currency-scale.js";
import { formatAmount } from "./figure-format.js";

/**
 * `positions.ts` — UR-12.
 *
 * Shared, screen-agnostic helpers the Positions screen's desktop table
 * (`HoldingsTable.tsx`) and mobile card list (`HoldingsCardList.tsx`) both
 * consume identically — the same rule `allocation.ts`/`figure-format.ts`
 * already established for percentage/monetary formatting, extended here to
 * this screen's own derived numbers (unrealized P&L %, cost-basis
 * summation) and its two shared classification predicates (manual-price
 * affordance, provenance-detail copy), so neither component tree
 * reimplements any of this on its own.
 */

function tryParseDecimal(raw: string): Decimal | undefined {
  try {
    return parseDecimalString(raw);
  } catch {
    return undefined;
  }
}

/**
 * The one implementation behind both percentage helpers below — a signed
 * result over the cost it was earned on, formatted as a percentage.
 *
 * Extracted from {@link unrealizedGainLossPercentageText}'s body when
 * `closed-positions` (AC-320) needed the identical rule for realised
 * results, and **extracted rather than copy-pasted on purpose**: with one code
 * path there is no divergence for a test to catch, so "the two agree" stops
 * being a property that has to be re-checked and becomes a structural fact.
 *
 * `undefined` — never `0 %`, never `∞` — when either amount fails to parse or
 * the denominator is zero: a division by zero, or a position with no recorded
 * cost, makes the ratio meaningless, not "0 %". Computed on `Decimal`
 * throughout, never `Number()`/floats.
 */
function ratioPercentageText(numerator: string, denominator: string): string | undefined {
  const top = tryParseDecimal(numerator);
  const bottom = tryParseDecimal(denominator);
  if (top === undefined || bottom === undefined || bottom.isZero()) return undefined;
  return formatAmount("percentage", top.dividedBy(bottom), 0);
}

/**
 * AC124: unrealized P&L % = `unrealizedGainLoss / costBasis`, via
 * `@kerdial/core-decimal` (never `Number()`/floats). Renders `—` (returns
 * `undefined`) — never `0 %`, never `∞` — when either amount fails to parse
 * or `costBasis` is zero (a division by zero, or a position with no
 * recorded cost, both make the ratio meaningless, not "0 %").
 *
 * Name, signature and returns are unchanged by the `closed-positions` cycle —
 * only the body moved into {@link ratioPercentageText}, so this function's
 * existing tests hold unmodified (AC-330).
 */
/**
 * The dashboard day-change tile's percentage (the combined overview carries
 * no aggregate `dayChangePercent`, unlike each holding): the price move against the value the same
 * holdings had at the previous close, i.e. `dayChange / (totalValue − dayChange)`.
 * `dayChange` is price-only (FR-263, flows excluded), so the previous-close
 * value is the current total less that move. `undefined` when either amount
 * is unparseable or the previous-close value is zero — the tile then shows
 * the amount alone rather than a `∞` or a `0 %`.
 */
export function overviewDayChangePercentageText(
  dayChangeAmount: string,
  totalValueAmount: string,
): string | undefined {
  const change = tryParseDecimal(dayChangeAmount);
  const total = tryParseDecimal(totalValueAmount);
  if (change === undefined || total === undefined) return undefined;
  return ratioPercentageText(dayChangeAmount, total.minus(change).toString());
}

export function unrealizedGainLossPercentageText(
  unrealizedGainLossAmount: string,
  costBasisAmount: string,
): string | undefined {
  return ratioPercentageText(unrealizedGainLossAmount, costBasisAmount);
}

/**
 * AC-320 (FR-327): a closed
 * position's return — `totalRealizedGainBase / totalDisposedCostBasisBase`.
 *
 * The **server never computes this** (FR-327: the wire carries the figure and
 * its denominator, and nothing else), precisely so the client owns what a zero
 * denominator renders as. It renders a dash, by sharing
 * {@link unrealizedGainLossPercentageText}'s exact implementation
 * ({@link ratioPercentageText}) rather than mirroring its convention — a
 * fully-divested line with no recorded disposed cost basis is unmeasurable,
 * not break-even.
 */
export function closedPositionReturnPercentageText(
  totalRealizedGainBaseAmount: string,
  totalDisposedCostBasisBaseAmount: string,
): string | undefined {
  return ratioPercentageText(totalRealizedGainBaseAmount, totalDisposedCostBasisBaseAmount);
}

/**
 * UR-46/AC-329: the sign-aware French label a closed position's result carries
 * **beside** its `<DeltaValue>` tint, so direction is never colour-only.
 *
 * Here rather than in either list component for the reason this module exists
 * at all: `<ClosedPositionsTable>` and `<ClosedPositionsCardList>` are two
 * presentations of one row, and a label ternary written twice is two
 * presentations that can disagree. The strings themselves live in
 * `copy/closed-positions.ts` (UR-45) — this only chooses between them, from
 * the sign `deltaValue`'s own `deltaSign` derived from the raw decimal.
 *
 * `"flat"` covers both a genuinely zero result and one whose amount could not
 * be read: neither is a plus-value, and neither may borrow that word.
 */
export function closedPositionResultLabel(sign: DeltaSign): string {
  if (sign === "gain") return CLOSED_POSITIONS_COPY.resultGain;
  if (sign === "loss") return CLOSED_POSITIONS_COPY.resultLoss;
  return CLOSED_POSITIONS_COPY.resultFlat;
}

/**
 * The heat bucket a position's **unrealised** P&L % falls in — the one thing
 * the Répartition map's tile colour encodes (`HoldingsTreemap.tsx`).
 *
 * Derived from the same ratio {@link unrealizedGainLossPercentageText} formats
 * (`unrealizedGainLoss / costBasis`, on `Decimal` throughout), and guarded
 * identically: an unparseable amount or a zero cost basis is `"unknown"` — a
 * *stated* absence painted in the muted `--chart-6` tone, never a green or red
 * tile and never `"flat"`, which would claim the position is exactly break-even.
 *
 * Three magnitudes each side rather than a continuous gradient: a colour ramp
 * invites reading a value off a hue, and the value is already printed on the
 * tile. Buckets say "up a lot / up / barely moved" and nothing finer.
 */
export type HeatTone =
  "gain-strong" | "gain" | "gain-soft" | "flat" | "loss-soft" | "loss" | "loss-strong" | "unknown";

/** ±2 % and ±10 % of cost basis — the two bucket edges, on `Decimal` (never a float literal comparison). */
const HEAT_EDGE_SOFT = new Decimal("0.02");
const HEAT_EDGE_STRONG = new Decimal("0.10");
const HEAT_ZERO = new Decimal(0);

export function unrealizedGainLossTone(
  unrealizedGainLossAmount: string,
  costBasisAmount: string,
): HeatTone {
  const gainLoss = tryParseDecimal(unrealizedGainLossAmount);
  const costBasis = tryParseDecimal(costBasisAmount);
  if (gainLoss === undefined || costBasis === undefined || costBasis.isZero()) return "unknown";

  const ratio = gainLoss.dividedBy(costBasis);
  if (ratio.isZero()) return "flat";
  const magnitude = ratio.abs();
  const gaining = ratio.greaterThan(HEAT_ZERO);
  if (magnitude.greaterThanOrEqualTo(HEAT_EDGE_STRONG)) {
    return gaining ? "gain-strong" : "loss-strong";
  }
  if (magnitude.greaterThanOrEqualTo(HEAT_EDGE_SOFT)) {
    return gaining ? "gain" : "loss";
  }
  return gaining ? "gain-soft" : "loss-soft";
}

/**
 * FR-263: the day-change percentage, formatted exactly like
 * the unrealised one — absent (never « 0 % ») when the wire carried none,
 * which is the response's own contract for "no previous close exists".
 */
export function dayChangePercentageText(dayChangePercent: string | undefined): string | undefined {
  if (dayChangePercent === undefined) return undefined;
  const parsed = tryParseDecimal(dayChangePercent);
  if (parsed === undefined) return undefined;
  return formatAmount("percentage", parsed, 0);
}

/**
 * AC125: the summary strip's total cost basis is the sum of every row's own
 * `costBasis.amount` — never re-derived any other way. A row whose own
 * amount fails to parse contributes zero rather than throwing or blanking
 * every other row's contribution (the same defensive stance `allocation.ts`
 * takes for a malformed `currentValue.amount`).
 */
export function sumDecimalAmounts(amounts: readonly string[]): Decimal {
  return amounts.reduce((acc, raw) => {
    const parsed = tryParseDecimal(raw);
    return parsed === undefined ? acc : acc.plus(parsed);
  }, new Decimal(0));
}

/**
 * AC128's row-action gate. `HoldingResponse` carries no `quotePolicy` — that
 * lives only on `InstrumentResponse`, and fetching it per row is exactly the
 * per-row instrument lookup UR-8/UR-9 removed
 * (`holdings-history-status-request-volume.spec.ts`'s `distinctKindRequests`
 * must stay `0`) — so this uses the richer per-holding signals already on
 * the wire as the best available
 * proxy: `currentPrice.provenance.priceQuality === "MANUAL"` (this holding's
 * current price was entered manually — the practical signature of a
 * `MANUAL_ONLY` instrument, since an automated instrument is never priced
 * this way in ordinary operation) OR `currentPrice.amount` failing to parse
 * (a defensive stand-in for "unresolvable": the domain's real
 * `UnresolvablePriceError` (`core/domain/src/valuation.ts`) fails the whole
 * `GET /portfolios/holdings` request with a 422 before any row ever reaches
 * this component, so a truly unresolvable price can never appear inside a
 * successfully rendered row under the current wire contract — this second
 * branch exists for defensive/future-proofing symmetry with `allocation.ts`'s
 * own "never thrown, never blank" stance on a malformed amount, not because
 * it is reachable today).
 */
export function needsManualPriceEntry(currentPrice: ValuedAmount): boolean {
  if (currentPrice.provenance.priceQuality === "MANUAL") return true;
  return tryParseDecimal(currentPrice.amount) === undefined;
}

const PRICE_QUALITY_LABELS: Readonly<Record<PriceQuality, string>> = {
  REALTIME: "temps réel",
  DELAYED: "différé",
  MANUAL: "manuel",
  EOD: "clôture",
};

const FX_SOURCE_LABELS: Readonly<Record<FxSource, string>> = {
  USER_PINNED: "épinglé par l'utilisateur",
  PROVIDER: "fournisseur",
  IMPLIED_BASE: "devise de base implicite",
  QUOTE_PROVIDER: "fournisseur de cours",
};

/**
 * The Positions row expander's "provenance detail" section — a permanently-visible, French-labelled restatement of the exact
 * fields `<Figure>`'s own tooltip already shows on hover
 * (`Figure.tsx`'s `buildTooltipLines`), plus `priceQuality`/`fxSource`/
 * `priceIsStale`, which the tooltip does not surface as text at all (only as
 * badge glyphs). Never re-renders a `ValuedAmount` itself — `<Figure>` stays
 * the sole renderer for that (FR-127/AC119) — this only describes the
 * provenance flags already attached to one.
 */
export function provenanceDetailLines(provenance: FigureProvenance): readonly string[] {
  const lines: string[] = [];
  if (provenance.priceSource !== undefined) {
    lines.push(`Source du cours : ${provenance.priceSource}`);
  }
  if (provenance.priceQuality !== undefined) {
    lines.push(`Qualité du cours : ${PRICE_QUALITY_LABELS[provenance.priceQuality]}`);
  }
  if (provenance.priceAsOf !== undefined) {
    lines.push(`Cours daté du : ${provenance.priceAsOf}`);
  }
  if (provenance.priceIsStale === true) {
    lines.push("Ce cours est considéré comme périmé.");
  }
  if (provenance.fxSource !== undefined) {
    lines.push(`Source du taux de change : ${FX_SOURCE_LABELS[provenance.fxSource]}`);
  }
  if (provenance.fxRateObservedOn !== undefined) {
    lines.push(`Taux de change observé le : ${provenance.fxRateObservedOn}`);
  }
  return lines;
}

/** UR-39's `topConcentration` default row count for the Positions summary strip's concentration indicator — a display choice, not a server-mirrored cap, so it lives here rather than in `api-limits.ts`. */
export const TOP_CONCENTRATION_ROW_COUNT = 5;

export interface RealizedGainsSummary {
  readonly count: number;
  readonly totalText: string;
  /**
   * The signed total as a raw decimal string, or `undefined` when any leg
   * failed to parse (the same condition that makes {@link totalText} a dash).
   *
   * Exists so a caller can distinguish a realised **gain** from a realised
   * **loss**: the indicator used to label every outcome « Gains réalisés »,
   * which reads a loss as a gain of a negative number. `undefined` rather than
   * a defaulted `0` on purpose — a figure that could not be read must not be
   * coloured as flat.
   */
  readonly totalAmount?: string;
}

/**
 * AC144 (the AC126 refinement): the
 * realized-gains **indicator**'s data, kept visible in the collapsed row/card
 * (`<RealizedGainsIndicator>`) — distinct from the itemised per-sale list,
 * which stays behind a disclosure (AC126, unweakened by this).
 *
 * **Corrected.** These two lines used to name a
 * `<HoldingRealizedGains>` component as that itemised list; a repo-wide grep
 * finds no such file, export or test — it was never built. The real
 * itemised per-sale list is `<ClosedPositionSaleLots>`, and it is mounted on
 * the « Clôturées » tab only, **never** on the open-holdings row: an open
 * position's legs are still summarised here and nowhere itemised (UR-44).
 * `count` is always exact; `totalText`
 * sums every entry's own `gainBase.amount` via `@kerdial/core-decimal`
 * (never floats — the same defensive stance `sumDecimalAmounts` takes, except
 * here a single unparseable entry blanks the *whole* aggregate to `"—"`
 * rather than silently contributing zero, because a wrong partial sum would
 * misstate the very figure this indicator exists to surface honestly).
 * `gainBase` is always the EUR base currency (every `RealizedGainResponse`
 * carries it in base, whichever surface renders the leg — the second of the
 * two `<HoldingRealizedGains>` references a later fix corrects), so this is
 * a same-currency addition, never a cross-currency one.
 */
export function summarizeRealizedGains(
  gains: readonly RealizedGainResponse[],
): RealizedGainsSummary | undefined {
  if (gains.length === 0) return undefined;

  let total: Decimal | undefined = new Decimal(0);
  let currency: string | undefined;
  for (const gain of gains) {
    const parsed = tryParseDecimal(gain.gainBase.amount);
    if (parsed === undefined) {
      total = undefined;
      break;
    }
    total = total.plus(parsed);
    currency ??= gain.gainBase.currency;
  }

  const totalText =
    total === undefined || currency === undefined
      ? "—"
      : `${formatAmount("monetary", total, resolveMinorUnit(currency))} ${currency}`;

  // The raw signed total, so a caller can tell a realised **gain** from a
  // realised **loss** rather than reading both as "gains réalisés".
  // `undefined` when any leg failed to parse — the same condition that makes
  // `totalText` a dash — so a caller cannot colour a figure it could not read.
  const totalAmount = total === undefined ? undefined : total.toString();

  return { count: gains.length, totalText, totalAmount };
}

/**
 * UR-14 (the "why does it need manual pricing?"
 * question) — reuses {@link needsManualPriceEntry}'s exact same proxy signal
 * (`currentPrice.provenance.priceQuality === "MANUAL"`), never a per-row
 * `GET /instruments/:id` lookup for the real `quotePolicy` (that per-row fetch
 * is exactly what UR-8/UR-9 removed — `holdings-history-status-request-
 * volume.spec.ts`'s `distinctKindRequests` must stay `0`). `kind` is already
 * on `HoldingResponse` at zero extra cost, so it is folded into the copy for
 * a more concrete answer than the proxy alone would give.
 */
export function manualPriceReasonText(holding: {
  readonly kind: string;
  readonly currentPrice: ValuedAmount;
}): string {
  if (holding.currentPrice.provenance.priceQuality === "MANUAL") {
    return `Cet instrument (${holding.kind}) est actuellement valorisé par un cours saisi manuellement : sans nouvelle saisie, ce cours ne sera pas mis à jour.`;
  }
  return `Le cours de cet instrument (${holding.kind}) n'est pas fourni automatiquement — un cours doit être saisi manuellement pour le valoriser.`;
}
