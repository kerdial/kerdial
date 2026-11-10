import { describe, expect, it } from "vitest";
import { classifyFlows } from "./flow-class.js";
import type { ClassifiableTransaction, FlowClass, TransactionKind } from "./flow-class.js";

/**
 * T-21's first acceptance criterion: "for every transaction `kind`,
 * `classifyFlows` returns the exact `flow_class` the classification rules
 * specify — verified by a table-driven test with one case per `kind` (and,
 * for BUY/SELL, one case per whether it's the crypto-settled disposal leg or
 * not)."
 *
 * The table is the specification, restated: the four flow classes, one row per
 * `(kind, leg)` pair. The `ALL_KINDS` completeness check below is what stops
 * this table from silently going stale — adding a `kind` to the
 * `TransactionKind` union without adding its row here fails this suite
 * rather than leaving the new kind unclassified and unnoticed.
 *
 * `ALL_KINDS` is derived from a `Record<TransactionKind, true>`, so a kind
 * missing from it is a type error rather than a list someone must remember
 * to extend — the hand-written array it replaces had silently stayed at seven
 * kinds when `SHARE_DISTRIBUTION` became the eighth (the security-transfer
 * work found it).
 */

const KINDS: Record<TransactionKind, true> = {
  BUY: true,
  SELL: true,
  DEPOSIT: true,
  WITHDRAWAL: true,
  DIVIDEND: true,
  DRIP: true,
  CURRENCY_EXCHANGE: true,
  SHARE_DISTRIBUTION: true,
  TRANSFER_OUT: true,
  TRANSFER_IN: true,
  INTEREST: true,
  FEE: true,
};
const ALL_KINDS = Object.keys(KINDS) as readonly TransactionKind[];

interface Case {
  readonly name: string;
  readonly input: ClassifiableTransaction;
  readonly expected: FlowClass;
  readonly why: string;
}

const CASES: readonly Case[] = [
  {
    name: "BUY (principal legs)",
    input: { kind: "BUY" },
    expected: "INTERNAL",
    why: "cash becomes a position inside the portfolio; nothing enters or leaves it.",
  },
  {
    name: "BUY — the crypto-settled disposal leg (FR-66/AC52's 0.1 BTC)",
    input: { kind: "BUY", leg: "SETTLEMENT_ASSET" },
    expected: "INTERNAL",
    why: "The paid-with asset is disposed of *inside* the portfolio: a realized gain, never an external outflow.",
  },
  {
    name: "SELL (principal legs)",
    input: { kind: "SELL" },
    expected: "INTERNAL",
    why: "a position becomes cash inside the portfolio.",
  },
  {
    name: "SELL — the crypto-settled asset leg",
    input: { kind: "SELL", leg: "SETTLEMENT_ASSET" },
    expected: "INTERNAL",
    why: "Mirror image of the BUY case: the settlement asset is acquired, still inside the portfolio.",
  },
  {
    name: "DEPOSIT",
    input: { kind: "DEPOSIT" },
    expected: "EXTERNAL",
    why: "opens a TWR sub-period and is an XIRR external flow.",
  },
  {
    name: "WITHDRAWAL",
    input: { kind: "WITHDRAWAL" },
    expected: "EXTERNAL",
    why: "As DEPOSIT, in the other direction.",
  },
  {
    name: "DIVIDEND",
    input: { kind: "DIVIDEND" },
    expected: "INCOME",
    why: "increases cash but is not an external contribution — it must not split a TWR sub-period.",
  },
  {
    name: "DRIP",
    input: { kind: "DRIP" },
    expected: "INTERNAL",
    why: "Structurally a buy. The dividend it reinvests was already INCOME; classifying the DRIP as income too would count the same money twice.",
  },
  {
    name: "CURRENCY_EXCHANGE",
    input: { kind: "CURRENCY_EXCHANGE" },
    expected: "INTERNAL",
    why: "currency exchanges are named explicitly: cash moves between two of the portfolio's own currencies.",
  },
  {
    name: "SHARE_DISTRIBUTION",
    input: { kind: "SHARE_DISTRIBUTION" },
    expected: "INTERNAL",
    why: "free units arrive against no money — neither a contribution nor an increase in cash.",
  },
  {
    name: "TRANSFER_OUT (the source leg of a security transfer)",
    input: { kind: "TRANSFER_OUT" },
    expected: "EXTERNAL",
    why: "FR-560: value leaves this portfolio at its market value — withdrawal-shaped.",
  },
  {
    name: "TRANSFER_IN (the target leg of a security transfer)",
    input: { kind: "TRANSFER_IN" },
    expected: "EXTERNAL",
    why: "FR-560: value enters this portfolio at its market value — deposit-shaped.",
  },
  {
    name: "INTEREST (interest earned on cash)",
    input: { kind: "INTEREST", leg: "PRINCIPAL" },
    expected: "INCOME",
    why: "cash-interest FR-624: cash the portfolio earned, as a dividend is — never a contribution, so it must not split a TWR sub-period or count as invested capital.",
  },
  {
    name: "FEE (a standalone portfolio fee)",
    input: { kind: "FEE", leg: "PRINCIPAL" },
    expected: "FEE",
    why: "portfolio-cash FR-671/PC-L5: value the portfolio lost, never a withdrawal — so it must not split a TWR sub-period or reduce invested capital.",
  },
  {
    name: "the fee leg of a BUY (FR-60)",
    input: { kind: "BUY", leg: "FEE" },
    expected: "FEE",
    why: "genuine value leakage; the sum-to-zero invariant is stated up to exactly this leg.",
  },
  {
    name: "the fee leg of a CURRENCY_EXCHANGE",
    input: { kind: "CURRENCY_EXCHANGE", leg: "FEE" },
    expected: "FEE",
    why: "A fee is classified by what it is, not by the kind carrying it.",
  },
  {
    name: "the withholding-tax leg of a DIVIDEND (FR-9)",
    input: { kind: "DIVIDEND", leg: "WITHHOLDING_TAX" },
    expected: "TAX",
    why: "withholding is a separate TAX posting, so gross and net are both recoverable.",
  },
  {
    name: "the withholding-tax leg of an INTEREST (CI-L3)",
    input: { kind: "INTEREST", leg: "WITHHOLDING_TAX" },
    expected: "TAX",
    why: "The withholding group INTEREST shares with DIVIDEND: tax withheld at source is leakage, not income.",
  },
];

