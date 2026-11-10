import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { INSTRUMENT_KIND_VALUES, type InstrumentKind } from "@kerdial/api-contracts";
import type { HoldingResponse } from "../lib/api-client.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import type { InstrumentRowData } from "../components/InstrumentTable.js";
import { InstrumentTable, isPresentError } from "../components/InstrumentTable.js";
import { InstrumentCardList } from "../components/InstrumentCardList.js";
import { AddTransactionEmptyAction } from "../components/AddTransactionEmptyAction.js";
import { EmptyState } from "../components/EmptyState.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { messageForError } from "../lib/problem-messages.js";
import {
  deriveHeldState,
  deriveInstrumentSet,
  holdingsQueryOptions,
  instrumentByIdQueryOptions,
  instrumentCatalogueQueryOptions,
  instrumentHistoryStatusQueryOptions,
  transactionsInstrumentScanQueryOptions,
  watchedIdSet,
  watchedInstrumentIdsQueryOptions,
  type TransactionScanResult,
} from "../lib/queries.js";
import { meetsInstrumentSearchMinimum } from "../lib/quick-search.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { PageHeader } from "../components/PageHeader.js";
import { Button, Card, Input, SegmentedControl, Select, StatTile } from "../components/ui/index.js";

/**
 * `InstrumentsView.tsx` — UR-27. Router-agnostic (the exact split
 * `ActivityRoute.tsx`/`ActivityView.tsx` and `PortfolioDetailRoute.tsx`/
 * `PortfolioDetailView.tsx` already establish — necessary supporting
 * plumbing, for the identical reason:
 * `InstrumentsRoute.tsx` reads `instrumentsRoute.useSearch()`, which pulls
 * in `router.js` -> `AppShell.tsx` -> `virtual:pwa-register/react`, which
 * does not resolve under plain `vitest`).
 *
 * **The instrument set (UR-26).** `holdingsQueryOptions()` (already fetched
 * elsewhere, `["portfolios","holdings","combined"]`) supplies the held half
 * immediately; `transactionsInstrumentScanQueryOptions()` supplies the
 * ever-transacted half once its bounded scan resolves.
 * `deriveInstrumentSet` unions the two — while the scan is still in flight,
 * the union is simply "held only", which is what makes the held-derived set
 * render immediately and sold-out instruments appear once the scan
 * completes ("progressive rendering"), without this screen
 * inventing a page-by-page streaming API the scan's own single-Promise
 * `queryFn` does not expose.
 *
 * **Per-row fan-out (GATE-1 case 8).** Two **background**-priority,
 * `cheapReadBudget`-bounded one-shot reads per distinct instrument id —
 * `instrumentByIdQueryOptions` (full detail) and
 * `instrumentHistoryStatusQueryOptions` (market-data status, **never**
 * `InstrumentHistoryStatus.tsx`'s own polling component) —
 * both already share `cheapReadBudget` with every other background read in
 * the app, so this screen's own peak never exceeds that budget's bound of 4
 * regardless of how many rows are in the set.
 *
 * **`kind`/`q` are client-side filters over the whole derived set** (design
 * table + `InstrumentTable.tsx`'s columns) — unlike Activity's own `type`
 * filter, this is **not** a page-scoped, dishonest filter: once the scan is
 * not `truncated`, the derived set genuinely is this tenant's entire
 * "held or transacted" instrument universe, so filtering it client-side
 * makes no completeness claim it cannot support. If the scan **is**
 * truncated, the standing note below already says so; the filter still
 * only ever narrows what is actually in `rows`.
 *
 * **The Kerdial restyle** adds the 4-up stat
 * strip above the table. Every one of its four figures is a **count over the
 * rows this screen already has** — never a ratio derived from a denominator
 * nobody publishes:
 *
 * - *Instruments suivis* — the size of UR-26's derived set.
 * - *Couverture des cours* — how many of them have a completed history, out of
 *   how many. A "96.4% of instrument-days requested" figure has no
 *   counterpart on this wire (`HistoryStatusResponse` carries dates, not
 *   ratios), and the standing rule is that a screen which cannot
 *   fill a figure honestly omits it rather than approximating it.
 * - *Cours manuel* — `quotePolicy === "MANUAL_ONLY"`.
 * - *À surveiller* — `status === "FAILED"`, the one status nothing will ever
 *   retry. "Stale" and "partial", the two other
 *   candidates for this bucket, are not states this API reports.
 *
 * A tile whose inputs have not all resolved yet renders `…`, not `0` — a zero
 * that means "still loading" is the exact "vacuous" figure this repo has
 * hit repeatedly.
 *
 * ## Catalogue mode (IB11, FR-188–FR-192)
 *
 * The screen has **two row sources**, chosen by the `mode` search param
 * (`"mine"` when absent — every existing link and bookmark lands where it
 * always did):
 *
 * | | `"mine"` (default, unchanged) | `"catalogue"` |
 * |---|---|---|
 * | Rows | `deriveInstrumentSet(heldIds, scan)` (UR-26) | `instrumentCatalogueQueryOptions` → `GET /instruments` (V10, unmodified) |
 * | `detail` per row | `instrumentByIdQueryOptions` (background) | **the list payload itself** — no per-row detail read |
 * | `historyStatus` per row | `instrumentHistoryStatusQueryOptions` (background) | the same factory, unmodified |
 * | `q`/`kind` | client-side, over the whole derived set | server-side `?query=`/`?kind=`, one page at a time |
 * | Held state | `deriveInstrumentSet`'s own (never `"none"`) | `deriveHeldState` per row, against the same two cached reads |
 * | Stat strip / subtitle | as before | not rendered / mode-specific |
 *
 * **AC-19 holds by construction, not by inspection.** Nothing above changes
 * the `"mine"` branch's inputs: `deriveInstrumentSet` is untouched and still
 * cannot return `"none"`, the same two per-row factories run at the same
 * `background` priority through the same budget, and the stat strip's four
 * counts are computed from the same `rows` as before.
 *
 * **AC-18 holds for the same reason it held before:** there is exactly one
 * `RequestBudget` in this client (`cheapReadBudget`, bound 4) and this cycle
 * adds no second one. The catalogue list is this mode's *primary* read, so it
 * takes `foreground` priority in that budget (the tier `listTransactions`
 * takes for Activity's own primary read) while the per-row status fan-out
 * stays `background` in the same instance — so a full 20-row catalogue page
 * and its 20 status reads queue against each other rather than adding a
 * second, uncoordinated ceiling.
 *
 * **Paging is honest about what it is showing**: a catalogue page is a
 * page, so the page control renders whenever the server returned a
 * `nextCursor`, and a filtered page never reads as "these are all the
 * matches".
 */
