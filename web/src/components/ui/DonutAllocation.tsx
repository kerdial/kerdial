import { useState, type KeyboardEvent, type ReactNode } from "react";
import { assetClassColor, assetClassLabel, assetClassRank } from "../../lib/asset-class.js";

/**
 * The allocation donut — 148px across a 20px ring by default.
 *
 * Drawn as inline SVG rather than through echarts on purpose: the dashboard
 * hero would otherwise pull the charting bundle in for a figure that is five
 * arcs and a label, and `echarts-sole-importer.test.ts` exists precisely
 * because this app cares where that import surface is. A stroke-dasharray ring
 * is a handful of lines and has no runtime.
 *
 * ## Two keyings, one ring
 *
 * The exposure card keys segments by **asset class**: colour and label come
 * from `asset-class.ts` and the ring is ordered by `assetClassRank`. The
 * dashboard's positions pie keys them by **instrument**: each segment brings
 * its own `color` and `label`, and the caller's order (largest first) is the
 * order that must be drawn — sorting it by class would interleave the
 * positions. So `color`/`label` are optional per-segment overrides with the
 * class-keyed behaviour as the default, and `order="given"` keeps the caller's
 * sequence. `size`/`thickness` were already props; the pie passes larger ones.
 *
 * ## The labelled ring
 *
 * With `labelled`, the ring carries its own legend **on the arcs**: each
 * segment's `code` (a ticker, an ISO country code, a class label) is drawn at
 * the arc's midpoint, inside the band. When the caller has an `icon` for a
 * segment it is drawn as a **marker outside the ring**, on the same radial
 * line just beyond the outer edge (the owner's review: the
 * icon inside the band crowded the code and was clipped to 20px; outside,
 * both are legible). Hovering or focusing an arc swaps the ring's centre for
 * that segment's details — name, percentage, value — and dims the other arcs
 * and markers. There is no side legend to read across to: the graphic is the
 * legend.
 *
 * Four consequences that are decisions rather than accidents:
 *
 * - **A code is drawn only where it fits.** The code is a horizontal box on a
 *   curved band, so whether it fits depends on the arc's length *and* on
 *   where around the ring it sits (at three o'clock the band runs vertically
 *   and the ring's thickness is the constraint, not the arc).
 *   {@link sliceLayout} gives up rather than overflow the band. A sliver
 *   therefore has no code, and its details are reached by hover, focus, or
 *   the hidden legend the caller keeps for assistive technology.
 * - **A marker is drawn only where it has its own room.** Markers sit at the
 *   arcs' midpoints on one circle, so two neighbours collide when either arc
 *   is narrower than the marker at that radius. {@link markerGeometry} draws
 *   one only when its arc, measured at the marker's radius, is at least the
 *   marker wide. The graphic's box grows by the marker margin on every side
 *   when any segment has an icon, so a card never clips one; the ring itself
 *   keeps the `size` the caller asked for.
 * - **The details live in the centre, not in a floating tooltip.** A tooltip
 *   anchored to a slice at the top of the ring would leave the card; one at
 *   the bottom would cover the ring. The centre is always inside the graphic,
 *   is empty or holds a one-line count, and is the same place for every slice
 *   — which also makes the behaviour work under a finger, where there is no
 *   hover. The centre overlay is `pointer-events: none`: it spans the
 *   whole graphic, and before that rule it sat on top of the arcs and took
 *   every pointer event, so no arc was ever hovered on the real page — a
 *   thing jsdom's `fireEvent.mouseEnter` cannot notice, which is why the
 *   Playwright hit-test in the issue exists.
 * - **Every arc is reachable by keyboard.** An arc is focusable and carries
 *   an accessible name of the form « label, percentage »; with `onSelect` it is
 *   a link (Enter or Space activates it). The `<svg>` becomes a `group` with the
 *   caller's label instead of a single `img`, because it now has named
 *   children. Without `labelled`, the ring is still one `img` with one name and
 *   the caller's own legend carries the numbers, exactly as before.
 *
 * `percent` is stroke geometry and the only `number` here. It is the caller's
 * job to derive it from apportioned units rather than from raw amounts
 * (`ExposureStrip.donutSegments`, `PositionsPieCard.pieSlices`).
 */
