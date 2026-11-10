import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  ensureCashAccount,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { Decimal } from "@kerdial/core-decimal";
import type { IsoDate } from "@kerdial/core-domain";
import { createInstrumentByIsin, createPortfolio, recomputeAndInvalidate } from "@kerdial/ledger";
import {
  createDb,
  fxRateDaily,
  fxRateUser,
  instrumentPriceDaily,
  manualPricePoint,
  tenant,
  transaction,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializePortfolioValuations } from "./materialize.js";
import { fxProvenanceKey, loadPricingSeries } from "./pricing-series.js";

/**
 * SH-6 — **B2**: before this fix, `loadPricingSeries`'
 * FX fallback was pair-level in the weakest possible sense ("the provider has
 * at least one row for this currency"), so the first `fx-daily` write for a
 * currency excluded the tenant's own `fx_rate_user` rows for *every* date,
 * producing a 422 `VALUATION_FX_RATE_UNAVAILABLE` on every earlier valuation
 * date — the overview breaking the day FX ingestion goes live.
 *
 * These are the coverage rule's four worked examples (E1–E4) as known-answer tests,
 * against a real Postgres 17 container, plus the B2 scenario itself stated
 * directly in both of its directions. Same Testcontainers bootstrap as
 * `holdings-valuation.integration.test.ts`; the tenant-scoped reads run as
 * `app_web` under `withTenant`, because `fx_rate_user` is RLS-protected.
 *
 * This file also absorbed the SH-7 release gate's valuation half
 * (`pricing-series.sh7-gate.integration.test.ts`, deleted after the gate
 * passed): that suite re-ran the E1–E4 grid on its own container with other
 * currency pairs, and every case of it that asserted something these examples
 * do not — the real calendar's worst closures, the empty-series inputs to the
 * 422, E4's flip side, and the `materializePortfolioValuations` caller that
 * passes a real `fromDate` — is marked where it landed.
 */

/** A `YYYY-MM-DD` `days` before `date` — the tests' own arithmetic, deliberately not importing the module under test's private helper. */
function daysBefore(date: string, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10) as IsoDate;
}

