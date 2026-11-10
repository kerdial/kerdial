import type {
  ImportEntryOutcomeResponse,
  ImportEntryWarningResponse,
  ImportInstrumentResolution,
  ImportMode,
  ImportRowOutcomeResponse,
  ImportRowSourceResponse,
  ImportSummaryResponse,
  ImportTransferDecisionResponse,
} from "@kerdial/api-contracts";
import { IMPORT_ROW_SOURCE_LABEL_MAX } from "@kerdial/api-contracts";
import type {
  AnyImportFileType,
  AnyNeutralRow,
  AppliedCatalogueOutcome,
  AppliedRowOutcome,
  CatalogueDraft,
  CatalogueImportResult,
  CatalogueParseResult,
  CataloguePlan,
  ImportPlan,
  ImportResult,
  ParseResult,
  PlannedCatalogueOutcome,
  PlannedRowOutcome,
} from "@kerdial/importer";

/**
 * The neutral row → the `source` descriptor, so a reason code is findable in
 * the user's own file (a line number alone was not, on an export of hundreds of rows).
 *
 * Built **here**, at the response boundary, rather than threaded through
 * `plan`/`apply`: `ParseResult.rows` is index-aligned with every outcome's
 * `at.index`, so one lookup reaches the same row the pipeline decided about,
 * and the pipeline's own `reject()`/`skip()` helpers stay two arguments wide.
 */
function truncateLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= IMPORT_ROW_SOURCE_LABEL_MAX
    ? trimmed
    : `${trimmed.slice(0, IMPORT_ROW_SOURCE_LABEL_MAX - 1)}\u2026`;
}

function labelOf(identity: {
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly displayName?: string | null;
}): string | null {
  const raw = identity.symbol ?? identity.isin ?? identity.displayName ?? null;
  return raw === null || raw.trim() === "" ? null : truncateLabel(raw);
}

/**
 * **Nine shapes, not five** (the export-import shapes, plus
 * `security-transfer`'s `TRANSFER`).
 * `NeutralRow` is deliberately *not* widened with the three Kerdial-only shapes
 * — three `switch`es are closed over it by a `never` check and one of them is
 * inside the Portfolio-Performance module this cycle may not touch — so this
 * function is closed over `AnyNeutralRow` instead, and is the one consumer that
 * genuinely handles all nine.
 *
 * The three new arms fill the same seven fields as the other five, and what
 * they choose is the point: the descriptor exists so a reason code is findable
 * in the user's own file, so each arm carries the figure that *identifies* its
 * row. A `CURRENCY_EXCHANGE` is identified by the amount that left and the
 * currency it left; a `SETTLED_TRADE` by the quantity acquired (its money leg
 * is denominated in another instrument, not in any currency, which is why
 * `currency` is `null` and not a guess); a `DRIP` by its quantity and the
 * currency it was priced in.
 */
