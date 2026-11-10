import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { manualPricePoint, withTenant, type Db } from "@kerdial/platform-db";
import { invalidateForInstrumentPrice } from "./materialization.js";
import { lockTenantWrites } from "./portfolio-lock.js";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import { Decimal } from "@kerdial/core-decimal";

/**
 * `ledger`'s manual price entry service — T-36
 * (component C12). Owns the write side of `manual_price_point`: a tenant's
 * own manually entered price for an instrument on a date, most notably the
 * OPCVM/FUND NAV case for which `quote_policy = MANUAL_ONLY` and no phase-1
 * provider publishes an automated close (FR-16, AC12). The read/precedence
 * side — `resolvePrice` giving a manual point highest precedence over
 * `instrument_price_daily` for the same `(instrument, date)`, FR-23's
 * "override" language — already exists (`@kerdial/core-domain`'s
 * `resolvePrice`, wired in by `valuation`'s `materializePortfolioValuations`,
 * T-28/T-30); this module supplies the rows that path reads.
 *
 * **Why `withTenant`.** Unlike `instrument`/`instrument_price_daily`, which
 * are shared reference data with no `tenant_id`, `manual_price_point` is
 * explicitly TENANT-OWNED (FR-23, FR-45, AC33, AC12; see this table's own
 * schema doc comment in `platform/db/src/schema/manual-price-point.ts`): a
 * manually entered NAV is the tenant's own data, not shared, on purpose —
 * so it must carry `tenant_id` and be included in that tenant's export/
 * deletion (FR-48/FR-49) and never leak to another tenant (AC33). Migration
 * `0007_roles-grants-rls.sql` (as amended by `0008`) puts this table under
 * `ENABLE`+`FORCE ROW LEVEL SECURITY`; every function below goes through
 * `withTenant` (`@kerdial/platform-db`, T-9) — the only sanctioned way to
 * obtain a handle with `app.tenant_id` set — so RLS, not merely an
 * application-level `where` clause, is what makes a cross-tenant read return
 * zero rows rather than another tenant's (defense in depth; the explicit `eq(manualPricePoint.tenantId, ...)` predicates here are
 * the same belt-and-suspenders `portfolio-service.ts` documents, not the
 * primary mechanism).
 *
 * **`source_key`** always ends up `'manual'` (the column's own default, FR-24)
 * unless a caller explicitly overrides it — kept overridable only so a future
 * caller distinguishing e.g. an admin-entered value from a user-entered one
 * (`'manual-admin'`, mirroring `fx_rate_daily`'s own `source_key` convention)
 * is a one-line change here, not a schema migration.
 *
 * **Out of scope** (T-36): the UI form for entering a manual
 * price (T-44, which reuses this service's validation rules) and
 * provenance-flag rendering (T-43, which reads the `origin`/`sourceKey` this
 * service's rows already carry via `resolvePrice`).
 */

/** Mirrors `manual_price_point`'s row shape exactly — see `platform/db/src/schema/manual-price-point.ts`. */
export type ManualPricePointRecord = typeof manualPricePoint.$inferSelect;

/**
 * F3 (security review, T-37): an unbounded per-tenant
 * `manual_price_point` row count is a resource-exhaustion vector — nothing
 * previously stopped one tenant from writing an arbitrary number of rows.
 * 500k is generous (far beyond any plausible number of (instrument, date)
 * NAV points a real tenant would ever enter by hand) while still bounding
 * the table's growth per tenant.
 *
 * N11 (security review, T-37, doc-only): this is a
 * **soft** cap, not a hard one — {@link upsertManualPricePoint}'s
 * count-then-insert is two separate statements inside one transaction, not a
 * single atomic check-and-write, so N concurrent inserts for genuinely new
 * `(instrumentId, priceDate)` keys arriving after the count has already been
 * read but before any of them commits can all observe a count just under the
 * cap and all proceed, overshooting it by up to N rows. This is a deliberate,
 * accepted trade-off, not an oversight: closing it fully would need a
 * `SELECT ... FOR UPDATE`-style serialising lock (or an advisory lock, the
 * pattern `TransactionWriteService`'s own `seq` allocation already uses) held
 * for the whole transaction, on every single manual-price write, purely to
 * defend a generous, resource-exhaustion-only ceiling that a real tenant is
 * never expected to approach in ordinary use — the overshoot this TOCTOU
 * window can ever produce is bounded by how many concurrent writers one
 * tenant's own session(s) can realistically sustain, not by anything an
 * attacker controls independently of that.
 *
 * (Since `security-transfer` F-9 both manual-price writes take the tenant
 * advisory lock as their first statement, for lock-order reasons of their own
 * — see {@link upsertManualPricePoint}. That lock also serialises this
 * count-then-insert per tenant, so the overshoot described above is no longer
 * reachable through this service; the paragraph is kept because the cap's
 * correctness was never meant to rest on it, and nothing tests it as hard.)
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (web/api mirrors and their tests, which knip does not analyse) — until AR-13a removed a namespace-wide `typeof import("@kerdial/ledger")` vi.mock, that accident masked this. */
export const MANUAL_PRICE_POINT_TENANT_ROW_CAP = 500_000;

