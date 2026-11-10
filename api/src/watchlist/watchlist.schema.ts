import { z } from "zod";
import { zDecimal } from "@kerdial/api-contracts";
// Imported as a **type**, and load-bearing for the *declaration* emit rather
// than for this file's own types: `zDecimal` is a `z.string().transform(…)`
// whose output is a `Decimal`, so the two request schemas below infer a type
// mentioning it. Without a local alias in scope, `tsc --declaration` writes
// `import("decimal.js").Decimal` into `api/dist/watchlist/watchlist.schema.d.ts`
// — a module `api` does not depend on, which `pnpm depcruise`'s
// `no-unresolvable` rule flags on the emitted file (MEASURED at T-69, and the
// only violation this cycle produced). `instruments.schema.ts` carries the same
// import for the same reason.
import type { Decimal } from "@kerdial/core-decimal";
import {
  WATCHLIST_NOTE_MAX_LENGTH,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
  type WatchlistItemRecord,
} from "@kerdial/ledger";
import {
  WATCHLIST_WINDOW_PRESETS,
  type ValuedWatchlist,
  type ValuedWatchlistRow,
} from "@kerdial/valuation";
import { serializeDecimal } from "../common/decimal.schema.js";
import {
  toValuedAmountResponse,
  type ValuedAmountResponse,
} from "../common/valued-amount.schema.js";

/**
 * Zod DTOs for `/watchlist/*`
 * (T-69); FR-338–FR-341, FR-346–FR-353, FR-364, FR-375.
 *
 * Request schemas validate `unknown` input through `parseOrThrow`;
 * responses are typed by plain interfaces (their Zod schemas went with the
 * OpenAPI descriptors) — the controller builds its bodies from
 * `valuation`/`ledger` values through the mappers below, never by running one
 * back through a Zod `.parse()`, exactly like `dividends.schema.ts` and
 * `portfolios.schema.ts`.
 *
 * ## "Unavailable" is an **absent key**, and this file is where that survives
 *
 * Decision W-10. Every metric is `.optional()`, **never**
 * `.nullable()`, and every optional field below is produced by a *conditional
 * spread* rather than by assigning `undefined` or `null` — so `JSON.stringify`
 * drops the key outright and no client's `Number(x ?? 0)` can turn a figure
 * that does not exist into a fabricated zero (AC-331). {@link
 * toPeriodReturnsResponse} is the sharpest case: `periodReturns` arrives as a
 * `Record` of all eight windows whose unavailable values are `undefined`, and
 * it is rebuilt here by **copying only the defined entries** — mapping the
 * eight window keys unconditionally would put eight `null`s on the wire and
 * lose exactly the distinction AC-331 is about.
 *
 * `targetPrice` and `note` are the two deliberate exceptions: they are
 * `.nullable()` on the wire, because `PATCH` needs to distinguish "clear this
 * field" (`null`) from "leave it alone" (absent) — the three-nullable-field
 * idiom `PATCH /instruments/:id/classification` already uses.
 *
 * **Every decimal crosses as a string** (NFR-12/AC53),
 * through `serializeDecimal`/`toValuedAmountResponse` and nowhere else.
 */

/* ========================================================================= *
 * Requests
 * ========================================================================= */

/**
 * `GET /watchlist?window=` — the preset set, validated against
 * `valuation`'s own {@link WATCHLIST_WINDOW_PRESETS} rather than a re-typed
 * copy of it, with `1Y` as the default the screen opens on.
 *
 * `resolveReturnWindow` (`portfolios.schema.ts`) is deliberately **not**
 * reused, and there is nothing to reuse: it validates an explicit
 * `?from=&to=` pair against `RETURN_WINDOW_EPOCH_FLOOR`/
 * `RETURN_WINDOW_MAX_SPAN_YEARS`, and this route takes no dates at all. A
 * preset is resolved to `[from, to]` **server-side**, inside
 * `valueWatchlistForTenant`, so the window the metrics were computed over and
 * the window the response echoes cannot disagree.
 */
