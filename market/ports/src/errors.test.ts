import { describe, expect, it } from "vitest";
import {
  DataGap,
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  SymbolNotFound,
  type ProviderError,
} from "./errors.js";

/**
 * `describeError` is the exhaustiveness proof (T-13's
 * acceptance criterion): the `switch` below has **no `default` case** and
 * still compiles, because every one of the five members of {@link
 * ProviderError} is handled. The trailing `assertNever` line is what actually
 * proves it — if a sixth error class were added to the union without a new
 * `case` here, `error` at that point would retain that extra member's type
 * (not `never`), and the assignment on the next line would fail to
 * type-check. Removing a `case` (try it) reproduces the same failure. This
 * is deliberately *not* a `noImplicitReturns`-style check: the switch itself
 * has no `default`, exactly as the acceptance criterion requires.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled ProviderError kind: ${JSON.stringify(x)}`);
}

function describeError(error: ProviderError): string {
  switch (error.kind) {
    case "PROVIDER_RATE_LIMITED":
      return `rate-limited (retryAfterSeconds=${String(error.retryAfterSeconds)})`;
    case "PROVIDER_UNAVAILABLE":
      return "unavailable";
    case "SYMBOL_NOT_FOUND":
      return `symbol not found: ${error.symbol}`;
    case "DATA_GAP":
      return `gap ${error.from}..${error.to}`;
    case "PROVIDER_MALFORMED_RESPONSE":
      return "malformed response";
  }
  // Exhaustiveness proof: reachable only if the switch above did not already
  // return for every member of ProviderError, in which case `error` would
  // not be `never` and this line would fail to compile.
  return assertNever(error);
}

describe("ProviderError — closed taxonomy", () => {
  it("describeError's default-case-free switch covers every member (compile-time proof above; this just exercises each branch)", () => {
    expect(describeError(new ProviderRateLimited("fake", 30))).toContain("rate-limited");
    expect(describeError(new ProviderUnavailable("fake"))).toBe("unavailable");
    expect(describeError(new SymbolNotFound("fake", "XYZ"))).toContain("XYZ");
    expect(describeError(new DataGap("fake", "2024-01-01", "2024-01-31"))).toContain(
      "2024-01-01..2024-01-31",
    );
    expect(describeError(new ProviderMalformedResponse("fake"))).toBe("malformed response");
  });

  it("every error is a real Error instance carrying its discriminant kind and providerKey", () => {
    const errors: ProviderError[] = [
      new ProviderRateLimited("fake", 5),
      new ProviderUnavailable("fake"),
      new SymbolNotFound("fake", "XYZ"),
      new DataGap("fake", "2024-01-01", "2024-01-02"),
      new ProviderMalformedResponse("fake"),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error.providerKey).toBe("fake");
      expect(typeof error.kind).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("ProviderRateLimited carries an optional retryAfterSeconds (undefined when the provider gave none)", () => {
    const withHint = new ProviderRateLimited("fake", 42);
    expect(withHint.retryAfterSeconds).toBe(42);
    expect(withHint.message).toContain("42s");

    const withoutHint = new ProviderRateLimited("fake");
    expect(withoutHint.retryAfterSeconds).toBeUndefined();
  });

  it("DataGap carries the requested range distinctly from SymbolNotFound's single symbol", () => {
    const gap = new DataGap("fake", "2024-01-01", "2024-01-31");
    expect(gap.from).toBe("2024-01-01");
    expect(gap.to).toBe("2024-01-31");

    const notFound = new SymbolNotFound("fake", "EUR/RUB");
    expect(notFound.symbol).toBe("EUR/RUB");
  });
});
