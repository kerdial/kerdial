/**
 * `market/adapters/ecb` — the ECB FX adapter (T-15). This is the only file
 * tree in `market/adapters` allowed to name the string `"ecb"` as a provider
 * identity, per the "nothing outside `market/adapters` may name a provider"
 * boundary rule — the constant lives in `currencies.ts`, not
 * duplicated here.
 */
export { EcbFxRateProvider } from "./provider.js";
export { HttpEcbSourceFetcher } from "./http-fetcher.js";
export type { EcbSourceFetcher } from "./http-fetcher.js";
export {
  ECB_BASE_CURRENCY,
  ECB_PROVIDER_KEY,
  ECB_PUBLISHED_CURRENCIES,
  EUR_RUB_SUSPENDED_FROM,
} from "./currencies.js";
export { parseHistoricalCsv } from "./parse-csv.js";
export type { EcbHistoricalRow, EcbHistoricalTable } from "./parse-csv.js";
export { parseDailyXml } from "./parse-xml.js";
export type { EcbDailySnapshot } from "./parse-xml.js";
