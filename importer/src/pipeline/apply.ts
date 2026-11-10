import {
  CashAccountArchivedError,
  createCashAccount,
  createPortfolio,
  CashAccountCurrencyMismatchError,
  CashAccountNameAlreadyExistsError,
  CashAccountNotAllowedError,
  CashAccountNotFoundError,
  CashAccountRequiredError,
  CostComponentsInvalidError,
  createInstrumentByIsin,
  createInstrumentBySymbol,
  CryptoRateUnavailableError,
  FxRateUnavailableError,
  InstrumentAlreadyExistsError,
  InstrumentNotFoundError,
  InsufficientQuantityError,
  InvalidDripSourceError,
  InvalidSettlementAssetError,
  OverSellError,
  PortfolioVanishedDuringRecomputeError,
  PostingExpansionError,
  TradeDateInFutureError,
  TradeDateTooOldError,
  TransactionAmountNotPositiveError,
  TransactionArgumentError,
  TransactionPortfolioNotFoundError,
  TransactionSelfSettledError,
  TransferDestinationIsSourceError,
  TransferDestinationNotFoundError,
  type TransactionWriteService,
} from "@kerdial/ledger";
import type { Decimal } from "@kerdial/core-decimal";
import { extractPostgresError, type Db } from "@kerdial/platform-db";
import { loggableErrorDetail, rootLogger } from "@kerdial/platform-logging";

import type {
  ImportDestination,
  ImportPlan,
  ImportRejectReason,
  ImportSkipReason,
  ImportSummary,
  PlannedCashAccountWrite,
  PlannedDirectory,
  PlannedPortfolioWrite,
  PlannedRowOutcome,
  PlannedTransactionWrite,
  PlannedWrite,
} from "./plan.js";
import type { PlannedInstrumentWrite } from "./instrument-resolution.js";
import type { Clock } from "./ports.js";
import type { AnyImportFileType, SourceRowRef } from "../types.js";

/**
 * `applyImport` — the write half of the pipeline.
 *
 * **Everything in this directory is scanned by `pnpm import-vocabulary-gate`,
 * comments included; the gate strips nothing.** No source column name and no
 * type label from any export format may appear in this file, in code or in
 * prose.
 *
 * ## The shape, and the measurement that chose it
 *
 * This is the simple per-row loop: for each index in
 * `plan.applyOrder`, exactly one call to the already-shipped `record*` /
 * `createInstrument*` function that manual entry uses. No new write function,
 * no bulk insert, no new caller of `recomputeAndInvalidate` — so every
 * `CHECK`, the sum-to-zero posting property, FX resolution, the cash-account
 * usability check, `portfolio-lock.ts`'s lock order and `calc_epoch`
 * invalidation are exercised by the same code path a hand-entered transaction
 * takes. That is what makes IMP-AC-16 checkable rather than aspirational, and
 * `materialization.ts`'s enumerated-caller comment stays true unchanged (this
 * module adds no third caller: it calls `record*`, which calls `#invalidate`).
 *
 * The chunked-apply fallback is **not** built. GATE-1
 * (`ledger/src/import-throughput.benchmark.integration.test.ts`) measured the
 * raw floor against real Postgres and recorded its verdict verbatim:
 *
 * > *GATE-1 PASSED at 4838 ms / 2031 ms — `apply.ts` (CI-13) is built as
 * > the simple per-row loop, not the chunked-apply
 * > fallback.*
 *
 * That fallback is "not to be built unless the measurement
 * fails"; it did not fail, at 32% and 14% of its 15 000 ms per-file budget.
 *
 * ## Order, and why it is not negotiable
 *
 * `plan.applyOrder` is ascending by trade date, then file order (ID5), and
 * this loop walks it in exactly that order. Every write deletes
 * `portfolio_daily_valuation` from its own trade date forward, so an ascending
 * walk makes the **first** write delete the widest range and every later one a
 * progressively narrower suffix (M20). Applying the same rows in any
 * other order re-widens that range repeatedly and measures a different, worse
 * system than the one GATE-1 timed. There is no out-of-order code path here to
 * choose by accident.
 *
 * ## Concurrency
 *
 * This module introduces **no new read/write interleaving**. It issues no read
 * of its own between `plan` and the writes, holds no lock across rows, and
 * every row's read-modify-write (`seq` allocation, cash-account usability,
 * over-sell check, recompute, `calc_epoch` bump) happens entirely inside a
 * single `record*` call's own DB transaction, under
 * `portfolio-lock.ts`'s existing rung order. Two concurrent imports of one
 * portfolio therefore serialise on rung 2 exactly as two concurrent manual
 * writes already do — the "invalidate on write, materialise lazily on read"
 * race this repository has recorded is a property of that shared path, not a
 * new seam opened here.
 *
 * The one genuinely new race is the fingerprint's, and it is closed by the
 * database rather than by this loop: `plan`'s existence check is a TOCTOU
 * read, and `transaction_import_fingerprint_key` is the backstop — the loser
 * of a race takes a `23505` on that index, which {@link applyImport} maps to
 * `SKIP / ALREADY_IMPORTED` for that row. Because the fingerprint is
 * part of the row's own `INSERT`, the loser's row is never written, so the
 * skip is a true statement about the ledger and not a euphemism for a
 * duplicate.
 *
 * ## Failure is per row, and the report says which rows
 *
 * FR-53's partial success is real here: each `record*` commits on its own, so
 * a failure part-way through leaves earlier rows written. This function never
 * throws for a row problem — it records `REJECT / APPLY_FAILED` carrying the
 * ledger error's own name and continues — and it returns
 * `applyFailed` / `applyNotAttempted` counts explicitly, so a caller can tell
 * "everything landed" from "some of it did". The identity between a dry-run
 * and a real run holds exactly when both counters are zero, which is why they
 * are counted rather than inferred from `byReason`.
 *
 * **The controller must not write a second error mapper (F-D, CI-15).**
 * The cash-account archive that commits between a dry-run and its confirm
 * reaches this loop as `CashAccountArchivedError` from
 * `TransactionWriteService`'s own `#assertCashAccountsUsable`; it is absorbed
 * per row, so the rows that landed **before** the archive are reported as
 * imported and the ones after it as `APPLY_FAILED`, rather than the whole
 * request being presented as failed and the committed rows disappearing from
 * the summary. Any ledger error that nevertheless escapes this function — a
 * request that could not be formed at all, not a row that failed — must be
 * mapped by `TransactionsController`'s existing `#mapWriteError`, reused, so
 * `CashAccountArchivedError` answers `409 CASH_ACCOUNT_ARCHIVED` there exactly
 * as it does for a manual write. A second mapper in `api/src/imports/` would
 * be a second contract to keep in step, and this is the note that says so
 * before one gets written.
 *
 * ## What this module never does: delete an instrument (F-B, CI-14)
 *
 * A partly-failed asset-catalogue import leaves behind instruments it created
 * for rows that later failed, and the tempting cleanup is to delete them.
 * **Decided: the import never deletes an instrument.** An over-created shared
 * instrument is harmless reference data; a delete path is not.
 * `TRANSACTION_FK_HANDLING`'s entry for
 * `transaction_instrument_id_instrument_id_fk` is `"NO_DELETE_PATH"`, and its
 * own doc comment says that is "a claim about the product, not about the
 * database … Add an endpoint that deletes one of those and the corresponding
 * entry becomes a bug" — the concrete consequence being that a concurrent
 * delete would turn an ordinary transaction write into an unmapped `23503`
 * 500. This is a property, not a convention:
 * `apply.non-regression.integration.test.ts` scans this package's own sources
 * for any instrument-deleting call, and
 * `transaction-write-service.fk-coverage.integration.test.ts` is the standing
 * guard on the claim itself and needs no edit.
 */

