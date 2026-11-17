import {
  EXPOSURE_WEIGHT_DIMENSIONS,
  EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND,
  validateExposureWeightSet,
  type ExposureWeightDimension,
  type ExposureWeightPart,
  type ExposureWeightRefusal,
} from "@kerdial/api-contracts";
import { parseDecimalString, type Decimal } from "@kerdial/core-decimal";
import { SECTOR_CODES, type SectorCode } from "@kerdial/core-reference-data";
import { instrument, instrumentExposureWeight, type Db, type Tx } from "@kerdial/platform-db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { InstrumentNotFoundError, type InstrumentKind } from "./instrument-service.js";

/**
 * The one writer and the one reader of `instrument_exposure_weight` (EW-T9;
 * FR-719, FR-720, FR-722, FR-723, FR-724, NFR-99, NFR-100). The API's
 * `PATCH /instruments/:id/exposure-weights` and the catalogue import both
 * write through {@link replaceInstrumentExposureWeights}; every read of a
 * stored set goes through {@link listInstrumentExposureWeights}, where a later
 * cycle's manual-over-provider precedence will live.
 *
 * **Why the sum cap is race-proof.** Postgres cannot CHECK an aggregate, so
 * "Σ ≤ 100 per (instrument, dimension)" rests here. Read-then-write in one
 * transaction is not enough under READ COMMITTED: two concurrent replaces of
 * one dimension would each delete the other's not-yet-committed nothing and
 * both insert, leaving the union. So the writer validates the whole set
 * first, then takes the instrument row lock (`SELECT … FOR NO KEY UPDATE`),
 * and only then deletes and inserts: every weight write of one instrument is
 * serialised, and the stored set is always one set the validator accepted.
 * `NO KEY UPDATE` rather than `UPDATE`: two writers still exclude each other,
 * but the lock does not conflict with the `FOR KEY SHARE` every insert of a
 * row referencing the instrument takes (a transaction, a price point), so a
 * weight write neither waits behind an import chunk nor blocks one.
 *
 * **No `withTenant`**: the table is shared catalogue data (EW-L3) with no RLS,
 * like `instrument` itself (see `instrument-service.ts`'s header); only
 * `owner_tenant_id IS NULL` instrument rows are locked and written, the
 * `getInstrumentById` predicate.
 *
 * **No date of any kind** (EW-L12): no timestamp column, and the lock is a
 * plain row lock, never an `UPDATE` — `instrument.updated_at` does not
 * move, so it cannot become the weight set's de facto "as of". No log line.
 */

/** One stored weight: its bucket code (a sector code or an ISO 3166-1 alpha-2 code) and its exact value. */
export interface StoredExposureWeight {
  readonly code: string;
  readonly weight: Decimal;
}

/**
 * An instrument's stored `MANUAL` sets. A dimension is **absent** when it has
 * no row, never an empty array; each list is sorted by weight descending, then
 * code ascending.
 */
export interface InstrumentExposureWeights {
  readonly sectorWeights?: readonly StoredExposureWeight[];
  readonly countryWeights?: readonly StoredExposureWeight[];
}

/** One wire item, exactly as the API body or a catalogue file states it. */
interface ExposureWeightItem {
  readonly code: string;
  readonly weight: string;
}

/**
 * What a caller may write: each named dimension is replaced whole, `[]` clears
 * it, an absent key leaves it alone. **Structurally no `origin`**: this
 * cycle's only writer is manual, and a later provider writer has to change
 * this signature visibly rather than pass a flag through it.
 */
export interface ReplaceInstrumentExposureWeightsParams {
  readonly sectorWeights?: readonly ExposureWeightItem[];
  readonly countryWeights?: readonly ExposureWeightItem[];
}

/** A named set failed FR-720's validation; nothing was stored. `index` is the offending item. */
export class ExposureWeightSetRefusedError extends Error {
  readonly dimension: ExposureWeightDimension;
  readonly reason: ExposureWeightRefusal;
  readonly index: number;

