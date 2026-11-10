-- CA-1 + CA-2 (Batch A1) — traces
-- FR-150–FR-157, FR-170, FR-171,
-- AC-172, AC-174, AC-175, AC-191, AC-192.
--
-- drizzle-kit generated (generated name: `0038_sudden_nightshade`; the journal
-- tag was renamed with the file to the descriptive form every migration in
-- this repo uses). Everything down to the last `ALTER TABLE ... ADD CONSTRAINT
-- ... CHECK` is the generator's own output, unedited. The RLS/grant block at
-- the bottom is hand-written in the `0008`/`0018`/`0029`/`0036` idiom, because
-- drizzle-kit models neither policies nor grants.
--
-- ## What this migration creates
--
--   1. `cash_account` — a named cash account belonging to exactly one
--      portfolio in exactly one currency. **No uniqueness on
--      `(tenant_id, portfolio_id, currency)`, in any form, under any name**:
--      that is AC-172's literal requirement, and the reviewer-checkable
--      statement of it is that *every unique key on this table contains either
--      `name` or `id`*. `UNIQUE (tenant_id, portfolio_id, id, currency)`
--      contains `id`, so it constrains nothing about how many accounts share a
--      currency — it exists solely so a composite FK can carry `currency`
--      along with the id.
--
--      `cash_account_name_length` is `name ~ '\S' and length(btrim(name))
--      <= 200`, expression for expression the corrected `portfolio_name_length`
--      of migration `0028`, and the form is **not** interchangeable with
--      `length(btrim(name)) between 1 and 200`: one-argument `btrim` strips
--      only ASCII space `0x20`, so `btrim(E'\t')` has length 1 and a name of a
--      single tab or newline would pass a `btrim`-based floor.
--      `portfolio_name_length` shipped that mistake once and its correction is
--      now the standing rule for every name-length floor in this repo.
--
--      **Verified against `postgres:17`, libc provider, `en_US.utf8`** — the
--      provider dev and CI actually run, asserted (not assumed) in
--      `cash-account-schema.integration.test.ts`, because `\S`'s space class is
--      collation-provider dependent. Rejected there, individually and by
--      constraint name: ASCII spaces, U+0009, U+000A, U+000D, U+0085 (NEL),
--      U+2000, U+3000.
--
--      **A measured gap, recorded rather than hidden:** on this provider `\S`
--      does *not* classify U+00A0, U+1680 or U+200B as space, so a name of only
--      one of those passes, contrary to what this expression was believed to
--      close. The shipped `portfolio_name_length` has
--      the identical hole (verified by inserting a U+00A0 portfolio name
--      against it), so this file does not unilaterally diverge from its
--      sibling — the three code points are asserted *accepted* in the suite,
--      so the fact is under test and any future strengthening has to move both
--      tables together. An explicit trim set
--      (`btrim(name, E' \t\n\r\v\f ') <> ''`) closes all three and is the
--      obvious repair if the project decides to take it.
--   2. Four nullable attribution columns on `transaction`, one per money leg
--      (principal / CURRENCY_EXCHANGE target / fee / withholding), plus one on
--      `transaction_posting`. One transaction row can move cash in up to four
--      different currencies, and an account is single-currency, so the
--      attribution cannot be a single column.
--   3. Four composite FKs against
--      `cash_account (tenant_id, portfolio_id, id, currency)` — the mechanism
--      that makes "same portfolio" (FR-155), "same tenant" (F6's recorded
--      class: FK checks are **not** RLS-aware) and "same currency" (OD-2)
--      database facts rather than application checks.
--   4. Seven CHECKs, three of which exist only to close the **MATCH SIMPLE**
--      hazard: a multi-column FK is not checked *at all* when any of its
--      columns is NULL, so an account id set beside a NULL currency column
--      would skip the FK entirely. Two more close a pre-existing gap the
--      pairing CHECKs now depend on (`fee_amount`/`fee_currency` and the
--      withholding equivalent); one is FR-157
--      (an asset-settled principal leg never names an account); one is on
--      `transaction_posting` (`currency` on a CASH
--      leg was enforced by nothing but `emitCash` always supplying one, and
--      CD4's re-key makes that load-bearing).
--
-- ## The true CHECK count this migration produces
--
-- Measured, not carried over from the earlier arithmetic (which did not
-- add up for `0039`): `transaction` had **13** `CHECK`s at
-- `0037` and has **19** after this file (six of the seven added here);
-- `transaction_posting` had **0** and has **1**. The seventh CHECK is the
-- `transaction_posting` one, which neither of the earlier tallies counted.
--
-- ## What is deliberately NOT here
--
-- The **totality** CHECKs ("a leg with a currency always names an account")
-- belong to `0039`, after the backfill: they are false against every
-- pre-`0038` row. Everything in this file is true of existing data on the
-- day it runs — the four new `transaction` columns are NULL on every existing
-- row, so the pairing CHECKs are trivially satisfied; the amount/currency
-- pairings assert an invariant `expandPostings` has always required in
-- practice; and `transaction_posting.currency` is already non-NULL on exactly
-- the CASH legs.
--
-- ## Gates
--
-- `tenant-column-gate`: `cash_account` carries `tenant_id NOT NULL` and gets
-- `ENABLE` + `FORCE` row-level security **in this same file**, so it needs no
-- `SHARED_REFERENCE_TABLE_ALLOWLIST` entry (AC-192). `no-floats-schema-gate`:
-- the table has no numeric column at all, so it passes with nothing to
-- enforce. Neither gate's configuration is edited or exempted.
--
-- ## Ownership
--
-- `ALTER TABLE "cash_account" OWNER TO app_owner`, in the `0032`/`0033` idiom
-- and for their reason: `0007` creates `app_owner` and reassigns every table
-- created before it, so every table created *after* it has to reassign itself.
-- The original DDL sketch does not mention this, and two
-- pre-existing suites catch its absence rather than letting it ship —
-- `roles-and-rls.integration.test.ts`'s "app_owner owns every tenant-owned and
-- shared table", and `app-backup-role.integration.test.ts`'s AC-24 `pg_dump`
-- probe, which without it fails with `permission denied for table
-- cash_account` instead of the row-level-security message it is asserting.
--
-- ## Why the grants are in this file and not a follow-up (FR-171)
--
-- This diverges from the repo's own `0035`/`0036` and `0014`/`0015`
-- split-migration precedent, and the divergence is the point. `app_web` had
-- **no grant at all** on `instrument_backfill_state` up to `0028`; the failure
-- was a `permission denied` swallowed by its own `catch`, invisible to CI
-- because every test connects as the Testcontainers superuser, and it ran in
-- production for weeks. One file makes the state "table exists, grant does
-- not" unrepresentable at *any* point in migration order.
--
-- Three things about the grant block are deliberate, and each is asserted
-- individually as the **real role** in
-- `platform/db/src/cash-account-grants.integration.test.ts` (AC-191's eight
-- cases):
--
--   - The policy uses `NULLIF(current_setting(...), '')::uuid` — `0008`'s
--     corrected idiom, never `0007`'s bare `current_setting(...)::uuid`, which
--     raises `invalid input syntax for type uuid` on any pooled connection
--     that has already run `set_config` (a bug this repo has fixed once).
--   - `UPDATE` is **column-level**. `app_web` is structurally incapable of
--     changing `currency` (OD-2's immutability) or `portfolio_id` (FR-153's
--     "belongs to exactly one portfolio for its entire lifetime"). Both become
--     database facts rather than DTO omissions; both are asserted failing with
--     `42501`.
--   - `DELETE` **is** granted even though OD-5 locked archive, because
--     `deletePortfolio` runs as `app_web` and must destroy this portfolio's
--     cash accounts (FR-166). Without it the cascade fails with `42501`, which
--     the existing defensive catch does not map (it tests for `23503`), so it
--     would escape as a raw 500 — in production only, since every count
--     assertion in that suite reads through the superuser. No HTTP route
--     exposes `DELETE`; that is a separate assertion, not this grant's job.
--   - `app_ingest` gets **nothing**, asserted as its own case.
--
-- No grant change is needed on `transaction`/`transaction_posting`: `0007`
-- grants `SELECT, INSERT, UPDATE, DELETE` at **table** level on both, so the
-- new columns are covered automatically. That is a claim, not a hope, and the
-- suite above proves it with a live insert as `app_web` rather than by reading
-- `0007`'s SQL text.
CREATE TABLE "cash_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_account_name_length" CHECK ("cash_account"."name" ~ '\S' and length(btrim("cash_account"."name")) <= 200),
	CONSTRAINT "cash_account_currency_charset" CHECK ("cash_account"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "target_cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "fee_cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "wht_cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD COLUMN "cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_account" ADD CONSTRAINT "cash_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_account" ADD CONSTRAINT "cash_account_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_account_tenant_id_portfolio_id_name_key" ON "cash_account" USING btree ("tenant_id","portfolio_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_account_tenant_id_portfolio_id_id_currency_key" ON "cash_account" USING btree ("tenant_id","portfolio_id","id","currency");--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_cash_account_fk" FOREIGN KEY ("tenant_id","portfolio_id","cash_account_id","txn_currency") REFERENCES "public"."cash_account"("tenant_id","portfolio_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_target_cash_account_fk" FOREIGN KEY ("tenant_id","portfolio_id","target_cash_account_id","target_currency") REFERENCES "public"."cash_account"("tenant_id","portfolio_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fee_cash_account_fk" FOREIGN KEY ("tenant_id","portfolio_id","fee_cash_account_id","fee_currency") REFERENCES "public"."cash_account"("tenant_id","portfolio_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_wht_cash_account_fk" FOREIGN KEY ("tenant_id","portfolio_id","wht_cash_account_id","withholding_currency") REFERENCES "public"."cash_account"("tenant_id","portfolio_id","id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_cash_account_id_cash_account_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fee_cash_account_pairing" CHECK (("transaction"."fee_cash_account_id" IS NULL) OR ("transaction"."fee_currency" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_wht_cash_account_pairing" CHECK (("transaction"."wht_cash_account_id" IS NULL) OR ("transaction"."withholding_currency" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_target_cash_account_pairing" CHECK (("transaction"."target_cash_account_id" IS NULL) OR ("transaction"."target_currency" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_fee_amount_currency_pairing" CHECK (("transaction"."fee_amount" IS NULL) = ("transaction"."fee_currency" IS NULL));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_withholding_amount_currency_pairing" CHECK (("transaction"."withholding_amount" IS NULL) = ("transaction"."withholding_currency" IS NULL));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_settled_principal_has_no_cash_account" CHECK ("transaction"."txn_settlement_instrument_id" IS NULL OR "transaction"."cash_account_id" IS NULL);--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_cash_leg_has_currency" CHECK (("transaction_posting"."leg" = 'CASH') = ("transaction_posting"."currency" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_account" OWNER TO app_owner;--> statement-breakpoint
ALTER TABLE "cash_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cash_account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cash_account_tenant_isolation" ON "cash_account" AS PERMISSIVE FOR ALL TO app_web
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "cash_account" TO app_web;--> statement-breakpoint
GRANT UPDATE ("name", "archived_at", "updated_at") ON "cash_account" TO app_web;