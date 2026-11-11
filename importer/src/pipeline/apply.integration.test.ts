import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin, type TransactionWriteService } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyDeadlineAt,
  applyImport,
  DEFAULT_IMPORT_LIMITS,
  planImport,
  systemClock,
  type Clock,
  type ImportPlan,
  type ImportResult,
  type NeutralCashMovementRow,
  type NeutralDividendRow,
  type NeutralTradeRow,
  type ParsedRow,
  type ParseResult,
} from "../index.js";
import {
  applyAssetCatalogue,
  applyWithGenerousDeadline,
  buildWriteService,
  parsedFixture,
  planContext,
  seedPortfolio,
  seedTenant,
  tally,
  type HarnessIds,
} from "./__tests__/apply-harness.js";

/**
 * CI-13 — `applyImport` against a real Postgres.
 *
 * ## The branch built, and the verdict that chose it
 *
 * GATE-1 (CI-1) recorded, verbatim:
 *
 * > *GATE-1 PASSED at 4838 ms / 2031 ms — `apply.ts` (CI-13) is built as
 * > the simple per-row loop, not the chunked-apply
 * > fallback.*
 *
 * The per-row loop is what this suite exercises. Nothing here calls a
 * batch writer, because none was built.
 *
 * ## What each count below is anchored to
 *
 * The fixture's own profile, reached through `plan` rather
 * than asserted about the file: `assets.csv` 27 rows, `investment.csv` 37,
 * `cash.csv` 52. Every expectation is an exact integer — "no errors" is not
 * an assertion this suite makes anywhere.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-0000000d1001",
  userId: "00000000-0000-7000-8000-0000000d1002",
  sessionId: "00000000-0000-7000-8000-0000000d1003",
  portfolioId: "00000000-0000-7000-8000-0000000d1004",
  cashAccountIds: ["00000000-0000-7000-8000-0000000d1005"],
};
const ACCOUNT = IDS.cashAccountIds[0]!;
const DESTINATION = { portfolioId: IDS.portfolioId, cashAccountId: ACCOUNT };

/** A second portfolio, so the deadline and over-sell suites cannot move the main portfolio's counts. */
const SIDE_PORTFOLIO = "00000000-0000-7000-8000-0000000d1006";
const SIDE_ACCOUNT = "00000000-0000-7000-8000-0000000d1007";
const SIDE_DESTINATION = { portfolioId: SIDE_PORTFOLIO, cashAccountId: SIDE_ACCOUNT };

/** This suite's own instrument, referenced by nothing the fixture contains — see {@link tradeRow}. */
const OVERSELL_ISIN = "FRTEST999996";

/** A second suite-owned instrument, so {@link nativeCurrencyTradeRow}'s position starts at zero regardless of test order. */
const FX_TRADE_ISIN = "FRTEST999995";

/** The recorded row totals. */
const ASSET_ROWS = 27;
const INVESTMENT_ROWS = 37;
const CASH_ROWS = 52;

/**
 * What `plan` decides for each file with **no discovery wired** (`discovery:
 * null`) — every otherwise-unresolved asset row reports rather than
 * guessing. Counted by hand from the committed fixture, then confirmed:
 *
 *  - assets: 12 created (the eleven rows whose ticker suffix names an exchange,
 *    plus Coca-Cola's `CCC3.DE` line) + 1 `INSTRUMENT_ALREADY_EXISTS`
 *    (`SU.PA`, which the shipped catalogue already carries) + 14
 *    `EXCHANGE_MIC_LOOKUP_UNAVAILABLE` (seven unsuffixed US tickers, two `.F`
 *    listings, four coins and the out-of-scope row) = 27
 *  - investment: 34 imported (30 trades + 4 cashless distributions) + 3
 *    `INSTRUMENT_NOT_RESOLVED` (the three `NESM.F` trades, whose listing the
 *    assets file could not resolve) = 37, **and nothing rejected**
 *  - cash: 18 imported (9 deposits, 1 withdrawal, 8 dividends) + 33
 *    `COVERED_BY_INVESTMENT_FILE` + 1 `ZERO_VALUE_DIVIDEND_MARKER` (the
 *    zero-amount income row) = 52, **and nothing rejected** — the
 *    zero-value-dividend rule moved that row from a REJECT to a named SKIP,
 *    because a zero-value income line is a corporate-action marker Portfolio
 *    Performance really emits and it parses and validates cleanly, which is
 *    the definition of a skip
 *
 * **Cashless-distribution support moved the investment file's numbers, and
 * only those.** Before it, the four `DISTRIBUTION` rows were refused as
 * `UNSUPPORTED_ROW_TYPE`, because `transaction` could not hold a cashless
 * event at all. `SHARE_DISTRIBUTION` (migration `0056`) can, so the file now
 * rejects nothing beyond the unresolvable listing — and the holdings it
 * produces are 56 shares larger, across the four instruments the
 * distributions name (asserted below, per instrument, rather than as one
 * total).
 */
const ASSETS_CREATED = 12;
const ASSETS_ALREADY_CATALOGUED = 1;
const ASSETS_UNAVAILABLE = 14;
/** The trade rows (`BUY`/`SELL`) that land — the population every cost assertion below is read against. */
const INVESTMENT_TRADES_IMPORTED = 30;
/** The four cashless-distribution rows, all of which resolve: their instruments are in the catalogue the assets file builds on. */
const INVESTMENT_DISTRIBUTIONS_IMPORTED = 4;
const INVESTMENT_IMPORTED = INVESTMENT_TRADES_IMPORTED + INVESTMENT_DISTRIBUTIONS_IMPORTED; // 34
const INVESTMENT_UNRESOLVED = 3;
const CASH_IMPORTED = 18;
const CASH_COVERED = 33;
/** The zero-value dividend line — a named SKIP since the marker reason was added, not a rejection. */
const CASH_ZERO_DIVIDEND_MARKER = 1;
const TOTAL_TRANSACTIONS = INVESTMENT_IMPORTED + CASH_IMPORTED; // 52

/**
 * The four cashless-distribution rows, as the fixture writes them: ISIN →
 * shares distributed. Asserted per instrument, because "56 more shares
 * somewhere" is not the claim — the claim is that *these four holdings* each
 * grew by exactly this count.
 */
const DISTRIBUTED_SHARES: readonly (readonly [isin: string, shares: string])[] = [
  ["FR0000051807", "2"], // TEP.PA, 2022-06-10
  ["NL0011794037", "3"], // AD.AS, 2023-04-05
  ["IT0000072618", "50"], // ISP.MI, 2023-11-20
  ["FR0000121972", "1"], // SU.PA, 2024-05-14 — the shipped catalogue's own row
];

