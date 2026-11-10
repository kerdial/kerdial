import { Decimal } from "@kerdial/core-decimal";
import { type AllocationResult } from "./allocation.js";
import { drawnPercents } from "./cash-position.js";
import { ApiError, type HoldingResponse } from "./api-client.js";
import type { AllocationSegment } from "../components/ui/index.js";

/**
 * `portfolio-detail.ts` — the portfolio workspace's pure derivations,
 * extracted from `routes/PortfolioDetailView.tsx` (which keeps the screen's
 * own rationale in its header comment).
 */

/** How many rows the Aperçu's condensed table shows before deferring to the Positions tab. */
export const CONDENSED_HOLDINGS_ROWS = 5;

/** The 404 mapping — checked directly, not via `messageForError` (which would return display copy, not a boolean). */
export function isPortfolioNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "PORTFOLIO_NOT_FOUND";
}

/**
 * AC136-adjacent honesty rule (AC136 for the
 * dashboard — the identical constraint applies here): there is no wall-clock
 * "last recalculated" anywhere in the portfolio workspace. The only clock
 * rendered is *when this tab's own data was fetched* (`dataUpdatedAt`,
 * TanStack Query's own bookkeeping) — an honest, verifiable fact distinct
 * from "when the server last recomputed", which this wire shape cannot
 * answer at all (`portfolio.updatedAt` is shared with plain renames and must
 * never be read as a recalculation time).
 *
 * It used to lead with « Version <calcEpoch> ». That token is no longer
 * displayed anywhere (2026-09-08): an opaque cache-invalidation counter is not
 * a fact a reader of a valuation can act on, and the fetch clock is.
 */
export function freshnessText(dataUpdatedAt: number): string {
  const time =
    dataUpdatedAt > 0
      ? new Date(dataUpdatedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : undefined;
  return time === undefined ? "Données récupérées à —" : `Données récupérées à ${time}`;
}

/**
 * The 8px class bar's segments, in the *apportioned* 0.01 % units UR-10
 * computed — never a ratio re-derived from raw `currentValue` amounts, which
 * is exactly the rounding drift largest-remainder apportionment exists to
 * remove. `Number.parseInt` (not `Number()`/`parseFloat`, both banned in
 * `web/src`) converts an integer unit count that is already exact; the result
 * only ever becomes a CSS width.
 *
 * Returns `[]` — no bar at all, rather than a misleading one — in exactly the
 * cases `allocation.ts` itself suppresses its roll-up: an unusable total, or
 * rows that do not sum to it.
 */
export function allocationSegments(allocation: AllocationResult): AllocationSegment[] {
  if (allocation.totalUnavailable || !allocation.reconciles) return [];
  const unitsByKind = new Map<string, Decimal>();
  for (const row of allocation.rows) {
    if (row.units === undefined) continue;
    unitsByKind.set(row.kind, (unitsByKind.get(row.kind) ?? new Decimal(0)).plus(row.units));
  }
  // portfolio-cash C-14: a negative « Liquidités » share draws no segment and
  // the others are renormalised so the bar stays full (`drawnPercents`).
  const entries = [...unitsByKind];
  const percents = drawnPercents(entries.map(([, units]) => units));
  return entries.flatMap(([kind], index) => {
    const percent = percents[index];
    return percent === undefined ? [] : [{ kind, percent }];
  });
}

/**
 * The condensed table's row order: descending apportioned weight, tie-broken
 * by the order the server returned. Ranking on `units` (a `Decimal`, compared
 * with `.comparedTo`) rather than on the raw amount strings keeps this on the
 * same numbers the percentages beside them are formatted from.
 */
export function topHoldings(
  holdings: readonly HoldingResponse[],
  allocation: AllocationResult,
): readonly HoldingResponse[] {
  const unitsFor = new Map(allocation.rows.map((row) => [row.instrumentId, row.units]));
  return [...holdings]
    .sort((a, b) => {
      const left = unitsFor.get(a.instrumentId);
      const right = unitsFor.get(b.instrumentId);
      if (left === undefined || right === undefined) return 0;
      return right.comparedTo(left);
    })
    .slice(0, CONDENSED_HOLDINGS_ROWS);
}

export function weightText(allocation: AllocationResult, instrumentId: string): string {
  return allocation.rows.find((row) => row.instrumentId === instrumentId)?.percentageText ?? "—";
}
