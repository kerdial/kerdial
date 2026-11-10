import type {
  InstrumentKind,
  ProviderKey,
  ProviderSymbolMatch,
  QuoteProvider,
} from "@kerdial/market-ports";
import { buildDiscoveryRef } from "./discovery-ref.js";
import { providerKeyForDiscovery } from "./routing.js";

interface DiscoverySearchParams {
  readonly kind: InstrumentKind;
  readonly query: string;
}

/** The shape `MarketRuntime.discovery` exposes to `api`. */
export interface Discovery {
  search(params: DiscoverySearchParams): Promise<ProviderSymbolMatch[]>;
}

/**
 * Builds `MarketRuntime.discovery` from the discovery-lane provider
 * registry — routes `kind` (`routing.ts`), builds the discovery
 * `InstrumentRef` (`discovery-ref.ts`), and calls the routed provider's
 * `resolve()`. A `kind` with no route (`SCPI` — the API's discovery route
 * answers `400 DISCOVERY_NOT_AVAILABLE_FOR_KIND` for it before reaching here,
 * so this arm is defence; {@link providerKeyForDiscovery}) or a `providerKey`
 * absent from `discoveryProviders` resolves to an empty candidate list
 * rather than throwing — mirrors `resolve()`'s own port contract of
 * returning `[]` for "nothing found," here extended to "nothing routed."
 */
export function createDiscovery(
  discoveryProviders: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>,
): Discovery {
  return {
    async search({ kind, query }: DiscoverySearchParams): Promise<ProviderSymbolMatch[]> {
      const providerKey = providerKeyForDiscovery(kind);
      if (providerKey === undefined) return [];
      const provider = discoveryProviders[providerKey];
      if (provider === undefined) return [];

      const ref = buildDiscoveryRef(kind, query);
      return provider.resolve(ref);
    },
  };
}
