/**
 * `ledger` — write side: transactions, postings, portfolios, instruments.
 * T-11 built the instrument identity service
 * (component C4); T-12 adds the instrument provider mapping service (also
 * C4); T-17 adds the portfolio management service (component C9); T-18 adds the
 * `FxRateResolver` (also C9 — the FR-57 precedence
 * rule); T-19 adds `TransactionWriteService` for BUY/SELL/DEPOSIT/WITHDRAWAL
 * and T-20 extends it with DIVIDEND/DRIP/CURRENCY_EXCHANGE and asset-settled
 * trades (also C9); T-21 adds the posting expander,
 * which every one of those write paths now runs inside its own DB
 * transaction. T-22 adds the in-place edit, hard delete, and `correctFxRate()`
 * correction path (also C9) — the last being the
 * only code path in the repo that sets `app.fx_correction`, the one sanctioned
 * bypass of the FX-immutability trigger. T-36 adds `manual-price-service.js`
 * (also C12) — the CRUD write side of the tenant-owned
 * `manual_price_point` table (an OPCVM NAV being the first-class case),
 * whose read/precedence half (`resolvePrice`, T-28) already lives in
 * `@kerdial/core-domain` and is wired into `valuation`'s materialisation
 * (T-30).
 *
 * T-30 adds `recomputeAndInvalidate` (`materialization.js`, also C9/C11) —
 * the write-path full recompute of `holding_state`/
 * `cash_balance`/`realized_gain` and `portfolio_daily_valuation`
 * invalidation every write method above now calls — and
 * `loadPositionTimeline` (`position-replay.js`), the shared "stored row →
 * pure movement" projection both the write-path recompute and
 * `valuation`'s read-path materialisation build a `PositionTimeline` from.
 *
 * T-37 (component C13, the `api` package's instruments/portfolios endpoints)
 * adds two read-side pieces this module had not needed before: `instrument-
 * service.js`'s `listInstruments`/`getInstrumentById` (the `GET /instruments`
 * search/resolve and `GET /instruments/:id` reads T-11 itself never built),
 * and `instrument-price-history-service.js` (the merged automated +
 * tenant-owned-manual price series `GET /instruments/:id/prices` reads).
 * T-37 also wires two things into `transaction-write-service.js` that T-35
 * deliberately deferred to it (T-35 entry): the
 * "first transaction referencing an instrument" backfill trigger
 * (`ensureInstrumentBackfillRequested`, `@kerdial/market-ingestion`) and a
 * `tradeDate` lower-bound at the write boundary, both documented on
 * `TransactionWriteService`'s own class comment.
 *
 * T-38 (the `api` package's transactions endpoints) adds
 * `transaction-read-service.js`'s `listTransactions`/`getTransactionById` —
 * the plain, filterable read side `GET /transactions`/`GET /transactions/:id`
 * need, which no earlier task built (T-19/T-20/T-22's scope was write/edit/
 * delete only).
 *
 * This module must never import `market/adapters` — enforced by the root dependency-cruiser config,
 * `.dependency-cruiser.cjs`. It *may* import `market/ingestion` in
 * production code (no such rule exists for that package) — T-37 is the first
 * task to do so, for exactly the backfill-trigger composition above.
 */
export * from "./instrument-service.js";
export * from "./instrument-provider-map-service.js";
export * from "./instrument-price-history-service.js";
export * from "./instrument-backfill-status-service.js";
/**
 * The freshness half of `GET /instruments/:id/history-status`: the last
 * quote instant and the newest daily-series date, neither of which the backfill
 * bookmark beside them reports.
 *
 * **Named, not `export * from`**, unlike every line around it:
 * `scripts/unused-exports-gate.ts`'s `STAR_REEXPORT_BUDGET` pins this file at
 * 20 star re-exports and says they may only be lowered, because knip cannot
 * attribute names through one — so a star line here would both fail that gate
 * and hide this module's surface from it. Naming the three symbols keeps them
 * inside the gate.
 */
export {
  getInstrumentPriceFreshness,
  type InstrumentPriceFreshnessRecord,
} from "./instrument-price-freshness-service.js";
/**
 * The instrument, price-history start and acquisition-price suggestion a
 * portfolio-level `VALUATION_PRICE_UNAVAILABLE` names. Named, not starred, for
 * `STAR_REEXPORT_BUDGET`'s reason stated above.
 */
export { describePriceGap } from "./price-gap-service.js";
export * from "./currency-service.js";
export * from "./portfolio-service.js";
/** CA-13 — create/rename/archive for the named cash accounts a portfolio holds. No delete: OD-5(c) locked archive, and `deletePortfolio`'s cascade is the only path that removes a row. */
export * from "./cash-account-service.js";
/** SH-18 — the tenant-scoped holdings enumeration `POST /market-data/quote-refresh` fans out over (never `fetchHeldInstruments`, which is cross-tenant by design). */
export * from "./tenant-holdings-service.js";
export * from "./manual-price-service.js";
/** `instrument-icons` IK6 — the write side of the per-tenant `instrument_icon` table, plus its two reads. The only `ledger` write that fans out to nothing: an icon is presentation, so it bumps no epoch and invalidates no valuation. */
export * from "./instrument-icon-service.js";
/**
 * `portfolio-details` PD-T5 — the lifetime of a `portfolio_icon` row: set/replace, remove, read.
 * Like the instrument-icon service it fans out to nothing.
 *
 * **Named, not `export * from`**, for the reason the two blocks below and above
 * state: `scripts/unused-exports-gate.ts`'s `STAR_REEXPORT_BUDGET` pins this
 * file at 20 star re-exports and allows only lowering, so a 21st star line
 * would fail that gate *and* hide this module's surface from it.
 *
 * **No `@public` tag, unlike `watchlist` T-64's block below when it shipped** —
 * and the difference is measured, not assumed. These symbols' HTTP consumers
 * (`api/src/portfolios/portfolios.controller.ts`'s three icon routes) land in
 * **PD-T7**, one batch after this one, so today the only importer is this
 * package's own integration suite. `pnpm unused-exports-gate` reports nothing
 * for them with the tag removed, because knip counts a workspace's own tests as
 * consumers — the second finding `scripts/unused-exports-gate.ts`'s header
 * records. A tag would therefore suppress nothing and would have to be removed
 * again in PD-T7.
 */
