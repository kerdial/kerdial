import type {
  HistoryStatusResponse,
  HoldingResponse,
  InstrumentDetailResponse,
} from "./api-client.js";
import type { InstrumentHeldState } from "./queries.js";
import type { BadgeTone } from "../components/ui/Badge.js";
import { needsManualPriceEntry } from "./positions.js";
import { formatIsoDateFr } from "./history-status-copy.js";
import { historyStatusLabel, historyStatusTone } from "./history-status-badge.js";
import { marketDataStatusText } from "../components/InstrumentTable.js";

/**
 * The Contrôles screen's row model and its pure derivations — extracted from
 * `components/ControlsTable.tsx` so the classification, badge, copy and
 * grouping logic both presentations (`ControlsTable`/`ControlsCardList`) and
 * (former) `AttentionPanel.tsx` read has a renderer-free home. The screen-level
 * rationale (three actionability groups, the two signal sources, the columns
 * the wire cannot fill) stays documented on `ControlsTable.tsx`.
 */
export type ControlBucket = "action-requise" | "en-cours" | "information";

export interface ControlRowData {
  readonly instrumentId: string;
  readonly heldState: InstrumentHeldState;
  readonly detail: InstrumentDetailResponse | undefined;
  readonly detailError: unknown;
  readonly historyStatus: HistoryStatusResponse | undefined;
  readonly historyStatusError: unknown;
  /** The same-instrument entry from `["portfolios","holdings","combined"]`, when currently held — `undefined` for a historical (fully sold-out) row. */
  readonly holding: HoldingResponse | undefined;
}

export const BUCKET_ORDER: readonly ControlBucket[] = ["action-requise", "en-cours", "information"];

export const BUCKET_LABELS: Readonly<Record<ControlBucket, string>> = {
  "action-requise": "Action requise",
  "en-cours": "En cours",
  information: "Information",
};

export const BUCKET_EMPTY_COPY: Readonly<Record<ControlBucket, string>> = {
  "action-requise": "Rien ne nécessite d'action pour le moment.",
  "en-cours": "Aucune récupération de données en cours.",
  information: "Aucun instrument dans cette catégorie.",
};

/** AC112/FR-120 — the single derivation both presentations read; never re-derived per surface. */
export function classifyControlRow(row: ControlRowData): ControlBucket {
  const needsPrice = row.holding !== undefined && needsManualPriceEntry(row.holding.currentPrice);
  if (needsPrice) return "action-requise";
  if (row.historyStatus?.status === "FAILED") return "action-requise";
  if (row.historyStatus?.status === "PENDING" || row.historyStatus?.status === "IN_PROGRESS") {
    return "en-cours";
  }
  return "information";
}

/**
 * The history-badge tone map, which the
 * Instruments list uses for the same five states: complete = gain, in
 * progress = brand, pending = warn, failed = loss. `NONE` was never in the original
 * set; it takes the neutral, because "no backfill was ever requested" is a
 * statement of fact rather than a state of health (FR-117 and the
 * `instrument-create-ux` D9 precedent both treat it as terminal, never as
 * "not finished yet").
 *
 * It lives here rather than in `history-status-copy.ts` only because that
 * file is another issue's surface this cycle; the two screens must share one
 * table, so whichever lands second should hoist this one rather than write a
 * second.
 */
// The tone and label maps live in `lib/history-status-badge.ts`. Instruments
// needs the identical map; this screen previously carried its own copy.

export interface ControlBadge {
  readonly label: string;
  readonly tone: BadgeTone;
}

/**
 * The history badge. A row whose one-shot read has not resolved says so
 * ("Chargement…"), and one whose read failed says *that* instead — never a
 * badge implying a state the response never reported.
 */
export function controlHistoryBadge(row: ControlRowData): ControlBadge {
  if (row.historyStatus !== undefined) {
    const { status } = row.historyStatus;
    return { label: historyStatusLabel(status), tone: historyStatusTone(status) };
  }
  return row.historyStatusError !== undefined
    ? { label: "Indisponible", tone: "neutral" }
    : { label: "Chargement…", tone: "neutral" };
}

/**
 * The "état des données" badge — the provenance half, read from the same
 * `currentPrice.provenance` {@link needsManualPriceEntry} reads. A row with
 * no current holding is **"Non valorisé"** rather than a warning: a
 * fully-sold-out instrument has no position left to price, which is normal,
 * not a defect.
 */
