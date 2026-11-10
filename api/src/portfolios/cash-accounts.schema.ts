import { z } from "zod";
import { currencyCodeSchema, portfolioNameSchema } from "@kerdial/api-contracts";
import type { Decimal } from "@kerdial/core-decimal";
import type { CashAccountRecord, PortfolioCashSnapshot } from "@kerdial/ledger";
import { serializeDecimal } from "../common/decimal.schema.js";
import { serializeCalcEpoch } from "./portfolios.schema.js";

/**
 * Zod DTOs for `/portfolios/:id/cash-accounts*` (CA-14) and
 * `GET /portfolios/:id/cash` (CA-16) —
 * FR-150/FR-152/FR-160–
 * FR-163/FR-164/FR-165.
 *
 * `cash_account` itself carries **no decimal column** — its balance lives in
 * `cash_balance` — so the write DTOs below have no amount to serialise,
 * correctly or otherwise. The read DTO does, and every decimal on it crosses
 * as a **string** (NFR-12/AC53): `balance` and `total`
 * are `serializeDecimal` output, never a JSON number, and `calcEpoch` is
 * `serializeCalcEpoch`'s decimal string because `bigint` has no JSON
 * representation at all.
 */

/**
 * FR-152 verbatim: "Cash account name validation shall **mirror** the existing
 * portfolio-name rule (FR-71)". So this is not a structurally-identical copy —
 * it is literally the same `portfolioNameSchema` object
 * (`z.string().trim().min(1).max(200)`, `@kerdial/api-contracts`), which is
 * the only form of "mirror" that cannot drift when one side is later tightened.
 *
 * The two database CHECKs agree by construction as well:
 * `cash_account_name_length` is `portfolio_name_length`'s expression copied
 * expression-for-expression, regex floor included (see
 * `platform/db/src/schema/cash-account.ts`'s own note on why
 * `length(btrim(name)) >= 1` is *not* interchangeable with `name ~ '\S'`).
 *
 * `.trim()` runs before the length checks, which is what makes AC-173 true at
 * the boundary: a name of three spaces is a clean 400 here, never the raw
 * `TypeError` (i.e. a 500) it would become if it reached `createCashAccount`'s
 * own guard. That is D11's recorded fix for `POST /portfolios`, applied here
 * before it can be re-discovered.
 */
export const createCashAccountBodySchema = z.object({
  name: portfolioNameSchema,
  /**
   * OD-2: exactly one currency per account, **immutable** for the row's
   * lifetime — so this field exists on create and appears in no patch body
   * anywhere. That is enforced three deep, not once: absent from
   * {@link patchCashAccountBodySchema}, absent from `renameCashAccount`'s
   * `set` clause, and absent from `app_web`'s column-level `UPDATE` grant
   * (migration `0038`), which is the only one of the three a future caller
   * cannot forget.
   */
  currency: currencyCodeSchema,
});
export type CreateCashAccountBody = z.infer<typeof createCashAccountBodySchema>;

/**
 * `PATCH /portfolios/:id/cash-accounts/:accountId` — **exactly one** of
 * `name` (rename, FR-164) or `archived` (archive/un-archive, FR-165).
 *
 * Two deliberate refusals, both of which would otherwise be silent:
 *
 * - **An empty body is rejected**, not treated as a no-op — the same choice
 *   `updatePortfolioBodySchema`'s own refine makes (and
 *   `renamePortfolioBodySchema` made before it, for a one-mutable-field `PATCH`)
 *   (general partial-`PATCH` convention, deviated from
 *   for the same reason: a contentless write is far more likely a client bug
 *   than an intent).
 * - **Both fields at once is rejected.** `renameCashAccount` and
 *   `setCashAccountArchived` are two functions, each taking CD10's portfolio-row
 *   lock in its own transaction, so honouring both in one request would mean
 *   two transactions and a partial-apply hazard (rename commits, archive
 *   fails, the caller sees only the error). Nothing needs it: the UI
 *   of record has two separate dialogs — `CashAccountFormDialog` (create and
 *   rename) and `CashAccountArchiveDialog` (archive and un-archive) — and each
 *   sends one field. If a later cycle genuinely needs both atomically, the
 *   honest fix is one service function that takes one lock, not a controller
 *   that issues two writes and hopes.
 */
