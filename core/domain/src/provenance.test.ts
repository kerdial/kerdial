import { describe, expect, it } from "vitest";
import { mergeProvenance, summarizeProvenance, type DerivedFromFlag } from "./provenance.js";

describe("mergeProvenance (T-39)", () => {
  it("unions distinct flag sets with no duplicates", () => {
    const merged = mergeProvenance([["MANUAL_PRICE"], ["PINNED_FX"], ["MANUAL_PRICE"]]);
    expect(merged).toEqual(["MANUAL_PRICE", "PINNED_FX"]);
  });

  it("returns flags in canonical order regardless of input order", () => {
    const merged = mergeProvenance([["CARRIED_FX", "MANUAL_PRICE"]]);
    expect(merged).toEqual(["MANUAL_PRICE", "CARRIED_FX"]);
  });

  it("propagates through a second level of aggregation (a portfolio total merging several holdings)", () => {
    const holdingA: readonly DerivedFromFlag[] = ["AUTOMATED"];
    const holdingB: readonly DerivedFromFlag[] = ["MANUAL_PRICE"];
    const holdingC: readonly DerivedFromFlag[] = ["AUTOMATED"];
    const portfolioTotal = mergeProvenance([holdingA, holdingB, holdingC]);
    // The one manually priced holding's flag survives to the aggregate level
    // (FR-39's "derived, in whole or in part").
    expect(portfolioTotal).toContain("MANUAL_PRICE");

    // And a third level — a combined cross-portfolio total merging two
    // per-portfolio totals — still carries it.
    const otherPortfolioTotal: readonly DerivedFromFlag[] = ["AUTOMATED"];
    const combinedTotal = mergeProvenance([portfolioTotal, otherPortfolioTotal]);
    expect(combinedTotal).toContain("MANUAL_PRICE");
  });

  it("M3 (security review): AUTOMATED does not survive alongside a real flag at any aggregation level — a claim and its negation are never both asserted", () => {
    // Leaf level: one automated holding merged with one manually priced one.
    const holdingA: readonly DerivedFromFlag[] = ["AUTOMATED"];
    const holdingB: readonly DerivedFromFlag[] = ["MANUAL_PRICE"];
    const portfolioTotal = mergeProvenance([holdingA, holdingB]);
    expect(portfolioTotal).toEqual(["MANUAL_PRICE"]);
    expect(portfolioTotal).not.toContain("AUTOMATED");

    // Second level: a combined cross-portfolio total merging an all-automated
    // portfolio with the manual-contaminated one above must still not carry
    // AUTOMATED — red-confirm for AC29's negative clause: a client trusting
    // `derivedFrom.includes('AUTOMATED')` must never see it on a manual-
    // contaminated total.
    const otherPortfolioTotal: readonly DerivedFromFlag[] = ["AUTOMATED"];
    const combinedTotal = mergeProvenance([portfolioTotal, otherPortfolioTotal]);
    expect(combinedTotal).toEqual(["MANUAL_PRICE"]);
    expect(combinedTotal).not.toContain("AUTOMATED");
  });

  it("never fabricates AUTOMATED on the caller's behalf", () => {
    expect(mergeProvenance([])).toEqual([]);
    expect(mergeProvenance([[], []])).toEqual([]);
  });

  it("a figure derived solely from automated sources carries only AUTOMATED, never a manual/pinned/delayed flag (AC29's negative clause)", () => {
    const merged = mergeProvenance([["AUTOMATED"]]);
    expect(merged).toEqual(["AUTOMATED"]);
    expect(merged).not.toContain("MANUAL_PRICE");
    expect(merged).not.toContain("DELAYED_QUOTE");
    expect(merged).not.toContain("PINNED_FX");
  });
});

describe("summarizeProvenance — ADR-0010's aggregate summary (AR-23)", () => {
  const leaf = (
    flags: DerivedFromFlag[],
    rest: Partial<import("./provenance.js").ProvenanceSummaryLeaf> = {},
  ) => ({ derivedFrom: flags, ...rest });

  it("computes sources, range, counts and flags from mixed leaves — the '3 sources · 2 manual of 12' shape", () => {
    const summary = summarizeProvenance([
      leaf(["MANUAL_PRICE"], { priceSource: "manual", priceAsOf: "2026-08-14" }),
      leaf(["MANUAL_PRICE", "CARRIED_FX"], {
        priceSource: "manual",
        priceAsOf: "2026-08-20",
        fxSource: "PROVIDER",
        fxRateObservedOn: "2026-08-14",
      }),
      leaf(["AUTOMATED"], { priceSource: "yahoo", priceAsOf: "2026-08-28", priceIsStale: true }),
    ]);

    expect(summary.sources).toEqual(["PROVIDER", "manual", "yahoo"]);
    expect(summary.oldestObservationAt).toBe("2026-08-14");
    expect(summary.newestObservationAt).toBe("2026-08-28");
    expect(summary.staleInputCount).toBe(1);
    expect(summary.manualInputCount).toBe(2);
    expect(summary.pinnedFxPresent).toBe(false);
    expect(summary.carriedFxPresent).toBe(true);
    expect(summary.leafCount).toBe(3);
    // Phase 1: structurally true — the fail-loud read path guarantees it
    // (ADR-0010 as amended).
    expect(summary.complete).toBe(true);
    // The flag set IS mergeProvenance over the same leaves — including M3's
    // AUTOMATED-suppression rule, so summary and aggregate cannot disagree.
    expect(summary.derivedFrom).toEqual(["MANUAL_PRICE", "CARRIED_FX"]);
  });

  it("pinnedFxPresent follows PINNED_FX through the same merge", () => {
    const summary = summarizeProvenance([leaf(["PINNED_FX"], { fxSource: "USER_PINNED" })]);
    expect(summary.pinnedFxPresent).toBe(true);
    expect(summary.sources).toEqual(["USER_PINNED"]);
    expect(summary.derivedFrom).toEqual(["PINNED_FX"]);
  });

  it("an empty leaf set yields the empty summary, never a fabricated one", () => {
    const summary = summarizeProvenance([]);
    expect(summary).toEqual({
      sources: [],
      staleInputCount: 0,
      manualInputCount: 0,
      pinnedFxPresent: false,
      carriedFxPresent: false,
      leafCount: 0,
      complete: true,
      derivedFrom: [],
    });
  });

  it("complete is false iff an unvalued leaf exists — a cash currency left out for lack of a rate (portfolio-cash AC-575 (v), PC-L2)", () => {
    const converted = leaf(["AUTOMATED"], { fxSource: "PROVIDER", fxRateObservedOn: "2026-03-02" });
    const unvalued = leaf(["AUTOMATED"], { unvalued: true });
    expect(summarizeProvenance([converted]).complete).toBe(true);
    const partial = summarizeProvenance([converted, unvalued]);
    expect(partial.complete).toBe(false);
    expect(partial.leafCount).toBe(2);
    expect(summarizeProvenance([unvalued]).complete).toBe(false);
  });

  it("the complete override exists for the day partial valuation does — nothing in phase 1 passes it", () => {
    expect(summarizeProvenance([], { complete: false }).complete).toBe(false);
  });
});
