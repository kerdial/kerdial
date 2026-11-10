import { AsyncLocalStorage } from "node:async_hooks";
import { pino, type Logger as PinoLogger } from "pino";

/**
 * SH-38 (FR-29–FR-33, AC-26–AC-29) — **plain pino plus a hand-rolled
 * `AsyncLocalStorage`**, which is a locked decision and is not a
 * re-litigable implementation detail: `nestjs-pino` is explicitly not what
 * this project uses, and `NestFactory.create(..., { logger: false })` stays
 * exactly as it is (`api/src/app.ts`).
 *
 * ## The one property everything here is built around
 *
 * **A monetary or position value must never reach log output** (FR-33), and
 * that is enforced by an **allow-list**, not by pino's deny-list `redact`.
 * The distinction is the whole design:
 *
 *  - A deny-list answers "which of the fields I thought of must be hidden?".
 *    It fails **open** on the field nobody has added yet — the next `price`,
 *    `quantity`, `costBasisBase` or `totalValueBase` someone puts in a log
 *    call is emitted in full, and no test that asserts a `redact` key exists
 *    would notice.
 *  - An allow-list answers "which fields may be emitted at all?". Everything
 *    else is dropped without anyone having to have anticipated it.
 *
 * So {@link createLogger} builds every record from {@link LOG_FIELD_ALLOWLIST}
 * only, never by spreading a caller's object, and pino's own `redact` is
 * configured **as well** — second line, not first, for the case where an
 * allow-listed field's *value* happens to carry a secret (a `DATABASE_URL`
 * inside an error message, say).
 *
 * AC-28/AC-29 are both worded "verified by inspecting the actual emitted
 * output", never by asserting a config key is present. `logger.test.ts`
 * captures the real stream and greps the bytes.
 *
 * ## Context
 *
 * `AsyncLocalStorage` carries `{ request_id, tenant_id }` for an API request
 * and `{ job_id, queue, instrument_id? }` for a worker job execution, so every
 * line emitted anywhere beneath them carries the context without any call site
 * threading it (AC-26, AC-27).
 *
 * `tenant_id` deliberately starts `null`: the store is opened by a Fastify
 * `onRequest` hook, and the tenant is not known until `AuthGuard` has run —
 * which is why {@link setRequestTenant} **mutates the existing store** rather
 * than opening a new one (a new one would not be visible to the frames that
 * already captured the old), and why AC-26 is scoped to *authenticated*
 * requests while pre-auth lines legitimately carry a null tenant.
 *
 * **Revision 4 adds the socket peer address** to the request-scoped fields,
 * distinct from `request.ip` (the *derived* client address). Both are needed
 * for `SH-26`'s detection layers and the runbook's procedure to
 * be diagnosable at all — "peer 192.168.1.12, client 203.0.113.7" answers in
 * one line what otherwise takes a packet capture. A peer address is
 * infrastructure, not personal data, and is allow-listed **explicitly** rather
 * than being left to look like something that ought to be redacted.
 */

/** What a redacted value is replaced by, in emitted output. */
export const REDACTED = "[redacted]";

/**
 * FR-30's redaction list, as pino `redact` paths — the
 * **second** line of defence behind the allow-list.
 *
 * `censor` replaces rather than removes, so a line that *would* have carried a
 * secret is visibly marked instead of silently shrinking, which is what makes
 * a leak diagnosable after the fact.
 *
 * **No DNS-provider-token entry**, and that absence is deliberate: FR-31/FR-47
 * name one, but the revision-3 scope cut removed TLS, ACME and DNS-01 from
 * this project entirely, so there is no such token
 * anywhere in this repository to redact. A path for a value that cannot exist
 * is a maintenance liability that reads as coverage.
 */
export const REDACT_PATHS: readonly string[] = [
  "sid",
  "*.sid",
  "csrf_token",
  "*.csrf_token",
  "cookie",
  "*.cookie",
  "headers.cookie",
  "headers.authorization",
  "CSRF_SECRET",
  "*.CSRF_SECRET",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "INGESTION_DATABASE_URL",
  "*.INGESTION_DATABASE_URL",
  "email",
  "*.email",
  "password",
  "*.password",
];

