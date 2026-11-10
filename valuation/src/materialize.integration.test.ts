import {
  type MigratedPostgres,
  deferred,
  startMigratedPostgres,
  ensureCashAccount,
} from "@kerdial/platform-test-support";
import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import {
  computePmp,
  computeTwr,
  computeXirr,
  UnresolvablePriceError,
  valuePortfolio,
  type TwrFlow,
  type Valuation,
} from "@kerdial/core-domain";
import {
  createInstrumentByIsin,
  createPortfolio,
  deletePortfolio,
  loadPositionTimeline,
  recomputeAndInvalidate,
} from "@kerdial/ledger";
import {
  appUser,
  createDb,
  fxRateDaily,
  instrumentPriceDaily,
  instrumentQuoteLatest,
  manualPricePoint,
  marketDataEpoch,
  portfolioDailyValuation,
  tenant,
  transaction,
  transactionPosting,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq, gte, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCashDailyNets } from "./cash-balances.js";
import { loadExistingValuationRows } from "./existing-valuation-rows.js";
import { materializePortfolioValuations } from "./materialize.js";
import { loadPricingSeries } from "./pricing-series.js";

/**
 * `loadPositionTimeline` is the one call `materializePortfolioValuations`
 * makes that this file's "concurrent-write race" describe (below) needs a
 * controllable pause point after, to deterministically reproduce the T-30
 * fix-up's race: a write's `recomputeAndInvalidate` landing after this
 * function's timeline load but before its `calc_epoch` re-check/`INSERT`.
 * Every other named export of `@kerdial/ledger` this file uses
 * (`createInstrumentByIsin`, `createPortfolio`, `recomputeAndInvalidate`)
 * passes straight through unmodified — only `loadPositionTimeline` is
 * wrapped, and only actually pauses when a test arms it with
 * `mockImplementationOnce` below; every other call (including every other
 * describe in this file) behaves exactly as the unmocked function would.
 */
vi.mock("@kerdial/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kerdial/ledger")>();
  return { ...actual, loadPositionTimeline: vi.fn(actual.loadPositionTimeline) };
});

/**
 * Finding 2 (security review, F-1-completion round) — the same
 * spy-wrapping treatment as `loadPositionTimeline` above, for this file's own
 * "prefix synthesis skips the engine entirely" describe below: a call count
 * is the only way to prove `loadPricingSeries` genuinely never ran (or never
 * ran *again*), rather than merely asserting the response looked right, which
 * a bug that recomputed-but-happened-to-produce-the-same-answer would not
 * catch.
 */
vi.mock("./pricing-series.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pricing-series.js")>();
  return { ...actual, loadPricingSeries: vi.fn(actual.loadPricingSeries) };
});

/**
 * Finding 4 (security review, LOW, coupled to finding 2) — this file's
 * own describe below needs a controllable pause point strictly between
 * `attemptMaterialize`'s "which engine dates already exist" read and its
 * `calc_epoch` `FOR UPDATE` re-check: neither `loadPositionTimeline` nor
 * `loadPricingSeries` (the two seams above) run at all on the "nothing
 * missing" path that race targets. See `./existing-valuation-rows.js`'s own
 * doc comment for why this read was factored out into its own module in the
 * first place.
 */
vi.mock("./existing-valuation-rows.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./existing-valuation-rows.js")>();
  return { ...actual, loadExistingValuationRows: vi.fn(actual.loadExistingValuationRows) };
});

/** A `{ promise, resolve }` pair for coordinating two async steps deterministically — no wall-clock timing. */

/**
 * T-30 acceptance — `valuation`'s read-path half: `portfolio_daily_valuation`
 * is materialised lazily on read, and a read
 * immediately after an edit reflects the recomputed figures with no
 * manual cache-clear step (AC3). Against a real Postgres 17 container,
 * authenticated as `app_web`.
 *
 * ## Why this file writes `transaction` rows directly, not via `TransactionWriteService`
 *
 * `valuation` must never import `market/ports` — not even in a test file
 * outside `__tests__`/`__fixtures__`, which the dependency-cruiser exclusion
 * does not cover (see `.dependency-cruiser.cjs`) — so this file cannot
 * construct an `FxRateResolver` (its `provider: FxRateProvider` parameter is
 * a `market/ports` type). The write-path proof that `TransactionWriteService`
 * itself correctly wires postings → recompute → invalidation lives in
 * `ledger/src/materialization.integration.test.ts`, which *can* import
 * `market/ports`. This file writes `transaction` rows directly (EUR trades,
 * `fx_rate = 1` / `IMPLIED_BASE` — no FX resolution needed) and calls
 * `recomputeAndInvalidate` (`@kerdial/ledger`, exported from the same
 * `materialization.ts` `TransactionWriteService` itself calls) directly —
 * the identical function, not a re-implementation — so the recompute/
 * invalidation behaviour under test is exactly what production runs. Only
 * the posting-expansion step (T-21, already proven elsewhere) is skipped,
 * since it is irrelevant to `portfolio_daily_valuation`/TWR/MWR, which read
 * from `holding_state` and the `transaction` table, never from
 * `transaction_posting`.
 */
/**
 * A tight relative-tolerance comparison for a hand-calculated repeating
 * decimal against a value `computeTwr` produced via a different arithmetic
 * path (see the call sites below) — 1e-12 relative, vastly tighter than the
 * known-answer suite's own 0.01% AC_TOLERANCE, since this is a rounding
 * artefact of significant-digit precision, not a hand-calculation check.
 */
function closeTo(actual: Decimal, expected: Decimal): boolean {
  if (expected.isZero()) return actual.abs().lessThan("1e-12");
  return actual.minus(expected).abs().dividedBy(expected.abs()).lessThan("1e-12");
}

