import { describe, expect, it } from "vitest";
import type { TransactionListPage, TransactionResponse } from "./api-client.js";
import {
  INCOME_TOTALS_MAX_PAGES,
  INCOME_TOTALS_PAGE_LIMIT,
  computeIncomeTotals,
  scanIncomeTotals,
} from "./income-totals.js";

/**
 * `income-totals.test.ts` — UR-38's own acceptance
 * criteria (UR-38). `scanIncomeTotals` is exercised entirely
 * against a **fake** page fetcher — no network, no TanStack Query — so the
 * two loop-termination guards are provable as plain control flow; the real
 * `listTransactions` wiring is `queries.ts`'s `incomeTotalsQueryOptions`,
 * which this file does not touch.
 */

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: "11111111-1111-1111-1111-111111111111",
    kind: "BUY",
    tradeDate: "2026-08-01",
    tradeTs: "2026-08-01T10:00:00.000Z",
    seq: "1",
    instrumentId: "33333333-3333-3333-3333-333333333333",
    quantity: "10",
    unitPrice: "100.00",
    grossAmount: "1000.00",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    fxRateProviderKey: null,
    fxRateObservedOn: null,
    fxRateUserInput: null,
    note: null,
    reference: null,
    transferLinkedTransactionId: null,
    transferLinkedPortfolioId: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("computeIncomeTotals", () => {
  it("sums DIVIDEND grossAmount converted to EUR via the transaction's own fxRate", () => {
    const totals = computeIncomeTotals([
      transaction({ kind: "DIVIDEND", grossAmount: "100.00", txnCurrency: "EUR", fxRate: "1" }),
      // A non-EUR dividend — hand-computed: 50.00 USD × 0.90 (USD->EUR) = 45.00 EUR.
      transaction({ kind: "DIVIDEND", grossAmount: "50.00", txnCurrency: "USD", fxRate: "0.90" }),
    ]);
    expect(totals.dividendsEur?.toString()).toBe("145");
  });

  /**
   * The specific correctness point this suite pins:
   * `ledger/src/posting-expander.ts`'s `DRIP` case is identical to `BUY`'s
   * (position + trade-money legs, no income leg) — a DRIP transaction is the
   * *reinvestment purchase*, not new income. The dividend it reinvests was
   * already booked as its own separate `DIVIDEND` row (linked via
   * `sourceDividendId`). Counting DRIP's own `grossAmount` here too would
   * double the same dividend.
   */
  it("never counts DRIP as dividend income — it is the reinvestment purchase, not the income", () => {
    const totals = computeIncomeTotals([
      transaction({
        kind: "DIVIDEND",
        id: "dividend-1",
        grossAmount: "100.00",
        txnCurrency: "EUR",
        fxRate: "1",
      }),
      transaction({
        kind: "DRIP",
        id: "drip-1",
        sourceDividendId: "dividend-1",
        grossAmount: "100.00",
        txnCurrency: "EUR",
        fxRate: "1",
      }),
    ]);
    expect(totals.dividendsEur?.toString()).toBe("100");
  });

  it("sums fee/withholding legs across every transaction kind, not only DIVIDEND", () => {
    const totals = computeIncomeTotals([
      transaction({
        kind: "BUY",
        feeAmount: "10.00",
      }),
      transaction({
        kind: "WITHDRAWAL",
        withholdingAmount: "5.00",
      }),
    ]);
    expect(totals.feesEur?.toString()).toBe("10");
    expect(totals.withholdingEur?.toString()).toBe("5");
  });

  /**
   * The withholding has no rate of its own any more. It is denominated
   * by the settling account, like a cost, and converted at the rate the
   * ledger's `TAX` posting uses — the principal's implied rate. On a
   * EUR-settled row that rate is 1 and the total is the plain sum of the
   * stored amounts; on a row settled in another currency it is the trade's.
   */
  it("reads a withholding in the settling currency: as it is when settled in EUR, at the trade's rate otherwise", () => {
    const eurSettled = transaction({
      kind: "DIVIDEND",
      grossAmount: "10.00",
      txnCurrency: "USD",
      fxRate: "0.9",
      cashCurrency: "EUR",
      cashAmount: "9.00",
      withholdingAmount: "0.51",
    });
    expect(computeIncomeTotals([eurSettled, eurSettled]).withholdingEur?.toString()).toBe("1.02");

    const usdSettled = transaction({
      kind: "DIVIDEND",
      grossAmount: "100.00",
      txnCurrency: "USD",
      fxRate: "0.5",
      cashCurrency: "USD",
      cashAmount: "100.00",
      withholdingAmount: "15.00",
    });
    // 15,00 USD × 0,5 = 7,50 EUR — the principal's rate, as for a cost.
    expect(computeIncomeTotals([usdSettled]).withholdingEur?.toString()).toBe("7.5");
  });

  // Owner decision (supersedes AC-582's exclusion): a FEE row
  // carries its charge as the principal (`grossAmount`), and « Frais » sums it
  // beside the trade fees; no other total moves.
  it("« Frais » sums one BUY fee and one FEE row, and no other total moves", () => {
    const window = [
      transaction({ kind: "DIVIDEND", grossAmount: "100.00", fxRate: "1" }),
      transaction({ kind: "BUY", feeAmount: "10.00" }),
    ];
    const fee = transaction({
      kind: "FEE",
      instrumentId: null,
      quantity: null,
      unitPrice: null,
      grossAmount: "25.00",
      note: "Frais de garde T3",
    });
    const totals = (rows: TransactionResponse[]) => {
      const result = computeIncomeTotals(rows);
      return [result.dividendsEur, result.feesEur, result.taxesEur, result.withholdingEur].map(
        (total) => total?.toString(),
      );
    };
    expect(totals(window)).toEqual(["100", "10", "0", "0"]);
    expect(totals([...window, fee])).toEqual(["100", "35", "0", "0"]);
  });

  it("a FEE row in USD converts at its own rate, and an unparseable one withholds « Frais »", () => {
    const usd = transaction({
      kind: "FEE",
      grossAmount: "20.00",
      txnCurrency: "USD",
      fxRate: "0.9",
    });
    expect(computeIncomeTotals([usd]).feesEur?.toString()).toBe("18");
    const broken = transaction({ kind: "FEE", grossAmount: "20.00", fxRate: "abc" });
    expect(computeIncomeTotals([broken]).feesEur).toBeUndefined();
  });

  it("returns zero (not undefined) totals for an empty window, and ignores rows with no leg of a given kind", () => {
    const totals = computeIncomeTotals([]);
    expect(totals.dividendsEur?.toString()).toBe("0");
    expect(totals.feesEur?.toString()).toBe("0");
    expect(totals.withholdingEur?.toString()).toBe("0");

    const noLegs = computeIncomeTotals([transaction({ kind: "BUY" })]);
    expect(noLegs.dividendsEur?.toString()).toBe("0");
    expect(noLegs.feesEur?.toString()).toBe("0");
    expect(noLegs.withholdingEur?.toString()).toBe("0");
  });

  /**
   * "One bad leg blanks the whole aggregate" — `positions.ts`'s
   * `summarizeRealizedGains` precedent, applied per-total here: a single
   * malformed leg poisons only the total it belongs to, never the other two,
   * and a genuinely absent leg (fee-less/withholding-less row) never poisons
   * anything.
   */
  it("poisons only the one total a malformed leg belongs to — never the other two", () => {
    const totals = computeIncomeTotals([
      transaction({
        kind: "DIVIDEND",
        grossAmount: "not-a-number",
        txnCurrency: "EUR",
        fxRate: "1",
      }),
      transaction({
        kind: "BUY",
        feeAmount: "10.00",
      }),
      transaction({
        kind: "WITHDRAWAL",
        withholdingAmount: "5.00",
      }),
    ]);
    expect(totals.dividendsEur).toBeUndefined();
    expect(totals.feesEur?.toString()).toBe("10");
    expect(totals.withholdingEur?.toString()).toBe("5");
  });

  it("poisons the whole dividends total (not just the bad row) once any row in the window fails to parse", () => {
    const totals = computeIncomeTotals([
      transaction({ kind: "DIVIDEND", grossAmount: "100.00", txnCurrency: "EUR", fxRate: "1" }),
      transaction({ kind: "DIVIDEND", grossAmount: "bogus", txnCurrency: "EUR", fxRate: "1" }),
    ]);
    expect(totals.dividendsEur).toBeUndefined();
  });

  /**
   * FR-260 (FT-46): the premise moved with L5. A cost written after this cycle
   * carries no cost rate of its own at all — `0049` dropped the column
   * — so the total is poisoned by the row failing to yield an
   * *implied* rate instead: no `fxRate` to derive one from.
   */
  it("poisons fees when a present feeAmount yields no rate at all — neither its own nor an implied one", () => {
    const totals = computeIncomeTotals([
      transaction({ kind: "BUY", feeAmount: "10.00", fxRate: "bogus" }),
    ]);
    expect(totals.feesEur).toBeUndefined();
    expect(totals.taxesEur).toBeUndefined();
    // The other totals are untouched — one poisoned leg never spreads.
    expect(totals.withholdingEur?.toString()).toBe("0");
  });
});

