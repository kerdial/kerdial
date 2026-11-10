import { Decimal } from "@kerdial/core-decimal";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import { tenant, withTenant, type Db, type TenantId } from "@kerdial/platform-db";
import { eq, sql } from "drizzle-orm";

/**
 * `ledger`'s dividend **aggregate** read service —
 * FR-265/FR-267/
 * FR-268/FR-270/FR-274–FR-277/FR-279/FR-284, backing `GET /dividends/summary`
 * (DV1). LD-3(b) locked a server-side aggregate over the client-side scan
 * `web/src/lib/income-totals.ts` performs today: that scan pages
 * `GET /transactions` to exhaustion and reports `truncated` when it runs out
 * of pages, so its dividend figure is complete only by luck of the window's
 * size. This endpoint answers the same question in **one bounded statement**,
 * so completeness is structural rather than reported.
 *
 * ## Why `ledger` and not `valuation` (DV3)
 *
 * This read resolves no price, resolves no FX rate, reads no `holding_state`,
 * materialises nothing, and fans out to nothing — none of the properties that
 * define `valuation` (whose `valuation-no-market-ports` depcruise rule exists
 * to keep "recomputation never re-fetches an FX rate" a compile-time fact).
 * `ledger` already owns exactly this shape of read: `transaction-read-service.ts`
 * (filtered, tenant-scoped `transaction` reads), `materialization.ts` (the one
 * other `GROUP BY` over `transaction_posting`), and `tenant-holdings-service.ts`
 * (a tenant-scoped read that `innerJoin`s `instrument` and is called straight
 * from a controller).
 *
 * ## Why `transaction_posting.amount_base`, and never `gross_amount × fx_rate` (DV2, RD2)
 *
 * The two are arithmetically the same expression of the same two stored
 * numbers — the posting expander's `toBase = (native, rate) => native.times(rate)`
 * (`posting-expander.ts`). The choice is decided on three grounds this codebase
 * already asserts about itself, and it is recorded **here**,
 * because the tempting shortcut (a `sum(gross_amount * fx_rate)` that
 * avoids the join) would still pass every known-answer test in
 * `dividend-summary-service.integration.test.ts`:
 *
 * 1. **`flow_class` is the designated single source of "what kind of flow is
 *    this?"** (*"Every downstream metric consumes
 *    `flow_class`; none re-implements the 'is this an external flow?'
 *    question"*). A per-instrument dividend total is a downstream metric.
 *    Reading the postings is what makes **FR-267's DRIP exclusion structural**:
 *    a DRIP's legs classify `INTERNAL` (`flow-class.ts`) and can never enter an
 *    `INCOME` sum — the exclusion is a property of the stored classification,
 *    not a `kind <> 'DRIP'` predicate a future reader could delete.
 * 2. **`amount_base` is declared the authoritative figure, twice, in the module
 *    that produces it**, and `posting-expander.ts` is deliberately built so that
 *    *"this file contains no second expression producing a base amount"*. A SQL
 *    aggregate computing `gross_amount * fx_rate` would be exactly such a second
 *    expression, in a second language, outside the module whose invariant that
 *    is — and one that would not have moved with the expander's base-amount rule
 *    when cross-currency settlement and then cost components moved it.
 * 3. **It reads the ledger the way the ledger reads itself.**
 *    `materialization.ts` already sums postings (`sum(amount_native)` grouped by
 *    `(cash_account_id, currency)`) to produce `cash_balance`. This is the same
 *    class of read, one column over.
 *
 * ## Tenancy
 *
 * Every statement runs inside {@link withTenant} — `transaction` and
 * `transaction_posting` are both `FORCE ROW LEVEL SECURITY`
 * (`0007_roles-grants-rls.sql`), so RLS is the enforcement (AC33/AC35) and the
 * explicit `p.tenant_id = …` predicate is defence in depth, exactly as
 * `transaction-read-service.ts` and `tenant-holdings-service.ts` document. No
 * caller writes a `WHERE tenant_id = ?` of its own.
 */

