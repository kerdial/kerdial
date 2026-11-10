import { rootLogger } from "@kerdial/platform-logging";
import { APP_ROLE_ENV_VAR, parseAppRole, runRole } from "./app-role.js";
import { runApi } from "./api-runtime.js";

/**
 * Production entrypoint — process-level concerns only.
 *
 * Everything the `api` role actually *wires* lives in `api-runtime.ts` and is
 * covered by `api-runtime.test.ts`. This file is the one module the
 * test run cannot import without running it, so nothing that can be deleted
 * silently may live here: what remains is `APP_ROLE` dispatch (proved by
 * `app-role.test.ts`) and the top-level catch.
 *
 * SH-21 (FR-2) — `APP_ROLE=worker` never reaches `runApi`.
 */

/**
 * SH-21 (FR-2, AC-2) — the `worker` role.
 *
 * Imported **dynamically**, and only on this branch, so the `api` role never
 * pays for it and — the half that matters — the worker process never evaluates
 * `./app.js`: no Nest container, no Fastify instance, no `@fastify/static`
 * registration, nothing that could bind a port. `worker-main.ts` owns the drain
 * semantics, the readiness marker and its own signal handlers; nothing here duplicates them.
 */
async function runWorker(): Promise<void> {
  const { workerMain } = await import("@kerdial/market-composition");
  await workerMain();
}

/**
 * SH-21 (FR-2) — role dispatch. The `docker-entrypoint.sh` (Batch
 * H) `exec`s the right entrypoint per role; this is the same decision enforced
 * inside the application, so an override, a hand-run `node dist/main.js`, or a
 * future entrypoint edit cannot turn a worker container into a second HTTP
 * server. An unrecognised `APP_ROLE` throws rather than defaulting —
 * `app-role.ts` records why.
 */
async function main(): Promise<void> {
  const role = parseAppRole(process.env[APP_ROLE_ENV_VAR]);
  await runRole(role, {
    runApi: async () => {
      await runApi();
    },
    runWorker,
  });
}

main().catch((error: unknown) => {
  // (FR-32) — the process-fatal path: no request/job context exists
  // yet, so `component` is the only field this line can carry beyond the
  // message itself.
  rootLogger().error("api: fatal error during startup/dispatch", {
    component: "api",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
