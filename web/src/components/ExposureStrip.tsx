import type { ExposureCountryBasis } from "@kerdial/api-contracts";
import { Decimal } from "@kerdial/core-decimal";
import { HOLDINGS_COPY } from "../lib/copy/holdings.js";
import { Card } from "./ui/index.js";
import type { AllocationResult } from "../lib/allocation.js";
import { CASH_CLASS, assetClassColor, assetClassLabel } from "../lib/asset-class.js";
import { drawnPercents } from "../lib/cash-position.js";
import {
  CASH,
  UNCLASSIFIED,
  type ExposureBreakdown,
  type ExposureBucket,
} from "../lib/exposure-breakdown.js";
import { CRYPTO, OTHER, displayBuckets } from "../lib/exposure-display.js";
import { SECTOR_UNCLASSIFIED_LABEL, sectorDisplayLabel } from "../lib/sector-display.js";
import { countryDisplayLabel } from "../lib/country-display.js";

/**
 * The dashboard's **exposure card** (UR-41's exposure block, restyled to the
 * Kerdial skin; IR-16's three dimensions) — "what am I exposed to", by instrument kind, by
 * country and by sector.
 *
 * ## Three stacked bars, all at once
 *
 * Until the owner's review of 2026-09-24 this card drew one 240px ring behind
 * a Type · Secteur · Pays segmented control. Beside the positions ring that
 * made two identical shapes side by side, and a two-class ring (Action / ETF)
 * spent a 452×456 card on one number. The three dimensions are now three
 * horizontal stacked bars in one column, each with its dot legend and share —
 * every dimension readable at a glance, no control to find, and a shape that
 * is not the ring's. The card stretches to the positions card's height
 * (`overview.css`).
 *
 * **Takes the `AllocationResult` as a prop; never calls `computeAllocation`
 * itself.** `OverviewRoute.tsx` computes it once per render pass and passes
 * the same object here and to `PositionsPieCard` — AC127's rule ("one
 * `computeAllocation` call per render pass"). The two breakdowns are second
 * *derivations* of the same units the route computes beside that call
 * (IR-16), so this component still
 * computes nothing and there is still exactly one apportionment per pass.
 *
 * **Labelled by what the data actually is.** For the type dimension,
 * `instrument.kind` is the classifier and the class colours and French labels
 * come from `asset-class.ts`'s locked map, so a kind is the same colour here
 * as in every other chart and chip. Sector and country
 * buckets are labelled through the app's single renderer for each code
 * (`sectorDisplayLabel`, `countryDisplayLabel` — the single-site rule) and take an
 * **ordered** neutral palette from the `--chart-*` tokens by rank, with
 * « Non classé » last in the muted tone (A16: a locked per-sector map
 * is the kerdial-skin cycle's decision, not this card's).
 *
 * **« Non classé » is a bucket** (FR-13, FR-28, FR-29, AC-34, AC-631). An ETF
 * with no weight set appears there in full, on both classified dimensions;
 * one with a set is split across it, what the set leaves uncovered staying in
 * « Non classé ». There is no spinner and no placeholder: the honest answer is
 * a labelled grey segment carrying the share.
 *
 * **Hand-entered weights say so** (FR-731). A weight set is typed in by the
 * user, not a verified or provider-sourced composition, so a bar whose figures
 * use one carries a note saying exactly that — and only then.
 *
 * **« Liquidités » is its own bucket** (FR-745) on the sector and country bars,
 * in the cash colour the type bar already uses, after « Non classé »; absent
 * when there is no cash.
 *
 * **The country dimension states its basis** (FR-11, AC-13, FR-730) — issuer
 * domicile, listing-country fallback, hand-entered weights, or the mix —
 * under its bar.
 *
 * **The legends carry the percentage but no per-bucket money value.** There is
 * no per-kind monetary subtotal on the wire, and a client-side sum would be a
 * new figure whose merged provenance this card cannot know, so it could not
 * render through `<Figure>` honestly (the "omit what cannot be filled honestly" rule).
 *
 * Suppression follows `computeAllocation`'s own guards: when the total is
 * unavailable or the rows do not reconcile, `kindSubtotals` is empty by
 * construction and both breakdowns are `suppressed`, so the card says so once
 * instead of drawing bars that do not add up.
 */
export interface ExposureStripProps {
  readonly allocation: AllocationResult;
  /** IR-15's regrouping of the same `allocation`, by sector — computed once by the route, never here. */
  readonly sectorBreakdown: ExposureBreakdown;
  /** IR-15's regrouping of the same `allocation`, by country (FR-11's basis included). */
  readonly countryBreakdown: ExposureBreakdown;
}

const ZERO = new Decimal(0);

type Dimension = "kind" | "country" | "sector";

const HEADING = "Exposition";

/** The dimensions in reading order — the two that usually carry several buckets first. */
const DIMENSION_TITLES: Readonly<Record<Dimension, string>> = {
  kind: "Type",
  country: "Pays",
  sector: "Secteur",
};

