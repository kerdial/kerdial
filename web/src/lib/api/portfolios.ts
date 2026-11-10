import type { InstrumentIconContentType, PortfolioAccentColor } from "@kerdial/core-reference-data";
import type { ValuedAmount } from "../../components/Figure.js";
import { cheapReadBudget, valuationReadBudget } from "../request-budget.js";
import { API_BASE, apiFetch } from "./core.js";

/**
 * `GET /api/v1/portfolios/overview` / `GET /api/v1/portfolios/holdings` — the
 * real T-45 screens' contract. Mirrored locally rather than imported from
 * `api` (`web` has no build-time dependency on it —
 * same convention as `Figure.tsx`'s own `ValuedAmount` mirror): these types
 * are kept in lockstep by hand with
 * `api/src/portfolios/portfolios.schema.ts`'s `OverviewResponse`/
 * `HoldingsResponse`.
 */
export interface TwrResponse {
  readonly available: boolean;
  readonly cumulative?: string;
  readonly annualised?: string | null;
  readonly rangeDays?: number;
  readonly subPeriodCount?: number;
  /** A closed set (`ReturnUnavailableCode`); the web maps it to French. */
  readonly reasonCode?: string;
  readonly reason?: string;
}

export interface MwrResponse {
  readonly converged: boolean;
  readonly rate?: string;
  readonly method?: "newton" | "bisection";
  readonly iterations?: number;
  /** See {@link TwrResponse.reasonCode}. */
  readonly reasonCode?: string;
  readonly reason?: string;
}

/**
 * The `cash` block of the overview and holdings responses — mirror of the
 * API's `CashBlockResponse` (FR-677). Always
 * present; `totalBase` is `"0"` when there is no cash and excludes any
 * `unconverted` currency. `rate`/`rateDate`/`valueBase` are `null` for an
 * unconverted currency; `rateDate` is also `null` for the base (rate `"1"`).
 * `totalValue.amount = Σ holdings[].currentValue.amount + totalBase`.
 */
export interface CashBlockResponse {
  readonly totalBase: string;
  readonly currency: string;
  readonly isNegative: boolean;
  readonly unconverted: readonly string[];
  readonly byCurrency: readonly {
    readonly currency: string;
    readonly amount: string;
    readonly rate: string | null;
    readonly rateDate: string | null;
    readonly valueBase: string | null;
  }[];
}

export interface OverviewResponse {
  readonly from: string;
  readonly to: string;
  readonly totalValue: ValuedAmount;
  readonly unrealizedGainLoss: ValuedAmount;
  /** FR-263: the dashboard tile's figure — same all-or-absent rule as the holdings total. */
  readonly dayChange?: ValuedAmount;
  readonly return: { readonly twr: TwrResponse; readonly mwr: MwrResponse };
  /** portfolio-cash FR-677: the as-of cash `totalValue` includes. */
  readonly cash: CashBlockResponse;
  readonly calcEpoch: string;
  readonly portfolioCount: number;
}

export interface OverviewRangeParams {
  readonly from?: string;
  readonly to?: string;
}

/**
 * `GET /api/v1/portfolios/overview?from=&to=` (T-45, AC24).
 *
 * Routed through `valuationReadBudget` at `foreground` priority, exactly as
 * {@link fetchValueSeries} and {@link fetchPortfolioOverview} are — this is a
 * valuation read, the costliest class the client bounds, so it must share the
 * one bound-1 slot (the server-side per-tenant cap it once mirrored was
 * retired since; the client bound stays).
 *
 * **It did not, until now.** This wrapper and {@link fetchHoldings} called
 * `apiFetch` directly while the four `:id/*`-and-`value-series` wrappers went
 * through the budget, so `request-budget.ts`'s claim that one tab can hold at
 * most one in-flight valuation read was false for the two routes the two
 * busiest screens actually read: `OverviewRoute.tsx` mounts
 * `overviewQueryOptions` + `holdingsQueryOptions` together (2 in flight), and
 * `PerformanceView.tsx` mounts `overviewQueryOptions` (unbudgeted) alongside
 * `valueSeriesQueryOptions` (budgeted, so it could not queue behind it).
 * Either screen therefore sat *at* the server cap, and any third read — a
 * second tab, the service worker's own re-issued fetch, a refetch on focus —
 * took the 429 (now the instance-wide `ADMISSION_BOUND_EXCEEDED`;
 * before that a per-tenant valuation-read code). Adding a budget to a route is only
 * half the mechanism; the wrapper has to use it.
 */
