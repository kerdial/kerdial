/**
 * The overview screen's period selector (T-45;
 * "the date-range ... state that FR-36/FR-37 need lives in
 * the URL, making views linkable/refresh-safe"). A small, closed set of
 * presets — never a free-text date field — so the URL search param the
 * router carries (`router.tsx`'s `overviewRoute` search schema) is always one
 * of these ids, and the `[from, to]` window resolved from it
 * ({@link resolvePresetRange}) can never itself be malformed or fall outside
 * `api/src/portfolios/portfolios.schema.ts`'s `resolveReturnWindow` bounds
 * (`RETURN_WINDOW_EPOCH_FLOOR`/`RETURN_WINDOW_MAX_SPAN_YEARS`, mirrored below
 * the same way `Figure.tsx` mirrors the server's `ValuedAmount` wire shape —
 * `web` has no build-time dependency on `api`).
 */

import { asIsoDate } from "./search-params.js";

export interface PeriodPreset {
  readonly id: string;
  /** The visible token — abbreviated, one line, never the spelled-out form. */
  readonly label: string;
  /** The spelled-out French, carried as the button's `title`/`aria-label`. */
  readonly longLabel: string;
  /** The window as a qualifier after a figure: « 16.82% *sur 1 an* », « *depuis le 1er janvier* ». */
  readonly phrase: string;
  /**
   * Months to look back from `to`; `undefined` means one of the two presets
   * {@link resolvePresetRange} special-cases instead of computing from a
   * fixed month count — `MAX` (since the epoch floor) and `YTD` (since this
   * calendar year's 1 January, a span that is never a fixed number of months).
   */
  readonly monthsBack?: number;
}

/**
 * Labels are the **abbreviated** forms ("3M", "1A") rather than the spelled-out
 * French ("3 mois", "1 an") they were until the period-control compaction.
 * Six spelled-out presets plus the header's own actions overflowed
 * `.k-pagehead-actions`'s wrap onto a second and third line on every screen
 * that mounts this control, which is exactly the vertical space the overview's
 * figures need. The spelled-out form survives as each button's `title`
 * ({@link PeriodPreset.longLabel}) — the abbreviation is the visible token, the
 * words are still one hover away and are what a screen reader announces.
 *
 * `YTD` sits between `6M` and `1Y` (asked for 2026-09-08): it is the one
 * preset whose span is neither fixed nor arbitrary — it is exactly as long as
 * the calendar year has run so far — so it belongs next to the other
 * sub-year windows rather than after the whole-year ones.
 */
export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  { id: "3M", label: "3M", longLabel: "3 mois", phrase: "sur 3 mois", monthsBack: 3 },
  { id: "6M", label: "6M", longLabel: "6 mois", phrase: "sur 6 mois", monthsBack: 6 },
  { id: "YTD", label: "YTD", longLabel: "Depuis le 1er janvier", phrase: "depuis le 1er janvier" },
  { id: "1Y", label: "1A", longLabel: "1 an", phrase: "sur 1 an", monthsBack: 12 },
  { id: "3Y", label: "3A", longLabel: "3 ans", phrase: "sur 3 ans", monthsBack: 36 },
  { id: "5Y", label: "5A", longLabel: "5 ans", phrase: "sur 5 ans", monthsBack: 60 },
  { id: "MAX", label: "Max", longLabel: "Depuis le début", phrase: "depuis le début" },
];

export const DEFAULT_PERIOD_PRESET_ID = "1Y";

