import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import {
  PostingExpansionError,
  expandPostings,
  type ExpandableTransaction,
} from "./posting-expander.js";
import { testMinorUnitOf } from "./posting-expander.test-support.js";

/**
 * Pure/no-DB tests for T-21's posting expander. The
 * expander is a pure function of a `transaction` row, so its whole contract is
 * assertable without Postgres; the Testcontainers half — that all seven write
 * paths persist this expansion inside their own DB transaction, and that an
 * edit regenerates it — lives in
 * `transaction-write-service.integration.test.ts`, one `describe` per
 * acceptance criterion.
 *
 * The sum-to-zero invariant is stated and exercised over generated
 * transactions in `posting-expander.property.test.ts`.
 */

const ETH = "00000000-0000-7000-8000-000000210001";
const BTC = "00000000-0000-7000-8000-000000210002";
const SHARE = "00000000-0000-7000-8000-000000210003";

/**
 * The principal leg's cash account (CA-6) — this file's rows are single-leg or
 * fee-less, so one id is enough here. The per-leg *routing* of all four
 * accounts is `posting-expander.cash-account.test.ts`'s subject, and it uses
 * four distinct ids precisely because a shared one would hide a mis-routing.
 */
const PRINCIPAL_ACCOUNT = "00000000-0000-7000-8000-0000000ac001";

/**
 * A `transaction` row's expandable columns, all NULL but the ones a caller
 * sets.
 *
 * **Every row this file builds is case D1/D2** — `cash_currency` mirrors
 * `txn_currency` and `cash_amount` mirrors `gross_amount`, which is `0045`'s
 * `transaction_cash_degenerate_equals_gross` and what every writer produces
 * (`transaction-write-service.ts`'s `degenerateCashLeg`). The mirror is applied
 * **after** the overrides, deliberately: several fixtures below are built by
 * spreading an already-built row and moving `txn_currency` on top of it, and a
 * mirror that had been frozen at the earlier currency would silently turn those
 * rows into case D3/D4/D5 and route them through the cross-currency division.
 * The cross-currency cases have their own worked fixtures, in
 * `posting-expander.cross-currency-settlement.test.ts`.
 */
function txn(overrides: Partial<ExpandableTransaction>): ExpandableTransaction {
  const row = {
    kind: "BUY",
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
    // An asset-settled row moves no cash and so has no denomination
    // (`transaction_settled_principal_has_no_cash_leg`); every other row
    // mirrors the trade's own.
    cashCurrency: row.txnCurrency,
    cashAmount: row.txnCurrency === null ? null : row.grossAmount,
  };
}

