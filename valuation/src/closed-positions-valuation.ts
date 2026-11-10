import { Decimal } from "@kerdial/core-decimal";
import {
  computeClosedPositions,
  computeRealizedGains,
  mergeProvenance,
  type ClosedPosition,
  type CurrencyCode,
  type DerivedFromFlag,
  type IsoDate,
} from "@kerdial/core-domain";
import { listPortfolios, type InstrumentKind } from "@kerdial/ledger";
import { tenant, withTenant, type Db } from "@kerdial/platform-db";
import { eq } from "drizzle-orm";
import { mapWithConcurrency } from "./concurrency.js";
import {
  buildRealizedGain,
  finalize,
  loadHoldingsInputs,
  FAN_OUT_CONCURRENCY,
  type FigureProvenance,
  type LoadedHoldingsInputs,
  type ValuedFigure,
  type ValuedRealizedGain,
} from "./holdings-valuation.js";

/**
 * `valueClosedPositionsAsOf` / `valueClosedPositionsForTenant` —
 * FR-321–FR-333/FR-336–FR-337.
 * Backs `GET /portfolios/:id/closed-positions` and
 * `GET /portfolios/closed-positions`: the instruments a tenant now holds
 * **zero** of, and what selling out of them realized.
 *
 * ## Why this is a sibling of `holdings-valuation.ts` and not part of it (CP-1)
 *
 * `holdings-valuation.ts` is entirely about valuing *open* positions against
 * *live* prices — `valuePortfolio`, price/FX flag construction, staleness
 * aggregation, day change, the cross-portfolio `HoldingAccumulator` merge. This
 * path shares that module's **loader** and nothing else, and there is exactly
 * one thing it must categorically never do: call `valuePortfolio` (see
 * "Never prices anything" below). Putting a function that must not price
 * anything inside the module whose whole subject is pricing invites precisely
 * the accident it forbids.
 *
 * The split's cost is five package-internal exports of `holdings-valuation.ts`
 * ({@link loadHoldingsInputs}, {@link LoadedHoldingsInputs},
 * {@link buildRealizedGain}, {@link finalize}, {@link FAN_OUT_CONCURRENCY}),
 * none of which is on `valuation/src/index.ts`. See that module's A1 note
 * (beside its `ResponseCapOverrides`) for the measured unused-exports-gate
 * behaviour that makes this safe — and for why `ResponseCapOverrides`, the
 * fifth candidate symbol, is deliberately **not** among them.
 *
 * ## The loader is reused unforked (CP-2)
 *
 * {@link loadHoldingsInputs} already reads, in one `withTenant` transaction,
 * everything this path needs — and not by approximation: its `instrumentIds`
 * superset is documented in-file as "every instrument this portfolio ever
 * traded … at the cost of loading a handful of prices for fully-divested
 * instruments nothing downstream reads." Those fully-divested instruments are
 * this module's entire subject. The accepted cost is the reverse: this path
 * pays for `loadPricingSeries` and reads none of its four outputs. Forking a
 * security-reviewed loader (L2's `asOfDate` truncation, H2(c)'s split, AR-5's
 * tenant-base read) into two copies that must stay in step forever, to save a
 * bounded price read, is the worse trade. Revisit trigger, if the "Clôturées"
 * tab's p95 ever becomes a measured problem: add an optional
 * `skipPricingSeries?: boolean` to `ValueHoldingsAsOfParams` and branch inside
 * the one loader — never fork it.
 *
 * ## Never prices anything, and that is load-bearing
 *
 * A closed position has no current price and needs none, so this path never
 * calls `valuePortfolio` and **cannot** raise `UnresolvablePriceError` /
 * `UnresolvableRateError` (the `VALUATION_PRICE_UNAVAILABLE` /
 * `VALUATION_FX_RATE_UNAVAILABLE` a caller sees). A fully-divested instrument
 * may have no price series at all, and failing a historical realized-result
 * read because some *other, still-open* holding is currently unpriceable would
 * be indefensible. Consequence, worth stating because it reads as an
 * inconsistency until you know it is the design: the "Clôturées" tab keeps
 * working on a portfolio whose "Ouvertes" tab is showing the
 * price-unavailable panel. `closed-positions-valuation.integration.test.ts`
 * pins this with a fixture whose closed instrument has **no** price rows.
 *
 * Corollary, stated so nobody "fixes" it: this feature creates no new
 * market-data demand. The quote-refresh and ingestion fan-outs are driven by
 * `holding_state.quantity > 0`; closed instruments are correctly excluded and
 * must stay excluded — their figures are historical and no live quote can move
 * them.
 *
 * ## Provenance (FR-328)
 *
 * One {@link FigureProvenance}, shared by all four aggregate figures, built by
 * `mergeProvenance` over the **legs this module just produced** rather than
 * re-derived from `transactionRows` — which is what makes it impossible for an
 * aggregate to claim a provenance its own itemised rows contradict. It carries
 * no `priceSource`/`priceQuality`/`priceAsOf`/`priceIsStale`/`fxSource`/
 * `fxRateObservedOn` (none of these figures has a live-price or
 * valuation-date-FX dependency — exactly as `assembleHoldings`'s own
 * `pmpProvenance` carries none) and no `summary` (the established boundary is
 * that `ProvenanceSummary` appears on *view-level* totals, and this response
 * deliberately has none).
 */

