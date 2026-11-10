import { randomUUID } from "node:crypto";
import { providerFetchLog, type Db } from "@kerdial/platform-db";

/**
 * `provider_fetch_log`'s closed status set (`platform/db/src/schema/provider-fetch-log.ts`).
 * Re-declared as a local literal union (rather than imported as a value from
 * the Drizzle enum) purely for a clean type import here — the column itself
 * enforces the same three values at the database level.
 */
type ProviderFetchStatus = "SUCCESS" | "FAILURE" | "RATE_LIMITED";

/** One row's worth of data for `provider_fetch_log`: "(provider, endpoint, status, latency, rows, error)." */
interface ProviderFetchLogEntry {
  readonly providerKey: string;
  readonly endpoint: string;
  readonly status: ProviderFetchStatus;
  readonly latencyMs: number;
  readonly rowsFetched: number;
  readonly error?: string | undefined;
}

/**
 * Writes exactly one `provider_fetch_log` row per call — T-33's
 * acceptance criterion: "Every fetch attempt (success or failure)
 * produces exactly one `provider_fetch_log` row." `provider_fetch_log`
 * carries no `tenant_id` (shared operational data, `platform/db/src/schema/
 * provider-fetch-log.ts`) so this is a plain `INSERT`, never `withTenant`.
 *
 * The `db` passed here should be an `app_ingest`-scoped connection
 * (migration `0007_roles-grants-rls.sql`'s grant of
 * `SELECT, INSERT, UPDATE` on this table to `app_ingest`) — mirroring how
 * `ledger`/`valuation` use an `app_web`-scoped `Db` for their own writes.
 * Provisioning *which* role a real deployed worker process connects as is a
 * T-2/T-3 deployment decision, deferred pending user approval (this is
 * the mechanism only); this module itself is role-agnostic
 * and simply issues an `INSERT` against whatever `Db` it is given.
 */
async function recordProviderFetch(db: Db, entry: ProviderFetchLogEntry): Promise<void> {
  await db.insert(providerFetchLog).values({
    id: randomUUID(),
    providerKey: entry.providerKey,
    endpoint: entry.endpoint,
    status: entry.status,
    latencyMs: entry.latencyMs,
    rowsFetched: entry.rowsFetched,
    error: entry.error ?? null,
  });
}

/** A `logFetch` function bound to a specific `Db` — the shape `market/composition`'s `provider-lanes.ts` depends on, so its unit tests can inject an in-memory recorder instead of a real database. */
export type FetchLogger = (entry: ProviderFetchLogEntry) => Promise<void>;

/** Builds a {@link FetchLogger} backed by a real `provider_fetch_log` insert against `db`. */
export function createDbFetchLogger(db: Db): FetchLogger {
  return (entry: ProviderFetchLogEntry) => recordProviderFetch(db, entry);
}
