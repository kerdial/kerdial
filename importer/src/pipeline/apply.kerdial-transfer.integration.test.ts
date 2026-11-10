import { createInstrumentByIsin, getTransactionById } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ImportResult } from "./apply.js";
import { planImport, type ImportPlan, type PlannedRowOutcome } from "./plan.js";
import {
  acquisitionRow,
  applyKerdial,
  buildKerdialWriteService,
  cashInRow,
  disposalRow,
  kerdialPlanContext,
  kerdialTally,
  parseKerdial,
  recordingBatches,
  seedBareTenant,
  transferInRow,
  transferOutRow,
  type Cells,
  type KerdialIds,
  type RowInstrument,
} from "./__tests__/kerdial-harness.js";

/**
 * `security-transfer` TR-29 — a transfer a per-row-destination file states as
 * **two** rows, the lone target leg ND-2 (a) carries back in,
 * and ST-12's apply order, against a real Postgres.
 *
 * Every scenario gets a tenant of its own and names its two portfolios, which
 * the import creates by name (FR-589/V13): nothing here is seeded but the
 * tenant and the one instrument.
 *
 * The rows are built in the neutral vocabulary through the format module's own
 * builders (`formats/kerdial-csv/__tests__/rows.ts`) — this directory is inside
 * the import-vocabulary gate's fence, test files included.
 */

const ISIN = "FRKERDTR2901";
const OTHER_ISIN = "FRKERDTR2902";
const MIC = "XPAR";
const SHARE: RowInstrument = { isin: ISIN, exchangeMic: MIC };

const EXCHANGE = "Exchange";
const WALLET = "Wallet";
const EXCHANGE_CASH = "Espèces Exchange";
const WALLET_CASH = "Espèces Wallet";

let scenario = 0;
/** A fresh tenant id family per scenario — `…00000e29<nn><kk>`. */
function nextIds(): KerdialIds {
  scenario += 1;
  const base = `00000000-0000-7000-8000-00000e29${String(scenario).padStart(2, "0")}`;
  return { tenantId: `${base}01`, userId: `${base}02`, sessionId: `${base}03` };
}

/* ------------------------------------------------------------- the fixtures */

const onExchange = (date: string) => ({ portfolio: EXCHANGE, account: EXCHANGE_CASH, date });
const onWallet = (date: string) => ({ portfolio: WALLET, account: WALLET_CASH, date });

/**
 * **The counter-example to any portfolio-first order**, with the two elements
 * the fixture needs: a same-date row in the target portfolio right after the
 * transfer (row 5), and a there-and-back pair (rows 3/4 out, rows 6/7 back).
 *
 * Exchange buys 20 at 60 and 30 at 70 (cost 3 300, PMP 66); moves 10 to Wallet
 * on 2025-07-09 (carried 660); Wallet sells 5 of them that same day (5 left,
 * cost 330); Wallet moves 4 back on 2025-11-01 (carried 4 × 66 = 264);
 * Exchange sells all 44 it then holds on 2025-12-01.
 */
function roundTripRows(): Cells[] {
  return [
    cashInRow(onExchange("2025-07-01"), "10000"),
    acquisitionRow(onExchange("2025-07-02"), SHARE, "20", "60"),
    acquisitionRow(onExchange("2025-07-03"), SHARE, "30", "70"),
    transferOutRow({ portfolio: EXCHANGE, date: "2025-07-09" }, SHARE, "10", "1240.80", "t1"),
    transferInRow({ portfolio: WALLET, date: "2025-07-09" }, SHARE, "10", "1240.80", {
      sourceLabel: "t1",
    }),
    disposalRow(onWallet("2025-07-09"), SHARE, "5", "100"),
    transferOutRow({ portfolio: WALLET, date: "2025-11-01" }, SHARE, "4", "400", "t2"),
    transferInRow({ portfolio: EXCHANGE, date: "2025-11-01" }, SHARE, "4", "400", {
      sourceLabel: "t2",
    }),
    disposalRow(onExchange("2025-12-01"), SHARE, "44", "80"),
  ];
}

