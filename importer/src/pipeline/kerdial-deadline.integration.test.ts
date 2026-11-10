import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KERDIAL_CSV_LIMITS, applyDeadlineAt } from "../limits.js";
import { applyImport, type ImportResult } from "./apply.js";
import { planImport, type ImportPlan } from "./plan.js";
import type { Clock } from "./ports.js";
import {
  buildKerdialWriteService,
  cashInRow,
  kerdialPlanContext,
  kerdialTally,
  parseKerdial,
  seedBareTenant,
  type Cells,
  type KerdialIds,
} from "./__tests__/kerdial-harness.js";

/**
 * **EI-31 — `applyDeadlineMs` at two values, and AC-437's resumability**
 * (AC-436/AC-437, FR-537/FR-538/FR-539), against a real Postgres container and **as `app_web`**.
 *
 * ## Why the crossing is a known answer and not a stopwatch
 *
 * AC-437 asks for a deadline "set low enough to be **crossed mid-file**". Over
 * HTTP that is a race: the controller passes `systemClock`, so which row the
 * cut lands on is whatever the host's load makes it, and on a throttling shared
 * runner the same test writes everything on one run and nothing on the next.
 * `api/src/exports-imports/kerdial-limits.integration.test.ts` therefore asserts
 * only the half that *is* deterministic over HTTP (a deadline of `1 ms`, already
 * past when `applyImport` starts, against the shipped 25 000 ms), and the
 * mid-file crossing is asserted here, where `ApplyContext.clock` is an input.
 *
 * `applyImport` reads the clock **exactly once per row** (MEASURED, its own
 * `apply.ts` comment and its loop: one reading before the chunk's transaction
 * is opened, then one per subsequent row of the chunk). So a clock that
 * advances {@link TICK_MS} per reading makes the cut arithmetic:
 * reading *k* answers `startedAt + (k − 1) × TICK_MS`, and row *k* is the first
 * unattempted one when that reaches the deadline. With the numbers below the
 * answer is **exactly 20 written, exactly 20 unattempted**, on a chunk
 * boundary — which is what lets "every already-committed chunk is intact" be a
 * count rather than a range.
 *
 * ## What "two values" means here, named
 *
 *  - **`applyDeadlineMs` lowered to {@link LOWERED_DEADLINE_MS}** — the file
 *    stops mid-way and reports the remainder honestly;
 *  - **`applyDeadlineMs` at the shipped
 *    `KERDIAL_CSV_LIMITS.applyDeadlineMs` (25 000)** — the *same* fixture, the
 *    *same* clock, completes. Both go through `applyDeadlineAt`, the one
 *    function the controller uses, rather than through a hand-built `Date`.
 *
 * `applyChunkRows` is lowered to {@link CHUNK_ROWS} as well, and that is
 * deliberate rather than incidental: at the shipped 50 a 40-row file is a
 * single chunk, so no deadline could land *inside* the file at all and AC-437's
 * own scenario would be unreachable.
 */

/** The fixture's size, and the two halves the deadline cuts it into. */
const ROWS = 40;
const WRITTEN_BEFORE_DEADLINE = 20;

/** Milliseconds the injected clock advances per reading — i.e. per row. */
const TICK_MS = 100;
/** Crossed at reading 21: `(21 − 1) × 100 = 2 000`. */
const LOWERED_DEADLINE_MS = WRITTEN_BEFORE_DEADLINE * TICK_MS;
/** The shipped value, which the same 40 readings (3 900 ms) never reach. */
const SHIPPED_DEADLINE_MS = KERDIAL_CSV_LIMITS.applyDeadlineMs;

/** Eight chunks over 40 rows, so the deadline can land between two of them. */
const CHUNK_ROWS = 5;

const STARTED_AT = new Date("2026-09-24T09:00:00.000Z");

const PORTFOLIO = "Portefeuille reprise";
const ACCOUNT = "Compte espèces";
const SECOND_PORTFOLIO = "Portefeuille secondaire";

/**
 * AC-436's "**across the measured number of runs**", exercised at a value that
 * is cheap: a deadline of {@link MULTI_RUN_DEADLINE_MS} admits ten rows per
 * request, so the 40-row fixture completes in exactly **four** runs.
 *
 * Four rather than two because the claim has a per-run half — "every run
 * reporting its remainder honestly and every already-committed row skipped on
 * the next" — which two runs exercise exactly once. At production values the
 * same shape is EI-23's **measured 37** runs for a 20 000-row file;
 * that number is cited, never re-measured, because measuring
 * it costs 876 676 ms of apply.
 */
