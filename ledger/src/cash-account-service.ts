import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { Decimal } from "@kerdial/core-decimal";
import {
  cashAccount,
  cashBalance,
  extractPostgresError,
  portfolio,
  withTenant,
  type Db,
  type Tx,
} from "@kerdial/platform-db";
import { lockPortfolioRow } from "./portfolio-lock.js";

/**
 * `ledger`'s cash-account service — CD7, CD10, CD11, CA-13 and CA-16. Create,
 * rename, and archive/un-archive the **named** cash accounts a portfolio
 * holds (FR-150, FR-152, FR-164, FR-165), and read their balances
 * (FR-160–FR-163).
 *
 * Modelled on `portfolio-service.ts` throughout: the same `withTenant`
 * posture, the same "translate the unique violation, never let a raw
 * constraint failure escape" pattern, the same
 * `isUniqueViolation(err, CONSTRAINT_NAME)` helper shape, and the same
 * "return `undefined` when this tenant has no such row" contract
 * {@link updatePortfolio} already has (RLS makes another tenant's row
 * indistinguishable from a nonexistent one — AC33).
 *
 * **No *write* here touches money.** A cash account is a named container; its
 * balance lives in `cash_balance`, is derived from postings, and is written
 * only by `recomputeAndInvalidate`. Every write below therefore holds no
 * numeric value at all, and — the consequence that matters — **no write here
 * bumps `calc_epoch`**: create, rename and archive move no
 * money and change no derived figure, so bumping it would be invalidation
 * without cause, the same reasoning that applies to
 * `instrument_quote_latest`. Asserted, not merely intended, in
 * `cash-account-service.integration.test.ts`.
 *
 * {@link listCashAccountsWithBalances} (CA-16) is the one function here that
 * *reports* money, and it still writes none: it reads the already-materialised
 * `cash_balance` and folds it, never recomputing a balance from postings at
 * request time (FR-160). Every amount it returns and every total it folds is a
 * `Decimal` (NFR-12); the string rendering happens at the API boundary, once.
 *
 * **There is no `deleteCashAccount`, and no HTTP route exposes one**
 * (OD-5(c), locked): the only code path that removes a `cash_account` row is
 * `deletePortfolio`'s ordered cascade (CA-7), which is why migration `0038`
 * grants `app_web` `DELETE` on the table even though user-facing removal is
 * archive. That grant is not a licence for a route — the absence of one is
 * asserted by `api/src/portfolios/cash-accounts.controller.routes.test.ts`.
 *
 * A per-portfolio account cap **is** enforced —
 * {@link MAX_CASH_ACCOUNTS_PER_PORTFOLIO}. The previous version
 * of this paragraph argued no cap was needed, on the grounds that cash accounts
 * "multiply nothing" and that the read route's result set is "bounded by the
 * response". F2 falsified both halves: the response *is* the unbounded
 * thing, and the account count multiplies `deletePortfolio`'s per-row RI check
 * over the whole all-tenants `transaction_posting` — measured at 534.9 ms for
 * 21 accounts against 200k postings, and `statement_timeout` (15 s) at 821,
 * with the tenant advisory lock held for every one of those seconds.
 */

/** Mirrors `cash_account`'s row shape exactly — see `platform/db/src/schema/cash-account.ts`. */
export type CashAccountRecord = typeof cashAccount.$inferSelect;

/**
 * The `UNIQUE (tenant_id, portfolio_id, name)` index migration `0038` creates
 * — **unconditional**, not partial on `archived_at IS NULL` (CD11): an
 * archived account keeps its name reserved, which is exactly what makes
 * un-archiving safe (it can never fail on a conflict the user cannot see).
 *
 * Matched by *name* as well as by SQLSTATE. Discriminating on `23505` alone
 * would also swallow a violation of
 * `cash_account_tenant_id_portfolio_id_id_currency_key` (a `randomUUID`
 * collision — impossible in practice, which is the point: an "impossible"
 * failure must not be reported to the user as a name conflict). This repo has
 * a recorded case of a duplicate-key test that passed both with and without
 * its constraint name, because the statement was failing earlier for an
 * unrelated reason and never reached the index at all.
 */
