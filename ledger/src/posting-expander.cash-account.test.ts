import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { expandPostings, type ExpandableTransaction } from "./posting-expander.js";

/**
 * **CA-6 — the four-column copy-down, asserted leg by leg**
 * (CD1/CD4; FR-156,
 * FR-157, AC-176).
 *
 * `expandPostings` gained one parameter and four source columns, and the whole
 * risk of that change is a *routing* mistake: the fee leg emitted with the
 * withholding leg's account, or the CURRENCY_EXCHANGE target emitted with the
 * source's. Nothing about it is type-checkable — every one of the four is
 * `string | null` — and nothing about it moves an amount, so the sum-to-zero
 * property in `posting-expander.property.test.ts` stays green under every
 * possible mis-routing. That is exactly why this file exists and why its
 * assertions are per-leg identities rather than "an account is present".
 *
 * The four ids below are deliberately distinct constants. A fixture that used
 * one shared account for all four legs would pass under any permutation of the
 * arguments, which is the vacuous form of this test.
 *
 * The transposition proof itself is `mapping-by-mutation`, done by hand:
 * swapping two of `emitCash`'s call-site arguments in
 * `posting-expander.ts` must make this suite red. It is not automatable here
 * without shipping a mutant of the source file, so it is performed by hand and
 * its output captured — but the assertions below are what make it *possible*
 * for it to go red.
 */

const INSTRUMENT = "00000000-0000-7000-8000-000000310001";
const SETTLEMENT_INSTRUMENT = "00000000-0000-7000-8000-000000310002";

const PRINCIPAL_ACCOUNT = "00000000-0000-7000-8000-0000000ac001";
const TARGET_ACCOUNT = "00000000-0000-7000-8000-0000000ac002";

/**
 * Every row here is case D1/D2 — `cash_currency`/`cash_amount` mirror
 * `txn_currency`/`gross_amount` (`0045`'s
 * `transaction_cash_degenerate_equals_gross`), applied after the overrides so a
 * fixture that moves `txn_currency` stays degenerate. Cross-currency settlement
 * changes which *currency* a cash leg carries and never which *account*, so it
 * is out of this file's subject and has its own fixtures in
 * `posting-expander.cross-currency-settlement.test.ts`.
 */
function txn(overrides: Partial<ExpandableTransaction>): ExpandableTransaction {
  const row = {
    kind: "DEPOSIT",
    instrumentId: null,
    quantity: null,
    grossAmount: new Decimal("100"),
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: PRINCIPAL_ACCOUNT,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    feeAmount: null,
    // 0047's cost components — absent on every fixture here; the itemised
    // shape is FT-31's own suite.
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: null,
    fxRate: new Decimal("1"),
    fxRateSource: "IMPLIED_BASE",
    ...overrides,
  } satisfies ExpandableTransaction;
  return {
    ...row,
    cashCurrency: row.txnCurrency,
    cashAmount: row.txnCurrency === null ? null : row.grossAmount,
  };
}

