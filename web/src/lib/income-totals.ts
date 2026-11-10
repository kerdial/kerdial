import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import type { TransactionListPage, TransactionResponse } from "./api-client.js";

/**
 * `income-totals.ts` — UR-38 (FR-102/FR-103). The "Revenus &
 * frais" preset's pure logic: paging `GET /transactions` to exhaustion over
 * a `from`/`to` window, and the dividend/fee/withholding-tax totals derived
 * from whatever pages that scan reads. No network call and no
 * `@tanstack/react-query` import here — {@link scanIncomeTotals} takes an
 * injected page-fetcher, so this whole file (including the two page-cap
 * guards) is testable with a fake, in `income-totals.test.ts`, without
 * mocking a single HTTP call. `web/src/lib/queries.ts`'s
 * `incomeTotalsQueryOptions` is the one production caller that plugs the
 * real `listTransactions` in as that fetcher.
 *
 * **Three hard constraints, established from source, that this file exists to not paper over:**
 *
 * 1. **This scan wants every kind in the window, so it filters by none.**
 *    Stated here as "no server-side `kind` filter exists" until the server
 *    added one — the conclusion is unchanged and the reason is now the real
 *    one: `dividendsEur` needs the DIVIDEND rows, but `feesEur`/`taxesEur`/
 *    `withholdingEur` are legs that ride on **any** kind (see
 *    {@link IncomeTotals.feesEur}'s own note), so no proper subset of the
 *    eight would be a correct narrowing. `computeIncomeTotals` below discards
 *    what it doesn't want, per row, from the full page set.
 * 2. **No total count in the response** (`{items, nextCursor}` only) — the
 *    only way to know a window is completely loaded is to page until
 *    `nextCursor === null`. `IncomeTotalsResult.truncated` is how
 *    {@link scanIncomeTotals} reports the alternative honestly: the caller
 *    (`ActivityView.tsx`) must render the incomplete state and **no total**
 *    when this is `true` (an AC) — this file computes totals from whatever
 *    was read either way, but never tells the caller they are complete when
 *    they are not.
 * 3. **An offset cursor, not keyset** — a concurrent write can shift rows
 *    between pages of the same scan. Nothing here can fix that; it is a
 *    server-side property this feature must live with, which is exactly why
 *    a partial/truncated scan is never presented as authoritative.
 */

/**
 * The server's own `MAX_PAGE_LIMIT` — the same value
 * `transactionsInstrumentScanQueryOptions`'s `TRANSACTIONS_SCAN_PAGE_LIMIT`
 * (`queries.ts`, UR-26) already requests for an identical reason: the
 * largest page the endpoint accepts keeps the number of round-trips a scan
 * needs at a minimum.
 */
export const INCOME_TOTALS_PAGE_LIMIT = 100;

/**
 * NFR-20's 5,000-transaction load assumption ÷ {@link INCOME_TOTALS_PAGE_LIMIT}
 * — the identical sizing `TRANSACTIONS_SCAN_MAX_PAGES` uses for the same load
 * assumption. A `from`/`to`-bounded window will in practice need far fewer
 * pages than a whole-tenant scan, but there is no reason to size this cap any
 * tighter than the one NFR-20 already justifies tenant-wide.
 */
export const INCOME_TOTALS_MAX_PAGES = 50;

/**
 * A non-throwing parse — a malformed wire string degrades the one total it
 * belongs to (see {@link computeIncomeTotals}'s own note on why), never the
 * whole scan. The same private-per-module convention `positions.ts`'s and
 * `allocation.ts`'s own `tryParseDecimal` already establish — this file adds
 * its own copy rather than importing either of theirs.
 */
function tryParseDecimal(raw: string): Decimal | undefined {
  try {
    return parseDecimalString(raw);
  } catch {
    return undefined;
  }
}

/**
 * `undefined` when either the amount is genuinely absent (nothing to sum) or
 * a wire value failed to parse — both callers below treat the two upstream
 * cases identically, but see {@link computeIncomeTotals} for the accumulator
 * semantics, which distinguish "absent" (zero contribution) from "malformed"
 * (poisons the whole total).
 */
