import type { Job } from "pg-boss";
import {
  QUOTE_REFRESH_QUEUE,
  QUOTE_REFRESH_TIME_ZONE,
  bumpMarketDataEpoch,
  fetchRefreshPopulation,
  routeToProviderSymbolsViaDb,
  scheduledQuoteRefreshBucket,
  upsertPriceDailyFromQuotesViaDb,
  upsertQuoteLatestViaDb,
  type Clock,
  type IngestionScheduler,
  type QuoteRefreshEntry,
} from "@kerdial/market-ingestion";
import type { ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { providerKeyForDiscovery, quoteRoutedKinds } from "./routing.js";

/**
 * SH-15 — the `quote-refresh` consumer. The queue has
 * existed since T-33 and, like gap-repair, has never been consumed.
 *
 * **Two job shapes on one queue**:
 *
 *  - **fan-out** (no `instrumentId`): sent by the `0 8` and `0 20`
 *    Europe/Paris crons. Computes the bucket `sched:<YYYY-MM-DD>:<08|20>` and
 *    enqueues one job per held instrument under
 *    `quote:refresh:{instrumentId}:{bucket}`.
 *  - **per-instrument** (`{ instrumentId, bucket }`): fetches that
 *    instrument's latest quote and writes `instrument_quote_latest` through
 *    the unmodified `upsertQuoteLatestViaDb` (see
 *    {@link handleOneQuoteRefresh} for why the fetch goes through the worker
 *    lane rather than a second guarded runner of its own).
 *
 * **`isEquityPollWindow` is deliberately not consulted anywhere on this
 * path** (FR-14/FR-56). The gate existed to keep a 5-minute equity poll
 * inside "session + 30 min"; at 08:00/20:00 Europe/Paris it would suppress
 * most runs — 08:00 precedes XPAR's open, and 20:00 follows XNYS's local
 * close for most of the year — silently defeating the locked cadence. The
 * gate (and the T-34 cycle engine that consulted it) was deleted as dead
 * code; EOD close still uses `EXCHANGE_SESSIONS` directly. This handler
 * passes no `isEligible` at all, so there is no gate to misfire rather than
 * a gate configured to always pass.
 *
 * **Each per-instrument run writes the observation twice.**
 * `upsertQuoteLatestViaDb` writes `instrument_quote_latest` — the staleness
 * view's input, which no valuation read path consults — and
 * `upsertPriceDailyFromQuotesViaDb` writes the same observation into
 * `instrument_price_daily`, which is what `loadPricingSeries` reads. The
 * second write covers **today only**: a quote about a day that has already
 * ended (a pre-open, weekend or holiday press) is dropped rather than allowed
 * to revise a settled day the daily-history path already owns. Only the
 * first write used to exist, so a refresh (scheduled or on-demand) provably
 * could not move a figure on any screen.
 *
 * The epoch bump follows `market-data-epoch.ts`'s two ordering rules: after
 * the rows have committed, and only when a row actually landed — which is
 * why the daily write returns a count rather than `void`. It is one bump per
 * *job*, and a job here is one instrument; the alternative (a bump owned by
 * the fan-out, once for the batch) does not exist on this queue, because the
 * fan-out job completes long before the per-instrument jobs it enqueued have
 * run. Cache invalidation is lazy — `attemptMaterialize` rebuilds on the next
 * *read* — so N bumps arriving in a burst cost one rebuild, not N, unless a
 * read interleaves.
 */

export interface QuoteRefreshJobData {
  /** Absent on the scheduled fan-out job; present on every per-instrument job. */
  readonly instrumentId?: string;
  /** The cadence bucket the fan-out computed; carried through so the singleton key and the job agree. */
  readonly bucket?: string;
}

export interface HandleQuoteRefreshJobDeps {
  /** The `app_ingest`-scoped ingest pool. */
  readonly db: Db;
  readonly clock: Clock;
  /** Worker-lane providers, keyed by `providerKey`. */
  readonly workerProviders: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>;
  /** Used by the fan-out shape, to enqueue the per-instrument jobs. */
  readonly scheduler: IngestionScheduler;
}

/** pg-boss hands `work()` an array even at `batchSize: 1` (Assumption A1). */
export async function handleQuoteRefreshJob(
  deps: HandleQuoteRefreshJobDeps,
  jobs: readonly Job<QuoteRefreshJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const data = job.data ?? {};
    if (data.instrumentId === undefined || data.instrumentId === "") {
      await handleScheduledQuoteRefreshFanOut(deps);
      continue;
    }
    await handleOneQuoteRefresh(deps, data.instrumentId);
  }
}

/**
 * The scheduled shape: every instrument in the refresh population,
 * **equity-like and crypto alike**, replacing the two kind-partitioned
 * fan-outs the 5-minute/3-minute cadence used. The one `kinds` filter is
 * {@link quoteRoutedKinds} (SC-L10): a kind with no quote
 * route (`SCPI`) is never enqueued, rather than enqueued and no-op'd below.
 *
 * The population is `held ∪ watched` as of the `watchlist` cycle
 * (fan-out call site 1, FR-343): it was
 * `fetchHeldInstruments`, and that function is unchanged — the union is a
 * sibling module (`watchlist-fanout.ts`) and is the identity while
 * `watchlist_item` is empty.
 */
