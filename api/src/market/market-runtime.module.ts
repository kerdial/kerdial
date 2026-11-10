import {
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { MarketRuntime } from "@kerdial/market-composition";
import { rootLogger } from "@kerdial/platform-logging";
import { MARKET_RUNTIME } from "./market-runtime.tokens.js";

/**
 * DD3 — registers the
 * `runtime | null` `main.ts` (production) or a test harness (Testcontainers
 * suites) constructs, as a **value** provider: `{ provide: MARKET_RUNTIME,
 * useValue: runtime }`. Deliberately a value, not a class resolved through
 * Nest DI — `@UseInterceptors(ClassRef)`'s per-host-module resolution hazard
 * (first found for `transactions/write-throttle.interceptor.ts`; see
 * `concurrency-throttle.interceptor.ts`'s header for the full mechanism) is
 * specific to interceptors looked up via `getInstanceByMetatype`, but this
 * module sidesteps the
 * question entirely by never asking Nest to construct a `MarketRuntime` at
 * all: every consumer (`InstrumentsController`, IC-9) receives the exact
 * same object via ordinary constructor injection against this token, and
 * `global: true` (mirroring `DbModule`/`CsrfSecretModule`) means every
 * present and future feature module can `@Inject(MARKET_RUNTIME)` it
 * without re-importing this module.
 *
 * Implements the two lifecycle hooks DD3 calls for:
 * - `OnApplicationBootstrap` — awaits `runtime.start()`, which registers the
 *   `boss.work()` handler(s) (`market/composition`'s `MarketRuntime.start`).
 *   Nest's own `NestApplicationContext.init()` runs every module's
 *   `onModuleInit` to completion (`callInitHook()`) *before* running any
 *   module's `onApplicationBootstrap` (`callBootstrapHook()`) — so this
 *   always fires strictly after every other module has finished
 *   initialising, never mid-initialisation, with no additional ordering
 *   code needed here.
 * - `OnApplicationShutdown` — awaits `runtime.stop({ graceful: true })`, a
 *   graceful drain (an in-flight backfill chunk finishes or is cleanly
 *   released, never abandoned mid-write — `market/composition`'s IC-6
 *   graceful-stop behaviour). Fires on `app.close()` regardless of whether
 *   `enableShutdownHooks()` was called (`NestApplicationContext.close()`
 *   always calls `callShutdownHook`); `enableShutdownHooks()` (`main.ts`)
 *   only additionally wires process signals (SIGTERM etc.) to call
 *   `close()` in the first place.
 *
 * Both hooks are documented no-ops when `runtime` is `null`
 * (`INGESTION_DATABASE_URL` unset, DD4) — `runtime?.start()`/
 * `runtime?.stop()` below.
 */
@Module({})
export class MarketRuntimeModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(MARKET_RUNTIME) private readonly runtime: MarketRuntime | null) {}

  /**
   * SH-10 (FR-9/FR-12) — the API half of the
   * handler-ownership invariant, checked rather than assumed.
   *
   * Compose sets `WORKER_IN_PROCESS: "false"` on `api` explicitly, and
   * `createMarketRuntime` turns that into producer mode: no ingest pool, no
   * handler-registration branch, and pg-boss constructed with
   * `supervise/schedule/migrate` off. The failure this guard catches is the
   * one that configuration alone cannot: a runtime built **elsewhere** (a
   * different code path, a stale wiring, a copy-pasted test harness) and
   * handed to the API in worker mode while the deployment believes the
   * standalone worker owns every queue. Both processes would then register
   * the same handlers and both would run the cron timekeeper — precisely
   * what FR-13 forbids, and silent at runtime.
   *
   * A `MarketRuntime` with no `mode` at all is a hand-written fake (the field
   * is additive-optional); those register nothing either way, so they are
   * exempt rather than rejected.
   */
  private static assertModeMatchesEnv(runtime: MarketRuntime | null): void {
    if (runtime?.mode !== "worker") return;
    if (process.env["WORKER_IN_PROCESS"] !== "false") return;
    throw new Error(
      "MarketRuntimeModule: WORKER_IN_PROCESS=false, but the MarketRuntime handed to the API was built in " +
        "worker mode. The API would register queue handlers and run pg-boss's cron timekeeper alongside the " +
        "standalone worker (FR-13 — exactly one process may own each). Build the API's runtime " +
        "with `createMarketRuntime()` in the same process env, or pass `workerInProcess: false` explicitly.",
    );
  }

  static forRoot(runtime: MarketRuntime | null): DynamicModule {
    MarketRuntimeModule.assertModeMatchesEnv(runtime);
    return {
      module: MarketRuntimeModule,
      global: true,
      providers: [{ provide: MARKET_RUNTIME, useValue: runtime }],
      exports: [MARKET_RUNTIME],
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.runtime?.mode !== undefined) {
      // SH-10: the deployed API's mode is otherwise invisible — nothing in an
      // HTTP response says whether this process is also consuming queues.
      // One line at boot, in the same startup log the operator already reads.
      rootLogger().info(
        `market runtime started in ${this.runtime.mode} mode ` +
          `(handlers registered here: ${this.runtime.mode === "worker" ? "yes" : "no"})`,
        { component: "api" },
      );
    }
    await this.runtime?.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop({ graceful: true });
  }
}