/** One row's outcome after the write attempt: the three outcomes, unchanged; only `IMPORT` carries new information. */
export type AppliedRowOutcome =
  | {
      readonly at: SourceRowRef;
      readonly outcome: "IMPORT";
      /** The `transaction.id` or `instrument.id` this row actually produced — the proof the write happened. */
      readonly writtenId: string;
    }
  | {
      readonly at: SourceRowRef;
      readonly outcome: "SKIP";
      readonly reason: ImportSkipReason;
      readonly message: string;
    }
  | {
      readonly at: SourceRowRef;
      readonly outcome: "REJECT";
      readonly reason: ImportRejectReason;
      readonly message: string;
      /**
       * The ledger error's own name for an `APPLY_FAILED` row ("carries
       * the ledger error's own code"), `null` for every rejection `plan`
       * already decided. Not optional: a caller reading `errorName` must be
       * able to tell "this row failed for a reason with no name" from "this
       * field was not populated on this path".
       *
       * **Three shapes, and the second exists because `Error` was useless**.
       * A recognised ledger error gives its class name
       * (`"CashAccountArchivedError"`). A failure the *database* refused gives
       * `"SQLSTATE_22003"` and the like: `DrizzleQueryError` never sets
       * `this.name`, so every driver error used to report as the bare
       * `"Error"` — uninformative for exactly the class the field was added
       * for. Anything else is `null`, because this pipeline has nothing true
       * to say about it. Internal to `importer` and to `api`'s logs:
       * `ImportRowOutcomeResponse` does not carry it, so no shape here is a
       * response-body contract.
       */
      readonly errorName: string | null;
    };

/**
 * The staged interface sketched this shape with a `changedBy` field and no `clock`.
 * Both differences are deliberate and are recorded here rather than
 * reconciled silently:
 *
 *  - **`changedBy` is absent.** It is `editTransaction`/`deleteTransaction`'s
 *    audit field (`transaction_revision.changed_by`); `apply` only ever
 *    creates, and no `record*` takes it. A required field no writer reads is a
 *    field the next author has to guess the meaning of. The session is carried
 *    instead, on `updatedBySessionId`, which every create path does write.
 *  - **`clock` is present.** `Date.now()` cannot be moved, so a deadline test
 *    written against it either sleeps or asserts a constant — and this
 *    repository has shipped an inert timeout that passed a test asserting the
 *    option's value. `PlanContext` already takes a `Clock` for the same reason.
 */
export interface ApplyContext {
  readonly plan: ImportPlan;
  /** Instrument creation is a free function over the connection, not a method on the write service. */
  readonly db: Db;
  /** The shipped service, called exactly as a manual entry calls it. */
  readonly writes: TransactionWriteService;
  /**
   * Absent for an asset-catalogue file; required for both transaction file
   * types, and the same destination `plan` was given — its `cashAccountId` is
   * already baked into every planned write (and into every fingerprint), so
   * only the portfolio is read from here.
   */
  readonly destination: ImportDestination | null;
  /** Recorded on `transaction.updated_by_session_id`, like every other write. */
  readonly updatedBySessionId: string;
  /**
   * The wall-clock stop line, derived once by `applyDeadlineAt`
   * (`limits.ts`) from the moment the **request** arrived — not from the moment
   * this function was called. The budget it protects is the 30 s handler
   * timeout, which starts ticking at the request, and parsing plus planning
   * have already spent some of it by then.
   */
  readonly deadlineAt: Date;
  /**
   * Injected for the reason `PlanContext.clock` is: a deadline asserted by
   * reading its constant proves nothing, so the tests drive this loop past the
   * line at a chosen row and count the effect.
   */
  readonly clock: Clock;
  /**
   * How many consecutive transaction rows share one write transaction
   * and one portfolio recompute. `ImportLimits.applyChunkRows`, passed through
   * rather than read from module scope for the reason `limits.ts`'s header
   * gives: a tunable that cannot be varied cannot be proved to bind.
   *
   * It is the unit of resumability as well as of batching: a chunk commits
   * whole or not at all, so the deadline's remedy stays "re-run the file and
   * it imports the remainder" — at chunk granularity rather than row
   * granularity. That is why it is a chunk size and not "one transaction for
   * the whole file", which would make a file too slow for the budget roll back
   * every time and never converge.
   */
  readonly chunkRows: number;
  /**
   * The tenant this plan is applied into. **Optional, and required in exactly
   * one case**: a plan that carries a {@link ImportPlan.directory} entry — a
   * portfolio or a cash account the file names and the destination does not
   * have — is written through `createPortfolio`/`createCashAccount`, which are
   * free functions over the connection and take the tenant explicitly.
   *
   * Optional rather than required because every pre-cycle caller writes into a
   * destination that already exists and has nothing to create; making it
   * required would be a compile error in `api/src/imports` for a field that
   * path never needs.
   */
  readonly tenantId?: string;
  /**
   * FR-539's two caps, forwarded verbatim to `createPortfolio` /
   * `createCashAccount`. `plan` consulted the same two numbers (see
   * `PlanContext.maxPortfoliosPerTenant`), so the plan-time report and the
   * write-time refusal cannot be given different values.
   */
  readonly maxPortfoliosPerTenant?: number;
  readonly maxCashAccountsPerPortfolio?: number;
}

export interface ImportResult {
  readonly fileType: AnyImportFileType;
  readonly rowCount: number;
  /** `length === rowCount`, in file order — the exhaustiveness invariant, preserved across the write. */
  readonly outcomes: readonly AppliedRowOutcome[];
  readonly summary: ImportSummary;
  /** Rows the ledger refused. Non-zero means a dry-run's counts and this run's cannot be expected to agree. */
  readonly applyFailed: number;
  /** Rows whose turn never came, because {@link ApplyContext.deadlineAt} was reached first. */
  readonly applyNotAttempted: number;
}

/** The `IMPORT` arm of {@link PlannedRowOutcome} — the only one `applyOrder` may name. */
type PlannedImportRow = Extract<PlannedRowOutcome, { outcome: "IMPORT" }>;

/** The outcome for a row whose turn never came. One definition, used by both the chunked and the standalone path. */
function notAttempted(at: SourceRowRef): AppliedRowOutcome {
  return {
    at,
    outcome: "REJECT",
    reason: "APPLY_NOT_ATTEMPTED",
    message:
      "the time budget for this request ran out before this row's turn; the rows already written stay written, " +
      "so running the same file again imports exactly the remainder",
    errorName: null,
  };
}

