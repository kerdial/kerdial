import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import type {
  CurrencyPair,
  FxObservation,
  FxRateProvider,
  IsoDate,
  QuoteProvider,
} from "@kerdial/market-ports";
import {
  appUser,
  createDb,
  tenant,
  transaction as transactionTable,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  cash,
  seedCashAccounts,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createPortfolio } from "./portfolio-service.js";
import { TransactionWriteService, type TransactionRecord } from "./transaction-write-service.js";

/**
 * **EI-2 / GATE-0b — the `CURRENCY_EXCHANGE` five-row known-answer probe**
 * (RK4; FR-522,
 * AC-434).
 *
 * Records a *near-miss*, and this file is the measurement that decides
 * whether it is only a near-miss. `RecordCurrencyExchangeParams` takes an
 * `exchangeRate` and **no** `targetAmount`; the write derives
 * `target_amount = amount × exchangeRate` (`transaction-write-service.ts`, the
 * `recordCurrencyExchange` `INSERT`) and the row stores no source→target rate
 * of its own. So the export can only *derive* the rate back out as
 * `target_amount / amount`, and the import can only re-derive
 * `target_amount = amount × rate`. Both the stored product and the derived
 * quotient are rounded to a finite scale, and the worry is that some
 * `(amount, target_amount)` pair therefore has **no** finite-scale rate that
 * reproduces the stored target — `amount = 3`, `target = 1` being its own
 * named simplest case.
 *
 * The round trip measured here is exactly the one the CSV will perform:
 *
 *   1. write through the shipped `recordCurrencyExchange`;
 *   2. read `target_amount` back out of Postgres (through `decimalCol`'s
 *      `fromDriver`, so this is the real stored value and not the in-memory
 *      product);
 *   3. derive `exchange_rate = target_amount / amount` at
 *      {@link CSV_RATE_DP} dp — the file column's own planned scale;
 *   4. recompute `amount × exchange_rate` and compare it with the stored
 *      `target_amount` **at the column's stored scale**, which is read from
 *      `information_schema` rather than assumed.
 *
 * Every figure is a `Decimal` end to end; nothing here goes through a float.
 *
 * **The verdict is the deliverable**, not "it ran": the table of stored and
 * derived values is built for every row and carried in the failure message, and
 * the verdict sentence itself is asserted verbatim. If a row ever disagrees,
 * EI-15 must add the pre-authorised additive `targetAmount?: Decimal` to
 * `RecordCurrencyExchangeParams` — so this assertion failing is a design
 * decision being reopened, not a flaky test.
 */