export function fetchOverview(
  params: OverviewRangeParams = {},
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  const queryString = query.toString();
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<OverviewResponse>(
      `/portfolios/overview${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

export interface RealizedGainResponse {
  readonly portfolioId: string;
  readonly tradeDate: string;
  readonly quantitySold: string;
  readonly gainBase: ValuedAmount;
  readonly gainNative: ValuedAmount;
  readonly fxComponentBase: ValuedAmount;
  readonly proceedsBase: ValuedAmount;
}

export interface HoldingResponse {
  readonly instrumentId: string;
  /**
   * Root-cause fix (tester's second
   * finding): additive field, now populated by
   * `api/src/portfolios/portfolios.schema.ts`'s `toValuedHoldingResponse` —
   * `HoldingHistoryStatus.tsx` reads this directly instead of issuing its own
   * `GET /instruments/:id` lookup per distinct holding.
   */
  readonly kind: string;
  /**
   * OD-9(a) (UR-8): additive field, populated the
   * same way `kind` above is — `HoldingsTable.tsx`/`HoldingsCardList.tsx`
   * read this directly instead of joining a name per row via
   * `GET /instruments/:id` (see `web/src/lib/tester-schema-parity.test.ts`
   * for the wire/mirror parity proof).
   */
  readonly displayName: string;
  /**
   * `instrument.symbol` — the ticker (or crypto symbol), `null`
   * when the instrument has none. Carried on the holdings read for the same
   * reason `displayName` is: the dashboard's positions pie labels each slice
   * with the code, and the alternative is a per-holding instrument fetch.
   * `PositionsPieCard` falls back to the monogram when it is `null`.
   */
  readonly symbol: string | null;
  /**
   * IR-12 (DD29): three additive
   * fields carried on the holdings response itself, for the identical reason
   * `kind`/`displayName` above are — the exposure breakdown regroups this
   * already-fetched response rather than resolving a classification per row
   * (the `ui-revamp` OD-9 precedent). `listingCountry` is derived server-side
   * from the MIC; `exchangeMic` is deliberately **not** on this wire shape.
   */
  readonly sectorCode: string | null;
  readonly domicileCountry: string | null;
  readonly listingCountry: string | null;
  /**
   * IK-10 (FR-313, FR-314) — whether
   * this tenant has uploaded an icon for this instrument, carried on the
   * holdings response itself for the identical reason `kind`/`displayName`
   * above are: the alternative is a per-row request asking the same question,
   * which FR-313 forbids outright. A boolean and not a URL — the URL is
   * `/api/v1/instruments/{instrumentId}/icon` for every tenant, so it carries
   * no information the row does not already have.
   */
  readonly hasIcon: boolean;
  readonly quantity: string;
  readonly currency: string;
  readonly pmp: ValuedAmount;
  readonly costBasis: ValuedAmount;
  readonly currentPrice: ValuedAmount;
  readonly currentValue: ValuedAmount;
  readonly unrealizedGainLoss: ValuedAmount;
  /**
   * FR-263: the day change — price-move only, `quantity ×
   * (current price − previous close) × current FX`, base-denominated. Absent
   * (never zero) when no previous close exists; render the absent state.
   */
  readonly dayChange?: ValuedAmount;
  /** The same move over the previous close (native, FX-free); shares `dayChange`'s provenance and absence. */
  readonly dayChangePercent?: string;
  readonly realizedGains: readonly RealizedGainResponse[];
}

export interface HoldingsResponse {
  readonly asOfDate: string;
  readonly holdings: readonly HoldingResponse[];
  readonly totalValue: ValuedAmount;
  readonly totalUnrealizedGainLoss: ValuedAmount;
  /** FR-263: present only when every holding's own dayChange is — partial sums are refused server-side. */
  readonly dayChange?: ValuedAmount;
  /** portfolio-cash FR-677: the as-of cash `totalValue` includes. */
  readonly cash: CashBlockResponse;
  readonly calcEpoch: string;
  readonly portfolioCount: number;
}

/** `GET /api/v1/portfolios/holdings` (T-45, AC25) — through `valuationReadBudget`, see {@link fetchOverview}'s doc comment for why both of these had to join it. */
export function fetchHoldings(signal?: AbortSignal): Promise<HoldingsResponse> {
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<HoldingsResponse>("/portfolios/holdings", undefined, signal),
  );
}

/**
 * `GET /api/v1/portfolios/value-series?from=&to=` — FR-262, mirroring
 * `api/src/portfolios/portfolios.schema.ts`'s `ValueSeriesResponse` field for
 * field.
 *
 * **The points are not `ValuedAmount` envelopes**, unlike every other figure
 * this file carries: the widest window (`RETURN_WINDOW_MAX_SPAN_YEARS`, 25
 * now) is ~9,100 points and per-point
 * provenance does not exist until AR-10. `value` is a decimal string in
 * `baseCurrency`, dense over `[from, to]`, with the **modelled zero** on
 * dates before the first trade — never interpolated (the server fails the
 * whole read loud rather than inventing a point). `provenance` is carried on
 * the wire and deliberately not mirrored here: the performance screen renders
 * the same series-level summary through the overview read it already makes.
 */
export interface ValueSeriesPoint {
  readonly date: string;
  readonly value: string;
  /**
   * Cumulative Σ DEPOSIT − Σ WITHDRAWAL in `baseCurrency` since inception, as
   * of the same start-of-day pre-flow instant as `value` — the
   * « capital investi » line. A decimal string, same rules as `value`.
   */
  readonly netContributions: string;
}

export interface ValueSeriesResponse {
  readonly from: string;
  readonly to: string;
  readonly baseCurrency: string;
  readonly points: readonly ValueSeriesPoint[];
}

/**
 * Routed through `valuationReadBudget` at `foreground` priority **in this
 * wrapper**, exactly as {@link fetchPortfolioOverview} is and for the reason
 * that function's doc comment records: this is a valuation read, so every
 * caller must share the one bound-1 slot rather than be able to construct a
 * factory that bypasses it.
 */
export function fetchValueSeries(
  params: OverviewRangeParams = {},
  signal?: AbortSignal,
): Promise<ValueSeriesResponse> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  const queryString = query.toString();
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<ValueSeriesResponse>(
      `/portfolios/value-series${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

/**
 * `GET /api/v1/portfolios/:id/value-series?from=&to=` — FR-262's per-portfolio
 * half, read by the Performance screen when one portfolio is
 * isolated. Same response shape as the combined route, same
 * `valuationReadBudget` slot for the reason {@link fetchValueSeries} records.
 */
export function fetchPortfolioValueSeries(
  id: string,
  params: OverviewRangeParams = {},
  signal?: AbortSignal,
): Promise<ValueSeriesResponse> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  const queryString = query.toString();
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<ValueSeriesResponse>(
      `/portfolios/${id}/value-series${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

/**
 * `GET /api/v1/portfolios/:id/performance` — mirrors `api/src/portfolios/
 * portfolios.schema.ts`'s `PerformanceResponse` exactly (`{from, to,
 * return: {twr, mwr}}`, no `totalValue`/`calcEpoch` — this route carries no
 * `calcEpoch` on the wire at all).
 */
export interface PerformanceResponse {
  readonly from: string;
  readonly to: string;
  readonly return: { readonly twr: TwrResponse; readonly mwr: MwrResponse };
}

/**
 * `GET /api/v1/portfolios/:id/overview` / `:id/holdings` / `:id/performance`
 * (UR-15) — the portfolio
 * workspace's own scoped reads (`PortfolioDetailRoute.tsx`), and (UR-16)
 * the dashboard's own per-card `:id/overview` read.
 *
 * Routed through `valuationReadBudget` at `foreground` priority **directly
 * in this wrapper** — unlike `instrumentByIdQueryOptions`'s convention
 * (budget wrapping lives in `queries.ts`, `background` priority) — deliberately:
 * every caller of `fetchPortfolioOverview`,
 * including UR-16's dashboard card fan-out, shares the exact same bound-1
 * budget at the exact same priority tier, so a future caller cannot bypass
 * the bound by constructing its own query-options factory with a different
 * tier for the identical endpoint.
 */
export function fetchPortfolioOverview(
  id: string,
  params: OverviewRangeParams = {},
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  const queryString = query.toString();
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<OverviewResponse>(
      `/portfolios/${id}/overview${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

/** `GET /api/v1/portfolios/:id/holdings` — see {@link fetchPortfolioOverview}'s doc comment for the budget/priority rationale, shared by every function in this group. */
export function fetchPortfolioHoldings(
  id: string,
  signal?: AbortSignal,
): Promise<HoldingsResponse> {
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<HoldingsResponse>(`/portfolios/${id}/holdings`, undefined, signal),
  );
}

/**
 * `GET /api/v1/portfolios/closed-positions` / `:id/closed-positions` —
 * FR-321…FR-330, mirrored
 * by hand from `api/src/portfolios/portfolios.schema.ts`'s
 * `ClosedPositionsResponse` exactly as `HoldingsResponse` above is (`web` has
 * no build-time dependency on `api`).
 *
 * The instruments this tenant now holds **zero** of, and what selling out of
 * them realized. Structurally the holdings shape minus the view-level totals a
 * closed view deliberately has none of (CP-9): no `totalValue`, no
 * `totalUnrealizedGainLoss`, no `dayChange` — none of them means anything for a
 * position that no longer exists.
 *
 * `realizedGains` is `RealizedGainResponse[]` — the **existing** type declared
 * above, unchanged and not re-declared (OD-5/UR-44): a leg's bytes are
 * identical whether it arrives on `HoldingResponse.realizedGains` or here, so a
 * second mirror of the same seven fields is exactly how two surfaces start
 * describing one sale two ways.
 *
 * `totalDisposedCostBasisBase` (FR-326) is the denominator for the return
 * percentage, and it is a denominator rather than a percentage on purpose
 * (FR-327): the server never computes the ratio, so the client decides what a
 * zero denominator renders as (`positions.ts`'s
 * `closedPositionReturnPercentageText` — a dash, never `0 %`, never `∞`).
 */
export interface ClosedPositionResponse {
  readonly instrumentId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly hasIcon: boolean;
  /** CP-3/A2: the instrument's **listing** currency, the same source the open holdings line labels its own native figures with — never a leg's `txn_currency`. */
  readonly currency: string;
  readonly totalRealizedGainBase: ValuedAmount;
  readonly totalRealizedGainNative: ValuedAmount;
  readonly totalFxComponentBase: ValuedAmount;
  readonly totalDisposedCostBasisBase: ValuedAmount;
  /** In wire order, never re-sorted client-side (FR-330). */
  readonly realizedGains: readonly RealizedGainResponse[];
}

export interface ClosedPositionsResponse {
  readonly asOfDate: string;
  readonly closedPositions: readonly ClosedPositionResponse[];
  readonly calcEpoch: string;
  /** 1 for the per-portfolio route; the tenant's portfolio count for the combined one — the same field `HoldingsResponse` carries. */
  readonly portfolioCount: number;
}

/**
 * `GET /api/v1/portfolios/closed-positions` — the tenant-wide view, the one
 * `HoldingsRoute.tsx`'s « Clôturées » tab reads.
 *
 * Through `valuationReadBudget` at `foreground` priority, **and that is not
 * optional decoration**: this is the same valuation-read class as
 * `/portfolios/holdings` (FR-332), so it must share the one bound-1 slot. See {@link fetchOverview}'s own doc comment for the recorded
 * regression that happened the last time a wrapper called `apiFetch` directly
 * while claiming the budget applied — "adding a budget to a route is only half
 * the mechanism; the wrapper has to use it."
 */
export function fetchClosedPositions(signal?: AbortSignal): Promise<ClosedPositionsResponse> {
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<ClosedPositionsResponse>("/portfolios/closed-positions", undefined, signal),
  );
}

/**
 * `GET /api/v1/portfolios/:id/closed-positions` — the per-portfolio view.
 *
 * **Ships without a screen mounting it, on purpose**: the route
 * has API and e2e coverage, and the portfolio workspace's own Positions tab
 * gains the tab in a follow-up — the same relationship
 * `GET /portfolios/:id/value-series` already has. The wrapper exists so that
 * follow-up cannot be tempted to build a second, unbudgeted fetcher.
 *
 * Budget/priority rationale as {@link fetchClosedPositions} and
 * {@link fetchPortfolioOverview}, shared unchanged.
 */
export function fetchPortfolioClosedPositions(
  id: string,
  signal?: AbortSignal,
): Promise<ClosedPositionsResponse> {
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<ClosedPositionsResponse>(`/portfolios/${id}/closed-positions`, undefined, signal),
  );
}

/** `GET /api/v1/portfolios/:id/performance?from=&to=` — see {@link fetchPortfolioOverview}'s doc comment for the budget/priority rationale, shared by every function in this group. */
export function fetchPortfolioPerformance(
  id: string,
  params: OverviewRangeParams = {},
  signal?: AbortSignal,
): Promise<PerformanceResponse> {
  const query = new URLSearchParams();
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  const queryString = query.toString();
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<PerformanceResponse>(
      `/portfolios/${id}/performance${queryString === "" ? "" : `?${queryString}`}`,
      undefined,
      signal,
    ),
  );
}

/**
 * `GET /api/v1/portfolios` (FR-14) — trimmed to the fields the transaction
 * form's picker and `PortfoliosRoute` need
 * (`api/src/portfolios/portfolios.schema.ts`'s `PortfolioResponse` also
 * carries `updatedAt`, not needed here). `transactionCount`/`createdAt` back
 * `PortfoliosRoute`'s list view and `PortfolioDeleteDialog`'s itemised
 * destructive-warning copy (D8).
 */
export interface PortfolioSummary {
  readonly id: string;
  readonly name: string;
  readonly transactionCount: number;
  readonly createdAt: string;
  /**
   * `portfolio-details` FR-449–FR-451, FR-467. All four ride **every**
   * portfolio-shaped response, list items included (the `hasIcon`
   * join costs zero extra statements), so all four are **required** here
   * rather than optional. An optional `hasIcon` would let a caller write
   * `portfolio.hasIcon ?? false` and silently render the wallet fallback for a
   * portfolio that has an icon — exactly the staleness FR-467 exists to
   * prevent.
   */
  readonly broker: string | null;
  readonly description: string | null;
  readonly accentColor: PortfolioAccentColor | null;
  /** Presence, never bytes (L8). The bitmap is fetched from {@link portfolioIconUrl}, and only when this is `true`. */
  readonly hasIcon: boolean;
  /**
   * portfolio-archive FR-593 — a display flag only (PA-L1): it hides the
   * portfolio from the cards panel, QuickSearch and every picker, and moves no
   * figure. Pickers go through `portfolioSelectOptions`, which keeps an
   * archived portfolio when it is the current value.
   */
  readonly archived: boolean;
}

/**
 * LOW-1 (security review): the largest
 * `?limit=` this endpoint accepts (`api/src/common/pagination.ts`'s
 * `MAX_PAGE_LIMIT`) — requesting it on every page keeps the number of
 * round-trips `fetchPortfolios` needs at a minimum.
 */
const PORTFOLIOS_PAGE_LIMIT = 100;

/**
 * LOW-1a (confirm review, fix round 2): the "at most 5 sequential requests"
 * figure documented on {@link fetchPortfolios} is an assumption about the
 * server, so it is enforced rather than trusted — the loop advances only on a
 * well-formed cursor that actually changed, and this hard page cap bounds it
 * even against a misbehaving or mocked server that omits `nextCursor` or
 * repeats one (either used to re-issue the identical request forever).
 */
const PORTFOLIOS_MAX_PAGES = 6;

/**
 * LOW-1 (security review): this used to
 * request the server's default `?limit=` (`DEFAULT_PAGE_LIMIT`, 20) and
 * return only that first page's `items`, silently discarding `nextCursor` —
 * so a tenant with more than 20 portfolios (up to `MAX_PORTFOLIOS_PER_TENANT`,
 * 500) never saw the rest in `/portfolios`, and `TransactionForm`'s own
 * portfolio picker could not even select one to record a transaction against.
 * Fixed by requesting {@link PORTFOLIOS_PAGE_LIMIT} (the server's own
 * `MAX_PAGE_LIMIT`) per page and following `nextCursor` until the server
 * reports none left — at most `MAX_PORTFOLIOS_PER_TENANT / PORTFOLIOS_PAGE_LIMIT`
 * = 5 sequential requests, never issued concurrently (each page's cursor
 * depends on the previous page's response), which is also why this cannot
 * itself trip the server's instance-wide admission bound — this call
 * ever holds one in-flight request at a time. Pages are concatenated in the order the server
 * returns them (`listPortfolios`'s own `ORDER BY name`, windowed), so the
 * result stays name-ascending overall, exactly as a single unpaginated read
 * would have been.
 */
export async function fetchPortfolios(signal?: AbortSignal): Promise<PortfolioSummary[]> {
  const items: PortfolioSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PORTFOLIOS_MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PORTFOLIOS_PAGE_LIMIT) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await apiFetch<{ items: PortfolioSummary[]; nextCursor: string | null }>(
      `/portfolios?${query.toString()}`,
      undefined,
      signal,
    );
    items.push(...response.items);
    const next = response.nextCursor;
    if (typeof next !== "string" || next === "" || next === cursor) break;
    cursor = next;
  }
  return items;
}

