import {
  type CurrencyCode,
  type FxRatePoint,
  type IsoDate,
  type PricePoint,
} from "@kerdial/core-domain";
import {
  fxRateDaily,
  fxRateUser,
  instrumentPriceDaily,
  manualPricePoint,
  type Tx,
} from "@kerdial/platform-db";
import { and, eq, gt, inArray, lte, max, or, sql, type SQL } from "drizzle-orm";

/**
 * `loadPricingSeries` — the shared "load every price/FX-rate observation a
 * set of instruments could need, on or before a date" query, factored out of
 * `materializePortfolioValuations` (T-30) so T-39 does not
 * duplicate it. `attemptMaterialize` (`./materialize.ts`) only ever reads
 * `.prices`/`.fxRates` from the result; `./holdings-valuation.ts` (T-39) reads
 * those two **and** the extra provenance lookup maps this function also
 * builds, needed to assemble the `ValuedAmount` envelope — `resolvePrice`/`resolveMarketRate` (`@kerdial/core-domain`)
 * return which point they chose, but not that point's `quality` (an
 * `instrument_price_daily`-only column, absent from `PricePoint`) or which
 * table an FX rate came from (`fx_rate_daily` vs. the tenant's
 * `fx_rate_user` fallback) — both are recovered here, by key, rather than
 * threading extra fields through `core/domain`'s already-reviewed T-28 types.
 *
 * Pure query, no pricing/valuation logic of its own: `valuePortfolio` (T-28)
 * still owns every precedence/LOCF decision. `valuation` must never import
 * `market/ports`/`market/adapters` — every
 * row here comes from `platform/db`, never a live provider fetch.
 */

/** `${instrumentId}|${observedOn}` — the natural key for a `PricePoint`'s provenance lookup. */
export function priceProvenanceKey(instrumentId: string, observedOn: IsoDate): string {
  return `${instrumentId}|${observedOn}`;
}

/** `${currency}|${observedOn}` — the natural key for an `FxRatePoint`'s provenance lookup. */
export function fxProvenanceKey(currency: string, observedOn: IsoDate): string {
  return `${currency}|${observedOn}`;
}

/** Only `instrument_price_daily` rows carry a `quality` column — a manual point's quality is always `'MANUAL'`, decided by the caller from `PriceObservation.origin`, not looked up here. */
export type DailyPriceQuality = "EOD" | "DELAYED" | "REALTIME";

/** Which table an `FxRatePoint` was loaded from — `fx_rate_daily` (the provider series) or the tenant's `fx_rate_user` fallback (NFR-13). Mirrors `transaction.fx_rate_source`'s `PROVIDER`/`USER_PINNED` values by convention, not by import (`core/domain` cannot depend on `platform/db`'s enum). */
export type FxRateOrigin = "PROVIDER" | "USER_PINNED";

export interface LoadedPricingSeries {
  readonly prices: readonly PricePoint[];
  readonly fxRates: readonly FxRatePoint[];
  /** Keyed by {@link priceProvenanceKey} — quality of every loaded `DAILY`-origin price point. */
  readonly priceQualityByKey: ReadonlyMap<string, DailyPriceQuality>;
  /** Keyed by {@link fxProvenanceKey} — which table every loaded FX rate point came from. */
  readonly fxOriginByKey: ReadonlyMap<string, FxRateOrigin>;
}

export interface LoadPricingSeriesParams {
  readonly tenantId: string;
  /**
   * The tenant's ledger base currency (`tenant.base_currency`, ADR-0002/AR-5)
   * — the currency FX pairs are loaded against and the one currency that
   * needs no pair at all. The caller reads it from the tenant row; this
   * loader takes it explicitly rather than importing a constant that no
   * longer exists.
   */
  readonly baseCurrency: CurrencyCode;
  readonly instrumentIds: readonly string[];
  /** Inclusive upper bound — never look ahead of this date. */
  readonly toDate: IsoDate;
  /**
   * Earliest date this load will be asked to value — the old end of the
   * two-sided FX coverage test below (SH-6). Given, it
   * is also the lower bound of every query, minus one row per series: the
   * newest observation on or before it, which this date LOCFs to.
   *
   * Omitted, it defaults to {@link LoadPricingSeriesParams.toDate} and marks a
   * **single-date** load (`valueHoldingsAsOf`), for which condition (1) is
   * implied by condition (2) — and which reads only the newest rows per series
   * (see {@link loadPricingSeries}). Pass it explicitly to get the full
   * series even for a one-day range.
   */
  readonly fromDate?: IsoDate;
  /**
   * portfolio-cash: the currencies cash is held in, each mapped
   * to its first CASH posting date. Their FX is loaded alongside the price
   * currencies' — the set is `price currencies ∪ cash currencies − base` — and
   * a portfolio with cash but no instrument still loads FX (the early return
   * below applies only when both are empty). A currency **only** cash uses is
   * judged covered from `max(fromDate, firstPostingDate)`: FX history that
   * starts after the portfolio's first trade but before that currency's first
   * posting is enough. A currency a price also uses keeps the stricter
   * `fromDate` rule.
   */
  readonly cashCurrencies?: ReadonlyMap<CurrencyCode, IsoDate>;
}