  constructor(dimension: ExposureWeightDimension, reason: ExposureWeightRefusal, index: number) {
    super(`The ${dimension} weight set is refused (${reason}) at item ${index}`);
    this.name = "ExposureWeightSetRefusedError";
    this.dimension = dimension;
    this.reason = reason;
    this.index = index;
  }
}

/** The instrument's kind cannot carry a weight set in that dimension (FR-723, EW-L4); nothing was stored. */
export class ExposureWeightsNotApplicableError extends Error {
  readonly instrumentId: string;
  readonly kind: InstrumentKind;
  readonly dimension: ExposureWeightDimension;

  constructor(instrumentId: string, kind: InstrumentKind, dimension: ExposureWeightDimension) {
    super(`Instrument ${instrumentId} is a ${kind}; a ${kind} carries no ${dimension} weights`);
    this.name = "ExposureWeightsNotApplicableError";
    this.instrumentId = instrumentId;
    this.kind = kind;
    this.dimension = dimension;
  }
}

/** Whether `kind` may carry a weight set in `dimension` — the one eligibility list, never a copy. */
export function kindCarriesExposureWeights(
  kind: InstrumentKind,
  dimension: ExposureWeightDimension,
): boolean {
  return EXPOSURE_WEIGHT_DIMENSIONS_BY_KIND[kind].includes(dimension);
}

function isSectorCode(code: string): code is SectorCode {
  return (SECTOR_CODES as readonly string[]).includes(code);
}

function byWeightThenCode(a: StoredExposureWeight, b: StoredExposureWeight): number {
  const byWeight = b.weight.comparedTo(a.weight);
  if (byWeight !== 0) return byWeight;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * Deletes the instrument's `MANUAL` rows of one dimension and inserts `parts`
 * in one multi-row `INSERT` (none for an empty set). The caller holds the
 * instrument row lock, or has just inserted the row in the same transaction.
 */
async function writeDimension(
  tx: Tx,
  instrumentId: string,
  dimension: ExposureWeightDimension,
  parts: readonly ExposureWeightPart[],
): Promise<void> {
  const column =
    dimension === "sector"
      ? instrumentExposureWeight.sectorCode
      : instrumentExposureWeight.countryCode;
  await tx
    .delete(instrumentExposureWeight)
    .where(
      and(
        eq(instrumentExposureWeight.instrumentId, instrumentId),
        eq(instrumentExposureWeight.origin, "MANUAL"),
        isNotNull(column),
      ),
    );
  if (parts.length === 0) return;
  await tx.insert(instrumentExposureWeight).values(
    parts.map((part) => {
      if (dimension === "country") {
        return { instrumentId, countryCode: part.code, weight: part.weight };
      }
      // The validator has already refused any code outside `SECTOR_CODES`;
      // this narrows the type and fails loudly if that ever stops being true.
      if (!isSectorCode(part.code)) {
        throw new TypeError(`not a sector code: ${part.code}`);
      }
      return { instrumentId, sectorCode: part.code, weight: part.weight };
    }),
  );
}

/**
 * FR-747(c), EW-L18: an instrument created with a single sector, on a kind
 * that can carry sector weights, stores that sector as a 100 % weight — never
 * in `instrument.sector_code`, which a CHECK keeps NULL for such a kind. Called
 * by `createInstrumentByIsin` inside its creation transaction, right after the
 * insert, so the row lock is not needed (nobody else can see the row yet).
 */
export async function writeCreationSectorWeight(
  tx: Tx,
  instrumentId: string,
  sectorCode: SectorCode,
): Promise<void> {
  await writeDimension(tx, instrumentId, "sector", [
    { code: sectorCode, weight: parseDecimalString("100") },
  ]);
}

/**
 * Replaces the named dimensions of one shared instrument's `MANUAL` weights
 * and returns its stored sets afterwards (both dimensions).
 *
 * Order, and why: (1) every named set is validated **before any statement**,
 * sector before country — an invalid set on either dimension stores neither
 * ({@link ExposureWeightSetRefusedError}); (2) in one transaction, the
 * instrument row is locked (`owner_tenant_id IS NULL`; no row →
 * `InstrumentNotFoundError`, also when a concurrent delete won); (3) the kind
 * gate per named dimension ({@link ExposureWeightsNotApplicableError}),
 * checked for every named dimension before anything is written; (4) per named
 * dimension, delete then insert. A dimension not named is not touched.
 */
export async function replaceInstrumentExposureWeights(
  db: Db,
  instrumentId: string,
  params: ReplaceInstrumentExposureWeightsParams,
): Promise<InstrumentExposureWeights> {
  const named: { dimension: ExposureWeightDimension; parts: readonly ExposureWeightPart[] }[] = [];
  for (const dimension of EXPOSURE_WEIGHT_DIMENSIONS) {
    const items = dimension === "sector" ? params.sectorWeights : params.countryWeights;
    if (items === undefined) continue;
    const verdict = validateExposureWeightSet(dimension, items);
    if (!verdict.ok) {
      throw new ExposureWeightSetRefusedError(dimension, verdict.reason, verdict.index);
    }
    named.push({ dimension, parts: verdict.parts });
  }
  if (named.length === 0) {
    throw new TypeError("replaceInstrumentExposureWeights requires at least one dimension");
  }

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ kind: instrument.kind })
      .from(instrument)
      .where(and(eq(instrument.id, instrumentId), isNull(instrument.ownerTenantId)))
      .for("no key update");
    if (!locked) {
      throw new InstrumentNotFoundError(instrumentId);
    }
    for (const { dimension } of named) {
      if (!kindCarriesExposureWeights(locked.kind, dimension)) {
        throw new ExposureWeightsNotApplicableError(instrumentId, locked.kind, dimension);
      }
    }
    for (const { dimension, parts } of named) {
      await writeDimension(tx, instrumentId, dimension, parts);
    }
    return (await listInstrumentExposureWeights(tx, [instrumentId])).get(instrumentId) ?? {};
  });
}

