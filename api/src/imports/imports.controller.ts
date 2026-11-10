import { Controller, HttpCode, Inject, Post, Req, UseInterceptors } from "@nestjs/common";
import {
  importInstrumentsFieldsSchema,
  importKerdialFieldsSchema,
  importTransactionsFieldsSchema,
  type ImportInstrumentResolution,
  type ImportSummaryResponse,
  type ImportTransferDestination,
} from "@kerdial/api-contracts";
import {
  CatalogueFileError,
  ImportFileError,
  ImportPlanRequestError,
  KERDIAL_CATALOGUE_FILE_TYPE,
  KERDIAL_TRANSACTIONS_FILE_TYPE,
  applyCatalogue,
  applyDeadlineAt,
  applyImport,
  kerdialCatalogueImporter,
  kerdialCsvImporter,
  planCatalogue,
  planImport,
  portfolioPerformanceImporter,
  systemClock,
  type AnyImportFileType,
  type AnyNeutralRow,
  type CatalogueEnrolmentCandidate,
  type CatalogueImportResult,
  type CatalogueParseResult,
  type CataloguePlan,
  type CsvImporter,
  type ImportLimits,
  type ImportPlan,
  type ImportResult,
  type KerdialJsonLimits,
  type ParseResult,
} from "@kerdial/importer";
import {
  CashAccountArchivedError,
  CashAccountNotFoundError,
  listCashAccountsWithBalances,
} from "@kerdial/ledger";
import {
  providerKeyForBackfill,
  routedProviderKeys,
  type MarketRuntime,
} from "@kerdial/market-composition";
import type { SessionContext } from "@kerdial/platform-auth";
import { rootLogger } from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import type { FastifyRequest } from "fastify";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { kerdialImportThrottleInterceptor } from "../common/kerdial-import-throttle.interceptor.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import { createTransactionWriteServiceForTenant } from "../transactions/transaction-write-service.factory.js";
import { mapTransactionWriteError } from "../transactions/write-error.mapper.js";
import { createCatalogueIconValidator } from "./catalogue-icon-validator.port.js";
import { importDiscoveryPortFor } from "./import-discovery.port.js";
import {
  IMPORT_LIMITS,
  KERDIAL_CSV_IMPORT_LIMITS,
  KERDIAL_JSON_IMPORT_LIMITS,
} from "./import-limits.tokens.js";
import { toCatalogueSummaryResponse, toImportSummaryResponse } from "./imports.schema.js";
import { readImportUpload } from "./multipart.js";

