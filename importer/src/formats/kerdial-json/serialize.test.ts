import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { KERDIAL_JSON_LIMITS } from "../../limits.js";
import { KERDIAL_CATALOGUE_FILE_TYPE, kerdialCatalogueImporter } from "./index.js";
import {
  KERDIAL_CATALOGUE_GENERATOR,
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
  kerdialCatalogueDocumentSchema,
  type KerdialCatalogueDocument,
} from "./schema.js";
import { catalogueIconBase64, serializeKerdialCatalogue } from "./serialize.js";

/** EI-13. */

/** Icon bytes that are not a round number of base64 groups, so a padding bug cannot hide. */
const ICON_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x2a, 0x7f,
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fullDocument(): KerdialCatalogueDocument {
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
        icon: {
          contentType: "image/png",
          source: "MANUAL",
          base64: catalogueIconBase64(ICON_BYTES),
        },
        manualPrices: [
          { priceDate: "2026-03-31", close: "173.420000000000000000", currency: "EUR" },
        ],
        watchlist: { targetPrice: "200.000000000000000000", note: "surveillé" },
      },
      {
        identity: { kind: "CRYPTO", symbol: "BTC" },
        private: true,
        listingCurrency: "EUR",
        displayName: "Bitcoin",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "MANUAL_ONLY",
        status: "ACTIVE",
        manualPrices: [],
      },
    ],
    portfolios: [
      {
        name: "PEA",
        broker: "Bourse Direct",
        description: "Plan d'épargne en actions",
        accentColor: "CHART_1",
        icon: { contentType: "image/png", base64: catalogueIconBase64(ICON_BYTES) },
        archived: true,
        cashAccounts: [
          { name: "Espèces EUR", currency: "EUR", archived: false },
          { name: "Espèces USD", currency: "USD", archived: true },
        ],
      },
      { name: "CTO", cashAccounts: [] },
    ],
    fxRatesUser: [
      { baseCurrency: "EUR", quoteCurrency: "USD", rateDate: "2026-03-31", rate: "1.082400000000" },
    ],
  };
}

/** KD4.2's `icons=omitted` variant: the same document with every `icon` object absent and the manifest saying so. */
function iconsOmittedDocument(): KerdialCatalogueDocument {
  const document = fullDocument();
  const [share, crypto] = document.instruments;
  const [pea, cto] = document.portfolios;
  const { icon: _instrumentIcon, ...shareWithoutIcon } = share!;
  const { icon: _portfolioIcon, ...peaWithoutIcon } = pea!;
  return {
    ...document,
    iconsIncluded: false,
    instruments: [shareWithoutIcon, crypto!],
    portfolios: [peaWithoutIcon, cto!],
  };
}

function reparse(text: string): KerdialCatalogueDocument {
  return kerdialCatalogueDocumentSchema.parse(JSON.parse(text));
}

