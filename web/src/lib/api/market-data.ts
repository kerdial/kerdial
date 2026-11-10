import { apiFetch } from "./core.js";

/**
 * `/api/v1/market-data/quote-refresh` — the on-demand "refresh every held
 * instrument's quote" trigger (FR-52/FR-53, AC-42–AC-44).
 *
 * The wire type mirrors `api/src/market-data/market-data.schema.ts`'s
 * `quoteRefreshAcceptedResponseSchema` field-for-field, the same by-hand
 * mirroring convention every sibling module here uses (`fx.ts`,
 * `instruments.ts`).
 */
export interface QuoteRefreshAccepted {
  readonly requestId: string;
  /** The on-demand bucket this request enqueued under — distinct from the scheduled 08:00/20:00 buckets by construction (FR-53). */
  readonly bucket: string;
  /** Distinct instruments the calling tenant holds that have an automated quote source (an SCPI, priced by hand, is not counted). `0` is a legitimate `202`: "nothing to refresh" is a successful refresh request. */
  readonly heldInstruments: number;
  /** Jobs actually created — lower than `heldInstruments` only when an identical key was already queued or active. */
  readonly enqueued: number;
}

/**
 * `POST /market-data/quote-refresh` — `202`; one quote-refresh job per held
 * instrument is queued, and nothing is fetched by the time this resolves (the
 * worker writes quotes moments later). Rate-capped at 3 requests per tenant
 * per 30 minutes (SH-19, the tightest cap in the app — each admitted request
 * fans out one provider fetch per held instrument); `429` past that, `503
 * MARKET_DATA_NOT_CONFIGURED` when the deployment has no ingestion queue.
 */
export function requestQuoteRefresh(): Promise<QuoteRefreshAccepted> {
  return apiFetch<QuoteRefreshAccepted>("/market-data/quote-refresh", { method: "POST" });
}
