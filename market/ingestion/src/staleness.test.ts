import { describe, expect, it } from "vitest";
import {
  computeStaleness,
  CRYPTO_STALENESS_THRESHOLD_MS,
  EQUITY_STALENESS_THRESHOLD_MS,
  stalenessThresholdMsForKind,
} from "./staleness.js";

describe("stalenessThresholdMsForKind — NFR-1/NFR-2", () => {
  it("is 20 minutes for SHARE/ETF/INDEX (NFR-1)", () => {
    expect(EQUITY_STALENESS_THRESHOLD_MS).toBe(20 * 60 * 1000);
    expect(stalenessThresholdMsForKind("SHARE")).toBe(EQUITY_STALENESS_THRESHOLD_MS);
    expect(stalenessThresholdMsForKind("ETF")).toBe(EQUITY_STALENESS_THRESHOLD_MS);
    expect(stalenessThresholdMsForKind("INDEX")).toBe(EQUITY_STALENESS_THRESHOLD_MS);
  });

  it("is 10 minutes for CRYPTO (NFR-2)", () => {
    expect(CRYPTO_STALENESS_THRESHOLD_MS).toBe(10 * 60 * 1000);
    expect(stalenessThresholdMsForKind("CRYPTO")).toBe(CRYPTO_STALENESS_THRESHOLD_MS);
  });
});

describe("computeStaleness — AC4 (T-34)", () => {
  const asOf = new Date("2024-01-01T00:00:00.000Z");

  it("flags an equity quote stale once its age exceeds the NFR-1 20-minute threshold, and not before", () => {
    const justUnder = computeStaleness(
      "inst-1",
      "SHARE",
      asOf,
      new Date(asOf.getTime() + 20 * 60 * 1000), // exactly on the budget
    );
    expect(justUnder.stale).toBe(false);
    expect(justUnder.ageMs).toBe(EQUITY_STALENESS_THRESHOLD_MS);

    const justOver = computeStaleness(
      "inst-1",
      "SHARE",
      asOf,
      new Date(asOf.getTime() + 20 * 60 * 1000 + 1), // one ms past the budget
    );
    expect(justOver.stale).toBe(true);
  });

  it("flags a crypto quote stale once its age exceeds the NFR-2 10-minute threshold, and not before — a discriminating check against the equity threshold, not merely 'some threshold'", () => {
    // At 15 minutes old: past crypto's 10-minute budget, but still inside
    // equity's 20-minute budget — proves the two kinds use genuinely
    // different thresholds, not a single shared constant.
    const fifteenMinutesOld = new Date(asOf.getTime() + 15 * 60 * 1000);

    const cryptoResult = computeStaleness("inst-2", "CRYPTO", asOf, fifteenMinutesOld);
    expect(cryptoResult.stale).toBe(true);
    expect(cryptoResult.thresholdMs).toBe(CRYPTO_STALENESS_THRESHOLD_MS);

    const equityResult = computeStaleness("inst-3", "SHARE", asOf, fifteenMinutesOld);
    expect(equityResult.stale).toBe(false);
    expect(equityResult.thresholdMs).toBe(EQUITY_STALENESS_THRESHOLD_MS);
  });

  it("a fresh quote (well within budget) is never flagged stale for either kind", () => {
    const oneMinuteOld = new Date(asOf.getTime() + 60 * 1000);
    expect(computeStaleness("inst-4", "SHARE", asOf, oneMinuteOld).stale).toBe(false);
    expect(computeStaleness("inst-5", "CRYPTO", asOf, oneMinuteOld).stale).toBe(false);
  });
});