export const patchCashAccountBodySchema = z
  .object({
    name: portfolioNameSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) => (body.name !== undefined ? 1 : 0) + (body.archived !== undefined ? 1 : 0) === 1,
    { message: "supply exactly one of `name` (rename) or `archived` (archive/un-archive)" },
  );
export type PatchCashAccountBody = z.infer<typeof patchCashAccountBodySchema>;

/**
 * The create/patch response — a cash account's own identity, with no balance.
 *
 * `archived` is a boolean, not the raw `archivedAt` timestamp, so this shape
 * agrees field-for-field with the `accounts[]` entries Batch D's
 * `GET /portfolios/:id/cash` returns rather than offering a
 * second, subtly different rendering of the same row for a client to choose
 * between.
 */
export interface CashAccountResponse {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCashAccountResponse(row: CashAccountRecord): CashAccountResponse {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `GET /portfolios/:id/cash` — one cash account and what it currently holds
 * (FR-160).
 *
 * Field-for-field the same identity {@link CashAccountResponse} carries
 * (`archived` a boolean, not a raw timestamp), plus the two figures only this
 * route has.
 */
export interface CashAccountBalanceResponse {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  /** Archived accounts are **listed and counted** — archiving hides an account from pickers, never from the balance (RC4). */
  readonly archived: boolean;
  /** A decimal string, never a JSON number. `"0"` for an account with no `cash_balance` row — a missing row is exactly zero, not unknown. */
  readonly balance: string;
  /** AC-183's explicit flag. See {@link isNegativeAmount} for why the client is not left to test the string itself. */
  readonly isNegative: boolean;
}

/** FR-161's per-currency rollup. There is deliberately no separate portfolio-level `total` field: this **is** the total, and two representations of one figure can disagree. */
export interface CashCurrencyTotalResponse {
  readonly currency: string;
  readonly total: string;
  /** How many accounts were folded into {@link total} — archived ones included, which is why it can exceed the number of accounts a picker would offer. */
  readonly accountCount: number;
  readonly isNegative: boolean;
}

/** `GET /portfolios/:id/cash` — FR-160, FR-161, FR-162, FR-163; AC-180–AC-183. */
export interface PortfolioCashResponse {
  readonly accounts: readonly CashAccountBalanceResponse[];
  readonly byCurrency: readonly CashCurrencyTotalResponse[];
  /** The epoch the whole payload above was read at, in one statement (FR-162). */
  readonly calcEpoch: string;
}

/**
 * AC-183's sign test, decided once here rather than by every client.
 *
 * `lessThan(0)`, not `startsWith("-")` and not `Decimal#isNegative()`: the
 * column is `numeric(38,12)`, so a value that rounds to nothing renders as
 * `-0.000000000000` in some producers and would read as negative under a
 * string test, while `decimal.js`'s own `isNegative()` reports `true` for a
 * signed zero. Neither is what "this account is overdrawn" means.
 */
function isNegativeAmount(value: Decimal): boolean {
  return value.lessThan(0);
}

export function toPortfolioCashResponse(snapshot: PortfolioCashSnapshot): PortfolioCashResponse {
  return {
    accounts: snapshot.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      currency: account.currency,
      archived: account.archived,
      balance: serializeDecimal(account.balance),
      isNegative: isNegativeAmount(account.balance),
    })),
    byCurrency: snapshot.byCurrency.map((entry) => ({
      currency: entry.currency,
      total: serializeDecimal(entry.total),
      accountCount: entry.accountCount,
      isNegative: isNegativeAmount(entry.total),
    })),
    calcEpoch: serializeCalcEpoch(snapshot.calcEpoch),
  };
}
