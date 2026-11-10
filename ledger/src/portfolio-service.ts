import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  cashAccount,
  portfolio,
  portfolioIcon,
  transaction,
  transactionPosting,
  withTenant,
  type Db,
} from "@kerdial/platform-db";
import type { InstrumentIconContentType, PortfolioAccentColor } from "@kerdial/core-reference-data";
import { lockPortfolioRow, lockTenantWrites } from "./portfolio-lock.js";
import { destroyDerivedStateForPortfolio } from "./materialization.js";
import { severTransferLinksFrom } from "./transfer-link.js";

/**
 * `ledger`'s portfolio management service — T-17
 * (component C9). Owns creation and listing of named, tenant-owned
 * containers for transactions (FR-14).
 *
 * `portfolio` rows carry **no** cash columns — cash is derived from postings
 * into `cash_balance` per `(tenant_id, portfolio_id, cash_account_id,
 * currency)` (re-keyed by `0039`/CD4), so there is nothing here to
 * initialise, zero, or keep in step. What {@link createPortfolio} *does*
 * initialise is the portfolio's first `cash_account` (CA-25) — a named
 * container, carrying no amount, not a balance. And there are no
 * tax-wrapper semantics: `name` is a free-text label only.
 * Nothing in this module touches money, so it holds no numeric values at all
 * (NFR-12 is satisfied vacuously here, not by convention).
 *
 * **Why `withTenant`** — unlike `instrument-service.ts` and
 * `instrument-provider-map-service.ts`, whose tables are shared reference
 * data with no `tenant_id` and no RLS: `portfolio` is tenant-owned (FR-45,
 * AC33), carries `tenant_id NOT NULL`, and migration
 * `0007_roles-grants-rls.sql` (as amended by `0008`) puts it under
 * `ENABLE`+`FORCE ROW LEVEL SECURITY` with the `portfolio_tenant_isolation`
 * policy on both `USING` and `WITH CHECK`. Row-level security is therefore
 * the *primary* enforcement of tenant scoping here; the explicit
 * `eq(portfolio.tenantId, ...)` predicates below are defence in depth,
 * not the mechanism. Every function goes through
 * `withTenant`, which is the only sanctioned way to obtain a handle with
 * `app.tenant_id` set — without it the policy matches nothing and these
 * queries return zero rows rather than another tenant's.
 *
 * Recording transactions against a portfolio is T-19 onward, and any
 * combined/aggregate cross-portfolio view is not built here (out of T-17's
 * scope).
 */

/** Mirrors `portfolio`'s row shape exactly — see `platform/db/src/schema/portfolio.ts`. */
export type PortfolioRecord = typeof portfolio.$inferSelect;

/**
 * A `portfolio` row plus L8's icon-presence flag (FR-467, PD-9) — what every read that
 * feeds a card, a list or a detail header returns.
 *
 * **An intersection with {@link PortfolioRecord}, not a hand-written shape**,
 * and that is the safety property: the three reads below stopped being able to
 * use a bare `.select()` the moment they gained a join (a join makes the bare
 * form's row shape nested and ambiguous), so they enumerate their columns —
 * and this type is what turns a forgotten column in that list into a **compile
 * error** rather than a field that silently disappears from every card in the
 * product. Verified by removing one, observing `tsc` fail, and restoring it.
 */
export type PortfolioWithIcon = PortfolioRecord & { readonly hasIcon: boolean };

/**
 * The explicit column list {@link PortfolioWithIcon}'s guarantee rests on —
 * every column of `portfolio`, once, shared by the three reads so the list
 * cannot drift between them. `bytes` is deliberately nowhere near it: presence
 * is a joined boolean, so no read on this path ever detoasts an icon.
 */
const PORTFOLIO_COLUMNS = {
  id: portfolio.id,
  tenantId: portfolio.tenantId,
  name: portfolio.name,
  broker: portfolio.broker,
  description: portfolio.description,
  accentColor: portfolio.accentColor,
  archivedAt: portfolio.archivedAt,
  calcEpoch: portfolio.calcEpoch,
  createdAt: portfolio.createdAt,
  updatedAt: portfolio.updatedAt,
} as const;

/** The `UNIQUE (tenant_id, name)` index created by migration `0003_ledger-schema.sql`. */
const TENANT_NAME_CONSTRAINT = "portfolio_tenant_id_name_key";

/**
 * Surfaced in place of the raw Postgres unique-violation (T-17's own "with a
 * clear domain error, not a raw constraint failure" requirement) when this
 * tenant already has a portfolio by this name.
 *
 * Note this is deliberately a *translation* of the database's own failure,
 * not a read-then-write pre-check: the `UNIQUE (tenant_id, name)` index
 * remains the actual arbiter, so two concurrent creates of the same name
 * cannot both succeed. Only the message the caller sees is this service's
 * concern.
 */
export class PortfolioNameAlreadyExistsError extends Error {
  readonly tenantId: string;
  /**
   * The offending portfolio name. Not `name`: that field is `Error`'s own,
   * and is this class's identifier.
   */
  readonly portfolioName: string;

  constructor(tenantId: string, portfolioName: string) {
    super(`A portfolio named ${JSON.stringify(portfolioName)} already exists for this tenant.`);
    this.name = "PortfolioNameAlreadyExistsError";
    this.tenantId = tenantId;
    this.portfolioName = portfolioName;
  }
}

/**
 * See `instrument-service.ts`'s identical helper's doc comment: drizzle-orm's
 * postgres-js driver (0.45.x) wraps the underlying `PostgresError` in a
 * `DrizzleQueryError`, so this unwraps one level to be robust to either
 * shape.
 */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const candidate =
    err instanceof postgres.PostgresError
      ? err
      : err instanceof Error && err.cause instanceof postgres.PostgresError
        ? err.cause
        : undefined;
  return candidate?.code === "23505" && candidate.constraint_name === constraintName;
}

