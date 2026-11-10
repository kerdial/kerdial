import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseDecimalString } from "@kerdial/core-decimal";
import { Figure } from "../components/Figure.js";
import { InstrumentClassificationForm } from "../components/InstrumentClassificationForm.js";
import { InstrumentIdentityForm } from "../components/InstrumentIdentityForm.js";
import { InstrumentScpiAttributesForm } from "../components/InstrumentScpiAttributesForm.js";
import { InstrumentDeleteDialog } from "../components/InstrumentDeleteDialog.js";
import { InstrumentIconForm } from "../components/InstrumentIconForm.js";
import { InstrumentIconTile } from "../components/InstrumentIconTile.js";
import { ManualPriceForm } from "../components/ManualPriceForm.js";
import {
  HistoryStatusBadge,
  historyThroughText,
  priceFreshnessInstantText,
  priceSourceLabel,
} from "../components/InstrumentTable.js";
import { InstrumentReloadButton } from "../components/InstrumentReloadButton.js";
import { WatchToggle } from "../components/WatchToggle.js";
import type { GlossaryTermId } from "../lib/copy/glossary.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import {
  LOADING_OR_FAILED_MESSAGE,
  availableSinceMessage,
  formatIsoDateFr,
  statusMessage,
} from "../lib/history-status-copy.js";
import { messageForError } from "../lib/problem-messages.js";
import { EmptyState, EmptyStateActionButton } from "../components/EmptyState.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { EMPTY_STATE_COPY } from "../lib/empty-states.js";
import { assetClassLabel } from "../lib/asset-class.js";
import { SECTOR_UNCLASSIFIED_LABEL, sectorDisplayLabel } from "../lib/sector-display.js";
import { COUNTRY_UNKNOWN_LABEL, countryDisplayLabel } from "../lib/country-display.js";
import { formatAmount } from "../lib/figure-format.js";
import {
  holdingsQueryOptions,
  instrumentByIdQueryOptions,
  instrumentHistoryStatusQueryOptions,
  instrumentPricesQueryOptions,
  watchedIdSet,
  watchedInstrumentIdsQueryOptions,
} from "../lib/queries.js";
import { toAutomatedFigure } from "../lib/synthetic-figure.js";
import {
  AssetClassChip,
  Badge,
  Button,
  Card,
  Dialog,
  JargonTerm,
  SegmentedControl,
  type SegmentedOption,
} from "../components/ui/index.js";
import { GlobalWriteActions } from "../components/GlobalWriteActions.js";

const InstrumentPriceSparkline = lazy(() =>
  import("../components/InstrumentPriceSparkline.js").then((module) => ({
    default: module.InstrumentPriceSparkline,
  })),
);

/**
 * `InstrumentDetailView.tsx` — UR-28, restyled to the
 * Kerdial skin. Router-agnostic (necessary
 * supporting plumbing, the identical
 * `ActivityRoute`/`ActivityView` split — `InstrumentDetailRoute.tsx` reads
 * `instrumentDetailRoute.useParams()`, which pulls in `router.js` ->
 * `AppShell.tsx` -> `virtual:pwa-register/react`, not resolvable under plain
 * `vitest`).
 *
 * ## Layout — two columns and a modal
 *
 * The screen has three parts: price history · instrument information + history
 * status · the manual-price modal. The third is not a column of the page — it
 * is the **modal**. So this screen is two content columns plus a
 * `<Dialog>`, and the modal's own content is that third column verbatim
 * (date, price/NAV with its decimal-places error, currency, and the note that
 * an existing manual price for that date is replaced with the old value kept
 * in the audit trail).
 *
 * The heading is this view's own `<h1>` under a breadcrumb rather than
 * `<PageHeader>` — `page-header.test.tsx` scopes that component to the six
 * *navigation destinations*, and a detail view legitimately carries its own
 * heading.
 *
 * ## Sections, and where UR-28's four went
 *
 * 1. **Informations sur l'instrument** — every `GET /instruments/:id` field
 *    (`instrumentByIdQueryOptions`, the same `["instruments", id]` key
 *    UR-9/UR-27 already share — a name resolved by either of those screens
 *    costs this route zero extra requests, and vice versa), in this
 *    order: display name, symbol, ISIN, FIGI, exchange, listing
 *    currency, type, quote policy.
 * 2. **Historique des cours** — the range control, then UR-29's `React.lazy`
 *    -loaded chart. The trade-marker legend, markers and marker
 *    annotations ship with the chart rather than with this card: they
 *    all come from the transactions read `InstrumentPriceSparkline.tsx` owns,
 *    keyed on the same window `months` below selects, so the legend renders
 *    just above the chart instead of in this header beside the range control —
 *    lifting that read up here would pull it out of the lazy chart chunk to
 *    position a legend.
 *
 *    **`PricePointTable` (UR-14) is no longer mounted here.** It listed every
 *    point of the merged history — hundreds of rows for a 1-year window, and
 *    up to ~1,500 for the 5A range this cycle added — under a chart that
 *    already shows the same series, which is the "full detailed list under the
 *    graph" this screen was asked to stop rendering. The per-point facts it
 *    carried (`origin`, `sourceKey`) are **not lost**: `ManualPriceDialog.tsx`
 *    mounts the same component for the same instrument, on the same query key,
 *    which is where AC104's per-row origin/source claim is now read (and where
 *    someone entering a manual point looks anyway). Nothing else on this screen
 *    changed shape: the chart's tooltip still names each point's own
 *    `Manuel`/`Automatique` origin.
 * 3. **État de l'historique** — a **one-shot** (no `refetchInterval`)
 *    `instrumentHistoryStatusQueryOptions` read at `background` priority
 *    through `cheapReadBudget`, rendered through `history-status-copy.ts` —
 *    **never** mounting `InstrumentHistoryStatus.tsx`'s own polling component
 *    (verified by this file's own test as a component-tree
 *    assertion). Its badge is `InstrumentTable.tsx`'s shared
 *    `HistoryStatusBadge`, off the one tone map the list uses.
 * 4. **Contexte portefeuille** — from the **already-cached**
 *    `["portfolios","holdings","combined"]` query, zero extra requests.
 *    `HoldingResponse` has **no `portfolioId`** (checked from source,
 *    `api-client.ts`'s own mirror): the combined view aggregates
 *    quantity/value **across every portfolio that holds this instrument**, so
 *    this section can say "held, quantity X, value Y (tous portefeuilles
 *    confondus)" but genuinely **cannot** say *which* portfolio(s) — that
 *    attribution does not exist on this wire shape, and this section says so
 *    explicitly rather than inventing it.
 *
 * The UR-36 empty/error states render on the page ground rather than inside a
 * card: `EmptyState` draws its own bordered block, and putting it in a `<Card>`
 * would be a nested card, which the Kerdial skin forbids.
 */
