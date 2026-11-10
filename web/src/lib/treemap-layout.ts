/**
 * `treemap-layout.ts` — the squarified-treemap geometry behind the
 * Positions screen's **Répartition** map (`HoldingsTreemap.tsx`).
 *
 * Pure geometry, and deliberately nothing else: it takes opaque `key`/`weight`
 * pairs and returns rectangles. It knows nothing about holdings, percentages,
 * money or colour — which is what lets the whole layout be unit-tested without
 * a DOM, and what keeps the "one allocation computation per render pass"
 * discipline (`allocation.ts`, AC127) intact: this module never derives a
 * weight, it is handed one.
 *
 * **Squarified (Bruls/Huizing/van Wijk), not slice-and-dice.** Slice-and-dice
 * is three lines shorter and produces slivers — a 0,4 % position becomes a
 * 1-pixel-wide ribbon no one can read or click. Squarify lays each row along
 * the shorter free side and closes the row when adding the next item would
 * make the row's *worst* aspect ratio worse, which is what gives the
 * finviz-style near-square tiles the screen is for.
 *
 * **Area is exact, shape is heuristic.** Every tile's area is exactly its
 * share of the box (`weight / Σweight`) — the property the map claims and the
 * only one it may claim. Row *shape* is the heuristic part, and no figure is
 * ever read off it.
 *
 * **Coordinates come back in percent**, `0..100` on each axis independently,
 * so the caller positions tiles with `left`/`top`/`width`/`height` in `%` and
 * needs neither a `ResizeObserver` nor a measured pixel box. Because the two
 * axes are normalised independently, the layout has to be *computed* in a box
 * with the real aspect ratio or every tile would come out stretched: that is
 * {@link MAP_ASPECT_WIDTH}/{@link MAP_ASPECT_HEIGHT}, which the map's own
 * `aspect-ratio` CSS must match — `treemap-aspect.drift.test.ts` asserts the
 * stylesheet and this constant agree.
 *
 * No `Number()`/`parseFloat`/unary `+`/`.toFixed()` anywhere here
 * (`lint-no-restricted-syntax.test.ts`): the weights arrive as plain integers
 * — `allocation.ts`'s apportioned 0.01 % unit counts, converted once by the
 * caller through `Number.parseInt` on an integer string, the same conversion
 * `ExposureStrip.tsx`'s donut geometry documents.
 */

/** The map's aspect ratio, shared with `holdings.css`'s `.holdings-map`. */
export const MAP_ASPECT_WIDTH = 16;
export const MAP_ASPECT_HEIGHT = 9;

export interface TreemapItem {
  readonly key: string;
  /** Any positive magnitude; only the ratios between weights matter. Non-finite and non-positive weights are dropped. */
  readonly weight: number;
}

/** A tile's box, in percent of the container on each axis (`0..100`). */
export interface TreemapRect {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface FreeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface AreaItem {
  readonly key: string;
  readonly area: number;
}

/**
 * The row's worst aspect ratio if it were laid along a side of length `side`
 * — the squarify paper's `worst()`, max(long/short) over the row's tiles.
 * `1` is a perfect square; bigger is worse.
 */
function worstAspect(row: readonly AreaItem[], side: number): number {
  if (row.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const item of row) {
    sum += item.area;
    if (item.area < min) min = item.area;
    if (item.area > max) max = item.area;
  }
  if (sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY;
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max((sideSquared * max) / sumSquared, sumSquared / (sideSquared * min));
}

/** Lays one closed row along the free rectangle's shorter side and returns what is left. */
function placeRow(
  row: readonly AreaItem[],
  free: FreeRect,
): { readonly rects: readonly TreemapRect[]; readonly free: FreeRect } {
  const sum = row.reduce((acc, item) => acc + item.area, 0);
  const rects: TreemapRect[] = [];

  if (free.width <= free.height) {
    // Row runs left-to-right across the top of the free box.
    const thickness = Math.min(sum / free.width, free.height);
    let x = free.x;
    for (const item of row) {
      const width = thickness > 0 ? item.area / thickness : 0;
      rects.push({ key: item.key, x, y: free.y, width, height: thickness });
      x += width;
    }
    return {
      rects,
      free: {
        x: free.x,
        y: free.y + thickness,
        width: free.width,
        height: free.height - thickness,
      },
    };
  }

  // Row runs top-to-bottom down the left edge of the free box.
  const thickness = Math.min(sum / free.height, free.width);
  let y = free.y;
  for (const item of row) {
    const height = thickness > 0 ? item.area / thickness : 0;
    rects.push({ key: item.key, x: free.x, y, width: thickness, height });
    y += height;
  }
  return {
    rects,
    free: {
      x: free.x + thickness,
      y: free.y,
      width: free.width - thickness,
      height: free.height,
    },
  };
}

/**
 * Lays `items` out as a squarified treemap over the whole box.
 *
 * Ordering is by weight descending, ties broken by `key` ascending — the same
 * total order `allocation.ts` uses for its residual units, so the map is
 * deterministic for a given input rather than dependent on input order.
 */
export function squarifiedTreemap(items: readonly TreemapItem[]): readonly TreemapRect[] {
  const usable = items
    .filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .sort((left, right) => right.weight - left.weight || (left.key < right.key ? -1 : 1));
  if (usable.length === 0) return [];

  const total = usable.reduce((acc, item) => acc + item.weight, 0);
  const boxArea = MAP_ASPECT_WIDTH * MAP_ASPECT_HEIGHT;
  const areas: readonly AreaItem[] = usable.map((item) => ({
    key: item.key,
    area: (item.weight / total) * boxArea,
  }));

  const rects: TreemapRect[] = [];
  let free: FreeRect = { x: 0, y: 0, width: MAP_ASPECT_WIDTH, height: MAP_ASPECT_HEIGHT };
  let row: AreaItem[] = [];

  for (const item of areas) {
    const side = Math.min(free.width, free.height);
    const candidate = [...row, item];
    if (row.length === 0 || worstAspect(candidate, side) <= worstAspect(row, side)) {
      row = candidate;
      continue;
    }
    const placed = placeRow(row, free);
    rects.push(...placed.rects);
    free = placed.free;
    row = [item];
  }
  if (row.length > 0) {
    rects.push(...placeRow(row, free).rects);
  }

  // Normalised per axis — see this module's header for why the layout above
  // had to happen in the real aspect ratio first.
  return rects.map((rect) => ({
    key: rect.key,
    x: (rect.x / MAP_ASPECT_WIDTH) * 100,
    y: (rect.y / MAP_ASPECT_HEIGHT) * 100,
    width: (rect.width / MAP_ASPECT_WIDTH) * 100,
    height: (rect.height / MAP_ASPECT_HEIGHT) * 100,
  }));
}
