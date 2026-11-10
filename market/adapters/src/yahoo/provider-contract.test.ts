/**
 * Runs the reusable provider contract suite (T-16) against the real `yahoo` adapter (T-31) — mirrors
 * `ecb`'s `provider-contract.test.ts` (T-15) wiring exactly.
 * `YahooQuoteProvider` implements `QuoteProvider`, so
 * `quoteProviderContractCases` applies here (as opposed to `ecb`'s
 * `FxRateProvider`/`fxRateProviderContractCases`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderRateLimited,
  ProviderUnavailable,
  quoteProviderContractCases,
} from "@kerdial/market-ports";
import type { InstrumentRef, ProviderSymbol } from "@kerdial/market-ports";
import { describe, it } from "vitest";
import type { YahooChartRange, YahooSourceFetcher } from "./http-fetcher.js";
import { YahooQuoteProvider } from "./provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "yahoo");
const CHART_FIXTURE = readFileSync(join(fixturesDir, "chart-happy-aapl.json"), "utf8");
const SEARCH_FIXTURE = readFileSync(join(fixturesDir, "search-happy-aapl.json"), "utf8");
const NOT_FOUND_FIXTURE = readFileSync(join(fixturesDir, "chart-not-found.json"), "utf8");

const KNOWN_SYMBOL: ProviderSymbol = "AAPL";
const UNKNOWN_SYMBOL: ProviderSymbol = "NOTASYMBOL";

class FixtureFetcher implements YahooSourceFetcher {
  async fetchSearch(_query: string): Promise<string> {
    return SEARCH_FIXTURE;
  }
  async fetchChart(symbol: ProviderSymbol, _range: YahooChartRange): Promise<string> {
    return symbol === UNKNOWN_SYMBOL ? NOT_FOUND_FIXTURE : CHART_FIXTURE;
  }
}

/** Simulates the HTTP-level rate-limit mapping `http-fetcher.ts` performs for a real HTTP 429 — this test never touches the network. */
class RateLimitedFetcher implements YahooSourceFetcher {
  async fetchSearch(): Promise<string> {
    throw new ProviderRateLimited("yahoo", 30);
  }
  async fetchChart(): Promise<string> {
    throw new ProviderRateLimited("yahoo", 30);
  }
}

/** Simulates a transient network failure — `http-fetcher.ts`'s mapping for a `fetch()` rejection. */
class TransientNetworkFailureFetcher implements YahooSourceFetcher {
  async fetchSearch(): Promise<string> {
    throw new ProviderUnavailable("yahoo", "simulated transient network error");
  }
  async fetchChart(): Promise<string> {
    throw new ProviderUnavailable("yahoo", "simulated transient network error");
  }
}

/** Simulates a full outage — `http-fetcher.ts`'s mapping for a non-OK HTTP status. */
class OutageFetcher implements YahooSourceFetcher {
  async fetchSearch(): Promise<string> {
    throw new ProviderUnavailable("yahoo", "simulated full provider outage");
  }
  async fetchChart(): Promise<string> {
    throw new ProviderUnavailable("yahoo", "simulated full provider outage");
  }
}

/** Returns a body `parse-chart.ts` cannot parse, so it maps it to `ProviderMalformedResponse` itself — no fixture-level throw needed. */
class MalformedResponseFetcher implements YahooSourceFetcher {
  async fetchSearch(): Promise<string> {
    return "this is not valid JSON";
  }
  async fetchChart(): Promise<string> {
    return "this is not valid JSON";
  }
}

const KNOWN_REF: InstrumentRef = {
  instrumentId: "11111111-1111-1111-1111-111111111111",
  kind: "SHARE",
  symbol: KNOWN_SYMBOL,
  listingCurrency: "USD",
};

describe("QuoteProvider contract — yahoo (T-16, T-31)", () => {
  for (const contractCase of quoteProviderContractCases({
    label: "yahoo",
    knownRef: KNOWN_REF,
    knownSymbol: KNOWN_SYMBOL,
    unknownSymbol: UNKNOWN_SYMBOL,
    historyFrom: "2024-01-08",
    historyTo: "2024-01-10",
    makeHappyPath: () => new YahooQuoteProvider(new FixtureFetcher()),
    makeRateLimited: () => new YahooQuoteProvider(new RateLimitedFetcher()),
    makeTransientNetworkFailure: () => new YahooQuoteProvider(new TransientNetworkFailureFetcher()),
    makeOutage: () => new YahooQuoteProvider(new OutageFetcher()),
    makeMalformedResponse: () => new YahooQuoteProvider(new MalformedResponseFetcher()),
  })) {
    it(contractCase.name, contractCase.run);
  }
});