/**
 * DV6 — the one response dimension that can grow without bound, capped
 * by **refusing** rather than truncating: a truncated `instruments[]` would make
 * {@link DividendSummary.total} disagree with the rows shown, which is G5's
 * exact prohibition and the reason FR-270 can be a structural fact here rather
 * than a claim. 1,000 is the same number, the same shape and the same reasoning
 * as `MAX_HOLDINGS_PER_VIEW` (`valuation/src/holdings-valuation.ts`) —
 * comfortably beyond any real phase-1 tenant while bounding what Fastify has to
 * serialise.
 *
 * The time dimensions carry no cap, and that is measured rather than forgotten:
 * a bucket exists only where a counted DIVIDEND falls, so
 * `|years| ≤ |months| ≤ |DIVIDEND rows| ≤` NFR-20's 5,000, and in calendar terms
 * `|months| ≤ 12 × (span in years)`. A cap there could not bind on any data this
 * product can hold, and an unbindable cap reads as a guarantee it never provides.
 *
 * @public mirrored in `web/src/lib/api-limits.ts` and drift-guarded there (the `MAX_HOLDINGS_PER_VIEW` precedent), a cross-workspace deep import the unused-export gate does not scan.
 */
export const MAX_DIVIDEND_INSTRUMENTS_PER_VIEW = 1000;

/**
 * Thrown by {@link summarizeDividends} when the requested scope holds more than
 * {@link MAX_DIVIDEND_INSTRUMENTS_PER_VIEW} dividend-paying instruments (DV6).
 * Mapped to `422 DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE` by the API layer — never a
 * truncated array, never a partial body.
 */
export class TooManyDividendInstrumentsError extends Error {
  readonly count: number;
  readonly limit: number;

  constructor(count: number, limit: number = MAX_DIVIDEND_INSTRUMENTS_PER_VIEW) {
    super(
      `This dividend summary would return ${count} instruments, exceeding the ${limit}-instrument cap.`,
    );
    this.name = "TooManyDividendInstrumentsError";
    this.count = count;
    this.limit = limit;
  }
}

/**
 * DV11 — the ambiguous-TAX-leg refusal.
 *
 * On a DIVIDEND row the only `TAX` posting is its withholding leg, but that is
 * an **application** invariant with no database enforcement:
 * `transaction_dividend_shape` constrains six columns and says nothing about
 * `fee_amount`, and `transaction_settled_principal_has_no_cost` is keyed on
 * `txn_settlement_instrument_id`, not on `kind`. What actually forbids it is the
 * shared create schema's `forbid(data.fee, "fee", …)` and, on the edit path,
 * `TransactionCashLegNotAddableError` — so a row written through the API can
 * never carry one, and a row written **out of band** can. Its cost components
 * would then emit `TAX` postings (`posting-expander.ts`) that this aggregate
 * would conflate with withholding, producing a «Retenue à la source» figure that
 * disagrees with the Activity tab's for the same window.
 *
 * The whole request is refused (`422 DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG`) rather
 * than the leg being summed (a figure that quietly disagrees with another screen)
 * or dropped (a silently-short partial sum, which `income-totals.ts` forbids by
 * name).
 *
 * The database-level closure that would make the shape unstorable — a
 * `transaction_dividend_has_no_cost` CHECK in
 * `transaction_settled_principal_has_no_cost`'s idiom — is not part of
 * this cycle, which writes no migration. This is the read-time half.
 */
export class AmbiguousDividendTaxLegError extends Error {
  readonly instrumentId: string;
  readonly legCount: number;

  constructor(instrumentId: string, legCount: number) {
    super(
      `Instrument ${instrumentId} has ${legCount} DIVIDEND posting(s) whose transaction carries a fee_amount: ` +
        `a dividend's only TAX leg must be its withholding, so this summary cannot tell withholding from transaction cost.`,
    );
    this.name = "AmbiguousDividendTaxLegError";
    this.instrumentId = instrumentId;
    this.legCount = legCount;
  }
}

