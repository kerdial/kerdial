import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import { createDb, fxRateUser, tenant, type Db } from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FxRateUserScaleExceededError,
  listUserFxRates,
  upsertUserFxRate,
} from "./fx-rate-user-service.js";

/**
 * EI-18 acceptance (`portfolio-export-import`): the **first**
 * write path `fx_rate_user` has ever had, against a real Postgres 17 container.
 *
 * **Every call under test goes through `appWebDb`** — a connection as the real
 * `app_web` login role, not the container superuser `ownerDb` — because the
 * acceptance criterion is a *live grant* proof: `app_web` holds `INSERT` and
 * `UPDATE` on this table and RLS is `FORCE`d against it, and reading the
 * migration's SQL text would prove neither. `ownerDb` is used only to seed the
 * two tenant rows, out of band, exactly as every other service test in this
 * package does.
 *
 * The F-D obligation — that `fx_rate_user` needs **no**
 * migration, no new `OWNER TO` reassignment and no coverage change, because it
 * is already one of `TENANT_SCOPED_TABLES`' 15 entries with RLS enabled and
 * forced — is discharged by running `roles-and-rls.integration.test.ts` and
 * `rls-cross-tenant-isolation.integration.test.ts` **unchanged** and pasting
 * their output into EI-18's report. Re-asserting their content here would be a
 * second copy of a guarantee those suites already own.
 */
describe("ledger — user FX rate write service (EI-18, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000ef18000a";
  const tenantB = "00000000-0000-7000-8000-0000ef18000b";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /** Counts rows for one tenant with the superuser handle, so the assertion does not depend on the same RLS path it is checking. */
  async function countRowsFor(tenantId: string): Promise<number> {
    const rows = await ownerDb.select().from(fxRateUser).where(eq(fxRateUser.tenantId, tenantId));
    return rows.length;
  }

  it("inserts as app_web, and a second conflicting call revises the one row in place", async () => {
    const first = await upsertUserFxRate(appWebDb, {
      tenantId: tenantA,
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate: "2026-03-31",
      rate: new Decimal("1.082400000000"),
    });
    expect(first.rate.toString()).toBe("1.0824");
    expect(first.sourceKey).toBe("user");

    const second = await upsertUserFxRate(appWebDb, {
      tenantId: tenantA,
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      rateDate: "2026-03-31",
      rate: new Decimal("1.090000000000"),
    });
    expect(second.rate.toString()).toBe("1.09");

    // `ON CONFLICT … DO UPDATE` proven, not assumed: one row, carrying the
    // *second* call's rate.
    expect(await countRowsFor(tenantA)).toBe(1);
    const stored = await listUserFxRates(appWebDb, {
      tenantId: tenantA,
      baseCurrencies: ["EUR"],
      quoteCurrencies: ["USD"],
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rate.toString()).toBe("1.09");
  });

  it("keys on the whole (base, quote, date) tuple, so a neighbouring date is a second row", async () => {
    await upsertUserFxRate(appWebDb, {
      tenantId: tenantB,
      baseCurrency: "EUR",
      quoteCurrency: "CHF",
      rateDate: "2026-03-30",
      rate: new Decimal("0.95"),
    });
    await upsertUserFxRate(appWebDb, {
      tenantId: tenantB,
      baseCurrency: "EUR",
      quoteCurrency: "CHF",
      rateDate: "2026-03-31",
      rate: new Decimal("0.96"),
    });

    const stored = await listUserFxRates(appWebDb, {
      tenantId: tenantB,
      baseCurrencies: ["EUR"],
      quoteCurrencies: ["CHF"],
    });
    expect(stored.map((row) => row.rateDate).sort()).toEqual(["2026-03-30", "2026-03-31"]);
  });

  it("returns only the named currencies, and issues no query for an empty set", async () => {
    expect(
      await listUserFxRates(appWebDb, {
        tenantId: tenantB,
        baseCurrencies: ["EUR"],
        quoteCurrencies: ["USD"],
      }),
    ).toEqual([]);
    expect(
      await listUserFxRates(appWebDb, {
        tenantId: tenantB,
        baseCurrencies: [],
        quoteCurrencies: ["CHF"],
      }),
    ).toEqual([]);
  });

  it("refuses a non-positive rate, a self-quote, and a rate finer than the column", async () => {
    const base = {
      tenantId: tenantA,
      baseCurrency: "EUR",
      quoteCurrency: "GBP",
      rateDate: "2026-03-31",
    } as const;

    await expect(upsertUserFxRate(appWebDb, { ...base, rate: new Decimal(0) })).rejects.toThrow(
      TypeError,
    );
    await expect(
      upsertUserFxRate(appWebDb, { ...base, quoteCurrency: "EUR", rate: new Decimal("1") }),
    ).rejects.toThrow(TypeError);
    // numeric(28,12): a 13th fractional digit would be silently rounded away.
    await expect(
      upsertUserFxRate(appWebDb, { ...base, rate: new Decimal("1.0000000000001") }),
    ).rejects.toThrow(FxRateUserScaleExceededError);

    // None of the three wrote anything: tenantA still holds exactly the one row
    // the first test left behind.
    expect(await countRowsFor(tenantA)).toBe(1);
  });
});