describe("scanIncomeTotals", () => {
  function pagesOf(items: readonly TransactionResponse[], pageSize: number) {
    const pages: TransactionResponse[][] = [];
    for (let i = 0; i < items.length; i += pageSize) pages.push(items.slice(i, i + pageSize));
    return pages;
  }

  it("pages to exhaustion and reports truncated: false when nextCursor genuinely reaches null", async () => {
    const items = [
      transaction({
        id: "t1",
        kind: "DIVIDEND",
        grossAmount: "10.00",
        txnCurrency: "EUR",
        fxRate: "1",
      }),
      transaction({
        id: "t2",
        kind: "DIVIDEND",
        grossAmount: "20.00",
        txnCurrency: "EUR",
        fxRate: "1",
      }),
      transaction({
        id: "t3",
        kind: "DIVIDEND",
        grossAmount: "30.00",
        txnCurrency: "EUR",
        fxRate: "1",
      }),
    ];
    const pages = pagesOf(items, 1);
    // A closure counter, not a parsed-from-string page index — `web/src`'s
    // no-floats syntactic ban (`eslint.config.mjs`) forbids `Number()` call
    // syntax outright, even here where nothing decimal-typed is involved
    // (`queries.test.ts`'s own identical precedent for this exact shape).
    let calls = 0;
    const result = await scanIncomeTotals(async () => {
      const index = calls;
      calls++;
      const page: TransactionListPage = {
        items: pages[index] ?? [],
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      };
      return page;
    });

    expect(calls).toBe(3);
    expect(result.pagesRead).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.totals.dividendsEur?.toString()).toBe("60");
  });

  /**
   * AC (red-confirmed): the loop terminates against a server that never
   * returns `nextCursor: null` — bounded by `maxPages` — and reports
   * `truncated: true`, since the cursor genuinely kept advancing every time.
   * `maxPages` is overridden to a small number so this needs only a handful
   * of fake pages, not `INCOME_TOTALS_PAGE_LIMIT * INCOME_TOTALS_MAX_PAGES`
   * real ones.
   */
  it("terminates against a server that never returns nextCursor: null, capped at maxPages, and reports truncated: true", async () => {
    let calls = 0;
    const SMALL_MAX_PAGES = 3;
    const result = await scanIncomeTotals(async () => {
      calls++;
      return { items: [], nextCursor: `cursor-${calls}` };
    }, SMALL_MAX_PAGES);

    expect(calls).toBe(SMALL_MAX_PAGES);
    expect(result.pagesRead).toBe(SMALL_MAX_PAGES);
    expect(result.truncated).toBe(true);
  });

  /**
   * AC (red-confirmed): a server that repeats the same cursor forever must
   * not loop forever either. Unlike the case above, this one is **not**
   * reported as truncated — a non-advancing cursor is indistinguishable from
   * genuine exhaustion under the wire contract (the same stance
   * `TransactionScanResult.truncated`'s own doc comment in `queries.ts`
   * already takes), so the loop halts on the very first repeat rather than
   * running to `maxPages`.
   */
  it("terminates against a server that repeats the same cursor forever, and does not report that as truncated", async () => {
    let calls = 0;
    const result = await scanIncomeTotals(async () => {
      calls++;
      // Always "advances" to the literal string "same-cursor" — repeats
      // itself from the second call onward.
      return { items: [], nextCursor: "same-cursor" };
    });

    // First call: cursor undefined -> next "same-cursor", genuinely different
    // from `undefined`, so it advances once. Second call: cursor
    // "same-cursor" -> next "same-cursor", identical to the cursor just
    // used, so the loop must stop here.
    expect(calls).toBe(2);
    expect(result.pagesRead).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("uses INCOME_TOTALS_MAX_PAGES as its default cap", async () => {
    let calls = 0;
    const result = await scanIncomeTotals(async () => {
      calls++;
      return { items: [], nextCursor: `cursor-${calls}` };
    });
    expect(calls).toBe(INCOME_TOTALS_MAX_PAGES);
    expect(result.truncated).toBe(true);
  });

  it("exports INCOME_TOTALS_PAGE_LIMIT as the server's own MAX_PAGE_LIMIT (100), the same value the instrument-scan precedent requests", () => {
    expect(INCOME_TOTALS_PAGE_LIMIT).toBe(100);
  });
});

/**
 * **FT-46 (FR-225, AC-251) — «Frais payés» split in two, and F9's divisor.**
 *
 * The formula is fixed, not one re-derived here: `Taxes = Σ tax_amount`
 * and `Frais = Σ (fee_amount − coalesce(tax_amount, 0))`. Its consequence is
 * what most of these cases are about — a legacy componentless row has
 * `tax_amount` NULL and so contributes its whole cost to «Frais», exactly what
 * it contributed before this cycle.
 */
describe("computeIncomeTotals — the Frais / Taxes split (FT-46)", () => {
  it("AC-251: over a window containing AC-232's BUY, Frais is 12,40 and Taxes is 3,60", () => {
    const totals = computeIncomeTotals([
      transaction({
        kind: "BUY",
        feeAmount: "16.00",
        taxAmount: "3.60",
        brokerFeeAmount: "9.90",
        fxFeeAmount: "2.50",
        fxRate: "1",
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: "1016.00",
      }),
    ]);
    // 16,00 − 3,60 = 12,40, worked here rather than by the implementation.
    expect(totals.feesEur?.toString()).toBe("12.4");
    expect(totals.taxesEur?.toString()).toBe("3.6");
  });

  /**
   * **The two tax-family numbers are proven not merged.** They read different
   * columns and mean different things — a trade tax paid to a market, and tax
   * withheld at source from income (L12 leaves the second untouched). Moving
   * one and asserting the other is unchanged is the only way to show that.
   */
  it("the trade tax and the withholding total are independent: moving one leaves the other exactly where it was", () => {
    const rows = (tax: string) => [
      transaction({
        kind: "BUY",
        feeAmount: tax,
        taxAmount: tax,
        fxRate: "1",
        txnCurrency: "EUR",
        cashCurrency: "EUR",
        cashAmount: "100.00",
      }),
      transaction({
        kind: "DIVIDEND",
        grossAmount: "50.00",
        withholdingAmount: "7.50",
        fxRate: "1",
      }),
    ];

    const before = computeIncomeTotals(rows("3.60"));
    const after = computeIncomeTotals(rows("9.99"));

    expect(before.taxesEur?.toString()).toBe("3.6");
    expect(after.taxesEur?.toString()).toBe("9.99");
    // Changed by the same edit? Then they are one number under two labels.
    expect(before.withholdingEur?.toString()).toBe("7.5");
    expect(after.withholdingEur?.toString()).toBe("7.5");
  });

  /**
   * **No historical figure moves (L8).** A row written before this cycle has no
   * cost components, so its whole `feeAmount` contributes to «Frais» —
   * compared against a checked-in literal rather than recomputed, so the
   * pre-cycle value is pinned rather than re-derived by the code under test.
   *
   * Such a row no longer carries a rate of its own: `0049` dropped
   * `fee_fx_rate*`, so the conversion uses the principal's
   * rate. The figure is unchanged because those two were equal on every row
   * that had both — measured, not assumed.
   */
  it("a window of only legacy componentless rows produces exactly its pre-cycle Frais total", () => {
    const totals = computeIncomeTotals([
      transaction({ kind: "BUY", feeAmount: "10.00", fxRate: "1" }),
      transaction({ kind: "SELL", feeAmount: "8.00", fxRate: "1" }),
    ]);
    // 10,00 + 8,00 — the figure this window produced before the split existed.
    expect(totals.feesEur?.toString()).toBe("18");
    // …and «Taxes» is a real zero, not `undefined`: nothing failed, there is
    // simply no trade tax in the window.
    expect(totals.taxesEur?.toString()).toBe("0");
  });

  /**
   * **F9, red-confirmed.** After L5 the client derives the cost's rate as
   * `(gross × fx_rate) / cash_amount`. A `cashAmount` that is absent or zero is
   * the **divisor**, and left alone it produces `Infinity`/`NaN` — a number,
   * under the label «Frais», that is not one. The whole total is withheld
   * instead, which is the stance this module already takes for an unparseable
   * leg.
   */
  it("F9: a cross-currency row with a missing or zero cashAmount withholds the whole total, never Infinity or NaN", () => {
    for (const cashAmount of [null, "0", "0.00"]) {
      const totals = computeIncomeTotals([
        transaction({
          kind: "BUY",
          feeAmount: "5.00",
          fxRate: "0.92",
          grossAmount: "1000.00",
          txnCurrency: "USD",
          cashCurrency: "EUR",
          cashAmount,
        }),
      ]);
      expect(totals.feesEur, `cashAmount=${String(cashAmount)}`).toBeUndefined();
      expect(totals.taxesEur, `cashAmount=${String(cashAmount)}`).toBeUndefined();
    }

    // **The guard has content**: the same row with a usable divisor produces a
    // figure, so the withholding above is the divisor's doing and not a shape
    // this module refuses outright. 1 000 × 0,92 / 920 = 1, so 5,00 × 1 = 5.
    const usable = computeIncomeTotals([
      transaction({
        kind: "BUY",
        feeAmount: "5.00",
        fxRate: "0.92",
        grossAmount: "1000.00",
        txnCurrency: "USD",
        cashCurrency: "EUR",
        cashAmount: "920.00",
      }),
    ]);
    expect(usable.feesEur?.toString()).toBe("5");
  });

  /** FR-241, mirrored: a degenerate row takes `fx_rate` verbatim, never `(G × R) / G`. */
  it("a degenerate row converts the cost at the trade's own rate, not at an implied one", () => {
    const totals = computeIncomeTotals([
      transaction({
        kind: "BUY",
        feeAmount: "5.00",
        fxRate: "0.92",
        grossAmount: "1000.00",
        txnCurrency: "USD",
        cashCurrency: "USD",
        cashAmount: "1005.00",
      }),
    ]);
    expect(totals.feesEur?.toString()).toBe("4.6");
  });
});
