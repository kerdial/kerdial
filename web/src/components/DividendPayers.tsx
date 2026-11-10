import { useMemo, useState } from "react";
import { parseDecimalString, toDecimalString, type Decimal } from "@kerdial/core-decimal";
import type { DividendInstrumentRow } from "../lib/api-client.js";
import { DIVIDEND_COPY, expandOthersCopy, othersCopy } from "../lib/copy/dividends.js";
import { InstrumentIconTile } from "./InstrumentIconTile.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { Button } from "./ui/index.js";

/**
 * « Qui vous paie » — the ranked payer list (it supersedes the four-column sortable grid).
 *
 * The rows arrive gross-descending from the server (the `ORDER BY` in
 * `dividend-summary-service.ts`) and are rendered **in that order, with no
 * sort control**: "which position pays me most" is the one question this list
 * answers, and the bar beside each name *is* the ranking made visible. FR-269
 * as originally written (name sort, either direction) is superseded — see the
 * root spec's dated amendment.
 *
 * ## The fold
 *
 * The first {@link TOP_N} render individually; the remainder fold into one
 * « N autres » row whose gross, withholding and payment count are the exact
 * `Decimal` sums of the rows it hides, so the list still accounts for every
 * cent the hero states (FR-270's "the total is the sum of what is shown" holds
 * across shown + folded). The fold expands in place — the same list, every
 * row — and collapses again; it is a `<button aria-expanded>`, not a link to a
 * screen that does not exist.
 *
 * ## Two figures per row, never netted (LD-1, AC-283)
 *
 * The gross and the withholding are two separately-queryable nodes
 * (`dividend-payer-gross`, `dividend-payer-withholding`) and no third, netted
 * figure exists anywhere in this file. The bar encodes gross only.
 *
 * ## The tile
 *
 * `InstrumentIconTile` with the response's own `hasIcon` (IK-10: a `LEFT
 * JOIN`ed presence flag, no per-row probe) and, as its monogram fallback, the
 * `symbol` when the instrument has one — a real ticker from the instrument
 * row — else three letters of the name, `holdings.css`'s standing rule that a
 * monogram is never shown *as* a ticker.
 *
 * ## One DOM, two layouts
 *
 * Each row is five flat grid items — tile, identity, gross, bar, meta —
 * placed by `grid-template-areas` in `dividends.css`. The mobile re-flow (the
 * meta line moving from under the amount to under the bar, so a long name
 * keeps its room) is a template change in the stylesheet, not a second
 * markup branch here.
 */
const TOP_N = 8;
const TILE_LETTERS = 3;
const TILE_SYMBOL_LETTERS = 4;

export interface DividendPayersProps {
  readonly rows: readonly DividendInstrumentRow[];
  readonly baseCurrency: string;
}

export function monogramOf(row: Pick<DividendInstrumentRow, "symbol" | "displayName">): string {
  if (row.symbol !== null && row.symbol !== "") return row.symbol.slice(0, TILE_SYMBOL_LETTERS);
  return row.displayName.slice(0, TILE_LETTERS);
}

interface Folded {
  readonly count: number;
  readonly paymentCount: number;
  readonly grossBase: Decimal;
  readonly withholdingBase: Decimal;
}

