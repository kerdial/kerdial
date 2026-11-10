import postgres from "postgres";

/**
 * A dependency-light view of a raw Postgres error's SQLSTATE and constraint
 * name (F2, T-37) — shields callers
 * (`api`'s global exception filter) from importing `postgres`'s own types
 * directly, the same way `platform/db` already shields `ledger`/`api` from
 * every other driver detail.
 */
export interface PgErrorInfo {
  /** The 5-character SQLSTATE, e.g. `"23505"` (unique_violation), `"23503"` (foreign_key_violation). */
  readonly sqlstate: string;
  /**
   * **`constraintName` is *a* violated constraint, not *the* violated
   * constraint**.
   *
   * When one statement violates several CHECKs on the same table, Postgres
   * reports one of them, and which one is not a property of the statement —
   * it follows the table's own constraint order, which in practice sorts by
   * name. So a later migration adding a constraint whose name sorts earlier
   * silently becomes the reported one.
   *
   * This has already happened here once, and it is the more interesting half
   * of that finding: `0046`'s `transaction_cash_account_currency_pairing` displaced
   * `transaction_target_has_cash_account` and the two beside it in
   * `cash-account-backfill.integration.test.ts`'s CA-4 red-confirms. Those
   * cases still *passed* — a `23514` was still raised — while having stopped
   * testing the constraint they were written to prove. A green assertion
   * measuring the wrong thing is worse than a red one.
   *
   * **So any test asserting a constraint by name owes one of two things:**
   * either the statement violates exactly that constraint and no other (state
   * it, as CA-4's (b)/(c)/(d) now do by carrying the degenerate pair so only
   * the totality CHECK is left to fail), or the assertion is on the SQLSTATE
   * alone. Do not add a by-name assertion whose statement violates several.
   *
   * Production code has no such obligation: `problem-json.filter.ts` and
   * `write-error.mapper.ts` match an allowlist and fall through to a generic
   * answer, so a displaced name degrades to the fallback rather than to a
   * wrong claim.
   */
  readonly constraintName: string | undefined;
}

/**
 * Unwraps a raw `postgres.PostgresError` from either its direct form or from
 * behind drizzle-orm's postgres-js driver's `DrizzleQueryError` wrapper
 * (`.cause`) — the same unwrap `ledger/instrument-service.ts`'s
 * `isUniqueViolation` already does for one constraint, generalised here as
 * shared infrastructure so a catch-all exception filter can map *any*
 * SQLSTATE, not only `23505`. Returns `undefined` for anything that isn't a
 * Postgres error at all (or at one level of wrapping).
 */
export function extractPostgresError(err: unknown): PgErrorInfo | undefined {
  const candidate =
    err instanceof postgres.PostgresError
      ? err
      : err instanceof Error && err.cause instanceof postgres.PostgresError
        ? err.cause
        : undefined;
  if (!candidate) return undefined;
  return { sqlstate: candidate.code ?? "", constraintName: candidate.constraint_name };
}