const MULTI_RUN_DEADLINE_MS = 1_000;
const ROWS_PER_MULTI_RUN = MULTI_RUN_DEADLINE_MS / TICK_MS;
const EXPECTED_RUNS = ROWS / ROWS_PER_MULTI_RUN;

/** One tenant per case: four cases, four tenants, no shared state to order the `it`s by. */
const PARTIAL: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-0000000e3101",
  userId: "00000000-0000-7000-8000-0000000e3102",
  sessionId: "00000000-0000-7000-8000-0000000e3103",
};
const COMPLETE: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-0000000e3111",
  userId: "00000000-0000-7000-8000-0000000e3112",
  sessionId: "00000000-0000-7000-8000-0000000e3113",
};
const DIRECTORY: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-0000000e3121",
  userId: "00000000-0000-7000-8000-0000000e3122",
  sessionId: "00000000-0000-7000-8000-0000000e3123",
};
const MULTI_RUN: KerdialIds = {
  tenantId: "00000000-0000-7000-8000-0000000e3131",
  userId: "00000000-0000-7000-8000-0000000e3132",
  sessionId: "00000000-0000-7000-8000-0000000e3133",
};

/**
 * A clock that moves {@link TICK_MS} forward **per reading**, so "the deadline
 * was crossed between row 20 and row 21" is arithmetic rather than timing.
 *
 * `sleep` is never called on this path and throws rather than resolving: a
 * silent no-op would hide a future change that started waiting on this clock.
 */
class TickingClock implements Clock {
  #readings = 0;

  constructor(private readonly base: Date) {}

  now(): Date {
    const at = new Date(this.base.getTime() + this.#readings * TICK_MS);
    this.#readings += 1;
    return at;
  }

  sleep(): Promise<void> {
    throw new Error("the apply path does not sleep — this clock is only read");
  }

  get readings(): number {
    return this.#readings;
  }
}

/** `count` deposits into one portfolio and one account, each a distinct amount and therefore a distinct fingerprint. */
function deposits(count: number, portfolio = PORTFOLIO): Cells[] {
  return Array.from({ length: count }, (_unused, index) =>
    cashInRow(
      { portfolio, account: ACCOUNT, date: "2026-01-05", currency: "EUR" },
      `${String(1000 + index)}.00`,
    ),
  );
}

describe("EI-31/AC-437 — the apply deadline at two values, and the file that resumes", () => {
  let pg: MigratedPostgres;
  let appWebSql: postgres.Sql;
  let db: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    // As the real `app_web` role, not the container owner — the
    // fingerprint read that makes a re-run skip is RLS-scoped, and every
    // importer suite that connected as the owner was blind to that for a year.
    appWebSql = postgres(pg.appWebUri, { max: 4 });
    db = createDb(appWebSql);
    for (const ids of [PARTIAL, COMPLETE, DIRECTORY, MULTI_RUN]) await seedBareTenant(pg, ids);
  }, 180_000);

  afterAll(async () => {
    await appWebSql.end({ timeout: 5 });
    await pg.stop();
  }, 60_000);

  async function plan(ids: KerdialIds, rows: readonly Cells[]): Promise<ImportPlan> {
    return planImport(parseKerdial(rows), kerdialPlanContext(db, ids.tenantId, { mode: "APPLY" }));
  }

  async function apply(
    ids: KerdialIds,
    built: ImportPlan,
    deadlineMs: number,
    clock: Clock,
    maxPortfoliosPerTenant?: number,
  ): Promise<ImportResult> {
    const { writes } = buildKerdialWriteService(db, ids.tenantId);
    return applyImport({
      plan: built,
      db,
      writes,
      destination: null,
      tenantId: ids.tenantId,
      updatedBySessionId: ids.sessionId,
      // The shipped derivation, not a hand-built `Date`: the thing under test
      // is the limit, and `applyDeadlineAt` is where the controller turns it
      // into an instant.
      deadlineAt: applyDeadlineAt(STARTED_AT, {
        ...KERDIAL_CSV_LIMITS,
        applyDeadlineMs: deadlineMs,
      }),
      clock,
      chunkRows: CHUNK_ROWS,
      ...(maxPortfoliosPerTenant === undefined ? {} : { maxPortfoliosPerTenant }),
    });
  }