describe("security-transfer TR-29 — a Kerdial file stating both legs of a transfer", () => {
  let pg: MigratedPostgres;
  let db: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    for (const isin of [ISIN, OTHER_ISIN]) {
      await createInstrumentByIsin(db, {
        kind: "SHARE",
        isin,
        exchangeMic: MIC,
        listingCurrency: "EUR",
        displayName: `TR-29 ${isin}`,
      });
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  async function tenant(): Promise<KerdialIds> {
    const ids = nextIds();
    await seedBareTenant(pg, ids);
    return ids;
  }

  function plan(ids: KerdialIds, rows: readonly Cells[], mode: "DRY_RUN" | "APPLY" = "APPLY") {
    return planImport(parseKerdial(rows), kerdialPlanContext(db, ids.tenantId, { mode }));
  }

  function apply(ids: KerdialIds, planned: ImportPlan): Promise<ImportResult> {
    return applyKerdial(planned, db, ids, buildKerdialWriteService(db, ids.tenantId).writes);
  }

  /** Every transfer leg of a tenant, in ledger order, its partner resolved to a portfolio name. */
  async function transferLegs(tenantId: string) {
    const rows = await pg.ownerClient<
      {
        portfolio: string;
        kind: string;
        trade_date: string;
        quantity: string;
        source_portfolio: string | null;
        transfer_cost_base: string | null;
        note: string | null;
        reference: string | null;
      }[]
    >`
      SELECT p.name AS portfolio, t.kind::text AS kind, t.trade_date::text AS trade_date,
             t.quantity::text AS quantity, sp.name AS source_portfolio,
             t.transfer_cost_base::text AS transfer_cost_base, t.note, t.reference
      FROM "transaction" t
      JOIN portfolio p ON p.id = t.portfolio_id
      LEFT JOIN "transaction" s ON s.id = t.transfer_source_id
      LEFT JOIN portfolio sp ON sp.id = s.portfolio_id
      WHERE t.tenant_id = ${tenantId}::uuid AND t.kind::text IN ('TRANSFER_OUT', 'TRANSFER_IN')
      ORDER BY t.trade_date, t.seq
    `;
    return rows.map((row) => ({ ...row }));
  }

  async function holdings(tenantId: string) {
    const rows = await pg.ownerClient<{ portfolio: string; quantity: string; cost: string }[]>`
      SELECT p.name AS portfolio, h.quantity::text AS quantity, h.cost_basis_base::text AS cost
      FROM holding_state h JOIN portfolio p ON p.id = h.portfolio_id
      WHERE h.tenant_id = ${tenantId}::uuid
      ORDER BY p.name
    `;
    return rows.map((row) => ({ ...row }));
  }

  const reasonsOf = (outcomes: readonly { outcome: string; reason?: string }[]) =>
    outcomes.map((one) => (one.outcome === "IMPORT" ? "IMPORT" : one.reason));

  /** The portfolio each planned write lands in, by the file position of its row. */
  function portfolioOfRow(planned: ImportPlan, index: number): string {
    const outcome: PlannedRowOutcome = planned.outcomes[index]!;
    if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") {
      throw new Error(`row ${String(index)} is not a planned transaction write`);
    }
    return outcome.write.portfolioId ?? "";
  }

  /** KD9's portfolio-first order over the same plan, with `first` sorting ahead — the order ST-12 replaces. */
  function portfolioFirst(planned: ImportPlan, first: string): ImportPlan {
    const rank = (index: number): number => (portfolioOfRow(planned, index) === first ? 0 : 1);
    return {
      ...planned,
      applyOrder: [...planned.applyOrder].sort((a, b) => rank(a) - rank(b) || a - b),
      applyOrderRule: "BY_PORTFOLIO",
    };
  }

  describe("ST-12 — the round trip no portfolio order survives", () => {
    it("plans one write per pair, the target rows covered by it, and the whole file in file order", async () => {
      const ids = await tenant();
      const dryRun = await plan(ids, roundTripRows(), "DRY_RUN");
      const confirm = await plan(ids, roundTripRows());

      expect(reasonsOf(confirm.outcomes)).toEqual([
        "IMPORT",
        "IMPORT",
        "IMPORT",
        "IMPORT",
        "COVERED_BY_TRANSFER_OUT",
        "IMPORT",
        "IMPORT",
        "COVERED_BY_TRANSFER_OUT",
        "IMPORT",
      ]);
      // The dry-run/confirm identity holds for a pair.
      expect(dryRun.summary).toEqual(confirm.summary);
      // Global (date, time, file order): every file here is already dated in
      // order, so the apply order is the file order of the written rows.
      expect(confirm.applyOrder).toEqual([0, 1, 2, 3, 5, 6, 8]);
      // Both portfolios are created by name, the target one reached only
      // through the pair's source write.
      expect(confirm.directory.portfolios.map((one) => one.name).sort()).toEqual([
        EXCHANGE,
        WALLET,
      ]);
    });

    it("succeeds in chronological order: both pairs linked, each carrying the source's PMP cost", async () => {
      const ids = await tenant();
      const result = await apply(ids, await plan(ids, roundTripRows()));

      expect(result.applyFailed).toBe(0);
      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 7, COVERED_BY_TRANSFER_OUT: 2 });
      expect(
        (await transferLegs(ids.tenantId)).map((leg) => [
          leg.portfolio,
          leg.kind,
          leg.trade_date,
          leg.source_portfolio,
          leg.transfer_cost_base,
        ]),
      ).toEqual([
        [EXCHANGE, "TRANSFER_OUT", "2025-07-09", null, null],
        [WALLET, "TRANSFER_IN", "2025-07-09", EXCHANGE, "660.000000000000"],
        [WALLET, "TRANSFER_OUT", "2025-11-01", null, null],
        [EXCHANGE, "TRANSFER_IN", "2025-11-01", WALLET, "264.000000000000"],
      ]);
      // Exchange sold every unit it held, so it holds no position at all;
      // Wallet keeps 1, at PMP 66.
      expect(await holdings(ids.tenantId)).toEqual([
        { portfolio: WALLET, quantity: "1.000000000000000000", cost: "66.000000000000" },
      ]);
    });

    for (const first of [EXCHANGE, WALLET]) {
      it(`fails under KD9's portfolio-first order with ${first} first — the stated failure mode`, async () => {
        const ids = await tenant();
        const planned = await plan(ids, roundTripRows());
        const firstId = planned.directory.portfolios.find((one) => one.name === first)!.id;
        const result = await apply(ids, portfolioFirst(planned, firstId));

        // Exchange first: its 2025-12-01 sale of 44 runs while it holds 40 —
        // Wallet's return leg has not been written. Wallet first: its same-day
        // sale and its return transfer run before a single unit has arrived.
        const failed = result.outcomes.flatMap((one, index) =>
          one.outcome === "REJECT" && one.reason === "APPLY_FAILED" ? [index] : [],
        );
        expect(failed).toEqual(first === EXCHANGE ? [8] : [5, 6, 8]);
      });
    }
  });

  it("a file with no stated pair keeps KD9's portfolio-first order, one portfolio per chunk (regression)", async () => {
    // The same fixture minus both transfers: Wallet funds and buys its own.
    const rows = [
      cashInRow(onExchange("2025-07-01"), "10000"),
      acquisitionRow(onExchange("2025-07-02"), SHARE, "20", "60"),
      acquisitionRow(onExchange("2025-07-03"), SHARE, "30", "70"),
      cashInRow(onWallet("2025-07-09"), "1000"),
      acquisitionRow(onWallet("2025-07-09"), SHARE, "5", "100"),
      disposalRow(onExchange("2025-12-01"), SHARE, "44", "80"),
    ];
    const ids = await tenant();
    const planned = await plan(ids, rows);
    const exchangeRows = [0, 1, 2, 5];
    const walletRows = [3, 4];
    const exchangeFirst =
      portfolioOfRow(planned, 0) < portfolioOfRow(planned, 3)
        ? [...exchangeRows, ...walletRows]
        : [...walletRows, ...exchangeRows];
    expect(planned.applyOrder).toEqual(exchangeFirst);

    const recording = recordingBatches(buildKerdialWriteService(db, ids.tenantId).writes);
    const result = await applyKerdial(planned, db, ids, recording.writes);
    expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 6 });
    expect(recording.batches.map((batch) => batch.length)).toEqual([1, 1]);
  });

  describe("pairing refusals — never a silent Step A", () => {
    const source = (overrides: Cells = {}): Cells => ({
      ...transferOutRow({ portfolio: EXCHANGE, date: "2025-07-09" }, SHARE, "10", "1240.80", "t1"),
      ...overrides,
    });
    const target = (overrides: Cells = {}): Cells => ({
      ...transferInRow({ portfolio: WALLET, date: "2025-07-09" }, SHARE, "10", "1240.80", {
        sourceLabel: "t1",
      }),
      ...overrides,
    });
    const funded = [
      cashInRow(onExchange("2025-07-01"), "10000"),
      acquisitionRow(onExchange("2025-07-02"), SHARE, "20", "60"),
    ];

    /** A disagreement, stated as the target row's variant of the source row's cells. */
    const DISAGREEMENTS: readonly [string, Cells][] = [
      ["the quantity", target({ quantity: "9" })],
      ["the market value", target({ gross_amount: "1240.81" })],
      ["the date", target({ date: "2025-07-10" })],
      ["the instrument", target({ isin: OTHER_ISIN })],
      ["the currency", target({ currency: "USD" })],
      ["the portfolio — the same one on both rows", target({ portfolio: EXCHANGE })],
    ];

    for (const [what, variant] of DISAGREEMENTS) {
      it(`refuses both rows TRANSFER_PAIR_INCONSISTENT when they disagree about ${what}`, async () => {
        const ids = await tenant();
        const planned = await plan(ids, [...funded, source(), variant], "DRY_RUN");

        expect(reasonsOf(planned.outcomes)).toEqual([
          "IMPORT",
          "IMPORT",
          "TRANSFER_PAIR_INCONSISTENT",
          "TRANSFER_PAIR_INCONSISTENT",
        ]);
      });
    }

    it("refuses both when a second receiving row names an already-paired source (one target per source)", async () => {
      const ids = await tenant();
      const planned = await plan(ids, [...funded, source(), target(), target()], "DRY_RUN");

      expect(reasonsOf(planned.outcomes).slice(2)).toEqual([
        "TRANSFER_PAIR_INCONSISTENT",
        "TRANSFER_PAIR_INCONSISTENT",
        "TRANSFER_PAIR_INCONSISTENT",
      ]);
    });

    it("refuses a receiving row whose source label no row declares, and the labelled source it was meant for", async () => {
      const ids = await tenant();
      const elsewhere = transferInRow(
        { portfolio: WALLET, date: "2025-07-09" },
        SHARE,
        "10",
        "1240.80",
        { sourceLabel: "t9" },
      );
      const planned = await plan(ids, [...funded, source(), elsewhere], "DRY_RUN");

      expect(reasonsOf(planned.outcomes).slice(2)).toEqual([
        "TRANSFER_PAIR_INCONSISTENT",
        "TRANSFER_SOURCE_NOT_RESOLVED",
      ]);
    });

    it("refuses a receiving row whose source row was itself refused", async () => {
      const ids = await tenant();
      const planned = await plan(
        ids,
        [...funded, source({ isin: "FRKERDTR2999" }), target()],
        "DRY_RUN",
      );
      expect(reasonsOf(planned.outcomes).slice(2)).toEqual([
        "INSTRUMENT_NOT_RESOLVED",
        "TRANSFER_SOURCE_NOT_RESOLVED",
      ]);
    });

    it("refuses a labelled source whose receiving row was refused, rather than writing it alone", async () => {
      const ids = await tenant();
      const planned = await plan(
        ids,
        [...funded, source(), target({ isin: "FRKERDTR2999" })],
        "DRY_RUN",
      );

      expect(reasonsOf(planned.outcomes).slice(2)).toEqual([
        "TRANSFER_PAIR_INCONSISTENT",
        "INSTRUMENT_NOT_RESOLVED",
      ]);
    });
  });

  describe("ND-2 (a) — a lone receiving row (its source portfolio was deleted)", () => {
    const lone = transferInRow({ portfolio: WALLET, date: "2025-08-01" }, SHARE, "5", "500", {
      cost: { base: "330", native: "330", currency: "EUR" },
    });

    it("imports as a TRANSFER_IN carrying the stated cost, EXTERNAL — never a BUY, never refused", async () => {
      const ids = await tenant();
      const result = await apply(ids, await plan(ids, [lone]));

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: 1 });
      const written = result.outcomes[0]!;
      if (written.outcome !== "IMPORT") throw new Error("expected the row to be written");
      const row = await getTransactionById(db, ids.tenantId, written.writtenId);
      // The literal kind, off the ledger's own read — (c)'s export-as-BUY
      // would read "BUY" here.
      expect(row?.kind).toBe("TRANSFER_IN");
      expect(row?.transferSourceId).toBeNull();
      expect(row?.transferCostBase?.toFixed(2)).toBe("330.00");
      expect(row?.transferCostCurrency).toBe("EUR");

      const flows = await pg.ownerClient<{ flow_class: string }[]>`
        SELECT DISTINCT flow_class::text AS flow_class FROM transaction_posting
        WHERE transaction_id = ${written.writtenId}::uuid
      `;
      expect(flows.map((one) => one.flow_class)).toEqual(["EXTERNAL"]);
      expect(await holdings(ids.tenantId)).toEqual([
        { portfolio: WALLET, quantity: "5.000000000000000000", cost: "330.000000000000" },
      ]);
    });

    it("re-imports as ALREADY_IMPORTED, not as a second arrival", async () => {
      const ids = await tenant();
      await apply(ids, await plan(ids, [lone]));
      const again = await apply(ids, await plan(ids, [lone]));

      expect(kerdialTally(again.outcomes)).toEqual({ ALREADY_IMPORTED: 1 });
      expect(await transferLegs(ids.tenantId)).toHaveLength(1);
    });

    it("refuses a stated cost in a well-formed currency this installation does not know", async () => {
      const ids = await tenant();
      const unknown = transferInRow({ portfolio: WALLET, date: "2025-08-01" }, SHARE, "5", "500", {
        cost: { base: "330", native: "330", currency: "XYZ" },
      });
      const result = await apply(ids, await plan(ids, [unknown]));

      expect(reasonsOf(result.outcomes)).toEqual(["CURRENCY_UNKNOWN"]);
      expect(await transferLegs(ids.tenantId)).toHaveLength(0);
    });
  });

  it("writes the receiving row's own note, reference and carried fingerprint on the target leg only", async () => {
    const ids = await tenant();
    const carried = `kd1:${"7".repeat(64)}`;
    const rows = [
      cashInRow(onExchange("2025-07-01"), "10000"),
      acquisitionRow(onExchange("2025-07-02"), SHARE, "20", "60"),
      transferOutRow({ portfolio: EXCHANGE, date: "2025-07-09" }, SHARE, "10", "1240.80", "t1"),
      {
        ...transferInRow(
          { portfolio: WALLET, date: "2025-07-09", carriedFingerprint: carried },
          SHARE,
          "10",
          "1240.80",
          { sourceLabel: "t1" },
        ),
        note: "Arrivée sur le portefeuille froid",
        reference: "TR-IN-1",
      },
    ];
    const planned = await plan(ids, rows);
    const result = await apply(ids, planned);
    expect(result.applyFailed).toBe(0);

    const legs = await transferLegs(ids.tenantId);
    expect(legs.map((leg) => [leg.kind, leg.note, leg.reference])).toEqual([
      ["TRANSFER_OUT", null, null],
      ["TRANSFER_IN", "Arrivée sur le portefeuille froid", "TR-IN-1"],
    ]);
    const fingerprints = await pg.ownerClient<{ kind: string; import_fingerprint: string }[]>`
      SELECT kind::text AS kind, import_fingerprint FROM "transaction"
      WHERE tenant_id = ${ids.tenantId}::uuid AND kind::text = 'TRANSFER_IN'
    `;
    expect(fingerprints.map((one) => one.import_fingerprint)).toEqual([carried]);
    // The target leg's id is the one the plan pre-allocated for it.
    const source = planned.outcomes[2]!;
    if (source.outcome !== "IMPORT" || source.write.target !== "TRANSACTION") {
      throw new Error("expected the source row to be planned");
    }
    const [target] = await pg.ownerClient<{ id: string }[]>`
      SELECT id FROM "transaction"
      WHERE tenant_id = ${ids.tenantId}::uuid AND kind::text = 'TRANSFER_IN'
    `;
    expect(target?.id).toBe(source.write.transferTargetRow?.id);
  });

  it("R-7 (accepted, ST-11): a Step A re-imported with its receiving row added is not upgraded to a pair", async () => {
    const ids = await tenant();
    const funding = [
      cashInRow(onExchange("2025-07-01"), "10000"),
      acquisitionRow(onExchange("2025-07-02"), SHARE, "20", "60"),
    ];
    await apply(
      ids,
      await plan(ids, [
        ...funding,
        transferOutRow({ portfolio: EXCHANGE, date: "2025-07-09" }, SHARE, "10", "1240.80"),
      ]),
    );
    const upgraded = await apply(
      ids,
      await plan(ids, [
        ...funding,
        transferOutRow({ portfolio: EXCHANGE, date: "2025-07-09" }, SHARE, "10", "1240.80", "t1"),
        transferInRow({ portfolio: WALLET, date: "2025-07-09" }, SHARE, "10", "1240.80", {
          sourceLabel: "t1",
        }),
      ]),
    );

    // The destination is not part of the source's fingerprint, so the source
    // row is the one already written — and a skipped source writes no target.
    expect(reasonsOf(upgraded.outcomes)).toEqual([
      "ALREADY_IMPORTED",
      "ALREADY_IMPORTED",
      "ALREADY_IMPORTED",
      "COVERED_BY_TRANSFER_OUT",
    ]);
    expect(
      (await transferLegs(ids.tenantId)).map((leg) => [
        leg.portfolio,
        leg.kind,
        leg.source_portfolio,
      ]),
    ).toEqual([[EXCHANGE, "TRANSFER_OUT", null]]);
  });
});
