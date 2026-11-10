import type { TransactionKind } from "@kerdial/api-contracts";
import { TRANSACTION_COPY } from "../lib/copy/transactions.js";
import { transactionKindLabel } from "../lib/transaction-kind.js";
import {
  KIND_FAMILIES,
  familyOf,
  firstKindOf,
  type KindFamily,
} from "../lib/transaction-kind-family.js";
import { SegmentedControl } from "./ui/index.js";

/**
 * The design's type tabs. Six tabs there, nine here: the
 * mock's **Transfer** is the `TRANSFER_OUT` tab since `security-transfer`
 * (OD-4 (a) — one « units out » entry point, whose destination
 * portfolio is optional; F-11 retires this comment's old "not built" line),
 * while `DRIP`, `CURRENCY_EXCHANGE` and `SHARE_DISTRIBUTION` are
 * later additions, and `INTEREST` (`cash-interest`, R-6) sits after
 * « Dividende » with the cash-income family, and `FEE` (`portfolio-cash`) is
 * the last pill, after « Change ». **`TRANSFER_IN` is never a
 * tab**: a receiving leg is written only by the `TRANSFER_OUT` that names its
 * portfolio.
 *
 * Labels come from `lib/transaction-kind.ts` so a kind reads the same word in
 * the tab strip, the ledger badge and the detail drawer — except the transfer
 * tab, which names the action (« Transfert de titres ») rather than the leg it
 * writes (« Transfert sortant »): the form records both legs.
 */
export const KIND_OPTIONS: readonly { value: TransactionKind; label: string }[] = [
  { value: "BUY", label: transactionKindLabel("BUY") },
  { value: "SELL", label: transactionKindLabel("SELL") },
  { value: "DEPOSIT", label: transactionKindLabel("DEPOSIT") },
  { value: "WITHDRAWAL", label: transactionKindLabel("WITHDRAWAL") },
  { value: "DIVIDEND", label: transactionKindLabel("DIVIDEND") },
  { value: "INTEREST", label: transactionKindLabel("INTEREST") },
  { value: "DRIP", label: transactionKindLabel("DRIP") },
  { value: "CURRENCY_EXCHANGE", label: transactionKindLabel("CURRENCY_EXCHANGE") },
  { value: "SHARE_DISTRIBUTION", label: transactionKindLabel("SHARE_DISTRIBUTION") },
  { value: "TRANSFER_OUT", label: TRANSACTION_COPY.transferTab },
  { value: "FEE", label: transactionKindLabel("FEE") },
];

const FAMILY_OPTIONS: readonly { value: KindFamily; label: string }[] = [
  { value: "SECURITIES", label: TRANSACTION_COPY.familySecurities },
  { value: "CASH", label: TRANSACTION_COPY.familyCash },
  { value: "INCOME", label: TRANSACTION_COPY.familyIncome },
  { value: "TRANSFERS", label: TRANSACTION_COPY.familyTransfers },
];

/**
 * The type tabs swap the field set. The form's
 * `register("kind")` still owns the value — these buttons write to it via
 * `onSelect`, so every per-kind branch in the form reads exactly the same
 * watched field it always did.
 *
 * `transaction-dialog-refresh` FR-643..FR-646: the ten tabs are
 * grouped under four families. The family is **derived** from `kind`, never
 * held as a second piece of state that could disagree with the form, and a
 * family change goes through the same `onSelect` as a pill (its first kind,
 * FR-644) — so the form's `setValue("kind")` stays the only writer. Families
 * are `SegmentedControl` radios (arrow keys move and select, NFR-84); the
 * pills keep `role="tab"` and their `kind-tab-<KIND>` handles, and only the
 * selected family's pills are rendered. Neither row carries an icon (N8).
 */
export function TransactionKindTabs({
  kind,
  onSelect,
}: {
  readonly kind: TransactionKind;
  readonly onSelect: (kind: TransactionKind) => void;
}) {
  const family = familyOf(kind);
  const pills = KIND_FAMILIES.find((entry) => entry.family === family)?.kinds ?? [];
  return (
    <div className="k-ov-kind-picker">
      <SegmentedControl
        options={FAMILY_OPTIONS}
        value={family}
        onChange={(next) => {
          const chosen = FAMILY_OPTIONS.find((option) => option.value === next);
          if (chosen !== undefined) onSelect(firstKindOf(chosen.value));
        }}
        label={TRANSACTION_COPY.familyGroupLabel}
        fullWidth
        testIdPrefix="family-tab-"
      />
      <div className="k-ov-kinds" role="tablist" aria-label={TRANSACTION_COPY.kindTablist}>
        {/* Spec order within the family (FR-643), not `KIND_OPTIONS`' order. */}
        {pills
          .flatMap((value) => KIND_OPTIONS.filter((option) => option.value === value))
          .map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={kind === option.value}
              data-testid={`kind-tab-${option.value}`}
              className="k-ov-kind"
              onClick={() => onSelect(option.value)}
            >
              {option.label}
            </button>
          ))}
      </div>
    </div>
  );
}
