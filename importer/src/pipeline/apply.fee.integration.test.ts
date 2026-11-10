import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planImport, type ImportPlan, type ParseResult, type PlannedRowOutcome } from "../index.js";
import type { NeutralFeeRow, NeutralTradeRow } from "../types.js";
import {
  applyWithGenerousDeadline,
  buildWriteService,
  parsedFixture,
  planContext,
  seedTenant,
  tally,
  type HarnessIds,
} from "./__tests__/apply-harness.js";

/**
 * `portfolio-cash` AC-586: a synthetic
 * cash-account file (`frais-cash-account.csv`, kept out of the measured corpus
 * so its per-label counts stay pinned) carrying, in file order:
 *
 *  0. a deposit of 100,00 — the routing reference;
 *  1. a fee row in an insurer's export shape (3,10 debited, a note, instrument
 *     IE00B4L5Y983);
 *  2. a withdrawal with the fee's date, amount, currency and account (C-8);
 *  3. the same fee written **positive** — a refund, refused by name (N7);
 *  4. a debit-interest row, still unmapped (PC-L7);
 *  5. a fee naming no instrument.
 *
 * The format's labels are not spelled here: `pipeline/**` is inside the
 * import-vocabulary gate's containment scan, tests included. The label-level
 * assertions (the exact refusal copy, the note text, the identity an
 * acquisition row reads off the same cells) are in the format module's own
 * `columns.test.ts`.
 *
 * The destination is the portfolio's **second** EUR account, so "routed like a
 * deposit" is a choice between two candidates and not the only account there is.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-0000000f3001",
  userId: "00000000-0000-7000-8000-0000000f3002",
  sessionId: "00000000-0000-7000-8000-0000000f3003",
  portfolioId: "00000000-0000-7000-8000-0000000f3004",
  cashAccountIds: ["00000000-0000-7000-8000-0000000f3005", "00000000-0000-7000-8000-0000000f3006"],
};
const DESTINATION = { portfolioId: IDS.portfolioId, cashAccountId: IDS.cashAccountIds[1]! };
const FIXTURE = "frais-cash-account.csv";

const FEE_ROW = 1;
const REFUND_ROW = 3;
const DEBIT_INTEREST_ROW = 4;

function outcomeAt(plan: ImportPlan, index: number): PlannedRowOutcome {
  const outcome = plan.outcomes[index];
  if (outcome === undefined) throw new Error(`no outcome at index ${String(index)}`);
  return outcome;
}

/** The fee row as `parse`/`validate` built it. */
function feeRow(): NeutralFeeRow {
  const parsed = parsedFixture(FIXTURE, "CASH_ACCOUNT_TRANSACTIONS").rows[FEE_ROW];
  if (parsed === undefined || !parsed.ok || parsed.row.shape !== "FEE") {
    throw new Error("the fee row was expected to parse as a FEE");
  }
  return parsed.row;
}

/**
 * An acquisition in the investment file naming **the fee's own parsed
 * identity** — `columns.test.ts` proves an acquisition row on the same cells
 * reads exactly that identity, so this is the acquisition the fee is compared
 * against, without spelling its label here.
 */
function acquisitionOfTheSameInstrument(): ParseResult {
  const fee = feeRow();
  if (fee.instrumentRef === null) throw new Error("the fee row names an instrument");
  const trade: NeutralTradeRow = {
    shape: "TRADE",
    direction: "ACQUIRE",
    tradeDate: fee.tradeDate,
    tradeTs: fee.tradeTs,
    quantity: new Decimal("1"),
    unitPrice: new Decimal("30.00"),
    currency: "EUR",
    cashCurrency: null,
    fxRateUserInput: null,
    costs: null,
    brokerFee: null,
    tax: null,
    instrumentRef: fee.instrumentRef,
    note: null,
    isCashSideDuplicate: false,
  };
  return {
    fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
    rowCount: 1,
    rows: [{ at: { line: 2, index: 0 }, ok: true, row: trade }],
  };
}