/**
 * `POST /imports/instruments` and `POST /imports/transactions` —
 * ID9/ID10/ID11, CI-16/CI-18/CI-19
 * — plus `POST /imports/kerdial/transactions` and
 * `POST /imports/kerdial/catalogue` (KD5, EI-26/EI-27).
 *
 * **Four routes, one controller, and that is the point**: the two Kerdial
 * routes join this class rather than getting their own so that the reuse of
 * `#run`/`#mapPipelineError`/`toImportSummaryResponse` is *literal*. A second
 * controller would have been a second copy of the envelope, the deadline
 * arithmetic and the error table, each free to drift from this one.
 *
 * All four are `multipart/form-data`, all four are session- and CSRF-guarded by the
 * global `APP_GUARD`s with no per-route opt-in (matching every other
 * controller), and all four sit behind the one instance-wide admission bound
 * (`APP_INTERCEPTOR`/ADR-0016).
 *
 * **The two Kerdial routes carry one cap of their own, and it is the only
 * per-route throttle on this surface** (security review M3):
 * {@link kerdialImportThrottleInterceptor}, concurrency 1, shared by both. It is
 * not a re-introduction of the per-tenant ceilings ADR-0016 retired — those
 * were a *fairness* control between tenants, and this one prices the 96–160 MiB
 * an in-flight 32 MiB import allocates, which the admission bound (sized for
 * requests holding one pooled connection) cannot. The
 * export-import feature named this exact remedy and named FR-554's escape clause as its
 * authority; the file's own header carries the arithmetic.
 *
 * The two Portfolio-Performance routes deliberately do **not** join it: their
 * `maxFileBytes` is 1 MiB, two orders of magnitude below the shape M3 measured,
 * and widening the bucket to them would throttle a cheap route for a cost it
 * does not have. FR-554/SD-13 is still honoured as stated — nothing existing is
 * loosened, bypassed or duplicated.
 *
 * ## No business logic here, and rather less than usual
 *
 * Every decision — parsing, the neutral row vocabulary, instrument resolution,
 * the fingerprint, the write order, the apply deadline — lives in
 * `@kerdial/importer`. This controller reads a multipart body, validates its
 * fields, resolves the destination, and formats the summary. The one thing it
 * *does* own is the boundary `importer` structurally cannot cross:
 * {@link importDiscoveryPortFor} binds `ImportDiscoveryPort` to the real
 * `MarketRuntime.discovery`, which is the only way a provider call enters the
 * import pipeline (ID1, enforced by `.dependency-cruiser.cjs`'s
 * `importer-no-market`).
 *
 * ## The envelope, and what is *not* in it
 *
 * A partial success is `200 OK` with per-row outcomes in `rows[]` — the
 * request succeeded, some rows did not.
 * `application/problem+json` is reserved for whole-request failures: a
 * malformed or missing upload (`400`), a header that is not this format's
 * (`400`), an unknown portfolio or cash account (`404`), an already-archived
 * destination (`409`), a file over the byte or row cap (`413`), a throttled
 * request (`429`). This is a deliberate deviation from a literal
 * reading of the original wording, whose phrasing reads as if a partial
 * success were an error response.
 *
 * ## One error mapper, reused
 *
 * F-D: a cash account archived between the dry run and the confirm reaches
 * the write path as `CashAccountArchivedError` and must answer `409
 * CASH_ACCOUNT_ARCHIVED` exactly as it does for a manual write. So this
 * controller calls `mapTransactionWriteError` — the same table
 * `TransactionsController` calls — and writes no second mapper. The
 * *mid-apply* archive is a different case and is deliberately not an error at
 * all here: `applyImport` absorbs it per row, so the rows that landed before
 * the archive are reported imported and the ones after it `APPLY_FAILED`, in
 * one `200` summary, rather than the whole request being presented as failed
 * and the committed rows disappearing from it.
 */