export interface DonutSegment {
  readonly kind: string;
  /** Share of the whole, 0–100. */
  readonly percent: number;
  /** The arc's colour — a `var(--…)` token. Defaults to the asset class's own. */
  readonly color?: string;
  /** The legend's and the centre's text for this segment. Defaults to the asset class's label. */
  readonly label?: string;
  /** Pre-formatted value for the legend and the centre — "€42 180,00", or a `<Figure>`. */
  readonly valueText?: ReactNode;
  /** Pre-formatted percentage for the legend and the centre — "32,8 %". */
  readonly percentText?: string;
  /** The short code drawn on the arc itself when the arc is wide enough — "AI.PA", "FR", "ETF". */
  readonly code?: string;
  /** A decorative marker drawn outside the ring at the arc's midpoint — the instrument's icon. Never announced. */
  readonly icon?: ReactNode;
  /** A click, Enter or Space on the arc. Makes the arc a link. */
  readonly onSelect?: () => void;
}

export interface DonutAllocationProps {
  readonly segments: readonly DonutSegment[];
  readonly size?: number;
  readonly thickness?: number;
  readonly centerLabel?: string;
  readonly centerValue?: string;
  readonly label: string;
  readonly showLegend?: boolean;
  /** `"asset-class"` (default) sorts by `assetClassRank`; `"given"` draws the caller's order. */
  readonly order?: "asset-class" | "given";
  /** Codes on the arcs, icons outside the ring, details in the centre on hover/focus, focusable arcs. */
  readonly labelled?: boolean;
  /** `data-testid` prefix for the labelled ring's parts — `<prefix>-arc`, `<prefix>-slice`, `<prefix>-marker`, `<prefix>-center`. */
  readonly testId?: string;
  /**
   * The active segment, when the caller owns it — so a legend row beside
   * the ring can light an arc and an arc can light its row. With
   * `onActiveKindChange` given the ring is controlled and reports hover/focus
   * changes instead of keeping its own; without it, it behaves as before.
   */
  readonly activeKind?: string;
  readonly onActiveKindChange?: (kind: string | undefined) => void;
}

/** The code's type: `--size-micro` mono, semibold — see `.k-donut-slice-code`. */
const CODE_FONT_PX = 11;
/** JetBrains Mono's advance is 0.6em; 7px per character at 11px, rounded up. */
const CODE_CHAR_PX = 7;
const CODE_LINE_PX = 14;
/** `.k-donut-slice-icon`'s box — the third size `InstrumentIconTile` renders. */
export const SLICE_ICON_PX = 20;
/** Breathing room kept between a code and the band's edges, per axis. */
const SLICE_PAD_PX = 6;
/** The gap between the ring's outer edge and a marker's box. */
const MARKER_GAP_PX = 6;
/** The margin the graphic grows by, per side, when it carries markers: gap + marker. */
export const MARKER_OUTSET_PX = MARKER_GAP_PX + SLICE_ICON_PX;
/** Room a marker needs along its circle so it never touches its neighbour: its width plus a hair. */
const MARKER_ROOM_PX = SLICE_ICON_PX + 2;

export type SliceLayout = "code" | "none";

export interface SliceGeometry {
  /** The arc's midpoint on the ring's centre line, in SVG px. */
  readonly x: number;
  readonly y: number;
  /** The arc's length along the ring's centre line, in px. */
  readonly arcLength: number;
  /** The midpoint's angle in radians, 0 at three o'clock, increasing clockwise (SVG y is down). */
  readonly angle: number;
}

/** Where an arc that starts at `startPercent` and spans `percent` of a ring of `size`/`thickness` has its midpoint. */
export function sliceGeometry(
  size: number,
  thickness: number,
  startPercent: number,
  percent: number,
): SliceGeometry {
  const radius = (size - thickness) / 2;
  const center = size / 2;
  // The ring is drawn rotated −90°, so 0 % sits at twelve o'clock.
  const angle = ((startPercent + percent / 2) / 100) * 2 * Math.PI - Math.PI / 2;
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
    arcLength: (percent / 100) * 2 * Math.PI * radius,
    angle,
  };
}

/**
 * Whether a horizontal `width × height` box fits inside the band at `angle`:
 * its projection onto the radial axis must fit the thickness and its
 * projection onto the tangent must fit the arc (treated as straight, which is
 * pessimistic for long arcs and near enough for the ones a label fits in).
 */
function fits(width: number, height: number, geometry: SliceGeometry, thickness: number): boolean {
  const cos = Math.abs(Math.cos(geometry.angle));
  const sin = Math.abs(Math.sin(geometry.angle));
  const radial = width * cos + height * sin;
  const tangential = width * sin + height * cos;
  return radial <= thickness - SLICE_PAD_PX && tangential <= geometry.arcLength - SLICE_PAD_PX;
}

