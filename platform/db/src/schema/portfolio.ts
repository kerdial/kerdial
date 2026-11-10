import { PORTFOLIO_ACCENT_COLORS } from "@kerdial/core-reference-data";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenant } from "./tenant.js";

/**
 * Generated **from** the TS tuple — the
 * `instrumentIconContentTypeEnum`/`INSTRUMENT_ICON_CONTENT_TYPES`
 * construction. Spreading {@link PORTFOLIO_ACCENT_COLORS} here is what makes
 * the database type and the TS list the same list by construction, so there is
 * no second copy to drift; `portfolio-icon-schema.integration.test.ts` still
 * reads `pg_enum` back, but it guards a different property — that the migration
 * actually created the type, with these members in this order.
 *
 * **The enum IS the constraint** (FR-451): "refused, never
 * coerced" is a database fact, so no CHECK is added beside `accent_color`.
 */
export const portfolioAccentColorEnum = pgEnum("portfolio_accent_color", PORTFOLIO_ACCENT_COLORS);

/**
 * `portfolio` — A named, tenant-owned container for
 * transactions. Carries **no** cash columns (cash is derived from postings
 * into `cash_balance`) and no tax-wrapper semantics — `name` is a
 * free-text label only (FR-14). Carries `tenant_id NOT NULL` per FR-45/
 * NFR-8/AC33.
 *
 * `calc_epoch` — T-30: the
 * invalidate-on-write / materialise-on-read version marker for this
 * portfolio's derived figures (`holding_state`, `cash_balance`,
 * `realized_gain`, `portfolio_daily_valuation`). Incremented once per write
 * that affects derived state, inside the same DB transaction as the write
 * (`ledger`'s `TransactionWriteService`, T-30's `recomputeAndInvalidate`).
 * Defaults to `0` so `createPortfolio` (T-17), which predates this column,
 * needs no change to its `INSERT`.
 */
export const portfolio = pgTable(
  "portfolio",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    name: text("name").notNull(),
    // `portfolio-details` FR-449 — three **independently optional**
    // presentation fields. Nullable with **no default**: a `NOT NULL DEFAULT ''`
    // would manufacture a value for every existing portfolio and make "unset"
    // unrepresentable, which is exactly what FR-453's clear-to-unset needs to
    // exist. None of the three touches `calc_epoch` (FR-459/PD-14) — they are
    // labels, and no derived figure reads them.
    broker: text("broker"),
    description: text("description"),
    accentColor: portfolioAccentColorEnum("accent_color"),
    // `portfolio-archive` FR-591, PA-L2 — a **display-only** flag: web option
    // lists, the Aperçu cards, QuickSearch and the Portefeuilles list hide or
    // group an archived portfolio, and nothing else reads it. No valuation,
    // ledger or importer figure ever filters on it. Nullable with no default,
    // so every pre-existing row reads not archived without a backfill.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    calcEpoch: bigint("calc_epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("portfolio_tenant_id_name_key").on(table.tenantId, table.name),
    // LOW-4: `name` had no
    // database-level bound at all — `ledger`'s `createPortfolio`/
    // `updatePortfolio` (then `renamePortfolio`) each carry only an
    // application-level non-empty guard
    // (mirrored between the two after this same fix round), and the HTTP DTOs
    // (`portfolioNameSchema`, `z.string().trim().min(1).max(200)`) are the
    // only thing bounding the *upper* length — bypassable by any caller that
    // reaches this table directly, or a future internal caller that
    // constructs a `CreatePortfolioParams`/`RenamePortfolioParams` without
    // going through the DTO. `btrim`, not a plain length check, so a name
    // padded with leading/trailing whitespace cannot dodge the floor by
    // hiding non-whitespace behind padding this table would otherwise store
    // verbatim — the same reasoning `portfolioNameSchema`'s own `.trim()`
    // documents (D11). `1 and 200` mirrors that schema's `min(1).max(200)`
    // exactly, so a value the HTTP boundary already accepts is never rejected
    // here, and one it already rejects was never going to reach this table
    // via that path anyway.
    //
    // **The floor was widened by `0041`.** `0028` shipped `~ '\S'` on
    // the (mistaken) claim that it rejected U+00A0 among other inputs.
    // It does not: `~ '\S'` is `[^[:space:]]`, and libc deliberately
    // does not classify U+00A0 as space. Ten codepoints passed this floor
    // (U+00A0, U+1680, U+180E, U+2007, U+200B, U+200C, U+200D, U+202F, U+2060,
    // U+FEFF), each rendering as a blank portfolio label. They are now listed
    // explicitly inside the negated class, which is why the expression is a
    // single existence test rather than the more obvious AND of a regex and a
    // `btrim` trim set — that form admits any name mixing the two families.
    // `cash_account_name_length` carries the identical expression, and
    // `name-floor-unicode-blank.integration.test.ts` asserts the two rendered
    // CHECK definitions are equal so neither can move alone.
    check(
      "portfolio_name_length",
      sql`${table.name} ~ '[^[:space:]\\u00A0\\u1680\\u180E\\u2007\\u200B\\u200C\\u200D\\u202F\\u2060\\uFEFF]' and length(btrim(${table.name})) <= 200`,
    ),
    // `portfolio-details` FR-450/FR-452, SD-6, PD-4 — `portfolio_name_length`'s
    // expression **copied character for character**, the ten explicitly-listed
    // codepoints included, with only the column and the upper bound changed.
    // Copied rather than generalised because the same decision was already made
    // twice (`portfolio_name_length`, `cash_account_name_length`) and
    // `name-floor-unicode-blank.integration.test.ts` already asserts those two
    // rendered definitions are equal — this cycle adds these two to that same
    // equality assertion, which is the only form of drift guard that holds
    // here. Reimplementing a floor from scratch is what reopened the ten-
    // codepoint hole once already (`0041`).
    //
    // **Both are NULL-safe for free**, with no branch: `NULL ~ '…'` is NULL and
    // a CHECK passes on NULL (`0035:35-38`'s rule, already relied on by
    // `watchlist_item_note_length`). So "independently optional" (FR-449) and
    // "non-blank when present" (FR-452) are one expression.
    //
    // The upper bounds are OD-1/L5's: 200 for `broker` (the `name` /
    // `cash_account.name` bound), 2000 for `description` (the
    // `transaction.note` bound). L5 requires both to be stated here **and**
    // mirrored in the shared Zod schema (`portfolioBrokerSchema` /
    // `portfolioDescriptionSchema`, PD-T3), so that a value the HTTP boundary
    // accepts is never rejected here and one it rejects never reaches this
    // table by that path.
    check(
      "portfolio_broker_length",
      sql`${table.broker} ~ '[^[:space:]\\u00A0\\u1680\\u180E\\u2007\\u200B\\u200C\\u200D\\u202F\\u2060\\uFEFF]' and length(btrim(${table.broker})) <= 200`,
    ),
    check(
      "portfolio_description_length",
      sql`${table.description} ~ '[^[:space:]\\u00A0\\u1680\\u180E\\u2007\\u200B\\u200C\\u200D\\u202F\\u2060\\uFEFF]' and length(btrim(${table.description})) <= 2000`,
    ),
  ],
);
