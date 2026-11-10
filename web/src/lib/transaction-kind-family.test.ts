// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIND_OPTIONS } from "../components/TransactionKindTabs.js";
import {
  KIND_FAMILIES,
  familyOf,
  firstKindOf,
  readRememberedKind,
  rememberKind,
} from "./transaction-kind-family.js";

/**
 * `transaction-dialog-refresh` TDR-T5: the family table and the
 * remembered last kind. The component half — what the picker renders and
 * selects — is `TransactionKindTabs.test.tsx`.
 */

const LAST_KIND_KEY = "kerdial:transaction-dialog:last-kind";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KIND_FAMILIES — FR-643's four families", () => {
  it("lists the four families in FR-643's order, with each family's kinds in FR-643's order", () => {
    expect(KIND_FAMILIES).toEqual([
      { family: "SECURITIES", kinds: ["BUY", "SELL", "SHARE_DISTRIBUTION"] },
      { family: "CASH", kinds: ["DEPOSIT", "WITHDRAWAL", "CURRENCY_EXCHANGE", "FEE"] },
      { family: "INCOME", kinds: ["DIVIDEND", "INTEREST", "DRIP"] },
      { family: "TRANSFERS", kinds: ["TRANSFER_OUT"] },
    ]);
  });

  it("every kind with a tab has exactly one pill, no other kind has one, and TRANSFER_IN has none", () => {
    const pills = KIND_FAMILIES.flatMap((entry) => entry.kinds);
    // Each exactly once: a kind in two families would be two pills.
    expect(new Set(pills).size).toBe(pills.length);
    expect([...pills].sort()).toEqual(KIND_OPTIONS.map((option) => option.value).sort());
    expect(KIND_OPTIONS).toHaveLength(11);
    expect(pills).not.toContain("TRANSFER_IN");
  });

  it("familyOf and firstKindOf agree with the table, and a family change selects its first kind", () => {
    for (const { family, kinds } of KIND_FAMILIES) {
      expect(firstKindOf(family)).toBe(kinds[0]);
      for (const kind of kinds) expect(familyOf(kind)).toBe(family);
    }
    expect(firstKindOf("INCOME")).toBe("DIVIDEND");
    expect(firstKindOf("CASH")).toBe("DEPOSIT");
  });
});

describe("readRememberedKind / rememberKind — FR-645's memory", () => {
  it("returns what rememberKind stored, under the one documented key", () => {
    rememberKind("SELL");
    expect(window.localStorage.getItem(LAST_KIND_KEY)).toBe("SELL");
    expect(readRememberedKind()).toBe("SELL");
  });

  it.each([
    ["nothing stored", null],
    ["an empty string", ""],
    ["TRANSFER_IN, a kind with no pill", "TRANSFER_IN"],
    ["a value from another build", "NOPE"],
    ["a lower-cased kind", "sell"],
  ])("falls back to BUY on %s", (_label, stored) => {
    if (stored !== null) window.localStorage.setItem(LAST_KIND_KEY, stored);
    expect(readRememberedKind()).toBe("BUY");
  });

  it("a throwing store (private mode) reads as BUY and swallows the write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(readRememberedKind()).toBe("BUY");
    expect(() => rememberKind("DIVIDEND")).not.toThrow();
  });
});
