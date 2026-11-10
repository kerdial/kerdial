import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { FakeClock } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import { readMarketDataEpoch } from "@kerdial/market-ingestion";
import type { IngestionScheduler } from "@kerdial/market-ingestion";
import type { QuoteProvider } from "@kerdial/market-ports";
import { fakeQuoteProvider } from "@kerdial/market-test-support";
import {
  createDb,
  holdingState,
  instrument,
  instrumentPriceDaily,
  instrumentProviderMap,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleQuoteRefreshJob } from "./quote-refresh-handler.js";

/**
 * The regression guard for "the refresh button changes no figure
 * on screen".
 *
 * The endpoint, the queue, the fan-out, the singleton keys and the provider
 * fetch were all correct and all tested. The defect was one missing write:
 * the handler persisted the observation only to `instrument_quote_latest`, a
 * table `loadPricingSeries` does not read, so a quote refresh — scheduled or
 * on-demand — could not move a valued holding no matter how often it ran.
 *
 * That is invisible to every test that asserts the *fetch* happened, which is
 * why this suite asserts the two things a user can actually perceive: a row in
 * `instrument_price_daily` (what valuation reads) and an advanced
 * `market_data_epoch` (what makes an already-materialised valuation rebuild
 * instead of being served from cache).
 */
describe("handleQuoteRefreshJob — the per-instrument shape writes what valuation reads (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000400001";
  const portfolioId = "00000000-0000-7000-8000-000000400011";
  const heldId = "00000000-0000-7000-8000-000000400101";
  const unheldId = "00000000-0000-7000-8000-000000400102";

  /** The instant the fake provider reports its quote for, and the day it therefore belongs to. */
  const QUOTE_AS_OF = "2024-06-12T15:35:00.000Z";
  const QUOTE_DAY = "2024-06-12";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: "P" });
    await ownerDb.insert(instrument).values([
      {
        id: heldId,
        kind: "SHARE",
        displayName: "Held share",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000400101",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: unheldId,
        kind: "SHARE",
        displayName: "Unheld share",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000400102",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
    ]);
    await ownerDb.insert(instrumentProviderMap).values([
      {
        instrumentId: heldId,
        providerKey: YAHOO_PROVIDER_KEY,
        providerSymbol: "SYM-400101",
        confidence: "CONFIRMED",
      },
      {
        instrumentId: unheldId,
        providerKey: YAHOO_PROVIDER_KEY,
        providerSymbol: "SYM-400102",
        confidence: "CONFIRMED",
      },
    ]);
    await ownerDb.insert(holdingState).values({
      tenantId,
      portfolioId,
      instrumentId: heldId,
      quantity: new Decimal("3"),
      costBasisBase: new Decimal("300"),
      pmpUnitBase: new Decimal("100"),
      costBasisNative: new Decimal("300"),
      pmpUnitNative: new Decimal("100"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  function provider(price: string): QuoteProvider {
    return fakeQuoteProvider({
      capabilities: { key: YAHOO_PROVIDER_KEY },
      fetchLatest: vi.fn(async () => [
        {
          price: new Decimal(price),
          currency: "EUR",
          asOf: QUOTE_AS_OF,
          quality: "DELAYED" as const,
          sourceKey: YAHOO_PROVIDER_KEY,
        },
      ]),
    });
  }

  /** The per-instrument shape only — the fan-out shape is what enqueues these, and it is covered by the queue-wiring suites. */
  function job(instrumentId: string) {
    return [{ data: { instrumentId, bucket: "test-bucket" } }] as unknown as Parameters<
      typeof handleQuoteRefreshJob
    >[1];
  }

  function deps(p: QuoteProvider) {
    return {
      db: appIngestDb,
      clock: new FakeClock(new Date("2024-06-12T16:00:00.000Z")),
      workerProviders: { [YAHOO_PROVIDER_KEY]: p },
      // The per-instrument shape never enqueues anything; only the fan-out
      // shape does, and this suite never drives it.
      scheduler: {
        enqueueQuoteRefresh: vi.fn(async () => {
          throw new Error("must not be called by the per-instrument shape");
        }),
      } as unknown as IngestionScheduler,
    };
  }

  async function dailyRow(instrumentId: string, priceDate: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentPriceDaily)
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, instrumentId),
          eq(instrumentPriceDaily.priceDate, priceDate),
        ),
      );
    return row;
  }

  it("writes the fetched quote into instrument_price_daily — the table loadPricingSeries reads — and not only into instrument_quote_latest", async () => {
    await handleQuoteRefreshJob(deps(provider("123.500000000000000000")), job(heldId));

    const [latest] = await ownerDb
      .select()
      .from(instrumentQuoteLatest)
      .where(eq(instrumentQuoteLatest.instrumentId, heldId));
    expect(latest?.price.toFixed(18)).toBe("123.500000000000000000");

    // The half that used to be missing. Without it every assertion above
    // still passes and the user still sees yesterday's figure.
    const daily = await dailyRow(heldId, QUOTE_DAY);
    expect(daily?.closeRaw.toFixed(18)).toBe("123.500000000000000000");
    expect(daily?.currency).toBe("EUR");
    expect(daily?.quality).toBe("DELAYED");
  });

  it("advances market_data_epoch, so an already-materialised valuation is rebuilt rather than served from cache", async () => {
    const before = await readMarketDataEpoch(ownerDb);

    await handleQuoteRefreshJob(deps(provider("124.000000000000000000")), job(heldId));

    expect(await readMarketDataEpoch(ownerDb)).toBe(before + 1n);
    expect((await dailyRow(heldId, QUOTE_DAY))?.closeRaw.toFixed(18)).toBe(
      "124.000000000000000000",
    );
  });

  it("does not advance the epoch when the day's official close already exists — the quote is refused and there is nothing to invalidate", async () => {
    await ownerDb
      .update(instrumentPriceDaily)
      .set({ quality: "EOD", closeRaw: new Decimal("130.000000000000000000") })
      .where(
        and(
          eq(instrumentPriceDaily.instrumentId, heldId),
          eq(instrumentPriceDaily.priceDate, QUOTE_DAY),
        ),
      );
    const before = await readMarketDataEpoch(ownerDb);

    await handleQuoteRefreshJob(deps(provider("125.000000000000000000")), job(heldId));

    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
    expect((await dailyRow(heldId, QUOTE_DAY))?.closeRaw.toFixed(18)).toBe(
      "130.000000000000000000",
    );
  });

  it("an instrument sold out from under the job writes nothing and bumps nothing — a no-op job, not a fabricated price", async () => {
    const before = await readMarketDataEpoch(ownerDb);
    const p = provider("999.000000000000000000");

    await handleQuoteRefreshJob(deps(p), job(unheldId));

    expect(p.fetchLatest).not.toHaveBeenCalled();
    expect(await dailyRow(unheldId, QUOTE_DAY)).toBeUndefined();
    expect(await readMarketDataEpoch(ownerDb)).toBe(before);
  });
});
