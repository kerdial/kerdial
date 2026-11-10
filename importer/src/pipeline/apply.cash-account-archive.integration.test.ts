import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decimal } from "@kerdial/core-decimal";
import {
  setCashAccountArchived,
  type RecordCashMovementParams,
  type TransactionRecord,
  type TransactionWriteService,
  type WriteBatch,
} from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyDeadlineAt,
  applyImport,
  DEFAULT_IMPORT_LIMITS,
  planImport,
  systemClock,
  type NeutralCashMovementRow,
  type ParsedRow,
  type ParseResult,
} from "../index.js";
import {
  buildWriteService,
  planContext,
  seedPortfolio,
  seedTenant,
  tally,
  type HarnessIds,
} from "./__tests__/apply-harness.js";

/**
 * CI-15 — F-D: a cash-account archive committing **between the
 * dry-run and the confirm**.
 *
 * The archive itself is not new and is detected correctly today:
 * `TransactionWriteService`'s `#assertCashAccountsUsable` throws
 * `CashAccountArchivedError` from inside the write, behind the same
 * portfolio-row lock, so the archive either commits before the check or waits
 * behind the whole write. What this feature adds is the *window*: the dry-run
 * promises "68 rows will import" and the confirm arrives seconds or minutes
 * later.
 *
 * Two things follow, and this suite checks both:
 *
 *  1. Because rows commit one at a time (FR-53), the summary must report the
 *     rows that landed **before** the archive and the ones that rejected after
 *     it — never present the whole request as failed and discard the rows that
 *     are already on disk.
 *
 *     **The chunked apply made "one at a time" a setting, and this suite now states both
 *     values of it.** `applyImport` writes a chunk of rows per transaction
 *     (`applyChunkRows`), and the consequence of the chunking is known:
 *     partial-success granularity moves from
 *     the row to the chunk. The first two cases below therefore run at
 *     `chunkRows: 1` — that *is* FR-53's row granularity, exercised exactly as
 *     it was before the chunked apply rather than described in prose — and a third case
 *     runs at the shipped size to pin what the chunk granularity actually is.
 *     It is not "five rows land and fifteen are refused, rounded to a chunk":
 *     the archive takes the same portfolio row `FOR UPDATE` the open chunk is
 *     already holding, so it cannot commit inside a chunk at all. It waits,
 *     the chunk imports whole, and the archive applies after it — which is why
 *     the third case is a statement about the *lock*, not about a count.
 *  2. The eventual controller (CI-16/CI-18) must reuse
 *     `TransactionsController`'s existing `#mapWriteError` rather than write a
 *     second mapper, so `CashAccountArchivedError` answers `409
 *     CASH_ACCOUNT_ARCHIVED` consistently. That obligation is stated in
 *     `apply.ts` itself — the last test below asserts the comment is there,
 *     because a requirement recorded only outside the code is a requirement
 *     the next author does not read.
 *
 * This suite drives `applyImport` directly. The routes are CI-16's job.
 */

const IDS: HarnessIds = {
  tenantId: "00000000-0000-7000-8000-00000010a001",
  userId: "00000000-0000-7000-8000-00000010a002",
  sessionId: "00000000-0000-7000-8000-00000010a003",
  portfolioId: "00000000-0000-7000-8000-00000010a004",
  cashAccountIds: ["00000000-0000-7000-8000-00000010a005"],
};
const ACCOUNT = IDS.cashAccountIds[0]!;
const DESTINATION = { portfolioId: IDS.portfolioId, cashAccountId: ACCOUNT };

const ROW_COUNT = 20;
const ARCHIVE_AFTER = 5;

/** The chunked third case needs a portfolio the first two have not already filled. */
const CHUNKED_PORTFOLIO = "00000000-0000-7000-8000-00000010a006";
const CHUNKED_ACCOUNT = "00000000-0000-7000-8000-00000010a007";
const CHUNKED_DESTINATION = {
  portfolioId: CHUNKED_PORTFOLIO,
  cashAccountId: CHUNKED_ACCOUNT,
};

