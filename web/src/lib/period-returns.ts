import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import type { ValuePoint } from "./chart-series.js";

/**
 * `period-returns.ts` — the periodic (day/week/month/year) % return chart on
 * the Performance screen.
 *
 * **Bucket, then chain.** `GET /portfolios/value-series` is dense over every
 * calendar day in the range (`valuation/src/performance.ts` builds it that
 * way), so a bucket's own return is simply its
 * period-end value against the *previous* bucket's period-end value —
 * `end_i / end_{i-1} - 1`. The very first bucket in the series has no prior
 * bucket to chain from and is dropped from the output entirely (never
 * rendered as an unavailable bar): it is the anchor, not a period.
 *
 * **Decimal throughout.** Every arithmetic step — bucketing aside, which is
 * pure date-string slicing — stays on `Decimal`
 * (`@kerdial/core-decimal`), from each point's original `amount` string.
 * `chart-series.ts`'s `.value` float (pixel-mapping only) is never read
 * here; this module produces the figure a bar's height is *labelled* with,
 * not the pixel it is drawn at — that conversion happens in
 * `PeriodReturnChart.tsx`, the same "one sanctioned conversion, one file"
 * shape `chart-series.ts` itself documents.
 *
 * **A non-positive prior anchor cannot be divided against, honestly.** The
 * series carries a *modelled zero* for every date before the portfolio's
 * first trade (`valuation/src/performance.ts`), so a bucket immediately after
 * that boundary would otherwise divide by zero. That bucket's `pct` is
 * `undefined` and it is counted in {@link PeriodReturnSeries.unavailableCount}
 * — never silently dropped, never rendered as a 0 % return it did not have.
 */

export type ReturnGranularity = "day" | "week" | "month" | "year";

export interface PeriodReturn {
  /** The bucket key — `YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM` or `YYYY` depending on granularity. */
  readonly period: string;
  /** The date of the period-end observation this bucket's return was computed to. */
  readonly periodEndDate: string;
  /** `undefined` when the prior bucket's period-end value was <= 0 — see the module header. */
  readonly pct: Decimal | undefined;
}

export interface PeriodReturnSeries {
  /** Ascending by `periodEndDate`. Never includes the series' own first bucket (the anchor). */
  readonly returns: readonly PeriodReturn[];
  /** Buckets whose `pct` could not be computed against a non-positive prior anchor. */
  readonly unavailableCount: number;
}

/**
 * `YYYY-Www` per ISO 8601 (Monday-start weeks, week 1 contains the year's
 * first Thursday) — ISO rather than a locale week so the bucket a date falls
 * in never depends on the reader's locale.
 */
function isoWeekKey(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoDayNumber = (date.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  date.setUTCDate(date.getUTCDate() - isoDayNumber + 3); // that week's Thursday

  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstIsoDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIsoDayNumber + 3);

  const weekNumber =
    1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${String(date.getUTCFullYear())}-W${weekNumber < 10 ? "0" : ""}${String(weekNumber)}`;
}

function bucketKey(dateStr: string, granularity: ReturnGranularity): string {
  switch (granularity) {
    case "day":
      return dateStr;
    case "week":
      return isoWeekKey(dateStr);
    case "month":
      return dateStr.slice(0, 7);
    case "year":
      return dateStr.slice(0, 4);
  }
}

/** A rejected decimal is dropped, the same way `chart-series.ts` drops a malformed point rather than throwing out of a render. */
function tryParse(amount: string): Decimal | undefined {
  try {
    return parseDecimalString(amount);
  } catch {
    return undefined;
  }
}

/**
 * Buckets `points` (ascending by date, `chart-series.ts`'s own contract) by
 * `granularity` and chains each bucket's period-end value against the
 * previous bucket's, in `Decimal`. Pure — no clock, no DOM — so every branch
 * above is assertable without rendering.
 */
export function computePeriodReturns(
  points: readonly ValuePoint[],
  granularity: ReturnGranularity,
): PeriodReturnSeries {
  // One entry per bucket, keeping the *last* point seen for that key — the
  // period-end value, since `points` arrives ascending by date.
  const buckets = new Map<string, ValuePoint>();
  for (const point of points) {
    buckets.set(bucketKey(point.date, granularity), point);
  }
  const ordered = [...buckets.values()];

  const returns: PeriodReturn[] = [];
  let unavailableCount = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    const priorValue = tryParse(previous.amount);
    const currentValue = tryParse(current.amount);

    const pct =
      priorValue === undefined || currentValue === undefined || priorValue.lte(0)
        ? undefined
        : currentValue.div(priorValue).minus(1);
    if (pct === undefined) unavailableCount += 1;

    returns.push({
      period: bucketKey(current.date, granularity),
      periodEndDate: current.date,
      pct,
    });
  }

  return { returns, unavailableCount };
}
