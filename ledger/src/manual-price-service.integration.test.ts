import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import {
  resolvePrice,
  valuePortfolio,
  type FxRatePoint,
  type HoldingState,
  type PricePoint,
} from "@kerdial/core-domain";
import {
  createDb,
  instrumentPriceDaily,
  manualPricePoint,
  tenant,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentByIsin } from "./instrument-service.js";
import {
  ManualPricePointScaleExceededError,
  ManualPricePointTenantCapExceededError,
  deleteManualPricePoint,
  listManualPricePoints,
  upsertManualPricePoint,
} from "./manual-price-service.js";

/**
 * T-36 acceptance: the manual price entry write service against a real Postgres 17 container, authenticated as `app_web` —
 * the same shape as `portfolio-service.integration.test.ts` (T-17).
 *
 * `ownerDb` is the superuser handle, used only for
 * out-of-band setup (seeding tenants, an automated `instrument_price_daily`
 * row to prove the override AC against). Every call that exercises the
 * service under test goes through `appWebDb`, the role RLS actually applies
 * to.
 *
 * The "manual overrides automated"/"falls back to last manual NAV" ACs
 * exercise `@kerdial/core-domain`'s already-existing `resolvePrice`/
 * `valuePortfolio` (T-28) directly, fed with rows this file reads back
 * through this service — proving the real write path feeds the real
 * precedence engine, without `ledger` importing `valuation` (which would be
 * a circular workspace dependency, since `valuation` itself imports
 * `ledger`'s `loadPositionTimeline`).
 */