function rowSourceOf(row: AnyNeutralRow): ImportRowSourceResponse {
  switch (row.shape) {
    case "INSTRUMENT":
      return {
        shape: "INSTRUMENT",
        tradeDate: null,
        direction: null,
        instrument: labelOf({ symbol: row.symbol, isin: row.isin, displayName: row.displayName }),
        amount: null,
        currency: row.listingCurrency,
        quantity: null,
      };
    case "CASH_MOVEMENT":
      return {
        shape: "CASH_MOVEMENT",
        tradeDate: row.tradeDate,
        direction: row.direction,
        instrument: null,
        amount: row.amount.toString(),
        currency: row.currency,
        quantity: null,
      };
    case "DIVIDEND":
      return {
        shape: "DIVIDEND",
        tradeDate: row.tradeDate,
        direction: null,
        instrument: labelOf(row.instrumentRef),
        amount: row.amount.toString(),
        currency: row.currency,
        quantity: null,
      };
    case "TRADE":
      return {
        shape: "TRADE",
        tradeDate: row.tradeDate,
        direction: row.direction,
        instrument: labelOf(row.instrumentRef),
        amount: null,
        currency: row.currency,
        quantity: row.quantity.toString(),
      };
    case "DISTRIBUTION":
      // The only shape that fills both figures. A free-share row
      // is identified by neither alone: "3 titres" does not say which event,
      // and "503,40 EUR" does not say that no money moved. `direction` stays
      // null: this shape has no opposite.
      return {
        shape: "DISTRIBUTION",
        tradeDate: row.tradeDate,
        direction: null,
        instrument: labelOf(row.instrumentRef),
        amount: row.marketValue.toString(),
        currency: row.currency,
        quantity: row.quantity.toString(),
      };
    case "TRANSFER":
      // `security-transfer` — both figures, as a distribution: a count
      // alone does not say which transfer, and a value alone does not say no
      // money moved. `direction` says which leg the row is.
      return {
        shape: "TRANSFER",
        tradeDate: row.tradeDate,
        direction: row.direction,
        instrument: labelOf(row.instrumentRef),
        amount: row.marketValue.toString(),
        currency: row.currency,
        quantity: row.quantity.toString(),
      };
    case "CURRENCY_EXCHANGE":
      // No `instrument` — this row names none. The pair is stated as the
      // amount's own currency; the target currency is in the row's message
      // when the failure is about it, and repeating it here would need a
      // ninth field for one shape.
      return {
        shape: "CURRENCY_EXCHANGE",
        tradeDate: row.tradeDate,
        direction: null,
        instrument: null,
        amount: row.amount.toString(),
        currency: row.currency,
        quantity: null,
      };
    case "SETTLED_TRADE":
      // `currency: null` is a statement, not a gap: the ledger's own
      // `txn_currency XOR txn_settlement_instrument_id` says an asset-settled
      // trade has no ISO currency, and filling this with the settlement
      // asset's ticker would put a non-currency in a currency field.
      return {
        shape: "SETTLED_TRADE",
        tradeDate: row.tradeDate,
        direction: "ACQUIRE",
        instrument: labelOf(row.instrumentRef),
        amount: null,
        currency: null,
        quantity: row.quantity.toString(),
      };
    case "DRIP":
      return {
        shape: "DRIP",
        tradeDate: row.tradeDate,
        direction: "ACQUIRE",
        instrument: labelOf(row.instrumentRef),
        amount: null,
        currency: row.currency,
        quantity: row.quantity.toString(),
      };
    case "INTEREST":
      // `cash-interest` — identified like a dividend minus the
      // instrument: the gross and its currency.
      return {
        shape: "INTEREST",
        tradeDate: row.tradeDate,
        direction: null,
        instrument: null,
        amount: row.amount.toString(),
        currency: row.currency,
        quantity: null,
      };
    case "FEE":
      // `portfolio-cash` — identified like a withdrawal, plus the
      // instrument it references when the row names one. No `direction`: a
      // fee is always cash out, so the shape says it.
      return {
        shape: "FEE",
        tradeDate: row.tradeDate,
        direction: null,
        instrument: row.instrumentRef === null ? null : labelOf(row.instrumentRef),
        amount: row.amount.toString(),
        currency: row.currency,
        quantity: null,
      };
  }
}

/**
 * `ImportPlan` / `ImportResult` → the `ImportSummaryResponse`
 * (CI-18).
 *
 * ## Why one function serves both modes
 *
 * IMP-AC-14's property is that a dry run and the confirm that follows it report
 * the **same** `imported`/`skipped`/`rejected` counts whenever `applyFailed`
 * and `applyNotAttempted` are both zero. That property is only checkable if the
 * two bodies are built by the same code from the same-shaped input — a
 * dry-run-only formatter and an apply-only formatter could disagree about, say,
 * whether a skipped row appears in `rows[]`, and the equality would then be
 * comparing two different questions. `plan.outcomes` and `result.outcomes`
 * differ in exactly one member (`IMPORT` carries the written id after a write),
 * and nothing below reads it.
 *
 * ## The two counters are surfaced, not inferred
 *
 * A dry run reports `applyFailed: 0, applyNotAttempted: 0` because it attempted
 * no write — not because it was assumed to be clean. These are the
 * only two outcomes a dry run cannot predict, so an apply that reports either
 * as non-zero is stating, in the response body, that its counts and the dry
 * run's are *legitimately* allowed to differ. That is the honest form of
 * IMP-AC-14: the equality is asserted **together with** both counters being
 * zero, and a run where they are not zero makes the divergence visible instead
 * of hiding it behind an assertion that would otherwise have failed for an
 * unexplained reason.
 */

