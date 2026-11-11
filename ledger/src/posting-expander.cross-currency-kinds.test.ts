import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import {
  expandPostings,
  PostingExpansionError,
  type ExpandableTransaction,
} from "./posting-expander.js";
import { testMinorUnitOf } from "./posting-expander.test-support.js";

/**
 * **GATE-A (FT-11), independent test author.**
 *
 * `posting-expander.cross-currency-settlement.test.ts` (FT-8) enumerates D1–D5
 * for **BUY** and, for D3 only, for **DEPOSIT**. `emitPrincipalCash` is reached
 * from three call sites covering six kinds — BUY/SELL/DRIP,
 * DEPOSIT/WITHDRAWAL and DIVIDEND — and L3 makes the rule *uniform across every
 * kind*, which is a claim about the five kinds AC-274's worked examples never
 * exercise. This file grades those.
 *
 * What it adds that no FT-1…FT-10 suite covers:
 *
 * 1. **The sign branch on a disposal.** `amountNative = signedAmount.isNegative()
 *    ? cashAmount.negated() : cashAmount` is only ever taken down its *negative*
 *    leg by FT-8 (BUY, WITHDRAWAL never appears at all). SELL, DRIP, DIVIDEND
 *    and WITHDRAWAL together exercise both legs on every kind.
 * 2. **The composition of a cross-currency principal leg with the two legs the
 *    helper deliberately does not touch** — withholding and fee. FT-8's five
 *    worked cases carry neither.
 * 3. **CURRENCY_EXCHANGE really does not read the new columns** — asserted
 *    behaviourally by handing the expander a CE row whose `cashCurrency`
 *    differs from `txnCurrency` (a shape `transaction_currency_exchange_cash_leg_pinned`
 *    forbids in the database, which is exactly why no database-level suite can
 *    prove the *source* is untouched) and observing the source leg still
 *    denominated in `txn_currency`.
 * 4. **The two new `PostingExpansionError` paths** the helper introduces.
 *    `required(txn.cashCurrency, …)` and `required(txn.cashAmount, …)` are new
 *    failure modes on a function whose whole contract is "fail loud"; neither
 *    is asserted anywhere in Batch A.
 *
 * Every expected figure is hand-computed here from the stated rules
 * (`amount_base = ±gross × fx_rate`; `fx_rate_applied = amount_base /
 * amount_native`), never from the implementation's own expression.
 */

const AAPL = "00000000-0000-7000-8000-0000feaa1001";
const ACCOUNT = "00000000-0000-7000-8000-0000feaa2001";
const TARGET_ACCOUNT = "00000000-0000-7000-8000-0000feaa2002";

/**
 * A row with every column spelled out. Deliberately **not** a factory that
 * mirrors `cash_currency` onto `txn_currency` after the overrides, the way
 * `posting-expander.test.ts` and `posting-expander.cash-account.test.ts` now
 * do: such a factory cannot express a single case in this file.
 */
function row(overrides: Partial<ExpandableTransaction>): ExpandableTransaction {
  return {
    kind: "BUY",
    instrumentId: null,
    quantity: null,
    grossAmount: new Decimal("100"),
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: ACCOUNT,
    targetCashAccountId: null,
    cashCurrency: "EUR",
    cashAmount: new Decimal("100"),
    feeAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: null,
    fxRate: new Decimal("1"),
    fxRateSource: "IMPLIED_BASE",
    ...overrides,
  };
}

