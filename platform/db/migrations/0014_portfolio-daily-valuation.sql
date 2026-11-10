CREATE TABLE "portfolio_daily_valuation" (
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"valuation_date" date NOT NULL,
	"total_value_base" numeric(38, 12) NOT NULL,
	"materialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_daily_valuation_tenant_id_portfolio_id_valuation_date_pk" PRIMARY KEY("tenant_id","portfolio_id","valuation_date")
);
--> statement-breakpoint
ALTER TABLE "portfolio" ADD COLUMN "calc_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolio_daily_valuation" ADD CONSTRAINT "portfolio_daily_valuation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_daily_valuation" ADD CONSTRAINT "portfolio_daily_valuation_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolio"("id") ON DELETE no action ON UPDATE no action;