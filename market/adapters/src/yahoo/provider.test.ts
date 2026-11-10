import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "@kerdial/core-decimal";
import { DataGap, ProviderMalformedResponse, SymbolNotFound } from "@kerdial/market-ports";
import type { InstrumentRef, ProviderSymbol } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import type { YahooChartRange, YahooSourceFetcher } from "./http-fetcher.js";
import { YAHOO_MAX_RESOLVE_CANDIDATES, YAHOO_PROVIDER_KEY } from "./constants.js";
import { YahooQuoteProvider } from "./provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "yahoo");
function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

const CHART_AAPL = fixture("chart-happy-aapl.json");
const CHART_MCPA = fixture("chart-happy-mcpa.json");
const CHART_NOT_FOUND = fixture("chart-not-found.json");
const CHART_IN_PROGRESS = fixture("chart-with-inprogress-session.json");
const SEARCH_AAPL = fixture("search-happy-aapl.json");
const SEARCH_MATERIALS = fixture("search-materials-mtas.json");

class MapFetcher implements YahooSourceFetcher {
  constructor(
    private readonly charts: ReadonlyMap<string, string>,
    private readonly search = SEARCH_AAPL,
  ) {}

  async fetchSearch(): Promise<string> {
    return this.search;
  }

  async fetchChart(symbol: ProviderSymbol, _range: YahooChartRange): Promise<string> {
    const body = this.charts.get(symbol);
    if (body === undefined) throw new Error(`no fixture registered for symbol ${symbol}`);
    return body;
  }
}

describe("YahooQuoteProvider — capabilities()", () => {
  it("declares SHARE/ETF/INDEX/CRYPTO, DELAYED quality, no corporate actions, batchSize 1", () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_AAPL]])));
    const capabilities = provider.capabilities();

    expect(capabilities.key).toBe("yahoo");
    expect(capabilities.assetKinds).toEqual(["SHARE", "ETF", "INDEX", "CRYPTO", "FUND"]);
    expect(capabilities.supportsLatestQuote).toBe(true);
    expect(capabilities.supportsDailyHistory).toBe(true);
    expect(capabilities.supportsCorporateActions).toBe(false);
    expect(capabilities.quoteQuality).toBe("DELAYED");
    expect(capabilities.delayMinutes).toBe(15);
    expect(capabilities.batchSize).toBe(1);
  });
});

describe("YahooQuoteProvider — fetchLatest()", () => {
  it("returns a Decimal price corrected for float32 noise, DELAYED quality, and the provider's own asOf for a US ticker", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_AAPL]])));
    const [observation] = await provider.fetchLatest(["AAPL"]);

    expect(observation!.price).toBeInstanceOf(Decimal);
    expect(observation!.price.equals(new Decimal("150.23"))).toBe(true);
    expect(observation!.currency).toBe("USD");
    expect(observation!.quality).toBe("DELAYED");
    expect(observation!.sourceKey).toBe(YAHOO_PROVIDER_KEY);
    expect(observation!.asOf).toBe("2024-01-10T15:00:00.000Z");
  });

  it("returns EUR currency for a Euronext Paris (.PA) ticker", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["MC.PA", CHART_MCPA]])));
    const [observation] = await provider.fetchLatest(["MC.PA"]);

    expect(observation!.currency).toBe("EUR");
    expect(observation!.price.equals(new Decimal("459.7"))).toBe(true);
    expect(observation!.quality).toBe("DELAYED");
  });

  it("fetches multiple symbols, one chart call per symbol", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(
        new Map([
          ["AAPL", CHART_AAPL],
          ["MC.PA", CHART_MCPA],
        ]),
      ),
    );
    const observations = await provider.fetchLatest(["AAPL", "MC.PA"]);
    expect(observations.map((o) => o.currency)).toEqual(["USD", "EUR"]);
  });

  it("rejects with SymbolNotFound for an unknown symbol, never an empty array", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["NOTASYMBOL", CHART_NOT_FOUND]])),
    );
    await expect(provider.fetchLatest(["NOTASYMBOL"])).rejects.toBeInstanceOf(SymbolNotFound);
  });
});