describe("serializeKerdialCatalogue", () => {
  it("round-trips a full document through the schema, field for field", () => {
    const document = fullDocument();

    expect(reparse(serializeKerdialCatalogue(document))).toStrictEqual(document);
  });

  it("round-trips through the importer's own parse, icons compared by hash", () => {
    const document = fullDocument();

    const result = kerdialCatalogueImporter.validate(
      kerdialCatalogueImporter.parse({
        bytes: new TextEncoder().encode(serializeKerdialCatalogue(document)),
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      }),
    );

    expect(result.problems).toStrictEqual([]);
    const icon = result.draft.instruments[0]!.icon!;
    expect(sha256(Buffer.from(icon.base64, "base64"))).toBe(sha256(ICON_BYTES));
    expect(Buffer.from(icon.base64, "base64").byteLength).toBe(ICON_BYTES.byteLength);
    expect(result.draft.instruments[0]!.manualPrices[0]!.close.toFixed()).toBe("173.42");
    expect(result.draft.portfolios[0]!.cashAccounts[1]!.archived).toBe(true);
    expect(result.draft.portfolios[0]!.archived).toBe(true);
    expect(Object.hasOwn(result.draft.portfolios[1]!, "archived")).toBe(false);
  });

  it("encodes icon bytes with no re-encode: the decoded bytes are byte-identical", () => {
    const decoded = Buffer.from(catalogueIconBase64(ICON_BYTES), "base64");

    expect(sha256(decoded)).toBe(sha256(ICON_BYTES));
    expect(Uint8Array.from(decoded)).toStrictEqual(ICON_BYTES);
  });

  it("writes every figure as a quoted string, and schemaVersion as the one bare number", () => {
    const raw = JSON.parse(serializeKerdialCatalogue(fullDocument())) as Record<string, unknown>;

    const instrument = (raw["instruments"] as Record<string, unknown>[])[0]!;
    const price = (instrument["manualPrices"] as Record<string, unknown>[])[0]!;
    const watchlist = instrument["watchlist"] as Record<string, unknown>;
    const fxRate = (raw["fxRatesUser"] as Record<string, unknown>[])[0]!;

    expect(typeof raw["schemaVersion"]).toBe("number");
    expect(typeof price["close"]).toBe("string");
    expect(typeof watchlist["targetPrice"]).toBe("string");
    expect(typeof fxRate["rate"]).toBe("string");
  });

  it("omits an absent optional field entirely, rather than writing a null", () => {
    const text = serializeKerdialCatalogue(iconsOmittedDocument());
    const raw = JSON.parse(text) as Record<string, unknown>;

    const instruments = raw["instruments"] as Record<string, unknown>[];
    const crypto = instruments[1]!;
    expect(Object.hasOwn(instruments[0]!, "icon")).toBe(false);
    expect(Object.hasOwn(crypto, "figi")).toBe(false);
    expect(Object.hasOwn(crypto, "watchlist")).toBe(false);
    expect(Object.hasOwn(crypto["identity"] as object, "isin")).toBe(false);
    expect(Object.hasOwn((raw["portfolios"] as Record<string, unknown>[])[1]!, "broker")).toBe(
      false,
    );
    expect(text).not.toContain("null");
  });

  it("produces an `icons=omitted` document that is still schema-valid and still round-trips", () => {
    const document = iconsOmittedDocument();
    const text = serializeKerdialCatalogue(document);

    expect(reparse(text)).toStrictEqual(document);
    expect(text).not.toContain("base64");
    expect(reparse(text).iconsIncluded).toBe(false);
  });

  it("writes the key order, whatever order the input object was built in", () => {
    const document = fullDocument();
    const shuffled: KerdialCatalogueDocument = {
      fxRatesUser: document.fxRatesUser,
      portfolios: document.portfolios,
      instruments: document.instruments,
      iconsIncluded: document.iconsIncluded,
      baseCurrency: document.baseCurrency,
      exportedAt: document.exportedAt,
      generator: document.generator,
      schemaVersion: document.schemaVersion,
    };

    const text = serializeKerdialCatalogue(document);

    expect(Object.keys(JSON.parse(text) as object)).toStrictEqual([
      "schemaVersion",
      "generator",
      "exportedAt",
      "baseCurrency",
      "iconsIncluded",
      "instruments",
      "portfolios",
      "fxRatesUser",
    ]);
    expect(serializeKerdialCatalogue(shuffled)).toBe(text);
  });

  it("is deterministic and ends in one newline", () => {
    const text = serializeKerdialCatalogue(fullDocument());

    expect(serializeKerdialCatalogue(fullDocument())).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("round-trips an empty tenant's document — FR-512's valid empty file", () => {
    const empty: KerdialCatalogueDocument = {
      schemaVersion: KERDIAL_CATALOGUE_SCHEMA_VERSION,
      generator: KERDIAL_CATALOGUE_GENERATOR,
      exportedAt: "2026-09-24T18:03:11Z",
      baseCurrency: "EUR",
      iconsIncluded: true,
      instruments: [],
      portfolios: [],
      fxRatesUser: [],
    };

    expect(reparse(serializeKerdialCatalogue(empty))).toStrictEqual(empty);
  });
});
