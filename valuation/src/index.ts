/**
 * `valuation` — read side (component C11):
 * holdings/valuation snapshots and the `portfolio_daily_valuation`
 * materialise-on-read path (T-30's `materializePortfolioValuations`, the
 * read-path half of "invalidate on write, materialise lazily on read";
 * the write-path half `recomputeAndInvalidate` lives in `@kerdial/ledger`,
 * since it runs inside `TransactionWriteService`'s own DB transaction).
 *
 * `materializePortfolioValuations` is deliberately **not** re-exported here.
 * It is reached through `performance.ts`'s `computePortfolioReturns`, which is
 * the surface `api` actually calls; the only in-repo importers are inside this
 * package and take it from `./materialize.js` directly. Adding it back to this
 * barrel without a cross-package caller fails the `unused-exports-gate`.
 *
 * This module must never import `market/adapters` **or** `market/ports` —
 * this is what makes
 * "recomputation never re-fetches an FX rate" a compile-time property.
 * Enforced by the root dependency-cruiser config, `.dependency-cruiser.cjs`
 * (`valuation-no-market-adapters`, `valuation-no-market-ports`).
 */
export {
  valueHoldingsAsOf,
  valueHoldingsForTenant,
  TooManyHoldingsError,
  TooManyRealizedGainsError,
  type ValuedFigure,
  type FigureProvenance,
  type ValuedHolding,
  type ValuedRealizedGain,
  type ValuedPortfolioHoldings,
} from "./holdings-valuation.js";
/**
 * `mcp-readonly` (MCP-L7): the allocation read's grouping of a valued
 * holdings result. `ALLOCATION_DIMENSIONS` is here because `api`'s query
 * schema validates `by` against it rather than re-typing the set.
 */
export {
  allocateValuedHoldings,
  ALLOCATION_DIMENSIONS,
  type HoldingsAllocation,
} from "./holdings-allocation.js";
/**
 * `closed-positions` (T-51). The two error classes are here because
 * `api`'s `#mapValuationError` catches them by `instanceof`; the two constants
 * because `web/src/lib/api-limits.ts` mirrors them and
 * `api-limits.drift.test.ts` asserts against the real definitions. Distinct
 * names throughout — never a repurposing of
 * `MAX_HOLDINGS_PER_VIEW`/`MAX_REALIZED_GAINS_PER_HOLDING`, whose own
 * enforcement is untouched (FR-336).
 */
export {
  valueClosedPositionsAsOf,
  valueClosedPositionsForTenant,
  MAX_CLOSED_POSITIONS_PER_VIEW,
  MAX_SALE_LOTS_PER_CLOSED_POSITION,
  TooManyClosedPositionsError,
  TooManySaleLotsError,
  type ValuedClosedPosition,
  type ValuedClosedPositions,
} from "./closed-positions-valuation.js";
/**
 * `watchlist` (T-68). The error class is here because `api`'s
 * watchlist controller catches it by `instanceof`; `MAX_WATCHLIST_ROWS_PER_VIEW`
 * because `web/src/lib/api-limits.ts` mirrors it and `api-limits.drift.test.ts`
 * asserts against the real definition; the window preset list because `api`'s
 * query schema validates against it rather than re-typing the set; and the two
 * types because `api`'s `watchlist.schema.ts` maps this module's own output.
 *
 * `WATCHLIST_SERIES_MAX_POINTS` is deliberately **not** here, and neither is
 * `WatchlistWindow`: nothing imports either across a package edge. The
 * `api-limits.ts` mirror T-72 adds reaches the declaring *module* by relative
 * path — which is what `api-limits.drift.test.ts` already does for every other
 * mirrored constant — and `unused-exports-gate` reports a barrel export nothing
 * imports as dead (MEASURED at T-69, which also refutes assumption A1: see `watchlist-valuation.ts`'s note beside its widened imports).
 */
export {
  valueWatchlistForTenant,
  TooManyWatchlistRowsError,
  WATCHLIST_WINDOW_PRESETS,
  type ValuedWatchlistRow,
  type ValuedWatchlist,
} from "./watchlist-valuation.js";
export {
  computePortfolioReturns,
  computeCombinedPortfolioReturns,
  computePortfolioValueSeries,
  computeCombinedPortfolioValueSeries,
  type PortfolioReturns,
  type PortfolioValueSeries,
  type TwrOutcome,
} from "./performance.js";
/**
 * Re-exported so `api` (which sees only `ledger`/`valuation`-shaped data,
 * never `core/domain` directly) can catch these
 * two by `instanceof` without adding a direct `@kerdial/core-domain`
 * dependency of its own purely for two error classes.
 */
export { UnresolvablePriceError, UnresolvableRateError } from "@kerdial/core-domain";
// AR-23: the aggregate summary's type, re-exported for the same
// reason as the two errors above — `api` consumes it off this package's
// figures without adding a direct `@kerdial/core-domain` edge.
export type { ProvenanceSummary } from "@kerdial/core-domain";
