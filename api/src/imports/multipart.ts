import fastifyMultipart from "@fastify/multipart";
import { DEFAULT_IMPORT_LIMITS, KERDIAL_CSV_LIMITS, KERDIAL_JSON_LIMITS } from "@kerdial/importer";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { problemException, type ProblemDetails } from "../common/problem.js";

/**
 * `@fastify/multipart`'s registration, and the scope RC6 requires around it
 * (CI-16).
 *
 * ## The risk this file exists to bound
 *
 * RC6's second limb: "its parser registration widens the request-parsing
 * surface of unrelated routes". It does, and measurably. Registering the plugin
 * calls `fastify.addContentTypeParser('multipart/form-data', setMultipart)` on
 * the instance — a **global** parser whose whole body is `req[kMultipart] =
 * true; done()`. Before it, a `multipart/form-data` body sent to
 * `POST /transactions` is refused by Fastify itself with `415
 * FST_ERR_CTP_INVALID_MEDIA_TYPE`, having been read by nothing. After it, that
 * same request is *accepted* by the parser, reaches the handler with
 * `request.body === undefined`, and is refused — differently, later, and by a
 * schema rather than by the transport.
 *
 * ## Why the scope is a hook and not an encapsulated plugin
 *
 * Fastify's own answer would be encapsulation: register the plugin inside a
 * `fastify.register(async (scope) => …)` context that also owns the routes, so
 * the parser exists only there. That is not available here — every route in
 * this app is registered by Nest onto the root instance, so there is no plugin
 * scope for a controller to live in. Stated rather than left as an apparent
 * oversight.
 *
 * So the scope is enforced where it can be: {@link registerImportMultipart}
 * installs an `onRequest` hook — which runs before content-type parsing — that
 * refuses a multipart body on any path other than the two import routes, with
 * the **same `415`** Fastify itself would have sent. Every other route's
 * request-parsing surface is therefore byte-for-byte what it was before this
 * plugin existed, which is the property RC6 asks for and
 * `imports.e2e.test.ts` asserts directly against `POST /transactions`.
 */

/**
 * The four import paths with **each path's own upload ceiling**
 * (KD14) — the two
 * Portfolio-Performance routes at `ImportLimits.maxFileBytes`, the Kerdial CSV
 * route at `KERDIAL_CSV_LIMITS.maxFileBytes`, the Kerdial catalogue route at
 * `KERDIAL_JSON_LIMITS.maxFileBytes`.
 *
 * Built from the three limit sets rather than taken as an argument, so the
 * ceiling the hook enforces moves with the constant a test lowers: `buildApp`
 * calls this with the **injected** sets (FR-539), and
 * {@link IMPORT_MULTIPART_PATHS} is the shipped-values map the inventory
 * assertion in `instrument-icon.e2e.test.ts` pins.
 */
export function importMultipartCeilings(ceilings: {
  /** Both Portfolio-Performance routes' shared ceiling (`ImportLimits.maxFileBytes`). */
  readonly pp: number;
  readonly kerdialCsv: number;
  readonly kerdialJson: number;
}): ReadonlyMap<string, number> {
  return new Map([
    ["/api/v1/imports/instruments", ceilings.pp],
    ["/api/v1/imports/transactions", ceilings.pp],
    ["/api/v1/imports/kerdial/transactions", ceilings.kerdialCsv],
    ["/api/v1/imports/kerdial/catalogue", ceilings.kerdialJson],
  ]);
}

/**
 * The only paths a multipart body is accepted on, post-`setGlobalPrefix`, at
 * the **shipped** values. Written out rather than derived from the controller's
 * decorators: a hook runs before routing, so there is no route object to ask,
 * and a wrong entry here fails a test rather than silently widening the surface
 * again.
 *
 * **Four since `portfolio-export-import` EI-26**,
 * and a `ReadonlyMap<string, number>` rather than a `ReadonlySet` since EI-29:
 * the `content-length` pre-check needs the path's *own* ceiling at
 * `onRequest` time, before routing and before a byte of the body is read, and
 * only a map has it there.
 */
export const IMPORT_MULTIPART_PATHS: ReadonlyMap<string, number> = importMultipartCeilings({
  pp: DEFAULT_IMPORT_LIMITS.maxFileBytes,
  kerdialCsv: KERDIAL_CSV_LIMITS.maxFileBytes,
  kerdialJson: KERDIAL_JSON_LIMITS.maxFileBytes,
});

/**
 * `true` for `multipart/form-data`, with or without the boundary parameter and
 * whatever the casing. Matched on the media type alone — the boundary is the
 * parser's business, not this hook's.
 */
export function isMultipartContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.split(";", 1)[0]!.trim().toLowerCase() === "multipart/form-data";
}

