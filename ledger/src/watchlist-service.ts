import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { instrument, watchlistItem, withTenant, type Db, type Tx } from "@kerdial/platform-db";
import type { Decimal } from "@kerdial/core-decimal";
import { InstrumentNotFoundError } from "./instrument-service.js";

/**
 * `ledger`'s watchlist service (T-64): FR-338–FR-341, FR-368, FR-375, FR-376, FR-380, NFR-36.
 *
 * Owns the whole write side of `watchlist_item`: the per-tenant reference to a
 * catalogue instrument the tenant wants to follow, held or not.
 * `instrument-icon-service.ts`'s body with the icon parts replaced by a target
 * price and a note, and for the same reasons — see that module for the
 * arguments behind the probe-then-count shape and the cap's replace exemption,
 * both reproduced here rather than reinvented.
 *
 * **Why `withTenant`.** `watchlist_item` is TENANT-OWNED (FR-366; see the
 * table's own schema doc comment in
 * `platform/db/src/schema/watchlist-item.ts`) with row-level security both
 * `ENABLE`d and `FORCE`d, so every function below goes through `withTenant` —
 * the only sanctioned way to obtain a handle with `app.tenant_id` set. RLS,
 * not the explicit `eq(watchlistItem.tenantId, …)` predicates, is what makes a
 * cross-tenant read return zero rows rather than another tenant's; those
 * predicates are the defence in depth `instrument-icon-service.ts` and
 * `manual-price-service.ts` both document. NFR-36's "no controller writes its
 * own `WHERE tenant_id = ?`" holds because the controller does not: the
 * service does, inside `withTenant`.
 *
 * **A watchlist write fans out to nothing**. No `holding_state`
 * write, no `calc_epoch` advance, no `recomputeAndInvalidate`, no
 * `market_data_epoch` bump, no queue enqueue from here — watching an
 * instrument moves no figure. The one thing a *first* watch does trigger, the
 * `ensureInstrumentBackfillRequested` call of FR-342, is the controller's,
 * copied from `POST /instruments`' own path: `ledger` does not
 * depend on the scheduler. Stated explicitly because every *other* write in
 * this package does fan out (`manual-price-service.ts:271-279`), so its
 * absence here would otherwise read as an omission.
 *
 * **The cross-tenant read of this table is deliberately elsewhere.**
 * `fetchWatchedInstruments` (`market/ingestion/src/watchlist-fanout.ts`) scans
 * every tenant's rows with no `tenant_id` predicate, through the `app_ingest`
 * pool, because the fan-out polls one instrument once no matter how many
 * tenants watch it. Serving a request path from that function would be FR-51's
 * forbidden substitution in a new shape;
 * {@link listWatchedInstrumentIds} is the tenant-scoped read the API uses, and
 * `api/src/market-data-quote-refresh.e2e.test.ts` guards the substitution
 * statically by name.
 */

/**
 * FR-368/OD-3 — one tenant holds at most this many watchlist rows. The 201st
 * **distinct** instrument is refused with
 * {@link WatchlistTenantCapExceededError}; updating an existing row never
 * consults the cap, because it adds no net-new row (the exemption
 * `INSTRUMENT_ICON_TENANT_ROW_CAP` states for itself, verbatim).
 *
 * Locked at 200, not chosen here: it is generous against any
 * personal decision-support list while bounding both this table's growth and
 * the ingestion population the union adds (`200 × tenants`
 * distinct instruments, the number NFR-41's capacity argument is made
 * against). Mirrors `manual-price-service.ts`'s
 * `MANUAL_PRICE_POINT_TENANT_ROW_CAP` precedent (V16) in shape as well as
 * intent, including the `web/src/lib/api-limits.ts` mirror and its drift test.
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (the `web/src/lib/api-limits.ts` mirror and its drift test, which knip does not analyse). */
export const MAX_WATCHLIST_ITEMS_PER_TENANT = 200;