describe("YahooQuoteProvider — fetchDailyHistory()", () => {
  it("returns Decimal closes corrected for float32 noise, date-ascending, DELAYED quality", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_AAPL]])));
    const history = await provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-10");

    expect(history.map((o) => o.priceDate)).toEqual(["2024-01-08", "2024-01-09", "2024-01-10"]);
    expect(history.map((o) => o.close.toString())).toEqual(["148.35", "149.12", "150.23"]);
    expect(history.every((o) => o.currency === "USD")).toBe(true);
    expect(history.every((o) => o.quality === "DELAYED")).toBe(true);
    expect(history.every((o) => o.sourceKey === YAHOO_PROVIDER_KEY)).toBe(true);
  });

  it("filters the returned series to the requested [from, to], excluding a fixture date outside it", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_AAPL]])));
    const history = await provider.fetchDailyHistory("AAPL", "2024-01-09", "2024-01-10");
    expect(history.map((o) => o.priceDate)).toEqual(["2024-01-09", "2024-01-10"]);
  });

  it("skips an in-progress session's null close rather than fabricating a value", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_IN_PROGRESS]])));
    const history = await provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-11");
    expect(history.map((o) => o.priceDate)).toEqual(["2024-01-08", "2024-01-09", "2024-01-10"]);
  });

  it("rejects with SymbolNotFound for an unknown symbol, never an empty array", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["NOTASYMBOL", CHART_NOT_FOUND]])),
    );
    await expect(
      provider.fetchDailyHistory("NOTASYMBOL", "2024-01-08", "2024-01-10"),
    ).rejects.toBeInstanceOf(SymbolNotFound);
  });

  it("rejects with DataGap when every point in the response falls outside [from, to]", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_AAPL]])));
    await expect(
      provider.fetchDailyHistory("AAPL", "2019-01-01", "2019-01-02"),
    ).rejects.toBeInstanceOf(DataGap);
  });

  it("rejects with ProviderMalformedResponse against an unparseable body", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", "not json"]])));
    await expect(
      provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-10"),
    ).rejects.toBeInstanceOf(ProviderMalformedResponse);
  });
});

