import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  createDb,
  holdingState,
  instrument,
  instrumentQuoteLatest,
  portfolio,
  tenant,
  type Db,
} from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listHeldInstrumentQuoteStaleness } from "./staleness.js";

/** The ops sweep's cadence-relative quote threshold, used here only as a fixed number to compare against. */
const FOURTEEN_HOURS_MS = 14 * 60 * 60 * 1000;

function holdingRow(params: {
  tenantId: string;
  portfolioId: string;
  instrumentId: string;
  quantity: string;
}) {
  const costBasisBase = new Decimal(params.quantity).times(100);
  return {
    tenantId: params.tenantId,
    portfolioId: params.portfolioId,
    instrumentId: params.instrumentId,
    quantity: new Decimal(params.quantity),
    costBasisBase,
    pmpUnitBase: new Decimal("100"),
    costBasisNative: costBasisBase,
    pmpUnitNative: new Decimal("100"),
    lastTxnSeq: 1n,
    calcEpoch: 1n,
  };
}

/**
 * SH-36 — the never-fetched staleness fix, proven by the case that was
 * broken.
 *
 * The old read started from `instrument_quote_latest` and inner-joined
 * `instrument`. Every row it can return exists, so a held instrument with
 * **no** quote row is invisible to it — the alert is silent in exactly the
 * total-failure case. This suite asserts both halves against the same seeded
 * database: the old shape's silence, and the new function's
 * `BREACHED`/never-fetched verdict.
 *
 * The old function (`listInstrumentQuoteStaleness`) is gone — it had no caller
 * but this contrast. Its query is inlined below
 * as raw SQL rather than dropped, because the *demonstration* is the point: a
 * future "cleanup" that deletes the new function cannot quietly restore the
 * old behaviour while this case still shows what the old behaviour was.
 *
 * Read through the real `app_ingest` role, like every other DB-backed suite in
 * this package.
 */
