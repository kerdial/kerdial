import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";

import type { KerdialJsonLimits } from "../../limits.js";
import type { CurrencyCode, IsoDate, RowProblem } from "../../types.js";
import {
  KERDIAL_CATALOGUE_SCHEMA_VERSION,
  kerdialCatalogueEnvelopeSchema,
  kerdialCatalogueFxRateSchema,
  kerdialCatalogueInstrumentSchema,
  kerdialCataloguePortfolioSchema,
  type KerdialCatalogueFxRate,
  type KerdialCatalogueInstrument,
  type KerdialCatalogueInstrumentIcon,
  type KerdialCataloguePortfolio,
  type KerdialCataloguePortfolioIcon,
} from "./schema.js";

/**
 * `kerdialCatalogueImporter` — `parse`/`validate` for the Kerdial catalogue
 * package.
 *
 * **On the interface name.** This implementation sits behind the one
 * existing interface; `CsvImporter` is a
 * slight misnomer for a JSON reader, decided **not** to be renamed because the
 * rename would touch the Portfolio-Performance module's own declaration and put
 * FR-551's "unmodified" claim into the grey. That decision stands and this
 * sentence is its record. What this module could *not* reuse is the interface's
 * **types**, and that is a measured difference rather than a preference:
 *
 *   - `ParseResult` is row-shaped (`rowCount`, `rows: ParsedRow[]`, each row a
 *     `NeutralRow`), and a catalogue has no rows — it has three sections of
 *     entities, and `planCatalogue`/`applyCatalogue`
 *     exist precisely because the transaction machinery does not fit;
 *   - `ImportFileType` does not yet carry `"KERDIAL_CATALOGUE"`, and
 *     `FileProblemCode` does not carry this format's three whole-file codes.
 *
 * So the shapes below **mirror** `types.ts`'s contract — same staging, same
 * purity, same "a whole-file failure throws, a per-entry failure is reported"
 * split — over catalogue vocabulary, and reuse `RowProblem`/`ParseRejectReason`
 * by import so the reason vocabulary stays the one closed set (the
 * taxonomy is of *remedies*, and multiplying it per format is how it stops
 * being closed). {@link KERDIAL_CATALOGUE_FILE_TYPE} moves into
 * `ImportFileType` with the change that adds the route (EI-24), together with
 * `core/api-contracts`' `IMPORT_FILE_TYPES` mirror.
 *
 * **The safety net that pair is supposed to have does not exist — MEASURED,
 * 2026-09-24.** `api/src/imports/imports.schema.test.ts` was expected to be
 * the test asserting the two lists equal; that file is **absent**, and a
 * repository-wide grep for `IMPORT_FILE_TYPES` finds exactly two hits, its own
 * declaration (`core/api-contracts/src/import-request.schema.ts:43`) and this
 * comment. So the mirror is currently unguarded, and the change that widens the
 * union owns writing that assertion rather than assuming it.
 *
 * **Purity.** `parse` and `validate` are synchronous, do no I/O, read no clock
 * and touch no database — the same contract `types.ts:526-529` states for
 * `CsvImporter`, and what lets `catalogue-draft.neutral.test.ts` drive
 * `validate` from a hand-built draft with no JSON text anywhere in it.
 */

/** The file type this format reads. One value, one route (`POST /imports/kerdial/catalogue`). */
export const KERDIAL_CATALOGUE_FILE_TYPE = "KERDIAL_CATALOGUE";

/** See {@link KERDIAL_CATALOGUE_FILE_TYPE}. */
export type CatalogueFileType = typeof KERDIAL_CATALOGUE_FILE_TYPE;

/**
 * The three whole-file failures, and the whole list (the error envelope).
 * Each is a `400`/`413` on the route; none can be attributed to one entry,
 * which is exactly what separates them from a {@link CatalogueEntryProblem}.
 */
export type CatalogueFileProblemCode =
  /** `JSON.parse` refused the bytes, or the document is not the shape a catalogue has at all. */
  | "KERDIAL_JSON_MALFORMED"
  /** `schemaVersion` is present and is not a version this build reads. */
  | "KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED"
  /** Past `KerdialJsonLimits.maxFileBytes`; the same code the multipart layer already answers with (MEASURED, `api/src/imports-limits.e2e.test.ts:167`). */
  | "IMPORT_FILE_TOO_LARGE";