/**
 * The defensive half of the cross-portfolio-DRIP guard: any
 * `23503` (foreign-key violation) reaching {@link deletePortfolio}'s own
 * `withTenant` transaction is mapped to
 * {@link PortfolioDeleteBlockedByLinkedTransactionError} rather than a raw
 * 500, whichever child table's FK actually fired — including one this
 * function does not yet know to delete explicitly (a future migration that
 * adds a `portfolio_id` FK without a matching `DELETE` statement here
 * degrades to an honest, retry-able 409, not a stack trace,
 * RD3). Deliberately not scoped to one named constraint, unlike
 * {@link isUniqueViolation} above — the primary enforcement is
 * {@link deletePortfolio}'s own pre-check (step 4); this is the
 * backstop.
 */
function isForeignKeyViolation(err: unknown): boolean {
  const candidate =
    err instanceof postgres.PostgresError
      ? err
      : err instanceof Error && err.cause instanceof postgres.PostgresError
        ? err.cause
        : undefined;
  return candidate?.code === "23503";
}

/**
 * H2 (security review, T-39): `GET /portfolios/overview`/
 * `GET /portfolios/holdings` fan out over *every* portfolio a tenant owns,
 * and `POST /portfolios` was itself unthrottled — so an uncapped portfolio
 * count was the multiplier that turned a single combined-view GET into an
 * arbitrarily large fan-out. A generous, one-time-checked cap closes that
 * multiplier at its source, mirroring `manual-price-service.ts`'s own
 * `MANUAL_PRICE_POINT_TENANT_ROW_CAP` (F3, T-37 security review) — same
 * count-then-insert shape, same accepted TOCTOU trade-off (see that
 * constant's own doc comment: closing the race fully would need a
 * serialising lock on every single portfolio creation, purely to defend a
 * resource-exhaustion-only ceiling no real tenant is expected to approach).
 * 500 comfortably exceeds any plausible phase-1 usage (the
 * 200-holding/5,000-transaction load-test scale, NFR-10, is per
 * *portfolio*) while still bounding the fan-out H2(b)/(c) additionally cap
 * the per-request concurrency of.
 */
/** @public (AR-3): consumed outside the unused-exports gate's workspace set (web/api mirrors and their tests, which knip does not analyse) — until AR-13a removed a namespace-wide `typeof import("@kerdial/ledger")` vi.mock, that accident masked this. */
export const MAX_PORTFOLIOS_PER_TENANT = 500;

/** Surfaced by {@link createPortfolio} when a tenant at {@link MAX_PORTFOLIOS_PER_TENANT} attempts to create another one (H2, security review). */
export class PortfolioTenantCapExceededError extends Error {
  readonly tenantId: string;
  readonly cap: number;

  constructor(tenantId: string, cap: number) {
    super(
      `Tenant ${tenantId} already has ${cap} or more portfolios — refusing to create another ` +
        `until existing ones are removed (H2).`,
    );
    this.name = "PortfolioTenantCapExceededError";
    this.tenantId = tenantId;
    this.cap = cap;
  }
}

/**
 * CA-25: the currency of the one `cash_account` {@link createPortfolio}
 * opens alongside every new portfolio.
 *
 * **EUR is an explicit assumption, not an oversight.** A portfolio carries no
 * base currency of its own (a known gap), so the *system* base currency is the only
 * default available to this function. A user whose portfolio is in fact USD-only renames this
 * account (the `name` column is in `app_web`'s column-level `UPDATE` grant) or
 * adds another; `currency` is immutable per OD-2, so the wrong guess is
 * corrected by adding, never by mutating. **Revisit when that gap closes** and a
 * portfolio can state its own base currency.
 */
export const INITIAL_CASH_ACCOUNT_CURRENCY = "EUR";

/**
 * The name of that account, deliberately the **same** template migration
 * `0039_cash-account-backfill.sql` names OD-3's synthesised accounts with
 * (`'Compte espèce ' || currency || ' (créé automatiquement)'`) — the two
 * paths exist for the same reason (a portfolio that never chose an account
 * still has to be able to receive a transaction) and a user who migrates
 * should not be able to tell which one produced theirs.
 *
 * It cannot collide with `UNIQUE (tenant_id, portfolio_id, name)`: the insert
 * runs in the same transaction as the `portfolio` row itself, against a
 * `portfolio_id` no other row can yet reference (every `cash_account` carries
 * a `portfolio_id` FK, so an account for a portfolio that does not exist yet
 * is not a row Postgres would have accepted). `0039` cannot have produced one
 * either — it only synthesises accounts for portfolios that already have
 * transaction history, which a portfolio created after it ran does not have.
 */
export const INITIAL_CASH_ACCOUNT_NAME = autoCreatedCashAccountName(INITIAL_CASH_ACCOUNT_CURRENCY);

/**
 * {@link INITIAL_CASH_ACCOUNT_NAME}'s template for any currency — also what a
 * CSV import names the account it opens for a row settled in a currency the
 * destination portfolio has no account in.
 */
export function autoCreatedCashAccountName(currency: string): string {
  return `Compte espèce ${currency} (créé automatiquement)`;
}

/**
 * The bytes and metadata of an icon, as both {@link CreatePortfolioParams} and
 * `setPortfolioIcon` take them — `portfolio-icon-service.ts`'s
 * `SetPortfolioIconParams` extends this interface rather than restating its
 * four fields, so the create-time and set-time arguments cannot drift apart.
 *
 * `contentType` is the **sniffed** verdict, never the declared one — the
 * `instrument-icons` posture, and the reason the validator that produces it
 * (`validateInstrumentIconUpload`) is a caller of this package rather than a
 * part of it (FR-460 is enforced at the HTTP boundary, PD-12/PD-T7).
 */
