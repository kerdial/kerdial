import type { BadgeTone } from "../components/ui/Badge.js";

/**
 * The locked history-status badge map: complete = gain,
 * in progress = brand, pending = warn, failed = loss.
 *
 * Instruments and Contrôles were restyled in parallel and each
 * needed this map. Both agents wrote it independently and both produced the
 * same five entries, which is reassuring but is not a mechanism: two identical
 * copies are still two copies, and the next edit to one of them is the drift.
 * Hoisted here so the two screens cannot disagree about what "Échec" looks
 * like.
 *
 * `NONE` was not in the original set — it predates the shipped status set. It takes
 * **neutral**: an instrument that was never queued for backfill (a FUND on
 * MANUAL_ONLY, say) is not a problem, and warn would be exactly the false
 * alarm the copy in `history-status-copy.ts` was already fixed to stop making.
 * That is a decision this cycle made, not a value carried over from the original set.
 *
 * The full explanatory sentence stays `history-status-copy.ts`'s job; this
 * module owns only the badge's tone and its short label.
 */
export type HistoryBadgeStatus = "COMPLETE" | "IN_PROGRESS" | "PENDING" | "FAILED" | "NONE";

const TONE: Readonly<Record<HistoryBadgeStatus, BadgeTone>> = {
  COMPLETE: "gain",
  IN_PROGRESS: "brand",
  PENDING: "warn",
  FAILED: "loss",
  NONE: "neutral",
};

/** Short French labels — sentence case. */
const LABEL: Readonly<Record<HistoryBadgeStatus, string>> = {
  COMPLETE: "Complet",
  IN_PROGRESS: "En cours",
  PENDING: "En attente",
  FAILED: "Échec",
  NONE: "Non demandé",
};

export function historyStatusTone(status: HistoryBadgeStatus): BadgeTone {
  return TONE[status];
}

export function historyStatusLabel(status: HistoryBadgeStatus): string {
  return LABEL[status];
}