export interface SummaryResponseParams {
  readonly mode: ImportMode;
  readonly plan: ImportPlan;
  /** Absent on a dry run: nothing was written, so there is nothing to report beyond the plan. */
  readonly result: ImportResult | null;
  /** `IMPORT_MAX_ROW_DETAILS`, passed in so a test can move the boundary and watch it move. */
  readonly maxRowDetails: number;
  /**
   * The `parse`/`validate` output the plan was built from. Index-aligned with
   * every outcome's `at.index`, and the only place the neutral row survives —
   * `ImportPlan` keeps decisions, not inputs. Used solely to build each row's
   * `source` descriptor.
   */
  readonly parsed: ParseResult<AnyNeutralRow, AnyImportFileType>;
}

export function toImportSummaryResponse(params: SummaryResponseParams): ImportSummaryResponse {
  const outcomes: readonly (PlannedRowOutcome | AppliedRowOutcome)[] =
    params.result?.outcomes ?? params.plan.outcomes;
  const summary = params.result?.summary ?? params.plan.summary;

  // Folded over **every** row, before any truncation: the row-detail cap's own requirement
  // that the summary counts stay complete when `rows[]` does not.
  const details: ImportRowOutcomeResponse[] = [];
  let suppressed = 0;
  for (const outcome of outcomes) {
    if (outcome.outcome === "IMPORT") continue;
    // OD-1's cross-file skip is deliberately **not** listed row by row. On a
    // typical cash-account file it is most of the rows, all saying the
    // same thing — the investment file carries this trade, which is the design
    // working, not something to review. Listing them buried the one row that
    // did need attention (a single zero-amount dividend) under hundreds of
    // identical entries. The count stays exact in `summary.byReason`, and the UI states
    // it in one sentence; only the per-row enumeration is dropped.
    //
    // Not counted as `suppressed` either: that flag means "the list was cut
    // short, go look at your file", and this is a deliberate omission with its
    // own visible total, not a truncation.
    if (outcome.reason === "COVERED_BY_INVESTMENT_FILE") continue;
    if (details.length >= params.maxRowDetails) {
      suppressed += 1;
      continue;
    }
    const parsedRow = params.parsed.rows[outcome.at.index];
    details.push({
      line: outcome.at.line,
      index: outcome.at.index,
      outcome: outcome.outcome,
      reason: outcome.reason,
      message: outcome.message,
      // `ok === true` for a clean row, and — since `validate` now carries the
      // refused row through — also present on a `validate` rejection. Only a
      // `parse` rejection has nothing to describe.
      source: parsedRow?.row === undefined ? null : rowSourceOf(parsedRow.row),
    });
  }

  // Asset-catalogue dry runs only. A confirm was *given* the resolutions
  // it echoed back, so returning them would be handing the caller its own
  // request; a transaction file has no proposals to make at all.
  // The label is attached **here**, at the response boundary, for the reason
  // `rowSourceOf` is built here too: `ParseResult.rows` is index-aligned
  // with every proposal's own `index`, so one lookup reaches the row the
  // pipeline decided about, and the pipeline itself stays free of the
  // response's own vocabulary — the same truncation, applied by the same
  // function, as every other echo of a free-text cell.
  const proposals: readonly ImportInstrumentResolution[] =
    params.result === null && params.plan.fileType === "ASSETS"
      ? params.plan.proposals.map((proposal) => {
          const row = params.parsed.rows[proposal.index]?.row;
          return {
            ...proposal,
            label:
              row?.shape === "INSTRUMENT"
                ? labelOf({ symbol: row.symbol, isin: row.isin, displayName: row.displayName })
                : null,
          };
        })
      : [];

  // `security-transfer` FR-583 — a dry run's open destination questions, one
  // per source-leg transfer row it would write. Dry runs only, for the reason
  // `proposals` are: a confirm was *given* the answers. Labelled here, at the
  // response boundary, by the same function and truncation as every other
  // echo of a free-text cell.
  const transferDecisions: readonly ImportTransferDecisionResponse[] =
    params.result === null
      ? params.plan.transferDecisions.map((decision) => {
          const parsedRow = params.parsed.rows[decision.index];
          const row = parsedRow?.row;
          return {
            index: decision.index,
            line: parsedRow?.at.line ?? decision.index + 2,
            tradeDate: decision.tradeDate,
            instrumentId: decision.instrumentId,
            instrument:
              row !== undefined && row.shape === "TRANSFER" ? labelOf(row.instrumentRef) : null,
            quantity: decision.quantity.toString(),
            marketValue: decision.marketValue.toString(),
            currency: decision.currency,
          };
        })
      : [];

  return {
    mode: params.mode,
    fileType: params.plan.fileType,
    rowCount: params.plan.rowCount,
    imported: summary.imported,
    skipped: summary.skipped,
    rejected: summary.rejected,
    byReason: summary.byReason,
    rows: details,
    rowsTruncated: suppressed > 0,
    ...(proposals.length > 0 ? { proposals } : {}),
    ...(transferDecisions.length > 0 ? { transferDecisions } : {}),
    applyFailed: params.result?.applyFailed ?? 0,
    applyNotAttempted: params.result?.applyNotAttempted ?? 0,
    discoveryCallsIssued: params.plan.discoveryCallsIssued,
  };
}

