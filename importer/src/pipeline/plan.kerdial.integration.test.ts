import { createInstrumentByIsin, createInstrumentBySymbol } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planImport, type ImportPlan, type PlannedRowOutcome } from "./plan.js";
import {
  acquisitionRow,
  cashInRow,
  distributionRow,
  feeRow,
  interestRow,
  kerdialPlanContext,
  kerdialTally,
  parseKerdial,
  reinvestmentRow,
  seedBareTenant,
  settledAcquisitionRow,
  type Cells,
  type KerdialIds,
  type RowInstrument,
  type RowSite,
} from "./__tests__/kerdial-harness.js";

/**
 * EI-14 — `planImport`'s per-row destination, settlement resolution and
 * reinvestment pass 1, against a real Postgres
 * (`portfolio-export-import` FR-532/FR-533/FR-539,
 * AC-429, AC-448's plan half).
 *
 * Every suite below writes **nothing**: `planImport` reads the tenant's
 * directory and the instrument catalogue and decides, which is the whole point
 * of deciding the caps and the reinvestment links at plan time — a dry run that
 * promises a create the apply refuses is the divergence that is permitted
 * for exactly two apply-only codes, and none of these is one of them. The apply
 * half of AC-448 is `apply.kerdial.integration.test.ts`.
 */

const IDS: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-00000000e101",
  userId: "00000000-0000-7000-8000-00000000e102",
  sessionId: "00000000-0000-7000-8000-00000000e103",
};

/** A portfolio this tenant already holds, so the "matched by name" half of L11 has a subject. */
const EXISTING_PORTFOLIO = "00000000-0000-7000-8000-00000000e104";
const EXISTING_ACCOUNT = "00000000-0000-7000-8000-00000000e105";
const EXISTING_PORTFOLIO_NAME = "Existing portfolio";
const EXISTING_ACCOUNT_NAME = "Existing account";

/** The one instrument this suite's rows resolve against. */
const KNOWN_ISIN = "FRKERDEI4001";
const KNOWN_MIC = "XPAR";
/** A second listing of the **same** identifier on another venue — what makes `exchange_mic` load-bearing. */
const OTHER_MIC = "XAMS";
/** A ticker-keyed instrument, so a settled acquisition has an asset to be paid with. */
const SETTLEMENT_SYMBOL = "KRDEI4BTC";

const KNOWN: RowInstrument = { isin: KNOWN_ISIN, exchangeMic: KNOWN_MIC };

/** The suite's default site: the portfolio and account this tenant already holds. */
const site = (overrides: Partial<RowSite> = {}): RowSite => ({
  portfolio: EXISTING_PORTFOLIO_NAME,
  account: EXISTING_ACCOUNT_NAME,
  date: "2026-02-02",
  ...overrides,
});

const DEPOSIT: Cells = cashInRow(site(), "1000.00");
const BUY: Cells = acquisitionRow(site({ date: "2026-02-03" }), KNOWN, "3", "100.50");

function outcomeAt(plan: ImportPlan, index: number): PlannedRowOutcome {
  const outcome = plan.outcomes[index];
  if (outcome === undefined) throw new Error(`no outcome at index ${String(index)}`);
  return outcome;
}

function reasonAt(plan: ImportPlan, index: number): string {
  const outcome = outcomeAt(plan, index);
  if (outcome.outcome === "IMPORT") {
    throw new Error(`row ${String(index)} was planned for import, not refused`);
  }
  return outcome.reason;
}

