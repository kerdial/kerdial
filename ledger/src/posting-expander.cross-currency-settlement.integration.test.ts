import { randomUUID } from "node:crypto";
import { Decimal } from "@kerdial/core-decimal";
import {
  cashAccount,
  cashBalance,
  holdingState,
  instrument,
  portfolio,
  tenant,
  transaction,
  transactionPosting,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeAndInvalidate } from "./materialization.js";
import {
  expandPostings,
  type ExpandableTransaction,
  type PostingDraft,
} from "./posting-expander.js";
import { testMinorUnitOf } from "./posting-expander.test-support.js";

/**
 * **AC-274 — phase 1's conformance gate: one worked example per case D1–D5**
 * (AC-263, AC-264, AC-265, AC-266; FR-234, FR-239, FR-242, FR-245).
 *
 * The five cases are the whole of phase 1's behaviour space, named by the
 * relation between the **a**ccount's currency `A`, the **t**ransaction's `T`
 * and the tenant's **b**ase `B`:
 *
 * | | shape | settled |
 * |---|---|---|
 * | **D1** | `A = T = B` | degenerately — the pre-phase-1 code path |
 * | **D2** | `A = T ≠ B` | degenerately — today's cross-currency world |
 * | **D3** | `T = B ≠ A` | in a third currency (base-denominated trade, foreign account) |
 * | **D4** | `A = B ≠ T` | in a third currency (**the user's own case**: a USD trade off a EUR account) |
 * | **D5** | `A ≠ T ≠ B ≠ A` | in a third currency (all three differ) |
 *
 * ## Why every figure below is written out rather than computed
 *
 * A conformance suite that recomputed its own expectations from the
 * expander's formulae would pass for any expander that was self-consistent,
 * including a wrong one. Every `amount_native`, `amount_base`,
 * `fx_rate_applied`, `currency`, `seq`, `flow_class`, `cost_basis_base`,
 * `cost_basis_native` and post-write `cash_balance` here is a literal, taken
 * from the hand computations for D3/D4/D5 and hand-derived on the
 * same rules for D1/D2. Each case is asserted in its **own** `it`, never by
 * looping a list — a loop whose list is empty is the failure mode this
 * project has recorded, and it is the one an `AC-274`-shaped gate must not
 * have.
 *
 * The rate figures are written at **`numeric(28,12)`**, the scale
 * `transaction_posting.fx_rate_applied` stores, and both halves of this file
 * compare at that scale: the in-memory draft via `toFixed(12)`, the persisted
 * row as it reads back. `amount_base` is compared at full precision, because
 * it is the authoritative figure and nothing rounds it.
 *
 * ## Two halves, and why the second one needs a database
 *
 * The first half grades {@link expandPostings} directly — that is where every
 * phase-1 rule lives. The second half persists the same five rows and runs the
 * **real** {@link recomputeAndInvalidate}, because `cash_balance` and
 * `holding_state` are SQL projections and "the CHF balance rose by 960,00 and
 * **no EUR balance row exists for that account**" (AC-266) is a statement about
 * a table, not about an array. The rows are inserted directly rather than
 * written through `TransactionWriteService`: the service does not learn to
 * accept a cross-currency settlement until Batch B (FT-12), and this suite's
 * subject is the expansion and its projection, not the writer. Everything the
 * materialiser reads is seeded exactly as the writer will produce it — the
 * `transaction` row through the real schema (so all 31 CHECKs and the
 * re-pointed `transaction_cash_account_fk` grade the fixture too) and its
 * postings through the real {@link expandPostings}.
 */

const TENANT = "00000000-0000-7000-8000-00000fee7a01";
const USER_PORTFOLIO_PREFIX = "00000000-0000-7000-8000-00000fee7b0";
const AAPL = "00000000-0000-7000-8000-00000fee7c01";
const ETH = "00000000-0000-7000-8000-00000fee7c02";
const BTC = "00000000-0000-7000-8000-00000fee7c03";

/** One account per case, so every balance assertion is over that case's own portfolio. */
const ACCOUNT = {
  d1: "00000000-0000-7000-8000-00000fee7d01",
  d2: "00000000-0000-7000-8000-00000fee7d02",
  d3: "00000000-0000-7000-8000-00000fee7d03",
  d4: "00000000-0000-7000-8000-00000fee7d04",
  d5: "00000000-0000-7000-8000-00000fee7d05",
} as const;

