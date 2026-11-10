import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planImport } from "../index.js";
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
 * `cash-interest` AC-528: a synthetic
 * cash-account file (`cash-interest.csv`, kept out of the measured corpus so
 * its per-label counts stay pinned) carrying one deposit, three interest
 * credits (plain 12,34; with a 3,00 tax; with a fee) and one debit-interest
 * row. The format's labels are not spelled here: `pipeline/**` is inside the
 * import-vocabulary gate's containment scan, tests included.
 *
 * The destination is the portfolio's **second** EUR account, so "routed like a
 * deposit" is a choice between two candidates and not the only account there is.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-0000000f2001",
  userId: "00000000-0000-7000-8000-0000000f2002",
  sessionId: "00000000-0000-7000-8000-0000000f2003",
  portfolioId: "00000000-0000-7000-8000-0000000f2004",
  cashAccountIds: ["00000000-0000-7000-8000-0000000f2005", "00000000-0000-7000-8000-0000000f2006"],
};
const DESTINATION = { portfolioId: IDS.portfolioId, cashAccountId: IDS.cashAccountIds[1]! };

describe("Portfolio Performance interest rows (AC-528)", () => {
  let pg: MigratedPostgres;
  let db: Db;

  const importOnce = async () => {
    const parsed = parsedFixture("cash-interest.csv", "CASH_ACCOUNT_TRANSACTIONS");
    const plan = await planImport(parsed, planContext(db, IDS, DESTINATION));
    const result = await applyWithGenerousDeadline(
      plan,
      db,
      IDS,
      buildWriteService(db, IDS.tenantId),
      DESTINATION,
    );
    return { plan, result };
  };

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedTenant(pg, IDS);
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("imports interest as INTEREST on the deposit's account, keeps the tax, refuses the fee and the debit label", async () => {
    const { plan, result } = await importOnce();

    // Dry run and confirm agree, row for row.
    expect(tally(plan.outcomes)).toEqual({
      IMPORT: 3,
      UNSUPPORTED_ROW_TYPE: 1,
      UNSUPPORTED_LEG: 1,
    });
    expect(tally(result.outcomes)).toEqual(tally(plan.outcomes));

    // The dry-run rows are INTEREST writes — the shape the review screen labels.
    const planned = plan.outcomes.flatMap((one) =>
      one.outcome === "IMPORT" && one.write.target === "TRANSACTION" ? [one.write.kind] : [],
    );
    expect(planned).toEqual(["DEPOSIT", "INTEREST", "INTEREST"]);

    const debit = plan.outcomes.find(
      (one) => one.outcome === "REJECT" && one.reason === "UNSUPPORTED_ROW_TYPE",
    );
    expect(debit !== undefined && debit.outcome === "REJECT" && debit.message).toContain(
      "débiteurs",
    );

    const rows = await pg.ownerClient<
      {
        kind: string;
        trade_date: string;
        amount: string;
        cash_account_id: string;
        instrument_id: string | null;
        withholding_amount: string | null;
      }[]
    >`
      SELECT kind, trade_date::text, gross_amount::text AS amount, cash_account_id::text,
             instrument_id::text, withholding_amount::text
      FROM transaction
      WHERE tenant_id = ${IDS.tenantId}::uuid
      ORDER BY trade_date
    `;
    expect(rows.map((one) => [one.kind, one.trade_date])).toEqual([
      ["DEPOSIT", "2026-01-05"],
      ["INTEREST", "2026-01-31"],
      ["INTEREST", "2026-02-28"],
    ]);
    const [deposit, interest, taxed] = rows;
    // Routed exactly like the same-currency deposit.
    expect(interest!.cash_account_id).toBe(deposit!.cash_account_id);
    expect(interest!.cash_account_id).toBe(IDS.cashAccountIds[1]);
    expect(interest!.amount).toBe("12.340000000000");
    expect(interest!.instrument_id).toBeNull();
    expect(interest!.withholding_amount).toBeNull();
    // The credited 20 is the net; the gross adds the 3 withheld.
    expect(taxed!.amount).toBe("23.000000000000");
    expect(taxed!.withholding_amount).toBe("3.000000000000");
  });

  it("re-imports as already imported, writing nothing", async () => {
    const { plan, result } = await importOnce();

    expect(tally(plan.outcomes)).toEqual({
      ALREADY_IMPORTED: 3,
      UNSUPPORTED_ROW_TYPE: 1,
      UNSUPPORTED_LEG: 1,
    });
    expect(tally(result.outcomes)).toEqual(tally(plan.outcomes));
    const [written] = await pg.ownerClient<{ count: string }[]>`
      SELECT count(*)::text AS count FROM transaction WHERE tenant_id = ${IDS.tenantId}::uuid
    `;
    expect(written?.count).toBe("3");
  });
});