function convertLegToEur(amount: string, fxRate: string | null): Decimal | undefined {
  const parsedAmount = tryParseDecimal(amount);
  if (parsedAmount === undefined) return undefined;
  if (fxRate === null) return undefined;
  const parsedRate = tryParseDecimal(fxRate);
  if (parsedRate === undefined) return undefined;
  // The server's own conversion (`ledger/src/posting-expander.ts`'s
  // `toBase = (native, rate) => native.times(rate)`), applied identically
  // here rather than re-derived — a principal already in EUR carries
  // `fxRate` 1, so no currency-based branching is needed: multiplying is
  // correct unconditionally.
  return parsedAmount.times(parsedRate);
}

/**
 * **F9, and the divisor honesty it demands.**
 *
 * A cost used to carry its own `feeFxRate` and this module multiplied by it.
 * After L5 it does not: a cost is denominated by the settling account and
 * converted at the rate the **principal cash posting** used, which the server
 * derives as `(gross × fx_rate) / cash_amount` (`principalImpliedRate`). The
 * client has to derive the same figure or the two disagree in the low digits.
 *
 * **The stance this module already takes extends to the divisor.** Its rule is
 * "one unparseable leg withholds the whole total, never a silently-short partial
 * sum" — and a `cashAmount` that is absent, zero or negative is not a leg that
 * failed to parse, it is a *division* that cannot be performed. Left alone it
 * produces `Infinity` or `NaN` and the tile renders a number, under the label
 * «Frais», that is not one. So the whole total is withheld instead.
 *
 * It never fires on database-valid data, which is the point:
 * `transaction_cash_amount_currency_pairing` requires the amount whenever the
 * settlement currency is set, and `transaction_cash_amount_positive` requires
 * it positive — so on a cross-currency row those states are unreachable. What
 * reaches here is a row that should not exist, and that is exactly when a
 * confident figure is a lie.
 *
 * Rows written **before** this cycle still carry a `feeFxRate` and are still
 * converted by it, byte for byte, so no historical tile figure moves (L8).
 */
function costRateFor(item: TransactionResponse): Decimal | undefined {
  // **A legacy branch stood here until the cost rework**: a pre-cycle row carried
  // its own `feeFxRate` and this used it, which is what kept every historical
  // tile figure unmoved through phase 2. `0049` dropped the column, so the
  // implied rate below is the only rule — and it moves nothing, because all 226
  // costed rows in the deployed database had `fee_fx_rate = fx_rate` when it
  // was measured.

  const fxRate = tryParseDecimal(item.fxRate ?? "");
  if (fxRate === undefined) return undefined;

  // The same three short-circuits `principalImpliedRate` takes, in the same
  // order, for the same reason: a degenerate or asset-settled row's cost is
  // converted at the trade's own rate, never at `(G × R) / G`, which is not
  // guaranteed to return `R` at this precision (FR-241).
  const settlement = item.cashCurrency?.trim() ?? null;
  const trade = item.txnCurrency?.trim() ?? null;
  if (settlement === null || trade === null || settlement === trade) return fxRate;

  const gross = tryParseDecimal(item.grossAmount);
  if (gross === undefined) return undefined;
  const cashAmount = item.cashAmount === null ? undefined : tryParseDecimal(item.cashAmount);
  if (cashAmount === undefined || !cashAmount.greaterThan(0)) return undefined;
  return gross.times(fxRate).dividedBy(cashAmount);
}

