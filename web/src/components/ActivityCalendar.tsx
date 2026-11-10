import { useCallback } from "react";
import { parseDecimalString } from "@kerdial/core-decimal";
import type { TransactionCalendar, TransactionCalendarBucket } from "../lib/api-client.js";
import { ACTIVITY_COPY, transactionsCopy } from "../lib/copy/activity.js";
import { monthLabel } from "../lib/copy/months.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { groupThousands, tryFormatAmount } from "../lib/figure-format.js";
import { HeatCalendar } from "./HeatCalendar.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { Button, Card, SegmentedControl } from "./ui/index.js";

/**
 * The Activité screen's « Calendrier » tab. The Dividendes
 * screen's year × month grid (`HeatCalendar.tsx`) over `GET
 * /transactions/calendar`: every month the tenant did something in, toned by
 * **either** how many transactions it held **or** how much changed hands in
 * the base currency, per the « Nombre / Montant » toggle. The toggle rides the
 * URL (`measure=`), like every other view choice on this screen.
 *
 * The detail line always prints **both** figures for the previewed month —
 * the toggle chooses the tone, not the information — and ends with the one
 * action this tab has: « Voir dans le journal », which opens the Journal tab
 * scoped to that month (`from`/`to` = the month's first and last day, cursor
 * reset). The calendar is a way *into* the ledger, not a second ledger.
 *
 * Nothing here is a `<Figure>`: like the Journal's own rows (OD-4), the
 * volume is a plain `<LedgerAmount>` with no provenance badge, and the count
 * is an integer with the app's thousands separator.
 */
export const ACTIVITY_CALENDAR_MEASURES = ["count", "volume"] as const;
export type ActivityCalendarMeasure = (typeof ACTIVITY_CALENDAR_MEASURES)[number];

export const DEFAULT_ACTIVITY_CALENDAR_MEASURE: ActivityCalendarMeasure = "count";

/**
 * `YYYY-MM` → its first and last day, as the `from`/`to` the ledger filters
 * take. The last day comes from `Date`'s own month arithmetic in UTC (day `0`
 * of the following month), so leap years are the runtime's problem and no
 * `Number()` is called — the web's syntactic no-floats rule. Exported for the
 * test that pins February.
 */
export function monthBounds(period: string): { readonly from: string; readonly to: string } {
  const from = `${period}-01`;
  const lastDay = new Date(`${from}T00:00:00Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  return { from, to: `${period}-${String(lastDay.getUTCDate()).padStart(2, "0")}` };
}

/** « 1 234 » — the count with the app's thousands separator, never a locale call. */
export function formatCount(count: number): string {
  return groupThousands(String(count));
}

export interface ActivityCalendarProps {
  readonly calendar: TransactionCalendar;
  readonly measure: ActivityCalendarMeasure;
  readonly onMeasureChange: (measure: ActivityCalendarMeasure) => void;
  /** « Voir dans le journal » — the month's bounds, for the parent to put in the ledger's filters. */
  readonly onOpenMonth: (bounds: { readonly from: string; readonly to: string }) => void;
}

const countMagnitude = (bucket: TransactionCalendarBucket) =>
  parseDecimalString(String(bucket.count));
const volumeMagnitude = (bucket: TransactionCalendarBucket) =>
  parseDecimalString(bucket.volumeBase);

export function ActivityCalendar({
  calendar,
  measure,
  onMeasureChange,
  onOpenMonth,
}: ActivityCalendarProps) {
  const { baseCurrency } = calendar;
  const minorUnit = resolveMinorUnit(baseCurrency);
  const format = useCallback(
    (amount: string) => tryFormatAmount("monetary", amount, minorUnit),
    [minorUnit],
  );
  const byCount = measure === "count";

  return (
    <Card data-testid="activity-calendar">
      <div className="activity-calendar-head">
        <div className="activity-calendar-heading">
          <span className="activity-calendar-title">{ACTIVITY_COPY.calendarTitle}</span>
          <span className="activity-calendar-unit" data-testid="activity-calendar-unit">
            {byCount ? (
              ACTIVITY_COPY.calendarUnitCount
            ) : (
              <>
                {ACTIVITY_COPY.calendarUnitVolume}
                <span aria-hidden="true"> · </span>
                {baseCurrency}
              </>
            )}
          </span>
        </div>
        <SegmentedControl
          label={ACTIVITY_COPY.measureLabel}
          size="sm"
          value={measure}
          onChange={(value) => onMeasureChange(value as ActivityCalendarMeasure)}
          options={[
            { value: "count", label: ACTIVITY_COPY.measureCount },
            { value: "volume", label: ACTIVITY_COPY.measureVolume },
          ]}
        />
      </div>
      <HeatCalendar
        months={calendar.months}
        years={calendar.years}
        magnitude={byCount ? countMagnitude : volumeMagnitude}
        cellLabel={(bucket) =>
          `${monthLabel(bucket.period)} : ${
            byCount
              ? transactionsCopy(bucket.count)
              : `${format(bucket.volumeBase) ?? bucket.volumeBase} ${baseCurrency}`
          }`
        }
        renderYearTotal={(_year, bucket) => {
          if (bucket === undefined) return <LedgerAmount amount={null} currency={baseCurrency} />;
          if (byCount) return formatCount(bucket.count);
          return (
            format(bucket.volumeBase) ?? (
              <LedgerAmount amount={bucket.volumeBase} currency={baseCurrency} />
            )
          );
        }}
        renderDetail={(bucket) => {
          const bounds = monthBounds(bucket.period);
          return (
            <>
              <strong>{monthLabel(bucket.period)}</strong>
              <span className="k-heatcal-sep" aria-hidden="true">
                ·
              </span>
              <span
                className="k-num activity-calendar-figure"
                data-testid="activity-calendar-detail-count"
              >
                {transactionsCopy(bucket.count)}
              </span>
              <span className="k-heatcal-sep" aria-hidden="true">
                ·
              </span>
              <span
                className="k-num activity-calendar-figure"
                data-testid="activity-calendar-detail-volume"
              >
                <LedgerAmount amount={bucket.volumeBase} currency={baseCurrency} />
              </span>{" "}
              {ACTIVITY_COPY.detailVolume}
              <span className="k-heatcal-sep" aria-hidden="true">
                ·
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconRight="chevron-right"
                data-testid="activity-calendar-open-month"
                data-from={bounds.from}
                data-to={bounds.to}
                onClick={() => onOpenMonth(bounds)}
              >
                {ACTIVITY_COPY.openMonthInLedger}
              </Button>
            </>
          );
        }}
        copy={{
          caption: ACTIVITY_COPY.calendarCaption,
          yearColumn: ACTIVITY_COPY.columnYear,
          totalColumn: ACTIVITY_COPY.columnTotal,
          empty: ACTIVITY_COPY.detailNoTransaction,
          rampLess: ACTIVITY_COPY.rampLess,
          rampMore: ACTIVITY_COPY.rampMore,
        }}
        testId="activity-calendar"
      />
    </Card>
  );
}