describe("valuation — T-30 read-path materialisation (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  /**
   * A second, independent `app_web` connection (its own physical socket,
   * not sharing `appWebSql`'s single-connection pool) — only the
   * "concurrent-write race" describe below uses it, to run a genuinely
   * concurrent write against the same tenant/portfolio while
   * `materializePortfolioValuations`'s call on `appWebDb` is deliberately
   * paused mid-transaction. Reusing `appWebSql` (`max: 1`) for that write
   * would deadlock: its single physical connection is held by the paused
   * transaction until the write itself unblocks it.
   */
  let appWebSql2: postgres.Sql;
  let appWebDb2: Db;

  const tenantId = "00000000-0000-7000-8000-000000310001";
  /** P-2 (portfolio-crud-ui): `deletePortfolio`'s own `deletedBy`, only this file's own vanished-portfolio describe below needs one. */
  const userId = "00000000-0000-7000-8000-000000310002";

  let shareA: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    appWebSql2 = postgres(pg.appWebUri, { max: 1 });
    appWebDb2 = createDb(appWebSql2);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(appUser).values({
      id: userId,
      tenantId,
      email: "t30-p2@valuation-test.example",
      passwordHash: "argon2id$x",
    });

    shareA = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        // IR-22 — a **synthetic** ISIN, not a real listing. Migration `0037` seeds the
        // real large-cap identifiers into the shared catalogue, so a fixture reusing one
        // collides with the seeded row on `instrument_isin_exchange_mic_key`. The `TEST`
        // NSIN keeps the ISO 6166 check digit valid and can never be a real identifier.
        isin: "FRTEST000461",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-30 valuation share",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appWebSql2?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /** A minimal, directly-inserted EUR BUY or DEPOSIT row — see this file's header for why. */
  async function insertEurTransaction(
    row: {
      id: string;
      portfolioId: string;
      kind: "BUY" | "DEPOSIT";
      tradeDate: string;
      seq: bigint;
      instrumentId?: string;
      quantity?: Decimal;
      unitPrice?: Decimal;
      grossAmount: Decimal;
    },
    db: Db = appWebDb,
  ): Promise<void> {
    await withTenant(db, tenantId, async (tx) => {
      // CA-9/`0039`: a fiat-settled row names the cash account its money
      // moved through.
      const cashAccountId = await ensureCashAccount(tx, tenantId, row.portfolioId, "EUR");
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: row.id,
        tenantId,
        portfolioId: row.portfolioId,
        kind: row.kind,
        tradeDate: row.tradeDate,
        seq: row.seq,
        instrumentId: row.instrumentId ?? null,
        quantity: row.quantity ?? null,
        unitPrice: row.unitPrice ?? null,
        grossAmount: row.grossAmount,
        txnCurrency: "EUR",
        cashAccountId,
        // `0046`: a fiat principal leg carries its own denomination, and the
        // degenerate case mirrors the trade's (`transaction_fiat_principal_has_cash_currency`,
        // `transaction_cash_degenerate_equals_gross`).
        cashCurrency: "EUR",
        cashAmount: row.grossAmount,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
    });
  }

  async function invalidate(
    portfolioId: string,
    minTradeDate: string,
    db: Db = appWebDb,
  ): Promise<void> {
    await withTenant(db, tenantId, async (tx) => {
      await recomputeAndInvalidate(tx, { tenantId, portfolioId, minTradeDate });
    });
  }

  async function seedPrice(instrumentId: string, priceDate: string, close: string): Promise<void> {
    await withTenant(appWebDb, tenantId, async (tx) => {
      await tx.insert(manualPricePoint).values({
        tenantId,
        instrumentId,
        priceDate,
        close: new Decimal(close),
        currency: "EUR",
      });
    });
  }

  async function valuationRowsInRange(portfolioId: string, from: string) {
    return withTenant(appWebDb, tenantId, async (tx) =>
      tx
        .select()
        .from(portfolioDailyValuation)
        .where(
          and(
            eq(portfolioDailyValuation.tenantId, tenantId),
            eq(portfolioDailyValuation.portfolioId, portfolioId),
            gte(portfolioDailyValuation.valuationDate, from),
          ),
        ),
    );
  }

  describe("AC3 — read before edit, edit, read again: never a cached pre-edit value", () => {
    it("materialises portfolio_daily_valuation lazily, and TWR/MWR reflect the edit with no manual cache-clear step", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "AC3" })).id;
      const buyId = randomUUID();

      await insertEurTransaction({
        id: buyId,
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-01-10",
        seq: 1n,
        instrumentId: shareA,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "DEPOSIT",
        tradeDate: "2024-01-12",
        seq: 2n,
        grossAmount: new Decimal("200"),
      });
      // The invalidation steps, called directly (see header) — the same function
      // every TransactionWriteService write method calls.
      await invalidate(p, "2024-01-10");

      await seedPrice(shareA, "2024-01-10", "100");
      await seedPrice(shareA, "2024-01-15", "120");
      await seedPrice(shareA, "2024-04-20", "130");

      const fromDate = "2024-01-11";
      const toDate = "2024-04-20";

      // --- READ BEFORE the edit -------------------------------------------
      // Nothing materialised yet: this call is the lazy materialisation.
      expect(await valuationRowsInRange(p, fromDate)).toHaveLength(0);
      const before = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate,
        toDate,
      });
      // Every calendar date in [fromDate, toDate], not just trading days.
      expect(before).toHaveLength(101);
      expect(await valuationRowsInRange(p, fromDate)).toHaveLength(101);

      const seriesFor = (rows: typeof before): Valuation[] =>
        rows.map((r) => ({ date: r.valuationDate, value: r.totalValueBase }));
      const flows: TwrFlow[] = [
        { date: "2024-01-12", amount: new Decimal("200"), flowClass: "EXTERNAL" },
      ];

      const byDate = new Map(before.map((r) => [r.valuationDate, r.totalValueBase]));
      // Hand-calculated (10 units, price LOCF from 2024-01-10 = 100 EUR):
      expect(byDate.get("2024-01-11")!.toString()).toBe("1000");
      expect(byDate.get("2024-04-20")!.toString()).toBe("1300"); // 10 * 130

      const twrBefore = computeTwr(seriesFor(before), flows);
      // r1 = 1000/1000 - 1 = 0; r2 = 1300/(1000+200) - 1 = 1/12.
      // cumulative = (1)*(13/12) - 1 = 1/12. A repeating decimal computed via
      // a different arithmetic path (1300/1200 - 1, inside computeTwr) than
      // the direct 1/12 below rounds to a handful fewer significant digits
      // at the configured 34-sig-fig precision (the magnitude differs before
      // the final `-1`), so this compares within a tight relative tolerance
      // rather than by exact `Decimal#equals` — the same reason the
      // known-answer suite (T-29) uses `withinTolerance`, not exact equality,
      // for hand-calculated repeating-decimal comparisons.
      expect(closeTo(twrBefore.cumulative, new Decimal(1).dividedBy(12))).toBe(true);

      const xirrBefore = computeXirr(
        [
          { date: fromDate, amount: byDate.get(fromDate)!.negated() },
          { date: "2024-01-12", amount: new Decimal("-200") },
        ],
        { date: toDate, value: byDate.get(toDate)! },
      );
      expect(xirrBefore.converged).toBe(true);

      // --- THE EDIT: quantity 10 -> 25 (same buy, same price/date) --------
      await withTenant(appWebDb, tenantId, async (tx) => {
        await tx
          .update(transaction)
          // `0046`: `cash_amount` moves with `gross_amount` in the degenerate
          // case (`transaction_cash_degenerate_equals_gross`). This raw
          // `UPDATE` bypasses `editTransaction`, which mirrors them for its
          // own callers, so it has to spell the mirror out.
          .set({
            quantity: new Decimal("25"),
            grossAmount: new Decimal("2500"),
            cashAmount: new Decimal("2500"),
          })
          .where(and(eq(transaction.tenantId, tenantId), eq(transaction.id, buyId)));
      });
      // The invalidation steps again — min(old.trade_date, new.trade_date), both
      // 2024-01-10 here (only quantity changed).
      await invalidate(p, "2024-01-10");

      // The stale rows are *gone*, not recomputed synchronously — proving
      // the invalidation is deletion, not recomputation.
      expect(await valuationRowsInRange(p, fromDate)).toHaveLength(0);

      // --- READ AGAIN, same request/session, no cache-clear call ----------
      const after = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate,
        toDate,
      });
      expect(after).toHaveLength(101);

      const byDateAfter = new Map(after.map((r) => [r.valuationDate, r.totalValueBase]));
      expect(byDateAfter.get("2024-01-11")!.toString()).toBe("2500"); // 25 * 100
      expect(byDateAfter.get("2024-04-20")!.toString()).toBe("3250"); // 25 * 130
      // Never the cached pre-edit value.
      expect(byDateAfter.get("2024-01-11")!.equals(byDate.get("2024-01-11")!)).toBe(false);

      const twrAfter = computeTwr(seriesFor(after), flows);
      // r1 = 2500/2500 - 1 = 0; r2 = 3250/(2500+200) - 1 = 11/54.
      expect(closeTo(twrAfter.cumulative, new Decimal(11).dividedBy(54))).toBe(true);
      expect(twrAfter.cumulative.equals(twrBefore.cumulative)).toBe(false);

      const xirrAfter = computeXirr(
        [
          { date: fromDate, amount: byDateAfter.get(fromDate)!.negated() },
          { date: "2024-01-12", amount: new Decimal("-200") },
        ],
        { date: toDate, value: byDateAfter.get(toDate)! },
      );
      expect(xirrAfter.converged).toBe(true);
      if (xirrBefore.converged && xirrAfter.converged) {
        expect(xirrAfter.rate.equals(xirrBefore.rate)).toBe(false);
      }
    });
  });

  describe("materialisation is lazy: an already-materialised range is not rewritten", () => {
    it("does not touch existing rows on a second read of the same range", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "lazy" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-02-01",
        // `seq` is unique per *tenant* (migration 0013), not per portfolio —
        // this file shares one tenant across describes, so seq 1n/2n are
        // already taken by the AC3 describe above.
        seq: 100n,
        instrumentId: shareA,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("50"),
        grossAmount: new Decimal("50"),
      });
      await invalidate(p, "2024-02-01");
      await seedPrice(shareA, "2024-02-01", "50");

      const params = { tenantId, portfolioId: p, fromDate: "2024-02-02", toDate: "2024-02-04" };
      const first = await materializePortfolioValuations(appWebDb, params);
      expect(first).toHaveLength(3);
      const materializedAtFirst = first.map((r) => r.materializedAt.getTime()).sort();

      const second = await materializePortfolioValuations(appWebDb, params);
      expect(second).toHaveLength(3);
      const materializedAtSecond = second.map((r) => r.materializedAt.getTime()).sort();
      // Same rows, not re-inserted/re-timestamped — nothing was missing.
      expect(materializedAtSecond).toEqual(materializedAtFirst);
    });
  });

  describe("a range before the epoch floor is rejected, never persisted", () => {
    it("rejects a fromDate before 2000-01-01 and persists no rows for it", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "h1-epoch-floor" })).id;

      // Red-confirm target: before the fix, a request sweeping an ancient
      // range (this exploit's "years 0001-9999" sweep) would materialise and
      // persist one permanent, never-invalidated row per date in range —
      // this asserts both the rejection itself and that nothing was written.
      await expect(
        materializePortfolioValuations(appWebDb, {
          tenantId,
          portfolioId: p,
          fromDate: "0001-01-01",
          toDate: "0001-01-03",
        }),
      ).rejects.toThrow(/must not be before 2000-01-01/);

      const rows = await valuationRowsInRange(p, "0001-01-01");
      expect(rows).toHaveLength(0);
    });

    it("accepts a range starting exactly on the epoch floor", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "h1-epoch-floor-ok" })).id;
      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2000-01-01",
        toDate: "2000-01-02",
      });
      expect(rows).toHaveLength(2);
    });
  });

  // M2 (security review): the in-flight de-duplication itself
  // (`materializePortfolioValuations`'s `inFlightByKey` map) is proven at the
  // unit level, not here — `materialize-dedupe.test.ts`, in this same
  // directory. A Testcontainers-level attempt at this proof (an earlier
  // draft of this file) turned out to be unreliable: real DB round-trip
  // timing meant the "second" call could reach its own missing-dates check
  // either before or after the first call had already committed, depending
  // on real query latency — sometimes passing for the wrong reason (the
  // range was simply already materialised by the time it looked) regardless
  // of whether the de-dupe fix was present. Controlling `withTenant` itself
  // (mocked, no real DB) removes that timing dependency entirely and is the
  // deterministic version of this same proof.

  describe("concurrent-write race — the calc_epoch version guard (T-30)", () => {
    it("never persists a value computed before a concurrent write invalidated it mid-materialisation", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "race-guard" })).id;

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-05-01",
        seq: 200n,
        instrumentId: shareA,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await invalidate(p, "2024-05-01");
      await seedPrice(shareA, "2024-05-01", "100");

      const fromDate = "2024-05-02";
      const toDate = "2024-05-05";

      // Deterministically reproduce the race this fix-up closes: pause the
      // read's first attempt immediately *after* it has loaded the position
      // timeline (so its in-flight computation is already committed to the
      // pre-write data) but *before* it re-checks `calc_epoch`/inserts —
      // exactly the window the bug report describes, driven by an explicit
      // gate rather than real concurrency/timing (see this file's header).
      const timelineLoaded = deferred<void>();
      const releaseTimeline = deferred<void>();
      const actualLoadPositionTimeline = (
        await vi.importActual<typeof import("@kerdial/ledger")>("@kerdial/ledger")
      ).loadPositionTimeline;

      vi.mocked(loadPositionTimeline).mockImplementationOnce(async (...args) => {
        const result = await actualLoadPositionTimeline(...args);
        timelineLoaded.resolve();
        await releaseTimeline.promise;
        return result;
      });

      const materializePromise = materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate,
        toDate,
      });

      // Wait until the read's first attempt has loaded its (about-to-be-
      // stale) timeline before landing the concurrent write — the same
      // "DELETE finds nothing, because the row doesn't exist yet" window
      // the bug report describes.
      await timelineLoaded.promise;

      // On `appWebDb2` — a separate physical connection (see this file's
      // `appWebSql2` header) — so this genuinely runs concurrently with the
      // paused `materializePortfolioValuations` call above rather than
      // deadlocking behind it on `appWebDb`'s single-connection pool.
      await insertEurTransaction(
        {
          id: randomUUID(),
          portfolioId: p,
          kind: "BUY",
          tradeDate: "2024-05-01",
          seq: 201n,
          instrumentId: shareA,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("100"),
          grossAmount: new Decimal("500"),
        },
        appWebDb2,
      );
      // Same `recomputeAndInvalidate` every `TransactionWriteService` write
      // method calls (see this file's header) — commits, increments
      // `calc_epoch`, and deletes every valuation on/after 2024-05-01, which
      // is a no-op for `fromDate..toDate` here precisely because nothing has
      // been materialised for those dates yet.
      await invalidate(p, "2024-05-01", appWebDb2);

      // Let the paused first attempt continue: its stale, pre-write
      // computation (10 units @ 100 = 1000) is what a version-guard-free
      // implementation would persist.
      releaseTimeline.resolve();

      const rows = await materializePromise;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        // 15 units @ 100 — the post-write state (10 + 5, both trade-dated
        // on/before every date in the range). Never 1000 (10 * 100), the
        // stale figure the raced first attempt actually computed — proving
        // the `calc_epoch` guard detected the race and either retried
        // against fresh data or discarded the stale computation.
        expect(row.totalValueBase.toString()).toBe("1500");
      }

      // And nothing stale reached the table itself — not just the in-memory
      // return value.
      const persisted = await valuationRowsInRange(p, fromDate);
      expect(persisted).toHaveLength(4);
      for (const row of persisted) {
        expect(row.totalValueBase.toString()).toBe("1500");
      }
    });

    /**
     * QE regression (read/write split tester pass) — the test above always lands the
     * concurrent write's `recomputeAndInvalidate` fully committed *before* the
     * paused attempt is released, so `attemptMaterializeWrite`'s re-check
     * observes an already-committed epoch change. Under READ COMMITTED, a
     * plain re-`SELECT` (no `.for("update")`) would observe that too — so
     * that test alone cannot tell a genuinely race-free `FOR UPDATE` re-check
     * apart from a plain re-`SELECT` that merely happens to run after the
     * write commits. Mutation-tested: replacing `.for("update")` with a plain
     * `.select(...)` in `attemptMaterializeWrite` passes the test above
     * unchanged but fails this one (both the "still blocked" assertion and
     * the final "1500" value — the plain-select mutant persists the stale
     * "1000" figure instead, permanently, since the writer's own `DELETE`
     * already ran, on nothing, before this attempt's `INSERT` created the row
     * it should have invalidated).
     *
     * This test keeps the writer's own `recomputeAndInvalidate` transaction
     * open (uncommitted) across the exact moment the re-check statement is
     * dispatched, by holding it on a `deferred` instead of letting `withTenant`
     * commit it immediately — the same "concurrently in-flight" scenario
     * `attemptMaterializeWrite`'s own comment on `.for("update")` describes.
     */
    it("FOR UPDATE — not a plain re-SELECT — is what makes the re-check race-free: it blocks on a concurrent write's still-open transaction instead of racing past it", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "race-guard-for-update" })).id;

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-06-01",
        seq: 210n,
        instrumentId: shareA,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await invalidate(p, "2024-06-01");
      await seedPrice(shareA, "2024-06-01", "100");

      const fromDate = "2024-06-02";
      const toDate = "2024-06-05";

      // Same pause seam as the "concurrent-write race" test above: paused
      // right after the read attempt has loaded its (about-to-be-stale)
      // timeline, still inside phase A's transaction.
      const timelineLoaded = deferred<void>();
      const releaseTimeline = deferred<void>();
      const actualLoadPositionTimeline = (
        await vi.importActual<typeof import("@kerdial/ledger")>("@kerdial/ledger")
      ).loadPositionTimeline;
      vi.mocked(loadPositionTimeline).mockImplementationOnce(async (...args) => {
        const result = await actualLoadPositionTimeline(...args);
        timelineLoaded.resolve();
        await releaseTimeline.promise;
        return result;
      });

      const materializePromise = materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate,
        toDate,
      });
      await timelineLoaded.promise;

      // The new trade itself, fully committed — only the epoch-bumping
      // `recomputeAndInvalidate` transaction below is held open.
      await insertEurTransaction(
        {
          id: randomUUID(),
          portfolioId: p,
          kind: "BUY",
          tradeDate: "2024-06-01",
          seq: 211n,
          instrumentId: shareA,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("100"),
          grossAmount: new Decimal("500"),
        },
        appWebDb2,
      );

      // The writer's `recomputeAndInvalidate` (calc_epoch bump + the delete
      // of every `portfolio_daily_valuation` row on/after `minTradeDate`)
      // deliberately held open — not committed — via its own `deferred`,
      // rather than letting `withTenant` commit it immediately as `invalidate`
      // above does.
      const writerUpdateExecuted = deferred<void>();
      const releaseWriter = deferred<void>();
      const writerPromise = withTenant(appWebDb2, tenantId, async (tx) => {
        await recomputeAndInvalidate(tx, {
          tenantId,
          portfolioId: p,
          minTradeDate: "2024-06-01",
        });
        writerUpdateExecuted.resolve();
        await releaseWriter.promise;
      });
      await writerUpdateExecuted.promise;

      // Let the paused read attempt continue: phase A commits, the (pure,
      // synchronous) compute step runs, and phase C dispatches its
      // `calc_epoch` re-check while the writer's transaction above is still
      // open.
      releaseTimeline.resolve();

      let materializeSettled = false;
      materializePromise.then(
        () => {
          materializeSettled = true;
        },
        () => {
          materializeSettled = true;
        },
      );

      // Give the re-check statement time to reach Postgres. With `FOR UPDATE`
      // it takes the same row lock the writer's own `UPDATE` above still
      // holds, and genuinely blocks indefinitely until `releaseWriter` fires
      // below — there is no clock this half of the assertion is racing for a
      // correct implementation. The margin only matters for a *mutant* (a
      // plain `.select()` instead of `.for("update")`, which does not block
      // and could complete within a too-short window on a loaded CI runner):
      // 750ms is generous headroom over the ~350ms measured wall time for
      // this whole test. The `"1500"` value assertions below are the
      // timing-independent backstop either way.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(materializeSettled).toBe(false);

      releaseWriter.resolve();
      await writerPromise;

      const rows = await materializePromise;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        // 15 units @ 100 — the post-write state. A plain re-`SELECT` mutant
        // would have already raced past the still-open writer transaction
        // above (observing the pre-write, not-yet-bumped epoch) and
        // persisted "1000" here, permanently — see this test's own header.
        expect(row.totalValueBase.toString()).toBe("1500");
      }

      const persisted = await valuationRowsInRange(p, fromDate);
      expect(persisted).toHaveLength(4);
      for (const row of persisted) {
        expect(row.totalValueBase.toString()).toBe("1500");
      }
    });
  });

  /**
   * The bounded-retries-exhausted fallback (`attemptMaterialize`'s
   * `persist: false` branch) had no test: only verified by reading the code
   * that it correctly skips the write phase. This forces every one of
   * {@link MAX_GUARDED_ATTEMPTS}'s three guarded attempts to observe a stale
   * epoch by re-bumping `calc_epoch` (via `appWebDb2` — a no-op
   * `recomputeAndInvalidate`, no new trade, so the timeline itself never
   * changes) right after each attempt's `loadPositionTimeline` call, before
   * that attempt's own `calc_epoch` re-check can observe the pre-bump value.
   * `MAX_GUARDED_ATTEMPTS` is not exported (this file's header convention for
   * such constants: a separately-declared value kept in sync by hand) — the
   * call-count assertion below is what proves 3 guarded attempts plus the
   * fallback actually ran, not merely that a plausible result came back.
   */
  describe("bounded-retries-exhausted fallback", () => {
    it("after every guarded attempt races, returns the full correct row set but persists nothing", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "fallback-exhausted" })).id;

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-07-01",
        seq: 220n,
        instrumentId: shareA,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await invalidate(p, "2024-07-01");
      await seedPrice(shareA, "2024-07-01", "100");

      const fromDate = "2024-07-02";
      const toDate = "2024-07-05";

      const actualLoadPositionTimeline = (
        await vi.importActual<typeof import("@kerdial/ledger")>("@kerdial/ledger")
      ).loadPositionTimeline;

      vi.mocked(loadPositionTimeline).mockClear();
      vi.mocked(loadPositionTimeline).mockImplementation(async (...args) => {
        const result = await actualLoadPositionTimeline(...args);
        // On `appWebDb2`, not `appWebDb`: the attempt's own read transaction
        // is still open on `appWebDb`'s single-connection pool at this point.
        await invalidate(p, "2024-07-01", appWebDb2);
        return result;
      });

      try {
        const rows = await materializePortfolioValuations(appWebDb, {
          tenantId,
          portfolioId: p,
          fromDate,
          toDate,
        });

        // No bump ever changes the timeline (no new trade), so the contract
        // — a full, correctly-computed row set — holds regardless of how many
        // guarded attempts raced before the fallback served this result.
        expect(rows).toHaveLength(4);
        for (const row of rows) {
          expect(row.totalValueBase.toString()).toBe("1000");
        }

        // 3 guarded attempts + the final unpersisted fallback attempt — proof
        // the fallback path actually ran, not one lucky retry.
        expect(vi.mocked(loadPositionTimeline).mock.calls.length).toBe(4);

        // And nothing reached the table: every guarded attempt discarded its
        // own stale computation, and the fallback attempt never writes.
        const persisted = await valuationRowsInRange(p, fromDate);
        expect(persisted).toHaveLength(0);
      } finally {
        vi.mocked(loadPositionTimeline).mockImplementation(actualLoadPositionTimeline);
      }
    });
  });

  // -------------------------------------------------------------------------
  // B1 (`self-hosted-deploy`, SH-3): the read path is
  // now market-epoch-aware. `recomputeAndInvalidate` deletes rows only on a
  // *transaction* write, so before this guard a row materialised from LOCF'd
  // (yesterday's) data stayed frozen at that value forever once the day's
  // actual close landed — AC23's "no stale figures, ever".
  //
  // Everything below prices through `instrument_price_daily` only (its own
  // instrument, `shareEpoch`, with no `manual_price_point` rows at all) so
  // the figures under test are unambiguous known answers rather than a
  // MANUAL-vs-DAILY precedence question.
  //
  // This describe also absorbed the SH-4 release gate's valuation half
  // (`materialize.sh4-gate.integration.test.ts`, deleted after the gate
  // passed), whose headline/FX/gap-repair/no-needless-rebuild scenarios were
  // already asserted here; its four additive cases are marked where they
  // landed.
  // -------------------------------------------------------------------------
  describe("market-data epoch — B1's invalidation contract (SH-3)", () => {
    /** Simulates a market-data job's write: `app_web` holds no INSERT on `instrument_price_daily` (it is the ingestion worker's table), so this runs as the owner, exactly as the real writer's own role would. */
    async function seedDailyClose(
      instrumentId: string,
      priceDate: string,
      close: string,
    ): Promise<void> {
      await ownerDb
        .insert(instrumentPriceDaily)
        .values({
          instrumentId,
          priceDate,
          closeRaw: new Decimal(close),
          currency: "EUR",
          sourceKey: "b1-test-provider",
          quality: "EOD",
        })
        .onConflictDoUpdate({
          target: [instrumentPriceDaily.instrumentId, instrumentPriceDaily.priceDate],
          set: { closeRaw: sql`excluded.close_raw` },
        });
    }

    /** The exact statement `market/ingestion`'s `bumpMarketDataEpoch` issues (that package is not importable from `valuation`, and must not be). */
    async function bumpMarketEpoch(): Promise<void> {
      await ownerDb
        .update(marketDataEpoch)
        .set({ epoch: sql`${marketDataEpoch.epoch} + 1`, updatedAt: new Date() })
        .where(eq(marketDataEpoch.id, 1));
    }

    async function currentMarketEpoch(): Promise<bigint> {
      const [row] = await ownerDb.select({ epoch: marketDataEpoch.epoch }).from(marketDataEpoch);
      return row!.epoch;
    }

    let shareEpoch: string;

    beforeAll(async () => {
      shareEpoch = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000479",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 market-epoch share",
        })
      ).id;
    }, 60_000);

    async function portfolioHolding(name: string, tradeDate: string, seq: bigint): Promise<string> {
      const p = (await createPortfolio(appWebDb, { tenantId, name })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate,
        seq,
        instrumentId: shareEpoch,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await invalidate(p, tradeDate);
      return p;
    }

    it("THE HEADLINE SCENARIO: a LOCF'd row is rebuilt after a price for that very date is written and the epoch is bumped", async () => {
      const p = await portfolioHolding("b1-headline", "2024-09-02", 700n);
      await seedDailyClose(shareEpoch, "2024-09-02", "100");

      // 10:00 — the owner opens the app. No close exists for 09-03 yet, so
      // the materialiser LOCFs 09-02's 100.00: 10 * 100 = 1000.
      const morning = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-09-03",
        toDate: "2024-09-03",
      });
      expect(morning).toHaveLength(1);
      expect(morning[0]!.totalValueBase.toString()).toBe("1000");

      // 22:00 — the EOD-close job writes the day's actual close and bumps
      // the epoch (in that order: `bumpMarketDataEpoch`'s ordering rule).
      await seedDailyClose(shareEpoch, "2024-09-03", "130");
      await bumpMarketEpoch();

      // The next read. Before this fix the cached row existed, so the read
      // took its fast path and returned 1000 — forever, for every future
      // read of that date, with nothing that would ever invalidate it.
      const evening = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-09-03",
        toDate: "2024-09-03",
      });
      expect(evening[0]!.totalValueBase.toString()).toBe("1300");

      // And the *stored* row was rebuilt and re-stamped — not merely the
      // returned value corrected in memory, which would leave the table
      // stale and rebuild on every subsequent read forever.
      const persisted = await valuationRowsInRange(p, "2024-09-03");
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.totalValueBase.toString()).toBe("1300");
      expect(persisted[0]!.marketEpoch).toBe(await currentMarketEpoch());
    });

    it("an FX write's bump invalidates just the same — the counter is coarse and shared, not price-specific", async () => {
      const p = await portfolioHolding("b1-fx-write", "2024-09-10", 701n);
      await seedDailyClose(shareEpoch, "2024-09-10", "100");

      const first = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-09-11",
        toDate: "2024-09-11",
      });
      expect(first[0]!.totalValueBase.toString()).toBe("1000");
      const firstMaterializedAt = first[0]!.materializedAt.getTime();

      // An `fx_rate_daily` run bumps the same shared counter. Nothing about
      // this portfolio's own prices changed, so the rebuilt figure is
      // identical — what this proves is that the rebuild *happened*, which
      // is what makes the guard indifferent to which market-data table was
      // written (the epoch's deliberate coarseness).
      await seedDailyClose(shareEpoch, "2024-09-11", "115");
      await bumpMarketEpoch();

      const second = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-09-11",
        toDate: "2024-09-11",
      });
      expect(second[0]!.totalValueBase.toString()).toBe("1150");
      expect(second[0]!.materializedAt.getTime()).toBeGreaterThanOrEqual(firstMaterializedAt);
    });

    it("a pre-existing row (market_epoch defaulted to 0, as every row written before this migration is) self-heals on the first read after deploy", async () => {
      const p = await portfolioHolding("b1-self-heal", "2024-09-20", 702n);
      await seedDailyClose(shareEpoch, "2024-09-20", "100");
      // Guarantee the current epoch is strictly above 0, as it is on any
      // database where the ingestion jobs have ever run.
      await bumpMarketEpoch();

      // A row exactly as `ADD COLUMN market_epoch bigint NOT NULL DEFAULT 0`
      // leaves every pre-deploy row: stamped 0, and — the point of the
      // exercise — holding a value recomputation would not produce.
      await ownerDb.insert(portfolioDailyValuation).values({
        tenantId,
        portfolioId: p,
        valuationDate: "2024-09-21",
        totalValueBase: new Decimal("999999"),
        marketEpoch: 0n,
      });

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-09-21",
        toDate: "2024-09-21",
      });
      expect(rows[0]!.totalValueBase.toString()).toBe("1000");

      const persisted = await valuationRowsInRange(p, "2024-09-21");
      expect(persisted[0]!.totalValueBase.toString()).toBe("1000");
      expect(persisted[0]!.marketEpoch).toBe(await currentMarketEpoch());
    });

    it("without a bump, an already-materialised range is still NOT rewritten — the guard invalidates on market-data writes, it does not disable the cache", async () => {
      const p = await portfolioHolding("b1-no-needless-rebuild", "2024-09-25", 703n);
      await seedDailyClose(shareEpoch, "2024-09-25", "100");

      const params = { tenantId, portfolioId: p, fromDate: "2024-09-26", toDate: "2024-09-28" };
      const first = await materializePortfolioValuations(appWebDb, params);
      const materializedAtFirst = first.map((r) => r.materializedAt.getTime()).sort();

      const second = await materializePortfolioValuations(appWebDb, params);
      expect(second.map((r) => r.materializedAt.getTime()).sort()).toEqual(materializedAtFirst);
    });

    it("a market-data write landing mid-computation leaves a row stamped with the OLDER epoch, which the next read rebuilds — never a permanently-stale row", async () => {
      const p = await portfolioHolding("b1-mid-computation", "2024-10-01", 704n);
      await seedDailyClose(shareEpoch, "2024-10-01", "100");

      const epochBefore = await currentMarketEpoch();

      // Pause the attempt immediately *after* `loadPricingSeries` has read
      // its (about-to-be-superseded) price snapshot — the worst window there
      // is: the epoch baseline was read even earlier, and the `INSERT` has
      // not happened yet. This is the market-data analogue of the
      // `calc_epoch` race describe above, and the reason the header's
      // ordering argument has to be read in this direction: the stamp is
      // taken no *later* than the data, so it can only ever under-claim
      // freshness.
      const pricesLoaded = deferred<void>();
      const releasePrices = deferred<void>();
      const actualLoadPricingSeries = (
        await vi.importActual<typeof import("./pricing-series.js")>("./pricing-series.js")
      ).loadPricingSeries;
      vi.mocked(loadPricingSeries).mockImplementationOnce(async (...args) => {
        const result = await actualLoadPricingSeries(...args);
        pricesLoaded.resolve();
        await releasePrices.promise;
        return result;
      });

      const inFlight = materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-10-02",
        toDate: "2024-10-02",
      });
      await pricesLoaded.promise;

      // The EOD close for the very date being computed lands mid-flight, on
      // a connection of its own (`ownerDb`), and bumps the epoch.
      await seedDailyClose(shareEpoch, "2024-10-02", "140");
      await bumpMarketEpoch();
      releasePrices.resolve();

      const raced = await inFlight;
      // The raced attempt computed from its pre-write snapshot, so it may
      // well have returned the pre-close figure — that is allowed (the read
      // started before the write committed). What is NOT allowed is for that
      // value to become permanent, and the stamp is what prevents it.
      expect(raced[0]!.totalValueBase.toString()).toBe("1000");
      const stranded = await valuationRowsInRange(p, "2024-10-02");
      expect(stranded[0]!.marketEpoch).toBe(epochBefore);
      expect(stranded[0]!.marketEpoch < (await currentMarketEpoch())).toBe(true);

      // The very next read sees a stamp older than the current epoch, treats
      // the row as missing, and rebuilds it against the close that landed.
      const next = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-10-02",
        toDate: "2024-10-02",
      });
      expect(next[0]!.totalValueBase.toString()).toBe("1400");
      const healed = await valuationRowsInRange(p, "2024-10-02");
      expect(healed[0]!.totalValueBase.toString()).toBe("1400");
      expect(healed[0]!.marketEpoch).toBe(await currentMarketEpoch());
    });

    // Folded from the SH-4 release gate (deleted after the gate passed): every
    // case above bumps the epoch alongside a write to the very portfolio being
    // read, so none of them could tell a coarse counter from an accidentally
    // instrument-scoped invalidation.
    it("a write for one instrument invalidates a portfolio holding only a different one — the counter is global, never instrument-scoped", async () => {
      const shareTrigger = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000440104",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 coarseness trigger",
        })
      ).id;
      const shareBystander = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000440105",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 coarseness bystander",
        })
      ).id;

      const p = (await createPortfolio(appWebDb, { tenantId, name: "b1-coarse-bystander" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-11-01",
        seq: 800n,
        instrumentId: shareBystander,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        grossAmount: new Decimal("10"),
      });
      await invalidate(p, "2024-11-01");
      await seedDailyClose(shareTrigger, "2024-11-01", "10");
      await seedDailyClose(shareBystander, "2024-11-01", "10");

      const params = { tenantId, portfolioId: p, fromDate: "2024-11-02", toDate: "2024-11-02" };
      const before = await materializePortfolioValuations(appWebDb, params);
      expect(before[0]!.totalValueBase.toString()).toBe("10");
      const epochBefore = before[0]!.marketEpoch;

      // Only the trigger instrument's price changes — the bystander portfolio
      // holds none of it, and its own instrument is untouched.
      await seedDailyClose(shareTrigger, "2024-11-02", "99");
      await bumpMarketEpoch();

      const after = await materializePortfolioValuations(appWebDb, params);
      // Value unchanged (its own price never moved)...
      expect(after[0]!.totalValueBase.toString()).toBe("10");
      // ...but genuinely rebuilt and re-stamped, not served from the cache.
      expect(after[0]!.marketEpoch).toBeGreaterThan(epochBefore);
    });

    // Folded from the SH-4 release gate (deleted after the gate passed).
    it("a quote-refresh write (instrument_quote_latest, deliberately no bump) leaves an already-cached row untouched — no valuation path reads that table", async () => {
      const share = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000440106",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 quote-refresh share",
        })
      ).id;
      const p = (await createPortfolio(appWebDb, { tenantId, name: "b1-quote-refresh" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-11-10",
        seq: 801n,
        instrumentId: share,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("15"),
        grossAmount: new Decimal("30"),
      });
      await invalidate(p, "2024-11-10");
      await seedDailyClose(share, "2024-11-10", "15");

      const params = { tenantId, portfolioId: p, fromDate: "2024-11-11", toDate: "2024-11-11" };
      const first = await materializePortfolioValuations(appWebDb, params);
      const firstMaterializedAt = first[0]!.materializedAt.getTime();

      // The quote-refresh job body's own write — `instrument_quote_latest`
      // only, no bump.
      await ownerDb.insert(instrumentQuoteLatest).values({
        instrumentId: share,
        price: new Decimal("999"),
        currency: "EUR",
        asOf: new Date(),
        quality: "REALTIME",
        sourceKey: "b1-test-quote-provider",
      });

      const second = await materializePortfolioValuations(appWebDb, params);
      // Byte-identical materializedAt: no rebuild happened at all...
      expect(second[0]!.materializedAt.getTime()).toBe(firstMaterializedAt);
      // ...and the 999 quote never reached the figure either.
      expect(second[0]!.totalValueBase.toString()).toBe("30");
    });

    // Folded from the SH-4 release gate (deleted after the gate passed): the
    // adversarial version of the mid-computation race above — here the STALE
    // attempt commits *last*, physically overwriting a fresh, correct row.
    it("even when a stale attempt's INSERT overwrites a fresher attempt's row last, the next read still self-heals — staleness is judged against the current epoch, not against race order", async () => {
      const share = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000440107",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 adversarial-race share",
        })
      ).id;
      const p = (await createPortfolio(appWebDb, { tenantId, name: "b1-adversarial-race" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-11-20",
        seq: 802n,
        instrumentId: share,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("100"),
      });
      await invalidate(p, "2024-11-20");
      await seedDailyClose(share, "2024-11-20", "100");

      const targetDate = "2024-11-21"; // missing — materialised by both attempts below.
      const params = { tenantId, portfolioId: p, fromDate: targetDate, toDate: targetDate };

      // Reader R1 ("stale"): paused immediately after it has taken its price
      // snapshot (old epoch, LOCF'd 100), before its own INSERT.
      const pricesLoaded = deferred<void>();
      const releasePrices = deferred<void>();
      const actualLoadPricingSeries = (
        await vi.importActual<typeof import("./pricing-series.js")>("./pricing-series.js")
      ).loadPricingSeries;
      vi.mocked(loadPricingSeries).mockImplementationOnce(async (...args) => {
        const result = await actualLoadPricingSeries(...args);
        pricesLoaded.resolve();
        await releasePrices.promise;
        return result;
      });

      const stale = materializePortfolioValuations(appWebDb, params);
      await pricesLoaded.promise;

      // While R1 is paused, the real close for the target date lands and the
      // epoch bumps (EOD-close job semantics: write, then bump).
      await seedDailyClose(share, targetDate, "250");
      await bumpMarketEpoch();

      // Reader R2 ("fresh") starts and finishes entirely after the bump: it
      // observes the new epoch and the new close, and persists a correct row.
      // On `appWebDb2` — a separate physical connection (see this file's
      // `appWebSql2` header) — since R1 is holding `appWebDb`'s single
      // connection open, paused mid-transaction. Its later start also gives it
      // a different in-flight dedupe key (the map folds in the market epoch it
      // observes), so it genuinely does its own work rather than joining R1.
      const fresh = await materializePortfolioValuations(appWebDb2, params);
      expect(fresh[0]!.totalValueBase.toString()).toBe("250");

      // Now release R1: its stale `INSERT ... ON CONFLICT DO UPDATE` lands
      // last, physically overwriting R2's correct row — but stamped with R1's
      // own (older) epoch snapshot, never with R2's fresher one.
      releasePrices.resolve();
      expect((await stale)[0]!.totalValueBase.toString()).toBe("100");
      const overwritten = await valuationRowsInRange(p, targetDate);
      expect(overwritten[0]!.totalValueBase.toString()).toBe("100");
      expect(overwritten[0]!.marketEpoch < (await currentMarketEpoch())).toBe(true);

      // The critical assertion: the next read compares the stored stamp
      // against the *current* epoch, not against whichever attempt committed
      // last, so it detects the staleness and rebuilds.
      const healed = await materializePortfolioValuations(appWebDb, params);
      expect(healed[0]!.totalValueBase.toString()).toBe("250");
      const healedPersisted = await valuationRowsInRange(p, targetDate);
      expect(healedPersisted[0]!.totalValueBase.toString()).toBe("250");
      expect(healedPersisted[0]!.marketEpoch).toBe(await currentMarketEpoch());
    });

    // Folded from the SH-4 release gate (deleted after the gate passed).
    it("a row stamped with an epoch NEWER than the reader's own snapshot is served as-is — the comparison is strictly `<`, not `!=`", async () => {
      const share = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000440109",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 strict-less-than share",
        })
      ).id;
      const p = (await createPortfolio(appWebDb, { tenantId, name: "b1-strict-lt" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-12-01",
        seq: 803n,
        instrumentId: share,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        grossAmount: new Decimal("10"),
      });
      await invalidate(p, "2024-12-01");
      await seedDailyClose(share, "2024-12-01", "10");

      const targetDate = "2024-12-02";
      const epochBefore = await currentMarketEpoch();

      // Directly engineer what a genuinely-fresher concurrent writer produces
      // (the race describe above is the real concurrent version): a persisted
      // row stamped strictly *above* the current epoch, carrying an
      // obviously-distinct value so any recomputation is caught immediately.
      await ownerDb.insert(portfolioDailyValuation).values({
        tenantId,
        portfolioId: p,
        valuationDate: targetDate,
        totalValueBase: new Decimal("777777"),
        marketEpoch: epochBefore + 5n,
      });

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: targetDate,
        toDate: targetDate,
      });
      // Under `!=` this "newer than me" row would count as a mismatch and be
      // overwritten with a freshly computed 10 — never 777777.
      expect(rows[0]!.totalValueBase.toString()).toBe("777777");
      const persisted = await valuationRowsInRange(p, targetDate);
      expect(persisted[0]!.totalValueBase.toString()).toBe("777777");
      expect(persisted[0]!.marketEpoch).toBe(epochBefore + 5n);
    });

    // Folded from the SH-4 release gate (deleted after the gate passed). Last
    // in this describe on purpose: it deletes the singleton epoch row and
    // restores it, and every describe below still needs that row.
    it("a missing market_data_epoch row throws — never silently defaults to 0", async () => {
      const share = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000440110",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "B1 missing-epoch-row share",
        })
      ).id;
      const p = (await createPortfolio(appWebDb, { tenantId, name: "b1-missing-epoch-row" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-12-10",
        seq: 804n,
        instrumentId: share,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        grossAmount: new Decimal("10"),
      });
      await invalidate(p, "2024-12-10");
      await seedDailyClose(share, "2024-12-10", "10");

      // No runtime role can DELETE this row (migration 0032) — only the owner
      // connection can, which is exactly how "the running schema is not the
      // one this code was built against" is simulated here.
      const epochBeforeDelete = await currentMarketEpoch();
      await ownerClient`DELETE FROM "market_data_epoch" WHERE "id" = 1`;

      await expect(
        materializePortfolioValuations(appWebDb, {
          tenantId,
          portfolioId: p,
          fromDate: "2024-12-11",
          toDate: "2024-12-11",
        }),
      ).rejects.toThrow(/market_data_epoch has no row/);

      await ownerClient`INSERT INTO "market_data_epoch" ("id", "epoch", "updated_at") VALUES (1, ${epochBeforeDelete.toString()}, now())`;
    });

    it("one range rebuild resolves each date's price exactly as a single-date read would: MANUAL-vs-DAILY precedence flips inside the range, ties go to MANUAL, gaps LOCF, and rows before the range anchor nothing", async () => {
      const share = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000735",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "Range precedence share",
        })
      ).id;
      const p = (await createPortfolio(appWebDb, { tenantId, name: "734-precedence" })).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2024-09-02",
        seq: 734n,
        instrumentId: share,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("50"),
        grossAmount: new Decimal("500"),
      });
      await invalidate(p, "2024-09-02");

      await seedDailyClose(share, "2024-09-03", "60"); // behind the anchor
      await seedPrice(share, "2024-09-15", "70"); // the manual anchor
      await seedDailyClose(share, "2024-09-30", "80"); // the daily anchor
      await seedDailyClose(share, "2024-10-01", "100");
      await seedPrice(share, "2024-10-02", "90");
      await seedDailyClose(share, "2024-10-03", "110");
      await seedDailyClose(share, "2024-10-04", "120");
      await seedPrice(share, "2024-10-04", "95");
      await seedDailyClose(share, "2024-10-06", "130");

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2024-09-30",
        toDate: "2024-10-06",
      });

      expect(rows.map((row) => [row.valuationDate, row.totalValueBase.toString()])).toEqual([
        ["2024-09-30", "800"], // daily 09-30 is newer than manual 09-15
        ["2024-10-01", "1000"],
        ["2024-10-02", "900"], // manual, newer
        ["2024-10-03", "1100"], // daily, strictly newer
        ["2024-10-04", "950"], // same-day tie: manual wins
        ["2024-10-05", "950"], // no observation: LOCF
        ["2024-10-06", "1300"],
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // N4 (security review, storage bound undone): H1's 2000-01-01 floor
  // bounds one portfolio to ~9,650 dates, but does nothing to stop
  // `MAX_PORTFOLIOS_PER_TENANT` (500) multiplying that into ~4.8M permanent
  // rows for a tenant that never trades at all — and a portfolio with no
  // transactions is never invalidated (invalidation is `>= min(trade_date)`,
  // and there is no `min` when there are no trades), so those rows would be
  // permanent. The fix: never persist a date before a portfolio's own first
  // trade — an empty portfolio persists nothing, a real one persists only
  // `[firstTradeDate, to]`.
  // -------------------------------------------------------------------------
  describe("nothing is persisted before a portfolio's first trade", () => {
    it("a portfolio with zero transactions persists no rows, however wide the requested range", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "n4-empty" })).id;

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2000-01-01",
        toDate: "2000-01-10",
      });
      // Still returns the full computed row set (every date is a trivial,
      // constant zero-value row for an untraded portfolio) — the contract
      // "returns the full row set for the range" holds even though none of
      // it was written.
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.totalValueBase.toString()).toBe("0");
      }

      expect(await valuationRowsInRange(p, "2000-01-01")).toHaveLength(0);

      // Repeating the same request does not grow the table either — each
      // call recomputes the (cheap, empty-timeline) prefix fresh rather than
      // ever finding something to reuse or re-persist.
      await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: "2000-01-01",
        toDate: "2000-01-10",
      });
      expect(await valuationRowsInRange(p, "2000-01-01")).toHaveLength(0);
    });

    it("a real portfolio persists only from its own first trade date onward, never the pre-trade prefix", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "n4-real" })).id;
      const firstTradeDate = "2024-06-10";

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: firstTradeDate,
        seq: 300n,
        instrumentId: shareA,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("200"),
      });
      await invalidate(p, firstTradeDate);
      await seedPrice(shareA, firstTradeDate, "100");

      const fromDate = "2024-06-01"; // before the first trade
      const toDate = "2024-06-12"; // after it

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate,
        toDate,
      });
      // Every date in [fromDate, toDate] is still returned...
      expect(rows).toHaveLength(12);
      const byDate = new Map(rows.map((r) => [r.valuationDate, r.totalValueBase]));
      // ...pre-trade dates are trivially zero (nothing held yet)...
      expect(byDate.get("2024-06-05")!.toString()).toBe("0");
      // ...and post-trade dates are the real, priced value.
      expect(byDate.get("2024-06-12")!.toString()).toBe("200");

      // Only the on/after-first-trade dates were actually written.
      const persisted = await valuationRowsInRange(p, fromDate);
      expect(persisted).toHaveLength(3); // 06-10, 06-11, 06-12
      const persistedDates = persisted.map((r) => r.valuationDate).sort();
      expect(persistedDates).toEqual(["2024-06-10", "2024-06-11", "2024-06-12"]);

      // Repeating the same request recomputes the (cheap) pre-trade prefix
      // again, but never grows the persisted set beyond the 3 real rows.
      await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate,
        toDate,
      });
      expect(await valuationRowsInRange(p, fromDate)).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Finding 2 (security review, F-1-completion round): N4 made the
  // pre-first-trade prefix never persist, but left the `missingDates.length
  // === 0` fast path unreachable for any range starting before the
  // portfolio's first trade (every new account's default window, forever) —
  // every such request unconditionally ran `loadPositionTimeline` +
  // unbounded-below `loadPricingSeries`, with no amortisation. The fix:
  // synthesise the pre-first-trade prefix directly, and restrict the
  // missing-dates check to the `[max(from, firstTradeDate), to]` engine
  // range alone.
  // -------------------------------------------------------------------------
  describe("prefix synthesis skips the engine entirely", () => {
    it("a synthesised pre-first-trade-date row is byte-identical to what the engine itself computes for an empty timeline", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "finding2-byte-equality" })).id;
      const firstTradeDate = "2024-07-10";

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: firstTradeDate,
        seq: 400n,
        instrumentId: shareA,
        quantity: new Decimal("3"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("300"),
      });
      await invalidate(p, firstTradeDate);
      await seedPrice(shareA, firstTradeDate, "100");

      const preTradeDate = "2024-07-05";
      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: preTradeDate,
        toDate: firstTradeDate,
      });
      const prefixRow = rows.find((r) => r.valuationDate === preTradeDate);
      expect(prefixRow).toBeDefined();

      // The engine's own answer for an empty timeline, no prices, no FX
      // rates — exactly what `preTradeDate` (before any trade this portfolio
      // has ever made) is standing in for, computed via the same
      // `computePmp`/`valuePortfolio` pipeline `attemptMaterialize` itself
      // calls for every *engine* date, never through the synthesis path.
      const engineComputed = valuePortfolio(
        computePmp([]),
        [],
        [],
        preTradeDate,
        "EUR",
      ).totalValueBase;

      // Numerically equal...
      expect(prefixRow!.totalValueBase.equals(engineComputed)).toBe(true);
      // ...and byte-for-byte in the exact representation `decimalCol`'s
      // `toDriver` (`Decimal#toFixed(12)`, the column's own scale) would
      // serialise either value to — not merely "both stringify to `0`".
      expect(prefixRow!.totalValueBase.toFixed(12)).toBe(engineComputed.toFixed(12));
    });

    it("a never-traded portfolio's default-window-shaped request never calls loadPositionTimeline/loadPricingSeries, across repeated identical requests", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "finding2-new-portfolio" })).id;

      const timelineCallsBefore = vi.mocked(loadPositionTimeline).mock.calls.length;
      const pricingCallsBefore = vi.mocked(loadPricingSeries).mock.calls.length;

      // Stands in for "a new account's default window" — the exact width doesn't matter to this proof, only
      // that every date in it precedes any trade (there are none).
      const params = { tenantId, portfolioId: p, fromDate: "2025-01-01", toDate: "2025-01-10" };

      for (let i = 0; i < 3; i++) {
        const rows = await materializePortfolioValuations(appWebDb, params);
        expect(rows).toHaveLength(10);
        for (const row of rows) expect(row.totalValueBase.toString()).toBe("0");
      }

      // Not "called fewer times" — called *zero* additional times, for any
      // of the 3 repeated calls, not only after the first.
      expect(vi.mocked(loadPositionTimeline).mock.calls.length).toBe(timelineCallsBefore);
      expect(vi.mocked(loadPricingSeries).mock.calls.length).toBe(pricingCallsBefore);
    });

    it("a real portfolio's second identical request does not re-invoke loadPositionTimeline/loadPricingSeries either", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "finding2-real-fast-path" })).id;
      const firstTradeDate = "2024-08-01";

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: firstTradeDate,
        seq: 401n,
        instrumentId: shareA,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("100"),
      });
      await invalidate(p, firstTradeDate);
      await seedPrice(shareA, firstTradeDate, "100");

      const params = { tenantId, portfolioId: p, fromDate: firstTradeDate, toDate: "2024-08-05" };
      // First call: genuinely materialises — expected to call both.
      await materializePortfolioValuations(appWebDb, params);

      const timelineCallsBefore = vi.mocked(loadPositionTimeline).mock.calls.length;
      const pricingCallsBefore = vi.mocked(loadPricingSeries).mock.calls.length;

      // Second, identical call: the M2 in-flight dedupe map cannot be what
      // makes this cheap (the first call already settled and was evicted
      // from it) — this is `attemptMaterialize`'s own restricted-to-the-
      // engine-range `missingEngineDates.length === 0` fast path, now
      // reachable again.
      await materializePortfolioValuations(appWebDb, params);

      expect(vi.mocked(loadPositionTimeline).mock.calls.length).toBe(timelineCallsBefore);
      expect(vi.mocked(loadPricingSeries).mock.calls.length).toBe(pricingCallsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Finding 4 (security review, LOW, coupled to finding 2): before the
  // fix, a request whose engine range had nothing missing returned `existing`
  // rows straight from a plain (non-locking) read, with no `calc_epoch`
  // re-check at all — a concurrent write's delete/epoch-bump landing between
  // that read and this attempt's own commit could let the response return
  // rows that write had already deleted. The fix: the `FOR UPDATE` re-check
  // now always runs before returning, whether or not this attempt has
  // anything new to persist.
  // -------------------------------------------------------------------------
  describe("the calc_epoch guard covers the fast (nothing-missing) path too", () => {
    it("a concurrent write's delete/epoch-bump landing after the existing-rows read but before this attempt's own commit is detected, not silently returned", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "finding4-race" })).id;
      const originalTradeDate = "2024-09-01";

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: originalTradeDate,
        seq: 500n,
        instrumentId: shareA,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await invalidate(p, originalTradeDate);
      await seedPrice(shareA, originalTradeDate, "100");

      const fromDate = "2024-09-02"; // strictly after the (only, so far) trade — no prefix, isolates this from finding 2.
      const toDate = "2024-09-05";
      const params = { tenantId, portfolioId: p, fromDate, toDate };

      // Fully materialise the range first — the read under test below must
      // hit the "nothing missing" fast path, not a fresh compute.
      const first = await materializePortfolioValuations(appWebDb, params);
      expect(first).toHaveLength(4);
      for (const row of first) expect(row.totalValueBase.toString()).toBe("1000");

      // Deterministically reproduce the race this fix closes: pause the
      // read's first attempt immediately *after* it has read the (about-to-
      // be-stale) existing rows but *before* it reaches its own
      // `calc_epoch`/`FOR UPDATE` re-check — the exact window the finding
      // describes, driven by an explicit gate rather than real
      // concurrency/timing (same technique as the "concurrent-write race"
      // describe above, just paused one statement later, at the seam finding
      // 4 itself needed factoring out for — see `./existing-valuation-rows.js`).
      const existingRead = deferred<void>();
      const releaseExistingRead = deferred<void>();
      const actualLoadExistingValuationRows = (
        await vi.importActual<typeof import("./existing-valuation-rows.js")>(
          "./existing-valuation-rows.js",
        )
      ).loadExistingValuationRows;

      vi.mocked(loadExistingValuationRows).mockImplementationOnce(async (...args) => {
        const result = await actualLoadExistingValuationRows(...args);
        existingRead.resolve();
        await releaseExistingRead.promise;
        return result;
      });

      const readPromise = materializePortfolioValuations(appWebDb, params);

      // Wait until the read's first attempt has seen the (still fully
      // materialised, nothing-missing) existing rows before landing the
      // concurrent write.
      await existingRead.promise;

      // On `appWebDb2` — a separate physical connection (see this file's
      // header) — a new, earlier-dated trade that changes every date in
      // [fromDate, toDate]'s value, committed via `recomputeAndInvalidate`
      // (the same function every `TransactionWriteService` write method
      // calls): bumps `calc_epoch` and deletes every valuation on/after
      // `originalTradeDate`, including the whole `first` result above.
      await insertEurTransaction(
        {
          id: randomUUID(),
          portfolioId: p,
          kind: "BUY",
          tradeDate: originalTradeDate,
          seq: 501n,
          instrumentId: shareA,
          quantity: new Decimal("5"),
          unitPrice: new Decimal("100"),
          grossAmount: new Decimal("500"),
        },
        appWebDb2,
      );
      await invalidate(p, originalTradeDate, appWebDb2);

      // Let the paused first attempt continue: its already-stale (the
      // concurrent write above already deleted them) `existing` rows are
      // exactly what a guard-free fast path would return unchanged.
      releaseExistingRead.resolve();

      const rows = await readPromise;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        // 15 units @ 100 — the post-write state (10 + 5). Never "1000" (the
        // now-deleted figure the read's own `existing` query saw before the
        // concurrent write committed) — returning that would be exactly
        // finding 4's bug: a fast path that skipped the epoch re-check
        // entirely.
        expect(row.totalValueBase.toString()).toBe("1500");
      }

      // And the table itself reflects the same, current figure — not just
      // the in-memory return value.
      const persisted = await valuationRowsInRange(p, fromDate);
      expect(persisted).toHaveLength(4);
      for (const row of persisted) {
        expect(row.totalValueBase.toString()).toBe("1500");
      }
    });
  });

  // -------------------------------------------------------------------------
  // D13 (`portfolio-crud-ui`, P-2): a `deletePortfolio` call
  // that wins the `portfolio` row's `FOR UPDATE` lock while a lazy
  // materialisation is mid-flight must not surface as a raw FK error on the
  // read path, and must leave zero `portfolio_daily_valuation` rows for the
  // deleted portfolio. Same pause technique as the fast-path guard case
  // above, reusing
  // the existing `loadExistingValuationRows` seam (no new hook invented for
  // this).
  // -------------------------------------------------------------------------
  describe("D13 (portfolio-crud-ui) — vanished-portfolio guard races deletePortfolio", () => {
    it("when deletePortfolio wins the row lock, the materialiser's re-check sees no portfolio row, raises no FK error, and the deleted portfolio ends with zero valuation rows", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "d13-vanishes" })).id;
      const tradeDate = "2024-10-01";

      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate,
        seq: 600n,
        instrumentId: shareA,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
        grossAmount: new Decimal("1000"),
      });
      await invalidate(p, tradeDate);
      await seedPrice(shareA, tradeDate, "100");

      const fromDate = "2024-10-02";
      const toDate = "2024-10-05";
      const params = { tenantId, portfolioId: p, fromDate, toDate };

      // Fully materialise first, so the read under test below hits the
      // "nothing missing" fast path — the finding-4 guard's own re-check
      // runs unconditionally regardless, which is exactly what this test
      // needs to race against.
      const first = await materializePortfolioValuations(appWebDb, params);
      expect(first).toHaveLength(4);

      const existingRead = deferred<void>();
      const releaseExistingRead = deferred<void>();
      const actualLoadExistingValuationRows = (
        await vi.importActual<typeof import("./existing-valuation-rows.js")>(
          "./existing-valuation-rows.js",
        )
      ).loadExistingValuationRows;

      vi.mocked(loadExistingValuationRows).mockImplementationOnce(async (...args) => {
        const result = await actualLoadExistingValuationRows(...args);
        existingRead.resolve();
        await releaseExistingRead.promise;
        return result;
      });

      const readPromise = materializePortfolioValuations(appWebDb, params);
      await existingRead.promise;

      // On `appWebDb2` (a separate physical connection) — `deletePortfolio`
      // wins the `portfolio` row's `FOR UPDATE` lock while the paused read
      // above still holds only its earlier, non-locking snapshot.
      await deletePortfolio(appWebDb2, { tenantId, portfolioId: p, deletedBy: userId });

      // Let the paused read continue into its own `FOR UPDATE` re-check,
      // which now finds no `portfolio` row at all.
      releaseExistingRead.resolve();

      // Must resolve — never reject with a raw 23503 FK error.
      const rows = await readPromise;
      expect(Array.isArray(rows)).toBe(true);

      // The deleted portfolio ends with zero valuation rows — deletePortfolio's
      // own step 1 (`portfolio_daily_valuation`, deleted after its `FOR
      // UPDATE` lock) removed exactly what the earlier
      // `first` materialisation had persisted.
      const persistedAfterDelete = await withTenant(appWebDb, tenantId, async (tx) =>
        tx
          .select()
          .from(portfolioDailyValuation)
          .where(
            and(
              eq(portfolioDailyValuation.tenantId, tenantId),
              eq(portfolioDailyValuation.portfolioId, p),
            ),
          ),
      );
      expect(persistedAfterDelete).toHaveLength(0);
    });
  });

  /*
   * portfolio-cash PC-T8 (FR-683, AC-575 integration half, AC-576):
   * `V(d) = H(d) + C(d)`, pre-flow. Each predicate on the cash
   * path can zero or freeze the cash silently, so each has a case that fails
   * without it: the strict `trade_date < d` cut (cash dated D first shows on
   * D+1), the any-kind first trade date (a cash-only portfolio is persisted),
   * exclude-and-flag for a missing rate, the upsert's cash columns (a rebuilt
   * row never keeps a stale cash component), and the ledger's delete from the
   * edited date on a cash-only kind.
   */
  describe("portfolio-cash — cash in V(d) (PC-L1, FR-683, AC-575, AC-576)", () => {
    let cashSeq = 900n;

    /** A cash transaction and its one CASH posting, signed (`amount` > 0 credits), then the ledger's own invalidation from its date. */
    async function cashMove(params: {
      portfolioId: string;
      kind: "DEPOSIT" | "INTEREST" | "FEE";
      currency: string;
      amount: string;
      tradeDate: string;
    }): Promise<{ transactionId: string }> {
      const signed = new Decimal(params.amount);
      const fxRate = new Decimal(params.currency === "EUR" ? "1" : "0.9");
      const fxRateSource = params.currency === "EUR" ? "IMPLIED_BASE" : "USER_PINNED";
      const transactionId = randomUUID();
      const s = cashSeq;
      cashSeq += 1n;
      await withTenant(appWebDb, tenantId, async (tx) => {
        const cashAccountId = await ensureCashAccount(
          tx,
          tenantId,
          params.portfolioId,
          params.currency,
        );
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: transactionId,
          tenantId,
          portfolioId: params.portfolioId,
          kind: params.kind,
          tradeDate: params.tradeDate,
          seq: s,
          grossAmount: signed.abs(),
          txnCurrency: params.currency,
          cashCurrency: params.currency,
          cashAmount: signed.abs(),
          cashAccountId,
          fxRate,
          fxRateSource,
          ...(params.currency === "EUR" ? {} : { fxRateUserInput: fxRate }),
        });
        await tx.insert(transactionPosting).values({
          id: randomUUID(),
          tenantId,
          baseCurrency: "EUR",
          transactionId,
          portfolioId: params.portfolioId,
          seq: 1,
          leg: "CASH",
          currency: params.currency,
          cashAccountId,
          amountNative: signed,
          amountBase: signed.times(fxRate),
          fxRateApplied: fxRate,
          fxRateSource,
          flowClass:
            params.kind === "FEE" ? "FEE" : params.kind === "INTEREST" ? "INCOME" : "EXTERNAL",
        });
      });
      await invalidate(params.portfolioId, params.tradeDate);
      return { transactionId };
    }

    /** A provider USD rate (EUR per USD), written as the ingestion worker's role would. */
    async function seedUsdRate(rateDate: string, rate: string): Promise<void> {
      await ownerDb.insert(fxRateDaily).values({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate,
        rate: new Decimal(rate),
        sourceKey: "ecb",
      });
    }

    async function materialize(portfolioId: string, fromDate: string, toDate: string) {
      return materializePortfolioValuations(appWebDb, { tenantId, portfolioId, fromDate, toDate });
    }

    const figures = (rows: readonly { valuationDate: string; totalValueBase: Decimal }[]) =>
      rows
        .map((row) => [row.valuationDate, row.totalValueBase.toString()])
        .sort(([a], [b]) => a!.localeCompare(b!));

    it("AC-575: income credited on 2026-07-01 first shows on 07-02 — V = 1000, 1000, 1010, the cash component equal to it", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "pc-income" })).id;
      await cashMove({
        portfolioId: p,
        kind: "DEPOSIT",
        currency: "EUR",
        amount: "1000.00",
        tradeDate: "2026-01-01",
      });
      await cashMove({
        portfolioId: p,
        kind: "INTEREST",
        currency: "EUR",
        amount: "10.00",
        tradeDate: "2026-07-01",
      });

      const rows = await materialize(p, "2026-01-01", "2026-07-02");
      const byDate = new Map(rows.map((row) => [row.valuationDate, row]));
      expect(byDate.get("2026-01-01")!.totalValueBase.toString()).toBe("0");
      expect(byDate.get("2026-01-02")!.totalValueBase.toString()).toBe("1000");
      expect(byDate.get("2026-07-01")!.totalValueBase.toString()).toBe("1000");
      expect(byDate.get("2026-07-02")!.totalValueBase.toString()).toBe("1010");
      expect(byDate.get("2026-07-02")!.cashValueBase.toString()).toBe("1010");
      expect(byDate.get("2026-07-02")!.cashUnconverted).toEqual([]);
    });

    it("C-11: a cash-only portfolio is valued and persisted from its first transaction, the prefix before it a synthesised zero", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "pc-cash-only" })).id;
      await cashMove({
        portfolioId: p,
        kind: "DEPOSIT",
        currency: "EUR",
        amount: "250.00",
        tradeDate: "2025-03-10",
      });

      await materialize(p, "2025-03-08", "2025-03-12");

      const persisted = await valuationRowsInRange(p, "2025-03-08");
      expect(figures(persisted)).toEqual([
        ["2025-03-10", "0"],
        ["2025-03-11", "250"],
        ["2025-03-12", "250"],
      ]);
    });

    it("pre-flow: USD 100.00 credited on D first shows on D+1 at D's rate carried forward (80.00), and is re-valued at each later day's rate", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "pc-usd-d1" })).id;
      await seedUsdRate("2025-05-05", "0.80");
      await seedUsdRate("2025-05-07", "0.82");
      await cashMove({
        portfolioId: p,
        kind: "DEPOSIT",
        currency: "USD",
        amount: "100.00",
        tradeDate: "2025-05-05",
      });

      // The read is strictly before its bound, with no lower bound: the
      // posting dated D is not a net of any date up to D itself.
      const nets = async (beforeDate: string) =>
        withTenant(appWebDb, tenantId, (tx) =>
          loadCashDailyNets(tx, { tenantId, portfolioId: p, beforeDate }),
        );
      expect((await nets("2025-05-05")).map((net) => net.amount.toString())).toEqual([]);
      expect((await nets("2025-05-06")).map((net) => net.amount.toString())).toEqual(["100"]);

      const rows = await materialize(p, "2025-05-05", "2025-05-08");
      expect(figures(rows)).toEqual([
        ["2025-05-05", "0"],
        ["2025-05-06", "80"],
        ["2025-05-07", "82"],
        ["2025-05-08", "82"],
      ]);
      expect(rows.every((row) => row.cashUnconverted.length === 0)).toBe(true);
    });

    it("PC-L2: with no rate on or before the date the cash is excluded and flagged, never a failure — and the rebuild once FX arrives replaces the stored cash component and clears the flag", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "pc-usd-unconverted" })).id;
      await cashMove({
        portfolioId: p,
        kind: "DEPOSIT",
        currency: "USD",
        amount: "50.00",
        tradeDate: "2025-04-01",
      });

      const before = await materialize(p, "2025-04-02", "2025-04-03");
      expect(before.map((row) => [row.totalValueBase.toString(), row.cashUnconverted])).toEqual([
        ["0", ["USD"]],
        ["0", ["USD"]],
      ]);
      const storedBefore = await valuationRowsInRange(p, "2025-04-02");
      expect(storedBefore.map((row) => row.cashUnconverted)).toEqual([["USD"], ["USD"]]);

      // The FX job lands a rate on or before both dates and bumps the epoch
      // (the order `bumpMarketDataEpoch` requires): the stored rows are
      // stale and the next read rebuilds them through the upsert.
      await seedUsdRate("2025-04-01", "0.90");
      await ownerDb
        .update(marketDataEpoch)
        .set({ epoch: sql`${marketDataEpoch.epoch} + 1`, updatedAt: new Date() })
        .where(eq(marketDataEpoch.id, 1));

      await materialize(p, "2025-04-02", "2025-04-03");
      const storedAfter = (await valuationRowsInRange(p, "2025-04-02")).sort((a, b) =>
        a.valuationDate.localeCompare(b.valuationDate),
      );
      expect(
        storedAfter.map((row) => [
          row.valuationDate,
          row.totalValueBase.toString(),
          row.cashValueBase.toString(),
        ]),
      ).toEqual([
        ["2025-04-02", "45", "45"],
        ["2025-04-03", "45", "45"],
      ]);
      expect(storedAfter.map((row) => row.cashUnconverted)).toEqual([[], []]);
    });

    it("editing a past FEE deletes the rows from its date and the next read rebuilds them with the new cash component", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "pc-fee-edit" })).id;
      await cashMove({
        portfolioId: p,
        kind: "DEPOSIT",
        currency: "EUR",
        amount: "1000.00",
        tradeDate: "2025-06-01",
      });
      const fee = await cashMove({
        portfolioId: p,
        kind: "FEE",
        currency: "EUR",
        amount: "-10.00",
        tradeDate: "2025-06-03",
      });

      expect(figures(await materialize(p, "2025-06-02", "2025-06-05"))).toEqual([
        ["2025-06-02", "1000"],
        ["2025-06-03", "1000"],
        ["2025-06-04", "990"],
        ["2025-06-05", "990"],
      ]);

      // The edit: 10.00 → 25.00, then the ledger's own invalidation from its date.
      await withTenant(appWebDb, tenantId, async (tx) => {
        await tx
          .update(transaction)
          .set({ grossAmount: new Decimal("25"), cashAmount: new Decimal("25") })
          .where(and(eq(transaction.tenantId, tenantId), eq(transaction.id, fee.transactionId)));
        await tx
          .update(transactionPosting)
          .set({ amountNative: new Decimal("-25"), amountBase: new Decimal("-25") })
          .where(
            and(
              eq(transactionPosting.tenantId, tenantId),
              eq(transactionPosting.transactionId, fee.transactionId),
            ),
          );
      });
      await invalidate(p, "2025-06-03");

      // Deleted from the FEE's date on, kept before it.
      expect(figures(await valuationRowsInRange(p, "2025-06-02"))).toEqual([
        ["2025-06-02", "1000"],
      ]);

      expect(figures(await materialize(p, "2025-06-02", "2025-06-05"))).toEqual([
        ["2025-06-02", "1000"],
        ["2025-06-03", "1000"],
        ["2025-06-04", "975"],
        ["2025-06-05", "975"],
      ]);
      const rebuilt = await valuationRowsInRange(p, "2025-06-05");
      expect(rebuilt.map((row) => row.cashValueBase.toString())).toEqual(["975"]);
    });

    it("a holding with no price still fails the read loud while its cash has no rate either — only cash is excluded", async () => {
      const p = (await createPortfolio(appWebDb, { tenantId, name: "pc-fail-loud" })).id;
      const unpriced = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST008358",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "portfolio-cash unpriced share",
        })
      ).id;
      await insertEurTransaction({
        id: randomUUID(),
        portfolioId: p,
        kind: "BUY",
        tradeDate: "2025-02-03",
        seq: 899n,
        instrumentId: unpriced,
        quantity: new Decimal("1"),
        unitPrice: new Decimal("10"),
        grossAmount: new Decimal("10"),
      });
      await cashMove({
        portfolioId: p,
        kind: "DEPOSIT",
        currency: "USD",
        amount: "5.00",
        tradeDate: "2025-02-03",
      });

      await expect(materialize(p, "2025-02-04", "2025-02-04")).rejects.toBeInstanceOf(
        UnresolvablePriceError,
      );
      expect(await valuationRowsInRange(p, "2025-02-04")).toHaveLength(0);
    });
  });
});