export interface InstrumentDetailViewProps {
  readonly instrumentId: string;
  /**
   * Called after the instrument is deleted, so the router-bound half
   * can navigate away from a now-nonexistent `/instruments/$instrumentId`.
   * Optional, so this view still renders without a router in a unit test —
   * the same shape and the same reason `PortfolioDetailView`'s
   * `onPortfolioDeleted` carries.
   */
  readonly onDeleted?: () => void;
}

/**
 * The range control. Kept here rather than in
 * `InstrumentPriceSparkline.tsx` on purpose: that module is `React.lazy`-loaded
 * so `echarts` stays out of the entry chunk (`scripts/check-sparkline-chunk.ts`
 * asserts it against a real production build), and importing a constant from it
 * eagerly would pull the whole chart chunk back in.
 *
 * **3A and 5A** were added to a list that stopped at one year: a one-year
 * ceiling is shorter than the holding period this screen exists to inspect.
 * Both need more than the 4-page default the price read takes for a year —
 * `InstrumentPriceSparkline.tsx` sizes the cap from the window rather than
 * letting a 5-year request come back silently truncated
 * (`instrumentPricePageCapForMonths`).
 *
 * Labels are the abbreviated forms ("1M" … "5A") for the reason
 * `period-presets.ts` records for its own: presets spelled out in French do
 * not fit beside a card title.
 *
 * **YTD** (asked for 2026-09-08) sits between 6M and 1A, the same slot
 * `period-presets.ts` gives it: its span is neither a fixed month count nor
 * arbitrary, it is exactly as long as the calendar year has run so far, which
 * puts it with the other sub-year windows rather than after the whole-year
 * ones. It is not a `RANGE_MONTHS` entry — a months-back count cannot express
 * "since 1 January" for every day of the year — so `months` below carries it
 * as the literal `"YTD"` straight through to `InstrumentPriceSparkline.tsx`,
 * which resolves the window itself.
 */
const RANGE_OPTIONS: readonly SegmentedOption[] = [
  { value: "1", label: "1M" },
  { value: "3", label: "3M" },
  { value: "6", label: "6M" },
  { value: "YTD", label: "YTD" },
  { value: "12", label: "1A" },
  { value: "36", label: "3A" },
  { value: "60", label: "5A" },
];

const RANGE_MONTHS: Readonly<Record<string, number>> = {
  "1": 1,
  "3": 3,
  "6": 6,
  "12": 12,
  "36": 36,
  "60": 60,
};
const DEFAULT_RANGE = "12";

/** The 38px mono ticker tile from the design, from the symbol when there is one. */
function tickerBadgeText(symbol: string | null, displayName: string): string {
  if (symbol !== null && symbol.trim() !== "") return symbol.slice(0, 5);
  return displayName.slice(0, 4).toUpperCase();
}

interface DefinitionRowProps {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
  /** The row's label is jargon, and carries its definition beside it. */
  readonly term?: GlossaryTermId;
}