/**
 * Thrown by {@link kerdialCatalogueImporter.parse} — and only by it — when the
 * file cannot be read as a catalogue at all. Every per-entry failure is a
 * {@link CatalogueEntryProblem} inside the result instead, because FR-525
 * requires the other entries of the same file to still be reported.
 */
export class CatalogueFileError extends Error {
  constructor(
    readonly code: CatalogueFileProblemCode,
    message: string,
  ) {
    super(message);
    this.name = "CatalogueFileError";
  }
}

/** Which array an entry came from. The document has exactly three. */
export type CatalogueSection = "instruments" | "portfolios" | "fxRatesUser";

/** Where an entry came from, for reporting. `index` is 0-based within its own section — the stable key the UI and `resolutions[]` address entries by. */
export interface CatalogueEntryRef {
  readonly section: CatalogueSection;
  readonly index: number;
}

/** One refused entry, with exactly one named reason. Same rule as `RowProblem`: never a bare "invalid entry" (IMP-AC-13). */
export interface CatalogueEntryProblem {
  readonly at: CatalogueEntryRef;
  readonly problem: RowProblem;
}

/** The document's manifest, carried verbatim — `exportedAt` stays the RFC 3339 string it was written as, so the draft holds no clock-derived value. */
export interface CatalogueManifest {
  readonly schemaVersion: number;
  readonly generator: string;
  readonly exportedAt: string;
  readonly baseCurrency: CurrencyCode;
  /** `false` => the document carries no icons and an import leaves existing ones untouched (KD4.2). */
  readonly iconsIncluded: boolean;
}

/** An instrument's identity, as the draft carries it. Which members a kind requires is {@link validate}'s rule, not the schema's. */
export interface CatalogueInstrumentIdentity {
  readonly kind: KerdialCatalogueInstrument["identity"]["kind"];
  readonly isin?: string;
  readonly exchangeMic?: string;
  readonly symbol?: string;
}

/** One manual price point, with its figure as a {@link Decimal} — the pipeline vocabulary's rule, not the document's. */
export interface CatalogueManualPrice {
  readonly priceDate: IsoDate;
  readonly close: Decimal;
  readonly currency: CurrencyCode;
}

/** An instrument's watchlist row. Both members independently optional (FR-341). */
export interface CatalogueWatchlist {
  readonly targetPrice?: Decimal;
  readonly note?: string;
}

/** One `instruments[]` entry of the draft. */
export interface CatalogueInstrumentEntry {
  readonly at: CatalogueEntryRef;
  readonly identity: CatalogueInstrumentIdentity;
  readonly private: boolean;
  readonly listingCurrency: CurrencyCode;
  readonly displayName: string;
  readonly primaryIdentifier: KerdialCatalogueInstrument["primaryIdentifier"];
  readonly quotePolicy: KerdialCatalogueInstrument["quotePolicy"];
  readonly status: KerdialCatalogueInstrument["status"];
  readonly figi?: string;
  readonly sectorCode?: KerdialCatalogueInstrument["sectorCode"];
  readonly industryLabel?: string;
  readonly domicileCountry?: string;
  /** SCPI only (`scpi` FR-621); absent = no statement. */
  readonly managementCompany?: string;
  /** SCPI only, a percentage 0..100 with at most two decimals — a {@link Decimal}, as every draft figure. */
  readonly subscriptionFeePct?: Decimal;
  readonly providerMapping?: { readonly providerKey: string; readonly providerSymbol: string };
  /** Base64 **undecoded**: the decode order lives behind the `CatalogueIconValidator` port, and re-implementing it here would lose its measured flat-encoded-length trap. */
  readonly icon?: KerdialCatalogueInstrumentIcon;
  readonly manualPrices: readonly CatalogueManualPrice[];
  readonly watchlist?: CatalogueWatchlist;
}

/** One cash account of a portfolio. */
export interface CatalogueCashAccountEntry {
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly archived: boolean;
}

/** One `portfolios[]` entry of the draft. Its icon has no `source` — the column does not exist. */
export interface CataloguePortfolioEntry {
  readonly at: CatalogueEntryRef;
  readonly name: string;
  readonly broker?: string;
  readonly description?: string;
  readonly accentColor?: KerdialCataloguePortfolio["accentColor"];
  readonly icon?: KerdialCataloguePortfolioIcon;
  /** Absent = the file makes no statement (PA-L6); see `kerdialCataloguePortfolioSchema`. */
  readonly archived?: boolean;
  readonly cashAccounts: readonly CatalogueCashAccountEntry[];
}

