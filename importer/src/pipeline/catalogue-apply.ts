import {
  CashAccountPortfolioCapExceededError,
  InstrumentIconBoundsError,
  InstrumentIconTenantCapExceededError,
  ManualPricePointTenantCapExceededError,
  PortfolioTenantCapExceededError,
  ProviderMappingAlreadyExistsError,
  WatchlistTenantCapExceededError,
  addWatchlistItem,
  correctProviderMapping,
  createCashAccount,
  createInstrumentByIsin,
  createInstrumentBySymbol,
  createInstrumentScpi,
  createPortfolio,
  createProviderMapping,
  setCashAccountArchived,
  setInstrumentIcon,
  setPortfolioArchived,
  setPortfolioIcon,
  updateInstrumentClassification,
  updateInstrumentDetails,
  updateInstrumentIdentity,
  updateInstrumentScpiAttributes,
  updatePortfolio,
  upsertManualPricePoint,
  upsertUserFxRate,
  type InstrumentRecord,
} from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";

import type { CatalogueEntryRef } from "../formats/kerdial-json/index.js";
import {
  countable,
  entityCountOf,
  summarize,
  type CataloguePlan,
  type CatalogueRefusal,
  type CatalogueRejectReason,
  type CatalogueSkipReason,
  type CatalogueSummary,
  type CatalogueWarning,
  type PlannedCatalogueFxRateWrite,
  type PlannedCatalogueInstrumentWrite,
  type PlannedCataloguePortfolioWrite,
  type PlannedCatalogueWrite,
} from "./catalogue-plan.js";
import type { Clock } from "./ports.js";

