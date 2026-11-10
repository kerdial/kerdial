import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell.js";
import { OfflineBanner } from "./components/OfflineBanner.js";
import { UpdateToast } from "./components/UpdateToast.js";
import { LoginRoute } from "./routes/LoginRoute.js";
import { AccountRoute } from "./routes/AccountRoute.js";
import { AdminUsersRoute } from "./routes/AdminUsersRoute.js";
import { OverviewRoute } from "./routes/OverviewRoute.js";
import { HoldingsRoute } from "./routes/HoldingsRoute.js";
import { PortfoliosRoute } from "./routes/PortfoliosRoute.js";
import {
  PORTFOLIO_DETAIL_TABS,
  PortfolioDetailRoute,
  type PortfolioDetailTab,
} from "./routes/PortfolioDetailRoute.js";
import {
  IMPORT_FILE_TYPES,
  INSTRUMENT_KIND_VALUES,
  TRANSACTION_KIND_VALUES,
  type ImportFileTypeName,
  type InstrumentKind,
  type TransactionKind,
} from "@kerdial/api-contracts";
import {
  ACTIVITY_CALENDAR_MEASURES,
  ACTIVITY_VIEW_TABS,
  ActivityRoute,
  LEDGER_SORT_ORDERS,
  type ActivityCalendarMeasure,
  type ActivityViewTab,
  type LedgerSortOrder,
} from "./routes/ActivityRoute.js";
import { InstrumentsRoute } from "./routes/InstrumentsRoute.js";
import { INSTRUMENT_VIEW_MODES, type InstrumentViewMode } from "./routes/InstrumentsView.js";
import { InstrumentDetailRoute } from "./routes/InstrumentDetailRoute.js";
import { ControlsRoute } from "./routes/ControlsRoute.js";
import { CurrenciesRoute } from "./routes/CurrenciesRoute.js";
import { DividendsRoute } from "./routes/DividendsRoute.js";
import { WatchlistRoute } from "./routes/WatchlistRoute.js";
import { WatchlistAnalysisRoute } from "./routes/WatchlistAnalysisRoute.js";
import { authQueryOptions } from "./lib/queries.js";
import {
  DEFAULT_PERIOD_PRESET_ID,
  DEFAULT_WATCHLIST_WINDOW,
  WATCHLIST_WINDOW_PRESET_IDS,
  isKnownRangeId,
} from "./lib/period-presets.js";
import {
  asCurrencyCode,
  asDecimalAmount,
  asEnum,
  asIsoDate,
  asOpaqueCursor,
  asUuid,
} from "./lib/search-params.js";
import { PerformanceRoute } from "./routes/PerformanceRoute.js";
import { ImportRoute } from "./routes/ImportRoute.js";
import { IMPORT_WIZARD_STEPS, type ImportWizardStep } from "./routes/ImportWizard.js";

interface RouterContext {
  readonly queryClient: QueryClient;
}

/**
 * `OfflineBanner`/`UpdateToast` render here, at the very root — not inside
 * `AppShell` — so the service worker registers (`UpdateToast`'s
 * `useRegisterSW`) and the offline banner is available on *every* route,
 * including `/login`, not only once a session exists. PWA behaviour must
 * not be gated behind authentication (it is an app-wide
 * concern, not a per-screen one).
 */
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <OfflineBanner />
      <Outlet />
      <UpdateToast />
    </>
  ),
});

/** `/login` — public, no session required (mirrors `api`'s `@Public()` route). */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});

