import { Decimal } from "@kerdial/core-decimal";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { createDb, fxRateDaily, fxTrackedPair, type Db } from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fetchTrackedFxPairs,
  listFxPairStatus,
  trackFxPair,
  untrackFxPair,
} from "./fx-tracked-pairs.js";

/**
 * `fx_tracked_pair` against a real Postgres, **through the roles
 * the deployment actually connects as**, not only the Testcontainers
 * superuser.
 *
 * That distinction is this suite's main reason to exist. Migration `0029`'s own
 * doc comment records the precedent: a code path had been "wired" since T-37
 * and silently failing with `permission denied` in every real deployment,
 * because every test that exercised it did so as the owner. The grant cases
 * below connect as `app_web` (the API) and `app_ingest` (the worker) so a
 * missing or over-broad grant in `0044` fails here rather than in production.
 */
describe("fx_tracked_pair — reads, writes, and the two roles' grants (Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  let appIngestSql: postgres.Sql;
  let appIngestDb: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 2 });
    appWebDb = createDb(appWebSql);
    appIngestSql = postgres(pg.appIngestUri, { max: 2 });
    appIngestDb = createDb(appIngestSql);
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await appIngestSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  afterEach(async () => {
    await ownerDb.delete(fxTrackedPair);
    await ownerDb.delete(fxRateDaily);
  });

  it("tracks a pair, reports whether the row was created, and is idempotent on a repeat", async () => {
    expect(await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" })).toBe(true);
    // The second call is the "user pressed add twice" shape: no error, no
    // duplicate row, and `false` so the API can say which of the two happened.
    expect(await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" })).toBe(false);
    expect(await fetchTrackedFxPairs(appWebDb)).toEqual([{ base: "EUR", quote: "SEK" }]);
  });

  it("orders the list base-then-quote, so the worker's log and the screen's table share one order", async () => {
    await trackFxPair(appWebDb, { base: "EUR", quote: "USD" });
    await trackFxPair(appWebDb, { base: "EUR", quote: "NOK" });
    await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" });
    expect((await fetchTrackedFxPairs(appWebDb)).map((pair) => pair.quote)).toEqual([
      "NOK",
      "SEK",
      "USD",
    ]);
  });

  it("untracks a pair and says whether anything was deleted", async () => {
    await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" });
    expect(await untrackFxPair(appWebDb, { base: "EUR", quote: "SEK" })).toBe(true);
    // `false`, not a silent success: the API turns this into 404 rather than
    // reporting a deletion that did not happen.
    expect(await untrackFxPair(appWebDb, { base: "EUR", quote: "SEK" })).toBe(false);
    expect(await fetchTrackedFxPairs(appWebDb)).toEqual([]);
  });

  it("keeps the rates already fetched when a pair is untracked", async () => {
    await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" });
    await ownerDb.insert(fxRateDaily).values({
      baseCurrency: "EUR",
      quoteCurrency: "SEK",
      rateDate: "2026-08-26",
      rate: new Decimal("0.0912"),
      sourceKey: "ecb",
    });

    await untrackFxPair(appWebDb, { base: "EUR", quote: "SEK" });

    // Untracking means "stop fetching this", never "forget what was fetched":
    // a transaction priced from one of these rows keeps its provenance.
    const [coverage] = await listFxPairStatus(appWebDb, [{ base: "EUR", quote: "SEK" }]);
    expect(coverage?.points).toBe(1);
    expect(coverage?.latestRate?.toString()).toBe("0.0912");
  });

  it("rejects a self-pair at the database, not only in the API's validator", async () => {
    // The SQLSTATE and the constraint by name, not a bare `.rejects` — which
    // would pass for a syntax error or a closed connection. Drizzle wraps the
    // driver error, so the assertion is on `cause` (the convention
    // `fx-ingestion-job.integration.test.ts` already uses).
    await expect(trackFxPair(appWebDb, { base: "EUR", quote: "EUR" })).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "fx_tracked_pair_legs_differ" },
    });
  });

  it("rejects a currency code that is not in the seeded ISO 4217 list", async () => {
    await expect(trackFxPair(appWebDb, { base: "EUR", quote: "XXY" })).rejects.toMatchObject({
      cause: { code: "23503" },
    });
  });

  describe("listFxPairStatus", () => {
    it("reports the latest rate, its source, the series span and the point count", async () => {
      await ownerDb.insert(fxRateDaily).values([
        {
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2026-08-24",
          rate: new Decimal("0.85"),
          sourceKey: "ecb",
        },
        {
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2026-08-26",
          rate: new Decimal("0.87"),
          sourceKey: "ecb",
        },
        {
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          rateDate: "2026-08-25",
          // Deliberately the highest value in the series, on a date that is
          // not the latest: a `max(rate)` implementation would return this
          // one and call it current.
          rate: new Decimal("0.99"),
          sourceKey: "manual-admin",
        },
      ]);

      const [coverage] = await listFxPairStatus(appWebDb, [{ base: "EUR", quote: "USD" }]);
      expect(coverage?.latestRate?.toString()).toBe("0.87");
      expect(coverage?.latestRateDate).toBe("2026-08-26");
      expect(coverage?.latestSourceKey).toBe("ecb");
      expect(coverage?.firstRateDate).toBe("2026-08-24");
      expect(coverage?.points).toBe(3);
    });

    it("returns a pair with no rows as zero points and no rate at all — never a zero rate", async () => {
      const [coverage] = await listFxPairStatus(appWebDb, [{ base: "EUR", quote: "SEK" }]);
      expect(coverage).toEqual({ base: "EUR", quote: "SEK", points: 0 });
      // A fabricated `0` here is a rate the app would then be willing to value
      // with, which is the failure this assertion exists to prevent.
      expect(coverage?.latestRate).toBeUndefined();
    });

    it("keeps the requested order and reports each pair independently", async () => {
      await ownerDb.insert(fxRateDaily).values({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2026-08-26",
        rate: new Decimal("0.87"),
        sourceKey: "ecb",
      });

      const coverage = await listFxPairStatus(appWebDb, [
        { base: "EUR", quote: "SEK" },
        { base: "EUR", quote: "USD" },
      ]);
      expect(coverage.map((entry) => entry.quote)).toEqual(["SEK", "USD"]);
      expect(coverage.map((entry) => entry.points)).toEqual([0, 1]);
    });

    it("returns [] for an empty pair list without issuing an unbounded query", async () => {
      await ownerDb.insert(fxRateDaily).values({
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        rateDate: "2026-08-26",
        rate: new Decimal("0.87"),
        sourceKey: "ecb",
      });
      // `or()` of nothing is `undefined` in drizzle — i.e. no predicate at all,
      // which would scan the whole table. The guard is what keeps that from
      // being the behaviour, and this row is here so a regression returns
      // something instead of an empty array.
      expect(await listFxPairStatus(appWebDb, [])).toEqual([]);
    });
  });

  describe("grants (migration 0044) — as the roles the deployment connects as", () => {
    it("app_ingest can read the tracked list (this is how the worker builds its pair set)", async () => {
      await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" });
      expect(await fetchTrackedFxPairs(appIngestDb)).toEqual([{ base: "EUR", quote: "SEK" }]);
    });

    it("app_ingest cannot write the tracked list — a job that could widen its own workload", async () => {
      await expect(trackFxPair(appIngestDb, { base: "EUR", quote: "SEK" })).rejects.toMatchObject({
        cause: { code: "42501", message: "permission denied for table fx_tracked_pair" },
      });
      await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" });
      await expect(untrackFxPair(appIngestDb, { base: "EUR", quote: "SEK" })).rejects.toMatchObject(
        {
          cause: { code: "42501", message: "permission denied for table fx_tracked_pair" },
        },
      );
    });

    it("app_web cannot UPDATE a tracked pair — the row is its key plus a creation time, so there is nothing to update", async () => {
      await trackFxPair(appWebDb, { base: "EUR", quote: "SEK" });
      // Raw SQL, not drizzle: the point is the *grant*, and the query builder
      // has no shape for an update this schema deliberately cannot express.
      await expect(
        appWebSql`UPDATE fx_tracked_pair SET quote_currency = 'NOK'`,
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
