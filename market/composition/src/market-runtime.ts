import { PgBoss } from "pg-boss";
import postgres from "postgres";
import {
  EcbFxRateProvider,
  YAHOO_PROVIDER_KEY,
  YahooQuoteProvider,
} from "@kerdial/market-adapters";
import {
  CircuitBreaker,
  IngestionScheduler,
  createDbFetchLogger,
  ensureInstrumentBackfillRequested,
  forceInstrumentBackfillReload,
  systemClock,
  type Clock,
  type EnsureInstrumentBackfillParams,
  type ForceInstrumentBackfillReloadParams,
  type ForceInstrumentBackfillReloadResult,
  type IngestionSchedulerStopOptions,
} from "@kerdial/market-ingestion";
import type { FxRateProvider, ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  createPostgresClient,
  resolveApiRequestPoolMax,
  type Db,
} from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import {
  INGEST_POOL_MAX,
  PGBOSS_POOL_MAX,
  assertConnectionBudget,
  type ConnectionBudgetComponents,
} from "./connection-budget.js";
import { createDiscovery, type Discovery } from "./discovery.js";
import {
  OPS_INDICATOR_SWEEP_INTERVAL_MS,
  runOpsIndicatorSweep,
  type OpsIndicatorSweepResult,
} from "./ops-indicator-sweep.js";
import { createDiscoveryProvider, createWorkerProvider } from "./provider-lanes.js";
import { runStartupCatchUp, type StartupCatchUpResult } from "./startup-catch-up.js";
import { registerWorkerQueues } from "./worker-registrations.js";

/**
 * SH-8 — which half of the split this process is.
 *
 * - `"worker"`: owns every `boss.work()` registration and every
 *   `boss.schedule()` upsert, opens the ingest `postgres.js` pool, and runs
 *   pg-boss's supervisor and cron timekeeper.
 * - `"producer"`: sends jobs and nothing else. **No ingest pool is created
 *   at all**, no handler-registration branch exists, and pg-boss is
 *   constructed with `supervise:false, schedule:false, migrate:false` — which
 *   is what makes FR-13 ("exactly one process owns the cron timekeeper")
 *   structural rather than configured.
 */
type MarketRuntimeMode = "producer" | "worker";

/**
 * The `MarketRuntime` shape and its `createMarketRuntime` factory —
 * DD3/DD4/DD16.
 * Constructed **once**, before `buildApp` (`api/src/main.ts`, IC-8) —
 * mirrors the `DbModule.forRoot(db)`/`CsrfSecretModule.forRoot(secret)`
 * convention of externally-constructed dependencies rather than inventing
 * Nest-side factory providers.
 */
