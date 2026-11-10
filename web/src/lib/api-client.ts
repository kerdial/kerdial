/**
 * The `/api/v1` client, split by domain: `api/core.ts`
 * holds the fetch wrapper, `ApiError` and the CSRF/abort conventions;
 * `api/auth.ts`, `api/admin.ts` (`account-setup` FR-421/FR-422/FR-424), `api/portfolios.ts`, `api/instruments.ts`,
 * `api/transactions.ts`, `api/imports.ts`, `api/fx.ts` (the Devises screen's
 * `/market-data/fx*`), `api/market-data.ts` (the on-demand quote-refresh
 * trigger), `api/dividends.ts` (the Dividendes screen's one read, DS-6) and
 * `api/watchlist.ts` (the five `/watchlist/*` routes)
 * hold the typed endpoint wrappers and their mirrored wire types. This barrel re-exports the exact public surface the original
 * single-file module had, so every existing `../lib/api-client.js` import
 * keeps working unchanged; `apiFetch`/`API_BASE` stay internal to `lib/api/`.
 */
export { ApiError } from "./api/core.js";
export * from "./api/auth.js";
export * from "./api/admin.js";
export * from "./api/portfolios.js";
export * from "./api/instruments.js";
export * from "./api/transactions.js";
export * from "./api/imports.js";
export * from "./api/fx.js";
export * from "./api/market-data.js";
export * from "./api/dividends.js";
export * from "./api/watchlist.js";
export * from "./api/settings.js";