/**
 * Every route nested under here requires a session. `beforeLoad` probes
 * `GET /api/v1/auth/me` (via TanStack Query's cache, so a second navigation
 * does not refetch needlessly) and redirects to `/login` on any failure
 * (401 or otherwise) — the same "no session -> uniform rejection, no
 * distinguishing signal" property `AuthGuard` enforces server-side
 * (`api/src/auth/auth.guard.ts`) is preserved here: this guard does not
 * itself branch on *why* the probe failed.
 *
 * F9 (security review): `ensureQueryData` with no options of its
 * own never revalidates existing cached data, *ever* — not "up to
 * `staleTime`" as the plain `staleTime: 60_000` on `authQueryOptions` might
 * suggest, but indefinitely, since staleness is only ever consulted when
 * `revalidateIfStale` is set (`@tanstack/query-core`'s own
 * `ensureQueryData`: `if (cachedData === void 0) return fetchQuery(...)`,
 * otherwise always `Promise.resolve(cachedData)` unless told to check).
 * `revalidateIfStale: true` restores the *intended* behaviour: once the
 * cached `auth/me` answer is more than `staleTime` old, every subsequent
 * navigation kicks off a real background revalidation — if the session was
 * revoked server-side in the meantime, `main.tsx`'s global 401 handler (F4)
 * catches that revalidation's failure and evicts the session shortly after,
 * rather than never being asked again for as long as the tab stays open.
 * This does not change what the guard synchronously returns on that
 * navigation (`ensureQueryData` still resolves immediately with the cached,
 * possibly-stale, data — `query-core`'s `void this.prefetchQuery(...)` is
 * fire-and-forget), so it does not turn a nav into a blocking round trip,
 * and — critically — it does not spam `auth/me` on every navigation while
 * the cached answer is still fresh: `revalidateIfStale` only ever prefetches
 * once `query.isStaleByTime(...)` is actually true.
 *
 * F11 (security review): `gcTime: Infinity` (`queries.ts`) closes
 * the "cache entry silently evicted after 5 minutes, next call blocks
 * forever offline" hole for as long as the guard has fetched successfully
 * at least once in this tab — but the *very first* fetch of a page load (no
 * cached data yet at all) still takes the blocking `fetchQuery` path, which
 * can still hang indefinitely (offline pausing, or simply an unresponsive
 * server — the guard should not care *why* the probe never resolves).
 * `AUTH_GUARD_TIMEOUT_MS` is this guard's own fail-closed backstop for that
 * remaining case: past this window, treat it exactly like any other guard
 * failure and redirect to `/login` rather than freezing the navigation.
 *
 * Post-ADR-0009 correction: `gcTime: Infinity` means this entry (and every
 * other one with the same setting) is *never* evicted by inactivity alone —
 * in-memory eviction now comes entirely from the two explicit
 * `queryClient.clear()` call sites (`LoginRoute.tsx`'s `onSuccess`,
 * `main.tsx`'s global 401 handler), not from the retired Cache-Storage purge
 * machinery. Line 75-77 above ("evicts the session") is exactly that call.
 */
const AUTH_GUARD_TIMEOUT_MS = 10_000;

/**
 * 10s (security review — raised from an initial 5s):
 * 5s cut it too close to a legitimate, if slow, cold start (a cold
 * serverless/DB connection on the very first `auth/me` of a session is a
 * real, non-pathological case — evicting a genuine user for that is worse
 * than the rare freeze this guards against) and left the "slow but
 * legitimate" test case (`guard-revalidation.spec.ts`, a deliberately slow
 * 2s `auth/me`) uncomfortably close to the control value for a CI-run
 * Playwright suite, a flake risk that would only have gotten re-baselined
 * upward anyway. 10s keeps ample margin above that 2s case, and there is no
 * service-worker ceiling to align with here at all: `/api/v1/**` is
 * `NetworkOnly` for every method (`AR-20`), so no handler carries a
 * `networkTimeoutSeconds` at all. (This used to take its
 * margin against the general `NetworkFirst` rule's 3s `networkTimeoutSeconds`,
 * deleted along with the rule. The conclusion was already "no ceiling to align
 * with"; only the value it cited had gone.) This is an application-level
 * fail-closed *safety net* for a case that should be rare (a stale cache
 * entry, evicted or never populated, combined with a probe that never
 * resolves at all) — not a network-performance tuning knob, so erring
 * toward "rare freeze protection, comfortably tolerant of slow-but-real
 * traffic" over "fastest possible fail-closed" is the right trade here.
 */
function createGuardTimeout(): { timeout: Promise<never>; clear: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("authenticatedRoute guard timed out")),
      AUTH_GUARD_TIMEOUT_MS,
    );
  });
  return {
    timeout,
    clear: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
  };
}

/**
 * Races `probe` against the guard's own timeout, clearing the timer as soon
 * as the race is decided *either* way (`.finally(clear)` on the race itself,
 * not on the timeout promise alone) — otherwise every `beforeLoad`
 * invocation whose `probe` wins (the overwhelmingly common case — including
 * a mere `<Link>` hover preload, `defaultPreload: "intent"`) leaks one live
 * timer for the rest of the `AUTH_GUARD_TIMEOUT_MS` window, since the timer
 * itself only self-clears by firing. Trivial hygiene, no behavioural change.
 */