export interface IncomeTotals {
  /**
   * The sum of every `DIVIDEND` transaction's `grossAmount`, converted to EUR
   * via that transaction's own top-level `fxRate` (the same rate
   * `posting-expander.ts`'s `DIVIDEND` case uses to compute
   * `toBase(txn.grossAmount, txn.fxRate)` server-side — reused, not
   * re-derived).
   *
   * **Deliberately excludes `DRIP`.** A DRIP transaction is a *purchase*
   * (`posting-expander.ts`'s `DRIP` case is identical to `BUY`'s: it emits a
   * position leg and a trade-money leg, never an income leg) funded by a
   * dividend that was already booked as its own separate `DIVIDEND`-kind
   * transaction (linked via `sourceDividendId`). Counting DRIP's own
   * `grossAmount` here as well would double-count the same dividend as both
   * the income that produced it and the reinvestment it bought.
   *
   * `undefined` means at least one `DIVIDEND` row in the window had an
   * unparseable `grossAmount`/`fxRate` — the whole total is withheld rather
   * than silently reported short (see this file's header on the "poison the
   * one total, not the whole scan" stance).
   */
  readonly dividendsEur: Decimal | undefined;
  /**
   * Every transaction's fee leg (`feeAmount`, present on any `kind` —
   * `posting-expander.ts`'s own comment: "the fee is its own leg... emitted
   * for any kind carrying one, not only DIVIDEND"), converted to EUR via that
   * leg's own `feeFxRate`, **plus every `FEE` row's principal**
   * (« Frais de portefeuille » belongs in «Frais»). `undefined` on the same
   * "one bad leg poisons this total" stance as {@link dividendsEur}.
   */
  readonly feesEur: Decimal | undefined;
  /**
   * **FR-225: «Taxes», split out of «Frais payés».** The sum of every
   * transaction's `taxAmount` component, converted by {@link costRateFor}.
   *
   * The split is `Taxes = Σ tax_amount` and
   * `Frais = Σ (fee_amount − coalesce(tax_amount, 0))`, which is a fixed
   * formula rather than one re-derived here. Its consequence is the point:
   * a legacy componentless row has `tax_amount` NULL and therefore contributes
   * its **whole** `fee_amount` to «Frais» — exactly what it contributed before
   * this cycle — so no historical tile figure moves under L8.
   *
   * **Distinct from {@link withholdingEur}, which is untouched (L12).** They
   * read different columns and mean different things: this is a trade tax paid
   * to a market, that is tax withheld at source from income.
   */
  readonly taxesEur: Decimal | undefined;
  /**
   * Every transaction's withholding-tax leg (`withholdingAmount`, same
   * "any kind" scope as fees). Now it is denominated by the settling
   * account, like a cost, and converted by {@link costRateFor} — the
   * principal's implied rate, which is the rate the ledger's `TAX` posting
   * uses, so on a EUR-settled row it is the stored amount as it is. Reported as
   * a positive magnitude (the wire's own `positiveDecimal` constraint,
   * `api/src/transactions/transactions.schema.ts` — the debit direction is a
   * posting-time concern, not this summary's).
   */
  readonly withholdingEur: Decimal | undefined;
}

/**
 * The pure totalling step, over an already-fetched page set. Each of the
 * three totals is accumulated **independently**: a malformed `feeAmount`
 * poisons `feesEur` only, never `dividendsEur`/`withholdingEur` — three
 * unrelated legs on possibly-unrelated rows have no business sharing a
 * failure. Within one total, though, a single unparseable leg poisons that
 * total for the **whole window** — the same "one bad entry blanks the whole
 * aggregate to an honest '—', never a silently-short partial sum" stance
 * `positions.ts`'s `summarizeRealizedGains` already takes, for the identical
 * reason: a wrong partial total misstates the very figure this feature
 * exists to show honestly, which a quietly-omitted contribution would do.
 */
export function computeIncomeTotals(items: readonly TransactionResponse[]): IncomeTotals {
  let dividendsEur: Decimal | undefined = new Decimal(0);
  let feesEur: Decimal | undefined = new Decimal(0);
  let taxesEur: Decimal | undefined = new Decimal(0);
  let withholdingEur: Decimal | undefined = new Decimal(0);

  for (const item of items) {
    if (item.kind === "DIVIDEND") {
      const contribution = convertLegToEur(item.grossAmount, item.fxRate);
      dividendsEur =
        dividendsEur === undefined || contribution === undefined
          ? undefined
          : dividendsEur.plus(contribution);
    }

    // Owner decision (reversing AC-582): a FEE row's charge is
    // its principal, not a fee leg, and «Frais» counts it — converted the way
    // a DIVIDEND's principal is, at the row's own rate.
    if (item.kind === "FEE") {
      const contribution = convertLegToEur(item.grossAmount, item.fxRate);
      feesEur =
        feesEur === undefined || contribution === undefined
          ? undefined
          : feesEur.plus(contribution);
    }

    if (item.feeAmount !== null || item.taxAmount !== null) {
      // One rate for both halves of the same leg — they are one cost, split by
      // what it was for, not two legs that could convert differently.
      const rate = costRateFor(item);
      const total = item.feeAmount === null ? new Decimal(0) : tryParseDecimal(item.feeAmount);
      const tax = item.taxAmount === null ? new Decimal(0) : tryParseDecimal(item.taxAmount);
      const usable = rate !== undefined && total !== undefined && tax !== undefined;

      // FR-225's formula: «Taxes» is the tax component and
      // «Frais» is what is left of the total after it.
      taxesEur = taxesEur === undefined || !usable ? undefined : taxesEur.plus(tax.times(rate));
      feesEur =
        feesEur === undefined || !usable ? undefined : feesEur.plus(total.minus(tax).times(rate));
    }

    if (item.withholdingAmount !== null) {
      const rate = costRateFor(item);
      const amount = tryParseDecimal(item.withholdingAmount);
      withholdingEur =
        withholdingEur === undefined || rate === undefined || amount === undefined
          ? undefined
          : withholdingEur.plus(amount.times(rate));
    }
  }

  return { dividendsEur, feesEur, taxesEur, withholdingEur };
}

