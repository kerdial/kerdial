import type { CurrencyPair, FxObservation } from "@kerdial/market-ports";

/**
 * What a fetched FX series is checked against before and after it is
 * written. Two kinds of check, with two outcomes:
 *
 *  - **implausible value → reject** ({@link assertPlausibleRate}). A rate an
 *    order of magnitude outside anything the currency has ever traded at is a
 *    provider or parsing defect, never a market move. Rejected like
 *    `assertPositiveRate` rejects: the whole batch, before any write.
 *  - **short series → warn** ({@link findFxSeriesShortfalls}). A series that
 *    stops long before the requested end, or is too sparse over the span it
 *    does cover, is written (its rows are real) but reported, because the
 *    coverage step would otherwise keep re-fetching the same short answer in
 *    silence.
 *
 * The case both exist for: an intercepted `eurofxref-hist.csv` returned a
 * synthetic 2801-row table ending 2010-02-14 with every rate `0.5`, and the
 * backfill wrote it into every development and test database with no signal.
 * Its JPY rows are rejected here (0.5 EUR per yen is ~70× the yen's highest
 * ever); its USD rows are plausible, so they are written and warned about
 * (16 years short of `to`).
 */

/**
 * ECB's own reference series, units of the currency per one EUR, lowest and
 * highest ever published, 1999-01-04..2026-10-06 (statistics API
 * `EXR/D.<CCY>.EUR.SP00.A`, rounded outward to three significant figures).
 * Measured, not chosen: TRY spans 0.37..56.5 because the series is restated
 * in post-2005 lira.
 *
 * A currency absent from this table (another provider's, or a future one)
 * is not checked — the band is a backstop for currencies we have history
 * for, not a whitelist.
 */
const UNITS_PER_EUR_OBSERVED: Readonly<Record<string, readonly [number, number]>> = {
  EUR: [1, 1],
  USD: [0.825, 1.6],
  JPY: [89.2, 188],
  BGN: [1.94, 1.97],
  CZK: [22.9, 38.6],
  DKK: [7.42, 7.48],
  GBP: [0.571, 0.979],
  HUF: [228, 431],
  PLN: [3.2, 4.96],
  RON: [1.29, 5.36],
  SEK: [8.05, 12],
  CHF: [0.9, 1.69],
  ISK: [68, 305],
  NOK: [7.22, 12.4],
  HRK: [7.1, 7.77],
  RUB: [23.1, 118],
  TRY: [0.37, 56.5],
  AUD: [1.16, 2.08],
  BRL: [1.56, 6.96],
  CAD: [1.21, 1.82],
  CNY: [6.55, 11.3],
  HKD: [6.43, 12.5],
  IDR: [6700, 21100],
  ILS: [3.25, 5.96],
  INR: [38.4, 113],
  KRW: [938, 2000],
  MXN: [7.62, 27.1],
  MYR: [3.15, 5.19],
  NZD: [1.38, 2.56],
  PHP: [36.8, 76.8],
  SGD: [1.38, 2.24],
  THB: [33.2, 53.6],
  ZAR: [6.07, 21.9],
};

/**
 * How far beyond the observed range a rate may go before it is implausible:
 * one order of magnitude either way. Wide on purpose — this is not a market
 * check. The widest real drift in the table is TRY (×153 over 27 years); a
 * further ×10 is a decade of that currency's worst devaluation pace.
 */
const FX_PLAUSIBILITY_FACTOR = 10;

/**
 * The band a `base/quote` rate (base units per one quote unit, this
 * codebase's direction) must fall in, or `undefined` when either currency is
 * not in {@link UNITS_PER_EUR_OBSERVED}. `rate = unitsPerEur(base) /
 * unitsPerEur(quote)`, so the extremes pair low-with-high. Plain numbers: an
 * order-of-magnitude bound, never money.
 */
export function plausibleFxRateBand(pair: CurrencyPair): readonly [number, number] | undefined {
  const base = UNITS_PER_EUR_OBSERVED[pair.base];
  const quote = UNITS_PER_EUR_OBSERVED[pair.quote];
  if (base === undefined || quote === undefined) return undefined;
  return [
    base[0] / quote[1] / FX_PLAUSIBILITY_FACTOR,
    (base[1] / quote[0]) * FX_PLAUSIBILITY_FACTOR,
  ];
}

/** Throws when `observation.rate` is outside {@link plausibleFxRateBand} for its pair. */
export function assertPlausibleRate(observation: FxObservation): void {
  const band = plausibleFxRateBand({ base: observation.base, quote: observation.quote });
  if (band === undefined) return;
  if (observation.rate.lessThan(band[0]) || observation.rate.greaterThan(band[1])) {
    throw new Error(
      `upsertFxRateDailyViaDb: refusing to persist an implausible rate (${observation.rate.toString()}) for ${observation.base}/${observation.quote} on ${observation.rateDate} — outside [${band[0]}, ${band[1]}], ${FX_PLAUSIBILITY_FACTOR}× beyond anything ECB has published for it`,
    );
  }
}