export async function applyImport(ctx: ApplyContext): Promise<ImportResult> {
  // Start from the plan's own outcomes: every `SKIP` and `REJECT` it decided
  // is carried through unchanged, so the counts a dry-run reported are the
  // counts this run reports for every row the write path never sees.
  // The `IMPORT` rows are left as holes, filled by the loop below — a hole
  // that survives it is a row `applyOrder` never named, which is thrown on
  // rather than reported as "not attempted": those two are the same green
  // otherwise.
  const draft: (AppliedRowOutcome | null)[] = ctx.plan.outcomes.map((outcome) => {
    if (outcome.outcome === "IMPORT") return null;
    // `errorName` is `null` for every rejection `plan` decided: no ledger call
    // was made for these rows, so there is no ledger error to name. See
    // {@link AppliedRowOutcome} on why the field is required rather than
    // optional.
    return outcome.outcome === "REJECT" ? { ...outcome, errorName: null } : outcome;
  });

  // The directory creates — the portfolios and cash accounts the file names and
  // the destination does not have, created before a single transaction row is
  // written. Outside `inWriteBatch`: `createCashAccount` takes the portfolio
  // lock itself, and opening a batch around a run of lock-taking creates would
  // hold rung 2 across every one of them.
  const unavailable = await createDirectory(ctx, ctx.plan.directory);

  const deadlineMs = ctx.deadlineAt.getTime();
  const pastDeadline = (): boolean => ctx.clock.now().getTime() >= deadlineMs;
  const order = ctx.plan.applyOrder;
  /**
   * Pass 2: the id each row was actually written with, keyed by its file
   * position, so a reinvestment names the row this run wrote rather than the
   * one the plan predicted. The two agree — `plan` pre-allocates the id and
   * `writeOne` passes it through — and reading the written one anyway is what
   * makes the claim checkable rather than assumed.
   */
  const writtenIdByPosition = new Map<number, string>();

  /** The plan's own entry for a row `applyOrder` named, or the "hole that survived" error. */
  const plannedAt = (index: number): PlannedImportRow => {
    const planned = ctx.plan.outcomes[index];
    if (planned === undefined || planned.outcome !== "IMPORT") {
      throw new Error(
        `applyOrder names row ${String(index)}, which the plan did not mark for import`,
      );
    }
    return planned;
  };

  let cursor = 0;
  while (cursor < order.length) {
    const first = order[cursor]!;

    // An asset-catalogue row writes no `transaction` and triggers no
    // recompute, so it has nothing to gain from a batch — and it writes over
    // `ctx.db`, a different connection from the batch's, which inside an open
    // batch transaction would be a second connection racing the first. Written
    // one at a time, exactly as before.
    if (plannedAt(first).write.target !== "TRANSACTION") {
      const planned = plannedAt(first);
      cursor += 1;
      // Checked **before** each row rather than after: a row is either
      // attempted whole or not at all, and every remaining one reports honestly.
      if (pastDeadline()) {
        draft[first] = notAttempted(planned.at);
        continue;
      }
      try {
        draft[first] = {
          at: planned.at,
          outcome: "IMPORT",
          writtenId: await writeOne(ctx, planned.write, writtenIdByPosition),
        };
      } catch (error) {
        draft[first] = failureOutcome(planned.at, error);
      }
      continue;
    }

    // The next run of consecutive transaction rows, up to the chunk
    // size, written inside one transaction with one portfolio recompute.
    const chunk: number[] = [];
    // KD9: the chunk also ends when the **next row's portfolio
    // differs** — except in a `CHRONOLOGICAL` plan (below). `applyOrder`
    // sorts by portfolio first for a file with no stated transfer pair, so this
    // costs no row its place in the order.
    //
    // F-7 (`security-transfer`, as amended by A-7): this used to say a chunk's lock set is **exactly one portfolio**.
    // It no longer is. A source-leg transfer row with a destination locks the
    // target's portfolio too (rung 2, ascending id), and a file writing such a
    // pair is applied in global chronological order (ST-12), so its chunks are
    // shorter but not single-portfolio. That is still no new deadlock shape,
    // for a different reason than before: every create takes the tenant
    // advisory lock (rung 1) first, and inside `inWriteBatch` that lock is held
    // from the chunk's first create to its commit — so no two writers of one
    // tenant can hold portfolio rows while waiting for each other's.
    //
    // It is deliberately **not** about the recompute: `WriteBatchState`'s
    // deferred recompute is keyed by portfolio, so a multi-portfolio batch
    // already recomputes each one correctly (its flush is one propagation over
    // every deferred portfolio). Stating that distinction is the point of the
    // rule.
    //
    // So a `CHRONOLOGICAL` plan does not break on the portfolio at all.
    // Its order alternates portfolios as often as the file does, and breaking
    // on each change made an interleaved file ~10x the chunks of a
    // portfolio-first one, each chunk a full recompute (with propagation) of a
    // growing timeline: 22 rows/s at 4 800 rows. The rung-1 argument above is
    // what makes a multi-portfolio chunk safe; KD9's break stays for the other
    // orders, where it costs nothing.
    const breakOnPortfolio = ctx.plan.applyOrderRule !== "CHRONOLOGICAL";
    const chunkPortfolio = portfolioOfPlanned(ctx, plannedAt(first));
    while (cursor < order.length && chunk.length < ctx.chunkRows) {
      const index = order[cursor]!;
      const planned = plannedAt(index);
      if (planned.write.target !== "TRANSACTION") break;
      if (breakOnPortfolio && portfolioOfPlanned(ctx, planned) !== chunkPortfolio) break;
      chunk.push(index);
      cursor += 1;
    }

    // Still **exactly one clock reading per row**, and the first row's
    // is taken before the transaction is opened: crossing the line should not
    // cost a connection and a `BEGIN` per remaining chunk, and a chunk whose
    // first row is already past the line writes nothing and opens nothing.
    // Sharing the first reading rather than adding a chunk-level one of its
    // own is what keeps the cut landing on the same row it landed on when
    // every row was its own transaction.
    let past = pastDeadline();
    if (past) {
      for (const index of chunk) draft[index] = notAttempted(plannedAt(index).at);
      continue;
    }

    try {
      await ctx.writes.inWriteBatch(async (batch) => {
        for (const [position, index] of chunk.entries()) {
          const planned = plannedAt(index);
          if (position > 0) past = pastDeadline();
          if (past) {
            draft[index] = notAttempted(planned.at);
            continue;
          }
          const blocked = blockedByDirectory(unavailable, planned.write);
          if (blocked !== undefined) {
            // The portfolio or account this row writes into could not be
            // created, so the row cannot be attempted. Reported as the create's
            // own failure rather than as the foreign-key violation the write
            // would have produced.
            draft[index] = failureOutcome(planned.at, blocked);
            continue;
          }
          try {
            draft[index] = {
              at: planned.at,
              outcome: "IMPORT",
              // One `SAVEPOINT` per row: a row the ledger refuses fails alone
              // and every other row of the chunk still commits.
              writtenId: await batch.row(async () => {
                const writtenId = await writeOne(ctx, planned.write, writtenIdByPosition);
                writtenIdByPosition.set(index, writtenId);
                return writtenId;
              }),
            };
          } catch (error) {
            draft[index] = failureOutcome(planned.at, error);
          }
        }
      });
    } catch (error) {
      // The batch's own transaction failed — its `COMMIT`, or the single
      // recompute it ends with. **Nothing in this chunk was written**, so the
      // per-row outcomes recorded inside it describe writes that no longer
      // exist and are replaced here. A row the deadline had already excluded
      // keeps that outcome: it was not attempted, and saying it failed would
      // be less true, not more.
      for (const index of chunk) {
        const recorded = draft[index];
        if (recorded?.outcome === "REJECT" && recorded.reason === "APPLY_NOT_ATTEMPTED") continue;
        draft[index] = failureOutcome(plannedAt(index).at, error);
      }
    }
  }

  const outcomes = draft.map((outcome, position) => {
    if (outcome === null) {
      // Unreachable while `applyOrder` names every `IMPORT` row, which
      // `applyOrderOf` builds it to. Checked anyway: silently reporting a row
      // as "not attempted" when the loop simply never looked at it is
      // precisely the vacuous half of `applyNotAttempted === 0`.
      throw new Error(
        `row at position ${String(position)} was marked for import and applyOrder never visited it`,
      );
    }
    return outcome;
  });
  if (outcomes.length !== ctx.plan.rowCount) {
    throw new Error(
      `outcome count ${String(outcomes.length)} does not equal row count ${String(ctx.plan.rowCount)}`,
    );
  }

  return {
    fileType: ctx.plan.fileType,
    rowCount: ctx.plan.rowCount,
    outcomes,
    summary: summarize(outcomes),
    applyFailed: countReason(outcomes, "APPLY_FAILED"),
    applyNotAttempted: countReason(outcomes, "APPLY_NOT_ATTEMPTED"),
  };
}