describe("expandPostings — cash-account copy-down (CA-6)", () => {
  /**
   * FR-260: **four** legs until `0049`. A cost no longer names
   * an account of its own — it leaves the settling one (L5) — so the maximal
   * row now routes three columns, and the cost posting rides on the principal's
   * account rather than a fourth. The property CA-6 is about is unchanged and
   * is still asserted the same way: one ordered tuple, so a swap between legs
   * cannot pass.
   */
  it("routes every leg of one transaction to its own account, and the cost to the settling one", () => {
    // The maximal row: a CURRENCY_EXCHANGE cannot carry a withholding leg in
    // practice, but `expandPostings` emits one for any kind that has the
    // columns set (its own doc comment's "so an out-of-band row can never hide
    // a tax leg"), which makes this the one row that exercises every column at
    // once.
    const postings = expandPostings(
      txn({
        kind: "CURRENCY_EXCHANGE",
        grossAmount: new Decimal("1000"),
        txnCurrency: "EUR",
        cashAccountId: PRINCIPAL_ACCOUNT,
        targetCurrency: "USD",
        targetAmount: new Decimal("1080"),
        targetCashAccountId: TARGET_ACCOUNT,
        feeAmount: new Decimal("5"),
        withholdingAmount: new Decimal("7"),
      }),
    );

    // Asserted as one ordered tuple of `(currency, account)` pairs rather than
    // four independent lookups: a swap between two legs keeps every individual
    // "is an account present" check green and changes only the pairing.
    expect(postings.map((posting) => `${posting.currency}:${posting.cashAccountId}`)).toEqual([
      `EUR:${PRINCIPAL_ACCOUNT}`,
      `USD:${TARGET_ACCOUNT}`,
      // The withholding and the cost: the settling account's currency and the
      // settling account, never one of their own.
      `EUR:${PRINCIPAL_ACCOUNT}`,
      `EUR:${PRINCIPAL_ACCOUNT}`,
    ]);
    // Two distinct accounts across four postings — the premise that makes the
    // tuple above discriminating.
    expect(new Set(postings.map((posting) => posting.cashAccountId)).size).toBe(2);
  });

  it("AC-176 — a CURRENCY_EXCHANGE's source and target accounts are independent: changing one leaves the other untouched", () => {
    const base = {
      kind: "CURRENCY_EXCHANGE" as const,
      grossAmount: new Decimal("1000"),
      txnCurrency: "EUR",
      targetCurrency: "USD",
      targetAmount: new Decimal("1080"),
    };
    const before = expandPostings(
      txn({ ...base, cashAccountId: PRINCIPAL_ACCOUNT, targetCashAccountId: TARGET_ACCOUNT }),
    );
    const otherTarget = "00000000-0000-7000-8000-0000000ac009";
    const after = expandPostings(
      txn({ ...base, cashAccountId: PRINCIPAL_ACCOUNT, targetCashAccountId: otherTarget }),
    );

    expect(before[0]!.cashAccountId).toBe(PRINCIPAL_ACCOUNT);
    expect(after[0]!.cashAccountId).toBe(PRINCIPAL_ACCOUNT);
    expect(before[1]!.cashAccountId).toBe(TARGET_ACCOUNT);
    expect(after[1]!.cashAccountId).toBe(otherTarget);
    // Nothing else moved: the two expansions differ in exactly that one field.
    expect(after.map((p) => ({ ...p, cashAccountId: null }))).toEqual(
      before.map((p) => ({ ...p, cashAccountId: null })),
    );
  });

  /**
   * FR-260: the second half read "while its fee leg does". A cost has no
   * account of its own after `0049` and an asset-settled row
   * has no settling account either, so such a row can carry **no cost at all**
   * — refused at the write path and unexpandable here. The
   * surviving claim is FR-157's, with both POSITION legs as its non-vacuous
   * half.
   */
  it("FR-157 — an asset-settled BUY names no account on either position leg", () => {
    const postings = expandPostings(
      txn({
        kind: "BUY",
        instrumentId: INSTRUMENT,
        quantity: new Decimal("2"),
        grossAmount: new Decimal("0.1"),
        txnCurrency: null,
        txnSettlementInstrumentId: SETTLEMENT_INSTRUMENT,
        cashAccountId: null,
      }),
    );

    expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "POSITION"]);
    // Both POSITION legs — including the settlement-asset one, which is the
    // leg that "paid" — carry no account: they moved an asset, not cash.
    expect(postings[0]!.cashAccountId).toBeNull();
    expect(postings[1]!.cashAccountId).toBeNull();
  });

  it("every POSITION leg of a fiat trade carries a null account while its CASH leg carries the principal's", () => {
    const postings = expandPostings(
      txn({
        kind: "SELL",
        instrumentId: INSTRUMENT,
        quantity: new Decimal("5"),
        grossAmount: new Decimal("550"),
        txnCurrency: "EUR",
        cashAccountId: PRINCIPAL_ACCOUNT,
      }),
    );
    expect(postings.map((posting) => [posting.leg, posting.cashAccountId] as const)).toEqual([
      ["POSITION", null],
      ["CASH", PRINCIPAL_ACCOUNT],
    ]);
  });

  /**
   * FR-260: the cost leg no longer takes a column of its own (`0049`), so it
   * takes the settling account's. The AC-172 shape this case is really about —
   * several accounts of one currency in one portfolio, where currency cannot
   * distinguish the legs — is unchanged and still what the tuple below pins.
   */
  it("a DIVIDEND's principal, withholding and cost legs all take the settling account", () => {
    const postings = expandPostings(
      txn({
        kind: "DIVIDEND",
        instrumentId: INSTRUMENT,
        grossAmount: new Decimal("40"),
        txnCurrency: "USD",
        cashAccountId: PRINCIPAL_ACCOUNT,
        withholdingAmount: new Decimal("6"),
        feeAmount: new Decimal("1"),
      }),
    );

    // All three legs are USD, so currency cannot distinguish them — which is
    // the AC-172 shape (several accounts of one currency in one portfolio) at
    // the expander layer, and the case a currency-keyed implementation would
    // silently collapse.
    expect(postings.map((posting) => posting.currency)).toEqual(["USD", "USD", "USD"]);
    expect(postings.map((posting) => posting.cashAccountId)).toEqual([
      PRINCIPAL_ACCOUNT,
      PRINCIPAL_ACCOUNT,
      PRINCIPAL_ACCOUNT,
    ]);
  });

  it("copies the account through unchanged — it is never derived from the currency", () => {
    // Two rows identical except for the account: same currency, same amounts.
    // A resolver-by-currency implementation would return the same account for
    // both, which is the mechanism rejected here.
    const other = "00000000-0000-7000-8000-0000000ac00a";
    const a = expandPostings(txn({ cashAccountId: PRINCIPAL_ACCOUNT }));
    const b = expandPostings(txn({ cashAccountId: other }));
    expect(a[0]!.currency).toBe(b[0]!.currency);
    expect(a[0]!.cashAccountId).toBe(PRINCIPAL_ACCOUNT);
    expect(b[0]!.cashAccountId).toBe(other);
  });
});