/**
 * The subset the Suivi screen offers — this file's set **minus `MAX`**.
 *
 * `MAX` is excluded because `GET /watchlist`'s series load is bounded at 5
 * years + 400 days: a `MAX` there would either lie about its span
 * or unbound a 200-row read. It stays available exactly where it is affordable
 * — the per-instrument detail chart, which fetches one instrument.
 *
 * **Derived, never re-declared.** The six ids this produces are, by
 * construction, `valuation/src/watchlist-valuation.ts`'s own
 * `WATCHLIST_WINDOW_PRESETS` (`["3M","6M","YTD","1Y","3Y","5Y"]`, itself
 * documented as "`period-presets.ts`'s set minus `MAX`"), so a preset added
 * here reaches the screen and the server's enum from the same source rather
 * than from two hand-kept lists. A value this filter let through that the
 * server does not accept would be a `400`, which is why the route validates
 * against {@link WATCHLIST_WINDOW_PRESET_IDS} rather than against every
 * preset.
 */
export const WATCHLIST_PERIOD_PRESETS: readonly PeriodPreset[] = PERIOD_PRESETS.filter(
  (preset) => preset.id !== "MAX",
);

/** {@link WATCHLIST_PERIOD_PRESETS}' ids — what `asEnum` validates `?window=` against, and what the screen may ask the server for. */
export const WATCHLIST_WINDOW_PRESET_IDS: readonly string[] = WATCHLIST_PERIOD_PRESETS.map(
  (preset) => preset.id,
);

/** `1Y` — the same default {@link DEFAULT_PERIOD_PRESET_ID} carries, and the same one `watchlistQuerySchema` applies server-side, so an absent `?window=` and an explicit `?window=1Y` are the same request. */
export const DEFAULT_WATCHLIST_WINDOW = DEFAULT_PERIOD_PRESET_ID;

/**
 * Mirrors `api/src/portfolios/portfolios.schema.ts`'s
 * `RETURN_WINDOW_EPOCH_FLOOR` by value (that file's own convention for this
 * exact constant — see its doc comment on why a separately-declared constant
 * beats a new cross-package dependency).
 */
export const RETURN_WINDOW_EPOCH_FLOOR = "2000-01-01";

/**
 * Mirrors `api/src/portfolios/portfolios.schema.ts`'s
 * `RETURN_WINDOW_MAX_SPAN_YEARS` by value.
 *
 * **25 now, and asserted rather than claimed.** It said 15 from T-45
 * until 2026-09-18 while the server had said 25 since 2026-08-24 (a change
 * itself restoring that constant's own mirror of
 * `PRICE_HISTORY_MAX_SPAN_YEARS` after FR-24 raised it). That change added
 * `api/src/instruments/history-window.drift.test.ts` R3 so the drift would
 * fail loudly — but R3 compares the two *api* constants, and nothing watched
 * this one, so `MAX` quietly resolved ten years short of what the server
 * would serve. `period-presets.drift.test.ts` now reads both source files and
 * asserts this pair (and {@link RETURN_WINDOW_EPOCH_FLOOR}'s) the same way,
 * without giving `web` a build-time dependency on `api`.
 *
 * Security review, T-45 (F1, MEDIUM): `resolveReturnWindow` (that file) *rejects* (400
 * `DATE_RANGE_TOO_WIDE`) an explicit `from` older than `to` minus this many
 * years — it never clamps. Before this fix, the `MAX` preset resolved `from`
 * to {@link RETURN_WINDOW_EPOCH_FLOOR} unconditionally, which is more than 15
 * years before `today` for any real "today" — the request 400s and the
 * overview screen shows only the error string (AC24 dead on that preset).
 * {@link resolvePresetRange} now bounds every preset's span to this many
 * years itself, so it never sends a request the server would reject.
 */
export const RETURN_WINDOW_MAX_SPAN_YEARS = 25;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mirrors `api/src/portfolios/portfolios.schema.ts`'s own `shiftYears` byte
 * for byte (same deliberately unclamped `setUTCFullYear` arithmetic) — used
 * only for the `MAX` preset's `today - RETURN_WINDOW_MAX_SPAN_YEARS` bound,
 * so the value computed here is guaranteed identical to what the server's
 * own `earliestAllowed` would independently compute for the same `to`,
 * whatever the leap-year/month-end edge case.
 */
