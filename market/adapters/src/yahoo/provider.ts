import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { DataGap, ProviderMalformedResponse } from "@kerdial/market-ports";
import type {
  InstrumentRef,
  IsoDate,
  PriceObservation,
  ProviderCapabilities,
  ProviderSymbol,
  ProviderSymbolMatch,
  QuoteObservation,
  QuoteProvider,
  QuoteQuality,
} from "@kerdial/market-ports";
import {
  DEFAULT_PRICE_HINT,
  YAHOO_ASSET_KINDS,
  YAHOO_BATCH_SIZE,
  YAHOO_DELAY_MINUTES,
  YAHOO_MAX_HISTORY_YEARS,
  YAHOO_MAX_RESOLVE_CANDIDATES,
  YAHOO_PROVIDER_KEY,
  YAHOO_CRYPTO_QUOTE_QUALITY,
  YAHOO_CRYPTO_QUOTE_TYPE,
  YAHOO_QUOTE_QUALITY,
  YAHOO_QUOTE_TYPES_BY_KIND,
} from "./constants.js";
import { HttpYahooSourceFetcher } from "./http-fetcher.js";
import type { YahooSourceFetcher } from "./http-fetcher.js";
import { parseChartResponse } from "./parse-chart.js";
import { parseSearchResponse } from "./parse-search.js";
import type { YahooSearchCandidate } from "./parse-search.js";

/**
 * `YahooQuoteProvider` — the Yahoo unofficial-endpoints adapter for
 * SHARE/ETF/INDEX (T-31). Implements
 * only {@link QuoteProvider} — `fetchCorporateActions` is intentionally not
 * implemented (`capabilities().supportsCorporateActions: false`; splits are
 * deferred, component C18).
 *
 * **Quote quality is always `DELAYED`, never `REALTIME`** — Yahoo's
 * unauthenticated data is ~15-20 minutes delayed and
 * this adapter never claims otherwise.
 *
 * **A single endpoint family serves both `fetchLatest` and
 * `fetchDailyHistory`.** `v8/finance/chart/{symbol}` is used for both,
 * distinguished only by the query parameters `http-fetcher.ts` builds
 * (`range=1d` for "latest", `period1`/`period2` for a history window) —
 * `v7/finance/quote`, which would let `fetchLatest` batch several symbols
 * per call, requires an authenticated cookie+crumb handshake this adapter
 * deliberately avoids (see `constants.ts`'s `YAHOO_BATCH_SIZE` doc comment
 * for the live-probe evidence). `capabilities().batchSize` is `1`,
 * honestly reflecting that constraint.
 *
 * **Float32 price noise, and the documented, heuristic mitigation
 * (NFR-12).** `v8/finance/chart`'s `indicators.quote[].close` (and
 * `open`/`high`/`low`) values are transmitted as float32-cast doubles, not
 * the clean decimal values `meta.regularMarketPrice` carries for the
 * identical instant — see `decimalFromChartPrice`'s doc comment for the
 * live-probe evidence and the accepted limitation. Unlike `ecb` (T-15),
 * which parses lossless plain-text decimal numerals off the wire, Yahoo's
 * transport is JSON: by the time this file's code sees a price, it is
 * already a JS `number`, and any precision the provider itself discarded
 * (whether from float32 casting or from JSON's own number encoding) cannot
 * be recovered — only mitigated. `parseDecimalString` (never `new
 * Decimal(someNumber)`) is used for every conversion, exactly as `ecb` uses
 * it, so no *additional* precision is lost at this adapter's own boundary.
 */
export class YahooQuoteProvider implements QuoteProvider {
  readonly #fetcher: YahooSourceFetcher;

  constructor(fetcher: YahooSourceFetcher = new HttpYahooSourceFetcher()) {
    this.#fetcher = fetcher;
  }

  capabilities(): ProviderCapabilities {
    return {
      key: YAHOO_PROVIDER_KEY,
      assetKinds: YAHOO_ASSET_KINDS,
      supportsLatestQuote: true,
      supportsDailyHistory: true,
      supportsCorporateActions: false,
      maxHistoryYears: YAHOO_MAX_HISTORY_YEARS,
      quoteQuality: YAHOO_QUOTE_QUALITY,
      delayMinutes: YAHOO_DELAY_MINUTES,
      batchSize: YAHOO_BATCH_SIZE,
    };
  }