export interface PortfolioIconInput {
  /** Stored **verbatim** — no re-encode, no metadata strip, no normalisation. */
  readonly bytes: Uint8Array;
  readonly contentType: InstrumentIconContentType;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface CreatePortfolioParams {
  /** Optional: defaults to a freshly minted UUID (all IDs are UUIDv7). */
  readonly id?: string;
  readonly tenantId: string;
  /** Free-text label. Unique within the tenant only — two tenants may both call one "Main". */
  readonly name: string;
  /**
   * `portfolio-details` FR-454/L4 — the three optional presentation fields, all
   * settable at create time. `undefined` and `null` are the same thing here
   * (there is no prior state to leave unchanged), so each is written as `?? null`
   * rather than being conditionally omitted from the `values`.
   */
  readonly broker?: string | null;
  readonly description?: string | null;
  readonly accentColor?: PortfolioAccentColor | null;
  /** FR-455 — when present, its row is inserted in **this** transaction (PD-10). */
  readonly icon?: PortfolioIconInput;
  /**
   * Whether to open the {@link INITIAL_CASH_ACCOUNT_NAME} account CA-25
   * describes. **Defaults to `true`** — every caller that does not mention it
   * behaves exactly as it did before this field existed.
   *
   * `false` is for the one caller that creates the portfolio's accounts
   * itself: a Kerdial transactions import. Its file names every
   * account it needs, *including* an account still carrying the auto-created
   * name — a user who never renamed theirs — and the planned account's id is
   * hashed into the row's `kd1` fingerprint, so the importer cannot adopt a
   * differently-identified account after the fact without storing a fingerprint
   * its own next run could not reproduce. Without this option the restore takes
   * a `23505` on `UNIQUE (tenant_id, portfolio_id, name)` and every row of that
   * account is `APPLY_FAILED`.
   *
   * It does **not** make a portfolio without any account a supported product
   * state: the importer passes `false` only when its own directory will create
   * at least one account for this portfolio in the same run.
   */
  readonly initialCashAccount?: boolean;
  /** Overrides {@link MAX_PORTFOLIOS_PER_TENANT} — test-only escape hatch, mirrors `upsertManualPricePoint`'s own `maxRowsPerTenant` parameter. */
  readonly maxPortfoliosPerTenant?: number;
}

/**
 * The non-empty guard `createPortfolio` and {@link updatePortfolio} share for
 * all three free-text fields (LOW-4's symmetry, widened by `portfolio-details`
 * to the two new columns for the reason LOW-4 records for `name`: the HTTP DTO
 * is not this package's only possible caller, and without it a blank value
 * reaches `portfolio_broker_length`/`portfolio_description_length` and escapes
 * as a raw `23514`, i.e. a 500 on user-supplied input).
 *
 * **One function, called by both writers, rather than the guard being restated
 * on each** — this repository's recorded failure shape is an edit path that
 * silently drops an invariant its create path enforces, and two copies of a
 * guard is how that starts.
 *
 * It is `String.prototype.trim`, not the database's own floor: a value blank
 * only under one of `0041`'s ten extra codepoints still reaches the CHECK. That
 * gap is closed at the boundary by `portfolioNameSchema`/`portfolioBrokerSchema`/
 * `portfolioDescriptionSchema`'s shared `isBlankUnderDatabaseFloor` refine
 * (SD-6), and the CHECK itself is the un-bypassable bound either way — an
 * application guard can always be forgotten by a future caller, which is
 * exactly why both layers exist.
 */
function assertNonBlank(caller: string, field: string, value: string | null | undefined): void {
  if (value !== undefined && value !== null && value.trim() === "") {
    throw new TypeError(`${caller} requires a non-empty ${field}`);
  }
}

/**
 * Creates one named portfolio for `params.tenantId` (FR-14). The returned
 * row's `id` is what every later read addresses this portfolio by, and two
 * portfolios of the same tenant necessarily get distinct ids — the
 * independent-per-portfolio half of AC10.
 *
 * `tenant_id` is taken from `params.tenantId`, the same value `withTenant`
 * sets `app.tenant_id` to, so the policy's `WITH CHECK` is satisfied by
 * construction; a caller cannot use this function to plant a row in another
 * tenant, because there is no separate row-tenant parameter to disagree with
 * the scope parameter.
 *
 * Throws {@link PortfolioNameAlreadyExistsError} — never lets the raw
 * unique-constraint violation escape — when this tenant already has a
 * portfolio by this name. Throws {@link PortfolioTenantCapExceededError} (H2,
 * security review) when this tenant is already at {@link MAX_PORTFOLIOS_PER_TENANT}.
 *
 * Also creates **exactly one** {@link INITIAL_CASH_ACCOUNT_CURRENCY}
 * `cash_account` named {@link INITIAL_CASH_ACCOUNT_NAME}, inside the same
 * transaction (CA-25) — see those constants for why EUR is an accepted
 * assumption and why the name cannot collide — **unless the caller
 * passes {@link CreatePortfolioParams.initialCashAccount} `false`**, which is
 * the importer stating that it creates this portfolio's accounts itself.
 *
 * **FR-455's atomicity is structural, not compensating.** Everything below already runs inside one `withTenant`
 * transaction — the cap count, the portfolio row, the first cash account — and
 * `params.icon`'s row joins it. A CHECK failure, an FK failure, the name
 * collision or the cap rolls the whole thing back, so "no portfolio row, no
 * icon row, no partial state" is what Postgres does, not what a `catch` undoes.
 * No lock is needed before that insert (unlike `setPortfolioIcon`'s, PD-7): the
 * `portfolio` row it references was inserted two statements earlier, in this
 * same transaction, so no concurrent `deletePortfolio` can be between them.
 *
 * The non-empty checks below are this function's only length/emptiness guards —
 * {@link updatePortfolio} shares the two new ones literally, through
 * {@link assertNonBlank} (LOW-4, security review; widened by
 * `portfolio-details` FR-452). No guard bounds the *upper* length on its own;
 * `portfolio_name_length`/`portfolio_broker_length`/`portfolio_description_length`
 * are the actual, un-bypassable bounds both writers share.
 */
export async function createPortfolio(
  db: Db,
  params: CreatePortfolioParams,
): Promise<PortfolioRecord> {
  if (!params.name || params.name.trim() === "") {
    throw new TypeError("createPortfolio requires a non-empty name");
  }
  assertNonBlank("createPortfolio", "broker", params.broker);
  assertNonBlank("createPortfolio", "description", params.description);

  const cap = params.maxPortfoliosPerTenant ?? MAX_PORTFOLIOS_PER_TENANT;
  const id = params.id ?? randomUUID();
  try {
    return await withTenant(db, params.tenantId, async (tx) => {
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(portfolio)
        .where(eq(portfolio.tenantId, params.tenantId));
      const count = countRows[0]?.count ?? 0;
      if (count >= cap) {
        throw new PortfolioTenantCapExceededError(params.tenantId, cap);
      }

      const [row] = await tx
        .insert(portfolio)
        .values({
          id,
          tenantId: params.tenantId,
          name: params.name,
          // FR-449/FR-454: `?? null` rather than a conditional key — the three
          // columns are nullable with no default precisely so "unset" is a
          // representable state, and on a create there is no prior value for an
          // omitted field to be left unchanged from.
          broker: params.broker ?? null,
          description: params.description ?? null,
          accentColor: params.accentColor ?? null,
        })
        .returning();

      // CA-25: exactly one `cash_account`, in the **same** transaction
      // as the portfolio row — so a portfolio either exists with an account or
      // does not exist at all, and no rollback path can leave one behind.
      //
      // Not an optional extra: `0039`'s five totality CHECKs make naming an
      // account mandatory on every cash-moving leg (FR-156), and OD-3's
      // backfill only synthesises accounts for portfolios that already have
      // history — so without this insert a freshly created portfolio could
      // never receive its first transaction. It is also what gives CD12's
      // picker prefill something to prefill.
      //
      // Two extra INSERTs at most, **both conditional** — this one on
      // `initialCashAccount`, the `portfolio_icon` one below on `icon` —
      // neither read back: the count query above is this function's only other
      // statement, and nothing here is per-row. (this
      // sentence used to say "one extra INSERT, unconditional", which PD-10
      // falsified, and then "this one unconditional", which the
      // opt-out falsified. A stale invariant left beside a correct
      // implementation is a recorded failure shape here, so it moves with the
      // code.)
      // `archived_at` is left NULL — a brand-new account is usable (OD-5's
      // archive is a user action, never a starting state).
      //
      // Deliberately *not* subject to `MAX_CASH_ACCOUNTS_PER_PORTFOLIO` (F2):
      // the cap bounds how many accounts a user may open in a portfolio,
      // and this is the first one in a portfolio that does not exist yet, so
      // the count it would take is zero by construction. Counting anyway would
      // add a statement to every portfolio creation to assert `0 < 200`.
      //
      // `initialCashAccount: false` is the one opt-out, and it is the *caller*
      // stating that it creates this portfolio's accounts itself — see the
      // field's own documentation.
      if (params.initialCashAccount !== false) {
        await tx.insert(cashAccount).values({
          id: randomUUID(),
          tenantId: params.tenantId,
          portfolioId: id,
          name: INITIAL_CASH_ACCOUNT_NAME,
          currency: INITIAL_CASH_ACCOUNT_CURRENCY,
        });
      }

      // FR-455/PD-10: the icon row, when the caller supplied one, in this same
      // transaction — see the header for why that is the whole of the
      // atomicity claim. `Buffer.from(view)` **copies**, and the copy is the
      // point: the `Buffer.from(view.buffer)` form reads the whole backing
      // store, so a `Uint8Array` view at a non-zero `byteOffset` would store a
      // neighbouring payload's bytes (`setInstrumentIcon` guards the same
      // hazard). No cap is consulted (FR-479/SD-4): at most one icon per
      // portfolio, on a set `MAX_PORTFOLIOS_PER_TENANT` already bounds.
      if (params.icon) {
        const bytes = Buffer.from(params.icon.bytes);
        await tx.insert(portfolioIcon).values({
          tenantId: params.tenantId,
          portfolioId: id,
          bytes,
          contentType: params.icon.contentType,
          byteLength: bytes.length,
          widthPx: params.icon.widthPx,
          heightPx: params.icon.heightPx,
        });
      }

      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err, TENANT_NAME_CONSTRAINT)) {
      throw new PortfolioNameAlreadyExistsError(params.tenantId, params.name);
    }
    throw err;
  }
}

/**
 * The `leftJoin` predicate both reads below use for L8's presence flag
 * (FR-467, PD-9, `portfolio-details`).
 *
 * **It cannot multiply rows**, and that is a property of the key rather than an
 * assumption about the data: the joined side's primary key is exactly
 * `(tenant_id, portfolio_id)`, so the match is 0-or-1. Both reads already run
 * inside `withTenant`, so `portfolio_icon`'s own policy scopes the join to the
 * caller's tenant on top of the explicit predicate. No new index — the join
 * uses `portfolio_icon_pkey`.
 *
 * The rejected alternative is `instrument-icons`' IK-10 shape (a separate
 * bounded `IN (…)` presence lookup per request). It was right there because
 * `listInstruments`/`getInstrumentById` are not tenant-scoped and threading
 * `tenantId` through would have touched six call sites; here the reads are
 * already scoped, so the cheaper option (zero extra statements) is also the
 * simpler one.
 */
const ICON_JOIN_ON = and(
  eq(portfolioIcon.tenantId, portfolio.tenantId),
  eq(portfolioIcon.portfolioId, portfolio.id),
);

/** Presence, never `length(bytes)`: the `bytes` column is never selected, so nothing on this path detoasts an icon. */
const HAS_ICON = sql<boolean>`(${portfolioIcon.portfolioId} is not null)`;

/**
 * Every portfolio owned by `tenantId`, ordered by `name` so the result is
 * deterministic rather than dependent on physical row order. A portfolio
 * created by another tenant is not in this list — enforced by RLS, which is
 * why this is the criterion AC33/FR-45 is proven against live Postgres
 * rather than asserted from the `where` clause below.
 */
export async function listPortfolios(db: Db, tenantId: string): Promise<PortfolioWithIcon[]> {
  return withTenant(db, tenantId, async (tx) =>
    tx
      .select({ ...PORTFOLIO_COLUMNS, hasIcon: HAS_ICON })
      .from(portfolio)
      .leftJoin(portfolioIcon, ICON_JOIN_ON)
      .where(eq(portfolio.tenantId, tenantId))
      .orderBy(asc(portfolio.name)),
  );
}

/**
 * A single portfolio by id, or `undefined` if this tenant has no such
 * portfolio — including the case where the id exists but belongs to another
 * tenant, which is indistinguishable from "does not exist" here by design
 * (AC33: another tenant's rows are invisible, not merely forbidden).
 *
 * This is the "independently addressable" read AC10's per-portfolio half
 * names; the holdings/valuation reads it will later sit alongside are T-21
 * and T-30, not this module.
 */
export async function getPortfolio(
  db: Db,
  tenantId: string,
  portfolioId: string,
): Promise<PortfolioWithIcon | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ ...PORTFOLIO_COLUMNS, hasIcon: HAS_ICON })
      .from(portfolio)
      .leftJoin(portfolioIcon, ICON_JOIN_ON)
      .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)));
    return row;
  });
}

