import { describe, expect, it, vi } from "vitest";
import type { Db } from "@kerdial/platform-db";

/**
 * M2 (security review, T-39) — `materializePortfolioValuations`'s
 * `inFlightByKey` de-duplication map (`./materialize.ts`), proven at the unit
 * level: `withTenant` (`@kerdial/platform-db`) is replaced with a plain
 * `vi.fn()` that never invokes its own callback, returning a promise this
 * test resolves by hand instead. This removes every real-DB-timing question
 * (a Testcontainers-level version of this proof — an earlier draft — turned
 * out to be unreliable, since real query round-trip latency meant a "second"
 * call could reach its own missing-dates check either before or after the
 * first call had already committed, sometimes passing for the wrong reason
 * regardless of whether the de-dupe fix was present). Here, `withTenant`'s
 * call count is the exact, deterministic signal for "did
 * `materializePortfolioValuationsInner` actually run its read/compute/write
 * pipeline" — no timing assumption needed.
 *
 * Security review finding N3 — `materializePortfolioValuations` now
 * makes **two** `withTenant` calls per outer call: a cheap `calc_epoch`
 * pre-read (`readCalcEpoch`, folded into the dedupe key itself) before
 * joining/creating an `inFlightByKey` entry, then (unless another in-flight
 * call with the same key was found) the real attempt. Every test below
 * queues a `withTenantMock` resolution for that pre-read first — every
 * existing call-count assertion is one higher than it was before N3 to
 * account for it.
 *
 * ADR-0008 split — `attemptMaterialize` itself now makes **two** `withTenant`
 * calls per attempt instead of one: a short read-only transaction
 * (`attemptMaterializeRead`, "phase A") followed by a separate short
 * write transaction (`attemptMaterializeWrite`, "phase C"), with the
 * CPU-heavy `computeNewRows` running in between, outside any transaction —
 * this is the fix for a held transaction during unbounded per-date
 * PMP/valuation replay. Since `withTenant` is fully mocked here, its
 * configured return value is what each phase's caller receives directly
 * (the real `attemptMaterializeRead`/`attemptMaterializeWrite` bodies never
 * run) — phase A's mocked value must satisfy `computeNewRows`'s reads
 * (`missingEngineDates`/`timeline`/`cashDailyNets`/`prices`/`fxRates`), and phase C's must be
 * the final `{ rows, stale }` shape `attemptMaterialize` returns verbatim.
 * Every existing call-count assertion is one higher again per non-coalesced
 * attempt to account for this second call.
 */
vi.mock("@kerdial/platform-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kerdial/platform-db")>();
  return { ...actual, withTenant: vi.fn() };
});

const { withTenant } = await import("@kerdial/platform-db");
const { materializePortfolioValuations } = await import("./materialize.js");

/**
 * The `{ calcEpoch, marketEpoch }` pair `readDedupeEpochs` (`./materialize.ts`)
 * resolves per call — B1 (`self-hosted-deploy`) added the
 * second axis; both are folded into the dedupe key. A test that wants two
 * calls to be *eligible* to coalesce queues this same pair for both.
 */
const EPOCHS_1_0 = { calcEpoch: 1n, marketEpoch: 0n };

/**
 * A minimal `attemptMaterializeRead` ("phase A") result with
 * nothing missing: `computeNewRows` reads only `missingEngineDates` and
 * `cashDailyNets` (`timeline`/`prices`/`fxRates` are never touched when the
 * former is empty), so this is sufficient for every test below, none of
 * which cares about actual computed values — only about `withTenant`'s call
 * count and about which phase-C-mocked `rows` end up on which caller.
 */
const EMPTY_READ_PHASE = {
  epochAtStart: 1n,
  marketEpochAtStart: 0n,
  prefixRows: [],
  existing: [],
  missingEngineDates: [],
  timeline: [],
  cashDailyNets: [],
  prices: [],
  fxRates: [],
};

/**
 * For tests that only assert on `withTenant`'s call *count*
 * (never on returned row content), one value that structurally satisfies
 * both consumers `attemptMaterialize` calls `withTenant` for: phase A
 * (`missingEngineDates: []` short-circuits `computeNewRows` to a no-op) and
 * phase C (`rows`/`stale`, returned verbatim). Using the same value for both
 * phases of every attempt sidesteps needing to know the exact interleaving
 * order of two concurrent outer calls' phase-A/phase-C `withTenant` calls.
 */