/**
 * The `transaction` columns {@link expandPostings} reads, per case. Spelled out
 * in full rather than layered over a shared default: a default that silently
 * supplied `cash_currency` would be the one field this file exists to grade.
 */
interface WorkedCase {
  readonly label: string;
  readonly row: ExpandableTransaction;
  /** Everything the row needs to exist in the database but the expander never reads. */
  readonly unitPrice: Decimal | null;
  readonly accountCurrency: string;
  readonly portfolioId: string;
  /**
   * Whether {@link recomputeAndInvalidate} runs for this case. False for the
   * asset-settled row only: its `SETTLEMENT_ASSET` leg disposes 0,1 BTC, and
   * `replayPositions` rejects that as an over-sell unless the portfolio already
   * holds BTC — correct behaviour, older than phase 1 and nothing to do with
   * it. Giving that portfolio a prior BTC acquisition would give it a cash
   * balance too, which is the one thing AC-263's assertion is about the absence
   * of. So AC-263 is asserted over `transaction` and `transaction_posting`, the
   * two tables phase 1 actually writes, and not through the materialiser.
   */
  readonly materialise: boolean;
}

function fiatBuy(params: {
  quantity: string;
  unitPrice: string;
  txnCurrency: string;
  fxRate: string;
  fxRateSource: ExpandableTransaction["fxRateSource"];
  cashCurrency: string;
  cashAmount: string;
  cashAccountId: string;
}): ExpandableTransaction {
  return {
    kind: "BUY",
    instrumentId: AAPL,
    quantity: new Decimal(params.quantity),
    grossAmount: new Decimal(params.quantity).times(new Decimal(params.unitPrice)),
    txnCurrency: params.txnCurrency,
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: params.cashAccountId,
    targetCashAccountId: null,
    cashCurrency: params.cashCurrency,
    cashAmount: new Decimal(params.cashAmount),
    feeAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: null,
    fxRate: new Decimal(params.fxRate),
    fxRateSource: params.fxRateSource,
  };
}

/** **D1** — `A = T = B`: 10 units at 100,00 EUR, EUR base, EUR account, `fx_rate = 1` (`IMPLIED_BASE`). */
const D1: WorkedCase = {
  label: "D1",
  materialise: true,
  portfolioId: `${USER_PORTFOLIO_PREFIX}1`,
  accountCurrency: "EUR",
  unitPrice: new Decimal("100.00"),
  row: fiatBuy({
    quantity: "10",
    unitPrice: "100.00",
    txnCurrency: "EUR",
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    cashCurrency: "EUR",
    cashAmount: "1000.00",
    cashAccountId: ACCOUNT.d1,
  }),
};

/** **D2** — `A = T ≠ B`: the same USD trade as D4, settled from a **USD** account. Today's cross-currency world. */
const D2: WorkedCase = {
  label: "D2",
  materialise: true,
  portfolioId: `${USER_PORTFOLIO_PREFIX}2`,
  accountCurrency: "USD",
  unitPrice: new Decimal("150.00"),
  row: fiatBuy({
    quantity: "10",
    unitPrice: "150.00",
    txnCurrency: "USD",
    fxRate: "0.92",
    fxRateSource: "USER_PINNED",
    cashCurrency: "USD",
    cashAmount: "1500.00",
    cashAccountId: ACCOUNT.d2,
  }),
};

/** **D3** (AC-266) — `T = B ≠ A`: a DEPOSIT of 1 000,00 EUR landing in a **CHF** account for 960,00 CHF. */
const D3: WorkedCase = {
  label: "D3",
  materialise: true,
  portfolioId: `${USER_PORTFOLIO_PREFIX}3`,
  accountCurrency: "CHF",
  unitPrice: null,
  row: {
    kind: "DEPOSIT",
    instrumentId: null,
    quantity: null,
    grossAmount: new Decimal("1000.00"),
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: ACCOUNT.d3,
    targetCashAccountId: null,
    cashCurrency: "CHF",
    cashAmount: new Decimal("960.00"),
    feeAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: null,
    fxRate: new Decimal("1"),
    fxRateSource: "IMPLIED_BASE",
  },
};

