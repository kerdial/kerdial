import { apiFetch } from "./core.js";

/**
 * `/api/v1/dividends/summary` (DS-6,
 * FR-265/FR-271–
 * FR-273/FR-279/FR-284).
 *
 * The wire types below mirror `api/src/dividends/dividends.schema.ts`
 * field-for-field **by hand**, the convention `fx.ts:10-19` documents, with its
 * two load-bearing rules restated because getting either wrong is silent:
 *
 *  - **Every decimal is a `string`.** A decimal never crosses this boundary as
 *    a number. Typing `grossBase` as `number` would
 *    compile and then quietly round a summed figure inside `JSON.parse`.
 *  - **Absence means absence.** The empty shape is `[]` and `"0"` — the
 *    server's own (`dividend-summary-service.ts`) — never a figure this
 *    layer invents. `from`/`to`/`portfolioId` are `null` for "unbounded" /
 *    "every portfolio", and are echoed exactly as asked, so the screen labels
 *    the two nulls rather than guessing at a window.
 *
 * There is nothing here for `tester-schema-parity.test.ts` to check: that file
 * proves shared **request-body Zod schemas** are the same object across both
 * import paths, and a response type has no shared schema to be checked against.
 */

/** One instrument's dividend history within the requested scope (FR-269). */
export interface DividendInstrumentRow {
  readonly instrumentId: string;
  /** Embedded by the server rather than resolved client-side: a fully-sold instrument still has dividend history and no holdings row at all. */
  readonly displayName: string;
  /** The local ticker for the payer tile's monogram — `null` when the instrument has none, never `""`. */
  readonly symbol: string | null;
  /** Whether this tenant has an icon for the instrument; the tile renders it when true and the monogram otherwise. */
  readonly hasIcon: boolean;
  readonly grossBase: string;
  /** A positive magnitude — the ledger flips the withholding leg's sign once, in SQL, so nothing here ever negates. */
  readonly withholdingBase: string;
  /** Distinct counted DIVIDEND transactions. A linked DRIP moves neither this nor `grossBase` (AC-282). */
  readonly paymentCount: number;
}

/** One `YYYY` or `YYYY-MM` bucket (FR-274–FR-277). A period with no counted dividend is **absent**, never a zero-valued entry — `DividendTimeChart`'s `fillBucketGaps` is what turns that into a visible gap. */
export interface DividendPeriodBucket {
  readonly period: string;
  readonly grossBase: string;
  readonly withholdingBase: string;
}

/** LD-1 — the two figures stay independent: never netted, never implicitly decomposed. */
export interface DividendTotalsRow {
  readonly grossBase: string;
  readonly withholdingBase: string;
}

/**
 * `GET /dividends/summary`'s `200` body — both halves of the screen from one
 * snapshot (DV4), which is why FR-272/AC-287's "the table and the chart
 * re-scope together" is structural here rather than coordinated.
 *
 * **No `calcEpoch`** (DV10), deliberately: `transaction_posting` is a
 * write-time projection, so there is no staleness window for an epoch to
 * describe. `invalidate-derived.ts`'s own `DIVIDENDS_PREFIX` note records the
 * direct consequence — this key is never routed through
 * `invalidateAndVerifyCalcEpoch`.
 */
export interface DividendSummary {
  /** FR-284/LD-4 — the tenant's ledger base currency, the unit of every figure here. Correct for a tenant with zero dividends too. */
  readonly baseCurrency: string;
  /** Echoed exactly as asked; `null` = unbounded (FR-271's all-time default). */
  readonly from: string | null;
  readonly to: string | null;
  /** Echoed applied filter; `null` = every portfolio this tenant owns (LD-5). */
  readonly portfolioId: string | null;
  readonly total: DividendTotalsRow;
  /** `grossBase` descending, ties broken by `instrumentId` — the server's own order, which is also the table's default sort, so the first paint is not a re-sort. */
  readonly instruments: readonly DividendInstrumentRow[];
  /** `period` ascending. */
  readonly years: readonly DividendPeriodBucket[];
  readonly months: readonly DividendPeriodBucket[];
}

/**
 * `?from=&to=&portfolio=` — **one spelling, URL to HTTP**. The parameter
 * is `portfolio`, matching `listTransactionsQuerySchema`'s own; `portfolioId`
 * appears only in the response, as the echo of the applied filter.
 */
export interface DividendSummaryParams {
  readonly from?: string;
  readonly to?: string;
  readonly portfolio?: string;
}

/**
 * `GET /dividends/summary`.
 *
 * **No read budget.** `cheapReadBudget`/`valuationReadBudget` bound a
 * client-side *fan-out* — several concurrent per-row reads from one screen.
 * This screen issues exactly one read on mount and one after each write, so
 * there is nothing to schedule; the server's own shared cheap-read concurrency
 * cap is what bounds it. (`fx.ts:53-61` records the same reasoning for the same
 * situation.)
 *
 * An absent bound is **omitted from the query string entirely**, never sent as
 * an empty value: the all-time default is the absence of a `from` predicate
 * (FR-271, AC-286), and `?from=` would be a 400 `VALIDATION_ERROR`.
 */
export function fetchDividendSummary(
  params: DividendSummaryParams = {},
  signal?: AbortSignal,
): Promise<DividendSummary> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  if (params.portfolio !== undefined) query.set("portfolio", params.portfolio);
  const queryString = query.toString();
  return apiFetch<DividendSummary>(
    `/dividends/summary${queryString === "" ? "" : `?${queryString}`}`,
    undefined,
    signal,
  );
}
