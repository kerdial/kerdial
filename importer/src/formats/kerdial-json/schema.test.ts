import { INSTRUMENT_ICON_MAX_BASE64_CHARS } from "@kerdial/core-reference-data";
import { MAX_PORTFOLIOS_PER_TENANT } from "@kerdial/ledger";
import { describe, expect, it, vi } from "vitest";

import { KERDIAL_JSON_LIMITS } from "../../limits.js";
import {
  KERDIAL_CATALOGUE_GENERATOR,
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
  kerdialCatalogueDocumentSchema,
  kerdialCatalogueEnvelopeSchema,
  type KerdialCatalogueDocument,
  type KerdialCatalogueEnvelope,
  type KerdialCataloguePortfolioIcon,
} from "./schema.js";

/**
 * EI-11.
 *
 * The document below is **hand-built**, one literal, and every negative case is
 * a one-field mutation of it — so a test that goes red names the rule that
 * moved rather than "the schema changed".
 */
function validDocument(): KerdialCatalogueDocument {
  return {
    schemaVersion: KERDIAL_CATALOGUE_SCHEMA_VERSION,
    generator: KERDIAL_CATALOGUE_GENERATOR,
    exportedAt: "2026-09-24T18:03:11Z",
    baseCurrency: "EUR",
    iconsIncluded: true,
    instruments: [
      {
        identity: { kind: "SHARE", isin: "FR0000120073", exchangeMic: "XPAR", symbol: "AI" },
        private: false,
        listingCurrency: "EUR",
        displayName: "Air Liquide",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
        status: "ACTIVE",
        figi: "BBG000BLNNH6",
        sectorCode: "MATERIAUX",
        industryLabel: "Industrial Gases",
        domicileCountry: "FR",
        providerMapping: { providerKey: "yahoo", providerSymbol: "AI.PA" },
        icon: { contentType: "image/png", source: "MANUAL", base64: "iVBORw0KGgo=" },
        manualPrices: [
          { priceDate: "2026-03-31", close: "173.420000000000000000", currency: "EUR" },
        ],
        watchlist: { targetPrice: "200.000000000000000000", note: "surveillé" },
      },
    ],
    portfolios: [
      {
        name: "PEA",
        broker: "Bourse Direct",
        description: "Plan d'épargne en actions",
        accentColor: "CHART_1",
        icon: { contentType: "image/png", base64: "iVBORw0KGgo=" },
        cashAccounts: [{ name: "Espèces EUR", currency: "EUR", archived: false }],
      },
    ],
    fxRatesUser: [
      {
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2026-03-31",
        rate: "1.082400000000",
      },
    ],
  };
}

