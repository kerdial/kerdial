import type { CurrencyCode } from "../types.js";

/**
 * The importer's one provider-facing dependency, and the reason ID1's
 * `importer-no-market` dependency-cruiser rule can be an `error` rather than a
 * convention.
 *
 * `api` implements {@link ImportDiscoveryPort} over `MarketRuntime.discovery`
 * (CI-16); this package never sees a `market/*` type, a provider key, a token
 * bucket or a circuit breaker. Everything below is either a local shape or a
 * structural read of an error's own `name`.
 */

/**
 * The instrument kinds discovery can be asked to route (mirrors `ledger`'s
 * `InstrumentKind`; see {@link ImportDiscoveryPort} on why it is not imported)
 * — **deliberately without `SCPI`** (SCD-14, FR-622): no
 * provider serves an SCPI and this importer never proposes one, so a search
 * or a kind proposal naming it is a compile error here, not a runtime case.
 * Exported so `instrument-resolution.ts` types its proposals and searches by it.
 */
export type DiscoveryKind = "SHARE" | "ETF" | "FUND" | "CRYPTO" | "INDEX";

/** One candidate the implementation hands back — the subset of `ProviderSymbolMatch` this pipeline reads, and nothing else. */
export interface DiscoveryMatch {
  readonly displayName: string;
  readonly currency: CurrencyCode;
  /**
   * A real ISO 10383 MIC the *implementation* has already mapped through
   * `core/reference-data`'s curated table — never a provider's own exchange
   * code. `null` when the implementation could not map one.
   *
   * Even so, nothing here is written to an instrument without the user's
   * confirm: `market/ports`' own rule is that a provider-derived MIC "is only
   * ever offered to the user as a pre-selection they must confirm, never
   * silently persisted", and the proposals/echo-back mechanism is that
   * confirmation. This value reaches the database only after a round trip
   * through the user.
   */
  readonly exchangeMic: string | null;
  readonly matchQuality: "EXACT" | "PROBABLE";
}

export interface DiscoveryLookup {
  readonly kind: DiscoveryKind;
  readonly query: string;
}

/**
 * **Not** `Discovery` from `market/composition`, though it is the same idea
 * with a narrower surface: importing that type would be a `market/*` edge and
 * `importer-no-market` would refuse it. The two are structurally compatible on
 * purpose, so CI-16's binding is an adapter of a few lines and not a
 * translation layer.
 *
 * Rejects with whatever the underlying provider stack throws;
 * {@link classifyDiscoveryError} is how this package decides what to do about
 * it without naming a `market/*` class.
 */
export interface ImportDiscoveryPort {
  search(lookup: DiscoveryLookup): Promise<readonly DiscoveryMatch[]>;
}

/** Injected so nothing in `pipeline/` reads a global clock or a global timer — both are inputs, and both are varied by the tests that prove the deadline binds. */
export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

/** The real one. Every test passes its own. */
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

/** What {@link classifyDiscoveryError} decided about one failed lookup. */
export interface DiscoveryErrorClass {
  /** `true` only for a rate limit: it clears on its own, so retrying inside the deadline can work. */
  readonly retryable: boolean;
  /** The provider's own hint, when it gave one. `null` otherwise. */
  readonly retryAfterSeconds: number | null;
}

/**
 * The retry rule, made structural: `ProviderRateLimited` is
 * retried honouring its own `retryAfterSeconds` until the deadline;
 * `ProviderCircuitOpenError` and `ProviderUnavailable` are **not** retried at
 * all. An open circuit lasts 60 s, which cannot clear inside a 10 s deadline,
 * and an unavailable provider counts *toward* opening it — retrying either one
 * spends budget to make the outcome worse.
 *
 * **Matched on `error.name`, not `instanceof`**, for two independent reasons.
 * The binding one: `instanceof ProviderRateLimited` needs the class, which is a
 * `market/*` import this package may not make. The second, which would apply
 * anyway: `api` and `importer` resolve `@kerdial/market-ports` through their
 * own `node_modules` links, so an `instanceof` across that boundary is a
 * duplicate-class hazard even where the import is legal. `market/ports`'
 * `errors.ts` sets `this.name` on every member of its closed taxonomy
 * explicitly, and `market/ingestion`'s `ProviderCircuitOpenError` does the
 * same, so the name is a contract those files keep rather than a coincidence
 * of class naming.
 *
 * Anything unrecognised — including a plain `Error` — is terminal. Retrying an
 * error whose meaning is unknown is exactly how a bounded budget becomes an
 * unbounded one.
 */
export function classifyDiscoveryError(error: unknown): DiscoveryErrorClass {
  if (typeof error !== "object" || error === null)
    return { retryable: false, retryAfterSeconds: null };
  const named = error as { name?: unknown; retryAfterSeconds?: unknown };
  if (named.name !== "ProviderRateLimited") return { retryable: false, retryAfterSeconds: null };
  const hint = named.retryAfterSeconds;
  return {
    retryable: true,
    retryAfterSeconds: typeof hint === "number" && Number.isFinite(hint) && hint >= 0 ? hint : null,
  };
}
