import { Decimal, ROUNDING_MODE } from "@kerdial/core-decimal";
import { classifyFlows, type FlowClass, type TransactionLeg } from "@kerdial/core-domain";
import type { transaction, transactionPosting } from "@kerdial/platform-db";

/**
 * `expandPostings` — T-21. The
 * deterministic expansion of one `transaction` row into the
 * `transaction_posting` rows that are the system's derived ledger.
 *
 * This function is **pure**: it reads a transaction row and returns posting
 * drafts. It performs no I/O, resolves no FX rate, and reads no other row —
 * `TransactionWriteService` calls it inside the same DB transaction as the
 * write and persists the result there (a "write-time projection, never a
 * cache": regenerated wholesale, delete + insert, so it cannot drift).
 *
 * ## Nothing here is re-resolved or recomputed (FR-57, AC47)
 *
 * Every draft's `fxRateApplied`/`fxRateSource` is **copied** from the parent
 * transaction's already-resolved leg — `fx_rate*` for the principal and
 * settlement legs. A **cost** and the **withholding tax** have no rate of
 * their own (`0049` retired `fee_fx_rate*`; `0079` the
 * withholding's): each is one amount denominated by the settling
 * account and carried at the principal's rate, and the withholding is one
 * `TAX` posting. There is no `FxRateResolver` here, no provider port, and
 * no rate lookup of any kind; the only arithmetic on a rate is
 * `amountBase = amountNative × rate` in the canonical direction. The two
 * exceptions are documented at {@link expandPostings}'s CURRENCY_EXCHANGE
 * branch and at `emitPrincipalCash`'s cross-currency branch (phase 1 of
 * `fee-tax-breakdown`) — the second is the first's
 * construction reused verbatim, and both derive their rate from two values
 * already stored on the row rather than resolving anything.
 *
 * **`cashAccountId` is copied exactly the same way** (CD1): each CASH draft takes
 * the account already stored on the *matching leg* of the parent row —
 * `cash_account_id` for the principal, `target_cash_account_id` for a
 * CURRENCY_EXCHANGE's target. A cost and the withholding have no account of
 * their own either — `fee_cash_account_id` went with `0049`,
 * `wht_cash_account_id` with `0079` — so each takes the settling
 * account's (L5). It is never resolved, and in
 * particular never looked up by currency: a portfolio may hold any number of
 * accounts in one currency (AC-172), so currency does not identify one, and
 * resolving here would need the I/O this function does not have and must not
 * acquire. A POSITION leg always carries `null` — it moved no cash, and
 * `0039`'s `transaction_posting_cash_leg_has_account` states that equality in
 * both directions.
 *
 * ## The sum-to-zero invariant
 *
 * Every leg that has a counterparty inside the portfolio is emitted as an
 * exact `Decimal` negation of that counterparty — a BUY's position leg is
 * `+gross × rate` and its cash leg `−gross × rate`, computed from the same
 * two values — so the `INTERNAL` legs of a transaction sum to exactly zero at
 * full precision, not to a tolerance, and stay balanced after the column's
 * scale is applied on the way to the wire (both sides round identically).
 * What remains is the fee and withholding legs (genuine value leakage) and
 * the `EXTERNAL`/`INCOME` legs, whose counterparty is by definition outside
 * the portfolio — see `posting-expander.property.test.ts`, which states the
 * invariant in full and notes where it departs from the one-line
 * form.
 *
 * A `SHARE_DISTRIBUTION` is the degenerate case of the same
 * rule and not an exception to it: it emits **one** leg, that leg's
 * `amount_base` is exactly `0`, and it carries no fee or tax leg, so its
 * postings sum to zero with nothing left over — a single-leg transaction that
 * balances because it moves no value, only units.
 */

/**
 * The principal cash posting's own `fx_rate_applied`, recomputed for the cost
 * legs.
 *
 * It is deliberately the **same two expressions** `emitPrincipalCash` uses and
 * not a third: degenerate rows take `fx_rate` verbatim (FR-241 — never
 * `(G × R) / G`, which is not guaranteed to return `R` at `precision: 34`),
 * and cross-currency rows take `amount_base / amount_native`, the implied
 * account→base rate. A cost converted by a rate the principal leg did not use
 * would break the sum-to-zero in the low digits for no reason.
 *
 * **Exported, and there is exactly one copy of this rule**.
 * `position-replay.ts` needs the same figure for its `TxnFee` projection, and
 * the two hand-written copies it started as already disagreed on
 * `txn_currency IS NULL` — unreachable on a database-valid row, and precisely
 * the state that produces a real divergence later.
 */
