/**
 * `market/adapters/yahoo` — the Yahoo unofficial-endpoints adapter
 * (T-31). This is the only file tree
 * in `market/adapters` allowed to name the string `"yahoo"` as a provider
 * identity, per the "nothing outside
 * `market/adapters` may name a provider" boundary rule — the constant lives
 * in `constants.ts`, not duplicated here.
 */
export { YahooQuoteProvider } from "./provider.js";
export { HttpYahooSourceFetcher } from "./http-fetcher.js";
export type { YahooChartRange, YahooSourceFetcher } from "./http-fetcher.js";
export {
  DEFAULT_PRICE_HINT,
  YAHOO_ASSET_KINDS,
  YAHOO_BATCH_SIZE,
  YAHOO_DELAY_MINUTES,
  YAHOO_MAX_HISTORY_YEARS,
  YAHOO_PROVIDER_KEY,
  YAHOO_QUOTE_QUALITY,
  YAHOO_QUOTE_TYPES_BY_KIND,
} from "./constants.js";
export { parseChartResponse } from "./parse-chart.js";
export type { YahooChartMeta, YahooChartResult, YahooChartSeriesPoint } from "./parse-chart.js";
export { parseSearchResponse } from "./parse-search.js";
export type { YahooSearchCandidate } from "./parse-search.js";