@Controller("imports")
export class ImportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
    @Inject(IMPORT_LIMITS) private readonly limits: ImportLimits,
    @Inject(KERDIAL_CSV_IMPORT_LIMITS) private readonly kerdialCsvLimits: ImportLimits,
    @Inject(KERDIAL_JSON_IMPORT_LIMITS) private readonly kerdialJsonLimits: KerdialJsonLimits,
  ) {}

  /**
   * `POST /imports/instruments` — the asset-catalogue file. `fileType` is
   * implicit (`ASSETS`): the route *is* the file type, so there is nothing to
   * detect and nothing to declare (NG3).
   *
   * A `DRY_RUN` is where discovery runs; the `APPLY` echoes the dry run's
   * `resolutions[]` back and issues **zero** provider calls. The
   * response's own `discoveryCallsIssued` is how a caller checks that rather
   * than taking it on trust.
   */
  @Post("instruments")
  @HttpCode(200)
  async importInstruments(
    @Req() request: FastifyRequest,
    @CurrentSession() session: SessionContext,
  ): Promise<ImportSummaryResponse> {
    const startedAt = new Date();
    // KD14 — the plugin is registered at the maximum over every import
    // path, so this route's own 1 MiB ceiling is re-imposed here, per request.
    const upload = await readImportUpload(request, { maxFileBytes: this.limits.maxFileBytes });
    const fields = parseOrThrow(importInstrumentsFieldsSchema, upload.fields);

    const validated = this.#parse(
      portfolioPerformanceImporter,
      upload.bytes,
      "ASSETS",
      this.limits,
    );
    return this.#run({
      startedAt,
      session,
      validated,
      limits: this.limits,
      mode: fields.mode,
      destination: null,
      resolutions: fields.resolutions ?? [],
    });
  }

  /**
   * `POST /imports/transactions` — either transaction file, into one portfolio
   * and one cash account.
   *
   * Both ids are required in **both** modes, not only on the apply: each row's
   * instrument is resolved and each row's idempotency fingerprint is computed
   * against the destination it would be written to (`cashAccountId` sits
   * in the hash), so a dry run without one would report counts for an import
   * nobody could confirm.
   */
  @Post("transactions")
  @HttpCode(200)
  async importTransactions(
    @Req() request: FastifyRequest,
    @CurrentSession() session: SessionContext,
  ): Promise<ImportSummaryResponse> {
    const startedAt = new Date();
    const upload = await readImportUpload(request, { maxFileBytes: this.limits.maxFileBytes });
    const fields = parseOrThrow(importTransactionsFieldsSchema, upload.fields);

    await this.#assertDestinationUsable(session.tenantId, fields.portfolioId, fields.cashAccountId);

    const validated = this.#parse(
      portfolioPerformanceImporter,
      upload.bytes,
      fields.fileType,
      this.limits,
    );
    return this.#run({
      startedAt,
      session,
      validated,
      limits: this.limits,
      mode: fields.mode,
      destination: { portfolioId: fields.portfolioId, cashAccountId: fields.cashAccountId },
      resolutions: [],
      // `security-transfer` FR-583: where each source-leg transfer's units
      // went, as the user answered it on the review step. Absent is `[]`:
      // every such row is written alone (Step A).
      transferDestinations: fields.transferDestinations ?? [],
    });
  }

  /**
   * `POST /imports/kerdial/transactions` — this product's **own** transactions
   * package, the one `GET /exports/transactions` writes.
   *
   * **No `portfolioId`, no `cashAccountId`, and that is the shape of the
   * feature rather than an omission**: a Kerdial row names its own portfolio
   * and cash account (FR-532/FR-533), so there is no single
   * destination to pick — and a file spanning four portfolios could not be
   * described by one. `destination: null` is what tells `planImport` to read
   * each row's own names, and `tenantId` below is what lets the apply create a
   * portfolio or a cash account the file names and the tenant does not have
   * (FR-556/AC-448).
   *
   * **No `fileType` either**: the route is the file type (NG3), as it is for
   * `…/imports/instruments`.
   *
   * Everything after the parse is the **same code path** the two
   * Portfolio-Performance routes take — `#run`, `#mapPipelineError`,
   * `toImportSummaryResponse` — which is what makes FR-204's "the same file
   * imported twice writes one transaction" true here by construction rather
   * than by a second implementation that has to be tested into agreement.
   */
  @UseInterceptors(kerdialImportThrottleInterceptor)
  @Post("kerdial/transactions")
  @HttpCode(200)
  async importKerdialTransactions(
    @Req() request: FastifyRequest,
    @CurrentSession() session: SessionContext,
  ): Promise<ImportSummaryResponse> {
    const startedAt = new Date();
    const upload = await readImportUpload(request, {
      maxFileBytes: this.kerdialCsvLimits.maxFileBytes,
    });
    const fields = parseOrThrow(importKerdialFieldsSchema, upload.fields);

    const validated = this.#parse(
      kerdialCsvImporter,
      upload.bytes,
      KERDIAL_TRANSACTIONS_FILE_TYPE,
      this.kerdialCsvLimits,
    );
    return this.#run({
      startedAt,
      session,
      validated,
      limits: this.kerdialCsvLimits,
      mode: fields.mode,
      destination: null,
      // MEASURED: a Kerdial transactions row carries identity
      // but no `kind` and no listing currency, so an unresolved instrument is
      // `INSTRUMENT_NOT_RESOLVED` and never a proposal — `plan.proposals` is
      // structurally empty for this file type and there is nothing for a
      // confirm to echo. The field is still *required* on APPLY by the wire
      // schema; it is forwarded here so that the day a proposal
      // channel exists, this line is already the one that carries it.
      resolutions: fields.resolutions ?? [],
    });
  }

  /**
   * `POST /imports/kerdial/catalogue` — the instruments/settings package
   * (KD5; FR-558/SD-15).
   *
   * **Its own plan and apply stages, not `#run`'s**: a catalogue
   * entry has no trade date, no idempotency fingerprint and no write batch, so
   * `planImport` refuses this file type outright rather than growing a third
   * write target whose every other field is `null`. What the two paths *do*
   * share is the envelope — one `200` with per-entity outcomes for a partial
   * success, `problem+json` for a whole-request failure — and the summariser
   * that counts them.
   *
   * **FR-557's enrolment happens here, after the apply returns** — see
   * {@link ImportsController.triggerCatalogueBackfills}.
   */
  @UseInterceptors(kerdialImportThrottleInterceptor)
  @Post("kerdial/catalogue")
  @HttpCode(200)
  async importKerdialCatalogue(
    @Req() request: FastifyRequest,
    @CurrentSession() session: SessionContext,
  ): Promise<ImportSummaryResponse> {
    const startedAt = new Date();
    const upload = await readImportUpload(request, {
      maxFileBytes: this.kerdialJsonLimits.maxFileBytes,
    });
    const fields = parseOrThrow(importKerdialFieldsSchema, upload.fields);

    const parsed = this.#parseCatalogue(upload.bytes);

    let plan: CataloguePlan;
    try {
      plan = await planCatalogue({
        db: this.db,
        tenantId: session.tenantId,
        draft: parsed.draft,
        problems: parsed.problems,
        // KD11's port: the icon rules live in `api`'s shipped validator, whose
        // eight ordered steps carry the measured base64 flat-length trap.
        // `importer` gets a verdict, never a decoder.
        icons: createCatalogueIconValidator(),
        // A mapping under a retired provider key (`coingecko`) is dropped.
        servedProviderKeys: new Set(routedProviderKeys()),
      });
    } catch (error) {
      throw this.#mapPipelineError(error);
    }

    if (fields.mode === "DRY_RUN") {
      return toCatalogueSummaryResponse({
        mode: "DRY_RUN",
        parsed,
        plan,
        result: null,
        maxEntityDetails: this.kerdialJsonLimits.maxEntityDetails,
      });
    }

    let result: CatalogueImportResult;
    try {
      result = await applyCatalogue({
        db: this.db,
        tenantId: session.tenantId,
        plan,
        // The deadline rule, unchanged: measured from the moment the **request**
        // arrived, because parse and plan have already spent part of the
        // handler's own budget by the time this line runs.
        deadlineAt: new Date(startedAt.getTime() + this.kerdialJsonLimits.applyDeadlineMs),
        clock: systemClock,
        chunkEntities: this.kerdialJsonLimits.applyChunkEntities,
      });
    } catch (error) {
      throw this.#mapPipelineError(error);
    }

    // FR-557/KD10 — **after** the writes have committed, never inside one.
    await this.triggerCatalogueBackfills(result.enrolmentCandidates);

    return toCatalogueSummaryResponse({
      mode: "APPLY",
      parsed,
      plan,
      result,
      maxEntityDetails: this.kerdialJsonLimits.maxEntityDetails,
    });
  }

  /**
   * FR-557/KD10 — enrol every instrument the catalogue apply
   * **created** in the backfill machinery.
   *
   * A JSON-created instrument has no transaction behind it, so nothing else
   * enrols it: `TransactionWriteService` triggers on a `record*` that never
   * happens here, and `reconcilePendingInstrumentBackfills` only sweeps
   * instruments that already have a state row. Without this loop, a restored
   * catalogue would sit with no price history and no job that would ever give
   * it one — which is precisely what AC-447 asserts against.
   *
   * Three properties, each the reason a simpler placement is wrong:
   *
   *  - **In `api`, never in `importer`.** `.dependency-cruiser.cjs`'s
   *    `importer-no-market` rule is `error`-severity, so a call from inside
   *    that package is a red `pnpm depcruise` rather than a review comment
   *    (re-confirmed at implementation with a scratch
   *    `import "@kerdial/market-composition"` in `catalogue-apply.ts`).
   *  - **After the apply's writes have committed.** `enqueueBackfill`
   *    publishes to `pg-boss`, and no queue operation may run
   *    inside an RLS transaction — the same reason `TransactionWriteService`
   *    defers its own trigger to the end of a batch.
   *  - **Best effort, per candidate.** Mirrors
   *    `InstrumentsController.#triggerInstrumentBackfill` verbatim, including
   *    the `providerKeyForBackfill(kind) === undefined` guard that keeps an
   *    unbackfillable kind from even attempting an enqueue (`SCPI`, by
   *    design — `scpi` cycle, SC-L10): an import that wrote 200
   *    entities must not be reported as failed because a queue was down, and
   *    the writes it made are already committed and correct.
   *
   * Public rather than `#private` for one reason, stated because a reader will
   * ask: the `#triggerInstrumentBackfill` it mirrors is private, and so was
   * this until a test needed to drive the swallow-and-log branch without
   * standing up a whole catalogue import to reach it.
   */
  async triggerCatalogueBackfills(
    candidates: readonly CatalogueEnrolmentCandidate[],
  ): Promise<void> {
    if (this.marketRuntime === null) return;

    for (const candidate of candidates) {
      if (providerKeyForBackfill(candidate.kind) === undefined) continue;
      try {
        await this.marketRuntime.enqueueBackfill(this.db, {
          instrumentId: candidate.id,
          kind: candidate.kind,
        });
      } catch (err) {
        rootLogger().error(
          "ImportsController#triggerCatalogueBackfills: best-effort backfill enrolment failed (FR-557/KD10) — swallowed; the catalogue writes are committed and reconcilePendingInstrumentBackfills is not a recovery path for an instrument that was never enrolled.",
          {
            component: "api",
            instrument_id: candidate.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  /**
   * The destination, checked once before any parsing — the `404`/`409` half of
   * the whole-request failures.
   *
   * **One read, and it is the shipped one.** `listCashAccountsWithBalances`
   * already answers both questions in a single statement and already returns
   * `undefined` for a portfolio this tenant cannot see (the same "another
   * tenant's row is indistinguishable from a nonexistent one" contract every
   * other route has). Re-deriving either rule here would be a second copy of a
   * tenancy check, which is the class of duplication that eventually disagrees.
   *
   * The two rejections are raised as `ledger`'s **own** error types and handed
   * to `mapTransactionWriteError`, rather than as hand-built
   * `problemException`s: that is what makes "an archived destination answers
   * `409 CASH_ACCOUNT_ARCHIVED`" one fact with one implementation, whether the
   * archive was already in place when the request arrived (here) or committed
   * mid-apply (F-D, absorbed per row by `applyImport`).
   *
   * This is a pre-check, not a guarantee: the account can be archived in the
   * gap between it and the writes. That race is exactly what F-D handles, and
   * the reason this check is worth making anyway is that without it an import
   * into an already-archived account would answer `200` with every row failed —
   * technically honest, and useless.
   */
  async #assertDestinationUsable(
    tenantId: string,
    portfolioId: string,
    cashAccountId: string,
  ): Promise<void> {
    const snapshot = await listCashAccountsWithBalances(this.db, { tenantId, portfolioId });
    if (snapshot === undefined) {
      throw problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
    }
    const account = snapshot.accounts.find((one) => one.id === cashAccountId);
    if (account === undefined) {
      throw mapTransactionWriteError(new CashAccountNotFoundError(cashAccountId, "cashAccountId"));
    }
    if (account.archived) {
      throw mapTransactionWriteError(new CashAccountArchivedError(cashAccountId, "cashAccountId"));
    }
  }

  /**
   * Bytes to validated rows, plus the row cap.
   *
   * The two failures here are the two `parse` is allowed to raise at all:
   * a header that is not this format's, and a file that cannot be read
   * as rows. Both are `400` whole-request failures — there are no rows to
   * report outcomes for. Every *row-level* failure is already inside the
   * result, because FR-53 requires the other rows of the same file to still be
   * reported.
   *
   * The row cap is applied **after** parsing and before anything touches a
   * database or a provider. Parsing is pure, synchronous and bounded by the
   * byte cap the transport already enforced, so counting the rows costs no
   * round trip; what the cap protects is everything downstream of it.
   */
  #parse<TRow extends AnyNeutralRow, TFileType extends AnyImportFileType>(
    importer: CsvImporter<TRow, TFileType>,
    bytes: Uint8Array,
    fileType: TFileType,
    limits: ImportLimits,
  ): ParseResult<TRow, TFileType> {
    let parsed: ParseResult<TRow, TFileType>;
    try {
      parsed = importer.parse({ bytes, fileType });
    } catch (error) {
      if (error instanceof ImportFileError) {
        // The same mapping for all five codes this class can carry: the two
        // Portfolio-Performance ones and the three `KERDIAL_CSV_*` ones
        // (a version line this build does not read, an unknown column, a
        // missing required column). Each is a whole-file refusal with no rows
        // to report outcomes for, which is what makes them a `400` and not a
        // `rows[]` entry.
        throw problemException(400, {
          title: "This file is not a readable export of the supported format",
          code: error.code,
          detail: error.message,
        });
      }
      throw error;
    }
    if (parsed.rowCount > limits.maxRows) {
      throw problemException(413, {
        title: "This file has too many rows to import in one request",
        code: "IMPORT_TOO_MANY_ROWS",
        detail: `this file carries ${String(parsed.rowCount)} data rows; at most ${String(limits.maxRows)} are accepted in one import`,
      });
    }
    return importer.validate(parsed);
  }

  /**
   * The catalogue package's own `parse`/`validate`, and the second of this
   * cycle's two whole-file error classes.
   *
   * `CatalogueFileError` carries three codes and they do **not** all map to one
   * status: `KERDIAL_JSON_MALFORMED` and
   * `KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED` are `400` — a document this build
   * cannot read — while `IMPORT_FILE_TOO_LARGE` is `413`, the same code and
   * status the multipart layer already answers with for the same fact. Two
   * enforcement points for one ceiling is deliberate and not duplication: the
   * transport refuses a body it is still reading, and `parse` refuses a byte
   * count it can see, so neither depends on the other being reached first.
   *
   * There is no row cap here: a catalogue has entities, not rows, and its size
   * bound is the byte ceiling above.
   */
  #parseCatalogue(bytes: Uint8Array): CatalogueParseResult {
    try {
      return kerdialCatalogueImporter.validate(
        kerdialCatalogueImporter.parse({
          bytes,
          fileType: KERDIAL_CATALOGUE_FILE_TYPE,
          limits: this.kerdialJsonLimits,
        }),
      );
    } catch (error) {
      if (error instanceof CatalogueFileError) {
        if (error.code === "IMPORT_FILE_TOO_LARGE") {
          throw problemException(413, {
            title: "The uploaded file is too large",
            code: error.code,
            detail: error.message,
          });
        }
        throw problemException(400, {
          title: "This file is not a readable Kerdial catalogue package",
          code: error.code,
          detail: error.message,
        });
      }
      throw error;
    }
  }

  /** `plan`, then `apply` when the caller confirmed, then the body. The one path both routes share. */
  async #run(params: {
    readonly startedAt: Date;
    readonly session: SessionContext;
    readonly validated: ParseResult<AnyNeutralRow, AnyImportFileType>;
    /** The calling route's **own** set — `IMPORT_LIMITS` for the two PP routes, `KERDIAL_CSV_IMPORT_LIMITS` for the Kerdial one. */
    readonly limits: ImportLimits;
    readonly mode: "DRY_RUN" | "APPLY";
    readonly destination: { readonly portfolioId: string; readonly cashAccountId: string } | null;
    readonly resolutions: readonly ImportInstrumentResolution[];
    /** `security-transfer` FR-583 — the investment-file route only; every other route has no such row to answer. */
    readonly transferDestinations?: readonly ImportTransferDestination[];
  }): Promise<ImportSummaryResponse> {
    let plan: ImportPlan;
    try {
      plan = await planImport(params.validated, {
        db: this.db,
        tenantId: params.session.tenantId,
        destination: params.destination,
        // The request's own mode decides whether this pass may reach a
        // provider — not whether `resolutions[]` happens to be non-empty. Both
        // routes pass it, including the transaction one, whose `resolutions`
        // is always `[]`: an asset row can never reach that route's file
        // types, and if one ever did, `"APPLY"` here makes it an unconfirmed
        // row that is reported rather than a row silently resolved and written.
        mode: params.mode,
        resolutions: params.resolutions,
        ...(params.transferDestinations === undefined
          ? {}
          : { transferDestinations: params.transferDestinations }),
        // ID1's one seam: the real provider stack, reachable from here and
        // from nowhere inside `importer`.
        discovery: importDiscoveryPortFor(this.marketRuntime),
        limits: params.limits,
        clock: systemClock,
      });
    } catch (error) {
      throw this.#mapPipelineError(error);
    }

    if (params.mode === "DRY_RUN") {
      return toImportSummaryResponse({
        mode: "DRY_RUN",
        plan,
        result: null,
        maxRowDetails: params.limits.maxRowDetails,
        parsed: params.validated,
      });
    }

    let result: ImportResult;
    try {
      const writes = await createTransactionWriteServiceForTenant(
        this.db,
        params.session.tenantId,
        this.marketRuntime,
      );
      result = await applyImport({
        plan,
        db: this.db,
        writes,
        destination: params.destination,
        // `portfolio-export-import` FR-556/AC-448: a Kerdial plan whose file
        // names a portfolio or cash account the tenant does not have carries a
        // non-empty `directory`, and `createPortfolio`/`createCashAccount` are
        // free functions over the connection that take the tenant explicitly —
        // so this is **required** on that path and `applyImport` throws without
        // it. Passed unconditionally rather than only for the Kerdial route:
        // the two Portfolio-Performance routes plan against a destination that
        // already exists, so their `directory` is empty and this is inert for
        // them, and one call site with one behaviour is worth more than a
        // conditional that has to be kept true.
        tenantId: params.session.tenantId,
        updatedBySessionId: params.session.sessionId,
        // Measured from the handler's own start rather than from here:
        // parsing and planning have already spent part of the 30 s
        // `handlerTimeout` this line sits under, and a deadline that ignored
        // that would be 25 s *plus* however long planning took.
        deadlineAt: applyDeadlineAt(params.startedAt, params.limits),
        clock: systemClock,
        // One write transaction and one portfolio recompute per this
        // many consecutive transaction rows.
        chunkRows: params.limits.applyChunkRows,
      });
    } catch (error) {
      throw this.#mapPipelineError(error);
    }

    return toImportSummaryResponse({
      mode: "APPLY",
      plan,
      result,
      maxRowDetails: params.limits.maxRowDetails,
      parsed: params.validated,
    });
  }

  /**
   * A request that could not have been formed is a `400`; anything else the
   * ledger refuses goes through the one shared write-error table.
   *
   * `ImportPlanRequestError` is deliberately not a reason code — the reason-code table
   * is closed and every entry in it describes something about a *row*, whereas
   * this describes the request. It is unreachable through these two routes (the
   * transaction route requires both ids, the instrument route supplies
   * neither), and mapped anyway so a future caller gets a clean 400 rather than
   * a 500.
   */
  #mapPipelineError(error: unknown): unknown {
    if (error instanceof ImportPlanRequestError) {
      return problemException(400, {
        title: "This import request is not well formed",
        code: "IMPORT_REQUEST_INVALID",
        detail: error.message,
      });
    }
    return mapTransactionWriteError(error);
  }
}