export interface UpdatePortfolioParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** Present ⇒ set. Absent ⇒ leave unchanged. `null` ⇒ clear — which `name`, alone of the four, cannot be. */
  readonly name?: string;
  readonly broker?: string | null;
  readonly description?: string | null;
  readonly accentColor?: PortfolioAccentColor | null;
}

/**
 * Updates any subset of a portfolio's four presentation fields (FR-456–FR-459,
 * PD-8) — the function `renamePortfolio` became when `name` stopped being the
 * only thing a portfolio carries.
 *
 * **Partial means the `set` clause is built from the keys that are present**,
 * not from all four with the absent ones written back as themselves. The
 * difference is the whole of FR-456/FR-458: a `{ name }`-only call issues
 * exactly `set name = …, updated_at = now()`, so it is byte-for-byte the write
 * `renamePortfolio` used to issue and cannot disturb a field the caller never
 * mentioned. `undefined` ⇒ leave unchanged, `null` ⇒ clear (FR-453) — the
 * distinction the JSON body already carries, preserved all the way down rather
 * than re-encoded as a sentinel.
 *
 * **Never touches `calc_epoch`** (FR-459, NG5, PD-14): the `set` clause names
 * only these four columns and `updated_at`, and no
 * `recomputeAndInvalidate`/`destroyDerivedStateForPortfolio`/advisory lock/`FOR
 * UPDATE` is anywhere near it. All four fields are presentation, exactly as
 * `name` already was. This is load-bearing on the *client* too, not only in the
 * database: the portfolio workspace's freshness copy is driven by `calc_epoch`
 * through `invalidateAndVerifyCalcEpoch`, so bumping it here would re-verify
 * every derived figure for the portfolio on every broker-name edit — and
 * routing a write that does *not* bump it through that helper would exhaust its
 * 3-attempt budget waiting for an epoch nothing will advance and surface a
 * spurious « fraîcheur non confirmée » (a recorded failure).
 * `portfolio-service.integration.test.ts` asserts the epoch before and after
 * rather than leaving it to this paragraph.
 *
 * Always issues the `UPDATE`, with deliberately no pre-read: renaming a
 * portfolio to its own current name is a no-op success by construction (the
 * `UNIQUE (tenant_id, name)` index is not violated — it is the same row), not a
 * special case in this code. And the single `UPDATE … RETURNING` is its own
 * probe, which is why **`undefined` is returned when no row matched** (unknown
 * id, another tenant's — RLS makes the two indistinguishable, AC33 — or one
 * deleted concurrently) and why no lock is needed here, unlike
 * `setPortfolioIcon`'s: this statement inserts nothing, so it cannot violate an
 * FK.
 *
 * @throws {TypeError} when every field is `undefined` — an update that updates
 * nothing is a caller bug, not a no-op success. Unreachable over HTTP:
 * `updatePortfolioBodySchema`'s refine (FR-457) rejects an empty body with a
 * 400 first. Also when a present `name`/`broker`/`description` is blank, the
 * guard {@link assertNonBlank} documents.
 * @throws {PortfolioNameAlreadyExistsError} on a collision with another of this
 * tenant's portfolios — translated from `23505`, the unique index staying the
 * actual arbiter, exactly as {@link createPortfolio} documents.
 */
