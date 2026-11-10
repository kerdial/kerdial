import { sql } from "drizzle-orm";
import { withTenant, type Db } from "@kerdial/platform-db";
import { parseDecimalString, toDecimalString } from "@kerdial/core-decimal";

/**
 * What a portfolio-level read needs to say about the holding it could not
 * price: which instrument, where its price history begins, and
 * — when the ledger already holds the number — the acquisition price that
 * would close the gap as a manual point.
 *
 * Read-only and called only on the failure path
 * (`PortfoliosController#mapValuationError`), never during valuation: the
 * engine's fail-whole semantics are unchanged (owner decision D1). Nothing
 * here writes a price; the suggestion is offered to the user, who writes it
 * through `POST /instruments/:id/prices` after confirming (D2).
 *
 * One `withTenant` round trip: `manual_price_point` and `transaction` are
 * under `FORCE ROW LEVEL SECURITY` and return zero rows without
 * `app.tenant_id`; `instrument` and `instrument_price_daily` are shared
 * reference data. Every subquery is an index lookup on an `(instrument_id,
 * …date)` key.
 */
export interface PriceGapDescription {
  readonly symbol: string | null;
  readonly displayName: string;
  /** Earliest automated or manual (this tenant's) price date, `YYYY-MM-DD`; `null` when the instrument has none. */
  readonly firstPriceDate: string | null;
  /** `null` when there is no qualifying acquisition, or it is not in the listing currency (see below). */
  readonly suggestedPrice: {
    readonly date: string;
    readonly close: string;
    readonly currency: string;
  } | null;
}

export interface DescribePriceGapParams {
  readonly tenantId: string;
  readonly instrumentId: string;
  /** The date the read failed on — the acquisition must be on or before it for a manual point there to cover it. */
  readonly valuationDate: string;
}

/**
 * `undefined` when the instrument row does not exist (it always should — the
 * read just replayed a holding of it — but the caller then keeps the plain
 * payload rather than inventing a name).
 *
 * **The suggestion.** The earliest `BUY`/`DRIP` of this instrument in this
 * tenant dated on or before `valuationDate` — the two kinds that acquire
 * quantity *at a price* (`SHARE_DISTRIBUTION` acquires with `unit_price NULL`).
 * Offered only when its `txn_currency` equals the instrument's listing
 * currency: the manual-price route would accept another ISO code, but a EUR
 * point in a USD instrument's series is a mixed-currency history, so a trade
 * settled elsewhere is omitted rather than converted. `unit_price` is
 * `numeric(38, 18)`, strictly positive for these kinds, so it always fits the
 * route's own close refinements.
 */
export async function describePriceGap(
  db: Db,
  params: DescribePriceGapParams,
): Promise<PriceGapDescription | undefined> {
  return withTenant(db, params.tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      select
        i.symbol,
        i.display_name,
        least(
          (select min(price_date) from instrument_price_daily
            where instrument_id = i.id),
          (select min(price_date) from manual_price_point
            where instrument_id = i.id and tenant_id = ${params.tenantId}::uuid)
        )::text as first_price_date,
        acq.trade_date::text as acq_date,
        acq.unit_price::text as acq_unit_price,
        (acq.txn_currency = i.listing_currency) as acq_in_listing_currency,
        acq.txn_currency as acq_currency
      from instrument i
      left join lateral (
        select t.trade_date, t.unit_price, t.txn_currency
          from "transaction" t
         where t.tenant_id = ${params.tenantId}::uuid
           and t.instrument_id = i.id
           and t.kind in ('BUY', 'DRIP')
           and t.unit_price is not null
           and t.unit_price > 0
           and t.txn_currency is not null
           and t.trade_date <= ${params.valuationDate}::date
         order by t.trade_date asc, t.seq asc
         limit 1
      ) acq on true
      where i.id = ${params.instrumentId}::uuid
    `)) as unknown as readonly {
      readonly symbol: string | null;
      readonly display_name: string;
      readonly first_price_date: string | null;
      readonly acq_date: string | null;
      readonly acq_unit_price: string | null;
      readonly acq_in_listing_currency: boolean | null;
      readonly acq_currency: string | null;
    }[];

    const row = rows[0];
    if (!row) return undefined;

    const suggestedPrice =
      row.acq_date !== null &&
      row.acq_unit_price !== null &&
      row.acq_currency !== null &&
      row.acq_in_listing_currency === true
        ? {
            date: row.acq_date,
            close: toDecimalString(parseDecimalString(row.acq_unit_price)),
            currency: row.acq_currency,
          }
        : null;

    return {
      symbol: row.symbol,
      displayName: row.display_name,
      firstPriceDate: row.first_price_date,
      suggestedPrice,
    };
  });
}
