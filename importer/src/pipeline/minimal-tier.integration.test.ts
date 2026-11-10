import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KERDIAL_COLUMNS } from "../formats/kerdial-csv/columns.js";
import { planImport } from "./plan.js";
import {
  applyKerdial,
  buildKerdialWriteService,
  kerdialPlanContext,
  kerdialTally,
  parseKerdialBytes,
  seedBareTenant,
  type KerdialIds,
} from "./__tests__/kerdial-harness.js";

/**
 * EI-17 / AC-438 — the spreadsheet-minimal round trip
 * (FR-544/FR-546, L14; the two
 * tiers).
 *
 * `__fixtures__/kerdial-csv/minimal-tier.csv` is a **hand-authored** file whose
 * header carries the required minimal column set and nothing else: no cost
 * column, no currency-conversion column, no reinvestment reference, no
 * settlement column, no carried fingerprint. It is a Buy/Sell/Deposit/
 * Withdrawal/Dividend-only history, which is what L14's minimal tier is for —
 * the user who reshapes a spreadsheet by hand rather than exporting one.
 *
 * **This exact file is the worked example `docs/import-export-format.md`
 * section 4 renders for FR-546**, not a separately maintained illustration of
 * it. A change to the fixture is a change to the document, and
 * `formats/kerdial-csv/columns.doc.test.ts` compares the two line by line — so
 * editing one of them alone is a red test rather than a documentation drift
 * nobody notices.
 *
 * ## Known answers, not re-derivations
 *
 * Every figure asserted below is computed by hand from the fixture's own rows
 * and pinned as a literal, with the row it comes from named in a comment. The
 * discipline is deliberate: an expectation derived by running the
 * implementation is an expectation that agrees with any bug the implementation
 * has.
 *
 *     row 1  2026-01-05  DEPOSIT              + 10 000,00
 *     row 2  2026-01-06  BUY  alpha 10 @ 100  −  1 000,00
 *     row 3  2026-01-07  BUY  alpha 10 @ 120  −  1 200,00
 *     row 4  2026-02-10  DIVIDEND alpha       +     45,00
 *     row 5  2026-03-11  SELL alpha  5 @ 130  +    650,00
 *     row 6  2026-03-12  BUY  beta   4 @ 250  −  1 000,00
 *     row 7  2026-04-01  WITHDRAWAL           −    500,00
 *                                             ─────────────
 *     cash                                       6 995,00
 *
 *     alpha  20 bought for 1 000,00 + 1 200,00 = 2 200,00 ⇒ 110,00 per unit
 *            5 sold at the weighted average ⇒ 15 left, costing 15 × 110,00
 *                                                          = 1 650,00
 *     beta    4 bought for 1 000,00 ⇒ 250,00 per unit
 *
 * The sale's *proceeds* (650,00) are cash, not cost: the 5 units leave at the
 * weighted-average unit cost, which is why alpha's remaining cost basis is a
 * multiple of 110,00 and not of any price the file states.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "__fixtures__", "kerdial-csv", "minimal-tier.csv");

const IDS: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-00000000e301",
  userId: "00000000-0000-7000-8000-00000000e302",
  sessionId: "00000000-0000-7000-8000-00000000e303",
};

/** The fixture's two instruments. A transactions file states no kind and no listing currency, so the catalogue supplies both. */
const ALPHA = "FRKERDEI7001";
const BETA = "FRKERDEI7002";
const MIC = "XPAR";

const PORTFOLIO_NAME = "Portefeuille";
const ACCOUNT_NAME = "Compte principal";