export const INSTRUMENT_VIEW_MODES = ["mine", "catalogue"] as const;
export type InstrumentViewMode = (typeof INSTRUMENT_VIEW_MODES)[number];

export interface InstrumentsSearchState {
  readonly kind?: InstrumentKind;
  readonly q?: string;
  readonly sel?: string;
  /** IB11. Absent ⇒ `"mine"`, the original view, byte-for-byte (AC-19). */
  readonly mode?: InstrumentViewMode;
  /** IB11 — the catalogue's opaque page cursor. Meaningless in `"mine"` mode, and reset whenever the mode or a filter changes. */
  readonly cursor?: string;
}

export interface InstrumentsViewProps {
  readonly search: InstrumentsSearchState;
  readonly onSearchChange: (
    updater: (prev: InstrumentsSearchState) => InstrumentsSearchState,
  ) => void;
}

const MODE_OPTIONS = [
  { value: "mine", label: "Mes instruments" },
  { value: "catalogue", label: "Catalogue complet" },
] as const;

const SUBTITLES: Readonly<Record<InstrumentViewMode, string>> = {
  // Unchanged, byte for byte (AC-19).
  mine: "Les instruments suivis et la qualité de leurs données.",
  // The screen must not keep a subtitle describing the other row source.
  // One mode-dependent string, never a second `PageHeader`.
  catalogue: "Le catalogue partagé et la qualité des données de cours.",
};

/**
 * The catalogue filter's own gate: `GET /instruments`'s
 * `listInstrumentsQuerySchema` rejects a `query` with fewer than 3
 * alphanumeric characters with a 400, so a shorter one is **withheld** rather
 * than sent — the same client-side mirror of that server gate
 * `quickSearchInstrumentsQueryOptions` uses (`quick-search.ts`). The screen
 * says so instead of silently ignoring what was typed.
 */