/**
 * The density floor: rows per weekday over the span a fetch actually covered.
 * ECB's TARGET calendar closes about six weekdays a year (≈ 97.7 %); its
 * worst real 28–90-day window, over every currency since 1999, is 87.5 %.
 */
const FX_MIN_WEEKDAY_DENSITY = 0.8;

/** Below this many weekdays the density test says nothing useful (one holiday week is 60 %). */
const FX_DENSITY_MIN_WEEKDAYS = 20;

export interface FxSeriesShortfall {
  readonly pair: CurrencyPair;
  /**
   * `TAIL`: the newest returned row is more than the gap limit behind the
   * requested `to`, or nothing came back at all. `SPARSE`: fewer than
   * {@link FX_MIN_WEEKDAY_DENSITY} rows per weekday over the span returned.
   */
  readonly kind: "TAIL" | "SPARSE";
  readonly requestedFrom: string;
  readonly requestedTo: string;
  /** First and last returned `rateDate`; absent when nothing came back for the pair. */
  readonly observedFrom?: string;
  readonly observedTo?: string;
  readonly rows: number;
  /** `SPARSE` only: the weekdays in `[observedFrom, observedTo]`. */
  readonly weekdays?: number;
}

function epochDay(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`) / 86_400_000;
}

/** Monday–Friday dates in `[from, to]`, inclusive. */
export function countWeekdays(from: string, to: string): number {
  let count = 0;
  for (let day = epochDay(from); day <= epochDay(to); day++) {
    // 1970-01-01 (epoch day 0) was a Thursday: day % 7 → 0 Thu, 2 Sat, 3 Sun.
    const weekday = ((day % 7) + 7) % 7;
    if (weekday !== 2 && weekday !== 3) count++;
  }
  return count;
}

/**
 * The post-fetch shape checks for one requested `[from, to]` and the pairs
 * fetched over it. The **head** — `[from, first row)` — is deliberately not
 * judged: a currency ECB began publishing after the euro epoch has an
 * unfillable head (the same reason `ensureFxHistoryCoverage` does not treat
 * it as a hole). Density is measured over the returned span only, so that
 * head never reads as sparseness either.
 */
export function findFxSeriesShortfalls(
  pairs: readonly CurrencyPair[],
  observations: readonly FxObservation[],
  from: string,
  to: string,
  maxGapDays: number,
): FxSeriesShortfall[] {
  const shortfalls: FxSeriesShortfall[] = [];
  for (const pair of pairs) {
    const dates = [
      ...new Set(
        observations
          .filter((o) => o.base === pair.base && o.quote === pair.quote)
          .filter((o) => o.rateDate >= from && o.rateDate <= to)
          .map((o) => o.rateDate),
      ),
    ].sort();
    const requested = { pair, requestedFrom: from, requestedTo: to };
    const observedFrom = dates[0];
    const observedTo = dates[dates.length - 1];
    if (observedFrom === undefined || observedTo === undefined) {
      shortfalls.push({ ...requested, kind: "TAIL", rows: 0 });
      continue;
    }
    const observed = { observedFrom, observedTo, rows: dates.length };
    if (epochDay(to) - epochDay(observedTo) > maxGapDays) {
      shortfalls.push({ ...requested, ...observed, kind: "TAIL" });
    }
    const weekdays = countWeekdays(observedFrom, observedTo);
    if (weekdays >= FX_DENSITY_MIN_WEEKDAYS && dates.length < weekdays * FX_MIN_WEEKDAY_DENSITY) {
      shortfalls.push({ ...requested, ...observed, kind: "SPARSE", weekdays });
    }
  }
  return shortfalls;
}

/** One scalar per shortfall for the log line: `EUR/USD TAIL requested 1999-01-04..2026-10-07 observed 1999-01-04..2010-02-14 rows 2803`. */
export function describeFxSeriesShortfall(shortfall: FxSeriesShortfall): string {
  const observed =
    shortfall.observedFrom === undefined
      ? "observed nothing"
      : `observed ${shortfall.observedFrom}..${shortfall.observedTo} rows ${shortfall.rows}` +
        (shortfall.weekdays === undefined ? "" : `/${shortfall.weekdays} weekdays`);
  return `${shortfall.pair.base}/${shortfall.pair.quote} ${shortfall.kind} requested ${shortfall.requestedFrom}..${shortfall.requestedTo} ${observed}`;
}
