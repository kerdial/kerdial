import { API_BASE, apiFetch } from "./core.js";

/**
 * `GET /api/v1/instruments?query=` (T-37) — the instrument picker's search
 * endpoint, trimmed to the fields the form's picker renders/submits
 * (`api/src/instruments/instruments.schema.ts`'s `InstrumentResponse` also
 * carries `figi`/`quotePolicy`/`status`/timestamps, not needed here).
 * `exchangeMic` IS carried (unlike the other trimmed fields): the
 * instrument-creation UI's duplicate-outcome flow needs it to disambiguate
 * two distinct listings of the same ISIN (assumption
 * 7 — dual listings share an ISIN, deduped per `(isin, exchangeMic)`) when
 * locating the pre-existing row a 409 pointed at.
 */
export interface InstrumentSummary {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly listingCurrency: string;
  readonly isin: string | null;
  readonly exchangeMic: string | null;
  readonly symbol: string | null;
  /**
   * Already on the list wire (`instruments.controller.ts` maps every row
   * through `toInstrumentResponse(row, iconed.has(row.id))`). Optional because
   * the POST-create response and older fixtures reach this same type; read it
   * as `=== true`.
   */
  readonly hasIcon?: boolean;
}

export async function searchInstruments(
  query: string,
  signal?: AbortSignal,
): Promise<InstrumentSummary[]> {
  const response = await apiFetch<{ items: InstrumentSummary[]; nextCursor: string | null }>(
    `/instruments?query=${encodeURIComponent(query)}`,
    undefined,
    signal,
  );
  return response.items;
}

/**
 * `GET /api/v1/instruments/:id` (UR-9/UR-27/UR-28) —
 * mirrors `api/src/instruments/instruments.schema.ts`'s `InstrumentResponse`
 * field-for-field (`instruments.schema.ts:248-262`). Widened from the
 * originally-trimmed `InstrumentSummary` (UR-9's own call site only needed
 * `displayName`) once the Instruments list (UR-27, `quotePolicy`/`symbol`
 * column) and the Instrument detail route (UR-28, every `GET
 * /instruments/:id` field) became real consumers of the **same**
 * `["instruments", id]` key `instrumentByIdQueryOptions` already assigns —
 * one key, one fetch, two consumers (now three).
 * `instrument-names.ts`'s `useInstrumentNames` reads only `.displayName` off
 * this richer shape; nothing about its own behaviour changes.
 */
