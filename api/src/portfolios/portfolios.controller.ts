import {
  Controller,
  Body,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { Db } from "@kerdial/platform-db";
import {
  PortfolioDeleteBlockedByLinkedTransactionError,
  describePriceGap,
  PortfolioIconPortfolioNotFoundError,
  PortfolioNameAlreadyExistsError,
  PortfolioTenantCapExceededError,
  countTransactionsByPortfolio,
  createPortfolio,
  deletePortfolio,
  getPortfolio,
  getPortfolioIcon,
  listPortfolios,
  removePortfolioIcon,
  setPortfolioArchived,
  setPortfolioIcon,
  updatePortfolio,
  type PortfolioIconInput,
} from "@kerdial/ledger";
import {
  TooManyClosedPositionsError,
  TooManyHoldingsError,
  TooManyRealizedGainsError,
  TooManySaleLotsError,
  UnresolvablePriceError,
  UnresolvableRateError,
  computeCombinedPortfolioReturns,
  computeCombinedPortfolioValueSeries,
  computePortfolioReturns,
  computePortfolioValueSeries,
  valueClosedPositionsAsOf,
  valueClosedPositionsForTenant,
  valueHoldingsAsOf,
  valueHoldingsForTenant,
} from "@kerdial/valuation";
import type { SessionContext } from "@kerdial/platform-auth";
import type { ValuationPriceGapParams } from "@kerdial/api-contracts";
import { DB } from "../db/db.tokens.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { buildCursorPage, decodeOffsetCursor, parsePageLimit } from "../common/pagination.js";
import { CurrentSession } from "../auth/current-session.decorator.js";
import {
  createPortfolioBodySchema,
  listPortfoliosQuerySchema,
  overviewQuerySchema,
  performanceQuerySchema,
  valueSeriesQuerySchema,
  patchPortfolioBodySchema,
  resolveReturnWindow,
  toClosedPositionsResponse,
  toHoldingsResponse,
  toOverviewResponse,
  toPerformanceResponse,
  toValueSeriesResponse,
  toPortfolioIconMetaResponse,
  toPortfolioResponse,
  type ClosedPositionsResponse,
  type HoldingsResponse,
  type OverviewResponse,
  type PerformanceResponse,
  type ValueSeriesResponse,
  type PortfolioIconMetaResponse,
  type PortfolioResponse,
} from "./portfolios.schema.js";
import {
  validatePortfolioIconUpload,
  type PortfolioIconRejectionCode,
} from "./portfolio-icon.validate.js";

/** ISO `YYYY-MM-DD` — today's date, in UTC, matching every other `today` default in this codebase's schema layer (`instruments.schema.ts`'s `resolvePriceHistoryWindow`). */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `/portfolios/*` — T-37/T-39, FR-14.
 * Thin controllers over T-17's portfolio management service and T-39's
 * `@kerdial/valuation` read engines (`valueHoldingsAsOf`/
 * `valueHoldingsForTenant`/`computePortfolioReturns`/
 * `computeCombinedPortfolioReturns`). Every read/write is scoped to
 * `session.tenantId`, enforced via `withTenant`/RLS (T-9) inside those
 * functions — never a `WHERE tenant_id = ?` this controller writes itself
 * (AC33).
 *
 * ## Route ordering — `/portfolios/overview` vs. `/portfolios/:id/overview`
 *
 * The combined tenant-wide routes (`overview`, `holdingsCombined`) are
 * declared **before** the `:id`-scoped ones in this class, and take no path
 * parameter of their own (`@Get("overview")` -> `/portfolios/overview`,
 * exactly two path segments) while every `:id`-scoped route has **three**
 * (`@Get(":id/overview")` -> `/portfolios/:id/overview`). Nest/Fastify's
 * router matches on the compiled route pattern, and a two-segment path and a
 * three-segment path are different patterns regardless of registration
 * order — so `GET /portfolios/overview` can never be captured by `:id`
 * matching the literal string `"overview"` *for these specific routes*
 * (verified directly in `portfolios-overview.e2e.test.ts`'s own routing
 * describe). The ordering is kept anyway, and documented here, as a
 * defensive convention: this controller has no bare `GET /portfolios/:id`
 * today, but if one is ever added (a natural future addition alongside
 * `:id/overview`/`:id/holdings`/`:id/performance`), it *would* collide in
 * segment count with `/portfolios/overview`/`/portfolios/holdings` — placing
 * the combined routes first means Nest/Fastify's registration-order
 * tie-break, if it is ever needed, already favours the un-ambiguous literal
 * route over a hypothetical `:id` one.
 *
 * `portfolio-details`' three icon routes (`PUT`/`DELETE`/`GET
 * /portfolios/:id/icon`) join that picture with **no** ordering requirement of
 * their own: each is three segments with a static tail, so it can collide with
 * neither the two-segment combined routes nor the `:id`-scoped ones. Asserted
 * behaviourally in `portfolios.e2e.test.ts` — which handler actually answers —
 * rather than by reading the decorator order, per the recorded rule that a
 * configuration assertion has passed here before while the control was inert.
 */
@Controller("portfolios")
export class PortfoliosController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `GET /portfolios/overview?from=&to=` — the combined tenant-wide view
   * (added 2026-07-21 by user decision, T-39, closing AC10's
   * combined-total gap). Aggregated across every portfolio this tenant owns,
   * through the same `valuePortfolio`/`mergeProvenance` path as the
   * per-portfolio route — see `@kerdial/valuation`'s `valueHoldingsForTenant`/
   * `computeCombinedPortfolioReturns`.
   *
   * H2(d) (security review): `holdings` is fetched once and handed to
   * `computeCombinedPortfolioReturns` as `terminalHoldings` — that function's
   * own MWR terminal value needs exactly the same `valueHoldingsForTenant`
   * result this method needs for its response body, so both now use the
   * *same* result instead of each independently triggering their own full
   * `N`-portfolio holdings replay (previously `2N` per request).
   *
   * N5 (security review, connection-pool sizing): `holdings` and
   * `computeCombinedPortfolioReturns` are deliberately awaited **in
   * sequence**, not raced via `Promise.all` (this method's previous shape,
   * back when `holdingsPromise` was still in flight when
   * `computeCombinedPortfolioReturns` started its own fan-out). Racing them
   * meant this one request could hold up to `2 * FAN_OUT_CONCURRENCY`
   * pooled connections at once — `valueHoldingsForTenant`'s own fan-out
   * *and* `computeCombinedPortfolioReturns`'s own, independent
   * `materializePortfolioValuations` fan-out, concurrently — against a pool
   * whose `max` is 10, so the then per-tenant valuation-read cap of 2
   * concurrent reads (H2(a), since retired by ADR-0016) was already enough to threaten
   * exhaustion (2 requests x 8 connections = 16 > 10) for a single tenant
   * alone. Sequencing these two fan-outs bounds this method's own peak at
   * `FAN_OUT_CONCURRENCY` (one fan-out is always fully drained before the
   * next starts) — 2 concurrent requests then peak at `2 *
   * FAN_OUT_CONCURRENCY`, comfortably under the pool's `max`. The added
   * latency is `computeCombinedPortfolioReturns`'s own fan-out duration,
   * which it would have paid anyway even when raced (it already awaits the
   * same `holdings` value internally, via `terminalHoldings`, before it can
   * compute the MWR figure this response needs) — nothing here was actually
   * independent work these two calls needed to overlap.
   */
  @Get("overview")
  async overviewCombined(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<OverviewResponse> {
    const parsed = parseOrThrow(overviewQuerySchema, query);
    const { from, to } = resolveReturnWindow(parsed.from, parsed.to, todayIsoDate());

    try {
      const holdings = await valueHoldingsForTenant(this.db, {
        tenantId: session.tenantId,
        asOfDate: to,
      });
      const returns = await computeCombinedPortfolioReturns(this.db, {
        tenantId: session.tenantId,
        fromDate: from,
        toDate: to,
        terminalHoldings: holdings,
      });
      return toOverviewResponse(holdings, returns);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /**
   * `GET /portfolios/holdings` — the combined tenant-wide holdings listing
   * (added 2026-07-21 by user decision, T-39, AC10): the
   * same instrument held in two portfolios is summed into one line with a
   * correctly weighted PMP (`@kerdial/valuation`'s `valueHoldingsForTenant`),
   * never listed twice.
   */
  @Get("holdings")
  async holdingsCombined(@CurrentSession() session: SessionContext): Promise<HoldingsResponse> {
    try {
      const holdings = await valueHoldingsForTenant(this.db, {
        tenantId: session.tenantId,
        asOfDate: todayIsoDate(),
      });
      return toHoldingsResponse(holdings);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /**
   * `GET /portfolios/closed-positions` — the combined tenant-wide closed
   * positions (FR-321/
   * FR-331): every instrument this tenant now holds **zero** of, merged across
   * portfolios exactly as `holdings` above merges the open ones. An instrument
   * sold out in one portfolio but still open in another is deliberately absent
   * from *this* response and present on `holdings` — the membership rule is
   * evaluated on the merged quantity (CP-4), never per portfolio.
   *
   * FR-332 asked that this route join the existing valuation-read throttle
   * rather than add its own; there is now one instance-wide admission
   * bound for every route, so the requirement is met by construction.
   *
   * **No H2(d)/N5 dedupe-and-sequence treatment, on purpose:** that exists
   * because `overviewCombined`/`overview` each run *two* engines over the same
   * holdings value (`valueHoldings*` for the body plus `computePortfolioReturns`
   * for the MWR terminal value), so there was a duplicate replay to dedupe and
   * two fan-outs to keep from racing. This route runs exactly **one** engine
   * and awaits it to completion — the same single-engine shape `holdings`/
   * `holdingsCombined` already have — so there is nothing to dedupe and nothing
   * to sequence, and peak pooled connections per request stay bounded by
   * `FAN_OUT_CONCURRENCY` rather than twice it.
   */
  @Get("closed-positions")
  async closedPositionsCombined(
    @CurrentSession() session: SessionContext,
  ): Promise<ClosedPositionsResponse> {
    try {
      const closed = await valueClosedPositionsForTenant(this.db, {
        tenantId: session.tenantId,
        asOfDate: todayIsoDate(),
      });
      return toClosedPositionsResponse(closed);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /**
   * `GET /portfolios/value-series?from=&to=` — FR-262 (the wire half of
   * FR-36's chart): the combined tenant-wide daily value
   * series, the union of every portfolio's series summed per date, exactly
   * as the combined TWR consumes it. Same window contract and same
   * valuation-read budget as the performance read — the range this serves
   * is the range that read already materialises.
   */
  @Get("value-series")
  async valueSeriesCombined(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<ValueSeriesResponse> {
    const parsed = parseOrThrow(valueSeriesQuerySchema, query);
    const { from, to } = resolveReturnWindow(parsed.from, parsed.to, todayIsoDate());

    try {
      const series = await computeCombinedPortfolioValueSeries(this.db, {
        tenantId: session.tenantId,
        fromDate: from,
        toDate: to,
      });
      return toValueSeriesResponse(series);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /**
   * `GET /portfolios` (FR-14).
   *
   * Bounded by the instance-wide admission bound (formerly MEDIUM-2's
   * shared per-tenant cheap-read cap).
   */
  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<{ items: PortfolioResponse[]; nextCursor: string | null }> {
    const parsed = parseOrThrow(listPortfoliosQuerySchema, query);
    const offset = decodeOffsetCursor(parsed.cursor);
    const limit = parsePageLimit(parsed.limit);

    // `listPortfolios` already returns every portfolio RLS lets this
    // tenant's session see (AC33) — pagination here windows that array; the
    // tenant scoping itself happens inside the service call, not here.
    const all = await listPortfolios(this.db, session.tenantId);
    const window = all.slice(offset, offset + limit + 1);
    const page = buildCursorPage(window, offset, limit);

    // D8: computed only for the returned page's ids, one
    // grouped aggregate — bounded by page limit, not by the 500-portfolio cap.
    const counts = await countTransactionsByPortfolio(
      this.db,
      session.tenantId,
      page.items.map((row) => row.id),
    );
    return {
      // `row.hasIcon` rides `listPortfolios`' own `leftJoin` (L8, PD-9) — no
      // second, page-bounded query, so FR-481 holds by construction:
      // pagination, the cursor and the `transactionCount` aggregate are
      // untouched and the four new fields are purely additive.
      items: page.items.map((row) =>
        toPortfolioResponse(row, counts.get(row.id) ?? 0, row.hasIcon),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * `POST /portfolios` (FR-14, AC10; `portfolio-details` FR-454/FR-455, L4).
   *
   * D9/OQ-P6 gave `create`/`patch`/`remove` one shared
   * per-tenant write cap; ADR-0016 retired it for the instance-wide admission
   * bound, which spans them just the same.
   *
   * **All four presentation fields are settable here, icon included** (L4).
   * That is the one place this feature departs from `instrument-icons`, whose
   * own LD-5 restricted icon setting to the detail screen: the owner asked for
   * create-time settability explicitly, so the icon travels in *this* body
   * rather than costing a second round trip the user could abandon halfway.
   *
   * **The icon is validated before any database work** (FR-455, AC-404). Order
   * is the requirement, not an optimisation: a rejected icon must leave no
   * portfolio row *and* no icon row, and the cheapest way to guarantee that is
   * for the write never to start. The remaining atomicity — a CHECK or FK
   * failure once the write *has* started — is `createPortfolio`'s single
   * `withTenant` transaction, so nothing here compensates and
   * there is no `catch` that deletes.
   *
   * `hasIcon` is `parsed.icon !== undefined`, known without a read-back: the
   * row was created one statement ago and the caller is the one who said
   * whether it carried an icon.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<PortfolioResponse> {
    const parsed = parseOrThrow(createPortfolioBodySchema, body);

    let icon: PortfolioIconInput | undefined;
    if (parsed.icon !== undefined) {
      const validated = validatePortfolioIconUpload(parsed.icon);
      if (!validated.ok) throw this.#mapIconRejection(validated.code);
      icon = {
        bytes: validated.bytes,
        // The **sniffed** type, never `icon.declaredContentType` (FR-460).
        contentType: validated.contentType,
        widthPx: validated.widthPx,
        heightPx: validated.heightPx,
      };
    }

    try {
      const row = await createPortfolio(this.db, {
        tenantId: session.tenantId,
        name: parsed.name,
        // `?? null` here, **spread-when-present on the `PATCH`** — the
        // asymmetry is the whole of FR-453 and is the opposite of a slip. On
        // create there is no prior state, so "absent" and "explicitly cleared"
        // are the same instruction and `CreatePortfolioParams` says so; on a
        // partial update they are different instructions and collapsing them
        // would clear two columns on every edit of the third.
        broker: parsed.broker ?? null,
        description: parsed.description ?? null,
        accentColor: parsed.accentColor ?? null,
        // `icon` is not nullable — there is nothing to clear on a row being
        // created — so it is spread only when one was supplied.
        ...(icon !== undefined ? { icon } : {}),
      });
      // A freshly created portfolio has no transactions yet — no aggregate
      // query needed for the value every other path computes.
      return toPortfolioResponse(row, 0, icon !== undefined);
    } catch (err) {
      if (err instanceof PortfolioNameAlreadyExistsError) {
        throw problemException(409, {
          title: "Portfolio name already exists",
          code: "PORTFOLIO_NAME_ALREADY_EXISTS",
          detail: err.message,
        });
      }
      // H2 (security review): the per-tenant portfolio-count cap — a
      // machine-readable error, not a raw 500.
      //
      // N6 (security review): 409, not 429. This cap is *permanent*
      // state (this tenant already has `MAX_PORTFOLIOS_PER_TENANT`
      // portfolios), not a rate the client should back off and retry —
      // retrying the identical request, however many times, after however
      // long a wait, never succeeds until an existing portfolio is removed.
      // 429 ("Too Many Requests") wrongly implies the opposite, and this
      // response carried no `Retry-After` either (unlike every genuine rate
      // limit in this codebase, e.g. the valuation-read and transaction-write
      // throttles), which was itself a symptom of 429 being
      // the wrong status here. 409 ("Conflict" — the request conflicts with
      // the current state of the resource, i.e. this tenant's portfolio
      // count) is the honest status; `code` stays the same machine-readable
      // value, unaffected by the status change. `ManualPricePointTenantCapExceededError`'s
      // own 429 treatment (`instruments.controller.ts`) is deliberately left
      // as-is (out of scope here).
      if (err instanceof PortfolioTenantCapExceededError) {
        throw problemException(409, {
          title: "Portfolio limit reached",
          code: "PORTFOLIO_TENANT_CAP_EXCEEDED",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * `PATCH /portfolios/:id` (FR-P2; `portfolio-details`
   * FR-456–FR-459, PD-8) — **genuinely partial** over `name`, `broker`,
   * `description` and `accentColor`, where it used to be a rename with `name`
   * required.
   *
   * **`undefined` ⇒ leave unchanged, `null` ⇒ clear** (FR-453), carried by the
   * JSON itself: a key absent from the body parses to `undefined`, a key
   * present as `null` parses to `null`, and JSON cannot express the former, so
   * the two are unambiguous on the wire. No sentinel string and no
   * `clear: [...]` array — both invent a second vocabulary for a distinction
   * the encoding already makes. `updatePortfolio` then builds its `set` from
   * only the keys that are not `undefined`, so **AC-405 falls out**: a body of
   * exactly `{ name }` issues exactly the write the old rename did and cannot
   * disturb a field the caller never mentioned, icon row included (no statement
   * this request issues names `portfolio_icon` at all).
   *
   * Each field is **spread when present** rather than passed as
   * `parsed.field ?? null` — `updateClassification`'s own rule, one route over,
   * and the thing that keeps `null` (clear) distinguishable from absent (leave
   * alone) all the way from the JSON to the `set` clause. A whole-object spread
   * of `parsed` would be shorter and is refused for a second reason too:
   * `exactOptionalPropertyTypes` makes an explicitly-`undefined` optional a
   * type error, which is the compiler saying the same thing.
   *
   * **Or exactly `{ archived }`** (`portfolio-archive` FR-592):
   * `patchPortfolioBodySchema` is a union of the strict archive body and the
   * strict presentation body, so a body mixing the two is a `400` (AC-476).
   * The archive branch calls `setPortfolioArchived` — a display-only flag, no
   * `calc_epoch` bump (FR-594) — and answers `200` in both directions,
   * no-ops included (AC-475).
   *
   * An unknown key never reaches any of this: both union branches are a
   * `z.strictObject`, so `{"descrption": "…"}` is a `400` rather than a `200`
   * that changed nothing.
   *
   * An empty body is a `400 VALIDATION_ERROR` from the schema's own refine
   * (FR-457), which is what makes `updatePortfolio`'s "every field
   * `undefined`" `TypeError` unreachable over HTTP rather than merely unlikely.
   *
   * **No `calc_epoch` bump and no invalidation** (FR-459, NG5, PD-14): all four
   * fields are presentation, exactly as `name` already was.
   */
  @Patch(":id")
  async patch(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<PortfolioResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(patchPortfolioBodySchema, body);

    try {
      const row =
        "archived" in parsed
          ? await setPortfolioArchived(this.db, {
              tenantId: session.tenantId,
              portfolioId: id,
              archived: parsed.archived,
            })
          : await updatePortfolio(this.db, {
              tenantId: session.tenantId,
              portfolioId: id,
              // Spread-when-present, never `?? null` —
              // `updateClassification`'s own rule, and the reason is the same one
              // FR-453 states: `null` and absent mean different things here (clear
              // vs. leave alone), and collapsing them would silently clear the other
              // three columns on every edit of one.
              ...(parsed.name !== undefined ? { name: parsed.name } : {}),
              ...(parsed.broker !== undefined ? { broker: parsed.broker } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description } : {}),
              ...(parsed.accentColor !== undefined ? { accentColor: parsed.accentColor } : {}),
            });
      if (!row) {
        throw problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
      }
      const counts = await countTransactionsByPortfolio(this.db, session.tenantId, [row.id]);
      return toPortfolioResponse(row, counts.get(row.id) ?? 0, row.hasIcon);
    } catch (err) {
      if (err instanceof PortfolioNameAlreadyExistsError) {
        throw problemException(409, {
          title: "Portfolio name already exists",
          code: "PORTFOLIO_NAME_ALREADY_EXISTS",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * `DELETE /portfolios/:id` (FR-P3). Hard-deletes the
   * portfolio and every row it owns (the locked full-cascade decision,
   * `deletePortfolio`, `@kerdial/ledger`) — no response body (204), matching
   * `DELETE /transactions/:id`'s own convention.
   */
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<void> {
    const id = parseIdParam(rawId);
    try {
      const result = await deletePortfolio(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        deletedBy: session.userId,
      });
      if (!result.deleted) {
        throw problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
      }
    } catch (err) {
      if (err instanceof PortfolioDeleteBlockedByLinkedTransactionError) {
        throw problemException(409, {
          title: "Cannot delete: a linked transaction in another portfolio depends on this one",
          code: "PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * `PUT /portfolios/:id/icon` — set **or** replace this tenant's uploaded icon
   * for one of its portfolios (L2, L7,
   * FR-460, FR-461, FR-466, NFR-55).
   *
   * **One route for set and replace, `200` for both**, for the reason the
   * storage says it structurally: `portfolio_icon`'s primary key is
   * `(tenant_id, portfolio_id)` and `setPortfolioIcon` is a single `INSERT …
   * ON CONFLICT DO UPDATE`, so a set on an already-iconed portfolio *is* a
   * replace and not a second row. A status that varied with prior state would
   * add a branch nothing consumes.
   *
   * **The bytes arrive base64-encoded inside an ordinary `application/json`
   * body**, exactly as `PUT /instruments/:id/icon` does, and for the same
   * recorded reason (RC6/V10): registering a content-type parser for an image
   * media type would widen the request-parsing surface of **every** route on
   * this API. So this route adds no entry to `IMPORT_MULTIPART_PATHS`,
   * registers no parser, and inherits the existing `bodyLimit`, the session
   * guard, the CSRF guard and `problem+json` unchanged. The arithmetic that
   * makes it fit is `instrument-icons`' own, unchanged because the numbers are:
   * 262 144 bytes ⇒ 349 528 base64 characters ⇒ ~342 KiB of worst legitimate
   * body, 33 % of `REQUEST_BODY_LIMIT_BYTES`.
   *
   * **There is deliberately no `#requirePortfolio` pre-probe** (PD-7), and its
   * absence is the fix rather than an omission. `setPortfolioIcon` takes the
   * `portfolio` row `FOR UPDATE` as its first statement, which is *both* the
   * existence probe and the race fix: a probe that is not a lock leaves a
   * window in which a concurrent `deletePortfolio` commits between the check
   * and the insert, and the insert then violates the FK with a `23503` that is
   * not in `CLIENT_CAUSED_FK_CONSTRAINTS` and surfaces as a **500** on an
   * ordinary user action. Adding a probe here would re-open
   * exactly that window at the cost of an extra statement.
   *
   * The `404` reuses the **existing** `PORTFOLIO_NOT_FOUND` code and message —
   * `PATCH`/`DELETE /portfolios/:id`'s own — rather than minting an
   * icon-write-specific one: from the client's side it is the same fact.
   *
   * No route-level throttle: every route on this API sits behind the one
   * instance-wide admission bound, so there is no interceptor to join
   * and no list to append to (FR-480).
   */
  @Put(":id/icon")
  async putIcon(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<PortfolioIconMetaResponse> {
    const id = parseIdParam(rawId);
    const validated = validatePortfolioIconUpload(body);
    if (!validated.ok) throw this.#mapIconRejection(validated.code);

    try {
      const meta = await setPortfolioIcon(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        bytes: validated.bytes,
        // The **sniffed** type, never `body.declaredContentType` (FR-460).
        contentType: validated.contentType,
        widthPx: validated.widthPx,
        heightPx: validated.heightPx,
        // There is deliberately no `source` here, and no field to put one in:
        // `PortfolioIconInput` cannot express it and the table has no such
        // column (FR-462/SD-2).
      });
      return toPortfolioIconMetaResponse(meta);
    } catch (err) {
      if (err instanceof PortfolioIconPortfolioNotFoundError) {
        throw problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
      }
      throw err;
    }
  }

  /**
   * `DELETE /portfolios/:id/icon` — remove this tenant's icon, returning the
   * portfolio to its wallet fallback (FR-461).
   *
   * **`204` whether or not a row existed, and whether or not the portfolio
   * exists.** The TOCTOU is one this capability itself creates: two tabs, or a
   * double-click, would otherwise make the second attempt an error for having
   * succeeded. The rejected alternative — `404` when absent — is not an
   * existence oracle (RLS scopes the statement to the caller's own tenant, so a
   * zero-row delete reveals only the caller's own state); it is rejected on the
   * idempotence argument alone. `apiFetch` already maps `204` to `undefined`,
   * so the client needs nothing new.
   *
   * No probe first, for the same reason `removePortfolioIcon` takes no lock: a
   * `DELETE` cannot violate a foreign key, so there is no failure for one to
   * prevent, and a probe would cost a statement to produce a `404` this route
   * has just declined to emit.
   */
  @Delete(":id/icon")
  @HttpCode(204)
  async removeIcon(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<void> {
    const id = parseIdParam(rawId);
    await removePortfolioIcon(this.db, { tenantId: session.tenantId, portfolioId: id });
  }

  /**
   * `GET /portfolios/:id/icon` — this tenant's stored icon bytes
   * (FR-463, FR-466, SD-5). **The second route
   * on this API whose `200` body is not JSON**, and it reaches the wire the way
   * `getIcon` already proves in production.
   *
   * **`@Res({ passthrough: true })` is load-bearing, not cosmetic.** It keeps
   * Nest's pipeline in charge while the handler still *returns* the bytes:
   * Nest's Fastify adapter hands a returned value to `reply.send(…)`, and
   * Fastify passes a `Buffer` through as-is, choosing a content type only when
   * none is already set — which is why the three headers are set *before* the
   * return. Take Nest out of the response path with a bare `@Res()` and the
   * admission bound never runs its `finalize`, leaking one in-flight slot per
   * request until the cap wedges shut. The claim is asserted behaviourally in
   * `portfolios.e2e.test.ts` — byte-identity of the body and the exact headers,
   * never "a decorator is present".
   *
   * **`content-disposition: attachment`, with no `filename` parameter, ever**
   * (FR-466, NFR-55(b)): it makes a direct navigation to this URL a download
   * rather than a rendered document, and has no effect on an `<img>`
   * subresource load. No filename is emitted because none is stored — the
   * request body has no such field. Nothing client-supplied reaches a header
   * here: `content-type` is the **stored** enum column (the sniffed verdict,
   * never the declared one) and `content-length` is the bytes' own length.
   *
   * **`Cache-Control: no-store` is inherited, not set here.**
   * `security-headers.ts`'s `cacheControlForPath` returns it for everything
   * under `api/v1`, first and unconditionally (FR-6/AC-5), and `buildApp`'s
   * global `onSend` applies it; `web/vite.config.ts` already makes every
   * `/api/v1/**` request `NetworkOnly`. So no header rule and no route prefix
   * change here, and there is no stored copy to be stale. What `no-store` does
   * **not** reach is a bitmap already decoded into a mounted `<img>` — that is
   * `PortfolioIconTile`'s `iconVersion` (PD-T10), the one part of the
   * instrument-icon design that was wrong before GATE-3 corrected it.
   *
   * **`portfolio` is never read**, and this deliberately does *not* inherit
   * `getIcon`'s existence-oracle reasoning. There, "no such instrument" and
   * "nobody has iconed it" must be one code path because instruments are shared
   * catalogue rows; here the portfolio is the caller's own and FR-463/SD-5 asks
   * for no such guarantee. The probe is omitted because it would cost a
   * statement to produce a `404` this primary-key lookup already produces, and
   * would open a TOCTOU between the two.
   */
  @Get(":id/icon")
  async getIcon(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const id = parseIdParam(rawId);

    const icon = await getPortfolioIcon(this.db, {
      tenantId: session.tenantId,
      portfolioId: id,
    });
    if (icon === null) {
      throw problemException(404, {
        title: "Icon not found",
        code: "PORTFOLIO_ICON_NOT_FOUND",
      });
    }

    void reply
      .header("content-type", icon.contentType)
      .header("content-length", String(icon.bytes.byteLength))
      .header("content-disposition", "attachment");
    return icon.bytes;
  }

  /**
   * `portfolio-icon.validate.ts`'s rejection code → `problem+json`, the status
   * table the portfolio-details feature defines.
   *
   * **The statuses are `instruments.controller.ts`'s `#mapIconRejection`'s,
   * code for code**, because L2 asks a portfolio icon to obey the same rules
   * and the same numbers as an instrument icon and a client cannot be told the
   * rules are the same while the answers differ. `422`, not `415`, for the four
   * payload verdicts: the *request's* media type is `application/json` and is
   * supported, so `415` would be wrong in the way finding N6 is explicit about
   * elsewhere in this file. `413` for the byte ceiling matches
   * RFC 9110 §15.5.14.
   *
   * **Every title and detail below is a static literal**, and the French copy
   * the user actually sees is `web/src/lib/problem-messages.ts`'s — which
   * points the six `PORTFOLIO_ICON_*` keys at the *same message objects* the
   * six `INSTRUMENT_ICON_*` keys already use (PD-T9), since those strings were
   * written entity-neutral. Nothing the uploader supplied is reflected here: no
   * filename (the body has no such field), no declared content type, no byte
   * length, no payload prefix — FR-466/NFR-55(b) held at the one place a
   * client-supplied string could otherwise reach a response.
   *
   * Nothing here reaches `ProblemJsonExceptionFilter`'s generic 500 — that is
   * the point of enumerating them.
   */
  #mapIconRejection(code: PortfolioIconRejectionCode): unknown {
    switch (code) {
      case "PORTFOLIO_ICON_MALFORMED_BASE64":
        return problemException(400, {
          title: "The icon payload is not valid base64",
          code,
          detail: "the icon bytes must be standard base64 with no whitespace and no base64url",
        });
      case "PORTFOLIO_ICON_TOO_LARGE":
        return problemException(413, {
          title: "The icon is too large",
          code,
          detail: "the icon exceeds the maximum stored size",
        });
      case "PORTFOLIO_ICON_UNSUPPORTED_FORMAT":
        return problemException(422, {
          title: "The icon format is not supported",
          code,
          detail: "the leading bytes are not one of the accepted image signatures",
        });
      case "PORTFOLIO_ICON_UNREADABLE":
        return problemException(422, {
          title: "The icon header could not be read",
          code,
          detail: "the image signature was recognised but its header could not be read",
        });
      case "PORTFOLIO_ICON_TYPE_MISMATCH":
        return problemException(422, {
          title: "The declared type does not match the icon bytes",
          code,
          detail: "the declared content type disagrees with the image's own leading bytes",
        });
      case "PORTFOLIO_ICON_DIMENSIONS_EXCEEDED":
        return problemException(422, {
          title: "The icon is too large in pixels",
          code,
          detail: "the image exceeds the maximum accepted pixel dimensions",
        });
    }
  }

  /** Shared by every `:id`-scoped T-39 route: 404 when this tenant has no such portfolio (AC33: another tenant's row is invisible, not merely forbidden — the same `getPortfolio` every other controller already uses for this check). */
  async #requirePortfolio(id: string, tenantId: string): Promise<void> {
    const row = await getPortfolio(this.db, tenantId, id);
    if (!row) {
      throw problemException(404, { title: "Portfolio not found", code: "PORTFOLIO_NOT_FOUND" });
    }
  }

  /**
   * `core/domain`'s `valuePortfolio` fails loud (`UnresolvablePriceError`/
   * `UnresolvableRateError`) rather than silently mispricing a holding with
   * no price/FX rate published on or before the valuation date — mapped
   * here to a 422, the same "well-formed request, not currently
   * expressible" semantics `TransactionsController` already uses for
   * `FxRateUnavailableError`/`CryptoRateUnavailableError`, never a raw 500.
   *
   * Async only for the price arm, which reads what it needs to name the
   * holding (`#priceUnavailableProblem`).
   */
  async #mapValuationError(err: unknown, tenantId: string): Promise<unknown> {
    if (err instanceof UnresolvablePriceError) {
      return this.#priceUnavailableProblem(err, tenantId);
    }
    if (err instanceof UnresolvableRateError) {
      return problemException(422, {
        title: "Cannot value a holding: no FX rate available",
        code: "VALUATION_FX_RATE_UNAVAILABLE",
        detail: err.message,
        // Which pair, and for which date. Both are already on the error and
        // both are meaningful to a person; `detail` carries the same facts but
        // in English prose with a spec citation in it, which is not something
        // to render in a French UI.
        params: {
          currency: err.currency,
          valuationDate: err.valuationDate,
        },
      });
    }
    // L6 (security review): rejected, not silently truncated — see
    // `@kerdial/valuation`'s `assertWithinResponseCaps`.
    //
    // N6 (security review): 422, not 413. Per RFC 9110 §15.5.14, 413
    // ("Content Too Large") describes a *request* payload the server refuses
    // to process — this is a *response* the server refuses to send in full,
    // the inverse direction; a client (correctly) reading 413 by its RFC
    // meaning would look for an oversized request body to shrink, which does
    // not exist here (this is a `GET`). 422 ("Unprocessable Content") is the
    // same "well-formed request, not currently expressible/servable"
    // semantics this method already uses above for
    // `UnresolvablePriceError`/`UnresolvableRateError` — this response is
    // just another reason this specific request cannot be honoured as asked.
    if (err instanceof TooManyHoldingsError || err instanceof TooManyRealizedGainsError) {
      return problemException(422, {
        title: "Holdings response too large",
        code: "VALUATION_RESPONSE_TOO_LARGE",
        detail: err.message,
      });
    }
    // `closed-positions` CP-5 (FR-333/AC-326): **one** problem
    // code for both cap errors, mirroring the arm immediately above, which has
    // mapped `TooManyHoldingsError`/`TooManyRealizedGainsError` to a single
    // code since it was written — the two are distinguished by `detail`, which
    // names the offending instrument for the per-position sale-lot cap. What
    // AC-326 actually needs is a code distinct from the *holdings* one, since
    // that is the distinction a client can act on (« trop de positions
    // clôturées » rather than « trop de positions »).
    //
    // 422, not 413, for N6's reason recorded above: a response the server
    // refuses to send in full, not an oversized request. Rejected, never
    // truncated — `assertWithinClosedPositionCaps` throws before any response
    // object exists, so there is no partial array for this arm to leak.
    if (err instanceof TooManyClosedPositionsError || err instanceof TooManySaleLotsError) {
      return problemException(422, {
        title: "Closed-positions response too large",
        code: "CLOSED_POSITIONS_RESPONSE_TOO_LARGE",
        detail: err.message,
      });
    }
    return err;
  }

  /**
   * Every route this controller maps is a **portfolio-level**
   * read, valuing every holding at once, so « no price on 09/11/2019 » alone
   * left the reader to guess which of their positions it meant. The 422 now
   * names it: symbol and name, where its price history begins, and — when the
   * ledger holds it — the acquisition price the client may offer to write as a
   * manual point (`@kerdial/api-contracts`' `valuation-price-gap.ts` for the
   * shape and the owner decisions D1/D2 it records). The read itself still
   * fails whole.
   *
   * `instrumentId` travels as a structured member: the client links the fiche
   * and posts the price with it. `detail` names the symbol and carries no
   * UUID — `err.message` does, which is why it is no longer forwarded.
   */
  async #priceUnavailableProblem(err: UnresolvablePriceError, tenantId: string): Promise<unknown> {
    const title = "Cannot value a holding: no price available";
    // The description is a courtesy on top of the 422, never a second way to
    // fail: a lookup error degrades to the bare payload rather than a 500.
    const gap = await describePriceGap(this.db, {
      tenantId,
      instrumentId: err.instrumentId,
      valuationDate: err.valuationDate,
    }).catch(() => undefined);
    if (gap === undefined) {
      return problemException(422, {
        title,
        code: "VALUATION_PRICE_UNAVAILABLE",
        detail: `no manual or automated price published on or before ${err.valuationDate}`,
        params: { valuationDate: err.valuationDate },
      });
    }

    const params: ValuationPriceGapParams = {
      valuationDate: err.valuationDate,
      instrumentId: err.instrumentId,
      instrumentName: gap.displayName,
      ...(gap.symbol !== null ? { symbol: gap.symbol } : {}),
      ...(gap.firstPriceDate !== null ? { firstPriceDate: gap.firstPriceDate } : {}),
    };
    const firstPrice =
      gap.firstPriceDate !== null ? ` (its first price is on ${gap.firstPriceDate})` : "";
    return problemException(422, {
      title,
      code: "VALUATION_PRICE_UNAVAILABLE",
      detail:
        `Cannot value ${gap.symbol ?? gap.displayName} on ${err.valuationDate}: no manual or ` +
        `automated price published on or before that date${firstPrice}.`,
      params: { ...params },
      ...(gap.suggestedPrice !== null ? { suggestedPrice: gap.suggestedPrice } : {}),
    });
  }

  /**
   * `GET /portfolios/:id/overview?from=&to=` (FR-33, FR-34, AC24).
   *
   * H2(d) (security review): same dedupe as `overviewCombined` — `holdings`
   * is fetched once and shared with `computePortfolioReturns`'s
   * `terminalHoldings`, so this request replays this portfolio's holdings
   * once, not twice.
   *
   * Finding 5 (security review, N2's exact bug, one route over) —
   * `holdings` and `computePortfolioReturns` used to be raced via
   * `Promise.all([holdingsPromise, computePortfolioReturns({terminalHoldings:
   * holdingsPromise})])`: if `computePortfolioReturns` rejected while
   * `valueHoldingsAsOf` was still in flight, `Promise.all` rejected
   * immediately, the read throttle's `finalize` (today the admission bound's)
   * freed this request's slot right then, and the caller moved on — while the
   * still-running `holdingsPromise` kept its own `withTenant` transaction
   * and pooled connection open in the background, uncounted, for however
   * much longer it took to settle. `overviewCombined` above already avoids
   * this (N5, sequenced, not raced) for the tenant-wide route; this method
   * simply never got the same fix when it was written. The fix here is the
   * same shape N2 itself already established for `mapWithConcurrency`
   * (`@kerdial/valuation`'s `concurrency.ts`): await `holdings` to
   * completion *first*, then pass the already-resolved value (not a
   * still-in-flight promise) to `computePortfolioReturns` — nothing here is
   * independent work that benefits from overlapping (`computePortfolioReturns`
   * already awaits the same holdings value internally via `terminalHoldings`
   * before it can produce a result), so sequencing costs no real latency,
   * only removes the early-release race. See
   * `portfolios-overview.e2e.test.ts`'s "finding 5" describe for the
   * behavioral proof.
   */
  @Get(":id/overview")
  async overview(
    @Param("id") rawId: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<OverviewResponse> {
    const id = parseIdParam(rawId);
    await this.#requirePortfolio(id, session.tenantId);
    const parsed = parseOrThrow(overviewQuerySchema, query);
    const { from, to } = resolveReturnWindow(parsed.from, parsed.to, todayIsoDate());

    try {
      const holdings = await valueHoldingsAsOf(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        asOfDate: to,
      });
      const returns = await computePortfolioReturns(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        fromDate: from,
        toDate: to,
        terminalHoldings: holdings,
      });
      return toOverviewResponse(holdings, returns);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /** `GET /portfolios/:id/holdings` (FR-35, AC25). */
  @Get(":id/holdings")
  async holdings(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<HoldingsResponse> {
    const id = parseIdParam(rawId);
    await this.#requirePortfolio(id, session.tenantId);

    try {
      const holdings = await valueHoldingsAsOf(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        asOfDate: todayIsoDate(),
      });
      return toHoldingsResponse(holdings);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /**
   * `GET /portfolios/:id/closed-positions` — one portfolio's closed positions
   * (FR-321/FR-331). See
   * `closedPositionsCombined` above for the throttle-join and the
   * one-engine-per-request reason neither method carries the H2(d)/N5
   * dedupe-and-sequence treatment.
   *
   * `#requirePortfolio` first, exactly as `holdings` above: another tenant's
   * portfolio id is a 404, invisible rather than merely forbidden (AC33).
   *
   * OD-1: this route ships with API/e2e coverage and no screen — UR-41
   * locks the web surface to the tenant-wide read — the same relationship
   * `GET /portfolios/:id/value-series` already has. Stated so it is not read as
   * a gap.
   */
  @Get(":id/closed-positions")
  async closedPositions(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<ClosedPositionsResponse> {
    const id = parseIdParam(rawId);
    await this.#requirePortfolio(id, session.tenantId);

    try {
      const closed = await valueClosedPositionsAsOf(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        asOfDate: todayIsoDate(),
      });
      return toClosedPositionsResponse(closed);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /** `GET /portfolios/:id/performance?from=&to=` (FR-25, FR-26, FR-30, FR-33). */
  @Get(":id/performance")
  async performance(
    @Param("id") rawId: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<PerformanceResponse> {
    const id = parseIdParam(rawId);
    await this.#requirePortfolio(id, session.tenantId);
    const parsed = parseOrThrow(performanceQuerySchema, query);
    const { from, to } = resolveReturnWindow(parsed.from, parsed.to, todayIsoDate());

    try {
      const returns = await computePortfolioReturns(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        fromDate: from,
        toDate: to,
      });
      return toPerformanceResponse(returns);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }

  /** `GET /portfolios/:id/value-series?from=&to=` — FR-262's per-portfolio half; see the combined route above for the contract. */
  @Get(":id/value-series")
  async valueSeries(
    @Param("id") rawId: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<ValueSeriesResponse> {
    const id = parseIdParam(rawId);
    await this.#requirePortfolio(id, session.tenantId);
    const parsed = parseOrThrow(valueSeriesQuerySchema, query);
    const { from, to } = resolveReturnWindow(parsed.from, parsed.to, todayIsoDate());

    try {
      const series = await computePortfolioValueSeries(this.db, {
        tenantId: session.tenantId,
        portfolioId: id,
        fromDate: from,
        toDate: to,
      });
      return toValueSeriesResponse(series);
    } catch (err) {
      throw await this.#mapValuationError(err, session.tenantId);
    }
  }
}
