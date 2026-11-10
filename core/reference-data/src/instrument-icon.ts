/**
 * The instrument-icon ceilings and vocabularies (IK1, SD-1–SD-5,
 * FR-292–FR-295, FR-301).
 *
 * Sibling of `exchange-mic.ts`/`sector.ts`/`country.ts` and, for the reason
 * this package's own header states, deliberately **framework-free**: `web`
 * validates the same rules client-side as a pre-flight and
 * `.dependency-cruiser.cjs`'s `web-no-server-runtime-imports` only admits
 * `core/*` into `web/src`. Putting these four numbers here rather than in
 * `ledger` is what lets `web` import them at runtime with **no**
 * `web/src/lib/api-limits.ts` mirror and no new depcruise exception. The
 * per-tenant **row cap** is the opposite case — it is enforced by a `ledger`
 * service, so it lives there with a mirror + drift test, exactly as
 * `MANUAL_PRICE_POINT_TENANT_ROW_CAP` does. Two homes, two precedents, stated
 * here because a reader will otherwise read the split as an inconsistency.
 */

/**
 * SD-1 — the two accepted formats, and nothing else. SVG, GIF, WebP and AVIF
 * are rejected: SVG because the bytes are served **same-origin** and an XML
 * document in this app's own origin would lean on the CSP as a primary
 * control (and would need an XML parser plus a sanitiser this repo does not
 * have — V14); the raster three for proportion, since two formats cover every
 * file a user's OS or image editor produces and the closed set keeps the
 * magic-byte check and its fixture table small.
 *
 * Spread into `instrumentIconContentTypeEnum`
 * (`platform/db/src/schema/instrument-icon.ts`), so the database type and this
 * tuple are the same list by construction — the `instrumentSectorEnum`/
 * `SECTOR_CODES` construction. Member **order** is therefore load-bearing:
 * `instrument-icon-schema.integration.test.ts` compares `pg_enum`'s labels to
 * this array in order.
 */
export const INSTRUMENT_ICON_CONTENT_TYPES = ["image/png", "image/jpeg"] as const;

/** One of {@link INSTRUMENT_ICON_CONTENT_TYPES}. */
export type InstrumentIconContentType = (typeof INSTRUMENT_ICON_CONTENT_TYPES)[number];

/**
 * FR-301's provenance seam. Both values are representable from day one and
 * **no** CHECK narrows the stored value to `MANUAL` — a
 * `CHECK (source = 'MANUAL')` would defeat the seam, since the later provider
 * fetch would then need a DDL change to the icon model. "No application path
 * produces `PROVIDER` today" is a test (AC-305) and a compile-time property of
 * `SetInstrumentIconParams`, not a constraint.
 */
export const INSTRUMENT_ICON_SOURCES = ["MANUAL", "PROVIDER"] as const;

/** One of {@link INSTRUMENT_ICON_SOURCES}. */
export type InstrumentIconSource = (typeof INSTRUMENT_ICON_SOURCES)[number];

/**
 * SD-2 — 256 KiB, exactly, and the boundary is **inclusive**: a payload of
 * exactly this many bytes is accepted.
 *
 * An abuse bound, not a working constraint (the framing `importer/src/limits.ts`
 * uses for its own cap). It sits inside both existing 1 MiB transport bounds,
 * so no existing limit has to move, and because the bytes are stored in
 * Postgres and read on the display path this one number is simultaneously the
 * ceiling on stored size, on response size, and on what one request buffers.
 */
export const INSTRUMENT_ICON_MAX_BYTES = 262_144;

/**
 * SD-3 — 512 × 512, inclusive on both axes. The largest surface that renders
 * an icon is the 38px detail badge, so at a device pixel ratio of 3 the
 * largest real need is ~114px; 512 is over 4× that while still bounding what
 * a browser decodes (512 × 512 × 4 B ≈ 1 MiB), which matters because SD-4
 * means the server never decodes and the browser is the only decoder in the
 * path. **No minimum**: a 16×16 upload is ugly, not unsafe.
 */
export const INSTRUMENT_ICON_MAX_PIXELS = 512;

/**
 * The largest base64 payload that can decode to {@link INSTRUMENT_ICON_MAX_BYTES}
 * — 4 characters per 3 bytes, rounded up to a whole quantum, padding
 * included. `4 * ceil(262144 / 3)` = 349 528.
 *
 * **Derived, never typed as a literal.** A second hand-written number would be
 * a copy that drifts the first time the byte ceiling moves; here changing
 * `INSTRUMENT_ICON_MAX_BYTES` moves this with it, which
 * `instrument-icon.schema.test.ts` asserts by recomputing the expression
 * against a different byte ceiling.
 */
export const INSTRUMENT_ICON_MAX_BASE64_CHARS = 4 * Math.ceil(INSTRUMENT_ICON_MAX_BYTES / 3);