describe("B3 — quote staleness over the fan-out set, left-joined (SH-36)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000360001";
  const portfolioId = "00000000-0000-7000-8000-000000360011";

  /** Held, and has a fresh quote row. */
  const freshId = "00000000-0000-7000-8000-000000360101";
  /** Held, and has a quote row older than the cadence-relative threshold. */
  const agedId = "00000000-0000-7000-8000-000000360102";
  /** Held, and has **no** `instrument_quote_latest` row at all — B3's case. */
  const neverFetchedId = "00000000-0000-7000-8000-000000360103";
  /** Not held (quantity 0), and equally never fetched — must not be reported at all. */
  const unheldId = "00000000-0000-7000-8000-000000360104";

  const now = new Date("2026-08-20T12:00:00.000Z");

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appIngestSql = postgres(pg.appIngestUri, { max: 1 });
    appIngestDb = createDb(appIngestSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
    await ownerDb.insert(portfolio).values({ id: portfolioId, tenantId, name: "B3" });
    await ownerDb.insert(instrument).values(
      [freshId, agedId, neverFetchedId, unheldId].map((id, index) => ({
        id,
        kind: "SHARE" as const,
        displayName: `B3 ${String(index)}`,
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: `FR000036010${String(index + 1)}`,
        primaryIdentifier: "ISIN" as const,
        quotePolicy: "AUTO" as const,
      })),
    );
    await ownerDb
      .insert(holdingState)
      .values([
        holdingRow({ tenantId, portfolioId, instrumentId: freshId, quantity: "10" }),
        holdingRow({ tenantId, portfolioId, instrumentId: agedId, quantity: "10" }),
        holdingRow({ tenantId, portfolioId, instrumentId: neverFetchedId, quantity: "10" }),
        holdingRow({ tenantId, portfolioId, instrumentId: unheldId, quantity: "0" }),
      ]);
    await ownerDb.insert(instrumentQuoteLatest).values([
      {
        instrumentId: freshId,
        price: new Decimal("10"),
        currency: "EUR",
        asOf: new Date(now.getTime() - 60 * 60 * 1000),
        quality: "DELAYED",
        sourceKey: "test",
      },
      {
        instrumentId: agedId,
        price: new Decimal("10"),
        currency: "EUR",
        asOf: new Date(now.getTime() - 30 * 60 * 60 * 1000),
        quality: "DELAYED",
        sourceKey: "test",
      },
    ]);
    // `neverFetchedId` and `unheldId` deliberately get no quote row.
  }, 180_000);

  afterAll(async () => {
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("BEFORE — the inner-joined read is silent about the never-fetched instrument (the bug, characterised)", async () => {
    // The deleted `listInstrumentQuoteStaleness`'s query, verbatim: start from
    // `instrument_quote_latest`, inner-join `instrument` for the kind. The
    // staleness computation it fed is irrelevant here — the bug is in the row
    // set, before any threshold is applied.
    const rows = await appIngestSql<{ instrument_id: string }[]>`
      SELECT iql."instrument_id"
      FROM "instrument_quote_latest" iql
      INNER JOIN "instrument" i ON i."id" = iql."instrument_id"
    `;
    const ids = rows.map((row) => row.instrument_id);

    // Not "reported fresh" — not reported at all. That is what makes the alert
    // silent rather than wrong: no verdict of any kind is produced for the one
    // instrument whose data never arrived.
    expect(ids).not.toContain(neverFetchedId);
    expect(ids.sort()).toEqual([agedId, freshId].sort());
    // It sees only what already has a row, and judges those against NFR-1's
    // 20-minute display budget — which, at a twice-daily cadence, everything
    // exceeds. Both halves are why this read cannot be the alert's source.
  });

  it("AFTER — a held instrument that has never been fetched is stale, with a distinct never-fetched marker", async () => {
    const results = await listHeldInstrumentQuoteStaleness(appIngestDb, now, FOURTEEN_HOURS_MS);
    const byId = new Map(results.map((result) => [result.instrumentId, result]));

    const missing = byId.get(neverFetchedId);
    expect(missing).toBeDefined();
    expect(missing?.stale).toBe(true);
    expect(missing?.neverFetched).toBe(true);
    // `null`, not `0`: there is no age. A zero here would read as "fetched this
    // instant", the exact inversion of the truth.
    expect(missing?.asOf).toBeNull();
    expect(missing?.ageMs).toBeNull();
  });

  it("AFTER — the aged-row case is unaffected: still stale, still with a real age", async () => {
    const results = await listHeldInstrumentQuoteStaleness(appIngestDb, now, FOURTEEN_HOURS_MS);
    const aged = results.find((result) => result.instrumentId === agedId);

    expect(aged?.stale).toBe(true);
    expect(aged?.neverFetched).toBe(false);
    expect(aged?.ageMs).toBe(30 * 60 * 60 * 1000);
    expect(aged?.thresholdMs).toBe(FOURTEEN_HOURS_MS);
  });

  it("AFTER — a fresh row inside the cadence budget is not stale", async () => {
    const results = await listHeldInstrumentQuoteStaleness(appIngestDb, now, FOURTEEN_HOURS_MS);
    const fresh = results.find((result) => result.instrumentId === freshId);

    expect(fresh?.stale).toBe(false);
    expect(fresh?.neverFetched).toBe(false);
    expect(fresh?.ageMs).toBe(60 * 60 * 1000);
  });

  it("AFTER — the set swept is the fan-out set: an unheld, never-fetched instrument is not reported", async () => {
    const results = await listHeldInstrumentQuoteStaleness(appIngestDb, now, FOURTEEN_HOURS_MS);
    expect(results.map((result) => result.instrumentId).sort()).toEqual(
      [freshId, agedId, neverFetchedId].sort(),
    );
    // Otherwise every instrument anyone ever created, held or not, would breach
    // this indicator forever — an alert that is always on is the same as none.
    expect(results.map((result) => result.instrumentId)).not.toContain(unheldId);
  });

  it("AFTER — the kind filter narrows the fan-out set the same way fetchHeldInstruments' does", async () => {
    const cryptoOnly = await listHeldInstrumentQuoteStaleness(appIngestDb, now, FOURTEEN_HOURS_MS, {
      kinds: ["CRYPTO"],
    });
    expect(cryptoOnly).toEqual([]);
  });
});