describe("expandPostings — DEPOSIT / WITHDRAWAL (AC5, FR-8: cash only, external)", () => {
  it("expands a DEPOSIT into exactly one CASH posting in the specified currency, and no POSITION posting", () => {
    const postings = expandPostings(
      txn({ kind: "DEPOSIT", grossAmount: new Decimal("2500"), txnCurrency: "EUR" }),
      testMinorUnitOf,
    );

    expect(postings).toHaveLength(1);
    expect(postings[0]).toEqual({
      seq: 1,
      leg: "CASH",
      instrumentId: null,
      currency: "EUR",
      // Named explicitly, not left to `toEqual`'s undefined-is-absent
      // tolerance: a draft that dropped the column entirely would otherwise
      // still match this object.
      cashAccountId: PRINCIPAL_ACCOUNT,
      quantityDelta: null,
      amountNative: new Decimal("2500"),
      amountBase: new Decimal("2500"),
      fxRateApplied: new Decimal("1"),
      fxRateSource: "IMPLIED_BASE",
      flowClass: "EXTERNAL",
    });
    // AC5 at the posting layer: no instrument's state can move, because no
    // POSITION leg exists to move it.
    expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
  });

  it("expands a WITHDRAWAL into one negative CASH posting, converted at the stored rate", () => {
    const postings = expandPostings(
      txn({
        kind: "WITHDRAWAL",
        grossAmount: new Decimal("400"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.9165"),
        fxRateSource: "PROVIDER",
      }),
      testMinorUnitOf,
    );

    expect(postings).toHaveLength(1);
    expect(postings[0]!.amountNative.toString()).toBe("-400");
    // The fixed direction: amount_base = amount_native × rate.
    expect(postings[0]!.amountBase.toString()).toBe("-366.6");
    expect(postings[0]!.fxRateApplied.toString()).toBe("0.9165");
    expect(postings[0]!.fxRateSource).toBe("PROVIDER");
    expect(postings[0]!.flowClass).toBe("EXTERNAL");
  });
});

describe("expandPostings — BUY / SELL (INTERNAL legs, plus the fee's own leg)", () => {
  const buy = txn({
    kind: "BUY",
    instrumentId: SHARE,
    quantity: new Decimal("12"),
    grossAmount: new Decimal("735"),
    txnCurrency: "EUR",
  });

  it("expands a BUY into a POSITION posting and a CASH posting, and nothing else", () => {
    const postings = expandPostings(buy, testMinorUnitOf);

    expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "CASH"]);
    expect(postings[0]!.instrumentId).toBe(SHARE);
    expect(postings[0]!.quantityDelta!.toString()).toBe("12");
    expect(postings[0]!.amountNative.toString()).toBe("735");
    expect(postings[1]!.currency).toBe("EUR");
    expect(postings[1]!.amountNative.toString()).toBe("-735");
    expect(postings[1]!.quantityDelta).toBeNull();
    expect(postings.every((posting) => posting.flowClass === "INTERNAL")).toBe(true);
    // The two legs are exact negations, so they cancel at full precision.
    expect(postings[0]!.amountBase.plus(postings[1]!.amountBase).isZero()).toBe(true);
  });

  /**
   * FR-260: the title read "carrying the fee's OWN rate (FR-60, AC49)". L6
   * retired that rate and `0049` dropped the column, so the
   * cost is carried at the **principal cash posting's** rate — for a degenerate
   * leg, `fx_rate` verbatim (FR-241). The posting, its `FEE` flow class and its
   * position in the order are unchanged, which is why this is a retarget and
   * not a deletion.
   */
  it("adds a third FEE posting when a cost was specified, carrying the principal leg's rate (L5)", () => {
    const postings = expandPostings(
      txn({
        ...buy,
        txnCurrency: "USD",
        fxRate: new Decimal("0.9165"),
        fxRateSource: "PROVIDER",
        feeAmount: new Decimal("9.90"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "CASH", "CASH"]);
    expect(postings.map((posting) => posting.flowClass)).toEqual(["INTERNAL", "INTERNAL", "FEE"]);
    const fee = postings[2]!;
    // The settling account's currency, which for this degenerate row is the
    // trade's own — EUR / rate 1 until `0049`.
    expect(fee.currency).toBe("USD");
    expect(fee.amountNative.toString()).toBe("-9.9");
    // 9,90 × 0,9165 = 9,073350, worked here rather than read back.
    expect(fee.amountBase.toString()).toBe("-9.07335");
    // AC47/FR-57 still holds, on the rate that remains: copied from the
    // principal leg, never re-resolved.
    expect(fee.fxRateApplied.toString()).toBe("0.9165");
    expect(fee.fxRateSource).toBe("PROVIDER");
  });

  it("expands a SELL into a negative POSITION posting and a positive CASH posting", () => {
    const postings = expandPostings(
      txn({
        kind: "SELL",
        instrumentId: SHARE,
        quantity: new Decimal("8"),
        grossAmount: new Decimal("496"),
        txnCurrency: "EUR",
      }),
      testMinorUnitOf,
    );

    expect(postings[0]!.quantityDelta!.toString()).toBe("-8");
    expect(postings[0]!.amountNative.toString()).toBe("-496");
    expect(postings[1]!.amountNative.toString()).toBe("496");
    expect(postings.every((posting) => posting.flowClass === "INTERNAL")).toBe(true);
  });

  it("expands a DRIP exactly as it expands a BUY — INTERNAL, never INCOME (the dividend was the income)", () => {
    const postings = expandPostings(
      txn({
        kind: "DRIP",
        instrumentId: SHARE,
        quantity: new Decimal("1.0625"),
        grossAmount: new Decimal("64"),
      }),
      testMinorUnitOf,
    );
    expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "CASH"]);
    expect(postings.map((posting) => posting.flowClass)).toEqual(["INTERNAL", "INTERNAL"]);
    expect(postings[0]!.quantityDelta!.toString()).toBe("1.0625");
  });
});

