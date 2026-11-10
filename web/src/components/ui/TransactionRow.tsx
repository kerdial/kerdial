import type { ReactNode } from "react";
import { transactionKindLabel, transactionKindTone } from "../../lib/transaction-kind.js";
import { Badge } from "./Badge.js";

/**
 * A ledger entry as a stacked card — the mobile treatment of the transactions
 * table.
 *
 * The kind badge takes its tone from the one shared map, so a `SELL` is the
 * same red here, in the desktop table and in the detail drawer.
 */
export interface TransactionRowProps {
  readonly kind: string;
  readonly asset: string;
  /** Secondary line — "8 titres @ 612,40 EUR · frais 1,20 EUR". */
  readonly detail?: ReactNode;
  readonly date: string;
  /** Net amount — a rendered `<LedgerAmount>` or `<Figure>`. */
  readonly amount: ReactNode;
  readonly onOpen?: () => void;
  readonly openLabel?: string;
}

export function TransactionRow({
  kind,
  asset,
  detail,
  date,
  amount,
  onOpen,
  openLabel,
}: TransactionRowProps) {
  const body = (
    <>
      <div className="k-txrow-main">
        <span className="k-txrow-asset">{asset}</span>
        {detail !== undefined ? <span className="k-txrow-detail">{detail}</span> : null}
        <span className="k-txrow-date">{date}</span>
      </div>
      <div className="k-txrow-side">
        <span className="k-txrow-amount">{amount}</span>
        <Badge tone={transactionKindTone(kind)}>{transactionKindLabel(kind)}</Badge>
      </div>
    </>
  );

  if (onOpen === undefined) return <div className="k-txrow">{body}</div>;

  return (
    <button
      type="button"
      className="k-txrow k-txrow-button"
      onClick={onOpen}
      aria-label={openLabel}
    >
      {body}
    </button>
  );
}
