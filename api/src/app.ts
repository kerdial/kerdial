import { requestConcurrencyCeiling } from "@kerdial/platform-db";
import "reflect-metadata";
import fastifyCookie from "@fastify/cookie";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "@kerdial/importer";
import type { MarketRuntime } from "@kerdial/market-composition";
import { runWithRequestContext } from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import type { FastifyInstance } from "fastify";
import { AppModule } from "./app.module.js";
import { registerHealthRoute } from "./health.js";
import { RouteRegistry } from "./route-registry.js";
import { resolveAdmissionBound } from "./common/admission-bound.interceptor.js";
import { securityHeadersFor } from "./security-headers.js";
import {
  DEFAULT_KERDIAL_LIMIT_SETS,
  type KerdialLimitSets,
} from "./imports/import-limits.tokens.js";
import { importMultipartCeilings, registerImportMultipart } from "./imports/multipart.js";
import { APPLY_DEADLINE_HEADROOM_MS, APPLY_DEADLINE_MIN_MS } from "./request-budget.js";
import { registerStaticTier, resolveWebDistRoot } from "./static-tier.js";
import type { TrustProxyOption } from "./trust-proxy.js";

/**
 * `api` — the real NestJS 11 (Fastify adapter) application
 * (D2): `/api/v1`, JSON, cookie-authenticated. Replaces T-1's bare Fastify
 * placeholder (this file's previous doc comment: "This file is replaced, not
 * extended, when [the real API surface] happens" — this is that
 * replacement).
 *
 * `db` is injected rather than constructed here so a real `postgres.js`
 * connection (production, via `main.ts`) and a Testcontainers-backed one
 * (tests) go through the exact same bootstrap path.
 */
