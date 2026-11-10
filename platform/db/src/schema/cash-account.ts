import { sql } from "drizzle-orm";
import { char, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { portfolio } from "./portfolio.js";
import { tenant } from "./tenant.js";

/**
 * `cash_account` (CA-1). A **named** cash account belonging to exactly one
 * portfolio, in exactly one currency. It replaces the implicit
 * "one balance per (portfolio, currency)" identity `cash_balance` used to
 * carry: a portfolio may hold as many EUR accounts as the user cares to name
 * (AC-172), so cash identity is `(account, currency)` from here on.
 *
 * **There is no uniqueness on `(tenant_id, portfolio_id, currency)`, in any
 * form, under any name** — that is AC-172's literal requirement and L1's
 * entire reason for existing. The reviewer-checkable statement of it: *every
 * unique key on this table contains either `name` or `id`*, asserted against
 * `pg_index` in `cash-account-schema.integration.test.ts`.
 *
 * - `UNIQUE (tenant_id, portfolio_id, name)` is **unconditional** (CD11), not
 *   partial on `archived_at IS NULL`: an archived account keeps its name
 *   reserved, so un-archiving can never fail on a conflict it cannot see. The
 *   partial alternative frees the name and turns `PATCH { archived: false }`
 *   into a one-way trap, and permits two identically-named accounts in one
 *   portfolio's history — the ambiguity naming exists to remove.
 * - `UNIQUE (tenant_id, portfolio_id, id, currency)` constrains nothing about
 *   how many accounts share a currency (it contains `id`); it exists solely as
 *   the target of the four composite FKs on `transaction` (CD3) and, from
 *   `0039`, of `cash_balance`'s own (CD4). Carrying `tenant_id` and
 *   `portfolio_id` through the FK is what makes cross-tenant/cross-portfolio
 *   attribution a database fact rather than an RLS-dependent one — FK checks
 *   are not RLS-aware (F6's recorded class).
 * - `portfolio_id` is `ON DELETE no action` (V8's rule, never cascade): the
 *   final `DELETE FROM portfolio` in `deletePortfolio`'s ordered cascade stays
 *   the no-orphans proof.
 * - `currency` is immutable (OD-2) and `portfolio_id` is fixed for the row's
 *   lifetime (FR-153). Neither is enforced here — both are enforced by
 *   `0038` withholding them from `app_web`'s **column-level** `UPDATE` grant,
 *   so they are structurally unwritable rather than merely un-exposed by a
 *   DTO.
 *
 * No extra index: the picker's and the read route's
 * `WHERE tenant_id = ? AND portfolio_id = ?` is served by the leading prefix
 * of `cash_account_tenant_id_portfolio_id_name_key`.
 */
export const cashAccount = pgTable(
  "cash_account",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    name: text("name").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cash_account_tenant_id_portfolio_id_name_key").on(
      table.tenantId,
      table.portfolioId,
      table.name,
    ),
    uniqueIndex("cash_account_tenant_id_portfolio_id_id_currency_key").on(
      table.tenantId,
      table.portfolioId,
      table.id,
      table.currency,
    ),
    // Mirrors `portfolio_name_length` (migration 0028) **expression for
    // expression**, and the shape is not interchangeable with the obvious
    // `length(btrim(name)) between 1 and 200`:
    //
    //   - The floor is `~ '\S'`, never `length(btrim(...)) >= 1`. One-argument
    //     `btrim` strips only ASCII space `0x20`, not the whitespace class, so
    //     `btrim(E'\t')` has length 1 and a name of a single tab or newline
    //     would pass a `btrim`-based floor. `portfolio_name_length` made
    //     exactly this mistake in its first round and was corrected to the
    //     regex form; this is now the standing rule for every name-length
    //     floor in this repo. The discriminating inputs are asserted
    //     rejecting in `cash-account-schema.integration.test.ts` — three ASCII
    //     spaces alone cannot tell the two forms apart, which is how the weak
    //     form survives a green suite.
    //   - The ceiling keeps `btrim`, so a name padded with trailing spaces
    //     cannot dodge the 200 bound by hiding non-whitespace behind padding
    //     this table would otherwise store verbatim. `1 and 200` mirrors the
    //     DTO's own `min(1).max(200)`.
    //
    // The space class is collation-provider dependent. Verified against the
    // provider dev and CI actually run — `postgres:17`, **libc**,
    // `en_US.utf8`, pinned by an assertion in
    // `name-floor-unicode-blank.integration.test.ts`.
    //
    // **Closed by `0041`.** Through `0040` the floor was a bare
    // `~ '\S'`, and libc does not classify ten codepoints as space — U+00A0,
    // U+1680, U+180E, U+2007, U+200B, U+200C, U+200D, U+202F, U+2060, U+FEFF —
    // so a name of only one of them passed. `0038` characterised three of them
    // as an accepted gap and said closing it needed a decision taken on both
    // tables at once; `0041` takes it, on both, in one statement group.
    //
    // The fix extends the **negated class** rather than adding a `btrim` trim
    // set, and that distinction is load-bearing: a trim set strips only what it
    // lists, so replacing the regex with one reopens U+0085/U+2000/U+3000, and
    // *ANDing* the two reopens any name that mixes the families (U+00A0 passes
    // the regex half, U+3000 survives the trim set). "There exists a character
    // that is neither `[:space:]` nor one of the ten" cannot be defeated that
    // way. Escapes, never literal characters: a class of ten invisible
    // codepoints would be unreviewable and one editor normalisation would
    // silently reopen it. An ICU-collated target remains an open verification
    // item, but because the ten are listed *in addition* to `[:space:]`, such a
    // move can only make this floor stricter.
    check(
      "cash_account_name_length",
      sql`${table.name} ~ '[^[:space:]\\u00A0\\u1680\\u180E\\u2007\\u200B\\u200C\\u200D\\u202F\\u2060\\uFEFF]' and length(btrim(${table.name})) <= 200`,
    ),
    check("cash_account_currency_charset", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);