/** One `fxRatesUser[]` entry of the draft. */
export interface CatalogueFxRateEntry {
  readonly at: CatalogueEntryRef;
  readonly baseCurrency: CurrencyCode;
  readonly quoteCurrency: CurrencyCode;
  readonly rateDate: IsoDate;
  readonly rate: Decimal;
}

/**
 * What `parse` emits and `planCatalogue`/`applyCatalogue` consume.
 *
 * **Format-agnostic by construction**: nothing below names a JSON key, a
 * base64 alphabet or a schema version beyond the manifest's own number, which
 * is what lets the catalogue stages be driven from a hand-built literal with no
 * JSON text in the test file (the containment proof for this half, since
 * the JSON vocabulary is camelCase and cannot be literal-scanned).
 */
export interface CatalogueDraft {
  readonly manifest: CatalogueManifest;
  readonly instruments: readonly CatalogueInstrumentEntry[];
  readonly portfolios: readonly CataloguePortfolioEntry[];
  readonly fxRatesUser: readonly CatalogueFxRateEntry[];
}

/** `parse`'s input. `limits` is injected rather than read from module scope, so a test can bind it at two values (FR-539, `limits.ts`'s standing rule). */
export interface CatalogueParseInput {
  readonly bytes: Uint8Array;
  readonly fileType: CatalogueFileType;
  readonly limits: KerdialJsonLimits;
}

/** `parse`/`validate`'s result: the entries that survived, and one named problem per entry that did not. */
export interface CatalogueParseResult {
  readonly fileType: CatalogueFileType;
  /** Entries read from the document, refused ones included — `draft` entries + `problems` entries. */
  readonly entryCount: number;
  readonly draft: CatalogueDraft;
  readonly problems: readonly CatalogueEntryProblem[];
}

/**
 * The catalogue's half of FR-516's "one interface, two implementations", in the
 * shape `CsvImporter` has and over the vocabulary a catalogue actually carries.
 * See this module's header for why the declaration is here and not in
 * `types.ts`.
 */
export interface CatalogueImporter {
  readonly formatKey: string;
  readonly supportedFileTypes: readonly CatalogueFileType[];
  /** Pure, synchronous, no I/O, no clock. Throws {@link CatalogueFileError} on a whole-file failure only. */
  parse(input: CatalogueParseInput): CatalogueParseResult;
  /** Pure, synchronous. The per-entry rules that need no database. */
  validate(parsed: CatalogueParseResult): CatalogueParseResult;
}

/**
 * `manual_price_point.close` and `watchlist_item.target_price` are
 * `numeric(38,18)` (MEASURED, `manual-price-point.ts:31`,
 * `watchlist-item.ts:79`) -> 20 digits before the point; `fx_rate_user.rate` is
 * `numeric(28,12)` (MEASURED, `fx-rate-user.ts:29`) -> 16. A figure too large
 * for its column is refused here, at validate, for the reason
 * `formats/portfolio-performance/index.ts` records at its own copy of this
 * rule: a value certain to fail at the `INSERT` belongs in the rejected count
 * at plan time, with a reason the user can read, or the dry run stops equalling
 * the confirm.
 */
const PRICE_MAX_INTEGER_DIGITS = 20;
const FX_RATE_MAX_INTEGER_DIGITS = 16;

/** `CRYPTO` and `INDEX` are created by symbol alone; every other kind is created by ISIN + MIC (`isSymbolBasedInstrumentKind`, `instrument-create.schema.ts:38-43`, mirrored here over the identity rather than the create body). */
const SYMBOL_BASED_KINDS: ReadonlySet<CatalogueInstrumentIdentity["kind"]> = new Set([
  "CRYPTO",
  "INDEX",
]);

