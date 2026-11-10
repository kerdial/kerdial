import { Fragment, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import type { HistoryStatusResponse, InstrumentDetailResponse } from "../lib/api-client.js";
import type { InstrumentHeldState } from "../lib/queries.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { messageForError } from "../lib/problem-messages.js";
import { formatIsoDateFr, statusMessage } from "../lib/history-status-copy.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { AssetClassChip, Badge, Card, SortableHeader, type BadgeTone } from "./ui/index.js";
import {
  ariaSortFor,
  compareDecimalText,
  compareIso,
  compareRank,
  compareText,
  nextSortState,
  sortRows,
  type SortState,
} from "../lib/table-sort.js";
import { Figure, type ValuedAmount } from "./Figure.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { WatchToggle } from "./WatchToggle.js";
import { historyStatusLabel, historyStatusTone } from "../lib/history-status-badge.js";
import { sectorDisplayLabel } from "../lib/sector-display.js";

/**
 * `InstrumentTable.tsx` / `InstrumentCardList.tsx` — UR-27, restyled to the Kerdial skin.
 * One row per member of UR-26's derived instrument set
 * (`deriveInstrumentSet`), each enriched by two **background**-priority,
 * `cheapReadBudget`-bounded, one-shot reads —
 * `instrumentByIdQueryOptions` (name/kind/MIC/currency/quote policy/symbol)
 * and `instrumentHistoryStatusQueryOptions` (market-data status) —
 * `InstrumentsView.tsx`'s own `useQueries` calls, passed down here as plain
 * data, never refetched by this component.
 *
 * **Never mounts `InstrumentHistoryStatus.tsx`'s own polling component**
 * The market-data-status cell renders through
 * `history-status-copy.ts`'s `statusMessage` directly, over a one-shot
 * query result the caller already fetched — N rows therefore never becomes
 * N independent 3-second pollers with N 2-minute ceilings.
 *
 * Columns, in order, with IR-13's sector column added: instrument (with
 * the status **dot**) · type · **sector** · symbol · exchange · price source ·
 * last price · updated · coverage · history badge · action. `symbol` is
 * rendered **only when present**
 * (frequently `null` for SHARE/ETF/FUND, never a
 * cell that reads as broken): its column falls back to a plain `—` carrying
 * no `instrument-symbol` handle at all.
 *
 * **The status is a dot, never a coloured row fill**. The dot
 * takes its tone from {@link historyStatusTone} — the same map the history
 * badge beside it uses, so colour and text cannot disagree — and the row's own
 * background is reserved for hover and nothing else. `InstrumentTable.test.tsx`
 * asserts the negative half: five rows differing only in status are byte-for-
 * byte identical in class and style.
 *
 * ## Columns this wire cannot fully answer
 *
 * - **Last price** exists only for a *currently held* instrument, from the
 *   already-cached `["portfolios","holdings","combined"]` response
 *   (`InstrumentsView.tsx` passes it down as `lastPrice`, zero extra
 *   requests). A sold-out/historical row has no price on this wire, and a
 *   per-row `GET /instruments/:id/prices` would blow the per-row fan-out
 *   bound GATE-1 case 8 exists to hold — so it renders `—`.
 * - **Coverage** would naturally be a *percentage of instrument-days*. Nothing in
 *   this product computes that: `HistoryStatusResponse` carries dates, not
 *   ratios. The column therefore shows the honest datum it does have — the
 *   date coverage starts from (`earliestBackfilledDate`) — rather than a
 *   percentage derived from a denominator nobody has.
 * - **Overflow menu**: no menu primitive exists in the kit (there is no
 *   `@radix-ui/react-dropdown-menu` in `web/package.json`), and every item the
 *   mock's menu carries is on the instrument's own detail screen, one click
 *   away through the action that *is* rendered.
 */
/**
 * FR-309/SD-6 (IK-12) — the two instruments-list tiles are a monogram of the
 * **display name**, never of `symbol`.
 *
 * `symbol` is frequently `null` for SHARE/ETF/FUND (this module's own header
 * records it, and the symbol column falls back to a bare `—` for exactly that
 * reason), so a symbol-derived monogram would be blank on the rows that need
 * it most. Three letters, the same rule the holdings tile uses —
 * `HoldingsTable.tsx`'s `TILE_LETTERS`, which stays where it is; declared
 * locally rather than imported across component files, with
 * `InstrumentIconTile.test.tsx` pinning the two to the same number so they
 * cannot drift.
 */
const LIST_TILE_LETTERS = 3;

export interface InstrumentRowData {
  readonly instrumentId: string;
  readonly heldState: InstrumentHeldState;
  readonly detail: InstrumentDetailResponse | undefined;
  readonly detailError: unknown;
  readonly historyStatus: HistoryStatusResponse | undefined;
  readonly historyStatusError: unknown;
  /** The held instrument's current price, from the cached holdings read. Absent for a historical (sold-out) row — see this module's own note. */
  readonly lastPrice?: ValuedAmount;
}

/**
 * IB12: the
 * third label, for the state only the catalogue row source can produce
 * (`deriveHeldState` → `"none"`). `deriveInstrumentSet` never returns it, so
 * no row in the default « Mes instruments » view can ever carry it — see that
 * function's own doc comment.
 */
const HELD_STATE_LABELS: Readonly<Record<InstrumentHeldState, string>> = {
  held: "Détenu",
  historical: "Historique",
  none: "Jamais détenu",
};

/** Shared across `InstrumentTable`/`InstrumentCardList` so the two never diverge on wording for the same underlying state. */
export function heldStateLabel(state: InstrumentHeldState): string {
  return HELD_STATE_LABELS[state];
}

/**
 * Whether a query result's `error` slot actually holds a failure.
 *
 * TanStack Query sets `error` to **`null`**, not `undefined`, while a query is
 * merely pending — so a bare `!== undefined` check reads every in-flight read
 * as failed. Found by the stat-strip test, which pinned a never-resolving
 * history read and got a settled count back instead of "still loading". One
 * predicate, used by every error-shaped branch in this module, so the mistake
 * cannot be made again per call site.
 */
export function isPresentError(error: unknown): boolean {
  return error !== undefined && error !== null;
}

/** Shared across both presentations for the market-data-status cell/line — never a raw error, never a blank cell while still loading. */
export function marketDataStatusText(row: InstrumentRowData): string {
  if (row.historyStatus !== undefined) return statusMessage(row.historyStatus);
  if (isPresentError(row.historyStatusError)) return messageForError(row.historyStatusError).text;
  return "Chargement…";
}

export type HistoryStatus = HistoryStatusResponse["status"];

/**
 * **The** history-status tone map: complete = gain, in
 * progress = brand, pending = warn, failed = loss. One map, deliberately
 * exported rather than re-typed: the instruments list, the instrument detail
 * screen and the Contrôles screen all render this status, and three
 * independent copies is exactly how "failed" ends up amber on one screen and
 * red on another. `ControlsTable.tsx`/`ControlsCardList.tsx` already import
 * this module's `heldStateLabel`/`marketDataStatusText` for the same reason.
 *
 * `NONE` is the one status the design never saw — it is this product's
 * "no automatic backfill was ever requested" (terminal, per the
 * `instrument-create-ux` F-3 finding). It takes **neutral**, not warn: nothing
 * is wrong with a FUND or a MANUAL_ONLY instrument that was never queued, and
 * colouring it as a problem would be the same false signal the copy in
 * `history-status-copy.ts` was fixed to stop making.
 */
// The tone and label maps moved to `lib/history-status-badge.ts` — Contrôles
// needs the identical map and two copies are one edit away from disagreeing.
// Re-exported here so this module's existing importers do not all have to move.
export { historyStatusLabel, historyStatusTone };

export interface HistoryStatusBadgeProps {
  /** `undefined` while the one-shot read is still in flight, or when it failed. */
  readonly status: HistoryStatus | undefined;
  readonly failedToLoad?: boolean;
  readonly testId?: string;
}

/**
 * The badge itself, shared for the same reason the map is: the list, the
 * detail screen and Contrôles must render an identical pill for an identical
 * status. An unresolved read is neutral and says so — never an optimistic
 * "complete" while nothing has answered.
 */
export function HistoryStatusBadge({
  status,
  failedToLoad = false,
  testId = "instrument-history-badge",
}: HistoryStatusBadgeProps) {
  if (status === undefined) {
    return (
      <Badge tone="neutral" data-testid={testId} data-status={failedToLoad ? "ERROR" : "LOADING"}>
        {failedToLoad ? COMMON_COPY.unavailable : INSTRUMENT_COPY.loading}
      </Badge>
    );
  }
  return (
    <Badge tone={historyStatusTone(status)} data-testid={testId} data-status={status}>
      {historyStatusLabel(status)}
    </Badge>
  );
}

/** The row's status **dot** — same tone as the badge, never a row fill. */
export function historyStatusDotTone(row: InstrumentRowData): BadgeTone {
  return row.historyStatus === undefined ? "neutral" : historyStatusTone(row.historyStatus.status);
}

/**
 * The row's sector text (IR-13) — through `sectorDisplayLabel`, the single
 * code-to-text site in `web`, so this cell, the detail row and the
 * breakdown legend cannot disagree. « Non classé » both for an unclassified
 * instrument (AC-5) and while the row's own detail read is still in flight:
 * both are honestly "no sector to show yet", and a blank cell in a table
 * column reads as a defect ("never a blank cell").
 *
 * Shared by `InstrumentTable`/`InstrumentCardList` for the same reason
 * `coverageText`/`updatedText` are: two copies is one edit away from two
 * different answers for the same row.
 */
export function sectorText(row: InstrumentRowData): string {
  return sectorDisplayLabel(row.detail?.sectorCode);
}

/** `AUTO`/`MANUAL_ONLY` is the only price-source signal on this wire. */
export function priceSourceLabel(detail: InstrumentDetailResponse | undefined): string {
  if (detail === undefined) return "—";
  return detail.quotePolicy === "MANUAL_ONLY" ? "Saisie manuelle" : "Automatique";
}

/** Coverage, honestly: the date the retrieved history starts from. See this module's own note. */
export function coverageText(row: InstrumentRowData): string {
  const earliest = row.historyStatus?.earliestBackfilledDate;
  return earliest === null || earliest === undefined ? "—" : formatIsoDateFr(earliest);
}

/**
 * The two formats the freshness cell needs, built once at module scope
 * like `Figure.tsx`'s and `TransactionFxDisclosure.tsx`'s own — an
 * `Intl.DateTimeFormat` per row would be rebuilt for every one of hundreds of
 * virtualised rows.
 *
 * Rendered in the **viewer's** zone, not UTC: `lastQuoteAt` is an instant (a
 * timestamptz the API hands over as ISO-8601 UTC), and « reçu à 12:44 » is
 * only meaningful as the time on the clock of whoever is reading it. The
 * zoneless calendar dates on this screen — the backfill bookmark, the series
 * date, coverage — keep going through `formatIsoDateFr`'s pure string
 * rearrangement instead, which is what stops a `priceDate` from shifting a day
 * for a reader west of UTC.
 */
const FR_DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });
const FR_DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

