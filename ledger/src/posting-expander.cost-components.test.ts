import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import {
  expandPostings,
  principalImpliedRate,
  type ExpandableTransaction,
  type PostingDraft,
} from "./posting-expander.js";
import { testMinorUnitOf } from "./posting-expander.test-support.js";

const AAPL = "00000000-0000-7000-8000-00000047e001";
const CASH_ACCOUNT = "00000000-0000-7000-8000-00000047e002";
const FEE_ACCOUNT = "00000000-0000-7000-8000-00000047e003";

/**
 * **FT-31 (`fee-tax-breakdown` phase 2, Batch E2) — the four-component loop.**
 *
 * Traces FR-216, AC-239.
 *
 * The figures throughout are AC-232/AC-238's: a BUY of 10 at 100,00 USD
 * (gross 1 000,00), `fx_rate = 0,90`, settled from a EUR account for 900,00 —
 * case D4, so `implied = (1 000,00 × 0,90) / 900,00 = 1` exactly — with 16,00
 * EUR of costs split 9,90 broker / 2,50 FX / 3,60 tax.
 *
 * Two shapes exist after phase 2 and **both are permanent** (L8): an itemised
 * row emits one posting per present component, and an unitemised one emits the
 * single posting it always did, from the code that always did it. This suite
 * asserts each on its own and asserts they do not leak into each other.
 */

interface CostSplit {
  readonly brokerFee?: string;
  readonly fxFee?: string;
  readonly tax?: string;
  readonly other?: string;
}

/** The D4 BUY above, with whatever cost shape the case needs. */
function itemisedBuy(costs: CostSplit): ExpandableTransaction {
  const present = [costs.brokerFee, costs.fxFee, costs.tax, costs.other].filter(
    (amount): amount is string => amount !== undefined,
  );
  const total = present.reduce((sum, amount) => sum.plus(new Decimal(amount)), new Decimal(0));
  return {
    kind: "BUY",
    instrumentId: AAPL,
    quantity: new Decimal("10"),
    grossAmount: new Decimal("1000"),
    txnCurrency: "USD",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: CASH_ACCOUNT,
    targetCashAccountId: null,
    // After L5 there is no fee account: the cost is paid by the account that
    // settled the trade. Left non-null here on purpose, so a loop that read it
    // by mistake would produce a visibly wrong `cash_account_id`.
    cashCurrency: "EUR",
    cashAmount: new Decimal("900"),
    feeAmount: total.isZero() ? null : total,
    // The retired columns, deliberately populated with values that would show
    // up if the component loop read them: a different currency and a different
    // rate from the ones it must use.
    withholdingAmount: null,
    fxRate: new Decimal("0.90"),
    fxRateSource: "USER_PINNED",
    brokerFeeAmount: costs.brokerFee === undefined ? null : new Decimal(costs.brokerFee),
    fxFeeAmount: costs.fxFee === undefined ? null : new Decimal(costs.fxFee),
    taxAmount: costs.tax === undefined ? null : new Decimal(costs.tax),
    otherCostAmount: costs.other === undefined ? null : new Decimal(costs.other),
  };
}

/** The same trade with the same total, unitemised — the legacy shape, and the comparison FR-215/FR-216 turn on. */
function unitemisedBuy(
  total: string,
  overrides: Partial<ExpandableTransaction> = {},
): ExpandableTransaction {
  return {
    ...itemisedBuy({}),
    feeAmount: new Decimal(total),
    ...overrides,
  };
}

/** The CASH postings that are costs — everything after the principal cash leg. */
function costPostings(drafts: readonly PostingDraft[]): PostingDraft[] {
  return drafts.filter(
    (draft) => draft.leg === "CASH" && (draft.flowClass === "FEE" || draft.flowClass === "TAX"),
  );
}