/**
 * **The allow-list.** Every field name a record may carry, beyond pino's own
 * `level`/`time`/`msg`.
 *
 * Adding a field here is a deliberate act with a reviewer; *not* adding one
 * means the value is dropped. That is the intended failure direction: a
 * missing diagnostic is an inconvenience, a leaked position size is not.
 *
 * Note what is **not** here and could not be added by accident: `price`,
 * `quantity`, `close`, `rate`, `amount`, `costBasis*`, `pmpUnit*`,
 * `totalValueBase`, or any other monetary/position field. FR-33 is structural,
 * not a rule someone has to remember.
 */
const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  // Request context (FR-29, AC-26)
  "request_id",
  "tenant_id",
  "method",
  "path",
  "status",
  // SH-26 / revision 4 — the socket peer, distinct from the derived client IP.
  "peer",
  "client_ip",
  // Worker job context (FR-29, AC-27)
  "job_id",
  "queue",
  "instrument_id",
  // Operational diagnostics
  "indicator",
  "provider",
  "exchange",
  "sqlstate",
  "constraint",
  "err",
  "error",
  "count",
  "duration_ms",
  // `portfolio-export-import` EI-30 (FR-513, NFR-62): the
  // **byte size** of an export's response body, beside its `count` and
  // `duration_ms`. NFR-62 admits exactly three things — counts, byte sizes and
  // durations — and this is the second of them finally having a name; an export
  // whose size is the operator's only handle on "why did that request take
  // twelve seconds" had none.
  //
  // It is a size, never a figure: `result.byteLength` of a buffer, derived from
  // nothing tenant-specific but the volume of it. No per-table breakdown joins
  // it, deliberately — that would need one allow-listed name per table, and the
  // counts are already in the file the user just downloaded.
  "bytes",
  "component",
  // SH-35's ops-indicator diagnostics (FR-49 channel 2). These are the
  // operator-only specifics that deliberately do **not** go into
  // `ops_indicator.detail`, because `/health` is unauthenticated and
  // tenant-derived counts must not appear there. They are listed one by one, and
  // that is the mechanism working as intended rather than a nuisance: the first
  // cut of the sweep emitted `openProviders`, which is not in this list, and
  // the field was silently dropped from the ERROR line — caught by a test that
  // read the emitted output. A field only reaches logs if someone put it here.
  "quote_never_fetched_count",
  "quote_stale_count",
  "eod_silent_exchanges",
  "eod_behind_exchanges",
  "fx_last_rate_date",
  "dead_letter_queues",
  "dead_letter_depth",
  "open_providers",
  // The two that shipped without ever reaching a log line.
  // `backfill_unresolvable_count` and `price_currency_mismatch_count`
  // were emitted by `ops-indicator-sweep.ts` and dropped here, silently,
  // for exactly the reason this list's own header gives — nobody added them.
  // Their suite did not catch it because it injects its own `error` sink
  // (`OpsIndicatorSweepDeps.error`) and asserts on what the *sweep* passed,
  // which is upstream of this filter. `ops-indicator-sweep.integration.test.ts`
  // now also reads a real emitted line for one of them, so a fourth count added
  // without a line here fails rather than disappears.
  "backfill_unresolvable_count",
  "price_currency_mismatch_count",
  "backfill_abandoned_count",
  // IR-9 (`instrument-reference-data`, FR-3): the *unmapped* provider
  // classification label, so `PROVIDER_SECTOR_TO_CODE` can be extended
  // deliberately instead of by guesswork. Added here as the one deliberate act
  // this list's own header describes — without it the field is dropped and
  // FR-3's record names nothing. It is a public equity-sector bucket name from
  // the provider's own taxonomy, never tenant-derived and never monetary.
  // Truncated to 64 chars at the call site — bounded, not the two
  // options below's "log a length instead" shape, because FR-3 needs the raw
  // value itself to extend `PROVIDER_SECTOR_TO_CODE` deliberately.
  "provider_sector_label",
  // `instrument-reference-data`, the classification write site: the **length**
  // of a provider industry label that exceeds the stored bound, which is why
  // that label was dropped while `sector_code` was still written. The label
  // itself is deliberately not logged — it is over 120 characters by
  // construction, and a length is the whole diagnostic. An integer character
  // count of a provider-supplied display string: never tenant-derived, never
  // monetary. Unlike `provider_sector_label` above, nothing here needs the
  // raw string — the length alone tells the reader why the write was
  // dropped — which is why this entry stays a bound integer rather than a
  // truncated string.
  "provider_industry_label_length",
  // the two market-data repair paths' own summary
  // lines, each shipped first *without* an entry here and each lost its
  // whole payload to this filter on the deployed worker (`fx-daily: history
  // coverage fetched missing ranges` emitted only `component`;
  // `history-gap-repair: instrument scanned` emitted only the job context).
  // The same shape as the ops-indicator counts above: integers and ISO dates
  // describing coverage of a shared reference series — how many business
  // days were missing, filled, skipped and why, over which scanned range —
  // plus, for the FX line, the fetched ranges as `EUR/USD INTERIOR
  // 2010-02-15..2026-08-27` strings. Never tenant-derived, never a price.
  "written",
  "backfills",
  // The same line's sibling: a fetched range that came back short, as
  // `EUR/USD TAIL requested 1999-01-04..2026-10-07 observed 1999-01-04..2010-02-14 rows 2803`.
  "shortfalls",
  "scanned_from",
  "scanned_to",
  "missing",
  "filled",
  "skipped_closed",
  "skipped_known_empty",
  "recorded_empty",
  // `account-setup` NFR-48/NFR-49/LD-7 — the admin audit line, emitted once
  // per successful `POST /admin/users` and `POST /admin/users/:id/password`
  // (`api/src/admin/admin.controller.ts`). Four scalars and only four: who
  // acted, on whom, in which tenant, and which of the two actions it was.
  // `tenant_id` is already listed above and carries the *actor's* tenant from
  // the request context, which is why the subject's tenant needs its own name.
  //
  // The email and the password are never passed to the logger at all. They
  // are unconditionally redacted at `REDACT_PATHS` regardless, but the
  // discipline is not to hand them over in the first place — an audit line
  // needs the id, and the id is not a credential.
  "actor_user_id",
  "target_user_id",
  "target_tenant_id",
  "admin_action",
]);

