import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import supertest from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import { createUser } from "@kerdial/platform-auth";
import { portfolioIcon, tenant } from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * **PD-T8 — GATE-3**, the blocking, independently authored known-answer gate
 * for the `portfolio-details` icon write path
 * (PD-T8; AC-400).
 *
 * Written by a tester who did not write `portfolio-icon.validate.ts` or
 * `portfolios.controller.ts` and does not import PD-T7's own fixtures: every
 * image below is built here, from the format's own bytes, by builders copied
 * **by value** from `instrument-icon.e2e.test.ts` (AC-300's own gate) — the
 * same bytes, run against `PUT /portfolios/:id/icon` instead of
 * `PUT /instruments/:id/icon`, which is the only way "the same rules and the
 * same numbers" (L2) is a *proof* rather than an assumption. Where PD-T7's own
 * suite samples five representative rows to prove the route is wired to the
 * shared validator, this file is the full sweep.
 *
 * What this file decides:
 *
 *  - **AC-400, every row of the fixture table, over HTTP**, each asserted on
 *    **status and machine-readable code**. Two boundary directions (bytes,
 *    pixels) are each proven for **both** accepted formats (PNG, JPEG) at the
 *    exact bound and one unit past it, so the cap is shown to admit its own
 *    value rather than being inferred from PNG alone. Every rejected row
 *    additionally asserts that **no `portfolio_icon` row exists**, queried
 *    directly — never inferred from the response.
 *  - **AC-400's atomicity companion.** Every rejecting cause re-run against a
 *    portfolio that already carries a valid icon, with the whole stored row
 *    (bytes, content type, dimensions, byte length, `updated_at`) asserted
 *    unchanged — a replace that ran and then rolled back would leave the bytes
 *    right and the timestamp wrong, which a bytes-only comparison cannot see.
 *  - **`DELETE` as a non-oracle.** Three states — a portfolio id that does not
 *    exist at all, another tenant's portfolio with no icon, and another
 *    tenant's portfolio *with* an icon — answer `204` with an
 *    indistinguishable body and header set, and the targeted portfolio's own
 *    icon (when it has one) survives byte-identical.
 *  - **`GET`'s headers and cross-tenant secrecy**, independently re-verified:
 *    `content-disposition: attachment` with no filename parameter,
 *    `cache-control: no-store`, and a cross-tenant `GET` cannot read another
 *    tenant's bytes.
 *
 * **Lane:** `pnpm test` (`test:main`) — a bare `*.e2e.test.ts` basename, and
 * none of `package.json`'s five `--exclude` entries names this file.
 *
 * **Throttle budget.** Every portfolio here is created via `POST /portfolios`,
 * which carries **no** per-tenant rate cap (`MAX_PORTFOLIOS_PER_TENANT` is a
 * permanent count, not a rate, and the write throttle that once existed was
 * retired by ADR-0016) — unlike `POST /instruments`, nothing here needs a
 * fixture-insert workaround.
 */

const USER_PASSWORD = "correct horse battery staple pd-t8 gate3 portfolio icon";

/* ------------------------------------------------------------------------- *
 * Fixture builders — real files, from the formats' own bytes, copied BY
 * VALUE from `instrument-icon.e2e.test.ts` so the bytes proving AC-400 here
 * are the identical bytes that proved AC-300 there (L2's "same numbers").
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
 * number.
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
 * As many `COM` (comment) segments as needed to carry exactly `totalBytes`
 * of filler. A single `COM` segment's length field is 16-bit (RFC — max
 * segment length 65535, so max payload 65533), which a 262 144-byte JPEG
 * fixture overruns in one segment — AC-300's own JPEG fixture (row 2) never
 * needed more than 6 144 bytes of padding, so this repo has no precedent for
 * a JPEG *at* the byte ceiling. Each segment therefore contributes exactly
 * `4 + payload` bytes, chained until `totalBytes` is used up exactly.
 */
function buildCommentSegments(totalBytes: number): Buffer[] {
  const segments: Buffer[] = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    if (remaining < 4) {
      throw new Error(`buildCommentSegments: ${remaining} bytes left, cannot represent exactly`);
    }
    const payload = Math.min(65_533, remaining - 4);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload + 2, 0);
    segments.push(Buffer.concat([Buffer.from([0xff, 0xfe]), length, Buffer.alloc(payload, 0x20)]));
    remaining -= payload + 4;
  }
  return segments;
}

/**
 * A JPEG whose header states `width` x `height`: SOI, a JFIF APP0, as many
 * `COM` comment segments as needed to carry `padToBytes` worth of filler, a
 * baseline SOF0, SOS, EOI.
 */
