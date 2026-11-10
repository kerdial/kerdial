import { describe, expect, it } from "vitest";
import {
  DataGap,
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  SymbolNotFound,
} from "./index.js";
import type {
  CurrencyPair,
  FxObservation,
  FxRateProvider,
  InstrumentRef,
  ProviderCapabilities,
  QuoteObservation,
  QuoteProvider,
} from "./index.js";

/**
 * Package-level smoke test: everything this package exports (T-13) is reachable
 * through the single public entry point, `./index.js` — the same surface
 * `ledger`/`valuation`/`api` import from. The
 * type-level and behavioural detail lives in `errors.test.ts` and
 * `type-conformance.test.ts`; this file only proves the barrel re-export
 * itself is wired correctly.
 */
describe("market/ports — public surface", () => {
  it("re-exports the closed error taxonomy as constructible classes", () => {
    expect(new ProviderRateLimited("fake", 30)).toBeInstanceOf(Error);
    expect(new ProviderUnavailable("fake")).toBeInstanceOf(Error);
    expect(new SymbolNotFound("fake", "XYZ")).toBeInstanceOf(Error);
    expect(new DataGap("fake", "2024-01-01", "2024-01-31")).toBeInstanceOf(Error);
    expect(new ProviderMalformedResponse("fake")).toBeInstanceOf(Error);
  });

  it("re-exports the QuoteProvider / FxRateProvider / DTO types (compile-time check)", () => {
    const capabilities: ProviderCapabilities = {
      key: "fake",
      assetKinds: ["SHARE"],
      supportsLatestQuote: true,
      supportsDailyHistory: true,
      supportsCorporateActions: false,
      maxHistoryYears: 10,
      quoteQuality: "DELAYED",
      delayMinutes: 15,
      batchSize: 50,
    };
    const ref: InstrumentRef = {
      instrumentId: "00000000-0000-0000-0000-000000000000",
      kind: "SHARE",
      listingCurrency: "EUR",
    };
    const pair: CurrencyPair = { base: "EUR", quote: "USD" };
    expect(capabilities.key).toBe("fake");
    expect(ref.kind).toBe("SHARE");
    expect(pair.base).toBe("EUR");

    // Referenced only for their types, to prove the barrel re-exports them —
    // never constructed here (that would require a real implementation).
    const _typesReachable: [QuoteProvider, FxRateProvider, QuoteObservation, FxObservation] =
      undefined as unknown as [QuoteProvider, FxRateProvider, QuoteObservation, FxObservation];
    void _typesReachable;
  });
});
