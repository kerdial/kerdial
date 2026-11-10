import type { Job } from "pg-boss";
import { getInstrumentById } from "@kerdial/ledger";
import {
  markInstrumentBackfillUnresolved,
  runInstrumentBackfillJob,
  type Clock,
} from "@kerdial/market-ingestion";
import type { ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { resolveProviderSymbol } from "./provider-symbol.js";
import { providerKeyForBackfill } from "./routing.js";

/**
 * The `history:backfill:*` `boss.work()` handler body — it closes "the
 * single most important integration gap": nothing writes `instrument_provider_map` for a freshly
 * created instrument, so this handler resolves the provider symbol itself,
 * before ever calling the existing, unmodified `runInstrumentBackfillJob`.
 *
 * Registered (IC-6, `market-runtime.ts`) against a `Db` scoped to the
 * `app_ingest` role — every read/write this file performs
 * (`instrument.SELECT`, `instrument_provider_map.SELECT`/`INSERT`,
 * `instrument_backfill_state`/`instrument_price_daily` via
 * `runInstrumentBackfillJob`) is covered by that role's existing grants
 * (migrations `0007`, `0018`, `0030`) — no new migration needed.
 */

export interface HistoryBackfillJobData {
  readonly instrumentId: string;
}

export interface HandleHistoryBackfillJobDeps {
  /** The `app_ingest`-scoped ingest pool. */
  readonly db: Db;
  readonly clock: Clock;
  /** Worker-lane (blocking, `provider_fetch_log`-writing) providers, keyed by `providerKey`. */
  readonly workerProviders: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>;
}

/**
 * pg-boss v12 hands `work()` an **array** of jobs even at the default
 * `batchSize: 1` (Assumption A1, verified directly against
 * `pg-boss@^12.26.2`'s own `WorkHandler<ReqData, ResData> = (job:
 * Job<ReqData>[]) => Promise<ResData>` type) — this defensively iterates.
 * A failure on one job propagates immediately (this function does not
 * itself catch per-job errors), consistent with "a thrown error is not
 * swallowed... pg-boss's own retry/dead-letter policy applies" (this
 * task's own acceptance criteria) — a batch of more than one job is not a
 * case this queue's `exclusive` policy (`scheduler.ts`) ever actually
 * produces in practice (at most one queued-or-active job per instrument),
 * so a mid-batch throw aborting the remaining jobs in the same array is
 * not a real-world concern here.
 */
export async function handleHistoryBackfillJob(
  deps: HandleHistoryBackfillJobDeps,
  // `retryCount` arrives only because this queue is registered with
  // `includeMetadata: true`; typed as optional rather than requiring the full
  // `JobWithMetadata` so this suite's own hand-built jobs — and any caller
  // that legitimately has no metadata — still satisfy the signature.
  jobs: readonly (Job<HistoryBackfillJobData> & { readonly retryCount?: number })[],
): Promise<void> {
  for (const job of jobs) {
    // `retryCount` is why this queue is registered with
    // `includeMetadata: true` (`worker-registrations.ts`). It distinguishes an
    // enqueue's first attempt from pg-boss's own retries of the same job body,
    // and only the first spends a unit of the reconcile sweep's retry budget.
    // `?? 0` because a hand-built job in a test carries no metadata, and a
    // single invocation *is* a first attempt.
    await handleOneInstrumentBackfill(deps, job.data.instrumentId, job.retryCount ?? 0);
  }
}

/**
 * The single-instrument core of the handler — exported directly so tests
 * can drive it without constructing a fake pg-boss `Job` wrapper for every
 * case; {@link handleHistoryBackfillJob} above is the pg-boss-shaped entry
 * point `market-runtime.ts` actually registers.
 */
export async function handleOneInstrumentBackfill(
  deps: HandleHistoryBackfillJobDeps,
  instrumentId: string,
  /** pg-boss's `retryCount` — see {@link handleHistoryBackfillJob}. Defaults to a first attempt. */
  jobAttempt = 0,
): Promise<void> {
  const instrumentRow = await getInstrumentById(deps.db, instrumentId);
  if (!instrumentRow) {
    // The instrument was deleted (or never existed) between enqueue and
    // dispatch — nothing to do, and nothing to retry either (retrying
    // would only ever find the same absence).
    rootLogger().warn("history-backfill: no instrument row — completing as a no-op", {
      component: "market-composition",
      instrument_id: instrumentId,
    });
    return;
  }

  const providerKey = providerKeyForBackfill(instrumentRow.kind);
  if (providerKey === undefined) {
    // No automated quote source: complete the job without attempting any
    // provider call (AC-14). **`SCPI` would land
    // here** (`scpi` cycle, SC-L10) — but it is never enqueued, since every
    // enqueuing caller pre-checks `providerKeyForBackfill`, so this is
    // defence. INDEX left this branch for the benchmark line and FUND with
    // ADR-0018; both walk the whole Yahoo path below exactly as a SHARE does.
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
    // No candidate at all — log and complete
    // without running the backfill body, leaving the state row `PENDING`
    // for the hourly reconcile sweep (`reconcile-handler.ts`) to retry.
    //
    // The attempt is also **stamped**. `status` stays `PENDING` —
    // that is what keeps the sweep retrying — but `last_attempted_at` now
    // separates "not yet reached" from "attempted, resolves for nobody". Those
    // were the same row before, so an instrument no provider can name was
    // indistinguishable from a fresh queue item while spending one search an
    // hour, forever, with only a log line to show for it.
    const stamped = await markInstrumentBackfillUnresolved(deps.db, deps.clock, instrumentId);
    rootLogger().warn(
      "history-backfill: no provider symbol resolved — left PENDING for the hourly reconcile sweep",
      {
        component: "market-composition",
        instrument_id: instrumentId,
        provider: providerKey,
        // False when a widen, a reload or a claim moved the row out of
        // `PENDING` between this handler's read and this write — the stamp is
        // declined rather than applied to a run it knows nothing about.
        attempt_stamped: stamped,
      },
    );
    return;
  }

  const result = await runInstrumentBackfillJob({
    db: deps.db,
    clock: deps.clock,
    provider,
    instrumentId,
    symbol,
    // The declared listing currency, as a hint a currency-choosing
    // provider would serve the series in. Yahoo (now every kind's provider)
    // ignores it — the `<SYMBOL>-<CCY>` line it resolved fixes the currency.
    quoteCurrency: instrumentRow.listingCurrency,
    jobAttempt,
  });
  if (result.pendingReason === "PROVIDER_RATE_LIMITED") {
    // The provider's rate limit outlasted the worker lane's bounded
    // Retry-After honouring; the job body released the row to PENDING for the
    // reconcile sweep. Logged here because `market/ingestion` carries no
    // logger — this line is the operator-visible half of that deferral.
    rootLogger().warn(
      "history-backfill: provider rate limit outlasted the lane's wait budget — row released to PENDING for the reconcile sweep",
      {
        component: "market-composition",
        instrument_id: instrumentId,
        provider: providerKey,
      },
    );
  }
}