function raceGuard<T>(probe: Promise<T>): Promise<T> {
  const { timeout, clear } = createGuardTimeout();
  return Promise.race([probe, timeout]).finally(clear);
}

/**
 * Any guard failure (a 401, a genuine network error, or `AUTH_GUARD_TIMEOUT_MS`
 * firing on an unresponsive probe) redirects to `/login` uniformly — this
 * guard does not itself branch on *why* the probe failed, mirroring the
 * server-side `AuthGuard`'s own "no session -> uniform rejection" property.
 *
 * ADR-0009 Stage 1 (`AR-21`): this used to also run a defense-in-depth purge
 * here (HIGH-1(b), security review) before redirecting, in case
 * the previous session's `QueryClient`/Cache Storage entries survived for
 * whatever rendered next in this tab. That purge is retired along with the
 * rest of the machinery it belonged to (`session-cache.ts`'s own doc
 * comment): `vite.config.ts`'s `/api/v1/**` `NetworkOnly` rule means no
 * response is ever cached in the first place, so there is nothing left here
 * to purge.
 */
const authenticatedRoute = createRoute({
  id: "authenticated",
  getParentRoute: () => rootRoute,
  beforeLoad: async ({ context }) => {
    try {
      await raceGuard(
        context.queryClient.ensureQueryData({
          ...authQueryOptions(),
          revalidateIfStale: true,
        }),
      );
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

/**
 * `range` — T-45's period selector, tier 2
 * ("the date-range ... state ... lives in the URL, making views
 * linkable/refresh-safe"). Always resolves to a known preset id
 * (`period-presets.ts`) or, since the custom window, `CUSTOM`: an absent or unrecognised
 * value falls back to {@link DEFAULT_PERIOD_PRESET_ID} rather than ever
 * reaching `resolveRange` with something it would itself have to guess at.
 *
 * `from`/`to` carry the custom window, through the same `asIsoDate`
 * every other date param on this router passes through. They are validated
 * for *shape* only here — whether the pair is a window the server would serve
 * (ordered, not in the future, inside the epoch floor and the 25-year span) is
 * `resolveCustomRange`'s job, and a pair that fails it resolves to the default
 * preset's window rather than erroring. That split is deliberate: a
 * `validateSearch` that threw on a stale bookmark would blank the route
 * through the router's `CatchBoundary` (`search-params.ts`'s own convention).
 */
interface CustomRangeSearch {
  readonly range: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * The `{ range, from, to }` triple, validated once for the three screens that
 * offer a custom window — Aperçu, Performance and portfolio detail. Suivi is
 * deliberately not one of them (`GET /watchlist` takes a server-validated
 * `?window=` enum), so it keeps its own `asEnum` over
 * `WATCHLIST_WINDOW_PRESET_IDS`.
 */
function validateCustomRangeSearch(search: Record<string, unknown>): CustomRangeSearch {
  const from = asIsoDate(search["from"]);
  const to = asIsoDate(search["to"]);
  return {
    range: isKnownRangeId(search["range"]) ? search["range"] : DEFAULT_PERIOD_PRESET_ID,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

export const overviewRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/",
  validateSearch: validateCustomRangeSearch,
  component: OverviewRoute,
});

/**
 * `/performance`'s search: the shared `{ range, from, to }` triple plus, since
 * the per-portfolio view, an optional `portfolio` UUID — the one portfolio the screen isolates.
 * `asUuid` drops a malformed value (the screen falls back to the combined
 * view); a well-formed id that names no portfolio of this tenant is the
 * view's own fallback, not the router's, since only the list read can tell.
 */
interface PerformanceSearch extends CustomRangeSearch {
  readonly portfolio?: string;
}

function validatePerformanceSearch(search: Record<string, unknown>): PerformanceSearch {
  const portfolio = asUuid(search["portfolio"]);
  return {
    ...validateCustomRangeSearch(search),
    ...(portfolio === undefined ? {} : { portfolio }),
  };
}

/**
 * `/performance` — the dedicated destination for the return figures.
 * Same validated `range` preset the combined
 * overview uses, so the two screens cannot disagree about which window a
 * figure covers.
 *
 * It once had a `benchmark` UUID param here for the base-100 chart's
 * per-view benchmark; that chart was removed, and the param with it — an
 * unknown key is simply not carried, per `search-params.ts`'s convention.
 * It now carries `portfolio`, see {@link validatePerformanceSearch}.
 */
export const performanceRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/performance",
  validateSearch: validatePerformanceSearch,
  component: PerformanceRoute,
});

const holdingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/holdings",
  component: HoldingsRoute,
});

/** `/portfolios` (locked OQ-P3) — no search params: this screen has no linkable state. */
const portfoliosRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/portfolios",
  component: PortfoliosRoute,
});