describe("ledger — EI-2: CURRENCY_EXCHANGE rate/target round trip, five known answers", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  const tenantA = "00000000-0000-7000-8000-0000000e1201";
  const userA = "00000000-0000-7000-8000-0000000e12a1";

  /**
   * The scale the CSV's `exchange_rate` column carries. This is a
   * *file-format* constant, not a column scale — no `transaction` column stores
   * a source→target rate at all, which is the whole question.
   */
  const CSV_RATE_DP = 18;

  /** One date for every row, so a single EUR/USD observation covers the fixture. */
  const TRADE_DATE = "2024-03-12";

  /** EUR per 1 USD — the canonical direction. */
  const USD_SERIES: readonly FxObservation[] = [
    { base: "EUR", quote: "USD", rate: new Decimal("0.9165000000"), rateDate: TRADE_DATE },
  ].map((observation) => ({ ...observation, sourceKey: "ei2-fx-provider" }));

  /**
   * The five combinations. Chosen to stress rounding at `target_amount`'s
   * stored scale rather than to be five variations of the same easy shape:
   *
   * | # | why it is here |
   * |---|---|
   * | 1 | the **exact** case that is required — the product needs no rounding at all, so a disagreement here would mean the round trip is broken outright and not merely lossy |
   * | 2 | the **named simplest case**: `amount = 3` with a rate whose product (`0.999999999999999`) is not a clean decimal at the stored scale and rounds up to `1` |
   * | 3 | a retail-sized amount against a 12 dp rate, whose exact product runs well past the stored scale |
   * | 4 | the only row whose **source currency is not the tenant's base** (USD→EUR), so the write also resolves a principal FX rate — the round trip must not depend on that leg |
   * | 5 | the analytic edge: an amount above 1e6 paired with a full {@link CSV_RATE_DP} dp rate. Below 1e6 the recomputation's error is bounded under half an ULP at the stored scale by construction; above it, the stored scale is genuinely at risk and this row is what proves the direction |
   */
  const PROBE_ROWS = [
    {
      label: "exact: 1 000 EUR at 1,09",
      amount: "1000",
      currency: "EUR",
      targetCurrency: "USD",
      exchangeRate: "1.09",
    },
    {
      label: "the named case: 3 EUR at ~1/3",
      amount: "3",
      currency: "EUR",
      targetCurrency: "USD",
      exchangeRate: "0.333333333333333",
    },
    {
      label: "retail, 12 dp rate: 1 234,56 EUR to CHF",
      amount: "1234.56",
      currency: "EUR",
      targetCurrency: "CHF",
      exchangeRate: "0.958733333333",
    },
    {
      label: "non-base source: 4 999,99 USD to EUR",
      amount: "4999.99",
      currency: "USD",
      targetCurrency: "EUR",
      exchangeRate: "0.912345678912",
    },
    {
      label: "edge: 2 500 000,33 EUR at an 18 dp rate",
      amount: "2500000.33",
      currency: "EUR",
      targetCurrency: "CHF",
      exchangeRate: "1.087654321987654321",
    },
  ] as const;

  interface ProbeResult {
    readonly label: string;
    readonly amount: string;
    readonly currency: string;
    readonly targetCurrency: string;
    readonly exchangeRateGiven: string;
    readonly stored: string;
    readonly derivedRate: string;
    readonly recomputed: string;
    readonly agrees: boolean;
    /** Whether the write's own product actually had to be rounded to reach the stored scale. */
    readonly productRounded: boolean;
  }

  function provider(): FxRateProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "ei2-fx-provider",
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async (pairs: CurrencyPair[], from: IsoDate, to: IsoDate) =>
        pairs.flatMap((pair) =>
          pair.base === "EUR" && pair.quote === "USD"
            ? USD_SERIES.filter((o) => o.rateDate >= from && o.rateDate <= to)
            : [],
        ),
      ),
      fetchLatestRates: vi.fn(async (_pairs: CurrencyPair[]) => []),
    } satisfies FxRateProvider;
  }

  function unreachableQuoteProvider(): QuoteProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "ei2-unused-quote-provider",
        assetKinds: ["CRYPTO"] as const,
        supportsLatestQuote: true,
        supportsDailyHistory: true,
        supportsCorporateActions: false,
        maxHistoryYears: 1,
        quoteQuality: "REALTIME" as const,
        delayMinutes: 0,
        batchSize: 20,
      })),
      resolve: vi.fn(async () => []),
      fetchLatest: vi.fn(async () => []),
      fetchDailyHistory: vi.fn(async () => {
        throw new Error("no crypto quote is needed by this probe");
      }),
    } satisfies QuoteProvider;
  }

  function service(): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: provider(),
      tenantId: tenantA,
      baseCurrency: "EUR",
    });
    return new TransactionWriteService({
      db: appWebDb,
      fxRateResolver,
      cryptoRateResolver: new CryptoRateResolver({
        db: appWebDb,
        provider: unreachableQuoteProvider(),
        fxRateResolver,
      }),
    });
  }

  async function findRow(id: string): Promise<TransactionRecord | undefined> {
    return withTenant(appWebDb, tenantA, async (tx) => {
      const [row] = await tx.select().from(transactionTable).where(eq(transactionTable.id, id));
      return row;
    });
  }

  /**
   * `target_amount`'s scale as the *database* reports it, so the comparison
   * below is against the shipped column and not against a number typed into
   * this file. `platform/db/src/schema/transaction.ts` declares
   * `decimalCol("target_amount", 38, 12)`; the assertion that these two agree
   * is in the test, because a future widening of the column changes this
   * probe's answer and must not do so silently.
   */
  async function storedScaleOfTargetAmount(): Promise<number> {
    const [row] = await appWebSql<{ scale: number }[]>`
      SELECT numeric_scale::int AS scale
      FROM information_schema.columns
      WHERE table_name = 'transaction' AND column_name = 'target_amount'`;
    if (row === undefined) {
      throw new Error("transaction.target_amount was not found in information_schema.columns");
    }
    return row.scale;
  }

  function renderTable(results: readonly ProbeResult[], scale: number): string {
    const header = [
      "| # | amount | from | to | exchange_rate given | stored target_amount | derived rate (18 dp) | recomputed amount × derived | agree |",
      "|---|---|---|---|---|---|---|---|---|",
    ];
    const body = results.map(
      (r, i) =>
        `| ${i + 1} | ${r.amount} | ${r.currency} | ${r.targetCurrency} | ${r.exchangeRateGiven} | ${r.stored} | ${r.derivedRate} | ${r.recomputed} | ${r.agrees ? "yes" : "NO"} |`,
    );
    return [`target_amount stored scale: ${scale} dp`, ...header, ...body].join("\n");
  }

  let portfolioId: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;
    appWebSql = postgres(pg.appWebUri, { max: 1 });
    appWebDb = createDb(appWebSql);

    await ownerDb.insert(tenant).values([{ id: tenantA }]);
    await ownerDb
      .insert(appUser)
      .values([
        { id: userA, tenantId: tenantA, email: "a@ei2.example", passwordHash: "argon2id$x" },
      ]);

    portfolioId = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "EI-2 probe" })).id;
    await seedCashAccounts(ownerDb, tenantA, portfolioId, ["EUR", "USD", "CHF"]);
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  it("derives exchange_rate back out of target_amount and reproduces the stored target for all five rows", async () => {
    const scale = await storedScaleOfTargetAmount();
    // Cross-check of the live column against the schema declaration
    // (`decimalCol("target_amount", 38, 12)`): the verdict below is only valid
    // at this scale, so a drift has to fail here rather than quietly change
    // what the probe measured.
    expect(scale, "transaction.target_amount is no longer NUMERIC(38, 12)").toBe(12);

    const results: ProbeResult[] = [];
    for (const row of PROBE_ROWS) {
      const amount = new Decimal(row.amount);
      const exchangeRate = new Decimal(row.exchangeRate);
      const id = randomUUID();

      await service().recordCurrencyExchange({
        id,
        portfolioId,
        tradeDate: TRADE_DATE,
        amount,
        currency: row.currency,
        targetCurrency: row.targetCurrency,
        exchangeRate,
        cashAccountId: cash(portfolioId, row.currency),
        targetCashAccountId: cash(portfolioId, row.targetCurrency),
      });

      const written = await findRow(id);
      expect(written, `${row.label}: the row did not reach the database`).toBeDefined();
      const stored = written!.targetAmount;
      expect(stored, `${row.label}: target_amount was written NULL`).not.toBeNull();

      // Step 3: what the export would put in the CSV's `exchange_rate` column.
      const derivedRate = new Decimal(stored!.dividedBy(amount).toFixed(CSV_RATE_DP));
      // Step 4: what the import would write back, at the column's stored scale.
      const recomputed = new Decimal(amount.times(derivedRate).toFixed(scale));

      results.push({
        label: row.label,
        amount: amount.toString(),
        currency: row.currency,
        targetCurrency: row.targetCurrency,
        exchangeRateGiven: exchangeRate.toString(),
        stored: stored!.toFixed(scale),
        derivedRate: derivedRate.toFixed(CSV_RATE_DP),
        recomputed: recomputed.toFixed(scale),
        agrees: recomputed.equals(stored!),
        productRounded: amount.times(exchangeRate).decimalPlaces() > scale,
      });
    }

    const table = renderTable(results, scale);
    expect(results, table).toHaveLength(PROBE_ROWS.length);

    // The fixture is only a stress test if it actually contains both shapes
    // required — otherwise "0 disagreed" would be five easy rows agreeing.
    expect(
      results.filter((r) => !r.productRounded).map((r) => r.label),
      `no row's product was exact at ${scale} dp — the exact case is missing\n${table}`,
    ).not.toHaveLength(0);
    expect(
      results.filter((r) => r.productRounded).map((r) => r.label),
      `no row's product needed rounding at ${scale} dp — nothing here stresses the stored scale\n${table}`,
    ).not.toHaveLength(0);
    // …and specifically the `amount = 3` case, whose product really is
    // rounded on the way in (0,999999999999999 → 1,000000000000).
    const namedCase = results.find((r) => r.amount === "3");
    expect(namedCase?.productRounded, `the amount=3 row did not round\n${table}`).toBe(true);

    const disagreed = results.filter((r) => !r.agrees);
    const verdict =
      disagreed.length === 0
        ? "PROBE: 0/5 rows disagreed — FR-522 holds in practice; the CSV import writes from `exchange_rate` alone and `targetAmount?` is not needed."
        : `PROBE: ${disagreed.length}/5 rows disagreed — EI-15 (applyImport) must add the pre-authorised additive \`targetAmount?: Decimal\` to \`RecordCurrencyExchangeParams\`.`;

    expect(disagreed, `${verdict}\n\n${table}`).toEqual([]);
    // The verdict itself, written down rather than inferred from a green run —
    // this is the sentence EI-15 is allowed to rely on.
    expect(verdict).toBe(
      "PROBE: 0/5 rows disagreed — FR-522 holds in practice; the CSV import writes from `exchange_rate` alone and `targetAmount?` is not needed.",
    );
  });
});