/** The request path with any query string removed — a hook sees the raw URL, not a routed path. */
export function pathOf(url: string): string {
  return url.split("?", 1)[0]!;
}

export interface ImportMultipartOptions {
  /**
   * Path → that path's own `maxFileBytes` (KD14), normally
   * {@link importMultipartCeilings} over the three injected limit sets.
   *
   * The plugin itself is registered at the **maximum** over this map, because
   * `limits.fileSize` is one number for the instance; each route's own bound is
   * re-imposed twice — cheaply here by the `content-length` pre-check, and
   * exactly by `readImportUpload(request, { maxFileBytes })`.
   */
  readonly ceilings: ReadonlyMap<string, number>;
}

/**
 * Registers the multipart parser and the scope hook, in that order.
 *
 * `limits` are **the plugin's own**, not Fastify's `bodyLimit`: a multipart
 * request is handed to the custom parser above as a raw stream, so `bodyLimit`
 * never sees it and only these bound a part.
 *
 *  - `files: 1` — an import is one file. A second file part is refused rather
 *    than silently ignored, so "which one did it import?" is never a question.
 *  - `fileSize` — the **maximum** over {@link ImportMultipartOptions.ceilings}:
 *    one number for the instance, so it has to admit the largest
 *    route's file. `part.toBuffer()` throws `FST_REQ_FILE_TOO_LARGE` past it,
 *    which {@link multipartFailure} maps to `413`.
 *  - `fields: 8` — the largest field set on either route is five
 *    (`mode`, `fileType`, `portfolioId`, `cashAccountId`, `resolutions`).
 */
/**
 * The largest field set either route sends is **five** (`mode`, `fileType`,
 * `portfolioId`, `cashAccountId`, `resolutions`) — the number this file's own
 * doc comment already stated while the limit said 8 (LOW-6).
 * Stated at the real figure so the memory arithmetic below is the true one.
 */
export const IMPORT_MAX_MULTIPART_FIELDS = 5;

/**
 * Per-field byte cap (LOW-6), sized against the one field that
 * can legitimately be large.
 *
 * `resolutions` is a JSON document carried as a multipart field: one entry per
 * asset row, ~235 bytes each at the shape `ImportInstrumentResolution` has, and
 * `IMPORT_MAX_ROWS` is 5 000 — so a maximal confirm is about **1.15 MB**.
 * `@fastify/busboy`'s default is **1 MiB**, which that would exceed: the field
 * is truncated, `@fastify/multipart` raises `FST_INVALID_JSON_FIELD_ERROR`
 * (`index.js:324`), and before LOW-5's taxonomy entry below that arrived as a
 * **500 logged as a server bug** for a request that was entirely legitimate.
 *
 * 2 MiB clears the ceiling with room for a wider resolution shape. The
 * worst-case buffered field memory is therefore
 * `5 × 2 MiB = 10 MiB`, plus the 1 MiB file — stated here because the doc
 * comment below used to claim 1 MiB total, and the real figure was ~9 MiB.
 */
export const IMPORT_MAX_FIELD_BYTES = 2 * 1024 * 1024;

/**
 * Framing bytes one multipart envelope may carry beyond its parts' own
 * payloads: boundary lines, per-part headers and the terminator.
 *
 * **MEASURED** (EI-29, 2026-09-24): a body carrying a single 4 096-byte file
 * part declared `content-length: 4297` — **201 bytes** of framing for one part
 * with a filename and a content type. 64 KiB is ~300× that and covers the five
 * field parts {@link IMPORT_MAX_MULTIPART_FIELDS} permits with their own
 * headers, so the pre-check below can never refuse a *legitimate* request for
 * framing it did not account for.
 */
const MULTIPART_FRAMING_BYTES = 64 * 1024;

/**
 * How far a legitimate request's declared `content-length` may exceed its
 * path's own **file** ceiling — the whole of the envelope that is not the file.
 *
 * This is why the `content-length` pre-check is a *pre*-check and not the
 * bound: `content-length` describes the envelope, and the envelope legitimately
 * carries up to `IMPORT_MAX_MULTIPART_FIELDS × IMPORT_MAX_FIELD_BYTES` = 10 MiB
 * of fields (a maximal `resolutions` confirm) plus framing beside the file. A
 * pre-check that compared the declared length against the file ceiling alone
 * would `413` a request whose *file* is exactly at the ceiling — which is the
 * case AC-436 requires to be accepted.
 *
 * So the two lines have different jobs and both are needed: this one refuses,
 * before a byte is read, a body that **cannot** be within the ceiling however
 * it is composed; `readImportUpload`'s per-request `fileSize` then bounds the
 * file itself exactly, while it is being read.
 */
export const MULTIPART_ENVELOPE_ALLOWANCE_BYTES =
  IMPORT_MAX_MULTIPART_FIELDS * IMPORT_MAX_FIELD_BYTES + MULTIPART_FRAMING_BYTES;