export function principalImpliedRate(
  txn: Pick<
    ExpandableTransaction,
    "txnCurrency" | "grossAmount" | "cashAmount" | "fxRate" | "cashCurrency"
  >,
): Decimal {
  const { cashCurrency, txnCurrency, cashAmount } = txn;
  // No cash leg at all (an asset-settled row) — there is nothing to imply a
  // rate between, and the trade's own rate is the only answer.
  if (cashCurrency === null) return txn.fxRate;
  if (txnCurrency === null) return txn.fxRate;
  if (cashCurrency.trim() === txnCurrency.trim()) return txn.fxRate;
  if (cashAmount === null || cashAmount.isZero()) return txn.fxRate;
  return txn.grossAmount.times(txn.fxRate).dividedBy(cashAmount);
}

/** The `transaction` row shape this expander reads — a structural subset of `typeof transaction.$inferSelect`. */
export type ExpandableTransaction = Pick<
  typeof transaction.$inferSelect,
  | "kind"
  | "instrumentId"
  | "quantity"
  | "grossAmount"
  | "txnCurrency"
  | "txnSettlementInstrumentId"
  | "targetCurrency"
  | "targetAmount"
  // The per-leg cash accounts (CD1). Columns and not one, because a
  // single transaction row can move cash in two different currencies (a
  // CURRENCY_EXCHANGE's source and target) and an account is single-currency — see this module's doc comment for why
  // they are copied and never resolved.
  | "cashAccountId"
  | "targetCashAccountId"
  // The principal cash leg's own denomination (`0045`/`0046`, phase 1 of
  // `fee-tax-breakdown`): what the *account* moved, which
  // from phase 1 on need not be what the *trade* was priced in. Both are NULL
  // on an asset-settled row (FR-236,
  // `transaction_settled_principal_has_no_cash_leg`) and both are non-NULL on
  // every fiat principal leg (`transaction_fiat_principal_has_cash_currency`,
  // `transaction_cash_amount_currency_pairing`).
  | "cashCurrency"
  | "cashAmount"
  | "feeAmount"
  // The itemised cost components (`0047`, phase 2 of
  // `fee-tax-breakdown`). `fee_amount` remains the
  // **total**; these four are its breakdown, and
  // `transaction_cost_components_sum_to_fee_amount` keeps them summing to it.
  // All four NULL is the unitemised shape — every row written before phase 2,
  // and every row a user chooses not to itemise (L8).
  | "brokerFeeAmount"
  | "fxFeeAmount"
  | "taxAmount"
  | "otherCostAmount"
  | "withholdingAmount"
  | "fxRate"
  | "fxRateSource"
>;

/**
 * One `transaction_posting` row, minus the identity columns the persistence
 * layer owns (`id`, `tenant_id`, `transaction_id`, `portfolio_id`). Typed as
 * a `Pick` of the real insert type, so a schema change to any of these
 * columns fails `pnpm typecheck` here rather than at runtime — including a
 * change to the `posting_leg`, `fx_rate_source` or `flow_class` enums.
 */
export type PostingDraft = Pick<
  typeof transactionPosting.$inferInsert,
  | "seq"
  | "leg"
  | "instrumentId"
  | "currency"
  | "cashAccountId"
  | "quantityDelta"
  | "amountNative"
  | "amountBase"
  | "fxRateApplied"
  | "fxRateSource"
  | "flowClass"
>;

/**
 * A transaction whose stored columns cannot be expanded into a balanced set
 * of postings — a BUY with no `quantity`, a row settled in neither a currency
 * nor an asset, a fee amount with no fee rate. Every one of these is already
 * refused by a `CHECK` constraint and by
 * `TransactionWriteService`'s validation, so reaching this error means an
 * out-of-band writer produced a row the ledger cannot account for. It is a
 * hard failure rather than a "best effort" expansion, because a silently
 * dropped leg would show up as a quietly wrong cash balance and a quietly
 * wrong return figure, with nothing pointing back here.
 */
