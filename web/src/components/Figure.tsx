import * as Tooltip from "@radix-ui/react-tooltip";
import { assertValidScale, tryFormatAmount, type FigureKind } from "../lib/figure-format.js";
import { Icon } from "./ui/Icon.js";
import { FIGURE_COPY } from "../lib/copy/figures.js";
import { GLOSSARY_COPY } from "../lib/copy/glossary.js";

/**
 * `<Figure>` — T-43: the single
 * component every monetary/quantity figure in the UI renders through
 * (`<Figure value={holding.currentValue} scale={2} />`). Formats exclusively
 * via `@kerdial/core-decimal`'s shared display formatters (T-4) — never a
 * local `.toFixed` call or a bare `Number` conversion (T-43 AC5, enforced by
 * `Figure.test.tsx`'s source-text assertion) — and renders the badge/
 * tooltip set: a dotted underline plus an "M" badge for
 * manual data, a clock badge for delayed quotes, a pin badge for
 * user-pinned FX (FR-65, AC51), and an amber treatment when the figure is
 * stale. The manual/pinned and delayed treatments are deliberately
 * different colours *and* different glyphs (never conflated,
 * by explicit rule) — see `Figure.test.tsx`'s structural-distinctness
 * assertion.
 *
 * Renders a bare `Tooltip.Root`/`Trigger` **unconditionally** (T-44 carry-forward) — only `Tooltip.Portal`/`Content` are
 * skipped when there is nothing tooltip-worthy to show. The
 * `Tooltip.Provider` (hover-delay coordination) is a single instance at the
 * app root (`AppShell.tsx`), not one per `<Figure>` (security review:
 * a `Provider` per cell would never coordinate delays with its
 * neighbours once T-45's virtualised table renders many of these at once).
 * Any caller — including this file's own tests — needs an ancestor
 * `Tooltip.Provider` for *every* figure, tooltip-worthy or not: one that is
 * missing will throw on first render, regardless of which fixture's
 * provenance happens to be tooltip-worthy (`Figure.test.tsx`'s "Tooltip.
 * Provider lives at the app root" suite).
 *
 * ## `ValuedAmount` — the wire shape, mirrored locally (not imported from `api`)
 *
 * `web` has no build-time dependency on the `api` package — it consumes
 * JSON over HTTP — so, exactly like
 * `web/src/lib/api-client.ts`'s `OverviewResponse`/`HoldingsResponse`, the
 * types below are a local mirror of the server's wire shape rather than an
 * import of it: `api/src/common/valued-amount.schema.ts`'s
 * `ValuedAmountResponse`/`ProvenanceResponse` (itself serialised from
 * `@kerdial/valuation`'s `ValuedFigure`/`FigureProvenance`, whose
 * `derivedFrom` union is computed exactly once by `core/domain`'s
 * `mergeProvenance()`). Field names/optionality are kept in lockstep with
 * that file by hand — T-44's shared-Zod-schema package covers *request*
 * bodies (client/server validation cannot drift there); no equivalent
 * shared-types package exists yet for *response* envelopes like this one,
 * matching every other response shape already declared locally in
 * `api-client.ts`.
 */
export type PriceQuality = "REALTIME" | "DELAYED" | "MANUAL" | "EOD";
export type FxSource = "USER_PINNED" | "PROVIDER" | "IMPLIED_BASE" | "QUOTE_PROVIDER";
export type DerivedFromFlag =
  "MANUAL_PRICE" | "DELAYED_QUOTE" | "PINNED_FX" | "CARRIED_FX" | "CRYPTO_QUOTE" | "AUTOMATED";

/**
 * AR-23/AR-24 (ADR-0010) — the aggregate's summary, mirrored
 * from `api/src/common/valued-amount.schema.ts`'s
 * `ProvenanceSummaryResponse` exactly like the envelope below. Present on
 * aggregate figures only (portfolio totals, combined totals, the TWR/MWR
 * pair); a leaf's singular fields are already the whole truth.
 */
