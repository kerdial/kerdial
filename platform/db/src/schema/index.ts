/**
 * `platform/db` schema (T-5 scope: auth &
 * reference schema). Re-exports every table/enum so `drizzle-kit` can
 * introspect the whole schema from a single entry point, and so application
 * code imports one module rather than reaching into individual files.
 *
 * Ledger tables (T-6) and market/reference-data tables (T-7) extend this
 * same schema directory; RLS policies and DB roles are T-8.
 */
export * from "./pg-types.js";
export * from "./currency.js";
export * from "./tenant.js";
export * from "./app-user.js";
export * from "./session.js";
export * from "./personal-access-token.js";
export * from "./instrument.js";
export * from "./instrument-provider-map.js";
export * from "./instrument-icon.js";
export * from "./watchlist-item.js";
export * from "./fx-rate-daily.js";
export * from "./fx-rate-user.js";
export * from "./fx-tracked-pair.js";
export * from "./instrument-price-daily.js";
export * from "./manual-price-point.js";
export * from "./instrument-quote-latest.js";
export * from "./provider-fetch-log.js";
export * from "./instrument-backfill-state.js";
export * from "./instrument-price-gap.js";
export * from "./market-calendar.js";
export * from "./market-data-epoch.js";
export * from "./portfolio.js";
export * from "./portfolio-icon.js";
export * from "./rate-preset-list.js";
export * from "./cash-account.js";
export * from "./transaction.js";
export * from "./transaction-posting.js";
export * from "./transaction-revision.js";
export * from "./cash-balance.js";
export * from "./holding-state.js";
export * from "./realized-gain.js";
export * from "./portfolio-daily-valuation.js";
export * from "./login-attempt.js";
export * from "./ops-indicator.js";
