import type { BrowserContext, Page } from "@playwright/test";
import { RATE_PRESET_DEFAULTS } from "@kerdial/api-contracts";

/**
 * Every mock below that a spec might need to register at the browser-
 * **context** level (a spec driving the app through a controlling service
 * worker — `page.route` never intercepts a fetch the service worker's own
 * handler issues, only `context.route` does) accepts either a `Page` or a
 * `BrowserContext`: both
 * expose the identical `.route(url, handler)` signature this file only ever
 * calls, so a caller picks whichever target its own spec needs with no
 * change to these fixtures.
 */
export type RoutableTarget = Page | BrowserContext;

/**
 * Route-mocked T-40 contract fixtures for the web shell's Playwright suite.
 *
 * The CI `e2e` job (`.github/workflows/ci.yml`) runs `pnpm test:e2e` against
 * a plain `vite` dev server with no Postgres/Testcontainers-backed API
 * behind it (unlike `api`'s own Testcontainers-backed Supertest suite,
 * `api/src/auth.e2e.test.ts`). Standing up a full live API + database for
 * this shell-level task would be disproportionate to what T-42 needs to
 * prove (routing/rendering/PWA behaviour, not the auth service's own
 * correctness — that is `api/src/auth.e2e.test.ts`'s job). These fixtures
 * therefore mock `/api/v1/auth/*`/`/api/v1/portfolios/*` at the network
 * layer (`page.route`), but every request/response shape below is copied
 * verbatim from the real DTOs: `api/src/auth/auth.controller.ts` (login
 * 200/401 bodies), `api/src/common/problem.ts` (problem+json shape), and
 * `api/src/portfolios/portfolios.schema.ts` (`OverviewResponse`/
 * `HoldingsResponse`, trimmed to the non-monetary fields the shell
 * actually renders — see `src/lib/api-client.ts`'s own note on why no
 * monetary figure is rendered here).
 */

export const TENANT_ID = "00000000-0000-7000-8000-0000000a0000";
export const USER_ID = "00000000-0000-7000-8000-0000000a0001";
export const EMAIL = "alice@example.com";
export const PASSWORD = "correct horse battery staple";

/** T-44's transaction-form fixtures. */
export const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
export const INSTRUMENT_ID = "22222222-2222-4222-8222-222222222222";
export const SETTLEMENT_INSTRUMENT_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Mirrors `api/src/auth/cookies.ts`'s cookie names/attributes — except
 * `Secure`, deliberately dropped here: this suite runs against the plain-http
 * Vite dev server, and WebKit (the `iPhone 14` project) refuses to store a
 * `Secure` cookie arriving over http (Chromium special-cases localhost;
 * WebKit does not), which would silently leave `document.cookie` empty and
 * fail every csrf_token assertion on that project only. The real cookies'
 * attribute set (including `Secure`) is asserted where it is actually
 * produced, against real HTTPS-bound headers: `api`'s own Supertest suite.
 */
const LOGIN_SET_COOKIE = [
  "sid=test-session-token; Path=/; HttpOnly; SameSite=Lax",
  "csrf_token=test-csrf-token; Path=/; SameSite=Lax",
];

/**
 * `GET /api/v1/auth/setup`'s two answers (`account-setup` FR-395, AC-366),
 * copied verbatim from the real DTO: `api/src/auth/auth.controller.ts`'s
 * `setupState()` returns `{ needsSetup, currencies }` where each currency is
 * `api/src/currencies/currencies.schema.ts`'s `CurrencyResponse` —
 * `{ code, name, minorUnit }`, the same shape `GET /currencies` returns,
 * because the controller reuses `toCurrencyResponse` rather than projecting a
 * second one.
 *
 * **Both fixtures answer `GET` only and `route.fallback()` anything else**:
 * `POST /auth/setup` is the *same URL*, and a Playwright route handler matches
 * on URL, not method. Without the branch, registering one of these would
 * swallow the write as well — and {@link mockSetupSuccess} below, registered
 * after, would swallow the read for the same reason if it did not branch too.
 */
const SETUP_CURRENCIES = [
  { code: "CHF", name: "Franc suisse", minorUnit: 2 },
  { code: "EUR", name: "Euro", minorUnit: 2 },
  { code: "USD", name: "Dollar américain", minorUnit: 2 },
];

export async function mockSetupNeeded(page: RoutableTarget): Promise<void> {
  await page.route("**/api/v1/auth/setup", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ needsSetup: true, currencies: SETUP_CURRENCIES }),
    });
  });
}

/**
 * The already-configured instance — i.e. every spec in this suite except
 * `setup.spec.ts`'s own first test.
 *
 * Registered by {@link mockLoginSuccess}/{@link mockLoginFailure} rather than
 * added to each of the specs that render the login form, for the reason
 * `mockAuthenticatedSession` registers `mockWatchedInstrumentIds` below: this
 * file grows and no existing spec's assertions move. A spec that needs the
 * *setup* form registers {@link mockSetupNeeded} afterwards — Playwright
 * matches the most-recently-registered handler first — and a spec that
 * registers a broad catch-all glob over `/api/v1/auth/` must register this
 * one **after** it, for the same ordering reason.
 */
export async function mockSetupNotNeeded(page: RoutableTarget): Promise<void> {
  await page.route("**/api/v1/auth/setup", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ needsSetup: false, currencies: SETUP_CURRENCIES }),
    });
  });
}

/**
 * `POST /api/v1/auth/setup` succeeding (FR-399/LD-6 (a)): the real handler
 * returns `{ tenantId, userId }` and sets the **same two cookies** as
 * `POST /auth/login` (AC-360, byte-identical issuance) — which is why the web
 * navigates into the shell rather than to `/login`.
 */
export async function mockSetupSuccess(page: RoutableTarget): Promise<void> {
  await page.route("**/api/v1/auth/setup", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "set-cookie": LOGIN_SET_COOKIE.join("\n") },
      body: JSON.stringify({ tenantId: TENANT_ID, userId: USER_ID }),
    });
  });
}

export async function mockLoginSuccess(page: RoutableTarget): Promise<void> {
  // `account-setup` T-95: `/login` probes `GET /auth/setup` before it renders
  // anything, so a spec that expects the *login* form needs that probe
  // answered — see {@link mockSetupNotNeeded}'s own note on why it is here
  // and not in forty specs' setup.
  await mockSetupNotNeeded(page);
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // Two cookies, one response — real HTTP repeats the `Set-Cookie`
      // header once per cookie (never comma-joins it: unlike other
      // headers, `Set-Cookie` values may themselves contain commas, e.g. in
      // an `Expires` date). `route.fulfill`'s `headers` is a flat
      // name->value record with no way to repeat a header name, but
      // newline-joining the values here does correctly produce two
      // separate `Set-Cookie` response headers (verified empirically:
      // comma-joining silently dropped the second cookie — only `sid` ever
      // reached the browser's cookie jar, `csrf_token` never did —
      // `csrf-cookie-purge.spec.ts`, F10, is the test that first needed
      // `csrf_token` to genuinely land in the browser and caught this).
      headers: { "set-cookie": LOGIN_SET_COOKIE.join("\n") },
      body: JSON.stringify({ tenantId: TENANT_ID, userId: USER_ID }),
    });
  });
}

/** Same 401 problem+json body `auth.e2e.test.ts` asserts for a wrong password/unknown email. */
export async function mockLoginFailure(page: RoutableTarget): Promise<void> {
  await mockSetupNotNeeded(page);
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Invalid email or password",
        status: 401,
        code: "INVALID_CREDENTIALS",
      }),
    });
  });
}

/**
 * `options.isInstanceAdmin` is the admin variant of this fixture
 * (`account-setup` FR-419/UR-70): `GET /auth/me` carries the flag on the real
 * wire, and the account menu's **« Utilisateurs »** entry is rendered from it
 * alone. Default `false` — the ordinary user every pre-existing spec here
 * drives, stated rather than omitted, because an absent field and `false`
 * mean the same thing to `AccountMenu` and only one of them matches the real
 * response.
 */
