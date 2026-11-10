import { ProviderMalformedResponse } from "@kerdial/market-ports";
import { YAHOO_PROVIDER_KEY } from "./constants.js";
import { isRecord } from "../shared/json-utils.js";

/**
 * One `v1/finance/search`'s `quotes[]` entry this adapter needs — confirmed
 * by a live probe during development (searching "Apple" returns,
 * among others, `{"symbol":"AAPL","shortname":"Apple Inc.","quoteType":
 * "EQUITY","exchange":"NMS", ...}`). Yahoo's search response carries no
 * currency field at all — {@link import("./provider.js").YahooQuoteProvider}
 * enriches each candidate's currency from `v8/finance/chart`'s authoritative
 * `meta.currency` rather than guessing from `exchange` (`provider.ts`'s doc
 * comment).
 */
export interface YahooSearchCandidate {
  readonly symbol: string;
  readonly quoteType: string;
  readonly shortName?: string;
  readonly longName?: string;
  readonly exchange?: string;
  /**
   * DD21 — the
   * provider's own classification value (`"Technology"`, `"Basic
   * Materials"`, ...), carried out of this adapter verbatim as
   * `ProviderSymbolMatch.providerSectorLabel`. Inconsistently present in the
   * real response (`search-realshape.json` has one `EQUITY` entry, `AAPLC.BA`,
   * carrying neither this nor {@link industry}), hence optional.
   *
   * The parallel `sectorDisp`/`industryDisp` fields are deliberately **not**
   * read (A12): they are inconsistently present too and add nothing
   * over these. Nothing in this adapter maps either value to an internal
   * code — that happens on the neutral side (DD20).
   */
  readonly sector?: string;
  /** The finer-grained label beneath {@link sector} (`"Consumer Electronics"`) — opaque, display-only. */
  readonly industry?: string;
}

function malformed(detail: string): never {
  throw new ProviderMalformedResponse(YAHOO_PROVIDER_KEY, `v1/finance/search: ${detail}`);
}

/**
 * Parses `v1/finance/search`'s JSON body. The real response (see
 * `__fixtures__/yahoo/search-realshape.json`, captured live) carries several
 * top-level arrays this adapter does not need (`news`, `nav`, `lists`, ...);
 * only `quotes[]` is read. An empty `quotes[]` array is a legitimate "no
 * matches" result, not malformed — {@link
 * import("./provider.js").YahooQuoteProvider.resolve} returns an empty array
 * in that case rather than throwing (the port's `resolve()` contract does
 * not require a `SymbolNotFound`-style error for "nothing found", unlike
 * `fetchLatest`/`fetchDailyHistory`).
 *
 * Anything that does not match this shape (invalid JSON, a missing/
 * non-array `quotes` field, or a `quotes[]` entry missing `symbol`/
 * `quoteType`) is a {@link ProviderMalformedResponse}.
 */
export function parseSearchResponse(raw: string): YahooSearchCandidate[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    malformed("response body is not valid JSON");
  }

  if (!isRecord(json)) malformed("response body is not a JSON object");
  const quotes = json["quotes"];
  if (!Array.isArray(quotes)) malformed('missing or non-array "quotes" field');

  return quotes.map((entry, index) => {
    if (!isRecord(entry)) malformed(`quotes[${index}] is not an object`);
    const symbol = entry["symbol"];
    const quoteType = entry["quoteType"];
    if (typeof symbol !== "string" || symbol.length === 0) {
      malformed(`quotes[${index}].symbol is missing or not a non-empty string`);
    }
    if (typeof quoteType !== "string" || quoteType.length === 0) {
      malformed(`quotes[${index}].quoteType is missing or not a non-empty string`);
    }
    const shortName = typeof entry["shortname"] === "string" ? entry["shortname"] : undefined;
    const longName = typeof entry["longname"] === "string" ? entry["longname"] : undefined;
    const exchange = typeof entry["exchange"] === "string" ? entry["exchange"] : undefined;
    const sector = typeof entry["sector"] === "string" ? entry["sector"] : undefined;
    const industry = typeof entry["industry"] === "string" ? entry["industry"] : undefined;
    // Built via conditional spreads, not `field: possiblyUndefined`, so an
    // absent optional field is genuinely *absent* from the object rather
    // than present with the value `undefined` — required under this repo's
    // `exactOptionalPropertyTypes: true` (tsconfig.base.json), which treats
    // those as distinct.
    return {
      symbol,
      quoteType,
      ...(shortName !== undefined ? { shortName } : {}),
      ...(longName !== undefined ? { longName } : {}),
      ...(exchange !== undefined ? { exchange } : {}),
      ...(sector !== undefined ? { sector } : {}),
      ...(industry !== undefined ? { industry } : {}),
    };
  });
}