describe("loadPricingSeries — two-sided, horizon-bounded FX coverage (SH-6, B2)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantId = "00000000-0000-7000-8000-000000560001";
  let isinSeq = 0;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 5 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values({ id: tenantId });
  }, 120_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /**
   * An instrument priced in `currency` on `priceDate` — the only reason the
   * pricing load ever asks about a currency at all (`loadPricingSeries`
   * derives its currency set from the prices it just loaded).
   */
  async function instrumentPricedIn(currency: string, priceDate: string): Promise<string> {
    isinSeq += 1;
    const id = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: `US000000${String(isinSeq).padStart(4, "0")}`,
        exchangeMic: "XNYS",
        listingCurrency: currency,
        displayName: `SH-6 ${currency} share ${randomUUID()}`,
      })
    ).id;
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: id,
      priceDate,
      closeRaw: new Decimal("100"),
      currency,
      sourceKey: "yahoo",
      quality: "EOD",
    });
    return id;
  }

  async function seedProviderRates(
    quoteCurrency: string,
    rows: readonly { rateDate: string; rate: string }[],
  ): Promise<void> {
    await ownerDb.insert(fxRateDaily).values(
      rows.map((row) => ({
        baseCurrency: "EUR",
        quoteCurrency,
        rateDate: row.rateDate,
        rate: new Decimal(row.rate),
        sourceKey: "ecb",
      })),
    );
  }

  /**
   * One provider row every 7 days from `from` up to `to`. Several
   * fixtures below used to seed two endpoints and nothing between them —
   * "published since January, still live in March" as two rows. Condition (3)
   * now rejects that as the interior hole it is (the live EUR/USD hole that
   * motivated condition (3) had exactly that two-endpoint shape), so a fixture that
   * means "a continuously published pair" has to say so. Weekly is the
   * sparsest cadence inside the 14-day horizon that still reads as a list.
   */
  function weekly(from: string, to: string, rate: string): { rateDate: string; rate: string }[] {
    const rows: { rateDate: string; rate: string }[] = [];
    for (
      const cursor = new Date(`${from}T00:00:00.000Z`);
      cursor.getTime() <= Date.parse(`${to}T00:00:00.000Z`);
      cursor.setUTCDate(cursor.getUTCDate() + 7)
    ) {
      rows.push({ rateDate: cursor.toISOString().slice(0, 10), rate });
    }
    return rows;
  }

  async function seedTenantRates(
    quoteCurrency: string,
    rows: readonly { rateDate: string; rate: string }[],
  ): Promise<void> {
    await withTenant(appWebDb, tenantId, async (tx) => {
      await tx.insert(fxRateUser).values(
        rows.map((row) => ({
          tenantId,
          baseCurrency: "EUR",
          quoteCurrency,
          rateDate: row.rateDate,
          rate: new Decimal(row.rate),
        })),
      );
    });
  }

  async function load(params: {
    instrumentIds: readonly string[];
    fromDate?: IsoDate;
    toDate: IsoDate;
    cashCurrencies?: ReadonlyMap<string, IsoDate>;
  }) {
    return withTenant(appWebDb, tenantId, async (tx) =>
      loadPricingSeries(tx, {
        tenantId,
        baseCurrency: "EUR",
        instrumentIds: params.instrumentIds,
        ...(params.fromDate === undefined ? {} : { fromDate: params.fromDate }),
        toDate: params.toDate,
        ...(params.cashCurrencies === undefined ? {} : { cashCurrencies: params.cashCurrencies }),
      }),
    );
  }

  /** Every loaded FX point for one currency, with the table it came from. */
  function pointsFor(
    result: Awaited<ReturnType<typeof load>>,
    currency: string,
  ): { observedOn: string; rate: string; origin: string | undefined }[] {
    return result.fxRates
      .filter((point) => point.currency === currency)
      .map((point) => ({
        observedOn: point.observedOn,
        rate: point.rate.toString(),
        origin: result.fxOriginByKey.get(fxProvenanceKey(currency, point.observedOn)),
      }))
      .sort((a, b) => a.observedOn.localeCompare(b.observedOn));
  }

  it("E1 — a suspended pair (EUR/RUB, last published 2022-03-01) does not cover a 2024 load: the tenant's rates are used and the two-year-old rate is never carried forward", async () => {
    const rubShare = await instrumentPricedIn("RUB", "2024-06-03");
    await seedProviderRates("RUB", [
      { rateDate: "2022-02-25", rate: "0.011" },
      { rateDate: "2022-03-01", rate: "0.010" },
    ]);
    await seedTenantRates("RUB", [{ rateDate: "2024-01-01", rate: "0.0095" }]);

    const result = await load({
      instrumentIds: [rubShare],
      fromDate: "2024-01-01" as IsoDate,
      toDate: "2024-12-31" as IsoDate,
    });

    // Condition (1) passes (2022-03-01 <= 2024-01-01) — precisely where the
    // old wording stopped, and why it wrongly admitted the series. Condition
    // (2) fails: ~1,030 days, far beyond the 14-day horizon.
    expect(pointsFor(result, "RUB")).toEqual([
      { observedOn: "2024-01-01", rate: "0.0095", origin: "USER_PINNED" },
    ]);
    // No stale carry-forward: neither suspended-era observation reaches the engine.
    expect(result.fxRates.some((point) => point.observedOn.startsWith("2022"))).toBe(false);
  });

  it("E2 — a live pair (EUR/USD) over a Christmas-plus-weekend gap is covered: the provider series is used exactly as before, and the tenant's rows are not loaded", async () => {
    const usdShare = await instrumentPricedIn("USD", "2024-12-20");
    await seedProviderRates("USD", [
      // Published since 1999 — condition (1) is never in question for this pair.
      { rateDate: "1999-01-04", rate: "0.85" },
      // The interior of the load has to be dense too. The fixture used
      // to jump from 1999 straight to 2024-12-20 with `fromDate` 2024-12-01 —
      // exactly the holed shape condition (3) now rejects (2024-12-01..19
      // would have carried a 1999 rate). Weekly Fridays keep every stretch
      // inside the horizon while staying a sparse, readable fixture.
      { rateDate: "2024-11-29", rate: "0.94" },
      { rateDate: "2024-12-06", rate: "0.94" },
      { rateDate: "2024-12-13", rate: "0.95" },
      { rateDate: "2024-12-20", rate: "0.95" },
      { rateDate: "2024-12-23", rate: "0.96" },
      { rateDate: "2024-12-24", rate: "0.97" },
      // 25th/26th TARGET holidays, 28th a Saturday — the last publication is Friday the 27th.
      { rateDate: "2024-12-27", rate: "0.98" },
    ]);
    await seedTenantRates("USD", [{ rateDate: "2024-12-01", rate: "1.50" }]);

    const result = await load({
      instrumentIds: [usdShare],
      fromDate: "2024-12-01" as IsoDate,
      toDate: "2024-12-28" as IsoDate,
    });

    const usd = pointsFor(result, "USD");
    // The 1999 row is behind the anchor (2024-11-29, the newest on or
    // before `fromDate`), so no date in the load can resolve to it.
    expect(usd.map((point) => point.origin)).toEqual(Array(7).fill("PROVIDER"));
    expect(usd[0]?.observedOn).toBe("2024-11-29");
    // The tightened condition must not damage the ordinary weekend/holiday
    // path — the tenant's own 1.50 is nowhere in the series.
    expect(usd.some((point) => point.rate === "1.5")).toBe(false);
    expect(usd[usd.length - 1]).toEqual({
      observedOn: "2024-12-27",
      rate: "0.98",
      origin: "PROVIDER",
    });
  });

  it("AC5 — a pair with a 16-year interior hole (EUR/HUF: 1999..2010, then 2026-08-28) is NOT covered for a load over the hole: its provider rows are dropped and the tenant's pinned rows are used", async () => {
    const hufShare = await instrumentPricedIn("HUF", "2026-08-27");
    await seedProviderRates("HUF", [
      // Dense 1999..2010 (every stretch 7 days), then the hole.
      ...weekly("1999-01-08", "2010-02-12", "250"),
      // The live shape: the backfill batch ends 2010-02-14 with a
      // doctored rate, then nothing until the first incremental pull.
      { rateDate: "2010-02-14", rate: "0.5" },
      { rateDate: "2026-08-28", rate: "395" },
    ]);
    await seedTenantRates("HUF", [{ rateDate: "2026-08-01", rate: "400" }]);

    const result = await load({
      instrumentIds: [hufShare],
      fromDate: "2026-08-27" as IsoDate,
      toDate: "2026-08-28" as IsoDate,
    });

    // Both endpoints pass — 2010-02-14 <= 2026-08-27, and 2026-08-28 is on
    // `toDate` — which is precisely what the two-sided test admitted. The
    // interior does not, so the pair falls back exactly as the bad-endpoint
    // cases (E1, E4) do: the tenant's row, and not one provider row.
    expect(pointsFor(result, "HUF")).toEqual([
      { observedOn: "2026-08-01", rate: "400", origin: "USER_PINNED" },
    ]);
    expect(result.fxRates.some((point) => point.rate.toString() === "0.5")).toBe(false);
    expect(
      result.fxRates.some((point) => point.currency === "HUF" && point.observedOn === "2026-08-28"),
    ).toBe(false);
  });

  it("the same holed pair IS covered for a load that stays inside its dense stretch: the hole is behind toDate", async () => {
    const hufShare = await instrumentPricedIn("HUF", "2005-06-03");
    const result = await load({
      instrumentIds: [hufShare],
      fromDate: "2005-05-02" as IsoDate,
      toDate: "2005-06-03" as IsoDate,
    });
    const origins = new Set(pointsFor(result, "HUF").map((point) => point.origin));
    expect(origins).toEqual(new Set(["PROVIDER"]));
    expect(result.fxRates.some((point) => point.rate.toString() === "400")).toBe(false);
  });

  // Folded from the SH-7 release gate (deleted after the gate passed).
  it("a tenant rate dated on the very same day as a provider observation is still not merged in — the source is chosen per pair, not per date", async () => {
    const mxnShare = await instrumentPricedIn("MXN", "2024-12-20");
    await seedProviderRates("MXN", [
      { rateDate: "2024-12-02", rate: "0.048" },
      // The load runs to 2024-12-23, so the interior has to stay inside
      // the horizon — two Mondays between the endpoints.
      { rateDate: "2024-12-09", rate: "0.0478" },
      { rateDate: "2024-12-16", rate: "0.0477" },
      { rateDate: "2024-12-20", rate: "0.0475" },
    ]);
    // A decoy sharing 2024-12-02 with a provider observation: E2's own pin is
    // on a date the provider never published, so only this one can catch a
    // per-date merge.
    await seedTenantRates("MXN", [{ rateDate: "2024-12-02", rate: "9.99" }]);

    const result = await load({
      instrumentIds: [mxnShare],
      fromDate: "2024-12-02" as IsoDate,
      toDate: "2024-12-23" as IsoDate,
    });

    expect(pointsFor(result, "MXN")).toEqual([
      { observedOn: "2024-12-02", rate: "0.048", origin: "PROVIDER" },
      { observedOn: "2024-12-09", rate: "0.0478", origin: "PROVIDER" },
      { observedOn: "2024-12-16", rate: "0.0477", origin: "PROVIDER" },
      { observedOn: "2024-12-20", rate: "0.0475", origin: "PROVIDER" },
    ]);
  });

  describe("the real calendar's worst closures — the case a tightened rule damages most easily", () => {
    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("Good Friday 2024-03-29 through Easter Monday 2024-04-01 — the longest real TARGET non-publication run, four days — is still covered", async () => {
      // Last publication Thursday 2024-03-28; `toDate` is Easter Monday itself.
      const thbShare = await instrumentPricedIn("THB", "2024-03-28");
      await seedProviderRates("THB", [
        { rateDate: "2024-01-02", rate: "0.0265" },
        // Weekly through the quarter, so the only stretch under test is
        // the four-day closure itself.
        ...weekly("2024-01-09", "2024-03-26", "0.026"),
        { rateDate: "2024-03-28", rate: "0.0253" },
      ]);
      await seedTenantRates("THB", [{ rateDate: "2024-01-02", rate: "0.9999" }]);

      const result = await load({
        instrumentIds: [thbShare],
        fromDate: "2024-01-02" as IsoDate,
        toDate: "2024-04-01" as IsoDate,
      });

      const thb = pointsFor(result, "THB");
      expect(thb.length).toBeGreaterThan(2);
      expect(new Set(thb.map((point) => point.origin))).toEqual(new Set(["PROVIDER"]));
      expect(thb[thb.length - 1]).toEqual({
        observedOn: "2024-03-28",
        rate: "0.0253",
        origin: "PROVIDER",
      });
    });

    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("a New-Year Sunday toDate (2025-01-05, last publication Tuesday 2024-12-31) is still covered", async () => {
      const phpShare = await instrumentPricedIn("PHP", "2024-12-30");
      await seedProviderRates("PHP", [
        { rateDate: "2024-06-03", rate: "0.016" },
        // Weekly through the half-year; the stretch under test is the
        // last one, 2024-12-31 → Sunday 2025-01-05.
        ...weekly("2024-06-10", "2024-12-30", "0.0162"),
        { rateDate: "2024-12-31", rate: "0.0165" },
      ]);
      await seedTenantRates("PHP", [{ rateDate: "2024-06-03", rate: "0.5" }]);

      const result = await load({
        instrumentIds: [phpShare],
        fromDate: "2024-06-03" as IsoDate,
        toDate: "2025-01-05" as IsoDate,
      });

      const php = pointsFor(result, "PHP");
      expect(php.length).toBeGreaterThan(2);
      expect(new Set(php.map((point) => point.origin))).toEqual(new Set(["PROVIDER"]));
      expect(php[php.length - 1]).toEqual({
        observedOn: "2024-12-31",
        rate: "0.0165",
        origin: "PROVIDER",
      });
    });
  });

  it("E3 — a pair the provider has never covered still falls back to the tenant's rates, unchanged from before SH-6", async () => {
    const gbpShare = await instrumentPricedIn("GBP", "2024-06-03");
    await seedTenantRates("GBP", [{ rateDate: "2024-05-01", rate: "1.15" }]);

    const result = await load({
      instrumentIds: [gbpShare],
      fromDate: "2024-05-01" as IsoDate,
      toDate: "2024-06-30" as IsoDate,
    });

    expect(pointsFor(result, "GBP")).toEqual([
      { observedOn: "2024-05-01", rate: "1.15", origin: "USER_PINNED" },
    ]);
  });

  it("E4 — a shallow-start pair (provider begins 2010, load begins 2005) is not covered for the whole load: PINNED_FX throughout, not a 422 for 2005–2009 and PROVIDER after", async () => {
    const sekShare = await instrumentPricedIn("SEK", "2024-06-03");
    const recent = daysBefore("2024-12-31", 3);
    await seedProviderRates("SEK", [
      { rateDate: "2010-01-04", rate: "0.098" },
      // Continuously published from 2010 on (weekly, Mondays), so the
      // flip-side case below is decided by condition (1) alone.
      ...weekly("2010-01-11", "2023-12-25", "0.09"),
      { rateDate: "2024-01-02", rate: "0.089" },
      ...weekly("2024-01-08", "2024-12-23", "0.088"),
      { rateDate: recent, rate: "0.087" },
    ]);
    await seedTenantRates("SEK", [
      { rateDate: "2005-01-03", rate: "0.11" },
      { rateDate: "2012-06-01", rate: "0.115" },
    ]);

    const result = await load({
      instrumentIds: [sekShare],
      fromDate: "2005-01-01" as IsoDate,
      toDate: "2024-12-31" as IsoDate,
    });

    // Condition (2) passes; condition (1) fails — and the decision is per
    // pair per load, so the provider rows are dropped for the *whole* load,
    // never merged per date.
    expect(pointsFor(result, "SEK")).toEqual([
      { observedOn: "2005-01-03", rate: "0.11", origin: "USER_PINNED" },
      { observedOn: "2012-06-01", rate: "0.115", origin: "USER_PINNED" },
    ]);
  });

  // Folded from the SH-7 release gate (deleted after the gate passed).
  it("E4's flip side — moving only `fromDate` past the provider's start covers the very same seeded pair: the decision reads `fromDate`, nothing else", async () => {
    // Deliberately re-uses the EUR/SEK series E4 above seeded (provider from
    // 2010-01-04, tenant from 2005-01-03): the only thing that differs here is
    // the load's old end, so nothing but condition (1) can explain the flip.
    const sekShare = await instrumentPricedIn("SEK", "2024-06-04");

    const result = await load({
      instrumentIds: [sekShare],
      fromDate: "2010-01-04" as IsoDate,
      toDate: "2024-12-31" as IsoDate,
    });

    const sek = pointsFor(result, "SEK");
    expect(sek.length).toBeGreaterThan(3);
    expect(new Set(sek.map((point) => point.origin))).toEqual(new Set(["PROVIDER"]));
    expect(sek.some((point) => point.origin === "USER_PINNED")).toBe(false);
  });

  /*
   * portfolio-cash: cash currencies join the FX set. A portfolio
   * with no instrument still loads FX for its non-base cash (the old early
   * return skipped every query, leaving that cash unconverted), and a currency
   * only cash uses is judged covered from its first posting, not from the
   * load's `fromDate`. Re-uses E4's EUR/SEK series (provider from 2010-01-04,
   * tenant from 2005-01-03).
   */
  describe("cash currencies (portfolio-cash)", () => {
    it("no instrument, SEK cash first posted 2012: the FX load still runs and the provider series covers it from the first posting, not from fromDate 2005", async () => {
      const result = await load({
        instrumentIds: [],
        fromDate: "2005-01-01" as IsoDate,
        toDate: "2024-12-31" as IsoDate,
        cashCurrencies: new Map([["SEK", "2012-01-02" as IsoDate]]),
      });

      const sek = pointsFor(result, "SEK");
      expect(sek.length).toBeGreaterThan(3);
      expect(new Set(sek.map((point) => point.origin))).toEqual(new Set(["PROVIDER"]));
      expect(result.prices).toEqual([]);
    });

    it("a currency a price also uses keeps the stricter fromDate rule: the same SEK, priced, falls back to the tenant's rates", async () => {
      const sekShare = await instrumentPricedIn("SEK", "2024-06-05");

      const result = await load({
        instrumentIds: [sekShare],
        fromDate: "2005-01-01" as IsoDate,
        toDate: "2024-12-31" as IsoDate,
        cashCurrencies: new Map([["SEK", "2012-01-02" as IsoDate]]),
      });

      expect(new Set(pointsFor(result, "SEK").map((point) => point.origin))).toEqual(
        new Set(["USER_PINNED"]),
      );
    });

    it("neither an instrument nor a non-base cash currency loads nothing (base-currency cash needs no rate)", async () => {
      const result = await load({
        instrumentIds: [],
        toDate: "2024-12-31" as IsoDate,
        cashCurrencies: new Map([["EUR", "2012-01-02" as IsoDate]]),
      });
      expect(result.prices).toEqual([]);
      expect(result.fxRates).toEqual([]);
    });
  });

  describe("nothing to load at all — the honest input to the 422, never a fabricated rate", () => {
    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("a rejected provider series with no tenant rate in the window loads no FX point at all", async () => {
      // Priced *inside* the window below, so TRY is genuinely one of the
      // currencies the load asks about — an instrument priced outside it would
      // make this assertion vacuous.
      const tryShare = await instrumentPricedIn("TRY", "2023-06-01");
      await seedProviderRates("TRY", [
        { rateDate: "2015-01-05", rate: "0.35" },
        { rateDate: "2021-06-15", rate: "0.099" },
      ]);
      await seedTenantRates("TRY", [{ rateDate: "2024-02-05", rate: "0.03" }]);

      // A window the (suspended) provider series does not cover and the
      // tenant's own single rate is not in either.
      const result = await load({
        instrumentIds: [tryShare],
        fromDate: "2023-01-01" as IsoDate,
        toDate: "2023-12-31" as IsoDate,
      });

      expect(pointsFor(result, "TRY")).toEqual([]);
    });

    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("no provider rows and no tenant rows load nothing at all", async () => {
      const inrShare = await instrumentPricedIn("INR", "2024-06-03");

      const result = await load({
        instrumentIds: [inrShare],
        fromDate: "2024-01-01" as IsoDate,
        toDate: "2024-06-30" as IsoDate,
      });

      expect(result.fxRates).toEqual([]);
      expect(result.fxOriginByKey.size).toBe(0);
    });
  });

  describe("B2 itself — the first fx-daily write must not void the tenant's already-pinned rates", () => {
    it("a currency whose provider series starts after the load keeps the tenant's earlier rows (old end fails)", async () => {
      const nokShare = await instrumentPricedIn("NOK", "2024-03-01");
      // The `fx-daily` job's first successful write, today.
      await seedProviderRates("NOK", [{ rateDate: "2026-08-18", rate: "0.086" }]);
      await seedTenantRates("NOK", [{ rateDate: "2024-01-15", rate: "0.09" }]);

      const result = await load({
        instrumentIds: [nokShare],
        fromDate: "2024-01-15" as IsoDate,
        toDate: "2026-08-19" as IsoDate,
      });

      expect(pointsFor(result, "NOK")).toEqual([
        { observedOn: "2024-01-15", rate: "0.09", origin: "USER_PINNED" },
      ]);
    });

    it("a historical load that ends before the first ingested rate keeps the tenant's rows too (new end fails — the exact 422 case)", async () => {
      const plnShare = await instrumentPricedIn("PLN", "2024-02-01");
      await seedProviderRates("PLN", [{ rateDate: "2026-08-18", rate: "0.23" }]);
      await seedTenantRates("PLN", [{ rateDate: "2024-01-02", rate: "0.22" }]);

      const result = await load({
        instrumentIds: [plnShare],
        fromDate: "2024-01-02" as IsoDate,
        toDate: "2024-06-30" as IsoDate,
      });

      // Before SH-6 this returned *nothing* for PLN — the provider row is
      // outside the `rate_date <= toDate` window, yet the currency counted as
      // "covered", so the tenant's row was excluded and `resolveMarketRate`
      // found no rate at all: 422 `VALUATION_FX_RATE_UNAVAILABLE`.
      expect(pointsFor(result, "PLN")).toEqual([
        { observedOn: "2024-01-02", rate: "0.22", origin: "USER_PINNED" },
      ]);
    });
  });

  describe("the default `fromDate` — a single-date load (`valueHoldingsAsOf`)", () => {
    it("omitting fromDate makes condition (1) implied by condition (2): a live series is still covered", async () => {
      const chfShare = await instrumentPricedIn("CHF", "2024-04-10");
      await seedProviderRates("CHF", [
        { rateDate: "2024-04-05", rate: "1.02" },
        { rateDate: "2024-04-10", rate: "1.03" },
      ]);
      await seedTenantRates("CHF", [{ rateDate: "2024-04-01", rate: "1.10" }]);

      const result = await load({ instrumentIds: [chfShare], toDate: "2024-04-11" as IsoDate });

      // A single-date load keeps only the newest rate of the series.
      expect(pointsFor(result, "CHF")).toEqual([
        { observedOn: "2024-04-10", rate: "1.03", origin: "PROVIDER" },
      ]);
    });

    it("a single-date load reads only the two newest prices per instrument per table on or before toDate; a range load reads the anchor and the range, nothing older", async () => {
      const share = await instrumentPricedIn("EUR", "2024-04-01");
      await ownerDb.insert(instrumentPriceDaily).values(
        ["2024-04-02", "2024-04-03", "2024-04-04", "2024-04-05"].map((priceDate) => ({
          instrumentId: share,
          priceDate,
          closeRaw: new Decimal("100"),
          currency: "EUR",
          sourceKey: "yahoo",
          quality: "EOD" as const,
        })),
      );
      await ownerDb.insert(manualPricePoint).values(
        ["2024-03-01", "2024-03-02", "2024-03-03"].map((priceDate) => ({
          tenantId,
          instrumentId: share,
          priceDate,
          close: new Decimal("90"),
          currency: "EUR",
        })),
      );

      const single = await load({ instrumentIds: [share], toDate: "2024-04-04" as IsoDate });
      const observed = (origin: string, result: typeof single) =>
        result.prices
          .filter((point) => point.origin === origin)
          .map((point) => point.observedOn)
          .sort();

      expect(observed("DAILY", single)).toEqual(["2024-04-03", "2024-04-04"]);
      expect(observed("MANUAL", single)).toEqual(["2024-03-02", "2024-03-03"]);

      const range = await load({
        instrumentIds: [share],
        fromDate: "2024-04-03" as IsoDate,
        toDate: "2024-04-04" as IsoDate,
      });
      // The newest on or before fromDate (the anchor), then every row inside
      // the range; 2024-04-02 and the older manual NAVs can resolve no date in it.
      expect(observed("DAILY", range)).toEqual(["2024-04-03", "2024-04-04"]);
      expect(observed("MANUAL", range)).toEqual(["2024-03-03"]);
    });

    it("omitting fromDate still rejects a series stale past the horizon (15 days, one past the boundary)", async () => {
      const dkkShare = await instrumentPricedIn("DKK", "2024-04-10");
      await seedProviderRates("DKK", [{ rateDate: daysBefore("2024-04-30", 15), rate: "0.134" }]);
      await seedTenantRates("DKK", [{ rateDate: "2024-04-02", rate: "0.13" }]);

      const result = await load({ instrumentIds: [dkkShare], toDate: "2024-04-30" as IsoDate });

      expect(pointsFor(result, "DKK")).toEqual([
        { observedOn: "2024-04-02", rate: "0.13", origin: "USER_PINNED" },
      ]);
    });

    it("the horizon boundary itself is inclusive: exactly 14 days stale is still covered", async () => {
      const czkShare = await instrumentPricedIn("CZK", "2024-04-10");
      await seedProviderRates("CZK", [{ rateDate: daysBefore("2024-04-30", 14), rate: "0.04" }]);
      await seedTenantRates("CZK", [{ rateDate: "2024-04-02", rate: "0.041" }]);

      const result = await load({ instrumentIds: [czkShare], toDate: "2024-04-30" as IsoDate });

      expect(pointsFor(result, "CZK")).toEqual([
        { observedOn: daysBefore("2024-04-30", 14), rate: "0.04", origin: "PROVIDER" },
      ]);
    });
  });

  describe("what the horizon is measured against", () => {
    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("the horizon is anchored to `toDate`, not to wall-clock today: a 2019 load against a 2019 series is covered", async () => {
      const myrShare = await instrumentPricedIn("MYR", "2019-05-02");
      await seedProviderRates("MYR", [
        { rateDate: "2019-01-02", rate: "0.21" },
        // Weekly through the four months, so only the anchoring of the
        // horizon is under test.
        ...weekly("2019-01-09", "2019-04-24", "0.212"),
        { rateDate: "2019-05-02", rate: "0.215" },
      ]);
      await seedTenantRates("MYR", [{ rateDate: "2019-01-02", rate: "0.9999" }]);

      const result = await load({
        instrumentIds: [myrShare],
        fromDate: "2019-01-02" as IsoDate,
        toDate: "2019-05-03" as IsoDate,
      });

      const myr = pointsFor(result, "MYR");
      expect(myr.length).toBeGreaterThan(2);
      expect(new Set(myr.map((point) => point.origin))).toEqual(new Set(["PROVIDER"]));
    });

    // Folded from the SH-7 release gate (deleted after the gate passed).
    it("an observation dated after `toDate` cannot rescue a series that is stale within the load's own window", async () => {
      const idrShare = await instrumentPricedIn("IDR", "2024-03-01");
      await seedProviderRates("IDR", [
        { rateDate: "2024-01-02", rate: "0.000059" },
        // Newest row, but a year past the load's `toDate` — condition (2)
        // reads the newest observation *on or before* `toDate`, which is the
        // 2024-01-02 one, ~180 days stale.
        { rateDate: "2025-06-02", rate: "0.000058" },
      ]);
      await seedTenantRates("IDR", [{ rateDate: "2024-01-02", rate: "0.00006" }]);

      const result = await load({
        instrumentIds: [idrShare],
        fromDate: "2024-01-02" as IsoDate,
        toDate: "2024-06-30" as IsoDate,
      });

      expect(pointsFor(result, "IDR")).toEqual([
        { observedOn: "2024-01-02", rate: "0.00006", origin: "USER_PINNED" },
      ]);
    });
  });

  it("one uncovered currency does not drag a covered one down with it — the decision is per pair", async () => {
    const audShare = await instrumentPricedIn("AUD", "2024-09-02");
    const nzdShare = await instrumentPricedIn("NZD", "2024-09-02");
    await seedProviderRates("AUD", [
      { rateDate: "2024-08-01", rate: "0.60" },
      // Weekly Thursdays through August — the covered pair is covered
      // in the interior too.
      ...weekly("2024-08-08", "2024-08-29", "0.605"),
      { rateDate: "2024-09-02", rate: "0.61" },
    ]);
    // NZD: suspended-shaped — one ancient observation only.
    await seedProviderRates("NZD", [{ rateDate: "2019-01-04", rate: "0.58" }]);
    await seedTenantRates("AUD", [{ rateDate: "2024-08-01", rate: "0.99" }]);
    await seedTenantRates("NZD", [{ rateDate: "2024-08-01", rate: "0.55" }]);

    const result = await load({
      instrumentIds: [audShare, nzdShare],
      fromDate: "2024-08-01" as IsoDate,
      toDate: "2024-09-05" as IsoDate,
    });

    expect(pointsFor(result, "AUD").map((point) => point.origin)).toEqual(
      Array(6).fill("PROVIDER"),
    );
    expect(pointsFor(result, "NZD")).toEqual([
      { observedOn: "2024-08-01", rate: "0.55", origin: "USER_PINNED" },
    ]);

    // Folded from the SH-7 release gate (deleted after the gate passed): the
    // structural property behind both expectations above — one source per
    // currency per load, so `resolveMarketRate`'s precedence can never depend
    // on which source published later.
    const originsPerCurrency = new Map<string, Set<string>>();
    for (const point of result.fxRates) {
      const origin = String(
        result.fxOriginByKey.get(fxProvenanceKey(point.currency, point.observedOn)),
      );
      originsPerCurrency.set(
        point.currency,
        (originsPerCurrency.get(point.currency) ?? new Set<string>()).add(origin),
      );
    }
    for (const [currency, origins] of originsPerCurrency) {
      expect([currency, origins.size]).toEqual([currency, 1]);
    }
  });

  /**
   * Folded from the SH-7 release gate (deleted after the gate passed): every
   * case above calls `loadPricingSeries` directly, so nothing else in this
   * repository proves that `materializePortfolioValuations` passes the
   * engine's real `fromDate` — the only parameter that makes the rule's old
   * end anything other than `toDate`.
   */
  describe("the caller that passes a real `fromDate` — `materializePortfolioValuations`", () => {
    it("a live-but-shallow provider series is rejected because `engineFromDate`, not `toDate`, is the old end", async () => {
      const clpShare = await instrumentPricedIn("CLP", "2024-01-05");
      // Live at `toDate` (9 days stale, well inside the horizon) but published
      // only from a date after the range's first valued one. Defaulting
      // `fromDate` to `toDate` here would admit the series and then throw
      // `UnresolvableRateError` for every date before 2024-03-01.
      await seedProviderRates("CLP", [{ rateDate: "2024-03-01", rate: "0.001" }]);
      await seedTenantRates("CLP", [{ rateDate: "2024-01-01", rate: "0.002" }]);

      const portfolioId = (await createPortfolio(appWebDb, { tenantId, name: "sh6-engine-from" }))
        .id;
      await withTenant(appWebDb, tenantId, async (tx) => {
        // CA-9/`0039`: a fiat-settled row names the cash account its money
        // moved through — a CLP one here, matching the leg's own currency.
        const cashAccountId = await ensureCashAccount(tx, tenantId, portfolioId, "CLP");
        await tx.insert(transaction).values({
          baseCurrency: "EUR",
          id: randomUUID(),
          tenantId,
          portfolioId,
          kind: "BUY",
          tradeDate: "2024-01-05",
          seq: 1n,
          instrumentId: clpShare,
          quantity: new Decimal("10"),
          unitPrice: new Decimal("100"),
          grossAmount: new Decimal("1000"),
          txnCurrency: "CLP",
          // `0046`: the degenerate cash leg mirrors the trade's own currency and amount.
          cashCurrency: "CLP",
          cashAmount: new Decimal("1000"),
          cashAccountId,
          fxRate: new Decimal("0.002"),
          fxRateSource: "USER_PINNED",
        });
      });
      await withTenant(appWebDb, tenantId, async (tx) => {
        await recomputeAndInvalidate(tx, {
          tenantId,
          portfolioId,
          minTradeDate: "2024-01-05",
        });
      });

      const rows = await materializePortfolioValuations(appWebDb, {
        tenantId,
        portfolioId,
        fromDate: "2024-01-05" as IsoDate,
        toDate: "2024-03-10" as IsoDate,
      });

      const byDate = new Map(rows.map((row) => [row.valuationDate, row.totalValueBase.toString()]));
      // 10 units × 100 CLP × 0.002 (the tenant's pin) = 2, on both sides of
      // the provider series' start — and never 10 × 100 × 0.001 = 1.
      expect(byDate.get("2024-01-06")).toBe("2");
      expect(byDate.get("2024-03-10")).toBe("2");
    });
  });
});
