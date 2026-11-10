import {
  ensureCashAccount,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Decimal, toDecimalString } from "@kerdial/core-decimal";
import { UnresolvablePriceError } from "@kerdial/core-domain";
import {
  createInstrumentScpi,
  createPortfolio,
  recomputeAndInvalidate,
  upsertManualPricePoint,
} from "@kerdial/ledger";
import {
  createDb,
  instrument,
  tenant,
  transaction,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { valueHoldingsAsOf, type ValuedHolding } from "./holdings-valuation.js";

/**
 * `scpi` cycle, SC-T6 — the Batch 2 release gate (AC-503, AC-505; FR-613,
 * FR-616; S-3). An SCPI is valued by the existing manual-price
 * path — manual-wins/LOCF `resolvePrice`, the `MANUAL_PRICE` flag, the
 * 400-day manual staleness horizon — with **no SCPI-specific code**, so every
 * claim here except the known answer is an equality with a `MANUAL_ONLY` FUND.
 *
 * That FUND is inserted directly through `ownerDb`: since OPCVM funds are
 * priced automatically the create path makes a FUND `AUTO`, so a created FUND
 * is the wrong comparand (SC-T6). Against a real Postgres, authenticated as `app_web`, on the
 * `holdings-valuation.integration.test.ts` bootstrap.
 *
 * Why here and not in `pnpm known-answers`: that gate is pure, in-memory
 * `core/domain` arithmetic with zero database I/O by design
 * (`core/domain/src/known-answers.test.ts`'s header). AC-503's claim is about
 * the stored manual series and an instrument kind reaching that arithmetic,
 * which only a database-backed read can test.
 */

describe("valuation — an SCPI is valued like a manually priced FUND (SC-T6, AC-503/AC-505)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000007760001";
  let seq = 1n;
  let codeSeq = 0;

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

  /** A directly-inserted EUR BUY, then the real recompute — `holdings-valuation.integration.test.ts`'s `buy`. */
  async function buy(row: {
    portfolioId: string;
    instrumentId: string;
    tradeDate: string;
    quantity: string;
    unitPrice: string;
  }): Promise<void> {
    const s = seq;
    seq += 1n;
    const gross = new Decimal(row.quantity).times(row.unitPrice);
    await withTenant(appWebDb, tenantId, async (tx) => {
      const cashAccountId = await ensureCashAccount(tx, tenantId, row.portfolioId, "EUR");
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
        grossAmount: gross,
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: gross,
        cashAccountId,
        fxRate: new Decimal("1"),
        fxRateSource: "IMPLIED_BASE",
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

  async function newPortfolio(label: string): Promise<string> {
    return (await createPortfolio(appWebDb, { tenantId, name: `${label} ${randomUUID()}` })).id;
  }

  /** An SCPI through the real create path: MIC-less, `MANUAL_ONLY` by rule. */
  async function createScpi(displayName: string): Promise<string> {
    codeSeq += 1;
    return (
      await createInstrumentScpi(appWebDb, {
        symbol: `SCPIVAL${codeSeq}`,
        listingCurrency: "EUR",
        displayName,
      })
    ).id;
  }

  /** The comparand: a `MANUAL_ONLY` FUND written straight to the catalogue (see the header). */
  async function insertManualOnlyFund(displayName: string): Promise<string> {
    codeSeq += 1;
    const id = randomUUID();
    await ownerDb.insert(instrument).values({
      id,
      kind: "FUND",
      displayName,
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      symbol: `FUNDVAL${codeSeq}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
    });
    return id;
  }

  async function manualPrice(instrumentId: string, priceDate: string, close: string) {
    await upsertManualPricePoint(appWebDb, {
      tenantId,
      instrumentId,
      priceDate,
      close: new Decimal(close),
      currency: "EUR",
    });
  }

  async function holdingOn(portfolioId: string, instrumentId: string, asOfDate: string) {
    const result = await valueHoldingsAsOf(appWebDb, { tenantId, portfolioId, asOfDate });
    const holding = result.holdings.find((h) => h.instrumentId === instrumentId);
    expect(holding, `${instrumentId} on ${asOfDate}`).toBeDefined();
    return holding!;
  }

  /** Every provenance/flag object a holding carries — what AC-505 compares, identity left out. */
  function provenanceOf(holding: ValuedHolding) {
    return {
      pmp: holding.pmp.provenance,
      costBasis: holding.costBasis.provenance,
      currentPrice: holding.currentPrice.provenance,
      currentValue: holding.currentValue.provenance,
      unrealizedGainLoss: holding.unrealizedGainLoss.provenance,
      dayChange: holding.dayChange?.provenance,
    };
  }

  function addDays(isoDate: string, days: number): string {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  it("AC-503 known answer: 10 parts, prix de part 250.00 then 260.00 — 2500.00 on 2026-03-01 (LOCF), 2600.00 from 2026-06-01, MANUAL_PRICE", async () => {
    const scpiA = await createScpi("SCPI-A known answer");
    await manualPrice(scpiA, "2026-01-05", "250.00");
    await manualPrice(scpiA, "2026-06-01", "260.00");
    const portfolioId = await newPortfolio("AC-503");
    await buy({
      portfolioId,
      instrumentId: scpiA,
      tradeDate: "2026-01-05",
      quantity: "10",
      unitPrice: "250.00",
    });

    // `toDecimalString` is the wire codec (full precision, no padding): the
    // value is exactly 2500 — "2500.00" at the two decimals the AC states it in.
    const march = await holdingOn(portfolioId, scpiA, "2026-03-01");
    expect(march.kind).toBe("SCPI");
    expect(march.currency).toBe("EUR");
    expect(toDecimalString(march.currentValue.amount)).toBe("2500");
    expect(march.currentValue.amount.toFixed(2)).toBe("2500.00");
    expect(march.currentValue.currency).toBe("EUR");
    expect(toDecimalString(march.currentPrice.amount)).toBe("250");
    expect(march.currentValue.provenance.priceAsOf).toBe("2026-01-05");
    expect(march.currentValue.provenance.derivedFrom).toContain("MANUAL_PRICE");
    expect(march.currentValue.provenance.priceQuality).toBe("MANUAL");

    for (const asOfDate of ["2026-06-01", "2026-06-02", "2026-09-30"]) {
      const after = await holdingOn(portfolioId, scpiA, asOfDate);
      expect(toDecimalString(after.currentValue.amount), asOfDate).toBe("2600");
      expect(after.currentValue.amount.toFixed(2), asOfDate).toBe("2600.00");
      expect(after.currentValue.provenance.priceAsOf, asOfDate).toBe("2026-06-01");
      expect(after.currentValue.provenance.derivedFrom, asOfDate).toContain("MANUAL_PRICE");
      expect(after.currentValue.provenance.priceQuality, asOfDate).toBe("MANUAL");
      expect(toDecimalString(after.unrealizedGainLoss.amount), asOfDate).toBe("100");
    }
  });

  it("AC-503 no price: an SCPI with a BUY and no manual price fails exactly as a MANUAL_ONLY FUND does", async () => {
    const scpi = await createScpi("SCPI never priced");
    const fund = await insertManualOnlyFund("MANUAL_ONLY FUND never priced");
    const scpiPortfolio = await newPortfolio("AC-503 no-price SCPI");
    const fundPortfolio = await newPortfolio("AC-503 no-price FUND");
    const trade = { tradeDate: "2026-01-05", quantity: "10", unitPrice: "250.00" };
    await buy({ ...trade, portfolioId: scpiPortfolio, instrumentId: scpi });
    await buy({ ...trade, portfolioId: fundPortfolio, instrumentId: fund });

    async function failureOf(portfolioId: string, instrumentId: string) {
      const error = await valueHoldingsAsOf(appWebDb, {
        tenantId,
        portfolioId,
        asOfDate: "2026-03-01",
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(UnresolvablePriceError);
      const { instrumentId: failedId, ...rest } = error as UnresolvablePriceError;
      expect(failedId).toBe(instrumentId);
      return {
        ...rest,
        name: (error as Error).name,
        message: (error as Error).message.replace(instrumentId, "<instrument>"),
      };
    }

    expect(await failureOf(scpiPortfolio, scpi)).toEqual(await failureOf(fundPortfolio, fund));
  });

  it("AC-505: at 200, 400 and 401 days an SCPI's provenance equals a MANUAL_ONLY FUND's — fresh, fresh, then stale alike", async () => {
    const priceDate = "2025-01-02";
    const scpi = await createScpi("SCPI aging");
    const fund = await insertManualOnlyFund("MANUAL_ONLY FUND aging");
    await manualPrice(scpi, priceDate, "250.00");
    await manualPrice(fund, priceDate, "250.00");
    const portfolioId = await newPortfolio("AC-505");
    const trade = { portfolioId, tradeDate: priceDate, quantity: "10", unitPrice: "250.00" };
    await buy({ ...trade, instrumentId: scpi });
    await buy({ ...trade, instrumentId: fund });

    // `MANUAL_STALE_AFTER_DAYS = 400` with a strict `>` (S-3): fresh
    // through day 400, stale from day 401 — for both, by the FUND's rule.
    for (const [days, stale] of [
      [200, false],
      [400, false],
      [401, true],
    ] as const) {
      const asOfDate = addDays(priceDate, days);
      const scpiHolding = await holdingOn(portfolioId, scpi, asOfDate);
      const fundHolding = await holdingOn(portfolioId, fund, asOfDate);

      expect(provenanceOf(scpiHolding), `${days} days`).toEqual(provenanceOf(fundHolding));
      expect(scpiHolding.currentValue.provenance.priceIsStale, `${days} days`).toBe(stale);
      expect(fundHolding.currentValue.provenance.priceIsStale, `${days} days`).toBe(stale);
      expect(scpiHolding.currentValue.provenance.derivedFrom).toContain("MANUAL_PRICE");
      expect(scpiHolding.currentValue.amount.equals(fundHolding.currentValue.amount)).toBe(true);
    }
  });
});
