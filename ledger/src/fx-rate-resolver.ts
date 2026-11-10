import { Decimal } from "@kerdial/core-decimal";
import { locf } from "@kerdial/core-domain";
import { DataGap, SymbolNotFound } from "@kerdial/market-ports";
import type {
  CurrencyCode,
  FxObservation,
  FxRateProvider,
  IsoDate,
  ProviderKey,
} from "@kerdial/market-ports";
import {
  fxRateDaily,
  fxRateSourceEnum,
  fxRateUser,
  withTenant,
  type Db,
  type TenantId,
} from "@kerdial/platform-db";
import { and, eq, gte, lte } from "drizzle-orm";

/**
 * `FxRateResolver` — T-18
 * (component C9). **The single place in the system where an FX rate is
 * decided**, called exactly once per FX leg at transaction write time
 * (T-19/T-20, out of scope here). The rate it returns is stored on the
 * transaction row and never recomputed at read time (FR-57's third clause).
 *
 * ## The precedence rule (FR-57, AC45) — why the shape of `resolve` matters
 *
 * `resolve` implements the pseudocode literally, in its stated order —
 * as amended by ADR-0004 (AR-7), which put the **local
 * authoritative observation** ahead of the live call:
 *
 * ```
 * resolve(leg, currency, date, userInput?) -> ResolvedRate
 *   if currency == baseCurrency (the tenant ledger base, ADR-0002)  -> { rate: 1, source: IMPLIED_BASE }
 *   if userInput != null   -> { rate: userInput, source: USER_PINNED,
 *                               userInput, providerKey: null, observedOn: null }
 *   local observation      -> fx_rate_user first (FR-56: the user's rate always
 *                             wins), then fx_rate_daily bounded to the same
 *                             lookback window as the live call; LOCF
 *                             -> { rate, source: PROVIDER, providerKey, observedOn }
 *   live provider call     -> lookup via FxRateProvider port,
 *                             LOCF -> { rate, source: PROVIDER,
 *                                              providerKey, observedOn }
 *   neither                -> FxRateUnavailableError (fail closed)
 * ```
 *
 * Local-first is not a degradation path (ADR-0004): for a historical date
 * the local row is what our ingestion actually observed and what every
 * valuation of that period already uses, where a live call can return a
 * since-revised value. For **today**, where ingestion may not have
 * run yet, the local step simply misses and the live call answers — the
 * correct fall-through with no special case. A locally-read ECB rate and a
 * live-fetched one are the same fact from the same publisher, so no new
 * `fx_rate_source` value exists for "read from our own table" — that would
 * record our transport, not the rate's provenance.
 *
 * Both of the first two branches are **early returns**, so the provider
 * branch is *structurally unreachable* when a user rate is present — it is
 * not a try/fallback, and not a provider call whose result is later
 * discarded. A provider outage therefore cannot cause a pinned rate to be
 * replaced, and no code path exists along which the automatically retrieved
 * rate could be used "just in case". `fx-rate-resolver.test.ts` proves this
 * with a spy on the port that asserts zero calls, not merely by checking the
 * returned value.
 *
 * ## Fail-closed
 *
 * When no user rate is supplied and neither the provider (after LOCF) nor
 * this tenant's own `fx_rate_user` rows can supply a rate, `resolve` throws
 * {@link FxRateUnavailableError} and the write is rejected. It never
 * defaults to 1, never substitutes a neighbouring currency, and never
 * carries a rate forward from an unrelated pair: "a wrong rate is worse than
 * a rejected form". `IMPLIED_BASE`'s rate is the literal `1`, never a
 * computed `currency/currency` division, so it cannot drift to
 * `0.999999...`.
 *
 * ## Direction (risk R12)
 *
 * Every rate here — pinned, provider-sourced or manual — is in the one
 * canonical direction: `amount_base = amount_native × rate`, i.e. units of
 * base currency per one unit of `currency`. The pair handed to the port is
 * therefore `{ base: baseCurrency, quote: currency }`; the ECB adapter
 * inverts ECB's own EUR-base publication direction at its own boundary
 * (T-15), so nothing here ever sees a provider's convention.
 *
 * ## No provider identity here
 *
 * This class depends on the {@link FxRateProvider} *port* only; it never
 * names, imports or branches on a concrete adapter. `providerKey` is carried
 * through opaquely from the observation that supplied the rate, purely as
 * provenance (FR-58).
 *
 * ## NFR-12
 *
 * Every rate is a `Decimal` end to end (`fx_rate` is `NUMERIC(28,12)`,
 * ≥ 8 dp per NFR-12). No `number` enters or leaves this module; a `userInput`
 * that is not a `Decimal` instance is rejected rather than coerced.
 */

