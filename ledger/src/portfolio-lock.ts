import { and, eq, sql } from "drizzle-orm";
import { portfolio, type Tx } from "@kerdial/platform-db";

/**
 * **The global lock order for every writer in this package**, and the two
 * statements that take its first and second rungs.
 *
 * ## Why this module exists (F1, security review)
 *
 * Until this fix each write path stated its *own* ordering argument, and the
 * arguments were pairwise consistent right up to the moment CD3's composite
 * FKs added a lock edge nobody's argument had enumerated. `cash-account-service.ts`
 * claimed, in prose, that its `portfolio`-row lock "cannot deadlock … not with
 * `deletePortfolio`'s protocol and not with the transaction-edit path". That
 * claim was false as shipped, and reproducibly so:
 *
 *     ERROR:  deadlock detected
 *     DETAIL:  Process 299 waits for ShareLock on transaction 1078; blocked by process 300.
 *     Process 300 waits for ShareLock on transaction 1077; blocked by process 299.
 *     CONTEXT:  while updating tuple (0,6) in relation "cash_account"
 *
 * `PATCH /transactions/:id {"cashAccountId": …}` took the `transaction` row
 * `FOR UPDATE`, then a `FOR KEY SHARE` on the named `cash_account` row (the
 * `UPDATE`'s own RI re-check of `transaction_cash_account_fk`), and only then
 * asked for the `portfolio` row — while `PATCH …/cash-accounts/:id {"name": …}`
 * held the `portfolio` row `FOR UPDATE` and was waiting to key-update that same
 * `cash_account` row. Two edges, opposite directions, one cycle.
 *
 * ## The order
 *
 * Coarsest container first, and never the reverse:
 *
 *   1. **`pg_advisory_xact_lock(hashtext(tenant_id))`** — the per-tenant lock,
 *      {@link lockTenantWrites} below. Taken by every writer that may hold
 *      more than one `portfolio` row (the rule in the next section): every
 *      transaction create (`TransactionWriteService#nextSeq`), `editTransaction`,
 *      `deleteTransaction` and `correctFxRate`, `deletePortfolio`, and both
 *      manual-price writes (`upsertManualPricePoint`/`deleteManualPricePoint`,
 *      whose `invalidateForInstrumentPrice` fan-out locks every affected
 *      portfolio). `platform/auth`'s login rate limiter takes a two-argument
 *      advisory lock in its own `LOGIN_RATE_LIMIT_LOCK_NAMESPACE`, which is a
 *      different lock and touches none of these tables. A path that does *not*
 *      take rung 1 never waits on it, so it cannot be an edge of any cycle
 *      through it.
 *   2. **the `portfolio` row** — {@link lockPortfolioRow} below, `FOR UPDATE`.
 *   3. **`transaction` rows** — `SELECT … FOR UPDATE`, or the implicit lock an
 *      `UPDATE`/`DELETE` takes.
 *   4. **`cash_account` rows** — almost never requested explicitly: they are
 *      taken `FOR KEY SHARE` by the RI checks behind an `INSERT`/`UPDATE` of
 *      `transaction`, `transaction_posting` or `cash_balance`, and `FOR UPDATE`
 *      by `renameCashAccount`'s key-update of `name`.
 *
 * Rung 2 is what makes rungs 3 and 4 safe *without* anyone reasoning about
 * them: a writer that already holds the `portfolio` row `FOR UPDATE` excludes
 * every other writer in this package from rungs 2, 3 and 4 for that portfolio,
 * because every one of them passes through this function first.
 *
 * ## The multi-portfolio rule: rung 1 first (`security-transfer`, ST-7)
 *
 * Rung 2's argument is per portfolio. It says nothing about a writer that
 * holds portfolio P1 and then asks for P2 while another holds P2 and asks for
 * P1 — and since security transfers, several writers do exactly that: a
 * linked source edit mirrors onto its target's portfolio, a pair delete holds
 * both, a write in a transfer's source portfolio re-costs the target in
 * another (`transfer-link.ts`), `deletePortfolio` severs links in other
 * portfolios, and the manual-price fan-out has always recomputed several.
 *
 * **A writer that may hold more than one `portfolio` row takes rung 1 before
 * any of them.** Two such writers can then never wait on each other's
 * portfolio rows: the second is queued on rung 1 before it holds anything the
 * first could want. A writer that holds exactly one portfolio row
 * (`cash-account-service`, `portfolio-icon-service`, the lazy materialiser's
 * guard) never waits for a second, so it cannot close a cycle either, and does
 * not take rung 1. `editTransaction`/`deleteTransaction`/`correctFxRate` take
 * it as their **first** statement whatever the row's kind, because any of them
 * can trigger cross-portfolio propagation and none can know whether it will
 * before it has read — and that read must already be under the lock.
 *
 * The rejected alternative — discover the transfer closure, then lock its
 * portfolios in id order — reads the closure before the locks, so a concurrent
 * create can grow it; making that safe needs a retry loop, which the section
 * below rules out. The cost, stated: every ledger write of one tenant is
 * serialised on this lock.
 *
 * ## What this replaces, and why the replaced argument was fragile
 *
 * Transaction **create** did not deadlock before this fix either — but only
 * incidentally. `transaction_portfolio_id_portfolio_id_fk`'s RI trigger has a
 * lower OID (`16748`) than the four cash-account FK triggers (`17237`+), so on
 * `INSERT` Postgres happened to fire the portfolio check first and take rung 2
 * before rung 4. That is an artefact of the order two migrations ran in, not a
 * designed invariant: recreating those constraints (a `pg_dump`/restore that
 * reorders them, a future migration that drops and re-adds one) silently
 * inverts it. Taking the lock here, explicitly, before the `INSERT` is issued
 * makes create's safety a property of this code instead.
 *
 * ## No `40P01` handler, deliberately
 *
 * There is no deadlock-retry loop anywhere in this repository, and this fix
 * does not add one. A retry loop *instead of* a lock order would have hidden
 * the cycle rather than removed it, and one *in addition to* a correct lock
 * order defends against nothing this code can still produce — every writer
 * that touches both a `portfolio` and its children now takes rung 2 first, so
 * no cycle can form between them. If a future writer ever produces a `40P01`,
 * the honest fix is to bring it onto this order, not to retry it.
 *
 * ## The other reason rung 2 is taken first: TOCTOU on a child insert
 *
 * Independently of deadlocks, **any** write that inserts a child row FK'd to
 * `portfolio` races a concurrent `deletePortfolio`: check the portfolio
 * exists, then insert the child, and the portfolio can vanish between the two
 * statements. The insert then violates the child's `..._portfolio_id_fk`, and
 * because `problem-json.filter.ts`'s `CLIENT_CAUSED_FK_CONSTRAINTS` allowlist
 * maps only two currency-FK constraints to a `400`, every other FK violation —
 * this one included — escapes as an unmapped, undiagnosable `500`, not the
 * `404` the caller actually wants ("this portfolio doesn't exist").
 *
 * Calling {@link lockPortfolioRow} as the **first** statement of the write
 * closes the window: `SELECT … FOR UPDATE` either blocks until a racing
 * `deletePortfolio` commits and then correctly finds no row, or takes the
 * lock first and excludes the delete until the insert is done. This is the
 * same rung-2-first discipline the deadlock section above argues for, from a
 * different angle — here the payoff is a clean `404` instead of a raw `23503`.
 *
 * Discovered twice, independently: `cash-account-service.ts`'s
 * `lockPortfolio` (feeding `CashAccountPortfolioNotFoundError`) and
 * `portfolio-icon-service.ts`'s `setPortfolioIcon` (feeding
 * `PortfolioIconPortfolioNotFoundError`, PD-7) each hit this hazard from
 * scratch and fixed it the same way before either one referenced the other.
 * Both are proved against a real in-flight `deletePortfolio` — asserting the
 * named domain error and no raw SQLSTATE, never a `500` — in
 * `cash-account-service.integration.test.ts`'s "CD10" suite and
 * `portfolio-icon-service.integration.test.ts`'s "PD-7" suite respectively.
 * A third child-inserting writer should take this lock first too, and can
 * point back here instead of re-deriving the argument.
 */
/**
 * Rung 1: the per-tenant advisory lock, released at commit or rollback.
 * Re-entrant within one transaction (`pg_advisory_xact_lock` stacks), so a
 * writer that already holds it may call this again at no cost beyond the round
 * trip. See this module's "multi-portfolio rule" for who must take it, and
 * when.
 */
export async function lockTenantWrites(tx: Tx, tenantId: string): Promise<void> {
  // The `::text` cast is not decoration: without it the parameter's type is
  // undeterminable and Postgres refuses to resolve `hashtext`.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId}::text))`);
}

/** Rung 2: the `portfolio` row, `FOR UPDATE` — see this module's header. `false` when this tenant has no such portfolio. */
export async function lockPortfolioRow(
  tx: Tx,
  tenantId: string,
  portfolioId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: portfolio.id })
    .from(portfolio)
    .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)))
    .for("update");
  return row !== undefined;
}
