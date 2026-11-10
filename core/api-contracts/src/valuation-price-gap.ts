import { z } from "zod";
import { decimalStringSchema } from "./decimal-codec.js";

/**
 * The `VALUATION_PRICE_UNAVAILABLE` problem a **portfolio-level** read answers
 * with — `GET /portfolios/overview`, `/portfolios/:id/overview`,
 * the performance and value-series reads, and every other route
 * `PortfoliosController#mapValuationError` guards.
 *
 * Those reads value *every* holding, so a 422 carrying only a date left the
 * reader to guess which one of twenty positions had no price. The payload now
 * names it, states the unpriceable range, and — when the ledger already holds
 * the number that would close the gap — offers it.
 *
 * Owner decisions of 2026-09-28: the read still **fails whole** (D1 —
 * no per-holding degradation, `resolvePrice` still never looks ahead), and the
 * suggestion is only ever written by an explicit user confirmation through the
 * ordinary `POST /instruments/:id/prices` route (D2 — never automatically,
 * never on BUY).
 */

/**
 * `params` members of the problem, all scalars (`ProblemDetails.params`'s own
 * rule). `instrumentId` is here because the client needs it to link the fiche
 * and to POST the price; the human-readable `detail` names the symbol and
 * carries no UUID.
 */
export interface ValuationPriceGapParams {
  /** The first date the read could not value, `YYYY-MM-DD`. The same member the error has always carried. */
  readonly valuationDate: string;
  readonly instrumentId: string;
  /** Absent when the instrument has no symbol (an ISIN-only listing). */
  readonly symbol?: string;
  readonly instrumentName: string;
  /** The instrument's earliest price point (automated, or this tenant's manual), `YYYY-MM-DD` — absent when it has none at all. Always after `valuationDate`: nothing at or before it exists, which is the failure. */
  readonly firstPriceDate?: string;
}

/**
 * A manual price point the client may offer to write: the unit price of this
 * tenant's earliest acquisition (BUY/DRIP) of the instrument dated on or
 * before `valuationDate`, at that acquisition's trade date.
 *
 * Only sent when it is valid input for `POST /instruments/:id/prices` **and**
 * denominated in the instrument's listing currency — a trade settled in
 * another currency is omitted rather than converted, so a suggestion never
 * writes a mixed-currency point into the instrument's price series. The client
 * posts `{ priceDate: date, close, currency }`.
 */
export const suggestedManualPriceSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close: decimalStringSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type SuggestedManualPrice = z.infer<typeof suggestedManualPriceSchema>;
