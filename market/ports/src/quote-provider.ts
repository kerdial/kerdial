import type {
  CorporateActionObservation,
  CurrencyCode,
  InstrumentRef,
  IsoDate,
  PriceObservation,
  ProviderCapabilities,
  ProviderSymbol,
  ProviderSymbolMatch,
  QuoteObservation,
} from "./types.js";

/**
 * The equity/ETF/index/crypto quote port. Deliberately
 * **not** a supertype or subtype of {@link
 * import("./fx-rate-provider.js").FxRateProvider}: FR-63/NFR-9 require the
 * equity/crypto source and the FX source to be independently swappable, and
 * that has to be true at the type level, not merely by registry convention —
 * see `fx-rate-provider.ts`'s doc comment and `type-conformance.test.ts` for
 * the compile-time proof. A provider that happens to serve both (e.g. a
 * combined equities+FX vendor) implements both interfaces separately and
 * registers in both registries; nothing
 * here requires that.
 *
 * `fetchCorporateActions` is optional (`?`) because `supportsCorporateActions`
 * in {@link ProviderCapabilities} is what the scheduler actually checks
 * ("capability declaration, not `try`/`catch` discovery") — an adapter that never supports corporate actions need not
 * implement the method at all.
 */
export interface QuoteProvider {
  capabilities(): ProviderCapabilities;

  /** Resolves what we know about an instrument to this provider's own symbol(s) — FR-5, AC3. */
  resolve(ref: InstrumentRef): Promise<ProviderSymbolMatch[]>;

  /**
   * Latest quote per requested symbol. The scheduler chunks the input by
   * `capabilities().batchSize`.
   *
   * `quoteCurrency` — the instrument's **declared listing currency**,
   * as a hint. An adapter whose upstream *chooses* the quote currency per
   * request would serve the quote in that currency — CoinGecko's `vs_currency`
   * did, until that adapter was retired; no current adapter does — so what lands in `instrument_quote_latest`/`instrument_price_daily`
   * matches what the instrument declares, instead of a provider-side constant
   * the declaration can never satisfy. An adapter whose listing itself
   * dictates the currency (`yahoo`) ignores it. Either way every observation
   * carries the currency **actually served** — a caller must read
   * `observation.currency`, never assume the hint was honoured. Omitted on
   * paths with no single declared instrument (contract fixtures,
   * `CryptoRateResolver`'s settlement-rate lookups).
   */
  fetchLatest(symbols: ProviderSymbol[], quoteCurrency?: CurrencyCode): Promise<QuoteObservation[]>;

  /** Daily close history for one symbol over `[from, to]`, inclusive, date-ascending. `quoteCurrency`: see {@link QuoteProvider.fetchLatest}. */
  fetchDailyHistory(
    symbol: ProviderSymbol,
    from: IsoDate,
    to: IsoDate,
    quoteCurrency?: CurrencyCode,
  ): Promise<PriceObservation[]>;

  /** Only present when `capabilities().supportsCorporateActions` is `true`. */
  fetchCorporateActions?(
    symbol: ProviderSymbol,
    from: IsoDate,
    to: IsoDate,
  ): Promise<CorporateActionObservation[]>;
}
