/**
 * `resolveMinorUnit` — the screen-level boundary note N1 (T-44's review of
 * T-43) calls for: `<Figure>`'s own
 * `assertValidScale` deliberately *throws* on a bad `scale` (a caller bug —
 * blanking the whole route is the right behaviour for that case,
 * `Figure.tsx`'s own doc comment). A `minorUnit` that instead *originates
 * from the API* (here: derived from a `ValuedAmount.currency` code this
 * screen does not control) is a different class of problem — a currency
 * code this build's small local table does not recognise must degrade
 * gracefully (a safe default), not blank the overview/holdings route.
 *
 * `platform/db`'s `currency` table (seeded from the full ISO 4217 list,
 * `platform/db/src/seed-data/iso-4217-currencies.ts`) is the authoritative
 * source of a currency's real `minorUnit`. DD12 (IC-12) added `GET /currencies` to
 * the API surface, but this is a **display-formatting** concern deliberately
 * **not** replaced by that endpoint in this cycle:
 * this table is consumed synchronously during rendering, where an async
 * fetch would be a regression. This is a deliberately small, hand-maintained
 * mirror of the ISO 4217 *exceptions* (0 and 3 decimal-place currencies)
 * rather than a duplicate of the full 182-row table; every currency not
 * listed below (including every currency this phase-1 slice actually issues
 * — EUR, USD, the FX pairs T-31/T-32 route through) falls through to the
 * 2-decimal default, which is correct for the overwhelming majority of ISO
 * 4217.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export const DEFAULT_MINOR_UNIT = 2;

/**
 * Never throws, and always returns a non-negative integer — an
 * unrecognised/malformed `currency` (empty string, lowercase, a stray
 * whitespace-padded value, or anything else a hostile/buggy server response
 * might carry) degrades to {@link DEFAULT_MINOR_UNIT} rather than producing
 * a value `<Figure>`'s `assertValidScale` would reject.
 */
export function resolveMinorUnit(currency: string | undefined): number {
  const code = (currency ?? "").trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return DEFAULT_MINOR_UNIT;
}
