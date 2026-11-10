-- **FT-28 + the deferred half of FT-27/FT-30: the fee FX leg is retired.**
--
-- Phase 2's schema change has five steps. Steps (1)
-- and (2) — five columns, six CHECKs — shipped in `0047`. Steps (3), (4) and (5)
-- are here, in `0047`'s own order, because **22 non-test files still read these
-- columns when `0047` was written** and dropping them then would have left the
-- repository unable to typecheck for three batches. Batches E2, F and H removed
-- the last of those readers; Batch H's was the final one.
--
-- ## The order is the whole point (finding **F6**)
--
-- `trg_transaction_fx_immutable_fn()` names `fee_fx_rate` and its four
-- companions (`0004_transaction-fx-immutable-trigger.sql:26-30`). PostgreSQL
-- does **not** validate a PL/pgSQL body against the catalogue at definition
-- time, and `DROP COLUMN` does not inspect trigger function bodies — so
-- dropping the columns while the function still names them **commits clean**,
-- and then every ordinary `UPDATE` on `transaction` fails at runtime with
-- `42703 record "new" has no field "fee_fx_rate"`. The migration would be green
-- and the table unwritable. That is F6, and it is why step (3) is first.
--
-- ## Why this is safe on existing data, measured rather than assumed
--
-- Dropping `fee_currency`/`fee_fx_rate*`/`fee_cash_account_id` makes
-- `expandPostings`' legacy cost branch unreachable — its guard is
-- `fee_currency IS NOT NULL` — so every stored row's cost re-derives through
-- the L5 branch instead, at the settling account's currency and the principal's
-- implied rate. On a row where those diverge, four things move: the posting's
-- currency, its base amount, its account attribution and its applied rate
-- (proved on `pre-phase1-degenerate-postings.ts:310-367`).
--
-- Measured against the live database before this migration was written:
--
--     total=313  with_cost=226  currency_differs=0  account_differs=0  rate_differs=0
--
-- All 226 costed rows have `fee_currency = txn_currency`,
-- `fee_cash_account_id = cash_account_id` and `fee_fx_rate = fx_rate`, so the
-- two branches produce identical postings for every row that exists and nothing
-- moves. `transaction-fee-fx-leg-retired.integration.test.ts` asserts that
-- count, so a divergent row cannot appear later without failing a test — and
-- since Batch H the write path can no longer produce one.
--
-- ## RF5
--
-- This is the migration RF5 describes: seven columns whose data **cannot be
-- restored** once dropped. `docs/release-notes.md` says so; the measurement
-- above is why it is an acceptable loss rather than an unquantified one.
--
-- `transaction` CHECK count: 36 after `0048` → **34** here (−2). The planned
-- arithmetic is 37 → 34 (−3); `0048` already dropped
-- `transaction_fee_amount_currency_pairing` already, so one of that
-- three is spent. Composite cash-account FKs: 4 → **3**.

-- (3) The trigger stops naming the columns, BEFORE they go. `0004`'s body
--     verbatim minus its five `fee_fx_rate*` clauses, and with `fee_fx_rate`
--     removed from the RAISE message — a message naming a dropped column is
--     F7's own defect class.
CREATE OR REPLACE FUNCTION trg_transaction_fx_immutable_fn() RETURNS trigger AS $$
BEGIN
  IF (
    NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_rate_source IS DISTINCT FROM OLD.fx_rate_source
    OR NEW.fx_rate_provider_key IS DISTINCT FROM OLD.fx_rate_provider_key
    OR NEW.fx_rate_observed_on IS DISTINCT FROM OLD.fx_rate_observed_on
    OR NEW.fx_rate_user_input IS DISTINCT FROM OLD.fx_rate_user_input
    OR NEW.wht_fx_rate IS DISTINCT FROM OLD.wht_fx_rate
    OR NEW.wht_fx_rate_source IS DISTINCT FROM OLD.wht_fx_rate_source
    OR NEW.wht_fx_rate_provider_key IS DISTINCT FROM OLD.wht_fx_rate_provider_key
    OR NEW.wht_fx_rate_observed_on IS DISTINCT FROM OLD.wht_fx_rate_observed_on
    OR NEW.wht_fx_rate_user_input IS DISTINCT FROM OLD.wht_fx_rate_user_input
  ) AND coalesce(current_setting('app.fx_correction', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'transaction FX legs are immutable outside the correctFxRate() correction path (FR-57, FR-64, AC47) -- SET LOCAL app.fx_correction = ''on'' is required to change fx_rate or wht_fx_rate and their source/provider_key/observed_on/user_input columns' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- (4) The constraints that name the columns about to go.
--     `transaction_fee_amount_currency_pairing` is absent from this list because
--     `0048` already dropped it.
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fee_cash_account_fk";
--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fee_cash_account_pairing";
--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fee_has_cash_account";
--> statement-breakpoint

-- (5) The seven columns. L6's retirement, made physical.
ALTER TABLE "transaction" DROP COLUMN "fee_currency";
--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "fee_cash_account_id";
--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "fee_fx_rate";
--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "fee_fx_rate_source";
--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "fee_fx_rate_provider_key";
--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "fee_fx_rate_observed_on";
--> statement-breakpoint
ALTER TABLE "transaction" DROP COLUMN "fee_fx_rate_user_input";