/**
 * FT-42's cost profile of the **imported** subset of `investment.csv`'s trade
 * rows. Not the file-level counts: 3 of that file's 33 trades are
 * `INSTRUMENT_NOT_RESOLVED` and never reach the database, so these are counted
 * against what actually lands. Each is asserted beside its population so a
 * number that drifted cannot pass as a clean result.
 *
 * By hand, from the file: 33 trades, of which 4 carry no cost cell (two
 * purchases of 2021-09-09 and 2023-01-16 that land, the unresolved 2022-04-04
 * purchase, and the 2024-09-19 sale) and 4 carry a tax cell beside the fee cell (the
 * three Teleperformance/Schneider purchases of 2021-02-03, 2022-01-18,
 * 2022-10-12 and the 2023-02-27 one). Of the 3 unresolved trades, 2 carry a
 * fee and 1 nothing.
 */
const TRADES_WITH_COST = 27;
const TRADES_WITH_BROKER_FEE = 27;
const TRADES_WITH_TAX = 4;
const TRADES_WITH_BOTH = 4;
// 27 + 4 - 4 = 27 — the inclusion-exclusion the four numbers above must
// satisfy, written out so a drifted count cannot be "fixed" one constant at a
// time. All 4 of the file's tax-bearing trade rows import: none of them is
// among the 3 the catalogue cannot resolve.

