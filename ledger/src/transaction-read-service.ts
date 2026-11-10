import { and, asc, eq, gte, inArray, lte, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  tenant,
  transaction,
  withTenant,
  type Db,
  type TenantId,
  type Tx,
} from "@kerdial/platform-db";
import { Decimal } from "@kerdial/core-decimal";
import type { IsoDate } from "@kerdial/market-ports";
import type { TransactionRecord } from "./transaction-write-service.js";

/**
 * `ledger`'s transaction *read* service — T-38's
 * `GET /transactions?portfolio=&instrument=&from=&to=&kind=&currency=&minAmount=&maxAmount=`
 * and `GET /transactions/:id`. Neither T-19/T-20 (write)
 * nor T-22 (edit/delete/correct) built a plain list/get read side — this
 * module is the "thin controller needs a service to call" building block
 * T-38 supplies, mirroring `instrument-service.ts`'s own `listInstruments`/
 * `getInstrumentById` addition for T-37.
 *
 * `transaction` is tenant-owned and `FORCE ROW LEVEL SECURITY` (migration
 * `0007_roles-grants-rls.sql`), so every function here goes through
 * `withTenant` — RLS is the primary enforcement of tenant scoping (AC33/
 * AC35), the explicit `eq(transaction.tenantId, ...)` predicates are defence
 * in depth, exactly as every other tenant-scoped `ledger` service already
 * documents.
 */

/**
 * A transaction as the read side returns it: the stored row, plus the other
 * leg of a security transfer (`security-transfer`).
 *
 * On a `TRANSFER_OUT`, the partner is the `TRANSFER_IN` whose
 * `transfer_source_id` names it; on a `TRANSFER_IN`, it is the row its own
 * `transfer_source_id` names. Both `null` when the row is not a transfer, or is
 * one with no linked partner (a transfer out of Kerdial, FR-566, or a severed
 * target, FR-580). The partner's portfolio travels with it because that is what
 * a screen names — « Transféré vers {portefeuille} ».
 */
export type TransactionReadRecord = TransactionRecord & {
  readonly transferLinkedTransactionId: string | null;
  readonly transferLinkedPortfolioId: string | null;
};

/**
 * The receiving leg of a row, found through `transaction_transfer_source_id_key`
 * (the partial unique index on `(tenant_id, transfer_source_id)`), and the
 * source leg a row names, found through the primary key. Two aliases rather
 * than one join with an `OR`, so each side is one index probe.
 */
const transferTarget = alias(transaction, "transfer_target");
const transferSource = alias(transaction, "transfer_source");

/**
 * The read projection every function here shares: the row and its partner in
 * **one** statement, however many rows the page holds — two `LEFT JOIN`s, never
 * a lookup per row. The unique index makes each join match at most one row, so
 * neither can fan a page out.
 */
function selectWithTransferLink(tx: Tx) {
  return tx
    .select({
      row: transaction,
      targetId: transferTarget.id,
      targetPortfolioId: transferTarget.portfolioId,
      sourcePortfolioId: transferSource.portfolioId,
    })
    .from(transaction)
    .leftJoin(
      transferTarget,
      and(
        eq(transferTarget.tenantId, transaction.tenantId),
        eq(transferTarget.transferSourceId, transaction.id),
      ),
    )
    .leftJoin(
      transferSource,
      and(
        eq(transferSource.tenantId, transaction.tenantId),
        eq(transferSource.id, transaction.transferSourceId),
      ),
    );
}

function withTransferLink(selected: {
  readonly row: TransactionRecord;
  readonly targetId: string | null;
  readonly targetPortfolioId: string | null;
  readonly sourcePortfolioId: string | null;
}): TransactionReadRecord {
  const { row, targetId, targetPortfolioId, sourcePortfolioId } = selected;
  if (targetId !== null) {
    return {
      ...row,
      transferLinkedTransactionId: targetId,
      transferLinkedPortfolioId: targetPortfolioId,
    };
  }
  if (row.transferSourceId !== null && sourcePortfolioId !== null) {
    return {
      ...row,
      transferLinkedTransactionId: row.transferSourceId,
      transferLinkedPortfolioId: sourcePortfolioId,
    };
  }
  return { ...row, transferLinkedTransactionId: null, transferLinkedPortfolioId: null };
}

