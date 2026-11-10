import { Decimal } from "@kerdial/core-decimal";
import {
  classifyFlows,
  computeTwr,
  computeXirr,
  DegenerateSubPeriodError,
  summarizeProvenance,
  type IsoDate,
  type ProvenanceSummary,
  type ProvenanceSummaryLeaf,
  type ReturnUnavailableCode,
  type TransactionKind,
  type TwrFlow,
  type TwrResult,
  type Valuation,
  type XirrFlow,
  type XirrResult,
} from "@kerdial/core-domain";
import { listPortfolios } from "@kerdial/ledger";
import { tenant, transaction, withTenant, type Db, type Tx } from "@kerdial/platform-db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { mapWithConcurrency } from "./concurrency.js";
import {
  mapFxRateSourceToFlags,
  valueHoldingsAsOf,
  valueHoldingsForTenant,
  type ValuedPortfolioHoldings,
} from "./holdings-valuation.js";
import {
  materializePortfolioValuations,
  type PortfolioDailyValuationRecord,
} from "./materialize.js";

/**
 * H2(b) (security review) — mirrors `holdings-valuation.ts`'s own
 * `FAN_OUT_CONCURRENCY` (kept as a separate constant, not shared by import,
 * matching this codebase's "a separately-declared constant of the same
 * value" convention elsewhere — e.g. `portfolios.schema.ts`'s own
 * `RETURN_WINDOW_*` doc comment): the worker-pool width
 * `computeCombinedPortfolioReturns` uses to fan out over a tenant's
 * portfolios for `materializePortfolioValuations`. Since the ADR-0008 split, each
 * call is up to two short `withTenant` transactions per guarded attempt (a
 * read, then — after the CPU-heavy compute step, outside any transaction —
 * a write), never both open at once (`materialize.ts`'s own header) — the
 * peak concurrent pooled-connection count this constant bounds is unchanged
 * (at most one connection held per fanned-out call at any instant), only the
 * total number of short-lived acquisitions per call went up.
 */
const FAN_OUT_CONCURRENCY = 4;

/**
 * `computePortfolioReturns` / `computeCombinedPortfolioReturns` — T-39. Backs
 * `GET /portfolios/:id/performance?from=&to=` and its tenant-wide combined
 * counterpart, `GET /portfolios/overview`'s TWR/MWR figures.
 *
 * The daily valuation series feeding `computeTwr` always comes from
 * `materializePortfolioValuations` (T-30) — this module never re-derives or
 * caches that series itself, so the calc-epoch-guarded lazy-materialise-on-
 * read race fix (`valuation/materialize.ts`'s own header) is exercised
 * exactly once, in exactly one place.
 *
 * The `return` figure is always the `{ twr, mwr }` labelled pair (FR-33) — see {@link PortfolioReturns} — computed
 * by `core/domain`'s two deliberately code-disjoint engines (`computeTwr`,
 * T-26; `computeXirr`, T-27), never derived from one another.
 */

/**
 * Mirrors `core/domain/twr.ts`'s `TwrResult` but wrapped so a degenerate
 * range (an empty series, a zero-invested-base sub-period) is an explicit,
 * labelled `available: false` outcome rather than a thrown exception
 * reaching the API boundary — the same "never a bare/fabricated number,
 * always an explicit reason" stance `XirrResult` already takes for MWR.
 */
export type TwrOutcome = ({ readonly available: true } & TwrResult) | TwrUnavailable;

interface TwrUnavailable {
  readonly available: false;
  /** See `ReturnUnavailableCode`. */
  readonly code: ReturnUnavailableCode;
  readonly reason: string;
}