/**
 * SH-6 — how stale the newest provider observation may
 * be before the `fx_rate_daily` series is judged **not to cover** a load at
 * all, and the tenant's `fx_rate_user` rows are used instead.
 *
 * The same horizon, for the same reason, that `ledger`'s
 * `fx-rate-resolver.ts` applies on the *write* path via
 * `PROVIDER_LOOKBACK_DAYS`: two weeks is comfortably wider than the longest
 * run of consecutive non-publication days a daily FX series has (a weekend
 * plus adjacent TARGET holidays), and deliberately not wider — a pair with
 * no publication for a fortnight has been **withdrawn or suspended**, not
 * merely not-published-today, and silently valuing off a rate weeks stale is
 * the failure this fails closed on instead.
 *
 * `valuation` must not import `ledger`, and `PROVIDER_LOOKBACK_DAYS` is
 * module-private there, so this follows the repo's existing "declared twice
 * by value, guarded by a drift test" convention (as
 * `MATERIALIZE_EPOCH_FLOOR`/`RETURN_WINDOW_EPOCH_FLOOR` and
 * `web`'s `api-limits.ts` already do) — see `pricing-series.drift.test.ts`.
 */
export const FX_PROVIDER_COVERAGE_HORIZON_DAYS = 14;

/** Calendar days from `from` to `to` (`to − from`), on the proleptic Gregorian calendar — integer arithmetic on epoch days, no floats (NFR-12). Negative when `to` precedes `from`. */
function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

/**
 * SH-6, **the condition, stated once**. For one currency
 * pair, over a load spanning `[fromDate, toDate]`, the provider series covers
 * the load iff **all three** hold:
 *
 *  1. **Old end — the series starts early enough.** An observation exists with
 *     `rate_date <= fromDate`. The most recent such observation is the
 *     **anchor**: the rate `fromDate` itself would carry forward.
 *  2. **New end — the series is still live.** The most recent observation with
 *     `rate_date <= toDate` is no more than
 *     {@link FX_PROVIDER_COVERAGE_HORIZON_DAYS} calendar days before `toDate`.
 *  3. **Interior — no hole inside the load.** Walking from the anchor
 *     through every observation in `(fromDate, toDate]`, no two consecutive
 *     observations are more than {@link FX_PROVIDER_COVERAGE_HORIZON_DAYS}
 *     calendar days apart. (2) is the same rule applied to the last stretch,
 *     from the final observation to `toDate`.
 *
 * Why (3) exists: the original two-sided test admitted an EUR/USD series that
 * ran 1999-01-05..2010-02-14 and then resumed on 2026-08-28 — both endpoints
 * were fine — so every date in the 16-year hole LOCF'd the 2010-02-14 rate
 * (`0.5`) and valued every USD position at half its worth for two weeks before
 * anyone noticed. The horizon is the right bound for the interior too:
 * it is the staleness the write path (`ledger`'s `PROVIDER_LOOKBACK_DAYS`)
 * already refuses to resolve a rate across, so a stretch wider than it is one
 * the engine would be carrying a rate across that no other path would accept.
 * The real ECB series' widest genuine gap is five calendar days (a holiday
 * long weekend), so 14 is well clear of every legitimate closure.
 *
 * The interior check is **scoped to the load**, not to the whole series: a
 * hole entirely before `fromDate` (behind the anchor) or after `toDate`
 * affects no date being valued, and rejecting the pair for it would 422 loads
 * the series covers perfectly well.
 *
 * `observedDates` is every `fx_rate_daily` `rate_date` already filtered to
 * `<= toDate` by the caller's query; dates after `toDate` are ignored here too,
 * so the function is correct either way.
 *
 * What this deliberately is **not**: not a per-date presence test (LOCF exists
 * because rates are not published every day — requiring an observation *on*
 * the date rejects every weekend), and **not a per-date merge**. The decision
 * is made once per pair per load, so the array handed to `resolveMarketRate`
 * still holds exactly one source per currency; interleaving sources would make
 * precedence depend on which one published later, which is the failure the
 * original pair-level rule refused and this fix preserves that refusal.
 *
 * Exported for its unit tests only (`pricing-series.test.ts`); the read path
 * reaches it through {@link loadPricingSeries}.
 */
