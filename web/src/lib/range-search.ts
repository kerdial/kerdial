import {
  CUSTOM_RANGE_ID,
  resolveRange,
  type CustomRangeInput,
  type ResolvedPeriodRange,
} from "./period-presets.js";

/**
 * `range-search.ts` — the glue between the three routes that carry a
 * `{ range, from, to }` search triple (Aperçu, Performance, portfolio detail)
 * and the control that renders it.
 *
 * It exists so the *navigation* half of a custom window is written once. Each
 * of those routes otherwise repeats the same eight lines, and the one that got
 * them subtly wrong would be the one where clicking «Perso.» silently moved
 * the window — the exact failure {@link PeriodSelectorCustom.onOpen}'s
 * seed-from-the-applied-window rule exists to prevent.
 *
 * Deliberately **router-agnostic**: it takes a `navigate` callback rather than
 * importing `router.js`, so the views that consume it stay unit-testable
 * without dragging the route tree (and `virtual:pwa-register/react`) into a
 * test — the same split `PerformanceRoute.tsx`/`PerformanceView.tsx` records.
 */

/** The search triple, as every route that offers a custom window validates it. */
export interface RangeSearch {
  readonly range: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * The custom-window half of `PeriodSelector`'s props.
 *
 * Declared here rather than in the component so `PeriodSelector.tsx` and this
 * module cannot disagree about the shape, and so a route file can name the
 * type without importing a component.
 */
export interface PeriodSelectorCustom {
  /** The window the URL carries, or a bound of it while the reader is still typing. */
  readonly from?: string;
  readonly to?: string;
  /**
   * «Perso.» was clicked while some preset was applied: seed the URL with the
   * window **already on screen**, so the click changes which control is lit
   * and not a single figure. Writing `range=CUSTOM` with empty bounds instead
   * would resolve ({@link resolveRange}) to the *default* preset's window —
   * the reader clicks «Perso.» on a `MAX` chart and watches it jump to one
   * year.
   */
  readonly onOpen: () => void;
  /** A bound was edited. Both are sent every time, so one coherent window is written. */
  readonly onChange: (range: CustomRangeInput) => void;
}

/** What a route hands its view: the window to query with, and the control's props. */
export interface RangeSearchControl {
  /** The `[from, to]` every query on the screen is scoped to. */
  readonly resolved: ResolvedPeriodRange;
  /** {@link PeriodSelector}'s `custom` prop. */
  readonly custom: PeriodSelectorCustom;
}

/**
 * Builds both halves from a validated search triple and a `navigate`.
 *
 * `navigate` receives the **whole** next triple, never a patch: a partial
 * update is how `range=CUSTOM` comes to survive beside a `from`/`to` that a
 * later preset click should have dropped. Selecting a preset is therefore the
 * caller's own one-liner (`{ range: id }`) — it drops both bounds by
 * construction.
 *
 * `today` is injectable purely for deterministic testing, mirroring
 * `resolvePresetRange`'s own parameter.
 */
export function rangeSearchControl(
  search: RangeSearch,
  navigate: (next: RangeSearch) => void,
  today?: string,
): RangeSearchControl {
  const custom: CustomRangeInput = {
    ...(search.from === undefined ? {} : { from: search.from }),
    ...(search.to === undefined ? {} : { to: search.to }),
  };
  const resolved = resolveRange(search.range, custom, today);
  return {
    resolved,
    custom: {
      ...custom,
      onOpen: () => {
        navigate({ range: CUSTOM_RANGE_ID, from: resolved.from, to: resolved.to });
      },
      onChange: (next) => {
        navigate({
          range: CUSTOM_RANGE_ID,
          ...(next.from === undefined ? {} : { from: next.from }),
          ...(next.to === undefined ? {} : { to: next.to }),
        });
      },
    },
  };
}
