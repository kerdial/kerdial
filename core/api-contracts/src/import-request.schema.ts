import { z } from "zod";
import { exchangeMicSchema, INSTRUMENT_KIND_VALUES } from "./instrument-create.schema.js";
import { portfolioNameSchema } from "./portfolio-name.schema.js";

/**
 * `POST /imports/instruments` and `POST /imports/transactions` — the
 * multipart field schema and the response shape (CI-16).
 *
 * Here, and not in `api/src/imports/`, for the reason
 * `transaction-create.schema.ts` and `instrument-create.schema.ts` already
 * record: `web` validates the request against the same object the API does, so
 * the two cannot drift. `web` may import `core/*` and nothing else
 * (`.dependency-cruiser.cjs`'s `web-no-server-runtime-imports`).
 *
 * **Nothing here imports `@kerdial/importer`, and the vocabularies below are
 * therefore declared a second time by value.** `importer` depends on this
 * package (`importer/package.json`), so the reverse edge would be a package
 * cycle. This is the same "declared twice by value" convention
 * `discovery.schema.ts`'s `DISCOVERY_RESPONSE_MAX_ITEMS` uses across the
 * `api`/`market/adapters` boundary. The pairs are asserted equal by
 * `api/src/imports/imports.schema.test.ts`, which may import both sides — a
 * drift is a red test, not a silent divergence.
 *
 * Every field below is a **string** on the wire: `multipart/form-data` has no
 * types. `mode`, `fileType` and the two ids are plain string fields; the one
 * structured field, `resolutions`, is a JSON document carried as a string,
 * decoded by {@link jsonArrayField} rather than by
 * the controller.
 */

/** A dry run reports what *would* happen and writes nothing; an apply writes. */
export const IMPORT_MODES = ["DRY_RUN", "APPLY"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];
export const importModeSchema = z.enum(IMPORT_MODES);

/**
 * The file types, declared once for the response and split per route for the
 * request: `…/instruments` implies `ASSETS` (the route *is* the file type),
 * and `…/transactions` requires the caller to say which of the two
 * transaction files it is — NG3, "no automatic file-type detection", means the
 * user always says.
 *
 * **The last two are the `portfolio-export-import` cycle's own two packages**
 * (one per new route). They are the by-value mirror of `importer/src/types.ts`'s
 * `ImportFileType`, asserted equal by
 * `importer/src/import-file-types.mirror.test.ts` — added once it turned out
 * that the mirror the module header above promises was guarded by a test file
 * that did not exist.
 *
 * **That test lives on the `importer` side of the edge, not beside this tuple,
 * and the module header above is the reason**: `importer` depends on this
 * package, so a test here that imported `@kerdial/importer` would be the
 * package cycle this file exists to avoid. Only one of the two sides can see
 * both, and it is that one.
 *
 * Widening this tuple is deliberately a **compile error** in `web`, not a blank
 * card: `IMPORT_FILE_TYPE_LABELS` and `IMPORT_FILE_TYPE_DESCRIPTIONS` are
 * `Record<ImportFileTypeName, string>`, so the UI cycle that adds the two cards
 * is told by the compiler exactly which copy is missing.
 */
export const IMPORT_FILE_TYPES = [
  "ASSETS",
  "CASH_ACCOUNT_TRANSACTIONS",
  "INVESTMENT_ACCOUNT_TRANSACTIONS",
  "KERDIAL_TRANSACTIONS",
  "KERDIAL_CATALOGUE",
] as const;
export type ImportFileTypeName = (typeof IMPORT_FILE_TYPES)[number];

export const TRANSACTION_IMPORT_FILE_TYPES = [
  "CASH_ACCOUNT_TRANSACTIONS",
  "INVESTMENT_ACCOUNT_TRANSACTIONS",
] as const;

/**
 * How far a label derived from a free-text cell is allowed to echo the user's
 * own file — {@link ImportRowSourceResponse.instrument} and
 * {@link ImportInstrumentResolution.label}.
 *
 * Declared here, above both, rather than next to the response interface it was
 * written for: {@link importInstrumentResolutionSchema} applies it as a `z.max`
 * at module-evaluation time, and a `const` used before its own declaration is a
 * TDZ `ReferenceError` on import, not a hoisted value.
 */