describe("applyImport against a real Postgres (CI-13)", () => {
  let pg: MigratedPostgres;
  let db: Db;
  let writes: TransactionWriteService;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedTenant(pg, IDS);
    await seedPortfolio(pg, IDS.tenantId, SIDE_PORTFOLIO, SIDE_ACCOUNT, "side portfolio");
    writes = buildWriteService(db, IDS.tenantId);
    await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: OVERSELL_ISIN,
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "over-sell subject",
    });
    // FR-55/AC44: a trade's currency is independent of the instrument's own
    // listing currency, so a EUR-listed instrument is exactly as valid a
    // subject for a USD-denominated trade as a USD-listed one would be — see
    // `nativeCurrencyTradeRow`.
    await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: FX_TRADE_ISIN,
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "foreign-currency-trade subject",
    });
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  describe("the asset-catalogue file, applied through the same loop", () => {
    it("creates exactly the instruments the plan named, and no others", async () => {
      const instrumentsBefore = await countInstruments(pg);
      const result = await applyAssetCatalogue(db, IDS, writes);

      expect(result.rowCount).toBe(ASSET_ROWS);
      expect(tally(result.outcomes)).toEqual({
        IMPORT: ASSETS_CREATED,
        INSTRUMENT_ALREADY_EXISTS: ASSETS_ALREADY_CATALOGUED,
        EXCHANGE_MIC_LOOKUP_UNAVAILABLE: ASSETS_UNAVAILABLE,
      });
      expect(result.applyFailed).toBe(0);
      expect(result.applyNotAttempted).toBe(0);
      // The positive companion to both zeros: rows really were written. A run
      // that attempted nothing has the same two zeros as a run that succeeded.
      expect(result.summary.imported).toBe(ASSETS_CREATED);
      // A delta, not a total: `instrument` is shared reference data and this
      // database already carries the seeded sample catalogue plus this suite's
      // own over-sell subject.
      expect((await countInstruments(pg)) - instrumentsBefore).toBe(ASSETS_CREATED);

      // Every `IMPORT` carries the id of a row that exists — the write
      // happened, rather than the outcome merely being relabelled.
      const writtenIds = result.outcomes.flatMap((outcome) =>
        outcome.outcome === "IMPORT" ? [outcome.writtenId] : [],
      );
      expect(new Set(writtenIds).size).toBe(ASSETS_CREATED);
      expect(await countInstrumentsWithIds(pg, writtenIds)).toBe(ASSETS_CREATED);
    }, 120_000);
  });

  describe("the two transaction files, applied in ascending trade-date order", () => {
    let investment: ImportResult;
    let cash: ImportResult;

    it("applies the investment file with the exact counts the plan predicted", async () => {
      const plan = await planImport(
        parsedFixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"),
        planContext(db, IDS, DESTINATION),
      );
      // The precondition, stated before the run rather than after: the plan
      // and the apply can only agree if nothing apply-only intervenes.
      expect(tally(plan.outcomes)).toEqual({
        IMPORT: INVESTMENT_IMPORTED,
        INSTRUMENT_NOT_RESOLVED: INVESTMENT_UNRESOLVED,
      });

      investment = await applyWithGenerousDeadline(plan, db, IDS, writes, DESTINATION);

      expect(investment.rowCount).toBe(INVESTMENT_ROWS);
      expect(tally(investment.outcomes)).toEqual({
        IMPORT: INVESTMENT_IMPORTED,
        INSTRUMENT_NOT_RESOLVED: INVESTMENT_UNRESOLVED,
      });
      // Cashless-distribution support, stated as its intended outcome: **4 imported,
      // 0 rejected** for the four `DISTRIBUTION` rows. `tally` above carries no
      // `UNSUPPORTED_ROW_TYPE` key at all now — the 3 rejections that remain
      // are the unresolvable-exchange position, which is a different and
      // untouched cause.
      expect(
        investment.outcomes.filter(
          (one) => one.outcome !== "IMPORT" && one.reason === "UNSUPPORTED_ROW_TYPE",
        ),
      ).toHaveLength(0);
      expect(investment.summary.rejected).toBe(INVESTMENT_UNRESOLVED);
      // IMP-AC-14's two zeros, as that criterion requires them: the equality above is
      // only meaningful paired with these.
      expect(investment.applyFailed).toBe(0);
      expect(investment.applyNotAttempted).toBe(0);
      expect(await countTransactions(pg, IDS.portfolioId)).toBe(INVESTMENT_IMPORTED);
    }, 120_000);

    it("applies the cash-account file, and writes only the rows that file is canonical for", async () => {
      const plan = await planImport(
        parsedFixture("cash.csv", "CASH_ACCOUNT_TRANSACTIONS"),
        planContext(db, IDS, DESTINATION),
      );
      cash = await applyWithGenerousDeadline(plan, db, IDS, writes, DESTINATION);

      expect(cash.rowCount).toBe(CASH_ROWS);
      expect(tally(cash.outcomes)).toEqual({
        IMPORT: CASH_IMPORTED,
        COVERED_BY_INVESTMENT_FILE: CASH_COVERED,
        ZERO_VALUE_DIVIDEND_MARKER: CASH_ZERO_DIVIDEND_MARKER,
      });
      expect(cash.applyFailed).toBe(0);
      expect(cash.applyNotAttempted).toBe(0);
      expect(await countTransactions(pg, IDS.portfolioId)).toBe(TOTAL_TRANSACTIONS);
    }, 120_000);

    it("wrote every row in ascending (trade_date, seq) order — ID5, and the order GATE-1 measured", async () => {
      // Not a restatement of `applyOrder`: this reads the *written* rows back
      // and checks that the ledger's own replay order matches the file's
      // chronology. An apply loop that walked the plan in file order would
      // still produce the right rows and the wrong order, and only this
      // catches it (M20: an out-of-order walk re-widens every invalidation).
      // `seq` is aliased away from its own column name on purpose: a bare
      // `seq::text` in the select list shadows the column for `ORDER BY`, and
      // the rows then come back in lexicographic order (1, 10, 100, ...),
      // which looks exactly like an out-of-order apply loop.
      const rows = await pg.ownerClient<{ trade_date: string; row_seq: string }[]>`
        SELECT trade_date::text, seq::text AS row_seq FROM "transaction"
        WHERE portfolio_id = ${IDS.portfolioId}::uuid ORDER BY seq
      `;
      expect(rows).toHaveLength(TOTAL_TRANSACTIONS);
      const investmentRows = rows.slice(0, INVESTMENT_IMPORTED).map((row) => row.trade_date);
      const cashRows = rows.slice(INVESTMENT_IMPORTED).map((row) => row.trade_date);
      expect(investmentRows).toEqual([...investmentRows].sort());
      expect(cashRows).toEqual([...cashRows].sort());
      // The positive companion: the dates actually span years, so "sorted" is
      // not trivially true of a single repeated date. 34 rows on 32 distinct
      // dates — 2021-01-12 and 2023-06-21 each carry two.
      expect(new Set(investmentRows).size).toBe(32);
      expect(investmentRows[0]!).not.toBe(investmentRows[investmentRows.length - 1]!);
    }, 60_000);

    /**
     * **FT-42 / AC-244 at fixture scale (Batch G).** The unit-level half —
     * 66 unfolded rows, the pre-cycle table, the mutation counts — is
     * `formats/portfolio-performance/precycle-derivations.test.ts`; this is the
     * half only a real database can answer: that the components survive the
     * whole pipeline and land in their own columns, on the right rows, without
     * moving a single total.
     *
     * Counts are literals and are paired with their population, so a query that
     * matched nothing cannot report a clean result.
     */
    it("FT-42 — every tax-bearing trade row lands with a tax component, and no total moved", async () => {
      const [row] = await pg.ownerClient<
        {
          trades: string;
          with_total: string;
          with_broker: string;
          with_tax: string;
          both: string;
          sum_mismatch: string;
          zero_component: string;
          componentless: string;
        }[]
      >`
        SELECT count(*)::text                                                      AS trades,
               count(*) FILTER (WHERE fee_amount IS NOT NULL)::text                AS with_total,
               count(*) FILTER (WHERE broker_fee_amount IS NOT NULL)::text         AS with_broker,
               count(*) FILTER (WHERE tax_amount IS NOT NULL)::text                AS with_tax,
               count(*) FILTER (WHERE broker_fee_amount IS NOT NULL
                                  AND tax_amount IS NOT NULL)::text                AS both,
               count(*) FILTER (WHERE fee_amount IS NOT NULL
                                  AND fee_amount <> coalesce(broker_fee_amount, 0)
                                                 + coalesce(tax_amount, 0))::text  AS sum_mismatch,
               count(*) FILTER (WHERE broker_fee_amount = 0 OR tax_amount = 0)::text AS zero_component,
               count(*) FILTER (WHERE fee_amount IS NULL
                                  AND broker_fee_amount IS NULL
                                  AND tax_amount IS NULL)::text                    AS componentless
        FROM "transaction"
        WHERE portfolio_id = ${IDS.portfolioId}::uuid AND kind IN ('BUY', 'SELL')
      `;

      // The population, first — every later count is read against it. Scoped
      // to `BUY`/`SELL` by the query above, so it is the *trade* count, which
      // the four cashless distributions deliberately do not join.
      expect(Number(row!.trades)).toBe(INVESTMENT_TRADES_IMPORTED);
      expect(Number(row!.with_total)).toBe(TRADES_WITH_COST);
      expect(Number(row!.componentless)).toBe(INVESTMENT_TRADES_IMPORTED - TRADES_WITH_COST);

      // AC-244's own count: every tax-bearing row that reached the database
      // carries its tax as a component of its own, not folded into the total.
      expect(Number(row!.with_tax)).toBe(TRADES_WITH_TAX);
      expect(Number(row!.with_broker)).toBe(TRADES_WITH_BROKER_FEE);
      expect(Number(row!.both)).toBe(TRADES_WITH_BOTH);

      // …and no total moved: the components sum to it exactly, on every row,
      // at `numeric(38,12)`. This is the database's own CHECK re-asserted from
      // the outside — a constraint that was never exercised would report the
      // same zero.
      expect(Number(row!.sum_mismatch)).toBe(0);
      // FR-213: a component is absent or positive, never a stored zero.
      expect(Number(row!.zero_component)).toBe(0);
    }, 60_000);

    it("keeps the sum-to-zero posting property over every row this import wrote (IMP-AC-18)", async () => {
      // The property `posting-expander.property.test.ts` asserts over
      // hand-built rows, asserted here over the rows built through the import
      // path instead — `ledger`'s own file is untouched (it cannot import
      // `@kerdial/importer`: that edge would be a package cycle), so this is
      // an addition alongside it rather than an edit to it.
      const [row] = await pg.ownerClient<{ offenders: string; checked: string }[]>`
        SELECT
          count(*) FILTER (WHERE total <> 0)::text AS offenders,
          count(*)::text                            AS checked
        FROM (
          SELECT p.transaction_id, sum(p.amount_base) AS total
          FROM "transaction_posting" p
          JOIN "transaction" t ON t.id = p.transaction_id
          WHERE t.portfolio_id = ${IDS.portfolioId}::uuid AND p.flow_class = 'INTERNAL'
          GROUP BY p.transaction_id
        ) per_transaction
      `;
      expect(Number(row!.offenders)).toBe(0);
      // Without this the query could have matched nothing and still reported
      // zero offenders — the exact vacuous shape this repository keeps hitting.
      // The four cashless distributions are among the rows counted here: each emits
      // a single INTERNAL posting worth exactly zero, which sums to zero for
      // the same reason a balanced pair does.
      expect(Number(row!.checked)).toBe(INVESTMENT_IMPORTED);
    }, 60_000);

    /**
     * **The shares the import used to leave behind.**
     *
     * Until `SHARE_DISTRIBUTION` existed, these four rows were rejected and the
     * imported portfolio was short every one of their shares. The assertion is
     * per instrument and it is a *decomposition*, not a total: each holding's
     * quantity is exactly what the file's trades net to **plus** what the
     * distributions added, so a run that silently imported them as buys (wrong
     * cost basis) or dropped them (wrong quantity) fails here.
     *
     * The cost basis half is `ledger`'s own known-answer case
     * (`materialization.integration.test.ts`): this one is about the
     * corpus reaching the database at all.
     */
    it("the four cashless distributions land, and each holding grows by exactly their count", async () => {
      const rows = await pg.ownerClient<
        {
          isin: string;
          distributed: string;
          distribution_rows: string;
          traded_net: string;
          held: string;
          cash_legs: string;
        }[]
      >`
        SELECT i.isin,
               coalesce(sum(t.quantity) FILTER (WHERE t.kind = 'SHARE_DISTRIBUTION'), 0)::text
                 AS distributed,
               count(*) FILTER (WHERE t.kind = 'SHARE_DISTRIBUTION')::text AS distribution_rows,
               (coalesce(sum(t.quantity) FILTER (WHERE t.kind = 'BUY'), 0)
                 - coalesce(sum(t.quantity) FILTER (WHERE t.kind = 'SELL'), 0))::text
                 AS traded_net,
               (SELECT h.quantity::text FROM "holding_state" h
                 WHERE h.portfolio_id = ${IDS.portfolioId}::uuid AND h.instrument_id = i.id)
                 AS held,
               count(*) FILTER (WHERE t.kind = 'SHARE_DISTRIBUTION'
                                  AND (t.cash_account_id IS NOT NULL
                                    OR t.cash_currency IS NOT NULL
                                    OR t.cash_amount IS NOT NULL))::text AS cash_legs
        FROM "transaction" t
        JOIN "instrument" i ON i.id = t.instrument_id
        WHERE t.portfolio_id = ${IDS.portfolioId}::uuid
          AND i.isin = ANY(${DISTRIBUTED_SHARES.map(([isin]) => isin)})
        GROUP BY i.id, i.isin
      `;

      expect(rows).toHaveLength(DISTRIBUTED_SHARES.length);
      for (const [isin, shares] of DISTRIBUTED_SHARES) {
        const measured = rows.find((one) => one.isin === isin);
        expect(measured, `no rows imported for ${isin}`).toBeDefined();
        expect(Number(measured!.distribution_rows)).toBe(1);
        expect(new Decimal(measured!.distributed).toString()).toBe(shares);
        // The holding is the traded net **plus** the distribution — which is
        // the whole claim, and it fails if the shares were dropped.
        expect(new Decimal(measured!.held).toString()).toBe(
          new Decimal(measured!.traded_net).plus(shares).toString(),
        );
        // …and no money moved to get them: the row names no account, no
        // settlement currency and no settled amount.
        expect(Number(measured!.cash_legs)).toBe(0);
      }
      // The four rows are the whole population — nothing else in the portfolio
      // was written as a distribution.
      const [total] = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "transaction"
        WHERE portfolio_id = ${IDS.portfolioId}::uuid AND kind = 'SHARE_DISTRIBUTION'
      `;
      expect(Number(total!.count)).toBe(INVESTMENT_DISTRIBUTIONS_IMPORTED);
    }, 60_000);

    it("produces the same row shape and the same calc_epoch behaviour as a manual write (IMP-AC-16)", async () => {
      // The comparison row is written by calling the same service a manual
      // `POST /transactions` calls, with the same values as one of the
      // imported rows, into the same portfolio and cash account.
      const imported = await oneImportedBuy(pg, IDS.portfolioId);
      const epochBefore = await calcEpoch(pg, IDS.portfolioId);

      const manual = await writes.recordBuy({
        portfolioId: IDS.portfolioId,
        instrumentId: imported.instrument_id,
        tradeDate: imported.trade_date,
        ...(imported.trade_ts === null ? {} : { tradeTs: new Date(imported.trade_ts) }),
        quantity: new Decimal(imported.quantity),
        unitPrice: new Decimal(imported.unit_price),
        txnCurrency: imported.txn_currency,
        cashAccountId: imported.cash_account_id,
        ...(imported.note === null ? {} : { note: imported.note }),
        // FR-227 (FR-260, shape change): the imported row's cost leg is now
        // *itemised*, so the manual row must be built with the same components
        // or IMP-AC-16 compares two genuinely different shapes and reports a
        // difference the import did not cause. Copying them through here keeps
        // the claim what it always was — a manual write can produce exactly
        // what the import produces — and strengthens it, because the
        // components are part of what must match.
        ...(imported.fee_amount === null
          ? {}
          : {
              fee: {
                amount: new Decimal(imported.fee_amount),
                ...(imported.broker_fee_amount === null && imported.tax_amount === null
                  ? {}
                  : {
                      components: {
                        ...(imported.broker_fee_amount === null
                          ? {}
                          : { brokerFee: new Decimal(imported.broker_fee_amount) }),
                        ...(imported.tax_amount === null
                          ? {}
                          : { tax: new Decimal(imported.tax_amount) }),
                      },
                    }),
              },
            }),
        updatedBySessionId: IDS.sessionId,
      });

      const epochAfter = await calcEpoch(pg, IDS.portfolioId);
      // One write, one epoch bump — the existing per-write contract,
      // unchanged by the import path.
      expect(epochAfter).toBe(epochBefore + 1);

      const manualRow = await transactionShape(pg, manual.id);
      const importedShape = await transactionShape(pg, imported.id);
      // Everything except the three columns that are *supposed* to differ:
      // the row's own identity, its ordering position, and the fingerprint
      // that records where it came from.
      expect(manualRow).toEqual(importedShape);
      // ...and the fingerprint is exactly the difference: the imported row has
      // one, the manual row does not. Asserted rather than implied by the
      // exclusion above.
      // FR-260: `pp1:` until FT-40 bumped the recipe.
      expect(await fingerprintOf(pg, imported.id)).toMatch(/^pp2:[0-9a-f]{64}$/);
      expect(await fingerprintOf(pg, manual.id)).toBeNull();

      // Undo, so the counts the re-run test below asserts are the import's own.
      await writes.deleteTransaction({ id: manual.id, changedBy: IDS.userId });
      expect(await countTransactions(pg, IDS.portfolioId)).toBe(TOTAL_TRANSACTIONS);
    }, 60_000);

    it("imports nothing on a second run of the same two files, and skips exactly what it wrote", async () => {
      const investmentAgain = await applyWithGenerousDeadline(
        await planImport(
          parsedFixture("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"),
          planContext(db, IDS, DESTINATION),
        ),
        db,
        IDS,
        writes,
        DESTINATION,
      );
      // The four distribution rows skip on the second run like every other imported row:
      // their fingerprints are real (`SHARE_DISTRIBUTION` is part of the
      // hashed `kindCode`), so idempotency covers them without a special case.
      expect(tally(investmentAgain.outcomes)).toEqual({
        ALREADY_IMPORTED: INVESTMENT_IMPORTED,
        INSTRUMENT_NOT_RESOLVED: INVESTMENT_UNRESOLVED,
      });
      expect(investmentAgain.summary.imported).toBe(0);

      const cashAgain = await applyWithGenerousDeadline(
        await planImport(
          parsedFixture("cash.csv", "CASH_ACCOUNT_TRANSACTIONS"),
          planContext(db, IDS, DESTINATION),
        ),
        db,
        IDS,
        writes,
        DESTINATION,
      );
      expect(tally(cashAgain.outcomes)).toEqual({
        ALREADY_IMPORTED: CASH_IMPORTED,
        COVERED_BY_INVESTMENT_FILE: CASH_COVERED,
        ZERO_VALUE_DIVIDEND_MARKER: CASH_ZERO_DIVIDEND_MARKER,
      });
      expect(cashAgain.summary.imported).toBe(0);

      // The rows the first run wrote are exactly the rows still there — the
      // second run wrote none and destroyed none.
      expect(await countTransactions(pg, IDS.portfolioId)).toBe(TOTAL_TRANSACTIONS);
      // Every previously-imported row became a skip, not a reject: an
      // already-imported file reads as "nothing to do" (ID8), and the two runs'
      // rejected counts are identical.
      expect(investmentAgain.summary.rejected).toBe(investment.summary.rejected);
      expect(cashAgain.summary.rejected).toBe(cash.summary.rejected);
    }, 120_000);
  });

  describe("the apply deadline binds, measured at two values", () => {
    /** Six deposits, ascending dates, distinct amounts — so `applyOrder` is file order and every row is individually identifiable. */
    function sixDeposits(): ParseResult {
      const rows: ParsedRow[] = Array.from({ length: 6 }, (_, index) => {
        const row: NeutralCashMovementRow = {
          shape: "CASH_MOVEMENT",
          direction: "IN",
          tradeDate: `2026-02-${String(index + 1).padStart(2, "0")}`,
          tradeTs: null,
          amount: new Decimal(`${String(100 + index)}.00`),
          currency: "EUR",
          note: null,
        };
        return { at: { line: index + 2, index }, ok: true, row };
      });
      return { fileType: "CASH_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows };
    }

    async function planSixDeposits(): Promise<ImportPlan> {
      return planImport(sixDeposits(), planContext(db, IDS, SIDE_DESTINATION));
    }

    /** Real time for the first `stopAfter` rows, then far past any deadline — so the cut lands at a chosen row rather than wherever the machine happened to be. */
    function clockThatJumpsAfter(stopAfter: number, deadlineAt: Date): Clock {
      let calls = 0;
      return {
        now: () => {
          calls += 1;
          return calls <= stopAfter ? new Date() : new Date(deadlineAt.getTime() + 1_000);
        },
        sleep: systemClock.sleep.bind(systemClock),
      };
    }

    it("writes nothing at all when the deadline has already passed, and reports every row", async () => {
      const plan = await planSixDeposits();
      expect(plan.summary.imported).toBe(6);

      // Value 1 of the tunable: `applyDeadlineMs: 0`, taken through the same
      // `applyDeadlineAt` derivation the controller uses.
      const result = await applyImport({
        plan,
        db,
        writes,
        destination: SIDE_DESTINATION,
        updatedBySessionId: IDS.sessionId,
        deadlineAt: applyDeadlineAt(new Date(), { ...DEFAULT_IMPORT_LIMITS, applyDeadlineMs: 0 }),
        clock: systemClock,
        chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
      });

      expect(result.applyNotAttempted).toBe(6);
      expect(result.summary.imported).toBe(0);
      expect(await countTransactions(pg, SIDE_PORTFOLIO)).toBe(0);
    }, 60_000);

    it("stops cleanly mid-run, keeps what it wrote, and reports the rest as not attempted", async () => {
      const plan = await planSixDeposits();
      const deadlineAt = applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS);
      const result = await applyImport({
        plan,
        db,
        writes,
        destination: SIDE_DESTINATION,
        updatedBySessionId: IDS.sessionId,
        deadlineAt,
        clock: clockThatJumpsAfter(3, deadlineAt),
        chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
      });

      expect(result.summary.imported).toBe(3);
      expect(result.applyNotAttempted).toBe(3);
      expect(result.applyFailed).toBe(0);
      // Per-row commits: the three that ran are on disk, not rolled back.
      expect(await countTransactions(pg, SIDE_PORTFOLIO)).toBe(3);
      // ...and it is the *first* three of the ascending order, not an
      // arbitrary three.
      expect(result.outcomes.slice(0, 3).map((one) => one.outcome)).toEqual([
        "IMPORT",
        "IMPORT",
        "IMPORT",
      ]);
      expect(result.outcomes.slice(3).map((one) => one.outcome)).toEqual([
        "REJECT",
        "REJECT",
        "REJECT",
      ]);
    }, 60_000);

    it("degrades into run-it-twice: the second run imports exactly the remainder", async () => {
      // Value 2 of the tunable: the shipped 25 000 ms. The counter moves from
      // 6 to 0, and the imported count from 0 to 3 — the downstream effect,
      // not the constant, is what is asserted.
      const plan = await planSixDeposits();
      expect(tally(plan.outcomes)).toEqual({ IMPORT: 3, ALREADY_IMPORTED: 3 });

      const result = await applyImport({
        plan,
        db,
        writes,
        destination: SIDE_DESTINATION,
        updatedBySessionId: IDS.sessionId,
        deadlineAt: applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS),
        clock: systemClock,
        chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
      });
      expect(result.applyNotAttempted).toBe(0);
      expect(result.summary.imported).toBe(3);
      expect(await countTransactions(pg, SIDE_PORTFOLIO)).toBe(6);
    }, 60_000);
  });

  describe("APPLY_FAILED is a real ledger refusal, not a predicted one", () => {
    it("lets an over-sell reach the ledger and reports it with the ledger error's own name", async () => {
      const rows: ParsedRow[] = [
        tradeRow(0, "2026-03-01", "ACQUIRE", "4"),
        // Ten times the position the row above establishes. `plan` does not
        // simulate positions (doing so would be a second implementation
        // of ledger math inside the importer), so it marks this row IMPORT.
        tradeRow(1, "2026-03-02", "DISPOSE", "40"),
      ];
      const plan = await planImport(
        { fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS", rowCount: 2, rows },
        planContext(db, IDS, SIDE_DESTINATION),
      );
      // The half of this that is easy to lose: the *plan* saw nothing wrong.
      expect(plan.summary.imported).toBe(2);

      const before = await countTransactions(pg, SIDE_PORTFOLIO);
      const result = await applyImport({
        plan,
        db,
        writes,
        destination: SIDE_DESTINATION,
        updatedBySessionId: IDS.sessionId,
        deadlineAt: applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS),
        clock: systemClock,
        chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
      });

      expect(result.summary.imported).toBe(1);
      expect(result.applyFailed).toBe(1);
      expect(result.applyNotAttempted).toBe(0);
      const failed = result.outcomes[1]!;
      expect(failed.outcome).toBe("REJECT");
      if (failed.outcome !== "REJECT") throw new Error("unreachable");
      expect(failed.reason).toBe("APPLY_FAILED");
      // "carries the ledger error's own code" — the shipped error's own
      // name, not a message this module invented.
      expect(failed.errorName).toBe("InsufficientQuantityError");
      expect(failed.message).toContain("InsufficientQuantityError");
      // The acquisition landed and the disposal did not: partial success is
      // real, and the failed row wrote nothing.
      expect(await countTransactions(pg, SIDE_PORTFOLIO)).toBe(before + 1);
    }, 60_000);
  });

  describe("a zero cost cell is no leg, on both legs that have one", () => {
    /**
     * The asymmetry this closes: the fee branch already required
     * `.greaterThan(0)`, the withholding branch only required "not `null`", and
     * `readCostCell` answers `Decimal(0)` — not `null` — for a source cell that
     * spells the figure out as zero. `validate` and `plan` both permit zero, so
     * such a row was promised as `IMPORT` and then refused by
     * `assertPositiveDecimal` at write time: a dry-run/confirm divergence on an
     * entirely ordinary export.
     *
     * Both legs are exercised in **one** run, because the claim is that they
     * agree — a test that drove only the withholding half could not tell "both
     * normalise" from "the one I changed normalises".
     */
    it("imports a zero-tax dividend and a zero-cost trade with no cost leg stored, and the plan predicted both", async () => {
      const rows: ParsedRow[] = [
        dividendRow(0, "2026-05-04", "12.75", "0"),
        zeroCostTradeRow(1, "2026-05-05"),
        // The positive companions, in the same run and the same shapes: a
        // non-zero figure on each leg still becomes a leg. Without these two,
        // "no leg was stored" would also pass for a pipeline that had stopped
        // storing cost legs at all.
        dividendRow(2, "2026-05-06", "13.75", "1.25"),
        zeroCostTradeRow(3, "2026-05-07", "2.50"),
      ];
      const plan = await planImport(
        { fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows },
        planContext(db, IDS, SIDE_DESTINATION),
      );
      expect(tally(plan.outcomes)).toEqual({ IMPORT: 4 });

      const result = await applyWithGenerousDeadline(plan, db, IDS, writes, SIDE_DESTINATION);

      // The identity: the dry run's counts are the confirm's, which is only
      // true when nothing failed at write time.
      expect(tally(result.outcomes)).toEqual(tally(plan.outcomes));
      expect(result.applyFailed).toBe(0);
      expect(result.applyNotAttempted).toBe(0);

      const written = result.outcomes.map((outcome) => {
        if (outcome.outcome !== "IMPORT") throw new Error(`row was ${outcome.outcome}`);
        return outcome.writtenId;
      });
      // Asserted on the stored rows, not on the summary: the zero cells stored
      // no leg at all (amount, currency and cash account all absent), and the
      // non-zero ones stored a complete one.
      expect(await costLegsOf(pg, written[0]!)).toEqual({
        withholding: null,
        fee: null,
      });
      expect(await costLegsOf(pg, written[1]!)).toEqual({ withholding: null, fee: null });
      expect(await costLegsOf(pg, written[2]!)).toEqual({
        withholding: { amount: "1.250000000000", currency: "", account: "" },
        fee: null,
      });
      // FR-260: the fee leg's `currency` and `account` were `"EUR"` and
      // `SIDE_ACCOUNT` here. L5 denominates a cost by the settling account, so
      // the columns are no longer written and `costLegsOf`
      // renders them as empty strings — the amount is what the leg is.
      expect(await costLegsOf(pg, written[3]!)).toEqual({
        withholding: null,
        fee: { amount: "2.500000000000", currency: "", account: "" },
      });
    }, 60_000);
  });

  /**
   * A real Portfolio Performance export from a
   * USD account (a CTO) settled through a EUR cash account, reported by the
   * user as importing with the trade's own USD price and rate silently lost
   * and only its EUR-converted total kept. This is that shape one layer below
   * `columns.test.ts`'s mapping-only proof — through `planImport` and
   * `applyImport` against a real Postgres, so the write-service call that was
   * only read (never run) while this was designed is actually exercised.
   */
  describe("a foreign-currency trade settles through a base-currency account (FR-55/FR-56/FR-253)", () => {
    it("BUY: stores the trade in its own currency, with the pinned rate and a derived EUR settlement", async () => {
      const rows: ParsedRow[] = [nativeCurrencyTradeRow(0, "2026-04-01", "ACQUIRE")];
      const plan = await planImport(
        { fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS", rowCount: 1, rows },
        planContext(db, IDS, SIDE_DESTINATION),
      );
      expect(tally(plan.outcomes)).toEqual({ IMPORT: 1 });

      const result = await applyWithGenerousDeadline(plan, db, IDS, writes, SIDE_DESTINATION);
      expect(result.applyFailed).toBe(0);
      expect(result.applyNotAttempted).toBe(0);
      const [outcome] = result.outcomes;
      if (outcome?.outcome !== "IMPORT") throw new Error(`row was ${outcome?.outcome}`);

      const [row] = await pg.ownerClient<
        {
          txn_currency: string;
          unit_price: string;
          cash_currency: string;
          cash_amount: string;
          fx_rate: string;
          fx_rate_user_input: string;
        }[]
      >`
        SELECT txn_currency, unit_price::text, cash_currency, cash_amount::text,
               fx_rate::text, fx_rate_user_input::text
        FROM "transaction" WHERE id = ${outcome.writtenId}::uuid
      `;
      // 2 units at 300.00 USD, pinned at the source's own 0.8500 rate:
      // 2 x 300.00 x 0.8500 = 510.00 EUR — the D4/L11 derivation
      // (`#resolveCashLeg`), not a value this row supplied.
      expect(row).toMatchObject({
        txn_currency: "USD",
        unit_price: "300.000000000000000000",
        cash_currency: "EUR",
        cash_amount: "510.000000000000",
        fx_rate: "0.850000000000",
        fx_rate_user_input: "0.850000000000",
      });
    }, 60_000);

    it("SELL: the same shape unwinds the position it just bought", async () => {
      const rows: ParsedRow[] = [nativeCurrencyTradeRow(1, "2026-04-02", "DISPOSE")];
      const plan = await planImport(
        { fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS", rowCount: 1, rows },
        planContext(db, IDS, SIDE_DESTINATION),
      );
      expect(tally(plan.outcomes)).toEqual({ IMPORT: 1 });

      const result = await applyWithGenerousDeadline(plan, db, IDS, writes, SIDE_DESTINATION);
      expect(result.applyFailed).toBe(0);
      expect(result.applyNotAttempted).toBe(0);
      const [outcome] = result.outcomes;
      if (outcome?.outcome !== "IMPORT") throw new Error(`row was ${outcome?.outcome}`);

      const [row] = await pg.ownerClient<{ kind: string; txn_currency: string }[]>`
        SELECT kind, txn_currency FROM "transaction" WHERE id = ${outcome.writtenId}::uuid
      `;
      expect(row).toMatchObject({ kind: "SELL", txn_currency: "USD" });
    }, 60_000);

    it("DIVIDEND: the reference row's gross at its own rate, less a withholding in the account's currency", async () => {
      // The reference row in `net-dividend-reference.csv`: 2.86 EUR credited
      // (the net), 3.65 USD gross at 0.9237, 0.51 EUR withheld. Apple is in
      // the shipped catalogue (migration 0037).
      const plan = await planImport(
        parsedFixture("net-dividend-reference.csv", "CASH_ACCOUNT_TRANSACTIONS"),
        planContext(db, IDS, SIDE_DESTINATION),
      );
      expect(tally(plan.outcomes)).toEqual({ IMPORT: 1 });

      const result = await applyWithGenerousDeadline(plan, db, IDS, writes, SIDE_DESTINATION);
      expect(result.applyFailed).toBe(0);
      const [outcome] = result.outcomes;
      if (outcome?.outcome !== "IMPORT") throw new Error(`row was ${outcome?.outcome}`);

      const [row] = await pg.ownerClient<
        {
          gross_amount: string;
          txn_currency: string;
          fx_rate_user_input: string;
          cash_currency: string;
          cash_amount: string;
          withholding_amount: string;
        }[]
      >`
        SELECT gross_amount::text, txn_currency, fx_rate_user_input::text, cash_currency,
               cash_amount::text, withholding_amount::text
        FROM "transaction" WHERE id = ${outcome.writtenId}::uuid
      `;
      // 3.65 USD x 0.9237 = 3.371505 EUR, derived by the ledger: in a
      // base-currency account the source's settled figure (net + withholding,
      // 2.86 + 0.51 = 3.37) is dropped, as it is for a trade, and no rate is
      // back-solved from it.
      expect(row).toEqual({
        gross_amount: "3.650000000000",
        txn_currency: "USD",
        fx_rate_user_input: "0.923700000000",
        cash_currency: "EUR",
        cash_amount: "3.371505000000",
        withholding_amount: "0.510000000000",
      });

      const postings = await pg.ownerClient<
        { flow_class: string; currency: string; amount_native: string }[]
      >`
        SELECT flow_class::text, currency, amount_native::text
        FROM transaction_posting
        WHERE transaction_id = ${outcome.writtenId}::uuid AND leg = 'CASH'
        ORDER BY seq
      `;
      expect(postings).toEqual([
        { flow_class: "INCOME", currency: "EUR", amount_native: "3.370000000000" },
        { flow_class: "TAX", currency: "EUR", amount_native: "-0.510000000000" },
      ]);
      // The net cash effect is the source's credited 2.86 exactly: the movement
      // round(3.371505 - 0.51, 2) settles to the cent, while the row keeps the
      // unrounded cash_amount above.
      const net = postings.reduce((sum, one) => sum.plus(one.amount_native), new Decimal(0));
      expect(net.toFixed(12)).toBe("2.860000000000");
    }, 60_000);
  });
});

