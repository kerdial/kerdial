import { describe, expect, it } from "vitest";
import { LOG_DETAIL_MAX_CHARS, loggableErrorDetail } from "./loggable-error.js";

describe("loggableErrorDetail", () => {
  it("withholds a message carrying a dumped query and its bound parameters, keeping the class name", () => {
    class DrizzleQueryError extends Error {}
    const detail = loggableErrorDetail(
      new DrizzleQueryError(
        'Failed query: insert into "transaction" ("gross_amount") values ($1)\nparams: 154321.99',
      ),
    );
    expect(detail).toBe(
      "DrizzleQueryError: [the failed query and its bound parameters are withheld]",
    );
    expect(detail).not.toContain("154321.99");
  });

  it("matches on either literal alone — the two halves arrive together, but neither is load-bearing on its own", () => {
    expect(loggableErrorDetail(new Error("Failed query: select 1"))).toContain("withheld");
    expect(loggableErrorDetail(new Error("params: 42"))).toContain("withheld");
  });

  it("leaves an ordinary message alone — this is a subtraction of one class, not of error logging", () => {
    const detail = loggableErrorDetail(
      new TypeError("withholding.amount must be a positive, finite amount, got: 0"),
    );
    expect(detail).toBe("TypeError: withholding.amount must be a positive, finite amount, got: 0");
  });

  it("a message that merely contains a number is NOT withheld — the allow-list already accepts that trade", () => {
    // The rule is about one class that dumps a statement's parameters, not
    // about digits. Withholding on "contains a number" would strip the detail
    // out of nearly every useful error this codebase writes.
    expect(loggableErrorDetail(new Error("expected 3 columns, got 4"))).toBe(
      "Error: expected 3 columns, got 4",
    );
  });

  it("truncates an unrecognised message at the bound, so one pathological error cannot flood the line", () => {
    const detail = loggableErrorDetail(new Error("x".repeat(LOG_DETAIL_MAX_CHARS * 3)));
    expect(detail.length).toBeLessThanOrEqual(LOG_DETAIL_MAX_CHARS + "Error: ".length);
  });

  it("describes a non-Error throw by type rather than stringifying it", () => {
    // `String({query, params})` would be "[object Object]" here, but a thrown
    // string or a thrown object with a toString could carry anything.
    expect(loggableErrorDetail({ params: [42] })).toBe(
      "a non-Error value of type object was thrown",
    );
    expect(loggableErrorDetail("params: 154321.99")).toBe(
      "a non-Error value of type string was thrown",
    );
  });

  it("falls back to `name` when the constructor is anonymous", () => {
    const anonymous = new (class extends Error {})("boom");
    anonymous.name = "AnonymousFailure";
    expect(loggableErrorDetail(anonymous)).toContain("boom");
  });
});
