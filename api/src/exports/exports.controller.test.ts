import { HttpException } from "@nestjs/common";
import { KERDIAL_JSON_LIMITS } from "@kerdial/importer";
import type { SessionContext } from "@kerdial/platform-auth";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import type { FastifyReply } from "fastify";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProblemDetails } from "../common/problem.js";
import { ExportsController } from "./exports.controller.js";
import type {
  CatalogueExportOptions,
  CatalogueExportResult,
  TransactionsExportResult,
} from "./exports.reads.js";
import type { ExportReads } from "./exports.tokens.js";

/**
 * EI-25 — the export routes' **header and size-gate** behaviour, at the level
 * where the `413` boundary is constructible.
 *
 * ## Why the reads are stubbed here and real in `exports.e2e.test.ts`
 *
 * KD4's refusal threshold is 33 554 432 bytes. Making a real tenant serialise
 * to exactly that, and to exactly one more, would take a corpus of ~95 maximal
 * icons sized to the byte — so the boundary would in practice be asserted by
 * reading the constant, which is exactly what this project's standing rule
 * about limits forbids. With {@link ExportReads} bound to a stub that returns a
 * buffer of a chosen length, both sides of the boundary are one cheap case
 * each, and the buffers are **real** (`Buffer.alloc`) rather than a `byteLength`
 * that disagrees with its own body.
 *
 * Everything that needs a real socket — `Cache-Control`, the CSRF exemption,
 * `401` with no session, a valid body for an empty tenant — is asserted over
 * real HTTP in `exports.e2e.test.ts`. Neither file is sufficient alone and
 * neither repeats the other.
 */

const SESSION: SessionContext = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  isInstanceAdmin: false,
};

/** A `FastifyReply` that records the headers set on it. Chainable, like the real one. */
function recordingReply(): { reply: FastifyReply; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const reply = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, headers };
}

function catalogueResult(byteLength: number): CatalogueExportResult {
  return {
    refused: false,
    body: Buffer.alloc(byteLength, 0x7b),
    byteLength,
    exportedAt: new Date("2026-09-24T10:00:00.000Z"),
    counts: {
      instruments: 3,
      portfolios: 1,
      cashAccounts: 1,
      icons: 0,
      manualPrices: 0,
      watchlistItems: 0,
      fxRatesUser: 0,
    },
    durationMs: 12.4,
  };
}

function transactionsResult(body: string): TransactionsExportResult {
  const buffer = Buffer.from(body, "utf8");
  return { body: buffer, byteLength: buffer.byteLength, rowCount: 0, durationMs: 3.1 };
}

interface Harness {
  readonly controller: ExportsController;
  /** Every `{ icons }` the catalogue read was called with, in order. */
  readonly catalogueCalls: CatalogueExportOptions[];
}

function harness(overrides: Partial<ExportReads> = {}): Harness {
  const catalogueCalls: CatalogueExportOptions[] = [];
  const reads: ExportReads = {
    readCatalogue: async (_db, _tenantId, options) => {
      catalogueCalls.push(options);
      return catalogueResult(64);
    },
    readTransactions: async () => transactionsResult("kerdial-transactions;v1\r\nrow_ref\r\n"),
    ...overrides,
  };
  return {
    controller: new ExportsController({} as Db, reads, KERDIAL_JSON_LIMITS),
    catalogueCalls,
  };
}

function problemOf(error: unknown): { status: number; body: ProblemDetails } {
  if (!(error instanceof HttpException)) throw error;
  return { status: error.getStatus(), body: error.getResponse() as ProblemDetails };
}

describe("ExportsController — KD6's content types, FR-509's constant filenames (EI-25)", () => {
  it("serves the catalogue as application/json attached as kerdial-instruments.json", async () => {
    const { controller } = harness();
    const { reply, headers } = recordingReply();

    const body = await controller.exportInstruments({}, SESSION, reply);

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("content-disposition")).toBe(
      'attachment; filename="kerdial-instruments.json"',
    );
    expect(headers.get("content-length")).toBe("64");
    expect(body.byteLength).toBe(64);
  });

  it("serves the transactions package as text/csv; charset=utf-8 attached as kerdial-transactions.csv", async () => {
    const { controller } = harness();
    const { reply, headers } = recordingReply();

    const body = await controller.exportTransactions(SESSION, reply);

    expect(headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(headers.get("content-disposition")).toBe(
      'attachment; filename="kerdial-transactions.csv"',
    );
    expect(headers.get("content-length")).toBe(String(body.byteLength));
  });

  it("reflects nothing client-supplied into content-disposition (FR-509)", async () => {
    // The reddening assertion: the filename is a literal, so a query string
    // that tries to name the file must change nothing at all. An
    // implementation that interpolated `query.filename` would pass every other
    // case in this file and fail this one.
    const { controller } = harness();
    const { reply, headers } = recordingReply();

    await expect(
      controller.exportInstruments(
        { filename: "../../etc/passwd", icons: "included" },
        SESSION,
        reply,
      ),
    ).rejects.toBeInstanceOf(HttpException);

    // `z.strictObject` refuses the unknown key outright, so no header was even
    // reached — which is a stronger answer than "the header was set to the
    // constant anyway".
    expect(headers.size).toBe(0);
  });
});

