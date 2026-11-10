-- Two findings from the quality tail, in one migration because drizzle-kit
-- diffs the whole schema and splitting the diff by hand would mean
-- hand-editing the journal and the snapshots — the one place in this
-- repository where a hand edit is not worth the tidiness.
--
-- ## A DIVIDEND may not carry a cost leg (DB-level)
--
-- `transaction_dividend_shape` did not forbid `fee_amount`, so the invariant
-- "a DIVIDEND's only TAX posting is its withholding leg" held only through the
-- application layer (`transaction-create.schema.ts:360` plus
-- `TransactionCashLegNotAddableError`). A row written past the application —
-- manual SQL, a future import path, an `app_owner` maintenance session — could
-- carry a cost component that the dividend aggregate would misattribute.
-- Found by the `dividend-screen` cycle's architect stage (F1).
--
-- ### `NOT VALID`, and why the validating form was wrong
--
-- The live database holds **no** such row, measured before writing this rather
-- than assumed:
--
--     SELECT count(*) FROM "transaction"
--      WHERE kind='DIVIDEND' AND fee_amount IS NOT NULL;   -- 0
--
--     kind        | with_fee | total
--     BUY         |      163 |   180
--     SELL        |       68 |    70
--     DIVIDEND    |        0 |    31
--
-- That was not sufficient, and the validating form is what proved it. A
-- DIVIDEND carrying a cost leg was **legally writable under the old rules**,
-- and `cash-account-backfill.integration.test.ts`'s CA-5 fixture creates one
-- deliberately — "P2 (tenant A): DEPOSIT USD; DIVIDEND `txn=USD` + `wht=USD` +
-- `fee=EUR`; SELL USD" — because that suite exists to prove `0039`'s backfill
-- over the *legacy* corpus. The first version of this migration validated, and
-- it failed there:
--
--     Failed query: ALTER TABLE "transaction" ADD CONSTRAINT
--       "transaction_dividend_shape" CHECK (… AND fee_amount IS NULL)
--
-- Changing that fixture to let this migration pass would have been asserting a
-- false history — the row shape really existed, and it is the shape the suite
-- is about. `transaction-check-count.ts`'s own warning names this exact move
-- ("a test assertion changed to match new behaviour is only legitimate when
-- the behaviour change was intended").
--
-- So `NOT VALID`, following `0050`'s precedent and for the same reason it
-- records: **every INSERT and every UPDATE from here on is checked** — which
-- is the whole of what was asked for, an out-of-band writer, a restored dump,
-- a future importer path — while rows written under the old rules are left
-- where they are. Postgres enforces a `NOT VALID` CHECK on new and modified
-- rows; it skips only the initial full-table validation.
--
-- This is also what makes the read-time guard **load-bearing rather than
-- redundant**: `dividend-summary-service.ts` refuses a DIVIDEND carrying
-- `fee_amount` with a 422 (DV11), and a legacy row is precisely the case that
-- can still reach it.
--
-- **The cost-component columns get no conjuncts of their own.** They are bound
-- to the total by `transaction_cost_components_sum_to_fee_amount`, so
-- forbidding `fee_amount` forbids them transitively. Five more conjuncts would
-- read as five more rules.
--
-- **The CHECK count does not move: 37 -> 37.** This is a DROP and re-ADD of
-- one constraint, not a new one — `transaction-check-count.ts` carries the
-- ledger and records this row for the reader who sees a migration touch a
-- CHECK and goes looking for the bump.
--
-- ## `transaction_posting (tenant_id, leg, flow_class)`
--
-- `GET /dividends/summary`'s count-guard and its aggregate share one driving
-- scan over `transaction_posting`, and that scan was sequential **and
-- cross-tenant** — RLS filters after the scan, so the cost grew with every
-- tenant's postings rather than the caller's. The query plan,
-- reproduced against the live database on 2026-09-07 before this migration:
--
--     Seq Scan on transaction_posting p  (cost=0.00..43.21 rows=91)
--       Filter: ((flow_class = ANY ('{INCOME,TAX}'::flow_class[]))
--                AND (tenant_id = '…'::uuid) AND (leg = 'CASH'::posting_leg))
--
-- Three columns in that order, not the two `(tenant_id, flow_class)` the issue
-- suggested: the filter is exactly `tenant_id =` (equality, and RLS's own
-- column), `leg =` (equality), `flow_class IN (…)` (a small set), so leading
-- with both equalities and leaving the `IN` last is the order the planner can
-- use whole. It is also usable by any read filtering this table by tenant
-- alone, being a leading-column prefix — which `(transaction_id)`, the issue's
-- other candidate, would not have been.
--
-- This is RD5's recorded revisit trigger, now with measured
-- evidence rather than an estimate.
--
-- ## Neither half needs an ownership or grant statement
--
-- No new table and no new column: `0007` grants `transaction` and
-- `transaction_posting` to `app_web` at **table** level, and an index inherits
-- its table's ownership. The `ALTER … OWNER TO app_owner` rule applies to
-- post-`0007` **tables** (the trap `0058` records); a CHECK and an index are
-- neither. `roles-and-rls.integration.test.ts` is the suite that would catch
-- it if this reasoning were wrong.

ALTER TABLE "transaction" DROP CONSTRAINT "transaction_dividend_shape";--> statement-breakpoint
CREATE INDEX "transaction_posting_tenant_leg_flow_class_idx" ON "transaction_posting" USING btree ("tenant_id","leg","flow_class");--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_dividend_shape" CHECK ("transaction"."kind" <> 'DIVIDEND' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."fee_amount" IS NULL
      )) NOT VALID;