/**
 * `/portfolios/$portfolioId` (UR-15) — a **flat sibling** of `/portfolios`, not nested under it: nesting
 * would require adding an `<Outlet/>` to `PortfoliosRoute.tsx` (a component
 * this feature otherwise only adds a `<Link>` to), and there is no shared
 * layout or shared data between list and detail a layout route would factor
 * out.
 *
 * `{ range, from, to, tab }` — the first three reuse the exact same
 * `validateCustomRangeSearch` validator/default `overviewRoute` above uses
 * (extended for the custom window); `tab`
 * is this route's own addition (OD-1(c): display state lives in the URL,
 * never `localStorage`) — an unrecognised/absent value falls back to
 * `"overview"`, the same "never throw, always a safe default" convention
 * every validator in `search-params.ts` follows.
 *
 * **No `loader` key** (no route declares one): `defaultPreload: "intent"`
 * below means a route `loader` runs on mere link hover — a hover that fanned
 * out `:id/overview`/`:id/holdings`/`:id/performance` would burn the shared
 * `valuationReadBudget` (bound 1) invisibly, on a navigation that may never
 * even happen. All data fetching here lives in `PortfolioDetailRoute.tsx`'s
 * own `useQuery` calls. `router.test.ts`'s source-text assertion enforces
 * this repo-wide, not only for this route.
 */
interface PortfolioDetailSearch extends CustomRangeSearch {
  readonly tab: PortfolioDetailTab;
}

export const portfolioDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/portfolios/$portfolioId",
  validateSearch: (search: Record<string, unknown>): PortfolioDetailSearch => ({
    ...validateCustomRangeSearch(search),
    tab: asEnum(search["tab"], PORTFOLIO_DETAIL_TABS) ?? "overview",
  }),
  component: PortfolioDetailRoute,
});

/**
 * `/activity` (UR-19) — the ledger.
 * Every filter (`portfolio`/`instrument`/`from`/`to`/`type`, plus the filters panel's
 * `currency`/`minAmount`/`maxAmount`) and pagination (`cursor`) and the open
 * detail panel (`tx`) live in the URL (OD-1(c)) — `search-params.ts`'s
 * validator primitives, never `localStorage`. Each one degrades to `undefined`
 * on an absent/malformed value rather than ever throwing (`search-params.ts`'s
 * own convention) — a hand-edited or bookmarked URL must never blank this
 * route.
 *
 * `type` is a closed enum, so it uses the same `asEnum` primitive
 * `portfolioDetailRoute`'s own `tab` search param already uses above — no
 * new validator shape. It was UR-19's *client-side-only* kind filter
 * (AC140) until the server gave
 * `GET /transactions` a `kind` parameter; the search param and its validator
 * are unchanged, but `ActivityView.tsx` now forwards it to the server rather
 * than narrowing the loaded page with it.
 *
 * ## The amount bounds are dropped when `currency` is absent
 *
 * `GET /transactions` refuses either bound without a currency — 422
 * `TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY` — because
 * `gross_amount` is stored in the trade's own denomination and the endpoint
 * converts nothing, so an unscoped bound would rank 1 000 JPY against
 * 1 000 EUR. `LedgerFiltersPanel` therefore keeps the amount inputs disabled
 * until a currency is chosen, and this validator closes the *other* way in:
 * a bookmarked or hand-edited `?minAmount=100` with no `currency=` degrades to
 * `undefined` here rather than travelling to the server and blanking the
 * ledger with an error banner. Same "malformed -> undefined, never throws"
 * convention as every validator above; the coupling is simply between two
 * params rather than inside one.
 *
 * **No `loader` key** — same rationale as `portfolioDetailRoute` above
 * (`router.test.ts`'s source-text assertion covers this route too, with no
 * change to that test needed).
 */
