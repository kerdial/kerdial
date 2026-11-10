import { createInstrumentBySymbol, type TransactionWriteService } from "@kerdial/ledger";
import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import type { ImportTransferDestination } from "@kerdial/api-contracts";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyImport,
  DEFAULT_IMPORT_LIMITS,
  planImport,
  systemClock,
  type Clock,
  type ImportPlan,
  type ImportResult,
  type PlannedRowOutcome,
} from "../index.js";
import {
  buildWriteService,
  parsedFixture,
  planContext,
  seedTenant,
  tally,
  type HarnessIds,
} from "./__tests__/apply-harness.js";

/**
 * `security-transfer` Batch D (TR-23..TR-25) against a real Postgres: a
 * Portfolio-Performance investment file whose units leave the account, the
 * destination decision the file cannot answer, the destination portfolio's own
 * file recognising the arrival, and the pair's idempotency.
 *
 * Two committed fixtures, both in the export's own bytes (BOM, CRLF, U+202F
 * thousands separator):
 *
 *  - `security-transfer-source.csv` — a worked example: 0.02 BTC
 *    bought at 40 000 (800.00) and 0.03 at 45 000 (1 350.00), PMP
 *    2 150.00 / 0.05 = 43 000; then two transfer-out rows in an exchange
 *    export's shape: 2024-03-14 0.01 BTC valued 620.40 EUR and 2024-06-24
 *    0.01 BTC valued 548.90 EUR. Each removes 43 000 × 0.01 = 430.00 EUR of
 *    cost.
 *  - `security-transfer-destination.csv` — the receiving account's own file:
 *    one arrival matching the first transfer, one matching nothing, and a sale
 *    of 0.005 BTC that only the received units can cover. **No real sample of
 *    an arrival row exists**: it is written on the stated
 *    assumption that it reads like the transfer out with a positive value.
 *
 * Every scenario gets a tenant of its own, so the counts of one cannot leak
 * into another's. `applyImport` is always called **with** `tenantId`: a plan
 * that names a new destination portfolio creates it, which needs the tenant.
 */

const SOURCE_FILE = "security-transfer-source.csv";
const DESTINATION_FILE = "security-transfer-destination.csv";
const FILE_TYPE = "INVESTMENT_ACCOUNT_TRANSACTIONS" as const;

let scenarioCounter = 0;
/** A fresh tenant id family — `…000000f2<nn><kk>` — so no two scenarios share a row. */
function nextIds(): HarnessIds {
  scenarioCounter += 1;
  const base = `00000000-0000-7000-8000-000000f2${String(scenarioCounter).padStart(2, "0")}`;
  return {
    tenantId: `${base}01`,
    userId: `${base}02`,
    sessionId: `${base}03`,
    portfolioId: `${base}04`,
    cashAccountIds: [`${base}05`],
  };
}

const destinationOf = (ids: HarnessIds) => ({
  portfolioId: ids.portfolioId,
  cashAccountId: ids.cashAccountIds[0]!,
});

