import { expect, test } from "@playwright/test";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { TENANT_ID, USER_ID, EMAIL } from "./mocks.js";
import { goOffline } from "./network.js";

/**
 * Security review finding F9 (LOW): `ensureQueryData` with no
 * options of its own never revalidates existing cached data — not "for up
 * to `staleTime`" as `authQueryOptions`'s plain `staleTime: 60_000` implies,
 * but *indefinitely*, since staleness is only ever consulted when
 * `revalidateIfStale` is set. `router.tsx`'s guard now passes
 * `revalidateIfStale: true`.
 *
 * `api-cache-guard.spec.ts` (F2) deliberately asserts at the raw
 * `fetch()`/service-worker layer, not the router guard layer — this file is
 * the guard-layer proof `revalidateIfStale` needs: it counts real
 * `GET /auth/me` hits across navigations, using `page.clock` to jump past
 * `staleTime` (60s) without an actual 60-second wait.
 */
test("the guard revalidates auth/me once stale, but not on every nav while fresh", async ({
  page,
}) => {
  await page.clock.install();

  let authMeHits = 0;
  await page.route("**/api/v1/auth/me", async (route) => {
    authMeHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tenantId: TENANT_ID, userId: USER_ID, email: EMAIL }),
    });
  });
  await page.route("**/api/v1/portfolios/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2026-01-01",
        to: "2026-08-15",
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        return: { twr: {}, mwr: {} },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
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
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });

  await gotoAppShell(page);
  expect(authMeHits).toBe(1);

  // Fresh (well within the 60s staleTime): navigating between authenticated
  // routes must not spam `auth/me` again — `revalidateIfStale` must not
  // regress the original "second navigation does not refetch needlessly"
  // intent for the non-stale case.
  await navigateViaNav(page, "Positions");
  await expect(page.getByTestId("holdings-screen")).toBeVisible();
  await navigateViaNav(page, "Aperçu");
  await expect(page.getByTestId("overview-screen")).toBeVisible();
  expect(authMeHits).toBe(1);

  // Jump well past staleTime without an actual 60s wait.
  await page.clock.fastForward("01:05");

  await navigateViaNav(page, "Positions");

  // The navigation itself is never blocked on the revalidation (it is a
  // fire-and-forget background prefetch — `query-core`'s own
  // `ensureQueryData`) — the guard still resolves immediately from cache.
  await expect(page.getByTestId("holdings-screen")).toBeVisible();

  // ...but the background revalidation does happen, shortly after.
  await expect
    .poll(() => authMeHits, { message: "stale auth/me should be revalidated in the background" })
    .toBeGreaterThanOrEqual(2);
});

/**
 * Adjacent path (this fix must not break, per the review's own instruction
 * to "walk it"): once `auth/me` is stale and the network then drops, a
 * background revalidation with the default `networkMode: "online"` *pauses*
 * rather than rejects (unlike the logout mutation, F6, which was
 * deliberately switched to `"always"` — this is a read, not a
 * user-initiated action, so pausing rather than forcing a doomed fetch is
 * the correct behaviour here). `ensureQueryData` must still resolve
 * immediately from the cached data regardless — offline navigation between
 * already-loaded, authenticated screens (T-42 AC3) must keep working, not
 * hang waiting on a paused revalidation that will never resolve until back
 * online.
 */
test("offline navigation after auth/me goes stale still works (revalidation pauses, guard does not hang)", async ({
  page,
  context,
}) => {
  await page.clock.install();

  // Without this counter neither of these two tests can tell
  // offline from online. Every route they need is `page.route`-fulfilled,
  // and a fulfilled route answers regardless of the offline flag — so the
  // screen renders from cache either way and both tests passed with
  // `goOffline` deleted. The behaviour actually under test is that the
  // *revalidation itself pauses* (`networkMode: "online"`, keyed off
  // `navigator.onLine`), and that is observable exactly here: stale plus a
  // navigation would fire a fresh `auth/me` online, and must fire none
  // offline.
  let authMeRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/auth/me")) {
      authMeRequests += 1;
    }
  });

  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tenantId: TENANT_ID, userId: USER_ID, email: EMAIL }),
    });
  });
  await page.route("**/api/v1/portfolios/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2026-01-01",
        to: "2026-08-15",
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        return: { twr: {}, mwr: {} },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
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
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });

  await gotoAppShell(page);

  await page.clock.fastForward("01:05");
  const authMeRequestsBeforeOffline = authMeRequests;
  await goOffline(page, context);

  await navigateViaNav(page, "Positions");

  // Must render promptly from cache, not hang waiting on the (paused)
  // background revalidation, and must not have been bounced to `/login`
  // either — a paused revalidation is not a guard failure.
  await expect(page.getByTestId("holdings-screen")).toBeVisible({ timeout: 5_000 });
  await expect(page).not.toHaveURL(/\/login$/);

  // The revalidation was paused, not merely invisible: no `auth/me` left the
  // page while offline, despite the entry being stale.
  expect(
    authMeRequests,
    "a stale auth/me must not be revalidated while offline — networkMode 'online' pauses it",
  ).toBe(authMeRequestsBeforeOffline);
});

/**
 * Security review finding F11 (MEDIUM): `authQueryOptions` never
 * has an active observer anywhere in the app (only ever touched
 * imperatively via `ensureQueryData` here), so the default 5-minute
 * `gcTime` starts counting down the moment the query is first built,
 * regardless of navigation activity — this query would be auto-evicted
 * well within a single idle tab. Once evicted, the *next* `beforeLoad` sees
 * no cached data at all and falls back to a *blocking* `fetchQuery`, which
 * — offline, default `networkMode: "online"` — pauses indefinitely rather
 * than rejecting, freezing the navigation forever (confirmed against the
 * unfixed code below: it never settles inside this test's 8s bound, unlike
 * every other assertion in this file). `gcTime: Infinity` (`queries.ts`)
 * closes this for as long as the guard has fetched successfully once.
 */
