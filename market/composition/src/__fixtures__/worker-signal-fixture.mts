/**
 * SH-9 fixture — a **real process** that boots the real `startWorker` and is
 * then sent a real `SIGTERM` by
 * `../worker-main.signal.integration.test.ts`.
 *
 * The runtime is a stub, deliberately: what is under test is the entrypoint's
 * own signal handling and the options it passes at its own call site,
 * not pg-boss's drain. The stub's `stop` takes
 * `STOP_DELAY_MS` to simulate a job in flight, and reports what it was called
 * with on stdout — so the parent observes the passed options, never the
 * source text.
 */
import { startWorker } from "../worker-main.js";
import type { MarketRuntime } from "../market-runtime.js";

const STOP_DELAY_MS = Number(process.env["FIXTURE_STOP_DELAY_MS"] ?? "800");

const runtime: MarketRuntime = {
  mode: "worker",
  discovery: { search: async () => [] } as unknown as MarketRuntime["discovery"],
  scheduler: null,
  enqueueBackfill: async () => {},
  async start() {
    // A registration that takes a moment, like the real six-queue sequence.
    await new Promise((resolve) => setTimeout(resolve, 50));
  },
  async stop(options) {
    console.log(`STOP_OPTIONS ${JSON.stringify(options)}`);
    await new Promise((resolve) => setTimeout(resolve, STOP_DELAY_MS));
    console.log("STOP_DONE");
  },
};

const handle = await startWorker({
  createRuntime: () => runtime,
  log: (message) => console.log(message),
});

console.log(`READY ${handle.readyFilePath}`);

// Without this the process would exit as soon as the module finished: the real
// worker is held open by pg-boss's own timers, which the stub has none of.
const keepAlive = setInterval(() => {}, 1_000);
process.once("SIGTERM", () => {
  // Registered *after* `startWorker`'s own handler, so this runs second —
  // clearing the keep-alive only once the drain has been kicked off.
  setTimeout(() => clearInterval(keepAlive), STOP_DELAY_MS + 200);
});
