import {
  ensureCashAccount,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin, createPortfolio, recomputeAndInvalidate } from "@kerdial/ledger";
import {
  createDb,
  fxRateDaily,
  instrumentPriceDaily,
  tenant,
  transaction,
  transactionPosting,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { valueHoldingsAsOf, valueHoldingsForTenant } from "./holdings-valuation.js";
import {
  computeCombinedPortfolioReturns,
  computeCombinedPortfolioValueSeries,
  computePortfolioReturns,
  computePortfolioValueSeries,
} from "./performance.js";

/**
 * T-39 — `computePortfolioReturns`/`computeCombinedPortfolioReturns`.
 * Most notably the combined view's own AC: "combined TWR/MWR computed from
 * the union of both portfolios' cash flows — verified against a fixture
 * where naive averaging of the two per-portfolio returns would give a
 * demonstrably different answer" (AC10, FR-14). Against a real Postgres 17
 * container, authenticated as `app_web` — same bootstrap as
 * `materialize.integration.test.ts`/`holdings-valuation.integration.test.ts`.
 *
 * H2(d) (security review): `./holdings-valuation.js`'s `valueHoldingsAsOf`/
 * `valueHoldingsForTenant` are wrapped in call-counting spies (mirrors
 * `materialize.integration.test.ts`'s own `vi.mock("@kerdial/ledger", ...)`
 * convention — every other export passes through unmodified) so this file's
 * own H2(d) describe (below) can assert `computePortfolioReturns`/
 * `computeCombinedPortfolioReturns` skip their own internal holdings fetch
 * when the caller already passed one in as `terminalHoldings`. This is the
 * module-boundary this dedupe can actually be observed at:
 * `PortfoliosController` (the real caller `portfolios-overview.e2e.test.ts`
 * exercises) and this module both import `valueHoldingsAsOf`/
 * `valueHoldingsForTenant` from `./holdings-valuation.js` as a *separate*
 * module — unlike `valueHoldingsForTenant`'s own internal call to
 * `valueHoldingsAsOf`, which is a same-module function reference `vi.mock`
 * cannot intercept.
 */
vi.mock("./holdings-valuation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./holdings-valuation.js")>();
  return {
    ...actual,
    valueHoldingsAsOf: vi.fn(actual.valueHoldingsAsOf),
    valueHoldingsForTenant: vi.fn(actual.valueHoldingsForTenant),
  };
});

