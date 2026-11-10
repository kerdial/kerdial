import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { createDb, currency, type Db } from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCurrencies } from "./currency-service.js";

/**
 * IC-12 (DD12) —
 * `listCurrencies` against a real Postgres 17 container, authenticated as
 * `app_web` (migration `0007` already grants `SELECT` on `currency`, no new
 * grant needed).
 */
describe("ledger — listCurrencies (IC-12, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("returns the full seeded ISO 4217 active-currency list, ordered by code, as app_web", async () => {
    const rows = await listCurrencies(appWebDb);

    expect(rows.length).toBeGreaterThan(100);
    const codes = rows.map((r) => r.code);
    expect(codes).toEqual([...codes].sort());

    const eur = rows.find((r) => r.code === "EUR");
    expect(eur).toEqual({ code: "EUR", name: "Euro", minorUnit: 2 });
    const usd = rows.find((r) => r.code === "USD");
    expect(usd).toEqual({ code: "USD", name: "US Dollar", minorUnit: 2 });
  });

  it("excludes a currency once deactivated (is_active = false)", async () => {
    await ownerDb.update(currency).set({ isActive: false }).where(eq(currency.code, "EUR"));

    const rows = await listCurrencies(appWebDb);
    expect(rows.find((r) => r.code === "EUR")).toBeUndefined();

    // restore for any later test in this file/process
    await ownerDb.update(currency).set({ isActive: true }).where(eq(currency.code, "EUR"));
  });
});