export async function mockAuthenticatedSession(
  page: RoutableTarget,
  options: { isInstanceAdmin?: boolean } = {},
): Promise<void> {
  // `watchlist` W-6: **every** authenticated screen that mounts a
  // `<WatchToggle>` — Instruments (table and cards), Instrument Detail, Suivi
  // — issues `GET /watchlist/ids` on load, so an authenticated session is
  // exactly the scope this fulfilment belongs to. Registered here rather than
  // added to a dozen specs' setup because the rule for the watchlist work was
  // that this mock file grows and **no existing spec's assertions move**
  // (AC-347); a spec that needs a non-empty set registers
  // {@link mockWatchedInstrumentIds} of its own afterwards, and Playwright
  // matches the later handler first.
  await mockWatchedInstrumentIds(page, []);
  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // `baseCurrency` is on the real wire (`CurrentUser` declares it
      // required); the mock omitting it meant nothing driven by this fixture
      // could exercise a surface that reads it — the gap a currency badge once
      // shipped into, and the one the income-tile labels would have
      // silently regressed through ("—" instead of a labelled total).
      body: JSON.stringify({
        tenantId: TENANT_ID,
        userId: USER_ID,
        email: EMAIL,
        baseCurrency: "EUR",
        isInstanceAdmin: options.isInstanceAdmin ?? false,
      }),
    });
  });
}

export async function mockOverview(
  page: RoutableTarget,
  overrides: Partial<{
    from: string;
    to: string;
    portfolioCount: number;
    totalValue: unknown;
    unrealizedGainLoss: unknown;
    return: unknown;
    calcEpoch: string;
    cash: unknown;
  }> = {},
): Promise<void> {
  // F2 (security review, T-45): `calcEpoch` auto-increments per call
  // unless the caller pins one explicitly (`overrides.calcEpoch`) — matching
  // the real API's behaviour (every recompute advances the epoch) closely
  // enough that `invalidateAndVerifyCalcEpoch` (`src/lib/calc-epoch.ts`)
  // sees a fresh value on the very first refetch in the common case, the
  // same way most other specs in this suite (which do not themselves care
  // about calcEpoch verification) expect a transaction-form submission to
  // just close the dialog. `calc-epoch-refetch.spec.ts` and its own
  // exhaustion test use `mockOverviewSequence`/a pinned `calcEpoch` instead,
  // precisely to exercise the retry/exhaustion paths this default avoids.
  let callCount = 0;
  await page.route("**/api/v1/portfolios/overview*", async (route) => {
    callCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2026-01-01",
        to: "2026-08-15",
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        return: { twr: {}, mwr: {} },
        calcEpoch: String(callCount),
        portfolioCount: 1,
        ...overrides,
      }),
    });
  });
}

/**
 * `GET /api/v1/portfolios/value-series` (FR-262; `netContributions`
 * per point). Points default to a three-day series with
 * a deposit landing between the first and second day.
 */
export async function mockValueSeries(
  page: RoutableTarget,
  overrides: Partial<{
    from: string;
    to: string;
    baseCurrency: string;
    points: readonly { date: string; value: string; netContributions: string }[];
  }> = {},
): Promise<void> {
  await page.route("**/api/v1/portfolios/value-series*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2026-01-01",
        to: "2026-08-15",
        baseCurrency: "EUR",
        points: [
          { date: "2026-01-30", value: "1000.00", netContributions: "900.00" },
          { date: "2026-01-31", value: "1050.00", netContributions: "900.00" },
          { date: "2026-02-01", value: "1650.00", netContributions: "1500.00" },
        ],
        provenance: { leafCount: 3, complete: true, derivedFrom: [], sources: [] },
        ...overrides,
      }),
    });
  });
}

/**
 * `GET /api/v1/portfolios` (FR-14) — T-44's transaction form portfolio
 * picker, and `PortfoliosRoute`'s list.
 * `transactionCount`/`createdAt` default to a fixed, deterministic value
 * unless a caller overrides them per item (D8).
 *
 * LOW-1 (security review): both this and
 * {@link mockCreatePortfolio} route on the portfolios path with a trailing
 * glob wildcard, not an exact-suffix match — because `fetchPortfolios` now
 * always requests a `limit`/`cursor` querystring (`api-client.ts`'s own fix),
 * so an exact-suffix pattern would stop matching the real request URL and
 * silently fall through to the network. Mirrors `mockInstrumentSearch`'s
 * identical trailing-wildcard pattern on the instruments path, needed there
 * for the same reason (its own `?query=`).
 */
export interface PortfolioSummaryFixture {
  id: string;
  name: string;
  transactionCount?: number;
  createdAt?: string;
  /**
   * `portfolio-details` FR-449–FR-451/FR-467 — all four ride
   * `PortfolioSummary` unconditionally, so the wire fixture
   * defaults them to the same "nothing set" shape the real `listPortfolios`
   * join answers with (`null`/`null`/`null`/`false`) at every fulfilment site
   * below. Optional here only so every pre-existing spec's fixture literal
   * (none of which name these four fields) keeps rendering the unconditional-
   * looking wallet fallback and no broker/description line, with zero fixture
   * changes of its own.
   */
  broker?: string | null;
  description?: string | null;
  accentColor?: string | null;
  hasIcon?: boolean;
  /** portfolio-archive FR-593 — defaults to `false` at every fulfilment site, like the real list. */
  archived?: boolean;
}

export async function mockPortfolios(
  page: RoutableTarget,
  items: PortfolioSummaryFixture[] = [{ id: PORTFOLIO_ID, name: "Compte principal" }],
): Promise<void> {
  await page.route("**/api/v1/portfolios*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: items.map((item) => ({
          transactionCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          broker: null,
          description: null,
          accentColor: null,
          hasIcon: false,
          archived: false,
          ...item,
        })),
        nextCursor: null,
      }),
    });
  });
}

/**
 * `POST /api/v1/portfolios` (FR-P1) — same
 * glob as `mockPortfolios` (`mockInstrumentSearch`/`mockCreateInstrument`'s
 * exact precedent): method-checked, `route.fallback()`s to let
 * `mockPortfolios`'s own `GET` handler take the request when this isn't a
 * `POST`.
 */
export async function mockCreatePortfolio(
  page: RoutableTarget,
  outcome:
    | { status: 201; response: PortfolioSummaryFixture }
    | { status: 409; code: string }
    | { status: 429; retryAfterSeconds?: number } = {
    status: 201,
    response: { id: "created-portfolio-1", name: "Nouveau portefeuille" },
  },
): Promise<void> {
  await page.route("**/api/v1/portfolios*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    if (outcome.status === 409) {
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          code: outcome.code,
        }),
      });
      return;
    }
    if (outcome.status === 429) {
      await route.fulfill({
        status: 429,
        contentType: "application/problem+json",
        headers: { "retry-after": String(outcome.retryAfterSeconds ?? 1) },
        body: JSON.stringify({
          type: "about:blank",
          title: "Too many requests",
          status: 429,
          code: "ADMISSION_BOUND_EXCEEDED",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        transactionCount: 0,
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
        archived: false,
        ...outcome.response,
      }),
    });
  });
}

/**
 * The three `/api/v1/portfolios/:id/icon` routes — PD-T12's own addition.
 * One regex per method rather than one combined handler, so a spec registers only the
 * methods it actually needs and each composes with `mockPortfolios`'s own
 * `**\/api/v1/portfolios*` glob with no conflict (a single, non-doubled `*`
 * never crosses the `/` before `:id`, Playwright's own glob semantics — see
 * `mockPortfolios`'s doc comment).
 *
 * Every one of the three method-checks and `route.fallback()`s otherwise —
 * `mockPortfolios`/`mockCreatePortfolio`'s own precedent for sharing one URL
 * across several independently-registered handlers — so a spec can mix and
 * match (e.g. `mockPortfolioIconBytes` alone for a read-only AC-403 case,
 * all three together for an AC-406 replace/remove sequence) in any
 * registration order.
 */
