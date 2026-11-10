import { queryOptions, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import {
  fetchCurrencies,
  fetchInstrument,
  fetchInstrumentHistoryStatus,
  listInstrumentCatalogue,
  listInstrumentPrices,
  listInstrumentPriceWindow,
  INSTRUMENT_PRICES_DEFAULT_MAX_PAGES,
  postManualPricePoint,
  requestInstrumentHistoryReload,
  searchInstrumentDiscovery,
  searchInstruments,
  setInstrumentIcon,
  deleteInstrument,
  deleteInstrumentIcon,
  updateInstrumentClassification,
  updateInstrumentIdentity,
  updateInstrumentScpiAttributes,
  type HistoryReloadAcceptedResponse,
  type InstrumentCatalogueParams,
  type InstrumentDetailResponse,
  type InstrumentIconMetaResponse,
  type SetInstrumentIconInput,
  type PostManualPricePointInput,
  type PriceHistoryPointResponse,
  type UpdateInstrumentClassificationInput,
  type UpdateInstrumentIdentityInput,
  type UpdateInstrumentScpiAttributesInput,
} from "../api-client.js";
import { invalidatePortfolioDerivedFigures } from "../invalidate-derived.js";
import { meetsInstrumentSearchMinimum } from "../quick-search.js";
import { cheapReadBudget, type RequestBudget } from "../request-budget.js";

/**
 * T-44's transaction form instrument picker — `GET /instruments?query=`
 * (T-37). Disabled for an empty/whitespace-only query so the picker does not
 * fire a search on every keystroke of an empty field.
 *
 * LOW-2 (security review): the 250ms debounce on the search
 * input itself lives in `TransactionForm.tsx` (`InstrumentPicker`'s own
 * `query` state), not here — this stays a plain, synchronous mapping from
 * "current committed search text" to query options, same as every other
 * `*QueryOptions` function in this file. Uncancellable before `api-client.ts`'s
 * `signal` threading: every keystroke's request ran to completion regardless
 * of whether a newer keystroke had already superseded it (pre-ADR-0009, this
 * also needlessly wrote one `instruments?query=...` entry per keystroke into
 * Cache Storage, since this query key changes per keystroke) — now cancelled
 * the moment TanStack Query itself decides the previous key's query is no
 * longer wanted (`enabled`/query key change deactivates the old observer).
 */
export function instrumentSearchQueryOptions(query: string) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: ["instruments", "search", trimmed] as const,
    queryFn: ({ signal }) => searchInstruments(trimmed, signal),
    enabled: trimmed.length > 0,
  });
}

/**
 * `QuickSearch.tsx`'s instrument half (UR-37,
 * UR-37). Reuses
 * `searchInstruments` — the same `GET /instruments?query=` catalogue search
 * {@link instrumentSearchQueryOptions} above already wraps — but as its
 * **own** factory rather than that shared one, for two reasons neither of
 * which is cosmetic:
 *
 * 1. **A different gate.** `instrumentSearchQueryOptions` backs picker
 *    fields (`TransactionForm`/`TransactionEditForm`/`LedgerFilterBar`) and
 *    enables on any non-empty trimmed string; those pickers exist to
 *    *resolve* an instrument the user already knows, not to search broadly,
 *    so a 1- or 2-character query there is harmless (a small, already-scoped
 *    result set behind a form field). The quick-nav palette is reachable
 *    from **every** screen and is exactly the "hammer the unindexed... query
 *    at volume" surface `instruments.schema.ts`'s own F5/N1 hardening exists
 *    against — so this factory enables only at
 *    {@link meetsInstrumentSearchMinimum}'s ≥3-alphanumeric floor, the
 *    client-side mirror of that same server gate (`quick-search.ts`).
 * 2. **A different priority.** The picker fields are a user actively filling
 *    a form — urgent, in-flow. The palette is a global, always-available
 *    convenience, the same category that already holds
 *    `instrumentByIdQueryOptions`/`instrumentHistoryStatusQueryOptions`
 *    in — `background` priority through `cheapReadBudget`, so opening the
 *    palette can never itself starve a screen's own primary reads.
 *
 * `["instruments", "quick-search", trimmed]` is its own key prefix, distinct
 * from `["instruments", "search", trimmed]` above — sharing a key would mean
 * a picker's 1-character query and the palette's own (withheld) query could
 * collide on the same cache entry with two different `enabled` intentions.
 *
 * `budget` is the same test-only override convention as this file's other
 * `background`-priority factories. `retry: false` — the same "a
 * shared-budget background read must fail fast" reasoning
 * `instrumentDiscoveryQueryOptions`/`instrumentHistoryStatusQueryOptions`
 * already document for theirs: retrying into an `ADMISSION_BOUND_EXCEEDED` 429
 * only compounds the saturation it reports.
 */