/**
 * `watchlist_item_note_length`'s literal, declared here because
 * the service re-asserts it: a note that reaches the CHECK escapes as a raw
 * Postgres `23514`, i.e. a 500 on user-supplied text rather than a named
 * refusal.
 *
 * 500 is this feature's own number — `instrument_industry_label_length` bounds
 * at 120, but that bounds a *provider* label and this bounds a human's note.
 * Read back out of `pg_get_constraintdef` and compared to this constant by
 * `watchlist-service.integration.test.ts`, which is the both-directions drift
 * guard `0057:55-61` records as the only kind that holds. (That guard lives
 * here rather than in `platform/db`'s own schema suite because `platform/db`
 * cannot import `@kerdial/ledger` — the package edge runs the other way;
 * `watchlist-item-schema.integration.test.ts` asserts the SQL literal
 * directly.)
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (the `web/src/lib/api-limits.ts` mirror and its drift test, which knip does not analyse). */
export const WATCHLIST_NOTE_MAX_LENGTH = 500;

/**
 * WL-1 (security review): `watchlist_item.target_price`
 * is `numeric(38, 18)` (`platform/db/src/schema/watchlist-item.ts`'s
 * `decimalCol("target_price", 38, 18)`) — Postgres itself rounds anything with
 * more than 18 fractional digits to that scale on storage. A target like
 * `"0.0000000000000000001"` (19 fractional digits, 1e-19) passes the positive
 * check below (it genuinely is positive, as parsed) and then **rounds to
 * exactly `0`** once stored, violating `watchlist_item_target_price_positive`
 * — a raw `23514`, i.e. a 500 on a user-entered figure. A non-zero 19-dp
 * target is worse than an error: it is stored silently truncated, so the
 * decision figure the user typed is not the one the row holds.
 *
 * Matches the column's own declared scale, not an arbitrary constant, and
 * mirrors `manual-price-service.ts`'s
 * `MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES` (NEW-5) — the same column type
 * with the same positive CHECK, whose scale guard this feature reproduced the
 * positive half of and dropped the scale half of.
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (the `web/src/lib/api-limits.ts` mirror and its drift test, which knip does not analyse). */
export const WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES = 18;

/** Surfaced by {@link addWatchlistItem} when a tenant at {@link MAX_WATCHLIST_ITEMS_PER_TENANT} attempts to watch a genuinely new instrument (FR-340). Editing an existing row is never blocked — it adds no net-new row. `api` answers `429 WATCHLIST_TENANT_CAP_EXCEEDED`. */
export class WatchlistTenantCapExceededError extends Error {
  readonly tenantId: string;
  readonly cap: number;

  constructor(tenantId: string, cap: number) {
    super(
      `Tenant ${tenantId} already has ${cap} or more watchlist_item rows — refusing to watch ` +
        `another instrument until existing ones are removed (FR-340, FR-368).`,
    );
    this.name = "WatchlistTenantCapExceededError";
    this.tenantId = tenantId;
    this.cap = cap;
  }
}

/**
 * Surfaced by {@link updateWatchlistItem} when the tenant does not watch
 * `instrumentId`. A `PATCH` is **not** a create: silently inserting would make
 * it a second, undocumented add path, and it maps to
 * `404 WATCHLIST_ITEM_NOT_FOUND`.
 *
 * {@link removeWatchlistItem} deliberately never throws it — un-watching an
 * absent row is a success (FR-375).
 */
export class WatchlistItemNotFoundError extends Error {
  readonly instrumentId: string;

  constructor(instrumentId: string) {
    super(`No watchlist item found for instrument ${instrumentId}`);
    this.name = "WatchlistItemNotFoundError";
    this.instrumentId = instrumentId;
  }
}

/**
 * Surfaced by {@link addWatchlistItem} and {@link updateWatchlistItem} when
 * `targetPrice` carries more fractional digits than the
 * `watchlist_item.target_price` column can store without silent rounding
 * (WL-1). A named refusal rather than a `RangeError`, for the
 * reason `ManualPricePointScaleExceededError` is one: `api` maps it to
 * `400 WATCHLIST_TARGET_PRICE_SCALE_EXCEEDED`, and a non-HTTP
 * caller gets a refusal that names the rule instead of a raw `23514`.
 */