export async function updatePortfolio(
  db: Db,
  params: UpdatePortfolioParams,
): Promise<PortfolioWithIcon | undefined> {
  const { tenantId, portfolioId, ...fields } = params;
  assertNonBlank("updatePortfolio", "name", fields.name);
  assertNonBlank("updatePortfolio", "broker", fields.broker);
  assertNonBlank("updatePortfolio", "description", fields.description);

  // Only the keys the caller actually supplied. Typed as a `Pick` of the row
  // itself, so a misspelt column name is a compile error rather than a key
  // drizzle would carry into an `UPDATE` that sets nothing.
  const set: Partial<Pick<PortfolioRecord, "name" | "broker" | "description" | "accentColor">> = {};
  if (fields.name !== undefined) set.name = fields.name;
  if (fields.broker !== undefined) set.broker = fields.broker;
  if (fields.description !== undefined) set.description = fields.description;
  if (fields.accentColor !== undefined) set.accentColor = fields.accentColor;

  // FR-457's service-side half, measured on the `set` that was actually built
  // rather than on the parameters. The `Record` is what makes it exhaustive: a
  // fifth updatable field added to `UpdatePortfolioParams` with no branch above
  // leaves this literal incomplete and **fails to compile**, instead of being
  // counted as present here and then silently never written — an edit path
  // quietly dropping what its create path enforces is this repository's
  // recorded failure shape, so the symmetry is held by the type checker.
  const present: Record<keyof typeof fields, boolean> = {
    name: set.name !== undefined,
    broker: set.broker !== undefined,
    description: set.description !== undefined,
    accentColor: set.accentColor !== undefined,
  };
  if (!Object.values(present).some(Boolean)) {
    throw new TypeError("updatePortfolio requires at least one field to update");
  }

  try {
    return await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .update(portfolio)
        .set({ ...set, updatedAt: sql`now()` })
        .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)))
        .returning({
          ...PORTFOLIO_COLUMNS,
          // `RETURNING` admits a scalar subquery, so L8's flag costs this write
          // no second statement and no second round trip — the `leftJoin` the
          // two reads use is not available to an `UPDATE`. Tenant-scoped
          // explicitly as well as by `portfolio_icon`'s own policy, the
          // defence-in-depth posture every predicate in this module follows.
          hasIcon: sql<boolean>`exists (
            select 1 from portfolio_icon pi
             where pi.tenant_id = ${tenantId}::uuid and pi.portfolio_id = ${portfolio.id}
          )`,
        });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err, TENANT_NAME_CONSTRAINT)) {
      // `?? ""` is unreachable rather than defensive: the only unique index on
      // this table is `(tenant_id, name)`, so a `23505` here means `name` was
      // in the `set`. Written this way because narrowing an optional field with
      // a non-null assertion, in a `catch`, is worse than an empty string.
      throw new PortfolioNameAlreadyExistsError(tenantId, params.name ?? "");
    }
    throw err;
  }
}