export interface PortfolioReturns {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly twr: TwrOutcome;
  readonly mwr: XirrResult;
  /**
   * AR-24 (ADR-0010) — one summary for the pair, deliberately:
   * TWR and MWR are computed from the identical inputs (the valuation
   * series and the external flows), so two copies could only ever agree or
   * drift. Its leaves are honest about what this stage can see: each flow
   * contributes its stored `fx_rate_source` (flags through the same
   * `mapFxRateSourceToFlags` every holding figure uses — a USER_PINNED flow
   * is `PINNED_FX` on the return, the recorded T-39/T-45 carry-forward);
   * each series point contributes its valuation date to the observation
   * range and to `leafCount`. What the series points CANNOT yet contribute
   * is their own price provenance — `portfolio_daily_valuation` stores no
   * per-row provenance until AR-10's `input_digest` (Stage 6), so
   * `manualInputCount` counts flow-side inputs only until then. Recorded
   * here rather than silently under-reported as a property of the data.
   */
  readonly provenance: ProvenanceSummary;
}

interface LoadedFlows {
  readonly twrFlows: readonly TwrFlow[];
  readonly xirrFlows: readonly XirrFlow[];
  /** AR-24: one provenance leaf per flow, from its stored `fx_rate_source` (FR-57's pinned fact, never re-resolved). */
  readonly flowLeaves: readonly ProvenanceSummaryLeaf[];
}

/**
 * The kinds `classifyFlows` (T-21) returns `EXTERNAL` for: deposits,
 * withdrawals, and the two legs of a security transfer (FR-567/FR-568,
 * OD-10 (a)) — a `TRANSFER_OUT` is withdrawal-shaped for its
 * own portfolio, a `TRANSFER_IN` deposit-shaped, each at its own stored market
 * value.
 *
 * **One constant for both loaders**, {@link loadExternalFlows} (TWR/XIRR) and
 * {@link loadNetFlowsByDate} (the invested-capital line): "the same selection"
 * used to be two hand-kept `inArray` lists that agreed by convention; now it
 * is one value, so the invested line cannot be drawn from a different set of
 * flows than the TWR sub-periods split on.
 */
export const EXTERNAL_FLOW_KINDS = [
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER_IN",
  "TRANSFER_OUT",
] as const satisfies readonly TransactionKind[];

/** Money (or value) entering the portfolio — the positive-signed half of {@link EXTERNAL_FLOW_KINDS}. */
function isInflowKind(kind: TransactionKind): boolean {
  return kind === "DEPOSIT" || kind === "TRANSFER_IN";
}

/**
 * Every {@link EXTERNAL_FLOW_KINDS} row in `[fromDate, toDate]`, projected
 * into both engines' own sign conventions (`twr.ts`'s "deposit positive,
 * withdrawal negative" vs. `xirr.ts`'s inverse — see each engine's own
 * header). Amounts are converted to the base currency via the transaction's
 * own stored, never-re-resolved `fx_rate` (FR-57) — for a transfer leg that
 * is the stored market value, never the carried PMP cost (AC-451).
 */
async function loadExternalFlows(
  tx: Tx,
  params: { tenantId: string; portfolioId: string; fromDate: IsoDate; toDate: IsoDate },
): Promise<LoadedFlows> {
  const { tenantId, portfolioId, fromDate, toDate } = params;
  const rows = await tx
    .select({
      kind: transaction.kind,
      tradeDate: transaction.tradeDate,
      grossAmount: transaction.grossAmount,
      fxRate: transaction.fxRate,
      fxRateSource: transaction.fxRateSource,
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.portfolioId, portfolioId),
        inArray(transaction.kind, EXTERNAL_FLOW_KINDS),
        gte(transaction.tradeDate, fromDate),
        lte(transaction.tradeDate, toDate),
      ),
    );

  const twrFlows: TwrFlow[] = [];
  const xirrFlows: XirrFlow[] = [];
  const flowLeaves: ProvenanceSummaryLeaf[] = [];
  for (const row of rows) {
    const flowClass = classifyFlows({ kind: row.kind as TransactionKind });
    const amountBase = row.grossAmount.times(row.fxRate);
    const date = row.tradeDate as IsoDate;
    const isInflow = isInflowKind(row.kind as TransactionKind);
    twrFlows.push({ date, amount: isInflow ? amountBase : amountBase.negated(), flowClass });
    xirrFlows.push({ date, amount: isInflow ? amountBase.negated() : amountBase });
    flowLeaves.push({
      derivedFrom: mapFxRateSourceToFlags(row.fxRateSource),
      fxSource: row.fxRateSource,
    });
  }
  return { twrFlows, xirrFlows, flowLeaves };
}

