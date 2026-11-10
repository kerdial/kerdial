import type { Job } from "pg-boss";
import { EcbFxRateProvider } from "@kerdial/market-adapters";
import {
  describeFxSeriesShortfall,
  FX_DAILY_TIME_ZONE,
  fetchHeldCurrencies,
  fetchTrackedFxPairs,
  fxDailyRatesAlreadyIngested,
  fxPairKey,
  localDateTimeParts,
  runFxDailyWithHistoryCoverage,
  type Clock,
} from "@kerdial/market-ingestion";
import type { CurrencyPair, FxProviderCapabilities, FxRateProvider } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";

/**
 * SH-14 — the `fx-daily` consumer.
 *
 * **The two crons (17:30 and 19:00 Europe/Paris) are one mechanism.** The
 * 19:00 entry *is* the retry, and the decision must come from the database
 * rather than from process memory:
 *
 * > `today_cet := local date in Europe/Paris`
 * > `if fx_rate_daily already has a row with rate_date >= today_cet` → complete, no fetch
 * > `else` → run the incremental pull
 *
 * `FxDailyIngestionScheduler`'s in-memory per-CET-day state machine was
 * deliberately **not** on this path, and was deleted as dead code —
 * a scheduler whose retry state resets on restart is not a scheduler you can
 * deploy: the
 * container restarts on deploy and on any crash, and a crash between 17:30
 * and 19:00 is exactly when the retry matters.
 *
 * The fetch itself goes through `runFxDailyWithHistoryCoverage` (SH-5), so a
 * pair with no history at all gets its ECB history loaded **before** the
 * first incremental row lands — the ordering SH-5 requires, and the one
 * SH-14 owed as "queue wiring".
 */

export interface FxDailyJobData {
  /** Optional override for tests and catch-up runs; defaults to the clock's own date in `Europe/Paris`. */
  readonly isoDate?: string;
  /**
   * Skips the "today is already ingested" short-circuit and
   * fetches anyway. Set only by the on-demand trigger
   * (`POST /market-data/fx/refresh`), never by either cron: the two scheduled
   * slots *are* one mechanism precisely because the 19:00 one is allowed to
   * find the work already done, and a forced cron would turn the retry
   * into a second guaranteed provider call every weekday.
   *
   * What it does **not** skip: `ensureFxHistoryCoverage`, the positive-rate
   * guard, or the upsert's `ON CONFLICT DO UPDATE`. A forced run rewrites
   * today's rows with what the provider currently publishes — which is the
   * point of the button (ECB revises, and a pair added an hour ago has no rows
   * at all) — and cannot fabricate anything a scheduled run could not.
   */
  readonly force?: boolean;
}

export interface HandleFxDailyJobDeps {
  /** The `app_ingest`-scoped ingest pool. */
  readonly db: Db;
  readonly clock: Clock;
  /**
   * The FX provider **port**. Defaults to the real ECB adapter — this is the
   * composition root, the one package allowed to name it.
   */
  readonly provider?: FxRateProvider;
}

interface FxDailyRunResult {
  readonly isoDate: string;
  readonly pairs: readonly CurrencyPair[];
  /** `true` when the DB-driven decision found today's rates already present and no fetch was made. */
  readonly skippedAlreadyIngested: boolean;
  readonly written: number;
}

/**
 * The pair set: **what tenants hold, plus what someone asked to
 * track**, intersected with what the provider publishes.
 *
 * The held half is the original default and its reasoning is unchanged (see
 * {@link runFxDailyForToday}). The tracked half is the Devises screen's "add a
 * pair": a currency you are *about to* buy into has no holding, so the derived
 * set can never contain it, so it never gets a history — which is the gap
 * `fx_tracked_pair` exists to close.
 *
 * Two properties this function is responsible for, both of which a plainer
 * union gets wrong:
 *
 *  - **Deduplication by `(base, quote)`.** A tracked pair that is *also*
 *    implied by a holding must appear once. Requesting it twice would double
 *    every provider observation for it in one batch and make
 *    `fxDailyRatesAlreadyIngested`'s "every pair covered" reading meaningless.
 *  - **An unsupported tracked pair is dropped, not fatal.** The API validates
 *    against `capabilities()` before writing a row (`fx-supported-pairs.ts`),
 *    but the provider's published set can shrink *afterwards* — EUR/RUB is the
 *    standing example, suspended mid-2022 — and a `SymbolNotFound` from one
 *    stale row would fail the whole batch and leave every other pair
 *    unfetched. Dropping it degrades exactly one pair, and the screen shows
 *    that pair as unsupported from the same `capabilities()` answer.
 */
