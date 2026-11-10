import { sql } from "drizzle-orm";
import { withTenant, type Db } from "@kerdial/platform-db";

/**
 * `GET /instruments/:id/history-status`'s *freshness* half.
 *
 * **Why this exists.** That endpoint used to answer with
 * `instrument_backfill_state` alone, and the Instruments screen rendered its
 * `latest_backfilled_date` under the heading « Mise à jour ». That column is a
 * **backfill resume bookmark** — `instrument-backfill-job.ts` and
 * `gap-repair-job.ts` are its only writers, and both the quote-refresh writer
 * (`market/ingestion`'s `upsertPriceDailyFromQuotesViaDb`) and `runEodCloseJob`
 * deliberately leave it alone. So « Actualiser les cours » would fetch, write
 * today's price, move the screen's price cell — and leave the date beside it
 * days old, which reads as "the button did nothing" (measured: NOV priced
 * 2026-09-07 with a bookmark of 2026-09-01).
 *
 * The bookmark is **not** the thing to move. Backfill resumes from
 * `latest_backfilled_date + 1`, so bumping it from a quote would make the
 * backfill skip days it never fetched. Freshness is a *read-side* question,
 * and this is the read.
 *
 * **Two values, because they answer two different questions.**
 *
 *  - `lastQuoteAt` — `instrument_quote_latest.as_of`, the provider's own
 *    observation instant for the last quote fetched. Intraday precision, which
 *    is what makes a refresh visible: two presses ten minutes apart move this
 *    even when the price and its calendar day do not. This is the same row
 *    `market/ingestion`'s `staleness.ts` reads for NFR-1/NFR-2, so the screen
 *    and the staleness sweep now agree on what "last quote" means by reading
 *    one table rather than two.
 *  - `latestPriceDate` — the newest *daily series* observation, across the
 *    automated series and this tenant's own manual points, which is the last
 *    point a chart can draw. A `MANUAL_ONLY` instrument has no quote row at
 *    all, so without the manual half its freshness would read `—` forever.
 *
 * Both nullable, and independently so: a catalogue instrument nobody has ever
 * fetched has neither, a manual-only instrument has only the second, and an
 * instrument whose quote landed while its daily row was refused (the
 * quote-writer's today-only rule, `quote-refresh-db.ts`) has a `lastQuoteAt`
 * ahead of its `latestPriceDate`. The screen renders what it is given and
 * never synthesises one from the other.
 *
 * **One statement**, two scalar subqueries and a `greatest` — this backs the
 * same cheap-read route as `getInstrumentBackfillStatus`, and that route's
 * whole point is that it stays a couple of indexed lookups rather than
 * the heavier coverage computation. It runs inside `withTenant`, which is not
 * optional and not a precaution: `manual_price_point` is under `FORCE ROW
 * LEVEL SECURITY` (migration `0007`, amended by `0008`), so its subquery
 * returns zero rows for `app_web` unless `app.tenant_id` is set — a
 * manual-only instrument would read « — » forever, which is the same class of
 * silent-wrong-answer this read guards against. `manual-price-service.ts`'s header owns
 * the full reasoning; the explicit `tenant_id` predicate below is that file's
 * same belt-and-suspenders, never the primary mechanism. Every lookup here is
 * an index scan:
 * `instrument_quote_latest`'s primary key, and the `(instrument_id,
 * price_date)` primary keys of `instrument_price_daily` and
 * `manual_price_point` (a backwards index scan for each `max`, never a scan of
 * the instrument's 20 years of rows).
 *
 * `greatest` ignores nulls in Postgres — it returns the non-null argument when
 * one side is missing, and null only when both are — which is exactly the
 * merge rule wanted here and the reason it is not written as a `coalesce`
 * chain.
 *
 * Formatted to text **in Postgres**, not by the driver: `::text` on the date
 * yields the `YYYY-MM-DD` this repo's `IsoDate` is, and the explicit
 * `to_char(… at time zone 'UTC', …)` yields a `Z`-suffixed ISO-8601 instant
 * that `z.iso.datetime()` accepts. A raw `db.execute` hands driver-parsed
 * values back (`postgres.js` turns both a `date` and a `timestamptz` into a
 * `Date`), so casting here is what keeps the two column *types* from becoming
 * one ambiguous JS type at the boundary — the mirror of the `::date`/`::text`
 * casts `instrument-backfill-job.ts`'s own raw upsert records.
 */
export interface InstrumentPriceFreshnessRecord {
  /** The last quote's own observation instant (`instrument_quote_latest.as_of`), ISO-8601 UTC — `null` when no quote was ever stored for this instrument. */
  readonly lastQuoteAt: string | null;
  /** The newest daily-series date across the automated series and this tenant's manual points — `null` when neither has a single point. */
  readonly latestPriceDate: string | null;
}

const NO_OBSERVATION: InstrumentPriceFreshnessRecord = {
  lastQuoteAt: null,
  latestPriceDate: null,
};

export interface GetInstrumentPriceFreshnessParams {
  readonly tenantId: string;
  readonly instrumentId: string;
}

/**
 * Reads fresh on every call, like `getInstrumentBackfillStatus` beside it, and
 * is total over every instrument id: an id that does not exist answers
 * {@link NO_OBSERVATION} rather than throwing (the controller's own
 * `getInstrumentById` pre-check is what turns that into a 404).
 *
 * Tenant-scoped on the manual half only, because that is the only half that is
 * per-tenant: `instrument_price_daily` and `instrument_quote_latest` carry no
 * `tenant_id` (the automated series is shared reference data, as
 * `listInstrumentPriceHistory` already treats it), while `manual_price_point`
 * is this tenant's own and another tenant's point must never widen this
 * answer.
 */
export async function getInstrumentPriceFreshness(
  db: Db,
  params: GetInstrumentPriceFreshnessParams,
): Promise<InstrumentPriceFreshnessRecord> {
  return withTenant(db, params.tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      select
        to_char(
          (select as_of from instrument_quote_latest
            where instrument_id = ${params.instrumentId}::uuid) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) as last_quote_at,
        greatest(
          (select max(price_date) from instrument_price_daily
            where instrument_id = ${params.instrumentId}::uuid),
          (select max(price_date) from manual_price_point
            where instrument_id = ${params.instrumentId}::uuid
              and tenant_id = ${params.tenantId}::uuid)
        )::text as latest_price_date
    `)) as unknown as readonly {
      readonly last_quote_at: string | null;
      readonly latest_price_date: string | null;
    }[];

    const row = rows[0];
    if (!row) return NO_OBSERVATION;

    return {
      lastQuoteAt: row.last_quote_at ?? null,
      latestPriceDate: row.latest_price_date ?? null,
    };
  });
}
