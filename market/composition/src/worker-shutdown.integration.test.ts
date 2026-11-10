import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MigratedPostgres,
  startMigratedPostgres,
  waitUntil,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import { QUOTE_REFRESH_QUEUE } from "@kerdial/market-ingestion";
import {
  holdingState,
  instrument,
  instrumentProviderMap,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMarketRuntime, type MarketRuntime } from "./market-runtime.js";

/**
 * **AC-11 and the graceful-drain check, at the strongest level in-process
 * testing permits** (originally the SH-16/GATE-3 verification suite).
 *
 * AC-11: "Sending SIGTERM to the worker process while a job batch is actively
 * executing results in the in-flight job completing ... before the process
 * exits — never an abandoned 'active' row left inconsistent by an abrupt
 * kill."
 *
 * The pre-existing `worker-main.signal.integration.test.ts` sends a real
 * SIGTERM to a real process, but its runtime is a **stub whose `stop()` is a
 * `setTimeout`** — no pg-boss, no job, no `pgboss.job` row. It therefore
 * proves the *options at the call site* and nothing about whether an in-flight
 * job survives. This file supplies the missing half: a real pg-boss worker, a
 * real `quote-refresh` job whose handler is provably still inside its provider
 * call, and the job's own `pgboss.job.state` read afterwards.
 *
 * **What remains unverified at this commit, stated rather than simulated.**
 * The check's other half is a *container* property: "`stop_grace_period` really
 * exceeds the graceful timeout", plus the deliberate run at Docker's 10 s
 * default to reproduce the inert drain. The image and the compose
 * file do not exist yet, so there is no container to signal and no
 * `stop_grace_period` to set. Nothing here simulates one. The second test
 * below reproduces the *failure mode* a too-short grace period produces —
 * SIGTERM followed by a SIGKILL before the drain can finish — at the process
 * level, which is what makes the first test's "completed" assertion
 * non-vacuous; it is **not** evidence about compose.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "__fixtures__", "worker-shutdown-fixture.mts");
const repoRoot = join(here, "..", "..", "..");

/** What `spawn(..., { stdio: ["ignore", "pipe", "pipe"] })` actually returns: no stdin, both readable. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

interface WorkerProcess {
  readonly child: PipedChild;
  /** Resolves when the fixture prints `READY` — i.e. every queue is registered and the marker is on disk. */
  ready(): Promise<void>;
  /** Resolves when the fixture prints `token`. */
  awaitStdout(token: string, timeoutMs: number): Promise<void>;
  stdout(): string;
  signal(name: NodeJS.Signals): void;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>;
}