export interface SetPortfolioArchivedParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly archived: boolean;
}

/**
 * Archives or un-archives a portfolio (`portfolio-archive` FR-592, FR-595)
 * — a **display-only** flag (PA-L2): no `calc_epoch` bump, no
 * `recomputeAndInvalidate`, no queue, no log line. The `SET` names exactly
 * `archived_at` and `updated_at`.
 *
 * **One conditional `UPDATE … RETURNING`.** `SET` expressions see the
 * pre-update row, so both `CASE`s branch on the old state: a no-op (archive an
 * archived row, un-archive a non-archived one) writes each column back as
 * itself, so the returned record is identical to the previous one (PAD-3,
 * AC-475); a real change stamps `now()` on both (FR-595, AC-496). This
 * deliberately diverges from `setCashAccountArchived`, which re-stamps on a
 * no-op.
 *
 * `undefined` when no row matched — unknown id, another tenant's (RLS and the
 * explicit `tenant_id` predicate make the two indistinguishable, AC-479) or
 * one deleted concurrently — {@link updatePortfolio}'s contract. No lock: the
 * statement writes the row itself and inserts nothing, so it cannot hit an
 * FK, and it serialises with `deletePortfolio` on the row lock.
 */
export async function setPortfolioArchived(
  db: Db,
  params: SetPortfolioArchivedParams,
): Promise<PortfolioWithIcon | undefined> {
  const { tenantId, portfolioId, archived } = params;
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .update(portfolio)
      .set({
        archivedAt: archived ? sql`coalesce(${portfolio.archivedAt}, now())` : null,
        updatedAt: sql`case when (${portfolio.archivedAt} is not null) = ${archived}::boolean
                            then ${portfolio.updatedAt} else now() end`,
      })
      .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)))
      .returning({
        ...PORTFOLIO_COLUMNS,
        hasIcon: sql<boolean>`exists (
          select 1 from portfolio_icon pi
           where pi.tenant_id = ${tenantId}::uuid and pi.portfolio_id = ${portfolio.id}
        )`,
      });
    return row;
  });
}

/**
 * D4: raised by {@link deletePortfolio} when a transaction in
 * a *different* portfolio (a `DRIP`) reinvests a dividend recorded *inside*
 * the portfolio being deleted. Deleting the dividend would either dangle the
 * DRIP's `source_dividend_id` (impossible: that FK stays `no action`, which
 * is exactly what raises the `23503` this error's defensive catch also
 * translates) or silently take out another portfolio's data — both violate
 * the locked "destroy exactly this portfolio's children, nothing else"
 * cascade contract (OQ-P1).
 *
 * **That contract has one deliberate exception since `security-transfer`**
 * (OD-7 (c), FR-580, F-4 — the owner's decision): a security
 * transfer's link is **severed**, not blocked. Deleting a portfolio clears
 * `transfer_source_id` on every other portfolio's `TRANSFER_IN` that points at
 * one of its transactions — one column on another portfolio's rows, with an
 * `UPDATE` revision each — and the survivor keeps its quantity and stored
 * carried cost. So the contract now reads "destroy exactly this portfolio's
 * children, and sever the transfer links into it; nothing else". A DRIP's
 * dividend link is still a block, through this error.
 */
export class PortfolioDeleteBlockedByLinkedTransactionError extends Error {
  readonly tenantId: string;
  readonly portfolioId: string;

  constructor(tenantId: string, portfolioId: string, detail: string) {
    super(
      `Cannot delete portfolio ${portfolioId}: ${detail} — remove that transaction first, or leave ` +
        `this portfolio's dividend in place.`,
    );
    this.name = "PortfolioDeleteBlockedByLinkedTransactionError";
    this.tenantId = tenantId;
    this.portfolioId = portfolioId;
  }
}

export interface DeletePortfolioParams {
  readonly tenantId: string;
  readonly portfolioId: string;
  /** `app_user.id` recorded as `changed_by` on every appended `DELETE` revision. */
  readonly deletedBy: string;
}

export interface DeletePortfolioResult {
  /** `false` — no such portfolio for this tenant (unknown id, or another tenant's) — never throws for this case. */
  readonly deleted: boolean;
  readonly transactionsDeleted: number;
  /**
   * Security-transfer links from **other** portfolios' `TRANSFER_IN` rows into
   * this one's transactions that the delete cut (step 4b, OD-7 (c)) — measured
   * from the sever's own `UPDATE … RETURNING`, on LOW-3's precedent below. The
   * `UPDATE` revisions those rows receive are not counted in
   * {@link DeletePortfolioResult.revisionsAppended}, which stays one `DELETE`
   * revision per destroyed transaction.
   */
  readonly transferLinksSevered: number;
  /**
   * A measurement of the audit `INSERT`'s own returned row count (LOW-3,
   * security review) — one `DELETE`-kind revision per destroyed
   * transaction, so this equals
   * {@link DeletePortfolioResult.transactionsDeleted} for every real writer
   * this package ships, but it is read back from what was actually inserted
   * rather than assumed equal. `0` for an empty portfolio is the accepted,
   * documented gap that delete leaves no audit trace in that one case.
   */
  readonly revisionsAppended: number;
}

