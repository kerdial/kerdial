import { and, eq, inArray, sql } from "drizzle-orm";
import { fxRateUser, withTenant, type Db } from "@kerdial/platform-db";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import { Decimal } from "@kerdial/core-decimal";

/**
 * `ledger`'s user-supplied FX rate write service — `portfolio-export-import`, EI-18.
 *
 * **This module closes a measured gap, and the gap is the reason it exists.**
 * MEASURED, 2026-09-24: `fx_rate_user` is **read** by `fx-rate-resolver.ts`
 * (the local-first fallback when `fx_rate_daily` has no coverage for a pair)
 * and by `valuation/src/pricing-series.ts`, and until this file it was
 * **written only by tests** — four integration suites insert into it directly
 * as the superuser. The table has been in the schema, under RLS, reachable by
 * the resolver, and unreachable by any product path, since T-18.
 *
 * So the exported `fxRatesUser[]` section of a catalogue export is empty for
 * every tenant that exists today, and this function is the first and (for now)
 * only writer: `applyCatalogue` (EI-20) calls it when a restored catalogue
 * carries user FX rates. **No HTTP route is added** — the catalogue import
 * being the only writer is exactly what makes this
 * the minimum change, and a route would be a second contract to keep.
 *
 * **No migration, and no `OWNER TO` reassignment.** `fx_rate_user` already
 * exists, is already one of `TENANT_SCOPED_TABLES`' 15 entries, and already has
 * RLS `ENABLE`d and `FORCE`d by `0007`/`0008`. This project's recorded "a new
 * table needs an `ALTER … OWNER TO app_owner`" lesson does **not** apply here,
 * and that is stated rather than left to be re-derived: no table is created by
 * this cycle. The obligation that *does* apply (F-D) is to **confirm** the
 * coverage rather than cite the schema — `roles-and-rls.integration.test.ts`
 * and `rls-cross-tenant-isolation.integration.test.ts` are run unchanged, and
 * this module's own integration test connects as the real `app_web` role rather
 * than as the container superuser so the `INSERT` grant is proven on the wire.
 *
 * **What this function deliberately does not do: fan out.** A user FX rate is
 * an input to `valuation`'s pricing series, so a *product* feature that let a
 * user edit one would owe an invalidation exactly as `upsertManualPricePoint`
 * owes `invalidateForInstrumentPrice`. The catalogue import is not that
 * feature: no catalogue write moves a figure and
 * the apply path runs no recompute, and FR-557's refetch is what repopulates
 * provider data after a restore. If a user-facing FX-rate editor is ever added,
 * the invalidation is added **with it**, in that cycle, against that cycle's
 * own evidence — this comment exists so that decision is visible instead of
 * being read off this function's silence. (Filed upward by EI-18 rather than
 * decided here.)
 */

/** Mirrors `fx_rate_user`'s row shape exactly — see `platform/db/src/schema/fx-rate-user.ts`. */
export type FxRateUserRecord = typeof fxRateUser.$inferSelect;

/**
 * `fx_rate_user.rate` is `numeric(28, 12)` (MEASURED,
 * `platform/db/src/schema/fx-rate-user.ts:29`), so Postgres silently rounds
 * anything finer to 12 fractional digits. Refused here rather than stored
 * rounded, for the reason `manual-price-service.ts`'s NEW-5 records for its own
 * column: this service's stated caller is not an HTTP route with a Zod schema
 * in front of it, so the scale check has to live where the write does.
 */
const FX_RATE_USER_MAX_DECIMAL_PLACES = 12;

/** Surfaced by {@link upsertUserFxRate} when `rate` carries more fractional digits than `fx_rate_user.rate` can store without silent rounding. */
export class FxRateUserScaleExceededError extends Error {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rateDate: IsoDate;
  readonly maxDecimalPlaces: number;

  constructor(
    baseCurrency: string,
    quoteCurrency: string,
    rateDate: IsoDate,
    maxDecimalPlaces: number,
  ) {
    super(
      `upsertUserFxRate: the rate for ${baseCurrency}/${quoteCurrency} on ${rateDate} has more than ` +
        `${maxDecimalPlaces} fractional digits — the fx_rate_user.rate column would silently round it.`,
    );
    this.name = "FxRateUserScaleExceededError";
    this.baseCurrency = baseCurrency;
    this.quoteCurrency = quoteCurrency;
    this.rateDate = rateDate;
    this.maxDecimalPlaces = maxDecimalPlaces;
  }
}

export interface UpsertUserFxRateParams {
  readonly tenantId: string;
  /** ISO 4217, uppercase — the currency the rate is quoted **from**. */
  readonly baseCurrency: CurrencyCode;
  /** ISO 4217, uppercase — the currency the rate is quoted **into**. */
  readonly quoteCurrency: CurrencyCode;
  /** `YYYY-MM-DD`. */
  readonly rateDate: IsoDate;
  readonly rate: Decimal;
  /** Defaults to `'user'` (the column's own default, FR-24/FR-58) — overridable for the same reason `upsertManualPricePoint`'s `sourceKey` is, and for no other. */
  readonly sourceKey?: string;
}