describe("expandPostings — FR-216: one posting per present cost component (AC-239)", () => {
  it("AC-239: the three-component BUY emits three cost postings, and each one's flow class is asserted individually", () => {
    const drafts = expandPostings(
      itemisedBuy({ brokerFee: "9.90", fxFee: "2.50", tax: "3.60" }),
      testMinorUnitOf,
    );
    const costs = costPostings(drafts);

    // **Per posting, not per count.** A design that emitted three `FEE`
    // postings — losing the tax distinction this whole cycle exists for —
    // passes a count assertion and fails these three.
    expect(costs.map((posting) => [posting.amountNative.toString(), posting.flowClass])).toEqual([
      ["-9.9", "FEE"],
      ["-2.5", "FEE"],
      ["-3.6", "TAX"],
    ]);
  });

  it("the same trade with a single unitemised 17,00 EUR cost emits exactly one FEE posting of −17,00", () => {
    const costs = costPostings(expandPostings(unitemisedBuy("17.00"), testMinorUnitOf));
    expect(costs).toHaveLength(1);
    expect(costs[0]!.amountNative.toString()).toBe("-17");
    expect(costs[0]!.flowClass).toBe("FEE");
  });

  it("every cost posting carries the settling account's currency, the principal account, and the implied rate", () => {
    const drafts = expandPostings(
      itemisedBuy({ brokerFee: "9.90", fxFee: "2.50", tax: "3.60" }),
      testMinorUnitOf,
    );
    const principal = drafts.find(
      (draft) => draft.leg === "CASH" && draft.flowClass === "INTERNAL",
    );
    expect(principal!.amountNative.toString()).toBe("-900");

    for (const posting of costPostings(drafts)) {
      // The account's currency, never the trade's and never the retired
      // `fee_currency` — which this fixture sets to USD precisely so a wrong
      // read is visible.
      expect(posting.currency).toBe("EUR");
      // The principal account, never the retired fee account.
      expect(posting.cashAccountId).toBe(CASH_ACCOUNT);
      expect(posting.cashAccountId).not.toBe(FEE_ACCOUNT);
      // The principal leg's own implied rate — 1 here — never the retired
      // `fee_fx_rate` of 0,5 the fixture also carries.
      expect(posting.fxRateApplied.toString()).toBe(principal!.fxRateApplied.toString());
      expect(posting.fxRateApplied.toString()).toBe("1");
      // …and the transaction's own source, copied, exactly as the settlement
      // leg's is.
      expect(posting.fxRateSource).toBe("USER_PINNED");
      // `amount_base = −cᵢ × implied`, per component.
      expect(posting.amountBase.toString()).toBe(
        posting.amountNative.times(posting.fxRateApplied).toString(),
      );
    }
  });

  it("the emitted order is the enum's declaration order, over three different subsets", () => {
    // A loop over object keys is order-stable only by accident, and P11's
    // determinism claim is about the *sequence*, so subsets are what test it.
    const subsets: readonly [CostSplit, readonly string[]][] = [
      [{ tax: "3.60", brokerFee: "9.90" }, ["-9.9", "-3.6"]],
      [{ other: "0.50", fxFee: "2.50" }, ["-2.5", "-0.5"]],
      [
        { other: "0.50", tax: "3.60", fxFee: "2.50", brokerFee: "9.90" },
        ["-9.9", "-2.5", "-3.6", "-0.5"],
      ],
    ];
    for (const [costs, expected] of subsets) {
      const emitted = costPostings(expandPostings(itemisedBuy(costs), testMinorUnitOf)).map(
        (posting) => posting.amountNative.toString(),
      );
      expect(emitted).toEqual(expected);
    }
  });

  it("seq is contiguous and the cost legs come last — re-expansion differs in nothing (P11)", () => {
    const row = itemisedBuy({ brokerFee: "9.90", fxFee: "2.50", tax: "3.60" });
    const first = expandPostings(row, testMinorUnitOf);
    const second = expandPostings(row, testMinorUnitOf);
    expect(second).toEqual(first);

    expect(first.map((draft) => draft.seq)).toEqual([1, 2, 3, 4, 5]);
    // POSITION, principal CASH, then the three costs — the documented ordering
    // (`:140-149`), with the components after the withholding leg's slot.
    expect(first.map((draft) => draft.flowClass)).toEqual([
      "INTERNAL",
      "INTERNAL",
      "FEE",
      "FEE",
      "TAX",
    ]);
  });

  it("flow_class gains no value: only FEE and TAX are used, and TAX is genuinely produced", () => {
    const drafts = expandPostings(
      itemisedBuy({ brokerFee: "9.90", fxFee: "2.50", tax: "3.60" }),
      testMinorUnitOf,
    );
    const classes = new Set(costPostings(drafts).map((posting) => posting.flowClass));
    // No `ALTER TYPE`: both are values `flow_class` already had.
    expect([...classes].sort()).toEqual(["FEE", "TAX"]);
    // The positive companion — a suite asserting only "no new value" would pass
    // on a design that never emitted TAX at all.
    expect(classes.has("TAX")).toBe(true);
  });
});

