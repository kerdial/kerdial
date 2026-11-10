/**
 * `copy/months.ts` — the French calendar months, shared by every year × month
 * calendar (`HeatCalendar.tsx`: the Dividendes screen's, and
 * the Activité screen's « Calendrier » tab).
 *
 * The calendar's month letters and full names are copy: the single letter is
 * what a reader scans as a column header, the full name is what a screen
 * reader hears and what the detail line prints, and both are French, so both
 * live here rather than in a component. Moved out of `copy/dividends.ts` when
 * a second calendar needed them — the months are nobody's screen.
 */

/**
 * The twelve months, index 0 = January. `letter` is the column header a reader
 * scans (J F M A M J J A S O N D — three Js and two Ms, which is why the full
 * name is the accessible text and the letter is `aria-hidden`); `name` is the
 * lower-case French month for the detail line and the cell's accessible name.
 */
export const MONTHS: readonly { readonly letter: string; readonly name: string }[] = [
  { letter: "J", name: "janvier" },
  { letter: "F", name: "février" },
  { letter: "M", name: "mars" },
  { letter: "A", name: "avril" },
  { letter: "M", name: "mai" },
  { letter: "J", name: "juin" },
  { letter: "J", name: "juillet" },
  { letter: "A", name: "août" },
  { letter: "S", name: "septembre" },
  { letter: "O", name: "octobre" },
  { letter: "N", name: "novembre" },
  { letter: "D", name: "décembre" },
];

/** `"01".."12"`, index-aligned with {@link MONTHS}. */
export const MONTH_KEYS: readonly string[] = MONTHS.map(
  (_, index) => `${index < 9 ? "0" : ""}${String(index + 1)}`,
);

/** The lower-case French name of a `YYYY-MM` period's month — `"mai"` — or the raw `MM` when it is not one of the twelve. */
export function monthName(period: string): string {
  const [, month] = period.split("-") as [string, string];
  // A string lookup, not `Number(month) - 1`: the web has no float rule to key
  // a type-aware check off, so `Number()` is banned syntactically here.
  return MONTHS[MONTH_KEYS.indexOf(month)]?.name ?? month;
}

/** « Mai 2025 » — the detail line's period, capitalised because it opens the sentence. */
export function monthLabel(period: string): string {
  const [year] = period.split("-") as [string, string];
  const name = monthName(period);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}
