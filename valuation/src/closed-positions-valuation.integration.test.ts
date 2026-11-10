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
  createInstrumentBySymbol,
  createPortfolio,
  recomputeAndInvalidate,
} from "@kerdial/ledger";
import {
  createDb,
  instrumentPriceDaily,
  tenant,
  transaction,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// T-51: imported through the **package barrel**, not the defining module,
// deliberately — `api` (T-53) and `web` (T-56) reach these six symbols exactly
// this way, so importing them here is what proves `valuation/src/index.ts`
// actually re-exports the surface T-51 requires rather than merely appearing
// to. `instanceof` still works: the barrel re-exports the same module instance.
import {
  MAX_CLOSED_POSITIONS_PER_VIEW,
  MAX_SALE_LOTS_PER_CLOSED_POSITION,
  TooManyClosedPositionsError,
  TooManySaleLotsError,
  valueClosedPositionsAsOf,
  valueClosedPositionsForTenant,
  type ValuedClosedPosition,
  type ValuedClosedPositions,
} from "./index.js";
import { valueHoldingsAsOf, valueHoldingsForTenant } from "./holdings-valuation.js";

/**
 * Batch B of the `closed-positions` cycle — T-49/T-50/T-51's own acceptance
 * criteria and T-52's gate, against a real Postgres 17 container authenticated
 * as `app_web` (the same Testcontainers bootstrap
 * `holdings-valuation.integration.test.ts` uses).
 *
 * The three arithmetic fixtures below are **T-47's own**, transcribed from
 * `core/domain/src/closed-positions.test.ts` together with their hand
 * calculations and their hand-computed expected totals — re-run here through
 * the real DB loader (T-52's "confirm the loader wiring didn't disturb the
 * arithmetic T-47 already proved"). Every expected figure is still the
 * hand-derived one, never a capture of this path's own output.
 *
 * Also covers: the load-bearing "never prices anything" property (proven
 * with a fixture that has **no** price series at all, not asserted in a
 * comment), AC-322 in both directions (the per-portfolio re-bought case and
 * CP-4's cross-portfolio trap), CP-10's merged chronological sale-lot sort,
 * CP-11's ordering, A2's shared currency label, and FR-333/OD-4's caps
 * including R6's merged-only lot overflow.
 */

describe("valuation — closed positions (Batch B, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  /** The default tenant for the single-portfolio cases; every combined-view case mints its own so `listPortfolios` sees exactly its fixture. */
  const tenantId = "00000000-0000-7000-8000-000000440001";
  let seq = 1n;
  let isinCounter = 0;

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

  async function newTenant(): Promise<string> {
    const id = randomUUID();
    await ownerDb.insert(tenant).values({ id });
    return id;
  }

  /** A fresh instrument. The ISIN is only a uniqueness key here — nothing on this path validates its check digit. */
  async function newInstrument(params: {
    displayName: string;
    listingCurrency?: string;
    kind?: "SHARE" | "FUND";
  }): Promise<string> {
    isinCounter += 1;
    const suffix = String(isinCounter).padStart(9, "0");
    return (
      await createInstrumentByIsin(appWebDb, {
        kind: params.kind ?? "SHARE",
        isin: `XX${suffix}0`,
        exchangeMic: "XPAR",
        listingCurrency: params.listingCurrency ?? "EUR",
        displayName: params.displayName,
      })
    ).id;
  }

  /**
   * A directly-inserted BUY/SELL row — mirrors
   * `holdings-valuation.integration.test.ts`'s own `buy` helper (see that
   * file's header for why these bypass `TransactionWriteService`), widened to
   * carry `kind` so a fixture can close a position.
   */
  async function trade(row: {
    kind: "BUY" | "SELL";
    tenantId?: string;
    portfolioId: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    unitPrice: string;
    currency?: string;
    fxRate?: string;
  }): Promise<void> {
    const owner = row.tenantId ?? tenantId;
    const currency = row.currency ?? "EUR";
    const gross = new Decimal(row.quantity).times(row.unitPrice);
    const s = seq;
    seq += 1n;
    await withTenant(appWebDb, owner, async (tx) => {
      const cashAccountId = await ensureCashAccount(tx, owner, row.portfolioId, currency);
      await tx.insert(transaction).values({
        id: randomUUID(),
        tenantId: owner,
        baseCurrency: "EUR",
        portfolioId: row.portfolioId,
        kind: row.kind,
        tradeDate: row.tradeDate,
        seq: s,
        instrumentId: row.instrumentId,
        quantity: new Decimal(row.quantity),
        unitPrice: new Decimal(row.unitPrice),
        grossAmount: gross,
        txnCurrency: currency,
        cashCurrency: currency,
        cashAmount: gross,
        cashAccountId,
        fxRate: new Decimal(row.fxRate ?? "1"),
        fxRateSource: "IMPLIED_BASE",
      });
    });
    await withTenant(appWebDb, owner, async (tx) => {
      await recomputeAndInvalidate(tx, {
        tenantId: owner,
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

  // =========================================================================
  // T-51 — the barrel surface itself.
  // =========================================================================

  describe("T-51/FR-336 — the barrel exposes a cap surface distinct from the holdings one", () => {
    it("re-exports both constants at 1000 and two separately-typed error classes", () => {
      expect(MAX_CLOSED_POSITIONS_PER_VIEW).toBe(1000);
      expect(MAX_SALE_LOTS_PER_CLOSED_POSITION).toBe(1000);

      const tooManyPositions = new TooManyClosedPositionsError(1001);
      expect(tooManyPositions).toBeInstanceOf(Error);
      expect(tooManyPositions.name).toBe("TooManyClosedPositionsError");
      expect(tooManyPositions.count).toBe(1001);
      expect(tooManyPositions.limit).toBe(MAX_CLOSED_POSITIONS_PER_VIEW);

      const tooManyLots = new TooManySaleLotsError("instrument-1", 1001);
      expect(tooManyLots.name).toBe("TooManySaleLotsError");
      expect(tooManyLots.instrumentId).toBe("instrument-1");
      expect(tooManyLots.count).toBe(1001);
      expect(tooManyLots.limit).toBe(MAX_SALE_LOTS_PER_CLOSED_POSITION);

      // Distinct classes and distinct messages, so `api`'s `instanceof` arms
      // (T-53) can tell them apart even though CP-5 maps both to one code.
      expect(tooManyPositions.message).not.toBe(tooManyLots.message);
      expect(tooManyPositions).not.toBeInstanceOf(TooManySaleLotsError);
      expect(tooManyLots).not.toBeInstanceOf(TooManyClosedPositionsError);
    });
  });

  // =========================================================================
  // AC-319 — T-47's known-answer fixture, now through the real DB loader.
  // =========================================================================

  /**
   * T-47's `CLOSED_KNOWN_ANSWER`, verbatim (see
   * `core/domain/src/closed-positions.test.ts` for the full hand calculation):
   * a USD-denominated instrument in a EUR-base portfolio, bought twice at two
   * stored FX rates and sold out in two legs.
   *
   *   Buy  100 @ 10 USD, fx 0.90 → cost_native 1000, cost_base 900
   *   Buy  200 @ 10 USD, fx 0.75 → cost_native 3000, cost_base 2400, pmp_base 8
   *   Sell 100 @ 12 USD, fx 0.85 → gain_base 220, gain_native 200, fx 60, disposed 800
   *   Sell 200 @ 9.5 USD, fx 0.95 → gain_base 205, gain_native −100, fx 285, disposed 1600
   *
   *   Σ 425 base · 100 native · 345 fx · 2400 disposed cost basis
   */
  describe("AC-319 (valuation-level re-verification): the four summed totals survive the DB loader", () => {
    it("matches T-47's hand-computed totals exactly, through valueClosedPositionsAsOf", async () => {
      const instrumentId = await newInstrument({
        displayName: "AC-319 known-answer share",
        listingCurrency: "USD",
      });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `AC-319 ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-02",
        quantity: "100",
        unitPrice: "10",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-02",
        quantity: "200",
        unitPrice: "10",
        currency: "USD",
        fxRate: "0.75",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-03-01",
        quantity: "100",
        unitPrice: "12",
        currency: "USD",
        fxRate: "0.85",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-04-01",
        quantity: "200",
        unitPrice: "9.5",
        currency: "USD",
        fxRate: "0.95",
      });

      const asOfDate = "2024-05-01";
      const view: ValuedClosedPositions = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate,
      });

      expect(view.asOfDate).toBe(asOfDate);
      expect(view.baseCurrency).toBe("EUR");
      expect(view.portfolioCount).toBe(1);
      expect(view.closedPositions).toHaveLength(1);

      const position: ValuedClosedPosition = view.closedPositions[0]!;
      expect(position.instrumentId).toBe(instrumentId);
      expect(position.displayName).toBe("AC-319 known-answer share");
      expect(position.kind).toBe("SHARE");
      expect(position.hasIcon).toBe(false);

      // Hand-computed in T-47; asserted exactly, not within a tolerance.
      expect(position.totalRealizedGainBase.amount.toFixed()).toBe("425");
      expect(position.totalRealizedGainNative.amount.toFixed()).toBe("100");
      expect(position.totalFxComponentBase.amount.toFixed()).toBe("345");
      expect(position.totalDisposedCostBasisBase.amount.toFixed()).toBe("2400");

      // CP-3/A2: the base figures are labelled with the tenant's ledger base,
      // the native one with the instrument's **listing** currency — never a
      // leg's `txn_currency`.
      expect(position.currency).toBe("USD");
      expect(position.totalRealizedGainBase.currency).toBe("EUR");
      expect(position.totalRealizedGainNative.currency).toBe("USD");
      expect(position.totalFxComponentBase.currency).toBe("EUR");
      expect(position.totalDisposedCostBasisBase.currency).toBe("EUR");

      // FR-329/FR-330: both legs, itemised, in `computeRealizedGains`'s own order.
      expect(position.realizedGains).toHaveLength(2);
      expect(position.realizedGains.map((g) => g.tradeDate)).toEqual(["2024-03-01", "2024-04-01"]);
      expect(position.realizedGains.map((g) => g.gainBase.amount.toFixed())).toEqual([
        "220",
        "205",
      ]);
      expect(position.realizedGains.every((g) => g.portfolioId === portfolioId)).toBe(true);

      // AC-319's simultaneity, at this layer: the same instrument is absent
      // from the open-holdings response for the same portfolio and date.
      const holdings = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      expect(holdings.holdings.map((h) => h.instrumentId)).not.toContain(instrumentId);

      // FR-328: one shared envelope over all four figures, carrying only
      // `derivedFrom` — no price/FX fields, no aggregate summary.
      const provenance = position.totalRealizedGainBase.provenance;
      expect(position.totalRealizedGainNative.provenance).toBe(provenance);
      expect(position.totalFxComponentBase.provenance).toBe(provenance);
      expect(position.totalDisposedCostBasisBase.provenance).toBe(provenance);
      expect(provenance.derivedFrom).toEqual(["AUTOMATED"]);
      expect(provenance.priceSource).toBeUndefined();
      expect(provenance.priceQuality).toBeUndefined();
      expect(provenance.priceAsOf).toBeUndefined();
      expect(provenance.priceIsStale).toBeUndefined();
      expect(provenance.fxSource).toBeUndefined();
      expect(provenance.fxRateObservedOn).toBeUndefined();
      expect(provenance.summary).toBeUndefined();

      // FR-327/CP-9: the server ships the raw figures and nothing derived from
      // them — no percentage string, no view-level total, no quantity, no PMP.
      const wireKeys = Object.keys(position).sort();
      expect(wireKeys).toEqual([
        "currency",
        "displayName",
        "hasIcon",
        "instrumentId",
        "kind",
        "realizedGains",
        "totalDisposedCostBasisBase",
        "totalFxComponentBase",
        "totalRealizedGainBase",
        "totalRealizedGainNative",
      ]);
      expect(Object.keys(view).sort()).toEqual([
        "asOfDate",
        "baseCurrency",
        "calcEpoch",
        "closedPositions",
        "portfolioCount",
      ]);
    });
  });

  // =========================================================================
  // AC-320 — the degenerate denominator, through the real loader.
  // =========================================================================

  /**
   * T-47's `DEGENERATE_DENOMINATOR`, verbatim: 50 units acquired at 4 USD with
   * a stored `fx_rate` of exactly 0, so `pmp_unit_base_at_sale` is zero while
   * `cost_basis_native` is not (the shape that avoids `computeRealizedGains`'s
   * own pre-existing `0 / 0` `acq_rate`).
   *
   *   Sell 20 @ 6 USD, fx 0.9 → gain_base 108, gain_native 40, fx 108, disposed 0
   *   Sell 30 @ 5 USD, fx 0.8 → gain_base 120, gain_native 30, fx 120, disposed 0
   *   Σ 228 base · 70 native · 228 fx · **0** disposed cost basis
   */
  describe("AC-320 (valuation-level): a zero disposed cost basis reaches the caller as exactly 0", () => {
    it("never NaN, never Infinity, never coerced to a fabricated non-zero denominator", async () => {
      const instrumentId = await newInstrument({
        displayName: "AC-320 degenerate share",
        listingCurrency: "USD",
      });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `AC-320 ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-02",
        quantity: "50",
        unitPrice: "4",
        currency: "USD",
        fxRate: "0",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-02",
        quantity: "20",
        unitPrice: "6",
        currency: "USD",
        fxRate: "0.9",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-03-03",
        quantity: "30",
        unitPrice: "5",
        currency: "USD",
        fxRate: "0.8",
      });

      const view = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-04-01",
      });
      const position = view.closedPositions.find((p) => p.instrumentId === instrumentId)!;

      const denominator = position.totalDisposedCostBasisBase.amount;
      expect(denominator.toFixed()).toBe("0");
      expect(denominator.isZero()).toBe(true);
      expect(denominator.isNaN()).toBe(false);
      expect(denominator.isFinite()).toBe(true);

      // The numerator is a real, finite figure — only the percentage a client
      // would compute from the pair is undefined (rendered `—` in `web`).
      expect(position.totalRealizedGainBase.amount.toFixed()).toBe("228");
      expect(position.totalRealizedGainNative.amount.toFixed()).toBe("70");
      expect(position.totalFxComponentBase.amount.toFixed()).toBe("228");
    });
  });

  // =========================================================================
  // AC-321 — multi-episode, through the real loader.
  // =========================================================================

  /**
   * T-47's `MULTI_EPISODE`, verbatim: bought, sold out, bought again, sold out
   * again. One running position, therefore **one** entry — no episode
   * segmentation anywhere in this feature.
   *
   *   Σ 172 base · 40 native · 192 fx · 1700 disposed cost basis, two legs.
   */
  describe("AC-321 (valuation-level): a re-bought-and-re-sold instrument is one entry", () => {
    it("produces one closed position whose legs and totals span both episodes", async () => {
      const instrumentId = await newInstrument({
        displayName: "AC-321 multi-episode share",
        listingCurrency: "USD",
      });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `AC-321 ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2023-01-10",
        quantity: "10",
        unitPrice: "100",
        currency: "USD",
        fxRate: "0.5",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2023-06-10",
        quantity: "10",
        unitPrice: "120",
        currency: "USD",
        fxRate: "0.6",
      });
      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-01",
        quantity: "20",
        unitPrice: "80",
        currency: "USD",
        fxRate: "0.75",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-09-01",
        quantity: "20",
        unitPrice: "72",
        currency: "USD",
        fxRate: "0.8",
      });

      const view = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-10-01",
      });
      expect(view.closedPositions).toHaveLength(1);
      const position = view.closedPositions[0]!;

      expect(position.realizedGains).toHaveLength(2);
      expect(position.realizedGains.map((g) => g.tradeDate)).toEqual(["2023-06-10", "2024-09-01"]);
      expect(position.totalRealizedGainBase.amount.toFixed()).toBe("172");
      expect(position.totalRealizedGainNative.amount.toFixed()).toBe("40");
      expect(position.totalFxComponentBase.amount.toFixed()).toBe("192");
      expect(position.totalDisposedCostBasisBase.amount.toFixed()).toBe("1700");
    });
  });

  // =========================================================================
  // This path never prices anything, proven rather than asserted.
  // =========================================================================

  describe("never calls valuePortfolio, so no price/FX resolution can fail it", () => {
    it("returns a fully-divested instrument that has NO price series at all", async () => {
      const instrumentId = await newInstrument({ displayName: "Unpriced closed share" });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `Unpriced ${randomUUID()}` })
      ).id;

      // Deliberately no `seedDailyPrice`, no manual price, no FX row.
      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-05",
        quantity: "10",
        unitPrice: "20",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-05",
        quantity: "10",
        unitPrice: "30",
      });

      const view = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-03-05",
      });
      const position = view.closedPositions.find((p) => p.instrumentId === instrumentId)!;
      expect(position.totalRealizedGainBase.amount.toFixed()).toBe("100");
    });

    it("still succeeds when a DIFFERENT, still-open holding in the same portfolio is unpriceable", async () => {
      const closedId = await newInstrument({ displayName: "Closed alongside unpriceable" });
      const openId = await newInstrument({ displayName: "Unpriceable open holding" });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `Unpriceable mix ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId: closedId,
        tradeDate: "2024-01-05",
        quantity: "10",
        unitPrice: "20",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId: closedId,
        tradeDate: "2024-02-05",
        quantity: "10",
        unitPrice: "25",
      });
      // Open, and with no price series — the open path cannot value it.
      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId: openId,
        tradeDate: "2024-01-06",
        quantity: "3",
        unitPrice: "40",
      });

      const asOfDate = "2024-03-05";
      // The open-holdings read fails, as it must — this is the state the
      // "Ouvertes" tab renders as `valuation-price-unavailable`.
      await expect(
        valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate }),
      ).rejects.toThrow();
      // The closed-positions read is unaffected. This is the whole point:
      // a historical realized-result read must not fail because some other,
      // still-open holding is currently unpriceable.
      const view = await valueClosedPositionsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      expect(view.closedPositions.map((p) => p.instrumentId)).toEqual([closedId]);
      expect(view.closedPositions[0]!.totalRealizedGainBase.amount.toFixed()).toBe("50");
    });
  });

  // =========================================================================
  // AC-322 — both directions.
  // =========================================================================

  describe("AC-322 (per-portfolio half): sold to zero then re-bought in the SAME portfolio", () => {
    it("is absent from the closed-positions view and present in the holdings view", async () => {
      const instrumentId = await newInstrument({ displayName: "AC-322 re-bought share" });
      await seedDailyPrice(instrumentId, "2024-05-01", "70");
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `AC-322 same-pf ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-10",
        quantity: "10",
        unitPrice: "50",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-10",
        quantity: "10",
        unitPrice: "60",
      });
      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-03-10",
        quantity: "4",
        unitPrice: "65",
      });

      const asOfDate = "2024-05-02";
      const closed = await valueClosedPositionsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      const open = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });

      expect(closed.closedPositions.map((p) => p.instrumentId)).not.toContain(instrumentId);
      expect(open.holdings.map((h) => h.instrumentId)).toContain(instrumentId);
      // NG6: the pre-re-purchase disposal leg is not lost — it lives on the
      // still-open holding, where it already did before this feature.
      expect(
        open.holdings.find((h) => h.instrumentId === instrumentId)!.realizedGains,
      ).toHaveLength(1);
    });
  });

  describe("CP-4 (the cross-portfolio trap): closed in A, still open in B", () => {
    it("is absent from valueClosedPositionsForTenant entirely, and present as one merged open line in valueHoldingsForTenant", async () => {
      const cpTenantId = await newTenant();
      const crossId = await newInstrument({ displayName: "CP-4 cross-portfolio share" });
      const soloId = await newInstrument({ displayName: "CP-4 genuinely closed share" });
      await seedDailyPrice(crossId, "2024-05-01", "70");
      await seedDailyPrice(soloId, "2024-05-01", "70");

      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId: cpTenantId, name: `CP-4 A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId: cpTenantId, name: `CP-4 B ${randomUUID()}` })
      ).id;

      // X: fully sold in A …
      await trade({
        kind: "BUY",
        tenantId: cpTenantId,
        portfolioId: portfolioA,
        instrumentId: crossId,
        tradeDate: "2024-01-10",
        quantity: "10",
        unitPrice: "50",
      });
      await trade({
        kind: "SELL",
        tenantId: cpTenantId,
        portfolioId: portfolioA,
        instrumentId: crossId,
        tradeDate: "2024-02-10",
        quantity: "10",
        unitPrice: "60",
      });
      // … and still open in B, same tenant.
      await trade({
        kind: "BUY",
        tenantId: cpTenantId,
        portfolioId: portfolioB,
        instrumentId: crossId,
        tradeDate: "2024-01-20",
        quantity: "6",
        unitPrice: "55",
      });
      // A control instrument, closed in A and traded nowhere else, so the
      // absence asserted below is membership and not an empty response.
      await trade({
        kind: "BUY",
        tenantId: cpTenantId,
        portfolioId: portfolioA,
        instrumentId: soloId,
        tradeDate: "2024-01-11",
        quantity: "8",
        unitPrice: "20",
      });
      await trade({
        kind: "SELL",
        tenantId: cpTenantId,
        portfolioId: portfolioA,
        instrumentId: soloId,
        tradeDate: "2024-02-11",
        quantity: "8",
        unitPrice: "30",
      });

      const asOfDate = "2024-05-02";
      const combinedClosed = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: cpTenantId,
        asOfDate,
      });
      const combinedOpen = await valueHoldingsForTenant(appWebDb, {
        tenantId: cpTenantId,
        asOfDate,
      });

      // The trap: X is open somewhere, so it is not a closed position anywhere.
      expect(combinedClosed.closedPositions.map((p) => p.instrumentId)).toEqual([soloId]);
      // …while the open view shows it as exactly one merged line.
      const openLines = combinedOpen.holdings.filter((h) => h.instrumentId === crossId);
      expect(openLines).toHaveLength(1);
      expect(openLines[0]!.quantity.toFixed()).toBe("6");
      /**
       * **Measured, and it is NOT what was predicted** — recorded here
       * rather than asserted the way the prediction words it.
       *
       * The prediction was that "its A-side disposal legs are not lost:
       * `valueHoldingsForTenant` already concatenates every contributing
       * portfolio's `realizedGains` onto the merged open holding, which is the
       * NG6 home for a leg on a still-open instrument." That holds only when A
       * *contributes a holding*. Here it does not: X's replayed quantity in A
       * is zero, so `computePmp` drops it, `assembleHoldings` never emits a
       * `ValuedHolding` for it, and the merge loop — which iterates each
       * portfolio's `holdings` — never sees A's legs at all. The merged open
       * line therefore carries **B's** realized gains only, which is none.
       *
       * So under CP-4 exactly, A's disposal legs are absent from *both*
       * tenant-wide responses. They remain reachable on both per-portfolio
       * responses (asserted immediately below). This is a pre-existing property
       * of `valueHoldingsForTenant`, not something this batch changed — that
       * function is untouched, and it is under FR-335's byte-for-byte guarantee
       * — so it is pinned here as an honest characterisation and filed as a
       * finding rather than "fixed" under that guarantee.
       */
      expect(openLines[0]!.realizedGains).toHaveLength(0);

      // The per-portfolio view still reports X as closed **in A** — CP-4 is a
      // combined-level membership rule, not a per-portfolio one.
      const perPortfolioA = await valueClosedPositionsAsOf(appWebDb, {
        tenantId: cpTenantId,
        portfolioId: portfolioA,
        asOfDate,
      });
      expect(perPortfolioA.closedPositions.map((p) => p.instrumentId).sort()).toEqual(
        [crossId, soloId].sort(),
      );
      // …and that is where A's disposal legs remain reachable (see the note above).
      expect(
        perPortfolioA.closedPositions.find((p) => p.instrumentId === crossId)!.realizedGains,
      ).toHaveLength(1);

      // L5: the combined epoch is the identical rule the holdings view uses,
      // so one freshness check keys both responses.
      expect(combinedClosed.calcEpoch).toBe(combinedOpen.calcEpoch);
      expect(combinedClosed.portfolioCount).toBe(2);
      expect(combinedClosed.baseCurrency).toBe("EUR");

      // A2: the same instrument reports the same `currency` on both surfaces.
      const openInB = await valueHoldingsAsOf(appWebDb, {
        tenantId: cpTenantId,
        portfolioId: portfolioB,
        asOfDate,
      });
      const closedInA = perPortfolioA.closedPositions.find((p) => p.instrumentId === crossId)!;
      expect(closedInA.currency).toBe(
        openInB.holdings.find((h) => h.instrumentId === crossId)!.currency,
      );
    });

    it("gives a zero-portfolio tenant an honest baseCurrency and an empty list", async () => {
      const emptyTenantId = await newTenant();
      const view = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: emptyTenantId,
        asOfDate: "2024-05-02",
      });
      expect(view.baseCurrency).toBe("EUR");
      expect(view.closedPositions).toEqual([]);
      expect(view.portfolioCount).toBe(0);
      expect(view.calcEpoch).toBe(0n);
    });
  });

  // =========================================================================
  // CP-10 / CP-11 — ordering.
  // =========================================================================

  describe("CP-10 — the merged sale-lot list is stable-sorted by tradeDate ascending", () => {
    it("interleaves two portfolios' legs chronologically, not by portfolio", async () => {
      const sortTenantId = await newTenant();
      const instrumentId = await newInstrument({ displayName: "CP-10 two-portfolio share" });
      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId: sortTenantId, name: `CP-10 A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId: sortTenantId, name: `CP-10 B ${randomUUID()}` })
      ).id;

      // A closes in 2021/2022; B closes in 2019/2020. A raw concatenation
      // would render 2021, 2022, 2019, 2020 — which is exactly the pre-existing
      // behaviour of the combined holdings view this one deliberately diverges
      // from (and does not backport into).
      for (const [portfolioId, years] of [
        [portfolioA, ["2021", "2022"]],
        [portfolioB, ["2019", "2020"]],
      ] as const) {
        for (const year of years) {
          await trade({
            kind: "BUY",
            tenantId: sortTenantId,
            portfolioId,
            instrumentId,
            tradeDate: `${year}-01-05`,
            quantity: "5",
            unitPrice: "10",
          });
          await trade({
            kind: "SELL",
            tenantId: sortTenantId,
            portfolioId,
            instrumentId,
            tradeDate: `${year}-06-05`,
            quantity: "5",
            unitPrice: "12",
          });
        }
      }

      const view = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: sortTenantId,
        asOfDate: "2024-01-01",
      });
      expect(view.closedPositions).toHaveLength(1);
      expect(view.closedPositions[0]!.realizedGains.map((g) => g.tradeDate)).toEqual([
        "2019-06-05",
        "2020-06-05",
        "2021-06-05",
        "2022-06-05",
      ]);
      // The four totals are summed across both portfolios (all additive).
      // Each round trip realizes 5 × (12 − 10) = 10.
      expect(view.closedPositions[0]!.totalRealizedGainBase.amount.toFixed()).toBe("40");
      expect(view.closedPositions[0]!.totalDisposedCostBasisBase.amount.toFixed()).toBe("200");

      // …and the per-portfolio path, which never merges, keeps
      // `computeRealizedGains`'s own order untouched (FR-330).
      const perPortfolioB = await valueClosedPositionsAsOf(appWebDb, {
        tenantId: sortTenantId,
        portfolioId: portfolioB,
        asOfDate: "2024-01-01",
      });
      expect(perPortfolioB.closedPositions[0]!.realizedGains.map((g) => g.tradeDate)).toEqual([
        "2019-06-05",
        "2020-06-05",
      ]);
    });
  });

  describe("CP-11 — the list is ordered most-recently-closed first", () => {
    it("orders by last disposal descending, on both the per-portfolio and the combined path", async () => {
      const orderTenantId = await newTenant();
      const oldId = await newInstrument({ displayName: "CP-11 closed in 2021" });
      const recentId = await newInstrument({ displayName: "CP-11 closed in 2023" });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId: orderTenantId, name: `CP-11 ${randomUUID()}` })
      ).id;

      // Seeded oldest-first, so a pass-through of insertion order would fail.
      for (const [instrumentId, year] of [
        [oldId, "2021"],
        [recentId, "2023"],
      ] as const) {
        await trade({
          kind: "BUY",
          tenantId: orderTenantId,
          portfolioId,
          instrumentId,
          tradeDate: `${year}-01-05`,
          quantity: "5",
          unitPrice: "10",
        });
        await trade({
          kind: "SELL",
          tenantId: orderTenantId,
          portfolioId,
          instrumentId,
          tradeDate: `${year}-06-05`,
          quantity: "5",
          unitPrice: "12",
        });
      }

      const perPortfolio = await valueClosedPositionsAsOf(appWebDb, {
        tenantId: orderTenantId,
        portfolioId,
        asOfDate: "2024-01-01",
      });
      expect(perPortfolio.closedPositions.map((p) => p.instrumentId)).toEqual([recentId, oldId]);

      const combined = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: orderTenantId,
        asOfDate: "2024-01-01",
      });
      expect(combined.closedPositions.map((p) => p.instrumentId)).toEqual([recentId, oldId]);
    });
  });

  // =========================================================================
  // `security-transfer` TR-16 — transfer-closed
  // positions in the combined view.
  // =========================================================================

  /**
   * A security transfer written directly, in the shape
   * `TransactionWriteService.recordTransferOut` writes (the `trade` helper's
   * reason for bypassing the service applies): a `TRANSFER_OUT` and, when
   * `targetPortfolioId` is named, its linked `TRANSFER_IN` carrying the carried
   * cost. Both portfolios are recomputed, as the service's propagation would.
   */
  async function transferOut(row: {
    tenantId: string;
    sourcePortfolioId: string;
    targetPortfolioId?: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    marketValue: string;
    carriedCost: string;
  }): Promise<void> {
    const sourceId = randomUUID();
    const sourceSeq = seq;
    const targetSeq = seq + 1n;
    seq += 2n;
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

  describe("security transfer — positions closed by a transfer, in the combined view (TR-16)", () => {
    it("F-2/ST-10: a transfer-only closed position sorts LAST in the combined list, though it closed most recently; the per-portfolio list orders it by its transfer date", async () => {
      const transferTenantId = await newTenant();
      const soldId = await newInstrument({ displayName: "Sold out in 2023-06" });
      const movedId = await newInstrument({ displayName: "Transferred out in 2024-03" });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId: transferTenantId, name: "Transfer closed" })
      ).id;

      await trade({
        kind: "BUY",
        tenantId: transferTenantId,
        portfolioId,
        instrumentId: soldId,
        tradeDate: "2023-01-05",
        quantity: "5",
        unitPrice: "10",
      });
      await trade({
        kind: "SELL",
        tenantId: transferTenantId,
        portfolioId,
        instrumentId: soldId,
        tradeDate: "2023-06-05",
        quantity: "5",
        unitPrice: "12",
      });
      await trade({
        kind: "BUY",
        tenantId: transferTenantId,
        portfolioId,
        instrumentId: movedId,
        tradeDate: "2023-02-05",
        quantity: "4",
        unitPrice: "25",
      });
      // Out of Kerdial altogether (FR-566): no target, so closed everywhere.
      await transferOut({
        tenantId: transferTenantId,
        sourcePortfolioId: portfolioId,
        instrumentId: movedId,
        tradeDate: "2024-03-10",
        quantity: "4",
        marketValue: "130",
        carriedCost: "100",
      });

      const perPortfolio = await valueClosedPositionsAsOf(appWebDb, {
        tenantId: transferTenantId,
        portfolioId,
        asOfDate: "2024-06-01",
      });
      expect(perPortfolio.closedPositions.map((p) => p.instrumentId)).toEqual([movedId, soldId]);

      const combined = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: transferTenantId,
        asOfDate: "2024-06-01",
      });
      expect(combined.closedPositions.map((p) => p.instrumentId)).toEqual([soldId, movedId]);

      const moved = combined.closedPositions[1]!;
      expect(moved.realizedGains).toEqual([]);
      expect(moved.totalRealizedGainBase.amount.toString()).toBe("0");
      expect(moved.totalDisposedCostBasisBase.amount.toString()).toBe("0");
      expect(moved.totalRealizedGainBase.provenance.derivedFrom).toEqual(["AUTOMATED"]);
    });

    it("an instrument fully moved into another, still-held portfolio is open somewhere, so it is absent from the combined closed view", async () => {
      const transferTenantId = await newTenant();
      const movedId = await newInstrument({ displayName: "Moved to a sibling" });
      const source = (
        await createPortfolio(appWebDb, { tenantId: transferTenantId, name: "Transfer source" })
      ).id;
      const target = (
        await createPortfolio(appWebDb, { tenantId: transferTenantId, name: "Transfer target" })
      ).id;
      await trade({
        kind: "BUY",
        tenantId: transferTenantId,
        portfolioId: source,
        instrumentId: movedId,
        tradeDate: "2024-01-05",
        quantity: "4",
        unitPrice: "25",
      });
      await transferOut({
        tenantId: transferTenantId,
        sourcePortfolioId: source,
        targetPortfolioId: target,
        instrumentId: movedId,
        tradeDate: "2024-03-10",
        quantity: "4",
        marketValue: "130",
        carriedCost: "100",
      });

      // The source alone closed it (AC-456's per-portfolio fact)…
      const sourceView = await valueClosedPositionsAsOf(appWebDb, {
        tenantId: transferTenantId,
        portfolioId: source,
        asOfDate: "2024-06-01",
      });
      expect(sourceView.closedPositions.map((p) => p.instrumentId)).toEqual([movedId]);

      // …but the tenant still holds it, so the combined view lists nothing.
      const combined = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: transferTenantId,
        asOfDate: "2024-06-01",
      });
      expect(combined.closedPositions).toEqual([]);
    });
  });

  // =========================================================================
  // FR-333 / OD-4 — the caps.
  // =========================================================================

  describe("FR-333/OD-4 — response caps reject, never truncate", () => {
    it("throws TooManyClosedPositionsError once the per-portfolio count exceeds the cap", async () => {
      const capTenantId = await newTenant();
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId: capTenantId, name: `caps-a ${randomUUID()}` })
      ).id;
      for (const label of ["caps A", "caps B"]) {
        const instrumentId = await newInstrument({ displayName: `${label} closed` });
        await trade({
          kind: "BUY",
          tenantId: capTenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-01-05",
          quantity: "5",
          unitPrice: "10",
        });
        await trade({
          kind: "SELL",
          tenantId: capTenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-02-05",
          quantity: "5",
          unitPrice: "12",
        });
      }

      const asOfDate = "2024-03-05";
      await expect(
        valueClosedPositionsAsOf(appWebDb, {
          tenantId: capTenantId,
          portfolioId,
          asOfDate,
          responseCapOverrides: { maxClosedPositions: 1 },
        }),
      ).rejects.toThrow(TooManyClosedPositionsError);
      // Under the real cap the same request succeeds, with the array intact —
      // nothing was sliced on the way to the throw above (NFR-5).
      const view = await valueClosedPositionsAsOf(appWebDb, {
        tenantId: capTenantId,
        portfolioId,
        asOfDate,
      });
      expect(view.closedPositions).toHaveLength(2);
    });

    it("throws TooManySaleLotsError, naming the instrument, once one position's lot count exceeds the cap", async () => {
      const capTenantId = await newTenant();
      const instrumentId = await newInstrument({ displayName: "sale-lot cap share" });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId: capTenantId, name: `caps-b ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        tenantId: capTenantId,
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-05",
        quantity: "10",
        unitPrice: "10",
      });
      await trade({
        kind: "SELL",
        tenantId: capTenantId,
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-05",
        quantity: "5",
        unitPrice: "12",
      });
      await trade({
        kind: "SELL",
        tenantId: capTenantId,
        portfolioId,
        instrumentId,
        tradeDate: "2024-03-05",
        quantity: "5",
        unitPrice: "13",
      });

      const asOfDate = "2024-04-05";
      await expect(
        valueClosedPositionsAsOf(appWebDb, {
          tenantId: capTenantId,
          portfolioId,
          asOfDate,
          responseCapOverrides: { maxSaleLotsPerClosedPosition: 1 },
        }),
      ).rejects.toThrow(TooManySaleLotsError);
      await expect(
        valueClosedPositionsAsOf(appWebDb, {
          tenantId: capTenantId,
          portfolioId,
          asOfDate,
          responseCapOverrides: { maxSaleLotsPerClosedPosition: 1 },
        }),
      ).rejects.toThrow(new RegExp(instrumentId));
    });

    it("R6 — the combined view's own check catches a merged lot count no single portfolio exceeds", async () => {
      const capTenantId = await newTenant();
      const instrumentId = await newInstrument({ displayName: "R6 merged-lot share" });
      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId: capTenantId, name: `R6 A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId: capTenantId, name: `R6 B ${randomUUID()}` })
      ).id;

      // Two lots in each portfolio, four merged.
      for (const portfolioId of [portfolioA, portfolioB]) {
        await trade({
          kind: "BUY",
          tenantId: capTenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-01-05",
          quantity: "10",
          unitPrice: "10",
        });
        await trade({
          kind: "SELL",
          tenantId: capTenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-02-05",
          quantity: "5",
          unitPrice: "12",
        });
        await trade({
          kind: "SELL",
          tenantId: capTenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-03-05",
          quantity: "5",
          unitPrice: "13",
        });
      }

      const asOfDate = "2024-04-05";
      const overrides = { maxSaleLotsPerClosedPosition: 3 } as const;

      // Neither portfolio alone is over the cap …
      for (const portfolioId of [portfolioA, portfolioB]) {
        const perPortfolio = await valueClosedPositionsAsOf(appWebDb, {
          tenantId: capTenantId,
          portfolioId,
          asOfDate,
          responseCapOverrides: overrides,
        });
        expect(perPortfolio.closedPositions[0]!.realizedGains).toHaveLength(2);
      }
      // … but the merged list is, and the combined path is where that is caught.
      await expect(
        valueClosedPositionsForTenant(appWebDb, {
          tenantId: capTenantId,
          asOfDate,
          responseCapOverrides: overrides,
        }),
      ).rejects.toThrow(TooManySaleLotsError);

      const combined = await valueClosedPositionsForTenant(appWebDb, {
        tenantId: capTenantId,
        asOfDate,
      });
      expect(combined.closedPositions[0]!.realizedGains).toHaveLength(4);
    });
  });

  describe("mixed-currency acquisitions — a closed position is labelled with base currency", () => {
    it("labels currency and totalRealizedGainNative with base currency, not listing_currency", async () => {
      // listing_currency deliberately USD, not EUR (the base) -- proves the fix
      // reads nativeCurrencyMixed, not merely coincides with the base currency.
      const instrumentId = await newInstrument({
        displayName: "Mixed-currency share",
        listingCurrency: "USD",
      });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-mixed ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-02",
        quantity: "10",
        unitPrice: "100",
        currency: "EUR",
      });
      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-02",
        quantity: "10",
        unitPrice: "120",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-03-02",
        quantity: "20",
        unitPrice: "150",
        currency: "EUR",
      });

      const asOfDate = "2024-03-03";
      const view = await valueClosedPositionsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      const position = view.closedPositions.find((p) => p.instrumentId === instrumentId)!;
      expect(position.currency).toBe("EUR"); // base, not the USD listing_currency fixture
      expect(position.totalRealizedGainNative.currency).toBe("EUR");
      expect(
        position.totalRealizedGainNative.amount.equals(position.totalRealizedGainBase.amount),
      ).toBe(true);
    });

    it("falls back to base currency at the tenant-wide merge when two portfolios disagree on this instrument's currency", async () => {
      // Same instrument, two portfolios under one tenant: portfolio A is
      // currency-mixed (its own currency resolves to base "EUR" per the fix
      // above), portfolio B is single-currency USD (its own currency resolves
      // to the USD listing currency, unmixed). Before this fix, the combined
      // view summed A's base-equivalent native total with B's real USD total
      // under whichever portfolio's currency the merge saw first -- the exact
      // cross-currency-sum defect this whole cycle exists to prevent,
      // recurring one level up at the tenant-wide merge.
      const instrumentId = await newInstrument({
        displayName: "Mixed-currency tenant-merge share",
        listingCurrency: "USD",
      });
      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-merge-A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-merge-B ${randomUUID()}` })
      ).id;

      // Portfolio A: mixed (EUR then USD), fully sold.
      await trade({
        kind: "BUY",
        portfolioId: portfolioA,
        instrumentId,
        tradeDate: "2024-01-02",
        quantity: "10",
        unitPrice: "100",
        currency: "EUR",
      });
      await trade({
        kind: "BUY",
        portfolioId: portfolioA,
        instrumentId,
        tradeDate: "2024-02-02",
        quantity: "10",
        unitPrice: "120",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "SELL",
        portfolioId: portfolioA,
        instrumentId,
        tradeDate: "2024-03-02",
        quantity: "20",
        unitPrice: "150",
        currency: "EUR",
      });

      // Portfolio B: single-currency USD throughout, fully sold.
      await trade({
        kind: "BUY",
        portfolioId: portfolioB,
        instrumentId,
        tradeDate: "2024-01-05",
        quantity: "5",
        unitPrice: "100",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "SELL",
        portfolioId: portfolioB,
        instrumentId,
        tradeDate: "2024-03-05",
        quantity: "5",
        unitPrice: "150",
        currency: "USD",
        fxRate: "0.92",
      });

      const asOfDate = "2024-03-06";
      const perA = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId: portfolioA,
        asOfDate,
      });
      const perB = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId: portfolioB,
        asOfDate,
      });
      // Precondition: the two portfolios must genuinely disagree, or this
      // test would not exercise the merge fallback at all.
      expect(perA.closedPositions.find((p) => p.instrumentId === instrumentId)!.currency).toBe(
        "EUR",
      );
      expect(perB.closedPositions.find((p) => p.instrumentId === instrumentId)!.currency).toBe(
        "USD",
      );

      const combined = await valueClosedPositionsForTenant(appWebDb, { tenantId, asOfDate });
      const merged = combined.closedPositions.find((p) => p.instrumentId === instrumentId)!;
      expect(merged.currency).toBe("EUR");
      expect(merged.totalRealizedGainNative.currency).toBe("EUR");
      expect(
        merged.totalRealizedGainNative.amount.equals(merged.totalRealizedGainBase.amount),
      ).toBe(true);
    });
  });

  describe("gain native-currency resolution — a single-currency closed position carries its real trade currency", () => {
    it("labels currency and totalRealizedGainNative with the actual trade currency, not listing_currency", async () => {
      const instrumentId = await newInstrument({
        displayName: "Single-currency-non-listing share",
        listingCurrency: "EUR", // deliberately not USD, so a pass can't be a coincidence
      });
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-disposal-closed ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId,
        tradeDate: "2024-01-02",
        quantity: "10",
        unitPrice: "100",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId,
        tradeDate: "2024-02-02",
        quantity: "10",
        unitPrice: "120",
        currency: "USD",
        fxRate: "0.92",
      });

      const asOfDate = "2024-02-03";
      const view = await valueClosedPositionsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
      const position = view.closedPositions.find((p) => p.instrumentId === instrumentId)!;
      expect(position.currency).toBe("USD"); // real trade currency, not the EUR listing_currency fixture
      expect(position.totalRealizedGainNative.currency).toBe("USD");
    });

    it("AC5: the tenant-wide merge falls back to base when a disposal-currency mismatch (not acquisition-mixing) makes two portfolios disagree", async () => {
      const instrumentId = await newInstrument({
        displayName: "Disposal-currency tenant-merge share",
        listingCurrency: "USD",
      });
      const portfolioA = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-disposal-A ${randomUUID()}` })
      ).id;
      const portfolioB = (
        await createPortfolio(appWebDb, { tenantId, name: `MC-disposal-B ${randomUUID()}` })
      ).id;

      // Portfolio A: single acquisition currency (USD), but disposed in EUR --
      // the disposal-currency trigger, not acquisition-mixing. Resolves to MIXED, base fallback.
      await trade({
        kind: "BUY",
        portfolioId: portfolioA,
        instrumentId,
        tradeDate: "2024-01-02",
        quantity: "10",
        unitPrice: "100",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "SELL",
        portfolioId: portfolioA,
        instrumentId,
        tradeDate: "2024-02-02",
        quantity: "10",
        unitPrice: "120",
        currency: "EUR",
      });

      // Portfolio B: single currency throughout (USD), no mismatch at all --
      // resolves to "USD" (the gain-currency resolution itself).
      await trade({
        kind: "BUY",
        portfolioId: portfolioB,
        instrumentId,
        tradeDate: "2024-01-05",
        quantity: "5",
        unitPrice: "100",
        currency: "USD",
        fxRate: "0.90",
      });
      await trade({
        kind: "SELL",
        portfolioId: portfolioB,
        instrumentId,
        tradeDate: "2024-03-05",
        quantity: "5",
        unitPrice: "150",
        currency: "USD",
        fxRate: "0.92",
      });

      const asOfDate = "2024-03-06";
      const perA = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId: portfolioA,
        asOfDate,
      });
      const perB = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId: portfolioB,
        asOfDate,
      });
      // Precondition: the two portfolios must genuinely disagree, or this
      // test would not exercise AC5 at all.
      expect(perA.closedPositions.find((p) => p.instrumentId === instrumentId)!.currency).toBe(
        "EUR",
      );
      expect(perB.closedPositions.find((p) => p.instrumentId === instrumentId)!.currency).toBe(
        "USD",
      );

      const combined = await valueClosedPositionsForTenant(appWebDb, { tenantId, asOfDate });
      const merged = combined.closedPositions.find((p) => p.instrumentId === instrumentId)!;
      expect(merged.currency).toBe("EUR"); // the tenant's base currency
      expect(
        merged.totalRealizedGainNative.amount.equals(merged.totalRealizedGainBase.amount),
      ).toBe(true);
    });
  });

  describe("crypto settlement — a settlement leg is exempt per leg, through the real projection", () => {
    it("labels each leg with its own currency and collapses the closed position's totals to base", async () => {
      const bitcoin = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "BTC",
          listingCurrency: "EUR",
          displayName: "Settlement Bitcoin",
        })
      ).id;
      const ether = (
        await createInstrumentBySymbol(appWebDb, {
          kind: "CRYPTO",
          symbol: "ETH",
          listingCurrency: "EUR",
          displayName: "Settlement Ether",
        })
      ).id;
      const portfolioId = (
        await createPortfolio(appWebDb, { tenantId, name: `SETTLE-654 ${randomUUID()}` })
      ).id;

      await trade({
        kind: "BUY",
        portfolioId,
        instrumentId: bitcoin,
        tradeDate: "2024-01-10",
        quantity: "1",
        unitPrice: "40000",
        currency: "USD",
        fxRate: "0.9",
      });
      // "Buy 2 ETH paying 0.1 BTC" at BTC → EUR 55000, in the row shape
      // `recordSettledBuy` writes; `loadPositionTimeline` projects the BTC side
      // as the marked settlement disposal.
      const settledSeq = seq;
      seq += 1n;
      await withTenant(appWebDb, tenantId, async (tx) => {
        await tx.insert(transaction).values({
          id: randomUUID(),
          tenantId,
          baseCurrency: "EUR",
          portfolioId,
          kind: "BUY",
          tradeDate: "2024-03-15",
          seq: settledSeq,
          instrumentId: ether,
          quantity: new Decimal("2"),
          unitPrice: new Decimal("0.05"),
          grossAmount: new Decimal("0.1"),
          txnCurrency: null,
          cashAccountId: null,
          cashCurrency: null,
          cashAmount: null,
          txnSettlementInstrumentId: bitcoin,
          fxRate: new Decimal("55000"),
          fxRateSource: "USER_PINNED",
          fxRateUserInput: new Decimal("55000"),
        });
        await recomputeAndInvalidate(tx, { tenantId, portfolioId, minTradeDate: "2024-03-15" });
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId: bitcoin,
        tradeDate: "2024-06-15",
        quantity: "0.5",
        unitPrice: "50000",
        currency: "USD",
        fxRate: "0.95",
      });
      await trade({
        kind: "SELL",
        portfolioId,
        instrumentId: bitcoin,
        tradeDate: "2024-09-15",
        quantity: "0.4",
        unitPrice: "60000",
        currency: "USD",
        fxRate: "0.92",
      });

      // Hand derivation (pmp_base 36000, pmp_native 40000 USD throughout):
      //   settlement 0.1 @ 55000: gain_base 5500 − 3600 = 1900 = gain_native, fx 0 (EUR label)
      //   SELL 0.5 @ 50000 × 0.95: gain_base 23750 − 18000 = 5750,
      //     gain_native 25000 − 20000 = 5000 USD, fx 5750 − 5000 × 0.9 = 1250
      //   SELL 0.4 @ 60000 × 0.92: gain_base 22080 − 14400 = 7680,
      //     gain_native 24000 − 16000 = 8000 USD, fx 7680 − 8000 × 0.9 = 480
      //   totals: base 1900 + 5750 + 7680 = 15330; native collapsed to 15330 EUR; fx 0
      const view = await valueClosedPositionsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2024-09-16",
      });
      const position = view.closedPositions.find((p) => p.instrumentId === bitcoin)!;
      const legs = position.realizedGains.map((g) => [
        g.gainBase.amount.toString(),
        g.gainNative.amount.toString(),
        g.gainNative.currency,
        g.fxComponentBase.amount.toString(),
      ]);
      expect(legs).toEqual([
        ["1900", "1900", "EUR", "0"],
        ["5750", "5000", "USD", "1250"],
        ["7680", "8000", "USD", "480"],
      ]);
      expect(position.currency).toBe("EUR");
      expect(position.totalRealizedGainBase.amount.toString()).toBe("15330");
      expect(position.totalRealizedGainNative.amount.toString()).toBe("15330");
      expect(position.totalRealizedGainNative.currency).toBe("EUR");
      expect(position.totalFxComponentBase.amount.isZero()).toBe(true);
    });
  });
});
