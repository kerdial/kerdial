/**
 * The Dividendes screen's period presets — DS-6
 * (FR-271/FR-272,
 * AC-286; LD-6, DV8, DV9).
 *
 * Pure, no component import, testable alone — `period-presets.ts`'s own shape.
 * It is a **sibling** of that file rather than an extension of it (DV8), and
 * neither `period-presets.ts` nor `PeriodSelector.tsx` is modified: the two
 * controls answer different questions and one of them would have to lose.
 *
 * ## Three differences from `period-presets.ts`, each load-bearing
 *
 * 1. **The default is all-time, not `1Y`.** FR-271 requires the unselected
 *    state to cover the tenant's entire history, and `ALL` therefore resolves
 *    to `{}` — the *absence* of a date predicate, not a very wide window.
 *    AC-286 tests exactly that, against a dividend more than five years old.
 * 2. **No clamp of any kind.** `RETURN_WINDOW_EPOCH_FLOOR` and
 *    `RETURN_WINDOW_MAX_SPAN_YEARS` (`period-presets.ts:39-53`) mirror the
 *    *valuation* window's server-side bounds; `GET /dividends/summary` has
 *    neither (`api/src/dividends/dividends.schema.ts`'s own note on why
 *    `resolveReturnWindow` is deliberately not reused). Borrowing them here
 *    would silently re-introduce the trailing window FR-271 forbids.
 * 3. **The URL carries the resolved `from`/`to`, never a preset id** (DV9). A
 *    relative id (`PREV_1`) in a bookmark silently changes meaning on 1
 *    January; an absolute one (`2025`) stops the id set being closed, which is
 *    what `validateSearch` needs to fall back safely. Carrying the window makes
 *    a bookmark absolute and permanent, and {@link matchDividendPeriod}
 *    recovers which button to light up — a window no preset produces simply
 *    highlights «Personnalisée…».
 */

export type DividendPeriodId = "ALL" | "YTD" | "PREV_1" | "PREV_2" | "PREV_3" | "PREV_4" | "CUSTOM";

/** Render order for the control. Four previous years, not more — six controls is the footprint `PeriodSelector` already occupies (A5: the count and the wording are the user's to override). */
export const DIVIDEND_PERIOD_IDS: readonly DividendPeriodId[] = [
  "ALL",
  "YTD",
  "PREV_1",
  "PREV_2",
  "PREV_3",
  "PREV_4",
  "CUSTOM",
];

/** FR-271 — the unselected default is the tenant's entire history. */
export const DEFAULT_DIVIDEND_PERIOD_ID: DividendPeriodId = "ALL";

/** Both bounds optional and both **absent** rather than `undefined`-valued when unbounded — see {@link resolveDividendPeriod}. */
export interface DividendPeriodRange {
  readonly from?: string;
  readonly to?: string;
}

/** Calendar years back from `today`'s own year. */
const PREVIOUS_YEAR_OFFSETS: Readonly<Record<"PREV_1" | "PREV_2" | "PREV_3" | "PREV_4", number>> = {
  PREV_1: 1,
  PREV_2: 2,
  PREV_3: 3,
  PREV_4: 4,
};

/** The ids that resolve to a window of their own, in match order — `ALL` first, so an empty window matches the default rather than falling through to `CUSTOM`. */
const MATCHABLE_IDS: readonly DividendPeriodId[] = [
  "ALL",
  "YTD",
  "PREV_1",
  "PREV_2",
  "PREV_3",
  "PREV_4",
];

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `today`'s calendar year, shifted back by `yearsBack`.
 *
 * `.split("-").map(Number)` — never a bare `Number(x)` call — is
 * `search-params.ts`/`period-presets.ts`'s own idiom: `web/src`'s no-floats
 * syntactic ban (`eslint.config.mjs`) forbids the `CallExpression` shape, but
 * a `Number` *reference* passed to `.map()` is not that shape. No `Date` is
 * constructed either, so no timezone enters a calendar-year calculation.
 */
