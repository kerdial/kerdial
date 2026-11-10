import type {
  KerdialCatalogueCashAccount,
  KerdialCatalogueDocument,
  KerdialCatalogueFxRate,
  KerdialCatalogueIdentity,
  KerdialCatalogueInstrument,
  KerdialCatalogueInstrumentIcon,
  KerdialCatalogueManualPrice,
  KerdialCataloguePortfolio,
  KerdialCataloguePortfolioIcon,
  KerdialCatalogueProviderMapping,
  KerdialCatalogueWatchlist,
} from "./schema.js";

/**
 * The catalogue writer.
 *
 * **Pure, synchronous, no I/O, no clock, no randomness** — the same contract
 * the CSV writer has, and what lets the round-trip known-answer gate (EI-22)
 * exercise the format half with no database at all. `exportedAt` arrives in the
 * document; this function never reads a clock to invent one.
 *
 * **Three properties, each asserted in `serialize.test.ts` rather than
 * described here:**
 *
 *  1. **Round-trip identity.** `parse(serialize(x))` reproduces `x` field for
 *     field, icons included and compared by hash — the pure-function half of
 *     what AC-432 will later demand at the ledger layer.
 *  2. **Every figure is a quoted string, and `schemaVersion` is the one bare
 *     number** (FR-505/NFR-61 and the format's single stated exception). The document
 *     already holds its figures as decimal strings — `Decimal` is converted to
 *     text once, by the *reader* of the ledger rows (EI-21), through
 *     `serializeDecimal` — so this function cannot silently emit a JSON number
 *     even by accident: it has none to emit.
 *  3. **An absent optional field produces no key**, never `"key": null`.
 *     Every optional below is written as
 *     `...(value !== undefined && { key: value })`.
 *
 * **Key order is fixed, and it is the format's documented order**, not
 * `Object.keys(input)`'s: two exports of the same tenant are then the same
 * bytes, which is what makes a diff of two backups readable and a
 * content-hash comparison meaningful. That is the whole reason the objects
 * below are rebuilt member by member instead of being passed through.
 *
 * **Indented with two spaces, and one trailing newline.** The format is
 * documented as hand-editable and hand-authorable (FR-543's worked example),
 * and the indentation is a rounding error beside the base64 payloads that
 * dominate the byte budget.
 */

/** How the document is indented. Two spaces, as `prettier` and the repository's other emitted text use. */
const INDENT = 2;

/** The entry point: the whole document as the text of one file. */
export function serializeKerdialCatalogue(catalogue: KerdialCatalogueDocument): string {
  const document = {
    schemaVersion: catalogue.schemaVersion,
    generator: catalogue.generator,
    exportedAt: catalogue.exportedAt,
    baseCurrency: catalogue.baseCurrency,
    iconsIncluded: catalogue.iconsIncluded,
    instruments: catalogue.instruments.map(instrumentOf),
    portfolios: catalogue.portfolios.map(portfolioOf),
    fxRatesUser: catalogue.fxRatesUser.map(fxRateOf),
  };
  return `${JSON.stringify(document, null, INDENT)}\n`;
}

/**
 * Icon bytes to the document's base64, and the **only** place this cycle
 * encodes them.
 *
 * `Buffer.from(bytes).toString("base64")` — no re-encode, no metadata strip, no
 * re-compression: the decoded bytes are byte-identical to the input, which
 * `serialize.test.ts` asserts by SHA-256 rather than by length (a size-only
 * check passes for two different images of the same size, which is exactly the
 * failure AC-432 is written against).
 *
 * Standard base64 with `=` padding, not base64url: it is what
 * `validateInstrumentIconUpload` decodes on the way back in (MEASURED,
 * `api/src/instruments/instrument-icon.validate.ts`), and a second alphabet
 * would make the export non-round-trippable through the product's own reader.
 */