const ZERO = new Decimal(0);

/**
 * One instrument the tenant/portfolio now holds zero of, and what selling out
 * of it realized. The pre-JSON counterpart of `api`'s
 * `ClosedPositionResponse`.
 *
 * **Deliberately absent** (CP-9), so none of these reads as an oversight:
 * `sectorCode`/`domicileCountry`/`listingCountry` (loaded for free by the
 * shared loader, but there is no allocation/treemap/exposure view for closed
 * positions and IR-12's own rule is that those columns were added *because* a
 * screen needed them); `pmp`/`costBasis` (a closed position has neither — that
 * is the `0 / 0` `computePmp` drops it over); `currentPrice`/`currentValue`/
 * `unrealizedGainLoss`/`dayChange` (nothing here is valued live); `quantity`
 * and any total-quantity-sold (UR-42 enumerates the per-position display and
 * does not include one, and FR-326 introduces exactly one new figure);
 * `saleLotCount` (equal to `realizedGains.length` — a redundant count is one
 * refactor away from disagreeing with the array it counts).
 */
export interface ValuedClosedPosition {
  readonly instrumentId: string;
  readonly kind: InstrumentKind;
  readonly displayName: string;
  readonly hasIcon: boolean;
  /**
   * The currency {@link totalRealizedGainNative} is expressed in. The tenant's
   * base currency when the position's native total collapsed
   * (`ClosedPosition.nativeCurrencyMixed`: a mixed instrument, or any
   * crypto-settlement leg); otherwise the one currency its legs
   * resolved to (`RealizedGain.nativeCurrency`). The
   * listing currency is only the "cannot happen" fallback. Originally
   * (CP-3/A2) this was always `instrument.listing_currency`.
   */
  readonly currency: CurrencyCode;
  /** Σ `gainBase` over every disposal leg, in the tenant's ledger base currency (FR-325). */
  readonly totalRealizedGainBase: ValuedFigure;
  /** Σ `gainNative`, labelled with {@link currency} — see that field for the labelling rule and its caveat. */
  readonly totalRealizedGainNative: ValuedFigure;
  /** Σ `fxComponentBase` — FR-30's separate FX-attribution line, summed. */
  readonly totalFxComponentBase: ValuedFigure;
  /**
   * FR-326, the one new figure: Σ (`pmpUnitBaseAtSale` × `quantitySold`), read
   * off `RealizedGain` directly and never re-derived from a wire field. It is
   * the denominator a client needs to turn {@link totalRealizedGainBase} into a
   * return percentage — the server ships the two raw figures and **no**
   * percentage string of its own (FR-327).
   */
  readonly totalDisposedCostBasisBase: ValuedFigure;
  /** Every disposal leg that contributed, in `computeRealizedGains`'s own `(tradeDate, seq)` order — never re-sorted on the per-portfolio path (FR-330). Produced by the existing, unmodified `buildRealizedGain`, so a given leg serialises byte-identically whether reached through here or through `HoldingResponse.realizedGains` (FR-335). */
  readonly realizedGains: readonly ValuedRealizedGain[];
}