/** A dividend against {@link OVERSELL_ISIN}, with an explicit withholding figure — `"0"` being the zero-cost-cell case. */
function dividendRow(
  index: number,
  tradeDate: string,
  amount: string,
  withholding: string,
): ParsedRow {
  const row: NeutralDividendRow = {
    shape: "DIVIDEND",
    tradeDate,
    tradeTs: null,
    amount: new Decimal(amount),
    currency: "EUR",
    withholdingAmount: new Decimal(withholding),
    instrumentRef: { isin: OVERSELL_ISIN, symbol: null, displayName: null },
    note: null,
  };
  return { at: { line: index + 2, index }, ok: true, row };
}

/** The fee leg's half of the same claim: an acquisition whose combined cost figure is an explicit zero (or, for the companion, is not). */
function zeroCostTradeRow(index: number, tradeDate: string, costs = "0"): ParsedRow {
  const row: NeutralTradeRow = {
    shape: "TRADE",
    direction: "ACQUIRE",
    tradeDate,
    tradeTs: null,
    quantity: new Decimal("1"),
    unitPrice: new Decimal("10.00"),
    currency: "EUR",
    cashCurrency: null,
    fxRateUserInput: null,
    costs: new Decimal(costs),
    // The whole combined figure is a broker fee, as a row carrying only one of
    // the source's two cost figures has it. When `costs` is `"0"` this is a
    // zero broker fee, and asserting on *this* fixture is how the
    // zero-to-absent boundary gets exercised by the suite that already owns
    // the zero-cost claim.
    brokerFee: new Decimal(costs),
    tax: null,
    instrumentRef: { isin: OVERSELL_ISIN, symbol: null, displayName: null },
    note: null,
    isCashSideDuplicate: false,
  };
  return { at: { line: index + 2, index }, ok: true, row };
}