export interface BuildAppOptions {
  readonly db: Db;
  /**
   * Security review finding L2 — the server secret `computeCsrfToken`
   * (`auth/csrf-token.ts`) HMACs a session id against. Required (no
   * default): unlike `trustProxy`, there is no safe implicit value here — a
   * hardcoded fallback secret shared by every deployment would defeat the
   * whole point of binding the CSRF token to a secret only the server
   * knows. `main.ts` reads this from `CSRF_SECRET` and fails fast if unset;
   * tests generate a fresh random one per test app (`test-app.ts`).
   */
  readonly csrfSecret: string;
  /**
   * Security review finding M2 — see `trust-proxy.ts`'s doc comment.
   * Defaults to `false` (trust nothing) when omitted, which is the safe
   * default for an app not deployed behind a reverse proxy; `main.ts`
   * computes this from `TRUST_PROXY` for the real deployment.
   */
  readonly trustProxy?: TrustProxyOption;
  /**
   * IC-8 — the
   * live provider composition root, built via `@kerdial/market-composition`'s
   * `createMarketRuntime` (`main.ts`) or a fake/injected one (tests). Omitted
   * or `null` (today's/every existing suite's default) ⇒ `MARKET_RUNTIME`
   * resolves to `null`: the creation-time backfill trigger (IC-9) and the
   * discovery route (IC-11) both treat that as "no runtime configured" and
   * behave exactly as they do today — no behavior change for any existing
   * caller of this function.
   */
  readonly marketRuntime?: MarketRuntime | null;
  /**
   * Security review finding N1 — override of
   * {@link CONNECTION_TIMEOUT_MS}. Exists so a test can assert Node actually
   * kills a socket past a *short* bound without waiting out the real 30 s
   * production value.
   *
   * **No longer test-only.** `api-runtime.ts` now passes
   * `resolveRequestBudget(env).httpTimeoutMs` here, so a self-hosted
   * deployment on slow hardware can raise the triple through `HTTP_TIMEOUT_MS`
   * without a rebuild. Omitted ⇒ {@link CONNECTION_TIMEOUT_MS}, which is also
   * what that resolver returns when the variable is unset, so the default
   * deployment is unchanged.
   */
  readonly connectionTimeoutMs?: number;
  /**
   * Security review finding F-1 — override of
   * {@link HANDLER_TIMEOUT_MS}, same rationale and same amendment as
   * `connectionTimeoutMs` above: a test shortens it; `api-runtime.ts` passes
   * the resolved `HTTP_TIMEOUT_MS`; omitted ⇒ the shipped default.
   */
  readonly handlerTimeoutMs?: number;
  /**
   * F-1 remediation (security review) — override of
   * {@link REQUEST_TIMEOUT_MS} (and, alongside it, the `headersTimeout` this
   * app always derives from the same value — see that constant's doc
   * comment). Same rationale and same amendment as
   * `connectionTimeoutMs`/`handlerTimeoutMs` above.
   */
  readonly requestTimeoutMs?: number;
  /**
   * F-1 remediation (security review) — test-only override of Node's
   * `connectionsCheckingInterval` (default 30 s: `server.js`'s
   * `setupConnectionsTracking`, which the `headersTimeout`/`requestTimeout`
   * enforcement in `checkConnections` piggybacks on — see
   * `REQUEST_TIMEOUT_MS`'s doc comment). Node only re-scans connections for
   * headers/request-timeout expiry once per this interval, so a test that
   * wants to observe `requestTimeout` actually fire within a normal test
   * timeout (rather than waiting out a real 30s scan period on top of the
   * timeout itself) needs to shorten this too. Never set outside
   * `test-support/test-app.ts`/the F-1-completion spec; production takes
   * Node's own default (undefined here, which `http.createServer` treats
   * identically to omitting the option).
   */
  readonly connectionsCheckingIntervalMs?: number;
  /**
   * Security review finding N1 — test-only hook: registers additional
   * raw Fastify routes directly on the underlying `instance`, before
   * `app.init()`/`instance.ready()` lock the router (Fastify refuses new
   * routes once ready, so this must run inside `buildApp`, not after it
   * returns). Used by the N1 behavioral timeout spec to register a route that
   * sleeps past a shortened, test-only `connectionTimeoutMs` — proving the
   * timeout actually destroys the socket, not merely that the config value is
   * set. Never used by `main.ts`; bypasses Nest DI entirely (fine for a
   * throwaway test route, wrong for anything this app actually serves).
   *
   * Finding 7 (security review, INFO) — until now, "never used by
   * `main.ts`" was enforced by nothing but this comment: any future caller of
   * `buildApp` (a refactor of `main.ts`, a new production entrypoint, a
   * script) could pass this and register an **unauthenticated** route —
   * `registerTestRoutes` runs directly against the raw Fastify `instance`,
   * entirely outside Nest's DI/module graph, so it bypasses the global
   * `AuthGuard` (`app.module.ts`) the same way every other route in this app
   * is subject to it. `buildApp` now asserts `process.env["NODE_ENV"] ===
   * "test"` whenever this option is set (see `buildApp`'s own guard, run
   * before anything else), throwing rather than silently accepting it
   * outside a test process. Vitest sets `NODE_ENV=test` for every test file
   * in this repo (verified directly, not assumed); `main.ts` never sets it at
   * all in production, so this is a real, load-bearing check, not a
   * decorative one.
   */
  readonly registerTestRoutes?: (instance: FastifyInstance) => void;
  /**
   * SH-21 (FR-1–FR-3, AC-1) — the built SPA's directory.
   *
   * Omitted (every existing suite's call, and `main.ts`) ⇒ resolved by
   * `resolveWebDistRoot`: `WEB_DIST_DIR`, else the workspace-relative
   * `web/dist`, and `null` when that has no `index.html`. Pass an explicit path
   * to serve a fixture bundle; pass `null` to disable the static tier outright
   * even where a real `web/dist` exists (an API-only process, or a test that
   * must see the pre-SH-21 404 behaviour on a machine that happens to have
   * built the web app).
   */
  readonly staticRoot?: string | null;
  /**
   * SH-32 — test-only override of `health.ts`'s
   * {@link HEALTH_CACHE_TTL_MS}, same rationale as `connectionTimeoutMs` above:
   * a test that must observe the payload cache *expire* would otherwise have to
   * wait out the real 5 s window. Never set by `main.ts`, which always takes the
   * designed TTL. Note the *entry* into the cache needs no override — proving
   * "N concurrent requests cost one round-trip" only needs the default window,
   * and that test deliberately uses it.
   */
  readonly healthCacheTtlMs?: number | undefined;
  /**
   * `csv-import` CI-19 — the import pipeline's tunables,
   * as one object. Omitted (every existing suite) ⇒ `DEFAULT_IMPORT_LIMITS`,
   * the shipped values.
   *
   * **No longer test-only**, on the same two tunables the timeout
   * triple above became configurable for: `api-runtime.ts` passes
   * `resolveRequestBudget(env).importLimits`, which is `DEFAULT_IMPORT_LIMITS`
   * with `applyDeadlineMs` and `applyChunkRows` resolved from env. The other
   * tunables stay compile-time constants.
   *
   * It keeps the same rationale as `connectionTimeoutMs`/
   * `handlerTimeoutMs`/`healthCacheTtlMs` above, and one this feature's own
   * standing rule makes mandatory rather than convenient: every limit has
   * to be **proved to bind by measuring a downstream effect at two
   * different values**, never by asserting the constant. A constant read from
   * module scope inside the pipeline can only be asserted. Two of the six —
   * `maxFileBytes` and `maxRows` — are only reachable through HTTP, so this is
   * the only place their boundary can be moved and watched to move.
   *
   * `maxFileBytes` is consumed here (it is one input to `@fastify/multipart`'s
   * `limits.fileSize`, applied at registration — see
   * {@link BuildAppOptions.kerdialLimits}); the other five travel on to
   * `ImportsModule.forRoot`.
   */
  readonly importLimits?: ImportLimits;
  /**
   * `portfolio-export-import` EI-25/EI-26 — the two Kerdial packages' own limit
   * sets. Omitted (every existing suite) ⇒ `DEFAULT_KERDIAL_LIMIT_SETS`, the
   * shipped values.
   *
   * Here rather than inside `ImportsModule` for the same FR-539 reason
   * {@link BuildAppOptions.importLimits} is, plus one this cycle adds: the
   * multipart plugin's `limits.fileSize` is a single number per instance, so
   * the ceiling registered below is the **maximum** over
   * `importMultipartCeilings(...)`'s four entries, and each route re-imposes
   * its own per request. Both halves have to move together or the 1 MiB bound the
   * Portfolio-Performance routes state would be retired by the JSON route's
   * 32 MiB, which is exactly risk RK2.
   */
  readonly kerdialLimits?: KerdialLimitSets;
  /**
   * ADR-0016 — the instance-wide admission bound: at most this many
   * Nest-routed requests in flight at once, whoever sent them. `main.ts` passes
   * `resolveAdmissionBound(requestPoolMax)` so the bound describes the pool the
   * process actually opened; omitted (every existing suite's call) ⇒ derived
   * from `DB_POOL_MAX`'s resolved default the same way.
   */
  readonly admissionBound?: number;
}

