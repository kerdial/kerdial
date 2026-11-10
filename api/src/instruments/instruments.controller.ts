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
  Put,
  Query,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  ProviderCircuitOpenError,
  providerKeyForBackfill,
  providerKeyForDiscovery,
  type MarketRuntime,
} from "@kerdial/market-composition";
import {
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  type ProviderSymbolMatch,
} from "@kerdial/market-ports";
import type { Db } from "@kerdial/platform-db";
import {
  InstrumentAlreadyExistsError,
  InstrumentAttributesNotApplicableError,
  InstrumentFigiAlreadySetError,
  InstrumentIconBoundsError,
  InstrumentIconTenantCapExceededError,
  InstrumentNotFoundError,
  ManualPricePointScaleExceededError,
  ManualPricePointTenantCapExceededError,
  createInstrumentByIsin,
  createInstrumentBySymbol,
  createInstrumentScpi,
  getInstrumentBackfillStatus,
  getInstrumentPriceFreshness,
  getInstrumentBackfillTarget,
  getInstrumentById,
  getInstrumentIcon,
  listInstrumentIdsWithIcon,
  listInstrumentPriceHistory,
  listInstruments,
  removeInstrumentIcon,
  setInstrumentIcon,
  updateInstrumentClassification,
  updateInstrumentIdentity,
  updateInstrumentScpiAttributes,
  upsertManualPricePoint,
  type InstrumentIconBoundsViolation,
  type InstrumentKind,
  deleteInstrument,
  InstrumentDeleteBlockedError,
} from "@kerdial/ledger";
import { rootLogger } from "@kerdial/platform-logging";
import { DB } from "../db/db.tokens.js";
import { discoveryRateThrottleInterceptor } from "./discovery-throttle.interceptor.js";
import { MARKET_RUNTIME } from "../market/market-runtime.tokens.js";
import { problemException } from "../common/problem.js";
import { parseOrThrow } from "../common/zod-validate.js";
import { parseIdParam } from "../common/id-param.schema.js";
import { buildCursorPage, decodeOffsetCursor, parsePageLimit } from "../common/pagination.js";
import { CurrentSession } from "../auth/current-session.decorator.js";
import type { SessionContext } from "@kerdial/platform-auth";
import {
  createInstrumentBodySchema,
  createManualPriceBodySchema,
  listInstrumentPricesQuerySchema,
  listInstrumentsQuerySchema,
  resolvePriceHistoryWindow,
  toInstrumentIconMetaResponse,
  toInstrumentResponse,
  updateInstrumentClassificationBodySchema,
  updateInstrumentIdentityBodySchema,
  updateInstrumentScpiAttributesBodySchema,
  toPriceHistoryPointResponse,
  toHistoryStatusResponse,
  type InstrumentIconMetaResponse,
  type InstrumentResponse,
  type PriceHistoryPointResponse,
  type HistoryStatusResponse,
} from "./instruments.schema.js";
import {
  validateInstrumentIconUpload,
  type InstrumentIconRejectionCode,
} from "./instrument-icon.validate.js";
import {
  discoveryQuerySchema,
  toDiscoveryCandidateResponse,
  DISCOVERY_RESPONSE_MAX_ITEMS,
  type DiscoveryCandidateResponse,
} from "./discovery.schema.js";

/**
 * `setInstrumentIcon`'s three re-asserted bounds → this feature's own
 * rejection codes (a GATE-2 finding). One arm each, no
 * fallthrough: `BYTE_LENGTH` is SD-2's byte ceiling (`413`), `DIMENSIONS` is
 * SD-3's pixel ceiling (`422`), and `CONTENT_TYPE` is SD-1's closed format set
 * (`422`) — the same three answers `instrument-icon.validate.ts` gives for the
 * same three facts, so a caller cannot tell which layer refused it, which is
 * the point.
 *
 * A module-level function rather than a `static #private` on the controller:
 * `@Controller()` is a class decorator and TypeScript refuses static private
 * identifiers on a decorated class (TS18036).
 */
function iconRejectionCodeForBoundsViolation(
  violation: InstrumentIconBoundsViolation,
): InstrumentIconRejectionCode {
  switch (violation) {
    case "BYTE_LENGTH":
      return "INSTRUMENT_ICON_TOO_LARGE";
    case "DIMENSIONS":
      return "INSTRUMENT_ICON_DIMENSIONS_EXCEEDED";
    case "CONTENT_TYPE":
      return "INSTRUMENT_ICON_UNSUPPORTED_FORMAT";
  }
}

/**
 * `/instruments/*` — T-37. Thin
 * controllers over T-11's identity service, T-11's own read extension
 * (`listInstruments`/`getInstrumentById` — see
 * `ledger/src/instrument-service.ts`'s doc comments), and T-36's manual price
 * service. No business logic here: every decision (dedupe, quote-policy
 * default, price precedence) lives in `@kerdial/ledger`.
 */
