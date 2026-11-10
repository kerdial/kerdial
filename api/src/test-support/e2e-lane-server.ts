/**
 * SH-43 (`self-hosted-deploy`; the "new e2e lane for CSP/static")
 * — the **real** application, on a **real** socket, for the static-tier CSP
 * e2e lane. (SH-44's test-proxy lane, the second consumer, was retired with
 * the proxy exposure control.)
 *
 * Why this file exists at all: `web/playwright.config.ts` runs `vite dev` on
 * :5173, which emits no `Content-Security-Policy`, never touches
 * `@fastify/static`, and never runs `buildApp`'s `onSend` hook — so no existing
 * Playwright spec has ever received a CSP header or exercised the static tier.
 * The lanes need a process that is the real thing: `buildApp` with the real
 * `securityHeadersFor` hook, the real `@fastify/static` root over the **built**
 * `web/dist`, the real per-IP login throttle against a real Postgres, and the
 * real `TRUST_PROXY` read — through `wireTrustProxy`, literally the function
 * `main.ts` calls, not a re-implementation of it.
 *
 * It is started by `web/playwright.static-tier.config.ts`'s `webServer`.
 *
 * **Run it from `api/dist`, never through `tsx`.** `app.module.ts`'s Nest DI
 * reads `design:paramtypes` metadata, which needs `emitDecoratorMetadata` —
 * esbuild (tsx) does not implement it and would silently produce `undefined`
 * for every injected constructor parameter. `pnpm build` is therefore a
 * prerequisite of both lanes, exactly as it already is of the `e2e`,
 * `flake-lane` and `dependency-boundaries` CI jobs.
 *
 * Contained the same way `buildApp`'s `registerTestRoutes` is (finding 7,
 * security review): it refuses to run outside `NODE_ENV=test`. It also
 * starts a Testcontainers Postgres, whose package is a `devDependency` absent
 * from the runtime image entirely — so even the compiled copy that travels in
 * `api/dist` (as `test-app.js` already does) cannot start there.
 *
 * Protocol: one line on stdout when listening —
 * `E2E-LANE-SERVER-READY {"url":…,"port":…,"staticRoot":…,"trustProxy":…}` —
 * then serves until `SIGTERM`/`SIGINT`, on which it closes the app and stops
 * the container.
 */
import { wireTrustProxy } from "../api-runtime.js";
import { startTestApp, type TestApp } from "./test-app.js";

export const READY_MARKER = "E2E-LANE-SERVER-READY";

export interface LaneServerHandshake {
  readonly url: string;
  readonly port: number;
  /** What the app *did* — `null` when no static tier was registered, never a re-derivation. */
  readonly staticRoot: string | null;
  /** The effective Fastify `trustProxy`, as `wireTrustProxy` read it from the env. */
  readonly trustProxy: unknown;
}

function assertTestEnvironment(): void {
  if (process.env["NODE_ENV"] === "test") return;
  throw new Error(
    "e2e-lane-server: refusing to start outside NODE_ENV=test. This is e2e-lane test " +
      "infrastructure (it starts a Testcontainers Postgres and serves an app whose database is " +
      "thrown away on exit), never a deployment entrypoint — the deployed entrypoint is " +
      "api/dist/main.js via deploy/docker-entrypoint.sh.",
  );
}

async function main(): Promise<void> {
  assertTestEnvironment();

  // The real read, from the real variable name, so the lane brings the app up
  // under `TRUST_PROXY` the way a deployment does. It is the entrypoint's own
  // function, not a second copy of it.
  const trustProxy = wireTrustProxy(process.env);

  const staticRoot = process.env["LANE_STATIC_ROOT"]?.trim();
  const host = process.env["LANE_HOST"]?.trim() || "127.0.0.1";
  const port = Number(process.env["LANE_PORT"] ?? 0);

  const testApp: TestApp = await startTestApp({
    ...(staticRoot === undefined || staticRoot === "" ? {} : { staticRoot }),
    trustProxy,
  });

  if (staticRoot !== undefined && staticRoot !== "" && testApp.built.staticRoot === null) {
    await testApp.stop();
    throw new Error(
      `e2e-lane-server: LANE_STATIC_ROOT="${staticRoot}" has no index.html, so no static tier was ` +
        'registered. Run `pnpm --filter "@kerdial/web..." run build` first — this lane\'s whole ' +
        "point is the *built* artefact, and serving nothing would be a vacuous green.",
    );
  }

  await testApp.built.app.listen(port, host);
  const address = testApp.built.app.getHttpServer().address() as { port: number };

  const handshake: LaneServerHandshake = {
    url: `http://${host}:${String(address.port)}`,
    port: address.port,
    staticRoot: testApp.built.staticRoot,
    trustProxy,
  };
  process.stdout.write(`${READY_MARKER} ${JSON.stringify(handshake)}\n`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void testApp
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("e2e-lane-server: shutdown failed", error);
        process.exit(1);
      });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

await main();
