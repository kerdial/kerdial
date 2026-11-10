/**
 * Lane placement (2026-09-11): this file runs in `test:flake-lane`, not `test:main`.
 * Its R6 fixture bulk-loads ~318 200 `instrument_price_daily` rows and then
 * measures a 200-row read against them; alone that is ~20 s, but under
 * `test:main`'s full file parallelism the load plus the Seq Scan crossed the
 * pool's 15 s `statement_timeout` twice in two runs ("canceling statement due
 * to statement timeout"). The measurement is the point of the file, so the
 * fixture stays and the lane moved — a paired edit of BOTH lists in the root
 * `package.json` (`test:main` exclude + `test:flake-lane` file), like
 * `instrument-icon-throttle.e2e.test.ts`. Editing one list makes the file run
 * nowhere.
 */
import { randomUUID } from "node:crypto";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { Decimal } from "@kerdial/core-decimal";
import type { IsoDate } from "@kerdial/core-domain";
import {
  createDb,
  instrument,
  instrumentIcon,
  instrumentPriceDaily,
  manualPricePoint,
  tenant,
  watchlistItem,
  type Db,
} from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_WATCHLIST_ROWS_PER_VIEW,
  WATCHLIST_SERIES_MAX_POINTS,
  valueWatchlistForTenant,
  watchlistSeriesFromDate,
} from "./watchlist-valuation.js";

/**
 * `watchlist` risk **R6** — the DB-facing
 * half of the watchlist read, against real Postgres through the real `app_web`
 * role, plus the two measurements R6 and A5 ask for **by measurement rather
 * than by prediction** (the `holdings-valuation.ts:797-810` habit).
 *
 * ## MEASURED, 2026-09-10 (T-68), on this suite's own fixtures
 *
 * Fixture: 200 watched instruments, one `instrument_price_daily` row per
 * weekday over the whole loaded window (`asOfDate − 5y − 400d` … `asOfDate`) =
 * **318 200 rows** in statement 2 — the predicted worst case, whose arithmetic
 * estimate was ~307 000. Plus a second tenant with a 4-row watchlist against
 * the same relation (the "realistic curated list" regime).
 *
 * **1a. The plan in the realistic regime** — a 4-row watchlist against the
 * 318 200-row relation. `EXPLAIN (ANALYZE, BUFFERS)` on the statement the
 * loader actually emitted (captured off postgres.js's `debug` hook, not a
 * hand-written lookalike):
 *
 * ```
 * Bitmap Heap Scan on instrument_price_daily  (cost=306.37..3742.21 rows=6327 width=44)
 *   (actual time=0.036..0.038 rows=8 loops=1)
 *   Recheck Cond: ((instrument_id = ANY ('{…ids…}'::uuid[]))
 *                  AND (price_date >= '2020-04-27'::date) AND (price_date <= '2026-06-01'::date))
 *   Heap Blocks: exact=1
 *   Buffers: shared hit=13
 *   ->  Bitmap Index Scan on instrument_price_daily_instrument_id_price_date_pk
 *         (actual time=0.029..0.029 rows=8 loops=1)
 *         Index Cond: (… the same three conditions …)
 *         Buffers: shared hit=12
 * Planning Time: 0.081 ms
 * Execution Time: 0.067 ms
 * ```
 *
 * An index range scan on the PK `(instrument_id, price_date)` — **the
 * predicted shape**, and asserted below (index present, no `Seq Scan`). Note the
 * index's real name is drizzle's `…_instrument_id_price_date_pk`, not
 * Postgres' default `…_pkey`.
 *
 * **1b. The plan at the 200-row worst case is NOT the predicted one, and that
 * is the correct plan.** With the watched 200 owning *every* row of the
 * relation, the statement selects ~100 % of it and Postgres prefers a
 * **`Seq Scan`**: measured **3 281 shared buffers / ~59 ms** for 318 200 rows,
 * against **6 105 buffers / ~66 ms** for the PK bitmap scan it chose on the
 * identical data *before* `ANALYZE` gave it statistics. The index plan is the
 * slower one there, so this is the planner being right rather than an index
 * being missing: **no index was added, and the design's named remedy (SQL-side
 * pre-aggregation) is not triggered** — 59 ms of database time is not the cost
 * of this read.
 *
 * **1c. Where the time actually goes.** The whole `valueWatchlistForTenant`
 * call over that fixture measures **~4 s wall**, of which ~59 ms is the
 * database. The cost is CPU-side: materialising 318 200 `PricePoint`s with
 * `Decimal` values and then bucketing/merging/metricising them. Recorded, not
 * optimised — the realistic list is ~20 rows (~1/10th of this), W-3's bucketing
 * already keeps the merge `O(points)` rather than `O(rows × points)`, and the
 * design's revisit trigger is a measured p95 problem on the real screen.
 *
 * **2. The serialised response size** (A5, whose design-time figure of
 * ~1.15 MB was explicitly a hypothesis): `JSON.stringify` of the 200-row
 * `ValuedWatchlist` measured **930 097 bytes ≈ 0.89 MiB**. Uncompressed, and
 * this is the *pre-`api`-mapper* object: the wire body additionally wraps
 * `currentPrice` in the `ValuedAmount` envelope (~150 bytes × 200 rows) and
 * drops the `exchangeMic` input column, so the wire figure is within a few
 * per cent of this. A5's hypothesis is therefore **confirmed to the right
 * order of magnitude and corrected downward, 1.15 MB → ~0.9 MB**; the lever it
 * names ({@link WATCHLIST_SERIES_MAX_POINTS}) is untouched, because ~1 MB at
 * the 200-row cap with 120-point sparklines is what the design accepted. The
 * assertion below is a band, so a 10x regression (a lost decimation, an
 * unbounded window) fails while fixture noise does not.
 *
 * ## The statement count
 *
 * "Three statements, independent of N" is pinned here the way
 * `holdings-query-statement-count.integration.test.ts` pins the holdings
 * baseline: measured off the same `debug` hook, and asserted **twice** — once
 * for a 4-row watchlist and once for the 200-row one — so "independent of N" is
 * a measurement and not a claim.
 */