/**
 * `applyCatalogue` — the write half of the catalogue pipeline.
 *
 * **Everything in this directory is scanned by `pnpm import-vocabulary-gate`,
 * comments included; the gate strips nothing.** No source column name and no
 * type label from any export format may appear in this file, in code or in
 * prose.
 *
 * ## The shape: the shipped `ledger` services, called by name
 *
 * Every write below is one call to the function the manual path already uses —
 * SD-15's "through the existing edit paths rather than a second write path",
 * which is what makes every validation, every cap and every grant on those
 * columns apply to an imported value for free. There is no raw `INSERT` in this
 * file, and no new write function anywhere behind it.
 *
 * **The parameter shapes were re-read at implementation time, not trusted from
 * the earlier citation** (which said in as many words that only the names and
 * line numbers were read). Five differences were found and are handled here
 * rather than downstream — each is stated where it bites:
 *
 *  - `createPortfolio` takes the **icon at create time**, so a new portfolio and
 *    its icon are one call and one transaction, not two.
 *  - `updateInstrumentDetails` writes only `displayName` and `status`, and
 *    `updateInstrumentIdentity` only `displayName` and `figi` — so a rename and
 *    a first identifier go through the second (one transaction for both) and a
 *    status through the first.
 *  - `addWatchlistItem` is **already** an `INSERT … ON CONFLICT DO UPDATE`
 *    (MEASURED), so it covers the create *and* the merge, and
 *    `updateWatchlistItem` — which the original write table also names — is deliberately
 *    not called: it would add a second path with a not-found error for a row
 *    this one creates.
 *  - `correctProviderMapping` **discards the instrument's whole automated price
 *    series**, so it is planned only when the stored mapping genuinely differs
 *    (see `catalogue-plan.ts`'s `planProviderMapping`).
 *  - `createInstrumentBySymbol` carries no classification fields at all, so a
 *    symbol-keyed instrument's sector/industry are a residual
 *    `updateInstrumentClassification` the plan already computed.
 *
 * ## Transactions, chunks, and the one place this file departs from the original sizing
 *
 * The original sizing was "one `withTenant` transaction per 200 draft entities".
 * **MEASURED: that is not reachable through the shipped services, and the
 * difference is in the safe direction.** Every tenant-scoped service above —
 * `createPortfolio`, `createCashAccount`, `setPortfolioIcon`, `setInstrumentIcon`,
 * `upsertManualPricePoint`, `addWatchlistItem`, `upsertUserFxRate` — takes a
 * `Db` and opens its **own** `withTenant` transaction internally (`withTenant`'s
 * signature is `(db: Db, …)`, and a `Tx` is not assignable to `Db`). Wrapping
 * 200 of them in one transaction would mean either passing a handle they cannot
 * accept or re-implementing their writes, and re-implementing them is precisely
 * what KD11/SD-15 forbid.
 *
 * So each write commits on its own, which satisfies the
 * bounded-transaction rule **more** strictly than a 200-entity transaction would
 * (nothing here holds a lock across entities, and a slow document cannot pin one
 * open), and `applyChunkEntities` keeps a real, measurable job: it is the
 * **deadline and resumability unit**. The budget is checked at the head of each
 * chunk and again before each entry in it, so an entry's *own* writes — an
 * instrument and its icon, its provider mapping, its watchlist row — are
 * attempted whole, and the remedy stays "re-run the file and it applies the
 * remainder", at entry granularity.
 * {@link CatalogueImportResult.chunksApplied} reports it, so the limit is proved
 * to bind by measuring an effect at two values (FR-539) rather than by asserting
 * its constant.
 *
 * ## The two loops the chunk does **not** bound (H1)
 *
 * "Checked once per chunk, never inside one" was true of the first
 * implementation and it was a hole, found by a security review.
 * A chunk is a budget in *entities*, and an entry heavier than the whole budget
 * is admitted as a chunk of its own (see the admission loop below) — so a single
 * instrument entry carrying 500 000 `manualPrices`, which the schema and the
 * 32 MiB file ceiling both admit, was 500 000 sequential `withTenant`
 * transactions with **no clock read between them**. The socket closed at the
 * handler timeout; the promise kept writing for minutes, and
 * `AdmissionBoundInterceptor` releases its in-flight slot only in `finalize`.
 *
 * So the budget is checked **per element** in the two loops whose length the
 * *document* chooses — `manualPrices` and `cashAccounts` — as well as per entry
 * and at the chunk head. An element the clock cut off is a
 * {@link CatalogueRefusal} on the entry naming the remainder, not a failed
 * entry: what was written stays written and every ledger call here is an
 * upsert, so re-running the file writes exactly the rest.
 *
 * **The bound that follows, stated exactly (F1).** The first
 * version of this paragraph claimed "one write past the deadline", and that was
 * false while the clock was read at the chunk head and inside the two element
 * loops only: an entry's writes outside those loops — at most seven ledger
 * calls for an instrument (the create, the three update calls, the provider
 * mapping, the icon, the watchlist row) and two for a portfolio — were
 * unconditional, so a chunk of 200 such entries was 200 entries' worth of
 * writes past the deadline, not one. With the per-entry read now at the head of
 * the chunk loop, the true bound is **one entry's non-loop ledger calls plus
 * one element write**: the check before an entry admits it whole, and the check
 * before an element admits at most one more. Each of those calls is a single
 * `withTenant` upsert of the order of `upsertManualPricePoint`'s cost
 * (MEASURED, 2026-09-25: 3,37–3,58 ms against a real Postgres 17 container,
 * four batches of 2 000 over rows 0→8 000), so the overrun is tens of
 * milliseconds rather than the minutes H1 found.
 *
 * **The reason code is `APPLY_NOT_ATTEMPTED` and not a new one.** The closed
 * vocabulary is a taxonomy of *remedies*, and this remedy is
 * {@link notAttempted}'s own — re-run the file — reached inside an entry rather
 * than before one. A distinct code would have bought a second French sentence
 * saying the same thing.
 *
 * **`manualPrices` keeps the tenant cap as its per-entry schema bound**
 * (`MANUAL_PRICE_POINT_TENANT_ROW_CAP`, 500 000) rather than gaining a tighter
 * one, and that is a decision with an argument, not an omission: every other
 * array bound in `kerdial-json/schema.ts` mirrors a **ledger** cap, so a
 * per-entry ceiling below the ledger's would let this product store a state it
 * refuses to re-import — KD4.1's "never emit a file it cannot take back" broken
 * for the one case a backup exists for. What an uncapped entry costs is
 * *convergence*, and that is bounded and reported rather than silent: ~7 100
 * points per 25 s request at the rate above, and the price loop restarts at the
 * head of the entry on every re-run. Closing that properly is a resumable
 * within-entry cursor, or a per-instrument cap in `manual-price-service.ts` with
 * its French copy and its `api-limits` mirror — a product change, not a security
 * fix.
 *
 * ## Idempotent by construction (FR-537)
 *
 * Every call above is an upsert or a create-if-absent, and the plan stage
 * already turned "the destination agrees" into `CATALOGUE_ENTRY_UNCHANGED`. So
 * a partial run is safe, a re-run applies exactly the remainder, and the JSON
 * route needs no fingerprint channel — which is the property FR-537 states and
 * this cycle relies on rather than a second idempotency mechanism.
 *
 * ## What this module never does: delete an instrument (F-E)
 *
 * A catalogue entry can create an instrument with **no transaction behind it**,
 * so the "harmless over-created row" case this import produces is more common
 * than the transaction path's — and the tempting cleanup, when a later part of
 * the same entry fails, is to delete it. **Decided, unchanged from csv-import's
 * own F-B: the import never deletes an instrument.** An over-created shared
 * instrument is harmless reference data; a delete path is not.
 * `TRANSACTION_FK_HANDLING`'s `NO_DELETE_PATH` entry is "a claim about the
 * product, not about the database", and a concurrent delete would turn an
 * ordinary transaction write into an unmapped foreign-key failure.
 *
 * The decision is **weaker than csv-import's was and therefore tested**: an
 * instrument delete now exists in `ledger` (MEASURED,
 * `ledger/src/instrument-service.ts`, beside `InstrumentDeleteBlockedError`), so
 * this is no longer "the function does not exist" but "this package does not
 * call it". `catalogue-apply.no-delete.test.ts` scans this directory's own
 * sources for that call and asserts zero hits — and, because that scan strips
 * nothing, this paragraph may not spell the name out either.
 *
 * ## FR-557's enrolment is **returned**, never called (KD10)
 *
 * A JSON-created instrument has no transaction behind it, so nothing enrols it
 * in the backfill machinery — `writeInstrument` never did, and
 * `reconcilePendingInstrumentBackfills` only sweeps instruments that already
 * have a state row. This function therefore returns
 * {@link CatalogueImportResult.enrolmentCandidates}, and `api`'s controller
 * (EI-27) enqueues them **after** the writes have committed. It cannot happen
 * here for two independent reasons, each sufficient: `importer` may not import
 * any `market/*` package (`importer-no-market`, an `error`-severity `depcruise`
 * rule), and the bounded-transaction rule forbids a queue operation inside an RLS
 * transaction.
 */