/**
 * « Historique jusqu'au » — the backfill **resume bookmark**
 * (`latest_backfilled_date`), which is what it has always been and is now
 * labelled as such.
 *
 * This used to be `updatedText`, rendered under « Mise à jour », and that was
 * the whole of that fix: only `instrument-backfill-job.ts` and
 * `gap-repair-job.ts` write that column, so a « Actualiser les cours » that
 * fetched, wrote today's price and moved the price cell beside this one left
 * this date days old (measured: NOV priced 2026-09-07 under a bookmark of
 * 2026-09-01) — a working button reading as a broken one. It is a genuine
 * fact worth showing, next to the history status it belongs to; it is simply
 * not price freshness. {@link priceFreshnessText} is that.
 */
export function historyThroughText(status: HistoryStatusResponse | undefined): string {
  const latest = status?.latestBackfilledDate;
  return latest === null || latest === undefined ? "—" : formatIsoDateFr(latest);
}

/**
 * « Cours du » — when this instrument's price was last observed.
 *
 * **The quote instant wins over the series date**, and the fallback is not
 * cosmetic: `lastQuoteAt` has intraday precision, so a refresh moves it even
 * on a day whose price did not change, while `latestPriceDate` is the newest
 * daily point (automated series merged with this tenant's manual ones) and is
 * the only one of the two a `MANUAL_ONLY` instrument has at all. Neither is
 * synthesised from the other: an instrument with no quote row and no point
 * reads « — », honestly.
 *
 * Date only, because this renders in an 88px column. The instant itself —
 * which is the half that proves a refresh landed — is the cell's `title`,
 * through {@link priceFreshnessDetail}, the same treatment the status cell
 * beside it already gives its own long sentence.
 */
