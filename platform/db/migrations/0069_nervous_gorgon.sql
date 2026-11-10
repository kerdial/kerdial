-- persists whether an instrument's acquisitions ever settled in
-- more than one currency (MC-D6).
-- An audit/schema-symmetry column, not a read-path dependency: the actual
-- open-holdings and closed-positions reads recompute this flag fresh from the
-- transaction timeline on every request and never consult this column, so an
-- existing row reading the `false` default until the next write to that
-- portfolio has no user-visible effect today (MC-D6). Both
-- holding_state and realized_gain are wholesale delete-then-insert on every
-- recompute, so this column needs no backfill logic.

ALTER TABLE "holding_state" ADD COLUMN "native_currency_mixed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "realized_gain" ADD COLUMN "native_currency_mixed" boolean DEFAULT false NOT NULL;