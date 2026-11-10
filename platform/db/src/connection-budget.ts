/**
 * `AR-17` (ADR-0008 Stage 8) — the **deployment-wide** connection
 * budget, and the boot assertion that keeps it honest.
 *
 * ADR-0008 states the invariant this module owns:
 *
 * ```
 *   Σ over every pool in every process ( pool.max )  +  reserve
 *      ≤  PGMAX
 * ```
 *
 * ADR-0008's `/ REPLICA_COUNT` divisor and the deploy-overlap reserve were
 * struck by ADR-0016: they existed for C28 multi-replica HA, which is
 * retired with the SaaS phase. One compose stack, one replica, one budget.
 *
 * **Why this lives in `platform/db` and not where the pools are opened.** Every
 * ceiling below was individually defensible where it was written, and nothing
 * added them up — the same shape as the finding `AR-18` closed one layer up
 * (`api/src/common/tenant-concurrency-budget.ts`). `market/composition` already
 * had a budget check, but it was deliberately per-process ("no process can see
 * how many peers exist, so a cluster-wide check here would be a guess dressed
 * up as a guarantee") and it mirrored this package's pool default **by value**,
 * guarded by a drift test. A drift test proves two constants are equal, not
 * that either matches what `postgres.js` was handed. Here there is nothing to
 * mirror: this module declares every ceiling, and the pools are built from
 * these same values.
 *
 * **Why a deployment-wide sum is not the guess that per-process reasoning
 * feared.** The peers are not discovered at runtime — they are *declared*. A
 * phase-1 deployment is a fixed compose stack (ADR-0014), so the topology is a
 * deploy-time input like any other, and {@link deploymentPoolCeilings}
 * enumerates it. What a process cannot know it is told; what it is told, it
 * asserts.
 *
 * **Why the failure is a refusal to boot.** Connection exhaustion surfaces on
 * *unrelated* routes, minutes after the change that caused it, which is what
 * makes this class of bug expensive — three recorded incidents (T-39's
 * combined-view 3N-transaction starvation, T-38's pool deadlock, and the
 * per-tenant throttle MEDIUM) all presented as something else. A process that
 * would have exhausted the cluster never reaches `listen()`.
 */

import { parsePositiveIntEnv } from "./client.js";

/**
 * `postgres:17`'s own `max_connections` default. Stated as the fallback rather
 * than read from the server because this assertion must run *before* the first
 * pool opens — there is no connection to ask. A deployment whose instance
 * differs sets `PGMAX`; if a managed provider changes it underneath us the
 * assertion fails loudly at the next boot, which ADR-0008 names as the desired
 * behaviour rather than a gap.
 */
export const DEFAULT_PGMAX = 100;

/**
 * Postgres keeps `superuser_reserved_connections` slots (default 3) that no
 * application role can take. They are part of `max_connections` but not
 * available to us, so budgeting against the raw number would over-commit by
 * exactly this much.
 */
export const SUPERUSER_RESERVED_CONNECTIONS = 3;

/**
 * One slot kept free for a human with `psql` during an incident. The cost is
 * one connection; the alternative is discovering that the only way into a
 * saturated database is to restart the thing you are trying to diagnose.
 */
export const OPERATOR_RESERVED_CONNECTIONS = 1;

/**
 * Every slot the budget must leave unclaimed. `deploy/docker-compose.yml`
 * recreates containers rather than rolling them, so there is no old-and-new
 * overlap window to reserve for (the former zero-valued deploy-overlap
 * component was dropped with the replica divisor).
 */
export const RESERVED_CONNECTIONS = SUPERUSER_RESERVED_CONNECTIONS + OPERATOR_RESERVED_CONNECTIONS;