export function priceFreshnessText(status: HistoryStatusResponse | undefined): string {
  const quotedAt = status?.lastQuoteAt;
  if (quotedAt !== null && quotedAt !== undefined) return FR_DATE.format(new Date(quotedAt));
  const seriesDate = status?.latestPriceDate;
  return seriesDate === null || seriesDate === undefined ? "—" : formatIsoDateFr(seriesDate);
}

/**
 * The same two-value preference as {@link priceFreshnessText}, at the
 * precision the fact actually has: the quote to the minute, the series point
 * to the day. For surfaces with horizontal room — the mobile card, the detail
 * screen — where the minutes can be read directly instead of hidden in a
 * `title`.
 */
export function priceFreshnessInstantText(status: HistoryStatusResponse | undefined): string {
  const quotedAt = status?.lastQuoteAt;
  if (quotedAt !== null && quotedAt !== undefined) return FR_DATE_TIME.format(new Date(quotedAt));
  const seriesDate = status?.latestPriceDate;
  return seriesDate === null || seriesDate === undefined ? "—" : formatIsoDateFr(seriesDate);
}

/**
 * The sentence behind {@link priceFreshnessText} — which of the two
 * observations the cell is showing, and at what time when it has one. Says
 * « Aucun cours reçu » rather than nothing when the row has neither, so the
 * `—` above is never left to be read as a loading state.
 */