function parse(input: CatalogueParseInput): CatalogueParseResult {
  // The first bound, before anything is materialised: the byte ceiling is
  // checked against the *bytes*, not against the decoded text, because the
  // decode is itself the first allocation an over-size upload would win.
  if (input.bytes.byteLength > input.limits.maxFileBytes) {
    throw new CatalogueFileError(
      "IMPORT_FILE_TOO_LARGE",
      `the file is ${String(input.bytes.byteLength)} bytes; this route accepts at most ${String(input.limits.maxFileBytes)}`,
    );
  }

  const text = decodeUtf8(input.bytes);
  const value = parseJson(text);
  refuseUnknownSchemaVersion(value);

  const envelope = kerdialCatalogueEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new CatalogueFileError(
      "KERDIAL_JSON_MALFORMED",
      `the document is not a Kerdial catalogue: ${firstIssue(envelope.error.issues)}`,
    );
  }

  const problems: CatalogueEntryProblem[] = [];
  const instruments = readSection(
    envelope.data.instruments,
    "instruments",
    kerdialCatalogueInstrumentSchema,
    draftInstrument,
    problems,
  );
  const portfolios = readSection(
    envelope.data.portfolios,
    "portfolios",
    kerdialCataloguePortfolioSchema,
    draftPortfolio,
    problems,
  );
  const fxRatesUser = readSection(
    envelope.data.fxRatesUser,
    "fxRatesUser",
    kerdialCatalogueFxRateSchema,
    draftFxRate,
    problems,
  );

  return {
    fileType: input.fileType,
    entryCount:
      envelope.data.instruments.length +
      envelope.data.portfolios.length +
      envelope.data.fxRatesUser.length,
    draft: {
      manifest: {
        schemaVersion: envelope.data.schemaVersion,
        generator: envelope.data.generator,
        exportedAt: envelope.data.exportedAt,
        baseCurrency: envelope.data.baseCurrency,
        iconsIncluded: envelope.data.iconsIncluded,
      },
      instruments,
      portfolios,
      fxRatesUser,
    },
    problems,
  };
}

/**
 * The per-entry rules that need no database. Reads the **draft** and nothing
 * else — no JSON, no schema, no source text — which is what makes the
 * containment proof (`catalogue-draft.neutral.test.ts`) able to drive it from a
 * hand-built literal.
 */
function validate(parsed: CatalogueParseResult): CatalogueParseResult {
  const problems: CatalogueEntryProblem[] = [...parsed.problems];
  const iconsIncluded = parsed.draft.manifest.iconsIncluded;

  const instruments = parsed.draft.instruments.filter((entry) => {
    const problem = validateInstrument(entry, iconsIncluded);
    if (problem === null) return true;
    problems.push({ at: entry.at, problem });
    return false;
  });
  const portfolios = parsed.draft.portfolios.filter((entry) => {
    const problem = validatePortfolio(entry, iconsIncluded);
    if (problem === null) return true;
    problems.push({ at: entry.at, problem });
    return false;
  });
  const fxRatesUser = parsed.draft.fxRatesUser.filter((entry) => {
    const problem = validateFxRate(entry);
    if (problem === null) return true;
    problems.push({ at: entry.at, problem });
    return false;
  });

  return {
    fileType: parsed.fileType,
    // The stage is entry-preserving: `entryCount` counts what the document
    // carried, so `draft` + `problems` still accounts for every one of them.
    entryCount: parsed.entryCount,
    draft: { manifest: parsed.draft.manifest, instruments, portfolios, fxRatesUser },
    problems,
  };
}

function validateInstrument(
  entry: CatalogueInstrumentEntry,
  iconsIncluded: boolean,
): RowProblem | null {
  const { identity } = entry;
  if (identity.kind === "SCPI") {
    const problem = validateScpi(entry);
    if (problem !== null) return problem;
  } else if (entry.managementCompany !== undefined || entry.subscriptionFeePct !== undefined) {
    return malformed(
      `the management company and the subscription fee describe an SCPI; a ${identity.kind} instrument carries neither`,
    );
  } else if (SYMBOL_BASED_KINDS.has(identity.kind)) {
    if (identity.symbol === undefined) {
      return {
        code: "MISSING_REQUIRED_VALUE",
        message: `a ${identity.kind} instrument is identified by its symbol, and this entry carries none`,
      };
    }
    if (identity.isin !== undefined || identity.exchangeMic !== undefined) {
      return malformed(
        `a ${identity.kind} instrument carries no ISIN and no exchange MIC; this entry carries one`,
      );
    }
  } else {
    if (identity.isin === undefined || identity.exchangeMic === undefined) {
      return {
        code: "MISSING_REQUIRED_VALUE",
        message: `a ${identity.kind} instrument is identified by its ISIN and its exchange MIC, and this entry is missing one of the two`,
      };
    }
  }

  if (entry.icon !== undefined && !iconsIncluded) {
    return malformed(
      "the manifest says this document carries no icons, and this instrument carries one",
    );
  }

  for (const price of entry.manualPrices) {
    const problem =
      notPositive(price.close, "a manual price") ??
      tooLarge(price.close, PRICE_MAX_INTEGER_DIGITS, "a manual price");
    if (problem !== null) return problem;
  }

  const target = entry.watchlist?.targetPrice;
  if (target !== undefined) {
    return (
      notPositive(target, "the watchlist target price") ??
      tooLarge(target, PRICE_MAX_INTEGER_DIGITS, "the watchlist target price")
    );
  }
  return null;
}

