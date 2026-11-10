import { isoDateSchema } from "@kerdial/api-contracts";
import { Decimal, parseDecimalString } from "@kerdial/core-decimal";

/**
 * French-locale cell interpretation and the unit-price derivation (ID4;
 * M1, M7, M7a, M7b).
 *
 * The lexer (`lexer.ts`) hands out raw strings and never reads a cell's
 * contents; this module is the only place that decides what a cell *means*.
 * It stays deliberately below the neutral vocabulary: it takes strings and
 * returns `Decimal`/`Date`, and `columns.ts`/`parse` (CI-8) is what assembles
 * those into a `NeutralRow`. Nothing here knows a column's position or a row
 * type's French label — the doc comments name `Valeur`/`Frais`/`Impots`/`Parts`
 * only to say which source cell a parameter is fed from.
 *
 * Every value produced here is a `Decimal`: no
 * `Number()`, no `parseFloat`, no float arithmetic on a money value at any
 * point, enforced by `eslint.config.mjs`'s `no-float-ops-on-decimal` over
 * `importer/**`. The only `Number()` calls in this file are on *date*
 * components, which are calendar integers and never money.
 *
 * No whitespace codepoint is written literally anywhere in this file: one
 * editor normalisation on a literal blank codepoint would silently reopen
 * the hole this rule exists to close.
 */

/**
 * `MALFORMED_VALUE`: a cell that cannot be parsed under OD-10(a)'s
 * strict rules. `message` is required — IMP-AC-13 forbids a bare "invalid
 * row", so every rejection here says which rule refused it.
 *
 * Absence is deliberately *not* this module's business: an empty cell is
 * rejected as malformed here, and the caller that knows whether the column is
 * required for this row's type is the one that turns that into the separate
 * `MISSING_REQUIRED_VALUE` (CI-8). Reading an empty numeric cell as zero here
 * would be exactly the silent repair OD-10(a) rules out.
 */
export interface LocaleValueProblem {
  readonly code: "MALFORMED_VALUE";
  readonly message: string;
}

/** A cell interpretation that either produced a value or refused, never both. */
export type LocaleParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: LocaleValueProblem };

/**
 * The thousands separators stripped from a numeric cell — **exactly three
 * codepoints**, written as `\uXXXX` escapes and never as
 * literal characters:
 *
 *  - **U+0020 SPACE** — defensive. In a real-world export it occurs inside
 *    names and notes, never as a thousands separator.
 *  - **U+202F NARROW NO-BREAK SPACE** — the one a real-world Portfolio
 *    Performance export actually uses, as in `2<U+202F>000,00`.
 *  - **U+00A0 NO-BREAK SPACE** — defensive only, and this is M1's binding
 *    correction to OD-10(a)'s own wording: no export this was checked against
 *    writes U+00A0 anywhere. It is accepted against a codepoint not observed,
 *    not because it was observed. Do not read its presence here as evidence
 *    that a real export writes it.
 *
 * M1's sweep was exhaustive over every cell of the exports it covered, for
 * characters in Unicode category `Zs` or matching `isspace()`, and found
 * exactly two: U+0020 and U+202F. Anything outside this set of three is
 * therefore not a separator this format is known to write, and a numeric cell
 * containing one is rejected rather than repaired.
 */
const THOUSANDS_SEPARATOR_CODEPOINTS = ["\u0020", "\u202F", "\u00A0"] as const;

/**
 * The same three codepoints as a regex character class, derived from the array
 * so the two cannot drift, and emitted as `\uXXXX` escape *text* rather than
 * raw characters so that logging or printing the pattern stays reviewable.
 */