export function priceFreshnessDetail(status: HistoryStatusResponse | undefined): string {
  const quotedAt = status?.lastQuoteAt;
  if (quotedAt !== null && quotedAt !== undefined) {
    return `Dernier cours reçu le ${FR_DATE_TIME.format(new Date(quotedAt))}`;
  }
  const seriesDate = status?.latestPriceDate;
  if (seriesDate !== null && seriesDate !== undefined) {
    return `Dernier point de série du ${formatIsoDateFr(seriesDate)}`;
  }
  return "Aucun cours reçu";
}

export interface InstrumentTableProps {
  readonly rows: readonly InstrumentRowData[];
  /** UR-7's `sel` search param — the row to highlight/scroll to, if any (this module's own doc comment on the ambiguity `sel` resolves). */
  readonly selectedInstrumentId?: string;
  /**
   * `watchlist` FR-371/W-6 — the instruments this tenant watches, as the id set
   * `InstrumentsView` builds once per render from its single
   * `GET /watchlist/ids` read. `undefined` means that read has produced no data
   * yet (loading **or** error), and every row's toggle then renders its
   * `"unknown"` state rather than a false « Suivre ».
   *
   * Optional so a caller that has no watch capability — and this component's
   * own suite, whose assertions this cycle may not modify (AC-347) — needs no
   * change; `InstrumentsView` always passes it.
   */
  readonly watchedIds?: ReadonlySet<string>;
}