export class WatchlistTargetPriceScaleExceededError extends Error {
  readonly instrumentId: string;
  readonly maxDecimalPlaces: number;

  constructor(instrumentId: string, maxDecimalPlaces: number) {
    super(
      `watchlist target price for instrument ${instrumentId} has more than ${maxDecimalPlaces} ` +
        `fractional digits — the watchlist_item.target_price column would silently round it, ` +
        `to zero for a value below 5e-19 (WL-1).`,
    );
    this.name = "WatchlistTargetPriceScaleExceededError";
    this.instrumentId = instrumentId;
    this.maxDecimalPlaces = maxDecimalPlaces;
  }
}

/** One `watchlist_item` row as this service reads and returns it — what `POST /watchlist` and `PATCH /watchlist/:instrumentId` answer with. */
export interface WatchlistItemRecord {
  readonly tenantId: string;
  readonly instrumentId: string;
  /** In the instrument's **listing** currency (LD-6), or `null` — FR-341's optional target. */
  readonly targetPrice: Decimal | null;
  readonly note: string | null;
  /** Its date is the wire's `watchedSince`. */
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * FR-341's two optional fields, with the three-way distinction both write
 * paths share and neither may collapse:
 *
 *  - **absent (`undefined`)** — leave whatever is stored alone. This is what
 *    makes a bare re-watch a no-op (FR-339/FR-375) instead of a silent wipe of
 *    the note the first watch carried.
 *  - **`null`** — clear the field. FR-341's "editable" includes "editable back
 *    to empty", and a `PATCH` has no other way to say it.
 *  - **a value** — set it.
 */
interface WatchlistItemFields {
  readonly targetPrice?: Decimal | null;
  readonly note?: string | null;
}

interface WatchlistItemKey {
  readonly tenantId: string;
  readonly instrumentId: string;
}

/**
 * `POST /watchlist`'s input. Not a separate exported alias per
 * write path: the two write paths take the same shape and differ only in what
 * they do when the row is absent, and `scripts/unused-exports-gate.ts` counts
 * an export nothing imports as dead surface.
 */
export type WatchlistItemWriteParams = WatchlistItemKey & WatchlistItemFields;

const RETURNING = {
  tenantId: watchlistItem.tenantId,
  instrumentId: watchlistItem.instrumentId,
  targetPrice: watchlistItem.targetPrice,
  note: watchlistItem.note,
  createdAt: watchlistItem.createdAt,
  updatedAt: watchlistItem.updatedAt,
} as const;

/**
 * Re-asserts `watchlist_item`'s two CHECKs at the service boundary, for the
 * reason `instrument-icon-service.ts`'s `assertStorableIcon` states: the route
 * is not this function's only possible caller, and without this the table's
 * CHECKs would be the only backstop — a defect upstream would escape as a raw
 * `23514`, i.e. a 500 on user-supplied text or a user-entered price.
 *
 * **Plus the column's scale** (WL-1), which is *not* a CHECK and
 * which the two CHECKs cannot stand in for: Postgres rounds a 19-dp target to
 * the column's 18 places before `watchlist_item_target_price_positive` is ever
 * evaluated, so the positive check below passes on a value that then becomes
 * `0` (the `23514`) or a silently different figure. Both write paths call this
 * function, so `POST` and `PATCH` refuse it identically.
 */
function assertStorableFields(params: WatchlistItemKey & WatchlistItemFields): void {
  if (params.note !== undefined && params.note !== null) {
    if (params.note.length > WATCHLIST_NOTE_MAX_LENGTH) {
      throw new RangeError(
        `watchlist note for instrument ${params.instrumentId} is ${params.note.length} characters, ` +
          `outside 0..${WATCHLIST_NOTE_MAX_LENGTH} (watchlist_item_note_length).`,
      );
    }
  }
  if (params.targetPrice !== undefined && params.targetPrice !== null) {
    if (!params.targetPrice.isFinite() || params.targetPrice.lessThanOrEqualTo(0)) {
      throw new RangeError(
        `watchlist target price for instrument ${params.instrumentId} is ` +
          `${params.targetPrice.toString()} — a non-positive target is not a target ` +
          `(watchlist_item_target_price_positive).`,
      );
    }
    if (params.targetPrice.decimalPlaces() > WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES) {
      throw new WatchlistTargetPriceScaleExceededError(
        params.instrumentId,
        WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
      );
    }
  }
}

/**
 * The `set` clause of the upsert's conflict arm, and of `PATCH`'s `UPDATE`:
 * exactly the fields the caller named, never the ones it did not. See
 * {@link WatchlistItemFields} for why the distinction is load-bearing.
 */
function fieldUpdates(fields: WatchlistItemFields): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (fields.targetPrice !== undefined) set["targetPrice"] = fields.targetPrice;
  if (fields.note !== undefined) set["note"] = fields.note;
  return set;
}