describe("YahooQuoteProvider — resolve()", () => {
  const knownRef: InstrumentRef = {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    kind: "SHARE",
    symbol: "AAPL",
    listingCurrency: "USD",
  };

  it("returns a match with currency enriched from the chart endpoint and EXACT matchQuality for a symbol match", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["AAPL", CHART_AAPL]]), SEARCH_AAPL),
    );
    const matches = await provider.resolve(knownRef);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      providerSymbol: "AAPL",
      displayName: "Apple Inc.",
      currency: "USD",
      exchangeMic: undefined,
      matchQuality: "EXACT",
      providerExchangeCode: "NMS",
    });
  });

  it("populates providerExchangeCode from Yahoo's own exchange code, and never populates tickerSymbol for an equity (DD9)", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["AAPL", CHART_AAPL]]), SEARCH_AAPL),
    );
    const matches = await provider.resolve(knownRef);

    expect(matches[0]?.providerExchangeCode).toBe("NMS");
    expect(matches[0]?.tickerSymbol).toBeUndefined();
    expect(Object.hasOwn(matches[0]!, "tickerSymbol")).toBe(false);
  });

  it("omits providerExchangeCode when the search candidate carries no exchange field", async () => {
    const search = JSON.stringify({
      quotes: [{ symbol: "AAPL", quoteType: "EQUITY", shortname: "Apple Inc." }],
    });
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["AAPL", CHART_AAPL]]), search),
    );
    const matches = await provider.resolve(knownRef);

    expect(matches[0]?.providerExchangeCode).toBeUndefined();
    expect(Object.hasOwn(matches[0]!, "providerExchangeCode")).toBe(false);
  });

  /**
   * IR-8 (DD21) — asserted on the **port-level return value**, from a
   * fixture, never a live call (NFR-7: CI stays offline).
   * `search-materials-mtas.json` is hand-authored in the exact shape
   * `search-realshape.json` was captured in (a real 2026-07-23
   * `v1/finance/search` body, whose own `EQUITY` entries carry
   * `sector`/`industry` next to `sectorDisp`/`industryDisp`), with a
   * `"Basic Materials"`/`"Steel"` pair — both real values of that provider
   * taxonomy, the first of which `PROVIDER_SECTOR_TO_CODE` maps.
   */
  it("carries the provider's own sector/industry labels onto the chosen candidate, verbatim and unmapped", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["MT.AS", CHART_MCPA]]), SEARCH_MATERIALS),
    );
    const matches = await provider.resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      symbol: "MT.AS",
      listingCurrency: "EUR",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.providerSectorLabel).toBe("Basic Materials");
    expect(matches[0]?.providerIndustryLabel).toBe("Steel");
    // The adapter never maps: no Kerdial code (`MATERIAUX`) appears anywhere
    // on the port's return value (DD20 — an adapter must not know the
    // internal taxonomy).
    expect(JSON.stringify(matches)).not.toContain("MATERIAUX");
  });

  it.each([
    { label: "absent", entry: {} },
    { label: "null", entry: { sector: null, industry: null } },
    { label: "non-string", entry: { sector: 7, industry: [] } },
  ])(
    "omits both classification labels entirely when the candidate's sector/industry are $label",
    async ({ entry }) => {
      const search = JSON.stringify({
        quotes: [{ symbol: "AAPL", quoteType: "EQUITY", shortname: "Apple Inc.", ...entry }],
      });
      const provider = new YahooQuoteProvider(
        new MapFetcher(new Map([["AAPL", CHART_AAPL]]), search),
      );
      const matches = await provider.resolve(knownRef);

      expect(matches[0]?.providerSectorLabel).toBeUndefined();
      expect(matches[0]?.providerIndustryLabel).toBeUndefined();
      expect(Object.hasOwn(matches[0]!, "providerSectorLabel")).toBe(false);
      expect(Object.hasOwn(matches[0]!, "providerIndustryLabel")).toBe(false);
    },
  );

  it("returns PROBABLE matchQuality when the ref carries no symbol to match against", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["AAPL", CHART_AAPL]]), SEARCH_AAPL),
    );
    const matches = await provider.resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "US0378331005",
      listingCurrency: "USD",
    });
    expect(matches[0]?.matchQuality).toBe("PROBABLE");
  });

  it("returns an empty array (not an error) when the search yields no candidates", async () => {
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map(), JSON.stringify({ quotes: [] })),
    );
    await expect(provider.resolve(knownRef)).resolves.toEqual([]);
  });

  it("returns an empty array when the ref carries neither isin nor symbol", async () => {
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", CHART_AAPL]])));
    await expect(
      provider.resolve({
        instrumentId: "11111111-1111-1111-1111-111111111111",
        kind: "SHARE",
        listingCurrency: "USD",
      }),
    ).resolves.toEqual([]);
  });

  it("filters a FUND query to MUTUALFUND-quoteType candidates only", async () => {
    const search = JSON.stringify({
      quotes: [
        { symbol: "AAPL", quoteType: "EQUITY", shortname: "Apple Inc." },
        { symbol: "VFIAX", quoteType: "MUTUALFUND", shortname: "Vanguard 500 Index Fund" },
      ],
    });
    const provider = new YahooQuoteProvider(
      new MapFetcher(
        new Map([
          ["AAPL", CHART_AAPL],
          ["VFIAX", CHART_MCPA],
        ]),
        search,
      ),
    );
    const matches = await provider.resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "FUND",
      symbol: "Vanguard 500",
      listingCurrency: "USD",
    });

    expect(matches.map((m) => m.providerSymbol)).toEqual(["VFIAX"]);
  });

  it("names a MUTUALFUND candidate after `longname` when Yahoo's `shortname` is just the symbol again", async () => {
    // Live shape, 2026-10-19: for a Morningstar-sourced fund line Yahoo's
    // `shortname` *is* the `0P…` symbol; the readable name is only in
    // `longname`. An equity keeps its `shortname` ("Apple Inc.") first.
    const search = JSON.stringify({
      quotes: [
        {
          symbol: "0P0001DKPM.F",
          quoteType: "MUTUALFUND",
          shortname: "0P0001DKPM.F",
          longname: "Indépendance AM Europe Small A (C)",
          exchange: "FRA",
        },
      ],
    });
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["0P0001DKPM.F", CHART_MCPA]]), search),
    );
    const matches = await provider.resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "FUND",
      isin: "LU1832174962",
      listingCurrency: "EUR",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.displayName).toBe("Indépendance AM Europe Small A (C)");
    expect(matches[0]?.providerExchangeCode).toBe("FRA");
  });

  it("a `shortname` that differs from the symbol only by case is still 'just the symbol'", async () => {
    const search = JSON.stringify({
      quotes: [
        {
          symbol: "0P0001DKPM.F",
          quoteType: "MUTUALFUND",
          shortname: "0p0001dkpm.f",
          longname: "Indépendance AM Europe Small A (C)",
        },
      ],
    });
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["0P0001DKPM.F", CHART_MCPA]]), search),
    );
    const matches = await provider.resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "FUND",
      isin: "LU1832174962",
      listingCurrency: "EUR",
    });
    expect(matches[0]?.displayName).toBe("Indépendance AM Europe Small A (C)");
  });

  it("with no `longname` at all, the symbol-shaped `shortname` is still better than nothing", async () => {
    const search = JSON.stringify({
      quotes: [{ symbol: "0P0001DKPM.F", quoteType: "MUTUALFUND", shortname: "0P0001DKPM.F" }],
    });
    const provider = new YahooQuoteProvider(
      new MapFetcher(new Map([["0P0001DKPM.F", CHART_MCPA]]), search),
    );
    const matches = await provider.resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "FUND",
      isin: "LU1832174962",
      listingCurrency: "EUR",
    });
    expect(matches[0]?.displayName).toBe("0P0001DKPM.F");
  });

  it("drops a candidate whose currency enrichment fails, rather than failing the whole call", async () => {
    const search = JSON.stringify({
      quotes: [
        { symbol: "AAPL", quoteType: "EQUITY", shortname: "Apple Inc." },
        { symbol: "GHOST", quoteType: "EQUITY", shortname: "Ghost Corp" },
      ],
    });
    const provider = new YahooQuoteProvider(
      new MapFetcher(
        new Map([
          ["AAPL", CHART_AAPL],
          ["GHOST", CHART_NOT_FOUND],
        ]),
        search,
      ),
    );
    const matches = await provider.resolve(knownRef);
    expect(matches.map((m) => m.providerSymbol)).toEqual(["AAPL"]);
  });
});