export const IMPORT_ROW_SOURCE_LABEL_MAX = 48;

/**
 * The confirm's echo-back. A dry run over an asset-catalogue file *proposes* a kind
 * and an exchange per row; the confirm re-submits the list the user reviewed,
 * and that is what makes the apply pass issue **zero** provider calls.
 *
 * `micSource` is carried for display only and is never a decision input on
 * apply — an `exchangeMic` that arrives here has been through the user, which
 * is exactly the confirmation `market/ports` requires before a provider-derived
 * MIC may be persisted.
 *
 * **`kindSource`, `nameSuggestsFund` and `label` are the same kind of field for
 * the kind, and equally display-only.** A dry run proposes `kind` from
 * rule K, which under-classifies: a real fund whose source row carries no
 * expense ratio is proposed `SHARE`. That was always documented and always
 * overridable, but the review step had no way to say which rows were guesses,
 * and `instrument.kind` is granted to `app_owner` only — so an accepted default
 * is a write neither the UI nor the API can correct later. `kindSource` carries
 * the provenance, `nameSuggestsFund` carries the one independent signal that a
 * default is likely wrong, and `label` is what makes either of them actionable:
 * the review table addressed rows by line number alone, so "line 36's kind is a
 * guess" sent the user back to the source file to find out which holding that
 * was.
 *
 * **`exchangeMic` is {@link exchangeMicSchema}, the *same* constant
 * `POST /instruments` enforces — imported, never re-typed**. This field
 * used to be a bare `z.string().nullable()`, which made the import path the
 * only writer into the shared `instrument` catalogue with no shape gate at all:
 * `exchange_mic` is `char(4)`, so Postgres accepts and pads anything of four
 * characters or fewer (`'ab'`, `'x<>'`, and `'  '`, which even survives
 * `createInstrumentByIsin`'s non-empty guard as a blank). Only five characters
 * or more errored. Because `instrument` has no `tenant_id` and no RLS, one
 * authenticated request could put a junk listing for a real ISIN in front of
 * every tenant — and a duplicate listing makes `plan`'s `resolveTransactionInstrument`
 * report `INSTRUMENT_AMBIGUOUS` for any tenant importing that ISIN. A malformed
 * value is now a `400` on the `resolutions` field, at the same boundary and by
 * the same rule as the manual creation path.
 */
/**
 * The kinds a CSV import may propose and a review step may confirm — every
 * kind except `SCPI` (SCD-14, FR-622: the Portfolio Performance
 * importer never creates or infers an SCPI). Derived from
 * `INSTRUMENT_KIND_VALUES` rather than listed, so a later *listed* kind still
 * widens it; an SCPI echoed back on the confirm is a `400`, and the review
 * editor builds its options from this same list.
 */
export const importableInstrumentKindSchema = z.enum(INSTRUMENT_KIND_VALUES).exclude(["SCPI"]);

export const importInstrumentResolutionSchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.enum(["CREATE", "SKIP"]),
  kind: importableInstrumentKindSchema,
  kindSource: z.enum(["EXPENSE_RATIO", "DISCOVERY", "DEFAULT", "USER"]),
  nameSuggestsFund: z.boolean(),
  exchangeMic: exchangeMicSchema.nullable(),
  micSource: z.enum(["SUFFIX_TABLE", "DISCOVERY", "USER"]),
  matchQuality: z.enum(["EXACT", "PROBABLE"]).nullable(),
  /**
   * Symbol, else ISIN, else display name — the same identity
   * {@link ImportRowSourceResponse.instrument} carries for a non-imported row,
   * built by the same truncation at the same response boundary, and `null` for a
   * row that carried none of the three. Echoed back on the confirm and read by
   * nothing: the apply pass uses `action`, `kind` and `exchangeMic` only.
   * Bounded here because it originates in a free-text cell of the user's file.
   */
  label: z.string().max(IMPORT_ROW_SOURCE_LABEL_MAX).nullable(),
});

export type ImportInstrumentResolution = z.infer<typeof importInstrumentResolutionSchema>;

/**
 * A multipart *string* field carrying a JSON array. Decoded here rather than in
 * the controller so a malformed document is a per-field 400 with the field's
 * own name on it, exactly like every other validation failure, instead of a
 * `SyntaxError` escaping as a 500.
 */
