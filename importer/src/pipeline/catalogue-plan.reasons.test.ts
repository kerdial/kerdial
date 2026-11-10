import { describe, expect, it } from "vitest";

import { PARSE_REJECT_REASONS } from "../types.js";
import {
  CATALOGUE_REJECT_REASONS,
  CATALOGUE_SKIP_REASONS,
  CATALOGUE_WARNING_CODES,
} from "./catalogue-plan.js";

/**
 * The catalogue's reason vocabulary, pinned by value — the table, asserted
 * rather than described.
 *
 * Both sets are declared as runtime arrays and not only as union types for the
 * reason `types.ts` states for `PARSE_REJECT_REASONS`: a code silently added or
 * dropped is then a **cardinality change** a test can see, not a type that still
 * compiles. This file is that test for the two catalogue sets, and it is the
 * server-side half of the drift pair — the French copy for each code lands with
 * the web copy table (Batch E), whose own drift test asserts the labels cover
 * these exact lists.
 *
 * The expectations below are written out in full rather than derived from the
 * constants they check. A test that maps over the table under test asserts that
 * the table equals itself.
 */
describe("importer — the catalogue reason vocabulary (EI-20)", () => {
  it("skips for exactly one reason", () => {
    expect([...CATALOGUE_SKIP_REASONS]).toEqual(["CATALOGUE_ENTRY_UNCHANGED"]);
  });

  it("rejects for exactly these reasons, the six parse codes included", () => {
    expect([...CATALOGUE_REJECT_REASONS]).toEqual([
      "MALFORMED_ROW",
      "MALFORMED_VALUE",
      "MISSING_REQUIRED_VALUE",
      "UNSUPPORTED_ROW_TYPE",
      "UNSUPPORTED_LEG",
      "AMOUNT_NOT_POSITIVE",
      "INSTRUMENT_AMBIGUOUS",
      "ICON_REJECTED",
      "ICON_CAP_EXCEEDED",
      "WATCHLIST_CAP_EXCEEDED",
      "MANUAL_PRICE_CAP_EXCEEDED",
      "CURRENCY_UNKNOWN",
      "PROVIDER_MAPPING_CONFLICT",
      "PORTFOLIO_CAP_EXCEEDED",
      "CASH_ACCOUNT_CAP_EXCEEDED",
      "CASH_ACCOUNT_CURRENCY_MISMATCH",
      "PRIVATE_INSTRUMENT_UNSUPPORTED",
      "APPLY_FAILED",
      "APPLY_NOT_ATTEMPTED",
    ]);
  });

  it("carries every code `parse`/`validate` can already produce", () => {
    // The relationship the plan stage relies on when it carries a parse problem
    // through unchanged: every code that arrives from the earlier stage is one
    // this vocabulary can express.
    for (const reason of PARSE_REJECT_REASONS) {
      expect(CATALOGUE_REJECT_REASONS).toContain(reason);
    }
  });

  it("warns for exactly one reason, which is neither a skip nor a reject", () => {
    expect([...CATALOGUE_WARNING_CODES]).toEqual(["ISIN_CHECK_DIGIT_MISMATCH"]);
    const notWritten = new Set<string>([...CATALOGUE_REJECT_REASONS, ...CATALOGUE_SKIP_REASONS]);
    expect(notWritten.has("ISIN_CHECK_DIGIT_MISMATCH")).toBe(false);
  });

  it("shares no code with the skip set", () => {
    const rejects = new Set<string>(CATALOGUE_REJECT_REASONS);
    for (const reason of CATALOGUE_SKIP_REASONS) {
      expect(rejects.has(reason)).toBe(false);
    }
  });
});