interface StoredCostLeg {
  readonly amount: string;
  readonly currency: string;
  readonly account: string;
}

/** The two cost legs of one stored transaction, read back column by column — `null` when the leg is genuinely absent. */
async function costLegsOf(
  pg: MigratedPostgres,
  id: string,
): Promise<{ withholding: StoredCostLeg | null; fee: StoredCostLeg | null }> {
  const [row] = await pg.ownerClient<
    {
      withholding_amount: string | null;
      fee_amount: string | null;
    }[]
  >`
    SELECT withholding_amount::text, fee_amount::text
    FROM "transaction" WHERE id = ${id}::uuid
  `;
  if (row === undefined) throw new Error(`no transaction ${id}`);
  const leg = (
    amount: string | null,
    currency: string | null,
    account: string | null,
  ): StoredCostLeg | null =>
    amount === null && currency === null && account === null
      ? null
      : { amount: amount ?? "", currency: currency ?? "", account: account ?? "" };
  return {
    // The withholding's own currency and account were read here until
    // `0079` dropped them; it is denominated by the settling account now.
    withholding: leg(row.withholding_amount, null, null),
    // FR-260: the cost's own currency and account were read here until `0049`
    // dropped the columns. A cost is denominated by the
    // settling account now, so the amount is the whole leg.
    fee: leg(row.fee_amount, null, null),
  };
}

