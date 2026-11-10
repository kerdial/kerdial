/**
 * The connection-budget assertion for the processes `createMarketRuntime`
 * builds — a thin delegation to `platform/db`'s own budget module since
 * `AR-17` (ADR-0008 Stage 8).
 *
 * **What moved, and why.** This file used to own the arithmetic: it summed
 * *this* process's three ceilings against `DB_CONNECTION_BUDGET`, and it
 * declared `DEFAULT_REQUEST_POOL_MAX = 10` **by value**, mirroring a constant
 * `platform/db` kept private, guarded by a drift test. Both were deliberate and
 * both were the wrong shape:
 *
 * - **Per-process was as far as it could see.** Its own header said a
 *   cluster-wide check here "would be a guess dressed up as a guarantee",
 *   because no process can discover its peers. True — but the peers do not need
 *   discovering, they are *declared* at deploy time, which is what
 *   `platform/db`'s `deploymentPoolCeilings` now does. The cluster-wide figure
 *   used to be held only in prose, and prose goes stale silently.
 * - **A drift test proves two constants are equal**, not that either matches
 *   what `postgres.js` was handed. A caller passing `options.max` explicitly
 *   diverged from the mirror with nothing failing anywhere.
 *
 * `platform/db` is where the pools are built, so it is where their ceilings are
 * declared and summed. Nothing is mirrored here any more.
 *
 * **`DB_CONNECTION_BUDGET` is retired** in favour of `PGMAX`. It expressed a
 * per-process ceiling that only ever stood in for the cluster's
 * `max_connections`; the replacement names the real quantity. (The
 * `REPLICA_COUNT` divisor that briefly accompanied it was struck by ADR-0016,
 * with the multi-replica phase.)
 */

import {
  assertConnectionBudget as assertDeploymentConnectionBudget,
  type ConnectionBudgetReport,
  type DeploymentTopology,
} from "@kerdial/platform-db";

export { INGEST_POOL_MAX, PGBOSS_POOL_MAX } from "@kerdial/platform-db";

/**
 * The three ceilings *this* process opens, reported on
 * {@link MarketRuntime.connectionCeilings}.
 *
 * **Informational since `AR-17`, not the assertion's input.** The boot check is
 * now deployment-wide, so these three numbers no longer bound anything on their
 * own — but they remain the honest answer to "what does this process itself
 * open?", which is what the mode and producer-wiring suites assert, and what
 * makes the per-process connection figures checkable rather than asserted.
 */
export interface ConnectionBudgetComponents {
  /** This process's HTTP request-pool ceiling — `DB_POOL_MAX` in `api`, `0` in the worker (which serves no requests and opens no such pool). */
  readonly requestPoolCeiling: number;
  /** `INGEST_POOL_MAX` in worker mode, `0` in producer mode — which genuinely never creates the pool. */
  readonly ingestPoolCeiling: number;
  /** `PGBOSS_POOL_MAX` whenever pg-boss is constructed at all, `0` when `INGESTION_DATABASE_URL` is unset. */
  readonly pgBossPoolCeiling: number;
}

export interface AssertConnectionBudgetParams {
  /** Names the process in the failure message — `"producer"`/`"worker"`, or whatever an entrypoint calls itself. */
  readonly role: string;
  /** Overrides `DB_POOL_MAX` — for tests, and for a caller that sizes its own request pool. */
  readonly requestPoolMax?: number;
  /** Overrides the `APP_ROLE`/`WORKER_IN_PROCESS` derivation — for tests. */
  readonly topology?: DeploymentTopology;
  /** Overrides `PGMAX` — for tests. */
  readonly pgMax?: number;
}

/**
 * Throws unless the whole deployment's pool ceilings fit inside the cluster. Called at construction time, before any pool is opened,
 * so an over-sized configuration fails fast instead of failing under load.
 *
 * The ingest and pg-boss ceilings are **not** parameters any more: which pools
 * a topology opens is a property of the topology, and `platform/db` derives it.
 * Producer mode genuinely never creates the ingest pool, and
 * `deploymentPoolCeilings` encodes that rather than trusting a caller to pass
 * `0`.
 */
export function assertConnectionBudget(
  params: AssertConnectionBudgetParams,
): ConnectionBudgetReport {
  return assertDeploymentConnectionBudget(params);
}
