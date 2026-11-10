import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_FIELD_BYTES,
  IMPORT_MAX_MULTIPART_FIELDS,
  multipartFailure,
} from "./multipart.js";

/**
 * The two LOW findings from the csv-import security review, and
 * they turned out to be **one mechanism**.
 *
 * `fieldSize` was unset, so `@fastify/busboy` defaulted it to 1 MiB per field
 * (`lib/types/multipart.js:56`). A maximal legitimate `resolutions` confirm is
 * about 1.15 MB — 5 000 rows (`IMPORT_MAX_ROWS`) at ~235 bytes each — so that
 * field was **truncated**, and `@fastify/multipart` raises
 * `FST_INVALID_JSON_FIELD_ERROR` on a truncated JSON field (`index.js:324`).
 * That code was absent from the taxonomy, so it fell through to
 * `log().error("unhandled error mapped to 500")`: a legitimate request reported
 * as a server bug.
 *
 * So LOW-6 (the unset limit) was the *cause* and LOW-5 (the missing taxonomy
 * entry) was how it presented. Both are fixed, and both are asserted here.
 */
const fastifyError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`simulated ${code}`), { code });

const problemOf = (thrown: unknown): { status: number; code: string } => {
  const response = (thrown as { getResponse?: () => { code?: string } }).getResponse?.();
  const status = (thrown as { getStatus?: () => number }).getStatus?.() ?? 0;
  return { status, code: String(response?.code) };
};

describe("LOW-5 — FST_INVALID_JSON_FIELD_ERROR is in the taxonomy", () => {
  it("maps to a 400 malformed-upload problem, not through to the 500 branch", () => {
    const raised = fastifyError("FST_INVALID_JSON_FIELD_ERROR");
    const mapped = multipartFailure(raised);
    // **Not the same object.** `multipartFailure` returns the error unchanged
    // for codes it does not recognise, and that pass-through is exactly what
    // produced the 500 — an `HttpException` is itself an `Error`, so identity
    // is the thing to assert here, not the class.
    expect(mapped).not.toBe(raised);
    expect(problemOf(mapped)).toEqual({ status: 400, code: "IMPORT_MALFORMED_UPLOAD" });
  });

  it("its five siblings still map the same way, and the size error is still the only 413", () => {
    for (const code of [
      "FST_PARTS_LIMIT",
      "FST_FIELDS_LIMIT",
      "FST_PROTO_VIOLATION",
      "FST_INVALID_MULTIPART_CONTENT_TYPE",
      "FST_MP_PREMATURE_CLOSE",
    ]) {
      expect(problemOf(multipartFailure(fastifyError(code))), code).toEqual({
        status: 400,
        code: "IMPORT_MALFORMED_UPLOAD",
      });
    }
    expect(problemOf(multipartFailure(fastifyError("FST_REQ_FILE_TOO_LARGE")))).toEqual({
      status: 413,
      code: "IMPORT_FILE_TOO_LARGE",
    });
    expect(problemOf(multipartFailure(fastifyError("FST_FILES_LIMIT")))).toEqual({
      status: 400,
      code: "IMPORT_TOO_MANY_FILES",
    });
  });

  it("an unrecognised code is still returned unchanged — the 500 branch is preserved, not widened", () => {
    // The negative companion. Adding a code must not turn the taxonomy into a
    // catch-all: a genuinely unknown failure must still reach the branch whose
    // whole job is to say "this is a server bug".
    const unknown = fastifyError("FST_SOMETHING_NOBODY_MAPPED");
    expect(multipartFailure(unknown)).toBe(unknown);
    const notFastify = new TypeError("a programming mistake");
    expect(multipartFailure(notFastify)).toBe(notFastify);
  });
});

describe("LOW-6 — the field limits are stated, and sized against the real maximum", () => {
  it("clears a maximal resolutions confirm, which the 1 MiB default did not", () => {
    // 5 000 rows at ~235 bytes each — the arithmetic in `multipart.ts`'s own
    // constant, asserted so a future shrink of the cap fails here rather than
    // on a real 5 000-row import.
    const maximalConfirmBytes = 5_000 * 235;
    expect(maximalConfirmBytes).toBeGreaterThan(1024 * 1024); // what the default would have truncated
    expect(IMPORT_MAX_FIELD_BYTES).toBeGreaterThan(maximalConfirmBytes);
  });

  it("counts the fields either route actually sends, not one more", () => {
    // `mode`, `fileType`, `portfolioId`, `cashAccountId`, `resolutions` — the
    // number this file's doc comment already stated while the limit said 8.
    expect(IMPORT_MAX_MULTIPART_FIELDS).toBe(5);
  });

  it("the worst-case buffered field memory is bounded and knowable", () => {
    // The figure the doc comment now states, computed from the two constants
    // rather than repeated as prose: 10 MiB.
    expect(IMPORT_MAX_MULTIPART_FIELDS * IMPORT_MAX_FIELD_BYTES).toBe(10 * 1024 * 1024);
  });
});