/**
 * An SCPI entry: unlisted, so no exchange MIC; an
 * ISIN or a symbol, or both; priced by hand only, so `quotePolicy` is
 * `MANUAL_ONLY` (AC-510) and no provider mapping applies; no sector or
 * industry (the create path never writes them); the fee within 0..100.
 */
function validateScpi(entry: CatalogueInstrumentEntry): RowProblem | null {
  const { identity } = entry;
  if (identity.isin === undefined && identity.symbol === undefined) {
    return {
      code: "MISSING_REQUIRED_VALUE",
      message:
        "an SCPI instrument is identified by its ISIN or its symbol, and this entry carries neither",
    };
  }
  if (identity.exchangeMic !== undefined) {
    return malformed(
      "an SCPI instrument is not listed and carries no exchange MIC; this entry carries one",
    );
  }
  if (entry.quotePolicy !== "MANUAL_ONLY") {
    return malformed(
      `an SCPI instrument is priced by hand only (MANUAL_ONLY); this entry says ${entry.quotePolicy}`,
    );
  }
  if (entry.sectorCode !== undefined || entry.industryLabel !== undefined) {
    return malformed(
      "an SCPI instrument carries no sector and no industry; this entry carries one",
    );
  }
  if (entry.providerMapping !== undefined) {
    return malformed(
      "an SCPI instrument has no market data provider; this entry carries a provider mapping",
    );
  }
  if (entry.subscriptionFeePct?.greaterThan(100) === true) {
    return malformed("the subscription fee is a percentage between 0 and 100");
  }
  return null;
}

function validatePortfolio(
  entry: CataloguePortfolioEntry,
  iconsIncluded: boolean,
): RowProblem | null {
  if (entry.icon !== undefined && !iconsIncluded) {
    return malformed(
      "the manifest says this document carries no icons, and this portfolio carries one",
    );
  }
  return null;
}

function validateFxRate(entry: CatalogueFxRateEntry): RowProblem | null {
  if (entry.baseCurrency === entry.quoteCurrency) {
    return malformed("a user FX rate quotes one currency against another, not against itself");
  }
  return (
    notPositive(entry.rate, "the FX rate") ??
    tooLarge(entry.rate, FX_RATE_MAX_INTEGER_DIGITS, "the FX rate")
  );
}

function malformed(message: string): RowProblem {
  return { code: "MALFORMED_VALUE", message };
}

function notPositive(amount: Decimal, label: string): RowProblem | null {
  return amount.greaterThan(0)
    ? null
    : { code: "AMOUNT_NOT_POSITIVE", message: `${label} is not greater than zero` };
}

/** The digits before the decimal point, read off the value's own plain text — `toFixed()` with no argument never renders an exponent, so no float arithmetic is involved (`no-float-ops-on-decimal`). */
function tooLarge(amount: Decimal, maxIntegerDigits: number, label: string): RowProblem | null {
  const text = amount.abs().toFixed();
  const point = text.indexOf(".");
  const digits = point === -1 ? text.length : point;
  return digits > maxIntegerDigits
    ? malformed(
        `${label} has ${String(digits)} digits before the decimal point; the ledger stores at most ${String(maxIntegerDigits)}`,
      )
    : null;
}

/** UTF-8, BOM stripped by the decoder, invalid sequences refused rather than replaced with U+FFFD (`fatal: true`) — a replacement character inside a name would be a silently corrupted import. */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CatalogueFileError("KERDIAL_JSON_MALFORMED", "the file is not valid UTF-8 text");
  }
}

