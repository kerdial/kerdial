import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import { BACKFILLABLE_KINDS } from "@kerdial/market-ingestion";
import type { InstrumentKind, ProviderKey } from "@kerdial/market-ports";

/**
 * `market/composition`'s kind→provider routing table (E3). This is the
 * **registry configuration**, one of the exactly-three places provider
 * identity may live, so referencing `YAHOO_PROVIDER_KEY` here (imported
 * from `market/adapters`, the only
 * other place allowed to) is not a boundary violation — it is this file's
 * entire purpose.
 *
 * One table serves both discovery search and backfill/quote routing,
 * because every kind that has *any* automated route maps to the same
 * provider for both purposes — today that is yahoo for every kind
 * (`CRYPTO` was coingecko until its 365-day history cap retired it). The two
 * consumption sites differ only in which kinds they
 * accept:
 *
 *   - {@link providerKeyForDiscovery} answers for every kind with an entry
 *     below — every kind except `SCPI`.
 *   - {@link providerKeyForBackfill} answers only for
 *     `BACKFILLABLE_KINDS` (`market/ingestion`) — since ADR-0018 that is
 *     every routed kind too.
 *
 * **`SCPI` has no entry, by design** (`scpi` cycle, SC-L10): it is priced by
 * hand only, so both helpers return `undefined` for it, the quote-refresh
 * fan-out leaves it out ({@link quoteRoutedKinds}), and the discovery route
 * answers `400 DISCOVERY_NOT_AVAILABLE_FOR_KIND` before reaching a provider.
 * **`INDEX` and `FUND` used to resolve to `undefined` for backfill**: the
 * benchmark line made INDEX backfillable through
 *     this table's own long-standing Yahoo entry, and ADR-0018 did the same for
 *     FUND once Yahoo's Morningstar-sourced NAV lines were found — the earlier
 *     "search only" deviation for FUND (and AC-14's "no provider call
 *     attempted") is retired. See
 *     `BACKFILLABLE_KINDS`' doc comment for both moves.
 */
export const PROVIDER_ROUTING: Readonly<Partial<Record<InstrumentKind, ProviderKey>>> = {
  SHARE: YAHOO_PROVIDER_KEY,
  ETF: YAHOO_PROVIDER_KEY,
  // This entry is now read by `providerKeyForBackfill` too, not only by
  // discovery — an INDEX's price history comes down the same Yahoo path.
  INDEX: YAHOO_PROVIDER_KEY,
  // Search-only until ADR-0018: Yahoo's Morningstar `0P…` lines carry
  // a daily NAV, so FUND now backfills and refreshes through this same entry.
  FUND: YAHOO_PROVIDER_KEY,
  // The `<SYMBOL>-<CCY>` pairs (`BTC-EUR`), full daily history.
  CRYPTO: YAHOO_PROVIDER_KEY,
  // No `SCPI` entry — deliberately (SC-L10): see this table's doc comment.
};

/** The provider key discovery search routes `kind` to, or `undefined` if no provider ever serves this kind — `SCPI`, by design (SC-L10); the API answers `400 DISCOVERY_NOT_AVAILABLE_FOR_KIND` for it and filters it out of the on-demand quote refresh. */
export function providerKeyForDiscovery(kind: InstrumentKind): ProviderKey | undefined {
  return PROVIDER_ROUTING[kind];
}

/**
 * The kinds with a quote route: the keys of
 * {@link PROVIDER_ROUTING}. The scheduled quote refresh narrows its
 * population to these (`quote-refresh-handler.ts`), so an unrouted kind
 * (`SCPI`) is never even enqueued — SC-L10's "absent from the fan-out", not
 * merely a no-op job. Package-internal.
 */
export function quoteRoutedKinds(): readonly InstrumentKind[] {
  return Object.keys(PROVIDER_ROUTING) as InstrumentKind[];
}

/**
 * The provider key the in-process worker routes `kind` to for backfill, or
 * `undefined` when `kind` is not in {@link BACKFILLABLE_KINDS} — the
 * worker handler body (`history-backfill-handler.ts`) treats an `undefined`
 * result as "complete this job as a no-op, no provider call attempted".
 * `SCPI` lands there (`scpi` cycle): never enqueued in the first place —
 * every caller pre-checks this helper — so the branch is defence.
 */
export function providerKeyForBackfill(kind: InstrumentKind): ProviderKey | undefined {
  if (!BACKFILLABLE_KINDS.includes(kind)) return undefined;
  return PROVIDER_ROUTING[kind];
}

/**
 * Every provider key some kind routes to: the keys a stored
 * `instrument_provider_map` row can still be *used* under. A row under any
 * other key (`coingecko`, since retired) is read by nothing; the catalogue
 * export leaves it out and the catalogue import does not recreate it.
 */
export function routedProviderKeys(): readonly ProviderKey[] {
  return [...new Set(Object.values(PROVIDER_ROUTING))];
}