interface ActivitySearch {
  readonly portfolio?: string;
  readonly instrument?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly tx?: string;
  readonly type?: TransactionKind;
  /** The trade's own `txn_currency`, and the scope the two bounds below are read in. */
  readonly currency?: string;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  /** UR-38 ("Revenus & frais"): which of `ActivityView`'s two tabs is showing — `asEnum`'s own "unrecognised -> undefined" convention, same as every other closed-set param here. */
  readonly view?: ActivityViewTab;
  /**
   * The ledger's row order (`GET /transactions?order=`). Absent means the
   * screen's own default, **`"desc"`** — newest-first, which is what the ledger
   * screen shows: the server's default is ascending and FR-264 keeps it that
   * way for API callers, so the default lives in `ActivityView` rather than
   * here (this validator only ever narrows what the URL carries).
   */
  readonly sort?: LedgerSortOrder;
  /** What the « Calendrier » tab's cells encode (`count` | `volume`); absent means the view's own default, `count`. */
  readonly measure?: ActivityCalendarMeasure;
}

export const activityRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/activity",
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
    const currency = asCurrencyCode(search["currency"]);
    return {
      portfolio: asUuid(search["portfolio"]),
      instrument: asUuid(search["instrument"]),
      from: asIsoDate(search["from"]),
      to: asIsoDate(search["to"]),
      cursor: asOpaqueCursor(search["cursor"]),
      tx: asUuid(search["tx"]),
      type: asEnum(search["type"], TRANSACTION_KIND_VALUES),
      currency,
      minAmount: currency === undefined ? undefined : asDecimalAmount(search["minAmount"]),
      maxAmount: currency === undefined ? undefined : asDecimalAmount(search["maxAmount"]),
      view: asEnum(search["view"], ACTIVITY_VIEW_TABS),
      sort: asEnum(search["sort"], LEDGER_SORT_ORDERS),
      measure: asEnum(search["measure"], ACTIVITY_CALENDAR_MEASURES),
    };
  },
  component: ActivityRoute,
});

/**
 * `/instruments` (UR-27) — the
 * security master. `{ kind?, q?, sel? }` (UR-7's own `asEnum`/`asUuid`
 * primitives, same "unrecognised/malformed -> undefined, never throws"
 * convention every other route's `validateSearch` follows).
 *
 * `q` is a **free-text** filter (client-side over the derived instrument set
 * in « Mes instruments » mode, server-side `?query=` in catalogue mode —
 * `InstrumentsView.tsx`) — it is not `asUuid`/`asEnum`-shaped, so it only
 * needs the "non-empty string, bounded length" treatment `asOpaqueCursor`
 * already gives a different kind of URL string; reused here rather than
 * inventing a fourth near-identical primitive for the same shape.
 *
 * `mode`/`cursor` (IB11, FR-188): which row source the screen is showing, and where
 * in the catalogue's own pagination it is. Both live **in the URL, never in
 * component state or storage** — UR-7/OD-1(c)'s standing rule, and the same
 * `asEnum`/`asOpaqueCursor` pair `activityRoute` above already uses. An
 * absent or unrecognised `mode` is `undefined`, which `InstrumentsView`
 * reads as `"mine"`, so every existing `/instruments` link and bookmark
 * lands on exactly the view it landed on before (AC-19).
 *
 * **No `loader` key** — same rationale as `portfolioDetailRoute`/
 * `activityRoute` above (`router.test.ts`'s source-text assertion covers
 * this route too, with no change to that test needed).
 */
interface InstrumentsSearch {
  readonly kind?: InstrumentKind;
  readonly q?: string;
  readonly sel?: string;
  readonly mode?: InstrumentViewMode;
  readonly cursor?: string;
}

export const instrumentsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/instruments",
  validateSearch: (search: Record<string, unknown>): InstrumentsSearch => ({
    kind: asEnum(search["kind"], INSTRUMENT_KIND_VALUES),
    q: asOpaqueCursor(search["q"]),
    sel: asUuid(search["sel"]),
    mode: asEnum(search["mode"], INSTRUMENT_VIEW_MODES),
    cursor: asOpaqueCursor(search["cursor"]),
  }),
  component: InstrumentsRoute,
});

