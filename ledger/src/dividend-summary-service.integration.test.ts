import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import { eq, sql } from "drizzle-orm";
import type { FxRateProvider, QuoteProvider } from "@kerdial/market-ports";
import {
  createDb,
  tenant,
  transaction,
  transactionPosting,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import {
  cash,
  seedCashAccounts,
  startMigratedPostgres,
  type MigratedPostgres,
} from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CryptoRateResolver } from "./crypto-rate-resolver.js";
import {
  AmbiguousDividendTaxLegError,
  DividendBaseCurrencyMismatchError,
  summarizeDividends,
  TooManyDividendInstrumentsError,
  type DividendInstrumentSummary,
  type DividendPeriodSummary,
  type DividendSummary,
  type DividendTotals,
} from "./dividend-summary-service.js";
import { FxRateResolver } from "./fx-rate-resolver.js";
import { createInstrumentByIsin } from "./instrument-service.js";
import { recomputeAndInvalidate } from "./materialization.js";
import { lockPortfolioRow } from "./portfolio-lock.js";
import { createPortfolio } from "./portfolio-service.js";
import { expandPostings, type ExpandableTransaction } from "./posting-expander.js";
import { testMinorUnitOf } from "./posting-expander.test-support.js";
import { TransactionWriteService } from "./transaction-write-service.js";

/**
 * DS-2 (Batch A) — the
 * known-answer proof for `dividend-summary-service.ts`, against a real
 * Postgres 17 container through the shared-Postgres harness, reading as the
 * real `app_web` role inside `withTenant` (the
 * `transaction-read-service.integration.test.ts` pattern).
 *
 * **Every expected figure below is hand-computed and
 * restated here with its arithmetic**, never copied from the implementation's
 * own output. The fixture is the grading criterion for AC-282–AC-289 and
 * AC-291, and it is deliberately non-degenerate in three ways that a
 * carelessly-built fixture would lose:
 *
 *  - the three instruments' French-collated name order and their
 *    gross-descending order are neither the same ordering nor each other's
 *    reverse (AC-284), so a sort assertion cannot pass on the wrong key;
 *  - the DRIP (row 3) reinvests exactly the dividend that precedes it (row 2)
 *    and carries the *same* amount, so an implementation that counted it would
 *    double row 2 rather than produce an obviously silly number (AC-282);
 *  - 2019-02 has no dividend and 2021–2023 have no dividend, so a bucket
 *    silently merged into its neighbour is caught by a **length** assertion,
 *    not only by a value one (AC-289).
 *
 * Wire form: every expected decimal is written as `serializeDecimal` would
 * emit it (`Decimal#toFixed()`, trailing zeros normalised away — `"60"`, never
 * `"60.000000000000"`, A7), which is what {@link wire} below produces. So the
 * A7 normalisation is red-confirmed by every assertion in this file rather
 * than by one dedicated test.
 */