/**
 * The fields the ambient context contributes. Exported so a test can assert
 * the exact set rather than a substring of a serialized line.
 */
export const LOG_CONTEXT_FIELDS: readonly string[] = [
  "request_id",
  "tenant_id",
  "peer",
  "client_ip",
  "job_id",
  "queue",
  "instrument_id",
];

export interface RequestLogContext {
  readonly kind: "request";
  readonly request_id: string;
  /** `null` until `AuthGuard` resolves it — see {@link setRequestTenant}. */
  tenant_id: string | null;
  /** The socket peer address (`request.socket.remoteAddress`), never `request.ip`. */
  readonly peer?: string | undefined;
  /** The *derived* client address (`request.ip`), which is what the trust configuration believes. */
  readonly client_ip?: string | undefined;
}

export interface JobLogContext {
  readonly kind: "job";
  readonly job_id: string;
  readonly queue: string;
  readonly instrument_id?: string | undefined;
}

export type LogContext = RequestLogContext | JobLogContext;

/** Values a log field may take. Deliberately not `unknown`: an arbitrary object is what spreading looks like. */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

const storage = new AsyncLocalStorage<LogContext>();

/** The ambient context, or `undefined` outside any request or job (process-level lines). */
export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Opened by the API's `onRequest` hook. `tenant_id` starts
 * `null` and is filled in place by {@link setRequestTenant}.
 */
export function runWithRequestContext<T>(context: Omit<RequestLogContext, "kind">, fn: () => T): T {
  return storage.run({ kind: "request", ...context }, fn);
}

/** The worker context (AC-27) — one per job execution. */
export function runWithJobContext<T>(context: Omit<JobLogContext, "kind">, fn: () => T): T {
  return storage.run({ kind: "job", ...context }, fn);
}

/**
 * **Mutates** the current request store. A new store would be invisible to
 * every frame that already captured the old one, which is precisely the
 * ordering `AuthGuard` runs in: the hook opened the store, the guard resolves
 * the tenant afterwards, and lines emitted by the controller below it must see
 * the tenant. A no-op outside a request context (a job never has a tenant).
 */
export function setRequestTenant(tenantId: string): void {
  const context = storage.getStore();
  if (context !== undefined && context.kind === "request") context.tenant_id = tenantId;
}

