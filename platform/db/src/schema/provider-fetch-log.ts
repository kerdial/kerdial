import { integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The fetch outcomes are not a closed set —
 * `SUCCESS`/`FAILURE`/`RATE_LIMITED` map onto the three cases
 * (`ProviderRateLimited`, `ProviderUnavailable`/other failures) actually
 * distinguish for alerting purposes (T-3's circuit-breaker/staleness
 * alerts, AC40).
 */
export const providerFetchStatusEnum = pgEnum("provider_fetch_status", [
  "SUCCESS",
  "FAILURE",
  "RATE_LIMITED",
]);

/**
 * `provider_fetch_log` — "(provider, endpoint,
 * status, latency, rows, error) supports AC40's automated staleness checks
 * and gives the tester something to assert against." Shared
 * operational/reference data: no `tenant_id` — a fetch log entry describes
 * a provider call, not a tenant's data. Column shape only here;
 * the ingestion code that writes rows here is T-33-T-35.
 */
export const providerFetchLog = pgTable("provider_fetch_log", {
  id: uuid("id").primaryKey(),
  providerKey: text("provider_key").notNull(),
  endpoint: text("endpoint").notNull(),
  status: providerFetchStatusEnum("status").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  rowsFetched: integer("rows_fetched").notNull().default(0),
  error: text("error"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
