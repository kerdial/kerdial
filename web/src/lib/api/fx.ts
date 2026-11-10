import { apiFetch } from "./core.js";

/**
 * `/api/v1/market-data/fx*` — the Devises screen's four calls.
 *
 * The wire types below mirror `api/src/market-data/fx.schema.ts`
 * field-for-field, the same by-hand mirroring convention every sibling module
 * here uses (`instruments.ts`, `portfolios.ts`). Two things that mirroring must
 * preserve, because getting either wrong is silent:
 *
 *  - **`latestRate` is a `string`.** A decimal never crosses this boundary as a
 *    number. Typing it `number` here would compile, and
 *    then quietly round a rate at four decimal places on its way through
 *    `JSON.parse`.
 *  - **The coverage fields are optional, and absence means "never fetched".**
 *    Not `| null`, and never defaulted to `0`/an epoch date at this layer: the
 *    screen renders an em dash from the absence, and a default here would be
 *    the fabricated figure this whole screen exists to avoid.
 */

/** One row of the Devises table. */
export interface FxPairStatus {
  readonly base: string;
  readonly quote: string;
  /** This tenant holds something in `quote`, so the pair is fetched whether or not it is tracked. */
  readonly held: boolean;
  /** An `fx_tracked_pair` row exists — deployment-wide, not per tenant. */
  readonly tracked: boolean;
  /** The FX provider still publishes this pair. A tracked pair can lose this (EUR/RUB, suspended 2022) and is then skipped by the daily job. */
  readonly supported: boolean;
  /** Decimal string in `fx_rate_daily`'s canonical direction: `amount_base = amount_native × rate`. */
  readonly latestRate?: string;
  readonly latestRateDate?: string;
  readonly latestSourceKey?: string;
  readonly firstRateDate?: string;
  readonly points: number;
}

export interface FxCurrencyPair {
  readonly base: string;
  readonly quote: string;
}

export interface FxOverview {
  readonly provider: { readonly key: string; readonly baseCurrency: string };
  /** `false` when this deployment has no ingestion queue — the refresh button is disabled from this, rather than discovering the 503 by pressing it. */
  readonly ingestionConfigured: boolean;
  readonly pairs: readonly FxPairStatus[];
  /** Every pair the provider publishes — the picker's options, so it cannot offer one the server would reject. */
  readonly supportedPairs: readonly FxCurrencyPair[];
}

/**
 * `GET /market-data/fx`.
 *
 * **No read budget.** `cheapReadBudget`/`valuationReadBudget` exist to bound a
 * *fan-out* — several concurrent per-row reads from one screen. This screen
 * issues exactly one read on mount and one after each write, so there is
 * nothing to schedule; the server's shared cheap-read cap is what bounds it.
 * (`imports.ts` documents the same reasoning for its own one-shot calls.)
 */
export function fetchFxOverview(signal?: AbortSignal): Promise<FxOverview> {
  return apiFetch<FxOverview>("/market-data/fx", undefined, signal);
}

export interface TrackFxPairResult extends FxCurrencyPair {
  /** `false` when the pair was already tracked — the request's intent is satisfied either way, and the server answers `201` for both. */
  readonly created: boolean;
}

/** `POST /market-data/fx/pairs`. A pair the provider does not publish is a `400 FX_PAIR_NOT_SUPPORTED`, never a stored row the daily job would skip forever. */
export function trackFxPair(pair: FxCurrencyPair): Promise<TrackFxPairResult> {
  return apiFetch<TrackFxPairResult>("/market-data/fx/pairs", {
    method: "POST",
    body: JSON.stringify(pair),
  });
}

/**
 * `DELETE /market-data/fx/pairs/:base/:quote`.
 *
 * The codes are `encodeURIComponent`'d even though a validated ISO 4217 code
 * cannot contain a path separator: the guarantee belongs at the point the URL
 * is built, not to whatever validated the value three layers up.
 */
export function untrackFxPair(pair: FxCurrencyPair): Promise<void> {
  return apiFetch<void>(
    `/market-data/fx/pairs/${encodeURIComponent(pair.base)}/${encodeURIComponent(pair.quote)}`,
    { method: "DELETE" },
  );
}

export interface FxRefreshResult {
  /** How many pairs the enqueued run will cover — the server's own resolution, not an estimate. */
  readonly pairs: number;
  /** `false` when pg-boss collapsed the request into a run already queued or active. Pressing twice is not two runs, and the screen says so. */
  readonly enqueued: boolean;
  readonly jobId?: string;
}

/** `POST /market-data/fx/refresh` — `202`; nothing is fetched by the time this resolves. `503 MARKET_DATA_NOT_CONFIGURED` when the deployment has no ingestion queue. */
export function refreshFxRates(): Promise<FxRefreshResult> {
  return apiFetch<FxRefreshResult>("/market-data/fx/refresh", { method: "POST" });
}
