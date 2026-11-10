ALTER TABLE "realized_gain" DROP CONSTRAINT "realized_gain_transaction_id_transaction_id_fk";
--> statement-breakpoint
ALTER TABLE "realized_gain" ADD CONSTRAINT "realized_gain_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;