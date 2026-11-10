import { autoCreatedCashAccountName, createInstrumentBySymbol } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyImport, DEFAULT_IMPORT_LIMITS, planImport, systemClock } from "../index.js";
import {
  buildWriteService,
  parsedFixture,
  planContext,
  seedTenant,
  tally,
  type HarnessIds,
} from "./__tests__/apply-harness.js";

/**
 * A crypto account export that settles some rows in EUR and some in USD
 * (`crypto-mixed-currency.csv`, four synthetic rows in a crypto exchange
 * export's shape), imported into a portfolio whose only account is EUR.
 *
 * Three things had to change for it to import at all: a fractional quantity
 * (`0,00365412`, and the three-decimal `3,125`) was refused; a USD-settled row
 * was sent to the EUR account and refused by the ledger's account-currency
 * check; and a EUR-priced trade settled in USD — a third currency beside a EUR
 * base — carried no settled amount, which the ledger requires there.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-0000000f1001",
  userId: "00000000-0000-7000-8000-0000000f1002",
  sessionId: "00000000-0000-7000-8000-0000000f1003",
  portfolioId: "00000000-0000-7000-8000-0000000f1004",
  cashAccountIds: ["00000000-0000-7000-8000-0000000f1005"],
};
const DESTINATION = { portfolioId: IDS.portfolioId, cashAccountId: IDS.cashAccountIds[0]! };

describe("a mixed-currency crypto export into a EUR-only portfolio", () => {
  let pg: MigratedPostgres;
  let db: Db;

  const importOnce = async () => {
    const parsed = parsedFixture("crypto-mixed-currency.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS");
    const plan = await planImport(parsed, planContext(db, IDS, DESTINATION));
    const result = await applyImport({
      plan,
      db,
      writes: buildWriteService(db, IDS.tenantId),
      destination: DESTINATION,
      tenantId: IDS.tenantId,
      updatedBySessionId: IDS.sessionId,
      deadlineAt: new Date(Date.now() + 600_000),
      clock: systemClock,
      chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
    });
    return { plan, result };
  };

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedTenant(pg, IDS);
    for (const [symbol, displayName] of [
      ["BTC", "Bitcoin"],
      ["SOL", "Solana"],
    ] as const) {
      await createInstrumentBySymbol(db, {
        kind: "CRYPTO",
        symbol,
        listingCurrency: "EUR",
        displayName,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("routes each row to an account in its own currency, opening a USD one", async () => {
    const { plan, result } = await importOnce();

    expect(tally(plan.outcomes)).toEqual({ IMPORT: 4 });
    expect(plan.directory.cashAccounts.map(({ name, currency }) => ({ name, currency }))).toEqual([
      { name: autoCreatedCashAccountName("USD"), currency: "USD" },
    ]);
    expect(tally(result.outcomes)).toEqual({ IMPORT: 4 });

    const trades = await pg.ownerClient<
      {
        kind: string;
        quantity: string;
        txn_currency: string;
        account_currency: string;
        cash_currency: string;
        cash_amount: string;
      }[]
    >`
      SELECT t.kind, t.quantity::text, t.txn_currency, c.currency AS account_currency,
             t.cash_currency, t.cash_amount::text
      FROM transaction t JOIN cash_account c ON c.id = t.cash_account_id
      WHERE t.tenant_id = ${IDS.tenantId}::uuid
      ORDER BY t.trade_date
    `;
    expect(trades).toEqual([
      {
        kind: "BUY",
        quantity: "0.003654120000000000",
        txn_currency: "EUR",
        account_currency: "EUR",
        cash_currency: "EUR",
        cash_amount: "150.000000000000",
      },
      // The settled USD figure less the USD fee: 325,40 − 0,71 = 324,69. The
      // trade itself is the EUR `Montant brut`, 298,70 (× 1,0870 = 324,69).
      {
        kind: "BUY",
        quantity: "3.125000000000000000",
        txn_currency: "EUR",
        account_currency: "USD",
        cash_currency: "USD",
        cash_amount: "324.690000000000",
      },
      // 412,34 + 0,46 = 412,80.
      {
        kind: "SELL",
        quantity: "3.125000000000000000",
        txn_currency: "EUR",
        account_currency: "USD",
        cash_currency: "USD",
        cash_amount: "412.800000000000",
      },
    ]);
  });

  it("re-imports as already imported, into the account it opened, and opens no other", async () => {
    const { plan, result } = await importOnce();

    expect(tally(plan.outcomes)).toEqual({ ALREADY_IMPORTED: 4 });
    expect(plan.directory.cashAccounts).toEqual([]);
    expect(tally(result.outcomes)).toEqual({ ALREADY_IMPORTED: 4 });
    const accounts = await pg.ownerClient<{ currency: string }[]>`
      SELECT currency FROM cash_account WHERE portfolio_id = ${IDS.portfolioId}::uuid ORDER BY currency
    `;
    expect(accounts.map((one) => one.currency)).toEqual(["EUR", "USD"]);
  });
});
