-- SH-34 — the shared ops-indicator table and its grants, FR-48/FR-49.
--
-- **What this is for.** FR-48 names five conditions a single owner running
-- this on a home server would want to notice, and FR-49 fixes the two
-- delivery channels: `GET /health` reports the current value (pull), and an
-- ERROR-level log line fires the moment a condition first breaches (push).
-- Neither channel can exist without a place to keep the verdict, because the
-- conditions are not all observable from one process: the API cannot see the
-- worker's in-process `CircuitBreaker`, `app_web` has no grant on the
-- `pgboss` schema so it cannot count a dead-letter queue, and the backup
-- volume is mounted into the worker. One row per condition, written by
-- whoever can see it and read by whoever answers `/health`.
--
-- It is also what makes the push channel outlive its own medium. FR-31 pins
-- the Docker `json-file` driver at 10 MB x 5, so "since when has this been
-- broken?" stops being answerable from logs after a busy week;
-- `first_breached_at` is durable and answers it. That column is equally what
-- keeps the push channel quiet: the sweep emits an ERROR only on the
-- `OK -> BREACHED` transition, so a breach that persists for a week costs one
-- line rather than one per sweep interval (the delivery
-- rationale — a per-sweep line would rotate the evidence out of the very
-- driver the channel is delivered through).
--
-- **`proxy_trust` is deliberately absent**, and that is the one
-- stated exception rather than an oversight: the proxy-trust anomaly (FR-48
-- item 5) is observable only inside the API process, and routing it through
-- this table would mean granting `app_web` INSERT/UPDATE here for a single
-- diagnostic. `api/src/proxy-trust-monitor.ts` reports it from in-process
-- state. Recorded here so a later reader does not "fix" the inconsistency by
-- widening the grant below.
--
-- **Deliberately no `tenant_id` and no RLS** — operational data about the
-- deployment, not about any tenant, exactly like `provider_fetch_log` and
-- `market_data_epoch`. Its `tools/tenant-column-gate`
-- `SHARED_REFERENCE_TABLE_ALLOWLIST` entry lands in this same change (the
-- gate otherwise fails CI, which is correct). No `numeric` and no float column at all: every threshold
-- comparison happens in the worker's sweep, and what lands here is a verdict
-- plus a short, allow-listed prose `detail`.
--
-- `state` is CHECK-constrained to `('OK','BREACHED')`. The third value
-- `/health` can report — `UNKNOWN` — exists only in the *payload* and means
-- "there is no row", which is precisely the fact a row cannot carry. The
-- sweep therefore never writes a placeholder `OK` row for a condition it has
-- not actually evaluated: "never swept" and "swept, fine" are different facts
-- and stay different.
--
-- **Grants are in this same migration** (this repo's recorded rule — a
-- missing `app_web` grant on `instrument_backfill_state` shipped and died
-- inside a catch block for weeks, invisible because Testcontainers connects
-- as the superuser). `app_ingest` is the **writer**: the sweep runs in the
-- worker, whose ingest pool authenticates as that role, and it needs
-- `SELECT` too because the transition detection reads the previous row in the
-- same statement it upserts (`INSERT ... ON CONFLICT DO UPDATE`, which reads
-- `ops_indicator.state` through the excluded/target rows). `app_web` is the
-- **reader** and gets `SELECT` only — `/health`'s single statement — because
-- an endpoint reachable without credentials must not be able to write the
-- table it reports from. Neither role gets `DELETE`: a row, once swept, is
-- the record that the condition was swept at all.
--
-- Proven against both real roles by
-- `platform/db/src/ops-indicator.integration.test.ts`, which connects as
-- `app_ingest`/`app_web` rather than the container superuser.
--
-- Does not touch `transaction`, `transaction_posting`, or `holding_state`
-- (AC47's guarantee, re-asserted here since this migration touches grants).
CREATE TABLE "ops_indicator" (
	"indicator_key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"first_breached_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"detail" text,
	CONSTRAINT "ops_indicator_state" CHECK ("ops_indicator"."state" IN ('OK','BREACHED'))
);
--> statement-breakpoint

ALTER TABLE "ops_indicator" OWNER TO app_owner;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "ops_indicator" TO app_ingest;--> statement-breakpoint
GRANT SELECT ON "ops_indicator" TO app_web;
