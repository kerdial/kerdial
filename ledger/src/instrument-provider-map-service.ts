import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { bumpMarketDataEpoch } from "@kerdial/market-ingestion";
import {
  instrumentPriceDaily,
  instrumentProviderMap,
  type Db,
  type Tx,
} from "@kerdial/platform-db";

/**
 * Every function below accepts either a plain connection ({@link Db}) or a
 * transaction handle ({@link Tx}) — the latter so {@link swapProviderMapping}
 * can compose {@link deleteProviderMapping} and {@link createProviderMapping}
 * inside its own `db.transaction(...)` call.
 */
type DbLike = Db | Tx;

/**
 * `ledger`'s instrument provider mapping service — T-12
 * (component C4). Owns CRUD over `instrument_provider_map`: one row per
 * `(instrument_id, provider_key)` — the table's own `PRIMARY KEY` (T-5) makes
 * "at most one active mapping per (instrument, provider)" unrepresentable at
 * the database layer, not merely a service-code convention.
 *
 * This is the "re-mapping job" mechanism, and the
 * system's highest-consequence silent failure mode: a wrong `HEURISTIC`
 * mapping produces plausible-but-wrong prices. `confidence` is therefore
 * treated here as a safety control, not descriptive metadata — every mapping
 * is created with an explicit confidence, {@link confirmProviderMapping} is
 * the only state transition from `HEURISTIC` to `CONFIRMED`, and
 * {@link isUnverifiedMapping} gives downstream consumers (the UI's
 * "unverified data source" hint, R7) a single place to query the
 * distinction instead of re-deriving it from a raw string comparison at each
 * call site.
 *
 * **Why no `withTenant`.** Exactly the reasoning `instrument-service.ts`
 * documents for `instrument` itself: `instrument_provider_map` is shared
 * reference catalogue data, not tenant-owned (the table
 * definition carries no `tenant_id`; recorded in `platform/db/src/schema/README.md`
 * and confirmed by migration `0007_roles-grants-rls.sql`, which deliberately
 * does not enable row-level security on this table). `withTenant`'s entire
 * purpose is setting the transaction-local `app.tenant_id` GUC that RLS
 * policies read — there is no such policy here for it to satisfy. Every
 * function below takes a plain `Db` (or `Tx`, for {@link swapProviderMapping}'s
 * internal composition) and issues an ordinary (unscoped) query.
 */

/** @public (AR-3): the nameable form of an exported signature's type — consumers receive it structurally; exported so call sites can name it. Unmasked by the same vi.mock removal the gate's other @public tags record. */
export type ProviderMapConfidence = "CONFIRMED" | "HEURISTIC";

/** Mirrors `instrument_provider_map`'s row shape — see `platform/db/src/schema/instrument-provider-map.ts`. */
export type ProviderMappingRecord = typeof instrumentProviderMap.$inferSelect;

const INSTRUMENT_PROVIDER_CONSTRAINT = "instrument_provider_map_instrument_id_provider_key_pk";
const PROVIDER_SYMBOL_CONSTRAINT = "instrument_provider_map_provider_symbol_key";

/**
 * Surfaced in place of the raw Postgres unique-violation when either this
 * table's `PRIMARY KEY (instrument_id, provider_key)` or its
 * `UNIQUE (provider_key, provider_symbol)` index (both T-5) is violated.
 * `INSTRUMENT_PROVIDER` is the former (this instrument already has a mapping
 * for this provider); `PROVIDER_SYMBOL` is the latter (some *other*
 * instrument is already mapped to this exact provider+symbol pair — the
 * conflict T-12's own acceptance criteria names explicitly).
 */
export class ProviderMappingAlreadyExistsError extends Error {
  readonly conflict: "INSTRUMENT_PROVIDER" | "PROVIDER_SYMBOL";

  constructor(conflict: "INSTRUMENT_PROVIDER" | "PROVIDER_SYMBOL", message: string) {
    super(message);
    this.name = "ProviderMappingAlreadyExistsError";
    this.conflict = conflict;
  }
}

