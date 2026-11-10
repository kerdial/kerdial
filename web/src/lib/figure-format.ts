import {
  Decimal,
  formatFxRate,
  formatMonetary,
  formatPercentage,
  formatQuantity,
  parseDecimalString,
} from "@kerdial/core-decimal";

/**
 * `figure-format.ts` — UR-5 (OD-4).
 *
 * Pure move out of `Figure.tsx`: `formatAmount`, `tryFormatAmount` (including
 * its F2 malformed-input -> `undefined` degradation and its DEV-only
 * `console.warn`) and `assertValidScale` moved here **verbatim** — no
 * behaviour change — so a second, non-provenance renderer
 * (`<LedgerAmount>`, UR-18) can reuse the same formatting/degradation without
 * inheriting `<Figure>`'s badge/tooltip vocabulary. `Figure.tsx` now imports
 * these instead of defining them.
 *
 * **Strengthened, testable invariant: only this file may
 * import `formatMonetary`/`formatQuantity`/`formatPercentage`/`formatFxRate`
 * from `@kerdial/core-decimal` anywhere in `web/src`.** Enforced by
 * `figure-format-sole-importer.test.ts`. `<Figure>` remains the sole renderer
 * of the `ValuedAmount` shape (FR-127/AC119) — this module only owns the
 * formatting arithmetic both renderers share, not the provenance mechanism.
 */

/**
 * `monetary` is the shape (`scale` = the
 * currency's `minorUnit`); `quantity`/`percentage`/`fxRate` cover the rest of
 * "every monetary/quantity figure in the UI" (T-43) via
 * `@kerdial/core-decimal`'s other three display formatters. `scale` is
 * ignored for every kind but `monetary`.
 */
export type FigureKind = "monetary" | "quantity" | "percentage" | "fxRate";

/** U+2212 MINUS SIGN. Not U+002D HYPHEN-MINUS, and not U+2013 EN DASH. */
const MINUS_SIGN = "\u2212";

/**
 * U+202F NARROW NO-BREAK SPACE — the French thousands separator, and the one
 * `Intl.NumberFormat("fr-FR")` emits. Never a plain space (a column would wrap
 * inside a number) and never a comma (the decimal point stays `.`, so a comma
 * would read as a second decimal mark).
 */
export const THOUSANDS_SEPARATOR = "\u202f";

/**
 * Groups the integer part of an already-formatted decimal string in threes
 * (`1234567.89` → `1 234 567.89`). Display-only
 * ("€128,430.12" — numbers on this screen are read at a glance, and a five- or
 * six-digit total without grouping is the single hardest thing to read on the
 * dashboard). The wire, CSV export and every form field keep the ungrouped
 * form; this runs only at the `<Figure>` boundary.
 */
export function groupThousands(formatted: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(formatted);
  if (match === null) return formatted;
  const [, sign, integer, fraction = ""] = match as unknown as [string, string, string, string?];
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
  return `${sign}${grouped}${fraction ?? ""}`;
}

/**
 * Swaps the ASCII hyphen a `Decimal` formatter emits for a true minus.
 *
 * Every negative figure uses U+2212. The reason is typographic rather than pedantic: a hyphen is
 * drawn short and high against a lining figure, so a column of negatives reads
 * ragged next to the positives it is meant to align with — and money figures
 * sit in a tabular column on nearly every screen.
 *
 * **This lives here rather than in `@kerdial/core-decimal`** deliberately.
 * Those formatters are shared with the API, where the output is a wire value
 * that must stay machine-parseable — `parseDecimalString` would reject its own
 * output if it ever came back with a U+2212 in it. `figure-format.ts` is the
 * boundary where a wire string becomes display text, and display is the only
 * place the substitution is correct.
 *
 * Only a leading sign is replaced. A hyphen anywhere else in a formatted number
 * would be a bug in the formatter, not a character to silently rewrite.
 */
function toDisplayMinus(formatted: string): string {
  return formatted.startsWith("-") ? MINUS_SIGN + formatted.slice(1) : formatted;
}

export function formatAmount(kind: FigureKind, amount: Decimal, scale: number): string {
  switch (kind) {
    case "monetary":
      return toDisplayMinus(groupThousands(formatMonetary(amount, scale)));
    case "quantity":
      return toDisplayMinus(groupThousands(formatQuantity(amount)));
    case "percentage":
      return toDisplayMinus(formatPercentage(amount));
    case "fxRate":
      return toDisplayMinus(formatFxRate(amount));
  }
}

/**
 * A computed amount written **into a form field** (the rate chips,
 * transaction-dialog-refresh): the wire form — `.` decimal mark,
 * no thousands grouping, an ASCII `-` — rounded half-up to `scale` places
 * with the trailing zeros kept (`"2.00"`, not `"2"`). Not display text: the
 * field's value goes through `zDecimal`, which a U+202F or U+2212 would fail.
 * Lives here because this file is the sole importer of `formatMonetary`, and
 * `.toFixed` is lint-banned in `web/`.
 */
export function formatInputAmount(amount: Decimal, scale: number): string {
  return formatMonetary(amount, scale);
}

/**
 * Carry-forward from T-43's review (T-44): a null/non-integer
 * `scale` is a caller bug — a bad `minorUnit` resolved from the currency
 * table, or a call site simply passing the wrong type — not a hostile
 * server-controlled value. It must fail loudly (an uncaught throw a test can
 * observe), never be swallowed into the same "—" degradation a malformed
 * `amount` string gets from {@link tryFormatAmount}'s catch below. Called
 * *before* `tryFormatAmount` runs, deliberately outside its try/catch, so
 * this throw is never caught by it. Ignored for every `kind` but `monetary`
 * (`scale` is unused by the other three formatters).
 */
export function assertValidScale(kind: FigureKind, scale: number): void {
  if (kind !== "monetary") return;
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(
      `<Figure>: scale must be a non-negative integer for kind="monetary", got ${String(scale)}`,
    );
  }
}

/**
 * Security review F2 (T-43): the caller's `amount` is server-controlled JSON
 * with no runtime response validation in front of it (no shared-Zod-schema
 * package covers *response* envelopes yet) — an unguarded server-side
 * Decimal division (or any other bug) producing "Infinity"/"NaN"/exponential
 * notation reaches `parseDecimalString` (@kerdial/core-decimal) exactly
 * as-is, and it throws a `RangeError` on all three. An uncaught throw here is
 * not scoped to one figure: for `<Figure>`'s call site it would blank the
 * *entire* route via the router's `CatchBoundary`, taking every other —
 * otherwise valid — figure on the page down with it. `undefined` is returned
 * on failure rather than a guessed/rounded number.
 *
 * Carry-forward from T-43's review (T-44): a DEV-only
 * `console.warn` on the swallowed error, so a genuinely malformed server
 * response is still visible to a developer during local/dev testing —
 * production builds (`import.meta.env.DEV === false`) stay silent, matching
 * the shipped behaviour before this warning was added.
 */
export function tryFormatAmount(
  kind: FigureKind,
  amount: string,
  scale: number,
): string | undefined {
  try {
    return formatAmount(kind, parseDecimalString(amount), scale);
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("<Figure>: failed to format amount — rendering the unavailable placeholder", {
        kind,
        amount,
        scale,
        err,
      });
    }
    return undefined;
  }
}