export interface ProvenanceSummary {
  readonly sources: readonly string[];
  readonly oldestObservationAt?: string;
  readonly newestObservationAt?: string;
  readonly staleInputCount: number;
  readonly manualInputCount: number;
  readonly pinnedFxPresent: boolean;
  readonly carriedFxPresent: boolean;
  readonly leafCount: number;
  readonly complete: boolean;
  readonly derivedFrom: readonly DerivedFromFlag[];
}

export interface FigureProvenance {
  readonly priceSource?: string;
  readonly priceQuality?: PriceQuality;
  readonly priceAsOf?: string;
  readonly priceIsStale?: boolean;
  readonly fxSource?: FxSource;
  readonly fxRateObservedOn?: string;
  readonly derivedFrom: readonly DerivedFromFlag[];
  readonly summary?: ProvenanceSummary;
}

export interface ValuedAmount {
  readonly amount: string;
  readonly currency: string;
  readonly provenance: FigureProvenance;
}

/**
 * `monetary` is the usual shape (`scale` = the currency's `minorUnit`);
 * `quantity`/`percentage`/`fxRate` cover the rest of "every monetary/
 * quantity figure in the UI" (T-43) via T-4's other three
 * display formatters. `scale` is ignored for every kind but `monetary`.
 *
 * Re-exported from `figure-format.ts` (UR-5, a pure move) so nothing importing `FigureKind` from here
 * needs to change.
 */
export type { FigureKind };

export interface FigureProps {
  readonly value: ValuedAmount;
  /** The currency's `minorUnit`. Only used for `kind="monetary"` (the default); ignored otherwise. */
  readonly scale?: number;
  /** Defaults to `"monetary"`, the one documented call shape. */
  readonly kind?: FigureKind;
  /**
   * Suppress the provenance affordances — the M / delayed / pinned-FX badges
   * and the tooltip — leaving only the formatted amount.
   *
   * **Not a way around the `<Figure>` convention** (AC119: every monetary
   * figure renders through this component). The formatting, the scale, the
   * absent-value case and the stale styling are all unchanged; only the source
   * annotations are dropped. A caller reaches for this when the surface itself
   * has decided not to carry provenance — the Positions table, where three
   * badge-bearing columns sit side by side and the row's own provenance
   * expander has been removed.
   *
   * Provenance is not lost to the product: it remains on the instrument detail
   * screen, and every response still carries its envelope. This is a presentation choice on one surface, not a data change.
   */
  readonly showProvenance?: boolean;
}

const DEFAULT_MONETARY_SCALE = 2;

const FR_DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const FR_DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

/** French display of an ISO timestamp/date; falls back to the raw string if it does not parse. */
function formatFrenchDate(iso: string, formatter: Intl.DateTimeFormat): string {
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? formatter.format(parsed) : iso;
}

/**
 * AR-24 (ADR-0010): the aggregate tooltip reads from the summary —
 * "2 sources · 3 saisies manuelles sur 12" — instead of inventing a single
 * source label for many inputs. French, sentence case, no advice, per the
 * app's voice rules. A line is emitted only when it says something (a
 * zero count is silence, not "0 sur 12").
 */
