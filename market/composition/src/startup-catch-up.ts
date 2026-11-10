import {
  EOD_CLOSE_QUEUE,
  EQUITY_LIKE_KINDS,
  FX_DAILY_QUEUE,
  createDbMarketCalendarLookup,
  fetchHeldInstruments,
  maxFxRateDate,
  maxPriceDateForHeldInstrumentsOnExchange,
  mostRecentCompletedEodSessionDay,
  mostRecentTargetPublicationDay,
  type Clock,
  type IngestionScheduler,
  type MarketCalendarLookup,
} from "@kerdial/market-ingestion";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";

/**
 * SH-17 (FR-19, AC-18/AC-19) — **catch-up on worker start**.
 *
 * Runs after `boss.start()` and every handler/schedule registration, and
 * before the readiness marker (`worker-main.ts`): a stopped worker misses
 * whatever ticks fell inside its downtime, and pg-boss's cron does not
 * back-fill them — the next fire is the next fire.
 *
 * **Two job types, and only two.** For each the "was a tick missed?" question
 * is answered from the *written series* (`market/ingestion`'s
 * `catch-up-window.ts` — see its header for why job history cannot be the
 * source), and a missed one is answered by enqueueing the ordinary job, under
 * the ordinary key:
 *
 *  - **`eod-close`**, per held MIC: `max(instrument_price_daily.price_date)`
 *    for that MIC's held instruments vs. the most recent completed session day.
 *    Enqueued through {@link IngestionScheduler.enqueueEodClose}, i.e. under
 *    the `eod:{MIC}:{date}` key, which is what makes a catch-up and that
 *    day's own scheduled run collapse to **one** execution under the queue's
 *    `exclusive` policy rather than both fetching.
 *  - **`fx-daily`**: `max(fx_rate_daily.rate_date)` vs. the most recent TARGET
 *    publication day. Its queue is `singleton` (no key dimension), so a
 *    catch-up and a scheduled wake-up cannot be active together — and a
 *    *completed* same-day run turns the other into a no-op through the
 *    handler's own DB-driven decision (`fxDailyRatesAlreadyIngested`).
 *    The collapse is therefore the same property, reached through this queue's
 *    own mechanism instead of a per-day key.
 *
 * **What is deliberately absent:**
 *
 *  - **quote-refresh** (AC-19). A missed slot is at most ~12 hours of
 *    quote age on a table nothing displays but the staleness indicator, the
 *    next slot supersedes it, and the on-demand refresh endpoint is the
 *    explicit remedy. {@link CATCH_UP_QUEUES} is the machine-checkable form of
 *    that absence.
 *  - **the nightly backup** — moot since the backup pipeline was retired,
 *    and recorded because the *reasoning* survives it: re-running a
 *    missed dump now produces a differently-dated artifact, not the missing
 *    one, so a scheduled export does not get a catch-up lane either.
 *
 * This function only ever *enqueues*. No provider is called on this path, and
 * nothing here writes market data — which is what keeps a worker's startup
 * fast and its failure modes ordinary.
 */

/**
 * Exactly the job types FR-19 covers. Exported so "quote-refresh has no
 * catch-up" can be asserted against a value rather than inferred from the
 * absence of code.
 */
export const CATCH_UP_QUEUES: readonly string[] = [EOD_CLOSE_QUEUE, FX_DAILY_QUEUE];

export interface StartupCatchUpDeps {
  /** The `app_ingest`-scoped ingest pool — worker mode only. */
  readonly db: Db;
  readonly clock: Clock;
  readonly scheduler: IngestionScheduler;
  /** Test seam; defaults to a real `market_calendar` read (`createDbMarketCalendarLookup`). */
  readonly marketCalendarLookup?: MarketCalendarLookup;
  /** Defaults to SH-38's structured INFO line — the worker has no HTTP surface, so its lifecycle is only ever visible in logs. */
  readonly log?: (message: string) => void;
}

/** One lane's decision — a MIC for `eod-close`, the single FX lane for `fx-daily`. */
interface CatchUpLaneDecision {
  readonly queue: string;
  /** The MIC, or {@link FX_DAILY_QUEUE} for the one FX lane. */
  readonly lane: string;
  /** The day the lane owed a run for; `null` when no completed day lies inside the lookback window. */
  readonly owedDate: string | null;
  /** The lane's last written date — `max(price_date)` / `max(rate_date)`; `null` when it has written nothing at all. */
  readonly lastWrittenDate: string | null;
  readonly fired: boolean;
  /** pg-boss's job id when this catch-up enqueued one; `null` when it fired nothing, or when the enqueue collapsed onto a job already queued or active. */
  readonly jobId: string | null;
}

