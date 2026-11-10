-- CA-4 (Batch A2) — CD4, CD6; FR-158, FR-159, FR-161, AC-178, AC-179.
--
-- The data-dependent half of this cycle. `0038` was schema, RLS and grants and
-- was true of existing data on the day it ran; **this file changes existing
-- rows**, and its last five statements are the assertion that it changed all
-- of them.
--
-- ## Why this file is hand-written where `0038` was generated
--
-- `drizzle-kit generate` produced (verbatim, run and kept for the record):
--
--     ALTER TABLE "cash_balance" DROP CONSTRAINT "cash_balance_tenant_id_portfolio_id_currency_pk";
--     ALTER TABLE "cash_balance" ADD CONSTRAINT "cash_balance_..._pk" PRIMARY KEY(...,"cash_account_id",...);
--     ALTER TABLE "cash_balance" ADD COLUMN "cash_account_id" uuid NOT NULL;
--     ALTER TABLE "cash_balance" ADD CONSTRAINT "cash_balance_cash_account_fk" ...;
--     -- + the five totality CHECKs
--
-- That output is **not runnable in any database, empty or not**: it declares
-- the new primary key on a column the next statement creates. Even reordered
-- it is wrong against real data — `ADD COLUMN ... NOT NULL` with no default
-- fails on a non-empty table, and there is no default that could be correct
-- here (the value is a per-row join result). The generator cannot model a
-- backfill, so the DDL is re-ordered by hand into
-- `add column (nullable) → fill → set not null → re-key`, and the DML is
-- written by hand. The generated *snapshot* is kept exactly as the generator
-- wrote it, which is what keeps `drizzle-kit generate` reporting "No schema
-- changes detected" afterwards: every object below is declared in
-- `src/schema/cash-balance.ts`, `transaction.ts` and `transaction-posting.ts`.
--
-- ## What it computes
--
--   1. One `cash_account` per `(portfolio, currency actually used)` — the
--      union of the four currency columns on that portfolio's transactions,
--      which is by construction the exact set statements 2–4 have to resolve,
--      so it cannot under-cover them. A portfolio with **no** transactions
--      gets **no** account: synthesising an empty EUR account for a portfolio
--      that never held cash would invent structure the user did not create,
--      which FR-159 forbids in spirit. The workspace's empty state offers
--      creation instead.
--   2–3. Attribution of the four `transaction` columns and of every CASH
--      `transaction_posting`, each by joining on
--      `(tenant_id, portfolio_id, currency)`.
--   4. `cash_balance` re-keyed **in place** to
--      `(tenant_id, portfolio_id, cash_account_id, currency)`. The amounts are
--      *not* recomputed, only re-keyed — cheaper, and strictly safer, because
--      an amount that is never read cannot change.
--
-- ## Resolution by currency, exactly once, and why it is legitimate here
--
-- Currency is rejected as a way to find an account, and that
-- rejection stands everywhere else in the system: a portfolio may hold any
-- number of EUR accounts (AC-172), so currency does not identify one. It is
-- legitimate in statements 2–4 and nowhere else, because statement 1 **built
-- the set being resolved against, inside this same transaction**, with exactly
-- one account per `(portfolio, currency)`. The mapping is unique by
-- construction at this instant and at no other. This is not a general
-- mechanism and no application code below may copy it.
--
-- ## The totality CHECKs are the completeness proof, not a formality
--
-- If a single row was missed, `ALTER TABLE … ADD CONSTRAINT … CHECK` fails,
-- Drizzle's per-file transaction rolls back, and the deployment stops loudly —
-- in **every** environment including production, not only where a test happens
-- to look. `cash_balance`'s `SET NOT NULL` plays the identical role for the
-- re-key: a balance row whose currency has no account aborts the migration
-- rather than being silently dropped or defaulted.
-- `cash-account-backfill.integration.test.ts` is the *other* half of the
-- proof, and it proves the thing a constraint structurally cannot: that real
-- rows existed for the constraint to be total over (this repo's single
-- most-recorded failure mode is an assertion that cannot tell "no violations"
-- from "nothing was there").
--
-- ## The true CHECK-count delta this file produces
--
-- Measured against the database, not carried over from the earlier arithmetic
-- (which did not add up — it stated 22, and itemises a set
-- that comes to 23 on `transaction` alone): `transaction` goes from **19**
-- CHECKs after `0038` to **23**; `transaction_posting` from **1** to **2**.
-- Four totality CHECKs on `transaction` (principal, target, fee, withholding —
-- one per cash-emitting currency column, which is what makes FR-158/AC-178
-- literally true) and one on `transaction_posting`, five in total. Asserted by
-- a `pg_constraint` count in `cash-account-backfill.integration.test.ts`
-- rather than by reading this comment.
--
-- ## Idempotence and re-runnability
--
-- Drizzle's journal already prevents this file from running twice in the
-- normal path; the guards exist for the case that actually happens — a
-- hand-run during recovery, or a partial apply. **The whole file is
-- re-runnable, not just its DML half**: statement 1 is
-- `ON CONFLICT DO NOTHING`, statements 2–4 are `WHERE … IS NULL`-guarded, and
-- every DDL statement below is either `IF EXISTS`/`IF NOT EXISTS` or a
-- `drop constraint if exists` immediately followed by its `add constraint`.
-- A second execution therefore changes zero rows and re-validates every
-- constraint rather than aborting on `42P07`/`42701`. Re-validating is a
-- feature, not a cost: it re-proves totality against whatever the data has
-- since become.
--
-- ## Gates
--
-- `tenant-column-gate` and `no-floats-schema-gate` both pass with no
-- allowlist edit: this file creates no table, and `cash_balance.amount` keeps
-- its `decimalCol(38,12)` — `cash_account_id` is an identifier and takes part
-- in no arithmetic anywhere in the system.

