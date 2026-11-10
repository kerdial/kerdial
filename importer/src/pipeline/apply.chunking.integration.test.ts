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
  type NeutralCashMovementRow,
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
 * `applyImport`'s chunked write path: the designed-but-not-built fallback,
 * built once the NAS deployment showed the 25 s apply deadline
 * rejecting rows on a real file.
 *
 * It was first declined on GATE-1's evidence ("GATE-1 PASSED at 4838 ms /
 * 2031 ms"), which was measured on a CI runner against a local Postgres. The
 * gate was not wrong; it was measured on hardware the deployment turned out
 * not to run on. What this suite pins is not the speed — a timing assertion is
 * a flake on shared hardware — but the four
 * things the speed was bought with, each of which is a way the change could be
 * silently wrong:
 *
 *  1. the recompute really does run once per chunk and not once per row
 *     (otherwise nothing was gained and the suite would still pass on counts);
 *  2. a row the ledger refuses inside a chunk still fails **alone**;
 *  3. the materialised state a chunked run leaves is byte-for-byte the state a
 *     row-at-a-time run leaves;
 *  4. crossing the deadline mid-file still leaves a consistent database and a
 *     re-run that imports exactly the remainder.
 *
 * (1) and (4) are also where the two-different-values rule lands for
 * `applyChunkRows`: every assertion about it below is a *difference* between
 * two chunk sizes, never a reading of the constant.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-0000000c1001",
  userId: "00000000-0000-7000-8000-0000000c1002",
  sessionId: "00000000-0000-7000-8000-0000000c1003",
  portfolioId: "00000000-0000-7000-8000-0000000c1004",
  cashAccountIds: ["00000000-0000-7000-8000-0000000c1005"],
};

/** One portfolio per case, so no case can read a count another case moved. */
const EPOCH_SMALL_CHUNK = [
  "00000000-0000-7000-8000-0000000c1010",
  "00000000-0000-7000-8000-0000000c1011",
] as const;
const EPOCH_ONE_CHUNK = [
  "00000000-0000-7000-8000-0000000c1012",
  "00000000-0000-7000-8000-0000000c1013",
] as const;
const FAIL_ALONE = [
  "00000000-0000-7000-8000-0000000c1014",
  "00000000-0000-7000-8000-0000000c1015",
] as const;
const EQUIV_PER_ROW = [
  "00000000-0000-7000-8000-0000000c1016",
  "00000000-0000-7000-8000-0000000c1017",
] as const;
const EQUIV_CHUNKED = [
  "00000000-0000-7000-8000-0000000c1018",
  "00000000-0000-7000-8000-0000000c1019",
] as const;
const DEADLINE = [
  "00000000-0000-7000-8000-0000000c101a",
  "00000000-0000-7000-8000-0000000c101b",
] as const;

const ALL_PORTFOLIOS = [
  EPOCH_SMALL_CHUNK,
  EPOCH_ONE_CHUNK,
  FAIL_ALONE,
  EQUIV_PER_ROW,
  EQUIV_CHUNKED,
  DEADLINE,
] as const;

/** This suite's own instrument: nothing else holds it, so a `DISPOSE` of it is an over-sell by construction. */
const OVERSELL_ISIN = "FRTEST999994";

/** The recorded figures for the two transaction fixtures, reached through `plan` below rather than trusted. */
const INVESTMENT_IMPORTED = 34;
const CASH_IMPORTED = 18;