/**
 * AR-24: the return pair's summary over exactly the inputs both engines
 * consumed — see {@link PortfolioReturns.provenance} for what each leaf
 * kind contributes and the recorded AR-10 limitation.
 */
function returnsProvenance(
  series: readonly SeriesPointProvenance[],
  flowLeaves: readonly ProvenanceSummaryLeaf[],
): ProvenanceSummary {
  const seriesLeaves: ProvenanceSummaryLeaf[] = series.map((point) => ({
    derivedFrom: [],
    priceAsOf: point.date,
    // portfolio-cash — a point whose cash left a currency unconverted
    // is a partial value: its leaf makes the summary `complete: false`.
    ...(point.unvalued ? { unvalued: true as const } : {}),
  }));
  return summarizeProvenance([...seriesLeaves, ...flowLeaves]);
}

/** What one series point contributes to {@link returnsProvenance}: its date, and whether its value is partial. */
interface SeriesPointProvenance {
  readonly date: IsoDate;
  /** Some cash currency had no rate on this date (`cash_unconverted` non-empty, PC-L2). */
  readonly unvalued: boolean;
}

/** Per-date provenance of a series: a date is unvalued when any row behind it is (the combined paths inherit per row). */
function seriesProvenance(
  rowSets: readonly (readonly PortfolioDailyValuationRecord[])[],
): SeriesPointProvenance[] {
  const unvaluedByDate = new Map<IsoDate, boolean>();
  for (const rows of rowSets) {
    for (const row of rows) {
      const date = row.valuationDate as IsoDate;
      unvaluedByDate.set(
        date,
        (unvaluedByDate.get(date) ?? false) || row.cashUnconverted.length > 0,
      );
    }
  }
  return [...unvaluedByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, unvalued]) => ({ date, unvalued }));
}

