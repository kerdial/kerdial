import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { messageForError } from "../lib/problem-messages.js";
import { instrumentPricesQueryOptions } from "../lib/queries.js";
import { Badge } from "./ui/index.js";
import { Figure, type ValuedAmount } from "./Figure.js";

export interface PricePointTableProps {
  readonly instrumentId: string;
}

/**
 * `PricePointTable.tsx` — UR-14 (Flag B:
 * pulled forward from Phase 2's Instruments detail route into this Phase 1
 * batch, since AC104 ["the instrument's price history view shows both
 * automated and manual points... distinguishable by `origin`"] has no other
 * Phase 1 surface). Sourced from `GET /instruments/:id/prices` via UR-13's
 * `instrumentPricesQueryOptions` — the server's default 1-year window,
 * exhausted across pages by `listInstrumentPrices` (hard page cap + cursor-
 * advance guard, `api-client.ts`).
 *
 * **Host-agnostic, deliberately**: this component takes only `instrumentId`
 * — no dialog-specific prop — so `InstrumentDetailView` mounts it
 * **unchanged**, exactly as Flag B specifies. It renders **no
 * heading of its own**: each host titles the section it is embedded in,
 * so the detail screen's "Historique des cours" card does not have to carry
 * two titles.
 *
 * **No per-point `quality`/ingestion timestamp** (not on this wire — the
 * mapper drops them, `api/src/instruments/instruments.schema.ts`'s
 * `toPriceHistoryPointResponse`) — this table shows only what the response
 * actually carries: `priceDate`, `close`+`currency`, `sourceKey`, `origin`.
 *
 * **MANUAL vs AUTOMATED, not by colour alone (AC104)**: the Origin column is
 * an **Origin badge** — `<Badge>` with the brand tone for a
 * manual point and the neutral tone for an automated one — but its **text**
 * ("Manuel"/"Automatique") is what discriminates, and it is never dropped in
 * favour of the tint. `<Figure>` adds its own dotted-underline + "M" treatment
 * on a manual point's price cell (`derivedFrom: ["MANUAL_PRICE"]` when
 * `origin === "MANUAL"`). The row with the most recent `priceDate` — the
 * "latest applicable observation" — carries its own explicit text label, not
 * merely a highlight colour. `sourceKey` renders beside the badge as the
 * "source" column: both halves of what the response says about where a
 * point came from, neither inferred from the other.
 *
 * **There is no separate "Currency" column; it is folded into the close.**
 * Every money value in this app renders through `<Figure>` (T-43), and
 * `<Figure kind="monetary">` always emits the currency beside the amount —
 * there is no prop to suppress it, and formatting the amount here to split
 * the two would be exactly the local `.toFixed()` that rule exists to ban. A
 * standalone column would therefore print the code twice on every row. The
 * currency is present, in the close cell beside it.
 */
export function PricePointTable({ instrumentId }: PricePointTableProps) {
  const { data, isLoading, isError, error } = useQuery(instrumentPricesQueryOptions(instrumentId));

  // Most recent `priceDate` first — the latest applicable observation is
  // then simply the first row, never a second pass over the data.
  const points = useMemo(() => {
    if (data === undefined) return [];
    return [...data].sort((a, b) =>
      a.priceDate < b.priceDate ? 1 : a.priceDate > b.priceDate ? -1 : 0,
    );
  }, [data]);

  return (
    <div data-testid="price-point-table">
      {isLoading && <p className="k-inst-note">{INSTRUMENT_COPY.loading}</p>}
      {isError && (
        <p role="alert" data-testid="price-point-table-error" className="k-inst-note-loss">
          {messageForError(error).text}
        </p>
      )}
      {!isLoading && !isError && points.length === 0 && (
        <p data-testid="price-point-table-empty" className="k-inst-note">
          {INSTRUMENT_COPY.noPricePointsInRange}
        </p>
      )}
      {points.length > 0 && (
        <table className="k-inst-price-table">
          <thead>
            <tr>
              <th scope="col">{INSTRUMENT_COPY.columnDate}</th>
              <th scope="col" className="k-inst-cell-right">
                {INSTRUMENT_COPY.columnPrice}
              </th>
              <th scope="col">{INSTRUMENT_COPY.columnOrigin}</th>
              <th scope="col">{INSTRUMENT_COPY.columnSource}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => {
              const isManual = point.origin === "MANUAL";
              const isLatest = index === 0;
              const value: ValuedAmount = {
                amount: point.close,
                currency: point.currency,
                provenance: { derivedFrom: isManual ? ["MANUAL_PRICE"] : ["AUTOMATED"] },
              };
              return (
                <tr
                  key={`${point.priceDate}-${point.origin}-${point.sourceKey}`}
                  data-testid="price-point-row"
                  data-origin={point.origin}
                >
                  <td className="k-num">
                    {formatIsoDateFr(point.priceDate)}
                    {isLatest && (
                      <span data-testid="price-point-latest" className="k-inst-price-latest">
                        {" "}
                        {INSTRUMENT_COPY.carriedForward}
                      </span>
                    )}
                  </td>
                  <td className="k-inst-price-close k-num">
                    <Figure value={value} scale={resolveMinorUnit(point.currency)} />
                  </td>
                  <td>
                    <Badge
                      data-testid="price-point-origin"
                      data-origin={point.origin}
                      tone={isManual ? "brand" : "neutral"}
                    >
                      {isManual ? INSTRUMENT_COPY.originManual : INSTRUMENT_COPY.originAutomatic}
                    </Badge>
                  </td>
                  <td data-testid="price-point-source-key" className="k-inst-price-source">
                    {point.sourceKey}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