describe("security-transfer — importing a transfer out of, and into, a Portfolio-Performance account", () => {
  let pg: MigratedPostgres;
  let db: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await createInstrumentBySymbol(db, {
      kind: "CRYPTO",
      symbol: "BTC",
      listingCurrency: "EUR",
      displayName: "Bitcoin",
    });
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  async function seeded(): Promise<HarnessIds> {
    const ids = nextIds();
    await seedTenant(pg, ids);
    return ids;
  }

  function plan(
    ids: HarnessIds,
    file: string,
    destination: { readonly portfolioId: string; readonly cashAccountId: string },
    transferDestinations?: readonly ImportTransferDestination[],
    onDb: Db = db,
  ): Promise<ImportPlan> {
    return planImport(parsedFixture(file, FILE_TYPE), {
      ...planContext(onDb, ids, destination),
      ...(transferDestinations === undefined ? {} : { transferDestinations }),
    });
  }

  function apply(
    ids: HarnessIds,
    planned: ImportPlan,
    destination: { readonly portfolioId: string; readonly cashAccountId: string },
    options: {
      readonly writes?: TransactionWriteService;
      readonly clock?: Clock;
      readonly onDb?: Db;
    } = {},
  ): Promise<ImportResult> {
    const onDb = options.onDb ?? db;
    return applyImport({
      plan: planned,
      db: onDb,
      writes: options.writes ?? buildWriteService(onDb, ids.tenantId),
      destination,
      tenantId: ids.tenantId,
      updatedBySessionId: ids.sessionId,
      deadlineAt: DEADLINE,
      clock: options.clock ?? systemClock,
      chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
    });
  }

  /** Every transfer leg of a tenant, in ledger order, with the portfolio it sits in by name. */
  async function transferLegs(tenantId: string) {
    return pg.ownerClient<
      {
        id: string;
        portfolio: string;
        kind: string;
        trade_date: string;
        quantity: string;
        gross_amount: string;
        transfer_source_id: string | null;
        transfer_cost_base: string | null;
        transfer_cost_currency: string | null;
        fingerprinted: boolean;
      }[]
    >`
      SELECT t.id, p.name AS portfolio, t.kind::text AS kind, t.trade_date::text AS trade_date,
             t.quantity::text AS quantity, t.gross_amount::text AS gross_amount,
             t.transfer_source_id, t.transfer_cost_base::text AS transfer_cost_base,
             t.transfer_cost_currency, t.import_fingerprint IS NOT NULL AS fingerprinted
      FROM "transaction" t JOIN portfolio p ON p.id = t.portfolio_id
      WHERE t.tenant_id = ${tenantId}::uuid AND t.kind::text IN ('TRANSFER_OUT', 'TRANSFER_IN')
      ORDER BY t.trade_date, t.seq
    `;
  }

  async function rowCount(tenantId: string): Promise<number> {
    const [row] = await pg.ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "transaction" WHERE tenant_id = ${tenantId}::uuid
    `;
    return Number(row!.n);
  }

  async function portfolioNamed(tenantId: string, name: string) {
    const [portfolio] = await pg.ownerClient<{ id: string; cash_account_id: string }[]>`
      SELECT p.id, c.id AS cash_account_id FROM portfolio p
      JOIN cash_account c ON c.portfolio_id = p.id
      WHERE p.tenant_id = ${tenantId}::uuid AND p.name = ${name}
    `;
    if (portfolio === undefined) throw new Error(`no portfolio named ${name}`);
    return { portfolioId: portfolio.id, cashAccountId: portfolio.cash_account_id };
  }

  const transferWritesOf = (planned: ImportPlan) =>
    planned.outcomes.flatMap((outcome: PlannedRowOutcome) =>
      outcome.outcome === "IMPORT" &&
      outcome.write.target === "TRANSACTION" &&
      outcome.write.kind === "TRANSFER_OUT"
        ? [outcome.write]
        : [],
    );

  /** The two transfer-out rows are the file's rows 2 and 3; answering both with one name. */
  const bothTo = (portfolioName: string): ImportTransferDestination[] => [
    { index: 2, portfolioName },
    { index: 3, portfolioName },
  ];

  it("AC-464/AC-465: the dry run plans both transfer-out rows as source-leg transfers at the file's value, each asking where", async () => {
    const ids = await seeded();
    const dryRun = await plan(ids, SOURCE_FILE, destinationOf(ids));

    expect(tally(dryRun.outcomes)).toEqual({ IMPORT: 4 });
    expect(
      transferWritesOf(dryRun).map((write) => ({
        tradeDate: write.tradeDate,
        quantity: write.quantity?.toFixed(2),
        amount: write.amount?.toFixed(2),
        currency: write.currency,
        target: write.transferTargetPortfolioId,
      })),
    ).toEqual([
      {
        tradeDate: "2024-03-14",
        quantity: "0.01",
        amount: "620.40",
        currency: "EUR",
        target: null,
      },
      {
        tradeDate: "2024-06-24",
        quantity: "0.01",
        amount: "548.90",
        currency: "EUR",
        target: null,
      },
    ]);
    expect(dryRun.transferDecisions.map((decision) => decision.index)).toEqual([2, 3]);
  });

  it("AC-465, unanswered: each row commits Step A alone — two source legs, no target anywhere", async () => {
    const ids = await seeded();
    const result = await apply(
      ids,
      await plan(ids, SOURCE_FILE, destinationOf(ids)),
      destinationOf(ids),
    );

    expect(tally(result.outcomes)).toEqual({ IMPORT: 4 });
    const legs = await transferLegs(ids.tenantId);
    expect(legs.map((leg) => [leg.kind, leg.portfolio, leg.gross_amount])).toEqual([
      ["TRANSFER_OUT", "csv-import apply suite", "620.400000000000"],
      ["TRANSFER_OUT", "csv-import apply suite", "548.900000000000"],
    ]);
  });

  describe("AC-465, answered with a new portfolio name — and the destination's own file afterwards", () => {
    let ids: HarnessIds;
    let wallet: { readonly portfolioId: string; readonly cashAccountId: string };

    it("creates the named portfolio and two linked pairs carrying the PMP cost, never the market value", async () => {
      ids = await seeded();
      const dryRun = await plan(ids, SOURCE_FILE, destinationOf(ids));
      const confirm = await plan(ids, SOURCE_FILE, destinationOf(ids), bothTo("Wallet"));
      expect(confirm.directory.portfolios.map((one) => one.name)).toEqual(["Wallet"]);
      const result = await apply(ids, confirm, destinationOf(ids));

      // The dry-run/confirm identity: answering changed the write, not the counts.
      expect(tally(dryRun.outcomes)).toEqual(tally(confirm.outcomes));
      expect(tally(result.outcomes)).toEqual(tally(dryRun.outcomes));
      expect(result.applyFailed).toBe(0);

      const legs = await transferLegs(ids.tenantId);
      const [out1, in1, out2, in2] = legs;
      expect(legs.map((leg) => [leg.kind, leg.portfolio, leg.trade_date])).toEqual([
        ["TRANSFER_OUT", "csv-import apply suite", "2024-03-14"],
        ["TRANSFER_IN", "Wallet", "2024-03-14"],
        ["TRANSFER_OUT", "csv-import apply suite", "2024-06-24"],
        ["TRANSFER_IN", "Wallet", "2024-06-24"],
      ]);
      expect(in1!.transfer_source_id).toBe(out1!.id);
      expect(in2!.transfer_source_id).toBe(out2!.id);
      // 43 000 × 0.01 = 430.00 both times — the market values
      // 620.40 and 548.90 ride `gross_amount`, not the cost.
      expect([in1!.transfer_cost_base, in2!.transfer_cost_base]).toEqual([
        "430.000000000000",
        "430.000000000000",
      ]);
      expect(in1!.gross_amount).toBe("620.400000000000");
      expect(in1!.transfer_cost_currency).toBe("EUR");
      // FR-586: the fingerprint is on the source leg only.
      expect(legs.map((leg) => leg.fingerprinted)).toEqual([true, false, true, false]);

      wallet = await portfolioNamed(ids.tenantId, "Wallet");
    });

    it("AC-468: re-submitting the same file, answers and all, writes nothing more on either leg", async () => {
      const before = await rowCount(ids.tenantId);
      const again = await plan(ids, SOURCE_FILE, destinationOf(ids), bothTo("Wallet"));
      // The portfolio exists now: matched by name, not created twice.
      expect(again.directory.portfolios).toEqual([]);
      const result = await apply(ids, again, destinationOf(ids));

      expect(tally(result.outcomes)).toEqual({ ALREADY_IMPORTED: 4 });
      expect(await rowCount(ids.tenantId)).toBe(before);
      expect((await transferLegs(ids.tenantId)).map((leg) => leg.kind)).toEqual([
        "TRANSFER_OUT",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "TRANSFER_IN",
      ]);
    });

    it("AC-466/AC-467: the destination's own file skips the matching arrival, refuses the unmatched one, and writes the sale", async () => {
      const before = await transferLegs(ids.tenantId);
      const result = await apply(ids, await plan(ids, DESTINATION_FILE, wallet), wallet);

      expect(
        result.outcomes.map((outcome) =>
          outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason,
        ),
      ).toEqual(["COVERED_BY_TRANSFER_OUT", "UNSUPPORTED_ROW_TYPE", "IMPORT"]);
      // No second target leg: the transfer legs are exactly the ones before.
      expect(await transferLegs(ids.tenantId)).toEqual(before);
      // 0.02 received − 0.005 sold; the refused arrival added nothing.
      const [holding] = await pg.ownerClient<{ quantity: string }[]>`
        SELECT quantity::text AS quantity FROM holding_state
        WHERE portfolio_id = ${wallet.portfolioId}::uuid
      `;
      expect(holding?.quantity).toBe("0.015000000000000000");
    });
  });

  it("R-5 (documented, not fixed): the destination file imported first refuses its arrivals and its sale oversells; importing the source file first, then it again, recovers", async () => {
    const ids = await seeded();
    const walletIds = { portfolioId: ids.portfolioId, cashAccountId: ids.cashAccountIds[0]! };
    // This scenario's seeded portfolio *is* the receiving one; the source
    // portfolio is a second one.
    const sourcePortfolio = `${ids.portfolioId.slice(0, -2)}14`;
    const sourceAccount = `${ids.portfolioId.slice(0, -2)}15`;
    await pg.ownerClient`
      INSERT INTO portfolio (id, tenant_id, name) VALUES (${sourcePortfolio}::uuid, ${ids.tenantId}::uuid, 'Exchange')
    `;
    await pg.ownerClient`
      INSERT INTO cash_account (id, tenant_id, portfolio_id, name, currency)
      VALUES (${sourceAccount}::uuid, ${ids.tenantId}::uuid, ${sourcePortfolio}::uuid, 'Exchange EUR', 'EUR')
    `;
    const source = { portfolioId: sourcePortfolio, cashAccountId: sourceAccount };

    const first = await apply(ids, await plan(ids, DESTINATION_FILE, walletIds), walletIds);
    // AC-467 (OD-8 (a)): an arrival with no transfer out anywhere is refused,
    // and it creates no row and no holding; the sale then has nothing to sell.
    expect(
      first.outcomes.map((outcome) => (outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason)),
    ).toEqual(["UNSUPPORTED_ROW_TYPE", "UNSUPPORTED_ROW_TYPE", "APPLY_FAILED"]);
    expect(await rowCount(ids.tenantId)).toBe(0);
    const holdings = await pg.ownerClient<{ quantity: string }[]>`
      SELECT quantity::text AS quantity FROM holding_state
      WHERE portfolio_id = ${ids.portfolioId}::uuid AND quantity <> 0
    `;
    expect(holdings).toEqual([]);

    // The recovery the reject message names: the source file first, naming
    // this portfolio, then this file again.
    await apply(
      ids,
      await plan(ids, SOURCE_FILE, source, bothTo("csv-import apply suite")),
      source,
    );
    const second = await apply(ids, await plan(ids, DESTINATION_FILE, walletIds), walletIds);
    expect(
      second.outcomes.map((outcome) => (outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason)),
    ).toEqual(["COVERED_BY_TRANSFER_OUT", "UNSUPPORTED_ROW_TYPE", "IMPORT"]);
  });

  describe("an apply the deadline cut short, continued", () => {
    /** Reads before the line for the first `readings` clock readings, past it after. */
    function clockCrossingAfter(readings: number): Clock {
      let taken = 0;
      return {
        now: () => {
          taken += 1;
          return new Date(DEADLINE.getTime() + (taken > readings ? 1 : -1));
        },
        sleep: () => Promise.resolve(),
      };
    }

    /** The first run writes the two buys and the first transfer, then the line is crossed. */
    async function firstRunCutAfterTheFirstTransfer(ids: HarnessIds): Promise<void> {
      const cut = await apply(
        ids,
        await plan(ids, SOURCE_FILE, destinationOf(ids), bothTo("Wallet")),
        destinationOf(ids),
        { clock: clockCrossingAfter(3) },
      );
      expect(tally(cut.outcomes)).toEqual({ IMPORT: 3, APPLY_NOT_ATTEMPTED: 1 });
    }

    it("a continuation that echoes the answers links the remaining transfer too", async () => {
      const ids = await seeded();
      await firstRunCutAfterTheFirstTransfer(ids);
      const continued = await apply(
        ids,
        await plan(ids, SOURCE_FILE, destinationOf(ids), bothTo("Wallet")),
        destinationOf(ids),
      );
      expect(tally(continued.outcomes)).toEqual({ ALREADY_IMPORTED: 3, IMPORT: 1 });
      expect((await transferLegs(ids.tenantId)).map((leg) => leg.kind)).toEqual([
        "TRANSFER_OUT",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "TRANSFER_IN",
      ]);
    });

    it("the failure the echo exists for: a continuation that drops them writes the remaining transfer alone, silently", async () => {
      const ids = await seeded();
      await firstRunCutAfterTheFirstTransfer(ids);
      const continued = await apply(
        ids,
        await plan(ids, SOURCE_FILE, destinationOf(ids)),
        destinationOf(ids),
      );
      // Nothing in the counts says anything went wrong…
      expect(tally(continued.outcomes)).toEqual({ ALREADY_IMPORTED: 3, IMPORT: 1 });
      // …and the second transfer has no target leg.
      expect((await transferLegs(ids.tenantId)).map((leg) => leg.kind)).toEqual([
        "TRANSFER_OUT",
        "TRANSFER_IN",
        "TRANSFER_OUT",
      ]);
    });
  });

  it("FR-586: a fault inside the pair's savepoint leaves neither leg — never a lone target", async () => {
    const ids = await seeded();
    const writes = buildWriteService(db, ids.tenantId);
    const writtenThenRolledBack: string[] = [];
    // The real write runs to completion — source and target both inserted —
    // and the fault is raised after it, still inside `batch.row`'s savepoint.
    const faulty = new Proxy(writes, {
      get(target, property, receiver) {
        if (property === "recordTransferOut") {
          return async (params: Parameters<TransactionWriteService["recordTransferOut"]>[0]) => {
            const source = await target.recordTransferOut(params);
            writtenThenRolledBack.push(source.id);
            throw new Error("injected after the pair was written, inside its savepoint");
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const result = await apply(
      ids,
      await plan(ids, SOURCE_FILE, destinationOf(ids), bothTo("Wallet")),
      destinationOf(ids),
      { writes: faulty },
    );

    expect(tally(result.outcomes)).toEqual({ IMPORT: 2, APPLY_FAILED: 2 });
    // Both pairs were written before the fault…
    expect(writtenThenRolledBack).toHaveLength(2);
    // …and neither leg of either survived it, while the buys beside them did.
    expect(await transferLegs(ids.tenantId)).toEqual([]);
    const survivors = await pg.ownerClient<{ n: string }[]>`
      SELECT count(*)::text AS n FROM "transaction"
      WHERE id = ANY(${writtenThenRolledBack}::uuid[])
         OR transfer_source_id = ANY(${writtenThenRolledBack}::uuid[])
    `;
    expect(survivors[0]!.n).toBe("0");
    expect(await rowCount(ids.tenantId)).toBe(2);
  });

  it("FR-586: two concurrent imports of the same confirmed plan write one pair per row — the unique index turns the loser into a skip", async () => {
    const ids = await seeded();
    // An existing destination, so the two runs create nothing: what is under
    // test is the source leg's unique index, not two creates of one portfolio.
    await pg.ownerClient`
      INSERT INTO portfolio (id, tenant_id, name)
      VALUES (${`${ids.portfolioId.slice(0, -2)}24`}::uuid, ${ids.tenantId}::uuid, 'Wallet')
    `;
    const confirmed = await plan(ids, SOURCE_FILE, destinationOf(ids), bothTo("Wallet"));
    expect(confirmed.directory.portfolios).toEqual([]);
    // Two connections of their own, each warmed, so the two applies genuinely
    // overlap rather than queue on one lazily-opened client.
    const clients = [postgres(pg.ownerUri, { max: 2 }), postgres(pg.ownerUri, { max: 2 })];
    try {
      await Promise.all(clients.map((client) => client`SELECT 1`));
      const dbs = clients.map((client) => createDb(client));
      const results = await Promise.all(
        dbs.map((onDb) => apply(ids, confirmed, destinationOf(ids), { onDb })),
      );

      // Row by row: exactly one of the two runs wrote it, the other skipped it.
      for (let index = 0; index < confirmed.rowCount; index += 1) {
        const labels = results
          .map((result) => result.outcomes[index]!)
          .map((outcome) => (outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason))
          .sort();
        expect(labels).toEqual(["ALREADY_IMPORTED", "IMPORT"]);
      }
      expect((await transferLegs(ids.tenantId)).map((leg) => leg.kind)).toEqual([
        "TRANSFER_OUT",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "TRANSFER_IN",
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
    }
  });
});

/** Far enough out that it is never the thing under test, except where a clock is handed in to cross it. */
const DEADLINE = new Date(Date.now() + 600_000);
