import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_FILE_TYPES,
  IMPORT_MANUAL_ROW_NOTICE,
  type ImportEntryWarningResponse,
  type ImportFileTypeName,
  type ImportInstrumentResolution,
  type ImportMode,
  type ImportSummaryResponse,
} from "@kerdial/api-contracts";
import {
  EXPORT_CATALOGUE_HREF,
  EXPORT_CATALOGUE_WITHOUT_ICONS_HREF,
  EXPORT_TRANSACTIONS_HREF,
  importInstrumentsFile,
  importKerdialFile,
  importTransactionsFile,
} from "../lib/api-client.js";
import {
  IMPORT_FILE_ACCEPT,
  IMPORT_FILE_LOST_ON_REFRESH_NOTICE,
  IMPORT_FILE_TYPE_DESCRIPTIONS,
  IMPORT_FILE_TYPE_LABELS,
  IMPORT_PP2_REIMPORT_NOTICE,
  sharedCatalogueImpactNotice,
  IMPORT_RERUN_HINT,
  catalogueSectionLabel,
  importFileRefusalNotice,
  isAcceptableImportFile,
  isKerdialFileType,
  needsDestination,
  nextGuidedFileType,
} from "../lib/import-copy.js";
import { fill } from "../lib/copy/fill.js";
import { groupThousands } from "../lib/figure-format.js";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { messageForError } from "../lib/problem-messages.js";
import {
  invalidateCatalogueSurfaces,
  invalidatePortfolioDerivedFigures,
} from "../lib/invalidate-derived.js";
import { portfoliosQueryOptions } from "../lib/queries.js";
import { CashAccountPicker } from "../components/CashAccountPicker.js";
import { CurrencySelect } from "../components/CurrencySelect.js";
import { ImportCountsStrip } from "../components/ImportCountsStrip.js";
import { ImportEntryOutcomeTable } from "../components/ImportEntryOutcomeTable.js";
import { ImportEntryWarnings } from "../components/ImportEntryWarnings.js";
import { hasInvalidExchangeMic, ImportProposalEditor } from "../components/ImportProposalEditor.js";
import { ImportRowOutcomeTable } from "../components/ImportRowOutcomeTable.js";
import {
  ImportTransferDecisions,
  incompleteTransferDestination,
  transferDestinationsOf,
  type TransferDestinationChoices,
} from "../components/ImportTransferDecisions.js";
import { PageHeader } from "../components/PageHeader.js";
import { Banner, Button, Card, Icon, Select } from "../components/ui/index.js";

/**
 * `ImportWizard.tsx` — the router-agnostic half of `/import`
 * (OD-11(a); CI-22). The
 * router-bound `component` is `ImportRoute.tsx`, which hands this one its
 * search state as plain props — the `ActivityRoute`/`ActivityView` and
 * `InstrumentsRoute`/`InstrumentsView` split, for the same reason: this file
 * is then directly testable under plain `vitest` with no router at all.
 *
 * ## Five steps, one route
 *
 * 1. **`type`** — five cards since `portfolio-export-import`: the three
 *    Portfolio-Performance files and the two Kerdial packages, rendered from
 *    `IMPORT_FILE_TYPES` so widening that tuple is a compile error in the copy
 *    tables rather than a blank card. **No detection** (NG3): the user always
 *    says which file this is, because guessing wrong writes the wrong thing.
 *    The two « Exporter » actions sit above them.
 * 2. **`destination`** — skipped entirely for the three destination-less types:
 *    `ASSETS` (a catalogue has no portfolio), `KERDIAL_CATALOGUE` (it carries
 *    whole portfolios) and `KERDIAL_TRANSACTIONS` (each row names its own,
 *    FR-532/FR-533). Otherwise a portfolio select plus the **shipped**
 *    `CashAccountPicker`, which already offers inline creation through
 *    `CashAccountFormDialog`. Nothing new is built here — both components
 *    exist, closing M13's "no reusable create-or-pick widget"
 *    gap.
 * 3. **`file`** — `accept` per file type (`.csv` for four of the five, `.json`
 *    for the Kerdial catalogue), enforced locally as well as declared, then
 *    « Analyser le fichier », which issues `mode=DRY_RUN`. A dry run writes
 *    nothing, ever.
 * 4. **`review`** — the three counts, the per-reason breakdown, the
 *    virtualised per-row table (or, for the catalogue, its section counts and
 *    its per-entry table), and — for `ASSETS` only — the editable proposal per
 *    row. « Confirmer l'import » issues `mode=APPLY` with the same file and the
 *    **edited** resolutions. An investment file with a transfer out
 *    (`security-transfer` FR-583) also asks, per such row, which portfolio
 *    received the units; the answers ride every APPLY of the chain.
 * 5. **`result`** — the final counts, the per-row (or per-entry) outcomes, the
 *    re-run line when the discovery budget cut rows short, and « Importer le
 *    fichier suivant ». When the apply deadline cut the file short the wizard
 *    re-posts it on its own until nothing is left, with a progress line
 *    and « Arrêter »; « Continuer l'import » is what remains once it stopped.
 *
 * ## The domain mapping, stated because the user's words differ from the schema
 *
 * The user describes "the PEA cash account" and "the PEA portfolio" as two
 * things that need linking. In this schema they already are: a **portfolio**
 * *is* the investment account, and a **cash account** is a child of it. So the
 * destination step asks for a portfolio and then for one of *its* cash
 * accounts — the containment is the link, and there is nothing to connect.
 *
 * ## The stated limitation, and why it is stated rather than hidden
 *
 * The selected `File` cannot live in the URL, so it lives in component state
 * and a refresh at step 4 or 5 loses it. This is precisely why OD-11(a) chose
 * a route over a modal (a modal loses it on *any* navigation, not only a
 * refresh). Rather than silently emptying, the wizard falls back to step 3 and
 * renders {@link IMPORT_FILE_LOST_ON_REFRESH_NOTICE}, which also says the
 * reassuring half: an analysis writes nothing, so nothing was lost but the
 * click.
 *
 * ## Honesty about a partial result
 *
 * A typical asset file reports some rows **rejected, not imported**: the
 * discovery budget is spent before the last rows get their turn, and
 * re-running is the designed remedy (the committed fixture: 24 imported,
 * 1 skipped, 2 rejected). `IMPORT_RERUN_HINT` is rendered whenever
 * `EXCHANGE_MIC_LOOKUP_UNAVAILABLE > 0` for exactly that reason — reporting
 * the imported count as though it were the whole file is the outcome this
 * screen is written against.
 */

