import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import { computeTransactionPreview } from "./transaction-preview.js";

/**
 * The preview's whole value is that it agrees with what the ledger records. A
 * figure computed a different way is worse than none — it teaches the user a
 * number the ledger then contradicts.
 *
 * So the expectations below are not hand-written arithmetic. They apply the
 * server's own expressions to the same inputs, and one test reads the server
 * source to prove those expressions are still what the server does.
 */
const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** The ledger's own gross: `quantity.times(unitPrice)`. */
function serverGross(quantity: string, unitPrice: string): Decimal {
  return parseDecimalString(quantity).times(parseDecimalString(unitPrice));
}

/** The ledger's own base conversion: `native.times(rate)`. */
function serverToBase(native: Decimal, rate: string): Decimal {
  return native.times(parseDecimalString(rate));
}

describe("preview arithmetic matches the ledger's, expression for expression", () => {
  it("computes gross as quantity × unitPrice", () => {
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "8",
      unitPrice: "612.40",
      currency: "EUR",
    });
    expect(preview.gross?.toString()).toBe(serverGross("8", "612.40").toString());
  });

  it("keeps full precision rather than rounding to a display scale", () => {
    // Rounding happens at display, through figure-format. If the preview
    // rounded here, its total would drift from the ledger's by a hair on
    // exactly the fractional-quantity trades where it matters most.
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "0.00000001",
      unitPrice: "63412.77",
      currency: "EUR",
    });
    expect(preview.gross?.toString()).toBe(serverGross("0.00000001", "63412.77").toString());
  });

  it("subtracts the fee from a sale and adds it to a purchase", () => {
    // posting-expander.ts: the fee leg is `feeAmount.negated()` whatever the
    // kind — money out of a buy and money out of a sale alike.
    const buy = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      feeAmount: "1.20",
    });
    const sell = computeTransactionPreview({
      kind: "SELL",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      feeAmount: "1.20",
    });

    expect(buy.cashMovement?.toString()).toBe(
      serverGross("10", "100").plus(parseDecimalString("1.20")).negated().toString(),
    );
    expect(sell.cashMovement?.toString()).toBe(
      serverGross("10", "100").minus(parseDecimalString("1.20")).toString(),
    );
  });

  it("converts to base as cashMovement × rate", () => {
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "USD",
      fxRateUserInput: "0.92",
    });
    const expected = serverToBase(serverGross("10", "100").negated(), "0.92");
    expect(preview.baseEquivalent?.toString()).toBe(expected.toString());
    expect(preview.rateIsUserInput).toBe(true);
  });

  it("still applies the server's expressions after a source change", () => {
    // The parity above is only meaningful while the server still computes it
    // that way. This reads the two definitions and fails if either moves, so
    // the preview cannot drift silently behind a refactor.
    const writeService = readFileSync(
      join(repoRoot, "ledger", "src", "transaction-write-service.ts"),
      "utf8",
    );
    const expander = readFileSync(join(repoRoot, "ledger", "src", "posting-expander.ts"), "utf8");

    expect(writeService).toContain("grossAmount: params.quantity.times(params.unitPrice)");
    expect(expander).toContain(
      "const toBase = (native: Decimal, rate: Decimal): Decimal => native.times(rate)",
    );
    expect(expander).toContain("txn.feeAmount.negated()");
  });
});