describe("kerdialCatalogueDocumentSchema", () => {
  it("parses the worked example, field for field", () => {
    const parsed = kerdialCatalogueDocumentSchema.parse(validDocument());

    expect(parsed).toStrictEqual(validDocument());
  });

  it("refuses an unknown key at every level (strict, at a fixed depth)", () => {
    const atRoot = { ...validDocument(), extra: 1 };
    const inInstrument = validDocument();
    const inIdentity = validDocument();
    Object.assign(inInstrument.instruments[0]!, { extra: 1 });
    Object.assign(inIdentity.instruments[0]!.identity, { extra: 1 });

    expect(kerdialCatalogueDocumentSchema.safeParse(atRoot).success).toBe(false);
    expect(kerdialCatalogueDocumentSchema.safeParse(inInstrument).success).toBe(false);
    expect(kerdialCatalogueDocumentSchema.safeParse(inIdentity).success).toBe(false);
  });

  it("refuses a document nested one level deeper than the schema allows, as a validation error", () => {
    const deeper = validDocument();
    // `identity` is the deepest legal object; a fifth level under it is one
    // level deeper than the schema allows.
    Object.assign(deeper.instruments[0]!.identity, { symbol: { value: "AI" } });

    const result = kerdialCatalogueDocumentSchema.safeParse(deeper);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.includes("identity"))).toBe(true);
  });

  it("survives a pathologically nested value without a stack overflow or a silent truncation", () => {
    let nested: Record<string, unknown> = {};
    const deepest = nested;
    for (let depth = 0; depth < 200_000; depth += 1) {
      const next: Record<string, unknown> = {};
      nested["a"] = next;
      nested = next;
    }
    const document = { ...validDocument(), instruments: [deepest] };

    const result = kerdialCatalogueDocumentSchema.safeParse(document);

    expect(result.success).toBe(false);
  });

  describe("schemaVersion — the one bare number in the document", () => {
    it("parses the bare number 1", () => {
      expect(kerdialCatalogueDocumentSchema.safeParse(validDocument()).success).toBe(true);
    });

    it('refuses the quoted "1"', () => {
      const quoted = { ...validDocument(), schemaVersion: "1" };

      expect(kerdialCatalogueDocumentSchema.safeParse(quoted).success).toBe(false);
    });

    // The other half of the asymmetry lives in the transactions format's own
    // test — a CSV with no version line parses under the current version
    // (`formats/kerdial-csv/lexer.test.ts`, "assumes the current version when
    // the file declares none (L4's floor)"). Cited rather than duplicated: this
    // module owns only the JSON half of the pair.
    it("refuses an absent schemaVersion — the asymmetry with the CSV's optional version comment", () => {
      const { schemaVersion: _omitted, ...withoutVersion } = validDocument();

      expect(kerdialCatalogueDocumentSchema.safeParse(withoutVersion).success).toBe(false);
    });

    it("refuses an unknown version number", () => {
      const future = { ...validDocument(), schemaVersion: 99 };

      expect(kerdialCatalogueDocumentSchema.safeParse(future).success).toBe(false);
    });

    it("is the exception exactly one field wide: a figure is the quoted form, never the bare one", () => {
      const quotedFigure = validDocument();
      const bareFigure = validDocument();
      // Written through `Object.assign` because the negative half of the rule
      // cannot be spelled in the type it violates.
      Object.assign(bareFigure.instruments[0]!, { watchlist: { targetPrice: 200 } });

      expect(kerdialCatalogueDocumentSchema.safeParse(quotedFigure).success).toBe(true);
      expect(kerdialCatalogueDocumentSchema.safeParse(bareFigure).success).toBe(false);
    });
  });

  describe("icon base64 (length-checked before any decode)", () => {
    it("refuses a payload longer than INSTRUMENT_ICON_MAX_BASE64_CHARS without decoding it", () => {
      const decode = vi.spyOn(Buffer, "from");
      const overLength = validDocument();
      overLength.instruments[0]!.icon = {
        contentType: "image/png",
        source: "MANUAL",
        base64: "A".repeat(INSTRUMENT_ICON_MAX_BASE64_CHARS + 1),
      };

      const result = kerdialCatalogueDocumentSchema.safeParse(overLength);

      expect(result.success).toBe(false);
      expect(decode).not.toHaveBeenCalled();
      decode.mockRestore();
    });

    it("accepts a payload at exactly the ceiling — the bound is the limits object's, not a second copy", () => {
      expect(KERDIAL_JSON_LIMITS.maxJsonStringChars).toBe(INSTRUMENT_ICON_MAX_BASE64_CHARS);
      const atCeiling = validDocument();
      atCeiling.instruments[0]!.icon = {
        contentType: "image/png",
        source: "MANUAL",
        base64: "A".repeat(KERDIAL_JSON_LIMITS.maxJsonStringChars),
      };

      expect(kerdialCatalogueDocumentSchema.safeParse(atCeiling).success).toBe(true);
    });
  });

  describe("optional fields are omitted, never null", () => {
    it("leaves every omitted key genuinely absent from the parsed result", () => {
      const minimal: KerdialCatalogueDocument = {
        schemaVersion: KERDIAL_CATALOGUE_SCHEMA_VERSION,
        generator: KERDIAL_CATALOGUE_GENERATOR,
        exportedAt: "2026-09-24T18:03:11Z",
        baseCurrency: "EUR",
        iconsIncluded: false,
        instruments: [
          {
            identity: { kind: "CRYPTO", symbol: "BTC" },
            private: false,
            listingCurrency: "EUR",
            displayName: "Bitcoin",
            primaryIdentifier: "SYMBOL",
            quotePolicy: "AUTO",
            status: "ACTIVE",
            manualPrices: [],
          },
        ],
        portfolios: [{ name: "PEA", cashAccounts: [] }],
        fxRatesUser: [],
      };

      const parsed = kerdialCatalogueDocumentSchema.parse(minimal);

      const instrument = parsed.instruments[0]!;
      for (const key of [
        "figi",
        "sectorCode",
        "industryLabel",
        "domicileCountry",
        "providerMapping",
        "icon",
        "watchlist",
      ]) {
        expect(Object.hasOwn(instrument, key)).toBe(false);
      }
      for (const key of ["isin", "exchangeMic"]) {
        expect(Object.hasOwn(instrument.identity, key)).toBe(false);
      }
      for (const key of ["broker", "description", "accentColor", "icon"]) {
        expect(Object.hasOwn(parsed.portfolios[0]!, key)).toBe(false);
      }
    });

    it("refuses an explicit null where a field is optional", () => {
      const withNull = { ...validDocument() };
      Object.assign(withNull.instruments[0]!, { figi: null });

      expect(kerdialCatalogueDocumentSchema.safeParse(withNull).success).toBe(false);
    });
  });

  it("gives a portfolio icon no `source` — the column does not exist (portfolio-icon.ts:95-107)", () => {
    const portfolioIcon: KerdialCataloguePortfolioIcon = {
      contentType: "image/png",
      base64: "iVBORw0KGgo=",
      // @ts-expect-error — `portfolio_icon` has no `source` column, so the type has no such field.
      source: "MANUAL",
    };

    expect(
      kerdialCatalogueDocumentSchema.safeParse({
        ...validDocument(),
        portfolios: [{ name: "PEA", cashAccounts: [], icon: portfolioIcon }],
      }).success,
    ).toBe(false);
  });

  it("refuses an instant that is not UTC, and a date that is not a real calendar date", () => {
    const offsetInstant = { ...validDocument(), exportedAt: "2026-09-24T20:03:11+02:00" };
    const impossibleDate = validDocument();
    impossibleDate.fxRatesUser[0]!.rateDate = "2026-02-31";

    expect(kerdialCatalogueDocumentSchema.safeParse(offsetInstant).success).toBe(false);
    expect(kerdialCatalogueDocumentSchema.safeParse(impossibleDate).success).toBe(false);
  });

  it("bounds a decimal string's length, not only its shape", () => {
    const wide = validDocument();
    wide.fxRatesUser[0]!.rate = `${"1".repeat(63)}.5`;

    expect(kerdialCatalogueDocumentSchema.safeParse(wide).success).toBe(false);
  });

  // The schema accepts what the store accepts — any 12
  // characters. A bad check digit is the plan's warning, not a parse refusal.
  it("accepts a 12-character ISIN whose check digit does not match, and refuses 11 characters", () => {
    const badCheckDigit = validDocument();
    badCheckDigit.instruments[0]!.identity.isin = "USGATE000001";
    const tooShort = validDocument();
    tooShort.instruments[0]!.identity.isin = "USGATE00000";

    expect(kerdialCatalogueDocumentSchema.safeParse(badCheckDigit).success).toBe(true);
    expect(kerdialCatalogueDocumentSchema.safeParse(tooShort).success).toBe(false);
  });

  it("trims and upper-cases an ISIN before its length is checked", () => {
    const padded = validDocument();
    padded.instruments[0]!.identity.isin = " fr0000120073 ";

    const parsed = kerdialCatalogueDocumentSchema.parse(padded);

    expect(parsed.instruments[0]!.identity.isin).toBe("FR0000120073");
  });
});

describe("kerdialCatalogueEnvelopeSchema", () => {
  it("checks the manifest and the array bounds while leaving entries unvalidated", () => {
    const oneBadEntry = { ...validDocument(), instruments: [{ nonsense: true }] };

    const envelope: KerdialCatalogueEnvelope = kerdialCatalogueEnvelopeSchema.parse(oneBadEntry);

    expect(envelope.instruments).toHaveLength(1);
    expect(envelope.baseCurrency).toBe("EUR");
    expect(kerdialCatalogueDocumentSchema.safeParse(oneBadEntry).success).toBe(false);
  });

  it("refuses an array past its bound before any entry is read", () => {
    const tooManyPortfolios = {
      ...validDocument(),
      portfolios: Array.from({ length: MAX_PORTFOLIOS_PER_TENANT + 1 }, () => ({
        name: "PEA",
        cashAccounts: [],
      })),
    };

    expect(kerdialCatalogueEnvelopeSchema.safeParse(tooManyPortfolios).success).toBe(false);
  });
});