export interface MarketRuntime {
  readonly discovery: Discovery;
  /**
   * SH-8 — {@link MarketRuntimeMode}. Derived from
   * `workerInProcess`/`WORKER_IN_PROCESS`; exposed so a caller (and a test)
   * can assert which half it got rather than infer it.
   *
   * Optional on the interface (additive): a hand-written `MarketRuntime` fake
   * predating this field still satisfies the type.
   * `createMarketRuntime` always sets it, so `undefined` means "a fake, which
   * registers nothing either way" — never "mode unknown" for a real runtime.
   */
  readonly mode?: MarketRuntimeMode;
  /** The ceilings this process's own connection-budget check summed at construction — exposed for the same reason `mode` is, and optional for the same reason. */
  readonly connectionCeilings?: ConnectionBudgetComponents;
  /**
   * SH-11/SH-12 — the queues this process registered handlers for, filled by
   * `start()`. Empty in producer mode, and empty before `start()` in either.
   * This is what lets "the readiness marker is withheld until every
   * registration completes" be asserted rather than assumed.
   */
  readonly registeredQueues?: readonly string[];
  /**
   * SH-17 — what the startup catch-up decided, filled by
   * `start()` in worker mode. `null` in producer mode, before `start()`, when
   * the catch-up is switched off ({@link CreateMarketRuntimeConfig.catchUpOnStart}),
   * and when the pass itself failed (see `start()`'s own comment on why that is
   * not fatal). Exposed for the same reason {@link registeredQueues} is: so
   * "fire-once-on-restart, and never for quote-refresh" is assertable rather
   * than assumed.
   */
  readonly startupCatchUp?: StartupCatchUpResult | null;
  /**
   * SH-35 — the last ops-indicator sweep this process
   * completed, filled by the sweep timer `start()` arms in worker mode. `null`
   * in producer mode, before the first sweep, and when the sweep is switched
   * off ({@link CreateMarketRuntimeConfig.opsIndicatorSweep}). Exposed for the
   * same reason {@link registeredQueues} is: so "the worker really is
   * publishing the four conditions" is assertable rather than assumed.
   */
  readonly lastOpsIndicatorSweep?: OpsIndicatorSweepResult | null;
  /**
   * SH-35 — runs one sweep now, outside the timer, and returns what it wrote.
   * `null` in producer mode or when the sweep is switched off. This is the seam
   * a test drives; production reaches the same code through the timer.
   */
  sweepOpsIndicators?(): Promise<OpsIndicatorSweepResult | null>;
  /** `null` when `INGESTION_DATABASE_URL` is unset — no pg-boss, no worker, no ingest pool (DD4). */
  readonly scheduler: IngestionScheduler | null;
  /**
   * Thin wrapper over `ensureInstrumentBackfillRequested` — a documented
   * no-op (logs once, never throws) when {@link scheduler} is `null`.
   */
  enqueueBackfill(db: Db, params: EnsureInstrumentBackfillParams): Promise<void>;
  /**
   * The **force-capable** sibling of {@link enqueueBackfill}, behind
   * `POST /instruments/:id/history-reload`.
   *
   * Optional on the interface for the same additive reason
   * {@link MarketRuntime.mode} is: a hand-written `MarketRuntime` fake predating this field still
   * satisfies the type. `createMarketRuntime` always provides it.
   *
   * It differs from `enqueueBackfill` in exactly one respect, deliberately:
   * it does **not** log-and-continue when {@link scheduler} is `null`, because
   * FR-184 requires the caller to turn that state into a `503`. The
   * implementation throws rather than returning a fake success if that branch
   * is ever reached — see `createMarketRuntime`'s own comment on why it is
   * unreachable from the controller.
   *
   * Writes go through the **caller's** `db` (the API's `app_web` pool),
   * exactly as `enqueueBackfill` does — migration `0029`'s
   * `SELECT, INSERT, UPDATE ON instrument_backfill_state TO app_web` is
   * precisely the set the statement needs and no more.
   */
  requestBackfillReload?(
    db: Db,
    params: ForceInstrumentBackfillReloadParams,
  ): Promise<ForceInstrumentBackfillReloadResult>;
  /** Idempotent — a second call is a no-op. `boss.start()` → queue creation → (if `workerInProcess`) `boss.work()` registrations + the hourly reconcile schedule. */
  start(): Promise<void>;
  /** Idempotent — a second call (or a call when {@link scheduler} is `null`) is a no-op. Drains the ingest `Db` pool as well as pg-boss itself. */
  stop(options?: IngestionSchedulerStopOptions): Promise<void>;
}

