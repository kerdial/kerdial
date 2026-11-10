/**
 * A configurable, fixture-backed `FxRateProvider` test double — the
 * `FxRateProvider` analogue of `quote-provider-fixture.ts`. See that file's
 * doc comment for why the contract suite keeps its own doubles.
 */
import { Decimal } from "@kerdial/core-decimal";
import {
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  SymbolNotFound,
} from "../errors.js";
import type { FxRateProvider } from "../fx-rate-provider.js";
import type { CurrencyPair, FxObservation, FxProviderCapabilities } from "../types.js";

export const KNOWN_FX_PAIR: CurrencyPair = { base: "EUR", quote: "USD" };
export const UNKNOWN_FX_PAIR: CurrencyPair = { base: "EUR", quote: "XAU" };
export const FX_HISTORY_FROM = "2024-01-08";
export const FX_HISTORY_TO = "2024-01-10";

/** date-ascending, matching `FX_HISTORY_FROM`..`FX_HISTORY_TO`. */
const HISTORY: readonly { date: string; rate: string }[] = [
  { date: "2024-01-08", rate: "0.9153318077" },
  { date: "2024-01-09", rate: "0.9140767825" },
  { date: "2024-01-10", rate: "0.9216589862" },
];

type FxFailureMode = "OK" | "RATE_LIMITED" | "TRANSIENT_NETWORK" | "OUTAGE" | "MALFORMED";

function pairKey(pair: CurrencyPair): string {
  return `${pair.base}/${pair.quote}`;
}

export class ConfigurableFxRateProvider implements FxRateProvider {
  readonly #mode: FxFailureMode;
  readonly #sourceKey: string;

  constructor(mode: FxFailureMode, sourceKey: string) {
    this.#mode = mode;
    this.#sourceKey = sourceKey;
  }

  capabilities(): FxProviderCapabilities {
    return {
      key: this.#sourceKey,
      publishedPairs: [KNOWN_FX_PAIR],
      baseCurrency: "EUR",
      publicationTimeUtc: "15:00",
      maxHistoryYears: "unbounded",
    };
  }

  async fetchDailyRates(pairs: CurrencyPair[], from: string, to: string): Promise<FxObservation[]> {
    this.#maybeFail();
    return pairs.flatMap((pair) => {
      if (pairKey(pair) !== pairKey(KNOWN_FX_PAIR))
        throw new SymbolNotFound(this.#sourceKey, pairKey(pair));
      return HISTORY.filter((point) => point.date >= from && point.date <= to).map((point) => ({
        base: pair.base,
        quote: pair.quote,
        rate: new Decimal(point.rate),
        rateDate: point.date,
        sourceKey: this.#sourceKey,
      }));
    });
  }

  async fetchLatestRates(pairs: CurrencyPair[]): Promise<FxObservation[]> {
    this.#maybeFail();
    return pairs.map((pair) => {
      if (pairKey(pair) !== pairKey(KNOWN_FX_PAIR))
        throw new SymbolNotFound(this.#sourceKey, pairKey(pair));
      const latest = HISTORY[HISTORY.length - 1]!;
      return {
        base: pair.base,
        quote: pair.quote,
        rate: new Decimal(latest.rate),
        rateDate: latest.date,
        sourceKey: this.#sourceKey,
      };
    });
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