/**
 * `POST /api/v1/portfolios` (FR-P1, `POST /portfolios`, now
 * retroactively throttled — D9/OQ-P6) — `body` is validated client-side
 * against the identical `createPortfolioBodySchema` (`@kerdial/api-contracts`,
 * D10's shared-schema package) before this is ever called, see
 * `PortfolioNameForm.tsx`'s own resolver.
 */
export function createPortfolio(body: Record<string, unknown>): Promise<PortfolioSummary> {
  return apiFetch<PortfolioSummary>("/portfolios", { method: "POST", body: JSON.stringify(body) });
}

/**
 * `PATCH /api/v1/portfolios/:id` (FR-P2; `portfolio-details` FR-456–FR-459) —
 * `body` is validated client-side against `updatePortfolioBodySchema`, the
 * schema the route itself parses with (D10/D12).
 *
 * **Was `renamePortfolio`.** The endpoint is now genuinely partial, so the
 * name was a claim about a one-field body that no longer holds.
 *
 * **The caller must send only the fields it means to write**, and that is not
 * a style preference: the server's schema is `z.strictObject` with a
 * "at least one field" refinement (FR-457), so an unknown key is a `400` and
 * `{}` is a `400`. A `null` clears a field; an omitted key leaves it
 * unchanged. There is no sentinel and no `clear: []` array — JSON already
 * distinguishes absent from null, which is the whole of FR-453.
 * `PortfolioDetailsForm` builds the body from react-hook-form's `dirtyFields`
 * for exactly this reason and disables submit when that body would be empty.
 *
 * **The icon is not in this body** — it has its own three routes below
 * (PD-11: a 341 KiB base64 payload does not belong in a label edit).
 */