-- ---------------------------------------------------------------------------
-- (1) Synthesise one account per (portfolio, currency actually used).
--
-- `on conflict (tenant_id, portfolio_id, name) do nothing` is the idempotency
-- guard. It is safe against a pre-existing user-created account of the same
-- name only because no such account can exist: cash-account CRUD does not
-- ship until Batch C, so the only rows this table can hold when `0039` runs
-- are the ones this statement creates. Were that ever untrue, the skipped row
-- would leave its currency unresolvable in (2)–(4) and the totality CHECKs at
-- the bottom would roll the migration back — loudly, not silently.
-- ---------------------------------------------------------------------------
INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency, created_at, updated_at)
SELECT gen_random_uuid(),
       u.tenant_id,
       u.portfolio_id,
       'Compte espèce ' || u.currency || ' (créé automatiquement)',
       u.currency,
       now(),
       now()
  FROM (
        SELECT tenant_id, portfolio_id, txn_currency AS currency FROM "transaction" WHERE txn_currency IS NOT NULL
        UNION
        SELECT tenant_id, portfolio_id, target_currency      FROM "transaction" WHERE target_currency      IS NOT NULL
        UNION
        SELECT tenant_id, portfolio_id, fee_currency         FROM "transaction" WHERE fee_currency         IS NOT NULL
        UNION
        SELECT tenant_id, portfolio_id, withholding_currency FROM "transaction" WHERE withholding_currency IS NOT NULL
       ) u
ON CONFLICT (tenant_id, portfolio_id, name) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- (2) Attribute the four `transaction` columns. One UPDATE per money leg,
-- because one row can move cash in up to four different currencies and an
-- account is single-currency (CD1) — a single column could not express it.
-- ---------------------------------------------------------------------------
UPDATE "transaction" t
   SET cash_account_id = ca.id
  FROM "cash_account" ca
 WHERE ca.tenant_id = t.tenant_id
   AND ca.portfolio_id = t.portfolio_id
   AND ca.currency = t.txn_currency
   AND t.txn_currency IS NOT NULL
   AND t.cash_account_id IS NULL;--> statement-breakpoint

UPDATE "transaction" t
   SET target_cash_account_id = ca.id
  FROM "cash_account" ca
 WHERE ca.tenant_id = t.tenant_id
   AND ca.portfolio_id = t.portfolio_id
   AND ca.currency = t.target_currency
   AND t.target_currency IS NOT NULL
   AND t.target_cash_account_id IS NULL;--> statement-breakpoint