/** The `step` search param. `asEnum` degrades an unrecognised value to `undefined`, which reads as `"type"`. */
export const IMPORT_WIZARD_STEPS = ["type", "destination", "file", "review", "result"] as const;
export type ImportWizardStep = (typeof IMPORT_WIZARD_STEPS)[number];

export interface ImportSearchState {
  readonly step?: ImportWizardStep;
  readonly type?: ImportFileTypeName;
  readonly portfolio?: string;
  readonly account?: string;
}

export interface ImportWizardProps {
  readonly search: ImportSearchState;
  readonly onSearchChange: (updater: (prev: ImportSearchState) => ImportSearchState) => void;
}

/** The label each step shows in the progress rail — the user's own vocabulary, not the param values. */
const STEP_LABELS: Readonly<Record<ImportWizardStep, string>> = {
  type: "Type de fichier",
  destination: "Destination",
  file: "Fichier",
  review: "Vérification",
  result: "Résultat",
};

/**
 * Which file types write ledger rows — the two Portfolio-Performance
 * transaction files and the Kerdial CSV.
 *
 * Distinct from {@link needsDestination}, which is about *where* those rows go,
 * and the two must not be conflated again: the Kerdial CSV writes transactions
 * and needs no destination step, so a single predicate would have to be wrong
 * about one of the two questions. `IMPORT_MANUAL_ROW_NOTICE` is keyed off this
 * one (a hand-entered transaction is unrecognisable to *any* import), while the
 * destination step is keyed off the other.
 */
function writesTransactions(fileType: ImportFileTypeName): boolean {
  return needsDestination(fileType) || fileType === "KERDIAL_TRANSACTIONS";
}

/**
 * The most APPLY requests one « Confirmer » or « Continuer » chains on
 * its own. A ceiling-sized Kerdial CSV needs ~37 (EI-23), so this only fires
 * on something the no-progress stop did not catch.
 */
const MAX_CHAINED_APPLY_RUNS = 100;

/** Why a chain of APPLY requests stopped on its own, when it was neither finished, stopped by the user nor failed. */
type ApplyChainHalt = "noProgress" | "runCap";

/**
 * The skip reason a re-posted file gives the rows an earlier run of the same
 * chain wrote (FR-537): the fingerprint dedupe for the transaction files,
 * "already identical" for the catalogue, "already catalogued" for an asset file.
 */
const RESKIP_REASON: Readonly<Record<ImportFileTypeName, string>> = {
  ASSETS: "INSTRUMENT_ALREADY_EXISTS",
  CASH_ACCOUNT_TRANSACTIONS: "ALREADY_IMPORTED",
  INVESTMENT_ACCOUNT_TRANSACTIONS: "ALREADY_IMPORTED",
  KERDIAL_TRANSACTIONS: "ALREADY_IMPORTED",
  KERDIAL_CATALOGUE: "CATALOGUE_ENTRY_UNCHANGED",
};

/** Every APPLY response of one chain that the cumulative summary needs. */
interface ApplyChain {
  readonly first: ImportSummaryResponse;
  readonly latest: ImportSummaryResponse;
  /** The catalogue's warnings, unioned: a warning rides only the run that wrote its entry. */
  readonly warnings: readonly ImportEntryWarningResponse[];
  /** Warnings some run counted but cut from its list. */
  readonly unlistedWarnings: number;
}

