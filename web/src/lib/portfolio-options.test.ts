import { describe, expect, it } from "vitest";
import { portfolioSelectOptions } from "./portfolio-options.js";

const ACTIVE = { id: "p-active", name: "Compte titres", archived: false };
const ARCHIVED = { id: "p-archived", name: "Ancien PEA", archived: true };
const OTHER = { id: "p-other", name: "Crypto", archived: false };

describe("portfolioSelectOptions (portfolio-archive FR-596)", () => {
  it("AC-486: omits an archived portfolio when the current value is another one or empty", () => {
    for (const current of [ACTIVE.id, ""]) {
      expect(portfolioSelectOptions([ACTIVE, ARCHIVED, OTHER], current)).toEqual([
        { value: ACTIVE.id, label: ACTIVE.name },
        { value: OTHER.id, label: OTHER.name },
      ]);
    }
  });

  it("AC-487: keeps an archived current value once, suffixed, in list order", () => {
    expect(portfolioSelectOptions([ACTIVE, ARCHIVED, OTHER], ARCHIVED.id)).toEqual([
      { value: ACTIVE.id, label: ACTIVE.name },
      { value: ARCHIVED.id, label: "Ancien PEA (archivé)" },
      { value: OTHER.id, label: OTHER.name },
    ]);
  });

  it("keys options by name when asked, and matches the current value by name", () => {
    expect(portfolioSelectOptions([ACTIVE, ARCHIVED], ARCHIVED.name, "name")).toEqual([
      { value: ACTIVE.name, label: ACTIVE.name },
      { value: ARCHIVED.name, label: "Ancien PEA (archivé)" },
    ]);
    expect(portfolioSelectOptions([ACTIVE, ARCHIVED], ARCHIVED.id, "name")).toEqual([
      { value: ACTIVE.name, label: ACTIVE.name },
    ]);
  });

  it("treats a fixture without the flag as not archived", () => {
    const loose = [{ id: "p-loose", name: "Sans drapeau" }] as unknown as Parameters<
      typeof portfolioSelectOptions
    >[0];
    expect(portfolioSelectOptions(loose, "")).toEqual([
      { value: "p-loose", label: "Sans drapeau" },
    ]);
  });
});
