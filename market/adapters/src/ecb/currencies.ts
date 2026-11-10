import type { CurrencyCode, IsoDate, ProviderKey } from "@kerdial/market-ports";

/**
 * This adapter's own `provider_key` value (provider identity lives in
 * exactly three places, one of which is "the adapter implementations
 * themselves" — this constant *is* that identity for ECB).
 * `fx_rate_daily.source_key` stores exactly this string.
 */
export const ECB_PROVIDER_KEY: ProviderKey = "ecb";

/** ECB always publishes EUR-base. */
export const ECB_BASE_CURRENCY: CurrencyCode = "EUR";

/**
 * The 32 currencies ECB has published a euro reference rate for at some
 * point since 1999-01-04 ("32 currency pairs against the euro"). This is the *historical* membership, not "currently
 * live in today's daily XML feed": EU accession states drop out of this list
 * when they adopt the euro (e.g. HRK on Croatia's 2023 accession), and RUB
 * is suspended (see {@link EUR_RUB_SUSPENDED_FROM}) rather than removed — a
 * pair for a retired/suspended currency still resolves via
 * {@link import("./provider.js").EcbFxRateProvider.fetchDailyRates} for
 * dates predating the retirement/suspension, since the CSV backfill still
 * carries that history.
 */
export const ECB_PUBLISHED_CURRENCIES: readonly CurrencyCode[] = [
  "USD",
  "JPY",
  "BGN",
  "CZK",
  "DKK",
  "GBP",
  "HUF",
  "PLN",
  "RON",
  "SEK",
  "CHF",
  "ISK",
  "NOK",
  "HRK",
  "RUB",
  "TRY",
  "AUD",
  "BRL",
  "CAD",
  "CNY",
  "HKD",
  "IDR",
  "ILS",
  "INR",
  "KRW",
  "MXN",
  "MYR",
  "NZD",
  "PHP",
  "SGD",
  "THB",
  "ZAR",
];

/**
 * EUR/RUB has been suspended since this date. T-15 does not itself spell out
 * post-suspension behaviour beyond "a clear domain error, not a fabricated
 * or zero rate" (AC3), so this adapter treats
 * *any* request touching a date on or after this cutoff as unresolvable —
 * {@link import("./provider.js").EcbFxRateProvider} raises
 * {@link import("@kerdial/market-ports").SymbolNotFound}, never silently
 * carrying the last pre-suspension rate forward indefinitely (which
 * `core-domain`'s `locf()` would happily do if asked — this is a deliberate
 * refusal to ask it to, not an oversight). A request entirely *before* this
 * date still resolves normally from the CSV backfill.
 */
export const EUR_RUB_SUSPENDED_FROM: IsoDate = "2022-03-01";

/**
 * Currencies ECB no longer publishes, and the first date it did not.
 * HRK and BGN were replaced by the euro (last rows 2022-12-30 and 2025-12-31
 * on the statistics API); RUB is suspended. They stay in
 * {@link ECB_PUBLISHED_CURRENCIES}, so their history up to that date is still
 * served, but they are not **live**: today's `eurofxref-daily.xml` has no
 * row for them, and asking the daily job for one failed the whole job.
 */
export const ECB_RETIRED_FROM: Readonly<Partial<Record<CurrencyCode, IsoDate>>> = {
  HRK: "2023-01-01",
  RUB: EUR_RUB_SUSPENDED_FROM,
  BGN: "2026-01-01",
};

/**
 * The currencies ECB publishes today — {@link ECB_PUBLISHED_CURRENCIES} less
 * {@link ECB_RETIRED_FROM}. This is what `capabilities().publishedPairs`
 * advertises, because that list is what the daily job is asked to fetch and
 * what a pair may be tracked against (`fx-supported-pairs.ts`).
 */
export const ECB_LIVE_CURRENCIES: readonly CurrencyCode[] = ECB_PUBLISHED_CURRENCIES.filter(
  (currency) => ECB_RETIRED_FROM[currency] === undefined,
);

/**
 * The first date ECB published a euro reference rate. The history
 * request asks the statistics API for everything from here on, so a history
 * load covers the same range the old `eurofxref-hist.csv` file did.
 */
export const ECB_HISTORY_START: IsoDate = "1999-01-04";