function portfolioIdFromIconUrl(url: string): string {
  const id = new URL(url).pathname.split("/").at(-2);
  if (id === undefined) throw new Error(`mocks.ts: not a /portfolios/:id/icon URL: ${url}`);
  return id;
}

/** `image/png,image/jpeg,image/gif,…` never matters here: every fixture this suite builds is a PNG (`icon-bytes.ts`), and the real route's own `content-type` is what a decoding `<img>` actually keys off. */
const PORTFOLIO_ICON_URL_PATTERN = /\/api\/v1\/portfolios\/[^/]+\/icon(\?.*)?$/;

/**
 * `GET /api/v1/portfolios/:id/icon` — the bytes an
 * `<img src={portfolioIconUrl(id)}>` decodes (FR-463/FR-466/SD-5).
 *
 * Served from a `Map` the **caller** owns and can mutate between actions —
 * deliberately not a plain object literal captured once, which would freeze
 * an AC-406 replace/remove sequence's "before" state and make the second
 * request in the same test see stale bytes no matter what the app did. A
 * missing id answers `404`, mirroring FR-474's own "404 after a concurrent
 * removal" branch — the same failure shape AC-409's load-failure fallback
 * exercises.
 */
export async function mockPortfolioIconBytes(
  target: RoutableTarget,
  bytesById: Map<string, Buffer>,
): Promise<void> {
  await target.route(PORTFOLIO_ICON_URL_PATTERN, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const bytes = bytesById.get(portfolioIdFromIconUrl(route.request().url()));
    if (bytes === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Not found",
          status: 404,
          code: "PORTFOLIO_ICON_NOT_FOUND",
        }),
      });
      return;
    }
    // The real route's own headers (`portfolios.controller.ts`'s `getIcon`,
    // mirrored from `static-tier-csp.lane.spec.ts`'s instrument-icon
    // precedent) — `cache-control: no-store` included, so a spec asserting
    // the *component's* own `iconVersion`-keyed remount (not the HTTP cache)
    // is what makes a replace re-render is exercising the real mechanism.
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
        "content-disposition": "attachment",
        "cache-control": "no-store",
      },
      body: bytes,
    });
  });
}

export interface PortfolioIconMetaFixture {
  portfolioId: string;
  contentType?: string;
  byteLength?: number;
  widthPx?: number;
  heightPx?: number;
  updatedAt?: string;
}

/**
 * `PUT /api/v1/portfolios/:id/icon` (FR-461, set **or** replace) —
 * `onSet` is handed the id and the decoded request body (the form's
 * `{ declaredContentType, bytesBase64 }`, PD-13) and returns either the
 * metadata response or a rejection `status`/`code` pair, so one callback
 * both drives a paired {@link mockPortfolioIconBytes} map (letting the caller
 * update it to the new bytes only once this mock has "accepted" them) and
 * lets a spec assert the exact body a `PortfolioDetailsForm` submit sent.
 */
export async function mockSetPortfolioIcon(
  target: RoutableTarget,
  onSet: (
    portfolioId: string,
    body: { declaredContentType: string; bytesBase64: string },
  ) => PortfolioIconMetaFixture | { status: 400 | 413 | 415 | 422; code: string },
): Promise<void> {
  await target.route(PORTFOLIO_ICON_URL_PATTERN, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    const id = portfolioIdFromIconUrl(route.request().url());
    const body = route.request().postDataJSON() as {
      declaredContentType: string;
      bytesBase64: string;
    };
    const outcome = onSet(id, body);
    if ("status" in outcome) {
      await route.fulfill({
        status: outcome.status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Rejected",
          status: outcome.status,
          code: outcome.code,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        contentType: "image/png",
        byteLength: 0,
        widthPx: 0,
        heightPx: 0,
        updatedAt: "2026-09-22T00:00:00.000Z",
        ...outcome,
      }),
    });
  });
}

/**
 * `DELETE /api/v1/portfolios/:id/icon` (FR-461) — `204` unconditionally,
 * matching the real route's own "not usable as an existence probe" shape
 * (`api/src/lib/api/portfolios.ts`'s `deletePortfolioIcon` doc comment).
 * `onDelete` lets the caller drop the id from a paired
 * {@link mockPortfolioIconBytes} map so the *next* `GET` answers `404`,
 * which is what actually proves the removal rather than merely the `204`.
 */
export async function mockDeletePortfolioIcon(
  target: RoutableTarget,
  onDelete: (portfolioId: string) => void,
): Promise<void> {
  await target.route(PORTFOLIO_ICON_URL_PATTERN, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    onDelete(portfolioIdFromIconUrl(route.request().url()));
    await route.fulfill({ status: 204 });
  });
}

export interface InstrumentSummaryFixture {
  id: string;
  kind: string;
  displayName: string;
  listingCurrency: string;
  isin: string | null;
  exchangeMic?: string | null;
  symbol: string | null;
  /**
   * IK-12 (`instrument-icons`, L13) — whether this tenant has an icon for the
   * instrument, the flag `InstrumentTable`/`InstrumentCardList` and the detail
   * badge branch on (IK-10 put it on `InstrumentResponse` and on
   * `InstrumentDetailResponse` alike, so one field covers both mocks below).
   *
   * Optional, defaulting `false` at each fulfilment site the same way
   * `exchangeMic` already does: every pre-existing spec keeps rendering the
   * monogram fallback it already asserts on, and only a spec that opts in sees
   * an `<img>`. Without this the icon specs cannot express "instrument X has
   * one and instrument Y does not" at all.
   */
  hasIcon?: boolean;
}

/**
 * `GET /api/v1/instruments?query=` (T-37) — T-44's instrument picker, mocked
 * the same way `mockOverview`/`mockHoldings` mock their own read endpoints.
 *
 * Method-checked (falls back for anything but `GET`) so it can coexist with
 * `mockCreateInstrument`'s `POST` route on the same `/api/v1/instruments`
 * glob pattern (the instrument-creation UI task) — mirrors
 * `mockCreateTransaction`'s own method check, which this route previously
 * lacked.
 */
export async function mockInstrumentSearch(
  page: RoutableTarget,
  items: InstrumentSummaryFixture[],
): Promise<void> {
  await page.route("**/api/v1/instruments*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: items.map((item) => ({ exchangeMic: null, hasIcon: false, ...item })),
        nextCursor: null,
      }),
    });
  });
}

/**
 * `POST /api/v1/instruments` (T-37; the instrument-creation
 * UI task) — either a 201 success (`created`) or the 409 duplicate outcome
 * (AC1's negative half) `instruments.controller.ts`'s `create` handler
 * returns for a duplicate (isin, exchangeMic)/symbol.
 */
export async function mockCreateInstrument(
  page: RoutableTarget,
  outcome: { status: 201; response: InstrumentSummaryFixture } | { status: 409; code: string } = {
    status: 201,
    response: {
      id: "created-instrument-1",
      kind: "SHARE",
      displayName: "Created Instrument",
      listingCurrency: "EUR",
      isin: null,
      exchangeMic: null,
      symbol: null,
    },
  },
): Promise<void> {
  await page.route("**/api/v1/instruments", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    if (outcome.status === 409) {
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Instrument already exists",
          status: 409,
          code: outcome.code,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(outcome.response),
    });
  });
}

/**
 * `GET /api/v1/currencies` (IC-12/IC-13)
 * — `CurrencySelect`'s data source. A small, deterministic fixture list
 * (real production data is the full ~180-row seeded ISO 4217 set) is enough
 * for every spec that only needs a currency dropdown to be selectable.
 */
interface CurrencyFixture {
  code: string;
  name: string;
  minorUnit: number;
}

export async function mockCurrencies(
  page: RoutableTarget,
  items: CurrencyFixture[] = [
    { code: "EUR", name: "Euro", minorUnit: 2 },
    { code: "USD", name: "Dollar américain", minorUnit: 2 },
  ],
): Promise<void> {
  await page.route("**/api/v1/currencies*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items }),
    });
  });
}

