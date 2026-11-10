import { queryOptions } from "@tanstack/react-query";
import { fetchDividendSummary, type DividendSummaryParams } from "../api-client.js";

/**
 * The Dividendes screen's single query key — DS-6.
 *
 * **One key for the whole screen**, not one per half: the server answers the
 * per-instrument table, the yearly buckets, the monthly buckets and the
 * combined total in one response (DV4), so there is nothing to fan out and
 * nothing to keep consistent across several keys. FR-272/AC-287's "the table
 * and the chart re-scope together on one user action" is then structural —
 * they are two renderings of one query result, and a period change changes one
 * key.
 *
 * `{ signal }` is threaded through rather than passing `fetchDividendSummary`
 * directly: a plain `queryFn: fetchDividendSummary` never reads
 * `context.signal`, and `query-core`'s `#abortSignalConsumed` flag means an
 * in-flight GET would then not actually abort on `queryClient.clear()`
 * (`api/core.ts`'s own note).
 *
 * **No `staleTime`.** These figures move on every transaction write, which is
 * the fact the screen exists to report — `fxOverviewQueryOptions`
 * (`queries/fx.ts:12-17`) states the same reasoning for the same situation.
 *
 * `retry: false` — the same "fail fast rather than compound a caller-owned
 * recovery" reasoning every factory in `queries/transactions.ts` documents,
 * and here the read's own refusals make it sharper: both errors
 * (`DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE`, `DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG`)
 * are **permanent** — no cap to wait under, no throttle to pass — so three
 * silent retries can only turn the identical 422 into the identical 422, each
 * one costing the server a second walk of the same join (the DV6 guard plus
 * the aggregate). They would also hold back copy that says outright
 * « réessayer n'y changera rien » (`problem-messages.ts`) for the length of
 * the backoff, which is the one thing that message must not do.
 */
export const DIVIDEND_SUMMARY_PREFIX = ["dividends", "summary"] as const;

export function dividendSummaryQueryOptions(params: DividendSummaryParams = {}) {
  return queryOptions({
    queryKey: [...DIVIDEND_SUMMARY_PREFIX, params] as const,
    queryFn: ({ signal }) => fetchDividendSummary(params, signal),
    retry: false,
  });
}
