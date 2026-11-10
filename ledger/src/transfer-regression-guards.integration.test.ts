import { Decimal } from "@kerdial/core-decimal";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  holdingState,
  tenant,
  transaction as transactionTable,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  cash,
  seedCashAccounts,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin } from "./instrument-service.js";
import { createPortfolio } from "./portfolio-service.js";
import { listTenantHeldInstruments } from "./tenant-holdings-service.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * `security-transfer` TR-17 (AC-472, AC-473) — two
 * regression guards that need no code change, proven through the
 * real write service as the real `app_web` role, so RLS bounds every read.
 *
 * - **AC-472**: the quote-refresh scope (`listTenantHeldInstruments`) is keyed
 *   on the tenant's live holdings across every portfolio, so moving a whole
 *   position from one portfolio into another keeps the instrument in scope;
 *   only selling it out everywhere drops it.
 * - **AC-473**: `recordDividend` carries no quantity-held check and this
 *   feature added none — a dividend is recordable against an instrument with
 *   transfer history, on either side of the move, even where the quantity
 *   held is now zero.
 */
describe("ledger — security transfer regression guards (TR-17, AC-472/AC-473)", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000717001";
  let isinCounter = 0;

  function service(): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: {
        fetchDailyRates: vi.fn(async () => {
          throw new Error("the FX provider must not be consulted: every leg here is EUR under EUR");
        }),
      } as unknown as FxRateProvider,
      tenantId,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db: appWebDb,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db: appWebDb,
        provider: {} as QuoteProvider,
        fxRateResolver,
      }),
    });
  }

  async function newPortfolio(name: string): Promise<string> {
    const id = (await createPortfolio(appWebDb, { tenantId, name })).id;
    await seedCashAccounts(pg.ownerDb, tenantId, id, ["EUR"]);
    return id;
  }

  async function newShare(displayName: string): Promise<string> {
    isinCounter += 1;
    return (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: `XR${String(isinCounter).padStart(9, "0")}0`,
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName,
      })
    ).id;
  }

  async function heldIds(): Promise<string[]> {
    return (await listTenantHeldInstruments(appWebDb, tenantId)).map((row) => row.instrumentId);
  }

  async function quantityHeld(portfolioId: string, instrumentId: string): Promise<string> {
    const [row] = await withTenant(appWebDb, tenantId, (tx) =>
      tx
        .select({ quantity: holdingState.quantity })
        .from(holdingState)
        .where(
          and(
            eq(holdingState.portfolioId, portfolioId),
            eq(holdingState.instrumentId, instrumentId),
          ),
        ),
    );
    // The recompute keeps no `holding_state` row for an emptied position.
    return row === undefined ? "0" : row.quantity.toString();
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);
    await pg.ownerDb.insert(tenant).values({ id: tenantId });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("AC-472: a position moved whole into a sibling portfolio stays in quote-refresh scope; selling it out everywhere is what drops it", async () => {
    const share = await newShare("AC-472 moved share");
    const source = await newPortfolio("AC-472 source");
    const target = await newPortfolio("AC-472 target");
    await service().recordBuy({
      portfolioId: source,
      instrumentId: share,
      tradeDate: "2025-01-10",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("50"),
      txnCurrency: "EUR",
      cashAccountId: cash(source, "EUR"),
    });
    expect(await heldIds()).toContain(share);

    await service().recordTransferOut({
      portfolioId: source,
      instrumentId: share,
      tradeDate: "2025-03-10",
      quantity: new Decimal("10"),
      marketValue: new Decimal("620"),
      currency: "EUR",
      destinationPortfolioId: target,
    });
    // The move emptied the source and filled the target…
    expect(await quantityHeld(source, share)).toBe("0");
    expect(await quantityHeld(target, share)).toBe("10");
    // …and the tenant still holds it, so it is still refreshed.
    expect(await heldIds()).toContain(share);

    await service().recordSell({
      portfolioId: target,
      instrumentId: share,
      tradeDate: "2025-05-10",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("70"),
      txnCurrency: "EUR",
      cashAccountId: cash(target, "EUR"),
    });
    expect(await heldIds()).not.toContain(share);
  });

  it("AC-473: a DIVIDEND records unaffected on either side of a transfer, including the side now holding zero", async () => {
    const share = await newShare("AC-473 dividend share");
    const source = await newPortfolio("AC-473 source");
    const target = await newPortfolio("AC-473 target");
    await service().recordBuy({
      portfolioId: source,
      instrumentId: share,
      tradeDate: "2025-01-10",
      quantity: new Decimal("10"),
      unitPrice: new Decimal("50"),
      txnCurrency: "EUR",
      cashAccountId: cash(source, "EUR"),
    });
    await service().recordTransferOut({
      portfolioId: source,
      instrumentId: share,
      tradeDate: "2025-03-10",
      quantity: new Decimal("10"),
      marketValue: new Decimal("620"),
      currency: "EUR",
      destinationPortfolioId: target,
    });

    for (const [portfolioId, amount] of [
      [source, "12.5"],
      [target, "7.25"],
    ] as const) {
      const dividend = await service().recordDividend({
        portfolioId,
        instrumentId: share,
        tradeDate: "2025-04-10",
        amount: new Decimal(amount),
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      });
      const [stored] = await withTenant(appWebDb, tenantId, (tx) =>
        tx.select().from(transactionTable).where(eq(transactionTable.id, dividend.id)),
      );
      expect(stored?.kind).toBe("DIVIDEND");
      expect(stored?.portfolioId).toBe(portfolioId);
      expect(stored?.grossAmount.equals(new Decimal(amount))).toBe(true);
    }

    // A dividend moves no units on either side.
    expect(await quantityHeld(source, share)).toBe("0");
    expect(await quantityHeld(target, share)).toBe("10");
  });
});
