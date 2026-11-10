import {
  ensureCashAccount,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import { UnresolvablePriceError } from "@kerdial/core-domain";
import {
  createInstrumentByIsin,
  createPortfolio,
  deleteManualPricePoint,
  recomputeAndInvalidate,
  upsertManualPricePoint,
} from "@kerdial/ledger";
import {
  createDb,
  portfolio,
  portfolioDailyValuation,
  tenant,
  transaction,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq, gte, lte } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializePortfolioValuations } from "./materialize.js";

/**
 * UR-4 (`ui-revamp`) — INVESTIGATION, no production code changed by this
 * file. Settles, empirically and against a real Postgres 17 container, the
 * open question of whether a back-dated manual price can leave a
 * materialised valuation row stale.
 *
 * ## THE FINDING, STATED PLAINLY
 *
 * > **Amended by AR-13a/AR-13b (ADR-0007, 2026-09-01).**
 * > UR-4's two scenarios and both mechanisms below remain proven — but its
 * > *conclusion* was broader than its scenarios, and the three write shapes
 * > outside them (a point inserted between the governor and a materialised
 * > date; an overwrite of the governor; a delete of it) were each measured
 * > leaving a stored row stale (this file's AR-13a describe, red before
 * > the fix). `upsertManualPricePoint`/`deleteManualPricePoint`
 * > therefore now fan out `recomputeAndInvalidate` from the price date via
 * > `invalidateForInstrumentPrice` — which also over-invalidates the
 * > back-dated case below, deliberately (over-invalidation is the safe
 * > direction; the LOCF immunity of the *value* still holds and is still
 * > asserted). The paragraphs below are UR-4's original record, kept as
 * > written; where they say the write "touches nothing", that is the
 * > pre-AR-13b behaviour they measured.
 *
 * **NOT A GAP.** A back-dated manual price (`priceDate` = D1, earlier than an
 * instrument's already-existing earliest price point, D2) can never leave an
 * already-materialised `portfolio_daily_valuation` row stale. Two independent,
 * both-necessary reasons, each proven empirically below (not merely read off
 * the source):
 *
 * 1. **LOCF makes D1 structurally unable to outrank D2 for any date the D2
 *    price already governs.** `resolvePrice` (`@kerdial/core-domain`)
 *    picks the *latest* observation on or before the valuation date. For
 *    every date on or after D2, D2 is that latest observation regardless of
 *    what happens at D1 < D2 afterward — inserting D1 later cannot change
 *    the answer for any date >= D2. See "scenario A" below.
 * 2. **The only dates D1 *could* possibly change are dates in `[D1, D2)` —
 *    and no materialised row can exist there before D1 is entered.**
 *    `valuePortfolio` fails loud (`UnresolvablePriceError`) the moment *any*
 *    held instrument has no resolvable price on or before the requested
 *    date. `materializePortfolioValuations`'s per-attempt transaction
 *    collects every new row into memory and only issues its `INSERT` after
 *    the *entire* requested date range has been computed without throwing —
 *    so an attempt covering `[D1, D2)` throws before committing anything,
 *    for the **whole** requested range, not merely the unresolvable dates
 *    within it. There is therefore never a "half-stale, half-fresh" batch,
 *    and no row can ever exist in `[D1, D2)` before D1 is entered for it to
 *    go stale in the first place. See "scenario B" below — which is also
 *    AC103's own success case: entering the manual price is exactly what
 *    turns a previously-unresolvable holding into a valuable one.
 *
 * `upsertManualPricePoint` bumping neither `portfolio.calc_epoch` nor
 * `portfolio_daily_valuation` (already verified by reading
 * `ledger/src/manual-price-service.ts` — no `calc_epoch`, no
 * `recomputeAndInvalidate`, no `portfolioDailyValuation` reference) is
 * therefore *correct as built*, not an oversight this feature needs to patch:
 * there is nothing for it to invalidate, because nothing it could ever affect
 * is capable of being materialised before it exists.
 *
 * **Consequences:**
 * - **AC103** ("entering a manual price for a `MANUAL_ONLY` FUND succeeds,
 *   and that instrument's holding subsequently values using the entered
 *   price rather than remaining unresolvable") holds exactly as designed —
 *   proven directly in scenario B.
 * - **UR-33 is not needed.** There is no ledger/valuation defect to fix in a
 *   follow-up cycle; the "plausible from the code path" suspicion is
 *   resolved as unreachable, and this suite records that "checked and
 *   clean" outcome.
 * - UR-14's manual-price success panel needs no "returns not yet recomputed"
 *   honesty note — `epochWillAdvance: false` (already decided in `web/src/
 *   lib/invalidate-derived.ts`, UR-3) remains correct, but for a different
 *   reason than "there might be a stale figure until the next transaction
 *   write": there is provably nothing stale to warn about.
 *
 * ## Why `app_web`, not the Testcontainers superuser
 *
 * Every service call below (`createInstrumentByIsin`, `createPortfolio`,
 * `upsertManualPricePoint`, `materializePortfolioValuations`) runs against
 * `appWebDb` — a connection authenticated as the restricted `app_web` role
 * migration `0007`/`0008` puts RLS in front of, the exact role a real
 * deployment's API process connects as. `ownerDb` (the Testcontainers
 * superuser) is used only for out-of-band setup (seeding the tenant) and,
 * in the final "red-confirmation" describe, to simulate a hypothetical
 * staleness bug by corrupting a row directly — never to exercise the
 * behaviour under investigation itself.
 *
 * ## Why this file lives in `valuation/`, not `ledger/`
 *
 * The investigation needs both `upsertManualPricePoint` (`@kerdial/ledger`)
 * and `materializePortfolioValuations` (`@kerdial/valuation`, the read-path
 * half of the invalidate-on-write/materialise-on-read design). `valuation`
 * already depends on `ledger` (`materialize.ts` imports `loadPositionTimeline`
 * from it) — the reverse is not true, so this file could not live in
 * `ledger/` without a circular workspace dependency. Same placement
 * reasoning `materialize.integration.test.ts`'s own header already documents
 * for writing `transaction` rows directly rather than going through
 * `TransactionWriteService` (which would need `market/ports`, forbidden in
 * this package).
 */