/**
 * The instrument must exist **and** be a shared-catalogue row
 * (`owner_tenant_id IS NULL`) — the filter every read in
 * `instrument-service.ts:624,721,840` applies. A watchlist row
 * pointing at nothing is a row whose every metric is unavailable forever, so
 * this 404s instead (`InstrumentNotFoundError`, reused rather than duplicated,
 * so `api` keeps answering the existing `INSTRUMENT_NOT_FOUND` code.
 */
async function assertSharedCatalogueInstrument(tx: Tx, instrumentId: string): Promise<void> {
  const [row] = await tx
    .select({ id: instrument.id })
    .from(instrument)
    .where(and(eq(instrument.id, instrumentId), isNull(instrument.ownerTenantId)));
  if (!row) throw new InstrumentNotFoundError(instrumentId);
}

/**
 * Watches `instrumentId` for this tenant, or updates the row that is already
 * there — the table's own primary key, so watching an already-watched
 * instrument **is** an update, not a second row (FR-339/FR-380).
 *
 * **FR-339's idempotence is a database property, not a read-then-write race.**
 * The write is one `INSERT … ON CONFLICT (tenant_id, instrument_id) DO
 * UPDATE`: two tabs, or a double-click, produce one row and two successes,
 * with no window in which a second caller sees "no row" and inserts a
 * duplicate the PK would then reject as a `23505` the user would read as an
 * error.
 *
 * **The cap is consulted only when the row is absent** (FR-340's exemption),
 * so a tenant at the cap can still correct an existing target price forever.
 * The probe, the `count(*)` and the insert all run inside `withTenant`'s single
 * transaction, so no other statement of *this* caller's can interleave; the
 * `count(*)` is an index-only scan of the PK's `tenant_id` prefix, bounded by
 * the cap itself.
 *
 * The TOCTOU window this leaves is the same soft-cap trade-off
 * `instrument-icon-service.ts` and `manual-price-service.ts` (N11) both
 * record, and it is **not** closed by the transaction: under `READ COMMITTED`
 * two concurrent watches of two *different* new instruments by one tenant can
 * both count 199 and both insert, overshooting by the number of writers. The
 * per-tenant write concurrency cap of 2 bounds that overshoot, the refusal is
 * still exact for every sequential caller (AC-337's own shape), and closing it
 * properly would mean either serialising every tenant's watch behind a row
 * lock or an `ISOLATION LEVEL SERIALIZABLE` retry loop — cost the locked cap
 * does not justify. Stated rather than implied, because it reads
 * as though the shared transaction alone made it impossible.
 */