describe("AC-438 — the spreadsheet-minimal column set, imported into an empty tenant", () => {
  let pg: MigratedPostgres;
  let db: Db;
  let bytes: Uint8Array;

  beforeAll(async () => {
    bytes = new Uint8Array(readFileSync(FIXTURE));
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedBareTenant(pg, IDS);
    // The instrument catalogue is shared reference data, not tenant data, so
    // seeding it leaves the *tenant* empty — which is what AC-438 asks for. It
    // has to be seeded: a transactions row carries no kind and no listing
    // currency, so this file genuinely cannot create an instrument. (The
    // claim about a CSV alone creating its instruments does not hold
    // for a transactions file.)
    for (const isin of [ALPHA, BETA]) {
      await createInstrumentByIsin(db, {
        kind: "SHARE",
        isin,
        exchangeMic: MIC,
        listingCurrency: "EUR",
        displayName: `minimal-tier ${isin}`,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("carries exactly the required minimal columns in its header, and no optional one", () => {
    const header = new TextDecoder()
      .decode(bytes)
      .split("\u000D\u000A")
      // The version marker is a comment line, not a column.
      .filter((line) => !line.startsWith("#"))[0];
    const columns = (header ?? "").split(",");
    const required = KERDIAL_COLUMNS.filter(
      (column) => column.tier === "R" || column.tier === "R*",
    ).map((column) => column.name);
    const optional: readonly string[] = KERDIAL_COLUMNS.filter((column) => column.tier === "X").map(
      (column) => column.name,
    );

    expect([...columns].sort()).toStrictEqual([...required].sort());
    // Stated as an absence too, because "the sets are equal" and "no optional
    // name appears" fail differently when the column table itself moves.
    expect(columns.filter((name) => optional.includes(name))).toStrictEqual([]);
  });

  it("imports every row and leaves the hand-computed holdings and cash balance", async () => {
    const plan = await planImport(parseKerdialBytes(bytes), kerdialPlanContext(db, IDS.tenantId));
    expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 7 });
    // The portfolio and the account are both created by this import — the
    // tenant held neither (FR-556/AC-448, the reason this file needs no
    // catalogue package beside it).
    expect(plan.directory.portfolios.map((one) => one.name)).toStrictEqual([PORTFOLIO_NAME]);
    expect(plan.directory.cashAccounts.map((one) => one.name)).toStrictEqual([ACCOUNT_NAME]);

    const harness = buildKerdialWriteService(db, IDS.tenantId);
    const result = await applyKerdial(plan, db, IDS, harness.writes);
    expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 7 });
    expect(result.applyFailed).toBe(0);

    const balances = await pg.ownerClient<{ amount: string }[]>`
      SELECT cb.amount::text AS amount FROM "cash_balance" cb
      JOIN "cash_account" ca ON ca.id = cb.cash_account_id
      JOIN "portfolio" p ON p.id = ca.portfolio_id
      WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = ${PORTFOLIO_NAME}
        AND ca.name = ${ACCOUNT_NAME}
    `;
    expect(balances).toHaveLength(1);
    // Rows 1–7, summed by hand in this file's header.
    expect(new Decimal(balances[0]!.amount).toFixed(2)).toBe("6995.00");

    const holdings = await pg.ownerClient<
      { isin: string; quantity: string; cost_basis_base: string; pmp_unit_base: string }[]
    >`
      SELECT i.isin, hs.quantity::text AS quantity,
             hs.cost_basis_base::text AS cost_basis_base,
             hs.pmp_unit_base::text AS pmp_unit_base
      FROM "holding_state" hs
      JOIN "instrument" i ON i.id = hs.instrument_id
      JOIN "portfolio" p ON p.id = hs.portfolio_id
      WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = ${PORTFOLIO_NAME}
      ORDER BY i.isin
    `;
    expect(holdings.map((row) => row.isin)).toStrictEqual([ALPHA, BETA]);

    // alpha — rows 2, 3 and 5. 20 units for 2 200,00 is 110,00 each; 5 leave at
    // that weighted average, so 15 remain at 15 x 110,00 = 1 650,00.
    expect(new Decimal(holdings[0]!.quantity).toFixed(2)).toBe("15.00");
    expect(new Decimal(holdings[0]!.cost_basis_base).toFixed(2)).toBe("1650.00");
    expect(new Decimal(holdings[0]!.pmp_unit_base).toFixed(2)).toBe("110.00");

    // beta — row 6 alone. 4 units for 1 000,00 is 250,00 each.
    expect(new Decimal(holdings[1]!.quantity).toFixed(2)).toBe("4.00");
    expect(new Decimal(holdings[1]!.cost_basis_base).toFixed(2)).toBe("1000.00");
    expect(new Decimal(holdings[1]!.pmp_unit_base).toFixed(2)).toBe("250.00");
  });
});
