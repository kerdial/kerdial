import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateMarketRuntimeConfig, MarketRuntime } from "./market-runtime.js";
import {
  DEFAULT_WORKER_READY_FILE,
  WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS,
  startWorker,
} from "./worker-main.js";

/**
 * SH-9 — the worker entrypoint's boot/drain
 * contract, driven in-process against a stub runtime. The *real-process*
 * halves (an actual `SIGTERM` to an actual child process) live in
 * `worker-main.signal.integration.test.ts`; this file pins the ordering
 * properties, which a signal test cannot observe as precisely.
 */

interface StubRuntime extends MarketRuntime {
  readonly events: string[];
  readonly stopCalls: ({ graceful?: boolean; timeoutSeconds?: number } | undefined)[];
  readonly configs: CreateMarketRuntimeConfig[];
}

function stubRuntime(options?: {
  startFails?: Error;
  onStart?: () => void | Promise<void>;
  stopDelayMs?: number;
}): StubRuntime {
  const events: string[] = [];
  const stopCalls: ({ graceful?: boolean; timeoutSeconds?: number } | undefined)[] = [];
  const configs: CreateMarketRuntimeConfig[] = [];
  return {
    events,
    stopCalls,
    configs,
    mode: "worker",
    discovery: { search: async () => [] } as unknown as MarketRuntime["discovery"],
    scheduler: null,
    enqueueBackfill: async () => {},
    async start() {
      events.push("start");
      await options?.onStart?.();
      if (options?.startFails) throw options.startFails;
    },
    async stop(stopOptions) {
      events.push("stop");
      stopCalls.push(stopOptions);
      if (options?.stopDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.stopDelayMs));
      }
    },
  };
}

describe("startWorker (SH-9)", () => {
  let dir: string;
  let readyFilePath: string;
  const savedUrl = process.env["INGESTION_DATABASE_URL"];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sh9-worker-"));
    // A nested path on purpose: the real marker lives at `/run/worker/ready`,
    // whose directory the container does not necessarily pre-create.
    readyFilePath = join(dir, "run", "worker", "ready");
    process.env["INGESTION_DATABASE_URL"] = "postgres://app_ingest:pass@127.0.0.1:5432/nonexistent";
  });

  afterEach(async () => {
    if (savedUrl === undefined) delete process.env["INGESTION_DATABASE_URL"];
    else process.env["INGESTION_DATABASE_URL"] = savedUrl;
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the readiness marker only after start() has fully resolved", async () => {
    let markerExistedDuringStart = true;
    const runtime = stubRuntime({
      onStart: async () => {
        markerExistedDuringStart = await stat(readyFilePath).then(
          () => true,
          () => false,
        );
      },
    });

    const handle = await startWorker({
      createRuntime: (config) => {
        runtime.configs.push(config);
        return runtime;
      },
      readyFilePath,
      signals: [],
      log: () => {},
    });

    // `api` waits on the worker's health, so a marker written before
    // every registration completed would open exactly the window where the
    // API is serving against a half-registered worker.
    expect(markerExistedDuringStart).toBe(false);
    expect(await readFile(handle.readyFilePath, "utf8")).toBe(`${process.pid}\n`);
    expect(runtime.events).toEqual(["start"]);
  });

  it("writes no marker at all when start() fails — a half-registered worker never looks healthy", async () => {
    const runtime = stubRuntime({ startFails: new Error("queue registration failed") });

    await expect(
      startWorker({
        createRuntime: () => runtime,
        readyFilePath,
        signals: [],
        log: () => {},
      }),
    ).rejects.toThrow("queue registration failed");

    await expect(stat(readyFilePath)).rejects.toThrow();
  });

  it("stop() passes the explicit graceful options at this call site", async () => {
    const runtime = stubRuntime();
    const handle = await startWorker({
      createRuntime: () => runtime,
      readyFilePath,
      signals: [],
      log: () => {},
    });

    await handle.stop("test");

    expect(runtime.stopCalls).toEqual([
      { graceful: true, timeoutSeconds: WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS },
    ]);
    expect(WORKER_GRACEFUL_STOP_TIMEOUT_SECONDS).toBe(25);
  });

  it("removes the marker before the drain begins, not after it ends", async () => {
    let markerExistedDuringDrain = true;
    const runtime = stubRuntime({ stopDelayMs: 50 });
    const handle = await startWorker({
      createRuntime: () => runtime,
      readyFilePath,
      signals: [],
      log: () => {},
    });

    const stopping = handle.stop("test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    markerExistedDuringDrain = await stat(readyFilePath).then(
      () => true,
      () => false,
    );
    await stopping;

    // A healthcheck must report "not ready" *while* the 25 s drain runs, not
    // only once it has finished.
    expect(markerExistedDuringDrain).toBe(false);
  });

  it("stop() is idempotent — two signals in quick succession drain once", async () => {
    const runtime = stubRuntime({ stopDelayMs: 30 });
    const handle = await startWorker({
      createRuntime: () => runtime,
      readyFilePath,
      signals: [],
      log: () => {},
    });

    await Promise.all([handle.stop("first"), handle.stop("second")]);

    expect(runtime.stopCalls).toHaveLength(1);
  });

  it("builds its runtime in worker mode with no request-pool budget of its own", async () => {
    const runtime = stubRuntime();
    await startWorker({
      createRuntime: (config) => {
        runtime.configs.push(config);
        return runtime;
      },
      readyFilePath,
      signals: [],
      log: () => {},
    });

    // The worker serves no HTTP requests and opens no request pool, so
    // counting `DB_POOL_MAX` against its P2 budget would budget for a pool
    // that does not exist.
    expect(runtime.configs).toEqual([{ workerInProcess: true, requestPoolCeiling: 0 }]);
  });

  it("refuses to start with no INGESTION_DATABASE_URL rather than looking healthy with nothing to do", async () => {
    delete process.env["INGESTION_DATABASE_URL"];
    const runtime = stubRuntime();

    await expect(
      startWorker({
        createRuntime: () => runtime,
        readyFilePath,
        signals: [],
        log: () => {},
      }),
    ).rejects.toThrow(/INGESTION_DATABASE_URL is required/);

    expect(runtime.events).toEqual([]);
    await expect(stat(readyFilePath)).rejects.toThrow();
  });

  it("defaults the marker path to the one the compose healthcheck tests for", () => {
    expect(DEFAULT_WORKER_READY_FILE).toBe("/run/worker/ready");
  });
});
