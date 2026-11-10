CREATE TYPE "public"."price_quality" AS ENUM('EOD', 'DELAYED', 'REALTIME');--> statement-breakpoint
CREATE TYPE "public"."provider_fetch_status" AS ENUM('SUCCESS', 'FAILURE', 'RATE_LIMITED');--> statement-breakpoint
CREATE TYPE "public"."backfill_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED');--> statement-breakpoint
CREATE TABLE "fx_rate_daily" (
	"base_currency" char(3) NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric(28, 12) NOT NULL,
	"source_key" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rate_daily_base_currency_quote_currency_rate_date_pk" PRIMARY KEY("base_currency","quote_currency","rate_date")
);
--> statement-breakpoint
CREATE TABLE "fx_rate_user" (
	"tenant_id" uuid NOT NULL,
	"base_currency" char(3) NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric(28, 12) NOT NULL,
	"source_key" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "fx_rate_user_tenant_id_base_currency_quote_currency_rate_date_pk" PRIMARY KEY("tenant_id","base_currency","quote_currency","rate_date")
);
--> statement-breakpoint
CREATE TABLE "instrument_price_daily" (
	"instrument_id" uuid NOT NULL,
	"price_date" date NOT NULL,
	"close_raw" numeric(38, 18) NOT NULL,
	"currency" char(3) NOT NULL,
	"source_key" text NOT NULL,
	"quality" "price_quality" NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_price_daily_instrument_id_price_date_pk" PRIMARY KEY("instrument_id","price_date")
);
--> statement-breakpoint
CREATE TABLE "manual_price_point" (
	"tenant_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"price_date" date NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	"currency" char(3) NOT NULL,
	"source_key" text DEFAULT 'manual' NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_price_point_tenant_id_instrument_id_price_date_pk" PRIMARY KEY("tenant_id","instrument_id","price_date")
);
--> statement-breakpoint
CREATE TABLE "instrument_quote_latest" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"currency" char(3) NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quality" "price_quality" NOT NULL,
	"source_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_fetch_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" "provider_fetch_status" NOT NULL,
	"latency_ms" integer NOT NULL,
	"rows_fetched" integer DEFAULT 0 NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instrument_backfill_state" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"requested_from" date NOT NULL,
	"earliest_backfilled_date" date,
	"latest_backfilled_date" date,
	"status" "backfill_status" DEFAULT 'PENDING' NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_calendar" (
	"calendar_key" text NOT NULL,
	"session_date" date NOT NULL,
	"is_open" boolean NOT NULL,
	"label" text,
	CONSTRAINT "market_calendar_calendar_key_session_date_pk" PRIMARY KEY("calendar_key","session_date")
);
--> statement-breakpoint
ALTER TABLE "fx_rate_daily" ADD CONSTRAINT "fx_rate_daily_base_currency_currency_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rate_daily" ADD CONSTRAINT "fx_rate_daily_quote_currency_currency_code_fk" FOREIGN KEY ("quote_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rate_user" ADD CONSTRAINT "fx_rate_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rate_user" ADD CONSTRAINT "fx_rate_user_base_currency_currency_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rate_user" ADD CONSTRAINT "fx_rate_user_quote_currency_currency_code_fk" FOREIGN KEY ("quote_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_price_daily" ADD CONSTRAINT "instrument_price_daily_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_price_daily" ADD CONSTRAINT "instrument_price_daily_currency_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_price_point" ADD CONSTRAINT "manual_price_point_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_price_point" ADD CONSTRAINT "manual_price_point_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_price_point" ADD CONSTRAINT "manual_price_point_currency_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_quote_latest" ADD CONSTRAINT "instrument_quote_latest_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_quote_latest" ADD CONSTRAINT "instrument_quote_latest_currency_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_backfill_state" ADD CONSTRAINT "instrument_backfill_state_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instrument_price_daily_ingested_at_brin_idx" ON "instrument_price_daily" USING brin ("ingested_at");