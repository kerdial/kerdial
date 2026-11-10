/**
 * Runs the provider contract suite (T-16) against dedicated in-memory
 * fixture doubles — proof the suite itself
 * is correct before it is ever pointed at a real adapter (`market/adapters`'s
 * `ecb/provider-contract.test.ts` does that for the `FxRateProvider` side,
 * so the suite is proven to work on a real adapter, not only on a fake).
 *
 * The four lines of `describe`/`it` glue below are exactly what T-31/T-32
 * repeat unchanged to register `yahoo`/`coingecko` (a design
 * constraint) — everything else comes from `quoteProviderContractCases`/
 * `fxRateProviderContractCases`.
 */
import { describe, it } from "vitest";
import type { ContractCase } from "../provider-contract.js";
import { fxRateProviderContractCases, quoteProviderContractCases } from "../provider-contract.js";
import {
  FX_HISTORY_FROM,
  FX_HISTORY_TO,
  KNOWN_FX_PAIR,
  UNKNOWN_FX_PAIR,
  ConfigurableFxRateProvider,
} from "./fx-rate-provider-fixture.js";
import {
  KNOWN_QUOTE_REF,
  KNOWN_QUOTE_SYMBOL,
  QUOTE_HISTORY_FROM,
  QUOTE_HISTORY_TO,
  UNKNOWN_QUOTE_SYMBOL,
  ConfigurableQuoteProvider,
} from "./quote-provider-fixture.js";

function registerCases(label: string, cases: readonly ContractCase[]): void {
  describe(label, () => {
    for (const contractCase of cases) {
      it(contractCase.name, contractCase.run);
    }
  });
}

registerCases(
  "QuoteProvider contract — in-memory fixture double",
  quoteProviderContractCases({
    label: "in-memory-quote-fixture",
    knownRef: KNOWN_QUOTE_REF,
    knownSymbol: KNOWN_QUOTE_SYMBOL,
    unknownSymbol: UNKNOWN_QUOTE_SYMBOL,
    historyFrom: QUOTE_HISTORY_FROM,
    historyTo: QUOTE_HISTORY_TO,
    makeHappyPath: () => new ConfigurableQuoteProvider("OK", "in-memory-quote-fixture"),
    makeRateLimited: () => new ConfigurableQuoteProvider("RATE_LIMITED", "in-memory-quote-fixture"),
    makeTransientNetworkFailure: () =>
      new ConfigurableQuoteProvider("TRANSIENT_NETWORK", "in-memory-quote-fixture"),
    makeOutage: () => new ConfigurableQuoteProvider("OUTAGE", "in-memory-quote-fixture"),
    makeMalformedResponse: () =>
      new ConfigurableQuoteProvider("MALFORMED", "in-memory-quote-fixture"),
  }),
);

registerCases(
  "FxRateProvider contract — in-memory fixture double",
  fxRateProviderContractCases({
    label: "in-memory-fx-fixture",
    knownPair: KNOWN_FX_PAIR,
    unknownPair: UNKNOWN_FX_PAIR,
    historyFrom: FX_HISTORY_FROM,
    historyTo: FX_HISTORY_TO,
    makeHappyPath: () => new ConfigurableFxRateProvider("OK", "in-memory-fx-fixture"),
    makeRateLimited: () => new ConfigurableFxRateProvider("RATE_LIMITED", "in-memory-fx-fixture"),
    makeTransientNetworkFailure: () =>
      new ConfigurableFxRateProvider("TRANSIENT_NETWORK", "in-memory-fx-fixture"),
    makeOutage: () => new ConfigurableFxRateProvider("OUTAGE", "in-memory-fx-fixture"),
    makeMalformedResponse: () =>
      new ConfigurableFxRateProvider("MALFORMED", "in-memory-fx-fixture"),
  }),
);
