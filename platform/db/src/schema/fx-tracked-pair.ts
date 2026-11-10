import { sql } from "drizzle-orm";
import { char, check, pgTable, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { currency } from "./currency.js";

/**
 * `fx_tracked_pair` — the FX pairs the daily pull covers **in addition to**
 * the ones the holdings imply (the Devises screen's "add a pair").
 *
 * ## Why a table at all
 *
 * Until now the managed pair set existed nowhere: `fx-daily-handler.ts`
 * derived it per run as the provider's published pairs ∩ `fetchHeldCurrencies`
 * — the currencies some tenant's held instrument is declared, priced, or
 * quoted in. That is the right *default* (asking for every published pair
 * would drag in EUR/RUB, suspended since 2022, and fail the whole job for a
 * currency nobody owns), but it makes one thing impossible: watching a pair
 * *before* holding anything in it. A currency you are about to buy into has no
 * holding, therefore no rate, therefore no history — and `ensureFxHistoryCoverage`
 * only ever loads history for a pair already in the requested set.
 *
 * This table is that missing input, and nothing more. The union happens in the
 * handler; a row here does not price anything by itself.
 *
 * ## Shared reference data, not tenant data
 *
 * No `tenant_id`, no RLS, recorded in `schema/README.md`'s shared-reference
 * table in the same change that created it — for exactly the reason `fx_rate_daily` (the
 * table these rows cause writes to) is allowlisted: the rates a tracked pair
 * produces land in a global series every tenant's valuation reads, and the
 * ingestion worker that consumes this list runs cross-tenant with no session
 * context to filter on. A `tenant_id` here would be a column that no reader is
 * allowed to filter by and that no writer could honestly populate — the same
 * argument `ops_indicator` and `market_data_epoch` make.
 *
 * ## Shape
 *
 * `(base_currency, quote_currency)` is the natural key and the whole row: two
 * legs, both FK'd to the seeded ISO 4217 `currency` list, plus when it was
 * added. The rate direction follows `fx_rate_daily`'s convention verbatim:
 * for `(base, quote)`, `amount_base = amount_native × rate` — so
 * `base` is the currency you report *in* and `quote` is the currency you hold.
 *
 * **Which pairs are legal is not expressible here.** The provider's published
 * currency list decides that (the ECB adapter resolves any cross rate between
 * two published currencies via their EUR legs), it changes without a
 * migration, and a CHECK against a hardcoded 32-currency list would go stale
 * silently. The API validates the pair against the live
 * `FxProviderCapabilities` before the INSERT, and the handler skips a pair the
 * provider no longer supports rather than failing the run — see
 * `fx-daily-handler.ts`. The one thing that *is* a domain invariant and is
 * enforced here: a pair's two legs must differ (a self-pair's rate is 1 by
 * definition and no provider is needed to say so).
 */
export const fxTrackedPair = pgTable(
  "fx_tracked_pair",
  {
    baseCurrency: char("base_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    quoteCurrency: char("quote_currency", { length: 3 })
      .notNull()
      .references(() => currency.code),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.baseCurrency, table.quoteCurrency] }),
    check("fx_tracked_pair_legs_differ", sql`${table.baseCurrency} <> ${table.quoteCurrency}`),
  ],
);
