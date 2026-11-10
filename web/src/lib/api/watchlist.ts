import { apiFetch } from "./core.js";
import { cheapReadBudget, valuationReadBudget } from "../request-budget.js";
import type { ValuedAmount } from "../../components/Figure.js";

/**
 * `/api/v1/watchlist/*` — the five routes of
 * the watchlist (FR-338–FR-342,
 * FR-355, FR-361, FR-363, FR-363a, FR-364, FR-375).
 *
 * The wire types below mirror `api/src/watchlist/watchlist.schema.ts`
 * field-for-field **by hand**, the convention `dividends.ts`/`fx.ts` document
 * (`web` has no build-time dependency on `api`), with the two rules that are
 * silent when broken restated here:
 *
 *  - **Every decimal is a `string`** (NFR-12/AC53).
 *  - **"Unavailable" is an absent key, never `null` and never `0`** (decision
 *    W-10, AC-331): every member of
 *    {@link WatchlistMetrics} is optional, `periodReturns` is a *partial*
 *    record over the window ids, and `currentPrice`/`dayChange`/
 *    `dayChangePercent` are absent — not null — when the row has none. The
 *    two deliberate exceptions are `targetPrice` and `note`, which are
 *    `string | null` on the wire because `PATCH` needs "clear this field"
 *    (`null`) to be distinguishable from "leave it alone" (absent).
 *
 * ## The two reads are wrapped in their budget, and that is the point
 *
 * `request-budget.ts:155-162` records the regression this guards against:
 * `fetchOverview`/`fetchHoldings` called `apiFetch` directly for as long as
 * `valuationReadBudget` existed, so the bound it claimed was false for the two
 * routes the busiest screens actually read. "A valuation read whose client
 * wrapper skips `valuationReadBudget.run` defeats this bound silently — the
 * thing to check is the wrapper, not the bound." So:
 *
 *  - {@link fetchWatchlist} → `valuationReadBudget.run("foreground", …)`, a
 *    valuation read;
 *  - {@link fetchWatchedInstrumentIds} → `cheapReadBudget.run(…)`, one indexed
 *    `SELECT instrument_id`.
 *
 * **Never the other way around** (NFR-35): the two budgets are sized for
 * different cost classes, and `watchlist.test.ts` asserts each wrapper by
 * stubbing the budget's own `run` rather than by observing the fetch.
 *
 * The three writes use **neither** budget — there is no write budget, exactly
 * as every other mutation wrapper in this directory.
 */

/** FR-350's trailing range. `distanceFromHigh` is a **unitless signed fraction** (−0.12 for "12 % below the high"); `high`/`low` are prices in the row's `listingCurrency`. */
export interface WatchlistFiftyTwoWeek {
  readonly high: string;
  readonly low: string;
  readonly highDate: string;
  readonly lowDate: string;
  readonly distanceFromHigh: string;
}

/** FR-351. `fraction` is a non-positive unitless fraction; recovery is never required, so `troughDate` may be the series' last point. */
export interface WatchlistMaxDrawdown {
  readonly fraction: string;
  readonly peakDate: string;
  readonly troughDate: string;
}

/**
 * FR-349–FR-353's figures. Every field is optional and **absent when
 * unavailable** — see this module's header.
 *
 * `unusableSeries` is the one always-present flag: `true` means a non-positive
 * close made every ratio meaningless, which is a different fact from "the
 * series is too short", and the screen says so differently.
 */
export interface WatchlistMetrics {
  readonly unusableSeries: boolean;
  /** Keyed by window id (`1W`…`5Y`); an unavailable window has **no key at all**. Read through `at()`-style optional access, never `?? "0"`. */
  readonly periodReturns: Readonly<Record<string, string | undefined>>;
  readonly fiftyTwoWeek?: WatchlistFiftyTwoWeek;
  readonly maxDrawdown?: WatchlistMaxDrawdown;
  /** Non-negative unitless fraction (FR-352). */
  readonly annualisedVolatility?: string;
  readonly sma50?: string;
  readonly sma200?: string;
  readonly priceVsSma50?: string;
  readonly priceVsSma200?: string;
}

/** One decimated series point (W-9) — **display data only**, never the input to any figure. */
export interface WatchlistSeriesPoint {
  readonly date: string;
  readonly close: string;
}