interface DiscoveryCandidateFixture {
  providerSymbol: string;
  tickerSymbol: string | null;
  displayName: string;
  listingCurrency: string;
  exchangeHint: { code: string; suggestedMic: string | null } | null;
  matchQuality: "EXACT" | "PROBABLE";
}

/**
 * `GET /api/v1/instruments/discovery?kind=&query=` (IC-11/IC-14) —
 * `InstrumentDiscoverySearch`'s data source. Registered on its own static path
 * so it never collides with `mockInstrumentSearch`'s `**\/api/v1/instruments*`
 * glob (the API's own route-shadowing concern, mirrored here at the mock level).
 */
export async function mockInstrumentDiscovery(
  page: RoutableTarget,
  items: DiscoveryCandidateFixture[],
): Promise<void> {
  await page.route("**/api/v1/instruments/discovery*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items }),
    });
  });
}

interface HistoryStatusFixture {
  status?: "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
  requestedFrom?: string | null;
  earliestBackfilledDate?: string | null;
  latestBackfilledDate?: string | null;
}

/**
 * `GET /api/v1/instruments/:id/history-status` (IC-12/IC-16) —
 * `InstrumentHistoryStatus`'s data
 * source, mounted from the create dialog's success panel (and the holdings
 * row, `HoldingHistoryStatus`'s own `GET /instruments/:id` lookup mock is
 * not needed here since this suite never exercises the holdings screen).
 *
 * This route is `NetworkOnly` in the service worker (`vite.config.ts`) —
 * exactly the reason this file's own top-of-file note calls out
 * `context.route` over `page.route` for a spec driving the app through a
 * controlling service worker: an unmocked poll would otherwise hit the real
 * network (there is no live API behind this suite's plain `vite` dev
 * server, per this file's own header comment) rather than merely miss the
 * SW's cache. Registered on a path-specific glob
 * (`**\/instruments/*\/history-status`) so it never collides with
 * `mockCreateInstrument`/`mockInstrumentSearch`'s broader
 * `**\/api/v1/instruments*` globs.
 *
 * Defaults to `PENDING` — the calm "en cours" indication a freshly created
 * backfillable instrument shows immediately, before any poll has had time to
 * resolve further (DD15).
 */
export async function mockInstrumentHistoryStatus(
  page: RoutableTarget,
  overrides: HistoryStatusFixture = {},
): Promise<void> {
  await page.route("**/api/v1/instruments/*/history-status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "PENDING",
        requestedFrom: null,
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
        ...overrides,
      }),
    });
  });
}

/**
 * `GET`/`PUT /api/v1/settings/rate-presets`. The transaction dialog reads the
 * presets on **every** opening, whatever the kind, so every spec that opens
 * it registers this: unmocked, the read goes through the dev server's proxy
 * to `:3000` — a refused connection here, or a live API's answer where the
 * local deployment is up (the "unmocked query" trap).
 *
 * `GET` answers the server's four defaults — imported from the contract the
 * API serves them from, never mirrored by hand. `PUT` echoes the list, the
 * way the server answers a valid whole-list replace (canonicalisation aside,
 * which a spec does not exercise). Any other method falls through.
 */
export async function mockRatePresets(page: RoutableTarget): Promise<void> {
  await page.route("**/api/v1/settings/rate-presets", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: RATE_PRESET_DEFAULTS }),
      });
      return;
    }
    if (method === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: route.request().postData() ?? "{}",
      });
      return;
    }
    await route.fallback();
  });
}

/** `POST /api/v1/transactions` (T-38/T-44) — a bare 201 success body is enough; the form only needs to know the call succeeded. */
export async function mockCreateTransaction(page: RoutableTarget): Promise<void> {
  let callCount = 0;
  await page.route("**/api/v1/transactions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    callCount += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: `txn-${callCount}` }),
    });
  });
}

export async function mockHoldings(
  page: RoutableTarget,
  overrides: Partial<{
    asOfDate: string;
    portfolioCount: number;
    holdings: unknown[];
    totalValue: unknown;
    totalUnrealizedGainLoss: unknown;
    calcEpoch: string;
  }> = {},
): Promise<void> {
  // See `mockOverview`'s own note on why `calcEpoch` auto-increments per
  // call unless pinned via `overrides.calcEpoch`.
  let callCount = 0;
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
    callCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-15",
        holdings: [],
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        totalUnrealizedGainLoss: {
          amount: "0.00",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
        calcEpoch: String(callCount),
        portfolioCount: 1,
        ...overrides,
      }),
    });
  });
}

/** A `ValuedAmount` fixture (T-45's screens) — `mockHolding`'s own default building block. */
function valuedAmount(amount: string, currency = "EUR"): Record<string, unknown> {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

/**
 * A single `api/src/portfolios/portfolios.schema.ts` `HoldingResponse`
 * fixture — T-45's holdings screen (AC25). `realizedGains`
 * defaults to empty (no sales), matching the common case; pass a non-empty
 * array to exercise the "present only when sales occurred" clause.
 */
export function mockHolding(
  overrides: Partial<{
    instrumentId: string;
    kind: string;
    displayName: string;
    quantity: string;
    currency: string;
    pmp: unknown;
    costBasis: unknown;
    currentPrice: unknown;
    currentValue: unknown;
    unrealizedGainLoss: unknown;
    /** IK-10 (`instrument-icons`, L13): whether this tenant has an icon for the instrument — the flag every icon surface branches on, so a spec measuring "10 of 30 rows have icons" sets it per row. */
    hasIcon: boolean;
    /** The ticker the dashboard pie writes on the slice; `null` falls back to the display name's monogram. */
    symbol: string | null;
    realizedGains: unknown[];
  }> = {},
): Record<string, unknown> {
  const instrumentId = overrides.instrumentId ?? INSTRUMENT_ID;
  return {
    instrumentId,
    // Root-cause fix (a tester finding): `HoldingResponse` now carries `kind` directly (see
    // `api/src/portfolios/portfolios.schema.ts`'s `valuedHoldingResponseSchema`)
    // — defaults to a backfillable kind so specs that don't care about `kind`
    // still exercise `HoldingHistoryStatus`'s default-mounted path.
    kind: "SHARE",
    // UR-8/UR-12: `HoldingResponse` now carries
    // `displayName` too, and the Positions screen renders it (never the raw
    // `instrumentId`) as the primary instrument label. Defaults to the same
    // value as `instrumentId` — every pre-UR-12 spec that only ever set a
    // custom `instrumentId` (many pass a human-readable string there, e.g.
    // `readme-screenshots.spec.ts`'s `"LVMH (MC.PA)"`, or filter rows by that
    // same string, e.g. `overview-holdings.spec.ts`) keeps seeing the
    // identical rendered text without any changes on its part — pass
    // `displayName` explicitly only when a spec needs a display name that
    // genuinely differs from `instrumentId`.
    displayName: instrumentId,
    // `null` by default — the pie then shows the monogram, exactly what
    // the holdings tile shows for the same row.
    symbol: null,
    quantity: "10",
    currency: "USD",
    pmp: valuedAmount("100.00", "USD"),
    costBasis: valuedAmount("1000.00", "USD"),
    currentPrice: valuedAmount("110.00", "USD"),
    currentValue: valuedAmount("1100.00", "USD"),
    unrealizedGainLoss: valuedAmount("100.00", "USD"),
    // IK-10: `false` by default, so every pre-existing spec keeps rendering
    // the monogram fallback it already asserts on and only a spec that opts in
    // sees an `<img>` — the same additive-with-a-safe-default shape
    // `displayName` took above.
    hasIcon: false,
    realizedGains: [],
    ...overrides,
  };
}

/**
 * `GET /api/v1/portfolios/closed-positions` (T-60) — the tenant-wide combined route `HoldingsRoute.tsx`'s
 * « Clôturées » tab reads. Mirrors `mockHoldings`'s own shape/convention
 * exactly, including the auto-incrementing `calcEpoch` unless pinned.
 *
 * Registered on the exact path (no trailing `*`) since `fetchClosedPositions`
 * sends no query string — this also means it cannot collide with
 * `mockPortfolios`'s broader `**\/api/v1/portfolios*` glob, whose trailing `*`
 * does not cross the `/` before `closed-positions` (Playwright's glob
 * semantics), so registration order between the two does not matter — but the
 * per-portfolio route (`:id/closed-positions`) is deliberately *not* mocked
 * here (this repo has no screen mounting it yet).
 */
export async function mockClosedPositions(
  page: RoutableTarget,
  overrides: Partial<{
    asOfDate: string;
    portfolioCount: number;
    closedPositions: unknown[];
    calcEpoch: string;
  }> = {},
): Promise<{ callCount: () => number }> {
  let callCount = 0;
  await page.route("**/api/v1/portfolios/closed-positions", async (route) => {
    callCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: "2026-08-15",
        closedPositions: [],
        calcEpoch: String(callCount),
        portfolioCount: 1,
        ...overrides,
      }),
    });
  });
  return { callCount: () => callCount };
}

