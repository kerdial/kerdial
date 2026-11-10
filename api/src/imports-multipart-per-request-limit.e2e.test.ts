import { HttpException } from "@nestjs/common";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProblemDetails } from "./common/problem.js";
import {
  IMPORT_MULTIPART_PATHS,
  readImportUpload,
  registerImportMultipart,
} from "./imports/multipart.js";

/**
 * `portfolio-export-import` EI-1 / GATE-0a — **the RK2 probe, kept as a
 * permanent regression test.**
 *
 * ## The question, and why it is answered by a round trip
 *
 * KD14 raises the multipart plugin's `fileSize` to the
 * **maximum** over the four import paths (32 MiB, for the JSON catalogue
 * route) and re-imposes each route's own ceiling by passing a **per-request**
 * `limits` object to `request.parts()`. The whole design leans on one library
 * behaviour — that `@fastify/multipart` honours that per-request object at all
 * (assumption **A4**). If it does not, the plugin-wide 32 MiB wins and the PP
 * routes' 1 MiB bound is silently retired, which is a **security** regression
 * (risk RK2), not a cosmetic one.
 *
 * So this file never asks the plugin's types or its changelog. It registers
 * the real {@link registerImportMultipart} at 32 MiB, sends real multipart
 * bodies over a real socket, and reads the status code off the response.
 *
 * ## Why it stays here forever
 *
 * A library upgrade could flip the answer at any time, and the failure mode is
 * silent: every existing limits test would stay green while uploads twenty
 * times the stated cap were accepted. The assertion that catches it is exactly
 * the one below.
 *
 * ## Why a bare Fastify instance rather than `startTestApp`
 *
 * The probe's subject is the parser, not the controller: it needs **two
 * different `fileSize` numbers in one process** — the plugin's, and the
 * request's — and the shipped controller passes no override (EI-29 is what
 * adds the real per-route map). A Nest app therefore could not exercise the
 * seam at all today, while costing a Postgres container per run. Everything
 * the probe is about is production code: `registerImportMultipart`, its
 * `onRequest` scope hook, `IMPORT_MULTIPART_PATHS`, `readImportUpload`, and
 * `multipartFailure`'s `FST_REQ_FILE_TOO_LARGE` mapping — only the two route
 * handlers are the test's own, and they are four lines each.
 */

/** The plugin-wide ceiling: the maximum over the import paths, i.e. the JSON route's future 32 MiB. */
const PLUGIN_FILE_BYTES = 33_554_432;

/** The **existing** PP transaction route's ceiling (`DEFAULT_IMPORT_LIMITS.maxFileBytes`), imposed per request. */
const PER_REQUEST_FILE_BYTES = 1_048_576;

/** The path that carries the per-request override, and the one that does not — both real import paths. */
const OVERRIDDEN_PATH = "/api/v1/imports/transactions";
const PLUGIN_ONLY_PATH = "/api/v1/imports/instruments";

function payload(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0x78);
}

describe("api — @fastify/multipart honours a per-request limits override (EI-1, RK2)", () => {
  let instance: FastifyInstance;

  function post(path: string, file: Buffer): supertest.Test {
    return supertest(instance.server)
      .post(path)
      .attach("file", file, { filename: "upload.csv", contentType: "text/csv" });
  }

  /**
   * The controller's own two lines, minus everything that needs a database:
   * read the upload, and let `readImportUpload`'s already-mapped exception
   * become the `problem+json` body `ProblemJsonExceptionFilter` would have
   * produced in the real app.
   */
  function handler(limits: { maxFileBytes: number } | undefined) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const upload = await readImportUpload(request, limits);
        await reply.status(200).send({ receivedBytes: upload.bytes.length });
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        await reply
          .status(error.getStatus())
          .header("content-type", "application/problem+json")
          .send(error.getResponse() as ProblemDetails);
      }
    };
  }

  beforeAll(async () => {
    // The probe's own premise: both paths must be ones the scope hook lets a
    // multipart body through on, or every case below would be a 415 about
    // something else entirely.
    expect(IMPORT_MULTIPART_PATHS.has(OVERRIDDEN_PATH)).toBe(true);
    expect(IMPORT_MULTIPART_PATHS.has(PLUGIN_ONLY_PATH)).toBe(true);

    instance = fastify();
    // **Both paths are registered at the plugin-wide ceiling**, which is what
    // keeps EI-29's `content-length` pre-check out of this probe's way: the
    // subject here is the *parser* honouring a per-request `limits` object, and
    // a pre-check that refused the 1 MiB + 1 body before the parser saw it
    // would make every case below green for the wrong reason. The pre-check has
    // its own file (`imports-multipart-content-length.e2e.test.ts`); the
    // shipped per-path map has its own inventory assertion
    // (`instrument-icon.e2e.test.ts`).
    await registerImportMultipart(instance, {
      ceilings: new Map([
        [OVERRIDDEN_PATH, PLUGIN_FILE_BYTES],
        [PLUGIN_ONLY_PATH, PLUGIN_FILE_BYTES],
      ]),
    });
    instance.post(OVERRIDDEN_PATH, handler({ maxFileBytes: PER_REQUEST_FILE_BYTES }));
    instance.post(PLUGIN_ONLY_PATH, handler(undefined));
    await instance.ready();
  }, 30_000);

  afterAll(async () => {
    await instance.close();
  });

  it("refuses 1 MiB + 1 with 413 IMPORT_FILE_TOO_LARGE, with the plugin registered at 32 MiB", async () => {
    const response = await post(OVERRIDDEN_PATH, payload(PER_REQUEST_FILE_BYTES + 1));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
  });

  it("accepts 1 MiB - 1 on the same route — the override refuses by size, not everything", async () => {
    const response = await post(OVERRIDDEN_PATH, payload(PER_REQUEST_FILE_BYTES - 1));

    expect(response.status).toBe(200);
    expect(response.body.receivedBytes).toBe(PER_REQUEST_FILE_BYTES - 1);
  });

  it("accepts the very same 1 MiB + 1 body on a route with no override — so the refusal is the override's", async () => {
    // The discriminator, and the reason this file boots one instance with two
    // routes rather than one route. Without it, the 413 above is equally
    // consistent with the plugin having ignored the 32 MiB registration, with
    // Fastify's own `bodyLimit`, or with any other byte cap in the stack — and
    // the probe would have "confirmed" A4 while measuring none of it.
    const response = await post(PLUGIN_ONLY_PATH, payload(PER_REQUEST_FILE_BYTES + 1));

    expect(response.status).toBe(200);
    expect(response.body.receivedBytes).toBe(PER_REQUEST_FILE_BYTES + 1);
  });

  it("still refuses a body over the plugin-wide ceiling, override or not — the outer bound is intact", async () => {
    // The plugin's own limit stays as the outer bound. A per-request
    // object that *replaced* the plugin's `limits` wholesale rather than
    // narrowing this request would be a different behaviour with the same
    // green result above, and this is what tells them apart.
    const response = await post(PLUGIN_ONLY_PATH, payload(PLUGIN_FILE_BYTES + 1));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
  }, 30_000);
});
