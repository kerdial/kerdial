import { useQuery } from "@tanstack/react-query";
import { holdingsQueryOptions } from "../lib/queries.js";

/**
 * `useCalcEpochFreshness` — UR-31 (FR-121/AC113).
 *
 * Reads the **same** `["portfolios","holdings","combined"]` query the
 * Contrôles screen already mounts for its own instrument-set derivation
 * (`ControlsRoute.tsx`'s own `holdingsQueryOptions()` call) — this hook does
 * not issue a second request, it only re-reads the query the screen already
 * has mounted. `useQuery`'s own `dataUpdatedAt` (a query-specific timestamp,
 * milliseconds since epoch, set by TanStack Query itself whenever this
 * query's data last changed) is what backs the "données récupérées à hh:mm"
 * half of the rendered copy — deliberately **not**
 * `useLastFetchTimestamp` (the offline banner's own app-wide max
 * `dataUpdatedAt` across every query), which stays exclusively that banner's
 * concern; this is a query-specific signal, a separate mechanism.
 *
 * ## No `calcEpoch` is returned any more (2026-09-08)
 *
 * This hook used to hand out the combined view's `calcEpoch` so the screens
 * could print "version <n>". **That number is no longer displayed anywhere**
 * — asked for on 2026-09-08: it is an internal cache-invalidation counter, and
 * a reader looking at a valuation has no use for its build number. What is
 * left is the fetch time, which is a fact about *this client's* data and the
 * half a reader can act on ("recharger" if it is old).
 *
 * The name stays `use-calc-epoch-freshness` because the query it reads and the
 * invariant it documents are still the epoch's: `dataUpdatedAt` moves exactly
 * when `["portfolios","holdings","combined"]` gets new data, which is what an
 * epoch advance causes.
 *
 * **The honesty constraint that outlives the version chip:**
 * there is still no wall-clock *recalculation* time anywhere on the wire, so
 * {@link formatFreshnessCopy} says «données récupérées à», never «recalculé
 * à» — `portfolio.updatedAt` is bumped by a plain rename and `calc_epoch` is
 * opaque.
 */
export interface CalcEpochFreshness {
  /** TanStack Query's own `dataUpdatedAt` for this query — `undefined` before the first successful fetch. */
  readonly dataUpdatedAt: number | undefined;
  /**
   * `true` while the first read is still in flight.
   *
   * Distinct from "no value": a read that *failed* has no `dataUpdatedAt`
   * either, so the timestamp alone cannot tell loading from unavailable. A
   * tile that says "—" while still loading claims nothing was ever fetched,
   * which is a different statement from "still fetching".
   */
  readonly isPending: boolean;
}

export function useCalcEpochFreshness(): CalcEpochFreshness {
  const query = useQuery(holdingsQueryOptions());
  return {
    dataUpdatedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : undefined,
    isPending: query.isPending,
  };
}

const FRESHNESS_TIME_FORMATTER = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });

/**
 * *"Données récupérées à `<hh:mm>`"* — the original copy less its
 * *"Dernier recalcul : version `<calcEpoch>`"* half, which stopped being
 * displayed on 2026-09-08 (see this module's header).
 *
 * Time-only French format, never a full date, and `"—"` when not yet known
 * (before the first successful fetch, or after a failed one). It says when the
 * *data was fetched* — a fact this client owns — and never when the server
 * recalculated, which no wire field carries.
 */
export function formatFreshnessCopy(dataUpdatedAt: number | undefined): string {
  const time =
    dataUpdatedAt !== undefined && Number.isFinite(dataUpdatedAt)
      ? FRESHNESS_TIME_FORMATTER.format(new Date(dataUpdatedAt))
      : "—";
  return `Données récupérées à ${time}`;
}