/**
 * `/instruments/$instrumentId` (UR-28) — a **flat sibling** of `/instruments`, not nested under it, for the
 * identical reason `portfolioDetailRoute`'s own doc comment above records
 * for `/portfolios/$portfolioId`: no shared layout or shared data between
 * list and detail a layout route would factor out, and nesting would
 * require adding an `<Outlet/>` to `InstrumentsRoute.tsx`/`InstrumentsView.tsx`.
 *
 * No search params. **No `loader` key** — same
 * rationale as every other route above.
 */
export const instrumentDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/instruments/$instrumentId",
  component: InstrumentDetailRoute,
});

/**
 * `/controls` (UR-30..UR-32) — the
 * Contrôles screen (renamed from "Opérations"). No
 * search params (this screen has no linkable filter/selection state — see
 * `ControlsRoute.tsx`'s own doc comment on why the original `{status?}`
 * filter is superseded by the three-group restructuring).
 * **No `loader` key** — same rationale as every other route above
 * (`router.test.ts`'s source-text assertion covers this route too, with no
 * change to that test needed). This is the sixth and final destination that
 * closes AC88 (`nav-items.ts`'s own doc comment records the flip).
 */
const controlsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/controls",
  component: ControlsRoute,
});

/**
 * `/import` (OD-11(a)) —
 * the CSV import wizard. Four search params, every one of them through
 * `search-params.ts`'s own primitives with the same "unrecognised or malformed
 * -> `undefined`, never throws" convention every other route here follows: a
 * bookmarked or hand-edited URL lands on step 1 rather than blanking.
 *
 * **What deliberately does *not* live in the URL: the selected `File`.** It
 * cannot — a `File` has no serialisable form — so it lives in the wizard's own
 * component state, and a refresh at the revue step returns the user to the
 * file step with a message saying so. That limitation is exactly why OD-11(a)
 * chose a route over a modal: a modal would lose it on *any* navigation.
 *
 * **No `loader` key** — same rationale as every other route above
 * (`router.test.ts`'s source-text assertion covers this route too, with no
 * change to that test needed).
 */
interface ImportSearch {
  readonly step?: ImportWizardStep;
  readonly type?: ImportFileTypeName;
  readonly portfolio?: string;
  readonly account?: string;
}

export const importRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/import",
  validateSearch: (search: Record<string, unknown>): ImportSearch => ({
    step: asEnum(search["step"], IMPORT_WIZARD_STEPS),
    type: asEnum(search["type"], IMPORT_FILE_TYPES),
    portfolio: asUuid(search["portfolio"]),
    account: asUuid(search["account"]),
  }),
  component: ImportRoute,
});

/**
 * `/currencies` — the Devises screen. No search
 * params (the screen has no linkable filter or selection state: it lists every
 * pair the daily FX pull covers), so it never calls `useSearch()`/`useParams()`
 * and `CurrenciesRoute.tsx` stays directly testable under plain `vitest`.
 * **No `loader` key** — same rationale as every other route above
 * (`router.test.ts`'s source-text assertion covers this route too, with no
 * change to that test needed).
 */
const currenciesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/currencies",
  component: CurrenciesRoute,
});

/**
 * `/dividends` (DV1's path,
 * LD-9) — the Dividendes screen. `{from, to, portfolio}`, each through
 * `search-params.ts`'s shipped primitives with the same "unrecognised or
 * malformed -> `undefined`, never throws" convention every other route here
 * follows — `activityRoute` above already uses exactly this trio, so **no
 * fourth validator shape is invented**.
 *
 * A hand-edited `/dividends?from=not-a-date` therefore lands on the all-time
 * default rather than throwing into the router's `CatchBoundary` and blanking
 * the screen. That degradation is what makes the URL safe to carry the
 * *resolved* window (DV9) instead of a preset id: a bookmark stays absolute,
 * and nothing has to keep a relative id's meaning stable across 1 January.
 *
 * **No `loader` key** — same rationale as every other route above
 * (`router.test.ts`'s source-text assertion covers this route too, with no
 * change to that test needed).
 */
interface DividendsSearch {
  readonly from?: string;
  readonly to?: string;
  readonly portfolio?: string;
}

export const dividendsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/dividends",
  validateSearch: (search: Record<string, unknown>): DividendsSearch => ({
    from: asIsoDate(search["from"]),
    to: asIsoDate(search["to"]),
    portfolio: asUuid(search["portfolio"]),
  }),
  component: DividendsRoute,
});

