import { and, eq, inArray, sql } from "drizzle-orm";
import { instrumentIcon, withTenant, type Db } from "@kerdial/platform-db";
import {
  INSTRUMENT_ICON_CONTENT_TYPES,
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
  type InstrumentIconContentType,
  type InstrumentIconSource,
} from "@kerdial/core-reference-data";

/**
 * `ledger`'s instrument-icon service —
 * IK6; FR-295, FR-296, FR-297, FR-299, FR-301, FR-302, SD-4, SD-5.
 *
 * Owns the whole write side of `instrument_icon`: the per-tenant uploaded icon
 * for an instrument. `upsertManualPricePoint`'s body with the price parts
 * replaced, and for the same reasons — see that function for the arguments
 * behind the probe-then-count shape and the testing-only cap override, both of
 * which are reproduced here rather than reinvented.
 *
 * **Why `withTenant`.** `instrument_icon` is TENANT-OWNED (FR-298; see the
 * table's own schema doc comment in
 * `platform/db/src/schema/instrument-icon.ts`) with row-level security both
 * `ENABLE`d and `FORCE`d, so every function below goes through `withTenant` —
 * the only sanctioned way to obtain a handle with `app.tenant_id` set. RLS,
 * not the explicit `eq(instrumentIcon.tenantId, …)` predicates, is what makes
 * a cross-tenant read return zero rows rather than another tenant's; those
 * predicates are the same belt-and-suspenders `manual-price-service.ts`
 * documents.
 *
 * **One code path for both instrument kinds** (FR-299). Nothing here reads
 * `instrument` at all, so a shared catalogue row (`owner_tenant_id IS NULL`)
 * and a tenant-owned row are the same case: the icon's scope is the tenant
 * that uploaded it, independently of who — if anyone — owns the instrument.
 *
 * **An icon write fans out to nothing** (FR-300). No
 * `invalidateForInstrumentPrice`, no `recomputeAndInvalidate`, no `calc_epoch`
 * bump, no `market_data_epoch` bump, no `instrument` write, no queue enqueue.
 * An icon is presentation; it moves no figure. Stated explicitly because every
 * *other* write in this package fans out
 * (`manual-price-service.ts:271-279`), so its absence here would otherwise
 * read as an omission — and asserted, not merely stated, in
 * `instrument-icon-service.integration.test.ts`.
 */

/**
 * SD-5 — one tenant holds at most this many icon rows. The 501st **distinct**
 * instrument is refused; a **replace** of an existing row never consults the
 * cap, because it adds no net-new row (FR-302's explicit exemption).
 *
 * Generous against any personal portfolio while bounding the table's growth
 * per tenant to 500 × `INSTRUMENT_ICON_MAX_BYTES` ≈ 128 MiB — a number an
 * owner-operated Postgres backup can absorb. Mirrors
 * `manual-price-service.ts`'s `MANUAL_PRICE_POINT_TENANT_ROW_CAP` precedent (V16) in shape as well
 * as intent, including the `web/src/lib/api-limits.ts` mirror and its drift
 * test: this cap is enforced by a service, so it lives in `ledger`, unlike the
 * four byte/pixel ceilings, which live in `@kerdial/core-reference-data`
 * because `web` may import that package at runtime. Two homes, two precedents
 * — `core/reference-data/src/instrument-icon.ts`'s header states the split.
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (the `web/src/lib/api-limits.ts` mirror and its drift test, which knip does not analyse). */
export const INSTRUMENT_ICON_TENANT_ROW_CAP = 500;

/** Surfaced by {@link setInstrumentIcon} when a tenant at {@link INSTRUMENT_ICON_TENANT_ROW_CAP} attempts to icon a genuinely new instrument (FR-302). Replacing an existing icon is never blocked — it adds no net-new row. */
export class InstrumentIconTenantCapExceededError extends Error {
  readonly tenantId: string;
  readonly cap: number;

  constructor(tenantId: string, cap: number) {
    super(
      `Tenant ${tenantId} already has ${cap} or more instrument_icon rows — refusing to add an ` +
        `icon for another instrument until existing ones are removed (FR-302, SD-5).`,
    );
    this.name = "InstrumentIconTenantCapExceededError";
    this.tenantId = tenantId;
    this.cap = cap;
  }
}

