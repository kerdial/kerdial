import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  fetchClosedPositions,
  fetchHoldings,
  fetchOverview,
  fetchPortfolioCash,
  fetchPortfolioClosedPositions,
  fetchPortfolioHoldings,
  fetchPortfolioOverview,
  fetchPortfolioPerformance,
  fetchPortfolioValueSeries,
  fetchPortfolios,
  fetchValueSeries,
  type OverviewRangeParams,
} from "../api-client.js";

/**
 * `range` feeds `?from=&to=` straight through to `GET /portfolios/overview`
 * (T-45's period selector; "Query
 * keys include ... the date range"). Callers resolve a preset id to a
 * concrete `{ from, to }` before calling this (`period-presets.ts`'s
 * `resolvePresetRange`) — this function itself does not know about presets,
 * only the resolved window.
 *
 * `"combined"` is the fixed `scope` slot placed *after* the
 * resource (never before it): `["portfolios","overview", scope, from, to]`.
 * The combined (all-portfolios) view is the only caller today, so `scope` is
 * always `"combined"` here — a future per-portfolio detail view supplies its
 * own `portfolioId` in that same slot. Keeping the slot in a fixed position
 * is what lets `invalidate-derived.ts`'s bare `["portfolios","overview"]`
 * prefix keep matching both variants without knowing which ones are mounted.
 */
export function overviewQueryOptions(range: OverviewRangeParams = {}) {
  return queryOptions({
    queryKey: ["portfolios", "overview", "combined", range.from ?? null, range.to ?? null] as const,
    queryFn: ({ signal }) => fetchOverview(range, signal),
  });
}

/**
 * `GET /portfolios/value-series?from=&to=` (FR-262) — the performance
 * screen's chart series. Same `["portfolios", resource, scope, from,
 * to]` key shape {@link overviewQueryOptions} uses, `"combined"` in the fixed
 * scope slot. `invalidate-derived.ts` gains a `VALUE_SERIES_PREFIX` entry for
 * it — the two-element prefixes there are per-resource, so this key is NOT
 * covered by the overview's, and a new transaction would otherwise leave the
 * chart holding a pre-write shape under a post-write total.
 *
 * The budget is applied inside `fetchValueSeries` itself, not here — see that
 * function's own note on why every caller of a valuation read shares one slot.
 */
export function valueSeriesQueryOptions(range: OverviewRangeParams = {}) {
  return queryOptions({
    queryKey: [
      "portfolios",
      "value-series",
      "combined",
      range.from ?? null,
      range.to ?? null,
    ] as const,
    queryFn: ({ signal }) => fetchValueSeries(range, signal),
  });
}

/** `"combined"` scope slot — see {@link overviewQueryOptions}'s doc comment. */
export function holdingsQueryOptions() {
  return queryOptions({
    queryKey: ["portfolios", "holdings", "combined"] as const,
    queryFn: ({ signal }) => fetchHoldings(signal),
  });
}

/**
 * `GET /portfolios/closed-positions` — the « Clôturées » tab
 * (OD-2/UR-41). Same
 * `["portfolios", resource, scope]` shape {@link holdingsQueryOptions} uses,
 * with `"combined"` in the fixed scope slot, so `invalidate-derived.ts`'s bare
 * `["portfolios","closed-positions"]` prefix matches this and the per-portfolio
 * variant below with no per-caller knowledge of which is mounted.
 *
 * **No `enabled` here, deliberately** — laziness is the *caller's* decision and
 * this factory must stay usable by a caller that wants the read eagerly.
 * `HoldingsRoute.tsx` spreads these options with `enabled: tab === TAB_CLOSED`
 * (CP-6): the Positions screen already spends the bound-1 `valuationReadBudget`
 * slot on `fetchHoldings`, so an unconditional second valuation read would
 * serialise behind it on every load of the most-visited screen and double that
 * screen's contribution to the server's per-tenant concurrency cap.
 */
export function closedPositionsQueryOptions() {
  return queryOptions({
    queryKey: ["portfolios", "closed-positions", "combined"] as const,
    queryFn: ({ signal }) => fetchClosedPositions(signal),
  });
}

/** `GET /portfolios/:id/closed-positions` — the scoped variant, `portfolioId` in the same scope slot. `retry: false` for the reason {@link portfolioOverviewQueryOptions} documents: this key is refetched by the bare-prefix invalidation every write performs. */
export function portfolioClosedPositionsQueryOptions(portfolioId: string) {
  return queryOptions({
    queryKey: ["portfolios", "closed-positions", portfolioId] as const,
    queryFn: ({ signal }) => fetchPortfolioClosedPositions(portfolioId, signal),
    retry: false,
  });
}