/**
 * A single `ClosedPositionResponse` fixture (`api/src/portfolios/
 * portfolios.schema.ts`) — mirrors `mockHolding`'s own building-block shape.
 * `realizedGains` defaults to one gain leg so a spec that only cares about the
 * position-level figures does not also have to hand-build a sale lot.
 */
export function mockClosedPosition(
  overrides: Partial<{
    instrumentId: string;
    kind: string;
    displayName: string;
    hasIcon: boolean;
    currency: string;
    totalRealizedGainBase: unknown;
    totalRealizedGainNative: unknown;
    totalFxComponentBase: unknown;
    totalDisposedCostBasisBase: unknown;
    realizedGains: unknown[];
  }> = {},
): Record<string, unknown> {
  const instrumentId = overrides.instrumentId ?? INSTRUMENT_ID;
  return {
    instrumentId,
    kind: "SHARE",
    displayName: instrumentId,
    hasIcon: false,
    currency: "USD",
    totalRealizedGainBase: valuedAmount("42.00", "EUR"),
    totalRealizedGainNative: valuedAmount("50.00", "USD"),
    totalFxComponentBase: valuedAmount("1.00", "EUR"),
    totalDisposedCostBasisBase: valuedAmount("500.00", "EUR"),
    realizedGains: [
      {
        portfolioId: PORTFOLIO_ID,
        tradeDate: "2026-03-01",
        quantitySold: "5",
        gainBase: valuedAmount("42.00", "EUR"),
        gainNative: valuedAmount("50.00", "USD"),
        fxComponentBase: valuedAmount("1.00", "EUR"),
        proceedsBase: valuedAmount("500.00", "EUR"),
      },
    ],
    ...overrides,
  };
}

interface PriceHistoryPointFixture {
  priceDate: string;
  close: string;
  currency: string;
  sourceKey: string;
  origin: "MANUAL" | "AUTOMATED";
}

/**
 * `GET /instruments/:id/prices` + `POST /instruments/:id/prices`
 * (UR-13/UR-14) — one
 * mock registered on the shared path glob, method-checked, mirroring
 * `mockInstrumentHistoryStatus`'s own dedicated-glob precedent so this never
 * collides with `mockInstrumentSearch`'s broader `**\/api/v1/instruments*`.
 *
 * `get.items` backs every `GET` (both `ManualPriceDialog`'s own window fetch
 * and `ManualPriceForm`'s single-date pre-check — this fixture does not
 * distinguish the two call sites by query string beyond `from`/`to`
 * filtering, since they share one factory, `instrumentPricesQueryOptions`,
 * and priority assignment is per query-options factory). Filters `get.items`
 * by the request's own `from`/`to` (inclusive), the same window the real `GET /instruments/:id/prices` honors — this is
 * what lets `ManualPriceForm`'s single-date pre-check (`from === to ===` the
 * date being typed) see a genuinely different answer per date, exactly like
 * the real endpoint. `post.status`/`post.point` controls the `POST` outcome —
 * `201` with a `PriceHistoryPointResponse` body by default, or a
 * `problem+json` error for the cap/scale specs.
 */
type MockManualPriceOutcome =
  { status: 201; point?: Partial<PriceHistoryPointFixture> } | { status: 429 | 400; code: string };

export async function mockInstrumentPrices(
  page: RoutableTarget,
  options: {
    get?: PriceHistoryPointFixture[];
    post?: MockManualPriceOutcome;
  } = {},
): Promise<{ postCallCount: () => number }> {
  const getItems = options.get ?? [];
  let postCallCount = 0;
  await page.route("**/api/v1/instruments/*/prices*", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const url = new URL(request.url());
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const items = getItems.filter(
        (point) =>
          (from === null || point.priceDate >= from) && (to === null || point.priceDate <= to),
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, nextCursor: null }),
      });
      return;
    }
    if (request.method() === "POST") {
      postCallCount += 1;
      const outcome: MockManualPriceOutcome = options.post ?? { status: 201 };
      if ("code" in outcome) {
        await route.fulfill({
          status: outcome.status,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Manual price rejected",
            status: outcome.status,
            code: outcome.code,
          }),
        });
        return;
      }
      const body = JSON.parse(request.postData() ?? "{}") as {
        priceDate?: string;
        close?: string;
        currency?: string;
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          priceDate: body.priceDate ?? "2026-08-01",
          close: body.close ?? "42.50",
          currency: body.currency ?? "EUR",
          sourceKey: "manual",
          origin: "MANUAL",
          ...outcome.point,
        }),
      });
      return;
    }
    await route.fallback();
  });
  return { postCallCount: () => postCallCount };
}

/**
 * `GET /api/v1/portfolios/overview*` served from a fixed sequence of bodies
 * — the last one repeats for every call past the end of the array. Used by
 * `calc-epoch-refetch.spec.ts` to simulate a response that has not yet
 * caught up with a just-completed write (the exact race
 * `invalidateAndVerifyCalcEpoch` (`src/lib/calc-epoch.ts`) exists to survive)
 * before eventually returning the fresh, post-write figures.
 */
export async function mockOverviewSequence(
  page: RoutableTarget,
  bodies: readonly Record<string, unknown>[],
): Promise<{ callCount: () => number }> {
  let callCount = 0;
  await page.route("**/api/v1/portfolios/overview*", async (route) => {
    const body = bodies[Math.min(callCount, bodies.length - 1)];
    callCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return { callCount: () => callCount };
}

/**
 * `GET /api/v1/instruments/:id` (UR-9/UR-19) —
 * `instrument-names.ts`'s `useInstrumentNames` resolver's own read, this
 * suite's first e2e exercise of it at any real scale (the Instruments screen
 * itself is Phase 2). Looks up by id in `items`; a 404 for an id not in the
 * fixture mirrors the real `INSTRUMENT_NOT_FOUND` outcome rather than
 * silently 200-ing with a guessed body.
 */
export async function mockInstrumentById(
  page: RoutableTarget,
  items: InstrumentSummaryFixture[],
): Promise<void> {
  await page.route("**/api/v1/instruments/*", async (route) => {
    const url = new URL(route.request().url());
    // Exclude the two-segment-deeper sub-resources (`/prices`,
    // `/history-status`) — Playwright's `*` glob does not cross `/`, so
    // `**/api/v1/instruments/*` already only matches exactly one path
    // segment after `instruments`, but this guard also protects a caller
    // that registers this mock after a more specific one on the same target.
    if (/\/(prices|history-status)$/.test(url.pathname)) {
      await route.fallback();
      return;
    }
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const id = url.pathname.split("/").pop();
    const found = items.find((item) => item.id === id);
    if (found === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Instrument not found",
          status: 404,
          code: "INSTRUMENT_NOT_FOUND",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hasIcon: false, ...found }),
    });
  });
}

