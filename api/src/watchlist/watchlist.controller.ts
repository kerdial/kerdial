import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { providerKeyForBackfill, type MarketRuntime } from "@kerdial/market-composition";
import {
  InstrumentNotFoundError,
  WatchlistItemNotFoundError,
  WatchlistTargetPriceScaleExceededError,
  WatchlistTenantCapExceededError,
  addWatchlistItem,
  getInstrumentBackfillTarget,
  listWatchedInstrumentIds,
  removeWatchlistItem,
  updateWatchlistItem,
  type InstrumentKind,
} from "@kerdial/ledger";
import type { SessionContext } from "@kerdial/platform-auth";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { TooManyWatchlistRowsError, valueWatchlistForTenant } from "@kerdial/valuation";
import { CurrentSession } from "../auth/current-session.decorator.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { DB } from "../db/db.tokens.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import {
  createWatchlistItemBodySchema,
  toWatchlistItemResponse,
  toWatchlistResponse,
  updateWatchlistItemBodySchema,
  watchlistQuerySchema,
  type WatchedInstrumentIdsResponse,
  type WatchlistItemResponse,
  type WatchlistResponse,
} from "./watchlist.schema.js";
import { TokenReadable } from "../auth/token-readable.decorator.js";

/** ISO `YYYY-MM-DD` — today's date, in UTC, matching every other `today` default in this codebase (`portfolios.controller.ts`'s own copy). */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `/watchlist/*` — the five routes (T-69; FR-338–FR-342, FR-355, FR-361, FR-363, FR-363a, FR-364,
 * FR-375).
 *
 * **Why its own controller.** The resource is *the tenant's watchlist*, not a
 * property of one instrument and not a portfolio view: it answers across the
 * whole catalogue, it returns figures no `InstrumentResponse` carries, and its
 * read is a valuation-class read while `/instruments/*` is a cheap-read
 * controller. Hanging it off `/instruments` would also put a write that
 * *creates no instrument* next to the 30/hour instrument-creation rate cap.
 *
 * Auth and CSRF are the global `AuthGuard`/`CsrfGuard` (`app.module.ts`'s
 * `APP_GUARD`s), so there is no new auth surface here and all five routes are
 * swept by `auth.e2e.test.ts`'s AC32 401 sweep automatically —
 * `route-registry.ts` collects routes from Fastify's own `onRoute` hook, and
 * that suite pins no route *count* (MEASURED at T-69:
 * `auth.e2e.test.ts:376` asserts `sweptRoutes.length > 0`), so assumption A4
 * is closed and that file needs no edit.
 *
 * ## Throttles
 *
 * NFR-35 had every route here join an *existing* per-tenant interceptor
 * instance (valuation reads, cheap reads, instrument writes) because the
 * budget's headroom was one connection. ADR-0016 retired that table:
 * every route is bounded by the one instance-wide admission bound and carries
 * no route-level throttle. Decision W-7 still holds in spirit — a watch's
 * backfill trigger is idempotent per instrument, forever, so nothing here
 * needed a rate cap even when `POST /instruments` had one.
 *
 *   Stated exactly, because the reasoning recorded here was wrong until WL-1's
 *   review and a future reader must not lean on the bound it
 *   claimed: the 200-row cap bounds *concurrently held rows*, not distinct
 *   instruments over time — `DELETE /watchlist/:instrumentId` is unconditional
 *   and un-rate-capped, so a POST/DELETE cycle walks the whole catalogue past
 *   this trigger while never holding more than one row. What actually bounds
 *   the induced provider work is `ensureInstrumentBackfillRequested`
 *   (`market/ingestion/src/instrument-backfill-job.ts:253-257`): its insert is
 *   `ON CONFLICT (instrument_id) DO NOTHING`, and its only other arm is the
 *   widen `UPDATE` guarded by `WHERE requested_from > $computed`
 *   (`:310-323`). A watch omits `firstTransactionDate`, so it always computes
 *   `now − 20 y` (`backfill-window.ts:119-149` — the *latest* value that
 *   function can return, since a `firstTransactionDate` only ever pushes it
 *   earlier), and `requested_from` only ever decreases (the widen's own guard;
 *   `forceInstrumentBackfillReload`'s `least(...)`, `:498`). So a watch can
 *   never satisfy the widen predicate and can only ever take the insert
 *   branch: total induced provider work is **one backfill per catalogue
 *   instrument that never had one, ever**, no matter how many watch/un-watch
 *   cycles a tenant runs — which is exactly what FR-342 promises.
 */
@Controller("watchlist")
export class WatchlistController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
  ) {}

  /**
   * `GET /watchlist?window=` (FR-355/FR-361/FR-363) — every watched
   * instrument with its price, freshness, day change, metrics and decimated
   * series, from **one** request whose statement count does not scale with the
   * number of rows.
   *
   * The **position-if-held block is deliberately not here** (FR-354, W-5): the
   * client joins this response against the `GET /portfolios/holdings` response
   * it already knows how to fetch, so those figures are the holdings
   * response's own bytes rather than a second mapper kept in step by hand —
   * and one unpriceable *held* instrument, unrelated to anything watched,
   * cannot 422 this screen.
   */
  @TokenReadable()
  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<WatchlistResponse> {
    const parsed = parseOrThrow(watchlistQuerySchema, query);

    try {
      const view = await valueWatchlistForTenant(this.db, {
        tenantId: session.tenantId,
        asOfDate: todayIsoDate(),
        window: parsed.window,
      });
      return toWatchlistResponse(view);
    } catch (err) {
      throw this.#mapWatchlistError(err);
    }
  }

  /**
   * `GET /watchlist/ids` (FR-363a) — which instruments this tenant watches,
   * nothing else. What `<WatchToggle>` on the instrument screens resolves its
   * state from (W-6), which is why it is a cheap read and not a slice of the
   * response above.
   *
   * **Route-shadowing note**, stated for the reason
   * `instruments.controller.ts:324-329` states its own: `ids` is a static path
   * segment, and this controller has no `@Get(":instrumentId")` for it to
   * compete with today — but Fastify's `find-my-way` prioritises a static
   * match over a parametric one regardless of declaration order, so a future
   * parametric GET here cannot shadow this route either.
   *
   * **Never `fetchWatchedInstruments`** (`market/ingestion`): that function is
   * cross-tenant by design for the fan-out, and serving a request path from it
   * would leak every tenant's watchlist — FR-51's forbidden substitution in a
   * new shape. `listWatchedInstrumentIds` is the tenant-scoped read,
   * and `market-data-quote-refresh.e2e.test.ts` guards the substitution
   * statically by name.
   */
  @Get("ids")
  async ids(@CurrentSession() session: SessionContext): Promise<WatchedInstrumentIdsResponse> {
    return { instrumentIds: await listWatchedInstrumentIds(this.db, session.tenantId) };
  }

  /**
   * `POST /watchlist` (FR-338/FR-339/FR-342/FR-375) — watch an instrument, or
   * update the row that is already there.
   *
   * **200 on every call**, first add and repeat alike. A `201`-then-`200`
   * split would put a fact on the status line that no client can act on and no
   * test can assert deterministically (a second tab's add *is* a repeat), and
   * FR-375 requires that no entry point's failure mode be "already in that
   * state". This is the idempotent-upsert idiom `PUT /instruments/:id/icon`
   * already uses — **confirmed at T-69** (assumption A7): that route is
   * declared with no `@HttpCode`, so Nest answers `200` for both create and
   * replace, which is exactly the status this route follows.
   *
   * Idempotence itself is the table's primary key, not a read-then-write race:
   * `addWatchlistItem` is one `INSERT … ON CONFLICT DO UPDATE`.
   */
  @Post()
  @HttpCode(200)
  async add(
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<WatchlistItemResponse> {
    const parsed = parseOrThrow(createWatchlistItemBodySchema, body);

    let record;
    try {
      record = await addWatchlistItem(this.db, {
        tenantId: session.tenantId,
        instrumentId: parsed.instrumentId,
        ...(parsed.targetPrice !== undefined ? { targetPrice: parsed.targetPrice } : {}),
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      });
    } catch (err) {
      throw this.#mapWatchlistError(err);
    }

    // FR-342 — **after** the upsert has committed and never inside its
    // own `try`: a 404/429 never reaches this line (the `catch` above already
    // threw), and a failure here must never be mistaken for the watch itself
    // having failed. `kind` comes from the catalogue row `addWatchlistItem`
    // has just proved exists.
    await this.#triggerInstrumentBackfill(record.instrumentId, parsed.instrumentId);

    return toWatchlistItemResponse(record);
  }

  /**
   * `PATCH /watchlist/:instrumentId` (FR-341) — edit the target price or the
   * note **without un-watching**. `404 WATCHLIST_ITEM_NOT_FOUND` when the
   * instrument is not watched: a `PATCH` is not a create, and silently
   * inserting would make this a second, undocumented add path.
   *
   * The cap is never consulted here (this adds no row), so a tenant at 200 can
   * still correct a target price.
   */
  @Patch(":instrumentId")
  async patch(
    @Param("instrumentId") rawInstrumentId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<WatchlistItemResponse> {
    const instrumentId = parseIdParam(rawInstrumentId);
    const parsed = parseOrThrow(updateWatchlistItemBodySchema, body);

    try {
      const record = await updateWatchlistItem(this.db, {
        tenantId: session.tenantId,
        instrumentId,
        ...(parsed.targetPrice !== undefined ? { targetPrice: parsed.targetPrice } : {}),
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      });
      return toWatchlistItemResponse(record);
    } catch (err) {
      throw this.#mapWatchlistError(err);
    }
  }

  /**
   * `DELETE /watchlist/:instrumentId` (FR-340/FR-375) — un-watch.
   *
   * **204 whether or not a row existed, and never 404** —
   * `DELETE /instruments/:id/icon`'s exact contract, for the same reason: two
   * tabs or a double-click would otherwise make the second attempt an error
   * for having succeeded. It is not an existence oracle either (RLS scopes the
   * statement to the caller's own tenant, so a zero-row delete reveals only
   * the caller's own state), but the idempotence argument alone is what
   * decides it.
   *
   * No existence probe first: it would cost a statement to produce a `404`
   * this route has just declined to emit.
   */
  @Delete(":instrumentId")
  @HttpCode(204)
  async remove(
    @Param("instrumentId") rawInstrumentId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<void> {
    const instrumentId = parseIdParam(rawInstrumentId);
    await removeWatchlistItem(this.db, { tenantId: session.tenantId, instrumentId });
  }

  /**
   * FR-342, copying `InstrumentsController#triggerInstrumentBackfill`'s
   * shape verbatim — the same two guards and the same best-effort swallow:
   *
   *  1. `MARKET_RUNTIME` `null` (the test/degraded default) is a no-op, so a
   *     watch succeeds regardless of queue state;
   *  2. `providerKeyForBackfill(kind) === undefined` is a no-op — the **SCPI
   *     exclusion** (`scpi` cycle, SC-L10: no provider ever serves an SCPI;
   *     FR-346 said the same of FUND until ADR-0018 routed it), checked
   *     here rather than by catching `ensureInstrumentBackfillRequested`'s own
   *     `TypeError`, so an SCPI watch never even attempts an enqueue;
   *  3. the enqueue is logged and swallowed, never thrown, so a provider or
   *     queue outage cannot turn a successful watch into a 500.
   *
   * Idempotence needs no code here: `ensureInstrumentBackfillRequested`'s
   * insert is `ON CONFLICT (instrument_id) DO NOTHING`, which serialises any
   * number of concurrent callers across any number of processes — so the 201st
   * add of an already-catalogued instrument enqueues nothing.
   * `firstTransactionDate` is deliberately omitted: a watch is not a
   * transaction, and the full 20-year window (`BACKFILL_YEARS`,
   * `market/ingestion/src/backfill-window.ts`) is the honest default.
   *
   * **The `kind` this needs is not on `WatchlistItemRecord`**, which carries
   * only the `watchlist_item` row's own columns. Rather than widen that
   * record (a `ledger` type change for one `api` guard) or run a second
   * statement, the kind is read from `getInstrumentBackfillTarget` — the same
   * probe `PUT /instruments/:id/icon` uses, and one indexed primary-key
   * lookup **outside** the write's transaction, on the best-effort path where
   * a failure is already swallowed.
   */
  async #triggerInstrumentBackfill(instrumentId: string, requestedId: string): Promise<void> {
    if (this.marketRuntime === null) return;

    try {
      const kind = await this.#instrumentKind(instrumentId);
      if (kind === undefined) return;
      if (providerKeyForBackfill(kind) === undefined) return;
      await this.marketRuntime.enqueueBackfill(this.db, { instrumentId, kind });
    } catch (err) {
      rootLogger().error(
        "WatchlistController#triggerInstrumentBackfill: best-effort backfill trigger failed — swallowed; reconcilePendingInstrumentBackfills is the recovery path.",
        {
          component: "api",
          instrument_id: requestedId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  /** The one lookup {@link WatchlistController.#triggerInstrumentBackfill} needs — see its doc comment for why it is a read rather than a widened `ledger` record. */
  async #instrumentKind(instrumentId: string): Promise<InstrumentKind | undefined> {
    const target = await getInstrumentBackfillTarget(this.db, instrumentId);
    return target?.kind as InstrumentKind | undefined;
  }

  /**
   * the four mapped errors, plus WL-1's defensive fifth. Every other error
   * falls through to the `ProblemJsonExceptionFilter`'s 500, which is the
   * honest status for a problem the caller cannot fix by changing the request.
   */
  #mapWatchlistError(err: unknown): unknown {
    // FR-340/FR-368 — the per-tenant row cap as a machine-readable **429**,
    // matching `INSTRUMENT_ICON_TENANT_CAP_EXCEEDED`'s measured precedent
    // (`instruments.controller.icon-error-mapping.test.ts:186-194`); two
    // per-tenant row caps answering different statuses would be the drift.
    //
    // The collision this creates is a **test-shape requirement**, not a
    // footnote: the admission bound also answers 429 on this same route with
    // `ADMISSION_BOUND_EXCEEDED`, so AC-337's e2e asserts the `code`, never
    // the status alone (R4, `watchlist-cap.e2e.test.ts`).
    if (err instanceof WatchlistTenantCapExceededError) {
      return problemException(429, {
        title: "Watchlist limit reached",
        code: "WATCHLIST_TENANT_CAP_EXCEEDED",
        // No `detail` and no `params`: `err.message` names the tenant id, and
        // the cap is a server constant the client already mirrors in
        // `web/src/lib/api-limits.ts` — a second copy on the wire would be a
        // figure two sources could disagree about (the icon cap's own rule).
      });
    }
    if (err instanceof WatchlistItemNotFoundError) {
      return problemException(404, {
        title: "Watchlist item not found",
        code: "WATCHLIST_ITEM_NOT_FOUND",
      });
    }
    // WL-1 (security review): unreachable through
    // these two routes today — `watchlistTargetPriceSchema`'s own scale
    // refinement rejects more than 18 fractional digits before either write
    // function is called — but mapped defensively anyway, exactly as
    // `MANUAL_PRICE_POINT_SCALE_EXCEEDED` is (`instruments.controller.ts`),
    // so a future change to either layer degrades to a machine-readable 400
    // and never to the raw `23514`-shaped 500 this finding recorded.
    if (err instanceof WatchlistTargetPriceScaleExceededError) {
      return problemException(400, {
        title: "Watchlist target price has too many fractional digits",
        code: "WATCHLIST_TARGET_PRICE_SCALE_EXCEEDED",
        detail: err.message,
      });
    }
    // Reusing the **existing** code rather than minting a watchlist-specific
    // one: "no such instrument" is the same fact here as everywhere else, and
    // `ledger` deliberately throws the existing error class for it. Covers
    // both "does not exist" and "is not a shared-catalogue row" — one answer
    // on the wire, so this route is not an existence oracle for a future
    // tenant-private instrument.
    if (err instanceof InstrumentNotFoundError) {
      return problemException(404, {
        title: "Instrument not found",
        code: "INSTRUMENT_NOT_FOUND",
      });
    }
    // FR-365/NFR-39 — rejected, never truncated. 422 not 413, for the reason
    // `VALUATION_RESPONSE_TOO_LARGE`'s own arm records: this is a *response*
    // the server refuses to send in full, not an oversized request, and this
    // is a `GET`.
    if (err instanceof TooManyWatchlistRowsError) {
      return problemException(422, {
        title: "Watchlist response too large",
        code: "WATCHLIST_RESPONSE_TOO_LARGE",
        detail: err.message,
      });
    }
    return err;
  }
}