/**
 * Which of a transaction's independent FX legs a resolution is
 * for. Each leg is resolved by its own call to
 * {@link FxRateResolver.resolve}. `PRINCIPAL` maps to `transaction`'s
 * `fx_rate*` column group. The resolver itself does not branch on the leg — it
 * is carried on the result so the caller writes the resolved values to the
 * matching column group.
 *
 * **`WITHHOLDING_TAX` was the second member and is gone too** (`0079`):
 * the withholding is denominated by the settling account and carried at the
 * principal's implied rate, as a cost is since L5, so it has no rate to
 * resolve and `wht_fx_rate*` was dropped. `PRINCIPAL` is the only leg left.
 *
 * **`FEE` was the third member and is gone** (FT-34). L5/L6
 * retired the independently-rated fee leg: a cost is denominated by the
 * settling account and carried at the principal's rate, so FR-60/AC49's "a EUR
 * fee on a USD trade uses the fee's own rate" is retired with it (L6).
 *
 * **The narrowing is the enforcement, and that was the plan.** With `FEE`
 * removed from this union, any surviving `resolve("FEE", …)` is a *type error*
 * rather than a dead call nobody notices — which is why FT-36's last acceptance
 * criterion is phrased as "`pnpm typecheck` passes" and why the removal had to
 * wait until the last caller stopped sending a fee currency. Rows written
 * before this release keep their `fee_fx_rate*` values and still expand through
 * `expandPostings`' legacy branch; the columns are to be dropped later.
 */
export type FxLeg = "PRINCIPAL";

/**
 * The closed set of rate provenances, taken from the database's own
 * `fx_rate_source` enum (migration `0003`) rather than redeclared, so this
 * module physically cannot produce a value the column would reject.
 */
/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export type FxRateSource = (typeof fxRateSourceEnum.enumValues)[number];

/**
 * What `resolve` returns, and what T-19/T-20 write verbatim into the
 * transaction's FX columns for {@link ResolvedRate.leg} — `fx_rate`,
 * `fx_rate_source`, `fx_rate_provider_key`, `fx_rate_observed_on`,
 * `fx_rate_user_input`.
 *
 * `rate` is never null and never absent ("never NULL, never
 * 'absent, assume 1'"), which is why the type has no optional/undefined
 * variant. `userInput` is non-null **only** for `USER_PINNED`: it records
 * exactly what the user typed, alongside `rate`, so a later reviewer can see
 * the stored rate came from the form and not from a provider.
 *
 * `observedOn` is the date the returned rate was actually published, which
 * for a weekend/holiday `date` is an *earlier* date (the LOCF rule): a
 * Saturday trade stores Friday's `observedOn`, making the carry-forward
 * auditable rather than invisible.
 */
export interface ResolvedRate {
  readonly leg: FxLeg;
  readonly rate: Decimal;
  readonly source: FxRateSource;
  readonly userInput: Decimal | null;
  readonly providerKey: ProviderKey | null;
  readonly observedOn: IsoDate | null;
}

/**
 * The fail-closed outcome: no user-supplied rate, and no rate
 * obtainable for this pair and date from the configured provider (even after
 * LOCF) or from this tenant's `fx_rate_user` rows. The write is rejected;
 * the caller's remedy is to supply a rate on the transaction (FR-56 always
 * permits this) or to add an `fx_rate_user` row for the pair (NFR-13), which
 * is what the message says.
 *
 * A validation error, not a provider error: from the caller's point of view
 * this is a rejected input, not an outage. Genuinely transient provider
 * failures (`ProviderUnavailable`, `ProviderRateLimited`,
 * `ProviderMalformedResponse`) are *not* mapped to this class — see
 * {@link FxRateResolver}'s `#fromProvider` comment.
 */
export class FxRateUnavailableError extends Error {
  readonly leg: FxLeg;
  readonly baseCurrency: CurrencyCode;
  readonly currency: CurrencyCode;
  readonly date: IsoDate;