export function quickSearchInstrumentsQueryOptions(
  query: string,
  budget: RequestBudget = cheapReadBudget,
) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: ["instruments", "quick-search", trimmed] as const,
    queryFn: ({ signal }) =>
      budget.run("background", signal, () => searchInstruments(trimmed, signal)),
    enabled: meetsInstrumentSearchMinimum(trimmed),
    retry: false,
  });
}

/**
 * IB11 (FR-188/FR-190) — the Instruments screen's **catalogue mode** primary read.
 *
 * **`foreground` priority, through the one existing `cheapReadBudget`.** In
 * catalogue mode this list *is* the screen — the same role `listTransactions`
 * plays for the Activity ledger, and it takes the same priority. The per-row
 * `instrumentHistoryStatusQueryOptions` fan-out stays `background` through
 * the **same** budget instance, so the two tiers actually queue against each
 * other: the list is drained first, then the statuses. FR-190 is answered
 * structurally rather than by tuning — this cycle adds **no second
 * `RequestBudget`**, so peak in-flight in either mode, and across the
 * transition between them, stays bounded by that one semaphore's 4 (AC-18).
 *
 * `["instruments", "catalogue", query, kind, cursor]` — its own sub-namespace
 * under the `["instruments", …]` prefix, deliberately not the
 * `["instruments", "search", …]` key `instrumentSearchQueryOptions` owns: the
 * two return different shapes (a full page + cursor vs. a bare
 * `InstrumentSummary[]`), and sharing a key would hand one caller the other's
 * payload — the same reasoning `instrumentPriceWindowQueryOptions` records
 * for its own `"window"` segment. `null` rather than `undefined` in the key,
 * so an absent filter is a stable, serialisable key segment.
 *
 * No `staleTime`: the catalogue is shared reference data, but the row's
 * *page membership* moves with the filter, and a mode switch should not
 * re-render a page fetched under a filter that has since changed. `budget` is
 * the same test-only override convention as this file's other budgeted
 * factories.
 */
export function instrumentCatalogueQueryOptions(
  params: InstrumentCatalogueParams = {},
  budget: RequestBudget = cheapReadBudget,
) {
  return queryOptions({
    queryKey: [
      "instruments",
      "catalogue",
      params.query ?? null,
      params.kind ?? null,
      params.cursor ?? null,
    ] as const,
    queryFn: ({ signal }) =>
      budget.run("foreground", signal, () => listInstrumentCatalogue(params, signal)),
  });
}

/**
 * `CurrencySelect`'s data source (IC-13,
 * DD12) — `GET /currencies`'s ~180-row seeded ISO 4217 list only
 * ever changes on a migration, so `staleTime`/`gcTime` are both `Infinity`:
 * once fetched in a session, it is never
 * refetched or evicted, verified by `CurrencySelect.test.tsx`'s own
 * query-cache-configuration assertion (IC-13's acceptance criterion) rather
 * than merely trusted from this comment.
 */
