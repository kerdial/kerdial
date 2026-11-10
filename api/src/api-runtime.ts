import { createMarketRuntime, type MarketRuntime } from "@kerdial/market-composition";
import {
  assertConnectionBudget,
  createDb,
  createPostgresClient,
  type Db,
} from "@kerdial/platform-db";
import { resolveAdmissionBound } from "./common/admission-bound.interceptor.js";
import { resolveRequestBudget } from "./request-budget.js";
import { buildApp, type BuildAppOptions, type BuiltApp } from "./app.js";
import { rootLogger } from "@kerdial/platform-logging";
import { parseTrustProxy, TRUST_PROXY_ENV_VAR, type TrustProxyOption } from "./trust-proxy.js";

/**
 * The `api` role's body, lifted out of `main.ts`.
 *
 * **Why it does not live in `main.ts` any more.** `main.ts` is the one module
 * the test run never loads — importing it *runs* it, side effects and all — so
 * everything written there is, by construction, uncovered. The split is the
 * same one `app-role.ts` already makes for role dispatch, for the same reason:
 * `main.ts` keeps only what cannot be tested (reading `process.env`,
 * `await main()`), and the wiring that *decides what the deployed process
 * installs* lives here.
 *
 * ADR-0016 retired SH-26's four-layer proxy exposure control from this
 * file: `PROXY_TOPOLOGY`/`PROXY_ADDRESS`, the derived `API_BIND`, the
 * per-request peer monitor and the `/health` `proxyTrust` indicator. What
 * remains is the one knob a self-hosted deployment actually has —
 * `TRUST_PROXY`, parsed by {@link parseTrustProxy} and handed to Fastify —
 * plus the single INFO line that says what it resolved to.
 */

/** Everything the wiring reaches for, injectable so the suite can run it without a database or a socket. */
export interface ApiRuntimeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createDb: (databaseUrl: string, poolMax: number) => Db;
  readonly buildApp: (options: BuildAppOptions) => Promise<BuiltApp>;
  readonly createMarketRuntime: () => MarketRuntime;
  /** The trust-proxy INFO line's sink. Defaults to `rootLogger().info`. */
  readonly info?: (line: string) => void;
}

const productionDeps: ApiRuntimeDeps = {
  env: process.env,
  createDb: (databaseUrl, poolMax) => createDb(createPostgresClient(databaseUrl, { max: poolMax })),
  buildApp,
  createMarketRuntime,
};

/**
 * The one exposure knob: `TRUST_PROXY`, parsed exactly as
 * `trust-proxy.ts` documents, announced in one INFO line in the same startup
 * log the operator already reads. Every entrypoint that serves the real app
 * (`main.ts`, the static-tier e2e lane server) goes through this function so
 * the value is read and described in one place.
 */
export function wireTrustProxy(
  env: Readonly<Record<string, string | undefined>>,
  info: (line: string) => void = (line) => rootLogger().info(line, { component: "api" }),
): TrustProxyOption {
  const trustProxy = parseTrustProxy(env[TRUST_PROXY_ENV_VAR]);
  info(
    trustProxy === false
      ? `trust proxy: none — request.ip is the socket peer (${TRUST_PROXY_ENV_VAR} unset)`
      : `trust proxy: ${JSON.stringify(trustProxy)} — X-Forwarded-For is honoured from that hop/peer (${TRUST_PROXY_ENV_VAR})`,
  );
  return trustProxy;
}

/**
 * SH-21 (FR-2) — the `api` role's entrypoint body. `main.ts` calls this and
 * does nothing else for the role; `APP_ROLE=worker` never reaches it.
 */
