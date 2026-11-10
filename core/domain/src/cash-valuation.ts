/**
 * `valueCash` / `cashBalancesBefore` — the pure cash half of a portfolio's
 * value (`portfolio-cash`; PC-L1, PC-L2, FR-679).
 *
 * `V(d) = H(d) + C(d)`, with `C(d) = Σ_c balance_c × r_c(d)`: each currency's
 * cash balance converted to the base currency at the **market** rate of the
 * valuation date, last observation carried forward — the rule holdings use
 * ({@link resolveMarketRate}). Two callers:
 *
 * - the daily series (materialise), whose balances are pre-flow: only cash
 *   dated **strictly before** `d` counts in `V(d)` ({@link cashBalancesBefore});
 * - the live totals, whose balances are as-of inclusive, loaded by the caller.
 *
 * ## Never throws — the deliberate difference from `valuePortfolio`
 *
 * A holding with no price or rate fails loud. A cash currency with no rate on
 * or before `date` is **excluded** from the total and listed in `unconverted`
 * instead (PC-L2, ADR-0010 amended for cash only): the caller
 * surfaces it as `provenance.complete = false`, never as a 500. A balance that
 * is exactly zero needs no rate and is never unconverted.
 *
 * Pure and DB-free: imports only `core/decimal` and its
 * sibling modules. Exact `Decimal` throughout.
 */
import { Decimal } from "@kerdial/core-decimal";
import { locf } from "./locf.js";
import type { CurrencyCode, IsoDate } from "./types.js";
import { marketRate, type FxRatePoint, type MarketRate } from "./valuation.js";

/** The summed CASH postings of one currency on one trade date (signed, native). */
export interface CashDailyNet {
  readonly date: IsoDate;
  readonly currency: CurrencyCode;
  readonly amount: Decimal;
}

/** One currency's line of {@link CashValuation}. */
export interface CashCurrencyValuation {
  readonly currency: CurrencyCode;
  /** Native balance, signed (negative = overdrawn). Never zero. */
  readonly amount: Decimal;
  /** native→base market rate; `1` for the base currency; absent when unconverted. */
  readonly rate?: MarketRate;
  /** `observed_on` of the LOCF'd rate; absent for the base currency and when unconverted. */
  readonly rateObservedOn?: IsoDate;
  /** `amount × rate`; absent when unconverted. */
  readonly valueBase?: Decimal;
}

export interface CashValuation {
  /** Non-zero balances, ordered by currency code. */
  readonly byCurrency: readonly CashCurrencyValuation[];
  /** Σ `valueBase` over converted currencies — unconverted ones add nothing. */
  readonly totalValueBase: Decimal;
  /** Currencies with a non-zero balance and no rate on or before `date`, sorted. */
  readonly unconverted: readonly CurrencyCode[];
}

const ZERO = new Decimal(0);
const ONE = marketRate(new Decimal(1));

/**
 * For each of the ascending `dates`, the per-currency cumulative sum of the
 * nets dated **strictly before** it — the pre-flow, start-of-day cut every
 * V(d) uses (cash dated `d` first shows in `V(d+1)`). One pointer sweep over
 * the nets sorted by date, the shape of `cumulativeNetContributions`.
 */
export function cashBalancesBefore(
  dailyNets: readonly CashDailyNet[],
  dates: readonly IsoDate[],
): readonly ReadonlyMap<CurrencyCode, Decimal>[] {
  const nets = [...dailyNets].sort((a, b) => a.date.localeCompare(b.date));
  const running = new Map<CurrencyCode, Decimal>();
  const out: ReadonlyMap<CurrencyCode, Decimal>[] = [];
  let cursor = 0;
  for (const date of dates) {
    while (cursor < nets.length && (nets[cursor] as CashDailyNet).date < date) {
      const net = nets[cursor] as CashDailyNet;
      running.set(net.currency, (running.get(net.currency) ?? ZERO).plus(net.amount));
      cursor += 1;
    }
    out.push(new Map(running));
  }
  return out;
}

/**
 * Converts per-currency cash `balances` to `baseCurrency` on `date`. Zero
 * balances are skipped; the base currency converts at 1 with no observation;
 * any other currency at its latest rate on or before `date` (never look-ahead),
 * returning the observed date. No rate: listed in `unconverted`, adds nothing.
 */
export function valueCash(
  balances: ReadonlyMap<CurrencyCode, Decimal>,
  fxRates: readonly FxRatePoint[],
  date: IsoDate,
  baseCurrency: CurrencyCode,
): CashValuation {
  const byCurrency: CashCurrencyValuation[] = [];
  const unconverted: CurrencyCode[] = [];
  let totalValueBase = ZERO;

  const currencies = [...balances.keys()].sort((a, b) => a.localeCompare(b));
  for (const currency of currencies) {
    const amount = balances.get(currency) ?? ZERO;
    if (amount.isZero()) continue;

    if (currency === baseCurrency) {
      byCurrency.push({ currency, amount, rate: ONE, valueBase: amount });
      totalValueBase = totalValueBase.plus(amount);
      continue;
    }

    const observation = locf(
      fxRates.filter((r) => r.currency === currency),
      date,
      (r) => r.observedOn,
    );
    if (observation === undefined) {
      byCurrency.push({ currency, amount });
      unconverted.push(currency);
      continue;
    }
    const valueBase = amount.times(observation.rate);
    byCurrency.push({
      currency,
      amount,
      rate: marketRate(observation.rate),
      rateObservedOn: observation.observedOn,
      valueBase,
    });
    totalValueBase = totalValueBase.plus(valueBase);
  }

  return { byCurrency, totalValueBase, unconverted };
}