  /**
   * Resolves `ref` via `v1/finance/search` — **both** the ISIN and the
   * instrument's own ticker when both are known — filtered to the
   * `quoteType`(s) `constants.ts`'s `YAHOO_QUOTE_TYPES_BY_KIND` maps
   * `ref.kind` to, ranked by {@link candidateRank}, then enriched with each
   * candidate's authoritative listing currency from `v8/finance/chart`'s
   * `meta.currency` (search results carry no currency field at all). A
   * candidate whose currency lookup itself fails (e.g. a search hit for a
   * symbol the chart endpoint does not recognise) is dropped rather than
   * failing the whole call — a best-effort match list, per `resolve()`'s port
   * contract, which does not require every candidate to be enrichable.
   *
   * **Why not the ISIN alone.** This used to be `ref.isin ?? ref.symbol`,
   * documented as "an ISIN is the more precise identifier when both are
   * known". It is the more precise *identifier* and
   * still the worse *query*: Yahoo's ISIN search is not a superset of its
   * ticker search. Measured against a live catalogue, a handful of
   * instruments were degraded by querying the ISIN only — some (a Xetra line
   * of a US share, `GOOGL`) because the ISIN search returns nothing at all
   * while the ticker is a valid Yahoo symbol, and others (a Frankfurt line of
   * a Stockholm share) because it returned only a synthetic `<ISIN>.SG`
   * Stuttgart line carrying a single day of history, which then backfilled "successfully" and reported
   * `COMPLETE`. Every instrument imported from a Portfolio Performance assets
   * file has an ISIN, so for the whole imported catalogue the ticker the
   * source file supplied was never tried.
   *
   * **N+1 cap, and why the ranking has to come first.**
   * Each candidate's currency enrichment is its own `v8/finance/chart` HTTP
   * call, so a broad search that returns many relevant candidates would
   * otherwise fan out into that many chart calls for a single interactive
   * `resolve()`. The candidate list is truncated to
   * `YAHOO_MAX_RESOLVE_CANDIDATES` **before** that fan-out, so at most that
   * many chart calls are ever issued — which is also why the ranking is
   * applied *before* the slice rather than left to the caller's selection: a
   * union of two searches can exceed the cap, and the Frankfurt-line case is
   * exactly the one where the instrument's own ticker would otherwise be the candidate
   * the cap discarded.
   *
   * **The one thing a ticker query may not do: introduce a different
   * security.** A bare ticker is a weak identifier and collides across
   * venues — `GOLD` is Amundi's EUR gold ETC in this catalogue and Barrick
   * Mining's USD NYSE line at Yahoo. An ISIN cannot make that mistake: every
   * line it returns belongs to the same issue, so a currency disagreement
   * there is a *listing* choice, which is the caller's to make (and
   * `resolveProviderSymbol` makes it, preferring the declared currency). A
   * ticker-only candidate whose enriched currency disagrees with the
   * instrument's declared `listingCurrency` is therefore dropped, and only
   * when `ref.isin` is present — i.e. only where it is an *extra* candidate
   * this change introduced. Wrong-currency prices on the wrong company are
   * strictly worse than no prices; wrong-currency prices on the right company
   * are the `NOV.DE`/DKK case, and stay the caller's decision.
   */
  async resolve(ref: InstrumentRef): Promise<ProviderSymbolMatch[]> {
    const candidates = await this.#searchCandidates(ref);
    const relevantQuoteTypes = YAHOO_QUOTE_TYPES_BY_KIND[ref.kind];
    const relevant =
      relevantQuoteTypes === undefined
        ? candidates
        : candidates.filter((sourced) => relevantQuoteTypes.includes(sourced.candidate.quoteType));
    // `Array#sort` is stable (spec-guaranteed since ES2019), so candidates of
    // equal rank keep the provider's own ordering — and the ISIN query's
    // results keep coming before the ticker query's, which is the order
    // `#searchCandidates` collected them in.
    const ranked = [...relevant].sort(
      (left, right) => candidateRank(left.candidate, ref) - candidateRank(right.candidate, ref),
    );
    const bounded = ranked.slice(0, YAHOO_MAX_RESOLVE_CANDIDATES);

    const settled = await Promise.allSettled(
      bounded.map(async (sourced) => ({
        sourced,
        match: await this.#enrichWithCurrency(sourced.candidate, ref),
      })),
    );
    return settled
      .filter(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<{
          sourced: SourcedCandidate;
          match: ProviderSymbolMatch;
        }> => outcome.status === "fulfilled",
      )
      .map((outcome) => outcome.value)
      .filter(({ sourced, match }) => isSameSecurityAsRef(sourced, match, ref))
      .map(({ match }) => match);
  }