/**
 * FR-11/AC-13's sentences (the agreed French copy, verbatim) and FR-730's for
 * hand-entered weights, one per member of the shared basis set — a new member
 * is a compile error here until it has one. `"NONE"` has no sentence on
 * purpose: nothing was classified on a country, so there is no basis to state
 * and the legend is « Non classé » alone. `MIXED` reads as before unless a
 * weight set is part of the mix ({@link MIXED_WEIGHTED_SENTENCE}).
 */
const BASIS_SENTENCE: Readonly<Record<ExposureCountryBasis, string | undefined>> = {
  DOMICILE: "Pays du siège social pour toutes les lignes",
  MIXED: "Pays du siège social lorsqu'il est connu, sinon pays de cotation",
  LISTING: "Pays de cotation (aucun siège social renseigné)",
  WEIGHTED: "Répartition par pays saisie manuellement pour toutes les lignes classées",
  NONE: undefined,
};

const MIXED_WEIGHTED_SENTENCE =
  "Pays du siège social, pays de cotation ou répartition saisie manuellement, selon la ligne";

/** FR-731, AC-631: under any bar whose figures use a hand-entered weight set, and only there. */
const WEIGHTED_NOTE =
  "Pondérations saisies manuellement pour certains instruments — ce ne sont pas des données vérifiées.";

function basisSentence(breakdown: ExposureBreakdown): string | undefined {
  if (breakdown.basis === "MIXED" && breakdown.weighted) return MIXED_WEIGHTED_SENTENCE;
  return BASIS_SENTENCE[breakdown.basis];
}

/**
 * A16, stated as code: an **ordered** palette keyed by the bucket's rank
 * rather than by what the bucket *is* — one colour per named bucket, six at
 * most (`displayBuckets`). « Non classé » always takes `--chart-6` (the muted
 * tone an unknown kind already gets through `assetClassColor`) so
 * "unclassified" never reads as just another sector.
 *
 * Teal, lilac and sky only, in two tones: apricot and lemon are the type
 * bar's « Crypto » and « Liquidités », which these bars now draw too, so a
 * ranked bucket never borrows them. A teal sits between every lilac and sky:
 * that pair fails the dataviz validator when adjacent.
 */
const BUCKET_PALETTE: readonly string[] = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--teal-800)",
  "var(--chart-4)",
  "var(--teal-300)",
  "var(--lilac-700)",
];
const UNCLASSIFIED_COLOR = "var(--chart-6)";
/** « Autres »: a neutral darker than « Non classé », so the two greys next to each other stay apart. */
const OTHER_COLOR = "var(--ink-600)";
const OTHER_LABEL = "Autres";
const CRYPTO_KIND = "CRYPTO";

function bucketColor(bucketKey: string, index: number): string {
  if (bucketKey === UNCLASSIFIED) return UNCLASSIFIED_COLOR;
  if (bucketKey === OTHER) return OTHER_COLOR;
  // The type bar's « Crypto » colour, for the same reason as cash below.
  if (bucketKey === CRYPTO) return assetClassColor(CRYPTO_KIND);
  // FR-745: the type bar's « Liquidités » colour, so cash reads the same on every bar.
  if (bucketKey === CASH) return assetClassColor(CASH_CLASS);
  return BUCKET_PALETTE[index % BUCKET_PALETTE.length]!;
}

/**
 * FR-13's bucket label, through the app's single renderer for each code.
 * The « Non classé » bucket reuses `SECTOR_UNCLASSIFIED_LABEL` on
 * **both** dimensions, because it is one bucket ("this holding has no
 * classification on this dimension"), not the absence of a field on a detail
 * row (which is « Non renseigné »).
 */
function bucketLabel(dimension: Dimension, bucketKey: string): string {
  if (bucketKey === UNCLASSIFIED) return SECTOR_UNCLASSIFIED_LABEL;
  if (bucketKey === CASH) return assetClassLabel(CASH_CLASS);
  if (bucketKey === OTHER) return OTHER_LABEL;
  if (bucketKey === CRYPTO) return assetClassLabel(CRYPTO_KIND);
  return dimension === "sector" ? sectorDisplayLabel(bucketKey) : countryDisplayLabel(bucketKey);
}

/** One segment of a bar: its key, label, colour, exact share text and the geometry-only width. */
export interface ExposureSegment {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly percentText: string;
  /**
   * Bar geometry only, 0–100. Summed from the apportioned integer `units`
   * (never re-derived from amounts, never parsed out of `percentText`) and
   * converted with `Number.parseInt` on an integer — the exact, total step
   * `PositionsPieCard` records; nothing displayed is derived from it.
   */
  readonly percent: number;
}

/**
 * The type bar: one segment per kind, in `kindSubtotals`' own order, coloured
 * by the locked class map — « Liquidités » (`CASH`) last, in `--class-cash`,
 * with its signed share.
 *
 * A kind whose share is zero or below gets no segment width: a **negative**
 * cash subtotal keeps its legend entry with the signed figure (« -33,33 % »),
 * but draws nothing, and the other segments are renormalised over their own
 * sum so the bar is full (`drawnPercents`, C-14).
 */