export interface ListTransactionsParams {
  readonly portfolioId?: string;
  readonly instrumentId?: string;
  /** Inclusive `trade_date` range start, `YYYY-MM-DD`. Omit for no lower bound. */
  readonly fromDate?: IsoDate;
  /** Inclusive `trade_date` range end, `YYYY-MM-DD`. Omit for no upper bound. */
  readonly toDate?: IsoDate;
  /**
   * `kind IN (…)` — the set a row's kind must belong to. Omit for
   * every kind. An **empty** array is not a way to say "all": callers are
   * expected to omit the field instead (`api`'s own query schema refuses an
   * empty `kind=`), and an empty array here would render as a `false`
   * predicate matching nothing, which is the honest reading of "the caller
   * asked for none of them".
   *
   * Typed off `TransactionRecord` (the Drizzle row) rather than a re-listed
   * union: an 8th kind was added by migration, and a hand-copied list
   * would have gone on compiling while silently refusing to name the new one —
   * the "a list that mirrors its input by value can pass while the thing it
   * describes has moved" hazard `GUARDED_FX_EDIT_FIELDS` records from the
   * other side.
   */
  readonly kinds?: readonly TransactionRecord["kind"][];
  /**
   * `txn_currency = …` — the trade's **own** denomination, not
   * the settling account's (`cash_currency`) and not the ledger base.
   *
   * **An asset-settled row never matches any value of this filter.**
   * `txn_currency` is NULL for a BUY settled in another instrument (migration
   * `0003`'s `transaction_currency_xor_settlement_instrument` XOR: the
   * principal leg is denominated in *either* a fiat currency *or* an asset),
   * and `= NULL` is never true — so filtering by currency at all excludes the
   * asset-settled rows entirely, by construction rather than by accident.
   */
  readonly txnCurrency?: string;
  /**
   * Inclusive bounds on `gross_amount`, **in `txn_currency`** —
   * the row's own denomination, never converted. Comparing them across
   * currencies would silently rank 1 000 JPY against 1 000 EUR, so the API
   * layer requires a `currency` alongside either bound (422); this service
   * takes them independently, exactly as it takes `fromDate`/`toDate`
   * independently, and a caller that supplies a `min` above its `max` gets no
   * rows — the same way an inverted date range already does.
   */
  readonly minGrossAmount?: Decimal;
  readonly maxGrossAmount?: Decimal;
  /** Rows to return, after `offset` — the API layer's cursor-pagination window (mirrors `ledger`'s other T-37/T-38 list services); this service takes a plain offset/limit and leaves cursor encoding to the caller. */
  readonly limit: number;
  readonly offset: number;
  /**
   * FR-264: `"desc"` returns newest-first — the total order is
   * the exact reverse of the ascending one (`trade_date, seq, id`, all three
   * flipped, so the order stays total and a page boundary cannot duplicate or
   * skip a row). Defaults to `"asc"`, the ledger's own reading order — kept
   * as the default deliberately (a ledger reads forward; "recent activity" is
   * the surface that opts into `desc`).
   */
  readonly order?: "asc" | "desc";
}

