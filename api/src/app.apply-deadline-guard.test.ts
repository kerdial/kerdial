import { DEFAULT_IMPORT_LIMITS } from "@kerdial/importer";
import type { Db } from "@kerdial/platform-db";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DEFAULT_KERDIAL_LIMIT_SETS } from "./imports/import-limits.tokens.js";
import { APPLY_DEADLINE_HEADROOM_MS } from "./request-budget.js";

/**
 * (security confirm, F2). `request-budget.ts`'s
 * `assertDeadlinesUnderCeiling` iterates the sets of the budget it has just
 * built, so it proves that *file* consistent and nothing about the call site —
 * and the bug it was written for (M1) was a call site:
 * `api-runtime.ts` passed `importLimits` and dropped `kerdialLimits`, leaving
 * the two Kerdial routes on the module constants' 25 000 ms under whatever
 * timeout the operator had chosen. `buildApp` now asserts the three deadlines it
 * is actually about to hand to the routes.
 *
 * No database or Testcontainers needed, for
 * `app.register-test-routes-guard.test.ts`'s reason: the guard runs before
 * `buildApp` touches `options.db` or constructs the Nest app, so a fake `db` is
 * safe — the assertions below depend on the guard firing, not on what would
 * happen if it did not.
 *
 * Red-confirm: removing the `assertApplyDeadlinesUnderHandlerTimeout` call from
 * `buildApp` makes the first two tests fail — the promise no longer rejects with
 * the guard's message, which is exactly the M1 shape booting again.
 *
 * The other half — that a deadline *under* the ceiling is not refused, including
 * the 1 ms `gate4-resumability-http.integration.test.ts` and
 * `kerdial-limits.integration.test.ts` inject — is proved by those suites
 * themselves: they build a real app through `startTestApp` and would stop
 * booting at all. Asserting it here would mean letting `buildApp` run on past
 * the guard with a fake `db`, which fails inside Nest for an unrelated reason.
 */
describe("buildApp — the apply deadlines are checked where they are consumed (F2)", () => {
  const csrfSecret = "apply-deadline-guard-test-only-secret-apply-deadline-guard-test";
  const HANDLER_TIMEOUT_MS = 12_000;
  /** 12 000 − 5 000: what a limit set's deadline may be under that timeout. */
  const ceilingMs = HANDLER_TIMEOUT_MS - APPLY_DEADLINE_HEADROOM_MS;

  it("refuses to boot when kerdialLimits is omitted under a lowered handler timeout", async () => {
    // The M1 shape exactly: the Portfolio-Performance set is resolved and
    // correct, and `kerdialLimits:` is simply not passed — so both Kerdial
    // routes would run on `DEFAULT_KERDIAL_LIMIT_SETS`' compile-time deadline,
    // past this app's own socket.
    expect(DEFAULT_KERDIAL_LIMIT_SETS.csv.applyDeadlineMs).toBeGreaterThan(ceilingMs);

    await expect(
      buildApp({
        db: {} as Db,
        csrfSecret,
        handlerTimeoutMs: HANDLER_TIMEOUT_MS,
        importLimits: { ...DEFAULT_IMPORT_LIMITS, applyDeadlineMs: ceilingMs },
      }),
    ).rejects.toThrow(
      /Kerdial transactions import set's apply deadline is 25000 ms, over the 7000/,
    );
  });

  it("names the catalogue set when that is the one left behind", async () => {
    await expect(
      buildApp({
        db: {} as Db,
        csrfSecret,
        handlerTimeoutMs: HANDLER_TIMEOUT_MS,
        importLimits: { ...DEFAULT_IMPORT_LIMITS, applyDeadlineMs: ceilingMs },
        kerdialLimits: {
          csv: { ...DEFAULT_KERDIAL_LIMIT_SETS.csv, applyDeadlineMs: ceilingMs },
          json: DEFAULT_KERDIAL_LIMIT_SETS.json,
        },
      }),
    ).rejects.toThrow(/Kerdial catalogue import set's apply deadline/);
  });

  it("leaves the shipped pairing alone — the default sets under the default timeout", () => {
    // Not a second guard test: the number this asserts is the one that makes
    // every existing suite build. `HANDLER_TIMEOUT_MS` is 30 000 and the three
    // shipped deadlines are 25 000, which is the ceiling *exactly* — so the
    // guard sits one millisecond away from refusing the default deployment, and
    // this is where that would be noticed.
    const shippedCeilingMs = 30_000 - APPLY_DEADLINE_HEADROOM_MS;
    expect(DEFAULT_IMPORT_LIMITS.applyDeadlineMs).toBeLessThanOrEqual(shippedCeilingMs);
    expect(DEFAULT_KERDIAL_LIMIT_SETS.csv.applyDeadlineMs).toBeLessThanOrEqual(shippedCeilingMs);
    expect(DEFAULT_KERDIAL_LIMIT_SETS.json.applyDeadlineMs).toBeLessThanOrEqual(shippedCeilingMs);
  });
});
