import { and, eq, sql } from "drizzle-orm";
import {
  holdingState,
  instrument,
  instrumentPriceDaily,
  instrumentQuoteLatest,
  withTenant,
  type Db,
  type TenantId,
} from "@kerdial/platform-db";
import type { InstrumentKind } from "./instrument-service.js";

/**
 * SH-18 (`self-hosted-deploy`, FR-50/FR-51) — the
 * **tenant-scoped** enumeration behind `POST /api/v1/market-data/quote-refresh`.
 *
 * **Why this function exists at all, rather than the endpoint calling
 * `market/ingestion`'s `fetchHeldInstruments`.** That function is deliberately
 * cross-tenant: `holding_state`'s `holding_state_ingest_read` policy grants
 * `app_ingest` an unconditional (`USING (true)`) read, because a held
 * instrument is polled once no matter how many tenants hold it. Calling it from
 * a per-tenant request path would enqueue **every tenant's** holdings for the
 * one tenant who pressed refresh — a cross-tenant leak in the shape of a
 * feature, and the negative requirement FR-51 is written as. This function is
 * the opposite by construction: the API's own `app_web` pool inside
 * {@link withTenant}, so RLS is what bounds the result, plus an explicit
 * `tenant_id` predicate belt-and-braces (the convention every other
 * tenant-owned read in this package follows).
 *
 * `quantity > 0` is the same "live holding" criterion the scheduled fan-out
 * uses — a fully-sold position costs a provider call for nothing. It is
 * expressed as raw SQL against the `decimalCol` column so Postgres does the
 * numeric comparison and no `Decimal` is read out at all (nothing for
 * `no-float-ops-on-decimal` to flag).
 *
 * The join to `instrument` is not decoration: `holding_state` alone could name
 * an instrument row that no longer exists, and enqueueing a refresh for it
 * would produce a job whose body can only fail. It also keeps this read's
 * shape identical to the fan-out's.
 */

/** One distinct instrument the calling tenant currently holds. */
export interface TenantHeldInstrument {
  readonly instrumentId: string;
  /** Carried through for logging, for a caller that wants to report what it enqueued, and for the on-demand refresh's routed-kind filter (`scpi`); the enqueue itself keys on the id alone. */
  readonly kind: InstrumentKind;
}

/**
 * Every distinct instrument this tenant holds with a positive quantity, across
 * all of its portfolios, ordered by instrument id so a caller's enqueue order
 * (and therefore its logs and its tests) is deterministic.
 *
 * Returns `[]` for a tenant with no live holdings — the caller's own decision
 * what to do with that (the endpoint still answers `202`: "nothing to refresh"
 * is a successful refresh request, not an error).
 */
export async function listTenantHeldInstruments(
  db: Db,
  tenantId: TenantId,
): Promise<TenantHeldInstrument[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .selectDistinct({
        instrumentId: holdingState.instrumentId,
        kind: instrument.kind,
      })
      .from(holdingState)
      .innerJoin(instrument, eq(instrument.id, holdingState.instrumentId))
      .where(and(eq(holdingState.tenantId, tenantId), sql`${holdingState.quantity} > 0`))
      .orderBy(holdingState.instrumentId);
    return rows.map((row) => ({ instrumentId: row.instrumentId, kind: row.kind }));
  });
}

/**
 * The **tenant-scoped** counterpart of
 * `market/ingestion`'s `fetchHeldCurrencies`, for the same reason
 * {@link listTenantHeldInstruments} exists rather than the endpoint calling
 * `fetchHeldInstruments`: that function reads `holding_state` under
 * `app_ingest`'s unconditional `USING (true)` policy, so serving it from a
 * per-tenant request would tell one tenant which currencies *another* tenant
 * holds. Here RLS bounds the result (`withTenant`), plus the explicit
 * `tenant_id` predicate every tenant-owned read in this package carries.
 *
 * **All three currency sources, exactly as the worker's version reads them**
 * (`holding-fanout.ts`'s own comment records why): the instrument's *declared*
 * `listing_currency`, the currency its stored daily prices are actually in, and
 * the currency its latest quote is in. Valuation converts from the *price
 * row's* currency, so a screen that showed only the declared one would report
 * a pair as unmanaged while valuation was demanding it — the exact defect that
 * left `NOV.DE`'s DKK prices unvaluable against a EUR instrument.
 *
 * Upper-cased and de-duplicated, sorted, so the caller can compare against a
 * provider's published list without normalising again.
 */
export async function listTenantHeldCurrencies(db: Db, tenantId: TenantId): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) => {
    const livePosition = and(
      eq(holdingState.tenantId, tenantId),
      sql`${holdingState.quantity} > 0`,
    );

    const declared = await tx
      .selectDistinct({ currency: instrument.listingCurrency })
      .from(holdingState)
      .innerJoin(instrument, eq(instrument.id, holdingState.instrumentId))
      .where(livePosition);

    const priced = await tx
      .selectDistinct({ currency: instrumentPriceDaily.currency })
      .from(holdingState)
      .innerJoin(
        instrumentPriceDaily,
        eq(instrumentPriceDaily.instrumentId, holdingState.instrumentId),
      )
      .where(livePosition);

    const quoted = await tx
      .selectDistinct({ currency: instrumentQuoteLatest.currency })
      .from(holdingState)
      .innerJoin(
        instrumentQuoteLatest,
        eq(instrumentQuoteLatest.instrumentId, holdingState.instrumentId),
      )
      .where(livePosition);

    return [
      ...new Set([...declared, ...priced, ...quoted].map((row) => row.currency.toUpperCase())),
    ].sort();
  });
}
