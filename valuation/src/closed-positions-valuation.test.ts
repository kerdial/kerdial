import { describe, expect, it } from "vitest";
import { aggregateLegProvenance } from "./closed-positions-valuation.js";

/**
 * `security-transfer` TR-16 (R-8) — a position closed only by a
 * transfer out has no sale lot, so the aggregate envelope over its four totals
 * is merged from zero legs. Pinned here, field by field, rather than left to
 * whatever an empty merge happens to produce.
 */
describe("valuation — aggregateLegProvenance over zero legs (R-8)", () => {
  it("answers exactly { derivedFrom: ['AUTOMATED'] } — no price, FX or summary field", () => {
    const provenance = aggregateLegProvenance([]);

    expect(Object.keys(provenance)).toEqual(["derivedFrom"]);
    expect(provenance.derivedFrom).toEqual(["AUTOMATED"]);
    expect(provenance.priceSource).toBeUndefined();
    expect(provenance.priceQuality).toBeUndefined();
    expect(provenance.priceAsOf).toBeUndefined();
    expect(provenance.priceIsStale).toBeUndefined();
    expect(provenance.fxSource).toBeUndefined();
    expect(provenance.fxRateObservedOn).toBeUndefined();
    expect(provenance.summary).toBeUndefined();
  });
});