/**
 * Which of {@link setInstrumentIcon}'s three re-asserted bounds a caller
 * violated. A discriminant rather than three error classes because the three
 * are one claim — "these bytes are not a storable icon" — and no HTTP status
 * distinguishes them: the route validates all three *before* calling this
 * service (its own validation steps), each with its own machine-readable code, so
 * this error is unreachable through the API and needs no taxonomy row.
 */
export type InstrumentIconBoundsViolation = "BYTE_LENGTH" | "DIMENSIONS" | "CONTENT_TYPE";

/**
 * Surfaced by {@link setInstrumentIcon} when its own re-assertion of SD-2's
 * byte ceiling, SD-3's pixel ceiling or SD-1's closed format set fails.
 *
 * The duplication with the HTTP schema is deliberate, for the reason
 * `manual-price-service.ts:113-125` records for its own duplicated guard: the
 * `PUT /instruments/:id/icon` route is not this function's only possible
 * caller — FR-301's provider lane is the whole point of the provenance seam —
 * and without this the table's three CHECKs would be the only backstop, so a
 * defect upstream would escape as a raw Postgres `23514`, i.e. a 500 on a
 * user-supplied upload rather than a named refusal.
 */
export class InstrumentIconBoundsError extends Error {
  readonly violation: InstrumentIconBoundsViolation;
  readonly instrumentId: string;

  constructor(violation: InstrumentIconBoundsViolation, instrumentId: string, detail: string) {
    super(
      `setInstrumentIcon: refusing to store an icon for instrument ${instrumentId} — ${detail} ` +
        `(${violation}; FR-293/FR-294/SD-1).`,
    );
    this.name = "InstrumentIconBoundsError";
    this.violation = violation;
    this.instrumentId = instrumentId;
  }
}

/**
 * What {@link setInstrumentIcon} returns and what
 * `PUT /instruments/:id/icon` answers with — **the metadata, never the bytes**.
 * The stored `bytes` column is up to 256 KiB and the caller just sent it, so
 * returning it would double every upload's transfer for no consumer.
 */
export interface InstrumentIconMeta {
  readonly tenantId: string;
  readonly instrumentId: string;
  /** The type the magic-byte check determined, never the one the client declared (FR-295). */
  readonly contentType: InstrumentIconContentType;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Always `MANUAL` from any application path (FR-301, AC-305) — see {@link SetInstrumentIconParams}. */
  readonly source: InstrumentIconSource;
  readonly updatedAt: Date;
}

/**
 * **There is deliberately no `source` field, and that is AC-305's second half
 * expressed as a compile-time property rather than a runtime check.** FR-301
 * asks for a provenance seam — both `MANUAL` and `PROVIDER` representable in
 * the column, with **no** CHECK narrowing it — and pairs it with "no
 * application-reachable path produces `PROVIDER` today". A guard that read a
 * `source` parameter and refused `PROVIDER` would satisfy the second half only
 * as long as the guard survived; a parameter type that cannot express it makes
 * a would-be `PROVIDER` write a type error at the call site, and
 * {@link setInstrumentIcon} writes the literal `'MANUAL'` on **both** arms of
 * its upsert. The later provider lane will add its own function, and that is
 * the DDL-free change the seam exists to allow.
 */
export interface SetInstrumentIconParams {
  readonly tenantId: string;
  readonly instrumentId: string;
  /** Stored **verbatim** — no re-encode, no metadata strip, no normalisation (FR-295, SD-4). */
  readonly bytes: Uint8Array;
  /** From `sniffInstrumentIcon`'s verdict, not from the request's declared type (FR-292, FR-295). */
  readonly contentType: InstrumentIconContentType;
  readonly widthPx: number;
  readonly heightPx: number;
  /**
   * Testing-only override of {@link INSTRUMENT_ICON_TENANT_ROW_CAP} —
   * production callers never supply this. Lets FR-302's cap be exercised
   * against a real Postgres instance without seeding 500 rows of real image
   * bytes. The `maxRowsPerTenant` precedent is
   * `manual-price-service.ts`'s {@link UpsertManualPricePointParams}.
   */
  readonly maxRowsPerTenant?: number;
}

