import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import type { FxRateProvider } from "./fx-rate-provider.js";
import type { QuoteProvider } from "./quote-provider.js";
import type { FxObservation, PriceObservation, QuoteObservation } from "./types.js";

/**
 * Compile-time proofs for the port's acceptance criteria
 * (T-13). Every assertion in this file is checked by `tsc`
 * (`pnpm typecheck` / `pnpm build`), not by `vitest run` — the runtime
 * assertions below just additionally exercise the same values so the file
 * is not "compile-only, never actually run."
 *
 * The two doubles below are the smallest object literals that satisfy each
 * port, written inline in the `it` that needs them rather than pulled from a
 * shared module: the property being proved is that each interface is
 * implementable *on its own*, so neither implementation may share anything
 * with the other — a helper module naming both interfaces would weaken the
 * proof. (The provider-contract suite's own configurable doubles live in
 * `__tests__/quote-provider-fixture.ts` / `__tests__/fx-rate-provider-fixture.ts`
 * and are deliberately not reused here.)
 */
describe("QuoteProvider / FxRateProvider — independent interfaces (FR-63, NFR-9)", () => {
  it("an object implementing only QuoteProvider compiles and type-checks, with no FxRateProvider member required", async () => {
    // If QuoteProvider secretly required any FxRateProvider member (a shared
    // supertype), this literal would fail to satisfy `QuoteProvider` — it
    // implements *only* capabilities/resolve/fetchLatest/fetchDailyHistory
    // (fetchCorporateActions is optional on the port and omitted here; not
    // part of FxRateProvider either way).
    const quoteOnly: QuoteProvider = {
      capabilities: () => ({
        key: "type-conformance-double",
        assetKinds: ["SHARE"],
        supportsLatestQuote: true,
        supportsDailyHistory: true,
        supportsCorporateActions: false,
        maxHistoryYears: "unbounded",
        quoteQuality: "DELAYED",
        delayMinutes: 15,
        batchSize: 1,
      }),
      resolve: () => Promise.resolve([]),
      fetchLatest: () => Promise.resolve([]),
      fetchDailyHistory: () => Promise.resolve([]),
    };
    await expect(quoteOnly.fetchLatest([])).resolves.toEqual([]);

    // The converse of the proof: a QuoteProvider must NOT be assignable to
    // FxRateProvider (they are genuinely independent — the errors below are
    // load-bearing, kept as documentation of the asymmetry rather than a live
    // assertion, since `@ts-expect-error` already proves the compiler rejects
    // it).
    // @ts-expect-error — a QuoteProvider does not satisfy FxRateProvider: no shared supertype (FR-63, NFR-9).
    const _notAnFxProvider: FxRateProvider = quoteOnly;
    void _notAnFxProvider;
  });

  it("an object implementing only FxRateProvider compiles and type-checks, with no QuoteProvider member required", async () => {
    const fxOnly: FxRateProvider = {
      capabilities: () => ({
        key: "type-conformance-double",
        publishedPairs: [],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded",
      }),
      fetchDailyRates: () => Promise.resolve([]),
      fetchLatestRates: () => Promise.resolve([]),
    };
    await expect(fxOnly.fetchLatestRates([])).resolves.toEqual([]);

    // @ts-expect-error — an FxRateProvider does not satisfy QuoteProvider either, for the same reason.
    const _notAQuoteProvider: QuoteProvider = fxOnly;
    void _notAQuoteProvider;
  });
});

describe("observation DTOs — Decimal-only price/rate fields (NFR-12, feeds AC53)", () => {
  it("QuoteObservation.price accepts a Decimal", () => {
    const observation: QuoteObservation = {
      price: new Decimal("142.375"),
      currency: "EUR",
      asOf: "2024-01-05T16:00:00.000Z",
      quality: "DELAYED",
      sourceKey: "fake",
    };
    expect(observation.price).toBeInstanceOf(Decimal);
  });

  it("QuoteObservation.price rejects a number literal at compile time", () => {
    const observation: QuoteObservation = {
      // @ts-expect-error — price must be Decimal, never number (NFR-12).
      price: 142.375,
      currency: "EUR",
      asOf: "2024-01-05T16:00:00.000Z",
      quality: "DELAYED",
      sourceKey: "fake",
    };
    void observation;
  });

  it("PriceObservation.close rejects a number literal at compile time", () => {
    const observation: PriceObservation = {
      priceDate: "2024-01-05",
      // @ts-expect-error — close must be Decimal, never number.
      close: 142.375,
      currency: "EUR",
      quality: "EOD",
      sourceKey: "fake",
    };
    void observation;
  });

  it("FxObservation.rate rejects a number literal at compile time", () => {
    const observation: FxObservation = {
      base: "EUR",
      quote: "USD",
      // @ts-expect-error — rate must be Decimal, never number.
      rate: 1.085,
      rateDate: "2024-01-05",
      sourceKey: "fake",
    };
    void observation;
  });

  it("FxObservation.rate also rejects a string (Decimal only, not the wire-format string either)", () => {
    const observation: FxObservation = {
      base: "EUR",
      quote: "USD",
      // @ts-expect-error — rate must be Decimal, not a decimal string (that codec lives at the API boundary, not here).
      rate: "1.085",
      rateDate: "2024-01-05",
      sourceKey: "fake",
    };
    void observation;
  });
});