/** One created instrument, for the caller's FR-557 enrolment. `kind` is what `providerKeyForBackfill` routes on. */
export interface CatalogueEnrolmentCandidate {
  readonly id: string;
  readonly kind: InstrumentRecord["kind"];
}

/** One entry's outcome after the write attempt. The plan's three outcomes, unchanged; only `IMPORT` and `REJECT` carry new information. */
export type AppliedCatalogueOutcome =
  | {
      readonly at: CatalogueEntryRef;
      readonly outcome: "IMPORT";
      /** The portfolio's or instrument's id; `null` for a section whose row has no id of its own. */
      readonly writtenId: string | null;
      readonly refusals: readonly CatalogueRefusal[];
      /** The plan's own warnings, carried through unchanged — the confirm reports what the dry run did. */
      readonly warnings: readonly CatalogueWarning[];
    }
  | {
      readonly at: CatalogueEntryRef;
      readonly outcome: "SKIP";
      readonly reason: CatalogueSkipReason;
      readonly message: string;
    }
  | {
      readonly at: CatalogueEntryRef;
      readonly outcome: "REJECT";
      readonly reason: CatalogueRejectReason;
      readonly message: string;
      /** The ledger error's own class name when the write was attempted and refused; `null` for everything the plan decided. */
      readonly errorName: string | null;
    };

export interface CatalogueImportResult {
  readonly entryCount: number;
  /** One per plan outcome, in the plan's own order. */
  readonly outcomes: readonly AppliedCatalogueOutcome[];
  readonly summary: CatalogueSummary;
  /** Entries the ledger refused. Non-zero means a dry run's counts and this run's cannot be expected to agree. */
  readonly applyFailed: number;
  /** Entries whose turn never came, because the deadline was reached first. */
  readonly applyNotAttempted: number;
  /** Chunks actually applied — the observable {@link CatalogueApplyContext.chunkEntities} governs. */
  readonly chunksApplied: number;
  /** FR-557/KD10: the instruments this run **created**, for the caller to enrol in the backfill machinery. */
  readonly enrolmentCandidates: readonly CatalogueEnrolmentCandidate[];
}

export interface CatalogueApplyContext {
  readonly db: Db;
  readonly tenantId: string;
  readonly plan: CataloguePlan;
  /** Derived once from the moment the **request** arrived, exactly as `applyImport`'s is. */
  readonly deadlineAt: Date;
  /** Injected for the reason `PlanContext.clock` is: a deadline asserted by reading its constant proves nothing. */
  readonly clock: Clock;
  /** `KerdialJsonLimits.applyChunkEntities`, passed through rather than read from module scope — a tunable that cannot be varied cannot be proved to bind. */
  readonly chunkEntities: number;
}