export interface ValuedClosedPositions {
  readonly asOfDate: IsoDate;
  readonly baseCurrency: CurrencyCode;
  readonly closedPositions: readonly ValuedClosedPosition[];
  /** The single portfolio's `calc_epoch`, or — for {@link valueClosedPositionsForTenant} — the **identical** L5 rule `valueHoldingsForTenant` uses (Σ constituent epochs + portfolio count), on purpose, so a client can key one freshness check across both responses without knowing which produced which. */
  readonly calcEpoch: bigint;
  /** 1 for {@link valueClosedPositionsAsOf}; the tenant's portfolio count for {@link valueClosedPositionsForTenant}. */
  readonly portfolioCount: number;
}

/**
 * OD-4/FR-333, mirroring `holdings-valuation.ts`'s L6 cap block line for line —
 * and **distinct** from it in every name: this is not a repurposing of
 * `MAX_HOLDINGS_PER_VIEW`, whose own enforcement for the open path is untouched
 * (FR-336). Reject, never truncate (NFR-5): the assert below throws before any
 * response object is built, it does not slice the array.
 *
 * @public mirrored in `web/src/lib/api-limits.ts` and asserted against this definition by `web/src/lib/api-limits.drift.test.ts`, a cross-workspace deep import the unused-export gate does not scan.
 */
export const MAX_CLOSED_POSITIONS_PER_VIEW = 1000;

/** @public see {@link MAX_CLOSED_POSITIONS_PER_VIEW} — mirrored and drift-guarded from `web` the same way. */
export const MAX_SALE_LOTS_PER_CLOSED_POSITION = 1000;

/** Thrown by {@link valueClosedPositionsAsOf}/{@link valueClosedPositionsForTenant} when a view's closed-position count exceeds {@link MAX_CLOSED_POSITIONS_PER_VIEW}. Mapped to a 4xx by the API layer, never a raw 500 and never a silently truncated body. */
export class TooManyClosedPositionsError extends Error {
  readonly count: number;
  readonly limit: number;

  constructor(count: number, limit: number = MAX_CLOSED_POSITIONS_PER_VIEW) {
    super(`This view would return ${count} closed positions, exceeding the ${limit}-position cap.`);
    this.name = "TooManyClosedPositionsError";
    this.count = count;
    this.limit = limit;
  }
}

/** Thrown when a single closed position's sale-lot history exceeds {@link MAX_SALE_LOTS_PER_CLOSED_POSITION}. */
export class TooManySaleLotsError extends Error {
  readonly instrumentId: string;
  readonly count: number;
  readonly limit: number;

  constructor(
    instrumentId: string,
    count: number,
    limit: number = MAX_SALE_LOTS_PER_CLOSED_POSITION,
  ) {
    super(
      `Instrument ${instrumentId} has ${count} sale lots in this view, exceeding the ${limit}-row cap.`,
    );
    this.name = "TooManySaleLotsError";
    this.instrumentId = instrumentId;
    this.count = count;
    this.limit = limit;
  }
}

/** Test-only escape hatch for {@link assertWithinClosedPositionCaps}'s two real constants — same reason `holdings-valuation.ts`'s own `ResponseCapOverrides` exists: a real 1,000-position fixture is impractical to seed. */
interface ClosedPositionCapOverrides {
  readonly maxClosedPositions?: number;
  readonly maxSaleLotsPerClosedPosition?: number;
}

/** Enforces {@link MAX_CLOSED_POSITIONS_PER_VIEW}/{@link MAX_SALE_LOTS_PER_CLOSED_POSITION}, or `overrides`' test-only replacements — called once per entry point, over the **whole** array that entry point is about to return (for the combined view that is the *merged* array: R6, a tenant can exceed the per-position lot cap only in combination, so a per-portfolio-only check would miss it). */
function assertWithinClosedPositionCaps(
  positions: readonly ValuedClosedPosition[],
  overrides?: ClosedPositionCapOverrides,
): void {
  const maxClosedPositions = overrides?.maxClosedPositions ?? MAX_CLOSED_POSITIONS_PER_VIEW;
  const maxSaleLotsPerClosedPosition =
    overrides?.maxSaleLotsPerClosedPosition ?? MAX_SALE_LOTS_PER_CLOSED_POSITION;

  if (positions.length > maxClosedPositions) {
    throw new TooManyClosedPositionsError(positions.length, maxClosedPositions);
  }
  for (const position of positions) {
    if (position.realizedGains.length > maxSaleLotsPerClosedPosition) {
      throw new TooManySaleLotsError(
        position.instrumentId,
        position.realizedGains.length,
        maxSaleLotsPerClosedPosition,
      );
    }
  }
}

export interface ValueClosedPositionsAsOfParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** Inclusive — the same truncation the holdings read applies. */
  readonly asOfDate: IsoDate;
  /** Test-only override — see {@link ClosedPositionCapOverrides}. */
  readonly responseCapOverrides?: ClosedPositionCapOverrides;
}

export interface ValueClosedPositionsForTenantParams {
  readonly tenantId: string;
  readonly asOfDate: IsoDate;
  /** Test-only override — see {@link ClosedPositionCapOverrides}. */
  readonly responseCapOverrides?: ClosedPositionCapOverrides;
}

/**
 * {@link assembleClosedPositions}'s full result: the view a single portfolio
 * would return, **plus** the complement it computed on the way to deciding
 * membership. `openInstrumentIds` is internal only and never reaches the wire —
 * it exists so {@link valueClosedPositionsForTenant} can apply OD-3's
 * membership rule at the *merged* level (CP-4) without a second fan-out.
 */
interface AssembledClosedPositions {
  readonly view: ValuedClosedPositions;
  /** Every instrument whose replayed quantity at `asOfDate` is strictly positive in this portfolio. */
  readonly openInstrumentIds: readonly string[];
}

/**
 * H2(c) — the pure-compute half of {@link valueClosedPositionsAsOf}, run
 * *after* `withTenant`'s transaction has closed, so the pooled connection is
 * released before any of this runs. Takes exactly what
 * {@link loadHoldingsInputs} read, nothing more, and touches no database.
 */
