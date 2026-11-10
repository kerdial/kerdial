import { parseDecimalString } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

import {
  KERDIAL_CATALOGUE_FILE_TYPE,
  kerdialCatalogueImporter,
  type CatalogueCashAccountEntry,
  type CatalogueDraft,
  type CatalogueFxRateEntry,
  type CatalogueInstrumentEntry,
  type CatalogueInstrumentIdentity,
  type CatalogueManifest,
  type CatalogueManualPrice,
  type CatalogueParseResult,
  type CataloguePortfolioEntry,
  type CatalogueWatchlist,
} from "./index.js";

/**
 * **The containment proof for the catalogue half.**
 *
 * The transactions format's vocabulary is gated by a literal scan
 * (`pnpm import-vocabulary-gate`, `tools/gates/src/import-vocabulary/`). The
 * catalogue's cannot be: its field names are camelCase — `schemaVersion`,
 * `exchangeMic`, `manualPrices` — and collide with ordinary identifiers
 * everywhere, so a scan over the pipeline would either miss everything or fire
 * on correct code. The property is therefore carried a different way,
 * and this file **is** that way:
 *
 *   **every stage after `parse` is driven here from a hand-built draft, and
 *   there is not one character of document text anywhere in this file.**
 *
 * No encoded bytes, no serialized document, no parser call, no base64 that
 * came from a file. If `validate` — or, later, `planCatalogue`/
 * `applyCatalogue` — ever needed to reach back into the source text, this test
 * could not be written, and that is exactly what makes it a falsification and
 * not a formality.
 *
 * `planCatalogue`/`applyCatalogue` do not exist yet (EI-20). {@link planStub}
 * stands in for their **shape** — a function of the draft alone — so the
 * property is asserted now rather than deferred to the change that would be least
 * likely to notice it was lost.
 */

/**
 * The draft literal, built piece by piece with **each piece annotated by its own
 * declared type** — so this file is not only the containment proof but also the
 * thing that keeps those declarations honest: a member that drifts is a compile
 * error here rather than a surprise at the stage that consumes it.
 */
function manifest(): CatalogueManifest {
  return {
    schemaVersion: 1,
    generator: "kerdial",
    exportedAt: "2026-09-24T18:03:11Z",
    baseCurrency: "EUR",
    iconsIncluded: true,
  };
}

function shareIdentity(): CatalogueInstrumentIdentity {
  return { kind: "SHARE", isin: "FR0000120073", exchangeMic: "XPAR", symbol: "AI" };
}

function manualPrice(): CatalogueManualPrice {
  return { priceDate: "2026-03-31", close: parseDecimalString("173.42"), currency: "EUR" };
}

function watchlist(): CatalogueWatchlist {
  return { targetPrice: parseDecimalString("200"), note: "surveillé" };
}

function cashAccount(): CatalogueCashAccountEntry {
  return { name: "Espèces EUR", currency: "EUR", archived: false };
}

function shareEntry(): CatalogueInstrumentEntry {
  return {
    at: { section: "instruments", index: 0 },
    identity: shareIdentity(),
    private: false,
    listingCurrency: "EUR",
    displayName: "Air Liquide",
    primaryIdentifier: "ISIN",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    manualPrices: [manualPrice()],
    watchlist: watchlist(),
  };
}

function cryptoEntry(): CatalogueInstrumentEntry {
  return {
    at: { section: "instruments", index: 1 },
    identity: { kind: "CRYPTO", symbol: "BTC" },
    private: true,
    listingCurrency: "EUR",
    displayName: "Bitcoin",
    primaryIdentifier: "SYMBOL",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    manualPrices: [],
  };
}

function portfolioEntry(): CataloguePortfolioEntry {
  return {
    at: { section: "portfolios", index: 0 },
    name: "PEA",
    broker: "Bourse Direct",
    cashAccounts: [cashAccount()],
  };
}

function fxRateEntry(): CatalogueFxRateEntry {
  return {
    at: { section: "fxRatesUser", index: 0 },
    baseCurrency: "EUR",
    quoteCurrency: "USD",
    rateDate: "2026-03-31",
    rate: parseDecimalString("1.0824"),
  };
}

function draft(): CatalogueDraft {
  return {
    manifest: manifest(),
    instruments: [shareEntry(), cryptoEntry()],
    portfolios: [portfolioEntry()],
    fxRatesUser: [fxRateEntry()],
  };
}

function resultOf(value: CatalogueDraft): CatalogueParseResult {
  return {
    fileType: KERDIAL_CATALOGUE_FILE_TYPE,
    entryCount: value.instruments.length + value.portfolios.length + value.fxRatesUser.length,
    draft: value,
    problems: [],
  };
}

/**
 * `planCatalogue`'s shape, stubbed (EI-20 builds the real one): a function of
 * the draft and nothing else, which is the property under test. It counts what
 * a plan would write, per section and in order.
 */
function planStub(value: CatalogueDraft): {
  readonly instruments: number;
  readonly cashAccounts: number;
  readonly fxRates: number;
} {
  return {
    instruments: value.instruments.length,
    cashAccounts: value.portfolios.reduce(
      (total, portfolio) => total + portfolio.cashAccounts.length,
      0,
    ),
    fxRates: value.fxRatesUser.length,
  };
}

describe("the catalogue stages, driven from a hand-built draft", () => {
  it("validates a draft that was never parsed from anything", () => {
    const result = kerdialCatalogueImporter.validate(resultOf(draft()));

    expect(result.problems).toStrictEqual([]);
    expect(result.draft.instruments).toHaveLength(2);
    expect(result.entryCount).toBe(4);
  });

  it("refuses an identity that does not match its kind, reading only the draft", () => {
    const built = draft();
    const instruments = [
      { ...built.instruments[0]!, identity: { kind: "SHARE" as const, isin: "FR0000120073" } },
      built.instruments[1]!,
    ];

    const result = kerdialCatalogueImporter.validate(resultOf({ ...built, instruments }));

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.problem.code).toBe("MISSING_REQUIRED_VALUE");
    expect(result.draft.instruments).toHaveLength(1);
  });

  it("refuses a figure that is not greater than zero", () => {
    const built = draft();
    const fxRatesUser = [{ ...built.fxRatesUser[0]!, rate: parseDecimalString("0") }];

    const result = kerdialCatalogueImporter.validate(resultOf({ ...built, fxRatesUser }));

    expect(result.problems[0]!.problem.code).toBe("AMOUNT_NOT_POSITIVE");
    expect(result.draft.fxRatesUser).toStrictEqual([]);
  });

  it("is enough on its own for the stage that comes next", () => {
    const result = kerdialCatalogueImporter.validate(resultOf(draft()));

    expect(planStub(result.draft)).toStrictEqual({
      instruments: 2,
      cashAccounts: 1,
      fxRates: 1,
    });
  });
});
