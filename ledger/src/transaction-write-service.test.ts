import { Decimal } from "@kerdial/core-decimal";
import type {
  CurrencyPair,
  FxRateProvider,
  InstrumentRef,
  IsoDate,
  ProviderSymbol,
  QuoteProvider,
} from "@kerdial/market-ports";
import type { Clock } from "@kerdial/market-ingestion";
import { createDb, createPostgresClient, type Db } from "@kerdial/platform-db";
import { describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import {
  CashAccountNotAllowedError,
  CashAccountRequiredError,
  TradeDateInFutureError,
  CostComponentsInvalidError,
  TradeDateTooOldError,
  TransactionAmountNotPositiveError,
  TransactionArgumentError,
  TransactionWriteService,
  type TransactionEdit,
} from "./transaction-write-service.js";

/**
 * Pure/no-DB tests for T-19 and T-20 — argument validation and NFR-12's
 * "`Decimal`, never `number`" boundary. The Postgres-backed acceptance
 * criteria (AC4, AC5, AC44, the over-sell rejection, and T-20's FR-9 / AC6 /
 * FR-59 / AC52) live in `transaction-write-service.integration.test.ts`
 * against a real Postgres 17 Testcontainer.
 *
 * **Every case below now expects
 * {@link TransactionArgumentError} where it expected a bare `TypeError`.**
 * The rejections are unchanged: same conditions, same messages, same place in
 * the sequence (before any DB read and before any rate fetch, which is what
 * the unroutable `Db` and the spy prove). What changed is that the nine
 * assertion sites throw a class this codebase owns, so `mapTransactionWriteError`
 * answers 400 instead of 500 and the importer's `ROW_SAFE_LEDGER_ERRORS` can
 * name it. `TransactionAmountNotPositiveError` is its one specialisation, so
 * the cases that expect *that* are unchanged and still pass.
 *
 * These assertions are strictly stronger than the ones they replace: a bare
 * `TypeError` is also what V8 throws for a property read on `undefined`
 * anywhere beneath `record*`, so `toThrow(TypeError)` could have passed on a
 * crash rather than on the assertion under test. `TransactionArgumentError`
 * cannot be raised by accident.
 *
 * As in `fx-rate-resolver.test.ts`, the `Db` here is a lazily-connecting
 * client pointed at an unroutable port and the provider port is a spy: any
 * case below that reached the database or the provider would fail loudly
 * rather than pass quietly, so these tests also prove *where* the rejection
 * happens — before anything is persisted and before any rate is fetched.
 */

const TENANT = "00000000-0000-7000-8000-00000019000a";
const PORTFOLIO = "00000000-0000-7000-8000-000000190001";
const INSTRUMENT = "00000000-0000-7000-8000-000000190002";
/**
 * CA-9: every fiat-settled write now names the `cash_account` its money moved
 * through (FR-156). These ids are never resolved here — this suite's `Db`
 * points at an unroutable port, and the point of every case below is that the
 * rejection happens *before* `#assertCashAccountsUsable`'s read is reached.
 */
const CASH_ACCOUNT = "00000000-0000-7000-8000-0000001900c1";
const TARGET_CASH_ACCOUNT = "00000000-0000-7000-8000-0000001900c2";
const UNREACHABLE_DB: Db = createDb(createPostgresClient("postgres://nobody@127.0.0.1:1/nowhere"));

function serviceWithSpiedProvider(clock?: Clock): {
  service: TransactionWriteService;
  fetchDailyRates: ReturnType<typeof vi.fn>;
} {
  const fetchDailyRates = vi.fn(async (_pairs: CurrencyPair[], _from: IsoDate, _to: IsoDate) => []);
  const provider = {
    capabilities: vi.fn(() => ({
      key: "spy-provider",
      publishedPairs: [],
      baseCurrency: "EUR",
      publicationTimeUtc: "15:00",
      maxHistoryYears: "unbounded" as const,
    })),
    fetchDailyRates,
    fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
  } satisfies FxRateProvider;

  const fxRateResolver = new FxRateResolver({
    db: UNREACHABLE_DB,
    provider,
    tenantId: TENANT,
    baseCurrency: "EUR",
  });

  const quoteProvider = {
    capabilities: vi.fn(() => ({
      key: "spy-coingecko",
      assetKinds: ["CRYPTO"] as const,
      supportsLatestQuote: true,
      supportsDailyHistory: true,
      supportsCorporateActions: false,
      maxHistoryYears: 1,
      quoteQuality: "REALTIME" as const,
      delayMinutes: 0,
      batchSize: 20,
    })),
    resolve: vi.fn(async (_ref: InstrumentRef) => []),
    fetchLatest: vi.fn(async (_symbols: ProviderSymbol[]) => []),
    fetchDailyHistory: vi.fn(async (_symbol: ProviderSymbol, _from: IsoDate, _to: IsoDate) => []),
  } satisfies QuoteProvider;

  const service = new TransactionWriteService({
    db: UNREACHABLE_DB,
    fxRateResolver,
    cryptoRateResolver: new CryptoRateResolver({
      db: UNREACHABLE_DB,
      provider: quoteProvider,
      fxRateResolver,
    }),
    ...(clock ? { clock } : {}),
  });
  return { service, fetchDailyRates };
}

const validBuy = {
  portfolioId: PORTFOLIO,
  instrumentId: INSTRUMENT,
  tradeDate: "2024-03-12",
  quantity: new Decimal("10"),
  unitPrice: new Decimal("42.50"),
  txnCurrency: "EUR",
  cashAccountId: CASH_ACCOUNT,
};

describe("TransactionWriteService — argument validation (no DB required)", () => {
  it("takes its tenant from the resolver, so the write scope cannot disagree with the FX scope", () => {
    const { service } = serviceWithSpiedProvider();
    expect(service.tenantId).toBe(TENANT);
  });

  it("rejects a `number` quantity rather than coercing it (NFR-12)", async () => {
    const { service, fetchDailyRates } = serviceWithSpiedProvider();
    await expect(
      service.recordBuy({ ...validBuy, quantity: 10 as unknown as Decimal }),
    ).rejects.toThrow(TransactionArgumentError);
    expect(fetchDailyRates).not.toHaveBeenCalled();
  });

  it("rejects a `number` deposit amount rather than coercing it (NFR-12)", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(
      service.recordDeposit({
        portfolioId: PORTFOLIO,
        tradeDate: "2024-03-12",
        amount: 1000 as unknown as Decimal,
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
      }),
    ).rejects.toThrow(TransactionArgumentError);
  });

  it("rejects a zero or negative quantity", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(service.recordBuy({ ...validBuy, quantity: new Decimal(0) })).rejects.toThrow(
      /positive/,
    );
    await expect(service.recordSell({ ...validBuy, quantity: new Decimal(-1) })).rejects.toThrow(
      /positive/,
    );
  });

  it("rejects a malformed currency and a malformed trade date before resolving any rate", async () => {
    const { service, fetchDailyRates } = serviceWithSpiedProvider();
    await expect(service.recordBuy({ ...validBuy, txnCurrency: "usd" })).rejects.toThrow(
      TransactionArgumentError,
    );
    await expect(service.recordBuy({ ...validBuy, tradeDate: "12/03/2024" })).rejects.toThrow(
      TransactionArgumentError,
    );
    expect(fetchDailyRates).not.toHaveBeenCalled();
  });

  /**
   * FR-260 (shape change, not a weakened assertion): the amount half of this
   * case now expects {@link TransactionAmountNotPositiveError} where it
   * expected a bare `TypeError`. FT-36 made `fee.amount` optional — components
   * may imply the total — so the four `record*` sites moved from the
   * freestanding `assertPositiveDecimal` to `#assertPositiveIfPresent`, which
   * is the named error `editTransaction` has thrown since T-38's INFO-1. That
   * closes the `fee.amount` slice of an earlier finding ("record* paths still throw a bare
   * TypeError … where editTransaction was moved to a named error") as a side
   * effect; the other slices named there are untouched. The assertion is
   * *stronger* than before — a bare `TypeError` would also have been thrown by
   * a genuine programming mistake anywhere in the call, which is that finding's point.
   * The currency half moved too, but to the base class rather than to this
   * specialisation: `assertCurrency` throws `TransactionArgumentError`
   * (which this note's own parenthetical predicted).
   */
  it("rejects a fee with a non-positive amount, by name", async () => {
    // FR-260: the malformed-currency half went with `fee.currency` itself
    // (L6) — there is no currency on a cost to malform. The
    // amount half is unchanged and still the stronger assertion of the two.
    const { service } = serviceWithSpiedProvider();
    const rejected = await service
      .recordBuy({
        ...validBuy,
        fee: { amount: new Decimal("0") },
      })
      .catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(TransactionAmountNotPositiveError);
    expect((rejected as TransactionAmountNotPositiveError).field).toBe("fee.amount");
    expect((rejected as Error).message).toMatch(/positive, finite amount, got: 0/);
  });

  /**
   * CA-9: "Every `record*` method
   * rejects a missing/empty `cashAccountId` … **before any FX resolution or DB
   * round trip**." Both halves matter, and only this suite can prove the
   * second: its `Db` points at an unroutable port and its provider is a spy,
   * so a rejection that reached either would show up as `ECONNREFUSED` or as a
   * non-zero `fetchDailyRates` count rather than as the named error.
   */
  describe("CA-9 — a cash-emitting leg with no account named (no DB, no FX)", () => {
    it("rejects an empty principal cashAccountId with CashAccountRequiredError, before any rate is fetched", async () => {
      const { service, fetchDailyRates } = serviceWithSpiedProvider();
      // `txnCurrency: "USD"` deliberately: a USD leg under a EUR base *would*
      // consult the provider, so "not called" is a real observation here and
      // not the vacuous one an EUR leg (IMPLIED_BASE, never fetched) gives.
      await expect(
        service.recordBuy({ ...validBuy, txnCurrency: "USD", cashAccountId: "" }),
      ).rejects.toThrow(CashAccountRequiredError);
      await expect(
        service.recordBuy({ ...validBuy, txnCurrency: "USD", cashAccountId: "   " }),
      ).rejects.toThrow(CashAccountRequiredError);
      expect(fetchDailyRates).not.toHaveBeenCalled();
    });

    it("rejects it for every fiat-settled kind, not only a BUY", async () => {
      const { service } = serviceWithSpiedProvider();
      const rejections = [
        service.recordSell({ ...validBuy, cashAccountId: "" }),
        service.recordDeposit({
          portfolioId: PORTFOLIO,
          tradeDate: "2024-03-12",
          amount: new Decimal("100"),
          currency: "EUR",
          cashAccountId: "",
        }),
        service.recordWithdrawal({
          portfolioId: PORTFOLIO,
          tradeDate: "2024-03-12",
          amount: new Decimal("100"),
          currency: "EUR",
          cashAccountId: "",
        }),
        service.recordDividend({
          portfolioId: PORTFOLIO,
          instrumentId: INSTRUMENT,
          tradeDate: "2024-03-12",
          amount: new Decimal("10"),
          currency: "EUR",
          cashAccountId: "",
        }),
        service.recordDrip({
          portfolioId: PORTFOLIO,
          instrumentId: INSTRUMENT,
          sourceDividendId: "00000000-0000-7000-8000-0000001900d1",
          tradeDate: "2024-03-12",
          quantity: new Decimal("1"),
          unitPrice: new Decimal("10"),
          txnCurrency: "EUR",
          cashAccountId: "",
        }),
        service.recordCurrencyExchange({
          portfolioId: PORTFOLIO,
          tradeDate: "2024-03-12",
          amount: new Decimal("100"),
          currency: "EUR",
          cashAccountId: "",
          targetCurrency: "USD",
          targetCashAccountId: TARGET_CASH_ACCOUNT,
          exchangeRate: new Decimal("1.1"),
        }),
      ];
      for (const rejection of rejections) {
        await expect(rejection).rejects.toThrow(CashAccountRequiredError);
      }
    });

    it("rejects a CURRENCY_EXCHANGE missing only its TARGET account — the leg the source's own check cannot cover (AC-176)", async () => {
      const { service } = serviceWithSpiedProvider();
      const attempt = service.recordCurrencyExchange({
        portfolioId: PORTFOLIO,
        tradeDate: "2024-03-12",
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
        targetCurrency: "USD",
        targetCashAccountId: "",
        exchangeRate: new Decimal("1.1"),
      });
      await expect(attempt).rejects.toThrow(CashAccountRequiredError);
      await expect(attempt).rejects.toMatchObject({ field: "targetCashAccountId" });
    });

    /**
     * **FR-260 — CA-9's fee row is retired, and replaced by its successor.**
     *
     * "a fee leg names its own account" was CA-9's claim for the cost leg, and
     * L5 removes the account: a cost leaves the **settling** account, so there
     * is nothing to name and nothing to omit. The other legs' CA-9 rows above
     * are untouched, so the rule itself is still guarded.
     *
     * What replaces it is the constraint that took its place — a cost needs a
     * settling account to be *denominated by*, and an asset-settled row has
     * none — asserted with CA-9's own
     * second half: before any FX resolution or DB round trip.
     */
    it("rejects a cost on a row with no settling account to denominate it, before any DB or FX", async () => {
      const { service, fetchDailyRates } = serviceWithSpiedProvider();
      const attempt = service.recordSettledBuy({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: "00000000-0000-7000-8000-000000190003",
          amount: new Decimal("0.1"),
        },
        fee: { amount: new Decimal("1") },
      });
      await expect(attempt).rejects.toThrow(CostComponentsInvalidError);
      await expect(attempt).rejects.toMatchObject({
        field: "fee.amount",
        reason: "NO_SETTLING_ACCOUNT",
      });
      expect(fetchDailyRates).not.toHaveBeenCalled();
    });

    it("rejects a principal cashAccountId on an asset-settled BUY, before any DB round trip (FR-157/AC-177)", async () => {
      const { service, fetchDailyRates } = serviceWithSpiedProvider();
      const attempt = service.recordSettledBuy({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: "00000000-0000-7000-8000-000000190003",
          amount: new Decimal("0.1"),
        },
        cashAccountId: CASH_ACCOUNT,
      } as unknown as Parameters<typeof service.recordSettledBuy>[0]);
      await expect(attempt).rejects.toThrow(CashAccountNotAllowedError);
      await expect(attempt).rejects.toMatchObject({ reason: "ASSET_SETTLED_PRINCIPAL" });
      expect(fetchDailyRates).not.toHaveBeenCalled();
    });
  });

  it("rejects an empty portfolioId / instrumentId", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(service.recordBuy({ ...validBuy, portfolioId: "" })).rejects.toThrow(
      TransactionArgumentError,
    );
    await expect(service.recordBuy({ ...validBuy, instrumentId: "  " })).rejects.toThrow(
      TransactionArgumentError,
    );
  });
});