export interface BuiltApp {
  readonly app: NestFastifyApplication;
  /**
   * SH-21 — the SPA root actually served, or `null` when no static tier was
   * registered. Returned so a test asserts what the app *did* rather than
   * re-deriving what it should have done.
   */
  readonly staticRoot: string | null;
  /**
   * Every route Fastify actually registered, post `/api/v1` prefix — the
   * AC32 cross-endpoint 401 sweep enumerates this dynamically rather than a
   * hand-maintained list, so it automatically covers whatever T-37/T-38/T-39
   * mount later.
   */
  readonly routes: readonly { readonly method: string; readonly path: string }[];
}

/**
 * F5 (security review, T-38): an explicit cap on request
 * body size — Fastify's own default (~1 MiB, as of the version this app
 * pins) was never overridden here, so this makes the limit a documented
 * property of this app rather than an implementation detail of whichever
 * Fastify version happens to be installed. 1 MiB comfortably covers every
 * request body this API accepts (`/transactions` bodies are a handful of
 * decimal strings and UUIDs; nothing here streams a file upload).
 */
const REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * M1 (security review, T-39): none of the `/portfolios/*`
 * valuation routes had a request-level timeout — `materializePortfolioValuations`
 * (`valuation/src/materialize.ts`) is event-loop-blocking `Decimal` arithmetic
 * plus, on a sustained `calc_epoch` race, its own bounded retry loop
 * (`MAX_GUARDED_ATTEMPTS`) — a genuinely pathological request (the widest
 * allowed range, repeatedly racing a concurrent writer) could otherwise hold
 * a connection and an event-loop turn open indefinitely. 30 s comfortably
 * exceeds the documented worst-case estimate ("a few hundred
 * milliseconds of I/O plus ~1-2s of Decimal arithmetic" for a full 10-year
 * rebuild) many times over, so no legitimate request is expected to ever hit
 * it — this is a backstop for the pathological case, not a budget tuned to
 * the common one. H1's absolute date bounds and H2's per-tenant concurrency
 * throttle are the primary mitigations for the cost this backstops; C25 (the
 * deferred background valuation-warmer job) is the actual latency fix this is
 * *not* attempting to be.
 *
 * Security review finding N1 — this was originally wired as
 * `requestTimeout`, which is **inert** against exactly the pathological case
 * above: Node's `server.requestTimeout` (what Fastify's `requestTimeout`
 * option maps straight onto, `fastify/lib/server.js`) only bounds the time
 * to *receive* a complete request (headers + body); once Fastify has the
 * full request and has handed it to a route handler, `requestTimeout` no
 * longer applies at all, no matter how long that handler blocks the event
 * loop. Verified directly against this repo's pinned Node/Fastify versions:
 * a handler that sleeps 1500 ms returns 200 under `requestTimeout: 500`
 * (the "timeout" never fires, because the request was already fully
 * received). `connectionTimeout` is the option that actually helps here —
 * Fastify maps it onto `server.setTimeout(...)` (Node's `server.timeout`,
 * `fastify/lib/server.js`), a whole-connection *inactivity* timeout: past
 * this many milliseconds with no socket activity — which includes a
 * handler that has stopped sending anything back, mid-computation — Node
 * destroys the underlying socket itself (observed here: `server.timeout =
 * 500` kills the same 1500 ms handler's connection at ~513 ms, "socket hang
 * up" on the client). See `app-timeout.e2e.test.ts`'s own header for the
 * behavioral (not merely configuration) proof, and its red-confirm against
 * the old `requestTimeout`-only config.
 *
 * Security review finding F-1 (blocker) — `connectionTimeout` is
 * *also* not the whole answer, for a reason that applies equally to the
 * `requestTimeout` it replaced: both map onto Node's `socket.setTimeout(...)`
 * (`fastify/lib/server.js`), which is an **inactivity** timer — it is reset
 * by *any* read or write on that socket, request or response side alike, not
 * armed once from a fixed start time. A slow client that keeps trickling a
 * handful of bytes more often than the configured timeout (the classic
 * slowloris shape: send the headers, announce a `Content-Length`, then drip
 * the body in one byte at a time) never leaves the socket idle for long
 * enough to trip it, no matter how long the request takes in total. Verified
 * directly: a raw socket sending one body byte every 100 ms against
 * `connectionTimeout: 500` (this app's previous sole defense) ran past 5 s —
 * ten times the configured bound — without the connection ever being closed.
 * The same is true of `requestTimeout` on its own (verified the same way);
 * neither socket-level option bounds *total* request lifetime against a
 * continuously-if-slowly-active client, which is exactly the gap this
 * finding is about — Fastify additionally leaving `requestTimeout` at its
 * own default of `0` (disabled, `fastify/lib/config-validator.js`'s
 * `defaultInitOptions`) merely means nothing was even attempting that bound
 * post-N1; it was never sufficient on its own regardless.
 *
 * Fastify 5.10 (the version this app pins) added `handlerTimeout`
 * specifically for this: an **application-level** timeout — not
 * socket-level — that starts once a request is routed and covers body
 * awaiting/parsing, validation, handler execution, and serialization as one
 * fixed wall-clock budget, immune to the reset-on-activity behavior above.
 * Verified against the same slow-body-trickle client that defeated
 * `connectionTimeout`: with `handlerTimeout: 800`, Fastify sends a `503
 * FST_ERR_HANDLER_TIMEOUT` at ~807 ms even though the client is still
 * actively (if slowly) sending body bytes past the 5 s mark — the fix this
 * finding calls for. `handlerTimeout` is now this app's primary per-request
 * bound ({@link HANDLER_TIMEOUT_MS}, below); `connectionTimeout` stays
 * configured alongside it, not in place of it — `handlerTimeout` only
 * guarantees the *client* gets a definitive response, it does not itself
 * close the underlying socket (verified: the trickling client above kept its
 * connection open well after the 503 was sent), so `connectionTimeout`
 * remains the backstop that eventually reaps a connection that has gone
 * genuinely idle (including one left dangling after its own `handlerTimeout`
 * response). See `app-timeout.e2e.test.ts`'s F-1 section for the behavioral
 * proof of both the gap and the fix.
 *
 * Security review, F-1 completion — `handlerTimeout` alone still left
 * a real gap the third round's own reasoning got backwards: it argued
 * `requestTimeout` was redundant with `connectionTimeout` (both being the
 * same `socket.setTimeout` inactivity mechanism) and dropped it entirely,
 * leaving Fastify at its own default of `requestTimeout: 0` (disabled,
 * `fastify/lib/config-validator.js`'s `defaultInitOptions`) — i.e. *no*
 * bound at all on how long the server will wait to *receive* a complete
 * request. That is wrong on the facts: Node's `server.requestTimeout` (added
 * in Node 14 specifically for this) is not the same mechanism as
 * `connectionTimeout`/`server.timeout` — it is a hard deadline measured from
 * when the current HTTP message *begins* (`last_message_start_`,
 * `src/node_http_parser.cc`'s `on_message_begin`, only reset by the *next*
 * message on a keep-alive socket, never by activity within the current one),
 * checked by a periodic scan (`checkConnections`, default every 30s —
 * `connectionsCheckingInterval`), not the reset-on-every-byte inactivity
 * timer `connectionTimeout` is. Verified directly against this repo's
 * pinned Node/Fastify: with `requestTimeout: 500` and a shortened
 * `connectionsCheckingInterval: 100`, a client that trickles its body one
 * byte every 40ms (continuously active, well within `connectionTimeout`'s
 * own budget, exactly the slowloris shape `handlerTimeout` cannot see until
 * the request is fully received) gets `408 Request Timeout` and its socket
 * closed at ~601ms — `requestTimeout` firing *during* body receipt, before
 * the request ever reaches a handler.
 *
 * That test also surfaced a real footgun in how Fastify wires this option up,
 * worth recording precisely because it is easy to reintroduce silently:
 * Fastify sets `server.requestTimeout` as a plain property *after*
 * `http.createServer(...)` has already run (`fastify/lib/server.js`), but
 * never touches `server.headersTimeout` at all, which Node computes at
 * construction time as `Math.min(60_000, requestTimeout)` — using whatever
 * `requestTimeout` the *http* module's own options carried in, not the value
 * Fastify assigns moments later. The result: with only Fastify's
 * `requestTimeout: 500` set, `server.headersTimeout` stays at Node's
 * unrelated default of `60_000`. `checkConnections`'s native implementation
 * (`ConnectionsList::Expired`, `src/node_http_parser.cc`) then finds
 * `headersTimeout (60_000) > requestTimeout (500)` and *swaps* them before
 * applying either — silently making the *effective* full-request-receipt
 * bound 60s, not the 500ms configured, for any request whose headers already
 * completed (exactly the ongoing-body-trickle case this finding is about).
 * Verified directly: `requestTimeout: 500` alone left the same trickling
 * client's connection open past 5s (ten times the intended bound) with
 * nothing firing; adding `headersTimeout: 500` via Fastify's `http` passthrough
 * option (the only way to set it — Fastify has no first-class
 * `headersTimeout` option) removed the swap and restored the 500ms bound
 * (the ~601ms result above). This app therefore always derives
 * `http.headersTimeout` from the same {@link REQUEST_TIMEOUT_MS}/
 * `requestTimeoutMs` value passed as `requestTimeout`, never leaving it at
 * Node's mismatched default. See `app-timeout.e2e.test.ts`'s F-1-completion
 * section for the full behavioral proof (including the red-confirm of both
 * the "no requestTimeout at all" state and the "requestTimeout without a
 * matching headersTimeout" footgun above).
 */
const CONNECTION_TIMEOUT_MS = 30_000;

/**
 * Security review finding F-1 — see {@link CONNECTION_TIMEOUT_MS}'s
 * doc comment above for the full rationale. Same 30 s budget as
 * `CONNECTION_TIMEOUT_MS`: this isn't a second, independent policy decision,
 * it's the same "a pathological request may take up to 30 s, no more"
 * backstop enforced through two different mechanisms for defense in depth —
 * one immune to a still-active-but-slow client (`handlerTimeout`), one that
 * eventually reaps a connection that has actually gone idle
 * (`connectionTimeout`).
 */
const HANDLER_TIMEOUT_MS = 30_000;

/**
 * Security review, F-1 completion — see `CONNECTION_TIMEOUT_MS`'s doc
 * comment above for the full rationale and the observed numbers this is
 * based on. Same 30s budget as `CONNECTION_TIMEOUT_MS`/`HANDLER_TIMEOUT_MS`,
 * enforced through a third, independent mechanism: a hard deadline on
 * *receiving* a complete request (Node's `server.requestTimeout`), covering
 * the one attack shape neither of the other two bounds: a client that keeps
 * trickling request bytes just often enough to never trip `connectionTimeout`
 * (an inactivity timer) and never finishes the request, so `handlerTimeout`
 * (which only starts once the request is fully received) never gets a chance
 * to run either.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Finding 7 (security review, INFO) — see
 * `BuildAppOptions.registerTestRoutes`'s own doc comment. Checked first,
 * before any of `buildApp`'s other work (Nest/Fastify construction, DB
 * wiring), so a misuse fails immediately and loudly rather than partway
 * through building an app that would otherwise happily serve an
 * unauthenticated route.
 */
function assertRegisterTestRoutesOnlyInTest(options: BuildAppOptions): void {
  if (options.registerTestRoutes === undefined) return;
  if (process.env["NODE_ENV"] === "test") return;
  throw new Error(
    "buildApp: registerTestRoutes was passed outside NODE_ENV=test. It registers " +
      "unauthenticated Fastify routes that bypass Nest's DI and the global AuthGuard " +
      "entirely — never a legitimate production/non-test code path.",
  );
}

/**
 * (security confirm, F2) — the apply deadlines are checked
 * **where they are consumed**, against the handler timeout this app is about to
 * be built with.
 *
 * `resolveRequestBudget`'s own `assertDeadlinesUnderCeiling` iterates the sets
 * of the budget it has just derived, so it can only catch a set that *file*
 * resolves wrongly. The bug it was written for (M1) was the
 * opposite shape: `api-runtime.ts` built a budget correctly and then passed
 * `importLimits` alone to `buildApp`, so the Kerdial routes ran on
 * {@link DEFAULT_KERDIAL_LIMIT_SETS}' compile-time 25 000 ms under whatever
 * timeout the operator had set — and a budget-side loop over the budget's own
 * sets says nothing about that. This one reads the three values the routes will
 * actually be given, so dropping `kerdialLimits:` at the call site is a
 * container that does not start.
 *
 * Refused, never clamped, for `request-budget.ts`' reason: a clamped
 * misconfiguration runs with a number nobody chose.
 *
 * A test-injected deadline *below* the ceiling is fine and is the normal case —
 * the GATE-4 and FR-539 suites pass 1 ms deliberately. Only a deadline that sits
 * past the socket is refused.
 *
 * **Where the rule stops.** A `handlerTimeoutMs` leaving less than
 * {@link APPLY_DEADLINE_MIN_MS} after the headroom is one `resolveRequestBudget`
 * refuses at boot (its own `applyDeadlineCeilingMs` check), so no deployment can
 * reach this function with one: the only caller that does is
 * `app-timeout.e2e.test.ts`, which builds an app at a 500 ms handler timeout to
 * observe Fastify's socket behaviour and never calls an import route. Below that
 * line there is no deadline any limit set could carry — the ceiling is negative
 * — so checking it would refuse every value rather than a wrong one.
 */
function assertApplyDeadlinesUnderHandlerTimeout(
  handlerTimeoutMs: number,
  importLimits: ImportLimits,
  kerdialLimits: KerdialLimitSets,
): void {
  const ceilingMs = handlerTimeoutMs - APPLY_DEADLINE_HEADROOM_MS;
  if (ceilingMs < APPLY_DEADLINE_MIN_MS) return;
  const sets: readonly (readonly [string, number])[] = [
    ["Portfolio-Performance", importLimits.applyDeadlineMs],
    ["Kerdial transactions", kerdialLimits.csv.applyDeadlineMs],
    ["Kerdial catalogue", kerdialLimits.json.applyDeadlineMs],
  ];
  for (const [name, deadlineMs] of sets) {
    if (deadlineMs > ceilingMs) {
      throw new Error(
        `buildApp: the ${name} import set's apply deadline is ${String(deadlineMs)} ms, over the ` +
          `${String(ceilingMs)} ms left by this app's ${String(handlerTimeoutMs)} ms handler timeout ` +
          `minus the ${String(APPLY_DEADLINE_HEADROOM_MS)} ms response headroom. A deadline past the ` +
          `socket is not a deadline — pass the limit set resolved by resolveRequestBudget rather ` +
          `than letting this one fall back to its module constants.`,
      );
    }
  }
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  assertRegisterTestRoutesOnlyInTest(options);

  const importLimits = options.importLimits ?? DEFAULT_IMPORT_LIMITS;
  const kerdialLimits = options.kerdialLimits ?? DEFAULT_KERDIAL_LIMIT_SETS;
  assertApplyDeadlinesUnderHandlerTimeout(
    options.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS,
    importLimits,
    kerdialLimits,
  );

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(
      options.db,
      options.csrfSecret,
      options.marketRuntime ?? null,
      importLimits,
      options.admissionBound ?? resolveAdmissionBound(requestConcurrencyCeiling()),
      kerdialLimits,
    ),
    new FastifyAdapter({
      trustProxy: options.trustProxy ?? false,
      bodyLimit: REQUEST_BODY_LIMIT_BYTES,
      connectionTimeout: options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
      handlerTimeout: options.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS,
      requestTimeout: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      // F-1 completion — `http` is Fastify's documented passthrough straight
      // to Node's `http.createServer(options, ...)` (`fastify/lib/server.js`),
      // the only way to set `headersTimeout` (Fastify has no first-class
      // option for it) and, for tests, `connectionsCheckingInterval`.
      // `headersTimeout` is deliberately pinned to the same value as
      // `requestTimeout` above, not left at Node's unrelated 60s default —
      // see `CONNECTION_TIMEOUT_MS`'s doc comment for the swap footgun this
      // avoids (an unmatched, larger `headersTimeout` silently doubles the
      // effective request-receipt bound).
      http: {
        headersTimeout: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        connectionsCheckingInterval: options.connectionsCheckingIntervalMs,
      },
    }),
    { logger: false },
  );

  const registry = new RouteRegistry();
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) registry.add(method, routeOptions.url);
  });

  // F11 (security review, T-37, INFO): the response security
  // headers, applied here (not per-controller) so every response — success,
  // 4xx, 5xx alike, including `ProblemJsonExceptionFilter`'s own, and every
  // static-tier response, which never enters Nest at all — carries them.
  // Deliberately a hand-written set rather than a `helmet`-class dependency.
  //
  // SH-23 (FR-4–FR-8) extends that set with the
  // cited `Content-Security-Policy`, `Referrer-Policy` and `Permissions-Policy`
  // (and no HSTS — FR-5, asserted absent), and makes `Cache-Control`
  // **path-aware**: `/api/v1/*` and `/health` keep the unconditional
  // `no-store` this hook has always applied (every API response is
  // authenticated, per-tenant financial data, and cookie session auth means a
  // shared/back-button cache could resurface it after logout), while the
  // content-hashed build artifacts the static tier serves become immutable and
  // the update-discovery path becomes `no-cache`. `security-headers.ts` owns
  // the whole policy; this hook is the single place it is applied (Locked
  // decision 3), which is what makes "exactly one CSP header, from the
  // application" provable about this app.
  instance.addHook("onSend", (request, reply, payload, done) => {
    for (const [name, value] of securityHeadersFor(request.url)) void reply.header(name, value);
    done(null, payload);
  });

  // SH-26 (FR-44's detection clause; L2/L3) — the exposure
  // control's runtime half, on every request including the static tier's and
  // `/health`'s (registered here, before `registerStaticTier`'s own plugin
  // scope, so it is inherited rather than skipped). It reads the **socket
  // peer**, not `request.ip`: `request.ip` is the *derived* client address, so
  // asking it who connected would answer with whatever the trust configuration
  // under test already believed — the one question this layer exists to check
  // independently.
  // SH-38 (FR-29, AC-26) — the request-scoped log store,
  // opened here and inherited by everything below.
  //
  // Registered **first**, before every other hook and before the static tier's
  // plugin scope, so there is no request-lifecycle position from which a line
  // could be emitted without context. `done()` is called *inside*
  // `runWithRequestContext`, which is what makes the rest of the request run
  // within the store: `AsyncLocalStorage` propagates through the continuation,
  // not through the hook object.
  //
  // `tenant_id` starts `null` on purpose — the tenant is not knowable until
  // `AuthGuard` has validated the session, which mutates this same store
  // (`auth.guard.ts`). The **socket peer** is recorded alongside `request.ip`
  // and is deliberately not the same field: `request.ip` is the address the
  // trust configuration *derived*, so a log line carrying only it cannot help
  // diagnose a trust misconfiguration.
  instance.addHook("onRequest", (request, _reply, done) => {
    runWithRequestContext(
      {
        request_id: String(request.id),
        tenant_id: null,
        peer: request.socket.remoteAddress,
        client_ip: request.ip,
      },
      done,
    );
  });

  await app.register(fastifyCookie);

  // csv-import CI-16 — the *only* file-upload surface this
  // app has. Registered alongside `fastifyCookie` because the plugin has to be
  // on the instance the Nest routes are registered on, and immediately
  // scoped by `registerImportMultipart`'s own hook to the two import paths:
  // the plugin's content-type parser is global, and leaving it so would change
  // how every other route answers a `multipart/form-data` body (RC6). See that
  // module's doc comment for why the scope is a hook and not Fastify
  // encapsulation.
  //
  // KD14: the plugin is registered at the
  // **maximum** over the four import paths, because it has one `fileSize` for
  // the instance and the JSON catalogue route's is 32 MiB. Each path's own
  // ceiling is carried in the map and re-imposed twice — by the hook's
  // `content-length` pre-check before a byte is read, and exactly by
  // `readImportUpload(request, { maxFileBytes })` while the file is read. That
  // the plugin honours a per-request override is MEASURED over a real socket by
  // `imports-multipart-per-request-limit.e2e.test.ts` (GATE-0a), and
  // `imports-limits.e2e.test.ts` is the regression that the PP routes' 1 MiB
  // bound survived the raise.
  //
  // Built from the **injected** limit sets, not from module constants, so a
  // suite that lowers a ceiling moves the pre-check with it (FR-539).
  await registerImportMultipart(app.getHttpAdapter().getInstance(), {
    ceilings: importMultipartCeilings({
      pp: importLimits.maxFileBytes,
      kerdialCsv: kerdialLimits.csv.maxFileBytes,
      kerdialJson: kerdialLimits.json.maxFileBytes,
    }),
  });

  app.setGlobalPrefix("api/v1");

  // SH-32 (FR-42/FR-48, AC-34) — `GET /health`, the
  // thing compose's `depends_on: service_healthy` and `api`'s own healthcheck
  // probe. A raw Fastify route, like the static tier's: unauthenticated by
  // construction (it never enters Nest's DI graph, so the global `AuthGuard`
  // does not apply) and outside `setGlobalPrefix` for free. Registered *before*
  // `registerStaticTier` so the explicit path is in the router before the SPA's
  // wildcard — `shouldServeSpaShell` already excludes `/health`, and this is the
  // second, structural half of that same guarantee.
  registerHealthRoute(instance, {
    db: options.db,
    cacheTtlMs: options.healthCacheTtlMs,
  });

  // SH-21 (FR-1–FR-3, AC-1) — the SPA and the API on one
  // instance and one port. Registered here, before `app.init()` installs Nest's
  // not-found handler and before `instance.ready()` locks the router; see
  // `static-tier.ts` for why the fallback is a delegating wildcard route rather
  // than a second not-found handler. `null` (no `web/dist`) leaves this app
  // byte-for-byte its pre-SH-21 self, which is what every existing API suite
  // runs as.
  const staticRoot = resolveWebDistRoot(options.staticRoot);
  if (staticRoot !== null) await registerStaticTier(instance, staticRoot);

  // Security review finding N1 (test-only) — see
  // `BuildAppOptions.registerTestRoutes`'s own doc comment. Must run before
  // `app.init()`/`instance.ready()` below lock the router.
  options.registerTestRoutes?.(instance);

  await app.init();
  await instance.ready();

  return { app, routes: registry.routes, staticRoot };
}
