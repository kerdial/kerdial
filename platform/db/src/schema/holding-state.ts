import { bigint, boolean, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { instrument } from "./instrument.js";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";

/**
 * `holding_state` — derived and materialised from
 * `transaction_posting`: the PMP result. One row per `(tenant_id,
 * portfolio_id, instrument_id)`. Both `cost_basis_base` and
 * `cost_basis_native` are maintained losslessly (FR-61) — the FX component
 * of a gain (FR-30, AC21) is uncomputable from the EUR figure alone; `cost_basis_native`
 * is base-equivalent rather than a true native figure whenever `native_currency_mixed`
 * is true (MC-D1/MC-D2). This
 * task owns only the column shape, not the PMP replay logic that
 * materialises it (T-24, T-30).
 */
export const holdingState = pgTable(
  "holding_state",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instrument.id),
    quantity: decimalCol("quantity", 38, 18).notNull(),
    costBasisBase: decimalCol("cost_basis_base", 38, 12).notNull(), // total EUR cost (FR-61)
    pmpUnitBase: decimalCol("pmp_unit_base", 38, 12).notNull(), // cost_basis_base / quantity (FR-27)
    costBasisNative: decimalCol("cost_basis_native", 38, 12).notNull(), // native-currency cost when nativeCurrencyMixed is false, else equal to cost_basis_base
    pmpUnitNative: decimalCol("pmp_unit_native", 38, 18).notNull(), // needed for FX attribution (FR-30)
    // true when this instrument's acquisitions ever settled in
    // more than one currency, across its whole history — not only from the
    // point mixing started (MC-D1). When true, costBasisNative and
    // pmpUnitNative above are computePmp's base-currency values, not a
    // cross-currency sum. An audit/schema-symmetry column, not a read-path
    // dependency (MC-D6): the actual holdings/closed-positions
    // reads recompute this flag fresh from the timeline on every request via
    // computePmp/computeRealizedGains and never consult this column.
    nativeCurrencyMixed: boolean("native_currency_mixed").notNull().default(false),
    lastTxnSeq: bigint("last_txn_seq", { mode: "bigint" }).notNull(),
    calcEpoch: bigint("calc_epoch", { mode: "bigint" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.portfolioId, table.instrumentId] })],
);