export interface StartupCatchUpResult {
  readonly lanes: readonly CatchUpLaneDecision[];
  /** {@link CATCH_UP_QUEUES} — the queues this pass considered at all. */
  readonly queuesConsidered: readonly string[];
}

/** Whether a lane whose last written date is `lastWritten` still owes `owedDate`. A lane that has written nothing owes it too — there is no series to be up to date with. */
function isBehind(lastWrittenDate: string | null, owedDate: string): boolean {
  return lastWrittenDate === null || lastWrittenDate < owedDate;
}

export async function runStartupCatchUp(deps: StartupCatchUpDeps): Promise<StartupCatchUpResult> {
  const log =
    deps.log ??
    ((message: string) => {
      rootLogger().info(message, { component: "market-composition" });
    });
  const lookup = deps.marketCalendarLookup ?? createDbMarketCalendarLookup(deps.db);
  const now = deps.clock.now();
  const lanes: CatchUpLaneDecision[] = [];

  // The MIC set comes from what is *held*, exactly as the EOD fan-out's own
  // lanes do — known exchanges and residual MICs alike, so the residual lane's
  // instruments are not silently exempt from catch-up (they are the ones most
  // likely to be behind). A crypto instrument has no `exchange_mic` and no EOD
  // close at all.
  const held = await fetchHeldInstruments(deps.db, { kinds: EQUITY_LIKE_KINDS });
  const heldMics = [
    ...new Set(
      held
        .map((heldInstrument) => heldInstrument.exchangeMic)
        .filter((mic): mic is string => mic !== null),
    ),
  ].sort();

  for (const exchangeMic of heldMics) {
    const owedDate = await mostRecentCompletedEodSessionDay({ exchangeMic, now, lookup });
    const lastWrittenDate = await maxPriceDateForHeldInstrumentsOnExchange(deps.db, exchangeMic);
    if (owedDate === null || !isBehind(lastWrittenDate, owedDate)) {
      lanes.push({
        queue: EOD_CLOSE_QUEUE,
        lane: exchangeMic,
        owedDate,
        lastWrittenDate,
        fired: false,
        jobId: null,
      });
      continue;
    }

    const jobId = await deps.scheduler.enqueueEodClose({ exchangeMic, isoDate: owedDate });
    lanes.push({
      queue: EOD_CLOSE_QUEUE,
      lane: exchangeMic,
      owedDate,
      lastWrittenDate,
      fired: true,
      jobId,
    });
    log(
      `[market-composition] catch-up: ${exchangeMic} last wrote ${lastWrittenDate ?? "nothing"}, ` +
        `${owedDate} was owed — eod-close enqueued (${jobId ?? "collapsed onto an existing job"}).`,
    );
  }

  const fxOwedDate = await mostRecentTargetPublicationDay({ now, lookup });
  const fxLastWrittenDate = await maxFxRateDate(deps.db);
  if (fxOwedDate !== null && isBehind(fxLastWrittenDate, fxOwedDate)) {
    const jobId = await deps.scheduler.enqueueFxDaily();
    lanes.push({
      queue: FX_DAILY_QUEUE,
      lane: FX_DAILY_QUEUE,
      owedDate: fxOwedDate,
      lastWrittenDate: fxLastWrittenDate,
      fired: true,
      jobId,
    });
    log(
      `[market-composition] catch-up: fx_rate_daily last wrote ${fxLastWrittenDate ?? "nothing"}, ` +
        `${fxOwedDate} was owed — fx-daily enqueued (${jobId ?? "collapsed onto an existing job"}).`,
    );
  } else {
    lanes.push({
      queue: FX_DAILY_QUEUE,
      lane: FX_DAILY_QUEUE,
      owedDate: fxOwedDate,
      lastWrittenDate: fxLastWrittenDate,
      fired: false,
      jobId: null,
    });
  }

  const fired = lanes.filter((lane) => lane.fired);
  log(
    `[market-composition] catch-up: ${fired.length} of ${lanes.length} lane(s) were behind` +
      (fired.length > 0 ? ` (${fired.map((lane) => lane.lane).join(", ")})` : "") +
      ". quote-refresh is excluded by design (AC-19).",
  );

  return { lanes, queuesConsidered: CATCH_UP_QUEUES };
}