  constructor(leg: FxLeg, baseCurrency: CurrencyCode, currency: CurrencyCode, date: IsoDate) {
    super(
      `No FX rate available for ${currency} -> ${baseCurrency} on ${date} (${leg} leg): the configured provider does not cover this pair for that date and no manual rate is on file. ` +
        `Supply an explicit FX rate for this transaction, or record a manual rate for the pair.`,
    );
    this.name = "FxRateUnavailableError";
    this.leg = leg;
    this.baseCurrency = baseCurrency;
    this.currency = currency;
    this.date = date;
  }
}

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_SHAPE = /^[A-Z]{3}$/;

/**
 * How far back the provider is asked for observations so that {@link locf}
 * has something to carry forward from. It bounds the *fetch window*, not the
 * LOCF rule itself.
 *
 * Two weeks is comfortably wider than the longest run of consecutive
 * non-publication days a daily FX series has (a weekend plus adjacent
 * TARGET holidays — Christmas/New Year, Good Friday to Easter Monday — is at
 * most a handful of days), and deliberately not wider: a pair with *no*
 * publication for a fortnight has been withdrawn or suspended, not merely
 * not-published-today, and silently pricing a trade off a rate weeks stale
 * is exactly the failure the resolver chooses to fail closed on. Such a request
 * falls through to `fx_rate_user` and then to
 * {@link FxRateUnavailableError}, telling the user to pin a rate.
 *
 * The read path's `valuation/src/pricing-series.ts` declares the same horizon
 * by value as `FX_PROVIDER_COVERAGE_HORIZON_DAYS`, because `valuation` may not
 * import `ledger` — keep the two in step by hand.
 */
const PROVIDER_LOOKBACK_DAYS = 14;

/** `date` minus `days`, on the proleptic Gregorian calendar, in `YYYY-MM-DD`. Integer arithmetic on epoch milliseconds — no floats (NFR-12). */
function minusDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

/** Dependencies of one resolver instance. Constructed per request/tenant — `tenantId` and `baseCurrency` are fixed for the lifetime of the instance so `resolve` keeps its exact four-argument shape. */
export interface FxRateResolverDeps {
  readonly db: Db;
  /** The **port**, never a concrete adapter. */
  readonly provider: FxRateProvider;
  /** The tenant whose `fx_rate_user` rows are the NFR-13 fallback. */
  readonly tenantId: TenantId;
  /**
   * This tenant's base reporting currency, read from `tenant.base_currency`
   * by the caller. Passed in rather than hardcoded: NFR-13 allows no
   * currency in business logic other than the base reporting currency
   * *default*, which lives in the column's `DEFAULT 'EUR'`, not here.
   */
  readonly baseCurrency: CurrencyCode;
}

export class FxRateResolver {
  readonly #db: Db;
  readonly #provider: FxRateProvider;
  readonly #tenantId: TenantId;
  readonly #baseCurrency: CurrencyCode;

  constructor(deps: FxRateResolverDeps) {
    if (!CURRENCY_SHAPE.test(deps.baseCurrency)) {
      throw new TypeError(
        `baseCurrency must be an ISO 4217 alphabetic code, got: ${JSON.stringify(deps.baseCurrency)}`,
      );
    }
    this.#db = deps.db;
    this.#provider = deps.provider;
    this.#tenantId = deps.tenantId;
    this.#baseCurrency = deps.baseCurrency;
  }

  /**
   * The tenant this resolver was constructed for. Exposed read-only so
   * `TransactionWriteService` (T-19) can scope its writes to *the same*
   * tenant the FX legs were resolved under, rather than taking a second
   * `tenantId` parameter that could silently disagree with this one.
   */
  get tenantId(): TenantId {
    return this.#tenantId;
  }

  /** This tenant's base reporting currency (see {@link FxRateResolverDeps.baseCurrency}). Read-only, for the same reason as {@link FxRateResolver.tenantId}. */
  get baseCurrency(): CurrencyCode {
    return this.#baseCurrency;
  }

