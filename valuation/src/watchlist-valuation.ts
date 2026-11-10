import type { Decimal } from "@kerdial/core-decimal";
import {
  computeInstrumentMetrics,
  decimateCloseSeries,
  resolvePrice,
  type ClosePoint,
  type CurrencyCode,
  type InstrumentMetrics,
  type IsoDate,
  type PeriodReturnWindow,
  type PricePoint,
} from "@kerdial/core-domain";
// The one-application-point rule (`instrument-create-ux` DD10, restated by
// `holdings-valuation.ts:619-629`): a MIC becomes a listing country here and
// nowhere else on this path.
import { micToCountryCode } from "@kerdial/core-reference-data";
import type { InstrumentKind, InstrumentSectorCode } from "@kerdial/ledger";
import {
  instrument,
  instrumentIcon,
  instrumentPriceDaily,
  manualPricePoint,
  watchlistItem,
  withTenant,
  type Db,
  type Tx,
} from "@kerdial/platform-db";
import { and, between, eq, inArray, sql } from "drizzle-orm";
import {
  buildPriceFlags,
  dayBefore,
  finalize,
  type FigureProvenance,
  type PriceFlagResult,
  type ValuedFigure,
} from "./holdings-valuation.js";
import { priceProvenanceKey, type DailyPriceQuality } from "./pricing-series.js";

/**
 * `valueWatchlistForTenant` — `watchlist` (T-68); FR-344, FR-346–FR-348, FR-355, FR-361, FR-362, FR-365, FR-377,
 * NFR-37, NFR-39. Backs `GET /watchlist`: the instruments a tenant follows,
 * each with its last price, its freshness, its day change and the
 * `computeInstrumentMetrics` figures, over one bounded price load.
 *
 * ## A sibling of `holdings-valuation.ts`, never an addition to it (W-1)
 *
 * That module is about valuing *open positions* against *live* prices, and it
 * has one property this path must categorically not inherit: it calls
 * `valuePortfolio`, which throws `UnresolvablePriceError` for an instrument
 * with no price on or before the date (`core/domain/valuation.ts:197-211`).
 * FR-346 requires a watched instrument with **zero price rows of any origin**
 * to *render* — every metric absent, the row present — not to 422 the screen.
 * So nothing here calls `valuePortfolio`, `resolvePrice` returning `undefined`
 * is a normal outcome, and this module cannot raise
 * `UnresolvablePriceError`/`UnresolvableRateError` at all. That is
 * closed-positions' CP-1 argument applied to a second read path: a
 * function that must not price anything does not belong inside the module
 * whose entire subject is pricing.
 *
 * The split's cost is **three** package-internal exports of
 * `holdings-valuation.ts` ({@link buildPriceFlags}, {@link PriceFlagResult},
 * {@link dayBefore}), none of them on `valuation/src/index.ts`.
 *
 * **A fourth, `daysBetween`, was planned and it is deliberately not
 * widened — assumption A1 is only half true (MEASURED at T-68/T-69).** A1
 * states the unused-exports gate "scans package barrels, not intra-package
 * exports", closed by closed-positions' precedent. What that precedent actually
 * shows is narrower: an intra-package export **with an intra-package importer**
 * is invisible to the gate. Widening `daysBetween`, which nothing here imports
 * (it is `buildPriceFlags`' own helper and stays module-private), made
 * `pnpm unused-exports-gate` report `daysBetween function
 * valuation/src/holdings-valuation.ts:422` and exit 1. So the rule is "an
 * export needs an importer, wherever it lives", and the widening list is the
 * three symbols this module genuinely uses.
 *
 * **Reused verbatim** is
 * the point of `buildPriceFlags`: it carries `STALE_AFTER_DAYS = 3` and
 * `MANUAL_STALE_AFTER_DAYS = 400`, and declaring a second staleness horizon
 * here would give the product two answers to "is this price stale", which is
 * exactly what FR-344's "the same signal the rest of the app already computes"
 * forbids.
 *
 * ## Its own loader, and why not `loadPricingSeries` (W-2)
 *
 * `loadPricingSeries` loads every `instrument_price_daily`/`manual_price_point`
 * row **unbounded below** (deliberately — `pricing-series.ts:78-81`: the
 * holdings caller's LOCF needs the most recent observation *before* its
 * `fromDate`), plus FX rows and a two-sided provider-coverage test this path
 * has no use for. Adding a real lower bound there would change the LOCF anchor
 * of the holdings read, i.e. a behavioural edit to a security-reviewed function
 * under FR-382's non-regression guarantee. So this module issues its own two
 * narrow, window-bounded queries and `pricing-series.ts` is **not opened**
 * (only its provenance-key helper and quality type are imported).
 *
 * ## Three statements, independent of N (FR-361/FR-362)
 *
 * One `watchlist_item`/`instrument`/`instrument_icon` join, one
 * `instrument_price_daily` range read, one `manual_price_point` range read —
 * all three inside **one** `withTenant` transaction which closes before any
 * CPU work runs (H2(c)'s split, `holdings-valuation.ts:677-699`). No
 * `tenant.base_currency` read (nothing converts — every figure is in the
 * instrument's listing currency), no `portfolio.calc_epoch` read
 * (this read touches no lazily-materialised state), no
 * `instrument_quote_latest` read.
 *
 * ## No `calcEpoch`, deliberately
 *
 * Nothing here is materialised on read: not `portfolio_daily_valuation`, not
 * `holding_state`, not `realized_gain`. This is `GET /dividends/summary`'s
 * DV10 position for the same structural reason, and it has one consequence the
 * client must honour: `["watchlist"]` is invalidated **plainly**, never through
 * `invalidateAndVerifyCalcEpoch`, whose verify half could only no-op forever.
 */