function jsonArrayField<T extends z.ZodTypeAny>(element: T) {
  return z
    .string()
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be a JSON document" });
        return z.NEVER;
      }
    })
    .pipe(z.array(element));
}

/**
 * `POST /imports/instruments`. `fileType` is absent by
 * design (the route implies `ASSETS`), and `resolutions` is required exactly
 * on `APPLY`: a confirm states which rows the user reviewed, so a confirm that
 * omits the field entirely is a request that was never formed.
 *
 * **Required means *present*, and an empty array is a legitimate value** —
 * `proposals` carries only the rows a dry run would `CREATE`, so a file whose
 * every row is already in the catalogue, and a dry run whose discovery budget
 * ran out before any row resolved, both legitimately produce `[]`. What used to
 * make the empty case dangerous was not the schema but the pipeline reading
 * `resolutions.length > 0` as "this is a confirm"; that inference is gone
 * (`instrument-resolution.ts`'s `fromConfirmedResolution`), and confirm
 * mode is now the request's `mode`. An `APPLY` with `[]` therefore writes
 * nothing, issues no provider call, and reports every row
 * `RESOLUTION_NOT_CONFIRMED`.
 */
export const importInstrumentsFieldsSchema = z
  .object({
    mode: importModeSchema,
    resolutions: jsonArrayField(importInstrumentResolutionSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "APPLY" && value.resolutions === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["resolutions"],
        message:
          "required when mode is APPLY: the confirm re-submits the resolutions the dry run proposed, which is what makes it issue no provider call",
      });
    }
  });

export type ImportInstrumentsFields = z.infer<typeof importInstrumentsFieldsSchema>;

/**
 * `security-transfer` FR-583: the user's answer to one
 * {@link ImportTransferDecisionResponse} — "the units this row moved out went
 * to the portfolio named `portfolioName`". An existing portfolio is matched by
 * its exact name; any other name is created, bare, by the import (L4).
 *
 * **By name, not by id**, and that is L4's own wording: the target is "named at
 * import and created by name if absent", so one field serves both an existing
 * portfolio and a new one, exactly as a Kerdial row's own `portfolio` cell
 * does. The name is {@link portfolioNameSchema}, imported rather than re-typed,
 * so an answer this field accepts is one `createPortfolio` accepts too.
 *
 * `index` is the row's {@link ImportRowOutcomeResponse.index}. What makes a
 * list of these *well formed* beyond each element's shape — an index that is a
 * source-leg transfer row of this file, no index twice, never the request's
 * own portfolio — is decided by `planImport`, which alone knows the file, and
 * refused there as `IMPORT_REQUEST_INVALID` (400).
 */
export const importTransferDestinationSchema = z.object({
  index: z.number().int().nonnegative(),
  portfolioName: portfolioNameSchema,
});

export type ImportTransferDestination = z.infer<typeof importTransferDestinationSchema>;

/**
 * `POST /imports/transactions`. Both ids are required
 * on both modes: a dry run resolves each row's instrument and computes each
 * row's fingerprint against the destination it would be written to, so a dry
 * run without one would report counts for an import nobody could confirm.
 *
 * `transferDestinations` (`security-transfer` FR-583) is the **resolutions
 * precedent** applied to a second decision: a JSON document carried as a
 * string, optional on both modes, and **absent means every source-leg
 * transfer row is written alone** (Step A, L4) — a transfer out of Kerdial.
 * Unlike `resolutions` it is not required on `APPLY`: leaving every row
 * unanswered is a legitimate answer. That is exactly why a client must echo it
 * on every `APPLY` of one import, the automatic continuation included: a
 * re-post that dropped it would silently write the remaining rows alone.
 */
export const importTransactionsFieldsSchema = z.object({
  mode: importModeSchema,
  fileType: z.enum(TRANSACTION_IMPORT_FILE_TYPES),
  portfolioId: z.uuid(),
  cashAccountId: z.uuid(),
  transferDestinations: jsonArrayField(importTransferDestinationSchema).optional(),
});

export type ImportTransactionsFields = z.infer<typeof importTransactionsFieldsSchema>;