function extendApplyChain(chain: ApplyChain | null, next: ImportSummaryResponse): ApplyChain {
  const seen = new Set<string>();
  const warnings: ImportEntryWarningResponse[] = [];
  for (const warning of [...(chain?.warnings ?? []), ...(next.warnings ?? [])]) {
    const key = `${warning.section}:${String(warning.index)}:${warning.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(warning);
  }
  const nextListed = next.warnings?.length ?? 0;
  return {
    first: chain?.first ?? next,
    latest: next,
    warnings,
    unlistedWarnings:
      (chain?.unlistedWarnings ?? 0) + (next.warningCount ?? nextListed) - nextListed,
  };
}

/**
 * What the whole chain did, never what its last request alone did.
 *
 * Every run re-reads the whole file, so the latest response already holds the
 * final outcome of every row — except that the rows *earlier runs* wrote now
 * come back as {@link RESKIP_REASON} skips. Those are the growth of that one
 * reason between the first run and the latest (rows it covered before the
 * chain began are in both), and they move back from « ignorées » to
 * « importées ». Summing the runs instead would count each written row once
 * as imported and then once per later run as skipped. The three counts still
 * sum to `rowCount`.
 *
 * The detail list is the latest run's, minus those same re-skips: a re-skip
 * row is kept only when the first run already reported it as one.
 */
function applyChainSummary(chain: ApplyChain, fileType: ImportFileTypeName): ImportSummaryResponse {
  const { first, latest } = chain;
  const reskip = RESKIP_REASON[fileType];
  const reskippedNow = latest.byReason[reskip] ?? 0;
  const writtenEarlier = Math.max(0, reskippedNow - (first.byReason[reskip] ?? 0));
  const byReason: Record<string, number> = { ...latest.byReason };
  if (reskippedNow - writtenEarlier > 0) byReason[reskip] = reskippedNow - writtenEarlier;
  else delete byReason[reskip];
  const reskippedRows = new Set(
    first.rows.filter((row) => row.reason === reskip).map((row) => row.index),
  );
  const reskippedEntries = new Set(
    (first.entries ?? [])
      .filter((entry) => entry.reason === reskip)
      .map((entry) => `${entry.section}:${String(entry.index)}`),
  );
  return {
    ...latest,
    imported: latest.imported + writtenEarlier,
    skipped: latest.skipped - writtenEarlier,
    byReason,
    rows: latest.rows.filter((row) => row.reason !== reskip || reskippedRows.has(row.index)),
    rowsTruncated: first.rowsTruncated || latest.rowsTruncated,
    ...(latest.entries !== undefined && {
      entries: latest.entries.filter(
        (entry) =>
          entry.reason !== reskip ||
          reskippedEntries.has(`${entry.section}:${String(entry.index)}`),
      ),
    }),
    ...(latest.warnings !== undefined && {
      warnings: chain.warnings,
      warningCount: chain.warnings.length + chain.unlistedWarnings,
    }),
  };
}

export function ImportWizard({ search, onSearchChange }: ImportWizardProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState<ImportSummaryResponse | null>(null);
  const [resolutions, setResolutions] = useState<readonly ImportInstrumentResolution[]>([]);
  /** `security-transfer` FR-583 — the review step's answers, echoed on every APPLY of one chain. */
  const [transferChoices, setTransferChoices] = useState<TransferDestinationChoices>(new Map());
  const [result, setResult] = useState<ImportSummaryResponse | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState("EUR");
  /** The name of a selection refused for not being a CSV — kept so the refusal names the file it refused. */
  const [rejectedFileName, setRejectedFileName] = useState<string | undefined>(undefined);
  /** Set by « Arrêter », read between two APPLY requests — an in-flight one is never aborted. */
  const [stopRequested, setStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  const [chainHalt, setChainHalt] = useState<ApplyChainHalt | undefined>(undefined);
  const applyChainRef = useRef<ApplyChain | null>(null);
  /**
   * Bumped whenever the wizard drops the file (or unmounts), so a chain still
   * awaiting a response neither re-posts nor writes a stale summary over the
   * next file's state.
   */
  const applyGenerationRef = useRef(0);
  useEffect(
    () => () => {
      applyGenerationRef.current += 1;
    },
    [],
  );

  const portfoliosQuery = useQuery(portfoliosQueryOptions());

  const fileType = search.type;
  const portfolioId = search.portfolio ?? "";
  const accountId = search.account ?? "";
  const requestedStep: ImportWizardStep = search.step ?? "type";

  // Every fallback below is derived at render rather than pushed through an
  // effect: a `useEffect` that rewrote the URL on mount would race the user's
  // own back button, and there is nothing here that the current props do not
  // already determine.
  const fileLost =
    (requestedStep === "review" && dryRun === null) ||
    (requestedStep === "result" && result === null);
  const step: ImportWizardStep =
    fileType === undefined
      ? "type"
      : requestedStep === "destination" && !needsDestination(fileType)
        ? "file"
        : fileLost
          ? "file"
          : requestedStep;

  function go(next: Partial<ImportSearchState>): void {
    onSearchChange((prev) => ({ ...prev, ...next }));
  }

  /** Everything that describes *one* file, dropped whenever the wizard moves to another. */
  function clearFileState(): void {
    applyGenerationRef.current += 1;
    applyChainRef.current = null;
    setChainHalt(undefined);
    setStopRequested(false);
    setBusy(false);
    setFile(null);
    setDryRun(null);
    setResolutions([]);
    setTransferChoices(new Map());
    setResult(null);
    setError(undefined);
    setRejectedFileName(undefined);
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }

  function chooseType(next: ImportFileTypeName): void {
    clearFileState();
    go({ type: next, step: needsDestination(next) ? "destination" : "file" });
  }

  /** The one request-issuing point: which of the four routes this file type goes to, in the given mode. */
  function upload(
    selected: File,
    selectedType: ImportFileTypeName,
    mode: ImportMode,
  ): Promise<ImportSummaryResponse> {
    if (isKerdialFileType(selectedType)) {
      // Not `needsDestination`'s branch and not `ASSETS`' either: the two
      // Kerdial routes take `file` and `mode` and nothing else — no
      // destination (the package carries its own, per row) and no
      // `resolutions` (nothing reads them).
      return importKerdialFile({
        file: selected,
        mode,
        fileType: selectedType as "KERDIAL_CATALOGUE" | "KERDIAL_TRANSACTIONS",
      });
    }
    if (needsDestination(selectedType)) {
      return importTransactionsFile({
        file: selected,
        mode,
        fileType: selectedType,
        portfolioId,
        cashAccountId: accountId,
        // `security-transfer` FR-583, and the reason it is here rather than
        // on the confirm button: every APPLY of a chain goes through this one
        // call, so the automatic continuation re-posts the same answers. A
        // re-post without them would write the remaining transfers alone.
        ...(mode === "APPLY"
          ? { transferDestinations: transferDestinationsOf(transferChoices) }
          : {}),
      });
    }
    return mode === "APPLY"
      ? importInstrumentsFile({ file: selected, mode, resolutions })
      : importInstrumentsFile({ file: selected, mode });
  }

  async function analyse(): Promise<void> {
    if (file === null || fileType === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const summary = await upload(file, fileType, "DRY_RUN");
      setDryRun(summary);
      setResolutions(summary.proposals ?? []);
      setTransferChoices(new Map());
      go({ step: "review" });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /**
   * « Confirmer l'import » (`continuation: false`, a new chain) and
   * « Continuer l'import » (`continuation: true`, the same chain resumed after
   * it stopped) — one path, which is the manual continuation made
   * self-driving.
   *
   * Each response with `applyNotAttempted > 0` re-posts the same file to the
   * same route with the same fields, and the server re-skips what it already
   * wrote. The chain ends on the first of:
   *
   * - `applyNotAttempted === 0` — the file is done;
   * - « Arrêter » — read *between* requests only, because the server commits
   *   per chunk and aborting a request would only hide what it wrote;
   * - a failed request, `429 KERDIAL_IMPORT_THROTTLED` included — shown through
   *   the one error banner, with no retry;
   * - no progress: `applyNotAttempted` did not decrease since the previous
   *   response (a chain resumed by hand compares with the response it resumes);
   * - {@link MAX_CHAINED_APPLY_RUNS} requests in this chain.
   *
   * The invalidation runs once, when the chain ends, if any run wrote: the
   * figures are stale either way, and verifying `calc_epoch` after each of
   * ~37 requests would be 37 verification rounds for one answer.
   */
  async function apply(continuation: boolean): Promise<void> {
    if (file === null || fileType === undefined) return;
    applyGenerationRef.current += 1;
    const generation = applyGenerationRef.current;
    stopRequestedRef.current = false;
    setStopRequested(false);
    setChainHalt(undefined);
    setBusy(true);
    setError(undefined);
    let chain = continuation ? applyChainRef.current : null;
    let wrote = false;
    try {
      for (let run = 1; ; run += 1) {
        const summary = await upload(file, fileType, "APPLY");
        if (generation !== applyGenerationRef.current) return;
        const previous = chain?.latest;
        chain = extendApplyChain(chain, summary);
        applyChainRef.current = chain;
        setResult(applyChainSummary(chain, fileType));
        if (run === 1) go({ step: "result" });
        if (summary.imported > 0) wrote = true;
        if (summary.applyNotAttempted === 0 || stopRequestedRef.current) break;
        if (previous !== undefined && summary.applyNotAttempted >= previous.applyNotAttempted) {
          setChainHalt("noProgress");
          break;
        }
        if (run >= MAX_CHAINED_APPLY_RUNS) {
          setChainHalt("runCap");
          break;
        }
      }
    } catch (caught) {
      if (generation === applyGenerationRef.current) setError(caught);
    } finally {
      if (generation === applyGenerationRef.current) {
        setBusy(false);
        setStopRequested(false);
      }
      // An apply writes and advances `calc_epoch`, so every derived figure
      // this app caches is now stale — the same invalidation every other write
      // path performs, never a narrower one. Also after a failed or abandoned
      // chain: its earlier runs wrote.
      //
      // Fire-and-forget, and its failure is deliberately swallowed: the import
      // itself has already succeeded and its summary is on screen, so a failed
      // *cache* invalidation must not be presented as a failed import. The
      // worst case is another screen showing a figure one read out of date.
      if (wrote) invalidateAfterApply(fileType);
    }
  }

  function requestStop(): void {
    stopRequestedRef.current = true;
    setStopRequested(true);
  }

  /**
   * EI-35 — the fan-out, and the one flag
   * that differs between the two halves of it.
   *
   * - **Anything that writes ledger rows** (both PP transaction files and the
   *   Kerdial CSV) advances `calc_epoch` server-side, so
   *   `epochWillAdvance: true`: overview and holdings are held until the
   *   refetched epoch is *proven* to have moved.
   * - **The catalogue** moves no `calc_epoch` at all (it writes
   *   instruments, icons, prices, watchlist rows and portfolios, none of which
   *   is a computed figure), so `epochWillAdvance: false`. `true` here would
   *   make the client burn `invalidateAndVerifyCalcEpoch`'s whole retry budget
   *   waiting for a move that never comes and then report the figures as
   *   unverified — the recorded `upsertManualPricePoint` failure, repeated.
   * - **Both Kerdial routes** additionally invalidate the catalogue surfaces:
   *   a Kerdial CSV creates the portfolios and cash accounts its rows name
   *   (covered by the derived-figure call's own `list`/`cash` prefixes), and
   *   the catalogue creates instruments, icons, manual prices, watchlist rows
   *   and user FX rates (covered only by {@link invalidateCatalogueSurfaces}).
   *   The CSV path gets the second call too rather than a third case: it costs
   *   one refetch of screens the user is looking at, and the alternative is a
   *   predicate asserting that a Kerdial CSV can never touch the security
   *   master — which is a claim about the server's write path, not this one's.
   * - **`ASSETS` invalidates nothing**, unchanged from before this cycle: a
   *   Portfolio-Performance asset file writes catalogue rows the wizard's own
   *   review step is the only reader of, and widening it here would be an
   *   untested change to a path this cycle has no requirement over.
   */
  function invalidateAfterApply(applied: ImportFileTypeName): void {
    if (writesTransactions(applied)) {
      void invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }).catch(
        () => undefined,
      );
    } else if (applied === "KERDIAL_CATALOGUE") {
      void invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false }).catch(
        () => undefined,
      );
    }
    if (isKerdialFileType(applied)) {
      void invalidateCatalogueSurfaces(queryClient).catch(() => undefined);
    }
  }

  const portfolios = portfoliosQuery.data ?? [];
  const destinationOptions = portfolioSelectOptions(portfolios, portfolioId);
  const summaryForStep = step === "result" ? result : dryRun;
  const rerunNeeded =
    summaryForStep !== null &&
    summaryForStep !== undefined &&
    (summaryForStep.byReason["EXCHANGE_MIC_LOOKUP_UNAVAILABLE"] ?? 0) > 0;
  const followUp = fileType !== undefined ? nextGuidedFileType(fileType) : undefined;
  // Before the confirm only — the result screen reports what was written.
  const sharedImpact = dryRun?.sharedCatalogueImpact;
  const sharedImpactNotice =
    sharedImpact !== undefined ? sharedCatalogueImpactNotice(sharedImpact) : null;

  return (
    <section data-testid="import-screen" className="import-screen">
      <PageHeader title={IMPORT_COPY.screenTitle} subtitle={IMPORT_COPY.screenSubtitle} />

      <ol className="import-steps" data-testid="import-steps">
        {IMPORT_WIZARD_STEPS.map((candidate) => (
          <li
            key={candidate}
            className="import-step"
            data-testid={`import-step-${candidate}`}
            data-current={candidate === step ? "true" : undefined}
            aria-current={candidate === step ? "step" : undefined}
          >
            {STEP_LABELS[candidate]}
          </li>
        ))}
      </ol>

      {error !== undefined && (
        <Banner
          tone={messageForError(error).tone === "warning" ? "warn" : "loss"}
          icon="circle-alert"
          testId="import-error"
        >
          {messageForError(error).text}
        </Banner>
      )}

      {fileLost && (
        <Banner tone="neutral" icon="info" testId="import-file-lost">
          {IMPORT_FILE_LOST_ON_REFRESH_NOTICE}
        </Banner>
      )}

      {/*
        The export card. On the `type` step — the screen's landing state,
        so it is on screen the moment `/import` opens and needs no user action
        at all, which is the property EI-34 asks for — and not on the four
        steps that follow, where an unrelated download link beside a file being
        analysed is noise.

        **Two plain `<a download>` elements, never `fetch` + `createObjectURL`.**
        These are CSRF-exempt GETs, the session cookie rides a same-origin
        navigation, and the server already sets `Content-Disposition` with the
        filename it chose. A blob path would hold a second copy of a file up to
        32 MiB in memory and invent a filename that could disagree with the
        server's.

        The one thing a plain navigation cannot do is render a
        `413 EXPORT_TOO_LARGE` as anything but raw JSON — so the ceiling and
        the `icons=omitted` remedy are stated *here*, inline and unconditional,
        rather than after the failure. `EXPORT_TOO_LARGE` is also in
        `problem-messages.ts` for the day a `fetch` path surfaces it.
      */}
      {step === "type" && (
        <Card data-testid="import-export-card">
          <h2 className="import-card-title">{IMPORT_COPY.exportTitle}</h2>
          <p className="import-note">{IMPORT_COPY.exportExplanation}</p>
          <div className="import-export-links">
            <a
              className="k-btn k-btn-md k-btn-secondary import-export-link"
              href={EXPORT_CATALOGUE_HREF}
              download
              data-testid="import-export-catalogue"
            >
              <Icon name="download" size="sm" />
              {IMPORT_COPY.exportCatalogue}
            </a>
            <a
              className="k-btn k-btn-md k-btn-secondary import-export-link"
              href={EXPORT_TRANSACTIONS_HREF}
              download
              data-testid="import-export-transactions"
            >
              <Icon name="download" size="sm" />
              {IMPORT_COPY.exportTransactions}
            </a>
          </div>
          <p className="import-note import-export-note" data-testid="import-export-ceiling">
            {IMPORT_COPY.exportCeiling}{" "}
            <a
              href={EXPORT_CATALOGUE_WITHOUT_ICONS_HREF}
              download
              data-testid="import-export-catalogue-no-icons"
            >
              {IMPORT_COPY.exportCatalogueWithoutIcons}
            </a>
          </p>
        </Card>
      )}

      {step === "type" && (
        <div className="import-type-grid" data-testid="import-type-step">
          {IMPORT_FILE_TYPES.map((candidate) => (
            <Card key={candidate} data-testid={`import-type-card-${candidate}`}>
              <h2 className="import-card-title">{IMPORT_FILE_TYPE_LABELS[candidate]}</h2>
              <p className="import-note">{IMPORT_FILE_TYPE_DESCRIPTIONS[candidate]}</p>
              <Button
                variant="primary"
                data-testid={`import-choose-${candidate}`}
                onClick={() => chooseType(candidate)}
              >
                {IMPORT_COPY.chooseType}
              </Button>
            </Card>
          ))}
        </div>
      )}

      {step === "destination" && fileType !== undefined && (
        <Card data-testid="import-destination-step">
          <h2 className="import-card-title">{IMPORT_COPY.destinationTitle}</h2>
          <p className="import-note">{IMPORT_COPY.destinationExplanation}</p>
          <Select
            label={IMPORT_COPY.portfolio}
            data-testid="import-portfolio-select"
            value={portfolioId}
            // portfolio-archive FR-596: archived portfolios are not offered
            // unless already chosen; an all-archived tenant is told so.
            hint={
              portfolios.length > 0 && destinationOptions.length === 0
                ? PORTFOLIO_COPY.allArchived
                : undefined
            }
            options={[{ value: "", label: IMPORT_COPY.chooseOption }, ...destinationOptions]}
            onChange={(event) => go({ portfolio: event.target.value, account: undefined })}
          />
          {portfoliosQuery.isError && (
            <p role="alert" className="k-pf-error" data-testid="import-portfolios-error">
              {messageForError(portfoliosQuery.error).text}
            </p>
          )}
          {/* The picker is currency-scoped by contract, and no currency
              reaches this screen from anywhere else: the request carries none
              (each row's currency comes from the file), so the wizard has to
              ask. Defaulted to EUR because that is what a Portfolio
              Performance export of a French PEA carries, and it only ever
              filters which accounts are offered — it is never sent. */}
          <CurrencySelect value={currency} onChange={setCurrency} testId="import-currency-select" />
          <CashAccountPicker
            portfolioId={portfolioId}
            currency={currency}
            value={accountId}
            onChange={(next) => go({ account: next })}
            label={IMPORT_COPY.cashAccount}
            hint={IMPORT_COPY.cashAccountHint}
            testId="import-cash-account"
          />
          <div className="import-actions">
            <Button
              variant="ghost"
              iconLeft="arrow-left"
              data-testid="import-back-to-type"
              onClick={() => go({ step: "type" })}
            >
              {IMPORT_COPY.changeType}
            </Button>
            <Button
              variant="primary"
              iconRight="arrow-right"
              data-testid="import-destination-continue"
              disabled={portfolioId === "" || accountId === ""}
              onClick={() => go({ step: "file" })}
            >
              {IMPORT_COPY.continue}
            </Button>
          </div>
        </Card>
      )}

      {step === "file" && fileType !== undefined && (
        <Card data-testid="import-file-step">
          <h2 className="import-card-title">{IMPORT_FILE_TYPE_LABELS[fileType]}</h2>
          <p className="import-note">{IMPORT_COPY.fileExplanation}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORT_FILE_ACCEPT[fileType]}
            data-testid="import-file-input"
            aria-label={IMPORT_COPY.fileInputLabel}
            onChange={(event) => {
              setError(undefined);
              setDryRun(null);
              setResult(null);
              setResolutions([]);
              setTransferChoices(new Map());
              setRejectedFileName(undefined);
              const picked = event.target.files?.[0];
              // `accept` above is a *hint* to the file dialog — a user who
              // switches it to "all files" walks straight past it — so the
              // constraint is enforced here as well, and a non-CSV never
              // becomes a request at all.
              if (picked !== undefined && !isAcceptableImportFile(fileType, picked)) {
                setRejectedFileName(picked.name);
                setFile(null);
                return;
              }
              setFile(picked ?? null);
            }}
          />
          {rejectedFileName !== undefined && (
            <p
              role="alert"
              className="import-note import-note-warn"
              data-testid="import-file-rejected"
            >
              {importFileRefusalNotice(fileType)}
            </p>
          )}
          {file !== null && (
            <p className="import-note" data-testid="import-file-name">
              {file.name}
            </p>
          )}
          {writesTransactions(fileType) && (
            <p className="import-note" data-testid="import-manual-row-notice">
              {IMPORT_MANUAL_ROW_NOTICE}
            </p>
          )}
          <div className="import-actions">
            <Button
              variant="ghost"
              iconLeft="arrow-left"
              data-testid="import-back-from-file"
              onClick={() => go({ step: needsDestination(fileType) ? "destination" : "type" })}
            >
              {IMPORT_COPY.back}
            </Button>
            <Button
              variant="primary"
              iconLeft="search"
              loading={busy}
              disabled={file === null || busy}
              data-testid="import-analyse"
              onClick={() => void analyse()}
            >
              {IMPORT_COPY.analyse}
            </Button>
          </div>
        </Card>
      )}

      {step === "review" && dryRun !== null && fileType !== undefined && (
        <div data-testid="import-review-step" className="import-review">
          <ImportCountsStrip summary={dryRun} testId="import-review-counts" />
          {/*
            RF7 (FT-43): before « Confirmer l'import », never on the result
            screen. Only for the two transaction file types — an asset file
            carries no idempotency key, so the warning would be false there.
          */}
          {/* RF7 is about the **`pp2`** fingerprint recipe changing under
              files already imported. A Kerdial package is `kd1` and is new in
              this release, so no key of its can have been computed under an
              older recipe and the notice would be a false statement — it stays
              scoped to the two Portfolio-Performance transaction files. */}
          {needsDestination(fileType) && (
            <Banner tone="warn" icon="alert-triangle" testId="import-review-reimport-notice">
              {IMPORT_PP2_REIMPORT_NOTICE}
            </Banner>
          )}
          {dryRun.sections !== undefined && (
            <Card data-testid="import-review-sections">
              <h3 className="import-card-title">{IMPORT_COPY.catalogueSectionsTitle}</h3>
              <p className="import-note">{IMPORT_COPY.catalogueSectionsExplanation}</p>
              <ul className="import-reason-list">
                {Object.entries(dryRun.sections).map(([section, count]) => (
                  <li
                    key={section}
                    className="import-reason-row"
                    data-testid="import-review-section"
                  >
                    <span className="k-num import-reason-count">{count}</span>
                    <span>{catalogueSectionLabel(section)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {sharedImpactNotice !== null && (
            <Banner tone="warn" icon="alert-triangle" testId="import-review-shared-impact">
              {sharedImpactNotice}
            </Banner>
          )}
          {rerunNeeded && (
            <Banner tone="warn" icon="alert-triangle" testId="import-review-rerun-hint">
              {IMPORT_RERUN_HINT}
            </Banner>
          )}
          {fileType === "ASSETS" && (
            <Card data-testid="import-proposals-card">
              <h3 className="import-card-title">{IMPORT_COPY.proposalsTitle}</h3>
              <p className="import-note">{IMPORT_COPY.proposalsExplanation}</p>
              <ImportProposalEditor
                proposals={resolutions}
                onChange={(at, next) =>
                  setResolutions((previous) =>
                    previous.map((entry, position) => (position === at ? next : entry)),
                  )
                }
                testId="import-proposals"
              />
            </Card>
          )}
          {dryRun.transferDecisions !== undefined && dryRun.transferDecisions.length > 0 && (
            <Card data-testid="import-transfer-decisions-card">
              <h3 className="import-card-title">{IMPORT_COPY.transferDecisionsTitle}</h3>
              <p className="import-note">{IMPORT_COPY.transferDecisionsExplanation}</p>
              <ImportTransferDecisions
                decisions={dryRun.transferDecisions}
                portfolios={portfolios}
                sourcePortfolioId={portfolioId}
                choices={transferChoices}
                onChange={setTransferChoices}
                testId="import-transfer-decisions"
              />
            </Card>
          )}
          {/* A route reports rows **or** entries, never both (the wire
              contract says so, and `rowsTruncated` is one flag for whichever
              list is present). The catalogue's entries have no line number —
              a JSON document has sections and indices — so they get their own
              compact table rather than a row table with a fabricated column. */}
          {/* Warned entries import — shown, never blocking the confirm. */}
          {dryRun.warnings !== undefined && (
            <ImportEntryWarnings
              warnings={dryRun.warnings}
              warningCount={dryRun.warningCount ?? dryRun.warnings.length}
              testId="import-review-warnings"
            />
          )}
          <Card data-testid="import-review-rows-card">
            <h3 className="import-card-title">{IMPORT_COPY.unimportedRows}</h3>
            {dryRun.entries !== undefined ? (
              <ImportEntryOutcomeTable
                entries={dryRun.entries}
                truncated={dryRun.rowsTruncated}
                testId="import-review-entries"
              />
            ) : (
              <ImportRowOutcomeTable
                rows={dryRun.rows}
                truncated={dryRun.rowsTruncated}
                coveredByInvestmentFile={dryRun.byReason["COVERED_BY_INVESTMENT_FILE"] ?? 0}
                testId="import-review-rows"
              />
            )}
          </Card>
          <div className="import-actions">
            <Button
              variant="ghost"
              iconLeft="arrow-left"
              data-testid="import-back-to-file"
              onClick={() => go({ step: "file" })}
            >
              {IMPORT_COPY.changeFile}
            </Button>
            <Button
              variant="primary"
              iconLeft="check"
              loading={busy}
              // A hand-typed MIC that `exchangeMicSchema`
              // refuses blocks the confirm, because the alternative is the
              // whole-request 400 the per-field message exists to replace.
              // The server-side refusal stays as the backstop; this only
              // stops the user from walking into it.
              disabled={
                busy ||
                hasInvalidExchangeMic(resolutions) ||
                incompleteTransferDestination(transferChoices)
              }
              data-testid="import-confirm"
              onClick={() => void apply(false)}
            >
              {IMPORT_COPY.confirmImport}
            </Button>
          </div>
        </div>
      )}

      {step === "result" && result !== null && (
        <div data-testid="import-result-step" className="import-review">
          <ImportCountsStrip summary={result} testId="import-result-counts" />
          {rerunNeeded && (
            <Banner tone="warn" icon="alert-triangle" testId="import-result-rerun-hint">
              {IMPORT_RERUN_HINT}
            </Banner>
          )}
          {/* The remainder. A ceiling-sized Kerdial CSV needs more
              apply time than one request's deadline allows (876 676 ms
              measured at 20 000 rows against a 25 000 ms budget), so the rows
              past the deadline come back `APPLY_NOT_ATTEMPTED` and the designed
              remedy is to re-submit the same file — `apply` does that on its
              own while `busy`, and the notice below is for a chain that
              stopped with rows still left. */}
          {busy && (
            <p className="import-note" role="status" data-testid="import-continue-progress">
              {fill(IMPORT_COPY.continueImportProgress, {
                processed: groupThousands(String(result.rowCount - result.applyNotAttempted)),
                total: groupThousands(String(result.rowCount)),
              })}
              {stopRequested && (
                <>
                  {" "}
                  <span data-testid="import-continue-stop-requested">
                    {IMPORT_COPY.continueImportStopRequested}
                  </span>
                </>
              )}
            </p>
          )}
          {!busy && chainHalt !== undefined && (
            <Banner tone="warn" icon="alert-triangle" testId="import-continue-halted">
              {chainHalt === "noProgress"
                ? IMPORT_COPY.continueImportNoProgress
                : fill(IMPORT_COPY.continueImportRunCap, {
                    count: groupThousands(String(MAX_CHAINED_APPLY_RUNS)),
                  })}
            </Banner>
          )}
          {!busy && result.applyNotAttempted > 0 && (
            <Banner tone="warn" icon="alert-triangle" testId="import-continue-notice">
              {IMPORT_COPY.continueImportExplanation}
            </Banner>
          )}
          {result.warnings !== undefined && (
            <ImportEntryWarnings
              warnings={result.warnings}
              warningCount={result.warningCount ?? result.warnings.length}
              testId="import-result-warnings"
            />
          )}
          <Card data-testid="import-result-rows-card">
            <h3 className="import-card-title">{IMPORT_COPY.unimportedRows}</h3>
            {result.entries !== undefined ? (
              <ImportEntryOutcomeTable
                entries={result.entries}
                truncated={result.rowsTruncated}
                testId="import-result-entries"
              />
            ) : (
              <ImportRowOutcomeTable
                rows={result.rows}
                truncated={result.rowsTruncated}
                coveredByInvestmentFile={result.byReason["COVERED_BY_INVESTMENT_FILE"] ?? 0}
                testId="import-result-rows"
              />
            )}
          </Card>
          <div className="import-actions">
            {busy && (
              <Button
                variant="secondary"
                disabled={stopRequested}
                data-testid="import-continue-stop"
                onClick={requestStop}
              >
                {IMPORT_COPY.continueImportStop}
              </Button>
            )}
            {!busy && result.applyNotAttempted > 0 && file !== null && (
              <Button
                variant="primary"
                iconLeft="upload"
                data-testid="import-continue"
                onClick={() => void apply(true)}
              >
                {IMPORT_COPY.continueImport}
              </Button>
            )}
            {followUp !== undefined ? (
              <Button
                variant="primary"
                iconRight="arrow-right"
                data-testid="import-next-file"
                // A chain in flight is stopped with « Arrêter », never by
                // walking away from it mid-file.
                disabled={busy}
                onClick={() => chooseType(followUp)}
              >
                {fill(IMPORT_COPY.nextFile, { type: IMPORT_FILE_TYPE_LABELS[followUp] })}
              </Button>
            ) : (
              <Button
                variant="secondary"
                iconLeft="upload"
                data-testid="import-restart"
                disabled={busy}
                onClick={() => {
                  clearFileState();
                  go({ step: "type", type: undefined, portfolio: undefined, account: undefined });
                }}
              >
                {IMPORT_COPY.importAnother}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
