import type { TransactionKind } from "@kerdial/api-contracts";

/**
 * `transaction-dialog-refresh` FR-643..FR-645 (TDR-D9): the four
 * families the create dialog's type picker groups its eleven kinds into
 * (`portfolio-cash` appended `FEE` to « Espèces », last — the family still
 * opens on DEPOSIT, FR-644).
 *
 * Order is FR-643's, both for the families and for the kinds inside each:
 * a family change selects its **first** kind (FR-644), so the first entry of
 * each list is a decision, not an accident of typing. `TRANSFER_IN` is in no
 * family — a receiving leg is written only by the `TRANSFER_OUT` that names
 * its portfolio, exactly as it never had a tab.
 */
export type KindFamily = "SECURITIES" | "CASH" | "INCOME" | "TRANSFERS";

export const KIND_FAMILIES: readonly {
  readonly family: KindFamily;
  readonly kinds: readonly TransactionKind[];
}[] = [
  { family: "SECURITIES", kinds: ["BUY", "SELL", "SHARE_DISTRIBUTION"] },
  { family: "CASH", kinds: ["DEPOSIT", "WITHDRAWAL", "CURRENCY_EXCHANGE", "FEE"] },
  { family: "INCOME", kinds: ["DIVIDEND", "INTEREST", "DRIP"] },
  { family: "TRANSFERS", kinds: ["TRANSFER_OUT"] },
];

/** The family a selectable kind belongs to. A kind in no family (`TRANSFER_IN`) reads as `SECURITIES`, the family the dialog opens on. */
export function familyOf(kind: TransactionKind): KindFamily {
  return KIND_FAMILIES.find((entry) => entry.kinds.includes(kind))?.family ?? "SECURITIES";
}

/** The kind a family change selects (FR-644). */
export function firstKindOf(family: KindFamily): TransactionKind {
  return KIND_FAMILIES.find((entry) => entry.family === family)?.kinds[0] ?? "BUY";
}

/**
 * TDR-L16: the **one** `localStorage` key the client writes —
 * a kind code, which is not tenant data. Every other view parameter lives in
 * the URL (`lib/search-params.ts`).
 */
const LAST_KIND_KEY = "kerdial:transaction-dialog:last-kind";

function isSelectableKind(value: string | null): value is TransactionKind {
  return KIND_FAMILIES.some((entry) => (entry.kinds as readonly string[]).includes(value ?? ""));
}

/**
 * FR-645: the kind the dialog opens on — the last one selected, if it is one
 * of the eleven selectable kinds, else `BUY`. Synchronous and wrapped: a browser
 * that throws on storage access (private mode, a disabled store) opens on
 * Achat rather than not opening.
 */
export function readRememberedKind(): TransactionKind {
  try {
    const stored = window.localStorage.getItem(LAST_KIND_KEY);
    return isSelectableKind(stored) ? stored : "BUY";
  } catch {
    return "BUY";
  }
}

/** Records a selection (FR-645: at selection time, not at submit). Private-mode and quota errors are swallowed — memory is a convenience, never a reason for a selection to fail. */
export function rememberKind(kind: TransactionKind): void {
  try {
    window.localStorage.setItem(LAST_KIND_KEY, kind);
  } catch {
    // Nothing to do: the next opening falls back to Achat.
  }
}
