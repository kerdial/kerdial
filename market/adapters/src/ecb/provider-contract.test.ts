/**
 * Runs the reusable provider contract suite (T-16) against the real `ecb` adapter (T-15) — the proof
 * the suite works against an actual adapter, not only against a fake
 * (`market/ports`'s own `__tests__/provider-contract.test.ts` covers the
 * fixture-double side). `EcbFxRateProvider` implements only `FxRateProvider`
 * (FR-63), so only `fxRateProviderContractCases` applies here; `yahoo`/
 * `coingecko` (T-31/T-32) will register with `quoteProviderContractCases`
 * the same way once they exist — no change to the suite itself, per this
 * task's design constraint.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderRateLimited,
  ProviderUnavailable,
  fxRateProviderContractCases,
} from "@kerdial/market-ports";
import { describe, it } from "vitest";
import type { EcbSourceFetcher } from "./http-fetcher.js";
import { EcbFxRateProvider } from "./provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "ecb");
const HIST_FIXTURE = readFileSync(join(fixturesDir, "sdw-exr-fixture.csv"), "utf8");
const DAILY_FIXTURE = readFileSync(join(fixturesDir, "eurofxref-daily-fixture.xml"), "utf8");

class FixtureFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    return HIST_FIXTURE;
  }
  async fetchDailyXml(): Promise<string> {
    return DAILY_FIXTURE;
  }
}

/** Simulates the HTTP-level rate-limit mapping `http-fetcher.ts` performs for a real HTTP 429 — this test never touches the network. */
class RateLimitedFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    throw new ProviderRateLimited("ecb", 30);
  }
  async fetchDailyXml(): Promise<string> {
    throw new ProviderRateLimited("ecb", 30);
  }
}

/** Simulates a transient network failure — `http-fetcher.ts`'s mapping for a `fetch()` rejection. */
class TransientNetworkFailureFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    throw new ProviderUnavailable("ecb", "simulated transient network error");
  }
  async fetchDailyXml(): Promise<string> {
    throw new ProviderUnavailable("ecb", "simulated transient network error");
  }
}

/** Simulates a full outage — `http-fetcher.ts`'s mapping for a non-OK HTTP status. */
class OutageFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    throw new ProviderUnavailable("ecb", "simulated full provider outage");
  }
  async fetchDailyXml(): Promise<string> {
    throw new ProviderUnavailable("ecb", "simulated full provider outage");
  }
}

/** Returns a body neither `parse-csv.ts` nor `parse-xml.ts` can parse, so both map it to `ProviderMalformedResponse` themselves — no fixture-level throw needed. */
class MalformedResponseFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    return "this is not a valid ECB statistics API csvdata body";
  }
  async fetchDailyXml(): Promise<string> {
    return "<not-a-valid-eurofxref-daily-xml-body/>";
  }
}

describe("FxRateProvider contract — ecb (T-16, T-15)", () => {
  for (const contractCase of fxRateProviderContractCases({
    label: "ecb",
    knownPair: { base: "EUR", quote: "USD" },
    unknownPair: { base: "EUR", quote: "XAU" },
    historyFrom: "2024-01-08",
    historyTo: "2024-01-10",
    makeHappyPath: () => new EcbFxRateProvider(new FixtureFetcher()),
    makeRateLimited: () => new EcbFxRateProvider(new RateLimitedFetcher()),
    makeTransientNetworkFailure: () => new EcbFxRateProvider(new TransientNetworkFailureFetcher()),
    makeOutage: () => new EcbFxRateProvider(new OutageFetcher()),
    makeMalformedResponse: () => new EcbFxRateProvider(new MalformedResponseFetcher()),
  })) {
    it(contractCase.name, contractCase.run);
  }
});
