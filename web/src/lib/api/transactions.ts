import type { RequestPriority } from "../request-budget.js";
import { cheapReadBudget } from "../request-budget.js";
import { apiFetch } from "./core.js";

/**
 * `TransactionResponse` — `api/src/transactions/transactions.schema.ts`'s
 * wire shape, mirrored field-for-field (UR-17,
 * Every decimal is a JSON string, never a number
 * (NFR-12/AC53) — including `seq` (a `bigint` column serialised as a decimal
 * string, since `JSON.stringify` cannot carry a raw `bigint`). `instrumentId`
 * is nullable (DEPOSIT/WITHDRAWAL/CURRENCY_EXCHANGE/INTEREST, and
 * a FEE that references no instrument — `portfolio-cash` PC-L14) and
 * every FX-leg quintet (`fxRate*`/`feeFxRate*`) is independent —
 * the fee leg is `null` whenever its amount is absent (the withholding has no
 * FX leg of its own since 0079), never defaulted to the principal leg's own values.
 *
 * `<LedgerAmount>` (UR-18), not `<Figure>`, is the renderer for every field
 * here: none of these decimals is `ValuedAmount`-shaped (no `provenance`
 * envelope on the wire for this resource at all — OD-4, FR-109/AC102).
 */
export interface TransactionResponse {
  readonly id: string;
  readonly portfolioId: string;
  readonly kind: string;
  readonly tradeDate: string;
  readonly tradeTs: string | null;
  readonly seq: string;
  readonly instrumentId: string | null;
  readonly quantity: string | null;
  readonly unitPrice: string | null;
  readonly grossAmount: string;
  readonly txnCurrency: string | null;
  readonly txnSettlementInstrumentId: string | null;
  readonly targetCurrency: string | null;
  readonly targetAmount: string | null;
  readonly feeAmount: string | null;
  // `feeCurrency` and `feeCashAccountId` were here until the cost rework: a cost
  // is denominated by the settling account (L5), so the response no longer
  // carries either. Rows written before this release still have the columns —
  // A later migration drops them — but nothing on this side reads them.
  /** One amount, denominated by the settling account; its currency, account and rate were dropped by migration `0079`. */
  readonly withholdingAmount: string | null;
  readonly sourceDividendId: string | null;
  /**
   * CA-21 (CD12) — the four
   * per-leg cash-account ids, mirrored from
   * `api/src/transactions/transactions.schema.ts` (see that file's own note
   * on why they are bare ids and not embedded account objects).
   * `TransactionEditForm.tsx` reads these to preselect each leg's current
   * account, which is what keeps an archived-but-attributed account
   * offerable on the edit form instead of silently blanked.
   */
  readonly cashAccountId: string | null;
  readonly targetCashAccountId: string | null;
  /**
   * FT-17/FT-22 (FR-255/FR-258): the principal cash leg's settlement pair — the currency
   * the settling account is denominated in, and how much of it moved.
   *
   * Both `null` for a row that moved no cash at all (an asset-settled BUY),
   * and **equal to `txnCurrency`/`grossAmount` in the degenerate case** — which
   * is why `TransactionDetailPanel` compares them rather than testing for
   * presence: "the field exists" is not "the settlement differs". Mirrored
   * from `api/src/transactions/transactions.schema.ts`, whose own note says
   * the same thing from the other side.
   */
  readonly cashCurrency: string | null;
  readonly cashAmount: string | null;
  /**
   * FR-208/FR-213 (`fee-tax-breakdown` phase 2): the itemisation of
   * `feeAmount`, which keeps its meaning as the **total**. All four `null` is
   * the unitemised shape — every pre-`0047` row, and every row a user chooses
   * not to itemise (L8) — so a surface must render the total when they are
   * absent rather than read absence as "no cost".
   */
  readonly brokerFeeAmount: string | null;
  readonly fxFeeAmount: string | null;
  readonly taxAmount: string | null;
  readonly otherCostAmount: string | null;
  readonly fxRate: string;
  readonly fxRateSource: string;
  readonly fxRateProviderKey: string | null;
  readonly fxRateObservedOn: string | null;
  readonly fxRateUserInput: string | null;
  // The `feeFxRate*` quintet stood here until the cost rework. A cost carries
  // the principal leg's rate (L5), so there is no fee FX group left to read —
  // `0049` dropped the columns and `income-totals.ts` derives the rate the way
  // the ledger does.
  readonly note: string | null;
  /**
   * The user's own reference for this transaction — a broker's
   * order number, a statement line. `null` for every row written before
   * migration `0057` and for every row whose author never filled the field,
   * which is why `TransactionDetailPanel` **omits** its row when it is absent
   * rather than rendering an em-dash: a placeholder in a data row reads as a
   * value, and there is none.
   */
  readonly reference: string | null;
  /**
   * `security-transfer`: the other leg of a security transfer — a
   * `TRANSFER_OUT`'s receiving `TRANSFER_IN`, or a `TRANSFER_IN`'s source — and
   * the portfolio it lives in. `null` for every other kind, for a transfer out
   * of Kerdial (FR-566), and for a target whose source portfolio was deleted
   * (FR-580, a « severed » target). `TransactionEditForm` reads the id to pick
   * a `TRANSFER_IN`'s editable set; the detail and delete surfaces resolve the
   * portfolio's name from the portfolio list.
   */
  readonly transferLinkedTransactionId: string | null;
  readonly transferLinkedPortfolioId: string | null;
  /** The cost a `TRANSFER_IN` carried in (FR-563), in the ledger base and in its own currency. `null` on every other kind, a `TRANSFER_OUT` included. */
  readonly transferCostBase: string | null;
  readonly transferCostNative: string | null;
  readonly transferCostCurrency: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransactionListPage {
  readonly items: readonly TransactionResponse[];
  readonly nextCursor: string | null;
}

export interface ListTransactionsParams {
  readonly portfolio?: string;
  readonly instrument?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  /**
   * UR-26 — the instrument-set
   * transaction scan's own page size (the server's `MAX_PAGE_LIMIT`, 100),
   * requested explicitly so the scan needs at most 50 pages for NFR-20's
   * 5,000-transaction assumption. Every other caller (`ActivityView.tsx`'s
   * ledger list) omits this and keeps getting the server's own
   * `DEFAULT_PAGE_LIMIT` (20) page — unchanged, see this function's own
   * "limit is deliberately never sent" note below, which still describes
   * every call site except the scan's.
   */
  readonly limit?: number;
  /** FR-264: "desc" = newest-first; omitted = the ledger's ascending default. */
  readonly order?: "asc" | "desc";
  /**
   * `?kind=` — one `TransactionKind`, or several comma-separated
   * (the server accepts a repeated parameter too, and normalises both to the
   * same `kind IN (…)`). Omitted = every kind.
   *
   * **This is the parameter that retired the Activité screen's client-side type
   * narrowing.** Until it existed the endpoint had no kind filter at all, so
   * `ActivityView.tsx` filtered `data.items` — the currently loaded page — and
   * said so in an apology next to the control. Anything sending this now
   * filters the ledger; nothing may go back to filtering a page.
   */
  readonly kind?: string;
  /**
   * `?currency=` — the **trade's own** denomination
   * (`transaction.txn_currency`), not the settling account's and not the ledger
   * base. An asset-settled row has no `txn_currency` at all, so any value here
   * excludes every one of them; the filters panel says so next to the control
   * rather than leaving it a silent exclusion.
   */
  readonly currency?: string;
  /**
   * `?minAmount=`/`?maxAmount=` — inclusive bounds on
   * `gross_amount`, as plain decimal strings (never numbers),
   * **in `currency`**. The server refuses either bound without a
   * `currency` (422 `TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY`) because it
   * converts nothing; this wrapper does not pre-filter that combination, so
   * that refusal stays genuinely exercised rather than silently avoided —
   * `activityRoute`'s own `validateSearch` and `LedgerFiltersPanel`'s disabled
   * inputs are what keep the screen from reaching it.
   */
  readonly minAmount?: string;
  readonly maxAmount?: string;
}

/**
 * `GET /api/v1/transactions?portfolio=&instrument=&from=&to=&kind=&currency=&minAmount=&maxAmount=&cursor=&limit=`
 * (UR-17) — **one page per call,
 * never an exhaustion loop**: unlike `portfolios.ts`'s `fetchPortfolios` and
 * `instruments.ts`'s `listInstrumentPrices`, pagination here lives in the URL (`ActivityRoute.tsx`'s own
 * `cursor` search param, OD-1(c)) — a `cursor` pushes a new browser history
 * entry, and Back returns to the previous page. NFR-20's "a fixture with
 * 5,000 transactions pages without fetching more than one page at a time" is
 * exactly this: one call = one request = the server's own `DEFAULT_PAGE_LIMIT`
 * (20) page, never followed further by this function.
 *
 * `limit` is deliberately never sent by the ledger's own list view — the
 * server's own default (`DEFAULT_PAGE_LIMIT`, 20) is the page size that
 * screen is built around; a caller wanting a different size would need a
 * real UI control for it, which that task does not add. UR-26's
 * `transactionsInstrumentScanQueryOptions` (`queries.ts`) is the **one**
 * caller that does pass `limit` (100, the server's `MAX_PAGE_LIMIT`) — this
 * function still issues exactly one request per call either way; the scan's
 * own multi-page loop lives in `queries.ts`, not here, mirroring
 * `listInstrumentPrices`'s "one page per call" convention rather than this
 * function's own exhaustion-loop callers (`fetchPortfolios`).
 *
 * `priority` defaults to `"foreground"` — the ledger
 * list's own tier, unchanged — so every existing call site is unaffected;
 * `transactionsInstrumentScanQueryOptions` is the only caller that passes
 * `"background"` explicitly, since its own reads are a per-screen fan-out,
 * not the screen's own primary data.
 *
 * The response carries **no total count** (`{items, nextCursor}` only) and
 * the cursor is offset-based, not keyset — a
 * concurrent write can shift rows between page fetches. Neither property is
 * hidden from callers: this function returns exactly what the server sent,
 * with no client-side reconstruction of a total or a stable row identity
 * across pages.
 */
export function listTransactions(
  params: ListTransactionsParams = {},
  signal?: AbortSignal,
  priority: RequestPriority = "foreground",
): Promise<TransactionListPage> {
  const query = new URLSearchParams();
  if (params.portfolio !== undefined) query.set("portfolio", params.portfolio);
  if (params.instrument !== undefined) query.set("instrument", params.instrument);
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  if (params.cursor !== undefined) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.order !== undefined) query.set("order", params.order);
  if (params.kind !== undefined) query.set("kind", params.kind);
  if (params.currency !== undefined) query.set("currency", params.currency);
  if (params.minAmount !== undefined) query.set("minAmount", params.minAmount);
  if (params.maxAmount !== undefined) query.set("maxAmount", params.maxAmount);
  const queryString = query.toString();
  return cheapReadBudget.run(priority, signal, () =>
    apiFetch<TransactionListPage>(
      `/transactions${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

/** One `YYYY` or `YYYY-MM` bucket of the activity calendar. A period with no transaction is **absent**, never a zero entry — `HeatCalendar`'s gap fill is what draws it empty. */
export interface TransactionCalendarBucket {
  readonly period: string;
  readonly count: number;
  /** Σ `grossAmount × fxRate` in the ledger base — each row's principal leg; fees and withholding are not in it. A decimal string, never a number. */
  readonly volumeBase: string;
}

export interface TransactionCalendarTotals {
  readonly count: number;
  readonly volumeBase: string;
}

/**
 * `GET /api/v1/transactions/calendar`'s `200` body, mirroring
 * `api/src/transactions/transactions.schema.ts`'s `TransactionCalendarResponse`
 * field-for-field by hand (the `fx.ts`/`dividends.ts` convention). `total` is
 * the server's exact sum of `months[]`; nothing here re-sums.
 */
export interface TransactionCalendar {
  /** AR-5 — the tenant's ledger base, the unit of every `volumeBase`. */
  readonly baseCurrency: string;
  readonly total: TransactionCalendarTotals;
  /** `period` ascending. */
  readonly years: readonly TransactionCalendarBucket[];
  readonly months: readonly TransactionCalendarBucket[];
}

/** The list's filters without its paging and ordering — **one spelling, URL to HTTP**, exactly as `listTransactions` sends them. */
export type TransactionCalendarParams = Omit<ListTransactionsParams, "cursor" | "limit" | "order">;

/**
 * `GET /api/v1/transactions/calendar?portfolio=&instrument=&from=&to=&kind=&currency=&minAmount=&maxAmount=`
 * — the Activité screen's « Calendrier » tab. One read per
 * filter set, no pagination and no exhaustion loop: the server folds the whole
 * scope in one statement, so completeness is structural rather than reported
 * (the property `income-totals.ts`'s scan cannot have). An absent filter is
 * omitted from the query string, never sent empty.
 */
export function fetchTransactionCalendar(
  params: TransactionCalendarParams = {},
  signal?: AbortSignal,
): Promise<TransactionCalendar> {
  const query = new URLSearchParams();
  if (params.portfolio !== undefined) query.set("portfolio", params.portfolio);
  if (params.instrument !== undefined) query.set("instrument", params.instrument);
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  if (params.kind !== undefined) query.set("kind", params.kind);
  if (params.currency !== undefined) query.set("currency", params.currency);
  if (params.minAmount !== undefined) query.set("minAmount", params.minAmount);
  if (params.maxAmount !== undefined) query.set("maxAmount", params.maxAmount);
  const queryString = query.toString();
  return cheapReadBudget.run("foreground", signal, () =>
    apiFetch<TransactionCalendar>(
      `/transactions/calendar${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

/** `GET /api/v1/transactions/:id` (UR-17) — every field {@link TransactionResponse} carries, typed. */
export function getTransaction(id: string, signal?: AbortSignal): Promise<TransactionResponse> {
  return cheapReadBudget.run("foreground", signal, () =>
    apiFetch<TransactionResponse>(`/transactions/${id}`, undefined, signal),
  );
}

/**
 * `PATCH /api/v1/transactions/:id` (UR-20, FR-105). `body` is
 * only ever built from `editTransactionBodySchema`'s own field set
 * (`quantity`/`unitPrice`/`feeAmount`/`withholdingAmount`/`targetAmount`/
 * `note`/`instrumentId`/`tradeTs`) by `TransactionEditForm.tsx` — this
 * wrapper does not itself validate the shape, mirroring `createTransaction`'s
 * own "the caller validates, this only transports" convention. FX/currency/
 * `tradeDate`/settlement fields are rejected server-side with 400
 * `TRANSACTION_FX_EDIT_FORBIDDEN` if ever sent — this wrapper does not
 * pre-filter them either, so that rejection is genuinely exercised rather
 * than silently avoided.
 */
export function editTransaction(
  id: string,
  body: Record<string, unknown>,
): Promise<TransactionResponse> {
  return apiFetch<TransactionResponse>(`/transactions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * `PATCH /api/v1/transactions/:id/fx-rate` (UR-21, FR-106) — the **only**
 * `fx_correction` HTTP path, and the **only** field it accepts:
 * `{fxRate}`. Corrects the **principal** leg only — fee/withholding legs are
 * structurally unreachable by this or any other edit path.
 */
export function correctTransactionFxRate(id: string, fxRate: string): Promise<TransactionResponse> {
  return apiFetch<TransactionResponse>(`/transactions/${id}/fx-rate`, {
    method: "PATCH",
    body: JSON.stringify({ fxRate }),
  });
}

/** `DELETE /api/v1/transactions/:id` (UR-22, FR-107) — a hard delete, 204/no body (`apiFetch`'s existing 204 -> `undefined` convention). */
export async function deleteTransaction(id: string): Promise<void> {
  await apiFetch<undefined>(`/transactions/${id}`, { method: "DELETE" });
}

/**
 * `POST /api/v1/transactions` (T-38/T-44) — `body` is the
 * raw, pre-`zDecimal`-transform request shape (every decimal a JSON string,
 * validated client-side against the identical
 * `createTransactionBodySchema` (`@kerdial/api-contracts`, T-44's
 * shared-Zod-schema package) before this is ever called — see
 * `TransactionForm.tsx`'s own resolver. The response shape
 * (`api/src/transactions/transactions.schema.ts`'s `TransactionResponse`) is
 * not consumed by the form itself (it only needs to know the call
 * succeeded), so it is typed `unknown` here rather than duplicated.
 */
export function createTransaction(body: Record<string, unknown>): Promise<unknown> {
  return apiFetch<unknown>("/transactions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
