import { ISO_3166_COUNTRIES } from "@kerdial/core-reference-data";

/**
 * The country picker's filter (FR-737, AC-635) — a pure function over the
 * embedded ISO 3166-1 list, so `CountryPicker` owns no matching rule of its
 * own and the rule is unit-tested without a DOM.
 *
 * A row matches when its **folded French name contains** the folded query
 * (« etat » finds « États-Unis » and « Îles Vierges des États-Unis »), or when
 * its **code starts with** the upper-cased query (« jp » finds « Japon »). The
 * fold is `normalize("NFD")`, combining marks stripped, `toLocaleLowerCase("fr")`
 * — so case and accents never decide a match, in either the query or the name.
 *
 * No debounce and no index: 249 local rows, folded once at module load. The
 * result keeps the list's own order (French collation, stored that way so no
 * browser ICU ever reorders it), so this never sorts.
 */
type IsoCountry = (typeof ISO_3166_COUNTRIES)[number];

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
}

const FOLDED_NAMES: readonly string[] = ISO_3166_COUNTRIES.map((country) => fold(country.nameFr));

/**
 * The rows to offer for `query`, minus `excludedCodes` (the codes already
 * chosen in other rows of a weight set). An empty or blank query offers every
 * row that is not excluded.
 */
export function filterCountries(
  query: string,
  excludedCodes: ReadonlySet<string> = new Set(),
): readonly IsoCountry[] {
  const trimmed = query.trim();
  const folded = fold(trimmed);
  const codePrefix = trimmed.toUpperCase();
  return ISO_3166_COUNTRIES.filter((country, index) => {
    if (excludedCodes.has(country.code)) return false;
    if (trimmed === "") return true;
    return (FOLDED_NAMES[index] ?? "").includes(folded) || country.code.startsWith(codePrefix);
  });
}