/** **D4** (AC-264) — `A = B ≠ T`: BUY 10 AAPL at 150,00 USD, `fx_rate = 0,92`, settled from a **EUR** account for 1 380,00 EUR. */
const D4: WorkedCase = {
  label: "D4",
  materialise: true,
  portfolioId: `${USER_PORTFOLIO_PREFIX}4`,
  accountCurrency: "EUR",
  unitPrice: new Decimal("150.00"),
  row: fiatBuy({
    quantity: "10",
    unitPrice: "150.00",
    txnCurrency: "USD",
    fxRate: "0.92",
    fxRateSource: "USER_PINNED",
    cashCurrency: "EUR",
    // L11: in D4 the *rate* is authoritative, so the debit is `gross × fx_rate`.
    cashAmount: "1380.00",
    cashAccountId: ACCOUNT.d4,
  }),
};

/** **D5** (AC-265) — all three differ: BUY 10 at 100,00 USD, `fx_rate = 0,90` to EUR base, settled from a **CHF** account for 880,00 CHF. */
const D5: WorkedCase = {
  label: "D5",
  materialise: true,
  portfolioId: `${USER_PORTFOLIO_PREFIX}5`,
  accountCurrency: "CHF",
  unitPrice: new Decimal("100.00"),
  row: fiatBuy({
    quantity: "10",
    unitPrice: "100.00",
    txnCurrency: "USD",
    fxRate: "0.90",
    fxRateSource: "PROVIDER",
    cashCurrency: "CHF",
    cashAmount: "880.00",
    cashAccountId: ACCOUNT.d5,
  }),
};

/** AC-263's asset-settled row: 2 ETH paid for with 0,1 BTC — no cash denomination at all (FR-236). */
const CRYPTO: WorkedCase = {
  label: "crypto",
  materialise: false,
  portfolioId: `${USER_PORTFOLIO_PREFIX}6`,
  accountCurrency: "EUR",
  unitPrice: new Decimal("0.05"),
  row: {
    kind: "BUY",
    instrumentId: ETH,
    quantity: new Decimal("2"),
    grossAmount: new Decimal("0.1"),
    txnCurrency: null,
    txnSettlementInstrumentId: BTC,
    targetCurrency: null,
    targetAmount: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    feeAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: null,
    fxRate: new Decimal("60000"),
    fxRateSource: "USER_PINNED",
  },
};

const ALL_CASES = [D1, D2, D3, D4, D5, CRYPTO] as const;

/**
 * A posting rendered to plain, comparable values. `fx_rate_applied` at the
 * column's own `numeric(28,12)` scale — the figure the hand
 * computations are written at, and the figure that is stored; the low digits
 * of the in-memory quotient are not part of anything this system persists.
 */
interface RenderedPosting {
  readonly seq: number;
  readonly leg: string;
  readonly currency: string | null;
  readonly cashAccountId: string | null;
  readonly quantityDelta: string | null;
  readonly amountNative: string;
  readonly amountBase: string;
  readonly fxRateApplied: string;
  readonly fxRateSource: string;
  readonly flowClass: string;
}

function render(draft: PostingDraft): RenderedPosting {
  return {
    seq: draft.seq,
    leg: draft.leg,
    // `?? null` rather than `=== null`: `PostingDraft` is a `Pick` of an
    // *insert* type, so every nullable column is `T | null | undefined`. The
    // expander always writes an explicit `null`, and collapsing the two here
    // keeps that from being something this file has to restate per field.
    currency: draft.currency?.trim() ?? null,
    cashAccountId: draft.cashAccountId ?? null,
    quantityDelta: draft.quantityDelta?.toString() ?? null,
    amountNative: draft.amountNative.toString(),
    amountBase: draft.amountBase.toString(),
    fxRateApplied: draft.fxRateApplied.toFixed(12),
    fxRateSource: draft.fxRateSource,
    flowClass: draft.flowClass,
  };
}

/** The two `amount_base` figures of a trade cancel exactly — at full precision, never a tolerance. */
function expectBaseSumsToZero(drafts: readonly PostingDraft[]): void {
  const total = drafts.reduce((sum, draft) => sum.plus(draft.amountBase), new Decimal(0));
  expect(total.isZero()).toBe(true);
}

