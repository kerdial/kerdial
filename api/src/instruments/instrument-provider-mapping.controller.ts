import { Body, Controller, Delete, Inject, Param, Put } from "@nestjs/common";
import { providerKeyForBackfill, type MarketRuntime } from "@kerdial/market-composition";
import {
  clearProviderMapping,
  correctProviderMapping,
  findInstrumentByProviderSymbol,
  getInstrumentBackfillTarget,
  getProviderMapping,
  ProviderMappingAlreadyExistsError,
} from "@kerdial/ledger";
import type { InstrumentKind } from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import type { SessionContext } from "@kerdial/platform-auth";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { problemException } from "../common/problem.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import {
  correctProviderMappingBodySchema,
  type HistoryReloadAcceptedResponse,
  type ProviderMappingRepairResponse,
} from "./instruments.schema.js";

/**
 * `PUT` and `DELETE /instruments/:id/provider-mapping`: the way a
 * wrong provider mapping is corrected *through the product*.
 *
 * **The gap this closes.** `resolveProviderSymbol` short-circuits on any
 * existing mapping — a `CONFIRMED` one is used exactly like a `HEURISTIC` one —
 * so once a mapping is written it is what the system uses forever. The five
 * functions in `ledger`'s provider-map service that could repair one had no
 * production caller — not for want of privilege (migration `0012` has granted
 * `app_web` write on `instrument_provider_map` since the interactive-creation
 * path, contrary to the original bug report's diagnosis) but because no endpoint was ever
 * built. The only repair available was raw SQL as `app_owner`, and that is why
 * the NOV case — 4 995 DKK
 * closes under a EUR-declared XETR listing, 18 transactions valued against them
 * — stayed broken after it was found.
 *
 * **Its own controller**, not another handler on `InstrumentsController`, for
 * the reason `InstrumentHistoryReloadController` records: a distinct
 * user-triggered market-data operation with its own throttle and its own failure
 * vocabulary. Registered in the existing `InstrumentsModule`, so auth and CSRF
 * come from the global guards and `RouteRegistry`'s unauthenticated-route sweep
 * (AC32) picks both routes up with no exemption.
 *
 * **Route shadowing.** Both routes are a parametric `:id` followed by the static
 * tail `provider-mapping`, on distinct verbs (`PUT`/`DELETE`) that no other
 * `/instruments` route uses. `GET /instruments/discovery` — the one static-vs-
 * parametric hazard on this prefix — is unreachable from here.
 *
 * **Throttle: the same bucket as `POST /instruments/:id/history-reload`, not a
 * new one beside it.** Every repair here requests exactly that endpoint's work —
 * a full 20-year re-walk against the provider — so giving it a separate cap
 * would let a caller take ten walks an hour by alternating endpoints while both
 * caps read as respected. Sharing the bucket is what makes the 5/hour cap mean
 * five walks.
 */
/** What `#authorize` proved: the caller may repair this instrument, and this is the provider its kind routes to. */
interface AuthorizedTarget {
  readonly providerKey: string;
  readonly kind: InstrumentKind;
}