/**
 * `TransactionResponse`'s wire shape (UR-17,
 * `api/src/transactions/transactions.schema.ts`) — a full fixture builder so
 * every ledger e2e spec constructs a genuinely complete, valid transaction
 * rather than each hand-rolling its own partial object.
 */
export interface TransactionFixture {
  id: string;
  portfolioId: string;
  kind: string;
  tradeDate: string;
  tradeTs: string | null;
  seq: string;
  instrumentId: string | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string;
  txnCurrency: string | null;
  txnSettlementInstrumentId: string | null;
  targetCurrency: string | null;
  targetAmount: string | null;
  feeAmount: string | null;
  withholdingAmount: string | null;
  sourceDividendId: string | null;
  /** CA-21: the per-leg cash-account ids the edit form's pickers read (the withholding leg no longer has one). */
  cashAccountId: string | null;
  targetCashAccountId: string | null;
  /** FT-17/FT-22: the principal cash leg's settlement pair — `null`/`null` here, which is the degenerate case every pre-cycle fixture already was. */
  cashCurrency: string | null;
  cashAmount: string | null;
  /** `0047`'s four cost components — null here, the unitemised shape every fixture in this suite uses. */
  brokerFeeAmount: string | null;
  fxFeeAmount: string | null;
  taxAmount: string | null;
  otherCostAmount: string | null;
  fxRate: string;
  fxRateSource: string;
  fxRateProviderKey: string | null;
  fxRateObservedOn: string | null;
  fxRateUserInput: string | null;
  note: string | null;
  /** Security transfer — the other leg of a transfer, and a receiving leg's carried cost. `null` on every other kind. */
  transferLinkedTransactionId: string | null;
  transferLinkedPortfolioId: string | null;
  transferCostBase: string | null;
  transferCostNative: string | null;
  transferCostCurrency: string | null;
  createdAt: string;
  updatedAt: string;
}

export function transactionFixture(
  overrides: Partial<TransactionFixture> = {},
): TransactionFixture {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: PORTFOLIO_ID,
    kind: "BUY",
    tradeDate: "2026-08-01",
    tradeTs: "2026-08-01T10:00:00.000Z",
    seq: "1",
    instrumentId: INSTRUMENT_ID,
    quantity: "10",
    unitPrice: "100.00",
    grossAmount: "1000.00",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    fxRateProviderKey: null,
    fxRateObservedOn: null,
    fxRateUserInput: null,
    note: null,
    transferLinkedTransactionId: null,
    transferLinkedPortfolioId: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * `GET /api/v1/transactions?portfolio=&instrument=&from=&to=&kind=&currency=&minAmount=&maxAmount=&cursor=`
 * (UR-17/UR-19, AC95/AC96) — a genuinely paginated/
 * filtered in-memory mock over `items`, not a static fixture: `cursor` is a
 * plain string offset here (still opaque from the client's own point of
 * view, which never parses it — `search-params.ts`'s `asOpaqueCursor`), and
 * every one of `portfolio`/`instrument`/`from`/`to`/`kind`/`currency`/
 * `minAmount`/`maxAmount` is applied so a spec can assert a filter that would
 * fail if any one of them were silently dropped (AC96's own requirement), and
 * so are `order`/`limit` — the ledger screen reads newest-first and the
 * dashboard block reads five rows, neither of which a mock that ignored the two
 * parameters could tell apart from a client that had dropped them.
 * `GET /transactions/:id` is served from the same `items` array (AC97), so a
 * spec's fixture is the single source of truth for both the list and the
 * detail panel.
 */
const TRANSACTIONS_PAGE_SIZE = 20;

export async function mockTransactionsList(
  page: RoutableTarget,
  items: TransactionFixture[],
): Promise<void> {
  await page.route("**/api/v1/transactions*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    // `kind` is a server filter now, so the mock has to apply it
    // like the other four — a mock that ignored it would make a spec asserting
    // "the type filter filters the LEDGER" pass against a client that had gone
    // back to filtering the page. `currency` is the trade's
    // own `txnCurrency` (an asset-settled row's is null, and therefore never
    // matches — the server's documented silent exclusion), and the two bounds
    // are inclusive, in that currency, for the same reason. All eight live in
    // `filterTransactionFixtures`, shared with the calendar handler.
    const filtered = filterTransactionFixtures(items, url.searchParams);
    const cursor = url.searchParams.get("cursor");
    const offset = cursor !== null ? Number(cursor) : 0;
    // FR-264's `order=`, applied here for the same reason `kind` is: the ledger
    // screen asks for `desc` (newest-first) now, and a mock that ignored it
    // would let a client that had dropped the parameter pass a spec asserting
    // the newest row is on top. `limit=` likewise — the dashboard's
    // "dernières transactions" block asks for 5, not a 20-row page.
    const descending = url.searchParams.get("order") === "desc";
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam !== null ? Number(limitParam) : TRANSACTIONS_PAGE_SIZE;

    // The server's own total order — `(trade_date, seq, id)`, all three
    // flipped for `desc` so the order stays total and a page boundary can
    // neither duplicate nor skip a row (`transaction-read-service.ts`).
    const ordered = [...filtered].sort((a, b) => {
      const byDate = a.tradeDate.localeCompare(b.tradeDate);
      if (byDate !== 0) return descending ? -byDate : byDate;
      const bySeq = Number(a.seq) - Number(b.seq);
      if (bySeq !== 0) return descending ? -bySeq : bySeq;
      const byId = a.id.localeCompare(b.id);
      return descending ? -byId : byId;
    });

    const pageItems = ordered.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < ordered.length ? String(nextOffset) : null;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: pageItems, nextCursor }),
    });
  });

  await page.route("**/api/v1/transactions/*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const found = items.find((t) => t.id === id);
    if (found === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Transaction not found",
          status: 404,
          code: "TRANSACTION_NOT_FOUND",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(found),
    });
  });

  // `GET /transactions/calendar`, **computed from the same
  // items with the same filter function** as the list above, for the reason
  // the list applies its filters at all — a mock whose calendar disagreed with
  // its own list would let a client that dropped a filter from one of the two
  // pass a spec asserting they show the same rows. Registered after the `/*`
  // detail handler, which would otherwise catch `calendar` and 404 it (last
  // registered wins). Volume is Σ grossAmount × fxRate, as the server's.
  await page.route("**/api/v1/transactions/calendar*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const rows = filterTransactionFixtures(items, url.searchParams);
    const months = new Map<string, { count: number; volume: number }>();
    for (const row of rows) {
      const period = row.tradeDate.slice(0, 7);
      const bucket = months.get(period) ?? { count: 0, volume: 0 };
      bucket.count += 1;
      bucket.volume += Number(row.grossAmount) * Number(row.fxRate);
      months.set(period, bucket);
    }
    const years = new Map<string, { count: number; volume: number }>();
    let total = { count: 0, volume: 0 };
    for (const [period, bucket] of months) {
      const year = years.get(period.slice(0, 4)) ?? { count: 0, volume: 0 };
      year.count += bucket.count;
      year.volume += bucket.volume;
      years.set(period.slice(0, 4), year);
      total = { count: total.count + bucket.count, volume: total.volume + bucket.volume };
    }
    const serialise = (entries: Map<string, { count: number; volume: number }>) =>
      [...entries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, bucket]) => ({
          period,
          count: bucket.count,
          volumeBase: bucket.volume.toFixed(2),
        }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        baseCurrency: "EUR",
        total: { count: total.count, volumeBase: total.volume.toFixed(2) },
        years: serialise(years),
        months: serialise(months),
      }),
    });
  });
}

/**
 * The list's server-side filters, applied to a fixture — shared by the list
 * and the calendar handlers of {@link mockTransactionsList} so the two can
 * never disagree about which rows are in scope.
 */