const SEPARATOR_CLASS = `[${THOUSANDS_SEPARATOR_CODEPOINTS.map(
  (separator) => `\\u${separator.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
).join("")}]`;

/**
 * The accepted numeric shape, validated against the **raw** cell rather than
 * against whatever is left after a blind strip: an optional `-`, then either a
 * bare digit run or digit groups separated in genuine thousands positions,
 * then an optional `,` fraction.
 *
 * Validating the grouping (instead of deleting every separator wherever it
 * falls) is OD-10(a)'s "rejected, not guessed" applied to the separator
 * itself: `2<U+202F>00,00` is not a number this format writes, and reading it
 * as `200.00` would invent a value.
 *
 * Measured at CI-6, by running this module over every cell of a real-world
 * three-file export rather than by reasoning about the shape: every numeric
 * cell (`Valeur`, `Frais`, `Impots / Taxes`, `Taux de change`, both `Montant
 * brut` columns, and the assets file's TER/AUM/fee columns), every `Parts`
 * cell and every `Date` cell was accepted **except the assets file's `Total
 * Expense Ratio (TER)` column, which writes a trailing `%` (`0,13%`)** — a
 * percentage literal, not a number, and one the column table never feeds to
 * this function because it reads that column only as the boolean
 * `hasExpenseRatio`. That sweep was a one-off measurement, not a test; reading
 * a CSV file end to end is CI-8's job, against the committed synthetic
 * fixture.
 */
const FRENCH_NUMBER = new RegExp(`^-?(?:\\d+|\\d{1,3}(?:${SEPARATOR_CLASS}\\d{3})+)(?:,\\d+)?$`);

/**
 * OD-10(a)'s ambiguity rule: `<1-3 digits>,<exactly 3 digits>` is genuinely
 * undecidable between a French thousands group (`1,234` meaning 1234) and a
 * three-decimal amount (`1,234` meaning 1.234), so it is rejected outright
 * instead of being resolved by a house rule.
 *
 * **Defensive, and not exercised by any export this was checked against —
 * stated plainly so no reader infers otherwise:** the cells that need a
 * thousands separator write U+202F, never a comma. This rule exists for an export this cycle has never seen; its test is
 * synthetic.
 */
const AMBIGUOUS_COMMA_GROUP = /^-?\d{1,3},\d{3}$/;

/** The decimal mark this format uses, `,` (U+002C) — and the one it must never accept, `.` (U+002E). */
const DECIMAL_MARK = ",";
const REJECTED_DECIMAL_MARK = ".";

function malformed(message: string): { readonly ok: false; readonly problem: LocaleValueProblem } {
  return { ok: false, problem: { code: "MALFORMED_VALUE", message } };
}

/**
 * Parse a French-locale numeric cell (`Valeur`, `Frais`, `Impots / Taxes`,
 * `Parts`) into an exact `Decimal`.
 *
 * Rejects, each with its own message:
 *  - the empty cell (absence is the caller's decision — see {@link LocaleValueProblem});
 *  - a `.` anywhere in the cell, which is **not** a second accepted decimal
 *    mark;
 *  - the `<1-3 digits>,<exactly 3 digits>` ambiguity;
 *  - anything else outside {@link FRENCH_NUMBER}, which includes a separator
 *    codepoint outside the three, a separator in a non-thousands position, a
 *    leading `+`, surrounding whitespace, and exponential notation.
 */
export function parseFrenchNumber(cell: string): LocaleParse<Decimal> {
  return parseFrenchNumeral(cell, { rejectAmbiguousCommaGroup: true });
}

function parseFrenchNumeral(
  cell: string,
  options: { readonly rejectAmbiguousCommaGroup: boolean },
): LocaleParse<Decimal> {
  if (cell.length === 0) {
    return malformed("the cell is empty");
  }
  if (cell.includes(REJECTED_DECIMAL_MARK)) {
    return malformed(
      `"${cell}" uses U+002E as a decimal mark; this format's decimal mark is U+002C (a comma)`,
    );
  }
  if (options.rejectAmbiguousCommaGroup && AMBIGUOUS_COMMA_GROUP.test(cell)) {
    return malformed(
      `"${cell}" is ambiguous between a thousands group and a three-decimal amount, and is rejected rather than guessed at`,
    );
  }
  if (!FRENCH_NUMBER.test(cell)) {
    return malformed(`"${cell}" is not a French-locale decimal numeral`);
  }

  let digits = cell;
  for (const separator of THOUSANDS_SEPARATOR_CODEPOINTS) {
    digits = digits.split(separator).join("");
  }
  // `FRENCH_NUMBER` has already restricted `digits` to `-?\d+(,\d+)?`, so the
  // swap below produces exactly `parseDecimalString`'s accepted shape and it
  // cannot throw here. It is used in preference to `new Decimal(...)` because
  // it is this repository's one string -> Decimal codec (core/decimal): the
  // thing that rejects exponential notation, `NaN` and `Infinity`.
  return {
    ok: true,
    value: parseDecimalString(digits.replace(DECIMAL_MARK, REJECTED_DECIMAL_MARK)),
  };
}