/**
 * The `api` process's request-pool ceiling when `DB_POOL_MAX` is unset.
 *
 * **Not `postgres.js`'s generic default of 10.** That default suits this
 * package's many small consumers — migrations and test pools run at `max: 1` —
 * but the `api`'s ceiling is a documented deployment property, 24
 * (`deploy/docker-compose.yml`'s `DB_POOL_MAX: "24"`). Stating it here rather
 * than inheriting the library default is what keeps the budget honest off the
 * deployed path: `scripts/dev-up.sh` sets no `DB_POOL_MAX`, so inheriting 10
 * would both under-size the pool and make a correctly-configured process
 * disagree with the budget describing it.
 *
 * **20 → 22.** `api/src/portfolios/read-throttle.interceptor.ts`'s
 * valuation-read ceiling went 2 → 4 (its own doc comment carries the
 * argument), taking `AR-18`'s per-tenant sum from 19 to 21 — above 20, so the
 * `api` would have refused to boot. The slot was bought here rather than
 * taken from another route class: the deployment-wide bound this file asserts
 * is `sum(pools) <= PGMAX - reserve`, and the split shape's total moves
 * 27 → 29 against a default `PGMAX` of 100, so the outer bound is nowhere near
 * binding. Raising the pool is what a per-tenant
 * ceiling costs when the ceiling itself is the thing that was too low.
 *
 * **22 → 24.** The same shape, one cycle later: a
 * concurrency cap of 2 on the two *public* write routes (`POST /auth/setup`
 * and `POST /auth/login`, one shared `publicWriteThrottleInterceptor`),
 * because each of them runs Argon2id while holding two pooled connections
 * and nothing bounded how many anonymous callers could do so at once.
 * `AR-18`'s per-tenant sum stood at exactly 22 — the account-write entry had
 * consumed the last slot — so the new ceiling took it to 24 and the `api`
 * would have refused to boot. The slots were again bought here rather than
 * taken from another route class, for the same reason as above: the split
 * shape's total moves 29 → 31 against a default `PGMAX` of 100, so the outer
 * bound is still nowhere near binding.
 *
 * **24 → 40 (ADR-0016).** The ten per-tenant ceilings and their
 * zero-headroom sum are gone; the api now carries one instance-wide admission
 * bound derived from this pool (`api/src/common/admission-bound.interceptor.ts`,
 * `poolMax - 4`). Forty is comfortable rather than tight: the split shape's
 * total becomes 47 against a default `PGMAX` of 100, and a household's browser
 * tabs never come near it. Sized once, here, and read by
 * {@link requestConcurrencyCeiling}.
 */
export const API_REQUEST_POOL_MAX_DEFAULT = 40;

/** pg-boss's own internal `pg.Pool` ceiling, per process — passed explicitly to `PgBoss` rather than left at its `max: 10` default. */
export const PGBOSS_POOL_MAX = 2;

/** The ingest `postgres.js` pool ceiling wherever the worker's own work runs. Producer mode does not create this pool at all, so its contribution is `0`. */
export const INGEST_POOL_MAX = 2;

/**
 * The transient single-connection slot: `migrate` (drizzle as the bootstrap
 * superuser, then exits).
 *
 * It was "migrate **or** the nightly backup sidecar, never both at once" until
 * the backup pipeline was retired. The value does not change, and that is the point of
 * how it was sized: one slot for whichever transient owner-level
 * connection the deployment opens ("Deploy window: 5", peak `+ 1`). A future
 * export that dumps from a scheduled process takes this same slot and
 * needs no new arithmetic — as long as it, too, cannot overlap the deploy.
 */
export const TRANSIENT_POOL_MAX = 1;

/**
 * Which processes exist, and therefore which pools to count.
 *
 * - `split` — phase-1's shipped shape: an `api` in producer
 *   mode plus a separate `worker`. The api opens no ingest pool at all.
 * - `single-process` — `WORKER_IN_PROCESS=true` (R15): one
 *   process holds the request pool, the ingest pool and pg-boss, and there is
 *   no second process to count.
 */
export type DeploymentTopology = "split" | "single-process";

/** One pool's claim on the cluster. */
export interface PoolCeiling {
  /** Names the pool in the boot-failure table. */
  readonly label: string;
  /** The database role it connects as — the same axis the deploy's grants are reasoned about on. */
  readonly dbRole: "app_web" | "app_ingest" | "app_owner";
  /** Its `max`. The number the pool is actually constructed with, never a restatement of it. */
  readonly max: number;
}

export interface DeploymentPoolInputs {
  /** The `api` request pool's effective ceiling — {@link resolveApiRequestPoolMax}, or an explicit override. */
  readonly requestPoolMax: number;
  /** {@link DeploymentTopology}. */
  readonly topology: DeploymentTopology;
}

