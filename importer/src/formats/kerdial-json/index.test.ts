import { describe, expect, it, vi } from "vitest";

import { KERDIAL_JSON_LIMITS, type KerdialJsonLimits } from "../../limits.js";
import {
  CatalogueFileError,
  KERDIAL_CATALOGUE_FILE_TYPE,
  kerdialCatalogueImporter,
  type CatalogueEntryProblem,
  type CatalogueEntryRef,
  type CatalogueFileType,
  type CatalogueParseInput,
  type CatalogueParseResult,
  type CatalogueSection,
} from "./index.js";
import {
  KERDIAL_CATALOGUE_GENERATOR,
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
  type KerdialCatalogueDocument,
} from "./schema.js";

/**
 * EI-12.
 *
 * This file is the *format* half and therefore does contain JSON text. The
 * containment proof for this half — needed because the catalogue's
 * camelCase vocabulary cannot be literal-scanned by a gate — is
 * `catalogue-draft.neutral.test.ts`, which drives the same `validate` with no
 * JSON text anywhere in it.
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
        icon: { contentType: "image/png", source: "MANUAL", base64: "iVBORw0KGgo=" },
        manualPrices: [
          { priceDate: "2026-03-31", close: "173.420000000000000000", currency: "EUR" },
        ],
        watchlist: { targetPrice: "200.000000000000000000" },
      },
      {
        identity: { kind: "CRYPTO", symbol: "BTC" },
        private: true,
        listingCurrency: "EUR",
        displayName: "Bitcoin",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
        status: "ACTIVE",
        manualPrices: [],
      },
    ],
    portfolios: [
      {
        name: "PEA",
        broker: "Bourse Direct",
        cashAccounts: [{ name: "Espèces EUR", currency: "EUR", archived: false }],
      },
    ],
    fxRatesUser: [
      { baseCurrency: "EUR", quoteCurrency: "USD", rateDate: "2026-03-31", rate: "1.082400000000" },
    ],
  };
}

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parse(value: unknown, limits: KerdialJsonLimits = KERDIAL_JSON_LIMITS) {
  const input: CatalogueParseInput = {
    bytes: bytesOf(value),
    fileType: KERDIAL_CATALOGUE_FILE_TYPE,
    limits,
  };
  return kerdialCatalogueImporter.parse(input);
}

function fileErrorFrom(run: () => unknown): CatalogueFileError {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogueFileError) return error;
    throw error;
  }
  throw new Error("expected a CatalogueFileError and nothing was thrown");
}

describe("kerdialCatalogueImporter.parse", () => {
  it("names its format and its one file type", () => {
    const fileType: CatalogueFileType = KERDIAL_CATALOGUE_FILE_TYPE;

    expect(kerdialCatalogueImporter.formatKey).toBe("kerdial-json");
    expect(kerdialCatalogueImporter.supportedFileTypes).toStrictEqual([fileType]);
  });

  it("emits a draft whose figures are Decimals and whose icons stay undecoded base64", () => {
    const decode = vi.spyOn(Buffer, "from");

    const result = parse(validDocument());

    expect(result.problems).toStrictEqual([]);
    expect(result.entryCount).toBe(4);
    expect(result.draft.manifest).toStrictEqual({
      schemaVersion: KERDIAL_CATALOGUE_SCHEMA_VERSION,
      generator: KERDIAL_CATALOGUE_GENERATOR,
      exportedAt: "2026-09-24T18:03:11Z",
      baseCurrency: "EUR",
      iconsIncluded: true,
    });
    const share = result.draft.instruments[0]!;
    expect(share.at).toStrictEqual({ section: "instruments", index: 0 });
    expect(share.manualPrices[0]!.close.toFixed()).toBe("173.42");
    expect(share.watchlist?.targetPrice?.toFixed()).toBe("200");
    expect(share.icon?.base64).toBe("iVBORw0KGgo=");
    expect(result.draft.fxRatesUser[0]!.rate.toFixed()).toBe("1.0824");
    expect(result.draft.portfolios[0]!.cashAccounts[0]!.name).toBe("Espèces EUR");
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it("leaves an omitted optional field absent from the draft, never present-and-undefined", () => {
    const result = parse(validDocument());

    const crypto = result.draft.instruments[1]!;
    expect(Object.hasOwn(crypto, "icon")).toBe(false);
    expect(Object.hasOwn(crypto, "watchlist")).toBe(false);
    expect(Object.hasOwn(crypto.identity, "isin")).toBe(false);
    expect(Object.hasOwn(result.draft.portfolios[0]!, "description")).toBe(false);
  });

  it("takes a portfolio file from before the archived key unchanged, and reads the key when present (portfolio-archive AC-493)", () => {
    // `validDocument()` carries no `archived` key on its portfolio: it is the
    // pre-feature shape, through the same, unmodified validation.
    const before = kerdialCatalogueImporter.validate(parse(validDocument()));
    expect(before.problems).toStrictEqual([]);
    expect(Object.hasOwn(before.draft.portfolios[0]!, "archived")).toBe(false);

    for (const archived of [true, false]) {
      const document = validDocument();
      const result = kerdialCatalogueImporter.validate(
        parse({ ...document, portfolios: [{ ...document.portfolios[0]!, archived }] }),
      );
      expect(result.problems).toStrictEqual([]);
      expect(result.draft.portfolios[0]!.archived).toBe(archived);
    }
  });

  it("reports one bad entry and imports every other entry of the same document (FR-525)", () => {
    const document = validDocument();
    const withBadEntry = {
      ...document,
      instruments: [document.instruments[0], { identity: { kind: "NOT_A_KIND" } }],
    };
    const section: CatalogueSection = "instruments";
    const expectedRef: CatalogueEntryRef = { section, index: 1 };

    const result = parse(withBadEntry);
    const [problem] = result.problems as readonly CatalogueEntryProblem[];

    expect(result.entryCount).toBe(4);
    expect(result.draft.instruments).toHaveLength(1);
    expect(result.problems).toHaveLength(1);
    expect(problem!.at).toStrictEqual(expectedRef);
    expect(problem!.problem.code).toBe("MALFORMED_VALUE");
    // The valid entry's own outcome is unchanged by the invalid one's presence.
    expect(result.draft.instruments[0]).toStrictEqual(parse(document).draft.instruments[0]);
  });

  it("separates a missing key from a malformed one", () => {
    const document = validDocument();
    const { displayName: _dropped, ...withoutName } = document.instruments[0]!;
    const missing = parse({ ...document, instruments: [withoutName] });
    const malformed = parse({
      ...document,
      instruments: [{ ...document.instruments[0]!, displayName: 42 }],
    });

    expect(missing.problems[0]!.problem.code).toBe("MISSING_REQUIRED_VALUE");
    expect(malformed.problems[0]!.problem.code).toBe("MALFORMED_VALUE");
    expect(missing.problems[0]!.problem.message).toContain("displayName");
  });

  describe("whole-file failures", () => {
    it("refuses unreadable JSON text with KERDIAL_JSON_MALFORMED", () => {
      const error = fileErrorFrom(() =>
        kerdialCatalogueImporter.parse({
          bytes: new TextEncoder().encode("{ not json"),
          fileType: KERDIAL_CATALOGUE_FILE_TYPE,
          limits: KERDIAL_JSON_LIMITS,
        }),
      );

      expect(error.code).toBe("KERDIAL_JSON_MALFORMED");
    });

    it("refuses bytes that are not valid UTF-8", () => {
      const error = fileErrorFrom(() =>
        kerdialCatalogueImporter.parse({
          bytes: Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]),
          fileType: KERDIAL_CATALOGUE_FILE_TYPE,
          limits: KERDIAL_JSON_LIMITS,
        }),
      );

      expect(error.code).toBe("KERDIAL_JSON_MALFORMED");
    });

    it("maps a RangeError out of JSON.parse to KERDIAL_JSON_MALFORMED, never to an unhandled throw", () => {
      const jsonParse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw new RangeError("Maximum call stack size exceeded");
      });

      const error = fileErrorFrom(() => parse(validDocument()));

      expect(error.code).toBe("KERDIAL_JSON_MALFORMED");
      jsonParse.mockRestore();
    });

    it("refuses a pathologically nested document, as a refusal rather than a crash", () => {
      // MEASURED (Node 22.23.1, 2026-09-24): `JSON.parse` itself **accepts**
      // this input — a 200 000-deep array and a 200 000-deep object both parse
      // — so the expected `RangeError` does not reproduce on the deployed
      // runtime and the bound that actually refuses the document is the
      // fixed-depth schema one step later. Both halves are asserted: a deep
      // document is a whole-file failure, and a deep *entry* inside an
      // otherwise valid document is one reported entry.
      const depth = 200_000;
      const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;

      const whole = fileErrorFrom(() =>
        kerdialCatalogueImporter.parse({
          bytes: new TextEncoder().encode(nested),
          fileType: KERDIAL_CATALOGUE_FILE_TYPE,
          limits: KERDIAL_JSON_LIMITS,
        }),
      );
      const document = validDocument();
      const text = JSON.stringify(document).replace('"instruments":[', `"instruments":[${nested},`);
      const entry = kerdialCatalogueImporter.parse({
        bytes: new TextEncoder().encode(text),
        fileType: KERDIAL_CATALOGUE_FILE_TYPE,
        limits: KERDIAL_JSON_LIMITS,
      });

      expect(whole.code).toBe("KERDIAL_JSON_MALFORMED");
      expect(entry.problems).toHaveLength(1);
      expect(entry.problems[0]!.at).toStrictEqual({ section: "instruments", index: 0 });
      expect(entry.draft.instruments).toHaveLength(2);
    });

    it("refuses an unknown schemaVersion with its own code, and an absent one as malformed", () => {
      const unknownVersion = fileErrorFrom(() => parse({ ...validDocument(), schemaVersion: 99 }));
      const { schemaVersion: _omitted, ...withoutVersion } = validDocument();
      const absentVersion = fileErrorFrom(() => parse(withoutVersion));

      expect(unknownVersion.code).toBe("KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED");
      expect(absentVersion.code).toBe("KERDIAL_JSON_MALFORMED");
    });

    it("binds maxFileBytes — the same document parses at one value and is refused at the other (FR-539)", () => {
      const document = validDocument();
      const size = bytesOf(document).byteLength;

      const accepted = parse(document, { ...KERDIAL_JSON_LIMITS, maxFileBytes: size });
      const error = fileErrorFrom(() =>
        parse(document, { ...KERDIAL_JSON_LIMITS, maxFileBytes: size - 1 }),
      );

      expect(accepted.problems).toStrictEqual([]);
      expect(error.code).toBe("IMPORT_FILE_TOO_LARGE");
      expect(error.message).toContain(String(size));
    });
  });
});

describe("kerdialCatalogueImporter.validate", () => {
  function validated(document: KerdialCatalogueDocument): CatalogueParseResult {
    return kerdialCatalogueImporter.validate(parse(document));
  }

  it("keeps every entry of a well-formed document", () => {
    const result = validated(validDocument());

    expect(result.problems).toStrictEqual([]);
    expect(result.draft.instruments).toHaveLength(2);
    expect(result.entryCount).toBe(4);
  });

  it("refuses an identity that does not match its kind, in both directions", () => {
    const cryptoWithIsin = validDocument();
    cryptoWithIsin.instruments[1]!.identity = {
      kind: "CRYPTO",
      symbol: "BTC",
      isin: "FR0000120073",
    };
    const shareWithoutMic = validDocument();
    shareWithoutMic.instruments[0]!.identity = { kind: "SHARE", isin: "FR0000120073" };

    expect(validated(cryptoWithIsin).problems[0]!.problem.code).toBe("MALFORMED_VALUE");
    expect(validated(shareWithoutMic).problems[0]!.problem.code).toBe("MISSING_REQUIRED_VALUE");
  });

  describe("an SCPI entry (scpi FR-621, AC-510)", () => {
    type Instrument = KerdialCatalogueDocument["instruments"][number];

    function scpi(overrides: Partial<Instrument> = {}): Instrument {
      return {
        identity: { kind: "SCPI", isin: "FR0014005RN7" },
        private: false,
        listingCurrency: "EUR",
        displayName: "SCPI Pierre Rendement",
        primaryIdentifier: "ISIN",
        quotePolicy: "MANUAL_ONLY",
        status: "ACTIVE",
        managementCompany: "Société de Gestion Exemple",
        subscriptionFeePct: "8.50",
        manualPrices: [],
        ...overrides,
      };
    }

    function problemsOf(entry: unknown) {
      const document = { ...validDocument(), instruments: [entry] };
      return kerdialCatalogueImporter.validate(parse(document)).problems.map((p) => p.problem.code);
    }

    it("keeps a well-formed SCPI, its fee a Decimal, by ISIN or by symbol alone", () => {
      const document = validDocument();
      document.instruments = [
        scpi(),
        scpi({
          identity: { kind: "SCPI", symbol: "PFO2" },
          primaryIdentifier: "SYMBOL",
          managementCompany: undefined,
          subscriptionFeePct: undefined,
        }),
      ];

      const result = validated(document);

      expect(result.problems).toStrictEqual([]);
      expect(result.draft.instruments[0]!.managementCompany).toBe("Société de Gestion Exemple");
      expect(result.draft.instruments[0]!.subscriptionFeePct?.toFixed(2)).toBe("8.50");
      expect(Object.hasOwn(result.draft.instruments[1]!, "managementCompany")).toBe(false);
      expect(Object.hasOwn(result.draft.instruments[1]!, "subscriptionFeePct")).toBe(false);
    });

    it("reports an SCPI with quotePolicy AUTO, or with an exchange MIC, as an invalid row", () => {
      expect(problemsOf(scpi({ quotePolicy: "AUTO" }))).toStrictEqual(["MALFORMED_VALUE"]);
      expect(
        problemsOf(scpi({ identity: { kind: "SCPI", isin: "FR0014005RN7", exchangeMic: "XPAR" } })),
      ).toStrictEqual(["MALFORMED_VALUE"]);
    });

    it("reports an SCPI with neither ISIN nor symbol as a missing value", () => {
      expect(problemsOf(scpi({ identity: { kind: "SCPI" } }))).toStrictEqual([
        "MISSING_REQUIRED_VALUE",
      ]);
    });

    it("refuses a fee outside 0..100 or not a two-decimal percentage", () => {
      expect(problemsOf(scpi({ subscriptionFeePct: "100.01" }))).toStrictEqual(["MALFORMED_VALUE"]);
      expect(problemsOf(scpi({ subscriptionFeePct: "abc" }))).toStrictEqual(["MALFORMED_VALUE"]);
      expect(problemsOf(scpi({ subscriptionFeePct: "100" }))).toStrictEqual([]);
    });

    it("refuses either SCPI attribute on another kind", () => {
      const share = validDocument().instruments[0]!;
      expect(
        problemsOf({ ...share, managementCompany: "Société de Gestion Exemple" }),
      ).toStrictEqual(["MALFORMED_VALUE"]);
      expect(problemsOf({ ...share, subscriptionFeePct: "1.00" })).toStrictEqual([
        "MALFORMED_VALUE",
      ]);
    });
  });

  it("refuses a non-positive figure, and an over-wide one, with the named reason", () => {
    const zeroPrice = validDocument();
    zeroPrice.instruments[0]!.manualPrices = [
      { priceDate: "2026-03-31", close: "0", currency: "EUR" },
    ];
    const hugeRate = validDocument();
    hugeRate.fxRatesUser[0]!.rate = "1".repeat(17);

    expect(validated(zeroPrice).problems[0]!.problem.code).toBe("AMOUNT_NOT_POSITIVE");
    expect(validated(hugeRate).problems[0]!.problem.code).toBe("MALFORMED_VALUE");
    expect(validated(hugeRate).problems[0]!.problem.message).toContain("17 digits");
  });

  it("refuses an icon carried by a document whose manifest says it carries none (KD4.2)", () => {
    const contradictory = validDocument();
    contradictory.iconsIncluded = false;

    const result = validated(contradictory);

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.at).toStrictEqual({ section: "instruments", index: 0 });
    expect(result.draft.instruments).toHaveLength(1);
  });

  it("carries a parse-stage problem through rather than replacing it", () => {
    const document = validDocument();
    const withBadEntry = {
      ...document,
      fxRatesUser: [document.fxRatesUser[0], { baseCurrency: "EUR" }],
    };

    const result = kerdialCatalogueImporter.validate(parse(withBadEntry));

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.at).toStrictEqual({ section: "fxRatesUser", index: 1 });
  });
});