/** `"code"` when the code fits the arc's band, else `"none"`. */
export function sliceLayout(
  geometry: SliceGeometry,
  thickness: number,
  code: string | undefined,
): SliceLayout {
  if (code === undefined) return "none";
  return fits(code.length * CODE_CHAR_PX, CODE_LINE_PX, geometry, thickness) ? "code" : "none";
}

export interface MarkerGeometry {
  /** The marker's centre, in the ring's SVG coordinates (the graphic adds {@link MARKER_OUTSET_PX}). */
  readonly x: number;
  readonly y: number;
  /** Whether the arc, measured at the marker's radius, is wide enough for the marker to stand alone. */
  readonly fits: boolean;
}

/**
 * Where the marker of an arc that starts at `startPercent` and spans
 * `percent` of a ring of `size` sits — on the radial line through the arc's
 * midpoint, {@link MARKER_GAP_PX} beyond the ring's outer edge — and whether it
 * has room there.
 */
export function markerGeometry(
  size: number,
  startPercent: number,
  percent: number,
): MarkerGeometry {
  const radius = size / 2 + MARKER_GAP_PX + SLICE_ICON_PX / 2;
  const center = size / 2;
  const angle = ((startPercent + percent / 2) / 100) * 2 * Math.PI - Math.PI / 2;
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
    fits: (percent / 100) * 2 * Math.PI * radius >= MARKER_ROOM_PX,
  };
}

/** « Air Liquide, 32,8 % » — the arc's accessible name; the value stays in the caller's hidden legend. */
function arcName(segment: DonutSegment): string {
  const label = segment.label ?? assetClassLabel(segment.kind);
  return segment.percentText === undefined ? label : `${label}, ${segment.percentText}`;
}