describe("TransactionWriteService — T-20 argument validation (no DB required)", () => {
  const validDividend = {
    portfolioId: PORTFOLIO,
    instrumentId: INSTRUMENT,
    tradeDate: "2024-03-12",
    amount: new Decimal("120.50"),
    currency: "EUR",
    cashAccountId: CASH_ACCOUNT,
  };

  const validExchange = {
    portfolioId: PORTFOLIO,
    tradeDate: "2024-03-12",
    amount: new Decimal("1000"),
    currency: "EUR",
    cashAccountId: CASH_ACCOUNT,
    targetCurrency: "USD",
    targetCashAccountId: TARGET_CASH_ACCOUNT,
    exchangeRate: new Decimal("1.0912"),
  };

  it("rejects a `number` dividend amount or withholding amount rather than coercing it (NFR-12)", async () => {
    const { service, fetchDailyRates } = serviceWithSpiedProvider();
    await expect(
      service.recordDividend({ ...validDividend, amount: 120.5 as unknown as Decimal }),
    ).rejects.toThrow(TransactionArgumentError);
    await expect(
      service.recordDividend({
        ...validDividend,
        withholding: { amount: 18 as unknown as Decimal },
      }),
    ).rejects.toThrow(TransactionArgumentError);
    expect(fetchDailyRates).not.toHaveBeenCalled();
  });

  it("rejects a DRIP with a missing source_dividend_id before touching the database (AC6: the link is mandatory)", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(
      service.recordDrip({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        sourceDividendId: "",
        tradeDate: "2024-03-12",
        quantity: new Decimal("1.5"),
        unitPrice: new Decimal("42"),
        txnCurrency: "EUR",
        cashAccountId: CASH_ACCOUNT,
      }),
    ).rejects.toThrow(/sourceDividendId is required/);
  });

  it("rejects a CURRENCY_EXCHANGE carrying an instrument leg, even from an untyped caller (FR-59, AC48)", async () => {
    const { service, fetchDailyRates } = serviceWithSpiedProvider();
    const attempt = service.recordCurrencyExchange({
      ...validExchange,
      instrumentId: INSTRUMENT,
    } as unknown as Parameters<typeof service.recordCurrencyExchange>[0]);
    await expect(attempt).rejects.toThrow(/no instrument leg/);
    expect(fetchDailyRates).not.toHaveBeenCalled();
  });

  it("rejects a CURRENCY_EXCHANGE with a non-positive rate, a malformed target currency, or the same currency on both sides", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(
      service.recordCurrencyExchange({ ...validExchange, exchangeRate: new Decimal("0") }),
    ).rejects.toThrow(/positive/);
    await expect(
      service.recordCurrencyExchange({ ...validExchange, targetCurrency: "US" }),
    ).rejects.toThrow(TransactionArgumentError);
    await expect(
      service.recordCurrencyExchange({ ...validExchange, targetCurrency: "EUR" }),
    ).rejects.toThrow(/two different currencies/);
  });

  it("rejects an asset-settled BUY that pays with the instrument it acquires", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(
      service.recordSettledBuy({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        settlement: { instrumentId: INSTRUMENT, amount: new Decimal("0.1") },
      }),
    ).rejects.toThrow(/must differ from instrumentId/);
  });

  it("rejects a `number` settlement amount rather than coercing it (NFR-12)", async () => {
    const { service } = serviceWithSpiedProvider();
    await expect(
      service.recordSettledBuy({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: "2024-03-12",
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: "00000000-0000-7000-8000-000000190003",
          amount: 0.1 as unknown as Decimal,
        },
      }),
    ).rejects.toThrow(TransactionArgumentError);
  });
});