/** The longest period return FR-349 asks for, in years — the floor of the price window this module loads. */
const WATCHLIST_SERIES_LOOKBACK_YEARS = 5;

/**
 * Extra days below `asOfDate − 5y`, so the period return's five-year *coverage* test
 * is decidable: that test asks whether a point exists at or before the window
 * start, and a point that far back has to be inside the loaded window to be
 * seen. 400 days covers an annual-NAV FUND's gap.
 *
 * Deliberately **not** a mirror of `holdings-valuation.ts`'s
 * `MANUAL_STALE_AFTER_DAYS` (also 400) and deliberately given **no** drift
 * test: the two answer different questions — "how far back must the series
 * load reach" versus "when does a manual price become stale" — and must be free
 * to move independently.
 */
const WATCHLIST_SERIES_LOOKBACK_MARGIN_DAYS = 400;

/**
 * The decimated wire series' point budget (W-8/W-9) — a sparkline's worth per
 * row, not the loaded series. `decimateCloseSeries` may exceed it by at most 3
 * (its first/last/min/max union, which is what keeps a decimated chart from
 * contradicting the 52-week-high figure printed beside it).
 *
 * @public mirrored in `web/src/lib/api-limits.ts` and asserted against this definition by `web/src/lib/api-limits.drift.test.ts`, a cross-workspace deep import the unused-export gate does not scan.
 */
export const WATCHLIST_SERIES_MAX_POINTS = 120;

/**
 * FR-365/NFR-39 — the read-side row cap. **Equal to `ledger`'s
 * `MAX_WATCHLIST_ITEMS_PER_TENANT` by value, guarded by
 * `watchlist-valuation.drift.test.ts`**, because `valuation` must not import
 * `ledger`'s internals: the same "declared twice by value, guarded by a drift
 * test" convention `FX_PROVIDER_COVERAGE_HORIZON_DAYS` follows against
 * `PROVIDER_LOOKBACK_DAYS` (`pricing-series.ts:103-107`, W-15).
 *
 * It can only fire if the write-side cap was bypassed (a direct `INSERT`, a
 * future importer, or the soft-cap overshoot two concurrent adds at 199 rows
 * can produce), which is precisely what
 * `assertWithinResponseCaps` exists for on the holdings path. Reject, never
 * truncate.
 *
 * @public mirrored in `web/src/lib/api-limits.ts` and asserted against this definition by `web/src/lib/api-limits.drift.test.ts`, a cross-workspace deep import the unused-export gate does not scan.
 */
