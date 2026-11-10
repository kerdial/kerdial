import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { decimalCol } from "../decimal-column.js";
import { cashAccount } from "./cash-account.js";
import { instrument } from "./instrument.js";
import { portfolio } from "./portfolio.js";
import { session } from "./session.js";
import { tenant } from "./tenant.js";

/**
 * The twelve kinds of the event model.
 *
 * `SHARE_DISTRIBUTION` (migration `0056`) is the **8th** — a
 * cashless share distribution, the French *attribution d'actions gratuites*:
 * the share count rises, the total cost basis does not, and **no money moves
 * anywhere**. It is an additive `ALTER TYPE ... ADD VALUE` exactly as
 * `QUOTE_PROVIDER` was on `fx_rate_source` below, and it consumes one of the
 * two kind slots left before ADR-0012's escalation condition (3) — "the
 * per-kind `CHECK` matrix exceeds **10 kinds**" — trips. That headroom is
 * stated in `0056`'s own comment, which is where the ADR check belongs.
 *
 * `TRANSFER_OUT` and `TRANSFER_IN` (migration `0070`, `security-transfer`)
 * are the **9th and 10th** — the two legs of a units-only move
 * of a holding from one portfolio to another, each on `SHARE_DISTRIBUTION`'s
 * cashless row shape. They spend the last two slots: the matrix is now
 * exactly 10 kinds, **headroom 0**, so the next kind trips ADR-0012
 * condition (3) unconditionally. `0070`'s header carries the check.
 *
 * `INTEREST` (migration `0075`, `cash-interest`) is the
 * **11th** — interest earned on cash: DEPOSIT's shape (one positive cash leg
 * into a named cash account) plus DIVIDEND's existing optional withholding
 * group, classified `INCOME`. ADR-0012 condition (3) was re-stated on
 * 2026-10-21 (owner decision CI-L1): a kind beyond the tenth trips it only
 * when it adds a column on `transaction` or a per-money-leg column group.
 * `INTEREST` adds neither, so (3) does not fire; (1), (2) and (4) were
 * checked and do not fire either. `0075`'s header carries the check.
 *
 * `FEE` (migration `0077`, `portfolio-cash`) is
 * the **12th** — a standalone portfolio fee (custody, account keeping, debit
 * interest…): WITHDRAWAL's shape (one negative cash leg out of a named cash
 * account), the principal leg classified `FEE`, and an optional
 * `instrument_id` that is a reference only — no POSITION leg, no backfill.
 * It adds no column on `transaction` and no per-money-leg group, so ADR-0012
 * condition (3) as re-stated does not fire; (1), (2) and (4) do not fire
 * either. `0077`'s header carries the check.
 */
export const transactionKindEnum = pgEnum("transaction_kind", [
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "DIVIDEND",
  "DRIP",
  "CURRENCY_EXCHANGE",
  "SHARE_DISTRIBUTION",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "INTEREST",
  "FEE",
]);

/**
 * `transaction.fx_rate_source`. It was shared
 * with `fee_fx_rate_source` (dropped by `0049`) and `wht_fx_rate_source`
 * (dropped by `0079`) — each of the three FX legs was resolved
 * independently through the same `FxRateResolver` (T-18) and carried the same
 * closed set of sources.
 *
 * `QUOTE_PROVIDER` (T-32) is an additive value added
 * after the fact: a crypto-settled trade's principal leg is priced through
 * `ledger`'s `CryptoRateResolver` (a market *quote*, via the crypto
 * `QuoteProvider`), not `FxRateResolver`/ECB, since ECB will never publish a
 * crypto rate. This enum carries **no** FK to `fx_rate_daily` and no
 * FX-specific metadata, so it is already provenance-agnostic —
 * adding this value is a single additive `ALTER TYPE ... ADD VALUE`, no
 * reshaping, no new column. `fx_rate_provider_key` holds the crypto quote
 * source key (e.g. `yahoo`; `coingecko` on rows written before it was retired) and
 * `fx_rate_observed_on` the date the quote
 * was observed (LOCF) for a `QUOTE_PROVIDER`-sourced row.
 */
export const fxRateSourceEnum = pgEnum("fx_rate_source", [
  "USER_PINNED",
  "PROVIDER",
  "IMPLIED_BASE",
  "QUOTE_PROVIDER",
]);

/**
 * `transaction` — the event model. A single table with
 * a `kind` discriminator and per-kind `CHECK` constraints, rather than
 * table-per-kind (class-table inheritance) — chosen so the chronological
 * replay PMP/XIRR need stays a single ordered scan, not a seven-way
 * UNION.
 *
 * FX: three independent legs (principal, fee, withholding), each resolved by
 * `ledger/FxRateResolver` (T-18) exactly once at write time. `fx_rate` is
 * `NOT NULL` — never absent, never "assume 1". Rate direction
 * convention: `amount_base = amount_native * fx_rate` — the opposite
 * of ECB's own EUR-base publication convention, inverted at ingestion
 * (T-15), not here.
 *
 * `trg_transaction_fx_immutable` is a
 * hand-written `BEFORE UPDATE` trigger added by a follow-up custom SQL
 * migration — see `migrations/0004_transaction-fx-immutable-trigger.sql` —
 * because Drizzle's schema DSL has no first-class trigger builder.
 */
