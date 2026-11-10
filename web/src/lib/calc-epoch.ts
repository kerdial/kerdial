import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * AC23's client half (T-45):
 * "`calc_epoch` is returned in every API response containing derived
 * figures. The frontend uses it to invalidate its TanStack Query cache after
 * a mutation ... the client half of AC23." Merely calling
 * `invalidateQueries` is not, by itself, a *guarantee*: `invalidateQueries`
 * only refetches *actively observed* queries, and nothing about it proves the
 * refetched response actually reflects the write that just happened (a slow
 * read replica, or simply an unlucky race, could in principle hand back the
 * same figures that were on screen before the write — `GET /api/v1/**` is
 * `NetworkOnly` since ADR-0009 Stage 1, so a service-worker cache is no
 * longer one of the possible causes). This helper closes that gap directly:
 * it invalidates, refetches,
 * and then *verifies* the refetched `calcEpoch` actually differs from the
 * value captured immediately before the write — retrying (bounded) rather
 * than accepting a response that cannot be proven fresh.
 *
 * Deliberately keyed off a query-key *prefix* (`exact: false`, TanStack
 * Query's default match semantics for a partial key array), not one caller-
 * supplied exact key: the overview query's own key also carries the
 * currently selected period (`queries.ts`'s `overviewQueryOptions`), which
 * this helper — called from the transaction form, which has no idea what
 * period is currently selected on screen — must never need to know.
 *
 * F2 (security review, T-45, MEDIUM), two related fixes:
 *
 * (a) Both the baseline snapshot and every re-check are scoped to `type:
 * "active"` queries only — matching exactly what `invalidateQueries({
 * refetchType: "active" })`/`refetchQueries({ type: "active" })` actually
 * refetch. Before this fix, an *inactive* sibling query under the same
 * prefix (e.g. a previously-viewed period the user has since navigated away
 * from, still cached but no longer observed) was captured in the baseline
 * but never refetched — its `calcEpoch` could never advance, so the
 * "every entry has advanced" predicate was permanently unsatisfiable
 * whenever such a sibling existed, exhausting every retry on an otherwise
 * perfectly healthy write.
 *
 * (b) Exhaustion is no longer silent. {@link invalidateAndVerifyCalcEpoch}
 * returns a discriminated {@link CalcEpochVerificationResult} rather than
 * resolving `void` — `{ verified: false }` tells the caller it could not
 * *prove* freshness within the retry budget, so a caller (`TransactionForm`)
 * can surface that honestly instead of silently treating "gave up" the same
 * as "confirmed fresh".
 */

interface CalcEpochBearing {
  readonly calcEpoch: string;
}

/** `invalidateAndVerifyCalcEpoch`'s outcome — see this file's own F2(b) doc comment. */
export type CalcEpochVerificationResult =
  { readonly verified: true } | { readonly verified: false };

const REFETCH_MAX_ATTEMPTS = 3;
const REFETCH_RETRY_DELAY_MS = 200;

/** Matches `invalidateQueries`/`refetchQueries`'s own `active`-only refetch scope (F2a) — both `snapshotEpochs` and `hasAdvancedPastBaseline` must agree with this, or an inactive sibling can never satisfy the predicate. */
const ACTIVE_ONLY = { type: "active" } as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCalcEpochBearing(value: unknown): value is CalcEpochBearing {
  return (
    typeof value === "object" &&
    value !== null &&
    "calcEpoch" in value &&
    typeof (value as { calcEpoch: unknown }).calcEpoch === "string"
  );
}

function snapshotEpochs(queryClient: QueryClient, queryKeyPrefix: QueryKey): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const [key, data] of queryClient.getQueriesData({
    queryKey: queryKeyPrefix,
    ...ACTIVE_ONLY,
  })) {
    if (isCalcEpochBearing(data)) {
      snapshot.set(JSON.stringify(key), data.calcEpoch);
    }
  }
  return snapshot;
}

/**
 * True once *every* currently-*active* cached entry under `queryKeyPrefix`
 * that also existed in `baseline` has moved past its baseline `calcEpoch` —
 * a query that only started existing after the mutation (no baseline entry)
 * is never considered stale, since there is nothing prior to compare it
 * against; an inactive entry is never considered at all (F2a).
 */
function hasAdvancedPastBaseline(
  queryClient: QueryClient,
  queryKeyPrefix: QueryKey,
  baseline: Map<string, string>,
): boolean {
  for (const [key, data] of queryClient.getQueriesData({
    queryKey: queryKeyPrefix,
    ...ACTIVE_ONLY,
  })) {
    if (!isCalcEpochBearing(data)) continue;
    const serializedKey = JSON.stringify(key);
    const previousEpoch = baseline.get(serializedKey);
    if (previousEpoch !== undefined && data.calcEpoch === previousEpoch) {
      return false;
    }
  }
  return true;
}

/**
 * Invalidates every active query under `queryKeyPrefix`, then keeps
 * refetching (bounded by {@link REFETCH_MAX_ATTEMPTS}) until every matching
 * active query's `calcEpoch` has advanced past what it was immediately
 * before this call. Resolves `{ verified: true }` once that is confirmed;
 * resolves `{ verified: false }` (F2b) if the retry budget is exhausted
 * without ever observing an advance — the caller must not treat that the
 * same as a confirmed-fresh write (the write itself still succeeded; only
 * the *display* could not be proven caught up).
 */
export async function invalidateAndVerifyCalcEpoch(
  queryClient: QueryClient,
  queryKeyPrefix: QueryKey,
): Promise<CalcEpochVerificationResult> {
  const baseline = snapshotEpochs(queryClient, queryKeyPrefix);

  await queryClient.invalidateQueries({ queryKey: queryKeyPrefix, refetchType: "active" });
  if (hasAdvancedPastBaseline(queryClient, queryKeyPrefix, baseline)) return { verified: true };

  for (let attempt = 1; attempt < REFETCH_MAX_ATTEMPTS; attempt += 1) {
    await delay(REFETCH_RETRY_DELAY_MS);
    await queryClient.refetchQueries({ queryKey: queryKeyPrefix, type: "active" });
    if (hasAdvancedPastBaseline(queryClient, queryKeyPrefix, baseline)) return { verified: true };
  }
  return { verified: false };
}