export function controlDataStatus(row: ControlRowData): ControlBadge {
  if (row.holding === undefined) return { label: "Non valorisé", tone: "neutral" };
  if (needsManualPriceEntry(row.holding.currentPrice)) {
    return { label: "Cours à saisir", tone: "loss" };
  }
  if (row.holding.currentPrice.provenance.priceIsStale === true) {
    return { label: "Cours périmé", tone: "warn" };
  }
  return { label: "Cours à jour", tone: "gain" };
}

/** An ISO date the response may not carry at all — an em dash, never a fabricated or blank cell. */
function isoDateOrAbsent(isoDate: string | null | undefined): string {
  return isoDate === null || isoDate === undefined ? "—" : formatIsoDateFr(isoDate);
}

/** First date actually backfilled — the coverage the response reports, not the coverage that was asked for. */
export function controlCoverageText(row: ControlRowData): string {
  return isoDateOrAbsent(row.historyStatus?.earliestBackfilledDate);
}

/** The date the backfill was asked to start from, which is frequently `null`. */
export function controlRequestedFromText(row: ControlRowData): string {
  return isoDateOrAbsent(row.historyStatus?.requestedFrom);
}

/** Most recent date with data — the honest right-hand edge of the coverage. */
export function controlLastAvailableText(row: ControlRowData): string {
  return isoDateOrAbsent(row.historyStatus?.latestBackfilledDate);
}

export interface ControlJobCounts {
  /** Rows whose backfill ended in `FAILED`. */
  readonly failed: number;
  /** Rows whose backfill is `PENDING` or `IN_PROGRESS`. */
  readonly running: number;
  /** Rows whose one-shot history-status read has settled — resolved *or* errored. The honest numerator of the footer progress bar. */
  readonly checked: number;
}

/**
 * Counts over the rows the screen actually has, for `ControlsRoute.tsx`'s
 * strip and its footer progress bar. `checked` counts *settled* reads rather
 * than valued rows: this screen's per-row fan-out is bounded at 4 concurrent
 * (`cheapReadBudget`), so it genuinely arrives progressively, and that is a
 * real denominator. Progressive per-row **valuation** is a different figure
 * this app cannot report at all — it is not approximated here.
 */
export function countControlJobs(rows: readonly ControlRowData[]): ControlJobCounts {
  let failed = 0;
  let running = 0;
  let checked = 0;
  for (const row of rows) {
    const status = row.historyStatus?.status;
    if (status === "FAILED") failed += 1;
    if (status === "PENDING" || status === "IN_PROGRESS") running += 1;
    if (row.historyStatus !== undefined || row.historyStatusError !== undefined) checked += 1;
  }
  return { failed, running, checked };
}

/**
 * The row's own instrument label — held rows already carry `displayName` on
 * `HoldingResponse` at **zero extra requests** (OD-9(a)'s whole point), so
 * this prefers that over the per-row `instrumentByIdQueryOptions` fetch
 * (`row.detail`), which is only strictly needed for historical
 * (fully-sold-out) rows.
 */
export function controlRowName(row: ControlRowData): string {
  return row.holding?.displayName ?? row.detail?.displayName ?? "…";
}

export function controlRowKind(row: ControlRowData): string {
  return row.holding?.kind ?? row.detail?.kind ?? "—";
}

/**
 * The row's "Signal" column/line — always includes the honest market-data
 * status text (`InstrumentTable.tsx`'s own `marketDataStatusText`, which
 * already surfaces a per-row fetch error, including a genuine
 * `ADMISSION_BOUND_EXCEEDED` 429 on this screen's own fan-out, via
 * `messageForError` — AC114's second required case), prefixed by the
 * manual-pricing reason when that is what put the row in Action requise.
 */
export function controlSignalText(row: ControlRowData): string {
  const needsPrice = row.holding !== undefined && needsManualPriceEntry(row.holding.currentPrice);
  const marketText = marketDataStatusText(row);
  return needsPrice ? `Cours à saisir manuellement · ${marketText}` : marketText;
}

/** Grouped, in `BUCKET_ORDER`, each group's own rows in the order they appear in `rows` — shared by both presentations so they can never diverge on grouping. */
export function groupControlRows(
  rows: readonly ControlRowData[],
): ReadonlyMap<ControlBucket, readonly ControlRowData[]> {
  const groups = new Map<ControlBucket, ControlRowData[]>(BUCKET_ORDER.map((b) => [b, []]));
  for (const row of rows) {
    groups.get(classifyControlRow(row))?.push(row);
  }
  return groups;
}
