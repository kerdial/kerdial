import { randomBytes } from "node:crypto";
import postgres from "postgres";
import type { ImportLimits } from "@kerdial/importer";
import type { KerdialLimitSets } from "../imports/import-limits.tokens.js";
import type { TokenAuthLimits } from "../auth/token-auth-limits.js";
import type { MarketRuntime } from "@kerdial/market-composition";
import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres } from "@kerdial/platform-test-support";
import { buildApp, type BuiltApp } from "../app.js";
import type { TrustProxyOption } from "../trust-proxy.js";

/**
 * Shared migrated-Postgres bootstrap for `api`'s Supertest suites — the same
 * shape `platform/auth/src/auth-service.integration.test.ts` (T-10) and
 * `platform/auth/src/login-rate-limit.integration.test.ts` (T-40) use:
 * migrations run as the database superuser (`ownerDb`, implicitly
 * `BYPASSRLS`, for out-of-band setup/assertions), the app under test connects
 * as `app_web` (RLS-enforced), exactly the role the real API connects as.
 *
 * The database itself comes from `@kerdial/platform-test-support`'s
 * `startMigratedPostgres()`: one shared container with a
 * per-suite cloned database under the root test scripts, an own container in
 * a bare `npx vitest run one-file.test.ts`.
 */
export interface TestApp {
  readonly built: BuiltApp;
  /** The same `app_web`-authenticated `Db` the app under test itself uses — for seeding via `platform/auth`'s helpers (e.g. `createUser`). */
  readonly db: Db;
  readonly ownerDb: Db;
  readonly ownerClient: postgres.Sql;
  /**
   * The connection string of the real `app_ingest` role on the same database —
   * for a suite that must run the **worker lane's** own write beside an HTTP
   * request (IR-17's DD25 proof: a `PATCH` over HTTP as `app_web`, then a real
   * provider resolve as `app_ingest`, then a `GET` over HTTP). Exposed as a URI
   * rather than an open `Db` so no suite pays for a connection it does not use;
   * connecting as `ownerDb` instead would bypass migration `0036`'s
   * column-level grants and make exactly that kind of assertion vacuous.
   */
  readonly appIngestUri: string;
  stop(): Promise<void>;
}

