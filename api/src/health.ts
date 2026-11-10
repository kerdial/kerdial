import { sql } from "drizzle-orm";
import { extractPostgresError, type Db } from "@kerdial/platform-db";
import type { FastifyInstance } from "fastify";

/**
 * SH-32 (`self-hosted-deploy` FR-42/FR-48/FR-49, AC-34) — `GET /health`.
 *
 * Nothing in this repository has ever had a health endpoint, so until this file
 * existed compose's `depends_on: service_healthy` and every restart policy had
 * nothing to probe. Three properties it exists to hold, none of them
 * re-derivable from the payload shape alone:
 *
 *  1. **`status` is about the database, never about the indicators.**
 *     `ok` whenever the database is reachable *regardless of
 *     indicator state* — otherwise a provider having a bad night would flip
 *     compose's `service_healthy` and flap the API. Degraded indicators are
 *     reported, never fatal. A forced database failure is the *only* thing that
 *     produces `degraded`/`unreachable`, and even that is still **200** (the
 *     payload is the signal; the status code is not a second, coarser one).
 *
 *  2. **The 5-second payload cache is a structural bound, not a throttle**.
 *     `/health` is credential-free, touches the database, and
 *     in the cross-host topology is LAN-reachable — so the cost of N probes must
 *     not be N round-trips. {@link createHealthPayloadCache} caches the
 *     *in-flight promise*, not merely the resolved value: N requests that arrive
 *     before the first one has resolved share it, which is what makes "exactly
 *     one round-trip per window" true under concurrency rather than only under
 *     a well-spaced poll.
 *
 *  3. **One round-trip, so the bound is countable.** The whole payload is one
 *     `select` against `ops_indicator`: reaching the server at all is what
 *     proves `db: "ok"`, so there is no separate `select 1`. The original
 *     specification describes `db` as "a `select 1`" — the difference is deliberate and is
 *     what makes the cache's acceptance criterion ("exactly one underlying DB
 *     round-trip") a countable fact instead of an approximate one.
 *
 * **`ops_indicator` does not exist yet — Batch J (`SH-34`) creates it.** That is
 * why {@link classifyIndicatorReadFailure} treats `42P01` (undefined_table) and
 * `42501` (insufficient_privilege) as *the database answered*: the server
 * responded with a SQLSTATE, so it is plainly reachable, and the
 * table-backed indicators report {@link INDICATOR_STATE_UNKNOWN} with a detail
 * saying which of the two it was. Everything else is treated as unreachable —
 * fail-safe, because an unrecognised failure is not evidence of health.
 *
 * Every indicator comes from that table. The api-side `proxyTrust` indicator
 * that used to be the one in-process exception was retired with the proxy
 * exposure control (ADR-0016).
 */

/** Outside `/api/v1`, matching `security-headers.ts` and `static-tier.ts`'s own constant. */
export const HEALTH_PATH = "/health";

/** The payload cache's TTL. A bound on cost, not a rate limit — see this file's header. */
export const HEALTH_CACHE_TTL_MS = 5_000;

/**
 * The table-backed conditions (FR-48 items 1–3), in the order
 * the payload lists them. Exported as data so a test asserts the exact set
 * rather than a substring of a serialized payload.
 *
 * FR-48's item 4, `backupStaleness`, was retired with the backup pipeline:
 * the volume and completion marker it read no longer exist, so the
 * condition has no observable subject. It returns with the export story.
 */
export const TABLE_BACKED_INDICATOR_KEYS = [
  "ingestionStaleness",
  "deadLetterDepth",
  "circuitBreaker",
] as const;

/** Every key the payload carries — all table-backed since ADR-0016 retired the in-process `proxyTrust`. */
export const HEALTH_INDICATOR_KEYS = [...TABLE_BACKED_INDICATOR_KEYS] as const;

export type TableBackedIndicatorKey = (typeof TABLE_BACKED_INDICATOR_KEYS)[number];
export type HealthIndicatorKey = (typeof HEALTH_INDICATOR_KEYS)[number];

/**
 * The `ops_indicator.state` CHECK is `('OK','BREACHED')`; this adds
 * a third value that only ever exists in the *payload*, never in the table.
 *
 * It is load-bearing, and not only for the pre-Batch-J window: an indicator
 * whose sweep has never run has no row, and reporting a never-computed
 * condition as `OK` is precisely the vacuous-green failure this project has a
 * recorded history of. "No observation" and "observed, fine" are different
 * facts and are reported differently.
 */
export const INDICATOR_STATE_UNKNOWN = "UNKNOWN";

export type HealthIndicatorState = "OK" | "BREACHED" | typeof INDICATOR_STATE_UNKNOWN;

