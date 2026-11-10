import { describe, expect, it } from "vitest";
import { fakeFxProvider, fxProviderCapabilities } from "@kerdial/market-test-support";
import { resolveFxDailyPairs } from "./fx-daily-handler.js";
import { isFxPairSupported } from "./fx-supported-pairs.js";

/**
 * The pair set the daily FX pull covers, and the API-boundary
 * check that decides what may enter it.
 *
 * Pure functions, so this suite needs no database and no provider: the
 * capability record is the input. `fx-daily-handler.integration.test.ts` (and
 * `queue-wiring.integration.test.ts`) cover the wiring around them.
 */

const capabilities = fxProviderCapabilities({
  publishedPairs: [
    { base: "EUR", quote: "USD" },
    { base: "EUR", quote: "SEK" },
    { base: "EUR", quote: "RUB" },
  ],
});

describe("resolveFxDailyPairs — held ∪ tracked, intersected with what the provider publishes", () => {
  it("returns the held-derived pairs when nothing is tracked (the previous behaviour, unchanged)", () => {
    expect(
      resolveFxDailyPairs({ capabilities, heldCurrencies: ["USD"], trackedPairs: [] }),
    ).toEqual([{ base: "EUR", quote: "USD" }]);
  });

  it("adds a tracked pair nothing is held in — the whole point of the table", () => {
    const pairs = resolveFxDailyPairs({
      capabilities,
      heldCurrencies: [],
      trackedPairs: [{ base: "EUR", quote: "SEK" }],
    });
    expect(pairs).toEqual([{ base: "EUR", quote: "SEK" }]);
  });

  it("lists a pair that is BOTH held and tracked exactly once", () => {
    const pairs = resolveFxDailyPairs({
      capabilities,
      heldCurrencies: ["USD"],
      trackedPairs: [{ base: "EUR", quote: "USD" }],
    });
    // A duplicate here would double every observation in one provider batch
    // and make `fxDailyRatesAlreadyIngested`'s "every pair covered" reading
    // meaningless.
    expect(pairs).toEqual([{ base: "EUR", quote: "USD" }]);
  });

  it("drops a tracked pair the provider no longer publishes instead of failing the run", () => {
    const pairs = resolveFxDailyPairs({
      capabilities,
      heldCurrencies: ["USD"],
      // Neither leg is published by this fake provider, which is the shape a
      // pair tracked before a provider swap (or ECB's EUR/RUB suspension) ends
      // up in.
      trackedPairs: [{ base: "EUR", quote: "ZAR" }],
    });
    expect(pairs).toEqual([{ base: "EUR", quote: "USD" }]);
  });

  it("ignores a held currency the provider does not publish, and the base currency itself", () => {
    expect(
      resolveFxDailyPairs({
        capabilities,
        heldCurrencies: ["EUR", "ZAR"],
        trackedPairs: [],
      }),
    ).toEqual([]);
  });

  it("returns nothing when nothing is held and nothing is tracked — no fetch, no provider call", () => {
    expect(resolveFxDailyPairs({ capabilities, heldCurrencies: [], trackedPairs: [] })).toEqual([]);
  });

  it("never asks for every published pair — the EUR/RUB shape that would fail the whole job", () => {
    const pairs = resolveFxDailyPairs({
      capabilities,
      heldCurrencies: ["USD", "SEK"],
      trackedPairs: [],
    });
    expect(pairs.map((pair) => pair.quote)).not.toContain("RUB");
  });
});

describe("isFxPairSupported — the API-boundary check", () => {
  const provider = fakeFxProvider({
    capabilities: { publishedPairs: capabilities.publishedPairs },
  });

  it("accepts a published pair", () => {
    expect(isFxPairSupported({ base: "EUR", quote: "SEK" }, provider)).toBe(true);
  });

  it("rejects a pair the provider does not publish", () => {
    expect(isFxPairSupported({ base: "EUR", quote: "ZAR" }, provider)).toBe(false);
  });

  it("rejects a pair whose legs are published only in the other direction", () => {
    // Membership, not "both legs are known currencies": the ECB adapter can
    // *derive* USD/EUR from the EUR/USD leg, but a derived pair is not a
    // published one, and what this function gates is what the daily job will
    // be asked to fetch.
    expect(isFxPairSupported({ base: "USD", quote: "EUR" }, provider)).toBe(false);
  });

  it("agrees with resolveFxDailyPairs, so an accepted pair is never silently dropped later", () => {
    const pair = { base: "EUR", quote: "SEK" };
    expect(isFxPairSupported(pair, provider)).toBe(true);
    expect(resolveFxDailyPairs({ capabilities, heldCurrencies: [], trackedPairs: [pair] })).toEqual(
      [pair],
    );
  });
});