/** @internal Exported for `performance.twr-outcome.test.ts` (the unavailable-reason code mapping). */
export function twrOutcomeFrom(
  series: readonly Valuation[],
  flows: readonly TwrFlow[],
): TwrOutcome {
  try {
    return { available: true, ...computeTwr(series, flows) };
  } catch (err) {
    return {
      available: false,
      code: err instanceof DegenerateSubPeriodError ? "ZERO_INVESTED_BASE" : "INSUFFICIENT_DATA",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ComputePortfolioReturnsParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly fromDate: IsoDate;
  readonly toDate: IsoDate;
  /**
   * H2(d) (security review) — an already-in-flight (or already-resolved)
   * `valueHoldingsAsOf` result for this same `(portfolioId, toDate)`, when
   * the caller already needs one anyway (`PortfoliosController#overview`
   * fetches holdings for the response body *and* this function fetches them
   * again internally for the MWR terminal value — the same replay, run
   * twice, per request). Passing the caller's own (still in-flight) promise
   * through means both callers `await` the *same* underlying call — it
   * resolves exactly once — rather than this function starting a second,
   * redundant one. Optional: every other caller (`computeCombinedPortfolioReturns`'s
   * internal use, this module's own integration tests) is unaffected and
   * keeps fetching it itself.
   */
  readonly terminalHoldings?: Promise<ValuedPortfolioHoldings> | ValuedPortfolioHoldings;
}

/**
 * TWR/MWR for one portfolio over `[fromDate, toDate]`. The MWR terminal
 * value is the portfolio's **live** holdings total as of `toDate` (via
 * {@link valueHoldingsAsOf} — the same replay path `holdings-valuation.ts`
 * uses, so overview's point-in-time total and its own MWR terminal can never
 * silently disagree), never the materialised series' own last (pre-flow)
 * point.
 */
export async function computePortfolioReturns(
  db: Db,
  params: ComputePortfolioReturnsParams,
): Promise<PortfolioReturns> {
  const { tenantId, portfolioId, fromDate, toDate } = params;

  // T-30's own guarded lazy-materialise-on-read path — never reimplemented here.
  const series = await materializePortfolioValuations(db, {
    tenantId,
    portfolioId,
    fromDate,
    toDate,
  });
  const valuationSeries: Valuation[] = series
    .map((row) => ({ date: row.valuationDate as IsoDate, value: row.totalValueBase }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const { twrFlows, xirrFlows, flowLeaves } = await withTenant(db, tenantId, (tx) =>
    loadExternalFlows(tx, { tenantId, portfolioId, fromDate, toDate }),
  );

  const twr = twrOutcomeFrom(valuationSeries, twrFlows);

  const opening = valuationSeries[0]?.value ?? new Decimal(0);
  // H2(d): reuse the caller's own in-flight fetch when one was passed —
  // never re-fetch what the caller already needs anyway.
  const terminalHoldings =
    params.terminalHoldings !== undefined
      ? await params.terminalHoldings
      : await valueHoldingsAsOf(db, { tenantId, portfolioId, asOfDate: toDate });
  const flowsForXirr: XirrFlow[] = [{ date: fromDate, amount: opening.negated() }, ...xirrFlows];
  const mwr = computeXirr(flowsForXirr, {
    date: toDate,
    value: terminalHoldings.totalValue.amount,
  });

  return {
    from: fromDate,
    to: toDate,
    twr,
    mwr,
    provenance: returnsProvenance(seriesProvenance([series]), flowLeaves),
  };
}

export interface ComputeCombinedPortfolioReturnsParams {
  readonly tenantId: string;
  readonly fromDate: IsoDate;
  readonly toDate: IsoDate;
  /** H2(d) (security review) — mirrors {@link ComputePortfolioReturnsParams.terminalHoldings}: an already-in-flight (or resolved) `valueHoldingsForTenant` result for this same `(tenantId, toDate)`, so `PortfoliosController#overviewCombined` (which needs one for its own response body) and this function's own MWR terminal never redundantly fetch it twice. */
  readonly terminalHoldings?: Promise<ValuedPortfolioHoldings> | ValuedPortfolioHoldings;
}

/**
 * The combined, tenant-wide TWR/MWR (added 2026-07-21 by user decision,
 * T-39): computed from the **union** of every portfolio's
 * daily valuation series (summed per date) and the **union** of every
 * portfolio's external cash flows — never by averaging each portfolio's own
 * TWR/MWR. Averaging per-portfolio returns is demonstrably wrong whenever
 * the portfolios' sizes or flow timing differ (see
 * `performance.combined.test.ts`'s fixture, which constructs exactly such a
 * case) — this function never takes that shortcut.
 */
export async function computeCombinedPortfolioReturns(
  db: Db,
  params: ComputeCombinedPortfolioReturnsParams,
): Promise<PortfolioReturns> {
  const { tenantId, fromDate, toDate } = params;
  const portfolios = await listPortfolios(db, tenantId);

  if (portfolios.length === 0) {
    const reason = "This tenant owns no portfolios yet, so a combined return cannot be computed.";
    return {
      from: fromDate,
      to: toDate,
      twr: { available: false, code: "NO_PORTFOLIO", reason },
      mwr: { converged: false, code: "NO_PORTFOLIO", reason },
      provenance: summarizeProvenance([]),
    };
  }

  // H2(b) (security review): bounded fan-out, not a bare
  // `Promise.all(portfolios.map(...))` — see `FAN_OUT_CONCURRENCY`'s own doc
  // comment (each call now opens up to two short transactions,
  // never simultaneously, so the peak-connections-per-call bound this fan-out
  // limits is unchanged). `loadExternalFlows` below shares one transaction
  // across every portfolio instead (a plain `Promise.all` over queries on the
  // *same* connection, not a fan-out of connections, so it is not this
  // finding's concern).
  const perPortfolioSeries = await mapWithConcurrency(portfolios, FAN_OUT_CONCURRENCY, (p) =>
    materializePortfolioValuations(db, { tenantId, portfolioId: p.id, fromDate, toDate }),
  );
  const perPortfolioFlows = await withTenant(db, tenantId, (tx) =>
    Promise.all(
      portfolios.map((p) =>
        loadExternalFlows(tx, { tenantId, portfolioId: p.id, fromDate, toDate }),
      ),
    ),
  );

  const combinedByDate = new Map<IsoDate, Decimal>();
  for (const series of perPortfolioSeries) {
    for (const row of series) {
      const date = row.valuationDate as IsoDate;
      combinedByDate.set(
        date,
        (combinedByDate.get(date) ?? new Decimal(0)).plus(row.totalValueBase),
      );
    }
  }
  const combinedSeries: Valuation[] = [...combinedByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));

  const combinedTwrFlows = perPortfolioFlows.flatMap((f) => f.twrFlows);
  const combinedXirrFlows = perPortfolioFlows.flatMap((f) => f.xirrFlows);
  const combinedFlowLeaves = perPortfolioFlows.flatMap((f) => f.flowLeaves);

  const twr = twrOutcomeFrom(combinedSeries, combinedTwrFlows);

  const opening = combinedSeries[0]?.value ?? new Decimal(0);
  // H2(d): reuse the caller's own in-flight fetch when one was passed.
  const terminalHoldings =
    params.terminalHoldings !== undefined
      ? await params.terminalHoldings
      : await valueHoldingsForTenant(db, { tenantId, asOfDate: toDate });
  const flowsForXirr: XirrFlow[] = [
    { date: fromDate, amount: opening.negated() },
    ...combinedXirrFlows,
  ];
  const mwr = computeXirr(flowsForXirr, {
    date: toDate,
    value: terminalHoldings.totalValue.amount,
  });

  return {
    from: fromDate,
    to: toDate,
    twr,
    mwr,
    provenance: returnsProvenance(seriesProvenance(perPortfolioSeries), combinedFlowLeaves),
  };
}

/**
 * `computePortfolioValueSeries` / `computeCombinedPortfolioValueSeries` —
 * FR-262 (the wire half of FR-36's chart). The daily portfolio
 * value series, per portfolio and combined, in the tenant's ledger base.
 *
 * ## Deliberately a projection, not a computation path
 *
 * The series IS `materializePortfolioValuations`' output — the same
 * epoch-guarded, lazily-materialised `portfolio_daily_valuation` rows
 * `computeTwr` already consumes, mapped to `{ date, value }` and nothing
 * else. That settles three open questions at once:
 *
 * - **Cost**: `GET /portfolios/:id/performance` already materialises this
 *   exact range on every read and discards everything but two scalars —
 *   serving the points costs serialisation, not a second engine pass. The
 *   window is bounded by the same `resolveReturnWindow` caps (25-year span,
 *   epoch floor, no future `to`), so the worst case is ~9,100 daily points,
 *   accepted for a self-hosted single-user deployment rather than
 *   downsampled: a chart client can decimate; a server cannot un-decimate.
 * - **Agreement**: the endpoint value equals the overview's scalar total for
 *   the same date because both are `valuePortfolio` over the same inputs —
 *   asserted in the integration suite, since two reads disagreeing about
 *   the same portfolio is worse than one read missing.
 * - **Gaps**: none are interpolated because none can exist — materialisation
 *   is all-or-nothing over the range (an unpriceable holding fails the whole
 *   read loud; a cash currency with no rate is excluded
 *   and makes `provenance.complete` false instead, portfolio-cash PC-L2), and
 *   a date before the portfolio's first transaction carries the **modelled
 *   zero** N4 already defines (no holdings, no cash → value 0, synthesised,
 *   market-data-independent), not a fabricated point.
 *
 * The series-level `provenance` is the same coarse `ProvenanceSummary` the
 * TWR/MWR pair carries, with the same recorded AR-10 limitation: the points
 * contribute their dates and count, but per-point price provenance does not
 * exist until `input_digest` (Stage 6).
 */
export interface PortfolioValueSeries {
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** The tenant's ledger base currency (`tenant.base_currency`, ADR-0002) — every point's denomination. */
  readonly baseCurrency: string;
  /**
   * Dense daily points over `[from, to]`; dates before the first trade carry
   * the modelled 0. `netContributions` is the cumulative net external
   * capital as of the same start-of-day instant as `value` — see
   * {@link cumulativeNetContributions}.
   */
  readonly points: readonly {
    readonly date: IsoDate;
    /** The portfolio's total value — holdings and cash — start-of-day, pre-flow (FR-262, PC-L1). */
    readonly value: Decimal;
    /**
     * Σ inflows − Σ outflows ({@link EXTERNAL_FLOW_KINDS}: deposits and
     * transfers in, less withdrawals and transfers out), base-denominated,
     * over every external flow dated **strictly before** `date` — since
     * inception, not since `from` (IC-D2). The same pre-flow
     * instant as `value`, so a deposit on D leaves both figures of point D
     * unchanged and moves both on D+1: the two lines never cross on the wrong
     * day. A security transfer steps each side's own series the same way,
     * and a linked pair nets to zero only on the combined series (OD-10 (a)).
     */
    readonly netContributions: Decimal;
  }[];
  readonly provenance: ProvenanceSummary;
}

/**
 * IC-D3 — every {@link EXTERNAL_FLOW_KINDS} row of the
 * portfolio (or, with no `portfolioId`, of the whole tenant — the combined
 * series' union) dated on or before `toDate`, netted per trade date in the
 * base currency.
 *
 * The same selection and the same FX as {@link loadExternalFlows}, by sharing
 * the constant — `gross_amount × fx_rate` with the
 * transaction's own stored, never-re-resolved rate (FR-57) — so the invested
 * line is drawn from exactly the flows the TWR sub-periods split on. No lower
 * bound: capital invested before the window still counts at the window's
 * start (the reader asked "how much have I put in", not "how much in this
 * range").
 */
async function loadNetFlowsByDate(
  db: Db,
  params: { tenantId: string; portfolioId?: string; toDate: IsoDate },
): Promise<ReadonlyMap<IsoDate, Decimal>> {
  const { tenantId, portfolioId, toDate } = params;
  // Inside the tenant's RLS context, like every other `transaction` read
  // here — on the bare connection the policy answers with no rows at all.
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        kind: transaction.kind,
        tradeDate: transaction.tradeDate,
        grossAmount: transaction.grossAmount,
        fxRate: transaction.fxRate,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          ...(portfolioId === undefined ? [] : [eq(transaction.portfolioId, portfolioId)]),
          inArray(transaction.kind, EXTERNAL_FLOW_KINDS),
          lte(transaction.tradeDate, toDate),
        ),
      ),
  );

  const byDate = new Map<IsoDate, Decimal>();
  for (const row of rows) {
    const amountBase = row.grossAmount.times(row.fxRate);
    const signed = isInflowKind(row.kind as TransactionKind) ? amountBase : amountBase.negated();
    const date = row.tradeDate as IsoDate;
    byDate.set(date, (byDate.get(date) ?? new Decimal(0)).plus(signed));
  }
  return byDate;
}