/**
 * Every pool the whole deployment opens, for one topology.
 *
 * Adding a pool anywhere means adding a line here. A pool that exists but is
 * missing from this list makes the budget optimistic by exactly its ceiling,
 * which is the failure mode ADR-0008's revisit trigger names ("a further pool
 * being added to any process — each new pool re-opens the arithmetic by
 * construction, that is the point").
 */
export function deploymentPoolCeilings(inputs: DeploymentPoolInputs): readonly PoolCeiling[] {
  const request: PoolCeiling = {
    label: "api request pool (DB_POOL_MAX)",
    dbRole: "app_web",
    max: inputs.requestPoolMax,
  };
  const transient: PoolCeiling = {
    label: "migrate (transient, exits before the stack is up)",
    dbRole: "app_owner",
    max: TRANSIENT_POOL_MAX,
  };

  if (inputs.topology === "single-process") {
    return [
      request,
      { label: "ingest pool (in-process worker)", dbRole: "app_ingest", max: INGEST_POOL_MAX },
      { label: "pg-boss pool", dbRole: "app_ingest", max: PGBOSS_POOL_MAX },
      transient,
    ];
  }

  return [
    request,
    { label: "api pg-boss pool (send only)", dbRole: "app_ingest", max: PGBOSS_POOL_MAX },
    { label: "worker ingest pool", dbRole: "app_ingest", max: INGEST_POOL_MAX },
    { label: "worker pg-boss pool", dbRole: "app_ingest", max: PGBOSS_POOL_MAX },
    transient,
  ];
}

/** Reads `PGMAX`, falling back to {@link DEFAULT_PGMAX}. */
export function resolvePgMax(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return parsePositiveIntEnv("PGMAX", DEFAULT_PGMAX);
}

/**
 * The `api`'s effective request-pool ceiling: `DB_POOL_MAX` when set, else
 * {@link API_REQUEST_POOL_MAX_DEFAULT}.
 *
 * **Stricter than `parsePositiveIntEnv` on a malformed value, deliberately.**
 * That helper warns and falls back, which is right for `createPostgresClient`'s
 * many small consumers — a test pool or a migration should not fail to open
 * because an unrelated env var is junk. A *budget* is the opposite case: it
 * exists to refuse rather than to proceed on a guess, and `DB_POOL_MAX=lots` in
 * a deployment is an operator error that a warning buried in boot logs does not
 * serve. `market/composition`'s own resolver threw here before `AR-17` and that
 * behaviour is kept.
 *
 * Unset or set-but-blank still falls back, per `platform/db`'s N7 lesson: those
 * are the normal "not configured" shapes, not a typo.
 */
export function resolveApiRequestPoolMax(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env["DB_POOL_MAX"];
  if (raw === undefined || raw.trim() === "") return API_REQUEST_POOL_MAX_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `[platform-db] DB_POOL_MAX must be a positive integer, got ${JSON.stringify(raw)}. ` +
        `Refusing to guess: the connection budget would then be sized for a pool the process ` +
        `does not open. Unset it to use the default (${API_REQUEST_POOL_MAX_DEFAULT}).`,
    );
  }
  return parsed;
}

/**
 * Resolves the topology from `APP_ROLE` and `WORKER_IN_PROCESS` together.
 *
 * **`WORKER_IN_PROCESS` alone is not enough, and reading it alone is a real
 * bug.** It is `true` in *two* different deployments:
 *
 * ```
 *   split           api    APP_ROLE=api     WORKER_IN_PROCESS=false
 *                   worker APP_ROLE=worker  WORKER_IN_PROCESS=true   <-- true
 *   single-process   api   APP_ROLE=api     WORKER_IN_PROCESS=true   <-- true
 * ```
 *
 * so a process that branched on it alone would have the split deployment's
 * worker declare itself `single-process` — counting one request pool that
 * container never opens, and *not* counting the api's own. That is optimistic
 * in one direction and pessimistic in the other, which is worse than either.
 *
 * `APP_ROLE=worker` settles it: a worker container existing at all means the
 * deployment is split, whatever that container runs in-process. Only an `api`
 * that is also running the worker's handlers is genuinely single-process.
 */
export function resolveDeploymentTopology(explicit?: DeploymentTopology): DeploymentTopology {
  if (explicit !== undefined) return explicit;
  if ((process.env["APP_ROLE"] ?? "").trim().toLowerCase() === "worker") return "split";
  return process.env["WORKER_IN_PROCESS"] === "true" ? "single-process" : "split";
}