export const watchlistQuerySchema = z.object({
  window: z.enum(WATCHLIST_WINDOW_PRESETS).default("1Y"),
});

/**
 * FR-341's optional target price: a positive decimal **string** (never a JSON
 * number), rejected here as a `400` rather than reaching
 * `watchlist-service.ts`'s own `assertStorableFields`, whose `RangeError`
 * would surface as a 500 on user-supplied input.
 *
 * **The scale bound is the second half of the same argument** (WL-1),
 * and it is not implied by the positive one: `watchlist_item.target_price`
 * is `numeric(38, 18)`, so a 19-dp value like `"0.0000000000000000001"` is
 * positive *as parsed* and rounds to `0` *as stored* — the CHECK's raw `23514`
 * became a 500 on user-supplied input, and a non-zero 19-dp value was stored
 * truncated. Bounded against `ledger`'s own constant (which names the column's
 * declared scale), the way the note field below is bounded against its CHECK's
 * constant, rather than a re-typed 18 here. `createManualPriceBodySchema`'s N9
 * refinement is the precedent, on the same column type.
 */
const watchlistTargetPriceSchema = zDecimal
  .refine((value: Decimal) => value.isFinite() && value.greaterThan(0), {
    message: "targetPrice must be a positive decimal — a non-positive target is not a target",
  })
  .refine((value: Decimal) => value.decimalPlaces() <= WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES, {
    message: `targetPrice must not have more than ${WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES} fractional digits`,
  });

/** FR-341's note, bounded by `ledger`'s own constant (which mirrors the table's `watchlist_item_note_length` CHECK) so the refusal is a 400 and never a raw `23514`. */
const watchlistNoteSchema = z.string().max(WATCHLIST_NOTE_MAX_LENGTH);

/**
 * `POST /watchlist`. `z.strictObject`, for
 * `updateInstrumentClassificationBodySchema`'s stated reason: these three are
 * the only fields this route accepts, and a body carrying anything else is
 * refused rather than silently stripped.
 *
 * Both optional fields follow the three-way rule
 * `WatchlistItemFields` documents: absent leaves whatever is stored alone
 * (which is what makes a bare re-watch a no-op instead of wiping the note the
 * first watch carried), `null` clears, a value sets.
 */
export const createWatchlistItemBodySchema = z.strictObject({
  instrumentId: z.uuid(),
  targetPrice: watchlistTargetPriceSchema.nullable().optional(),
  note: watchlistNoteSchema.nullable().optional(),
});

/**
 * `PATCH /watchlist/:instrumentId` — the same two fields, and **at least one
 * of them**: an empty body is a 400, not a no-op `UPDATE` that would still
 * bump `updated_at` and consume a write slot (the classification patch's own
 * rule).
 */
export const updateWatchlistItemBodySchema = z
  .strictObject({
    targetPrice: watchlistTargetPriceSchema.nullable().optional(),
    note: watchlistNoteSchema.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.targetPrice === undefined && data.note === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "at least one of targetPrice or note is required (null clears a value; an absent key leaves it unchanged)",
      });
    }
  });

/* ========================================================================= *
 * Responses
 * ========================================================================= */

/** FR-350's trailing range. `distanceFromHigh` is a **unitless signed fraction**; `high`/`low` are listing-currency prices (the denomination table). */
export interface FiftyTwoWeekResponse {
  readonly high: string;
  readonly low: string;
  readonly highDate: string;
  readonly lowDate: string;
  readonly distanceFromHigh: string;
}

/** FR-351. `fraction` is a non-positive unitless fraction (−0.25 for a 25 % decline); recovery is never required, so `troughDate` may be the series' last point. */
export interface MaxDrawdownResponse {
  readonly fraction: string;
  readonly peakDate: string;
  readonly troughDate: string;
}

/**
 * FR-349–FR-353's figures. Every field is optional and **absent when
 * unavailable** — see this file's header.
 *
 * `unusableSeries` is the one always-present flag: `true` means a
 * non-positive close made every ratio meaningless (the guard), which is a
 * different fact from "the series is too short", and the client says so
 * differently.
 */