export function updatePortfolio(
  id: string,
  body: Record<string, unknown>,
): Promise<PortfolioSummary> {
  return apiFetch<PortfolioSummary>(`/portfolios/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * `PATCH /api/v1/portfolios/:id` with exactly `{ archived }` (portfolio-archive
 * FR-594/FR-595) — the server's `patchPortfolioBodySchema` is a union of this
 * one-key strict body and the four-field update, so `archived` never rides
 * with another field. Idempotent both ways; moves no figure.
 */
export function setPortfolioArchived(id: string, archived: boolean): Promise<PortfolioSummary> {
  return apiFetch<PortfolioSummary>(`/portfolios/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });
}

/**
 * `DELETE /api/v1/portfolios/:id` (FR-P3) — 204, no body
 * (`apiFetch`'s existing 204 -> `undefined` convention, matching
 * `DELETE /transactions/:id`).
 */
export async function deletePortfolio(id: string): Promise<void> {
  await apiFetch<undefined>(`/portfolios/${id}`, { method: "DELETE" });
}

/**
 * `GET /api/v1/portfolios/:id/icon` — the bytes, as an `<img src>`
 * (FR-463, FR-466, SD-5).
 *
 * A pure function of the id and **not** an existence oracle: the URL is
 * identical for every tenant and for a portfolio nobody has iconed, so it
 * carries no information the caller does not already hold. Whether to *render*
 * an `<img>` at it is decided by the `hasIcon` boolean
 * {@link PortfolioSummary} already carries (FR-467) — never by requesting it
 * and seeing what comes back.
 *
 * `API_BASE` rather than a second `/api/v1` literal: an `<img src>` is not an
 * `apiFetch` call, so it does not get the prefix for free.
 *
 * **Deliberately not cache-busted with a query token**, for
 * {@link instrumentIconUrl}'s measured reason: `no-store` leaves no cached copy
 * for one to defeat, and what it *cannot* reach — a bitmap already decoded into
 * a mounted `<img>` — is fixed at the element instead. `PortfolioIconTile` keys
 * the `<img>` on an `iconVersion` so a replace remounts it (GATE-3).
 */