/**
 * The tenant-scoped, filterable transaction list — T-38's
 * filtering *capability* (the dedicated filterable transaction-history
 * *screen*, FR-37/AC27, is [P1-LATER]/C20; this is the API-level building
 * block that will eventually sit under it).
 *
 * Ordered by `(trade_date, seq)` — the same replay order used everywhere —
 * then `id` as a final stable tiebreaker for rows sharing both (there is no
 * scenario where two rows share `(tenant_id, trade_date, seq)`, `seq` being
 * unique per tenant per migration `0013`, but the tiebreaker costs nothing
 * and keeps repeated calls with an advancing `offset` from ever depending on
 * an unspecified secondary order).
 *
 * **Adds `kinds`/`txnCurrency`/`minGrossAmount`/`maxGrossAmount`
 * and deliberately adds no index for them.** NFR-20's load assumption is
 * 5 000 transactions for one tenant, and the plan for this query is driven by
 * the ordering, not by the predicates: every call is bounded by `LIMIT` and
 * ordered by `(trade_date, seq, id)`, so it rides
 * `transaction_tenant_portfolio_trade_date_seq_idx` (or
 * `..._instrument_trade_date_seq_idx`, or the ordered scan of the tenant's own
 * rows when neither scope is given) and the four new predicates are filters
 * applied to rows that scan has already produced. None of them is selective
 * enough at that scale to change which index is chosen: `kind` has 12 distinct
 * values, `txn_currency` a handful, and `gross_amount` is unclustered — a
 * dedicated index would be read once per query and would have to be maintained
 * on every write, to save a filter over at most 5 000 rows already in cache.
 * The cost of the four is the `WHERE` evaluation, not an extra scan. Revisit
 * when a *tenant* holds an order of magnitude more rows than NFR-20 assumes,
 * not when the filter count grows.
 */
export async function listTransactions(
  db: Db,
  tenantId: TenantId,
  params: ListTransactionsParams,
): Promise<TransactionReadRecord[]> {
  return withTenant(db, tenantId, async (tx) => {
    const conditions = scopeConditions(tenantId, params);

    const ordering =
      params.order === "desc"
        ? [desc(transaction.tradeDate), desc(transaction.seq), desc(transaction.id)]
        : [asc(transaction.tradeDate), asc(transaction.seq), asc(transaction.id)];
    const rows = await selectWithTransferLink(tx)
      .where(and(...conditions))
      .orderBy(...ordering)
      .limit(params.limit)
      .offset(params.offset);
    return rows.map(withTransferLink);
  });
}

/**
 * The scope every read in this module shares — `listTransactions`'s eight
 * filters, as one predicate list. Extracted so the calendar
 * aggregate below counts **exactly the rows the list would return** for the
 * same parameters: the Activité screen's « Calendrier » tab and its « Journal »
 * tab are two readings of one filter set, and two hand-copied predicate lists
 * are how they would come to disagree.
 */
function scopeConditions(tenantId: TenantId, params: TransactionScopeParams) {
  const conditions = [eq(transaction.tenantId, tenantId)];
  if (params.portfolioId !== undefined) {
    conditions.push(eq(transaction.portfolioId, params.portfolioId));
  }
  if (params.instrumentId !== undefined) {
    conditions.push(eq(transaction.instrumentId, params.instrumentId));
  }
  if (params.fromDate !== undefined) {
    conditions.push(gte(transaction.tradeDate, params.fromDate));
  }
  if (params.toDate !== undefined) {
    conditions.push(lte(transaction.tradeDate, params.toDate));
  }
  if (params.kinds !== undefined) {
    conditions.push(inArray(transaction.kind, [...params.kinds]));
  }
  if (params.txnCurrency !== undefined) {
    // NULL `txn_currency` (an asset-settled row) is never equal to anything
    // — see {@link ListTransactionsParams.txnCurrency}.
    conditions.push(eq(transaction.txnCurrency, params.txnCurrency));
  }
  if (params.minGrossAmount !== undefined) {
    conditions.push(gte(transaction.grossAmount, params.minGrossAmount));
  }
  if (params.maxGrossAmount !== undefined) {
    conditions.push(lte(transaction.grossAmount, params.maxGrossAmount));
  }
  return conditions;
}

/** `listTransactions`'s filters without its paging and ordering — what a whole-scope aggregate takes. */
export type TransactionScopeParams = Omit<ListTransactionsParams, "limit" | "offset" | "order">;

