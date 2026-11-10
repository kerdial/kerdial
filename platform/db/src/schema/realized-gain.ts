import { bigint, boolean, date, pgTable, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { instrument } from "./instrument.js";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";
import { transaction } from "./transaction.js";

/**
 * `realized_gain` — derived and materialised, one row
 * per disposal leg. `fx_component_base` (FR-30, AC21) is the FX attribution
 * of a gain, computable only because `holding_state` retains both the base
 * and native cost basis. This file owns only the column shape, not the
 * disposal/realized-gain computation itself (T-25, T-30).
 *
 * `transaction_id` cascades on delete, like `transaction_posting.transaction_id`
 * — found by T-30's own `deleteTransaction` recompute path: deleting
 * a disposal transaction that produced a `realized_gain` row previously
 * violated this FK (no prior task had ever deleted a transaction with a real
 * materialised gain against it). Since `realized_gain` is a derived table
 * T-30 always wholesale-replaces on the next recompute anyway, letting the
 * `DELETE` cascade here — rather than requiring a specific ordering between
 * "recompute realized_gain first" and "delete the transaction row" — is the
 * same "derived table, referential cleanup is not a hand-authored concern"
 * reasoning `transaction_posting` already uses.
 */
export const realizedGain = pgTable("realized_gain", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id),
  portfolioId: uuid("portfolio_id")
    .notNull()
    .references(() => portfolio.id),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instrument.id),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transaction.id, { onDelete: "cascade" }),
  disposalDate: date("disposal_date", { mode: "string" }).notNull(),
  quantitySold: decimalCol("quantity_sold", 38, 18).notNull(),
  pmpUnitBaseAtSale: decimalCol("pmp_unit_base_at_sale", 38, 12).notNull(),
  proceedsBase: decimalCol("proceeds_base", 38, 12).notNull(),
  gainBase: decimalCol("gain_base", 38, 12).notNull(), // AC20
  gainNative: decimalCol("gain_native", 38, 12).notNull(),
  fxComponentBase: decimalCol("fx_component_base", 38, 12).notNull(), // FR-30, AC21
  // mirrors holding_state.native_currency_mixed for this leg's
  // instrument — true when gain_native/fx_component_base above are
  // computeRealizedGains's base-currency substitutes, not this leg's true
  // native-currency figures. See MC-D1. An audit/schema-symmetry
  // column, not a read-path dependency (MC-D6): the actual
  // holdings/closed-positions reads recompute this flag fresh from the
  // timeline on every request and never consult this column.
  nativeCurrencyMixed: boolean("native_currency_mixed").notNull().default(false),
  calcEpoch: bigint("calc_epoch", { mode: "bigint" }).notNull(),
});
