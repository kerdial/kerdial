import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { rootLogger } from "@kerdial/platform-logging";
import {
  createMarketRuntime,
  type CreateMarketRuntimeConfig,
  type MarketRuntime,
} from "./market-runtime.js";

/**
 * SH-9 — the **worker** entrypoint.
 *
 * It lives here, not in a new top-level package or in `api`, for these
 * reasons: `market/composition` is already the only package permitted to
 * import `market/adapters`, already owns the pg-boss instance and the ingest
 * pool, and is already inside `package.json`'s `depcruise` target list — a new
 * top-level directory would silently not be cruised, a gate failure this repo
 * has recorded twice. Putting it in `api/src` would drag `@nestjs/*` into the
 * worker's dependency graph for nothing.
 *
 * Three properties this module exists to make true:
 *
 *  1. **Explicit graceful stop at this call site**. `runtime.stop` is
 *     called with `{ graceful: true, timeoutSeconds: 25 }` **here**;
 *     `IngestionScheduler.stop()`'s own `graceful: false` default is
 *     deliberately left alone, so no other caller's shutdown semantics change.
 *     The trap underneath it is compose's, not this file's: a 25 s drain
 *     inside compose's default 10 s `stop_grace_period` is completely inert,
 *     which is why `stop_grace_period: 40s` is a required part of the worker
 *     service definition rather than a nicety.
 *  2. **Its own signal handlers**. Compose also sets `init: true`;
 *     neither is load-bearing alone, and both are deliberate.
 *  3. **The readiness marker is withheld until every registration completes**
 *     This is half of the handler-ownership invariant: `api` waits on
 *     `worker: service_healthy`, so there is no window in which the API is
 *     serving while the worker is only half-registered — and none in which
 *     neither process owns a queue.
 *
 * SH-17's missed-tick catch-up runs inside `runtime.start()`, after
 * every registration and therefore before the marker below — deliberately
 * so. It is the one step whose failure is logged rather than propagated;
 * `market-runtime.ts`'s `start()` records why.
 */

/** The explicit drain timeout. Compose must pair it with a `stop_grace_period` **above** it, or the drain never happens. */
export const WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS = 25;

/** The compose healthcheck's target: `test -f /run/worker/ready`. */
export const DEFAULT_WORKER_READY_FILE = "/run/worker/ready";

/** Signals a container runtime actually sends. SIGTERM is compose's stop signal; SIGINT is what an interactive `docker compose up` sends. */
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

export interface StartWorkerOptions {
  /** Test seam — defaults to the real {@link createMarketRuntime}. */
  readonly createRuntime?: (config: CreateMarketRuntimeConfig) => MarketRuntime;
  /** Overrides `WORKER_READY_FILE`/{@link DEFAULT_WORKER_READY_FILE}. */
  readonly readyFilePath?: string;
  /** Overrides {@link DEFAULT_SIGNALS}; pass `[]` to register none (a test that drives `stop()` directly). */
  readonly signals?: readonly NodeJS.Signals[];
  /** Defaults to SH-38's structured INFO line — the worker has no HTTP surface, so its lifecycle is only ever visible in logs. */
  readonly log?: (message: string) => void;
}

export interface WorkerHandle {
  readonly runtime: MarketRuntime;
  /** The path the readiness marker was written to — the file `api`'s `depends_on` healthcheck tests for. */
  readonly readyFilePath: string;
  /** Idempotent: removes the marker, then drains. Safe to call from two signals arriving in quick succession. */
  stop(reason: string): Promise<void>;
}

function resolveReadyFilePath(options: StartWorkerOptions): string {
  if (options.readyFilePath !== undefined) return options.readyFilePath;
  const fromEnv = process.env["WORKER_READY_FILE"];
  return fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : DEFAULT_WORKER_READY_FILE;
}

/**
 * Boots the worker: runtime → `start()` (every `boss.work()` registration and
 * every `boss.schedule()` upsert) → **only then** the readiness marker.
 *
 * A failure anywhere before that last step propagates with **no marker
 * written**, which is the whole point: compose's `api` never starts against a
 * worker that did not finish registering.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const log =
    options.log ??
    ((message: string) => {
      rootLogger().info(message, { component: "worker" });
    });
  const readyFilePath = resolveReadyFilePath(options);

  if (
    process.env["INGESTION_DATABASE_URL"] === undefined ||
    process.env["INGESTION_DATABASE_URL"].trim() === ""
  ) {
    throw new Error(
      "worker-main: INGESTION_DATABASE_URL is required — a worker with no queue connection has nothing to do, " +
        "and starting one anyway would leave every queue unowned while looking healthy.",
    );
  }

  const createRuntime = options.createRuntime ?? createMarketRuntime;
  // `requestPoolCeiling: 0` is not a tuning knob — the worker serves no HTTP
  // requests and opens no request pool, so counting `DB_POOL_MAX` against its
  // P2 budget would budget for a pool that does not exist.
  const runtime = createRuntime({ workerInProcess: true, requestPoolCeiling: 0 });

  await runtime.start();

  await mkdir(dirname(readyFilePath), { recursive: true });
  await writeFile(readyFilePath, `${process.pid}\n`, "utf8");
  log(`[worker] ready — every queue registered, marker written to ${readyFilePath}`);

  let stopping: Promise<void> | null = null;
  async function stop(reason: string): Promise<void> {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      log(`[worker] ${reason} — draining (graceful, ${WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS}s)`);
      // Marker first: from this instant the worker is no longer ready, and a
      // healthcheck says so *while* the drain runs rather than after it.
      await rm(readyFilePath, { force: true });
      await runtime.stop({
        graceful: true,
        timeoutSeconds: WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS,
      });
      log("[worker] drained");
    })();
    return stopping;
  }

  for (const signal of options.signals ?? DEFAULT_SIGNALS) {
    process.once(signal, () => {
      void stop(`received ${signal}`).catch((error: unknown) => {
        rootLogger().error("shutdown failed", {
          component: "worker",
          error: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
      });
    });
  }

  return { runtime, readyFilePath, stop };
}

/**
 * The process entrypoint proper. Kept separate from {@link startWorker} so a
 * test can drive the boot/drain sequence in-process, and so importing this
 * module never starts a worker as a side effect.
 */
export async function workerMain(): Promise<void> {
  await startWorker();
}

// Runs only when this module *is* the process entrypoint (`node
// dist/worker-main.js`, the image's `worker` role command) — never when a
// test or another module imports it, which is what keeps `startWorker`
// drivable in-process without a worker booting as an import side effect.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  workerMain().catch((error: unknown) => {
    rootLogger().error("failed to start", {
      component: "worker",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
