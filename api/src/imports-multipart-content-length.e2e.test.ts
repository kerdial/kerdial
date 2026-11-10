import { HttpException } from "@nestjs/common";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProblemDetails } from "./common/problem.js";
import {
  IMPORT_MULTIPART_PATHS,
  MULTIPART_ENVELOPE_ALLOWANCE_BYTES,
  readImportUpload,
  registerImportMultipart,
} from "./imports/multipart.js";

/**
 * EI-29 — the **`content-length` pre-check**, the half of KD14 that
 * GATE-0a's probe deliberately does not touch.
 *
 * ## The three claims, and why each needs its own shape
 *
 *  1. **It refuses before a byte of the body is read.** Asserted by a raw
 *     `node:http` request that *declares* a huge `Content-Length`, writes a
 *     kilobyte, and never sends the rest. If the server read the body first it
 *     would block until the request timeout; the response arriving while the
 *     client still holds ~99,99 % of the declared bytes is the proof, and the
 *     bytes actually written are counted rather than described.
 *  2. **It is per path, not per instance.** The same declared length is refused
 *     on a 1 MiB path and accepted on the 32 MiB one — the map's value half
 *     doing work, which is the RK2 regression restated at the pre-check.
 *  3. **It never refuses a legitimate request**, which is the trap this check
 *     walks into if written naively: `content-length` measures the *envelope*,
 *     and a file exactly at the ceiling declares more than the ceiling
 *     (MEASURED: **201 bytes** of framing for a single file part, and a
 *     legitimate `resolutions` confirm adds up to 10 MiB of fields). Hence
 *     {@link MULTIPART_ENVELOPE_ALLOWANCE_BYTES}, and hence a case that uploads
 *     exactly `maxFileBytes` and expects `200`.
 *
 * ## Why a bare Fastify instance
 *
 * GATE-0a's own reason, unchanged: the subject is the parser and its scope
 * hook, both of which are the shipped functions here, and a Nest app would cost
 * a Postgres container to assert the same statuses. The map under test is the
 * **shipped** {@link IMPORT_MULTIPART_PATHS}, so the ceilings are the
 * production ones rather than a fixture's.
 */

const PP_PATH = "/api/v1/imports/transactions";
const JSON_PATH = "/api/v1/imports/kerdial/catalogue";
const NOT_AN_IMPORT_PATH = "/api/v1/transactions";

const PP_CEILING = IMPORT_MULTIPART_PATHS.get(PP_PATH)!;
const JSON_CEILING = IMPORT_MULTIPART_PATHS.get(JSON_PATH)!;

/** Over the PP path's pre-check threshold, comfortably under the JSON path's. */
const BETWEEN_THE_TWO_THRESHOLDS = PP_CEILING + MULTIPART_ENVELOPE_ALLOWANCE_BYTES + 1_048_576;