/**
 * The fractional digits `transaction.quantity` (`numeric(38,18)`) can hold. A
 * `Parts` cell finer than this would be rounded by Postgres on insert, so it is
 * refused here instead of silently changed.
 */
const QUANTITY_MAX_FRACTION_DIGITS = 18;

/**
 * Parse a `Parts` cell: the same grammar as {@link parseFrenchNumber} — so the
 * thousands separator works there too (VERIFIED against a real-world export,
 * which writes a four-digit quantity as `1<U+202F>000`) — and then a
 * **positive** requirement.
 *
 * **Fractional quantities are accepted.** M7b measured 0 fractional rows in
 * the stock-account exports it was checked against and this function used to
 * require an integer; a crypto account export writes quantities such as
 * `0,00365412` BTC and `3,125` SOL on nearly every trade, and every one of
 * them was refused. The ledger stores
 * `numeric(38,18)` and every consumer divides with `Decimal`, so the integer
 * rule protected nothing downstream.
 *
 * **The `<1-3 digits>,<3 digits>` ambiguity rule does not apply here.** It is
 * defensive against an export that writes `,` as a thousands separator, which
 * this format never does (it writes U+202F — see
 * {@link THOUSANDS_SEPARATOR_CODEPOINTS}); and a three-decimal quantity
 * (`0,998`, `1,063`) is exactly what a crypto export writes. Money cells keep
 * the rule, since no real export has yet contradicted it there.
 */
export function parseFrenchQuantity(cell: string): LocaleParse<Decimal> {
  const parsed = parseFrenchNumeral(cell, { rejectAmbiguousCommaGroup: false });
  if (!parsed.ok) return parsed;
  if (!parsed.value.greaterThan(0)) {
    return malformed(`"${cell}" is not a positive quantity`);
  }
  if (parsed.value.decimalPlaces() > QUANTITY_MAX_FRACTION_DIGITS) {
    return malformed(
      `"${cell}" has more than ${QUANTITY_MAX_FRACTION_DIGITS} decimal places, finer than a quantity can be stored`,
    );
  }
  return parsed;
}

/** A source `Date` cell, split into the two fields `transaction` actually stores. */
export interface SourceTimestamp {
  /**
   * The file's own `YYYY-MM-DD` prefix, **verbatim**. Never derived from
   * {@link SourceTimestamp.tradeTs}, which is what makes the timezone question
   * safe: no interpretation of the time part can move a row to a different
   * calendar date (ID5).
   */
  readonly tradeDate: string;
  /** The `YYYY-MM-DDTHH:MM` read as Europe/Paris wall clock, as an instant. Never `null`, including for a `T00:00` row. */
  readonly tradeTs: Date;
}

/**
 * The source shape: `YYYY-MM-DDTHH:MM`, no seconds, no zone.
 * Anything else is `MALFORMED_VALUE`.
 */
