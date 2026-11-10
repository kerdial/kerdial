import {
  DEFAULT_IMPORT_LIMITS,
  KERDIAL_CSV_LIMITS,
  KERDIAL_JSON_LIMITS,
  type CatalogueEnrolmentCandidate,
} from "@kerdial/importer";
import type { MarketRuntime } from "@kerdial/market-composition";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import type { Db } from "@kerdial/platform-db";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportsController } from "./imports.controller.js";

/**
 * EI-27 — `ImportsController.triggerCatalogueBackfills`, FR-557/KD10's
 * enrolment loop, asserted at the three points a whole-route test cannot reach
 * cheaply.
 *
 * ## Why here and not in the e2e
 *
 * `imports-kerdial.e2e.test.ts` proves the loop *runs* and that a real
 * `instrument_backfill_state` row lands — the AC-447 half, which needs a real
 * database. The three properties below need the opposite: a runtime that
 * **throws**, a candidate whose kind has no provider, and no runtime at all.
 * Each would otherwise cost its own app (and its own Postgres) to express, and
 * two of them would be unobservable through a `200` body anyway.
 *
 * The subject is the shipped method, called directly. Nothing here is a
 * reimplementation of it.
 */
describe("ImportsController#triggerCatalogueBackfills (EI-27, FR-557/KD10)", () => {
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

  interface Enqueued {
    readonly instrumentId: string;
    readonly kind: string;
  }

  function controllerWith(runtime: MarketRuntime | null): ImportsController {
    return new ImportsController(
      {} as Db,
      runtime,
      DEFAULT_IMPORT_LIMITS,
      KERDIAL_CSV_LIMITS,
      KERDIAL_JSON_LIMITS,
    );
  }

  function recordingRuntime(enqueued: Enqueued[], failFor?: string): MarketRuntime {
    return {
      discovery: {} as MarketRuntime["discovery"],
      scheduler: null,
      async enqueueBackfill(_db: Db, params: { instrumentId: string; kind: string }) {
        if (params.instrumentId === failFor) {
          throw new Error("pg-boss is not reachable");
        }
        enqueued.push({ instrumentId: params.instrumentId, kind: params.kind });
      },
      async requestBackfillReload() {
        throw new Error("requestBackfillReload is not this path");
      },
      async start() {},
      async stop() {},
    } as unknown as MarketRuntime;
  }

  const SHARE: CatalogueEnrolmentCandidate = { id: "share-1", kind: "SHARE" };
  const FUND: CatalogueEnrolmentCandidate = { id: "fund-1", kind: "FUND" };
  const CRYPTO: CatalogueEnrolmentCandidate = { id: "crypto-1", kind: "CRYPTO" };

  it("enqueues one backfill per created instrument, carrying its kind", async () => {
    const enqueued: Enqueued[] = [];
    await controllerWith(recordingRuntime(enqueued)).triggerCatalogueBackfills([SHARE, CRYPTO]);

    expect(enqueued).toEqual([
      { instrumentId: "share-1", kind: "SHARE" },
      { instrumentId: "crypto-1", kind: "CRYPTO" },
    ]);
  });

  it("ADR-0018: a FUND is enqueued like a SHARE — its NAV comes from the same provider now (this file asserted the AC-14 skip before)", async () => {
    const enqueued: Enqueued[] = [];
    await controllerWith(recordingRuntime(enqueued)).triggerCatalogueBackfills([FUND, SHARE]);

    expect(enqueued).toEqual([
      { instrumentId: "fund-1", kind: "FUND" },
      { instrumentId: "share-1", kind: "SHARE" },
    ]);
  });

  it("swallows a failing enqueue, logs it with the instrument's id, and still enrols the rest", async () => {
    const enqueued: Enqueued[] = [];
    const controller = controllerWith(recordingRuntime(enqueued, "share-1"));

    await expect(controller.triggerCatalogueBackfills([SHARE, CRYPTO])).resolves.toBeUndefined();

    // The failure did not stop the loop — the catalogue's other created
    // instrument is still enrolled.
    expect(enqueued).toEqual([{ instrumentId: "crypto-1", kind: "CRYPTO" }]);

    // Asserted against the **emitted** line, not "no exception escaped": a
    // silently swallowed enqueue failure is indistinguishable from a successful
    // one, and the log line is the only thing that tells an operator which
    // instrument never got enrolled.
    const errors = lines().filter((line) => line["level"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!["instrument_id"]).toBe("share-1");
    expect(errors[0]!["error"]).toBe("pg-boss is not reachable");
    expect(String(errors[0]!["msg"])).toContain("triggerCatalogueBackfills");
  });

  it("is a no-op with no market runtime wired, and logs nothing", async () => {
    await expect(
      controllerWith(null).triggerCatalogueBackfills([SHARE, FUND]),
    ).resolves.toBeUndefined();
    expect(lines()).toEqual([]);
  });
});