export const MAX_WATCHLIST_ROWS_PER_VIEW = 200;

/** Thrown by {@link valueWatchlistForTenant} when a tenant's watchlist exceeds {@link MAX_WATCHLIST_ROWS_PER_VIEW}. `api` answers `422 WATCHLIST_RESPONSE_TOO_LARGE` — a refusal, never a truncated array (NFR-39). */
export class TooManyWatchlistRowsError extends Error {
  readonly count: number;
  readonly limit: number;

  constructor(count: number, limit: number = MAX_WATCHLIST_ROWS_PER_VIEW) {
    super(`This view would return ${count} watchlist rows, exceeding the ${limit}-row cap.`);
    this.name = "TooManyWatchlistRowsError";
    this.count = count;
    this.limit = limit;
  }
}

/**
 * The window presets this read offers — `period-presets.ts`'s
 * set **minus `MAX`**, because the price load is bounded at 5 years + 400 days
 * and a `MAX` here would either lie about its span or unbound a 200-row read.
 *
 * `satisfies readonly PeriodReturnWindow[]` is the compile-time link to
 * `core/domain`'s own eight windows: a preset that is not one of them fails to
 * type-check rather than silently producing a window start nothing else agrees
 * with.
 */
export const WATCHLIST_WINDOW_PRESETS = [
  "3M",
  "6M",
  "YTD",
  "1Y",
  "3Y",
  "5Y",
] as const satisfies readonly PeriodReturnWindow[];

/** One of {@link WATCHLIST_WINDOW_PRESETS}. Default `"1Y"`, applied by `api`'s query schema. */
export type WatchlistWindow = (typeof WATCHLIST_WINDOW_PRESETS)[number];

/** The selected window, resolved to concrete dates — echoed on the response so the client never re-derives it. */
export interface ResolvedWatchlistWindow {
  readonly preset: WatchlistWindow;
  /** Inclusive start — drawdown, volatility and the wire series read this and nothing earlier. */
  readonly from: IsoDate;
  /** Inclusive end; always `asOfDate`. */
  readonly to: IsoDate;
}

/**
 * One watched instrument. Every figure is in the instrument's
 * **listing** currency or is a unitless signed fraction — nothing here is
 * converted to the tenant's base, and the API contract states which is which
 * once, so no surface can mislabel a ratio as money.
 *
 * **Deliberately absent**, so neither reads as an oversight: the
 * position-if-held block (quantity/PMP/unrealized/weight — FR-354 is satisfied
 * by the client's join against the `GET /portfolios/holdings` response it
 * already fetches, W-5, because computing it here would run the entire
 * holdings replay on every watchlist read and would couple this response to
 * `UnresolvablePriceError`); and `calcEpoch` (see this module's header).
 */
export interface ValuedWatchlistRow {
  readonly instrumentId: string;
  readonly kind: InstrumentKind;
  readonly displayName: string;
  readonly hasIcon: boolean;
  readonly status: "ACTIVE" | "DELISTED" | "MERGED";
  readonly listingCurrency: CurrencyCode;
  readonly exchangeMic: string | null;
  /** Derived from {@link exchangeMic} through `micToCountryCode` at this one point — never stored, never the ISIN prefix. */
  readonly listingCountry: string | null;
  readonly sectorCode: InstrumentSectorCode | null;
  readonly industryLabel: string | null;
  readonly domicileCountry: string | null;
  /** `watchlist_item.created_at`'s date (FR-338). */
  readonly watchedSince: IsoDate;
  readonly targetPrice?: Decimal;
  readonly note?: string;
  /** The existing `ValuedFigure` envelope, in {@link listingCurrency} — **absent** when no price of any origin exists on or before `asOfDate` (FR-346). */
  readonly currentPrice?: ValuedFigure;
  /**
   * FR-348, and the denomination is *not* what the field name suggests
   * elsewhere: this is the **per-unit move in the listing currency**, i.e.
   * `holdings-valuation.ts:955-984`'s rule minus its `quantity × rate`
   * multiplication. A watchlist row has no position, so multiplying by one
   * notional share would invent one. Absent when there is no previous
   * observation — never a fabricated `0`.
   */
  readonly dayChange?: Decimal;
  /** `dayChange / previous.price` — a unitless signed fraction. Absent under the same condition. */
  readonly dayChangePercent?: Decimal;
  /** T-61's figures over the merged series. `unusableSeries` and `periodReturns` are always present; every other field is absent when unavailable (W-10 — never `null`, never `0`). */
  readonly metrics: InstrumentMetrics;
  /** Decimated to {@link WATCHLIST_SERIES_MAX_POINTS} — **display data only**, never the input to any figure (W-9). */
  readonly series: readonly { readonly date: IsoDate; readonly close: Decimal }[];
}