async function handleScheduledQuoteRefreshFanOut(
  deps: HandleQuoteRefreshJobDeps,
): Promise<readonly string[]> {
  const bucket = scheduledQuoteRefreshBucket(deps.clock.now(), QUOTE_REFRESH_TIME_ZONE);
  const held = await fetchRefreshPopulation(deps.db, { kinds: quoteRoutedKinds() });

  const enqueued: string[] = [];
  for (const heldInstrument of held) {
    const jobId = await deps.scheduler.enqueueQuoteRefresh({
      instrumentId: heldInstrument.instrumentId,
      bucket,
    });
    if (jobId !== null) enqueued.push(jobId);
  }
  rootLogger().info("quote-refresh: fanned out to the held instruments", {
    component: "market-composition",
    queue: QUOTE_REFRESH_QUEUE,
    count: enqueued.length,
  });
  return enqueued;
}

/**
 * One instrument's refresh. Per-instrument rather than one batched cycle
 * because the singleton key is `quote:refresh:{instrumentId}:{bucket}` — a
 * per-instrument key needs a per-instrument job, which is also what will let
 * the on-demand path (SH-18/19) refresh exactly the instruments one tenant
 * holds.
 *
 * **Why this calls the provider directly, with no second guarded runner.**
 * The deleted T-34 cycle engine (`runQuoteRefreshCycle`)
 * guarded its own fetches through `fetchLatestBatched`, which applied the
 * circuit breaker, the token-bucket limiter and the `provider_fetch_log`
 * write itself. The worker lane
 * (`provider-lanes.ts`'s `createWorkerProvider`) already applies all three to
 * every call. Composing them would put **two token buckets in series** for
 * one fetch — halving the effective rate and logging each attempt twice. So
 * this handler keeps the cycle's persistence half verbatim
 * (`routeToProviderSymbolsViaDb` → `upsertQuoteLatestViaDb`, both unchanged)
 * and lets the already-guarded provider do the fetching.
 *
 * A provider failure is left to propagate: pg-boss's retry and dead-letter
 * policy is the retry mechanism here, and "never fabricate" holds either way
 * — a failed fetch writes nothing, exactly as the cycle body's own contract
 * specifies.
 */
async function handleOneQuoteRefresh(
  deps: HandleQuoteRefreshJobDeps,
  instrumentId: string,
): Promise<void> {
  // A targeted lookup, not the full cross-tenant scan — this handler
  // already knows the one instrument it wants from the job payload.
  //
  // **`fetchRefreshPopulation`, not `fetchHeldInstruments`** — the `watchlist`
  // cycle's fan-out call site 2, and the
  // load-bearing one: the fan-out above enqueues a job per *watched*
  // instrument too, and with a held-only re-check here every one of those jobs
  // would complete as the logged no-op below and write nothing. That failure
  // mode is invisible to an enqueue-count assertion, which is why
  // `market/ingestion/src/watchlist-fanout.integration.test.ts` proves this
  // body attempts provider work for a watched-not-held instrument.
  const held = await fetchRefreshPopulation(deps.db, { instrumentIds: [instrumentId] });
  if (held.length === 0) {
    // No longer in the refresh population between enqueue and dispatch — sold
    // out, or un-watched. Nothing to refresh, and a retry would only find the
    // same absence.
    rootLogger().warn("quote-refresh: instrument is no longer held — completing as a no-op", {
      component: "market-composition",
      instrument_id: instrumentId,
    });
    return;
  }

  const kind = held[0]!.kind;
  const providerKey = providerKeyForDiscovery(kind);
  if (providerKey === undefined) {
    // Anything with no automated quote source — `SCPI` (`scpi` cycle). The
    // scheduled fan-out above and the on-demand route both leave it out
    // already, so this is defence, never the expected path.
    return;
  }
  const provider = deps.workerProviders[providerKey];
  if (provider === undefined) {
    throw new Error(
      `quote-refresh: instrument ${instrumentId} routed to provider key ${providerKey}, but no worker provider is registered for it.`,
    );
  }

  const symbolMap = await routeToProviderSymbolsViaDb(deps.db, [instrumentId], providerKey);
  const symbol = symbolMap.get(instrumentId);
  if (symbol === undefined) {
    // No `instrument_provider_map` row for this provider yet — the backfill
    // handler is what creates them; skipping is what the cycle body does too
    // (`skippedNoMapping`), never an error.
    return;
  }

  // The declared listing currency rides along as a hint. Yahoo (now every
  // kind's provider) ignores it; its resolved line already fixes the currency.
  const observations = await provider.fetchLatest([symbol], held[0]!.listingCurrency);
  const entries: QuoteRefreshEntry[] = observations.map((observation) => ({
    instrumentId,
    observation,
  }));
  if (entries.length === 0) return;

  await upsertQuoteLatestViaDb(deps.db, deps.clock.now(), entries);
  // The write that reaches the screen. `instrument_quote_latest` above
  // feeds `staleness.ts` and nothing else; this one feeds `loadPricingSeries`,
  // and therefore every valued holding.
  const rowsWritten = await upsertPriceDailyFromQuotesViaDb(deps.db, deps.clock.now(), entries);
  if (rowsWritten > 0) {
    await bumpMarketDataEpoch(deps.db);
  }
}