@Controller("instruments")
export class InstrumentsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MARKET_RUNTIME) private readonly marketRuntime: MarketRuntime | null,
  ) {}

  /**
   * `GET /instruments?query=&kind=&cursor=&limit=` (FR-1..FR-4 search + resolve).
   *
   * Bounded by the instance-wide admission bound (formerly MEDIUM-2's
   * shared per-tenant cheap-read cap).
   */
  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<{ items: InstrumentResponse[]; nextCursor: string | null }> {
    const parsed = parseOrThrow(listInstrumentsQuerySchema, query);
    const offset = decodeOffsetCursor(parsed.cursor);
    const limit = parsePageLimit(parsed.limit);

    const rows = await listInstruments(this.db, {
      ...(parsed.query !== undefined ? { query: parsed.query } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      limit: limit + 1,
      offset,
    });

    const page = buildCursorPage(rows, offset, limit);
    // IK-10: **one** bounded, tenant-scoped lookup for the whole
    // page, not one per row — `listInstrumentIdsWithIcon` issues a single
    // `instrument_id in (…)` over `instrument_icon`'s primary key, bounded by
    // `MAX_PAGE_LIMIT` (100), and returns an empty set with **no** statement
    // at all for an empty page. `listInstruments` is not tenant-scoped
    // (`instrument` carries no `tenant_id`), and threading `tenantId` through
    // it would touch six call sites, four with no icon interest — so the
    // per-request cost lands here instead. `instruments-icon-presence-
    // statement-count.integration.test.ts` measures that it is one statement
    // for a page of 100 rather than reading this comment.
    const iconed = await listInstrumentIdsWithIcon(this.db, {
      tenantId: session.tenantId,
      instrumentIds: page.items.map((row) => row.id),
    });
    return {
      // Never `.map(toInstrumentResponse)`: the flag is a second parameter, so
      // a bare reference would hand the array index in as `hasIcon` — which
      // the required parameter turns into a compile error rather than a page
      // whose first row is the only un-iconed one.
      items: page.items.map((row) => toInstrumentResponse(row, iconed.has(row.id))),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * `POST /instruments` (FR-1, AC1, AC2). Routes to the ISIN-based or
   * symbol-based creation path based on `kind`; either service call throws
   * {@link InstrumentAlreadyExistsError} for a duplicate, translated here to
   * a 409 `problem+json` with a machine-readable `code` — never a raw 500
   * (AC1).
   *
   * DD17. Locked
   * decision D6 gave this route a per-tenant 30/hour rate cap stacked with a
   * per-tenant concurrency cap of 2. Both were retired by ADR-0016
   * (ADR-0016): the instance-wide admission bound is the only concurrency
   * control now, and a household does not need a creation rate cap (the
   * provider backfill it triggers is idempotent per instrument; a concurrency
   * cap alone is never exceeded by
   * *sequential* requests).
   */
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown): Promise<InstrumentResponse> {
    const parsed = parseOrThrow(createInstrumentBodySchema, body);

    let row;
    try {
      row =
        // `scpi` cycle (SCD-5): the SCPI branch of the union —
        // no MIC, ISIN and/or code, `MANUAL_ONLY` set by the service. The
        // schema's strict branch has already refused anything else.
        parsed.kind === "SCPI"
          ? await createInstrumentScpi(this.db, {
              ...(parsed.isin !== undefined ? { isin: parsed.isin } : {}),
              ...(parsed.symbol !== undefined ? { symbol: parsed.symbol } : {}),
              listingCurrency: parsed.listingCurrency,
              displayName: parsed.displayName,
              ...(parsed.figi !== undefined ? { figi: parsed.figi } : {}),
              // FR-611 (SC-T4): both optional; the fee is already a `Decimal`.
              ...(parsed.managementCompany !== undefined
                ? { managementCompany: parsed.managementCompany }
                : {}),
              ...(parsed.subscriptionFeePct !== undefined
                ? { subscriptionFeePct: parsed.subscriptionFeePct }
                : {}),
            })
          : parsed.kind === "CRYPTO" || parsed.kind === "INDEX"
            ? await createInstrumentBySymbol(this.db, {
                kind: parsed.kind,
                // `parseOrThrow`'s superRefine already guarantees `symbol` is
                // present for this branch (AC2) — the `!` documents that
                // invariant rather than re-checking it.
                symbol: parsed.symbol!,
                listingCurrency: parsed.listingCurrency,
                displayName: parsed.displayName,
                ...(parsed.figi !== undefined ? { figi: parsed.figi } : {}),
              })
            : await createInstrumentByIsin(this.db, {
                kind: parsed.kind,
                isin: parsed.isin!,
                exchangeMic: parsed.exchangeMic!,
                listingCurrency: parsed.listingCurrency,
                displayName: parsed.displayName,
                ...(parsed.symbol !== undefined ? { symbol: parsed.symbol } : {}),
                ...(parsed.figi !== undefined ? { figi: parsed.figi } : {}),
                // IR-10 — carried into the same single `INSERT … RETURNING`.
                // `createInstrumentBodySchema`'s own `superRefine` has already
                // rejected either field for a non-SHARE `kind` (FR-7), so no
                // second kind check is needed (or wanted — two would drift).
                ...(parsed.sectorCode !== undefined ? { sectorCode: parsed.sectorCode } : {}),
                ...(parsed.industryLabel !== undefined
                  ? { industryLabel: parsed.industryLabel }
                  : {}),
              });
    } catch (err) {
      if (err instanceof InstrumentAlreadyExistsError) {
        const code =
          err.conflict === "ISIN_EXCHANGE_MIC"
            ? "INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC"
            : err.conflict === "CRYPTO_SYMBOL"
              ? "INSTRUMENT_DUPLICATE_CRYPTO_SYMBOL"
              : // F1(c) (security review, T-37): the same
                // machine-readable-duplicate treatment as AC1/the crypto case,
                // for a duplicate non-CRYPTO symbol-identified instrument
                // (INDEX today).
                "INSTRUMENT_DUPLICATE_SYMBOL";
        throw problemException(409, {
          title: "Instrument already exists",
          code,
          detail: err.message,
        });
      }
      throw err;
    }

    // DD13 — **after**
    // the insert above has committed, never inside its own `try`: a 409
    // (duplicate) never reaches this line at all (the `catch` above already
    // returned/threw), and a failure here must never be mistaken for the
    // creation itself having failed (see `#triggerInstrumentBackfill`'s own
    // doc comment).
    await this.#triggerInstrumentBackfill(row.id, row.kind);

    // IK-10: the literal `false`, and no lookup — an instrument inserted a
    // moment ago cannot already carry this tenant's icon, so a query here
    // would spend a statement to learn a known answer.
    return toInstrumentResponse(row, false);
  }

  /**
   * DD13 — best-effort,
   * mirroring `TransactionWriteService#triggerInstrumentBackfill`'s existing
   * shape verbatim (`ledger/src/transaction-write-service.ts`): logged and
   * swallowed, never thrown, so a caller retrying a 5xx can never risk a
   * duplicate instrument, and a provider/queue outage never turns a
   * successful `201` into a 500. No-op when `MARKET_RUNTIME` is `null`
   * (DD4 — creation succeeds regardless of provider/queue state)
   * or when `kind` has no backfill route (`providerKeyForBackfill` returns
   * `undefined` — `SCPI`, by design (`scpi` cycle, SC-L10); FUND (ADR-0018) and
   * INDEX have since left this set; `market/composition`'s `routing.ts` — checked
   * here, not by catching `ensureInstrumentBackfillRequested`'s own
   * `TypeError` for an unbackfillable kind, so such a creation never even
   * attempts an enqueue).
   */
  async #triggerInstrumentBackfill(instrumentId: string, kind: InstrumentKind): Promise<void> {
    if (this.marketRuntime === null) return;
    if (providerKeyForBackfill(kind) === undefined) return;

    try {
      await this.marketRuntime.enqueueBackfill(this.db, { instrumentId, kind });
    } catch (err) {
      rootLogger().error(
        "InstrumentsController#triggerInstrumentBackfill: best-effort backfill trigger failed — swallowed; reconcilePendingInstrumentBackfills is the recovery path.",
        {
          component: "api",
          instrument_id: instrumentId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  /**
   * `GET /instruments/discovery?kind=&query=` — DD6. Session-authenticated
   * like every other route (global `AuthGuard`, no `@Public()` — the AC32
   * unauthenticated-route sweep picks this up automatically from
   * `RouteRegistry`). `MARKET_RUNTIME` `null` (the pre-existing test/degraded
   * default) yields a stable `503 DISCOVERY_UNAVAILABLE`, never a 500.
   *
   * **Route-shadowing note:** `discovery` is a static path
   * segment; Fastify's `find-my-way` prioritises a static match over
   * `@Get(":id")`'s parametric one regardless of decorator-declaration order
   * — asserted by a dedicated behavioral test
   * (`instruments-discovery.e2e.test.ts`), not merely assumed, per this
   * repo's own "assert behaviour, not configuration" lesson.
   */
  @UseInterceptors(discoveryRateThrottleInterceptor)
  @Get("discovery")
  async discovery(
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ items: DiscoveryCandidateResponse[] }> {
    const parsed = parseOrThrow(discoveryQuerySchema, query);

    // SCD-10: a kind with no provider route (`SCPI`) is
    // created by hand, so there is nothing to search. A static, kind-only
    // answer — checked **before** the `MARKET_RUNTIME` 503 so it never depends
    // on deployment state, and without any provider call.
    if (providerKeyForDiscovery(parsed.kind) === undefined) {
      throw problemException(400, {
        title: "Discovery is not available for this kind of instrument",
        code: "DISCOVERY_NOT_AVAILABLE_FOR_KIND",
        detail: `instruments of kind ${parsed.kind} are created by hand; there is no provider to search`,
      });
    }

    if (this.marketRuntime === null) {
      throw problemException(503, {
        title: "Discovery is not available",
        code: "DISCOVERY_UNAVAILABLE",
      });
    }

    let matches: ProviderSymbolMatch[];
    try {
      matches = await this.marketRuntime.discovery.search({
        kind: parsed.kind,
        query: parsed.query,
      });
    } catch (err) {
      throw this.#mapDiscoveryError(err, reply);
    }

    return {
      // IR-10: the query's own `kind` decides whether the classification
      // fields are emitted (FR-7) — `toDiscoveryCandidateResponse` takes it
      // rather than inferring it from a candidate, which carries no kind.
      items: matches
        .slice(0, DISCOVERY_RESPONSE_MAX_ITEMS)
        .map((match) => toDiscoveryCandidateResponse(match, parsed.kind)),
    };
  }

  /**
   * Translates a thrown provider error to `problem+json`, mirroring
   * `transactions.controller.ts`'s `#mapWriteError` shape. Nothing reaches
   * `ProblemJsonExceptionFilter`'s generic 500 filter — that is AC-7's whole
   * point. `SymbolNotFound`/an empty result are **not** errors at all
   * (`resolve()`'s own port contract returns `[]` for "nothing found"), so
   * there is no case for them here.
   *
   * **F-5 (security review): `detail` is never `err.message` verbatim.**
   * `err.message` for `ProviderUnavailable` (and, on some adapters,
   * `ProviderRateLimited`) is built by the adapter's own HTTP transport
   * (e.g. `yahoo/http-fetcher.ts`'s `fetchYahoo`) from the literal upstream
   * URL it just called — which, for a search request, embeds this tenant's
   * own query string verbatim. `problem+json`'s `detail` is client-facing
   * (this codebase's own convention — every other `detail` in this file is
   * either a fixed string or a value the *caller* already supplied), so
   * that URL/query would otherwise be echoed straight back to whoever sent
   * it. The full `err` (message included) is still logged server-side below
   * for every case — nothing about the diagnostic is lost, only where it is
   * allowed to surface. The machine-readable `code` (what DD8's own test
   * table asserts on) is unchanged by this fix.
   */
  #mapDiscoveryError(err: unknown, reply: FastifyReply): unknown {
    if (err instanceof ProviderRateLimited) {
      const retryAfterSeconds = err.retryAfterSeconds ?? 1;
      void reply.header("Retry-After", String(retryAfterSeconds));
      rootLogger().warn("InstrumentsController#discovery: the provider rate-limited this request", {
        component: "api",
        error: err.message,
      });
      return problemException(429, {
        title: "The discovery provider is momentarily saturated",
        code: "DISCOVERY_PROVIDER_RATE_LIMITED",
        detail: "the discovery provider is temporarily rate-limiting requests — try again shortly",
      });
    }
    if (err instanceof ProviderUnavailable || err instanceof ProviderCircuitOpenError) {
      rootLogger().warn("InstrumentsController#discovery: the provider is unavailable", {
        component: "api",
        error: err.message,
      });
      return problemException(503, {
        title: "The discovery provider is currently unavailable",
        code: "DISCOVERY_PROVIDER_UNAVAILABLE",
        detail: "the discovery provider is currently unavailable — try again later",
      });
    }
    if (err instanceof ProviderMalformedResponse) {
      // R1: worth an alert-grade log line — a shape change
      // upstream, not a rate limit or outage.
      rootLogger().error(
        "InstrumentsController#discovery: the provider returned a malformed response",
        {
          component: "api",
          error: err.message,
        },
      );
      return problemException(502, {
        title: "The discovery provider returned an unexpected response",
        code: "DISCOVERY_PROVIDER_MALFORMED",
        detail: "the discovery provider returned a response this service could not parse",
      });
    }
    return err;
  }

  /**
   * `GET /instruments/:id/history-status`, Assumption A5. Two indexed
   * lookups (`ledger`'s `getInstrumentBackfillStatus` and
   * `getInstrumentPriceFreshness`), never the heavier `getInstrumentCoverage`
   * — the route's design constraint is that it stays cheap enough to poll,
   * not that it issues exactly one statement.
   *
   * Bounded by the instance-wide admission bound. The earlier
   * "shared budget of 8 ... nine cheap-read routes" and its later 6-across-ten
   * revision (`AR-18`, CA-17) describe the retired per-tenant cap.
   */
  @Get(":id/history-status")
  async historyStatus(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<HistoryStatusResponse> {
    const id = parseIdParam(rawId);

    const instrumentRow = await getInstrumentById(this.db, id);
    if (!instrumentRow) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }

    const record = await getInstrumentBackfillStatus(this.db, id);
    // The backfill row alone cannot answer "when was this price last
    // updated" — it holds the resume bookmark, which no quote write moves. One
    // added indexed statement (`getInstrumentPriceFreshness`) carries the last
    // quote instant and the newest daily-series date, and it is tenant-scoped
    // because its manual-point half is.
    const freshness = await getInstrumentPriceFreshness(this.db, {
      tenantId: session.tenantId,
      instrumentId: id,
    });

    return toHistoryStatusResponse(record, freshness);
  }

  /**
   * `PUT /instruments/:id/icon` — set **or** replace this tenant's uploaded
   * icon for an instrument (FR-291(a)(b), FR-292–FR-297, FR-304, FR-317, FR-318, NFR-4).
   *
   * **One route for set and replace, `200` for both.** FR-296 says a set on an
   * instrument that already has an icon *is* a replace, not a second row, and
   * the storage layer says the same thing structurally: the table's primary
   * key is `(tenant_id, instrument_id)` and `setInstrumentIcon` is a single
   * `INSERT … ON CONFLICT DO UPDATE`. A status that varied with prior state
   * would add a branch nothing consumes — `POST /instruments/:id/prices`'s
   * upsert already established that shape.
   *
   * **The bytes arrive base64-encoded inside an ordinary `application/json`
   * body** (FR-318, SD-8). That is a decision, not a convenience: V10 records
   * that `@fastify/multipart`'s parser is deliberately fenced to two import
   * paths by an `onRequest` hook (RC6 — *"its parser registration widens the
   * request-parsing surface of unrelated routes"*), and a content-type parser
   * for `image/png` would widen the surface by media type for **every** route
   * on the API. So this route adds **no** entry to `IMPORT_MULTIPART_PATHS` and
   * registers **no** parser: it inherits the existing `bodyLimit`
   * (`app.ts`'s `REQUEST_BODY_LIMIT_BYTES` = 1 MiB), the session guard, the
   * CSRF guard and `problem+json` unchanged. The arithmetic that makes it fit:
   * 262 144 bytes ⇒ 349 528 base64 characters ⇒ a worst legitimate body of
   * 349 584 bytes with the two-key JSON envelope, **33.3 %** of the limit.
   *
   * **Validation order is the requirement** and lives in
   * `instrument-icon.validate.ts`, which returns a discriminated union this
   * controller maps in {@link InstrumentsController.#mapIconRejection}. The
   * encoded length is checked *before* any decode, so an over-cap payload is
   * refused having materialised no decoded buffer.
   *
   * No route-level throttle now: the instance-wide admission bound
   * covers it, as it does every other write here (SD-7/FR-317's "join the
   * existing instrument-write instance" is moot now that there is none).
   *
   * The `404` reuses the existing `INSTRUMENT_NOT_FOUND` code and the existing
   * French message — `createPrice`'s precedent — rather than minting a
   * write-path-specific one.
   *
   * **The existence probe is `getInstrumentBackfillTarget`, not
   * `getInstrumentById`** (a GATE-2 finding). `getInstrumentById`
   * filters `owner_tenant_id IS NULL` (the F10 forward-compat guard), which
   * cannot express FR-299's *two* instrument kinds: a tenant-owned row is
   * invisible to it, so the **owner** of their own instrument would be told it
   * does not exist. That is the same defect the repo already recorded and
   * fixed once for `POST /instruments/:id/history-reload`, which is why
   * `getInstrumentBackfillTarget` exists beside `getInstrumentById` and why
   * two controllers already apply the caller-side rule this one now joins.
   * `createPrice` is the precedent for the *code and message*, not for the
   * probe: its own spec never names both kinds, and FR-299 does.
   */
  @Put(":id/icon")
  async putIcon(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<InstrumentIconMetaResponse> {
    const id = parseIdParam(rawId);
    const validated = validateInstrumentIconUpload(body);
    if (!validated.ok) throw this.#mapIconRejection(validated.code);

    // **404, never 403** — `InstrumentHistoryReloadController`'s note states
    // the reason in full: a 403 would confirm the existence of another
    // tenant's private instrument to anyone who can guess a UUID, turning this
    // write into an existence oracle for exactly the rows `owner_tenant_id`
    // exists to hide. "No such instrument" and "not yours" are one answer on
    // the wire, and this is stated here so nobody "fixes" it to a 403 for
    // symmetry with some other route.
    const target = await getInstrumentBackfillTarget(this.db, id);
    if (
      target === undefined ||
      (target.ownerTenantId !== null && target.ownerTenantId !== session.tenantId)
    ) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }

    try {
      const meta = await setInstrumentIcon(this.db, {
        tenantId: session.tenantId,
        instrumentId: id,
        bytes: validated.bytes,
        // The **sniffed** type, never `body.declaredContentType` (FR-295).
        contentType: validated.contentType,
        widthPx: validated.widthPx,
        heightPx: validated.heightPx,
        // There is deliberately no `source` here, and there is no field to put
        // one in: `SetInstrumentIconParams` cannot express it, which is how
        // AC-305's "no application-reachable path produces PROVIDER" is a
        // compile-time property rather than a runtime check.
      });
      return toInstrumentIconMetaResponse(meta);
    } catch (err) {
      // FR-302 / SD-5: the per-tenant row cap, as a machine-readable 429 —
      // never a raw 500. Same shape as `createPrice`'s manual-price cap.
      if (err instanceof InstrumentIconTenantCapExceededError) {
        throw problemException(429, {
          title: "Instrument icon limit reached",
          code: "INSTRUMENT_ICON_TENANT_CAP_EXCEEDED",
          // No `detail`, and no `params`: `err.message` names the tenant id,
          // and the cap is a *server* constant the client already mirrors in
          // `web/src/lib/api-limits.ts` — `problem-messages.ts` interpolates
          // it from there (OD-6), so putting a second copy on the wire would
          // create a figure two sources could disagree about.
        });
      }
      // A GATE-2 finding — defence in depth, and deliberately
      // *not* a reordering of `instrument-icon.validate.ts`. That module's
      // steps 3–8 make this class unreachable over HTTP today, which is the
      // stated reason `ledger` gives it no taxonomy row. That finding measured what
      // happens if one of those steps is ever removed as "redundant" (step 5
      // is the one that reads that way and is not): the class escapes this
      // `catch` and `ProblemJsonExceptionFilter` answers **500** — an
      // information-free server error on a user-supplied upload. Mapped here
      // to the same `413`/`422` its own `violation` implies, through the same
      // `#mapIconRejection` table the reachable rejections use, so there is
      // one home for the status per code and not two that can drift.
      // `createPrice`'s `ManualPricePointScaleExceededError` case is the exact
      // precedent for mapping an unreachable-today service error anyway.
      if (err instanceof InstrumentIconBoundsError) {
        throw this.#mapIconRejection(iconRejectionCodeForBoundsViolation(err.violation));
      }
      throw err;
    }
  }

  /**
   * `DELETE /instruments/:id/icon` — remove this tenant's icon, returning the
   * instrument to its fallback tile (FR-291(c), FR-296).
   *
   * **`204` whether or not a row existed.** The reason is the TOCTOU this
   * feature's own removal capability creates: two tabs, or a double-click,
   * would otherwise make the second attempt an error for having succeeded. The
   * rejected alternative — `404` when absent — is not an existence oracle (RLS
   * scopes the statement to the caller's own tenant, so a zero-row delete
   * reveals only the caller's own state); it is rejected on the idempotence
   * argument alone. `apiFetch` already returns `undefined` for a `204`, so the
   * client needs nothing new.
   *
   * No `getInstrumentById` probe first: it would cost a statement to produce a
   * `404` this route has just declined to emit, and the `DELETE` is scoped by
   * RLS plus the whole primary key either way.
   *
   * Same **existing** throttle instance as {@link InstrumentsController.putIcon}
   * — see that method's note.
   */
  @Delete(":id/icon")
  @HttpCode(204)
  async removeIcon(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<void> {
    const id = parseIdParam(rawId);
    await removeInstrumentIcon(this.db, { tenantId: session.tenantId, instrumentId: id });
  }

  /**
   * `instrument-icon.validate.ts`'s rejection code → `problem+json`, mirroring
   * {@link InstrumentsController.#mapDiscoveryError}'s shape.
   *
   * **Every title and detail below is a static literal.** Nothing the uploader
   * supplied is reflected — no filename (the body has no such field), no
   * declared content type, no byte length, no payload prefix — which is
   * FR-304/NFR-4(b) held at the one place a client-supplied string could
   * otherwise reach a response.
   *
   * **`422`, not `415`, for the four payload rejections.** The *request's*
   * media type is `application/json` and is supported, so `415` would be wrong
   * in the way `portfolios.controller.ts` (finding N6) is explicit about;
   * `415` stays what `imports/multipart.ts` uses it for, a genuinely
   * unsupported `Content-Type`. **`413` for the byte cap** matches
   * RFC 9110 §15.5.14 and the import path's own `IMPORT_FILE_TOO_LARGE`.
   *
   * Nothing here reaches `ProblemJsonExceptionFilter`'s generic 500 — that is
   * the point of enumerating them.
   */
  #mapIconRejection(code: InstrumentIconRejectionCode): unknown {
    switch (code) {
      case "INSTRUMENT_ICON_MALFORMED_BASE64":
        return problemException(400, {
          title: "The icon payload is not valid base64",
          code,
          detail: "the icon bytes must be standard base64 with no whitespace and no base64url",
        });
      case "INSTRUMENT_ICON_TOO_LARGE":
        return problemException(413, {
          title: "The icon is too large",
          code,
          detail: "the icon exceeds the maximum stored size",
        });
      case "INSTRUMENT_ICON_UNSUPPORTED_FORMAT":
        return problemException(422, {
          title: "The icon format is not supported",
          code,
          detail: "the leading bytes are not one of the accepted image signatures",
        });
      case "INSTRUMENT_ICON_UNREADABLE":
        return problemException(422, {
          title: "The icon header could not be read",
          code,
          detail: "the image signature was recognised but its header could not be read",
        });
      case "INSTRUMENT_ICON_TYPE_MISMATCH":
        return problemException(422, {
          title: "The declared type does not match the icon bytes",
          code,
          detail: "the declared content type disagrees with the image's own leading bytes",
        });
      case "INSTRUMENT_ICON_DIMENSIONS_EXCEEDED":
        return problemException(422, {
          title: "The icon is too large in pixels",
          code,
          detail: "the image exceeds the maximum accepted pixel dimensions",
        });
    }
  }

  /**
   * `GET /instruments/:id/icon` — this tenant's stored icon bytes
   * (FR-303, FR-304,
   * FR-305, FR-306, FR-317, NFR-2). **The one route on this API whose `200`
   * body is not JSON.**
   *
   * **A1 — how a `Buffer` reaches the wire, since no other route does this.**
   * `@Res({ passthrough: true })` keeps Nest's pipeline in charge and the
   * handler still *returns* the bytes: Nest's Fastify adapter hands a returned
   * value to `reply.send(...)`, and Fastify passes a `Buffer` through as-is,
   * choosing a content type only when none is already set — which is why the
   * three headers below are set *before* the return. `passthrough` is
   * load-bearing and not cosmetic: the admission bound releases its
   * in-flight slot in `finalize`
   * (`common/admission-bound.interceptor.ts`), so a non-passthrough
   * `@Res()` — which takes Nest out of the response path — would leak a slot
   * per request until the cap wedged shut. The claim is asserted
   * *behaviourally* in `instrument-icon-read.e2e.test.ts`: byte-identity of
   * the response body and the exact headers, never "a decorator is present".
   *
   * **`content-disposition: attachment`, with no `filename` parameter, ever**
   * (FR-304): it makes a direct navigation to this URL a download rather than
   * a rendered document, and has no effect on an `<img>` subresource load. No
   * filename is emitted because none is stored — the request body has no such
   * field (NFR-4(b)). Nothing client-supplied reaches a header here:
   * `content-type` is the **stored** enum column (FR-295), `content-length` is
   * the bytes' own length.
   *
   * **`Cache-Control: no-store` is inherited, not set here** (LD-6, NFR-2).
   * `security-headers.ts`'s `cacheControlForPath` returns `no-store` for
   * everything under the `api/v1` prefix, first and unconditionally
   * (FR-6/AC-5), and `buildApp`'s global `onSend` applies it. This route is
   * inside that prefix, so no header rule and no route prefix changes, and
   * FR-306 (a stale icon after a replace) is impossible **by construction** —
   * there is no stored copy to be stale, in the HTTP cache or in Cache Storage
   * (`web/vite.config.ts` already makes every `/api/v1/**` request
   * `NetworkOnly`). That is also why there is no version token, no ETag and no
   * cache-busting query parameter: with `no-store` each would be dead weight.
   *
   * **No existence oracle** (FR-305, AC-312): the handler is one primary-key
   * lookup and **never reads `instrument`**. "Another tenant owns an icon for
   * X", "nobody has iconed X" and "X does not exist" are therefore the same
   * code path producing the same `404` and the same body — by construction,
   * not by three branches that happen to agree. RLS scopes the statement to
   * the caller's tenant even if the predicate were forgotten (NFR-3). One
   * documented non-case: a malformed uuid is `parseIdParam`'s `400`, the same
   * answer every other `:id` route gives, and not an oracle.
   *
   * Bounded by the instance-wide admission bound (formerly the shared
   * per-tenant cheap-read cap, MEDIUM-2/IK-9).
   */
  @Get(":id/icon")
  async getIcon(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const id = parseIdParam(rawId);

    const icon = await getInstrumentIcon(this.db, {
      tenantId: session.tenantId,
      instrumentId: id,
    });
    if (icon === null) {
      throw problemException(404, {
        title: "Icon not found",
        code: "INSTRUMENT_ICON_NOT_FOUND",
      });
    }

    void reply
      .header("content-type", icon.contentType)
      .header("content-length", String(icon.bytes.byteLength))
      .header("content-disposition", "attachment");
    return icon.bytes;
  }

  /** `GET /instruments/:id`. MEDIUM-2 (security review): see `list`'s own doc comment. */
  @Get(":id")
  async getOne(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<InstrumentResponse> {
    const id = parseIdParam(rawId);
    const row = await getInstrumentById(this.db, id);
    if (!row) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }
    // IK-10: the same one bounded lookup as `list`, over a single id. It runs
    // only after the 404 above, so a nonexistent instrument costs nothing
    // extra — and it is deliberately **not** `getInstrumentIcon`, which would
    // read the `bytes` column to answer a boolean.
    const iconed = await listInstrumentIdsWithIcon(this.db, {
      tenantId: session.tenantId,
      instrumentIds: [id],
    });
    return toInstrumentResponse(row, iconed.has(id));
  }

  /**
   * `PATCH /instruments/:id/classification` — the user override
   * (spec
   * FR-3, AC-36's write half). Accepts `sectorCode`, `domicileCountry` and
   * `industryLabel`, each `T | null`, at least one key; returns the **full**
   * `InstrumentResponse` so the client re-renders from the server's own truth
   * rather than from what it just sent.
   *
   * **Three narrowings, each enforced somewhere different**, because this route
   * writes a row every tenant reads:
   *
   *  1. `updateInstrumentClassificationBodySchema` is a `z.strictObject` — a
   *     body carrying `isin`/`exchangeMic`/`symbol`/`kind`/`figi`/
   *     `primaryIdentifier`/`ownerTenantId` is a 400, not a stripped key.
   *  2. `updateInstrumentClassification`'s parameter type cannot *express*
   *     those fields (a compile-time guarantee, pinned by
   *     `ledger/src/instrument-service.test.ts`'s `@ts-expect-error` fixture).
   *  3. Migration `0036` grants `app_web` `UPDATE` on exactly six columns, so
   *     the database refuses the rest as `permission denied` even if 1 and 2
   *     were both bypassed.
   *
   * No route-level throttle — the instance-wide admission bound
   * covers it (the C27 row, "no new unthrottled write route", is met by
   * that bound for every route at once). The old cap was a concurrency cap, so a *sequential*
   * caller is never throttled here; `instruments-classification-patch.e2e.test.ts`
   * asserts both directions, because "a throttle exists" is satisfiable by the
   * wrong mechanism. No rate cap is added: unlike `create`, this route enqueues
   * no backfill and inserts no row — it is one `UPDATE` on a row that already
   * exists.
   *
   * **`display_name`/`status` are deliberately not editable here** (DD30
   * rejects a general `PATCH /instruments/:id`), and there is no per-tenant
   * override table (NG11): the catalogue is shared, so one tenant's correction
   * changes the row for every tenant. That is C27, harmless while
   * phase 1 is single-user (ADR-0014), stated in the form's own copy, and
   * explicitly **not** fixed here.
   *
   * 404-shaped exactly like `getOne` above: `updateInstrumentClassification`
   * raises {@link InstrumentNotFoundError} when the `UPDATE` matches no row —
   * so the not-found case costs one statement, not a read-then-write pair
   * (which would also be a race).
   */
  @Patch(":id/classification")
  async updateClassification(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<InstrumentResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(updateInstrumentClassificationBodySchema, body);

    try {
      const row = await updateInstrumentClassification(this.db, id, {
        // Spread-when-present, never `?? null`: `null` and absent mean
        // different things on this route (clear vs. leave alone), and
        // collapsing them would silently clear two columns on every patch of
        // the third.
        ...(parsed.sectorCode !== undefined ? { sectorCode: parsed.sectorCode } : {}),
        ...(parsed.domicileCountry !== undefined
          ? { domicileCountry: parsed.domicileCountry }
          : {}),
        ...(parsed.industryLabel !== undefined ? { industryLabel: parsed.industryLabel } : {}),
      });
      // IK-10: this route returns the **full** `InstrumentResponse`, so it
      // owes the same real flag `getOne` does — a hard-coded `false` here
      // would make a classification edit visibly drop the tile.
      const iconed = await listInstrumentIdsWithIcon(this.db, {
        tenantId: session.tenantId,
        instrumentIds: [id],
      });
      return toInstrumentResponse(row, iconed.has(id));
    } catch (err) {
      if (err instanceof InstrumentNotFoundError) {
        throw problemException(404, {
          title: "Instrument not found",
          code: "INSTRUMENT_NOT_FOUND",
        });
      }
      // (FR-608/N11): a non-null sector or industry on an SCPI — the
      // scpi-attributes route's code, nothing stored.
      if (err instanceof InstrumentAttributesNotApplicableError) {
        throw problemException(400, {
          title: "An SCPI carries no sector and no industry",
          code: "INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * `PATCH /instruments/:id/identity` — instrument-detail identity edit
   * (issue, 2026-09-09). A **second** user-override route beside
   * `updateClassification` above, deliberately not a widened classification
   * body: `updateInstrumentIdentityBodySchema`'s own doc comment
   * (`@kerdial/api-contracts`) states why `figi` needed a fill-once
   * contract rather than that route's correct-or-clear one.
   *
   * `displayName` (unconditional) and `figi` (fill-once) are independent
   * fields written through `ledger`'s `updateInstrumentIdentity`, which wraps
   * both in one transaction — a request naming both never leaves a rename
   * applied against a rejected `figi` fill.
   *
   * **`isin`/`exchangeMic`/`symbol`/`kind`/`primaryIdentifier`/
   * `ownerTenantId` remain exactly as unreachable as on the classification
   * route** — this route widens the writable identity surface by one column
   * (`figi`) beyond what `0036` ever granted `app_web`, and no further;
   * migration `0061` is the column-level grant for it.
   *
   * Shares the classification route's throttle instance (the C27 row:
   * no new unthrottled write route) rather than a third interceptor.
   */
  @Patch(":id/identity")
  async updateIdentity(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<InstrumentResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(updateInstrumentIdentityBodySchema, body);

    try {
      const row = await updateInstrumentIdentity(this.db, id, {
        ...(parsed.displayName !== undefined ? { displayName: parsed.displayName } : {}),
        ...(parsed.figi !== undefined ? { figi: parsed.figi } : {}),
      });
      const iconed = await listInstrumentIdsWithIcon(this.db, {
        tenantId: session.tenantId,
        instrumentIds: [id],
      });
      return toInstrumentResponse(row, iconed.has(id));
    } catch (err) {
      if (err instanceof InstrumentNotFoundError) {
        throw problemException(404, {
          title: "Instrument not found",
          code: "INSTRUMENT_NOT_FOUND",
        });
      }
      if (err instanceof InstrumentFigiAlreadySetError) {
        throw problemException(409, {
          title: "Instrument already has a FIGI",
          code: "INSTRUMENT_FIGI_ALREADY_SET",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * `PATCH /instruments/:id/scpi-attributes` (SCD-8;
   * FR-612, AC-502) — the société de gestion and the frais de souscription of
   * an SCPI, cloned from `updateClassification` above: strict body (`kind`,
   * `isin`, `symbol`, `quotePolicy` are a 400), at least one key, `null`
   * clears; returns the full `InstrumentResponse` with the real icon flag.
   *
   * `400 INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE` for an instrument that is not
   * an SCPI, `404 INSTRUMENT_NOT_FOUND` for an unknown id. **No owner filter**,
   * the classification route's rule (S-2, C27). A descriptive
   * write: no `calc_epoch` bump, no queue. Bounded by the instance-wide
   * admission bound like every route.
   */
  @Patch(":id/scpi-attributes")
  async updateScpiAttributes(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<InstrumentResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(updateInstrumentScpiAttributesBodySchema, body);

    try {
      const row = await updateInstrumentScpiAttributes(this.db, id, {
        // Spread-when-present: `null` clears, absent leaves alone.
        ...(parsed.managementCompany !== undefined
          ? { managementCompany: parsed.managementCompany }
          : {}),
        ...(parsed.subscriptionFeePct !== undefined
          ? { subscriptionFeePct: parsed.subscriptionFeePct }
          : {}),
      });
      const iconed = await listInstrumentIdsWithIcon(this.db, {
        tenantId: session.tenantId,
        instrumentIds: [id],
      });
      return toInstrumentResponse(row, iconed.has(id));
    } catch (err) {
      if (err instanceof InstrumentNotFoundError) {
        throw problemException(404, {
          title: "Instrument not found",
          code: "INSTRUMENT_NOT_FOUND",
        });
      }
      if (err instanceof InstrumentAttributesNotApplicableError) {
        throw problemException(400, {
          title: "These attributes apply only to an SCPI",
          code: "INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * `DELETE /instruments/:id` — removes an instrument nothing in the
   * ledger references, and with it the eight tables that cascade from it
   * (price history, manual points, gaps, provider map, quote cache, backfill
   * state, icon, watchlist entry). `204`, no body, the convention
   * `DELETE /portfolios/:id` and `DELETE /transactions/:id` already set.
   *
   * **`409`, not a cascade, when the ledger still points at it.** The decision
   * (owner) is that transactions, postings, holdings and realized gains
   * are never destroyed as a side effect of tidying up the catalogue: a
   * position's history outlives a decision to stop tracking its instrument.
   * Deleting it is still possible, by deleting the transactions first through
   * `DELETE /transactions/:id`, which maintains `holding_state` and
   * `realized_gain`; nothing here does that on the caller's behalf.
   *
   * The counts travel in `params` so the client can say « 18 transactions »
   * rather than « c'est utilisé ». They are counts, never row ids — the same
   * reasoning `portfolios.controller.ts` records for keeping a UUID out of its
   * 422, and here it also keeps another tenant's row count out of a response
   * (it cannot be counted at all: see `deleteInstrument`).
   *
   * No route-level throttle — a delete is an instrument write like
   * any other, bounded by the instance-wide admission bound.
   */
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("id") rawId: string,
    @CurrentSession() session: SessionContext,
  ): Promise<void> {
    const id = parseIdParam(rawId);
    try {
      const result = await deleteInstrument(this.db, {
        tenantId: session.tenantId,
        instrumentId: id,
      });
      if (!result.deleted) {
        throw problemException(404, {
          title: "Instrument not found",
          code: "INSTRUMENT_NOT_FOUND",
        });
      }
    } catch (err) {
      if (err instanceof InstrumentDeleteBlockedError) {
        throw problemException(409, {
          title: "Cannot delete: the ledger still references this instrument",
          code: "INSTRUMENT_DELETE_BLOCKED_BY_LEDGER",
          detail: err.message,
          ...(err.counts === undefined ? {} : { params: { ...err.counts } }),
        });
      }
      throw err;
    }
  }

  /**
   * `POST /instruments/:id/prices` (FR-23, AC12) — manual NAV/price point
   * entry, T-36's `upsertManualPricePoint`. `close` is validated by
   * `zDecimal` (a malformed, e.g. non-numeric, value is rejected with a
   * per-field `problem+json` error before this handler ever runs).
   *
   * `AR-18` (security review HIGH-1): throttled at 2 concurrent
   * writes per tenant. This was the only write route on the whole surface
   * with no interceptor at all, and the existing
   * `MANUAL_PRICE_POINT_TENANT_ROW_CAP` does not bound it — that cap only
   * fires on a genuinely new `(instrumentId, priceDate)` key, so a same-key
   * loop is a pure `ON CONFLICT … DO UPDATE` that never consults it. Since
   * The instance-wide admission bound is what bounds it (the per-tenant
   * cap of 2 that closed the finding was retired with the rest of the table).
   */
  @Post(":id/prices")
  @HttpCode(201)
  async createPrice(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionContext,
  ): Promise<PriceHistoryPointResponse> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(createManualPriceBodySchema, body);

    const instrumentRow = await getInstrumentById(this.db, id);
    if (!instrumentRow) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }

    let row;
    try {
      row = await upsertManualPricePoint(this.db, {
        tenantId: session.tenantId,
        instrumentId: id,
        priceDate: parsed.priceDate,
        close: parsed.close,
        currency: parsed.currency,
      });
    } catch (err) {
      // F3 (security review, T-37): the per-tenant
      // manual_price_point row cap — a machine-readable 429, not a raw 500.
      if (err instanceof ManualPricePointTenantCapExceededError) {
        throw problemException(429, {
          title: "Manual price point limit reached",
          code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED",
          detail: err.message,
        });
      }
      // NEW-5 (security review, T-37): unreachable via
      // this controller today — `createManualPriceBodySchema`'s own N9
      // refinement already rejects more than 18 fractional digits before
      // `upsertManualPricePoint` is ever called — but mapped defensively
      // anyway, exactly like the cap above, so a future change to either
      // layer degrades to a machine-readable 400, not a raw 500.
      if (err instanceof ManualPricePointScaleExceededError) {
        throw problemException(400, {
          title: "Manual price point close has too many fractional digits",
          code: "MANUAL_PRICE_POINT_SCALE_EXCEEDED",
          detail: err.message,
        });
      }
      throw err;
    }

    return toPriceHistoryPointResponse({
      priceDate: row.priceDate,
      close: row.close,
      currency: row.currency,
      sourceKey: row.sourceKey,
      origin: "MANUAL",
    });
  }

  /**
   * `GET /instruments/:id/prices?from=&to=&cursor=&limit=` (FR-15, FR-16) —
   * the merged automated + this tenant's manual price history.
   *
   * F3 (security review, T-37): previously unbounded —
   * omitting `from`/`to` returned the instrument's *entire* history in one
   * response, with no cap on how wide an explicit range could be. Now
   * defaults/clamps to {@link resolvePriceHistoryWindow}'s window and applies
   * the same cursor pagination (`MAX_PAGE_LIMIT` = 100) every other T-37 list
   * endpoint uses.
   *
   * N6 (security review, T-37): `limit`/`offset` are
   * now passed straight through to `listInstrumentPriceHistory`, which
   * applies them at the data layer (a real `LIMIT` on each underlying
   * source query — see that function's own doc comment) instead of this
   * controller fetching+merging+sorting the instrument's *entire* window
   * before slicing to a page in Node — a `limit=1` walker used to force that
   * full fetch/merge/sort on every single request.
   *
   * Bounded by the instance-wide admission bound (formerly MEDIUM-2's
   * shared per-tenant cheap-read cap).
   */
  @Get(":id/prices")
  async listPrices(
    @Param("id") rawId: string,
    @Query() query: Record<string, string | undefined>,
    @CurrentSession() session: SessionContext,
  ): Promise<{ items: PriceHistoryPointResponse[]; nextCursor: string | null }> {
    const id = parseIdParam(rawId);
    const parsed = parseOrThrow(listInstrumentPricesQuerySchema, query);
    const offset = decodeOffsetCursor(parsed.cursor);
    const limit = parsePageLimit(parsed.limit);

    const instrumentRow = await getInstrumentById(this.db, id);
    if (!instrumentRow) {
      throw problemException(404, { title: "Instrument not found", code: "INSTRUMENT_NOT_FOUND" });
    }

    const { from, to } = resolvePriceHistoryWindow(parsed.from, parsed.to);

    const window = await listInstrumentPriceHistory(this.db, {
      tenantId: session.tenantId,
      instrumentId: id,
      fromDate: from,
      toDate: to,
      limit,
      offset,
    });

    const page = buildCursorPage(window, offset, limit);
    return { items: page.items.map(toPriceHistoryPointResponse), nextCursor: page.nextCursor };
  }
}
