import { describe, expect, it } from "vitest";
import { COUNTRY_LABELS_FR, countryLabel } from "./country.js";
import { CURATED_EXCHANGE_MICS, micToCountryCode } from "./exchange-mic.js";
import {
  PROVIDER_SECTOR_TO_CODE,
  SECTOR_CODES,
  SECTOR_LABELS,
  sectorCodeForProviderLabel,
  sectorLabel,
  type SectorCode,
} from "./sector.js";

describe("SECTOR_CODES / SECTOR_LABELS — the vocabulary's own shape (IR-5; FR-1, OD-1(d))", () => {
  it("has exactly nine codes — the cardinality is OD-1(d)'s licensing argument, not a preference", () => {
    expect(SECTOR_CODES).toHaveLength(9);
  });

  it("every code is ASCII, accent-free, uppercase snake, and unique", () => {
    for (const code of SECTOR_CODES) {
      expect(code, `${code} must be uppercase snake ASCII`).toMatch(/^[A-Z]+(?:_[A-Z]+)*$/);
      // Belt and braces over the charset rule above: an accented character
      // would already fail `[A-Z]`, but this states the intent the design
      // records (codes are accent-free, labels carry the accents).
      expect(code.normalize("NFD")).toBe(code);
    }
    expect(new Set(SECTOR_CODES).size).toBe(SECTOR_CODES.length);
  });

  it("every code has a non-empty French label, and SECTOR_LABELS carries no key that is not a code", () => {
    for (const code of SECTOR_CODES) {
      expect(SECTOR_LABELS[code], `${code} must carry a label`).toBeTruthy();
      expect(SECTOR_LABELS[code].trim()).toBe(SECTOR_LABELS[code]);
    }
    expect(Object.keys(SECTOR_LABELS).sort()).toEqual([...SECTOR_CODES].sort());
  });

  it("at least one label carries an accent — the labels are French copy, not the codes echoed back (NFR-4)", () => {
    const accented = Object.values(SECTOR_LABELS).filter((label) => /[À-ÿ]/.test(label));
    expect(accented.length).toBeGreaterThan(0);
  });

  it("does not contain a sentinel for 'unclassified' — absence is NULL in the database, never a code (FR-3)", () => {
    for (const code of SECTOR_CODES) {
      expect(code.startsWith("__")).toBe(false);
    }
    expect(SECTOR_CODES as readonly string[]).not.toContain("__NON_CLASSE__");
  });
});

describe("PROVIDER_SECTOR_TO_CODE — eleven provider strings onto nine codes (DD20, FR-2)", () => {
  it("maps exactly eleven provider strings, every value a real code", () => {
    const entries = Object.entries(PROVIDER_SECTOR_TO_CODE);
    expect(entries).toHaveLength(11);
    for (const [providerLabel, code] of entries) {
      expect(SECTOR_CODES as readonly string[], `${providerLabel} -> ${code}`).toContain(code);
    }
  });

  it("folds eleven onto nine — two codes are each reached by two provider strings (OD-1(d)'s two mergers)", () => {
    const counts = new Map<SectorCode, number>();
    for (const code of Object.values(PROVIDER_SECTOR_TO_CODE)) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    expect([...counts.values()].filter((n) => n === 2)).toHaveLength(2);
    expect(new Set(Object.values(PROVIDER_SECTOR_TO_CODE)).size).toBe(9);
  });
});

// The provider strings themselves are read out of the table rather than
// spelled out here: `classification-vocabulary-containment.test.ts` asserts
// that they appear in `sector.ts` and nowhere else, and a test file that
// hard-coded them would be the first violation of the rule it exists beside.
const PROVIDER_STRINGS = Object.keys(PROVIDER_SECTOR_TO_CODE);
const MULTI_WORD_PROVIDER_STRING = PROVIDER_STRINGS.find((raw) => raw.includes(" "))!;