/**
 * `JSON.parse`, with **`RangeError` caught beside `SyntaxError`**.
 *
 * MEASURED, Node 22.23.1 (2026-09-24): `JSON.parse` does **not** raise on depth
 * — `"[".repeat(1_000_000)` and a 200 000-deep object both parse — so the expectation that
 * "a pathologically nested document raises `RangeError`" does not reproduce on
 * the deployed runtime, and the structural bound that actually refuses such a
 * document is the fixed-depth schema one step later. The catch stays, and is
 * not decoration: `RangeError` is still reachable from this call on an input
 * near V8's string/array ceilings, and the requirement is that it never
 * reaches the unhandled-500 branch the way `FST_INVALID_JSON_FIELD_ERROR` once
 * did (MEASURED, `api/src/imports/multipart.ts:267-279`).
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) {
      throw new CatalogueFileError(
        "KERDIAL_JSON_MALFORMED",
        "the file is not readable as JSON text",
      );
    }
    throw error;
  }
}

/**
 * An unknown `schemaVersion` refuses the **whole** document with its own
 * code, so the user is told the file is from another version rather than that
 * it is malformed. Read before the envelope for exactly that reason — the
 * envelope would report the same document as a shape failure.
 *
 * An **absent** version is deliberately *not* handled here: it falls through to
 * the envelope and is refused as malformed, which is the deliberate asymmetry
 * with the CSV's optional version comment.
 */
function refuseUnknownSchemaVersion(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const version: unknown = (value as Record<string, unknown>)["schemaVersion"];
  if (typeof version === "number" && version !== KERDIAL_CATALOGUE_SCHEMA_VERSION) {
    throw new CatalogueFileError(
      "KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED",
      `this build reads schemaVersion ${String(KERDIAL_CATALOGUE_SCHEMA_VERSION)}; the document declares ${String(version)}`,
    );
  }
}

/**
 * One Zod issue, rendered as "path: message" — the path and the rule it broke,
 * never the value.
 *
 * **The citation this comment used to carry was wrong, and the rule it states
 * is narrower than it looked** (security review I1). NFR-55 is
 * the *icon-upload* path's security properties — leading-byte type detection,
 * no client-supplied filename stored or reflected, the body bounded before it
 * is buffered — and says nothing about echoing a parsed value. Nothing in the
 * requirements forbids an echo here; what governs is the same response-size argument
 * the CSV reader's `echoCell` records, and on this side it lands differently:
 * a JSON field that fails validation can be a 349 528-character base64 icon,
 * and Zod's `path` already names it exactly (`instruments.3.icon.base64`), so
 * the value would add length without adding information. **So the two formats
 * do not in fact state contradictory rules: both are "say as much as is
 * useful, bounded". The CSV cell is useful and is echoed within
 * `echoCell`'s 120 characters; the JSON value is not, and is not.**
 */
