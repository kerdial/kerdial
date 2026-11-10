import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import { fetchWithProviderErrors } from "../shared/provider-transport.js";
import { ECB_BASE_CURRENCY, ECB_HISTORY_START, ECB_PROVIDER_KEY } from "./currencies.js";

/**
 * The network boundary, injected rather than called directly by {@link
 * import("./provider.js").EcbFxRateProvider} — this is what lets tests
 * exercise the adapter's parsing/derivation logic against checked-in
 * fixtures with **no live network call**.
 * `HttpEcbSourceFetcher` below is the real implementation; tests supply a
 * fixture-backed fake.
 */
export interface EcbSourceFetcher {
  /**
   * The daily history of each of `currencies` against the euro, from
   * {@link ECB_HISTORY_START} through `to`, as the ECB statistics API's
   * `csvdata` body — used for backfill and hole repair.
   */
  fetchHistoricalCsv(currencies: readonly CurrencyCode[], to: IsoDate): Promise<string>;
  /** The `eurofxref-daily.xml` file — today's rates only, used for incremental updates. */
  fetchDailyXml(): Promise<string>;
}

/**
 * History comes from the ECB statistics API (SDW), **not** from
 * `www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.csv`. On the owner's
 * network that file path is intercepted and answers 200 with a synthetic
 * 2801-row file that stops on 2010-02-14 and carries fabricated rates; every
 * history load from it wrote those rates, and every repair
 * attempt fetched the same stub again. The API is a different host, serves
 * the same reference rates, and can be scoped to the currencies and range a
 * load needs.
 */
const HISTORY_API_URL = "https://data-api.ecb.europa.eu/service/data/EXR";
const DAILY_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/**
 * The SDMX series key `D.<CCY>+<CCY>.EUR.SP00.A`: daily (`D`), the given
 * currencies against the euro, spot (`SP00`), average (`A`) — the euro
 * foreign exchange reference rates. `detail=dataonly` keeps the body to the
 * key columns plus `TIME_PERIOD`/`OBS_VALUE` (no free-text title columns,
 * which are the only ones that could carry a comma). Currencies are sorted so
 * the same request is always the same URL.
 */
function historyUrl(currencies: readonly CurrencyCode[], to: IsoDate): string {
  const key = [...currencies].sort().join("+");
  const query = new URLSearchParams({
    format: "csvdata",
    detail: "dataonly",
    startPeriod: ECB_HISTORY_START,
    endPeriod: to,
  });
  return `${HISTORY_API_URL}/D.${key}.${ECB_BASE_CURRENCY}.SP00.A?${query.toString()}`;
}

/**
 * The real fetcher — plain HTTPS `GET`, no auth/key and no headers, over
 * the shared transport core
 * (`../shared/provider-transport.ts`), which documents the error mapping
 * this fetcher inherits.
 *
 * Both endpoints keep the default "any 2xx is usable, everything else is
 * `ProviderUnavailable`" status handling — unlike `yahoo`, whose chart
 * endpoint passes some non-OK bodies through. The statistics API answers
 * 404 for a series key it does not know, but the provider only ever asks for
 * currencies it has already validated, so a 404 here is an outage-shaped
 * failure, not a "no such symbol" answer. Body-shape failures are mapped by
 * the parsers (`parse-csv.ts`, `parse-xml.ts`), not here — this module only
 * knows about the transport, not the payload shape.
 */
export class HttpEcbSourceFetcher implements EcbSourceFetcher {
  fetchHistoricalCsv(currencies: readonly CurrencyCode[], to: IsoDate): Promise<string> {
    return fetchWithProviderErrors(ECB_PROVIDER_KEY, historyUrl(currencies, to));
  }

  fetchDailyXml(): Promise<string> {
    return fetchWithProviderErrors(ECB_PROVIDER_KEY, DAILY_XML_URL);
  }
}
