/**
 * A configurable, fixture-backed `QuoteProvider` test double built solely
 * for the provider-contract suite (T-16) and its swap-diff
 * companion test. Deliberately its own double rather than a reuse of T-13's
 * port-implementability scaffolding, so as not to conflate "proof the port is
 * implementable" (T-13's job — now carried by the real adapters plus the
 * inline doubles in `type-conformance.test.ts`) with "proof an adapter
 * conforms to the contract" (this fixture's job).
 */
import { Decimal } from "@kerdial/core-decimal";
import {
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  SymbolNotFound,
} from "../errors.js";
import type { QuoteProvider } from "../quote-provider.js";
import type {
  InstrumentRef,
  PriceObservation,
  ProviderCapabilities,
  ProviderSymbol,
  ProviderSymbolMatch,
  QuoteObservation,
} from "../types.js";

export const KNOWN_QUOTE_SYMBOL: ProviderSymbol = "KNOWN-CO";
export const UNKNOWN_QUOTE_SYMBOL: ProviderSymbol = "NO-SUCH-CO";
export const QUOTE_HISTORY_FROM = "2024-01-08";
export const QUOTE_HISTORY_TO = "2024-01-10";

export const KNOWN_QUOTE_REF: InstrumentRef = {
  instrumentId: "instr-known-co",
  kind: "SHARE",
  symbol: KNOWN_QUOTE_SYMBOL,
  listingCurrency: "EUR",
};

/** date-ascending, matching `QUOTE_HISTORY_FROM`..`QUOTE_HISTORY_TO`. */
const HISTORY: readonly { date: string; close: string }[] = [
  { date: "2024-01-08", close: "100.00" },
  { date: "2024-01-09", close: "101.50" },
  { date: "2024-01-10", close: "99.75" },
];

type QuoteFailureMode = "OK" | "RATE_LIMITED" | "TRANSIENT_NETWORK" | "OUTAGE" | "MALFORMED";

/**
 * Every scenario the contract suite provokes lives behind one `mode` switch,
 * so each `make*()` fixture factory in `QuoteProviderContractFixtures` is a
 * one-line constructor call — no scenario shares mutable state with another.
 */
export class ConfigurableQuoteProvider implements QuoteProvider {
  readonly #mode: QuoteFailureMode;
  readonly #sourceKey: string;

  constructor(mode: QuoteFailureMode, sourceKey: string) {
    this.#mode = mode;
    this.#sourceKey = sourceKey;
  }

  capabilities(): ProviderCapabilities {
    return {
      key: this.#sourceKey,
      assetKinds: ["SHARE"],
      supportsLatestQuote: true,
      supportsDailyHistory: true,
      supportsCorporateActions: false,
      maxHistoryYears: "unbounded",
      quoteQuality: "DELAYED",
      delayMinutes: 15,
      batchSize: 50,
    };
  }

  async resolve(ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
    if (ref.symbol !== KNOWN_QUOTE_SYMBOL) return [];
    return [
      {
        providerSymbol: KNOWN_QUOTE_SYMBOL,
        displayName: "Known Co",
        currency: ref.listingCurrency,
        matchQuality: "EXACT",
      },
    ];
  }

  async fetchLatest(symbols: ProviderSymbol[]): Promise<QuoteObservation[]> {
    this.#maybeFail();
    return symbols.map((symbol) => {
      if (symbol !== KNOWN_QUOTE_SYMBOL) throw new SymbolNotFound(this.#sourceKey, symbol);
      const latest = HISTORY[HISTORY.length - 1]!;
      return {
        price: new Decimal(latest.close),
        currency: "EUR",
        asOf: `${latest.date}T16:00:00.000Z`,
        quality: "DELAYED",
        sourceKey: this.#sourceKey,
      };
    });
  }

  async fetchDailyHistory(
    symbol: ProviderSymbol,
    from: string,
    to: string,
  ): Promise<PriceObservation[]> {
    this.#maybeFail();
    if (symbol !== KNOWN_QUOTE_SYMBOL) throw new SymbolNotFound(this.#sourceKey, symbol);
    return HISTORY.filter((point) => point.date >= from && point.date <= to).map((point) => ({
      priceDate: point.date,
      close: new Decimal(point.close),
      currency: "EUR",
      quality: "EOD",
      sourceKey: this.#sourceKey,
    }));
  }

  #maybeFail(): void {
    switch (this.#mode) {
      case "RATE_LIMITED":
        throw new ProviderRateLimited(this.#sourceKey, 30);
      case "TRANSIENT_NETWORK":
        throw new ProviderUnavailable(this.#sourceKey, "simulated transient network error");
      case "OUTAGE":
        throw new ProviderUnavailable(this.#sourceKey, "simulated full provider outage");
      case "MALFORMED":
        throw new ProviderMalformedResponse(
          this.#sourceKey,
          "simulated malformed upstream response",
        );
      case "OK":
        return;
    }
  }
}
