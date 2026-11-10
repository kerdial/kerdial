import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import supertest from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUMENT_ICON_MAX_BASE64_CHARS,
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { DEFAULT_IMPORT_LIMITS, KERDIAL_CSV_LIMITS, KERDIAL_JSON_LIMITS } from "@kerdial/importer";
import { INSTRUMENT_ICON_TENANT_ROW_CAP, getInstrumentIcon } from "@kerdial/ledger";
import { createUser } from "@kerdial/platform-auth";
import { instrument, instrumentIcon, tenant, withTenant } from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";
import { IMPORT_MULTIPART_PATHS } from "./imports/multipart.js";

/**
 * **IK-8 — GATE-2**, the blocking, independently authored known-answer gate
 * for the `instrument-icons` write path
 * (IK-8; AC-300, AC-301,
 * AC-304, AC-305).
 *
 * Written by a tester who did not write the code and does not reuse the
 * implementer's fixtures: every image below is built here, from the format's
 * own bytes, by a builder in this file. Where the implementer's PNG is a
 * header plus filler, these are **real** PNGs — signature, CRC-checked IHDR,
 * a zlib-deflated IDAT and an IEND — so an "accepted" row means the bytes a
 * browser would actually render were stored, not that a 24-byte prefix
 * satisfied a reader.
 *
 * What this file decides, and why each block cannot pass for the wrong reason:
 *
 *  - **AC-300, all twelve rows of the spec table, over HTTP.** Each row
 *    states its own status *and* machine-readable code. Accepted rows are
 *    asserted on the **stored** content type, the **stored** dimensions and
 *    **stored bytes byte-equal to the fixture**; rejected rows are asserted
 *    to have stored **nothing**, read back from `instrument_icon` as the
 *    owner. The response is never the evidence for a persistence claim.
 *    Rows 5 and 6 (GIF, WebP) exist nowhere over HTTP today — the
 *    implementer's table has no GIF and no WebP row at all — and each is
 *    asserted **twice**, since the declared type and the leading bytes are
 *    two separate closed sets and the boundary row exercises the first while
 *    the security property lives in the second.
 *  - **AC-300's atomicity half (FR-297).** Every rejecting row re-run against
 *    an instrument that already carries row 1's PNG, with the *whole stored
 *    row* — bytes, type, dimensions, byte length, `source` **and
 *    `updated_at`** — asserted unchanged afterwards. `updated_at` is the
 *    tightening: a replace that ran and then rolled back would leave the
 *    bytes right and the timestamp wrong.
 *  - **AC-301, the session half, on a shared catalogue row.** GATE-1 proved
 *    the isolation as a database fact. This is the same property addressed
 *    through a logged-in session over HTTP: tenant B, holding a valid
 *    session, cannot see, overwrite or delete tenant A's icon for the same
 *    shared instrument, and B's own `PUT` creates a **second** row rather
 *    than replacing A's (FR-299).
 *  - **AC-304 at the boundary, in three directions.** The cap is a live
 *    `count(*)`, so the 500th distinct instrument is accepted, the 501st
 *    refused, a replace at the cap still accepted, **and** the refused one
 *    becomes acceptable after a single `DELETE` — the last is what
 *    distinguishes a live count from a number decided once.
 *  - **AC-305, both halves.** Every application write route's stored
 *    `source`, read off the table; a `PROVIDER` row inserted as the real
 *    `app_web` role with no DDL change; and the out-of-band-correction
 *    property the implementer claims as a compile-time one, asserted
 *    behaviourally — a row made `PROVIDER` out of band is `MANUAL` again
 *    after a replace, which is false if the conflict arm ever stops writing
 *    the literal.
 *
 * **Lane:** `pnpm test` (`test:main`). Checked: `vitest.config.ts`'s
 * `api/**\/src/**\/*.test.ts` include matches, and none of `package.json:28`'s
 * twelve `--exclude` basenames is `instrument-icon.e2e.test.ts`.
 *
 * **Throttle budget.** This file never calls `POST /instruments` — every
 * fixture instrument is inserted with the owner handle — so no
 * `POST /instruments` is made at all (the 30/hour rate cap that motivated
 * this is gone now; the tidiness stays).
 */

const USER_PASSWORD = "correct horse battery staple ik8 gate2 instrument icon";

/* ------------------------------------------------------------------------- *
 * Fixture builders — real files, from the formats' own bytes.
 * ------------------------------------------------------------------------- */

/** One PNG chunk: length, type, data, CRC32 over type+data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A **real** PNG of `width` x `height`: signature, IHDR (8-bit RGB), a
 * zlib-deflated IDAT of that many zeroed scanlines, and IEND. When
 * `padToBytes` is given, an ancillary `zzZz` chunk of filler is inserted
 * before IEND until the file is *exactly* that long — which keeps the file a
 * structurally valid PNG while letting a byte-ceiling row sit on an exact
 * number (PNG chunk overhead is 12 bytes, so any target from ~90 bytes up is
 * reachable).
 */
function png(width: number, height: number, padToBytes?: number): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", deflateSync(raw)),
  ];
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const soFar = chunks.reduce((sum, c) => sum + c.length, 0) + iend.length;
  if (padToBytes === undefined) return Buffer.concat([...chunks, iend]);
  const fillerData = padToBytes - soFar - 12;
  if (fillerData < 0) {
    throw new Error(
      `png(${width},${height}) is already ${soFar} bytes, cannot pad to ${padToBytes}`,
    );
  }
  return Buffer.concat([...chunks, pngChunk("zzZz", Buffer.alloc(fillerData, 0x37)), iend]);
}

/**
 * A JPEG whose header states `width` x `height`: SOI, a JFIF APP0, a COM
 * comment carrying `padToBytes` worth of filler, a baseline SOF0, SOS, EOI.
 * Deliberately a different construction from the implementer's header-only
 * JPEG — the marker walk has to step over two payload-carrying segments
 * before it reaches the frame header, which a reader that only looked at a
 * fixed offset would fail.
 */
function jpeg(width: number, height: number, padToBytes = 0): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0", "ascii"),
    Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  // Conformant: an SOF declares `L = 8 + 3 * Nf`, so one component is
  // `L = 11` in a 13-byte segment with a 3-byte component descriptor. This
  // builder used to declare `L = 9` with a 1-byte descriptor, a shape no
  // encoder emits and the reader's guard now refuses.
  const sof = Buffer.alloc(13);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // Nf: one component
  sof[10] = 1; // component id
  sof[11] = 0x11; // sampling factors: 1x1
  sof[12] = 0; // quantisation-table selector
  const tail = Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const fixed = 2 + app0.length + sof.length + tail.length;
  const commentPayload = Math.max(0, padToBytes - fixed - 4);
  const comment = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    (() => {
      const l = Buffer.alloc(2);
      l.writeUInt16BE(commentPayload + 2, 0);
      return l;
    })(),
    Buffer.alloc(commentPayload, 0x20),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    ...(commentPayload > 0 ? [comment] : []),
    sof,
    tail,
  ]);
}

/** `GIF89a` plus a logical-screen descriptor stating 128 x 128 — a real GIF's leading bytes. */
const VALID_GIF = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([0x80, 0x00, 0x80, 0x00, 0xf7, 0x00, 0x00]),
]);

/** `RIFF` + size + `WEBPVP8 ` — a lossy WebP's leading bytes. */
const VALID_WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
]);

/** An SVG document. FR-292's "named `logo.png`" has no wire representation here: the body carries no filename field at all, which is asserted in its own case below. */
const SVG_DOCUMENT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128"/></svg>',
  "utf8",
);

/** Row 1's fixture, and the α of every atomicity and isolation case below. */
const PNG_128 = png(128, 128, 3182);
/** Row 2's fixture. */
const JPEG_128 = jpeg(128, 128, 6144);