/** What one entry's writes produced. */
interface EntryResult {
  readonly writtenId: string | null;
  readonly refusals: readonly CatalogueRefusal[];
  readonly created: CatalogueEnrolmentCandidate | null;
}

export async function applyCatalogue(ctx: CatalogueApplyContext): Promise<CatalogueImportResult> {
  // Start from the plan's own outcomes: every SKIP and REJECT it decided is
  // carried through unchanged, so the counts a dry run reported are the counts
  // this run reports for every entry the write path never sees. The IMPORT
  // entries are holes, filled by the loop below.
  const draft: (AppliedCatalogueOutcome | null)[] = ctx.plan.outcomes.map((outcome) => {
    if (outcome.outcome === "IMPORT") return null;
    return outcome.outcome === "REJECT" ? { ...outcome, errorName: null } : outcome;
  });

  const order = ctx.plan.applyOrder;
  const candidates: CatalogueEnrolmentCandidate[] = [];

  const plannedAt = (
    index: number,
  ): {
    at: CatalogueEntryRef;
    write: PlannedCatalogueWrite;
    warnings: readonly CatalogueWarning[];
  } => {
    const planned = ctx.plan.outcomes[index];
    if (planned === undefined || planned.outcome !== "IMPORT") {
      throw new Error(
        `applyOrder names entry ${String(index)}, which the plan did not mark for import`,
      );
    }
    return { at: planned.at, write: planned.write, warnings: planned.warnings };
  };

  let chunksApplied = 0;
  let cursor = 0;
  while (cursor < order.length) {
    // The next chunk: whole entries, up to the entity budget, and **always at
    // least one** — an entry heavier than the whole budget is a chunk of its
    // own rather than an entry nothing ever attempts.
    const chunk: number[] = [];
    let entities = 0;
    while (cursor < order.length) {
      const index = order[cursor]!;
      const size = entityCountOf(plannedAt(index).write);
      if (chunk.length > 0 && entities + size > ctx.chunkEntities) break;
      chunk.push(index);
      entities += size;
      cursor += 1;
    }

    // Checked at the head of the chunk, before anything in it is written — and
    // again per entry below, and per element in the two loops a *document* can
    // make arbitrarily long. See this module's header for the bound the three
    // reads together buy.
    if (pastDeadline(ctx)) {
      for (const index of chunk) draft[index] = notAttempted(plannedAt(index).at);
      continue;
    }
    chunksApplied += 1;

    for (const [position, index] of chunk.entries()) {
      // And once per **entry**, not only at the chunk head (F1):
      // an instrument entry issues up to seven ledger calls outside its price
      // loop and a portfolio two, so a head-only check let a whole chunk of
      // entries' unconditional writes run past the deadline. Same semantics as
      // the head check — an entry not attempted, and every entry behind it in
      // this chunk, is `APPLY_NOT_ATTEMPTED`, decided by one clock read.
      if (pastDeadline(ctx)) {
        for (const remaining of chunk.slice(position)) {
          draft[remaining] = notAttempted(plannedAt(remaining).at);
        }
        break;
      }
      const planned = plannedAt(index);
      try {
        const result = await applyOne(ctx, planned.write);
        if (result.created !== null) candidates.push(result.created);
        draft[index] = {
          at: planned.at,
          outcome: "IMPORT",
          writtenId: result.writtenId,
          refusals: result.refusals,
          warnings: planned.warnings,
        };
      } catch (error) {
        draft[index] = failureOutcome(planned.at, error);
      }
    }
  }

  const outcomes = draft.map((outcome, index) => {
    if (outcome === null) {
      throw new Error(`entry ${String(index)} was marked for import and never attempted`);
    }
    return outcome;
  });

  return {
    entryCount: outcomes.length,
    outcomes,
    summary: summarize(outcomes.map(countableApplied)),
    applyFailed: outcomes.filter(
      (outcome) => outcome.outcome === "REJECT" && outcome.reason === "APPLY_FAILED",
    ).length,
    applyNotAttempted: outcomes.filter(
      (outcome) => outcome.outcome === "REJECT" && outcome.reason === "APPLY_NOT_ATTEMPTED",
    ).length,
    chunksApplied,
    enrolmentCandidates: candidates,
  };
}

