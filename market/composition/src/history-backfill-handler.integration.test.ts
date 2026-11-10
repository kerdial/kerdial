import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import { systemClock } from "@kerdial/market-ingestion";
import {
  ProviderUnavailable,
  type PriceObservation,
  type ProviderSymbolMatch,
  type QuoteProvider,
} from "@kerdial/market-ports";
import {
  createDb,
  instrument,
  instrumentBackfillState,
  instrumentPriceDaily,
  instrumentProviderMap,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleOneInstrumentBackfill } from "./history-backfill-handler.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

const PROVIDER_KEY = "ic7-fake-provider";

interface FakeProviderBehavior {
  candidates?: ProviderSymbolMatch[];
  resolveError?: Error;
  history?: PriceObservation[];
  historyError?: Error;
}

interface FakeProviderHandle extends QuoteProvider {
  readonly resolveCallCount: number;
  readonly historyCallCount: number;
}

function fakeProvider(behavior: FakeProviderBehavior): FakeProviderHandle {
  const state = { resolveCallCount: 0, historyCallCount: 0 };
  return {
    ...fakeQuoteProvider({
      capabilities: { key: PROVIDER_KEY, assetKinds: ["SHARE", "CRYPTO"] },
      resolve: async () => {
        state.resolveCallCount += 1;
        if (behavior.resolveError) throw behavior.resolveError;
        return behavior.candidates ?? [];
      },
      fetchDailyHistory: async () => {
        state.historyCallCount += 1;
        if (behavior.historyError) throw behavior.historyError;
        return behavior.history ?? [];
      },
    }),
    get resolveCallCount(): number {
      return state.resolveCallCount;
    },
    get historyCallCount(): number {
      return state.historyCallCount;
    },
  };
}

function priceObservation(date: string): PriceObservation {
  return {
    priceDate: date,
    close: new Decimal("100.00"),
    currency: "EUR",
    quality: "DELAYED",
    sourceKey: PROVIDER_KEY,
  };
}

/**
 * IC-7 — the
 * `history:backfill:*` handler body's provider-symbol resolution and
 * backfill invocation ("the single most important integration gap"). Every write this handler performs
 * (`instrument_provider_map.INSERT`, `instrument_backfill_state`/
 * `instrument_price_daily` via `runInstrumentBackfillJob`) is proved here
 * against the real `app_ingest` role — never the Testcontainers superuser
 * — mirroring the role-realism discipline IC-1 established.
 */