/**
 * The ISIN is not a superset of the ticker. Every case below is a shape a live
 * catalogue actually produced, reduced to the smallest hand-built search body
 * that reproduces it; the ISINs and symbols are public, illustrative ones
 * chosen to fit each shape.
 */
describe("YahooQuoteProvider — resolve() queries the ticker as well as the ISIN", () => {
  /** A fetcher whose search body depends on the query, and which records every query it was asked. */
  class QueryFetcher implements YahooSourceFetcher {
    readonly searches: string[] = [];
    constructor(
      private readonly bodies: ReadonlyMap<string, string>,
      private readonly charts: ReadonlyMap<string, string> = new Map(),
    ) {}
    async fetchSearch(query: string): Promise<string> {
      this.searches.push(query);
      const body = this.bodies.get(query);
      if (body === undefined) throw new Error(`no search fixture registered for query ${query}`);
      return body;
    }
    async fetchChart(symbol: ProviderSymbol): Promise<string> {
      return this.charts.get(symbol) ?? CHART_AAPL;
    }
  }

  function searchBody(...symbols: readonly string[]): string {
    return JSON.stringify({
      quotes: symbols.map((symbol) => ({
        symbol,
        quoteType: "EQUITY",
        shortname: `${symbol} line`,
        exchange: "NMS",
      })),
    });
  }

  const EMPTY_SEARCH = JSON.stringify({ quotes: [] });

  /** `GOOGL`: the ISIN search returns nothing at all, so the ISIN-only query left such a row permanently PENDING. */
  it("resolves from the ticker when the ISIN search returns no candidates at all", async () => {
    const fetcher = new QueryFetcher(
      new Map([
        ["US02079K3059", EMPTY_SEARCH],
        ["GOOGL", searchBody("GOOGL")],
      ]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "US02079K3059",
      symbol: "GOOGL",
      listingCurrency: "USD",
    });

    expect(fetcher.searches).toEqual(["US02079K3059", "GOOGL"]);
    expect(matches.map((match) => match.providerSymbol)).toEqual(["GOOGL"]);
    expect(matches[0]?.matchQuality).toBe("EXACT");
  });

  /**
   * `VOL3.F` (a Frankfurt line of a Stockholm share): the ISIN search offers a
   * SEK Stockholm line and a synthetic `<ISIN>.SG` Stuttgart line carrying one
   * price point, and the instrument's own EUR ticker — years of daily points —
   * was never queried.
   */
  it("ranks the instrument's own ticker ahead of a synthetic <ISIN>.SG line", async () => {
    const fetcher = new QueryFetcher(
      new Map([
        ["SE0000115446", searchBody("SE0000115446.SG", "VOLV-B.ST")],
        ["VOL3.F", searchBody("VOL3.F")],
      ]),
      // The Frankfurt line quotes in the instrument's own declared EUR; the
      // other two come from the ISIN query, so their currency is not this
      // adapter's business (see `isSameSecurityAsRef`).
      new Map([["VOL3.F", CHART_MCPA]]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "SE0000115446",
      symbol: "VOL3.F",
      listingCurrency: "EUR",
    });

    // Both searches ran, every candidate survives, and the order is the one
    // the cap and the caller's `find(EXACT)` both read: own ticker, then the
    // real foreign line, then the synthetic ISIN-derived one.
    expect(matches.map((match) => match.providerSymbol)).toEqual([
      "VOL3.F",
      "VOLV-B.ST",
      "SE0000115446.SG",
    ]);
  });

  /** The cap is what makes the ranking load-bearing rather than cosmetic: a union can exceed it. */
  it("keeps the instrument's own ticker when the union exceeds YAHOO_MAX_RESOLVE_CANDIDATES", async () => {
    const noise = Array.from(
      { length: YAHOO_MAX_RESOLVE_CANDIDATES },
      (_, i) => `NOISE${String(i)}`,
    );
    const fetcher = new QueryFetcher(
      new Map([
        ["SE0000115446", searchBody(...noise)],
        ["VOL3.F", searchBody("VOL3.F")],
      ]),
      new Map([["VOL3.F", CHART_MCPA]]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "SE0000115446",
      symbol: "VOL3.F",
      listingCurrency: "EUR",
    });

    expect(matches).toHaveLength(YAHOO_MAX_RESOLVE_CANDIDATES);
    expect(matches[0]?.providerSymbol).toBe("VOL3.F");
  });

  /**
   * The regression the wider query could otherwise introduce, seen live: a
   * bare ticker can name two companies — `SAN` is Sanofi in EUR on Euronext
   * Paris and Banco Santander's USD NYSE line at Yahoo, so the ticker query
   * returns a *different company* at an EXACT match quality. A wrong-currency price on the wrong
   * issuer is worse than no price, so the ticker-only candidate goes; the
   * ISIN's own line stays, whatever currency it quotes in, because the caller
   * decides between listings of the same issue.
   */
  it("drops a ticker-only candidate quoting in another currency, and keeps the ISIN's own line", async () => {
    const fetcher = new QueryFetcher(
      new Map([
        ["FR0000120578", searchBody("SAN.PA")],
        ["SAN", searchBody("SAN")],
      ]),
      // Both quote USD; only one of them was vouched for by the ISIN.
      new Map([
        ["SAN.PA", CHART_AAPL],
        ["SAN", CHART_AAPL],
      ]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "FR0000120578",
      symbol: "SAN",
      listingCurrency: "EUR",
    });

    expect(fetcher.searches).toEqual(["FR0000120578", "SAN"]);
    expect(matches.map((match) => match.providerSymbol)).toEqual(["SAN.PA"]);
  });

  it("keeps a ticker-only candidate that agrees with the declared currency", async () => {
    const fetcher = new QueryFetcher(
      new Map([
        ["FR0010425595", searchBody("FR0010425595.SG")],
        ["ALCLS", searchBody("ALCLS.PA")],
      ]),
      new Map([
        ["FR0010425595.SG", CHART_MCPA],
        ["ALCLS.PA", CHART_MCPA],
      ]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "FR0010425595",
      symbol: "ALCLS",
      listingCurrency: "EUR",
    });

    // Ranked ahead of the synthetic `<ISIN>.SG` line it was competing with,
    // which is the mapping the ISIN-only query actually produced (1 price row).
    expect(matches.map((match) => match.providerSymbol)).toEqual(["ALCLS.PA", "FR0010425595.SG"]);
  });

  /** An ISIN-less instrument has nothing but its ticker, so the guard must not fire there. */
  it("keeps a currency-mismatched ticker candidate when the ref carries no ISIN at all", async () => {
    const fetcher = new QueryFetcher(new Map([["AAPL", searchBody("AAPL")]]));
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      symbol: "AAPL",
      listingCurrency: "EUR",
    });
    expect(matches.map((match) => match.providerSymbol)).toEqual(["AAPL"]);
  });

  it("issues one search only when the ISIN's own results already carry the instrument's ticker", async () => {
    const fetcher = new QueryFetcher(new Map([["US0378331005", searchBody("AAPL", "AAPL.MX")]]));
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "US0378331005",
      symbol: "AAPL",
      listingCurrency: "USD",
    });

    expect(fetcher.searches).toEqual(["US0378331005"]);
    expect(matches.map((match) => match.providerSymbol)).toEqual(["AAPL", "AAPL.MX"]);
  });

  it("keeps the ticker's candidates when the ISIN search itself fails", async () => {
    const fetcher = new QueryFetcher(new Map([["GOOGL", searchBody("GOOGL")]]));
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      // No fixture registered for the ISIN, so `fetchSearch` throws for it.
      isin: "US02079K3059",
      symbol: "GOOGL",
      listingCurrency: "USD",
    });

    expect(matches.map((match) => match.providerSymbol)).toEqual(["GOOGL"]);
  });

  it("keeps the ticker's candidates when the ISIN search answers with a malformed body", async () => {
    const fetcher = new QueryFetcher(
      new Map([
        ["US02079K3059", "not json"],
        ["GOOGL", searchBody("GOOGL")],
      ]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "US02079K3059",
      symbol: "GOOGL",
      listingCurrency: "USD",
    });

    expect(matches.map((match) => match.providerSymbol)).toEqual(["GOOGL"]);
  });

  /** "Nothing found" and "the provider could not be asked" stay different facts. */
  it("propagates the first failure when every search fails, rather than reporting nothing found", async () => {
    const fetcher = new QueryFetcher(new Map());
    await expect(
      new YahooQuoteProvider(fetcher).resolve({
        instrumentId: "11111111-1111-1111-1111-111111111111",
        kind: "SHARE",
        isin: "US02079K3059",
        symbol: "GOOGL",
        listingCurrency: "USD",
      }),
    ).rejects.toThrow("no search fixture registered for query US02079K3059");
  });

  it("still issues a single search when the ref carries an ISIN and no symbol", async () => {
    const fetcher = new QueryFetcher(new Map([["US0378331005", searchBody("AAPL")]]));
    await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "US0378331005",
      listingCurrency: "USD",
    });
    expect(fetcher.searches).toEqual(["US0378331005"]);
  });

  it("issues a single search when isin and symbol are the same string", async () => {
    const fetcher = new QueryFetcher(new Map([["US0378331005", searchBody("AAPL")]]));
    await new YahooQuoteProvider(fetcher).resolve({
      instrumentId: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      isin: "US0378331005",
      symbol: "us0378331005",
      listingCurrency: "USD",
    });
    expect(fetcher.searches).toEqual(["US0378331005"]);
  });
});

