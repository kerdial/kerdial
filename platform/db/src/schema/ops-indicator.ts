import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `ops_indicator` — SH-34
 * (FR-48/FR-49). The **shared** table the worker's
 * ops-indicator sweep writes and `GET /health` reads.
 *
 * ## Why a table at all, rather than one process asking the other
 *
 * The conditions are not all observable from one
 * process. The API cannot see the worker's in-process `CircuitBreaker`;
 * `app_web` has no grant on the `pgboss` schema, so it cannot count a
 * dead-letter queue. A row per condition, written by whoever can see it and read by
 * whoever answers `/health`, is the whole mechanism — no RPC, no second
 * port, no notification service (FR-49 forbids all three this cycle).
 *
 * It is also what makes the **push** channel survive log rotation. FR-31
 * caps the Docker `json-file` driver at 10 MB × 5, so "when did this start?"
 * is not answerable from logs alone after a busy week; `first_breached_at`
 * is durable and answers it.
 *
 * ## Only worker-observed indicators live here
 *
 * The rule, kept after the api-side `proxyTrust`
 * indicator: an anomaly observable only inside the API process is reported
 * from that process, never by granting `app_web` INSERT/UPDATE here for a
 * single diagnostic. Recorded so a later reader does not widen the grant.
 *
 * ## Shape
 *
 * `indicator_key` is the primary key — one row per condition, updated in
 * place, so the table's size is bounded by the number of conditions rather
 * than by time. `state` is CHECK-constrained to `('OK','BREACHED')`: the
 * third value `/health` can report, `UNKNOWN`, exists only in the *payload*
 * and means "no row", which is precisely the fact a row cannot carry.
 *
 * `first_breached_at` is what drives the once-per-transition ERROR line:
 * the sweep emits only when it writes a
 * row whose previous `state` was not `BREACHED`, so a persistent breach costs
 * one line, not one line per sweep interval. `last_ok_at` is its mirror, and
 * is what lets a cleared breach be told apart from one that never happened.
 *
 * **Deliberately no `tenant_id` and no RLS** — operational data about the
 * deployment, not about any tenant, exactly like `provider_fetch_log` and
 * `market_data_epoch`. Its `schema/README.md` shared-reference entry lands in
 * the same change.
 * No `numeric` and no float column at all: every threshold comparison happens
 * in the sweep, and what lands here is a verdict plus a short prose `detail`.
 */
export const opsIndicator = pgTable(
  "ops_indicator",
  {
    /**
     * One of `market/composition`'s `OPS_INDICATOR_KEYS` — the same four
     * strings `api/src/health.ts`'s `TABLE_BACKED_INDICATOR_KEYS` reads.
     * Deliberately `text`, not an enum type: a new condition should be a
     * migration-free addition on the writing side, and `/health` already
     * reports a key it does not know about by simply not reading it.
     */
    indicatorKey: text("indicator_key").primaryKey(),
    state: text("state").notNull(),
    /** When the sweep last *evaluated* this condition — not when it last changed. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    /** Set on the `OK → BREACHED` transition, cleared on the way back; the durable answer to "since when?". */
    firstBreachedAt: timestamp("first_breached_at", { withTimezone: true }),
    /** The last sweep at which this condition was `OK`. */
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    /**
     * A short, **allow-listed** operator-facing string. `/health` is designed
     * as if public, so the writer never puts an instrument
     * identity, a tenant-derived count or a monetary value here — the sweep
     * builds every one of these from a fixed vocabulary
     * (`ops-indicator-sweep.ts`'s `detail` builders), and `/health` bounds
     * whatever arrives to 200 characters as a second, independent limit.
     */
    detail: text("detail"),
  },
  (table) => [check("ops_indicator_state", sql`${table.state} IN ('OK','BREACHED')`)],
);