/**
 * AR-5 (ADR-0002) — the base-currency provenance guard.
 *
 * Since AR-5 every `transaction_posting` row carries its own `base_currency`,
 * filled from `tenant.base_currency` by `trg_transaction_posting_base_currency_fill`
 * and frozen by `trg_tenant_base_currency_immutable` once the tenant has any
 * transaction. So this is unreachable on trigger-valid data — which is the
 * point: AR-5 exists so a mislabelled fact is *detectable*, and a
 * reporting-currency total that cannot say which currency it is in is the exact
 * bug ADR-0002 was written about.
 *
 * Deliberately **absent from the error table**: it maps to no 4xx, because it
 * describes corrupt stored state rather than an unservable request, and it
 * surfaces as a 500. Refusing is the requirement; a number in an unknown unit is
 * the thing that must not be returned.
 */
export class DividendBaseCurrencyMismatchError extends Error {
  readonly expected: string;
  readonly found: string;

  constructor(expected: string, found: string) {
    super(
      `A DIVIDEND posting reports base_currency ${found} where the tenant's ledger base is ${expected}: ` +
        `refusing to report a figure in an unknown unit (AR-5).`,
    );
    this.name = "DividendBaseCurrencyMismatchError";
    this.expected = expected;
    this.found = found;
  }
}

/**
 * Test-only escape hatch for {@link MAX_DIVIDEND_INSTRUMENTS_PER_VIEW} — mirrors
 * `holdings-valuation.ts`'s own `ResponseCapOverrides` (and, before it,
 * `upsertManualPricePoint`'s `maxRowsPerTenant`): a real 1,000-instrument
 * fixture is impractical to seed, so the cap is provable without one.
 */
interface DividendResponseCapOverrides {
  readonly maxInstruments?: number;
}

/** One instrument's dividend history within the requested scope. */
export interface DividendInstrumentSummary {
  readonly instrumentId: string;
  /**
   * `instrument.symbol` — the local ticker, `null` when the
   * instrument has none. Read in the same statement as `displayName`, for the
   * same reason: the Dividendes screen's payer tile shows the code, and the
   * alternative is a per-row instrument read the screen has no budget for.
   */
  readonly symbol: string | null;
  /**
   * `instrument-icons` IK-10: a `LEFT JOIN`ed presence flag
   * on `instrument_icon`, never the bytes — `holdings-valuation.ts`'s exact
   * construction, so the payer tile renders the real icon when one exists
   * and the monogram otherwise, with no per-row probe.
   */
  readonly hasIcon: boolean;
  /**
   * Embedded rather than resolved client-side — `HoldingResponse.displayName`'s
   * precedent (OD-9/UR-8) and, here, the only workable source: an instrument the
   * tenant has fully sold still has dividend history and has no holdings row at
   * all, so no holdings-shaped response could supply the name.
   */
  readonly displayName: string;
  readonly grossBase: Decimal;
  /** A positive magnitude — see {@link DividendPeriodSummary.withholdingBase}. */
  readonly withholdingBase: Decimal;
  /**
   * `count(distinct transaction_id)` over the INCOME legs. It distinguishes one
   * large dividend from four small ones without a second read, and it makes
   * AC-282's DRIP-exclusion proof observable a second, independent way: adding
   * or removing the linked DRIP must move neither `grossBase` **nor** this.
   */
  readonly paymentCount: number;
}

/** One `YYYY` or `YYYY-MM` bucket (FR-274–FR-277). */
export interface DividendPeriodSummary {
  /** `to_char(trade_date, 'YYYY')` or `to_char(trade_date, 'YYYY-MM')` — the exact bucket key, produced once, in SQL. */
  readonly period: string;
  readonly grossBase: Decimal;
  /**
   * A **positive magnitude**. The ledger stores the withholding leg's
   * `amount_base` negative (`posting-expander.ts`: `native =
   * withholdingAmount.negated()`), and the sign is flipped once, in SQL, so no
   * caller ever negates — matching `IncomeTotals.withholdingEur`'s own
   * documented convention, which is what keeps this screen and Activity's
   * «Retenue à la source» tile directly comparable.
   */
  readonly withholdingBase: Decimal;
}

