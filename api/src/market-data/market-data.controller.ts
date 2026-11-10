import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { serializeDecimal } from "@kerdial/api-contracts";
import {
  fetchTrackedFxPairs,
  fxProviderCapabilities,
  isFxPairSupported,
  listFxPairStatus,
  onDemandQuoteRefreshBucket,
  providerKeyForDiscovery,
  resolveFxDailyPairs,
  trackFxPair,
  untrackFxPair,
  type MarketRuntime,
} from "@kerdial/market-composition";
import { listTenantHeldCurrencies, listTenantHeldInstruments } from "@kerdial/ledger";
import type { CurrencyPair } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import type { SessionContext } from "@kerdial/platform-auth";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import { fxRefreshRateThrottleInterceptor } from "./fx-refresh-throttle.interceptor.js";
import { quoteRefreshRateThrottleInterceptor } from "./quote-refresh-throttle.interceptor.js";
import {
  trackFxPairRequestSchema,
  type FxOverviewResponse,
  type FxPairResponse,
  type FxRefreshAcceptedResponse,
  type TrackFxPairResponse,
} from "./fx.schema.js";
import type { QuoteRefreshAcceptedResponse } from "./market-data.schema.js";

/**
 * SH-18 (FR-50–FR-55,
 * AC-42–AC-47) — `/market-data/*`: the **on-demand quote-refresh trigger**.
 *
 * Why the endpoint exists: a deliberate decision dropped the continuous
 * quote-refresh cadence to twice daily (08:00/20:00 Europe/Paris) because
 * `instrument_quote_latest` feeds nothing user-visible but the staleness
 * indicator. That trade is only acceptable because *this* endpoint is the
 * remedy for a user who wants fresher data sooner — it is also why a missed
 * quote-refresh slot deliberately gets no catch-up on worker start (SH-17,
 * AC-19).
 *
 * Four properties, each of which a plausible-looking implementation gets wrong:
 *
 *  1. **Tenant-scoped enumeration** (FR-51). `listTenantHeldInstruments` reads
 *     the API's own `app_web` pool inside `withTenant`. The available
 *     alternative — `market/ingestion`'s `fetchHeldInstruments` — is
 *     deliberately cross-tenant (`USING (true)`) and would enqueue every
 *     tenant's holdings for whoever pressed refresh. See that function's own
 *     doc comment; AC-43 is the cross-tenant test.
 *  2. **A distinct bucket** (FR-53). `ondemand:<requestId>`, never the
 *     scheduled `sched:<date>:<08|20>`. The queue's policy is `exclusive` (one
 *     job per `quote:refresh:{instrumentId}:{bucket}` key queued *or* active),
 *     so reusing the scheduled bucket during a slot window would silently
 *     dedupe the request away: `202` returned, nothing run. One `requestId` per
 *     request keeps the bucket stable *within* a request (an instrument held in
 *     two portfolios enqueues once) and unique *across* them.
 *  3. **A bounded fan-out** (FR-52). A sequential `for` loop, never
 *     `Promise.all` over N instruments — pg-boss's pool is budgeted at 2
 *     (`connection-budget.ts`), and the parallel shape is a pool-exhaustion
 *     defect this codebase has already fixed once. Sends are cheap
 *     (`boss.send`, one INSERT); doing them in order costs latency proportional
 *     to holdings and nothing else.
 *  4. **No silent success when ingestion is off** (FR-54). `scheduler === null`
 *     (`INGESTION_DATABASE_URL` unset) ⇒ `503 MARKET_DATA_NOT_CONFIGURED`,
 *     never a `202` that enqueues nothing.
 *
 * The rate cap is SH-19's `quoteRefreshRateThrottleInterceptor` — a per-tenant
 * *rate* cap, deliberately not a concurrency cap (see its own file).
 *
 * Auth and CSRF come from the global `AuthGuard`/`CsrfGuard` (`app.module.ts`),
 * so there is no new auth surface here; the route sits under the existing
 * `api/v1` prefix, which is what makes the CSP and the `no-store` rule
 * cover it with no new case.
 *
 * ## `/market-data/fx*` — the Devises screen
 *
 * Four routes on the same controller, because they are the same subject
 * (market data this deployment fetches) reached through the same runtime: the
 * FX pair list and its coverage (`GET fx`), tracking (`POST fx/pairs`) and
 * untracking (`DELETE fx/pairs/{base}/{quote}`) a pair, and forcing the daily
 * pull now (`POST fx/refresh`).
 *
 * Properties 1 and 4 above carry over verbatim and are the two worth naming
 * again: the held-currency enumeration is **tenant-scoped**
 * (`listTenantHeldCurrencies`, not the worker's cross-tenant
 * `fetchHeldCurrencies`), and `scheduler === null` is a `503`, never a `202`
 * that enqueues nothing. Property 3 has no analogue — an FX refresh is a single
 * `send`, not a fan-out — and property 2's bucket has none either: the
 * `fx-daily` queue is `singleton` and payload-light, so a second press
 * deliberately collapses into the run already in flight and the response says
 * so (`enqueued: false`).
 */