describe("expandPostings — the unitemised path emits exactly what the itemised one does (FR-216, L8)", () => {
  /**
   * **FR-260 — the claim this case made has been spent, deliberately.**
   *
   * It read "an unitemised row's cost posting is unchanged in every field — it
   * still uses fee_currency, fee_fx_rate and the fee account", and it was what
   * made `0047`'s deferral safe: a row carrying those columns expanded exactly
   * as it had before phase 2. `0049` dropped them, so there is
   * one path and the old one is gone.
   *
   * That was safe to spend because the two paths only ever disagreed on a row
   * whose cost was denominated differently from its settling account, and no
   * such row existed: 226 costed rows, 0 divergent on all three axes, measured
   * before the drop.
   *
   * What replaces it is the property FR-216 actually asks for and which now
   * carries the weight: **the unitemised total emits exactly what the itemised
   * loop emits for one component**, so the two shapes cannot drift apart.
   */
  it("an unitemised total and a single component of the same size produce the identical posting", () => {
    const unitemised = costPostings(expandPostings(unitemisedBuy("17.00", {}), testMinorUnitOf));
    const itemised = costPostings(
      expandPostings(itemisedBuy({ brokerFee: "17.00" }), testMinorUnitOf),
    );

    expect(unitemised).toHaveLength(1);
    expect(itemised).toHaveLength(1);
    // Every field, not a spot check — `flowClass` is the one that legitimately
    // differs, and only for a component whose leg is TAX rather than FEE.
    expect(unitemised[0]).toEqual(itemised[0]);
    // …and it is the settling account's, at the principal's rate.
    expect(unitemised[0]!.currency).toBe("EUR");
    expect(unitemised[0]!.cashAccountId).toBe(CASH_ACCOUNT);
  });

  it("a row with no costs at all emits no cost posting from either path", () => {
    expect(costPostings(expandPostings(itemisedBuy({}), testMinorUnitOf))).toHaveLength(0);
  });

  it("components with no total are refused by name rather than expanded", () => {
    // `transaction_cost_components_sum_to_fee_amount` makes this unreachable
    // from the database, so the expander's own guard is the one that would
    // catch an in-memory caller — and it names the constraint, so the reader is
    // sent to the rule rather than to a stack trace.
    const row = { ...itemisedBuy({ brokerFee: "9.90" }), feeAmount: null };
    expect(() => expandPostings(row, testMinorUnitOf)).toThrow(/cost components but no feeAmount/);
  });

  it("components on a row with no cash leg are refused — after L5 a cost has no currency without one", () => {
    const row = {
      ...itemisedBuy({ brokerFee: "9.90" }),
      cashCurrency: null,
      cashAmount: null,
    };
    expect(() => expandPostings(row, testMinorUnitOf)).toThrow(/no cashCurrency/);
  });
});

/**
 * One rule, one copy. `position-replay.ts` needs the same
 * implied rate for its `TxnFee` projection, and the two hand-written copies it
 * started as disagreed on `txn_currency IS NULL`: the expander divided, the
 * projection returned `fx_rate`. Unreachable on a database-valid row — an
 * asset-settled row is the only one with a NULL `txn_currency`, and
 * `transaction_settled_principal_has_no_cash_leg` gives it no `cash_currency`
 * either — which is exactly the kind of latent disagreement that becomes a real
 * one the first time a shape changes.
 */
describe("principalImpliedRate — the one copy of the rule", () => {
  const base = itemisedBuy({});

  it("returns fx_rate verbatim in the degenerate case — never (G × R) / G", () => {
    // FR-241: the division is not guaranteed to return R at precision 34, so
    // the degenerate branch must not take it.
    expect(
      principalImpliedRate({
        ...base,
        cashCurrency: "USD",
        cashAmount: new Decimal("1000"),
      }).toString(),
    ).toBe("0.9");
  });

  it("divides in the cross-currency case", () => {
    // 1 000 × 0,90 / 900 = 1.
    expect(principalImpliedRate(base).toString()).toBe("1");
  });

  it("returns fx_rate for every shape that has no second figure to imply one from", () => {
    // A NULL cash leg (asset-settled), a NULL txn currency, and a zero settled
    // amount all resolve the same way — and identically for both callers, which
    // is the point of there being one function.
    for (const shape of [
      { cashCurrency: null, cashAmount: null },
      { txnCurrency: null },
      { cashAmount: new Decimal("0") },
    ]) {
      expect(principalImpliedRate({ ...base, ...shape }).toString()).toBe("0.9");
    }
  });
});