describe("expandPostings — DIVIDEND (FR-9: gross INCOME leg plus its own TAX leg)", () => {
  it("PP reference: gross 3.65 USD settled as 3.372 EUR, withholding 0.51 → INCOME +3.372 EUR and TAX −0.51 EUR at the principal's implied rate", () => {
    const postings = expandPostings(
      {
        ...txn({
          kind: "DIVIDEND",
          instrumentId: SHARE,
          grossAmount: new Decimal("3.65"),
          txnCurrency: "USD",
          fxRate: new Decimal("0.9237"),
          fxRateSource: "PROVIDER",
          withholdingAmount: new Decimal("0.51"),
        }),
        cashCurrency: "EUR",
        cashAmount: new Decimal("3.372"),
      },
      testMinorUnitOf,
    );

    expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX"]);
    const [income, tax] = postings;
    expect(income!.currency).toBe("EUR");
    // The account moves whole cents: the stated 3.372 settles as 3.37
    // (per-movement rounding, HALF_UP). The implied rate below still reads the
    // stored 3.372 — only the movement is rounded, never the row.
    expect(income!.amountNative.toString()).toBe("3.37");
    // 3.65 × 0.9237 / 3.372 — the principal's implied account→base rate.
    const implied = new Decimal("3.65").times("0.9237").dividedBy("3.372");
    expect(income!.fxRateApplied.equals(implied)).toBe(true);
    expect(tax!.currency).toBe("EUR");
    expect(tax!.cashAccountId).toBe(PRINCIPAL_ACCOUNT);
    expect(tax!.amountNative.toString()).toBe("-0.51");
    expect(tax!.fxRateApplied.equals(implied)).toBe(true);
    expect(tax!.amountBase.equals(new Decimal("-0.51").times(implied))).toBe(true);
    expect(tax!.fxRateSource).toBe("PROVIDER");
    // No instrument leg: a dividend does not move the position (`transaction_dividend_shape`
    // has no quantity to move it with).
    expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
  });

  it("a same-currency EUR dividend with a withholding posts the TAX leg at rate 1", () => {
    const postings = expandPostings(
      txn({
        kind: "DIVIDEND",
        instrumentId: SHARE,
        grossAmount: new Decimal("100"),
        withholdingAmount: new Decimal("30"),
      }),
      testMinorUnitOf,
    );
    expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX"]);
    expect(postings[1]!.currency).toBe("EUR");
    expect(postings[1]!.amountNative.toString()).toBe("-30");
    expect(postings[1]!.amountBase.toString()).toBe("-30");
    expect(postings[1]!.fxRateApplied.toString()).toBe("1");
  });

  it("emits a single INCOME leg when nothing was withheld", () => {
    const postings = expandPostings(
      txn({ kind: "DIVIDEND", instrumentId: SHARE, grossAmount: new Decimal("52.4") }),
      testMinorUnitOf,
    );
    expect(postings).toEqual([
      {
        seq: 1,
        leg: "CASH",
        instrumentId: null,
        currency: "EUR",
        cashAccountId: PRINCIPAL_ACCOUNT,
        quantityDelta: null,
        amountNative: new Decimal("52.4"),
        amountBase: new Decimal("52.4"),
        fxRateApplied: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        flowClass: "INCOME",
      },
    ]);
  });
});

/**
 * `cash-interest` AC-517 (FR-628, GATE-CI). An INTEREST shares DIVIDEND's
 * arm: the gross is one positive CASH leg classified INCOME, and the
 * withholding its own negative CASH leg classified TAX. Nothing else — no
 * POSITION leg, no EXTERNAL leg (that would make interest a contribution).
 *
 * The sum-to-zero invariant (`posting-expander.property.test.ts`) is
 * `Σ amount_base = Σ EXTERNAL + Σ INCOME − fee − tax`, i.e. the INTERNAL legs
 * cancel. Asserted here on the worked figures: no INTERNAL leg at all, and the
 * net in base is exactly gross − withholding.
 */