/** The connections available to application roles. */
export function availableConnections(params: { pgMax: number }): number {
  return params.pgMax - RESERVED_CONNECTIONS;
}

/** What the deployment demands of the cluster at peak. */
export function sumPoolCeilings(ceilings: readonly PoolCeiling[]): number {
  return ceilings.reduce((total, pool) => total + pool.max, 0);
}

export interface AssertConnectionBudgetParams {
  /** Names the process in the failure message — `"api"`, `"worker"`, `"migrate"`. */
  readonly role: string;
  /** Overrides `DB_POOL_MAX`/{@link API_REQUEST_POOL_MAX_DEFAULT}. */
  readonly requestPoolMax?: number;
  /** Overrides `WORKER_IN_PROCESS`. */
  readonly topology?: DeploymentTopology;
  /** Overrides `PGMAX`/{@link DEFAULT_PGMAX}. */
  readonly pgMax?: number;
}

export interface ConnectionBudgetReport {
  readonly role: string;
  readonly topology: DeploymentTopology;
  readonly ceilings: readonly PoolCeiling[];
  readonly total: number;
  readonly available: number;
  readonly pgMax: number;
  /** The request-pool ceiling this process should build its pool with — resolved once, so the pool and the budget cannot disagree. */
  readonly requestPoolMax: number;
}

/** Resolves every input and reports the arithmetic without asserting it — for a boot log, a test, or a diagnostic. */
export function connectionBudget(params: AssertConnectionBudgetParams): ConnectionBudgetReport {
  const requestPoolMax = resolveApiRequestPoolMax(params.requestPoolMax);
  const topology = resolveDeploymentTopology(params.topology);
  const pgMax = resolvePgMax(params.pgMax);
  const ceilings = deploymentPoolCeilings({ requestPoolMax, topology });

  return {
    role: params.role,
    topology,
    ceilings,
    total: sumPoolCeilings(ceilings),
    available: availableConnections({ pgMax }),
    pgMax,
    requestPoolMax,
  };
}

/**
 * The per-process request-concurrency ceiling implied by this budget's own pool
 * sizing — ADR-0008's export, and what `AR-18`'s per-tenant throttle
 * ceilings are sized against.
 *
 * It is the request pool's `max` and nothing more: a request holds at most one
 * pooled connection at a time, so the pool is the admission bound. Exposed
 * under its own name, rather than leaving callers to read `requestPoolMax`,
 * because the whole point is that the throttles *derive* this value instead of
 * restating it — a caller asking "what may I admit?" should not have to know
 * that the answer happens to be a pool size.
 */
export function requestConcurrencyCeiling(explicit?: number): number {
  return resolveApiRequestPoolMax(explicit);
}

/**
 * Throws unless the whole deployment's pool ceilings fit inside the cluster.
 *
 * Call before opening any pool. The message names the arithmetic rather than
 * merely reporting a violation, because whoever trips this is by construction
 * someone who changed one ceiling without knowing the others existed — the
 * useful thing to hand them is the table, not the total.
 */
export function assertConnectionBudget(
  params: AssertConnectionBudgetParams,
): ConnectionBudgetReport {
  const report = connectionBudget(params);
  if (report.total <= report.available) return report;

  const breakdown = report.ceilings
    .map((pool) => `  ${String(pool.max).padStart(3)}  ${pool.label}  [${pool.dbRole}]`)
    .join("\n");

  throw new Error(
    `[platform-db] ${report.role} refuses to boot: the ${report.topology} deployment's connection ` +
      `ceilings sum to ${report.total}, above the ${report.available} available to application roles.\n` +
      `${breakdown}\n` +
      `  ---\n  ${String(report.total).padStart(3)}  total  (must be <= ${report.available})\n\n` +
      `Available = PGMAX ${report.pgMax} - ${RESERVED_CONNECTIONS} reserved ` +
      `(${SUPERUSER_RESERVED_CONNECTIONS} superuser + ${OPERATOR_RESERVED_CONNECTIONS} operator).\n` +
      `Lower DB_POOL_MAX, or raise PGMAX only after confirming the cluster's own max_connections ` +
      `actually allows it — raising the budget without raising the server moves the exhaustion from ` +
      `this assertion to Postgres itself, which is the failure mode this exists to prevent.`,
  );
}