function assembleClosedPositions(
  loaded: LoadedHoldingsInputs,
  params: ValueClosedPositionsAsOfParams,
): AssembledClosedPositions {
  const { portfolioId, asOfDate } = params;
  const {
    baseCurrency,
    calcEpoch,
    timeline,
    transactionIdBySeq,
    transactionRows,
    kindByInstrumentId,
    displayNameByInstrumentId,
    referenceByInstrumentId,
    listingCurrencyByInstrumentId,
  } = loaded;

  // The identical line `assembleHoldings` uses — not a paraphrase of it.
  const truncated = timeline.filter((event) => event.txn.tradeDate <= asOfDate);
  const gains = computeRealizedGains(truncated);
  const closed = computeClosedPositions(truncated, gains);

  // CP-4's input, computed here rather than by a second engine call: the same
  // last-event-wins fold `computeClosedPositions` performs internally, kept as
  // the literal complement of its own `state.quantity.greaterThan(0)`
  // predicate so the open and closed sets can neither overlap nor leave an
  // instrument in neither. (`computePmp` is deliberately not called: this path
  // has no use for a PMP and calling it would only re-derive this same map
  // behind a signature FR-334 requires stay untouched.)
  const finalQuantityByInstrumentId = new Map<string, Decimal>();
  for (const event of truncated) {
    finalQuantityByInstrumentId.set(event.txn.instrumentId, event.after.quantity);
  }
  const openInstrumentIds: string[] = [];
  for (const [instrumentId, quantity] of finalQuantityByInstrumentId) {
    if (quantity.greaterThan(0)) openInstrumentIds.push(instrumentId);
  }

  const fxRateSourceByTxnId = new Map(transactionRows.map((r) => [r.id, r.fxRateSource]));

  // CP-11: most-recently-closed first, ties broken by `instrumentId` so two
  // reads of unchanged data are byte-identical. Sorted *before* the mapping
  // below, because `lastDisposalDate` is an ordering key that never leaves this
  // pure layer (NG1 — it is not a wire field, and a client that wants a closing
  // date reads it off the last `realizedGains` element it already receives).
  const ordered = [...closed].sort(compareByLastDisposalDesc);

  const closedPositions: ValuedClosedPosition[] = ordered.map((position) => {
    // Read through the same defensive fallbacks `assembleHoldings` uses, for
    // the identical "cannot happen — the loader's `instrumentIds` superset
    // covers every instrument this portfolio ever traded" reason. A miss
    // degrades to an honest state, never to a fabricated one.
    // Legs of one instrument no longer share one label — a
    // crypto-settlement leg is base-collapsed on its own while the ordinary
    // SELLs keep their trade currency. So each leg is labelled with its own
    // currency, and the aggregate reads `position.nativeCurrencyMixed`
    // (`computeClosedPositions` has already collapsed the totals to base when
    // it is set). When it is not, every leg resolved to the same currency,
    // so any leg's label is the aggregate's. Falls back
    // to listingCurrencyByInstrumentId only in the true "cannot happen" case
    // (an unmixed leg always carries its nativeCurrency).
    const legCurrency = (lot: (typeof position.saleLots)[number]): CurrencyCode =>
      lot.nativeCurrencyMixed
        ? baseCurrency
        : (lot.nativeCurrency ??
          listingCurrencyByInstrumentId.get(position.instrumentId) ??
          baseCurrency);
    const firstLot = position.saleLots[0];
    const currency = position.nativeCurrencyMixed
      ? baseCurrency
      : firstLot !== undefined
        ? legCurrency(firstLot)
        : (listingCurrencyByInstrumentId.get(position.instrumentId) ?? baseCurrency);
    const realizedGains = position.saleLots.map((lot) =>
      // The existing, unmodified builder (FR-323/FR-329) — no re-sort of
      // `saleLots` (FR-330), no new per-leg figure.
      buildRealizedGain(
        portfolioId,
        lot,
        legCurrency(lot),
        fxRateSourceByTxnId,
        transactionIdBySeq,
        baseCurrency,
      ),
    );
    const provenance = aggregateLegProvenance(realizedGains);

    return {
      instrumentId: position.instrumentId,
      kind: kindByInstrumentId.get(position.instrumentId) ?? "SHARE",
      displayName: displayNameByInstrumentId.get(position.instrumentId) ?? position.instrumentId,
      hasIcon: referenceByInstrumentId.get(position.instrumentId)?.hasIcon ?? false,
      currency,
      totalRealizedGainBase: {
        amount: position.totalRealizedGainBase,
        currency: baseCurrency,
        provenance,
      },
      totalRealizedGainNative: {
        amount: position.totalRealizedGainNative,
        currency,
        provenance,
      },
      totalFxComponentBase: {
        amount: position.totalFxComponentBase,
        currency: baseCurrency,
        provenance,
      },
      totalDisposedCostBasisBase: {
        amount: position.totalDisposedCostBasisBase,
        currency: baseCurrency,
        provenance,
      },
      realizedGains,
    };
  });

  assertWithinClosedPositionCaps(closedPositions, params.responseCapOverrides);

  return {
    view: { asOfDate, baseCurrency, closedPositions, calcEpoch, portfolioCount: 1 },
    openInstrumentIds,
  };
}

/** CP-11's comparator, lifted out so the per-portfolio and combined paths provably order by the same rule. ISO dates compare lexicographically. */
function compareByLastDisposalDesc(
  a: Pick<ClosedPosition, "instrumentId" | "lastDisposalDate">,
  b: Pick<ClosedPosition, "instrumentId" | "lastDisposalDate">,
): number {
  if (a.lastDisposalDate !== b.lastDisposalDate) {
    return a.lastDisposalDate < b.lastDisposalDate ? 1 : -1;
  }
  return a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0;
}

/**
 * FR-325/FR-328: the one envelope all four aggregate figures share, merged over
 * the legs' own already-finalised flag sets — see this module's header for why
 * it is read off the legs rather than re-derived.
 *
 * **Zero legs is a real input since security transfers** (`security-transfer`
 * R-8): a position closed by a transfer out has `saleLots: []`.
 * The merge of no flag sets is empty, so `finalize` answers `["AUTOMATED"]` and
 * nothing else — the same envelope any flagless figure carries. Exported for
 * that unit test only.
 */
