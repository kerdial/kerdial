import { z } from "zod";
import { INSTRUMENT_KIND_VALUES, type InstrumentKind } from "@kerdial/api-contracts";
import { findMicByCode, sectorCodeForProviderLabel } from "@kerdial/core-reference-data";
import type { ProviderSymbolMatch } from "@kerdial/market-ports";

/**
 * `GET /instruments/discovery` — DD6, DD9. Query schema, response DTO, and the
 * `ProviderSymbolMatch` -> DTO mapper (applies IC-4's curated MIC-hint
 * mapping) — mirrors `instruments.schema.ts`'s own "request schemas validate
 * `unknown` input, response shapes are built directly from domain records"
 * convention.
 */

/**
 * `kind` is **required** (routing depends on it); `query`
 * `.trim().min(3).max(64)` mirrors `listInstrumentsQuerySchema`'s abuse floor
 * (the `pg_trgm` reasoning behind that rule does not apply here — there is no
 * index to protect — but the anti-abuse reasoning does: a free discovery
 * search against a live external provider is more expensive per call than a
 * local indexed query).
 */
export const discoveryQuerySchema = z.object({
  kind: z.enum(INSTRUMENT_KIND_VALUES),
  query: z.string().trim().min(3).max(64),
});

/**
 * Response cap: "at most `YAHOO_MAX_RESOLVE_CANDIDATES` (5)
 * items; no pagination (a typeahead does not page)." Declared here **by
 * value**, not by importing `market/adapters`' own constant (`api` may never
 * import `market/adapters` — `api-no-market-adapters`), the same
 * "declared twice by value" convention `instruments.schema.ts`'s
 * `PRICE_HISTORY_MAX_SPAN_YEARS` already uses. Applied defensively here too:
 * the equity adapter already truncates to this same number before its own
 * per-candidate fan-out (IC-3), but the crypto adapter's candidate list is
 * not itself provider-capped, so this response-level slice is what actually
 * guarantees the cap for every kind, not just SHARE/ETF/FUND.
 */
export const DISCOVERY_RESPONSE_MAX_ITEMS = 5;

/**
 * `exchangeHint`: present only when the provider supplied a
 * code; `suggestedMic` is `null` when that code has no entry in IC-4's
 * curated table. Never a bare `exchangeMic` field anywhere in this DTO
 * (AC-4, FR-4) — `ProviderSymbolMatch.exchangeMic` (a distinct,
 * pre-existing port field neither adapter's `resolve()` ever populates) is
 * deliberately never read here at all.
 */
export interface DiscoveryExchangeHint {
  readonly code: string;
  readonly suggestedMic: string | null;
}

export interface DiscoveryCandidateResponse {
  readonly providerSymbol: string;
  /** DD9 — the coin's own ticker for a crypto candidate (`BTC` for Yahoo's `BTC-EUR` line), `null` when the provider set none (every equity candidate, whose provider symbol already is the ticker). */
  readonly tickerSymbol: string | null;
  readonly displayName: string;
  readonly listingCurrency: string;
  readonly exchangeHint: DiscoveryExchangeHint | null;
  readonly matchQuality: "EXACT" | "PROBABLE";
  /**
   * IR-10 —
   * the **mapped Kerdial code**, `null` for a provider string with no entry in
   * `PROVIDER_SECTOR_TO_CODE`. Never the raw provider string, never a fallback
   * code, never a guess: exactly the rule `instrument-create-ux` AC-4 already
   * binds `exchangeMic` to, now binding for sector too.
   *
   * Present **only** when the query's `kind` is `SHARE` (FR-7) — hence
   * optional rather than always-`null`: a CRYPTO/ETF candidate carries no
   * classification key at all, so nothing downstream can render "unclassified"
   * for a kind that has no classification this cycle.
   */
  readonly sectorCode?: string | null;
  /** The provider's opaque detail label (FR-6), or `null` when it supplied none. `SHARE` queries only, like {@link sectorCode}. */
  readonly industryLabel?: string | null;
}

/**
 * `ProviderSymbolMatch` -> {@link DiscoveryCandidateResponse}. The **one**
 * application point for `providerExchangeCode -> suggestedMic` and,
 * since IR-10, the second and last application site of
 * `PROVIDER_SECTOR_TO_CODE` (DD20 — the
 * other is `market/composition`'s write path). `web` never re-implements
 * either mapping.
 *
 * `kind` is the **query's** kind, not the candidate's: it is what decides
 * whether the classification fields are emitted at all (FR-7).
 */
export function toDiscoveryCandidateResponse(
  match: ProviderSymbolMatch,
  kind: InstrumentKind,
): DiscoveryCandidateResponse {
  return {
    providerSymbol: match.providerSymbol,
    tickerSymbol: match.tickerSymbol ?? null,
    displayName: match.displayName,
    listingCurrency: match.currency,
    exchangeHint:
      match.providerExchangeCode !== undefined
        ? {
            code: match.providerExchangeCode,
            suggestedMic: findMicByCode(match.providerExchangeCode) ?? null,
          }
        : null,
    matchQuality: match.matchQuality,
    ...(kind === "SHARE"
      ? {
          sectorCode:
            match.providerSectorLabel === undefined
              ? null
              : (sectorCodeForProviderLabel(match.providerSectorLabel) ?? null),
          industryLabel: match.providerIndustryLabel ?? null,
        }
      : {}),
  };
}
