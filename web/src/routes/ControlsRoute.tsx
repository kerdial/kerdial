import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ManualPriceDialog } from "../components/ManualPriceDialog.js";
import { ControlsCardList } from "../components/ControlsCardList.js";
import { ControlsTable } from "../components/ControlsTable.js";
import { classifyControlRow, countControlJobs } from "../lib/control-rows.js";
import { AddTransactionEmptyAction } from "../components/AddTransactionEmptyAction.js";
import { ApiError, type HoldingResponse } from "../lib/api-client.js";
import { messageForError } from "../lib/problem-messages.js";
import { invalidatePortfolioDerivedFigures } from "../lib/invalidate-derived.js";
import { CONTROLS_COPY } from "../lib/copy/controls.js";
import { fill } from "../lib/copy/fill.js";
import { useControlRows } from "../hooks/use-control-rows.js";
import { useCalcEpochFreshness } from "../hooks/use-calc-epoch-freshness.js";
import { useDerivedReadErrors } from "../hooks/use-derived-read-errors.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  Banner,
  Button,
  Card,
  ProgressBar,
  Skeleton,
  StatTile,
  type IconName,
} from "../components/ui/index.js";

/**
 * `ControlsRoute.tsx` — the **Contrôles** screen
 * (UR-30..UR-32, **MODIFY + MERGE**), restyled to `kerdial-skin`.
 * Renamed from "Opérations": "Opérations"
 * collides with "Activité" in a product where transactions are literally
 * operations, and it invites the change-log reading FR-123/AC115 forbid.
 * FR-95's binding requirement is the destination *set*, not the labels, so
 * the locked FR is preserved — `nav-items.ts` is the file that actually
 * flips this destination live.
 *
 * **Not a router-bound/router-agnostic split** (unlike `InstrumentsRoute.tsx`/
 * `InstrumentsView.tsx`): this route has no search params, so — exactly
 * like `HoldingsRoute.tsx` — it never calls `useSearch()`/`useParams()` and
 * therefore never needs to import `router.js`, so it is directly testable
 * under plain `vitest` with no split required.
 *
 * **Instrument set (reused, not re-derived — UR-26's own rule).** The exact
 * same `holdingsQueryOptions()` + `transactionsInstrumentScanQueryOptions()`
 * + `deriveInstrumentSet` combination `InstrumentsView.tsx` already
 * establishes — held ∪ ever-transacted, held-first, `truncated` propagated
 * honestly (the same French note, never presenting a partial sweep as
 * complete).
 *
 * **Per-row fan-out** — the identical two **background**-priority,
 * `cheapReadBudget`-bounded, one-shot reads `InstrumentsView.tsx` already
 * issues (`instrumentByIdQueryOptions`, `instrumentHistoryStatusQueryOptions`)
 * — never `InstrumentHistoryStatus.tsx`'s own polling component.
 *
 * ## The 5-up strip, and why all five tiles are honest
 *
 * The original brief asked for valuation version · last refresh · needs attention
 * · failed history jobs · pending jobs. Four of the five are read from
 * something this screen already has; the fifth was **removed on 2026-09-08**,
 * so the strip is 4-up:
 *
 * 1. ~~**Valorisation**~~ — `HoldingsResponse.calcEpoch` labelled "version".
 *    Gone: the epoch is cache-invalidation bookkeeping (the *sum* of every
 *    constituent portfolio's epoch plus the portfolio count —
 *    `valuation/src/holdings-valuation.ts`, finding L5), and a reader of this
 *    screen has nothing to do with its value. It is not displayed anywhere in
 *    the product any more.
 * 2. **Données récupérées** — TanStack Query's own `dataUpdatedAt` for the
 *    combined holdings query, as a time only. It says when the *data was
 *    fetched*, which is a fact the client owns; it is deliberately **not**
 *    labelled as a recalculation time, because no wall-clock recalculation
 *    timestamp exists anywhere on the wire.
 *    Since the tile above it went, this is the screen's whole freshness
 *    signal, which is why it distinguishes "…" (in flight) from "—" (settled
 *    with nothing).
 * 3. **Action requise** — the `action-requise` bucket's size, from the same
 *    `classifyControlRow` the table groups by and the dashboard's attention
 *    panel counts (AC137).
 * 4/5. **Récupérations en échec / en cours** — `countControlJobs`, over the
 *    `FAILED` and `PENDING`/`IN_PROGRESS` history statuses this screen has
 *    already read.
 *
 * ## Banners (the design's three treatments)
 *
 * Price unavailable is **loss**, FX rate unavailable is **warn**, a genuine
 * 429 is **neutral** — a deliberate assignment, applied to the two error
 * sources UR-32 already established (this screen's own live reads, and
 * `useDerivedReadErrors`' scan of what another screen's cached read already
 * failed with). Every message comes from `messageForError`, never from the
 * server's English `detail`/`title` (FR-110/FR-128).
 *
 * **The rate-limited banner carries no retry countdown**, which the design
 * asks for: `ApiError` captures `status` and the problem `code` only, and
 * nothing in the app reads a `Retry-After` header, so there is no real number
 * to count down from. Inventing one would be a fabricated figure on a screen
 * whose entire purpose is telling the truth about data quality. The audited
 * copy already says what to do ("Patientez un instant puis réessayez").
 *
 * ## The footer progress bar
 *
 * The bar reports the **per-row fan-out**: how many of the listed instruments
 * have had their one-shot history-status read settle. That is a real
 * numerator and a real denominator — the fan-out is bounded at 4 concurrent
 * by `cheapReadBudget`, so it genuinely arrives progressively — and it
 * disappears once every row has settled. It is **not** progressive per-row
 * *valuation*, which this app cannot report at all and which stays an open
 * question; no denominator is fabricated to stand in for it.
 *
 * **Freshness (UR-31)** and **error surfacing (UR-32)** are both driven from
 * queries this screen already mounts or from the shared cache — see
 * `use-calc-epoch-freshness.ts`/`use-derived-read-errors.ts`'s own doc
 * comments for the exact mechanism and honesty constraints.
 */