describe("YahooQuoteProvider — resolve() bounds the chart-enrichment fan-out (N+1 cap)", () => {
  const knownRef: InstrumentRef = {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    kind: "SHARE",
    symbol: "AAPL",
    listingCurrency: "USD",
  };

  /** A search response with more matching candidates than `YAHOO_MAX_RESOLVE_CANDIDATES`, all the same relevant `quoteType` so none are filtered out before enrichment. */
  function manyCandidatesSearch(count: number): string {
    return JSON.stringify({
      quotes: Array.from({ length: count }, (_, index) => ({
        symbol: `SYM${index}`,
        quoteType: "EQUITY",
        shortname: `Company ${index}`,
        exchange: "NMS",
      })),
    });
  }

  /** Counts `fetchChart` invocations — the actual per-candidate HTTP call this cap bounds (rule: assert behavior, not configuration). */
  class CountingChartFetcher implements YahooSourceFetcher {
    callCount = 0;
    constructor(private readonly search: string) {}
    async fetchSearch(): Promise<string> {
      return this.search;
    }
    async fetchChart(): Promise<string> {
      this.callCount += 1;
      return CHART_AAPL;
    }
  }

  it("never issues more than YAHOO_MAX_RESOLVE_CANDIDATES chart-enrichment calls, even against a fixture with more matching candidates", async () => {
    const fetcher = new CountingChartFetcher(manyCandidatesSearch(7));
    const provider = new YahooQuoteProvider(fetcher);
    const matches = await provider.resolve(knownRef);

    expect(fetcher.callCount).toBeLessThanOrEqual(YAHOO_MAX_RESOLVE_CANDIDATES);
    expect(fetcher.callCount).toBe(YAHOO_MAX_RESOLVE_CANDIDATES);
    expect(matches.length).toBeLessThanOrEqual(YAHOO_MAX_RESOLVE_CANDIDATES);
  });
});