describe("ledger — dividend summary service (DS-1/DS-2, Testcontainers)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;

  /** The tenant: the whole worked fixture, EUR base. */
  const tenantA = "00000000-0000-7000-8000-00000265000a";
  /** The isolation counterparty — one DIVIDEND that tenant A must never see. */
  const tenantB = "00000000-0000-7000-8000-00000265000b";
  /** A tenant with a row in `tenant` and nothing else: the empty shape. */
  const tenantEmpty = "00000000-0000-7000-8000-00000265000c";
  /** AC-291's bulk-fixture tenant. */
  const tenantBulk = "00000000-0000-7000-8000-00000265000d";
  /** DV11's out-of-band costed DIVIDEND, which no API path can produce. */
  const tenantCosted = "00000000-0000-7000-8000-00000265000e";
  /** AR-5's provenance guard: a posting relabelled out of band, which the insert trigger cannot catch. */
  const tenantMislabelled = "00000000-0000-7000-8000-00000265000f";

  /** X «Air Liquide» — five payments across three years and two portfolios. */
  let instrumentX: string;
  /** Y «Apple Inc.» — the one USD payment, the only withholding leg in the fixture. */
  let instrumentY: string;
  /** Z «Bouygues» — one payment, and the row whose `"60"` proves A7's no-scale-padding. */
  let instrumentZ: string;
  let instrumentOther: string;
  let instrumentBulk: string;
  let instrumentCosted: string;
  let instrumentMislabelled: string;

  let portfolioP1: string;
  let portfolioP2: string;
  let portfolioBulk: string;
  let portfolioCosted: string;
  let portfolioMislabelled: string;

  /** AC-282's DRIP-invariance "before" run: the fixture with row 3 absent. */
  let withoutDrip: DividendSummary;

  /**
   * The provider is unreachable by construction and that is an assertion in
   * itself: every EUR leg resolves `IMPLIED_BASE` (currency == the tenant base)
   * and the one USD leg pins its rate through `fxRateUserInput`, both of which
   * are early returns in `FxRateResolver#resolve`. A fixture that quietly
   * depended on a fetched rate would fail here rather than pass with a rate
   * nobody chose.
   */
  function unreachableFxProvider(): FxRateProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused-fx-provider",
        publishedPairs: [{ base: "EUR", quote: "USD" }],
        baseCurrency: "EUR",
        publicationTimeUtc: "15:00",
        maxHistoryYears: "unbounded" as const,
      })),
      fetchDailyRates: vi.fn(async () => {
        throw new Error("no FX provider call is expected: every rate in this fixture is pinned");
      }),
      fetchLatestRates: vi.fn(async () => []),
    } satisfies FxRateProvider;
  }

  function unreachableQuoteProvider(): QuoteProvider {
    return {
      capabilities: vi.fn(() => ({
        key: "unused-quote-provider",
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
        throw new Error("no CRYPTO settlement scenario in this file");
      }),
    } satisfies QuoteProvider;
  }

  function serviceFor(tenantId: string): TransactionWriteService {
    const fxRateResolver = new FxRateResolver({
      db: appWebDb,
      provider: unreachableFxProvider(),
      tenantId,
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

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    appWebSql = postgres(pg.appWebUri, { max: 5 });
    appWebDb = createDb(appWebSql);

    await ownerDb
      .insert(tenant)
      .values([
        { id: tenantA },
        { id: tenantB },
        { id: tenantEmpty },
        { id: tenantBulk },
        { id: tenantCosted },
        { id: tenantMislabelled },
      ]);

    // Synthetic ISINs with valid ISO 6166 check digits and a `TEST` NSIN
    // (IR-22): migration `0037` seeds the real large-cap identifiers into the
    // shared catalogue, so a fixture reusing one collides on
    // `instrument_isin_exchange_mic_key`.
    instrumentX = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST007003",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Air Liquide",
      })
    ).id;
    instrumentY = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "USTEST008001",
        exchangeMic: "XNAS",
        listingCurrency: "USD",
        displayName: "Apple Inc.",
      })
    ).id;
    instrumentZ = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST007011",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Bouygues",
      })
    ).id;
    instrumentOther = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST007029",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Société Générale",
      })
    ).id;
    instrumentBulk = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST007037",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Vinci",
      })
    ).id;
    instrumentCosted = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST007045",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Orange",
      })
    ).id;
    instrumentMislabelled = (
      await createInstrumentByIsin(appWebDb, {
        kind: "SHARE",
        isin: "FRTEST007052",
        exchangeMic: "XPAR",
        listingCurrency: "EUR",
        displayName: "Danone",
      })
    ).id;

    portfolioP1 = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "DS-2 P1" })).id;
    portfolioP2 = (await createPortfolio(appWebDb, { tenantId: tenantA, name: "DS-2 P2" })).id;
    await seedCashAccounts(ownerDb, tenantA, portfolioP1);
    await seedCashAccounts(ownerDb, tenantA, portfolioP2);

    const writer = serviceFor(tenantA);

    // Rows 1, 2, 4, 5, 7, 8 (EUR, degenerate settlement) and row 6 (USD,
    // with the withholding leg). **Row 3, the DRIP, is deliberately written
    // later**, so AC-282's invariance pair is a genuine before/after over the
    // same database rather than two hand-built fixtures.
    const eurDividend = async (
      portfolioId: string,
      instrumentId: string,
      tradeDate: string,
      amount: string,
    ): Promise<string> =>
      (
        await writer.recordDividend({
          portfolioId,
          instrumentId,
          tradeDate,
          amount: new Decimal(amount),
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        })
      ).id;

    await eurDividend(portfolioP1, instrumentX, "2019-01-15", "10.00"); // row 1
    const row2 = await eurDividend(portfolioP1, instrumentX, "2019-03-20", "15.50"); // row 2
    await eurDividend(portfolioP1, instrumentX, "2020-02-05", "7.25"); // row 4
    await eurDividend(portfolioP1, instrumentX, "2024-06-10", "4.50"); // row 5
    await writer.recordDividend({
      // row 6 — 100,00 USD gross, 15,00 USD withheld, the principal pinned at
      // 0,9234 so `amount_base` is 92,34 and −13,851 exactly.
      portfolioId: portfolioP1,
      instrumentId: instrumentY,
      tradeDate: "2024-06-10",
      amount: new Decimal("100.00"),
      currency: "USD",
      cashAccountId: cash(portfolioP1, "USD"),
      fxRateUserInput: new Decimal("0.923400000000"),
      // The withholding takes the principal's rate, so 0,9234 for both.
      withholding: { amount: new Decimal("15.00") },
    });
    await eurDividend(portfolioP2, instrumentX, "2024-06-10", "3.00"); // row 7
    await eurDividend(portfolioP1, instrumentZ, "2024-06-10", "60.00"); // row 8

    // **Not one of the fixture's eight rows, and it deliberately moves none of its
    // figures.** A BUY carrying a `tax` cost component emits a `TAX` posting of
    // its own (`posting-expander.ts`: a trade tax classifies `TAX`, the same
    // class a withheld dividend tax carries), on the same instrument and in the
    // same month as rows 5-8. It is here so `t.kind = 'DIVIDEND'` — the one
    // predicate that is load-bearing specifically for the withholding half —
    // is covered by something: without it this 5,00 leaks into X's
    // «Retenue à la source». Every expectation below is unchanged by its
    // presence, which is the point.
    await writer.recordBuy({
      portfolioId: portfolioP1,
      instrumentId: instrumentX,
      tradeDate: "2024-06-10",
      quantity: new Decimal("1"),
      unitPrice: new Decimal("50.00"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioP1, "EUR"),
      fee: { components: { tax: new Decimal("5.00") } },
    });

    // AC-282's "before": the identical fixture with row 3 absent.
    withoutDrip = await summarizeDividends(appWebDb, { tenantId: tenantA });

    // Row 3 — the DRIP that reinvests row 2, same instrument, same 15,50, one
    // day later (AC6 requires the `sourceDividendId` link).
    await writer.recordDrip({
      portfolioId: portfolioP1,
      instrumentId: instrumentX,
      sourceDividendId: row2,
      tradeDate: "2019-03-21",
      quantity: new Decimal("0.5"),
      unitPrice: new Decimal("31.00"),
      txnCurrency: "EUR",
      cashAccountId: cash(portfolioP1, "EUR"),
    });

    // Tenant B's own single dividend — the cross-tenant isolation counterparty.
    const portfolioB = (await createPortfolio(appWebDb, { tenantId: tenantB, name: "DS-2 B" })).id;
    await seedCashAccounts(ownerDb, tenantB, portfolioB);
    await serviceFor(tenantB).recordDividend({
      portfolioId: portfolioB,
      instrumentId: instrumentOther,
      tradeDate: "2024-06-10",
      amount: new Decimal("11.00"),
      currency: "EUR",
      cashAccountId: cash(portfolioB, "EUR"),
    });

    portfolioBulk = (await createPortfolio(appWebDb, { tenantId: tenantBulk, name: "DS-2 bulk" }))
      .id;
    await seedCashAccounts(ownerDb, tenantBulk, portfolioBulk);
    portfolioCosted = (
      await createPortfolio(appWebDb, { tenantId: tenantCosted, name: "DS-2 costed" })
    ).id;
    await seedCashAccounts(ownerDb, tenantCosted, portfolioCosted);

    // AR-5's guard gets its own tenant so relabelling its postings cannot
    // perturb any other assertion in this file.
    portfolioMislabelled = (
      await createPortfolio(appWebDb, { tenantId: tenantMislabelled, name: "DS-2 mislabelled" })
    ).id;
    await seedCashAccounts(ownerDb, tenantMislabelled, portfolioMislabelled);
    await serviceFor(tenantMislabelled).recordDividend({
      portfolioId: portfolioMislabelled,
      instrumentId: instrumentMislabelled,
      tradeDate: "2024-06-10",
      amount: new Decimal("20.00"),
      currency: "EUR",
      cashAccountId: cash(portfolioMislabelled, "EUR"),
    });
  }, 180_000);

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await pg?.stop();
  }, 30_000);

  /**
   * The service's `Decimal`s rendered exactly as `serializeDecimal` will render
   * them on the wire (`Decimal#toFixed()`, A7) — so every expectation below is
   * written in the fixture's own form and a scale-padded `"60.000000000000"` fails.
   */
  function wire(summary: DividendSummary): WireSummary {
    const toWirePeriod = (row: DividendPeriodSummary): WirePeriod => ({
      period: row.period,
      grossBase: row.grossBase.toFixed(),
      withholdingBase: row.withholdingBase.toFixed(),
    });
    const toWireInstrument = (row: DividendInstrumentSummary): WireInstrument => ({
      instrumentId: row.instrumentId,
      displayName: row.displayName,
      symbol: row.symbol,
      hasIcon: row.hasIcon,
      grossBase: row.grossBase.toFixed(),
      withholdingBase: row.withholdingBase.toFixed(),
      paymentCount: row.paymentCount,
    });
    return {
      baseCurrency: summary.baseCurrency,
      from: summary.from,
      to: summary.to,
      portfolioId: summary.portfolioId,
      total: {
        grossBase: summary.total.grossBase.toFixed(),
        withholdingBase: summary.total.withholdingBase.toFixed(),
      },
      instruments: summary.instruments.map(toWireInstrument),
      years: summary.years.map(toWirePeriod),
      months: summary.months.map(toWirePeriod),
    };
  }

  /**
   * Every decimal figure the response carries, in one flat list — totals,
   * per-instrument rows, years and months.
   *
   * Exists so a "this number never appears" assertion can be made against the
   * figures alone. The obvious form, `JSON.stringify(summary)`, also scans
   * `instrumentId` and `displayName`: a short numeric needle then matches a
   * random UUID and reports a figure error that is not there (CI, 2026-09-07 —
   * see the mixed-currency withholding case below). `paymentCount` is deliberately excluded: it is a
   * count, not a figure, and nothing here asserts about it.
   */
  function everyFigure(summary: WireSummary): string[] {
    return [
      summary.total.grossBase,
      summary.total.withholdingBase,
      ...summary.instruments.flatMap((row) => [row.grossBase, row.withholdingBase]),
      ...summary.years.flatMap((row) => [row.grossBase, row.withholdingBase]),
      ...summary.months.flatMap((row) => [row.grossBase, row.withholdingBase]),
    ];
  }

  function instrumentRow(
    summary: WireSummary,
    instrumentId: string,
  ): { grossBase: string; withholdingBase: string; paymentCount: number } {
    const row = summary.instruments.find((each) => each.instrumentId === instrumentId);
    if (row === undefined) {
      throw new Error(
        `no instruments[] row for ${instrumentId} — the fixture or the fold is wrong`,
      );
    }
    // Projected to the three figures, so a `toEqual` against them is exact
    // rather than quietly tolerant of the two identity keys.
    return {
      grossBase: row.grossBase,
      withholdingBase: row.withholdingBase,
      paymentCount: row.paymentCount,
    };
  }

  describe("AC-282 — the worked fixture, and DRIP exclusion proved empirically (FR-267)", () => {
    it("returns each instrument's hand-computed gross, withholding and payment count", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));

      // X: 10,00 + 15,50 + 7,25 + 4,50 + 3,00 = 40,25 over five payments.
      // Y: 100,00 × 0,9234 = 92,34 gross, 15,00 × 0,9234 = 13,851 withheld.
      // Z: 60,00, and `"60"` rather than `"60.000000000000"` (A7).
      expect(summary.instruments).toEqual([
        {
          instrumentId: instrumentY,
          displayName: "Apple Inc.",
          symbol: null,
          hasIcon: false,
          grossBase: "92.34",
          withholdingBase: "13.851",
          paymentCount: 1,
        },
        {
          instrumentId: instrumentZ,
          displayName: "Bouygues",
          symbol: null,
          hasIcon: false,
          grossBase: "60",
          withholdingBase: "0",
          paymentCount: 1,
        },
        {
          instrumentId: instrumentX,
          displayName: "Air Liquide",
          symbol: null,
          hasIcon: false,
          grossBase: "40.25",
          withholdingBase: "0",
          paymentCount: 5,
        },
      ]);
      expect(summary.baseCurrency).toBe("EUR");
      expect(summary.from).toBeNull();
      expect(summary.to).toBeNull();
      expect(summary.portfolioId).toBeNull();
    });

    it("is byte-identical with and without the linked DRIP (row 3), gross AND paymentCount", async () => {
      // `withoutDrip` was taken before row 3 existed; the fixture now holds it.
      // The DRIP reinvests row 2's exact 15,50, so an implementation that
      // counted it would report X at 55,75 / 6 payments.
      const after = await summarizeDividends(appWebDb, { tenantId: tenantA });

      expect(JSON.stringify(wire(after).instruments)).toBe(
        JSON.stringify(wire(withoutDrip).instruments),
      );
      expect(instrumentRow(wire(after), instrumentX)).toEqual({
        grossBase: "40.25",
        withholdingBase: "0",
        paymentCount: 5,
      });
      expect(instrumentRow(wire(withoutDrip), instrumentX)).toEqual({
        grossBase: "40.25",
        withholdingBase: "0",
        paymentCount: 5,
      });

      // And the DRIP really is in the database for the "after" run — otherwise
      // the equality above would be vacuous, which is exactly the shape of
      // "watched it pass without watching it be able to fail".
      const drips = await withTenant(appWebDb, tenantA, async (tx) =>
        tx.select({ id: transaction.id }).from(transaction).where(eq(transaction.kind, "DRIP")),
      );
      expect(drips).toHaveLength(1);
    });
  });

  describe("AC-283 — gross and withholding are two fields, never netted (LD-1)", () => {
    it("carries 92.34 and 13.851 separately, and 78.489 appears nowhere in the response", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));
      const apple = instrumentRow(summary, instrumentY);

      // Both keys read, not one asserted and the other assumed present.
      expect(apple.grossBase).toBe("92.34");
      expect(apple.withholdingBase).toBe("13.851");

      // 92,34 − 13,851 = 78,489: the netted figure LD-1 forbids.
      expect(new Decimal("92.34").minus("13.851").toFixed()).toBe("78.489");
      expect(JSON.stringify(summary)).not.toContain("78.489");
      expect(summary.total.withholdingBase).toBe("13.851");
    });
  });

  describe("AC-284/AC-285 — two orderings that are neither equal nor reverses (DV7)", () => {
    it("returns gross-descending, while French collation gives a genuinely different order", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));

      const grossDescending = summary.instruments.map((row) => row.displayName);
      expect(grossDescending).toEqual(["Apple Inc.", "Bouygues", "Air Liquide"]);

      // The client re-sorts by name through `Intl.Collator("fr", …)` (DV7); the
      // fixture is built so that order is a third permutation, so a sort test
      // cannot pass by silently falling back to the other key.
      const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
      const byName = [...grossDescending].sort(collator.compare);
      expect(byName).toEqual(["Air Liquide", "Apple Inc.", "Bouygues"]);
      expect(byName).not.toEqual(grossDescending);
      expect([...byName].reverse()).not.toEqual(grossDescending);
    });

    it("AC-285 — total.grossBase equals the hand-added sum of the three instrument rows", async () => {
      const summary = await summarizeDividends(appWebDb, { tenantId: tenantA });
      // 40,25 + 92,34 + 60,00 = 192,59, added here rather than read back.
      const handSum = new Decimal("40.25").plus("92.34").plus("60.00");
      expect(handSum.toFixed()).toBe("192.59");
      expect(summary.total.grossBase.toFixed()).toBe("192.59");
      expect(summary.total.grossBase.equals(handSum)).toBe(true);
    });
  });

  describe("AC-286 — the unselected default is all-time, not a trailing window (FR-271)", () => {
    it("includes the 2019-01-15 payment when no from/to is given", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));

      expect(summary.months.map((row) => row.period)).toContain("2019-01");
      expect(summary.months.find((row) => row.period === "2019-01")?.grossBase).toBe("10");

      // A 1Y-defaulting control (the exact failure reusing `resolveReturnWindow`
      // would produce) drops rows 1, 2 and 4 and reports X at 7,50.
      const airLiquide = instrumentRow(summary, instrumentX);
      expect(airLiquide.grossBase).toBe("40.25");
      expect(airLiquide.grossBase).not.toBe("7.5");
      expect(airLiquide.paymentCount).toBe(5);
    });
  });

  describe("AC-287 — the period bounds instruments and buckets together, from ONE call", () => {
    it("scopes instruments[], years[] and months[] with the same from/to", async () => {
      const summary = wire(
        await summarizeDividends(appWebDb, {
          tenantId: tenantA,
          from: "2024-01-01",
          to: "2024-12-31",
        }),
      );

      // X in 2024 = 4,50 (P1) + 3,00 (P2) = 7,50; total = 7,50 + 92,34 + 60,00.
      expect(instrumentRow(summary, instrumentX).grossBase).toBe("7.5");
      expect(instrumentRow(summary, instrumentY).grossBase).toBe("92.34");
      expect(instrumentRow(summary, instrumentZ).grossBase).toBe("60");
      expect(summary.total.grossBase).toBe("159.84");
      expect(summary.years).toEqual([
        { period: "2024", grossBase: "159.84", withholdingBase: "13.851" },
      ]);
      expect(summary.months).toEqual([
        { period: "2024-06", grossBase: "159.84", withholdingBase: "13.851" },
      ]);
      expect(summary.from).toBe("2024-01-01");
      expect(summary.to).toBe("2024-12-31");
    });

    it("both bounds are INCLUSIVE — a dividend exactly ON `from` and ON `to` is in the answer", async () => {
      // Row 1 is the fixture's only 2019-01-15 payment, so a one-day window on
      // that date puts the same row on **both** bounds at once: a `>` on the
      // lower bound or a `<` on the upper one empties this response entirely,
      // and neither could be caught by a window with slack at either end.
      const summary = wire(
        await summarizeDividends(appWebDb, {
          tenantId: tenantA,
          from: "2019-01-15",
          to: "2019-01-15",
        }),
      );

      expect(summary.total).toEqual({ grossBase: "10", withholdingBase: "0" });
      expect(summary.instruments).toEqual([
        {
          instrumentId: instrumentX,
          displayName: "Air Liquide",
          symbol: null,
          hasIcon: false,
          grossBase: "10",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
      expect(summary.years).toEqual([{ period: "2019", grossBase: "10", withholdingBase: "0" }]);
      expect(summary.months).toEqual([
        { period: "2019-01", grossBase: "10", withholdingBase: "0" },
      ]);
    });
  });

  describe("AC-288 — the portfolio filter narrows, it does not relabel (LD-5)", () => {
    it("gives P1 strictly less than the combined figure, and P2 X alone", async () => {
      const combined = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));
      const p1 = wire(
        await summarizeDividends(appWebDb, { tenantId: tenantA, portfolioId: portfolioP1 }),
      );

      // X in P1 = 10,00 + 15,50 + 7,25 + 4,50 = 37,25, i.e. strictly less than
      // the combined 40,25 — asserted as an inequality, not merely a different
      // string, so a filter that returned some other subset still fails.
      expect(instrumentRow(p1, instrumentX).grossBase).toBe("37.25");
      expect(
        new Decimal(instrumentRow(p1, instrumentX).grossBase).lessThan(
          new Decimal(instrumentRow(combined, instrumentX).grossBase),
        ),
      ).toBe(true);
      expect(p1.total.grossBase).toBe("189.59"); // 37,25 + 92,34 + 60,00
      expect(p1.portfolioId).toBe(portfolioP1);

      const p2 = wire(
        await summarizeDividends(appWebDb, { tenantId: tenantA, portfolioId: portfolioP2 }),
      );
      expect(p2.instruments).toEqual([
        {
          instrumentId: instrumentX,
          displayName: "Air Liquide",
          symbol: null,
          hasIcon: false,
          grossBase: "3",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });

    it("returns the empty shape for a portfolio id this tenant does not own (invisible, not forbidden)", async () => {
      const foreign = wire(
        await summarizeDividends(appWebDb, { tenantId: tenantA, portfolioId: randomUUID() }),
      );
      expect(foreign.instruments).toEqual([]);
      expect(foreign.total).toEqual({ grossBase: "0", withholdingBase: "0" });
      expect(foreign.baseCurrency).toBe("EUR");
    });
  });

  describe("AC-289 — bucket COUNTS, so a silent merge cannot pass on values alone", () => {
    it("has exactly three years and four months, with 2021-2023 and 2019-02 absent", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));

      // Length first, separately from the values: a bucket folded into its
      // neighbour keeps every remaining value plausible but changes the count.
      expect(summary.years).toHaveLength(3);
      expect(summary.months).toHaveLength(4);

      const yearPeriods = summary.years.map((row) => row.period);
      expect(yearPeriods).toEqual(["2019", "2020", "2024"]);
      for (const missing of ["2021", "2022", "2023"]) {
        expect(yearPeriods).not.toContain(missing);
      }
      const monthPeriods = summary.months.map((row) => row.period);
      expect(monthPeriods).toEqual(["2019-01", "2019-03", "2020-02", "2024-06"]);
      expect(monthPeriods).not.toContain("2019-02");

      // …and only then the values.
      expect(summary.years).toEqual([
        { period: "2019", grossBase: "25.5", withholdingBase: "0" }, // 10,00 + 15,50
        { period: "2020", grossBase: "7.25", withholdingBase: "0" },
        { period: "2024", grossBase: "159.84", withholdingBase: "13.851" },
      ]);
      expect(summary.months).toEqual([
        { period: "2019-01", grossBase: "10", withholdingBase: "0" },
        { period: "2019-03", grossBase: "15.5", withholdingBase: "0" },
        { period: "2020-02", grossBase: "7.25", withholdingBase: "0" },
        { period: "2024-06", grossBase: "159.84", withholdingBase: "13.851" },
      ]);
    });
  });

  describe("the response shape, field for field, and no `calcEpoch`", () => {
    it("carries exactly the eight documented keys and no calcEpoch", async () => {
      const summary = await summarizeDividends(appWebDb, { tenantId: tenantA });

      // A **positive** assertion, not an absence left unstated: DV10's whole
      // point is that a later reader must not add one reflexively.
      // `transaction_posting` is a write-time projection, so there is no
      // staleness window for an epoch to describe — and a `calcEpoch` here
      // would be matched by the client's `isCalcEpochBearing`, spending that
      // retry budget verifying nothing.
      expect("calcEpoch" in summary).toBe(false);
      expect(Object.keys(summary).sort()).toEqual([
        "baseCurrency",
        "from",
        "instruments",
        "months",
        "portfolioId",
        "to",
        "total",
        "years",
      ]);
    });
  });

  describe("`t.kind = 'DIVIDEND'` is load-bearing for the withholding half", () => {
    it("never absorbs a BUY's own trade tax into a dividend's withholding", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));

      // The fixture holds a BUY on X, in 2024-06, whose 5,00 `tax` component is
      // a `TAX` posting on a CASH leg — the exact shape the `kind` predicate
      // exists to keep out. Drop that predicate and this figure becomes "5"
      // (or, with DV11's guard still in place, the whole request is refused
      // because the BUY carries a `fee_amount`); both are red, neither is "0".
      expect(instrumentRow(summary, instrumentX).withholdingBase).toBe("0");
      expect(summary.total.withholdingBase).toBe("13.851");
      expect(summary.months.find((row) => row.period === "2024-06")?.withholdingBase).toBe(
        "13.851",
      );
    });
  });

  describe("FR-270 — the four-way fold agreement, at full Decimal precision", () => {
    it("total = Sigma instruments = Sigma years = Sigma months, for both figures", async () => {
      const summary = await summarizeDividends(appWebDb, { tenantId: tenantA });

      // `DividendTotals` is the shape both `instruments[]` and the two period
      // arrays share, so one fold covers all three.
      const sum = (rows: readonly DividendTotals[]): { gross: Decimal; withholding: Decimal } =>
        rows.reduce(
          (accumulated, row) => ({
            gross: accumulated.gross.plus(row.grossBase),
            withholding: accumulated.withholding.plus(row.withholdingBase),
          }),
          { gross: new Decimal(0), withholding: new Decimal(0) },
        );

      const overInstruments = sum(summary.instruments);
      const overYears = sum(summary.years);
      const overMonths = sum(summary.months);

      for (const folded of [overInstruments, overYears, overMonths]) {
        expect(folded.gross.equals(summary.total.grossBase)).toBe(true);
        expect(folded.withholding.equals(summary.total.withholdingBase)).toBe(true);
      }
      // And the hand-computed value they all have to be.
      expect(summary.total.grossBase.toFixed()).toBe("192.59");
      expect(summary.total.withholdingBase.toFixed()).toBe("13.851");
    });
  });

  describe("Cross-tenant isolation (AC33/AC35, the RLS pattern)", () => {
    it("never shows tenant B's dividend to tenant A, and vice versa", async () => {
      const asA = wire(await summarizeDividends(appWebDb, { tenantId: tenantA }));
      expect(asA.instruments.map((row) => row.instrumentId)).not.toContain(instrumentOther);
      expect(asA.instruments).toHaveLength(3);
      expect(asA.total.grossBase).toBe("192.59"); // unchanged by tenant B's 11,00

      const asB = wire(await summarizeDividends(appWebDb, { tenantId: tenantB }));
      expect(asB.instruments).toEqual([
        {
          instrumentId: instrumentOther,
          displayName: "Société Générale",
          symbol: null,
          hasIcon: false,
          grossBase: "11",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });
  });

  describe("the empty shape, and baseCurrency in both empty cases", () => {
    it("gives a tenant with no transactions at all the zero shape, still labelled EUR", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantEmpty }));
      expect(summary).toEqual({
        baseCurrency: "EUR",
        from: null,
        to: null,
        portfolioId: null,
        total: { grossBase: "0", withholdingBase: "0" },
        instruments: [],
        years: [],
        months: [],
      });
      // The assertion that catches a `min(base_currency)`-over-nothing
      // implementation, which would answer `null` here.
      expect(summary.baseCurrency).not.toBeNull();
      expect(summary.baseCurrency).toBe("EUR");
    });

    it("gives an empty WINDOW on a tenant that does have dividends the same shape", async () => {
      const summary = wire(
        await summarizeDividends(appWebDb, {
          tenantId: tenantA,
          from: "2025-01-01",
          to: "2025-12-31",
        }),
      );
      expect(summary).toEqual({
        baseCurrency: "EUR",
        from: "2025-01-01",
        to: "2025-12-31",
        portfolioId: null,
        total: { grossBase: "0", withholdingBase: "0" },
        instruments: [],
        years: [],
        months: [],
      });
      expect(summary.baseCurrency).toBe("EUR");
    });
  });

  describe("DV6 — the instrument cap refuses, never truncates", () => {
    it("throws TooManyDividendInstrumentsError past the test-only override", async () => {
      await expect(
        summarizeDividends(appWebDb, {
          tenantId: tenantA,
          responseCapOverrides: { maxInstruments: 2 },
        }),
      ).rejects.toBeInstanceOf(TooManyDividendInstrumentsError);
      await expect(
        summarizeDividends(appWebDb, {
          tenantId: tenantA,
          responseCapOverrides: { maxInstruments: 2 },
        }),
      ).rejects.toMatchObject({ count: 3, limit: 2 });
    });

    it("boundary — exactly the limit is served, so the refusal is `>` and not `>=`", async () => {
      // Tenant A has exactly three dividend-paying instruments, so an override
      // of 3 is the cap itself rather than a value under it. The pair above
      // brackets the boundary from the far side (4 > 3 refuses); this is the
      // assertion an off-by-one `>=` fails, and it is the shape the real
      // 1,000-instrument cap can never be tested at directly.
      const summary = wire(
        await summarizeDividends(appWebDb, {
          tenantId: tenantA,
          responseCapOverrides: { maxInstruments: 3 },
        }),
      );

      expect(summary.instruments).toHaveLength(3);
      expect(summary.total.grossBase).toBe("192.59");
    });

    it("positive companion — one instrument under the same override succeeds normally", async () => {
      const summary = wire(
        await summarizeDividends(appWebDb, {
          tenantId: tenantA,
          portfolioId: portfolioP2,
          responseCapOverrides: { maxInstruments: 1 },
        }),
      );
      expect(summary.instruments).toHaveLength(1);
      expect(summary.instruments[0]?.grossBase).toBe("3");
    });
  });

  /**
   * **Security review LOW-1 — the refusal precedes the materialisation
   * it exists to prevent.**
   *
   * The cap used to be checked on `byInstrument.size`, so a scope it was about
   * to refuse was first pulled across the wire in full and folded into three
   * `Map`s: it bounded what Fastify serialises and nothing else. Neither
   * existing fixture could catch that — DV6's above is three instruments in one
   * month, and AC-291's below is *one* instrument across 197 months, so in both
   * the grouped result set is small exactly where it needs to be large.
   *
   * This fixture is therefore deliberately a **product**: `GUARD_INSTRUMENTS` x
   * `GUARD_MONTHS` = 1,200 grouped rows behind a refusal that fires at an
   * override of `GUARD_CAP`.
   *
   * And the proof is **measured, not read**: statements are counted on the wire
   * through postgres.js's own `debug` hook, on a dedicated connection so
   * nothing the fixture does is ever attributed to the measured call — the
   * pattern `cash-account-balances-statement-count.integration.test.ts` and
   * `holdings-query-statement-count.integration.test.ts` established for
   * exactly this class of claim. Reading the service and asserting "the guard
   * runs first" is the self-report this project has a recorded history of.
   *
   * The third test is the discrimination proof: the identical call under a
   * permissive cap *does* issue the aggregate, over the whole 1,200-row
   * product. Without it, the "no `group by` went on the wire" assertion would
   * also pass if the probe had stopped seeing statements, or if the fixture had
   * stopped producing rows.
   */
  describe("the instrument cap refuses before the aggregate is materialised", () => {
    const tenantGuard = "00000000-0000-7000-8000-000002650011";
    /** Wide enough that a `LIMIT`-free fold would have built 1,200 rows; small enough to seed in one batched insert. */
    const GUARD_INSTRUMENTS = 24;
    /** Consecutive months, all of them shared by all instruments — so `|grouped rows| = GUARD_INSTRUMENTS x GUARD_MONTHS` exactly, and `months` has exactly this length. */
    const GUARD_MONTHS = 50;
    /** The refusal's override. Far under `GUARD_INSTRUMENTS`, so the refusal is unambiguous rather than a boundary case — the boundary itself is bracketed by the DV6 tests above and re-proved at 24 by the third test here. */
    const GUARD_CAP = 8;
    /** `GUARD_INSTRUMENTS x GUARD_MONTHS x 1,00 EUR`, as a closed form re-derivable from the generator's inputs rather than copied from output. */
    const GUARD_EXPECTED_GROSS = "1200";

    let portfolioGuard: string;
    /** A second, dedicated connection whose statements are recorded — the fixture's own inserts must never land in the measured window. */
    let countedSql: postgres.Sql;
    let countedDb: Db;
    let statements: string[] = [];

    /**
     * The 15th of the `m`-th month from 2015-01. Calendar arithmetic on a plain
     * `date`, matching {@link addDays}'s own reason for existing: no timezone
     * can enter, and 50 consecutive months make `months` a known length.
     */
    function guardTradeDate(m: number): string {
      const year = 2015 + Math.floor(m / 12);
      const month = (m % 12) + 1;
      return `${year}-${String(month).padStart(2, "0")}-15`;
    }

    /**
     * `body` (11 characters) plus its ISO 6166 check digit. This file's other
     * synthetic ISINs are hardcoded with hand-computed digits (IR-22), which
     * does not scale to `GUARD_INSTRUMENTS` of them; `core/api-contracts`'
     * `isValidIsinCheckDigit` is not reachable from `ledger` (it is not a
     * dependency of this workspace, and adding one for a fixture would be a
     * dependency edge added by a test). The helper is proved rather than
     * trusted: the first assertion below re-derives the check digit of the
     * ISINs already in this file and of two real ones.
     */
    function isinWithCheckDigit(body: string): string {
      const expanded = [...body]
        .map((character) =>
          /[0-9]/.test(character) ? character : String(character.charCodeAt(0) - 55),
        )
        .join("");
      let sum = 0;
      let doubling = true;
      for (let index = expanded.length - 1; index >= 0; index--) {
        let digit = Number(expanded[index]);
        if (doubling) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        doubling = !doubling;
        sum += digit;
      }
      return `${body}${(10 - (sum % 10)) % 10}`;
    }

    beforeAll(async () => {
      await ownerDb.insert(tenant).values({ id: tenantGuard });
      portfolioGuard = (
        await createPortfolio(appWebDb, { tenantId: tenantGuard, name: "DS-2 cap" })
      ).id;
      await seedCashAccounts(ownerDb, tenantGuard, portfolioGuard);

      const instrumentIds: string[] = [];
      for (let n = 0; n < GUARD_INSTRUMENTS; n++) {
        instrumentIds.push(
          (
            await createInstrumentByIsin(appWebDb, {
              kind: "SHARE",
              isin: isinWithCheckDigit(`FRTEST394${String(n).padStart(2, "0")}`),
              exchangeMic: "XPAR",
              listingCurrency: "EUR",
              displayName: `DS-2 cap instrument ${String(n).padStart(2, "0")}`,
            })
          ).id,
        );
      }

      // AC-291's bulk pattern — real `expandPostings` over hand-built
      // `transaction` rows, batched inserts, one `recomputeAndInvalidate` —
      // rather than 1,200 service calls.
      const cashAccountId = cash(portfolioGuard, "EUR");
      const rows: Array<typeof transaction.$inferInsert> = [];
      const postings: Array<typeof transactionPosting.$inferInsert> = [];
      let seq = 0;
      for (const instrumentId of instrumentIds) {
        for (let m = 0; m < GUARD_MONTHS; m++) {
          seq += 1;
          const row: typeof transaction.$inferInsert = {
            id: randomUUID(),
            tenantId: tenantGuard,
            baseCurrency: "EUR",
            portfolioId: portfolioGuard,
            kind: "DIVIDEND",
            tradeDate: guardTradeDate(m),
            tradeTs: null,
            seq: BigInt(seq),
            instrumentId,
            quantity: null,
            unitPrice: null,
            grossAmount: new Decimal(1),
            txnCurrency: "EUR",
            cashCurrency: "EUR",
            cashAmount: new Decimal(1),
            cashAccountId,
            targetCashAccountId: null,
            txnSettlementInstrumentId: null,
            targetCurrency: null,
            targetAmount: null,
            feeAmount: null,
            withholdingAmount: null,
            sourceDividendId: null,
            fxRate: new Decimal(1),
            fxRateSource: "IMPLIED_BASE",
          };
          rows.push(row);
          postings.push(...postingRowsFor(row));
        }
      }

      await withTenant(appWebDb, tenantGuard, async (tx) => {
        await lockPortfolioRow(tx, tenantGuard, portfolioGuard);
        for (const batch of chunk(rows, 500)) {
          await tx.insert(transaction).values(batch);
        }
        for (const batch of chunk(postings, 500)) {
          await tx.insert(transactionPosting).values(batch);
        }
        await recomputeAndInvalidate(tx, {
          tenantId: tenantGuard,
          portfolioId: portfolioGuard,
          minTradeDate: guardTradeDate(0),
        });
      });

      countedSql = postgres(pg.appWebUri, {
        max: 1,
        debug: (_connection, query) => {
          statements.push(query);
        },
      });
      countedDb = createDb(countedSql);
    }, 300_000);

    afterAll(async () => {
      await countedSql?.end({ timeout: 5 });
    }, 30_000);

    it("refuses the over-cap scope WITHOUT putting the aggregate on the wire", async () => {
      // Warm the pooled connection so no lazily-issued setup traffic lands
      // inside the measured window.
      await countedSql`select 1 as warm`;
      statements = [];

      const thrown: unknown = await summarizeDividends(countedDb, {
        tenantId: tenantGuard,
        responseCapOverrides: { maxInstruments: GUARD_CAP },
      }).catch((error: unknown) => error);
      const measured = [...statements];

      expect(thrown).toBeInstanceOf(TooManyDividendInstrumentsError);
      expect(thrown).toMatchObject({ count: GUARD_INSTRUMENTS, limit: GUARD_CAP });

      // The aggregate is the only statement this service issues that groups
      // and buckets. It never went on the wire, so its 1,200 rows were never
      // materialised, never decoded and never folded.
      expect(measured.filter((statement) => /group by/i.test(statement))).toEqual([]);
      expect(measured.filter((statement) => /to_char/i.test(statement))).toEqual([]);

      // …and the breakdown, so that assertion cannot pass because the call
      // failed before it reached the database at all: exactly two data
      // statements ran, the tenant's base-currency lookup and the guard, and
      // the second is the guard by its own text.
      const dataStatements = measured.filter(
        (statement) =>
          !/^\s*(begin|commit|rollback)\b/i.test(statement) && !/set_config/i.test(statement),
      );
      expect(dataStatements).toHaveLength(2);
      expect(dataStatements[1]).toMatch(/count\(distinct t\.instrument_id\)/i);
    });

    it("discrimination — the identical scope under a cap of exactly 24 DOES issue the aggregate, over the whole 1,200-row product", async () => {
      await countedSql`select 1 as warm`;
      statements = [];

      const summary = await summarizeDividends(countedDb, {
        tenantId: tenantGuard,
        responseCapOverrides: { maxInstruments: GUARD_INSTRUMENTS },
      });
      const measured = [...statements];

      expect(measured.filter((statement) => /group by/i.test(statement))).toHaveLength(1);

      // The fixture really is the product the previous test claims was never
      // materialised — every instrument pays in every one of the 50 months, so
      // the aggregate returned 1,200 grouped rows — and exactly-at-cap is still
      // served, now at 24 rather than at 3.
      expect(summary.instruments).toHaveLength(GUARD_INSTRUMENTS);
      expect(summary.months).toHaveLength(GUARD_MONTHS);
      expect(summary.total.grossBase.toFixed()).toBe(GUARD_EXPECTED_GROSS);
    });
  });

  /**
   * AC-291 — completeness past the client-side scan cap this endpoint exists to
   * beat. `income-totals.ts` pages `GET /transactions` at
   * `INCOME_TOTALS_PAGE_LIMIT` (100) for at most `INCOME_TOTALS_MAX_PAGES` (50)
   * pages, i.e. 5,000 rows, and reports `truncated` beyond that. A fixture at or
   * under 5,000 rows would prove nothing about independence from that cap, so
   * this one is deliberately larger.
   *
   * Built with `load/src/seed-fixture.ts`'s bulk pattern — real
   * {@link expandPostings} over hand-built `transaction` rows, batched inserts,
   * one {@link recomputeAndInvalidate} — rather than 6,000 service calls.
   */
  describe("AC-291 — 6,000 dividends, one call, an exact hand-computed total", () => {
    const BULK_DIVIDEND_ROWS = 6_000;
    /** `INCOME_TOTALS_MAX_PAGES` (50) x `INCOME_TOTALS_PAGE_LIMIT` (100), mirrored by value: `ledger` must not import `web`. */
    const CLIENT_SCAN_CAP_ROWS = 5_000;
    /**
     * Row `i` pays `((i mod 100) + 1)` cents, so each of 1..100 cents occurs
     * exactly 60 times: `60 x (1 + 2 + ... + 100) / 100 = 60 x 50,50 = 3030`.
     * Stated as a closed form so it can be re-derived from the generator's
     * inputs rather than copied from this file's output.
     */
    const BULK_EXPECTED_GROSS = "3030";

    beforeAll(async () => {
      const cashAccountId = cash(portfolioBulk, "EUR");
      const rows: Array<typeof transaction.$inferInsert> = [];
      const postings: Array<typeof transactionPosting.$inferInsert> = [];

      for (let i = 0; i < BULK_DIVIDEND_ROWS; i++) {
        const amount = new Decimal((i % 100) + 1).dividedBy(100);
        const row: typeof transaction.$inferInsert = {
          id: randomUUID(),
          tenantId: tenantBulk,
          baseCurrency: "EUR",
          portfolioId: portfolioBulk,
          kind: "DIVIDEND",
          tradeDate: addDays("2010-01-01", i),
          tradeTs: null,
          seq: BigInt(i + 1),
          instrumentId: instrumentBulk,
          quantity: null,
          unitPrice: null,
          grossAmount: amount,
          txnCurrency: "EUR",
          cashCurrency: "EUR",
          cashAmount: amount,
          cashAccountId,
          targetCashAccountId: null,
          txnSettlementInstrumentId: null,
          targetCurrency: null,
          targetAmount: null,
          feeAmount: null,
          withholdingAmount: null,
          sourceDividendId: null,
          fxRate: new Decimal(1),
          fxRateSource: "IMPLIED_BASE",
        };
        rows.push(row);
        postings.push(...postingRowsFor(row));
      }

      await withTenant(appWebDb, tenantBulk, async (tx) => {
        // Rung 2 of `portfolio-lock.ts`'s global lock order before the bulk
        // inserts (which take rung 4 through the cash-account RI checks) —
        // `seed-fixture.ts`'s own recorded ordering fix.
        await lockPortfolioRow(tx, tenantBulk, portfolioBulk);
        for (const batch of chunk(rows, 500)) {
          await tx.insert(transaction).values(batch);
        }
        for (const batch of chunk(postings, 500)) {
          await tx.insert(transactionPosting).values(batch);
        }
        await recomputeAndInvalidate(tx, {
          tenantId: tenantBulk,
          portfolioId: portfolioBulk,
          minTradeDate: "2010-01-01",
        });
      });
    }, 300_000);

    it("returns the complete total in one call, past the 5,000-row client scan cap", async () => {
      expect(BULK_DIVIDEND_ROWS).toBeGreaterThan(CLIENT_SCAN_CAP_ROWS);

      const summary = await summarizeDividends(appWebDb, { tenantId: tenantBulk });

      expect(summary.instruments).toHaveLength(1);
      expect(summary.instruments[0]?.paymentCount).toBe(BULK_DIVIDEND_ROWS);
      expect(summary.instruments[0]?.grossBase.toFixed()).toBe(BULK_EXPECTED_GROSS);
      expect(summary.total.grossBase.toFixed()).toBe(BULK_EXPECTED_GROSS);
      expect(summary.total.withholdingBase.toFixed()).toBe("0");

      // The buckets are complete too — no truncation hiding in either fold.
      const foldedYears = summary.years.reduce(
        (accumulated, row) => accumulated.plus(row.grossBase),
        new Decimal(0),
      );
      const foldedMonths = summary.months.reduce(
        (accumulated, row) => accumulated.plus(row.grossBase),
        new Decimal(0),
      );
      expect(foldedYears.toFixed()).toBe(BULK_EXPECTED_GROSS);
      expect(foldedMonths.toFixed()).toBe(BULK_EXPECTED_GROSS);
    }, 60_000);
  });

  /**
   * **The mixed-currency shape: the withholding denominated in a
   * *different* currency from the gross.**
   *
   * Since `0079` a withholding is denominated by the settling account, so the
   * shape is a US dividend (USD gross) paid into the EUR account with the
   * withholding in EUR — the PP reference case. The worked fixture cannot
   * cover this: Y's gross and withholding are both USD, so an implementation
   * that only counted a withholding whose currency matched its transaction's
   * `txn_currency` would pass every other test in this file. Here the two
   * differ by construction — asserted on the stored row, not assumed — and
   * both figures are still aggregated.
   */
  describe("a withholding in a different currency from the gross", () => {
    const tenantMixed = "00000000-0000-7000-8000-000002650010";
    let instrumentMixed: string;
    let portfolioMixed: string;

    beforeAll(async () => {
      await ownerDb.insert(tenant).values({ id: tenantMixed });
      instrumentMixed = (
        await createInstrumentByIsin(appWebDb, {
          kind: "SHARE",
          isin: "USTEST008019",
          exchangeMic: "XNAS",
          listingCurrency: "USD",
          displayName: "Johnson & Johnson",
        })
      ).id;
      portfolioMixed = (
        await createPortfolio(appWebDb, { tenantId: tenantMixed, name: "DS-2b mixed" })
      ).id;
      await seedCashAccounts(ownerDb, tenantMixed, portfolioMixed);

      // 200,00 USD gross at a pinned 0,9, paid into the EUR (base) account so
      // the credited 180,00 EUR is derived (L11) => 180,00 base; 12,00 EUR
      // withheld from that account at the principal's implied rate 1 => 12,00
      // base. Two different currencies — one transaction, one account.
      await serviceFor(tenantMixed).recordDividend({
        portfolioId: portfolioMixed,
        instrumentId: instrumentMixed,
        tradeDate: "2024-06-10",
        amount: new Decimal("200.00"),
        currency: "USD",
        cashAccountId: cash(portfolioMixed, "EUR"),
        cashCurrency: "EUR",
        fxRateUserInput: new Decimal("0.900000000000"),
        withholding: { amount: new Decimal("12.00") },
      });
    }, 60_000);

    it("stores the gross and the withholding in genuinely different currencies — not two USD figures", async () => {
      const [row] = await ownerDb
        .select({
          txnCurrency: transaction.txnCurrency,
          cashCurrency: transaction.cashCurrency,
          withholdingAmount: transaction.withholdingAmount,
        })
        .from(transaction)
        .where(eq(transaction.tenantId, tenantMixed));

      // The withholding is denominated by the settling account.
      expect(row?.txnCurrency).toBe("USD");
      expect(row?.cashCurrency).toBe("EUR");
      expect(row?.withholdingAmount?.toString()).toBe("12");
    });

    it("aggregates BOTH stored figures — 200,00 x 0,9 = 180 gross and the 12,00 EUR withholding", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantMixed }));

      expect(summary.instruments).toEqual([
        {
          instrumentId: instrumentMixed,
          displayName: "Johnson & Johnson",
          symbol: null,
          hasIcon: false,
          grossBase: "180",
          withholdingBase: "12",
          paymentCount: 1,
        },
      ]);
      // Neither figure is dropped and neither is netted: 180 − 12 = 168 is not
      // an answer this response ever gives (LD-1).
      expect(summary.total).toEqual({ grossBase: "180", withholdingBase: "12" });
      // The netting check reads the response's FIGURES, not its serialisation.
      // `JSON.stringify(summary)` also covers `instrumentId`, and a randomly
      // generated UUID that happens to contain the needle fails this assertion
      // while every figure is correct — which is what CI hit on 2026-09-07
      // (`bd566376-bd04-429e-9726-0c1168dcef2e`, and "168" is in
      // `…0c1168dcef2e`). A short numeric needle over a whole serialised body
      // cannot tell a wrong figure from a coincidental identifier.
      expect(everyFigure(summary)).not.toContain("168");
      // Stronger than the absence of one arithmetic slip: the response's whole
      // figure set is the two stored ones, so no third number is reported at
      // all — netted, rounded or otherwise.
      expect([...new Set(everyFigure(summary))].sort()).toEqual(["12", "180"]);
      expect(summary.months).toEqual([
        { period: "2024-06", grossBase: "180", withholdingBase: "12" },
      ]);
    });
  });

  /**
   * AR-5 (ADR-0002) — the base-currency provenance guard.
   *
   * `trg_transaction_posting_base_currency_fill` is `BEFORE INSERT` only, so a
   * relabelling `UPDATE` (an `app_owner` maintenance session, a repair script)
   * is exactly the shape that reaches this guard and nothing else catches. The
   * pair is on one tenant: the same single dividend is read once correctly
   * labelled and once relabelled, and only the second is refused — a number in
   * an unknown unit is the one answer AR-5 forbids.
   */
  describe("AR-5 — a posting relabelled out of band is refused, not reported", () => {
    it("positive companion — the correctly-labelled row summarises normally", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantMislabelled }));
      expect(summary.baseCurrency).toBe("EUR");
      expect(summary.instruments).toEqual([
        {
          instrumentId: instrumentMislabelled,
          displayName: "Danone",
          symbol: null,
          hasIcon: false,
          grossBase: "20",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });

    it("throws DividendBaseCurrencyMismatchError once the posting disagrees with tenant.base_currency", async () => {
      await ownerDb
        .update(transactionPosting)
        .set({ baseCurrency: "USD" })
        .where(eq(transactionPosting.tenantId, tenantMislabelled));

      await expect(
        summarizeDividends(appWebDb, { tenantId: tenantMislabelled }),
      ).rejects.toBeInstanceOf(DividendBaseCurrencyMismatchError);
      await expect(
        summarizeDividends(appWebDb, { tenantId: tenantMislabelled }),
      ).rejects.toMatchObject({ expected: "EUR", found: "USD" });
    });
  });

  /**
   * DV11 — the ambiguous-TAX-leg refusal, proved as a pair on **one**
   * row: the identical fixture is read once without a `fee_amount` and once
   * with, and only the second is refused. The costed shape is written through
   * `ownerDb` because no API path produces it (`transaction-create.schema.ts`'s
   * `forbid(data.fee, …)` and `TransactionCashLegNotAddableError` between them
   * make it unreachable) and no CHECK forbids it.
   */
  describe("DV11 — a DIVIDEND carrying a fee_amount refuses the whole request", () => {
    let costedTransactionId: string;

    beforeAll(async () => {
      const row: typeof transaction.$inferInsert = {
        id: randomUUID(),
        tenantId: tenantCosted,
        baseCurrency: "EUR",
        portfolioId: portfolioCosted,
        kind: "DIVIDEND",
        tradeDate: "2024-06-10",
        tradeTs: null,
        seq: 1n,
        instrumentId: instrumentCosted,
        quantity: null,
        unitPrice: null,
        grossAmount: new Decimal("40.00"),
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: new Decimal("40.00"),
        cashAccountId: cash(portfolioCosted, "EUR"),
        targetCashAccountId: null,
        txnSettlementInstrumentId: null,
        targetCurrency: null,
        targetAmount: null,
        feeAmount: null,
        withholdingAmount: null,
        sourceDividendId: null,
        fxRate: new Decimal(1),
        fxRateSource: "IMPLIED_BASE",
      };
      costedTransactionId = row.id;
      await ownerDb.insert(transaction).values(row);
      await ownerDb.insert(transactionPosting).values(postingRowsFor(row));
    }, 60_000);

    it("positive companion — the identical row WITHOUT the fee_amount summarises normally", async () => {
      const summary = wire(await summarizeDividends(appWebDb, { tenantId: tenantCosted }));
      expect(summary.instruments).toEqual([
        {
          instrumentId: instrumentCosted,
          displayName: "Orange",
          symbol: null,
          hasIcon: false,
          grossBase: "40",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });

    it("refuses with AmbiguousDividendTaxLegError once the same row carries a costed TAX leg", async () => {
      // `fee_amount` = 2,00 itemised entirely as `tax_amount`
      // (`transaction_cost_components_sum_to_fee_amount` requires the total).
      // The expander then emits a second `TAX` posting of −2,00 alongside the
      // INCOME leg — indistinguishable, in the aggregate, from withholding.
      //
      // **The constraint is dropped for the write and put back
      // (migration `0059`).** `transaction_dividend_shape` now forbids
      // `fee_amount` on a DIVIDEND, so this row shape is reachable in exactly
      // two ways: as a **legacy row** written before `0059` (which is why the
      // constraint is `NOT VALID` — it does not invalidate one), or by an
      // out-of-band writer with the privilege to drop a constraint. This
      // fixture is the second, standing in for the first, and that is the whole
      // scenario DV11's guard exists for: **the CHECK stops new rows, and the
      // read-time 422 is what answers a row that is already there.**
      //
      // Restored immediately after the write rather than in an `afterAll`, so
      // no later case in this file runs against a schema this one weakened.
      await ownerDb.execute(
        sql`ALTER TABLE "transaction" DROP CONSTRAINT "transaction_dividend_shape"`,
      );
      try {
        await ownerDb
          .update(transaction)
          .set({ feeAmount: new Decimal("2.00"), taxAmount: new Decimal("2.00") })
          .where(eq(transaction.id, costedTransactionId));
      } finally {
        await ownerDb.execute(
          sql`ALTER TABLE "transaction" ADD CONSTRAINT "transaction_dividend_shape" CHECK ("transaction"."kind" <> 'DIVIDEND' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."fee_amount" IS NULL
      )) NOT VALID`,
        );
      }
      // And the constraint really is back, so the restore is asserted rather
      // than assumed — a silently-dropped CHECK would make every later case in
      // this file weaker than it reads.
      const [live] = await ownerDb.execute<{ convalidated: boolean }>(
        sql`SELECT convalidated FROM pg_constraint WHERE conname = 'transaction_dividend_shape'`,
      );
      expect(live).toBeDefined();
      const [updated] = await ownerDb
        .select()
        .from(transaction)
        .where(eq(transaction.id, costedTransactionId));
      if (updated === undefined) throw new Error("the costed fixture row vanished");
      await ownerDb
        .delete(transactionPosting)
        .where(eq(transactionPosting.transactionId, costedTransactionId));
      await ownerDb.insert(transactionPosting).values(postingRowsFor(updated));

      // Without the guard this would silently answer withholdingBase "2".
      const taxLegs = await ownerDb
        .select()
        .from(transactionPosting)
        .where(eq(transactionPosting.transactionId, costedTransactionId));
      expect(taxLegs.filter((leg) => leg.flowClass === "TAX")).toHaveLength(1);

      await expect(summarizeDividends(appWebDb, { tenantId: tenantCosted })).rejects.toBeInstanceOf(
        AmbiguousDividendTaxLegError,
      );
      await expect(summarizeDividends(appWebDb, { tenantId: tenantCosted })).rejects.toMatchObject({
        instrumentId: instrumentCosted,
      });
    });
  });
});

/** {@link DividendInstrumentSummary} with its two decimals rendered the way `serializeDecimal` will render them on the wire (A7). */
interface WireInstrument {
  instrumentId: string;
  displayName: string;
  symbol: string | null;
  hasIcon: boolean;
  grossBase: string;
  withholdingBase: string;
  paymentCount: number;
}

/** {@link DividendPeriodSummary}, same rendering. */
interface WirePeriod {
  period: string;
  grossBase: string;
  withholdingBase: string;
}

/** {@link DividendSummary}, same rendering — what every expectation in this file is written against. */
interface WireSummary {
  baseCurrency: string;
  from: string | null;
  to: string | null;
  portfolioId: string | null;
  total: { grossBase: string; withholdingBase: string };
  instruments: WireInstrument[];
  years: WirePeriod[];
  months: WirePeriod[];
}

/** `seed-fixture.ts`'s own `toExpandable`, local to this file: `load` is not a `ledger` dependency and this is a fixture concern, not a shared one. */
function toExpandable(row: typeof transaction.$inferInsert): ExpandableTransaction {
  return {
    kind: row.kind,
    instrumentId: row.instrumentId ?? null,
    quantity: row.quantity ?? null,
    grossAmount: row.grossAmount,
    txnCurrency: row.txnCurrency ?? null,
    txnSettlementInstrumentId: row.txnSettlementInstrumentId ?? null,
    targetCurrency: row.targetCurrency ?? null,
    targetAmount: row.targetAmount ?? null,
    cashAccountId: row.cashAccountId ?? null,
    targetCashAccountId: row.targetCashAccountId ?? null,
    cashCurrency: row.cashCurrency ?? null,
    cashAmount: row.cashAmount ?? null,
    brokerFeeAmount: row.brokerFeeAmount ?? null,
    fxFeeAmount: row.fxFeeAmount ?? null,
    taxAmount: row.taxAmount ?? null,
    otherCostAmount: row.otherCostAmount ?? null,
    feeAmount: row.feeAmount ?? null,
    withholdingAmount: row.withholdingAmount ?? null,
    fxRate: row.fxRate,
    fxRateSource: row.fxRateSource,
  };
}

/** The **real** expander over a hand-built row — the postings are produced the way every production write produces them, never hand-written. */
function postingRowsFor(
  row: typeof transaction.$inferInsert,
): Array<typeof transactionPosting.$inferInsert> {
  return expandPostings(toExpandable(row), testMinorUnitOf).map((draft) => ({
    id: randomUUID(),
    tenantId: row.tenantId,
    baseCurrency: row.baseCurrency,
    transactionId: row.id,
    portfolioId: row.portfolioId,
    ...draft,
  }));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** `YYYY-MM-DD` + `days`, by UTC calendar arithmetic — no timezone can enter, matching the column's own `date` semantics. */
function addDays(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