describe("planImport over a Kerdial transactions file (EI-14)", () => {
  let pg: MigratedPostgres;
  let db: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedBareTenant(pg, IDS);
    await pg.ownerClient`
      INSERT INTO "portfolio" (id, tenant_id, name)
      VALUES (${EXISTING_PORTFOLIO}::uuid, ${IDS.tenantId}::uuid, ${EXISTING_PORTFOLIO_NAME})
    `;
    await pg.ownerClient`
      INSERT INTO "cash_account" (id, tenant_id, portfolio_id, name, currency)
      VALUES (${EXISTING_ACCOUNT}::uuid, ${IDS.tenantId}::uuid, ${EXISTING_PORTFOLIO}::uuid,
              ${EXISTING_ACCOUNT_NAME}, 'EUR')
    `;
    await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: KNOWN_ISIN,
      exchangeMic: KNOWN_MIC,
      listingCurrency: "EUR",
      displayName: "the resolvable listing",
    });
    await createInstrumentByIsin(db, {
      kind: "SHARE",
      isin: KNOWN_ISIN,
      exchangeMic: OTHER_MIC,
      listingCurrency: "EUR",
      displayName: "the same identifier on a second venue",
    });
    await createInstrumentBySymbol(db, {
      kind: "CRYPTO",
      symbol: SETTLEMENT_SYMBOL,
      listingCurrency: "EUR",
      displayName: "the settlement asset",
    });
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  describe("the destination each row names (FR-532/FR-533, AC-448's plan half)", () => {
    it("plans a bare create for a portfolio and an account the tenant does not have", async () => {
      const plan = await planImport(
        parseKerdial([
          cashInRow(site({ portfolio: "Fresh portfolio", account: "Fresh account" }), "1000.00"),
          acquisitionRow(
            site({ portfolio: "Fresh portfolio", account: "Fresh account", date: "2026-02-03" }),
            KNOWN,
            "3",
            "100.50",
          ),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 2 });
      // Bare: a name and nothing else. Every presentation field a catalogue
      // package would merge in is simply absent, which is FR-556's "either
      // package alone" stated as a shape.
      expect(plan.directory.portfolios).toHaveLength(1);
      expect(plan.directory.portfolios[0]?.name).toBe("Fresh portfolio");
      expect(Object.keys(plan.directory.portfolios[0] ?? {}).sort()).toStrictEqual(["id", "name"]);
      expect(plan.directory.cashAccounts).toHaveLength(1);
      expect(plan.directory.cashAccounts[0]?.name).toBe("Fresh account");
      expect(plan.directory.cashAccounts[0]?.currency).toBe("EUR");
      expect(plan.directory.cashAccounts[0]?.portfolioId).toBe(plan.directory.portfolios[0]?.id);
      // The two rows write into exactly the one portfolio the plan promises,
      // by the id the plan allocated — not by a name apply would re-resolve.
      for (const index of [0, 1]) {
        const outcome = outcomeAt(plan, index);
        expect(outcome.outcome).toBe("IMPORT");
        if (outcome.outcome === "IMPORT" && outcome.write.target === "TRANSACTION") {
          expect(outcome.write.portfolioId).toBe(plan.directory.portfolios[0]?.id);
          expect(outcome.write.cashAccountId).toBe(plan.directory.cashAccounts[0]?.id);
        }
      }
    });

    it("matches an existing portfolio and account by name, promising no create at all", async () => {
      const plan = await planImport(parseKerdial([DEPOSIT]), kerdialPlanContext(db, IDS.tenantId));

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 1 });
      expect(plan.directory).toStrictEqual({ portfolios: [], cashAccounts: [] });
      const outcome = outcomeAt(plan, 0);
      if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") {
        throw new Error("the deposit was expected to plan a transaction write");
      }
      expect(outcome.write.portfolioId).toBe(EXISTING_PORTFOLIO);
      expect(outcome.write.cashAccountId).toBe(EXISTING_ACCOUNT);
    });

    it("refuses only the row whose stated account currency disagrees, leaving the account's own currency out of it", async () => {
      const plan = await planImport(
        parseKerdial([
          DEPOSIT,
          cashInRow(site({ date: "2026-02-04", currency: "USD" }), "1000.00"),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({
        IMPORT: 1,
        CASH_ACCOUNT_CURRENCY_MISMATCH: 1,
      });
      expect(reasonAt(plan, 1)).toBe("CASH_ACCOUNT_CURRENCY_MISMATCH");
      // SD-14: the column is immutable by grant, so this path must not have
      // attempted a coercion — no create, no update, nothing planned for it.
      expect(plan.directory.cashAccounts).toHaveLength(0);
      const stored = await pg.ownerClient<{ currency: string }[]>`
        SELECT currency FROM "cash_account" WHERE id = ${EXISTING_ACCOUNT}::uuid
      `;
      expect(stored[0]?.currency).toBe("EUR");
    });

    it("plans an interest row's withholding as an amount on the principal's account", async () => {
      const plan = await planImport(
        parseKerdial([interestRow(site({ date: "2026-02-05" }), "100.00", { amount: "30.00" })]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 1 });
      const outcome = outcomeAt(plan, 0);
      if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") {
        throw new Error("the interest row was expected to plan a transaction write");
      }
      expect(outcome.write.kind).toBe("INTEREST");
      expect(outcome.write.instrumentId).toBeNull();
      expect(outcome.write.cashAccountId).toBe(EXISTING_ACCOUNT);
      expect(outcome.write.withholdingAmount?.toString()).toBe("30");
      // No account of its own: the directory plans nothing for it.
      expect(plan.directory.cashAccounts).toHaveLength(0);
    });

    it("refuses a request-level destination outright rather than half-honouring it", async () => {
      await expect(
        planImport(
          parseKerdial([DEPOSIT]),
          kerdialPlanContext(db, IDS.tenantId, {
            destination: { portfolioId: EXISTING_PORTFOLIO, cashAccountId: EXISTING_ACCOUNT },
          }),
        ),
      ).rejects.toThrow(/cannot be honoured/u);
    });
  });

  describe("FR-539 — the caps bind at plan time, measured at two injected values", () => {
    /** One row naming a portfolio this tenant does not have, so the cap is the only thing that can refuse it. */
    const newPortfolioRow: Cells = cashInRow(
      site({ portfolio: "Cap subject", account: "Cap account" }),
      "1000.00",
    );

    it("plans the create when the tenant is one below the cap, and refuses it at the cap", async () => {
      // One portfolio exists (the suite's own). At a cap of 2 the file's new
      // one fits; at a cap of 1 it does not. Injected rather than seeded,
      // because proving a cap of 500 by creating 499 portfolios is not a test
      // anybody runs — `createPortfolio` takes the identical parameter for the
      // identical reason, and `applyImport` forwards this one to it.
      const under = await planImport(
        parseKerdial([newPortfolioRow]),
        kerdialPlanContext(db, IDS.tenantId, { maxPortfoliosPerTenant: 2 }),
      );
      expect(kerdialTally(under.outcomes)).toEqual({ IMPORT: 1 });
      expect(under.directory.portfolios).toHaveLength(1);

      const at = await planImport(
        parseKerdial([newPortfolioRow]),
        kerdialPlanContext(db, IDS.tenantId, { maxPortfoliosPerTenant: 1 }),
      );
      expect(kerdialTally(at.outcomes)).toEqual({ PORTFOLIO_CAP_EXCEEDED: 1 });
      expect(at.directory.portfolios).toHaveLength(0);
    });

    it("refuses a new account in a portfolio already at the account cap", async () => {
      const row: Cells = cashInRow(site({ account: "Second account" }), "1000.00");
      const under = await planImport(
        parseKerdial([row]),
        kerdialPlanContext(db, IDS.tenantId, { maxCashAccountsPerPortfolio: 2 }),
      );
      expect(kerdialTally(under.outcomes)).toEqual({ IMPORT: 1 });

      const at = await planImport(
        parseKerdial([row]),
        kerdialPlanContext(db, IDS.tenantId, { maxCashAccountsPerPortfolio: 1 }),
      );
      expect(kerdialTally(at.outcomes)).toEqual({ CASH_ACCOUNT_CAP_EXCEEDED: 1 });
    });
  });

  describe("instrument resolution reads the stated market identifier", () => {
    it("picks the listing the row names, out of two that share the identifier", async () => {
      const plan = await planImport(
        parseKerdial([
          acquisitionRow(
            site({ date: "2026-02-03" }),
            { isin: KNOWN_ISIN, exchangeMic: OTHER_MIC },
            "3",
            "100.50",
          ),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 1 });
      const outcome = outcomeAt(plan, 0);
      if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") {
        throw new Error("the trade was expected to plan a transaction write");
      }
      const listing = await pg.ownerClient<{ exchange_mic: string }[]>`
        SELECT exchange_mic FROM "instrument" WHERE id = ${outcome.write.instrumentId}::uuid
      `;
      // The row stated the venue in a column of its own; without reading it,
      // the identifier alone matches two listings and the row would be
      // INSTRUMENT_AMBIGUOUS instead.
      expect(listing[0]?.exchange_mic).toBe(OTHER_MIC);
    });

    it("rejects a settled acquisition whose settlement asset does not resolve — and does not demote it to a cash-settled one", async () => {
      const plan = await planImport(
        parseKerdial([
          settledAcquisitionRow(site({ date: "2026-02-03" }), KNOWN, "3", {
            symbol: "NOSUCHASSET",
            amount: "0.5",
          }),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ SETTLEMENT_INSTRUMENT_NOT_RESOLVED: 1 });
      // The look-alike this must be distinguished from: an ordinary
      // cash-settled acquisition of the same instrument, which would have
      // planned an `IMPORT` with no settlement leg and written a *different*
      // row. Asserted as an absence, because that is the bug's actual shape.
      expect(outcomeAt(plan, 0).outcome).not.toBe("IMPORT");
    });

    it("resolves a FEE's optional instrument reference like a trade's, and plans no instrument when it names none (portfolio-cash)", async () => {
      const plan = await planImport(
        parseKerdial([
          feeRow(site({ date: "2026-02-04" }), "12.50", KNOWN),
          feeRow(site({ date: "2026-02-04" }), "7.00"),
          feeRow(site({ date: "2026-02-04" }), "3.00", {
            isin: "FRKERDEI4999",
            exchangeMic: KNOWN_MIC,
          }),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 2, INSTRUMENT_NOT_RESOLVED: 1 });
      const referenced = outcomeAt(plan, 0);
      const bare = outcomeAt(plan, 1);
      if (
        referenced.outcome !== "IMPORT" ||
        referenced.write.target !== "TRANSACTION" ||
        bare.outcome !== "IMPORT" ||
        bare.write.target !== "TRANSACTION"
      ) {
        throw new Error("both fee rows were expected to plan a transaction write");
      }
      expect(referenced.write.kind).toBe("FEE");
      const listing = await pg.ownerClient<{ isin: string; exchange_mic: string }[]>`
        SELECT isin, exchange_mic FROM "instrument" WHERE id = ${referenced.write.instrumentId}::uuid
      `;
      expect(listing[0]).toEqual({ isin: KNOWN_ISIN, exchange_mic: KNOWN_MIC });
      expect(bare.write.kind).toBe("FEE");
      expect(bare.write.instrumentId).toBeNull();
      expect(bare.write.cashAccountId).toBe(EXISTING_ACCOUNT);
      expect(reasonAt(plan, 2)).toBe("INSTRUMENT_NOT_RESOLVED");
    });

    it("plans the settled acquisition when the settlement asset does resolve", async () => {
      const plan = await planImport(
        parseKerdial([
          settledAcquisitionRow(site({ date: "2026-02-03" }), KNOWN, "3", {
            symbol: SETTLEMENT_SYMBOL,
            amount: "0.5",
          }),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 1 });
      const outcome = outcomeAt(plan, 0);
      if (outcome.outcome !== "IMPORT" || outcome.write.target !== "TRANSACTION") {
        throw new Error("the settled acquisition was expected to plan a transaction write");
      }
      expect(outcome.write.settlementInstrumentId).not.toBeNull();
      expect(outcome.write.settlementAmount?.toFixed(2)).toBe("0.50");
    });
  });

  describe("reinvestment pass 1 — the source, in both directions", () => {
    const LABEL = "d1";
    const DIVIDEND: Cells = distributionRow(site({ date: "2026-03-02" }), KNOWN, "42.00", LABEL);
    const DRIP: Cells = reinvestmentRow(
      site({ date: "2026-03-03" }),
      KNOWN,
      "0.4",
      "105.00",
      LABEL,
    );

    it("resolves a label a distribution row of the same file declares", async () => {
      const plan = await planImport(
        parseKerdial([DIVIDEND, DRIP]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 2 });
      const dividend = outcomeAt(plan, 0);
      const reinvestment = outcomeAt(plan, 1);
      if (
        dividend.outcome !== "IMPORT" ||
        dividend.write.target !== "TRANSACTION" ||
        reinvestment.outcome !== "IMPORT" ||
        reinvestment.write.target !== "TRANSACTION"
      ) {
        throw new Error("both rows were expected to plan transaction writes");
      }
      // The link is resolved to the id the source row will be written with,
      // not merely to its position — which is what lets `kd1` hash it.
      expect(reinvestment.write.sourceDividendId).toBe(dividend.write.id);
      expect(reinvestment.write.sourceRowPosition).toBe(0);
    });

    it("refuses a label no row of the file declares", async () => {
      const plan = await planImport(
        parseKerdial([
          DIVIDEND,
          reinvestmentRow(site({ date: "2026-03-03" }), KNOWN, "0.4", "105.00", "nosuchlabel"),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 1, DRIP_SOURCE_NOT_RESOLVED: 1 });
      expect(reasonAt(plan, 1)).toBe("DRIP_SOURCE_NOT_RESOLVED");
    });

    it("refuses a label declared by a row that is itself refused", async () => {
      // The distribution names an account whose currency disagrees with the
      // one it already has, so it is rejected — and the reinvestment that
      // points at it then has nothing to attach to. Two rows, two different
      // reasons, and neither is reported as the other's.
      const plan = await planImport(
        parseKerdial([
          distributionRow(site({ date: "2026-03-02", currency: "USD" }), KNOWN, "42.00", LABEL),
          DRIP,
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({
        CASH_ACCOUNT_CURRENCY_MISMATCH: 1,
        DRIP_SOURCE_NOT_RESOLVED: 1,
      });
      expect(reasonAt(plan, 1)).toBe("DRIP_SOURCE_NOT_RESOLVED");
    });

    it("refuses a reinvestment its source would be written after", async () => {
      // The source-before-reinvestment ordering, asserted rather than assumed: the file lists
      // the reinvestment a day *before* the distribution it reinvests, so the
      // source's id would not exist yet at the moment the row is written.
      const plan = await planImport(
        parseKerdial([
          distributionRow(site({ date: "2026-03-05" }), KNOWN, "42.00", LABEL),
          reinvestmentRow(site({ date: "2026-03-04" }), KNOWN, "0.4", "105.00", LABEL),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 1, DRIP_SOURCE_NOT_RESOLVED: 1 });
      expect(reasonAt(plan, 1)).toBe("DRIP_SOURCE_NOT_RESOLVED");
    });
  });

  describe("AC-429 — one unplannable row changes no other row's outcome", () => {
    it("plans every other row of a file whose third row names an unknown instrument", async () => {
      const plan = await planImport(
        parseKerdial([
          DEPOSIT,
          BUY,
          acquisitionRow(
            site({ date: "2026-02-05" }),
            { isin: "FRKERDEI4999", exchangeMic: "XPAR" },
            "3",
            "100.50",
          ),
          acquisitionRow(site({ date: "2026-02-06" }), KNOWN, "3", "100.50"),
          cashInRow(site({ date: "2026-02-07" }), "1000.00"),
        ]),
        kerdialPlanContext(db, IDS.tenantId),
      );

      expect(plan.rowCount).toBe(5);
      expect(kerdialTally(plan.outcomes)).toEqual({ IMPORT: 4, INSTRUMENT_NOT_RESOLVED: 1 });
      expect(reasonAt(plan, 2)).toBe("INSTRUMENT_NOT_RESOLVED");
      // The exhaustiveness invariant, restated at this layer: one outcome per
      // data row, in file order, whatever any of them decided.
      expect(plan.outcomes).toHaveLength(5);
      expect(plan.applyOrder).toHaveLength(4);
    });
  });
});