const CASH_ACCOUNT_NAME_CONSTRAINT = "cash_account_tenant_id_portfolio_id_name_key";

/**
 * Surfaced in place of the raw `23505` when this portfolio already has an
 * account by this name — including an **archived** one (CD11).
 *
 * A translation of the database's own failure, not a read-then-write
 * pre-check: the unique index remains the actual arbiter, so two concurrent
 * creates of the same name cannot both succeed. Only the message the caller
 * sees is this service's concern — the same posture
 * {@link PortfolioNameAlreadyExistsError} documents.
 */
export class CashAccountNameAlreadyExistsError extends Error {
  readonly portfolioId: string;
  /** The offending account name. Not `name`: that field is `Error`'s own, and is this class's identifier. */
  readonly cashAccountName: string;

  constructor(portfolioId: string, cashAccountName: string) {
    super(
      `A cash account named ${JSON.stringify(cashAccountName)} already exists in this portfolio ` +
        `(it may be archived — an archived account keeps its name reserved, CD11).`,
    );
    this.name = "CashAccountNameAlreadyExistsError";
    this.portfolioId = portfolioId;
    this.cashAccountName = cashAccountName;
  }
}

/**
 * CD10: raised when the `SELECT … FROM portfolio … FOR UPDATE` every function
 * below takes as its **first** statement finds no row — an unknown id, or
 * another tenant's (RLS makes the two indistinguishable, AC33), or one a
 * concurrent `deletePortfolio` has just destroyed.
 *
 * That last case is the whole reason the lock exists. Without it, a create
 * committing between the cascade's `DELETE FROM cash_account` and its
 * `DELETE FROM portfolio` produces a `23503` that `deletePortfolio`'s own
 * defensive catch maps to
 * {@link PortfolioDeleteBlockedByLinkedTransactionError} — a 409 whose message
 * ("a transaction outside this portfolio…") is simply false; and a create
 * committing *after* the portfolio row is gone violates
 * `cash_account_portfolio_id_portfolio_id_fk` and escapes as an unmapped 500.
 * Taking the portfolio row `FOR UPDATE` first makes the two paths mutually
 * exclusive, so the honest answer — this portfolio does not exist — is the
 * only one reachable.
 */
export class CashAccountPortfolioNotFoundError extends Error {
  readonly tenantId: string;
  readonly portfolioId: string;

  constructor(tenantId: string, portfolioId: string) {
    super(
      `Portfolio ${portfolioId} does not exist for this tenant — it may have been deleted ` +
        `concurrently (CD10: the portfolio row is locked FOR UPDATE before any cash-account write).`,
    );
    this.name = "CashAccountPortfolioNotFoundError";
    this.tenantId = tenantId;
    this.portfolioId = portfolioId;
  }
}

/** See `portfolio-service.ts`'s identical helper: built on `extractPostgresError`, which already unwraps drizzle-orm's `DrizzleQueryError` around the driver's `PostgresError`. */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const pgError = extractPostgresError(err);
  return pgError?.sqlstate === "23505" && pgError.constraintName === constraintName;
}

/**
 * The name a caller supplied, trimmed, with the empty case refused.
 *
 * Mirrors {@link createPortfolio}/{@link updatePortfolio}'s own guard **and**
 * adds the trim, so the two write paths below cannot
 * disagree about what `"Compte "` means: create stores `"Compte"`, and a later
 * rename to `"Compte "` is therefore the no-op self-rename FR-164 promises,
 * not a spurious conflict with the row's own stored name.
 *
 * This is not the real bound. `cash_account_name_length`
 * (`name ~ '\S' and length(btrim(name)) <= 200`, migration `0038`) is —
 * an application check can always be bypassed by a future caller that forgets
 * it; the CHECK cannot. Every HTTP caller is additionally bounded by
 * `portfolioNameSchema` (`z.string().trim().min(1).max(200)`), which is what
 * makes AC-173's "never a 500" true at the boundary rather than here.
 */