describe("YahooQuoteProvider — out-of-range numeric fields map to ProviderMalformedResponse, not a raw RangeError", () => {
  interface MutableChartFixture {
    chart: {
      result: [
        {
          meta: { regularMarketTime: number; regularMarketPrice: number };
          timestamp: number[];
          indicators: { quote: [{ close: number[] }] };
        },
      ];
    };
  }

  function chartWith(mutate: (parsed: MutableChartFixture) => void): string {
    const parsed = JSON.parse(CHART_AAPL) as MutableChartFixture;
    mutate(parsed);
    return JSON.stringify(parsed);
  }

  it("fetchLatest(): a regularMarketTime outside Date's representable range is rejected, not thrown as a raw RangeError", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].meta.regularMarketTime = 1e13;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    await expect(provider.fetchLatest(["AAPL"])).rejects.toThrow(ProviderMalformedResponse);
  });

  it("fetchDailyHistory(): a timestamp outside Date's representable range is rejected, not thrown as a raw RangeError", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].timestamp[0] = 1e13;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    await expect(provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-10")).rejects.toThrow(
      ProviderMalformedResponse,
    );
  });

  it("fetchLatest(): a regularMarketPrice large enough to force toFixed's exponential notation is rejected, not thrown as a raw RangeError", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].meta.regularMarketPrice = 1e21;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    await expect(provider.fetchLatest(["AAPL"])).rejects.toThrow(ProviderMalformedResponse);
  });

  it("fetchDailyHistory(): a close value large enough to force toFixed's exponential notation is rejected, not thrown as a raw RangeError", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].indicators.quote[0].close[0] = 1e21;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    await expect(provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-10")).rejects.toThrow(
      ProviderMalformedResponse,
    );
  });
});

