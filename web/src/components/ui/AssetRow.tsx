import type { ReactNode } from "react";
import { AssetClassChip } from "./AssetClassChip.js";

/**
 * A holding as a stacked card — the mobile treatment of the holdings table
 * ("tables become stacked cards, never horizontal scroll").
 *
 * The design puts value and day change at thumb height and the secondary
 * figures on a second line, which is the layout this encodes. Money nodes are
 * passed in already rendered (normally `<Figure>`), so this component never
 * formats — the mobile card and the desktop row show the same string because
 * they receive the same node, not because two call sites agreed.
 */
export interface AssetRowProps {
  readonly ticker: string;
  readonly name: string;
  readonly kind: string;
  /** Market value — a rendered `<Figure>`. */
  readonly value: ReactNode;
  /** Day change — normally a `<DeltaValue>`. */
  readonly delta?: ReactNode;
  /** Secondary line, e.g. "42 titres · 297,15 EUR PMP". */
  readonly quantity?: ReactNode;
  /** Portfolio weight, pre-formatted. */
  readonly weight?: string;
  readonly unrealized?: ReactNode;
  readonly onOpen?: () => void;
  readonly openLabel?: string;
}

export function AssetRow({
  ticker,
  name,
  kind,
  value,
  delta,
  quantity,
  weight,
  unrealized,
  onOpen,
  openLabel,
}: AssetRowProps) {
  const body = (
    <>
      <div className="k-assetrow-head">
        <span className="k-assetrow-tile k-mono" aria-hidden="true">
          {ticker.slice(0, 4)}
        </span>
        <div className="k-assetrow-identity">
          <span className="k-assetrow-ticker k-mono">{ticker}</span>
          <span className="k-assetrow-name">{name}</span>
        </div>
        <div className="k-assetrow-primary">
          <span className="k-assetrow-value">{value}</span>
          {delta}
        </div>
      </div>
      <div className="k-assetrow-secondary">
        <AssetClassChip kind={kind} />
        {quantity !== undefined ? <span>{quantity}</span> : null}
        {weight !== undefined ? <span className="k-num">{weight}</span> : null}
        {unrealized}
      </div>
    </>
  );

  if (onOpen === undefined) return <div className="k-assetrow">{body}</div>;

  return (
    <button
      type="button"
      className="k-assetrow k-assetrow-button"
      onClick={onOpen}
      aria-label={openLabel}
    >
      {body}
    </button>
  );
}