@Controller("instruments")
export class InstrumentProviderMappingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
  ) {}

  /**
   * Correct the mapping: the caller states the provider symbol this instrument
   * should have been resolved to.
   *
   * `200`, not `202`: unlike the reload, the mapping write and the price-series
   * discard both happen synchronously and are complete when this returns. Only
   * the re-fetch is asynchronous, and it is reported as its own nested object
   * rather than by collapsing the whole response into `202`.
   */
  @Put(":id/provider-mapping")
  async correct(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<ProviderMappingRepairResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(correctProviderMappingBodySchema, body);
    const target = await this.#authorize(id, session);
    const { providerKey } = target;

    // Pre-flight, before the reload writes anything (see `#reload`): the
    // `(provider_key, provider_symbol)` unique index would refuse this at the
    // insert anyway, but by then the backfill state has been reset and a
    // re-walk enqueued for a request that goes on to fail. The constraint stays
    // as the backstop for the race this check cannot close.
    const claimant = await findInstrumentByProviderSymbol(
      this.db,
      providerKey,
      parsed.providerSymbol,
    );
    if (claimant !== undefined && claimant.instrumentId !== id) {
      throw this.#symbolAlreadyMapped(parsed.providerSymbol);
    }

    const historyReload = await this.#reload(id, target);

    let repaired;
    try {
      repaired = await correctProviderMapping(this.db, id, {
        providerKey,
        providerSymbol: parsed.providerSymbol,
      });
    } catch (err) {
      // The `(provider_key, provider_symbol)` unique index: some *other*
      // instrument already claims this exact pair. Surfaced rather than
      // resolved — silently stealing it would break that instrument's pricing
      // to fix this one, which is the same trade this endpoint exists to undo.
      // The race the pre-flight check above cannot close: another request
      // claimed the pair in between. Same answer, reached the other way.
      if (err instanceof ProviderMappingAlreadyExistsError) {
        throw this.#symbolAlreadyMapped(parsed.providerSymbol);
      }
      throw err;
    }

    return {
      instrumentId: id,
      providerKey,
      providerSymbol: repaired.mapping?.providerSymbol ?? null,
      confidence: "CONFIRMED",
      discardedPriceRows: repaired.discardedPriceRows,
      historyReload,
    };
  }

  /**
   * Clear the mapping: the caller knows the stored symbol is wrong and does not
   * know the right one, so the next backfill re-resolves from the instrument's
   * own identifiers instead of short-circuiting on a guess that already failed.
   *
   * `200` with a body rather than `204`. A `204` would be the smaller answer and
   * the wrong one: this operation deletes the instrument's entire automated
   * price series, and `discardedPriceRows` is exactly the fact a caller must be
   * able to show the user. An empty response would make the destructive half
   * invisible at the surface that performed it.
   */
  @Delete(":id/provider-mapping")
  async clear(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<ProviderMappingRepairResponse> {
    const id = parseIdParam(rawId);
    const target = await this.#authorize(id, session);
    const { providerKey } = target;

    // Pre-flight, for the same reason the correction has one: `clearProviderMapping`
    // throws `ProviderMappingNotFoundError` for a row that is not there, and
    // discovering that after `#reload` would leave a reset and an enqueued
    // re-walk behind a `404`.
    if ((await getProviderMapping(this.db, id, providerKey)) === undefined) {
      throw problemException(404, {
        title: "This instrument has no provider mapping to clear",
        code: "PROVIDER_MAPPING_NOT_FOUND",
        detail:
          "nothing is mapped for this instrument's provider, so its next backfill already " +
          "resolves from scratch",
      });
    }

    const historyReload = await this.#reload(id, target);
    const repaired = await clearProviderMapping(this.db, id, providerKey);

    return {
      instrumentId: id,
      providerKey,
      providerSymbol: null,
      confidence: null,
      discardedPriceRows: repaired.discardedPriceRows,
      historyReload,
    };
  }

  /** The `409` both paths reach — from the pre-flight check, and from the unique constraint that closes its race. */
  #symbolAlreadyMapped(providerSymbol: string): Error {
    return problemException(409, {
      title: "That provider symbol is already mapped to another instrument",
      code: "PROVIDER_SYMBOL_ALREADY_MAPPED",
      detail:
        `provider symbol ${providerSymbol} is already mapped to a different instrument — ` +
        "correct or clear that instrument's mapping first",
    });
  }

  /**
   * Every rejection that does not depend on the repair itself, and the provider
   * key the repair will use.
   *
   * The provider key is **derived, never accepted**: `providerKeyForBackfill`
   * is the same routing table the backfill uses, so a request cannot point an
   * instrument at a provider that would never be asked to price it.
   *
   * The rejections are ordered exactly as `InstrumentHistoryReloadController`
   * orders its own, including the deliberate ownership-before-kind departure:
   * answering `400 INSTRUMENT_NOT_BACKFILLABLE` for another
   * tenant's tenant-owned FUND would reinstate, through the kind check, the
   * existence oracle the `404` exists to close.
   */
  async #authorize(id: string, session: SessionContext): Promise<AuthorizedTarget> {
    if (
      this.marketRuntime === null ||
      this.marketRuntime.scheduler === null ||
      this.marketRuntime.requestBackfillReload === undefined
    ) {
      throw problemException(503, {
        title: "Market data ingestion is not configured",
        code: "MARKET_DATA_NOT_CONFIGURED",
        detail:
          "this deployment has no ingestion queue connection (INGESTION_DATABASE_URL is unset), " +
          "so a provider mapping cannot be repaired — the corrected mapping would never be fetched",
      });
    }

    const target = await getInstrumentBackfillTarget(this.db, id);
    // 404, never 403 — see `InstrumentHistoryReloadController`'s own note: a 403
    // would confirm the existence of another tenant's private instrument to
    // anyone who can guess a UUID.
    if (
      target === undefined ||
      (target.ownerTenantId !== null && target.ownerTenantId !== session.tenantId)
    ) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }

    const providerKey = providerKeyForBackfill(target.kind);
    if (providerKey === undefined) {
      throw problemException(400, {
        title: "This instrument has no automated price source",
        code: "INSTRUMENT_NOT_BACKFILLABLE",
        detail:
          `instruments of kind ${target.kind} have no automated price-history provider, so they ` +
          "carry no provider mapping to repair — enter price points manually instead",
      });
    }

    return { providerKey, kind: target.kind };
  }

  /**
   * Resets the backfill state and enqueues the re-walk — **the last thing that
   * happens before the repair, and the first thing that writes.**
   *
   * **Why it precedes the repair.** A backfill run that is already
   * `IN_PROGRESS` holds a provider symbol resolved before this request arrived,
   * and will keep writing rows for it. Repairing under such a run would discard
   * the series and then let that run refill it from the symbol being replaced.
   * `forceInstrumentBackfillReload`'s compare-and-set refuses an `IN_PROGRESS`
   * row, so going through it first turns that case into a clean `409` with
   * nothing written — no half-done repair. It also nulls the bookmarks, so the
   * run this repair schedules re-walks the full window instead of resuming from
   * one the old symbol established.
   *
   * **The residual window, stated rather than implied.** Between this call and
   * the repair transaction one round trip later, a queued job could start and
   * resolve the *old* mapping. Its own claim is refused while it is still in
   * `runInstrumentBackfillJob`'s SELECT→claim window (its claim guard compares the
   * bookmarks this call just nulled), but a job that gets past that can write
   * rows for the old symbol after the discard. The result is exactly the state
   * this endpoint repairs — detected by the `priceCurrencyMismatch`
   * indicator and fixed by calling this endpoint again. Neither silent nor
   * permanent, and the alternative ordering trades it for a half-done repair,
   * which is both.
   */
  async #reload(id: string, target: AuthorizedTarget): Promise<HistoryReloadAcceptedResponse> {
    // Non-null asserted rather than re-checked: `#authorize` has already thrown
    // the 503 for every absent-runtime shape, and it is the only way into here.
    const runtime = this.marketRuntime!;
    const result = await runtime.requestBackfillReload!.call(runtime, this.db, {
      instrumentId: id,
      kind: target.kind,
    });

    if (result.outcome === "ALREADY_RUNNING") {
      throw problemException(409, {
        title: "A history reload is already running for this instrument",
        code: "HISTORY_RELOAD_IN_PROGRESS",
        detail:
          "a full-history fetch for this instrument is in flight right now, and repairing its " +
          "mapping underneath that run would let the run refill the series from the symbol being " +
          "replaced — nothing has been changed; retry once it finishes",
      });
    }

    return {
      instrumentId: id,
      status: "PENDING",
      previousStatus: result.previousStatus,
      requestedFrom: result.requestedFrom,
      enqueued: result.enqueued,
    };
  }
}