/** One `YYYY` or `YYYY-MM` bucket of the activity calendar. A period with no transaction is **absent**, never a zero entry. */
export interface TransactionCalendarBucket {
  /** `to_char(trade_date, 'YYYY')` or `'YYYY-MM'` — zero-padded, so lexical order is chronological order. */
  readonly period: string;
  /** Transactions of any kind in the bucket. */
  readonly count: number;
  /** Σ `gross_amount × fx_rate` — each row's principal leg in the ledger base. Fees and withholding are not in it. */
  readonly volumeBase: Decimal;
}

interface TransactionCalendarTotals {
  readonly count: number;
  readonly volumeBase: Decimal;
}

/** `GET /transactions/calendar`'s answer — the Activité screen's « Calendrier » tab. */
export interface TransactionCalendar {
  /** AR-5 — the tenant's ledger base, the unit of every `volumeBase` here. Correct for a tenant with no transaction too. */
  readonly baseCurrency: string;
  readonly total: TransactionCalendarTotals;
  /** `period` ascending. */
  readonly years: readonly TransactionCalendarBucket[];
  readonly months: readonly TransactionCalendarBucket[];
}

/**
 * AR-5's provenance guard, the same one `summarizeDividends` raises: a
 * `transaction.base_currency` that disagrees with the tenant's is corrupt
 * stored state (`trg_transaction_base_currency_fill` makes it unreachable on
 * trigger-valid data), so the aggregate refuses to label a sum in an unknown
 * unit rather than serving it under the tenant's.
 */
class TransactionCalendarBaseCurrencyMismatchError extends Error {
  readonly expected: string;
  readonly found: string;
  constructor(expected: string, found: string) {
    super(
      `A transaction reports base_currency ${found} where the tenant's ledger base is ${expected}: ` +
        `the calendar cannot sum volumes in an unknown unit`,
    );
    this.name = "TransactionCalendarBaseCurrencyMismatchError";
    this.expected = expected;
    this.found = found;
  }
}

type CalendarRow = {
  month: string;
  count: string;
  volume_base: string | null;
  base_currency_count: string;
  base_currency: string | null;
};

/**
 * The year × month activity calendar, backing
 * `GET /transactions/calendar`. **One statement**: `count(*)` and
 * `sum(gross_amount × fx_rate)` over `transaction`, grouped by
 * `to_char(trade_date, 'YYYY-MM')`, then folded into months, years and a total
 * in exact `Decimal` arithmetic, so the three agree by construction.
 *
 * **Why `gross_amount × fx_rate` and not a `transaction_posting` sum.** The
 * question is "how much changed hands", per transaction, whatever its kind: a
 * BUY's principal, a SELL's proceeds, a DEPOSIT's cash, a DIVIDEND's gross, a
 * CURRENCY_EXCHANGE's source amount. `gross_amount` is exactly that figure on
 * every kind (`transaction_amounts_positive`), and `fx_rate` is the principal
 * leg's own resolved rate — the same two stored numbers `posting-expander.ts`'s
 * `toBase` multiplies (`native.times(rate)`), so the sum is the expander's own
 * base figure without joining the projection. A posting-side sum would have to
 * pick legs per kind (INTERNAL for trades, EXTERNAL for cash, INCOME for
 * dividends) and would still need the absolute value, since postings are
 * signed. Fees and withholding are deliberately not included: they are costs
 * *on* the activity, not the activity. A `SHARE_DISTRIBUTION` contributes its
 * `gross_amount` (zero — no money moves) and one to the count. A security
 * transfer (`TRANSFER_OUT`/`TRANSFER_IN`) counts once per leg but adds **no
 * volume** (an owner decision): units move between portfolios, no money
 * does, and a linked pair would otherwise show twice its market value.
 *
 * The scope is {@link scopeConditions} — the list's own predicate list — so
 * the calendar counts exactly what the Journal would page through under the
 * same filters. `to_char` for the bucket key for the reasons
 * `dividend-summary-service.ts` records: `trade_date` is a `date`, no
 * time zone enters, and `'YYYY'` pads.
 */
