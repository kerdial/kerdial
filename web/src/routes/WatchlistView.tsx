import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstrumentSummary } from "../lib/api-client.js";
import { AssetSearchPopover } from "../components/AssetSearchPopover.js";
import { EmptyState } from "../components/EmptyState.js";
import { InstrumentCreateDialog } from "../components/InstrumentCreateDialog.js";
import { PageHeader } from "../components/PageHeader.js";
import { PanelLoading } from "../components/PanelLoading.js";
import { PeriodSelector } from "../components/PeriodSelector.js";
import { ValuationErrorState } from "../components/ValuationErrorState.js";
import { WatchlistCardList } from "../components/WatchlistCardList.js";
import { WatchlistTable, watchlistAsOfText } from "../components/WatchlistTable.js";
import { Button } from "../components/ui/index.js";
import { DESKTOP_BREAKPOINT_QUERY, useMediaQuery } from "../hooks/use-media-query.js";
import { EMPTY_STATE_COPY } from "../lib/empty-states.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { messageForError } from "../lib/problem-messages.js";
import { WATCHLIST_PERIOD_PRESETS } from "../lib/period-presets.js";
import {
  watchInstrumentMutationOptions,
  watchedIdSet,
  watchedInstrumentIdsQueryOptions,
  watchlistQueryOptions,
} from "../lib/queries.js";

/**
 * Suivi — the watchlist screen (FR-341, FR-344, FR-345, FR-354, FR-355, FR-357, FR-361,
 * FR-363, FR-373–FR-375, FR-379, UR-47–UR-51, UR-53, UR-54, UR-57, AC-344,
 * AC-345).
 *
 * Router-agnostic, deliberately: this file never imports `router.js`, so it is
 * directly testable without pulling the whole route tree (and with it
 * `virtual:pwa-register/react`) into a unit test. `WatchlistRoute.tsx` is the
 * thin router-bound wrapper that owns the `?window=` round trip — the same
 * split `DividendsRoute`/`DividendsView` and `PerformanceRoute`/
 * `PerformanceView` already use and record.
 *
 * ## Two requests, and none of them per row
 *
 * 1. `GET /watchlist?window=` — every figure on every row, from one read whose
 *    statement count does not scale with the number of rows.
 *    Changing the window changes one query key, so the refetch is **one**
 *    request for any N.
 * 2. `GET /watchlist/ids` — the bounded id set every `<WatchToggle>` on this
 *    screen (and on the Instruments surfaces) resolves its state from (W-6),
 *    mounted **once here**, never per row.
 *
 * The row sparkline adds none of its own (FR-357): it is fed from the embedded,
 * decimated series the response already carries. **Nothing on this screen
 * mounts a chart that fetches.** The analysis — the metric tiles, the
 * position-if-held block (FR-354, and with it the `GET /portfolios/holdings`
 * read this screen used to make), the detail and drawdown charts — lives on
 * `/watchlist/$instrumentId` (`WatchlistAnalysisView.tsx`) since 2026-09-11,
 * one instrument at a time, reached from the row's name or its
 * « Analyser » action. The former all-watched comparison chart went with it.
 *
 * ## The « Ajouter » affordance reuses the existing search, entirely (UR-50)
 *
 * `<AssetSearchPopover>` with its existing `onSelect`/`onCreate` props, and
 * `<InstrumentCreateDialog>` behind the second of them — the same pair
 * `InstrumentPicker.tsx` wires, including its F3 lesson: the dialog is mounted
 * unconditionally as a sibling rather than inside a branch that the success
 * path itself unmounts. **No new search or creation mechanism**: `onSelect`
 * posts the chosen instrument, and `onCreate` runs the existing creation path
 * and then posts the id it produced.
 */
export interface WatchlistViewProps {
  /** The preset id from the URL (`WatchlistRoute.tsx` has already validated it against `WATCHLIST_WINDOW_PRESET_IDS`). */
  readonly window: string;
  readonly onWindowChange: (window: string) => void;
}