export {
  PortfolioIconPortfolioNotFoundError,
  getPortfolioIcon,
  removePortfolioIcon,
  setPortfolioIcon,
  type PortfolioIconMeta,
  type SetPortfolioIconParams,
} from "./portfolio-icon-service.js";
/**
 * `watchlist` T-64 —
 * add/update/remove plus the tenant-scoped id list for the tenant-owned
 * `watchlist_item` table (FR-338–FR-341, FR-368, FR-375). Like the icon
 * service it fans out to nothing: watching an instrument moves no figure. The
 * cross-tenant read the ingestion fan-out needs is deliberately elsewhere
 * (`market/ingestion`'s `fetchWatchedInstruments`), never this module.
 *
 * **Named, not `export * from`**, for the reason
 * `instrument-price-freshness-service`'s line above states:
 * `scripts/unused-exports-gate.ts`'s `STAR_REEXPORT_BUDGET` pins this file at
 * 20 star re-exports and allows only lowering, so a 21st star line would fail
 * that gate and hide this module's surface from it.
 *
 * T-64's `@public` tag — which recorded that these symbols had no consumer yet
 * and was to be removed "when T-69 lands" — is **gone as of T-69**:
 * `api/src/watchlist/watchlist.controller.ts` now imports the four write/read
 * functions and both error classes, and `watchlist.schema.ts` imports
 * `WATCHLIST_NOTE_MAX_LENGTH` and `WatchlistItemRecord`. Being named rather
 * than starred keeps every symbol below inside the unused-exports gate, which
 * is the point: anything here the routes turn out not to use is reported as
 * dead. `MAX_WATCHLIST_ITEMS_PER_TENANT` and
 * `WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES` (WL-1) keep their
 * own `@public` tags at their declarations for the `web/src/lib/api-limits.ts`
 * mirror, which knip does not analyse.
 */
export {
  MAX_WATCHLIST_ITEMS_PER_TENANT,
  WATCHLIST_NOTE_MAX_LENGTH,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
  WatchlistItemNotFoundError,
  WatchlistTargetPriceScaleExceededError,
  WatchlistTenantCapExceededError,
  addWatchlistItem,
  listWatchedInstrumentIds,
  removeWatchlistItem,
  updateWatchlistItem,
  type WatchlistItemRecord,
} from "./watchlist-service.js";
/**
 * `portfolio-export-import` EI-18 — the **first** write path
 * `fx_rate_user` has ever had, plus the batched read its one caller
 * (`applyCatalogue`, EI-20) needs before it writes.
 *
 * **Named, not `export * from`**, for the reason the blocks above state:
 * `scripts/unused-exports-gate.ts`'s `STAR_REEXPORT_BUDGET` pins this file at
 * 20 star re-exports and allows only lowering, so a 21st star line would fail
 * that gate *and* hide this module's surface from it.
 */
export { listUserFxRates, upsertUserFxRate } from "./fx-rate-user-service.js";
export * from "./fx-rate-resolver.js";
export * from "./crypto-rate-resolver.js";
export * from "./posting-expander.js";
export * from "./position-replay.js";
// `lockPortfolioRow` is exported so out-of-package writers can join the global
// lock order rather than reinventing it — `load`'s T-41 fixture is the one such
// caller today. Keeping it internal is what let that fixture take rung 4 before
// rung 2 (confirm-only review of the F1 fix round).
export * from "./portfolio-lock.js";
export * from "./materialization.js";
export * from "./transaction-write-service.js";
/**
 * `security-transfer` — the one symbol of the propagation module a caller
 * outside this package needs: the named internal error `api`'s write-error
 * mapper answers with `TRANSFER_PROPAGATION_DID_NOT_SETTLE`. Named, not
 * starred, for `STAR_REEXPORT_BUDGET`'s reason stated above.
 */
export { TransferPropagationDidNotSettleError } from "./transfer-link.js";
export * from "./transaction-read-service.js";
/** `dividend-screen` DS-1 (DV3) — the one-statement dividend aggregate `GET /dividends/summary` reads (FR-265/FR-279). Here rather than in `valuation`: it resolves no price and no FX rate, materialises nothing, and fans out to nothing. */
export * from "./dividend-summary-service.js";
export * from "./invalidation-registry.js";
/**
 * `transaction-dialog-refresh` TDR-T3 — the tenant's rate
 * presets. Named, not starred, for `STAR_REEXPORT_BUDGET`'s reason stated above.
 */
export { getRatePresets, replaceRatePresets } from "./rate-preset-service.js";
