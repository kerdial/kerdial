/**
 * `core/domain` — the pure, DB-free calculation engine (D13). T-14 is this
 * package's first real content: the shared LOCF algorithm plus the minimal
 * shared pure types it and its first consumer (`ledger`'s `FxRateResolver`,
 * T-18) need in common. T-21 adds `classifyFlows`, consumed by `ledger`'s
 * posting expander at write time and by every return metric afterwards. T-24
 * adds `replayPositions` / `computePmp` (the PMP cost-basis engine). T-25 adds
 * `computeRealizedGains` / `attributeFx` (realized gains and the FR-30 FX
 * gain/loss line). T-26 adds `computeTwr` (the time-weighted return engine —
 * deliberately sharing no code with the XIRR engine, T-27, which follows).
 * T-27 adds `computeXirr` (the money-weighted return / XIRR engine — Newton–Raphson with a bisection fallback, code-disjoint from
 * `computeTwr` per AC18 and the mutual `twr-no-xirr`/`xirr-no-twr` rules).
 * T-28 adds `valuePortfolio` / `resolvePrice` (portfolio mark-to-market, with the `MarketRate`/`PinnedRate` brands that keep the
 * valuation-date and transaction-pinned FX rate paths structurally distinct).
 * T-39 adds `mergeProvenance` (the single aggregation-safe union of
 * `ValuedAmount.provenance.derivedFrom` flag sets). T-46 adds
 * `computeClosedPositions` (the fully-divested instruments `computePmp`
 * deliberately drops, and what selling out of them realized — FR-321–FR-324).
 * T-61 adds `computeInstrumentMetrics` / `decimateCloseSeries` (`watchlist` —
 * per-instrument period returns, 52-week range, maximum drawdown, annualised
 * volatility and the two SMAs, FR-349–FR-353). `security-transfer` adds
 * `transferCarriedCost` (the exact cost basis a security transfer's source
 * leg carries into its target portfolio). `portfolio-cash` adds `valueCash` /
 * `cashBalancesBefore` (cash converted to base at the valuation date's market
 * rate, never throwing on a missing rate). `mcp-readonly` adds `allocate`
 * (bucket values and largest-remainder shares for the allocation read).
 *
 * This package may import nothing but
 * `core/decimal` — see `locf.ts`/`types.ts`/`flow-class.ts`, none of which
 * imports anything at all.
 */
export { locf } from "./locf.js";
export { classifyFlows } from "./flow-class.js";
export type {
  ClassifiableTransaction,
  FlowClass,
  TransactionKind,
  TransactionLeg,
} from "./flow-class.js";
export {
  replayPositions,
  computePmp,
  OverSellError,
  UnsupportedCorporateActionError,
} from "./pmp.js";
export type {
  PositionTxn,
  AcquisitionTxn,
  DisposalTxn,
  TxnFee,
  CorporateAction,
  RunningPosition,
  PositionEvent,
  PositionTimeline,
  HoldingState,
} from "./pmp.js";
export { computeRealizedGains, attributeFx } from "./realized-gains.js";
export type { RealizedGain, FxAttributionInput, FxAttribution } from "./realized-gains.js";
export { computeClosedPositions } from "./closed-positions.js";
export { transferCarriedCost } from "./transfer.js";
export type { ClosedPosition } from "./closed-positions.js";
export {
  computeInstrumentMetrics,
  decimateCloseSeries,
  UnsortedCloseSeriesError,
  PERIOD_RETURN_WINDOWS,
  TRADING_DAYS_PER_YEAR,
  VOLATILITY_MIN_RETURNS,
  SMA_PERIODS,
} from "./instrument-metrics.js";
export type {
  ClosePoint,
  DecimatedClosePoint,
  InstrumentMetricsInput,
  InstrumentMetrics,
  FiftyTwoWeekRange,
  MaxDrawdown,
  PeriodReturnWindow,
} from "./instrument-metrics.js";
export { computeTwr, TwrInputError, DegenerateSubPeriodError } from "./twr.js";
export type { Valuation, TwrFlow, TwrResult } from "./twr.js";
export { computeXirr, XirrInputError } from "./xirr.js";
export type {
  XirrFlow,
  TerminalValue,
  XirrResult,
  XirrConverged,
  XirrDidNotConverge,
  ReturnUnavailableCode,
} from "./xirr.js";
export {
  valuePortfolio,
  resolvePrice,
  resolveMarketRate,
  marketRate,
  pinnedRate,
  UnresolvablePriceError,
  UnresolvableRateError,
} from "./valuation.js";
export type {
  MarketRate,
  PinnedRate,
  PriceOrigin,
  PricePoint,
  PriceObservation,
  FxRatePoint,
  HoldingValuation,
  PortfolioValuation,
} from "./valuation.js";
export { valueCash, cashBalancesBefore } from "./cash-valuation.js";
export type { CashDailyNet, CashCurrencyValuation, CashValuation } from "./cash-valuation.js";
export type { CurrencyPair, CurrencyCode, DatedObservation, IsoDate } from "./types.js";
export { mergeProvenance, summarizeProvenance } from "./provenance.js";
export type { ProvenanceSummary, ProvenanceSummaryLeaf } from "./provenance.js";
export type { DerivedFromFlag } from "./provenance.js";
export { allocate } from "./allocation.js";
export type { AllocationRow } from "./allocation.js";