/** Projects an applied outcome into the shape `summarize` counts — the plan's own `countable`, over this stage's union. */
function countableApplied(outcome: AppliedCatalogueOutcome): ReturnType<typeof countable> {
  switch (outcome.outcome) {
    case "IMPORT":
      return { outcome: "IMPORT", refusals: outcome.refusals };
    case "SKIP":
      return { outcome: "SKIP", reason: outcome.reason };
    case "REJECT":
      return { outcome: "REJECT", reason: outcome.reason };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/**
 * The one clock read, so the chunk head, the per-entry check and the two
 * per-element loops cannot come to disagree about what "past the deadline"
 * means.
 *
 * Read through {@link CatalogueApplyContext.clock} rather than from
 * `Date.now()` for the reason `PlanContext.clock` exists: a deadline asserted by
 * reading its constant proves nothing, and only an injected clock lets a test
 * put the cut where it wants it.
 */
function pastDeadline(ctx: CatalogueApplyContext): boolean {
  return ctx.clock.now().getTime() >= ctx.deadlineAt.getTime();
}

/**
 * What an element the clock cut off reports (H1) — see this
 * module's header for why the code is `APPLY_NOT_ATTEMPTED` and not a new one.
 *
 * `remaining` counts from the element that was **not attempted**, inclusive, so
 * it is the number a re-run writes rather than the number this run failed at.
 */
function deadlineRefusal(remaining: number, what: string): CatalogueRefusal {
  return {
    reason: "APPLY_NOT_ATTEMPTED",
    message:
      `the time budget for this request ran out inside this entry; ` +
      `${String(remaining)} of its ${what} were not written, and running the same file again ` +
      `writes exactly those`,
  };
}

function notAttempted(at: CatalogueEntryRef): AppliedCatalogueOutcome {
  return {
    at,
    outcome: "REJECT",
    reason: "APPLY_NOT_ATTEMPTED",
    message:
      "the time budget for this request ran out before this entry's turn; what was already written " +
      "stays written, so running the same file again applies exactly the remainder",
    errorName: null,
  };
}

/**
 * The one place a thrown ledger error becomes an entry-level rejection. Only
 * the entity's **own** write reaches here — a nested row's failure is a
 * refusal, decided beside the call that made it.
 *
 * The error's own `message` is never echoed: `errorName` carries the class, and
 * the sentence is this file's.
 */
function failureOutcome(at: CatalogueEntryRef, error: unknown): AppliedCatalogueOutcome {
  const named = error instanceof Error ? error.name : null;
  const reason: CatalogueRejectReason =
    error instanceof PortfolioTenantCapExceededError ? "PORTFOLIO_CAP_EXCEEDED" : "APPLY_FAILED";
  return {
    at,
    outcome: "REJECT",
    reason,
    message:
      reason === "PORTFOLIO_CAP_EXCEEDED"
        ? "this tenant is at its portfolio limit, so this entry was not created"
        : "the ledger refused this entry; what was already written stays written",
    errorName: named,
  };
}

async function applyOne(
  ctx: CatalogueApplyContext,
  write: PlannedCatalogueWrite,
): Promise<EntryResult> {
  switch (write.target) {
    case "PORTFOLIO":
      return applyPortfolio(ctx, write);
    case "INSTRUMENT":
      return applyInstrument(ctx, write);
    case "FX_RATE_USER":
      return applyFxRate(ctx, write);
    default: {
      const exhaustive: never = write;
      return exhaustive;
    }
  }
}

/**
 * `updatePortfolio` and `setPortfolioArchived` answer
 * `undefined` when no row matched: the portfolio the plan matched was deleted
 * before its turn. Thrown so {@link failureOutcome} reports the entry as
 * `APPLY_FAILED` instead of imported.
 */
class MatchedPortfolioGoneError extends Error {
  constructor() {
    super("the portfolio the plan matched no longer exists");
    this.name = "MatchedPortfolioGoneError";
  }
}

async function applyPortfolio(
  ctx: CatalogueApplyContext,
  write: PlannedCataloguePortfolioWrite,
): Promise<EntryResult> {
  const refusals: CatalogueRefusal[] = [...write.refusals];
  let portfolioId = write.portfolioId;

  if (portfolioId === null) {
    // One call, one transaction: `createPortfolio` inserts the icon row itself
    // when it is given one (MEASURED, its own `icon` parameter), so a new
    // portfolio never exists briefly without the icon the file carried.
    //
    // **The create mints its own first account only when this entry lists
    // none** (reversing an earlier ruling now that the initial-account change has added
    // the parameter). The create path otherwise opens one unconditionally
    // (CA-25), and a restore of a portfolio whose accounts are all user-named
    // would then end with one account more than the source tenant had — an
    // empty one, which a user reads as "my backup did not restore cleanly".
    // An entry listing **no** account keeps the default, because a portfolio
    // with zero accounts can receive no transaction at all.
    const created = await createPortfolio(ctx.db, {
      tenantId: ctx.tenantId,
      name: write.name,
      initialCashAccount: write.cashAccounts.length === 0,
      ...write.changes,
      ...(write.icon !== null && { icon: write.icon }),
    });
    portfolioId = created.id;
  } else {
    if (Object.keys(write.changes).length > 0) {
      const updated = await updatePortfolio(ctx.db, {
        tenantId: ctx.tenantId,
        portfolioId,
        ...write.changes,
      });
      if (updated === undefined) throw new MatchedPortfolioGoneError();
    }
    if (write.icon !== null) {
      await setPortfolioIcon(ctx.db, {
        tenantId: ctx.tenantId,
        portfolioId,
        bytes: write.icon.bytes,
        contentType: write.icon.contentType,
        widthPx: write.icon.widthPx,
        heightPx: write.icon.heightPx,
      });
    }
  }
  // `null` = no statement or already in agreement (PA-L6), so no write — the
  // cash-account pattern below. A separate transaction from the create: should
  // it fail, the portfolio exists un-archived, which is visible and harmless.
  if (write.archived !== null) {
    const archived = await setPortfolioArchived(ctx.db, {
      tenantId: ctx.tenantId,
      portfolioId,
      archived: write.archived,
    });
    if (archived === undefined) throw new MatchedPortfolioGoneError();
  }

  for (const [index, account] of write.cashAccounts.entries()) {
    // H1: one of the two loops whose length the *document*
    // chooses — `MAX_CASH_ACCOUNTS_PER_PORTFOLIO` bounds it at plan time, so it
    // is far shorter than the price loop, and it is checked for the same reason:
    // the bound that matters is "one write past the deadline", not "a small
    // number of writes past it".
    if (pastDeadline(ctx)) {
      refusals.push(deadlineRefusal(write.cashAccounts.length - index, "accounts"));
      break;
    }
    try {
      // `cashAccountId` is the plan's own match against an account the
      // destination already has; `null` means "create it". There is no third
      // case any more: the create above no longer mints an account behind this
      // loop's back, so nothing here can collide with one.
      const cashAccountId =
        account.cashAccountId ??
        (
          await createCashAccount(ctx.db, {
            tenantId: ctx.tenantId,
            portfolioId,
            name: account.name,
            currency: account.currency,
          })
        ).id;
      if (account.archived !== null) {
        await setCashAccountArchived(ctx.db, {
          tenantId: ctx.tenantId,
          portfolioId,
          cashAccountId,
          archived: account.archived,
        });
      }
    } catch (error) {
      refusals.push(refusalFor(error, "CASH_ACCOUNT_CAP_EXCEEDED", "this account"));
    }
  }

  return { writtenId: portfolioId, refusals, created: null };
}

async function applyInstrument(
  ctx: CatalogueApplyContext,
  write: PlannedCatalogueInstrumentWrite,
): Promise<EntryResult> {
  const refusals: CatalogueRefusal[] = [...write.refusals];
  let instrumentId = write.instrumentId;
  let created: CatalogueEnrolmentCandidate | null = null;

  if (write.create !== null) {
    const spec = write.create;
    // An SCPI first: unlisted, an ISIN or a symbol or
    // both, its own create path. The two asserts below stay the run-time half
    // for the other five kinds.
    const row =
      spec.kind === "SCPI"
        ? await createInstrumentScpi(ctx.db, {
            ...(spec.isin !== null && { isin: spec.isin }),
            ...(spec.symbol !== null && { symbol: spec.symbol }),
            listingCurrency: spec.listingCurrency,
            displayName: spec.displayName,
            ...(spec.figi !== undefined && { figi: spec.figi }),
            ...(spec.managementCompany !== undefined && {
              managementCompany: spec.managementCompany,
            }),
            ...(spec.subscriptionFeePct !== undefined && {
              subscriptionFeePct: spec.subscriptionFeePct,
            }),
          })
        : spec.isin !== null && spec.exchangeMic !== null
          ? await createInstrumentByIsin(ctx.db, {
              kind: assertIdentifierKind(spec.kind),
              isin: spec.isin,
              exchangeMic: spec.exchangeMic,
              listingCurrency: spec.listingCurrency,
              displayName: spec.displayName,
              ...(spec.symbol !== null && { symbol: spec.symbol }),
              ...(spec.figi !== undefined && { figi: spec.figi }),
              ...(spec.sectorCode !== undefined && { sectorCode: spec.sectorCode }),
              ...(spec.industryLabel !== undefined && { industryLabel: spec.industryLabel }),
            })
          : await createInstrumentBySymbol(ctx.db, {
              kind: assertSymbolKind(spec.kind),
              symbol: requireSymbol(spec.symbol),
              listingCurrency: spec.listingCurrency,
              displayName: spec.displayName,
              ...(spec.figi !== undefined && { figi: spec.figi }),
            });
    instrumentId = row.id;
    // FR-557: a catalogue-created instrument has no transaction behind it, so
    // this is the only record that it needs enrolling. Re-resolved instruments
    // are deliberately **not** candidates — they already exist in the
    // destination with their own state row, and adding them would make every
    // re-import of the same document fan out one queue publish per instrument
    // for nothing.
    created = { id: row.id, kind: row.kind };
  }

  // An instrument that is neither created nor resolved cannot happen — the plan
  // produces exactly one of the two — but the write path must not proceed on a
  // `null` id, and saying so structurally beats trusting the invariant.
  if (instrumentId === null) {
    throw new Error("an instrument write carries neither a destination row nor a creation");
  }

  const {
    displayName,
    figi,
    status,
    sectorCode,
    industryLabel,
    domicileCountry,
    managementCompany,
    subscriptionFeePct,
  } = write.changes;

  // `updateInstrumentIdentity` runs both of its fields in one transaction, so a
  // request naming both never leaves a rename applied against a refused
  // identifier fill.
  if (displayName !== undefined || figi !== undefined) {
    await updateInstrumentIdentity(ctx.db, instrumentId, {
      ...(displayName !== undefined && { displayName }),
      ...(figi !== undefined && { figi }),
    });
  }
  if (status !== undefined) {
    await updateInstrumentDetails(ctx.db, instrumentId, { status });
  }
  if (sectorCode !== undefined || industryLabel !== undefined || domicileCountry !== undefined) {
    await updateInstrumentClassification(ctx.db, instrumentId, {
      ...(sectorCode !== undefined && { sectorCode }),
      ...(industryLabel !== undefined && { industryLabel }),
      ...(domicileCountry !== undefined && { domicileCountry }),
    });
  }
  // SCPI only: set, never cleared — the plan carries a
  // key only when the file states a value that differs.
  if (managementCompany !== undefined || subscriptionFeePct !== undefined) {
    await updateInstrumentScpiAttributes(ctx.db, instrumentId, {
      ...(managementCompany !== undefined && { managementCompany }),
      ...(subscriptionFeePct !== undefined && { subscriptionFeePct }),
    });
  }

  if (write.providerMapping !== null) {
    const mapping = write.providerMapping;
    try {
      if (mapping.action === "CREATE") {
        await createProviderMapping(ctx.db, {
          instrumentId,
          providerKey: mapping.providerKey,
          providerSymbol: mapping.providerSymbol,
          // An imported mapping is by construction a user-confirmed one — which is the
          // reason the document carries no confidence of its own — and the
          // confirm path is what stamps `lastVerifiedAt`.
          confidence: "CONFIRMED",
        });
      } else {
        await correctProviderMapping(ctx.db, instrumentId, {
          providerKey: mapping.providerKey,
          providerSymbol: mapping.providerSymbol,
        });
      }
    } catch (error) {
      refusals.push(
        error instanceof ProviderMappingAlreadyExistsError
          ? {
              reason: "PROVIDER_MAPPING_CONFLICT",
              message:
                "the pinned provider symbol already belongs to a different instrument in this " +
                "destination, so it was not taken from it",
            }
          : refusalFor(error, "APPLY_FAILED", "this provider mapping"),
      );
    }
  }

  if (write.icon !== null) {
    try {
      await setInstrumentIcon(ctx.db, {
        tenantId: ctx.tenantId,
        instrumentId,
        bytes: write.icon.bytes,
        contentType: write.icon.contentType,
        widthPx: write.icon.widthPx,
        heightPx: write.icon.heightPx,
      });
    } catch (error) {
      refusals.push(
        error instanceof InstrumentIconTenantCapExceededError
          ? {
              reason: "ICON_CAP_EXCEEDED",
              message: "this tenant is at its stored-icon limit, so this icon was not written",
            }
          : error instanceof InstrumentIconBoundsError
            ? {
                reason: "ICON_REJECTED",
                message: `this instrument's icon was refused: ${error.violation}`,
              }
            : refusalFor(error, "APPLY_FAILED", "this icon"),
      );
    }
  }

  let pricesWritten = 0;
  for (const [index, price] of write.manualPrices.entries()) {
    // H1, and the loop that finding is about: the schema admits
    // 500 000 points on one entry and each one is its own transaction, so
    // without this read the clock is never consulted again between here and the
    // end of the document. See this module's header.
    if (pastDeadline(ctx)) {
      refusals.push(deadlineRefusal(write.manualPrices.length - index, "price points"));
      break;
    }
    try {
      await upsertManualPricePoint(ctx.db, {
        tenantId: ctx.tenantId,
        instrumentId,
        priceDate: price.priceDate,
        close: price.close,
        currency: price.currency,
      });
      pricesWritten += 1;
    } catch (error) {
      if (error instanceof ManualPricePointTenantCapExceededError) {
        // One refusal, not one per remaining point: the cap refuses every
        // subsequent new key identically, and a refusal per point would bury
        // the report under a limit the user can only act on once.
        refusals.push({
          reason: "MANUAL_PRICE_CAP_EXCEEDED",
          message:
            `this tenant is at its stored-price limit; ` +
            `${String(write.manualPrices.length - pricesWritten)} of this entry's points were not written`,
        });
        break;
      }
      refusals.push(refusalFor(error, "APPLY_FAILED", "this price"));
    }
  }

  if (write.watchlist !== null) {
    try {
      // Already an upsert (MEASURED), so this one call is both the create and
      // the merge — see this module's header.
      await addWatchlistItem(ctx.db, {
        tenantId: ctx.tenantId,
        instrumentId,
        targetPrice: write.watchlist.targetPrice,
        note: write.watchlist.note,
      });
    } catch (error) {
      refusals.push(
        error instanceof WatchlistTenantCapExceededError
          ? {
              reason: "WATCHLIST_CAP_EXCEEDED",
              message:
                "this tenant is at its watchlist limit, so this entry's watchlist row was not written",
            }
          : refusalFor(error, "APPLY_FAILED", "this watchlist row"),
      );
    }
  }

  return { writtenId: instrumentId, refusals, created };
}

async function applyFxRate(
  ctx: CatalogueApplyContext,
  write: PlannedCatalogueFxRateWrite,
): Promise<EntryResult> {
  await upsertUserFxRate(ctx.db, {
    tenantId: ctx.tenantId,
    baseCurrency: write.baseCurrency,
    quoteCurrency: write.quoteCurrency,
    rateDate: write.rateDate,
    rate: write.rate,
  });
  return { writtenId: null, refusals: write.refusals, created: null };
}

/** A nested row's failure, with the cap class this call site can name mapped and everything else an honest `APPLY_FAILED`. */
function refusalFor(
  error: unknown,
  capReason: CatalogueRejectReason,
  what: string,
): CatalogueRefusal {
  if (error instanceof CashAccountPortfolioCapExceededError) {
    return {
      reason: capReason,
      message: `this portfolio is at its account limit, so ${what} was not opened`,
    };
  }
  return {
    reason: "APPLY_FAILED",
    message: `the ledger refused ${what}: ${error instanceof Error ? error.name : "unknown error"}`,
  };
}

/** The create paths are typed by kind, and the plan cannot express the wrong pairing — this is the run-time half of that claim. */
function assertIdentifierKind(kind: InstrumentRecord["kind"]): "SHARE" | "ETF" | "FUND" {
  if (kind !== "SHARE" && kind !== "ETF" && kind !== "FUND") {
    throw new Error(`an identifier-keyed instrument cannot be created with kind ${kind}`);
  }
  return kind;
}

function assertSymbolKind(kind: InstrumentRecord["kind"]): "CRYPTO" | "INDEX" {
  if (kind !== "CRYPTO" && kind !== "INDEX") {
    throw new Error(`a ticker-keyed instrument cannot be created with kind ${kind}`);
  }
  return kind;
}

function requireSymbol(symbol: string | null): string {
  if (symbol === null) {
    throw new Error("an instrument write carries neither an identifier plus exchange nor a ticker");
  }
  return symbol;
}