export function DividendPayers({ rows, baseCurrency }: DividendPayersProps) {
  const [expanded, setExpanded] = useState(false);
  const { max, rest } = useMemo(() => {
    const zero = parseDecimalString("0");
    const max = rows.reduce((highest, row) => {
      const gross = parseDecimalString(row.grossBase);
      return gross.gt(highest) ? gross : highest;
    }, zero);
    const folded = rows.slice(TOP_N);
    const rest: Folded | undefined =
      folded.length === 0
        ? undefined
        : folded.reduce<Folded>(
            (sum, row) => ({
              count: sum.count + 1,
              paymentCount: sum.paymentCount + row.paymentCount,
              grossBase: sum.grossBase.plus(parseDecimalString(row.grossBase)),
              withholdingBase: sum.withholdingBase.plus(parseDecimalString(row.withholdingBase)),
            }),
            { count: 0, paymentCount: 0, grossBase: zero, withholdingBase: zero },
          );
    return { max, rest };
  }, [rows]);

  const shown = expanded ? rows : rows.slice(0, TOP_N);
  // Percent of the largest payer, in `Decimal`, as a CSS width. The folded row
  // can exceed the largest single payer; it is clamped to the track, since a
  // bar past its track would be a layout bug, not information.
  const widthOf = (gross: string): string => {
    if (max.isZero()) return "0%";
    const percent = parseDecimalString(gross).div(max).mul(100);
    const clamped = percent.gt(100) ? parseDecimalString("100") : percent;
    return `${toDecimalString(clamped.toDecimalPlaces(2))}%`;
  };

  const figures = (gross: string, withholding: string, paymentCount: number) => (
    <>
      <span className="dividends-payer-gross" data-testid="dividend-payer-gross">
        <LedgerAmount amount={gross} currency={baseCurrency} />
      </span>
      <span className="dividends-payer-bar" aria-hidden="true">
        <span
          className="dividends-payer-bar-fill"
          data-testid="dividend-payer-bar"
          style={{ width: widthOf(gross) }}
        />
      </span>
      <span className="dividends-payer-meta k-num">
        <span data-testid="dividend-payer-count">{paymentCount}</span> {DIVIDEND_COPY.payersCount}
        <span className="dividends-payer-sep" aria-hidden="true">
          ·
        </span>
        {DIVIDEND_COPY.payersWithholding}{" "}
        <span data-testid="dividend-payer-withholding">
          <LedgerAmount amount={withholding} currency={baseCurrency} />
        </span>
      </span>
    </>
  );

  return (
    <div className="dividends-card k-card k-card-pad" data-testid="dividend-payers">
      <div className="dividends-card-head">
        <span className="dividends-card-title">{DIVIDEND_COPY.payersTitle}</span>
        {rest !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="dividend-payers-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? DIVIDEND_COPY.payersCollapse : expandOthersCopy(rest.count)}
          </Button>
        )}
      </div>
      <ol className="dividends-payers">
        {shown.map((row) => (
          <li
            key={row.instrumentId}
            className="dividends-payer"
            data-testid="dividend-payer"
            data-instrument-id={row.instrumentId}
          >
            <span className="dividends-payer-tile">
              <InstrumentIconTile instrumentId={row.instrumentId} hasIcon={row.hasIcon}>
                <span className="holdings-asset-tile k-mono" aria-hidden="true">
                  {monogramOf(row)}
                </span>
              </InstrumentIconTile>
            </span>
            <span className="dividends-payer-identity">
              <span className="dividends-payer-name" data-testid="dividend-payer-name">
                {row.displayName}
              </span>
              {row.symbol !== null && row.symbol !== "" && (
                <span className="dividends-payer-symbol k-mono" data-testid="dividend-payer-symbol">
                  {row.symbol}
                </span>
              )}
            </span>
            {figures(row.grossBase, row.withholdingBase, row.paymentCount)}
          </li>
        ))}
        {!expanded && rest !== undefined && (
          <li
            className="dividends-payer dividends-payer-rest"
            data-testid="dividend-payers-rest"
            data-count={rest.count}
          >
            <span className="dividends-payer-tile">
              <span
                className="holdings-asset-tile k-mono dividends-payer-rest-tile"
                aria-hidden="true"
              >
                +{rest.count}
              </span>
            </span>
            <span className="dividends-payer-identity">
              <span className="dividends-payer-name" data-testid="dividend-payer-name">
                {othersCopy(rest.count)}
              </span>
            </span>
            {figures(
              toDecimalString(rest.grossBase),
              toDecimalString(rest.withholdingBase),
              rest.paymentCount,
            )}
          </li>
        )}
      </ol>
    </div>
  );
}