function buildSummaryTooltipLines(summary: ProvenanceSummary): string[] {
  const lines: string[] = [];
  if (summary.sources.length > 0) {
    lines.push(
      summary.sources.length === 1
        ? `Source : ${summary.sources[0]}`
        : `${summary.sources.length} sources : ${summary.sources.join(", ")}`,
    );
  }
  if (summary.manualInputCount > 0) {
    lines.push(
      `${summary.manualInputCount} ${summary.manualInputCount === 1 ? "saisie manuelle" : "saisies manuelles"} sur ${summary.leafCount}`,
    );
  }
  if (summary.staleInputCount > 0) {
    lines.push(
      `${summary.staleInputCount} ${summary.staleInputCount === 1 ? "donnée périmée" : "données périmées"} sur ${summary.leafCount}`,
    );
  }
  if (summary.pinnedFxPresent) {
    lines.push("Taux de change épinglé par l'utilisateur");
  }
  if (summary.carriedFxPresent && summary.oldestObservationAt !== undefined) {
    lines.push(
      `Taux de change reporté depuis le ${formatFrenchDate(summary.oldestObservationAt, FR_DATE)}`,
    );
  } else if (summary.carriedFxPresent) {
    lines.push("Taux de change reporté (dernière observation connue)");
  }
  if (summary.oldestObservationAt !== undefined && summary.newestObservationAt !== undefined) {
    lines.push(
      summary.oldestObservationAt === summary.newestObservationAt
        ? `Au : ${formatFrenchDate(summary.oldestObservationAt, FR_DATE_TIME)}`
        : `Observations du ${formatFrenchDate(summary.oldestObservationAt, FR_DATE)} au ${formatFrenchDate(summary.newestObservationAt, FR_DATE)}`,
    );
  }
  return lines;
}

/**
 * Tooltip content: "source, timestamp, and — for
 * carried-forward FX — the observation date." When the figure is an
 * aggregate (AR-23's `summary` is present), the summary's lines replace the
 * singular ones entirely: an aggregate's `priceAsOf` is the summary's own
 * oldest observation restated, and a singular `Source :` line standing for
 * many inputs is exactly what ADR-0010 exists to end.
 */
function buildTooltipLines(provenance: FigureProvenance): string[] {
  // « Cours différé » is jargon, and the clock badge beside it is the
  // only thing that says so. The badge cannot carry a `<GlossaryHint>` of its
  // own — it lives *inside* this component's own `Tooltip.Trigger`, and a
  // trigger nested in a trigger is not a thing Radix can resolve — so the
  // definition joins the lines this figure's existing tooltip already shows.
  const delayed = provenance.derivedFrom.includes("DELAYED_QUOTE")
    ? [GLOSSARY_COPY.delayedQuote]
    : [];
  if (provenance.summary !== undefined) {
    return [...buildSummaryTooltipLines(provenance.summary), ...delayed];
  }
  const lines: string[] = [...delayed];
  if (provenance.priceSource !== undefined) {
    lines.push(`Source : ${provenance.priceSource}`);
  }
  if (provenance.priceAsOf !== undefined) {
    lines.push(`Au : ${formatFrenchDate(provenance.priceAsOf, FR_DATE_TIME)}`);
  }
  if (provenance.fxRateObservedOn !== undefined) {
    lines.push(
      `Taux de change observé le ${formatFrenchDate(provenance.fxRateObservedOn, FR_DATE)}`,
    );
  }
  return lines;
}

