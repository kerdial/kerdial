import type { Job } from "pg-boss";
import {
  EOD_CLOSE_RESIDUAL_TIME_ZONE,
  EXCHANGE_SESSIONS,
  fetchRefreshPopulation,
  localDateTimeParts,
  runEodCloseJob,
  type Clock,
  type IngestionScheduler,
} from "@kerdial/market-ingestion";
import type { ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { providerKeyForBackfill } from "./routing.js";

/**
 * SH-13 — the `eod-close` consumer and its
 * per-exchange fan-out.
 *
 * **Three job shapes on one queue**, the same "trigger, then keyed work"
 * shape `gap-repair-handler.ts` established, and for a specific reason here:
 * the work key is `eod:{MIC}:{date}`, and a pg-boss schedule's options are
 * static, so no cron can express a per-day key. The trigger hop is what lets
 * the *work* job carry it — which is what makes a catch-up run (SH-17) and
 * the day's scheduled run collapse to one execution instead of both fetching.
 *
 *  - **`{ exchangeMic }`** — a scheduled trigger for one known exchange. Reads
 *    the date in *that exchange's* zone and enqueues the work job.
 *  - **`{ residual: true }`** — the 22:00 UTC residual lane. Finds every MIC
 *    held by someone that has no `EXCHANGE_SESSIONS` entry and enqueues one
 *    work job each, dated in UTC.
 *  - **`{ exchangeMic, isoDate }`** — the work itself: `runEodCloseJob`,
 *    unmodified.
 *
 * The residual lane is best-effort by construction: there is no close
 * time to schedule against for an exchange this project knows nothing about,
 * so 22:00 UTC is a guess that the staleness indicator is expected to
 * surface the consequences of. Dropping those instruments silently was the
 * alternative, and is worse.
 */

export interface EodCloseJobData {
  /** Present on a scheduled trigger and on the work job; absent on the residual trigger. */
  readonly exchangeMic?: string;
  /** Present only on the work job — the trading date being filled. */
  readonly isoDate?: string;
  /** `true` on the residual-lane trigger only. */
  readonly residual?: boolean;
}

export interface HandleEodCloseJobDeps {
  /** The `app_ingest`-scoped ingest pool. */
  readonly db: Db;
  readonly clock: Clock;
  /** Worker-lane providers, keyed by `providerKey`. */
  readonly workerProviders: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>;
  /** Used by both trigger shapes, to enqueue the keyed work jobs. */
  readonly scheduler: IngestionScheduler;
}

/** pg-boss hands `work()` an array even at `batchSize: 1` (Assumption A1) — iterated defensively, as every other handler in this package does. */
export async function handleEodCloseJob(
  deps: HandleEodCloseJobDeps,
  jobs: readonly Job<EodCloseJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const data = job.data ?? {};
    if (data.residual === true) {
      await handleResidualEodCloseFanOut(deps);
      continue;
    }
    if (data.exchangeMic === undefined) {
      throw new Error(
        "eod-close: job carries neither an exchangeMic nor residual: true — refusing to guess which exchange to close.",
      );
    }
    if (data.isoDate === undefined) {
      await handleScheduledEodCloseTrigger(deps, data.exchangeMic);
      continue;
    }
    await handleOneExchangeClose(deps, data.exchangeMic, data.isoDate);
  }
}

/**
 * A known exchange's scheduled trigger: resolve "today" **in that exchange's
 * own zone** — never the container's, which runs `TZ=UTC` — and enqueue the
 * keyed work job. A second trigger for the same exchange and date (a
 * duplicate dispatch, a catch-up) enqueues nothing.
 */
async function handleScheduledEodCloseTrigger(
  deps: HandleEodCloseJobDeps,
  exchangeMic: string,
): Promise<string | null> {
  const session = EXCHANGE_SESSIONS[exchangeMic];
  const timeZone = session?.timeZone ?? EOD_CLOSE_RESIDUAL_TIME_ZONE;
  const { isoDate } = localDateTimeParts(deps.clock.now(), timeZone);
  return deps.scheduler.enqueueEodClose({ exchangeMic, isoDate });
}

/**
 * The residual lane: every MIC in the refresh population that
 * {@link EXCHANGE_SESSIONS} has no entry for. Computed from
 * `fetchRefreshPopulation` at run time rather than from a static list — the
 * set changes whenever a tenant buys or watches an instrument on a new
 * exchange, and a static list would silently stop covering them.
 *
 * The population is `held ∪ watched` as of the `watchlist` cycle
 * (fan-out call site 4, FR-343). Without this site a watched instrument on a MIC **no tenant holds anything on** would get
 * no `eod-close` trigger at all, so the per-exchange fill (site 3) would never
 * run for it; `fetchHeldInstruments` itself is unchanged.
 */
async function handleResidualEodCloseFanOut(
  deps: HandleEodCloseJobDeps,
): Promise<readonly string[]> {
  const held = await fetchRefreshPopulation(deps.db);
  const residualMics = [
    ...new Set(
      held
        .map((heldInstrument) => heldInstrument.exchangeMic)
        .filter((mic): mic is string => mic !== null && EXCHANGE_SESSIONS[mic] === undefined),
    ),
  ].sort();

  const { isoDate } = localDateTimeParts(deps.clock.now(), EOD_CLOSE_RESIDUAL_TIME_ZONE);
  const enqueued: string[] = [];
  for (const exchangeMic of residualMics) {
    const jobId = await deps.scheduler.enqueueEodClose({ exchangeMic, isoDate });
    if (jobId !== null) enqueued.push(jobId);
  }
  rootLogger().info("eod-close: residual lane enqueued its exchanges", {
    component: "market-composition",
    count: enqueued.length,
    exchange: residualMics.join(","),
  });
  return enqueued;
}

/**
 * The work shape — `runEodCloseJob` called unmodified (AC-16), with fresh
 * provider routing. `isoDate` is carried only so the queue key can be
 * per-day; the job body resolves its own `toDate` from the clock, exactly as
 * it did before this cycle.
 *
 * Equity-like instruments are the only ones with an `exchange_mic` at all,
 * so the provider is routed for `SHARE` — the same routing table the
 * backfill path uses.
 */
async function handleOneExchangeClose(
  deps: HandleEodCloseJobDeps,
  exchangeMic: string,
  isoDate: string,
): Promise<void> {
  const providerKey = providerKeyForBackfill("SHARE");
  if (providerKey === undefined) {
    throw new Error("eod-close: no provider is routed for exchange-listed instruments.");
  }
  const provider = deps.workerProviders[providerKey];
  if (provider === undefined) {
    throw new Error(
      `eod-close: provider key ${providerKey} has no registered worker provider — cannot fill ${exchangeMic}'s close for ${isoDate}.`,
    );
  }

  await runEodCloseJob({
    db: deps.db,
    clock: deps.clock,
    provider,
    providerKey,
    exchangeMic,
  });
}