export function aggregateLegProvenance(legs: readonly ValuedRealizedGain[]): FigureProvenance {
  const flagSets: (readonly DerivedFromFlag[])[] = legs.map(
    (leg) => leg.gainBase.provenance.derivedFrom,
  );
  return { derivedFrom: finalize(mergeProvenance(flagSets)) };
}

/**
 * One portfolio's closed positions as of `asOfDate` — the engine behind
 * `GET /portfolios/:id/closed-positions`.
 *
 * Follows {@link valueHoldingsAsOf}'s exact two-phase shape and the H2(c) rule
 * it enforces: the `withTenant` transaction covers only the DB reads, and every
 * pure computation runs after it has closed, so the pooled connection is
 * released before any CPU work runs.
 */
export async function valueClosedPositionsAsOf(
  db: Db,
  params: ValueClosedPositionsAsOfParams,
): Promise<ValuedClosedPositions> {
  const { tenantId, portfolioId, asOfDate } = params;
  const loaded = await withTenant(db, tenantId, (tx) =>
    loadHoldingsInputs(tx, { tenantId, portfolioId, asOfDate }, { withCash: false }),
  );
  return assembleClosedPositions(loaded, params).view;
}

/** One instrument's cross-portfolio accumulation. The four totals are summed — all four are additive across portfolios; `kind`/`displayName`/`hasIcon`/`currency` are carried from the first contributing portfolio, the same rule `HoldingAccumulator` already applies to `kind`/`displayName`, because they are `instrument`-table properties that cannot vary by portfolio. */
interface ClosedPositionAccumulator {
  totalRealizedGainBase: Decimal;
  totalRealizedGainNative: Decimal;
  totalFxComponentBase: Decimal;
  totalDisposedCostBasisBase: Decimal;
  kind: InstrumentKind;
  displayName: string;
  hasIcon: boolean;
  currency: CurrencyCode;
  flagSets: (readonly DerivedFromFlag[])[];
  realizedGains: ValuedRealizedGain[];
}

/**
 * The combined, tenant-wide view — `GET /portfolios/closed-positions`. Runs
 * the per-portfolio assembly once per portfolio the tenant owns, through the
 * same bounded {@link mapWithConcurrency} pool at the same
 * {@link FAN_OUT_CONCURRENCY} the holdings fan-out uses, then merges.
 *
 * ## The one trap (CP-4)
 *
 * OD-3 defines a closed position by the **current quantity being zero**, and
 * `GET /portfolios/holdings` merges the same instrument across portfolios into
 * one line. So for the tenant-wide pair the membership predicate must be
 * evaluated on the **merged** quantity:
 *
 * > An instrument fully sold in portfolio A but still open in portfolio B
 * > appears on `GET /portfolios/holdings` as one open line, and therefore must
 * > **not** appear here at all.
 *
 * A naive union of the per-portfolio closed sets lists it in both responses
 * simultaneously — exactly the state OD-3/AC-322 exist to forbid, one level up
 * from where the spec states it. Its A-side disposal legs are not lost:
 * `valueHoldingsForTenant` already concatenates every contributing portfolio's
 * `realizedGains` onto the merged open holding, which is the NG6 home for a leg
 * on a still-open instrument.
 *
 * Rejected: calling `valueHoldingsForTenant` to learn which instruments are
 * open. It doubles the replay work and the pooled-connection pressure for
 * information the closed fan-out already holds internally
 * (`openInstrumentIds`) — precisely the H2(d)/N5 trap the controller spent two
 * security reviews removing.
 *
 * ## The sale-lot sort is a deliberate divergence (CP-10)
 *
 * The merged sale-lot list is **stable-sorted by `tradeDate` ascending**.
 * `valueHoldingsForTenant` concatenates its own per-portfolio `realizedGains`
 * without sorting, so a two-portfolio instrument renders 2021, 2022, 2019,
 * 2020. FR-330 requires chronological rendering on *this* surface, so this one
 * sorts — and the existing combined holdings response is left untouched,
 * because it is under this feature's own FR-335 byte-for-byte non-regression
 * guarantee. The inconsistency is recorded as an adjacent finding rather than
 * silently fixed under that guarantee; **do not backport this sort.**
 */
