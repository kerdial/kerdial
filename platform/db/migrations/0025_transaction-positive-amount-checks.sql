-- F1 (T-38): `PATCH /transactions/:id`
-- (`editTransaction`, a plain UPDATE built from any caller-supplied subset of
-- `transaction`'s columns) had no positivity check of its own on
-- quantity/unit_price/gross_amount/target_amount/fee_amount/
-- withholding_amount — every column each is documented "always positive" —
-- so a negative or zero value survived exactly as far as this table, and
-- PMP replay (`core/domain/src/pmp.ts`) has no sign
-- guard: a negative `quantity` update on a BUY, say, is applied to the
-- running position as a real (wrong-signed) movement rather than rejected,
-- producing a negative holding and a corrupted realized gain with an
-- otherwise legitimate-looking `transaction_revision` audit row.
--
-- This is the third of three independent enforcement layers for positivity
-- (mirroring FR-57/AC47's own three-layer pattern): (1)
-- `transactions.schema.ts`'s `editTransactionBodySchema` now uses
-- `positiveDecimal(...)` for all six fields, same as the create DTO; (2)
-- `TransactionWriteService.editTransaction` now calls `assertPositiveDecimal`
-- on any of the six present in `params.changes`; (3) these `CHECK`s, so an
-- out-of-band writer (a hand-run `UPDATE`, a future call site that forgets
-- (1)/(2)) is still rejected at the database, exactly like the six per-kind
-- shape `CHECK`s already on this table (`0003_ledger-schema.sql`). Each is
-- guarded `IS NULL OR` for the columns that are legitimately absent for some
-- `kind` (the per-kind field table); `gross_amount` is `NOT NULL`
-- already, so its own check needs no such guard. Every existing writer
-- (`record*`, and now `editTransaction`/`editTransactionBodySchema`) already
-- only ever produces a positive value here, so this is purely additive —
-- verified against this package's own integration test fixtures/seed data,
-- none of which write `transaction` rows directly.
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_quantity_positive" CHECK ("transaction"."quantity" IS NULL OR "transaction"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_unit_price_positive" CHECK ("transaction"."unit_price" IS NULL OR "transaction"."unit_price" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_gross_amount_positive" CHECK ("transaction"."gross_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_target_amount_positive" CHECK ("transaction"."target_amount" IS NULL OR "transaction"."target_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fee_amount_positive" CHECK ("transaction"."fee_amount" IS NULL OR "transaction"."fee_amount" > 0);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_withholding_amount_positive" CHECK ("transaction"."withholding_amount" IS NULL OR "transaction"."withholding_amount" > 0);