/**
 * A trade row against {@link OVERSELL_ISIN} — an instrument created by this
 * suite alone, so the position it names is not shared with the 30 trades the
 * investment file wrote and the over-sell below is arithmetic this test
 * controls entirely.
 */
function tradeRow(
  index: number,
  tradeDate: string,
  direction: "ACQUIRE" | "DISPOSE",
  quantity: string,
): ParsedRow {
  const row: NeutralTradeRow = {
    shape: "TRADE",
    direction,
    tradeDate,
    tradeTs: null,
    quantity: new Decimal(quantity),
    unitPrice: new Decimal("10.00"),
    currency: "EUR",
    cashCurrency: null,
    fxRateUserInput: null,
    costs: null,
    brokerFee: null,
    tax: null,
    instrumentRef: { isin: OVERSELL_ISIN, symbol: null, displayName: null },
    note: null,
    isCashSideDuplicate: false,
  };
  return { at: { line: index + 2, index }, ok: true, row };
}

/**
 * A foreign-currency trade against {@link FX_TRADE_ISIN} — the case a user
 * reported from a securities account: a USD-denominated trade settled through a EUR
 * cash account, exactly the shape `columns.test.ts`'s "records a
 * foreign-currency trade" case builds at the mapping layer. This is that same
 * row one layer down, proving the write actually lands in `transaction`
 * rather than only in the neutral row `columns.ts` produces.
 */
