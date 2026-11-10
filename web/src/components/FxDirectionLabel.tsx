/**
 * The stated UI mitigation for R12 (T-44): shows an FX rate's direction explicitly ("1 USD = ___ EUR") so a
 * user cannot pin an inverted rate by accident. Renders nothing until both
 * sides are present and actually differ — a field still being typed, or a
 * same-currency pair, has no direction ambiguity to disambiguate.
 *
 * `minLength` defaults to 3 (a currency code, `/^[A-Z]{3}$/`) so a
 * half-typed currency does not flash a premature label; the settlement leg's
 * own usage (F2 security review, T-44: the
 * settlement asset's rate is pinned to base currency, not between two
 * ISO currencies) passes `minLength={1}` since an instrument symbol has no
 * fixed length.
 */
export function FxDirectionLabel({
  from,
  to,
  minLength = 3,
}: {
  from: string;
  to: string;
  minLength?: number;
}) {
  const fromCode = from.trim().toUpperCase();
  const toCode = to.trim().toUpperCase();
  if (fromCode.length < minLength || toCode.length < minLength || fromCode === toCode) return null;
  return (
    <p data-testid="fx-direction-label" className="k-field-hint">
      1 {fromCode} = ___ {toCode}
    </p>
  );
}