  /**
   * The search half of {@link resolve}: up to two `v1/finance/search` calls
   * (ISIN first, then `ref.symbol`), unioned by symbol with the first
   * occurrence winning.
   *
   * **Sequential, and short-circuited.** The second query is skipped as soon
   * as the ISIN's own results already contain the instrument's own ticker —
   * searching Yahoo again for a symbol it has already handed back cannot
   * produce a better line for that same symbol — so a well-identified
   * instrument still costs exactly one search call, and only the cases the
   * live-catalogue measurement found degraded pay for a second. Sequential rather than
   * `Promise.all` for the reason `http-fetcher.ts` records about Yahoo's
   * edge: it rejects traffic that looks scripted, so two simultaneous
   * searches for one `resolve()` is the wrong trade for a little latency.
   *
   * **One query's failure does not lose the other's candidates**, parse
   * failures included: an ISIN search that 5xx's or answers with a malformed
   * body no longer takes the ticker search down with it. Only "every query
   * failed" propagates, and it propagates the *first* failure rather than
   * returning `[]` — `[]` is this port's "nothing found", a different fact
   * from "the provider could not be asked", and the difference is what
   * decides whether the caller should retry.
   */
  async #searchCandidates(ref: InstrumentRef): Promise<SourcedCandidate[]> {
    const isinQuery = ref.isin?.trim().toUpperCase();
    // A crypto's own line is `<SYMBOL>-<CCY>`, asked for first — a
    // bare `SOL` search returns `SOL-USD` and five equities but no `SOL-EUR`.
    const queries = [ref.isin, cryptoPairSymbol(ref), ref.symbol]
      .filter((query): query is string => query !== undefined && query.trim() !== "")
      .map((query) => query.trim());