UPDATE "transaction" t
   SET fee_cash_account_id = ca.id
  FROM "cash_account" ca
 WHERE ca.tenant_id = t.tenant_id
   AND ca.portfolio_id = t.portfolio_id
   AND ca.currency = t.fee_currency
   AND t.fee_currency IS NOT NULL
   AND t.fee_cash_account_id IS NULL;--> statement-breakpoint

UPDATE "transaction" t
   SET wht_cash_account_id = ca.id
  FROM "cash_account" ca
 WHERE ca.tenant_id = t.tenant_id
   AND ca.portfolio_id = t.portfolio_id
   AND ca.currency = t.withholding_currency
   AND t.withholding_currency IS NOT NULL
   AND t.wht_cash_account_id IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- (3) Attribute every CASH posting, by the same join.
--
-- Done in SQL rather than by re-running `expandPostings`: this repo has no
-- application-code data-migration mechanism, and a re-expansion would need the
-- write service's whole FX apparatus to reproduce rows it already has. A
-- POSITION leg is deliberately untouched — it moved no cash, and `0039`'s
-- `transaction_posting_cash_leg_has_account` asserts exactly that equality in
-- both directions.
-- ---------------------------------------------------------------------------
UPDATE "transaction_posting" p
   SET cash_account_id = ca.id
  FROM "cash_account" ca
 WHERE ca.tenant_id = p.tenant_id
   AND ca.portfolio_id = p.portfolio_id
   AND ca.currency = p.currency
   AND p.leg = 'CASH'
   AND p.cash_account_id IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- (4) Re-key `cash_balance` in place (CD4).
--
-- `SET NOT NULL` below is the re-key's own completeness proof, the same move
-- as the totality CHECKs: a balance row whose `(portfolio, currency)` has no
-- account would abort the migration here rather than be quietly dropped or
-- defaulted to some other account's id.
-- ---------------------------------------------------------------------------
ALTER TABLE "cash_balance" ADD COLUMN IF NOT EXISTS "cash_account_id" uuid;--> statement-breakpoint

UPDATE "cash_balance" cb
   SET cash_account_id = ca.id
  FROM "cash_account" ca
 WHERE ca.tenant_id = cb.tenant_id
   AND ca.portfolio_id = cb.portfolio_id
   AND ca.currency = cb.currency
   AND cb.cash_account_id IS NULL;--> statement-breakpoint

ALTER TABLE "cash_balance" ALTER COLUMN "cash_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_balance" DROP CONSTRAINT IF EXISTS "cash_balance_tenant_id_portfolio_id_currency_pk";--> statement-breakpoint
ALTER TABLE "cash_balance" DROP CONSTRAINT IF EXISTS "cash_balance_tenant_id_portfolio_id_cash_account_id_currency_pk";--> statement-breakpoint
ALTER TABLE "cash_balance" ADD CONSTRAINT "cash_balance_tenant_id_portfolio_id_cash_account_id_currency_pk" PRIMARY KEY("tenant_id","portfolio_id","cash_account_id","currency");--> statement-breakpoint
ALTER TABLE "cash_balance" DROP CONSTRAINT IF EXISTS "cash_balance_cash_account_fk";--> statement-breakpoint
ALTER TABLE "cash_balance" ADD CONSTRAINT "cash_balance_cash_account_fk" FOREIGN KEY ("tenant_id","portfolio_id","cash_account_id","currency") REFERENCES "public"."cash_account"("tenant_id","portfolio_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- (5) The totality CHECKs — the proof that (1)–(4) were total.
-- ---------------------------------------------------------------------------
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fiat_principal_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fiat_principal_has_cash_account" CHECK ("transaction"."txn_currency" IS NULL OR "transaction"."cash_account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_target_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_target_has_cash_account" CHECK ("transaction"."target_currency" IS NULL OR "transaction"."target_cash_account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_fee_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fee_has_cash_account" CHECK ("transaction"."fee_currency" IS NULL OR "transaction"."fee_cash_account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT IF EXISTS "transaction_wht_has_cash_account";--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_wht_has_cash_account" CHECK ("transaction"."withholding_currency" IS NULL OR "transaction"."wht_cash_account_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "transaction_posting" DROP CONSTRAINT IF EXISTS "transaction_posting_cash_leg_has_account";--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_cash_leg_has_account" CHECK (("transaction_posting"."leg" = 'CASH') = ("transaction_posting"."cash_account_id" IS NOT NULL));
