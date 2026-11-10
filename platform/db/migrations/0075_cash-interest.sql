-- CI-T1 — CI-D1, CI-D2; FR-624, FR-625, FR-642, NFR-79,
-- CI-L1.
--
-- drizzle-kit generated (generated name: `0075_serious_prima`; file and
-- journal tag renamed to the descriptive form every migration here uses), and
-- `meta/0075_snapshot.json` is byte-identical to what the generator wrote.
-- One hand edit only: the generated `ADD VALUE 'INTEREST'` became
-- `ADD VALUE IF NOT EXISTS 'INTEREST'` (the `0070`/`0074` precedent) and stays
-- the first statement. `db:generate` re-run afterwards reports "No schema
-- changes detected".
--
-- **What.** `INTEREST`, the eleventh `transaction_kind`: interest earned on
-- cash. DEPOSIT's shape (one positive cash leg into a named cash account) plus
-- DIVIDEND's existing optional withholding group; the principal leg is
-- classified `INCOME`, the withholding `TAX`. No new column, no data
-- statement, no backfill: every existing row passes the new CHECK by its
-- `kind::text <> 'INTEREST'` disjunct (FR-642, NFR-79). No `GRANT`, no RLS
-- change, no `OWNER TO` (no new table or column).
--
-- ## ADR-0012 check (the escalation trigger)
--
--   (1) another FX/provenance group — no: the principal and withholding
--       groups already exist; groups stay 2;
--   (2) a second instrument leg — no: INTEREST has no instrument leg;
--   (3) as re-stated 2026-10-21 (owner decision CI-L1) — does not trip: the
--       matrix goes 10 → 11 kinds, but INTEREST adds no column on
--       `transaction` and no per-money-leg column group (as originally
--       written, 10 → 11 would have tripped it);
--   (4) a fifth per-money-leg column group — no: INTEREST emits at most two
--       CASH postings, principal and withholding, both through existing
--       groups; money-leg groups stay 4.
--
-- `check(...)` constraints on `transaction`: 40 → 41
-- (`transaction_interest_shape`).
--
-- ## Standing rule — no migration may ever present `'INTEREST'` to the enum
--
-- Postgres refuses to *use* an enum label in the transaction that added it
-- (`55P04`), and drizzle's migrator runs every pending migration in one
-- transaction. An **upgrade** — the existing database running this file and
-- any later one in that one transaction, which is what every deployment does —
-- is where it bites. (A fresh install does not: Postgres treats a new label of
-- a type created in the same transaction as safe — measured.)
-- So the rule is **permanent**, not just for this file: no later migration may
-- compare the column to `'INTEREST'` without `::text` (`kind = 'INTEREST'`,
-- `kind IN ('INTEREST')` or an `'INTEREST'` index predicate breaks every
-- upgrade that applies both). The CHECK below compares `kind::text`. (A runtime query, after
-- this has committed, may use the literal freely.)
--
-- ## The CHECK
--
-- `transaction_interest_shape` — `txn_currency` and `cash_account_id`
-- required; no instrument, quantity, unit price, target, DRIP link or fee
-- (forbidding `fee_amount` forbids the cost components transitively); and a
-- same-currency withholding strictly below the gross. A cross-currency
-- withholding passes `IS DISTINCT FROM` and is compared in base by the write
-- service at write time (CI-D2). No other CHECK changes (CI-D1).
ALTER TYPE "public"."transaction_kind" ADD VALUE IF NOT EXISTS 'INTEREST';--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_interest_shape" CHECK ("transaction"."kind"::text <> 'INTEREST' OR (
        "transaction"."txn_currency" IS NOT NULL
        AND "transaction"."cash_account_id" IS NOT NULL
        AND "transaction"."instrument_id" IS NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."fee_amount" IS NULL
        AND (
          "transaction"."withholding_amount" IS NULL
          OR "transaction"."withholding_currency" IS DISTINCT FROM "transaction"."txn_currency"
          OR "transaction"."withholding_amount" < "transaction"."gross_amount"
        )
      ));