export async function valueClosedPositionsForTenant(
  db: Db,
  params: ValueClosedPositionsForTenantParams,
): Promise<ValuedClosedPositions> {
  const { tenantId, asOfDate } = params;

  // AR-5, and the same reason `valueHoldingsForTenant` reads it here rather
  // than inferring it from the first per-portfolio result: a zero-portfolio
  // tenant still gets an honest `baseCurrency` on the empty response.
  const [tenantRow] = await db
    .select({ baseCurrency: tenant.baseCurrency })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!tenantRow) {
    throw new Error(`valueClosedPositionsForTenant: no tenant row for ${tenantId}`);
  }
  const baseCurrency = tenantRow.baseCurrency as CurrencyCode;

  const portfolios = await listPortfolios(db, tenantId);

  const perPortfolio = await mapWithConcurrency(portfolios, FAN_OUT_CONCURRENCY, async (p) => {
    const loaded = await withTenant(db, tenantId, (tx) =>
      loadHoldingsInputs(tx, { tenantId, portfolioId: p.id, asOfDate }, { withCash: false }),
    );
    return assembleClosedPositions(loaded, { tenantId, portfolioId: p.id, asOfDate });
  });

  // Step 1 — collect. Step 2's exclusion set is the union of every portfolio's
  // own open set, so one still-open contribution anywhere removes the
  // instrument from this view entirely.
  const openAnywhere = new Set<string>();
  for (const assembled of perPortfolio) {
    for (const instrumentId of assembled.openInstrumentIds) openAnywhere.add(instrumentId);
  }

  // Step 3 — merge the survivors.
  //
  // `position.currency` is a
  // per-portfolio answer (base currency when that portfolio's own timeline
  // is mixed, else the instrument's listing currency) — two portfolios can
  // legitimately disagree about it for the same instrument. Tracked here so
  // the merge below can fall back to MC-D2's own convention (native ≡ base)
  // instead of summing two portfolios' `totalRealizedGainNative` under
  // whichever currency the first-seen portfolio happened to report — the
  // exact cross-currency-sum defect MC-D1 exists to prevent, recurring one
  // level up at this tenant-wide merge.
  const firstCurrencyByInstrument = new Map<string, CurrencyCode>();
  const tenantCurrencyMixed = new Set<string>();
  for (const assembled of perPortfolio) {
    for (const position of assembled.view.closedPositions) {
      if (openAnywhere.has(position.instrumentId)) continue;
      const seen = firstCurrencyByInstrument.get(position.instrumentId);
      if (seen === undefined) {
        firstCurrencyByInstrument.set(position.instrumentId, position.currency);
      } else if (seen !== position.currency) {
        tenantCurrencyMixed.add(position.instrumentId);
      }
    }
  }

  const merged = new Map<string, ClosedPositionAccumulator>();
  for (const assembled of perPortfolio) {
    for (const position of assembled.view.closedPositions) {
      if (openAnywhere.has(position.instrumentId)) continue;
      const acc = merged.get(position.instrumentId) ?? {
        totalRealizedGainBase: ZERO,
        totalRealizedGainNative: ZERO,
        totalFxComponentBase: ZERO,
        totalDisposedCostBasisBase: ZERO,
        kind: position.kind,
        displayName: position.displayName,
        hasIcon: position.hasIcon,
        currency: position.currency,
        flagSets: [],
        realizedGains: [],
      };
      acc.totalRealizedGainBase = acc.totalRealizedGainBase.plus(
        position.totalRealizedGainBase.amount,
      );
      acc.totalRealizedGainNative = acc.totalRealizedGainNative.plus(
        position.totalRealizedGainNative.amount,
      );
      acc.totalFxComponentBase = acc.totalFxComponentBase.plus(
        position.totalFxComponentBase.amount,
      );
      acc.totalDisposedCostBasisBase = acc.totalDisposedCostBasisBase.plus(
        position.totalDisposedCostBasisBase.amount,
      );
      acc.flagSets.push(position.totalRealizedGainBase.provenance.derivedFrom);
      acc.realizedGains.push(...position.realizedGains);
      merged.set(position.instrumentId, acc);
    }
  }

  const closedPositions: ValuedClosedPosition[] = [...merged.entries()]
    .map(([instrumentId, acc]) => {
      // Step 4 (CP-10) — see this function's header. `Array.prototype.sort` is
      // required to be stable, so two legs on the same `tradeDate` keep the
      // relative order the concatenation gave them.
      const realizedGains = [...acc.realizedGains].sort((a, b) =>
        a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
      );
      const provenance: FigureProvenance = { derivedFrom: finalize(mergeProvenance(acc.flagSets)) };
      // Two portfolios disagreeing on this instrument's
      // currency means `acc.totalRealizedGainNative` is a sum of
      // incompatible currencies (MC-D1's own hazard). Fall back to base —
      // `totalRealizedGainBase` is always correct and already computed,
      // needing no new derivation (MC-D2).
      const currency = tenantCurrencyMixed.has(instrumentId) ? baseCurrency : acc.currency;
      const totalRealizedGainNative = tenantCurrencyMixed.has(instrumentId)
        ? acc.totalRealizedGainBase
        : acc.totalRealizedGainNative;
      // The FX line collapses with the native total — the same
      // pair `computeClosedPositions` collapses per portfolio. Summing one
      // portfolio's real FX component into a base-collapsed position would
      // break `gainBase = gainNative × rate + fx` for the merged line.
      const totalFxComponentBase = tenantCurrencyMixed.has(instrumentId)
        ? ZERO
        : acc.totalFxComponentBase;
      return {
        instrumentId,
        kind: acc.kind,
        displayName: acc.displayName,
        hasIcon: acc.hasIcon,
        currency,
        totalRealizedGainBase: {
          amount: acc.totalRealizedGainBase,
          currency: baseCurrency,
          provenance,
        },
        totalRealizedGainNative: {
          amount: totalRealizedGainNative,
          currency,
          provenance,
        },
        totalFxComponentBase: {
          amount: totalFxComponentBase,
          currency: baseCurrency,
          provenance,
        },
        totalDisposedCostBasisBase: {
          amount: acc.totalDisposedCostBasisBase,
          currency: baseCurrency,
          provenance,
        },
        realizedGains,
      };
    })
    // CP-11 again, by the same comparator: the merged position's own last
    // disposal is the last element of its now-ascending sale-lot list, so the
    // combined view orders most-recently-closed first exactly as the
    // per-portfolio one does.
    .sort((a, b) =>
      compareByLastDisposalDesc(
        { instrumentId: a.instrumentId, lastDisposalDate: lastDisposalOf(a) },
        { instrumentId: b.instrumentId, lastDisposalDate: lastDisposalOf(b) },
      ),
    );

  // R6: over the **merged** array, never a per-portfolio one — a tenant can
  // exceed the per-position lot cap only in combination (600 lots in A plus 600
  // in B for the same instrument, neither alone over the cap).
  assertWithinClosedPositionCaps(closedPositions, params.responseCapOverrides);

  // L5, the identical rule `valueHoldingsForTenant` applies — see this
  // module's {@link ValuedClosedPositions.calcEpoch}.
  let calcEpoch = 0n;
  for (const assembled of perPortfolio) {
    calcEpoch += assembled.view.calcEpoch;
  }
  calcEpoch += BigInt(portfolios.length);

  return {
    asOfDate,
    baseCurrency,
    closedPositions,
    calcEpoch,
    portfolioCount: portfolios.length,
  };
}

/**
 * The latest `tradeDate` among a merged position's (already ascending) sale
 * lots.
 *
 * **The fallback is reachable** (`security-transfer`): a position closed only by a transfer out has an entry from
 * `computeClosedPositions` but no sale lot, so it reads `0000-01-01` and sorts
 * **last** in the combined list rather than by the date it closed. Accepted
 * (ST-10): ordering it exactly needs a non-wire ordering field on
 * {@link ValuedClosedPosition}, the boundary the closed-positions cycle kept
 * out on purpose (see `assembleClosedPositions`' CP-11 comment). The
 * per-portfolio view is unaffected — it orders on the domain's own
 * `lastDisposalDate`, which does count the transfer.
 */
function lastDisposalOf(position: ValuedClosedPosition): IsoDate {
  const lots = position.realizedGains;
  return lots.length === 0 ? ("0000-01-01" as IsoDate) : lots[lots.length - 1]!.tradeDate;
}