export function kindSegments(allocation: AllocationResult): readonly ExposureSegment[] {
  const unitsByKind = new Map<string, Decimal>();
  for (const row of allocation.rows) {
    if (row.units === undefined) continue;
    unitsByKind.set(row.kind, (unitsByKind.get(row.kind) ?? ZERO).plus(row.units));
  }
  const percents = drawnPercents(
    allocation.kindSubtotals.map((subtotal) => unitsByKind.get(subtotal.kind) ?? ZERO),
  );
  return allocation.kindSubtotals.map((subtotal, index) => ({
    key: subtotal.kind,
    label: assetClassLabel(subtotal.kind),
    color: assetClassColor(subtotal.kind),
    percentText: subtotal.percentageText,
    percent: percents[index] ?? 0,
  }));
}

/** A sector or country bar: one segment per bucket, in the order given (`displayBuckets`: named, « Autres », « Non classé », « Crypto », « Liquidités »). */
export function bucketSegments(
  dimension: Dimension,
  buckets: readonly ExposureBucket[],
): readonly ExposureSegment[] {
  // Negative cash is a negative « Liquidités » bucket (FR-745): the same
  // signed legend entry, omission and renormalisation as the type bar (C-14).
  const percents = drawnPercents(buckets.map((bucket) => bucket.units));
  return buckets.map((bucket, index) => ({
    key: bucket.bucketKey,
    label: bucketLabel(dimension, bucket.bucketKey),
    color: bucketColor(bucket.bucketKey, index),
    percentText: bucket.percentageText,
    percent: percents[index] ?? 0,
  }));
}

interface DimensionBarProps {
  readonly dimension: Dimension;
  readonly segments: readonly ExposureSegment[];
  readonly note?: string | undefined;
  /** FR-731: this bar's figures use a hand-entered weight set. */
  readonly weighted?: boolean;
}

function DimensionBar({ dimension, segments, note, weighted = false }: DimensionBarProps) {
  const title = DIMENSION_TITLES[dimension];
  const legendId =
    dimension === "kind" ? "exposure-strip-subtotals" : `exposure-strip-buckets-${dimension}`;
  return (
    <section
      className="ov-dim"
      data-testid={`exposure-strip-${dimension}`}
      aria-labelledby={`exposure-strip-${dimension}-title`}
    >
      <h3 id={`exposure-strip-${dimension}-title`} className="micro-label">
        {title}
      </h3>
      <div className="ov-bar" role="img" aria-label={title} data-testid={`${legendId}-bar`}>
        {/* A share of zero or below has no width to draw (C-14); its legend
            entry below still states it. */}
        {segments
          .filter((segment) => segment.percent > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className="ov-bar-seg"
              data-testid="exposure-strip-segment"
              data-kind={segment.key}
              style={{ width: `${String(segment.percent)}%`, background: segment.color }}
            />
          ))}
      </div>
      <dl className="ov-bar-legend" data-testid={legendId}>
        {segments.map((segment) => (
          <div key={segment.key}>
            <dt className="ov-bar-item" data-testid={`exposure-strip-${dimension}-label`}>
              <span
                className="ov-bar-dot"
                style={{ background: segment.color }}
                aria-hidden="true"
              />
              {segment.label}
            </dt>
            <dd
              className="ov-bar-pct k-num"
              data-testid={
                dimension === "kind"
                  ? `exposure-strip-percentage-${segment.key}`
                  : `exposure-strip-bucket-percentage-${dimension}-${segment.key}`
              }
            >
              {segment.percentText}
            </dd>
          </div>
        ))}
      </dl>
      {note !== undefined && (
        <p data-testid={`exposure-strip-basis`} className="ov-note">
          {note}
        </p>
      )}
      {weighted && (
        <p data-testid={`exposure-strip-weighted-note-${dimension}`} className="ov-note">
          {WEIGHTED_NOTE}
        </p>
      )}
    </section>
  );
}

export function ExposureStrip({
  allocation,
  sectorBreakdown,
  countryBreakdown,
}: ExposureStripProps) {
  const unavailable = allocation.kindSubtotals.length === 0;

  return (
    <Card data-testid="exposure-strip" aria-labelledby="exposure-strip-heading">
      <div className="ov-card-head">
        <h2 id="exposure-strip-heading" className="ov-card-title">
          {HEADING}
        </h2>
      </div>

      <div className="ov-card-body ov-card-fill">
        {unavailable ? (
          /* `computeAllocation`'s own two guards, worded as they already were —
             once, since all three dimensions are derived from the same units. */
          <p data-testid="exposure-strip-unavailable" className="ov-note">
            {allocation.totalUnavailable
              ? HOLDINGS_COPY.exposureTotalUnavailable
              : HOLDINGS_COPY.exposureUnreconciled}
          </p>
        ) : (
          <div className="ov-dims">
            <DimensionBar dimension="kind" segments={kindSegments(allocation)} />
            <DimensionBar
              dimension="country"
              segments={bucketSegments("country", displayBuckets(countryBreakdown))}
              note={basisSentence(countryBreakdown)}
              weighted={countryBreakdown.weighted}
            />
            <DimensionBar
              dimension="sector"
              segments={bucketSegments("sector", displayBuckets(sectorBreakdown))}
              weighted={sectorBreakdown.weighted}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