/** `GET /watchlist`'s pre-JSON body. No `baseCurrency` (nothing converts) and no `calcEpoch` (nothing is materialised on read). */
export interface ValuedWatchlist {
  readonly asOfDate: IsoDate;
  readonly window: ResolvedWatchlistWindow;
  /** `displayName` ascending case-insensitively, `instrumentId` as the tie-break — so two reads of unchanged data are byte-identical. */
  readonly rows: readonly ValuedWatchlistRow[];
}

export interface ValueWatchlistForTenantParams {
  readonly tenantId: string;
  /** Inclusive — nothing after it is read (the never-look-ahead rule). */
  readonly asOfDate: IsoDate;
  /** The selected preset; {@link ResolvedWatchlistWindow} is derived from it and `asOfDate` here, so the response's own echo can never disagree with what was computed. */
  readonly window: WatchlistWindow;
}

/** One `watchlist_item` row joined to its catalogue instrument, exactly as statement 1 reads it. */
interface WatchlistItemRow {
  readonly instrumentId: string;
  readonly targetPrice: Decimal | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly kind: InstrumentKind;
  readonly displayName: string;
  readonly listingCurrency: string;
  readonly exchangeMic: string | null;
  readonly sectorCode: InstrumentSectorCode | null;
  readonly industryLabel: string | null;
  readonly domicileCountry: string | null;
  readonly status: "ACTIVE" | "DELISTED" | "MERGED";
  readonly hasIcon: boolean;
}

/**
 * Everything {@link loadWatchlistInputs}' transaction read, and nothing it
 * computes — H2(c)'s split. Package-internal (never on the barrel): it is the
 * seam {@link assembleWatchlist}'s own unit tests drive, so the pure half is
 * testable without a database.
 */
export interface LoadedWatchlistInputs {
  readonly items: readonly WatchlistItemRow[];
  /** Both origins in one array, the shape `resolvePrice` takes. Bounded by `[fromDate, asOfDate]`. */
  readonly prices: readonly PricePoint[];
  /** Keyed by {@link priceProvenanceKey} — the `quality` column only `instrument_price_daily` carries. */
  readonly priceQualityByKey: ReadonlyMap<string, DailyPriceQuality>;
}

/** `date` minus `days`, UTC, `YYYY-MM-DD` — the `pricing-series.ts:112-116` idiom, duplicated rather than shared for the reason that file's own copy records (each module owns the calendar arithmetic its own bounds need). */
function minusDays(date: IsoDate, days: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10) as IsoDate;
}

function minusMonths(date: IsoDate, months: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  return shifted.toISOString().slice(0, 10) as IsoDate;
}

function minusYears(date: IsoDate, years: number): IsoDate {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
  return shifted.toISOString().slice(0, 10) as IsoDate;
}

/**
 * A preset's inclusive start date, by the **same** plain-UTC calendar
 * arithmetic `instrument-metrics.ts`'s own `periodWindowStart` applies to the
 * identically-named windows (that function is module-private in `core/domain`,
 * so the rule is reproduced here rather than the module's surface widened for
 * one caller). JavaScript's month/year setters roll forward on a short month,
 * which only ever moves the start *later* — the direction W-4 declares safe.
 */