export function catalogueIconBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function instrumentOf(instrument: KerdialCatalogueInstrument): object {
  return {
    identity: identityOf(instrument.identity),
    private: instrument.private,
    listingCurrency: instrument.listingCurrency,
    displayName: instrument.displayName,
    primaryIdentifier: instrument.primaryIdentifier,
    quotePolicy: instrument.quotePolicy,
    status: instrument.status,
    ...(instrument.figi !== undefined && { figi: instrument.figi }),
    ...(instrument.sectorCode !== undefined && { sectorCode: instrument.sectorCode }),
    ...(instrument.industryLabel !== undefined && { industryLabel: instrument.industryLabel }),
    ...(instrument.domicileCountry !== undefined && {
      domicileCountry: instrument.domicileCountry,
    }),
    // SCPI only; absent on every other instrument, so a
    // document without an SCPI is byte-identical to a pre-feature one.
    ...(instrument.managementCompany !== undefined && {
      managementCompany: instrument.managementCompany,
    }),
    ...(instrument.subscriptionFeePct !== undefined && {
      subscriptionFeePct: instrument.subscriptionFeePct,
    }),
    ...(instrument.providerMapping !== undefined && {
      providerMapping: providerMappingOf(instrument.providerMapping),
    }),
    // Absent for every instrument when the export ran with `icons=omitted`
    // (KD4.2) — the manifest's `iconsIncluded` says which of the two documents
    // this is, and the import of the second leaves existing icons untouched.
    ...(instrument.icon !== undefined && { icon: instrumentIconOf(instrument.icon) }),
    manualPrices: instrument.manualPrices.map(manualPriceOf),
    ...(instrument.watchlist !== undefined && { watchlist: watchlistOf(instrument.watchlist) }),
  };
}

function identityOf(identity: KerdialCatalogueIdentity): object {
  return {
    kind: identity.kind,
    ...(identity.isin !== undefined && { isin: identity.isin }),
    ...(identity.exchangeMic !== undefined && { exchangeMic: identity.exchangeMic }),
    ...(identity.symbol !== undefined && { symbol: identity.symbol }),
  };
}

function providerMappingOf(mapping: KerdialCatalogueProviderMapping): object {
  return { providerKey: mapping.providerKey, providerSymbol: mapping.providerSymbol };
}

/** `source` is carried verbatim (V16/L6) — a measurement showed that MANUAL-only would select the same rows and so is not the size optimisation it looks like. */
function instrumentIconOf(icon: KerdialCatalogueInstrumentIcon): object {
  return { contentType: icon.contentType, source: icon.source, base64: icon.base64 };
}

/** No `source`: `portfolio_icon` has no such column (MEASURED, `platform/db/src/schema/portfolio-icon.ts:95-107`). */
function portfolioIconOf(icon: KerdialCataloguePortfolioIcon): object {
  return { contentType: icon.contentType, base64: icon.base64 };
}

function manualPriceOf(price: KerdialCatalogueManualPrice): object {
  return { priceDate: price.priceDate, close: price.close, currency: price.currency };
}

function watchlistOf(watchlist: KerdialCatalogueWatchlist): object {
  return {
    ...(watchlist.targetPrice !== undefined && { targetPrice: watchlist.targetPrice }),
    ...(watchlist.note !== undefined && { note: watchlist.note }),
  };
}

function portfolioOf(portfolio: KerdialCataloguePortfolio): object {
  return {
    name: portfolio.name,
    ...(portfolio.broker !== undefined && { broker: portfolio.broker }),
    ...(portfolio.description !== undefined && { description: portfolio.description }),
    ...(portfolio.accentColor !== undefined && { accentColor: portfolio.accentColor }),
    ...(portfolio.icon !== undefined && { icon: portfolioIconOf(portfolio.icon) }),
    // FR-604: only ever `true` — a non-archived portfolio omits the key.
    ...(portfolio.archived === true && { archived: true }),
    cashAccounts: portfolio.cashAccounts.map(cashAccountOf),
  };
}

function cashAccountOf(account: KerdialCatalogueCashAccount): object {
  return { name: account.name, currency: account.currency, archived: account.archived };
}

function fxRateOf(rate: KerdialCatalogueFxRate): object {
  return {
    baseCurrency: rate.baseCurrency,
    quoteCurrency: rate.quoteCurrency,
    rateDate: rate.rateDate,
    rate: rate.rate,
  };
}