/**
 * IB13 — where
 * `InstrumentReloadButton` renders on this screen.
 *
 * **`InstrumentTable` no longer reads this.** The desktop table dropped its
 * action column so the whole row could become the link to the detail screen,
 * and a `<button>` nested inside an `<a>` is invalid HTML that swallows its own
 * clicks. The reload control moved to the detail screen, which is
 * unconditional — it is one instrument, so there is no per-row predicate to
 * apply. This predicate therefore has exactly one remaining reader,
 * `InstrumentCardList` (mobile, where the row is not an anchor), and IB13's
 * two-mode rule below is still the rule *there*.
 *
 * - **Default (« Mes instruments ») mode**: on a `FAILED` row and nowhere else
 *   (AC-15) — the one status nothing retries on its own, and the only one
 *   where a reload is the obvious next move.
 * - **Catalogue mode** (`reloadOnEveryRow`): on every row (AC-21). A catalogue
 *   row is frequently one the tenant has never held, whose history was seeded
 *   `PENDING` at install and may sit at any status; the answer is
 *   that the affordance is unconditional there, and the endpoint's four
 *   distinguishable rejections (409/400/429/503) are what say "not this one,
 *   not now" — in French, from the server, rather than from a client-side
 *   guess that could disagree with it.
 *
 * **Never on an SCPI** (`scpi` FR-610): it has no provider route, so
 * the endpoint refuses it — the detail screen hides the action for the same
 * reason.
 */
export function showReloadAffordance(row: InstrumentRowData, reloadOnEveryRow: boolean): boolean {
  if (row.detail?.kind === "SCPI") return false;
  return reloadOnEveryRow || row.historyStatus?.status === "FAILED";
}

const ESTIMATED_ROW_HEIGHT_PX = 56;

/** Derived from {@link COLUMNS} below, so the sortable keys and the rendered columns cannot drift apart. */
type InstrumentSortKey = (typeof COLUMNS)[number]["key"];

/**
 * `history` sorts by *how much attention the row needs*, not alphabetically:
 * a FAILED instrument is the one nothing will ever retry, so an ascending sort on that column puts the actionable rows first.
 * Alphabetical order on these five would be meaningless.
 */
const HISTORY_STATUS_ORDER = ["FAILED", "NONE", "PENDING", "IN_PROGRESS", "COMPLETE"] as const;

/**
 * The value each column orders by. Text columns fall through to the collator;
 * `price` is a decimal string parsed through the money codec; `updated` is an
 * ISO date, which compares lexicographically *and* chronologically.
 *
 * `undefined` means "no value", which `sortRows` keeps at the bottom in both
 * directions — a row still loading its detail, a sold-out row with no price, or
 * an instrument whose history never ran should not displace real data on an
 * ascending sort.
 */
function instrumentSortValue(row: InstrumentRowData, key: InstrumentSortKey): string | undefined {
  switch (key) {
    case "name":
      return row.detail?.displayName;
    case "kind":
      return row.detail?.kind;
    case "sector":
      return row.detail?.sectorCode ?? undefined;
    case "symbol":
      return row.detail?.symbol ?? undefined;
    case "place":
      return row.detail?.exchangeMic ?? undefined;
    case "price":
      return row.lastPrice?.amount;
    // The column sorts by *freshness*, on the same two-value preference
    // the cell renders — the quote instant when there is one, the series date
    // otherwise. Both are lexicographically ordered by their own format, and
    // they are never compared against each other: an ISO instant
    // ("2026-09-07T10:44:43Z") sorts above a bare date ("2026-09-07") for the
    // same day, which is the order those two facts are actually in.
    case "quotedAt":
      return row.historyStatus?.lastQuoteAt ?? row.historyStatus?.latestPriceDate ?? undefined;
    case "history":
      return row.historyStatus?.status;
  }
}