export class PostingExpansionError extends Error {
  readonly kind: string;
  readonly missing: string;

  constructor(kind: string, missing: string) {
    super(
      `Cannot expand a ${kind} transaction into postings: ${missing}. ` +
        `The posting ledger is a derived projection — it refuses to emit an unbalanced set of legs rather than guess at the missing value.`,
    );
    this.name = "PostingExpansionError";
    this.kind = kind;
    this.missing = missing;
  }
}

/**
 * **`missing` is written in the API's own field names, never the database's
 * columns.**
 *
 * These strings reach a client: `write-error.mapper.ts` forwards them into a
 * 422 problem+json `detail`. `problem-json.filter.ts:138-141` states the
 * policy they must satisfy — a client is told what is wrong "without itself
 * learning the schema's internal shape" — and four genuine leaks (constraint
 * names, column precision) were fixed earlier. These twelve were the mild
 * inconsistency left behind: `cash_currency` and `fee_amount` tell a caller
 * who can already send `cashCurrency` and `feeAmount` nothing new, but they
 * are the schema's spelling, not the contract's.
 *
 * Three of them said more than that and are now reworded rather than
 * re-cased, because they named things no caller can send: the constraint
 * `transaction_cost_components_sum_to_fee_amount`, and the server-resolved
 * withholding rate columns (dropped by `0079`). Those describe the *condition*
 * now, with no internal name in them.
 *
 * Nested fields use the contract's dotted path (`withholding.amount`), the
 * same convention `positiveDecimal("withholding.amount")` already uses in
 * `transaction-create.schema.ts`.
 */
function required<T>(value: T | null | undefined, kind: string, missing: string): T {
  if (value === null || value === undefined) throw new PostingExpansionError(kind, missing);
  return value;
}

/**
 * Expands `txn` into its postings, in a deterministic order: the principal
 * legs first (position before cash, source before target), then the
 * withholding-tax leg, then the fee leg. `seq` is assigned 1-based in that
 * order — the "ordering within the transaction" rule.
 *
 * The same input always produces the same output, which is what makes
 * regeneration on edit (delete + insert) safe: a re-expansion of an unchanged
 * row differs from its predecessor only in the freshly minted posting `id`s.
 */
export function expandPostings(
  txn: ExpandableTransaction,
  minorUnitOf: MinorUnitOf,
): readonly PostingDraft[] {
  return roundCashMovements(expandUnrounded(txn), minorUnitOf);
}

/**
 * A currency's `minor_unit` (ISO 4217 exponent: 2 for EUR/USD, 0 for JPY, 3
 * for KWD), read from the `currency` reference table by the caller — this
 * file performs no I/O (NFR-13: no currency is hard-coded here).
 */
export type MinorUnitOf = (currency: string) => number;

/**
 * **A cash movement is settled to its currency's minor unit, one movement at
 * a time.**
 *
 * A broker debits or credits each operation to the cent, so an account's
 * balance is the sum of per-movement *rounded* amounts. Summing the
 * unrounded legs and rounding only the total drifts away from the bank
 * statement: a USD trade settled in a EUR account carries
 * `gross × fx_rate` to twelve decimals, and ninety such sub-cent remainders
 * add up to whole cents.
 *
 * The movement is the **net** of one transaction on one cash account — the
 * principal, its withholding and its costs together — rounded `ROUND_HALF_UP`
 * (the system-wide mode) to that account currency's minor unit. The rounding
 * difference goes on the group's first CASH leg in `seq` order, which is the
 * principal leg whenever the row has one; the withholding and cost legs keep
 * the amounts stored on the row, so a total and its components are never
 * counted twice. A CURRENCY_EXCHANGE's two legs are two groups (two accounts,
 * two currencies), each rounded in its own currency.
 *
 * Only `amount_native` moves. `amount_base` is left exactly as expanded, so
 * the sum-to-zero invariant on base is untouched and quantities, prices and
 * rates are never rounded before the final movement. A position leg is never
 * rounded. The transaction row itself is not modified: the rounding lives in
 * this projection only.
 */