/**
 * **Batch F's unitemised total, which `0048` made storable and
 * nothing could expand.**
 *
 * FT-36's `CostInput` drops `currency` and `cashAccountId` (L5), so from Batch F
 * a row carries a `fee_amount` with no `fee_currency`. GATE-E found that the
 * expander threw on exactly that shape and `position-replay` dropped the cost
 * silently — the write path would have produced rows the derived ledger could
 * not read.
 */
describe("expandPostings — an unitemised total denominated by the settling account", () => {
  /** The Batch-F shape: a total, no components, and no fee currency or account. */
  function batchFUnitemised(overrides: Partial<ExpandableTransaction> = {}): ExpandableTransaction {
    return {
      ...itemisedBuy({}),
      feeAmount: new Decimal("17.00"),
      ...overrides,
    };
  }

  it("emits exactly one FEE posting, in the settling account's currency, at the principal leg's implied rate", () => {
    const costs = costPostings(expandPostings(batchFUnitemised(), testMinorUnitOf));

    expect(costs).toHaveLength(1);
    expect(costs[0]!.amountNative.toString()).toBe("-17");
    // D4: the account is EUR, implied = (1 500 × 0,92) / 1 380 … here
    // (1 000 × 0,90) / 900 = 1.
    expect(costs[0]!.currency).toBe("EUR");
    expect(costs[0]!.fxRateApplied.toString()).toBe("1");
    expect(costs[0]!.cashAccountId).toBe(CASH_ACCOUNT);
    expect(costs[0]!.amountBase.toString()).toBe("-17");
    expect(costs[0]!.flowClass).toBe("FEE");
  });

  it("agrees with the itemised path — the same total, split or not, produces the same cost posting", () => {
    // L5 is one rule, so the two shapes must not disagree about denomination.
    // FR-216's "exactly one posting" holds for the unitemised side; the
    // itemised side's postings sum to the same figure at the same rate.
    const unitemised = costPostings(expandPostings(batchFUnitemised(), testMinorUnitOf));
    const itemised = costPostings(
      expandPostings(
        itemisedBuy({ brokerFee: "10.90", fxFee: "2.50", tax: "3.60" }),
        testMinorUnitOf,
      ),
    );

    const total = (postings: readonly PostingDraft[]) =>
      postings.reduce((sum, posting) => sum.plus(posting.amountBase), new Decimal(0)).toString();
    expect(total(unitemised)).toBe(total(itemised));
    expect(new Set(itemised.map((posting) => posting.currency))).toEqual(
      new Set(unitemised.map((posting) => posting.currency)),
    );
  });

  it("a cross-currency settlement converts the total at the implied rate, not at the trade's", () => {
    // The rate is the account→base one, so a cost lands in the account's
    // currency at the account's rate — the whole point of L5.
    const costs = costPostings(
      expandPostings(
        batchFUnitemised({
          cashCurrency: "CHF",
          cashAmount: new Decimal("880"),
          grossAmount: new Decimal("1000"),
          fxRate: new Decimal("0.90"),
        }),
        testMinorUnitOf,
      ),
    );
    // implied = 1 000 × 0,90 / 880 = 1,0227272727…
    expect(costs[0]!.currency).toBe("CHF");
    expect(costs[0]!.fxRateApplied.toString()).toBe(
      new Decimal("1000").times("0.90").dividedBy("880").toString(),
    );
    expect(costs[0]!.amountBase.toString()).toBe(
      new Decimal("-17").times(costs[0]!.fxRateApplied).toString(),
    );
  });

  /**
   * FR-260: this asserted that a row carrying `fee_currency` took the *legacy*
   * branch, byte for byte. `0049` removed both the column and the branch.
   * What is left to state is that there is now exactly one
   * branch — asserted by the identity above — and that it is the settling
   * account's, which the case below covers for the shape that has none.
   */
  it("every unitemised total takes the settling account's currency and account", () => {
    const costs = costPostings(expandPostings(unitemisedBuy("17.00", {}), testMinorUnitOf));
    expect(costs[0]!.currency).toBe("EUR");
    expect(costs[0]!.cashAccountId).toBe(CASH_ACCOUNT);
  });

  it("a total with no cash leg at all is refused by name — after L5 there is no currency to denominate it in", () => {
    const assetSettled = batchFUnitemised({ cashCurrency: null, cashAmount: null });
    expect(() => expandPostings(assetSettled, testMinorUnitOf)).toThrow(/no cashCurrency/);
  });
});
