-- `trg_transaction_fx_immutable` — the second of
-- three independent AC47/FR-57 enforcement mechanisms (T-6's scope; the
-- other two are DB role grants, T-8, and the dependency-cruiser rule, T-30).
--
-- A BEFORE UPDATE trigger on "transaction" that raises unless the update is
-- accompanied by `SET LOCAL app.fx_correction = 'on'` in the same DB
-- transaction — a flag set only by `ledger/TransactionWriteService
-- .correctFxRate()` (FR-64's explicit user-correction path, built in T-22).
-- Batch jobs, migrations, and ad-hoc SQL all trip it. Guards all three
-- independently-resolved FX legs (principal, fee, withholding)
-- so re-running FX ingestion can never mutate any of them, not just the
-- principal rate.
--
-- Fires only when one of the FX-leg columns actually changes value (`IS
-- DISTINCT FROM`), not on every UPDATE of the row — editing an unrelated
-- field (e.g. `quantity`, `note`) never needs the session flag (T-22's
-- generic edit path stays unaffected).
CREATE OR REPLACE FUNCTION trg_transaction_fx_immutable_fn() RETURNS trigger AS $$
BEGIN
  IF (
    NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_rate_source IS DISTINCT FROM OLD.fx_rate_source
    OR NEW.fx_rate_provider_key IS DISTINCT FROM OLD.fx_rate_provider_key
    OR NEW.fx_rate_observed_on IS DISTINCT FROM OLD.fx_rate_observed_on
    OR NEW.fx_rate_user_input IS DISTINCT FROM OLD.fx_rate_user_input
    OR NEW.fee_fx_rate IS DISTINCT FROM OLD.fee_fx_rate
    OR NEW.fee_fx_rate_source IS DISTINCT FROM OLD.fee_fx_rate_source
    OR NEW.fee_fx_rate_provider_key IS DISTINCT FROM OLD.fee_fx_rate_provider_key
    OR NEW.fee_fx_rate_observed_on IS DISTINCT FROM OLD.fee_fx_rate_observed_on
    OR NEW.fee_fx_rate_user_input IS DISTINCT FROM OLD.fee_fx_rate_user_input
    OR NEW.wht_fx_rate IS DISTINCT FROM OLD.wht_fx_rate
    OR NEW.wht_fx_rate_source IS DISTINCT FROM OLD.wht_fx_rate_source
    OR NEW.wht_fx_rate_provider_key IS DISTINCT FROM OLD.wht_fx_rate_provider_key
    OR NEW.wht_fx_rate_observed_on IS DISTINCT FROM OLD.wht_fx_rate_observed_on
    OR NEW.wht_fx_rate_user_input IS DISTINCT FROM OLD.wht_fx_rate_user_input
  ) AND coalesce(current_setting('app.fx_correction', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'transaction FX legs are immutable outside the correctFxRate() correction path (FR-57, FR-64, AC47) -- SET LOCAL app.fx_correction = ''on'' is required to change fx_rate, fee_fx_rate, or wht_fx_rate and their source/provider_key/observed_on/user_input columns' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transaction_fx_immutable ON "transaction";
--> statement-breakpoint
CREATE TRIGGER trg_transaction_fx_immutable
  BEFORE UPDATE ON "transaction"
  FOR EACH ROW
  EXECUTE FUNCTION trg_transaction_fx_immutable_fn();