/** The two figures LD-1 requires to stay independent: never netted, never implicitly decomposed. */
export interface DividendTotals {
  readonly grossBase: Decimal;
  readonly withholdingBase: Decimal;
}

/**
 * {@link summarizeDividends}'s whole answer — both halves of the screen from one
 * snapshot (DV4). `total`, `Σ instruments`, `Σ years` and `Σ months` are four
 * folds of **one** query result under exact `Decimal` addition, so FR-270's "the
 * total is the exact sum of the rows shown" is a structural fact rather than an
 * asserted one.
 */
export interface DividendSummary {
  /** FR-284/LD-4 — the tenant's ledger base (AR-5), the unit of every figure here. Read from `tenant`, not from an aggregate, so it is correct for a tenant with zero dividends too. */
  readonly baseCurrency: CurrencyCode;
  /** Echoed exactly as asked; `null` means unbounded (FR-271's all-time default). Never defaulted to today — the caller labels the two nulls. */
  readonly from: IsoDate | null;
  readonly to: IsoDate | null;
  /** Echoed applied filter; `null` = every portfolio this tenant owns (LD-5). */
  readonly portfolioId: string | null;
  readonly total: DividendTotals;
  /** Ordered `grossBase` descending, ties broken by `instrumentId`, so the first render is not a re-sort. */
  readonly instruments: readonly DividendInstrumentSummary[];
  /** Ordered by `period` ascending. A period with no counted dividend is **absent**, never a zero-valued entry. */
  readonly years: readonly DividendPeriodSummary[];
  readonly months: readonly DividendPeriodSummary[];
}

/** {@link summarizeDividends}'s arguments. */
export interface DividendSummaryParams {
  readonly tenantId: TenantId;
  /** Inclusive `trade_date` lower bound, `YYYY-MM-DD`. Omit for none — FR-271's all-time default is the *absence of a predicate*, not a trailing window. */
  readonly from?: IsoDate;
  /** Inclusive `trade_date` upper bound, `YYYY-MM-DD`. Omit for none; deliberately never defaulted to today. */
  readonly to?: IsoDate;
  /** LD-5 — narrow to one portfolio. An id this tenant does not own matches no rows and yields the empty shape (invisible, not forbidden), the stance `getTransactionById` documents. */
  readonly portfolioId?: string;
  /** DV6 test-only override — see {@link DividendResponseCapOverrides}. */
  readonly responseCapOverrides?: DividendResponseCapOverrides;
}

/**
 * The raw grouped row, one per `(instrument, month)` with at least one counted
 * dividend. Every figure arrives as a **string**: a `sum()` is not a
 * `decimalCol` and does not go through `fromDriver` (the `materialization.ts`
 * idiom), and `postgres`'s driver hands `int8` back as a string too.
 *
 * A `type` alias, not an `interface`: `tx.execute<T>` constrains `T` to
 * `Record<string, unknown>`, and TypeScript grants an implicit index signature
 * to an object-type alias but not to an interface.
 */
type DividendAggregateRow = {
  readonly instrument_id: string;
  readonly display_name: string;
  readonly symbol: string | null;
  readonly has_icon: boolean;
  readonly year: string;
  readonly month: string;
  readonly gross_base: string;
  readonly withholding_base: string;
  readonly payment_count: string;
  readonly base_currency_count: string;
  readonly base_currency: string;
  readonly costed_row_legs: string;
};

const ZERO = new Decimal(0);

interface MutableTotals {
  grossBase: Decimal;
  withholdingBase: Decimal;
}

interface MutableInstrument extends MutableTotals {
  displayName: string;
  symbol: string | null;
  hasIcon: boolean;
  paymentCount: number;
}