/* -------------------------------------------------------------------------- */
/*  The catalogue package's own summary (portfolio-export-import)        */
/* -------------------------------------------------------------------------- */

export interface CatalogueSummaryResponseParams {
  readonly mode: ImportMode;
  /** `parse`/`validate`'s output — the only place the document's own section sizes survive. */
  readonly parsed: CatalogueParseResult;
  readonly plan: CataloguePlan;
  /** Absent on a dry run: nothing was written, so there is nothing to report beyond the plan. */
  readonly result: CatalogueImportResult | null;
  /** `KerdialJsonLimits.maxEntityDetails`, passed in so a test can move the boundary and watch it move. */
  readonly maxEntityDetails: number;
}

/**
 * `CataloguePlan` / `CatalogueImportResult` -> the same
 * `ImportSummaryResponse` envelope the CSV routes return.
 *
 * ## Why one envelope for two packages that share no vocabulary
 *
 * The **counts** are the same question — how many entities imported, were
 * skipped, were rejected, and under which reason codes — and a caller that had
 * to read two differently-shaped answers to it would end up with two summary
 * renderers that disagree about, say, whether a skipped entry is in the list.
 * What genuinely differs is *addressing*: a CSV row has a line, a catalogue
 * entry has a section and an index. That difference, and only that, is why
 * {@link ImportSummaryResponse.entries} exists beside `rows` rather than the
 * catalogue reusing `rows` with a fabricated `line` on every entry.
 *
 * ## The two counters, and why a dry run reports zero rather than omitting them
 *
 * Exactly as {@link toImportSummaryResponse}: `applyFailed`/`applyNotAttempted`
 * are `0` on a dry run because it attempted no write, not because it was
 * assumed clean, so an apply reporting either as non-zero is stating in the
 * body that its counts and the dry run's are legitimately allowed to differ.
 *
 * `discoveryCallsIssued` is `0` and is **structural**, not an assertion: a
 * catalogue plan has no discovery port and cannot reach a provider — the
 * document carries every identity it needs.
 */