/** Surfaced by {@link upsertManualPricePoint} when a tenant at {@link MANUAL_PRICE_POINT_TENANT_ROW_CAP} attempts to add a genuinely new `(instrumentId, priceDate)` row (F3). Revising an existing key is never blocked — it adds no net-new row. */
export class ManualPricePointTenantCapExceededError extends Error {
  readonly tenantId: string;
  readonly cap: number;

  constructor(tenantId: string, cap: number) {
    super(
      `Tenant ${tenantId} already has ${cap} or more manual_price_point rows — refusing to add ` +
        `another new (instrument, date) point until existing rows are removed (F3, security review ` +
        `of T-37).`,
    );
    this.name = "ManualPricePointTenantCapExceededError";
    this.tenantId = tenantId;
    this.cap = cap;
  }
}

/**
 * Rejects a non-positive close before any write — mirrors
 * `market/ingestion`'s `assertPositivePrice` guard on the automated path
 * (`eod-close-job.ts`), applied here to the manual path for the identical
 * reason: a defect upstream of this service (a malformed form submission, a
 * future bulk-import tool) must not be able to persist a zero/negative NAV
 * that would silently corrupt a mark-to-market valuation.
 */
function assertPositiveClose(close: Decimal, instrumentId: string, priceDate: IsoDate): void {
  if (!close.greaterThan(0)) {
    throw new TypeError(
      `upsertManualPricePoint: refusing to persist a non-positive close price ` +
        `(${close.toString()}) for instrument ${instrumentId} on ${priceDate}.`,
    );
  }
}

/**
 * NEW-5 (security review, T-37): `manual_price_point.close`
 * is `numeric(38, 18)` (`platform/db/src/schema/manual-price-point.ts`'s
 * `decimalCol("close", 38, 18)`) — Postgres itself silently rounds anything
 * with more fractional digits than that to the column's own scale, so a
 * close like `1e-19` would round away to exactly `0` once stored (the API's
 * `instruments.schema.ts`'s `MANUAL_PRICE_CLOSE_MAX_DECIMAL_PLACES` refinement,
 * N9, already rejects this at the HTTP boundary). This mirrors that same
 * check here, at the service layer: `POST /instruments/:id/prices` is not
 * this function's only caller in principle (a future bulk-import tool, a
 * script, or any other direct `ledger` consumer bypasses the Zod schema
 * entirely), and none of them should be able to silently zero out a NAV this
 * way. Matches the column's own declared scale, not an arbitrary constant.
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (web/api mirrors and their tests, which knip does not analyse) — until AR-13a removed a namespace-wide `typeof import("@kerdial/ledger")` vi.mock, that accident masked this. */
export const MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES = 18;

/** Surfaced by {@link upsertManualPricePoint} when `close` carries more fractional digits than the `manual_price_point.close` column can store without silent rounding (NEW-5). */
export class ManualPricePointScaleExceededError extends Error {
  readonly instrumentId: string;
  readonly priceDate: IsoDate;
  readonly maxDecimalPlaces: number;

  constructor(instrumentId: string, priceDate: IsoDate, maxDecimalPlaces: number) {
    super(
      `upsertManualPricePoint: close for instrument ${instrumentId} on ${priceDate} has more than ` +
        `${maxDecimalPlaces} fractional digits — the manual_price_point.close column would silently ` +
        `round it (NEW-5).`,
    );
    this.name = "ManualPricePointScaleExceededError";
    this.instrumentId = instrumentId;
    this.priceDate = priceDate;
    this.maxDecimalPlaces = maxDecimalPlaces;
  }
}

/** Rejects a close with more fractional digits than the column can store, before any write (NEW-5). */
function assertCloseScale(close: Decimal, instrumentId: string, priceDate: IsoDate): void {
  if (close.decimalPlaces() > MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES) {
    throw new ManualPricePointScaleExceededError(
      instrumentId,
      priceDate,
      MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES,
    );
  }
}