const SOURCE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/**
 * A1 (an assumption the user can overrule cheaply): no source states the
 * file's timezone; Europe/Paris is inferred from the format's locale — a
 * French-language export whose every other convention is French. **This one constant is the whole fix
 * if that inference is wrong**; no data shape depends on it.
 */
const SOURCE_TIME_ZONE = "Europe/Paris";

/**
 * Resolves an instant's Europe/Paris wall clock through `Intl.DateTimeFormat`'s
 * own IANA offset resolution (Node's bundled ICU), so no new dependency and no
 * hand-written DST table. This is the same technique
 * `market/ingestion/src/market-hours.ts`'s `localDateTimeParts` uses for the
 * identical CET/CEST question; it is reimplemented here rather than imported
 * because ID1 forbids `importer` from depending on any `market/*` package
 * (enforced by `.dependency-cruiser.cjs`'s `importer-no-market` rule).
 */
const ZONE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SOURCE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `instant`'s Europe/Paris UTC offset in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(instant: Date): number {
  const parts = new Map(
    ZONE_FORMATTER.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const second = parts.get("second");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new Error(
      `locale.ts: Intl.DateTimeFormat did not produce the expected parts for time zone "${SOURCE_TIME_ZONE}"`,
    );
  }
  const asUtcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    // Some ICU builds render midnight as hour 24 even under `hourCycle: "h23"`;
    // normalised the same way `market-hours.ts` normalises it, so the offset
    // arithmetic stays inside a `[0, 24)` hour.
    Number(hour) % 24,
    Number(minute),
    Number(second),
  );
  return asUtcMs - instant.getTime();
}

/**
 * Europe/Paris wall clock -> instant, as a two-pass fixed point: the offset
 * needed to do the conversion is itself a function of the instant the
 * conversion produces, so the first pass converts at the offset in force
 * "around" the wall clock and the second re-converts if that landed on the
 * other side of a transition.
 *
 * Both DST edges are **defined, and neither throws** — a row must import
 * whatever clock reading its file carries:
 *  - **Spring-forward gap** (e.g. `2025-03-30T02:30`, a wall clock that does
 *    not exist in Paris): the second pass settles on the post-transition
 *    offset, so the instant produced is the one whose Paris wall clock reads
 *    03:30. The reading shifts forward across the gap; it is not rejected.
 *  - **Autumn-back ambiguity** (e.g. `2025-10-26T02:30`, a wall clock that
 *    happens twice): resolves to the **second**, post-transition (CET)
 *    occurrence.
 *
 * Neither choice can move a row onto another calendar date, because
 * `tradeDate` is the file's own verbatim prefix and is never read back off
 * this instant (ID5) — a property `locale.test.ts` asserts directly on both
 * transition dates rather than assuming.
 */
function parisWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const asIfUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffsetMs = zoneOffsetMs(new Date(asIfUtcMs));
  const firstGuessMs = asIfUtcMs - firstOffsetMs;
  const secondOffsetMs = zoneOffsetMs(new Date(firstGuessMs));
  return new Date(secondOffsetMs === firstOffsetMs ? firstGuessMs : asIfUtcMs - secondOffsetMs);
}

/**
 * Parse a source `Date` cell into {@link SourceTimestamp}.
 *
 * `tradeDate` is the verbatim `YYYY-MM-DD` prefix, validated against
 * `@kerdial/api-contracts`' own `isoDateSchema` — **reused, not
 * re-implemented**, so the real-calendar-date rule that
 * rejects February 31st is the same one `POST /transactions` applies and the
 * two cannot drift. (That reuse also disposes of `Date.UTC`'s two-digit-year
 * remapping below: `isoDateSchema` already refuses a year under 0100, because
 * its own `isRealCalendarDate` round-trips through the same call.)
 *
 * `tradeTs` is always populated, including for the `T00:00` rows: a real-world
 * export writes `T00:00` on older rows and a genuine intraday time on recent
 * ones, and a mixed `null`/non-`null` column would make "no time recorded" and
 * "recorded at midnight" indistinguishable in exactly the file where both
 * occur.
 */