/** The ambient context as loggable fields — `{}` outside any context. */
export function logContextFields(): LogFields {
  const context = storage.getStore();
  if (context === undefined) return {};
  if (context.kind === "request") {
    return {
      request_id: context.request_id,
      tenant_id: context.tenant_id,
      ...(context.peer === undefined ? {} : { peer: context.peer }),
      ...(context.client_ip === undefined ? {} : { client_ip: context.client_ip }),
    };
  }
  return {
    job_id: context.job_id,
    queue: context.queue,
    ...(context.instrument_id === undefined ? {} : { instrument_id: context.instrument_id }),
  };
}

/**
 * A log call's shape: a message, plus **named** fields. There is deliberately
 * no overload taking an arbitrary object — "log this thing" is exactly how a
 * monetary value ends up in output.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A child bound to extra allow-listed fields (e.g. `component`). */
  child(fields: LogFields): Logger;
}

export interface CreateLoggerOptions {
  /** Defaults to `LOG_LEVEL`, else `info`. */
  readonly level?: string;
  /** Test seam — pino writes here instead of stdout. Production never sets it (FR-31: stdout only). */
  readonly destination?: NodeJS.WritableStream;
  /** Bound onto every record from this logger (e.g. `{ component: "worker" }`). */
  readonly base?: LogFields;
}

/**
 * Drops every field that is not allow-listed. This is where FR-33 actually
 * happens — before pino sees the record at all, so nothing downstream (a
 * transport, a future formatter) can put a dropped field back.
 */
function allowListed(fields: LogFields | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_FIELD_ALLOWLIST.has(key)) continue;
    if (value === undefined) continue;
    record[key] = value;
  }
  return record;
}

function wrap(logger: PinoLogger): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, fields?: LogFields): void => {
      // Context first, so a caller cannot shadow `tenant_id`/`request_id` with
      // a field of its own — the ambient truth wins over a call site's guess.
      logger[level]({ ...allowListed(fields), ...allowListed(logContextFields()) }, message);
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields: LogFields): Logger => wrap(logger.child(allowListed(fields))),
  };
}

/**
 * FR-31: **stdout only.** No file destination, no transport, no second sink —
 * the Docker `json-file` driver with explicit `max-size`/`max-file` is the
 * whole log-management story (compose, Batch I), and the consequence — that
 * log-based alerting is rotation-bounded — is exactly why FR-48's conditions
 * also live in a durable table (`ops_indicator`, SH-34/SH-35).
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? process.env["LOG_LEVEL"] ?? "info";
  const pinoOptions = {
    level,
    base: allowListed(options.base),
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    formatters: {
      level: (label: string): Record<string, string> => ({ level: label }),
    },
  };
  const logger =
    options.destination === undefined
      ? pino(pinoOptions)
      : pino(pinoOptions, options.destination as never);
  return wrap(logger);
}

/**
 * The process's one logger.
 *
 * Created lazily on first use rather than at module load, so importing this
 * package never opens a stream as a side effect — the same discipline
 * `worker-main.ts` follows about not starting a worker on import.
 */
let root: Logger | null = null;

/**
 * The shared logger every migrated `console.*` call site writes through
 * (FR-32). Deliberately a **function**, not an exported constant: call sites
 * resolve it per call, which is what lets {@link setRootLoggerForTest} swap it
 * without every module having to take a logger parameter it would otherwise
 * never vary.
 */
export function rootLogger(): Logger {
  root ??= createLogger();
  return root;
}

/**
 * Test-only: replaces the process logger and returns a restore function.
 *
 * AC-28/AC-29 require inspecting **emitted output**, and pino writes to fd 1
 * through `sonic-boom`, which `vi.spyOn(process.stdout, "write")` never sees.
 * A test therefore has to be able to hand the process a logger pointed at a
 * stream it holds — otherwise those two criteria could only be checked by
 * reading configuration, which is exactly what they forbid.
 *
 * Guarded by `NODE_ENV === "test"`, mirroring `api/src/app.ts`'s
 * `registerTestRoutes` precedent (finding 7): a
 * production caller that redirected the process's logs would silence every
 * FR-49 push-channel line, so this refuses rather than trusting a comment.
 * Vitest sets `NODE_ENV=test` for every test file in this repo.
 */
export function setRootLoggerForTest(logger: Logger): () => void {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "setRootLoggerForTest was called outside NODE_ENV=test. It redirects every log line " +
        "this process emits, including FR-49's ERROR-level breach notifications — never a " +
        "legitimate production code path.",
    );
  }
  const previous = root;
  root = logger;
  return () => {
    root = previous;
  };
}
