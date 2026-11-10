import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as calcEpoch from "./calc-epoch.js";
import { invalidateCashAccounts, invalidatePortfolioDerivedFigures } from "./invalidate-derived.js";

/**
 * GATE-2: a table test over the invalidation matrix —
 * one row per mutation, asserting the **exact** set of invalidated/removed
 * query-key prefixes, driven by a spied `QueryClient`. This is what turns
 * "an under-invalidation is a stale-financial-figure bug" into a caught
 * regression rather than a review question.
 *
 * Every row below reproduces exactly what its call site does (or, for a
 * mutation not yet wired up in this batch — `POST/PATCH/DELETE
 * /transactions*`, `POST /instruments/:id/prices` — exactly what a future
 * call site is contractually required to do): call
 * `invalidatePortfolioDerivedFigures` with the row's `epochWillAdvance`
 * flag, plus any "Additional" invalidate/remove calls that mutation's own
 * row specifies. `DELETE /portfolios/:id` (via `PortfolioDeleteDialog.tsx`,
 * migrated to the shared helper in this same task) is exercised directly
 * against the helper with no additional calls, since list/overview/holdings/
 * performance are now all the helper's job and the old standalone
 * `["portfolios","list"]` invalidate this dialog used to issue itself is
 * gone. `POST/PATCH /portfolios/:id` (`PortfolioNameForm.tsx`) is **not** a
 * row here — that call site keeps its own pre-existing, unmodified invalidation calls
 * (covered by its own existing test suite, `PortfolioNameForm.test.tsx`).
 *
 * Real `invalidateAndVerifyCalcEpoch` runs in every row (not mocked) — with
 * nothing cached under any prefix in a fresh `QueryClient`, its own "no
 * baseline to compare against" path (`calc-epoch.test.tsx`'s own case)
 * resolves `{ verified: true }` after exactly one `invalidateQueries` call,
 * so it is observable through the same `invalidateQueries` spy as every
 * other call in this file.
 */

const TRANSACTION_ID = "44444444-4444-4444-8444-444444444444";
const INSTRUMENT_ID = "55555555-5555-4555-8555-555555555555";

const OVERVIEW = ["portfolios", "overview"];
const HOLDINGS = ["portfolios", "holdings"];
const PERFORMANCE = ["portfolios", "performance"];
const LIST = ["portfolios", "list"];
/**
 * CA-19: the cash query joins
 * the set a **transaction** write invalidates — a transaction is the only
 * thing that moves a cash balance. A **cash-account** write (rename/archive)
 * moves no figure at all and takes the narrow `invalidateCashAccounts` path
 * instead, which is its own row at the bottom of this file.
 */
const CASH = ["portfolios", "cash"];
/**
 * `dividend-screen` DS-8:
 * a transaction write can add, edit or delete a DIVIDEND row, so
 * `GET /dividends/summary` joins the derived set. It is **never** routed
 * through `invalidateAndVerifyCalcEpoch` — that response carries no
 * `calcEpoch` at all (DV10), so the "verify" half would silently no-op
 * forever, the identical reasoning already recorded for `performance`/`list`.
 * Its own named assertion is at the bottom of the `describe` below.
 */
const DIVIDENDS = ["dividends", "summary"];
/**
 * The performance screen's value-series chart. A transaction write moves
 * the daily value series exactly as it moves the overview total, so this key
 * joins the derived set — and, like `performance`, it is never routed through
 * `invalidateAndVerifyCalcEpoch`, because `GET /portfolios/value-series`
 * carries no `calcEpoch` either.
 */
const VALUE_SERIES = ["portfolios", "value-series"];
/**
 * `closed-positions`: a transaction write can *close* a position — the
 * sale of a last unit moves an instrument off the open list and onto this one
 * — so the « Clôturées » key joins the derived set. Unlike `performance`,
 * `list`, `dividends` and `value-series`, this response **does** carry a
 * `calcEpoch`, so `isCalcEpochBearing` would match it and its exclusion from
 * `invalidateAndVerifyCalcEpoch` is a deliberate choice rather than a
 * structural impossibility (the CA-19 precedent — a lazily-fetched tab is not
 * worth widening every write's critical path for). That is why it gets its own
 * named negative assertion at the bottom of the `describe` below, and not just
 * a slot in the matrix.
 */
