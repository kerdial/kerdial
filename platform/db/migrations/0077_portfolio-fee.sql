-- PC-T1 (Batch B1) — FR-671, FR-672, AC-567, AC-588, PC-L5,
-- PC-L14.
--
-- drizzle-kit generated (generated name: `0077_fluffy_hellfire_club`; file and
-- journal tag renamed to the descriptive form every migration here uses), and
-- `meta/0077_snapshot.json` is byte-identical to what the generator wrote.
-- One hand edit only: the generated `ADD VALUE 'FEE'` became
-- `ADD VALUE IF NOT EXISTS 'FEE'` (the `0070`/`0074`/`0075` precedent) and
-- stays the first statement. `db:generate` re-run afterwards reports "No
-- schema changes detected".
--
-- **What.** `FEE`, the twelfth `transaction_kind`: a standalone portfolio fee
-- (custody, account keeping, debit interest…) debited from a named cash
-- account. WITHDRAWAL's shape (one negative cash leg), the principal leg
-- classified `FEE` (value leakage, never a contribution), and an optional
-- `instrument_id` that is a reference only — it emits no POSITION posting and
-- requests no price backfill. No new column, no data statement, no backfill:
-- every existing row passes the new CHECK by its `kind::text <> 'FEE'`
-- disjunct. No `GRANT`, no RLS change, no `OWNER TO` (no new table or column).
--
-- ## ADR-0012 check (the escalation trigger)
--
--   (1) another FX/provenance group — no: FEE uses the principal group only;
--       groups stay 2;
--   (2) a second instrument leg — no: FEE has no instrument leg at all; its
--       `instrument_id` is a reference that emits no POSITION posting;
--   (3) as re-stated 2026-10-21 — does not trip: kinds 11 → 12, but FEE adds
--       no column on `transaction` and no per-money-leg column group;
--   (4) a fifth per-money-leg column group — no: FEE emits one CASH posting
--       through the principal group; money-leg groups stay 4.
--
-- `check(...)` constraints on `transaction`: 41 → 42
-- (`transaction_fee_shape`).
--
-- ## Standing rule — no migration may ever present `'FEE'` to the enum
--
-- Postgres refuses to *use* an enum label in the transaction that added it
-- (`55P04`), and drizzle's migrator runs every pending migration in one
-- transaction. An **upgrade** — the existing database running this file and
-- any later one in that one transaction, which is what every deployment does —
-- is where it bites. (A fresh install does not: Postgres treats a new label of
-- a type created in the same transaction as safe — measured.)
-- So the rule is **permanent**, not just for this file: no later migration may
-- compare the column to `'FEE'` without `::text` (`kind = 'FEE'`,
-- `kind IN ('FEE')` or a `'FEE'` index predicate breaks every
-- upgrade that applies both). The CHECK below compares `kind::text`. (A runtime query, after
-- this has committed, may use the literal freely.)
--
-- ## The CHECK
--
-- `transaction_fee_shape` — `txn_currency` and `cash_account_id` required; no
-- quantity, unit price, target, DRIP link, fee or withholding (forbidding
-- `fee_amount` forbids the cost components transitively). `instrument_id` is
-- deliberately absent: NULL and a valid FK value both pass. No other CHECK
-- changes.
ALTER TYPE "public"."transaction_kind" ADD VALUE IF NOT EXISTS 'FEE';--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fee_shape" CHECK ("transaction"."kind"::text <> 'FEE' OR (
        "transaction"."txn_currency" IS NOT NULL
        AND "transaction"."cash_account_id" IS NOT NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."fee_amount" IS NULL
        AND "transaction"."withholding_amount" IS NULL
      ));