export function parseSourceTimestamp(cell: string): LocaleParse<SourceTimestamp> {
  const match = SOURCE_TIMESTAMP.exec(cell);
  if (match === null) {
    return malformed(`"${cell}" is not a YYYY-MM-DDTHH:MM timestamp`);
  }
  const tradeDate = match[1]!;
  const hour = Number(match[2]);
  const minute = Number(match[3]);

  if (!isoDateSchema.safeParse(tradeDate).success) {
    return malformed(`"${tradeDate}" is not a real calendar date`);
  }
  if (hour > 23 || minute > 59) {
    return malformed(`"${cell}" is not a real time of day`);
  }

  const [year, month, day] = tradeDate.split("-");
  return {
    ok: true,
    value: {
      tradeDate,
      tradeTs: parisWallClockToInstant(Number(year), Number(month), Number(day), hour, minute),
    },
  };
}

/** The source cells a trade row's unit price is reconstructed from. */
export interface UnitPriceInput {
  /**
   * `ACQUIRE` for the source's `Achat`, `DISPOSE` for its `Vente`. The label
   * itself never reaches this module — mapping `Achat`/`Vente` onto these is
   * `columns.ts`'s job (CI-8).
   */
  readonly direction: "ACQUIRE" | "DISPOSE";
  /**
   * The source's `Valeur`, **with whatever sign the file wrote**. Both signs
   * are correct inputs: M6/M7a measured that the two transaction files invert
   * it for the same trade (the cash-account file writes an `Achat` as a
   * negative cash-out and the investment-account file writes it positive;
   * `Vente` mirrors that).
   */
  readonly value: Decimal;
  /** The source's `Frais`, or `null` where the cell is empty. */
  readonly fees: Decimal | null;
  /** The source's `Impots / Taxes`, or `null` where the cell is empty. */
  readonly taxes: Decimal | null;
  /** The source's `Parts`, already through {@link parseFrenchQuantity} and therefore positive. */
  readonly quantity: Decimal;
}

/**
 * ID4's unit-price formula, verbatim:
 *
 * ```
 * costs      = (Frais ?? 0) + (Impots ?? 0)
 * gross      = abs(Valeur)                      // absolute value FIRST — this is the whole point
 * netForUnit = direction === "ACQUIRE" ? gross - costs : gross + costs
 * unitPrice  = netForUnit / Parts
 * ```
 *
 * **Why the order of those two middle lines is the entire content of this
 * function.** `Valeur` means different things per direction — for `Achat` it
 * is the total cash paid *including* costs, for `Vente` it is the net proceeds
 * *after* costs — and the two files write it with opposite signs. So any
 * formula that folds the costs into the numerator *before* taking the absolute
 * value (the shape `abs(Valeur - Frais - Impots) / Parts`) is correct in
 * exactly one of the two files and silently wrong in the other. M7a settled
 * that by exhaustive count over a real-world pair of transaction files rather
 * than by worked example, scoring a row clean when its derived price is
 * exactly representable at 4 dp: the folded formula scored markedly lower on
 * the cash-account file than on the investment-account file, while this
 * function scored the same in both — file-dependent versus sign-independent.
 *
 * The committed synthetic fixture reproduces the property through this
 * function itself: every one of its 33 trades per file derives the same price
 * from both files, and 32 of the 33 are clean at 4 dp
 * (`precycle-derivations.test.ts` pins 64/66).
 *
 * **The result is exact, and nothing here rounds** (M7b). For some trades it
 * does not terminate — the fixture's `2022-03-10 Achat SXR8.DE`, `Parts=3`,
 * `Valeur=1<U+202F>238,95`, `Frais=4,95` gives `1234.00 / 3 =
 * 411.3333...` — and that is expected and correct, not an error:
 * `transaction` stores `numeric(38,12)`, at which precision the
 * reconstruction error `abs(Parts * round(unitPrice, 12) - netForUnit)` is of
 * the order of 1e-11 EUR per trade. Rounding to 2 or 4 dp here would turn a
 * 1e-11 error into a 1e-3 one for no benefit, so non-termination is never a
 * rejection.
 *
 * Positivity (`AMOUNT_NOT_POSITIVE`, IMP-18) is not checked here: that is a
 * row-level validation rule with its own reason code, and its caller decides.
 */