  /** Every amount this tenant holds, with how many rows carry it — the duplicate check AC-428/AC-437 both want. */
  async function amountCounts(ids: KerdialIds): Promise<Map<string, number>> {
    const rows = await pg.ownerClient`
      SELECT cash_amount::text AS amount, count(*)::int AS n
      FROM "transaction" WHERE tenant_id = ${ids.tenantId}::uuid
      GROUP BY cash_amount`;
    // Keyed by the amount's own value rather than by its stored text:
    // `numeric(…, 4)` renders `1000.00` as `1000.0000`, and the point of this
    // map is which rows landed, not how Postgres prints a scale.
    return new Map(rows.map((row) => [String(Number(row["amount"])), row["n"] as number]));
  }

  describe("the lowered value cuts the file mid-way and reports the remainder", () => {
    let result: ImportResult;

    beforeAll(async () => {
      result = await apply(
        PARTIAL,
        await plan(PARTIAL, deposits(ROWS)),
        LOWERED_DEADLINE_MS,
        new TickingClock(STARTED_AT),
      );
    }, 180_000);

    it("writes exactly the rows before the crossing and attempts none after it", () => {
      expect(kerdialTally(result.outcomes)).toEqual({
        IMPORT: WRITTEN_BEFORE_DEADLINE,
        APPLY_NOT_ATTEMPTED: ROWS - WRITTEN_BEFORE_DEADLINE,
      });
      expect(result.applyNotAttempted).toBe(ROWS - WRITTEN_BEFORE_DEADLINE);
    });

    it("leaves every already-committed chunk intact, queried directly", async () => {
      const counts = await amountCounts(PARTIAL);
      expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(WRITTEN_BEFORE_DEADLINE);
      // Not merely "20 rows": the **first** 20 amounts, in file order, each
      // exactly once — a chunk half-written or a chunk rolled back whole would
      // both show here.
      for (let index = 0; index < WRITTEN_BEFORE_DEADLINE; index += 1) {
        expect(counts.get(String(1000 + index))).toBe(1);
      }
      expect(counts.get(String(1000 + WRITTEN_BEFORE_DEADLINE))).toBeUndefined();
    });

    it("AC-437: re-submitting the same file completes it, skipping every row of the first run", async () => {
      const second = await plan(PARTIAL, deposits(ROWS));

      // The skip is decided at **plan** time, by the fingerprint read — which
      // is the mechanism FR-537 names, not the unique-index backstop.
      expect(
        second.outcomes.filter(
          (one) => one.outcome === "SKIP" && one.reason === "ALREADY_IMPORTED",
        ),
      ).toHaveLength(WRITTEN_BEFORE_DEADLINE);

      const result2 = await apply(
        PARTIAL,
        second,
        SHIPPED_DEADLINE_MS,
        new TickingClock(STARTED_AT),
      );

      expect(kerdialTally(result2.outcomes)).toEqual({
        IMPORT: ROWS - WRITTEN_BEFORE_DEADLINE,
        ALREADY_IMPORTED: WRITTEN_BEFORE_DEADLINE,
      });

      // The total after both runs is the fixture's own row count, each row
      // exactly once — never twice, which is what "skipped rather than
      // re-written" means in the table rather than in the response.
      const counts = await amountCounts(PARTIAL);
      expect(counts.size).toBe(ROWS);
      expect([...counts.values()]).toEqual(Array.from({ length: ROWS }, () => 1));
    }, 180_000);
  });

  describe("the shipped value completes the same fixture in one run", () => {
    it("writes every row, with nothing unattempted", async () => {
      const clock = new TickingClock(STARTED_AT);
      const result = await apply(
        COMPLETE,
        await plan(COMPLETE, deposits(ROWS)),
        SHIPPED_DEADLINE_MS,
        clock,
      );

      expect(kerdialTally(result.outcomes)).toEqual({ IMPORT: ROWS });
      expect(result.applyNotAttempted).toBe(0);
      // The discriminator for the pair: the same clock advanced the same
      // 40 readings — 3 900 ms of fixture time — so the only thing that changed
      // between this case and the one above is the limit's value.
      expect(clock.readings).toBe(ROWS);
      expect((clock.readings - 1) * TICK_MS).toBeLessThan(SHIPPED_DEADLINE_MS);
      expect((clock.readings - 1) * TICK_MS).toBeGreaterThan(LOWERED_DEADLINE_MS);

      const counts = await amountCounts(COMPLETE);
      expect(counts.size).toBe(ROWS);
    }, 180_000);
  });

