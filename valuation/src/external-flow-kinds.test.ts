import { classifyFlows } from "@kerdial/core-domain";
import { POSITION_AFFECTING_KINDS } from "@kerdial/ledger";
import { transactionKindEnum } from "@kerdial/platform-db";
import { describe, expect, it } from "vitest";
import { EXTERNAL_FLOW_KINDS } from "./performance.js";

/**
 * Risk R-1 of `cash-interest` (GATE-CI). The live TWR, XIRR and
 * invested-capital loaders select their flows with the hand list
 * {@link EXTERNAL_FLOW_KINDS}, not with `transaction_posting.flow_class`. The
 * known-answer suite proves {@link classifyFlows}; this proves the list agrees
 * with it. Without it, a kind added to the list but classified `INCOME` (an
 * `INTEREST`, say) would leave every classifier test green while silently
 * opening a TWR sub-period and counting as invested capital on every screen.
 *
 * Iterates the **database** enum, so a kind added by a migration is covered
 * with no edit here. Pure: no connection is opened.
 */
describe("EXTERNAL_FLOW_KINDS ≡ { kind : classifyFlows(kind) = EXTERNAL } (cash-interest R-1)", () => {
  it("the shared selection is exactly the kinds classifyFlows calls EXTERNAL — no more, no fewer", () => {
    const external = transactionKindEnum.enumValues.filter(
      (kind) => classifyFlows({ kind }) === "EXTERNAL",
    );
    expect([...EXTERNAL_FLOW_KINDS].sort()).toEqual([...external].sort());
  });

  it("INTEREST is a kind, and it is on neither side (interest earned is never a contribution)", () => {
    // Non-vacuity: the iterated list is the real, post-0075 enum.
    expect(transactionKindEnum.enumValues).toContain("INTEREST");
    expect(classifyFlows({ kind: "INTEREST" })).not.toBe("EXTERNAL");
    expect(EXTERNAL_FLOW_KINDS).not.toContain("INTEREST");
  });

  // portfolio-cash (AC-565, AC-587 negative pins): a fee is value leakage,
  // never a contribution, and its instrument reference moves no position.
  it("FEE is a kind, on neither side, and moves no position", () => {
    expect(transactionKindEnum.enumValues).toContain("FEE");
    expect(classifyFlows({ kind: "FEE" })).toBe("FEE");
    expect([...EXTERNAL_FLOW_KINDS].sort()).toEqual([
      "DEPOSIT",
      "TRANSFER_IN",
      "TRANSFER_OUT",
      "WITHDRAWAL",
    ]);
    expect(POSITION_AFFECTING_KINDS).not.toContain("FEE");
  });
});
