import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decimal } from "@kerdial/core-decimal";
import {
  createInstrumentByIsin,
  createInstrumentBySymbol,
  type InstrumentKind,
} from "@kerdial/ledger";
import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_IMPORT_LIMITS,
  planImport,
  portfolioPerformanceImporter,
  systemClock,
  type ImportFileType,
  type ImportPlan,
  type NeutralRow,
  type NeutralTradeRow,
  type ParsedRow,
  type ParseResult,
  type PlanContext,
  type PlannedRowOutcome,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "__fixtures__", "portfolio-performance");

/**
 * CI-11 and CI-12 against a real Postgres — the two halves of `planImport` that
 * are statements about SQL rather than about outcome logic:
 *
 *  - **the transaction-row instrument lookup**, including the dual-listing
 *    case and the "one round trip for the whole file" property that a per-row
 *    read would silently violate while still producing correct answers.
 *  - **the batched fingerprint check** and the collision rule, including
 *    the identical-pair red-confirm the user's OD-7 override demands.
 *
 * **What this file deliberately does not close.** F-C's real
 * delete/free/re-import proof needs a real `apply`, which is CI-13/CI-14. The
 * already-imported rows below are inserted **directly** into `transaction`,
 * bypassing `apply` — everything the already-imported check needs *except* the delete/free half,
 * deferred rather than half-built twice (a flagged ambiguity).
 *
 * Grants are not re-proved here: CI-4 already proved, by a live round trip as
 * the real `app_web` role, that `0007`'s table-level grant covers the new
 * column. This suite connects as the owner because what it is measuring is
 * query *shape* and row *content*, neither of which a role changes.
 */

const TENANT = "00000000-0000-7000-8000-0000000c1001";
const PORTFOLIO = "00000000-0000-7000-8000-0000000c1002";
const ACCOUNT_A = "00000000-0000-7000-8000-0000000c1003";
const ACCOUNT_B = "00000000-0000-7000-8000-0000000c1004";

/** A dual listing seeded by hand: one identifier, two exchanges — the case the exchange lookup exists for. */
const DUAL_ISIN = "FRTEST000420";
let dualXparId = "";
let dualXetrId = "";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureDir, name)));
}

function parsed(name: string, fileType: ImportFileType): ParseResult {
  return portfolioPerformanceImporter.validate(
    portfolioPerformanceImporter.parse({ bytes: fixture(name), fileType }),
  );
}

const outcomeOf = (outcome: PlannedRowOutcome): string =>
  outcome.outcome === "IMPORT" ? "IMPORT" : outcome.reason;