export function Figure({
  value,
  scale = DEFAULT_MONETARY_SCALE,
  kind = "monetary",
  showProvenance = true,
}: FigureProps) {
  assertValidScale(kind, scale);
  const { provenance } = value;
  const formatted = tryFormatAmount(kind, value.amount, scale);

  if (formatted === undefined) {
    return (
      <span data-testid="figure" className="inline-flex items-center gap-1">
        <span role="img" aria-label={FIGURE_COPY.absent} className="k-figure-absent">
          —
        </span>
      </span>
    );
  }

  // AC29 (T-43): the "M" badge is keyed off `derivedFrom`
  // carrying `MANUAL_PRICE`, not off `priceQuality` — the aggregation case
  // the aggregation case (a portfolio total containing one manually priced OPCVM)
  // only ever surfaces through the merged `derivedFrom` set.
  const isManual = provenance.derivedFrom.includes("MANUAL_PRICE");
  const isDelayed = provenance.derivedFrom.includes("DELAYED_QUOTE");
  // AC51/FR-65, security review F1: keyed off *either* `fxSource ===
  // "USER_PINNED"` (the per-holding case) *or* `derivedFrom` carrying
  // `PINNED_FX` (the aggregate case — `aggregateStaleness`,
  // valuation/src/holdings-valuation.ts, only carries `priceAsOf`/
  // `priceIsStale` up to a portfolio total, dropping `fxSource`, so a total
  // derived from one user-pinned-FX holding has `fxSource: undefined` and
  // signals the pin only via the merged `derivedFrom` set). Safe, not a
  // loosened condition: `PINNED_FX` has exactly two producers in
  // `valuation/src/holdings-valuation.ts`, both gated identically on
  // `"USER_PINNED"` — `buildFxFlags` (line ~372, the per-holding market-rate
  // case) and `mapFxRateSourceToFlags` (line ~389, the realized-gain/
  // transaction-`fx_rate_source` case) — there is no other producer of that
  // flag.
  const isPinnedFx =
    provenance.fxSource === "USER_PINNED" || provenance.derivedFrom.includes("PINNED_FX");
  const isStale = provenance.priceIsStale === true;

  const valueClassName = [
    "k-num",
    isManual ? "border-b border-dotted border-lilac-500" : "",
    isStale ? "k-figure-stale" : "k-figure-value",
  ]
    .filter((c) => c.length > 0)
    .join(" ");

  // `showProvenance === false` returns here, before the badges and before
  // `Tooltip.Root` is mounted at all — not a hidden tooltip, an absent one, so
  // there is no trigger to focus and nothing announced to a screen reader.
  // The stale styling stays: `k-figure-stale` is about the *figure's* validity,
  // not about where it came from.
  if (!showProvenance) {
    return (
      <span data-testid="figure" className="inline-flex items-center gap-1">
        <span className={valueClassName}>
          {formatted}
          {kind === "monetary" ? ` ${value.currency}` : null}
        </span>
      </span>
    );
  }

  const figure = (
    <span data-testid="figure" className="inline-flex items-center gap-1">
      <span className={valueClassName}>
        {formatted}
        {kind === "monetary" ? ` ${value.currency}` : null}
      </span>
      {isManual && (
        <span
          data-testid="figure-badge-manual"
          role="img"
          aria-label={FIGURE_COPY.manualBadge}
          className="k-figure-badge k-figure-badge-manual"
        >
          M
        </span>
      )}
      {isDelayed && (
        <span
          data-testid="figure-badge-delayed"
          role="img"
          aria-label={FIGURE_COPY.delayedBadge}
          className="k-figure-badge k-figure-badge-delayed"
        >
          {/* The badge span carries the role and label — it is the meaningful
              unit, and `Figure.test.tsx` asserts every badge announces at that
              level. The glyph inside stays decorative so nothing is announced
              twice. */}
          <Icon name="clock" size="xs" />
        </span>
      )}
      {isPinnedFx && (
        <span
          data-testid="figure-badge-pinned-fx"
          role="img"
          aria-label={FIGURE_COPY.pinnedFxBadge}
          className="k-figure-badge k-figure-badge-pinned"
        >
          <Icon name="pin" size="xs" />
        </span>
      )}
    </span>
  );

  // Carry-forward from T-43's review (T-44): `Tooltip.Root`/
  // `Trigger` mount unconditionally — only `Tooltip.Portal`/`Content` are
  // skipped when there is nothing tooltip-worthy to show. Before this fix, a
  // figure whose provenance happened to carry no tooltip-worthy field (no
  // `priceSource`/`priceAsOf`/`fxRateObservedOn`) never touched `Tooltip.Root`
  // at all, so a caller missing the ancestor `Tooltip.Provider` would only
  // ever find out from *some* fixtures (the tooltip-worthy ones), not
  // reliably from every one — a missing `Provider` must fail on first render
  // regardless of which fixture happened to trigger the test first.
  const tooltipLines = buildTooltipLines(provenance);

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{figure}</Tooltip.Trigger>
      {tooltipLines.length > 0 && (
        <Tooltip.Portal>
          <Tooltip.Content data-testid="figure-tooltip" className="k-tooltip" sideOffset={4}>
            {tooltipLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
            <Tooltip.Arrow className="k-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      )}
    </Tooltip.Root>
  );
}