/**
 * One row, one call to the shipped write path.
 *
 * Returns the written row's id. The `switch` is closed by a `never` check, so
 * a new planned-write kind is a compile error here rather than a row that
 * silently writes nothing.
 */
async function writeOne(
  ctx: ApplyContext,
  write: PlannedWrite,
  writtenIdByPosition: ReadonlyMap<number, string>,
): Promise<string> {
  switch (write.target) {
    case "TRANSACTION":
      return writeTransaction(ctx, write, writtenIdByPosition);
    case "INSTRUMENT":
      return writeInstrument(ctx.db, write);
    default: {
      const exhaustive: never = write;
      return exhaustive;
    }
  }
}

/**
 * FR-227's zero-to-absent boundary, and the only place in this package that
 * crosses it.
 *
 * The neutral row and the fingerprint carry the source's two cost figures
 * **verbatim**, because a hash must tell an absent figure (`""`) from one that
 * said `0` (`"0.000000000000"`). The write contract wants the opposite: a
 * component is present or omitted and is never zero (FR-213), and every present
 * component must be strictly positive. So a zero is dropped here.
 *
 * Dropping a zero cannot move the total: `costs` is the sum of the two figures
 * with an absent one read as zero, so a zero contributes nothing to it, and the
 * surviving components still sum to it exactly — which is what
 * `transaction_cost_components_sum_to_fee_amount` and the write service both
 * require. A fee of 7,14 with a tax of 4,30 itemises 7,14 + 4,30 = 11,44; a fee
 * of 7,14 with a tax of 0,00 itemises a broker fee of 7,14 alone against a
 * total of 7,14.
 *
 * Returns `{}` — no `components` key at all — when neither figure survives, so
 * a trade whose only cost figure is an unattributed total still writes the
 * unitemised leg it wrote before this cycle. That is not a fallback: it is the
 * shape a cash-side or fold-only row genuinely has, and L8 keeps it valid
 * permanently.
 */
function costComponentsOf(
  write: PlannedTransactionWrite,
):
  | { components: { brokerFee?: Decimal; fxFee?: Decimal; tax?: Decimal; other?: Decimal } }
  | Record<string, never> {
  const components = {
    ...(write.brokerFee !== null && write.brokerFee.greaterThan(0)
      ? { brokerFee: write.brokerFee }
      : {}),
    // FR-213's four-way itemisation. The Portfolio-Performance export carries
    // two of the four and leaves these two `null`, so its rows produce exactly
    // the two-component leg they produced before this cycle.
    ...(write.fxFee !== null && write.fxFee.greaterThan(0) ? { fxFee: write.fxFee } : {}),
    ...(write.taxAmount !== null && write.taxAmount.greaterThan(0) ? { tax: write.taxAmount } : {}),
    ...(write.otherCost !== null && write.otherCost.greaterThan(0)
      ? { other: write.otherCost }
      : {}),
  };
  return Object.keys(components).length === 0 ? {} : { components };
}

/**
 * The whole cost leg, or no leg at all — one definition, used by the four kinds
 * that can carry one.
 *
 * `plan` has already rejected a negative figure, and a zero one emits no leg:
 * the write service requires a fee amount to be strictly positive, and
 * {@link costComponentsOf} turns a zero component into an absent one.
 */
function feeLegOf(
  write: PlannedTransactionWrite,
): { fee: { amount: Decimal; components?: object } } | Record<string, never> {
  if (write.feeAmount === null || !write.feeAmount.greaterThan(0)) return {};
  return { fee: { amount: write.feeAmount, ...costComponentsOf(write) } };
}

/**
 * The plan's directory creates, run once before the write loop.
 *
 * **Through the shipped services, never a raw insert** (FR-558's rule for the
 * catalogue path, and the same rule here): `createPortfolio` and
 * `createCashAccount` are what enforce FR-539's two caps, the non-empty-name
 * guard, the `(tenant, name)` and `(portfolio, name)` unique indexes and the
 * portfolio lock. Re-checking the caps at write time — after `plan` already
 * reported them — is not redundant: a concurrent request can take the last slot
 * between the two.
 *
 * Returns the ids that could **not** be created, each mapped to the error that
 * refused it, so every row naming one is reported as that failure rather than
 * as the foreign-key violation its own write would have raised. A cash account
 * whose portfolio failed inherits the portfolio's error: it is the same fact,
 * and reporting a second, derived error for it would double-count one cause.
 *
 * ## The initial-account name collision, and where it is repaired
 *
 * `createPortfolio` opens one cash account of its own inside the same
 * transaction — `INITIAL_CASH_ACCOUNT_NAME`, in
 * `INITIAL_CASH_ACCOUNT_CURRENCY` (MEASURED, `ledger/src/portfolio-service.ts`).
 * `(tenant_id, portfolio_id, name)` is unique, so a file naming an account with
 * **that** name inside a portfolio this run creates used to take a `23505`
 * here, and every row of that account was reported `APPLY_FAILED` — the common
 * case of a user who never renamed the account the product opened for them.
 *
 * The repair is **not** in this function, and that is the decision rather than
 * an omission: no repair available here is correct. The planned id is baked
 * into the row's `kd1` fingerprint, so
 * adopting the auto-created account's id after the fact would store a
 * fingerprint computed over a *different* id than the row uses — and the next
 * import of the same file would recompute it over the real id, not match, and
 * duplicate every row. So the repair is where the account is created:
 * {@link portfolioCreateParams} passes
 * `initialCashAccount: false` for a portfolio this plan also creates accounts
 * for, and those accounts — including one carrying the auto-created name — are
 * created below, with the ids the fingerprints were computed over.
 *
 * **The condition is "this plan creates an account for it", not "always".** A
 * file whose only rows for a new portfolio name no cash account at all (a
 * `SHARE_DISTRIBUTION` names none) leaves the portfolio with no account
 * whatever if the initial one is suppressed, and CA-25 exists precisely so a
 * fresh portfolio can receive its first transaction. So that portfolio still
 * gets the account the product would have given it.
 */
async function createDirectory(
  ctx: ApplyContext,
  directory: PlannedDirectory,
): Promise<Map<string, unknown>> {
  const unavailable = new Map<string, unknown>();
  const { portfolios, cashAccounts } = directory;
  if (portfolios.length === 0 && cashAccounts.length === 0) return unavailable;
  const tenantId = ctx.tenantId;
  if (tenantId === undefined) {
    // A request that could not have been formed, not a row that failed: this
    // plan promised creates and the context cannot say into which tenant.
    throw new Error(
      "this plan creates a portfolio or a cash account, which needs the tenant it is applied into",
    );
  }
  /** The portfolios this run also creates at least one cash account for — see the header. */
  const accountsPlannedFor = new Set(cashAccounts.map((one) => one.portfolioId));
  for (const one of portfolios) {
    try {
      await createPortfolio(
        ctx.db,
        portfolioCreateParams(ctx, tenantId, one, accountsPlannedFor.has(one.id)),
      );
    } catch (error) {
      unavailable.set(one.id, error);
    }
  }
  for (const one of cashAccounts) {
    const portfolioFailure = unavailable.get(one.portfolioId);
    if (portfolioFailure !== undefined) {
      unavailable.set(one.id, portfolioFailure);
      continue;
    }
    try {
      await createCashAccount(ctx.db, cashAccountCreateParams(ctx, tenantId, one));
    } catch (error) {
      unavailable.set(one.id, error);
    }
  }
  return unavailable;
}

/**
 * The create call's own arguments, built here rather than inline so the cap
 * override is **omitted** when the context does not set one — `undefined` and
 * "not supplied" are the same to a `??`, but this package compiles under
 * `exactOptionalPropertyTypes`, where they are not the same to the type.
 */