export function portfolioIconUrl(portfolioId: string): string {
  return `${API_BASE}/portfolios/${portfolioId}/icon`;
}

/**
 * `PUT /portfolios/:id/icon`'s response — the stored icon's metadata
 * (`api/src/portfolios/portfolios.schema.ts`'s `PortfolioIconMetaResponse`),
 * mirrored here field for field, the convention every other wire type in this
 * module follows.
 *
 * **There is no `source` field**, unlike `InstrumentIconMetaResponse`: an
 * instrument icon can arrive from a provider, a portfolio icon can only be
 * uploaded by its owner, so there is no provenance seam to represent and the
 * table has no such column (FR-462/SD-2). Copying the instrument meta type
 * would be a wire contract claiming a distinction the storage cannot make.
 *
 * The bytes are not on it: they are read from {@link portfolioIconUrl}'s route.
 */
export interface PortfolioIconMetaResponse {
  readonly portfolioId: string;
  readonly contentType: InstrumentIconContentType;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly updatedAt: string;
}

export interface SetPortfolioIconInput {
  readonly portfolioId: string;
  /**
   * FR-460: sent so the server can *detect* a disagreement with the file's own
   * leading bytes, never so it can be trusted. The server sniffs the bytes and
   * stores the sniffed type; this field only ever causes a rejection.
   */
  readonly declaredContentType: string;
  /** Standard base64 — `setPortfolioIconBodySchema` **is** `setInstrumentIconBodySchema` (PD-13), so the accepted alphabet is the same one. No filename is sent. */
  readonly bytesBase64: string;
}

