import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin, INITIAL_CASH_ACCOUNT_NAME } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnyImportFileType, AnyNeutralRow, ParseResult } from "../types.js";
import { planImport, type ImportPlan } from "./plan.js";
import type { ImportResult } from "./apply.js";
import {
  acquisitionRow,
  applyKerdial,
  buildKerdialWriteService,
  cashInRow,
  distributionRow,
  exchangeRow,
  interestRow,
  kerdialPlanContext,
  kerdialTally,
  parseKerdial,
  recordingBatches,
  reinvestmentRow,
  seedBareTenant,
  shareGrantRow,
  type Cells,
  type KerdialIds,
  type RowInstrument,
  type RowSite,
  type WriteServiceHarness,
} from "./__tests__/kerdial-harness.js";

/**
 * EI-15 and EI-16 — `applyImport`'s per-row portfolio, portfolio-bounded
 * chunks, reinvestment pass 2 and the carried-forward fingerprint channel
 * (`portfolio-export-import` KD8, KD9;
 * FR-540–FR-542, FR-557, AC-448's apply half).
 *
 * ## The branch built, and the verdict that chose it
 *
 * GATE-0b recorded, verbatim:
 *
 * > *0/5 disagreed — do NOT add `targetAmount?` to
 * > `RecordCurrencyExchangeParams`; write from `exchange_rate` (18 dp) and
 * > verify against `target_amount`, rejecting
 * > `CURRENCY_EXCHANGE_RATE_INCONSISTENT`. The verdict is conditional on the CSV
 * > rate column staying ≥ 18 dp.*
 *
 * So `recordCurrencyExchange` is called with the **rate** and no target figure,
 * and the file's stated target is verified rather than written. The
 * verification itself is A2's, in `validate`, where the rule for a
 * cell-level disagreement puts it — see `IMPORT_REJECT_REASONS`'s own entry for
 * `CURRENCY_EXCHANGE_RATE_INCONSISTENT` on why this stage does not repeat it,
 * and the suite below for the measurement that the disagreement is caught.
 */

const IDS: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-00000000e201",
  userId: "00000000-0000-7000-8000-00000000e202",
  sessionId: "00000000-0000-7000-8000-00000000e203",
};

const ISIN = "FRKERDEI5001";
const MIC = "XPAR";
/** A second instrument, so "one backfill call per **distinct** instrument" has two subjects. */
const OTHER_ISIN = "FRKERDEI5002";
/** Two more, referenced by nothing else in this file, so FR-557's count starts from zero for them. */
const BACKFILL_ISINS = ["FRKERDEI5003", "FRKERDEI5004"] as const;

const at = (portfolio: string, account: string, date: string): RowSite => ({
  portfolio,
  account,
  date,
});

const listed = (isin: string): RowInstrument => ({ isin, exchangeMic: MIC });

function deposit(portfolio: string, account: string, date: string, amount: string): Cells {
  return cashInRow(at(portfolio, account, date), amount);
}

function buy(portfolio: string, account: string, date: string, isin = ISIN): Cells {
  return acquisitionRow(at(portfolio, account, date), listed(isin), "2", "50.00");
}

interface Applied {
  readonly plan: ImportPlan;
  readonly result: ImportResult;
}