/**
 * T-35 security review Finding 3 companion (T-37): a
 * `tradeDate` at or before the 15-year backfill floor is rejected at every
 * write boundary, before any rate is resolved. A fixed injected `Clock`
 * (rather than the real one) makes the boundary itself, not merely "some
 * date far in the past," deterministic and immune to the passage of time.
 */
describe("TransactionWriteService — trade-date floor (T-35 security review Finding 3 companion, no DB required)", () => {
  const fixedClock: Clock = { now: () => new Date("2024-06-01T00:00:00.000Z") };
  // BACKFILL_FLOOR_YEARS is 25 (market/ingestion's backfill-window.ts, raised
  // from 15 by FR-23) —
  // floor is 1999-06-01. This service imports that constant, so its floor
  // moved with it; the cases below are the pre-existing ones at the new
  // boundary.

  it("rejects a tradeDate one day before the floor", async () => {
    const { service, fetchDailyRates } = serviceWithSpiedProvider(fixedClock);
    await expect(service.recordBuy({ ...validBuy, tradeDate: "1999-05-31" })).rejects.toThrow(
      TradeDateTooOldError,
    );
    expect(fetchDailyRates).not.toHaveBeenCalled();
  });

  it("rejects the same too-old tradeDate for every instrument-bearing write method", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    const tooOld = "1999-01-01";

    await expect(service.recordBuy({ ...validBuy, tradeDate: tooOld })).rejects.toThrow(
      TradeDateTooOldError,
    );
    await expect(service.recordSell({ ...validBuy, tradeDate: tooOld })).rejects.toThrow(
      TradeDateTooOldError,
    );
    await expect(
      service.recordDeposit({
        portfolioId: PORTFOLIO,
        tradeDate: tooOld,
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
      }),
    ).rejects.toThrow(TradeDateTooOldError);
    await expect(
      service.recordDividend({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: tooOld,
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
      }),
    ).rejects.toThrow(TradeDateTooOldError);
    await expect(
      service.recordCurrencyExchange({
        portfolioId: PORTFOLIO,
        tradeDate: tooOld,
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
        targetCurrency: "USD",
        targetCashAccountId: TARGET_CASH_ACCOUNT,
        exchangeRate: new Decimal("1.1"),
      }),
    ).rejects.toThrow(TradeDateTooOldError);
    await expect(
      service.recordSettledBuy({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: tooOld,
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: "00000000-0000-7000-8000-000000190099",
          amount: new Decimal("0.1"),
        },
      }),
    ).rejects.toThrow(TradeDateTooOldError);
  });

  it("passes the floor check (reaches FX resolution) for a tradeDate exactly on the floor and one day after it", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    // `txnCurrency: "USD"` against a EUR base — the resolver must actually
    // resolve a rate (`IMPLIED_BASE` would short-circuit for EUR regardless
    // of the floor check). Since AR-7 (ADR-0004) the resolution's
    // FIRST step is the local database read, so "the floor check passed" is
    // proven by the `ECONNREFUSED` from `UNREACHABLE_DB` — the same idiom the
    // editTransaction floor case below already uses — rather than by a
    // provider-port call the local step now precedes.
    for (const tradeDate of ["1999-06-01", "1999-06-02"]) {
      const error = await service
        .recordBuy({ ...validBuy, txnCurrency: "USD", tradeDate })
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TradeDateTooOldError);
      expect((error as Error).message).toMatch(/ECONNREFUSED/);
    }
  });

  it("without an injected clock, an ordinary recent tradeDate is unaffected (the real clock is used, and 2024-03-12 is always within 25 years for the lifetime of this suite)", async () => {
    const { service } = serviceWithSpiedProvider();
    const error = await service
      .recordBuy({ ...validBuy, txnCurrency: "USD" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    // AR-7 idiom (see the floor case above): resolution reached, guard silent.
    expect(error).not.toBeInstanceOf(TradeDateTooOldError);
    expect((error as Error).message).toMatch(/ECONNREFUSED/);
  });

  it("the error carries the offending tradeDate and the computed floor", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    await expect(service.recordBuy({ ...validBuy, tradeDate: "1990-01-01" })).rejects.toMatchObject(
      { tradeDate: "1990-01-01", floor: "1999-06-01" },
    );
  });

  /**
   * IR-4 (GATE-1 independent verification) — `editTransaction` is the
   * **seventh** `#assertTradeDate` call site and the only one this floor
   * suite did not exercise: the five `record*` cases above plus `recordBuy`
   * cover six, and the *ceiling* suite below has its own
   * "editTransaction rejects a tradeDate change past the ceiling too" case
   * while the floor had no counterpart. That asymmetry mattered once
   * FR-23 moved
   * `BACKFILL_FLOOR_YEARS` 15 -> 25, because this service imports that
   * constant: the range `editTransaction` accepts widened by ten years as a
   * side effect, at an entry point with no test on either side of the bound.
   *
   * Both directions are asserted, so the bound is pinned rather than merely
   * touched, and the "accepted" case proves it reached the database (the
   * `ECONNREFUSED` from `UNREACHABLE_DB`) rather than merely "not throwing
   * the one error we named" — the same idiom this file's other
   * "reaches the provider" assertions use.
   */
  it("editTransaction rejects a tradeDate change before the floor, and accepts one inside the ten-year band FR-23 opened", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    const edit = (tradeDate: string) =>
      service.editTransaction({
        id: "00000000-0000-7000-8000-000000190098",
        changes: { tradeDate },
        changedBy: "00000000-0000-7000-8000-000000190097",
      });

    // Exactly on the floor, and a date squarely inside the band the 15 -> 25
    // move opened (2005-01-01 was *rejected* under the old 2009-06-01 floor):
    // both must pass the guard and reach the database.
    for (const accepted of ["1999-06-01", "2005-01-01"]) {
      const error = await edit(accepted)
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TradeDateTooOldError);
      expect((error as Error).message).toMatch(/ECONNREFUSED/);
    }

    // One day before the floor: rejected, with the specific floor in the
    // error payload — not merely "something threw".
    await expect(edit("1999-05-31")).rejects.toThrow(TradeDateTooOldError);
    await expect(edit("1999-05-31")).rejects.toMatchObject({
      tradeDate: "1999-05-31",
      floor: "1999-06-01",
    });
  });
});

