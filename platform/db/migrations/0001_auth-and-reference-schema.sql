CREATE TYPE "public"."tenant_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."instrument_kind" AS ENUM('SHARE', 'ETF', 'FUND', 'CRYPTO', 'INDEX');--> statement-breakpoint
CREATE TYPE "public"."instrument_status" AS ENUM('ACTIVE', 'DELISTED', 'MERGED');--> statement-breakpoint
CREATE TYPE "public"."primary_identifier" AS ENUM('ISIN', 'SYMBOL');--> statement-breakpoint
CREATE TYPE "public"."quote_policy" AS ENUM('AUTO', 'MANUAL_ONLY');--> statement-breakpoint
CREATE TYPE "public"."provider_map_confidence" AS ENUM('CONFIRMED', 'HEURISTIC');--> statement-breakpoint
CREATE TABLE "currency" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_unit" smallint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "tenant_status" DEFAULT 'ACTIVE' NOT NULL,
	"base_currency" char(3) DEFAULT 'EUR' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" "inet",
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "user_setting" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "user_setting_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "instrument" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "instrument_kind" NOT NULL,
	"display_name" text NOT NULL,
	"listing_currency" char(3) NOT NULL,
	"exchange_mic" char(4),
	"isin" char(12),
	"symbol" text,
	"figi" char(12),
	"primary_identifier" "primary_identifier" NOT NULL,
	"quote_policy" "quote_policy" NOT NULL,
	"owner_tenant_id" uuid,
	"status" "instrument_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instrument_provider_map" (
	"instrument_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"provider_symbol" text NOT NULL,
	"confidence" "provider_map_confidence" NOT NULL,
	"last_verified_at" timestamp with time zone,
	CONSTRAINT "instrument_provider_map_instrument_id_provider_key_pk" PRIMARY KEY("instrument_id","provider_key")
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_base_currency_currency_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setting" ADD CONSTRAINT "user_setting_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_listing_currency_currency_code_fk" FOREIGN KEY ("listing_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_owner_tenant_id_tenant_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_provider_map" ADD CONSTRAINT "instrument_provider_map_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_isin_exchange_mic_key" ON "instrument" USING btree ("isin","exchange_mic") WHERE "instrument"."isin" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_symbol_crypto_key" ON "instrument" USING btree ("symbol") WHERE "instrument"."kind" = 'CRYPTO';--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_provider_map_provider_symbol_key" ON "instrument_provider_map" USING btree ("provider_key","provider_symbol");