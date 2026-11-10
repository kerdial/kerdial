import type { IsoDate, ProviderSymbol } from "@kerdial/market-ports";
import { fetchWithProviderErrors } from "../shared/provider-transport.js";
import { YAHOO_PROVIDER_KEY } from "./constants.js";

/**
 * The two shapes `provider.ts` needs from `v8/finance/chart/{symbol}` — the
 * unauthenticated endpoint this adapter uses for both `fetchLatest`
 * (`"latest"`, `range=1d`) and `fetchDailyHistory` (`"history"`,
 * `period1`/`period2`). See `constants.ts`'s `YAHOO_BATCH_SIZE` doc comment
 * for why `v7/finance/quote` (which would batch several symbols per call) is
 * deliberately not used.
 */
export type YahooChartRange =
  | { readonly kind: "latest" }
  | { readonly kind: "history"; readonly from: IsoDate; readonly to: IsoDate };

/**
 * The network boundary, injected rather than called directly by {@link
 * import("./provider.js").YahooQuoteProvider} — mirrors `ecb`'s
 * `EcbSourceFetcher` (T-15): this is what lets tests exercise the adapter's
 * parsing/mapping logic against checked-in fixtures with **no live network
 * call**. `HttpYahooSourceFetcher` below is the real implementation; tests
 * supply a fixture-backed fake.
 */
export interface YahooSourceFetcher {
  /** `v1/finance/search?q=...` — symbol/ISIN resolution candidates (the port's `resolve()`). */
  fetchSearch(query: string): Promise<string>;
  /** `v8/finance/chart/{symbol}` — the provider's own current price (`meta`) and, for `"history"`, a daily OHLC series. */
  fetchChart(symbol: ProviderSymbol, range: YahooChartRange): Promise<string>;
}

const HOST = "https://query1.finance.yahoo.com";
const SEARCH_PATH = "/v1/finance/search";
const ONE_DAY_SECONDS = 86_400;

/**
 * A plain desktop-browser User-Agent. Required in practice — confirmed by a
 * live probe during development: an unauthenticated request
 * with no `User-Agent` header (Node's default `undici` one) is rejected at
 * Yahoo's edge with a bare HTTP 429 ("Edge: Too Many Requests") before ever
 * reaching the chart/search services, while the identical request carrying
 * this header succeeds. This is not rate limiting in the
 * `ProviderRateLimited` sense (it fires on the very first request, with no
 * prior traffic) — it is Yahoo's edge rejecting requests that look
 * scripted, and is a known operational quirk of this unofficial,
 * personal-use-only endpoint.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Sent on every request — the only adapter in this package that needs any header at all. */
const YAHOO_HEADERS: Readonly<Record<string, string>> = { "User-Agent": BROWSER_USER_AGENT };

/**
 * The three statuses `v8/finance/chart` answers with a body worth parsing:
 * 200, plus the 404/400 pair `HttpYahooSourceFetcher`'s doc comment
 * explains. Anything else is `ProviderUnavailable` — and note this is an
 * exact set, not "any 2xx": only 200 is a success on this endpoint.
 */
const CHART_OK_STATUSES: readonly number[] = [200, 400, 404];

function isoDateToUnixSeconds(date: IsoDate): number {
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 1000);
}

/**
 * Builds the chart endpoint's query string for `range`.
 *
 * For `"history"`, `period1`/`period2` are padded a day either side of the
 * requested `[from, to]` window: a live probe during development
 * found Yahoo's own period filtering to be inexact at the boundary (a
 * weekend-only requested period still returned the preceding trading day's
 * bar, i.e. a point *before* the nominal `period1`), so this adapter
 * requests generously and enforces the port's exact `[from, to]` contract
 * itself in `provider.ts`, rather than trusting the upstream boundary.
 */
function chartQueryString(range: YahooChartRange): string {
  if (range.kind === "latest") return "range=1d&interval=1d";
  const period1 = isoDateToUnixSeconds(range.from) - ONE_DAY_SECONDS;
  const period2 = isoDateToUnixSeconds(range.to) + 2 * ONE_DAY_SECONDS;
  return `period1=${period1}&period2=${period2}&interval=1d`;
}

/**
 * The real fetcher — plain HTTPS `GET` with a browser `User-Agent`, no
 * auth/key, over the shared transport core
 * (`../shared/provider-transport.ts`), which documents the error mapping
 * this fetcher inherits.
 *
 * `fetchChart` is the one deliberate exception to "any non-OK status is
 * `ProviderUnavailable`": HTTP 404 and 400 are part of
 * `v8/finance/chart`'s own documented-by-observation response contract (a
 * 404 for an unknown/delisted symbol, a 400 for a period outside a known
 * symbol's tradable range — both confirmed by live probes, both still
 * carrying a parseable `{"chart":{"result":null,"error":{...}}}` body), so
 * this transport layer passes the body through for those two statuses and
 * lets `parse-chart.ts` — which has the symbol/date context needed to
 * distinguish `SymbolNotFound` from `DataGap` — decide. This is a deliberate
 * departure from `ecb`'s fetcher (T-15), which treats every non-OK status as
 * unusable: `ecb`'s endpoints are static file hosts with no such
 * error-shaped-body contract.
 */
export class HttpYahooSourceFetcher implements YahooSourceFetcher {
  fetchSearch(query: string): Promise<string> {
    const url = `${HOST}${SEARCH_PATH}?q=${encodeURIComponent(query)}`;
    return fetchWithProviderErrors(YAHOO_PROVIDER_KEY, url, { headers: YAHOO_HEADERS });
  }

  fetchChart(symbol: ProviderSymbol, range: YahooChartRange): Promise<string> {
    const url = `${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?${chartQueryString(range)}`;
    return fetchWithProviderErrors(YAHOO_PROVIDER_KEY, url, {
      headers: YAHOO_HEADERS,
      okStatuses: CHART_OK_STATUSES,
    });
  }
}