export interface UpsertManualPricePointParams {
  readonly tenantId: string;
  readonly instrumentId: string;
  /** `YYYY-MM-DD`. */
  readonly priceDate: IsoDate;
  readonly close: Decimal;
  readonly currency: CurrencyCode;
  /** Defaults to `'manual'` (the column's own default, FR-24) — see this file's header. */
  readonly sourceKey?: string;
  /**
   * Testing-only override of {@link MANUAL_PRICE_POINT_TENANT_ROW_CAP} —
   * production callers never supply this. Lets the row-cap guard (F3) be
   * exercised against a real Postgres instance without seeding 500k rows.
   */
  readonly maxRowsPerTenant?: number;
}

/**
 * Creates or revises the manual price point for `(tenantId, instrumentId,
 * priceDate)` — the table's own primary key, so re-entering a NAV for a date
 * already recorded corrects it in place (`ON CONFLICT ... DO UPDATE`) rather
 * than erroring or duplicating, exactly like `fx_rate_daily`/
 * `instrument_price_daily`'s own upsert convention: a manual entry is
 * expected to be revisable (a typo, a corrected NAV) without a separate edit
 * endpoint.
 *
 * This is the first-class path AC12 requires: nothing here depends on
 * `instrument_price_daily` having any row at all, so a brand-new
 * `MANUAL_ONLY` FUND with zero automated history accepts its first NAV point
 * exactly the same way a SHARE with years of automated closes would accept a
 * correction.
 */
export async function upsertManualPricePoint(
  db: Db,
  params: UpsertManualPricePointParams,
): Promise<ManualPricePointRecord> {
  assertPositiveClose(params.close, params.instrumentId, params.priceDate);
  assertCloseScale(params.close, params.instrumentId, params.priceDate);

  const sourceKey = params.sourceKey ?? "manual";
  const enteredAt = new Date();
  const cap = params.maxRowsPerTenant ?? MANUAL_PRICE_POINT_TENANT_ROW_CAP;

  return withTenant(db, params.tenantId, async (tx) => {
    // Rung 1 first (`security-transfer`, F-9): the fan-out below
    // locks every portfolio holding or having traded the instrument, one
    // after another — a multi-portfolio writer, so it takes the tenant lock
    // before anything else, per `portfolio-lock.ts`'s multi-portfolio rule.
    await lockTenantWrites(tx, params.tenantId);
    // F3: only a genuinely new `(instrumentId, priceDate)` key counts
    // against the cap — revising an existing point adds no net-new row, so
    // it must still succeed even once a tenant is at the cap (otherwise a
    // tenant at the limit could never again correct a typo).
    //
    // The `count(*)` below is deliberate (decided 2026-09-01).
    // It is an index-only range scan of the PK's `tenant_id` prefix, and the
    // cap it enforces is also its own bound: a tenant can never hold more
    // than `cap` rows, so the scan never exceeds `cap` entries. A
    // LIMIT/OFFSET-bounded probe walks exactly the same `min(n, cap)` index
    // entries, so it is not cheaper — the only genuinely cheaper shape is a
    // maintained counter, which trades this rare, bounded read on an
    // owner-audited path (per-tenant concurrency cap 2, statement_timeout)
    // for transactional bookkeeping on every insert and delete plus a
    // counter-vs-truth drift risk. Same issue, same date: a same-key update
    // (the `ON CONFLICT` arm) deliberately costs nothing beyond the write —
    // the concurrency cap bounds simultaneous pressure, statement_timeout
    // bounds each one, and a rate cap here would punish exactly the
    // legitimate bulk correction (an operator fixing a month of NAVs) the
    // write throttle deliberately declines to rate-limit.
    const [existing] = await tx
      .select({ tenantId: manualPricePoint.tenantId })
      .from(manualPricePoint)
      .where(
        and(
          eq(manualPricePoint.tenantId, params.tenantId),
          eq(manualPricePoint.instrumentId, params.instrumentId),
          eq(manualPricePoint.priceDate, params.priceDate),
        ),
      );
    if (!existing) {
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(manualPricePoint)
        .where(eq(manualPricePoint.tenantId, params.tenantId));
      const count = countRows[0]?.count ?? 0;
      if (count >= cap) {
        throw new ManualPricePointTenantCapExceededError(params.tenantId, cap);
      }
    }

    const [row] = await tx
      .insert(manualPricePoint)
      .values({
        tenantId: params.tenantId,
        instrumentId: params.instrumentId,
        priceDate: params.priceDate,
        close: params.close,
        currency: params.currency,
        sourceKey,
        enteredAt,
      })
      .onConflictDoUpdate({
        target: [
          manualPricePoint.tenantId,
          manualPricePoint.instrumentId,
          manualPricePoint.priceDate,
        ],
        set: {
          close: sql`excluded.close`,
          currency: sql`excluded.currency`,
          sourceKey: sql`excluded.source_key`,
          enteredAt: sql`excluded.entered_at`,
        },
      })
      .returning();

    // AR-13b (ADR-0007): a new or revised point can
    // change every materialised valuation from its date forward, in every
    // portfolio holding or having traded the instrument — AR-13a measured
    // both the insert-between and the overwrite shape leaving stored rows
    // stale. Same transaction as the write, so a failed fan-out rolls the
    // point back too.
    await invalidateForInstrumentPrice(tx, {
      tenantId: params.tenantId,
      instrumentId: params.instrumentId,
      fromDate: params.priceDate,
    });
    return row!;
  });
}