describe("expandPostings — INTEREST (cash-interest AC-517: gross INCOME leg plus its own TAX leg)", () => {
  const LIVRET = PRINCIPAL_ACCOUNT;
  const interest = txn({
    kind: "INTEREST",
    grossAmount: new Decimal("100.00"),
    txnCurrency: "EUR",
    withholdingAmount: new Decimal("30.00"),
  });

  /** The invariant's residue: Σ amount_base over the legs that are neither EXTERNAL, INCOME, FEE nor TAX. */
  function internalResidue(postings: ReturnType<typeof expandPostings>): Decimal {
    return postings
      .filter((posting) => posting.flowClass === "INTERNAL")
      .reduce((sum, posting) => sum.plus(posting.amountBase), new Decimal(0));
  }

  it("gross 100.00 / withholding 30.00 into « Livret »: CASH +100.00 INCOME and CASH −30.00 TAX, net +70.00", () => {
    const postings = expandPostings(interest, testMinorUnitOf);

    expect(postings.map((posting) => posting.leg)).toEqual(["CASH", "CASH"]);
    expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX"]);
    expect(postings.map((posting) => posting.cashAccountId)).toEqual([LIVRET, LIVRET]);
    expect(postings[0]!.amountNative.toString()).toBe("100");
    expect(postings[0]!.amountBase.toString()).toBe("100");
    expect(postings[1]!.amountNative.toString()).toBe("-30");
    expect(postings[1]!.amountBase.toString()).toBe("-30");
    expect(postings.some((posting) => posting.flowClass === "EXTERNAL")).toBe(false);
    expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
    // Sum-to-zero up to the leakage: nothing INTERNAL, and the base net is 70.
    expect(internalResidue(postings).isZero()).toBe(true);
    const net = postings.reduce((sum, posting) => sum.plus(posting.amountBase), new Decimal(0));
    expect(net.toString()).toBe("70");
  });

  it("without a withholding: exactly one CASH +100.00 INCOME leg", () => {
    const postings = expandPostings(
      txn({ kind: "INTEREST", grossAmount: new Decimal("100.00"), txnCurrency: "EUR" }),
      testMinorUnitOf,
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]!.leg).toBe("CASH");
    expect(postings[0]!.flowClass).toBe("INCOME");
    expect(postings[0]!.amountNative.toString()).toBe("100");
  });

  it("a USD 30.00 withholding on a USD interest at a typed rate: the TAX leg's amount_base is −30.00 × the principal's rate", () => {
    const postings = expandPostings(
      txn({
        ...interest,
        txnCurrency: "USD",
        fxRate: new Decimal("0.9165"),
        fxRateSource: "USER_PINNED",
      }),
      testMinorUnitOf,
    );

    expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX"]);
    const tax = postings[1]!;
    expect(tax.currency).toBe("USD");
    expect(tax.amountNative.toString()).toBe("-30");
    // −30.00 × 0.9165 = −27.495, worked here rather than read back.
    expect(tax.amountBase.toString()).toBe("-27.495");
    expect(tax.fxRateApplied.toString()).toBe("0.9165");
    expect(tax.fxRateSource).toBe("USER_PINNED");
    expect(internalResidue(postings).isZero()).toBe(true);
    expect(postings[0]!.amountBase.plus(tax.amountBase).toString()).toBe("64.155");
  });

  it("an edit of the gross to 120.00 regenerates the postings wholesale and the invariant still holds", () => {
    // Regeneration on edit is delete + re-expand of the edited row: the old
    // +100 leg must not survive beside the new one.
    const postings = expandPostings(
      {
        ...interest,
        grossAmount: new Decimal("120.00"),
        cashAmount: new Decimal("120.00"),
      },
      testMinorUnitOf,
    );

    expect(postings).toHaveLength(2);
    expect(postings.map((posting) => posting.amountBase.toString())).toEqual(["120", "-30"]);
    expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX"]);
    expect(internalResidue(postings).isZero()).toBe(true);
  });
});

describe("expandPostings — FEE (portfolio-cash AC-565, C-2: one CASH leg, classified FEE, never a position)", () => {
  const fee = txn({ kind: "FEE", grossAmount: new Decimal("10.00"), txnCurrency: "EUR" });

  it("FEE 10.00 gives exactly one CASH posting of −10.00, flow_class FEE, and no POSITION posting", () => {
    const postings = expandPostings(fee, testMinorUnitOf);

    expect(postings).toHaveLength(1);
    expect(postings[0]!.leg).toBe("CASH");
    expect(postings[0]!.flowClass).toBe("FEE");
    expect(postings[0]!.cashAccountId).toBe(PRINCIPAL_ACCOUNT);
    expect(postings[0]!.amountNative.toString()).toBe("-10");
    expect(postings[0]!.amountBase.toString()).toBe("-10");
    expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
  });

  it("the same FEE with an instrument id set is byte-identical: the reference emits no POSITION leg", () => {
    const withInstrument = expandPostings({ ...fee, instrumentId: SHARE }, testMinorUnitOf);

    expect(withInstrument).toHaveLength(1);
    expect(withInstrument[0]!.leg).toBe("CASH");
    expect(withInstrument[0]!.flowClass).toBe("FEE");
    expect(withInstrument[0]!.instrumentId ?? null).toBeNull();
    expect(withInstrument[0]!.amountNative.toString()).toBe("-10");
    expect(withInstrument.some((posting) => posting.leg === "POSITION")).toBe(false);
  });

  it("an edit of the amount to 30.00 regenerates the single leg wholesale", () => {
    const postings = expandPostings(
      {
        ...fee,
        grossAmount: new Decimal("30.00"),
        cashAmount: new Decimal("30.00"),
      },
      testMinorUnitOf,
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]!.amountBase.toString()).toBe("-30");
  });
});