export interface StartTestAppOptions {
  /**
   * IC-8 — omitted
   * (every existing suite's call) or `null` ⇒ `buildApp`'s own default
   * (`marketRuntime: null`), byte-for-byte the pre-IC-8 behavior. Pass a
   * hand-written fake `MarketRuntime` for a suite exercising the IC-9
   * creation-time trigger without a real pg-boss/`app_ingest` connection —
   * see `instruments-backfill-trigger.e2e.test.ts`. A *real* runtime (built
   * via `createMarketRuntime` against a real pg-boss instance, for proving
   * the bootstrap/shutdown lifecycle itself) needs its own `app_ingest`
   * connection string, which this helper does not expose —
   * `market/market-runtime.module.integration.test.ts` (this package's own
   * `src/market/`) calls `startMigratedPostgres()` and `buildApp` directly
   * instead, the same pattern `market/composition`'s own IC-6 tests already
   * use.
   */
  readonly marketRuntime?: MarketRuntime | null;
  /**
   * SH-21 (FR-1–FR-3, AC-1) — forwarded to `buildApp`, but **defaulting to
   * `null`** (no static tier) rather than to `buildApp`'s own env/workspace
   * resolution.
   *
   * Deliberate: `buildApp`'s default would pick up a real `web/dist` whenever
   * one happens to have been built in the checkout, so every suite's route table
   * would depend on whether someone had run the web build — the same suite
   * passing or failing for a reason outside its own file. Suites that mean to
   * exercise the tier pass an explicit fixture root (`static-tier.e2e.test.ts`);
   * everyone else keeps the pre-SH-21 app.
   */
  readonly staticRoot?: string | null;
  /**
   * SH-44 — forwarded to `buildApp`, defaulting to `buildApp`'s own default
   * (`false`, trust nothing), which is what every existing caller gets.
   *
   * Exists for `e2e-lane-server.ts`, which reads it from the real
   * `TRUST_PROXY` env var via `wireTrustProxy` the way `main.ts` does.
   * `auth.e2e.test.ts`'s trustProxy block calls `buildApp` directly instead
   * because it builds an app per value inside a single suite.
   */
  readonly trustProxy?: TrustProxyOption;
  /**
   * `csv-import` CI-19 — forwarded to `buildApp` verbatim; omitted (every
   * existing suite's call) ⇒ `DEFAULT_IMPORT_LIMITS`. The rule is that a
   * limit is proved to bind by measuring a downstream effect at **two**
   * values, so `imports-limits.e2e.test.ts` starts one app at the shipped
   * values and one at lowered ones and compares what actually happens.
   */
  readonly importLimits?: ImportLimits;
  /**
   * `portfolio-export-import` EI-25/EI-26 — forwarded to `buildApp` verbatim;
   * omitted (every pre-cycle suite's call) ⇒ `DEFAULT_KERDIAL_LIMIT_SETS`.
   *
   * Same FR-539 reason {@link StartTestAppOptions.importLimits} exists for, and
   * one more: the catalogue export's `413 EXPORT_TOO_LARGE` threshold **is**
   * this set's `json.maxFileBytes` (KD4.1, one constant for the export refusal
   * and the import ceiling), so a lowered value is the only way to make a real
   * tenant cross it over real HTTP without a 32 MiB fixture.
   */
  readonly kerdialLimits?: KerdialLimitSets;
  /**
   * `account-setup` AC-378 — `postgres.js`'s own per-query `debug` hook,
   * forwarded to the `app_web` client the app under test runs on.
   *
   * It fires once per statement actually sent to the server, which is what
   * makes "this route issues no extra round trip" a *counted* fact rather
   * than an assertion about the shape of the code that issues them. The
   * precedent is `health.e2e.test.ts`, which builds its own clients for
   * exactly this reason; exposing the hook here means a suite that needs
   * the count does not also have to re-implement `startTestApp`.
   *
   * Omitted by every other suite's call, in which case the client is built
   * byte-for-byte as before.
   */
  readonly appWebQueryDebug?: (connection: number, query: string) => void;
  /** ADR-0019 — forwarded to `buildApp` verbatim; omitted ⇒ the shipped token windows. */
  readonly tokenAuthLimits?: TokenAuthLimits;
}

export async function startTestApp(options: StartTestAppOptions = {}): Promise<TestApp> {
  const pg = await startMigratedPostgres();
  const ownerClient = pg.ownerClient;
  const ownerDb = pg.ownerDb;

  // Security review finding M1: the atomic login-rate-limit path
  // (`withLoginRateLimit`) holds one connection for its advisory-lock
  // transaction for the duration of the whole login attempt, plus a second
  // for `login()`'s own internal transaction — and a burst of N concurrent
  // attempts for the *same* email all queue on the same advisory lock, each
  // holding a connection while it waits. `max: 5` was enough before that
  // burst-concurrency test existed; it is not enough for the burst-of-10
  // test in `auth.e2e.test.ts`, which would otherwise pool-exhaust rather
  // than exercise the lock itself.
  const appWebSql = postgres(pg.appWebUri, {
    max: 20,
    ...(options.appWebQueryDebug === undefined ? {} : { debug: options.appWebQueryDebug }),
  });
  const appWebDb = createDb(appWebSql);

  // A fresh random secret per test app — no cross-restart/cross-replica
  // persistence requirement in tests (security review finding L2).
  const csrfSecret = randomBytes(32).toString("hex");

  const built = await buildApp({
    db: appWebDb,
    csrfSecret,
    marketRuntime: options.marketRuntime ?? null,
    staticRoot: options.staticRoot ?? null,
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    ...(options.importLimits === undefined ? {} : { importLimits: options.importLimits }),
    ...(options.kerdialLimits === undefined ? {} : { kerdialLimits: options.kerdialLimits }),
    ...(options.tokenAuthLimits === undefined ? {} : { tokenAuthLimits: options.tokenAuthLimits }),
  });

  return {
    built,
    db: appWebDb,
    ownerDb,
    ownerClient,
    appIngestUri: pg.appIngestUri,
    async stop() {
      await built.app.close();
      await appWebSql.end({ timeout: 5 });
      await pg.stop();
    },
  };
}
