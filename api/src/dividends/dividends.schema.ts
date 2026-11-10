import { z } from "zod";
import { isoDateSchema } from "@kerdial/api-contracts";
import type {
  DividendInstrumentSummary,
  DividendPeriodSummary,
  DividendSummary,
  DividendTotals,
} from "@kerdial/ledger";
import { serializeDecimal } from "../common/decimal.schema.js";

/**
 * Zod DTOs for `GET /dividends/summary` (DS-3,
 * FR-265/FR-271–
 * FR-273/FR-279/FR-284).
 *
 * Request schemas validate `unknown` input through `parseOrThrow`;
 * responses are typed by plain interfaces (their Zod schemas went with the
 * OpenAPI descriptors) — the controller builds its body from `ledger`'s
 * {@link DividendSummary} through {@link toDividendSummaryResponse}, never by
 * running it back through a Zod `.parse()`, exactly like
 * `cash-accounts.schema.ts`/`portfolios.schema.ts`.
 *
 * **Every decimal crosses as a string** (NFR-12/AC53):
 * `serializeDecimal` is `Decimal#toFixed()` with no scale padding, so a summed
 * `60.000000000000` is on the wire as `"60"` (A7). That is what the whole
 * cycle's fixture is written against, at every layer.
 */

/**
 * `?from=&to=&portfolio=`.
 *
 * The parameter is `portfolio`, matching `listTransactionsQuerySchema`'s own
 * spelling; `portfolioId` appears only in the *response*, as the echo of
 * the applied filter.
 *
 * **`resolveReturnWindow` (`portfolios.schema.ts`) is deliberately not reused,
 * and that is load-bearing rather than stylistic.** It defaults an absent
 * window to a trailing range and rejects a `from` older than
 * `to − RETURN_WINDOW_MAX_SPAN_YEARS` (15) with `DATE_RANGE_TOO_WIDE`. FR-271
 * requires the unselected default to be the tenant's **entire** history, and
 * AC-286 asserts it against a dividend more than five years old — reusing that
 * helper is precisely the failure AC-286 is written to catch. Here both absent
 * means no date predicate at all, and `to` is never defaulted to today: the
 * response echoes exactly what was asked and the client labels the two nulls.
 */
export const dividendSummaryQuerySchema = z
  .object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    portfolio: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    // Both are `YYYY-MM-DD` and zero-padded by `isoDateSchema`, so lexical
    // order *is* chronological order — no `Date` parsing, and therefore no
    // timezone, enters this comparison.
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "`to` must not be earlier than `from`",
      });
    }
  });

export type DividendSummaryQuery = z.infer<typeof dividendSummaryQuerySchema>;

/** One instrument's dividend history within the requested scope (FR-269). */
export interface DividendInstrumentResponse {
  readonly instrumentId: string;
  /** Embedded rather than resolved client-side — `HoldingResponse.displayName`'s precedent (OD-9/UR-8), and the only workable source: a fully-sold instrument still has dividend history and no holdings row at all. */
  readonly displayName: string;
  /** The local ticker for the payer tile's monogram, `null` when the instrument has none. Same statement as `displayName`. */
  readonly symbol: string | null;
  /** IK-10: `instrument_icon` presence for this tenant, `LEFT JOIN`ed in the same statement; the bytes are never read here. */
  readonly hasIcon: boolean;
  readonly grossBase: string;
  /** A positive magnitude — the sign flip happens once, in SQL. See {@link DividendPeriodResponse.withholdingBase}. */
  readonly withholdingBase: string;
  /** Distinct counted DIVIDEND transactions. Adding or removing a linked DRIP must move neither this nor `grossBase` (AC-282). */
  readonly paymentCount: number;
}

/** One `YYYY` or `YYYY-MM` bucket (FR-274–FR-277). A period with no counted dividend is **absent**, never a zero-valued entry. */
export interface DividendPeriodResponse {
  readonly period: string;
  readonly grossBase: string;
  /**
   * A **positive magnitude**, matching `IncomeTotals.withholdingEur`'s own
   * documented convention — which is what keeps this screen and Activity's
   * «Retenue à la source» tile directly comparable. The ledger stores the
   * withholding leg's `amount_base` negative; the sign is flipped once, in
   * SQL, so no client ever negates.
   */
  readonly withholdingBase: string;
}

/** LD-1 — the two figures stay independent: never netted, never implicitly decomposed. */
export interface DividendTotalsResponse {
  readonly grossBase: string;
  readonly withholdingBase: string;
}

/**
 * `GET /dividends/summary`, both halves of the screen from one snapshot
 * (DV4).
 *
 * **No `calcEpoch`** (DV10), and that is deliberate rather than forgotten:
 * `transaction_posting` is a write-time projection, not lazily materialised
 * state, so there is no window in which this answer can be behind a committed
 * write. `GET /transactions`, also a direct read of write-time state, carries
 * none for the same reason. See `summarizeDividends`'s own doc comment.
 */
export interface DividendSummaryResponse {
  /** FR-284/LD-4 — the tenant's ledger base (AR-5), the unit of every figure here. Correct for a tenant with zero dividends too. */
  readonly baseCurrency: string;
  /** Echoed exactly as asked; `null` = unbounded (FR-271's all-time default). */
  readonly from: string | null;
  readonly to: string | null;
  /** Echoed applied filter; `null` = every portfolio this tenant owns (LD-5). */
  readonly portfolioId: string | null;
  readonly total: DividendTotalsResponse;
  /** `grossBase` descending, ties broken by `instrumentId` — so the client's first render is not a re-sort. */
  readonly instruments: readonly DividendInstrumentResponse[];
  /** `period` ascending. */
  readonly years: readonly DividendPeriodResponse[];
  readonly months: readonly DividendPeriodResponse[];
}

function toTotalsResponse(totals: DividendTotals): DividendTotalsResponse {
  return {
    grossBase: serializeDecimal(totals.grossBase),
    withholdingBase: serializeDecimal(totals.withholdingBase),
  };
}

function toPeriodResponse(row: DividendPeriodSummary): DividendPeriodResponse {
  return { period: row.period, ...toTotalsResponse(row) };
}

function toInstrumentResponse(row: DividendInstrumentSummary): DividendInstrumentResponse {
  return {
    instrumentId: row.instrumentId,
    displayName: row.displayName,
    symbol: row.symbol,
    hasIcon: row.hasIcon,
    ...toTotalsResponse(row),
    paymentCount: row.paymentCount,
  };
}

/**
 * `ledger`'s `Decimal`-bearing aggregate rendered on the wire — the one place
 * this route's figures become strings. Ordering is the service's own and is
 * never re-sorted here: `total` is the exact sum of the rows shown (FR-270),
 * and re-ordering or re-folding it in the mapper is how those two would come
 * to disagree.
 */
export function toDividendSummaryResponse(summary: DividendSummary): DividendSummaryResponse {
  return {
    baseCurrency: summary.baseCurrency,
    from: summary.from,
    to: summary.to,
    portfolioId: summary.portfolioId,
    total: toTotalsResponse(summary.total),
    instruments: summary.instruments.map(toInstrumentResponse),
    years: summary.years.map(toPeriodResponse),
    months: summary.months.map(toPeriodResponse),
  };
}