/**
 * `PUT /portfolios/:id/icon` — set **or** replace (FR-461): `portfolio_icon`'s
 * primary key is `(tenant_id, portfolio_id)` and the write is an upsert, so a
 * set on an already-iconed portfolio is one statement and `200` either way,
 * with no create-vs-overwrite signal for a client that already knows which it
 * did.
 *
 * JSON with base64 bytes rather than `multipart/form-data`, for
 * {@link setInstrumentIcon}'s reason: `IMPORT_MULTIPART_PATHS` is a closed
 * allowlist this cycle does not widen.
 */
export function setPortfolioIcon(input: SetPortfolioIconInput): Promise<PortfolioIconMetaResponse> {
  return apiFetch<PortfolioIconMetaResponse>(`/portfolios/${input.portfolioId}/icon`, {
    method: "PUT",
    body: JSON.stringify({
      declaredContentType: input.declaredContentType,
      bytesBase64: input.bytesBase64,
    }),
  });
}

/**
 * `DELETE /portfolios/:id/icon` — remove it, returning the portfolio to its
 * wallet fallback (FR-461).
 *
 * **`204` unconditionally**, whether or not a row existed and whether or not
 * the portfolio does: the route declines to make a removal an existence
 * signal, so this resolves rather than rejecting on a double-click or a second
 * tab. It is therefore **not** usable as a probe for "did this portfolio have
 * an icon" — `hasIcon` on the next list read is the only answer to that.
 * `apiFetch` already maps a `204` to `undefined`.
 */