/**
 * Hard-deletes a portfolio and every row it owns (FR-P3, the locked
 * full-cascade decision, OQ-P1) — the cascade is
 * **explicit ordered `DELETE`s**, not `ON DELETE CASCADE`:
 * every child FK stays `no action`, so the final `DELETE FROM portfolio`
 * below is itself the no-orphans proof — if any table this function does not
 * know about still references the row, Postgres raises `23503` and the
 * *whole* transaction rolls back, deleting nothing.
 *
 * The lock protocol (**with steps 2 and 3 swapped by F1**
 * — see `portfolio-lock.ts` for the one global order they were swapped to
 * match), in this exact order, inside one `withTenant` transaction: tenant
 * advisory lock (the same one `TransactionWriteService#nextSeq` takes on every
 * transaction-create) → lock the `portfolio` row `FOR UPDATE` (the same row
 * `calc_epoch`'s writers and the lazy materialiser's guard contend on) → lock
 * this portfolio's `transaction` rows `FOR UPDATE` → the cross-portfolio DRIP
 * pre-check → the security-transfer sever (step 4b, `security-transfer`:
 * other portfolios' links into this one are cut, their portfolio
 * rows locked under rung 1) → the audit append → the **nine** ordered deletes
 * (`cash_account` is the eighth, added by CA-7,
 * and `portfolio_icon` the
 * ninth, added by `portfolio-details` FR-465/PD-6). This order is a correctness
 * requirement, not a stylistic preference — see `portfolio-lock.ts` for why the
 * portfolio row must be taken before both the transaction rows and any
 * `cash_account` row, and why `portfolio_daily_valuation`
 * must be deleted only after the portfolio row is locked.
 *
 * Returns `{ deleted: false, ... }` — never throws — when this tenant has no
 * such portfolio, including another tenant's id (RLS makes the two
 * indistinguishable, AC33) and the case where a concurrent delete already
 * won the advisory lock and committed first (the loser's
 * `FOR UPDATE` finds no row).
 *
 * @throws {PortfolioDeleteBlockedByLinkedTransactionError} when a DRIP in
 * another portfolio reinvests a dividend recorded in this one — either
 * from the explicit pre-check, or defensively from any `23503` this
 * transaction raises (a future child table added without its own `DELETE`
 * statement here degrades to this same 409, never a raw 500).
 */
