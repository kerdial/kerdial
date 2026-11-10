import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planImport, type PlannedRowOutcome } from "./plan.js";
import {
  acquisitionRow,
  cashInRow,
  feeRow,
  kerdialPlanContext,
  parseKerdial,
  seedBareTenant,
  type KerdialIds,
  type RowSite,
} from "./__tests__/kerdial-harness.js";

/**
 * GATE-FINAL tester section 8: a Kerdial file whose FEE names
 * an identifier no instrument has is refused with the same reason AND message
 * as an acquisition naming the same identity (PC-L14, FR-692).
 */

const IDS: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-00000b855101",
  userId: "00000000-0000-7000-8000-00000b855102",
  sessionId: "00000000-0000-7000-8000-00000b855103",
};
const PORTFOLIO = "00000000-0000-7000-8000-00000b855104";
const ACCOUNT = "00000000-0000-7000-8000-00000b855105";
const site = (date: string): RowSite => ({
  portfolio: "GF portfolio",
  account: "GF account",
  date,
});
const UNKNOWN = { isin: "FRGATEFNL001", exchangeMic: "XPAR" };

function refusal(outcome: PlannedRowOutcome): { reason: string; message: string } {
  if (outcome.outcome === "IMPORT") throw new Error("expected a refusal, got an import");
  return { reason: outcome.reason, message: outcome.message };
}

describe("planImport — a FEE naming an unknown instrument (GATE-FINAL)", () => {
  let pg: MigratedPostgres;
  let db: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedBareTenant(pg, IDS);
    await pg.ownerClient`INSERT INTO "portfolio" (id, tenant_id, name) VALUES (${PORTFOLIO}::uuid, ${IDS.tenantId}::uuid, 'GF portfolio')`;
    await pg.ownerClient`INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency) VALUES (${ACCOUNT}::uuid, ${IDS.tenantId}::uuid, ${PORTFOLIO}::uuid, 'GF account', 'EUR')`;
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("refuses the FEE with the very reason and message an acquisition of the same identity gets", async () => {
    const plan = await planImport(
      parseKerdial([
        cashInRow(site("2026-02-02"), "1000.00"),
        feeRow(site("2026-02-04"), "3.10", UNKNOWN),
        acquisitionRow(site("2026-02-04"), UNKNOWN, "3", "100.50"),
      ]),
      kerdialPlanContext(db, IDS.tenantId),
    );
    expect(plan.outcomes[0]?.outcome).toBe("IMPORT");
    expect(plan.outcomes[1]?.outcome).not.toBe("IMPORT");
    const fee = refusal(plan.outcomes[1]!);
    const buy = refusal(plan.outcomes[2]!);
    expect(fee.reason).toBe("INSTRUMENT_NOT_RESOLVED");
    expect(fee).toEqual(buy);
  });
});
