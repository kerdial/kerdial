-- `security-transfer`: the **9th and 10th** transaction kinds,
-- `TRANSFER_OUT` (source leg) and `TRANSFER_IN` (target leg) — a units-only
-- move of a holding from one portfolio to another (FR-559).
--
-- Both legs are `SHARE_DISTRIBUTION`'s cashless row shape (`0056`): an
-- instrument and a quantity, the market value in `gross_amount` (so
-- `transaction_gross_amount_positive` is satisfied honestly), a `txn_currency`
-- that denominates it, and no price, no cash leg, no cost. The target row
-- additionally carries the link and the carried cost:
--
--   - `transfer_source_id uuid` — the target's pointer at its source row,
--     target → source only (DRIP's `source_dividend_id` direction). Plain FK
--     `transaction_transfer_source_id_fk`, **`ON DELETE NO ACTION`**: a delete
--     path that removed a source without handling its partner raises `23503`
--     instead of silently severing the pair, and `deletePortfolio`'s final
--     `DELETE` stays the no-orphans proof. NULL once severed (FR-580).
--   - `transfer_cost_base` / `transfer_cost_native numeric(38,12)` — the cost
--     basis the source replay removed (`before − after`), at
--     `cost_basis_base`'s scale;
--   - `transfer_cost_currency char(3)` — what `transfer_cost_native` is
--     denominated in (OD-9/ND-1), distinct from `txn_currency`.
--
-- `transaction_transfer_source_id_key` — unique on `(tenant_id,
-- transfer_source_id) WHERE transfer_source_id IS NOT NULL`: one target per
-- source (FR-565), and the reverse lookup.
--
-- **Columns on the existing table, no new table** — so no `OWNER TO
-- app_owner`, no RLS policy and no GRANT: `0007` grants `transaction` at table
-- level and the table already carries `tenant_id NOT NULL` with RLS enabled and
-- forced.
--
-- ## ADR-0012's escalation trigger does not fire, and this is the check
--
--   (1) a fourth FX/provenance column group — **no**: the `transfer_cost_*`
--       columns carry no rate, source, provider key, observed-on date or user
--       input. The groups stay 2 (`fx_rate*`, `wht_fx_rate*`);
--   (2) a second instrument leg on one row — **no**: two linked rows, one
--       instrument leg each;
--   (3) the per-kind CHECK matrix exceeding **10 kinds** — **no, exactly 10,
--       headroom 0**. The next kind trips it unconditionally;
--   (4) a fifth per-money-leg column group — **no**: a money leg is one that
--       emits a CASH posting, and the carried-cost group emits no posting of
--       any kind. Recorded honestly: it is three columns used by exactly one
--       kind, the pattern ADR-0012's context names as compounding cost.
--
-- ## The CHECKs — net CHECK count on `transaction`: **36 -> 40**
--
--   - `transaction_transfer_out_shape` — `0056`'s shape, label changed;
--   - `transaction_transfer_in_shape` — the same, plus the three carried-cost
--     columns NOT NULL, plus `transfer_source_id` never equal to the row's own
--     `id`;
--   - `transaction_transfer_columns_only_on_transfer_in` — the four transfer
--     columns are NULL on every other kind, `TRANSFER_OUT` included, so the OUT
--     shape need not repeat them;
--   - `transaction_transfer_cost_non_negative` — `>= 0`, deliberately not the
--     house `> 0`: a holding acquired only through free distributions carries
--     a real cost of exactly zero, and "absent" is NULL, which the IN shape
--     forbids.
--
-- `transaction_fiat_principal_has_cash_account` and
-- `transaction_fiat_principal_has_cash_currency` are dropped and re-created
-- with `0056`'s per-kind exemption widened to the two transfer kinds —
-- replacements, so they move no count. Both transfer shapes force the three
-- cash columns NULL, so the pair stays total in both directions and the MATCH
-- SIMPLE hazard is not reopened (a NULL `cash_account_id` names no account).
--
-- What no CHECK can state — the referenced row is a `TRANSFER_OUT`, the legs
-- sit in different portfolios, and the target's instrument/quantity/date/
-- amount/currency/rate equal the source's — is held by
-- `TransactionWriteService`, the only writer of `TRANSFER_IN`.
--
-- Every existing row satisfies every new CHECK by its `kind` disjunct and its
-- NULL columns: the four columns are added nullable, with no default and no
-- backfill.
--
-- ## Two statement groups, and `::text` rather than the enum literal
--
-- `0056`'s reason, unchanged: Postgres refuses to *use* a newly added enum
-- value in the transaction that added it (`55P04`), and drizzle's migrator
-- runs every pending migration in one transaction, so a separate file would
-- not help. Every comparison below is on `kind::text`, which never presents
-- the new labels to the enum.
--
-- Every statement is `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` +
-- `ADD CONSTRAINT`, so a second execution changes nothing and re-validates
-- every row.

-- Group 1 — the enum values. Nothing below may mention them to the enum.
ALTER TYPE "public"."transaction_kind" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';--> statement-breakpoint
ALTER TYPE "public"."transaction_kind" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';--> statement-breakpoint

-- Group 2 — the columns, the link, and the constraints, all comparing `kind::text`.
ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "transfer_source_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "transfer_cost_base" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "transfer_cost_native" numeric(38, 12);--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN IF NOT EXISTS "transfer_cost_currency" char(3);--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_transfer_source_id_fk";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_source_id_fk" FOREIGN KEY ("transfer_source_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_transfer_source_id_key" ON "transaction" USING btree ("tenant_id","transfer_source_id") WHERE "transaction"."transfer_source_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_transfer_out_shape";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_out_shape" CHECK ("transaction"."kind"::text <> 'TRANSFER_OUT' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NOT NULL
        AND "transaction"."txn_currency" IS NOT NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."cash_account_id" IS NULL
        AND "transaction"."cash_currency" IS NULL
        AND "transaction"."cash_amount" IS NULL
        AND "transaction"."fee_amount" IS NULL
        AND "transaction"."withholding_amount" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_transfer_in_shape";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_in_shape" CHECK ("transaction"."kind"::text <> 'TRANSFER_IN' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NOT NULL
        AND "transaction"."txn_currency" IS NOT NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."cash_account_id" IS NULL
        AND "transaction"."cash_currency" IS NULL
        AND "transaction"."cash_amount" IS NULL
        AND "transaction"."fee_amount" IS NULL
        AND "transaction"."withholding_amount" IS NULL
        AND "transaction"."transfer_cost_base" IS NOT NULL
        AND "transaction"."transfer_cost_native" IS NOT NULL
        AND "transaction"."transfer_cost_currency" IS NOT NULL
        AND ("transaction"."transfer_source_id" IS NULL OR "transaction"."transfer_source_id" <> "transaction"."id")
      ));--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_transfer_columns_only_on_transfer_in";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_columns_only_on_transfer_in" CHECK ("transaction"."kind"::text = 'TRANSFER_IN' OR (
        "transaction"."transfer_source_id" IS NULL
        AND "transaction"."transfer_cost_base" IS NULL
        AND "transaction"."transfer_cost_native" IS NULL
        AND "transaction"."transfer_cost_currency" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_transfer_cost_non_negative";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_transfer_cost_non_negative" CHECK ("transaction"."transfer_cost_base" IS NULL OR ("transaction"."transfer_cost_base" >= 0 AND "transaction"."transfer_cost_native" >= 0));--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fiat_principal_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fiat_principal_has_cash_account" CHECK ("transaction"."txn_currency" IS NULL OR "transaction"."kind"::text IN ('SHARE_DISTRIBUTION', 'TRANSFER_OUT', 'TRANSFER_IN') OR "transaction"."cash_account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fiat_principal_has_cash_currency";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fiat_principal_has_cash_currency" CHECK ("transaction"."txn_currency" IS NULL OR "transaction"."kind"::text IN ('SHARE_DISTRIBUTION', 'TRANSFER_OUT', 'TRANSFER_IN') OR "transaction"."cash_currency" IS NOT NULL);