const CLOSED_POSITIONS = ["portfolios", "closed-positions"];
const TRANSACTIONS = ["transactions"];
const INSTRUMENT_PRICES = ["instruments", INSTRUMENT_ID, "prices"];

interface Row {
  readonly name: string;
  readonly ac: string;
  readonly run: (queryClient: QueryClient) => Promise<void>;
  readonly expectedInvalidated: readonly unknown[][];
  readonly expectedRemoved: readonly { queryKey: unknown[]; exact: boolean }[];
}

const ROWS: readonly Row[] = [
  {
    name: "POST /transactions (existing)",
    ac: "existing behaviour + the ledger must refresh",
    run: async (queryClient) => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: TRANSACTIONS }),
      ]);
    },
    expectedInvalidated: [
      OVERVIEW,
      HOLDINGS,
      PERFORMANCE,
      LIST,
      CASH,
      DIVIDENDS,
      VALUE_SERIES,
      CLOSED_POSITIONS,
      TRANSACTIONS,
    ],
    expectedRemoved: [],
  },
  {
    name: "PATCH /transactions/:id",
    ac: "AC98",
    run: async (queryClient) => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: TRANSACTIONS }),
      ]);
    },
    expectedInvalidated: [
      OVERVIEW,
      HOLDINGS,
      PERFORMANCE,
      LIST,
      CASH,
      DIVIDENDS,
      VALUE_SERIES,
      CLOSED_POSITIONS,
      TRANSACTIONS,
    ],
    expectedRemoved: [],
  },
  {
    name: "PATCH /transactions/:id/fx-rate",
    ac: "AC100",
    run: async (queryClient) => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: TRANSACTIONS }),
      ]);
    },
    expectedInvalidated: [
      OVERVIEW,
      HOLDINGS,
      PERFORMANCE,
      LIST,
      CASH,
      DIVIDENDS,
      VALUE_SERIES,
      CLOSED_POSITIONS,
      TRANSACTIONS,
    ],
    expectedRemoved: [],
  },
  {
    name: "DELETE /transactions/:id",
    ac: "AC101 — removeQueries so a stale detail panel cannot be re-read from cache",
    run: async (queryClient) => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: TRANSACTIONS }),
        queryClient.removeQueries({ queryKey: ["transactions", TRANSACTION_ID], exact: true }),
      ]);
    },
    expectedInvalidated: [
      OVERVIEW,
      HOLDINGS,
      PERFORMANCE,
      LIST,
      CASH,
      DIVIDENDS,
      VALUE_SERIES,
      CLOSED_POSITIONS,
      TRANSACTIONS,
    ],
    expectedRemoved: [{ queryKey: ["transactions", TRANSACTION_ID], exact: true }],
  },
  {
    name: "POST /instruments/:id/prices",
    ac: "AC103/AC105/AC106 — epochWillAdvance: false, verified from source",
    run: async (queryClient) => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false }),
        queryClient.invalidateQueries({ queryKey: INSTRUMENT_PRICES }),
      ]);
    },
    expectedInvalidated: [
      OVERVIEW,
      HOLDINGS,
      PERFORMANCE,
      LIST,
      CASH,
      DIVIDENDS,
      VALUE_SERIES,
      CLOSED_POSITIONS,
      INSTRUMENT_PRICES,
    ],
    expectedRemoved: [],
  },
  {
    name: "DELETE /portfolios/:id (PortfolioDeleteDialog, migrated to the shared helper)",
    ac: "AC93, traces to root AC57–AC59",
    run: async (queryClient) => {
      await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true });
    },
    expectedInvalidated: [
      OVERVIEW,
      HOLDINGS,
      PERFORMANCE,
      LIST,
      CASH,
      DIVIDENDS,
      VALUE_SERIES,
      CLOSED_POSITIONS,
    ],
    expectedRemoved: [],
  },
];