function shiftYears(isoDate: string, years: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/**
 * Unlike {@link shiftYears} (which deliberately mirrors the server's own
 * unclamped arithmetic), this clamps the day-of-month to the target month's
 * last day when it overflows (e.g. "2026-05-31" minus 3 months must resolve
 * to "2026-02-28", not overflow into March) — security review, T-45 (F6,
 * LOW). Only used for the fixed-`monthsBack` presets (3M/6M/1Y/3Y/5Y), all
 * of which sit far inside {@link RETURN_WINDOW_MAX_SPAN_YEARS}, so there is
 * no server-agreement concern here the way there is for `shiftYears`.
 */
function shiftMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const firstOfTargetMonth = new Date(Date.UTC(year, month - 1 - months, 1));
  const daysInTargetMonth = new Date(
    Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth() + 1, 0),
  ).getUTCDate();
  firstOfTargetMonth.setUTCDate(Math.min(day, daysInTargetMonth));
  return firstOfTargetMonth.toISOString().slice(0, 10);
}

/** The qualifier for `presetId`'s window; an unknown id falls back to the default preset's, as `resolvePresetRange` does. */
export function periodPhrase(presetId: string): string {
  const preset =
    PERIOD_PRESETS.find((candidate) => candidate.id === presetId) ??
    PERIOD_PRESETS.find((candidate) => candidate.id === DEFAULT_PERIOD_PRESET_ID);
  return preset?.phrase ?? "";
}

export function isKnownPresetId(value: unknown): value is string {
  return typeof value === "string" && PERIOD_PRESETS.some((preset) => preset.id === value);
}