export async function registerImportMultipart(
  instance: FastifyInstance,
  options: ImportMultipartOptions,
): Promise<void> {
  await instance.register(fastifyMultipart, {
    limits: {
      files: 1,
      // The maximum over the map, never one route's own value.
      fileSize: Math.max(...options.ceilings.values()),
      // LOW-6 — both numbers are now stated rather than
      // defaulted, and the reason is in this function's doc comment: an unset
      // `fieldSize` defaults to **1 MiB per field** in `@fastify/busboy`
      // (`lib/types/multipart.js:56`), which a maximal legitimate `resolutions`
      // confirm exceeds.
      fields: IMPORT_MAX_MULTIPART_FIELDS,
      fieldSize: IMPORT_MAX_FIELD_BYTES,
    },
  });

  instance.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done) => {
    if (!isMultipartContentType(request.headers["content-type"])) {
      done();
      return;
    }
    const ceiling = options.ceilings.get(pathOf(request.url));
    if (ceiling === undefined) {
      // Fastify's own status and reason for an unparseable media type, kept
      // identical so this route's behaviour is unchanged by the plugin's
      // presence — only the body is this app's problem+json convention, as it is
      // for every other error it emits.
      const body: ProblemDetails = {
        type: "about:blank",
        title: "Unsupported Media Type",
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        detail:
          "multipart/form-data is accepted only by the import routes; this route takes application/json",
      };
      void reply.status(415).header("content-type", "application/problem+json").send(body);
      return;
    }

    // The `content-length` pre-check, here rather than in the
    // handler because `onRequest` runs **before** content-type parsing: a body
    // refused here is refused before the parser has read a byte of it, which is
    // what keeps a hostile 32 MiB declaration on a 1 MiB route from costing
    // 32 MiB of socket reads. MEASURED (EI-29): Fastify does expose
    // `content-length` on `request.headers` at this point.
    //
    // A chunked request declares no length; it falls through to the parser,
    // which bounds it exactly. This check never *admits* anything — it only
    // refuses early.
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > ceiling + MULTIPART_ENVELOPE_ALLOWANCE_BYTES) {
      const body: ProblemDetails = {
        type: "about:blank",
        title: "The uploaded file is too large",
        status: 413,
        // The same code the parser's own refusal carries
        // ({@link multipartFailure}): from the caller's side it is one fact,
        // and which of the two lines caught it is not the caller's business.
        code: "IMPORT_FILE_TOO_LARGE",
        detail:
          `this request declares ${String(declared)} bytes, which cannot fit this route's ` +
          `${String(ceiling)}-byte file ceiling however the body is composed`,
      };
      void reply.status(413).header("content-type", "application/problem+json").send(body);
      return;
    }
    done();
  });
}