type BannerTone = "loss" | "warn" | "neutral";

const BANNER_ICON: Readonly<Record<BannerTone, IconName>> = {
  loss: "circle-alert",
  warn: "alert-triangle",
  neutral: "info",
};

/**
 * A business error is a banner with a 3px inset left bar, in
 * place, never a toast. Screen-local rather than a kit primitive — the kit
 * ships no banner, and this milestone's rule is to compose what exists rather
 * than grow the kit speculatively from one call site.
 */
function ControlsBanner({
  tone,
  testId,
  children,
}: {
  readonly tone: BannerTone;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  // The treatment is the kit's (`k-banner`, the 3px inset bar)
  // — this wrapper survives only to keep the screen's own
  // tone vocabulary and test handles. The CSS was hoisted out of
  // `controls.css`, where it was the second copy of a shared pattern.
  return (
    <Banner tone={tone} icon={BANNER_ICON[tone]} testId={testId}>
      {children}
    </Banner>
  );
}

/** The tone assignment for the two valuation failures it names; anything else stays neutral rather than borrowing a meaning it was not given. */
const DERIVED_ERROR_TONE: Readonly<Record<string, BannerTone>> = {
  VALUATION_PRICE_UNAVAILABLE: "loss",
  VALUATION_FX_RATE_UNAVAILABLE: "warn",
};

function derivedErrorTone(code: string | undefined): BannerTone {
  return (code !== undefined ? DERIVED_ERROR_TONE[code] : undefined) ?? "neutral";
}

/** A genuine throttle — the instance-wide `ADMISSION_BOUND_EXCEEDED` 429 this screen's own fan-out can provoke, not the manual-price *cap* that also uses 429. */
function throttledError(error: unknown): ApiError | undefined {
  return error instanceof ApiError && error.status === 429 && error.code !== undefined
    ? error
    : undefined;
}

const REFRESH_TIME_FORMATTER = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });

/**
 * `dataUpdatedAt` as a French time only, never a full date and never a claim
 * about when anything was recalculated — an em dash before the first
 * successful fetch, rather than a zero or a guess.
 */
function formatFetchedAt(dataUpdatedAt: number | undefined): string {
  return dataUpdatedAt !== undefined && Number.isFinite(dataUpdatedAt)
    ? REFRESH_TIME_FORMATTER.format(new Date(dataUpdatedAt))
    : "—";
}

export function ControlsRoute() {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const queryClient = useQueryClient();
  const [manualPriceHolding, setManualPriceHolding] = useState<HoldingResponse | undefined>(
    undefined,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);

  // UR-41: the row derivation moved verbatim into `useControlRows` so the
  // dashboard's attention panel reads the *same* rows through the *same*
  // classifier. AC137 ("the dashboard's counts match what Contrôles lists")
  // is only honestly satisfiable that way — see that hook's own doc comment
  // for why a second derivation would be the defect rather than the fix.
  // Nothing about this screen's behaviour changes: same queries, same keys,
  // same shared cache, same bounded fan-out.
  const {
    rows,
    instrumentSet,
    isInitialLoading,
    isHoldingsError,
    holdingsError,
    isScanLoading,
    isScanError,
    scanError,
  } = useControlRows();
  const freshness = useCalcEpochFreshness();
  const derivedErrors = useDerivedReadErrors();

  const jobs = countControlJobs(rows);

  // The strip's "Action requise" tile counts the same bucket the table groups
  // by, through the same `classifyControlRow` — never a second classification
  // (AC137's own reasoning applies here too, one screen further in).
  const actionRequiredCount = rows.filter(
    (row) => classifyControlRow(row) === "action-requise",
  ).length;

  // A 429 on this screen's own bounded fan-out: the design's third banner.
  const fanOutThrottle = rows
    .flatMap((row) => [row.detailError, row.historyStatusError])
    .map(throttledError)
    .find((error) => error !== undefined);

  const showProgress = rows.length > 0 && jobs.checked < rows.length;

  const progressBar = (
    <ProgressBar
      value={jobs.checked}
      max={rows.length}
      label={CONTROLS_COPY.instrumentCheckProgress}
      valueLabel={`${jobs.checked} / ${rows.length}`}
    />
  );

  async function refreshValuation(): Promise<void> {
    setIsRefreshing(true);
    try {
      // `epochWillAdvance: false` — this is a re-read, not a write, so no
      // `calc_epoch` advance is expected and none is claimed.
      await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false });
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <section data-testid="controls-screen" className="controls-screen">
      <PageHeader
        title={CONTROLS_COPY.screenTitle}
        subtitle={CONTROLS_COPY.screenSubtitle}
        actions={
          <Button
            variant="secondary"
            iconLeft="refresh-cw"
            loading={isRefreshing}
            data-testid="controls-refresh-valuation"
            onClick={() => void refreshValuation()}
          >
            {CONTROLS_COPY.refreshValuation}
          </Button>
        }
      />

      <Card padding="none" data-testid="controls-strip">
        <div className="controls-strip">
          {/* **No « Valorisation / version <n> » tile.** It carried the
              combined `calcEpoch` and nothing else, and that counter is no
              longer displayed anywhere (asked for 2026-09-08): it is
              cache-invalidation bookkeeping, not a fact about this
              portfolio's data. The strip is four tiles, and the freshness
              question it answered is answered better by the one beside it. */}
          <div className="controls-strip-item">
            <StatTile
              data-testid="controls-fetched-at"
              label={CONTROLS_COPY.dataFetchedAt}
              icon="clock"
              value={
                <span className="k-num">
                  {/* "…" while the read is in flight, "—" only once it has
                      settled without a timestamp. Loading and unavailable are
                      different states, and this is now the strip's only
                      freshness tile, so the difference is worth the branch:
                      keyed off `isPending`, not off the absence of a
                      timestamp, because a *failed* read also has no
                      `dataUpdatedAt` and that condition would call an error
                      "loading" (`ControlsRoute.test.tsx`'s rejected-read case
                      caught exactly that on the tile this replaces). */}
                  {freshness.dataUpdatedAt !== undefined
                    ? formatFetchedAt(freshness.dataUpdatedAt)
                    : freshness.isPending
                      ? "…"
                      : "—"}
                </span>
              }
            />
          </div>
          <div className="controls-strip-item">
            <StatTile
              data-testid="controls-attention-count"
              label={CONTROLS_COPY.actionRequired}
              icon="circle-alert"
              value={<span className="k-num">{actionRequiredCount}</span>}
              delta={
                <span className="controls-strip-sub">
                  {fill(CONTROLS_COPY.actionRequiredOutOf, { count: String(rows.length) })}
                </span>
              }
            />
          </div>
          <div className="controls-strip-item">
            <StatTile
              data-testid="controls-failed-count"
              label={CONTROLS_COPY.fetchesFailed}
              icon="ban"
              value={<span className="k-num">{jobs.failed}</span>}
            />
          </div>
          <div className="controls-strip-item">
            <StatTile
              data-testid="controls-running-count"
              label={CONTROLS_COPY.fetchesRunning}
              icon="loader"
              value={<span className="k-num">{jobs.running}</span>}
            />
          </div>
        </div>
      </Card>

      {isHoldingsError && (
        <ControlsBanner
          tone={throttledError(holdingsError) !== undefined ? "neutral" : "loss"}
          testId="controls-holdings-error"
        >
          {messageForError(holdingsError).text}
        </ControlsBanner>
      )}

      {isScanError && (
        <ControlsBanner tone="warn" testId="controls-scan-error">
          {CONTROLS_COPY.scanErrorPrefix} {messageForError(scanError).text}
        </ControlsBanner>
      )}

      {derivedErrors.length > 0 && (
        <div data-testid="controls-derived-errors" className="controls-banners">
          {derivedErrors.map((entry) => (
            <ControlsBanner
              key={JSON.stringify(entry.queryKey)}
              tone={derivedErrorTone(entry.error.code)}
              testId="controls-derived-error"
            >
              {messageForError(entry.error).text}
            </ControlsBanner>
          ))}
        </div>
      )}

      {fanOutThrottle !== undefined && (
        <ControlsBanner tone="neutral" testId="controls-rate-limited">
          {messageForError(fanOutThrottle).text}
        </ControlsBanner>
      )}

      {isScanLoading && (
        <p data-testid="controls-scan-loading" role="status" className="controls-note">
          {CONTROLS_COPY.scanLoading}
        </p>
      )}
      {!isScanLoading && instrumentSet.truncated && (
        <p data-testid="controls-truncated-note" className="controls-note controls-note-warn">
          {CONTROLS_COPY.truncatedNote}
        </p>
      )}

      {isInitialLoading && (
        <Card padding="none" data-testid="controls-loading">
          <Skeleton rows={5} size="compact" label={CONTROLS_COPY.loadingControls} />
        </Card>
      )}

      {!isInitialLoading && rows.length === 0 && (
        <Card data-testid="controls-empty">
          <div className="controls-empty">
            <p>{CONTROLS_COPY.noInstruments}</p>
            <AddTransactionEmptyAction stateId="zero-instruments" testId="controls-empty-action" />
          </div>
        </Card>
      )}

      {rows.length > 0 &&
        (isDesktop ? (
          <Card padding="none" data-testid="controls-list-card">
            <ControlsTable rows={rows} onEnterPrice={setManualPriceHolding} />
            {showProgress && (
              <div className="controls-foot" data-testid="controls-progress">
                {progressBar}
              </div>
            )}
          </Card>
        ) : (
          <>
            <ControlsCardList rows={rows} onEnterPrice={setManualPriceHolding} />
            {showProgress && <Card data-testid="controls-progress">{progressBar}</Card>}
          </>
        ))}

      <ManualPriceDialog
        open={manualPriceHolding !== undefined}
        onOpenChange={(next) => {
          if (!next) setManualPriceHolding(undefined);
        }}
        holding={manualPriceHolding}
      />
    </section>
  );
}
