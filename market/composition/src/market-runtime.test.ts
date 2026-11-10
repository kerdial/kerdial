import { Writable } from "node:stream";
import { YAHOO_PROVIDER_KEY } from "@kerdial/market-adapters";
import type { QuoteProvider } from "@kerdial/market-ports";
import { createPostgresClient, type Db } from "@kerdial/platform-db";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { describe, expect, it, vi } from "vitest";
import { createMarketRuntime } from "./market-runtime.js";
import { fakeQuoteProvider } from "@kerdial/market-test-support";

/**
 * SH-38 — points the process logger at a stream this test holds, so the two
 * F-7 assertions below read the bytes that were actually emitted. pino writes
 * to fd 1 through `sonic-boom`, which a `process.stdout.write` spy never sees,
 * so this seam is what makes emitted-output assertions possible at all.
 */
function captureLogs(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  const restore = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
  return {
    restore,
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

// F-2 (security review) — `createPostgresClient` is wrapped, not replaced
// (`vi.fn(actual.createPostgresClient)` delegates to the real
// implementation), so every other test in this file still gets a genuine
// `postgres.Sql` client (which never eagerly connects — `postgres.js`
// connects lazily on first query, confirmed by this file's own pre-existing
// tests already constructing one against a never-connected URL) while this
// file can also assert on the exact arguments `market-runtime.ts` actually
// passed, real behaviour rather than a re-assertion of a literal.
vi.mock("@kerdial/platform-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kerdial/platform-db")>();
  return { ...actual, createPostgresClient: vi.fn(actual.createPostgresClient) };
});

function fakeProvider(): QuoteProvider {
  return fakeQuoteProvider({
    capabilities: { key: YAHOO_PROVIDER_KEY },
    resolve: async () => [
      {
        providerSymbol: "ACME",
        displayName: "Acme Corp",
        currency: "EUR",
        matchQuality: "PROBABLE",
      },
    ],
  });
}

describe("createMarketRuntime (IC-6) — INGESTION_DATABASE_URL gate", () => {
  it("with no ingestion database url configured, scheduler is null, enqueueBackfill is a documented no-op, and discovery still works", async () => {
    // An explicit blank string (not merely "omitted") so this assertion
    // holds regardless of any ambient INGESTION_DATABASE_URL in the actual
    // process environment (this package's own `resolveIngestionDatabaseUrl`
    // treats a blank string exactly like "unset").
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: "",
      providerOverrides: { [YAHOO_PROVIDER_KEY]: fakeProvider() },
    });

    expect(runtime.scheduler).toBeNull();

    const results = await runtime.discovery.search({ kind: "SHARE", query: "acme" });
    expect(results).toHaveLength(1);
    expect(results[0]!.providerSymbol).toBe("ACME");

    // `db` is never touched by the no-op branch — a value that would throw
    // if it were ever actually used proves that.
    const neverTouchedDb = new Proxy(
      {},
      {
        get(): never {
          throw new Error("enqueueBackfill must not touch `db` when scheduler is null");
        },
      },
    ) as unknown as Db;

    await expect(
      runtime.enqueueBackfill(neverTouchedDb, {
        instrumentId: "11111111-1111-7111-8111-111111111111",
        kind: "SHARE",
      }),
    ).resolves.toBeUndefined();

    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("ICB-7: requestBackfillReload THROWS when scheduler is null — never enqueueBackfill's log-and-continue, never a fake success", async () => {
    const runtime = createMarketRuntime({
      ingestionDatabaseUrl: "",
      providerOverrides: { [YAHOO_PROVIDER_KEY]: fakeProvider() },
    });
    expect(runtime.scheduler).toBeNull();
    // Always provided by `createMarketRuntime`, even in this degraded state —
    // optional on the interface only so a pre-existing hand-written fake still
    // satisfies the type (see `MarketRuntime.requestBackfillReload`).
    expect(typeof runtime.requestBackfillReload).toBe("function");

    // Same "a db that throws if touched" proof as the no-op branch above: the
    // throw happens before any statement is attempted.
    const neverTouchedDb = new Proxy(
      {},
      {
        get(): never {
          throw new Error("requestBackfillReload must not touch `db` when scheduler is null");
        },
      },
    ) as unknown as Db;

    // FR-184: the controller (`api`'s `instrument-history-reload.controller.ts`)
    // checks `marketRuntime === null` / `scheduler === null` /
    // `requestBackfillReload === undefined` first and returns
    // `503 MARKET_DATA_NOT_CONFIGURED`, so this path is unreachable in
    // production. It throws — rather than silently succeeding — so a future
    // caller that forgets the check fails loudly.
    await expect(
      runtime.requestBackfillReload!(neverTouchedDb, {
        instrumentId: "11111111-1111-7111-8111-111111111112",
        kind: "SHARE",
      }),
    ).rejects.toThrow(/INGESTION_DATABASE_URL is not configured/);
  });

  it("F-7 RED-CONFIRM (security review): warns once, at construction time, when INGESTION_DATABASE_URL is not configured — not merely per-creation", () => {
    // SH-38 (FR-32): this warning is one of
    // the two named sites that migrated from `console.*` to pino, so the
    // assertion reads the **emitted** line rather than a console spy.
    const { lines, restore } = captureLogs();
    try {
      createMarketRuntime({ ingestionDatabaseUrl: "" });
      const emitted = lines();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.["level"]).toBe("warn");
      expect(String(emitted[0]?.["msg"])).toContain("INGESTION_DATABASE_URL");
      expect(String(emitted[0]?.["msg"])).toContain("disabled");
    } finally {
      restore();
    }
  });

  it("never warns when INGESTION_DATABASE_URL (via the override) is configured", () => {
    const { lines, restore } = captureLogs();
    try {
      createMarketRuntime({ ingestionDatabaseUrl: "postgres://localhost:5432/never-connected" });
      expect(lines()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("F-2 RED-CONFIRM (security review): the ingest pool is created with an explicit small max (2), not DB_POOL_MAX's own default", () => {
    const mockedCreatePostgresClient = vi.mocked(createPostgresClient);
    mockedCreatePostgresClient.mockClear();

    createMarketRuntime({
      ingestionDatabaseUrl: "postgres://localhost:5432/never-connected",
    });

    expect(mockedCreatePostgresClient).toHaveBeenCalledTimes(1);
    expect(mockedCreatePostgresClient).toHaveBeenCalledWith(
      "postgres://localhost:5432/never-connected",
      { max: 2 },
    );

    // The real (never-connected — postgres.js connects lazily) client this
    // produced actually carries that `max`, confirming the option reached
    // the real client, not merely that this call site passed it.
    const ingestSql = mockedCreatePostgresClient.mock.results[0]?.value as {
      options: { max: number };
    };
    expect(ingestSql.options.max).toBe(2);
  });
});