/**
 * F9 (security review, T-37): `#assertTradeDate` had a floor
 * but no ceiling — a future-dated `tradeDate` was accepted without limit.
 * Same "fixed injected Clock" technique as the floor suite above, so the
 * boundary itself is deterministic.
 */
describe("TransactionWriteService — trade-date ceiling (F9 security review, no DB required)", () => {
  const fixedClock: Clock = { now: () => new Date("2024-06-01T00:00:00.000Z") };
  // TRADE_DATE_CEILING_GRACE_DAYS is 1 — ceiling is 2024-06-02.

  it("rejects a tradeDate two days after today (past the 1-day grace)", async () => {
    const { service, fetchDailyRates } = serviceWithSpiedProvider(fixedClock);
    await expect(service.recordBuy({ ...validBuy, tradeDate: "2024-06-03" })).rejects.toThrow(
      TradeDateInFutureError,
    );
    expect(fetchDailyRates).not.toHaveBeenCalled();
  });

  it("rejects the same future tradeDate for every instrument-bearing write method", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    const tooFuture = "2099-01-01";

    await expect(service.recordBuy({ ...validBuy, tradeDate: tooFuture })).rejects.toThrow(
      TradeDateInFutureError,
    );
    await expect(service.recordSell({ ...validBuy, tradeDate: tooFuture })).rejects.toThrow(
      TradeDateInFutureError,
    );
    await expect(
      service.recordDeposit({
        portfolioId: PORTFOLIO,
        tradeDate: tooFuture,
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
      }),
    ).rejects.toThrow(TradeDateInFutureError);
    await expect(
      service.recordDividend({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: tooFuture,
        amount: new Decimal("10"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
      }),
    ).rejects.toThrow(TradeDateInFutureError);
    await expect(
      service.recordCurrencyExchange({
        portfolioId: PORTFOLIO,
        tradeDate: tooFuture,
        amount: new Decimal("100"),
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT,
        targetCurrency: "USD",
        targetCashAccountId: TARGET_CASH_ACCOUNT,
        exchangeRate: new Decimal("1.1"),
      }),
    ).rejects.toThrow(TradeDateInFutureError);
    await expect(
      service.recordSettledBuy({
        portfolioId: PORTFOLIO,
        instrumentId: INSTRUMENT,
        tradeDate: tooFuture,
        quantity: new Decimal("2"),
        settlement: {
          instrumentId: "00000000-0000-7000-8000-000000190099",
          amount: new Decimal("0.1"),
        },
      }),
    ).rejects.toThrow(TradeDateInFutureError);
  });

  it("passes the ceiling check (reaches FX resolution) for today and the 1-day grace date", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    // Same AR-7 note as the floor case: reaching resolution is proven by the
    // local step's `ECONNREFUSED`, not by a port call it now precedes.
    for (const tradeDate of ["2024-06-01", "2024-06-02"]) {
      const error = await service
        .recordBuy({ ...validBuy, txnCurrency: "USD", tradeDate })
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TradeDateInFutureError);
      expect((error as Error).message).toMatch(/ECONNREFUSED/);
    }
  });

  it("the error carries the offending tradeDate and the computed ceiling", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    await expect(service.recordBuy({ ...validBuy, tradeDate: "2030-01-01" })).rejects.toMatchObject(
      { tradeDate: "2030-01-01", ceiling: "2024-06-02" },
    );
  });

  it("editTransaction rejects a tradeDate change past the ceiling too", async () => {
    const { service } = serviceWithSpiedProvider(fixedClock);
    await expect(
      service.editTransaction({
        id: "00000000-0000-7000-8000-000000190098",
        changes: { tradeDate: "2099-01-01" },
        changedBy: "00000000-0000-7000-8000-000000190097",
      }),
    ).rejects.toThrow(TradeDateInFutureError);
  });
});