export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolio.id),
    kind: transactionKindEnum("kind").notNull(),
    // AR-5 (ADR-0002): the ledger base this row's *_base figures
    // are denominated in — a self-describing fact, so a mis-set tenant row can
    // never retroactively relabel history. Filled (or verified) from
    // `tenant.base_currency` by `trg_transaction_base_currency_fill`
    // at insert time; migration 0055 backfilled every pre-AR-5 row.
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    tradeDate: date("trade_date", { mode: "string" }).notNull(), // FR-26 exact dates
    tradeTs: timestamp("trade_ts", { withTimezone: true }), // optional intraday ordering
    seq: bigint("seq", { mode: "bigint" }).notNull(), // tiebreaker within a date, monotonic per tenant

    // Instrument leg (NULL for DEPOSIT / WITHDRAWAL / CURRENCY_EXCHANGE). On a
    // FEE it is an optional *reference* naming the holding the fee relates to:
    // no quantity, no POSITION posting (`transaction_fee_shape`).
    instrumentId: uuid("instrument_id").references(() => instrument.id),
    quantity: decimalCol("quantity", 38, 18), // always positive; sign implied by kind
    unitPrice: decimalCol("unit_price", 38, 18), // in txn_currency

    // Money leg.
    grossAmount: decimalCol("gross_amount", 38, 12).notNull(), // in txn_currency, always positive
    txnCurrency: char("txn_currency", { length: 3 }), // ISO code when settling in fiat
    txnSettlementInstrumentId: uuid("txn_settlement_instrument_id").references(() => instrument.id), // FR-66: settling in BTC etc.

    // The principal cash leg's own denomination —
    // FD1/FD2 (FT-1,
    // migration 0045; FR-230–FR-233, FR-236).
    //
    // Declared here, inside the money leg, and *not* beside the four
    // `*_cash_account_id` columns below: placement is documentation. Before
    // this cycle the principal cash leg had no denomination of its own — it
    // borrowed `txn_currency`/`gross_amount`, and `transaction_cash_account_fk`
    // carried `txn_currency`, so a USD trade required a USD cash account. The
    // real portfolio this cycle exists for (one EUR account, AAPL bought in
    // USD) was not representable at all.
    //
    // Named `cash_*` rather than `settlement_*` (FD1) because "settlement" is
    // already taken on this table by FR-66's *crypto* settlement
    // (`txn_settlement_instrument_id`) and by
    // `transaction_settled_principal_has_no_cash_account` below, which means
    // *asset*-settled. `cash_currency` pairs by name with the
    // `cash_account_id` it belongs to.
    //
    // Both nullable: they are NULL on every pre-`0045` row and stay NULL
    // forever on an asset-settled one (FR-236,
    // `transaction_settled_principal_has_no_cash_leg`). `0046`'s backfill
    // fills them for every fiat row and
    // `transaction_fiat_principal_has_cash_currency` then makes that total.
    cashCurrency: char("cash_currency", { length: 3 }), // the currency the principal cash leg actually moved in; equals the account's currency, by composite FK
    cashAmount: decimalCol("cash_amount", 38, 12), // how much of it moved; strictly positive, sign implied by kind

    // Currency-exchange leg (NULL unless kind = CURRENCY_EXCHANGE).
    targetCurrency: char("target_currency", { length: 3 }),
    targetAmount: decimalCol("target_amount", 38, 12),

    // Fees (FR-60).
    feeAmount: decimalCol("fee_amount", 38, 12),

    // Itemised transaction costs (`fee-tax-breakdown` phase 2, FR-213/FR-214
    // under L8). Four nullable components beside the total,
    // **not** replacing it: `fee_amount` keeps its meaning and its value and
    // becomes the documented *total transaction costs*, which is what lets a
    // componentless row stay valid forever and keeps every stored figure
    // bit-identical across the migration.
    //
    // `NULL` means **absent, never zero** (FR-213): a cost that was not
    // charged has no component, and `transaction_<x>_positive` below refuses a
    // zero so the two cannot be confused. `tax_amount` is the trade tax the
    // cycle exists for (a French `Impôts / Taxes`), and is distinct from
    // `withholding_amount`, which is a tax withheld at source on a DIVIDEND or
    // an INTEREST.
    brokerFeeAmount: decimalCol("broker_fee_amount", 38, 12),
    fxFeeAmount: decimalCol("fx_fee_amount", 38, 12),
    taxAmount: decimalCol("tax_amount", 38, 12),
    otherCostAmount: decimalCol("other_cost_amount", 38, 12),

    // Withholding at source (FR-9): DIVIDEND and INTEREST. Since `0079`
    // it is one amount and nothing else: denominated by the settling cash
    // account (`cash_currency`), converted at the principal's implied rate and
    // posted on the principal's account, like a cost component (L5). Its own
    // currency, rate and account were dropped with the leg they described.
    withholdingAmount: decimalCol("withholding_amount", 38, 12),

    // DRIP linkage (FR-10, AC6). Self-referencing FK, hence the lazy
    // `AnyPgColumn` callback (the table isn't defined yet at this point in
    // module evaluation).
    sourceDividendId: uuid("source_dividend_id").references((): AnyPgColumn => transaction.id),

    // Security transfer (`security-transfer`, migration
    // `0070`). All four are NULL on every kind except
    // `TRANSFER_IN` (`transaction_transfer_columns_only_on_transfer_in`).
    //
    // `transfer_source_id` points a target leg at its source `TRANSFER_OUT`
    // row — target → source, one column, mirroring DRIP's
    // `source_dividend_id`. The source row carries nothing; its partner is
    // found through `transaction_transfer_source_id_key`. NULL on a target
    // once its source portfolio has been deleted (FR-580's sever). Never
    // caller-supplied: the write service sets it to the id of a row it
    // inserted in the same DB transaction. The FK is declared by name below
    // (`transaction_transfer_source_id_fk`, `ON DELETE NO ACTION`).
    transferSourceId: uuid("transfer_source_id"),
    // The cost basis the source leg removed (`before − after` of the source
    // replay, `core/domain/src/transfer.ts`), stored because the target
    // portfolio is replayed alone. `>= 0`, not the house `> 0`: a holding
    // acquired only through free distributions carries a real cost of zero.
    // Same scale as `cost_basis_base`/`gross_amount`. None of the three is a
    // rate, source or provider key, so this is no fourth FX/provenance group.
    transferCostBase: decimalCol("transfer_cost_base", 38, 12),
    transferCostNative: decimalCol("transfer_cost_native", 38, 12),
    // The currency `transfer_cost_native` is denominated in (OD-9/ND-1) — not
    // `txn_currency`, which denominates the market value in `gross_amount`.
    transferCostCurrency: char("transfer_cost_currency", { length: 3 }),

    // FX: three independent legs, principal is mandatory.
    fxRate: decimalCol("fx_rate", 28, 12).notNull(),
    fxRateSource: fxRateSourceEnum("fx_rate_source").notNull(),
    fxRateProviderKey: text("fx_rate_provider_key"),
    fxRateObservedOn: date("fx_rate_observed_on", { mode: "string" }),
    fxRateUserInput: decimalCol("fx_rate_user_input", 28, 12),
    // The withholding leg's `wht_fx_rate*` group was dropped by `0079`:
    // the withholding now converts at the principal's implied rate.

    // Cash-account attribution — CD1/CD3 (CA-2). One transaction row can move cash in up to four
    // different currencies (principal, CURRENCY_EXCHANGE target, fee,
    // withholding), each of which is a *different* single-currency account, so
    // the attribution is one nullable column per money leg alongside the
    // currency column it belongs to — not one `cash_account_id` for the row.
    // Nullable here in `0038` because every pre-existing row is unattributed
    // until `0039`'s backfill; `0039` then adds the totality CHECKs that make
    // "a cash leg always names an account" a database fact.
    //
    // None of these four participates in any arithmetic, anywhere: they are
    // identifiers copied down to the postings, exactly like `fx_rate_applied`
    // is copied, and they change no amount and no rate.
    cashAccountId: uuid("cash_account_id"), // principal leg, in txn_currency
    targetCashAccountId: uuid("target_cash_account_id"), // CURRENCY_EXCHANGE target leg, in target_currency
    // `wht_cash_account_id` (the withholding leg's own account) was dropped by
    // `0079`: the withholding settles on `cash_account_id`.

    // CSV import idempotency — ID7 (CI-4, migration 0042), locked by the OD-7 amendment
    // (real per-row idempotency in this cycle, not deferred).
    //
    // `"<recipe>:<sha256hex>"` — a hash of the source row's own economic
    // fields (kind, trade date, resolved instrument, quantity, unit price,
    // amount, currency, fees, withholding, destination cash account) plus a
    // within-file occurrence ordinal, so two legitimately identical same-day
    // trades in one file produce two distinct fingerprints and both import,
    // while re-importing the same file recomputes both and skips both.
    //
    // Nullable, and it stays nullable: every manually-entered transaction
    // carries NULL and is therefore neither blocked by an import nor able to
    // block one. It participates in no arithmetic anywhere — it is an
    // identifier, like the four `*_cash_account_id` columns above.
    //
    // A column here rather than a side table (decisively): `0007`
    // grants `transaction` to `app_web` at **table** level, so no new GRANT
    // is needed; `transaction` already carries `tenant_id NOT NULL` with RLS
    // enabled and forced; and the fingerprint dies with its row, so there is
    // no `ON DELETE CASCADE` to write, no `TRANSACTION_FK_HANDLING` entry to
    // add, and no tombstone that would make a legitimately re-imported row
    // skip forever.
    //
    // **`editTransaction` deliberately leaves this column alone (F-E,
    // CI-14).** Editing an imported row's date or amount desynchronises the
    // stored fingerprint from the row it now describes, so a later re-import
    // of the original file **skips** the edited row instead of restoring it.
    // That is the decision, not an oversight: the row still originates from
    // that source line and the user changed it on purpose, whereas clearing
    // the fingerprint on edit would make the same re-import *duplicate* the
    // row. Because the opposite expectation ("re-importing repairs what I
    // broke") is the natural one, the UI says so — the exact wording is
    // `IMPORT_EDITED_ROW_NOTICE` in `core/api-contracts`, and
    // `apply.non-regression.integration.test.ts` is what proves the skip.
    importFingerprint: text("import_fingerprint"),

    note: text("note"),
    /**
     * **The user's own reference for this transaction**
     * (migration `0057`) — a broker's order number, a statement line, whatever
     * the person reconciling by hand actually quotes.
     *
     * Three properties, each of them a recorded decision rather than
     * an omission:
     *
     *  - **user-supplied, never generated.** A reference this product minted
     *    would reconcile against nothing — the value of the field is that it
     *    matches a string on a document the product never sees;
     *  - **not unique, and no index.** Two brokers' numbering schemes may
     *    collide, and a uniqueness constraint would reject the user's real
     *    data. There is deliberately no `uniqueIndex` here, unlike
     *    `import_fingerprint` above, whose whole purpose is collision;
     *  - **free text**, bounded only by {@link TRANSACTION_REFERENCE_MAX_LENGTH}
     *    and the blank floor below.
     *
     * Like `note` and `import_fingerprint` it participates in no arithmetic
     * anywhere and is copied to no posting: it is a label on the row.
     */
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBySessionId: uuid("updated_by_session_id").references(() => session.id),
  },
  (table) => [
    // `seq` is documented as monotonic per tenant and, with `trade_date`,
    // defines the replay order — a duplicate would make that order (and so
    // PMP and realized gain) undefined. Migration 0013; see its comment for
    // why this is a constraint rather than only an advisory lock in the write
    // path.
    uniqueIndex("transaction_tenant_id_seq_key").on(table.tenantId, table.seq),
    // The two replay orders.
    index("transaction_tenant_portfolio_trade_date_seq_idx").on(
      table.tenantId,
      table.portfolioId,
      table.tradeDate,
      table.seq,
    ),
    index("transaction_tenant_instrument_trade_date_seq_idx").on(
      table.tenantId,
      table.instrumentId,
      table.tradeDate,
      table.seq,
    ),
    // CSV import idempotency's backstop (CI-4, migration 0042).
    //
    // `planImport` reads the whole file's fingerprints in one batched SELECT
    // and marks the matches `SKIP / ALREADY_IMPORTED`, but that read is a
    // TOCTOU read: two concurrent imports of the same file (two API replicas,
    // past the per-tenant concurrency cap) would both see no match. This index
    // is what closes it — the loser takes a `23505` on this name, which `apply`
    // maps to `SKIP / ALREADY_IMPORTED` for that row rather than failing the
    // import. It is therefore a correctness mechanism, not an optimisation.
    //
    // The key is scoped because **a unique index is enforced across every row
    // regardless of RLS**: on `import_fingerprint` alone, two portfolios — or
    // two tenants — importing the same file would collide, which is a
    // correctness bug and an existence oracle for another tenant's data at
    // once. `portfolio_id` is what actually prevents both (a portfolio belongs
    // to exactly one tenant, so it already partitions by tenant); `tenant_id`
    // leads the key for the reason it leads this table's two other composite
    // indexes — every read is tenant-scoped — and so the key stays correct
    // even if a portfolio were ever re-parented. The original rationale attributes the
    // cross-tenant half to `tenant_id`; that is a slightly stronger claim than
    // the columns support, and the difference is recorded here rather than
    // quietly reproduced.
    //
    // Partial on `import_fingerprint IS NOT NULL` so it says nothing at all
    // about the manually-entered rows (every row predating `0042` among them),
    // all of which carry NULL. (A plain unique index would already tolerate
    // them — NULLs never collide by default — but the predicate keeps the
    // index off those rows entirely and states the intent.)
    uniqueIndex("transaction_import_fingerprint_key")
      .on(table.tenantId, table.portfolioId, table.importFingerprint)
      .where(sql`${table.importFingerprint} IS NOT NULL`),
    // Security transfer's link (migration `0070`). **`NO
    // ACTION`, not `SET NULL`**: every child FK of a portfolio's rows stays
    // `no action` so `deletePortfolio`'s final `DELETE` is the no-orphans
    // proof, and a delete path that removed a source without handling its
    // partner raises `23503` instead of quietly severing the pair. A plain
    // (not tenant-composite) FK, because the value is never caller-supplied.
    foreignKey({
      name: "transaction_transfer_source_id_fk",
      columns: [table.transferSourceId],
      foreignColumns: [table.id],
    }).onDelete("no action"),
    // One target per source (FR-565), and the source → target lookup path.
    // `tenant_id` leads for the reason `transaction_import_fingerprint_key`
    // gives above; partial so it says nothing about the other rows.
    uniqueIndex("transaction_transfer_source_id_key")
      .on(table.tenantId, table.transferSourceId)
      .where(sql`${table.transferSourceId} IS NOT NULL`),
    // The per-kind CHECK table (illustrative, not exhaustive elsewhere —
    // fully enumerated here).
    check(
      "transaction_buy_sell_shape",
      sql`${table.kind} NOT IN ('BUY', 'SELL') OR (
        ${table.instrumentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL
        AND ${table.unitPrice} IS NOT NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
      )`,
    ),
    check(
      "transaction_deposit_withdrawal_shape",
      sql`${table.kind} NOT IN ('DEPOSIT', 'WITHDRAWAL') OR (
        ${table.txnCurrency} IS NOT NULL
        AND ${table.instrumentId} IS NULL
        AND ${table.quantity} IS NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
      )`,
    ),
    check(
      "transaction_dividend_shape",
      // `fee_amount IS NULL` is the conjunct this CHECK was
      // missing. The invariant "a DIVIDEND's only TAX posting is its
      // withholding leg" was application-enforced only
      // (`transaction-create.schema.ts:360` plus
      // `TransactionCashLegNotAddableError`), so a row written past the
      // application — manual SQL, a future import path, an `app_owner`
      // maintenance session — could carry a cost component that the dividend
      // aggregate would misattribute.
      //
      // The cost-component columns need no conjuncts of their own: they are
      // bound to the total by `transaction_cost_components_sum_to_fee_amount`,
      // so forbidding `fee_amount` forbids them transitively. Stated rather
      // than repeated, because five more conjuncts would read as five more
      // rules.
      //
      // The read-time guard stays. `dividend-summary-service.ts` still
      // detects `count(*) filter (where t.fee_amount is not null)` on DIVIDEND
      // rows and refuses with a 422 rather than serving a silently-wrong
      // figure (DV11) — this CHECK makes that unreachable for rows written
      // from now on, and says nothing about rows that already exist in a
      // database migrated before it.
      sql`${table.kind} <> 'DIVIDEND' OR (
        ${table.instrumentId} IS NOT NULL
        AND ${table.quantity} IS NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
        AND ${table.feeAmount} IS NULL
      )`,
    ),
    check(
      "transaction_drip_shape",
      sql`${table.kind} <> 'DRIP' OR (
        ${table.instrumentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL
        AND ${table.unitPrice} IS NOT NULL
        AND ${table.sourceDividendId} IS NOT NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
      )`,
    ),
    check(
      "transaction_currency_exchange_shape",
      sql`${table.kind} <> 'CURRENCY_EXCHANGE' OR (
        ${table.txnCurrency} IS NOT NULL
        AND ${table.targetCurrency} IS NOT NULL
        AND ${table.targetAmount} IS NOT NULL
        AND ${table.instrumentId} IS NULL
        AND ${table.quantity} IS NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.sourceDividendId} IS NULL
      )`,
    ),
    /**
     * **The 8th kind's shape** — `SHARE_DISTRIBUTION`, migration `0056`.
     * A cashless share distribution (*attribution d'actions
     * gratuites*): units arrive, **no money moves**, and the total cost basis
     * is unchanged.
     *
     * Three groups of columns, and each one is a statement about the event:
     *
     *  - **the instrument leg is real** — `instrument_id` and `quantity` are
     *    both required, because the whole event is "this holding grew by this
     *    many units";
     *  - **there is no price** — `unit_price IS NULL`. A free share has no
     *    price per unit, and `gross_amount` carries the *market value* the
     *    source supplied instead. That value keeps
     *    `transaction_gross_amount_positive` satisfied **honestly** rather
     *    than relaxed: F1/T-38's two positivity CHECKs are untouched by this
     *    kind, which is the entire reason it exists instead of a zero-cost
     *    `BUY`;
     *  - **there is no cash leg of any kind** — `cash_account_id`,
     *    `cash_currency` and `cash_amount` are all NULL, and so is every cost
     *    column. `txn_currency` stays non-NULL: it denominates
     *    `gross_amount` and satisfies
     *    `transaction_currency_xor_settlement_instrument` (the alternative,
     *    settling in an instrument, would be a *second instrument leg* and
     *    would trip ADR-0012 condition (2)).
     *
     * The target and DRIP columns are NULL for the same reason they are on
     * every other instrument-leg kind.
     *
     * **`kind::text`, not `kind`, and it is load-bearing.** Postgres refuses
     * to *use* an enum value in the same transaction that added it
     * (`55P04 unsafe use of new value`), and drizzle's migrator runs **every**
     * pending migration inside one transaction — so splitting the `ALTER
     * TYPE` into its own migration file would not help either. Comparing the
     * column's text rendering never mentions the enum value to the enum, so
     * `0056` applies in a single pass. The comparison is exact: `kind` is an
     * enum, so its text rendering is one of eight known labels with no
     * padding or case ambiguity.
     */
    check(
      "transaction_share_distribution_shape",
      sql`${table.kind}::text <> 'SHARE_DISTRIBUTION' OR (
        ${table.instrumentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL
        AND ${table.txnCurrency} IS NOT NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
        AND ${table.cashAccountId} IS NULL
        AND ${table.cashCurrency} IS NULL
        AND ${table.cashAmount} IS NULL
        AND ${table.feeAmount} IS NULL
        AND ${table.withholdingAmount} IS NULL
      )`,
    ),
    /**
     * **The 9th and 10th kinds' shapes** — `TRANSFER_OUT` (source leg) and
     * `TRANSFER_IN` (target leg), migration `0070`, `security-transfer`.
     * Both are `transaction_share_distribution_shape` above with the
     * label changed: an instrument leg, a `txn_currency` denominating the
     * market value in `gross_amount`, and no price, no cash leg, no cost.
     *
     * The target additionally requires its three carried-cost columns and
     * refuses to point at itself. The OUT shape does not repeat the four
     * transfer columns: `transaction_transfer_columns_only_on_transfer_in`
     * forces them NULL on every other kind, `TRANSFER_OUT` included.
     *
     * `kind::text` for the reason stated on the 8th kind's CHECK (`55P04`).
     *
     * What no CHECK can state — the referenced row is a `TRANSFER_OUT`, the
     * two legs are in different portfolios, and the target's instrument,
     * quantity, date, amount, currency and rate equal the source's — is held
     * by `TransactionWriteService`, the only writer of `TRANSFER_IN`.
     */
    check(
      "transaction_transfer_out_shape",
      sql`${table.kind}::text <> 'TRANSFER_OUT' OR (
        ${table.instrumentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL
        AND ${table.txnCurrency} IS NOT NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
        AND ${table.cashAccountId} IS NULL
        AND ${table.cashCurrency} IS NULL
        AND ${table.cashAmount} IS NULL
        AND ${table.feeAmount} IS NULL
        AND ${table.withholdingAmount} IS NULL
      )`,
    ),
    check(
      "transaction_transfer_in_shape",
      sql`${table.kind}::text <> 'TRANSFER_IN' OR (
        ${table.instrumentId} IS NOT NULL
        AND ${table.quantity} IS NOT NULL
        AND ${table.txnCurrency} IS NOT NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
        AND ${table.cashAccountId} IS NULL
        AND ${table.cashCurrency} IS NULL
        AND ${table.cashAmount} IS NULL
        AND ${table.feeAmount} IS NULL
        AND ${table.withholdingAmount} IS NULL
        AND ${table.transferCostBase} IS NOT NULL
        AND ${table.transferCostNative} IS NOT NULL
        AND ${table.transferCostCurrency} IS NOT NULL
        AND (${table.transferSourceId} IS NULL OR ${table.transferSourceId} <> ${table.id})
      )`,
    ),
    check(
      "transaction_transfer_columns_only_on_transfer_in",
      sql`${table.kind}::text = 'TRANSFER_IN' OR (
        ${table.transferSourceId} IS NULL
        AND ${table.transferCostBase} IS NULL
        AND ${table.transferCostNative} IS NULL
        AND ${table.transferCostCurrency} IS NULL
      )`,
    ),
    // `>= 0`, deliberately unlike every other amount CHECK here:
    // a carried cost of exactly zero is real (units that only ever arrived
    // free), and "absent" is NULL, which the target shape forbids.
    check(
      "transaction_transfer_cost_non_negative",
      sql`${table.transferCostBase} IS NULL OR (${table.transferCostBase} >= 0 AND ${table.transferCostNative} >= 0)`,
    ),
    /**
     * **The 11th kind's shape** — `INTEREST`, migration `0075`,
     * `cash-interest`. DEPOSIT's shape (a `txn_currency`, a named
     * cash account, no instrument leg, no target, no DRIP link) plus
     * DIVIDEND's optional withholding group, with `fee_amount IS NULL` stated
     * rather than left to the DTO (the lesson recorded on
     * `transaction_dividend_shape`; it forbids the cost components
     * transitively). `cash_account_id IS NOT NULL` repeats a totality CHECK on
     * purpose, so the shape reads whole.
     *
     * The withholding conjunct (rewritten by `0079`): the withholding
     * is denominated by the settling account, so it is compared with the
     * principal cash amount it reduces — `cash_amount`, NOT NULL on every
     * INTEREST (`cash_account_id` → `cash_currency` → `cash_amount` through
     * the pairing CHECKs). Exact in every currency combination; before `0079`
     * it was exact only when the withholding shared `txn_currency`.
     *
     * `kind::text` for the reason stated on the 8th kind's CHECK (`55P04`).
     */
    check(
      "transaction_interest_shape",
      sql`${table.kind}::text <> 'INTEREST' OR (
        ${table.txnCurrency} IS NOT NULL
        AND ${table.cashAccountId} IS NOT NULL
        AND ${table.instrumentId} IS NULL
        AND ${table.quantity} IS NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
        AND ${table.feeAmount} IS NULL
        AND (
          ${table.withholdingAmount} IS NULL
          OR ${table.withholdingAmount} < ${table.cashAmount}
        )
      )`,
    ),
    /**
     * **The 12th kind's shape** — `FEE`, migration `0077`, `portfolio-cash`.
     * WITHDRAWAL's shape (a `txn_currency`, a named cash account,
     * no quantity, no unit price, no target, no DRIP link), with
     * `fee_amount IS NULL` and `withholding_amount IS NULL` stated rather than
     * left to the DTO (the same lesson). `instrument_id` is **deliberately
     * absent**: a FEE may reference an instrument (PC-L14) or not, and the FK
     * guards a non-null value.
     *
     * `kind::text` for the reason stated on the 8th kind's CHECK (`55P04`).
     */
    check(
      "transaction_fee_shape",
      sql`${table.kind}::text <> 'FEE' OR (
        ${table.txnCurrency} IS NOT NULL
        AND ${table.cashAccountId} IS NOT NULL
        AND ${table.quantity} IS NULL
        AND ${table.unitPrice} IS NULL
        AND ${table.targetCurrency} IS NULL
        AND ${table.targetAmount} IS NULL
        AND ${table.sourceDividendId} IS NULL
        AND ${table.feeAmount} IS NULL
        AND ${table.withholdingAmount} IS NULL
      )`,
    ),
    // Global constraint (FR-66/AC52's crypto-settlement path): a
    // transaction settles either in an ISO fiat currency or in a settlement
    // instrument (e.g. BTC), never both, never neither.
    check(
      "transaction_currency_xor_settlement_instrument",
      sql`(${table.txnCurrency} IS NOT NULL) <> (${table.txnSettlementInstrumentId} IS NOT NULL)`,
    ),
    // F1 (T-38): every quantity/amount
    // column on this table is documented "always positive" (see each
    // column's own comment above), and `TransactionWriteService`'s
    // `assertPositiveDecimal`/`record*` methods enforce that on every
    // *creation* path — but `editTransaction` issues a plain `UPDATE` built
    // from `TransactionEdit` (any column except `id`/`tenant_id`/`seq`) with
    // no such check of its own, so a negative or zero value reached only
    // this far was accepted verbatim, corrupting PMP replay and every
    // figure derived from it. These six `CHECK`s are the database-level
    // enforcement layer (mirroring the per-kind shape checks above, each
    // guarded `IS NULL OR` for the columns that are legitimately absent for
    // some kind); `grossAmount` is already `NOT NULL`, so its check carries
    // no such guard. Every existing writer (`record*`, `editTransaction`'s
    // own new `assertPositiveDecimal` calls, `transactions.schema.ts`'s
    // `editTransactionBodySchema`) already only ever produces a positive
    // value here, so this is additive, not a behaviour change for any
    // correctly-behaving caller.
    check("transaction_quantity_positive", sql`${table.quantity} IS NULL OR ${table.quantity} > 0`),
    check(
      "transaction_unit_price_positive",
      sql`${table.unitPrice} IS NULL OR ${table.unitPrice} > 0`,
    ),
    check("transaction_gross_amount_positive", sql`${table.grossAmount} > 0`),
    check(
      "transaction_target_amount_positive",
      sql`${table.targetAmount} IS NULL OR ${table.targetAmount} > 0`,
    ),
    check(
      "transaction_fee_amount_positive",
      sql`${table.feeAmount} IS NULL OR ${table.feeAmount} > 0`,
    ),
    // FR-213, in `transaction_fee_amount_positive`'s idiom above: absent is
    // NULL, and zero is refused, so "no broker fee" has exactly one spelling.
    check(
      "transaction_broker_fee_amount_positive",
      sql`${table.brokerFeeAmount} IS NULL OR ${table.brokerFeeAmount} > 0`,
    ),
    check(
      "transaction_fx_fee_amount_positive",
      sql`${table.fxFeeAmount} IS NULL OR ${table.fxFeeAmount} > 0`,
    ),
    check(
      "transaction_tax_amount_positive",
      sql`${table.taxAmount} IS NULL OR ${table.taxAmount} > 0`,
    ),
    check(
      "transaction_other_cost_amount_positive",
      sql`${table.otherCostAmount} IS NULL OR ${table.otherCostAmount} > 0`,
    ),
    /**
     * FR-214 under L8 — **non-total by necessity, and non-vacuous by
     * construction**.
     *
     * Two disjuncts, and both are load-bearing:
     *
     *  - the first is exactly the **legacy shape** (no components at all), true
     *    of every row written before this migration, which is what makes the
     *    constraint satisfiable at the instant it is added and keeps a
     *    componentless row valid permanently under L8;
     *  - the second requires `fee_amount IS NOT NULL` **before** comparing.
     *    Without that conjunct a row carrying components beside a NULL
     *    `fee_amount` evaluates `NULL = <sum>` → NULL → and a CHECK passes on
     *    NULL. It would be a constraint that reads as an invariant and enforces
     *    nothing on exactly the shape it exists for.
     *
     * `coalesce(…, 0)` per component rather than a sum over non-nulls: a row
     * may itemise any subset, and the absent ones must contribute nothing
     * without turning the whole sum NULL.
     */
    check(
      "transaction_cost_components_sum_to_fee_amount",
      sql`(${table.brokerFeeAmount} IS NULL AND ${table.fxFeeAmount} IS NULL AND ${table.taxAmount} IS NULL AND ${table.otherCostAmount} IS NULL) OR (${table.feeAmount} IS NOT NULL AND ${table.feeAmount} = coalesce(${table.brokerFeeAmount},0) + coalesce(${table.fxFeeAmount},0) + coalesce(${table.taxAmount},0) + coalesce(${table.otherCostAmount},0))`,
    ),
    check(
      "transaction_withholding_amount_positive",
      sql`${table.withholdingAmount} IS NULL OR ${table.withholdingAmount} > 0`,
    ),
    // C (final narrow fix round, feature/api-transactions): defence in depth
    // for FR-66/AC52's "a trade cannot be settled in the instrument it
    // acquires" — `recordSettledBuy` already rejects this shape at creation
    // (own `TypeError`), and `editTransaction` now rejects it too
    // (`TransactionSelfSettledError`), but neither of those is a database
    // constraint, so an out-of-band writer (a hand-run `UPDATE`, a future
    // call site that forgets the application-level check) was not stopped —
    // a row with `instrument_id = txn_settlement_instrument_id` represents
    // net free units acquired at zero cost basis. Guarded
    // `txn_settlement_instrument_id IS NULL OR` rather than comparing with
    // `IS DISTINCT FROM` outright: every other kind (and a fiat-priced
    // BUY/SELL/DRIP) always has `txn_settlement_instrument_id` NULL, and this
    // check must stay a no-op for all of them. Whenever it is non-NULL,
    // `instrument_id` is always non-NULL too (`transaction_buy_sell_shape`
    // above plus `transaction_currency_xor_settlement_instrument`'s XOR force
    // `kind = 'BUY'` with a real acquired instrument), so no equivalent
    // `instrument_id IS NULL OR` guard is needed on that side. Every existing
    // writer already only ever produces a row that satisfies this, so this is
    // purely additive — verified against this package's own integration test
    // fixtures/seed data, none of which write `transaction` rows directly.
    check(
      "transaction_instrument_not_self_settled",
      sql`${table.txnSettlementInstrumentId} IS NULL OR ${table.instrumentId} <> ${table.txnSettlementInstrumentId}`,
    ),

    // ---------------------------------------------------------------------
    // Cash-account attribution — CD3 (CA-2, migration 0038).
    //
    // Four composite FKs, one per money leg, each against
    // `cash_account (tenant_id, portfolio_id, id, currency)`. The composite
    // form is the mechanism, not a stylistic choice: it delivers three
    // requirements structurally, with no trigger and no application check.
    //
    //   - FR-155 (same portfolio): `portfolio_id` in the FK is the
    //     *transaction's own* column, so another portfolio's account simply is
    //     not in the referenced set.
    //   - Cross-tenant (F6's recorded class — referential-integrity checks are
    //     **not** RLS-aware, so a cross-tenant id could otherwise be named):
    //     `tenant_id` is in the FK, taken from the transaction's own row.
    //   - OD-2's currency scoping: `currency` is in the FK, so attributing a
    //     EUR fee leg to a USD account is refused by the database.
    //
    // A plain `cash_account_id`-only FK would deliver none of the three.
    //
    // **The principal one is re-pointed by `0046`** onto `cash_currency`
    // instead of `txn_currency` (FD3; FT-2, FR-232, FR-246). Same name, same referenced unique key,
    // one column changed — all three guarantees above survive verbatim and for
    // the same reason; what changes is *which* currency it scopes by, the
    // account's own instead of the trade's. That is the entirety of phase 1's
    // semantic change, and it is still a database fact with no trigger and no
    // application-only rule. The other three composite FKs are untouched by
    // phase 1 (FR-237): four before, four after.
    foreignKey({
      name: "transaction_cash_account_fk",
      columns: [table.tenantId, table.portfolioId, table.cashAccountId, table.cashCurrency],
      foreignColumns: [
        cashAccount.tenantId,
        cashAccount.portfolioId,
        cashAccount.id,
        cashAccount.currency,
      ],
    }),
    foreignKey({
      name: "transaction_target_cash_account_fk",
      columns: [table.tenantId, table.portfolioId, table.targetCashAccountId, table.targetCurrency],
      foreignColumns: [
        cashAccount.tenantId,
        cashAccount.portfolioId,
        cashAccount.id,
        cashAccount.currency,
      ],
    }),

    // **The MATCH SIMPLE hazard, and how the next three CHECKs close it.** A
    // multi-column FK with default `MATCH SIMPLE` semantics is **not checked
    // at all** when *any* of its columns is NULL. `tenant_id`/`portfolio_id`
    // are `NOT NULL`, so the exposure is precisely: an account id set while
    // its paired currency column is NULL skips the FK entirely — an arbitrary
    // uuid, from any tenant, accepted silently. These pairing CHECKs make that
    // shape unrepresentable, so "the FK checked it" is true for every row that
    // exists rather than for every row that happened to be complete.
    //
    // The principal leg needed no such pairing CHECK while its FK carried
    // `txn_currency`: that column is constrained by
    // `transaction_currency_xor_settlement_instrument` above, and
    // `transaction_settled_principal_has_no_cash_account` below already forbade
    // the only shape in which it is NULL from naming an account.
    // **Phase 1 is what opens that hole** — `cash_currency` inherits neither
    // protection, so re-pointing the FK onto it (`0046`) would let a
    // `cash_account_id` beside a NULL `cash_currency` skip the FK entirely.
    // `transaction_cash_account_currency_pairing` below is the closure
    // (FR-247), and `transaction_cash_amount_currency_pairing` completes it.
    // `transaction_wht_cash_account_pairing` dropped with its columns (`0079`).
    check(
      "transaction_target_cash_account_pairing",
      sql`(${table.targetCashAccountId} IS NULL) OR (${table.targetCurrency} IS NOT NULL)`,
    ),

    // Pre-existing gap, closed here because the
    // pairing CHECKs above now depend on it: an amount without its currency
    // made `expandPostings` throw `PostingExpansionError` on every subsequent
    // write to that portfolio, and — new this cycle — would let MATCH SIMPLE
    // skip the fee/withholding composite FK for that leg. Every existing
    // writer already produces the paired shape (`emitFee`/`emitWithholding`
    // both `required(...)` the currency), so this is additive.
    // **Retired by `0048`.** It read
    // `(fee_amount IS NULL) = (fee_currency IS NULL)`, and phase 2's write path
    // (FT-36's `CostInput`) denominates a cost by the settling account under
    // L5 — so it writes a `fee_amount` with **no** `fee_currency`, which this
    // CHECK refused. It is the only one of the four fee objects that does:
    // `transaction_fee_cash_account_pairing` and
    // `transaction_fee_has_cash_account` are both satisfied when
    // `fee_currency` is NULL, and `transaction_fee_cash_account_fk` is MATCH
    // SIMPLE, so it is skipped entirely when its columns are NULL. The other
    // three therefore stay until a later migration drops the columns with them —
    // keeping the MATCH SIMPLE closure and the FK's tenant/portfolio/currency
    // guarantee for every row that still names a fee account.
    // `transaction_withholding_amount_currency_pairing` — dropped by `0079`
    // with `withholding_currency`, as `0048` dropped the fee's for the
    // same reason: the withholding is now denominated by the settling account.

    // FR-157: an asset-settled principal leg (a BUY paid for in BTC) moves no
    // cash at all, so it never names a cash account. Neither the cost leg nor
    // (since `0079`) the withholding has a currency or an account of its
    // own: `0049` and `0079` took them away, so after L5 there is nothing to
    // denominate either by on a row that moved no cash, which is what
    // the second CHECK below holds for the cost.
    check(
      "transaction_settled_principal_has_no_cash_account",
      sql`${table.txnSettlementInstrumentId} IS NULL OR ${table.cashAccountId} IS NULL`,
    ),

    /**
     * **`0050` — the rule already established, now held by the
     * database rather than only by the service.**
     *
     * `recordSettledBuy` and `resolveCostLeg` both refuse this shape, but
     * between `0048` and `0049` every constraint that happened
     * to catch it was dropped and none replaced them: a direct INSERT of an
     * asset-settled BUY carrying a `fee_amount` succeeded cleanly. The row is
     * storable and unexpandable, and the two consumers disagree about it —
     * `expandPostings` throws (breaking every later write to that portfolio,
     * because `regeneratePostings` runs portfolio-wide) while
     * `position-replay.ts` silently drops the cost from the basis. A wrong
     * cost basis with no error is the worse half.
     *
     * Only `fee_amount` is named: `transaction_cost_components_sum_to_fee_amount`
     * already requires a total whenever any component is present, so this
     * forbids a breakdown transitively.
     *
     * **`0050` adds it `NOT VALID`, which Drizzle cannot express** — `check()`
     * has no validated/not-validated distinction, so the generated snapshot
     * records a plain CHECK and the hand-written migration is authoritative
     * about that one property. The difference is deliberate and load-bearing:
     * the shape was **legal before phase 2**, when a fee carried its own
     * currency and cash account (FR-60/AC49) and FR-157 constrained only the
     * principal leg — `cash-account-backfill.integration.test.ts`'s fixture
     * still holds such a row on purpose. Adding this validated fails to apply
     * against it. `NOT VALID` still checks every INSERT and UPDATE, which is the
     * gap in question; it only skips the retroactive full-table scan.
     * `transaction-settled-principal-no-cost.integration.test.ts` asserts the
     * `convalidated = false` half so this comment cannot quietly become false.
     */
    check(
      "transaction_settled_principal_has_no_cost",
      sql`${table.txnSettlementInstrumentId} IS NULL OR ${table.feeAmount} IS NULL`,
    ),

    // ---------------------------------------------------------------------
    // The principal cash leg's own shape — rows 1–4 (FT-1, migration `0045`; FR-233, FR-236,
    // FR-247, FR-250).
    //
    // All four are **additive**: every one of them is true of every row that
    // existed the instant `0045` ran, because both new columns are NULL there
    // and each is satisfied by a NULL disjunct. The three that are *false* of
    // a pre-migration row — the account/currency pairing, the
    // CURRENCY_EXCHANGE pinning and the fiat-principal totality — are in
    // `0046`, after the backfill, on `0038`/`0039`'s precedent and for the
    // reason stated at the totality block below. Putting them here would make
    // the constraint set correct and unsatisfiable at once.
    check(
      "transaction_cash_amount_positive",
      sql`${table.cashAmount} IS NULL OR ${table.cashAmount} > 0`,
    ),
    check(
      "transaction_cash_amount_currency_pairing",
      sql`(${table.cashAmount} IS NULL) = (${table.cashCurrency} IS NULL)`,
    ),
    // The degenerate case (FR-250): when the cash leg moved in the trade's own
    // currency there is nothing to convert, so the two amounts must agree —
    // which is also what makes the expander's degenerate fast path
    // (`posting-expander.ts`, FD6) provably equivalent to the old code.
    //
    // **`IS DISTINCT FROM`, not `<>`.** On an asset-settled row both columns
    // are NULL and `NULL <> NULL` is NULL, which a CHECK treats as satisfied —
    // a vacuous pass. `IS DISTINCT FROM` makes it a real one. The leading
    // `cash_currency IS NULL` disjunct already covers that row today; the
    // constraint must not depend on disjunct order to be sound.
    check(
      "transaction_cash_degenerate_equals_gross",
      sql`${table.cashCurrency} IS NULL OR ${table.cashCurrency} IS DISTINCT FROM ${table.txnCurrency} OR ${table.cashAmount} = ${table.grossAmount}`,
    ),
    // FR-236, the exact analogue of `transaction_settled_principal_has_no_cash_account`
    // above and deliberately **not** a replacement for it: an asset-settled
    // principal leg (a BUY paid for in BTC) moves no cash, so it has no cash
    // denomination either. Keeping both means every by-name assertion written
    // against the older one still means what it meant.
    check(
      "transaction_settled_principal_has_no_cash_leg",
      sql`${table.txnSettlementInstrumentId} IS NULL OR (${table.cashCurrency} IS NULL AND ${table.cashAmount} IS NULL)`,
    ),

    // ---------------------------------------------------------------------
    // The **totality** CHECKs — migration `0039`, after its backfill (CA-4,
    // FR-158/AC-178). One per cash-emitting currency column, so
    // the statement "a leg that moved cash names the account it moved it in"
    // is total rather than true-of-the-rows-someone-looked-at.
    //
    // They are deliberately **not** in `0038`: they are false of every
    // pre-`0038` row, so they can only be added once the backfill has run.
    // That ordering is the point — `ALTER TABLE … ADD CONSTRAINT` validates
    // the existing rows, so a backfill that missed one rolls `0039` back
    // whole, in production as much as in CI. The constraint *is* the proof;
    // the test (`cash-account-backfill.integration.test.ts`) proves only that
    // real rows existed for it to be total over.
    //
    // The pairing CHECKs above are the converse implication (an account
    // implies its currency); these are the forward one (a currency implies
    // its account). Both directions are needed: the pairing CHECKs close the
    // MATCH SIMPLE hole, these close the unattributed-leg hole.
    //
    // **`0056` adds the one exemption either of them has ever
    // had**, to this one and to `transaction_fiat_principal_has_cash_currency`
    // below. Both read "a transaction denominated in a currency moved cash in
    // an account", and until the 8th kind that was true by construction: every
    // kind with a `txn_currency` had a money leg. A cashless share
    // distribution has a `txn_currency` — it denominates `gross_amount`, the
    // market value — and moves no cash at all, so it is the first row shape
    // for which "denominated in" and "settled through" come apart.
    //
    // The exemption is **per kind and nothing else**: every other kind still
    // fails this CHECK without an account, and `transaction_share_distribution_
    // shape` above forces the exempted kind's three cash columns to NULL, so
    // the pair is total in both directions rather than merely weakened. The
    // MATCH SIMPLE hazard the pairing CHECKs close is not reopened either — a
    // NULL `cash_account_id` names no account, so there is no FK to skip.
    //
    // **`0070` widens the exemption to the two transfer kinds**, the next two
    // cashless shapes, on the same argument: both transfer shape CHECKs force
    // the three cash columns NULL, so the pair stays total both ways.
    check(
      "transaction_fiat_principal_has_cash_account",
      sql`${table.txnCurrency} IS NULL OR ${table.kind}::text IN ('SHARE_DISTRIBUTION', 'TRANSFER_OUT', 'TRANSFER_IN') OR ${table.cashAccountId} IS NOT NULL`,
    ),
    check(
      "transaction_target_has_cash_account",
      sql`${table.targetCurrency} IS NULL OR ${table.targetCashAccountId} IS NOT NULL`,
    ),
    // `transaction_wht_has_cash_account` dropped with its columns (`0079`).

    // ---------------------------------------------------------------------
    // The three CHECKs that could only be added **after** phase 1's backfill —
    // rows 5–7 (FT-2,
    // migration `0046`; FR-235, FR-247, FR-248).
    //
    // Each is **false of every pre-`0046` row** and becomes true only once
    // `0046`'s single `UPDATE` has run, which is exactly why they are not in
    // `0045` — the same reasoning, and the same ordering, as `0039`'s totality
    // CHECKs above. As there, the constraint *is* the completeness proof: a row
    // the backfill missed makes `ALTER TABLE … ADD CONSTRAINT` fail and rolls
    // `0046` back whole, in production as much as in CI.
    //
    // `transaction_cash_account_currency_pairing` is FR-247's MATCH SIMPLE
    // closure for the principal leg (see the pairing block above);
    // `transaction_currency_exchange_cash_leg_pinned` makes L3's
    // "CURRENCY_EXCHANGE is unchanged" a database fact — it is a *new,
    // additive* constraint, not an amendment to
    // `transaction_currency_exchange_shape`, so phase 1 modifies no existing
    // CHECK at all. Its amount half is `transaction_cash_degenerate_equals_gross`
    // above: with `cash_currency = txn_currency` pinned here, that CHECK forces
    // `cash_amount = gross_amount`. Two constraints, one per fact, each
    // independently named so a violation says which one it was.
    check(
      "transaction_cash_account_currency_pairing",
      sql`${table.cashAccountId} IS NULL OR ${table.cashCurrency} IS NOT NULL`,
    ),
    check(
      "transaction_currency_exchange_cash_leg_pinned",
      sql`${table.kind} <> 'CURRENCY_EXCHANGE' OR (${table.cashCurrency} IS NOT NULL AND ${table.cashCurrency} = ${table.txnCurrency})`,
    ),
    // `0056`'s second exemption — see the one on
    // `transaction_fiat_principal_has_cash_account` above, which this is the
    // settlement-currency half of. A cashless kind has no settling account, so
    // it has no settlement currency to name. `0070` widens it to the two
    // transfer kinds, in step with its sibling.
    check(
      "transaction_fiat_principal_has_cash_currency",
      sql`${table.txnCurrency} IS NULL OR ${table.kind}::text IN ('SHARE_DISTRIBUTION', 'TRANSFER_OUT', 'TRANSFER_IN') OR ${table.cashCurrency} IS NOT NULL`,
    ),

    // ---------------------------------------------------------------------
    // The import fingerprint's shape — the optional CHECK, **adopted** (CI-4, migration 0042). It is the
    // 24th `check(...)` on this table; it was the 23rd before.
    //
    // Adopted rather than skipped because it is what makes ADR-0013's
    // claim — "the fingerprint is a hash of data already in the row, so it
    // creates no new personal-data location" — a database fact instead of a
    // convention held by one writer. A future caller that stored the source
    // CSV line itself here, or a raw ISIN, or an account label, would be
    // creating exactly the new personal-data location ADR-0013 would then
    // have to answer for; this refuses that shape outright. It costs nothing
    // to satisfy: `fingerprint.ts` (CI-12) emits `"pp1:" + sha256Hex(...)`.
    //
    // ASCII character classes only, so this is not exposed to the
    // collation-provider hazard `0041` records for `[:space:]`-family
    // classes. `^`/`$` were red-confirmed
    // against a scratch table before this migration was generated, including
    // the case that matters for them specifically — Postgres's `~` is not
    // newline-sensitive here, so a conforming value with a leading or
    // trailing newline is rejected, not admitted.
    //
    // `IS NULL OR` is load-bearing: every pre-`0042` row, and every
    // hand-entered row forever after, is NULL.
    check(
      "transaction_import_fingerprint_shape",
      sql`${table.importFingerprint} IS NULL OR ${table.importFingerprint} ~ '^[a-z0-9]{1,8}:[0-9a-f]{64}$'`,
    ),
    /**
     * **The user reference's shape** — migration `0057`. Absent,
     * or a bounded string with at least one visible character. Nothing else:
     * no uniqueness, no format, no generation (see the column's own comment).
     *
     * `IS NULL OR` is load-bearing exactly as it is on
     * `transaction_import_fingerprint_shape` above: every row that existed
     * when `0057` ran carries NULL, and so does every row whose author never
     * fills the field.
     *
     * **The blank floor is `portfolio_name_length`'s expression, character
     * for character**, and it is here for the reason `0041` records: a
     * bare `~ '\S'` admits ten codepoints libc does not classify as space
     * (U+00A0, U+200B, U+FEFF and seven others), each of which renders as an
     * empty reference row in the drawer — data that is not there, displayed as
     * though it were. `core/api-contracts`' `transactionReferenceSchema` maps
     * every string blank under *this same* floor to "absent" before it ever
     * reaches here (reusing `isBlankUnderDatabaseFloor`, the predicate
     * `name-floor-unicode-blank.integration.test.ts` proves agrees with this
     * class), so the two layers cannot disagree and this CHECK is the
     * out-of-band writer's backstop rather than a reachable 500.
     *
     * **`length(...)`, not `length(btrim(...))`** — deliberately unlike
     * `portfolio_name_length`. The boundary stores a `.trim()`-ed value, so
     * the raw length *is* the trimmed length for every row this product
     * writes; bounding the raw length is the strictly stronger statement, and
     * it closes the gap `btrim` leaves (`btrim` strips ASCII spaces only, so a
     * value padded with tabs can pass a JS-side `.trim().max(n)` and fail a
     * `length(btrim(...)) <= n` CHECK — a 500 for input the boundary
     * accepted).
     *
     * `120` is stated literally here and read back out of
     * `pg_get_constraintdef` by `transaction-reference.integration.test.ts`,
     * which asserts it equals `TRANSACTION_REFERENCE_MAX_LENGTH` — the
     * both-directions drift guard `INDUSTRY_LABEL_MAX_LENGTH`'s own comment
     * records as the only kind that holds.
     */
    check(
      "transaction_reference_shape",
      sql`${table.reference} IS NULL OR (${table.reference} ~ '[^[:space:]\\u00A0\\u1680\\u180E\\u2007\\u200B\\u200C\\u200D\\u202F\\u2060\\uFEFF]' and length(${table.reference}) <= 120)`,
    ),
  ],
);
