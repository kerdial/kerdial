/**
 * Barrel for the TanStack Query options/mutation factories, split by domain:
 * `queries/auth.ts`, `queries/admin.ts` (`account-setup`'s « Utilisateurs » key), `queries/portfolios.ts`,
 * `queries/instruments.ts` (incl. currencies, discovery, history-status and
 * manual prices), `queries/transactions.ts` (incl. the UR-26 instrument scan
 * and UR-38 income totals) and `queries/instrument-set.ts` (the holdings ∪
 * transactions union), `queries/fx.ts` (the Devises screen) and `queries/dividends.ts`
 * (DS-6, the Dividendes screen's single key) and `queries/watchlist.ts` (the
 * Watchlist screen's `rows`/`ids` keys and its three mutations).
 * Import paths are unchanged: everything is re-exported
 * here, and prose citations of `queries.ts` stay accurate.
 */
export * from "./queries/auth.js";
export * from "./queries/admin.js";
export * from "./queries/portfolios.js";
export * from "./queries/instruments.js";
export * from "./queries/transactions.js";
export * from "./queries/instrument-set.js";
export * from "./queries/fx.js";
export * from "./queries/dividends.js";
export * from "./queries/watchlist.js";
export * from "./queries/settings.js";
