import { Controller, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { providerKeyForBackfill, type MarketRuntime } from "@kerdial/market-composition";
import { getInstrumentBackfillTarget } from "@kerdial/ledger";
import type { Db } from "@kerdial/platform-db";
import type { SessionContext } from "@kerdial/platform-auth";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { problemException } from "../common/problem.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { DB } from "../db/db.tokens.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import type { HistoryReloadAcceptedResponse } from "./instruments.schema.js";

/**
 * IB5 (spec
 * FR-179–FR-187) — `POST /instruments/:id/history-reload`, the
 * user-triggered "fetch this instrument's price history again, from scratch".
 *
 * Its own controller rather than another handler on `InstrumentsController`
 * (the `cash-accounts` CD7 precedent), registered in the existing
 * `InstrumentsModule`. Auth and CSRF come from the global `AuthGuard`/
 * `CsrfGuard` (`app.module.ts`), so there is **no new auth surface** and the
 * AC32 unauthenticated-route sweep picks this route up from `RouteRegistry`
 * automatically, with no exemption.
 *
 * **Route-shadowing (the hazard `InstrumentsController#discovery` documents).**
 * The only static-vs-parametric ambiguity on this prefix is
 * `GET /instruments/discovery`. This route is a `POST` with a distinct static
 * tail segment (`history-reload`) after the parameter, so no collision with it
 * — or with `POST /instruments` / `POST /instruments/:id/prices` — is possible.
 *
 * The 5/hour per-tenant rate cap this route shipped with (OD-3) was retired
 * by ADR-0016; the instance-wide admission bound is the only control.
 */
@Controller("instruments")
export class InstrumentHistoryReloadController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
  ) {}

  /**
   * `202 Accepted`, no request body. **Nothing is fetched synchronously** —
   * the response is written before any job runs, which is what makes `202`
   * the honest status code here (the same posture, and the same reason, as
   * `POST /market-data/quote-refresh`).
   *
   * The four rejections are ordered so each is a *distinguishable* failure
   * (FR-183) — a caller must be able to tell "this deployment has no
   * ingestion" from "this kind has no automated source" from "no such
   * instrument" from "a run is already in flight":
   *
   *  1. `parseIdParam` — a malformed id is a 400 before anything else.
   *  2. **503 `MARKET_DATA_NOT_CONFIGURED`** when the runtime, its scheduler,
   *     or `requestBackfillReload` itself is absent (FR-184, AC-10). A `202`
   *     here would be the worst outcome: the caller is told the reload was
   *     accepted and nothing anywhere is queued to do it. This check is also
   *     what makes `requestBackfillReload`'s own `scheduler === null` throw
   *     unreachable in production.
   *  3. **Ownership** (IB7) — 404, never 403; see the ordering
   *     note at that check for why it runs before, not after, step 4.
   *  4. **400 `INSTRUMENT_NOT_BACKFILLABLE`** for a kind with no automated
   *     price source (`SCPI` — `scpi` cycle, SC-L10, priced by hand only;
   *     FUND held this answer until ADR-0018, FR-183/AC-9, and INDEX
   *     until the benchmark line got a Yahoo-backed history). Decided by
   *     `market/composition`'s `providerKeyForBackfill`, the same routing
   *     helper `InstrumentsController#triggerInstrumentBackfill` uses, rather
   *     than by importing `market/ingestion`'s `BACKFILLABLE_KINDS` — `api`
   *     gains no new package dependency edge for this cycle.
   *
   * Then `requestBackfillReload`; `ALREADY_RUNNING` ⇒ **409
   * `HISTORY_RELOAD_IN_PROGRESS`** (IB3), which is also the honest answer to
   * the user: a full-history fetch for this instrument is running right now.
   */
  @HttpCode(202)
  @Post(":id/history-reload")
  async reload(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<HistoryReloadAcceptedResponse> {
    const id = parseIdParam(rawId);

    const requestBackfillReload = this.marketRuntime?.requestBackfillReload;
    if (
      this.marketRuntime === null ||
      this.marketRuntime.scheduler === null ||
      requestBackfillReload === undefined
    ) {
      throw problemException(503, {
        title: "Market data ingestion is not configured",
        code: "MARKET_DATA_NOT_CONFIGURED",
        detail:
          "this deployment has no ingestion queue connection (INGESTION_DATABASE_URL is unset), " +
          "so a history reload cannot be enqueued",
      });
    }

    // IB7: deliberately **not** `getInstrumentById`, which
    // filters `owner_tenant_id IS NULL` and would therefore 404 the *owner* of
    // their own tenant-owned instrument. See `getInstrumentBackfillTarget`'s
    // own doc comment.
    const target = await getInstrumentBackfillTarget(this.db, id);

    // **404, never 403** (IB7, deliberate). A 403 would confirm the existence
    // of another tenant's private instrument to anyone who can guess a UUID,
    // turning this endpoint into an existence oracle for exactly the rows
    // `owner_tenant_id` exists to hide. The two rejections — "no such
    // instrument" and "not yours" — are indistinguishable on the wire, and
    // this is stated here so nobody "fixes" it to a 403 for symmetry with
    // some other route.
    //
    // **Ordering note — a deliberate, disclosed departure from the
    // step list.** That list enumerates the kind check (step 3) before the
    // ownership check (step 4); doing so literally would answer
    // `400 INSTRUMENT_NOT_BACKFILLABLE` for another tenant's tenant-owned
    // FUND and `404` for a genuinely unknown id — reinstating, through
    // the kind check, exactly the existence oracle the ownership rule exists
    // to close. The two rules are only consistent if a row this caller may not
    // see is indistinguishable from a row that does not exist, so the
    // authorization gate runs first here. No acceptance criterion is affected:
    // AC-9's fixture is a *shared* FUND (still `400` — it passes this gate),
    // AC-13's is a tenant-owned SHARE (still `404`), and the codes stay
    // pairwise distinguishable as FR-183 requires.
    if (
      target === undefined ||
      (target.ownerTenantId !== null && target.ownerTenantId !== session.tenantId)
    ) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }

    if (providerKeyForBackfill(target.kind) === undefined) {
      throw problemException(400, {
        title: "This instrument has no automated price source",
        code: "INSTRUMENT_NOT_BACKFILLABLE",
        detail:
          `instruments of kind ${target.kind} have no automated price-history provider, so their ` +
          "history cannot be reloaded — enter price points manually instead",
      });
    }

    const result = await requestBackfillReload.call(this.marketRuntime, this.db, {
      instrumentId: id,
      kind: target.kind,
    });

    if (result.outcome === "ALREADY_RUNNING") {
      throw problemException(409, {
        title: "A history reload is already running for this instrument",
        code: "HISTORY_RELOAD_IN_PROGRESS",
        detail:
          "a full-history fetch for this instrument is in flight right now — its result will " +
          "include the freshest available data, so no second run is needed",
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