/**
 * Statements one `valueWatchlistForTenant` call puts on the wire over this
 * suite's fixture, measured: `BEGIN`, `withTenant`'s `set_config`, the three
 * watchlist reads, `COMMIT`. A **rise** means a new round trip (what FR-361/
 * FR-362 forbid); a **fall** means the fixture stopped exercising what it was
 * built to exercise — hence `toBe`.
 */
const BASELINE_WATCHLIST_READ_STATEMENTS = 6;

/** The three reads the count above contains, by table. Named so a failure says *which* read moved. */
const WATCHLIST_READ_TABLES = ["watchlist_item", "instrument_price_daily", "manual_price_point"];

const ASOF = "2026-06-01" as IsoDate;

describe("valuation — valueWatchlistForTenant against real Postgres (R6)", () => {
  let pg: MigratedPostgres;
  let setupSql: postgres.Sql;
  let setupDb: Db;
  /** A second, dedicated connection whose statements are counted — so nothing the fixture does is ever attributed to a measured call. */
  let countedSql: postgres.Sql;
  let countedDb: Db;
  let statementCount = 0;
  let statements: { sql: string; parameters: readonly unknown[] }[] = [];

  const smallTenantId = "00000000-0000-7000-8000-000000680001";
  const capTenantId = "00000000-0000-7000-8000-000000680002";

  const pricedId = randomUUID();
  const barePriceId = randomUUID();
  const delistedId = randomUUID();
  const fundId = randomUUID();

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    setupSql = postgres(pg.appWebUri, { max: 5 });
    setupDb = createDb(setupSql);
    countedSql = postgres(pg.appWebUri, {
      max: 1,
      debug: (_connection, query, parameters) => {
        statementCount += 1;
        statements.push({ sql: query, parameters: parameters as readonly unknown[] });
      },
    });
    countedDb = createDb(countedSql);

    await pg.ownerDb.insert(tenant).values([{ id: smallTenantId }, { id: capTenantId }]);

    // ---- the four-instrument semantic fixture -----------------------------
    await pg.ownerDb.insert(instrument).values([
      {
        id: pricedId,
        kind: "SHARE",
        displayName: "Priced share",
        listingCurrency: "EUR",
        isin: "FRTEST000680",
        exchangeMic: "XPAR",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: barePriceId,
        kind: "CRYPTO",
        displayName: "Never backfilled",
        listingCurrency: "EUR",
        symbol: "WL68BARE",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
      {
        id: delistedId,
        kind: "SHARE",
        displayName: "Delisted share",
        listingCurrency: "EUR",
        isin: "FRTEST000698",
        exchangeMic: "XPAR",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
        status: "DELISTED",
      },
      {
        id: fundId,
        kind: "FUND",
        displayName: "Annual NAV fund",
        listingCurrency: "EUR",
        isin: "FRTEST000706",
        exchangeMic: "XPAR",
        primaryIdentifier: "ISIN",
        quotePolicy: "MANUAL_ONLY",
      },
    ]);

    // IK-10, both branches in one measured call: exactly one of the four
    // carries this tenant's icon, so a `hasIcon` hard-coded either way fails.
    const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await pg.ownerDb.insert(instrumentIcon).values({
      tenantId: smallTenantId,
      instrumentId: pricedId,
      bytes: iconBytes,
      contentType: "image/png",
      byteLength: iconBytes.length,
      widthPx: 64,
      heightPx: 64,
    });

    await pg.ownerDb.insert(watchlistItem).values([
      { tenantId: smallTenantId, instrumentId: pricedId, targetPrice: new Decimal("150") },
      { tenantId: smallTenantId, instrumentId: barePriceId, note: "watched before any price" },
      { tenantId: smallTenantId, instrumentId: delistedId },
      { tenantId: smallTenantId, instrumentId: fundId },
    ]);

    // The priced share: two consecutive weekdays plus a coverage point before
    // 1 January, so YTD is decidable and the day change has a previous
    // observation.
    await pg.ownerDb.insert(instrumentPriceDaily).values([
      {
        instrumentId: pricedId,
        priceDate: "2025-12-31",
        closeRaw: new Decimal("80"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
      {
        instrumentId: pricedId,
        priceDate: "2026-01-02",
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
      {
        instrumentId: pricedId,
        priceDate: "2026-05-29",
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
      {
        instrumentId: pricedId,
        priceDate: "2026-06-01",
        closeRaw: new Decimal("105"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
    ]);

    // FR-377: the delisted instrument's series **stops** two years before
    // `asOfDate` and still sits inside the loaded window, so its metrics
    // compute over whatever exists up to the point the data stopped.
    await pg.ownerDb.insert(instrumentPriceDaily).values([
      // Before the 3Y window's start, so that window is *covered* and its
      // return is a real figure rather than another absence.
      {
        instrumentId: delistedId,
        priceDate: "2023-01-10",
        closeRaw: new Decimal("150"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
      {
        instrumentId: delistedId,
        priceDate: "2024-05-01",
        closeRaw: new Decimal("200"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
      {
        instrumentId: delistedId,
        priceDate: "2024-06-03",
        closeRaw: new Decimal("100"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      },
    ]);

    // The FUND: a manual NAV only, and a *later* daily close on the same date
    // as the NAV so the merge precedence is exercised on real rows too.
    await pg.ownerDb.insert(manualPricePoint).values([
      {
        tenantId: smallTenantId,
        instrumentId: fundId,
        priceDate: "2026-05-04",
        close: new Decimal("50"),
        currency: "EUR",
      },
      {
        tenantId: smallTenantId,
        instrumentId: fundId,
        priceDate: "2026-06-01",
        close: new Decimal("60"),
        currency: "EUR",
      },
    ]);
    await pg.ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: fundId,
      priceDate: "2026-06-01",
      closeRaw: new Decimal("999"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });

    // ---- R6's 200-row fixture, seeded in SQL ------------------------------
    // Row-by-row inserts of ~318 000 price rows through the ORM would dominate
    // this suite's runtime; the point of the fixture is the *plan* and the
    // *size*, so it is built with two set-based statements.
    //
    // The seed runs in one transaction under a widened `statement_timeout`.
    // The owner client carries the production default (15 s, `client.ts`),
    // and the 318 200-row INSERT crossed it on the CI runner (a `main`
    // run: `canceling statement due to statement timeout` at
    // 15 209 ms, every test skipped) while taking ~10 s on this host. The
    // timeout is a property of the *read path* this file measures — the seed
    // is scaffolding — so it is lifted for the seed only, with SET LOCAL, and
    // the read below still runs under the production 15 s.
    await pg.ownerClient.begin(async (sql) => {
      await sql.unsafe(`set local statement_timeout = '240s'`);
      await sql.unsafe(
        `
        with created as (
          insert into instrument (id, kind, display_name, listing_currency, symbol, primary_identifier, quote_policy)
          select gen_random_uuid(), 'CRYPTO', 'R6 fixture ' || lpad(i::text, 4, '0'), 'EUR',
                 'WL68R6' || lpad(i::text, 6, '0'), 'SYMBOL', 'AUTO'
          from generate_series(1, $2::int) i
          returning id
        )
        insert into watchlist_item (tenant_id, instrument_id)
        select $1::uuid, id from created
        `,
        [capTenantId, MAX_WATCHLIST_ROWS_PER_VIEW],
      );
      await sql.unsafe(
        `
        insert into instrument_price_daily (instrument_id, price_date, close_raw, currency, source_key, quality)
        select w.instrument_id, d::date,
               100 + (d::date - $2::date) % 37 + 1,
               'EUR', 'r6-fixture', 'EOD'
        from watchlist_item w
        cross join generate_series($2::date, $3::date, interval '1 day') d
        where w.tenant_id = $1::uuid
          and extract(isodow from d) < 6
        `,
        [capTenantId, watchlistSeriesFromDate(ASOF), ASOF],
      );
      // The plan measured below is only representative if the planner has
      // statistics: a freshly-bulk-loaded table has none, and the first
      // measurement taken here estimated 613 rows for a 318 200-row scan. A
      // production table has been ANALYZEd by autovacuum, so the fixture is too.
      await sql.unsafe(`analyze instrument_price_daily`);
    });
  }, 300_000);

  afterAll(async () => {
    await setupSql?.end({ timeout: 5 });
    await countedSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 60_000);

  function resetCounter(): void {
    statementCount = 0;
    statements = [];
  }

  it("issues exactly three reads — the watchlist join, the daily range, the manual range — inside one transaction", async () => {
    await countedSql`select 1 as warm`;
    resetCounter();

    const view = await valueWatchlistForTenant(countedDb, {
      tenantId: smallTenantId,
      asOfDate: ASOF,
      window: "1Y",
    });

    expect(statementCount).toBe(BASELINE_WATCHLIST_READ_STATEMENTS);
    for (const table of WATCHLIST_READ_TABLES) {
      expect(statements.filter((entry) => entry.sql.includes(`"${table}"`))).toHaveLength(1);
    }
    // No `tenant` read (nothing converts), no `portfolio` read (no
    // `calcEpoch`), no `instrument_quote_latest` read.
    for (const forbidden of ['"tenant"', '"portfolio"', "instrument_quote_latest"]) {
      expect(statements.filter((entry) => entry.sql.includes(forbidden))).toHaveLength(0);
    }
    // The icon join rides the watchlist read as one `LEFT JOIN` and one
    // column — presence, never the bytes.
    const joined = statements.find((entry) => entry.sql.includes('"watchlist_item"'))!;
    expect(joined.sql).toContain("left join");
    expect(joined.sql).toContain("is not null");
    for (const entry of statements) {
      expect(entry.sql).not.toContain("bytes");
    }
    // A count is only meaningful if the call produced the data.
    expect(view.rows).toHaveLength(4);
  }, 60_000);

  it("renders every watched row, with the priced/unpriced distinction intact (FR-346) and both icon branches", async () => {
    const view = await valueWatchlistForTenant(setupDb, {
      tenantId: smallTenantId,
      asOfDate: ASOF,
      window: "1Y",
    });

    expect(view.rows.map((row) => row.displayName)).toEqual([
      "Annual NAV fund",
      "Delisted share",
      "Never backfilled",
      "Priced share",
    ]);

    const priced = view.rows.find((row) => row.instrumentId === pricedId)!;
    expect(priced.hasIcon).toBe(true);
    expect(priced.currentPrice?.amount.toString()).toBe("105");
    expect(priced.currentPrice?.provenance.priceQuality).toBe("EOD");
    expect(priced.currentPrice?.provenance.priceIsStale).toBe(false);
    expect(priced.dayChange?.toString()).toBe("5");
    expect(priced.dayChangePercent?.toString()).toBe("0.05");
    expect(priced.targetPrice?.toString()).toBe("150");
    expect(priced.listingCountry).toBe("FR");
    expect(priced.metrics.periodReturns["YTD"]?.toString()).toBe("0.05");

    // FR-346, at the engine's own boundary: no price row of any origin, the
    // row still renders, nothing throws.
    const bare = view.rows.find((row) => row.instrumentId === barePriceId)!;
    expect(bare.hasIcon).toBe(false);
    expect(bare.currentPrice).toBeUndefined();
    expect(bare.dayChange).toBeUndefined();
    expect(bare.note).toBe("watched before any price");
    expect(bare.series).toEqual([]);
    expect(bare.metrics.unusableSeries).toBe(false);
    expect(bare.metrics.fiftyTwoWeek).toBeUndefined();
    expect(JSON.parse(JSON.stringify(bare.metrics.periodReturns))).toEqual({});

    // The manual NAV wins over the same-date daily close — on
    // real rows from two real tables, not a hand-built array.
    const fund = view.rows.find((row) => row.instrumentId === fundId)!;
    expect(fund.currentPrice?.amount.toString()).toBe("60");
    expect(fund.currentPrice?.provenance.priceQuality).toBe("MANUAL");
    expect(fund.currentPrice?.provenance.derivedFrom).toEqual(["MANUAL_PRICE"]);
    expect(fund.series.map((point) => point.close.toString())).toEqual(["50", "60"]);
  }, 60_000);

  it("FR-377: a DELISTED instrument's metrics compute over whatever exists inside the bounded window", async () => {
    const view = await valueWatchlistForTenant(setupDb, {
      tenantId: smallTenantId,
      asOfDate: ASOF,
      window: "5Y",
    });
    const delisted = view.rows.find((row) => row.instrumentId === delistedId)!;

    expect(delisted.status).toBe("DELISTED");
    // The last close before the data stopped, carried forward by LOCF — and
    // flagged stale, which is the honest signal for a two-year-old price.
    expect(delisted.currentPrice?.amount.toString()).toBe("100");
    expect(delisted.currentPrice?.provenance.priceAsOf).toBe("2024-06-03");
    expect(delisted.currentPrice?.provenance.priceIsStale).toBe(true);
    // Computed over the three points that exist, not refused for the missing
    // two years: a 50 % drawdown (peak 200, trough 100) and a 52-week range
    // over the same points.
    expect(delisted.metrics.maxDrawdown?.fraction.toString()).toBe("-0.5");
    expect(delisted.metrics.fiftyTwoWeek?.high.toString()).toBe("200");
    expect(delisted.metrics.fiftyTwoWeek?.low.toString()).toBe("100");
    // A window the series **does** reach back past is a real figure: 3Y starts
    // 2023-06-01, the series starts 2023-01-10, the anchor is 2024-05-01 (200)
    // and the end is 2024-06-03 (100).
    expect(delisted.metrics.periodReturns["3Y"]?.toString()).toBe("-0.5");
    // And a window it does not reach back past is **unavailable**, never a
    // number measured from a shorter span (AC-331). This is the bounded load's
    // stated consequence for a delisted instrument, asserted rather than
    // assumed.
    expect(delisted.metrics.periodReturns["5Y"]).toBeUndefined();
  }, 60_000);

  it("a second tenant sees none of the first tenant's rows (RLS, FR-376)", async () => {
    const view = await valueWatchlistForTenant(setupDb, {
      tenantId: capTenantId,
      asOfDate: ASOF,
      window: "1Y",
    });
    expect(view.rows.map((row) => row.instrumentId)).not.toContain(pricedId);
    expect(view.rows).toHaveLength(MAX_WATCHLIST_ROWS_PER_VIEW);
  }, 120_000);

  /* ===================================================================== *
   * R6 and A5 — the two measurements, recorded in this file's header.
   * ===================================================================== */

  /**
   * Runs `EXPLAIN (ANALYZE, BUFFERS)` on the `instrument_price_daily`
   * statement the loader **actually emitted** for `tenantId`, with the
   * parameters it actually bound — captured off the same `debug` hook the
   * statement count comes from, so a plan here can never describe a different
   * query than the one that ran.
   */
  async function explainStatementTwoFor(tenantId: string): Promise<string> {
    await countedSql`select 1 as warm`;
    resetCounter();
    await valueWatchlistForTenant(countedDb, { tenantId, asOfDate: ASOF, window: "1Y" });
    const daily = statements.find((entry) => entry.sql.includes('"instrument_price_daily"'));
    expect(daily).toBeDefined();
    const explained = await countedSql.unsafe(
      `explain (analyze, buffers) ${daily!.sql}`,
      daily!.parameters as never[],
    );
    return explained.map((row) => Object.values(row)[0] as string).join("\n");
  }

  /** The bound id arrays are ~7 400 characters and appear twice per plan — elided from the *printout* only; every assertion runs against the full text. */
  function printable(plan: string): string {
    return plan.replace(/'\{[0-9a-f,-]{80,}\}'::uuid\[\]/g, "'{…ids…}'::uuid[]");
  }

  it("R6, the realistic regime: a small watchlist against a large relation is an index range scan on the PK", async () => {
    // The "realistic 20-row curated list", here four rows, against the
    // 318 200-row relation the 200-row tenant seeded. This is the regime the
    // design's prediction is about, and it holds.
    const plan = await explainStatementTwoFor(smallTenantId);
    console.info(`\n[R6] EXPLAIN (ANALYZE, BUFFERS) — 4-row watchlist:\n${printable(plan)}\n`);

    // The composite primary key's own index — named by drizzle's convention
    // (`…_instrument_id_price_date_pk`), which is **not** Postgres' default
    // `…_pkey`: the first version of this assertion looked for `_pkey` and went
    // red against a plan that was in fact correct.
    expect(plan).toContain("instrument_price_daily_instrument_id_price_date_pk");
    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(plan).not.toContain("Seq Scan");
  }, 180_000);

  /**
   * The 200-row worst case, and **the plan is not the predicted one** —
   * recorded as measured rather than argued away, and deliberately **not**
   * asserted into the predicted shape.
   *
   * At this fixture's selectivity the 200 watched instruments own *every* row
   * of `instrument_price_daily`, so the statement selects ~100 % of the
   * relation and Postgres correctly prefers a **Seq Scan** — measured at
   * 3 281 shared buffers / ~59 ms, against the 6 105 buffers / ~66 ms the PK
   * bitmap scan cost on the identical data before `ANALYZE` gave the planner
   * statistics. Choosing the index there would be the *slower* plan, so this
   * is the planner being right, not an index being missing: **no index is
   * added and none is needed** (the same rejected-index precedent as
   * `holdings-valuation.ts:797-810`).
   *
   * What is therefore asserted here is what has to hold under *either* node
   * choice: the window predicate reaches the scan (so the read is bounded by
   * `[fromDate, asOfDate]` and not by the instrument's whole history), the
   * buffer count stays within one relation's worth of pages, and the DB time
   * is a small fraction of the request. R6's remedy — SQL-side pre-aggregation
   * of the long-horizon anchors — is **not** triggered.
   */
  it("R6, the worst case: 318 200 rows scanned in ~59 ms of DB time, bounded by the window predicate", async () => {
    const plan = await explainStatementTwoFor(capTenantId);
    console.info(`\n[R6] EXPLAIN (ANALYZE, BUFFERS) — 200-row watchlist:\n${printable(plan)}\n`);

    // The window bound is in the plan — as an `Index Cond` when the index is
    // chosen, as a `Filter` when it is not. Its absence would mean the lower
    // bound of the window had stopped being applied in SQL.
    expect(plan).toMatch(/2020-04-27/);
    expect(plan).toMatch(/2026-06-01/);
    const buffers = [...plan.matchAll(/shared hit=(\d+)(?: read=(\d+))?/g)].map(
      (match) => Number(match[1]) + Number(match[2] ?? 0),
    );
    expect(buffers.length).toBeGreaterThan(0);
    // ~25 MB of pages for a 318 200-row scan. A ten-fold rise means the window
    // stopped bounding the read.
    expect(Math.max(...buffers)).toBeLessThan(40_000);
    const executionMs = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? "NaN");
    console.info(`\n[R6] statement 2's execution time: ${String(executionMs)} ms\n`);
    expect(executionMs).toBeLessThan(5_000);
  }, 180_000);

  /**
   * The other half of R6's question, and the half the plan does **not**
   * answer: where the 200-row read's time actually goes. MEASURED on this
   * fixture — statement 2 costs ~59 ms of database time (above) while the
   * whole `valueWatchlistForTenant` call takes ~4 s, so the cost is
   * **CPU-side**: materialising 318 200 `PricePoint`s with `Decimal` values,
   * then bucketing/merging/metricising them (W-3's `O(points)` bucketing is
   * what keeps that from being `O(rows × points)`).
   *
   * Recorded rather than optimised: the design's stated revisit trigger is a
   * *measured* p95 problem on the real screen, the realistic list is ~20 rows
   * (~1/10th of this), and the named remedy is SQL-side pre-aggregation of the
   * long-horizon anchors — not a change to this module's shape. The ceiling
   * below is a smoke bound, deliberately loose: this host is a throttling flex
   * instance.
   */
  it("R6: where the time goes — the 200-row worst case end to end, DB time excluded", async () => {
    const startedAt = Date.now();
    const view = await valueWatchlistForTenant(setupDb, {
      tenantId: capTenantId,
      asOfDate: ASOF,
      window: "1Y",
    });
    const elapsedMs = Date.now() - startedAt;
    console.info(
      `\n[R6] valueWatchlistForTenant over ${String(view.rows.length)} rows / ` +
        `318 200 price points: ${String(elapsedMs)} ms wall\n`,
    );
    expect(elapsedMs).toBeLessThan(30_000);
  }, 180_000);

  it("A5: the 200-row response serialises to roughly 1 MB uncompressed — under the design's hypothesised 1.15 MB", async () => {
    const view = await valueWatchlistForTenant(setupDb, {
      tenantId: capTenantId,
      asOfDate: ASOF,
      window: "1Y",
    });

    expect(view.rows).toHaveLength(MAX_WATCHLIST_ROWS_PER_VIEW);
    const bytes = Buffer.byteLength(JSON.stringify(view), "utf8");
    console.info(
      `\n[A5] serialised 200-row ValuedWatchlist: ${String(bytes)} bytes ` +
        `(${(bytes / 1_048_576).toFixed(2)} MiB), series capped at ${String(
          WATCHLIST_SERIES_MAX_POINTS,
        )} points/row\n`,
    );

    // A generous band around the measurement in this file's header: a 10x
    // regression (a forgotten decimation, a window that stopped being bounded)
    // fails, while fixture noise does not.
    expect(bytes).toBeGreaterThan(400_000);
    expect(bytes).toBeLessThan(3_000_000);
    // The decimation is what keeps it there: ~1 590 loaded weekdays per row
    // become at most `WATCHLIST_SERIES_MAX_POINTS + 3` wire points.
    for (const row of view.rows) {
      expect(row.series.length).toBeLessThanOrEqual(WATCHLIST_SERIES_MAX_POINTS + 3);
    }
  }, 180_000);

  it("the statement count is independent of N — the same three reads for 200 rows as for four", async () => {
    await countedSql`select 1 as warm`;
    resetCounter();
    await valueWatchlistForTenant(countedDb, {
      tenantId: capTenantId,
      asOfDate: ASOF,
      window: "1Y",
    });
    expect(statementCount).toBe(BASELINE_WATCHLIST_READ_STATEMENTS);
  }, 180_000);

  it("the fixture really is the predicted worst case — one price row per weekday over the whole loaded window", async () => {
    const [row] = await pg.ownerClient<{ count: string }[]>`
      select count(*)::text as count
      from instrument_price_daily p
      join watchlist_item w on w.instrument_id = p.instrument_id
      where w.tenant_id = ${capTenantId}::uuid
    `;
    const seeded = Number(row!.count);
    console.info(`\n[R6] statement 2's row volume on this fixture: ${String(seeded)} rows\n`);
    // The arithmetic estimate was ~307 000 at the 200-row cap; a fixture
    // an order of magnitude smaller would make the plan above meaningless.
    expect(seeded).toBeGreaterThan(250_000);
  }, 60_000);

  it("the loaded window's floor is honoured — a price row below it is not loaded at all", async () => {
    const belowFloorId = randomUUID();
    await pg.ownerDb.insert(instrument).values({
      id: belowFloorId,
      kind: "CRYPTO",
      displayName: "Zzz below the floor",
      listingCurrency: "EUR",
      symbol: "WL68FLOOR",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    await pg.ownerDb
      .insert(watchlistItem)
      .values({ tenantId: smallTenantId, instrumentId: belowFloorId });
    // One day *before* `asOfDate − 5y − 400d`.
    await pg.ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: belowFloorId,
      priceDate: "2020-04-26",
      closeRaw: new Decimal("42"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });

    const view = await valueWatchlistForTenant(setupDb, {
      tenantId: smallTenantId,
      asOfDate: ASOF,
      window: "5Y",
    });
    const row = view.rows.find((candidate) => candidate.instrumentId === belowFloorId)!;
    // The bounded load's stated consequence: honestly reported as having nothing, rather
    // than paid for with an unbounded history load.
    expect(row.currentPrice).toBeUndefined();
    expect(row.series).toEqual([]);

    await pg.ownerDb.delete(watchlistItem).where(eq(watchlistItem.instrumentId, belowFloorId));
  }, 60_000);
});