function deposits(count: number, firstLine = 2): ParseResult {
  const rows: ParsedRow[] = Array.from({ length: count }, (_, index) => {
    const row: NeutralCashMovementRow = {
      shape: "CASH_MOVEMENT",
      direction: "IN",
      tradeDate: `2026-03-${String(index + 1).padStart(2, "0")}`,
      tradeTs: null,
      amount: new Decimal(`${String(100 + index)}.00`),
      currency: "EUR",
      note: null,
    };
    return { at: { line: firstLine + index, index }, ok: true, row };
  });
  return { fileType: "CASH_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows };
}

/** A `DISPOSE` of an instrument this portfolio has never held — `InsufficientQuantityError` at apply time, never at plan time. */
function overSellRow(index: number): ParsedRow {
  const row: NeutralTradeRow = {
    shape: "TRADE",
    direction: "DISPOSE",
    tradeDate: "2026-03-15",
    tradeTs: null,
    quantity: new Decimal("5"),
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

/**
 * The materialised state of one portfolio, with every identifier that cannot
 * be equal across two portfolios dropped, so two portfolios that were fed the
 * same rows compare equal. Three columns are left out, each for its own
 * reason:
 *
 *  - `calc_epoch` — how many times the state was recomputed is exactly the
 *    thing this change alters, and folding it in here would make the
 *    equivalence check assert the opposite of the two cases above.
 *  - `last_txn_seq` — `transaction.seq` is monotonic **per tenant**, so the
 *    second portfolio's rows carry the continuation of the first's numbering,
 *    not a repeat of it. What it points at is compared; the number is not
 *    comparable.
 *  - `realized_gain.transaction_id` / `id` — fresh uuids per run.
 *
 * What is left is every computed figure: the position, its cost basis and PMP
 * in both currencies, the cash balance, and every realised disposal.
 */
async function materialisedState(
  pg: MigratedPostgres,
  portfolioId: string,
): Promise<Record<string, unknown>[][]> {
  const holdings = await pg.ownerClient<Record<string, unknown>[]>`
    SELECT instrument_id::text, quantity::text, cost_basis_base::text, pmp_unit_base::text,
           cost_basis_native::text, pmp_unit_native::text
    FROM "holding_state" WHERE portfolio_id = ${portfolioId}::uuid
    ORDER BY instrument_id
  `;
  const cash = await pg.ownerClient<Record<string, unknown>[]>`
    SELECT currency::text, amount::text
    FROM "cash_balance" WHERE portfolio_id = ${portfolioId}::uuid
    ORDER BY currency
  `;
  const gains = await pg.ownerClient<Record<string, unknown>[]>`
    SELECT instrument_id::text, disposal_date::text, quantity_sold::text, pmp_unit_base_at_sale::text,
           proceeds_base::text, gain_base::text, gain_native::text, fx_component_base::text
    FROM "realized_gain" WHERE portfolio_id = ${portfolioId}::uuid
    ORDER BY disposal_date, instrument_id, quantity_sold
  `;
  return [[...holdings], [...cash], [...gains]];
}

describe("applyImport writes in chunks", () => {
  let pg: MigratedPostgres;
  let db: Db;
  let writes: TransactionWriteService;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedTenant(pg, IDS);
    for (const [portfolioId, cashAccountId] of ALL_PORTFOLIOS) {
      await seedPortfolio(pg, IDS.tenantId, portfolioId, cashAccountId, `chunking ${portfolioId}`);
    }
    writes = buildWriteService(db, IDS.tenantId);
    await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: OVERSELL_ISIN,
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "chunking over-sell subject",
    });
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  describe("one portfolio recompute per chunk, not per row", () => {
    /**
     * `calc_epoch` is `recomputeAndInvalidate`'s own step 2 and is incremented
     * exactly once per call, so its advance across a run **is** the number of
     * recomputes — counted from the database rather than from a spy, which
     * would only prove that a mock was called.
     *
     * Deposits, not trades: a trade reaches `assertSufficientQuantity`, which
     * legitimately forces an extra flush mid-chunk (see its own comment), and
     * this case is about the chunk count and nothing else.
     */
    const twentyRows = 20;

    it("advances calc_epoch once per chunk at a chunk size of 5", async () => {
      const [portfolioId, cashAccountId] = EPOCH_SMALL_CHUNK;
      const destination = { portfolioId, cashAccountId };
      const plan = await planImport(deposits(twentyRows), planContext(db, IDS, destination));
      expect(plan.summary.imported).toBe(twentyRows);

      const before = await calcEpoch(pg, portfolioId);
      const result = await applyWithGenerousDeadline(plan, db, IDS, writes, destination, 5);

      expect(result.summary.imported).toBe(twentyRows);
      expect(await countTransactions(pg, portfolioId)).toBe(twentyRows);
      // 20 rows / 5 per chunk = 4 chunks = 4 recomputes, where the per-row
      // path this replaced would have produced 20.
      expect((await calcEpoch(pg, portfolioId)) - before).toBe(4);
    }, 120_000);

    it("advances it exactly once when the whole file is one chunk", async () => {
      const [portfolioId, cashAccountId] = EPOCH_ONE_CHUNK;
      const destination = { portfolioId, cashAccountId };
      const plan = await planImport(deposits(twentyRows), planContext(db, IDS, destination));

      const before = await calcEpoch(pg, portfolioId);
      const result = await applyWithGenerousDeadline(
        plan,
        db,
        IDS,
        writes,
        destination,
        twentyRows,
      );

      expect(result.summary.imported).toBe(twentyRows);
      expect(await countTransactions(pg, portfolioId)).toBe(twentyRows);
      // The second value of the tunable, and the one that makes the first a
      // measurement rather than a reading: same rows, same counts, a quarter
      // of the recomputes.
      expect((await calcEpoch(pg, portfolioId)) - before).toBe(1);
    }, 120_000);
  });

  it("fails one refused row alone and commits the rest of its chunk", async () => {
    const [portfolioId, cashAccountId] = FAIL_ALONE;
    const destination = { portfolioId, cashAccountId };
    // Three rows, one chunk, the middle one refused by the ledger at write
    // time — `plan` cannot know the position is empty, so this is exactly
    // the "exceptional apply-time failure" and the case the per-row
    // `SAVEPOINT` exists for.
    const parsed: ParseResult = {
      fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
      rowCount: 3,
      rows: [depositAsTradeFileRow(0), overSellRow(1), depositAsTradeFileRow(2)],
    };
    const plan = await planImport(parsed, planContext(db, IDS, destination));
    expect(plan.summary.imported).toBe(3);

    const result = await applyWithGenerousDeadline(plan, db, IDS, writes, destination, 10);

    expect(tally(result.outcomes)).toEqual({ IMPORT: 2, APPLY_FAILED: 1 });
    expect(result.applyFailed).toBe(1);
    // The claim the savepoint makes, and the one an aborted transaction would
    // break: the other two rows are on disk.
    expect(await countTransactions(pg, portfolioId)).toBe(2);
    const failed = result.outcomes[1]!;
    expect(failed.outcome).toBe("REJECT");
    if (failed.outcome === "REJECT") {
      expect(failed.errorName).toBe("InsufficientQuantityError");
    }
  }, 120_000);

  it("leaves the same materialised state as a row-at-a-time run", async () => {
    // The committed fixture, both transaction files, into two portfolios that differ
    // only in chunk size — `chunkRows: 1` is the pre-chunking path exactly (one
    // transaction and one recompute per row), so this is a differential test
    // against the behaviour being replaced, not against a hand-written
    // expectation of it.
    await applyAssetCatalogue(db, IDS, writes);

    const applyBoth = async (portfolioId: string, cashAccountId: string, chunkRows: number) => {
      const destination = { portfolioId, cashAccountId };
      for (const [file, fileType] of [
        ["investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"],
        ["cash.csv", "CASH_ACCOUNT_TRANSACTIONS"],
      ] as const) {
        const plan: ImportPlan = await planImport(
          parsedFixture(file, fileType),
          planContext(db, IDS, destination),
        );
        const result = await applyWithGenerousDeadline(
          plan,
          db,
          IDS,
          writes,
          destination,
          chunkRows,
        );
        expect(result.applyFailed).toBe(0);
        expect(result.applyNotAttempted).toBe(0);
      }
      return countTransactions(pg, portfolioId);
    };

    const [perRowPortfolio, perRowAccount] = EQUIV_PER_ROW;
    const [chunkedPortfolio, chunkedAccount] = EQUIV_CHUNKED;
    expect(await applyBoth(perRowPortfolio, perRowAccount, 1)).toBe(
      INVESTMENT_IMPORTED + CASH_IMPORTED,
    );
    expect(await applyBoth(chunkedPortfolio, chunkedAccount, 50)).toBe(
      INVESTMENT_IMPORTED + CASH_IMPORTED,
    );

    const perRow = await materialisedState(pg, perRowPortfolio);
    const chunked = await materialisedState(pg, chunkedPortfolio);
    // Non-vacuous on all three tables: this fixture holds positions, a EUR
    // cash balance and realised disposals, so an empty-equals-empty pass is
    // not available.
    expect(perRow[0]!.length).toBeGreaterThan(0);
    expect(perRow[1]!.length).toBeGreaterThan(0);
    expect(perRow[2]!.length).toBeGreaterThan(0);
    expect(chunked).toEqual(perRow);
  }, 600_000);

  it("keeps what a deadline-interrupted chunk wrote, consistent, and imports the remainder on a re-run", async () => {
    const [portfolioId, cashAccountId] = DEADLINE;
    const destination = { portfolioId, cashAccountId };
    const rows = 10;
    const chunkRows = 4;
    const plan = await planImport(deposits(rows), planContext(db, IDS, destination));
    const deadlineAt = applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS);

    /** Real time for `stopAfter` reads of the clock, then far past the deadline — so the cut lands at a chosen row. */
    const clockThatJumpsAfter = (stopAfter: number): Clock => {
      let calls = 0;
      return {
        now: () => {
          calls += 1;
          return calls <= stopAfter ? new Date() : new Date(deadlineAt.getTime() + 1_000);
        },
        sleep: systemClock.sleep.bind(systemClock),
      };
    };

    // The cut lands inside the second chunk: the first chunk's 4 rows and the
    // pre-chunk check of the second have consumed 5 reads, so row 6 is the
    // first to see the jumped clock.
    const first = await applyImport({
      plan,
      db,
      writes,
      destination,
      updatedBySessionId: IDS.sessionId,
      deadlineAt,
      clock: clockThatJumpsAfter(6),
      chunkRows,
    });

    const imported = first.summary.imported;
    expect(imported).toBeGreaterThan(0);
    expect(imported).toBeLessThan(rows);
    expect(first.applyNotAttempted).toBe(rows - imported);
    // Committed, not rolled back — the property that makes "re-run it" the
    // remedy rather than "start again".
    expect(await countTransactions(pg, portfolioId)).toBe(imported);

    // ...and consistent with exactly those rows: the deferred recompute of an
    // interrupted chunk ran before that chunk committed, so the balance is the
    // sum of the deposits that landed, never of the ones that were planned.
    const expectedBalance = Array.from({ length: imported }, (_, index) => 100 + index).reduce(
      (total, amount) => total + amount,
      0,
    );
    const [cash] = await pg.ownerClient<{ amount: string }[]>`
      SELECT amount::text FROM "cash_balance" WHERE portfolio_id = ${portfolioId}::uuid
    `;
    expect(Number(cash!.amount)).toBe(expectedBalance);

    // The re-run: the rows that landed are recognised by fingerprint and
    // skipped, and exactly the remainder is written.
    const rerunPlan = await planImport(deposits(rows), planContext(db, IDS, destination));
    expect(tally(rerunPlan.outcomes)).toEqual({
      IMPORT: rows - imported,
      ALREADY_IMPORTED: imported,
    });
    const rerun = await applyWithGenerousDeadline(
      rerunPlan,
      db,
      IDS,
      writes,
      destination,
      chunkRows,
    );
    expect(rerun.summary.imported).toBe(rows - imported);
    expect(await countTransactions(pg, portfolioId)).toBe(rows);
  }, 180_000);
});

/** A cash-movement row in the investment file's own shape, so the refused-row case can put three rows in one chunk. */
function depositAsTradeFileRow(index: number): ParsedRow {
  const row: NeutralCashMovementRow = {
    shape: "CASH_MOVEMENT",
    direction: "IN",
    tradeDate: `2026-03-${String(index + 1).padStart(2, "0")}`,
    tradeTs: null,
    amount: new Decimal("500.00"),
    currency: "EUR",
    note: null,
  };
  return { at: { line: index + 2, index }, ok: true, row };
}
