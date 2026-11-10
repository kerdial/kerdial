import { eq } from "drizzle-orm";
import { instrumentBackfillState, type Db } from "@kerdial/platform-db";

/**
 * `GET /instruments/:id/history-status` (DD15, IC-12). A single indexed primary-key lookup over
 * `instrument_backfill_state` — deliberately **not** `market/ingestion`'s
 * `getInstrumentCoverage`, which additionally computes `missingBusinessDays`
 * by listing every price date in range (far too heavy for a 3-second poll).
 */

/**
 * `"NONE"` is not a real `backfill_status` enum value (`platform/db/src/
 * schema/instrument-backfill-state.ts`'s `backfillStatusEnum` only has
 * `PENDING`/`IN_PROGRESS`/`COMPLETE`/`FAILED`) — it is this read's own
 * "no row exists yet" case: a FUND/INDEX instrument (never backfilled at
 * all), or a SHARE/ETF/CRYPTO instrument created while `MARKET_RUNTIME` was
 * `null`.
 */
/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export type InstrumentBackfillStatus = "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";

export interface InstrumentBackfillStatusRecord {
  readonly status: InstrumentBackfillStatus;
  readonly requestedFrom: string | null;
  readonly earliestBackfilledDate: string | null;
  readonly latestBackfilledDate: string | null;
}

const NO_ROW: InstrumentBackfillStatusRecord = {
  status: "NONE",
  requestedFrom: null,
  earliestBackfilledDate: null,
  latestBackfilledDate: null,
};

/**
 * Reads `instrument_backfill_state` fresh on every call — no caching, this is
 * meant to back a poll. Returns the `"NONE"` shape (never `undefined`, never
 * throws) when no row exists for `instrumentId` yet — a total function over
 * every instrument id, existent or not (the controller's own `getInstrumentById`
 * pre-check is what turns a genuinely nonexistent instrument into a 404;
 * this function only ever answers "what does the backfill-state row say").
 */
export async function getInstrumentBackfillStatus(
  db: Db,
  instrumentId: string,
): Promise<InstrumentBackfillStatusRecord> {
  const [row] = await db
    .select({
      status: instrumentBackfillState.status,
      requestedFrom: instrumentBackfillState.requestedFrom,
      earliestBackfilledDate: instrumentBackfillState.earliestBackfilledDate,
      latestBackfilledDate: instrumentBackfillState.latestBackfilledDate,
    })
    .from(instrumentBackfillState)
    .where(eq(instrumentBackfillState.instrumentId, instrumentId));

  if (!row) return NO_ROW;

  return {
    status: row.status,
    requestedFrom: row.requestedFrom,
    earliestBackfilledDate: row.earliestBackfilledDate,
    latestBackfilledDate: row.latestBackfilledDate,
  };
}