export function resolveWatchlistWindow(
  preset: WatchlistWindow,
  asOfDate: IsoDate,
): ResolvedWatchlistWindow {
  const from = ((): IsoDate => {
    switch (preset) {
      case "3M":
        return minusMonths(asOfDate, 3);
      case "6M":
        return minusMonths(asOfDate, 6);
      case "YTD":
        return `${asOfDate.slice(0, 4)}-01-01` as IsoDate;
      case "1Y":
        return minusYears(asOfDate, 1);
      case "3Y":
        return minusYears(asOfDate, 3);
      case "5Y":
        return minusYears(asOfDate, 5);
    }
  })();
  return { preset, from, to: asOfDate };
}

/**
 * The price window's floor: `asOfDate − WATCHLIST_SERIES_LOOKBACK_YEARS −
 * WATCHLIST_SERIES_LOOKBACK_MARGIN_DAYS`. Independent of the *selected*
 * window, because the 3Y/5Y period returns and the 200-point SMA are computed
 * over the loaded series whatever the screen is showing.
 *
 * Consequence, stated plainly: a `DELISTED` instrument whose last price
 * predates this floor renders with every metric unavailable and a visible
 * freshness gap. FR-377's "whatever price history exists up to the point data
 * stopped" means, under this bound, "whatever exists inside the last ~6.1
 * years" — honestly reported as nothing rather than paid for with an unbounded
 * 200-instrument history load.
 */
export function watchlistSeriesFromDate(asOfDate: IsoDate): IsoDate {
  return minusDays(
    minusYears(asOfDate, WATCHLIST_SERIES_LOOKBACK_YEARS),
    WATCHLIST_SERIES_LOOKBACK_MARGIN_DAYS,
  );
}

/**
 * The DB-reading half — three statements, independent of N (see this module's
 * header). Runs inside `withTenant`, so `watchlist_item`'s and
 * `manual_price_point`'s RLS policies are what actually scope the tenant's
 * rows; the explicit `tenant_id` predicates are the defence in depth
 * `instrument-icon-service.ts` and `manual-price-service.ts` both document.
 */
