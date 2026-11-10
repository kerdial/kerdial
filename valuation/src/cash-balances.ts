import { Decimal } from "@kerdial/core-decimal";
import type { CashDailyNet, CurrencyCode, IsoDate } from "@kerdial/core-domain";
import { transaction, transactionPosting, type Tx } from "@kerdial/platform-db";
import { and, eq, lt, lte, min, sql } from "drizzle-orm";

/**
 * The cash reads of the valuation path (`portfolio-cash`; PC-L1, PC-L11,
 * PC-L13, NFR-91).
 *
 * Cash is read from the CASH postings, never from `cash_balance`: a live read
 * may be as of a past date (`GET /:id/overview?to=`) while `cash_balance`
 * holds only the current balance, and the holdings it is added to are already
 * truncated at `trade_date <= asOf` — reading the current balance would mix
 * two instants. Postings ignore archive, so an archived account's balance
 * counts, as it does on the « Espèces » tab.
 */

/** As-of cash, per currency, for one portfolio or a whole tenant. */
export interface CashAsOf {
  /** Σ `amount_native` of the CASH postings dated on or before the as-of date, per currency (zero balances included). */
  readonly balances: ReadonlyMap<CurrencyCode, Decimal>;
  /**
   * The first CASH posting date per currency **with a non-zero balance** —
   * the cash currencies `loadPricingSeries` must load FX for. A
   * zero balance needs no rate, so it asks for none.
   */
  readonly firstPostingDates: ReadonlyMap<CurrencyCode, IsoDate>;
}

/**
 * `loadCashAsOf` — one grouped statement (NFR-91): the as-of balance per
 * currency, `trade_date <= asOfDate` inclusive (the live total is end-of-day,
 * like the holdings beside it). With `portfolioId` it is one portfolio's
 * cash; without, the whole tenant's — the same statement minus the
 * `portfolio_id` predicate, so a tenant with N portfolios pays one statement,
 * not N. Must run inside `withTenant` (RLS scopes the rows; the explicit
 * `tenant_id` predicate also serves the `(tenant_id, leg, flow_class)` index).
 */
export async function loadCashAsOf(
  tx: Tx,
  params: {
    readonly tenantId: string;
    /** Omitted: every portfolio of the tenant, archived ones included (PC-L13). */
    readonly portfolioId?: string;
    readonly asOfDate: IsoDate;
  },
): Promise<CashAsOf> {
  const rows = await tx
    .select({
      currency: transactionPosting.currency,
      amount: sql<string>`sum(${transactionPosting.amountNative})`,
      firstDate: min(transaction.tradeDate),
    })
    .from(transactionPosting)
    .innerJoin(transaction, eq(transaction.id, transactionPosting.transactionId))
    .where(
      and(
        eq(transactionPosting.tenantId, params.tenantId),
        params.portfolioId === undefined
          ? undefined
          : eq(transactionPosting.portfolioId, params.portfolioId),
        eq(transactionPosting.leg, "CASH"),
        lte(transaction.tradeDate, params.asOfDate),
      ),
    )
    .groupBy(transactionPosting.currency);

  const balances = new Map<CurrencyCode, Decimal>();
  const firstPostingDates = new Map<CurrencyCode, IsoDate>();
  for (const row of rows) {
    // `transaction_posting_cash_leg_has_currency`: a CASH leg always has one.
    if (row.currency === null) continue;
    const amount = new Decimal(row.amount);
    balances.set(row.currency, amount);
    if (!amount.isZero() && row.firstDate !== null) {
      firstPostingDates.set(row.currency, row.firstDate as IsoDate);
    }
  }
  return { balances, firstPostingDates };
}

/**
 * `loadCashDailyNets` — the daily series' cash read: one grouped
 * statement, the signed sum of one portfolio's CASH postings per
 * `(trade_date, currency)`, every kind, for `trade_date < beforeDate`.
 *
 * Strictly before: `V(d)` is pre-flow, so the newest net any date of a range
 * ending `beforeDate` can use is dated the day before it — a posting dated
 * `beforeDate` itself first shows in `V(beforeDate + 1)`, outside the range.
 * No lower bound: the balance on a range's first date needs every earlier
 * posting. `cashBalancesBefore` (`core/domain`) applies the per-date cut.
 * Must run inside `withTenant`.
 */
export async function loadCashDailyNets(
  tx: Tx,
  params: { readonly tenantId: string; readonly portfolioId: string; readonly beforeDate: IsoDate },
): Promise<CashDailyNet[]> {
  const rows = await tx
    .select({
      date: transaction.tradeDate,
      currency: transactionPosting.currency,
      amount: sql<string>`sum(${transactionPosting.amountNative})`,
    })
    .from(transactionPosting)
    .innerJoin(transaction, eq(transaction.id, transactionPosting.transactionId))
    .where(
      and(
        eq(transactionPosting.tenantId, params.tenantId),
        eq(transactionPosting.portfolioId, params.portfolioId),
        eq(transactionPosting.leg, "CASH"),
        lt(transaction.tradeDate, params.beforeDate),
      ),
    )
    .groupBy(transaction.tradeDate, transactionPosting.currency);

  const nets: CashDailyNet[] = [];
  for (const row of rows) {
    // `transaction_posting_cash_leg_has_currency`: a CASH leg always has one.
    if (row.currency === null) continue;
    nets.push({
      date: row.date as IsoDate,
      currency: row.currency,
      amount: new Decimal(row.amount),
    });
  }
  return nets;
}