describe("expandPostings — CURRENCY_EXCHANGE (FR-59, AC48: cash out of A, into B, no instrument leg)", () => {
  it("emits one negative CASH leg in A and one positive CASH leg in B, value-neutral in base", () => {
    const postings = expandPostings(
      txn({
        kind: "CURRENCY_EXCHANGE",
        grossAmount: new Decimal("1000"),
        txnCurrency: "EUR",
        targetCurrency: "USD",
        targetAmount: new Decimal("1091.575"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((posting) => posting.leg)).toEqual(["CASH", "CASH"]);
    expect(postings[0]!.currency).toBe("EUR");
    expect(postings[0]!.amountNative.toString()).toBe("-1000");
    expect(postings[1]!.currency).toBe("USD");
    // Each leg is rounded in its own currency: 1091.575 USD settles as 1091.58.
    expect(postings[1]!.amountNative.toString()).toBe("1091.58");
    // AC48's "leaves every instrument quantity and cost basis unchanged" at
    // the posting layer: there is no POSITION leg to change one.
    expect(postings.some((posting) => posting.leg === "POSITION")).toBe(false);
    // Value-neutral in base, exactly — this is what keeps the pair summing to
    // zero at full precision rather than to a tolerance.
    expect(postings[0]!.amountBase.plus(postings[1]!.amountBase).isZero()).toBe(true);
    // The target leg's implied rate to base: 1000 EUR of base value spread
    // over 1091.575 USD.
    expect(postings[1]!.fxRateApplied.toString()).toBe(
      new Decimal("1000").dividedBy(new Decimal("1091.575")).toString(),
    );
  });

  it("keeps the pair balanced when the source currency is itself non-base", () => {
    const postings = expandPostings(
      txn({
        kind: "CURRENCY_EXCHANGE",
        grossAmount: new Decimal("500"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.918"),
        fxRateSource: "USER_PINNED",
        targetCurrency: "JPY",
        targetAmount: new Decimal("74160"),
      }),
      testMinorUnitOf,
    );
    expect(postings[0]!.amountBase.toString()).toBe("-459");
    expect(postings[1]!.amountBase.toString()).toBe("459");
    expect(postings[1]!.amountNative.toString()).toBe("74160");
  });
});

describe("expandPostings — AC52/FR-66: a crypto-to-crypto BUY disposes of the asset it paid with", () => {
  const cryptoBuy = txn({
    kind: "BUY",
    instrumentId: ETH,
    quantity: new Decimal("2"),
    grossAmount: new Decimal("0.1"),
    txnCurrency: null,
    txnSettlementInstrumentId: BTC,
    fxRate: new Decimal("60000"),
    fxRateSource: "USER_PINNED",
  });

  it("emits a +2 ETH POSITION posting and a −0.1 BTC POSITION posting — the disposal, not a transfer", () => {
    const postings = expandPostings(cryptoBuy, testMinorUnitOf);

    expect(postings.map((posting) => posting.leg)).toEqual(["POSITION", "POSITION"]);
    const [acquired, disposed] = postings;
    expect(acquired!.instrumentId).toBe(ETH);
    expect(acquired!.quantityDelta!.toString()).toBe("2");
    expect(disposed!.instrumentId).toBe(BTC);
    expect(disposed!.quantityDelta!.toString()).toBe("-0.1");

    // "A disposal, not merely a transfer": the BTC leg carries a *valued*
    // negative quantity — 0.1 BTC at the stored BTC→EUR rate — which is
    // exactly the proceeds figure T-25 needs to compute a realized gain
    // against BTC's PMP. A transfer would move units with no
    // base-currency proceeds attached.
    expect(disposed!.amountNative.toString()).toBe("-0.1");
    expect(disposed!.amountBase.toString()).toBe("-6000");
    expect(disposed!.fxRateApplied.toString()).toBe("60000");
    expect(disposed!.fxRateSource).toBe("USER_PINNED");
    // Both legs are INTERNAL: the asset moved inside the portfolio, so
    // neither opens a TWR sub-period nor appears in XIRR.
    expect(postings.every((posting) => posting.flowClass === "INTERNAL")).toBe(true);
    // No CASH leg at all — nothing was settled in a currency.
    expect(postings.some((posting) => posting.leg === "CASH")).toBe(false);
  });

  it("keeps 18 dp on the disposed quantity — a float would collapse it (NFR-12, AC53)", () => {
    const postings = expandPostings(
      txn({ ...cryptoBuy, grossAmount: new Decimal("0.100000000000000001") }),
      testMinorUnitOf,
    );
    expect(postings[1]!.quantityDelta!.toString()).toBe("-0.100000000000000001");
    expect(postings[1]!.quantityDelta!.equals(new Decimal("-0.1"))).toBe(false);
    // Still exactly balanced at that precision.
    expect(postings[0]!.amountBase.plus(postings[1]!.amountBase).isZero()).toBe(true);
  });
});

describe("expandPostings — determinism and fail-closed refusals", () => {
  it("is deterministic: the same row expands to an identical set of drafts every time", () => {
    // What makes regeneration on edit safe (delete + insert): re-expanding an
    // unchanged row cannot change the ledger.
    const row = txn({
      kind: "BUY",
      instrumentId: SHARE,
      quantity: new Decimal("3"),
      grossAmount: new Decimal("90"),
      feeAmount: new Decimal("1.5"),
    });
    expect(expandPostings(row, testMinorUnitOf)).toEqual(expandPostings(row, testMinorUnitOf));
  });

  it("numbers postings 1..n in emission order", () => {
    const postings = expandPostings(
      txn({
        kind: "DIVIDEND",
        instrumentId: SHARE,
        withholdingAmount: new Decimal("10"),
        feeAmount: new Decimal("2"),
      }),
      testMinorUnitOf,
    );
    expect(postings.map((posting) => posting.seq)).toEqual([1, 2, 3]);
    expect(postings.map((posting) => posting.flowClass)).toEqual(["INCOME", "TAX", "FEE"]);
  });

  it("refuses a trade with no quantity rather than emitting a position leg of unknown size", () => {
    const attempt = () =>
      expandPostings(txn({ kind: "BUY", instrumentId: SHARE, quantity: null }), testMinorUnitOf);
    expect(attempt).toThrow(PostingExpansionError);
    expect(attempt).toThrow(/it has no quantity/);
  });

  /**
   * **FR-260 — this refusal is retired, and its successor asserted instead.**
   *
   * It read "refuses a fee with no stored rate rather than reusing the
   * principal's (FR-57)", and reusing the principal's rate is now precisely
   * what L5 prescribes. There is no `fee_fx_rate` to be missing.
   *
   * What replaces it is the refusal that took its place: a cost needs a
   * **settling account** to be denominated by, and a row with no cash leg has
   * none. Same discipline — a specific named refusal, not
   * "something threw" — on the constraint that still exists.
   */
  it("refuses a cost on a row with no cash leg to denominate it", () => {
    const attempt = () =>
      expandPostings(
        txn({
          kind: "BUY",
          instrumentId: SHARE,
          quantity: new Decimal("1"),
          txnCurrency: null,
          txnSettlementInstrumentId: BTC,
          cashAccountId: null,
          cashCurrency: null,
          cashAmount: null,
          feeAmount: new Decimal("2"),
        }),
        testMinorUnitOf,
      );
    expect(attempt).toThrow(PostingExpansionError);
    expect(attempt).toThrow(/denominated by the settling account/);
  });

  it("refuses a row settled in neither a currency nor an asset", () => {
    const attempt = () =>
      expandPostings(
        txn({
          kind: "BUY",
          instrumentId: SHARE,
          quantity: new Decimal("1"),
          txnCurrency: null,
          txnSettlementInstrumentId: null,
        }),
        testMinorUnitOf,
      );
    expect(attempt).toThrow(PostingExpansionError);
    expect(attempt).toThrow(/neither currency nor a settlement instrument/);
  });

  it("refuses a CURRENCY_EXCHANGE with no target amount, which would make its target leg unpriceable", () => {
    const attempt = () =>
      expandPostings(
        txn({ kind: "CURRENCY_EXCHANGE", targetCurrency: "USD", targetAmount: null }),
        testMinorUnitOf,
      );
    expect(attempt).toThrow(/it has no targetAmount/);
  });
});