describe("what the preview refuses to claim", () => {
  it("shows nothing while the figures are half-typed", () => {
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "8",
      unitPrice: "",
      currency: "EUR",
    });
    expect(preview.gross).toBeUndefined();
    expect(preview.cashMovementGap).toBe("incomplete");
  });

  it("treats a partially-typed number as not-yet-available, not as an error", () => {
    for (const halfTyped of ["1.", "-", ".", "0.0.0", "abc"]) {
      const preview = computeTransactionPreview({
        kind: "BUY",
        quantity: halfTyped,
        unitPrice: "100",
        currency: "EUR",
      });
      expect(preview.gross, `"${halfTyped}" should not produce a figure`).toBeUndefined();
    }
  });

  /**
   * **FT-47 (FR-260, shape change).** This case asserted `fee-currency-differs`
   * on a fee in a third currency. That input no longer exists — a cost has no
   * currency of its own (L5) — so the case is re-keyed with the *situation*
   * that still produces the outcome: the cost is in the settling account's
   * currency and the gross is in the trade's, so the trade-currency total
   * cannot be stated. The claim is unchanged: a cost that cannot be added is
   * never silently dropped from a total.
   */
  it("refuses to total a cost that is denominated in the settling account's other currency", () => {
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      feeAmount: "3.00",
      cashCurrency: "USD",
      cashAmount: "1100.00",
    });
    // The **trade-currency** movement is the one that cannot be stated, and
    // the base equivalent derived from it goes with it.
    expect(preview.baseEquivalentGap).toBe("settlement-currency-differs");
    // The gross is still shown — it is unaffected and still true.
    expect(preview.gross?.toString()).toBe(serverGross("10", "100").toString());
  });

  /**
   * FT-47's second criterion: **the outcome is still reachable, and still
   * refuses only what it should.** A re-key that made it unreachable would
   * pass a single-case test while silently deleting a refusal the module's own
   * rule requires.
   */
  it("produces settlement-currency-differs on a D3/D4/D5 row with a cost, and never on a D1/D2 one", () => {
    const crossCurrency = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      feeAmount: "3.00",
      cashCurrency: "USD",
      cashAmount: "1100.00",
    });
    expect(crossCurrency.baseEquivalentGap).toBe("settlement-currency-differs");

    // D1/D2: the settlement currency **is** the trade's, so the cost is in the
    // trade's currency too and the total is stateable exactly as before.
    const degenerate = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      feeAmount: "3.00",
      cashCurrency: "EUR",
      cashAmount: "1003.00",
    });
    expect(degenerate.cashMovementGap).toBeUndefined();
    // The trade path, unchanged: gross 1 000,00 plus the 3,00 cost, out.
    expect(degenerate.cashMovement?.toString()).toBe(
      serverGross("10", "100").plus(parseDecimalString("3.00")).negated().toString(),
    );

    // …and a cross-currency row with **no** cost is not refused either: the
    // outcome is about a cost that cannot be added, not about the currencies.
    const noCost = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      cashCurrency: "USD",
      cashAmount: "1100.00",
    });
    expect(noCost.baseEquivalentGap).not.toBe("settlement-currency-differs");
  });

  it("never invents an FX rate the server has not resolved yet", () => {
    // No FX read exists anywhere in this product, so the rate the server will
    // pick is genuinely unknowable here.
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "USD",
    });
    expect(preview.baseEquivalent).toBeUndefined();
    expect(preview.baseEquivalentGap).toBe("rate-resolved-on-save");
    expect(preview.rate).toBeUndefined();
    expect(preview.rateIsUserInput).toBe(false);
  });

  it("declines to state a cash direction for kinds it does not model", () => {
    for (const kind of ["DEPOSIT", "WITHDRAWAL", "DIVIDEND", "DRIP", "CURRENCY_EXCHANGE"]) {
      const preview = computeTransactionPreview({
        kind,
        quantity: "10",
        unitPrice: "100",
        currency: "EUR",
      });
      expect(preview.cashMovement, `${kind} must not borrow a buy's arithmetic`).toBeUndefined();
      expect(preview.cashMovementGap).toBe("kind-has-no-cash-direction");
    }
  });
});

/**
 * FT-23 (finding **F5**): after
 * phase 1 the ledger records the principal cash posting in the settling
 * account's currency, so a preview that keeps reporting the trade currency's
 * magnitude breaks this module's own rule.
 *
 * AC-264's figures throughout, so the expectations here are the *ledger's*
 * hand-computed ones and not this module's own recomputation: BUY 10 AAPL at
 * 150,00 USD (gross 1 500,00 USD), `fx_rate = 0,92`, base EUR, settled from a
 * EUR account for 1 380,00 EUR.
 */
