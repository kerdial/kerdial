import {
  ensureCashAccount,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Decimal } from "@kerdial/core-decimal";
import {
  createInstrumentByIsin,
  createPortfolio,
  recomputeAndInvalidate,
  upsertManualPricePoint,
} from "@kerdial/ledger";
import {
  cashAccount,
  createDb,
  fxRateDaily,
  fxRateUser,
  instrumentPriceDaily,
  portfolio,
  tenant,
  transaction,
  transactionPosting,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TooManyHoldingsError,
  TooManyRealizedGainsError,
  valueHoldingsAsOf,
  valueHoldingsForTenant,
} from "./holdings-valuation.js";

/**
 * T-39 — `valueHoldingsAsOf`/`valueHoldingsForTenant`'s
 * correctness properties: the weighted-PMP two-portfolio combination
 * (AC10/FR-14/FR-27), `MANUAL_PRICE` propagating to the aggregate/portfolio-
 * total level (AC29/FR-39), and `fxSource: 'USER_PINNED'` vs. `'PROVIDER'`
 * (AC51/FR-65). Against a real Postgres 17 container, authenticated as
 * `app_web` — same Testcontainers bootstrap as `materialize.integration.test.ts`.
 */

describe("valuation — holdings/overview valuation with provenance (T-39, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000390001";
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

  /** A minimal, directly-inserted BUY row — mirrors `materialize.integration.test.ts`'s own `insertEurTransaction` (see that file's header for why this bypasses `TransactionWriteService`). */
  async function buy(row: {
    portfolioId: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    unitPrice: string;
    currency?: string;
    fxRate?: string;
    fxRateSource?: "IMPLIED_BASE" | "PROVIDER" | "USER_PINNED";
  }): Promise<void> {
    const s = await nextSeq();
    await withTenant(appWebDb, tenantId, async (tx) => {
      // CA-9/`0039`: a fiat-settled row names the cash account its money moved
      // through, in that leg's own currency — this helper takes a per-row
      // `currency`, so the account must follow it rather than assume EUR.
      const cashAccountId = await ensureCashAccount(
        tx,
        tenantId,
        row.portfolioId,
        row.currency ?? "EUR",
      );
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: randomUUID(),
        tenantId,
        portfolioId: row.portfolioId,
        kind: "BUY",
        tradeDate: row.tradeDate,
        seq: s,
        instrumentId: row.instrumentId,
        quantity: new Decimal(row.quantity),
        unitPrice: new Decimal(row.unitPrice),
        grossAmount: new Decimal(row.quantity).times(row.unitPrice),
        txnCurrency: row.currency ?? "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: row.currency ?? "EUR",
        cashAmount: new Decimal(row.quantity).times(row.unitPrice),
        cashAccountId,
        fxRate: new Decimal(row.fxRate ?? "1"),
        fxRateSource: row.fxRateSource ?? "IMPLIED_BASE",
      });
    });
    await withTenant(appWebDb, tenantId, async (tx) => {
      await recomputeAndInvalidate(tx, {
        tenantId,
        portfolioId: row.portfolioId,
        minTradeDate: row.tradeDate,
      });
    });
  }

  /** A minimal, directly-inserted SELL row — same shape as `buy` above, `kind: "SELL"`. */
  async function sell(row: {
    portfolioId: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    unitPrice: string;
    currency?: string;
    fxRate?: string;
    fxRateSource?: "IMPLIED_BASE" | "PROVIDER" | "USER_PINNED";
  }): Promise<void> {
    const s = await nextSeq();
    await withTenant(appWebDb, tenantId, async (tx) => {
      const cashAccountId = await ensureCashAccount(
        tx,
        tenantId,
        row.portfolioId,
        row.currency ?? "EUR",
      );
      await tx.insert(transaction).values({
        baseCurrency: "EUR",
        id: randomUUID(),
        tenantId,
        portfolioId: row.portfolioId,
        kind: "SELL",
        tradeDate: row.tradeDate,
        seq: s,
        instrumentId: row.instrumentId,
        quantity: new Decimal(row.quantity),
        unitPrice: new Decimal(row.unitPrice),
        grossAmount: new Decimal(row.quantity).times(row.unitPrice),
        txnCurrency: row.currency ?? "EUR",
        cashCurrency: row.currency ?? "EUR",
        cashAmount: new Decimal(row.quantity).times(row.unitPrice),
        cashAccountId,
        fxRate: new Decimal(row.fxRate ?? "1"),
        fxRateSource: row.fxRateSource ?? "IMPLIED_BASE",
      });
    });
    await withTenant(appWebDb, tenantId, async (tx) => {
      await recomputeAndInvalidate(tx, {
        tenantId,
        portfolioId: row.portfolioId,
        minTradeDate: row.tradeDate,
      });
    });
  }

  async function seedDailyPrice(
    instrumentId: string,
    priceDate: string,
    close: string,
    currency = "EUR",
  ): Promise<void> {
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId,
      priceDate,
      closeRaw: new Decimal(close),
      currency,
      sourceKey: "yahoo",
      quality: "EOD",
    });
  }

  describe("weighted PMP across two portfolios (AC10, FR-14, FR-27)", () => {
    it("sums quantity and recomputes PMP by division, not a naive mean of the two portfolios' PMPs", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131610",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 weighted-PMP share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-01-01", "100");

      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39 PMP A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39 PMP B ${randomUUID()}` })
      ).id;

      // A: 10 units @ 100 = cost basis 1000. B: 30 units @ 200 = cost basis 6000.
      await buy({
        portfolioId: portfolioA,
        instrumentId: shareId,
        tradeDate: "2024-01-01",
        quantity: "10",
        unitPrice: "100",
      });
      await buy({
        portfolioId: portfolioB,
        instrumentId: shareId,
        tradeDate: "2024-01-01",
        quantity: "30",
        unitPrice: "200",
      });

      const asOfDate = "2024-01-02";
      const combined = await valueHoldingsForTenant(appWebDb, { tenantId, asOfDate });

      expect(combined.holdings).toHaveLength(1);
      const holding = combined.holdings[0]!;
      expect(holding.instrumentId).toBe(shareId);
      // UR-8 (`ui-revamp`, OD-9(a)): carried through
      // `valueHoldingsForTenant`'s merge unchanged (an instrument's
      // `displayName` never varies per contributing portfolio), same as
      // `kind` immediately below.
      expect(holding.displayName).toBe("T-39 weighted-PMP share");
      // 10 + 30
      expect(holding.quantity.toString()).toBe("40");
      // Correctly weighted: (1000 + 6000) / 40 = 175 — never the naive mean
      // of the two portfolios' own PMPs, (100 + 200) / 2 = 150.
      expect(holding.pmp.amount.toString()).toBe("175");
      expect(holding.pmp.amount.toString()).not.toBe("150");
      expect(holding.costBasis.amount.toString()).toBe("7000");
    });
  });

  describe("MANUAL_PRICE propagates to the aggregate level (AC29, FR-39)", () => {
    it("a portfolio total including one manually priced OPCVM carries MANUAL_PRICE, but the automated-priced holding's own figure does not", async () => {
      const fundId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "FUND",
          isin: "FR0000131611",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 manual-priced OPCVM",
        })
      ).id;
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131612",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39 automated share",
        })
      ).id;

      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fundId,
        priceDate: "2024-02-01",
        close: new Decimal("50"),
        currency: "EUR",
      });
      await seedDailyPrice(shareId, "2024-02-01", "100");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39 manual ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: fundId,
        tradeDate: "2024-02-01",
        quantity: "10",
        unitPrice: "50",
      });
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-02-01",
        quantity: "10",
        unitPrice: "100",
      });

      const asOfDate = "2024-02-02";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });

      const fundHolding = result.holdings.find((h) => h.instrumentId === fundId)!;
      const shareHolding = result.holdings.find((h) => h.instrumentId === shareId)!;

      // UR-8 (`ui-revamp`, OD-9(a)): the single-portfolio
      // (`valueHoldingsAsOf`) path — same call site `kind` uses.
      expect(fundHolding.displayName).toBe("T-39 manual-priced OPCVM");
      expect(shareHolding.displayName).toBe("T-39 automated share");

      expect(fundHolding.currentValue.provenance.derivedFrom).toContain("MANUAL_PRICE");
      // AC29's negative clause: the automated-only holding's own figure never
      // carries the manual flag.
      expect(shareHolding.currentValue.provenance.derivedFrom).not.toContain("MANUAL_PRICE");

      // The portfolio *total* — an aggregate over both holdings — carries it,
      // even though only one of its two constituents is manually priced
      // (FR-39's "derived, in whole or in part").
      expect(result.totalValue.provenance.derivedFrom).toContain("MANUAL_PRICE");

      // AR-23 (ADR-0010): the same aggregate now carries the
      // summary a singular source label could never honestly express — and
      // carries no singular priceSource/fxSource at all, which is Stage 5's
      // own exit criterion asserted from both sides.
      expect(result.totalValue.provenance.priceSource).toBeUndefined();
      expect(result.totalValue.provenance.fxSource).toBeUndefined();
      const summary = result.totalValue.provenance.summary!;
      expect(summary.leafCount).toBe(2);
      expect(summary.manualInputCount).toBe(1);
      expect(summary.sources).toEqual(expect.arrayContaining(["manual"]));
      expect(summary.sources.length).toBeGreaterThanOrEqual(2); // manual + the automated series' own source
      // Phase 1: structurally true — the fail-loud read path guarantees every
      // constituent of an aggregate that reached this assertion was valued
      // (ADR-0010 as amended 2026-09-01).
      expect(summary.complete).toBe(true);
      // The summary's flag set IS the aggregate's own — one mergeProvenance,
      // no drift possible.
      expect(summary.derivedFrom).toEqual(
        result.totalValue.provenance.derivedFrom.filter((f) => f !== "AUTOMATED"),
      );
    });
  });

  describe("FR-263 — the day change: price-move only, previous close from the same series", () => {
    it("weekend/LOCF: on a Saturday the figure is the last session's move — Friday minus Thursday — and priceAsOf names the session", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131650",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-263 weekend share",
        })
      ).id;
      // Thursday and Friday closes; asOf is the Saturday.
      await seedDailyPrice(shareId, "2024-04-04", "100");
      await seedDailyPrice(shareId, "2024-04-05", "104");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `FR-263 weekend ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-04",
        quantity: "10",
        unitPrice: "100",
      });

      const result = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-04-06",
      });
      const holding = result.holdings[0]!;

      // 10 × (104 − 100) × 1 — the last SESSION's move, not Saturday-vs-Friday.
      expect(holding.dayChange!.amount.toString()).toBe("40");
      expect(holding.dayChangePercent!.toString()).toBe("0.04");
      expect(holding.dayChange!.provenance.priceAsOf).toBe("2024-04-05");
      // Portfolio total: every holding has one, so the sum is present.
      expect(result.dayChange!.amount.toString()).toBe("40");
      expect(result.dayChange!.provenance.summary!.leafCount).toBe(1);
    });

    it("a manual previous close badges the day change as manual — the figure carries provenance like every other valued figure", async () => {
      const fundId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "FUND",
          isin: "FR0000131651",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-263 manual fund",
        })
      ).id;
      // Previous close is a MANUAL point, current close is automated — the
      // day change depends on both observations, so it carries MANUAL_PRICE.
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fundId,
        priceDate: "2024-04-04",
        close: new Decimal("50"),
        currency: "EUR",
      });
      await seedDailyPrice(fundId, "2024-04-05", "55");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `FR-263 manual ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: fundId,
        tradeDate: "2024-04-04",
        quantity: "2",
        unitPrice: "50",
      });

      const result = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-04-05",
      });
      const holding = result.holdings[0]!;

      expect(holding.dayChange!.amount.toString()).toBe("10"); // 2 × (55 − 50)
      expect(holding.dayChange!.provenance.derivedFrom).toContain("MANUAL_PRICE");
      // …while the current VALUE's own flags are automated-only: the manual
      // contribution is the previous close's, proving the day change folds in
      // the second observation's provenance rather than copying the value's.
      expect(holding.currentValue.provenance.derivedFrom).not.toContain("MANUAL_PRICE");
    });

    it("no previous observation: the field is ABSENT — never zero — and the portfolio total is absent with it", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131652",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-263 first-ever-price share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-04-05", "100"); // the first-ever point

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `FR-263 absent ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-04-05",
        quantity: "10",
        unitPrice: "100",
      });

      const result = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-04-05",
      });

      expect(result.holdings[0]!.dayChange).toBeUndefined();
      expect(result.holdings[0]!.dayChangePercent).toBeUndefined();
      // All-or-absent at the total: one unknown holding blanks the tile
      // honestly rather than summing 9 of 10.
      expect(result.dayChange).toBeUndefined();
    });

    it("a stale current price still yields a day change, carrying the same staleness the value already discloses", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131654",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "FR-263 stale share",
        })
      ).id;
      // Two closes far in the past relative to asOf — the current price is
      // stale by the automated budget, and the figure says so.
      await seedDailyPrice(shareId, "2024-01-04", "100");
      await seedDailyPrice(shareId, "2024-01-05", "90");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `FR-263 stale ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-01-05",
        quantity: "1",
        unitPrice: "90",
      });

      const result = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-04-05",
      });
      const holding = result.holdings[0]!;

      expect(holding.dayChange!.amount.toString()).toBe("-10");
      expect(holding.dayChange!.provenance.priceIsStale).toBe(true);
    });
  });

  describe("fxSource: USER_PINNED vs. PROVIDER (AC51, FR-65)", () => {
    it("a figure using the tenant's own pinned FX rate carries fxSource USER_PINNED; an otherwise identical one using the provider series does not", async () => {
      const usdShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "US0000131613",
          exchangeMic: "XNYS",
          listingCurrency: "USD",
          displayName: "T-39 USD share (provider FX)",
        })
      ).id;
      const gbpShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "GB0000131614",
          exchangeMic: "XLON",
          listingCurrency: "GBP",
          displayName: "T-39 GBP share (tenant-pinned FX only)",
        })
      ).id;

      await seedDailyPrice(usdShare, "2024-03-01", "10", "USD");
      await seedDailyPrice(gbpShare, "2024-03-01", "10", "GBP");

      // USD is covered by the provider series (fx_rate_daily).
      await ownerDb.insert(fxRateDaily).values({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2024-03-01",
        rate: new Decimal("0.9"),
        sourceKey: "ecb",
      });
      // GBP has NO provider coverage at all — only the tenant's own pinned
      // rate (`fx_rate_user`, NFR-13's fallback).
      //
      // USD is *also* pinned, at a deliberately different rate: this file's
      // tenant is shared across tests, and every later `valueHoldingsForTenant`
      // case values this USD holding too, at a date months past the single
      // provider observation above. Since SH-6 a provider
      // series that stale no longer covers the load — the pin is what those
      // later dates resolve through, and this test's own assertion below (the
      // provider rate wins on 2024-03-02, when the series *does* cover) is
      // strengthened by the two sources disagreeing.
      await withTenant(appWebDb, tenantId, async (tx) => {
        await tx.insert(fxRateUser).values([
          {
            tenantId,
            baseCurrency: "EUR",
            quoteCurrency: "GBP",
            rateDate: "2024-03-01",
            rate: new Decimal("1.15"),
          },
          {
            tenantId,
            baseCurrency: "EUR",
            quoteCurrency: "USD",
            rateDate: "2024-03-01",
            rate: new Decimal("1.05"),
          },
        ]);
      });

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39 fx ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: usdShare,
        tradeDate: "2024-03-01",
        quantity: "1",
        unitPrice: "10",
        currency: "USD",
        fxRate: "0.9",
        fxRateSource: "PROVIDER",
      });
      await buy({
        portfolioId,
        instrumentId: gbpShare,
        tradeDate: "2024-03-01",
        quantity: "1",
        unitPrice: "10",
        currency: "GBP",
        fxRate: "1.15",
        fxRateSource: "USER_PINNED",
      });

      const asOfDate = "2024-03-02";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });

      const usdHolding = result.holdings.find((h) => h.instrumentId === usdShare)!;
      const gbpHolding = result.holdings.find((h) => h.instrumentId === gbpShare)!;

      expect(gbpHolding.currentValue.provenance.fxSource).toBe("USER_PINNED");
      expect(gbpHolding.currentValue.provenance.derivedFrom).toContain("PINNED_FX");

      expect(usdHolding.currentValue.provenance.fxSource).toBe("PROVIDER");
      expect(usdHolding.currentValue.provenance.derivedFrom).not.toContain("PINNED_FX");
    });

    it("a GBP holding split across two portfolios, both using the tenant's pinned rate, carries fxSource USER_PINNED at the combined level too", async () => {
      const gbpShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "GB0000131661",
          exchangeMic: "XLON",
          listingCurrency: "GBP",
          displayName: "T-39/L4 GBP share (combined, pinned FX)",
        })
      ).id;
      await seedDailyPrice(gbpShare, "2024-07-01", "10", "GBP");
      await withTenant(appWebDb, tenantId, async (tx) => {
        await tx.insert(fxRateUser).values({
          tenantId,
          baseCurrency: "EUR",
          quoteCurrency: "GBP",
          rateDate: "2024-07-01",
          rate: new Decimal("1.2"),
        });
      });

      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/L4 A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/L4 B ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId: portfolioA,
        instrumentId: gbpShare,
        tradeDate: "2024-07-01",
        quantity: "1",
        unitPrice: "10",
        currency: "GBP",
        fxRate: "1.2",
        fxRateSource: "USER_PINNED",
      });
      await buy({
        portfolioId: portfolioB,
        instrumentId: gbpShare,
        tradeDate: "2024-07-01",
        quantity: "2",
        unitPrice: "10",
        currency: "GBP",
        fxRate: "1.2",
        fxRateSource: "USER_PINNED",
      });

      const asOfDate = "2024-07-02";
      const combined = await valueHoldingsForTenant(appWebDb, { tenantId, asOfDate });
      const holding = combined.holdings.find((h) => h.instrumentId === gbpShare)!;

      // Red-confirm: before the fix this read `undefined` — the combined
      // merge carried only `currentPrice`'s own provenance (which never
      // carries an `fxSource` at all), silently dropping it at the combined
      // level even though every per-portfolio figure had it.
      expect(holding.currentValue.provenance.fxSource).toBe("USER_PINNED");
      expect(holding.currentValue.provenance.fxRateObservedOn).toBe("2024-07-01");
      expect(holding.currentValue.provenance.derivedFrom).toContain("PINNED_FX");
      // The unrealized figure mirrors the value figure's price/FX provenance,
      // exactly like the per-portfolio view.
      expect(holding.unrealizedGainLoss.provenance.fxSource).toBe("USER_PINNED");
    });
  });

  describe("priceIsStale reaches the aggregate, carrying the oldest constituent's priceAsOf", () => {
    it("a portfolio total whose every holding is stale is itself flagged stale, with the oldest priceAsOf of the two", async () => {
      const olderShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131620",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/M4 older-stale share",
        })
      ).id;
      const newerShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131638",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/M4 newer-stale share",
        })
      ).id;
      // Both prices are far enough before `asOfDate` (below) to exceed
      // `STALE_AFTER_DAYS` (3) — `olderShare`'s own price is additionally
      // older than `newerShare`'s, so the aggregate's `priceAsOf` must be
      // `olderShare`'s date, not `newerShare`'s (the "oldest constituent"
      // rule, not "most recent" or "first encountered").
      await seedDailyPrice(olderShare, "2024-05-01", "100");
      await seedDailyPrice(newerShare, "2024-05-10", "50");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/M4 ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: olderShare,
        tradeDate: "2024-05-01",
        quantity: "1",
        unitPrice: "100",
      });
      await buy({
        portfolioId,
        instrumentId: newerShare,
        tradeDate: "2024-05-10",
        quantity: "1",
        unitPrice: "50",
      });

      const asOfDate = "2024-06-01";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });

      const olderHolding = result.holdings.find((h) => h.instrumentId === olderShare)!;
      const newerHolding = result.holdings.find((h) => h.instrumentId === newerShare)!;
      expect(olderHolding.currentValue.provenance.priceIsStale).toBe(true);
      expect(newerHolding.currentValue.provenance.priceIsStale).toBe(true);

      // Red-confirm: before the fix, `totalValue.provenance` carried no
      // `priceIsStale`/`priceAsOf` at all (the serializer would then omit
      // them, and a client checking `priceIsStale` would read "fresh").
      expect(result.totalValue.provenance.priceIsStale).toBe(true);
      expect(result.totalValue.provenance.priceAsOf).toBe("2024-05-01");
      expect(result.totalUnrealizedGainLoss.provenance.priceIsStale).toBe(true);
      expect(result.totalUnrealizedGainLoss.provenance.priceAsOf).toBe("2024-05-01");
    });

    it("a fresh single-holding portfolio's total carries priceIsStale: false, not an omitted field", async () => {
      const freshShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131646",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/M4 fresh share",
        })
      ).id;
      await seedDailyPrice(freshShare, "2024-05-30", "20");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/M4 fresh ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: freshShare,
        tradeDate: "2024-05-30",
        quantity: "1",
        unitPrice: "20",
      });

      const asOfDate = "2024-05-31";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      expect(result.totalValue.provenance.priceIsStale).toBe(false);
      expect(result.totalValue.provenance.priceAsOf).toBe("2024-05-30");
    });
  });

  describe("a manual price ages too, on a longer (400-day) horizon", () => {
    it("a manual price older than 400 days is flagged stale; one 399 days old is not", async () => {
      const fundId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "FUND",
          isin: "FR0000131653",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L3 manual-priced OPCVM",
        })
      ).id;
      await upsertManualPricePoint(appWebDb, {
        tenantId,
        instrumentId: fundId,
        priceDate: "2023-01-01",
        close: new Decimal("50"),
        currency: "EUR",
      });

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/L3 ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: fundId,
        tradeDate: "2023-01-01",
        quantity: "1",
        unitPrice: "50",
      });

      // 2024-02-06 is 401 days after 2023-01-01 — stale.
      const staleResult = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-02-06",
      });
      const staleHolding = staleResult.holdings.find((h) => h.instrumentId === fundId)!;
      expect(staleHolding.currentValue.provenance.priceIsStale).toBe(true);

      // 2024-02-03 is 399 days after 2023-01-01 — not yet stale.
      const freshResult = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-02-03",
      });
      const freshHolding = freshResult.holdings.find((h) => h.instrumentId === fundId)!;
      expect(freshHolding.currentValue.provenance.priceIsStale).toBe(false);
    });
  });

  describe("a historical snapshot's PMP provenance ignores acquisitions after asOfDate", () => {
    it("a later USER_PINNED acquisition does not contaminate an earlier snapshot's PMP flags", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131679",
          exchangeMic: "XPAR",
          listingCurrency: "GBP",
          displayName: "T-39/L2 GBP share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-08-01", "10", "GBP");
      await seedDailyPrice(shareId, "2024-09-01", "10", "GBP");
      await ownerDb.insert(fxRateDaily).values([
        {
          baseCurrency: "EUR",
          quoteCurrency: "GBP",
          rateDate: "2024-08-01",
          rate: new Decimal("1.1"),
          sourceKey: "ecb",
        },
        {
          baseCurrency: "EUR",
          quoteCurrency: "GBP",
          rateDate: "2024-09-01",
          rate: new Decimal("1.1"),
          sourceKey: "ecb",
        },
      ]);

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/L2 ${randomUUID()}` })
      ).id;
      // First acquisition (PROVIDER-sourced FX) — the only one that should
      // count for an `asOfDate` snapshot taken before the second one.
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-08-01",
        quantity: "1",
        unitPrice: "10",
        currency: "GBP",
        fxRate: "1.1",
        fxRateSource: "PROVIDER",
      });
      // Second acquisition, dated *after* the snapshot below, using a
      // USER_PINNED rate — its `PINNED_FX` flag must not leak backwards into
      // an earlier snapshot's PMP provenance.
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-09-01",
        quantity: "1",
        unitPrice: "10",
        currency: "GBP",
        fxRate: "1.15",
        fxRateSource: "USER_PINNED",
      });

      // A snapshot as of a date strictly before the second (USER_PINNED)
      // acquisition — only the first, PROVIDER-sourced, buy has happened yet.
      const asOfDate = "2024-08-15";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      const holding = result.holdings.find((h) => h.instrumentId === shareId)!;

      expect(holding.quantity.toString()).toBe("1");
      // Red-confirm: before the fix, the acquisitions query had no upper date
      // bound, so the not-yet-happened USER_PINNED buy's flag would already
      // contaminate this earlier snapshot's PMP provenance.
      expect(holding.pmp.provenance.derivedFrom).not.toContain("PINNED_FX");
    });
  });

  describe("a response over either cap is rejected, never silently truncated", () => {
    it("rejects (TooManyHoldingsError) once a portfolio's holding count exceeds the cap", async () => {
      const shareX = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131687",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L6 holdings-cap share X",
        })
      ).id;
      const shareY = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131695",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L6 holdings-cap share Y",
        })
      ).id;
      await seedDailyPrice(shareX, "2024-10-01", "10");
      await seedDailyPrice(shareY, "2024-10-01", "10");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/L6 ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareX,
        tradeDate: "2024-10-01",
        quantity: "1",
        unitPrice: "10",
      });
      await buy({
        portfolioId,
        instrumentId: shareY,
        tradeDate: "2024-10-01",
        quantity: "1",
        unitPrice: "10",
      });

      // A real 1,000-holding fixture is impractical to seed in a test —
      // `responseCapOverrides` (test-only) proves the guard at a scale of 2.
      await expect(
        valueHoldingsAsOf(appWebDb, {
          tenantId,
          portfolioId,
          asOfDate: "2024-10-02",
          responseCapOverrides: { maxHoldings: 1 },
        }),
      ).rejects.toThrow(TooManyHoldingsError);

      // Under the real cap, the same request succeeds normally.
      const result = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-10-02",
      });
      expect(result.holdings).toHaveLength(2);
    });

    it("rejects (TooManyRealizedGainsError) once one holding's realized-gain count exceeds the cap", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131703",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L6 gains-cap share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-11-01", "10");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `T-39/L6 gains ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-11-01",
        quantity: "10",
        unitPrice: "10",
      });

      // Two separate disposals against the same holding — two realized-gain
      // rows for the one instrument.
      await withTenant(appWebDb, tenantId, async (tx) => {
        // CA-9/`0039`: `buy` above already minted this portfolio's EUR
        // account; both disposals name the same one.
        const cashAccountId = await ensureCashAccount(tx, tenantId, portfolioId, "EUR");
        await tx.insert(transaction).values([
          {
            id: randomUUID(),
            tenantId,
            baseCurrency: "EUR",
            portfolioId,
            kind: "SELL",
            tradeDate: "2024-11-02",
            seq: 9001n,
            instrumentId: shareId,
            quantity: new Decimal("1"),
            unitPrice: new Decimal("10"),
            grossAmount: new Decimal("10"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("10"),
            cashAccountId,
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          },
          {
            id: randomUUID(),
            tenantId,
            baseCurrency: "EUR",
            portfolioId,
            kind: "SELL",
            tradeDate: "2024-11-03",
            seq: 9002n,
            instrumentId: shareId,
            quantity: new Decimal("1"),
            unitPrice: new Decimal("10"),
            grossAmount: new Decimal("10"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("10"),
            cashAccountId,
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          },
        ]);
      });

      await expect(
        valueHoldingsAsOf(appWebDb, {
          tenantId,
          portfolioId,
          asOfDate: "2024-11-04",
          responseCapOverrides: { maxRealizedGainsPerHolding: 1 },
        }),
      ).rejects.toThrow(TooManyRealizedGainsError);

      const result = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-11-04",
      });
      const holding = result.holdings.find((h) => h.instrumentId === shareId)!;
      expect(holding.realizedGains).toHaveLength(2);
    });

    it("the combined view's own check catches a total that exceeds the cap even though no single portfolio does", async () => {
      const combinedCapTenantId = "00000000-0000-7000-8000-000000390005";
      await ownerDb.insert(tenant).values({ id: combinedCapTenantId });

      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131711",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L6 combined-cap share",
        })
      ).id;
      const otherShare = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131729",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L6 combined-cap other share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-12-01", "10");
      await seedDailyPrice(otherShare, "2024-12-01", "10");

      const portfolioA = (
        await createPortfolio(appWebDb, {
          tenantId: combinedCapTenantId,
          name: `T-39/L6 combined A ${randomUUID()}`,
        })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, {
          tenantId: combinedCapTenantId,
          name: `T-39/L6 combined B ${randomUUID()}`,
        })
      ).id;
      // Direct inserts, not the shared `buy` helper above (which is
      // hardcoded to this file's own outer `tenantId`) — `combinedCapTenantId`
      // is a dedicated tenant so this test's "no single portfolio exceeds the
      // cap" assumption isn't polluted by every other portfolio the rest of
      // this file creates under the shared `tenantId`. `seq` uniqueness is
      // per-tenant (migration `0013`), so these fixed values cannot collide
      // with the outer tenant's own `nextSeq()` counter.
      await withTenant(appWebDb, combinedCapTenantId, async (tx) => {
        // CA-9/`0039`: one EUR account per portfolio (FR-155 scopes an
        // account to exactly one, so two portfolios need two).
        const cashAccountA = await ensureCashAccount(tx, combinedCapTenantId, portfolioA, "EUR");
        const cashAccountB = await ensureCashAccount(tx, combinedCapTenantId, portfolioB, "EUR");
        await tx.insert(transaction).values([
          {
            id: randomUUID(),
            tenantId: combinedCapTenantId,
            baseCurrency: "EUR",
            portfolioId: portfolioA,
            kind: "BUY",
            tradeDate: "2024-12-01",
            seq: 9101n,
            instrumentId: shareId,
            quantity: new Decimal("1"),
            unitPrice: new Decimal("10"),
            grossAmount: new Decimal("10"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("10"),
            cashAccountId: cashAccountA,
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          },
          {
            id: randomUUID(),
            tenantId: combinedCapTenantId,
            baseCurrency: "EUR",
            portfolioId: portfolioB,
            kind: "BUY",
            tradeDate: "2024-12-01",
            seq: 9102n,
            instrumentId: otherShare,
            quantity: new Decimal("1"),
            unitPrice: new Decimal("10"),
            grossAmount: new Decimal("10"),
            txnCurrency: "EUR",
            // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
            cashCurrency: "EUR",
            cashAmount: new Decimal("10"),
            cashAccountId: cashAccountB,
            fxRate: new Decimal("1"),
            fxRateSource: "IMPLIED_BASE",
          },
        ]);
      });

      // Each portfolio, individually, has exactly 1 holding — well under a
      // cap of 1; only the *combined* two-instrument total exceeds it.
      await expect(
        valueHoldingsForTenant(appWebDb, {
          tenantId: combinedCapTenantId,
          asOfDate: "2024-12-02",
          responseCapOverrides: { maxHoldings: 1 },
        }),
      ).rejects.toThrow(TooManyHoldingsError);
    });
  });

  // ---------------------------------------------------------------------
  // The combined view's `realizedGains` are chronological across
  // portfolios, not per-portfolio runs. The two portfolios' legs interleave
  // in time on purpose — A: 2020-06, 2022-06; B: 2021-06, 2023-06 — so that
  // *either* fan-out order (A then B, or B then A) concatenates to a
  // non-chronological list, and the test fails under the unsorted code no
  // matter which portfolio `valueHoldingsForTenant` happens to visit first.
  // ---------------------------------------------------------------------
  describe("the combined view's realizedGains are sorted by tradeDate across portfolios", () => {
    it("two portfolios whose disposal legs interleave in time come back in one chronological list, each leg still tagged with its own portfolioId", async () => {
      const orderTenantId = "00000000-0000-7000-8000-000000440001";
      await ownerDb.insert(tenant).values({ id: orderTenantId });

      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131757",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "Interleaved-legs share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-12-01", "10");

      const portfolioA = (
        await createPortfolio(appWebDb, {
          tenantId: orderTenantId,
          name: `Interleaved A ${randomUUID()}`,
        })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, {
          tenantId: orderTenantId,
          name: `Interleaved B ${randomUUID()}`,
        })
      ).id;

      // Direct inserts on a dedicated tenant, for the same reasons as the L6
      // combined-cap test above. Each portfolio buys 3 and sells 1 twice, so
      // both still hold 1 and the instrument appears as ONE merged open line
      // carrying four disposal legs.
      const leg = (
        portfolioId: string,
        cashAccountId: string,
        kind: "BUY" | "SELL",
        tradeDate: string,
        seq: bigint,
        quantity: string,
        unitPrice: string,
      ) => ({
        id: randomUUID(),
        tenantId: orderTenantId,
        baseCurrency: "EUR" as const,
        portfolioId,
        kind,
        tradeDate,
        seq,
        instrumentId: shareId,
        quantity: new Decimal(quantity),
        unitPrice: new Decimal(unitPrice),
        grossAmount: new Decimal(quantity).times(unitPrice),
        txnCurrency: "EUR",
        // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
        cashCurrency: "EUR",
        cashAmount: new Decimal(quantity).times(unitPrice),
        cashAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE" as const,
      });
      await withTenant(appWebDb, orderTenantId, async (tx) => {
        const cashAccountA = await ensureCashAccount(tx, orderTenantId, portfolioA, "EUR");
        const cashAccountB = await ensureCashAccount(tx, orderTenantId, portfolioB, "EUR");
        await tx
          .insert(transaction)
          .values([
            leg(portfolioA, cashAccountA, "BUY", "2020-01-06", 9201n, "3", "10"),
            leg(portfolioA, cashAccountA, "SELL", "2020-06-01", 9202n, "1", "11"),
            leg(portfolioA, cashAccountA, "SELL", "2022-06-01", 9203n, "1", "12"),
            leg(portfolioB, cashAccountB, "BUY", "2021-01-04", 9204n, "3", "10"),
            leg(portfolioB, cashAccountB, "SELL", "2021-06-01", 9205n, "1", "11"),
            leg(portfolioB, cashAccountB, "SELL", "2023-06-01", 9206n, "1", "12"),
          ]);
      });

      const combined = await valueHoldingsForTenant(appWebDb, {
        tenantId: orderTenantId,
        asOfDate: "2024-12-02",
      });
      const holding = combined.holdings.find((h) => h.instrumentId === shareId)!;
      expect(holding.quantity.toString()).toBe("2");
      expect(holding.realizedGains.map((g) => [g.tradeDate, g.portfolioId])).toEqual([
        ["2020-06-01", portfolioA],
        ["2021-06-01", portfolioB],
        ["2022-06-01", portfolioA],
        ["2023-06-01", portfolioB],
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // L5 (security review): the combined view's calcEpoch is a monotonic sum
  // (+ portfolio count), not a max — see `valueHoldingsForTenant`'s own doc
  // comment (`holdings-valuation.ts`) for the full rationale. No test
  // previously exercised this directly; this is that missing regression
  // test, constructed to fail under the superseded "max" implementation.
  // ---------------------------------------------------------------------
  describe("combined calcEpoch is a monotonic sum, not a max", () => {
    it("changes when a brand-new portfolio's first-ever write lands, even though that portfolio's own epoch stays below an older, already-written portfolio's", async () => {
      const l5TenantId = "00000000-0000-7000-8000-000000390200";
      await ownerDb.insert(tenant).values({ id: l5TenantId });

      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000131737",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "T-39/L5 calcEpoch-sum share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-11-01", "10");

      // This describe's own tenant/portfolio combination — the shared `buy`
      // helper above is hardwired to the outer describe's own `tenantId`, so
      // this test (which needs its own, isolated tenant to compute an exact
      // sum-equality check) inserts directly instead.
      async function buyAsL5Tenant(row: {
        portfolioId: string;
        tradeDate: string;
        quantity: string;
        unitPrice: string;
      }): Promise<void> {
        await withTenant(appWebDb, l5TenantId, async (tx) => {
          const cashAccountId = await ensureCashAccount(tx, l5TenantId, row.portfolioId, "EUR");
          await tx.insert(transaction).values({
            baseCurrency: "EUR",
            id: randomUUID(),
            tenantId: l5TenantId,
            portfolioId: row.portfolioId,
            kind: "BUY",
            tradeDate: row.tradeDate,
            seq: await nextSeq(),
            instrumentId: shareId,
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
        await withTenant(appWebDb, l5TenantId, async (tx) => {
          await recomputeAndInvalidate(tx, {
            tenantId: l5TenantId,
            portfolioId: row.portfolioId,
            minTradeDate: row.tradeDate,
          });
        });
      }

      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId: l5TenantId, name: `T-39/L5 A ${randomUUID()}` })
      ).id;
      // Several writes to A, so its own epoch is comfortably higher than
      // any single write to a brand-new portfolio B could ever match.
      for (let i = 0; i < 5; i += 1) {
        await buyAsL5Tenant({
          portfolioId: portfolioA,
          tradeDate: "2024-11-01",
          quantity: "1",
          unitPrice: "10",
        });
      }

      // B is created (epoch 0) — the combined epoch already changes here
      // purely from `+ portfolios.length`, which is not what this test is
      // proving (see `holdings-valuation.ts`'s own doc comment for that,
      // simpler, case). This test's point starts *after* B exists.
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId: l5TenantId, name: `T-39/L5 B ${randomUUID()}` })
      ).id;

      const asOfDate = "2024-11-02";
      const before = await valueHoldingsForTenant(appWebDb, { tenantId: l5TenantId, asOfDate });

      // B's very first write — its own epoch goes from 0 to 1, still far
      // below A's epoch (5). Under the superseded "max across portfolios"
      // implementation, the combined epoch would be `max(A.epoch, B.epoch)`
      // both before and after this write (A's epoch dominates either way),
      // so it would not change at all — exactly the non-monotonic gap L5
      // fixes.
      await buyAsL5Tenant({
        portfolioId: portfolioB,
        tradeDate: "2024-11-01",
        quantity: "1",
        unitPrice: "10",
      });

      const after = await valueHoldingsForTenant(appWebDb, { tenantId: l5TenantId, asOfDate });

      expect(after.calcEpoch > before.calcEpoch).toBe(true);
      // Precisely by 1 — B's own epoch increment, since the sum design
      // means any single portfolio's epoch bump changes the combined total
      // by exactly that amount, not merely "changes it" in some direction.
      expect(after.calcEpoch - before.calcEpoch).toBe(1n);
    });
  });

  describe("mixed-currency acquisitions — a mixed-currency instrument's realizedGains[].gainNative is base-labelled", () => {
    it("labels gainNative with base currency, not the instrument's quote currency, for a mixed-currency holding", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000439",
          exchangeMic: "XPAR",
          listingCurrency: "USD", // deliberately not EUR, so a pass can't be a coincidence
          displayName: "Mixed-currency share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-03-03", "150", "USD");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-439 ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-01-02",
        quantity: "10",
        unitPrice: "100",
        currency: "EUR",
      });
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-02-02",
        quantity: "10",
        unitPrice: "120",
        currency: "USD",
        fxRate: "0.90",
      });
      await sell({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-03-02",
        quantity: "5",
        unitPrice: "150",
        currency: "EUR",
      });

      const asOfDate = "2024-03-03";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      const holding = result.holdings.find((h) => h.instrumentId === shareId)!;
      expect(holding.realizedGains).toHaveLength(1);
      expect(holding.realizedGains[0]!.gainNative.currency).toBe("EUR"); // base, not "USD"
      expect(
        holding.realizedGains[0]!.gainNative.amount.equals(
          holding.realizedGains[0]!.gainBase.amount,
        ),
      ).toBe(true);
    });
  });

  describe("gain native-currency resolution — a single-currency instrument's realizedGains[].gainNative carries its real trade currency", () => {
    it("labels gainNative with the actual trade currency, not the instrument's listing/quote currency", async () => {
      const shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FRTEST000651",
          exchangeMic: "XPAR",
          listingCurrency: "EUR", // deliberately not USD, so a pass can't be a coincidence
          displayName: "Single-currency-non-listing share",
        })
      ).id;
      await seedDailyPrice(shareId, "2024-02-03", "150", "EUR");

      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-651 ${randomUUID()}` })
      ).id;
      await buy({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-01-02",
        quantity: "10",
        unitPrice: "100",
        currency: "USD",
        fxRate: "0.90",
      });
      await sell({
        portfolioId,
        instrumentId: shareId,
        tradeDate: "2024-02-02",
        quantity: "5",
        unitPrice: "120",
        currency: "USD",
        fxRate: "0.92",
      });

      const asOfDate = "2024-02-03";
      const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      const holding = result.holdings.find((h) => h.instrumentId === shareId)!;
      expect(holding.realizedGains).toHaveLength(1);
      expect(holding.realizedGains[0]!.gainNative.currency).toBe("USD"); // real trade currency, not "EUR"
    });
  });
  /*
   * portfolio-cash PC-T6 (FR-677..681, AC-569, AC-570 API half):
   * the as-of cash block and `totalValue = Σ holdings + cash`, per portfolio
   * and tenant-wide, on its own tenant. Each predicate on the cash data path
   * can zero the cash silently, so each has a case here that fails without it:
   * `trade_date <= asOf` (the same-day FEE), archived accounts (the « Livret »
   * deposit), the archived portfolio (in the tenant sum), the tenant-wide
   * statement without a `portfolio_id` predicate (the three-portfolio sum),
   * the pricing early return (the cash-only USD portfolio), LOCF (the D-2
   * rate) and the base short-circuit (EUR needs no rate, adds no leaf).
   */
  describe("portfolio-cash — the cash block and totalValue = holdings + cash (FR-677..681, AC-569, AC-570)", () => {
    const cashTenant = "00000000-0000-7000-8000-000000835001";
    const asOfDate = "2026-03-10";
    const statements: string[] = [];
    let countingSql: postgres.Sql;
    let countingDb: Db;
    let cashSeq = 1n;

    let shareId: string;
    let portfolioH: string; // holdings 200.00 + EUR cash 975.00
    let portfolioC: string; // cash only: USD 100.00, no instrument
    let portfolioN: string; // holdings 200.00 + SEK 100.00 with no rate; archived

    async function accountFor(portfolioId: string, name: string, currency: string) {
      const id = randomUUID();
      await ownerDb
        .insert(cashAccount)
        .values({ id, tenantId: cashTenant, portfolioId, name, currency });
      return id;
    }

    /** A transaction and its one CASH posting, signed (`amount` > 0 credits). */
    async function cashMove(params: {
      portfolioId: string;
      cashAccountId: string;
      currency: string;
      kind: "DEPOSIT" | "FEE";
      amount: string;
      tradeDate: string;
    }) {
      const signed = new Decimal(params.amount);
      const fxRate = new Decimal(params.currency === "EUR" ? "1" : "0.9");
      const id = randomUUID();
      const s = cashSeq;
      cashSeq += 1n;
      await ownerDb.insert(transaction).values({
        id,
        tenantId: cashTenant,
        baseCurrency: "EUR",
        portfolioId: params.portfolioId,
        kind: params.kind,
        tradeDate: params.tradeDate,
        seq: s,
        grossAmount: signed.abs(),
        txnCurrency: params.currency,
        cashCurrency: params.currency,
        cashAmount: signed.abs(),
        cashAccountId: params.cashAccountId,
        fxRate,
        fxRateSource: params.currency === "EUR" ? "IMPLIED_BASE" : "USER_PINNED",
      });
      await ownerDb.insert(transactionPosting).values({
        id: randomUUID(),
        tenantId: cashTenant,
        baseCurrency: "EUR",
        transactionId: id,
        portfolioId: params.portfolioId,
        seq: 1,
        leg: "CASH",
        currency: params.currency,
        cashAccountId: params.cashAccountId,
        amountNative: signed,
        amountBase: signed.times(fxRate),
        fxRateApplied: fxRate,
        fxRateSource: params.currency === "EUR" ? "IMPLIED_BASE" : "USER_PINNED",
        flowClass: params.kind === "FEE" ? "FEE" : "EXTERNAL",
      });
    }

    /** 2 units @ 50 of the EUR share priced 100 — holdings 200.00 (the trade's own cash leg is not modelled here). */
    async function holdTwo(portfolioId: string) {
      const s = cashSeq;
      cashSeq += 1n;
      await ownerDb.insert(transaction).values({
        id: randomUUID(),
        tenantId: cashTenant,
        baseCurrency: "EUR",
        portfolioId,
        kind: "BUY",
        tradeDate: "2026-03-02",
        seq: s,
        instrumentId: shareId,
        quantity: new Decimal("2"),
        unitPrice: new Decimal("50"),
        grossAmount: new Decimal("100"),
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: new Decimal("100"),
        cashAccountId: await accountFor(portfolioId, `Titres ${randomUUID()}`, "EUR"),
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
      });
      await withTenant(appWebDb, cashTenant, (tx) =>
        recomputeAndInvalidate(tx, {
          tenantId: cashTenant,
          portfolioId,
          minTradeDate: "2026-03-02",
        }),
      );
    }

    /** Statements a read issued, split by the table that marks them. */
    async function measure<T>(read: () => Promise<T>) {
      statements.length = 0;
      const result = await read();
      // postgres.js's one-off type lookup on a fresh connection is not the read's.
      const all = statements.filter((q) => !q.includes("pg_catalog.pg_type"));
      return {
        result,
        total: all.length,
        cash: all.filter((q) => q.includes('"transaction_posting"')).length,
        fxProvider: all.filter((q) => q.includes('from "fx_rate_daily"')).length,
        fxUser: all.filter((q) => q.includes('from "fx_rate_user"')).length,
      };
    }

    beforeAll(async () => {
      countingSql = postgres(pg.appWebUri, {
        max: 2,
        debug: (_connection, query) => {
          statements.push(query);
        },
      });
      countingDb = createDb(countingSql);
      await ownerDb.insert(tenant).values({ id: cashTenant });

      shareId = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "FR0000835001",
          exchangeMic: "XPAR",
          listingCurrency: "EUR",
          displayName: "portfolio-cash share",
        })
      ).id;
      await seedDailyPrice(shareId, "2026-03-02", "100");
      // AC-570: one USD rate, two days before the as-of date (LOCF carries it).
      await ownerDb.insert(fxRateDaily).values({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2026-03-08",
        rate: new Decimal("0.80"),
        sourceKey: "ecb",
      });

      portfolioH = (await createPortfolio(appWebDb, { tenantId: cashTenant, name: "H" })).id;
      portfolioC = (await createPortfolio(appWebDb, { tenantId: cashTenant, name: "C" })).id;
      portfolioN = (await createPortfolio(appWebDb, { tenantId: cashTenant, name: "N" })).id;

      // H: 900 into « Courant », 100 into « Livret » (archived after), then a
      // 25.00 FEE on the as-of date itself → EUR cash 975.00.
      const courant = await accountFor(portfolioH, "Courant", "EUR");
      const livret = await accountFor(portfolioH, "Livret", "EUR");
      await holdTwo(portfolioH);
      await cashMove({
        portfolioId: portfolioH,
        cashAccountId: courant,
        currency: "EUR",
        kind: "DEPOSIT",
        amount: "900.00",
        tradeDate: "2026-03-02",
      });
      await cashMove({
        portfolioId: portfolioH,
        cashAccountId: livret,
        currency: "EUR",
        kind: "DEPOSIT",
        amount: "100.00",
        tradeDate: "2026-03-02",
      });
      await cashMove({
        portfolioId: portfolioH,
        cashAccountId: courant,
        currency: "EUR",
        kind: "FEE",
        amount: "-25.00",
        tradeDate: asOfDate,
      });
      await ownerDb
        .update(cashAccount)
        .set({ archivedAt: new Date("2026-03-05T00:00:00Z") })
        .where(eq(cashAccount.id, livret));

      // C: USD 100.00 and nothing else — no instrument at all.
      const usd = await accountFor(portfolioC, "Compte USD", "USD");
      await cashMove({
        portfolioId: portfolioC,
        cashAccountId: usd,
        currency: "USD",
        kind: "DEPOSIT",
        amount: "100.00",
        tradeDate: "2026-03-02",
      });

      // N: holdings 200.00 + SEK 100.00, a currency with no rate anywhere; the
      // portfolio itself is archived (PC-L13: still in the tenant total).
      const sek = await accountFor(portfolioN, "Compte SEK", "SEK");
      await holdTwo(portfolioN);
      await cashMove({
        portfolioId: portfolioN,
        cashAccountId: sek,
        currency: "SEK",
        kind: "DEPOSIT",
        amount: "100.00",
        tradeDate: "2026-03-02",
      });
      await ownerDb
        .update(portfolio)
        .set({ archivedAt: new Date("2026-03-05T00:00:00Z") })
        .where(eq(portfolio.id, portfolioN));
    }, 120_000);

    afterAll(async () => {
      await countingSql?.end({ timeout: 5 });
    }, 30_000);

    it("H: totalValue 1175 = holdings 200 + EUR cash 975 — the same-day FEE and the archived account's deposit both count; one more statement than without cash", async () => {
      const read = (cash: "include" | "omit") =>
        measure(() =>
          valueHoldingsAsOf(countingDb, {
            tenantId: cashTenant,
            portfolioId: portfolioH,
            asOfDate,
            cash,
          }),
        );
      const included = await read("include");
      const omitted = await read("omit");
      const h = included.result;

      expect(h.holdings).toHaveLength(1);
      expect(h.cash.unconverted).toEqual([]);
      expect(
        h.cash.byCurrency.map((l) => [
          l.currency,
          l.amount.toString(),
          l.rate?.toString(),
          l.rateObservedOn,
          l.valueBase?.toString(),
        ]),
      ).toEqual([["EUR", "975", "1", undefined, "975"]]);
      expect(h.holdings[0]!.currentValue.amount.toString()).toBe("200");
      expect(h.cash.totalValueBase.toString()).toBe("975");
      expect(h.totalValue.amount.toString()).toBe("1175");
      // Unchanged by cash (FR-678): unrealized and cost basis are the holding's.
      expect(h.totalUnrealizedGainLoss.amount.toString()).toBe("100");
      // EUR cash adds no provenance leaf.
      expect(h.totalValue.provenance.summary?.leafCount).toBe(1);
      expect(h.totalValue.provenance.summary?.complete).toBe(true);

      // NFR-91: +1 statement, and it is the cash one; no FX for EUR.
      expect(included.cash).toBe(1);
      expect(omitted.cash).toBe(0);
      expect(included.total - omitted.total).toBe(1);
      expect(included.fxProvider).toBe(0);
      // `omit` leaves the cash out of the total entirely.
      expect(omitted.result.totalValue.amount.toString()).toBe("200");
    });

    it("H the day before: the FEE dated asOf is not in yet — 1200, as-of postings, not the current balance", async () => {
      const h = await valueHoldingsAsOf(appWebDb, {
        tenantId: cashTenant,
        portfolioId: portfolioH,
        asOfDate: "2026-03-09",
      });
      expect(h.cash.totalValueBase.toString()).toBe("1000");
      expect(h.totalValue.amount.toString()).toBe("1200");
    });

    it("C, cash only: USD 100 converts at the D-2 rate (80, rate 0.8, observed 2026-03-08) — the FX load runs with no instrument", async () => {
      const read = (cash: "include" | "omit") =>
        measure(() =>
          valueHoldingsAsOf(countingDb, {
            tenantId: cashTenant,
            portfolioId: portfolioC,
            asOfDate,
            cash,
          }),
        );
      const included = await read("include");
      const omitted = await read("omit");
      const c = included.result;

      expect(c.holdings).toEqual([]);
      expect(c.cash.unconverted).toEqual([]);
      expect(c.cash.byCurrency).toHaveLength(1);
      const usd = c.cash.byCurrency[0]!;
      expect(usd.currency).toBe("USD");
      expect(usd.amount.toString()).toBe("100");
      expect(usd.rate?.toString()).toBe("0.8");
      expect(usd.rateObservedOn).toBe("2026-03-08");
      expect(usd.valueBase?.toString()).toBe("80");
      expect(c.totalValue.amount.toString()).toBe("80");
      const summary = c.totalValue.provenance.summary!;
      expect(summary.leafCount).toBe(1);
      expect(summary.carriedFxPresent).toBe(true);
      expect(summary.complete).toBe(true);

      // +1 cash statement, +1 FX statement (a cash-only non-base currency had none before).
      expect(included.cash).toBe(1);
      expect(included.fxProvider).toBe(1);
      expect(included.fxUser).toBe(0);
      expect(included.total - omitted.total).toBe(2);
    });

    it("N, no rate: SEK is left out and listed, the total is the holdings' 200, provenance incomplete — never a throw", async () => {
      const n = await valueHoldingsAsOf(appWebDb, {
        tenantId: cashTenant,
        portfolioId: portfolioN,
        asOfDate,
      });
      expect(n.cash.unconverted).toEqual(["SEK"]);
      expect(n.cash.byCurrency.map((l) => [l.currency, l.amount.toString(), l.valueBase])).toEqual([
        ["SEK", "100", undefined],
      ]);
      expect(n.cash.totalValueBase.toString()).toBe("0");
      expect(n.totalValue.amount.toString()).toBe("200");
      expect(n.totalValue.provenance.summary?.complete).toBe(false);
      expect(n.totalValue.provenance.summary?.leafCount).toBe(2);
    });

    it("tenant-wide: the three per-portfolio totals add exactly (archived portfolio included), with ONE cash statement and ONE FX load for all three", async () => {
      const perPortfolio = await Promise.all(
        [portfolioH, portfolioC, portfolioN].map((portfolioId) =>
          valueHoldingsAsOf(appWebDb, { tenantId: cashTenant, portfolioId, asOfDate }),
        ),
      );
      const sum = perPortfolio.reduce((acc, p) => acc.plus(p.totalValue.amount), new Decimal(0));
      expect(sum.toString()).toBe("1455");

      const {
        result: tenantWide,
        cash,
        fxProvider,
        fxUser,
      } = await measure(() =>
        valueHoldingsForTenant(countingDb, { tenantId: cashTenant, asOfDate }),
      );

      expect(tenantWide.portfolioCount).toBe(3);
      expect(
        tenantWide.cash.byCurrency.map((l) => [
          l.currency,
          l.amount.toString(),
          l.valueBase?.toString(),
        ]),
      ).toEqual([
        ["EUR", "975", "975"],
        ["SEK", "100", undefined],
        ["USD", "100", "80"],
      ]);
      expect(tenantWide.cash.totalValueBase.toString()).toBe("1055");
      expect(tenantWide.cash.unconverted).toEqual(["SEK"]);
      // 200 (H) + 200 (N) merged holdings + 1055 cash = 1455 = Σ per portfolio.
      expect(tenantWide.totalValue.amount.toString()).toBe("1455");
      expect(tenantWide.totalValue.amount.toString()).toBe(sum.toString());
      expect(tenantWide.totalValue.provenance.summary?.complete).toBe(false);

      // NFR-91: one grouped cash statement for the tenant, not one per
      // portfolio; one provider FX statement (USD and SEK together) plus the
      // tenant-rate fallback for SEK, which the provider does not cover.
      expect(cash).toBe(1);
      expect(fxProvider).toBe(1);
      expect(fxUser).toBe(1);
    });
  });
});