export function currenciesQueryOptions() {
  return queryOptions({
    queryKey: ["currencies"] as const,
    queryFn: ({ signal }) => fetchCurrencies(signal),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * `InstrumentDiscoverySearch`'s data source (IC-14). `query` is trimmed here
 * (same "committed search text -> query options" convention
 * `instrumentSearchQueryOptions` already uses) and gated at the same 3-
 * character floor `GET /instruments/discovery`'s own `discoveryQuerySchema`
 * enforces server-side — an under-length query is never
 * even attempted, let alone debounced into one.
 *
 * `staleTime: 5 min` (NFR-1: repeated identical queries must not each
 * re-hit the provider) and `retry: false` (AC-7: a
 * `DISCOVERY_PROVIDER_RATE_LIMITED` must never be silently retried — retrying
 * a 429 would compound the very saturation it reports). The 400ms debounce
 * itself lives in `InstrumentDiscoverySearch.tsx`'s own component state
 * (`TransactionForm.tsx`'s `InstrumentPicker`/LOW-2 precedent), not here —
 * this function stays a plain, synchronous mapping from "current committed
 * kind+query" to query options, same as every other `*QueryOptions` function
 * in this file. `signal` is threaded through (MEDIUM-1 precedent), so a
 * superseded keystroke's request is genuinely aborted once TanStack Query
 * drops the old query key's last observer, exactly the mechanism
 * `instrumentSearchQueryOptions`'s own doc comment above already documents.
 */
export function instrumentDiscoveryQueryOptions(kind: string, query: string) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: ["instruments", "discovery", kind, trimmed] as const,
    queryFn: ({ signal }) => searchInstrumentDiscovery(kind, trimmed, signal),
    enabled: trimmed.length >= 3,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * `instrument-names.ts`'s `useInstrumentNames` resolver's data source
 * (UR-9). `["instruments",
 * instrumentId]` is the **same** key the Instruments list (UR-27) and the
 * Instrument detail route (UR-28) now also reuse — "one
 * key, one fetch, two consumers" (now three), not a separate namespace per
 * screen. `fetchInstrument` was widened from a name-only trim to every
 * `GET /instruments/:id` field precisely so those two later screens share
 * this one cache entry per id instead of each inventing their own; a name
 * already resolved by one screen therefore costs the other screen zero
 * extra requests. `staleTime`/`gcTime: Infinity` mirrors
 * `currenciesQueryOptions`'s own precedent above: an instrument's fields
 * change only by migration/admin action, never within a session, so a given
 * id is fetched at most once per session regardless of how many
 * rows/screens ask for it.
 *
 * `budget` is a test-only override — mirrors this codebase's existing
 * "escape hatch" convention for a hardcoded real dependency
 * (`ResponseCapOverrides`, `upsertManualPricePoint`'s own `maxRowsPerTenant`
 * parameter): every real call site takes the default, `cheapReadBudget`;
 * only a test wires a smaller/instrumented budget to make a
 * peak-concurrency assertion tractable without a full network harness.
 */
export function instrumentByIdQueryOptions(
  instrumentId: string,
  budget: RequestBudget = cheapReadBudget,
) {
  return queryOptions({
    queryKey: ["instruments", instrumentId] as const,
    queryFn: ({ signal }) =>
      budget.run("background", signal, () => fetchInstrument(instrumentId, signal)),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * `InstrumentHistoryStatus.tsx`'s data source (IC-12/IC-16). Deliberately
 * carries no `refetchInterval`/`staleTime` of its own — the poll cadence,
 * its three stop conditions (terminal status, unmount, 2-minute ceiling),
 * and the ceiling's own per-mount clock are `InstrumentHistoryStatus.tsx`'s
 * own concern (they need a `useRef` tied to *that* component instance's
 * lifecycle, which a stateless query-options factory cannot hold), so that
 * component spreads this factory's output and overrides `refetchInterval`
 * itself, the same "factory supplies the fetch, the component supplies
 * anything mount-lifecycle-shaped" split `instrumentDiscoveryQueryOptions`'s
 * own debounce (component-owned) vs. cache (factory-owned) split already
 * uses above.
 *
 * UR-11: the fetch itself now routes through
 * `cheapReadBudget` at `background` priority — the root-cause fix for
 * `holdings-history-status-request-volume.spec.ts`'s documented 20-poller,
 * no-client-cap fan-out on a 30-holding view. `budget` is a test-only
 * override, same convention as `instrumentByIdQueryOptions` above.
 */
export function instrumentHistoryStatusQueryOptions(
  instrumentId: string,
  budget: RequestBudget = cheapReadBudget,
) {
  return queryOptions({
    queryKey: ["instruments", instrumentId, "history-status"] as const,
    queryFn: ({ signal }) =>
      budget.run("background", signal, () => fetchInstrumentHistoryStatus(instrumentId, signal)),
    // Root-cause fix (tester's second
    // finding): this factory's default used to be TanStack Query's own
    // 3-retries-with-exponential-backoff. That default is wrong for a
    // background poll that already has its own retry mechanism —
    // `InstrumentHistoryStatus.tsx`'s `refetchInterval` re-issues this same
    // request every `POLL_INTERVAL_MS` (3s) regardless of the previous
    // attempt's outcome, up to its own 2-minute ceiling. Stacking three more
    // retries (1s/2s/4s backoff) on top of that, for every one of up to 20
    // concurrent pollers on a realistic holdings view, only *amplifies* a
    // `ADMISSION_BOUND_EXCEEDED` 429 burst — retrying a rate-limit response is
    // never correct (the same reasoning `instrumentDiscoveryQueryOptions`
    // above already documents for its own `retry: false`, and this factory
    // shares the exact same shared-tenant-budget hazard, the instrument-create-ux
    // request-volume finding). `retry: false` lets the
    // component's own poll cadence be the sole retry mechanism.
    retry: false,
  });
}

/**
 * `PricePointTable.tsx`'s data source (UR-13/UR-14,
 * the "priority assignment is per query-options factory, never
 * per call site" rule): every caller of this factory — the dialog's own
 * merged history table (no `from`/`to`, the server's 1-year default) and its
 * single-date replace-warning pre-check (AC129, `from === to`, the exact
 * date being entered) — gets the same `background` priority, because both
 * are the same factory, not two.
 *
 * `["instruments", instrumentId, "prices", from, to]` — the `["instruments",
 * instrumentId]` prefix this file's own `instrumentByIdQueryOptions` already
 * establishes, `"prices"` as its own sub-resource (by
 * convention), `from`/`to` last since they vary the window, not the
 * resource. `budget` is the same test-only override convention as this
 * file's other `background`-priority factories.
 */
export function instrumentPricesQueryOptions(
  instrumentId: string,
  from?: string,
  to?: string,
  budget: RequestBudget = cheapReadBudget,
) {
  return queryOptions({
    queryKey: ["instruments", instrumentId, "prices", from ?? null, to ?? null] as const,
    queryFn: ({ signal }) =>
      budget.run("background", signal, () =>
        listInstrumentPrices(instrumentId, { from, to }, signal),
      ),
  });
}

/**
 * `InstrumentPriceSparkline.tsx`'s data source (UR-29) — the
 * same route as `instrumentPricesQueryOptions` above, at the same
 * `background` priority through `cheapReadBudget`, but returning
 * `listInstrumentPriceWindow`'s `{ points, truncated }` rather than a bare
 * array: a chart that silently drops the tail of its window looks exactly
 * like a complete one, so the sparkline needs the page-cap signal in order to
 * say so (see `api-client.ts`'s own note on why the list-shaped caller does
 * not).
 *
 * `maxPages` is the caller's, sized from the window it asked for
 * (`instrumentPricePageCapForMonths`): the instrument screen's range control
 * offers 3A and 5A, and the 4-page default would answer either with ~400 points
 * from the far end of the window and set `truncated` — see that helper for why
 * a derived cap beat a second hand-tuned constant. It is **part of the query
 * key**: two caps over the same window return genuinely different payloads (one
 * possibly truncated), and sharing a key would serve the narrower answer to the
 * wider request — the same hazard the `"window"` segment below exists for, one
 * level down.
 *
 * `["instruments", instrumentId, "prices", "window", from, to, maxPages]` — a distinct
 * `"window"` segment under the same `["instruments", instrumentId, "prices"]`
 * prefix, deliberately **not** the same key as `instrumentPricesQueryOptions`
 * with the same `from`/`to`: the two factories return different shapes, and
 * sharing a key would hand one caller the other's payload. The shared prefix
 * is what matters for invalidation — `postManualPricePointMutationOptions`
 * below invalidates `["instruments", id, "prices"]`, which covers this key
 * too, so a freshly entered manual point redraws the chart as well as the
 * table.
 */
export function instrumentPriceWindowQueryOptions(
  instrumentId: string,
  from: string,
  to: string,
  maxPages: number = INSTRUMENT_PRICES_DEFAULT_MAX_PAGES,
  budget: RequestBudget = cheapReadBudget,
) {
  return queryOptions({
    queryKey: ["instruments", instrumentId, "prices", "window", from, to, maxPages] as const,
    queryFn: ({ signal }) =>
      budget.run("background", signal, () =>
        listInstrumentPriceWindow(instrumentId, { from, to }, signal, maxPages),
      ),
  });
}

/**
 * `ManualPriceForm.tsx`'s submit mutation (UR-13). Unlike
 * every `*QueryOptions` factory above (a `queryFn` alone, no client
 * dependency), a mutation's `onSuccess` needs a `QueryClient` to invalidate
 * what the write just changed — the only mutation-options factory in this
 * file so far; `TransactionForm.tsx`/`InstrumentCreateForm.tsx`/
 * `PortfolioNameForm.tsx` still build their own inline `useMutation` calls
 * (no existing "shared mutation options" convention this could otherwise
 * follow), so this one takes `queryClient` as an explicit parameter rather
 * than inventing one.
 *
 * `invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false })`
 * — **never `true`** (see `invalidate-
 * derived.ts`'s doc comment): `upsertManualPricePoint` never touches
 * `calc_epoch`, so routing this through the epoch-verified path would
 * exhaust its 3-attempt retry budget on every successful entry and surface a
 * spurious "freshness could not be confirmed" notice for a write that was
 * never going to move the epoch. The caller renders no freshness claim from
 * this — see that file's own header for why `{ verified: true }` here is
 * vacuous, not a confirmation.
 *
 * Also invalidates `["instruments", instrumentId, "prices"]` (every window)
 * so a freshly entered point appears in the merged price-history list
 * (`PricePointTable.tsx`) without a manual reload.
 */
/**
 * The three query keys a classification correction invalidates — named here as
 * data so the form's own test can assert exactly this set, rather than
 * re-deriving three string arrays a component could quietly drift from.
 *
 * Why these three, and what each one is actually
 * for on this app's surfaces:
 *
 *  1. `["instruments", instrumentId]` — the instrument detail view's own read,
 *     **and** every instruments-list row's content: `InstrumentsView` builds
 *     its rows from `instrumentByIdQueryOptions` per id (`InstrumentTable.tsx`
 *     reads `row.detail.sectorCode`), so this one key refreshes both surfaces.
 *  2. `["instruments", "search"]` — the catalogue-search result sets
 *     (`GET /instruments?query=`) behind the pickers and the quick-nav palette.
 *     Included because it is the *instruments-list* key on the wire; note that
 *     `InstrumentSummary` carries no classification field today, so this
 *     invalidation is correctness-by-construction rather than load-bearing —
 *     stated rather than left as a silent no-op.
 *  3. `["portfolios", "holdings"]` — the holdings surface and, through it, the
 *     exposure breakdown: `HoldingResponse` carries `sectorCode`/
 *     `domicileCountry`/`listingCountry`, so a corrected sector moves a bucket.
 *
 * Deliberately **not** `invalidatePortfolioDerivedFigures`: a classification
 * correction never touches `calc_epoch` (it moves no figure), and routing it
 * through the epoch-verified path would burn that helper's retry budget and
 * surface a spurious "freshness could not be confirmed" notice — the same
 * reasoning `postManualPricePointMutationOptions` below already records for
 * `epochWillAdvance: false`, taken one step further.
 */
export function instrumentClassificationInvalidationKeys(
  instrumentId: string,
): readonly (readonly string[])[] {
  return [
    ["instruments", instrumentId],
    ["instruments", "search"],
    ["portfolios", "holdings"],
  ];
}

/**
 * `InstrumentClassificationForm.tsx`'s submit mutation (IR-18,
 * DD30/DD31). Same shape as {@link postManualPricePointMutationOptions} below —
 * `networkMode: "always"` (a write path is never paused or replayed offline) and an `onSuccess` that invalidates what the write
 * actually changed, from {@link instrumentClassificationInvalidationKeys}.
 *
 * **The shared catalogue is not fixed here (C27, NG11).**
 * `instrument` rows are shared reference data, so this correction changes what
 * every tenant sees; the form says so in its own copy. Harmless while phase 1
 * is single-user (ADR-0014), and explicitly out of scope for this cycle.
 */
export function updateInstrumentClassificationMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<InstrumentDetailResponse, unknown, UpdateInstrumentClassificationInput> {
  return {
    mutationFn: updateInstrumentClassification,
    networkMode: "always",
    onSuccess: async (_data, variables) => {
      await Promise.all(
        instrumentClassificationInvalidationKeys(variables.instrumentId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  };
}

/**
 * The four query keys an identity edit invalidates (instrument-detail
 * identity edit, 2026-09-09) — `displayName` is the one field this app
 * renders on essentially every instrument surface, unlike a classification
 * correction's narrower reach, so this set is the union of
 * {@link instrumentClassificationInvalidationKeys}'s `"search"` key and
 * {@link instrumentIconInvalidationKeys}'s `"catalogue"` key: both `search`
 * (`InstrumentSummary.displayName` — the pickers, the quick-nav palette) and
 * `catalogue` (`InstrumentTable.tsx` rows) show it, on top of the detail read
 * and the holdings surfaces both existing sets already cover.
 *
 * Deliberately **not** `invalidatePortfolioDerivedFigures`: neither
 * `displayName` nor `figi` is a figure and neither touches `calc_epoch`,
 * exactly the reasoning `instrumentClassificationInvalidationKeys` and
 * `instrumentIconInvalidationKeys` already record.
 */
export function instrumentIdentityInvalidationKeys(
  instrumentId: string,
): readonly (readonly string[])[] {
  return [
    ["instruments", instrumentId],
    ["instruments", "search"],
    ["instruments", "catalogue"],
    ["portfolios", "holdings"],
  ];
}

/**
 * `InstrumentIdentityForm.tsx`'s submit mutation. Same shape as
 * {@link updateInstrumentClassificationMutationOptions} above:
 * `networkMode: "always"` (a write path is never paused or replayed offline) and an `onSuccess` that invalidates exactly what the
 * write changed, from {@link instrumentIdentityInvalidationKeys}.
 *
 * **The shared catalogue is not fixed here either (C27, NG11).**
 * `instrument` rows are shared reference data, so a rename or a figi fill
 * changes what every tenant sees — the same stated-not-fixed consequence
 * `updateInstrumentClassificationMutationOptions` already records, harmless
 * while phase 1 is single-user (ADR-0014).
 */
export function updateInstrumentIdentityMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<InstrumentDetailResponse, unknown, UpdateInstrumentIdentityInput> {
  return {
    mutationFn: updateInstrumentIdentity,
    networkMode: "always",
    onSuccess: async (_data, variables) => {
      await Promise.all(
        instrumentIdentityInvalidationKeys(variables.instrumentId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  };
}

/**
 * `InstrumentScpiAttributesForm.tsx`'s submit mutation (scpi cycle,
 * SCD-8). Same shape as {@link updateInstrumentClassificationMutationOptions}:
 * `networkMode: "always"`, and an `onSuccess` that invalidates
 * `["instruments", id]` — the detail rows and every instruments-list row read
 * that one key. The two attributes are descriptive only: no figure moves, no
 * `calc_epoch`, so neither the holdings nor `invalidatePortfolioDerivedFigures`.
 */
export function updateInstrumentScpiAttributesMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<InstrumentDetailResponse, unknown, UpdateInstrumentScpiAttributesInput> {
  return {
    mutationFn: updateInstrumentScpiAttributes,
    networkMode: "always",
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["instruments", variables.instrumentId] });
    },
  };
}

/**
 * The three query keys an icon set, replace or removal invalidates
 * (IK-15; FR-291,
 * FR-296, FR-306–FR-309) — named here as data so
 * `routes/instrument-icon-invalidation.test.tsx` can assert exactly this set
 * rather than re-deriving three string arrays a component could drift from.
 * Same shape and same reasoning as
 * {@link instrumentClassificationInvalidationKeys} above.
 *
 * **`["instruments", instrumentId]` is not optional here, and the reason is a
 * pre-existing cache setting this feature activates rather than a defect of
 * this cycle's own code.** {@link instrumentByIdQueryOptions} sets
 * `staleTime: Infinity, gcTime: Infinity` — correct for an instrument's
 * catalogue fields, which change only by migration or admin action, and now
 * carrying one field that changes whenever the user presses a button on this
 * very screen. Without this key an icon set or removal is invisible on the
 * identity card **and** on every instruments-list row (both read that one key)
 * **for the lifetime of the tab**, while the holdings surfaces update fine.
 * That asymmetry is exactly how a five-surface acceptance criterion passes on
 * two surfaces and reads as green, which is why the no-reload test asserts the
 * identity card and a list row and not only the holdings table.
 *
 *  1. `["instruments", instrumentId]` — the detail view's own read and every
 *     instruments-list row's content (`InstrumentsView` builds its rows from
 *     `instrumentByIdQueryOptions` per id, and `InstrumentTable` reads
 *     `row.detail.hasIcon`), so this one key refreshes two of the five
 *     surfaces.
 *  2. `["instruments", "catalogue"]` — catalogue-mode rows come from
 *     `GET /instruments`, whose `InstrumentResponse` carries `hasIcon` (IK-10),
 *     so a catalogue page held in cache would otherwise keep the old flag.
 *  3. `["portfolios", "holdings"]` — `HoldingResponse.hasIcon` feeds both
 *     holdings presentations, the dashboard and top positions.
 *
 * `["instruments", "search"]` is deliberately **omitted**, stated rather than
 * left as a silent no-op (the convention
 * {@link instrumentClassificationInvalidationKeys} already uses for the
 * mirror-image case): `InstrumentSummary` carries no `hasIcon` at all, and the
 * surfaces it feeds — the pickers, the quick-nav palette, the asset-search
 * popover — are explicit non-goals of this cycle (NG2), so invalidating it
 * would refetch three result sets to change nothing.
 *
 * Deliberately **not** `invalidatePortfolioDerivedFigures`, with or without
 * `epochWillAdvance`: an icon moves no figure and touches no `calc_epoch`, so
 * routing it through the epoch-verified helper would burn that helper's
 * 3-attempt retry budget on every successful write and surface a spurious
 * « fraîcheur non confirmée » for a write that was never going to move the
 * epoch — the same reasoning the two mutations above already record, applied
 * to a write that is even further from a figure than a classification is.
 */
export function instrumentIconInvalidationKeys(
  instrumentId: string,
): readonly (readonly string[])[] {
  return [
    ["instruments", instrumentId],
    ["instruments", "catalogue"],
    ["portfolios", "holdings"],
  ];
}

/**
 * `InstrumentIconForm.tsx`'s « Enregistrer » mutation — `PUT
 * /instruments/:id/icon` (FR-291(a)/(b)). Same shape as
 * {@link updateInstrumentClassificationMutationOptions} above:
 * `networkMode: "always"` (a write path is never paused or replayed offline) and an `onSuccess` that invalidates exactly what the
 * write changed, from {@link instrumentIconInvalidationKeys}.
 */
export function setInstrumentIconMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<InstrumentIconMetaResponse, unknown, SetInstrumentIconInput> {
  return {
    mutationFn: setInstrumentIcon,
    networkMode: "always",
    onSuccess: async (_data, variables) => {
      await Promise.all(
        instrumentIconInvalidationKeys(variables.instrumentId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  };
}

/**
 * `InstrumentIconForm.tsx`'s « Supprimer l'icône » mutation — `DELETE
 * /instruments/:id/icon` (FR-291(c)).
 *
 * The **same** key list as the set direction, and that symmetry is
 * load-bearing rather than tidy: a one-directional invalidation passes a
 * removal-only test and leaves the other direction broken, which is why
 * `instrument-icon-invalidation.test.tsx` drives both.
 */
export function removeInstrumentIconMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<void, unknown, string> {
  return {
    mutationFn: deleteInstrumentIcon,
    networkMode: "always",
    onSuccess: async (_data, instrumentId) => {
      await Promise.all(
        instrumentIconInvalidationKeys(instrumentId).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  };
}

/**
 * `InstrumentDeleteDialog.tsx`'s « Supprimer l'instrument » mutation —
 * `DELETE /instruments/:id`.
 *
 * **What it invalidates, and the one thing it deliberately does not.** The
 * instrument is gone from the catalogue, from search, from its own detail
 * query and from the watchlist (`watchlist_item` cascades with it), so all
 * four are dropped. It is **not** routed through
 * `invalidatePortfolioDerivedFigures`: the server refuses (409) to delete an
 * instrument any transaction, posting, holding or realized gain references, so
 * a delete that *succeeded* moved no portfolio figure by construction — and
 * the epoch-verified helper would burn its 3-attempt retry budget and surface a
 * spurious « fraîcheur non confirmée » for a write that was never going to move
 * the epoch. That is the same reasoning the icon and classification mutations
 * above already record, and here it is not a judgement call but a consequence
 * of the endpoint's own refusal semantics.
 *
 * `["portfolios", "holdings"]` is dropped all the same, for the reason the icon
 * keys include it: a holdings row carries the instrument's display metadata,
 * and a stale name for a row that can no longer resolve one is worse than a
 * refetch.
 */
export function deleteInstrumentMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<void, unknown, string> {
  return {
    mutationFn: deleteInstrument,
    networkMode: "always",
    onSuccess: async (_data, instrumentId) => {
      await Promise.all(
        [
          ["instruments", instrumentId],
          ["instruments", "catalogue"],
          ["instruments", "search"],
          ["watchlist"],
          ["portfolios", "holdings"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  };
}

/**
 * IB13 (spec
 * FR-193, AC-15/AC-21) — `InstrumentReloadButton.tsx`'s mutation. Same shape
 * as {@link postManualPricePointMutationOptions} below: `networkMode:
 * "always"` (a write path is never paused or replayed offline;
 * the real `fetch()` is attempted immediately and
 * rejects immediately when offline, surfaced through `mutation.isError`).
 *
 * **`["instruments", instrumentId, "history-status"]` and nothing else.**
 * Deliberately **not** `invalidatePortfolioDerivedFigures`: the reload
 * advances no `calc_epoch` synchronously — the epoch that eventually moves is
 * the *market-data* one, bumped by the worker when price rows are actually
 * written, minutes later — so routing this through the epoch-verified path
 * would burn that helper's retry budget on every successful click and surface
 * a spurious "freshness could not be confirmed" notice for a write that was
 * never going to move a figure. The same reasoning
 * `postManualPricePointMutationOptions` records for `epochWillAdvance:
 * false`, taken one step further.
 *
 * **This one invalidation is the whole refresh mechanism on list surfaces**
 * (IB13): no `refetchInterval`, no `setInterval`, no per-row poller is added
 * anywhere by this cycle. `InstrumentHistoryStatus.tsx`'s own detail-surface
 * poller and its 2-minute per-mount ceiling are untouched; its
 * `refetchInterval` predicate simply re-evaluates against the freshly
 * invalidated data.
 */
export function instrumentHistoryReloadMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<HistoryReloadAcceptedResponse, unknown, string> {
  return {
    mutationFn: (instrumentId: string) => requestInstrumentHistoryReload(instrumentId),
    networkMode: "always",
    onSuccess: async (_data, instrumentId) => {
      await queryClient.invalidateQueries({
        queryKey: ["instruments", instrumentId, "history-status"],
      });
    },
  };
}

export function postManualPricePointMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<PriceHistoryPointResponse, unknown, PostManualPricePointInput> {
  return {
    mutationFn: postManualPricePoint,
    // A write path never pauses/replays offline (same `networkMode: "always"`
    // rationale `TransactionForm.tsx`/`InstrumentCreateForm.tsx` already
    // document): the real `fetch()` is attempted immediately and rejects
    // immediately when offline, surfaced via `mutation.isError`.
    networkMode: "always",
    onSuccess: async (_data, variables) => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: false }),
        queryClient.invalidateQueries({
          queryKey: ["instruments", variables.instrumentId, "prices"],
        }),
      ]);
    },
  };
}