/**
 * The stored `MANUAL` sets of each instrument in `instrumentIds`, keyed by id;
 * an instrument with no row is absent from the map. **One statement** for any
 * number of ids and **none** for an empty list. `PROVIDER` rows are invisible
 * this cycle.
 */
export async function listInstrumentExposureWeights(
  db: Db | Tx,
  instrumentIds: readonly string[],
): Promise<ReadonlyMap<string, InstrumentExposureWeights>> {
  if (instrumentIds.length === 0) return new Map();
  const rows = await db
    .select({
      instrumentId: instrumentExposureWeight.instrumentId,
      sectorCode: instrumentExposureWeight.sectorCode,
      countryCode: instrumentExposureWeight.countryCode,
      weight: instrumentExposureWeight.weight,
    })
    .from(instrumentExposureWeight)
    .where(
      and(
        inArray(instrumentExposureWeight.instrumentId, [...instrumentIds]),
        eq(instrumentExposureWeight.origin, "MANUAL"),
      ),
    );

  const collected = new Map<
    string,
    { sector: StoredExposureWeight[]; country: StoredExposureWeight[] }
  >();
  for (const row of rows) {
    let sets = collected.get(row.instrumentId);
    if (sets === undefined) {
      sets = { sector: [], country: [] };
      collected.set(row.instrumentId, sets);
    }
    if (row.sectorCode !== null) {
      sets.sector.push({ code: row.sectorCode, weight: row.weight });
    } else if (row.countryCode !== null) {
      sets.country.push({ code: row.countryCode, weight: row.weight });
    }
  }

  const result = new Map<string, InstrumentExposureWeights>();
  for (const [instrumentId, sets] of collected) {
    result.set(instrumentId, {
      ...(sets.sector.length > 0 && { sectorWeights: sets.sector.sort(byWeightThenCode) }),
      ...(sets.country.length > 0 && { countryWeights: sets.country.sort(byWeightThenCode) }),
    });
  }
  return result;
}
