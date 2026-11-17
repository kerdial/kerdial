import { describe, expect, it } from "vitest";
import { filterCountries } from "./country-search.js";

/**
 * AC-635. Every assertion is "includes", never an exact list: a longer
 * legitimate set of matching names must not break these.
 */
function names(query: string): string[] {
  return filterCountries(query).map((country) => country.nameFr);
}

describe("filterCountries — AC-635", () => {
  it("folds accents and case: « etat » lists « États-Unis »", () => {
    expect(names("etat")).toContain("États-Unis");
  });

  it("matches anywhere in the name, not only its start: « unis » lists « États-Unis »", () => {
    expect(names("unis")).toContain("États-Unis");
  });

  it("is case-insensitive on upper-case input: « ALLEM » lists « Allemagne »", () => {
    expect(names("ALLEM")).toContain("Allemagne");
  });

  it("matches the start of the ISO code: « jp » lists « Japon »", () => {
    expect(names("jp")).toContain("Japon");
  });

  it("« zzz » matches nothing", () => {
    expect(names("zzz")).toEqual([]);
  });
});