describe("history-backfill-handler (IC-7, Testcontainers, app_ingest role realism)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);
  }, 120_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  async function seedInstrument(
    id: string,
    kind: "SHARE" | "ETF" | "CRYPTO" | "FUND" | "INDEX",
    symbol: string,
  ): Promise<void> {
    await ownerDb.insert(instrument).values({
      id,
      kind,
      displayName: `Instrument ${id}`,
      listingCurrency: "EUR",
      symbol,
      primaryIdentifier: "SYMBOL",
      // Every kind is AUTO by default now, FUND included (ADR-0018).
      quotePolicy: "AUTO",
    });
  }

  async function seedPendingState(
    instrumentId: string,
    requestedFrom = "2024-01-01",
  ): Promise<void> {
    await ownerDb
      .insert(instrumentBackfillState)
      .values({ instrumentId, requestedFrom, status: "PENDING" });
  }

  async function stateFor(instrumentId: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentBackfillState)
      .where(eq(instrumentBackfillState.instrumentId, instrumentId));
    return row;
  }

  async function mappingFor(instrumentId: string) {
    const [row] = await ownerDb
      .select()
      .from(instrumentProviderMap)
      .where(eq(instrumentProviderMap.instrumentId, instrumentId));
    return row;
  }

  async function priceDatesFor(instrumentId: string): Promise<string[]> {
    const rows = await ownerDb
      .select({ priceDate: instrumentPriceDaily.priceDate })
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId));
    return rows.map((r) => r.priceDate).sort();
  }

  it("a freshly created SHARE instrument with no existing mapping resolves a symbol, writes a HEURISTIC mapping, and backfills — the fully-manual creation path (AC-13)", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000001";
    await seedInstrument(instrumentId, "SHARE", "acme-share-1");
    await seedPendingState(instrumentId, "2024-01-01");

    const provider = fakeProvider({
      candidates: [
        {
          providerSymbol: "ACME1",
          displayName: "Acme Corp",
          currency: "EUR",
          matchQuality: "EXACT",
        },
      ],
      history: [priceObservation("2024-01-02")],
    });

    await handleOneInstrumentBackfill(
      { db: appIngestDb, clock: systemClock, workerProviders: { [YAHOO_PROVIDER_KEY]: provider } },
      instrumentId,
    );

    expect(provider.resolveCallCount).toBe(1);

    const mapping = await mappingFor(instrumentId);
    expect(mapping?.confidence).toBe("HEURISTIC");
    expect(mapping?.providerSymbol).toBe("ACME1");
    expect(mapping?.providerKey).toBe(YAHOO_PROVIDER_KEY);

    const state = await stateFor(instrumentId);
    expect(state?.status).toBe("COMPLETE");

    expect(await priceDatesFor(instrumentId)).toContain("2024-01-02");
  });

  it("RED-CONFIRM: the handler forwards the DECLARED listing currency as the quote-currency hint, and the stored series carries it — declared == stored, the ingestionStaleness currency check's own predicate", async () => {
    const instrumentId = "00000000-0000-7000-8000-0000038000aa";
    await seedInstrument(instrumentId, "CRYPTO", "hintcoin");
    await seedPendingState(instrumentId);
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId,
      providerKey: YAHOO_PROVIDER_KEY,
      providerSymbol: "hintcoin",
      confidence: "CONFIRMED",
    });

    // A currency-choosing provider, compressed: echoes the hint into the
    // observations it returns, and records what it was asked for — the
    // quote-currency contract such an adapter honours (CoinGecko did until it
    // was retired; the handler keeps forwarding the hint either way).
    const hints: Array<string | undefined> = [];
    const provider = fakeQuoteProvider({
      capabilities: { key: PROVIDER_KEY, assetKinds: ["SHARE", "CRYPTO"] },
      fetchDailyHistory: async (_symbol, _from, to, quoteCurrency) => {
        hints.push(quoteCurrency);
        return [{ ...priceObservation(to), currency: quoteCurrency ?? "USD" }];
      },
    });

    await handleOneInstrumentBackfill(
      {
        db: appIngestDb,
        clock: systemClock,
        workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
      },
      instrumentId,
    );

    // The hint on every chunk call is the instrument's own declaration...
    expect(hints.length).toBeGreaterThan(0);
    expect(new Set(hints)).toEqual(new Set(["EUR"]));
    // ...and what landed matches it. Before the hint was threaded through, this query is
    // exactly the mismatch the live deployment surfaced (USD rows against an
    // EUR declaration) — asserting stored == declared red-confirms the fix.
    const rows = await ownerDb
      .select({ currency: instrumentPriceDaily.currency })
      .from(instrumentPriceDaily)
      .where(eq(instrumentPriceDaily.instrumentId, instrumentId));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(["EUR"]));
  });

  it("an instrument with an existing CONFIRMED mapping uses it directly and never calls resolve() again", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000002";
    await seedInstrument(instrumentId, "CRYPTO", "btc-2");
    await seedPendingState(instrumentId, "2024-01-01");
    await ownerDb.insert(instrumentProviderMap).values({
      instrumentId,
      providerKey: YAHOO_PROVIDER_KEY,
      providerSymbol: "BTC-EUR",
      confidence: "CONFIRMED",
    });

    const provider = fakeProvider({ history: [priceObservation("2024-01-03")] });

    await handleOneInstrumentBackfill(
      {
        db: appIngestDb,
        clock: systemClock,
        workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
      },
      instrumentId,
    );

    expect(provider.resolveCallCount).toBe(0);
    const state = await stateFor(instrumentId);
    expect(state?.status).toBe("COMPLETE");
    expect(await priceDatesFor(instrumentId)).toContain("2024-01-03");

    // The existing mapping is untouched (still CONFIRMED, same symbol).
    const mapping = await mappingFor(instrumentId);
    expect(mapping?.confidence).toBe("CONFIRMED");
    expect(mapping?.providerSymbol).toBe("BTC-EUR");
  });

  it("when resolve() yields no candidates, the job completes without error, the state row stays PENDING, and no price rows are written", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000003";
    await seedInstrument(instrumentId, "SHARE", "unknown-3");
    await seedPendingState(instrumentId, "2024-01-01");

    const provider = fakeProvider({ candidates: [] });

    await expect(
      handleOneInstrumentBackfill(
        {
          db: appIngestDb,
          clock: systemClock,
          workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
        },
        instrumentId,
      ),
    ).resolves.toBeUndefined();

    const state = await stateFor(instrumentId);
    expect(state?.status).toBe("PENDING");
    // PENDING is still right — it is what keeps the hourly sweep
    // retrying — but the attempt is now *recorded*, so this row can be told
    // apart from one that was never dispatched. Both halves asserted together,
    // because either alone is satisfiable by the wrong fix: status-only lets
    // the row stay invisible, stamp-only would strand it out of the sweep.
    expect(state?.lastAttemptedAt).not.toBeNull();
    expect(await priceDatesFor(instrumentId)).toEqual([]);
    expect(await mappingFor(instrumentId)).toBeUndefined();
  });

  it("ADR-0018: a FUND instrument walks the same Yahoo path a SHARE does — resolve, mapping, NAV rows, COMPLETE (it was AC-14's no-op before)", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000004";
    await seedInstrument(instrumentId, "FUND", "fund-4");
    await seedPendingState(instrumentId, "2024-01-01");

    const provider = fakeProvider({
      candidates: [
        {
          providerSymbol: "0P0001DKPM.F",
          displayName: "Indépendance AM Europe Small A (C)",
          currency: "EUR",
          matchQuality: "PROBABLE",
        },
      ],
      history: [priceObservation("2024-01-04")],
    });

    await expect(
      handleOneInstrumentBackfill(
        {
          db: appIngestDb,
          clock: systemClock,
          workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
        },
        instrumentId,
      ),
    ).resolves.toBeUndefined();

    expect(provider.resolveCallCount).toBe(1);
    expect(provider.historyCallCount).toBeGreaterThan(0);

    const mapping = await mappingFor(instrumentId);
    expect(mapping?.providerKey).toBe(YAHOO_PROVIDER_KEY);
    expect(mapping?.providerSymbol).toBe("0P0001DKPM.F");

    expect((await stateFor(instrumentId))?.status).toBe("COMPLETE");
    expect(await priceDatesFor(instrumentId)).toContain("2024-01-04");
  });

  it("an INDEX instrument walks the same Yahoo path a SHARE does — resolve, HEURISTIC mapping, price rows, COMPLETE (it was a no-op before the benchmark line)", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000005";
    await seedInstrument(instrumentId, "INDEX", "index-5");
    await seedPendingState(instrumentId, "2024-01-01");

    const provider = fakeProvider({
      candidates: [
        {
          providerSymbol: "^STOXX50E",
          displayName: "EURO STOXX 50",
          currency: "EUR",
          matchQuality: "EXACT",
        },
      ],
      history: [priceObservation("2024-01-04")],
    });

    await expect(
      handleOneInstrumentBackfill(
        {
          db: appIngestDb,
          clock: systemClock,
          workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
        },
        instrumentId,
      ),
    ).resolves.toBeUndefined();

    // The three halves that were all zero/absent before the benchmark line, asserted
    // together: a provider call actually happened, the mapping was written,
    // and the history landed. Any one alone is satisfiable by a routing
    // change that still writes nothing.
    expect(provider.resolveCallCount).toBe(1);
    expect(provider.historyCallCount).toBeGreaterThan(0);

    const mapping = await mappingFor(instrumentId);
    expect(mapping?.providerKey).toBe(YAHOO_PROVIDER_KEY);
    expect(mapping?.providerSymbol).toBe("^STOXX50E");

    expect((await stateFor(instrumentId))?.status).toBe("COMPLETE");
    expect(await priceDatesFor(instrumentId)).toContain("2024-01-04");
  });

  it("a thrown provider error during resolution propagates — not swallowed by this handler", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000006";
    await seedInstrument(instrumentId, "SHARE", "err-6");
    await seedPendingState(instrumentId, "2024-01-01");

    const provider = fakeProvider({ resolveError: new ProviderUnavailable(PROVIDER_KEY, "boom") });

    await expect(
      handleOneInstrumentBackfill(
        {
          db: appIngestDb,
          clock: systemClock,
          workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
        },
        instrumentId,
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("a thrown provider error during runInstrumentBackfillJob propagates, and the mapping written just before it is not rolled back", async () => {
    const instrumentId = "10000000-0000-7000-8000-000000000007";
    await seedInstrument(instrumentId, "SHARE", "err-7");
    await seedPendingState(instrumentId, "2024-01-01");

    const provider = fakeProvider({
      candidates: [
        { providerSymbol: "ERR7", displayName: "Err7", currency: "EUR", matchQuality: "EXACT" },
      ],
      historyError: new ProviderUnavailable(PROVIDER_KEY, "history boom"),
    });

    await expect(
      handleOneInstrumentBackfill(
        {
          db: appIngestDb,
          clock: systemClock,
          workerProviders: { [YAHOO_PROVIDER_KEY]: provider },
        },
        instrumentId,
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailable);

    const mapping = await mappingFor(instrumentId);
    expect(mapping?.confidence).toBe("HEURISTIC");
    expect(mapping?.providerSymbol).toBe("ERR7");

    const state = await stateFor(instrumentId);
    expect(state?.status).toBe("FAILED");
  });
});