export interface ResolvedPeriodRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Resolves a preset id to a concrete `[from, to]` window. An unrecognised id
 * (never expected once `router.tsx`'s `validateSearch` has run, but this
 * function does not assume that) falls back to
 * {@link DEFAULT_PERIOD_PRESET_ID} rather than producing an invalid range.
 * `today` is an injectable parameter purely for deterministic testing,
 * mirroring `resolveReturnWindow`'s own.
 *
 * Every resolved window's span is bounded by
 * {@link RETURN_WINDOW_MAX_SPAN_YEARS} — the `MAX` preset (F1, see
 * {@link RETURN_WINDOW_MAX_SPAN_YEARS}'s own doc comment) resolves `from` to
 * `max(RETURN_WINDOW_EPOCH_FLOOR, today - RETURN_WINDOW_MAX_SPAN_YEARS)`,
 * never the epoch floor unconditionally. `YTD` is handled before that
 * fallback: it resolves to `today`'s own 1 January, a span that is always
 * well inside that bound and needs no clamp beyond the epoch floor
 * (relevant only for a `today` within {@link RETURN_WINDOW_MAX_SPAN_YEARS} of
 * it).
 */
export function resolvePresetRange(
  presetId: string,
  today: string = todayIsoDate(),
): ResolvedPeriodRange {
  const preset =
    PERIOD_PRESETS.find((candidate) => candidate.id === presetId) ??
    PERIOD_PRESETS.find((candidate) => candidate.id === DEFAULT_PERIOD_PRESET_ID);
  if (preset?.id === "YTD") {
    const [year] = today.split("-").map(Number) as [number];
    const jan1 = `${String(year)}-01-01`;
    return { from: jan1 < RETURN_WINDOW_EPOCH_FLOOR ? RETURN_WINDOW_EPOCH_FLOOR : jan1, to: today };
  }
  if (preset === undefined || preset.monthsBack === undefined) {
    const maxSpanFloor = shiftYears(today, -RETURN_WINDOW_MAX_SPAN_YEARS);
    const from =
      maxSpanFloor < RETURN_WINDOW_EPOCH_FLOOR ? RETURN_WINDOW_EPOCH_FLOOR : maxSpanFloor;
    return { from, to: today };
  }
  const from = shiftMonths(today, preset.monthsBack);
  return { from: from < RETURN_WINDOW_EPOCH_FLOOR ? RETURN_WINDOW_EPOCH_FLOOR : from, to: today };
}

/**
 * The id the period control carries in the URL when the window is two dates
 * the reader typed rather than a trailing preset.
 *
 * **Deliberately not a member of {@link PERIOD_PRESETS}.** That array is
 * mapped wholesale into `WatchlistAnalysisPanel.tsx`'s range control and is
 * filtered only of `MAX` to build {@link WATCHLIST_PERIOD_PRESETS}, so adding
 * a seventh entry here would put a custom button on the two Suivi screens —
 * where `GET /watchlist` takes `?window=<preset id>` as a server-validated
 * enum and could not honour it (the bounded series load). The selector renders this id as an extra button only
 * when the caller opts in.
 */
export const CUSTOM_RANGE_ID = "CUSTOM";

/** The visible token, matching `dividendPeriodLabel`'s own abbreviation for the same idea. */
export const CUSTOM_RANGE_LABEL = "Perso.";

/** The spelled-out form, carried as the button's `title` and `aria-label` — the abbreviated/spelled-out split every preset here already uses. */
export const CUSTOM_RANGE_LONG_LABEL = "Personnalisée…";

/**
 * A custom window as the URL carries it: both bounds optional, because the
 * reader edits one at a time and a half-typed window is a real intermediate
 * state, not a malformed one.
 */
export interface CustomRangeInput {
  readonly from?: string;
  readonly to?: string;
}

/**
 * Why a custom window cannot be requested. One member per rejection
 * `api/src/portfolios/portfolios.schema.ts`'s `resolveReturnWindow` would
 * answer with a 400, plus the two the server never sees because the client
 * refuses to ask:
 *
 * - `incomplete` — one bound still empty; nothing to reject yet.
 * - `malformed` — not an ISO calendar date. Checked with `search-params.ts`'s
 *   own `asIsoDate`, the validator every URL date in this app already passes
 *   through, so `2026-02-31` is rejected here for the same reason and by the
 *   same code as it is in the ledger's filters.
 *
 * The other four mirror `INVALID_DATE_RANGE`, `DATE_RANGE_IN_FUTURE`,
 * `DATE_RANGE_TOO_EARLY` and `DATE_RANGE_TOO_WIDE` one for one, in that
 * function's own evaluation order, so the reason shown here is the reason the
 * server would have given.
 */
export type CustomRangeRejection =
  "incomplete" | "malformed" | "reversed" | "future" | "too-early" | "too-wide";

export type CustomRangeResolution =
  | { readonly ok: true; readonly range: ResolvedPeriodRange }
  | { readonly ok: false; readonly reason: CustomRangeRejection };

/**
 * Validates a custom `[from, to]` against every bound the server enforces,
 * **before** a request is issued.
 *
 * `resolveReturnWindow` rejects an explicit out-of-bounds value rather than
 * clamping it — that is its documented posture, and T-45's F1 finding is what
 * happens when the client forgets: the request 400s and the screen shows the
 * error string instead of a window. So this function is the client's half of
 * that contract, and it checks the same four things in the same order the
 * server does, plus the two states only a half-filled form can be in.
 *
 * Returns a discriminated result rather than throwing: a half-typed window is
 * the normal case while the reader is still typing, not an exception.
 *
 * `today` is injectable purely for deterministic testing, mirroring
 * {@link resolvePresetRange}'s own parameter.
 */
export function resolveCustomRange(
  input: CustomRangeInput,
  today: string = todayIsoDate(),
): CustomRangeResolution {
  const { from, to } = input;
  if (from === undefined || to === undefined || from === "" || to === "") {
    return { ok: false, reason: "incomplete" };
  }
  if (asIsoDate(from) === undefined || asIsoDate(to) === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (from > to) return { ok: false, reason: "reversed" };
  if (to > today) return { ok: false, reason: "future" };
  if (from < RETURN_WINDOW_EPOCH_FLOOR) return { ok: false, reason: "too-early" };
  if (from < shiftYears(to, -RETURN_WINDOW_MAX_SPAN_YEARS)) {
    return { ok: false, reason: "too-wide" };
  }
  return { ok: true, range: { from, to } };
}

/**
 * The reason to show beside the two date fields. French, in this module for
 * `dividend-period-presets.ts`'s own reason — `lib/` is outside
 * `no-hardcoded-copy`'s scope (`components/**`, `routes/**`), and a preset
 * catalogue that holds its own labels is the convention this file's sibling
 * already set.
 *
 * `incomplete` has no message: a window the reader has not finished typing is
 * not an error to tell them about.
 */
export function customRangeRejectionMessage(reason: CustomRangeRejection): string | undefined {
  switch (reason) {
    case "incomplete":
      return undefined;
    case "malformed":
      return "Date invalide.";
    case "reversed":
      return "La date de début doit précéder la date de fin.";
    case "future":
      return "La date de fin ne peut pas être dans le futur.";
    case "too-early":
      return `Les données ne remontent pas avant le ${RETURN_WINDOW_EPOCH_FLOOR.split("-").reverse().join("/")}.`;
    case "too-wide":
      return `La période ne peut pas dépasser ${String(RETURN_WINDOW_MAX_SPAN_YEARS)} ans.`;
  }
}

/** {@link isKnownPresetId}, plus {@link CUSTOM_RANGE_ID} — what `router.tsx`'s `validateSearch` accepts for a screen that offers a custom window. */
export function isKnownRangeId(value: unknown): value is string {
  return value === CUSTOM_RANGE_ID || isKnownPresetId(value);
}

/**
 * The one resolver a screen calls: {@link resolveCustomRange} when the id is
 * {@link CUSTOM_RANGE_ID} **and** the window validates, {@link
 * resolvePresetRange} otherwise.
 *
 * A `CUSTOM` id carrying an out-of-bounds or half-typed window falls back to
 * the default preset's window rather than erroring — the "never throw, always
 * a safe default" posture every validator in `search-params.ts` follows, and
 * what makes a hand-edited or stale bookmarked URL harmless.
 */
export function resolveRange(
  rangeId: string,
  custom: CustomRangeInput = {},
  today: string = todayIsoDate(),
): ResolvedPeriodRange {
  if (rangeId === CUSTOM_RANGE_ID) {
    const resolved = resolveCustomRange(custom, today);
    if (resolved.ok) return resolved.range;
    return resolvePresetRange(DEFAULT_PERIOD_PRESET_ID, today);
  }
  return resolvePresetRange(rangeId, today);
}

/**
 * {@link periodPhrase} for a window that may be custom — « du 09/11/2019 au
 * 18/09/2026 » rather than a preset's wording.
 *
 * The date rearrangement is `history-status-copy.ts`'s `formatIsoDateFr`
 * inlined rather than imported: this module is `PeriodSelector`'s pure
 * dependency and pulling in a module that carries status copy and its own
 * response types to rearrange three substrings is the wrong trade. Same
 * string-only manipulation, same no-floats non-issue.
 */
export function rangePhrase(
  rangeId: string,
  custom: CustomRangeInput = {},
  today: string = todayIsoDate(),
): string {
  if (rangeId !== CUSTOM_RANGE_ID) return periodPhrase(rangeId);
  const resolved = resolveCustomRange(custom, today);
  if (!resolved.ok) return periodPhrase(DEFAULT_PERIOD_PRESET_ID);
  const fr = (isoDate: string): string => {
    const [year, month, day] = isoDate.split("-");
    return `${day}/${month}/${year}`;
  };
  return `du ${fr(resolved.range.from)} au ${fr(resolved.range.to)}`;
}