function nativeCurrencyTradeRow(
  index: number,
  tradeDate: string,
  direction: "ACQUIRE" | "DISPOSE",
): ParsedRow {
  const row: NeutralTradeRow = {
    shape: "TRADE",
    direction,
    tradeDate,
    tradeTs: null,
    quantity: new Decimal("2"),
    unitPrice: new Decimal("300.00"),
    currency: "USD",
    cashCurrency: "EUR",
    fxRateUserInput: new Decimal("0.8500"),
    costs: null,
    brokerFee: null,
    tax: null,
    instrumentRef: { isin: FX_TRADE_ISIN, symbol: null, displayName: null },
    note: null,
    isCashSideDuplicate: false,
  };
  return { at: { line: index + 2, index }, ok: true, row };
}

async function countInstruments(pg: MigratedPostgres): Promise<number> {
  const [row] = await pg.ownerClient<{ n: string }[]>`SELECT count(*)::text AS n FROM "instrument"`;
  return Number(row!.n);
}

async function countInstrumentsWithIds(
  pg: MigratedPostgres,
  ids: readonly string[],
): Promise<number> {
  const [row] = await pg.ownerClient<{ n: string }[]>`
    SELECT count(*)::text AS n FROM "instrument" WHERE id::text = ANY(${ids})
  `;
  return Number(row!.n);
}