/**
 * The cumulative net contributions for each date of `dates` (ascending):
 * the sum of every flow dated **strictly before** that date. Pure, so the
 * pre-flow boundary is one loop, not a query.
 */
function cumulativeNetContributions(
  flowsByDate: ReadonlyMap<IsoDate, Decimal>,
  dates: readonly IsoDate[],
): readonly Decimal[] {
  const flowDates = [...flowsByDate.keys()].sort((a, b) => a.localeCompare(b));
  let cursor = 0;
  let running = new Decimal(0);
  const out: Decimal[] = [];
  for (const date of dates) {
    while (cursor < flowDates.length && (flowDates[cursor] as IsoDate) < date) {
      running = running.plus(flowsByDate.get(flowDates[cursor] as IsoDate) ?? 0);
      cursor += 1;
    }
    out.push(running);
  }
  return out;
}

function withNetContributions(
  points: readonly { readonly date: IsoDate; readonly value: Decimal }[],
  flowsByDate: ReadonlyMap<IsoDate, Decimal>,
): PortfolioValueSeries["points"][number][] {
  const cumulative = cumulativeNetContributions(
    flowsByDate,
    points.map((point) => point.date),
  );
  return points.map((point, index) => ({
    ...point,
    netContributions: cumulative[index] ?? new Decimal(0),
  }));
}

