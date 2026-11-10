import type { CurrencyPair, FxObservation, FxProviderCapabilities, IsoDate } from "./types.js";

/**
 * The FX rate port — **independent** of {@link
 * import("./quote-provider.js").QuoteProvider} by design (FR-63, NFR-9):
 * "`QuoteProvider` and `FxRateProvider` are separate interfaces with separate
 * registries," so the FX source can be swapped (the phase-1 FX source carries
 * a redistribution-terms risk) without touching the
 * equity/crypto source or any code that depends only on `QuoteProvider`.
 * There is no shared supertype requiring both to be implemented together —
 * a provider that only ever serves FX implements only this interface;
 * `type-conformance.test.ts` compiles a fixture that does exactly that as
 * the proof.
 */
export interface FxRateProvider {
  capabilities(): FxProviderCapabilities;

  /** Daily rates for each requested pair over `[from, to]`, inclusive, date-ascending, no duplicate dates per pair. */
  fetchDailyRates(pairs: CurrencyPair[], from: IsoDate, to: IsoDate): Promise<FxObservation[]>;

  /** The latest published rate for each requested pair. */
  fetchLatestRates(pairs: CurrencyPair[]): Promise<FxObservation[]>;
}