export function deriveUnitPrice(input: UnitPriceInput): Decimal {
  if (!input.quantity.greaterThan(0)) {
    // Not a `MALFORMED_VALUE`: `parseFrenchQuantity` is the gate that rejects a
    // non-positive `Parts` under that code, so reaching here means a caller
    // bypassed it — a programming error, and a divide-by-zero if let through
    // (decimal.js answers `Infinity` rather than throwing).
    throw new RangeError(
      `deriveUnitPrice: quantity must be positive (parseFrenchQuantity is what enforces that), got ${input.quantity.toFixed()}`,
    );
  }
  return deriveSettledPrincipal(input).dividedBy(input.quantity);
}

/**
 * {@link deriveUnitPrice}'s `netForUnit`, before the division: the trade's
 * principal in the currency `Valeur` is written in, i.e. the settling
 * account's. On a foreign-currency trade this is the settled amount the
 * ledger requires when that account is in neither the trade's currency nor
 * the base currency. It matches `Montant brut × Taux de change` to the cent on
 * a crypto export (the fixture's `325,40 − 0,71 = 324,69 ≈ 298,70 × 1,0870`),
 * and is preferred to that product because it is the figure the account
 * actually moved by, not a re-multiplied rate.
 */
export function deriveSettledPrincipal(input: Omit<UnitPriceInput, "quantity">): Decimal {
  const costs = (input.fees ?? new Decimal(0)).plus(input.taxes ?? new Decimal(0));
  const gross = input.value.abs();
  return input.direction === "ACQUIRE" ? gross.minus(costs) : gross.plus(costs);
}

/** The source cells a foreign-currency trade's *native* unit price is reconstructed from. */
export interface NativeUnitPriceInput {
  /** The source's `Montant brut`, in the trade's own (non-settlement) currency, whatever sign the file wrote. */
  readonly grossAmount: Decimal;
  /** The source's `Parts`, already through {@link parseFrenchQuantity} and therefore positive. */
  readonly quantity: Decimal;
}

/**
 * The unit price for a trade the source recorded in a currency other than the
 * settlement account's own — `abs(Montant brut) / Parts`, and nothing else.
 *
 * Unlike {@link deriveUnitPrice}, this never touches `Frais`/`Impôts / Taxes`:
 * those two cells are the *settlement* account's own currency, not the
 * trade's — verified by reconciling `Valeur = Montant brut × Taux de change ±
 * Frais ± Impôts` (sign per direction) against the foreign-currency trade rows
 * and a dividend row of a real-world export, every one matching to sub-5-cent
 * rounding, which
 * is `Taux de change`'s own display precision (4 dp) propagating through the
 * conversion. Folding a EUR figure into a per-unit *native-currency* price
 * would mix two currencies in one arithmetic expression, so it is left where
 * it belongs: on the settlement leg, applied in EUR by the write service's
 * own cost handling, exactly as it already is for a same-currency trade.
 */
export function deriveNativeUnitPrice(input: NativeUnitPriceInput): Decimal {
  if (!input.quantity.greaterThan(0)) {
    throw new RangeError(
      `deriveNativeUnitPrice: quantity must be positive (parseFrenchQuantity is what enforces that), got ${input.quantity.toFixed()}`,
    );
  }
  return input.grossAmount.abs().dividedBy(input.quantity);
}