export interface InstrumentDetailResponse {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly listingCurrency: string;
  readonly exchangeMic: string | null;
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly figi: string | null;
  readonly primaryIdentifier: string;
  readonly quotePolicy: string;
  readonly status: string;
  /**
   * IR-12 — the
   * mapped Kerdial sector code, `null` when the instrument is unclassified
   * (FR-3/FR-5, rendered « Non classé » by `sector-display.ts`). `web` never
   * maps a provider string itself.
   */
  readonly sectorCode: string | null;
  /** The provider's opaque detail label (FR-6) — rendered **as received**, never translated. */
  readonly industryLabel: string | null;
  /** The issuer's country of incorporation, `null` when unknown (FR-9) — « Non renseigné ». */
  readonly domicileCountry: string | null;
  /**
   * **Server-derived** from `exchangeMic` (FR-10, AC-9/AC-12) — a peer field
   * of {@link domicileCountry} on the wire, never the same value, and never
   * the ISIN's own prefix. `web` does not derive it and must not: the
   * MIC->country table lives with the curated MIC list.
   */
  readonly listingCountry: string | null;
  /**
   * IK-10 — whether **this** tenant has an
   * icon for the instrument. The one field on this response that depends on
   * who asked: `instrument` is the shared catalogue, and the icon is keyed by
   * `(tenant_id, instrument_id)`. Sourced server-side by one bounded lookup per
   * request, never a per-row probe.
   */
  readonly hasIcon: boolean;
  /**
   * scpi cycle (SCD-7) — present **only** on an SCPI's body
   * (`null` when unset); every other kind's body carries no such key, so a
   * non-SCPI response stays byte-identical to its pre-SCPI shape.
   */
  readonly managementCompany?: string | null;
  /** Canonical two-decimal percentage string (`"8.50"`), SCPI only — never parsed into a JS number. */
  readonly subscriptionFeePct?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function fetchInstrument(
  id: string,
  signal?: AbortSignal,
): Promise<InstrumentDetailResponse> {
  return apiFetch<InstrumentDetailResponse>(`/instruments/${id}`, undefined, signal);
}

/**
 * IB11 (FR-188/FR-190/FR-191) — the Instruments screen's **catalogue mode** row
 * source: the very same `GET /api/v1/instruments` route
 * {@link searchInstruments} already calls (V10 — no backend change this
 * cycle), read as a browsable, cursor-paged list rather than as a picker
 * search.
 *
 * **The full response shape, not `InstrumentSummary`'s trim.**
 * `GET /instruments` has always returned every `InstrumentResponse` field
 * (`api/src/instruments/instruments.schema.ts`'s `toInstrumentResponse`), and
 * `InstrumentRowData.detail` is typed on exactly that shape — so a catalogue
 * page carries everything a row renders and needs **no per-row
 * `GET /instruments/:id`**. That is what keeps the mode's per-row fan-out to
 * one read (`history-status`) instead of two.
 *
 * **No `limit` is ever sent.** The server's own `DEFAULT_PAGE_LIMIT` (20) is
 * the page size this screen is built around — the same convention
 * `listTransactions` documents. Pulling all ~51 rows at once with
 * `limit=100` was rejected (IB11): it triples the status fan-out per mode
 * switch on a screen users filter far more often than they scroll.
 *
 * **`query` is the caller's responsibility to gate.** The route's own
 * `listInstrumentsQuerySchema` rejects anything with fewer than 3
 * alphanumeric characters with a 400, so `InstrumentsView.tsx` withholds a
 * shorter filter through `meetsInstrumentSearchMinimum` (`quick-search.ts`'s
 * client-side mirror of that server gate) rather than sending a request that
 * cannot succeed.
 */
export interface InstrumentCatalogueParams {
  readonly query?: string;
  readonly kind?: string;
  readonly cursor?: string;
}

export interface InstrumentCataloguePage {
  readonly items: readonly InstrumentDetailResponse[];
  /** The server's opaque next-page token, `null` on the last page — round-tripped through the URL (UR-7), never parsed. */
  readonly nextCursor: string | null;
}

export function listInstrumentCatalogue(
  params: InstrumentCatalogueParams = {},
  signal?: AbortSignal,
): Promise<InstrumentCataloguePage> {
  const search = new URLSearchParams();
  if (params.query !== undefined) search.set("query", params.query);
  if (params.kind !== undefined) search.set("kind", params.kind);
  if (params.cursor !== undefined) search.set("cursor", params.cursor);
  const suffix = search.toString();
  return apiFetch<InstrumentCataloguePage>(
    suffix === "" ? "/instruments" : `/instruments?${suffix}`,
    undefined,
    signal,
  );
}

/**
 * `POST /api/v1/instruments` (T-37; the instrument-creation
 * UI task) — `body` is validated client-side against the identical
 * `createInstrumentBodySchema` (`@kerdial/api-contracts`) before this is
 * ever called, see `InstrumentCreateForm.tsx`'s own resolver. A duplicate
 * (isin, exchangeMic) or duplicate symbol responds 409 `problem+json`
 * (`code` one of `INSTRUMENT_DUPLICATE_ISIN_EXCHANGE_MIC`/
 * `INSTRUMENT_DUPLICATE_CRYPTO_SYMBOL`/`INSTRUMENT_DUPLICATE_SYMBOL`,
 * `instruments.controller.ts`'s `create` handler) — surfaced here as an
 * ordinary `ApiError`, which `InstrumentCreateForm.tsx`'s `onError` branches
 * on to show the calm "already exists" outcome (AC1) rather than a raw
 * error.
 */
export function createInstrument(body: Record<string, unknown>): Promise<InstrumentSummary> {
  return apiFetch<InstrumentSummary>("/instruments", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * `PATCH /api/v1/instruments/:id/classification` (DD30/DD31; IR-17/IR-18) — the
 * user override.
 *
 * **`null` and absent are different values on this route**, which is why this
 * input type spells both out: `null` clears the column (« Non classé » /
 * « Non renseigné » becomes the stored truth), an absent key leaves it
 * untouched. `JSON.stringify` drops `undefined` properties, so an unset field
 * genuinely never reaches the wire — it is not sent as `null` by accident.
 *
 * The body is validated client-side against the **same**
 * `updateInstrumentClassificationBodySchema` the API validates against
 * (`InstrumentClassificationForm.tsx`'s resolver, FR-31), and the response is
 * the full {@link InstrumentDetailResponse} — the server's own truth, including
 * the derived `listingCountry`, so the caller re-renders from it rather than
 * from what it just sent.
 */
export interface UpdateInstrumentClassificationInput {
  readonly instrumentId: string;
  readonly sectorCode?: string | null;
  readonly domicileCountry?: string | null;
  readonly industryLabel?: string | null;
}

export function updateInstrumentClassification(
  input: UpdateInstrumentClassificationInput,
): Promise<InstrumentDetailResponse> {
  const { instrumentId, ...patch } = input;
  return apiFetch<InstrumentDetailResponse>(`/instruments/${instrumentId}/classification`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * `PATCH /api/v1/instruments/:id/identity` (instrument-detail identity edit,
 * 2026-09-09) — a **second** user override beside
 * {@link updateInstrumentClassification}, not a widened one:
 * `updateInstrumentIdentityBodySchema`'s own doc comment explains why `figi`
 * needed a fill-once contract rather than that route's correct-or-clear one.
 *
 * Both fields are plain, never `null` — neither is clearable through this
 * route. A `figi` on an instrument that already has one responds `409`
 * `problem+json` (`code: "INSTRUMENT_FIGI_ALREADY_SET"`), surfaced as an
 * ordinary `ApiError` for `InstrumentIdentityForm.tsx`'s `onError` to read.
 *
 * Validated client-side against the **same**
 * `updateInstrumentIdentityBodySchema` the API validates against
 * (`InstrumentIdentityForm.tsx`'s resolver), and the response is the full
 * {@link InstrumentDetailResponse}, so the caller re-renders from the
 * server's own truth rather than from what it just sent.
 */
export interface UpdateInstrumentIdentityInput {
  readonly instrumentId: string;
  readonly displayName?: string;
  readonly figi?: string;
}

export function updateInstrumentIdentity(
  input: UpdateInstrumentIdentityInput,
): Promise<InstrumentDetailResponse> {
  const { instrumentId, ...patch } = input;
  return apiFetch<InstrumentDetailResponse>(`/instruments/${instrumentId}/identity`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * `PATCH /api/v1/instruments/:id/scpi-attributes` (scpi cycle,
 * SCD-8) — the société de gestion and the frais de souscription of an SCPI.
 *
 * The {@link updateInstrumentClassification} contract: `null` clears, an absent
 * key leaves the stored value untouched (`JSON.stringify` drops `undefined`).
 * The fee travels as the decimal string the user typed, never a JS number.
 * A non-SCPI target answers `400 INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE`; the
 * response is the full {@link InstrumentDetailResponse}.
 */
export interface UpdateInstrumentScpiAttributesInput {
  readonly instrumentId: string;
  readonly managementCompany?: string | null;
  readonly subscriptionFeePct?: string | null;
}

export function updateInstrumentScpiAttributes(
  input: UpdateInstrumentScpiAttributesInput,
): Promise<InstrumentDetailResponse> {
  const { instrumentId, ...patch } = input;
  return apiFetch<InstrumentDetailResponse>(`/instruments/${instrumentId}/scpi-attributes`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * The **same-origin** URL an `<img>` loads this tenant's stored icon from —
 * `GET /api/v1/instruments/:id/icon` (FR-303, LD-2).
 *
 * A function of the id and nothing else, which is the whole of the "no
 * existence oracle" property on the client side (FR-305): the URL is identical
 * for every tenant and for an instrument nobody has iconed, so it carries no
 * information the caller does not already hold. Whether to *render* an `<img>`
 * at this URL is decided by the `hasIcon` boolean the holdings and instrument
 * reads already carry (FR-313/FR-314) — never by requesting it and seeing what
 * comes back.
 *
 * `API_BASE` rather than a second `/api/v1` literal: an `<img src>` is not an
 * `apiFetch` call, so it does not get the prefix for free, and hardcoding it
 * here would be the one place that fails to move if the prefix ever does.
 *
 * Deliberately **not** cache-busted with a version token, and that stands —
 * but for a narrower reason than it was first written with. LD-6 locks the
 * response at `no-store`, so a replace cannot leave a stale copy in the HTTP
 * cache, in Cache Storage or in the service worker for a query string to
 * defeat, and a token would need the content digest OD-1(c) was rejected for
 * wanting. What that argument does **not** cover is a bitmap already decoded
 * into a mounted `<img>`, which no cache directive can reach — GATE-3 measured
 * a replace leaving the previous bytes on the detail badge for exactly that
 * reason (FR-306). The remedy belongs to the element, not to the URL:
 * `InstrumentIconTile` keys the `<img>` on an `iconVersion` so a replace
 * remounts it. A query string here would additionally break FR-303/AC-311's
 * own assertions, which read the rendered `src` as an exact path.
 */
export function instrumentIconUrl(instrumentId: string): string {
  return `${API_BASE}/instruments/${instrumentId}/icon`;
}

/**
 * `PUT /instruments/:id/icon`'s response — the stored icon's metadata
 * (`api/src/instruments/instruments.schema.ts`'s `InstrumentIconMetaResponse`).
 * Mirrored here field for field, the convention every other wire type in this
 * module follows.
 *
 * The bytes are **not** on it: they are read from
 * {@link instrumentIconUrl}'s route, which is what keeps a 256 KiB payload out
 * of the JSON the mutation resolves with.
 */
export interface InstrumentIconMetaResponse {
  readonly instrumentId: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly source: string;
  readonly updatedAt: string;
}

export interface SetInstrumentIconInput {
  readonly instrumentId: string;
  /**
   * FR-292: sent so the server can *detect* a disagreement with the file's own
   * leading bytes, never so it can be trusted. The server sniffs the bytes and
   * stores the sniffed type; this field only ever causes a rejection.
   */
  readonly declaredContentType: string;
  /** Standard base64 — the shape `setInstrumentIconBodySchema` accepts. No filename is sent (FR-304, NFR-4(b)). */
  readonly bytesBase64: string;
}

/**
 * `PUT /instruments/:id/icon` — set **or** replace (FR-291(a)/(b), FR-296:
 * a set on an instrument that already has one is a replace, not a second row).
 *
 * JSON with base64 bytes rather than `multipart/form-data`:
 * `IMPORT_MULTIPART_PATHS` is a closed allowlist this cycle does not touch
 * (AC-309), and a second multipart route would widen it.
 */
export function setInstrumentIcon(
  input: SetInstrumentIconInput,
): Promise<InstrumentIconMetaResponse> {
  return apiFetch<InstrumentIconMetaResponse>(`/instruments/${input.instrumentId}/icon`, {
    method: "PUT",
    body: JSON.stringify({
      declaredContentType: input.declaredContentType,
      bytesBase64: input.bytesBase64,
    }),
  });
}

/**
 * `DELETE /instruments/:id/icon` — remove it, returning the instrument to its
 * fallback tile (FR-291(c), FR-296).
 *
 * `204` whether or not a row existed, so this resolves rather than rejecting
 * on a double-click or a second tab (the controller's own note on the TOCTOU
 * its removal capability creates). `apiFetch` already maps a `204` to
 * `undefined`, so nothing new is needed here.
 */
export function deleteInstrumentIcon(instrumentId: string): Promise<void> {
  return apiFetch<void>(`/instruments/${instrumentId}/icon`, { method: "DELETE" });
}

/**
 * `DELETE /instruments/:id` — removes the instrument and everything
 * that cascades from it (price history, manual price points, gaps, provider
 * mapping, latest quote, backfill state, icon, watchlist entry).
 *
 * Rejects with a `409` `INSTRUMENT_DELETE_BLOCKED_BY_LEDGER` when a
 * transaction, posting, holding or realized gain still references it — never a
 * silent partial delete. `problem-messages.ts` turns that into the counted
 * French sentence; the caller only has to render `messageForError`.
 *
 * `204`, so `apiFetch` resolves to `undefined` — unlike
 * {@link deleteInstrumentIcon}, a second call after a successful one gets a
 * `404`, because the row really is gone.
 */
export function deleteInstrument(instrumentId: string): Promise<void> {
  return apiFetch<void>(`/instruments/${instrumentId}`, { method: "DELETE" });
}

/**
 * `GET /api/v1/currencies` (IC-12/IC-13,
 * decision D5) — the `CurrencySelect` combobox's data source.
 * Trimmed to what the dropdown needs (`api/src/currencies/currencies.schema.ts`'s
 * `CurrencyResponse` carries exactly these three fields already).
 */
export interface CurrencyOption {
  readonly code: string;
  readonly name: string;
  readonly minorUnit: number;
}

export async function fetchCurrencies(signal?: AbortSignal): Promise<CurrencyOption[]> {
  const response = await apiFetch<{ items: CurrencyOption[] }>("/currencies", undefined, signal);
  return response.items;
}

/**
 * `GET /api/v1/instruments/discovery?kind=&query=` (IC-11/IC-14) — mirrors
 * `api/src/instruments/discovery.schema.ts`'s `DiscoveryCandidateResponse`.
 * `exchangeHint` never carries a bare `exchangeMic` field (AC-4/FR-4) — only
 * `code`/`suggestedMic`, exactly as the server returns it.
 */
export interface DiscoveryExchangeHint {
  readonly code: string;
  readonly suggestedMic: string | null;
}

export interface DiscoveryCandidate {
  readonly providerSymbol: string;
  readonly tickerSymbol: string | null;
  readonly displayName: string;
  readonly listingCurrency: string;
  readonly exchangeHint: DiscoveryExchangeHint | null;
  readonly matchQuality: "EXACT" | "PROBABLE";
  /**
   * IR-10 — the
   * **mapped Kerdial sector code** (a `SECTOR_CODES` member), `null` when the
   * provider's own label has no entry in the curated map, and **absent
   * entirely** for a non-SHARE query (FR-7). Mirrors
   * `api/src/instruments/discovery.schema.ts`'s `DiscoveryCandidateResponse`
   * field for field, optionality included. `web` never maps a provider string
   * itself — it renders this code through `sectorDisplayLabel`.
   */
  readonly sectorCode?: string | null;
  /** The provider's opaque detail label (FR-6). Same optionality rule as {@link sectorCode}. */
  readonly industryLabel?: string | null;
}

/**
 * `signal` is threaded through exactly like every other GET wrapper here
 * (MEDIUM-1 precedent) — `InstrumentDiscoverySearch`'s own `queryFn` reads it
 * off `QueryFunctionContext`, which is what lets a superseded keystroke's
 * request (a changed `kind`/`query` -> a changed query key) actually abort
 * once TanStack Query drops the old query's last observer (see
 * `queries.ts`'s `instrumentDiscoveryQueryOptions` doc comment).
 */
export async function searchInstrumentDiscovery(
  kind: string,
  query: string,
  signal?: AbortSignal,
): Promise<DiscoveryCandidate[]> {
  const params = new URLSearchParams({ kind, query });
  const response = await apiFetch<{ items: DiscoveryCandidate[] }>(
    `/instruments/discovery?${params.toString()}`,
    undefined,
    signal,
  );
  return response.items;
}

/**
 * `GET /api/v1/instruments/:id/history-status` (IC-12/IC-16) — mirrors
 * `api/src/instruments/instruments.schema.ts`'s `HistoryStatusResponse`
 * field-for-field. `"NONE"` is not a real backend enum value stored
 * anywhere — it is `getInstrumentBackfillStatus`'s own "no
 * `instrument_backfill_state` row exists yet" case (an instrument created
 * while `MARKET_RUNTIME` was `null`, or an `SCPI`, the one kind that never
 * backfills — every other kind does now).
 */
export interface HistoryStatusResponse {
  readonly status: "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
  readonly requestedFrom: string | null;
  readonly earliestBackfilledDate: string | null;
  /**
   * The backfill **resume bookmark**, not price freshness. No quote
   * write moves it — `InstrumentTable.tsx`'s `historyThroughText` is the one
   * reader, under a label that says so.
   */
  readonly latestBackfilledDate: string | null;
  /** The last quote's own observation instant, ISO-8601 UTC — intraday, so « Actualiser les cours » moves it even when neither the day nor the price changes. `null` when no quote was ever stored. */
  readonly lastQuoteAt: string | null;
  /** The newest daily-series date (automated series merged with this tenant's manual points) — the last point the chart can draw. `null` when there is none. */
  readonly latestPriceDate: string | null;
}

/**
 * `signal` is threaded through (MEDIUM-1 precedent) even though this backs a
 * poll rather than a keystroke-driven search — `InstrumentHistoryStatus.tsx`'s
 * own `refetchInterval` is what stops the polling itself (three conditions:
 * terminal status, unmount, 2-minute ceiling); this only ensures an
 * in-flight request is not left dangling if the query is purged mid-flight.
 */
export function fetchInstrumentHistoryStatus(
  instrumentId: string,
  signal?: AbortSignal,
): Promise<HistoryStatusResponse> {
  return apiFetch<HistoryStatusResponse>(
    `/instruments/${instrumentId}/history-status`,
    undefined,
    signal,
  );
}

/**
 * IB5/IB13 (FR-179–FR-187) — `POST
 * /api/v1/instruments/:id/history-reload`. Mirrors
 * `api/src/instruments/instruments.schema.ts`'s
 * `HistoryReloadAcceptedResponse` field for field.
 *
 * **`202`, and nothing is fetched synchronously**: the reload is *enqueued*,
 * and the price rows land minutes later when the worker writes them. So the
 * only thing that changes at the instant this resolves is the instrument's
 * own backfill status (`PENDING`) — which is exactly, and only, what
 * `instrumentHistoryReloadMutationOptions` invalidates.
 *
 * The four rejections are distinguishable by `code` (FR-183) and each has its
 * own French message in `problem-messages.ts`: `503
 * MARKET_DATA_NOT_CONFIGURED`, `404 INSTRUMENT_NOT_FOUND` (a row that does
 * not exist **or** is another tenant's — deliberately indistinguishable, so
 * the route is not an existence oracle), `400
 * INSTRUMENT_NOT_BACKFILLABLE` (an `SCPI`, priced by hand — INDEX shed that
 * answer with the benchmark overlay's removal, FUND with OPCVM pricing), `409
 * HISTORY_RELOAD_IN_PROGRESS`. (The 5/hour rate cap has since been removed.)
 *
 * No request body: the route takes none (`@Post(":id/history-reload")` with
 * no `@Body()`), so none is sent.
 */
export interface HistoryReloadAcceptedResponse {
  readonly instrumentId: string;
  readonly status: "PENDING";
  readonly previousStatus: "NONE" | "PENDING" | "COMPLETE" | "FAILED";
  readonly requestedFrom: string;
  /** `false` ⇒ a job for this instrument was already queued/active under the exclusive singleton key, and *that* job performs the reload against the row this request just reset. */
  readonly enqueued: boolean;
}

export function requestInstrumentHistoryReload(
  instrumentId: string,
): Promise<HistoryReloadAcceptedResponse> {
  return apiFetch<HistoryReloadAcceptedResponse>(`/instruments/${instrumentId}/history-reload`, {
    method: "POST",
  });
}

/**
 * `PriceHistoryPointResponse` — `api/src/instruments/instruments.schema.ts`'s
 * response shape for both `POST` and `GET /instruments/:id/prices`
 * (UR-13). `close` is a
 * decimal string (never a JSON number, NFR-12/AC53); `origin` distinguishes a
 * tenant's own manually entered point from an automated one — the field
 * AC104's `PricePointTable` (UR-14) renders per row.
 */
export interface PriceHistoryPointResponse {
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
  readonly sourceKey: string;
  readonly origin: "MANUAL" | "AUTOMATED";
}

/**
 * `POST /api/v1/instruments/:id/prices` (FR-111..FR-114, AC103, UR-13) —
 * T-36's `upsertManualPricePoint`, reachable from the UI for the first time
 * this cycle. This route is an **upsert** on
 * `(tenantId, instrumentId, priceDate)` — a second call for the same date
 * replaces the first, always returning `201`, with **no create-vs-overwrite
 * signal** in the response. `sourceKey` is never sent — the server forces it
 * to `"manual"` unconditionally (`manual-price-service.ts`).
 */
export interface PostManualPricePointInput {
  readonly instrumentId: string;
  readonly priceDate: string;
  readonly close: string;
  readonly currency: string;
}

export function postManualPricePoint(
  input: PostManualPricePointInput,
): Promise<PriceHistoryPointResponse> {
  return apiFetch<PriceHistoryPointResponse>(`/instruments/${input.instrumentId}/prices`, {
    method: "POST",
    body: JSON.stringify({
      priceDate: input.priceDate,
      close: input.close,
      currency: input.currency,
    }),
  });
}

export interface InstrumentPricesRangeParams {
  readonly from?: string;
  readonly to?: string;
}

/**
 * The largest `?limit=` `GET /instruments/:id/prices` accepts
 * (`instruments.controller.ts`'s shared `MAX_PAGE_LIMIT` = 100, same value
 * `fetchPortfolios`'s own `PORTFOLIOS_PAGE_LIMIT` mirrors for a different
 * route) — requested on every page to keep round-trips at a minimum.
 */
const INSTRUMENT_PRICES_PAGE_LIMIT = 100;

/**
 * The endpoint defaults to a 1-year window and the recorded
 * rule ("if a full 1-year window needs more than one page, the fetch
 * must carry both a hard page cap and a cursor-advance guard from the moment
 * it is written", `fetchPortfolios`'s `PORTFOLIOS_MAX_PAGES` the precedent) —
 * a 1-year EOD series (~250 trading days) needs ~3 pages at
 * {@link INSTRUMENT_PRICES_PAGE_LIMIT}; 4 leaves one page of headroom without
 * ever trusting the server to terminate the loop on its own.
 */
const INSTRUMENT_PRICES_MAX_PAGES = 4;

/**
 * {@link INSTRUMENT_PRICES_MAX_PAGES} under its exported name — the default
 * `instrumentPriceWindowQueryOptions` states in its own signature now that the
 * cap is a caller-supplied parameter there. Same value, one declaration.
 */
export const INSTRUMENT_PRICES_DEFAULT_MAX_PAGES = INSTRUMENT_PRICES_MAX_PAGES;

/**
 * The benchmark overlay's own page cap, passed explicitly by
 * `PerformanceView.tsx` and by nobody else — {@link INSTRUMENT_PRICES_MAX_PAGES}
 * stays the default for every existing call site, the sparkline included.
 *
 * **Why raising it here was the honest choice, and truncating was not.** The
 * route serves ascending by `priceDate`, so a window cut short at the page cap
 * loses its **recent** end: a 5-year benchmark under a 4-page cap would draw
 * ~400 trading days from 2021 and then simply stop, four fifths of the way to
 * the left of a chart whose portfolio line runs the whole way. A note under a
 * line that visibly ends early is not the same class of honesty as the
 * sparkline's own truncated 1-year window (which stops a few days short of a
 * window it very nearly covered) — here it would make the comparison the
 * benchmark exists for unreadable on three of the six presets.
 *
 * 40 pages × 100 = 4,000 points covers ~15.9 years of trading days, i.e. the
 * whole of `period-presets.ts`'s widest window (`RETURN_WINDOW_MAX_SPAN_YEARS`
 * = 15), so `truncated` should never be set here in practice — it stays
 * plumbed and rendered anyway, because "should never" is not "cannot".
 *
 * **What it costs.** Up to 40 sequential GETs on a cheap-read-class route,
 * once per (benchmark, range) pair and then cached by TanStack Query, only
 * when the user has explicitly asked for a benchmark. The server's only
 * generic 429 is the instance-wide admission bound, a *concurrency*
 * bound, not a rate cap, so a sequential walk cannot 429 itself; the client-side cost is one
 * `cheapReadBudget` slot (of 4) held for the duration of the walk, which is
 * the same shape the sparkline's own 4-page walk already has.
 */
// Not exported since the benchmark overlay was removed: the ceiling still
// bounds `instrumentPricePageCapForMonths` below, and the reasoning above is
// why that ceiling is 40.
const BENCHMARK_PRICES_MAX_PAGES = 40;

/**
 * The page cap for a price window of `months` months — what the instrument
 * screen's range control needs now that it offers 3A and 5A.
 *
 * {@link INSTRUMENT_PRICES_MAX_PAGES} is sized for one year and stays the
 * default; a 5-year window under it would draw ~400 trading days from five
 * years ago and stop, which is the exact failure
 * {@link BENCHMARK_PRICES_MAX_PAGES}'s own comment refused for the benchmark
 * overlay. Rather than a second hand-tuned constant, the cap is derived from
 * the window on exactly the arithmetic {@link INSTRUMENT_PRICES_MAX_PAGES} was
 * itself chosen by: **~22 trading days per month, plus one page of headroom**.
 * A year therefore lands back on the 4 pages it has always taken (12 × 22 =
 * 264 -> 3 + 1), every shorter range clamps up to that same 4, and 5 years
 * resolves to 15 — no existing range's request changed. A window whose merged
 * manual points push it past the estimate still reports `truncated` and the
 * chart still flags it, which is the property that makes an estimate safe here.
 *
 * Never above {@link BENCHMARK_PRICES_MAX_PAGES}: that is the ceiling this
 * codebase has already reasoned about for a sequential walk on a cheap-read
 * route, and nothing here needs a wider window than the benchmark's 15 years.
 */
export function instrumentPricePageCapForMonths(months: number): number {
  const pages = Math.ceil((months * 22) / INSTRUMENT_PRICES_PAGE_LIMIT) + 1;
  if (pages < INSTRUMENT_PRICES_MAX_PAGES) return INSTRUMENT_PRICES_MAX_PAGES;
  return pages > BENCHMARK_PRICES_MAX_PAGES ? BENCHMARK_PRICES_MAX_PAGES : pages;
}

/**
 * What {@link listInstrumentPriceWindow} returns: the points it actually
 * collected, plus whether the scan stopped at
 * {@link INSTRUMENT_PRICES_MAX_PAGES} while the server's own cursor was still
 * advancing — i.e. whether the window shown is genuinely the whole window.
 *
 * `listInstrumentPrices` below deliberately does **not** expose this (its
 * callers, `PricePointTable.tsx` and `ManualPriceForm.tsx`'s single-date
 * pre-check, render a list/lookup where a missing tail is visible as a
 * shorter list rather than a mis-drawn shape). A *chart* is different: a
 * silently truncated series looks exactly like a complete one, which is why
 * UR-29 needs the flag and asks for an explicit note when it is set.
 */
export interface InstrumentPriceWindow {
  readonly points: readonly PriceHistoryPointResponse[];
  readonly truncated: boolean;
}

/**
 * `GET /api/v1/instruments/:id/prices?from=&to=&cursor=&limit=` (FR-112,
 * AC104, UR-13/UR-29) — the merged automated + this tenant's manual price
 * history, exhausted here rather than left to the caller. Same "hard cap, and
 * the loop only advances on a cursor that actually changed" guard
 * `portfolios.ts`'s `fetchPortfolios` uses, so a misbehaving/mocked server that omits
 * `nextCursor` or repeats one cannot loop forever; `truncated` reports the
 * one case that guard cannot distinguish on its own — a page cap reached
 * while the server still had more to give (`queries.ts`'s
 * `TRANSACTIONS_SCAN_MAX_PAGES` scan carries the identical flag for the same
 * reason).
 *
 * `maxPages` defaults to {@link INSTRUMENT_PRICES_MAX_PAGES}; the instrument
 * screen's long ranges pass {@link instrumentPricePageCapForMonths}'s derived
 * cap instead (the benchmark overlay, since removed, was the first caller
 * to raise it — see {@link BENCHMARK_PRICES_MAX_PAGES} for the ceiling).
 */
export async function listInstrumentPriceWindow(
  instrumentId: string,
  params: InstrumentPricesRangeParams = {},
  signal?: AbortSignal,
  maxPages: number = INSTRUMENT_PRICES_MAX_PAGES,
): Promise<InstrumentPriceWindow> {
  const items: PriceHistoryPointResponse[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: String(INSTRUMENT_PRICES_PAGE_LIMIT) });
    if (params.from !== undefined) query.set("from", params.from);
    if (params.to !== undefined) query.set("to", params.to);
    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await apiFetch<{
      items: PriceHistoryPointResponse[];
      nextCursor: string | null;
    }>(`/instruments/${instrumentId}/prices?${query.toString()}`, undefined, signal);
    items.push(...response.items);
    const next = response.nextCursor;
    if (typeof next !== "string" || next === "" || next === cursor) break;
    cursor = next;
    if (page === maxPages - 1) truncated = true;
  }
  return { points: items, truncated };
}

/**
 * The list-shaped view of {@link listInstrumentPriceWindow}, unchanged for
 * its existing callers: `PricePointTable.tsx` (UR-14) and its own single-date
 * pre-check (AC129) both need every point in the requested window, not one
 * page of it, and neither renders a truncation claim.
 */
export async function listInstrumentPrices(
  instrumentId: string,
  params: InstrumentPricesRangeParams = {},
  signal?: AbortSignal,
): Promise<PriceHistoryPointResponse[]> {
  const { points } = await listInstrumentPriceWindow(instrumentId, params, signal);
  return [...points];
}
