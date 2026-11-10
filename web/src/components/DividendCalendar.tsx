import { parseDecimalString } from "@kerdial/core-decimal";
import type { ReactNode } from "react";
import type { DividendPeriodBucket } from "../lib/api-client.js";
import { DIVIDEND_COPY } from "../lib/copy/dividends.js";
import { monthLabel } from "../lib/copy/months.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import {
  HeatCalendar,
  effectiveSelection,
  fillMonthGaps as fillHeatMonthGaps,
  heatStep,
} from "./HeatCalendar.js";
import { LedgerAmount } from "./LedgerAmount.js";

/**
 * The Dividendes screen's year × month calendar.
 *
 * The grid itself is `HeatCalendar.tsx` (the Activité
 * screen renders the same one over transactions); this file is what makes it
 * a *dividend* calendar: the magnitude is `grossBase`, the year column is
 * `years[]`'s gross, and the detail line is one line, two figures, **never
 * their difference** (LD-1 — netting decides for the reader which one
 * matters). `data-testid`s are unchanged from before the extraction, which is
 * how `DividendCalendar.test.tsx` and `dividends.spec.ts` prove nothing moved.
 */

/** The zero-fill (AC-289's rendering half), with the dividend bucket's own empty shape — exported so the gap rule stays provable without rendering. */
export function fillMonthGaps(
  buckets: readonly DividendPeriodBucket[],
): readonly DividendPeriodBucket[] {
  return fillHeatMonthGaps(buckets, (period) => ({
    period,
    grossBase: "0",
    withholdingBase: "0",
  }));
}

export { effectiveSelection, heatStep };

export interface DividendCalendarProps {
  readonly years: readonly DividendPeriodBucket[];
  readonly months: readonly DividendPeriodBucket[];
  readonly baseCurrency: string;
  /** The selected month, when the parent owns it; otherwise the calendar keeps its own, defaulting to the latest non-empty month. */
  readonly selected?: string;
  readonly onSelect?: (period: string) => void;
  /** Rendered under the foot — the parent's payment list for the selected month. */
  readonly children?: ReactNode;
}

const magnitude = (bucket: DividendPeriodBucket) => parseDecimalString(bucket.grossBase);

export function DividendCalendar({
  years,
  months,
  baseCurrency,
  selected,
  onSelect,
  children,
}: DividendCalendarProps) {
  const minorUnit = resolveMinorUnit(baseCurrency);
  const format = (amount: string) => tryFormatAmount("monetary", amount, minorUnit);

  return (
    <div className="dividends-card k-card k-card-pad" data-testid="dividend-calendar">
      <div className="dividends-card-head">
        <span className="dividends-card-title">{DIVIDEND_COPY.calendarTitle}</span>
        <span className="dividends-card-unit">
          {DIVIDEND_COPY.calendarUnit}
          <span aria-hidden="true"> · </span>
          {baseCurrency}
        </span>
      </div>
      <HeatCalendar
        months={months}
        years={years}
        magnitude={magnitude}
        cellLabel={(bucket) =>
          `${monthLabel(bucket.period)} : ${format(bucket.grossBase) ?? bucket.grossBase}`
        }
        renderYearTotal={(_year, bucket) =>
          bucket === undefined ? (
            <LedgerAmount amount={null} currency={baseCurrency} />
          ) : (
            (format(bucket.grossBase) ?? (
              <LedgerAmount amount={bucket.grossBase} currency={baseCurrency} />
            ))
          )
        }
        renderDetail={(bucket) => (
          <>
            <strong>{monthLabel(bucket.period)}</strong>
            <span className="k-heatcal-sep" aria-hidden="true">
              ·
            </span>
            <span className="k-num" data-testid="dividend-calendar-detail-gross">
              <LedgerAmount amount={bucket.grossBase} currency={baseCurrency} />
            </span>{" "}
            {DIVIDEND_COPY.detailGross}
            <span className="k-heatcal-sep" aria-hidden="true">
              ·
            </span>
            {DIVIDEND_COPY.detailWithholding}{" "}
            <span className="k-num" data-testid="dividend-calendar-detail-withholding">
              <LedgerAmount amount={bucket.withholdingBase} currency={baseCurrency} />
            </span>
          </>
        )}
        copy={{
          caption: DIVIDEND_COPY.calendarCaption,
          yearColumn: DIVIDEND_COPY.columnYear,
          totalColumn: DIVIDEND_COPY.columnTotal,
          empty: DIVIDEND_COPY.detailNoPayment,
          rampLess: DIVIDEND_COPY.rampLess,
          rampMore: DIVIDEND_COPY.rampMore,
        }}
        testId="dividend-calendar"
        {...(selected !== undefined ? { selected } : {})}
        {...(onSelect !== undefined ? { onSelect } : {})}
      >
        {children}
      </HeatCalendar>
    </div>
  );
}