export interface IncomeTotalsResult {
  readonly totals: IncomeTotals;
  readonly pagesRead: number;
  /**
   * `true` only when the scan stopped **because** it hit
   * {@link INCOME_TOTALS_MAX_PAGES} while the server's cursor was still
   * genuinely advancing — the exact same "never merely because the last page
   * happened to be full" semantics `TransactionScanResult.truncated`
   * (`queries.ts`, UR-26) already documents, applied here a second time. A
   * misbehaving/mocked server that omits or repeats `nextCursor` halts the
   * loop early but is **not** reported as truncated — indistinguishable from
   * genuine exhaustion under the wire contract.
   *
   * **Load-bearing for the AC**: "totals are shown only after `nextCursor
   * === null`". `ActivityView.tsx` must render the *période non entièrement
   * chargée* state and no total when this is `true`, regardless of what
   * `totals` above happens to contain (this function still totals whatever
   * pages it did read — that is not the same claim as "the window is fully
   * accounted for").
   */
  readonly truncated: boolean;
}

/**
 * Fetches one page of `GET /transactions` for a bounded window — the shape
 * `scanIncomeTotals` needs to page to exhaustion, and the one seam
 * `income-totals.test.ts` fakes so the loop's two guards (never-null
 * `nextCursor`, a repeating `nextCursor`) are provable without a real
 * network call. `queries.ts`'s `incomeTotalsQueryOptions` is the sole
 * production implementation, closing over `from`/`to` and calling
 * `listTransactions` with `"background"` priority through `cheapReadBudget`
 * (the same per-factory priority choice `transactionsInstrumentScanQueryOptions`
 * already makes for its own background scan).
 */
export type FetchIncomeTotalsPage = (cursor: string | undefined) => Promise<TransactionListPage>;

/**
 * Pages `fetchPage` to exhaustion (or {@link INCOME_TOTALS_MAX_PAGES},
 * whichever comes first), sequentially — each cursor depends on the previous
 * page's response, so this can never present more than one in-flight request
 * to whatever budget the caller's `fetchPage` is wired through. Mirrors
 * `transactionsInstrumentScanQueryOptions`'s own loop (`queries.ts`, UR-26)
 * exactly: only ever advances on a `nextCursor` that is a non-empty string
 * genuinely different from the cursor just used (the `fetchPortfolios`
 * `PORTFOLIOS_MAX_PAGES` precedent, `api-client.ts`, applied a third time in
 * this codebase) — a server that never returns `null`, or that repeats the
 * same cursor, cannot spin this loop forever.
 *
 * `maxPages` is overridable (defaults to {@link INCOME_TOTALS_MAX_PAGES})
 * purely so `income-totals.test.ts` can red-confirm the "cap hit ⇒
 * truncated ⇒ no total" behaviour with a small fixture instead of needing
 * `INCOME_TOTALS_PAGE_LIMIT * INCOME_TOTALS_MAX_PAGES` fake rows.
 */
export async function scanIncomeTotals(
  fetchPage: FetchIncomeTotalsPage,
  maxPages: number = INCOME_TOTALS_MAX_PAGES,
): Promise<IncomeTotalsResult> {
  const items: TransactionResponse[] = [];
  let cursor: string | undefined;
  let pagesRead = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const response = await fetchPage(cursor);
    pagesRead++;
    items.push(...response.items);

    const next = response.nextCursor;
    const advanced = typeof next === "string" && next !== "" && next !== cursor;
    if (!advanced) break;
    cursor = next;
    if (page === maxPages - 1) truncated = true;
  }

  return { totals: computeIncomeTotals(items), pagesRead, truncated };
}