/** One import upload, read whole: the single file's bytes plus every string field beside it. */
export interface ImportUpload {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Reads exactly one file part and the string fields around it, or throws the
 * `problem+json` exception that says why it could not.
 *
 * **Every failure below is a whole-request failure, hence `problem+json`, and
 * not a `rows[]` entry**: a request whose file never arrived, or arrived
 * twice, or overran the byte cap, has no rows to report outcomes for. The
 * per-row envelope starts once there is a file to parse.
 *
 * The parts are consumed in order and the file is buffered rather than
 * streamed to disk: `IMPORT_MAX_FILE_BYTES` is 1 MiB and the parser enforces it
 * *while* filling the buffer (`part.toBuffer()` throws `FST_REQ_FILE_TOO_LARGE`
 * the moment the stream is truncated), so there is no window in which an
 * over-cap **file** is fully in memory.
 *
 * **The fields are the other half, and this comment used to omit them**
 * (LOW-6). It claimed the buffered memory was bounded by the
 * 1 MiB file cap; with `fieldSize` unset it was really ~9 MiB — busboy's 1 MiB
 * default times the eight fields then permitted, plus the file. Both numbers
 * are now explicit ({@link IMPORT_MAX_MULTIPART_FIELDS},
 * {@link IMPORT_MAX_FIELD_BYTES}) and the true worst case is stated where they
 * are defined: **10 MiB of fields plus 1 MiB of file**. Larger than the old
 * claim, and the point is that it is now the real figure rather than a smaller
 * wrong one.
 */
/**
 * A **per-request** upload ceiling, overriding the plugin-wide `fileSize` this
 * instance was registered with (KD14).
 *
 * Optional and additive: omitted — every caller today — `request.parts()` is
 * called with no arguments, exactly as before, so the plugin's own
 * `limits.fileSize` is the only bound. Passed, the route's own ceiling applies
 * to that one request while the plugin stays registered at the maximum over
 * every import path, which is what lets a 32 MiB JSON route coexist with the
 * PP routes' 1 MiB bound instead of silently retiring it.
 *
 * That the plugin honours this at all is a **measured** fact, not an assumed
 * one, proved by the RK2 probe:
 * `imports-multipart-per-request-limit.e2e.test.ts` is a live round trip that
 * fails if a library upgrade ever flips it.
 */
export interface ImportUploadLimits {
  readonly maxFileBytes: number;
}

export async function readImportUpload(
  request: FastifyRequest,
  limits?: ImportUploadLimits,
): Promise<ImportUpload> {
  if (!request.isMultipart()) {
    throw problemException(400, {
      title: "This route takes a multipart/form-data upload",
      code: "IMPORT_MULTIPART_REQUIRED",
      detail: "send the CSV as a multipart/form-data body with a `file` part",
    });
  }

  const fields: Record<string, string> = {};
  let file: { filename: string; bytes: Uint8Array } | null = null;

  try {
    // KD14 — the no-argument call is kept verbatim for the
    // omitted case so the shipped behaviour is byte-identical, and it stays
    // inside this `try` so whatever it raises is still mapped by
    // `multipartFailure`; the override is only ever built when a caller asked
    // for one.
    const parts =
      limits === undefined
        ? request.parts()
        : request.parts({ limits: { fileSize: limits.maxFileBytes } });
    for await (const part of parts) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          throw problemException(400, {
            title: "Unexpected file part",
            code: "IMPORT_UNEXPECTED_FILE_PART",
            detail: `the only file part this route reads is named \`file\`; got \`${part.fieldname}\``,
          });
        }
        // Buffered here, inside the loop, because the parts are one stream: a
        // part left unread stalls the iterator rather than being skipped.
        file = { filename: part.filename, bytes: await part.toBuffer() };
        continue;
      }
      fields[part.fieldname] = String(part.value);
    }
  } catch (error) {
    throw multipartFailure(error);
  }

  if (file === null) {
    throw problemException(400, {
      title: "No file was uploaded",
      code: "IMPORT_FILE_REQUIRED",
      detail: "the multipart body must carry exactly one part named `file`",
    });
  }
  return { filename: file.filename, bytes: file.bytes, fields };
}

/**
 * The plugin's own error taxonomy, mapped to this app's statuses.
 *
 * `FST_REQ_FILE_TOO_LARGE` is the one that matters and is the only `413` here:
 * the byte cap, enforced by the parser rather than by a length check this
 * code could get wrong. The others are malformed requests, not oversized ones,
 * so they are `400` — `FST_FILES_LIMIT` in particular is "you sent two files",
 * which is a shape error, not a size error, even though the plugin's own
 * default status for it is `413`.
 *
 * Anything else is returned unchanged and becomes whatever
 * `ProblemJsonExceptionFilter` makes of it — including an exception this
 * function's own caller threw, which must pass through rather than be
 * re-labelled as a transport failure.
 */
export function multipartFailure(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "FST_REQ_FILE_TOO_LARGE") {
    return problemException(413, {
      title: "The uploaded file is too large",
      code: "IMPORT_FILE_TOO_LARGE",
      detail: "this file exceeds the import upload size limit",
    });
  }
  if (code === "FST_FILES_LIMIT") {
    return problemException(400, {
      title: "Only one file may be uploaded per import",
      code: "IMPORT_TOO_MANY_FILES",
      detail: "send exactly one part named `file`",
    });
  }
  if (
    code === "FST_PARTS_LIMIT" ||
    code === "FST_FIELDS_LIMIT" ||
    code === "FST_PROTO_VIOLATION" ||
    code === "FST_INVALID_MULTIPART_CONTENT_TYPE" ||
    code === "FST_MP_PREMATURE_CLOSE" ||
    // LOW-5 — the sixth code `@fastify/multipart@10.1.1` can
    // raise (`index.js:27`, thrown at `:325,333`): a field that declares
    // `Content-Type: application/json` and is not valid JSON, was truncated at
    // `fieldSize`, or trips `secure-json-parse`'s proto guard.
    //
    // Being a `FastifyError` rather than a Nest `HttpException`, it fell past
    // `toProblem`'s branches into `log().error("unhandled error mapped to
    // 500")` — so a **client-caused** malformed upload was recorded as a
    // **server bug**, which is exactly the signal that 500 branch exists to
    // preserve. Mapped to 400 with the same code as its five siblings: from
    // the caller's side it is the same fact, a body this route could not read.
    code === "FST_INVALID_JSON_FIELD_ERROR"
  ) {
    return problemException(400, {
      title: "The multipart upload could not be read",
      code: "IMPORT_MALFORMED_UPLOAD",
      detail: "the multipart body was malformed or carried more parts than this route accepts",
    });
  }
  return error;
}