function portfolioCreateParams(
  ctx: ApplyContext,
  tenantId: string,
  planned: PlannedPortfolioWrite,
  createsItsOwnAccounts: boolean,
): Parameters<typeof createPortfolio>[1] {
  return {
    id: planned.id,
    tenantId,
    name: planned.name,
    // See `createDirectory`'s header. Stated only when it is
    // `false`: the default is what every other caller of `createPortfolio`
    // gets, and passing `true` explicitly would read as a choice this function
    // makes rather than as the product behaviour it leaves alone.
    ...(createsItsOwnAccounts ? { initialCashAccount: false } : {}),
    ...(ctx.maxPortfoliosPerTenant === undefined
      ? {}
      : { maxPortfoliosPerTenant: ctx.maxPortfoliosPerTenant }),
  };
}

function cashAccountCreateParams(
  ctx: ApplyContext,
  tenantId: string,
  planned: PlannedCashAccountWrite,
): Parameters<typeof createCashAccount>[1] {
  return {
    id: planned.id,
    tenantId,
    portfolioId: planned.portfolioId,
    name: planned.name,
    currency: planned.currency,
    ...(ctx.maxCashAccountsPerPortfolio === undefined
      ? {}
      : { maxCashAccountsPerPortfolio: ctx.maxCashAccountsPerPortfolio }),
  };
}