export async function addWatchlistItem(
  db: Db,
  params: WatchlistItemWriteParams,
): Promise<WatchlistItemRecord> {
  assertStorableFields(params);

  return withTenant(db, params.tenantId, async (tx) => {
    await assertSharedCatalogueInstrument(tx, params.instrumentId);

    const [existing] = await tx
      .select({ tenantId: watchlistItem.tenantId })
      .from(watchlistItem)
      .where(
        and(
          eq(watchlistItem.tenantId, params.tenantId),
          eq(watchlistItem.instrumentId, params.instrumentId),
        ),
      );
    if (!existing) {
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(watchlistItem)
        .where(eq(watchlistItem.tenantId, params.tenantId));
      const count = countRows[0]?.count ?? 0;
      if (count >= MAX_WATCHLIST_ITEMS_PER_TENANT) {
        throw new WatchlistTenantCapExceededError(params.tenantId, MAX_WATCHLIST_ITEMS_PER_TENANT);
      }
    }

    const [row] = await tx
      .insert(watchlistItem)
      .values({
        tenantId: params.tenantId,
        instrumentId: params.instrumentId,
        targetPrice: params.targetPrice ?? null,
        note: params.note ?? null,
      })
      .onConflictDoUpdate({
        target: [watchlistItem.tenantId, watchlistItem.instrumentId],
        set: fieldUpdates(params),
      })
      .returning(RETURNING);

    return row!;
  });
}

/**
 * Edits this tenant's watchlist row for `instrumentId` **without un-watching
 * it** (FR-341). Each field follows {@link WatchlistItemFields}' three-way
 * rule, so a `PATCH` that names only the note leaves the target price alone
 * and a `PATCH` naming `null` clears the field it names.
 *
 * Throws {@link WatchlistItemNotFoundError} when no row exists. The check is
 * the `UPDATE`'s own zero-row outcome rather than a separate probe, so there
 * is no window between "it exists" and "it was updated"; the cap is never
 * consulted, because this path adds no row.
 */
export async function updateWatchlistItem(
  db: Db,
  params: WatchlistItemWriteParams,
): Promise<WatchlistItemRecord> {
  assertStorableFields(params);

  return withTenant(db, params.tenantId, async (tx) => {
    const [row] = await tx
      .update(watchlistItem)
      .set(fieldUpdates(params))
      .where(
        and(
          eq(watchlistItem.tenantId, params.tenantId),
          eq(watchlistItem.instrumentId, params.instrumentId),
        ),
      )
      .returning(RETURNING);
    if (!row) throw new WatchlistItemNotFoundError(params.instrumentId);
    return row;
  });
}

/**
 * Un-watches `instrumentId` for this tenant, if it was watched.
 *
 * **Idempotent by construction** (FR-375) — one `DELETE` whose zero-row
 * outcome is reported as `{ removed: false }` and is never an error; the route
 * answers `204` either way. `removed` exists for the caller that
 * wants to log or count, not for the status line.
 *
 * FR-376: the `WHERE` names this tenant's key and runs inside `withTenant`, so
 * another tenant's row for the same instrument is untouched — proven with a
 * two-tenant fixture rather than asserted, because RLS is what actually
 * enforces it and only a real-role test sees RLS.
 */
export async function removeWatchlistItem(
  db: Db,
  params: WatchlistItemKey,
): Promise<{ removed: boolean }> {
  return withTenant(db, params.tenantId, async (tx) => {
    const removed = await tx
      .delete(watchlistItem)
      .where(
        and(
          eq(watchlistItem.tenantId, params.tenantId),
          eq(watchlistItem.instrumentId, params.instrumentId),
        ),
      )
      .returning({ instrumentId: watchlistItem.instrumentId });
    return { removed: removed.length > 0 };
  });
}

/**
 * Which instruments **this tenant** watches — one `SELECT instrument_id` over
 * the PK's `tenant_id` prefix, ordered by `instrument_id` so the result is
 * deterministic for a client that diffs it, and bounded by
 * {@link MAX_WATCHLIST_ITEMS_PER_TENANT}.
 *
 * Backs `GET /watchlist/ids`, the cheap read the instrument-screen toggles
 * resolve their state from. **Never `fetchWatchedInstruments`**
 * — that one is cross-tenant by design and serving a request path from it
 * would leak every tenant's watchlist to whoever pressed a button (FR-51's
 * forbidden substitution in a new shape).
 */
export async function listWatchedInstrumentIds(db: Db, tenantId: string): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ instrumentId: watchlistItem.instrumentId })
      .from(watchlistItem)
      .where(eq(watchlistItem.tenantId, tenantId))
      .orderBy(asc(watchlistItem.instrumentId));
    return rows.map((row) => row.instrumentId);
  });
}