describe("F5 — the movement is stated in the settlement currency, never in the wrong unit", () => {
  const D4 = {
    kind: "BUY",
    quantity: "10",
    unitPrice: "150.00",
    currency: "USD",
    fxRateUserInput: "0.92",
    cashCurrency: "EUR",
    cashAmount: "1380.00",
  } as const;

  it("the defect, captured: the pre-FT-23 expression yields −1 500,00 USD where the ledger debits −1 380,00 EUR", () => {
    // The old code's own line, reproduced here rather than described: the
    // trade-currency movement, which this module still computes (the base
    // equivalent needs it) and which the *cash* row must no longer show.
    const preFix = serverGross("10", "150.00").plus(new Decimal(0)).negated();
    expect(preFix.toString()).toBe("-1500");

    // The ledger's D4 posting, hand-computed in AC-264: currency EUR,
    // amount_native −1 380,00. Both figures are captured in one test so the
    // disagreement is the assertion, not a comment about one.
    const ledgerNative = parseDecimalString("-1380.00");
    expect(preFix.equals(ledgerNative)).toBe(false);

    const preview = computeTransactionPreview(D4);
    expect(preview.cashMovement?.toString()).toBe(ledgerNative.toString());
    expect(preview.cashMovementCurrency).toBe("EUR");
    // …and the wrong-unit figure is genuinely gone from the cash row, not
    // merely relabelled.
    expect(preview.cashMovement?.equals(preFix)).toBe(false);
  });

  it("the base equivalent stays gross × fx_rate — the ledger's amount_base, unmoved by the settlement", () => {
    const preview = computeTransactionPreview(D4);
    // AC-264: amount_base = 1 500,00 × 0,92 = 1 380,00 EUR, and it is the
    // authoritative figure (FR-234) — computed from the trade movement, never
    // from the settled amount times the same rate.
    expect(preview.baseEquivalent?.toString()).toBe(
      serverToBase(serverGross("10", "150.00").negated(), "0.92").toString(),
    );
  });

  it("a D3/D5 shape with no settled amount yet reports the gap and no magnitude at all", () => {
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100.00",
      currency: "USD",
      fxRateUserInput: "0.90",
      cashCurrency: "CHF",
    });
    expect(preview.cashMovement).toBeUndefined();
    expect(preview.cashMovementGap).toBe("settlement-amount-missing");
    expect(preview.cashMovementCurrency).toBe("CHF");

    // The positive companion: supplying the amount produces the figure, in
    // CHF — so the gap above is a state this module leaves, not a dead end.
    const settled = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100.00",
      currency: "USD",
      fxRateUserInput: "0.90",
      cashCurrency: "CHF",
      cashAmount: "880.00",
    });
    // AC-265's own hand-computed CHF native figure.
    expect(settled.cashMovement?.toString()).toBe(parseDecimalString("-880.00").toString());
    expect(settled.cashMovementCurrency).toBe("CHF");
  });

  it("a SELL settles the other way, in the account's currency", () => {
    const preview = computeTransactionPreview({ ...D4, kind: "SELL" });
    expect(preview.cashMovement?.toString()).toBe(parseDecimalString("1380.00").toString());
    expect(preview.cashMovementCurrency).toBe("EUR");
  });

  /**
   * FR-260 (shape change, FT-47): the second half of this case used to feed a
   * fee in the *trade* currency and expect the settlement movement to refuse
   * it. Under L5 that input is unrepresentable — a cost is in the settling
   * account's currency, always — so the refusal moved to the trade-currency
   * movement, where the mismatch is now real, and is asserted there.
   *
   * What survives here is the positive half, strengthened: the cost **always**
   * joins the settlement movement, because it is always in that currency.
   */
  it("a cost joins the settlement movement, because it is denominated in that account", () => {
    const withCost = computeTransactionPreview({ ...D4, feeAmount: "2.00" });
    expect(withCost.cashMovement?.toString()).toBe(
      parseDecimalString("-1380.00").minus(parseDecimalString("2.00")).toString(),
    );
    expect(withCost.cashMovementGap).toBeUndefined();
    expect(withCost.cashMovementCurrency).toBe("EUR");

    // …and the trade-currency figure derived from the same row is withheld,
    // which is the other side of the same fact.
    expect(withCost.baseEquivalentGap).toBe("settlement-currency-differs");
  });

  it("the degenerate case is untouched: same currency, same figures, same unit as before the settlement fields existed", () => {
    const withoutFields = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
    });
    // Both spellings of "degenerate" — the fields absent, and the fields
    // present and equal — must produce the identical result (AC-278's shape,
    // one layer up).
    for (const degenerate of [
      { kind: "BUY", quantity: "10", unitPrice: "100", currency: "EUR", cashCurrency: "EUR" },
      {
        kind: "BUY",
        quantity: "10",
        unitPrice: "100",
        currency: "EUR",
        cashCurrency: "EUR",
        cashAmount: "1000",
      },
    ]) {
      const preview = computeTransactionPreview(degenerate);
      expect(preview.cashMovement?.toString()).toBe(withoutFields.cashMovement?.toString());
      expect(preview.cashMovementCurrency).toBe("EUR");
      expect(preview.cashMovementGap).toBeUndefined();
    }
  });

  it("a whitespace-padded settlement currency equal to the trade's is still degenerate, not a division-by-convention", () => {
    // `posting-expander.ts` trims for exactly this reason; a mis-compare here
    // would route a degenerate row down the settlement branch.
    const preview = computeTransactionPreview({
      kind: "BUY",
      quantity: "10",
      unitPrice: "100",
      currency: "EUR",
      cashCurrency: " EUR ",
    });
    expect(preview.cashMovement?.toString()).toBe(serverGross("10", "100").negated().toString());
    expect(preview.cashMovementGap).toBeUndefined();
  });
});