/**
 * One watched instrument as `GET /watchlist` returns it.
 *
 * **`exchangeMic` is deliberately not on the wire**, exactly as it is not on
 * `HoldingResponse`: it is the input to `listingCountry`'s server-side
 * derivation, not a field of the response.
 *
 * There is **no position block here** (FR-354, W-5): the screen joins this row
 * against the `GET /portfolios/holdings` response it already fetches, so those
 * figures are the holdings response's own bytes rather than a second mapper
 * kept in step by hand.
 */
export interface WatchlistRow {
  readonly instrumentId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly hasIcon: boolean;
  readonly status: string;
  /** Every price figure on this row is denominated in this currency — never the tenant's base (this response converts nothing). */
  readonly listingCurrency: string;
  readonly listingCountry: string | null;
  readonly sectorCode: string | null;
  readonly industryLabel: string | null;
  readonly domicileCountry: string | null;
  readonly watchedSince: string;
  /** `null` = not set — nullable rather than absent, see this module's header. */
  readonly targetPrice: string | null;
  readonly note: string | null;
  /** The existing `ValuedAmount` envelope, so `<Figure>` renders it with FR-344's freshness signal and no new component. **Absent** when no price of any origin exists (FR-346). */
  readonly currentPrice?: ValuedAmount;
  /** The **per-unit** move in {@link listingCurrency} — a watchlist row has no position, so this is not a monetary delta (FR-348). Absent when there is no previous observation. */
  readonly dayChange?: string;
  readonly dayChangePercent?: string;
  readonly metrics: WatchlistMetrics;
  readonly series: readonly WatchlistSeriesPoint[];
}

/** The window `GET /watchlist` resolved server-side and echoes back — the preset asked for, plus the concrete `[from, to]` the metrics were computed over. */
export interface WatchlistWindowResponse {
  readonly preset: string;
  readonly from: string;
  readonly to: string;
}

/**
 * `GET /watchlist`'s `200` body.
 *
 * **No `calcEpoch`** (DV10's position): this read materialises
 * nothing — it reads `instrument_price_daily`/`manual_price_point` directly —
 * so there is no staleness window for an epoch to describe, and
 * `queries/watchlist.ts` invalidates `["watchlist"]` plainly rather than
 * through `invalidateAndVerifyCalcEpoch`.
 */
export interface WatchlistResponse {
  readonly asOfDate: string;
  readonly window: WatchlistWindowResponse;
  readonly rows: readonly WatchlistRow[];
}

/**
 * `POST /watchlist` and `PATCH /watchlist/:instrumentId`'s body — the stored
 * `watchlist_item` row, and **deliberately not** a {@link WatchlistRow}.
 *
 * One type for both directions was the original plan; the server's own
 * deviation (recorded in `watchlist.schema.ts`'s
 * `WatchlistItemResponse` doc comment, T-69) settles it the other way, and
 * this mirror follows the server: shipping the *valued* row from a write would
 * mean running the whole watchlist read — three statements, and at the 200-row
 * cap the entire tenant's price window — to produce figures the client
 * immediately discards, because every mutation invalidates the bare
 * `["watchlist"]` prefix and the refetch that follows is what populates the
 * screen. A mutation here is an **acknowledgement of the fact it wrote**.
 */
export interface WatchlistItemResponse {
  readonly instrumentId: string;
  readonly targetPrice: string | null;
  readonly note: string | null;
  readonly watchedSince: string;
}

/** `GET /watchlist/ids` (FR-363a) — ordered by `instrumentId` server-side, so a client that diffs it sees a stable list. */
export interface WatchedInstrumentIdsResponse {
  readonly instrumentIds: readonly string[];
}

/**
 * `GET /api/v1/watchlist?window=` (FR-355/FR-361/FR-363) — every watched
 * instrument with its price, freshness, day change, metrics and decimated
 * series, from **one** request whose statement count does not scale with the
 * number of rows.
 *
 * Inside {@link valuationReadBudget} at `foreground` priority — see this
 * module's header for why that wrap is the mechanism and not decoration.
 * `window` is a preset id, resolved to `[from, to]` server-side so the window
 * the metrics were computed over and the window the response echoes cannot
 * disagree.
 */