    const bySymbol = new Map<string, SourcedCandidate>();
    let anySucceeded = false;
    let firstFailure: unknown;
    for (const [index, query] of queries.entries()) {
      // Deduped here rather than up front so the "already have the ticker"
      // short-circuit covers both cases in one place: an ISIN-shaped symbol
      // (or a ref whose two fields are the same string) and a ticker the ISIN
      // search already returned.
      if (index > 0 && hasOwnTicker(bySymbol, ref)) break;
      if (
        queries.slice(0, index).some((earlier) => earlier.toUpperCase() === query.toUpperCase())
      ) {
        continue;
      }
      try {
        const fromIsinQuery = query.toUpperCase() === isinQuery;
        for (const candidate of parseSearchResponse(await this.#fetcher.fetchSearch(query))) {
          const key = candidate.symbol.toUpperCase();
          // First occurrence wins, so a symbol both queries returned counts as
          // the ISIN's — which is what `isSameSecurityAsRef` reads.
          if (!bySymbol.has(key)) bySymbol.set(key, { candidate, fromIsinQuery });
        }
        anySucceeded = true;
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (!anySucceeded && firstFailure !== undefined) throw firstFailure;
    return [...bySymbol.values()];
  }

  async #enrichWithCurrency(
    candidate: YahooSearchCandidate,
    ref: InstrumentRef,
  ): Promise<ProviderSymbolMatch> {
    const chartRaw = await this.#fetcher.fetchChart(candidate.symbol, { kind: "latest" });
    const chart = parseChartResponse(chartRaw, candidate.symbol);
    // `exchangeMic` is genuinely omitted, not set to `undefined` — Yahoo
    // never supplies a MIC (only its own `exchange`/`exchDisp` codes), and
    // this repo's `exactOptionalPropertyTypes: true` treats an explicit
    // `undefined` differently from an absent optional property.
    // `providerExchangeCode` carries that same `exchange` code instead —
    // this is *not* a MIC (`ProviderSymbolMatch.providerExchangeCode`'s own
    // doc comment) and is never written to `exchangeMic`. `tickerSymbol` is
    // set only for a crypto pair: `BTC-EUR` is Yahoo's line, `BTC` is
    // the coin — the symbol a created instrument carries, so it matches the
    // CRYPTO rows already stored and their symbol-uniqueness index. For every
    // other line `candidate.symbol` already is the ticker.
    //
    // `providerSectorLabel`/`providerIndustryLabel` (DD21) forward the search
    // response's own `sector`/`industry` **verbatim** — no mapping, no
    // normalisation, no fallback. Turning a label into a Kerdial sector code
    // is `core/api-contracts`' `PROVIDER_SECTOR_TO_CODE`'s job, applied by
    // `market/composition` and `api`, precisely so this adapter never needs
    // to know the internal taxonomy (DD20). Both are omitted, not set to
    // `undefined`, for the `exactOptionalPropertyTypes` reason above.
    return {
      providerSymbol: candidate.symbol,
      displayName: displayNameOf(candidate),
      currency: chart.meta.currency,
      matchQuality: isOwnTicker(candidate.symbol, ref) ? "EXACT" : "PROBABLE",
      ...(candidate.quoteType === YAHOO_CRYPTO_QUOTE_TYPE
        ? { tickerSymbol: cryptoBaseSymbol(candidate.symbol) }
        : {}),
      ...(candidate.exchange !== undefined ? { providerExchangeCode: candidate.exchange } : {}),
      ...(candidate.sector !== undefined ? { providerSectorLabel: candidate.sector } : {}),
      ...(candidate.industry !== undefined ? { providerIndustryLabel: candidate.industry } : {}),
    };
  }

  async fetchLatest(symbols: ProviderSymbol[]): Promise<QuoteObservation[]> {
    return Promise.all(symbols.map((symbol) => this.#fetchLatestOne(symbol)));
  }

  async #fetchLatestOne(symbol: ProviderSymbol): Promise<QuoteObservation> {
    const raw = await this.#fetcher.fetchChart(symbol, { kind: "latest" });
    const chart = parseChartResponse(raw, symbol);
    return {
      price: decimalFromChartPrice(
        chart.meta.regularMarketPrice,
        chart.meta.priceHint,
        `${symbol}: meta.regularMarketPrice`,
      ),
      currency: chart.meta.currency,
      asOf: unixSecondsToIsoInstant(
        chart.meta.regularMarketTime,
        `${symbol}: meta.regularMarketTime`,
      ),
      quality: qualityOf(chart.meta.instrumentType),
      sourceKey: YAHOO_PROVIDER_KEY,
    };
  }

  /**
   * `[from, to]` is enforced here, not trusted from Yahoo's own
   * `period1`/`period2` filtering — `http-fetcher.ts`'s doc comment records
   * the live-probe evidence that Yahoo's own boundary is inexact. Rows with
   * a `null` close (an in-progress session) are skipped, and duplicate
   * dates are dropped defensively, before this port's date-ascending/
   * no-duplicate contract is asserted by construction
   * (the final sort is redundant given `parseChartResponse`'s series is
   * already timestamp-ascending, but costs nothing and removes the
   * dependency on that ordering holding forever).
   */
  async fetchDailyHistory(
    symbol: ProviderSymbol,
    from: IsoDate,
    to: IsoDate,
  ): Promise<PriceObservation[]> {
    const raw = await this.#fetcher.fetchChart(symbol, { kind: "history", from, to });
    const chart = parseChartResponse(raw, symbol, { from, to });

    const observations: PriceObservation[] = [];
    const seenDates = new Set<IsoDate>();
    for (const point of chart.points) {
      if (point.close === null) continue;
      const priceDate = unixSecondsToIsoDate(point.timestampSeconds, `${symbol}: timestamp`);
      if (priceDate < from || priceDate > to) continue;
      if (seenDates.has(priceDate)) continue;
      seenDates.add(priceDate);
      observations.push({
        priceDate,
        close: decimalFromChartPrice(
          point.close,
          chart.meta.priceHint,
          `${symbol}: close on ${priceDate}`,
        ),
        currency: chart.meta.currency,
        quality: qualityOf(chart.meta.instrumentType),
        sourceKey: YAHOO_PROVIDER_KEY,
      });
    }
    observations.sort((a, b) =>
      a.priceDate < b.priceDate ? -1 : a.priceDate > b.priceDate ? 1 : 0,
    );

    if (observations.length === 0) {
      throw new DataGap(YAHOO_PROVIDER_KEY, from, to);
    }
    return observations;
  }
}

/** One search hit plus the only thing `resolve()` needs to know about where it came from. */
interface SourcedCandidate {
  readonly candidate: YahooSearchCandidate;
  /** `true` when the ISIN query returned it — i.e. the provider itself vouches that this line is the same issue. */
  readonly fromIsinQuery: boolean;
}

/** Whether the candidates collected so far already contain `ref`'s own ticker — the one line a second search cannot improve on. */
function hasOwnTicker(
  bySymbol: ReadonlyMap<string, SourcedCandidate>,
  ref: InstrumentRef,
): boolean {
  const own = ownTicker(ref);
  return own !== undefined && bySymbol.has(own);
}

/**
 * The Yahoo line a CRYPTO ref names: `<SYMBOL>-<CCY>` (`BTC` declared
 * in EUR -> `BTC-EUR`). `undefined` for any other kind, for a ref with no
 * symbol, and for discovery's placeholder currency `XXX` (a search for a coin
 * not yet created has no currency to pair it with — the bare-symbol query
 * then serves it).
 */
function cryptoPairSymbol(ref: InstrumentRef): string | undefined {
  if (ref.kind !== "CRYPTO" || ref.symbol === undefined) return undefined;
  const symbol = ref.symbol.trim().toUpperCase();
  const currency = ref.listingCurrency.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol) || !/^[A-Z]{3}$/.test(currency) || currency === "XXX") {
    return undefined;
  }
  return `${symbol}-${currency}`;
}