export function resolveFxDailyPairs(params: {
  readonly capabilities: FxProviderCapabilities;
  readonly heldCurrencies: readonly string[];
  readonly trackedPairs: readonly CurrencyPair[];
}): CurrencyPair[] {
  const held = new Set(params.heldCurrencies);
  const publishable = new Set(params.capabilities.publishedPairs.map(fxPairKey));

  const heldPairs = params.capabilities.publishedPairs.filter(
    (pair) => pair.base === params.capabilities.baseCurrency && held.has(pair.quote),
  );
  const trackedPairs = params.trackedPairs.filter((pair) => publishable.has(fxPairKey(pair)));

  const byKey = new Map<string, CurrencyPair>();
  for (const pair of [...heldPairs, ...trackedPairs]) byKey.set(fxPairKey(pair), pair);
  return [...byKey.values()];
}

/** pg-boss hands `work()` an array even at `batchSize: 1` (Assumption A1). */
export async function handleFxDailyJob(
  deps: HandleFxDailyJobDeps,
  jobs: readonly Job<FxDailyJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await runFxDailyForToday(deps, job.data?.isoDate, job.data?.force ?? false);
  }
}

/**
 * One daily run, exported directly so tests can drive it without a pg-boss
 * `Job` wrapper.
 *
 * The pair list comes from **what tenants actually hold**
 * (`fetchHeldCurrencies`) **plus what someone asked to track**
 * (`fetchTrackedFxPairs`), intersected with what the provider
 * publishes — see {@link resolveFxDailyPairs}. Asking for every published pair
 * would fetch currencies nobody owns. The provider advertises only currencies
 * it still publishes, so a held or tracked retired one (HRK, BGN, RUB)
 * is left out here rather than failing the whole job with a `SymbolNotFound`;
 * its valuations fall back to the tenant's pinned rates (SH-6). No
 * held foreign currency and no tracked pair means no pairs, which means no
 * fetch and no provider call at all.
 */
async function runFxDailyForToday(
  deps: HandleFxDailyJobDeps,
  overrideIsoDate?: string,
  force = false,
): Promise<FxDailyRunResult> {
  const provider = deps.provider ?? new EcbFxRateProvider();
  const { isoDate } = localDateTimeParts(deps.clock.now(), FX_DAILY_TIME_ZONE);
  const today = overrideIsoDate ?? isoDate;

  const pairs = resolveFxDailyPairs({
    capabilities: provider.capabilities(),
    heldCurrencies: await fetchHeldCurrencies(deps.db),
    trackedPairs: await fetchTrackedFxPairs(deps.db),
  });

  if (pairs.length === 0) {
    rootLogger().info(
      "fx-daily: no held or tracked currency the provider publishes — nothing to fetch today",
      { component: "market-composition" },
    );
    return { isoDate: today, pairs, skippedAlreadyIngested: false, written: 0 };
  }

  if (!force && (await fxDailyRatesAlreadyIngested(deps.db, pairs, today))) {
    // The DB-driven decision's first branch: the 17:30 run already succeeded
    // (possibly in a process that no longer exists), so the 19:00 wake-up
    // completes without touching the provider. `force` is the one thing that skips
    // this branch — an explicit user action, never a cron.
    rootLogger().info("fx-daily: today is already ingested — no fetch", {
      component: "market-composition",
    });
    return { isoDate: today, pairs, skippedAlreadyIngested: true, written: 0 };
  }

  const result = await runFxDailyWithHistoryCoverage({
    db: deps.db,
    provider,
    pairs,
    clock: deps.clock,
  });

  // A hole the coverage step found and fetched is an operator-visible
  // event: it means the daily path had been carrying a stale rate across it.
  if (result.coverage.backfills.length > 0) {
    rootLogger().info("fx-daily: history coverage fetched missing ranges", {
      component: "market-composition",
      written: result.coverage.written,
      // The logger takes scalars: one `EUR/USD INTERIOR 2010-02-15..2026-08-27` per hole.
      backfills: result.coverage.backfills
        .map((hole) => `${fxPairKey(hole.pair)} ${hole.kind} ${hole.from}..${hole.to}`)
        .join(", "),
    });
  }

  // A fetched range that came back short (stops long before `to`, or
  // too sparse) was written, but the hole it leaves will be asked for again
  // on every run and answered the same way. Warn, so it is seen.
  if (result.coverage.shortfalls.length > 0) {
    rootLogger().warn("fx-daily: fetched FX history is short of the requested range", {
      component: "market-composition",
      shortfalls: result.coverage.shortfalls.map(describeFxSeriesShortfall).join(", "),
    });
  }

  return {
    isoDate: today,
    pairs,
    skippedAlreadyIngested: false,
    written: result.written,
  };
}