export async function deletePortfolioIcon(portfolioId: string): Promise<void> {
  await apiFetch<undefined>(`/portfolios/${portfolioId}/icon`, { method: "DELETE" });
}

/**
 * `GET /api/v1/portfolios/:id/cash` and the two cash-account writes — CA-19/
 * CA-20. Mirrored by hand from `api/src/portfolios/cash-accounts.schema.ts`, exactly as
 * `OverviewResponse`/`HoldingsResponse` above are (`web` has no
 * build-time dependency on `api`).
 *
 * **There is no delete wrapper here, and that is deliberate** — OD-5 is
 * locked to archive, and `CashAccountsController` exposes no `@Delete` for
 * one to call (its own doc comment states that as an assertion). Archiving
 * is `patchCashAccount(..., { archived: true })`.
 *
 * **There is no transfer wrapper either** — OD-4 is locked out of scope this
 * cycle; no endpoint moves money between two accounts, so no client function
 * may imply one exists.
 */
export interface CashAccountBalance {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  /** Archived accounts are **listed and counted** — archiving hides an account from pickers, never from the balance (RC4). */
  readonly archived: boolean;
  /** A decimal string, never a JSON number. Rendered through `<Figure>`, never a bare formatter. */
  readonly balance: string;
  /** AC-183's explicit flag — the server's own sign test, never a client-side `startsWith("-")`. */
  readonly isNegative: boolean;
}