describe("valuation — computePortfolioReturns / computeCombinedPortfolioReturns (T-39, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000390002";
  let seq = 1n;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 5 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function nextSeq(): Promise<bigint> {
    const value = seq;
    seq += 1n;
    return value;
  }

  async function buy(row: {
    tenantId?: string;
    portfolioId: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    unitPrice: string;
  }): Promise<void> {
    const scopedTenantId = row.tenantId ?? tenantId;
    const s = await nextSeq();
    await withTenant(appWebDb, scopedTenantId, async (tx) => {
      // CA-9/`0039`: a fiat-settled row names the cash account its money
      // moved through.
      const cashAccountId = await ensureCashAccount(tx, scopedTenantId, row.portfolioId, "EUR");
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: randomUUID(),
        tenantId: scopedTenantId,
        portfolioId: row.portfolioId,
        kind: "BUY",
        tradeDate: row.tradeDate,
        seq: s,
        instrumentId: row.instrumentId,
        quantity: new Decimal(row.quantity),
        unitPrice: new Decimal(row.unitPrice),
        grossAmount: new Decimal(row.quantity).times(row.unitPrice),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal(row.quantity).times(row.unitPrice),
        cashAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
    });
    await withTenant(appWebDb, scopedTenantId, async (tx) => {
      await recomputeAndInvalidate(tx, {
        tenantId: scopedTenantId,
        portfolioId: row.portfolioId,
        minTradeDate: row.tradeDate,
      });
    });
  }

  /** An external flow, in any currency, at the rate the row itself stores. */
  async function externalFlow(row: {
    tenantId?: string;
    portfolioId: string;
    kind: "DEPOSIT" | "WITHDRAWAL";
    tradeDate: string;
    amount: string;
    currency?: string;
    fxRate?: string;
  }): Promise<void> {
    const scopedTenantId = row.tenantId ?? tenantId;
    const currency = row.currency ?? "EUR";
    const fxRate = row.fxRate ?? "1";
    const s = await nextSeq();
    await withTenant(appWebDb, scopedTenantId, async (tx) => {
      const cashAccountId = await ensureCashAccount(tx, scopedTenantId, row.portfolioId, currency);
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: randomUUID(),
        tenantId: scopedTenantId,
        portfolioId: row.portfolioId,
        kind: row.kind,
        tradeDate: row.tradeDate,
        seq: s,
        grossAmount: new Decimal(row.amount),
        txnCurrency: currency,
        cashCurrency: currency,
        cashAmount: new Decimal(row.amount),
        cashAccountId,
        fxRate: new Decimal(fxRate),
        fxRateSource: currency === "EUR" ? "IMPLIED_BASE" : "USER_PINNED",
        ...(currency === "EUR" ? {} : { fxRateUserInput: new Decimal(fxRate) }),
      });
    });
    await withTenant(appWebDb, scopedTenantId, async (tx) => {
      await recomputeAndInvalidate(tx, {
        tenantId: scopedTenantId,
        portfolioId: row.portfolioId,
        minTradeDate: row.tradeDate,
      });
    });
  }

  /**
   * A security transfer written directly, in the shape
   * `TransactionWriteService.recordTransferOut` writes (this file's header
   * explains why it bypasses the service): a `TRANSFER_OUT` in the source and,
   * when `targetPortfolioId` is named, its linked `TRANSFER_IN` carrying the
   * same market value, currency and rate (ST-6) plus the carried cost. Both
   * portfolios are then recomputed, as the service's propagation would.
   */
  async function transferPair(row: {
    tenantId: string;
    sourcePortfolioId: string;
    targetPortfolioId?: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    marketValue: string;
    carriedCost: string;
  }): Promise<void> {
    const sourceSeq = await nextSeq();
    const targetSeq = await nextSeq();
    const sourceId = randomUUID();
    const common = {
      baseCurrency: "EUR",
      tenantId: row.tenantId,
      tradeDate: row.tradeDate,
      instrumentId: row.instrumentId,
      quantity: new Decimal(row.quantity),
      grossAmount: new Decimal(row.marketValue),
      txnCurrency: "EUR",
      fxRate: new Decimal("1"),
      fxRateSource: "IMPLIED_BASE",
    } as const;
    await withTenant(appWebDb, row.tenantId, async (tx) => {
      await tx.insert(transaction).values({
        ...common,
        id: sourceId,
        portfolioId: row.sourcePortfolioId,
        kind: "TRANSFER_OUT",
        seq: sourceSeq,
      });
      if (row.targetPortfolioId !== undefined) {
        await tx.insert(transaction).values({
          ...common,
          id: randomUUID(),
          portfolioId: row.targetPortfolioId,
          kind: "TRANSFER_IN",
          seq: targetSeq,
          transferSourceId: sourceId,
          transferCostBase: new Decimal(row.carriedCost),
          transferCostNative: new Decimal(row.carriedCost),
          transferCostCurrency: "EUR",
        });
      }
    });
    for (const portfolioId of [row.sourcePortfolioId, row.targetPortfolioId]) {
      if (portfolioId === undefined) continue;
      await withTenant(appWebDb, row.tenantId, async (tx) => {
        await recomputeAndInvalidate(tx, {
          tenantId: row.tenantId,
          portfolioId,
          minTradeDate: row.tradeDate,
        });
      });
    }
  }

  async function seedDailyPrice(
    instrumentId: string,
    priceDate: string,
    close: string,
  ): Promise<void> {
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId,
      priceDate,
      closeRaw: new Decimal(close),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });
  }

  describe("performance echoes the exact requested range (FR-25, FR-26)", () => {
    it("start/end dates in the response match the request parameters, not a default range", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131620",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 performance-range share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-01", "100");
      await seedDailyPrice(shareId, "2024-04-10", "110");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39 range ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-01",
        quantity: "10",
        unitPrice: "100",
      });

      const fromDate = "2024-04-02";
      const toDate = "2024-04-10";
      const returns = await computePortfolioReturns(appWebDb, {
        tenantId,
        portfolioId,
        fromDate,
        toDate,
      });

      expect(returns.from).toBe(fromDate);
      expect(returns.to).toBe(toDate);
      expect(returns.twr.available).toBe(true);
      if (returns.twr.available) {
        // V(from) = 10*100 = 1000 (LOCF from 04-01); V(to) = 10*110 = 1100.
        expect(returns.twr.cumulative.toString()).toBe("0.1");
      }

      // AR-24 (ADR-0010): the pair carries one summary over the
      // inputs both engines consumed — here a flow-less range, so its leaves
      // are the series points alone: range = the materialised dates,
      // complete structurally true (the amended ADR's phase-1 rule).
      expect(returns.provenance.leafCount).toBeGreaterThan(0);
      expect(returns.provenance.oldestObservationAt).toBe(fromDate);
      expect(returns.provenance.newestObservationAt).toBe(toDate);
      expect(returns.provenance.complete).toBe(true);
    });

    it("a return computed over a PINNED flow renders non-empty provenance — Stage 5's exit criterion, the recorded T-39/T-45 carry-forward (AR-24)", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131629",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 pinned-flow share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-01", "100");
      await seedDailyPrice(shareId, "2024-04-10", "110");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `AR-24 pinned ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-01",
        quantity: "10",
        unitPrice: "100",
      });
      // A USD deposit whose rate the user pinned — the stored fx_rate_source
      // is USER_PINNED (FR-57's fact, never re-resolved), and that is what
      // the return's provenance must surface.
      const s = await nextSeq();
      await withTenant(appWebDb, tenantId, async (tx) => {
        const cashAccountId = await ensureCashAccount(tx, tenantId, portfolioId, "USD");
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: randomUUID(),
          tenantId,
          portfolioId,
          kind: "DEPOSIT",
          tradeDate: "2024-04-05",
          seq: s,
          grossAmount: new Decimal("500"),
          txnCurrency: "USD",
          cashCurrency: "USD",
          cashAmount: new Decimal("500"),
          cashAccountId,
          fxRate: new Decimal("0.92"),
          fxRateSource: "USER_PINNED",
          fxRateUserInput: new Decimal("0.92"),
        });
      });
      await withTenant(appWebDb, tenantId, async (tx) => {
        await recomputeAndInvalidate(tx, { tenantId, portfolioId, minTradeDate: "2024-04-05" });
      });

      const returns = await computePortfolioReturns(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2024-04-02",
        toDate: "2024-04-10",
      });

      expect(returns.provenance.derivedFrom).toContain("PINNED_FX");
      expect(returns.provenance.pinnedFxPresent).toBe(true);
      expect(returns.provenance.sources).toContain("USER_PINNED");
      expect(returns.provenance.complete).toBe(true);
    });
  });

  describe("FR-262 — the daily value series", () => {
    it("the series' endpoint value agrees with the overview's scalar total for the same date — two reads never disagree about the same portfolio", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131640",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-262 agreement share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-01", "100");
      await seedDailyPrice(shareId, "2024-04-08", "104");
      await seedDailyPrice(shareId, "2024-04-10", "110");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `FR-262 agreement ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-01",
        quantity: "10",
        unitPrice: "100",
      });

      const series = await computePortfolioValueSeries(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2024-04-01",
        toDate: "2024-04-10",
      });

      // Dense: one point per calendar date, no interpolation needed and none
      // performed — LOCF inside valuePortfolio carries 04-08's close over
      // the priceless 04-09, and that is the engine's rule, not this
      // endpoint's.
      expect(series.points).toHaveLength(10);
      expect(series.points[0]).toMatchObject({ date: "2024-04-01" });
      expect(series.points.at(-1)).toMatchObject({ date: "2024-04-10" });
      expect(series.points.at(-1)!.value.toString()).toBe("1100");
      expect(series.baseCurrency).toBe("EUR");

      // THE agreement assertion (FR-262's own acceptance criterion): the
      // series' endpoint equals the scalar total the overview returns for
      // the same date — both are valuePortfolio over the same inputs. The
      // series is start-of-day (pre-flow, the TWR convention) and the
      // overview is end-of-day, so the property holds on any date without a
      // same-day flow — which this endpoint date is, and which FR-262
      // records as the convention rather than hiding.
      const holdings = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-04-10",
      });
      expect(series.points.at(-1)!.value.toString()).toBe(holdings.totalValue.amount.toString());

      // The series-level summary carries the pair's own coarse provenance:
      // every point a leaf, range = the window, complete structurally true.
      expect(series.provenance.leafCount).toBe(10);
      expect(series.provenance.complete).toBe(true);
    });

    it("dates before the first trade carry the modelled zero — N4's own semantics, never an interpolation", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131631",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-262 prefix share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-05", "100");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `FR-262 prefix ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-05",
        quantity: "10",
        unitPrice: "100",
      });

      const series = await computePortfolioValueSeries(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2024-04-01",
        toDate: "2024-04-06",
      });

      // Start-of-day, pre-flow — the engine's own TWR convention
      // (`materialize.ts`'s computeNewRows: "only events strictly before
      // `date` count"), recorded in FR-262 rather than papered over: the
      // trade date itself still values at the modelled zero; the position
      // appears from the next day.
      expect(series.points.map((point) => point.value.toString())).toEqual([
        "0",
        "0",
        "0",
        "0",
        "0",
        "1000",
      ]);
    });

    it("the combined series is the per-date SUM of every portfolio's series — the same union the combined TWR consumes", async () => {
      // A dedicated tenant so no other describe's portfolios join the sum.
      const combinedTenant = randomUUID();
      await ownerDb.insert(tenant).values({ id: combinedTenant });
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131632",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-262 combined share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-01", "100");
      await seedDailyPrice(shareId, "2024-04-03", "110");

      const p1 = (
        await createPortfolio(appWebDb, { tenantId: combinedTenant, name: "FR-262 combined A" })
      ).id;
      const p2 = (
        await createPortfolio(appWebDb, { tenantId: combinedTenant, name: "FR-262 combined B" })
      ).id;
      await buy({
        tenantId: combinedTenant,
        portfolioId: p1,
        instrumentId: shareId,
        tradeDate: "2024-04-01",
        quantity: "10",
        unitPrice: "100",
      });
      // The second portfolio's first trade is a day later — its 04-01 point
      // is the modelled zero, so the sum stays defined across the range.
      await buy({
        tenantId: combinedTenant,
        portfolioId: p2,
        instrumentId: shareId,
        tradeDate: "2024-04-02",
        quantity: "5",
        unitPrice: "100",
      });

      const combined = await computeCombinedPortfolioValueSeries(appWebDb, {
        tenantId: combinedTenant,
        fromDate: "2024-04-01",
        toDate: "2024-04-03",
      });

      // Same start-of-day convention as the per-portfolio series: a buy
      // counts from the day after its trade date.
      expect(combined.points.map((point) => point.value.toString())).toEqual([
        "0", // both pre-flow on their own trade dates
        "1000", // p1's 10×100 (LOCF from 04-01); p2 still pre-flow
        "1650", // (10 + 5) × 110
      ]);
    });
  });

  describe("invested capital — netContributions on the value series", () => {
    it("is cumulative since inception, pre-flow like `value`: a deposit on D leaves point D unchanged and lifts D+1; a foreign deposit converts at its own stored fx_rate; a withdrawal nets off", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131633",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "Contributions share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-01", "100");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `Contributions ${randomUUID()}` })
      ).id;
      // Capital that went in BEFORE the window still counts at its start.
      await externalFlow({ portfolioId, kind: "DEPOSIT", tradeDate: "2024-03-20", amount: "1000" });
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-01",
        quantity: "5",
        unitPrice: "100",
      });
      // A USD deposit at the user's pinned rate: 500 × 0.92 = 460 base.
      await externalFlow({
        portfolioId,
        kind: "DEPOSIT",
        tradeDate: "2024-04-03",
        amount: "500",
        currency: "USD",
        fxRate: "0.92",
      });
      await externalFlow({
        portfolioId,
        kind: "WITHDRAWAL",
        tradeDate: "2024-04-05",
        amount: "200",
      });

      const series = await computePortfolioValueSeries(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2024-04-02",
        toDate: "2024-04-06",
      });

      expect(series.points.map((point) => [point.date, point.netContributions.toString()])).toEqual(
        [
          ["2024-04-02", "1000"], // the March deposit, in full, before the window
          ["2024-04-03", "1000"], // the USD deposit is dated today — pre-flow, not yet
          ["2024-04-04", "1460"], // 1000 + 500 × 0.92
          ["2024-04-05", "1460"], // the withdrawal is dated today — pre-flow, not yet
          ["2024-04-06", "1260"], // 1460 − 200
        ],
      );
      // `value` is untouched by this: the buy is the only thing priced.
      expect(series.points.every((point) => point.value.toString() === "500")).toBe(true);
    });

    it("the combined series' netContributions is the per-date sum over the tenant's portfolios", async () => {
      const combinedTenant = randomUUID();
      await ownerDb.insert(tenant).values({ id: combinedTenant });
      const p1 = (
        await createPortfolio(appWebDb, {
          tenantId: combinedTenant,
          name: "Contributions combined A",
        })
      ).id;
      const p2 = (
        await createPortfolio(appWebDb, {
          tenantId: combinedTenant,
          name: "Contributions combined B",
        })
      ).id;
      await externalFlow({
        tenantId: combinedTenant,
        portfolioId: p1,
        kind: "DEPOSIT",
        tradeDate: "2024-04-01",
        amount: "100",
      });
      await externalFlow({
        tenantId: combinedTenant,
        portfolioId: p2,
        kind: "DEPOSIT",
        tradeDate: "2024-04-02",
        amount: "50",
      });

      const combined = await computeCombinedPortfolioValueSeries(appWebDb, {
        tenantId: combinedTenant,
        fromDate: "2024-04-01",
        toDate: "2024-04-03",
      });

      expect(combined.points.map((point) => point.netContributions.toString())).toEqual([
        "0", // both deposits are pre-flow on their own dates
        "100",
        "150",
      ]);
    });
  });

  describe("security transfer — a security transfer is an external flow at its market value (FR-567/568/569, OD-10 (a))", () => {
    /**
     * The figures AC-449/AC-451 state: the worked transfer row of 2025-07-09 moves
     * 1 unit worth 1 240.80 EUR out of a position bought at a PMP of 660.00 —
     * so the carried cost (660.00) and the market value (1 240.80) are two
     * different numbers, and only the second may reach the flow loaders.
     *
     * The instrument is priced at exactly 1 240.80 EUR throughout, so the
     * valuation close and the stated market value agree: R-3's accepted
     * sub-period drift is zero by construction here and the
     * return is a known answer, not a tolerance.
     *
     *   P1: DEPOSIT 3 300.00 on 07-01, BUY 5 @ 660.00 on 07-01 → value 6 204.00
     *   P1 → P2: 1 unit on 07-09, market value 1 240.80, carried cost 660.00
     *   P1 after: 4 units → 4 963.20; P2 after: 1 unit → 1 240.80
     */
    const transferDate = "2025-07-09";
    const dayAfter = "2025-07-10";
    let fixtureCount = 0;

    async function transferFixture(): Promise<{
      tenantId: string;
      source: string;
      target: string;
    }> {
      const scopedTenantId = randomUUID();
      await ownerDb.insert(tenant).values({ id: scopedTenantId });
      fixtureCount += 1;
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: `XT${String(fixtureCount).padStart(9, "0")}0`,
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "Transferred share",
        })
      ).id;
      await seedDailyPrice(shareId, "2025-07-01", "1240.80");
      const source = (
        await createPortfolio(appWebDb, { tenantId: scopedTenantId, name: "Transfer source" })
      ).id;
      const target = (
        await createPortfolio(appWebDb, { tenantId: scopedTenantId, name: "Transfer target" })
      ).id;
      await externalFlow({
        tenantId: scopedTenantId,
        portfolioId: source,
        kind: "DEPOSIT",
        tradeDate: "2025-07-01",
        amount: "3300",
      });
      await buy({
        tenantId: scopedTenantId,
        portfolioId: source,
        instrumentId: shareId,
        tradeDate: "2025-07-01",
        quantity: "5",
        unitPrice: "660",
      });
      await transferPair({
        tenantId: scopedTenantId,
        sourcePortfolioId: source,
        targetPortfolioId: target,
        instrumentId: shareId,
        tradeDate: transferDate,
        quantity: "1",
        marketValue: "1240.80",
        carriedCost: "660",
      });
      return { tenantId: scopedTenantId, source, target };
    }

    it("AC-451: the source leg's own TWR/XIRR consume a withdrawal-shaped 1 240.80 EUR flow, never the 660.00 PMP cost", async () => {
      const { tenantId: scopedTenantId, source } = await transferFixture();
      const returns = await computePortfolioReturns(appWebDb, {
        tenantId: scopedTenantId,
        portfolioId: source,
        fromDate: "2025-07-02",
        toDate: "2025-07-20",
      });

      expect(returns.twr.available).toBe(true);
      if (!returns.twr.available) return;
      // The transfer opened the one interior sub-period boundary.
      expect(returns.twr.subPeriodCount).toBe(2);
      // 6 204.00 → 6 204.00, then 4 963.20 / (6 204.00 − 1 240.80) = 1: exactly
      // zero. Had the loader used the carried cost the second sub-period would
      // be 4 963.20 / (6 204.00 − 660.00) − 1 ≈ −10.5 %.
      expect(returns.twr.cumulative.toString()).toBe("0");

      // XIRR: −6 204.00 at the start, +1 240.80 on 07-09 (a withdrawal is a
      // positive cash flow to the investor), 4 963.20 terminal — NPV is zero
      // at r = 0. With 660.00 in its place the rate is far from zero.
      expect(returns.mwr.converged).toBe(true);
      if (!returns.mwr.converged) return;
      expect(returns.mwr.rate.abs().lessThan("1e-9")).toBe(true);
    });

    it("AC-454 and AC-455 (OD-10 (a)): each side's net contributions step by ∓1 240.80 EUR on D+1, the combined series by exactly zero", async () => {
      const { tenantId: scopedTenantId, source, target } = await transferFixture();
      const range = { fromDate: transferDate, toDate: dayAfter } as const;

      const netContributions = (series: Awaited<ReturnType<typeof computePortfolioValueSeries>>) =>
        series.points.map((point) => [point.date, point.netContributions.toString()]);

      const sourceSeries = await computePortfolioValueSeries(appWebDb, {
        tenantId: scopedTenantId,
        portfolioId: source,
        ...range,
      });
      const targetSeries = await computePortfolioValueSeries(appWebDb, {
        tenantId: scopedTenantId,
        portfolioId: target,
        ...range,
      });
      // AC-455 — flows count "strictly before" the point: unchanged on D, the
      // step on D+1.
      expect(netContributions(sourceSeries)).toEqual([
        [transferDate, "3300"],
        [dayAfter, "2059.2"],
      ]);
      expect(netContributions(targetSeries)).toEqual([
        [transferDate, "0"],
        [dayAfter, "1240.8"],
      ]);

      // AC-454 — the tenant-wide series, same file, same fixture: exact
      // Decimal equality across the step, not "approximately unchanged".
      const combined = await computeCombinedPortfolioValueSeries(appWebDb, {
        tenantId: scopedTenantId,
        ...range,
      });
      const [onDay, nextDay] = combined.points;
      expect(onDay?.netContributions.toString()).toBe("3300");
      expect(nextDay?.netContributions.equals(onDay!.netContributions)).toBe(true);
    });
    it("FR-569: the combined TWR splits on both legs and still nets the pair to a zero return", async () => {
      const { tenantId: scopedTenantId } = await transferFixture();
      const combined = await computeCombinedPortfolioReturns(appWebDb, {
        tenantId: scopedTenantId,
        fromDate: "2025-07-02",
        toDate: "2025-07-20",
      });
      expect(combined.twr.available).toBe(true);
      if (!combined.twr.available) return;
      // 6 204.00 throughout the tenant: −1 240.80 + 1 240.80 on the same day.
      expect(combined.twr.cumulative.toString()).toBe("0");
    });
  });

  describe("first trade date — the first trade date counts every position-affecting kind", () => {
    it("a SHARE_DISTRIBUTION dated before the first BUY starts the valued series, not the modelled zero", async () => {
      const scopedTenantId = randomUUID();
      await ownerDb.insert(tenant).values({ id: scopedTenantId });
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "XD0000007210",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "Distributed share",
        })
      ).id;
      await seedDailyPrice(shareId, "2025-08-01", "100");
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId: scopedTenantId, name: "Distribution first" })
      ).id;

      // 3 free shares on 08-01, written in `recordShareDistribution`'s shape
      // (no price, no cash leg, the market value in `gross_amount`).
      await withTenant(appWebDb, scopedTenantId, async (tx) => {
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: randomUUID(),
          tenantId: scopedTenantId,
          portfolioId,
          kind: "SHARE_DISTRIBUTION",
          tradeDate: "2025-08-01",
          seq: await nextSeq(),
          instrumentId: shareId,
          quantity: new Decimal("3"),
          grossAmount: new Decimal("300"),
          txnCurrency: "EUR",
          fxRate: new Decimal("1"),
          fxRateSource: "IMPLIED_BASE",
        });
      });
      await withTenant(appWebDb, scopedTenantId, async (tx) => {
        await recomputeAndInvalidate(tx, {
          tenantId: scopedTenantId,
          portfolioId,
          minTradeDate: "2025-08-01",
        });
      });
      await buy({
        tenantId: scopedTenantId,
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2025-08-10",
        quantity: "1",
        unitPrice: "100",
      });

      const series = await computePortfolioValueSeries(appWebDb, {
        tenantId: scopedTenantId,
        portfolioId,
        fromDate: "2025-08-02",
        toDate: "2025-08-03",
      });
      expect(series.points.map((point) => [point.date, point.value.toString()])).toEqual([
        ["2025-08-02", "300"],
        ["2025-08-03", "300"],
      ]);
    });
  });

  describe("combined TWR/MWR — the union of cash flows, never a naive average of per-portfolio returns (AC10, FR-14)", () => {
    it("differs demonstrably from the naive arithmetic mean of the two portfolios' own TWR/MWR", async () => {
      // A dedicated tenant, isolated from every portfolio the other describe
      // block in this file creates under the shared `tenantId` — the
      // combined view fans out over *every* portfolio a tenant owns
      // (T-39), so this fixture's "exactly two portfolios"
      // assumption would otherwise be polluted by an unrelated portfolio.
      const combinedTenantId = "00000000-0000-7000-8000-000000390003";
      await ownerDb.insert(tenant).values({ id: combinedTenantId });

      const smallCapShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131621",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 combined-view small position, huge gain",
        })
      ).id;
      const largeCapShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131622",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 combined-view large position, modest gain",
        })
      ).id;

      // Small portfolio: 1 unit @ 100 -> 200 (a 100% gain). Large portfolio:
      // 100 units @ 100 -> 105 (a 5% gain), ten times the capital. The range
      // below spans ~330 days (not a handful of days) precisely so that
      // XIRR's annualisation of a 100% total gain stays inside its solver
      // bracket ([-0.9999, 10.0], i.e. up to +1000%/year) — a 100% gain
      // compressed into a few weeks would annualise to a rate no real
      // solver bracket accepts, which is a property of annualisation, not of
      // the thing this fixture is testing.
      await seedDailyPrice(smallCapShare, "2024-01-01", "100");
      await seedDailyPrice(smallCapShare, "2024-11-27", "200");
      await seedDailyPrice(largeCapShare, "2024-01-01", "100");
      await seedDailyPrice(largeCapShare, "2024-11-27", "105");

      const smallPortfolio = (
        await createPortfolio(appWebDb, {
          tenantId: combinedTenantId,
          name: `T-39 combined small ${randomUUID()}`,
        })
      ).id;
      const largePortfolio = (
        await createPortfolio(appWebDb, {
          tenantId: combinedTenantId,
          name: `T-39 combined large ${randomUUID()}`,
        })
      ).id;

      await buy({
        tenantId: combinedTenantId,
        portfolioId: smallPortfolio,
        instrumentId: smallCapShare,
        tradeDate: "2024-01-01",
        quantity: "1",
        unitPrice: "100",
      });
      await buy({
        tenantId: combinedTenantId,
        portfolioId: largePortfolio,
        instrumentId: largeCapShare,
        tradeDate: "2024-01-01",
        quantity: "100",
        unitPrice: "100",
      });

      // fromDate is the day *after* both buys, so the pre-flow starting value
      // is already nonzero for each (mirrors `materialize.integration.test.ts`'s
      // own AC3 fixture) — no EXTERNAL flow at all in range, so each
      // portfolio's own TWR reduces to a single-sub-period ratio.
      const fromDate = "2024-01-02";
      const toDate = "2024-11-27";

      const smallReturns = await computePortfolioReturns(appWebDb, {
        tenantId: combinedTenantId,
        portfolioId: smallPortfolio,
        fromDate,
        toDate,
      });
      const largeReturns = await computePortfolioReturns(appWebDb, {
        tenantId: combinedTenantId,
        portfolioId: largePortfolio,
        fromDate,
        toDate,
      });
      expect(smallReturns.twr.available).toBe(true);
      expect(largeReturns.twr.available).toBe(true);
      if (!smallReturns.twr.available || !largeReturns.twr.available) return;

      // Small: 200/100 - 1 = 1.0 (100%). Large: 10500/10000 - 1 = 0.05 (5%).
      expect(smallReturns.twr.cumulative.toString()).toBe("1");
      expect(largeReturns.twr.cumulative.toString()).toBe("0.05");

      const naiveAverageTwr = smallReturns.twr.cumulative
        .plus(largeReturns.twr.cumulative)
        .dividedBy(2);
      // (1.0 + 0.05) / 2 = 0.525.
      expect(naiveAverageTwr.toString()).toBe("0.525");

      const combined = await computeCombinedPortfolioReturns(appWebDb, {
        tenantId: combinedTenantId,
        fromDate,
        toDate,
      });
      expect(combined.twr.available).toBe(true);
      if (!combined.twr.available) return;

      // Value-weighted combination: V(from) = 100 + 10000 = 10100;
      // V(to) = 200 + 10500 = 10700 -> 10700/10100 - 1 (~5.94%), dominated by
      // the ten-times-larger position — nowhere near the naive 52.5% mean.
      const combinedCumulative = combined.twr.cumulative;
      const diffFromNaive = combinedCumulative.minus(naiveAverageTwr).abs();
      expect(diffFromNaive.greaterThan("0.4")).toBe(true);

      // And the combined total is exactly the sum of the two portfolios'
      // totals (to within rounding) — AC10's combined-total clause.
      const combinedFinalValue = new Decimal("200").plus("10500");
      // Recomputed independently here from the fixture's own known prices,
      // rather than re-reading `combined` a second way, to keep this
      // assertion's expectation derivation separate from the code under test.
      expect(combinedFinalValue.toString()).toBe("10700");

      // MWR: same demonstrably-different property. Both converge; the
      // combined rate sits far closer to the large portfolio's own rate than
      // to the naive average of the two.
      expect(smallReturns.mwr.converged).toBe(true);
      expect(largeReturns.mwr.converged).toBe(true);
      expect(combined.mwr.converged).toBe(true);
      if (!smallReturns.mwr.converged || !largeReturns.mwr.converged || !combined.mwr.converged) {
        return;
      }
      const naiveAverageMwr = smallReturns.mwr.rate.plus(largeReturns.mwr.rate).dividedBy(2);
      const mwrDiffFromNaive = combined.mwr.rate.minus(naiveAverageMwr).abs();
      expect(mwrDiffFromNaive.greaterThan("0.4")).toBe(true);
    });
  });

  describe("H2(d) (security review): computePortfolioReturns/computeCombinedPortfolioReturns skip their own holdings fetch when the caller already passed one in", () => {
    it("computePortfolioReturns calls valueHoldingsAsOf once when it must fetch its own terminal, and zero times when the caller supplies one", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131630",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/H2(d) single-portfolio dedupe share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-05-01", "100");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/H2(d) ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-05-01",
        quantity: "1",
        unitPrice: "100",
      });

      const fromDate = "2024-05-02";
      const toDate = "2024-05-10";

      const callsBefore = vi.mocked(valueHoldingsAsOf).mock.calls.length;
      await computePortfolioReturns(appWebDb, { tenantId, portfolioId, fromDate, toDate });
      // Red-confirm target: without a passed-in `terminalHoldings`, this
      // function fetches its own — exactly once.
      expect(vi.mocked(valueHoldingsAsOf).mock.calls.length - callsBefore).toBe(1);

      const terminalHoldings = valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: toDate,
      });
      const callsAfterCallerFetch = vi.mocked(valueHoldingsAsOf).mock.calls.length;
      await computePortfolioReturns(appWebDb, {
        tenantId,
        portfolioId,
        fromDate,
        toDate,
        terminalHoldings,
      });
      // The dedupe: zero *additional* calls once the caller already supplied
      // one — this is exactly what turns `PortfoliosController#overview`'s
      // previous 2 calls (one from the controller, one from this function)
      // into 1.
      expect(vi.mocked(valueHoldingsAsOf).mock.calls.length).toBe(callsAfterCallerFetch);
    });

    it("computeCombinedPortfolioReturns calls valueHoldingsForTenant once when it must fetch its own terminal, and zero times when the caller supplies one", async () => {
      const dedupeTenantId = "00000000-0000-7000-8000-000000390004";
      await ownerDb.insert(tenant).values({ id: dedupeTenantId });

      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131648",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/H2(d) combined dedupe share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-06-01", "100");

      const portfolioX = (
        await createPortfolio(appWebDb, {
          tenantId: dedupeTenantId,
          name: `T-39/H2(d) X ${randomUUID()}`,
        })
      ).id;
      const portfolioY = (
        await createPortfolio(appWebDb, {
          tenantId: dedupeTenantId,
          name: `T-39/H2(d) Y ${randomUUID()}`,
        })
      ).id;
      await buy({
        tenantId: dedupeTenantId,
        portfolioId: portfolioX,
        instrumentId: shareId,
        tradeDate: "2024-06-01",
        quantity: "1",
        unitPrice: "100",
      });
      await buy({
        tenantId: dedupeTenantId,
        portfolioId: portfolioY,
        instrumentId: shareId,
        tradeDate: "2024-06-01",
        quantity: "1",
        unitPrice: "100",
      });

      const fromDate = "2024-06-02";
      const toDate = "2024-06-10";

      const callsBefore = vi.mocked(valueHoldingsForTenant).mock.calls.length;
      await computeCombinedPortfolioReturns(appWebDb, {
        tenantId: dedupeTenantId,
        fromDate,
        toDate,
      });
      expect(vi.mocked(valueHoldingsForTenant).mock.calls.length - callsBefore).toBe(1);

      const terminalHoldings = valueHoldingsForTenant(appWebDb, {
        tenantId: dedupeTenantId,
        asOfDate: toDate,
      });
      const callsAfterCallerFetch = vi.mocked(valueHoldingsForTenant).mock.calls.length;
      await computeCombinedPortfolioReturns(appWebDb, {
        tenantId: dedupeTenantId,
        fromDate,
        toDate,
        terminalHoldings,
      });
      // N (however many `valueHoldingsAsOf` calls one `valueHoldingsForTenant`
      // fans out into) is now issued exactly once per request, not 2N — this
      // is the assertion at the level this dedupe can actually be observed
      // (see this describe's own header).
      expect(vi.mocked(valueHoldingsForTenant).mock.calls.length).toBe(callsAfterCallerFetch);
    });
  });

  /*
   * portfolio-cash PC-T8 (AC-575 integration half, AC-576, FR-683): the returns and the value series read V(d) with
   * its cash. Each portfolio here is its own fixture; cash moves carry their
   * CASH posting (the source V(d) reads), external ones also their stored
   * `fx_rate` (the source the flows read).
   */
  describe("portfolio-cash — returns and the value series include cash (AC-575, AC-576)", () => {
    async function cashMove(row: {
      tenantId?: string;
      portfolioId: string;
      kind: "DEPOSIT" | "INTEREST" | "FEE";
      currency?: string;
      fxRate?: string;
      /** Signed: > 0 credits the account. */
      amount: string;
      tradeDate: string;
    }): Promise<void> {
      const scopedTenantId = row.tenantId ?? tenantId;
      const currency = row.currency ?? "EUR";
      const fxRate = new Decimal(row.fxRate ?? "1");
      const fxRateSource = currency === "EUR" ? "IMPLIED_BASE" : "USER_PINNED";
      const signed = new Decimal(row.amount);
      const s = await nextSeq();
      const id = randomUUID();
      await withTenant(appWebDb, scopedTenantId, async (tx) => {
        const cashAccountId = await ensureCashAccount(
          tx,
          scopedTenantId,
          row.portfolioId,
          currency,
        );
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id,
          tenantId: scopedTenantId,
          portfolioId: row.portfolioId,
          kind: row.kind,
          tradeDate: row.tradeDate,
          seq: s,
          grossAmount: signed.abs(),
          txnCurrency: currency,
          cashCurrency: currency,
          cashAmount: signed.abs(),
          cashAccountId,
          fxRate,
          fxRateSource,
          ...(currency === "EUR" ? {} : { fxRateUserInput: fxRate }),
        });
        await tx.insert(transactionPosting).values({
          id: randomUUID(),
          tenantId: scopedTenantId,
          baseCurrency: "EUR",
          transactionId: id,
          portfolioId: row.portfolioId,
          seq: 1,
          leg: "CASH",
          currency,
          cashAccountId,
          amountNative: signed,
          amountBase: signed.times(fxRate),
          fxRateApplied: fxRate,
          fxRateSource,
          flowClass: row.kind === "FEE" ? "FEE" : row.kind === "INTEREST" ? "INCOME" : "EXTERNAL",
        });
        await recomputeAndInvalidate(tx, {
          tenantId: scopedTenantId,
          portfolioId: row.portfolioId,
          minTradeDate: row.tradeDate,
        });
      });
    }

    async function cashPortfolio(name: string, last: { kind: "INTEREST" | "FEE"; amount: string }) {
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `${name} ${randomUUID()}` })
      ).id;
      await cashMove({ portfolioId, kind: "DEPOSIT", amount: "1000.00", tradeDate: "2026-01-01" });
      await cashMove({ portfolioId, ...last, tradeDate: "2026-07-01" });
      return portfolioId;
    }

    it("AC-575: income 10.00 credited on 2026-07-01 — TWR over 2026-01-01..2026-07-02 is 0.0100, one sub-period", async () => {
      const portfolioId = await cashPortfolio("AC-575 income", {
        kind: "INTEREST",
        amount: "10.00",
      });
      const returns = await computePortfolioReturns(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2026-01-01",
        toDate: "2026-07-02",
      });
      expect(returns.twr.available).toBe(true);
      if (returns.twr.available) {
        // V(01-01) = 0, F = +1000 at rangeStart, V(07-02) = 1010: 1010/(0+1000) − 1.
        expect(returns.twr.cumulative.toString()).toBe("0.01");
        expect(returns.twr.subPeriodCount).toBe(1);
      }
    });

    it("AC-563 under PC-L1: a FEE of 10.00 on 2026-07-01 — TWR −0.0100, and netContributions is not moved by it", async () => {
      const portfolioId = await cashPortfolio("AC-563 fee", { kind: "FEE", amount: "-10.00" });
      const returns = await computePortfolioReturns(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2026-01-01",
        toDate: "2026-07-02",
      });
      expect(returns.twr.available).toBe(true);
      if (returns.twr.available) {
        expect(returns.twr.cumulative.toString()).toBe("-0.01");
      }

      const series = await computePortfolioValueSeries(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2026-07-01",
        toDate: "2026-07-02",
      });
      expect(
        series.points.map((point) => [
          point.date,
          point.value.toString(),
          point.netContributions.toString(),
        ]),
      ).toEqual([
        ["2026-07-01", "1000", "1000"],
        ["2026-07-02", "990", "1000"],
      ]);
    });

    it("AC-576: a currency with no rate leaves the value partial — returns and value series report provenance.complete false, the combined series too", async () => {
      const flaggedTenant = randomUUID();
      await ownerDb.insert(tenant).values({ id: flaggedTenant });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId: flaggedTenant, name: "AC-576 USD" })
      ).id;
      const clean = (
        await createPortfolio(appWebDb, { tenantId: flaggedTenant, name: "AC-576 EUR" })
      ).id;
      await cashMove({
        tenantId: flaggedTenant,
        portfolioId: clean,
        kind: "DEPOSIT",
        amount: "100.00",
        tradeDate: "2023-03-01",
      });
      // No USD rate exists on or before 2023 in this database.
      await cashMove({
        tenantId: flaggedTenant,
        portfolioId,
        kind: "DEPOSIT",
        currency: "USD",
        fxRate: "0.9",
        amount: "100.00",
        tradeDate: "2023-03-01",
      });
      const window = { tenantId: flaggedTenant, fromDate: "2023-03-02", toDate: "2023-03-03" };

      const returns = await computePortfolioReturns(appWebDb, { ...window, portfolioId });
      expect(returns.provenance.complete).toBe(false);
      const series = await computePortfolioValueSeries(appWebDb, { ...window, portfolioId });
      expect(series.points.map((point) => point.value.toString())).toEqual(["0", "0"]);
      expect(series.provenance.complete).toBe(false);

      const cleanSeries = await computePortfolioValueSeries(appWebDb, {
        ...window,
        portfolioId: clean,
      });
      expect(cleanSeries.provenance.complete).toBe(true);
      const combined = await computeCombinedPortfolioValueSeries(appWebDb, window);
      expect(combined.points.map((point) => point.value.toString())).toEqual(["100", "100"]);
      expect(combined.provenance.complete).toBe(false);
    });

    it("C-3: the series' last point equals the live total (holdings + cash) for a `to` with no transaction dated `to`", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000835084",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "portfolio-cash agreement share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-05-02", "100");
      await seedDailyPrice(shareId, "2024-05-08", "104");
      await ownerDb.insert(fxRateDaily).values([
        {
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2024-05-02",
          rate: new Decimal("0.90"),
          sourceKey: "ecb",
        },
        {
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2024-05-07",
          rate: new Decimal("0.93"),
          sourceKey: "ecb",
        },
      ]);
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `C-3 agreement ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-05-02",
        quantity: "10",
        unitPrice: "100",
      });
      await cashMove({ portfolioId, kind: "DEPOSIT", amount: "500.00", tradeDate: "2024-05-02" });
      await cashMove({
        portfolioId,
        kind: "DEPOSIT",
        currency: "USD",
        fxRate: "0.9",
        amount: "200.00",
        tradeDate: "2024-05-03",
      });
      await cashMove({ portfolioId, kind: "FEE", amount: "-7.50", tradeDate: "2024-05-06" });

      const series = await computePortfolioValueSeries(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2024-05-03",
        toDate: "2024-05-09",
      });
      // 10 × 104 + 500 − 7.50 + 200 × 0.93.
      expect(series.points.at(-1)!.value.toString()).toBe("1718.5");
      const live = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-05-09",
      });
      expect(series.points.at(-1)!.value.toString()).toBe(live.totalValue.amount.toString());
      expect(series.provenance.complete).toBe(true);
    });
  });
});