  /**
   * `ApplyContext.maxPortfoliosPerTenant` — optional, **not** passed by the
   * controller (so production gets `createPortfolio`'s own cap), and therefore
   * only provable at two values from here.
   *
   * The rows a failed directory create makes unwritable are reported as *that
   * create's* failure rather than as the foreign-key violation the write would
   * have produced (`blockedByDirectory`), which is the property this pair
   * pins.
   */
  describe("maxPortfoliosPerTenant, injected — the file's own directory is bounded", () => {
    it("blocks the second portfolio's rows at a cap of 1 and writes the first portfolio's", async () => {
      const rows = [...deposits(2), ...deposits(2, SECOND_PORTFOLIO)];
      const result = await apply(
        DIRECTORY,
        await plan(DIRECTORY, rows),
        SHIPPED_DEADLINE_MS,
        new TickingClock(STARTED_AT),
        1,
      );

      expect(result.summary.imported).toBe(2);
      expect(result.applyFailed).toBe(2);

      const portfolios = await pg.ownerClient`
        SELECT name FROM "portfolio" WHERE tenant_id = ${DIRECTORY.tenantId}::uuid`;
      expect(portfolios.map((row) => String(row["name"]))).toEqual([PORTFOLIO]);
    }, 180_000);

    it("…and the same file writes both portfolios at the default cap", async () => {
      // The second half of the pair, and it also shows the first run wrote
      // nothing it should not have: the two rows blocked above import here,
      // into a portfolio the cap previously refused to create.
      const result = await apply(
        DIRECTORY,
        await plan(DIRECTORY, [...deposits(2), ...deposits(2, SECOND_PORTFOLIO)]),
        SHIPPED_DEADLINE_MS,
        new TickingClock(STARTED_AT),
      );

      expect(result.summary.imported).toBe(2);
      expect(result.summary.skipped).toBe(2);

      const portfolios = await pg.ownerClient`
        SELECT name FROM "portfolio" WHERE tenant_id = ${DIRECTORY.tenantId}::uuid ORDER BY name`;
      expect(portfolios.map((row) => String(row["name"]))).toEqual([PORTFOLIO, SECOND_PORTFOLIO]);
    }, 180_000);
  });

  describe("AC-436's positive case: the file completes across several runs", () => {
    it("takes exactly four runs, each reporting its own remainder and skipping the last run's rows", async () => {
      const runs: { imported: number; skipped: number; notAttempted: number }[] = [];

      while (runs.length < 10) {
        const built = await plan(MULTI_RUN, deposits(ROWS));
        const result = await apply(
          MULTI_RUN,
          built,
          MULTI_RUN_DEADLINE_MS,
          new TickingClock(STARTED_AT),
        );
        runs.push({
          imported: result.summary.imported,
          skipped: result.summary.skipped,
          notAttempted: result.applyNotAttempted,
        });
        if (result.applyNotAttempted === 0) break;
      }

      // The whole claim as one value: every run's own three counts, in order.
      // A run that silently re-wrote its predecessor's rows, or one that
      // reported a remainder it had not left, changes a number here.
      expect(runs).toEqual([
        { imported: 10, skipped: 0, notAttempted: 30 },
        { imported: 10, skipped: 10, notAttempted: 20 },
        { imported: 10, skipped: 20, notAttempted: 10 },
        { imported: 10, skipped: 30, notAttempted: 0 },
      ]);
      expect(runs).toHaveLength(EXPECTED_RUNS);

      // And the table holds each row exactly once after all four — the count
      // the response summaries cannot be trusted for.
      const counts = await amountCounts(MULTI_RUN);
      expect(counts.size).toBe(ROWS);
      expect([...counts.values()]).toEqual(Array.from({ length: ROWS }, () => 1));
    }, 300_000);
  });

  it("the two deadline values are different numbers, and the shipped one is the constant", () => {
    // Guards the pair above against the failure mode where both cases run at
    // the same value because a refactor collapsed them.
    expect(SHIPPED_DEADLINE_MS).toBe(25_000);
    expect(LOWERED_DEADLINE_MS).toBe(2_000);
  });
});
