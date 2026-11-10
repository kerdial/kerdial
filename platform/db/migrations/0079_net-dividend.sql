-- Net-dividend: a DIVIDEND/INTEREST withholding becomes ONE amount,
-- `withholding_amount`, denominated by the settling cash account
-- (`cash_currency`), converted at the principal's implied rate and posted on
-- the principal's account — a trade cost component's construction (L5). Its
-- own currency, FX rate group and cash account are dropped here.
--
-- drizzle-kit generated (generated name: `0079_romantic_mole_man`; file and
-- journal tag renamed to the descriptive form every migration here uses), and
-- `meta/0079_snapshot.json` is byte-identical to what the generator wrote.
-- Hand edits, all additions the schema diff cannot express: (1) the guard,
-- first; (2) the trigger function, before the columns go; (5) the `TRUNCATE`,
-- last. The generated statements (3) and (4) are unchanged and in generated
-- order. `db:generate` re-run afterwards reports "No schema changes".
--
-- **No data migration (a non-goal).** The owner deletes every
-- DIVIDEND/INTEREST carrying a withholding before deploying this. A row left
-- behind would silently change meaning — its amount, stored in
-- `withholding_currency`, would be re-read as `cash_currency` and posted at the
-- principal's rate — so (1) refuses loudly instead of relying on the deletion.
-- (1) counts every kind, not only DIVIDEND/INTEREST: the expander posts a TAX
-- leg for any row with `withholding_amount`, so a row of any other kind would
-- be re-read the same way. No application path writes one; the guard is total
-- at no cost and names no enum literal (so `0075`'s `55P04` rule cannot arise).
--
-- **Order (`0049`'s F6).** PL/pgSQL bodies are not validated against the
-- catalogue, so dropping `wht_fx_rate*` while `trg_transaction_fx_immutable_fn`
-- still names them commits clean and then fails every `UPDATE` on
-- `transaction` with `42703`. (2) therefore precedes (4).
--
-- **`transaction_interest_shape`** is re-created, not dropped: its withholding
-- conjunct compared `withholding_amount < gross_amount` only when
-- `withholding_currency = txn_currency`. It now compares with `cash_amount`,
-- the principal cash amount in the very currency the withholding is
-- denominated by — NOT NULL on every INTEREST through the cash-account pairing
-- CHECKs — so the rule is exact in every currency combination. The write
-- service checks the same rule first, for a named error. `transaction_
-- dividend_shape` is unchanged (`fee_amount IS NULL` stays: a dividend has no
-- cost component). `withholding_amount` and
-- `transaction_withholding_amount_positive` stay.
--
-- **Why `TRUNCATE`** (`0078`'s reasoning): the rows deleted by hand bump no
-- `calc_epoch`, so cached valuations would keep their withholding effect
-- forever. `portfolio_daily_valuation` is a lazy cache the materialiser
-- rebuilds on the next read. `TRUNCATE` is not subject to RLS. `cash_balance`
-- and `transaction_posting` are rebuilt per portfolio on the next write and
-- need nothing here once the rows are gone.
--
-- `check(...)` constraints on `transaction`: 42 → **39** (−3:
-- `transaction_wht_cash_account_pairing`,
-- `transaction_withholding_amount_currency_pairing`,
-- `transaction_wht_has_cash_account`; `transaction_interest_shape` is dropped
-- and re-added). Composite cash-account FKs: 3 → **2**. ADR-0012: FX/provenance
-- groups 2 → 1 (principal only); the withholding is no longer a money-leg
-- column group. RF5: seven columns whose data cannot be restored — acceptable
-- because (1) proves none of them holds a value that matters.
-- No `GRANT`, no `OWNER TO` (no new table or column), RLS unchanged.

-- (1) Refuse loudly while any withholding remains.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
    FROM "transaction"
   WHERE withholding_amount IS NOT NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION '0079_net-dividend: % transaction(s) still carry a withholding (withholding_amount IS NOT NULL); delete them before migrating -- the withholding currency, rate and account columns are dropped and would change the meaning of those rows', remaining
      USING ERRCODE = 'P0001';
  END IF;
END
$$;
--> statement-breakpoint

-- (2) The trigger stops naming the withholding FX columns, BEFORE they go.
--     `0049`'s body verbatim minus its five `wht_fx_rate*` clauses, and with
--     `wht_fx_rate` removed from the RAISE message (F7: a message naming a
--     dropped column is a defect).
CREATE OR REPLACE FUNCTION trg_transaction_fx_immutable_fn() RETURNS trigger AS $$
BEGIN
  IF (
    NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_rate_source IS DISTINCT FROM OLD.fx_rate_source
    OR NEW.fx_rate_provider_key IS DISTINCT FROM OLD.fx_rate_provider_key
    OR NEW.fx_rate_observed_on IS DISTINCT FROM OLD.fx_rate_observed_on
    OR NEW.fx_rate_user_input IS DISTINCT FROM OLD.fx_rate_user_input
  ) AND coalesce(current_setting('app.fx_correction', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'transaction FX legs are immutable outside the correctFxRate() correction path (FR-57, FR-64, AC47) -- SET LOCAL app.fx_correction = ''on'' is required to change fx_rate and its source/provider_key/observed_on/user_input columns' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- (3) The constraints that name the columns about to go (generated).
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_wht_cash_account_pairing";--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_withholding_amount_currency_pairing";--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_wht_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_interest_shape";--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_wht_cash_account_fk";
--> statement-breakpoint

-- (4) The seven columns, then the re-created INTEREST shape (generated).
ALTER TABLE "transaction" DROP COLUMN "withholding_currency";--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "wht_fx_rate";--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "wht_fx_rate_source";--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "wht_fx_rate_provider_key";--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "wht_fx_rate_observed_on";--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "wht_fx_rate_user_input";--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "wht_cash_account_id";--> statement-breakpoint
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
          OR "transaction"."withholding_amount" < "transaction"."cash_amount"
        )
      ));--> statement-breakpoint

-- (5) Force re-materialisation (`0078`).
TRUNCATE "portfolio_daily_valuation";