async function tenantBaseCurrency(db: Db, tenantId: string): Promise<string> {
  const [row] = await db
    .select({ baseCurrency: tenant.baseCurrency })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!row) throw new Error(`tenantBaseCurrency: no tenant row for ${tenantId}`);
  return row.baseCurrency;
}

export async function computePortfolioValueSeries(
  db: Db,
  params: {
    readonly tenantId: string;
    readonly portfolioId: string;
    readonly fromDate: IsoDate;
    readonly toDate: IsoDate;
  },
): Promise<PortfolioValueSeries> {
  const { tenantId, portfolioId, fromDate, toDate } = params;
  const [baseCurrency, rows, flowsByDate] = await Promise.all([
    tenantBaseCurrency(db, tenantId),
    materializePortfolioValuations(db, { tenantId, portfolioId, fromDate, toDate }),
    loadNetFlowsByDate(db, { tenantId, portfolioId, toDate }),
  ]);
  const points = withNetContributions(
    rows
      .map((row) => ({ date: row.valuationDate as IsoDate, value: row.totalValueBase }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    flowsByDate,
  );
  return {
    from: fromDate,
    to: toDate,
    baseCurrency,
    points,
    provenance: returnsProvenance(seriesProvenance([rows]), []),
  };
}

/**
 * The combined, tenant-wide series: the **union** of every portfolio's daily
 * series, summed per date — exactly `computeCombinedPortfolioReturns`' own
 * combination, for the same reason (a per-portfolio sum is the only shape
 * that agrees with the combined overview total). A portfolio whose first
 * trade postdates a date contributes its modelled zero there, so the sum is
 * defined wherever any portfolio has history.
 */
export async function computeCombinedPortfolioValueSeries(
  db: Db,
  params: { readonly tenantId: string; readonly fromDate: IsoDate; readonly toDate: IsoDate },
): Promise<PortfolioValueSeries> {
  const { tenantId, fromDate, toDate } = params;
  const [baseCurrency, portfolios, flowsByDate] = await Promise.all([
    tenantBaseCurrency(db, tenantId),
    listPortfolios(db, tenantId),
    // Tenant-wide, no portfolio filter: the sum over every portfolio's
    // flows is one statement, and it agrees with the per-portfolio series
    // by construction (IC-D3).
    loadNetFlowsByDate(db, { tenantId, toDate }),
  ]);

  const perPortfolioSeries = await mapWithConcurrency(portfolios, FAN_OUT_CONCURRENCY, (p) =>
    materializePortfolioValuations(db, { tenantId, portfolioId: p.id, fromDate, toDate }),
  );

  const combinedByDate = new Map<IsoDate, Decimal>();
  for (const series of perPortfolioSeries) {
    for (const row of series) {
      const date = row.valuationDate as IsoDate;
      combinedByDate.set(
        date,
        (combinedByDate.get(date) ?? new Decimal(0)).plus(row.totalValueBase),
      );
    }
  }
  const points = withNetContributions(
    [...combinedByDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value })),
    flowsByDate,
  );

  return {
    from: fromDate,
    to: toDate,
    baseCurrency,
    points,
    provenance: returnsProvenance(seriesProvenance(perPortfolioSeries), []),
  };
}