function requireName(name: string, fn: string): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed === "") {
    throw new TypeError(`${fn} requires a non-empty name`);
  }
  return trimmed;
}

/**
 * F2 (security review): the per-portfolio
 * cash-account ceiling, mirroring `MAX_PORTFOLIOS_PER_TENANT`'s own H2
 * precedent — same count-then-insert shape, same test-only override parameter,
 * same 409 mapping at the HTTP boundary.
 *
 * **200, and the number is measured rather than picked round.** Two bounds had
 * to hold at once:
 *
 *   - *The delete stays well inside `statement_timeout`, even if the index this
 *     same fix adds were ever dropped.* `deletePortfolio`'s `DELETE FROM
 *     cash_account` costs one RI probe of `transaction_posting` per account;
 *     un-indexed, that probe was measured at 534.9 ms / 21 accounts = 25.5 ms
 *     per account against 200k postings, so the un-indexed break-even against
 *     `DEFAULT_STATEMENT_TIMEOUT_MS` (15 s, `platform/db/src/client.ts`) is
 *     ~590 accounts. 200 leaves ~3x headroom on the *unprotected* path and,
 *     with `transaction_posting_cash_account_id_idx` (migration `0040`) in
 *     place, brings the whole delete to ~50 ms.
 *   - *`GET /portfolios/:id/cash` stays a page, not a dump.* That route is
 *     deliberately **not** paginated (see
 *     {@link listCashAccountsWithBalances}: a `LIMIT` would silently omit
 *     accounts from FR-161's per-currency total, which is worse than a slow
 *     response), so this cap *is* the route's bound. 200 rows is ~1.4 ms of
 *     server time at the measured 50,821-account rate, and 200 `<option>`s is a
 *     bad `<select>` rather than a browser hazard.
 *
 * It is deliberately smaller than `MAX_PORTFOLIOS_PER_TENANT`'s 500: an account
 * is a *sub*-container, so the tenant-wide row count these caps jointly permit
 * is their product, and a portfolio with more than a handful of named cash
 * accounts is already outside any usage this product was specified for
 * (FR-150's examples top out at a few per portfolio).
 *
 * **Unlike `MAX_PORTFOLIOS_PER_TENANT`, this one has no TOCTOU** — and that is
 * free rather than earned. {@link createCashAccount} counts *after* CD10's
 * `portfolio`-row `FOR UPDATE`, so two concurrent creates in the same portfolio
 * are already serialised on that row and the second one's count sees the
 * first's committed insert. `createPortfolio`'s equivalent count has no such
 * lock available (there is no per-tenant row to take) and documents the race as
 * accepted.
 */
export const MAX_CASH_ACCOUNTS_PER_PORTFOLIO = 200;

/** Surfaced by {@link createCashAccount} when a portfolio at {@link MAX_CASH_ACCOUNTS_PER_PORTFOLIO} accounts attempts another one (F2). */
export class CashAccountPortfolioCapExceededError extends Error {
  readonly portfolioId: string;
  readonly cap: number;

  constructor(portfolioId: string, cap: number) {
    super(
      `Portfolio ${portfolioId} already has ${cap} or more cash accounts — refusing to open another ` +
        `(F2). Archived accounts count: archiving is a ` +
        `visibility change, and an archived account still costs the portfolio-delete cascade one ` +
        `referential-integrity probe.`,
    );
    this.name = "CashAccountPortfolioCapExceededError";
    this.portfolioId = portfolioId;
    this.cap = cap;
  }
}

