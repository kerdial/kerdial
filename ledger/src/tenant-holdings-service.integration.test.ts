import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { fetchHeldInstruments } from "@kerdial/market-ingestion";
import {
  createDb,
  holdingState,
  instrument,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTenantHeldInstruments } from "./tenant-holdings-service.js";

/**
 * SH-18 (`self-hosted-deploy` FR-51, AC-43) — the tenant-scoped holdings
 * enumeration behind `POST /market-data/quote-refresh`, and the
 * **negative-implementation check** asked for by name: the obvious
 * alternative (`market/ingestion`'s `fetchHeldInstruments`) is shown *leaking*
 * here, next to the real implementation shown not to.
 *
 * Both run against the same two-tenant fixture, each through the pool its
 * production caller uses — `app_web` for the endpoint's read (RLS-enforced),
 * `app_ingest` for the ingestion fan-out's (deliberately cross-tenant). The
 * leak is therefore a property of the roles and policies, not of a `where`
 * clause anyone could add back.
 */
describe("ledger — listTenantHeldInstruments vs. fetchHeldInstruments (SH-18/FR-51, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000018000a";
  const tenantB = "00000000-0000-7000-8000-00000018000b";
  const portfolioA = "00000000-0000-7000-8000-000000180a01";
  const portfolioA2 = "00000000-0000-7000-8000-000000180a02";
  const portfolioB = "00000000-0000-7000-8000-000000180b01";
  const shareA = "00000000-0000-7000-8000-0000001800a1";
  const cryptoA = "00000000-0000-7000-8000-0000001800a2";
  const soldA = "00000000-0000-7000-8000-0000001800a3";
  const shareB = "00000000-0000-7000-8000-0000001800b1";

  async function seedInstrument(id: string, kind: "SHARE" | "CRYPTO", symbol: string) {
    await ownerDb.insert(instrument).values({
      id,
      kind,
      displayName: `SH-18 ${symbol}`,
      listingCurrency: "EUR",
      symbol,
      ...(kind === "SHARE" ? { exchangeMic: "XPAR" } : {}),
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
  }

  async function seedHolding(
    tenantId: string,
    portfolioId: string,
    instrumentId: string,
    quantity: string,
  ) {
    await ownerDb.insert(holdingState).values({
      tenantId,
      portfolioId,
      instrumentId,
      quantity: new Decimal(quantity),
      costBasisBase: new Decimal("100"),
      pmpUnitBase: new Decimal("10"),
      costBasisNative: new Decimal("100"),
      pmpUnitNative: new Decimal("10"),
      lastTxnSeq: 1n,
      calcEpoch: 1n,
    });
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 4 });
    appWebDb = createDb(appWebSql);

    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);

    for (const [tenantId, portfolios] of [
      [tenantA, [portfolioA, portfolioA2]],
      [tenantB, [portfolioB]],
    ] as const) {
      await ownerDb.insert(tenant).values({ id: tenantId });
      for (const portfolioId of portfolios) {
        await ownerDb
          .insert(portfolio)
          .values({ id: portfolioId, tenantId, name: `p-${portfolioId.slice(-4)}` });
      }
    }

    await seedInstrument(shareA, "SHARE", "AAAA");
    await seedInstrument(cryptoA, "CRYPTO", "BBBB");
    await seedInstrument(soldA, "SHARE", "CCCC");
    await seedInstrument(shareB, "SHARE", "DDDD");

    // Tenant A: a share held in **two** portfolios (the dedupe case), a crypto,
    // and a fully-sold position that must not be refreshed.
    await seedHolding(tenantA, portfolioA, shareA, "10");
    await seedHolding(tenantA, portfolioA2, shareA, "4");
    await seedHolding(tenantA, portfolioA, cryptoA, "2");
    await seedHolding(tenantA, portfolioA, soldA, "0");
    await seedHolding(tenantB, portfolioB, shareB, "7");
  }, 180_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("returns each held instrument once for the calling tenant, and nothing of any other tenant's", async () => {
    const held = await listTenantHeldInstruments(appWebDb, tenantA);

    // Deduped across portfolios (three holding rows for two live instruments),
    // sold-out position excluded, ordered deterministically.
    expect(held.map((row) => row.instrumentId)).toEqual([shareA, cryptoA].sort());
    expect(held.map((row) => row.kind).sort()).toEqual(["CRYPTO", "SHARE"]);
    expect(held.some((row) => row.instrumentId === shareB)).toBe(false);
    expect(held.some((row) => row.instrumentId === soldA)).toBe(false);
  }, 60_000);

  it("is symmetric — tenant B sees only its own, so neither result is a vacuous pass", async () => {
    const held = await listTenantHeldInstruments(appWebDb, tenantB);
    expect(held.map((row) => row.instrumentId)).toEqual([shareB]);
  }, 60_000);

  it("FR-51's negative check: fetchHeldInstruments really does return every tenant's holdings", async () => {
    // This is the implementation the endpoint must *not* use, run here to prove
    // the requirement is about a real leak rather than a stylistic preference.
    // `app_ingest`'s `holding_state_ingest_read` policy is `USING (true)` on
    // purpose: an instrument held by anyone is polled once for everyone.
    const crossTenant = await fetchHeldInstruments(appIngestDb);
    const ids = crossTenant.map((row) => row.instrumentId);

    expect(ids).toContain(shareA);
    expect(ids).toContain(shareB);
    // Which is exactly the leak: tenant A's request would have enqueued tenant
    // B's instrument.
    const tenantAScoped = (await listTenantHeldInstruments(appWebDb, tenantA)).map(
      (row) => row.instrumentId,
    );
    expect(tenantAScoped).not.toContain(shareB);
  }, 60_000);
});
