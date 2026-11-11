import type { MinorUnitOf } from "./posting-expander.js";

/**
 * The ISO 4217 minor units of the currencies the expander suites use, for
 * calling `expandPostings` without a database. Production reads them from the
 * `currency` table; an unknown code throws here exactly as it does there, so
 * a suite cannot silently round in a currency it never declared.
 */
const MINOR_UNITS: ReadonlyMap<string, number> = new Map([
  ["EUR", 2],
  ["USD", 2],
  ["CHF", 2],
  ["GBP", 2],
  ["JPY", 0],
]);

export const testMinorUnitOf: MinorUnitOf = (currency) => {
  const minorUnit = MINOR_UNITS.get(currency.trim());
  if (minorUnit === undefined) throw new Error(`no test minor unit for ${currency}`);
  return minorUnit;
};
