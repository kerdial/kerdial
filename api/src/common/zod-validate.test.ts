import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HttpException } from "@nestjs/common";
import type { ProblemDetails } from "./problem.js";
import { parseOrThrow } from "./zod-validate.js";

/**
 * `parseOrThrow`'s **response bounds**.
 *
 * The vulnerability these assert against was quadratic: a `z.strictObject`
 * makes the failure count caller-controlled, and the old code re-attached
 * Zod's own key-enumerating message (length O(N)) to each of N entries before
 * joining them into `detail`. Measured on the shipped code at the branch
 * point: a 35 KB body of 3 000 junk keys produced a **234 MB** response body
 * and blocked the event loop for **833 ms**; ~94 KB produced an uncaught
 * `RangeError: Invalid string length` — both an order of magnitude under
 * `REQUEST_BODY_LIMIT_BYTES`.
 *
 * So the assertions below are about *size and time*, not only about shape. A
 * test that merely checked "a 400 is returned" passed against the vulnerable
 * code.
 */
function bodyOf(error: unknown): ProblemDetails {
  return (error as HttpException).getResponse() as ProblemDetails;
}

function captureProblem(schema: z.ZodType, input: unknown): ProblemDetails {
  try {
    parseOrThrow(schema, input);
  } catch (error) {
    return bodyOf(error);
  }
  throw new Error("expected parseOrThrow to reject this input");
}

/** N junk keys inside a nested `strictObject`, the `fee` shape the cycle shipped. */
function feeBodyWithJunkKeys(count: number): unknown {
  const fee: Record<string, unknown> = { amount: "1" };
  for (let i = 0; i < count; i++) fee[`k${String(i).padStart(6, "0")}`] = 1;
  return { fee };
}

const nestedStrict = z.object({ fee: z.strictObject({ amount: z.string() }) });
const topLevelStrict = z.strictObject({ sectorCode: z.string().optional() });

describe("parseOrThrow — the reported failures are bounded", () => {
  it("caps the errors array at 20 entries plus one that names the honest total", () => {
    const problem = captureProblem(nestedStrict, feeBodyWithJunkKeys(3_000));

    expect(problem.status).toBe(400);
    expect(problem.code).toBe("VALIDATION_ERROR");
    expect(problem.errors).toHaveLength(21);

    const last = problem.errors?.at(-1);
    expect(last?.field).toBe("(truncated)");
    // The count is the *total*, not the kept 20 — a truncated list that does
    // not say so reads as the whole set of problems with the request.
    expect(last?.message).toContain("3000 in total");
    expect(last?.message).toContain("2980 further");
  });

  it("caps detail well under the length that used to be measured in megabytes", () => {
    const problem = captureProblem(nestedStrict, feeBodyWithJunkKeys(3_000));

    // Pre-fix, this same input produced a 99.1 M-character `detail`.
    expect(problem.detail).toBeDefined();
    expect(problem.detail!.length).toBeLessThan(3_000);
  });

  it("each entry names only its own key, never the enumerating global message", () => {
    const problem = captureProblem(nestedStrict, feeBodyWithJunkKeys(50));

    const first = problem.errors?.[0];
    expect(first?.field).toBe("fee.k000000");
    expect(first?.message).toBe('Unrecognized key: "k000000"');
    // The amplifier itself: no entry may carry a message that lists the others.
    expect(first?.message).not.toContain("k000001");
    for (const entry of problem.errors ?? []) {
      expect(entry.message.length).toBeLessThan(200);
    }
  });

  it("the whole response stays kilobyte-sized for a body at the 1 MB request limit", () => {
    // 80 000 keys serialises to ~938 KB — the worst case the body limit admits
    // on a *top-level* strict object, where no nesting dilutes the key count.
    const body: Record<string, unknown> = { sectorCode: "X" };
    for (let i = 0; i < 80_000; i++) body[`k${String(i).padStart(6, "0")}`] = 1;

    const started = process.hrtime.bigint();
    const problem = captureProblem(topLevelStrict, body);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    const serialisedBytes = Buffer.byteLength(JSON.stringify(problem));
    expect(serialisedBytes).toBeLessThan(16_384);
    // The response must be *smaller* than the request that provoked it. That
    // single inequality is the property the vulnerability violated by 6503×.
    expect(serialisedBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(body)));
    // Generous ceiling: measured ~50 ms, and this is Zod's own parse of 80 000
    // keys, not the reporting. Pre-fix, a body 27× smaller blocked for 833 ms.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(problem.errors?.at(-1)?.message).toContain("80000 in total");
  });

  it("does not truncate — and adds no synthetic entry — when the count is under the cap", () => {
    const problem = captureProblem(nestedStrict, feeBodyWithJunkKeys(3));

    expect(problem.errors).toHaveLength(3);
    expect(problem.errors?.map((e) => e.field)).toEqual([
      "fee.k000000",
      "fee.k000001",
      "fee.k000002",
    ]);
    expect(JSON.stringify(problem)).not.toContain("(truncated)");
  });

  it("keeps the singular wording when exactly one entry is dropped", () => {
    const problem = captureProblem(nestedStrict, feeBodyWithJunkKeys(21));

    expect(problem.errors?.at(-1)?.message).toBe(
      "and 1 further validation error not listed (21 in total)",
    );
  });

  it("still reports an ordinary non-strict failure one entry per issue", () => {
    const problem = captureProblem(z.object({ amount: z.string(), currency: z.string() }), {
      amount: 1,
      currency: 2,
    });

    expect(problem.errors).toHaveLength(2);
    expect(problem.errors?.map((e) => e.field)).toEqual(["amount", "currency"]);
    expect(problem.detail).toContain("amount:");
    expect(problem.detail).toContain("currency:");
  });

  it("names a top-level unknown key with no leading dot", () => {
    const problem = captureProblem(topLevelStrict, { sectorCode: "X", nope: 1 });

    expect(problem.errors).toEqual([{ field: "nope", message: 'Unrecognized key: "nope"' }]);
  });
});