export function WatchlistView({ window, onWindowChange }: WatchlistViewProps) {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT_QUERY);
  const queryClient = useQueryClient();

  const watchlistQuery = useQuery(watchlistQueryOptions(window));
  const watchedIdsQuery = useQuery(watchedInstrumentIdsQueryOptions());

  const watch = useMutation(watchInstrumentMutationOptions(queryClient));

  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** The text the user had typed when they reached for « Créer un instrument… » — `InstrumentPicker.tsx`'s own `createSeed`, for the same reason: the popover unmounts its query state the moment the dialog's success path fires. */
  const [createSeed, setCreateSeed] = useState("");

  /** `undefined` until the ids read has answered — which is exactly what makes every toggle on this screen render its `"unknown"` state rather than a false « Suivre ». */
  const watchedIds = watchedIdSet(watchedIdsQuery.data);

  const watchlist = watchlistQuery.data;
  const rows = watchlist?.rows ?? [];

  function watchInstrument(instrument: InstrumentSummary): void {
    setAddOpen(false);
    watch.mutate({ instrumentId: instrument.id });
  }

  return (
    <section data-testid="watchlist-screen">
      <PageHeader
        title={WATCHLIST_COPY.screenTitle}
        subtitle={WATCHLIST_COPY.screenSubtitle}
        range={
          <PeriodSelector
            selected={window}
            onSelect={onWindowChange}
            // This screen's set is `period-presets.ts`' minus `MAX`,
            // which is also exactly the server's own `WATCHLIST_WINDOW_PRESETS`
            // enum — so no offered preset can produce a 400.
            presets={WATCHLIST_PERIOD_PRESETS}
          />
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            iconLeft="plus"
            data-testid="watchlist-add"
            aria-expanded={addOpen}
            loading={watch.isPending}
            onClick={() => setAddOpen((open) => !open)}
          >
            {WATCHLIST_COPY.addAction}
          </Button>
        }
      />

      {addOpen && (
        <div className="k-wl-add" data-testid="watchlist-add-panel">
          <AssetSearchPopover
            label={WATCHLIST_COPY.addSearchLabel}
            testId="watchlist-add-search"
            onSelect={watchInstrument}
            onCreate={(typed) => {
              setCreateSeed(typed);
              setCreateOpen(true);
            }}
          />
        </div>
      )}

      {watch.isError && (
        <p role="alert" data-testid="watchlist-add-error" className="k-wl-row-note">
          {/* The 429 cap and the 404 both reach the user through
              `problem-messages.ts`, which names the watchlist cap's own number
              from `api-limits.ts` — never the server's English `detail`. */}
          {messageForError(watch.error).text}
        </p>
      )}

      {watchlistQuery.isPending && (
        <PanelLoading panelLabel={WATCHLIST_COPY.loadingWatchlist} testId="watchlist-loading" />
      )}

      {watchlistQuery.isError && (
        <ValuationErrorState
          error={watchlistQuery.error}
          testId="watchlist-error"
          panelLabel={WATCHLIST_COPY.watchlistPanel}
          onRetry={() => void watchlistQuery.refetch()}
        />
      )}

      {watchlist !== undefined && rows.length === 0 && (
        <EmptyState
          id="watchlist-empty"
          testId="watchlist-empty"
          action={
            <Button
              variant="secondary"
              size="sm"
              iconLeft="plus"
              data-testid="watchlist-empty-add"
              onClick={() => setAddOpen(true)}
            >
              {EMPTY_STATE_COPY["watchlist-empty"].actionLabel}
            </Button>
          }
        />
      )}

      {watchlist !== undefined && rows.length > 0 && (
        <>
          <p data-testid="watchlist-as-of" className="k-wl-asof">
            {watchlistAsOfText(watchlist.asOfDate)}
          </p>
          {/* Exactly one of the two is mounted (F5) — never both with one
              CSS-hidden, which is what lets an absence assertion be
              `not.toBeInTheDocument()`. */}
          {isDesktop ? (
            <WatchlistTable rows={rows} window={watchlist.window.preset} watchedIds={watchedIds} />
          ) : (
            <WatchlistCardList
              rows={rows}
              window={watchlist.window.preset}
              watchedIds={watchedIds}
            />
          )}
        </>
      )}

      {/* Mounted unconditionally, as a sibling of both branches above — F3
          (`InstrumentPicker.tsx`): rendering it inside the add panel would
          unmount it the instant `onCreated` fires, before its own success panel
          ever paints. `onCreated` then posts the created id, so the creation
          path ends in a watched instrument rather than in a catalogue row the
          user has to find again. */}
      <InstrumentCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialDisplayName={createSeed}
        onCreated={(instrument) => watchInstrument(instrument)}
      />
    </section>
  );
}