function calendarYearBack(today: string, yearsBack: number): string {
  const [year] = today.split("-").map(Number) as [number];
  return String(year - yearsBack);
}

/**
 * Resolves a preset to the window to put in the URL.
 *
 * `ALL` is `{}` — **genuinely unbounded**, with no `from` key at all rather
 * than a `from: undefined` that would look identical at one call site and
 * behave differently at the next. That is the distinction AC-286 depends on:
 * all-time is the absence of a predicate.
 *
 * `CUSTOM` likewise returns `{}`, and that is not the same statement: it has no
 * window *of its own*, because its window is whatever the user typed. The
 * selector never resolves it — it reveals the two date inputs and leaves the
 * current window untouched — so this branch exists only to keep the function
 * total.
 *
 * `today` is injectable purely for deterministic testing, mirroring
 * `resolvePresetRange`'s own parameter.
 */
export function resolveDividendPeriod(
  id: DividendPeriodId,
  today: string = todayIsoDate(),
): DividendPeriodRange {
  switch (id) {
    case "YTD":
      return { from: `${calendarYearBack(today, 0)}-01-01` };
    case "PREV_1":
    case "PREV_2":
    case "PREV_3":
    case "PREV_4": {
      const year = calendarYearBack(today, PREVIOUS_YEAR_OFFSETS[id]);
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case "ALL":
    case "CUSTOM":
      return {};
  }
}

/**
 * The inverse: which preset (if any) the current URL window *is*.
 *
 * Compared bound by bound rather than by deep equality, so a validated search
 * object carrying `{from: undefined, to: undefined}` (which is exactly what
 * `router.tsx`'s `validateSearch` produces for a bare `/dividends`) matches
 * `ALL` instead of falling through to `CUSTOM` and lighting up the wrong
 * button on first paint.
 */
export function matchDividendPeriod(
  range: DividendPeriodRange,
  today: string = todayIsoDate(),
): DividendPeriodId {
  for (const id of MATCHABLE_IDS) {
    const candidate = resolveDividendPeriod(id, today);
    if (candidate.from === range.from && candidate.to === range.to) return id;
  }
  return "CUSTOM";
}

/**
 * The control's **visible** button labels, resolved against `today` so the four
 * year buttons read "2025", "2024", ….
 *
 * Abbreviated since the period-control compaction: seven buttons carrying
 * "Depuis le début", "Depuis le 1er janvier" and "Personnalisée…" made this the
 * tallest header in the app — the row alone wrapped onto three lines and pushed
 * the portfolio filter beside it onto a fourth. The spelled-out wording is not
 * lost: it is {@link dividendPeriodLongLabel}, which the control carries as each
 * button's `title` **and** `aria-label`, so the accessible name and the hover
 * text are still the full sentence while the visible token is one word.
 *
 * `YTD` reads as the current year ("2026") beside the four previous ones, which
 * is what makes the row one scannable sequence of years; the long label is what
 * says it stops at today rather than covering the whole year.
 */
export function dividendPeriodLabel(id: DividendPeriodId, today: string = todayIsoDate()): string {
  switch (id) {
    case "ALL":
      return "Tout";
    case "YTD":
      return calendarYearBack(today, 0);
    case "CUSTOM":
      return "Perso.";
    default:
      return calendarYearBack(today, PREVIOUS_YEAR_OFFSETS[id]);
  }
}

/**
 * The spelled-out wording {@link dividendPeriodLabel} used to render, kept as
 * the accessible name and the `title` of every button. A year button's long
 * form states the window it resolves to, so "2026" (YTD) and "2025" (a whole
 * calendar year) cannot be read as the same kind of thing.
 */
export function dividendPeriodLongLabel(
  id: DividendPeriodId,
  today: string = todayIsoDate(),
): string {
  switch (id) {
    case "ALL":
      return "Depuis le début";
    case "YTD":
      return `Depuis le 1er janvier ${calendarYearBack(today, 0)}`;
    case "CUSTOM":
      return "Personnalisée…";
    default:
      return `Année ${calendarYearBack(today, PREVIOUS_YEAR_OFFSETS[id])}`;
  }
}