describe("classifyFlows (one function, no metric re-derives it)", () => {
  for (const testCase of CASES) {
    it(`classifies ${testCase.name} as ${testCase.expected} — ${testCase.why}`, () => {
      expect(classifyFlows(testCase.input)).toBe(testCase.expected);
    });
  }

  it("covers every transaction kind — a new kind cannot be added without a row in the table above", () => {
    const covered = new Set(
      CASES.filter((testCase) => (testCase.input.leg ?? "PRINCIPAL") === "PRINCIPAL").map(
        (testCase) => testCase.input.kind,
      ),
    );
    expect([...covered].sort()).toEqual([...ALL_KINDS].sort());
  });

  it("treats EXTERNAL as exactly the deposit/withdrawal pair and the two transfer legs, and nothing else", () => {
    // The property TWR (FR-25) and XIRR (FR-26) both depend on. Asserted
    // over every kind rather than only the two positive cases, so a change
    // making, say, DIVIDEND external would fail here even if its own row above
    // were updated to match.
    const external = ALL_KINDS.filter((kind) => classifyFlows({ kind }) === "EXTERNAL");
    expect(external).toEqual(["DEPOSIT", "WITHDRAWAL", "TRANSFER_OUT", "TRANSFER_IN"]);
    // ...and no leg of a trade is ever external either, however it was settled.
    for (const leg of ["PRINCIPAL", "SETTLEMENT_ASSET", "FEE", "WITHHOLDING_TAX"] as const) {
      expect(classifyFlows({ kind: "BUY", leg })).not.toBe("EXTERNAL");
      expect(classifyFlows({ kind: "SELL", leg })).not.toBe("EXTERNAL");
    }
  });

  it("depends on nothing but (kind, leg) — the same pair always classifies the same way", () => {
    // Guards against a future amount- or date-sensitive branch sneaking in:
    // the classification is a pure lookup, so a zero-value deposit is still
    // EXTERNAL and a huge fee is still FEE.
    expect(
      classifyFlows({ kind: "DEPOSIT", extraneous: "ignored" } as ClassifiableTransaction),
    ).toBe("EXTERNAL");
    expect(classifyFlows({ kind: "DEPOSIT" })).toBe(classifyFlows({ kind: "DEPOSIT" }));
  });

  it("rejects a kind outside the enum rather than defaulting it to a class", () => {
    // Fail-closed: an unknown kind is a bug, and silently returning INTERNAL
    // would hide it inside every downstream return figure.
    expect(() => classifyFlows({ kind: "SPLIT" as unknown as TransactionKind })).toThrow(
      /Unclassifiable transaction kind: SPLIT/,
    );
  });
});