export interface ListManualPricePointsParams {
  readonly tenantId: string;
  readonly instrumentId: string;
  /** Inclusive range start, `YYYY-MM-DD`. Omit for no lower bound. */
  readonly fromDate?: IsoDate;
  /** Inclusive range end, `YYYY-MM-DD`. Omit for no upper bound. */
  readonly toDate?: IsoDate;
  /**
   * N6 (security review, T-37): caps how many rows
   * this query itself fetches (a real SQL `LIMIT`, applied *after* the
   * `ORDER BY` above so it is always the earliest-dated rows, never an
   * arbitrary subset) — `listInstrumentPriceHistory` is this function's only
   * caller and always supplies it; omitted only by this function's own
   * direct unit/integration tests, which want every row.
   */
  readonly limit?: number;
}

/**
 * Every manual price point this tenant has recorded for `instrumentId`,
 * optionally bounded to `[fromDate, toDate]`, ascending by date. A point
 * recorded by another tenant for the same instrument is never in this list
 * — enforced by RLS (see this file's header), which is why AC33 is proven
 * against live Postgres rather than asserted from the `where` clause below
 * (`manual-price-service.integration.test.ts`).
 */
export async function listManualPricePoints(
  db: Db,
  params: ListManualPricePointsParams,
): Promise<ManualPricePointRecord[]> {
  return withTenant(db, params.tenantId, async (tx) => {
    const conditions = [
      eq(manualPricePoint.tenantId, params.tenantId),
      eq(manualPricePoint.instrumentId, params.instrumentId),
    ];
    if (params.fromDate !== undefined) {
      conditions.push(gte(manualPricePoint.priceDate, params.fromDate));
    }
    if (params.toDate !== undefined) {
      conditions.push(lte(manualPricePoint.priceDate, params.toDate));
    }
    const query = tx
      .select()
      .from(manualPricePoint)
      .where(and(...conditions))
      .orderBy(asc(manualPricePoint.priceDate));
    return params.limit !== undefined ? query.limit(params.limit) : query;
  });
}

/**
 * Deletes the manual price point for `(tenantId, instrumentId, priceDate)`,
 * if this tenant has one. Returns `true` when a row was actually removed,
 * `false` when there was nothing to delete (including the case where the
 * point exists but belongs to another tenant — indistinguishable from
 * "never existed" here, per RLS, exactly as `portfolio-service.ts`'s
 * `getPortfolio` documents for the same reason).
 */
export async function deleteManualPricePoint(
  db: Db,
  tenantId: string,
  instrumentId: string,
  priceDate: IsoDate,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    // Rung 1 first — see `upsertManualPricePoint`.
    await lockTenantWrites(tx, tenantId);
    const deleted = await tx
      .delete(manualPricePoint)
      .where(
        and(
          eq(manualPricePoint.tenantId, tenantId),
          eq(manualPricePoint.instrumentId, instrumentId),
          eq(manualPricePoint.priceDate, priceDate),
        ),
      )
      .returning();
    if (deleted.length > 0) {
      // AR-13b: a removed governor changes answers from its date forward
      // exactly as an added one does (AR-13a case (c)). A no-op delete
      // invalidates nothing.
      await invalidateForInstrumentPrice(tx, { tenantId, instrumentId, fromDate: priceDate });
    }
    return deleted.length > 0;
  });
}