function filterTransactionFixtures(
  items: readonly TransactionFixture[],
  params: URLSearchParams,
): TransactionFixture[] {
  const portfolio = params.get("portfolio");
  const instrument = params.get("instrument");
  const from = params.get("from");
  const to = params.get("to");
  const kinds = params
    .getAll("kind")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const currency = params.get("currency");
  const minAmount = params.get("minAmount");
  const maxAmount = params.get("maxAmount");

  let filtered = [...items];
  if (portfolio !== null) filtered = filtered.filter((t) => t.portfolioId === portfolio);
  if (instrument !== null) filtered = filtered.filter((t) => t.instrumentId === instrument);
  if (from !== null) filtered = filtered.filter((t) => t.tradeDate >= from);
  if (to !== null) filtered = filtered.filter((t) => t.tradeDate <= to);
  if (kinds.length > 0) filtered = filtered.filter((t) => kinds.includes(t.kind));
  if (currency !== null) filtered = filtered.filter((t) => t.txnCurrency === currency);
  if (minAmount !== null)
    filtered = filtered.filter((t) => Number(t.grossAmount) >= Number(minAmount));
  if (maxAmount !== null)
    filtered = filtered.filter((t) => Number(t.grossAmount) <= Number(maxAmount));
  return filtered;
}

/**
 * `GET /api/v1/portfolios/:id/cash` (CA-16/CA-19) — the « Espèces » tab's and
 * `CashAccountPicker`'s only read. Shape copied verbatim from
 * `api/src/portfolios/cash-accounts.schema.ts`'s `PortfolioCashResponse`.
 *
 * The glob is `.../api/v1/portfolios/<*>/cash`: Playwright's `*` does not
 * cross a `/`, so this is disjoint from `mockPortfolios`'s own
 * `.../api/v1/portfolios<*>` (which therefore never sees, and never has to
 * `fallback()` for, this route).
 *
 * `byCurrency` is **computed here from the account list**, not hand-written
 * per call site, for the same reason the real route computes it in one
 * statement: two representations of one figure can disagree, and a fixture
 * whose per-currency total silently contradicted its own rows would make the
 * workspace tab's RC4 assertion (archived balances are *in* the total)
 * vacuously true. Archived accounts are folded in, exactly as the server does.
 */
export interface CashAccountFixture {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
  balance: string;
  isNegative: boolean;
}

function foldCashByCurrency(accounts: readonly CashAccountFixture[]) {
  const order: string[] = [];
  const sums = new Map<string, { total: number; accountCount: number }>();
  for (const account of accounts) {
    if (!sums.has(account.currency)) {
      order.push(account.currency);
      sums.set(account.currency, { total: 0, accountCount: 0 });
    }
    const entry = sums.get(account.currency)!;
    entry.total += Number(account.balance);
    entry.accountCount += 1;
  }
  return order.map((currency) => {
    const entry = sums.get(currency)!;
    return {
      currency,
      total: entry.total.toFixed(2),
      accountCount: entry.accountCount,
      isNegative: entry.total < 0,
    };
  });
}

export async function mockPortfolioCash(
  page: RoutableTarget,
  accounts: readonly CashAccountFixture[],
  calcEpoch = "11",
): Promise<void> {
  await page.route("**/api/v1/portfolios/*/cash", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts,
        byCurrency: foldCashByCurrency(accounts),
        calcEpoch,
      }),
    });
  });
}

/**
 * `PATCH /api/v1/portfolios/:id/cash-accounts/:accountId` (CA-14) — rename or
 * archive/un-archive, exactly one field per request. Echoes the request back
 * as the updated row, and hands the caller a reader for the bodies it saw so
 * a spec can assert **which** field was sent rather than only that a write
 * happened.
 */
export async function mockPatchCashAccount(
  page: RoutableTarget,
  account: CashAccountFixture,
): Promise<{ bodies: () => Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/v1/portfolios/*/cash-accounts/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: account.id,
        name: typeof body["name"] === "string" ? body["name"] : account.name,
        currency: account.currency,
        archived: typeof body["archived"] === "boolean" ? body["archived"] : account.archived,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    });
  });
  return { bodies: () => bodies };
}

/* ========================================================================= *
 * `/api/v1/watchlist/*`
 * ========================================================================= */

/**
 * `GET /api/v1/watchlist/ids` (FR-363a) — the bounded id set every
 * `<WatchToggle>` on every screen resolves its state from (W-6).
 *
 * Registered by {@link mockAuthenticatedSession} with an **empty** set, which
 * is the pre-watchlist behaviour of every screen in this suite: no row is
 * watched, so every toggle renders « Suivre » and nothing about an existing
 * spec's assertions changes. A spec that needs a watched instrument registers
 * this again with its own ids — the later registration is the one Playwright
 * tries first.
 *
 * Returns a reader for the ids it last answered with, and a setter, so a spec
 * can make a **refetch see a different set** without a second `page.route`
 * (registering the same path twice is the "last handler wins" trap
 * `concurrency-helpers.ts` records).
 */
export async function mockWatchedInstrumentIds(
  page: RoutableTarget,
  ids: readonly string[] = [],
): Promise<{ set: (next: readonly string[]) => void; callCount: () => number }> {
  let current = [...ids];
  let callCount = 0;
  await page.route("**/api/v1/watchlist/ids", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    callCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // Ordered by id server-side, so a client that diffs the list sees a
      // stable order — mirrored here rather than echoing the caller's order.
      body: JSON.stringify({ instrumentIds: [...current].sort() }),
    });
  });
  return {
    set: (next: readonly string[]) => {
      current = [...next];
    },
    callCount: () => callCount,
  };
}

/**
 * One `WatchlistRow` (`api/src/watchlist/watchlist.schema.ts`, mirrored in
 * `web/src/lib/api/watchlist.ts`) — the same builder shape `mockHolding` and
 * `mockClosedPosition` already use.
 *
 * **"Unavailable" is an absent key** (W-10/AC-331), so a spec exercising the
 * unavailable state passes `metrics: { unusableSeries: false, periodReturns: {} }`
 * rather than nulls or zeros, and drops `currentPrice` entirely for the
 * no-price row (FR-346/UR-54(b)).
 */
export function mockWatchlistRow(
  overrides: Partial<{
    instrumentId: string;
    kind: string;
    displayName: string;
    hasIcon: boolean;
    listingCurrency: string;
    targetPrice: string | null;
    note: string | null;
    currentPrice: unknown;
    dayChange: string;
    dayChangePercent: string;
    metrics: unknown;
    series: unknown[];
  }> = {},
): Record<string, unknown> {
  const instrumentId = overrides.instrumentId ?? INSTRUMENT_ID;
  return {
    instrumentId,
    kind: "SHARE",
    displayName: instrumentId,
    hasIcon: false,
    status: "ACTIVE",
    listingCurrency: "USD",
    listingCountry: "US",
    sectorCode: null,
    industryLabel: null,
    domicileCountry: null,
    watchedSince: "2026-01-15",
    targetPrice: null,
    note: null,
    currentPrice: {
      amount: "198.20",
      currency: "USD",
      provenance: { derivedFrom: [], priceAsOf: "2026-08-15", priceIsStale: false },
    },
    dayChange: "1.20",
    dayChangePercent: "0.0061",
    metrics: {
      unusableSeries: false,
      periodReturns: { "1Y": "0.1234" },
      fiftyTwoWeek: {
        high: "220.00",
        low: "150.00",
        highDate: "2026-07-01",
        lowDate: "2025-10-02",
        distanceFromHigh: "-0.0991",
      },
      maxDrawdown: { fraction: "-0.25", peakDate: "2026-07-01", troughDate: "2026-08-01" },
      annualisedVolatility: "0.31",
      sma50: "190.00",
      sma200: "170.00",
      priceVsSma50: "0.0432",
      priceVsSma200: "-0.1659",
    },
    series: [
      { date: "2026-08-01", close: "180.00" },
      { date: "2026-08-15", close: "190.00" },
      { date: "2026-09-01", close: "198.20" },
    ],
    ...overrides,
  };
}