describe("YahooQuoteProvider — a non-positive price is rejected, never fabricated (security review, mirrors ecb)", () => {
  interface MutableChartFixture {
    chart: {
      result: [
        {
          meta: { regularMarketTime: number; regularMarketPrice: number };
          timestamp: number[];
          indicators: { quote: [{ close: number[] }] };
        },
      ];
    };
  }

  function chartWith(mutate: (parsed: MutableChartFixture) => void): string {
    const parsed = JSON.parse(CHART_AAPL) as MutableChartFixture;
    mutate(parsed);
    return JSON.stringify(parsed);
  }

  async function rejectedKind(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ProviderMalformedResponse) return error.kind;
      throw error;
    }
    throw new Error("expected promise to reject");
  }

  it("fetchLatest(): regularMarketPrice: 0 (Yahoo's halted/delisted/pre-IPO sentinel) rejects with the PROVIDER_MALFORMED_RESPONSE taxonomy member, not a bare Error", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].meta.regularMarketPrice = 0;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    expect(await rejectedKind(provider.fetchLatest(["AAPL"]))).toBe("PROVIDER_MALFORMED_RESPONSE");
  });

  it("fetchLatest(): a negative regularMarketPrice rejects with the same taxonomy member", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].meta.regularMarketPrice = -12.5;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    expect(await rejectedKind(provider.fetchLatest(["AAPL"]))).toBe("PROVIDER_MALFORMED_RESPONSE");
  });

  it("fetchDailyHistory(): a zero close value rejects with the same taxonomy member", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].indicators.quote[0].close[0] = 0;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    expect(await rejectedKind(provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-10"))).toBe(
      "PROVIDER_MALFORMED_RESPONSE",
    );
  });

  it("fetchDailyHistory(): a negative close value rejects with the same taxonomy member", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].indicators.quote[0].close[0] = -1;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    expect(await rejectedKind(provider.fetchDailyHistory("AAPL", "2024-01-08", "2024-01-10"))).toBe(
      "PROVIDER_MALFORMED_RESPONSE",
    );
  });

  it("a positive price at the same magnitude is unaffected (discriminating control — the guard is 'non-positive', not 'any price near zero')", async () => {
    const chart = chartWith((parsed) => {
      parsed.chart.result[0].meta.regularMarketPrice = 0.01;
    });
    const provider = new YahooQuoteProvider(new MapFetcher(new Map([["AAPL", chart]])));
    const [observation] = await provider.fetchLatest(["AAPL"]);
    expect(observation!.price.equals(new Decimal("0.01"))).toBe(true);
  });
});

/**
 * CRYPTO is priced from Yahoo's `<SYMBOL>-<CCY>` pairs. The search and
 * chart bodies are verbatim live captures (2026-10-02):
 * `search-crypto-btc-eur-realshape.json` (`q=BTC-EUR`),
 * `search-crypto-sol-realshape.json` (`q=SOL`, which carries no `SOL-EUR`
 * line — the reason the pair is asked for first) and
 * `chart-btc-eur-realshape.json`.
 */
