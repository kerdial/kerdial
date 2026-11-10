-- 0047 — itemised transaction costs: five components beside the total
-- (`fee-tax-breakdown` phase 2, FR-213/FR-214 under L8).
--
-- **Additive only, and deliberately so.** The intended shape of this file was
-- five columns, six CHECKs, `CREATE OR REPLACE trg_transaction_fx_immutable_fn()`,
-- then the drop of `fee_currency`, the five `fee_fx_rate*` and
-- `fee_cash_account_id`. The drops are **not** here. 22 non-test files across
-- `api`, `ledger`, `load` and `web` still read those fields, and their
-- replacements land in Batches E2, F and H — so dropping them now (and from the
-- Drizzle schema, which `db:generate` requires) would leave the repository
-- unable to typecheck until the end of phase 2, while three of Batch E1's own
-- acceptance criteria require `pnpm test:main` to pass. Recorded and re-planned
-- later; the drops, F6's function re-create and the four dropped
-- constraints move to a single later migration where the last consumer goes
-- with them. F6's ordering rule is preserved there, inside one file:
-- **re-create the function before dropping the columns it names.**
--
-- Two consequences of doing the additive half first, both wanted:
--   * `trg_transaction_fx_immutable_fn()` keeps guarding `fee_fx_rate*` for as
--     long as those columns exist. Removing its clauses here would leave a live
--     FX column unguarded for three batches — AC47's enforcement layers, off.
--   * every row in the table satisfies the new CHECKs the instant they are
--     added (see below), so this migration cannot fail on real data.
--
-- **The `fee_amount IS NOT NULL` conjunct in the sum CHECK is load-bearing.**
-- Without it a row carrying components beside a NULL `fee_amount` evaluates
-- `NULL = <sum>` → NULL, and a CHECK passes on NULL: a constraint that reads as
-- an invariant and enforces nothing on exactly the shape it exists for. Its
-- first disjunct (all five components NULL) is the legacy shape and is true of
-- every pre-existing row, which is what makes the whole constraint satisfiable
-- at the instant it is added.
--
-- **No data migration** (L8): `fee_amount` keeps its meaning and its value, and
-- nothing backfills a component. Over this file's **statements** — this comment
-- block excluded — `grep -ci 'update "transaction"'` is 0, so AC-231 is
-- satisfied trivially rather than by assertion.
--
-- **No new table** (FR-229): the same, for `grep -ci 'create table'`, so AC-255
-- is recorded satisfied-vacuously with that citation, which is what FR-229 asks
-- for instead of silence.
--
-- **Both counts are stated over the statements, not over the file** (found
-- by the FT-48 gate). Run against the whole file each pattern matches the very
-- sentence quoting it and returns 1, so the unqualified claim was falsifiable by
-- the exact command it named. `0048`'s header already had the qualification;
-- this one now does too. The commands that reproduce the stated results are:
--
--   sed '/^--/d' 0047_transaction-cost-components.sql | grep -ci 'update "transaction"'
--   sed '/^--/d' 0047_transaction-cost-components.sql | grep -ci 'create table'
--
-- both 0.
--
-- `transaction` CHECK count: 31 after phase 1 → 37 here (+6); it becomes 34
-- once the later migration drops three with their columns.

ALTER TABLE "transaction" ADD COLUMN "broker_fee_amount" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "platform_fee_amount" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "fx_fee_amount" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "tax_amount" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "other_cost_amount" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_broker_fee_amount_positive" CHECK ("transaction"."broker_fee_amount" IS NULL OR "transaction"."broker_fee_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_platform_fee_amount_positive" CHECK ("transaction"."platform_fee_amount" IS NULL OR "transaction"."platform_fee_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fx_fee_amount_positive" CHECK ("transaction"."fx_fee_amount" IS NULL OR "transaction"."fx_fee_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_tax_amount_positive" CHECK ("transaction"."tax_amount" IS NULL OR "transaction"."tax_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_other_cost_amount_positive" CHECK ("transaction"."other_cost_amount" IS NULL OR "transaction"."other_cost_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_cost_components_sum_to_fee_amount" CHECK (("transaction"."broker_fee_amount" IS NULL AND "transaction"."platform_fee_amount" IS NULL AND "transaction"."fx_fee_amount" IS NULL AND "transaction"."tax_amount" IS NULL AND "transaction"."other_cost_amount" IS NULL) OR ("transaction"."fee_amount" IS NOT NULL AND "transaction"."fee_amount" = coalesce("transaction"."broker_fee_amount",0) + coalesce("transaction"."platform_fee_amount",0) + coalesce("transaction"."fx_fee_amount",0) + coalesce("transaction"."tax_amount",0) + coalesce("transaction"."other_cost_amount",0)));