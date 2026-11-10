-- the **8th** transaction kind: `SHARE_DISTRIBUTION`, a cashless
-- share distribution (the French *attribution d'actions gratuites*). Units
-- arrive, no money moves, and the holding's total cost basis is unchanged.
--
-- Before this migration **no cashless event of any kind was representable**:
-- `gross_amount` is `NOT NULL` and carries `transaction_gross_amount_positive`,
-- so an event that moves shares and no money had no legal row shape. The first
-- proposal — import such a row as a zero-cost `BUY` — is refused at three
-- layers (`transaction_buy_sell_shape` needs a `unit_price`;
-- `transaction_unit_price_positive` and `transaction_gross_amount_positive`
-- both refuse zero), and **those two positivity CHECKs are security-review
-- finding F1 (T-38)**: relaxing them to `>= 0` would reverse a security
-- constraint globally, for every kind and for manual entry, to serve one import
-- case. This migration relaxes neither. The new kind stores the distribution's
-- **market value** in `gross_amount` — the figure the source data already
-- supplies — so `> 0` is satisfied honestly, while `posting-expander.ts` emits
-- the position leg at exactly zero so the cost basis does not move.
--
-- ## ADR-0012's escalation trigger does not fire, and this is the check
--
--   (1) a fourth independent FX/provenance column group — **no**: a cashless
--       event has no money leg, and this adds no column at all;
--   (2) a second instrument leg on one transaction — **no**: one instrument
--       leg. (This is also why `txn_currency` stays non-NULL rather than the
--       row settling in an instrument: settling in one *would* be a second
--       instrument leg, and would trip this condition.)
--   (3) the per-kind CHECK matrix exceeding **10 kinds** — **no**: this is the
--       **8th** of 10. Two slots remain, and this migration consumes one.
--   (4) a fifth per-money-leg column group — **no**: no new per-leg dimension.
--
-- ## The row shape, and why two existing CHECKs had to gain an exemption
--
-- `transaction_share_distribution_shape` states the whole kind: an instrument
-- and a quantity, a `txn_currency` (which denominates `gross_amount` and
-- satisfies `transaction_currency_xor_settlement_instrument`), and NULL for
-- everything else — `unit_price`, the target and DRIP columns, **all three cash
-- columns**, `fee_amount` and `withholding_amount`.
--
-- `transaction_fiat_principal_has_cash_account` and
-- `transaction_fiat_principal_has_cash_currency` (`0039`/`0046`'s totality
-- CHECKs) both read "a row denominated in a currency settled through an account
-- in that currency". That was true by construction while every kind with a
-- `txn_currency` had a money leg. The 8th kind is the first row shape where
-- *denominated in* and *settled through* come apart, so each gains **one**
-- disjunct naming this kind and nothing else. That is a weakening for exactly
-- one kind, and the shape CHECK above closes it from the other side by forcing
-- that kind's three cash columns to NULL — so the pair stays total, and the
-- MATCH SIMPLE hazard the pairing CHECKs close is not reopened (a NULL
-- `cash_account_id` names no account, so there is no FK to skip).
--
-- Net CHECK count on `transaction`: **35 -> 36** (`transaction-check-count.ts`
-- carries the ledger; the two re-created CHECKs are replacements, not
-- additions).
--
-- ## Two statement groups, and `::text` rather than the enum literal
--
-- Postgres refuses to *use* a newly added enum value in the transaction that
-- added it (`55P04 unsafe use of new value ... New enum values must be
-- committed before they can be used`) — red-confirmed against a scratch
-- `postgres:17-alpine` before this file was written, with the naive
-- `kind <> 'SHARE_DISTRIBUTION'` spelling, which fails on the `ADD CONSTRAINT`.
--
-- **Splitting the `ALTER TYPE` into its own migration file would not help.**
-- `drizzle-orm@0.45.2`'s migrator (`pg-core/dialect.js`, `migrate()`) wraps
-- *every pending migration* in a single `session.transaction(...)`, so a fresh
-- database applies `0001`..`0056` in one transaction whatever the file
-- boundaries are. The group below is therefore separated by intent, and the
-- comparison is written against `kind::text`: comparing the column's text
-- rendering never presents the new label to the enum, so both groups apply in
-- one pass. `kind` is an enum, so its text rendering is one of eight known
-- labels — no padding, no case ambiguity.
--
-- Every statement is `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` +
-- `ADD CONSTRAINT`, so a second execution changes nothing and re-validates
-- every row.

-- Group 1 — the enum value. Nothing below may mention it to the enum.
ALTER TYPE "public"."transaction_kind" ADD VALUE IF NOT EXISTS 'SHARE_DISTRIBUTION';--> statement-breakpoint

-- Group 2 — the constraints, all comparing `kind::text`.
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_share_distribution_shape";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_share_distribution_shape" CHECK ("transaction"."kind"::text <> 'SHARE_DISTRIBUTION' OR (
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
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fiat_principal_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fiat_principal_has_cash_account" CHECK ("transaction"."txn_currency" IS NULL OR "transaction"."kind"::text = 'SHARE_DISTRIBUTION' OR "transaction"."cash_account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fiat_principal_has_cash_currency";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fiat_principal_has_cash_currency" CHECK ("transaction"."txn_currency" IS NULL OR "transaction"."kind"::text = 'SHARE_DISTRIBUTION' OR "transaction"."cash_currency" IS NOT NULL);