describe("expandPostings — D1–D5 conformance, one worked example per case (AC-274)", () => {
  it("D1 — `A = T = B`: 10 at 100,00 EUR from a EUR account, base EUR", () => {
    const drafts = expandPostings(D1.row, testMinorUnitOf);
    expect(drafts).toHaveLength(2);
    expect(render(drafts[0]!)).toEqual({
      seq: 1,
      leg: "POSITION",
      currency: null,
      cashAccountId: null,
      quantityDelta: "10",
      amountNative: "1000",
      amountBase: "1000",
      fxRateApplied: "1.000000000000",
      fxRateSource: "IMPLIED_BASE",
      flowClass: "INTERNAL",
    });
    expect(render(drafts[1]!)).toEqual({
      seq: 2,
      leg: "CASH",
      currency: "EUR",
      cashAccountId: ACCOUNT.d1,
      quantityDelta: null,
      amountNative: "-1000",
      amountBase: "-1000",
      // The **copied** `fx_rate`, not a quotient (FR-241): the degenerate
      // branch reaches no division at all.
      fxRateApplied: "1.000000000000",
      fxRateSource: "IMPLIED_BASE",
      flowClass: "INTERNAL",
    });
    expectBaseSumsToZero(drafts);
  });

  it("D2 — `A = T ≠ B`: 10 AAPL at 150,00 USD from a USD account, base EUR at 0,92", () => {
    const drafts = expandPostings(D2.row, testMinorUnitOf);
    expect(drafts).toHaveLength(2);
    expect(render(drafts[0]!)).toEqual({
      seq: 1,
      leg: "POSITION",
      currency: null,
      cashAccountId: null,
      quantityDelta: "10",
      amountNative: "1500",
      amountBase: "1380",
      fxRateApplied: "0.920000000000",
      fxRateSource: "USER_PINNED",
      flowClass: "INTERNAL",
    });
    expect(render(drafts[1]!)).toEqual({
      seq: 2,
      leg: "CASH",
      currency: "USD",
      cashAccountId: ACCOUNT.d2,
      quantityDelta: null,
      // The account's currency **is** the trade's here, so the cash leg is
      // 1 500,00 USD and its rate is the stored one — byte for byte what the
      // pre-phase-1 expander emitted for this row.
      amountNative: "-1500",
      amountBase: "-1380",
      fxRateApplied: "0.920000000000",
      fxRateSource: "USER_PINNED",
      flowClass: "INTERNAL",
    });
    expectBaseSumsToZero(drafts);
  });

  it("D3 (AC-266) — `T = B ≠ A`: a 1 000,00 EUR deposit landing in a CHF account for 960,00", () => {
    const drafts = expandPostings(D3.row, testMinorUnitOf);
    expect(drafts).toHaveLength(1);
    expect(render(drafts[0]!)).toEqual({
      seq: 1,
      leg: "CASH",
      // The **account's** currency, not the transaction's.
      currency: "CHF",
      cashAccountId: ACCOUNT.d3,
      quantityDelta: null,
      amountNative: "960",
      // `gross_amount × fx_rate` = 1 000,00 × 1 — the trade's base value,
      // carried across value-neutrally (FR-234).
      amountBase: "1000",
      // 1 000,00 / 960,00, at the column's scale.
      fxRateApplied: "1.041666666667",
      fxRateSource: "IMPLIED_BASE",
      // Unchanged by the settlement currency — `flow-class.ts` reads the kind.
      flowClass: "EXTERNAL",
    });
  });

  it("D4 (AC-264) — `A = B ≠ T`: 10 AAPL at 150,00 USD debited 1 380,00 from a EUR account", () => {
    const drafts = expandPostings(D4.row, testMinorUnitOf);
    expect(drafts).toHaveLength(2);
    expect(render(drafts[0]!)).toEqual({
      seq: 1,
      leg: "POSITION",
      currency: null,
      cashAccountId: null,
      quantityDelta: "10",
      // NG5: the position leg is untouched by where the money came from —
      // still 1 500,00 USD at 0,92.
      amountNative: "1500",
      amountBase: "1380",
      fxRateApplied: "0.920000000000",
      fxRateSource: "USER_PINNED",
      flowClass: "INTERNAL",
    });
    expect(render(drafts[1]!)).toEqual({
      seq: 2,
      leg: "CASH",
      currency: "EUR",
      cashAccountId: ACCOUNT.d4,
      quantityDelta: null,
      amountNative: "-1380",
      amountBase: "-1380",
      // The account is denominated in the base currency, so its implied rate
      // to base is exactly 1 — derived, not copied: the stored `fx_rate` is
      // 0,92 and appears on the position leg above.
      fxRateApplied: "1.000000000000",
      fxRateSource: "USER_PINNED",
      flowClass: "INTERNAL",
    });
    expectBaseSumsToZero(drafts);
  });

  it("D5 (AC-265) — all three differ: 1 000,00 USD at 0,90 to EUR base, debited 880,00 CHF", () => {
    const drafts = expandPostings(D5.row, testMinorUnitOf);
    expect(drafts).toHaveLength(2);
    expect(render(drafts[0]!)).toEqual({
      seq: 1,
      leg: "POSITION",
      currency: null,
      cashAccountId: null,
      quantityDelta: "10",
      amountNative: "1000",
      amountBase: "900",
      fxRateApplied: "0.900000000000",
      fxRateSource: "PROVIDER",
      flowClass: "INTERNAL",
    });
    expect(render(drafts[1]!)).toEqual({
      seq: 2,
      leg: "CASH",
      currency: "CHF",
      cashAccountId: ACCOUNT.d5,
      quantityDelta: null,
      amountNative: "-880",
      amountBase: "-900",
      // 900,00 / 880,00 at `numeric(28,12)`.
      fxRateApplied: "1.022727272727",
      fxRateSource: "PROVIDER",
      flowClass: "INTERNAL",
    });
    expectBaseSumsToZero(drafts);
  });

  it("AC-265 — `amount_base` is authoritative: 880,00 × 1,022727272727 ≠ the stored 900,00", () => {
    const cash = expandPostings(D5.row, testMinorUnitOf)[1]!;
    const storedRate = new Decimal(cash.fxRateApplied.toFixed(12));
    const recomputed = cash.amountNative.abs().times(storedRate);

    // Hand-computed, not derived from the line above.
    expect(recomputed.toString()).toBe("899.99999999976");
    expect(recomputed.equals(new Decimal("900"))).toBe(false);
    // ...and it is `amount_base` that the ledger carries. An implementation that made
    // the two agree by rounding `amount_base` would have broken sum-to-zero,
    // which the D5 case above asserts at full precision.
    expect(cash.amountBase.toString()).toBe("-900");
    expect(cash.amountBase.abs().minus(recomputed).toString()).toBe("0.00000000024");
  });

  it("AC-263 — an asset-settled BUY emits no CASH leg and reads no cash denomination", () => {
    const drafts = expandPostings(CRYPTO.row, testMinorUnitOf);
    expect(drafts.map((draft) => draft.leg)).toEqual(["POSITION", "POSITION"]);
    expect(drafts.some((draft) => draft.leg === "CASH")).toBe(false);
    expect(drafts.every((draft) => draft.cashAccountId === null)).toBe(true);
    // The three columns phase 1 leaves NULL on this shape are NULL on the
    // input, and the expander reached none of them — the positive companion to
    // the persistence assertion below.
    expect(CRYPTO.row.cashCurrency).toBeNull();
    expect(CRYPTO.row.cashAmount).toBeNull();
    expect(CRYPTO.row.cashAccountId).toBeNull();
  });
});

