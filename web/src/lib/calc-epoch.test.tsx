import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invalidateAndVerifyCalcEpoch } from "./calc-epoch.js";

/**
 * T-45's completion of AC23's client half. `Probe` stands in for the real overview/holdings screens: an
 * active `useQuery` observer is required for `invalidateQueries`'s
 * `refetchType: "active"` (this helper's own doc comment) to trigger a real
 * refetch at all — a bare `queryClient` with no mounted observer would never
 * exercise the retry loop this suite proves.
 */
function Probe({
  queryKey,
  queryFn,
}: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<{ calcEpoch: string }>;
}) {
  const { data } = useQuery({ queryKey, queryFn });
  return <span data-testid="epoch">{data?.calcEpoch ?? "none"}</span>;
}

describe("invalidateAndVerifyCalcEpoch", () => {
  it("resolves { verified: true } once the refetch's calcEpoch has advanced past the pre-write value", async () => {
    const queryClient = new QueryClient();
    let call = 0;
    const responses = [{ calcEpoch: "1" }, { calcEpoch: "2" }];
    const queryFn = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]!);
    const key = ["test", "epoch-advance"] as const;

    render(
      <QueryClientProvider client={queryClient}>
        <Probe queryKey={key} queryFn={queryFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("epoch")).toHaveTextContent("1"));

    await expect(invalidateAndVerifyCalcEpoch(queryClient, ["test"])).resolves.toEqual({
      verified: true,
    });

    await waitFor(() => expect(screen.getByTestId("epoch")).toHaveTextContent("2"));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  // Red-confirmed: with the retry loop removed (a bare `invalidateQueries` +
  // single `getQueryData` read, no re-check), this test fails — the second
  // call (the first refetch after invalidation) is a deliberately stale
  // response (still `calcEpoch: "1"`, simulating exactly the race this
  // helper exists to survive: a slow read replica, a caching layer in front
  // of `GET /api/v1/**`, or simply an unlucky ordering), so a caller that
  // trusted it blindly would still be looking at pre-write figures once this
  // function resolves.
  it("keeps retrying (bounded) when the first refetch after invalidation is still stale", async () => {
    const queryClient = new QueryClient();
    let call = 0;
    const responses = [{ calcEpoch: "1" }, { calcEpoch: "1" }, { calcEpoch: "2" }];
    const queryFn = vi.fn(async () => responses[Math.min(call++, responses.length - 1)]!);
    const key = ["test", "epoch-retry"] as const;

    render(
      <QueryClientProvider client={queryClient}>
        <Probe queryKey={key} queryFn={queryFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("epoch")).toHaveTextContent("1"));

    await expect(invalidateAndVerifyCalcEpoch(queryClient, ["test"])).resolves.toEqual({
      verified: true,
    });

    await waitFor(() => expect(screen.getByTestId("epoch")).toHaveTextContent("2"));
    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // F2b (security review, T-45, MEDIUM). Red-confirmed against the
  // pre-fix implementation (resolving `void` unconditionally): this test
  // fails with "expected undefined to equal { verified: false }" — silently
  // treating exhaustion the same as confirmed-fresh is exactly the bug.
  it("resolves { verified: false } once the retry budget is exhausted without ever observing an advance", async () => {
    const queryClient = new QueryClient();
    // calcEpoch never advances, no matter how many times it is refetched.
    const queryFn = vi.fn(async () => ({ calcEpoch: "1" }));
    const key = ["test", "epoch-never-advances"] as const;

    render(
      <QueryClientProvider client={queryClient}>
        <Probe queryKey={key} queryFn={queryFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("epoch")).toHaveTextContent("1"));

    await expect(invalidateAndVerifyCalcEpoch(queryClient, ["test"])).resolves.toEqual({
      verified: false,
    });

    // The initial mount fetch, plus every retry attempt this bounded loop
    // performs — proving it genuinely exhausted the budget rather than
    // giving up early.
    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  // F2a (security review, T-45, MEDIUM). Red-confirmed against the
  // pre-fix implementation (which snapshotted/verified *every* cached entry
  // under the prefix, active or not): this test fails there, because the
  // inactive "3M" sibling below is included in the baseline but never
  // refetched (`invalidateQueries`/`refetchQueries` only ever touch `active`
  // queries), so the "every entry has advanced" predicate can never be
  // satisfied and the call exhausts its retry budget — `verified: false` —
  // despite the one query actually on screen (`1Y`) advancing on the very
  // first refetch.
  it("ignores an inactive sibling query under the same prefix — verifies only the active one", async () => {
    const queryClient = new QueryClient();
    const staleSiblingQueryFn = vi.fn(async () => ({ calcEpoch: "1" }));
    let activeCall = 0;
    const activeResponses = [{ calcEpoch: "1" }, { calcEpoch: "2" }];
    const activeQueryFn = vi.fn(
      async () => activeResponses[Math.min(activeCall++, activeResponses.length - 1)]!,
    );

    // Mount the "3M" sibling, let it fetch once, then unmount — it stays
    // cached (default `gcTime`) but becomes inactive (no observer).
    const sibling = render(
      <QueryClientProvider client={queryClient}>
        <Probe queryKey={["test", "3M"]} queryFn={staleSiblingQueryFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(staleSiblingQueryFn).toHaveBeenCalledTimes(1));
    sibling.unmount();

    // The "1Y" query is the one actually on screen (active).
    render(
      <QueryClientProvider client={queryClient}>
        <Probe queryKey={["test", "1Y"]} queryFn={activeQueryFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("epoch")).toHaveTextContent("1"));

    await expect(invalidateAndVerifyCalcEpoch(queryClient, ["test"])).resolves.toEqual({
      verified: true,
    });

    // Verified promptly (the active query advanced on the very first
    // refetch) — not after exhausting retries waiting on a sibling that was
    // never going to refetch at all.
    expect(activeQueryFn).toHaveBeenCalledTimes(2);
    expect(staleSiblingQueryFn).toHaveBeenCalledTimes(1);
  });

  it("never touches a query outside the given key prefix", async () => {
    const queryClient = new QueryClient();
    const overviewQueryFn = vi.fn(async () => ({ calcEpoch: "1" }));
    const unrelatedQueryFn = vi.fn(async () => ({ calcEpoch: "unrelated" }));

    render(
      <QueryClientProvider client={queryClient}>
        <Probe queryKey={["portfolios", "overview"]} queryFn={overviewQueryFn} />
        <Probe queryKey={["something", "else"]} queryFn={unrelatedQueryFn} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(overviewQueryFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unrelatedQueryFn).toHaveBeenCalledTimes(1));

    await invalidateAndVerifyCalcEpoch(queryClient, ["portfolios", "overview"]);

    expect(unrelatedQueryFn).toHaveBeenCalledTimes(1);
  });

  it("does not hang when there is nothing cached yet under the prefix (no baseline to compare against)", async () => {
    const queryClient = new QueryClient();
    await expect(
      invalidateAndVerifyCalcEpoch(queryClient, ["portfolios", "never-fetched"]),
    ).resolves.toEqual({ verified: true });
  });
});