describe("ExportsController — ?icons (KD4.2)", () => {
  it("defaults to included when the query is absent", async () => {
    const { controller, catalogueCalls } = harness();
    await controller.exportInstruments({}, SESSION, recordingReply().reply);
    expect(catalogueCalls).toEqual([
      { icons: "included", maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes },
    ]);
  });

  it("passes omitted straight through to the read, which is what skips the icon queries", async () => {
    const { controller, catalogueCalls } = harness();
    await controller.exportInstruments({ icons: "omitted" }, SESSION, recordingReply().reply);
    expect(catalogueCalls).toEqual([
      { icons: "omitted", maxFileBytes: KERDIAL_JSON_LIMITS.maxFileBytes },
    ]);
  });

  it("refuses any other value with a 400 rather than silently defaulting", async () => {
    const { controller } = harness();
    const error = await controller
      .exportInstruments({ icons: "maybe" }, SESSION, recordingReply().reply)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(problemOf(error).status).toBe(400);
  });
});

describe("ExportsController — 413 EXPORT_TOO_LARGE at the byte boundary (KD4.3)", () => {
  const CEILING = KERDIAL_JSON_LIMITS.maxFileBytes;

  it("serves a document of exactly the ceiling", async () => {
    const { controller } = harness({ readCatalogue: async () => catalogueResult(CEILING) });
    const { reply, headers } = recordingReply();

    const body = await controller.exportInstruments({}, SESSION, reply);

    expect(body.byteLength).toBe(CEILING);
    expect(headers.get("content-length")).toBe(String(CEILING));
  });

  it("refuses one byte over it, naming the size, the ceiling and the icons=omitted remedy", async () => {
    const { controller } = harness({ readCatalogue: async () => catalogueResult(CEILING + 1) });

    const error = await controller.exportInstruments({}, SESSION, recordingReply().reply).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { status, body } = problemOf(error);

    expect(status).toBe(413);
    expect(body.code).toBe("EXPORT_TOO_LARGE");
    // Each of the three facts KD4.3 requires the body to carry, asserted
    // individually: a `detail` that named only the size would be a refusal the
    // user cannot act on, which is the whole reason the remedy is in it.
    expect(body.detail).toContain(String(CEILING + 1));
    expect(body.detail).toContain(String(CEILING));
    expect(body.detail).toContain("icons=omitted");
    expect(body.params).toEqual({
      bytes: CEILING + 1,
      maxBytes: CEILING,
      remedy: "icons=omitted",
    });
  });

  it("never emits a truncated body: no header is set on the refused request", async () => {
    // The negative half KD4.3 states out loud. A controller that clipped the
    // buffer to the ceiling and returned `200` would satisfy "the response is
    // at most 32 MiB" and be exactly the behaviour this forbids.
    const { controller } = harness({ readCatalogue: async () => catalogueResult(CEILING + 1) });
    const { reply, headers } = recordingReply();

    await expect(controller.exportInstruments({}, SESSION, reply)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(headers.size).toBe(0);
  });

  /**
   * (security review M2). The read now refuses **during** the
   * icon paging, so the controller's job on that path is to turn a
   * `CatalogueExportTooLarge` into the same 413 the backstop raises — with one
   * difference the user has to be told about: its byte count is a lower bound,
   * because the projection leaves out the JSON each icon object wraps.
   */
  it("maps the read's early refusal to the same 413, qualified as a lower bound", async () => {
    const projectedBytes = CEILING + 4_000_000;
    const { controller } = harness({
      readCatalogue: async () => ({
        refused: true,
        projectedBytes,
        iconsRead: 100,
        maxFileBytes: CEILING,
        durationMs: 40.2,
      }),
    });
    const { reply, headers } = recordingReply();

    const error = await controller.exportInstruments({}, SESSION, reply).then(
      () => null,
      (caught: unknown) => caught,
    );
    const { status, body } = problemOf(error);

    expect(status).toBe(413);
    expect(body.code).toBe("EXPORT_TOO_LARGE");
    expect(body.detail).toContain("at least");
    expect(body.detail).toContain(String(projectedBytes));
    expect(body.detail).toContain("icons=omitted");
    expect(body.params).toEqual({
      bytes: projectedBytes,
      maxBytes: CEILING,
      remedy: "icons=omitted",
    });
    // Same negative as the backstop's: nothing was served, not even a header.
    expect(headers.size).toBe(0);
  });

  it("has no size gate on the transactions route at all", async () => {
    // KD4's ceiling is an *icon* budget. The CSV's size is bounded by its row
    // cap and by the measured ~277 bytes/row, so a second ceiling here would be
    // a limit with no arithmetic behind it — asserted rather than left implicit,
    // because "it happens not to be big enough to notice" is not the same fact.
    const big = "x".repeat(CEILING + 1);
    const { controller } = harness({ readTransactions: async () => transactionsResult(big) });
    const { reply, headers } = recordingReply();

    const body = await controller.exportTransactions(SESSION, reply);

    expect(body.byteLength).toBe(big.length);
    expect(headers.get("content-disposition")).toBe(
      'attachment; filename="kerdial-transactions.csv"',
    );
  });
});

describe("ExportsController — FR-512, an empty tenant is a 200 with a valid file", () => {
  it("serves the catalogue's empty document rather than a 4xx", async () => {
    const empty = JSON.stringify({
      manifest: {},
      instruments: [],
      portfolios: [],
      fxRatesUser: [],
    });
    const { controller } = harness({
      readCatalogue: async () => ({ ...catalogueResult(0), ...bufferOf(empty) }),
    });
    const { reply, headers } = recordingReply();

    const body = await controller.exportInstruments({}, SESSION, reply);

    expect(JSON.parse(body.toString("utf8"))).toMatchObject({ instruments: [] });
    expect(headers.get("content-disposition")).toBe(
      'attachment; filename="kerdial-instruments.json"',
    );
  });

  it("serves the CSV's version line and header row with no data rows", async () => {
    const { controller } = harness();
    const { reply, headers } = recordingReply();

    const body = await controller.exportTransactions(SESSION, reply);

    expect(body.toString("utf8").split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });
});

/**
 * EI-30 — FR-513/NFR-62's log line, asserted against the **emitted**
 * record.
 *
 * ## Why the emitted line and not the call site
 *
 * This repository's own recorded lesson: `LOG_FIELD_ALLOWLIST` drops an
 * unlisted field **silently** (`platform/logging/src/logger.ts`'s
 * `allowListed`), so a test that spied on what the controller *passed* would be
 * green while `bytes` never reached a log at all. Two shipped fields
 * (`backfill_unresolvable_count`, `price_currency_mismatch_count`) were emitted
 * and dropped for exactly that reason, for months. So the logger here is the
 * real one, writing to a real stream, and what is read back is the line.
 *
 * ## The negative half is an exact key set, not a list of `not.toContain`
 *
 * NFR-62 forbids "monetary amount, holding, instrument name, or file content".
 * Naming four things it must not carry would leave a fifth free; asserting the
 * record's **whole** key set makes any addition — including a per-table
 * breakdown, which the log-line contract rules out by name — fail here rather than pass unnoticed.
 */
describe("ExportsController — the export log line carries bytes (EI-30, FR-513/NFR-62)", () => {
  let emitted: string[];
  let restoreLogger: () => void;

  beforeEach(() => {
    emitted = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        emitted.push(chunk.toString());
        callback();
      },
    });
    restoreLogger = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
  });

  afterEach(() => {
    restoreLogger();
  });

  const lines = (): Record<string, unknown>[] =>
    emitted
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("emits bytes on the catalogue line, equal to the body actually served", async () => {
    const { controller } = harness({ readCatalogue: async () => catalogueResult(4_096) });

    const body = await controller.exportInstruments({}, SESSION, recordingReply().reply);

    expect(lines()).toHaveLength(1);
    const line = lines()[0]!;
    expect(line["msg"]).toBe("exports: catalogue package served");
    // Not merely "the field is present": the value is the byte length of the
    // buffer this call returned, so a line that reported a constant, or the
    // ceiling, or the wrong result's size would fail.
    expect(line["bytes"]).toBe(4_096);
    expect(line["bytes"]).toBe(body.byteLength);
    expect(line["count"]).toBe(3);
    expect(line["component"]).toBe("api");
  });

  it("emits bytes on the transactions line too", async () => {
    const csv = "kerdial-transactions;v1\r\nrow_ref\r\n";
    const { controller } = harness({ readTransactions: async () => transactionsResult(csv) });

    const body = await controller.exportTransactions(SESSION, recordingReply().reply);

    const line = lines()[0]!;
    expect(line["msg"]).toBe("exports: transactions package served");
    expect(line["bytes"]).toBe(Buffer.byteLength(csv, "utf8"));
    expect(line["bytes"]).toBe(body.byteLength);
  });

  it("carries these fields and no others — no amount, no name, no per-table breakdown", async () => {
    const { controller } = harness();

    await controller.exportInstruments({}, SESSION, recordingReply().reply);

    expect(Object.keys(lines()[0]!).sort()).toEqual([
      "bytes",
      "component",
      "count",
      "duration_ms",
      "level",
      "msg",
      "time",
    ]);
  });

  it("logs nothing at all for a refused export — the 413 path emits no line", async () => {
    // The `413` is thrown before the log call, and that ordering is the
    // property: a refused export has no duration and no served body, so a line
    // claiming one would be a false record rather than a harmless extra.
    const { controller } = harness({
      readCatalogue: async () => catalogueResult(KERDIAL_JSON_LIMITS.maxFileBytes + 1),
    });

    await expect(
      controller.exportInstruments({}, SESSION, recordingReply().reply),
    ).rejects.toBeInstanceOf(HttpException);

    expect(lines()).toEqual([]);
  });
});

function bufferOf(text: string): { body: Buffer; byteLength: number } {
  const body = Buffer.from(text, "utf8");
  return { body, byteLength: body.byteLength };
}