export async function deletePortfolio(
  db: Db,
  params: DeletePortfolioParams,
): Promise<DeletePortfolioResult> {
  const { tenantId, portfolioId, deletedBy } = params;
  try {
    return await withTenant(db, tenantId, async (tx) => {
      // Step 1: the same tenant advisory lock
      // `TransactionWriteService#nextSeq` takes on every transaction-create —
      // this is what makes "create either fully commits first or
      // blocks behind this delete" argument true.
      await lockTenantWrites(tx, tenantId);

      // Step 2 (**reordered by F1**): the `portfolio` row —
      // rung 2 of `portfolio-lock.ts`'s global order, the same row and lock
      // mode `calc_epoch`'s writers and `materialize.ts`'s guard contend on.
      // No row -> 404, nothing written (the "two concurrent deletes" case:
      // the loser lands here).
      //
      // **This used to run after the `transaction` rows were locked, and the
      // comment there claimed the order was what avoided a deadlock with the
      // transaction-edit path.** That was true only while the edit path went
      // `transaction` row -> `portfolio` row. F1 inverted the edit path (it now
      // takes the `portfolio` row first, which is what removes the reproduced
      // `40P01` between a transaction edit and a cash-account rename), so this
      // cascade had to move with it: leaving it as it was would have traded one
      // cycle for another, between this function and every transaction write.
      // One order, everywhere — advisory lock, portfolio row, transaction rows,
      // cash-account rows — is the invariant, not any pairwise argument.
      if (!(await lockPortfolioRow(tx, tenantId, portfolioId))) {
        return {
          deleted: false,
          transactionsDeleted: 0,
          revisionsAppended: 0,
          transferLinksSevered: 0,
        };
      }

      // Step 3: locks the doomed transaction rows (rung 3), so no
      // concurrent edit can be mid-write on one of them when the deletes below
      // run. Its own former "must run before the portfolio row" requirement is
      // gone — see step 2.
      await tx
        .select({ id: transaction.id })
        .from(transaction)
        .where(and(eq(transaction.tenantId, tenantId), eq(transaction.portfolioId, portfolioId)))
        .orderBy(asc(transaction.id))
        .for("update");

      // Step 4: a DRIP in a *different* portfolio may legally
      // reinvest a DIVIDEND recorded in *this* one (`recordDrip` validates
      // same tenant/instrument, not same portfolio). Blocking this
      // explicitly, before anything is deleted, is what keeps "destroy
      // exactly this portfolio's children, nothing else" true.
      const [linked] = await tx.execute<{ dripId: string }>(sql`
        select drip.id as "dripId"
          from "transaction" drip
          join "transaction" dividend on dividend.id = drip.source_dividend_id
         where drip.tenant_id = ${tenantId}
           and dividend.tenant_id = ${tenantId}
           and dividend.portfolio_id = ${portfolioId}
           and drip.portfolio_id <> ${portfolioId}
         limit 1
      `);
      if (linked) {
        throw new PortfolioDeleteBlockedByLinkedTransactionError(
          tenantId,
          portfolioId,
          `a reinvestment transaction (${linked.dripId}) recorded in another portfolio depends on a dividend recorded in this one`,
        );
      }

      // Step 4b (`security-transfer`, OD-7 (c), FR-580): a
      // `TRANSFER_IN` in another portfolio whose source leg is one of this
      // portfolio's transactions is **severed**, not blocked — its
      // `transfer_source_id` cleared (with an `UPDATE` revision), its quantity
      // and stored carried cost kept, and its portfolio not recomputed (ST-14:
      // no figure there moves). Without this the `DELETE` of the source leg
      // below meets the `NO ACTION` self-FK, `23503`, and the catch turns the
      // whole delete into a 409. This portfolio's own `TRANSFER_IN` rows need
      // nothing: a referencing row may always be deleted, and the surviving
      // source leg in the other portfolio has no column pointing here.
      const transferLinksSevered = await severTransferLinksFrom(
        tx,
        tenantId,
        portfolioId,
        deletedBy,
      );

      // Step 5: one INSERT ... SELECT to_jsonb(t), before the
      // transactions themselves are deleted — the identical `to_jsonb`
      // snapshot shape `TransactionWriteService#snapshot`/`deleteTransaction`
      // already produce for a single-transaction delete. No NUMERIC value is
      // ever read back into JavaScript (NFR-12): the snapshot is built and
      // stored entirely inside Postgres — only the RETURNING'd row ids come
      // back, and solely to be counted (see LOW-3 below).
      //
      // LOW-3 (security review): `RETURNING
      // id` makes `revisionsAppended` below a **measurement** of this
      // `INSERT`'s own actual row count, not an assumption — it previously
      // reused `deletedTransactions.length` (the *separate* transaction
      // `DELETE`'s own count, computed below), which happened to agree with
      // this `INSERT`'s row count only because both statements select the
      // identical `WHERE tenant_id = ... AND portfolio_id = ...` set and
      // nothing runs between them to change it — true today, but an assumed
      // invariant, not something this return value itself proved. Reading the
      // row count `INSERT ... RETURNING` actually produced closes that gap:
      // if a future change ever made the two counts diverge, this value would
      // reflect what was actually audited, not what was actually deleted.
      const insertedRevisions = await tx.execute<{ id: string }>(sql`
        insert into transaction_revision (id, tenant_id, transaction_id, revision_kind, before, after, changed_by)
        select gen_random_uuid(), t.tenant_id, t.id, 'DELETE', to_jsonb(t), NULL, ${deletedBy}
          from "transaction" t
         where t.tenant_id = ${tenantId} and t.portfolio_id = ${portfolioId}
        returning id
      `);

      // Step 6: the **nine** ordered deletes, in the documented order —
      // `portfolio_daily_valuation` first (must run after the portfolio
      // row's `FOR UPDATE` above — a correctness requirement), `portfolio`
      // itself last (the no-orphans assertion). Eight until
      // `portfolio-details` added `portfolio_icon`; this count is asserted in
      // this function's own header, so the two
      // move together or none does.
      // AR-3: the derived-state half of the teardown lives in
      // materialization.ts — the one module allowed to write derived state —
      // in this same documented order.
      await destroyDerivedStateForPortfolio(tx, tenantId, portfolioId);
      await tx
        .delete(transactionPosting)
        .where(
          and(
            eq(transactionPosting.tenantId, tenantId),
            eq(transactionPosting.portfolioId, portfolioId),
          ),
        );
      const deletedTransactions = await tx
        .delete(transaction)
        .where(and(eq(transaction.tenantId, tenantId), eq(transaction.portfolioId, portfolioId)))
        .returning({ id: transaction.id });
      // `cash_account` (CA-7,
      // FR-166). Position is forced, not chosen: it must follow `transaction`
      // (four composite FKs point at it) and `cash_balance` (CD4's FK, deleted
      // at step 2 above), and it must precede `portfolio`, which it references
      // with `ON DELETE no action` like every other child — so the final
      // `DELETE FROM portfolio` below stays the no-orphans proof rather than
      // being quietly satisfied by a cascade. Runs as `app_web`, which is why
      // `0038` grants that role `DELETE` on this table even though OD-5 locked
      // *user-facing* removal to archive.
      await tx
        .delete(cashAccount)
        .where(and(eq(cashAccount.tenantId, tenantId), eq(cashAccount.portfolioId, portfolioId)));
      // `portfolio_icon`, the ninth (`portfolio-details` FR-465/PD-6). Position
      // is **not** forced by any FK — the table references only `tenant` and
      // `portfolio`, and nothing references it — so it sits last among the
      // children purely to keep "everything before the final `DELETE FROM
      // portfolio`" readable.
      //
      // Omitting it would not orphan a row: the `no action` FK raises `23503`
      // and the catch below turns that into a 409
      // `PortfolioDeleteBlockedByLinkedTransactionError` — the backstop working
      // as designed, but with a message ("a transaction outside this
      // portfolio…") that would be simply false, on *every* delete of an iconed
      // portfolio. Which is why FR-465 states this statement as a requirement
      // rather than leaving it to the backstop, and why AC-401 proves it by
      // querying the table instead of trusting the response.
      await tx
        .delete(portfolioIcon)
        .where(
          and(eq(portfolioIcon.tenantId, tenantId), eq(portfolioIcon.portfolioId, portfolioId)),
        );
      await tx
        .delete(portfolio)
        .where(and(eq(portfolio.tenantId, tenantId), eq(portfolio.id, portfolioId)));

      return {
        deleted: true,
        transactionsDeleted: deletedTransactions.length,
        // D2 / LOW-3: exactly one DELETE-kind revision per destroyed
        // transaction — a genuine measurement of the `INSERT ... RETURNING`
        // above's own row count (see that statement's own comment), not
        // `deletedTransactions.length` reused under an unstated assumption
        // that the two counts agree. Also asserted directly against the
        // table by the integration suite.
        revisionsAppended: insertedRevisions.length,
        transferLinksSevered,
      };
    });
  } catch (err) {
    if (err instanceof PortfolioDeleteBlockedByLinkedTransactionError) {
      throw err;
    }
    if (isForeignKeyViolation(err)) {
      throw new PortfolioDeleteBlockedByLinkedTransactionError(
        tenantId,
        portfolioId,
        "a transaction outside this portfolio still references a row that would have been deleted with it",
      );
    }
    throw err;
  }
}

/**
 * D8: the blocking-transaction-count figure
 * `PortfoliosController.list` surfaces per portfolio, computed only for the
 * given page's ids — one grouped aggregate inside `withTenant`, index-backed
 * by `transaction_tenant_portfolio_trade_date_seq_idx`'s
 * `(tenant_id, portfolio_id, ...)` prefix. A portfolio id with zero
 * transactions is simply absent from the returned map (never a zero entry),
 * since `GROUP BY` produces no row for it — callers read a missing key as
 * zero.
 */
export async function countTransactionsByPortfolio(
  db: Db,
  tenantId: string,
  portfolioIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (portfolioIds.length === 0) return new Map();
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ portfolioId: transaction.portfolioId, count: sql<number>`count(*)::int` })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          inArray(transaction.portfolioId, [...portfolioIds]),
        ),
      )
      .groupBy(transaction.portfolioId);
    return new Map(rows.map((row) => [row.portfolioId, row.count]));
  });
}