export interface CreateMarketRuntimeConfig {
  /**
   * Overrides the `INGESTION_DATABASE_URL` env var (DD4). Unset
   * (and an unset/blank env var) ⇒ {@link MarketRuntime.scheduler} is
   * `null` — no pg-boss instance, no ingest `Db` pool, no worker. Discovery
   * still works: neither adapter needs a database connection.
   */
  readonly ingestionDatabaseUrl?: string;
  /**
   * Overrides the `WORKER_IN_PROCESS` env var (DD4). Defaults to
   * `true`; only the literal string `"false"` disables it via the env var.
   *
   * SH-8: this is also what selects {@link MarketRuntimeMode} — `false` is
   * producer mode, which now means materially less than "skip the handler
   * registrations" (see {@link MarketRuntimeMode}).
   */
  readonly workerInProcess?: boolean;
  /**
   * P2 — this process's own HTTP request-pool ceiling, for
   * the boot-time budget assertion only; nothing here opens that pool.
   * Defaults to `DB_POOL_MAX` (the env var `api`'s request pool sizes itself
   * from), because this factory runs inside the API process in every
   * configuration that has one. **The worker entrypoint passes `0`**: it
   * serves no requests and opens no request pool.
   */
  readonly requestPoolCeiling?: number;
  /** AR-17 — overrides `PGMAX` for the boot assertion. Tests only; a deployment sets the env var. */
  readonly pgMax?: number;
  readonly clock?: Clock;
  /**
   * Test seam — swaps either adapter's live instance for a
   * fake `QuoteProvider`, keyed by the same `ProviderKey` the routing table
   * (`routing.ts`) uses (`YAHOO_PROVIDER_KEY`, `@kerdial/market-adapters`). Lets IC-10's end-to-end gate run against
   * fakes with a real pg-boss.
   */
  readonly providerOverrides?: Readonly<Partial<Record<ProviderKey, QuoteProvider>>>;
  /**
   * SH-14's equivalent seam for the FX side: swaps the real ECB adapter the
   * `fx-daily` consumer would otherwise pull through. Worker mode only —
   * producer mode registers no consumers at all.
   */
  readonly fxProviderOverride?: FxRateProvider;
  /**
   * SH-17 — whether `start()` runs the missed-tick catch-up
   * for `eod-close`/`fx-daily`. Worker mode only; defaults to **on**, and only
   * the literal string `"false"` in `WORKER_CATCH_UP_ON_START` turns it off,
   * the same "explicit option, else env var, else safe default" shape
   * {@link workerInProcess} uses.
   *
   * The off switch exists for two callers: a suite whose subject is some
   * *other* queue's behaviour and would otherwise have a catch-up job racing
   * its own fixtures, and an operator who wants a worker to come up without
   * touching any provider (a restore drill, say). It is not a tuning knob —
   * leaving it off in production means a tick missed during downtime stays
   * missed until the next cron fire.
   */
  readonly catchUpOnStart?: boolean;
  /**
   * SH-35 — whether `start()` arms the ops-indicator sweep
   * timer. Worker mode only; defaults to **on**, and only the literal string
   * `"false"` in `WORKER_OPS_INDICATOR_SWEEP` turns it off — the same
   * "explicit option, else env var, else safe default" shape
   * {@link workerInProcess} and {@link catchUpOnStart} use.
   *
   * The off switch exists for suites that assert on `pgboss.job` or
   * `instrument_quote_latest` and would otherwise have a background sweep
   * reading (and writing `ops_indicator`) underneath their own fixtures. It is
   * not a tuning knob: with it off, `GET /health` reports every table-backed
   * condition as `UNKNOWN` — never swept — forever.
   */
  readonly opsIndicatorSweep?: boolean;
  /**
   * SH-35 — FR-49's push channel. Defaults to `console.error`; SH-38's worker
   * logger is what production passes.
   */
  readonly opsIndicatorError?: (
    message: string,
    fields: Readonly<Record<string, string | number>>,
  ) => void;
}

function resolveIngestionDatabaseUrl(config: CreateMarketRuntimeConfig): string | undefined {
  if (config.ingestionDatabaseUrl !== undefined) {
    return config.ingestionDatabaseUrl.trim() === "" ? undefined : config.ingestionDatabaseUrl;
  }
  const fromEnv = process.env["INGESTION_DATABASE_URL"];
  return fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : undefined;
}

/** Default **on** (DD4) — only the literal string `"false"` (never merely falsy/empty) disables it, mirroring `platform/db/src/client.ts`'s own "explicit option, else env var, else safe default" convention. */
function resolveWorkerInProcess(config: CreateMarketRuntimeConfig): boolean {
  if (config.workerInProcess !== undefined) return config.workerInProcess;
  return process.env["WORKER_IN_PROCESS"] !== "false";
}

