import { describe, expect, it } from "vitest";
import { ISO_3166_COUNTRIES, countryLabel, isIsoCountryCode } from "./country.js";
import { CURATED_EXCHANGE_MICS } from "./exchange-mic.js";

/**
 * Drift tests for the embedded ISO 3166-1 list (FR-740, AC-641). The table is
 * data produced once at authoring time; these are what catch a wrong, missing
 * or extra row.
 */
describe("ISO_3166_COUNTRIES — the embedded country list (FR-740, AC-641)", () => {
  it("has no duplicate code, every code two uppercase letters, every name trimmed and non-empty", () => {
    const codes = ISO_3166_COUNTRIES.map((country) => country.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const { code, nameFr } of ISO_3166_COUNTRIES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(nameFr.length, code).toBeGreaterThan(0);
      expect(nameFr.trim(), code).toBe(nameFr);
    }
  });

  it("holds exactly the officially assigned codes: their count, and none of XK, EU, UN", () => {
    // 249 officially assigned ISO 3166-1 alpha-2 codes: the ISO 3166
    // Maintenance Agency's set as carried by the `iso-codes` 4.9.0 data files,
    // cross-checked against CLDR 48's region list, 2026-11-16.
    expect(ISO_3166_COUNTRIES).toHaveLength(249);
    for (const notAssigned of ["XK", "EU", "UN"]) {
      expect(isIsoCountryCode(notAssigned), notAssigned).toBe(false);
    }
  });

  it("keeps the 30 labels it carried before the list was embedded, byte for byte (EW-L8)", () => {
    const before: Readonly<Record<string, string>> = {
      FR: "France",
      US: "États-Unis",
      GB: "Royaume-Uni",
      DE: "Allemagne",
      NL: "Pays-Bas",
      BE: "Belgique",
      PT: "Portugal",
      IT: "Italie",
      ES: "Espagne",
      CH: "Suisse",
      AT: "Autriche",
      IE: "Irlande",
      NO: "Norvège",
      SE: "Suède",
      DK: "Danemark",
      FI: "Finlande",
      PL: "Pologne",
      CZ: "Tchéquie",
      HU: "Hongrie",
      GR: "Grèce",
      TR: "Turquie",
      CA: "Canada",
      MX: "Mexique",
      BR: "Brésil",
      JP: "Japon",
      HK: "Hong Kong",
      CN: "Chine",
      KR: "Corée du Sud",
      AU: "Australie",
      LU: "Luxembourg",
    };

    const now = Object.fromEntries(Object.keys(before).map((code) => [code, countryLabel(code)]));

    expect(now).toStrictEqual(before);
  });

  it("carries every curated exchange's country, so no curated exchange renders as a bare code", () => {
    const codes = [...new Set(CURATED_EXCHANGE_MICS.map((exchange) => exchange.countryCode))];
    for (const code of codes) {
      expect(isIsoCountryCode(code), `${code} must be in the list`).toBe(true);
    }
  });

  it("is stored in French collation order of the name, so no reader sorts it at runtime", () => {
    const names = ISO_3166_COUNTRIES.map((country) => country.nameFr);
    const collated = [...names].sort(new Intl.Collator("fr").compare);

    expect(names).toStrictEqual(collated);
  });

  it("answers exactly: an unknown, inherited or lower-case code is not a country", () => {
    expect(countryLabel("ZZ")).toBeUndefined();
    expect(countryLabel("toString")).toBeUndefined();
    expect(isIsoCountryCode("fr")).toBe(false);
    expect(isIsoCountryCode("toString")).toBe(false);
    expect(isIsoCountryCode("FR")).toBe(true);
  });
});