describe("UR-4 — does a back-dated manual price leave materialised valuation rows stale? (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000040004";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /** A minimal, directly-inserted EUR BUY row — same convention as `materialize.integration.test.ts`'s own `insertEurTransaction` (this file's header explains why `TransactionWriteService` itself is not used here). */
  async function insertEurBuy(row: {
    id: string;
    portfolioId: string;
    tradeDate: string;
    seq: bigint;
    instrumentId: string;
    quantity: Decimal;
    unitPrice: Decimal;
  }): Promise<void> {
    await withTenant(appWebDb, tenantId, async (tx) => {
      // CA-9/`0039`: a fiat-settled row names the cash account its money
      // moved through.
      const cashAccountId = await ensureCashAccount(tx, tenantId, row.portfolioId, "EUR");
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: row.id,
        tenantId,
        portfolioId: row.portfolioId,
        kind: "BUY",
        tradeDate: row.tradeDate,
        seq: row.seq,
        instrumentId: row.instrumentId,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        grossAmount: row.quantity.times(row.unitPrice),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: row.quantity.times(row.unitPrice),
        cashAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
    });
  }

  /**
   * A minimal, directly-inserted EUR DEPOSIT row — the "unrelated transaction
   * write" that is the self-healing trigger: it moves no
   * position (never a `BUY`/`SELL`/`DRIP`, `materialize.ts`'s own
   * `POSITION_AFFECTING_KINDS`), but still runs through the exact same
   * `recomputeAndInvalidate` step-4 delete every real write does, which is
   * all this file needs from it. A zero/no-op-sized `BUY` cannot stand in for
   * this (migration `0025`'s `transaction_quantity_positive` CHECK rejects a
   * non-positive quantity), so a trivial `DEPOSIT` is used instead.
   */
  async function insertUnrelatedDeposit(row: {
    id: string;
    portfolioId: string;
    tradeDate: string;
    seq: bigint;
  }): Promise<void> {
    await withTenant(appWebDb, tenantId, async (tx) => {
      const cashAccountId = await ensureCashAccount(tx, tenantId, row.portfolioId, "EUR");
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: row.id,
        tenantId,
        portfolioId: row.portfolioId,
        kind: "DEPOSIT",
        tradeDate: row.tradeDate,
        seq: row.seq,
        grossAmount: new Decimal("0.01"),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal("0.01"),
        cashAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
    });
  }

  /** The exact function every `TransactionWriteService` write method calls (the invalidation steps) — see `materialize.integration.test.ts`'s header for why this file calls it directly rather than through the write service. */
  async function invalidate(portfolioId: string, minTradeDate: string): Promise<void> {
    await withTenant(appWebDb, tenantId, async (tx) => {
      await recomputeAndInvalidate(tx, { tenantId, portfolioId, minTradeDate });
    });
  }

  async function readCalcEpoch(portfolioId: string): Promise<bigint> {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select({ calcEpoch: portfolio.calcEpoch })
        .from(portfolio)
        .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId))),
    );
    if (row === undefined) throw new Error(`portfolio ${portfolioId} not found`);
    return row.calcEpoch;
  }

  async function readValuationRows(portfolioId: string, fromDate: string, toDate: string) {
    return withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select()
        .from(portfolioDailyValuation)
        .where(
          and(
            eq(portfolioDailyValuation.tenantId, tenantId),
            eq(portfolioDailyValuation.portfolioId, portfolioId),
            gte(portfolioDailyValuation.valuationDate, fromDate),
            lte(portfolioDailyValuation.valuationDate, toDate),
          ),
        ),
    );
  }

  describe("scenario A — a date already governed by an existing (later) price is structurally immune to a back-dated one", () => {
    it("an already-materialised row on/after the instrument's existing price date is byte-identical before and after a back-dated manual price is entered, and a forced full recompute confirms the identical value is also the correct one", async () => {
      const fund = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000UR4001",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "UR-4 scenario A fund",
      });

      const p = (await createPortfolio(appWebDb, { tenantId, name: "UR-4 scenario A" })).id;

      // D2 — the instrument's first-ever price, entered the ordinary way,
      // same day as the BUY that opens the position (no unpriced gap).
      const d2 = "2025-01-05";
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fund.id,
        priceDate: d2,
        close: new Decimal("100"),
        currency: "EUR",
      });
      await insertEurBuy({
        id: randomUUID(),
        portfolioId: p,
        tradeDate: d2,
        // `seq` is unique per TENANT (`transaction_tenant_id_seq_key`), not
        // per portfolio — every describe in this file shares one tenant, so
        // each uses its own disjoint seq range to avoid colliding.
        seq: 101n,
        instrumentId: fund.id,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
      });
      await invalidate(p, d2);

      const d3 = "2025-04-01"; // ~3 months later, LOCF from d2's 100 (no later price yet)
      const beforeRows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      const d3RowBefore = beforeRows.find((r) => r.valuationDate === d3);
      expect(d3RowBefore?.totalValueBase.toString()).toBe("1000"); // 10 * 100

      const epochBeforeBackdate = await readCalcEpoch(p);
      const rawRowsBefore = await readValuationRows(p, d3, d3);
      expect(rawRowsBefore).toHaveLength(1);

      // --- THE BACK-DATE: D1 < D2, wildly different close so any leak would be obvious.
      const d1 = "2025-01-01";
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fund.id,
        priceDate: d1,
        close: new Decimal("1"), // 100x smaller than d2's 100 — a leak would be unmissable
        currency: "EUR",
      });

      // Since AR-13b (ADR-0007) the manual-price write
      // fans out invalidation from its own date — for this back-date that is
      // deliberate OVER-invalidation (LOCF makes D1 structurally unable to
      // change any date D2 governs, which is exactly what UR-4 proved and
      // what the recompute below still proves), and over-invalidating is the
      // safe direction, the same call `materialize.ts` makes for its own
      // double epoch bump. The write now bumps the epoch and clears rows
      // from D1 forward:
      const epochAfterBackdate = await readCalcEpoch(p);
      expect(epochAfterBackdate).toBeGreaterThan(epochBeforeBackdate);
      expect(await readValuationRows(p, d3, d3)).toHaveLength(0);

      // UR-4's actual finding — the VALUE is immune — survives unchanged,
      // and is now proven by the genuinely-recomputed row rather than a
      // cached one: freshly materialised against a series that includes D1,
      // D3's answer is identical, because D2 remains the latest observation
      // on/before D3 regardless of D1 existing.
      const recomputed = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      const d3RowRecomputed = recomputed.find((r) => r.valuationDate === d3);
      expect(d3RowRecomputed?.totalValueBase.toString()).toBe("1000");
      expect(await readValuationRows(p, d3, d3)).toHaveLength(1);
    });
  });

  describe("scenario B — AC103: the only window a back-dated price could change never had a materialised row to begin with", () => {
    it("materialising a range with an unresolvable price throws and persists NOTHING for the whole range (not just the unresolvable dates); entering the manual price for exactly that gap then lets the same range materialise in full", async () => {
      const fund = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000UR4002",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "UR-4 scenario B fund",
      });

      const p = (await createPortfolio(appWebDb, { tenantId, name: "UR-4 scenario B" })).id;

      const ta = "2025-02-01"; // the BUY's trade date — no price exists for this instrument yet
      await insertEurBuy({
        id: randomUUID(),
        portfolioId: p,
        tradeDate: ta,
        seq: 201n,
        instrumentId: fund.id,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("50"),
      });
      await invalidate(p, ta);

      // D2 — a *later*, ordinarily-entered price. The requested range below
      // spans both the unpriced prefix [ta, d2) and the priced suffix
      // [d2, toDate] — a date in the priced suffix (d2 itself) would, taken
      // alone, resolve just fine.
      const d2 = "2025-02-15";
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fund.id,
        priceDate: d2,
        close: new Decimal("55"),
        currency: "EUR",
      });

      const toDate = "2025-02-20";
      await expect(
        materializePortfolioValuations(appWebDb, {
          tenantId,
          portfolioId: p,
          fromDate: ta,
          toDate,
        }),
      ).rejects.toThrow(UnresolvablePriceError);

      // All-or-nothing: NOT ONE row persisted anywhere in the range,
      // including d2..toDate, which — considered alone — had a resolvable
      // price. There is therefore no materialised row anywhere in [ta, d2)
      // for a later back-dated price to ever find stale.
      expect(await readValuationRows(p, ta, toDate)).toHaveLength(0);

      // --- Entering a manual price for the gap (AC103's own scenario: a
      // MANUAL_ONLY FUND's holding was unresolvable; the manual entry is what
      // makes it valuable) — priced exactly at `ta`, the earliest date this
      // portfolio could possibly need it.
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fund.id,
        priceDate: ta,
        close: new Decimal("50"),
        currency: "EUR",
      });

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: ta,
        toDate,
      });
      expect(rows.length).toBeGreaterThan(0);
      const beforeD2 = rows.find((r) => r.valuationDate === "2025-02-10");
      const onD2 = rows.find((r) => r.valuationDate === d2);
      expect(beforeD2?.totalValueBase.toString()).toBe("500"); // 10 * 50 (the just-entered price, LOCF)
      expect(onD2?.totalValueBase.toString()).toBe("550"); // 10 * 55 (d2's own, later, price)
      expect(await readValuationRows(p, ta, toDate)).toHaveLength(rows.length);
    });
  });

  describe("red-confirmation — this suite's read-the-stored-row comparisons are not vacuous", () => {
    it("a genuinely stale row (simulated by direct corruption, standing in for a hypothetical missed invalidation) IS returned as-is by the same fast read path scenario A trusted, and IS fixed by the same self-healing transaction write", async () => {
      const fund = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000UR4003",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "UR-4 red-confirmation fund",
      });
      const p = (await createPortfolio(appWebDb, { tenantId, name: "UR-4 red-confirmation" })).id;

      const d2 = "2025-03-01";
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fund.id,
        priceDate: d2,
        close: new Decimal("100"),
        currency: "EUR",
      });
      await insertEurBuy({
        id: randomUUID(),
        portfolioId: p,
        tradeDate: d2,
        seq: 301n,
        instrumentId: fund.id,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
      });
      await invalidate(p, d2);

      const d3 = "2025-06-01";
      const before = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(before.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("1000");

      // Simulate a hypothetical bug — e.g. a write path that forgot to
      // invalidate `portfolio_daily_valuation` at all — by directly
      // corrupting the stored row via the Testcontainers superuser
      // connection (never `appWebDb`: this step stands in for the product
      // defect being investigated, not for anything a real deployment's
      // `app_web`-authenticated code path could itself do).
      await ownerDb
        .update(portfolioDailyValuation)
        .set({ totalValueBase: new Decimal("999999") })
        .where(
          and(
            eq(portfolioDailyValuation.tenantId, tenantId),
            eq(portfolioDailyValuation.portfolioId, p),
            eq(portfolioDailyValuation.valuationDate, d3),
          ),
        );

      // Read again through the exact same production read path scenario A's
      // "unchanged" assertions relied on. If this suite's comparisons could
      // not observe a real staleness, this assertion would fail here —
      // proving they can.
      const stale = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(stale.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("999999");

      // The self-healing trigger: an unrelated transaction
      // write invalidates (deletes) the corrupted row, and the next read
      // recomputes it correctly.
      await insertUnrelatedDeposit({ id: randomUUID(), portfolioId: p, tradeDate: d2, seq: 302n });
      await invalidate(p, d2);
      expect(await readValuationRows(p, d3, d3)).toHaveLength(0);

      const healed = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(healed.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("1000");
    });
  });
  describe("AR-13a/AR-13b (ADR-0007) — the three write shapes outside UR-4's scenarios", () => {
    /**
     * UR-4's two mechanisms are real and stay proven above — but neither
     * covers these three writes, and AR-13a's red run confirmed all three
     * leave a materialised row stale (rows kept their pre-write value while
     * a forced recompute produced a different one). AR-13b's fix is
     * `invalidateForInstrumentPrice` (ledger/src/materialization.ts): the
     * manual-price writes now fan out `recomputeAndInvalidate` to every
     * portfolio holding or having traded the instrument, from the price
     * date. Each case asserts the ADR's own registry contract: calc_epoch
     * advanced for every in-scope portfolio, stored rows on/after the price
     * date gone, an out-of-scope portfolio untouched — and then that a fresh
     * materialisation produces the value the new series implies, which is
     * what "stale" was measured against in the red run.
     */

    /** One priced, held MANUAL_ONLY fund in its own portfolio — the shared fixture shape of all three cases. */
    async function seedHeldFund(params: {
      isin: string;
      name: string;
      seq: bigint;
      prices: readonly { date: string; close: string }[];
      buyDate: string;
    }): Promise<{ fundId: string; portfolioId: string }> {
      const fund = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: params.isin,
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: params.name,
      });
      const portfolioId = (await createPortfolio(appWebDb, { tenantId, name: params.name })).id;
      for (const point of params.prices) {
        await upsertManualPricePoint(appWebDb, {
          tenantId,
          instrumentId: fund.id,
          priceDate: point.date,
          close: new Decimal(point.close),
          currency: "EUR",
        });
      }
      await insertEurBuy({
        id: randomUUID(),
        portfolioId,
        tradeDate: params.buyDate,
        seq: params.seq,
        instrumentId: fund.id,
        quantity: new Decimal("10"),
        unitPrice: new Decimal("100"),
      });
      await invalidate(portfolioId, params.buyDate);
      return { fundId: fund.id, portfolioId };
    }

    it("(a) a point inserted BETWEEN the governing observation and a materialised date invalidates from its own date — and only from it", async () => {
      const d2 = "2025-01-05";
      const d3 = "2025-04-01";
      const { fundId, portfolioId: p } = await seedHeldFund({
        isin: "FR0000AR13A1",
        name: "AR-13a case (a)",
        seq: 401n,
        prices: [{ date: d2, close: "100" }],
        buyDate: d2,
      });
      // An out-of-scope portfolio in the same tenant: holds nothing in this
      // instrument, must stay untouched by the fan-out.
      const outsider = (await createPortfolio(appWebDb, { tenantId, name: "AR-13a bystander" })).id;

      const before = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(before.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("1000");
      const epochBefore = await readCalcEpoch(p);
      const outsiderEpochBefore = await readCalcEpoch(outsider);

      // THE WRITE UNDER TEST — d2 < d2_5 < d3, so no LATER point governs d3
      // (mechanism 1 silent) and the range was fully priceable (mechanism 2
      // silent). Red run: the stored d3 row kept 1000 while the recomputed
      // value was 2000.
      const d2_5 = "2025-02-01";
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fundId,
        priceDate: d2_5,
        close: new Decimal("200"),
        currency: "EUR",
      });

      // The registry contract: epoch advanced for the in-scope portfolio…
      expect(await readCalcEpoch(p)).toBeGreaterThan(epochBefore);
      // …rows on/after the price date are gone, earlier rows are kept…
      expect(await readValuationRows(p, d2_5, d3)).toHaveLength(0);
      expect((await readValuationRows(p, d2, d2)).length).toBeGreaterThan(0);
      // …and the bystander is untouched.
      expect(await readCalcEpoch(outsider)).toBe(outsiderEpochBefore);

      const after = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(after.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("2000");
    });

    it("(b) an OVERWRITE of the governing observation invalidates from its date — the upsert's ON CONFLICT arm, AC129's one-click revision", async () => {
      const d2 = "2025-01-05";
      const d3 = "2025-04-01";
      const { fundId, portfolioId: p } = await seedHeldFund({
        isin: "FR0000AR13B1",
        name: "AR-13a case (b)",
        seq: 402n,
        prices: [{ date: d2, close: "100" }],
        buyDate: d2,
      });
      const before = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(before.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("1000");
      const epochBefore = await readCalcEpoch(p);

      // Same (instrumentId, priceDate) key — the upsert's DO UPDATE arm.
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fundId,
        priceDate: d2,
        close: new Decimal("50"),
        currency: "EUR",
      });

      expect(await readCalcEpoch(p)).toBeGreaterThan(epochBefore);
      expect(await readValuationRows(p, d2, d3)).toHaveLength(0);

      const after = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d2,
        toDate: d3,
      });
      expect(after.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("500");
    });

    it("(c) a DELETE of the governing observation invalidates from its date — the removed governor's window falls back to the earlier point", async () => {
      const d1 = "2025-01-02";
      const d2 = "2025-01-05";
      const d3 = "2025-04-01";
      const { fundId, portfolioId: p } = await seedHeldFund({
        isin: "FR0000AR13C1",
        name: "AR-13a case (c)",
        seq: 403n,
        prices: [
          { date: d1, close: "80" },
          { date: d2, close: "100" },
        ],
        buyDate: d1,
      });
      const before = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d1,
        toDate: d3,
      });
      expect(before.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("1000");
      const epochBefore = await readCalcEpoch(p);

      const deleted = await deleteManualPricePoint(appWebDb, tenantId, fundId, d2);
      expect(deleted).toBe(true);

      expect(await readCalcEpoch(p)).toBeGreaterThan(epochBefore);
      expect(await readValuationRows(p, d2, d3)).toHaveLength(0);
      // The d1-governed prefix is untouched — invalidation is from the
      // deleted point's own date, exactly as an added one.
      expect((await readValuationRows(p, d1, d1)).length).toBeGreaterThan(0);

      const after = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId: p,
        fromDate: d1,
        toDate: d3,
      });
      expect(after.find((r) => r.valuationDate === d3)?.totalValueBase.toString()).toBe("800");
    });

    it("a manual price for an UNHELD instrument fans out to nothing — no portfolio's epoch moves, which is why the client keeps epochWillAdvance: false", async () => {
      const fund = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000AR13D1",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "AR-13a unheld fund",
      });
      const bystander = (
        await createPortfolio(appWebDb, { tenantId, name: "AR-13a unheld bystander" })
      ).id;
      const epochBefore = await readCalcEpoch(bystander);

      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fund.id,
        priceDate: "2025-01-05",
        close: new Decimal("100"),
        currency: "EUR",
      });

      expect(await readCalcEpoch(bystander)).toBe(epochBefore);
    });

    it("a no-op delete (no such point) invalidates nothing", async () => {
      const { fundId, portfolioId: p } = await seedHeldFund({
        isin: "FR0000AR13E1",
        name: "AR-13a no-op delete",
        seq: 404n,
        prices: [{ date: "2025-01-05", close: "100" }],
        buyDate: "2025-01-05",
      });
      const epochBefore = await readCalcEpoch(p);
      const deleted = await deleteManualPricePoint(appWebDb, tenantId, fundId, "2030-01-01");
      expect(deleted).toBe(false);
      expect(await readCalcEpoch(p)).toBe(epochBefore);
    });
  });
});