/** SH-17 — same shape, same reason: default on, only the literal `"false"` disables the startup catch-up. */
function resolveCatchUpOnStart(config: CreateMarketRuntimeConfig): boolean {
  if (config.catchUpOnStart !== undefined) return config.catchUpOnStart;
  return process.env["WORKER_CATCH_UP_ON_START"] !== "false";
}

/** SH-35 — same shape again: default on, only the literal `"false"` disables the ops-indicator sweep. */
function resolveOpsIndicatorSweep(config: CreateMarketRuntimeConfig): boolean {
  if (config.opsIndicatorSweep !== undefined) return config.opsIndicatorSweep;
  return process.env["WORKER_OPS_INDICATOR_SWEEP"] !== "false";
}

/**
 * The request-pool ceiling this process would open, for
 * {@link MarketRuntime.connectionCeilings} only.
 *
 * `AR-17`: reads it through `platform/db`'s `resolveApiRequestPoolMax` rather
 * than re-parsing `DB_POOL_MAX` here. This function used to duplicate that
 * parsing — including the N7 set-but-empty stance — against a
 * `DEFAULT_REQUEST_POOL_MAX` mirrored by value from a constant `platform/db`
 * kept private. Reading the one function that also sizes the pool removes both
 * the duplicated parser and the mirror.
 */
function resolveRequestPoolCeiling(config: CreateMarketRuntimeConfig): number {
  if (config.requestPoolCeiling !== undefined) return config.requestPoolCeiling;
  return resolveApiRequestPoolMax();
}

function buildAdapterRegistry(
  overrides: Readonly<Partial<Record<ProviderKey, QuoteProvider>>> | undefined,
): Record<ProviderKey, QuoteProvider> {
  return {
    [YAHOO_PROVIDER_KEY]: overrides?.[YAHOO_PROVIDER_KEY] ?? new YahooQuoteProvider(),
  };
}