export interface HealthIndicator {
  readonly state: HealthIndicatorState;
  /** ISO-8601, or `null` when there has been no observation at all. */
  readonly observedAt: string | null;
  readonly detail: string | null;
}

export type HealthStatus = "ok" | "degraded";
export type HealthDbReachability = "ok" | "unreachable";

export interface HealthPayload {
  readonly status: HealthStatus;
  readonly db: HealthDbReachability;
  readonly indicators: Readonly<Record<HealthIndicatorKey, HealthIndicator>>;
}

/**
 * `/health` is designed as if public — "no tenant data, no
 * per-instrument identity, no tenant-derived counts, allow-listed `detail`
 * strings". The first three are structural here (this file selects four columns
 * of an operational table that has no `tenant_id` at all). The fourth cannot be
 * enforced at the *reader*: the strings are written by Batch J's worker sweep,
 * which does not exist yet. This bound is what the reader can hold on its own —
 * a hard ceiling on how much of whatever a future writer puts there is ever
 * echoed to an unauthenticated caller. **The actual allow-listing belongs at
 * the writer**; this is only the ceiling behind it.
 */
export const MAX_INDICATOR_DETAIL_LENGTH = 200;

function boundDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_INDICATOR_DETAIL_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_INDICATOR_DETAIL_LENGTH)}…`;
}

function unknownIndicator(detail: string): HealthIndicator {
  return { state: INDICATOR_STATE_UNKNOWN, observedAt: null, detail };
}

/** One `ops_indicator` row, as the four columns `/health` reads. */
export interface OpsIndicatorRow {
  readonly indicatorKey: string;
  readonly state: string;
  readonly observedAt: Date | string | null;
  readonly detail: string | null;
}

/**
 * Why the read result is a discriminated union rather than "rows or throw": the
 * three failure modes mean three genuinely different things about the
 * deployment, and collapsing them would either claim the database is down when
 * only a table is missing, or claim health when the connection is gone.
 */
export type OpsIndicatorRead =
  | { readonly kind: "rows"; readonly rows: readonly OpsIndicatorRow[] }
  /** The server answered `42P01` — reachable, but Batch J has not run yet. */
  | { readonly kind: "table-absent" }
  /** The server answered `42501` — reachable, but `app_web` has no `SELECT` grant. */
  | { readonly kind: "not-granted" }
  /** Anything else. Fail-safe: an unrecognised failure is not evidence of health. */
  | { readonly kind: "unreachable"; readonly detail: string };

export interface OpsIndicatorReader {
  read(): Promise<OpsIndicatorRead>;
}

const UNDEFINED_TABLE = "42P01";
const INSUFFICIENT_PRIVILEGE = "42501";

/** Exported so a test drives every branch directly, without provoking each real SQLSTATE. */
export function classifyIndicatorReadFailure(error: unknown): OpsIndicatorRead {
  const pgError = extractPostgresError(error);
  if (pgError?.sqlstate === UNDEFINED_TABLE) return { kind: "table-absent" };
  if (pgError?.sqlstate === INSUFFICIENT_PRIVILEGE) return { kind: "not-granted" };
  return {
    kind: "unreachable",
    detail: pgError === undefined ? "connection failed" : `sqlstate ${pgError.sqlstate}`,
  };
}

/**
 * The single statement the whole payload costs. `ops_indicator` is not in the
 * Drizzle schema (Batch J adds it), and deliberately stays raw here even after
 * it is: this is the one query `/health` is allowed to make, and keeping it
 * literal is what makes "one round-trip" readable at the call site.
 */
export function createDbOpsIndicatorReader(db: Db): OpsIndicatorReader {
  return {
    async read(): Promise<OpsIndicatorRead> {
      try {
        const result = await db.execute(
          sql`select indicator_key, state, observed_at, detail from ops_indicator`,
        );
        const rows = (result as unknown as readonly Record<string, unknown>[]).map((row) => ({
          indicatorKey: String(row["indicator_key"] ?? ""),
          state: String(row["state"] ?? ""),
          observedAt: (row["observed_at"] as Date | string | null | undefined) ?? null,
          detail: (row["detail"] as string | null | undefined) ?? null,
        }));
        return { kind: "rows", rows };
      } catch (error: unknown) {
        return classifyIndicatorReadFailure(error);
      }
    },
  };
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function indicatorFromRow(row: OpsIndicatorRow): HealthIndicator {
  // Anything that is not one of `ops_indicator`'s two CHECK-constrained values
  // is reported as UNKNOWN rather than passed through: the payload's own
  // vocabulary is fixed here, not by whatever a future writer inserts.
  const state: HealthIndicatorState =
    row.state === "OK" || row.state === "BREACHED" ? row.state : INDICATOR_STATE_UNKNOWN;
  return {
    state,
    observedAt: toIsoString(row.observedAt),
    detail: boundDetail(row.detail),
  };
}

function tableBackedIndicators(
  read: OpsIndicatorRead,
): Record<TableBackedIndicatorKey, HealthIndicator> {
  const missing = (detail: string): Record<TableBackedIndicatorKey, HealthIndicator> =>
    Object.fromEntries(
      TABLE_BACKED_INDICATOR_KEYS.map((key) => [key, unknownIndicator(detail)]),
    ) as Record<TableBackedIndicatorKey, HealthIndicator>;

  switch (read.kind) {
    case "table-absent":
      return missing("ops_indicator does not exist yet — the alerting sweep has not been deployed");
    case "not-granted":
      return missing("no SELECT grant on ops_indicator for this database role");
    case "unreachable":
      return missing(`indicators unavailable — database ${read.detail}`);
    case "rows": {
      const byKey = new Map(read.rows.map((row) => [row.indicatorKey, row]));
      return Object.fromEntries(
        TABLE_BACKED_INDICATOR_KEYS.map((key) => {
          const row = byKey.get(key);
          return [
            key,
            row === undefined
              ? unknownIndicator("no ops_indicator row yet — this condition has never been swept")
              : indicatorFromRow(row),
          ];
        }),
      ) as Record<TableBackedIndicatorKey, HealthIndicator>;
    }
  }
}

export interface HealthPayloadSources {
  readonly indicators: OpsIndicatorReader;
}

/** The uncached payload — one `ops_indicator` read. */
export async function computeHealthPayload(sources: HealthPayloadSources): Promise<HealthPayload> {
  const read = await sources.indicators.read();
  return {
    status: read.kind === "unreachable" ? "degraded" : "ok",
    db: read.kind === "unreachable" ? "unreachable" : "ok",
    indicators: tableBackedIndicators(read),
  };
}

export interface HealthPayloadCacheOptions {
  readonly compute: () => Promise<HealthPayload>;
  /** Defaults to {@link HEALTH_CACHE_TTL_MS}. Explicitly `| undefined` so a caller may forward its own optional (`exactOptionalPropertyTypes`). */
  readonly ttlMs?: number | undefined;
  /** Test seam — defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The 5-second bound. The cached thing is the **promise**, stored before it
 * is awaited, so a burst that arrives while the first read is still in flight
 * costs one round-trip rather than one each — the property the acceptance
 * criterion counts. A value cache would satisfy a spaced poll and nothing else.
 *
 * A rejected computation is evicted so the next caller retries: caching a
 * failure for 5 s would turn one transient blip into a fixed-length outage of
 * the endpoint that is supposed to report it.
 */
export function createHealthPayloadCache(
  options: HealthPayloadCacheOptions,
): () => Promise<HealthPayload> {
  const ttlMs = options.ttlMs ?? HEALTH_CACHE_TTL_MS;
  const now = options.now ?? ((): number => Date.now());
  let entry: { readonly startedAt: number; readonly payload: Promise<HealthPayload> } | null = null;

  return (): Promise<HealthPayload> => {
    const at = now();
    if (entry !== null && at - entry.startedAt < ttlMs) return entry.payload;
    const started = { startedAt: at, payload: options.compute() };
    entry = started;
    started.payload.catch(() => {
      if (entry === started) entry = null;
    });
    return started.payload;
  };
}

export interface HealthRouteOptions {
  readonly db: Db;
  /** Test-only override of {@link HEALTH_CACHE_TTL_MS} — see `buildApp`'s own option. */
  readonly cacheTtlMs?: number | undefined;
}

/**
 * Registers `GET /health` as a **raw Fastify route**, exactly like the static
 * tier's, and for the same reason: it must be reachable with no session, and
 * `buildApp`'s global `AuthGuard` applies to Nest's DI graph — which a raw route
 * never enters. It is therefore unauthenticated *by construction* rather than by
 * a `@Public()` opt-out that a future guard could shadow, and it sits outside
 * `setGlobalPrefix("api/v1")` for free.
 *
 * `auth.e2e.test.ts`'s AC32 sweep enumerates every registered route and requires
 * a 401 — this route is one of the two deliberate exceptions listed there.
 */
export function registerHealthRoute(instance: FastifyInstance, options: HealthRouteOptions): void {
  const reader = createDbOpsIndicatorReader(options.db);
  const read = createHealthPayloadCache({
    compute: () => computeHealthPayload({ indicators: reader }),
    ttlMs: options.cacheTtlMs,
  });

  instance.get(HEALTH_PATH, async (_request, reply) => {
    const payload = await read();
    // Always 200: the *payload* is the signal. A non-200 on a
    // degraded database would additionally make the compose healthcheck and the
    // status code disagree about what "degraded" means.
    await reply.code(200).send(payload);
  });
}