describe("ledger — manual price entry service (T-36, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-00000036000a";
  const tenantB = "00000000-0000-7000-8000-00000036000b";
  // Dedicated to the F3 row-cap test below — a fresh tenant with a
  // deterministic starting row count, so the cap check isn't at the mercy of
  // how many rows tenantA has accumulated from every other test in this file.
  const tenantC = "00000000-0000-7000-8000-00000036000c";

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }, { id: tenantB }, { id: tenantC }]);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /** Projects a `listManualPricePoints` row into the `PricePoint` shape `resolvePrice`/`valuePortfolio` consume — the same projection `valuation/src/materialize.ts` performs. */
  function toPricePoint(row: {
    instrumentId: string;
    priceDate: string;
    close: Decimal;
    currency: string;
    sourceKey: string;
  }): PricePoint {
    return {
      instrumentId: row.instrumentId,
      observedOn: row.priceDate as PricePoint["observedOn"],
      price: row.close,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "MANUAL",
    };
  }

  function oneUnitHolding(instrumentId: string): HoldingState[] {
    return [
      {
        instrumentId,
        quantity: new Decimal("1"),
        costBasisBase: new Decimal("0"),
        pmpUnitBase: new Decimal("0"),
        costBasisNative: new Decimal("0"),
        pmpUnitNative: new Decimal("0"),
        nativeCurrencyMixed: false,
      },
    ];
  }

  const eurRate: FxRatePoint[] = [];

  describe("AC12/FR-16/FR-23 — a FUND with no automated price accepts a NAV point and values via last NAV", () => {
    it("accepts the NAV point and falls back to it (LOCF) on a later valuation date with no automated history at all", async () => {
      const fund = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441700",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 OPCVM fund",
      });

      const written = await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: fund.id,
        priceDate: "2025-03-01",
        close: new Decimal("123.45"),
        currency: "EUR",
      });
      expect(written.sourceKey).toBe("manual");
      expect(written.close.toString()).toBe("123.45");

      const points = (
        await listManualPricePoints(appWebDb, { tenantId: tenantA, instrumentId: fund.id })
      ).map(toPricePoint);

      // No `instrument_price_daily` row exists for this instrument at all —
      // AC12's "no historical-price requirement blocks other functionality".
      const laterDate = "2025-03-20";
      const resolved = resolvePrice(points, fund.id, laterDate);
      expect(resolved?.origin).toBe("MANUAL");
      expect(resolved?.price.toString()).toBe("123.45");
      expect(resolved?.observedOn).toBe("2025-03-01");

      const valuation = valuePortfolio(oneUnitHolding(fund.id), points, eurRate, laterDate, "EUR");
      expect(valuation.totalValueBase.toString()).toBe("123.45");
      expect(valuation.holdings[0]?.price.origin).toBe("MANUAL");
    });
  });

  describe("FR-23 'override' — a manual price for the same date as an automated close takes precedence", () => {
    it("resolvePrice/valuePortfolio return the MANUAL value, not the automated DAILY value, for the shared date", async () => {
      const share = await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FR0000441701",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 override share",
      });

      const sharedDate = "2025-04-10";
      await ownerDb.insert(instrumentPriceDaily).values({
        instrumentId: share.id,
        priceDate: sharedDate,
        closeRaw: new Decimal("50.00"),
        currency: "EUR",
        sourceKey: "eodhd",
        quality: "EOD",
      });

      const manualClose = new Decimal("999.99");
      await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: share.id,
        priceDate: sharedDate,
        close: manualClose,
        currency: "EUR",
      });

      const manualPoints = (
        await listManualPricePoints(appWebDb, { tenantId: tenantA, instrumentId: share.id })
      ).map(toPricePoint);
      const dailyPoints: PricePoint[] = [
        {
          instrumentId: share.id,
          observedOn: sharedDate,
          price: new Decimal("50.00"),
          currency: "EUR",
          sourceKey: "eodhd",
          origin: "DAILY",
        },
      ];
      const allPoints = [...manualPoints, ...dailyPoints];

      const resolved = resolvePrice(allPoints, share.id, sharedDate);
      expect(resolved?.origin).toBe("MANUAL");
      expect(resolved?.price.toString()).toBe(manualClose.toString());
      expect(resolved?.price.toString()).not.toBe("50");

      const valuation = valuePortfolio(
        oneUnitHolding(share.id),
        allPoints,
        eurRate,
        sharedDate,
        "EUR",
      );
      expect(valuation.totalValueBase.toString()).toBe(manualClose.toString());
    });
  });

  describe("FR-45/AC33 — every manual price point carries tenant_id and is invisible to a different tenant's read", () => {
    it("tenant A sees exactly its own point; tenant B's read returns zero rows", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441702",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 isolation fund",
      });

      const written = await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-05-01",
        close: new Decimal("77.00"),
        currency: "EUR",
      });
      expect(written.tenantId).toBe(tenantA);

      const aRows = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
      });
      expect(aRows).toHaveLength(1);
      expect(aRows[0]?.tenantId).toBe(tenantA);
      expect(aRows[0]?.close.toString()).toBe("77");

      const bRows = await listManualPricePoints(appWebDb, {
        tenantId: tenantB,
        instrumentId: instrument.id,
      });
      expect(bRows).toHaveLength(0);

      // Enforced by RLS itself, not merely this service's `where` clause:
      // an unfiltered SELECT scoped to tenant B cannot see tenant A's row.
      const rowsSeenByB = await withTenant(appWebDb, tenantB, async (tx) =>
        tx.select().from(manualPricePoint),
      );
      expect(rowsSeenByB.map((row) => row.instrumentId)).not.toContain(instrument.id);
    });

    it("cannot be used to plant a row in another tenant: RLS's WITH CHECK rejects a raw insert naming a foreign tenant", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441703",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 planted-row fund",
      });

      const planted = withTenant(appWebDb, tenantB, async (tx) => {
        await tx.insert(manualPricePoint).values({
          tenantId: tenantA,
          instrumentId: instrument.id,
          priceDate: "2025-05-02",
          close: new Decimal("1"),
          currency: "EUR",
        });
      });

      await expect(planted).rejects.toThrow();
      const raised = await planted.catch((err: unknown) => err);
      const pgError =
        raised instanceof postgres.PostgresError
          ? raised
          : ((raised as Error).cause as postgres.PostgresError);
      expect(pgError.code).toBe("42501");
      expect(pgError.message).toMatch(/row-level security/i);
    });
  });

  describe("FR-24 — every stored row records source_key = 'manual'", () => {
    it("defaults source_key to 'manual' on both insert and update, and lets an explicit key override it", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441704",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 source_key fund",
      });

      const inserted = await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-06-01",
        close: new Decimal("10"),
        currency: "EUR",
      });
      expect(inserted.sourceKey).toBe("manual");

      const revised = await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-06-01",
        close: new Decimal("11"),
        currency: "EUR",
      });
      expect(revised.sourceKey).toBe("manual");
      expect(revised.close.toString()).toBe("11");

      const withExplicitKey = await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-06-02",
        close: new Decimal("12"),
        currency: "EUR",
        sourceKey: "manual-admin",
      });
      expect(withExplicitKey.sourceKey).toBe("manual-admin");
    });
  });

  describe("CRUD — upsert, list (with date range), delete", () => {
    it("upserts by primary key, lists ordered and range-filtered, and deletes", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441705",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 CRUD fund",
      });

      await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-07-01",
        close: new Decimal("100"),
        currency: "EUR",
      });
      await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-07-15",
        close: new Decimal("110"),
        currency: "EUR",
      });
      await upsertManualPricePoint(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        priceDate: "2025-08-01",
        close: new Decimal("120"),
        currency: "EUR",
      });

      const all = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
      });
      expect(all.map((row) => row.priceDate)).toEqual(["2025-07-01", "2025-07-15", "2025-08-01"]);

      const ranged = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
        fromDate: "2025-07-02",
        toDate: "2025-07-31",
      });
      expect(ranged.map((row) => row.priceDate)).toEqual(["2025-07-15"]);

      const deleted = await deleteManualPricePoint(appWebDb, tenantA, instrument.id, "2025-07-01");
      expect(deleted).toBe(true);

      const deletedAgain = await deleteManualPricePoint(
        appWebDb,
        tenantA,
        instrument.id,
        "2025-07-01",
      );
      expect(deletedAgain).toBe(false);

      const remaining = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
      });
      expect(remaining.map((row) => row.priceDate)).toEqual(["2025-07-15", "2025-08-01"]);
    });

    it("rejects a non-positive close before writing anything", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441706",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-36 non-positive close fund",
      });

      await expect(
        upsertManualPricePoint(appWebDb, {
          tenantId: tenantA,
          instrumentId: instrument.id,
          priceDate: "2025-09-01",
          close: new Decimal("0"),
          currency: "EUR",
        }),
      ).rejects.toThrow(TypeError);

      const rows = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
      });
      expect(rows).toHaveLength(0);
    });

    // NEW-5 (security review, T-37): the API's own Zod
    // schema (`instruments.schema.ts`'s N9 refinement) already rejects a
    // `close` with more than 18 fractional digits, but that check runs only
    // at the HTTP boundary — a non-API caller reaching this service directly
    // could otherwise silently store a value the `numeric(38, 18)` column
    // rounds to `0`. Duplicated here as a machine-readable service-layer
    // guard, defense in depth.
    it("rejects a close with more fractional digits than the column can store, before writing anything", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441707",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 NEW-5 excess-scale fund",
      });

      await expect(
        upsertManualPricePoint(appWebDb, {
          tenantId: tenantA,
          instrumentId: instrument.id,
          priceDate: "2025-09-02",
          // 19 fractional digits — one more than `numeric(38, 18)` can store
          // without Postgres itself silently rounding it away.
          close: new Decimal("0.0000000000000000001"),
          currency: "EUR",
        }),
      ).rejects.toThrow(ManualPricePointScaleExceededError);

      const rows = await listManualPricePoints(appWebDb, {
        tenantId: tenantA,
        instrumentId: instrument.id,
      });
      expect(rows).toHaveLength(0);
    });
  });

  // F3 (security review, T-37): an unbounded per-tenant
  // `manual_price_point` row count is a resource-exhaustion vector — nothing
  // stopped one tenant from writing an arbitrary number of rows. `cap`
  // (`maxRowsPerTenant`) is a testing-only override of the real 500k
  // constant, so this proves the guard without seeding 500k rows.
  describe("F3 — per-tenant manual_price_point row cap", () => {
    it("rejects a brand-new (instrument, date) key once the tenant is at the cap, but still allows revising an existing key", async () => {
      const instrument = await createInstrumentByIsin(appWebDb, {
        kind: "FUND",
        isin: "FR0000441800",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "T-37 F3 row-cap fund",
      });

      await upsertManualPricePoint(appWebDb, {
        tenantId: tenantC,
        instrumentId: instrument.id,
        priceDate: "2025-10-01",
        close: new Decimal("10"),
        currency: "EUR",
        maxRowsPerTenant: 2,
      });
      await upsertManualPricePoint(appWebDb, {
        tenantId: tenantC,
        instrumentId: instrument.id,
        priceDate: "2025-10-02",
        close: new Decimal("11"),
        currency: "EUR",
        maxRowsPerTenant: 2,
      });

      // Revising an existing key never adds a net-new row, so it is allowed
      // through even though the tenant is already at the cap.
      const revised = await upsertManualPricePoint(appWebDb, {
        tenantId: tenantC,
        instrumentId: instrument.id,
        priceDate: "2025-10-01",
        close: new Decimal("10.5"),
        currency: "EUR",
        maxRowsPerTenant: 2,
      });
      expect(revised.close.toString()).toBe("10.5");

      // A genuinely new key is rejected once at the cap.
      await expect(
        upsertManualPricePoint(appWebDb, {
          tenantId: tenantC,
          instrumentId: instrument.id,
          priceDate: "2025-10-03",
          close: new Decimal("12"),
          currency: "EUR",
          maxRowsPerTenant: 2,
        }),
      ).rejects.toThrow(ManualPricePointTenantCapExceededError);

      const rows = await listManualPricePoints(appWebDb, {
        tenantId: tenantC,
        instrumentId: instrument.id,
      });
      expect(rows.map((r) => r.priceDate)).toEqual(["2025-10-01", "2025-10-02"]);
    });
  });
});