/**
 * Creates or revises this tenant's own FX rate for
 * `(baseCurrency, quoteCurrency, rateDate)` — the table's own primary key, so
 * re-supplying a rate for a pair and date already recorded corrects it in place
 * (`ON CONFLICT … DO UPDATE`) rather than erroring or duplicating. That is the
 * same upsert convention `fx_rate_daily`, `instrument_price_daily` and
 * `manual_price_point` all follow, and it is what makes a catalogue re-import
 * idempotent by construction (FR-537) without a fingerprint of its own.
 *
 * Every statement runs inside `withTenant` — the only sanctioned way to obtain
 * a handle with `app.tenant_id` set — so RLS, not the explicit `tenant_id` in
 * the `values` clause, is what makes a cross-tenant write impossible (AC33); the belt-and-braces predicate is the convention
 * `portfolio-service.ts` documents).
 *
 * @throws {TypeError} when `rate` is not greater than zero (a zero or negative
 * FX rate is not a rate), or when the two currencies are the same (a pair
 * quotes one currency against **another** — a self-quote is always `1` and
 * storing one would give the resolver a row it must never prefer).
 * @throws {FxRateUserScaleExceededError} when `rate` is finer than the column.
 */
export async function upsertUserFxRate(
  db: Db,
  params: UpsertUserFxRateParams,
): Promise<FxRateUserRecord> {
  if (!params.rate.greaterThan(0)) {
    throw new TypeError(
      `upsertUserFxRate: refusing to persist a non-positive rate (${params.rate.toString()}) for ` +
        `${params.baseCurrency}/${params.quoteCurrency} on ${params.rateDate}.`,
    );
  }
  if (params.baseCurrency === params.quoteCurrency) {
    throw new TypeError(
      `upsertUserFxRate: refusing to persist a self-quote for ${params.baseCurrency} on ${params.rateDate}.`,
    );
  }
  if (params.rate.decimalPlaces() > FX_RATE_USER_MAX_DECIMAL_PLACES) {
    throw new FxRateUserScaleExceededError(
      params.baseCurrency,
      params.quoteCurrency,
      params.rateDate,
      FX_RATE_USER_MAX_DECIMAL_PLACES,
    );
  }

  const sourceKey = params.sourceKey ?? "user";

  return withTenant(db, params.tenantId, async (tx) => {
    const [row] = await tx
      .insert(fxRateUser)
      .values({
        tenantId: params.tenantId,
        baseCurrency: params.baseCurrency,
        quoteCurrency: params.quoteCurrency,
        rateDate: params.rateDate,
        rate: params.rate,
        sourceKey,
      })
      .onConflictDoUpdate({
        target: [
          fxRateUser.tenantId,
          fxRateUser.baseCurrency,
          fxRateUser.quoteCurrency,
          fxRateUser.rateDate,
        ],
        set: { rate: sql`excluded.rate`, sourceKey: sql`excluded.source_key` },
      })
      .returning();
    return row!;
  });
}

export interface ListUserFxRatesParams {
  readonly tenantId: string;
  /** The base currencies to restrict to. **Empty ⇒ no rows and no query** — the same "an `IN ()` can only return nothing" rule `findInstrumentsByIdentity` states. */
  readonly baseCurrencies: readonly CurrencyCode[];
  /** The quote currencies to restrict to. Empty ⇒ no rows and no query. */
  readonly quoteCurrencies: readonly CurrencyCode[];
}

/**
 * This tenant's own rates over the currencies a caller names — the batched read
 * {@link upsertUserFxRate}'s caller needs before it writes, and this module's
 * own test needs to read back what it wrote.
 *
 * Shaped exactly like `findInstrumentsByIdentity` and for the same reason: the
 * catalogue import must decide, for a whole document at once and **outside** any
 * write transaction, which of its entries would change anything. It returns a
 * **superset** of the rows asked about (every stored date for the named
 * currencies, and both currency lists are matched independently), and the caller
 * indexes the result by the full key in memory — a per-entry point read would be
 * one round trip per entry inside a request already sized against a handler
 * timeout, and a per-entry filter pushed into SQL would be a tuple `IN` this
 * codebase writes nowhere else.
 *
 * `fx-rate-resolver.ts`'s own read is deliberately **not** duplicated here: it
 * walks backwards for the newest rate on or before a date, which is a different
 * question from "is this exact row already stored".
 */
export async function listUserFxRates(
  db: Db,
  params: ListUserFxRatesParams,
): Promise<FxRateUserRecord[]> {
  const bases = [...new Set(params.baseCurrencies)];
  const quotes = [...new Set(params.quoteCurrencies)];
  if (bases.length === 0 || quotes.length === 0) return [];

  return withTenant(db, params.tenantId, async (tx) =>
    tx
      .select()
      .from(fxRateUser)
      .where(
        and(
          eq(fxRateUser.tenantId, params.tenantId),
          inArray(fxRateUser.baseCurrency, bases),
          inArray(fxRateUser.quoteCurrency, quotes),
        ),
      ),
  );
}