function DefinitionRow({ label, testId, children, mono = false, term }: DefinitionRowProps) {
  return (
    <div className="k-inst-def">
      <dt className="k-inst-def-key">
        {term === undefined ? label : <JargonTerm term={term}>{label}</JargonTerm>}
      </dt>
      <dd data-testid={testId} className={`k-inst-def-value${mono ? " k-mono" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

/**
 * An SCPI's frais de souscription as the detail row shows it
 * (NFR-75): the wire's percentage string (`"8.50"`) over 100, through the
 * existing `percentage` figure kind — the same 2-dp rendering every percentage
 * on this product gets, no formatting of its own. Unset reads « Non renseigné »
 * (`country-display.ts`'s one wording); an unparseable value reads "—", never a
 * thrown error.
 */
function subscriptionFeeText(fee: string | null | undefined): string {
  if (fee === null || fee === undefined) return COUNTRY_UNKNOWN_LABEL;
  try {
    return formatAmount("percentage", parseDecimalString(fee).dividedBy(100), 0);
  } catch {
    return "—";
  }
}

export function InstrumentDetailView({ instrumentId, onDeleted }: InstrumentDetailViewProps) {
  const [manualPriceOpen, setManualPriceOpen] = useState(false);
  // The delete dialog's own disclosure. Nothing else in this view
  // depends on it, so it is deliberately not folded into the `editOpen` group.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [manualPriceJustSaved, setManualPriceJustSaved] = useState(false);
  /*
   * One « Modifier » dialog, two sections. `editOpen` replaces the
   * former `classificationOpen`/`identityOpen` pair — the two forms are
   * mounted together now, so there is one thing to open and one thing to
   * close. The two `justSaved` flags stay **two** flags: the forms still
   * submit independently, and « Identité enregistrée. » and « Classification
   * enregistrée. » are two outcomes, either of which can happen without the
   * other.
   */
  const [editOpen, setEditOpen] = useState(false);
  const [classificationJustSaved, setClassificationJustSaved] = useState(false);
  const [identityJustSaved, setIdentityJustSaved] = useState(false);
  const [scpiAttributesJustSaved, setScpiAttributesJustSaved] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  /*
   * IK-13's `iconOpen`/`iconJustSaved` pair. Three-valued rather than a
   * boolean because removal has its own sentence — « Icône supprimée. » is not
   * « Icône enregistrée. », and one flag would have had to pick which of the
   * two outcomes to be wrong about.
   */
  const [iconJustSaved, setIconJustSaved] = useState<"saved" | "removed" | undefined>(undefined);
  /*
   * FR-306. This is the one screen an icon can be written from, so it is the
   * one screen whose badge is still mounted when the bytes behind its `src`
   * change — the other four surfaces only ever see an icon they navigated to.
   * Bumped after every successful write, and read by `InstrumentIconTile` as
   * the identity of the bytes it should be showing; see that file's own
   * `iconVersion` section for why the element's key and not a query token.
   *
   * Not derived from `detail.updatedAt`: an icon write does not touch the
   * instrument row, so that value does not move. Not derived from the `PUT`'s
   * own `InstrumentIconMetaResponse.updatedAt` either — a removal is a `204`
   * and carries none, and this counter has to move for a removal too, or a
   * failure recorded before it would outlive the re-add that follows.
   */
  const [iconVersion, setIconVersion] = useState(0);
  const [range, setRange] = useState(DEFAULT_RANGE);

  // Same reset-on-reopen rule as `ManualPriceDialog.tsx`'s own `justSaved`:
  // a reopened dialog never carries over the previous entry's transient
  // success notice.
  useEffect(() => {
    if (!manualPriceOpen) setManualPriceJustSaved(false);
  }, [manualPriceOpen, instrumentId]);

  // The « Modifier » dialog's two confirmations. Cleared when the
  // dialog is **opened**, never when it closes: both banners render inside
  // the dialog, which now *stays* open after a save so the other section can
  // be edited in the same visit, and clearing on close would erase a notice
  // in the same tick that produced it. One effect for both, because they
  // belong to one dialog.
  useEffect(() => {
    if (editOpen) {
      setClassificationJustSaved(false);
      setIdentityJustSaved(false);
      setScpiAttributesJustSaved(false);
    }
  }, [editOpen, instrumentId]);

  // The icon dialog follows the **classification** rule, not the
  // manual-price one (V15, FR-291): its confirmation renders on the identity
  // card and the dialog closes on save, so clearing on close would erase the
  // notice in the same tick that produced it. Cleared on **re-open**.
  useEffect(() => {
    if (iconOpen) setIconJustSaved(undefined);
  }, [iconOpen, instrumentId]);

  const detailQuery = useQuery(instrumentByIdQueryOptions(instrumentId));
  const historyStatusQuery = useQuery(instrumentHistoryStatusQueryOptions(instrumentId));
  const holdingsQuery = useQuery(holdingsQueryOptions());
  // UR-36 `manual-only-without-price`: whether a MANUAL_ONLY instrument has
  // any price at all. This used to ride the `["instruments", id, "prices"]`
  // key `PricePointTable` read on this screen for free; with that table gone
  // it is a read of this view's own, and it stays a *whole-history* read
  // rather than being folded into the chart's windowed one — a manual-only
  // instrument whose only point predates the selected range would otherwise
  // be reported as having no price at all, which is the opposite of true.
  const pricesQuery = useQuery(instrumentPricesQueryOptions(instrumentId));
  // `watchlist` FR-372/W-6: one bounded `GET /watchlist/ids` read
  // — the same key the Instruments list and the Suivi screen mount — from which
  // this screen's `<WatchToggle>` resolves its state. `InstrumentResponse`
  // gains no `watched` field, and this view fetches no watchlist *rows*.
  //
  // Mounted here rather than in `InstrumentDetailRoute.tsx`: that file is a 4-line `useParams` shim no test renders — every
  // suite renders **this** component directly, precisely because importing
  // `router.js` drags in `virtual:pwa-register/react`. A query mounted in the
  // shim would be covered by nothing, and the `fetchWatchedInstrumentIds`
  // stub in `InstrumentDetailRoute.test.tsx`'s api-client mock only makes
  // sense if the fetch happens inside the tree that test renders.
  const watchedIdsQuery = useQuery(watchedInstrumentIdsQueryOptions());

  const detail = detailQuery.data;
  /**
   * An SCPI is unlisted, unclassified and priced by hand —
   * its attributes replace the sector/industry/listing-country rows, its price
   * is a « prix de part », and it has no provider history to report on.
   */
  const isScpi = detail?.kind === "SCPI";
  const enterPriceLabel = isScpi
    ? INSTRUMENT_COPY.enterScpiPrice
    : INSTRUMENT_COPY.enterManualPrice;
  /** `undefined` until that read answers — the toggle's `"unknown"` state, never a defaulted « Suivre ». */
  const watchedIds = watchedIdSet(watchedIdsQuery.data);
  const heldHolding = holdingsQuery.data?.holdings.find((h) => h.instrumentId === instrumentId);
  const historyStatus = historyStatusQuery.data?.status;
  const manualOnlyWithoutPrice =
    detail?.quotePolicy === "MANUAL_ONLY" && pricesQuery.data !== undefined
      ? pricesQuery.data.length === 0
      : false;

  const months = useMemo(() => (range === "YTD" ? "YTD" : (RANGE_MONTHS[range] ?? 12)), [range]);

  return (
    <section data-testid="instrument-detail-screen">
      {detailQuery.isLoading && (
        <PanelLoading
          panelLabel={INSTRUMENT_COPY.loadingDetail}
          testId="instrument-detail-loading"
        />
      )}
      {detailQuery.isError && (
        <ValuationErrorState
          error={detailQuery.error}
          testId="instrument-detail-error"
          panelLabel={INSTRUMENT_COPY.detailPanel}
          onRetry={() => void detailQuery.refetch()}
        />
      )}

      {detail && (
        <>
          <header className="k-inst-detail-head">
            <div>
              <nav className="k-inst-breadcrumb" aria-label={INSTRUMENT_COPY.breadcrumb}>
                {/* A plain anchor, not a router `<Link>` — this view is
                    mounted router-free by its own suite (the UR-28 split), and
                    the sold-out action below already uses the same form. */}
                <a href="/instruments">{INSTRUMENT_COPY.breadcrumbInstruments}</a>
                <span className="k-inst-breadcrumb-sep" aria-hidden="true">
                  /
                </span>
                <span>{detail.displayName}</span>
              </nav>
              <div className="k-inst-identity">
                {/* FR-308: the uploaded icon in the badge's position when
                    this tenant has one, and otherwise `tickerBadgeText`'s
                    unchanged output in the unchanged 38px box (G2/NG8).

                    `onEditClick` is what puts the pencil chip on the
                    badge, and this is the **only** call site that passes it —
                    IK-13's "correctable where it is shown, nowhere else"
                    (NG2/NG3/NG4), now enforced by the prop rather than by
                    where a button was placed. The dialog, its state and its
                    mutations are unchanged; only the trigger moved here from
                    the identity card below. */}
                <InstrumentIconTile
                  instrumentId={instrumentId}
                  hasIcon={detail.hasIcon}
                  size="badge"
                  iconVersion={iconVersion}
                  onEditClick={() => setIconOpen(true)}
                >
                  <span className="k-inst-ticker k-mono" aria-hidden="true">
                    {tickerBadgeText(detail.symbol, detail.displayName)}
                  </span>
                </InstrumentIconTile>
                <h1 data-testid="instrument-detail-name" className="k-inst-title">
                  {detail.displayName}
                </h1>
                <span className="k-inst-meta k-mono">
                  {[detail.symbol, detail.exchangeMic, detail.listingCurrency]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </span>
                <AssetClassChip kind={detail.kind} />
                <Badge
                  data-testid="instrument-detail-status"
                  tone={detail.status === "ACTIVE" ? "gain" : "neutral"}
                >
                  {detail.status}
                </Badge>
              </div>
            </div>

            {/* FR-97: reachable from here too, not only from the six nav
                destinations — see GlobalWriteActions. */}
            <GlobalWriteActions />

            <Button
              variant="secondary"
              size="sm"
              iconLeft="pencil"
              data-testid="instrument-detail-enter-price"
              onClick={() => setManualPriceOpen(true)}
            >
              {enterPriceLabel}
            </Button>

            {/* `watchlist` FR-372 — the third surface the toggle mounts on,
                one instrument, no per-row anything. It fetches nothing: the
                state comes from the ids read above. */}
            <WatchToggle
              instrumentId={instrumentId}
              watched={watchedIds === undefined ? "unknown" : watchedIds.has(instrumentId)}
              testId="instrument-detail-watch-toggle"
            />

            {/* Last in the row and `danger`-toned: the destructive
                action is never the one a hurried click lands on, which is why
                it sits after the two affordances a reader actually came here
                for. The dialog behind it is where the consequences are
                stated. */}
            <Button
              variant="danger"
              size="sm"
              iconLeft="trash"
              data-testid="instrument-detail-delete"
              onClick={() => setDeleteOpen(true)}
            >
              {INSTRUMENT_COPY.deleteInstrument}
            </Button>
          </header>

          <div className="k-inst-detail">
            {/* ── Column 1: the price-history card ── */}
            <div className="k-inst-column">
              <Card data-testid="instrument-detail-valuation">
                <div className="k-inst-card-head-row">
                  <h2 className="k-inst-card-title">{INSTRUMENT_COPY.priceHistory}</h2>
                  <SegmentedControl
                    label={INSTRUMENT_COPY.displayedRange}
                    size="sm"
                    options={RANGE_OPTIONS}
                    value={range}
                    onChange={setRange}
                  />
                </div>

                {/*
                 * UR-29's chart, `React.lazy`-loaded so `echarts` is its own
                 * Rollup chunk and never enters the main entry chunk
                 * (`scripts/check-sparkline-chunk.ts` asserts both against a
                 * real production build). `.then(...)` maps the named export
                 * rather than adding a default export this codebase otherwise
                 * never uses. The fallback is a plain placeholder — the chart is
                 * a secondary view of the same series the tooltip reads, and
                 * the price table is no longer on this screen, so a slow chunk
                 * costs the chart itself and nothing else.
                 */}
                <Suspense
                  fallback={
                    <p data-testid="instrument-detail-sparkline-fallback" className="k-inst-note">
                      {INSTRUMENT_COPY.loadingChart}
                    </p>
                  }
                >
                  <InstrumentPriceSparkline instrumentId={instrumentId} months={months} />
                </Suspense>
              </Card>
            </div>

            {/* ── Column 2: instrument information, history status, context ── */}
            <div className="k-inst-column">
              <Card data-testid="instrument-detail-identity">
                <h2 className="k-inst-card-title">{INSTRUMENT_COPY.identityCard}</h2>
                <dl className="k-inst-defs">
                  <DefinitionRow
                    label={INSTRUMENT_COPY.displayName}
                    testId="instrument-detail-display-name"
                  >
                    {detail.displayName}
                  </DefinitionRow>
                  {/* Shown when present, with a
                      fallback — never a field that reads as broken. */}
                  <DefinitionRow
                    label={INSTRUMENT_COPY.symbol}
                    testId="instrument-detail-symbol"
                    mono
                  >
                    {detail.symbol ?? "—"}
                  </DefinitionRow>
                  <DefinitionRow label={INSTRUMENT_COPY.isin} testId="instrument-detail-isin" mono>
                    {detail.isin ?? "—"}
                  </DefinitionRow>
                  <DefinitionRow label={INSTRUMENT_COPY.figi} testId="instrument-detail-figi" mono>
                    {detail.figi ?? "—"}
                  </DefinitionRow>
                  <DefinitionRow
                    label={INSTRUMENT_COPY.exchangeMic}
                    testId="instrument-detail-mic"
                    mono
                  >
                    {detail.exchangeMic ?? "—"}
                  </DefinitionRow>
                  <DefinitionRow
                    label={INSTRUMENT_COPY.listingCurrency}
                    testId="instrument-detail-currency"
                    mono
                  >
                    {detail.listingCurrency}
                  </DefinitionRow>
                  <DefinitionRow label={INSTRUMENT_COPY.kind} testId="instrument-detail-kind">
                    {assetClassLabel(detail.kind)}
                  </DefinitionRow>
                  {/* This rendered the raw `AUTO`/`MANUAL_ONLY` enum at
                      the reader, which is neither French nor a policy anyone
                      could name. `priceSourceLabel` is the Instruments list's
                      own mapping, reused rather than restated — A7/NFR-4
                      keeps identifiers untranslated, and a *policy* is not one
                      of them (the raw token is still available as the row's
                      `data-quote-policy`, exactly as on the card list). */}
                  <DefinitionRow
                    label={INSTRUMENT_COPY.quotePolicy}
                    testId="instrument-detail-quote-policy"
                    term="quotePolicy"
                  >
                    <span data-quote-policy={detail.quotePolicy}>{priceSourceLabel(detail)}</span>
                  </DefinitionRow>
                  <DefinitionRow
                    label={INSTRUMENT_COPY.primaryIdentifier}
                    testId="instrument-detail-primary-identifier"
                  >
                    {detail.primaryIdentifier}
                  </DefinitionRow>
                  {/*
                   * IR-13 — the four
                   * classification/geography rows. Each renders *something* on
                   * every instrument: an unclassified row says « Non classé »
                   * and an unknown domicile says « Non renseigné » (AC-5), never
                   * a blank cell and never a "—" that reads as broken.
                   *
                   * « Secteur détaillé » is the provider's own opaque label,
                   * rendered **as received and never translated** — it is data,
                   * exactly like a `display_name` of "Air Liquide S.A."
                   * (A7/NFR-4). Everything else here is French chrome.
                   *
                   * The two countries are **two rows**, with two labels, and
                   * that is the point (AC-11): `listingCountry` is derived
                   * server-side from the MIC, `domicileCountry` is the issuer's
                   * own — for Airbus, Stellantis, STMicroelectronics,
                   * ArcelorMittal and EssilorLuxottica they differ, and a
                   * single merged "pays" row would silently pick one.
                   */}
                  {/* scpi FR-619: an SCPI's two attributes in place of the
                      sector, industry and listing-country rows (no sector
                      vocabulary, N11; no MIC, so no listing country). */}
                  {isScpi ? (
                    <>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.managementCompany}
                        testId="instrument-detail-management-company"
                      >
                        {detail.managementCompany ?? COUNTRY_UNKNOWN_LABEL}
                      </DefinitionRow>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.subscriptionFeePct}
                        testId="instrument-detail-subscription-fee"
                      >
                        {subscriptionFeeText(detail.subscriptionFeePct)}
                      </DefinitionRow>
                    </>
                  ) : (
                    <>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.sector}
                        testId="instrument-detail-sector"
                      >
                        {sectorDisplayLabel(detail.sectorCode)}
                      </DefinitionRow>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.industry}
                        testId="instrument-detail-industry"
                      >
                        {detail.industryLabel ?? SECTOR_UNCLASSIFIED_LABEL}
                      </DefinitionRow>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.listingCountry}
                        testId="instrument-detail-listing-country"
                      >
                        {countryDisplayLabel(detail.listingCountry)}
                      </DefinitionRow>
                    </>
                  )}
                  <DefinitionRow
                    label={INSTRUMENT_COPY.domicileCountry}
                    testId="instrument-detail-domicile-country"
                  >
                    {countryDisplayLabel(detail.domicileCountry)}
                  </DefinitionRow>
                </dl>
                {/* IK-13: the icon's own two notices. The
                    « Icône de l'instrument » sub-header and its « Gérer
                    l'icône » button that used to carry them are gone —
                    the trigger is the pencil chip on the badge at the top of
                    this screen — but both notices are outcomes of that write
                    and still belong on this card: the icon dialog closes on
                    save, so its confirmation has to render somewhere the user
                    is left looking at, and « Aucune icône » is a standing
                    statement about the instrument, not about the dialog. */}
                {iconJustSaved !== undefined && (
                  <p
                    role="status"
                    data-testid="instrument-detail-icon-saved"
                    className="k-inst-banner k-inst-banner-gain mt-3"
                  >
                    {iconJustSaved === "saved"
                      ? INSTRUMENT_COPY.iconSaved
                      : INSTRUMENT_COPY.iconRemoved}
                  </p>
                )}
                {!detail.hasIcon && (
                  <p data-testid="instrument-detail-icon-state" className="k-inst-note mt-3">
                    {INSTRUMENT_COPY.iconNone}
                  </p>
                )}
                {/* One « Modifier » where IR-18's « Corriger le secteur
                    ou le pays » and the identity edit were two buttons. Still
                    on this card, beside the rows it edits — DD30's rule is
                    that a shared row is corrected where it is shown and never
                    from a bulk surface like the holdings table, and merging
                    two triggers into one does not move the affordance off this
                    card. The dialog is mounted at the bottom of this view,
                    next to the manual-price one, and carries both forms as two
                    sections. */}
                <div className="k-inst-form-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="pencil"
                    data-testid="instrument-detail-edit"
                    onClick={() => setEditOpen(true)}
                  >
                    {INSTRUMENT_COPY.editInstrument}
                  </Button>
                </div>
                <p
                  data-testid="instrument-detail-manual-pricing-requirement"
                  className="k-inst-note mt-3"
                >
                  {detail.quotePolicy === "MANUAL_ONLY"
                    ? INSTRUMENT_COPY.manualPricingRequired
                    : INSTRUMENT_COPY.automaticPricing}
                </p>
              </Card>

              {/* One-shot read, never `InstrumentHistoryStatus.tsx`'s own polling
                  component — rendered directly through
                  `history-status-copy.ts`. Not for an SCPI:
                  it has no provider history, and the reload button could only
                  earn a 400. */}
              {!isScpi && (
                <Card data-testid="instrument-detail-history-status">
                  <div className="k-inst-card-head-row">
                    <h2 className="k-inst-card-title">{INSTRUMENT_COPY.historyStatusCard}</h2>
                    <span className="k-inst-card-head-actions">
                      <HistoryStatusBadge
                        status={historyStatus}
                        failedToLoad={historyStatusQuery.isError}
                        testId="instrument-detail-history-badge"
                      />
                      {/* The manual reload, moved here from the Instruments list.
                        Unconditional, unlike the list's own
                        `showReloadAffordance` two-mode rule: this screen is one
                        instrument the user navigated to deliberately, so there
                        is no per-row noise to suppress and no catalogue-vs-held
                        distinction left to make. The endpoint's four
                        distinguishable rejections (409/400/429/503) remain what
                        says "not this one, not now", in French, from the server
                        — a client-side guess here could disagree with it. */}
                      <InstrumentReloadButton
                        instrumentId={instrumentId}
                        historyStatus={historyStatusQuery.data}
                      />
                    </span>
                  </div>
                  <p role="status" className="k-inst-note">
                    {historyStatusQuery.data !== undefined
                      ? statusMessage(historyStatusQuery.data)
                      : historyStatusQuery.isError
                        ? messageForError(historyStatusQuery.error).text
                        : LOADING_OR_FAILED_MESSAGE}
                  </p>
                  {/* IR-14 (FR-26/FR-27, AC-31/AC-32): the
                    best-effort disclosure, from `earliestBackfilledDate` —
                    stored data, never a constant, and never a claim about how
                    many years of history exist. A provider that only had 12
                    years for a 20-year request is a normal outcome, and this
                    line is where the user sees what is actually held. */}
                  {historyStatusQuery.data && (
                    <p
                      data-testid="instrument-detail-history-available-since"
                      className="k-inst-note mt-3"
                    >
                      {availableSinceMessage(historyStatusQuery.data)}
                    </p>
                  )}
                  {historyStatusQuery.data && (
                    <dl className="k-inst-defs mt-3">
                      <DefinitionRow
                        label={INSTRUMENT_COPY.historyRequestedFrom}
                        testId="instrument-detail-history-requested-from"
                      >
                        {historyStatusQuery.data.requestedFrom !== null
                          ? formatIsoDateFr(historyStatusQuery.data.requestedFrom)
                          : "—"}
                      </DefinitionRow>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.historyEarliest}
                        testId="instrument-detail-history-earliest"
                      >
                        {historyStatusQuery.data.earliestBackfilledDate !== null
                          ? formatIsoDateFr(historyStatusQuery.data.earliestBackfilledDate)
                          : "—"}
                      </DefinitionRow>
                      {/* Two rows, because these are two facts. « Dernier
                        cours reçu » is the last observation (quote instant,
                        else newest series point) — the one « Actualiser les
                        cours » moves — and « Historique jusqu'au » is the
                        backfill resume bookmark, which no quote write touches.
                        This row used to be the bookmark alone, labelled
                        « Dernier cours disponible », which is the same wrong
                        claim the Instruments table was making. */}
                      <DefinitionRow
                        label={INSTRUMENT_COPY.historyLastQuote}
                        testId="instrument-detail-price-freshness"
                      >
                        {priceFreshnessInstantText(historyStatusQuery.data)}
                      </DefinitionRow>
                      <DefinitionRow
                        label={INSTRUMENT_COPY.historyLatest}
                        testId="instrument-detail-history-latest"
                      >
                        {historyThroughText(historyStatusQuery.data)}
                      </DefinitionRow>
                    </dl>
                  )}
                </Card>
              )}

              <Card data-testid="instrument-detail-portfolio-context">
                <h2 className="k-inst-card-title">{INSTRUMENT_COPY.portfolioContext}</h2>
                {holdingsQuery.isLoading && (
                  <PanelLoading
                    panelLabel={INSTRUMENT_COPY.loadingPortfolioContext}
                    testId="instrument-detail-portfolio-context-loading"
                  />
                )}
                {holdingsQuery.data && (
                  <>
                    <p data-testid="instrument-detail-held-state" className="k-inst-note">
                      {heldHolding !== undefined
                        ? INSTRUMENT_COPY.heldNow
                        : INSTRUMENT_COPY.notHeldNow}
                    </p>
                    {heldHolding !== undefined && (
                      <dl className="k-inst-defs mt-3">
                        <DefinitionRow
                          label={INSTRUMENT_COPY.heldQuantity}
                          testId="instrument-detail-held-quantity"
                        >
                          <Figure
                            value={toAutomatedFigure(heldHolding.quantity, heldHolding.currency, [
                              "AUTOMATED",
                            ])}
                            kind="quantity"
                          />
                        </DefinitionRow>
                        <DefinitionRow
                          label={INSTRUMENT_COPY.heldValue}
                          testId="instrument-detail-held-value"
                        >
                          <Figure
                            value={heldHolding.currentValue}
                            scale={resolveMinorUnit(heldHolding.currentValue.currency)}
                          />
                        </DefinitionRow>
                      </dl>
                    )}
                    <p
                      data-testid="instrument-detail-portfolio-attribution-note"
                      className="k-inst-note mt-3"
                    >
                      {INSTRUMENT_COPY.noPortfolioAttribution}
                    </p>
                  </>
                )}
              </Card>

              {holdingsQuery.isError && (
                <ValuationErrorState
                  error={holdingsQuery.error}
                  testId="instrument-detail-portfolio-context-error"
                  panelLabel={INSTRUMENT_COPY.portfolioContext}
                  onRetry={() => void holdingsQuery.refetch()}
                />
              )}

              {/* UR-36 `sold-out-instrument`: a historical row is a normal
                  outcome, not a failure — and this screen is only reachable
                  from a set built as "détenu ∪ déjà transigé" (a later
                  correction), so "plus détenu" here genuinely means cédé. */}
              {holdingsQuery.data && heldHolding === undefined && (
                <EmptyState
                  id="sold-out-instrument"
                  testId="instrument-detail-sold-out"
                  action={
                    <a
                      href={`/activity?instrument=${instrumentId}`}
                      data-testid="instrument-detail-sold-out-activity-link"
                      className="k-btn k-btn-secondary k-btn-sm"
                    >
                      {EMPTY_STATE_COPY["sold-out-instrument"].actionLabel}
                    </a>
                  }
                />
              )}

              {/* UR-36 `manual-only-without-price` — the one state on this
                  screen whose action is the whole point of the screen: the
                  instrument cannot be valorised at all until a NAV is
                  entered. */}
              {manualOnlyWithoutPrice && (
                <EmptyState
                  id="manual-only-without-price"
                  testId="instrument-detail-manual-only-without-price"
                  action={
                    <EmptyStateActionButton
                      stateId="manual-only-without-price"
                      testId="instrument-detail-manual-only-enter-price"
                      onClick={() => setManualPriceOpen(true)}
                    />
                  }
                />
              )}

              {/* UR-36 `ingestion-in-progress` / `ingestion-failed`. The failed
                  state's own action stays "price the instrument by hand" — the
                  one thing that fixes *this screen's* missing figures now.
                  It carries no reload control of its own because the history
                  card above now does: `InstrumentReloadButton` moved here from
                  the Instruments list when that table's action column was
                  removed, so the reload for this instrument is a few hundred
                  pixels up rather than on another screen. Nothing here promises
                  an automatic retry — the reconcile job still skips `FAILED` by
                  design. */}
              {(historyStatus === "PENDING" || historyStatus === "IN_PROGRESS") && (
                <EmptyState
                  id="ingestion-in-progress"
                  testId="instrument-detail-ingestion-in-progress"
                />
              )}
              {historyStatus === "FAILED" && (
                <EmptyState
                  id="ingestion-failed"
                  testId="instrument-detail-ingestion-failed"
                  action={
                    <EmptyStateActionButton
                      stateId="ingestion-failed"
                      testId="instrument-detail-ingestion-failed-enter-price"
                      onClick={() => setManualPriceOpen(true)}
                    />
                  }
                />
              )}
            </div>
          </div>

          {/* ── The manual-price modal — the design's third "column" ── */}
          <Dialog
            open={manualPriceOpen}
            onClose={() => setManualPriceOpen(false)}
            title={isScpi ? INSTRUMENT_COPY.enterScpiPrice : INSTRUMENT_COPY.manualPriceDialogTitle}
            description={`${detail.displayName} · ${assetClassLabel(detail.kind)}`}
            width={468}
            testId="instrument-detail-manual-price-dialog"
          >
            {/*
             * `ManualPriceForm.tsx` directly, not the full
             * `ManualPriceDialog.tsx` — that dialog's own prop contract is a
             * `HoldingResponse` (it reads `.displayName`/`.kind`/
             * `.currentPrice`), which this route only has when the instrument
             * happens to be currently held; a never-/no-longer-held instrument
             * has no such `ValuedAmount` to show, and fabricating one would be
             * exactly the kind of invented data this cycle's honesty
             * constraints forbid. `ManualPriceDialog.tsx` also mounts its own
             * `PricePointTable`, which is a *fuller* surface than this
             * drawer needs — and, since the price table left "Historique des
             * cours", it is also the app's remaining home for the per-point
             * origin/source rows, reached from the holdings screen's own
             * manual-price dialog rather than from here. `ManualPriceForm`
             * alone needs only
             * `instrumentId`/`defaultCurrency`, both genuinely on hand from
             * this route's own `detail`.
             */}
            {manualPriceJustSaved && (
              <p
                role="status"
                data-testid="manual-price-success"
                className="k-inst-banner k-inst-banner-gain"
              >
                {INSTRUMENT_COPY.priceSaved}
              </p>
            )}

            <ManualPriceForm
              instrumentId={instrumentId}
              defaultCurrency={detail.listingCurrency}
              onSaved={() => setManualPriceJustSaved(true)}
              onCancel={() => setManualPriceOpen(false)}
            />
          </Dialog>

          {/* Mounted unconditionally beside the other dialogs, so its
              own `open` prop is the single thing that decides visibility, the
              convention every dialog on this screen follows. */}
          <InstrumentDeleteDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            instrumentId={instrumentId}
            displayName={detail.displayName}
            {...(onDeleted === undefined ? {} : { onDeleted })}
          />

          {/*
            ── The « Modifier » dialog: IR-18's correction dialog
               (DD30/DD31) and the 2026-09-09 identity-edit
               dialog, merged into one ──

            Two **sections**, not two merged forms: each keeps its own Zod
            resolver, its own mutation and its own submit, because
            `PATCH /instruments/:id/identity` and
            `PATCH /instruments/:id/classification` are two requests either of
            which can fail on its own. Merging them would have needed a
            partial-failure vocabulary ("le nom est enregistré, le secteur a
            échoué") that neither form has to invent while they stay
            independent. What is merged is the *entry point* — one button, one
            overlay — which is the whole of what the merge was for.

            The dialog therefore does **not** close on save: a save is one
            section's outcome, and closing would take the other section away
            from someone who came to change both. Each section's confirmation
            renders beside its own form, and the only ways out are the shell's
            close button, Esc, the backdrop, and either form's « Annuler » —
            which cancels the visit rather than the section, there being no
            per-section state to roll back once a section has submitted.
          */}
          <Dialog
            open={editOpen}
            onClose={() => setEditOpen(false)}
            title={INSTRUMENT_COPY.editInstrumentDialogTitle}
            description={`${detail.displayName} · ${assetClassLabel(detail.kind)}`}
            width={468}
            testId="instrument-detail-edit-dialog"
          >
            {/* `detail` is the server's own response for this instrument, so
                both forms prefill from the same values the rows above render —
                no second read, and no divergence between what is shown and
                what is being edited. On success each mutation invalidates
                `["instruments", id]`, so those rows re-render from the
                server's new truth rather than from the submitted body — while
                this dialog is still open, which is what lets the second
                section be edited against fresh values. */}
            <section data-testid="instrument-detail-edit-identity-section">
              <h3 className="k-inst-card-title">{INSTRUMENT_COPY.editSectionIdentity}</h3>
              {identityJustSaved && (
                <p
                  role="status"
                  data-testid="instrument-detail-identity-saved"
                  className="k-inst-banner k-inst-banner-gain mt-3"
                >
                  {INSTRUMENT_COPY.identitySaved}
                </p>
              )}
              <InstrumentIdentityForm
                instrument={detail}
                onSaved={() => setIdentityJustSaved(true)}
                onCancel={() => setEditOpen(false)}
              />
            </section>

            <section
              data-testid="instrument-detail-edit-classification-section"
              className="k-inst-edit-section"
            >
              <h3 className="k-inst-card-title">{INSTRUMENT_COPY.editSectionClassification}</h3>
              {classificationJustSaved && (
                <p
                  role="status"
                  data-testid="instrument-detail-classification-saved"
                  className="k-inst-banner k-inst-banner-gain mt-3"
                >
                  {INSTRUMENT_COPY.classificationSaved}
                </p>
              )}
              <InstrumentClassificationForm
                instrument={detail}
                onSaved={() => setClassificationJustSaved(true)}
                onCancel={() => setEditOpen(false)}
              />
            </section>

            {/* A third section, SCPI only — its own form,
                mutation and confirmation, like the two above. */}
            {isScpi && (
              <section
                data-testid="instrument-detail-edit-scpi-section"
                className="k-inst-edit-section"
              >
                <h3 className="k-inst-card-title">{INSTRUMENT_COPY.editSectionScpi}</h3>
                {scpiAttributesJustSaved && (
                  <p
                    role="status"
                    data-testid="instrument-detail-scpi-attributes-saved"
                    className="k-inst-banner k-inst-banner-gain mt-3"
                  >
                    {INSTRUMENT_COPY.scpiAttributesSaved}
                  </p>
                )}
                <InstrumentScpiAttributesForm
                  instrument={detail}
                  onSaved={() => setScpiAttributesJustSaved(true)}
                  onCancel={() => setEditOpen(false)}
                />
              </section>
            )}
          </Dialog>

          {/* ── IK-13's icon dialog, reached from the badge's pencil chip ── */}
          <Dialog
            open={iconOpen}
            onClose={() => setIconOpen(false)}
            title={INSTRUMENT_COPY.iconDialogTitle}
            description={`${detail.displayName} · ${assetClassLabel(detail.kind)}`}
            width={468}
            testId="instrument-detail-icon-dialog"
          >
            {/* `detail` again, not a second read: `hasIcon` is what decides
                whether removal is offered, and it comes from the same response
                the badge above renders from. The mutation invalidates
                `["instruments", id]` on success, so both this flag and the
                badge follow the server's new truth without a reload —
                `instrumentByIdQueryOptions` is `staleTime: Infinity`, so
                nothing else would refresh them. */}
            <InstrumentIconForm
              instrument={detail}
              onSaved={() => {
                setIconVersion((previous) => previous + 1);
                setIconJustSaved("saved");
                setIconOpen(false);
              }}
              onRemoved={() => {
                setIconVersion((previous) => previous + 1);
                setIconJustSaved("removed");
                setIconOpen(false);
              }}
              onCancel={() => setIconOpen(false)}
            />
          </Dialog>
        </>
      )}
    </section>
  );
}