/** The provider symbol that *is* this ref's own line: the crypto pair when there is one, the ref's ticker otherwise. Upper-cased. */
function ownTicker(ref: InstrumentRef): string | undefined {
  return cryptoPairSymbol(ref) ?? ref.symbol?.trim().toUpperCase();
}

function isOwnTicker(symbol: string, ref: InstrumentRef): boolean {
  const own = ownTicker(ref);
  return own !== undefined && symbol.toUpperCase() === own;
}

/** `BTC-EUR` -> `BTC`: everything before the last `-`, Yahoo's pair separator. A symbol with none is returned as is. */
function cryptoBaseSymbol(symbol: string): string {
  const separator = symbol.lastIndexOf("-");
  return separator > 0 ? symbol.slice(0, separator) : symbol;
}

/** See `YAHOO_CRYPTO_QUOTE_QUALITY`: a crypto pair is quoted live, every other line delayed. */
/**
 * The name a candidate is shown under. `shortname` first, as before
 * (an equity's `shortname` is "Apple Inc." and its `longname` the formal
 * "Apple Inc."), **unless** `shortname` is absent or is just the symbol
 * again: for a Morningstar-sourced fund line (`0P0001DKPM.F`, quoteType
 * `MUTUALFUND`) Yahoo's `shortname` *is* the symbol and the readable name
 * ("Indépendance AM Europe Small A (C)") lives only in `longname`. Compared
 * case-insensitively — a `shortname` is sometimes the symbol lower-cased.
 * Falls through to the symbol itself when neither name is usable.
 */
function displayNameOf(candidate: YahooSearchCandidate): string {
  const shortName = candidate.shortName;
  const shortNameIsSymbol =
    shortName === undefined || shortName.toUpperCase() === candidate.symbol.toUpperCase();
  if (!shortNameIsSymbol) return shortName;
  return candidate.longName ?? shortName ?? candidate.symbol;
}

function qualityOf(instrumentType: string | undefined): QuoteQuality {
  return instrumentType === YAHOO_CRYPTO_QUOTE_TYPE
    ? YAHOO_CRYPTO_QUOTE_QUALITY
    : YAHOO_QUOTE_QUALITY;
}

/**
 * The guard `resolve()`'s doc comment states: a candidate only the *ticker*
 * query produced, quoting in a currency the instrument does not declare, is
 * treated as a different security and dropped.
 *
 * Applies only when `ref.isin` is present, which is what keeps it narrow:
 *
 *   - the discovery lane never reaches it — `buildDiscoveryRef` sets `isin`
 *     *or* `symbol` and never both, so a free-text search has no ISIN query to
 *     be the extra candidate of (and its `listingCurrency` is a placeholder
 *     that would match nothing);
 *   - an ISIN-less instrument is unaffected: its ticker is the only identifier
 *     it has, and dropping its candidates would leave it with none.
 */