/** The create failure that makes this row unwritable, or `undefined`. */
function blockedByDirectory(
  unavailable: ReadonlyMap<string, unknown>,
  write: PlannedWrite,
): unknown {
  if (unavailable.size === 0 || write.target !== "TRANSACTION") return undefined;
  for (const id of [
    write.portfolioId,
    write.cashAccountId,
    write.targetCashAccountId,
    // `security-transfer`: a destination portfolio this run failed to create
    // blocks the pair — writing the source leg alone would be a Step A the
    // user did not choose.
    write.transferTargetPortfolioId,
  ]) {
    if (id === null || id === "") continue;
    const failure = unavailable.get(id);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

/** The portfolio a planned row is written into — the chunk boundary KD9 fixes. `null` for a non-transaction row. */
function portfolioOfPlanned(ctx: ApplyContext, planned: PlannedImportRow): string | null {
  return planned.write.target === "TRANSACTION"
    ? (planned.write.portfolioId ?? ctx.destination?.portfolioId ?? null)
    : null;
}

async function writeTransaction(
  ctx: ApplyContext,
  write: PlannedTransactionWrite,
  writtenIdByPosition: ReadonlyMap<number, string>,
): Promise<string> {
  const portfolioId = portfolioIdOf(ctx, write);
  const common = {
    // `plan` pre-allocated it for every per-row-destination row, because `kd1`
    // hashes the id of the row a reinvestment reinvests and the fingerprint has
    // to exist before the write. Absent for every other row, which lets
    // `record*` mint its own exactly as before.
    ...(write.id === null ? {} : { id: write.id }),
    portfolioId,
    tradeDate: write.tradeDate,
    ...(write.tradeTs === null ? {} : { tradeTs: write.tradeTs }),
    ...(write.note === null ? {} : { note: write.note }),
    ...(write.reference === null ? {} : { reference: write.reference }),
    updatedBySessionId: ctx.updatedBySessionId,
    importFingerprint: write.importFingerprint,
  };
  /** The settling account's own denomination and the amount that moved — omitted together, per the ledger's own resolution table. */
  const cashLeg = {
    ...(write.cashCurrency === null ? {} : { cashCurrency: write.cashCurrency }),
    ...(write.cashAmount === null ? {} : { cashAmount: write.cashAmount }),
    ...(write.fxRateUserInput === null ? {} : { fxRateUserInput: write.fxRateUserInput }),
  };

  switch (write.kind) {
    case "DEPOSIT":
    case "WITHDRAWAL": {
      const params = {
        ...common,
        amount: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        cashAccountId: write.cashAccountId,
        ...cashLeg,
      };
      const row =
        write.kind === "DEPOSIT"
          ? await ctx.writes.recordDeposit(params)
          : await ctx.writes.recordWithdrawal(params);
      return row.id;
    }
    case "DIVIDEND": {
      const row = await ctx.writes.recordDividend({
        ...common,
        instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
        amount: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        cashAccountId: write.cashAccountId,
        ...cashLeg,
        // The withholding is one amount, denominated by the settling
        // account's currency and posted on the principal's account at the
        // principal's rate — the ledger derives all of that; the row carries
        // the amount alone.
        //
        // **A zero figure is no leg at all, exactly as it is for a fee**.
        // `readCostCell` answers `Decimal(0)` — not `null` — for a
        // source cell that spells the tax out as zero rather than leaving it
        // blank, and `validate`/`plan` both permit zero because zero is not a
        // *malformed* figure. This branch used to forward it anyway, so such a
        // row planned as `IMPORT` and then failed at `apply`:
        // `recordDividend`'s `assertPositiveDecimal` refuses it, and so does
        // `transaction_withholding_amount_positive` behind it. That is a
        // dry-run/confirm divergence with no reason to exist — a dividend on
        // which no tax was withheld *has* no withholding leg — and the fee
        // branch below already normalises the identical case, which is the
        // precedent this follows rather than inventing a second rule.
        ...(write.withholdingAmount === null || !write.withholdingAmount.greaterThan(0)
          ? {}
          : {
              withholding: { amount: write.withholdingAmount },
            }),
      });
      return row.id;
    }
    case "INTEREST": {
      // `cash-interest`: the DIVIDEND arm above with no instrument —
      // including its zero-means-no-leg withholding normalisation: a
      // source that spells the tax out as `0` has no withholding leg.
      const row = await ctx.writes.recordInterest({
        ...common,
        amount: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        cashAccountId: write.cashAccountId,
        ...cashLeg,
        ...(write.withholdingAmount === null || !write.withholdingAmount.greaterThan(0)
          ? {}
          : {
              withholding: { amount: write.withholdingAmount },
            }),
      });
      return row.id;
    }
    case "FEE": {
      // `portfolio-cash`: the WITHDRAWAL arm above plus an optional
      // instrument reference — `null` (no reference stated) is omitted.
      const row = await ctx.writes.recordFee({
        ...common,
        amount: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        cashAccountId: write.cashAccountId,
        ...cashLeg,
        ...(write.instrumentId === null ? {} : { instrumentId: write.instrumentId }),
      });
      return row.id;
    }
    case "SHARE_DISTRIBUTION": {
      // The one write in this switch that passes **no**
      // `cashAccountId`: this kind moves no money, `recordShareDistribution`
      // has no field for one, and the database refuses a row that names an
      // account for it. `amount` is the market value the source supplied.
      const row = await ctx.writes.recordShareDistribution({
        ...common,
        instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
        quantity: requireValue(write.quantity, "quantity", write.kind),
        marketValue: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        ...(write.fxRateUserInput === null ? {} : { fxRateUserInput: write.fxRateUserInput }),
      });
      return row.id;
    }
    case "BUY":
    case "SELL": {
      if (write.settlementInstrumentId !== null) {
        // FR-66/AC52's asset-settled acquisition: the principal leg is paid in
        // an asset, so it names **no** cash account at all and carries no
        // `txnCurrency` — `transaction_currency_xor_settlement_instrument` and
        // `transaction_settled_principal_has_no_cash_account` are the two
        // database statements of the same fact. `plan` rejects the row when the
        // settlement asset does not resolve, so reaching here with one means it
        // did (`SETTLEMENT_INSTRUMENT_NOT_RESOLVED`).
        const settled = await ctx.writes.recordSettledBuy({
          ...common,
          instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
          quantity: requireValue(write.quantity, "quantity", write.kind),
          settlement: {
            instrumentId: write.settlementInstrumentId,
            amount: requireValue(write.settlementAmount, "settlementAmount", write.kind),
            ...(write.settlementFxRateUserInput === null
              ? {}
              : { fxRateUserInput: write.settlementFxRateUserInput }),
          },
          ...feeLegOf(write),
        });
        return settled.id;
      }
      const params = {
        ...common,
        instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
        quantity: requireValue(write.quantity, "quantity", write.kind),
        unitPrice: requireValue(write.unitPrice, "unitPrice", write.kind),
        txnCurrency: write.currency,
        cashAccountId: write.cashAccountId,
        // A foreign-currency trade (`write.cashCurrency` non-`null`): the D4/
        // L11 path (`#resolveCashLeg`) derives the settled EUR amount as
        // `gross x fxRate` from these two, and refuses a `cashAmount` alongside
        // them — none is sent here, matching that. Absent on the ordinary
        // same-currency trade, exactly like the `fee` leg below.
        ...cashLeg,
        // OD-2(a): one cost leg, or none at all. `plan` has already rejected a
        // negative figure, and a zero one emits no leg — the write service
        // requires a fee amount to be strictly positive. The withholding
        // branch above answers zero the same way, and did not before the zero-cost-cell rule.
        //
        // FR-227: the leg is now *itemised* where the source itemised it. The
        // total stays `write.feeAmount` — the fold survives, bit-identically,
        // so no pre-cycle `fee_amount` moves — and the components ride beside
        // it. `costComponentsOf` is where a zero figure becomes an **absent**
        // component: a fee of 7,14 with a tax of 0,00 is a broker fee of 7,14
        // and no tax at all, never a tax of zero (FR-213), and the components
        // must still sum to the total exactly or the write service refuses.
        //
        // `currency` and `cashAccountId` were sent here until the legs' own columns were dropped.
        // A cost is denominated by the settling account (L5), so the leg names
        // neither: `FeeInput` is a figure, or a breakdown, and nothing else.
        ...feeLegOf(write),
      };
      const row =
        write.kind === "BUY"
          ? await ctx.writes.recordBuy(params)
          : await ctx.writes.recordSell(params);
      return row.id;
    }
    case "DRIP": {
      // Reinvestment pass 2. The source's id comes from what **this run wrote** at the
      // source's file position when the source is a row of this file, and from
      // what `plan` matched when the destination already held it. The two agree
      // by construction — `plan` pre-allocated the id `writeOne` then wrote —
      // and preferring the written one is what makes that agreement a checked
      // fact rather than an assumption.
      const written =
        write.sourceRowPosition === null
          ? undefined
          : writtenIdByPosition.get(write.sourceRowPosition);
      const row = await ctx.writes.recordDrip({
        ...common,
        instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
        sourceDividendId: requireValue(
          written ?? write.sourceDividendId,
          "sourceDividendId",
          write.kind,
        ),
        quantity: requireValue(write.quantity, "quantity", write.kind),
        unitPrice: requireValue(write.unitPrice, "unitPrice", write.kind),
        txnCurrency: write.currency,
        cashAccountId: write.cashAccountId,
        ...cashLeg,
        ...feeLegOf(write),
      });
      return row.id;
    }
    case "TRANSFER_OUT": {
      // `security-transfer` (FR-586). **One call writes the pair**: the
      // source leg here and, when the user named a destination, its linked
      // target leg there — inside the same `batch.row` savepoint as every
      // other row, so the two commit or roll back together and a lone target
      // cannot exist. Like a distribution, no cash account is sent: the kind
      // moves no money. The fingerprint rides the source leg only, so a
      // retried or continued apply skips the source `ALREADY_IMPORTED` and
      // never reaches the target, and a concurrent second import loses on the
      // source's unique index before any target is written.
      //
      // A per-row-destination file states the target as a row of its own:
      // its id, labels and carried fingerprint ride along, and are
      // written on the target leg only.
      const targetRow = write.transferTargetRow;
      const row = await ctx.writes.recordTransferOut({
        ...common,
        instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
        quantity: requireValue(write.quantity, "quantity", write.kind),
        marketValue: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        ...(write.fxRateUserInput === null ? {} : { fxRateUserInput: write.fxRateUserInput }),
        ...(write.transferTargetPortfolioId === null
          ? {}
          : { destinationPortfolioId: write.transferTargetPortfolioId }),
        ...(targetRow === null
          ? {}
          : {
              targetId: targetRow.id,
              ...(targetRow.note === null ? {} : { targetNote: targetRow.note }),
              ...(targetRow.reference === null ? {} : { targetReference: targetRow.reference }),
              ...(targetRow.importFingerprint === null
                ? {}
                : { targetImportFingerprint: targetRow.importFingerprint }),
            }),
      });
      return row.id;
    }
    case "TRANSFER_IN": {
      // `security-transfer` ND-2 (a): a **lone** target leg — its source
      // portfolio was deleted — carried back in with the cost it arrived with.
      // The one target leg this importer writes itself, and the only caller
      // of `recordStandaloneTransferIn`. Like the source leg, no cash account.
      const row = await ctx.writes.recordStandaloneTransferIn({
        ...common,
        instrumentId: requireValue(write.instrumentId, "instrumentId", write.kind),
        quantity: requireValue(write.quantity, "quantity", write.kind),
        marketValue: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        ...(write.fxRateUserInput === null ? {} : { fxRateUserInput: write.fxRateUserInput }),
        carriedCost: requireValue(write.transferCost, "transferCost", write.kind),
      });
      return row.id;
    }
    case "CURRENCY_EXCHANGE": {
      // FR-59/AC48. `exchangeRate` is the whole input: the ledger derives
      // `target_amount = amount × exchangeRate` and has no parameter that
      // overrides it, which is GATE-0b's verdict (0/5 disagreed — no
      // `targetAmount?` is added to `RecordCurrencyExchangeParams`). The file's
      // own stated target figure is verified in `validate` and never written.
      const row = await ctx.writes.recordCurrencyExchange({
        ...common,
        amount: requireValue(write.amount, "amount", write.kind),
        currency: write.currency,
        targetCurrency: requireValue(write.targetCurrency, "targetCurrency", write.kind),
        exchangeRate: requireValue(write.exchangeRate, "exchangeRate", write.kind),
        cashAccountId: write.cashAccountId,
        targetCashAccountId: requireValue(
          write.targetCashAccountId,
          "targetCashAccountId",
          write.kind,
        ),
        ...(write.fxRateUserInput === null ? {} : { fxRateUserInput: write.fxRateUserInput }),
        ...feeLegOf(write),
      });
      return row.id;
    }
    default: {
      const exhaustive: never = write.kind;
      return exhaustive;
    }
  }
}

/**
 * The catalogue half of the write path. **Nothing here, and nothing anywhere in
 * this package, deletes an instrument** — see this module's header on F-B
 * for the whole argument, and on why a failed import leaves its
 * already-created instruments in place rather than tidying them away.
 */
async function writeInstrument(db: Db, write: PlannedInstrumentWrite): Promise<string> {
  if (write.isin !== null && write.exchangeMic !== null) {
    if (write.kind !== "SHARE" && write.kind !== "ETF" && write.kind !== "FUND") {
      throw new Error(`an identifier-keyed instrument cannot be created with kind ${write.kind}`);
    }
    const row = await createInstrumentByIsin(db, {
      kind: write.kind,
      isin: write.isin,
      exchangeMic: write.exchangeMic,
      listingCurrency: write.listingCurrency,
      displayName: write.displayName,
      ...(write.symbol === null ? {} : { symbol: write.symbol }),
    });
    return row.id;
  }
  if (write.symbol === null) {
    throw new Error("an instrument write carries neither an identifier plus exchange nor a ticker");
  }
  if (write.kind !== "CRYPTO" && write.kind !== "INDEX") {
    throw new Error(`a ticker-keyed instrument cannot be created with kind ${write.kind}`);
  }
  const row = await createInstrumentBySymbol(db, {
    kind: write.kind,
    symbol: write.symbol,
    listingCurrency: write.listingCurrency,
    displayName: write.displayName,
  });
  return row.id;
}

/**
 * The duplicate-fingerprint backstop, and the one place a thrown error becomes a **skip** rather
 * than a failure.
 *
 * `transaction_import_fingerprint_key` is a partial unique index on
 * `(tenant_id, portfolio_id, import_fingerprint)`. A `23505` on it means some
 * other run wrote this exact source row into this exact destination between
 * `plan`'s existence check and this `INSERT` — which is what
 * `SKIP / ALREADY_IMPORTED` means. Matched by constraint **name**: a `23505`
 * on `transaction_tenant_id_seq_key`, say, is a different fact entirely and is
 * re-thrown as an ordinary apply failure rather than quietly reported as a row
 * that was already imported.
 *
 * `InstrumentAlreadyExistsError` is the catalogue's own equivalent — the
 * dedupe rule `plan` already consulted, re-decided by the database because two
 * runs can reach it at once — and it maps to the skip code `plan` uses for
 * exactly that fact.
 */
function failureOutcome(at: SourceRowRef, error: unknown): AppliedRowOutcome {
  const pg = extractPostgresError(error);
  if (pg?.sqlstate === "23505" && pg.constraintName === IMPORT_FINGERPRINT_CONSTRAINT) {
    return {
      at,
      outcome: "SKIP",
      reason: "ALREADY_IMPORTED",
      message:
        "another run wrote this exact row into this exact destination while this import was running, " +
        "so it is not written twice",
    };
  }
  if (error instanceof InstrumentAlreadyExistsError) {
    return {
      at,
      outcome: "SKIP",
      reason: "INSTRUMENT_ALREADY_EXISTS",
      message: `the catalogue already holds this instrument: ${error.message}`,
    };
  }
  // F-A. These two are the only ledger refusals a **correct, unmodified**
  // export can hit, and the ledger's own message — accurate as a
  // write-boundary diagnostic — reads, to someone restoring a backup, as "my
  // file is broken". It is not: the row is
  // exactly as it was written, and it is the *calendar* that moved under it.
  // The floor is `now - BACKFILL_FLOOR_YEARS` (25 years,
  // `market/ingestion/src/backfill-window.ts`) and the ceiling `today + 1`, so
  // a file that restored cleanly last year can have rows past the floor this
  // year. The ledger message is kept — it names the floor date and the year
  // count, and duplicating either here would be a second copy of a constant —
  // and the clause the restoring user needs is added to it.
  //
  // This is a **per-row** reject like every other entry below: the rest of the
  // file imports, and a re-run after removing or re-dating those rows imports
  // them too (verified in `apply.kerdial.integration.test.ts`).
  if (error instanceof TradeDateTooOldError || error instanceof TradeDateInFutureError) {
    return {
      at,
      outcome: "REJECT",
      reason: "APPLY_FAILED",
      message:
        `the ledger refused this row (${error.name}): ${error.message} ` +
        "This row is not corrupt: only its date is outside the window this application can price, " +
        "so the rest of the file is imported and this row can be re-dated and imported on its own.",
      errorName: error.name,
    };
  }
  // An error's own `message` is echoed **only** when this pipeline
  // recognises the error. Everything else gets a message this file authored.
  if (isRowSafeLedgerError(error)) {
    return {
      at,
      outcome: "REJECT",
      reason: "APPLY_FAILED",
      message: `the ledger refused this row (${error.name}): ${error.message}`,
      errorName: error.name,
    };
  }
  if (pg !== undefined) {
    const explanation = SQLSTATE_EXPLANATIONS[pg.sqlstate];
    return {
      at,
      outcome: "REJECT",
      reason: "APPLY_FAILED",
      message:
        explanation === undefined
          ? `the ledger refused this row: the database rejected it (SQLSTATE ${pg.sqlstate})`
          : `the ledger refused this row: ${explanation} (SQLSTATE ${pg.sqlstate})`,
      errorName: `SQLSTATE_${pg.sqlstate}`,
    };
  }
  // The message below promises a log line, so the log line is emitted here
  // rather than left to a caller. `applyImport`'s own `catch` lets the
  // error go out of scope and nothing is re-thrown, so
  // `ProblemJsonExceptionFilter` never sees this error either — before this,
  // the promise was simply false.
  rootLogger().error(
    `an import row was refused by the ledger with a failure this pipeline cannot describe (file line ${String(at.line)})`,
    { error: loggableErrorDetail(error) },
  );
  return {
    at,
    outcome: "REJECT",
    reason: "APPLY_FAILED",
    message:
      "the ledger refused this row, and the refusal is not one this import can describe; " +
      "the server log records it against this request and this row's line number",
    errorName: null,
  };
}

/**
 * This pipeline's own `loggableErrorDetail` was lifted verbatim
 * into `@kerdial/platform-logging`, which is where FR-33 is stated and where
 * the API's exception filter now reads it from too. The behaviour is unchanged
 * — same class name, same withheld sentinel, same 300-character truncation —
 * but the reasoning about `DrizzleQueryError` now lives in one place instead of
 * being rediscovered per call site, which is how the filter came to warn about
 * this hazard while logging it.
 */

/**
 * The ledger errors whose own `message` may be repeated back to the caller.
 *
 * **This is an allowlist because the field it feeds is
 * `ImportRowOutcomeResponse.message`, which ships inside a `200 OK` body and
 * therefore never passes `ProblemJsonExceptionFilter`.** The previous code
 * echoed `error.message` for *any* `Error`, and `drizzle-orm@0.45.2` wraps
 * every failed query in a `DrizzleQueryError` whose message is
 * `` `Failed query: ${query}\nparams: ${params}` `` — so the filter's own
 * stated hazard ("a `DrizzleQueryError` carries the failed query's bound
 * `parameters`, which for any write path is exactly the monetary values FR-33
 * forbids in output") reached the wire by going *around* the filter rather than
 * through it. `TransactionWriteService` re-throws anything it does not
 * recognise, and `recomputeAndInvalidate` replays the whole portfolio, so the
 * parameters in question are not even limited to the row being imported.
 *
 * The list is the 23 classes `api/src/transactions/write-error.mapper.ts`
 * recognises — enumerated by reading that file's own import block, which is the
 * command to re-run when this needs checking (`sed -n '1,30p'` over it) —
 * **minus** the five an import cannot reach because it only ever creates
 * (`TransactionNotFoundError`, `TransactionCashLegNotAddableError`,
 * `TransactionGrossAmountNotEditableError`,
 * `TransactionPortfolioNotEditableError`,
 * `TransactionUnitPriceNotEditableError`), **plus**
 * {@link PortfolioVanishedDuringRecomputeError}, which that mapper does not
 * handle but the post-write recompute can raise, and
 * {@link InstrumentAlreadyExistsError}, which {@link failureOutcome} answers as
 * a skip before reaching here and is listed so that a change to that branch
 * cannot turn it into a leak. Twenty entries. Every message in it is one this
 * codebase wrote.
 *
 * ## What this list does **not** cover, and why it still does not
 *
 * The paragraph above enumerates *classes the mapper names*. That is not the
 * same set as *classes a row can throw*, and this is the correction: the write
 * service's own argument assertions throw a bare `TypeError`, from nine sites
 * (`grep -n "throw new TypeError" ledger/src/transaction-write-service.ts` —
 * that is the command to re-run, and it is a different command from the one
 * above, which is the whole point). One of them was reachable from an ordinary
 * export until the zero-cost-cell rule normalised a zero withholding here, and the others stay
 * reachable in principle for any internal caller that hands this loop a value
 * the DTO layer would have refused.
 *
 * `TypeError` is nevertheless **deliberately absent** from the list. It is not
 * a class this codebase owns: it is also what V8 throws for a property read on
 * `undefined` anywhere beneath `record*`, and what a dependency throws for its
 * own argument checks, so allow-listing it would be allow-listing "any message
 * from anyone" under a name that looks specific. The narrower repair belongs in
 * `ledger`, where `TransactionAmountNotPositiveError` already exists for exactly
 * this — and it is not made here, because turning a `500` into a `400` on every
 * direct caller of nine assertions is a `ledger` decision, not an importer one.
 *
 * **That repair is done**. All nine sites now throw
 * {@link TransactionArgumentError} — a class this codebase owns — with
 * {@link TransactionAmountNotPositiveError} as its one specialisation, and
 * both are on the list below. `grep -c "throw new TypeError"
 * ledger/src/transaction-write-service.ts` is **0**; that is the command to
 * re-run rather than trusting this paragraph.
 *
 * `TypeError` remains deliberately absent, for the reason two paragraphs up:
 * the repair gave these nine rejections a name, it did not make `TypeError`
 * a class this codebase owns.
 *
 * So being incomplete stays safe by construction — an omitted class loses its
 * message and gets the generic text, it never leaks one — and the cost of that
 * safety is now paid rather than waved away: the generic branch emits a real
 * log line carrying the class and (bounded, and minus a query wrapper's bound
 * parameters) the message, so an unlisted class is diagnosable by an operator
 * instead of silently discarded. See {@link loggableErrorDetail}.
 */
const ROW_SAFE_LEDGER_ERRORS = [
  CashAccountArchivedError,
  CashAccountCurrencyMismatchError,
  CashAccountNameAlreadyExistsError,
  // FR-227: a cost breakdown that does not add up, or one on a row that names
  // no settling account. Unreachable by construction from this package — the
  // components are derived from the same two cells the total is folded from —
  // and listed anyway, because its message names the field and the arithmetic,
  // which is exactly what a user staring at one rejected row needs. An
  // unlisted class would lose that and get the generic text.
  CostComponentsInvalidError,
  CashAccountNotAllowedError,
  CashAccountNotFoundError,
  CashAccountRequiredError,
  CryptoRateUnavailableError,
  FxRateUnavailableError,
  InstrumentAlreadyExistsError,
  InstrumentNotFoundError,
  InsufficientQuantityError,
  InvalidDripSourceError,
  InvalidSettlementAssetError,
  OverSellError,
  PortfolioVanishedDuringRecomputeError,
  PostingExpansionError,
  // Both are **handled above**, by their own branch, which adds F-A's "this row
  // is not corrupt" clause to the ledger's message. Listed here anyway so this
  // set stays the complete answer to "which ledger errors are row-safe": a
  // refactor that drops that branch falls back to the generic echo, which is a
  // worse message rather than an unnamed failure.
  TradeDateInFutureError,
  TradeDateTooOldError,
  TransactionAmountNotPositiveError,
  // The class the nine `TypeError` sites became. This is the
  // entry the paragraph above said could not safely exist yet: a class this
  // codebase owns, raised only by `ledger`'s own explicit assertions about a
  // caller-supplied value, with a message that names the argument and carries
  // no SQL and no bound parameters. `TypeError` itself stays **absent** — a
  // property read on `undefined` beneath `record*` is still a `TypeError`, and
  // still gets the generic text plus a log line.
  TransactionArgumentError,
  TransactionPortfolioNotFoundError,
  TransactionSelfSettledError,
  // `security-transfer`: a source-leg transfer's two own refusals. Both
  // messages name only the portfolio id this import itself chose, never a
  // figure. `NotFound` is reachable when the named destination is deleted
  // between the plan and this write; `IsSource` is refused at plan time and
  // listed so that a change there degrades to this message, not the generic.
  TransferDestinationIsSourceError,
  TransferDestinationNotFoundError,
] as const;

function isRowSafeLedgerError(error: unknown): error is Error {
  return ROW_SAFE_LEDGER_ERRORS.some((candidate) => error instanceof candidate);
}

/**
 * What to tell the user about a row the *database* refused, keyed by the
 * SQLSTATE the driver reported and nothing else.
 *
 * Deliberately not the driver's own message, and deliberately not the
 * constraint name: `ProblemJsonExceptionFilter` already decided that a
 * constraint name teaches a client "the schema's internal shape" and logs it
 * instead of returning it, and this path answers to the same rule. A SQLSTATE
 * is neither — it is the SQL standard's own five-character class code, the
 * same for every Postgres schema in the world — and including it is what makes
 * an unrecognised failure reportable by a user who cannot see the log.
 *
 * `22003` and `23503` are the two a plain CSV could actually reach (the
 * recorded reproductions: a quantity cell of 10^20, and an assets row naming a
 * well-formed currency code that is not one of the 155 the reference table
 * holds). The first is now refused at `validate` before any write — see
 * `formats/portfolio-performance/index.ts`'s `QUANTITY_MAX_INTEGER_DIGITS` —
 * and is kept here anyway, because this table exists for whatever reaches it,
 * not for the two cases someone happened to find.
 */
const SQLSTATE_EXPLANATIONS: Readonly<Record<string, string>> = {
  "22003": "a number in this row is larger than the ledger can store",
  "22007": "a date or time in this row is not one the ledger can read",
  "22P02": "a value in this row is not in a form the ledger can read",
  "23502": "this row leaves empty a field the ledger requires",
  "23503":
    "this row names something the ledger does not have — most often a currency code that is well formed but is not one of the codes it knows",
  "23505": "this row duplicates one the ledger already holds",
  "23514": "a value in this row is outside the range the ledger accepts",
  "40001":
    "another write touching the same portfolio was in flight; re-running the import retries this row",
  "40P01":
    "another write touching the same portfolio was in flight; re-running the import retries this row",
};

/** The partial unique index migration `0042` creates. Named here, matched by name — never by SQLSTATE alone. */
const IMPORT_FINGERPRINT_CONSTRAINT = "transaction_import_fingerprint_key";

/**
 * The single `reduce`, closed by a `never` — the same shape `plan`'s own
 * `summarize` has, over the same three outcomes, so a dry-run summary and a
 * real one are comparable field by field.
 */
function summarize(outcomes: readonly AppliedRowOutcome[]): ImportSummary {
  const byReason: Record<string, number> = {};
  let imported = 0;
  let skipped = 0;
  let rejected = 0;
  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "IMPORT":
        imported += 1;
        break;
      case "SKIP":
        skipped += 1;
        byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1;
        break;
      case "REJECT":
        rejected += 1;
        byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1;
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  return { imported, skipped, rejected, byReason };
}

function countReason(outcomes: readonly AppliedRowOutcome[], reason: ImportRejectReason): number {
  return outcomes.filter((outcome) => outcome.outcome === "REJECT" && outcome.reason === reason)
    .length;
}

/**
 * A transaction write with no destination is a request that could not have
 * been formed, not a row that failed — `planImport` refuses it before any of
 * this runs, so reaching here means the plan and the context disagree.
 */
function portfolioIdOf(ctx: ApplyContext, write: PlannedTransactionWrite): string {
  // The row's own portfolio when it has one, the request's
  // single destination when it does not — which is every Portfolio-Performance
  // row, so nothing about that path moves.
  const portfolioId = write.portfolioId ?? ctx.destination?.portfolioId ?? "";
  if (portfolioId === "") {
    throw new Error("a transaction row cannot be written without a destination portfolio");
  }
  return portfolioId;
}

function requireValue<T>(value: T | null, field: string, kind: string): T {
  if (value === null) {
    throw new Error(`a ${kind} row reached the write path with no ${field}`);
  }
  return value;
}