  /**
   * Resolves the rate to apply to one FX leg — the
   * pseudocode, branch for branch and in order. See this module's header
   * for why the ordering and the early returns are the requirement rather
   * than an implementation detail.
   *
   * @param leg which of the transaction's three FX legs this is; carried
   *   through onto the result, never branched on.
   * @param currency the transaction (or fee, or withholding) currency.
   * @param date the transaction date, `YYYY-MM-DD`.
   * @param userInput the rate the user supplied for *this transaction*
   *   (FR-56), or `undefined`/`null` if they supplied none. When present it
   *   wins outright (FR-57, AC45) and no provider call is made.
   *
   * @throws {FxRateUnavailableError} when no user rate was supplied and no
   *   rate can be obtained for the pair and date (fail-closed).
   */
  async resolve(
    leg: FxLeg,
    currency: CurrencyCode,
    date: IsoDate,
    userInput?: Decimal | null,
  ): Promise<ResolvedRate> {
    if (!CURRENCY_SHAPE.test(currency)) {
      throw new TypeError(
        `currency must be an ISO 4217 alphabetic code, got: ${JSON.stringify(currency)}`,
      );
    }
    if (!ISO_DATE_SHAPE.test(date)) {
      throw new TypeError(
        `date must be an ISO YYYY-MM-DD calendar date, got: ${JSON.stringify(date)}`,
      );
    }

    // A transaction with no FX involvement stores rate 1 /
    // IMPLIED_BASE — never NULL, never "absent, assume 1", and never a
    // computed 1.000000... from dividing a currency by itself.
    if (currency === this.#baseCurrency) {
      return {
        leg,
        rate: new Decimal(1),
        source: "IMPLIED_BASE",
        userInput: null,
        providerKey: null,
        observedOn: null,
      };
    }

    // FR-57 / AC45. Early return: everything below this point is
    // unreachable when the user pinned a rate.
    if (userInput !== undefined && userInput !== null) {
      if (!(userInput instanceof Decimal)) {
        throw new TypeError(
          `userInput must be a Decimal (NFR-12 — never a number or string), got: ${typeof userInput}`,
        );
      }
      // `greaterThan(0)`, not `isPositive()`: decimal.js's `isPositive()` is
      // true for zero (zero carries a `+` sign), which would let a rate of 0
      // through and silently zero out every base-currency amount.
      if (!userInput.isFinite() || !userInput.greaterThan(0)) {
        throw new TypeError(
          `userInput must be a positive, finite rate, got: ${userInput.toString()}`,
        );
      }
      return {
        leg,
        rate: userInput,
        source: "USER_PINNED",
        userInput,
        providerKey: null,
        observedOn: null,
      };
    }

    // ADR-0004 step 2 (AR-7) — the local authoritative
    // observation, before any live call. Within the step, the tenant's own
    // rows win (FR-56's principle, mirroring resolvePrice's
    // manual-over-automated precedence — recorded in the ADR so it is not
    // inferred).
    const manual = await this.#fromTenantRates(currency, date);
    if (manual !== undefined) {
      return {
        leg,
        rate: manual.rate,
        source: "PROVIDER",
        userInput: null,
        providerKey: manual.sourceKey,
        observedOn: manual.rateDate,
      };
    }

    const local = await this.#fromLocalDaily(currency, date);
    if (local !== undefined) {
      return {
        leg,
        rate: local.rate,
        source: "PROVIDER",
        userInput: null,
        providerKey: local.sourceKey,
        observedOn: local.rateDate,
      };
    }

    // ADR-0004 step 3 — the live call, now a fallback for the dates the
    // local series does not cover yet (typically today, before ingestion).
    const published = await this.#fromProvider(currency, date);
    if (published !== undefined) {
      return {
        leg,
        rate: published.rate,
        source: "PROVIDER",
        userInput: null,
        providerKey: published.sourceKey,
        observedOn: published.rateDate,
      };
    }

    throw new FxRateUnavailableError(leg, this.#baseCurrency, currency, date);
  }

  /**
   * The provider leg: ask the port for the pair's observations
   * over `[date - PROVIDER_LOOKBACK_DAYS, date]` and pick the most recent
   * one on or before `date` with T-14's {@link locf} — the *one*
   * carry-forward implementation ("one rule, one implementation"),
   * never re-derived here. Because the requested window ends at `date`, and
   * because `locf` never looks ahead, a later publication cannot leak into
   * a past transaction's rate (the look-ahead-bias argument).
   *
   * Returns `undefined` — meaning "this provider does not cover the pair
   * for this date", the trigger for the `fx_rate_user` fallback — when the
   * port reports {@link SymbolNotFound} (the pair is not published at all,
   * e.g. EUR/RUB after its suspension) or {@link DataGap} (nothing
   * published in the window), or when the window holds no observation on or
   * before `date`.
   *
   * Every other {@link import("@kerdial/market-ports").ProviderError}
   * — rate limited, unavailable, malformed — is rethrown unchanged. Those
   * mean "we could not ask", not "there is no rate": swallowing them into
   * the manual-rate fallback would let a transient outage silently change
   * which source priced a transaction, and would hide the outage from the
   * ingestion layer's circuit breaker.
   */
  async #fromProvider(currency: CurrencyCode, date: IsoDate): Promise<FxObservation | undefined> {
    const pair = { base: this.#baseCurrency, quote: currency };
    let observations: readonly FxObservation[];
    try {
      observations = await this.#provider.fetchDailyRates(
        [pair],
        minusDays(date, PROVIDER_LOOKBACK_DAYS),
        date,
      );
    } catch (err) {
      if (err instanceof SymbolNotFound || err instanceof DataGap) return undefined;
      throw err;
    }

    const forPair = observations.filter(
      (observation) => observation.base === pair.base && observation.quote === pair.quote,
    );
    return locf(forPair, date, (observation) => observation.rateDate);
  }