/**
 * `POST /imports/kerdial/transactions` and `POST /imports/kerdial/catalogue` —
 * their field set differs from the Portfolio-Performance routes' in exactly
 * two respects, both deliberate:
 *
 *  - **`portfolioId`/`cashAccountId` are absent by design.** A Kerdial CSV
 *    names its own portfolio and cash account **per row** (FR-532/FR-533)
 *    and a catalogue package carries whole portfolios; there is
 *    no single destination for the caller to choose, so asking for one would
 *    be asking for a value nothing reads.
 *  - **`fileType` is absent too**, for the asset route's reason applied to two
 *    more routes: the route *is* the file type (NG3).
 *
 * **`resolutions` is optional on both modes, and that is a decision with a
 * date on it (2026-09-24) rather than an omission.** It was originally
 * required on `APPLY` for both routes, on the grounds that "the catalogue
 * route creates instruments too, and the empty-confirm lesson applies
 * identically". Neither half of that holds as measured at implementation:
 * `planCatalogue`'s context has no `resolutions` member and a catalogue plan
 * makes no proposals (it decides create-vs-match from the document's own
 * identity and `private` fields), and a Kerdial transactions row carries no
 * `kind` and no listing currency, so an unresolved identity can only be
 * `INSTRUMENT_NOT_RESOLVED` and never a proposal. That lesson's actual
 * content — that the *mode*, not `resolutions.length`, decides whether a pass
 * may write — is already structural on both paths.
 *
 * So the field is **read by nothing** on these two routes, and requiring a
 * confirm to carry a value nothing reads would make the web client send a dead
 * field. It stays in the schema, and `[]`
 * stays legal, so the day a Kerdial proposal channel exists there is no wire
 * change to make — but its absence is not a malformed request.
 *
 * **The two Portfolio-Performance routes are unchanged**:
 * {@link importInstrumentsFieldsSchema} still requires it on `APPLY`, because
 * there it genuinely is the confirm — a PP asset row *does* produce proposals,
 * and the empty-confirm failure was real on that path.
 *
 * **One schema, two routes.** The two Kerdial routes take *identical* field
 * sets, so two field schemas would be two by-value copies of one object with
 * nothing to drift against — the exact failure this module's own header
 * spends a paragraph on. Split it the day the two routes' fields stop
 * agreeing.
 */
export const importKerdialFieldsSchema = z.object({
  mode: importModeSchema,
  resolutions: jsonArrayField(importInstrumentResolutionSchema).optional(),
});

export type ImportKerdialFields = z.infer<typeof importKerdialFieldsSchema>;

/** One non-imported row, with the single named reason assigned to it. IMP-AC-13 forbids a bare "invalid row". */
/**
 * What the offending row actually *said*, so a reason code becomes findable in
 * the user's own file.
 *
 * A line number alone was not enough in practice: « ligne 95 — ce type de ligne
 * n'est pas géré » does not tell you which holding it was about, and the file
 * has hundreds of rows. This carries the few fields that identify a row to the
 * person who exported it.
 *
 * **Structured, not a rendered sentence.** The server never formats this — the
 * neutral pipeline is forbidden from knowing any format's vocabulary
 * (`import-vocabulary-gate`), and the UI is French while the pipeline is not.
 * `web`'s `formatImportRowSource` does the rendering.
 *
 * **Bounded.** `instrument` is truncated server-side. It is the one field
 * derived from a free-text cell, and the security review's INFO-8 flagged
 * unbounded echoes of file content as the thing to avoid before anything
 * rendered them — this is the first surface that does.
 */
