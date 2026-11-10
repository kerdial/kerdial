import { z } from "zod";

/**
 * The wire shapes of `/market-data/fx*`, the Devises screen's
 * four routes.
 *
 * ## Currency codes
 *
 * `z.string().length(3).regex(/^[A-Z]{3}$/)` and **no lower-case coercion**: a
 * code is either the ISO 4217 form the seeded `currency` table holds or it is
 * not one, and `.toUpperCase()`-ing a request into validity would let `eur`
 * and `EUR` be two spellings of the same tracked pair while the primary key
 * says they are one. The screen sends codes it read from this same API.
 *
 * ## Rates are decimal strings
 *
 * `latestRate` is a **string**, not a number ("every
 * decimal crosses the API boundary as a JSON string. Not a number, ever").
 * `zDecimal` is deliberately *not* reused here: that codec parses an incoming
 * string into a `Decimal`, and these are outbound — the controller serialises
 * with `Decimal#toString()` and this schema describes what is on the wire.
 *
 * ## Absence is absence
 *
 * Every coverage field is optional and simply missing for a pair with no
 * `fx_rate_daily` rows. There is no `latestRate: "0"` and no epoch date
 * standing in for "never fetched" — the screen renders an em dash from the
 * absence, and a fabricated zero here would be a rate the app would then be
 * willing to value with.
 */

const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, "must be a three-letter upper-case ISO 4217 code");

/** One row of the Devises table. Consumed through {@link FxPairResponse} (the controller's `fxOverview` row mapper) and by {@link fxOverviewResponseSchema}. */
export const fxPairResponseSchema = z.object({
  base: currencyCode,
  quote: currencyCode,
  /**
   * `true` when this tenant holds — declares, prices, or quotes — something in
   * `quote`, so the pair is fetched whether or not anyone tracked it. Read
   * tenant-scoped (`listTenantHeldCurrencies`), never from the worker's
   * cross-tenant fan-out.
   */
  held: z.boolean(),
  /** `true` when an `fx_tracked_pair` row exists. Deployment-wide, not per tenant — the table is shared reference data. */
  tracked: z.boolean(),
  /** `true` when the live FX provider publishes this pair. A tracked pair can become unsupported (EUR/RUB, suspended 2022) — the daily job then skips it and this flag is how the screen says so. */
  supported: z.boolean(),
  /** The most recent stored rate in `fx_rate_daily`'s canonical direction: `amount_base = amount_native × rate`. Absent when the pair has never been fetched. */
  latestRate: z.string().optional(),
  latestRateDate: z.string().optional(),
  /** `source_key` of that row — provenance per point (FR-24/FR-58), so the screen states its source instead of assuming one. */
  latestSourceKey: z.string().optional(),
  /** Oldest stored `rate_date` for the pair; with `points`, this is the honest depth of the series a valuation can draw on. */
  firstRateDate: z.string().optional(),
  points: z.number().int().nonnegative(),
});

export type FxPairResponse = z.infer<typeof fxPairResponseSchema>;

/** `GET /market-data/fx`. Consumed through {@link FxOverviewResponse}, `fxOverview`'s return type. */
export const fxOverviewResponseSchema = z.object({
  /** The FX provider's key (`ecb`) and the currency every published pair reports in. */
  provider: z.object({ key: z.string(), baseCurrency: currencyCode }),
  /**
   * `false` when this deployment has no ingestion queue connection
   * (`INGESTION_DATABASE_URL` unset). The screen disables its refresh button
   * from this rather than discovering the 503 by pressing it.
   */
  ingestionConfigured: z.boolean(),
  /** Held-or-tracked pairs, base-then-quote ascending. Empty is a real answer: nothing held, nothing tracked. */
  pairs: z.array(fxPairResponseSchema),
  /** Every pair the provider publishes — the "add a pair" picker's option list, so it can never offer one the server would reject. */
  supportedPairs: z.array(z.object({ base: currencyCode, quote: currencyCode })),
});

export type FxOverviewResponse = z.infer<typeof fxOverviewResponseSchema>;

/** `POST /market-data/fx/pairs` request body. */
export const trackFxPairRequestSchema = z
  .object({ base: currencyCode, quote: currencyCode })
  .refine((pair) => pair.base !== pair.quote, {
    message: "a pair's two legs must differ (a currency's rate against itself is 1)",
    path: ["quote"],
  });

export type TrackFxPairRequest = z.infer<typeof trackFxPairRequestSchema>;

/**
 * `POST /market-data/fx/pairs` response. `created: false` means the pair was
 * already tracked — reported rather than turned into a 409, because the
 * request's intent ("this pair should be tracked") is satisfied either way and
 * a screen that adds a pair twice should not have to treat the second attempt
 * as an error. The status code stays `201` for both; `created` is what
 * distinguishes them.
 *
 * Consumed through {@link TrackFxPairResponse}, `addFxPair`'s return type.
 */
export const trackFxPairResponseSchema = z.object({
  base: currencyCode,
  quote: currencyCode,
  created: z.boolean(),
});

export type TrackFxPairResponse = z.infer<typeof trackFxPairResponseSchema>;

/**
 * `POST /market-data/fx/refresh` — `202 Accepted`.
 *
 * `pairs` is what the run *will* cover, computed by the same
 * `resolveFxDailyPairs` the worker uses, so the number is not an estimate.
 * `enqueued` is `false` when pg-boss collapsed this send into a run already
 * queued or active on the `singleton` `fx-daily` queue — the honest outcome of
 * pressing the button twice, and deliberately not reported as a second run.
 *
 * Consumed through {@link FxRefreshAcceptedResponse}, `fxRefresh`'s return type.
 */
export const fxRefreshAcceptedResponseSchema = z.object({
  pairs: z.number().int().nonnegative(),
  enqueued: z.boolean(),
  /** pg-boss's job id, when this request created the job. Absent when it collapsed into an existing one. */
  jobId: z.string().optional(),
});

export type FxRefreshAcceptedResponse = z.infer<typeof fxRefreshAcceptedResponseSchema>;