describe("sectorCodeForProviderLabel() — total, normalising, and prototype-safe", () => {
  it.each(PROVIDER_STRINGS.map((raw, index) => [index, raw] as const))(
    "maps provider string #%i in its emitted form to the table's own code",
    (_index, raw) => {
      expect(sectorCodeForProviderLabel(raw)).toBe(PROVIDER_SECTOR_TO_CODE[raw]);
    },
  );

  it("normalises both sides: case, surrounding and collapsed inner whitespace all hit the same entry", () => {
    const raw = MULTI_WORD_PROVIDER_STRING;
    const expected = PROVIDER_SECTOR_TO_CODE[raw];
    expect(expected).toBeDefined();
    expect(sectorCodeForProviderLabel(raw.replace(" ", "  "))).toBe(expected);
    expect(sectorCodeForProviderLabel(raw.toLowerCase())).toBe(expected);
    expect(sectorCodeForProviderLabel(`  ${raw.toUpperCase().replace(" ", "\t")}  `)).toBe(
      expected,
    );
  });

  it("returns undefined (never throws) for a string with no mapping — an unknown bucket is NULL, not an error (FR-3)", () => {
    expect(() => sectorCodeForProviderLabel("Quantum Widgets")).not.toThrow();
    expect(sectorCodeForProviderLabel("Quantum Widgets")).toBeUndefined();
  });

  // F-6 (security review): the argument is the provider's value, verbatim —
  // a plain object literal indexed with an inherited-property name resolves
  // to that inherited value (`Object.prototype` itself for `"__proto__"`)
  // rather than `undefined`, which is exactly the shape this function's
  // signature promises never to produce. That defect shipped once already,
  // in `findMicByCode`, and crashed the create form.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "returns undefined (never an inherited Object.prototype member) for the prototype-polluting string %j",
    (raw) => {
      const result = sectorCodeForProviderLabel(raw);
      expect(result).toBeUndefined();
      expect(typeof result === "string" || result === undefined).toBe(true);
    },
  );

  it("the same defence holds for sectorLabel() and countryLabel(), whose arguments come off the wire too", () => {
    for (const raw of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(sectorLabel(raw)).toBeUndefined();
      expect(countryLabel(raw)).toBeUndefined();
    }
  });
});

describe("COUNTRY_LABELS_FR / countryLabel() / micToCountryCode()", () => {
  it("every distinct curated-exchange country code has a French label — no curated exchange renders as a bare code", () => {
    const codes = [...new Set(CURATED_EXCHANGE_MICS.map((exchange) => exchange.countryCode))];
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      expect(countryLabel(code), `${code} must carry a French label`).toBeTruthy();
    }
  });

  it("covers the sample catalogue's fund domicile that is not itself a curated listing country", () => {
    expect(countryLabel("LU")).toBe("Luxembourg");
  });

  it("every key is a two-letter uppercase code with a non-empty, trimmed label", () => {
    for (const [code, label] of Object.entries(COUNTRY_LABELS_FR)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("micToCountryCode() resolves a curated MIC to its country code", () => {
    expect(micToCountryCode("XPAR")).toBe("FR");
    expect(micToCountryCode("XNAS")).toBe("US");
  });
});

describe("totality — sectorLabel, countryLabel, micToCountryCode, sectorCodeForProviderLabel", () => {
  const hostileInputs = [
    "",
    " ",
    "\t\n",
    "0",
    "null",
    "undefined",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "[object Object]",
    "TECHNOLOGIE ",
    " technologie",
    "XPAR ",
    "fr",
    "F",
    "FRA",
    "%s",
    "\\u0000",
    "'; DROP TABLE instrument; --",
    "<script>alert(1)</script>",
    "Санте",
    "🇫🇷",
    "x".repeat(500),
  ];

  it.each(hostileInputs)(
    "every lookup returns a string or undefined, and never throws, for %j",
    (input) => {
      for (const lookup of [sectorLabel, countryLabel, micToCountryCode]) {
        expect(() => lookup(input)).not.toThrow();
        const result = lookup(input);
        expect(
          result === undefined || typeof result === "string",
          `${lookup.name}(${JSON.stringify(input)}) returned ${String(result)}`,
        ).toBe(true);
      }

      expect(() => sectorCodeForProviderLabel(input)).not.toThrow();
      const code = sectorCodeForProviderLabel(input);
      expect(code === undefined || (SECTOR_CODES as readonly string[]).includes(code)).toBe(true);
    },
  );

  it("the same lookups resolve their real keys — a sector label, a country, a MIC, a provider string", () => {
    expect(sectorLabel("TECHNOLOGIE")).toBeTruthy();
    expect(countryLabel("FR")).toBeTruthy();
    expect(micToCountryCode("XPAR")).toBeTruthy();
    expect(sectorCodeForProviderLabel(MULTI_WORD_PROVIDER_STRING)).toBeTruthy();
  });
});