export function DonutAllocation({
  segments,
  size = 148,
  thickness = 20,
  centerLabel,
  centerValue,
  label,
  showLegend = true,
  order = "asset-class",
  labelled = false,
  testId = "donut",
  activeKind: controlledActiveKind,
  onActiveKindChange,
}: DonutAllocationProps) {
  const [ownActiveKind, setOwnActiveKind] = useState<string | undefined>(undefined);
  const controlled = onActiveKindChange !== undefined;
  const activeKind = controlled ? controlledActiveKind : ownActiveKind;
  const setActiveKind = controlled ? onActiveKindChange : setOwnActiveKind;
  const ordered =
    order === "given"
      ? [...segments]
      : [...segments].sort((a, b) => assetClassRank(a.kind) - assetClassRank(b.kind));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const active = labelled ? ordered.find((segment) => segment.kind === activeKind) : undefined;

  let consumed = 0;
  const arcs = ordered.map((segment) => {
    const start = consumed;
    consumed += segment.percent;
    return { segment, start, geometry: sliceGeometry(size, thickness, start, segment.percent) };
  });
  // The marker margin is reserved on every side as soon as one segment has
  // an icon — a ring whose box changed size per marker would jitter.
  const outset =
    labelled && ordered.some((segment) => segment.icon !== undefined) ? MARKER_OUTSET_PX : 0;
  const boxSize = size + 2 * outset;

  const onArcKeyDown = (segment: DonutSegment) => (event: KeyboardEvent<SVGElement>) => {
    if (segment.onSelect === undefined) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      segment.onSelect();
    }
  };

  return (
    <div className="k-donut" data-labelled={labelled ? "true" : undefined}>
      <div
        className="k-donut-graphic"
        /* `padding` is the marker margin: absolutely positioned children are
           laid out against the padding box, so every overlay adds `outset`
           to its ring coordinates and the SVG sits in the content box. */
        style={{ width: boxSize, height: boxSize, padding: outset, fontSize: CODE_FONT_PX }}
        data-testid={labelled ? `${testId}-box` : undefined}
        onMouseLeave={labelled ? () => setActiveKind(undefined) : undefined}
      >
        <svg
          width={size}
          height={size}
          role={labelled ? "group" : "img"}
          aria-label={label}
          data-testid={labelled ? `${testId}-graphic` : undefined}
        >
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {/* The track keeps the ring visually closed when the segments do
                not reach 100 % — an unreconciled total (allocation.ts's own
                `reconciles: false`) must look incomplete, not look like a
                different distribution. */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--surface-sunken)"
              strokeWidth={thickness}
            />
            {arcs.map(({ segment, start }) => {
              const length = (segment.percent / 100) * circumference;
              const offset = (start / 100) * circumference;
              const interactive = labelled;
              return (
                <circle
                  key={segment.kind}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={segment.color ?? assetClassColor(segment.kind)}
                  strokeWidth={thickness}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-offset}
                  className={interactive ? "k-donut-arc" : undefined}
                  data-testid={interactive ? `${testId}-arc` : undefined}
                  data-kind={interactive ? segment.kind : undefined}
                  data-dimmed={
                    interactive && active !== undefined && active.kind !== segment.kind
                      ? "true"
                      : undefined
                  }
                  data-selectable={
                    interactive && segment.onSelect !== undefined ? "true" : undefined
                  }
                  /* Focusable, named, and a link when it goes somewhere: the
                     arc is the row of a legend that is no longer drawn. */
                  tabIndex={interactive ? 0 : undefined}
                  role={interactive ? (segment.onSelect === undefined ? "img" : "link") : undefined}
                  aria-label={interactive ? arcName(segment) : undefined}
                  onMouseEnter={interactive ? () => setActiveKind(segment.kind) : undefined}
                  onFocus={interactive ? () => setActiveKind(segment.kind) : undefined}
                  onBlur={interactive ? () => setActiveKind(undefined) : undefined}
                  onClick={segment.onSelect}
                  onKeyDown={interactive ? onArcKeyDown(segment) : undefined}
                />
              );
            })}
          </g>
        </svg>

        {/* The on-arc codes. HTML over the SVG rather than `<text>`
            inside it, so the code is the same mono type every other surface
            renders; `pointer-events: none` keeps the arc underneath as the
            hover and click target. */}
        {labelled &&
          arcs.map(({ segment, geometry }) => {
            const layout = sliceLayout(geometry, thickness, segment.code);
            if (layout === "none") return null;
            return (
              <div
                key={segment.kind}
                className="k-donut-slice"
                data-testid={`${testId}-slice`}
                data-kind={segment.kind}
                data-layout={layout}
                style={{ left: outset + geometry.x, top: outset + geometry.y }}
                aria-hidden="true"
              >
                <span className="k-donut-slice-code k-mono">{segment.code}</span>
              </div>
            );
          })}

        {/* The markers outside the ring — the icon is the same `<img>`
            element every other surface renders. A marker dims with its arc. */}
        {labelled &&
          arcs.map(({ segment, start }) => {
            if (segment.icon === undefined) return null;
            const marker = markerGeometry(size, start, segment.percent);
            if (!marker.fits) return null;
            return (
              <div
                key={segment.kind}
                className="k-donut-marker"
                data-testid={`${testId}-marker`}
                data-kind={segment.kind}
                data-dimmed={
                  active !== undefined && active.kind !== segment.kind ? "true" : undefined
                }
                style={{ left: outset + marker.x, top: outset + marker.y }}
                aria-hidden="true"
              >
                {segment.icon}
              </div>
            );
          })}

        {active !== undefined ? (
          <div className="k-donut-center k-donut-center-detail" data-testid={`${testId}-center`}>
            <span className="k-donut-center-name">
              {active.label ?? assetClassLabel(active.kind)}
            </span>
            {active.percentText !== undefined ? (
              <span className="k-donut-center-value k-num">{active.percentText}</span>
            ) : null}
            {active.valueText !== undefined ? (
              <span className="k-donut-center-sub k-num">{active.valueText}</span>
            ) : null}
          </div>
        ) : centerValue !== undefined ? (
          <div className="k-donut-center" data-testid={labelled ? `${testId}-center` : undefined}>
            {centerLabel !== undefined ? <span className="micro-label">{centerLabel}</span> : null}
            <span className="k-donut-center-value k-num">{centerValue}</span>
          </div>
        ) : null}
      </div>

      {showLegend ? (
        <ul className="k-donut-legend">
          {ordered.map((segment) => (
            <li key={segment.kind} className="k-donut-legend-item">
              <span
                className="k-donut-legend-dot"
                style={{ background: segment.color ?? assetClassColor(segment.kind) }}
                aria-hidden="true"
              />
              <span className="k-donut-legend-label">
                {segment.label ?? assetClassLabel(segment.kind)}
              </span>
              {segment.percentText !== undefined ? (
                <span className="k-donut-legend-percent k-num">{segment.percentText}</span>
              ) : null}
              {segment.valueText !== undefined ? (
                <span className="k-donut-legend-value k-num">{segment.valueText}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
