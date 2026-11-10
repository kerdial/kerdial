import { DataGap, ProviderMalformedResponse, SymbolNotFound } from "@kerdial/market-ports";
import type { IsoDate, ProviderSymbol } from "@kerdial/market-ports";
import { DEFAULT_PRICE_HINT, YAHOO_PROVIDER_KEY } from "./constants.js";
import { isRecord } from "../shared/json-utils.js";

/**
 * The subset of `v8/finance/chart/{symbol}`'s `result[0].meta` this adapter
 * needs — confirmed by live probes during development (both a
 * `.PA` Euronext Paris ticker and a plain US ticker). `regularMarketPrice`/
 * `regularMarketTime` double as the "latest quote" this adapter serves
 * (`provider.ts#fetchLatest`) — Yahoo's authenticated `v7/finance/quote`
 * endpoint is deliberately not used (`http-fetcher.ts`'s doc comment).
 */
export interface YahooChartMeta {
  readonly currency: string;
  readonly symbol: string;
  /** Decimal places Yahoo itself quotes this instrument's clean `meta` fields to; used to recover `indicators.quote[]`'s float32-noisy values (`provider.ts`'s `decimalFromChartPrice`). */
  readonly priceHint: number;
  readonly regularMarketPrice: number;
  /** Unix epoch seconds — the provider's own observation timestamp (FR-22, AC14). */
  readonly regularMarketTime: number;
  /**
   * Yahoo's own classification of the line — `"CRYPTOCURRENCY"` for a
   * `BTC-EUR`-style crypto pair, `"EQUITY"`/`"ETF"`/… otherwise.
   * Optional: absent from some captures, and nothing here may fail on it.
   */
  readonly instrumentType?: string;
}

/**
 * One point of `result[0].timestamp` / `result[0].indicators.quote[0].close`,
 * zipped together. `close` is `null` for an in-progress session's bar —
 * confirmed by a live probe capturing a mid-session response (the final
 * element of a same-day request came back `null` before that day's session
 * closed); `provider.ts` skips these rather than fabricating a close.
 */
export interface YahooChartSeriesPoint {
  readonly timestampSeconds: number;
  readonly close: number | null;
}

export interface YahooChartResult {
  readonly meta: YahooChartMeta;
  readonly points: readonly YahooChartSeriesPoint[];
}

function malformed(detail: string): never {
  throw new ProviderMalformedResponse(YAHOO_PROVIDER_KEY, `v8/finance/chart: ${detail}`);
}

/**
 * Parses `v8/finance/chart/{symbol}`'s JSON body — the shape below is
 * confirmed against **live** captures during development (see
 * `__fixtures__/yahoo/*-realshape.json`, exercised by
 * `parse-chart.realshape.test.ts`), not merely assumed from third-party
 * documentation of this undocumented endpoint:
 *
 * ```json
 * {
 *   "chart": {
 *     "result": [{
 *       "meta": { "currency": "USD", "symbol": "AAPL", "priceHint": 2,
 *                 "regularMarketPrice": 150.23, "regularMarketTime": 1700000000, ... },
 *       "timestamp": [1700000000, ...],
 *       "indicators": { "quote": [{ "close": [150.23, null, ...], ... }], "adjclose": [...] }
 *     }],
 *     "error": null
 *   }
 * }
 * ```
 *
 * **Two distinct "no data" shapes, both `result: null` plus a populated
 * `error` object** — confirmed by live probes:
 *   - an unknown/delisted symbol: HTTP 404, `error.code: "Not Found"` -> {@link SymbolNotFound}.
 *   - a period entirely outside a *known* symbol's tradable history: HTTP
 *     400, `error.code: "Bad Request"` -> {@link DataGap} when `historyRange`
 *     is given (the `fetchDailyHistory` caller has a `[from, to]` to report);
 *     otherwise (the `fetchLatest`/`resolve` callers, which pass no history
 *     range and never construct a period Yahoo could reject this way in
 *     practice) an unrecognised error shape is a {@link ProviderMalformedResponse}.
 *
 * Anything else that does not match this shape (invalid JSON, a missing
 * `chart` object, a `result` that is present but not a non-empty array of
 * result objects, missing/wrong-typed `meta`/`timestamp`/`indicators` fields)
 * is a {@link ProviderMalformedResponse} — "the provider changed its response
 * shape," never silently coerced (no provider DTO leaks).
 */