export interface WatchlistMetricsResponse {
  readonly unusableSeries: boolean;
  /** Keyed by window (`1W`…`5Y`); an unavailable window has **no key at all**. Never `null`, never `0`. */
  readonly periodReturns: Readonly<Record<string, string>>;
  readonly fiftyTwoWeek?: FiftyTwoWeekResponse;
  readonly maxDrawdown?: MaxDrawdownResponse;
  /** Non-negative unitless fraction (FR-352). */
  readonly annualisedVolatility?: string;
  readonly sma50?: string;
  readonly sma200?: string;
  readonly priceVsSma50?: string;
  readonly priceVsSma200?: string;
}

/**
 * One watched instrument as `GET /watchlist` returns it.
 *
 * **`exchangeMic` is deliberately not on the wire**, exactly as it is not on
 * `HoldingResponse`: it is the input to `listingCountry`'s derivation, not a
 * field of the response (`holdings-valuation.ts:605-609`'s rule).
 */
export interface WatchlistRowResponse {
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
  /** `null` = not set. Nullable rather than absent — see this file's header. */
  readonly targetPrice: string | null;
  readonly note: string | null;
  /** The existing `ValuedAmount` envelope, so `<Figure>` renders it with no new component and FR-344's freshness signal is the existing one. **Absent** when no price of any origin exists (FR-346). */
  readonly currentPrice?: ValuedAmountResponse;
  /** The **per-unit** move in {@link listingCurrency} — a watchlist row has no position, so this is not a monetary delta (FR-348). Absent when there is no previous observation. */
  readonly dayChange?: string;
  readonly dayChangePercent?: string;
  readonly metrics: WatchlistMetricsResponse;
  /** Decimated, display-only (W-9) — never the input to any figure. */
  readonly series: readonly { readonly date: string; readonly close: string }[];
}

/** `GET /watchlist`'s body. **No `calcEpoch`** (DV10's position): this read materialises nothing, so `["watchlist"]` is invalidated plainly. */
export interface WatchlistResponse {
  readonly asOfDate: string;
  readonly window: { readonly preset: string; readonly from: string; readonly to: string };
  readonly rows: readonly WatchlistRowResponse[];
}

/**
 * `POST /watchlist` and `PATCH /watchlist/:instrumentId`'s body — the stored
 * `watchlist_item` row, and **deliberately not** a
 * {@link WatchlistRowResponse}.
 *
 * One type serves both directions. Shipping the valued row
 * here would mean running the watchlist read again on a write path — three
 * statements, and at the 200-row cap the *whole* tenant's price window — to
 * produce figures the client immediately discards: every mutation
 * invalidate the bare `["watchlist"]` prefix, so the refetch that follows is
 * what actually populates the screen. The mutation therefore answers with the
 * fact it just wrote (`targetPrice`, `note`, `watchedSince`), which is also
 * everything an optimistic update needs.
 */
export interface WatchlistItemResponse {
  readonly instrumentId: string;
  readonly targetPrice: string | null;
  readonly note: string | null;
  readonly watchedSince: string;
}

/** `GET /watchlist/ids` (FR-363a) — the cheap read the instrument-screen toggles resolve their state from, ordered by `instrumentId` so a client that diffs it sees a stable list. */
export interface WatchedInstrumentIdsResponse {
  readonly instrumentIds: readonly string[];
}

/* ========================================================================= *
 * Mappers — the one place these figures become strings
 * ========================================================================= */

/** `created_at`'s date, in UTC — the wire's `watchedSince`. */
function watchedSinceOf(createdAt: Date): string {
  return createdAt.toISOString().slice(0, 10);
}

/** `ledger`'s stored row -> the mutation response. */
export function toWatchlistItemResponse(record: WatchlistItemRecord): WatchlistItemResponse {
  return {
    instrumentId: record.instrumentId,
    targetPrice: record.targetPrice === null ? null : serializeDecimal(record.targetPrice),
    note: record.note,
    watchedSince: watchedSinceOf(record.createdAt),
  };
}

