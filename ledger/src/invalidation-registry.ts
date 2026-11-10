/**
 * AR-3 (ADR-0007) — the write-path registry: every
 * valuation-affecting write path in `ledger`, with its invalidation scope
 * and the date it invalidates from. One list, exported, so a new write type
 * cannot be added silently:
 *
 *  - `invalidation-registry.integration.test.ts` iterates this registry —
 *    for each entry it performs the write and asserts `calc_epoch` advanced
 *    for every in-scope portfolio and that `portfolio_daily_valuation` rows
 *    on/after the stated date are gone;
 *  - the same suite's exhaustiveness check compares the registry against the
 *    service's actual write surface (reflection over
 *    `TransactionWriteService.prototype`) and the module-level writers, so a
 *    write method added without a registry entry fails the check, and an
 *    entry added without a test exercise fails its own case;
 *  - `eslint-rules/only-materialization-writes-derived-state.mjs` is the
 *    structural half: nothing outside `materialization.ts` can touch the
 *    derived tables, so going *around* this registry is a lint error, not a
 *    review hazard.
 *
 * The **scope asymmetry** this registry exists to document (ADR-0007):
 * a transaction write is portfolio-scoped — `recomputeAndInvalidate` takes
 * one `portfolioId`, widened since `security-transfer` to that portfolio's
 * transfer closure — while a manual-price write is keyed
 * `(tenant, instrument, date)` and fans out to every portfolio holding or
 * having traded the instrument (`invalidateForInstrumentPrice`, AR-13b).
 *
 * `security-transfer` TR-29 re-opened this list once, sequentially after TR-13:
 * `recordStandaloneTransferIn` (ND-2 (a), import-only)
 * joined it the day it existed, in the closure scope like every other create.
 *
 * P1-LATER, deliberately **not** an entry (an unimplemented write in the
 * registry would poison the exhaustiveness check): the `corporate_action`
 * write (C18) — tenant × instrument fan-out from `ex_date` — joins this list
 * the day it exists.
 */

/** How far an entry's invalidation reaches. */
/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export type InvalidationScope =
  /** One portfolio: the write carries a `portfolioId` and `recomputeAndInvalidate` covers it. */
  | "portfolio"
  /**
   * `security-transfer`: the written portfolio, plus every
   * portfolio whose linked `TRANSFER_IN`'s carried cost the write changed —
   * transitively (`transfer-link.ts`'s `recomputeWithTransferPropagation`).
   * A reached portfolio invalidates from its target's
   * `trade_date`, not from the write's date. A portfolio with no link to the
   * written one — and a linked one whose carried cost the write left equal —
   * is not touched.
   */
  | "portfolio-and-transfer-closure"
  /** Tenant × instrument: `invalidateForInstrumentPrice` resolves every portfolio holding or having traded the instrument. */
  | "tenant-instrument-fanout"
  /** The write destroys the portfolio's derived state outright (`destroyDerivedStateForPortfolio`); there is no "from" date. */
  | "destroys-derived-state";

/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export interface InvalidationRegistryEntry {
  /**
   * The write path, as `TransactionWriteService.<method>` for service
   * methods or the bare exported function name for module-level writers —
   * the exhaustiveness check parses this shape.
   */
  readonly write: string;
  readonly scope: InvalidationScope;
  /** Prose statement of the date invalidation runs from — the table-driven test asserts the behaviour it describes. */
  readonly invalidatesFrom: string;
}

export const INVALIDATION_REGISTRY: readonly InvalidationRegistryEntry[] = [
  {
    write: "TransactionWriteService.recordBuy",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.recordSell",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.recordDeposit",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.recordWithdrawal",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.recordDividend",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    // cash-interest: the 11th kind, written like a deposit.
    write: "TransactionWriteService.recordInterest",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    // portfolio-cash: the 12th kind, written like a withdrawal.
    write: "TransactionWriteService.recordFee",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.recordDrip",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.recordCurrencyExchange",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    // Postdates ADR-0007's own table (asset-settled trades) — caught
    // by this registry's exhaustiveness check on its first run, which is the
    // check working as designed.
    write: "TransactionWriteService.recordSettledBuy",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    // The cashless 8th kind, and it postdates ADR-0007's table for the same
    // reason the entry above does — caught by the exhaustiveness check the
    // moment the method existed. **Not a narrower scope:** it moves no cash,
    // but it changes the holding's quantity and therefore every valuation from
    // its trade date on, exactly as a BUY does — and a linked target's
    // carried cost with it.
    write: "TransactionWriteService.recordShareDistribution",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    // `security-transfer`: its own target's portfolio, and — a quantity
    // removed before a later acquisition moves that portfolio's PMP — every
    // earlier link's target too.
    write: "TransactionWriteService.recordTransferOut",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    // `security-transfer` ND-2 (a): a severed target carried back in by the
    // Kerdial CSV importer. It links to nothing, but it is an acquisition, so
    // one written before a later transfer *out of* its portfolio moves that
    // portfolio's PMP at the transfer — and that transfer's own target with it.
    write: "TransactionWriteService.recordStandaloneTransferIn",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "TransactionWriteService.editTransaction",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "min(old.trade_date, new.trade_date)",
  },
  {
    write: "TransactionWriteService.deleteTransaction",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "deleted row's trade_date",
  },
  {
    write: "TransactionWriteService.correctFxRate",
    scope: "portfolio-and-transfer-closure",
    invalidatesFrom: "trade_date",
  },
  {
    write: "upsertManualPricePoint",
    scope: "tenant-instrument-fanout",
    invalidatesFrom: "price_date",
  },
  {
    write: "deleteManualPricePoint",
    scope: "tenant-instrument-fanout",
    invalidatesFrom: "price_date",
  },
  {
    // `security-transfer` (OD-7 (c), ST-14): severs every link to another
    // portfolio's transfer leg and deliberately does **not** recompute the
    // survivor — its quantity and stored carried cost are unchanged, so no
    // figure of it moves. Hence not a transfer-closure scope.
    write: "deletePortfolio",
    scope: "destroys-derived-state",
    invalidatesFrom: "n/a",
  },
];
