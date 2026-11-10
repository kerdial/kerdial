import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./trust-proxy.js";

describe("parseTrustProxy (security review M2 — safe-by-default trust boundary)", () => {
  it("defaults to false (trust nothing) when unset", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
  });

  it("defaults to false for an empty string", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
  });

  it('"false" (any casing) is explicitly false', () => {
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  it("a positive integer string is a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("a single IP/CIDR is returned as a one-element array", () => {
    expect(parseTrustProxy("10.0.0.5")).toEqual(["10.0.0.5"]);
  });

  it("a comma-separated list of IPs/CIDRs is returned as an array, trimmed", () => {
    expect(parseTrustProxy("10.0.0.5, 10.0.0.6,10.0.0.0/24")).toEqual([
      "10.0.0.5",
      "10.0.0.6",
      "10.0.0.0/24",
    ]);
  });

  it("never resolves to the literal boolean true — there is no input that produces blanket trust", () => {
    // "true" is neither a recognised hop count nor a valid CIDR/IP, so it
    // falls through to the CIDR-list branch as an (unmatchable) string —
    // never coerced to the dangerous blanket-trust boolean.
    expect(parseTrustProxy("true")).not.toBe(true);
    expect(parseTrustProxy("true")).toEqual(["true"]);
  });
});
