import { findMicByCode } from "@kerdial/core-reference-data";
import type { DiscoveryLookup, DiscoveryMatch, ImportDiscoveryPort } from "@kerdial/importer";
import type { MarketRuntime } from "@kerdial/market-composition";

/**
 * `ImportDiscoveryPort` bound to the real `MarketRuntime.discovery` — the one
 * place a provider call is allowed to enter the import pipeline
 * (ID1; CI-16).
 *
 * `importer` may not import any `market/*` package —
 * `.dependency-cruiser.cjs`'s `importer-no-market` rule is an `error`, not a
 * convention — so the pipeline declares the narrow port it needs
 * (`importer/src/pipeline/ports.ts`) and `api`, which is already the
 * composition root holding a `MarketRuntime`, is what implements it. That is
 * what makes the boundary structural: there is no second place a lookup could
 * be issued from, because there is no second place that can see both types.
 *
 * ## The one translation this adapter performs, and why it is not optional
 *
 * `ProviderSymbolMatch.providerExchangeCode` is the **provider's own** exchange
 * taxonomy (e.g. `"NMS"`), not an ISO 10383 MIC, and `market/ports`' own rule
 * is that it "must never be written to `instrument.exchangeMic` directly — it
 * is only ever a hint, mapped through a curated, hand-maintained table". That
 * table is `core/reference-data`'s `findMicByCode`, applied here, on the
 * neutral side of the boundary, exactly as `discovery.schema.ts` applies it for
 * the interactive route. An unmapped code becomes `null`, never a guess and
 * never the raw provider string — a `null` here makes the row report
 * `EXCHANGE_MIC_NOT_RESOLVED`, which is an honest answer, where a passed-through
 * `"NMS"` would be a plausible-looking wrong one.
 *
 * `ProviderSymbolMatch.exchangeMic` — a distinct, pre-existing port field
 * neither adapter's `resolve()` ever populates — is deliberately not read, the
 * same decision `discovery.schema.ts` records for the same field.
 *
 * ## What this adapter does *not* do
 *
 * It adds no retry, no budget, no deadline and no error translation. Those all
 * live in `importer`'s own `DiscoveryBudget`, which classifies a failure
 * structurally by `error.name` rather than by `instanceof` — so whatever the
 * provider stack throws is re-thrown here unchanged, and this adapter stays the
 * few lines the port was shaped to make it.
 */
export function createImportDiscoveryPort(runtime: MarketRuntime): ImportDiscoveryPort {
  return {
    async search(lookup: DiscoveryLookup): Promise<readonly DiscoveryMatch[]> {
      const matches = await runtime.discovery.search({
        kind: lookup.kind,
        query: lookup.query,
      });
      return matches.map((match) => ({
        displayName: match.displayName,
        currency: match.currency,
        exchangeMic:
          match.providerExchangeCode === undefined
            ? null
            : (findMicByCode(match.providerExchangeCode) ?? null),
        matchQuality: match.matchQuality,
      }));
    },
  };
}

/**
 * `null` in, `null` out: with no `INGESTION_DATABASE_URL` there is no
 * `MarketRuntime`, and that is deliberately a per-row
 * `EXCHANGE_MIC_LOOKUP_UNAVAILABLE` rather than a failed request — the import
 * still completes, and re-running it once a runtime is configured resolves
 * exactly the rows that reported.
 */
export function importDiscoveryPortFor(runtime: MarketRuntime | null): ImportDiscoveryPort | null {
  return runtime === null ? null : createImportDiscoveryPort(runtime);
}