/**
 * T-35's deferred instrument-backfill trigger (T-37): pure
 * unit coverage that the trigger is a genuine no-op — never throws, never
 * required — when `instrumentBackfillScheduler` is not supplied. The
 * Postgres/pg-boss-backed proof that it actually enqueues when supplied lives
 * in `transaction-write-service.instrument-backfill.integration.test.ts`.
 */
describe("TransactionWriteService — instrument backfill trigger omitted (no DB required)", () => {
  it("recordBuy passes validation and reaches FX resolution with no instrumentBackfillScheduler configured (today's default) — the eventual DB-connection failure is unrelated", async () => {
    const { service } = serviceWithSpiedProvider();
    const error = await service
      .recordBuy({ ...validBuy, txnCurrency: "USD" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    // AR-7: resolution's first step is the local read — `ECONNREFUSED` from
    // `UNREACHABLE_DB` is what "reached FX resolution" looks like here.
    expect((error as Error).message).toMatch(/ECONNREFUSED/);
  });
});

/**
 * The acceptance criteria for named argument errors, asserted at the class level rather
 * than through nine call sites: the nine assertion sites throw a class this
 * codebase owns, and the one that already had a named error keeps it.
 *
 * This is the seam the mapper and the importer's allowlist both key on, and
 * neither of them can tell you it broke — `mapTransactionWriteError` would
 * quietly fall through to its 500, and `ROW_SAFE_LEDGER_ERRORS` would quietly
 * stop matching and emit the generic text.
 */
describe("the argument assertions throw a class this codebase owns", () => {
  it('`grep -c "throw new TypeError"` over the service is zero, and every assertion answers TransactionArgumentError', async () => {
    const { service } = serviceWithSpiedProvider();

    // One per assertion function, and one per inline check — the nine sites.
    const cases: readonly (readonly [string, Promise<unknown>])[] = [
      [
        "assertPositiveDecimal / not a Decimal",
        service.recordBuy({ ...validBuy, quantity: 10 as unknown as Decimal }),
      ],
      ["assertCurrency", service.recordBuy({ ...validBuy, txnCurrency: "usd" })],
      ["assertTradeDateShape", service.recordBuy({ ...validBuy, tradeDate: "12/03/2024" })],
      ["assertNonEmpty", service.recordBuy({ ...validBuy, portfolioId: "" })],
      [
        "editTransaction with nothing to change",
        service.editTransaction({
          id: PORTFOLIO,
          changes: {},
          changedBy: "00000000-0000-7000-8000-000000190097",
        }),
      ],
    ];

    for (const [label, attempt] of cases) {
      const caught: unknown = await attempt.then(() => undefined).catch((error: unknown) => error);
      expect(caught, `${label} threw nothing`).toBeInstanceOf(TransactionArgumentError);
      // Not the class it used to be: `TypeError` is what V8 also throws for a
      // property read on `undefined`, which is why it could never be
      // allow-listed and why these had to stop using it.
      expect(caught, `${label} still throws a bare TypeError`).not.toBeInstanceOf(TypeError);
      expect((caught as Error).message.length, `${label} threw an empty message`).toBeGreaterThan(
        0,
      );
    }
  });

  it("the non-positive case keeps its specialisation, its `field`, and therefore its own problem code", async () => {
    const { service } = serviceWithSpiedProvider();
    const caught: unknown = await service
      .recordBuy({ ...validBuy, quantity: new Decimal(0) })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Both, in this order: the specialisation the mapper's first branch reads,
    // and the base class the importer's allowlist and the mapper's second
    // branch read. If the inheritance were dropped, only the first would hold.
    expect(caught).toBeInstanceOf(TransactionAmountNotPositiveError);
    expect(caught).toBeInstanceOf(TransactionArgumentError);
    expect((caught as TransactionAmountNotPositiveError).field).toBe("quantity");
  });
});

/**
 * `cash-interest` AC-520 / F-A1 (I-11): a row's `kind` is not
 * editable at either layer. This is the type-level half — `pnpm typecheck`
 * fails if `TransactionEdit` ever names `kind` again, because the directive
 * below would then be unused. The HTTP half (`400
 * TRANSACTION_KIND_NOT_EDITABLE`) is in `api/src/transactions.e2e.test.ts`.
 */
describe("TransactionEdit — kind is not an editable field (cash-interest F-A1)", () => {
  it("an edit naming kind does not type-check", () => {
    // @ts-expect-error — `kind` is omitted from `TransactionEdit`.
    const edit: TransactionEdit = { kind: "DEPOSIT", note: "x" };
    expect(edit.note).toBe("x");
  });
});