/**
 * `GET /api/v1/watchlist?window=` (FR-355/FR-361) — the Suivi screen's own
 * read, and the one read whose payload a spec needs to be able to **change
 * between two calls** (AC-346: a re-watched instrument must show freshly
 * computed metrics, not the ones cached before it was removed).
 *
 * `rows` is therefore a function of the call, not a fixed array: the handler
 * asks for the rows each time it answers, so a spec mutates its own fixture
 * and the next refetch sees it. The alternative — a second `page.route` for
 * the changed payload — is the last-handler-wins trap, and would also
 * silently shadow the first handler's request counting.
 */
export async function mockWatchlist(
  page: RoutableTarget,
  rows: () => readonly Record<string, unknown>[],
  overrides: Partial<{ asOfDate: string }> = {},
): Promise<{ windows: () => string[] }> {
  const windows: string[] = [];
  await page.route("**/api/v1/watchlist*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const preset = url.searchParams.get("window") ?? "1Y";
    windows.push(preset);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOfDate: overrides.asOfDate ?? "2026-08-15",
        // Echoed from the request, exactly as the server resolves it, so the
        // window the metrics were computed over and the window the response
        // reports cannot disagree in a fixture either.
        window: { preset, from: "2025-08-15", to: "2026-08-15" },
        rows: rows(),
      }),
    });
  });
  return { windows: () => windows };
}

/**
 * `POST /api/v1/watchlist` (FR-338/FR-342/FR-375) — watch, or re-watch.
 *
 * **200 on every call**, first add and repeat alike: the route is an
 * idempotent upsert, and a spec asserting a 201 would be asserting a contract
 * the server does not have. Method-checked on the same glob
 * {@link mockWatchlist} uses, `route.fallback()`ing to it for `GET` —
 * `mockCreatePortfolio`/`mockPortfolios`' own arrangement.
 *
 * The returned reader hands back the bodies it saw, so a spec can assert
 * **which instrument** was watched rather than only that a write happened.
 */
export async function mockWatchWrite(
  page: RoutableTarget,
  outcome: { status: 200 } | { status: 404 | 429; code: string } = { status: 200 },
): Promise<{ bodies: () => Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/v1/watchlist*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    if ("code" in outcome) {
      await route.fulfill({
        status: outcome.status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Watch refused",
          status: outcome.status,
          code: outcome.code,
        }),
      });
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instrumentId: body["instrumentId"],
        targetPrice: body["targetPrice"] ?? null,
        note: body["note"] ?? null,
        watchedSince: "2026-08-15",
      }),
    });
  });
  return { bodies: () => bodies };
}

/**
 * `PATCH` and `DELETE /api/v1/watchlist/:instrumentId` (FR-340/FR-341/
 * FR-374/FR-375) — the target-price/note edit and the un-watch, on one
 * per-instrument glob.
 *
 * `DELETE` answers **204 whether or not a row existed, and never 404** (the
 * server's own contract: two tabs or a double-click must not make the second
 * attempt an error for having succeeded). `PATCH` echoes the stored row —
 * deliberately **not** a valued `WatchlistRow`, which is why the screen
 * re-reads instead of patching a row in place from the write's answer
 * (AC-345).
 *
 * Registered on `**\/api/v1/watchlist/*`, which also matches
 * `/watchlist/ids`; the method check falls through for `GET`, so
 * {@link mockWatchedInstrumentIds} still answers it whichever order the two
 * are registered in.
 */
export async function mockWatchlistItemWrites(
  page: RoutableTarget,
): Promise<{ patches: () => Record<string, unknown>[]; deletes: () => string[] }> {
  const patches: Record<string, unknown>[] = [];
  const deletes: string[] = [];
  await page.route("**/api/v1/watchlist/*", async (route) => {
    const request = route.request();
    const instrumentId = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (request.method() === "PATCH") {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push({ instrumentId, ...body });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instrumentId,
          targetPrice: body["targetPrice"] ?? null,
          note: body["note"] ?? null,
          watchedSince: "2026-01-15",
        }),
      });
      return;
    }
    if (request.method() === "DELETE") {
      deletes.push(instrumentId);
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fallback();
  });
  return { patches: () => patches, deletes: () => deletes };
}

/**
 * `/api/v1/admin/*` — the instance admin's three routes (`account-setup`
 * FR-421/FR-422/FR-424, T-99).
 *
 * Every body below is `api/src/admin/admin.schema.ts`'s
 * `AdminUserResponse`/`resetPasswordBodySchema` verbatim, this file's
 * standing convention: five fields (no `baseCurrency` — it is the
 * tenant's, chosen once at setup), both instants ISO-8601 **UTC strings with
 * second precision** (the server's `to_char(… 'YYYY-MM-
 * DD"T"HH24:MI:SS"Z"')` idiom), and `lastLoginAt` `null` rather than absent
 * for an account that has never been used.
 *
 * `GET` and `POST /admin/users` share a URL and Playwright routes on URL
 * only, so — exactly like the three `/auth/setup` fixtures above — each
 * handler branches on `route.request().method()` and `route.fallback()`s
 * otherwise. Register the `GET` one **first**: the last-registered handler
 * wins, and the `POST` one falling back is what lets the read still be
 * answered.
 */
export function adminUserFixture(
  overrides: Partial<{
    userId: string;
    tenantId: string;
    email: string;
    createdAt: string;
    lastLoginAt: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    userId: overrides.userId ?? USER_ID,
    tenantId: overrides.tenantId ?? TENANT_ID,
    email: overrides.email ?? EMAIL,
    createdAt: overrides.createdAt ?? "2026-01-15T08:00:39Z",
    lastLoginAt:
      overrides.lastLoginAt === undefined ? "2026-09-18T17:42:10Z" : overrides.lastLoginAt,
  };
}

/**
 * `GET /api/v1/admin/users` (FR-421) — `{ items }`, the codebase's list
 * envelope. `rows` is a **thunk** (`mockWatchlist`'s own arrangement) so a
 * spec can let the list change between two reads and assert what the
 * post-invalidation refetch brings back, rather than re-registering a
 * handler mid-test.
 */
export async function mockAdminUsers(
  page: RoutableTarget,
  rows: () => readonly Record<string, unknown>[],
): Promise<void> {
  await page.route("**/api/v1/admin/users", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: rows() }),
    });
  });
}

/**
 * `POST /api/v1/admin/users` (FR-422; the user joins the admin's own
 * tenant, so the body is `{ email, password }` and the answered `tenantId` is
 * the admin's) — answers `{ tenantId, userId }` and **no cookies**: unlike
 * `POST /auth/setup`, provisioning as an admin does not log the admin in as
 * the new user.
 *
 * `onCreate` runs before the response is fulfilled, so a spec that appends to
 * the array {@link mockAdminUsers} reads has the new row in place by the time
 * the screen's invalidation refetches.
 */
export async function mockCreateTenantUser(
  page: RoutableTarget,
  onCreate: (body: Record<string, unknown>) => void = () => undefined,
): Promise<{ bodies: () => Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/v1/admin/users", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    bodies.push(body);
    onCreate(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tenantId: TENANT_ID,
        userId: "00000000-0000-7000-8000-0000000c0001",
      }),
    });
  });
  return { bodies: () => bodies };
}

/**
 * `POST /api/v1/admin/users/:id/password` (FR-424) — `{}` on success.
 *
 * The reader hands back the target id and the body, so a spec can assert
 * **whose** password was reset and that the request carried `newPassword`
 * and nothing else (UR-73's "no current password" is a property of the
 * request as much as of the form).
 */
export async function mockResetUserPassword(
  page: RoutableTarget,
): Promise<{ resets: () => { userId: string; body: Record<string, unknown> }[] }> {
  const resets: { userId: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/admin/users/*/password", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const segments = new URL(route.request().url()).pathname.split("/");
    resets.push({
      userId: segments[segments.length - 2] ?? "",
      body: (route.request().postDataJSON() ?? {}) as Record<string, unknown>,
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return { resets: () => resets };
}
