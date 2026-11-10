import { z } from "zod";

/**
 * SH-18 — the `202 Accepted` body of `POST /api/v1/market-data/quote-refresh`.
 *
 * Three numbers and two ids, chosen so a caller (and AC-42) can tell the three
 * outcomes apart without reading the queue:
 *
 *  - `heldInstruments` — what the tenant-scoped enumeration found, counting
 *    only held instruments that have an automated quote source (an `SCPI`,
 *    priced by hand, is left out). `0` is a legitimate
 *    `202`: "nothing to refresh" is a successful refresh request.
 *  - `enqueued` — jobs actually created. Equal to `heldInstruments` in the
 *    ordinary case; lower only if an identical key was already queued or
 *    active, which for a per-request bucket means a repeated `requestId`.
 *  - `bucket`/`requestId` — the on-demand bucket this request enqueued under,
 *    returned rather than hidden because it is what makes FR-53's "distinct
 *    from the scheduled bucket" property observable from outside (AC-44 asserts
 *    on it). It names nothing tenant-private: a UUID this request just minted.
 *
 * Consumed through {@link QuoteRefreshAcceptedResponse}, the quote-refresh
 * handler's return type in `market-data.controller.ts`.
 */
export const quoteRefreshAcceptedResponseSchema = z.object({
  requestId: z.string().uuid(),
  bucket: z.string(),
  heldInstruments: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
});

export type QuoteRefreshAcceptedResponse = z.infer<typeof quoteRefreshAcceptedResponseSchema>;
