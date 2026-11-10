import type { FigureProvenance, ProvenanceSummary, ValuedFigure } from "@kerdial/valuation";
import { serializeDecimal } from "./decimal.schema.js";

/**
 * `ValuedAmount`, T-39. The one
 * envelope every derived monetary figure `/portfolios/*` returns is wrapped
 * in: `{ amount, currency, provenance }`, never a bare decimal. Shared here
 * (not duplicated per response DTO) so `overview`/`holdings`/`performance`
 * and their combined tenant-wide counterparts all serialise the exact same
 * shape from the exact same `ValuedFigure` (`@kerdial/valuation`, T-39).
 */

export const PROVENANCE_PRICE_QUALITY_VALUES = ["REALTIME", "DELAYED", "MANUAL", "EOD"] as const;
export const PROVENANCE_FX_SOURCE_VALUES = [
  "USER_PINNED",
  "PROVIDER",
  "IMPLIED_BASE",
  "QUOTE_PROVIDER",
] as const;
export const PROVENANCE_DERIVED_FROM_VALUES = [
  "MANUAL_PRICE",
  "DELAYED_QUOTE",
  "PINNED_FX",
  "CARRIED_FX",
  "CRYPTO_QUOTE",
  "AUTOMATED",
] as const;

export interface ProvenanceSummaryResponse {
  readonly sources: readonly string[];
  readonly oldestObservationAt?: string;
  readonly newestObservationAt?: string;
  readonly staleInputCount: number;
  readonly manualInputCount: number;
  readonly pinnedFxPresent: boolean;
  readonly carriedFxPresent: boolean;
  readonly leafCount: number;
  readonly complete: boolean;
  readonly derivedFrom: readonly (typeof PROVENANCE_DERIVED_FROM_VALUES)[number][];
}

export interface ProvenanceResponse {
  readonly priceSource?: string;
  readonly priceQuality?: (typeof PROVENANCE_PRICE_QUALITY_VALUES)[number];
  readonly priceAsOf?: string;
  readonly priceIsStale?: boolean;
  readonly fxSource?: (typeof PROVENANCE_FX_SOURCE_VALUES)[number];
  readonly fxRateObservedOn?: string;
  readonly derivedFrom: readonly (typeof PROVENANCE_DERIVED_FROM_VALUES)[number][];
  readonly summary?: ProvenanceSummaryResponse;
}

export interface ValuedAmountResponse {
  readonly amount: string;
  readonly currency: string;
  readonly provenance: ProvenanceResponse;
}

/** `core/domain`'s summary is already JSON-safe (strings, numbers, booleans) — serialised field-for-field, exported for the performance/overview responses that carry a summary outside a `ValuedAmount` envelope (AR-24). */
export function toProvenanceSummaryResponse(summary: ProvenanceSummary): ProvenanceSummaryResponse {
  return {
    sources: summary.sources,
    ...(summary.oldestObservationAt !== undefined
      ? { oldestObservationAt: summary.oldestObservationAt }
      : {}),
    ...(summary.newestObservationAt !== undefined
      ? { newestObservationAt: summary.newestObservationAt }
      : {}),
    staleInputCount: summary.staleInputCount,
    manualInputCount: summary.manualInputCount,
    pinnedFxPresent: summary.pinnedFxPresent,
    carriedFxPresent: summary.carriedFxPresent,
    leafCount: summary.leafCount,
    complete: summary.complete,
    derivedFrom: summary.derivedFrom,
  };
}

function toProvenanceResponse(provenance: FigureProvenance): ProvenanceResponse {
  return {
    ...(provenance.priceSource !== undefined ? { priceSource: provenance.priceSource } : {}),
    ...(provenance.priceQuality !== undefined ? { priceQuality: provenance.priceQuality } : {}),
    ...(provenance.priceAsOf !== undefined ? { priceAsOf: provenance.priceAsOf } : {}),
    ...(provenance.priceIsStale !== undefined ? { priceIsStale: provenance.priceIsStale } : {}),
    ...(provenance.fxSource !== undefined ? { fxSource: provenance.fxSource } : {}),
    ...(provenance.fxRateObservedOn !== undefined
      ? { fxRateObservedOn: provenance.fxRateObservedOn }
      : {}),
    derivedFrom: provenance.derivedFrom,
    ...(provenance.summary !== undefined
      ? { summary: toProvenanceSummaryResponse(provenance.summary) }
      : {}),
  };
}

/** `ValuedFigure` (`@kerdial/valuation`'s `Decimal`-domain figure) -> the JSON-safe `ValuedAmount` wire shape. */
export function toValuedAmountResponse(figure: ValuedFigure): ValuedAmountResponse {
  return {
    amount: serializeDecimal(figure.amount),
    currency: figure.currency,
    provenance: toProvenanceResponse(figure.provenance),
  };
}