describe("F-D — a cash account archived mid-apply (CI-15)", () => {
  let pg: MigratedPostgres;
  let db: Db;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    db = pg.ownerDb;
    await seedTenant(pg, IDS);
    await seedPortfolio(pg, IDS.tenantId, CHUNKED_PORTFOLIO, CHUNKED_ACCOUNT, "chunked archive");
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  }, 30_000);

  it("reports what landed before the archive and what rejected after it, and keeps the former", async () => {
    const plan = await planImport(twentyDeposits(), planContext(db, IDS, DESTINATION));
    // The dry-run's promise, in the form the user is shown it.
    expect(plan.summary.imported).toBe(ROW_COUNT);

    const writes = archiveAfterNthCommit(
      buildWriteService(db, IDS.tenantId),
      ARCHIVE_AFTER,
      async () => {
        await setCashAccountArchived(db, {
          tenantId: IDS.tenantId,
          portfolioId: IDS.portfolioId,
          cashAccountId: ACCOUNT,
          archived: true,
        });
      },
    );

    const result = await applyImport({
      plan,
      db,
      writes,
      destination: DESTINATION,
      updatedBySessionId: IDS.sessionId,
      deadlineAt: applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS),
      clock: systemClock,
      // FR-53's row granularity, as a setting rather than as an assumption —
      // see this suite's header. At any larger value `archive()` below would
      // be waiting on the portfolio row this very loop is holding.
      chunkRows: 1,
    });

    // Both counts, in the same summary — the whole point of F-D.
    expect(result.summary.imported).toBe(ARCHIVE_AFTER);
    expect(result.applyFailed).toBe(ROW_COUNT - ARCHIVE_AFTER);
    // Not the deadline, and not a plan-time rejection: the reason this run is
    // partial is the archive, and nothing else.
    expect(result.applyNotAttempted).toBe(0);
    expect(tally(result.outcomes)).toEqual({
      IMPORT: ARCHIVE_AFTER,
      APPLY_FAILED: ROW_COUNT - ARCHIVE_AFTER,
    });

    // The five that landed are on disk. A "whole request failed" response
    // would have left the user with five invisible rows.
    expect(await countTransactions(pg, IDS.portfolioId)).toBe(ARCHIVE_AFTER);

    // Rows 1..5 imported, rows 6..20 rejected — the split is where the archive
    // happened, not an arbitrary partition of the same totals.
    expect(result.outcomes.slice(0, ARCHIVE_AFTER).map((one) => one.outcome)).toEqual(
      Array.from({ length: ARCHIVE_AFTER }, () => "IMPORT"),
    );
    const after = result.outcomes.slice(ARCHIVE_AFTER);
    expect(after.map((one) => one.outcome)).toEqual(
      Array.from({ length: ROW_COUNT - ARCHIVE_AFTER }, () => "REJECT"),
    );
    // Every one of them names the shipped ledger error, not a message this
    // module invented — which is what lets CI-18 render the same
    // `CASH_ACCOUNT_ARCHIVED` the manual write path answers with.
    for (const outcome of after) {
      if (outcome.outcome !== "REJECT") throw new Error("unreachable");
      expect(outcome.reason).toBe("APPLY_FAILED");
      expect(outcome.errorName).toBe("CashAccountArchivedError");
    }
  }, 120_000);

  it("un-archiving the account makes the same file import exactly the remainder", async () => {
    // The user's actual remedy, and the reason a partial import must be
    // reported honestly rather than swallowed: re-running is a complete fix.
    await setCashAccountArchived(db, {
      tenantId: IDS.tenantId,
      portfolioId: IDS.portfolioId,
      cashAccountId: ACCOUNT,
      archived: false,
    });

    const plan = await planImport(twentyDeposits(), planContext(db, IDS, DESTINATION));
    expect(tally(plan.outcomes)).toEqual({
      IMPORT: ROW_COUNT - ARCHIVE_AFTER,
      ALREADY_IMPORTED: ARCHIVE_AFTER,
    });

    const result = await applyImport({
      plan,
      db,
      writes: buildWriteService(db, IDS.tenantId),
      destination: DESTINATION,
      updatedBySessionId: IDS.sessionId,
      deadlineAt: applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS),
      clock: systemClock,
      chunkRows: 1,
    });
    expect(result.summary.imported).toBe(ROW_COUNT - ARCHIVE_AFTER);
    expect(result.applyFailed).toBe(0);
    expect(await countTransactions(pg, IDS.portfolioId)).toBe(ROW_COUNT);
  }, 120_000);

  it("cannot be interleaved with a chunk: the archive waits for it and applies after", async () => {
    // At the shipped chunk size the twenty rows are one transaction, and that
    // transaction holds this portfolio's row `FOR UPDATE` from its first row
    // (rung 2, `#beginTransactionCreate`). `setCashAccountArchived` takes the
    // same row the same way. So the archive issued below **cannot** commit
    // between two rows of the chunk however it is timed — the question this
    // case settles is what happens instead, and the answer is that it waits.
    //
    // Issued without `await`, deliberately: awaiting it here would be a
    // circular wait (this loop waiting for the archive, the archive waiting
    // for this loop's transaction) rather than a test of anything.
    let archiving: Promise<unknown> | null = null;
    const writes = archiveDuringNthWrite(buildWriteService(db, IDS.tenantId), ARCHIVE_AFTER, () => {
      archiving = setCashAccountArchived(db, {
        tenantId: IDS.tenantId,
        portfolioId: CHUNKED_PORTFOLIO,
        cashAccountId: CHUNKED_ACCOUNT,
        archived: true,
      });
    });

    const plan = await planImport(twentyDeposits(), planContext(db, IDS, CHUNKED_DESTINATION));
    const result = await applyImport({
      plan,
      db,
      writes,
      destination: CHUNKED_DESTINATION,
      updatedBySessionId: IDS.sessionId,
      deadlineAt: applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS),
      clock: systemClock,
      chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
    });

    // The whole chunk landed. Not "15 of 20 rounded up to a chunk boundary":
    // the archive was never visible to any row of it.
    expect(result.summary.imported).toBe(ROW_COUNT);
    expect(result.applyFailed).toBe(0);
    expect(result.applyNotAttempted).toBe(0);
    expect(await countTransactions(pg, CHUNKED_PORTFOLIO)).toBe(ROW_COUNT);

    // And the archive was not lost — it was queued behind the chunk and
    // applied once it committed. Both halves matter: a test that only checked
    // the count above would pass equally if the archive had silently failed.
    await archiving;
    const [account] = await pg.ownerClient<{ archived_at: string | null }[]>`
      SELECT archived_at FROM "cash_account" WHERE id = ${CHUNKED_ACCOUNT}::uuid
    `;
    expect(account!.archived_at).not.toBeNull();

    // The next import onto that account is refused, which is F-D's own
    // rejection reaching the user one chunk later than it would have at
    // `chunkRows: 1` — later, never skipped.
    const afterPlan = await planImport(
      moreDeposits(ROW_COUNT, 3),
      planContext(db, IDS, CHUNKED_DESTINATION),
    );
    const afterResult = await applyImport({
      plan: afterPlan,
      db,
      writes: buildWriteService(db, IDS.tenantId),
      destination: CHUNKED_DESTINATION,
      updatedBySessionId: IDS.sessionId,
      deadlineAt: applyDeadlineAt(new Date(), DEFAULT_IMPORT_LIMITS),
      clock: systemClock,
      chunkRows: DEFAULT_IMPORT_LIMITS.applyChunkRows,
    });
    expect(tally(afterResult.outcomes)).toEqual({ APPLY_FAILED: 3 });
    for (const outcome of afterResult.outcomes) {
      if (outcome.outcome !== "REJECT") throw new Error("unreachable");
      expect(outcome.errorName).toBe("CashAccountArchivedError");
    }
    expect(await countTransactions(pg, CHUNKED_PORTFOLIO)).toBe(ROW_COUNT);
  }, 120_000);

  it("records the `#mapWriteError` reuse obligation in the code, not only in a report", () => {
    const applySource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "apply.ts"),
      "utf8",
    );
    expect(applySource).toContain("#mapWriteError");
    expect(applySource).toContain("CASH_ACCOUNT_ARCHIVED");
    // The positive companion: the reader really did open `apply.ts` and not an
    // empty or missing file.
    expect(applySource).toContain("export async function applyImport");
  });
});