export function providerSeriesCoversLoad(
  observedDates: readonly IsoDate[],
  fromDate: IsoDate,
  toDate: IsoDate,
): boolean {
  let anchor: IsoDate | undefined;
  const inside: IsoDate[] = [];
  for (const date of observedDates) {
    if (date <= fromDate) {
      if (anchor === undefined || date > anchor) anchor = date;
    } else if (date <= toDate) {
      inside.push(date);
    }
  }
  // (1)
  if (anchor === undefined) return false;
  inside.sort();
  // (3) — every stretch a date inside the load would carry a rate across.
  let previous = anchor;
  for (const date of inside) {
    if (daysBetween(previous, date) > FX_PROVIDER_COVERAGE_HORIZON_DAYS) return false;
    previous = date;
  }
  // (2) — the final stretch, up to `toDate` itself. Inclusive: exactly
  // `FX_PROVIDER_COVERAGE_HORIZON_DAYS` days is still covered.
  return daysBetween(previous, toDate) <= FX_PROVIDER_COVERAGE_HORIZON_DAYS;
}

/** `ids` as one `uuid[]` parameter for `unnest` — an array interpolated into drizzle's `sql` would expand to a parenthesised list instead. */
function uuidArray(ids: readonly string[]): SQL {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * How many of the newest observations per instrument, per source table, a
 * single-date load keeps. Two, because `assembleHoldings` reads two:
 * the price as of the date, and the close before it for the day change
 * (`resolvePrice` at `dayBefore(chosen.observedOn)`). Each source's best
 * point on or before that earlier date is its newest row or the one under it,
 * and `(instrument, date)` is unique in both tables, so two rows per source
 * cover both lookups exactly.
 */
const POINT_IN_TIME_PRICES_PER_SOURCE = 2;

/** `(instrument_id, price_date)` is one of the `limit` newest `instrument_price_daily` rows per instrument on or before `onOrBefore`. */
function amongNewestDailyPrices(
  instrumentIds: readonly string[],
  onOrBefore: IsoDate,
  limit: number,
): SQL {
  return sql`(${instrumentPriceDaily.instrumentId}, ${instrumentPriceDaily.priceDate}) in (
    select ids.id, newest.price_date
    from unnest(${uuidArray(instrumentIds)}) as ids(id)
    cross join lateral (
      select p.price_date from instrument_price_daily p
      where p.instrument_id = ids.id and p.price_date <= ${onOrBefore}
      order by p.price_date desc
      limit ${limit}
    ) as newest
  )`;
}

/** The `manual_price_point` twin of {@link amongNewestDailyPrices}, within the tenant. */
function amongNewestManualPrices(
  tenantId: string,
  instrumentIds: readonly string[],
  onOrBefore: IsoDate,
  limit: number,
): SQL {
  return sql`(${manualPricePoint.instrumentId}, ${manualPricePoint.priceDate}) in (
    select ids.id, newest.price_date
    from unnest(${uuidArray(instrumentIds)}) as ids(id)
    cross join lateral (
      select m.price_date from manual_price_point m
      where m.tenant_id = ${tenantId} and m.instrument_id = ids.id
        and m.price_date <= ${onOrBefore}
      order by m.price_date desc
      limit ${limit}
    ) as newest
  )`;
}

/**
 * Loads the `instrument_price_daily` / `manual_price_point` observations for
 * `instrumentIds`, the union's non-base currencies, and the `fx_rate_daily` /
 * `fx_rate_user` observations for those currencies — the exact set
 * `valuePortfolio` (T-28) needs, at or before `toDate` — plus the FX of
 * every {@link LoadPricingSeriesParams.cashCurrencies} currency. Returns an
 * empty result with no queries at all only when there is neither an
 * instrument nor a non-base cash currency (nothing to price, nothing to
 * convert); with cash but no instrument, the price queries are skipped and
 * the FX queries run.
 *
 * A **range** load (`fromDate` given — `materialize.ts`) reads every
 * observation in `(fromDate, toDate]` plus, per series, the newest one on or
 * before `fromDate` (the **anchor**, which `fromDate` and every date up to the
 * next observation LOCF to). Older rows can resolve no date in the range.
 * It used to read each series unbounded-below — the whole price history
 * for a one-day rebuild. The FX narrowing keeps `providerSeriesCoversLoad`'s
 * answer, which reads exactly the anchor and the observations inside the load.
 *
 * A **single-date** load (`fromDate` omitted — holdings, closed positions)
 * values one date, so it reads only what that date can resolve to: the
 * {@link POINT_IN_TIME_PRICES_PER_SOURCE} newest prices per instrument per
 * table and the newest rate per currency per table. It used to read the
 * whole history (150 500 price rows for 37 instruments on the live tenant) and
 * parsed every row to `Decimal`, which was ~700 ms of every holdings request.
 * The FX narrowing keeps `providerSeriesCoversLoad`'s answer: with
 * `fromDate === toDate` it reads only the newest observation (the anchor) and
 * its distance to `toDate`.
 */
export async function loadPricingSeries(
  tx: Tx,
  params: LoadPricingSeriesParams,
): Promise<LoadedPricingSeries> {
  const { tenantId, baseCurrency, instrumentIds, toDate } = params;
  const fromDate = params.fromDate ?? toDate;
  const pointInTime = params.fromDate === undefined;

  const cashCurrencies = new Map(
    [...(params.cashCurrencies ?? new Map<CurrencyCode, IsoDate>())].filter(
      ([currency]) => currency !== baseCurrency,
    ),
  );

  if (instrumentIds.length === 0 && cashCurrencies.size === 0) {
    return { prices: [], fxRates: [], priceQualityByKey: new Map(), fxOriginByKey: new Map() };
  }

  const [dailyRows, manualRows] =
    instrumentIds.length === 0
      ? [[], []]
      : await Promise.all([
          tx
            .select()
            .from(instrumentPriceDaily)
            .where(
              and(
                inArray(instrumentPriceDaily.instrumentId, instrumentIds),
                lte(instrumentPriceDaily.priceDate, toDate),
                pointInTime
                  ? amongNewestDailyPrices(instrumentIds, toDate, POINT_IN_TIME_PRICES_PER_SOURCE)
                  : or(
                      gt(instrumentPriceDaily.priceDate, fromDate),
                      amongNewestDailyPrices(instrumentIds, fromDate, 1),
                    ),
              ),
            ),
          tx
            .select()
            .from(manualPricePoint)
            .where(
              and(
                eq(manualPricePoint.tenantId, tenantId),
                inArray(manualPricePoint.instrumentId, instrumentIds),
                lte(manualPricePoint.priceDate, toDate),
                pointInTime
                  ? amongNewestManualPrices(
                      tenantId,
                      instrumentIds,
                      toDate,
                      POINT_IN_TIME_PRICES_PER_SOURCE,
                    )
                  : or(
                      gt(manualPricePoint.priceDate, fromDate),
                      amongNewestManualPrices(tenantId, instrumentIds, fromDate, 1),
                    ),
              ),
            ),
        ]);

  const priceQualityByKey = new Map<string, DailyPriceQuality>();
  for (const row of dailyRows) {
    priceQualityByKey.set(
      priceProvenanceKey(row.instrumentId, row.priceDate as IsoDate),
      row.quality,
    );
  }

  const prices: PricePoint[] = [
    ...dailyRows.map((row): PricePoint => ({
      instrumentId: row.instrumentId,
      observedOn: row.priceDate as IsoDate,
      price: row.closeRaw,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "DAILY",
    })),
    ...manualRows.map((row): PricePoint => ({
      instrumentId: row.instrumentId,
      observedOn: row.priceDate as IsoDate,
      price: row.close,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "MANUAL",
    })),
  ];

  // Every non-base currency any resolved price could be denominated in, and
  // every non-base currency cash is held in (portfolio-cash).
  const priceCurrencies = new Set(prices.map((p) => p.currency));
  const currencies = [...new Set([...priceCurrencies, ...cashCurrencies.keys()])].filter(
    (currency) => currency !== baseCurrency,
  );
  // The old end of the coverage test per currency: `fromDate`, except for a
  // currency only cash uses, whose rates are needed from its first posting
  // (clamped to `toDate`, the newest date this load values).
  const coverageFrom = (currency: CurrencyCode): IsoDate => {
    const firstPosting = cashCurrencies.get(currency);
    if (priceCurrencies.has(currency) || firstPosting === undefined) return fromDate;
    const from = firstPosting > fromDate ? firstPosting : fromDate;
    return from > toDate ? toDate : from;
  };

  let fxRates: FxRatePoint[] = [];
  const fxOriginByKey = new Map<string, FxRateOrigin>();

  if (currencies.length > 0) {
    const providerRows = await tx
      .select()
      .from(fxRateDaily)
      .where(
        and(
          eq(fxRateDaily.baseCurrency, baseCurrency),
          inArray(fxRateDaily.quoteCurrency, currencies),
          lte(fxRateDaily.rateDate, toDate),
          // The newest rate per currency on or before `fromDate` — the
          // anchor, and for a single-date load (`fromDate === toDate`) all of it.
          or(
            pointInTime ? undefined : gt(fxRateDaily.rateDate, fromDate),
            sql`(${fxRateDaily.quoteCurrency}, ${fxRateDaily.rateDate}) in ${tx
              .select({ currency: fxRateDaily.quoteCurrency, newest: max(fxRateDaily.rateDate) })
              .from(fxRateDaily)
              .where(
                and(
                  eq(fxRateDaily.baseCurrency, baseCurrency),
                  inArray(fxRateDaily.quoteCurrency, currencies),
                  lte(fxRateDaily.rateDate, fromDate),
                ),
              )
              .groupBy(fxRateDaily.quoteCurrency)}`,
          ),
        ),
      );
    // NFR-13's fallback, as re-stated by SH-6: still
    // pair-level, never a per-date merge — but the coverage test is now
    // **two-sided, horizon-bounded and hole-free inside the load** (see
    // `providerSeriesCoversLoad`).
    // Before SH-6 this was "the provider has at least one row for the pair",
    // which is B2: the first `fx-daily` write for a currency excluded the
    // tenant's own `fx_rate_user` rows for *every* date, 422-ing every
    // valuation earlier than that first ingested rate.
    const observedDatesByCurrency = new Map<string, IsoDate[]>();
    for (const row of providerRows) {
      const dates = observedDatesByCurrency.get(row.quoteCurrency) ?? [];
      dates.push(row.rateDate as IsoDate);
      observedDatesByCurrency.set(row.quoteCurrency, dates);
    }
    const coveredByProvider = new Set(
      currencies.filter((currency) =>
        providerSeriesCoversLoad(
          observedDatesByCurrency.get(currency) ?? [],
          coverageFrom(currency),
          toDate,
        ),
      ),
    );

    // A rejected pair's provider rows are dropped entirely — loading them
    // alongside the tenant's would be exactly the per-date merge above
    // refuses.
    const coveredProviderRows = providerRows.filter((row) =>
      coveredByProvider.has(row.quoteCurrency),
    );
    fxRates = coveredProviderRows.map((row): FxRatePoint => ({
      currency: row.quoteCurrency,
      observedOn: row.rateDate as IsoDate,
      rate: row.rate,
    }));
    for (const row of coveredProviderRows) {
      fxOriginByKey.set(fxProvenanceKey(row.quoteCurrency, row.rateDate as IsoDate), "PROVIDER");
    }

    const uncovered = currencies.filter((currency) => !coveredByProvider.has(currency));
    if (uncovered.length > 0) {
      const tenantRows = await tx
        .select()
        .from(fxRateUser)
        .where(
          and(
            eq(fxRateUser.tenantId, tenantId),
            eq(fxRateUser.baseCurrency, baseCurrency),
            inArray(fxRateUser.quoteCurrency, uncovered),
            lte(fxRateUser.rateDate, toDate),
            or(
              pointInTime ? undefined : gt(fxRateUser.rateDate, fromDate),
              sql`(${fxRateUser.quoteCurrency}, ${fxRateUser.rateDate}) in ${tx
                .select({ currency: fxRateUser.quoteCurrency, newest: max(fxRateUser.rateDate) })
                .from(fxRateUser)
                .where(
                  and(
                    eq(fxRateUser.tenantId, tenantId),
                    eq(fxRateUser.baseCurrency, baseCurrency),
                    inArray(fxRateUser.quoteCurrency, uncovered),
                    lte(fxRateUser.rateDate, fromDate),
                  ),
                )
                .groupBy(fxRateUser.quoteCurrency)}`,
            ),
          ),
        );
      fxRates = [
        ...fxRates,
        ...tenantRows.map((row): FxRatePoint => ({
          currency: row.quoteCurrency,
          observedOn: row.rateDate as IsoDate,
          rate: row.rate,
        })),
      ];
      for (const row of tenantRows) {
        fxOriginByKey.set(
          fxProvenanceKey(row.quoteCurrency, row.rateDate as IsoDate),
          "USER_PINNED",
        );
      }
    }
  }

  return { prices, fxRates, priceQualityByKey, fxOriginByKey };
}