async function loadWatchlistInputs(
  tx: Tx,
  params: ValueWatchlistForTenantParams,
): Promise<LoadedWatchlistInputs> {
  const { tenantId, asOfDate } = params;
  const fromDate = watchlistSeriesFromDate(asOfDate);

  // Statement 1. `instrument` is joined **inner** rather than outer: the
  // column is `NOT NULL` and references `instrument.id ON DELETE CASCADE`, so
  // a watchlist row without its catalogue row cannot exist, and an inner join
  // is what keeps `kind`/`displayName`/`status` non-nullable here instead of
  // adding fabricated fallbacks for a state the schema forbids.
  const items = await tx
    .select({
      instrumentId: watchlistItem.instrumentId,
      targetPrice: watchlistItem.targetPrice,
      note: watchlistItem.note,
      createdAt: watchlistItem.createdAt,
      kind: instrument.kind,
      displayName: instrument.displayName,
      listingCurrency: instrument.listingCurrency,
      exchangeMic: instrument.exchangeMic,
      sectorCode: instrument.sectorCode,
      industryLabel: instrument.industryLabel,
      domicileCountry: instrument.domicileCountry,
      status: instrument.status,
      // IK-10's **exact** presence expression, copied verbatim from
      // `loadHoldingsInputs` (`holdings-valuation.ts:784`): presence, never
      // bytes, so nothing here detoasts a 256 KiB value to answer a boolean.
      hasIcon: sql<boolean>`(${instrumentIcon.instrumentId} is not null)`,
    })
    .from(watchlistItem)
    .innerJoin(instrument, eq(instrument.id, watchlistItem.instrumentId))
    // `LEFT JOIN`, so an un-iconed instrument is still a row. There is
    // deliberately **no** `tenant_id` predicate on the joined side: this runs
    // inside `withTenant`, so `instrument_icon`'s RLS policy supplies
    // `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
    // and scopes it to the caller's own tenant — `holdings-valuation.ts:787-810`
    // records the measured plan for that join.
    .leftJoin(instrumentIcon, eq(instrumentIcon.instrumentId, instrument.id))
    .where(eq(watchlistItem.tenantId, tenantId));

  const instrumentIds = items.map((row) => row.instrumentId);
  if (instrumentIds.length === 0) {
    // An empty watchlist has nothing to price — and no statement is issued to
    // learn that, `loadPricingSeries`' own early return for the same case.
    return { items, prices: [], priceQualityByKey: new Map() };
  }

  // Statements 2 and 3 — both window-bounded, both an index range scan on the
  // respective primary key's `instrument_id` prefix (MEASURED: see
  // `watchlist-valuation.integration.test.ts`, which records the
  // `EXPLAIN (ANALYZE, BUFFERS)` plan for statement 2 at the 200-row cap
  // rather than restating a predicted one).
  const [dailyRows, manualRows] = await Promise.all([
    tx
      .select({
        instrumentId: instrumentPriceDaily.instrumentId,
        priceDate: instrumentPriceDaily.priceDate,
        closeRaw: instrumentPriceDaily.closeRaw,
        currency: instrumentPriceDaily.currency,
        sourceKey: instrumentPriceDaily.sourceKey,
        quality: instrumentPriceDaily.quality,
      })
      .from(instrumentPriceDaily)
      .where(
        and(
          inArray(instrumentPriceDaily.instrumentId, instrumentIds),
          between(instrumentPriceDaily.priceDate, fromDate, asOfDate),
        ),
      ),
    tx
      .select({
        instrumentId: manualPricePoint.instrumentId,
        priceDate: manualPricePoint.priceDate,
        close: manualPricePoint.close,
        currency: manualPricePoint.currency,
        sourceKey: manualPricePoint.sourceKey,
      })
      .from(manualPricePoint)
      .where(
        and(
          eq(manualPricePoint.tenantId, tenantId),
          inArray(manualPricePoint.instrumentId, instrumentIds),
          between(manualPricePoint.priceDate, fromDate, asOfDate),
        ),
      ),
  ]);

  const priceQualityByKey = new Map<string, DailyPriceQuality>();
  for (const row of dailyRows) {
    priceQualityByKey.set(
      priceProvenanceKey(row.instrumentId, row.priceDate as IsoDate),
      row.quality,
    );
  }

  const prices: PricePoint[] = [
    ...dailyRows.map((row): PricePoint => ({
      instrumentId: row.instrumentId,
      observedOn: row.priceDate as IsoDate,
      price: row.closeRaw,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "DAILY",
    })),
    // `quality` is never read for a manual point: it is always `MANUAL`,
    // decided by origin (`pricing-series.ts:47`).
    ...manualRows.map((row): PricePoint => ({
      instrumentId: row.instrumentId,
      observedOn: row.priceDate as IsoDate,
      price: row.close,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "MANUAL",
    })),
  ];

  return { items, prices, priceQualityByKey };
}

/**
 * W-3 — bucket the price points by `instrumentId` **once**, ascending by date.
 * Not micro-optimisation: `resolvePrice` filters by `instrumentId` *inside* its
 * single pass over whatever array it is handed
 * (`core/domain/valuation.ts:270-271`), so calling it per row against the flat
 * array is O(rows × points) — 200 × ~307 000 ≈ 61 million iterations at the cap
 * (UNVERIFIED arithmetic). Against a per-instrument bucket it is
 * O(points) total. `assembleHoldings` has the flat shape today at a much
 * smaller scale; this path must not inherit it.
 */
function bucketByInstrument(prices: readonly PricePoint[]): Map<string, PricePoint[]> {
  const byInstrument = new Map<string, PricePoint[]>();
  for (const point of prices) {
    const bucket = byInstrument.get(point.instrumentId);
    if (bucket === undefined) byInstrument.set(point.instrumentId, [point]);
    else bucket.push(point);
  }
  for (const bucket of byInstrument.values()) {
    bucket.sort((a, b) => (a.observedOn < b.observedOn ? -1 : a.observedOn > b.observedOn ? 1 : 0));
  }
  return byInstrument;
}