  /**
   * ADR-0004 step 2's shared half (AR-7): the `fx_rate_daily` series our own
   * ingestion wrote — the same rows every valuation of the period already
   * uses. Bounded to the **same lookback window as the live call**, and
   * deliberately: an unwindowed LOCF over the local series would carry a
   * suspended pair's last publication forward for years (EUR/RUB's 2022
   * stop pricing a 2024 trade), which is exactly what the window exists to
   * refuse on the live path. Same window, same refusal, same fall-through
   * to `fx_rate_user`-less rejection.
   *
   * `fx_rate_daily` is a shared reference table (no RLS), read with the
   * resolver's own handle — the same boundary reasoning ADR-0004 records
   * (`ledger` already reads reference tables; only `market/adapters` is
   * forbidden).
   */
  async #fromLocalDaily(
    currency: CurrencyCode,
    date: IsoDate,
  ): Promise<{ rate: Decimal; rateDate: IsoDate; sourceKey: ProviderKey } | undefined> {
    const rows = await this.#db
      .select()
      .from(fxRateDaily)
      .where(
        and(
          eq(fxRateDaily.baseCurrency, this.#baseCurrency),
          eq(fxRateDaily.quoteCurrency, currency),
          gte(fxRateDaily.rateDate, minusDays(date, PROVIDER_LOOKBACK_DAYS)),
          lte(fxRateDaily.rateDate, date),
        ),
      );
    return locf(rows, date, (row) => row.rateDate);
  }

  /**
   * The NFR-13 leg: this tenant's own `fx_rate_user` rows — "plus any
   * currency for which the user supplies rates manually", the documented
   * remedy for a pair the configured provider does not publish.
   *
   * Goes through `withTenant`: `fx_rate_user` is tenant-owned and
   * under `FORCE ROW LEVEL SECURITY`, so RLS is the primary scoping here and
   * the explicit `tenant_id` predicate is defence in depth.
   *
   * The same LOCF rule applies as for the provider series — one rule for
   * both — but the fetch is deliberately **not** windowed the way the
   * provider fetch is: a manual rate table has no publication cadence to
   * bound (a user records a rate when they have one, perhaps monthly), so
   * bounding it to a fortnight would reject rates the user deliberately
   * entered. `observedOn` records exactly which date the rate was carried
   * from, so the carry-forward stays auditable however long it is.
   */
  async #fromTenantRates(
    currency: CurrencyCode,
    date: IsoDate,
  ): Promise<{ rate: Decimal; rateDate: IsoDate; sourceKey: ProviderKey } | undefined> {
    const rows = await withTenant(this.#db, this.#tenantId, async (tx) =>
      tx
        .select()
        .from(fxRateUser)
        .where(
          and(
            eq(fxRateUser.tenantId, this.#tenantId),
            eq(fxRateUser.baseCurrency, this.#baseCurrency),
            eq(fxRateUser.quoteCurrency, currency),
            lte(fxRateUser.rateDate, date),
          ),
        ),
    );
    return locf(rows, date, (row) => row.rateDate);
  }
}