/** T-44's transaction form portfolio picker — every portfolio this tenant's session can see (FR-14). */
export function portfoliosQueryOptions() {
  return queryOptions({
    queryKey: ["portfolios", "list"] as const,
    queryFn: ({ signal }) => fetchPortfolios(signal),
  });
}

/**
 * `PortfolioDetailRoute.tsx`'s (UR-15) own scoped
 * overview read — `GET /portfolios/:id/overview?from=&to=`. Same
 * `["portfolios","overview", scope, from, to]` key shape
 * {@link overviewQueryOptions} already establishes for the combined view,
 * with `portfolioId` filling the
 * `scope` slot here instead of `"combined"` — so `invalidate-derived.ts`'s
 * bare `["portfolios","overview"]` prefix keeps matching this variant too,
 * with zero change to that helper.
 *
 * UR-16 (`PortfolioCardsPanel.tsx`) reuses this exact factory for its own
 * per-card read — one factory, one query key shape, two mount sites, never a
 * second one for the dashboard.
 *
 * `retry: false` (found necessary while red-confirming UR-16's own e2e
 * suite, not merely by inspection — see `portfolio-cards-panel-concurrency
 * .spec.ts`'s own note): it is expected that
 * `invalidateAndVerifyCalcEpoch` refetching **every** currently-active query
 * under the bare `["portfolios","overview"]` prefix, including however many
 * dashboard cards happen to be mounted — `queryClient.refetchQueries`
 * *awaits* every matched query's fetch (catching, never re-throwing, an
 * individual rejection) before its own promise resolves. TanStack Query's
 * *default* retry policy (3 attempts, exponential backoff) would multiply
 * that wait by several seconds for every dashboard card whose read happens
 * to fail at that exact moment — silently slowing down or (in this repo's
 * own e2e suite, several pre-existing specs' fixed assertion timeouts)
 * visibly breaking every *other* mutation's "await verification, then close"
 * flow while the dashboard merely happens to be mounted in the background.
 * The same reasoning `instrumentDiscoveryQueryOptions`/
 * `instrumentHistoryStatusQueryOptions` already document for their own
 * `retry: false`: a budgeted/shared-prefix read must fail fast, not
 * compound retries on top of a caller-owned recovery mechanism (here,
 * TWR/MWR staying visibly stale is the honest degradation — not a client
 * retry storm).
 */
export function portfolioOverviewQueryOptions(
  portfolioId: string,
  range: OverviewRangeParams = {},
) {
  return queryOptions({
    queryKey: [
      "portfolios",
      "overview",
      portfolioId,
      range.from ?? null,
      range.to ?? null,
    ] as const,
    queryFn: ({ signal }) => fetchPortfolioOverview(portfolioId, range, signal),
    retry: false,
  });
}

/** `PortfolioDetailRoute.tsx`'s scoped holdings read — see {@link portfolioOverviewQueryOptions}'s doc comment for both the scope-slot convention and the `retry: false` rationale, both shared here unchanged. */
export function portfolioHoldingsQueryOptions(portfolioId: string) {
  return queryOptions({
    queryKey: ["portfolios", "holdings", portfolioId] as const,
    queryFn: ({ signal }) => fetchPortfolioHoldings(portfolioId, signal),
    retry: false,
  });
}

/**
 * `PortfolioDetailRoute.tsx`'s Performance tab — `GET
 * /portfolios/:id/performance?from=&to=`. `["portfolios","performance",
 * portfolioId, from, to]` — this response
 * carries **no `calcEpoch`** on the wire, so it is never routed through
 * `invalidateAndVerifyCalcEpoch`/`isCalcEpochBearing` (that filter simply
 * never matches it — `invalidate-derived.ts`'s own doc comment). `retry:
 * false` for the same reason {@link portfolioOverviewQueryOptions} documents
 * (this key shares the same bare-prefix-refetch exposure whenever a mutation
 * invalidates `["portfolios","performance"]`, `invalidate-derived.ts`'s own
 * `PERFORMANCE_PREFIX`).
 */
export function portfolioPerformanceQueryOptions(
  portfolioId: string,
  range: OverviewRangeParams = {},
) {
  return queryOptions({
    queryKey: [
      "portfolios",
      "performance",
      portfolioId,
      range.from ?? null,
      range.to ?? null,
    ] as const,
    queryFn: ({ signal }) => fetchPortfolioPerformance(portfolioId, range, signal),
    retry: false,
  });
}

/**
 * `GET /portfolios/:id/value-series?from=&to=` — the Performance screen's
 * chart series when one portfolio is isolated. `portfolioId` fills the
 * fixed scope slot {@link valueSeriesQueryOptions} keeps `"combined"` in, so
 * `invalidate-derived.ts`'s bare `VALUE_SERIES_PREFIX` matches both variants
 * with no change to that helper — a transaction write refetches the isolated
 * curve exactly as it refetches the combined one.
 *
 * `retry: false` for the reason {@link portfolioOverviewQueryOptions}
 * documents: a budgeted read under a bare-prefix refetch must fail fast.
 */
