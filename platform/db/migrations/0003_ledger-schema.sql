CREATE TYPE "public"."fx_rate_source" AS ENUM('USER_PINNED', 'PROVIDER', 'IMPLIED_BASE');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('BUY', 'SELL', 'DEPOSIT', 'WITHDRAWAL', 'DIVIDEND', 'DRIP', 'CURRENCY_EXCHANGE');--> statement-breakpoint
CREATE TYPE "public"."flow_class" AS ENUM('EXTERNAL', 'INTERNAL', 'INCOME', 'FEE', 'TAX');--> statement-breakpoint
CREATE TYPE "public"."posting_leg" AS ENUM('POSITION', 'CASH');--> statement-breakpoint
CREATE TYPE "public"."transaction_revision_kind" AS ENUM('CREATE', 'UPDATE', 'DELETE');--> statement-breakpoint
CREATE TABLE "portfolio" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"kind" "transaction_kind" NOT NULL,
	"trade_date" date NOT NULL,
	"trade_ts" timestamp with time zone,
	"seq" bigint NOT NULL,
	"instrument_id" uuid,
	"quantity" numeric(38, 18),
	"unit_price" numeric(38, 18),
	"gross_amount" numeric(38, 12) NOT NULL,
	"txn_currency" char(3),
	"txn_settlement_instrument_id" uuid,
	"target_currency" char(3),
	"target_amount" numeric(38, 12),
	"fee_amount" numeric(38, 12),
	"fee_currency" char(3),
	"withholding_amount" numeric(38, 12),
	"withholding_currency" char(3),
	"source_dividend_id" uuid,
	"fx_rate" numeric(28, 12) NOT NULL,
	"fx_rate_source" "fx_rate_source" NOT NULL,
	"fx_rate_provider_key" text,
	"fx_rate_observed_on" date,
	"fx_rate_user_input" numeric(28, 12),
	"fee_fx_rate" numeric(28, 12),
	"fee_fx_rate_source" "fx_rate_source",
	"fee_fx_rate_provider_key" text,
	"fee_fx_rate_observed_on" date,
	"fee_fx_rate_user_input" numeric(28, 12),
	"wht_fx_rate" numeric(28, 12),
	"wht_fx_rate_source" "fx_rate_source",
	"wht_fx_rate_provider_key" text,
	"wht_fx_rate_observed_on" date,
	"wht_fx_rate_user_input" numeric(28, 12),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_session_id" uuid,
	CONSTRAINT "transaction_buy_sell_shape" CHECK ("transaction"."kind" NOT IN ('BUY', 'SELL') OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NOT NULL
        AND "transaction"."unit_price" IS NOT NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
      )),
	CONSTRAINT "transaction_deposit_withdrawal_shape" CHECK ("transaction"."kind" NOT IN ('DEPOSIT', 'WITHDRAWAL') OR (
        "transaction"."txn_currency" IS NOT NULL
        AND "transaction"."instrument_id" IS NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
      )),
	CONSTRAINT "transaction_dividend_shape" CHECK ("transaction"."kind" <> 'DIVIDEND' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
      )),
	CONSTRAINT "transaction_drip_shape" CHECK ("transaction"."kind" <> 'DRIP' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NOT NULL
        AND "transaction"."unit_price" IS NOT NULL
        AND "transaction"."source_dividend_id" IS NOT NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
      )),
	CONSTRAINT "transaction_currency_exchange_shape" CHECK ("transaction"."kind" <> 'CURRENCY_EXCHANGE' OR (
        "transaction"."txn_currency" IS NOT NULL
        AND "transaction"."target_currency" IS NOT NULL
        AND "transaction"."target_amount" IS NOT NULL
        AND "transaction"."instrument_id" IS NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
      )),
	CONSTRAINT "transaction_currency_xor_settlement_instrument" CHECK (("transaction"."txn_currency" IS NOT NULL) <> ("transaction"."txn_settlement_instrument_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "transaction_posting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"leg" "posting_leg" NOT NULL,
	"instrument_id" uuid,
	"currency" char(3),
	"quantity_delta" numeric(38, 18),
	"amount_native" numeric(38, 12) NOT NULL,
	"amount_base" numeric(38, 12) NOT NULL,
	"fx_rate_applied" numeric(28, 12) NOT NULL,
	"fx_rate_source" "fx_rate_source" NOT NULL,
	"flow_class" "flow_class" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"revision_kind" "transaction_revision_kind" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_balance" (
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"calc_epoch" bigint NOT NULL,
	CONSTRAINT "cash_balance_tenant_id_portfolio_id_currency_pk" PRIMARY KEY("tenant_id","portfolio_id","currency")
);
--> statement-breakpoint
CREATE TABLE "holding_state" (
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"cost_basis_base" numeric(38, 12) NOT NULL,
	"pmp_unit_base" numeric(38, 12) NOT NULL,
	"cost_basis_native" numeric(38, 12) NOT NULL,
	"pmp_unit_native" numeric(38, 18) NOT NULL,
	"last_txn_seq" bigint NOT NULL,
	"calc_epoch" bigint NOT NULL,
	CONSTRAINT "holding_state_tenant_id_portfolio_id_instrument_id_pk" PRIMARY KEY("tenant_id","portfolio_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "realized_gain" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"disposal_date" date NOT NULL,
	"quantity_sold" numeric(38, 18) NOT NULL,
	"pmp_unit_base_at_sale" numeric(38, 12) NOT NULL,
	"proceeds_base" numeric(38, 12) NOT NULL,
	"gain_base" numeric(38, 12) NOT NULL,
	"gain_native" numeric(38, 12) NOT NULL,
	"fx_component_base" numeric(38, 12) NOT NULL,
	"calc_epoch" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_txn_settlement_instrument_id_instrument_id_fk" FOREIGN KEY ("txn_settlement_instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_source_dividend_id_transaction_id_fk" FOREIGN KEY ("source_dividend_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_updated_by_session_id_session_id_fk" FOREIGN KEY ("updated_by_session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_posting" ADD CONSTRAINT "transaction_posting_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revision" ADD CONSTRAINT "transaction_revision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_revision" ADD CONSTRAINT "transaction_revision_changed_by_app_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_balance" ADD CONSTRAINT "cash_balance_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_balance" ADD CONSTRAINT "cash_balance_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_state" ADD CONSTRAINT "holding_state_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_state" ADD CONSTRAINT "holding_state_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_state" ADD CONSTRAINT "holding_state_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realized_gain" ADD CONSTRAINT "realized_gain_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realized_gain" ADD CONSTRAINT "realized_gain_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realized_gain" ADD CONSTRAINT "realized_gain_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realized_gain" ADD CONSTRAINT "realized_gain_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_tenant_id_name_key" ON "portfolio" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "transaction_tenant_portfolio_trade_date_seq_idx" ON "transaction" USING btree ("tenant_id","portfolio_id","trade_date","seq");--> statement-breakpoint
CREATE INDEX "transaction_tenant_instrument_trade_date_seq_idx" ON "transaction" USING btree ("tenant_id","instrument_id","trade_date","seq");