function tally(plan: ImportPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of plan.outcomes) {
    const key = outcomeOf(outcome);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("planImport against a real Postgres (CI-11, CI-12)", () => {
  let pg: MigratedPostgres;
  let db: Db;
  let seededInstruments = 0;

  function context(overrides: Partial<PlanContext> = {}): PlanContext {
    return {
      db,
      tenantId: TENANT,
      destination: { portfolioId: PORTFOLIO, cashAccountId: ACCOUNT_A },
      mode: "DRY_RUN",
      resolutions: [],
      discovery: null,
      limits: DEFAULT_IMPORT_LIMITS,
      clock: systemClock,
      ...overrides,
    };
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;

    await pg.ownerClient`INSERT INTO "tenant" (id) VALUES (${TENANT}::uuid)`;
    await pg.ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (${PORTFOLIO}::uuid, ${TENANT}::uuid, 'CI-11/CI-12 portfolio')
    `;
    await pg.ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency) VALUES
        (${ACCOUNT_A}::uuid, ${TENANT}::uuid, ${PORTFOLIO}::uuid, 'Account A', 'EUR'),
        (${ACCOUNT_B}::uuid, ${TENANT}::uuid, ${PORTFOLIO}::uuid, 'Account B', 'EUR')
    `;

    // Seed the catalogue **from the importer's own asset-file plan**, not from a
    // hand-written list: every instrument below is one this pipeline actually
    // decided to create, so the transaction-file runs that follow resolve
    // against exactly what an assets import would have produced.
    const assetPlan = await planImport(
      parsed("assets.csv", "ASSETS"),
      context({ destination: null }),
    );
    for (const outcome of assetPlan.outcomes) {
      if (outcome.outcome !== "IMPORT" || outcome.write.target !== "INSTRUMENT") continue;
      const write = outcome.write;
      if (write.isin !== null && write.exchangeMic !== null) {
        await createInstrumentByIsin(db, {
          kind: write.kind as "SHARE" | "ETF" | "FUND",
          isin: write.isin,
          exchangeMic: write.exchangeMic,
          listingCurrency: write.listingCurrency,
          displayName: write.displayName,
          ...(write.symbol === null ? {} : { symbol: write.symbol }),
        });
      } else if (write.symbol !== null) {
        await createInstrumentBySymbol(db, {
          kind: write.kind as "CRYPTO" | "INDEX",
          symbol: write.symbol,
          listingCurrency: write.listingCurrency,
          displayName: write.displayName,
        });
      }
      seededInstruments += 1;
    }

    const kinds: readonly [string, InstrumentKind][] = [
      ["XPAR", "SHARE"],
      ["XETR", "SHARE"],
    ];
    const [xpar, xetr] = await Promise.all(
      kinds.map(([mic, kind]) =>
        createInstrumentByIsin(db, {
          kind: kind as "SHARE",
          isin: DUAL_ISIN,
          exchangeMic: mic,
          listingCurrency: "EUR",
          displayName: `Dual listing on ${mic}`,
          symbol: mic === "XPAR" ? "DUAL" : "DUALX",
        }),
      ),
    );
    dualXparId = xpar!.id;
    dualXetrId = xetr!.id;
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("seeded the catalogue from the asset file's own plan, and seeded a non-trivial number of rows", () => {
    // The positive companion to every count below: a suite that seeded nothing
    // would report "not resolved" for every trade and look like a clean red.
    // 27 asset rows: 12 resolved from the suffix table (four TER-bearing ETFs,
    // the gold ETC, six shares, Coca-Cola's Xetra line), Schneider skipped as
    // already in the shipped catalogue, and 14 left for discovery.
    expect(seededInstruments).toBe(12);
  });

  describe("resolving a transaction row's instrument", () => {
    function tradeAgainst(isin: string | null, symbol: string | null, index = 0): ParsedRow {
      const row: NeutralTradeRow = {
        shape: "TRADE",
        direction: "ACQUIRE",
        tradeDate: "2026-01-05",
        tradeTs: null,
        quantity: new Decimal("3"),
        unitPrice: new Decimal("10"),
        currency: "EUR",
        cashCurrency: null,
        fxRateUserInput: null,
        costs: null,
        brokerFee: null,
        tax: null,
        instrumentRef: { isin, symbol, displayName: "a traded thing" },
        note: null,
        isCashSideDuplicate: false,
      };
      return { at: { line: index + 2, index }, ok: true, row };
    }

    it("picks the right line of a dual listing when the ticker's suffix names the exchange", async () => {
      const plan = await planImport(
        {
          fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
          rowCount: 2,
          rows: [tradeAgainst(DUAL_ISIN, "DUAL.PA", 0), tradeAgainst(DUAL_ISIN, "DUALX.DE", 1)],
        },
        context(),
      );
      expect(plan.outcomes.map(outcomeOf)).toEqual(["IMPORT", "IMPORT"]);
      const resolvedIds = plan.outcomes.map((outcome) =>
        outcome.outcome === "IMPORT" && outcome.write.target === "TRANSACTION"
          ? outcome.write.instrumentId
          : null,
      );
      // Two different rows of one identifier, told apart by the suffix alone.
      expect(resolvedIds).toEqual([dualXparId, dualXetrId]);
      expect(dualXparId).not.toBe(dualXetrId);
    });

    it("refuses an ambiguous identifier and names both candidates", async () => {
      const plan = await planImport(
        {
          fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
          rowCount: 1,
          rows: [tradeAgainst(DUAL_ISIN, null, 0)],
        },
        context(),
      );
      const outcome = plan.outcomes[0]!;
      expect(outcomeOf(outcome)).toBe("INSTRUMENT_AMBIGUOUS");
      const message = outcome.outcome === "REJECT" ? outcome.message : "";
      expect(message).toContain(dualXparId);
      expect(message).toContain(dualXetrId);
    });

    it("refuses an identifier the catalogue does not carry", async () => {
      const plan = await planImport(
        {
          fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS",
          rowCount: 1,
          rows: [tradeAgainst("FRTEST000439", "NOPE.PA", 0)],
        },
        context(),
      );
      expect(plan.outcomes.map(outcomeOf)).toEqual(["INSTRUMENT_NOT_RESOLVED"]);
    });

    it("reads the whole file's distinct identity set in exactly one round trip", async () => {
      // A per-row read produces identical answers and 200× the round trips, so
      // correctness cannot detect it — only counting can.
      const statements: string[] = [];
      const countingSql = postgres(pg.ownerUri, {
        max: 1,
        debug: (_connection, query) => statements.push(query),
      });
      try {
        // postgres.js issues one `pg_catalog` array-type introspection query on
        // its first use of a connection. Warm the pool and reset the log, so
        // what is counted below is application reads and nothing else.
        await countingSql`SELECT 1`;
        statements.length = 0;

        const rows: ParsedRow[] = Array.from({ length: 220 }, (_, index) =>
          tradeAgainst(
            index < 20 ? DUAL_ISIN : `FRTEST${String(500_000 + index)}`,
            index < 20 ? "DUAL.PA" : `T${String(index)}.PA`,
            index,
          ),
        );
        const distinctIdentifiers = new Set(
          rows.map((one) =>
            one.ok && one.row.shape === "TRADE" ? one.row.instrumentRef.isin : null,
          ),
        );
        // The positive companion: the fixture really does carry 200+ distinct
        // references, so "one query" is not one query over a trivial set.
        expect(distinctIdentifiers.size).toBe(201);

        const plan = await planImport(
          { fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows },
          context({ db: createDb(countingSql) }),
        );
        expect(plan.rowCount).toBe(220);

        const catalogueReads = statements.filter((sql) => /from\s+"instrument"/i.test(sql));
        const fingerprintReads = statements.filter((sql) => /from\s+"transaction"/i.test(sql));
        expect(catalogueReads).toHaveLength(1);
        expect(fingerprintReads).toHaveLength(1);
        // **Five**, not two, since GATE-1 moved the fingerprint read inside
        // `withTenant` (`transaction` carries RLS, so the read
        // saw nothing at all as the real `app_web` role): the two application
        // reads plus that one transaction's own `BEGIN`, `set_config` and
        // `COMMIT`. Still counted exactly rather than relaxed to "at least one
        // each" — a per-row read would show 200-odd here, which is the only
        // thing this test exists to catch. **Nine** since per-currency account routing: the
        // destination portfolio's accounts are read once, in a `withTenant` of
        // their own, so a row settled in another currency can be routed.
        expect(statements.filter((sql) => /from\s+"portfolio"/i.test(sql))).toHaveLength(1);
        expect(statements.filter((sql) => /set_config/i.test(sql))).toHaveLength(2);
        expect(statements).toHaveLength(9);
      } finally {
        await countingSql.end({ timeout: 5 });
      }
    });

    /**
     * `security-transfer` TR-23/TR-24 — the two plan-stage reads that cycle
     * adds, each issued **only** for a file that needs it, which is why the
     * case above still counts nine: its file has no transfer row.
     *
     *  - **The tenant's portfolio list** (FR-583), once, when some source-leg
     *    transfer row was answered with a destination name — how an existing
     *    portfolio is matched by name and a new one checked against the cap.
     *    Its accounts are *not* read: a target leg names no cash account.
     *  - **The destination's target-leg rows** (FR-584), once, when the file
     *    has a target-leg row — however many it has.
     *
     * Each is its own `withTenant` (`transaction` and `portfolio` carry RLS),
     * so each costs four statements: nine + four + four = seventeen. Many rows
     * of each kind are planned here, so a per-row read would show far more.
     */
    it("security-transfer: reads the portfolio list and the target legs once each, and only when the file needs them", async () => {
      const statements: string[] = [];
      const countingSql = postgres(pg.ownerUri, {
        max: 1,
        debug: (_connection, query) => statements.push(query),
      });
      try {
        await countingSql`SELECT 1`;
        statements.length = 0;

        const leg = (direction: "IN" | "OUT", index: number): ParsedRow => {
          const row: Extract<NeutralRow, { shape: "TRANSFER" }> = {
            shape: "TRANSFER",
            direction,
            tradeDate: "2026-01-05",
            tradeTs: null,
            quantity: new Decimal(String(index + 1)),
            marketValue: new Decimal("100"),
            currency: "EUR",
            instrumentRef: { isin: DUAL_ISIN, symbol: "DUAL.PA", displayName: "a moved thing" },
            note: null,
          };
          return { at: { line: index + 2, index }, ok: true, row };
        };
        const rows = Array.from({ length: 20 }, (_, index) =>
          leg(index < 10 ? "OUT" : "IN", index),
        );

        const plan = await planImport(
          { fileType: "INVESTMENT_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows },
          context({
            db: createDb(countingSql),
            transferDestinations: Array.from({ length: 10 }, (_, index) => ({
              index,
              portfolioName: index % 2 === 0 ? "CI-11/CI-12 receiving" : "CI-11/CI-12 cold storage",
            })),
          }),
        );
        // Positive companion: every source leg planned with its answer, every
        // target leg decided (none is in the ledger here, so all are refused).
        expect(tally(plan)).toEqual({ IMPORT: 10, UNSUPPORTED_ROW_TYPE: 10 });
        expect(plan.directory.portfolios.map((one) => one.name).sort()).toEqual([
          "CI-11/CI-12 cold storage",
          "CI-11/CI-12 receiving",
        ]);

        // Told apart by what each one selects, not by its `from`: the request
        // portfolio's account snapshot reads `portfolio` too.
        const portfolioListReads = statements.filter((sql) => sql.includes('"portfolio"."broker"'));
        const accountReads = statements.filter((sql) => sql.includes('"cash_account"."id"'));
        const targetLegReads = statements.filter(
          (sql) => /from\s+"transaction"/i.test(sql) && sql.includes('"gross_amount"'),
        );
        const fingerprintReads = statements.filter(
          (sql) => /from\s+"transaction"/i.test(sql) && sql.includes('"import_fingerprint"'),
        );
        expect(portfolioListReads).toHaveLength(1);
        expect(targetLegReads).toHaveLength(1);
        expect(fingerprintReads).toHaveLength(1);
        // No account read for the destinations: the one account read is the
        // request's own portfolio's, as in the case above.
        expect(accountReads).toHaveLength(1);
        expect(statements.filter((sql) => /set_config/i.test(sql))).toHaveLength(4);
        expect(statements).toHaveLength(17);
      } finally {
        await countingSql.end({ timeout: 5 });
      }
    });
  });

  describe("OD-1 — the cash-account file's trade rows are skipped, and only those", () => {
    it("skips all 33 trades of the committed fixture and touches no other row kind with that reason", async () => {
      const plan = await planImport(parsed("cash.csv", "CASH_ACCOUNT_TRANSACTIONS"), context());
      const counts = tally(plan);

      expect(plan.rowCount).toBe(52);
      expect(counts["COVERED_BY_INVESTMENT_FILE"]).toBe(33);

      // The positive companion IMP-AC-11 demands: in the **same** run, the
      // deposit/withdrawal/dividend rows are decided by something else
      // entirely, so the skip is type-specific and not a blanket catch-all.
      const nonTradeOutcomes = plan.outcomes.filter(
        (outcome) => outcomeOf(outcome) !== "COVERED_BY_INVESTMENT_FILE",
      );
      expect(nonTradeOutcomes).toHaveLength(19);
      expect(new Set(nonTradeOutcomes.map(outcomeOf))).toEqual(
        new Set(["IMPORT", "ZERO_VALUE_DIVIDEND_MARKER"]),
      );
      // 9 deposits + 1 withdrawal + 8 dividends imported; the one zero-amount
      // dividend **skipped** — the IMP-AC-5 profile, reached through
      // `plan` rather than asserted about the file.
      //
      // This row used to be the file's single
      // `AMOUNT_NOT_POSITIVE` **rejection**, and it was in the wrong category.
      // The source format emits a zero-value income line as a
      // corporate-action marker with no cash leg — it parses and validates
      // cleanly, which is precisely the definition of a SKIP. Telling the
      // user their file had a bad number, in a file where most rows were
      // legitimately skipped and this was the only thing flagged as wrong,
      // was the defect.
      expect(counts["IMPORT"]).toBe(18);
      expect(counts["ZERO_VALUE_DIVIDEND_MARKER"]).toBe(1);
      expect(counts["AMOUNT_NOT_POSITIVE"]).toBeUndefined();
      // **The 52-row file rejects nothing at all** — the zero-value-dividend
      // count, asserted as a number rather than described.
      expect(plan.summary).toMatchObject({ imported: 18, skipped: 34, rejected: 0 });
      expect(plan.summary.imported + plan.summary.skipped + plan.summary.rejected).toBe(52);
    });
  });

  describe("the collision rule, against the fixture's genuine identical pair", () => {
    /** The two rows of the committed fixture that are legitimately identical (same day, same instrument, same quantity, same price): two 20-unit fills of EMIM.AS on 2023-06-21. */
    const PAIR_IDENTIFIER = "IE00BKM4GZ66";

    async function planInvestmentFile(cashAccountId = ACCOUNT_A): Promise<ImportPlan> {
      return planImport(
        parsed("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"),
        context({ destination: { portfolioId: PORTFOLIO, cashAccountId } }),
      );
    }

    function pairOutcomes(plan: ImportPlan): PlannedRowOutcome[] {
      // Located by the fixture's own line numbers, so a fixture edit that moved
      // the pair fails here rather than silently testing two other rows.
      return [plan.outcomes[24]!, plan.outcomes[25]!];
    }

    let firstRunImported = 0;
    let pairFingerprints: string[] = [];

    it("marks both rows of the pair IMPORT on the first run, with two distinct fingerprints", async () => {
      const plan = await planInvestmentFile();
      const pair = pairOutcomes(plan);
      // The red-confirm this assertion exists for (OD-7's amendment
      // demands it by name): with the `occurrence` field removed from the
      // canonical string, this same run reports `["IMPORT", "ALREADY_IMPORTED"]`
      // — the second row collides with the first before either is written.
      // Performed by mutating `fingerprint.ts`, observed, and reverted; the
      // mechanism is therefore known to work, not merely known to be green.
      expect(pair.map(outcomeOf)).toEqual(["IMPORT", "IMPORT"]);

      pairFingerprints = pair.map((outcome) =>
        outcome.outcome === "IMPORT" && outcome.write.target === "TRANSACTION"
          ? outcome.write.importFingerprint
          : "",
      );
      // Two rows the source cannot tell apart, and the recipe can — because of
      // the occurrence ordinal and nothing else.
      expect(new Set(pairFingerprints).size).toBe(2);
      for (const fingerprint of pairFingerprints) {
        // FR-260: `pp1:` until FT-40 bumped the recipe to `pp2`.
        expect(fingerprint).toMatch(/^pp2:[0-9a-f]{64}$/);
      }
      // They are the pair, not two unrelated rows: same identifier, same day.
      const rows = parsed("investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS").rows;
      for (const index of [24, 25]) {
        const row = rows[index]!;
        expect(row.ok && row.row.shape === "TRADE" && row.row.instrumentRef.isin).toBe(
          PAIR_IDENTIFIER,
        );
        expect(row.ok && row.row.shape === "TRADE" && row.row.tradeDate).toBe("2023-06-21");
      }

      firstRunImported = plan.summary.imported;
      expect(firstRunImported).toBeGreaterThan(0);
    });

    it("marks both SKIP on the next run once those two fingerprints exist in the ledger", async () => {
      // Inserted directly, bypassing `apply` — which does not exist until
      // CI-13. This is the half of the already-imported check that can be closed now; the
      // delete/free/re-import half is CI-14's.
      await insertFingerprintedRows(pg.ownerClient, pairFingerprints);

      const plan = await planInvestmentFile();
      const pair = pairOutcomes(plan);
      expect(pair.map(outcomeOf)).toEqual(["ALREADY_IMPORTED", "ALREADY_IMPORTED"]);
      // 2 imported → 0 imported / 2 skipped, and nothing else moved.
      expect(plan.summary.imported).toBe(firstRunImported - 2);
      expect(tally(plan)["ALREADY_IMPORTED"]).toBe(2);
    });

    it("treats the same file into a different cash account as a different import", async () => {
      // The destination is in the hash, not only in the index: the two rows
      // whose fingerprints are already stored against account A import cleanly
      // against account B.
      const plan = await planInvestmentFile(ACCOUNT_B);
      expect(pairOutcomes(plan).map(outcomeOf)).toEqual(["IMPORT", "IMPORT"]);
      expect(plan.summary.imported).toBe(firstRunImported);
      expect(tally(plan)["ALREADY_IMPORTED"]).toBeUndefined();
    });

    it("cannot see a manually-entered row, and leaves it alone", async () => {
      const before = await countTransactions(pg.ownerClient);
      await pg.ownerClient`
        INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                   gross_amount, txn_currency, cash_currency, cash_amount,
                                   fx_rate, fx_rate_source,
                                   cash_account_id, import_fingerprint)
        VALUES (gen_random_uuid(), ${TENANT}::uuid, ${PORTFOLIO}::uuid, 'DEPOSIT',
                '2026-03-01', ${before + 9_000}, '100', 'EUR', 'EUR', '100', '1', 'IMPLIED_BASE',
                ${ACCOUNT_A}::uuid, NULL)
      `;

      const plan = await planInvestmentFile();
      // Unchanged from the previous run: the NULL row matched nothing.
      expect(tally(plan)["ALREADY_IMPORTED"]).toBe(2);
      // The positive companion: the row is still there afterwards, untouched —
      // "no match" and "the query never ran" are the same green otherwise.
      const [nullRows] = await pg.ownerClient<{ n: string }[]>`
        SELECT count(*)::text AS n FROM "transaction"
        WHERE portfolio_id = ${PORTFOLIO}::uuid AND import_fingerprint IS NULL
      `;
      expect(Number(nullRows!.n)).toBe(1);
      expect(await countTransactions(pg.ownerClient)).toBe(before + 1);
    });
  });
});

/** Writes one row per fingerprint, the cheapest shape that satisfies every CHECK on `transaction` (a fiat principal leg, its cash account, and — from `0046` — its own degenerate cash denomination). */
async function insertFingerprintedRows(
  sql: postgres.Sql,
  fingerprints: readonly string[],
): Promise<void> {
  let seq = 1;
  for (const fingerprint of fingerprints) {
    await sql`
      INSERT INTO "transaction" (id, tenant_id, portfolio_id, kind, trade_date, seq,
                                 gross_amount, txn_currency, cash_currency, cash_amount,
                                 fx_rate, fx_rate_source,
                                 cash_account_id, import_fingerprint)
      VALUES (gen_random_uuid(), ${TENANT}::uuid, ${PORTFOLIO}::uuid, 'DEPOSIT',
              '2023-06-21', ${seq}, '100', 'EUR', 'EUR', '100', '1', 'IMPLIED_BASE',
              ${ACCOUNT_A}::uuid, ${fingerprint})
    `;
    seq += 1;
  }
}

async function countTransactions(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM "transaction" WHERE portfolio_id = ${PORTFOLIO}::uuid
  `;
  return Number(row!.n);
}
