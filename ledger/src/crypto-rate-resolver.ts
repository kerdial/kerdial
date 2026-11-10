import { Decimal } from "@kerdial/core-decimal";
import { locf } from "@kerdial/core-domain";
import { DataGap, SymbolNotFound } from "@kerdial/market-ports";
import type { IsoDate, PriceObservation, ProviderKey, QuoteProvider } from "@kerdial/market-ports";
import { instrumentPriceDaily, type Db } from "@kerdial/platform-db";
import { and, eq, gte, lte } from "drizzle-orm";
import type { FxLeg, FxRateResolver, ResolvedRate } from "./fx-rate-resolver.js";
import { getProviderMapping } from "./instrument-provider-map-service.js";

/**
 * `CryptoRateResolver` — T-32
 * (component C9). Resolves a crypto **settlement** leg's rate to base
 * through the crypto `QuoteProvider` (a market *quote*), never through
 * `FxRateResolver`/ECB — ECB will never publish a crypto rate, and
 * `FxRateResolver`'s ISO-4217 currency validation would reject a settlement
 * asset like USDT/DOGE/AVAX/SHIB/MATIC outright (the T-20 blocker this
 * resolves). Mirrors {@link FxRateResolver} exactly: same precedence rule,
 * same fail-closed contract, same {@link ResolvedRate} shape — so
 * `TransactionWriteService`'s column-writing code (`principalFxColumns`) is
 * unchanged by which resolver produced the rate.
 *
 * ## The precedence rule — mirrors the FX resolver's exactly
 *
 * ```
 * resolve(leg, settlementInstrumentId, date, userInput?) -> ResolvedRate
 *   if userInput != null  -> { rate: userInput, source: USER_PINNED,
 *                              userInput, providerKey: null, observedOn: null }
 *   local observation     -> instrument_price_daily for the settlement
 *                            instrument over [date - lookback, date]
 *                            (ADR-0004 step 2 / AR-8) — the
 *                            series our own backfill wrote, which for a
 *                            historical date is deeper than any live call:
 *                            free quote APIs cap history around a year, so a
 *                            >365-day-old crypto-settled trade is priceable
 *                            ONLY from here. LOCF; the fiat sub-leg composed
 *                            exactly as below when the row's currency is not
 *                            the base.
 *   else                  -> resolve provider symbol (instrument_provider_map);
 *                            fetchDailyHistory over [date - lookback, date];
 *                            LOCF (core/domain's locf, the one implementation)
 *                            to `date` -- never look-ahead;
 *                            quote price is in the observation's `currency`:
 *                              if currency == baseCurrency -> rate = price
 *                              else -> rate = price × fiatRate(currency -> base, date)
 *                                                        -- composed via the
 *                                                        -- injected FxRateResolver
 *                            -> { rate, source: QUOTE_PROVIDER,
 *                                 providerKey: <crypto source>, observedOn: <quote date> }
 *   fail-closed: no quote and no user pin -> CryptoRateUnavailableError
 * ```
 *
 * The `userInput` branch is an early return, exactly as in
 * {@link FxRateResolver} — a provider outage cannot displace a pinned rate,
 * and no provider call is made at all on that path.
 *
 * ## No FX-provider fallback (unlike `FxRateResolver`'s NFR-13 leg)
 *
 * `FxRateResolver` falls back to a tenant's own `fx_rate_user` rows when the
 * configured FX provider does not cover a pair. There is no crypto analogue
 * of that table (none is introduced) — a crypto
 * settlement asset either has a usable quote or the write is rejected,
 * directing the user to pin a rate (FR-56 always permits this).
 *
 * ## Currency-of-quote (a flagged assumption)
 *
 * `QuoteProvider.fetchDailyHistory` returns each observation in the
 * instrument's own quote currency, with no target-currency parameter. When
 * that currency is this resolver's base currency, the quote *is* the rate;
 * otherwise it is composed with the fiat leg through the **injected**
 * {@link FxRateResolver} (never a second concrete FX adapter reached
 * directly — `ledger` only ever holds the one `FxRateResolver` instance a
 * request was constructed with). The composed row's single `fx_rate_source`
 * records the *dominant* provenance (`QUOTE_PROVIDER`); the fiat sub-leg's
 * own provenance is not separately preserved (an accepted granularity limit).
 *
 * ## Module boundary
 *
 * `ledger` may import `market/ports` (only `market/adapters` is forbidden) —
 * this class depends on the {@link QuoteProvider} **port** only, exactly as
 * {@link FxRateResolver} depends on `FxRateProvider`. It never names or
 * branches on a concrete adapter; `providerKey` is carried through opaquely
 * from `capabilities().key`, purely as provenance (FR-58).
 *
 * ## NFR-12
 *
 * Every rate is a `Decimal` end to end. A `userInput` that is not a
 * `Decimal` instance is rejected rather than coerced.
 */

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far back the provider is asked for observations so {@link locf} has
 * something to carry forward from — mirrors `FxRateResolver`'s
 * `PROVIDER_LOOKBACK_DAYS` (same value, same "bounds the fetch window, not
 * the LOCF rule itself" reasoning). Crypto markets trade 24/7 with no
 * weekend/holiday gap, so a real publication gap this wide already means the
 * quote source has stopped covering the asset, not merely "not published
 * today" — which is exactly the case this resolver should fail closed on
 * rather than carry forward from weeks prior.
 */
const PROVIDER_LOOKBACK_DAYS = 14;

/** `date` minus `days`, on the proleptic Gregorian calendar, in `YYYY-MM-DD`. Integer arithmetic on epoch milliseconds — no floats (NFR-12). Mirrors `fx-rate-resolver.ts`'s identical helper. */
function minusDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The fail-closed outcome: no user-supplied rate, and no quote
 * obtainable for this settlement instrument and date — whether because no
 * `instrument_provider_map` row maps it to this resolver's configured
 * `QuoteProvider`, or because the provider itself has nothing for the
 * requested window (even after LOCF). The analogue of
 * {@link import("./fx-rate-resolver.js").FxRateUnavailableError}: a
 * validation error, not a provider error — the write is rejected and the
 * caller's remedy is to supply a rate manually (FR-56).
 */
export class CryptoRateUnavailableError extends Error {
  readonly leg: FxLeg;
  readonly settlementInstrumentId: string;
  readonly date: IsoDate;

  constructor(leg: FxLeg, settlementInstrumentId: string, date: IsoDate) {
    super(
      `No crypto quote available for settlement instrument ${settlementInstrumentId} on ${date} (${leg} leg): ` +
        `no usable provider mapping or quote covers this asset for that date, and no manual rate is on file. ` +
        `Supply an explicit FX rate for this transaction.`,
    );
    this.name = "CryptoRateUnavailableError";
    this.leg = leg;
    this.settlementInstrumentId = settlementInstrumentId;
    this.date = date;
  }
}

/** Dependencies of one resolver instance — constructed per request/tenant, mirroring {@link import("./fx-rate-resolver.js").FxRateResolverDeps}. */
export interface CryptoRateResolverDeps {
  readonly db: Db;
  /** The **port**, never a concrete adapter — the composition layer selects the crypto-capable adapter (`CRYPTO -> yahoo`; `coingecko` before). */
  readonly provider: QuoteProvider;
  /**
   * The already-constructed `FxRateResolver` for this same tenant/request —
   * used only to compose the fiat sub-leg when the quote's own currency is
   * not this tenant's base currency. Also supplies
   * `baseCurrency`, so this resolver never hardcodes or re-reads it
   * separately (NFR-13's "no currency hardcoded in business logic").
   */
  readonly fxRateResolver: FxRateResolver;
}

export class CryptoRateResolver {
  readonly #db: Db;
  readonly #provider: QuoteProvider;
  readonly #fx: FxRateResolver;

  constructor(deps: CryptoRateResolverDeps) {
    this.#db = deps.db;
    this.#provider = deps.provider;
    this.#fx = deps.fxRateResolver;
  }

  /**
   * Resolves the rate to apply to a crypto settlement leg — the
   * pseudocode, branch for branch. See this module's header for
   * why the ordering and the early return are the requirement rather than an
   * implementation detail.
   *
   * @param leg which of the transaction's FX legs this is (in practice
   *   always `PRINCIPAL` for a settlement leg today); carried through onto
   *   the result, never branched on — mirrors {@link FxRateResolver.resolve}.
   * @param settlementInstrumentId the catalogue id of the settlement asset
   *   (the BTC of "buy 2 ETH paying 0.1 BTC").
   * @param date the transaction date, `YYYY-MM-DD`.
   * @param userInput the rate the user supplied for *this settlement leg*
   *   (FR-56), or `undefined`/`null` if they supplied none. When present it
   *   wins outright (FR-57, AC45) and no provider call is made.
   *
   * @throws {CryptoRateUnavailableError} when no user rate was supplied and
   *   no quote can be obtained for this asset and date (fail-closed).
   */
  async resolve(
    leg: FxLeg,
    settlementInstrumentId: string,
    date: IsoDate,
    userInput?: Decimal | null,
  ): Promise<ResolvedRate> {
    if (typeof settlementInstrumentId !== "string" || settlementInstrumentId.trim() === "") {
      throw new TypeError("settlementInstrumentId is required");
    }
    if (!ISO_DATE_SHAPE.test(date)) {
      throw new TypeError(
        `date must be an ISO YYYY-MM-DD calendar date, got: ${JSON.stringify(date)}`,
      );
    }

    // FR-57 / AC45. Early return: everything below this point is
    // unreachable when the user pinned a rate — exactly as in
    // `FxRateResolver.resolve`.
    if (userInput !== undefined && userInput !== null) {
      if (!(userInput instanceof Decimal)) {
        throw new TypeError(
          `userInput must be a Decimal (NFR-12 — never a number or string), got: ${typeof userInput}`,
        );
      }
      // `greaterThan(0)`, not `isPositive()`: see the identical note in
      // `fx-rate-resolver.ts` (decimal.js's `isPositive()` is true for zero).
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

    // ADR-0004 step 2 (AR-8) — the local series first. Not a
    // degradation path: it is the only path that can price a settlement
    // more than a year old (free quote APIs cap history), and it keeps the
    // pinned rate consistent with the series the portfolio's own valuations
    // already use.
    const local = await this.#fromLocalDaily(leg, settlementInstrumentId, date);
    const quote = local ?? (await this.#fromProvider(leg, settlementInstrumentId, date));
    if (quote === undefined) {
      throw new CryptoRateUnavailableError(leg, settlementInstrumentId, date);
    }

    return {
      leg,
      rate: quote.rate,
      source: "QUOTE_PROVIDER",
      userInput: null,
      providerKey: quote.providerKey,
      observedOn: quote.observedOn,
    };
  }

  /**
   * ADR-0004 step 2 (AR-8): the `instrument_price_daily` series our own
   * backfill wrote for the settlement instrument, bounded to the same
   * lookback window as the live call (same suspended-asset reasoning as
   * `FxRateResolver.#fromLocalDaily`), LOCF'd by the one shared
   * implementation, and composed with the fiat sub-leg exactly as the live
   * path is when the row's own `currency` is not the base. `providerKey` is
   * the row's own `source_key` — the same publisher the live call would
   * name, so a locally-resolved row is byte-identical to a live-resolved
   * one for the same observation.
   */
  async #fromLocalDaily(
    leg: FxLeg,
    settlementInstrumentId: string,
    date: IsoDate,
  ): Promise<{ rate: Decimal; providerKey: ProviderKey; observedOn: IsoDate } | undefined> {
    const rows = await this.#db
      .select()
      .from(instrumentPriceDaily)
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, settlementInstrumentId),
          gte(instrumentPriceDaily.priceDate, minusDays(date, PROVIDER_LOOKBACK_DAYS)),
          lte(instrumentPriceDaily.priceDate, date),
        ),
      );
    const row = locf(rows, date, (point) => point.priceDate as IsoDate);
    if (row === undefined) return undefined;

    const baseCurrency = this.#fx.baseCurrency;
    const rate =
      row.currency === baseCurrency
        ? row.closeRaw
        : row.closeRaw.times((await this.#fx.resolve(leg, row.currency, date)).rate);

    return { rate, providerKey: row.sourceKey, observedOn: row.priceDate as IsoDate };
  }

  /**
   * The quote leg: resolve `settlementInstrumentId`'s provider
   * symbol via `instrument_provider_map` (keyed by this resolver's
   * configured `QuoteProvider`'s own `capabilities().key` — never a
   * three-letter code), ask the port for its daily history over
   * `[date - PROVIDER_LOOKBACK_DAYS, date]`, and pick the most recent
   * observation on or before `date` with T-14's {@link locf}.
   *
   * Returns `undefined` — the trigger for {@link CryptoRateUnavailableError}
   * — when no provider mapping exists for this instrument, when the port
   * reports {@link SymbolNotFound} or {@link DataGap}, or when the fetched
   * window holds no observation on or before `date`. Every other
   * {@link import("@kerdial/market-ports").ProviderError} — rate limited,
   * unavailable, malformed — is rethrown unchanged, exactly as
   * `FxRateResolver.#fromProvider` does: those mean "we could not ask," not
   * "there is no quote."
   *
   * When the resolved observation's own `currency` is not this resolver's
   * base currency, it is composed with the fiat leg through the injected
   * `FxRateResolver` — a genuine `FxRateUnavailableError` from
   * that composition is **not** swallowed into
   * {@link CryptoRateUnavailableError}: it is a distinct, more precise
   * diagnostic ("the crypto quote resolved fine; its own currency has no
   * covered fiat rate to base") and is left to propagate unchanged.
   */
  async #fromProvider(
    leg: FxLeg,
    settlementInstrumentId: string,
    date: IsoDate,
  ): Promise<{ rate: Decimal; providerKey: ProviderKey; observedOn: IsoDate } | undefined> {
    const providerKey = this.#provider.capabilities().key;
    const mapping = await getProviderMapping(this.#db, settlementInstrumentId, providerKey);
    if (mapping === undefined) return undefined;

    let history: readonly PriceObservation[];
    try {
      history = await this.#provider.fetchDailyHistory(
        mapping.providerSymbol,
        minusDays(date, PROVIDER_LOOKBACK_DAYS),
        date,
      );
    } catch (err) {
      if (err instanceof SymbolNotFound || err instanceof DataGap) return undefined;
      throw err;
    }

    const observation = locf(history, date, (point) => point.priceDate);
    if (observation === undefined) return undefined;

    const baseCurrency = this.#fx.baseCurrency;
    const rate =
      observation.currency === baseCurrency
        ? observation.close
        : observation.close.times((await this.#fx.resolve(leg, observation.currency, date)).rate);

    return { rate, providerKey, observedOn: observation.priceDate };
  }
}