const COLUMNS = [
  { key: "name", label: "Instrument", numeric: false },
  { key: "kind", label: "Type", numeric: false },
  // IR-13: one sector column, beside the asset-class one it complements.
  // **No industry column** — OD-2/AC-8 keeps the provider's opaque detail
  // label to the instrument detail surface alone, and a list is exactly where
  // an unbounded provider string would push every other column out.
  { key: "sector", label: "Secteur", numeric: false },
  { key: "symbol", label: "Symbole", numeric: false },
  { key: "place", label: "Place", numeric: false },
  // **Eight columns, not eleven.** The table used to carry « Source du cours »,
  // « Couverture » and an « Action » column, and at ~1016px of fixed width
  // inside a 248px rail it could not fit a 1280px viewport — every session
  // started by scrolling the card sideways to read anything past the price.
  // The three that went are the three a *list* was the wrong place for:
  // `quotePolicy` and coverage are per-instrument facts the detail screen
  // states in full, and the « Voir » link duplicated what clicking the row
  // now does on its own. `InstrumentCardList` still shows all three — a card
  // has vertical room and never scrolls sideways.
  { key: "price", label: "Dernier cours", numeric: true },
  // « Cours du », not « Mise à jour » — the column now reports the last
  // *observation* (quote instant, else newest series point), which is what a
  // reader takes "mise à jour" to mean and what « Actualiser les cours »
  // moves. The backfill bookmark that used to sit here has its own column
  // beside the status it belongs to.
  { key: "quotedAt", label: "Cours du", numeric: true },
  // **No « Hist. jusqu'au » column.** The backfill resume bookmark once had
  // its own column here, next to the status it belongs to; asked for on
  // 2026-09-08, it is off the *list* again. It is an operator-grade fact about
  // one instrument's backfill, and a reader scanning eighty rows for a price
  // never needs it — the instrument **detail** screen still states it in full
  // (`InstrumentDetailView.tsx`, through the same `historyThroughText`), which
  // is why that helper stays exported. What that fix addressed is untouched: the fact
  // was wrong *because it was labelled « Mise à jour » beside the price*, and
  // « Cours du » beside it is still the observation, not the bookmark.
  { key: "history", label: "Historique", numeric: false },
] as const;

/**
 * Desktop virtualised table. `@tanstack/react-virtual` unconditionally (the
 * same convention `HoldingsTable.tsx` already uses) rather than only past a
 * ~200-row threshold — a small fixture windows to "every row", which is
 * behaviourally identical to not virtualising at all, so there is no
 * observable difference below the threshold and one fewer conditional to
 * get wrong above it.
 */