/** FR-161's per-currency rollup. Deliberately no portfolio-level grand total: two currencies are never summed (AC-180). */
export interface CashCurrencyTotal {
  readonly currency: string;
  readonly total: string;
  /** Archived accounts included — which is why this can exceed the number of accounts a picker offers. */
  readonly accountCount: number;
  readonly isNegative: boolean;
}

export interface PortfolioCashResponse {
  readonly accounts: readonly CashAccountBalance[];
  readonly byCurrency: readonly CashCurrencyTotal[];
  /** The epoch the whole payload was read at, in one statement (FR-162). */
  readonly calcEpoch: string;
}

/** `POST`/`PATCH /api/v1/portfolios/:id/cash-accounts*`'s response — a cash account's identity, with no balance. */
export interface CashAccountResponse {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `GET /api/v1/portfolios/:id/cash` — the tenth cheap-read route (CA-17), so
 * it shares `cheapReadBudget` (bound 4, strictly below the server's cap of 6)
 * rather than `valuationReadBudget`: it reads already-materialised
 * `cash_balance` rows and issues no provider call at all (AC-181).
 */
export function fetchPortfolioCash(
  id: string,
  signal?: AbortSignal,
): Promise<PortfolioCashResponse> {
  return cheapReadBudget.run("foreground", signal, () =>
    apiFetch<PortfolioCashResponse>(`/portfolios/${id}/cash`, undefined, signal),
  );
}

/** `POST /api/v1/portfolios/:id/cash-accounts` (FR-150/FR-152) — `{name, currency}`; the currency is fixed at creation and appears in no patch body anywhere (OD-2). */
export function createCashAccount(
  portfolioId: string,
  body: { readonly name: string; readonly currency: string },
): Promise<CashAccountResponse> {
  return apiFetch<CashAccountResponse>(`/portfolios/${portfolioId}/cash-accounts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * `PATCH /api/v1/portfolios/:id/cash-accounts/:accountId` — **exactly one** of
 * `name` (rename, FR-164) or `archived` (archive/un-archive, FR-165), which
 * is why this takes a union rather than a partial object: the server's
 * `patchCashAccountBodySchema` rejects both-at-once and empty alike, and a
 * `Partial<{name, archived}>` here would make either mistake expressible.
 */
export function patchCashAccount(
  portfolioId: string,
  accountId: string,
  body: { readonly name: string } | { readonly archived: boolean },
): Promise<CashAccountResponse> {
  return apiFetch<CashAccountResponse>(`/portfolios/${portfolioId}/cash-accounts/${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