describe.each(ROWS)("invalidation matrix — $name ($ac)", (row) => {
  it("invalidates exactly the expected prefix set, and removes exactly the expected exact keys", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const removeSpy = vi.spyOn(queryClient, "removeQueries");

    await row.run(queryClient);

    const invalidated = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    for (const expectedKey of row.expectedInvalidated) {
      expect(invalidated).toContainEqual(expectedKey);
    }
    expect(invalidated).toHaveLength(row.expectedInvalidated.length);

    const removed = removeSpy.mock.calls.map((call) => ({
      queryKey: call[0]?.queryKey ?? [],
      exact: call[0]?.exact ?? false,
    }));
    expect(removed).toEqual(row.expectedRemoved);
  });
});

/**
 * A dedicated point: `["portfolios","performance", …]` carries no
 * `calcEpoch` on the wire, so it must never be routed through
 * `invalidateAndVerifyCalcEpoch`/`isCalcEpochBearing` — only `overview` and
 * `holdings` ever are, in every row, regardless of `epochWillAdvance`. A
 * dedicated assertion, not an omission (UR-3's own acceptance
 * criterion): passing `performance` through the epoch-verification helper
 * would either silently no-op (nothing to verify) or worse, count toward and
 * exhaust its 3-attempt retry budget on data it can never observe advancing.
 */
describe("performance/list are never routed through calc-epoch verification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("epochWillAdvance: true — only overview/holdings prefixes are ever passed to invalidateAndVerifyCalcEpoch", async () => {
    const verifySpy = vi.spyOn(calcEpoch, "invalidateAndVerifyCalcEpoch");
    const queryClient = new QueryClient();

    await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true });

    const verifiedPrefixes = verifySpy.mock.calls.map((call) => call[1]);
    expect(verifiedPrefixes).toEqual(expect.arrayContaining([OVERVIEW, HOLDINGS]));
    expect(verifiedPrefixes).toHaveLength(2);
    expect(verifiedPrefixes).not.toContainEqual(PERFORMANCE);
    expect(verifiedPrefixes).not.toContainEqual(LIST);
    // DS-8: and never the dividends key either — its response carries no
    // `calcEpoch` (DV10), so `isCalcEpochBearing` could not match it and the
    // verification would be permanently unverifiable rather than merely
    // absent. The length assertion above already forbids a third entry; this
    // names *which* third entry must not appear, so a failure says why.
    expect(verifiedPrefixes).not.toContainEqual(DIVIDENDS);
    // `closed-positions`, and this one is the sharper case: unlike every
    // other name on this list, `GET /portfolios/closed-positions` *does*
    // return a `calcEpoch`, so `isCalcEpochBearing` would match it and the
    // helper would genuinely verify something. Its absence is therefore a
    // decision (CA-19: don't block a write's critical path on a tab that is
    // usually unmounted), which is exactly the kind of thing that gets
    // "helpfully" undone later without an assertion saying so.
    expect(verifiedPrefixes).not.toContainEqual(CLOSED_POSITIONS);
  });

  it("epochWillAdvance: both branches — the closed-positions prefix is still plainly invalidated", async () => {
    // The negative above would also pass if the key were simply forgotten;
    // this is its positive companion, on both branches.
    for (const epochWillAdvance of [true, false]) {
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance });

      expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(
        CLOSED_POSITIONS,
      );
    }
  });

  it("epochWillAdvance: true — the dividends prefix is still plainly invalidated, in the same call (DS-8)", async () => {
    // The negative above would also pass if the key were simply forgotten;
    // this is its positive companion, on the branch the negative covers.
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true });

    expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(DIVIDENDS);
  });

  it("epochWillAdvance: false — invalidateAndVerifyCalcEpoch is never called at all", async () => {
    const verifySpy = vi.spyOn(calcEpoch, "invalidateAndVerifyCalcEpoch");
    const queryClient = new QueryClient();

    await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false });

    // `upsertManualPricePoint` never bumps `calc_epoch`, so there
    // is nothing to verify — every one of the seven prefixes gets a plain
    // `invalidateQueries` instead.
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("epochWillAdvance: false — the dividends prefix is invalidated on this branch too (DS-8, both branches)", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false });

    expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(DIVIDENDS);
  });

  it("the value-series prefix is invalidated on both branches — a chart must not keep a pre-write shape under a post-write total", async () => {
    for (const epochWillAdvance of [true, false]) {
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      await invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance });

      expect(invalidateSpy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(
        VALUE_SERIES,
      );
    }
  });
});