describe("YahooQuoteProvider — CRYPTO pairs", () => {
  const SEARCH_BTC_EUR = fixture("search-crypto-btc-eur-realshape.json");
  const SEARCH_SOL = fixture("search-crypto-sol-realshape.json");
  const CHART_BTC_EUR = fixture("chart-btc-eur-realshape.json");
  const EMPTY_SEARCH = JSON.stringify({ quotes: [] });

  /** The BTC-EUR capture re-labelled as another line — only `meta` is read by `resolve()`'s enrichment. */
  function chartFor(symbol: string, currency: string): string {
    const body = JSON.parse(CHART_BTC_EUR) as {
      chart: { result: { meta: Record<string, unknown> }[] };
    };
    body.chart.result[0]!.meta = { ...body.chart.result[0]!.meta, symbol, currency };
    return JSON.stringify(body);
  }

  class QueryFetcher implements YahooSourceFetcher {
    readonly searches: string[] = [];
    constructor(
      private readonly bodies: ReadonlyMap<string, string>,
      private readonly charts: ReadonlyMap<string, string>,
    ) {}
    async fetchSearch(query: string): Promise<string> {
      this.searches.push(query);
      const body = this.bodies.get(query);
      if (body === undefined) throw new Error(`no search fixture registered for query ${query}`);
      return body;
    }
    async fetchChart(symbol: ProviderSymbol): Promise<string> {
      const body = this.charts.get(symbol);
      if (body === undefined) throw new Error(`no chart fixture registered for symbol ${symbol}`);
      return body;
    }
  }

  function cryptoRef(symbol: string, listingCurrency: string): InstrumentRef {
    return {
      instrumentId: "33333333-3333-3333-3333-333333333333",
      kind: "CRYPTO",
      symbol,
      listingCurrency,
    };
  }

  it("asks for `<SYMBOL>-<CCY>` first and stops there: BTC declared in EUR is BTC-EUR, EXACT, ticker BTC", async () => {
    const fetcher = new QueryFetcher(
      new Map([["BTC-EUR", SEARCH_BTC_EUR]]),
      new Map([["BTC-EUR", CHART_BTC_EUR]]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve(cryptoRef("BTC", "EUR"));

    expect(fetcher.searches).toEqual(["BTC-EUR"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      providerSymbol: "BTC-EUR",
      currency: "EUR",
      matchQuality: "EXACT",
      tickerSymbol: "BTC",
    });
  });

  it("falls back to the bare symbol when the pair has no line, keeping only crypto pairs (SOL: no SOL-EUR, five equities and two futures dropped)", async () => {
    const fetcher = new QueryFetcher(
      new Map([
        ["SOL-EUR", EMPTY_SEARCH],
        ["SOL", SEARCH_SOL],
      ]),
      new Map([["SOL-USD", chartFor("SOL-USD", "USD")]]),
    );
    const matches = await new YahooQuoteProvider(fetcher).resolve(cryptoRef("SOL", "EUR"));

    expect(fetcher.searches).toEqual(["SOL-EUR", "SOL"]);
    expect(matches.map((match) => match.providerSymbol)).toEqual(["SOL-USD"]);
    expect(matches[0]).toMatchObject({
      currency: "USD",
      matchQuality: "PROBABLE",
      tickerSymbol: "SOL",
    });
  });

  it("a discovery search (placeholder currency XXX) queries the bare symbol only", async () => {
    const fetcher = new QueryFetcher(
      new Map([["SOL", SEARCH_SOL]]),
      new Map([["SOL-USD", chartFor("SOL-USD", "USD")]]),
    );
    await new YahooQuoteProvider(fetcher).resolve(cryptoRef("SOL", "XXX"));

    expect(fetcher.searches).toEqual(["SOL"]);
  });

  it("stamps a crypto pair's quote and history REALTIME — Yahoo quotes it live", async () => {
    const provider = new YahooQuoteProvider(
      new QueryFetcher(new Map(), new Map([["BTC-EUR", CHART_BTC_EUR]])),
    );

    const [latest] = await provider.fetchLatest(["BTC-EUR"]);
    expect(latest).toMatchObject({ currency: "EUR", quality: "REALTIME", sourceKey: "yahoo" });

    const history = await provider.fetchDailyHistory("BTC-EUR", "2025-07-13", "2025-07-16");
    expect(history.map((point) => point.priceDate)).toEqual([
      "2025-07-13",
      "2025-07-14",
      "2025-07-15",
      "2025-07-16",
    ]);
    expect(new Set(history.map((point) => point.quality))).toEqual(new Set(["REALTIME"]));
  });
});