export interface ImportRowSourceResponse {
  /**
   * The last three are the shapes only a Kerdial transactions file produces
   * — the ledger kinds the
   * Portfolio-Performance export has no representation for at all. Widened
   * here, at the wire, because a Kerdial row that did not import is reported
   * through this same descriptor and describing it as one of the other five
   * would be a false statement about the user's own file.
   *
   * Nothing in `web` switches exhaustively on this member
   * (`formatImportRowSource` is field-driven and reads `shape` in exactly one
   * branch, for `INSTRUMENT`), so the widening is additive there — MEASURED,
   * `web/src/lib/import-copy.ts`.
   */
  readonly shape:
    | "INSTRUMENT"
    | "CASH_MOVEMENT"
    | "DIVIDEND"
    | "TRADE"
    | "DISTRIBUTION"
    | "CURRENCY_EXCHANGE"
    | "SETTLED_TRADE"
    | "DRIP"
    /** `security-transfer` — units in or out with a market value; carries both figures, as a distribution does. */
    | "TRANSFER"
    /** `cash-interest` — interest earned on cash: a date, the gross and its currency, no instrument. */
    | "INTEREST"
    /** `portfolio-cash` — a standalone portfolio fee: a date, the amount and its currency, the instrument it references if any. */
    | "FEE";
  /** ISO `YYYY-MM-DD`. Absent on an instrument row, which carries no date. */
  readonly tradeDate: string | null;
  readonly direction: "IN" | "OUT" | "ACQUIRE" | "DISPOSE" | null;
  /** Symbol, else ISIN, else display name — whichever the row actually carried. Truncated. */
  readonly instrument: string | null;
  /**
   * Decimal string; the money leg, or the instrument row's absence of one.
   *
   * A `DISTRIBUTION` is the one shape that carries this **and**
   * {@link quantity}: free shares have a count and a market value, and neither
   * describes the row on its own.
   */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly quantity: string | null;
}

export interface ImportRowOutcomeResponse {
  /** 1-based line in the file (the header is line 1) — what the user sees in their own editor. */
  readonly line: number;
  /** 0-based index among data rows: the stable key `resolutions[]` and the review table address rows by. */
  readonly index: number;
  readonly outcome: "SKIP" | "REJECT";
  readonly reason: string;
  readonly message: string;
  /**
   * `null` for a row rejected during `parse` — there is no neutral row to
   * describe, because failing to produce one is precisely what happened. Those
   * rows already name the offending cell in {@link message}.
   */
  readonly source: ImportRowSourceResponse | null;
}

/**
 * `security-transfer` FR-583: one source-leg transfer row a
 * dry run would write, with the destination question it leaves open.
 *
 * **A decision, not an outcome**: the row's outcome is `IMPORT` whatever the
 * answer — answering changes the write (one leg or a linked pair), never the
 * counts — so it is reported beside {@link ImportRowOutcomeResponse}, not as
 * one. The figures are decimal strings and `instrument` is the same bounded
 * label {@link ImportRowSourceResponse.instrument} carries.
 */
export interface ImportTransferDecisionResponse {
  /** The key {@link ImportTransferDestination.index} answers by. */
  readonly index: number;
  /** 1-based line in the file, for display. */
  readonly line: number;
  readonly tradeDate: string;
  readonly instrumentId: string;
  readonly instrument: string | null;
  readonly quantity: string;
  readonly marketValue: string;
  readonly currency: string;
}

/**
 * One non-imported **catalogue entry**, the JSON package's counterpart to
 * {@link ImportRowOutcomeResponse}.
 *
 * **A separate shape, and that is a measurement rather than a preference.** A
 * catalogue entry has no line: the document is JSON, and an entry is addressed
 * by its section and its 0-based index within it (`CatalogueEntryRef`, MEASURED,
 * `importer/src/formats/kerdial-json/index.ts`). Reusing
 * {@link ImportRowOutcomeResponse} would have meant inventing a `line` for
 * every entry and a `source` descriptor built out of a row vocabulary a
 * catalogue has none of — two fabricated fields, on the response whose whole
 * job is to tell the user where in their own file to look.
 *
 * The **counts** are not duplicated: `imported`/`skipped`/`rejected`/`byReason`
 * on the envelope are the same fields, filled by the same summariser, for both
 * packages. Only the addressing differs, which is the whole of the difference.
 */
export interface ImportEntryOutcomeResponse {
  /**
   * Which array of the document the entry came from.
   *
   * Spelled out by value for the reason this module's header gives — `importer`
   * depends on this package, so naming its `CatalogueSection` here would be the
   * package cycle — and **guarded by the compiler rather than by a second drift
   * test**: `api/src/imports/imports.schema.ts` assigns a `CatalogueSection`
   * straight into this field, so a member added on that side and not here is a
   * type error at the assignment, in the same build.
   */
  readonly section: "instruments" | "portfolios" | "fxRatesUser";
  /** 0-based within {@link section} — the stable key the UI addresses entries by. */
  readonly index: number;
  readonly outcome: "SKIP" | "REJECT";
  readonly reason: string;
  readonly message: string;
}

