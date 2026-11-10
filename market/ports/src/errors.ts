/**
 * The closed provider error taxonomy — the "no provider DTO leaks" rule:
 * "Provider HTTP errors are mapped to a closed set of
 * domain errors." An adapter (T-15, T-31, T-32) must catch every raw
 * provider-shaped failure (an HTTP status, a malformed JSON body, a fetch
 * timeout, ...) at its own boundary and re-throw one of the five classes
 * below — never a raw `Error`, never a provider-specific exception type.
 *
 * This is what lets `market/ingestion`'s circuit breaker and retry logic
 * (T-33) — and any other caller — distinguish cases that need genuinely
 * different handling:
 *
 *   - {@link ProviderRateLimited} — back off (with the provider's own
 *     `retryAfterSeconds` if it gave one), do not open the circuit breaker.
 *   - {@link ProviderUnavailable} — a transient network/outage failure;
 *     counts toward the circuit breaker's consecutive-failure threshold.
 *   - {@link SymbolNotFound} — the instrument/pair is not resolvable by this
 *     provider at all; retrying is pointless, this is a mapping problem, not
 *     a transient one.
 *   - {@link DataGap} — the provider is reachable and the symbol/pair is
 *     known, but no data exists for (part of) the requested range; distinct
 *     from `SymbolNotFound` because the caller's remedy differs (accept the
 *     gap / try a narrower range vs. re-map the instrument entirely).
 *   - {@link ProviderMalformedResponse} — the provider responded but the
 *     response could not be parsed into this package's DTOs; a signal that
 *     the provider changed its response shape, not a rate limit or outage.
 *
 * The union {@link ProviderError} is **closed**: it lists exactly these five
 * classes, each individually exported (not a single open `ProviderError extends
 * Error` base meant for ad-hoc subclassing elsewhere). `errors.test.ts` proves
 * the union is exhaustively switchable without a `default` case — a
 * `default` would silently swallow a sixth error kind introduced later
 * without every call site being forced to handle it.
 */

/**
 * Local alias so this file does not need to import from `./types.js` merely
 * for a type annotation (avoids a circular-looking import for no benefit);
 * structurally identical to {@link import("./types.js").ProviderKey}.
 */
type ProviderKeyLike = string;

/** The provider signalled a rate limit (e.g. HTTP 429). `retryAfterSeconds` is the provider's own hint, when it gave one. */
export class ProviderRateLimited extends Error {
  readonly kind = "PROVIDER_RATE_LIMITED" as const;
  readonly providerKey: ProviderKeyLike;
  readonly retryAfterSeconds: number | undefined;

  constructor(providerKey: ProviderKeyLike, retryAfterSeconds?: number, message?: string) {
    super(
      message ??
        `${providerKey}: rate limited` +
          (retryAfterSeconds !== undefined ? `, retry after ${retryAfterSeconds}s` : ""),
    );
    this.name = "ProviderRateLimited";
    this.providerKey = providerKey;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A transient failure reaching the provider at all (network error, timeout, 5xx, ...). Counts toward the circuit breaker. */
export class ProviderUnavailable extends Error {
  readonly kind = "PROVIDER_UNAVAILABLE" as const;
  readonly providerKey: ProviderKeyLike;

  constructor(providerKey: ProviderKeyLike, message?: string) {
    super(message ?? `${providerKey}: provider unavailable`);
    this.name = "ProviderUnavailable";
    this.providerKey = providerKey;
  }
}

/**
 * The requested symbol/instrument/pair is not resolvable by this provider —
 * the provider contract's requirement: "an unknown symbol yields
 * `SymbolNotFound` rather than an empty array." `symbol` is a plain string so
 * this same class serves both an equity/crypto `ProviderSymbol` and a
 * stringified FX `CurrencyPair` (e.g. `"EUR/RUB"` for a suspended pair)
 * — the caller already knows which port it called.
 */
export class SymbolNotFound extends Error {
  readonly kind = "SYMBOL_NOT_FOUND" as const;
  readonly providerKey: ProviderKeyLike;
  readonly symbol: string;

  constructor(providerKey: ProviderKeyLike, symbol: string, message?: string) {
    super(message ?? `${providerKey}: symbol not found: ${symbol}`);
    this.name = "SymbolNotFound";
    this.providerKey = providerKey;
    this.symbol = symbol;
  }
}

/**
 * The provider is reachable and the symbol/pair is known, but it published
 * no data for (part of) `[from, to]` — e.g. a requested range predating the
 * provider's history, or a real reporting gap. Distinct from
 * {@link SymbolNotFound}: the remedy is "accept the gap" or "narrow the
 * range," not "re-map the instrument."
 */
export class DataGap extends Error {
  readonly kind = "DATA_GAP" as const;
  readonly providerKey: ProviderKeyLike;
  readonly from: string;
  readonly to: string;

  constructor(providerKey: ProviderKeyLike, from: string, to: string, message?: string) {
    super(message ?? `${providerKey}: no data published for ${from}..${to}`);
    this.name = "DataGap";
    this.providerKey = providerKey;
    this.from = from;
    this.to = to;
  }
}

/** The provider responded, but the response could not be parsed/mapped into this package's DTOs — a shape change upstream, not a rate limit or outage. */
export class ProviderMalformedResponse extends Error {
  readonly kind = "PROVIDER_MALFORMED_RESPONSE" as const;
  readonly providerKey: ProviderKeyLike;

  constructor(providerKey: ProviderKeyLike, message?: string) {
    super(message ?? `${providerKey}: malformed response`);
    this.name = "ProviderMalformedResponse";
    this.providerKey = providerKey;
  }
}

/**
 * The closed set. Every function in `QuoteProvider`/
 * `FxRateProvider` (`quote-provider.ts`, `fx-rate-provider.ts`) that can fail
 * is documented as rejecting with a member of this union — never a bare
 * `Error`. A `switch` over `.kind` that omits a member is caught by
 * TypeScript, not merely by convention (see `errors.test.ts`).
 */
export type ProviderError =
  ProviderRateLimited | ProviderUnavailable | SymbolNotFound | DataGap | ProviderMalformedResponse;