/** Re-asserts SD-1/SD-2/SD-3 at the service boundary — see {@link InstrumentIconBoundsError}. */
function assertStorableIcon(params: SetInstrumentIconParams): void {
  if (params.bytes.length < 1 || params.bytes.length > INSTRUMENT_ICON_MAX_BYTES) {
    throw new InstrumentIconBoundsError(
      "BYTE_LENGTH",
      params.instrumentId,
      `${params.bytes.length} bytes is outside 1..${INSTRUMENT_ICON_MAX_BYTES}`,
    );
  }
  for (const [axis, value] of [
    ["widthPx", params.widthPx],
    ["heightPx", params.heightPx],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > INSTRUMENT_ICON_MAX_PIXELS) {
      throw new InstrumentIconBoundsError(
        "DIMENSIONS",
        params.instrumentId,
        `${axis} ${value} is outside 1..${INSTRUMENT_ICON_MAX_PIXELS}`,
      );
    }
  }
  // Checked at run time as well as in the type: this service's stated reason
  // for existing is the caller that is *not* the Zod-validated route.
  if (!INSTRUMENT_ICON_CONTENT_TYPES.includes(params.contentType)) {
    throw new InstrumentIconBoundsError(
      "CONTENT_TYPE",
      params.instrumentId,
      `content type is outside the closed set [${INSTRUMENT_ICON_CONTENT_TYPES.join(", ")}]`,
    );
  }
}

/**
 * Stores or replaces this tenant's icon for `instrumentId` — the table's own
 * primary key, so a set on an instrument that already has one **is** a
 * replace, not a second row (FR-296).
 *
 * **FR-297's atomicity comes from the single statement, not from a
 * compensating action.** The write is one `INSERT … ON CONFLICT DO UPDATE`:
 * every rejection above happens before it and writes nothing, and if the
 * statement itself fails (a CHECK, the FK) the row is untouched because
 * Postgres never applied it. There is deliberately **no delete-then-insert
 * pair**, because that opens exactly the window FR-297's last sentence
 * forbids — a failed replace leaving an instrument with no icon. The absence
 * is measured on the wire in
 * `instrument-icon-service.integration.test.ts`, not merely asserted here.
 *
 * The cap is consulted **only when the row is absent** (FR-302's exemption),
 * so a tenant at the cap can still correct an existing icon forever. The
 * `count(*)` is an index-only scan of the PK's `tenant_id` prefix and the cap
 * is its own bound (≤ 500 entries) — the argument already made for
 * `manual_price_point`'s 500 000-row count, which applies far more easily
 * here. Its TOCTOU window is the same soft-cap trade-off N11 records there:
 * concurrent inserts for genuinely new instruments can overshoot by the number
 * of writers, which the per-tenant concurrency cap of 2 already bounds.
 */
export async function setInstrumentIcon(
  db: Db,
  params: SetInstrumentIconParams,
): Promise<InstrumentIconMeta> {
  assertStorableIcon(params);

  const cap = params.maxRowsPerTenant ?? INSTRUMENT_ICON_TENANT_ROW_CAP;
  // `Buffer.from(view)` **copies**, and the copy is the point: the
  // `Buffer.from(view.buffer)` form reads the whole backing store, so a
  // `Uint8Array` view at a non-zero `byteOffset` would store a neighbouring
  // payload's bytes. `instrument-icon-sniff-robustness.test.ts` guards the
  // reader against exactly that shape; this is the same hazard on the write.
  const bytes = Buffer.from(params.bytes);
  const updatedAt = new Date();

  return withTenant(db, params.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ tenantId: instrumentIcon.tenantId })
      .from(instrumentIcon)
      .where(
        and(
          eq(instrumentIcon.tenantId, params.tenantId),
          eq(instrumentIcon.instrumentId, params.instrumentId),
        ),
      );
    if (!existing) {
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(instrumentIcon)
        .where(eq(instrumentIcon.tenantId, params.tenantId));
      const count = countRows[0]?.count ?? 0;
      if (count >= cap) {
        throw new InstrumentIconTenantCapExceededError(params.tenantId, cap);
      }
    }

    const [row] = await tx
      .insert(instrumentIcon)
      .values({
        tenantId: params.tenantId,
        instrumentId: params.instrumentId,
        bytes,
        contentType: params.contentType,
        byteLength: bytes.length,
        widthPx: params.widthPx,
        heightPx: params.heightPx,
        // AC-305: the literal, on the insert arm. `SetInstrumentIconParams`
        // has no `source` field, so there is nothing else this could be.
        source: "MANUAL",
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [instrumentIcon.tenantId, instrumentIcon.instrumentId],
        set: {
          bytes: sql`excluded.bytes`,
          contentType: sql`excluded.content_type`,
          byteLength: sql`excluded.byte_length`,
          widthPx: sql`excluded.width_px`,
          heightPx: sql`excluded.height_px`,
          // AC-305 again, on the conflict arm — `excluded.source` would be
          // the same literal today, but this says it outright so a future
          // widening of the insert arm cannot travel here silently.
          source: sql`'MANUAL'`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      // Partial `returning`: `bytes` is deliberately not read back. The caller
      // just sent it, and up to 256 KiB per upload of pure round-trip is a
      // cost with no consumer.
      .returning({
        tenantId: instrumentIcon.tenantId,
        instrumentId: instrumentIcon.instrumentId,
        contentType: instrumentIcon.contentType,
        byteLength: instrumentIcon.byteLength,
        widthPx: instrumentIcon.widthPx,
        heightPx: instrumentIcon.heightPx,
        source: instrumentIcon.source,
        updatedAt: instrumentIcon.updatedAt,
      });

    return row!;
  });
}

