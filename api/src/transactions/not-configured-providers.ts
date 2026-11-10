import { SymbolNotFound } from "@kerdial/market-ports";
import type {
  CorporateActionObservation,
  CurrencyPair,
  FxObservation,
  FxProviderCapabilities,
  FxRateProvider,
  InstrumentRef,
  IsoDate,
  PriceObservation,
  ProviderCapabilities,
  ProviderSymbol,
  ProviderSymbolMatch,
  QuoteObservation,
  QuoteProvider,
} from "@kerdial/market-ports";

/**
 * **Known phase-1 gap (T-38), stated here rather than silently
 * reconciled.**
 *
 * The ledger has `FxRateResolver`/`CryptoRateResolver`
 * call their injected `FxRateProvider`/`QuoteProvider` **port** live, at
 * write time, whenever a transaction's currency needs converting and the
 * caller supplied no pinned rate (FR-56). Composing a *real* adapter
 * (`market/adapters/ecb`, or a real `QuoteProvider`) into that call would
 * require `api` to depend on `market/adapters` — forbidden outright by
 * `.dependency-cruiser.cjs`'s `api-no-market-adapters` rule ("the API
 * surface sees only market/ports-shaped data via ledger/valuation"), and
 * `ledger` itself may not depend on `market/adapters` either
 * (`ledger-no-market-adapters`). No package in this workspace is yet the
 * composition root that wires a concrete adapter into a live, per-request
 * `TransactionWriteService` the way `market/ingestion`'s own jobs are wired
 * by their own (test-only, so far) callers — that composition root does not
 * exist yet for the write path, only for the read/ingestion path.
 *
 * This is the same category of gap the T-37/T-38 brief already accepts for
 * `TransactionWriteServiceDeps.instrumentBackfillScheduler` ("constructing it
 * WITHOUT the scheduler in the API is the accepted phase-1 state ... the
 * trigger is latent by design"), just on the FX/quote side instead. Rather
 * than reach past the module boundary (which `depcruise` would catch anyway)
 * or invent a new composition-root package as unplanned scope, `POST
 * /transactions` is composed with these two providers: both implement their
 * port fully and correctly, but report **no coverage for any pair/symbol**
 * (`SymbolNotFound`) — the same "this provider does not cover it" outcome
 * `FxRateResolver`/`CryptoRateResolver` already treat as a first-class case
 * (falling through to this tenant's own `fx_rate_user` rows, then to a
 * fail-closed `FxRateUnavailableError`/`CryptoRateUnavailableError`, mapped
 * to a 422 `problem+json` by `transactions.controller.ts`).
 *
 * **What this means for a caller of this API.** A user-pinned rate
 * (`fxRateUserInput`, FR-56) or a trade in the tenant's base currency
 * (`IMPLIED_BASE`) always works — neither ever reaches these stubs (both are
 * early returns in `FxRateResolver.resolve`/`CryptoRateResolver.resolve`,
 * before the port is ever called). A trade that needs an *automatically
 * looked-up* rate (no pin, non-base currency, and no matching
 * `fx_rate_user` row) is rejected with a 422 until a real composition root
 * wires a live provider in — a real limitation, not a bug, and one this
 * task's report calls out explicitly for whoever builds that composition
 * root (T-3's worker/producer wiring is the most likely home for it, per the
 * brief's own note on the backfill scheduler).
 */
const NOT_CONFIGURED_KEY = "not-configured";

export class NotConfiguredFxRateProvider implements FxRateProvider {
  capabilities(): FxProviderCapabilities {
    return {
      key: NOT_CONFIGURED_KEY,
      publishedPairs: [],
      baseCurrency: "EUR",
      publicationTimeUtc: "00:00",
      maxHistoryYears: "unbounded",
    };
  }

  async fetchDailyRates(
    pairs: CurrencyPair[],
    _from: IsoDate,
    _to: IsoDate,
  ): Promise<FxObservation[]> {
    const [pair] = pairs;
    throw new SymbolNotFound(NOT_CONFIGURED_KEY, pair ? `${pair.base}/${pair.quote}` : "(no pair)");
  }

  async fetchLatestRates(pairs: CurrencyPair[]): Promise<FxObservation[]> {
    const [pair] = pairs;
    throw new SymbolNotFound(NOT_CONFIGURED_KEY, pair ? `${pair.base}/${pair.quote}` : "(no pair)");
  }
}

export class NotConfiguredQuoteProvider implements QuoteProvider {
  capabilities(): ProviderCapabilities {
    return {
      key: NOT_CONFIGURED_KEY,
      assetKinds: ["SHARE", "ETF", "FUND", "CRYPTO", "INDEX"],
      supportsLatestQuote: false,
      supportsDailyHistory: false,
      supportsCorporateActions: false,
      maxHistoryYears: 0,
      quoteQuality: "DELAYED",
      delayMinutes: 0,
      batchSize: 1,
    };
  }

  async resolve(_ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
    return [];
  }

  async fetchLatest(symbols: ProviderSymbol[]): Promise<QuoteObservation[]> {
    throw new SymbolNotFound(NOT_CONFIGURED_KEY, symbols[0] ?? "(no symbol)");
  }

  async fetchDailyHistory(
    symbol: ProviderSymbol,
    _from: IsoDate,
    _to: IsoDate,
  ): Promise<PriceObservation[]> {
    throw new SymbolNotFound(NOT_CONFIGURED_KEY, symbol);
  }

  async fetchCorporateActions(
    symbol: ProviderSymbol,
    _from: IsoDate,
    _to: IsoDate,
  ): Promise<CorporateActionObservation[]> {
    throw new SymbolNotFound(NOT_CONFIGURED_KEY, symbol);
  }
}
