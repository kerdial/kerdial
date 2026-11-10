import type { TransactionKind } from "@kerdial/api-contracts";
import type { BadgeTone } from "../components/ui/Badge.js";

/**
 * The locked transaction-kind tone map.
 *
 * One map, shared by the ledger table, the mobile card list and the detail
 * drawer, because a kind must read the same everywhere.
 *
 * Several entries are decisions rather than values transcribed from the original palette:
 *
 * - **`DRIP`** was not in that palette. It takes `gain`: a dividend reinvestment
 *   is money coming in and then immediately deployed, so it shares the
 *   dividend's economic direction.
 * - **`CURRENCY_EXCHANGE`** takes the `neutral` originally assigned to
 *   "transfer/FX".
 * - **`TRANSFER_OUT`/`TRANSFER_IN`** (`security-transfer`, migration `0070`)
 *   are the original "transfer" at last — a security transfer between two
 *   portfolios, or out of Kerdial — and take the same `neutral`: units change
 *   portfolio, no money moves. The sixth type tab is the
 *   `TRANSFER_OUT` tab; a `TRANSFER_IN` is only ever written by its source.
 * - **`SHARE_DISTRIBUTION`** was not in that palette either. It
 *   takes `gain`: free shares arrive at no cost, which reads the same
 *   direction as a dividend — and deliberately **not** `brand`, which means
 *   "you bought this", the one thing a cashless distribution is not.
 * - **`INTEREST`** (`cash-interest`, CI-D7) takes `gain`: interest earned on
 *   cash is income, the dividend's family — not DEPOSIT's `accent`, which
 *   would read as a contribution. The label tells it apart from « Dividende ».
 * - **`FEE`** (`portfolio-cash`, PC-L5) takes `warn`, as WITHDRAWAL does: cash
 *   leaves the portfolio. The label « Frais de portefeuille » tells it apart
 *   from « Retrait ».
 *
 * `satisfies Record<TransactionKind, BadgeTone>` (cash-interest I-8): a kind
 * missing here is a compile error, not a raw code rendered in a neutral badge.
 */
export const TRANSACTION_KIND_TONE = {
  BUY: "brand",
  SELL: "loss",
  DIVIDEND: "gain",
  DRIP: "gain",
  DEPOSIT: "accent",
  WITHDRAWAL: "warn",
  CURRENCY_EXCHANGE: "neutral",
  SHARE_DISTRIBUTION: "gain",
  // `security-transfer` (TR-20). Also read by the import review
  // step, which renders the kind label.
  TRANSFER_OUT: "neutral",
  TRANSFER_IN: "neutral",
  INTEREST: "gain",
  FEE: "warn",
} as const satisfies Record<TransactionKind, BadgeTone>;

export type TransactionKindKey = keyof typeof TRANSACTION_KIND_TONE;

/** French labels, sentence case. */
export const TRANSACTION_KIND_LABEL: Record<TransactionKindKey, string> = {
  BUY: "Achat",
  SELL: "Vente",
  DIVIDEND: "Dividende",
  DRIP: "Réinvestissement",
  DEPOSIT: "Dépôt",
  WITHDRAWAL: "Retrait",
  CURRENCY_EXCHANGE: "Change",
  // The short form, for a badge repeated down a column — the ledger filter's
  // own option spells out « Attribution d'actions gratuites », which is the
  // same split this file's header already records for DRIP.
  SHARE_DISTRIBUTION: "Actions gratuites",
  // `security-transfer`.
  TRANSFER_OUT: "Transfert sortant",
  TRANSFER_IN: "Transfert entrant",
  INTEREST: "Intérêt",
  // `portfolio-cash` PC-L5.
  FEE: "Frais de portefeuille",
};

function isKnownKind(kind: string): kind is TransactionKindKey {
  return kind in TRANSACTION_KIND_TONE;
}

/** An unknown kind reads neutral rather than borrowing a tone that already means something. */
export function transactionKindTone(kind: string): BadgeTone {
  return isKnownKind(kind) ? TRANSACTION_KIND_TONE[kind] : "neutral";
}

export function transactionKindLabel(kind: string): string {
  return isKnownKind(kind) ? TRANSACTION_KIND_LABEL[kind] : kind;
}

/**
 * Tone to CSS custom property — the same `var(...)`-reference convention
 * `asset-class.ts`'s `CLASS_COLOR` uses, and for the same reason: the value
 * stays in `kerdial.css`, and the token lint rule has nothing to object to at
 * the call site.
 *
 * The 500 step of each ramp, not the badge's own 100/700 pair: a legend dot or
 * a chart marker is a solid 7–10px shape, where the pill's soft background and
 * dark text have no meaning.
 */
export const BADGE_TONE_COLOR: Record<BadgeTone, string> = {
  brand: "var(--teal-500)",
  gain: "var(--gain-500)",
  loss: "var(--loss-500)",
  warn: "var(--warn-500)",
  accent: "var(--apricot-500)",
  neutral: "var(--ink-400)",
};

/**
 * The colour a kind reads as on a legend dot or a chart marker —
 * **derived from {@link TRANSACTION_KIND_TONE}**, never a second kind -> colour
 * table. The badge beside it and the marker on the price chart therefore cannot
 * disagree about what a SELL looks like, which is the whole point of that map
 * being one map.
 *
 * `chart-theme.ts`'s `transactionKindChartColor` resolves this reference to a
 * literal for the canvas, exactly as `assetClassChartColor` does for a class.
 */
export function transactionKindColor(kind: string): string {
  return BADGE_TONE_COLOR[transactionKindTone(kind)];
}