/**
 * The tenant-scoped dividend aggregate behind `GET /dividends/summary`
 * (FR-265/FR-279): gross and withholding per instrument, per calendar year and
 * per calendar month, plus the combined total, all from **one** `GROUP BY`
 * statement (DV4).
 *
 * **One statement, three folds — not three statements.** Under READ COMMITTED
 * (the default) each statement in a transaction takes its own snapshot, so three
 * aggregates could observe three different states and the yearly totals would
 * not sum to the per-instrument totals: a figure presented as whole when it is
 * not, which is the exact incompleteness class LD-3(b) exists to eliminate. The
 * `tenant.base_currency` lookup is a second statement and that is harmless — the
 * column is trigger-frozen once the tenant has any transaction, so it cannot
 * move under the aggregate.
 *
 * **The returned shape carries no `calcEpoch`, deliberately** (DV10).
 * The convention is that a response containing derived
 * figures carries one, and the deviation is narrow: `calc_epoch` signals that
 * **lazily materialised** valuation state may lag a write, and
 * `transaction_posting` is not lazily materialised — it is "a write-time
 * projection, never a cache … regenerated wholesale (delete + insert) whenever
 * its parent transaction is written, inside the same DB transaction".
 * There is no window in which this answer can be behind a committed write, so an
 * epoch here would be a freshness claim about a mechanism this read does not use
 * — and routing its query key through the client's `invalidateAndVerifyCalcEpoch`
 * would then spend that retry budget verifying nothing. `GET /transactions`,
 * also a direct read of write-time state, carries none for the same reason.
 * **Do not add one.**
 *
 * The DV6 instrument-count guard is a third statement, and it is outside that
 * argument for the same reason as the currency lookup: it produces no figure,
 * it only decides whether to ask. Its own reasoning — including what a race
 * between the two statements can and cannot do — is written where it lives.
 */
