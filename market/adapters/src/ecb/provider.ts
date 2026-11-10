import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { locf } from "@kerdial/core-domain";
import { DataGap, ProviderMalformedResponse, SymbolNotFound } from "@kerdial/market-ports";
import type {
  CurrencyCode,
  CurrencyPair,
  FxObservation,
  FxProviderCapabilities,
  FxRateProvider,
  IsoDate,
} from "@kerdial/market-ports";
import {
  ECB_BASE_CURRENCY,
  ECB_LIVE_CURRENCIES,
  ECB_PROVIDER_KEY,
  ECB_PUBLISHED_CURRENCIES,
  EUR_RUB_SUSPENDED_FROM,
} from "./currencies.js";
import { HttpEcbSourceFetcher } from "./http-fetcher.js";
import type { EcbSourceFetcher } from "./http-fetcher.js";
import { parseHistoricalCsv } from "./parse-csv.js";
import type { EcbHistoricalTable } from "./parse-csv.js";
import { parseDailyXml } from "./parse-xml.js";
import type { EcbDailySnapshot } from "./parse-xml.js";

/** ECB publishes ~16:00 CET; 15:00 UTC covers both CET (UTC+1) and CEST (UTC+2) publication as a same-UTC-day marker (the port's `publicationTimeUtc`). */
const PUBLICATION_TIME_UTC = "15:00";

/**
 * One point of a currency's own EUR-base series, **already inverted** to
 * this codebase's canonical direction:
 * `eurPerUnit` = EUR per one unit of the currency, i.e. `1 / ecbRawValue`
 * (ECB itself publishes "1 EUR = ecbRawValue CCY").
 */
interface EurLegPoint {
  readonly rateDate: IsoDate;
  readonly eurPerUnit: Decimal;
}

function pairLabel(pair: CurrencyPair): string {
  return `${pair.base}/${pair.quote}`;
}

/**
 * Turns an ECB raw cell value ("1 EUR = raw CCY") into a validated
 * `Decimal`, using `core-decimal`'s own lossless string codec rather than a
 * bare `new Decimal(...)` so an unparseable or non-finite value is a
 * {@link ProviderMalformedResponse}, not a silent `NaN`/`Infinity` Decimal
 * or an uncaught `RangeError`. `parse-csv.ts`/`parse-xml.ts` already
 * validate the cell matches `/^\d+(\.\d+)?$/` before this ever sees it, but
 * this is the one place both parsers' outputs converge, so the guard
 * (including the zero/negative case, which the regex alone cannot rule out
 * for "0") lives here once.
 */
