import { parseDecimalString } from "@kerdial/core-decimal";

/**
 * Column sorting for the Positions and Instruments tables.
 *
 * Both screens render a virtualised list over an array the caller already
 * holds, so sorting is a pure transform applied before virtualisation — no
 * server round trip, and no interaction with paging (neither table pages;
 * Instruments' catalogue mode pages server-side and sorts only the page it was
 * given, which is stated on that screen rather than implied).
 *
 * ## Two rules the comparators exist to enforce
 *
 * **Sort the value, never the rendered text.** A money column formatted as
 * `1 234,50 EUR` sorts as a string into nonsense — `"9,00"` after `"1 234,50"`
 * — and a French-formatted number cannot be `Number()`d back either (comma
 * decimal, U+202F group separator). {@link compareDecimalText} parses through
 * `@kerdial/core-decimal`, the same codec the figures themselves round-trip
 * through, so the order matches the arithmetic the rest of the app does.
 *
 * **Absent values sort last in both directions.** A holding with no price and
 * a row whose history never ran render `—`; floating them to the top on every
 * ascending sort would bury the data the user asked to see. "Last" is not a
 * direction-dependent choice here — it is "least interesting", which does not
 * flip.
 */
export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  readonly key: K;
  readonly direction: SortDirection;
}

/**
 * The next state for a header click: a new column starts ascending, the
 * current column flips, and a third click on the same column clears the sort
 * and restores the caller's own order.
 *
 * Clearing matters on these two screens: Positions arrives ordered by the
 * server and Instruments by the derivation, and neither order is reproducible
 * by any column the user can click. Without a way back, sorting once would be
 * a one-way door.
 */
export function nextSortState<K extends string>(
  current: SortState<K> | undefined,
  key: K,
): SortState<K> | undefined {
  if (current?.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return undefined;
}

/** `aria-sort` for a header cell — `"none"` on every column that is not the sorted one. */
export function ariaSortFor<K extends string>(
  state: SortState<K> | undefined,
  key: K,
): "ascending" | "descending" | "none" {
  if (state?.key !== key) return "none";
  return state.direction === "asc" ? "ascending" : "descending";
}

/** Absent last in both directions; `0` when both are absent, so the sort stays stable. */
function compareAbsent(a: unknown, b: unknown): number | undefined {
  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return undefined;
}

/**
 * French-aware text comparison — `numeric` so `Titre 2` precedes `Titre 10`,
 * and base sensitivity so accents and case do not split otherwise-adjacent
 * names.
 */
const TEXT_COLLATOR = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

export function compareText(a: string | null | undefined, b: string | null | undefined): number {
  const absent = compareAbsent(a, b);
  if (absent !== undefined) return absent;
  return TEXT_COLLATOR.compare(a as string, b as string);
}

/**
 * Compares two decimal **strings** as numbers, through the same codec the
 * figures use. A value the codec rejects is treated as absent rather than as
 * zero — a malformed amount is not "worth nothing", and sorting it as zero
 * would place it among real figures.
 */
export function compareDecimalText(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const absent = compareAbsent(a, b);
  if (absent !== undefined) return absent;
  let left;
  let right;
  try {
    left = parseDecimalString(a as string);
  } catch {
    left = undefined;
  }
  try {
    right = parseDecimalString(b as string);
  } catch {
    right = undefined;
  }
  const parsedAbsent = compareAbsent(left, right);
  if (parsedAbsent !== undefined) return parsedAbsent;
  return (left as { comparedTo(other: unknown): number }).comparedTo(right);
}

/** ISO date/instant strings compare lexicographically, which is also chronologically. */
export function compareIso(a: string | null | undefined, b: string | null | undefined): number {
  const absent = compareAbsent(a, b);
  if (absent !== undefined) return absent;
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

/**
 * Ranks a value against a fixed order — for enum-ish columns (history status,
 * asset class) where alphabetical order says nothing useful. A value absent
 * from the order sorts last, like any other absent value.
 */
export function compareRank<T>(a: T | undefined, b: T | undefined, order: readonly T[]): number {
  const rank = (value: T | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const index = order.indexOf(value);
    return index === -1 ? undefined : index;
  };
  const left = rank(a);
  const right = rank(b);
  const absent = compareAbsent(left, right);
  if (absent !== undefined) return absent;
  return (left as number) - (right as number);
}

/**
 * Applies a sort without mutating the caller's array.
 *
 * `isMissing` is separate from `compare` on purpose, and it is the whole reason
 * absent-last survives a descending sort: if absence were encoded in the
 * comparator's return value, negating that value for `desc` would flip it and
 * float every `—` row to the top — the exact behaviour the module header says
 * this must not have. Here the direction is applied **only** to the comparison
 * of two present values.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  state: SortState<K> | undefined,
  compare: (a: T, b: T, key: K) => number,
  isMissing: (row: T, key: K) => boolean,
): readonly T[] {
  if (state === undefined) return rows;
  const { key, direction } = state;
  return [...rows].sort((a, b) => {
    const aMissing = isMissing(a, key);
    const bMissing = isMissing(b, key);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    const result = compare(a, b, key);
    return direction === "asc" ? result : -result;
  });
}