describe("applyImport over a Kerdial transactions file (EI-15, EI-16)", () => {
  let pg: MigratedPostgres;
  let db: Db;
  let harness: WriteServiceHarness;

  const run = async (rows: readonly Cells[]): Promise<Applied> => {
    const plan = await planImport(parseKerdial(rows), kerdialPlanContext(db, IDS.tenantId));
    const result = await applyKerdial(plan, db, IDS, harness.writes);
    return { plan, result };
  };

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedBareTenant(pg, IDS);
    harness = buildKerdialWriteService(db, IDS.tenantId);
    for (const isin of [ISIN, OTHER_ISIN, ...BACKFILL_ISINS]) {
      await createInstrumentByIsin(db, {
        kind: "SHARE",
        isin,
        exchangeMic: MIC,
        listingCurrency: "EUR",
        displayName: `subject ${isin}`,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  describe("AC-448's apply half — a CSV imported alone creates what it names (FR-556/FR-532/FR-533)", () => {
    it("creates the portfolio and the account, then writes every row against them", async () => {
      const { plan, result } = await run([
        deposit("AC448 portfolio", "AC448 account", "2026-04-02", "1000.00"),
        buy("AC448 portfolio", "AC448 account", "2026-04-03"),
      ]);

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 2 });
      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 2 });
      expect(result.applyFailed).toBe(0);

      // Asserted by direct query, not by trusting the response summary — the
      // summary is what a partially-applied run would still report happily.
      const portfolios = await pg.ownerClient<
        {
          id: string;
          broker: string | null;
          description: string | null;
          accent_color: string | null;
        }[]
      >`
        SELECT id, broker, description, accent_color FROM "portfolio"
        WHERE tenant_id = ${IDS.tenantId}::uuid AND name = 'AC448 portfolio'
      `;
      expect(portfolios).toHaveLength(1);
      // Bare: nothing but the name. A catalogue package is what fills these in.
      expect(portfolios[0]?.broker).toBeNull();
      expect(portfolios[0]?.description).toBeNull();
      expect(portfolios[0]?.accent_color).toBeNull();

      // **Exactly one** account, the one the file named. `createPortfolio`
      // would open an `INITIAL_CASH_ACCOUNT_NAME` account of its own, and this
      // run tells it not to because its own directory creates the portfolio's
      // accounts (see `createDirectory`'s own header) — so a
      // restore reproduces the source's accounts rather than the source's
      // accounts plus one.
      const accounts = await pg.ownerClient<{ id: string; name: string; currency: string }[]>`
        SELECT id, name, currency FROM "cash_account"
        WHERE tenant_id = ${IDS.tenantId}::uuid AND portfolio_id = ${portfolios[0]!.id}::uuid
        ORDER BY name
      `;
      expect(accounts).toHaveLength(1);
      const named = accounts.find((account) => account.name === "AC448 account");
      expect(named?.currency).toBe("EUR");

      const written = await pg.ownerClient<{ kind: string; cash_account_id: string | null }[]>`
        SELECT kind, cash_account_id FROM "transaction"
        WHERE portfolio_id = ${portfolios[0]!.id}::uuid ORDER BY seq
      `;
      expect(written.map((row) => row.kind)).toStrictEqual(["DEPOSIT", "BUY"]);
      expect(new Set(written.map((row) => row.cash_account_id))).toStrictEqual(
        new Set([named!.id]),
      );
    });

    it("refuses the row whose account currency disagrees and still writes every other row", async () => {
      const { result } = await run([
        deposit("AC448b portfolio", "AC448b account", "2026-04-02", "500.00"),
        cashInRow(
          { ...at("AC448b portfolio", "AC448b account", "2026-04-03"), currency: "USD" },
          "500.00",
        ),
        deposit("AC448b portfolio", "AC448b account", "2026-04-04", "500.00"),
      ]);

      expect(kerdialTally(result.outcomes)).toEqual({
        IMPORT: 2,
        CASH_ACCOUNT_CURRENCY_MISMATCH: 1,
      });
      const accounts = await pg.ownerClient<{ currency: string }[]>`
        SELECT ca.currency FROM "cash_account" ca
        JOIN "portfolio" p ON p.id = ca.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'AC448b portfolio'
          AND ca.name = 'AC448b account'
      `;
      // One account under that name, still EUR: the disagreeing row created no
      // second account and changed no currency.
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.currency).toBe("EUR");
    });
  });

  describe("F-A (EI-39) — a row older than the backfill floor is one refused row, with a message that says why", () => {
    it("refuses only that row, names the floor, and states the row is not corrupt", async () => {
      // The restoring user's case: a file written years ago, whose oldest rows
      // have since fallen past `now - BACKFILL_FLOOR_YEARS`. The date below is
      // decades old, so this fixture does not go stale as the floor moves with
      // the calendar — which is F-A's own subject.
      const { result } = await run([
        deposit("F-A portfolio", "f-a cash", "1995-01-02", "100.00"),
        deposit("F-A portfolio", "f-a cash", "2026-04-02", "100.00"),
      ]);

      // **Per-row, not per-file** — the half that is measured rather than
      // assumed: the second row is written.
      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 1, APPLY_FAILED: 1 });

      const refused = result.outcomes.find((outcome) => outcome.outcome === "REJECT");
      expect(refused?.errorName).toBe("TradeDateTooOldError");
      // The floor, by its year count and by the date it resolves to today, and
      // the clause the ledger's own message cannot carry.
      expect(refused?.message).toContain("25-year backfill floor");
      expect(refused?.message).toContain("This row is not corrupt");

      const written = await pg.ownerClient<{ trade_date: string }[]>`
        SELECT t.trade_date::text AS trade_date FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'F-A portfolio'
      `;
      expect(written.map((row) => row.trade_date)).toStrictEqual(["2026-04-02"]);
    });
  });

  describe("the initial account `createPortfolio` opens, and the collision it used to cause", () => {
    it("creates the account whose name the initial one would have taken, and writes its rows against it", async () => {
      // This case was pinned red by Batch B1 and is turned green by
      // the repair: `createDirectory` passes
      // `initialCashAccount: false` for a portfolio it also creates accounts
      // for, so the file's own account — carrying the name the product would
      // have auto-created — is the one that exists, with the id its rows'
      // `kd1` fingerprints were computed over.
      const collidingName = INITIAL_CASH_ACCOUNT_NAME;
      const { result } = await run([
        deposit("Collision portfolio", collidingName, "2026-04-10", "100.00"),
        deposit("Collision portfolio", "a name of its own", "2026-04-11", "100.00"),
      ]);

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 2 });

      // **Two** accounts, not three: the suppressed initial one is not sitting
      // beside a duplicate of itself under a mangled name.
      const accounts = await pg.ownerClient<{ name: string }[]>`
        SELECT ca.name FROM "cash_account" ca
        JOIN "portfolio" p ON p.id = ca.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'Collision portfolio'
        ORDER BY ca.name
      `;
      expect(accounts.map((row) => row.name).sort()).toStrictEqual(
        [collidingName, "a name of its own"].sort(),
      );

      // Each row against the account it named — the property the collision
      // destroyed, asserted by direct query rather than from the outcome codes.
      const written = await pg.ownerClient<{ name: string; amount: string }[]>`
        SELECT ca.name, t.gross_amount::text AS amount FROM "transaction" t
        JOIN "cash_account" ca ON ca.id = t.cash_account_id
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'Collision portfolio'
        ORDER BY t.trade_date
      `;
      expect(written.map((row) => row.name)).toStrictEqual([collidingName, "a name of its own"]);
    });

    it("still opens the initial account for a portfolio the file names no account for", async () => {
      // The opt-out's own bound: CA-25 exists so a fresh portfolio can receive
      // its first transaction, and a file that creates a portfolio without
      // naming any account for it must not leave one with none. A
      // `SHARE_DISTRIBUTION` is the row that names no cash account.
      const plan = await planImport(
        parseKerdial([
          shareGrantRow(
            { portfolio: "No-account portfolio", date: "2026-04-12" },
            listed(ISIN),
            "3",
            "1.00",
          ),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );
      const result = await applyKerdial(plan, db, IDS, harness.writes);
      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 1 });

      const accounts = await pg.ownerClient<{ name: string }[]>`
        SELECT ca.name FROM "cash_account" ca
        JOIN "portfolio" p ON p.id = ca.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'No-account portfolio'
      `;
      expect(accounts.map((row) => row.name)).toStrictEqual([INITIAL_CASH_ACCOUNT_NAME]);
    });
  });

  describe("KD9 — a chunk's lock set is exactly one portfolio", () => {
    it("opens one write batch per portfolio, never one spanning two", async () => {
      const rows: Cells[] = [
        deposit("KD9 alpha", "alpha cash", "2026-05-02", "100.00"),
        deposit("KD9 beta", "beta cash", "2026-05-03", "100.00"),
        deposit("KD9 alpha", "alpha cash", "2026-05-04", "100.00"),
        deposit("KD9 beta", "beta cash", "2026-05-05", "100.00"),
      ];
      const plan = await planImport(parseKerdial(rows), kerdialPlanContext(db, IDS.tenantId));
      // A chunk size well above the row count, so the **only** thing that can
      // end a chunk is the portfolio boundary. With a size of 4 and no
      // boundary rule, all four rows would share one batch.
      const recording = recordingBatches(harness.writes);
      const result = await applyKerdial(plan, db, IDS, recording.writes, { chunkRows: 10 });

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 4 });
      expect(recording.batches).toHaveLength(2);
      for (const batch of recording.batches) {
        expect(batch).toHaveLength(1);
      }
      expect(new Set(recording.batches.flat()).size).toBe(2);
    });
  });

  describe("the reinvestment link, and the skip case a naive implementation gets wrong", () => {
    const LABEL = "d1";
    const pair = (portfolio: string): Cells[] => [
      distributionRow(at(portfolio, "drip cash", "2026-06-02"), listed(ISIN), "40.00", LABEL),
      reinvestmentRow(
        at(portfolio, "drip cash", "2026-06-03"),
        listed(ISIN),
        "0.8",
        "50.00",
        LABEL,
      ),
    ];

    it("writes the reinvestment against the distribution this run wrote", async () => {
      const { result } = await run(pair("DRIP portfolio"));

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 2 });
      const rows = await pg.ownerClient<
        { id: string; kind: string; source_dividend_id: string | null }[]
      >`
        SELECT t.id, t.kind, t.source_dividend_id FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'DRIP portfolio'
        ORDER BY t.seq
      `;
      expect(rows.map((row) => row.kind)).toStrictEqual(["DIVIDEND", "DRIP"]);
      expect(rows[1]?.source_dividend_id).toBe(rows[0]?.id);
    });

    it("skips the reinvestment too when its distribution is already imported", async () => {
      const rows = pair("DRIP reimport portfolio");
      const first = await run(rows);
      expect(kerdialTally(first.result.outcomes)).toEqual({ IMPORT: 2 });

      const second = await run(rows);
      // The whole point: the reinvestment is ALREADY_IMPORTED, **not**
      // DRIP_SOURCE_NOT_RESOLVED. A pass 2 that only looked at ids written in
      // *this* run would have had nothing for it and refused it.
      expect(kerdialTally(second.result.outcomes)).toEqual({ ALREADY_IMPORTED: 2 });

      const written = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'DRIP reimport portfolio'
      `;
      expect(written[0]?.count).toBe("2");
    });
  });

  describe("GATE-0b — the exchange is written from the rate, and a disagreeing target figure is refused", () => {
    const exchange = (portfolio: string, statedTarget: string): Cells =>
      exchangeRow(at(portfolio, "eur cash", "2026-07-02"), "100.00", {
        currency: "USD",
        account: "usd cash",
        rate: "1.100000000000000000",
        statedTarget,
      });

    it("stores the derived target amount, and the ledger derived it from the rate", async () => {
      const { result } = await run([
        deposit("FX portfolio", "eur cash", "2026-07-01", "1000.00"),
        exchange("FX portfolio", "110.00"),
      ]);

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 2 });
      const rows = await pg.ownerClient<{ target_amount: string; target_currency: string }[]>`
        SELECT t.target_amount::text AS target_amount, t.target_currency
        FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = 'FX portfolio'
          AND t.kind = 'CURRENCY_EXCHANGE'
      `;
      expect(rows).toHaveLength(1);
      expect(new Decimal(rows[0]!.target_amount).toFixed(2)).toBe("110.00");
      expect(rows[0]?.target_currency).toBe("USD");
      // There is no stored rate column on `transaction` — the exchange's rate
      // lives only in the pair of amounts (confirmed
      // against `platform/db/src/schema/transaction.ts`, which has
      // `target_currency` and `target_amount` and nothing else for this kind).
      // 100.00 x 1.1 = 110.00 is therefore the whole observable statement that
      // the rate was the write input.
    });

    it("refuses a target figure that disagrees with the rate, writing nothing for that row", async () => {
      // **Recorded deviation from EI-15's acceptance criterion, measured.** The
      // criterion asks for this rejection to carry
      // `CURRENCY_EXCHANGE_RATE_INCONSISTENT` at the plan stage. A2 had already
      // put the check in `validate` — where the rule for a
      // cell-level disagreement puts it — so the row never reaches `plan` and
      // the code it carries is `MALFORMED_VALUE` naming the cell and the rule.
      // The property the criterion is about (a disagreeing figure is refused,
      // and no row is written from it) holds; the stage and the code differ,
      // and doubling the check to produce the second code would give one rule
      // two owners.
      const parsed = parseKerdial([exchange("FX refusal portfolio", "999.00")]);
      const row = parsed.rows[0];
      if (row === undefined || row.ok)
        throw new Error("the disagreeing row was expected to be refused");
      expect(row.problem.code).toBe("MALFORMED_VALUE");
      expect(row.problem.message).toMatch(/stated target amount/u);

      const plan = await planImport(parsed, kerdialPlanContext(db, IDS.tenantId));
      const result = await applyKerdial(plan, db, IDS, harness.writes);
      expect(kerdialTally(result.outcomes)).toEqual({ MALFORMED_VALUE: 1 });
      const written = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "portfolio"
        WHERE tenant_id = ${IDS.tenantId}::uuid AND name = 'FX refusal portfolio'
      `;
      // Nothing was created for a file whose only row was refused, which is
      // what `directoryActuallyUsed` is for.
      expect(written[0]?.count).toBe("0");
    });
  });

  describe("FR-557 — the CSV path enrols instruments through the shipped trigger, with no new wiring", () => {
    it("reaches the enrolment path exactly once per distinct instrument the rows reference", async () => {
      const before = harness.backfillCalls.length;
      const { result } = await run([
        deposit("FR557 portfolio", "fr557 cash", "2026-08-02", "1000.00"),
        buy("FR557 portfolio", "fr557 cash", "2026-08-03", BACKFILL_ISINS[0]),
        buy("FR557 portfolio", "fr557 cash", "2026-08-04", BACKFILL_ISINS[0]),
        buy("FR557 portfolio", "fr557 cash", "2026-08-05", BACKFILL_ISINS[1]),
      ]);

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 4 });
      const calls = harness.backfillCalls.slice(before);
      // Two distinct instruments referenced by three trades; the cash movement
      // references none. One call each — the trigger's own
      // `onConflictDoNothing` on `instrument_backfill_state` is what collapses
      // the repeat, which is exactly the shipped behaviour FR-557 says needs no
      // new wiring on this path.
      expect(new Set(calls).size).toBe(2);
      expect(calls).toHaveLength(2);
    });
  });

  describe("KD8 — the carried-forward fingerprint, one fixture per branch", () => {
    /** A well-formed value under another recipe's prefix — what an export out of another tenant carries. */
    const CARRIED = `pp2:${"a1b2c3d4".repeat(8)}`;
    const OTHER_CARRIED = `pp2:${"beef0123".repeat(8)}`;

    const storedFingerprints = async (portfolio: string): Promise<string[]> => {
      const rows = await pg.ownerClient<{ import_fingerprint: string | null }[]>`
        SELECT t.import_fingerprint FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = ${portfolio}
        ORDER BY t.seq
      `;
      return rows.map((row) => row.import_fingerprint ?? "");
    };

    it("(c) a row carrying nothing is fingerprinted under this format's own recipe", async () => {
      const { result } = await run([deposit("KD8 c", "kd8 cash", "2026-09-02", "10.00")]);

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 1 });
      const stored = await storedFingerprints("KD8 c");
      expect(stored).toHaveLength(1);
      expect(stored[0]?.startsWith("kd1:")).toBe(true);
    });

    it("(b) a carried value that matches nothing is stored verbatim, not re-fingerprinted", async () => {
      const { result } = await run([
        cashInRow(
          { ...at("KD8 b", "kd8 cash", "2026-09-02"), carriedFingerprint: CARRIED },
          "10.00",
        ),
      ]);

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 1 });
      // KD8's whole point: re-fingerprinting here would move the stored value
      // on every export/import cycle, which is what makes the *second* round
      // trip non-idempotent.
      expect(await storedFingerprints("KD8 b")).toStrictEqual([CARRIED]);
    });

    it("(a) a carried value that matches an existing row skips it, whatever the row's own figures say", async () => {
      const first = await run([
        cashInRow(
          { ...at("KD8 a", "kd8 cash", "2026-09-02"), carriedFingerprint: CARRIED },
          "10.00",
        ),
      ]);
      expect(kerdialTally(first.result.outcomes)).toEqual({ IMPORT: 1 });

      // A **different** amount on a different date, carrying the same value:
      // the carried channel is checked before any figure is hashed, so the
      // match is on the carried value alone.
      const second = await run([
        cashInRow(
          { ...at("KD8 a", "kd8 cash", "2026-09-05"), carriedFingerprint: CARRIED },
          "77.00",
        ),
      ]);
      expect(kerdialTally(second.result.outcomes)).toEqual({ ALREADY_IMPORTED: 1 });
      expect(await storedFingerprints("KD8 a")).toStrictEqual([CARRIED]);
    });

    it("stays idempotent over two whole cycles, with the original value still stored", async () => {
      const rows: Cells[] = [
        {
          ...deposit("KD8 cycles", "kd8 cash", "2026-09-02", "10.00"),
          import_fingerprint: CARRIED,
        },
        {
          ...deposit("KD8 cycles", "kd8 cash", "2026-09-03", "20.00"),
          import_fingerprint: OTHER_CARRIED,
        },
        deposit("KD8 cycles", "kd8 cash", "2026-09-04", "30.00"),
      ];

      const first = await run(rows);
      expect(kerdialTally(first.result.outcomes)).toEqual({ IMPORT: 3 });
      const afterFirst = await storedFingerprints("KD8 cycles");

      const second = await run(rows);
      expect(kerdialTally(second.result.outcomes)).toEqual({ ALREADY_IMPORTED: 3 });
      const third = await run(rows);
      expect(kerdialTally(third.result.outcomes)).toEqual({ ALREADY_IMPORTED: 3 });

      // Zero duplicates two cycles later, and the carried values are the
      // *original* ones — not a `kd1:` value that crept in on a later cycle.
      const afterThird = await storedFingerprints("KD8 cycles");
      expect(afterThird).toStrictEqual(afterFirst);
      expect(afterThird.slice(0, 2)).toStrictEqual([CARRIED, OTHER_CARRIED]);
      expect(afterThird[2]?.startsWith("kd1:")).toBe(true);
    });

    it("refuses a forged value at plan time, so the database never sees it", async () => {
      // The format module refuses it while mapping the cell, which is the
      // earlier and better-messaged of the two checks.
      const parsed = parseKerdial([
        cashInRow(
          {
            ...at("KD8 forged", "kd8 cash", "2026-09-02"),
            carriedFingerprint: "pp2-missing-the-colon",
          },
          "10.00",
        ),
      ]);
      expect(parsed.rows[0]?.ok).toBe(false);

      // And `plan` refuses it too, which is not redundant: `planImport` takes a
      // `ParseResult`, and it cannot assume some other implementation's
      // `validate` enforced anything. Reached here through a hand-built result,
      // because the shipped format cannot produce one.
      const forged: ParseResult<AnyNeutralRow, AnyImportFileType> = {
        fileType: "KERDIAL_TRANSACTIONS",
        rowCount: 1,
        rows: [
          {
            at: { line: 2, index: 0 },
            ok: true,
            row: {
              shape: "CASH_MOVEMENT",
              direction: "IN",
              tradeDate: "2026-09-02",
              tradeTs: null,
              amount: new Decimal("10.00"),
              currency: "EUR",
              note: null,
              portfolioName: "KD8 forged",
              cashAccountName: "kd8 cash",
              cashAccountCurrency: "EUR",
              importFingerprint: "aVeryLongPrefix:0123",
            },
          },
        ],
      };
      const plan = await planImport(forged, kerdialPlanContext(db, IDS.tenantId));
      expect(kerdialTally(plan.outcomes)).toEqual({ MALFORMED_VALUE: 1 });

      const result = await applyKerdial(plan, db, IDS, harness.writes);
      expect(kerdialTally(result.outcomes)).toEqual({ MALFORMED_VALUE: 1 });
      const written = await pg.ownerClient<{ count: string }[]>`
        SELECT count(*)::text AS count FROM "portfolio"
        WHERE tenant_id = ${IDS.tenantId}::uuid AND name = 'KD8 forged'
      `;
      // Zero writes for that row: no portfolio, no account, no transaction —
      // and therefore no `23514` coming back from the shape CHECK.
      expect(written[0]?.count).toBe("0");
    });
  });

  describe("cash-interest — an interest credit beside a deposit of the same figures", () => {
    const fingerprints = async (portfolio: string) =>
      pg.ownerClient<{ kind: string; import_fingerprint: string }[]>`
        SELECT t.kind, t.import_fingerprint FROM "transaction" t
        JOIN "portfolio" p ON p.id = t.portfolio_id
        WHERE p.tenant_id = ${IDS.tenantId}::uuid AND p.name = ${portfolio}
        ORDER BY t.kind
      `;

    it("imports both as two rows under two kd1 values, and a second import writes neither again", async () => {
      const rows = [
        deposit("CI pair", "ci cash", "2026-10-01", "12.34"),
        interestRow(at("CI pair", "ci cash", "2026-10-01"), "12.34"),
      ];

      const first = await run(rows);
      expect(kerdialTally(first.plan.outcomes)).toEqual({ IMPORT: 2 });
      expect(kerdialTally(first.result.outcomes)).toEqual({ IMPORT: 2 });
      const stored = await fingerprints("CI pair");
      expect(stored.map((row) => row.kind)).toStrictEqual(["DEPOSIT", "INTEREST"]);
      expect(stored.every((row) => row.import_fingerprint.startsWith("kd1:"))).toBe(true);
      expect(stored[0]!.import_fingerprint).not.toBe(stored[1]!.import_fingerprint);

      const second = await run(rows);
      expect(kerdialTally(second.plan.outcomes)).toEqual({ ALREADY_IMPORTED: 2 });
      expect(kerdialTally(second.result.outcomes)).toEqual({ ALREADY_IMPORTED: 2 });
      expect(await fingerprints("CI pair")).toStrictEqual(stored);
    });

    it("refuses a zero interest with the same code in the dry run and the confirm, writing nothing", async () => {
      const { plan, result } = await run([
        interestRow(at("CI zero", "ci cash", "2026-10-02"), "0"),
      ]);

      expect(kerdialTally(plan.outcomes)).toEqual({ AMOUNT_NOT_POSITIVE: 1 });
      expect(kerdialTally(result.outcomes)).toEqual(kerdialTally(plan.outcomes));
      expect(await fingerprints("CI zero")).toHaveLength(0);
    });
  });
});