/**
 * Folds the two price origins into **one point per date**, with **manual
 * winning on a shared date** — the same precedence `resolvePrice` encodes
 * (`valuation.ts:283-289`: manual wins on ties and whenever at least as
 * recent). This is the one place the two sources must be *merged* rather than
 * *resolved*, and doing it any other way would put two points on one date and
 * silently double-count a return.
 *
 * The result is strictly ascending with unique dates by construction, which is
 * what `computeInstrumentMetrics`' own `UnsortedCloseSeriesError` guard
 * requires of its input.
 */
function mergeCloseSeries(bucket: readonly PricePoint[]): ClosePoint[] {
  const byDate = new Map<IsoDate, PricePoint>();
  for (const point of bucket) {
    const existing = byDate.get(point.observedOn);
    if (existing === undefined || point.origin === "MANUAL") byDate.set(point.observedOn, point);
  }
  return [...byDate.values()]
    .sort((a, b) => (a.observedOn < b.observedOn ? -1 : a.observedOn > b.observedOn ? 1 : 0))
    .map((point) => ({ date: point.observedOn, close: point.price }));
}

/** FR-365/NFR-39 — enforced once, over the whole array the caller is about to return. Throws before the response object exists, so there is no partial array to leak. */
function assertWithinWatchlistCaps(rows: readonly ValuedWatchlistRow[]): void {
  if (rows.length > MAX_WATCHLIST_ROWS_PER_VIEW) {
    throw new TooManyWatchlistRowsError(rows.length, MAX_WATCHLIST_ROWS_PER_VIEW);
  }
}

/** The row's one shared provenance envelope: every figure on the row derives from the same series and the same freshness fact, so N copies could only ever disagree. The closed-positions rule (one envelope shared by every aggregate figure) reused. */
function provenanceOf(flags: PriceFlagResult): FigureProvenance {
  return {
    priceSource: flags.priceSource,
    priceQuality: flags.priceQuality,
    priceAsOf: flags.priceAsOf,
    priceIsStale: flags.priceIsStale,
    // The **existing** `finalize` — "default to `AUTOMATED` when nothing
    // else applies" — not a second copy of that decision: `buildPriceFlags`
    // returns `[]` for a plain EOD close, and every other figure in the app
    // renders that as `AUTOMATED`.
    derivedFrom: finalize(flags.flags),
  };
}

/**
 * H2(c) — the pure half, run *after* the transaction has closed (so the pooled
 * connection is released before any of this runs). Takes exactly what
 * {@link loadWatchlistInputs} read, nothing more, and touches no database.
 *
 * Package-internal export: `watchlist-valuation.test.ts` drives it directly,
 * which is how the merge precedence, the bucketing, the day-change absence and
 * the cap are asserted without seeding a database for arithmetic that has
 * nothing to do with one.
 */
