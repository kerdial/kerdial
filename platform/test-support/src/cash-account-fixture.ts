import { randomUUID } from "node:crypto";
import { cashAccount, portfolio, type Db, type Tx } from "@kerdial/platform-db";
import { eq } from "drizzle-orm";

/**
 * Test-only fixture helper for CA-9's write-path change
 * (Batch B). Lives here, next to
 * `startMigratedPostgres`, for the same reason that does: `ledger`,
 * `valuation` and `api` suites all need it, and three copies of it would be
 * three chances to disagree about what a fixture cash account looks like.
 *
 * Every fiat-settled write now names the `cash_account` its money moved
 * through (FR-156), and migration `0039`'s five totality CHECKs make that
 * total at the database — so **every** existing fixture that writes a
 * transaction needs an account to name. This is the one place that mints
 * them, rather than nine near-identical local helpers.
 *
 * Seeded through the **owner** role: out-of-band setup a real request never
 * does, exactly like the `tenant`/`app_user` inserts these suites already do
 * that way. The cash-account CRUD service (and its HTTP routes) is Batch C,
 * so there is no production writer to go through yet, and reaching for one
 * here would couple every unrelated suite to a service it is not testing.
 *
 * **One account per currency is this fixture's shape, not the schema's.**
 * AC-172 ("a portfolio may hold two EUR accounts") is deliberately *not*
 * exercised by making every unrelated fixture ambiguous — it is proved where
 * it is the subject: `ledger/src/materialization-cash-account.integration.test.ts`
 * at the projection layer, and
 * `ledger/src/transaction-write-service.cash-account.integration.test.ts` at
 * the write layer.
 *
 * The `Db` is a parameter rather than constructor state because these suites
 * assign their handles in `beforeAll`, after module evaluation.
 */

/** The currencies every fixture portfolio gets an account in — the union of what this repo's suites transact in. */
export const CASH_FIXTURE_CURRENCIES = ["EUR", "USD", "JPY", "GBP", "CHF", "MXN"] as const;

const ids = new Map<string, string>();

function key(portfolioId: string, currency: string): string {
  return `${portfolioId}/${currency}`;
}

/** Creates one `cash_account` per currency for `portfolioId`, and records the ids for {@link cash}. */
export async function seedCashAccounts(
  ownerDb: Db,
  tenantId: string,
  portfolioId: string,
  currencies: readonly string[] = CASH_FIXTURE_CURRENCIES,
): Promise<void> {
  for (const currency of currencies) {
    const id = randomUUID();
    await ownerDb
      .insert(cashAccount)
      .values({ id, tenantId, portfolioId, name: `Compte ${currency}`, currency });
    ids.set(key(portfolioId, currency), id);
  }
}

/**
 * {@link seedCashAccounts}, for a caller that has a portfolio id but not the
 * tenant it belongs to — the shape every `api` e2e suite is in, because it
 * creates its portfolios over HTTP and never handles a `tenant_id` itself.
 *
 * The tenant is read from the `portfolio` row rather than guessed, and a
 * missing row throws: seeding accounts against a portfolio that does not exist
 * would otherwise silently produce a fixture no transaction can ever name.
 */
export async function seedCashAccountsForPortfolio(
  ownerDb: Db,
  portfolioId: string,
  currencies: readonly string[] = CASH_FIXTURE_CURRENCIES,
): Promise<void> {
  const [row] = await ownerDb
    .select({ tenantId: portfolio.tenantId })
    .from(portfolio)
    .where(eq(portfolio.id, portfolioId));
  if (row === undefined) {
    throw new Error(`cannot seed cash accounts: portfolio ${portfolioId} does not exist`);
  }
  await seedCashAccounts(ownerDb, row.tenantId, portfolioId, currencies);
}

/**
 * The account for one `(portfolio, currency)`, created on first use.
 *
 * The counterpart to {@link seedCashAccounts}, for the suites whose fixtures
 * mint portfolios inside a shared row-insert helper rather than up front in
 * `beforeAll` (`valuation`'s, mostly). Takes the caller's own `db`/`tx`, so it
 * can run as `app_web` inside the caller's `withTenant` block — `0038` grants
 * `app_web` `INSERT` on `cash_account`, and RLS is already scoped there, so
 * this needs no superuser handle and no separate transaction.
 */
export async function ensureCashAccount(
  db: Db | Tx,
  tenantId: string,
  portfolioId: string,
  currency: string,
): Promise<string> {
  const existing = ids.get(key(portfolioId, currency));
  if (existing !== undefined) return existing;
  const id = randomUUID();
  await db
    .insert(cashAccount)
    .values({ id, tenantId, portfolioId, name: `Compte ${currency}`, currency });
  ids.set(key(portfolioId, currency), id);
  return id;
}

/**
 * The seeded account for one `(portfolio, currency)`.
 *
 * Throws rather than returning `undefined` or a plausible-looking wrong id: a
 * missing fixture must fail as "you forgot to seed this portfolio", not as a
 * `23503` fifty lines later that reads like a product bug.
 */
export function cash(portfolioId: string, currency: string): string {
  const id = ids.get(key(portfolioId, currency));
  if (id === undefined) {
    throw new Error(
      `no cash-account fixture for ${portfolioId}/${currency} — call seedCashAccounts(ownerDb, tenantId, portfolioId) for that portfolio first`,
    );
  }
  return id;
}