export interface CreateCashAccountParams {
  /** Optional: defaults to a freshly minted UUID (all IDs are UUIDv7). */
  readonly id?: string;
  readonly tenantId: string;
  readonly portfolioId: string;
  /** Free-text label, trimmed. Unique within the *portfolio* only (FR-152, AC-174) — two portfolios may each have a "Compte espèce". */
  readonly name: string;
  /** ISO 4217, uppercase. Immutable for the row's lifetime (OD-2) — `app_web` holds no `UPDATE` grant on this column at all. */
  readonly currency: string;
  /** Overrides {@link MAX_CASH_ACCOUNTS_PER_PORTFOLIO} — test-only escape hatch, mirroring `createPortfolio`'s own `maxPortfoliosPerTenant` parameter. */
  readonly maxCashAccountsPerPortfolio?: number;
}

/**
 * Opens one named cash account in `params.portfolioId` (FR-150).
 *
 * **AC-172, the criterion this cycle is graded against**: two accounts in the
 * same portfolio *and the same currency* both succeed, as long as their names
 * differ. Currency is not part of any uniqueness key on this table, in any
 * form, and nothing in this function reads or compares it — the
 * `(tenant_id, portfolio_id, name)` index is the only arbiter.
 *
 * Statement order is a correctness requirement, not a style: the portfolio-row
 * `FOR UPDATE` is the **first** statement (CD10 — see
 * {@link CashAccountPortfolioNotFoundError} for what the two interleavings
 * produce without it), then F2's cap count, then the `INSERT`, all inside the
 * same transaction. The count is *after* the lock, which is what makes it
 * race-free rather than best-effort — see
 * {@link MAX_CASH_ACCOUNTS_PER_PORTFOLIO}'s own doc comment.
 *
 * @throws {CashAccountPortfolioNotFoundError} 404 — no such portfolio for this tenant.
 * @throws {CashAccountPortfolioCapExceededError} 409 — this portfolio is already at {@link MAX_CASH_ACCOUNTS_PER_PORTFOLIO} (F2).
 * @throws {CashAccountNameAlreadyExistsError} 409 — this portfolio already has an account by this name (archived ones included, CD11).
 */
export async function createCashAccount(
  db: Db,
  params: CreateCashAccountParams,
): Promise<CashAccountRecord> {
  const name = requireName(params.name, "createCashAccount");
  const cap = params.maxCashAccountsPerPortfolio ?? MAX_CASH_ACCOUNTS_PER_PORTFOLIO;
  const id = params.id ?? randomUUID();
  try {
    return await withTenant(db, params.tenantId, async (tx) => {
      await lockPortfolio(tx, params.tenantId, params.portfolioId);

      // F2. Counted under CD10's lock, and counting **every** row of
      // this portfolio — archived included, since an archived account still
      // costs the delete cascade its RI probe and still occupies a name.
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(cashAccount)
        .where(
          and(
            eq(cashAccount.tenantId, params.tenantId),
            eq(cashAccount.portfolioId, params.portfolioId),
          ),
        );
      if ((countRows[0]?.count ?? 0) >= cap) {
        throw new CashAccountPortfolioCapExceededError(params.portfolioId, cap);
      }

      const [row] = await tx
        .insert(cashAccount)
        .values({
          id,
          tenantId: params.tenantId,
          portfolioId: params.portfolioId,
          name,
          currency: params.currency,
        })
        .returning();
      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err, CASH_ACCOUNT_NAME_CONSTRAINT)) {
      throw new CashAccountNameAlreadyExistsError(params.portfolioId, name);
    }
    throw err;
  }
}

export interface RenameCashAccountParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly cashAccountId: string;
  readonly name: string;
}