/**
 * `/watchlist` (UR-47) — the Suivi
 * screen. One search param, `window`, validated by `asEnum` against
 * `WATCHLIST_WINDOW_PRESET_IDS` (`period-presets.ts`' set **minus `MAX`**,
 * which is also the server's own `WATCHLIST_WINDOW_PRESETS` enum), so a
 * hand-edited `/watchlist?window=MAX` falls back to the default rather than
 * asking for a window the read would refuse with a 400 — the same
 * "unrecognised or malformed -> the safe default, never a throw" convention
 * every route here follows.
 *
 * The preset id, not a resolved `[from, to]` pair: this route's window is
 * resolved **server-side** precisely so the window the metrics
 * were computed over and the window the response echoes cannot disagree, which
 * is the opposite trade `/dividends` makes for its own (DV9) reason.
 *
 * **No `loader` key** — same rationale as every other route above
 * (`router.test.ts`'s source-text assertion covers this route too, with no
 * change to that test needed).
 */
interface WatchlistSearch {
  readonly window: string;
}

export const watchlistRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/watchlist",
  validateSearch: (search: Record<string, unknown>): WatchlistSearch => ({
    window: asEnum(search["window"], WATCHLIST_WINDOW_PRESET_IDS) ?? DEFAULT_WATCHLIST_WINDOW,
  }),
  component: WatchlistRoute,
});

/**
 * `/watchlist/$instrumentId` (as
 * amended 2026-09-11) — one watched instrument's analysis
 * screen, reached from the row. A **flat sibling** of `/watchlist`, not a
 * child, for the reason `instrumentDetailRoute` records: nothing a layout
 * route would factor out, and nesting would put an `<Outlet/>` into
 * `WatchlistView.tsx` for no gain.
 *
 * The same `window` search param, validated identically, so the two screens
 * read the **same** `GET /watchlist?window=` query key: arriving from a row is
 * a cache hit, and the breadcrumb back carries the window along. **No
 * `loader` key** — same rationale as every other route above.
 */
export const watchlistAnalysisRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/watchlist/$instrumentId",
  validateSearch: (search: Record<string, unknown>): WatchlistSearch => ({
    window: asEnum(search["window"], WATCHLIST_WINDOW_PRESET_IDS) ?? DEFAULT_WATCHLIST_WINDOW,
  }),
  component: WatchlistAnalysisRoute,
});

/**
 * `/account` — **« Mon compte »** (`account-setup` FR-409).
 * Reached from `AccountMenu`'s own new entry, never from `nav-items.ts`
 * (LD-2: an account-menu item, not a nav destination), which is why nothing
 * in the rail changes for it.
 *
 * No `validateSearch`: the screen has no window, filter or selection state to
 * put in the URL — it is two forms. **No `loader` key** — same rationale as
 * every other route above (`router.test.ts`'s source-text assertion covers
 * this route too, with no change to that test needed); both writes and the
 * cached `auth.me` read live in the component.
 */
const accountRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/account",
  component: AccountRoute,
});

/**
 * `/admin/users` — **« Utilisateurs »** (`account-setup` FR-420–FR-422).
 * Its own route rather than a tab of `/account` (LD-2),
 * because "is this caller the instance admin?" is then one guard on one
 * boundary instead of a condition threaded through a shared screen.
 *
 * The guard itself is **in the component**, reading the cached `auth.me`
 * (`AdminUsersRoute.tsx`): a `beforeLoad` redirect would need the same cache
 * read one layer earlier and would still not be the enforcement point — the
 * database's own `is_instance_admin` re-check is (LD-4), and every `/admin/*`
 * read this screen makes answers `403 NOT_INSTANCE_ADMIN` regardless of what
 * the client rendered. No `validateSearch`, **no `loader` key**.
 */
const adminUsersRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/admin/users",
  component: AdminUsersRoute,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([
    overviewRoute,
    performanceRoute,
    holdingsRoute,
    portfoliosRoute,
    portfolioDetailRoute,
    activityRoute,
    instrumentsRoute,
    instrumentDetailRoute,
    controlsRoute,
    importRoute,
    currenciesRoute,
    dividendsRoute,
    watchlistRoute,
    watchlistAnalysisRoute,
    accountRoute,
    adminUsersRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
