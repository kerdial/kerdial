import { randomUUID } from "node:crypto";
import { and, asc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import postgres from "postgres";
import type { Decimal } from "@kerdial/core-decimal";
import {
  extractPostgresError,
  instrument,
  withTenant,
  type Db,
  type Tx,
} from "@kerdial/platform-db";

/** `foreign_key_violation` — the backstop {@link deleteInstrument} maps to a 409. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Accepts either a plain connection or a transaction handle — mirrors
 * `instrument-provider-map-service.ts`'s own `DbLike`, for the same reason:
 * {@link updateInstrumentIdentity} composes {@link updateInstrumentDetails}
 * and {@link setInstrumentFigi} inside its own `db.transaction(...)` call.
 */
type DbLike = Db | Tx;

/**
 * `ledger`'s instrument identity service — T-11
 * (component C4). Owns the **creation** paths for `instrument` rows: the
 * ISIN-based path for SHARE/ETF/FUND (the "Dual listings" note — a
 * distinct row per `(isin, exchange_mic)`) and the symbol-based path for
 * CRYPTO (and, since nothing here is CRYPTO-specific beyond the unique-symbol
 * dedupe rule, INDEX too — see {@link createInstrumentBySymbol}'s doc
 * comment). Provider mapping (`instrument_provider_map`) is T-12, entirely
 * out of scope here for T-11.
 *
 * **Why no `withTenant`.** `instrument` is shared reference catalogue data,
 * not tenant-owned ("instrument carries no tenant_id
 * column"; recorded in `platform/db/src/schema/README.md` and confirmed by
 * migration `0007_roles-grants-rls.sql`, which deliberately does not enable
 * row-level security on this table). `withTenant`'s entire purpose is
 * setting the transaction-local `app.tenant_id` GUC that RLS policies read
 * (`platform/db/src/tenant-context.ts`) — there is no such policy on
 * `instrument` for it to satisfy, and calling it here would suggest, falsely,
 * that this table is tenant-scoped. Every function below therefore takes a
 * plain `Db` and issues an ordinary (unscoped) query, exactly as
 * `platform/db`'s own schema/seed code treats other shared tables like
 * `currency`.
 */

type ShareEtfFundKind = "SHARE" | "ETF" | "FUND";
type SymbolBasedKind = "CRYPTO" | "INDEX";

/** Mirrors `instrument`'s row shape exactly — see `platform/db/src/schema/instrument.ts`. */
export type InstrumentRecord = typeof instrument.$inferSelect;

/**
 * The `instrument_kind` enum, read off the row type rather than kept by hand
 * (`scpi` SCD-11): the schema module is the only list, so this can no
 * longer drift from it when a kind is added.
 */
export type InstrumentKind = InstrumentRecord["kind"];

const ISIN_EXCHANGE_MIC_CONSTRAINT = "instrument_isin_exchange_mic_key";
const CRYPTO_SYMBOL_CONSTRAINT = "instrument_symbol_crypto_key";
/**
 * F1(c) (security review, T-37): dedupes every
 * symbol-identified, non-CRYPTO row (INDEX today) — the gap
 * `instrument_symbol_crypto_key` (`WHERE kind = 'CRYPTO'`) and
 * `instrument_isin_exchange_mic_key` (`WHERE isin IS NOT NULL`) leave
 * between them. See migration `0021_instrument-symbol-no-isin-dedupe.sql`.
 */
const SYMBOL_NO_ISIN_CONSTRAINT = "instrument_symbol_no_isin_key";
/**
 * `scpi` cycle (SCD-2, migration `0074`): an ISIN with no listing is unique —
 * the NULL-MIC gap `instrument_isin_exchange_mic_key` leaves (NULLs compare
 * distinct). Only {@link createInstrumentScpi} writes MIC-less ISIN rows.
 */
const ISIN_NO_MIC_CONSTRAINT = "instrument_isin_no_mic_key";

/**
 * Surfaced in place of the raw Postgres unique-violation (T-11's own "the service, not just the DB constraint, must surface a
 * clear domain error" requirement) when a duplicate `(isin, exchange_mic)`
 * pair, a duplicate `CRYPTO` `symbol`, or a duplicate non-CRYPTO
 * symbol-identified instrument (F1(c)) is attempted.
 */
export class InstrumentAlreadyExistsError extends Error {
  readonly conflict: "ISIN_EXCHANGE_MIC" | "CRYPTO_SYMBOL" | "SYMBOL_NO_ISIN";

  constructor(conflict: "ISIN_EXCHANGE_MIC" | "CRYPTO_SYMBOL" | "SYMBOL_NO_ISIN", message: string) {
    super(message);
    this.name = "InstrumentAlreadyExistsError";
    this.conflict = conflict;
  }
}

/** Surfaced by {@link updateInstrumentDetails}, {@link updateInstrumentClassification} and {@link setInstrumentFigi} when `id` does not resolve to any row. */
export class InstrumentNotFoundError extends Error {
  readonly instrumentId: string;

  constructor(instrumentId: string) {
    super(`No instrument found with id ${instrumentId}`);
    this.name = "InstrumentNotFoundError";
    this.instrumentId = instrumentId;
  }
}

/** Surfaced by {@link setInstrumentFigi} when the row already carries a `figi` — that path fills a gap, it never overwrites. */
export class InstrumentFigiAlreadySetError extends Error {
  readonly instrumentId: string;

  constructor(instrumentId: string) {
    super(`Instrument ${instrumentId} already has a figi set`);
    this.name = "InstrumentFigiAlreadySetError";
    this.instrumentId = instrumentId;
  }
}

/**
 * FR-16/FR-23's routing precondition. Every kind
 * defaults to `AUTO` — **FUND included since ADR-0018**: a fund's NAV
 * is backfilled and refreshed from the same provider as every other kind
 * (`market/ingestion`'s `BACKFILLABLE_KINDS`), and manual NAV entry
 * (FR-23) is the override on top, not the only path. `MANUAL_ONLY` is still a
 * valid column value (a catalogue import may carry it; migration `0073`
 * flipped the earlier FUND rows).
 *
 * **Except `SCPI`** (`scpi` cycle, FR-610), where `MANUAL_ONLY` is a rule, not
 * a default: an SCPI has no provider route at all, the API refuses `AUTO` for
 * it, and migration `0074`'s `instrument_scpi_shape` CHECK refuses it in the
 * database. Not caller-supplied — the service, not the caller, owns this so it
 * cannot drift kind-by-kind at call sites.
 */
function defaultQuotePolicy(kind: InstrumentKind): "AUTO" | "MANUAL_ONLY" {
  return kind === "SCPI" ? "MANUAL_ONLY" : "AUTO";
}

/**
 * `postgres.js` throws a `PostgresError` directly, but drizzle-orm's
 * postgres-js driver (0.45.x) wraps it in a `DrizzleQueryError` with the
 * original error on `.cause` (`drizzle-orm/errors.js`). Unwrap one level so
 * this check is robust to either shape.
 */
/**
 * N4 (security review, T-37): `symbol` was never
 * normalised at this layer either — `"SPX"`/`"spx"`/`"SPX "` produced
 * distinct rows, silently bypassing migration 0021's dedupe key and the
 * pre-existing `instrument_symbol_crypto_key` (neither index is
 * case/whitespace-insensitive). `api`'s Zod schema now does the same
 * normalisation at the HTTP boundary (`instruments.schema.ts`'s
 * `createInstrumentBodySchema`), but this service function is the one place
 * every creation path — including any future caller that is not `api`'s
 * controller — actually goes through, so it normalises again here rather
 * than trusting every caller to have already done so.
 */
function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * ISO 10383's charset, `^[A-Z0-9]{4}$` — the same rule `api-contracts`'
 * `exchangeMicSchema` states for every HTTP boundary, restated here because
 * this function is the **last** gate before a row lands in `instrument`, a
 * table with no `tenant_id` and no RLS that every tenant reads.
 *
 * Restated by value and not imported: `ledger` does not depend on
 * `@kerdial/api-contracts` and must not start doing so for a four-character
 * charset. The two copies are asserted to accept and reject exactly the same
 * inputs by `api/src/imports/imports.schema.test.ts` — the file that already
 * owns this repository's "declared twice by value" pairs — so a drift is a red
 * test rather than a silent divergence.
 *
 * The check earns its keep because `exchange_mic` is `char(4)`: Postgres
 * accepts and blank-pads anything four characters or shorter, so `'ab'`,
 * `'x<>'` and even `'  '` (which passes a bare non-empty guard) all store
 * happily, and only five characters or more raise. The database is therefore
 * not a backstop for this field, and this is what stands in for one.
 */
const EXCHANGE_MIC_CHARSET = /^[A-Z0-9]{4}$/;

function isValidExchangeMic(candidate: string): boolean {
  return EXCHANGE_MIC_CHARSET.test(candidate);
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const candidate =
    err instanceof postgres.PostgresError
      ? err
      : err instanceof Error && err.cause instanceof postgres.PostgresError
        ? err.cause
        : undefined;
  return candidate?.code === "23505" && candidate.constraint_name === constraintName;
}

export interface CreateInstrumentByIsinParams {
  /** Optional: defaults to a freshly minted UUID (all IDs are UUIDv7). */
  readonly id?: string;
  readonly kind: ShareEtfFundKind;
  readonly isin: string;
  /** ISO 10383 MIC — what makes a dual listing (same ISIN, different exchange) a distinct row (FR-3). */
  readonly exchangeMic: string;
  readonly listingCurrency: string;
  readonly displayName: string;
  /** Local ticker on that exchange — an attribute, never the dedupe key. */
  readonly symbol?: string;
  readonly figi?: string;
  /**
   * IR-10 — the
   * classification a discovery-assisted creation already showed the user,
   * written in this function's **same single `INSERT … RETURNING`**: no extra
   * round trip, no provider call on the write path (AC-7, NFR-15).
   *
   * Only ever set for `kind = "SHARE"` (FR-7) — `createInstrumentBodySchema`'s
   * `superRefine` rejects both fields for every other kind at the HTTP
   * boundary, so this path never receives them for an ETF or FUND.
   */
  readonly sectorCode?: InstrumentSectorCode;
  /** The opaque provider detail label (FR-6) — display-only, never a key. */
  readonly industryLabel?: string;
}

/**
 * The ISIN-based creation path for SHARE/ETF/FUND (AC1;
 * AC2 is the symbol-based path below, FR-3's dual-listing note).
 * `exchange_mic` plus `isin` together are the dedupe key — the same ISIN on
 * a *different* `exchange_mic` is a deliberate, distinct instrument (a dual
 * listing), never silently merged.
 *
 * Throws {@link InstrumentAlreadyExistsError} — never lets the raw unique
 * constraint violation escape — when the identical `(isin, exchange_mic)`
 * pair already exists.
 */
export async function createInstrumentByIsin(
  db: Db,
  params: CreateInstrumentByIsinParams,
): Promise<InstrumentRecord> {
  if (!params.isin) {
    throw new TypeError("createInstrumentByIsin requires a non-empty isin");
  }
  // Shape, not merely presence. The non-empty guard this replaces let
  // `'  '` through to a `char(4)` column that stored it as four blanks.
  if (!isValidExchangeMic(params.exchangeMic)) {
    throw new TypeError(
      `createInstrumentByIsin requires a 4-character ISO 10383 MIC (uppercase alphanumeric), got ${JSON.stringify(params.exchangeMic)}`,
    );
  }

  const id = params.id ?? randomUUID();
  // N4: normalised even though `symbol` is only an attribute on this path
  // (never the dedupe key, see this param's own doc comment) — a caller
  // reading it back later (e.g. `listInstruments`'s search) should still see
  // the same normalised form every symbol-carrying row uses.
  const symbol = params.symbol !== undefined ? normalizeSymbol(params.symbol) : null;
  try {
    const [row] = await db
      .insert(instrument)
      .values({
        id,
        kind: params.kind,
        displayName: params.displayName,
        listingCurrency: params.listingCurrency,
        exchangeMic: params.exchangeMic,
        isin: params.isin,
        symbol,
        figi: params.figi ?? null,
        primaryIdentifier: "ISIN",
        quotePolicy: defaultQuotePolicy(params.kind),
        // IR-10: `null` rather than omitted, so the column's meaning is
        // explicit at the one place it is written — "no classification yet" is
        // NULL (AC-5), never a sentinel. `domicile_country` is deliberately
        // **not** settable here at all (AC-10: never MIC-derived, never
        // ISIN-derived, only a verified seed or an explicit user entry).
        sectorCode: params.sectorCode ?? null,
        industryLabel: params.industryLabel ?? null,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, ISIN_EXCHANGE_MIC_CONSTRAINT)) {
      throw new InstrumentAlreadyExistsError(
        "ISIN_EXCHANGE_MIC",
        `An instrument with ISIN ${params.isin} on exchange ${params.exchangeMic} already exists.`,
      );
    }
    throw err;
  }
}

export interface CreateInstrumentBySymbolParams {
  /** Optional: defaults to a freshly minted UUID. */
  readonly id?: string;
  readonly kind: SymbolBasedKind;
  readonly symbol: string;
  readonly listingCurrency: string;
  readonly displayName: string;
  readonly figi?: string;
}

/**
 * The symbol-based creation path — AC2: "no ISIN
 * required" for CRYPTO. `symbol` alone (no `exchange_mic`) is the dedupe key,
 * enforced by the `UNIQUE (symbol) WHERE kind = 'CRYPTO'` partial index
 * (T-5) — this function never sets `isin` or `exchange_mic`.
 *
 * Also accepts `kind = 'INDEX'` (benchmarks, FR-31): nothing about this path
 * is CRYPTO-specific except the unique-symbol dedupe *rule*, which the T-5
 * schema itself scopes to `kind = 'CRYPTO'` only — an INDEX row can be
 * created the same way, simply without that dedupe guarantee. This is
 * deliberately as far as this service goes for INDEX: the benchmark
 * *comparison* feature (component C21) is
 * **[P1-LATER]** and out of scope for this run; only the identity primitive
 * is exercised here.
 *
 * Throws {@link InstrumentAlreadyExistsError} for a duplicate `CRYPTO`
 * `symbol`.
 */
export async function createInstrumentBySymbol(
  db: Db,
  params: CreateInstrumentBySymbolParams,
): Promise<InstrumentRecord> {
  if (!params.symbol) {
    throw new TypeError("createInstrumentBySymbol requires a non-empty symbol");
  }
  // N4: the dedupe key itself — normalised here so `"SPX"`/`"spx"`/`"SPX "`
  // collide, as AC1/AC2's dedupe guarantee intends, rather than each
  // inserting a distinct row into a unique index that compares raw text.
  const symbol = normalizeSymbol(params.symbol);
  if (!symbol) {
    throw new TypeError("createInstrumentBySymbol requires a non-empty symbol");
  }

  const id = params.id ?? randomUUID();
  try {
    const [row] = await db
      .insert(instrument)
      .values({
        id,
        kind: params.kind,
        displayName: params.displayName,
        listingCurrency: params.listingCurrency,
        exchangeMic: null,
        isin: null,
        symbol,
        figi: params.figi ?? null,
        primaryIdentifier: "SYMBOL",
        quotePolicy: defaultQuotePolicy(params.kind),
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, CRYPTO_SYMBOL_CONSTRAINT)) {
      throw new InstrumentAlreadyExistsError(
        "CRYPTO_SYMBOL",
        `A CRYPTO instrument with symbol ${symbol} already exists.`,
      );
    }
    if (isUniqueViolation(err, SYMBOL_NO_ISIN_CONSTRAINT)) {
      throw new InstrumentAlreadyExistsError(
        "SYMBOL_NO_ISIN",
        `A ${params.kind} instrument with symbol ${symbol} already exists.`,
      );
    }
    throw err;
  }
}

export interface CreateInstrumentScpiParams {
  /** Optional: defaults to a freshly minted UUID. */
  readonly id?: string;
  /** At least one of `isin` / `symbol` (a `TypeError` otherwise). */
  readonly isin?: string;
  /** Normalised like every symbol; the dedupe key only when `isin` is absent. */
  readonly symbol?: string;
  readonly listingCurrency: string;
  readonly displayName: string;
  readonly figi?: string;
  /** Société de gestion (FR-611); NULL when absent. */
  readonly managementCompany?: string;
  /** Frais de souscription, a percentage 0..100 (FR-611); NULL when absent. */
  readonly subscriptionFeePct?: Decimal;
}

/**
 * The SCPI creation path (`scpi`, SCD-2/SCD-5). An SCPI is
 * unlisted: `exchange_mic` is always NULL, the ISIN is optional and a typed
 * symbol (a code) identifies it otherwise, `primary_identifier` follows, and
 * `quote_policy` is `MANUAL_ONLY` by rule. Sector, industry and domicile are
 * never written here (AC-497: domicile null, never defaulted).
 *
 * **Dedupe.** With an ISIN, an existence probe over the shared catalogue
 * refuses an ISIN already used by *any* instrument — another SCPI or a listed
 * SHARE/ETF/FUND (FR-609's cross-kind sentence) — before the insert;
 * `instrument_isin_no_mic_key` closes SCPI-vs-SCPI races. Without an ISIN,
 * `instrument_symbol_no_isin_key (kind, symbol)` dedupes the code. Both map to
 * the existing {@link InstrumentAlreadyExistsError} literals, so the HTTP
 * response is the one every other kind's duplicate gets.
 *
 * Race, accepted: the probe and a concurrent
 * {@link createInstrumentByIsin} of the same ISIN can both pass, leaving the
 * dual-listing state every ISIN-only resolver already reports as ambiguous.
 */
export async function createInstrumentScpi(
  db: Db,
  params: CreateInstrumentScpiParams,
): Promise<InstrumentRecord> {
  const isin = params.isin !== undefined && params.isin !== "" ? params.isin : null;
  const normalized = params.symbol !== undefined ? normalizeSymbol(params.symbol) : "";
  const symbol = normalized !== "" ? normalized : null;
  if (isin === null && symbol === null) {
    throw new TypeError("createInstrumentScpi requires an isin or a non-empty symbol");
  }

  const duplicateIsin = (): InstrumentAlreadyExistsError =>
    new InstrumentAlreadyExistsError(
      "ISIN_EXCHANGE_MIC",
      `An instrument with ISIN ${isin} already exists.`,
    );

  if (isin !== null) {
    const existing = await db
      .select({ id: instrument.id })
      .from(instrument)
      .where(and(eq(instrument.isin, isin), isNull(instrument.ownerTenantId)))
      .limit(1);
    if (existing.length > 0) {
      throw duplicateIsin();
    }
  }

  const id = params.id ?? randomUUID();
  try {
    const [row] = await db
      .insert(instrument)
      .values({
        id,
        kind: "SCPI",
        displayName: params.displayName,
        listingCurrency: params.listingCurrency,
        exchangeMic: null,
        isin,
        symbol,
        figi: params.figi ?? null,
        primaryIdentifier: isin !== null ? "ISIN" : "SYMBOL",
        quotePolicy: defaultQuotePolicy("SCPI"),
        sectorCode: null,
        industryLabel: null,
        domicileCountry: null,
        managementCompany: params.managementCompany ?? null,
        subscriptionFeePct: params.subscriptionFeePct ?? null,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, ISIN_NO_MIC_CONSTRAINT)) {
      throw duplicateIsin();
    }
    if (isUniqueViolation(err, SYMBOL_NO_ISIN_CONSTRAINT)) {
      throw new InstrumentAlreadyExistsError(
        "SYMBOL_NO_ISIN",
        `An SCPI instrument with symbol ${symbol} already exists.`,
      );
    }
    throw err;
  }
}

export interface UpdateInstrumentDetailsParams {
  readonly displayName?: string;
  readonly status?: "ACTIVE" | "DELISTED" | "MERGED";
}

/**
 * Deliberately narrow: its parameter type structurally cannot carry `id` (or
 * `isin`/`exchangeMic`/`symbol`/`kind`/`figi`/`primaryIdentifier`/
 * `ownerTenantId`) — there is no field to even attempt to write it through.
 * Migration `0011_instrument-update-grant` additionally restricts the columns
 * `app_web` may `UPDATE` at all to `display_name`, `status`, `updated_at` —
 * the same "structural, not discipline" guarantee this codebase applies to
 * AC47 applied here to AC3's "the canonical id
 * never changes".
 *
 * No longer the *only* update path (2026-09-09): {@link setInstrumentFigi}
 * fills a missing `figi` under its own, differently-shaped, fill-once
 * guarantee — see that function's doc comment for why `figi` needed a
 * separate path rather than a field here.
 *
 * Symbol-mapping changes (`instrument_provider_map`) are T-12, not this
 * function.
 */
export async function updateInstrumentDetails(
  db: DbLike,
  id: string,
  patch: UpdateInstrumentDetailsParams,
): Promise<InstrumentRecord> {
  if (patch.displayName === undefined && patch.status === undefined) {
    throw new TypeError("updateInstrumentDetails requires at least one field to update");
  }

  const [row] = await db
    .update(instrument)
    .set({
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(instrument.id, id))
    .returning();

  if (!row) {
    throw new InstrumentNotFoundError(id);
  }
  return row;
}

/**
 * Fills a **missing** `figi` — asked for 2026-09-09, narrowing migration
 * `0036`/AC-36's "figi is never `app_web`-writable" to "not writable once
 * set" (migration `0061`). Everything else AC3 protects (`id`, `isin`,
 * `exchangeMic`, `symbol`, `kind`, `primaryIdentifier`, `ownerTenantId`) is
 * untouched — `figi` is the one identity field this codebase already treats
 * as legitimately absent at creation (`instrument-create.schema.ts`'s `figi`
 * is optional), so filling a gap is not the same claim as "the canonical id
 * never changes".
 *
 * **Fill-once, not correct-or-clear** — the opposite shape from
 * {@link updateInstrumentClassification}. `WHERE figi IS NULL` is part of the
 * same `UPDATE` that sets it, so a concurrent double-fill can't race past each
 * other, and there is no path here (or anywhere `app_web` reaches) to
 * overwrite an existing value: correcting a wrong `figi` is a bigger claim
 * than this function makes and is deliberately not this function's job.
 *
 * Distinguishes "no such instrument" (404) from "already set" (409) with one
 * extra read, but only on the failure path — the common case is a single
 * `UPDATE ... RETURNING`.
 */
export async function setInstrumentFigi(
  db: DbLike,
  id: string,
  figi: string,
): Promise<InstrumentRecord> {
  const [row] = await db
    .update(instrument)
    .set({ figi, updatedAt: new Date() })
    .where(and(eq(instrument.id, id), isNull(instrument.figi)))
    .returning();
  if (row) return row;

  const [existing] = await db.select().from(instrument).where(eq(instrument.id, id));
  if (!existing) {
    throw new InstrumentNotFoundError(id);
  }
  throw new InstrumentFigiAlreadySetError(id);
}

export interface UpdateInstrumentIdentityParams {
  readonly displayName?: string;
  readonly figi?: string;
}

/**
 * The `PATCH /instruments/:id/identity` write path — one call for the two
 * fields the instrument detail screen lets a user edit directly:
 * `displayName` (unconditional, {@link updateInstrumentDetails}) and `figi`
 * (fill-once, {@link setInstrumentFigi}). Both run inside one transaction, so
 * a request naming both never leaves a rename applied against a rejected
 * `figi` fill — it is all or nothing, exactly like a single-column `PATCH`
 * would be.
 */
export async function updateInstrumentIdentity(
  db: Db,
  id: string,
  patch: UpdateInstrumentIdentityParams,
): Promise<InstrumentRecord> {
  if (patch.displayName === undefined && patch.figi === undefined) {
    throw new TypeError("updateInstrumentIdentity requires at least one field to update");
  }

  return db.transaction(async (tx) => {
    if (patch.displayName !== undefined) {
      await updateInstrumentDetails(tx, id, { displayName: patch.displayName });
    }
    if (patch.figi !== undefined) {
      await setInstrumentFigi(tx, id, patch.figi);
    }
    const [row] = await tx.select().from(instrument).where(eq(instrument.id, id));
    if (!row) {
      throw new InstrumentNotFoundError(id);
    }
    return row;
  });
}

/**
 * The Kerdial sector codes, as the `instrument_sector` enum column actually
 * types them (migration `0035`, generated from `@kerdial/api-contracts`'
 * `SECTOR_CODES` — `platform/db/src/schema/instrument.ts`). Derived from the
 * row type rather than re-declared, so this service cannot drift from the
 * column and `ledger` needs no dependency on `core/api-contracts`.
 */
export type InstrumentSectorCode = NonNullable<InstrumentRecord["sectorCode"]>;

export interface ApplyProviderClassificationParams {
  /** The mapped Kerdial code, or `null` for "the provider said nothing this map understands" (FR-3). Never a raw provider string — the mapping happens in `market/composition`, before this call (DD20). */
  readonly sectorCode: InstrumentSectorCode | null;
  /** The provider's opaque detail label, verbatim, or `null` (FR-6). */
  readonly industryLabel: string | null;
}

/**
 * The provider lane's classification write — DD25; FR-3..FR-7. Called
 * from exactly one site (`market/composition`'s `resolveProviderSymbol`,
 * DD26) and best-effort there: a failure here must never fail a backfill
 * job, so this function does not soften anything itself, it simply either
 * writes or throws.
 *
 * **`COALESCE`, i.e. fill-if-absent, is the whole point (DD25).** Each column
 * is written only where it is currently `NULL`, so:
 *
 *   - re-resolving an instrument is idempotent, and
 *   - a provider resolve **can never clobber a user correction** — the user
 *     override (`PATCH /instruments/:id/classification`) is the higher
 *     authority, permanently, without needing a provenance column. A user
 *     who wants a re-fill clears the field, and the next resolve fills it.
 *
 * Both columns are independent: a row with a user-set `sector_code` and a
 * `NULL` `industry_label` gets its industry filled and its sector left alone.
 *
 * Runs as `app_ingest` in the worker lane, which migration `0036` grants
 * `UPDATE (sector_code, industry_label, updated_at)` on this table and
 * deliberately **not** `domicile_country` (DD24) — the issuer domicile is
 * never inferred by a provider lane, and that is a database guarantee rather
 * than a convention this function has to remember. There is therefore no
 * `domicileCountry` field in {@link ApplyProviderClassificationParams} either:
 * the parameter type structurally cannot carry one, the same "structural, not
 * discipline" habit {@link updateInstrumentDetails} records.
 *
 * Silent when `id` matches no row (unlike {@link updateInstrumentDetails}'s
 * {@link InstrumentNotFoundError}): the caller has just resolved a provider
 * symbol *for* that row, and a row that vanished mid-job is a completed
 * no-op, not an error worth failing a best-effort write over.
 */
export async function applyProviderClassification(
  db: Db,
  id: string,
  params: ApplyProviderClassificationParams,
): Promise<void> {
  await db
    .update(instrument)
    .set({
      // The explicit cast is required, not decorative: a bound parameter
      // arrives as `text`/`unknown`, and `COALESCE(sector_code, $1)` over the
      // `instrument_sector` enum column is a type mismatch without it.
      sectorCode: sql`coalesce(${instrument.sectorCode}, ${params.sectorCode}::"public"."instrument_sector")`,
      industryLabel: sql`coalesce(${instrument.industryLabel}, ${params.industryLabel}::text)`,
      updatedAt: new Date(),
    })
    .where(eq(instrument.id, id));
}

export interface UpdateInstrumentClassificationParams {
  /** A Kerdial code, or `null` to clear the classification back to « Non classé » (FR-3). Never a provider string — the enum is the column's own. */
  readonly sectorCode?: InstrumentSectorCode | null;
  /** The issuer's country of incorporation (2-letter, `instrument_domicile_country_charset`), or `null` to clear it. The **only** path by which this column is ever written (DD24: no provider lane may). */
  readonly domicileCountry?: string | null;
  /** The opaque detail label, corrected or cleared (DD31) — never mapped, never a grouping key. */
  readonly industryLabel?: string | null;
}

/**
 * The user override — DD30/DD31; FR-3, AC-36's write half. Sibling of
 * {@link updateInstrumentDetails}, and **just as narrow**: like that function's
 * patch type, {@link UpdateInstrumentClassificationParams} has no `id`,
 * `isin`, `exchangeMic`, `symbol`, `kind`, `figi`, `primaryIdentifier` or
 * `ownerTenantId` field, so an identity write is not something this function
 * refuses — it is something its parameter type cannot express. The
 * compile-time half of that claim is pinned in `instrument-service.test.ts`
 * with a `@ts-expect-error` fixture per field; migration `0036` refuses the
 * same seven columns in the database, as `app_web`.
 *
 * `null` clears, `undefined`/absent leaves alone, and a patch with no field at
 * all is a `TypeError` before the database is touched — matching
 * {@link updateInstrumentDetails} rather than issuing an `UPDATE` that would
 * still bump `updated_at`.
 *
 * **This is the higher authority over the provider lane, permanently.**
 * {@link applyProviderClassification} writes each column only where it is
 * `NULL` (`COALESCE`, DD25), so a later resolve cannot clobber what a user set
 * here; a user who wants a re-fill clears the field and the next resolve fills
 * it. That is why this function writes the columns plainly, with no COALESCE
 * of its own: the two directions are deliberately asymmetric.
 *
 * `domicile_country` is writable **only** from here (DD24/OD-3): no provider
 * lane may infer an issuer domicile from a MIC, and migration `0036` makes
 * that a `permission denied` for `app_ingest` rather than a convention.
 *
 * 404-shaped like {@link updateInstrumentDetails}: an unknown id is an
 * {@link InstrumentNotFoundError}, which `api`'s controller maps to the same
 * `INSTRUMENT_NOT_FOUND` 404 `getOne` already returns.
 *
 * **Shared-catalogue consequence, stated and not fixed here:** `instrument` is
 * shared reference data (see this file's header), so one tenant's correction
 * changes the row every tenant reads. That is C27 territory,
 * harmless while phase 1 is single-user (ADR-0014), and explicitly out of
 * scope for this function (NG11) — not a per-tenant override table.
 */
export async function updateInstrumentClassification(
  db: Db,
  id: string,
  patch: UpdateInstrumentClassificationParams,
): Promise<InstrumentRecord> {
  if (
    patch.sectorCode === undefined &&
    patch.domicileCountry === undefined &&
    patch.industryLabel === undefined
  ) {
    throw new TypeError("updateInstrumentClassification requires at least one field to update");
  }

  // `scpi` FR-608/N11: an SCPI carries no sector and no industry.
  // Only a non-null value is refused — `null` (the web form's hidden fields,
  // or clearing a pre-existing one) stays a valid write. The kind gate rides
  // in the `WHERE`, the {@link updateInstrumentScpiAttributes} shape.
  const setsSectorOrIndustry =
    (patch.sectorCode !== undefined && patch.sectorCode !== null) ||
    (patch.industryLabel !== undefined && patch.industryLabel !== null);

  const [row] = await db
    .update(instrument)
    .set({
      ...(patch.sectorCode !== undefined ? { sectorCode: patch.sectorCode } : {}),
      ...(patch.domicileCountry !== undefined ? { domicileCountry: patch.domicileCountry } : {}),
      ...(patch.industryLabel !== undefined ? { industryLabel: patch.industryLabel } : {}),
      updatedAt: new Date(),
    })
    .where(
      setsSectorOrIndustry
        ? and(eq(instrument.id, id), ne(instrument.kind, "SCPI"))
        : eq(instrument.id, id),
    )
    .returning();
  if (row) return row;

  if (setsSectorOrIndustry) {
    const [existing] = await db
      .select({ kind: instrument.kind })
      .from(instrument)
      .where(eq(instrument.id, id));
    if (existing) {
      throw new InstrumentAttributesNotApplicableError(
        id,
        existing.kind,
        `Instrument ${id} is an SCPI; an SCPI carries no sector and no industry`,
      );
    }
  }
  throw new InstrumentNotFoundError(id);
}

/**
 * Surfaced by {@link updateInstrumentScpiAttributes} when `id` resolves to an
 * instrument that is not an SCPI (`scpi`, SCD-8), and by
 * {@link updateInstrumentClassification} when a sector or industry is set on
 * an SCPI.
 */
export class InstrumentAttributesNotApplicableError extends Error {
  readonly instrumentId: string;
  readonly kind: string;

  constructor(
    instrumentId: string,
    kind: string,
    message = `Instrument ${instrumentId} is a ${kind}; SCPI attributes apply only to an SCPI`,
  ) {
    super(message);
    this.name = "InstrumentAttributesNotApplicableError";
    this.instrumentId = instrumentId;
    this.kind = kind;
  }
}

export interface UpdateInstrumentScpiAttributesParams {
  /** Société de gestion, or `null` to clear it (FR-612). */
  readonly managementCompany?: string | null;
  /** Frais de souscription (0..100, two decimals at most), or `null` to clear it. */
  readonly subscriptionFeePct?: Decimal | null;
}

/**
 * The `PATCH /instruments/:id/scpi-attributes` write path (`scpi` SCD-8; FR-612). Like {@link updateInstrumentClassification}, the
 * parameter type cannot express `kind`, `isin`, `symbol` or `quotePolicy`, so
 * an identity or policy write is not refused here — it is inexpressible; and
 * migration `0074` grants `app_web` `UPDATE` on these two columns only.
 *
 * `null` clears, absent leaves alone, and an empty patch is a `TypeError`
 * before any statement. One `UPDATE … WHERE id AND kind = 'SCPI' RETURNING`;
 * only when it matches nothing does one `SELECT kind` tell "no such
 * instrument" ({@link InstrumentNotFoundError}) from "not an SCPI"
 * ({@link InstrumentAttributesNotApplicableError}) — the
 * {@link setInstrumentFigi} shape.
 *
 * **No owner filter**, exactly as {@link updateInstrumentClassification}:
 * `instrument` is the shared catalogue (S-2, C27). Descriptive
 * facts only: no `calc_epoch` bump, no queue, no log line (AC-502).
 */
export async function updateInstrumentScpiAttributes(
  db: Db,
  id: string,
  patch: UpdateInstrumentScpiAttributesParams,
): Promise<InstrumentRecord> {
  if (patch.managementCompany === undefined && patch.subscriptionFeePct === undefined) {
    throw new TypeError("updateInstrumentScpiAttributes requires at least one field to update");
  }

  const [row] = await db
    .update(instrument)
    .set({
      ...(patch.managementCompany !== undefined
        ? { managementCompany: patch.managementCompany }
        : {}),
      ...(patch.subscriptionFeePct !== undefined
        ? { subscriptionFeePct: patch.subscriptionFeePct }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(instrument.id, id), eq(instrument.kind, "SCPI")))
    .returning();
  if (row) return row;

  const [existing] = await db
    .select({ kind: instrument.kind })
    .from(instrument)
    .where(eq(instrument.id, id));
  if (!existing) {
    throw new InstrumentNotFoundError(id);
  }
  throw new InstrumentAttributesNotApplicableError(id, existing.kind);
}

/**
 * A single instrument by id, or `undefined` if none exists — T-37's `GET /instruments/:id`. No tenant scoping (see this file's header):
 * `instrument` is shared catalogue data, visible to every tenant alike.
 *
 * F10 (security review, T-37, INFO): also filters
 * `owner_tenant_id IS NULL` — see {@link listInstruments}'s identical doc
 * comment for the forward-compat rationale (this function receives no
 * `tenantId` either, for the same reason).
 */
export async function getInstrumentById(db: Db, id: string): Promise<InstrumentRecord | undefined> {
  const [row] = await db
    .select()
    .from(instrument)
    .where(and(eq(instrument.id, id), isNull(instrument.ownerTenantId)));
  return row;
}

export interface InstrumentBackfillTarget {
  readonly id: string;
  readonly kind: InstrumentKind;
  /** `null` for the shared catalogue (every row in phase 1); a tenant id once phase 2 populates the column. */
  readonly ownerTenantId: string | null;
}

/**
 * `POST /instruments/:id/history-reload`'s **authorization input only**
 * (IB7).
 *
 * **Deliberately not {@link getInstrumentById}.** That function filters
 * `owner_tenant_id IS NULL` (the F10 forward-compat guard), which cannot
 * express FR-182's second half: a tenant-owned row is invisible to it, so the
 * **owner** of their own instrument would be told it does not exist. Today
 * that is latent — nothing writes `owner_tenant_id` — but encoding the wrong
 * rule now means the feature is silently broken on the day phase 2 populates
 * the column, with no test that would notice. So this read returns the row
 * whatever its owner is, and the *caller* applies the rule (`ownerTenantId`
 * null ⇒ allowed; `=== session.tenantId` ⇒ allowed; otherwise ⇒ 404, never
 * 403 — see the controller).
 *
 * **It returns no user-visible instrument data**, and that is the point: three
 * fields, none of them display data, identifiers, or classification. It
 * therefore cannot become a general "read any instrument, including another
 * tenant's" back door — anything it hands back that a caller is not entitled
 * to see would be a widening of this signature, not a change of a filter
 * somewhere.
 */
export async function getInstrumentBackfillTarget(
  db: Db,
  id: string,
): Promise<InstrumentBackfillTarget | undefined> {
  const [row] = await db
    .select({
      id: instrument.id,
      kind: instrument.kind,
      ownerTenantId: instrument.ownerTenantId,
    })
    .from(instrument)
    .where(eq(instrument.id, id));
  return row;
}

export interface ListInstrumentsParams {
  /** Case-insensitive substring match against `display_name`, `symbol`, and `isin` (the `?query=` convention, FR-1..FR-4's "search + resolve"). Omit/empty for no text filter. */
  readonly query?: string;
  readonly kind?: InstrumentKind;
  /** Rows to return, after `offset` — the API layer's cursor-pagination window (T-37's "cursor pagination on list endpoints"); this service takes a plain offset/limit and leaves cursor encoding to the caller. */
  readonly limit: number;
  readonly offset: number;
}

/**
 * F5 (security review, T-37): `%`, `_`, and `\` are `ILIKE`
 * pattern metacharacters (`_` matches any single character, `%` matches any
 * run of characters, `\` is the escape character itself) — a user-supplied
 * search fragment containing any of them must have them escaped *before*
 * this function wraps the fragment in its own `%...%` wildcards, or a
 * literal underscore/percent in a search term silently turns into a
 * wildcard the user never asked for (widening the match, not narrowing it —
 * the opposite of what a search box should do). Escaping the backslash
 * first is required so a fragment that already contains one is not
 * double-unescaped.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * The read side of `GET /instruments?query=&kind=` (T-37) —
 * not built by T-11 itself (whose own scope was creation/update only), added
 * here because it is the natural extension of this file's existing identity
 * service rather than a second, competing "instrument search" module.
 *
 * Ordered by `display_name` then `id` (a stable tiebreaker for rows sharing a
 * display name), so repeated calls with an advancing `offset` never skip or
 * repeat a row.
 *
 * F10 (security review, T-37): filters `owner_tenant_id IS
 * NULL` — a cheap forward-compat guard. `instrument` is the shared catalogue
 * in phase 1 (`owner_tenant_id` is always NULL), so this changes
 * nothing observable *today*; it exists so the day a writer populates that
 * column (a phase-2 per-tenant private instrument), this read does not
 * silently start leaking another tenant's private row across the shared
 * search surface. This function receives no `tenantId` to scope by, which is
 * exactly why `IS NULL` (not a tenant comparison) is the correct phase-1
 * guard here.
 */
export async function listInstruments(
  db: Db,
  params: ListInstrumentsParams,
): Promise<InstrumentRecord[]> {
  const conditions = [isNull(instrument.ownerTenantId)];
  if (params.kind !== undefined) {
    conditions.push(eq(instrument.kind, params.kind));
  }
  const trimmedQuery = params.query?.trim();
  if (trimmedQuery) {
    const pattern = `%${escapeLikePattern(trimmedQuery)}%`;
    // `or(...)` is typed `SQL | undefined` for the general (possibly
    // zero-argument) case; three literal arguments are always supplied
    // here, so it never actually returns `undefined`.
    conditions.push(
      or(
        ilike(instrument.displayName, pattern),
        ilike(instrument.symbol, pattern),
        // N10 (security review, T-37): migration
        // 0022's `instrument_isin_trgm_idx` is a GIN trigram index on the
        // *expression* `(isin::text)`, not on the bare `isin` column
        // (`isin` is `char(12)`/bpchar, which `gin_trgm_ops` has no overload
        // for). Plain `isin ILIKE $1` resolves to the native
        // `bpchar ~~* text` operator (Postgres does not implicitly cast the
        // column to `text` for that operator, only for the pattern
        // literal), which does not match the index's `(isin::text)`
        // expression syntactically — confirmed with `EXPLAIN` against a real
        // Postgres 17 container: without this cast the planner sequential
        // scans even with the index present; with it, a Bitmap Index Scan
        // against `instrument_isin_trgm_idx` is used. Casting here (rather
        // than dropping the `::text` from the index expression) matches
        // 0022's own doc comment's reasoning for why the expression index
        // exists in the first place — `gin_trgm_ops` still has no bpchar
        // overload either way, so the index itself must stay an expression
        // index; the query is what needed to change to match it.
        ilike(sql`${instrument.isin}::text`, pattern),
      )!,
    );
  }

  return db
    .select()
    .from(instrument)
    .where(and(...conditions))
    .orderBy(asc(instrument.displayName), asc(instrument.id))
    .limit(params.limit)
    .offset(params.offset);
}

/** The distinct identity set of a whole import file — deduplicated by the caller, resolved by one query. */
export interface InstrumentIdentitySet {
  readonly isins: readonly string[];
  readonly symbols: readonly string[];
}

/** The columns {@link findInstrumentsByIdentity} returns. Identity and routing only — no prices, no classification, no provider mapping. */
export interface InstrumentIdentityMatch {
  readonly id: string;
  readonly kind: InstrumentKind;
  readonly isin: string | null;
  readonly exchangeMic: string | null;
  readonly symbol: string | null;
  readonly primaryIdentifier: InstrumentRecord["primaryIdentifier"];
  readonly displayName: string;
}

/**
 * The batched identity read the CSV importer's `plan` stage needs
 * (CI-11) — **additive, and it
 * changes the behaviour of nothing above it**.
 *
 * `plan` must know, for the dry-run's counts, whether every instrument a
 * transaction file references already exists; catching
 * {@link InstrumentAlreadyExistsError} at apply time is three batches too late
 * for a summary the user is asked to confirm. It must also do so in **one round
 * trip for the whole file**: a real-world export references dozens of distinct
 * instruments across hundreds of rows, and a per-row read would be one round trip per row
 * inside a request already sized against a 30 s handler timeout.
 *
 * So this takes the file's whole *distinct* identity set and returns every
 * catalogue row matching any of it, in one statement. The one/many/none
 * decision — the three-step order, `(isin, exchange_mic)` then `isin` alone
 * then `symbol` — is the caller's, applied in memory against this result;
 * putting it here would push a format-agnostic resolution rule into `ledger`,
 * where nothing else needs it.
 *
 * **Both arrays empty ⇒ zero queries and an empty result.** An `IN ()` over an
 * empty set is a statement that can only return nothing, and issuing it would
 * make the importer's "exactly one round trip" assertion depend on how many
 * empty files it was handed.
 *
 * F10 (the same forward-compat guard {@link listInstruments} and
 * {@link getInstrumentById} carry): filters `owner_tenant_id IS NULL`. This
 * function receives no `tenantId` — `instrument` is the shared phase-1
 * catalogue with no `tenant_id` and no RLS (see this file's header) — which is
 * exactly why `IS NULL`, and not a tenant comparison, is the correct guard. The
 * day phase 2 populates that column, an import must not silently resolve a
 * trade against another tenant's private instrument.
 */
export async function findInstrumentsByIdentity(
  db: Db,
  refs: InstrumentIdentitySet,
): Promise<InstrumentIdentityMatch[]> {
  const isins = [...new Set(refs.isins)];
  const symbols = [...new Set(refs.symbols)];
  if (isins.length === 0 && symbols.length === 0) return [];

  const identityMatches = [
    ...(isins.length > 0 ? [inArray(instrument.isin, isins)] : []),
    ...(symbols.length > 0 ? [inArray(instrument.symbol, symbols)] : []),
  ];

  return db
    .select({
      id: instrument.id,
      kind: instrument.kind,
      isin: instrument.isin,
      exchangeMic: instrument.exchangeMic,
      symbol: instrument.symbol,
      primaryIdentifier: instrument.primaryIdentifier,
      displayName: instrument.displayName,
    })
    .from(instrument)
    .where(and(isNull(instrument.ownerTenantId), or(...identityMatches)!))
    .orderBy(asc(instrument.id));
}

/**
 * What still points at an instrument, and therefore why it cannot be deleted.
 * Counts, never row ids: the caller renders this to a person, and a
 * transaction id tells them nothing they can act on — the same reasoning
 * `portfolios.controller.ts` records for keeping `instrumentId` out of its 422.
 */
export interface InstrumentReferenceCounts {
  readonly transactions: number;
  readonly postings: number;
  readonly holdings: number;
  readonly realizedGains: number;
}

/**
 * `true` when nothing in {@link InstrumentReferenceCounts} is non-zero.
 *
 * Module-private: {@link deleteInstrument} is the only caller, and the
 * unused-exports gate is right that a second public name for "are these four
 * numbers all zero" earns nothing.
 */
function isUnreferenced(counts: InstrumentReferenceCounts): boolean {
  return (
    counts.transactions === 0 &&
    counts.postings === 0 &&
    counts.holdings === 0 &&
    counts.realizedGains === 0
  );
}

/**
 * Raised when {@link deleteInstrument} is asked to remove an instrument the
 * ledger still references. Carries the counts so the API can say *what*
 * blocks it rather than only *that* something does.
 *
 * `counts` is `undefined` for the one case the pre-check cannot see: a
 * reference held by **another tenant**. `transaction`/`transaction_posting`/
 * `holding_state`/`realized_gain` all FORCE row-level security, so the
 * pre-check below — which runs inside this tenant's context, as it must to see
 * anything at all — counts this tenant's rows only. Another tenant's row is
 * invisible to it and surfaces as the foreign-key violation instead, which is
 * caught and mapped to this same error with no counts. Single-tenant phase 1
 * never reaches that arm; it exists so the answer is a 409 rather than a 500
 * if that ever changes.
 */
export class InstrumentDeleteBlockedError extends Error {
  readonly instrumentId: string;
  readonly counts: InstrumentReferenceCounts | undefined;

  constructor(instrumentId: string, counts: InstrumentReferenceCounts | undefined) {
    super(
      counts === undefined
        ? `Cannot delete instrument ${instrumentId}: a foreign key still references it.`
        : `Cannot delete instrument ${instrumentId}: ${String(counts.transactions)} transaction(s), ` +
            `${String(counts.postings)} posting(s), ${String(counts.holdings)} holding(s) and ` +
            `${String(counts.realizedGains)} realized gain(s) still reference it.`,
    );
    this.name = "InstrumentDeleteBlockedError";
    this.instrumentId = instrumentId;
    this.counts = counts;
  }
}

/**
 * Counts every ledger row this tenant holds against `instrumentId` — the four
 * `NO ACTION` referents, in one round trip.
 *
 * Inside `withTenant`, necessarily: all four FORCE row-level security, and on
 * a connection with no `app.tenant_id` set they answer with **zero rows rather
 * than an error** (the fail-closed posture `roles-and-rls.integration.test.ts`
 * asserts). A count taken outside the tenant context would therefore report a
 * confidently wrong "nothing references this".
 */
async function countReferences(
  tx: Tx,
  tenantId: string,
  instrumentId: string,
): Promise<InstrumentReferenceCounts> {
  const [row] = await tx.execute<{
    transactions: string;
    postings: string;
    holdings: string;
    realizedGains: string;
  }>(sql`
    select
      (select count(*) from "transaction"
        where tenant_id = ${tenantId}
          and (instrument_id = ${instrumentId} or txn_settlement_instrument_id = ${instrumentId}))
        as "transactions",
      (select count(*) from "transaction_posting"
        where tenant_id = ${tenantId} and instrument_id = ${instrumentId}) as "postings",
      (select count(*) from "holding_state"
        where tenant_id = ${tenantId} and instrument_id = ${instrumentId}) as "holdings",
      (select count(*) from "realized_gain"
        where tenant_id = ${tenantId} and instrument_id = ${instrumentId}) as "realizedGains"
  `);
  const toCount = (value: string | undefined): number => Number.parseInt(value ?? "0", 10);
  return {
    transactions: toCount(row?.transactions),
    postings: toCount(row?.postings),
    holdings: toCount(row?.holdings),
    realizedGains: toCount(row?.realizedGains),
  };
}

export interface DeleteInstrumentParams {
  readonly tenantId: string;
  readonly instrumentId: string;
}

export interface DeleteInstrumentResult {
  /** `false` when no such instrument existed — the caller's 404, never an exception. */
  readonly deleted: boolean;
}

/**
 * Deletes an instrument and everything that cascades from it.
 *
 * ## Only the parent row is deleted, deliberately
 *
 * Eight tables carry `ON DELETE CASCADE` to `instrument`
 * (`instrument_price_daily`, `manual_price_point`, `instrument_price_gap`,
 * `instrument_provider_map`, `instrument_quote_latest`,
 * `instrument_backfill_state`, `instrument_icon`, `watchlist_item`), and three
 * of those FORCE row-level security. **Do not "tidy up" the children first.**
 * Measured against the live schema 2026-09-18, in a rolled-back transaction: a
 * direct `DELETE FROM manual_price_point` as `app_owner` reports `DELETE 0`
 * (the policy is `TO app_web`, so the owner matches no policy and FORCE denies
 * it), while deleting the parent removes that row and every other child with
 * it. Postgres runs referential actions with row-level security not enforced;
 * an ordinary statement has no such exemption. A hand-rolled child sweep would
 * delete none of the three FORCEd tables and then fail on the foreign key.
 *
 * ## Why the reference check is explicit as well as enforced
 *
 * The five `NO ACTION` foreign keys (`transaction` twice, `transaction_posting`,
 * `holding_state`, `realized_gain`) already make a referenced instrument
 * undeletable — but as a `23503` that would reach the API as a generic 500.
 * {@link countReferences} runs first, in the same transaction, so the refusal
 * is a 409 that names what blocks it. The `23503` catch below is the backstop
 * for what that check cannot see (another tenant's rows — see
 * {@link InstrumentDeleteBlockedError}) and for the race between the two
 * statements.
 *
 * ## The tenant context
 *
 * `instrument` itself carries no `tenant_id` and no RLS policy (this file's
 * header), so the `DELETE` needs no tenant context. The **count** does, since
 * all four referents FORCE RLS. Both therefore run inside one `withTenant`
 * transaction — the check and the delete are atomic with respect to a
 * concurrent transaction write, which is the property that makes the 409
 * meaningful rather than advisory.
 */
export async function deleteInstrument(
  db: Db,
  params: DeleteInstrumentParams,
): Promise<DeleteInstrumentResult> {
  const { tenantId, instrumentId } = params;
  try {
    return await withTenant(db, tenantId, async (tx) => {
      const counts = await countReferences(tx, tenantId, instrumentId);
      if (!isUnreferenced(counts)) {
        throw new InstrumentDeleteBlockedError(instrumentId, counts);
      }
      const deleted = await tx
        .delete(instrument)
        .where(and(eq(instrument.id, instrumentId), isNull(instrument.ownerTenantId)))
        .returning({ id: instrument.id });
      return { deleted: deleted.length > 0 };
    });
  } catch (err) {
    if (err instanceof InstrumentDeleteBlockedError) throw err;
    if (extractPostgresError(err)?.sqlstate === FOREIGN_KEY_VIOLATION) {
      throw new InstrumentDeleteBlockedError(instrumentId, undefined);
    }
    throw err;
  }
}
