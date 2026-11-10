import { randomUUID } from "node:crypto";
import { OverSellError } from "@kerdial/core-domain";
import { createDb, withTenant, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPositionTimeline } from "./position-replay.js";

/**
 * `security-transfer` — how `loadPositionTimeline` projects the
 * two transfer kinds (FR-564, FR-566), read back as the real
 * `app_web` role.
 *
 * The rows are written as the owner with raw SQL because no production writer
 * of either kind exists yet (`recordTransferOut` is TR-6); every row still
 * passes `0070`'s shape CHECKs, which apply to the owner too. What is under
 * test is the projection, not the write path.
 */
describe("ledger — position-replay projects TRANSFER_OUT / TRANSFER_IN", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000710001";
  const instrumentId = "00000000-0000-7000-8000-000000710021";
  let seq = 0;

  async function newPortfolio(): Promise<string> {
    const id = randomUUID();
    await pg.ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (${id}::uuid, ${tenantId}::uuid, ${`TR-4 ${id.slice(0, 8)}`})`;
    return id;
  }

  /** One cashless row of `kind` (the three share `0056`'s shape); `extra` sets the transfer columns. */
  async function insertCashless(
    portfolioId: string,
    kind: "SHARE_DISTRIBUTION" | "TRANSFER_OUT" | "TRANSFER_IN",
    row: { tradeDate: string; quantity: string; grossAmount: string; txnCurrency: string },
    extra: {
      transfer_source_id?: string | null;
      transfer_cost_base?: string;
      transfer_cost_native?: string;
      transfer_cost_currency?: string;
    } = {},
  ): Promise<string> {
    seq += 1;
    const id = randomUUID();
    await pg.ownerClient`
      INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq, instrument_id,
        quantity, gross_amount, txn_currency, fx_rate, fx_rate_source, transfer_source_id,
        transfer_cost_base, transfer_cost_native, transfer_cost_currency)
      VALUES (${id}::uuid, ${tenantId}::uuid, ${portfolioId}::uuid, ${kind}, ${row.tradeDate}, ${seq},
        ${instrumentId}::uuid, ${row.quantity}, ${row.grossAmount}, ${row.txnCurrency}, '1',
        'IMPLIED_BASE', ${extra.transfer_source_id ?? null}, ${extra.transfer_cost_base ?? null},
        ${extra.transfer_cost_native ?? null}, ${extra.transfer_cost_currency ?? null})`;
    return id;
  }

  const load = (portfolioId: string) =>
    withTenant(appWebDb, tenantId, (tx) => loadPositionTimeline(tx, tenantId, portfolioId));

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
    await pg.ownerClient`INSERT INTO "tenant" (id) VALUES (${tenantId}::uuid)`;
    await pg.ownerClient`
      INSERT INTO "instrument" (id, kind, display_name, listing_currency, symbol,
                                primary_identifier, quote_policy)
      VALUES (${instrumentId}::uuid, 'CRYPTO', 'TR-4 Bitcoin', 'USD', 'TR4BTC', 'SYMBOL', 'AUTO')`;
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("FR-566: a TRANSFER_OUT with no linked target replays as a plain transfer disposal", async () => {
    const portfolioId = await newPortfolio();
    await insertCashless(portfolioId, "SHARE_DISTRIBUTION", {
      tradeDate: "2025-01-10",
      quantity: "2",
      grossAmount: "100",
      txnCurrency: "EUR",
    });
    await insertCashless(portfolioId, "TRANSFER_OUT", {
      tradeDate: "2025-07-09",
      quantity: "0.5",
      grossAmount: "1240.80",
      txnCurrency: "EUR",
    });
    const { timeline } = await load(portfolioId);
    expect(timeline).toHaveLength(2);
    const last = timeline[1]!;
    expect(last.txn.kind).toBe("DISPOSAL");
    expect(last.txn.kind === "DISPOSAL" && last.txn.transfer).toBe(true);
    expect(last.txn.quantity.toFixed()).toBe("0.5");
    expect(last.after.quantity.toFixed()).toBe("1.5");
  });

  it("FR-564: a transfer of more units than held throws the same OverSellError a SELL does", async () => {
    const portfolioId = await newPortfolio();
    await insertCashless(portfolioId, "SHARE_DISTRIBUTION", {
      tradeDate: "2025-01-10",
      quantity: "1",
      grossAmount: "100",
      txnCurrency: "EUR",
    });
    await insertCashless(portfolioId, "TRANSFER_OUT", {
      tradeDate: "2025-07-09",
      quantity: "2",
      grossAmount: "1240.80",
      txnCurrency: "EUR",
    });
    await expect(load(portfolioId)).rejects.toBeInstanceOf(OverSellError);
  });

  it("TRANSFER_IN is projected in transfer_cost_currency, not txn_currency, carrying its stored cost", async () => {
    const sourcePortfolio = await newPortfolio();
    const targetPortfolio = await newPortfolio();
    await insertCashless(sourcePortfolio, "SHARE_DISTRIBUTION", {
      tradeDate: "2025-01-10",
      quantity: "1",
      grossAmount: "100",
      txnCurrency: "EUR",
    });
    const sourceId = await insertCashless(sourcePortfolio, "TRANSFER_OUT", {
      tradeDate: "2025-07-09",
      quantity: "0.01",
      grossAmount: "1240.80",
      txnCurrency: "EUR",
    });
    await insertCashless(
      targetPortfolio,
      "TRANSFER_IN",
      { tradeDate: "2025-07-09", quantity: "0.01", grossAmount: "1240.80", txnCurrency: "EUR" },
      {
        transfer_source_id: sourceId,
        transfer_cost_base: "478",
        transfer_cost_native: "525",
        transfer_cost_currency: "USD",
      },
    );
    const { timeline } = await load(targetPortfolio);
    expect(timeline).toHaveLength(1);
    const [event] = timeline;
    expect(event!.txn.kind).toBe("ACQUISITION");
    expect(event!.txn.txnCurrency).toBe("USD");
    expect(event!.after.costBasisBase.toFixed()).toBe("478");
    expect(event!.after.costBasisNative.toFixed()).toBe("525");
    expect(event!.after.quantity.toFixed()).toBe("0.01");
  });
});
