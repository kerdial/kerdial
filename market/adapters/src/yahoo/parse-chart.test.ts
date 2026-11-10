import { DataGap, ProviderMalformedResponse, SymbolNotFound } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { parseChartResponse } from "./parse-chart.js";

const VALID_CHART = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "AAPL",
          priceHint: 2,
          regularMarketPrice: 150.23,
          regularMarketTime: 1704898800,
        },
        timestamp: [1704720600, 1704893400],
        indicators: {
          quote: [{ close: [148.35, 150.23] }],
        },
      },
    ],
    error: null,
  },
});

describe("parseChartResponse", () => {
  it("parses meta and points from a well-formed response", () => {
    const result = parseChartResponse(VALID_CHART, "AAPL");
    expect(result.meta.currency).toBe("USD");
    expect(result.meta.symbol).toBe("AAPL");
    expect(result.meta.priceHint).toBe(2);
    expect(result.meta.regularMarketPrice).toBe(150.23);
    expect(result.meta.regularMarketTime).toBe(1704898800);
    expect(result.points).toEqual([
      { timestampSeconds: 1704720600, close: 148.35 },
      { timestampSeconds: 1704893400, close: 150.23 },
    ]);
  });

  it("defaults priceHint when missing, rather than treating it as malformed", () => {
    const body = JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              currency: "USD",
              symbol: "AAPL",
              regularMarketPrice: 1.0,
              regularMarketTime: 1,
            },
            timestamp: [],
            indicators: { quote: [{ close: [] }] },
          },
        ],
        error: null,
      },
    });
    expect(parseChartResponse(body, "AAPL").meta.priceHint).toBe(2);
  });

  it("returns an empty points array when there is no timestamp series at all", () => {
    const body = JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              currency: "USD",
              symbol: "AAPL",
              priceHint: 2,
              regularMarketPrice: 150.23,
              regularMarketTime: 1704898800,
            },
          },
        ],
        error: null,
      },
    });
    expect(parseChartResponse(body, "AAPL").points).toEqual([]);
  });

  it("carries null closes through untouched (an in-progress session's bar)", () => {
    const body = JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              currency: "USD",
              symbol: "AAPL",
              priceHint: 2,
              regularMarketPrice: 150.23,
              regularMarketTime: 1704898800,
            },
            timestamp: [1704720600],
            indicators: { quote: [{ close: [null] }] },
          },
        ],
        error: null,
      },
    });
    expect(parseChartResponse(body, "AAPL").points).toEqual([
      { timestampSeconds: 1704720600, close: null },
    ]);
  });

  it("maps a Not Found chart error to SymbolNotFound", () => {
    const body = JSON.stringify({
      chart: { result: null, error: { code: "Not Found", description: "No data found" } },
    });
    expect(() => parseChartResponse(body, "NOTASYMBOL")).toThrow(SymbolNotFound);
  });

  it("maps a Bad Request chart error to DataGap when a history range is given", () => {
    const body = JSON.stringify({
      chart: { result: null, error: { code: "Bad Request", description: "out of range" } },
    });
    expect(() =>
      parseChartResponse(body, "AAPL", { from: "1900-01-01", to: "1900-01-02" }),
    ).toThrow(DataGap);
  });

  it("maps an unrecognised chart error with no history range to ProviderMalformedResponse", () => {
    const body = JSON.stringify({
      chart: { result: null, error: { code: "Bad Request", description: "out of range" } },
    });
    expect(() => parseChartResponse(body, "AAPL")).toThrow(ProviderMalformedResponse);
  });

  it("rejects an invalid JSON body as ProviderMalformedResponse", () => {
    expect(() => parseChartResponse("not json", "AAPL")).toThrow(ProviderMalformedResponse);
  });

  it("rejects a body missing the top-level chart object", () => {
    expect(() => parseChartResponse("{}", "AAPL")).toThrow(ProviderMalformedResponse);
  });

  it("rejects a result array that is present but empty", () => {
    const body = JSON.stringify({ chart: { result: [], error: null } });
    expect(() => parseChartResponse(body, "AAPL")).toThrow(ProviderMalformedResponse);
  });

  it("rejects meta missing regularMarketPrice", () => {
    const body = JSON.stringify({
      chart: {
        result: [{ meta: { currency: "USD", symbol: "AAPL", regularMarketTime: 1 } }],
        error: null,
      },
    });
    expect(() => parseChartResponse(body, "AAPL")).toThrow(ProviderMalformedResponse);
  });

  it("rejects a close series whose length does not match the timestamp series", () => {
    const body = JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              currency: "USD",
              symbol: "AAPL",
              priceHint: 2,
              regularMarketPrice: 150.23,
              regularMarketTime: 1704898800,
            },
            timestamp: [1704720600, 1704893400],
            indicators: { quote: [{ close: [148.35] }] },
          },
        ],
        error: null,
      },
    });
    expect(() => parseChartResponse(body, "AAPL")).toThrow(ProviderMalformedResponse);
  });
});
