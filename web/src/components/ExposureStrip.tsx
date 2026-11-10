import { Decimal } from "@kerdial/core-decimal";
import { HOLDINGS_COPY } from "../lib/copy/holdings.js";
import { Card } from "./ui/index.js";
import type { AllocationResult } from "../lib/allocation.js";
import { assetClassColor, assetClassLabel } from "../lib/asset-class.js";
import { drawnPercents } from "../lib/cash-position.js";
import {
  UNCLASSIFIED,
  type ExposureBreakdown,
  type ExposureBucket,
} from "../lib/exposure-breakdown.js";
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
 * **« Non classé » is a bucket, and it is the whole ETF story** (FR-13, FR-28,
 * FR-29, AC-34). An ETF's value appears there in full, on both classified
 * dimensions. There is no spinner and no placeholder look-through: the honest
 * answer is a labelled grey segment carrying the share.
 *
 * **The country dimension states its basis** (FR-11, AC-13) — issuer
 * domicile, listing-country fallback, or the mix — under its bar.
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
 * FR-11/AC-13's three sentences (the agreed French copy, verbatim).
 * `"NONE"` has no sentence on purpose: nothing was classified on a country, so
 * there is no basis to state and the legend is « Non classé » alone.
 */
const BASIS_SENTENCE: Readonly<Record<ExposureBreakdown["basis"], string | undefined>> = {
  DOMICILE: "Pays du siège social pour toutes les lignes",
  MIXED: "Pays du siège social lorsqu'il est connu, sinon pays de cotation",
  LISTING: "Pays de cotation (aucun siège social renseigné)",
  NONE: undefined,
};

/**
 * A16, stated as code: an **ordered** palette from the `--chart-*` tokens,
 * keyed by the bucket's rank rather than by what the bucket *is*. « Non
 * classé » always takes `--chart-6` (the muted tone an unknown kind already
 * gets through `assetClassColor`) so "unclassified" never reads as just
 * another sector. Sky before lemon before lilac: the lilac/sky pair fails the
 * dataviz validator when adjacent, so it is never adjacent by rank.
 */
const BUCKET_PALETTE: readonly string[] = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-3)",
];
const UNCLASSIFIED_COLOR = "var(--chart-6)";

function bucketColor(bucketKey: string, index: number): string {
  if (bucketKey === UNCLASSIFIED) return UNCLASSIFIED_COLOR;
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

/** A sector or country bar: one segment per bucket, in the breakdown's own order (descending, « Non classé » last). */
export function bucketSegments(
  dimension: Dimension,
  buckets: readonly ExposureBucket[],
): readonly ExposureSegment[] {
  // Negative cash lands in « Non classé » (C-13) and can leave that bucket
  // below zero: the same omission and renormalisation as the type bar.
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
}

function DimensionBar({ dimension, segments, note }: DimensionBarProps) {
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
              segments={bucketSegments("country", countryBreakdown.buckets)}
              note={BASIS_SENTENCE[countryBreakdown.basis]}
            />
            <DimensionBar
              dimension="sector"
              segments={bucketSegments("sector", sectorBreakdown.buckets)}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