function parseEcbRawRate(raw: string): Decimal {
  let value: Decimal;
  try {
    value = parseDecimalString(raw);
  } catch {
    throw new ProviderMalformedResponse(
      ECB_PROVIDER_KEY,
      `unparseable ECB rate value: ${JSON.stringify(raw)}`,
    );
  }
  // `greaterThan(0)`, not `isPositive()`: decimal.js models signed zero, so
  // `new Decimal("0.0000").isPositive()` is `true` and zero sailed through this
  // guard — then got inverted to `Infinity` by the EUR-base cross-rate maths.
  // The regex in the parsers admits "0", so this is the only thing standing
  // between a zero cell and a poisoned rate. Found during T-18.
  if (!value.greaterThan(0)) {
    throw new ProviderMalformedResponse(
      ECB_PROVIDER_KEY,
      `non-positive ECB rate value: ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * `EcbFxRateProvider` — the ECB adapter (T-15). Implements only {@link FxRateProvider} (FR-63,
 * NFR-9's independence from {@link
 * import("@kerdial/market-ports").QuoteProvider}).
 *
 * **Direction inversion (R12's "single most common class of FX bug").** ECB publishes EUR-base ("1 EUR = 1.0850 USD"); this
 * codebase's canonical direction is `amount_base = amount_quote × rate`,
 * i.e. `rate` = base-currency units per one unit of quote currency. Every
 * rate this adapter returns is inverted at this boundary — nothing outside
 * `market/adapters` ever sees ECB's own publication direction (see
 * `market/ports`' `FxObservation.rate` doc comment).
 *
 * **Cross rates.** ECB publishes EUR-base pairs
 * only. A single internal formula covers every requested pair, including
 * the direct EUR-base case, by treating EUR's own "rate against itself" as
 * the trivial identity `1`:
 *
 * ```
 * rate(base, quote, date) = eurPerUnit(quote, date) / eurPerUnit(base, date)
 * ```
 *
 * For `base = EUR` this collapses to `eurPerUnit(quote, date)` — the direct
 * inverted-ECB rate. For two non-EUR currencies (e.g. `USD/GBP`) it derives
 * `EUR/GBP ÷ EUR/USD`. The result
 * is computed on every call, never persisted here — persistence is the
 * ingestion layer's job (T-33), out of this adapter's scope.
 *
 * **LOCF for cross-rate legs (`core-domain`'s `locf()`).** ECB's own per-day sheet can carry
 * a value for one currency and not another on the same published date (a
 * market-specific holiday affecting one country's rate but not the whole
 * TARGET calendar) — a genuine gap distinct from "the whole feed didn't
 * publish that day" (weekends/holidays, which the *resolver*, T-18, is
 * responsible for LOCF-ing across, not this adapter — this adapter only
 * ever returns dates ECB's own file actually carries a row for). When
 * deriving a cross rate, each leg is independently resolved via `locf()`
 * against its own full published history, so a single-currency gap on the
 * date being derived carries forward that currency's most recent prior
 * value rather than either fabricating a value or dropping the whole
 * cross-rate date. Never looks ahead — the same guarantee `locf()` itself
 * documents.
 */
export class EcbFxRateProvider implements FxRateProvider {
  readonly #fetcher: EcbSourceFetcher;

  constructor(fetcher: EcbSourceFetcher = new HttpEcbSourceFetcher()) {
    this.#fetcher = fetcher;
  }

  capabilities(): FxProviderCapabilities {
    return {
      key: ECB_PROVIDER_KEY,
      // Live currencies only — a retired one would make the daily job
      // ask today's feed for a row it no longer carries.
      publishedPairs: ECB_LIVE_CURRENCIES.map((quote) => ({ base: ECB_BASE_CURRENCY, quote })),
      baseCurrency: ECB_BASE_CURRENCY,
      publicationTimeUtc: PUBLICATION_TIME_UTC,
      maxHistoryYears: "unbounded",
    };
  }

  async fetchDailyRates(
    pairs: CurrencyPair[],
    from: IsoDate,
    to: IsoDate,
  ): Promise<FxObservation[]> {
    // Validated before the request, not after: the history request
    // names its currencies, and an unknown one would come back as the API's
    // 404 (a `ProviderUnavailable`) rather than the `SymbolNotFound` it is.
    for (const pair of pairs) this.#assertPairSupported(pair, to);
    const legs = [...new Set(pairs.flatMap((pair) => [pair.base, pair.quote]))].filter(
      (currency) => currency !== ECB_BASE_CURRENCY,
    );
    if (legs.length === 0) throw new DataGap(ECB_PROVIDER_KEY, from, to);

    const csv = await this.#fetcher.fetchHistoricalCsv(legs, to);
    const table = parseHistoricalCsv(csv);
    return pairs.flatMap((pair) => this.#dailySeriesForPair(pair, table, from, to));
  }

  async fetchLatestRates(pairs: CurrencyPair[]): Promise<FxObservation[]> {
    const xml = await this.#fetcher.fetchDailyXml();
    const daily = parseDailyXml(xml);
    return pairs.map((pair) => this.#latestForPair(pair, daily));
  }

  /**
   * Validates that both legs of `pair` are resolvable at all — either the
   * base currency itself (trivially, EUR), or one of the 32 currencies ECB
   * has ever published, and (for RUB specifically) not touching a date on
   * or after the 2022-03-01 suspension. `asOfDate` is the *latest* date the
   * caller cares about (`to` for `fetchDailyRates`, the published day itself
   * for `fetchLatestRates`) — a range entirely before the suspension date
   * still resolves (see {@link EUR_RUB_SUSPENDED_FROM}'s doc comment for the
   * documented simplification: a range that only *partially* overlaps the
   * suspension is rejected wholesale, fail-closed, rather than silently
   * returning a partial series).
   */
  #assertPairSupported(pair: CurrencyPair, asOfDate: IsoDate): void {
    for (const currency of [pair.base, pair.quote]) {
      if (currency === ECB_BASE_CURRENCY) continue;
      if (!ECB_PUBLISHED_CURRENCIES.includes(currency)) {
        throw new SymbolNotFound(
          ECB_PROVIDER_KEY,
          pairLabel(pair),
          `${currency} is not one of ECB's published reference currencies`,
        );
      }
      if (currency === "RUB" && asOfDate >= EUR_RUB_SUSPENDED_FROM) {
        throw new SymbolNotFound(
          ECB_PROVIDER_KEY,
          pairLabel(pair),
          `EUR/RUB has been suspended by ECB since ${EUR_RUB_SUSPENDED_FROM}; pin a manual rate instead`,
        );
      }
    }
  }

  /** Builds `currency`'s own EUR-base series (already inverted), for every date the historical table carries a value for it. */
  #eurLegSeries(currency: CurrencyCode, table: EcbHistoricalTable): readonly EurLegPoint[] {
    const points: EurLegPoint[] = [];
    for (const row of table.rows) {
      const raw = row.values.get(currency);
      if (raw === undefined) continue;
      points.push({
        rateDate: row.date,
        eurPerUnit: new Decimal(1).dividedBy(parseEcbRawRate(raw)),
      });
    }
    return points;
  }

  /** `eurPerUnit(currency, date)` via LOCF over `legSeries` — `undefined` when nothing was ever published for `currency` on or before `date` (`locf`'s own no-fabrication contract). */
  #eurRateAsOf(
    currency: CurrencyCode,
    legSeries: readonly EurLegPoint[],
    date: IsoDate,
  ): Decimal | undefined {
    if (currency === ECB_BASE_CURRENCY) return new Decimal(1);
    return locf(legSeries, date, (point) => point.rateDate)?.eurPerUnit;
  }

  #dailySeriesForPair(
    pair: CurrencyPair,
    table: EcbHistoricalTable,
    from: IsoDate,
    to: IsoDate,
  ): FxObservation[] {
    const baseLeg = this.#eurLegSeries(pair.base, table);
    const quoteLeg = this.#eurLegSeries(pair.quote, table);

    // The dates ECB published one of **this pair's own** legs for,
    // within range, and none after either leg's last publication. The table
    // carries every requested currency, so its full row list would hand a
    // retired currency (HRK after 2022-12-30, BGN after 2025-12-31) the other
    // currencies' later dates, each LOCF'ing its final rate. A direct EUR pair
    // therefore gets exactly the dates its currency published; a cross pair
    // still LOCFs one leg across the other's single-currency holiday.
    const ownLegs = [
      ...(pair.base === ECB_BASE_CURRENCY ? [] : [baseLeg]),
      ...(pair.quote === ECB_BASE_CURRENCY ? [] : [quoteLeg]),
    ];
    // The earlier of the legs' last publication dates (a leg with no point at
    // all resolves nothing anyway, so it sets no bound).
    const lastPublished = ownLegs
      .filter((leg) => leg.length > 0)
      .map((leg) =>
        leg.reduce((last, point) => (point.rateDate > last ? point.rateDate : last), ""),
      )
      .sort()[0];
    const ownDates =
      ownLegs.length === 0
        ? table.rows.map((row) => row.date)
        : ownLegs.flatMap((leg) => leg.map((point) => point.rateDate));
    const candidateDates = [...new Set(ownDates)]
      .filter(
        (date) =>
          date >= from && date <= to && (lastPublished === undefined || date <= lastPublished),
      )
      .sort();

    const observations: FxObservation[] = [];
    for (const date of candidateDates) {
      const eurBase = this.#eurRateAsOf(pair.base, baseLeg, date);
      const eurQuote = this.#eurRateAsOf(pair.quote, quoteLeg, date);
      if (eurBase === undefined || eurQuote === undefined) continue;
      observations.push({
        base: pair.base,
        quote: pair.quote,
        rate: eurQuote.dividedBy(eurBase),
        rateDate: date,
        sourceKey: ECB_PROVIDER_KEY,
      });
    }

    if (observations.length === 0) {
      throw new DataGap(ECB_PROVIDER_KEY, from, to);
    }
    return observations;
  }

  #latestForPair(pair: CurrencyPair, daily: EcbDailySnapshot): FxObservation {
    this.#assertPairSupported(pair, daily.date);

    const eurBase = this.#latestEurRate(pair.base, daily);
    const eurQuote = this.#latestEurRate(pair.quote, daily);
    return {
      base: pair.base,
      quote: pair.quote,
      rate: eurQuote.dividedBy(eurBase),
      rateDate: daily.date,
      sourceKey: ECB_PROVIDER_KEY,
    };
  }

  #latestEurRate(currency: CurrencyCode, daily: EcbDailySnapshot): Decimal {
    if (currency === ECB_BASE_CURRENCY) return new Decimal(1);
    const raw = daily.rates.get(currency);
    if (raw === undefined) {
      throw new SymbolNotFound(
        ECB_PROVIDER_KEY,
        currency,
        `${currency} not present in today's ECB daily rates`,
      );
    }
    return new Decimal(1).dividedBy(parseEcbRawRate(raw));
  }
}