export async function summarizeTransactionCalendar(
  db: Db,
  tenantId: TenantId,
  params: TransactionScopeParams,
): Promise<TransactionCalendar> {
  return withTenant(db, tenantId, async (tx) => {
    // AR-5: the unit comes from `tenant`, never from `min(base_currency)` over
    // the aggregate — which is `null` for an empty scope, exactly the case the
    // empty response still has to label.
    const [tenantRow] = await tx
      .select({ baseCurrency: tenant.baseCurrency })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (!tenantRow) {
      throw new Error(`summarizeTransactionCalendar: no tenant row for ${tenantId}`);
    }
    const baseCurrency = tenantRow.baseCurrency;

    const month = sql<string>`to_char(${transaction.tradeDate}, 'YYYY-MM')`;
    // `sql<string>` throughout: `count(*)` is `int8` and the product is a wide
    // `numeric`, and the driver hands both back as strings — nothing here
    // goes through `decimalCol`'s `fromDriver` and nothing is ever a float.
    const rows: CalendarRow[] = await tx
      .select({
        month,
        count: sql<string>`count(*)`,
        volume_base: sql<
          string | null
        >`sum(${transaction.grossAmount} * ${transaction.fxRate}) filter (where ${transaction.kind} not in ('TRANSFER_OUT', 'TRANSFER_IN'))`,
        base_currency_count: sql<string>`count(distinct ${transaction.baseCurrency})`,
        base_currency: sql<string | null>`min(${transaction.baseCurrency})`,
      })
      .from(transaction)
      .where(and(...scopeConditions(tenantId, params)))
      .groupBy(month)
      .orderBy(month);

    const months: TransactionCalendarBucket[] = [];
    const byYear = new Map<string, { count: number; volumeBase: Decimal }>();
    let totalCount = 0;
    let totalVolume = new Decimal(0);

    for (const row of rows) {
      if (row.base_currency_count !== "1" || row.base_currency !== baseCurrency) {
        throw new TransactionCalendarBaseCurrencyMismatchError(
          baseCurrency,
          row.base_currency ?? "(none)",
        );
      }
      const count = Number(row.count);
      const volumeBase = new Decimal(row.volume_base ?? "0");
      months.push({ period: row.month, count, volumeBase });

      const year = row.month.slice(0, 4);
      const yearBucket = byYear.get(year);
      if (yearBucket === undefined) {
        byYear.set(year, { count, volumeBase });
      } else {
        yearBucket.count += count;
        yearBucket.volumeBase = yearBucket.volumeBase.plus(volumeBase);
      }

      totalCount += count;
      totalVolume = totalVolume.plus(volumeBase);
    }

    return {
      baseCurrency,
      total: { count: totalCount, volumeBase: totalVolume },
      // `Map` insertion order is the month scan's, which is already year-ascending.
      years: [...byYear.entries()].map(([period, value]) => ({ period, ...value })),
      months,
    };
  });
}

/**
 * A single transaction by id, or `undefined` if this tenant has no such
 * transaction — including the case where the id exists but belongs to
 * another tenant, which is indistinguishable from "does not exist" here by
 * design (AC33/AC35: another tenant's rows are invisible, not merely
 * forbidden). Backs `GET /transactions/:id` and AC9's "subsequent GET
 * returns 404" assertion.
 */
export async function getTransactionById(
  db: Db,
  tenantId: TenantId,
  id: string,
): Promise<TransactionReadRecord | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await selectWithTransferLink(tx).where(
      and(eq(transaction.tenantId, tenantId), eq(transaction.id, id)),
    );
    return row === undefined ? undefined : withTransferLink(row);
  });
}