export function fetchWatchlist(window: string, signal?: AbortSignal): Promise<WatchlistResponse> {
  return valuationReadBudget.run("foreground", signal, () =>
    apiFetch<WatchlistResponse>(
      `/watchlist?window=${encodeURIComponent(window)}`,
      undefined,
      signal,
    ),
  );
}

/**
 * `GET /api/v1/watchlist/ids` (FR-363a) — which instruments this tenant
 * watches, nothing else: what `<WatchToggle>` on the instrument screens
 * resolves its state from (W-6), which is why it is a cheap read and not a
 * slice of the response above.
 *
 * Inside {@link cheapReadBudget}, at `foreground` priority: the toggles on a
 * screen cannot render an honest label until this resolves, so it is not
 * background work — and the bound of 4 is what keeps this tab below the
 * server's cheap-read concurrency cap however many screens mount it.
 */
export function fetchWatchedInstrumentIds(
  signal?: AbortSignal,
): Promise<WatchedInstrumentIdsResponse> {
  return cheapReadBudget.run("foreground", signal, () =>
    apiFetch<WatchedInstrumentIdsResponse>("/watchlist/ids", undefined, signal),
  );
}

/**
 * `POST /watchlist`'s body (FR-338/FR-341). Both optional fields follow the
 * three-way rule the server documents: absent leaves whatever is stored alone
 * (which is what makes a bare re-watch a no-op instead of wiping the note the
 * first watch carried), `null` clears, a value sets. `JSON.stringify` drops
 * `undefined` properties, so an unset field genuinely never reaches the wire.
 */
export interface CreateWatchlistItemInput {
  readonly instrumentId: string;
  readonly targetPrice?: string | null;
  readonly note?: string | null;
}

/**
 * `POST /api/v1/watchlist` — watch an instrument, or update the row that is
 * already there.
 *
 * **200 on every call**, first add and repeat alike (the server's own
 * idempotent-upsert contract, FR-375): a wrong-direction click is harmless.
 * A tenant already at `MAX_WATCHLIST_ITEMS_PER_TENANT` watching a genuinely
 * new instrument is refused `429 WATCHLIST_TENANT_CAP_EXCEEDED`, and an
 * unknown id `404 INSTRUMENT_NOT_FOUND` — both ordinary `ApiError`s here,
 * rendered through `problem-messages.ts` by the caller.
 */
export function postWatchlistItem(input: CreateWatchlistItemInput): Promise<WatchlistItemResponse> {
  return apiFetch<WatchlistItemResponse>("/watchlist", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * `PATCH /watchlist/:instrumentId`'s body (FR-341) — the target price and the
 * note, **at least one of them**: an empty body is a `400` server-side, not a
 * no-op `UPDATE`. `null` clears, an absent key leaves the stored value alone.
 */
export interface UpdateWatchlistItemInput {
  readonly instrumentId: string;
  readonly targetPrice?: string | null;
  readonly note?: string | null;
}

/**
 * `PATCH /api/v1/watchlist/:instrumentId` (FR-341) — edit the target price or
 * the note **without un-watching**. `404 WATCHLIST_ITEM_NOT_FOUND` when the
 * instrument is not watched: a `PATCH` is not a create.
 *
 * The tenant cap is never consulted on this path (it adds no row), so a tenant
 * at the cap can still correct a target price.
 */
export function patchWatchlistItem(
  input: UpdateWatchlistItemInput,
): Promise<WatchlistItemResponse> {
  const { instrumentId, ...patch } = input;
  return apiFetch<WatchlistItemResponse>(`/watchlist/${instrumentId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * `DELETE /api/v1/watchlist/:instrumentId` (FR-340/FR-374/FR-375) — un-watch.
 *
 * **204 whether or not a row existed, and never 404** (the server's own
 * contract): two tabs or a double-click would otherwise make the second
 * attempt an error for having succeeded. `apiFetch` already maps a `204` to
 * `undefined`, so nothing extra is needed here.
 */
export function deleteWatchlistItem(instrumentId: string): Promise<void> {
  return apiFetch<void>(`/watchlist/${instrumentId}`, { method: "DELETE" });
}