describe("expandPostings — D1–D5 conformance, the persisted projection (AC-274, AC-266)", () => {
  let pg: MigratedPostgres;
  let ownerDb: Db;

  /** `transaction.seq` is monotonic **per tenant**, not per portfolio. */
  let nextSeq = 0n;

  async function persist(worked: WorkedCase): Promise<void> {
    nextSeq += 1n;
    await ownerDb
      .insert(portfolio)
      .values({ id: worked.portfolioId, tenantId: TENANT, name: `phase-1 ${worked.label}` });
    if (worked.row.cashAccountId !== null) {
      await ownerDb.insert(cashAccount).values({
        id: worked.row.cashAccountId,
        tenantId: TENANT,
        portfolioId: worked.portfolioId,
        name: `Compte ${worked.accountCurrency}`,
        currency: worked.accountCurrency,
      });
    }
    const transactionId = randomUUID();
    await ownerDb.insert(transaction).values({
      baseCurrency: "EUR",
      id: transactionId,
      tenantId: TENANT,
      portfolioId: worked.portfolioId,
      kind: worked.row.kind,
      tradeDate: "2025-03-04",
      seq: nextSeq,
      instrumentId: worked.row.instrumentId,
      quantity: worked.row.quantity,
      unitPrice: worked.unitPrice,
      grossAmount: worked.row.grossAmount,
      txnCurrency: worked.row.txnCurrency,
      txnSettlementInstrumentId: worked.row.txnSettlementInstrumentId,
      cashCurrency: worked.row.cashCurrency,
      cashAmount: worked.row.cashAmount,
      cashAccountId: worked.row.cashAccountId,
      fxRate: worked.row.fxRate,
      fxRateSource: worked.row.fxRateSource,
    });
    const drafts = expandPostings(worked.row, testMinorUnitOf);
    await ownerDb.insert(transactionPosting).values(
      drafts.map((draft) => ({
        ...draft,
        id: randomUUID(),
        tenantId: TENANT,
        baseCurrency: "EUR",
        transactionId,
        portfolioId: worked.portfolioId,
      })),
    );
    if (!worked.materialise) return;
    await withTenant(ownerDb, TENANT, async (tx) => {
      await recomputeAndInvalidate(tx, {
        tenantId: TENANT,
        portfolioId: worked.portfolioId,
        minTradeDate: "2025-03-04",
      });
    });
  }

  /** Every `cash_balance` row of one portfolio — the *full* set, so an absence assertion is over it. */
  async function balances(
    portfolioId: string,
  ): Promise<{ cashAccountId: string; currency: string; amount: string }[]> {
    const rows = await ownerDb
      .select()
      .from(cashBalance)
      .where(and(eq(cashBalance.tenantId, TENANT), eq(cashBalance.portfolioId, portfolioId)))
      .orderBy(asc(cashBalance.currency));
    return rows.map((row) => ({
      cashAccountId: row.cashAccountId,
      currency: row.currency.trim(),
      amount: row.amount.toString(),
    }));
  }

  async function holding(
    portfolioId: string,
  ): Promise<{ quantity: string; costBasisBase: string; costBasisNative: string }> {
    const rows = await ownerDb
      .select()
      .from(holdingState)
      .where(and(eq(holdingState.tenantId, TENANT), eq(holdingState.portfolioId, portfolioId)));
    expect(rows).toHaveLength(1);
    return {
      quantity: rows[0]!.quantity.toString(),
      costBasisBase: rows[0]!.costBasisBase.toString(),
      costBasisNative: rows[0]!.costBasisNative.toString(),
    };
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerDb = pg.ownerDb;

    await ownerDb.insert(tenant).values({ id: TENANT });
    await ownerDb.insert(instrument).values([
      {
        id: AAPL,
        kind: "SHARE",
        // Fixture identifiers, not the real security's: the seeded catalogue
        // already carries the genuine ISINs and symbols, and colliding with one
        // would make this suite's failure mode a duplicate-key error instead of
        // an assertion.
        displayName: "Phase-1 fixture share (USD)",
        listingCurrency: "USD",
        exchangeMic: "XNAS",
        isin: "XX000000FE01",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
      },
      {
        id: ETH,
        kind: "CRYPTO",
        displayName: "Phase-1 fixture crypto A",
        listingCurrency: "EUR",
        symbol: "FTETH",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
      {
        id: BTC,
        kind: "CRYPTO",
        displayName: "Phase-1 fixture crypto B",
        listingCurrency: "EUR",
        symbol: "FTBTC",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
      },
    ]);
    for (const worked of ALL_CASES) {
      await persist(worked);
    }
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("D1 — one EUR balance of −1 000,00, cost basis 1 000,00 / 1 000,00", async () => {
    expect(await balances(D1.portfolioId)).toEqual([
      { cashAccountId: ACCOUNT.d1, currency: "EUR", amount: "-1000" },
    ]);
    expect(await holding(D1.portfolioId)).toEqual({
      quantity: "10",
      costBasisBase: "1000",
      costBasisNative: "1000",
    });
  });

  it("D2 — one USD balance of −1 500,00, cost basis 1 380,00 base / 1 500,00 native", async () => {
    expect(await balances(D2.portfolioId)).toEqual([
      { cashAccountId: ACCOUNT.d2, currency: "USD", amount: "-1500" },
    ]);
    expect(await holding(D2.portfolioId)).toEqual({
      quantity: "10",
      costBasisBase: "1380",
      costBasisNative: "1500",
    });
  });

  it("D3 (AC-266) — the CHF balance rises by exactly 960,00 and no EUR row exists for that account", async () => {
    const rows = await balances(D3.portfolioId);
    // Asserted over the portfolio's **whole** balance set, not over the CHF
    // row alone: "no EUR row was created" is the half a single-row lookup
    // cannot see, and it is the half a cash leg left in `txn_currency` would
    // fail.
    expect(rows).toEqual([{ cashAccountId: ACCOUNT.d3, currency: "CHF", amount: "960" }]);
    expect(rows.some((row) => row.currency === "EUR")).toBe(false);
  });

  it("D4 (AC-264) — the EUR account falls by exactly 1 380,00 while cost basis stays 1 500,00 USD", async () => {
    expect(await balances(D4.portfolioId)).toEqual([
      { cashAccountId: ACCOUNT.d4, currency: "EUR", amount: "-1380" },
    ]);
    // NG5, stated as a figure: the settling account's denomination reaches
    // neither cost-basis column. `cost_basis_native` is still USD.
    expect(await holding(D4.portfolioId)).toEqual({
      quantity: "10",
      costBasisBase: "1380",
      costBasisNative: "1500",
    });
  });

  it("D5 (AC-265) — the CHF account falls by exactly 880,00, cost basis 900,00 / 1 000,00", async () => {
    expect(await balances(D5.portfolioId)).toEqual([
      { cashAccountId: ACCOUNT.d5, currency: "CHF", amount: "-880" },
    ]);
    expect(await holding(D5.portfolioId)).toEqual({
      quantity: "10",
      costBasisBase: "900",
      costBasisNative: "1000",
    });
  });

  it("AC-263 — a crypto-settled BUY persists with no cash_currency, no cash_amount and no cash_account_id", async () => {
    const rows = await ownerDb
      .select()
      .from(transaction)
      .where(
        and(eq(transaction.tenantId, TENANT), eq(transaction.portfolioId, CRYPTO.portfolioId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cashCurrency).toBeNull();
    expect(rows[0]!.cashAmount).toBeNull();
    expect(rows[0]!.cashAccountId).toBeNull();
    // The positive companion: the row is really there and really settled in an
    // asset, so the three NULLs are a shape rather than a missing insert.
    expect(rows[0]!.txnSettlementInstrumentId).toBe(BTC);
    expect(rows[0]!.grossAmount.toString()).toBe("0.1");
    // ...and it produced no CASH posting at all, so there is nothing for
    // `cash_balance` to be keyed by (see {@link WorkedCase.materialise} for why
    // this case stops at the posting table).
    const postings = await ownerDb
      .select()
      .from(transactionPosting)
      .where(
        and(
          eq(transactionPosting.tenantId, TENANT),
          eq(transactionPosting.portfolioId, CRYPTO.portfolioId),
        ),
      );
    expect(postings).toHaveLength(2);
    expect(postings.every((posting) => posting.leg === "POSITION")).toBe(true);
    expect(postings.every((posting) => posting.cashAccountId === null)).toBe(true);
  });

  it("the persisted fx_rate_applied is the implied rate at numeric(28,12), for D3 and D5", async () => {
    const read = async (portfolioId: string): Promise<string[]> => {
      const rows = await ownerDb
        .select()
        .from(transactionPosting)
        .where(
          and(
            eq(transactionPosting.tenantId, TENANT),
            eq(transactionPosting.portfolioId, portfolioId),
            eq(transactionPosting.leg, "CASH"),
          ),
        )
        .orderBy(asc(transactionPosting.seq));
      return rows.map((row) => row.fxRateApplied.toFixed(12));
    };
    expect(await read(D3.portfolioId)).toEqual(["1.041666666667"]);
    expect(await read(D5.portfolioId)).toEqual(["1.022727272727"]);
    // D1/D2/D4's cash legs carry a rate with no low digits at all — the
    // degenerate two because it is the copied `fx_rate`, D4 because its
    // account is denominated in the base currency.
    expect(await read(D1.portfolioId)).toEqual(["1.000000000000"]);
    expect(await read(D2.portfolioId)).toEqual(["0.920000000000"]);
    expect(await read(D4.portfolioId)).toEqual(["1.000000000000"]);
  });
});