/**
 * Renames a cash account (FR-164, AC-184). Always issues the `UPDATE` —
 * deliberately no pre-read, exactly as {@link updatePortfolio} does, so
 * renaming to the account's **own current name is a no-op success by
 * construction** (the unique index is not violated: it is the same row), not a
 * special case this function has to remember to write.
 *
 * The `set` clause names only `name` and `updated_at`. Those are two of the
 * three columns `app_web` holds an `UPDATE` grant on at all (`archived_at`
 * being the third), so this statement is structurally incapable of touching
 * `currency` or `portfolio_id` — and it touches no `calc_epoch` anywhere, on
 * `portfolio` or otherwise (a rename changes a label, not a
 * number).
 *
 * Returns `undefined` when this tenant has no such account **in this
 * portfolio** — an unknown id, another tenant's (invisible under RLS, AC33),
 * or one belonging to a sibling portfolio. The caller maps that to a 404
 * distinct from {@link CashAccountPortfolioNotFoundError}'s.
 *
 * @throws {CashAccountPortfolioNotFoundError} 404 — no such portfolio for this tenant (CD10's lock found no row).
 * @throws {CashAccountNameAlreadyExistsError} 409 — another account **in the same portfolio** already holds this name (AC-184). An account in a *different* portfolio holding it is not a conflict (AC-174).
 */
export async function renameCashAccount(
  db: Db,
  params: RenameCashAccountParams,
): Promise<CashAccountRecord | undefined> {
  const name = requireName(params.name, "renameCashAccount");
  try {
    return await withTenant(db, params.tenantId, async (tx) => {
      await lockPortfolio(tx, params.tenantId, params.portfolioId);
      const [row] = await tx
        .update(cashAccount)
        .set({ name, updatedAt: sql`now()` })
        .where(scopeToAccount(params))
        .returning();
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err, CASH_ACCOUNT_NAME_CONSTRAINT)) {
      throw new CashAccountNameAlreadyExistsError(params.portfolioId, name);
    }
    throw err;
  }
}

export interface SetCashAccountArchivedParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly cashAccountId: string;
  /** `true` sets `archived_at`; `false` clears it. **Un-archive is supported** (CD11) — see below. */
  readonly archived: boolean;
}

/**
 * Archives (`archived: true`) or un-archives (`archived: false`) a cash
 * account — FR-165 under OD-5(c)'s locked soft-delete.
 *
 * **This is a visibility change, not an accounting one, and that distinction
 * is load-bearing.** The account keeps every transaction ever attributed to
 * it, its `cash_balance` row is not touched, and it still contributes to the
 * portfolio's per-currency total:
 * excluding an archived account from that total would make money vanish from
 * the one figure this whole feature exists to show. Archiving hides an account
 * from *pickers*; it never hides it from a balance. Asserted directly —
 * `cash_balance` is read before and after in
 * `cash-account-service.integration.test.ts`.
 *
 * Nothing here is conditional on the account's transaction history. An account
 * a user wants out of their picker is *precisely* the one with years of
 * history behind it, so refusing to archive a non-empty account would make the
 * feature useless; that is the whole reason OD-5 locked (c) over (a). (This
 * contradicts AC-185's wording: its "rejected, stating the blocking transaction count" clause describes OD-5
 * option (a), which was not the option locked.)
 *
 * **Un-archive is supported**, which is what CD11's *unconditional* unique key
 * exists to make safe: because an archived account keeps its name reserved, no
 * other account can have taken that name in the meantime, so `archived: false`
 * can never fail on a conflict the user cannot see. A partial unique index
 * `WHERE archived_at IS NULL` would have made archive a one-way trap
 * discovered at the worst possible moment.
 *
 * Returns `undefined` when this tenant has no such account in this portfolio
 * ({@link renameCashAccount}'s contract, verbatim). Re-archiving an already
 * archived account is a success that re-stamps `archived_at`, and un-archiving
 * an already active one is a success that clears an already-`NULL` column —
 * both idempotent by construction, for the same "always issue the `UPDATE`,
 * never pre-read" reason a self-rename is.
 *
 * @throws {CashAccountPortfolioNotFoundError} 404 — no such portfolio for this tenant.
 */