export async function summarizeDividends(
  db: Db,
  params: DividendSummaryParams,
): Promise<DividendSummary> {
  const { tenantId, from, to, portfolioId } = params;
  const maxInstruments =
    params.responseCapOverrides?.maxInstruments ?? MAX_DIVIDEND_INSTRUMENTS_PER_VIEW;

  // Appended only when the corresponding parameter is present: both
  // absent means **no date predicate at all**, which is what makes FR-271's
  // all-time default genuinely all-time. `resolveReturnWindow` is deliberately
  // not reused here — it defaults an absent window to a trailing range and
  // rejects a span wider than 15 years, which is precisely the failure AC-286 is
  // written to catch.
  const portfolioPredicate =
    portfolioId === undefined ? sql.empty() : sql` and t.portfolio_id = ${portfolioId}`;
  const fromPredicate = from === undefined ? sql.empty() : sql` and t.trade_date >= ${from}`;
  const toPredicate = to === undefined ? sql.empty() : sql` and t.trade_date <= ${to}`;

  return withTenant(db, tenantId, async (tx) => {
    // AR-5/FR-284: the unit comes from `tenant`, never from `min(base_currency)`
    // over the aggregate — which would be `null` for a tenant with no dividends
    // at all, i.e. exactly the case the empty response still has to label.
    // `tenant` carries no RLS (it is the tenancy root) and `app_web` holds
    // column-level SELECT on exactly `tenant(id, base_currency)` (migration
    // `0024`), which is the grant `GET /auth/me` already relies on.
    const [tenantRow] = await tx
      .select({ baseCurrency: tenant.baseCurrency })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (!tenantRow) {
      throw new Error(`summarizeDividends: no tenant row for ${tenantId}`);
    }
    const baseCurrency = tenantRow.baseCurrency as CurrencyCode;

    // The row set, written out rather than re-derived, and **shared by the
    // two statements below rather than re-typed in each** — the DV6 guard has
    // to count exactly the instruments the aggregate would group by, and one
    // fragment makes that structural instead of a claim two SQL literals have
    // to keep agreeing on. Every predicate is load-bearing:
    //
    //  - `t.kind = 'DIVIDEND'` — for the *withholding* half above all, and
    //    for `INCOME` too since `cash-interest`: `INCOME` is emitted by a
    //    dividend's principal leg **and an INTEREST's** (CI-L4: interest is not
    //    a dividend and stays off this screen), and the withholding leg
    //    is emitted for *any* kind carrying one ("so an out-of-band row can
    //    never hide a tax leg from the ledger", `posting-expander.ts`) and a
    //    BUY's `tax_amount` cost component also classifies `TAX`. Without this
    //    predicate the withholding total would silently absorb trade taxes.
    //  - `p.leg = 'CASH'` — defence in depth, and it says out loud that this is a
    //    cash aggregate. `INCOME`/`TAX` never appear on a POSITION leg, and a
    //    DIVIDEND has none (`transaction_dividend_shape`).
    //  - the `instrument` join is `inner`, and that is safe: every DIVIDEND has a
    //    non-null `instrument_id`, `instrument` carries no RLS (it is the shared
    //    reference catalogue), and `app_web` has no DELETE grant on it
    //    (`instrument-delete-guard.test.ts` is a source-text gate against one
    //    appearing). So the join can never drop a dividend row.
    //    `listTenantHeldInstruments` relies on the same three facts. It is kept
    //    in the guard too, where nothing selects from `i`: an inner join is not
    //    a projection, it is part of *which rows exist*, and dropping it there
    //    would be the one edit that could make the two statements disagree.
    //  - `t.tenant_id = p.tenant_id` in the join — the composite-FK discipline the
    //    rest of the schema uses; RLS already bounds both sides, and this makes
    //    the join key total rather than relying on `transaction_id` uniqueness.
    const countedDividendLegs = sql`
          from transaction_posting p
          join "transaction" t
            on  t.id        = p.transaction_id
            and t.tenant_id = p.tenant_id
          join instrument i
            on  i.id = t.instrument_id
          left join instrument_icon ic
            on  ic.instrument_id = t.instrument_id
            and ic.tenant_id     = t.tenant_id
          where p.tenant_id = ${tenantId}
            and t.kind      = 'DIVIDEND'
            and p.leg       = 'CASH'
            and p.flow_class in ('INCOME', 'TAX')${portfolioPredicate}${fromPredicate}${toPredicate}`;

    // DV6 — **the refusal precedes the materialisation it exists to
    // prevent**. It used to be checked on `byInstrument.size`, i.e.
    // after every grouped row had crossed the wire and been folded into three
    // `Map`s: that bounds what Fastify serialises and nothing else, so the one
    // thing the cap could not do was refuse an oversized scope cheaply.
    //
    // **Why a `count(distinct)` and not a `LIMIT` on the grouped rows.** A
    // grouped row is an `(instrument, year, month)` tuple, so no `LIMIT`
    // derived from an *instrument* cap is honest: it would need a bound on
    // months per instrument, and no cap is invented for it (it
    // bounds the time dimensions by argument — `|months| ≤ |DIVIDEND rows|` —
    // precisely because a cap there could never bind). A `LIMIT` large enough
    // to be safe would be a number with no reasoning behind it; one small
    // enough to bound memory would refuse scopes that are legitimately
    // servable, and refusing on grouped rows would also make the refusal stop
    // meaning what {@link TooManyDividendInstrumentsError} says it means.
    // Counting the dimension the cap is actually about answers the question
    // the refusal is about, in one row.
    //
    // **Two statements under READ COMMITTED, reasoned rather than assumed.**
    // The "one statement, one snapshot" argument is about the three folds:
    // they must see one state or the yearly totals would not sum to the
    // per-instrument ones. This guard folds nothing and returns no figure — it
    // decides only whether to ask. Its snapshot may differ from the
    // aggregate's, and the whole consequence lives at the boundary: a tenant
    // that commits its (cap + 1)-th dividend-paying instrument between the two
    // statements is served cap + 1 rows, and one that deletes its (cap + 1)-th
    // is refused a response it could have been served. Neither is a wrong
    // figure — the aggregate is still one statement over one snapshot, and
    // `total` is still the exact sum of the rows returned. The
    // `tenant.base_currency` lookup above is the same shape of second
    // statement, tolerated on the same reasoning by the AR-5 guard.
    //
    // **What it costs and what it bounds, stated plainly.** A served request
    // now walks the join twice; that is the price of not materialising a scope
    // that is going to be refused. It bounds the dimension the cap names —
    // instruments — and nothing more: the grouped result set is still
    // `|instruments| × |months|`, and the time half rests on the argument in
    // this module's header, which is an argument and is labelled as one there.
    //
    // **Ordering against the two guards below is decided here.** An
    // over-cap scope that also holds an out-of-band costed DIVIDEND used to
    // raise {@link AmbiguousDividendTaxLegError} (thrown mid-fold) and now
    // raises this one. Both are 422 refusals of the whole request, neither
    // returns a figure, and refusing the cheaper one first is the point.
    //
    // The second guard is preceded too, and that one is not a 422:
    // {@link DividendBaseCurrencyMismatchError} is the deliberate 500 over
    // corrupt stored state. A tenant that is both over-cap and carrying an
    // AR-5-violating posting is now told its scope is too wide rather than
    // hearing the corruption alarm — until it narrows. That is acceptable
    // because narrowing is exactly what this refusal asks for and both
    // controls exist on the screen (a portfolio filter and a period), so any
    // narrowed scope still holding the mislabelled posting re-surfaces the
    // 500 unchanged: the alarm is deferred, never suppressed. What AR-5
    // actually forbids is untouched — no path here returns a figure in an
    // unknown unit, and the over-cap request returns no figure at all.
    const [capRow] = await tx.execute<{ instrument_count: string }>(
      sql`select count(distinct t.instrument_id) as instrument_count${countedDividendLegs}`,
    );
    if (capRow === undefined) {
      throw new Error("summarizeDividends: the instrument-count guard returned no row");
    }
    const instrumentCount = Number(capRow.instrument_count);
    if (instrumentCount > maxInstruments) {
      throw new TooManyDividendInstrumentsError(instrumentCount, maxInstruments);
    }

    // Bucketing is `to_char`, and that is a decision (FR-276): `trade_date` is a
    // plain calendar `date`, so no timezone can enter — there is no `AT TIME
    // ZONE`, no `now()`, no `current_date`, and `trade_ts` is not read by this
    // query at all. `date_trunc` is rejected (it returns a `timestamp`, which
    // would then need re-formatting to `YYYY-MM`) and `extract` is rejected (it
    // returns `numeric`, so the key would be re-stringified and years before 1000
    // would lose their zero padding — `to_char`'s `'YYYY'` pads).
    const rows = await tx.execute<DividendAggregateRow>(
      sql`select
            t.instrument_id                                                          as instrument_id,
            i.display_name                                                           as display_name,
            i.symbol                                                                 as symbol,
            (ic.instrument_id is not null)                                           as has_icon,
            to_char(t.trade_date, 'YYYY')                                            as year,
            to_char(t.trade_date, 'YYYY-MM')                                         as month,
            coalesce(  sum(p.amount_base) filter (where p.flow_class = 'INCOME'), 0) as gross_base,
            coalesce(- sum(p.amount_base) filter (where p.flow_class = 'TAX'   ), 0) as withholding_base,
            count(distinct p.transaction_id) filter (where p.flow_class = 'INCOME')  as payment_count,
            count(distinct p.base_currency)                                          as base_currency_count,
            min(p.base_currency)                                                     as base_currency,
            count(*) filter (where t.fee_amount is not null)                         as costed_row_legs${countedDividendLegs}
          group by t.instrument_id, i.display_name, i.symbol, ic.instrument_id,
                   to_char(t.trade_date, 'YYYY'), to_char(t.trade_date, 'YYYY-MM')
          order by t.instrument_id, month`,
    );

    // The three folds, over the same array, in exact `Decimal`
    // arithmetic. `Map` insertion order is the SQL `order by`'s; both period
    // arrays are re-sorted below anyway, since a month-ordered scan does not
    // yield years in order.
    const byInstrument = new Map<string, MutableInstrument>();
    const byYear = new Map<string, MutableTotals>();
    const byMonth = new Map<string, MutableTotals>();

    for (const row of rows) {
      // The two guards, per group, before the row contributes anything.
      if (row.costed_row_legs !== "0") {
        throw new AmbiguousDividendTaxLegError(row.instrument_id, Number(row.costed_row_legs));
      }
      if (row.base_currency_count !== "1" || row.base_currency !== baseCurrency) {
        throw new DividendBaseCurrencyMismatchError(baseCurrency, row.base_currency);
      }

      const grossBase = new Decimal(row.gross_base);
      const withholdingBase = new Decimal(row.withholding_base);

      const instrument = byInstrument.get(row.instrument_id);
      if (instrument === undefined) {
        byInstrument.set(row.instrument_id, {
          displayName: row.display_name,
          symbol: row.symbol,
          hasIcon: row.has_icon,
          grossBase,
          withholdingBase,
          paymentCount: Number(row.payment_count),
        });
      } else {
        instrument.grossBase = instrument.grossBase.plus(grossBase);
        instrument.withholdingBase = instrument.withholdingBase.plus(withholdingBase);
        // A transaction falls in exactly one month, so summing the per-month
        // `count(distinct transaction_id)` is the instrument's own distinct count.
        instrument.paymentCount += Number(row.payment_count);
      }

      accumulate(byYear, row.year, grossBase, withholdingBase);
      accumulate(byMonth, row.month, grossBase, withholdingBase);
    }

    // DV6, the backstop — and the reason both checks exist. The guard above
    // is a *proxy* measured at an earlier READ COMMITTED snapshot, and its
    // "at worst cap + 1" characterisation rests on a premise nothing states
    // or enforces: that every write path commits one instrument's dividends
    // at a time (true today — the importer applies row by row, `POST
    // /transactions` writes a single row). This check reads what was actually
    // folded, so it restores an exact, unraceable bound on what gets
    // serialised whatever the two snapshots did. It costs nothing: the fold
    // has already happened when it runs, and it issues no statement — so it
    // takes nothing back from the guard, whose point is refusing an oversized
    // scope *cheaply*, not refusing it at all.
    if (byInstrument.size > maxInstruments) {
      throw new TooManyDividendInstrumentsError(byInstrument.size, maxInstruments);
    }

    const instruments = [...byInstrument.entries()]
      .map(([instrumentId, value]) => ({
        instrumentId,
        displayName: value.displayName,
        symbol: value.symbol,
        hasIcon: value.hasIcon,
        grossBase: value.grossBase,
        withholdingBase: value.withholdingBase,
        paymentCount: value.paymentCount,
      }))
      // Descending `grossBase`, ties broken by `instrumentId`, so a repeated
      // call is byte-identical and the client's first render is not a re-sort.
      // The client re-orders by French collation the moment the user sorts by
      // name (DV7) — Postgres collation would order names differently from the
      // Positions and Instruments screens.
      .sort(
        (a, b) =>
          b.grossBase.comparedTo(a.grossBase) ||
          (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0),
      );

    const total = instruments.reduce<DividendTotals>(
      (accumulated, row) => ({
        grossBase: accumulated.grossBase.plus(row.grossBase),
        withholdingBase: accumulated.withholdingBase.plus(row.withholdingBase),
      }),
      { grossBase: ZERO, withholdingBase: ZERO },
    );

    return {
      baseCurrency,
      from: from ?? null,
      to: to ?? null,
      portfolioId: portfolioId ?? null,
      total,
      instruments,
      years: toPeriodRows(byYear),
      months: toPeriodRows(byMonth),
    };
  });
}

function accumulate(
  buckets: Map<string, MutableTotals>,
  period: string,
  grossBase: Decimal,
  withholdingBase: Decimal,
): void {
  const bucket = buckets.get(period);
  if (bucket === undefined) {
    buckets.set(period, { grossBase, withholdingBase });
    return;
  }
  bucket.grossBase = bucket.grossBase.plus(grossBase);
  bucket.withholdingBase = bucket.withholdingBase.plus(withholdingBase);
}

/** `period` ascending — `YYYY` and `YYYY-MM` are both zero-padded, so lexical order *is* chronological order. */
function toPeriodRows(buckets: Map<string, MutableTotals>): DividendPeriodSummary[] {
  return [...buckets.entries()]
    .map(([period, value]) => ({
      period,
      grossBase: value.grossBase,
      withholdingBase: value.withholdingBase,
    }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}