function jpeg(width: number, height: number, padToBytes = 0): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0", "ascii"),
    Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  // `L = 8 + 3 * Nf`: one component is `L = 11` in a 13-byte segment with a
  // 3-byte component descriptor (the conformant shape).
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
  const comments = buildCommentSegments(Math.max(0, padToBytes - fixed));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, ...comments, sof, tail]);
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

/** An SVG document — no filename field exists on this route's body, so "renamed .png" is exercised by declaring it `image/png`. */
const SVG_DOCUMENT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128"/></svg>',
  "utf8",
);

/** A valid PNG, well inside every bound — the atomicity companion's "already iconed" fixture. */
const BASELINE_ICON = png(96, 64, 4096);

describe("api — GATE-3 (PD-T8): the portfolio icon known-answer table, over HTTP, AC-400", () => {
  let testApp: TestApp;
  let alpha: { tenantId: string; sid: string; csrf: string };
  let beta: { tenantId: string; sid: string; csrf: string };

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  type Session = { sid: string; csrf: string };

  function putIcon(id: string, body: unknown, session: Session) {
    return server()
      .put(`/api/v1/portfolios/${id}/icon`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body as object);
  }

  function deleteIcon(id: string, session: Session) {
    return server()
      .delete(`/api/v1/portfolios/${id}/icon`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  /** `.responseType("blob")` is load-bearing — without it `res.body` is not a `Buffer` and a byte-identity assertion is vacuous (PD-T7's own flag). */
  function getIconBytes(id: string, session: { sid: string }) {
    return server()
      .get(`/api/v1/portfolios/${id}/icon`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`])
      .responseType("blob");
  }

  const bodyFor = (bytes: Buffer, declaredContentType = "image/png") => ({
    declaredContentType,
    bytesBase64: bytes.toString("base64"),
  });

  async function newTenantSession(label: string): Promise<{
    tenantId: string;
    sid: string;
    csrf: string;
  }> {
    const tenantId = randomUUID();
    const email = `pd-t8-${label}-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: USER_PASSWORD });
    const session = await loginAs(server(), email, USER_PASSWORD);
    return { tenantId, ...session };
  }

  /** A fresh portfolio owned by `session`'s tenant — no icon, no cash accounts (irrelevant to this gate). */
  async function newPortfolio(session: Session, label = "gate3"): Promise<string> {
    const response = await server()
      .post("/api/v1/portfolios")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send({ name: `PD-T8 ${label} ${randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  /** The stored row, read as the owner (BYPASSRLS) — the response body is never the evidence. */
  async function storedIcon(tenantId: string, portfolioId: string) {
    const [found] = await testApp.ownerDb
      .select()
      .from(portfolioIcon)
      .where(and(eq(portfolioIcon.tenantId, tenantId), eq(portfolioIcon.portfolioId, portfolioId)));
    return found;
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
   * AC-400 — the known-answer table, over HTTP.
   * ===================================================================== */

  describe("AC-400 — the fixture table, status AND code, stored AND not stored", () => {
    interface AcceptedRow {
      readonly label: string;
      readonly declared: string;
      readonly bytes: Buffer;
      readonly storedContentType: "image/png" | "image/jpeg";
      readonly widthPx: number;
      readonly heightPx: number;
    }
    interface RejectedRow {
      readonly label: string;
      readonly declared: string;
      readonly bytes: Buffer;
      readonly status: number;
      readonly code: string;
    }

    const accepted: readonly AcceptedRow[] = [
      {
        label: "a PNG of exactly the byte ceiling (262 144 bytes)",
        declared: "image/png",
        bytes: png(64, 64, INSTRUMENT_ICON_MAX_BYTES),
        storedContentType: "image/png",
        widthPx: 64,
        heightPx: 64,
      },
      {
        label: "a PNG of exactly 512 x 512 (the pixel ceiling, both axes)",
        declared: "image/png",
        bytes: png(INSTRUMENT_ICON_MAX_PIXELS, INSTRUMENT_ICON_MAX_PIXELS),
        storedContentType: "image/png",
        widthPx: 512,
        heightPx: 512,
      },
      {
        label: "a JPEG of exactly the byte ceiling (262 144 bytes)",
        declared: "image/jpeg",
        bytes: jpeg(32, 32, INSTRUMENT_ICON_MAX_BYTES),
        storedContentType: "image/jpeg",
        widthPx: 32,
        heightPx: 32,
      },
      {
        label: "a JPEG of exactly 512 x 512 (the pixel ceiling, both axes)",
        declared: "image/jpeg",
        bytes: jpeg(INSTRUMENT_ICON_MAX_PIXELS, INSTRUMENT_ICON_MAX_PIXELS),
        storedContentType: "image/jpeg",
        widthPx: 512,
        heightPx: 512,
      },
    ];

    const rejected: readonly RejectedRow[] = [
      {
        label: "a PNG one byte over the byte ceiling (262 145 bytes)",
        declared: "image/png",
        bytes: png(64, 64, INSTRUMENT_ICON_MAX_BYTES + 1),
        status: 413,
        code: "PORTFOLIO_ICON_TOO_LARGE",
      },
      {
        label: "a PNG of 513 x 512 (one pixel over on one axis)",
        declared: "image/png",
        bytes: png(INSTRUMENT_ICON_MAX_PIXELS + 1, INSTRUMENT_ICON_MAX_PIXELS),
        status: 422,
        code: "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED",
      },
      {
        label: "a JPEG one byte over the byte ceiling (262 145 bytes)",
        declared: "image/jpeg",
        bytes: jpeg(32, 32, INSTRUMENT_ICON_MAX_BYTES + 1),
        status: 413,
        code: "PORTFOLIO_ICON_TOO_LARGE",
      },
      {
        label: "a JPEG of 512 x 513 (one pixel over on the other axis)",
        declared: "image/jpeg",
        bytes: jpeg(INSTRUMENT_ICON_MAX_PIXELS, INSTRUMENT_ICON_MAX_PIXELS + 1),
        status: 422,
        code: "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED",
      },
      {
        label: "a valid PNG declared image/jpeg (declared/actual mismatch)",
        declared: "image/jpeg",
        bytes: png(64, 64, 2048),
        status: 422,
        code: "PORTFOLIO_ICON_TYPE_MISMATCH",
      },
      {
        label: "an <svg> document declared image/png (SVG renamed .png)",
        declared: "image/png",
        bytes: SVG_DOCUMENT,
        status: 422,
        code: "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
      },
      {
        label: "a valid GIF's bytes declared image/png (signature smuggle)",
        declared: "image/png",
        bytes: VALID_GIF,
        status: 422,
        code: "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
      },
      {
        label: "a valid WebP's bytes declared image/png (signature smuggle)",
        declared: "image/png",
        bytes: VALID_WEBP,
        status: 422,
        code: "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
      },
      {
        label: "a PNG truncated after 20 bytes, inside its IHDR",
        declared: "image/png",
        bytes: png(128, 128, 3182).subarray(0, 20),
        status: 422,
        code: "PORTFOLIO_ICON_UNREADABLE",
      },
      {
        label: "a zero-byte body",
        declared: "image/png",
        bytes: Buffer.alloc(0),
        status: 422,
        code: "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
      },
      {
        label: "malformed base64 (does not round-trip)",
        declared: "image/png",
        bytes: Buffer.alloc(0), // unused — this row sends a hand-built bad payload below
        status: 400,
        code: "PORTFOLIO_ICON_MALFORMED_BASE64",
      },
    ];

    /** Every row's body — the malformed-base64 row overrides `bytesBase64` with a string that cannot decode, rather than encoding `bytes`. */
    function rowBody(row: RejectedRow): unknown {
      if (row.code === "PORTFOLIO_ICON_MALFORMED_BASE64") {
        return { declaredContentType: row.declared, bytesBase64: "A" };
      }
      return bodyFor(row.bytes, row.declared);
    }

    it("the fixtures are what the table says they are, before the route ever runs", () => {
      expect(accepted[0]!.bytes).toHaveLength(INSTRUMENT_ICON_MAX_BYTES);
      expect(accepted[1]!.bytes.readUInt32BE(16)).toBe(512);
      expect(accepted[1]!.bytes.readUInt32BE(20)).toBe(512);
      expect(accepted[2]!.bytes).toHaveLength(INSTRUMENT_ICON_MAX_BYTES);
      expect(accepted[2]!.bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(accepted[3]!.bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(rejected[0]!.bytes).toHaveLength(INSTRUMENT_ICON_MAX_BYTES + 1);
      expect(rejected[1]!.bytes.readUInt32BE(16)).toBe(513);
      expect(VALID_GIF.subarray(0, 6).toString("ascii")).toBe("GIF89a");
      expect(VALID_WEBP.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(SVG_DOCUMENT.subarray(0, 4).toString("ascii")).toBe("<svg");
      // Every one of the six named codes appears at least once.
      const codes = new Set(rejected.map((r) => r.code));
      expect(codes).toEqual(
        new Set([
          "PORTFOLIO_ICON_TOO_LARGE",
          "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED",
          "PORTFOLIO_ICON_TYPE_MISMATCH",
          "PORTFOLIO_ICON_UNSUPPORTED_FORMAT",
          "PORTFOLIO_ICON_UNREADABLE",
          "PORTFOLIO_ICON_MALFORMED_BASE64",
        ]),
      );
    });

    it.each(accepted.map((r) => [r.label, r] as const))(
      "%s is ACCEPTED, and the STORED row is the sniffed type and the fixture's own bytes",
      async (_label, spec) => {
        const id = await newPortfolio(alpha);
        const response = await putIcon(id, bodyFor(spec.bytes, spec.declared), alpha);

        expect(response.status).toBe(200);
        const stored = await storedIcon(alpha.tenantId, id);
        expect(stored).toBeDefined();
        expect(Buffer.from(stored!.bytes).equals(spec.bytes)).toBe(true);
        expect(stored!.contentType).toBe(spec.storedContentType);
        expect(stored!.byteLength).toBe(spec.bytes.length);
        expect(stored!.widthPx).toBe(spec.widthPx);
        expect(stored!.heightPx).toBe(spec.heightPx);
      },
      60_000,
    );

    it.each(rejected.map((r) => [r.label, r] as const))(
      "%s is REJECTED with its own status and code, and stores NOTHING",
      async (_label, spec) => {
        const id = await newPortfolio(alpha);
        const response = await putIcon(id, rowBody(spec), alpha);

        expect(response.status).toBe(spec.status);
        expect(response.body.code).toBe(spec.code);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(await storedIcon(alpha.tenantId, id)).toBeUndefined();
      },
      60_000,
    );

    it("the table DISCRIMINATES — six distinct codes over three statuses", () => {
      const distinctCodes = new Set(rejected.map((r) => r.code));
      expect(distinctCodes.size).toBe(6);
      expect(new Set(rejected.map((r) => r.status))).toEqual(new Set([400, 413, 422]));
      // A type mismatch is not the same answer as an unsupported signature.
      const byCode = (code: string) => rejected.find((r) => r.code === code)!;
      expect(byCode("PORTFOLIO_ICON_TYPE_MISMATCH").code).not.toBe(
        byCode("PORTFOLIO_ICON_UNSUPPORTED_FORMAT").code,
      );
      // A header that cannot be read is not the same answer as a format that
      // is not accepted at all.
      expect(byCode("PORTFOLIO_ICON_UNREADABLE").code).not.toBe(
        byCode("PORTFOLIO_ICON_UNSUPPORTED_FORMAT").code,
      );
      // A byte ceiling is not a pixel ceiling, on EITHER format.
      expect(byCode("PORTFOLIO_ICON_TOO_LARGE").status).not.toBe(
        byCode("PORTFOLIO_ICON_DIMENSIONS_EXCEEDED").status,
      );
    });

    /* =================================================================== *
     * AC-400's atomicity companion — every rejection re-run against a
     * portfolio that already carries a valid icon.
     * =================================================================== */

    describe("atomicity companion — a failed replace leaves the existing icon byte-identical", () => {
      it.each(rejected.map((r) => [r.label, r] as const))(
        "%s leaves the previous icon present, unchanged, and byte-identical",
        async (_label, spec) => {
          const id = await newPortfolio(alpha, "atomicity");
          expect((await putIcon(id, bodyFor(BASELINE_ICON), alpha)).status).toBe(200);
          const before = await storedIcon(alpha.tenantId, id);
          expect(before).toBeDefined();
          expect(Buffer.from(before!.bytes).equals(BASELINE_ICON)).toBe(true);

          const response = await putIcon(id, rowBody(spec), alpha);
          expect(response.status).toBe(spec.status);
          expect(response.body.code).toBe(spec.code);

          const after = await storedIcon(alpha.tenantId, id);
          expect(after).toBeDefined();
          expect(Buffer.from(after!.bytes).equals(BASELINE_ICON)).toBe(true);
          // The whole row, `updated_at` included — a replace that ran and then
          // rolled back would leave the bytes right and the timestamp wrong.
          expect({ ...after!, bytes: undefined }).toEqual({ ...before!, bytes: undefined });
        },
        60_000,
      );

      it("the positive companion: the SAME portfolio accepts a legitimate replace, so the assertions above are not passing because replaces never work", async () => {
        const id = await newPortfolio(alpha, "atomicity-positive");
        expect((await putIcon(id, bodyFor(BASELINE_ICON), alpha)).status).toBe(200);
        expect((await putIcon(id, bodyFor(SVG_DOCUMENT), alpha)).status).toBe(422);

        const replace = await putIcon(id, bodyFor(accepted[2]!.bytes, "image/jpeg"), alpha);
        expect(replace.status).toBe(200);
        const stored = await storedIcon(alpha.tenantId, id);
        expect(Buffer.from(stored!.bytes).equals(accepted[2]!.bytes)).toBe(true);
        expect(stored!.contentType).toBe("image/jpeg");
      }, 60_000);
    });
  });

  /* ===================================================================== *
   * DELETE — 204 unconditionally, and not an existence oracle.
   * ===================================================================== */

  describe("DELETE /portfolios/:id/icon — 204 unconditionally, never an oracle", () => {
    it("204 in all three states, with an INDISTINGUISHABLE response, and the targeted icon (if any) survives", async () => {
      const neverExisted = randomUUID();
      const bareOtherTenant = await newPortfolio(alpha, "delete-bare");
      const iconedOtherTenant = await newPortfolio(alpha, "delete-iconed");
      expect((await putIcon(iconedOtherTenant, bodyFor(BASELINE_ICON), alpha)).status).toBe(200);

      const responses = await Promise.all([
        deleteIcon(neverExisted, beta),
        deleteIcon(bareOtherTenant, beta),
        deleteIcon(iconedOtherTenant, beta),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(204);
        expect(response.body).toEqual({});
        expect(response.text).toBe("");
      }
      // Compared field by field, not just on status — a `content-length` or an
      // `etag` that differed would itself be the oracle.
      const shapes = responses.map((r) => JSON.stringify({ body: r.body, text: r.text }));
      expect(new Set(shapes).size).toBe(1);

      // Alpha's icon on the targeted portfolio is untouched — beta's DELETE
      // addressed a row it was never allowed to touch.
      const survivor = await storedIcon(alpha.tenantId, iconedOtherTenant);
      expect(survivor).toBeDefined();
      expect(Buffer.from(survivor!.bytes).equals(BASELINE_ICON)).toBe(true);
      // …and alpha's bare portfolio still has no icon row (never created by
      // beta's DELETE either).
      expect(await storedIcon(alpha.tenantId, bareOtherTenant)).toBeUndefined();
    }, 60_000);
  });

  /* ===================================================================== *
   * GET — headers and cross-tenant secrecy, independently re-verified.
   * ===================================================================== */

  describe("GET /portfolios/:id/icon — headers, and cross-tenant secrecy", () => {
    it("content-disposition is exactly `attachment` (no filename), and cache-control is no-store", async () => {
      const id = await newPortfolio(alpha, "get-headers");
      expect((await putIcon(id, bodyFor(BASELINE_ICON), alpha)).status).toBe(200);

      const response = await getIconBytes(id, alpha);
      expect(response.status).toBe(200);
      expect(Buffer.compare(response.body as Buffer, BASELINE_ICON)).toBe(0);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-length"]).toBe(String(BASELINE_ICON.length));
      expect(response.headers["content-disposition"]).toBe("attachment");
      expect(response.headers["cache-control"]).toContain("no-store");
    }, 60_000);

    it("a cross-tenant GET cannot read another tenant's bytes — 404, and no byte leak in the body", async () => {
      const id = await newPortfolio(alpha, "get-cross-tenant");
      expect((await putIcon(id, bodyFor(BASELINE_ICON), alpha)).status).toBe(200);

      // Plain (non-blob) request: a 404 is `problem+json`, not image bytes, so
      // the code is read as ordinary JSON here.
      const response = await server()
        .get(`/api/v1/portfolios/${id}/icon`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${beta.sid}`]);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PORTFOLIO_ICON_NOT_FOUND");
      expect(response.headers["content-type"]).toContain("application/problem+json");
      // The no-byte-leak half, on the blob-typed read too (`responseType`
      // makes even this problem+json body arrive as a `Buffer`): decoded, it
      // is the same static JSON, and certainly not alpha's bytes.
      const blobRead = await server()
        .get(`/api/v1/portfolios/${id}/icon`)
        .set("Cookie", [`${SID_COOKIE_NAME}=${beta.sid}`])
        .responseType("blob");
      expect(blobRead.status).toBe(404);
      expect(Buffer.compare(blobRead.body as Buffer, BASELINE_ICON)).not.toBe(0);
      expect(JSON.parse((blobRead.body as Buffer).toString("utf8")).code).toBe(
        "PORTFOLIO_ICON_NOT_FOUND",
      );

      // Alpha can still read its own bytes afterward — beta's failed reads
      // did not disturb anything.
      const alphaRead = await getIconBytes(id, alpha);
      expect(Buffer.compare(alphaRead.body as Buffer, BASELINE_ICON)).toBe(0);
    }, 60_000);
  });
});
