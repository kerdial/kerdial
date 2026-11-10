/**
 * `quick-search.ts` — UR-37 (FR-97). The two small, pure
 * predicates `QuickSearch.tsx` needs to decide what to show and what to
 * fetch — kept out of the component so they can be asserted directly,
 * without mounting anything.
 */

/**
 * Mirrors `api/src/instruments/instruments.schema.ts`'s private
 * `hasThreeAlphanumericChars` (that file's own comment: the `pg_trgm` GIN
 * index backing `GET /instruments?query=` only pays off for 3+ character
 * trigrams, so a shorter query forces a sequential scan). That function is
 * not exported — private to its module — so this is a deliberate, literal
 * copy rather than an import. `quick-search.test.ts`'s own cases mirror the
 * server schema's three documented bypasses (`"a  "`, `"..."`, `"a_b"`) so a
 * future edit to either regex that drifts from the other is caught there,
 * the same "shared fixture, not a shared import" mirroring convention
 * `api-limits.ts` uses for numeric caps (drift-tested where the source is
 * exported, reproduced-with-a-fixture where it is not).
 */
function hasThreeAlphanumericChars(value: string): boolean {
  return /[a-zA-Z0-9].*[a-zA-Z0-9].*[a-zA-Z0-9]/.test(value);
}

/**
 * The client-side gate for both `quickSearchInstrumentsQueryOptions` (the
 * fetch) and `QuickSearch.tsx`'s own "type at least 3 characters" hint (the
 * copy) — the same predicate backs both, so the hint can never be visible
 * while the query is also enabled, or vice versa.
 */
export function meetsInstrumentSearchMinimum(query: string): boolean {
  return hasThreeAlphanumericChars(query.trim());
}

/**
 * `GET /portfolios` has no server-side text search, and does not need one —
 * this filters the already-cached list, client-side, in memory. An empty
 * query matches every portfolio (the palette's "jump to any portfolio"
 * default view before the user has typed anything), not zero — the instrument
 * half withholds its own request below 3 alphanumeric characters, but there
 * is no equivalent request to withhold here.
 */
export function matchesPortfolioName(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return name.toLowerCase().includes(needle);
}