@Controller("market-data")
export class MarketDataController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
  ) {}

  /**
   * `POST /market-data/quote-refresh` — enqueues one quote-refresh job per
   * distinct instrument the calling tenant holds **that has an automated quote
   * source** (every kind but `SCPI`, `scpi` cycle) and returns `202 Accepted`.
   *
   * **Nothing is fetched synchronously.** The response is written before any
   * job runs; the worker consumes the queue (the handler-ownership
   * invariant), which is what keeps this endpoint's latency proportional to the
   * tenant's holdings rather than to a provider's response time — and what
   * makes `202` the honest status code.
   */
  @UseInterceptors(quoteRefreshRateThrottleInterceptor)
  @HttpCode(202)
  @Post("quote-refresh")
  async quoteRefresh(
    @CurrentSession() session: SessionContext,
  ): Promise<QuoteRefreshAcceptedResponse> {
    const scheduler = this.marketRuntime?.scheduler ?? null;
    if (scheduler === null) {
      // FR-54/AC-45. A 202 here would be the worst outcome: the caller is told
      // the refresh was accepted, and nothing anywhere is queued to do it.
      throw problemException(503, {
        title: "Market data ingestion is not configured",
        code: "MARKET_DATA_NOT_CONFIGURED",
        detail:
          "this deployment has no ingestion queue connection (INGESTION_DATABASE_URL is unset), " +
          "so a quote refresh cannot be enqueued",
      });
    }

    // `scpi` (SC-L10): only held instruments with an automated
    // quote source. An unrouted kind (`SCPI`) is never enqueued, and is not
    // counted in `heldInstruments` either — the screen's « Actualisation
    // demandée pour N instruments » must not claim a refresh nothing performs.
    // For a tenant holding only routed kinds this filters nothing.
    const held = (await listTenantHeldInstruments(this.db, session.tenantId)).filter(
      (h) => providerKeyForDiscovery(h.kind) !== undefined,
    );
    const requestId = randomUUID();
    const bucket = onDemandQuoteRefreshBucket(requestId);

    let enqueued = 0;
    // FR-52: sequential, bounded by the tenant's own holdings — never
    // `Promise.all`, which against pg-boss's `max: 2` pool is the exact
    // exhaustion shape this repo already fixed once.
    for (const heldInstrument of held) {
      const jobId = await scheduler.enqueueQuoteRefresh({
        instrumentId: heldInstrument.instrumentId,
        bucket,
      });
      if (jobId !== null) enqueued += 1;
    }

    return { requestId, bucket, heldInstruments: held.length, enqueued };
  }

  /**
   * `GET /market-data/fx` — the Devises screen's only read.
   *
   * **The managed set is not re-derived here.** `resolveFxDailyPairs` is the
   * worker's own function, re-exported by `market/composition`: the screen
   * shows the pairs the next run will actually fetch, not a second guess at
   * them. A parallel implementation in `api` is exactly how a screen ends up
   * confidently listing a pair nothing fetches.
   *
   * **Held currencies are read tenant-scoped** (`listTenantHeldCurrencies`),
   * never through `market/ingestion`'s cross-tenant `fetchHeldCurrencies` —
   * the same FR-51 rule `quoteRefresh` above follows, for the same reason:
   * that function would tell this tenant which currencies other tenants hold.
   * Tracked pairs, by contrast, genuinely *are* deployment-wide — the table is
   * shared reference data with no `tenant_id` — and the response says so with
   * a `tracked` flag rather than pretending they are this tenant's.
   *
   * A tracked pair the provider no longer publishes is listed with
   * `supported: false` instead of being hidden: the daily job skips it, and a
   * pair silently absent from a screen whose job is to say what is fetched
   * would be the defect.
   */
  @Get("fx")
  async fxOverview(@CurrentSession() session: SessionContext): Promise<FxOverviewResponse> {
    const capabilities = fxProviderCapabilities();
    const heldCurrencies = await listTenantHeldCurrencies(this.db, session.tenantId);
    const trackedPairs = await fetchTrackedFxPairs(this.db);

    // Two resolutions of the same function, which is what makes `held` and
    // `tracked` separable without either flag being re-derived from a rule
    // this file restates: the held-only run is "what would be fetched if
    // nobody had tracked anything".
    const heldPairs = resolveFxDailyPairs({ capabilities, heldCurrencies, trackedPairs: [] });
    const managed = resolveFxDailyPairs({ capabilities, heldCurrencies, trackedPairs });

    const supportedKeys = new Set(capabilities.publishedPairs.map(pairKey));
    const heldKeys = new Set(heldPairs.map(pairKey));
    const trackedKeys = new Set(trackedPairs.map(pairKey));

    // Managed ∪ tracked — the union matters only for a tracked pair the
    // provider has dropped, which is in `trackedPairs` and not in `managed`.
    // Ordered base-then-quote server-side, so both viewports render the same
    // order without a client sort that could differ between them.
    const rowsByKey = new Map<string, CurrencyPair>();
    for (const pair of [...managed, ...trackedPairs]) rowsByKey.set(pairKey(pair), pair);
    const rows = [...rowsByKey.values()].sort((left, right) =>
      pairKey(left).localeCompare(pairKey(right)),
    );

    const coverage = await listFxPairStatus(this.db, rows);

    const pairs: FxPairResponse[] = coverage.map((entry) => {
      const key = pairKey(entry);
      return {
        base: entry.base,
        quote: entry.quote,
        held: heldKeys.has(key),
        tracked: trackedKeys.has(key),
        supported: supportedKeys.has(key),
        ...(entry.latestRate === undefined
          ? {}
          : { latestRate: serializeDecimal(entry.latestRate) }),
        ...(entry.latestRateDate === undefined ? {} : { latestRateDate: entry.latestRateDate }),
        ...(entry.latestSourceKey === undefined ? {} : { latestSourceKey: entry.latestSourceKey }),
        ...(entry.firstRateDate === undefined ? {} : { firstRateDate: entry.firstRateDate }),
        points: entry.points,
      };
    });

    return {
      provider: { key: capabilities.key, baseCurrency: capabilities.baseCurrency },
      ingestionConfigured: (this.marketRuntime?.scheduler ?? null) !== null,
      pairs,
      supportedPairs: capabilities.publishedPairs.map((pair) => ({
        base: pair.base,
        quote: pair.quote,
      })),
    };
  }

  /**
   * `POST /market-data/fx/pairs` — track a pair.
   *
   * **Validated against the live provider's published set before the write**
   * (`isFxPairSupported`), not after: a row for a pair no provider serves is a
   * `SymbolNotFound` waiting to happen in the daily job, and the job's own
   * skip of unsupported pairs is the second line of defence, not the first.
   *
   * No row cap is applied and none is needed — the published set is the
   * ceiling (29 live pairs for ECB), so the table cannot grow past it no matter how
   * many requests arrive.
   *
   * Nothing is fetched here. The pair is loaded by the next `fx-daily` run
   * (scheduled, or forced from `fx/refresh` below), which sees zero
   * `fx_rate_daily` rows for it and therefore loads its *history* first —
   * SH-5's ordering, unchanged by this endpoint.
   */
  @HttpCode(201)
  @Post("fx/pairs")
  async addFxPair(@Body() rawBody: unknown): Promise<TrackFxPairResponse> {
    const pair = parseOrThrow(trackFxPairRequestSchema, rawBody);
    assertFxPairSupported(pair);
    const created = await trackFxPair(this.db, pair);
    return { base: pair.base, quote: pair.quote, created };
  }

  /**
   * `DELETE /market-data/fx/pairs/:base/:quote` — stop tracking a pair.
   *
   * **The rates already fetched stay.** Untracking means "stop fetching this",
   * never "forget what was fetched": a transaction priced from one of those
   * rows keeps its provenance, and a valuation needing a historical
   * rate still finds one.
   *
   * A pair that was not tracked is a `404`, not a silent `204`: the two
   * outcomes are different facts, and the screen's list is built from this
   * same API — a `204` for a row that never existed would report a deletion
   * that did not happen. A pair still fetched because it is *held* is
   * untracked successfully; it simply keeps appearing, which the `held` flag
   * already explains.
   */
  @HttpCode(204)
  @Delete("fx/pairs/:base/:quote")
  async removeFxPair(
    @Param("base") rawBase: string,
    @Param("quote") rawQuote: string,
  ): Promise<void> {
    const pair = parseOrThrow(trackFxPairRequestSchema, { base: rawBase, quote: rawQuote });
    const deleted = await untrackFxPair(this.db, pair);
    if (!deleted) {
      throw problemException(404, {
        title: "This currency pair is not tracked",
        code: "FX_PAIR_NOT_TRACKED",
        detail: `no fx_tracked_pair row exists for ${pair.base}/${pair.quote}`,
        params: { base: pair.base, quote: pair.quote },
      });
    }
  }

  /**
   * `POST /market-data/fx/refresh` — force the daily FX pull now.
   *
   * Same three properties as `quoteRefresh` above, for the same reasons:
   * nothing is fetched synchronously (the response is written before any job
   * runs), `scheduler === null` is a `503` rather than a `202` that enqueues
   * nothing, and the rate cap is a *rate* cap
   * (`fx-refresh-throttle.interceptor.ts`).
   *
   * **`force: true` is what makes the button do anything.** Without it the
   * handler's DB-driven decision (`fxDailyRatesAlreadyIngested`) would find
   * today already covered and complete without touching the provider — correct
   * for the 19:00 cron, useless for a user who just added a pair or wants
   * ECB's revision of today. The flag skips only that check: the positive-rate
   * guard, the history catch-up and the idempotent upsert all still apply.
   *
   * `enqueued: false` means pg-boss collapsed this into a run already queued or
   * active on the `singleton` queue — reported honestly rather than dressed up
   * as a second run.
   */
  @UseInterceptors(fxRefreshRateThrottleInterceptor)
  @HttpCode(202)
  @Post("fx/refresh")
  async fxRefresh(@CurrentSession() session: SessionContext): Promise<FxRefreshAcceptedResponse> {
    const scheduler = this.marketRuntime?.scheduler ?? null;
    if (scheduler === null) {
      throw problemException(503, {
        title: "Market data ingestion is not configured",
        code: "MARKET_DATA_NOT_CONFIGURED",
        detail:
          "this deployment has no ingestion queue connection (INGESTION_DATABASE_URL is unset), " +
          "so an FX refresh cannot be enqueued",
      });
    }

    // Reported so the caller learns what the run will cover — the same
    // resolution the worker performs, not an estimate of it.
    const pairs = resolveFxDailyPairs({
      capabilities: fxProviderCapabilities(),
      heldCurrencies: await listTenantHeldCurrencies(this.db, session.tenantId),
      trackedPairs: await fetchTrackedFxPairs(this.db),
    });

    const jobId = await scheduler.enqueueFxDaily({ force: true });
    return {
      pairs: pairs.length,
      enqueued: jobId !== null,
      ...(jobId === null ? {} : { jobId }),
    };
  }
}

/**
 * The one `(base, quote)` key form this controller compares pairs by. Local
 * rather than imported: it exists only to build `Set`s inside `fxOverview`, and
 * nothing on the wire or in the database is keyed on its output — so this is a
 * two-line local convenience, not a second copy of an invariant.
 */
function pairKey(pair: { readonly base: string; readonly quote: string }): string {
  return `${pair.base}/${pair.quote}`;
}

/** 400 rather than a stored row the daily job would have to skip forever. `params` names the pair so the screen can say which one (see `ProblemDetails.params`). */
function assertFxPairSupported(pair: CurrencyPair): void {
  if (isFxPairSupported(pair)) return;
  throw problemException(400, {
    title: "This currency pair is not published by the FX provider",
    code: "FX_PAIR_NOT_SUPPORTED",
    detail: `${pair.base}/${pair.quote} is not one of the pairs the configured FX provider publishes`,
    params: { base: pair.base, quote: pair.quote },
  });
}