const GENERIC_ATTEMPT_RESULT = { ...EMPTY_READ_PHASE, rows: [], stale: false };

/** Drains the microtask queue completely — see `concurrency.test.ts`'s own identical helper's doc comment for why a macrotask boundary, not a fixed tick count. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("materializePortfolioValuations — M2 in-flight de-duplication (unit, no DB)", () => {
  it("a second identical call issued while the first is still in flight awaits the first's result, without calling withTenant again", async () => {
    const fakeDb = {} as Db;
    const params = {
      tenantId: "00000000-0000-7000-8000-00000000d001",
      portfolioId: "00000000-0000-7000-8000-00000000d002",
      fromDate: "2024-01-01",
      toDate: "2024-01-02",
    };

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();

    // Both calls' epoch pre-reads observe the same (calc, market) epoch pair,
    // so they compute the same dedupe key and are eligible to join.
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);

    let resolvePhaseA!: (value: unknown) => void;
    withTenantMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePhaseA = resolve;
        }),
    );

    const firstCall = materializePortfolioValuations(fakeDb, params);
    const secondCall = materializePortfolioValuations(fakeDb, params);

    // Let both epoch pre-reads resolve and the first call join the in-flight
    // map before its own attempt's phase-A `withTenant` call.
    await flushMicrotasks();
    // Both calls are in flight, the underlying attempt's phase A has not
    // resolved yet — the red-confirm target: before the M2 fix, the second
    // call starts its own independent attempt (two more `withTenant` calls);
    // after the fix, it finds the first call's promise already in the map
    // and never calls `withTenant` for its own attempt at all (2 epoch
    // pre-reads + 1 phase-A call = 3, not 4 or 5).
    expect(withTenantMock).toHaveBeenCalledTimes(3);

    const rows = [
      {
        tenantId: params.tenantId,
        portfolioId: params.portfolioId,
        valuationDate: params.fromDate,
        totalValueBase: 0,
        materializedAt: new Date(),
      },
    ];
    // Phase C's write transaction, queued before phase A resolves so it's
    // ready the instant `computeNewRows` (synchronous, no missing dates)
    // hands control back to `attemptMaterialize`.
    withTenantMock.mockResolvedValueOnce({ rows, stale: false });
    resolvePhaseA(EMPTY_READ_PHASE);

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first).toBe(second);
    expect(first).toEqual(rows);
    // 2 epoch pre-reads + phase A + phase C = 4 — never a 5th/6th call for
    // secondCall's own attempt, which is the actual thing this test proves.
    expect(withTenantMock).toHaveBeenCalledTimes(4);
  });

  it("a call issued after the first has already settled is a fresh call, not stuck de-duplicated forever", async () => {
    const fakeDb = {} as Db;
    const params = {
      tenantId: "00000000-0000-7000-8000-00000000d003",
      portfolioId: "00000000-0000-7000-8000-00000000d004",
      fromDate: "2024-02-01",
      toDate: "2024-02-02",
    };

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0); // epoch pre-read
    withTenantMock.mockResolvedValueOnce(EMPTY_READ_PHASE); // phase A
    withTenantMock.mockResolvedValueOnce({ rows: [], stale: false }); // phase C

    await materializePortfolioValuations(fakeDb, params);
    expect(withTenantMock).toHaveBeenCalledTimes(3);

    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0); // epoch pre-read
    withTenantMock.mockResolvedValueOnce(EMPTY_READ_PHASE); // phase A
    withTenantMock.mockResolvedValueOnce({ rows: [], stale: false }); // phase C
    await materializePortfolioValuations(fakeDb, params);
    // The in-flight entry was removed once the first call settled — this is
    // a second, independent call, not a stuck de-duplication entry that
    // would otherwise serve a stale/cached result forever.
    expect(withTenantMock).toHaveBeenCalledTimes(6);
  });

  it("two calls for different portfolios are never de-duplicated against each other", async () => {
    const fakeDb = {} as Db;
    const tenantId = "00000000-0000-7000-8000-00000000d005";
    const fromDate = "2024-03-01";
    const toDate = "2024-03-02";

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();
    // The two epoch pre-reads first (both calls take theirs before either
    // attempt starts), then every phase-A/phase-C call of both attempts.
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);
    withTenantMock.mockResolvedValue(GENERIC_ATTEMPT_RESULT);

    await Promise.all([
      materializePortfolioValuations(fakeDb, {
        tenantId,
        portfolioId: "00000000-0000-7000-8000-00000000d006",
        fromDate,
        toDate,
      }),
      materializePortfolioValuations(fakeDb, {
        tenantId,
        portfolioId: "00000000-0000-7000-8000-00000000d007",
        fromDate,
        toDate,
      }),
    ]);

    // 2 outer calls x (1 epoch pre-read + phase A + phase C) = 6.
    expect(withTenantMock).toHaveBeenCalledTimes(6);
  });

  it("two calls for the same (tenantId, portfolioId, fromDate, toDate) but different tenants are never de-duplicated against each other (cross-tenant key isolation)", async () => {
    const fakeDb = {} as Db;
    const portfolioId = "00000000-0000-7000-8000-00000000d100";
    const fromDate = "2024-09-01";
    const toDate = "2024-09-02";

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();
    // The two epoch pre-reads first (both calls take theirs before either
    // attempt starts), then every phase-A/phase-C call of both attempts.
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);
    withTenantMock.mockResolvedValue(GENERIC_ATTEMPT_RESULT);

    await Promise.all([
      materializePortfolioValuations(fakeDb, {
        tenantId: "00000000-0000-7000-8000-00000000d101",
        portfolioId,
        fromDate,
        toDate,
      }),
      materializePortfolioValuations(fakeDb, {
        tenantId: "00000000-0000-7000-8000-00000000d102",
        portfolioId,
        fromDate,
        toDate,
      }),
    ]);

    // Never coalesced merely because `portfolioId`/`fromDate`/`toDate` match
    // — `tenantId` is part of the key too. 2 outer calls x (1 epoch pre-read
    // + phase A + phase C) = 6, exactly as the different-portfolio case above.
    expect(withTenantMock).toHaveBeenCalledTimes(6);
  });

  it("a rejected materialization removes its in-flight entry — the next call for the same key is fresh, not stuck rejecting forever", async () => {
    const fakeDb = {} as Db;
    const params = {
      tenantId: "00000000-0000-7000-8000-00000000d200",
      portfolioId: "00000000-0000-7000-8000-00000000d201",
      fromDate: "2024-10-01",
      toDate: "2024-10-02",
    };

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0); // epoch pre-read
    withTenantMock.mockRejectedValueOnce(new Error("boom")); // phase A rejects

    await expect(materializePortfolioValuations(fakeDb, params)).rejects.toThrow("boom");
    // A phase-A rejection short-circuits before phase C is ever reached —
    // same total as before the read/write split (epoch pre-read + one failing call).
    expect(withTenantMock).toHaveBeenCalledTimes(2);

    // Same key (same tenant/portfolio/range/epoch) as the rejected call
    // above — if the in-flight entry had not been removed on rejection, this
    // would either hang forever awaiting a promise that already rejected
    // with nothing new started, or immediately re-throw the *same* stale
    // rejection without ever calling `withTenant` again. Neither happens:
    // this is a fresh, independent call.
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0); // epoch pre-read
    withTenantMock.mockResolvedValueOnce(EMPTY_READ_PHASE); // phase A succeeds this time
    withTenantMock.mockResolvedValueOnce({ rows: [], stale: false }); // phase C
    await expect(materializePortfolioValuations(fakeDb, params)).resolves.toEqual([]);
    expect(withTenantMock).toHaveBeenCalledTimes(5);
  });

  it("N3 (security review): a call whose calc_epoch pre-read observes a different epoch than an in-flight call's is never de-duplicated against it, even for the same (tenantId, portfolioId, fromDate, toDate)", async () => {
    const fakeDb = {} as Db;
    const params = {
      tenantId: "00000000-0000-7000-8000-00000000d300",
      portfolioId: "00000000-0000-7000-8000-00000000d301",
      fromDate: "2024-11-01",
      toDate: "2024-11-02",
    };

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();

    let resolveFirstPhaseA!: (value: unknown) => void;
    // firstCall observes calc_epoch 1n, and its attempt's phase A is held
    // pending — i.e. it has not yet read anything past its epoch baseline.
    withTenantMock.mockResolvedValueOnce(EPOCHS_1_0);
    withTenantMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstPhaseA = resolve;
        }),
    );
    const firstCall = materializePortfolioValuations(fakeDb, params);
    await flushMicrotasks();
    expect(withTenantMock).toHaveBeenCalledTimes(2);

    // ...secondCall observes calc_epoch 2n (as if a write committed between
    // the two calls) for the *identical* (tenantId, portfolioId, fromDate,
    // toDate) — red-confirm target: before N3, this would join firstCall's
    // still-in-flight (pre-write) promise instead of starting its own fresh
    // attempt, serving pre-write rows to a request entitled to see the
    // write. Its own attempt (phase A then phase C) runs to completion
    // immediately, since neither of its mocked values is held pending.
    withTenantMock.mockResolvedValueOnce({ calcEpoch: 2n, marketEpoch: 0n });
    withTenantMock.mockResolvedValueOnce(EMPTY_READ_PHASE); // secondCall's phase A
    withTenantMock.mockResolvedValueOnce({
      rows: [
        {
          tenantId: params.tenantId,
          portfolioId: params.portfolioId,
          valuationDate: params.fromDate,
          totalValueBase: 999,
          materializedAt: new Date(),
        },
      ],
      stale: false,
    }); // secondCall's phase C
    const secondCall = materializePortfolioValuations(fakeDb, params);
    await flushMicrotasks();
    // A distinct attempt was started for secondCall — not merely the two
    // epoch pre-reads (2) but its own phase A and phase C (2 more, total 5).
    expect(withTenantMock).toHaveBeenCalledTimes(5);

    // Queued before resolving, so it's ready the instant firstCall's phase A
    // resolves and `computeNewRows`/`attemptMaterialize` reach phase C.
    withTenantMock.mockResolvedValueOnce({ rows: [], stale: false }); // firstCall's phase C
    resolveFirstPhaseA(EMPTY_READ_PHASE);

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first).toEqual([]);
    expect(second).not.toBe(first);
    expect(second[0]!.totalValueBase).toBe(999);
  });

  it("B1 (SH-3): a call whose market_epoch pre-read observes a market-data write that landed after an in-flight call started is never coalesced onto that call's pre-write snapshot", async () => {
    const fakeDb = {} as Db;
    const params = {
      tenantId: "00000000-0000-7000-8000-00000000d400",
      portfolioId: "00000000-0000-7000-8000-00000000d401",
      fromDate: "2024-12-02",
      toDate: "2024-12-03",
    };

    const withTenantMock = vi.mocked(withTenant);
    withTenantMock.mockClear();

    let resolveFirstPhaseA!: (value: unknown) => void;
    // firstCall's pre-read observes market_epoch 7n and its attempt's phase
    // A is still in flight — i.e. it has not yet taken its price snapshot.
    withTenantMock.mockResolvedValueOnce({ calcEpoch: 1n, marketEpoch: 7n });
    withTenantMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstPhaseA = resolve;
        }),
    );
    const firstCall = materializePortfolioValuations(fakeDb, params);
    await flushMicrotasks();
    expect(withTenantMock).toHaveBeenCalledTimes(2);

    // ...then an EOD-close/FX-daily/gap-repair run commits and bumps the
    // epoch to 8n, and secondCall's pre-read observes it. `calc_epoch` is
    // deliberately *unchanged* (1n): a market-data write never touches it, so
    // the N3 axis alone cannot tell these two calls apart — this is the
    // red-confirm target for folding `market_epoch` into the key. Without it,
    // secondCall joins firstCall's pre-write promise and is served figures
    // priced from data the caller is entitled to see superseded.
    withTenantMock.mockResolvedValueOnce({ calcEpoch: 1n, marketEpoch: 8n });
    withTenantMock.mockResolvedValueOnce(EMPTY_READ_PHASE); // secondCall's phase A
    withTenantMock.mockResolvedValueOnce({
      rows: [
        {
          tenantId: params.tenantId,
          portfolioId: params.portfolioId,
          valuationDate: params.fromDate,
          totalValueBase: 1234,
          materializedAt: new Date(),
          marketEpoch: 8n,
        },
      ],
      stale: false,
    }); // secondCall's phase C
    const secondCall = materializePortfolioValuations(fakeDb, params);
    await flushMicrotasks();
    expect(withTenantMock).toHaveBeenCalledTimes(5);

    withTenantMock.mockResolvedValueOnce({ rows: [], stale: false }); // firstCall's phase C
    resolveFirstPhaseA(EMPTY_READ_PHASE);
    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first).toEqual([]);
    expect(second).not.toBe(first);
    expect(second[0]!.totalValueBase).toBe(1234);
  });
});