/**
 * Copies **only the windows that have a value**. See this file's header: this
 * is the one mapper that could silently destroy W-10's encoding by writing a
 * key per window, and it is written as a copy of the defined entries rather
 * than as a mapping over the window list precisely so it cannot.
 */
function toPeriodReturnsResponse(
  periodReturns: ValuedWatchlistRow["metrics"]["periodReturns"],
): Record<string, string> {
  const response: Record<string, string> = {};
  for (const [window, value] of Object.entries(periodReturns)) {
    if (value !== undefined) response[window] = serializeDecimal(value);
  }
  return response;
}

function toMetricsResponse(metrics: ValuedWatchlistRow["metrics"]): WatchlistMetricsResponse {
  const { fiftyTwoWeek, maxDrawdown } = metrics;
  return {
    unusableSeries: metrics.unusableSeries,
    periodReturns: toPeriodReturnsResponse(metrics.periodReturns),
    ...(fiftyTwoWeek !== undefined
      ? {
          fiftyTwoWeek: {
            high: serializeDecimal(fiftyTwoWeek.high),
            low: serializeDecimal(fiftyTwoWeek.low),
            highDate: fiftyTwoWeek.highDate,
            lowDate: fiftyTwoWeek.lowDate,
            distanceFromHigh: serializeDecimal(fiftyTwoWeek.distanceFromHigh),
          },
        }
      : {}),
    ...(maxDrawdown !== undefined
      ? {
          maxDrawdown: {
            fraction: serializeDecimal(maxDrawdown.fraction),
            peakDate: maxDrawdown.peakDate,
            troughDate: maxDrawdown.troughDate,
          },
        }
      : {}),
    ...(metrics.annualisedVolatility !== undefined
      ? { annualisedVolatility: serializeDecimal(metrics.annualisedVolatility) }
      : {}),
    ...(metrics.sma50 !== undefined ? { sma50: serializeDecimal(metrics.sma50) } : {}),
    ...(metrics.sma200 !== undefined ? { sma200: serializeDecimal(metrics.sma200) } : {}),
    ...(metrics.priceVsSma50 !== undefined
      ? { priceVsSma50: serializeDecimal(metrics.priceVsSma50) }
      : {}),
    ...(metrics.priceVsSma200 !== undefined
      ? { priceVsSma200: serializeDecimal(metrics.priceVsSma200) }
      : {}),
  };
}

export function toWatchlistRowResponse(row: ValuedWatchlistRow): WatchlistRowResponse {
  return {
    instrumentId: row.instrumentId,
    kind: row.kind,
    displayName: row.displayName,
    hasIcon: row.hasIcon,
    status: row.status,
    listingCurrency: row.listingCurrency,
    listingCountry: row.listingCountry,
    sectorCode: row.sectorCode,
    industryLabel: row.industryLabel,
    domicileCountry: row.domicileCountry,
    watchedSince: row.watchedSince,
    targetPrice: row.targetPrice === undefined ? null : serializeDecimal(row.targetPrice),
    note: row.note ?? null,
    ...(row.currentPrice !== undefined
      ? { currentPrice: toValuedAmountResponse(row.currentPrice) }
      : {}),
    ...(row.dayChange !== undefined ? { dayChange: serializeDecimal(row.dayChange) } : {}),
    ...(row.dayChangePercent !== undefined
      ? { dayChangePercent: serializeDecimal(row.dayChangePercent) }
      : {}),
    metrics: toMetricsResponse(row.metrics),
    series: row.series.map((point) => ({
      date: point.date,
      close: serializeDecimal(point.close),
    })),
  };
}

/** `valuation`'s view -> `GET /watchlist`'s body. The row order is the engine's own and is never re-sorted here. */
export function toWatchlistResponse(view: ValuedWatchlist): WatchlistResponse {
  return {
    asOfDate: view.asOfDate,
    window: { preset: view.window.preset, from: view.window.from, to: view.window.to },
    rows: view.rows.map(toWatchlistRowResponse),
  };
}