export function parseChartResponse(
  raw: string,
  symbol: ProviderSymbol,
  historyRange?: { readonly from: IsoDate; readonly to: IsoDate },
): YahooChartResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    malformed("response body is not valid JSON");
  }

  if (!isRecord(json) || !isRecord(json["chart"])) {
    malformed('missing top-level "chart" object');
  }
  const chart = (json as { chart: Record<string, unknown> }).chart;
  const resultField = chart["result"];

  if (resultField === null || resultField === undefined) {
    const errorField = chart["error"];
    const code =
      isRecord(errorField) && typeof errorField["code"] === "string" ? errorField["code"] : "";
    const description =
      isRecord(errorField) && typeof errorField["description"] === "string"
        ? errorField["description"]
        : "no description given";

    if (/not found/i.test(code)) {
      throw new SymbolNotFound(YAHOO_PROVIDER_KEY, symbol, `v8/finance/chart: ${description}`);
    }
    if (historyRange !== undefined) {
      throw new DataGap(
        YAHOO_PROVIDER_KEY,
        historyRange.from,
        historyRange.to,
        `v8/finance/chart: ${description}`,
      );
    }
    malformed(`unexpected error for symbol "${symbol}": ${code || description}`);
  }

  if (!Array.isArray(resultField) || resultField.length === 0 || !isRecord(resultField[0])) {
    malformed('"result" is not a non-empty array of result objects');
  }
  const result = (resultField as Record<string, unknown>[])[0]!;

  return { meta: parseMeta(result["meta"]), points: parsePoints(result) };
}

function parseMeta(raw: unknown): YahooChartMeta {
  if (!isRecord(raw)) malformed('"meta" is not an object');
  const currency = raw["currency"];
  const symbol = raw["symbol"];
  const regularMarketPrice = raw["regularMarketPrice"];
  const regularMarketTime = raw["regularMarketTime"];
  const priceHint = raw["priceHint"];
  const instrumentType = raw["instrumentType"];

  if (typeof currency !== "string" || currency.length === 0) {
    malformed('"meta.currency" is missing or not a non-empty string');
  }
  if (typeof symbol !== "string" || symbol.length === 0) {
    malformed('"meta.symbol" is missing or not a non-empty string');
  }
  if (typeof regularMarketPrice !== "number" || !Number.isFinite(regularMarketPrice)) {
    malformed('"meta.regularMarketPrice" is missing or not a finite number');
  }
  if (typeof regularMarketTime !== "number" || !Number.isFinite(regularMarketTime)) {
    malformed('"meta.regularMarketTime" is missing or not a finite number');
  }

  return {
    currency,
    symbol,
    priceHint:
      typeof priceHint === "number" && Number.isFinite(priceHint) ? priceHint : DEFAULT_PRICE_HINT,
    regularMarketPrice,
    regularMarketTime,
    ...(typeof instrumentType === "string" && instrumentType.length > 0 ? { instrumentType } : {}),
  };
}

function parsePoints(result: Record<string, unknown>): YahooChartSeriesPoint[] {
  const timestamps = result["timestamp"];
  // A response with no `timestamp` array at all (e.g. a bare "latest" meta
  // lookup for an instrument Yahoo has no session bars for yet) has no
  // history series to report — an empty series, not a malformed one.
  if (timestamps === undefined) return [];

  if (!Array.isArray(timestamps)) malformed('"timestamp" is present but not an array');
  const indicators = result["indicators"];
  if (!isRecord(indicators)) malformed('"indicators" is missing or not an object');
  const quoteArray = indicators["quote"];
  if (!Array.isArray(quoteArray) || quoteArray.length === 0 || !isRecord(quoteArray[0])) {
    malformed('"indicators.quote" is not a non-empty array');
  }
  const closes = (quoteArray[0] as Record<string, unknown>)["close"];
  if (!Array.isArray(closes) || closes.length !== timestamps.length) {
    malformed('"indicators.quote[0].close" is missing or does not match "timestamp" in length');
  }

  return timestamps.map((timestamp, index) => {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      malformed(`"timestamp[${index}]" is not a finite number`);
    }
    const close = closes[index];
    if (close !== null && (typeof close !== "number" || !Number.isFinite(close))) {
      malformed(`"indicators.quote[0].close[${index}]" is neither null nor a finite number`);
    }
    return { timestampSeconds: timestamp, close: close as number | null };
  });
}
