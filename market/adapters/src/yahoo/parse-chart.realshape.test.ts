import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DataGap, SymbolNotFound } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { parseChartResponse } from "./parse-chart.js";
import { parseSearchResponse } from "./parse-search.js";

/**
 * Fidelity regression against the REAL Yahoo response shapes.
 *
 * `parse-chart.test.ts`/`parse-search.test.ts` prove the parsers handle the
 * shape development *believed* Yahoo's undocumented endpoints
 * publish. This file pins the shape they **actually** publish: every fixture
 * here is a verbatim, unmodified capture from a live `curl` against
 * `query1.finance.yahoo.com` taken during development (dated
 * below), not hand-authored — `search-realshape.json` additionally drops the
 * unrelated `news`/`nav`/... top-level arrays the real response also carries
 * (this adapter never reads them), but every field it keeps is untouched.
 *
 * The one real-world detail a hand-authored fixture would not reproduce, and
 * which this test locks down: `indicators.quote[].close` (and `open`/`high`/
 * `low`/`adjclose`) values are transmitted as **float32-cast** doubles —
 * e.g. a true close of `321.79` (matching `meta.regularMarketPrice`'s clean
 * `321.785`, itself rounding to `321.79`) arrives as `321.7850036621094` —
 * while `meta`'s own price fields stay clean. `provider.ts`'s
 * `decimalFromChartPrice` is what corrects for this; this test only pins the
 * raw parser's output (the correction is exercised in `provider.test.ts`
 * against these same fixtures).
 *
 * Captured 2026-07-23 via:
 *   `curl -H "User-Agent: Mozilla/5.0 ..." "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d"`
 *   `curl -H "User-Agent: Mozilla/5.0 ..." "https://query1.finance.yahoo.com/v8/finance/chart/MC.PA?period1=1704409200&period2=1704841200&interval=1d"`
 *   `curl -H "User-Agent: Mozilla/5.0 ..." "https://query1.finance.yahoo.com/v8/finance/chart/NOTASYMBOL999XYZ?range=5d&interval=1d"` (HTTP 404)
 *   `curl -H "User-Agent: Mozilla/5.0 ..." "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?period1=0&period2=100000&interval=1d"` (HTTP 400)
 *   `curl -H "User-Agent: Mozilla/5.0 ..." "https://query1.finance.yahoo.com/v1/finance/search?q=Apple"`
 *
 * without a `User-Agent` header, both `query1`/`query2` hosts reject the
 * request outright at the edge (`http-fetcher.ts`'s doc comment) — every
 * capture above used one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "yahoo");
function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

/** Pulls `chart.result[0].indicators.quote[0].close` straight out of a raw fixture body, for comparison against the parser's own output. */
function rawCloseSeries(raw: string): (number | null)[] {
  const parsed = JSON.parse(raw) as {
    chart: { result: [{ indicators: { quote: [{ close: (number | null)[] }] } }] };
  };
  return parsed.chart.result[0].indicators.quote[0].close;
}

describe("parseChartResponse — real Yahoo v8/finance/chart shape (captured 2026-07-23)", () => {
  it("parses a real 5-day US ticker (AAPL) response", () => {
    const result = parseChartResponse(fixture("chart-aapl-realshape.json"), "AAPL");

    expect(result.meta).toMatchObject({
      currency: "USD",
      symbol: "AAPL",
      priceHint: 2,
      regularMarketPrice: 321.785,
      regularMarketTime: 1784814170,
    });
    expect(result.points).toHaveLength(5);
    // Compared against the fixture's own raw JSON (rather than a hand-copied
    // float literal in this file, which `eslint`'s `no-loss-of-precision`
    // rule rejects for some of these float32-noisy values) — the float32
    // noise itself is exactly what this test is pinning.
    const rawCloses = rawCloseSeries(fixture("chart-aapl-realshape.json"));
    expect(result.points.at(-1)).toEqual({ timestampSeconds: 1784813400, close: rawCloses.at(-1) });
  });

  it("parses a real Euronext Paris ticker (MC.PA) response with EUR currency", () => {
    const raw = fixture("chart-mcpa-realshape.json");
    const result = parseChartResponse(raw, "MC.PA");

    expect(result.meta.currency).toBe("EUR");
    expect(result.meta.symbol).toBe("MC.PA");
    expect(result.points).toHaveLength(3);
    expect(result.points.map((p) => p.close)).toEqual(rawCloseSeries(raw));
  });

  it("maps a real 404 not-found response to SymbolNotFound", () => {
    expect(() =>
      parseChartResponse(fixture("chart-notfound-realshape.json"), "NOTASYMBOL999XYZ"),
    ).toThrow(SymbolNotFound);
  });

  it("maps a real 400 out-of-range response to DataGap when a history range is given", () => {
    expect(() =>
      parseChartResponse(fixture("chart-bad-request-realshape.json"), "AAPL", {
        from: "1970-01-01",
        to: "1970-01-02",
      }),
    ).toThrow(DataGap);
  });
});

describe("parseSearchResponse — real Yahoo v1/finance/search shape (captured 2026-07-23)", () => {
  it("parses real search results, ignoring the unrelated news/nav/... sections", () => {
    const candidates = parseSearchResponse(fixture("search-realshape.json"));

    expect(candidates.length).toBeGreaterThan(0);
    const aapl = candidates.find((c) => c.symbol === "AAPL");
    expect(aapl).toEqual({
      symbol: "AAPL",
      quoteType: "EQUITY",
      shortName: "Apple Inc.",
      longName: "Apple Inc.",
      exchange: "NMS",
      // IR-8: read from the captured body, previously discarded.
      sector: "Technology",
      industry: "Consumer Electronics",
    });
    // The same real capture's own evidence for A12/FR-5's "tolerated
    // absent": one `EQUITY` entry (`AAPLC.BA`) carries neither field, and the
    // parser leaves both genuinely absent rather than `null`/`""`.
    const unclassified = candidates.find((c) => c.symbol === "AAPLC.BA");
    expect(Object.hasOwn(unclassified!, "sector")).toBe(false);
    expect(Object.hasOwn(unclassified!, "industry")).toBe(false);
    // A real search for "Apple" surfaces unrelated cross-listings/decoys
    // (Apple Hospitality REIT, a Xetra cross-listing, ...) — this adapter's
    // `YAHOO_QUOTE_TYPES_BY_KIND` filter (provider.ts) is what narrows this
    // down further; the parser itself keeps every quotes[] entry.
    expect(candidates.some((c) => c.symbol === "APLE")).toBe(true);
  });
});