describe("SH-16 GATE-3 — graceful shutdown with a genuinely in-flight job (AC-11)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appIngestUrl: string;
  let tmpRoot: string;
  let seq = 0;

  const tenantId = "00000000-0000-7000-8000-00000016b001";
  const portfolioId = "00000000-0000-7000-8000-00000016b002";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appIngestUrl = pg.appIngestUri;

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: "SH-16 shutdown" });
    tmpRoot = await mkdtemp(join(tmpdir(), "sh16-shutdown-"));
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
    if (tmpRoot !== undefined) await rm(tmpRoot, { recursive: true, force: true });
  }, 60_000);

  const producers: MarketRuntime[] = [];
  const spawned: PipedChild[] = [];

  afterEach(async () => {
    while (producers.length > 0) {
      const runtime = producers.pop()!;
      const boss = runtime.scheduler?.boss;
      const stopped =
        boss === undefined
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              boss.once("stopped", () => resolve());
            });
      await runtime.stop({ graceful: false });
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    while (spawned.length > 0) {
      const child = spawned.pop()!;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  function spawnWorker(fetchDelayMs: number): WorkerProcess {
    seq += 1;
    const readyFilePath = join(tmpRoot, `run-${seq}`, "worker", "ready");
    // `node --import tsx`, not `npx tsx`: a wrapper process in between would
    // swallow the SIGTERM this test is about.
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: repoRoot,
      env: {
        ...process.env,
        INGESTION_DATABASE_URL: appIngestUrl,
        WORKER_READY_FILE: readyFilePath,
        SH16_FETCH_DELAY_MS: String(fetchDelayMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(child);

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });

    let signalledAt = 0;
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      elapsedMs: number;
    }>((resolve) => {
      child.on("close", (code, signal) => {
        resolve({
          code,
          signal,
          elapsedMs: signalledAt === 0 ? -1 : Date.now() - signalledAt,
        });
      });
    });

    async function awaitStdout(token: string, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (out.includes(token)) return;
        if (child.exitCode !== null) {
          throw new Error(`worker exited before printing ${token}:\n${out}\n${err}`);
        }
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          throw new Error(`worker never printed ${token}:\n${out}\n${err}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    return {
      child,
      ready: () => awaitStdout("READY ", 90_000),
      awaitStdout,
      stdout: () => out,
      signal: (name) => {
        if (signalledAt === 0) signalledAt = Date.now();
        child.kill(name);
      },
      exited: () => exited,
    };
  }

  /** A producer-mode runtime — the only thing this test uses to *send* the job; it consumes nothing. */
  async function producer(): Promise<MarketRuntime> {
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: appIngestUrl,
      workerInProcess: false,
    });
    producers.push(runtime);
    await runtime.start();
    return runtime;
  }

  async function seedHeldShare(): Promise<string> {
    seq += 1;
    const id = `bbbbbbbb-1600-7000-8000-0000000000${String(seq).padStart(2, "0")}`;
    const symbol = `SD${String(seq).padStart(4, "0")}`;
    await ownerDb.insert(instrument).values({
      id,
      kind: "SHARE",
      displayName: `SH-16 shutdown ${seq}`,
      listingCurrency: "EUR",
      symbol,
      exchangeMic: "XPAR",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId: id,
      providerKey: YAHOO_PROVIDER_KEY,
      providerSymbol: symbol,
      confidence: "CONFIRMED",
    });
    await ownerDb.insert(holdingState).values({
      tenantId,
      portfolioId,
      instrumentId: id,
      quantity: new Decimal("3"),
      costBasisBase: new Decimal("300"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("300"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
    return id;
  }

  async function jobState(jobId: string): Promise<string | undefined> {
    const [row] = await ownerClient<{ state: string }[]>`
      SELECT state::text FROM pgboss.job WHERE id = ${jobId}`;
    return row?.state;
  }

  async function quoteRow(instrumentId: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentQuoteLatest)
      .where(eq(instrumentQuoteLatest.instrumentId, instrumentId));
    return row;
  }

  it("AC-11: SIGTERM mid-job — the in-flight job finishes, its write lands, and the process exits 0 only afterwards", async () => {
    const fetchDelayMs = 8_000;
    const instrumentId = await seedHeldShare();

    const worker = spawnWorker(fetchDelayMs);
    await worker.ready();

    const sender = await producer();
    const jobId = await sender.scheduler!.enqueueQuoteRefresh({
      instrumentId,
      bucket: "sh16-shutdown",
    });
    expect(jobId).not.toBeNull();

    // Not "the job exists" — the handler is provably *inside* the provider
    // call. Anything less and SIGTERM might arrive before pg-boss ever
    // fetched the job, which proves nothing about draining.
    await worker.awaitStdout("FETCH_STARTED", 60_000);
    expect(await jobState(jobId!)).toBe("active");
    const fetchStartedAt = Date.now();

    // A real signal to a real process, roughly a second into an eight-second
    // handler — so ~7 s of work is still outstanding when the drain begins.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    worker.signal("SIGTERM");

    const result = await worker.exited();

    // Exited by its own hand, not by the signal's default disposition.
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);

    // It genuinely waited: the remaining ~7 s of handler time elapsed between
    // the signal and the exit. A `graceful: false` stop returns in
    // milliseconds.
    const outstandingMs = fetchDelayMs - (Date.now() - fetchStartedAt);
    expect(result.elapsedMs).toBeGreaterThan(fetchDelayMs / 2);
    expect(outstandingMs).toBeLessThan(fetchDelayMs);

    // The handler ran to completion *after* the signal.
    expect(worker.stdout()).toContain("FETCH_DONE");
    expect(worker.stdout()).toContain("[worker] drained");

    // AC-11's actual subject: the job, not the process.
    expect(await jobState(jobId!)).toBe("completed");
    // And the effect of that in-flight job is on disk, not lost.
    const row = await quoteRow(instrumentId);
    expect(row).toBeDefined();
    expect(row!.price.toString()).toBe("13.37");
  }, 240_000);

  it("the same job is abandoned 'active' when the drain is cut short — the failure mode a too-short grace period produces", async () => {
    // NOT a container and NOT `stop_grace_period`: this is a process-level
    // reproduction of the *shape* of that failure, and it is what makes the
    // test above non-vacuous — the "completed" assertion there can be seen to
    // go the other way when the drain is not allowed to finish.
    const fetchDelayMs = 20_000;
    const instrumentId = await seedHeldShare();

    const worker = spawnWorker(fetchDelayMs);
    await worker.ready();

    const sender = await producer();
    const jobId = await sender.scheduler!.enqueueQuoteRefresh({
      instrumentId,
      bucket: "sh16-shutdown-kill",
    });
    expect(jobId).not.toBeNull();

    await worker.awaitStdout("FETCH_STARTED", 60_000);
    expect(await jobState(jobId!)).toBe("active");

    worker.signal("SIGTERM");
    // A grace period far shorter than the outstanding work, exactly as
    // compose's 10 s default would be against a 25 s drain.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    worker.signal("SIGKILL");

    const result = await worker.exited();
    expect(result.signal).toBe("SIGKILL");
    expect(worker.stdout()).not.toContain("FETCH_DONE");

    // The row AC-11 names in so many words: left `active`, its work lost.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await jobState(jobId!)).toBe("active");
    expect(await quoteRow(instrumentId)).toBeUndefined();

    // It is not merely slow to land: nothing is ever going to write it,
    // because the process that held the job no longer exists.
    expect(await waitUntil(async () => (await quoteRow(instrumentId)) !== undefined, 5_000)).toBe(
      false,
    );
  }, 240_000);

  it("a drained worker leaves nothing of its own stuck: every job it touched in that run is terminal", async () => {
    // Scoped to jobs created after this point: the preceding test
    // deliberately abandons one, and this suite shares one database.
    const [nowRow] = await ownerClient<{ now: Date }[]>`SELECT now() AS now`;
    const since = nowRow!.now;

    const instrumentId = await seedHeldShare();
    const worker = spawnWorker(3_000);
    await worker.ready();

    const sender = await producer();
    const jobId = await sender.scheduler!.enqueueQuoteRefresh({
      instrumentId,
      bucket: "sh16-shutdown-clean",
    });
    await worker.awaitStdout("FETCH_STARTED", 60_000);
    worker.signal("SIGTERM");
    await worker.exited();

    expect(await jobState(jobId!)).toBe("completed");
    const stuck = await ownerClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pgboss.job
      WHERE name = ${QUOTE_REFRESH_QUEUE} AND state = 'active' AND created_on > ${since}`;
    expect(stuck[0]?.count).toBe("0");
  }, 240_000);
});