/**
 * Removes this tenant's icon for `instrumentId`, if there is one.
 *
 * **Idempotent by construction** — one `DELETE` whose zero-row outcome is not
 * an error. The route answers `204` whether or not a row existed
 * because this feature's own removal capability creates the TOCTOU: two tabs,
 * or a double-click, would otherwise make the second attempt an error for
 * having succeeded.
 */
export async function removeInstrumentIcon(
  db: Db,
  params: { readonly tenantId: string; readonly instrumentId: string },
): Promise<void> {
  await withTenant(db, params.tenantId, async (tx) => {
    await tx
      .delete(instrumentIcon)
      .where(
        and(
          eq(instrumentIcon.tenantId, params.tenantId),
          eq(instrumentIcon.instrumentId, params.instrumentId),
        ),
      );
  });
}

/**
 * This tenant's stored icon bytes for `instrumentId`, or `null` — one lookup
 * on the whole primary key.
 *
 * **`instrument` is never read** (FR-305): "another tenant owns an icon for
 * this instrument", "nobody has iconed it" and "no such instrument" are the
 * same code path producing the same `null`, not three branches that happen to
 * agree, so the read route cannot become an existence oracle.
 */
export async function getInstrumentIcon(
  db: Db,
  params: { readonly tenantId: string; readonly instrumentId: string },
): Promise<{ bytes: Buffer; contentType: InstrumentIconContentType } | null> {
  return withTenant(db, params.tenantId, async (tx) => {
    const [row] = await tx
      .select({ bytes: instrumentIcon.bytes, contentType: instrumentIcon.contentType })
      .from(instrumentIcon)
      .where(
        and(
          eq(instrumentIcon.tenantId, params.tenantId),
          eq(instrumentIcon.instrumentId, params.instrumentId),
        ),
      );
    return row ?? null;
  });
}

/**
 * Which of `instrumentIds` this tenant has an icon for — one bounded lookup,
 * never one request per row (FR-313/FR-314's whole point).
 *
 * Returns only the ids, and only the ones present: the `bytes` column is never
 * selected, so a presence probe over a page of instruments costs the PK index
 * and nothing else.
 */
export async function listInstrumentIdsWithIcon(
  db: Db,
  params: { readonly tenantId: string; readonly instrumentIds: readonly string[] },
): Promise<ReadonlySet<string>> {
  if (params.instrumentIds.length === 0) return new Set();
  return withTenant(db, params.tenantId, async (tx) => {
    const rows = await tx
      .select({ instrumentId: instrumentIcon.instrumentId })
      .from(instrumentIcon)
      .where(
        and(
          eq(instrumentIcon.tenantId, params.tenantId),
          inArray(instrumentIcon.instrumentId, [...params.instrumentIds]),
        ),
      );
    return new Set(rows.map((row) => row.instrumentId));
  });
}