function firstIssue(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const issue = issues[0];
  if (issue === undefined) return "the document does not match the catalogue schema";
  const path = issue.path.map((segment) => String(segment)).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * Validates one section's entries individually, so one refused entry is one
 * reported problem and every other entry of the same document still imports
 * (FR-525 — the property AC-429 pins for the CSV half of this cycle).
 */
function readSection<TParsed, TEntry>(
  raw: readonly unknown[],
  section: CatalogueSection,
  schema: { safeParse(value: unknown): { success: boolean; data?: TParsed; error?: unknown } },
  toEntry: (parsed: TParsed, at: CatalogueEntryRef) => TEntry,
  problems: CatalogueEntryProblem[],
): TEntry[] {
  const entries: TEntry[] = [];
  raw.forEach((value, index) => {
    const at: CatalogueEntryRef = { section, index };
    const result = schema.safeParse(value);
    if (result.success && result.data !== undefined) {
      entries.push(toEntry(result.data, at));
      return;
    }
    const issues = issuesOf(result.error);
    problems.push({
      at,
      problem: {
        code: missingKey(value, issues) ? "MISSING_REQUIRED_VALUE" : "MALFORMED_VALUE",
        message: firstIssue(issues),
      },
    });
  });
  return entries;
}

function issuesOf(error: unknown): readonly { path: PropertyKey[]; message: string }[] {
  if (typeof error !== "object" || error === null) return [];
  const issues: unknown = (error as { issues?: unknown }).issues;
  return Array.isArray(issues)
    ? (issues as readonly { path: PropertyKey[]; message: string }[])
    : [];
}

/**
 * Which of the two reason codes an entry's failure gets: a key the entry simply
 * does not have is `MISSING_REQUIRED_VALUE`, anything else is
 * `MALFORMED_VALUE`. Decided by reading the **entry**, not by matching on a Zod
 * issue code — the issue vocabulary is the library's and would move under us,
 * `Object.hasOwn` is the language's.
 */
function missingKey(value: unknown, issues: readonly { path: PropertyKey[] }[]): boolean {
  const first = issues[0]?.path[0];
  if (first === undefined) return false;
  if (typeof value !== "object" || value === null) return false;
  return !Object.hasOwn(value, first);
}

function draftInstrument(
  parsed: KerdialCatalogueInstrument,
  at: CatalogueEntryRef,
): CatalogueInstrumentEntry {
  return {
    at,
    identity: {
      kind: parsed.identity.kind,
      ...(parsed.identity.isin !== undefined && { isin: parsed.identity.isin }),
      ...(parsed.identity.exchangeMic !== undefined && {
        exchangeMic: parsed.identity.exchangeMic,
      }),
      ...(parsed.identity.symbol !== undefined && { symbol: parsed.identity.symbol }),
    },
    private: parsed.private,
    listingCurrency: parsed.listingCurrency,
    displayName: parsed.displayName,
    primaryIdentifier: parsed.primaryIdentifier,
    quotePolicy: parsed.quotePolicy,
    status: parsed.status,
    ...(parsed.figi !== undefined && { figi: parsed.figi }),
    ...(parsed.sectorCode !== undefined && { sectorCode: parsed.sectorCode }),
    ...(parsed.industryLabel !== undefined && { industryLabel: parsed.industryLabel }),
    ...(parsed.domicileCountry !== undefined && { domicileCountry: parsed.domicileCountry }),
    ...(parsed.managementCompany !== undefined && {
      managementCompany: parsed.managementCompany,
    }),
    ...(parsed.subscriptionFeePct !== undefined && {
      subscriptionFeePct: parseDecimalString(parsed.subscriptionFeePct),
    }),
    ...(parsed.providerMapping !== undefined && { providerMapping: parsed.providerMapping }),
    ...(parsed.icon !== undefined && { icon: parsed.icon }),
    manualPrices: parsed.manualPrices.map((price) => ({
      priceDate: price.priceDate,
      close: parseDecimalString(price.close),
      currency: price.currency,
    })),
    ...(parsed.watchlist !== undefined && { watchlist: draftWatchlist(parsed.watchlist) }),
  };
}

function draftPortfolio(
  parsed: KerdialCataloguePortfolio,
  at: CatalogueEntryRef,
): CataloguePortfolioEntry {
  return {
    at,
    name: parsed.name,
    ...(parsed.broker !== undefined && { broker: parsed.broker }),
    ...(parsed.description !== undefined && { description: parsed.description }),
    ...(parsed.accentColor !== undefined && { accentColor: parsed.accentColor }),
    ...(parsed.icon !== undefined && { icon: parsed.icon }),
    ...(parsed.archived !== undefined && { archived: parsed.archived }),
    cashAccounts: parsed.cashAccounts.map((account) => ({
      name: account.name,
      currency: account.currency,
      archived: account.archived,
    })),
  };
}

function draftFxRate(parsed: KerdialCatalogueFxRate, at: CatalogueEntryRef): CatalogueFxRateEntry {
  return {
    at,
    baseCurrency: parsed.baseCurrency,
    quoteCurrency: parsed.quoteCurrency,
    rateDate: parsed.rateDate,
    rate: parseDecimalString(parsed.rate),
  };
}

/**
 * The watchlist row, with its one figure turned into a {@link Decimal}.
 *
 * Every optional field in this module is written as
 * `...(value !== undefined && { key: value })`: "omitted when absent, never
 * `null`" has to survive into the draft, and a key holding `undefined`
 * is a *present* key — `Object.hasOwn` says so, and so does `JSON.stringify`
 * on the way back out. The tests check it with `Object.hasOwn` rather than with
 * `toBeUndefined`, which cannot tell the two apart.
 */
function draftWatchlist(
  parsed: NonNullable<KerdialCatalogueInstrument["watchlist"]>,
): CatalogueWatchlist {
  return {
    ...(parsed.targetPrice !== undefined && {
      targetPrice: parseDecimalString(parsed.targetPrice),
    }),
    ...(parsed.note !== undefined && { note: parsed.note }),
  };
}

/** The one exported value of this module. `formatKey` is data, not a label: it is what the route and the summary name the format by. */
export const kerdialCatalogueImporter: CatalogueImporter = {
  formatKey: "kerdial-json",
  supportedFileTypes: [KERDIAL_CATALOGUE_FILE_TYPE],
  parse,
  validate,
};
