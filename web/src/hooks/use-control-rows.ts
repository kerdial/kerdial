import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ControlRowData } from "../lib/control-rows.js";
import type { HoldingResponse } from "../lib/api-client.js";
import {
  deriveInstrumentSet,
  holdingsQueryOptions,
  instrumentByIdQueryOptions,
  instrumentHistoryStatusQueryOptions,
  transactionsInstrumentScanQueryOptions,
  type InstrumentSetEntry,
  type TransactionScanResult,
} from "../lib/queries.js";

/**
 * The **single** derivation of Contrôles' row set, shared by the Contrôles
 * screen itself (`ControlsRoute.tsx`) and the dashboard's attention panel
 * (`AttentionPanel.tsx`, UR-41).
 *
 * **This exists because of AC137**, and the reason is worth stating plainly:
 * AC137 requires that "the dashboard's attention panel counts match what
 * Contrôles lists for the same data". If the dashboard derived its own rows —
 * even from the same endpoints, even with the same intent — the two surfaces
 * could silently drift apart, and AC137 would become *false while its own
 * assertion kept passing*, because each side would be asserted against its own
 * logic. A second derivation would therefore **be** the defect, not the fix.
 * Sharing one hook (and, downstream, one `classifyControlRow`) makes the match
 * true by construction rather than by coincidence, so the only way the counts
 * can disagree is if this function returns two different things to two callers
 * in the same render — which it cannot.
 *
 * **No extra request volume on the dashboard.** Every query below is keyed
 * exactly as the Contrôles screen keys it, so TanStack Query serves both
 * surfaces from one cache entry per instrument: visiting the dashboard warms
 * Contrôles and vice versa. The per-instrument reads stay `background`
 * priority through `cheapReadBudget` (bound 4) — the same bounded fan-out
 * GATE-1 case 8 measured at peak 4 — and `instrumentByIdQueryOptions` carries
 * `staleTime: Infinity`, so a name/kind is fetched at most once per session
 * regardless of how many surfaces ask for it.
 *
 * Deliberately **not** memoised into a stable array identity: `rows` is rebuilt
 * per render from already-memoised inputs, exactly as `ControlsRoute.tsx` built
 * it inline before this extraction. Callers derive counts/groups from it during
 * render and never store it in state, so a fresh array reference is harmless —
 * and `useDerivedReadErrors`'s own `getSnapshot` caching requirement (which
 * *did* need stability, and is red-confirmed in its own suite) does not apply
 * here.
 */
export interface ControlRowsResult {
  /** One entry per instrument the tenant holds or has ever transacted, held-first. */
  readonly rows: readonly ControlRowData[];
  /** The derived instrument set, including its honest `truncated` flag when the bounded transaction scan hit its page cap. */
  readonly instrumentSet: {
    readonly entries: readonly InstrumentSetEntry[];
    readonly truncated: boolean;
  };
  /** True only on the very first load, before any row exists — so a caller can show a skeleton without flashing an empty state. */
  readonly isInitialLoading: boolean;
  /** The combined-holdings read failed; a caller should surface it via `messageForError`. */
  readonly isHoldingsError: boolean;
  /** The combined-holdings error itself, for `messageForError`. */
  readonly holdingsError: unknown;
  /** The bounded transaction scan is still running — distinct from {@link isInitialLoading}, because held rows already render while sold-out ones are still being discovered. */
  readonly isScanLoading: boolean;
  /** The bounded transaction scan failed, so the sold-out half of the set is unknown (not empty). */
  readonly isScanError: boolean;
  /** The scan error itself, for `messageForError`. */
  readonly scanError: unknown;
}

export function useControlRows(): ControlRowsResult {
  const holdingsQuery = useQuery(holdingsQueryOptions());
  const scanQuery = useQuery(transactionsInstrumentScanQueryOptions());

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

  const detailResults = useQueries({
    queries: instrumentSet.entries.map((entry) => instrumentByIdQueryOptions(entry.instrumentId)),
  });
  const historyResults = useQueries({
    queries: instrumentSet.entries.map((entry) =>
      instrumentHistoryStatusQueryOptions(entry.instrumentId),
    ),
  });

  const holdingByInstrumentId = useMemo(() => {
    const map = new Map<string, HoldingResponse>();
    for (const h of holdingsQuery.data?.holdings ?? []) map.set(h.instrumentId, h);
    return map;
  }, [holdingsQuery.data]);

  const rows: ControlRowData[] = instrumentSet.entries.map((entry, index) => ({
    instrumentId: entry.instrumentId,
    heldState: entry.heldState,
    detail: detailResults[index]?.data,
    detailError: detailResults[index]?.error,
    historyStatus: historyResults[index]?.data,
    historyStatusError: historyResults[index]?.error,
    holding: holdingByInstrumentId.get(entry.instrumentId),
  }));

  return {
    rows,
    instrumentSet,
    isInitialLoading: holdingsQuery.isLoading && rows.length === 0,
    isHoldingsError: holdingsQuery.isError,
    holdingsError: holdingsQuery.error,
    isScanLoading: scanQuery.isLoading,
    isScanError: scanQuery.isError,
    scanError: scanQuery.error,
  };
}