describe("api — the content-length pre-check refuses an over-size upload before reading it (EI-29)", () => {
  let instance: FastifyInstance;
  let port: number;

  function handler(maxFileBytes: number) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const upload = await readImportUpload(request, { maxFileBytes });
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
    instance = fastify();
    await registerImportMultipart(instance, { ceilings: IMPORT_MULTIPART_PATHS });
    instance.post(PP_PATH, handler(PP_CEILING));
    instance.post(JSON_PATH, handler(JSON_CEILING));
    instance.post(NOT_AN_IMPORT_PATH, handler(PP_CEILING));
    await instance.listen({ host: "127.0.0.1", port: 0 });
    port = (instance.server.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await instance.close();
  });

  /**
   * Declares `declaredBytes`, writes `writtenBytes` of them, and never sends
   * the rest — so a server that waits for the body cannot answer at all.
   */
  async function declareAndStall(
    path: string,
    declaredBytes: number,
    writtenBytes: number,
  ): Promise<{ status: number; body: ProblemDetails; bytesWritten: number }> {
    return await new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=kerdialboundary",
          "content-length": String(declaredBytes),
        },
      });
      outgoing.on("response", (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProblemDetails,
            bytesWritten: outgoing.socket?.bytesWritten ?? -1,
          });
          outgoing.destroy();
        });
      });
      // The server answers early and then destroys the socket rather than
      // draining a body it refused — an `ECONNRESET` *after* the response is
      // the expected shape, not a failure, so only a pre-response error counts.
      outgoing.on("error", (error) => {
        if (!outgoing.destroyed) reject(error);
      });
      outgoing.write(Buffer.alloc(writtenBytes, 0x78));
      // Deliberately no `outgoing.end()`.
    });
  }

  it("answers 413 while the client still holds almost the whole declared body", async () => {
    const declared = JSON_CEILING + MULTIPART_ENVELOPE_ALLOWANCE_BYTES + 1;
    const { status, body, bytesWritten } = await declareAndStall(JSON_PATH, declared, 1024);

    expect(status).toBe(413);
    expect(body.code).toBe("IMPORT_FILE_TOO_LARGE");
    // The cheapness claim, counted: the refusal cost the socket a kilobyte and
    // some headers, not the 42 MiB the request declared.
    expect(bytesWritten).toBeLessThan(8 * 1024);
    expect(declared - bytesWritten).toBeGreaterThan(40 * 1024 * 1024);
  }, 30_000);

  it("refuses that same declaration on the 1 MiB path too — and names that path's own ceiling", async () => {
    const { status, body } = await declareAndStall(PP_PATH, BETWEEN_THE_TWO_THRESHOLDS, 1024);

    expect(status).toBe(413);
    expect(body.code).toBe("IMPORT_FILE_TOO_LARGE");
    expect(body.detail).toContain(String(PP_CEILING));
  }, 30_000);

  it("answers a 413 an ordinary client can read, when the whole body is actually sent", async () => {
    // The stalling client above proves the refusal is *early*; this one proves
    // it is *usable*. A hook that replies before consuming the request stream
    // can leave the socket in a state where the client sees `ECONNRESET`
    // instead of the problem document — a real failure mode, and the reason
    // the same refusal is asserted twice through two different clients.
    const response = await supertest(`http://127.0.0.1:${String(port)}`)
      .post(PP_PATH)
      .attach("file", Buffer.alloc(BETWEEN_THE_TWO_THRESHOLDS, 0x78), {
        filename: "cash.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
  }, 60_000);

  it("accepts the very same declared length on the 32 MiB path — the check is per path, not per instance", async () => {
    // The discriminator. Without it the two refusals above are equally
    // consistent with one instance-wide threshold, which is precisely the RK2
    // regression the per-path map exists to prevent.
    const response = await supertest(`http://127.0.0.1:${String(port)}`)
      .post(JSON_PATH)
      .attach("file", Buffer.alloc(BETWEEN_THE_TWO_THRESHOLDS, 0x78), {
        filename: "catalogue.json",
        contentType: "application/json",
      });

    expect(response.status).toBe(200);
    expect(response.body.receivedBytes).toBe(BETWEEN_THE_TWO_THRESHOLDS);
  }, 60_000);

  it("accepts a file of exactly the path's ceiling, whose envelope is necessarily larger", async () => {
    // The trap, asserted rather than reasoned about: a pre-check comparing the
    // declared length against `maxFileBytes` alone would refuse this — a
    // request that is entirely legitimate and that AC-436 requires to be
    // accepted — because the multipart framing puts the envelope over the
    // ceiling by ~200 bytes before a single field is added.
    const response = await supertest(`http://127.0.0.1:${String(port)}`)
      .post(PP_PATH)
      .attach("file", Buffer.alloc(PP_CEILING, 0x78), {
        filename: "cash.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(200);
    expect(response.body.receivedBytes).toBe(PP_CEILING);
  }, 60_000);

  it("still answers 415 on a path that is not an import path, whatever it declares", async () => {
    // The hook's original job (RC6), unchanged by the pre-check being added
    // inside it: a path with no entry in the map is refused on its media type
    // and never reaches the size question at all.
    const { status, body } = await declareAndStall(
      NOT_AN_IMPORT_PATH,
      JSON_CEILING + MULTIPART_ENVELOPE_ALLOWANCE_BYTES + 1,
      1024,
    );

    expect(status).toBe(415);
    expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  }, 30_000);
});