export function toCatalogueSummaryResponse(
  params: CatalogueSummaryResponseParams,
): ImportSummaryResponse {
  const outcomes: readonly (PlannedCatalogueOutcome | AppliedCatalogueOutcome)[] =
    params.result?.outcomes ?? params.plan.outcomes;
  const summary = params.result?.summary ?? params.plan.summary;

  // Folded over **every** entry, before any truncation — the same
  // rule as the CSV routes: the summary counts stay complete when the list does not.
  const details: ImportEntryOutcomeResponse[] = [];
  let suppressed = 0;
  // Warnings ride on `IMPORT` outcomes only, get their own list
  // under the same cap, and are counted in full before it — never in `byReason`.
  const warnings: ImportEntryWarningResponse[] = [];
  let warningCount = 0;
  for (const outcome of outcomes) {
    if (outcome.outcome === "IMPORT") {
      for (const warning of outcome.warnings) {
        warningCount += 1;
        if (warnings.length >= params.maxEntityDetails) continue;
        warnings.push({
          section: outcome.at.section,
          index: outcome.at.index,
          code: warning.code,
          message: warning.message,
        });
      }
      continue;
    }
    if (details.length >= params.maxEntityDetails) {
      suppressed += 1;
      continue;
    }
    details.push({
      section: outcome.at.section,
      index: outcome.at.index,
      outcome: outcome.outcome,
      reason: outcome.reason,
      message: outcome.message,
    });
  }

  return {
    mode: params.mode,
    fileType: "KERDIAL_CATALOGUE",
    // The catalogue route's `rowCount` counts **draft entities** — the
    // entries `parse` read, refused ones included, which is the same number
    // `outcomes` has one element per.
    rowCount: params.parsed.entryCount,
    imported: summary.imported,
    skipped: summary.skipped,
    rejected: summary.rejected,
    byReason: summary.byReason,
    // No rows: this package has entries. Present and empty rather than absent,
    // because the field is not optional and a caller reading `rows.length`
    // should get `0`, not a crash.
    rows: [],
    rowsTruncated: suppressed > 0,
    entries: details,
    warnings,
    warningCount,
    sections: sectionCountsOf(params.parsed.draft),
    sharedCatalogueImpact: params.plan.sharedImpact,
    applyFailed: params.result?.applyFailed ?? 0,
    applyNotAttempted: params.result?.applyNotAttempted ?? 0,
    discoveryCallsIssued: 0,
  };
}

/**
 * What the document carried, per section — for « 12 instruments, 3
 * portefeuilles, 480 prix manuels ».
 *
 * The keys are deliberately the **export's** own section names
 * (`CatalogueExportCounts`, `api/src/exports/exports.reads.ts`), so the file a
 * user downloaded and the summary of importing it back are counted the same way
 * and can be compared field by field. Counting what the file *carried* rather
 * than what was written is also deliberate: `imported`/`skipped`/`rejected`
 * already say what was written, and a second, subtly different answer to that
 * question is how a summary starts disagreeing with itself.
 */
function sectionCountsOf(draft: CatalogueDraft): Record<string, number> {
  let cashAccounts = 0;
  let icons = 0;
  let manualPrices = 0;
  let watchlistItems = 0;

  for (const portfolio of draft.portfolios) {
    cashAccounts += portfolio.cashAccounts.length;
    if (portfolio.icon !== undefined) icons += 1;
  }
  for (const instrument of draft.instruments) {
    if (instrument.icon !== undefined) icons += 1;
    manualPrices += instrument.manualPrices.length;
    if (instrument.watchlist !== undefined) watchlistItems += 1;
  }

  return {
    instruments: draft.instruments.length,
    portfolios: draft.portfolios.length,
    cashAccounts,
    icons,
    manualPrices,
    watchlistItems,
    fxRatesUser: draft.fxRatesUser.length,
  };
}