export function InstrumentTable({ rows, selectedInstrumentId, watchedIds }: InstrumentTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [sort, setSort] = useState<SortState<InstrumentSortKey> | undefined>(undefined);

  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        sort,
        (a, b, key) => {
          if (key === "history") {
            return compareRank(
              instrumentSortValue(a, key) as HistoryStatus | undefined,
              instrumentSortValue(b, key) as HistoryStatus | undefined,
              HISTORY_STATUS_ORDER,
            );
          }
          if (key === "price") {
            return compareDecimalText(instrumentSortValue(a, key), instrumentSortValue(b, key));
          }
          if (key === "quotedAt") {
            return compareIso(instrumentSortValue(a, key), instrumentSortValue(b, key));
          }
          return compareText(instrumentSortValue(a, key), instrumentSortValue(b, key));
        },
        (row, key) => instrumentSortValue(row, key) === undefined,
      ),
    [rows, sort],
  );

  /**
   * Window-scrolled, not container-scrolled — see `HoldingsTable.tsx`'s own
   * note. `scrollMargin` carries this card's offset from the top of the
   * document, without which every row would render that far too low.
   */
  const rowVirtualizer = useWindowVirtualizer({
    count: sortedRows.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 5,
    scrollMargin: scrollRef.current?.offsetTop ?? 0,
  });

  return (
    <Card padding="none" data-testid="instrument-table">
      <div role="row" data-testid="instrument-table-header" className="k-inst-grid k-inst-head">
        {/* Every column sorts. `aria-sort` lives on the columnheader cell and
            the action lives on the button inside it — the header cells are
            grid `<span>`s, not `<th>`s, so nothing here is focusable unless a
            real control provides it. */}
        {COLUMNS.map((column) => (
          <span
            key={column.key}
            role="columnheader"
            aria-sort={ariaSortFor(sort, column.key)}
            className={column.numeric ? "k-inst-cell-right" : undefined}
          >
            <SortableHeader
              label={column.label}
              sortKey={column.key}
              state={sort}
              onToggle={(key) => {
                setSort((current) => nextSortState(current, key));
              }}
              numeric={column.numeric}
              testId={`instrument-sort-${column.key}`}
            />
          </span>
        ))}
      </div>
      <div ref={scrollRef} data-testid="instrument-table-scroll" className="k-inst-scroll">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = sortedRows[virtualRow.index];
            if (row === undefined) return null;
            const isSelected = row.instrumentId === selectedInstrumentId;
            const symbol = row.detail?.symbol;

            return (
              /* The whole row is the link, rather than a « Voir » cell inside
                 it. A real `<Link>` (not an `onClick` on a `<div>`) is what
                 keeps the keyboard, middle-click, "open in new tab" and the
                 focus ring working for free — an `onClick` row would have had
                 to re-implement all four, and historically re-implements the
                 first one badly. It is safe to make the row itself the anchor
                 only because the reload button that used to sit in the action
                 cell has moved to the detail screen: an interactive control
                 nested inside an anchor is invalid HTML and swallows its own
                 clicks. */
              /* The toggle is a **sibling** of the row anchor, not a child of
                 it: `showReloadAffordance`'s own note above records why an
                 interactive control cannot go inside — a `<button>` nested in
                 an `<a>` is invalid HTML and swallows its own clicks. It is
                 absolutely positioned over the ninth grid column, which
                 `.k-inst-grid` reserves and the header deliberately leaves
                 unlabelled (the header keeps its eight cells), so the toggle
                 overlays empty space rather than a figure. The overlay itself
                 is `pointer-events: none`; only the button inside it takes
                 clicks, so every other part of the row is still the link. */
              <Fragment key={row.instrumentId}>
                <Link
                  to="/instruments/$instrumentId"
                  params={{ instrumentId: row.instrumentId }}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  data-testid="instrument-table-row"
                  data-selected={isSelected ? "true" : undefined}
                  aria-selected={isSelected}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                  }}
                  className="k-inst-grid k-inst-row"
                >
                  <span className="k-inst-name">
                    {/* FR-309: this list **gains** a tile it did not have — the
                      uploaded icon when set, and otherwise the display-name
                      monogram, in `.holdings-asset-tile`'s existing 34px box
                      (reused, never redeclared — NG8). Placed before the status
                      dot, so the row reads icon · status · name. */}
                    <InstrumentIconTile
                      instrumentId={row.instrumentId}
                      hasIcon={row.detail?.hasIcon ?? false}
                    >
                      <span className="holdings-asset-tile k-mono" aria-hidden="true">
                        {(row.detail?.displayName ?? "").slice(0, LIST_TILE_LETTERS)}
                      </span>
                    </InstrumentIconTile>
                    {/* The status dot. Decorative by design: the history badge in
                      this same row already carries the meaning as text, so the
                      colour is reinforcement and never the sole signal. */}
                    <span
                      data-testid="instrument-status-dot"
                      data-tone={historyStatusDotTone(row)}
                      className="k-inst-dot"
                      aria-hidden="true"
                    />
                    {/* The held state (« Détenu » / « Historique » / « Jamais
                      détenu ») used to sit here as a second label beside the
                      name. It is gone from this table: on every row of the
                      default « Mes instruments » view it read « Détenu », so it
                      cost horizontal room on every row to distinguish a case
                      the view itself already filters for. It survives where it
                      still discriminates — `InstrumentCardList`, and the
                      `heldState` filter control above this table. */}
                    <span data-testid="instrument-name" className="k-inst-name-text">
                      {row.detail?.displayName ?? "…"}
                    </span>
                  </span>

                  <span data-testid="instrument-kind" className="k-inst-cell">
                    {row.detail === undefined ? "—" : <AssetClassChip kind={row.detail.kind} />}
                  </span>

                  <span data-testid="instrument-sector" className="k-inst-cell">
                    {sectorText(row)}
                  </span>

                  <span className="k-inst-cell k-mono k-inst-symbol">
                    {symbol === null || symbol === undefined ? (
                      "—"
                    ) : (
                      <span data-testid="instrument-symbol">{symbol}</span>
                    )}
                  </span>

                  {/* Place and listing currency share a cell, the same
                    `AAPL · NASDAQ · USD` treatment the detail header uses — the
                    row's ten columns have no currency slot of their own,
                    and dropping it would leave a never-held row with no way to
                    say what it is quoted in. */}
                  <span className="k-inst-cell k-inst-cell-muted">
                    <span data-testid="instrument-mic">{row.detail?.exchangeMic ?? "—"}</span>
                    {" · "}
                    <span data-testid="instrument-currency" className="k-mono">
                      {row.detail?.listingCurrency ?? "—"}
                    </span>
                  </span>

                  <span
                    data-testid="instrument-last-price"
                    className="k-inst-cell k-inst-cell-strong k-inst-cell-right k-num"
                  >
                    {row.lastPrice === undefined ? (
                      "—"
                    ) : (
                      <Figure
                        value={row.lastPrice}
                        scale={resolveMinorUnit(row.lastPrice.currency)}
                      />
                    )}
                  </span>

                  {/* The date, with the instant behind it as the cell's
                    own title — an 88px column has no room for « 07/09/2026
                    12:44 », and the minutes are exactly what distinguishes two
                    refreshes on the same day. */}
                  <span
                    data-testid="instrument-price-freshness"
                    title={priceFreshnessDetail(row.historyStatus)}
                    className="k-inst-cell k-inst-cell-muted k-inst-cell-right k-num"
                  >
                    {priceFreshnessText(row.historyStatus)}
                  </span>

                  {/* The badge carries the short state; the full, audited
                    sentence stays reachable as the cell's own title rather
                    than being truncated into a 116px column. */}
                  <span
                    data-testid="instrument-market-data-status"
                    title={marketDataStatusText(row)}
                  >
                    <HistoryStatusBadge
                      status={row.historyStatus?.status}
                      failedToLoad={isPresentError(row.historyStatusError)}
                    />
                  </span>
                </Link>
                <span
                  data-testid="instrument-watch-cell"
                  className="k-inst-watch-overlay"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <WatchToggle
                    instrumentId={row.instrumentId}
                    watched={
                      watchedIds === undefined ? "unknown" : watchedIds.has(row.instrumentId)
                    }
                    testId="instrument-watch-toggle"
                  />
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>
      <p data-testid="instrument-table-count" className="k-inst-foot">
        <span>
          {fill(rows.length > 1 ? INSTRUMENT_COPY.countMany : INSTRUMENT_COPY.countOne, {
            count: String(rows.length),
          })}
        </span>
      </p>
    </Card>
  );
}