export async function setCashAccountArchived(
  db: Db,
  params: SetCashAccountArchivedParams,
): Promise<CashAccountRecord | undefined> {
  return withTenant(db, params.tenantId, async (tx) => {
    await lockPortfolio(tx, params.tenantId, params.portfolioId);
    const [row] = await tx
      .update(cashAccount)
      .set({
        archivedAt: params.archived ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(scopeToAccount(params))
      .returning();
    return row;
  });
}

/**
 * CD10's lock, and the **first** statement of every function above —
 * {@link lockPortfolioRow}, rung 2 of `portfolio-lock.ts`'s global order, with
 * this module's own 404 for the empty case.
 *
 * This is byte-for-byte `deletePortfolio`'s own portfolio-row lock — the same
 * row, the same lock mode — which is what makes the two paths mutually
 * exclusive: a cash-account write either fully commits before the cascade
 * acquires this lock, or blocks and then finds no portfolio.
 *
 * **The previous version of this comment claimed the path "cannot deadlock",
 * and that claim was false as shipped** (F1). It enumerated
 * `deletePortfolio`'s protocol and the transaction-edit path and concluded that
 * holding nothing at acquisition time made a cycle impossible — but a cycle
 * needs only that *some other* path take these locks in the opposite order, and
 * this cycle's own composite FKs gave the transaction-edit path exactly that:
 * `transaction` row → `cash_account` row (the `UPDATE`'s RI re-check) →
 * `portfolio` row, against this function's `portfolio` row →
 * `cash_account` row (rename's key-update of `name`). Reproduced as a real
 * `40P01`; see `portfolio-lock.ts` for the verbatim error and the order that
 * removes it.
 *
 * It cannot deadlock **now**, and the reason is that every writer in this
 * package reaches rungs 3 and 4 through rung 2 — not that this particular
 * caller happens to hold nothing. Proved behaviourally, against a real
 * in-flight `deletePortfolio` *and* a real in-flight `editTransaction`, in
 * `cash-account-service.integration.test.ts`.
 */
async function lockPortfolio(tx: Tx, tenantId: string, portfolioId: string): Promise<void> {
  if (!(await lockPortfolioRow(tx, tenantId, portfolioId))) {
    throw new CashAccountPortfolioNotFoundError(tenantId, portfolioId);
  }
}

/**
 * The `WHERE` shared by rename and archive — all three of `tenant_id`,
 * `portfolio_id` and `id`, never `id` alone.
 *
 * `tenant_id` is defence in depth (RLS's `USING` clause is the primary
 * enforcement). `portfolio_id` is **not**: the route is
 * nested under a portfolio (FR-153), CD10's lock was taken on *that*
 * portfolio's row, and without this predicate an account belonging to a
 * sibling portfolio of the same tenant would be editable through the wrong
 * portfolio's URL — a lock taken on a row that has nothing to do with the row
 * being written.
 */
function scopeToAccount(params: {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly cashAccountId: string;
}) {
  return and(
    eq(cashAccount.tenantId, params.tenantId),
    eq(cashAccount.portfolioId, params.portfolioId),
    eq(cashAccount.id, params.cashAccountId),
  );
}

/** One cash account, with the balance `cash_balance` currently holds for it. */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (web/api mirrors and their tests, which knip does not analyse) — until AR-13a removed a namespace-wide `typeof import("@kerdial/ledger")` vi.mock, that accident masked this. */
export interface CashAccountBalance {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  /** `true` once `archived_at` is set. It changes nothing below: an archived account keeps its balance and keeps contributing to {@link PortfolioCashSnapshot.byCurrency}. */
  readonly archived: boolean;
  /** Exactly zero when this account has no `cash_balance` row — never "unknown". */
  readonly balance: Decimal;
}

/** FR-161's per-currency rollup: the portfolio's cash total, expressed once per currency and never summed across them. */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (web/api mirrors and their tests, which knip does not analyse) — until AR-13a removed a namespace-wide `typeof import("@kerdial/ledger")` vi.mock, that accident masked this. */
export interface CashCurrencyTotal {
  readonly currency: string;
  readonly total: Decimal;
  /** How many of {@link PortfolioCashSnapshot.accounts} were folded into {@link total} — archived ones included. */
  readonly accountCount: number;
}

/** The whole of `GET /portfolios/:id/cash`'s payload, as one consistent snapshot. */
export interface PortfolioCashSnapshot {
  /** Ordered `currency, name`. Includes archived accounts, and accounts with no postings at all. */
  readonly accounts: readonly CashAccountBalance[];
  /** Folded from {@link accounts} in this process, so the two can never disagree. Ordered by currency. */
  readonly byCurrency: readonly CashCurrencyTotal[];
  /** The `portfolio.calc_epoch` read by the *same* statement that produced the balances (FR-162). */
  readonly calcEpoch: bigint;
}

export interface ListCashAccountsWithBalancesParams {
  readonly tenantId: string;
  readonly portfolioId: string;
}

/** The zero every account with no `cash_balance` row reports. One shared immutable instance: `Decimal` values are never mutated in place. */
const ZERO = new Decimal(0);

/**
 * CA-16 — every cash account in one portfolio, each with
 * its current balance, plus FR-161's per-currency total and the `calc_epoch`
 * the whole snapshot was taken at.
 *
 * Returns `undefined` when this tenant has no such portfolio — the same
 * "another tenant's row is indistinguishable from a nonexistent one" contract
 * (AC33) {@link renameCashAccount} has. The HTTP route maps it to a 404, and
 * takes its own prior `getPortfolio` check as well, so the 404 is decided
 * before this statement runs and never by an empty result.
 *
 * ## One statement, and why that is a correctness requirement
 *
 * Under READ COMMITTED a single statement sees one snapshot; two statements do
 * not. Reading `cash_account`, then `cash_balance`, then `portfolio.calc_epoch`
 * as three statements would hand a client epoch *N* with balances from *N−1*
 * whenever a writer commits between them — silently, undetectably, and
 * defeating FR-162 entirely. So this is **one** `SELECT`, and `byCurrency` is
 * folded from its result set here in TypeScript rather than issued as a second
 * `GROUP BY`: a total assembled by a second statement can straddle a
 * concurrent commit and report a figure that never existed. Measured, not
 * asserted by inspection — `cash-account-balances-statement-count.integration.test.ts`
 * counts what actually goes on the wire, and
 * `cash-account-balances.integration.test.ts` runs this read in a loop against
 * a committing writer and requires every response to be internally consistent.
 *
 * ## Why `portfolio` drives the join, and not `cash_account`
 *
 * The obvious SQL reads `from cash_account ca join portfolio p`, which
 * returns **no rows at all** for a portfolio that owns no cash account — and
 * therefore no `calc_epoch`, which the response is required to carry. That
 * portfolio is reachable in production: `0039`'s backfill mints accounts only
 * for `(portfolio, currency)` pairs some transaction actually used, so any
 * portfolio that existed before this cycle with no transactions has none, and
 * `createPortfolio`'s CA-25 account only covers portfolios created after it.
 * Driving from `portfolio` with two `LEFT JOIN`s keeps the statement count at
 * one, keeps every row the plain form returns, and additionally returns one
 * account-less row carrying the epoch — strictly more total, never less. The
 * account-less row is dropped below rather than rendered as an account.
 *
 * The `LEFT JOIN` onto `cash_balance` is what makes a never-used account
 * render `0` instead of vanishing: a missing row means exactly zero, not
 * unknown. Archived accounts are **not** filtered —
 * excluding one with a non-zero balance would make the portfolio total wrong,
 * which is the single easiest thing in this feature to get quietly wrong
 * (RC4: archiving hides an account from pickers, never from
 * the balance).
 *
 * ## Unbounded on purpose, and bounded elsewhere (F2)
 *
 * There is no `LIMIT` here and no pagination on the route above it, and that is
 * a decision rather than an omission. `byCurrency` is folded from exactly the
 * rows returned, so a `LIMIT` would not slow the response down — it would make
 * FR-161's per-currency total *wrong*, silently, by the balances of whichever
 * accounts fell off the end. A total that omits accounts is worse than a slow
 * response, and a paginated total would have to be a second `GROUP BY`
 * statement, which is precisely what the "one statement" section above rules
 * out.
 *
 * The bound is therefore {@link MAX_CASH_ACCOUNTS_PER_PORTFOLIO}, upstream of
 * this read: at most 200 accounts can exist in a portfolio, so at most 200 rows
 * can come back and the total is exact over all of them. That is a stated
 * reliance, not a coincidence — moving the cap moves this route's worst case
 * with it, and `cash-account-balances.integration.test.ts` asserts the two
 * together rather than assuming they agree.
 */
export async function listCashAccountsWithBalances(
  db: Db,
  params: ListCashAccountsWithBalancesParams,
): Promise<PortfolioCashSnapshot | undefined> {
  const rows = await withTenant(db, params.tenantId, async (tx) =>
    tx
      .select({
        cashAccountId: cashAccount.id,
        name: cashAccount.name,
        currency: cashAccount.currency,
        archivedAt: cashAccount.archivedAt,
        amount: cashBalance.amount,
        calcEpoch: portfolio.calcEpoch,
      })
      .from(portfolio)
      .leftJoin(
        cashAccount,
        and(
          eq(cashAccount.tenantId, portfolio.tenantId),
          eq(cashAccount.portfolioId, portfolio.id),
        ),
      )
      .leftJoin(
        cashBalance,
        and(
          eq(cashBalance.tenantId, cashAccount.tenantId),
          eq(cashBalance.portfolioId, cashAccount.portfolioId),
          eq(cashBalance.cashAccountId, cashAccount.id),
          eq(cashBalance.currency, cashAccount.currency),
        ),
      )
      .where(and(eq(portfolio.tenantId, params.tenantId), eq(portfolio.id, params.portfolioId)))
      .orderBy(asc(cashAccount.currency), asc(cashAccount.name)),
  );

  const first = rows[0];
  if (first === undefined) return undefined;

  const accounts: CashAccountBalance[] = [];
  for (const row of rows) {
    // The account-less row a portfolio with no `cash_account` produces. It
    // carried the epoch, which is the reason it is selected at all.
    if (row.cashAccountId === null) continue;
    accounts.push({
      id: row.cashAccountId,
      // `name` and `currency` are `NOT NULL` on `cash_account`; the `LEFT JOIN`
      // is the only reason the types are nullable at all, and the guard above
      // has already established the join matched.
      name: row.name!,
      currency: row.currency!,
      archived: row.archivedAt !== null,
      // `null` is "no row", which is defined as exactly zero.
      balance: row.amount ?? ZERO,
    });
  }

  // Folded from the rows just read, in currency order (the `ORDER BY` above
  // already grouped them), with `Decimal#plus` — an exact decimal sum, never a
  // float accumulation.
  const byCurrency: CashCurrencyTotal[] = [];
  const totals = new Map<string, { total: Decimal; accountCount: number }>();
  for (const account of accounts) {
    const running = totals.get(account.currency);
    if (running === undefined) {
      const entry = { total: account.balance, accountCount: 1 };
      totals.set(account.currency, entry);
      continue;
    }
    running.total = running.total.plus(account.balance);
    running.accountCount += 1;
  }
  for (const [currency, entry] of totals) {
    byCurrency.push({ currency, total: entry.total, accountCount: entry.accountCount });
  }

  return { accounts, byCurrency, calcEpoch: first.calcEpoch };
}