export async function runApi(overrides: Partial<ApiRuntimeDeps> = {}): Promise<BuiltApp> {
  const deps: ApiRuntimeDeps = { ...productionDeps, ...overrides };

  const databaseUrl = deps.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("main: DATABASE_URL is required");
  }

  // Security review finding L2: no default/fallback secret — a shared
  // hardcoded value would defeat the point of binding the CSRF token to a
  // server-only secret. Every replica behind the same load balancer must be
  // configured with the SAME value (it is not itself generated per process),
  // or a token issued by one replica would fail verification on another.
  const csrfSecret = deps.env["CSRF_SECRET"];
  if (!csrfSecret) {
    throw new Error("main: CSRF_SECRET is required");
  }

  // Two bounds, in the order their arithmetic depends on, both deliberately
  // *before* any pool is constructed — the point is that a misconfiguration
  // never reaches `listen()`, and a check that ran after the pool opened would
  // already have taken the connections it is arguing about.
  //
  // AR-17 (ADR-0008 Stage 8) first: does the whole deployment's set
  // of pools fit inside the cluster? This is the outer bound, and it is the one
  // that can fail for a reason nothing in this process controls — another
  // process's pool, or a `PGMAX` that no longer matches the server.
  //
  // ADR-0016 second: the instance-wide admission bound, derived from
  // the request pool it protects (`poolMax - reserve`) and refused at boot if
  // the pool is too small to leave one. It replaced AR-18's per-tenant ceiling
  // sum; the inner bound is now one number, not a table.
  //
  // `requestPoolMax` is resolved once, by AR-17, and used for the bound *and*
  // the pool itself. Resolving `DB_POOL_MAX` more than once is exactly how a
  // budget comes to describe a pool that does not exist.
  const budget = assertConnectionBudget({ role: "api" });
  const requestPoolMax = budget.requestPoolMax;
  const admissionBound = resolveAdmissionBound(requestPoolMax);

  // Third and last of the boot-time bounds, and refused here for the
  // same reason as the two above: the per-request timeout triple and the
  // import pipeline's apply deadline, which must stay under it. A slow
  // self-hosted box raises `HTTP_TIMEOUT_MS` and the deadline follows.
  const requestBudget = resolveRequestBudget(deps.env);

  const db = deps.createDb(databaseUrl, requestPoolMax);
  // Security review finding M2: never hardcode `trustProxy: true`.
  const trustProxy =
    deps.info === undefined ? wireTrustProxy(deps.env) : wireTrustProxy(deps.env, deps.info);

  // DD3/DD4 — built from
  // env (`INGESTION_DATABASE_URL`/`WORKER_IN_PROCESS`) *before* `buildApp`,
  // mirroring `db`/`trustProxy` above: an externally-constructed dependency
  // handed to `AppModule.forRoot`, not something Nest DI constructs itself.
  const marketRuntime = deps.createMarketRuntime();
  const built = await deps.buildApp({
    db,
    csrfSecret,
    trustProxy,
    marketRuntime,
    admissionBound,
    // One value drives all three; see `app.ts`'s `REQUEST_TIMEOUT_MS`
    // doc comment on why the triple is set together and none of them is left
    // at a framework default.
    connectionTimeoutMs: requestBudget.httpTimeoutMs,
    handlerTimeoutMs: requestBudget.httpTimeoutMs,
    requestTimeoutMs: requestBudget.httpTimeoutMs,
    importLimits: requestBudget.importLimits,
    // Security review M1: the two Kerdial routes' sets, from
    // the same budget. Omitting this line was the finding: `buildApp` then fell
    // back to `DEFAULT_KERDIAL_LIMIT_SETS`, whose `applyDeadlineMs` is the
    // 25 000 ms module constant, so lowering `HTTP_TIMEOUT_MS` closed the socket
    // on a catalogue import whose deadline had not moved.
    kerdialLimits: requestBudget.kerdialLimits,
  });

  // DD3 — `MarketRuntimeModule`'s `OnApplicationShutdown` hook (this app's own
  // graceful pg-boss drain) only fires on `app.close()`. `enableShutdownHooks()`
  // wires SIGTERM/SIGINT (Nest's default signal set) to call `close()`, so a
  // real deployment's shutdown signal actually drains in-flight backfill work
  // instead of the process being killed out from under it.
  built.app.enableShutdownHooks();

  const port = Number(deps.env["PORT"] ?? 3000);
  // This is the **container-internal** listen address and is always
  // `0.0.0.0`; it is *not* `API_BIND`. A loopback listen inside the container
  // would be unreachable even from a proxy on the same host, because the
  // publish crosses the bridge. The interface that actually limits who can
  // connect is the host publish — compose `ports: ["${API_BIND}:${API_PORT}:3000"]`,
  // an operator choice (docs/deploy-runbook.md §1). Do not "harden" this
  // line to 127.0.0.1: it would break every deployment while changing nothing
  // about reachability from off the host.
  await built.app.listen(port, "0.0.0.0");
  return built;
}