/** Twenty deposits, ascending dates, distinct amounts — so `applyOrder` is file order and "the first five" is a well-defined set. */
function twentyDeposits(): ParseResult {
  const rows: ParsedRow[] = Array.from({ length: ROW_COUNT }, (_, index) => {
    const row: NeutralCashMovementRow = {
      shape: "CASH_MOVEMENT",
      direction: "IN",
      tradeDate: `2026-01-${String(index + 1).padStart(2, "0")}`,
      tradeTs: null,
      amount: new Decimal(`${String(500 + index)}.00`),
      currency: "EUR",
      note: null,
    };
    return { at: { line: index + 2, index }, ok: true, row };
  });
  return { fileType: "CASH_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows };
}

/** `count` further deposits on dates no {@link twentyDeposits} row uses, so nothing is skipped as already imported. */
function moreDeposits(amountOffset: number, count: number): ParseResult {
  const rows: ParsedRow[] = Array.from({ length: count }, (_, index) => {
    const row: NeutralCashMovementRow = {
      shape: "CASH_MOVEMENT",
      direction: "IN",
      tradeDate: `2026-02-${String(index + 1).padStart(2, "0")}`,
      tradeTs: null,
      amount: new Decimal(`${String(500 + amountOffset + index)}.00`),
      currency: "EUR",
      note: null,
    };
    return { at: { line: index + 2, index }, ok: true, row };
  });
  return { fileType: "CASH_ACCOUNT_TRANSACTIONS", rowCount: rows.length, rows };
}

/**
 * The **real** write service, with one seam: after its `n`-th write
 * **transaction commits**, `archive()` runs to completion before the next one
 * is opened.
 *
 * A subclass rather than a stub, deliberately. The rows below are written by
 * the shipped code, the archive is performed by the shipped
 * `setCashAccountArchived`, and the rejection that follows is raised by the
 * shipped `#assertCashAccountsUsable` — nothing about the mechanism under test
 * is simulated. All this seam does is choose *when* the concurrent archive
 * lands, which is the one thing a race cannot be asked to do on cue.
 *
 * **The seam is `inWriteBatch`, not `recordDeposit`, and the difference
 * is the whole reason the archive can be awaited here.** A `record*` used to
 * open and commit its own transaction, so "the call returned" and "the row is
 * committed" were the same instant. Since the chunked apply a `record*` runs inside the
 * caller's batch transaction and returns while it is still open, so awaiting
 * an archive at that point would wait for a portfolio-row lock this very
 * transaction is holding — a circular wait, not a race. Counting committed
 * batches instead restores the original meaning exactly, and at
 * `chunkRows: 1` — which is what the two cases using this seam pass — one
 * committed batch is one committed row.
 *
 * A `Proxy` that re-binds every other member to the real instance, rather than
 * a subclass or `Object.create`: `TransactionWriteService` uses `#private`
 * fields, so any method invoked with a `this` that is not the real instance
 * throws on its first field access. Forwarding bound members keeps the whole
 * surface usable even though this suite happens to call only two of them.
 */
function archiveAfterNthCommit(
  service: TransactionWriteService,
  n: number,
  archive: () => Promise<void>,
): TransactionWriteService {
  let committed = 0;
  const intercepted = async <T>(run: (batch: WriteBatch) => Promise<T>): Promise<T> => {
    const value = await service.inWriteBatch(run);
    committed += 1;
    if (committed === n) await archive();
    return value;
  };
  return new Proxy(service, {
    get(target, property) {
      if (property === "inWriteBatch") return intercepted;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The other seam, and the opposite one: `start()` is called **during** the
 * `n`-th write, from inside the still-open batch transaction, and its result
 * is deliberately not awaited.
 *
 * Only the third case uses it, and only because that case is about what
 * happens to a concurrent archive that arrives mid-chunk. Awaiting it would
 * be the circular wait described above; not awaiting it is the actual
 * scenario — another request, on another connection, blocking on the
 * portfolio row until this chunk commits.
 */
function archiveDuringNthWrite(
  service: TransactionWriteService,
  n: number,
  start: () => void,
): TransactionWriteService {
  let written = 0;
  const intercepted = async (params: RecordCashMovementParams): Promise<TransactionRecord> => {
    const row = await service.recordDeposit(params);
    written += 1;
    if (written === n) start();
    return row;
  };
  return new Proxy(service, {
    get(target, property) {
      if (property === "recordDeposit") return intercepted;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function countTransactions(pg: MigratedPostgres, portfolioId: string): Promise<number> {
  const [row] = await pg.ownerClient<{ n: string }[]>`
    SELECT count(*)::text AS n FROM "transaction" WHERE portfolio_id = ${portfolioId}::uuid
  `;
  return Number(row!.n);
}