const CATALOGUE_QUERY_FLOOR_NOTE =
  "Saisissez au moins 3 caractères alphanumériques pour filtrer le catalogue par texte.";

const KIND_LABELS: Readonly<Record<InstrumentKind, string>> = {
  SHARE: "Action",
  ETF: "ETF",
  FUND: "Fonds",
  CRYPTO: "Crypto-actif",
  INDEX: "Indice",
  SCPI: "SCPI",
};

function matchesQuery(row: InstrumentRowData, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [row.detail?.displayName, row.detail?.symbol, row.detail?.isin]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function InstrumentsView({ search, onSearchChange }: InstrumentsViewProps) {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const mode: InstrumentViewMode = search.mode ?? "mine";
  const isCatalogue = mode === "catalogue";

  const holdingsQuery = useQuery(holdingsQueryOptions());
  const scanQuery = useQuery(transactionsInstrumentScanQueryOptions());
  // `watchlist` FR-371/W-6: **one** `GET /watchlist/ids` for the
  // whole screen — a bounded, indexed cheap read of ≤ 200 ids — from which each
  // row's `<WatchToggle>` resolves its own state by an O(1) lookup. Never a
  // read per row, and `InstrumentResponse` gains no `watched` field.
  const watchedIdsQuery = useQuery(watchedInstrumentIdsQueryOptions());

  const heldInstrumentIds = useMemo(
    () => (holdingsQuery.data?.holdings ?? []).map((h) => h.instrumentId),
    [holdingsQuery.data],
  );

  const scanResult: TransactionScanResult = scanQuery.data ?? {
    instrumentIds: [],
    pagesRead: 0,
    truncated: false,
  };

  const instrumentSet = useMemo(
    () => deriveInstrumentSet(heldInstrumentIds, scanResult),
    [heldInstrumentIds, scanResult],
  );

  // The catalogue query is this mode's primary read (`foreground`
  // priority, same `cheapReadBudget`). `enabled` keeps it off the wire
  // entirely in the default mode — a mode the user may never leave.
  // `q` is only sent once it clears the server's own 3-alphanumeric floor.
  const catalogueQueryText =
    search.q !== undefined && meetsInstrumentSearchMinimum(search.q) ? search.q.trim() : undefined;
  const catalogueQuery = useQuery({
    ...instrumentCatalogueQueryOptions({
      ...(catalogueQueryText !== undefined ? { query: catalogueQueryText } : {}),
      ...(search.kind !== undefined ? { kind: search.kind } : {}),
      ...(search.cursor !== undefined ? { cursor: search.cursor } : {}),
    }),
    enabled: isCatalogue,
  });
  const catalogueItems = catalogueQuery.data?.items ?? [];

  // The one list of ids this render fans out over — the derived set in
  // `"mine"` mode, the current catalogue page in `"catalogue"` mode. Both
  // presentations index `historyResults` by position in this list.
  const rowInstrumentIds = isCatalogue
    ? catalogueItems.map((item) => item.id)
    : instrumentSet.entries.map((entry) => entry.instrumentId);

  // A catalogue row's detail **is** the list payload, so this fan-out
  // is empty in that mode — the reason catalogue mode costs one read per row
  // instead of two.
  const detailResults = useQueries({
    queries: isCatalogue
      ? []
      : instrumentSet.entries.map((entry) => instrumentByIdQueryOptions(entry.instrumentId)),
  });
  const historyResults = useQueries({
    queries: rowInstrumentIds.map((instrumentId) =>
      instrumentHistoryStatusQueryOptions(instrumentId),
    ),
  });

  // The held half of the set already carries a priced holding in the cached
  // `["portfolios","holdings","combined"]` response, so the table's "dernier
  // cours" column costs zero extra requests. A historical (sold-out) row has
  // no such holding, and gets no price — see `InstrumentTable.tsx`'s note.
  const holdingByInstrumentId = useMemo(() => {
    const map = new Map<string, HoldingResponse>();
    for (const held of holdingsQuery.data?.holdings ?? []) map.set(held.instrumentId, held);
    return map;
  }, [holdingsQuery.data]);

  // FR-189/IB12: the two membership sets a catalogue row is cross-referenced
  // against, built once per render from the reads this screen already keeps
  // mounted in both modes — so the indicator costs no request of its own.
  const heldIdSet = useMemo(() => new Set(heldInstrumentIds), [heldInstrumentIds]);
  const transactedIdSet = useMemo(
    () => new Set(scanResult.instrumentIds),
    [scanResult.instrumentIds],
  );

  /** `undefined` until the ids read answers (loading **or** error) — which is what makes every toggle render its `"unknown"` state instead of a false « Suivre ». */
  const watchedIds = watchedIdSet(watchedIdsQuery.data);

  const rows: InstrumentRowData[] = isCatalogue
    ? catalogueItems.map((item, index) => ({
        instrumentId: item.id,
        heldState: deriveHeldState(item.id, heldIdSet, transactedIdSet),
        detail: item,
        detailError: undefined,
        historyStatus: historyResults[index]?.data,
        historyStatusError: historyResults[index]?.error,
        // A catalogue row the tenant happens to hold gets the same cached
        // price the default view gives it; one it does not hold has none on
        // this wire, and renders `—` (`InstrumentTable.tsx`'s own note).
        lastPrice: holdingByInstrumentId.get(item.id)?.currentPrice,
      }))
    : instrumentSet.entries.map((entry, index) => ({
        instrumentId: entry.instrumentId,
        heldState: entry.heldState,
        detail: detailResults[index]?.data,
        detailError: detailResults[index]?.error,
        historyStatus: historyResults[index]?.data,
        historyStatusError: historyResults[index]?.error,
        lastPrice: holdingByInstrumentId.get(entry.instrumentId)?.currentPrice,
      }));

  // Catalogue mode's filtering is the server's (`?query=`/`?kind=`), so the
  // page is rendered as received — filtering it again here would hide rows the
  // page control claims are part of the result.
  const filteredRows = isCatalogue
    ? rows
    : rows.filter((row) => {
        if (search.kind !== undefined && row.detail?.kind !== search.kind) return false;
        if (search.q !== undefined && !matchesQuery(row, search.q)) return false;
        return true;
      });

  const isInitialLoading = isCatalogue
    ? catalogueQuery.isLoading
    : holdingsQuery.isLoading && rows.length === 0;
  const hasActiveFilter = search.kind !== undefined || (search.q ?? "").trim() !== "";
  const showCatalogueQueryFloorNote =
    isCatalogue && (search.q ?? "").trim() !== "" && catalogueQueryText === undefined;
  const nextCursor = catalogueQuery.data?.nextCursor ?? null;

  // A count is only shown once every per-row read it is derived from has
  // settled; before that it is `…`, never `0`.
  const historySettled = rows.every(
    (row) => row.historyStatus !== undefined || isPresentError(row.historyStatusError),
  );
  const detailSettled = rows.every(
    (row) => row.detail !== undefined || isPresentError(row.detailError),
  );
  const completeCount = rows.filter((row) => row.historyStatus?.status === "COMPLETE").length;
  const manualCount = rows.filter((row) => row.detail?.quotePolicy === "MANUAL_ONLY").length;
  const failedCount = rows.filter((row) => row.historyStatus?.status === "FAILED").length;

  function resetFilters(): void {
    onSearchChange((prev) => ({ ...prev, kind: undefined, q: undefined, cursor: undefined }));
  }

  function switchMode(next: InstrumentViewMode): void {
    // A cursor issued by one row source means nothing in the other, so
    // it is dropped on every mode switch. The `kind`/`q` filters survive —
    // they express the same intent in both modes.
    onSearchChange((prev) => ({
      ...prev,
      mode: next === "mine" ? undefined : next,
      cursor: undefined,
    }));
  }

  return (
    <section data-testid="instruments-screen">
      <PageHeader title={INSTRUMENT_COPY.breadcrumbInstruments} subtitle={SUBTITLES[mode]} />

      {holdingsQuery.isError && (
        <div className="mb-2">
          <ValuationErrorState
            error={holdingsQuery.error}
            testId="instruments-holdings-error"
            panelLabel={INSTRUMENT_COPY.listPanel}
            onRetry={() => void holdingsQuery.refetch()}
          />
        </div>
      )}
      {/* Both notes describe the *derived* row set's own completeness, so they
          are stated only where that set is what is on screen. In catalogue
          mode the rows are the catalogue's own page, and a truncated scan
          costs at most a « Historique » label, never a missing row. */}
      {!isCatalogue && scanQuery.isError && (
        <p role="alert" data-testid="instruments-scan-error" className="mb-2 k-inst-note-loss">
          {INSTRUMENT_COPY.scanErrorPrefix} {messageForError(scanQuery.error).text}
        </p>
      )}
      {!isCatalogue && scanQuery.isLoading && (
        <p data-testid="instruments-scan-loading" className="mb-2 k-inst-note">
          {INSTRUMENT_COPY.scanLoading}
        </p>
      )}
      {!isCatalogue && !scanQuery.isLoading && scanQuery.data?.truncated === true && (
        <p data-testid="instruments-truncated-note" className="mb-2 k-inst-note-warn">
          {INSTRUMENT_COPY.historyScanTruncated}
        </p>
      )}
      {isCatalogue && catalogueQuery.isError && (
        <p role="alert" data-testid="instruments-catalogue-error" className="mb-2 k-inst-note-loss">
          {INSTRUMENT_COPY.catalogueErrorPrefix} {messageForError(catalogueQuery.error).text}
        </p>
      )}

      {/* The 4-up strip — one card with hairline dividers, never
          four nested cards. **Not rendered in catalogue mode**:
          every one of its four figures counts over the *tracked* set, and
          « Instruments suivis: 20 » over a page of the shared catalogue would
          be a false figure. */}
      {!isCatalogue && rows.length > 0 && (
        <div className="mb-4">
          <Card padding="none" data-testid="instruments-stat-strip">
            <div className="k-inst-stats">
              <StatTile
                data-testid="instruments-stat-total"
                label={INSTRUMENT_COPY.statTracked}
                value={<span className="k-num">{rows.length}</span>}
                delta={<span className="k-inst-stat-hint">{INSTRUMENT_COPY.statTrackedHint}</span>}
              />
              <StatTile
                data-testid="instruments-stat-coverage"
                label={INSTRUMENT_COPY.statCoverage}
                hintTerm="coverage"
                value={
                  <span className="k-num">
                    {historySettled ? `${completeCount} / ${rows.length}` : "…"}
                  </span>
                }
                delta={<span className="k-inst-stat-hint">{INSTRUMENT_COPY.statCoverageHint}</span>}
              />
              <StatTile
                data-testid="instruments-stat-manual"
                label={INSTRUMENT_COPY.statManual}
                value={<span className="k-num">{detailSettled ? manualCount : "…"}</span>}
                delta={<span className="k-inst-stat-hint">{INSTRUMENT_COPY.statManualHint}</span>}
              />
              <StatTile
                data-testid="instruments-stat-attention"
                label={INSTRUMENT_COPY.statAttention}
                value={
                  <span
                    className={`k-num${historySettled && failedCount > 0 ? " k-inst-stat-alert" : ""}`}
                  >
                    {historySettled ? failedCount : "…"}
                  </span>
                }
                delta={
                  <span className="k-inst-stat-hint">{INSTRUMENT_COPY.statAttentionHint}</span>
                }
              />
            </div>
          </Card>
        </div>
      )}

      <div className="k-inst-filters mb-4">
        {/* The two-option control, in the existing filter row. A radio
            group, not two buttons — one choice, arrow-key navigable, which is
            what `SegmentedControl` already gives every other single-choice
            control in this app. */}
        <div className="k-inst-mode" data-testid="instruments-mode-toggle" data-mode={mode}>
          <SegmentedControl
            label={INSTRUMENT_COPY.filterSource}
            size="sm"
            value={mode}
            options={[...MODE_OPTIONS]}
            onChange={(value) => switchMode(value === "catalogue" ? "catalogue" : "mine")}
          />
        </div>

        <div className="k-inst-filter-kind">
          <Select
            label={INSTRUMENT_COPY.filterKind}
            data-testid="instruments-filter-kind"
            value={search.kind ?? ""}
            options={[
              { value: "", label: INSTRUMENT_COPY.filterAllKinds },
              ...INSTRUMENT_KIND_VALUES.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
            ]}
            onChange={(event) =>
              onSearchChange((prev) => ({
                ...prev,
                kind:
                  event.target.value === "" ? undefined : (event.target.value as InstrumentKind),
                // A cursor was computed against the previous filter's own
                // result set, so any filter change starts back at page 1 —
                // `ActivityView.tsx`'s identical rule.
                cursor: undefined,
              }))
            }
          />
        </div>

        <div className="k-inst-filter-query">
          <Input
            label={INSTRUMENT_COPY.filterQuery}
            type="text"
            iconLeft="search"
            data-testid="instruments-filter-query"
            placeholder={INSTRUMENT_COPY.filterQueryPlaceholder}
            value={search.q ?? ""}
            onChange={(event) =>
              onSearchChange((prev) => ({
                ...prev,
                q: event.target.value === "" ? undefined : event.target.value,
                cursor: undefined,
              }))
            }
          />
        </div>

        {hasActiveFilter && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="instruments-filter-reset"
            onClick={resetFilters}
          >
            {INSTRUMENT_COPY.resetFilters}
          </Button>
        )}
      </div>

      {showCatalogueQueryFloorNote && (
        <p data-testid="instruments-catalogue-query-floor" className="mb-2 k-inst-note-warn">
          {CATALOGUE_QUERY_FLOOR_NOTE}
        </p>
      )}

      {isInitialLoading && (
        <PanelLoading
          panelLabel={isCatalogue ? INSTRUMENT_COPY.loadingCatalogue : INSTRUMENT_COPY.loadingOwned}
          testId="instruments-loading"
        />
      )}

      {/* UR-36 `zero-instruments` — the causal link ("this list is derived from
          holdings ∪ transactions") is the explanation, and the action that
          actually fills it is a transaction, not an instrument. It is a claim
          about the *tracked* set, so catalogue mode never renders it (only the
          filtered-empty card is shown). */}
      {!isCatalogue && !isInitialLoading && rows.length === 0 && (
        <EmptyState
          id="zero-instruments"
          testId="instruments-empty-no-instruments"
          action={
            <AddTransactionEmptyAction
              stateId="zero-instruments"
              testId="instruments-empty-add-transaction"
            />
          }
        />
      )}

      {!isInitialLoading &&
        filteredRows.length === 0 &&
        (isCatalogue || rows.length > 0) &&
        !catalogueQuery.isError && (
          <Card data-testid="instruments-empty-filtered">
            <p className="k-inst-note">{INSTRUMENT_COPY.noMatchingInstruments}</p>
            <div className="mt-3">
              <Button
                variant="secondary"
                size="sm"
                data-testid="instruments-empty-filtered-reset"
                onClick={resetFilters}
              >
                {INSTRUMENT_COPY.resetFilters}
              </Button>
            </div>
          </Card>
        )}

      {filteredRows.length > 0 &&
        (isDesktop ? (
          <InstrumentTable
            rows={filteredRows}
            selectedInstrumentId={search.sel}
            watchedIds={watchedIds}
          />
        ) : (
          <InstrumentCardList
            rows={filteredRows}
            selectedInstrumentId={search.sel}
            reloadOnEveryRow={isCatalogue}
            watchedIds={watchedIds}
          />
        ))}

      {/* RB7: a catalogue page is a *page*. The control renders whenever
          the server issued a `nextCursor`, so a filtered page can never read
          as a complete result set; « Première page » appears once the user has
          left it, since the offset cursors this route issues are forward-only
          (the same shape `ActivityView.tsx` pages with). */}
      {isCatalogue && (nextCursor !== null || search.cursor !== undefined) && (
        <div className="k-inst-pagination mt-4" data-testid="instruments-catalogue-pagination">
          {search.cursor !== undefined && (
            <Button
              variant="ghost"
              iconLeft="chevron-left"
              data-testid="instruments-catalogue-first-page"
              onClick={() => onSearchChange((prev) => ({ ...prev, cursor: undefined }))}
            >
              {INSTRUMENT_COPY.firstPage}
            </Button>
          )}
          {nextCursor !== null && (
            <Button
              variant="secondary"
              iconRight="chevron-right"
              data-testid="instruments-catalogue-next-page"
              onClick={() => onSearchChange((prev) => ({ ...prev, cursor: nextCursor }))}
            >
              {INSTRUMENT_COPY.nextPage}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