export function assembleWatchlist(
  loaded: LoadedWatchlistInputs,
  params: ValueWatchlistForTenantParams,
): ValuedWatchlist {
  const { asOfDate } = params;
  const window = resolveWatchlistWindow(params.window, asOfDate);
  const byInstrument = bucketByInstrument(loaded.prices);

  const rows: ValuedWatchlistRow[] = loaded.items.map((item) => {
    const bucket = byInstrument.get(item.instrumentId) ?? [];
    const closes = mergeCloseSeries(bucket);

    // FR-346: `undefined` is a **normal** outcome here — a watched instrument
    // that has never been backfilled, or a FUND with no manual NAV, has no
    // price and still renders. Never `UnresolvablePriceError`.
    const current = resolvePrice(bucket, item.instrumentId, asOfDate);
    const priceFlags =
      current === undefined
        ? undefined
        : buildPriceFlags(item.instrumentId, current, asOfDate, loaded.priceQualityByKey);
    const listingCurrency = item.listingCurrency as CurrencyCode;
    const currentPrice: ValuedFigure | undefined =
      current === undefined || priceFlags === undefined
        ? undefined
        : {
            amount: current.price,
            // The instrument's own listing currency, never the tenant's base:
            // nothing on this path converts.
            currency: listingCurrency,
            provenance: provenanceOf(priceFlags),
          };

    // FR-348 — the previous observation, resolved by the same LOCF rule one
    // day earlier. Absent when there is none: never a fabricated `0`.
    const previous =
      current === undefined
        ? undefined
        : resolvePrice(bucket, item.instrumentId, dayBefore(current.observedOn));
    const dayChange =
      current === undefined || previous === undefined
        ? undefined
        : current.price.minus(previous.price);
    const dayChangePercent =
      dayChange === undefined || previous === undefined || previous.price.isZero()
        ? undefined
        : dayChange.div(previous.price);

    const metrics = computeInstrumentMetrics({
      closes,
      asOfDate,
      windowStartDate: window.from,
    });

    // The wire series is the **selected window's** slice, decimated. The
    // metrics above deliberately read the whole loaded series (an SMA is
    // defined by its own lookback, not by the screen's).
    const withinWindow = closes.filter(
      (point) => point.date >= window.from && point.date <= asOfDate,
    );
    const series = decimateCloseSeries(withinWindow, WATCHLIST_SERIES_MAX_POINTS).map((point) => ({
      date: point.date,
      close: point.close,
    }));

    return {
      instrumentId: item.instrumentId,
      kind: item.kind,
      displayName: item.displayName,
      hasIcon: item.hasIcon,
      status: item.status,
      listingCurrency,
      exchangeMic: item.exchangeMic,
      listingCountry:
        item.exchangeMic === null ? null : (micToCountryCode(item.exchangeMic) ?? null),
      sectorCode: item.sectorCode,
      industryLabel: item.industryLabel,
      domicileCountry: item.domicileCountry,
      watchedSince: item.createdAt.toISOString().slice(0, 10) as IsoDate,
      // W-10's encoding, by conditional spread rather than an explicit
      // `undefined`, so `JSON.stringify` drops the key outright: `null` in the
      // column means "not set", and the wire says so by omission. (`api`'s own
      // schema then re-introduces `null` for exactly these two fields, because
      // `PATCH` needs to distinguish "clear" from "leave alone".)
      ...(item.targetPrice !== null ? { targetPrice: item.targetPrice } : {}),
      ...(item.note !== null ? { note: item.note } : {}),
      ...(currentPrice !== undefined ? { currentPrice } : {}),
      ...(dayChange !== undefined ? { dayChange } : {}),
      ...(dayChangePercent !== undefined ? { dayChangePercent } : {}),
      metrics,
      series,
    };
  });

  // `displayName` ascending case-insensitively, `instrumentId` as
  // the deterministic tie-break, so two reads of unchanged data are
  // byte-identical. Rejected: `created_at` descending — a watchlist is scanned
  // repeatedly for a known name, not read as a feed.
  rows.sort(compareByDisplayName);

  assertWithinWatchlistCaps(rows);

  return { asOfDate, window, rows };
}

/** The row-ordering comparator, lifted out so the ordering rule has one home. `localeCompare` is deliberately not used: it is locale-dependent, and this order must be stable across deployments. */
function compareByDisplayName(a: ValuedWatchlistRow, b: ValuedWatchlistRow): number {
  const left = a.displayName.toLowerCase();
  const right = b.displayName.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
}

/**
 * The tenant's watchlist as of `asOfDate` — the engine behind
 * `GET /watchlist?window=`.
 *
 * Two phases, `valueClosedPositionsAsOf`'s exact shape and the H2(c) rule it
 * enforces: the `withTenant` transaction covers only the three reads, and every
 * pure computation runs after it has closed.
 */
export async function valueWatchlistForTenant(
  db: Db,
  params: ValueWatchlistForTenantParams,
): Promise<ValuedWatchlist> {
  const loaded = await withTenant(db, params.tenantId, (tx) => loadWatchlistInputs(tx, params));
  return assembleWatchlist(loaded, params);
}