function isSameSecurityAsRef(
  sourced: SourcedCandidate,
  match: ProviderSymbolMatch,
  ref: InstrumentRef,
): boolean {
  if (sourced.fromIsinQuery || ref.isin === undefined) return true;
  return match.currency.toUpperCase() === ref.listingCurrency.toUpperCase();
}

/**
 * The three tiers `resolve()` orders its candidate union by, lower first.
 *
 * A `<ISIN>.<suffix>` provider symbol (`SE0000115446.SG`,
 * `FR0010425595.SG`) is deprioritised rather than rejected: it is a synthetic
 * Yahoo identifier, and in all three cases the live-catalogue measurement found it carried exactly
 * one price point — but it is still a mapping, and one thin mapping beats no
 * prices at all when it is the only candidate Yahoo offers. So it sorts last
 * and survives; the cap can only drop it in favour of a real ticker.
 *
 * Ranking is deliberately **not** currency-aware. Which candidate agrees with
 * the instrument's declared `listing_currency` is decided by
 * `market/composition`'s `resolveProviderSymbol`, which is the layer that
 * knows the stored row and already prefers a currency match over match
 * quality (the `NOV.DE`/DKK fix). Duplicating that here would mean two places
 * ranking on currency and no single place answering for it — and this
 * adapter's own candidates carry no currency until `#enrichWithCurrency`
 * runs, which happens *after* the cap.
 */
const CANDIDATE_RANK_OWN_TICKER = 0;
const CANDIDATE_RANK_REAL_SYMBOL = 1;
const CANDIDATE_RANK_ISIN_DERIVED = 2;

function candidateRank(candidate: YahooSearchCandidate, ref: InstrumentRef): number {
  const symbol = candidate.symbol.toUpperCase();
  if (isOwnTicker(symbol, ref)) {
    return CANDIDATE_RANK_OWN_TICKER;
  }
  if (ref.isin !== undefined && symbol.startsWith(ref.isin.trim().toUpperCase())) {
    return CANDIDATE_RANK_ISIN_DERIVED;
  }
  return CANDIDATE_RANK_REAL_SYMBOL;
}

/**
 * `regularMarketTime`/`timestamp` are unix epoch seconds; converting via
 * `new Date(...).toISOString()` and slicing the date portion for
 * `PriceObservation.priceDate` assumes the UTC calendar date matches the
 * exchange's local trading-session date — true for every exchange this
 * adapter targets in practice (Euronext Paris, NYSE/NASDAQ; both trade well
 * inside a single UTC day), but not a universal guarantee for an exchange
 * whose session straddles UTC midnight. **Flagged assumption**, not silently
 * relied upon: a future exchange whose local session crosses UTC midnight
 * would need this revisited.
 *
 * A `seconds` value outside `Date`'s representable range (±~8.64e12 seconds)
 * would otherwise make `new Date(...)` produce an Invalid Date and
 * `.toISOString()` throw a raw, unclassified `RangeError` — exactly the
 * "provider returned a garbage/unexpected shape" case this adapter's parse
 * layer exists to catch (found in a security review, T-31; `parseChartResponse`
 * only checked finiteness, not magnitude). Guarded here so it maps onto the
 * closed taxonomy like every other shape violation.
 */
const MAX_REPRESENTABLE_UNIX_SECONDS = 8_640_000_000_000; // Date's own ±100,000,000-day limit, in seconds.

function unixSecondsToIsoInstant(seconds: number, label: string): string {
  if (Math.abs(seconds) > MAX_REPRESENTABLE_UNIX_SECONDS) {
    throw new ProviderMalformedResponse(
      YAHOO_PROVIDER_KEY,
      `${label}: unix seconds value out of representable range: ${String(seconds)}`,
    );
  }
  return new Date(seconds * 1000).toISOString();
}

function unixSecondsToIsoDate(seconds: number, label: string): IsoDate {
  return unixSecondsToIsoInstant(seconds, label).slice(0, 10);
}