test("offline navigation still settles even after the auth/me entry would have hit the old default gcTime", async ({
  page,
  context,
}) => {
  await page.clock.install();

  // Without this counter neither of these two tests can tell
  // offline from online. Every route they need is `page.route`-fulfilled,
  // and a fulfilled route answers regardless of the offline flag — so the
  // screen renders from cache either way and both tests passed with
  // `goOffline` deleted. The behaviour actually under test is that the
  // *revalidation itself pauses* (`networkMode: "online"`, keyed off
  // `navigator.onLine`), and that is observable exactly here: stale plus a
  // navigation would fire a fresh `auth/me` online, and must fire none
  // offline.
  let authMeRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/auth/me")) {
      authMeRequests += 1;
    }
  });

  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tenantId: TENANT_ID, userId: USER_ID, email: EMAIL }),
    });
  });
  await page.route("**/api/v1/portfolios/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2026-01-01",
        to: "2026-08-15",
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        return: { twr: {}, mwr: {} },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
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
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });

  await gotoAppShell(page);

  // Past the *old* default `gcTime` (5 minutes) — the point at which the
  // cache entry used to silently disappear, without ever needing a real
  // 6-minute wait.
  await page.clock.fastForward("06:00");
  const authMeRequestsBeforeOffline = authMeRequests;
  await goOffline(page, context);

  await navigateViaNav(page, "Positions");

  // Must settle — either rendering Holdings (the cached answer survived,
  // `gcTime: Infinity` doing exactly what it's for; the expected, immediate
  // path) or redirecting to `/login` (the guard's own fail-closed 10s
  // timeout, F15 — the remaining backstop for whatever case still reaches a
  // blocking fetch) — within a bounded time. Never an indefinite freeze
  // either way. 12s comfortably covers the slower (timeout) branch too.
  const holdingsOrLogin = page.getByTestId("holdings-screen").or(page.getByTestId("login-email"));
  await expect(holdingsOrLogin).toBeVisible({ timeout: 12_000 });

  // The revalidation was paused, not merely invisible: no `auth/me` left the
  // page while offline, despite the entry being stale.
  expect(
    authMeRequests,
    "a stale auth/me must not be revalidated while offline — networkMode 'online' pauses it",
  ).toBe(authMeRequestsBeforeOffline);
});

/**
 * F11's other half: even with `gcTime: Infinity`, the *very first* fetch of
 * a page load (nothing cached yet at all) still takes the blocking
 * `fetchQuery` path — and that path can hang for reasons that have nothing
 * to do with `navigator.onLine` (an unresponsive server, a broken proxy,
 * ...). `router.tsx`'s `AUTH_GUARD_TIMEOUT_MS` (10s — raised from an initial
 * 5s, F15, security review, since 5s risked evicting a
 * genuine user on a merely slow cold start) races the probe and fails closed
 * to `/login` rather than freezing the app on a screen that looks broken
 * with no way out. `auth/me` here never resolves at all (`page.route` with a
 * promise that never settles) — the most direct way to force exactly the
 * "hangs indefinitely" failure mode, regardless of its real-world cause.
 */
test("the guard fails closed and redirects to /login, rather than hanging, when auth/me never responds", async ({
  page,
}) => {
  await page.route(
    "**/api/v1/auth/me",
    () =>
      new Promise(() => {
        // Deliberately never resolves/rejects/fulfills — the request just
        // hangs, forever, from the page's point of view.
      }),
  );

  const start = Date.now();
  await page.goto("/");

  // Bounded well above the guard's own 10s timeout (but nowhere near an
  // indefinite freeze) — fails if this regresses back to hanging.
  await expect(page).toHaveURL(/\/login$/, { timeout: 14_000 });
  const elapsed = Date.now() - start;

  // Didn't resolve suspiciously fast either — proves the redirect actually
  // came from the guard's own ~10s timeout firing, not some unrelated,
  // instant fast path that would make this assertion meaningless.
  expect(elapsed).toBeGreaterThanOrEqual(9_500);
});

/**
 * F11/F15's required adjacent-path check: the fail-closed timeout must not
 * fire on a merely *slow*, but still legitimately successful, online round
 * trip — and this assertion must not itself be a tight race against the
 * guard's own timeout (F15: the previous 4s window against a 5s guard
 * timeout was a CI flake risk that would only have gotten re-baselined
 * upward). This now bounds only "the guard did not fire": a comfortably
 * long wait (15s — well above `AUTH_GUARD_TIMEOUT_MS`'s 10s) for the
 * Overview screen, plus an explicit "never redirected" check, so this test
 * can only fail if the guard actually fired, never on ordinary timing
 * variance.
 */
test("the guard does not fail closed on a merely slow (2s), but successful, auth/me response", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tenantId: TENANT_ID, userId: USER_ID, email: EMAIL }),
    });
  });
  await page.route("**/api/v1/portfolios/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        from: "2026-01-01",
        to: "2026-08-15",
        totalValue: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
        return: { twr: {}, mwr: {} },
        calcEpoch: "1",
        portfolioCount: 1,
      }),
    });
  });

  await page.goto("/");
  // Bounded well above `AUTH_GUARD_TIMEOUT_MS` (10s) — this can only fail if
  // the guard actually fires and redirects instead of rendering Overview.
  await expect(page.getByTestId("overview-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/login$/);
});