/**
 * Sharpened by UR-35's independent-tester pass:
 * `epochWillAdvance: false`'s aggregate result is `{ status: "not-applicable"
 * }`, a state a caller cannot mistake for a confirmed verification — no
 * boolean collapse between "verified" and "never attempted". The manual-price
 * call site (`queries.ts`'s `postManualPricePointMutationOptions`) renders no
 * freshness claim at all off this result.
 */
describe("epochWillAdvance: false — not-applicable, no freshness claim implied", () => {
  it("resolves { status: 'not-applicable' } with nothing to verify", async () => {
    const queryClient = new QueryClient();
    await expect(
      invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false }),
    ).resolves.toEqual({ status: "not-applicable" });
  });
});

/**
 * Companion case for the `epochWillAdvance: true` path — a fresh
 * `QueryClient` has no baseline to compare against, so
 * `invalidateAndVerifyCalcEpoch` resolves `{ verified: true }` for both
 * `overview`/`holdings` after exactly one `invalidateQueries` call, and the
 * aggregate collapses to `{ status: "verified" }`.
 */
describe("epochWillAdvance: true — verified, aggregated from both calc-epoch checks", () => {
  it("resolves { status: 'verified' } when both overview and holdings verify", async () => {
    const queryClient = new QueryClient();
    await expect(
      invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
    ).resolves.toEqual({ status: "verified" });
  });
});

/**
 * CA-19: the **cash-account
 * write** path — rename and archive/un-archive. This is the narrow half of
 * the matrix, and it is asserted by spying on the query client's own
 * invalidation calls rather than by re-fetch timing.
 *
 * The negative half is the load-bearing one: a label change bumps no
 * `calc_epoch` server-side, so routing it through the full derived set would
 * refetch overview/holdings/performance for a write that provably moved none
 * of them, **and** exhaust `invalidateAndVerifyCalcEpoch`'s retry budget on
 * an epoch nothing is going to advance — the recorded
 * `upsertManualPricePoint` failure, exactly.
 */
describe("cash-account writes invalidate only the cash query", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";

  it("invalidates exactly ['portfolios','cash',<id>] — not the derived set, and not the bare prefix", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await invalidateCashAccounts(queryClient, PORTFOLIO_ID);

    const invalidated = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    // Positive: the one key it must touch.
    expect(invalidated).toEqual([[...CASH, PORTFOLIO_ID]]);
    // Negative companions, each named rather than implied by the length above.
    expect(invalidated).not.toContainEqual(OVERVIEW);
    expect(invalidated).not.toContainEqual(HOLDINGS);
    expect(invalidated).not.toContainEqual(PERFORMANCE);
    expect(invalidated).not.toContainEqual(LIST);
    expect(invalidated).not.toContainEqual(DIVIDENDS);
  });

  it("never routes a cash-account write through calc-epoch verification", async () => {
    const verifySpy = vi.spyOn(calcEpoch, "invalidateAndVerifyCalcEpoch");
    const queryClient = new QueryClient();

    await invalidateCashAccounts(queryClient, PORTFOLIO_ID);

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("scopes to one portfolio: a sibling portfolio's cash query is not matched by the key it invalidates", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await invalidateCashAccounts(queryClient, PORTFOLIO_ID);

    const invalidated = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidated).not.toContainEqual([...CASH, other]);
  });
});