function roundCashMovements(
  drafts: PostingDraft[],
  minorUnitOf: MinorUnitOf,
): readonly PostingDraft[] {
  const groups = new Map<string, PostingDraft[]>();
  for (const draft of drafts) {
    if (draft.leg !== "CASH") continue;
    const key = `${draft.cashAccountId ?? ""}|${(draft.currency ?? "").trim()}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [draft]);
    else group.push(draft);
  }
  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const currency = (first.currency ?? "").trim();
    const net = group.reduce((sum, draft) => sum.plus(draft.amountNative), new Decimal(0));
    const rounded = net.toDecimalPlaces(minorUnitOf(currency), ROUNDING_MODE);
    const difference = rounded.minus(net);
    if (difference.isZero()) continue;
    first.amountNative = first.amountNative.plus(difference);
  }
  return drafts;
}

function expandUnrounded(txn: ExpandableTransaction): PostingDraft[] {
  const drafts: PostingDraft[] = [];
  const { kind } = txn;

  /** A cashless distribution's cost contribution — the one amount in this file that is a constant rather than a stored column. */
  const ZERO = new Decimal(0);

  /** `amountBase = amountNative × rate` — the fixed direction, applied nowhere else in this file. */
  const toBase = (native: Decimal, rate: Decimal): Decimal => native.times(rate);

  const emitPosition = (
    instrumentId: string,
    quantityDelta: Decimal,
    amountNative: Decimal,
    leg: TransactionLeg,
  ): void => {
    drafts.push({
      seq: drafts.length + 1,
      leg: "POSITION",
      instrumentId,
      currency: null,
      // A position leg moved no cash, so it names no account — the other half
      // of `0039`'s `(leg = 'CASH') = (cash_account_id IS NOT NULL)`.
      cashAccountId: null,
      quantityDelta,
      amountNative,
      amountBase: toBase(amountNative, txn.fxRate),
      fxRateApplied: txn.fxRate,
      fxRateSource: txn.fxRateSource,
      flowClass: classifyFlows({ kind, leg }),
    });
  };

  /**
   * `cashAccountId` is **last** deliberately: every other parameter is a
   * `Decimal`, a `FlowClass` or an `fxRateSource`, so a transposition with any
   * of them is a compile error. What the type system cannot catch is passing
   * the *wrong leg's* account (the fee's where the withholding's belongs) —
   * both are `string | null` — which is why that specific mutation is the
   * proof `posting-expander.cash-account.test.ts` performs rather than
   * something this signature claims.
   */
  const emitCash = (
    currency: string,
    amountNative: Decimal,
    amountBase: Decimal,
    rate: Decimal,
    rateSource: PostingDraft["fxRateSource"],
    flowClass: FlowClass,
    cashAccountId: string | null,
  ): void => {
    drafts.push({
      seq: drafts.length + 1,
      leg: "CASH",
      instrumentId: null,
      currency,
      cashAccountId,
      quantityDelta: null,
      amountNative,
      amountBase,
      fxRateApplied: rate,
      fxRateSource: rateSource,
      flowClass,
    });
  };

  /**
   * The **principal cash leg**, in the currency the settling account is
   * actually denominated in — phase 1 (FR-239, FR-240, FR-241, FR-245). `signedAmount` is
   * ±`gross_amount`, denominated in `txn_currency`; negative when value left
   * the portfolio, positive when it arrived.
   *
   * Used by exactly three of this function's `emitCash` sites — the
   * BUY/SELL/DRIP principal cash leg, DEPOSIT/WITHDRAWAL, and the DIVIDEND's
   * gross cash leg. CURRENCY_EXCHANGE's two legs, the withholding leg and the
   * fee leg do **not** go through it and are left literally untouched:
   * `transaction_currency_exchange_cash_leg_pinned` pins CE to the degenerate
   * case so routing it here would be a no-op, but "untouched source" is a
   * stronger guarantee than "provably equivalent".
   *
   * ## Two branches, and the degenerate one is the old code
   *
   * 1. **`cash_currency = txn_currency`** (cases D1/D2 — every row that
   *    existed before phase 1, and every row any writer produces until FT-12):
   *    the *existing* call, byte for byte, reaching no division.
   *    `fx_rate_applied` is the copied `fx_rate`, not a quotient that happens
   *    to equal it — FR-241 makes that a requirement rather than an
   *    optimisation, and `posting-expander.cross-currency-settlement.integration.test.ts`
   *    asserts the identity it buys.
   * 2. **`cash_currency ≠ txn_currency`** (D3/D4/D5): CURRENCY_EXCHANGE's
   *    shipped target-leg construction, reused verbatim. `amount_base` is
   *    `toBase(signedAmount, txn.fxRate)` — the *same expression of the same
   *    two stored numbers as branch 1*, so FR-234's "the base value is
   *    `gross_amount × fx_rate`" stays structural: this file contains no
   *    second expression producing a base amount, and in particular none
   *    producing one from `cash_amount`. `fx_rate_applied` is the account
   *    currency's *implied* rate to base, `amount_base / amount_native`,
   *    derived from two values already on the row and never resolved; it is
   *    carried so the posting stays self-describing, and — exactly
   *    as for the CURRENCY_EXCHANGE target leg — `amount_native ×
   *    fx_rate_applied` may differ from the stored `amount_base` in the low
   *    digits at `numeric(28,12)`. **`amount_base` is the authoritative
   *    figure.** No second rate is stored anywhere (L13).
   *
   * The comparison is **trimmed on both sides**, as
   * `TransactionWriteService#assertCashAccountsUsable` and `materialization.ts`
   * already trim: both columns are `char(3)`, and a mis-compare here would
   * silently route a D1/D2 row through the division and move
   * `fx_rate_applied`'s low digits on rows nothing touched. The division
   * cannot be by zero — `transaction_cash_amount_positive` is a database fact
   * and `cash_amount` is the only divisor.
   */
  const emitPrincipalCash = (txnCurrency: string, signedAmount: Decimal): void => {
    const cashCurrency = required(txn.cashCurrency, kind, "it has a currency but no cashCurrency");
    if (cashCurrency.trim() === txnCurrency.trim()) {
      // D1/D2 — the *existing* code, byte for byte (FR-241).
      emitCash(
        txnCurrency,
        signedAmount,
        toBase(signedAmount, txn.fxRate),
        txn.fxRate,
        txn.fxRateSource,
        classifyFlows({ kind }),
        txn.cashAccountId,
      );
      return;
    }
    const cashAmount = required(txn.cashAmount, kind, "it has a cashCurrency but no cashAmount");
    const amountBase = toBase(signedAmount, txn.fxRate);
    const amountNative = signedAmount.isNegative() ? cashAmount.negated() : cashAmount;
    emitCash(
      cashCurrency,
      amountNative,
      amountBase,
      amountBase.dividedBy(amountNative),
      txn.fxRateSource,
      classifyFlows({ kind }),
      txn.cashAccountId,
    );
  };

  /**
   * The principal money leg of a trade: cash in `txn_currency`, or a position
   * in the settlement asset. `signedAmount` is the value moving,
   * denominated in whichever of the two the row is settled in — negative on
   * an acquisition (value given up), positive on a disposal.
   *
   * For an asset-settled row the settlement asset's *units* and the money
   * amount are the same figure (`gross_amount` is denominated in that asset),
   * so it is both `quantity_delta` and `amount_native` on that leg.
   */
  const emitTradeMoneyLeg = (signedAmount: Decimal): void => {
    if (txn.txnSettlementInstrumentId !== null) {
      // FR-66/AC52: "buy 2 ETH paying 0.1 BTC" — the paid-with asset is a
      // real position leg, so the BTC disposal produces a realized gain
      // against BTC's PMP without the user entering a synthetic sell.
      emitPosition(txn.txnSettlementInstrumentId, signedAmount, signedAmount, "SETTLEMENT_ASSET");
      return;
    }
    const currency = required(
      txn.txnCurrency,
      kind,
      "it has neither currency nor a settlement instrument",
    );
    emitPrincipalCash(currency, signedAmount);
  };

  switch (kind) {
    case "BUY":
    case "DRIP": {
      const instrumentId = required(txn.instrumentId, kind, "it has no instrumentId");
      const quantity = required(txn.quantity, kind, "it has no quantity");
      // Acquisition: units in, value out. `gross_amount` is the value given
      // up, denominated in `txn_currency` or in the settlement asset's units.
      emitPosition(instrumentId, quantity, txn.grossAmount, "PRINCIPAL");
      emitTradeMoneyLeg(txn.grossAmount.negated());
      break;
    }
    case "SELL": {
      const instrumentId = required(txn.instrumentId, kind, "it has no instrumentId");
      const quantity = required(txn.quantity, kind, "it has no quantity");
      emitPosition(instrumentId, quantity.negated(), txn.grossAmount.negated(), "PRINCIPAL");
      emitTradeMoneyLeg(txn.grossAmount);
      break;
    }
    case "SHARE_DISTRIBUTION": {
      /**
       * **The 8th kind: one leg, and it is worth nothing** (migration `0056`).
       *
       * A cashless share distribution moves units and no money, so this is
       * the only branch in this function that emits a POSITION leg and
       * **no** money leg at all — `emitTradeMoneyLeg` is deliberately not
       * called, and `transaction_share_distribution_shape` makes the row
       * shape that would need one unrepresentable (`cash_account_id`,
       * `cash_currency` and `cash_amount` are all NULL, so the fee and
       * withholding blocks below cannot fire either).
       *
       * `amountNative` is **exactly zero**, and that is the cost-basis
       * statement rather than a placeholder: the position leg's amount is
       * what a holding's basis accumulates, and a free share adds
       * none. `gross_amount` on the row is the *market value* the source
       * supplied — it keeps `transaction_gross_amount_positive` satisfied
       * honestly and stays readable as "what these shares were worth on the
       * day" — and it is deliberately **not** the leg's amount, because
       * carrying it here would capitalise value that was never paid and
       * inflate every later realised gain's cost side.
       *
       * The sum-to-zero invariant therefore holds in its strongest form:
       * this transaction's legs sum to exactly `0`, with no fee or tax
       * leakage term to state it "up to". `posting-expander.property.test.ts`
       * asserts that as its own case rather than folding it into the general
       * one.
       */
      const instrumentId = required(txn.instrumentId, kind, "it has no instrumentId");
      const quantity = required(txn.quantity, kind, "it has no quantity");
      emitPosition(instrumentId, quantity, ZERO, "PRINCIPAL");
      break;
    }
    case "TRANSFER_OUT":
    case "TRANSFER_IN": {
      /**
       * **A security transfer's two legs: one POSITION leg each, no money leg**
       * (`security-transfer`, FR-561).
       *
       * The `SHARE_DISTRIBUTION` branch's structure — `emitTradeMoneyLeg` is
       * not called, and both transfer shape CHECKs force the three cash
       * columns, the fee and the withholding NULL, so no block below fires
       * either. Unlike that branch the amount is **not** zero: it is the
       * market value in `gross_amount`, the same convention as a `SELL`'s
       * position leg (a position posting records the value that moved, not
       * a cost basis — the carried cost lives on the row and in the replay,
       * `position-replay.ts`). `classifyFlows` answers `EXTERNAL` for both,
       * so the leg is the flow the sum-to-zero invariant is stated against.
       */
      const instrumentId = required(txn.instrumentId, kind, "it has no instrumentId");
      const quantity = required(txn.quantity, kind, "it has no quantity");
      if (kind === "TRANSFER_OUT") {
        emitPosition(instrumentId, quantity.negated(), txn.grossAmount.negated(), "PRINCIPAL");
      } else {
        emitPosition(instrumentId, quantity, txn.grossAmount, "PRINCIPAL");
      }
      break;
    }
    case "DEPOSIT":
    case "WITHDRAWAL":
    case "FEE": {
      // AC5/FR-8: exactly one CASH leg, in the specified currency, and no
      // POSITION leg at all — this arm reads no instrument: a FEE's reference
      // emits nothing. `FEE` (portfolio-cash, PC-L5) is WITHDRAWAL-shaped (the
      // sign below gives it `-gross`) and is classified `FEE` by
      // `classifyFlows`, never `EXTERNAL`.
      const currency = required(txn.txnCurrency, kind, "it has no currency");
      const native = kind === "DEPOSIT" ? txn.grossAmount : txn.grossAmount.negated();
      emitPrincipalCash(currency, native);
      break;
    }
    case "DIVIDEND":
    case "INTEREST": {
      // `INTEREST` (cash-interest, CI-D3) shares this arm: interest earned on
      // cash is DEPOSIT-shaped but INCOME, with the same optional withholding
      // TAX leg below.
      //
      // The **gross** dividend: the tax is its own
      // TAX leg below, so gross and net are both recoverable from the ledger.
      const currency = required(txn.txnCurrency, kind, "it has no currency");
      emitPrincipalCash(currency, txn.grossAmount);
      break;
    }
    case "CURRENCY_EXCHANGE": {
      const currency = required(txn.txnCurrency, kind, "it has no currency");
      const targetCurrency = required(txn.targetCurrency, kind, "it has no targetCurrency");
      const targetAmount = required(txn.targetAmount, kind, "it has no targetAmount");
      if (!targetAmount.greaterThan(0)) {
        throw new PostingExpansionError(kind, "its target_amount is not a positive amount");
      }
      const sourceBase = toBase(txn.grossAmount, txn.fxRate);
      emitCash(
        currency,
        txn.grossAmount.negated(),
        sourceBase.negated(),
        txn.fxRate,
        txn.fxRateSource,
        classifyFlows({ kind }),
        txn.cashAccountId,
      );
      // AC48: the exchange itself is value-neutral in base, so the target leg
      // carries exactly the base value the source leg gave up — that equality
      // is what keeps the two legs summing to zero at full precision, and it
      // is why `transaction` stores no second FX rate for the target side.
      //
      // `fx_rate_applied` for this leg is therefore the target currency's
      // *implied* rate to base, `amount_base / amount_native` — arithmetic on
      // two values already on the row (the stored `fx_rate` and the stored
      // `target_amount`), never a second resolution. It is carried so the
      // posting remains self-describing ("every posting carries a
      // copy of the rate that produced its amount_base"); the authoritative
      // figure is `amount_base` itself.
      // AC-176: the target leg's account is the row's *target* account, and
      // the source leg above kept its own — the two are independent, which is
      // the whole reason CD1 refused to collapse them into one column.
      emitCash(
        targetCurrency,
        targetAmount,
        sourceBase,
        sourceBase.dividedBy(targetAmount),
        txn.fxRateSource,
        classifyFlows({ kind }),
        txn.targetCashAccountId,
      );
      break;
    }
    default: {
      const unreachable: never = kind;
      throw new PostingExpansionError(
        String(unreachable),
        "its kind is not a known transaction kind",
      );
    }
  }

  // The withholding is one amount, denominated by the settling account
  // like a cost (L5) and carried at the principal's implied rate on the
  // principal's account. Emitted for any kind carrying one, not only DIVIDEND,
  // so an out-of-band row can never hide a tax leg from the ledger.
  if (txn.withholdingAmount !== null) {
    const cashCurrency = required(
      txn.cashCurrency,
      kind,
      "it has a withholding.amount denominated by the settling account but no cashCurrency — a withholding has no currency on a row with no cash leg",
    );
    const implied = principalImpliedRate(txn);
    const native = txn.withholdingAmount.negated();
    emitCash(
      cashCurrency,
      native,
      native.times(implied),
      implied,
      txn.fxRateSource,
      classifyFlows({ kind, leg: "WITHHOLDING_TAX" }),
      txn.cashAccountId,
    );
  }

  /**
   * **FR-216 — the itemised cost components.**
   *
   * Emitted after the withholding leg, in the enum's own declaration order
   * (`BROKER_FEE, FX_FEE, TAX, OTHER`), so the posting sequence
   * is a total order over any subset and re-expanding an unchanged row differs
   * only in freshly minted ids (P11, `:140-149`).
   *
   * Per present component: the **settling account's** currency and the
   * principal account — after L5 a cost is denominated in the account that
   * paid it, and there is no fee account — `amount_native = −cᵢ`,
   * `amount_base = −cᵢ × implied`, `fx_rate_applied = implied` and the
   * transaction's own `fx_rate_source`, copied exactly as the settlement leg's
   * is.
   *
   * **`implied` is the principal cash posting's own rate**, so a cost's base
   * value is converted by the same rate as the trade it belongs to — which is
   * what makes the whole row still sum the way the sum-to-zero property asserts. In the
   * degenerate case it is `fx_rate` exactly, via the same branch FR-241 pins.
   *
   * The exactness trap this creates is real and is FT-32's subject:
   * `Σ(cᵢ × implied) ≠ (Σcᵢ) × implied` at `precision: 34`, because `implied`
   * is a division result and five separately-rounded products do not sum to
   * one rounded product. Consequence, accepted and documented: `fee_amount ×
   * implied` (what a "total costs in EUR" display computes) and `Σᵢ
   * amount_base` over these postings can differ in the last digits, and **the
   * postings are authoritative** — exactly as `amount_base` is authoritative
   * over `amount_native × fx_rate_applied` on the settlement leg.
   */
  const components = [
    { amount: txn.brokerFeeAmount, leg: "FEE" },
    { amount: txn.fxFeeAmount, leg: "FEE" },
    // A trade tax classifies as `TAX`, the same class a withheld dividend tax
    // carries. `classifyFlows` is still the only classifier — it is reached through the leg whose classification is identical,
    // rather than by adding a sixth leg value to `core/domain` for an outcome
    // that would not differ. `flow_class` gains no value and there is no
    // `ALTER TYPE`.
    { amount: txn.taxAmount, leg: "WITHHOLDING_TAX" },
    { amount: txn.otherCostAmount, leg: "FEE" },
  ] as const;
  const itemised = components.some((component) => component.amount !== null);

  if (itemised) {
    const total = required(
      txn.feeAmount,
      kind,
      "it carries cost components but no feeAmount to total them",
    );
    // Read for its side effect on the error path: a component set with no
    // total is refused above, and a total with no principal cash leg has no
    // currency to be denominated in.
    void total;
    const cashCurrency = required(
      txn.cashCurrency,
      kind,
      "it carries cost components but no cashCurrency — after L5 a cost is denominated in the settling account's currency, and this row has no cash leg",
    );
    const implied = principalImpliedRate(txn);
    for (const component of components) {
      if (component.amount === null) continue;
      const native = component.amount.negated();
      emitCash(
        cashCurrency,
        native,
        native.times(implied),
        implied,
        txn.fxRateSource,
        classifyFlows({ kind, leg: component.leg }),
        txn.cashAccountId,
      );
    }
    return drafts;
  }

  /**
   * **An unitemised total, denominated by the settling account** — Batch F's
   * shape, and since `0049` the **only** shape.
   *
   * FT-36's `CostInput` drops `currency` and `cashAccountId` under L5, so a row
   * carries a `fee_amount` with no currency of its own; `0048`
   * made the database accept that and `0049`
   * removed the columns entirely.
   *
   * It emits exactly what the itemised loop above emits for one component,
   * because it *is* the same rule: L5 denominates a cost by the account that
   * paid it. So the two shapes agree, and FR-216's "exactly one posting" holds
   * for both.
   *
   * **A second branch stood here until `0049`**, reached when `fee_currency`
   * was present, emitting the cost in its own currency at its own stored rate
   * (FR-60/AC49). It was what kept pre-phase-2 rows expanding byte-identically,
   * and it is gone with its columns. That is safe because it was never *taken*
   * by a stored row: all 226 costed rows in the deployed database had
   * `fee_currency = txn_currency`, `fee_fx_rate = fx_rate` and
   * `fee_cash_account_id = cash_account_id`, so both branches produced the same
   * posting. Measured before `0049` was written, and asserted in
   * `transaction-fee-fx-leg-retired.integration.test.ts`.
   */
  if (txn.feeAmount !== null) {
    const cashCurrency = required(
      txn.cashCurrency,
      kind,
      "it has a feeAmount denominated by the settling account (L5) but no cashCurrency — a cost has no currency on a row with no cash leg",
    );
    const implied = principalImpliedRate(txn);
    const native = txn.feeAmount.negated();
    emitCash(
      cashCurrency,
      native,
      native.times(implied),
      implied,
      txn.fxRateSource,
      classifyFlows({ kind, leg: "FEE" }),
      txn.cashAccountId,
    );
    return drafts;
  }

  return drafts;
}