export function createMarketRuntime(config: CreateMarketRuntimeConfig = {}): MarketRuntime {
  const clock = config.clock ?? systemClock;
  const ingestionDatabaseUrl = resolveIngestionDatabaseUrl(config);
  const workerInProcess = resolveWorkerInProcess(config);
  const mode: MarketRuntimeMode = workerInProcess ? "worker" : "producer";

  // P2, before any pool is opened: this process's own
  // ceilings, summed and checked against `DB_CONNECTION_BUDGET`. These are
  // the three per-process terms — and note that producer mode
  // contributes `0` for the ingest pool because it genuinely never creates
  // it below, not merely because this sum says so.
  const connectionCeilings: ConnectionBudgetComponents = {
    requestPoolCeiling: resolveRequestPoolCeiling(config),
    ingestPoolCeiling: ingestionDatabaseUrl !== undefined && workerInProcess ? INGEST_POOL_MAX : 0,
    pgBossPoolCeiling: ingestionDatabaseUrl !== undefined ? PGBOSS_POOL_MAX : 0,
  };
  // AR-17 (ADR-0008 Stage 8) — **a strictly wider check than the one
  // it replaces**, and the widening is the point.
  //
  // The old assertion summed only `connectionCeilings` above (the pools *this*
  // process opens) against a per-process `DB_CONNECTION_BUDGET`, because its own
  // header held that a cluster-wide check here "would be a guess dressed up as a
  // guarantee" — no process can discover its peers. It is not a guess when the
  // topology is *declared* rather than discovered, which is what `platform/db`'s
  // `deploymentPoolCeilings` does. So the worker now accounts for the api's
  // request pool too, and the cluster total stops living only in a design
  // paragraph that can go stale silently.
  //
  // `requestPoolCeiling` is deliberately **not** forwarded. Under the old model
  // the worker passed `0` to mean "I open no request pool"; under this one the
  // api's pool belongs to the deployment whichever process is asking, so
  // forwarding the worker's `0` would undercount by exactly `DB_POOL_MAX`.
  assertConnectionBudget({
    role: mode,
    ...(config.pgMax === undefined ? {} : { pgMax: config.pgMax }),
  });

  // One breaker instance per runtime, keyed internally by `providerKey` — both
  // lanes below pass the *same* instance, so an outage either lane observes
  // opens the circuit for both **lanes this process runs**.
  //
  // SH-37: that qualifier is the whole correction. This
  // comment used to claim "an outage observed by either lane opens the circuit
  // for both", flat, as a proven property. It stopped being true at T-3a's
  // producer/worker split: `createMarketRuntime` now runs once in `api`
  // (discovery lane only) and once in `worker` (ingestion lane only), so there
  // are two instances and neither sees the other's failures. A cross-process
  // breaker is **not** built this cycle and is deferred with an owner and a
  // trigger (R16). What *is* built is observability: the
  // worker's breaker is published to `ops_indicator` by the sweep below, so
  // `GET /health` can report the ingestion lane's circuit from the other
  // process instead of it being invisible outside this one.
  const breaker = new CircuitBreaker(clock);
  const adapters = buildAdapterRegistry(config.providerOverrides);

  const discoveryProviders: Record<ProviderKey, QuoteProvider> = Object.fromEntries(
    Object.entries(adapters).map(([providerKey, inner]) => [
      providerKey,
      createDiscoveryProvider({ inner, providerKey, clock, breaker }),
    ]),
  );
  const discovery = createDiscovery(discoveryProviders);

  let scheduler: IngestionScheduler | null = null;
  let ingestSql: postgres.Sql | null = null;
  let ingestDb: Db | null = null;
  let workerProviders: Record<ProviderKey, QuoteProvider> | null = null;
  let started = false;
  /** Filled by `start()` in worker mode — see {@link MarketRuntime.registeredQueues}. */
  let registeredQueues: readonly string[] = [];
  /** SH-17 — filled by `start()` in worker mode; see {@link MarketRuntime.startupCatchUp}. */
  let startupCatchUp: StartupCatchUpResult | null = null;
  /** SH-35 — filled by every sweep in worker mode; see {@link MarketRuntime.lastOpsIndicatorSweep}. */
  let lastOpsIndicatorSweep: OpsIndicatorSweepResult | null = null;
  /** SH-35 — the sweep timer, armed by `start()` in worker mode and cleared by `stop()`. */
  let opsIndicatorTimer: NodeJS.Timeout | null = null;

  if (ingestionDatabaseUrl !== undefined) {
    // F-2 (security review): `createPostgresClient` with no `options`
    // defaults to `DB_POOL_MAX` (`platform/db/src/client.ts`, default 10) —
    // the *same* env var `api`'s own request pool already sizes itself from.
    // One API process would therefore hold the request pool (up to
    // `DB_POOL_MAX`, 10 by default) **plus** this ingest pool (another 10,
    // silently reusing the same default) **plus** pg-boss's own internal
    // `pg.Pool` (also defaulting to 10, below) — up to ~30 connections from
    // one process where the recorded T-3 pool-sizing analysis assumed 10
    // total. `max: 2` here is deliberately small: this pool serves only the
    // in-process worker's own sequential-by-instrument backfill/reconcile
    // work (never a per-request budget — no HTTP request ever touches this
    // pool directly), so it does not need anywhere near the request pool's
    // own headroom. New arithmetic for T-3 to re-derive from: one API
    // process now holds up to `DB_POOL_MAX` (request pool, unchanged) + 2
    // (this ingest pool) + 2 (pg-boss's own pool, below) connections — a
    // fixed, small, documented addition instead of an accidental second
    // `DB_POOL_MAX`-sized pool plus an unbounded third one.
    // SH-8: **producer mode never opens this pool.** The
    // ingest `Db` and `workerProviders` are reachable only from `start()`'s
    // `handlerDeps`, which producer mode has no branch for; `enqueueBackfill`
    // writes `instrument_backfill_state` through the *caller's* `db` (the
    // API's own `app_web` pool — why migration `0029` exists), and discovery
    // needs no database at all. So the skip is provable, not merely
    // configured, and "0 — not created in producer mode" is the literal
    // truth about this process.
    if (workerInProcess) {
      ingestSql = createPostgresClient(ingestionDatabaseUrl, { max: INGEST_POOL_MAX });
      ingestDb = createDb(ingestSql);
      const logFetch = createDbFetchLogger(ingestDb);

      workerProviders = Object.fromEntries(
        Object.entries(adapters).map(([providerKey, inner]) => [
          providerKey,
          createWorkerProvider({ inner, providerKey, clock, breaker, logFetch }),
        ]),
      );
    }

    // `createSchema: false` — migration `0031_pgboss-schema.sql`'s own doc
    // comment (IC-2, verified finding, Assumption A2): PostgreSQL's `CREATE
    // SCHEMA IF NOT EXISTS` checks database-level `CREATE` privilege before
    // it ever checks whether the schema already exists, so pg-boss's
    // default `createSchema: true` fails as `app_ingest` even though that
    // migration has already created and authorized the `pgboss` schema.
    // Skipping pg-boss's own `CREATE SCHEMA` statement entirely (this
    // option) is the fix — lighter than the alternative fallback of
    // starting once as `app_owner` with migrations disabled.
    // F-2 (security review): pg-boss's own internal `pg.Pool` also defaults
    // to `max: 10` when unset — an explicit small value here, alongside the
    // `ingestSql` pool above, is what keeps one API process's total
    // connection count small and documented rather than an accidental sum of
    // three independently-defaulted pools (see `ingestSql`'s own doc comment
    // for the full arithmetic).
    // SH-8: `supervise`/`schedule`/`migrate` are
    // pg-boss defaults-on, and this repo previously overrode only
    // `createSchema` — so before this change *both* an API and a worker
    // process would have run the cron timekeeper and the maintenance
    // supervisor against the same schema. Turning all three off in producer
    // mode is what makes FR-13 ("exactly one process owns the timekeeper")
    // structural. `migrate:false` on the producer is deliberate too: the
    // worker owns pg-boss's own schema migration, and compose orders
    // `api` after `worker: service_healthy` so the schema is already current
    // by the time the API connects (this is what stops U3 being
    // load-bearing).
    const boss = new PgBoss({
      connectionString: ingestionDatabaseUrl,
      createSchema: false,
      max: PGBOSS_POOL_MAX,
      supervise: workerInProcess,
      schedule: workerInProcess,
      migrate: workerInProcess,
    });
    boss.on("error", (err: unknown) => {
      // pg-boss's own background maintenance-loop errors (e.g. a transient
      // connection blip) — logged, never left to crash the process via an
      // unhandled `error` event on this `EventEmitter`.
      //
      // SH-38 (FR-32): this is one of the two named sites that migrated to
      // pino. The error is passed as an
      // allow-listed `error` *string*, never spread — pg-boss attaches its own
      // query state to some of these.
      rootLogger().error("pg-boss error", {
        component: "market-composition",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    scheduler = new IngestionScheduler({ boss });
  } else {
    // F-7 (security review): the pre-existing per-creation `console.info`
    // below only ever fires once a creation actually
    // happens, and only ever reaches whoever is tailing logs at that exact
    // moment — easy to miss entirely for a deployment where this is the
    // *default*, silent state: `INGESTION_DATABASE_URL` unset is both this
    // config's own documented default (see this file's own doc comment) and
    // what `scripts/dev-up.sh` produces, so "instrument history backfill is
    // simply never wired up" could otherwise go unnoticed indefinitely. One
    // `console.warn`, once, at construction time (this function only runs
    // once per process, `api/src/main.ts`'s own doc comment) — loud enough to
    // show up in a deploy's own startup logs, and plain about which env var
    // enables the feature.
    // SH-38: the second named pino site — `market-runtime.ts`'s warnings.
    rootLogger().warn(
      "createMarketRuntime: INGESTION_DATABASE_URL is not set — instrument history backfill is " +
        "disabled for this process (every instrument creation will succeed with no automated " +
        "price-history fetch). Set INGESTION_DATABASE_URL to enable it.",
      { component: "market-composition" },
    );
  }

  async function enqueueBackfill(db: Db, params: EnsureInstrumentBackfillParams): Promise<void> {
    if (scheduler === null) {
      // Logged once per creation, never surfaced to the
      // user — creation still succeeds and simply requests no backfill.
      rootLogger().info(
        "enqueueBackfill: INGESTION_DATABASE_URL is not configured — the instrument was created " +
          "with no automated history backfill requested.",
        { component: "market-composition", instrument_id: params.instrumentId },
      );
      return;
    }
    await ensureInstrumentBackfillRequested(db, scheduler, clock, params);
  }

  /**
   * See {@link MarketRuntime.requestBackfillReload}.
   *
   * **Throws, never logs-and-swallows, when `scheduler === null`.** This is the
   * one deliberate difference from `enqueueBackfill` above: that one backs a
   * best-effort side effect of a creation that must still succeed; this one
   * backs a user's explicit request, and a silent no-op would mean a `202` for
   * a reload nothing will ever perform (FR-184 requires a `503` instead).
   *
   * **This branch is unreachable in production**: `instrument-history-reload
   * .controller.ts` checks `marketRuntime === null`, `scheduler === null` and
   * `requestBackfillReload === undefined` *before* calling, and returns
   * `503 MARKET_DATA_NOT_CONFIGURED`. The throw exists so a future caller that
   * forgets the check fails loudly rather than reporting a fake success.
   */
  async function requestBackfillReload(
    db: Db,
    params: ForceInstrumentBackfillReloadParams,
  ): Promise<ForceInstrumentBackfillReloadResult> {
    if (scheduler === null) {
      throw new Error(
        "requestBackfillReload: INGESTION_DATABASE_URL is not configured — no reload can be " +
          "enqueued. The caller must check `scheduler` first and return 503 " +
          "MARKET_DATA_NOT_CONFIGURED (FR-184); reaching here is a caller bug.",
      );
    }
    return forceInstrumentBackfillReload(db, scheduler, clock, params);
  }

  /**
   * SH-35 — one ops-indicator sweep, on demand.
   *
   * `null` in producer mode (no ingest pool, and the conditions are the
   * worker's to observe) and when the sweep is switched off. The breaker handed
   * over is **this process's** instance, which after the producer/worker split
   * is the worker's own and not the API's — accepted for
   * phase 1 (SH-37) and made observable precisely by publishing it here.
   */
  async function sweepOpsIndicators(): Promise<OpsIndicatorSweepResult | null> {
    if (ingestDb === null || !resolveOpsIndicatorSweep(config)) return null;
    const result = await runOpsIndicatorSweep({
      db: ingestDb,
      clock,
      breaker,
      ...(config.opsIndicatorError === undefined ? {} : { error: config.opsIndicatorError }),
    });
    lastOpsIndicatorSweep = result;
    return result;
  }

  async function start(): Promise<void> {
    if (started || scheduler === null) return;
    started = true;

    // Creates every standing queue, including `HISTORY_BACKFILL_RECONCILE_QUEUE`
    // (`market/ingestion`'s `scheduler.ts`, IC-6).
    await scheduler.start();

    if (!workerInProcess) return;

    // SH-11/SH-12: every worker-owned handler and schedule lives in
    // `worker-registrations.ts` — this is the handler-registration
    // branch, the one producer mode structurally does not have. The
    // worker entrypoint awaits this call before writing its readiness
    // marker, so the marker means every registration below completed.
    registeredQueues = await registerWorkerQueues({
      scheduler,
      db: ingestDb!,
      clock,
      workerProviders: workerProviders!,
      // The composition root is the only package allowed to name a concrete
      // adapter — so the ECB instance is constructed here and
      // handed to the consumer as a port, never imported by the handler.
      //
      // **Deliberately a bare port — never `createWorkerProvider` (decided
      // 2026-08-24).** ECB is a single well-behaved public
      // endpoint on a twice-daily schedule, not the many-symbol per-request
      // fan-out the breaker and token bucket exist to bound. Consequences,
      // accepted: the `circuitBreaker` ops indicator can never fire for an ECB
      // outage, and no `provider_fetch_log` diagnostic covers FX — staleness
      // detection still works (`ingestionStaleness` reads
      // `max(fx_rate_daily.rate_date)`); what is lost is outage
      // *attribution*. Revisit trigger: if FX outage attribution is ever
      // wanted, wrapping is the answer and this exemption is the thing to
      // remove — restore an `ecb` entry to `DEFAULT_PROVIDER_RATE_LIMITS`
      // with it. Pinned by the SH-14 fetch-log assertion in
      // `market-data-queues.integration.test.ts` and the registry test in
      // `rate-limits.test.ts`.
      fxProvider: config.fxProviderOverride ?? new EcbFxRateProvider(),
    });

    if (!resolveCatchUpOnStart(config)) {
      armOpsIndicatorSweep();
      return;
    }

    // SH-17: strictly after every registration — the
    // catch-up enqueues onto queues that must already have consumers — and
    // strictly before `worker-main.ts` writes the readiness marker.
    //
    // **A failed catch-up is logged, not thrown.** Letting it propagate would
    // leave the marker unwritten, which in compose means `api` never starts at
    // all (`depends_on: worker: service_healthy`) — a whole-stack outage
    // traded for a missed-tick optimisation whose own next cron fire heals it.
    // Every *other* step in `start()` still fails loudly, because an unowned
    // queue is not self-healing.
    try {
      startupCatchUp = await runStartupCatchUp({
        db: ingestDb!,
        clock,
        scheduler,
      });
    } catch (error) {
      rootLogger().error(
        "startup catch-up failed — the worker is otherwise fully registered; any missed " +
          "eod-close/fx-daily tick will be picked up by that job's next scheduled run.",
        {
          component: "market-composition",
          error: error instanceof Error ? error.message : String(error),
        },
      );
      startupCatchUp = null;
    }

    armOpsIndicatorSweep();
  }

  /**
   * SH-35 — arms the sweep timer, after every registration and after the
   * catch-up, and runs one sweep immediately so `/health` reports real values
   * within seconds of the worker becoming ready rather than after the first
   * interval elapses.
   *
   * **A failed sweep is logged, not thrown**, for exactly the reason a failed
   * catch-up is (`start()` above): this runs inside the boot path the readiness
   * marker gates, and an alerting pass that cannot reach the database must not
   * be able to keep the whole stack from starting. `unref()` so the timer never
   * by itself holds the process open — the drain, not the timer, decides when
   * the worker exits.
   */
  function armOpsIndicatorSweep(): void {
    if (ingestDb === null || !resolveOpsIndicatorSweep(config)) return;
    const runOnce = (): void => {
      void sweepOpsIndicators().catch((error: unknown) => {
        rootLogger().error(
          "ops-indicator sweep failed — the previously published values stand until the next " +
            "pass; /health continues to report them with their own observed_at.",
          {
            component: "market-composition",
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    };
    runOnce();
    opsIndicatorTimer = setInterval(runOnce, OPS_INDICATOR_SWEEP_INTERVAL_MS);
    opsIndicatorTimer.unref();
  }

  async function stop(options?: IngestionSchedulerStopOptions): Promise<void> {
    if (scheduler === null || !started) return;
    started = false;
    // SH-35: before the pool is drained, not after — a sweep that fired into a
    // closed pool would log a failure that says nothing about the deployment.
    if (opsIndicatorTimer !== null) {
      clearInterval(opsIndicatorTimer);
      opsIndicatorTimer = null;
    }
    await scheduler.stop(options);
    await ingestSql?.end({ timeout: 5 });
  }

  return {
    discovery,
    mode,
    connectionCeilings,
    get registeredQueues(): readonly string[] {
      return registeredQueues;
    },
    get startupCatchUp(): StartupCatchUpResult | null {
      return startupCatchUp;
    },
    get lastOpsIndicatorSweep(): OpsIndicatorSweepResult | null {
      return lastOpsIndicatorSweep;
    },
    sweepOpsIndicators,
    scheduler,
    enqueueBackfill,
    requestBackfillReload,
    start,
    stop,
  };
}