/** Surfaced by {@link confirmProviderMapping}, {@link deleteProviderMapping}, and {@link swapProviderMapping} when no matching row exists. */
export class ProviderMappingNotFoundError extends Error {
  readonly instrumentId: string;
  readonly providerKey: string;

  constructor(instrumentId: string, providerKey: string) {
    super(`No instrument_provider_map row for instrument ${instrumentId}, provider ${providerKey}`);
    this.name = "ProviderMappingNotFoundError";
    this.instrumentId = instrumentId;
    this.providerKey = providerKey;
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

export interface CreateProviderMappingParams {
  readonly instrumentId: string;
  readonly providerKey: string;
  readonly providerSymbol: string;
  readonly confidence: ProviderMapConfidence;
  /**
   * Defaults to `undefined` (never verified) for a `HEURISTIC` mapping;
   * defaults to "now" for a `CONFIRMED` one, since a mapping created already
   * `CONFIRMED` (e.g. the user typed the provider's own ticker directly) is,
   * by definition, verified as of its creation. Either default can be
   * overridden explicitly.
   */
  readonly lastVerifiedAt?: Date;
}

/**
 * Creates a mapping row — the "guessed"/search-resolution path
 * (`confidence: 'HEURISTIC'`) and the user-confirmed path
 * (`confidence: 'CONFIRMED'`) are both this same function; the caller states
 * which one it is, and the confidence is never inferred or defaulted by this
 * service.
 *
 * Throws {@link ProviderMappingAlreadyExistsError} — never lets the raw
 * unique-constraint violation escape — for either conflict this table's
 * schema can produce.
 */
export async function createProviderMapping(
  db: DbLike,
  params: CreateProviderMappingParams,
): Promise<ProviderMappingRecord> {
  if (!params.providerKey) {
    throw new TypeError("createProviderMapping requires a non-empty providerKey");
  }
  if (!params.providerSymbol) {
    throw new TypeError("createProviderMapping requires a non-empty providerSymbol");
  }

  const lastVerifiedAt =
    params.lastVerifiedAt ?? (params.confidence === "CONFIRMED" ? new Date() : undefined);

  try {
    const [row] = await db
      .insert(instrumentProviderMap)
      .values({
        instrumentId: params.instrumentId,
        providerKey: params.providerKey,
        providerSymbol: params.providerSymbol,
        confidence: params.confidence,
        lastVerifiedAt: lastVerifiedAt ?? null,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, INSTRUMENT_PROVIDER_CONSTRAINT)) {
      throw new ProviderMappingAlreadyExistsError(
        "INSTRUMENT_PROVIDER",
        `Instrument ${params.instrumentId} already has a mapping for provider ${params.providerKey}.`,
      );
    }
    if (isUniqueViolation(err, PROVIDER_SYMBOL_CONSTRAINT)) {
      throw new ProviderMappingAlreadyExistsError(
        "PROVIDER_SYMBOL",
        `Provider ${params.providerKey} symbol ${params.providerSymbol} is already mapped to a different instrument.`,
      );
    }
    throw err;
  }
}

/** Returns the single mapping row for `(instrumentId, providerKey)`, or `undefined` if none exists. */
export async function getProviderMapping(
  db: DbLike,
  instrumentId: string,
  providerKey: string,
): Promise<ProviderMappingRecord | undefined> {
  const [row] = await db
    .select()
    .from(instrumentProviderMap)
    .where(
      and(
        eq(instrumentProviderMap.instrumentId, instrumentId),
        eq(instrumentProviderMap.providerKey, providerKey),
      ),
    );
  return row;
}

/**
 * Which instrument, if any, already claims a `(providerKey, providerSymbol)`
 * pair — the read behind the pre-flight conflict check.
 *
 * The pair is `UNIQUE` at the database layer, so
 * {@link createProviderMapping} already refuses to steal one. This exists so a
 * request can be refused *before* it has side effects: the repair endpoint
 * resets the instrument's backfill state and enqueues a re-walk before it writes
 * the mapping, and discovering the conflict only at the insert would leave that
 * reset behind for a request that then failed. A pre-check plus the constraint
 * is the usual pairing — the check makes the common case clean, the constraint
 * makes the racing case correct.
 */
export async function findInstrumentByProviderSymbol(
  db: DbLike,
  providerKey: string,
  providerSymbol: string,
): Promise<ProviderMappingRecord | undefined> {
  const [row] = await db
    .select()
    .from(instrumentProviderMap)
    .where(
      and(
        eq(instrumentProviderMap.providerKey, providerKey),
        eq(instrumentProviderMap.providerSymbol, providerSymbol),
      ),
    );
  return row;
}

/**
 * Every provider mapping row for one instrument — the read API T-12's own
 * acceptance criteria requires a `HEURISTIC` mapping be "distinguishable...
 * from a `CONFIRMED` mapping" through: each row's `confidence` field answers
 * that directly, and {@link isUnverifiedMapping} below is the queryable
 * predicate a caller should use rather than re-comparing the string itself.
 */
export async function listProviderMappings(
  db: DbLike,
  instrumentId: string,
): Promise<ProviderMappingRecord[]> {
  return db
    .select()
    .from(instrumentProviderMap)
    .where(eq(instrumentProviderMap.instrumentId, instrumentId));
}

/**
 * `true` iff this mapping is `HEURISTIC` — i.e. unconfirmed, per the rule that
 * "mappings are marked HEURISTIC until the user confirms; unconfirmed
 * mappings surface a UI warning." This is the single predicate downstream
 * consumers (the UI hint built in T-43/T-45) should call, rather than each comparing `confidence ===
 * 'HEURISTIC'` independently.
 */
export function isUnverifiedMapping(mapping: ProviderMappingRecord): boolean {
  return mapping.confidence === "HEURISTIC";
}

/**
 * The `HEURISTIC` → `CONFIRMED` state transition (the R7 mitigation): a
 * user has looked at the guessed mapping and confirmed it is correct.
 * Idempotent in effect if called again on an already-`CONFIRMED` mapping
 * (simply bumps `last_verified_at`), but this is **not** a general-purpose
 * update — it is the one narrow transition this service exposes, the same
 * "structurally narrow, not merely disciplined" shape
 * `instrument-service.ts`'s `updateInstrumentDetails` uses for AC3.
 *
 * Throws {@link ProviderMappingNotFoundError} if no such mapping exists.
 */
export async function confirmProviderMapping(
  db: DbLike,
  instrumentId: string,
  providerKey: string,
  verifiedAt: Date = new Date(),
): Promise<ProviderMappingRecord> {
  const [row] = await db
    .update(instrumentProviderMap)
    .set({ confidence: "CONFIRMED", lastVerifiedAt: verifiedAt })
    .where(
      and(
        eq(instrumentProviderMap.instrumentId, instrumentId),
        eq(instrumentProviderMap.providerKey, providerKey),
      ),
    )
    .returning();

  if (!row) {
    throw new ProviderMappingNotFoundError(instrumentId, providerKey);
  }
  return row;
}

/**
 * Removes a mapping row outright. Throws {@link ProviderMappingNotFoundError}
 * if no such mapping exists. `ON DELETE CASCADE` runs the other way (an
 * `instrument` deletion cascades into this table, T-5) — deleting a mapping
 * row itself never touches `instrument` or anything downstream of it.
 */
export async function deleteProviderMapping(
  db: DbLike,
  instrumentId: string,
  providerKey: string,
): Promise<void> {
  const rows = await db
    .delete(instrumentProviderMap)
    .where(
      and(
        eq(instrumentProviderMap.instrumentId, instrumentId),
        eq(instrumentProviderMap.providerKey, providerKey),
      ),
    )
    .returning();

  if (rows.length === 0) {
    throw new ProviderMappingNotFoundError(instrumentId, providerKey);
  }
}

export interface SwapProviderMappingParams {
  readonly fromProviderKey: string;
  readonly toProviderKey: string;
  readonly toProviderSymbol: string;
  readonly confidence: ProviderMapConfidence;
  readonly lastVerifiedAt?: Date;
}

/**
 * The explicit "swap the underlying data provider for an already-tracked
 * instrument" operation — the "phase-2 migration = change
 * the route config and run a re-mapping job over `instrument_provider_map`,"
 * and its headline acceptance criterion (AC3, FR-5): the
 * instrument's `id`, `display_name`, and any transaction referencing it must
 * be untouched by this call, because nothing here ever writes to `instrument`
 * or anything downstream of it — only this table's rows change.
 *
 * Runs the delete of the old `(instrumentId, fromProviderKey)` row and the
 * insert of the new `(instrumentId, toProviderKey)` row in a single database
 * transaction, so a mid-swap failure never leaves the instrument with zero
 * provider mappings.
 *
 * Throws {@link ProviderMappingNotFoundError} if no mapping exists for
 * `fromProviderKey`, and {@link ProviderMappingAlreadyExistsError} if the new
 * `(providerKey, providerSymbol)` pair is already claimed by a different
 * instrument.
 */
export async function swapProviderMapping(
  db: DbLike,
  instrumentId: string,
  params: SwapProviderMappingParams,
): Promise<ProviderMappingRecord> {
  return db.transaction(async (tx) => {
    await deleteProviderMapping(tx, instrumentId, params.fromProviderKey);
    return createProviderMapping(tx, {
      instrumentId,
      providerKey: params.toProviderKey,
      providerSymbol: params.toProviderSymbol,
      confidence: params.confidence,
      ...(params.lastVerifiedAt !== undefined ? { lastVerifiedAt: params.lastVerifiedAt } : {}),
    });
  });
}

/**
 * What a repair actually did — the recovery path for a wrong mapping.
 *
 * `discardedPriceRows` is reported rather than swallowed because it is the
 * consequence a caller has to be able to state to the user: the series that was
 * there is gone, and the instrument is priceless until its re-backfill lands.
 */
export interface ProviderMappingRepairResult {
  /** The mapping now in force, or `null` when the repair removed it (so the next backfill re-resolves from scratch). */
  readonly mapping: ProviderMappingRecord | null;
  /** `instrument_price_daily` rows deleted — the whole automated series for this instrument. `manual_price_point` is never touched. */
  readonly discardedPriceRows: number;
}

/**
 * **Why a repair discards the price series, rather than only re-pointing the
 * mapping** (the repair's third acceptance criterion).
 *
 * Every `instrument_price_daily` row for an instrument is the product of the
 * mapping being replaced here. NOV's 4 995 rows are Copenhagen's DKK closes
 * because its mapping resolved `NOVO-B.CO`; correcting the mapping does not
 * make those rows right, it makes them *orphaned* — a different venue's series,
 * at a different close time, sitting under an instrument that now claims
 * another one.
 *
 * Leaving them and relying on the re-backfill to overwrite does not work, and
 * the reason is worth stating so nobody proposes it again: `upsertPriceDailyViaDb`
 * is keyed on `(instrument_id, price_date)`, so it corrects exactly the dates
 * the *new* symbol returns and leaves every date it does not — a different
 * listing history, a different first-trade date, a holiday calendar that does
 * not line up. The result is a series that is partly right, silently, forever.
 * That is the same shape as the bug being repaired.
 *
 * So the delete is unconditional and total for that instrument. It is
 * destructive and it is the point: the honest state after a repair is "no
 * automated history yet", which the re-backfill then fills from the corrected
 * mapping. `manual_price_point` is a different table and is deliberately not
 * touched — a hand-entered NAV was never the provider's to be wrong about.
 */
async function discardAutomatedPriceSeries(tx: Tx, instrumentId: string): Promise<number> {
  const deleted = await tx
    .delete(instrumentPriceDaily)
    .where(eq(instrumentPriceDaily.instrumentId, instrumentId))
    .returning({ priceDate: instrumentPriceDaily.priceDate });
  return deleted.length;
}

/**
 * Corrects an instrument's provider mapping and discards the series the wrong
 * mapping wrote — the operation `swapProviderMapping` was built for
 * and never given a caller.
 *
 * **Confidence is not a parameter.** A mapping written by this path is
 * `CONFIRMED`, with `lastVerifiedAt` stamped: a human looked at the instrument,
 * decided the provider symbol was wrong, and typed the right one. That is
 * precisely the `HEURISTIC` → verified transition the R7 mitigation describes, and letting
 * a caller pass `HEURISTIC` here would mean recording a hand-made correction as
 * a guess.
 *
 * **Creates rather than fails when no mapping exists.** An instrument whose
 * resolution never succeeded has no row at all (`history-backfill-handler.ts`
 * leaves such a row `PENDING`, writing nothing), and "I know what this
 * instrument's provider symbol is" is exactly as valid an assertion there as it
 * is over a wrong mapping. Failing would leave the unresolvable case with no manual escape either.
 *
 * **The epoch bump is outside the transaction, and conditional.** Both rules
 * come from `bumpMarketDataEpoch`'s own doc comment: strictly after the rows
 * commit (a bump visible before its own deletes would let a reader stamp a
 * permanently-stale cache row), and only when something actually changed (a
 * repair that discarded nothing changed no valuation input).
 *
 * Throws {@link ProviderMappingAlreadyExistsError} when the target
 * `(providerKey, providerSymbol)` pair already belongs to a different
 * instrument — the caller must surface that rather than silently stealing it.
 */
export async function correctProviderMapping(
  db: Db,
  instrumentId: string,
  params: {
    readonly providerKey: string;
    readonly providerSymbol: string;
    /** Test seam; production passes nothing and gets "now". */
    readonly verifiedAt?: Date;
  },
): Promise<ProviderMappingRepairResult> {
  const verifiedAt = params.verifiedAt ?? new Date();

  const result = await db.transaction(async (tx) => {
    const existing = await getProviderMapping(tx, instrumentId, params.providerKey);
    const mapping = existing
      ? // The composed delete-then-create, in one statement pair, is exactly
        // what `swapProviderMapping` is: reused rather than re-implemented, so
        // there is one place that knows a swap must not leave an instrument
        // with zero mappings. Its own `db.transaction` opens a savepoint under
        // this one, which is the behaviour that makes it composable at all.
        await swapProviderMapping(tx, instrumentId, {
          fromProviderKey: params.providerKey,
          toProviderKey: params.providerKey,
          toProviderSymbol: params.providerSymbol,
          confidence: "CONFIRMED",
          lastVerifiedAt: verifiedAt,
        })
      : await createProviderMapping(tx, {
          instrumentId,
          providerKey: params.providerKey,
          providerSymbol: params.providerSymbol,
          confidence: "CONFIRMED",
          lastVerifiedAt: verifiedAt,
        });

    const discardedPriceRows = await discardAutomatedPriceSeries(tx, instrumentId);
    return { mapping, discardedPriceRows };
  });

  if (result.discardedPriceRows > 0) await bumpMarketDataEpoch(db);
  return result;
}

/**
 * Removes an instrument's provider mapping and discards the series it wrote —
 * the other half of the recovery path.
 *
 * The difference from {@link correctProviderMapping} is who decides the symbol.
 * Correcting says "it is *this* one"; clearing says "I do not know, and the one
 * you have is wrong" — `resolveProviderSymbol` short-circuits on any existing
 * mapping, so removing the row is the only way to make the next backfill run
 * resolve again from the instrument's own identifiers instead of from a guess
 * that already went wrong.
 *
 * It discards the price series for the identical reason, and with the identical
 * consequence: the instrument is priceless until a re-resolution and re-backfill
 * land, and if resolution keeps failing it stays that way — visibly, as a
 * `PENDING`-and-attempted row on the `ingestionStaleness` indicator,
 * rather than invisibly, priced off another listing.
 *
 * Throws {@link ProviderMappingNotFoundError} when there is nothing to clear.
 */
export async function clearProviderMapping(
  db: Db,
  instrumentId: string,
  providerKey: string,
): Promise<ProviderMappingRepairResult> {
  const result = await db.transaction(async (tx) => {
    await deleteProviderMapping(tx, instrumentId, providerKey);
    const discardedPriceRows = await discardAutomatedPriceSeries(tx, instrumentId);
    return { mapping: null, discardedPriceRows };
  });

  if (result.discardedPriceRows > 0) await bumpMarketDataEpoch(db);
  return result;
}
