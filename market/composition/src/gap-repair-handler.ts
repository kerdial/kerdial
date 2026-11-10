import type { Job } from "pg-boss";
import { getInstrumentById } from "@kerdial/ledger";
import {
  enqueueWeeklyGapRepair,
  runGapRepairJob,
  type Clock,
  type IngestionScheduler,
} from "@kerdial/market-ingestion";
import type { ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { resolveProviderSymbol } from "./provider-symbol.js";
import { providerKeyForBackfill } from "./routing.js";

/**
 * SH-12 — the `history-gap-repair` consumer. The queue and
 * its job body (`market/ingestion`'s `runGapRepairJob`, T-35) have existed
 * since T-35 and have **never been consumed**: nothing registered a handler,
 * and nothing ran the weekly fan-out. This is that handler.
 *
 * **One queue, two job shapes** (a single `history-gap-repair` queue whose
 * schedule *is* the weekly fan-out, with no second scan-only queue):
 *
 *  - **Fan-out job** — no `instrumentId`. Sent by the worker's weekly
 *    `boss.schedule()`. Scans for every `COMPLETE`-backfilled instrument and
 *    enqueues one per-instrument job each.
 *  - **Per-instrument job** — carries `instrumentId`. Runs the unmodified
 *    `runGapRepairJob` body. Enqueued by the fan-out above, or directly by
 *    anyone calling `scheduler.enqueueGapRepair` — which is why a
 *    directly-enqueued repair completes without waiting for a schedule.
 *
 * The queue's `exclusive` policy dedupes on `singletonKey`, and the two
 * shapes carry different keys (pg-boss's own schedule key vs.
 * `gapRepairSingletonKey(instrumentId)`), so a fan-out and the repairs it
 * produces never suppress one another.
 */

export interface GapRepairJobData {
  /** Absent on the scheduled fan-out job; present on every per-instrument job. */
  readonly instrumentId?: string;
}

export interface HandleGapRepairJobDeps {
  /** The `app_ingest`-scoped ingest pool. */
  readonly db: Db;
  readonly clock: Clock;
  /** Worker-lane (blocking, `provider_fetch_log`-writing) providers, keyed by `providerKey`. */
  readonly workerProviders: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>;
  /** Used only by the fan-out shape, to enqueue the per-instrument jobs. */
  readonly scheduler: IngestionScheduler;
}

/**
 * pg-boss hands `work()` an array even at `batchSize: 1` (Assumption A1) —
 * iterated defensively, exactly as `handleHistoryBackfillJob` does. A thrown
 * error is not swallowed: pg-boss's retry/dead-letter policy applies.
 */
export async function handleGapRepairJob(
  deps: HandleGapRepairJobDeps,
  jobs: readonly Job<GapRepairJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const instrumentId = job.data?.instrumentId;
    if (instrumentId === undefined || instrumentId === "") {
      await handleWeeklyGapRepairFanOut(deps);
      continue;
    }
    await handleOneGapRepair(deps, instrumentId);
  }
}

/**
 * The scheduled shape: scan, then enqueue one job per candidate instrument.
 * Deliberately does **no** repair work itself — a fan-out that also repaired
 * would hold the queue's one `exclusive` slot for its own key while doing
 * every instrument's provider I/O serially.
 */
async function handleWeeklyGapRepairFanOut(
  deps: HandleGapRepairJobDeps,
): Promise<readonly string[]> {
  const jobIds = await enqueueWeeklyGapRepair(deps.db, deps.scheduler);
  rootLogger().info("history-gap-repair: weekly fan-out enqueued its per-instrument jobs", {
    component: "market-composition",
    count: jobIds.length,
  });
  return jobIds;
}

/**
 * The per-instrument shape — exported directly so tests can drive it without
 * constructing a pg-boss `Job` wrapper, mirroring
 * `handleOneInstrumentBackfill`.
 *
 * Resolution failures are completions, not errors, for the same reasons the
 * backfill handler documents: a retry would only ever find the same absence.
 * `runGapRepairJob` itself is called **unchanged** (AC-16's "no job-body
 * change") — this handler only supplies the fresh provider and symbol.
 */
async function handleOneGapRepair(
  deps: HandleGapRepairJobDeps,
  instrumentId: string,
): Promise<void> {
  const instrumentRow = await getInstrumentById(deps.db, instrumentId);
  if (!instrumentRow) {
    rootLogger().warn("history-gap-repair: no instrument row — completing as a no-op", {
      component: "market-composition",
      instrument_id: instrumentId,
    });
    return;
  }

  const providerKey = providerKeyForBackfill(instrumentRow.kind);
  if (providerKey === undefined) {
    // No automated quote source, so no gaps to repair either: `SCPI` (`scpi`
    // cycle). It has no backfill state row, so the weekly fan-out never names
    // it; this is defence. (INDEX and FUND left this branch when they gained a
    // provider route.)
    return;
  }

  const provider = deps.workerProviders[providerKey];
  if (provider === undefined) {
    throw new Error(
      `market-composition: instrument ${instrumentId} routed to provider key ${providerKey}, but no worker provider is registered for it.`,
    );
  }

  const symbol = await resolveProviderSymbol(deps.db, provider, providerKey, {
    id: instrumentRow.id,
    kind: instrumentRow.kind,
    isin: instrumentRow.isin,
    symbol: instrumentRow.symbol,
    exchangeMic: instrumentRow.exchangeMic,
    listingCurrency: instrumentRow.listingCurrency,
  });

  if (symbol === null) {
    rootLogger().warn(
      "history-gap-repair: no provider symbol resolved — nothing to repair against",
      {
        component: "market-composition",
        instrument_id: instrumentId,
        provider: providerKey,
      },
    );
    return;
  }

  const result = await runGapRepairJob({
    db: deps.db,
    clock: deps.clock,
    provider,
    instrumentId,
    symbol,
    // Same declared-currency hint as the backfill handler.
    quoteCurrency: instrumentRow.listingCurrency,
  });

  // One line per instrument saying what was fetched and, above all,
  // what was *not* and why: the Sunday fan-out's cost is now legible from the
  // log rather than only from `provider_fetch_log`.
  rootLogger().info("history-gap-repair: instrument scanned", {
    component: "market-composition",
    instrument_id: instrumentId,
    provider: providerKey,
    scanned_from: result.scannedFrom,
    scanned_to: result.scannedTo,
    missing: result.missingBeforeRepair.length,
    filled: result.filledDates.length,
    skipped_closed: result.skippedClosedDates.length,
    skipped_known_empty: result.skippedKnownEmptyDates.length,
    recorded_empty: result.recordedEmptyDates.length,
  });
}