describe("expandPostings — L3 uniformity: the cross-currency principal leg on the kinds AC-274 never works", () => {
  it("SELL in D5 shape: cash comes IN, so amount_native is +880,00 CHF and the base legs still cancel", () => {
    // SELL 10 AAPL at 100,00 USD (gross 1 000,00 USD), fx_rate 0,90 to EUR
    // base, proceeds landing in a CHF account for 880,00 CHF.
    //   POSITION: −10 units, native −1 000,00, base −900,00, applied 0,90
    //   CASH:     native +880,00 CHF, base +900,00, applied 900/880 = 1,022727272727
    const postings = expandPostings(
      row({
        kind: "SELL",
        instrumentId: AAPL,
        quantity: new Decimal("10"),
        grossAmount: new Decimal("1000.00"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.90"),
        fxRateSource: "PROVIDER",
        cashCurrency: "CHF",
        cashAmount: new Decimal("880.00"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((p) => p.leg)).toEqual(["POSITION", "CASH"]);
    const [position, cash] = postings;
    expect(position!.quantityDelta!.toString()).toBe("-10");
    expect(position!.amountNative.toString()).toBe("-1000");
    expect(position!.amountBase.toString()).toBe("-900");
    expect(position!.fxRateApplied.toFixed(12)).toBe("0.900000000000");

    expect(cash!.seq).toBe(2);
    expect(cash!.currency).toBe("CHF");
    expect(cash!.cashAccountId).toBe(ACCOUNT);
    // The sign branch: a disposal is a positive `signedAmount`, so the CHF
    // figure is positive — cash arrived.
    expect(cash!.amountNative.toString()).toBe("880");
    expect(cash!.amountBase.toString()).toBe("900");
    expect(cash!.fxRateApplied.toFixed(12)).toBe("1.022727272727");
    expect(cash!.flowClass).toBe("INTERNAL");
    expect(cash!.fxRateSource).toBe("PROVIDER");

    expect(position!.amountBase.plus(cash!.amountBase).isZero()).toBe(true);
  });

  it("DRIP in D5 shape: cash goes OUT, so amount_native is −880,00 CHF and the base legs cancel", () => {
    const postings = expandPostings(
      row({
        kind: "DRIP",
        instrumentId: AAPL,
        quantity: new Decimal("10"),
        grossAmount: new Decimal("1000.00"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.90"),
        fxRateSource: "PROVIDER",
        cashCurrency: "CHF",
        cashAmount: new Decimal("880.00"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((p) => p.leg)).toEqual(["POSITION", "CASH"]);
    const [position, cash] = postings;
    expect(position!.quantityDelta!.toString()).toBe("10");
    expect(position!.amountBase.toString()).toBe("900");
    expect(cash!.currency).toBe("CHF");
    expect(cash!.amountNative.toString()).toBe("-880");
    expect(cash!.amountBase.toString()).toBe("-900");
    // (−900)/(−880) — the quotient of two negatives, positive, same digits.
    expect(cash!.fxRateApplied.toFixed(12)).toBe("1.022727272727");
    expect(cash!.flowClass).toBe("INTERNAL");
    expect(position!.amountBase.plus(cash!.amountBase).isZero()).toBe(true);
  });

  it("WITHDRAWAL in D3 shape: one EXTERNAL CHF leg of −960,00 against a base of −1 000,00", () => {
    // AC-266's own figures, on the kind AC-266 does not use.
    const postings = expandPostings(
      row({
        kind: "WITHDRAWAL",
        grossAmount: new Decimal("1000.00"),
        txnCurrency: "EUR",
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        cashCurrency: "CHF",
        cashAmount: new Decimal("960.00"),
      }),
      testMinorUnitOf,
    );

    expect(postings).toHaveLength(1);
    const [cash] = postings;
    expect(cash!.seq).toBe(1);
    expect(cash!.leg).toBe("CASH");
    expect(cash!.currency).toBe("CHF");
    expect(cash!.amountNative.toString()).toBe("-960");
    expect(cash!.amountBase.toString()).toBe("-1000");
    expect(cash!.fxRateApplied.toFixed(12)).toBe("1.041666666667");
    expect(cash!.flowClass).toBe("EXTERNAL");
    expect(cash!.quantityDelta).toBeNull();
  });

  it("DIVIDEND in D5 shape, with a withholding leg: the principal leg converts, the tax leg is untouched", () => {
    // Gross dividend 200,00 USD, fx_rate 0,90 → base 180,00 EUR, credited to a
    // CHF account as 176,00 CHF. Withholding 15,00 CHF, denominated by the
    // settling account and carried at the principal's implied rate 180/176:
    // `amount_native = −15,00`, `amount_base = −15,00 × 180/176`.
    const postings = expandPostings(
      row({
        kind: "DIVIDEND",
        instrumentId: AAPL,
        grossAmount: new Decimal("200.00"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.90"),
        fxRateSource: "PROVIDER",
        cashCurrency: "CHF",
        cashAmount: new Decimal("176.00"),
        withholdingAmount: new Decimal("15.00"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((p) => p.leg)).toEqual(["CASH", "CASH"]);
    const [gross, tax] = postings;

    expect(gross!.seq).toBe(1);
    expect(gross!.currency).toBe("CHF");
    expect(gross!.cashAccountId).toBe(ACCOUNT);
    expect(gross!.amountNative.toString()).toBe("176");
    expect(gross!.amountBase.toString()).toBe("180");
    // 180 / 176 = 1,022727272727…
    expect(gross!.fxRateApplied.toFixed(12)).toBe("1.022727272727");
    expect(gross!.flowClass).toBe("INCOME");

    expect(tax!.seq).toBe(2);
    expect(tax!.currency).toBe("CHF");
    expect(tax!.cashAccountId).toBe(ACCOUNT);
    expect(tax!.amountNative.toString()).toBe("-15");
    // 15 × 180 / 176 = 15,340909… — the principal's implied rate.
    expect(tax!.amountBase.toFixed(10)).toBe("-15.3409090909");
    expect(tax!.fxRateApplied.toFixed(12)).toBe("1.022727272727");
    expect(tax!.fxRateSource).toBe("PROVIDER");
    expect(tax!.flowClass).toBe("TAX");
  });

  /**
   * FR-260: the title read "the fee leg keeps its OWN rate and its own account
   * (FR-60/AC49 alive in phase 1)". Phase 2 retired both — `0049` dropped the
   * columns — so the cost takes the **principal cash
   * posting's** rate and the settling account. In D4 that implied rate is
   * exactly 1, which makes this the sharpest place to state it: the figures
   * below are unchanged, and only their *provenance* moved.
   */
  it("DIVIDEND in D4 shape with a cost: the cost takes the principal leg's implied rate and the settling account", () => {
    // Gross 200,00 USD at 0,92 → base 184,00 EUR, credited to a EUR account as
    // 184,00 EUR (L11: the rate is authoritative). Cost 9,90, denominated by
    // that same EUR account at the same implied rate of 1.
    const postings = expandPostings(
      row({
        kind: "DIVIDEND",
        instrumentId: AAPL,
        grossAmount: new Decimal("200.00"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.92"),
        fxRateSource: "USER_PINNED",
        cashCurrency: "EUR",
        cashAmount: new Decimal("184.00"),
        feeAmount: new Decimal("9.90"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((p) => p.flowClass)).toEqual(["INCOME", "FEE"]);
    const [gross, fee] = postings;
    expect(gross!.currency).toBe("EUR");
    expect(gross!.amountNative.toString()).toBe("184");
    expect(gross!.amountBase.toString()).toBe("184");
    // D4: `amount_base / amount_native` is exactly 1 — no digit of the applied
    // rate survives from `fx_rate`, which is the whole of L11.
    expect(gross!.fxRateApplied.toFixed(12)).toBe("1.000000000000");
    expect(fee!.currency).toBe("EUR");
    // The settling account — `FEE_ACCOUNT` until `0049`.
    expect(fee!.cashAccountId).toBe(ACCOUNT);
    expect(fee!.amountNative.toString()).toBe("-9.9");
    expect(fee!.amountBase.toString()).toBe("-9.9");
    expect(fee!.fxRateApplied.toFixed(12)).toBe("1.000000000000");
  });

  it("DEPOSIT in D4 shape: the applied rate collapses to 1 and the base value is still gross × fx_rate", () => {
    const postings = expandPostings(
      row({
        kind: "DEPOSIT",
        grossAmount: new Decimal("1500.00"),
        txnCurrency: "USD",
        fxRate: new Decimal("0.92"),
        fxRateSource: "USER_PINNED",
        cashCurrency: "EUR",
        cashAmount: new Decimal("1380.00"),
      }),
      testMinorUnitOf,
    );

    expect(postings).toHaveLength(1);
    expect(postings[0]!.currency).toBe("EUR");
    expect(postings[0]!.amountNative.toString()).toBe("1380");
    expect(postings[0]!.amountBase.toString()).toBe("1380");
    expect(postings[0]!.fxRateApplied.toFixed(12)).toBe("1.000000000000");
    expect(postings[0]!.flowClass).toBe("EXTERNAL");
  });
});

describe("expandPostings — the four sites `emitPrincipalCash` deliberately does not serve", () => {
  it("CURRENCY_EXCHANGE's source leg is denominated in txn_currency even when cash_currency says otherwise", () => {
    // `transaction_currency_exchange_cash_leg_pinned` forbids this row in the
    // database, so no integration suite can make this observation. It is the
    // behavioural form of FT-5's "the CE sites are left literally untouched":
    // if the CE branch had been routed through the helper, the source leg
    // below would read `GBP` / −950,00 instead of `EUR` / −1 000,00.
    const postings = expandPostings(
      row({
        kind: "CURRENCY_EXCHANGE",
        grossAmount: new Decimal("1000.00"),
        txnCurrency: "EUR",
        targetCurrency: "USD",
        targetAmount: new Decimal("1090.00"),
        targetCashAccountId: TARGET_ACCOUNT,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        cashCurrency: "GBP",
        cashAmount: new Decimal("950.00"),
      }),
      testMinorUnitOf,
    );

    expect(postings.map((p) => p.leg)).toEqual(["CASH", "CASH"]);
    const [source, target] = postings;
    expect(source!.currency).toBe("EUR");
    expect(source!.amountNative.toString()).toBe("-1000");
    expect(source!.amountBase.toString()).toBe("-1000");
    expect(source!.fxRateApplied.toFixed(12)).toBe("1.000000000000");
    expect(source!.cashAccountId).toBe(ACCOUNT);

    expect(target!.currency).toBe("USD");
    expect(target!.amountNative.toString()).toBe("1090");
    expect(target!.amountBase.toString()).toBe("1000");
    expect(target!.cashAccountId).toBe(TARGET_ACCOUNT);
    expect(source!.amountBase.plus(target!.amountBase).isZero()).toBe(true);
  });

  it("an asset-settled BUY never reads the cash columns — the SETTLEMENT_ASSET leg is a POSITION", () => {
    const postings = expandPostings(
      row({
        kind: "BUY",
        instrumentId: AAPL,
        quantity: new Decimal("2"),
        grossAmount: new Decimal("0.1"),
        txnCurrency: null,
        txnSettlementInstrumentId: "00000000-0000-7000-8000-0000feaa3001",
        cashAccountId: null,
        cashCurrency: null,
        cashAmount: null,
        fxRate: new Decimal("60000"),
        fxRateSource: "USER_PINNED",
      }),
      testMinorUnitOf,
    );

    expect(postings.map((p) => p.leg)).toEqual(["POSITION", "POSITION"]);
    expect(postings.every((p) => p.currency === null)).toBe(true);
    expect(postings.every((p) => p.cashAccountId === null)).toBe(true);
  });
});

describe("expandPostings — the implied rate is unbounded, and `fx_rate_applied` is not", () => {
  it("a row the database accepts can produce an fx_rate_applied numeric(28,12) cannot store", () => {
    // `transaction_posting.fx_rate_applied` is `numeric(28,12)`: 16 integer
    // digits. The expander's implied rate is `amount_base / amount_native`,
    // and no constraint in `0045`/`0046` relates `cash_amount` to
    // `gross_amount × fx_rate` once the currencies differ — only
    // `transaction_cash_amount_positive`, whose floor is `numeric(38,12)`'s
    // smallest unit. The row below is accepted by every one of the 31 CHECKs
    // and by the re-pointed FK (asserted in
    // `platform/db/src/transaction-cash-leg-composition.integration.test.ts`),
    // and its expansion is unpersistable.
    //
    // Characterisation, not a guard on a guard: the expander is pure and
    // FR-239 fixes this formula, so this assertion stays true whatever
    // validation Batch B adds on the write path — which is exactly where the
    // finding filed alongside it says the bound belongs.
    const postings = expandPostings(
      row({
        kind: "DEPOSIT",
        grossAmount: new Decimal("1000000"),
        txnCurrency: "USD",
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
        cashCurrency: "EUR",
        // `numeric(38,12)`'s smallest storable positive value.
        cashAmount: new Decimal("0.000000000001"),
      }),
      testMinorUnitOf,
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]!.fxRateApplied.toString()).toBe("1000000000000000000");
    // Sixteen integer digits is the ceiling; this needs nineteen.
    expect(postings[0]!.fxRateApplied.greaterThan(new Decimal("1e16"))).toBe(true);
  });

  /**
   * **Closed — and closed somewhere else on purpose.** The
   * assertion above is unchanged by the fix, and that is the point: the
   * expander is pure, FR-239 fixes this formula, and it has no business
   * refusing an input. What changed is that no writer can hand it one — the
   * create and edit paths bound the implied rate before the row is written
   * (`ImpliedSettlementRateOutOfRangeError`, mapped to 422
   * `IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE`).
   *
   * This test states the boundary between the two layers, because "the
   * expander still does this" would otherwise read as an unfixed defect to
   * the next person who greps for the issue number.
   */
  it("the expander still computes it, unbounded — the refusal lives on the write path, not here", () => {
    const source = readFileSync(resolve(process.cwd(), "ledger/src/posting-expander.ts"), "utf8");
    // No guard was smuggled into the pure layer: the expander names no bound,
    // no maximum and no rate-range error.
    expect(source).not.toContain("ImpliedSettlementRateOutOfRangeError");
    expect(source).not.toMatch(/FX_RATE_APPLIED_MAX/);

    // And the write path does carry it, by name — a two-sided assertion, so
    // this cannot pass by the guard having been deleted from both layers.
    const writeService = readFileSync(
      resolve(process.cwd(), "ledger/src/transaction-write-service.ts"),
      "utf8",
    );
    expect(writeService).toContain("class ImpliedSettlementRateOutOfRangeError");
    expect(writeService).toContain("assertImpliedSettlementRateRepresentable");
  });
});

describe("expandPostings — the two failure paths `emitPrincipalCash` introduces", () => {
  it("a fiat principal leg with no cashCurrency fails loud, naming the kind and the missing field", () => {
    expect(() =>
      expandPostings(
        row({
          kind: "DEPOSIT",
          grossAmount: new Decimal("100"),
          txnCurrency: "EUR",
          cashCurrency: null,
          cashAmount: null,
        }),
        testMinorUnitOf,
      ),
    ).toThrow(/DEPOSIT.*currency but no cashCurrency/s);
  });

  it("…and the same call throws PostingExpansionError, not a TypeError from a null dereference", () => {
    expect(() =>
      expandPostings(
        row({
          kind: "SELL",
          instrumentId: AAPL,
          quantity: new Decimal("1"),
          grossAmount: new Decimal("100"),
          txnCurrency: "EUR",
          cashCurrency: null,
          cashAmount: null,
        }),
        testMinorUnitOf,
      ),
    ).toThrow(PostingExpansionError);
  });

  it("a cross-currency row with no cash_amount fails loud rather than dividing by a null", () => {
    expect(() =>
      expandPostings(
        row({
          kind: "WITHDRAWAL",
          grossAmount: new Decimal("100"),
          txnCurrency: "EUR",
          cashCurrency: "CHF",
          cashAmount: null,
        }),
        testMinorUnitOf,
      ),
    ).toThrow(/WITHDRAWAL.*cashCurrency but no cashAmount/s);
  });

  it("the degenerate branch does NOT require cash_amount — it never reads it (FR-241's byte-identity)", () => {
    // A row whose `cash_amount` is missing but whose currencies agree is
    // impossible in the database (`transaction_cash_amount_currency_pairing`),
    // and the point of asserting it here is the *converse*: the degenerate
    // branch reaches neither `required(cashAmount)` nor the division, which is
    // what "the old code byte for byte" means operationally.
    const postings = expandPostings(
      row({
        kind: "WITHDRAWAL",
        grossAmount: new Decimal("100"),
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: null,
      }),
      testMinorUnitOf,
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]!.amountNative.toString()).toBe("-100");
    expect(postings[0]!.fxRateApplied.toString()).toBe("1");
  });
});