describe("api — GATE-2 (IK-8): the icon write path's known answers, atomicity and isolation over HTTP", () => {
  let testApp: TestApp;
  /** Tenant A — the subject of most rows. */
  let alpha: { tenantId: string; sid: string; csrf: string };
  /** Tenant B — the *other* logged-in session, for AC-301. */
  let beta: { tenantId: string; sid: string; csrf: string };

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  type Session = { sid: string; csrf: string };

  function putIcon(id: string, body: unknown, session: Session) {
    return server()
      .put(`/api/v1/instruments/${id}/icon`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body as object);
  }

  function deleteIcon(id: string, session: Session) {
    return server()
      .delete(`/api/v1/instruments/${id}/icon`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  const bodyFor = (bytes: Buffer, declaredContentType = "image/png") => ({
    declaredContentType,
    bytesBase64: bytes.toString("base64"),
  });

  let fixtureCounter = 0;
  /**
   * A shared-catalogue instrument (`owner_tenant_id IS NULL`), inserted with
   * the owner handle. Never `POST /instruments`: that route carries the
   * 30/hour rate cap this file must not spend.
   */
  async function newInstrument(): Promise<string> {
    fixtureCounter += 1;
    const id = randomUUID();
    await testApp.ownerDb.insert(instrument).values({
      id,
      kind: "CRYPTO",
      displayName: `IK-8 gate2 fixture ${fixtureCounter}`,
      listingCurrency: "EUR",
      symbol: `IK8G2${String(fixtureCounter).padStart(6, "0")}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    return id;
  }

  /** The stored row, read as the owner (BYPASSRLS) — the response body is never the evidence. */
  async function storedRow(instrumentId: string, tenantId: string) {
    const [found] = await testApp.ownerDb
      .select()
      .from(instrumentIcon)
      .where(
        and(eq(instrumentIcon.tenantId, tenantId), eq(instrumentIcon.instrumentId, instrumentId)),
      );
    return found;
  }

  /** Every tenant's row for one instrument — for FR-299's "a second row, not an overwrite". */
  async function allRowsFor(instrumentId: string) {
    return testApp.ownerDb
      .select()
      .from(instrumentIcon)
      .where(eq(instrumentIcon.instrumentId, instrumentId));
  }

  async function newTenantSession(label: string): Promise<{
    tenantId: string;
    sid: string;
    csrf: string;
  }> {
    const tenantId = randomUUID();
    const email = `ik8-${label}-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: USER_PASSWORD });
    const session = await loginAs(server(), email, USER_PASSWORD);
    return { tenantId, ...session };
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    alpha = await newTenantSession("a");
    beta = await newTenantSession("b");
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  /* ===================================================================== *
   * AC-300 — the twelve-row known-answer table, over HTTP.
   * ===================================================================== */

  describe("AC-300 — the twelve-row fixture table, over HTTP, status AND code, stored AND not stored", () => {
    interface AcceptedRow {
      readonly row: number;
      readonly label: string;
      readonly declared: string;
      readonly bytes: Buffer;
      readonly storedContentType: "image/png" | "image/jpeg";
      readonly widthPx: number;
      readonly heightPx: number;
    }
    interface RejectedRow {
      readonly row: number;
      readonly label: string;
      readonly declared: string;
      readonly bytes: Buffer;
      readonly status: number;
      readonly code: string;
    }

    /** Rows 1, 2, 7 and 9 — hand-stated expected outputs, not derived from the code. */
    const accepted: readonly AcceptedRow[] = [
      {
        row: 1,
        label: "a valid 128x128 PNG of 3 182 bytes declared image/png",
        declared: "image/png",
        bytes: PNG_128,
        storedContentType: "image/png",
        widthPx: 128,
        heightPx: 128,
      },
      {
        row: 2,
        label: "a valid 128x128 JPEG of 6 144 bytes declared image/jpeg",
        declared: "image/jpeg",
        bytes: JPEG_128,
        storedContentType: "image/jpeg",
        widthPx: 128,
        heightPx: 128,
      },
      {
        row: 7,
        label: `a valid PNG of exactly ${INSTRUMENT_ICON_MAX_BYTES} bytes`,
        declared: "image/png",
        bytes: png(64, 64, INSTRUMENT_ICON_MAX_BYTES),
        storedContentType: "image/png",
        widthPx: 64,
        heightPx: 64,
      },
      {
        row: 9,
        label: "a valid PNG of exactly 512 x 512",
        declared: "image/png",
        bytes: png(INSTRUMENT_ICON_MAX_PIXELS, INSTRUMENT_ICON_MAX_PIXELS),
        storedContentType: "image/png",
        widthPx: 512,
        heightPx: 512,
      },
    ];

    /**
     * Rows 3, 4, 5, 6, 8, 10, 11, 12 — each with the status and code stated
     * by hand from the taxonomy, not read off the implementation.
     *
     * Rows 5 and 6 appear **twice**. The boundary table declares the GIF as
     * `image/gif` and the WebP as `image/webp`, which the body schema's
     * `declaredContentType` enum refuses before the bytes are ever looked at
     * — a real rejection, and the one a client sending an honestly-labelled
     * GIF gets, but it says nothing about the *bytes*. The `-b` variants
     * declare the same bytes as `image/png`, which is how a caller would
     * actually try to smuggle a GIF past a type check, and that is where
     * FR-292's closed set of **signatures** is what refuses it.
     */
    const rejected: readonly RejectedRow[] = [
      {
        row: 3,
        label: "the same valid PNG declared image/jpeg",
        declared: "image/jpeg",
        bytes: PNG_128,
        status: 422,
        code: "INSTRUMENT_ICON_TYPE_MISMATCH",
      },
      {
        row: 4,
        label: "an <svg> document declared image/png",
        declared: "image/png",
        bytes: SVG_DOCUMENT,
        status: 422,
        code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT",
      },
      {
        row: 5,
        label: "a valid GIF declared image/gif (the declared closed set refuses it)",
        declared: "image/gif",
        bytes: VALID_GIF,
        status: 400,
        code: "VALIDATION_ERROR",
      },
      {
        row: 5.5,
        label: "the same valid GIF declared image/png (the signature closed set refuses it)",
        declared: "image/png",
        bytes: VALID_GIF,
        status: 422,
        code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT",
      },
      {
        row: 6,
        label: "a valid WebP declared image/webp (the declared closed set refuses it)",
        declared: "image/webp",
        bytes: VALID_WEBP,
        status: 400,
        code: "VALIDATION_ERROR",
      },
      {
        row: 6.5,
        label: "the same valid WebP declared image/png (the signature closed set refuses it)",
        declared: "image/png",
        bytes: VALID_WEBP,
        status: 422,
        code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT",
      },
      {
        row: 8,
        label: `a valid PNG of exactly ${INSTRUMENT_ICON_MAX_BYTES + 1} bytes`,
        declared: "image/png",
        bytes: png(64, 64, INSTRUMENT_ICON_MAX_BYTES + 1),
        status: 413,
        code: "INSTRUMENT_ICON_TOO_LARGE",
      },
      {
        row: 10,
        label: "a valid PNG of 513 x 512",
        declared: "image/png",
        bytes: png(INSTRUMENT_ICON_MAX_PIXELS + 1, INSTRUMENT_ICON_MAX_PIXELS),
        status: 422,
        code: "INSTRUMENT_ICON_DIMENSIONS_EXCEEDED",
      },
      {
        row: 11,
        label: "a PNG truncated after 20 bytes, inside its IHDR (row 11 as amended 2026-09-04)",
        declared: "image/png",
        bytes: PNG_128.subarray(0, 20),
        status: 422,
        code: "INSTRUMENT_ICON_UNREADABLE",
      },
      {
        row: 12,
        label: "a zero-byte body",
        declared: "image/png",
        bytes: Buffer.alloc(0),
        status: 422,
        code: "INSTRUMENT_ICON_UNSUPPORTED_FORMAT",
      },
    ];

    it("the fixtures really are what the table says they are — the known answers are known before the route runs", () => {
      // A table of fixtures nobody checked is a table of unknown answers. Each
      // of these is a property of the *bytes*, independent of the route.
      expect(PNG_128.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(PNG_128).toHaveLength(3182);
      expect(PNG_128.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(PNG_128.readUInt32BE(16)).toBe(128);
      expect(PNG_128.readUInt32BE(20)).toBe(128);
      // …and the IHDR's CRC is correct, so this is a file a decoder accepts,
      // not just a prefix the sniffer accepts.
      expect(PNG_128.readUInt32BE(29)).toBe(
        crc32(Buffer.concat([Buffer.from("IHDR", "ascii"), PNG_128.subarray(16, 29)])) >>> 0,
      );
      expect(JPEG_128.subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(JPEG_128).toHaveLength(6144);
      expect(VALID_GIF.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      expect(VALID_WEBP.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(SVG_DOCUMENT.subarray(0, 4).toString("ascii")).toBe("<svg");
      expect(accepted.find((r) => r.row === 7)!.bytes).toHaveLength(INSTRUMENT_ICON_MAX_BYTES);
      expect(rejected.find((r) => r.row === 8)!.bytes).toHaveLength(INSTRUMENT_ICON_MAX_BYTES + 1);
      expect(accepted.find((r) => r.row === 9)!.bytes.readUInt32BE(16)).toBe(512);
      expect(rejected.find((r) => r.row === 10)!.bytes.readUInt32BE(16)).toBe(513);
      expect(rejected.find((r) => r.row === 11)!.bytes).toHaveLength(20);
    });

    it("all twelve boundary rows are present — a missing row is an untested boundary", () => {
      const rows = [...accepted.map((r) => r.row), ...rejected.map((r) => r.row)]
        .filter((row) => Number.isInteger(row))
        .sort((a, b) => a - b);
      expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it.each(accepted.map((r) => [`row ${r.row}: ${r.label}`, r] as const))(
      "%s is ACCEPTED, and the STORED row is the sniffed type and the fixture's own bytes",
      async (_label, spec) => {
        const id = await newInstrument();

        const response = await putIcon(id, bodyFor(spec.bytes, spec.declared), alpha);

        expect(response.status).toBe(200);
        const stored = await storedRow(id, alpha.tenantId);
        expect(stored).toBeDefined();
        // The stored bytes, byte-for-byte — FR-295's "verbatim, no re-encode".
        expect(Buffer.from(stored!.bytes).equals(spec.bytes)).toBe(true);
        expect(stored!.contentType).toBe(spec.storedContentType);
        expect(stored!.byteLength).toBe(spec.bytes.length);
        expect(stored!.widthPx).toBe(spec.widthPx);
        expect(stored!.heightPx).toBe(spec.heightPx);
        expect(stored!.source).toBe("MANUAL");
        // FR-296: one row per (tenant, instrument), never a second.
        expect(await allRowsFor(id)).toHaveLength(1);
      },
      60_000,
    );

    it.each(rejected.map((r) => [`row ${r.row}: ${r.label}`, r] as const))(
      "%s is REJECTED with its own status and code, and stores NOTHING",
      async (_label, spec) => {
        const id = await newInstrument();

        const response = await putIcon(id, bodyFor(spec.bytes, spec.declared), alpha);

        expect(response.status).toBe(spec.status);
        expect(response.body.code).toBe(spec.code);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        // Queried, never inferred from the response.
        expect(await allRowsFor(id)).toHaveLength(0);
      },
      60_000,
    );

    it("the table DISCRIMINATES — five distinct codes over three statuses, and no two causes share a code they should not", () => {
      // Every row above is individually satisfiable by a route that answers
      // one thing to everything, so long as that thing is what the row
      // expects. This asserts the table itself spans the taxonomy, and — the
      // part a code-count alone misses — that the four causes which are
      // *meant* to be distinguishable really are.
      const byRow = new Map(rejected.map((r) => [r.row, r]));
      const distinct = [3, 4, 8, 10, 11].map((row) => byRow.get(row)!.code);
      expect(new Set(distinct).size).toBe(5);
      expect(new Set(rejected.map((r) => r.status))).toEqual(new Set([400, 413, 422]));
      // A type mismatch is not the same answer as an unsupported signature —
      // "the disagreement is itself the signal" (FR-292) collapses if it is.
      expect(byRow.get(3)!.code).not.toBe(byRow.get(4)!.code);
      // A header that cannot be read is not the same answer as a format that
      // is not accepted (FR-294's explicit clause).
      expect(byRow.get(11)!.code).not.toBe(byRow.get(4)!.code);
      // A byte ceiling is not a pixel ceiling.
      expect(byRow.get(8)!.code).not.toBe(byRow.get(10)!.code);
      expect(byRow.get(8)!.status).not.toBe(byRow.get(10)!.status);
    });

    it("row 7 is accepted DESPITE sitting exactly on the encoded ceiling too — it is not the encoded check that lets it through", async () => {
      // The trap this row exists to catch: an over-strict encoded-length
      // comparison (`>=` instead of `>`) would refuse the byte-exact file
      // with a 413 for a reason that has nothing to do with its 262 144
      // bytes, and the row would then be "rejected" for the wrong cause.
      const exact = accepted.find((r) => r.row === 7)!.bytes;
      const encoded = exact.toString("base64");
      expect(encoded).toHaveLength(INSTRUMENT_ICON_MAX_BASE64_CHARS);

      const id = await newInstrument();
      const response = await putIcon(id, bodyFor(exact), alpha);
      expect(response.status).toBe(200);
      expect(response.body.byteLength).toBe(INSTRUMENT_ICON_MAX_BYTES);

      // …and one byte more is refused — but NOT by the encoded check, which is
      // the next case's whole subject.
      const over = rejected.find((r) => r.row === 8)!.bytes;
      const overResponse = await putIcon(await newInstrument(), bodyFor(over), alpha);
      expect(overResponse.status).toBe(413);
      expect(overResponse.body.code).toBe("INSTRUMENT_ICON_TOO_LARGE");
    }, 60_000);

    it("row 8 is refused by the DECODED check, not the encoded one — base64 is flat over a 3-byte group, so the pair is load-bearing and not belt-and-braces", async () => {
      // **Measured, and it contradicts the original justification for step 5**
      // ("belt and braces; step 3 already implies it"). `4 * ceil(n / 3)` is
      // monotonic but not *strictly* monotonic: it is flat across each 3-byte
      // group, so 262 144, 262 145 and 262 146 bytes all encode to exactly
      // 349 528 characters — the ceiling. Step 3 therefore lets rows 8's
      // payload through unrefused, and the decoded-length check at step 5 is
      // the only thing that refuses it. Removing step 5 as "implied" — which
      // the design's wording invites — would accept a payload over SD-2's
      // ceiling as far as the validator is concerned.
      const sizes = [
        INSTRUMENT_ICON_MAX_BYTES + 1,
        INSTRUMENT_ICON_MAX_BYTES + 2,
        INSTRUMENT_ICON_MAX_BYTES + 3,
      ];
      const encodedLengths = sizes.map((n) => png(64, 64, n).toString("base64").length);
      // The first two are indistinguishable from the accepted boundary by
      // encoded length alone; only the third is over it.
      expect(encodedLengths).toEqual([
        INSTRUMENT_ICON_MAX_BASE64_CHARS,
        INSTRUMENT_ICON_MAX_BASE64_CHARS,
        INSTRUMENT_ICON_MAX_BASE64_CHARS + 4,
      ]);

      // All three are refused all the same, with the same code — which is the
      // behaviour the spec asks for, reached by two different checks.
      for (const size of sizes) {
        const response = await putIcon(await newInstrument(), bodyFor(png(64, 64, size)), alpha);
        expect(response.status, `${size} bytes`).toBe(413);
        expect(response.body.code, `${size} bytes`).toBe("INSTRUMENT_ICON_TOO_LARGE");
      }
    }, 60_000);

    it("the encoded-length check runs BEFORE the decode — an over-long payload that also cannot decode answers 413, and the same payload inside the ceiling answers the decoder's 400", async () => {
      // Two mutually exclusive witnesses, so this is an *ordering* assertion
      // rather than a length one: a route that decoded first would answer
      // INSTRUMENT_ICON_MALFORMED_BASE64 to the first request. Independently
      // constructed here rather than inherited: the payload is inside the
      // body schema's alphabet (so step 2 passes it), one character over the
      // ceiling, and of a length that cannot round-trip.
      const overLong = "Q".repeat(INSTRUMENT_ICON_MAX_BASE64_CHARS + 1);
      expect(overLong.length % 4).not.toBe(0);
      const first = await putIcon(
        await newInstrument(),
        {
          declaredContentType: "image/png",
          bytesBase64: overLong,
        },
        alpha,
      );
      expect(first.status).toBe(413);
      expect(first.body.code).toBe("INSTRUMENT_ICON_TOO_LARGE");

      const inside = "Q".repeat(INSTRUMENT_ICON_MAX_BASE64_CHARS - 1);
      expect(inside.length % 4).not.toBe(0);
      const second = await putIcon(
        await newInstrument(),
        {
          declaredContentType: "image/png",
          bytesBase64: inside,
        },
        alpha,
      );
      expect(second.status).toBe(400);
      expect(second.body.code).toBe("INSTRUMENT_ICON_MALFORMED_BASE64");
    }, 60_000);
  });

  /* ===================================================================== *
   * AC-300's atomicity half — FR-297.
   * ===================================================================== */

  describe("AC-300 / FR-297 — every rejection re-run against an instrument that ALREADY carries row 1's PNG leaves it untouched", () => {
    /**
     * The eight rejecting causes, re-expressed as bodies. One case per cause,
     * each run against an instrument holding α — and the assertion is on the
     * **whole stored row**, `updated_at` included. A replace that ran and
     * then rolled back would leave the bytes right and the timestamp wrong,
     * which a bytes-only assertion cannot see.
     */
    const rejectionBodies: readonly [string, unknown][] = [
      [
        "a type mismatch",
        { declaredContentType: "image/jpeg", bytesBase64: PNG_128.toString("base64") },
      ],
      [
        "an unsupported signature (SVG)",
        { declaredContentType: "image/png", bytesBase64: SVG_DOCUMENT.toString("base64") },
      ],
      [
        "a GIF's signature",
        { declaredContentType: "image/png", bytesBase64: VALID_GIF.toString("base64") },
      ],
      [
        "a WebP's signature",
        { declaredContentType: "image/png", bytesBase64: VALID_WEBP.toString("base64") },
      ],
      [
        "one byte over the ceiling",
        {
          declaredContentType: "image/png",
          bytesBase64: png(64, 64, INSTRUMENT_ICON_MAX_BYTES + 1).toString("base64"),
        },
      ],
      [
        "513 x 512",
        { declaredContentType: "image/png", bytesBase64: png(513, 512).toString("base64") },
      ],
      [
        "a truncated header",
        {
          declaredContentType: "image/png",
          bytesBase64: PNG_128.subarray(0, 20).toString("base64"),
        },
      ],
      ["a zero-byte body", { declaredContentType: "image/png", bytesBase64: "" }],
      ["base64 that does not round-trip", { declaredContentType: "image/png", bytesBase64: "A" }],
      [
        "an unknown key",
        {
          declaredContentType: "image/png",
          bytesBase64: PNG_128.toString("base64"),
          filename: "logo.png",
        },
      ],
    ];

    it.each(rejectionBodies)(
      "a failed replace by %s leaves the previous icon present and byte-identical",
      async (_label, body) => {
        const id = await newInstrument();
        expect((await putIcon(id, bodyFor(PNG_128), alpha)).status).toBe(200);
        const before = await storedRow(id, alpha.tenantId);
        expect(before).toBeDefined();
        expect(Buffer.from(before!.bytes).equals(PNG_128)).toBe(true);

        const response = await putIcon(id, body, alpha);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        // A named refusal, never the generic 500 filter — a 500 here would
        // also be "greater than 400" on a route that had crashed.
        expect(typeof response.body.code).toBe("string");
        expect(response.body.code).not.toBe("INTERNAL_ERROR");

        const after = await storedRow(id, alpha.tenantId);
        // FR-297's last sentence: never left with no icon.
        expect(after).toBeDefined();
        expect(Buffer.from(after!.bytes).equals(PNG_128)).toBe(true);
        // …and not merely present: byte-identical in every column, including
        // `updated_at`, so a rolled-back replace is visible.
        expect({ ...after!, bytes: undefined }).toEqual({ ...before!, bytes: undefined });
        expect(await allRowsFor(id)).toHaveLength(1);
      },
      60_000,
    );

    it("the positive companion: the SAME instrument accepts a legitimate replace, so the assertions above are not passing because replaces never work", async () => {
      const id = await newInstrument();
      expect((await putIcon(id, bodyFor(PNG_128), alpha)).status).toBe(200);
      expect((await putIcon(id, bodyFor(SVG_DOCUMENT), alpha)).status).toBe(422);

      const replace = await putIcon(id, bodyFor(JPEG_128, "image/jpeg"), alpha);
      expect(replace.status).toBe(200);
      const stored = await storedRow(id, alpha.tenantId);
      expect(Buffer.from(stored!.bytes).equals(JPEG_128)).toBe(true);
      expect(stored!.contentType).toBe("image/jpeg");
      expect(await allRowsFor(id)).toHaveLength(1);
    }, 60_000);
  });

  /* ===================================================================== *
   * AC-301 — per-tenant isolation on a shared catalogue row, over HTTP.
   * ===================================================================== */

  describe("AC-301 — two logged-in sessions on ONE shared catalogue instrument (FR-299, FR-300)", () => {
    /** α's icon and β's icon: different bytes, so a byte comparison can tell them apart. */
    const ALPHA_ICON = png(100, 100, 2048);
    const BETA_ICON = jpeg(80, 60, 1024);

    it("α sets an icon, β sees ABSENCE while α sees α's own bytes; then β sets β's, and both persist as TWO rows", async () => {
      const shared = await newInstrument();
      const [instrumentBefore] = await testApp.ownerDb
        .select()
        .from(instrument)
        .where(eq(instrument.id, shared));
      // The configuration LD-3 exists for: nobody owns this instrument.
      expect(instrumentBefore!.ownerTenantId).toBeNull();

      expect((await putIcon(shared, bodyFor(ALPHA_ICON), alpha)).status).toBe(200);

      // Absence, for tenant B — read through the *application's* own reader,
      // as the real `app_web` role under RLS, which is the function the read
      // route of Batch C will call. (The read route does not exist yet, so
      // AC-301's "returns the no-icon response" over HTTP belongs to GATE-3.)
      await expect(
        getInstrumentIcon(testApp.db, { tenantId: beta.tenantId, instrumentId: shared }),
      ).resolves.toBeNull();
      // The positive companion the absence half needs.
      const alphaRead = await getInstrumentIcon(testApp.db, {
        tenantId: alpha.tenantId,
        instrumentId: shared,
      });
      expect(alphaRead).not.toBeNull();
      expect(alphaRead!.bytes.equals(ALPHA_ICON)).toBe(true);

      // β now sets a DIFFERENT icon on the same instrument. FR-299: this is a
      // second row, not an overwrite — the icon's scope is the tenant that
      // uploaded it, not the instrument.
      const betaPut = await putIcon(shared, bodyFor(BETA_ICON, "image/jpeg"), beta);
      expect(betaPut.status).toBe(200);

      const rows = await allRowsFor(shared);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.tenantId))).toEqual(
        new Set([alpha.tenantId, beta.tenantId]),
      );

      // Byte comparison on both sides, in both directions.
      expect(Buffer.from((await storedRow(shared, alpha.tenantId))!.bytes).equals(ALPHA_ICON)).toBe(
        true,
      );
      expect(Buffer.from((await storedRow(shared, beta.tenantId))!.bytes).equals(BETA_ICON)).toBe(
        true,
      );
      const betaRead = await getInstrumentIcon(testApp.db, {
        tenantId: beta.tenantId,
        instrumentId: shared,
      });
      expect(betaRead!.bytes.equals(BETA_ICON)).toBe(true);
      expect(betaRead!.contentType).toBe("image/jpeg");
      const alphaReadAgain = await getInstrumentIcon(testApp.db, {
        tenantId: alpha.tenantId,
        instrumentId: shared,
      });
      expect(alphaReadAgain!.bytes.equals(ALPHA_ICON)).toBe(true);

      // FR-300: the `instrument` row is untouched by all of it, column by column.
      const [instrumentAfter] = await testApp.ownerDb
        .select()
        .from(instrument)
        .where(eq(instrument.id, shared));
      expect(instrumentAfter).toEqual(instrumentBefore);
      // …and no column was added to `instrument` for this feature (FR-300's
      // first clause), which the exact key set states.
      expect(Object.keys(instrumentAfter!)).not.toContain("iconBytes");
      expect(Object.keys(instrumentAfter!).some((k) => /icon/i.test(k))).toBe(false);
    }, 60_000);

    it("β's REPLACE of β's own icon does not touch α's row for the same instrument", async () => {
      const shared = await newInstrument();
      expect((await putIcon(shared, bodyFor(ALPHA_ICON), alpha)).status).toBe(200);
      expect((await putIcon(shared, bodyFor(BETA_ICON, "image/jpeg"), beta)).status).toBe(200);
      const alphaBefore = await storedRow(shared, alpha.tenantId);

      const replaced = png(30, 30, 512);
      expect((await putIcon(shared, bodyFor(replaced), beta)).status).toBe(200);

      expect(Buffer.from((await storedRow(shared, beta.tenantId))!.bytes).equals(replaced)).toBe(
        true,
      );
      expect(await storedRow(shared, alpha.tenantId)).toEqual(alphaBefore);
      expect(await allRowsFor(shared)).toHaveLength(2);
    }, 60_000);

    it("β's DELETE removes only β's row — α's icon survives byte-identical, and vice versa", async () => {
      const shared = await newInstrument();
      expect((await putIcon(shared, bodyFor(ALPHA_ICON), alpha)).status).toBe(200);
      expect((await putIcon(shared, bodyFor(BETA_ICON, "image/jpeg"), beta)).status).toBe(200);

      expect((await deleteIcon(shared, beta)).status).toBe(204);
      expect(await storedRow(shared, beta.tenantId)).toBeUndefined();
      const alphaRow = await storedRow(shared, alpha.tenantId);
      expect(alphaRow).toBeDefined();
      expect(Buffer.from(alphaRow!.bytes).equals(ALPHA_ICON)).toBe(true);

      // The other direction, so this is not passing because DELETE only ever
      // deletes the first row it finds.
      expect((await deleteIcon(shared, alpha)).status).toBe(204);
      expect(await allRowsFor(shared)).toHaveLength(0);
    }, 60_000);

    it("β's DELETE on an instrument only α has iconed is 204 and destroys nothing — a session cannot delete across the tenant boundary", async () => {
      const shared = await newInstrument();
      expect((await putIcon(shared, bodyFor(ALPHA_ICON), alpha)).status).toBe(200);

      const response = await deleteIcon(shared, beta);
      expect(response.status).toBe(204);

      const alphaRow = await storedRow(shared, alpha.tenantId);
      expect(alphaRow).toBeDefined();
      expect(Buffer.from(alphaRow!.bytes).equals(ALPHA_ICON)).toBe(true);
      expect(await allRowsFor(shared)).toHaveLength(1);
    }, 60_000);
  });

  /* ===================================================================== *
   * The 404 path, DELETE idempotence, and the existence-oracle question.
   * ===================================================================== */

  describe("the not-found path, and whether it can be read as an oracle", () => {
    it("a PUT for an instrument id that does not exist is 404 INSTRUMENT_NOT_FOUND, and stores nothing", async () => {
      const ghost = randomUUID();
      const response = await putIcon(ghost, bodyFor(PNG_128), alpha);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("INSTRUMENT_NOT_FOUND");
      expect(await allRowsFor(ghost)).toHaveLength(0);
    });

    it("a DELETE answers 204 IDENTICALLY in all three states — no icon, another tenant's icon, and no such instrument", async () => {
      // FR-305's shape applied to the write route: the three answers must be
      // indistinguishable, or the route reports whether another tenant has an
      // icon for an instrument.
      const neverIconed = await newInstrument();
      const onlyAlphas = await newInstrument();
      expect((await putIcon(onlyAlphas, bodyFor(PNG_128), alpha)).status).toBe(200);
      const ghost = randomUUID();

      const responses = await Promise.all([
        deleteIcon(neverIconed, beta),
        deleteIcon(onlyAlphas, beta),
        deleteIcon(ghost, beta),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(204);
        expect(response.body).toEqual({});
        expect(response.text).toBe("");
      }
      // Compared field by field, not just on status: a `content-length`, an
      // `etag` or a body that differed would be the oracle.
      const shapes = responses.map((r) => JSON.stringify({ body: r.body, text: r.text }));
      expect(new Set(shapes).size).toBe(1);
      // And α's icon is still there, so the 204 above really did address a
      // populated row it was not allowed to touch.
      expect(await storedRow(onlyAlphas, alpha.tenantId)).toBeDefined();
    }, 60_000);

    it("a PUT's 404 does not distinguish an instrument another tenant has iconed from a fresh one — both 200 for the caller", async () => {
      // The oracle a PUT could become: if a PUT on an instrument another
      // tenant has iconed answered anything other than the ordinary success,
      // the caller would learn about that tenant's row.
      const iconedByAlpha = await newInstrument();
      expect((await putIcon(iconedByAlpha, bodyFor(PNG_128), alpha)).status).toBe(200);
      const fresh = await newInstrument();

      const onOthers = await putIcon(iconedByAlpha, bodyFor(JPEG_128, "image/jpeg"), beta);
      const onFresh = await putIcon(fresh, bodyFor(JPEG_128, "image/jpeg"), beta);

      expect(onOthers.status).toBe(200);
      expect(onFresh.status).toBe(200);
      expect(Object.keys(onOthers.body).sort()).toEqual(Object.keys(onFresh.body).sort());
      expect({ ...onOthers.body, instrumentId: null, updatedAt: null }).toEqual({
        ...onFresh.body,
        instrumentId: null,
        updatedAt: null,
      });
    }, 60_000);

    it("FR-299, FIXED: a TENANT-OWNED instrument is iconable by its OWNER, and 404 — never 403 — for anyone else", async () => {
      // Was pinned as a finding: `putIcon` reused `getInstrumentById`, which
      // filters `owner_tenant_id IS NULL` (the F10 forward-compat guard), so
      // the second of FR-299's two instrument kinds was unreachable on this
      // route — the *owner* of a tenant-owned instrument was told their own
      // instrument does not exist. The route now probes with
      // `getInstrumentBackfillTarget` and applies the caller-side rule, the
      // same shape the repo already recorded and fixed once for
      // `POST /instruments/:id/history-reload`.
      //
      // Latent in production today (nothing writes `owner_tenant_id`), so the
      // fixture writes it directly — which is the only way the *second* kind
      // can be exercised at all, and the reason this case must exist rather
      // than wait for phase 2 to make it reachable.
      const owned = randomUUID();
      await testApp.ownerDb.insert(instrument).values({
        id: owned,
        kind: "CRYPTO",
        displayName: "IK-8 tenant-owned instrument",
        listingCurrency: "EUR",
        symbol: "IK8OWNED1",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
        ownerTenantId: alpha.tenantId,
      });

      // The owner: served, and the bytes really land.
      const asOwner = await putIcon(owned, bodyFor(PNG_128), alpha);
      expect(asOwner.status).toBe(200);
      expect((await storedRow(owned, alpha.tenantId))!.byteLength).toBe(PNG_128.length);

      // Another tenant: 404, and **not** 403 — a 403 would confirm the
      // existence of α's private instrument to anyone who can guess a UUID,
      // which is the exact oracle `owner_tenant_id` exists to close. Asserted
      // as an equality on the status so a "symmetry" change to 403 reddens.
      const asStranger = await putIcon(owned, bodyFor(JPEG_128, "image/jpeg"), beta);
      expect(asStranger.status).toBe(404);
      expect(asStranger.body.code).toBe("INSTRUMENT_NOT_FOUND");

      // β's refusal is indistinguishable from a genuinely unknown id — the
      // positive control that makes "never an oracle" a measurement and not a
      // claim: same status, same code, same whole body.
      const asUnknown = await putIcon(randomUUID(), bodyFor(JPEG_128, "image/jpeg"), beta);
      expect(asUnknown.status).toBe(404);
      expect(asStranger.body).toEqual(asUnknown.body);

      // And β's rejected write stored nothing: α's row is the only one.
      const rows = await allRowsFor(owned);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenantId).toBe(alpha.tenantId);

      await testApp.ownerDb.delete(instrumentIcon).where(eq(instrumentIcon.instrumentId, owned));
    }, 60_000);
  });

  /* ===================================================================== *
   * AC-305 — the provenance seam.
   * ===================================================================== */

  describe("AC-305 — every application write path stores MANUAL, and PROVIDER needs no DDL", () => {
    it("the set path, the replace path and a set-after-remove all store MANUAL, read off the table", async () => {
      const id = await newInstrument();

      // Path 1: the insert arm.
      expect((await putIcon(id, bodyFor(PNG_128), alpha)).status).toBe(200);
      expect((await storedRow(id, alpha.tenantId))!.source).toBe("MANUAL");

      // Path 2: the conflict arm.
      expect((await putIcon(id, bodyFor(JPEG_128, "image/jpeg"), alpha)).status).toBe(200);
      expect((await storedRow(id, alpha.tenantId))!.source).toBe("MANUAL");

      // Path 3: the insert arm again, after the only other write route.
      expect((await deleteIcon(id, alpha)).status).toBe(204);
      expect((await putIcon(id, bodyFor(PNG_128), alpha)).status).toBe(200);
      expect((await storedRow(id, alpha.tenantId))!.source).toBe("MANUAL");

      // Those are all of them: the route table carries exactly two icon
      // writes, so "every application write path" is enumerable and
      // enumerated, not sampled.
      //
      // **Updated by IK-9, which this pin was built to catch.** Batch C added
      // `GET /instruments/:id/icon` (and Fastify's automatic `HEAD` beside
      // it), so the unfiltered set is now four and this assertion reddened —
      // by design. The claim it defends is about **write** paths, so the
      // filter is now by method and the *whole* set is asserted alongside it:
      // a fourth write verb still fails the first assertion, and a fifth verb
      // of any kind still fails the second. Relaxing either to a `toContain`
      // would have thrown the tripwire away.
      //
      // **Updated again by `portfolio-details`, caught the same way.**
      // `PUT`/`DELETE`/`GET /portfolios/:id/icon` (plus Fastify's automatic
      // `HEAD`) joined the table, so both sets are re-stated in full rather
      // than filtered down to `/instruments/` — scoping this to one entity
      // would silently stop noticing a *third* entity growing icon routes,
      // which is the only thing this pin is for. The instrument claim above
      // is unweakened: every instrument row here is still named explicitly.
      const iconRoutes = testApp.built.routes
        .filter((r) => r.path.endsWith("/icon"))
        .map((r) => `${r.method} ${r.path}`)
        .sort();
      expect(
        iconRoutes.filter((route) => !route.startsWith("GET ") && !route.startsWith("HEAD ")),
      ).toEqual([
        "DELETE /api/v1/instruments/:id/icon",
        "DELETE /api/v1/portfolios/:id/icon",
        "PUT /api/v1/instruments/:id/icon",
        "PUT /api/v1/portfolios/:id/icon",
      ]);
      // Sorted, so the two entities interleave by verb — `portfolio-details`
      // added the second of each pair.
      expect(iconRoutes).toEqual([
        "DELETE /api/v1/instruments/:id/icon",
        "DELETE /api/v1/portfolios/:id/icon",
        "GET /api/v1/instruments/:id/icon",
        "GET /api/v1/portfolios/:id/icon",
        // Fastify registers `HEAD` for every `GET` (`exposeHeadRoutes`), so
        // this is not a second handler and reads nothing: it is the `GET`
        // answering with headers only. Named rather than filtered away, so a
        // deliberately-added `HEAD` handler would still be visible here.
        "HEAD /api/v1/instruments/:id/icon",
        "HEAD /api/v1/portfolios/:id/icon",
        "PUT /api/v1/instruments/:id/icon",
        "PUT /api/v1/portfolios/:id/icon",
      ]);
    }, 60_000);

    it("a PROVIDER row is insertable with NO DDL change — as the real app_web role, inside this test", async () => {
      const id = await newInstrument();

      await withTenant(testApp.db, alpha.tenantId, async (tx) => {
        await tx.insert(instrumentIcon).values({
          tenantId: alpha.tenantId,
          instrumentId: id,
          bytes: PNG_128,
          contentType: "image/png",
          byteLength: PNG_128.length,
          widthPx: 128,
          heightPx: 128,
          source: "PROVIDER",
        });
      });

      // The seam's success condition: the column admits it today, so the
      // later provider lane needs no migration (FR-301). A
      // `CHECK (source = 'MANUAL')` would have failed this line.
      expect((await storedRow(id, alpha.tenantId))!.source).toBe("PROVIDER");
    }, 60_000);

    it("a PROVIDER row made OUT OF BAND is corrected to MANUAL by an ordinary replace — the conflict arm writes the literal, not the existing value", async () => {
      const id = await newInstrument();
      expect((await putIcon(id, bodyFor(PNG_128), alpha)).status).toBe(200);
      await testApp.ownerDb
        .update(instrumentIcon)
        .set({ source: "PROVIDER" })
        .where(
          and(eq(instrumentIcon.tenantId, alpha.tenantId), eq(instrumentIcon.instrumentId, id)),
        );
      expect((await storedRow(id, alpha.tenantId))!.source).toBe("PROVIDER");

      const replace = await putIcon(id, bodyFor(JPEG_128, "image/jpeg"), alpha);

      expect(replace.status).toBe(200);
      // The behavioural half of AC-305's compile-time claim: an upsert whose
      // conflict arm omitted `source` — or read `excluded.source` from a
      // widened insert arm — would leave PROVIDER standing here.
      expect(replace.body.source).toBe("MANUAL");
      expect((await storedRow(id, alpha.tenantId))!.source).toBe("MANUAL");
    }, 60_000);

    it("no icon response on any status ever carries a source other than MANUAL", async () => {
      // The sweep, over every answer the route can give that has a body at
      // all: a `source` of PROVIDER cannot be produced, and cannot be
      // reported either.
      const id = await newInstrument();
      const answers = [
        await putIcon(id, bodyFor(PNG_128), alpha),
        await putIcon(id, bodyFor(JPEG_128, "image/jpeg"), alpha),
        await putIcon(id, bodyFor(SVG_DOCUMENT), alpha),
        await putIcon(randomUUID(), bodyFor(PNG_128), alpha),
        await putIcon(id, { declaredContentType: "image/png", bytesBase64: "A" }, alpha),
      ];
      for (const answer of answers) {
        expect(JSON.stringify(answer.body)).not.toContain("PROVIDER");
      }
      // Positive control: the field is really there to have been wrong.
      expect(answers[0]!.body.source).toBe("MANUAL");
    }, 60_000);
  });

  describe("a mixed-case path id reports the same hasIcon as the canonical one", () => {
    it("PATCH /instruments/:ID/classification on an iconed instrument answers hasIcon:true", async () => {
      const id = await newInstrument();
      expect((await putIcon(id, bodyFor(PNG_128), alpha)).status).toBe(200);

      const response = await server()
        .patch(`/api/v1/instruments/${id.toUpperCase()}/classification`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${alpha.sid}`, `${CSRF_COOKIE_NAME}=${alpha.csrf}`])
        .set(CSRF_HEADER_NAME, alpha.csrf)
        .send({ industryLabel: "Mixed-case id" });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(id);
      expect(response.body.hasIcon).toBe(true);
    });
  });

  /* ===================================================================== *
   * FR-304 — nothing client-supplied is reflected, over every rejection.
   * ===================================================================== */

  describe("FR-304 / NFR-4(b) — the payload never reaches a response, over EVERY rejecting path", () => {
    /** A conspicuous marker inside the bytes of every fixture below. */
    const MARKER = "IK8REFLECTIONCANARY";

    function withMarker(base: Buffer): Buffer {
      return Buffer.concat([base, Buffer.from(MARKER.repeat(3), "ascii")]);
    }

    const paths: readonly [string, unknown][] = [
      [
        "a type mismatch",
        { declaredContentType: "image/jpeg", bytesBase64: withMarker(PNG_128).toString("base64") },
      ],
      [
        "an unsupported signature",
        {
          declaredContentType: "image/png",
          bytesBase64: withMarker(SVG_DOCUMENT).toString("base64"),
        },
      ],
      [
        "a truncated header",
        {
          declaredContentType: "image/png",
          bytesBase64: Buffer.concat([PNG_128.subarray(0, 20)]).toString("base64"),
        },
      ],
      [
        "a dimension ceiling",
        {
          declaredContentType: "image/png",
          bytesBase64: withMarker(png(513, 512)).toString("base64"),
        },
      ],
      [
        "a byte ceiling",
        {
          declaredContentType: "image/png",
          bytesBase64: withMarker(png(64, 64, INSTRUMENT_ICON_MAX_BYTES)).toString("base64"),
        },
      ],
      [
        "a malformed base64",
        {
          declaredContentType: "image/png",
          bytesBase64: `${MARKER.replace(/[^A-Za-z0-9]/g, "")}A`,
        },
      ],
      [
        "a bad declared type",
        { declaredContentType: "image/gif", bytesBase64: withMarker(PNG_128).toString("base64") },
      ],
      ["a missing field", { declaredContentType: "image/png" }],
    ];

    it.each(paths)(
      "%s reflects neither the bytes, nor a fingerprint of them, nor the declared type",
      async (_label, body) => {
        const id = await newInstrument();
        const response = await putIcon(id, body, alpha);
        expect(response.status).toBeGreaterThanOrEqual(400);

        const serialised = [JSON.stringify(response.body), JSON.stringify(response.headers)].join(
          "\n",
        );
        expect(serialised).not.toContain(MARKER);
        const sent = (body as { bytesBase64?: string }).bytesBase64;
        if (sent !== undefined && sent.length > 24) {
          expect(serialised).not.toContain(sent);
          // Not even a prefix long enough to fingerprint the payload.
          expect(serialised).not.toContain(sent.slice(0, 24));
        }
        // The declared type is a client-supplied string too — FR-304 names it
        // explicitly beside the filename.
        const declared = (body as { declaredContentType?: string }).declaredContentType;
        if (declared === "image/gif") expect(serialised).not.toContain("image/gif");
        expect(response.headers["content-disposition"]).toBeUndefined();
      },
      60_000,
    );

    it("two payloads that fail the same way produce byte-identical problem documents — which is what 'static literal' means operationally", async () => {
      const first = await putIcon(await newInstrument(), bodyFor(png(600, 600)), alpha);
      const second = await putIcon(await newInstrument(), bodyFor(png(513, 512)), alpha);
      expect(first.body.code).toBe("INSTRUMENT_ICON_DIMENSIONS_EXCEEDED");
      expect(second.body).toEqual(first.body);
      // …and across a different cause the document really does differ, so the
      // equality above is not comparing two empty objects.
      const third = await putIcon(await newInstrument(), bodyFor(SVG_DOCUMENT), alpha);
      expect(third.body).not.toEqual(first.body);
    }, 60_000);

    it("FINDING (FR-304): an unknown key's NAME is echoed in the validation problem — the one client-controlled string that does reach a response", async () => {
      // `parseOrThrow`'s `unrecognized_keys` fan-out puts the offending key
      // name in `errors[].field`, in `errors[].message` and in `detail`
      // (`api/src/common/zod-validate.ts`). The *value* is never echoed, and
      // the icon body has no filename field — but the key name is a
      // client-controlled string, which FR-304 forbids reflecting without
      // qualification.
      //
      // Repo-wide and pre-existing: every `z.strictObject` route on this API
      // behaves this way. Pinned here rather than asserted absent, because
      // the fix is a shared-helper decision, not this feature's.
      const marker = "IK8ECHOEDKEYNAME";
      const response = await putIcon(
        await newInstrument(),
        { declaredContentType: "image/png", bytesBase64: PNG_128.toString("base64"), [marker]: 1 },
        alpha,
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(response.body)).toContain(marker);
      // The value, by contrast, is not echoed — which is the half FR-304
      // most cares about and the half that holds.
      const withValue = await putIcon(
        await newInstrument(),
        {
          declaredContentType: "image/png",
          bytesBase64: PNG_128.toString("base64"),
          [marker]: "IK8SECRETVALUE",
        },
        alpha,
      );
      expect(JSON.stringify(withValue.body)).not.toContain("IK8SECRETVALUE");
    }, 60_000);
  });

  /* ===================================================================== *
   * FR-318 / AC-316 — the request-parsing surface.
   * ===================================================================== */

  describe("FR-318 / AC-316 — the icon route refuses a multipart body exactly as the transport did before it existed", () => {
    it("IMPORT_MULTIPART_PATHS is byte-identical to its four import paths, each at its own ceiling", () => {
      // **Four since `portfolio-export-import` EI-26** — the two Kerdial routes
      // joined the two Portfolio-Performance ones.
      // The list is asserted by value rather than by size alone because what
      // AC-316 is about is the *contents*: this is the map that decides which
      // paths the global multipart parser is allowed to reach, and the icon
      // route must never be in it.
      //
      // **A `ReadonlyMap` since EI-29** (KD14), so the value half
      // is asserted too: the ceilings are what the `onRequest` pre-check
      // enforces, and a wrong one there would silently retire a route's own
      // bound — RK2's exact failure. The three expected numbers are the shipped
      // limit sets', by reference, so this pins the *wiring* rather than
      // restating three constants that would then drift.
      expect([...IMPORT_MULTIPART_PATHS.keys()].sort()).toEqual([
        "/api/v1/imports/instruments",
        "/api/v1/imports/kerdial/catalogue",
        "/api/v1/imports/kerdial/transactions",
        "/api/v1/imports/transactions",
      ]);
      expect(IMPORT_MULTIPART_PATHS.size).toBe(4);
      expect([...IMPORT_MULTIPART_PATHS.keys()].some((path) => path.includes("icon"))).toBe(false);

      expect(Object.fromEntries(IMPORT_MULTIPART_PATHS)).toEqual({
        "/api/v1/imports/instruments": DEFAULT_IMPORT_LIMITS.maxFileBytes,
        "/api/v1/imports/transactions": DEFAULT_IMPORT_LIMITS.maxFileBytes,
        "/api/v1/imports/kerdial/transactions": KERDIAL_CSV_LIMITS.maxFileBytes,
        "/api/v1/imports/kerdial/catalogue": KERDIAL_JSON_LIMITS.maxFileBytes,
      });
      // …and the three are genuinely different numbers, so the mapping above
      // cannot be satisfied by one shared ceiling (the RK2 regression).
      expect(
        new Set([
          DEFAULT_IMPORT_LIMITS.maxFileBytes,
          KERDIAL_CSV_LIMITS.maxFileBytes,
          KERDIAL_JSON_LIMITS.maxFileBytes,
        ]).size,
      ).toBe(3);
    });

    it("a multipart body on the icon route gets the SAME 415 document a multipart body on POST /transactions gets", async () => {
      // "Exactly as it was before the route existed" is a comparison, not an
      // adjective: the reference is another non-import route's answer to the
      // same request shape. A parser registered for the icon path would make
      // these two differ.
      const id = await newInstrument();
      const onIcon = await server()
        .put(`/api/v1/instruments/${id}/icon`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${alpha.sid}`, `${CSRF_COOKIE_NAME}=${alpha.csrf}`])
        .set(CSRF_HEADER_NAME, alpha.csrf)
        .attach("file", PNG_128, { filename: "logo.png", contentType: "image/png" });

      const onTransactions = await server()
        .post("/api/v1/transactions")
        .set("Cookie", [`${SID_COOKIE_NAME}=${alpha.sid}`, `${CSRF_COOKIE_NAME}=${alpha.csrf}`])
        .set(CSRF_HEADER_NAME, alpha.csrf)
        .attach("file", PNG_128, { filename: "logo.png", contentType: "image/png" });

      expect(onIcon.status).toBe(415);
      expect(onIcon.status).toBe(onTransactions.status);
      expect(onIcon.body.code).toBe(onTransactions.body.code);
      expect(onIcon.body.title).toBe(onTransactions.body.title);
      // The filename travelled in the multipart headers; it is nowhere in the
      // answer (FR-304).
      expect(JSON.stringify(onIcon.body)).not.toContain("logo.png");
      expect(await allRowsFor(id)).toHaveLength(0);
    }, 60_000);

    it("…and the base64-in-JSON shape works, so the refusals above are not a route that refuses everything", async () => {
      const id = await newInstrument();
      const response = await putIcon(id, bodyFor(PNG_128), alpha);
      expect(response.status).toBe(200);
      expect(Buffer.from((await storedRow(id, alpha.tenantId))!.bytes).equals(PNG_128)).toBe(true);
    }, 60_000);
  });

  /* ===================================================================== *
   * FR-317 — throttle membership, in the mechanism's own shape.
   * ===================================================================== */

  /* ===================================================================== *
   * AC-304 — the cap, at the boundary, in three directions.
   * ===================================================================== */

  describe("AC-304 — the per-tenant row cap over HTTP, at the exact boundary", () => {
    let capped: { tenantId: string; sid: string; csrf: string };
    /** The instrument whose icon is replaced while the tenant sits at the cap. */
    let existing: string;
    /** The 500th distinct instrument — accepted, which is what makes the cap 500 and not 499. */
    let five_hundredth: string;
    /** The 501st distinct instrument — refused, then accepted after one removal. */
    let five_hundred_and_first: string;

    beforeAll(async () => {
      capped = await newTenantSession("cap");
      // `maxRowsPerTenant` is a service parameter and is deliberately not
      // plumbed through the route, so the cap can only be reached over HTTP
      // by really holding that many rows. Seeded with the owner handle: the
      // cap's *effect* is under test, not 499 uploads.
      const seeded = Array.from({ length: INSTRUMENT_ICON_TENANT_ROW_CAP - 1 }, (_, index) => ({
        id: randomUUID(),
        kind: "CRYPTO" as const,
        displayName: `IK-8 cap seed ${index}`,
        listingCurrency: "EUR",
        symbol: `IK8CAP${String(index).padStart(6, "0")}`,
        primaryIdentifier: "SYMBOL" as const,
        quotePolicy: "AUTO" as const,
      }));
      await testApp.ownerDb.insert(instrument).values(seeded);
      const seedBytes = png(16, 16);
      await testApp.ownerDb.insert(instrumentIcon).values(
        seeded.map((row) => ({
          tenantId: capped.tenantId,
          instrumentId: row.id,
          bytes: seedBytes,
          contentType: "image/png" as const,
          byteLength: seedBytes.length,
          widthPx: 16,
          heightPx: 16,
        })),
      );
      existing = seeded[0]!.id;
      five_hundredth = await newInstrument();
      five_hundred_and_first = await newInstrument();
    }, 180_000);

    it("the tenant really holds exactly CAP - 1 rows before anything is asked of the route", async () => {
      // Without this the two boundary assertions below would be about an
      // unknown starting state.
      const rows = await testApp.ownerDb
        .select({ tenantId: instrumentIcon.tenantId })
        .from(instrumentIcon)
        .where(eq(instrumentIcon.tenantId, capped.tenantId));
      expect(rows).toHaveLength(INSTRUMENT_ICON_TENANT_ROW_CAP - 1);
    });

    it(`the ${INSTRUMENT_ICON_TENANT_ROW_CAP}th distinct instrument is ACCEPTED — the cap admits its own value`, async () => {
      const response = await putIcon(five_hundredth, bodyFor(PNG_128), capped);
      expect(response.status).toBe(200);
      expect(
        Buffer.from((await storedRow(five_hundredth, capped.tenantId))!.bytes).equals(PNG_128),
      ).toBe(true);
    }, 60_000);

    it(`the ${INSTRUMENT_ICON_TENANT_ROW_CAP + 1}st distinct instrument is REFUSED 429 INSTRUMENT_ICON_TENANT_CAP_EXCEEDED, and stores nothing`, async () => {
      const response = await putIcon(five_hundred_and_first, bodyFor(PNG_128), capped);

      expect(response.status).toBe(429);
      expect(response.body.code).toBe("INSTRUMENT_ICON_TENANT_CAP_EXCEEDED");
      // The other 429 on this route is the throttle; a client shows a
      // different sentence for each, so conflating them is a real defect.
      expect(response.body.code).not.toBe("ADMISSION_BOUND_EXCEEDED");
      // Nor does the refusal leak the cap or the tenant id from the error's
      // own message (FR-304): the number reaches the client through
      // `web/src/lib/api-limits.ts`, not through the wire.
      expect(JSON.stringify(response.body)).not.toContain(capped.tenantId);
      expect(await allRowsFor(five_hundred_and_first)).toHaveLength(0);
    }, 60_000);

    it("a REPLACE of an existing row in that same state still succeeds — FR-302's exemption, which a one-sided test misses", async () => {
      const response = await putIcon(existing, bodyFor(JPEG_128, "image/jpeg"), capped);
      expect(response.status).toBe(200);
      const stored = await storedRow(existing, capped.tenantId);
      expect(Buffer.from(stored!.bytes).equals(JPEG_128)).toBe(true);
      expect(stored!.contentType).toBe("image/jpeg");
      // Still at the cap afterwards — a replace adds no net-new row, which is
      // the whole reason it is exempt.
      const rows = await testApp.ownerDb
        .select({ tenantId: instrumentIcon.tenantId })
        .from(instrumentIcon)
        .where(eq(instrumentIcon.tenantId, capped.tenantId));
      expect(rows).toHaveLength(INSTRUMENT_ICON_TENANT_ROW_CAP);
    }, 60_000);

    it("after ONE removal the previously-refused instrument is accepted — the cap is a live count, not a decision made once", async () => {
      expect((await deleteIcon(existing, capped)).status).toBe(204);

      const response = await putIcon(five_hundred_and_first, bodyFor(PNG_128), capped);
      expect(response.status).toBe(200);
      expect(response.body.instrumentId).toBe(five_hundred_and_first);
      expect(await storedRow(five_hundred_and_first, capped.tenantId)).toBeDefined();

      // And the tenant is back at the cap, so the next distinct one is
      // refused again — the boundary is where it was, not one row lower.
      const again = await putIcon(await newInstrument(), bodyFor(PNG_128), capped);
      expect(again.status).toBe(429);
      expect(again.body.code).toBe("INSTRUMENT_ICON_TENANT_CAP_EXCEEDED");
    }, 60_000);

    it("the cap is PER TENANT — another tenant's 501st-equivalent write is unaffected in the same state", async () => {
      const id = await newInstrument();
      const response = await putIcon(id, bodyFor(PNG_128), alpha);
      expect(response.status).toBe(200);
    }, 60_000);
  });
});