export function portfolioValueSeriesQueryOptions(
  portfolioId: string,
  range: OverviewRangeParams = {},
) {
  return queryOptions({
    queryKey: [
      "portfolios",
      "value-series",
      portfolioId,
      range.from ?? null,
      range.to ?? null,
    ] as const,
    queryFn: ({ signal }) => fetchPortfolioValueSeries(portfolioId, range, signal),
    retry: false,
  });
}

/**
 * `GET /portfolios/:id/cash` — CA-19. Key `["portfolios","cash", portfolioId]`, the same
 * resource-then-scope shape {@link overviewQueryOptions} establishes, so
 * `invalidate-derived.ts`'s bare `["portfolios","cash"]` prefix matches every
 * mounted scope with no per-caller knowledge.
 *
 * **Two mount sites share this one key, and that is the point.** The
 * « Espèces » tab reads it for balances; `CashAccountPicker` reads it for the
 * account list at both transaction-form entry points. TanStack Query dedups
 * identical keys, so a `CURRENCY_EXCHANGE` form showing two pickers for the
 * same portfolio issues **one** request, not two — which is also why no
 * request-count assertion in this suite may be written as "N pickers → N
 * requests".
 *
 * `retry: false` for the reason {@link portfolioOverviewQueryOptions}
 * documents: this key is refetched by the bare-prefix invalidation every
 * transaction write performs, and compounding retries there would slow every
 * other mutation's "await verification, then close" flow.
 */
export function portfolioCashQueryOptions(portfolioId: string) {
  return queryOptions({
    queryKey: ["portfolios", "cash", portfolioId] as const,
    queryFn: ({ signal }) => fetchPortfolioCash(portfolioId, signal),
    retry: false,
  });
}

/**
 * `["portfolios","list"]` — the **one** key all three portfolio render surfaces
 * read from.
 * `PortfoliosRoute` and `PortfolioCardsPanel` both mount
 * {@link portfoliosQueryOptions}; `PortfolioDetailView` does too, finding its
 * row with `portfoliosQuery.data?.find((p) => p.id === portfolioId)` rather
 * than a per-id read. So a write that changes a portfolio's own fields has
 * exactly one key to drop.
 *
 * A bare two-element prefix, so TanStack Query's default prefix matching
 * already covers every mounted consumer with zero per-caller knowledge — the
 * property `invalidate-derived.ts` records for its own eight prefixes.
 */
const PORTFOLIO_LIST_KEY = ["portfolios", "list"] as const;

/**
 * `POST /portfolios` ⇒ list + overview + holdings. **Unchanged from before
 * `portfolio-details`**: a new portfolio changes `portfolioCount`, which the
 * two combined reads carry, and the four new fields do not widen that set.
 */
export async function invalidateAfterPortfolioCreate(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    [PORTFOLIO_LIST_KEY, ["portfolios", "overview"], ["portfolios", "holdings"]].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

/**
 * `PATCH /portfolios/:id` (any of `name`, `broker`, `description`,
 * `accentColor`) ⇒ `["portfolios","list"]` **only** (PD-14).
 *
 * `invalidateCashAccounts`' documented reason, applied verbatim: a label change
 * moves no figure, so invalidating the derived set would refetch overview,
 * holdings and performance for a write that provably cannot have moved any of
 * them. And it is deliberately **not** routed through
 * `invalidateAndVerifyCalcEpoch` — that helper waits for `calc_epoch` to
 * advance, and nothing here advances it, so every successful edit would burn
 * the whole retry budget and then surface a spurious « fraîcheur non
 * confirmée ».
 */
export async function invalidateAfterPortfolioUpdate(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: PORTFOLIO_LIST_KEY });
}

/**
 * `PUT` / `DELETE /portfolios/:id/icon` ⇒ `["portfolios","list"]` — **and the
 * caller still owes an `iconVersion` bump** (and it is the half that is
 * easy to forget).
 *
 * Both halves are required and neither substitutes for the other: this
 * invalidation flips `hasIcon` on the next list read, but the *bytes* are in no
 * cache the flag reaches, so a mounted `<img>` keeps the bitmap it already
 * decoded — `no-store` does not evict an element that is already showing the
 * picture (GATE-3). Conversely the bump alone leaves `hasIcon` stale
 * after a removal. `PortfolioIconTile` takes the counter; this function
 * deliberately cannot do it for the caller, because the counter is local React
 * state owned by the screen that manages the icon.
 */
export async function invalidateAfterPortfolioIconWrite(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: PORTFOLIO_LIST_KEY });
}
