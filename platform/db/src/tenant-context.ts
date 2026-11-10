import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";
import type { Db } from "./client.js";
import * as schema from "./schema/index.js";

/** Opaque tenant identifier — a UUID string (all IDs are UUIDv7). */
export type TenantId = string;

/** The transaction handle `withTenant`/`withFxCorrection` hand to the caller. */
export type Tx = PostgresJsTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (typeof value !== "string" || !UUID_SHAPE.test(value)) {
    throw new TypeError(`${label} must be a UUID string, got: ${JSON.stringify(value)}`);
  }
}

/**
 * The *only* sanctioned way to run a tenant-scoped
 * query against an RLS-protected table. Opens a transaction and, as its
 * first statement, runs `select set_config('app.tenant_id', $1, true)`.
 * The third argument to `set_config` — `true` — makes the setting
 * **transaction-local** (`SET LOCAL` semantics): it is guaranteed to have
 * reverted by the time this transaction commits or rolls back, so returning
 * the underlying connection to the pool can never leak this request's
 * tenant into the next request that happens to reuse the same physical
 * connection (the failure mode this function exists to make
 * structurally impossible, not merely avoided by discipline).
 *
 * There is no exported way to obtain a transaction handle from this module
 * without `set_config` running first — `run` only ever receives `tx` after
 * the call above has completed — so every query issued through `tx` is
 * necessarily tenant-scoped. Nothing in this module exposes a general
 * "start a transaction and let the caller decide what to SET" escape hatch.
 *
 * Fail-closed defence in depth: if some other code path queries an
 * RLS-protected table without ever going through `withTenant` (a bug, since
 * this is meant to be the only path), `app.tenant_id` is unset for that
 * query and T-8's policies (`current_setting('app.tenant_id', true)::uuid`)
 * make every tenant-owned table return zero rows rather than everything —
 * see `roles-and-rls.integration.test.ts` for that guarantee and
 * `tenant-context.integration.test.ts` for the proof that reusing a
 * pooled connection across two different tenants' calls to this function
 * carries no cross-tenant leakage.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: TenantId,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return run(tx);
  });
}

/**
 * The explicit, named affordance for setting
 * `app.fx_correction`, the session flag `trg_transaction_fx_immutable`
 * (T-6) requires before it allows an `UPDATE` to `transaction.fx_rate`.
 *
 * This is deliberately narrow, not a general "run arbitrary SQL with a
 * flag" escape hatch: it is the only function in this module that sets
 * this particular session variable, and it sets nothing else. Like
 * `withTenant`, it uses `set_config(..., true)`, so the flag is
 * transaction-local and is guaranteed gone once the transaction commits or
 * rolls back — it cannot leak into a later transaction on the same pooled
 * connection any more than `app.tenant_id` can.
 *
 * Must be called with a transaction handle already produced by
 * `withTenant` (`tx`'s `app.tenant_id` is already set), because correcting
 * an FX rate is itself a tenant-scoped write: `withFxCorrection` sets an
 * additional flag on an already tenant-scoped transaction, it does not open
 * one. `ledger`'s `TransactionWriteService.correctFxRate()` (T-22) is the
 * only intended caller.
 */
export async function withFxCorrection<T>(tx: Tx, run: (tx: Tx) => Promise<T>): Promise<T> {
  await tx.execute(sql`select set_config('app.fx_correction', 'on', true)`);
  return run(tx);
}

/**
 * The one legitimate exception to "every query
 * goes through `withTenant`": resolving a login's email happens *before*
 * `tenantId` is known (finding the tenant is the point of the lookup), so
 * there is no tenantId to pass `withTenant`. Migration
 * `0010_auth-bootstrap-lookup-policies.sql` adds a narrow, additional
 * PERMISSIVE `SELECT`-only policy on `app_user`, gated on equality against
 * this function's `app.auth_lookup_email` GUC, so a query run inside this
 * transaction sees *at most* the single row whose `email` equals `email` —
 * never "every tenant's users" — regardless of what `WHERE` clause (if any)
 * the caller's SQL itself uses. This is not a `BYPASSRLS`/table-owner
 * workaround: `app_web` still runs under `FORCE ROW LEVEL SECURITY` with no
 * exemption; it is one more of this table's policies, scoped exactly as
 * tightly as the lookup it exists for.
 *
 * Only `platform/auth`'s login path is the intended caller. Like
 * `withFxCorrection`, the GUC is transaction-local (`set_config(..., true)`)
 * and is gone by the time this transaction commits or rolls back.
 */
export async function withEmailLookup<T>(
  db: Db,
  email: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.auth_lookup_email', ${email}, true)`);
    return run(tx);
  });
}

/**
 * The session-lookup counterpart to
 * {@link withEmailLookup}: resolving a session cookie's token happens before
 * `tenantId` is known (the session row is exactly what reveals it).
 * Migration `0010_auth-bootstrap-lookup-policies.sql` adds a narrow
 * PERMISSIVE `SELECT`-only policy on `session`, gated on equality against
 * this function's `app.auth_lookup_token_hash` GUC (the lowercase-hex
 * encoding of the SHA-256 token hash), so a query in this transaction sees
 * at most the one session row whose `token_hash` matches — never another
 * tenant's sessions. Combined with `session.token_hash` being `UNIQUE`
 * (migration `0009`) and a 256-bit CSPRNG token being practically
 * unguessable, this lookup cannot be used to enumerate sessions.
 *
 * Only `platform/auth`'s session-validation path is the intended caller.
 */
export async function withSessionTokenLookup<T>(
  db: Db,
  tokenHashHex: string,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.auth_lookup_token_hash', ${tokenHashHex}, true)`);
    return run(tx);
  });
}
