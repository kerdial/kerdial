-- `fx_tracked_pair` — the FX pairs the daily pull covers in addition to the
-- ones the holdings imply (the Devises screen). See
-- `platform/db/src/schema/fx-tracked-pair.ts`'s doc comment for why the table
-- exists at all and why it carries no `tenant_id`.
--
-- drizzle-kit generated (generated name: `0043_public_colonel_america`; the
-- file and its journal tag were renamed to the descriptive form every
-- migration in this repo uses). The statements below are the generator's own,
-- in the generator's own order; the snapshot (`meta/0043_snapshot.json`) is the
-- generator's, untouched.
--
-- **Grants are deliberately not here.** They land in `0044`, hand-written,
-- because this file is generator output and a hand-edit to it would be
-- silently reverted by the next `db:generate`. Same split migrations `0011`,
-- `0012`, `0018`, `0024`, `0029`, `0030` and `0036` already use.
--
-- No RLS implications: shared reference data, no `tenant_id` column, no policy
-- added or changed — AC33/AC35's tenant-isolation guarantees are untouched, and
-- nothing here names `transaction`, `transaction_posting` or `holding_state`
-- (AC47).
CREATE TABLE "fx_tracked_pair" (
	"base_currency" char(3) NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_tracked_pair_base_currency_quote_currency_pk" PRIMARY KEY("base_currency","quote_currency"),
	CONSTRAINT "fx_tracked_pair_legs_differ" CHECK ("fx_tracked_pair"."base_currency" <> "fx_tracked_pair"."quote_currency")
);
--> statement-breakpoint
ALTER TABLE "fx_tracked_pair" ADD CONSTRAINT "fx_tracked_pair_base_currency_currency_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_tracked_pair" ADD CONSTRAINT "fx_tracked_pair_quote_currency_currency_code_fk" FOREIGN KEY ("quote_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;