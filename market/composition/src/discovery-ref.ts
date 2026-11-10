import type {
  CurrencyCode,
  InstrumentId,
  InstrumentKind,
  InstrumentRef,
} from "@kerdial/market-ports";

/**
 * The discovery-search `InstrumentRef` builder. `InstrumentRef` mandates
 * `instrumentId` and `listingCurrency`, neither of which exists before an
 * instrument is created. `market/adapters/src/yahoo/provider.ts`'s `resolve()`
 * never reads `instrumentId`, and reads `listingCurrency` only to name a
 * crypto's `<SYMBOL>-<CCY>` line, where it treats this placeholder
 * `XXX` as "no currency" and searches the bare symbol instead. This function confines that placeholder
 * construction to one named place so it never has to be reinvented, or
 * duplicated, at a call site.
 */

/** RFC 9562 §5.9's nil UUID — used as the placeholder `instrumentId` no discovery search has yet. */
const DISCOVERY_REF_NIL_INSTRUMENT_ID: InstrumentId = "00000000-0000-0000-0000-000000000000";

/** ISO 4217's own reserved "no currency" code — used as the placeholder `listingCurrency` a not-yet-created instrument has none of. Never written to any real row; the adapter treats it as "no currency". */
const DISCOVERY_REF_PLACEHOLDER_CURRENCY: CurrencyCode = "XXX";

/**
 * Mirrors `core/api-contracts/src/instrument-create.schema.ts`'s own
 * `ISIN_SHAPE` (2 uppercase letters, 9 alphanumerics, 1 digit) — a shape
 * check only, no checksum validation (this only decides which
 * `InstrumentRef` field to populate for routing purposes, not whether the
 * query is a *valid* ISIN). Declared twice by value rather than importing
 * `core/api-contracts` into this package for one regex — the same pattern
 * `historyDepthLimitYears`'s declared-twice constant follows.
 */
const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/**
 * Builds the discovery `InstrumentRef` for a free-text `query` against
 * `kind`: `isin` when `query` is ISIN-shaped, `symbol` otherwise. Never sets
 * both.
 */
export function buildDiscoveryRef(kind: InstrumentKind, query: string): InstrumentRef {
  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();

  return {
    instrumentId: DISCOVERY_REF_NIL_INSTRUMENT_ID,
    kind,
    listingCurrency: DISCOVERY_REF_PLACEHOLDER_CURRENCY,
    ...(ISIN_SHAPE.test(upper) ? { isin: upper } : { symbol: trimmed }),
  };
}