describe("Portfolio Performance fee rows (AC-586)", () => {
  let pg: MigratedPostgres;
  let db: Db;

  const planCashFile = () =>
    planImport(
      parsedFixture(FIXTURE, "CASH_ACCOUNT_TRANSACTIONS"),
      planContext(db, IDS, DESTINATION),
    );
  const planAcquisition = () =>
    planImport(acquisitionOfTheSameInstrument(), planContext(db, IDS, DESTINATION));

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedTenant(pg, IDS);
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("refuses the fee's unknown instrument exactly as it refuses an acquisition of it", async () => {
    const fee = outcomeAt(await planCashFile(), FEE_ROW);
    const trade = outcomeAt(await planAcquisition(), 0);
    if (fee.outcome === "IMPORT" || trade.outcome === "IMPORT") {
      throw new Error("an unknown instrument was expected to refuse both rows");
    }
    expect(fee.reason).toBe("INSTRUMENT_NOT_RESOLVED");
    expect([fee.reason, fee.message]).toEqual([trade.reason, trade.message]);
  });

  it("imports the fee as one FEE on the deposit's account, resolved like an acquisition, and refuses the refund and the debit label", async () => {
    const listing = await createInstrumentByIsin(db, {
      kind: "ETF",
      isin: "IE00B4L5Y983",
      exchangeMic: "XAMS",
      symbol: "IWDA",
      listingCurrency: "EUR",
      displayName: "iShares Core MSCI World UCITS ETF USD (Acc)",
    });

    const trade = outcomeAt(await planAcquisition(), 0);
    if (trade.outcome !== "IMPORT" || trade.write.target !== "TRANSACTION") {
      throw new Error("the acquisition was expected to resolve once the listing exists");
    }
    expect(trade.write.instrumentId).toBe(listing.id);

    const plan = await planCashFile();
    expect(tally(plan.outcomes)).toEqual({
      IMPORT: 4,
      MALFORMED_VALUE: 1,
      UNSUPPORTED_ROW_TYPE: 1,
    });
    const fee = outcomeAt(plan, FEE_ROW);
    if (fee.outcome !== "IMPORT" || fee.write.target !== "TRANSACTION") {
      throw new Error("the fee row was expected to plan a transaction write");
    }
    expect(fee.write.kind).toBe("FEE");
    expect(fee.write.instrumentId).toBe(trade.write.instrumentId);

    const refund = outcomeAt(plan, REFUND_ROW);
    expect(refund.outcome !== "IMPORT" && [refund.reason, refund.message]).toEqual([
      "MALFORMED_VALUE",
      expect.stringContaining("remboursement"),
    ]);
    const debit = outcomeAt(plan, DEBIT_INTEREST_ROW);
    expect(debit.outcome !== "IMPORT" && [debit.reason, debit.message]).toEqual([
      "UNSUPPORTED_ROW_TYPE",
      expect.stringContaining("débiteurs"),
    ]);

    const result = await applyWithGenerousDeadline(
      plan,
      db,
      IDS,
      buildWriteService(db, IDS.tenantId),
      DESTINATION,
    );
    expect(tally(result.outcomes)).toEqual(tally(plan.outcomes));

    const rows = await pg.ownerClient<
      {
        kind: string;
        trade_date: string;
        amount: string;
        currency: string;
        cash_account_id: string;
        instrument_id: string | null;
        note: string | null;
        import_fingerprint: string;
      }[]
    >`
      SELECT kind, trade_date::text, gross_amount::text AS amount, txn_currency AS currency,
             cash_account_id::text,
             instrument_id::text, note, import_fingerprint
      FROM transaction
      WHERE tenant_id = ${IDS.tenantId}::uuid
      ORDER BY trade_date, kind::text
    `;
    // Nothing dated on the refund's day: the refused row wrote nothing.
    expect(rows.map((one) => [one.kind, one.trade_date])).toEqual([
      ["DEPOSIT", "2024-12-02"],
      ["FEE", "2024-12-10"],
      ["WITHDRAWAL", "2024-12-10"],
      ["FEE", "2024-12-31"],
    ]);
    const [deposit, written, withdrawal, bare] = rows;
    expect(written).toMatchObject({
      amount: "3.100000000000",
      currency: "EUR",
      instrument_id: listing.id,
      note: feeRow().note,
    });
    expect(written!.note).toMatch(/ gestion annuels$/);
    // Routed exactly like the same-currency deposit.
    expect(written!.cash_account_id).toBe(deposit!.cash_account_id);
    expect(bare!.cash_account_id).toBe(deposit!.cash_account_id);
    expect(deposit!.cash_account_id).toBe(IDS.cashAccountIds[1]);
    expect(bare).toMatchObject({ amount: "9.000000000000", instrument_id: null });
    // C-8: equal date, amount, currency and account, different kind — two
    // rows, two fingerprints.
    expect(withdrawal).toMatchObject({
      amount: written!.amount,
      currency: written!.currency,
      cash_account_id: written!.cash_account_id,
    });
    expect(withdrawal!.import_fingerprint).not.toBe(written!.import_fingerprint);
  });

  it("re-imports as already imported, writing nothing", async () => {
    const plan = await planCashFile();
    expect(tally(plan.outcomes)).toEqual({
      ALREADY_IMPORTED: 4,
      MALFORMED_VALUE: 1,
      UNSUPPORTED_ROW_TYPE: 1,
    });
    const [written] = await pg.ownerClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM transaction WHERE tenant_id = ${IDS.tenantId}::uuid
    `;
    expect(written?.count).toBe("4");
  });

  it("refuses the fee in the investment file as a row type that file does not carry", async () => {
    const plan = await planImport(
      parsedFixture(FIXTURE, "INVESTMENT_ACCOUNT_TRANSACTIONS"),
      planContext(db, IDS, DESTINATION),
    );
    const fee = outcomeAt(plan, FEE_ROW);
    expect(fee.outcome !== "IMPORT" && fee.reason).toBe("UNSUPPORTED_ROW_TYPE");
  });
});