async function countTransactions(pg: MigratedPostgres, portfolioId: string): Promise<number> {
  const [row] = await pg.ownerClient<{ n: string }[]>`
    SELECT count(*)::text AS n FROM "transaction" WHERE portfolio_id = ${portfolioId}::uuid
  `;
  return Number(row!.n);
}

async function calcEpoch(pg: MigratedPostgres, portfolioId: string): Promise<number> {
  const [row] = await pg.ownerClient<{ calc_epoch: string }[]>`
    SELECT calc_epoch::text FROM "portfolio" WHERE id = ${portfolioId}::uuid
  `;
  return Number(row!.calc_epoch);
}

async function fingerprintOf(pg: MigratedPostgres, id: string): Promise<string | null> {
  const [row] = await pg.ownerClient<{ import_fingerprint: string | null }[]>`
    SELECT import_fingerprint FROM "transaction" WHERE id = ${id}::uuid
  `;
  return row!.import_fingerprint;
}

interface ImportedBuy {
  readonly id: string;
  readonly instrument_id: string;
  readonly trade_date: string;
  readonly trade_ts: string | null;
  readonly quantity: string;
  readonly unit_price: string;
  readonly txn_currency: string;
  readonly cash_account_id: string;
  readonly note: string | null;
  readonly fee_amount: string | null;
  /** FR-227: the imported row is itemised, so the manual comparison row has to be too, or IMP-AC-16 compares two different shapes. */
  readonly broker_fee_amount: string | null;
  readonly tax_amount: string | null;
}

/** One BUY this import wrote, read back from the ledger — the comparison subject for IMP-AC-16. */
async function oneImportedBuy(pg: MigratedPostgres, portfolioId: string): Promise<ImportedBuy> {
  const [row] = await pg.ownerClient<ImportedBuy[]>`
    SELECT id::text, instrument_id::text, trade_date::text, trade_ts::text,
           quantity::text, unit_price::text, txn_currency, cash_account_id::text,
           note, fee_amount::text, broker_fee_amount::text, tax_amount::text
    FROM "transaction"
    WHERE portfolio_id = ${portfolioId}::uuid AND kind = 'BUY'
      AND import_fingerprint IS NOT NULL
    ORDER BY seq LIMIT 1
  `;
  if (row === undefined) throw new Error("the import wrote no plain BUY to compare against");
  return row;
}

/**
 * Every `transaction` column except the four that must differ between two
 * separate rows: `id`, `seq`, the timestamps, and `import_fingerprint` (whose
 * difference is asserted explicitly by the caller).
 */
async function transactionShape(
  pg: MigratedPostgres,
  id: string,
): Promise<Record<string, unknown>> {
  const [row] = await pg.ownerClient<Record<string, unknown>[]>`
    SELECT to_jsonb(t) - 'id' - 'seq' - 'created_at' - 'updated_at' - 'import_fingerprint' AS shape
    FROM "transaction" t WHERE t.id = ${id}::uuid
  `;
  return row!["shape"] as Record<string, unknown>;
}
