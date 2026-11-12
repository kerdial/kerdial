import { describe, expect, it } from "vitest";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";
import { allocate, type AllocationRow } from "./allocation.js";

/**
 * `allocate` (MCP-L7, MCP-L18) against an independent exact-integer
 * computation: every value below has at most SCALE decimals, so the oracle
 * works in BigInt hundred-thousandths and shares neither code nor number type
 * with the function under test.
 */

const SCALE = 5;

/** "-12.345" -> -1234500n. */
function scaled(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const units = BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, "0"));
  return negative ? -units : units;
}

/** Hundredths of a percent in a share rendered as "33.33" or "100". */
function hundredths(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  expect(fraction.length, `${text} has more than two decimals`).toBeLessThanOrEqual(2);
  return negative ? -units : units;
}

function row(id: string, bucket: string, value: string): AllocationRow {
  return { id, bucket, value: parseDecimalString(value) };
}

/** A small deterministic generator: the same rows on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("allocate", () => {
  it("no rows: total 0, no shares, no buckets", () => {
    const result = allocate([]);
    expect(toDecimalString(result.total)).toBe("0");
    expect(result.sharesAvailable).toBe(false);
    expect(result.buckets).toEqual([]);
  });

  it("a single row is 100.00 % of itself, whatever its value", () => {
    const result = allocate([row("a", "EUR", "0.000000000000000001")]);
    expect(result.sharesAvailable).toBe(true);
    expect(result.buckets.map((b) => [b.key, toDecimalString(b.sharePercent!)])).toEqual([
      ["EUR", "100"],
    ]);
  });

  it("only overdrawn cash: a negative total has no shares and the value is still exact", () => {
    const result = allocate([row("cash:EUR", "CASH", "-50.1"), row("cash:USD", "CASH", "-0.2")]);
    expect(toDecimalString(result.total)).toBe("-50.3");
    expect(result.sharesAvailable).toBe(false);
    expect(result.buckets).toHaveLength(1);
    expect(toDecimalString(result.buckets[0]!.value)).toBe("-50.3");
    expect(result.buckets[0]!.sharePercent).toBeNull();
  });

  it("values a float cannot sum are summed exactly, per bucket and in total", () => {
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001 as a double.
    const result = allocate([row("a", "X", "0.1"), row("b", "X", "0.2"), row("c", "Y", "0.3")]);
    expect(toDecimalString(result.total)).toBe("0.6");
    expect(result.buckets.map((b) => [b.key, toDecimalString(b.value)])).toEqual([
      ["X", "0.3"],
      ["Y", "0.3"],
    ]);
  });

  it("three equal rows split 33.34 / 33.33 / 33.33 by id order, and the shares add up to exactly 100", () => {
    const result = allocate([row("a", "A", "1"), row("b", "B", "1"), row("c", "C", "1")]);
    expect(result.buckets.map((b) => [b.key, toDecimalString(b.sharePercent!)])).toEqual([
      ["A", "33.34"],
      ["B", "33.33"],
      ["C", "33.33"],
    ]);
  });

  it("trailing keys sort last, in the order given, whatever their value", () => {
    const result = allocate(
      [row("a", "CASH", "900"), row("b", "UNCLASSIFIED", "50"), row("c", "TECH", "1")],
      ["UNCLASSIFIED", "CASH"],
    );
    expect(result.buckets.map((b) => b.key)).toEqual(["TECH", "UNCLASSIFIED", "CASH"]);
  });

  it("any positive total: bucket values sum to the total exactly and the shares sum to exactly 100.00 (500 random sets, negatives included)", () => {
    const next = lcg(20261112);
    for (let round = 0; round < 500; round += 1) {
      const count = 1 + Math.floor(next() * 14);
      const rows: AllocationRow[] = [];
      const expectedByBucket = new Map<string, bigint>();
      let expectedTotal = 0n;
      for (let i = 0; i < count; i += 1) {
        // Up to 9 whole digits and SCALE decimals; about one row in six is negative.
        const magnitude =
          BigInt(Math.floor(next() * 1e9)) * 10n ** BigInt(SCALE) +
          BigInt(Math.floor(next() * 10 ** SCALE));
        const units = next() < 0.17 ? -magnitude : magnitude;
        const text = `${units < 0n ? "-" : ""}${(units < 0n ? -units : units) / 10n ** BigInt(SCALE)}.${(
          (units < 0n ? -units : units) %
          10n ** BigInt(SCALE)
        )
          .toString()
          .padStart(SCALE, "0")}`;
        const bucket = `B${Math.floor(next() * 4)}`;
        rows.push(row(`row-${String(i).padStart(2, "0")}`, bucket, text));
        expectedByBucket.set(bucket, (expectedByBucket.get(bucket) ?? 0n) + units);
        expectedTotal += units;
      }

      const result = allocate(rows);
      const label = `round ${round}`;
      expect(scaled(toDecimalString(result.total)), label).toBe(expectedTotal);
      expect(result.buckets.length, label).toBe(expectedByBucket.size);
      for (const bucket of result.buckets) {
        expect(scaled(toDecimalString(bucket.value)), `${label} ${bucket.key}`).toBe(
          expectedByBucket.get(bucket.key),
        );
      }
      if (expectedTotal > 0n) {
        expect(result.sharesAvailable, label).toBe(true);
        const sum = result.buckets.reduce(
          (acc, bucket) => acc + hundredths(toDecimalString(bucket.sharePercent!)),
          0n,
        );
        expect(sum, label).toBe(10000n);
      } else {
        expect(result.sharesAvailable, label).toBe(false);
        for (const bucket of result.buckets) expect(bucket.sharePercent, label).toBeNull();
      }
    }
  });
});