/**
 * One warning on a catalogue entry that **imports** — e.g.
 * `ISIN_CHECK_DIGIT_MISMATCH`. Addressed exactly like
 * {@link ImportEntryOutcomeResponse}, and never counted in `byReason`,
 * `rejected` or `skipped`: those say what was not written, and this entry was.
 */
export interface ImportEntryWarningResponse {
  readonly section: ImportEntryOutcomeResponse["section"];
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

/**
 * The import response body, returned with `200 OK` and `application/json` for **both**
 * modes, including a partial success.
 *
 * `application/problem+json` is reserved for whole-request failures (a
 * malformed upload, an unknown or archived destination, a file over the byte
 * or row cap, a throttled request). A file in which some rows did not import is
 * not one of those: the request succeeded, and this body says precisely what
 * happened to every row. A partial success is not an error response.
 */
export interface ImportSummaryResponse {
  readonly mode: ImportMode;
  readonly fileType: ImportFileTypeName;
  readonly rowCount: number;
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
  /** Grouped counts by reason code — what the review step renders as the summary. */
  readonly byReason: Readonly<Record<string, number>>;
  /** Per-row detail, one entry per non-imported row, capped. Empty for the catalogue route, which reports {@link entries} instead. */
  readonly rows: readonly ImportRowOutcomeResponse[];
  /**
   * `true` when the detail list — {@link rows}, or {@link entries} on the
   * catalogue route — was cut at the cap. The counts above are **never**
   * truncated with it.
   *
   * One flag for both lists rather than two, because no response ever carries
   * both: a route reports rows or entries, never a mixture, and a second flag
   * would exist only to be `false`.
   */
  readonly rowsTruncated: boolean;
  /**
   * `POST /imports/kerdial/catalogue` only — the per-entry counterpart of
   * {@link rows}. Absent on every
   * other route, where there are no entries to report.
   */
  readonly entries?: readonly ImportEntryOutcomeResponse[];
  /**
   * `POST /imports/kerdial/catalogue` only — warnings on entries that imported,
   * capped at the same per-entry detail bound as
   * {@link entries}. {@link warningCount} is the uncapped total, so
   * `warningCount > warnings.length` means the list was cut. A warning never
   * blocks the confirm.
   */
  readonly warnings?: readonly ImportEntryWarningResponse[];
  readonly warningCount?: number;
  /**
   * `POST /imports/kerdial/catalogue` only — what the document carried, per
   * section, so the UI can say « 12 instruments, 3 portefeuilles, 480 prix
   * manuels » without a second vocabulary.
   *
   * The keys are the export's own section names
   * (`CatalogueExportCounts`, `api/src/exports/exports.reads.ts`), so the file
   * a user downloaded and the summary of importing it back are counted the same
   * way. A count here is **what the file carried**, not what was written —
   * `imported`/`skipped`/`rejected` are what was written, and conflating the
   * two is how a summary starts disagreeing with itself.
   */
  readonly sections?: Readonly<Record<string, number>>;
  /**
   * `POST /imports/kerdial/catalogue` only — how many existing
   * instruments of the **shared** catalogue the import changes, and how many
   * of those lose their automated price series to a corrected provider
   * mapping. Computed by the plan, so a dry run and its confirm report the
   * same figures.
   */
  readonly sharedCatalogueImpact?: {
    readonly instrumentsModified: number;
    readonly priceHistoriesDiscarded: number;
  };
  /** Asset-catalogue dry runs only: the per-row proposals the confirm echoes back. */
  readonly proposals?: readonly ImportInstrumentResolution[];
  /**
   * `security-transfer` FR-583 — investment-file dry runs only, and only when
   * the file has one: every source-leg transfer row this import would write,
   * each asking where its units went. The confirm answers them in
   * `transferDestinations`; an unanswered one is written alone (Step A).
   */
  readonly transferDecisions?: readonly ImportTransferDecisionResponse[];
  /** Non-zero means the dry run's counts and this run's cannot be expected to agree. */
  readonly applyFailed: number;
  readonly applyNotAttempted: number;
  /** The confirm's decisive property (no provider calls), made observable to the client: 0 on a confirm. */
  readonly discoveryCallsIssued: number;
}