/**
 * Converts one `v8/finance/chart` raw JSON `number` into a lossless
 * `Decimal`, correcting for the float32 noise `indicators.quote[]` values
 * carry — confirmed by a live probe during development: the
 * same underlying price point that appears as a clean `321.705` in
 * `meta.regularMarketPrice` appears as `321.7049865722656` in
 * `indicators.quote[0].close` for the identical instant, and
 * `Math.fround(321.705)` reproduces that exact tail — i.e. Yahoo's own
 * backend stores/serves this series at IEEE-754 single-precision, and the
 * noise already exists in the provider's own response, before this
 * adapter's JSON parsing ever runs.
 *
 * The mitigation: round to `priceHint`'s decimal places (the same precision
 * the clean `meta` fields are quoted to) via `Number#toFixed` — a plain
 * `number` operation, not a `Decimal` one, so this is unaffected by (and
 * does not need an exception from) the `no-float-ops-on-decimal` lint rule
 * — then parse the resulting clean numeral string with `parseDecimalString`
 * (never `new Decimal(rawNumber)`, exactly as `ecb`'s `parseEcbRawRate`
 * does), so no further precision is lost at *this* adapter's boundary.
 * Float32 carries roughly 7 significant decimal digits, comfortably more
 * than `priceHint` (2, for every instrument observed) for equity/ETF/index
 * price magnitudes, so the nearest `priceHint`-place decimal is essentially
 * always the value Yahoo actually intended.
 *
 * **Known limitation, documented rather than silently accepted (NFR-12).**
 * This is a heuristic recovery of a value already lossy at the provider's
 * own backend, not a guarantee: a value sitting exactly on a
 * `priceHint`-precision rounding boundary, or an instrument whose true tick
 * size is finer than `priceHint`, could recover the wrong neighbouring
 * value. There is no way to recover the exact originally-quoted figure once
 * Yahoo's own backend has cast it through a 32-bit float — unlike `ecb`
 * (T-15), whose CSV/XML text is a lossless decimal numeral on the wire.
 * Accepted here because this adapter is explicitly framed as
 * personal-use/delayed data, not a research-grade price source.
 */
/** Mirrors `core/decimal`'s own `PLAIN_DECIMAL_PATTERN` — checked here so an out-of-range magnitude is a classified {@link ProviderMalformedResponse}, not a raw `RangeError` bubbling up from `parseDecimalString`. */
const PLAIN_DECIMAL_NUMERAL = /^-?\d+(\.\d+)?$/;

function decimalFromChartPrice(raw: number, priceHint: number, label: string): Decimal {
  if (!Number.isFinite(raw)) {
    throw new ProviderMalformedResponse(
      YAHOO_PROVIDER_KEY,
      `${label}: non-finite price value ${String(raw)}`,
    );
  }
  // A zero or negative price is not a finiteness/magnitude problem the
  // checks below would catch — it is a distinct "this cannot be a real
  // price" case. Yahoo returns `regularMarketPrice: 0` for halted/delisted/
  // pre-IPO tickers; left unguarded, that zero would sail through as a
  // "successful" fetch and overwrite the last-good `instrument_quote_latest`
  // row with a fabricated zero that also looks "fresh" (never trips the
  // NFR-1 staleness flag) — exactly the class of silent mispricing
  // `ecb`'s `parseEcbRawRate` (T-18) already guards against; this mirrors it, using the same
  // `ProviderMalformedResponse` taxonomy member, not a raw `RangeError`/`Error`.
  if (raw <= 0) {
    throw new ProviderMalformedResponse(
      YAHOO_PROVIDER_KEY,
      `${label}: non-positive price value ${String(raw)}`,
    );
  }
  const dp =
    Number.isInteger(priceHint) && priceHint >= 0 && priceHint <= 8
      ? priceHint
      : DEFAULT_PRICE_HINT;
  // `toFixed` switches to exponential notation for magnitudes >= 1e21 (and
  // for very small magnitudes with a large `dp`, though priceHint's 0-8
  // range rules that branch out here) — a price that extreme is itself the
  // "provider returned a garbage/unexpected shape" case, not a value worth
  // parsing.
  const numeral = raw.toFixed(dp);
  if (!PLAIN_DECIMAL_NUMERAL.test(numeral)) {
    throw new ProviderMalformedResponse(
      YAHOO_PROVIDER_KEY,
      `${label}: price value out of representable range: ${String(raw)}`,
    );
  }
  return parseDecimalString(numeral);
}
