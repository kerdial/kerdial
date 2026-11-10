import { expect, type BrowserContext, test } from "@playwright/test";
import { PASSWORD } from "./mocks.js";
import { logOut } from "./nav-helpers.js";

/**
 * Coordinator-reviewed residual-risk fix, additive to ADR-0009 Stage 1 (this
 * is **not** a partial revival of the retired Cache-Storage purge machinery
 * — `queryClient.clear()` is plain, synchronous, in-memory eviction; it
 * never touches Cache Storage, IndexedDB, `BroadcastChannel`, or cookies).
 *
 * `AR-20`/`AR-21` correctly removed the reproduced Cache-Storage half of
 * HIGH-1 (a `NetworkFirst` fallback serving a previous tenant's cached
 * holdings), but retiring the *whole* purge machinery also removed every
 * `queryClient.clear()` call, and `queryClient` is a **module-scope
 * singleton** (`main.tsx`) that survives a client-side
 * logout -> `/login` -> a *different* user logging in, with no reload.
 * Several query-key factories (e.g. `overviewQueryOptions`) carry no
 * tenant/user identity at all, so without an explicit eviction, a second
 * user logging in on the same tab could read the first user's still-cached
 * figures — this is the exact guarantee the deleted `cross-user-purge.spec.ts`
 * test 2 held, restored here scoped to memory (Cache Storage's own half of
 * that guarantee is `api-cache-guard.spec.ts`'s job,
 * unaffected by this fix).
 *
 * The discriminating technique: Bob's own overview response is deliberately
 * delayed. `useQuery`'s cache-then-network behaviour means that if Alice's
 * entry survived in memory, `overview-total-value` would render Alice's
 * total **immediately**, synchronously, on mount — before Bob's own
 * (delayed) fetch ever resolves, and only transiently (Bob's own fetch
 * genuinely replaces it once it resolves, bug or no bug). That transience is
 * exactly why this cannot use a *retrying* Playwright assertion
 * (`expect(locator).toHaveCount(0)`) for the absence check: a retrying
 * assertion waits for its condition to become true at *any* point inside its
 * own timeout and succeeds the moment it does, so "Alice's total is gone" is
 * trivially, eventually true either way, once Bob's own data arrives — it
 * cannot tell "never appeared" from "appeared, then went away on its own"
 * (confirmed empirically while building this test: a `toHaveCount(0)` here
 * passed even with the fix reverted). A plain, one-shot, non-retrying
 * `.count()` read, taken the instant `overview-screen` exists (itself an
 * event-anchored wait, not a guessed wall-clock buffer — this repo's own
 * recorded lesson against load-dependent waits), is what actually
 * discriminates: it inspects the very first paint, not "eventually".
 *
 * `context.route`, not `page.route` (coordinator instruction): this suite's
 * dev-enabled service worker can take control of the page mid-test exactly
 * as every other SW-aware spec in this repo documents
 * (`api-cache-guard.spec.ts`'s own note) — a page-level route would be
 * silently bypassed once that happens.
 */

const ALICE = { tenantId: "tenant-alice", userId: "user-alice", email: "alice@example.com" };
const BOB = { tenantId: "tenant-bob", userId: "user-bob", email: "bob@example.com" };
const ALICE_TOTAL = "42424.00";
// What the screen shows for ALICE_TOTAL: `<Figure>` groups thousands with a
// narrow no-break space, and Playwright's text matchers normalise that to a
// plain space. The wire value above stays ungrouped. Keeping the two apart
// matters most for the `count()).toBe(0)` assertions below, which would pass
// vacuously against a string the screen can never render.
const ALICE_TOTAL_SHOWN = "42 424.00";
const BOB_TOTAL = "1.00";
const BOB_OVERVIEW_DELAY_MS = 1_500;

async function mockLoginAs(
  context: BrowserContext,
  user: { tenantId: string; userId: string },
): Promise<void> {
  await context.unroute("**/api/v1/auth/login");
  await context.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "set-cookie": [
          "sid=test-session-token; Path=/; HttpOnly; SameSite=Lax",
          "csrf_token=test-csrf-token; Path=/; SameSite=Lax",
        ].join("\n"),
      },
      body: JSON.stringify({ tenantId: user.tenantId, userId: user.userId }),
    });
  });
}

async function mockAuthMeAs(
  context: BrowserContext,
  user: { tenantId: string; userId: string; email: string },
): Promise<void> {
  await context.unroute("**/api/v1/auth/me");
  await context.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(user),
    });
  });
}

function overviewBody(totalValue: string) {
  return {
    from: "2026-01-01",
    to: "2026-08-15",
    totalValue: { amount: totalValue, currency: "EUR", provenance: { derivedFrom: [] } },
    unrealizedGainLoss: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
    return: { twr: {}, mwr: {} },
    calcEpoch: "1",
    portfolioCount: 1,
  };
}

/**
 * LOW-1 (security review): this suite's
 * dev-enabled service worker forwards any unmocked `/api/v1/**` call
 * through the Vite dev-server proxy to whatever is actually listening on
 * `:3000` — `scripts/dev-up.sh` now auto-starts a
 * real API there. `OverviewRoute` (post-UR-41) also fires
 * `GET /portfolios/holdings`, `GET /portfolios?limit=`, and
 * `GET /transactions?limit=`, none of which either test below mocks
 * explicitly. If a real server answers any of those with a 401,
 * `main.tsx`'s global `MutationCache`/`QueryCache` handler clears the
 * cache and redirects on its own — this suite's own assertions would then
 * pass for the wrong reason (a vacuous green, this repo's own recorded
 * recurring failure mode), independent of whichever bug is actually under
 * test. Registered first in each test, before every more specific
 * `context.route` call: Playwright matches the most-recently-registered
 * route first, so the specific mocks below always take precedence over
 * this fallback.
 */
async function mockUnrelatedEndpointsSafely(context: BrowserContext): Promise<void> {
  await context.route("**/api/v1/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/portfolios/holdings")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          asOfDate: "2026-01-01",
          holdings: [],
          totalValue: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
          totalUnrealizedGainLoss: {
            amount: "0",
            currency: "EUR",
            provenance: { derivedFrom: [] },
          },
          calcEpoch: "1",
          portfolioCount: 0,
        }),
      });
      return;
    }
    if (url.includes("/transactions")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (/\/api\/v1\/portfolios(\?|$)/.test(url)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    // Generic fallback for anything else unmocked — never a 401, for the
    // same reason as above.
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

test("a second user logging in on the same tab never sees the first user's figures, not even transiently (in-memory QueryClient isolation)", async ({
  page,
  context,
}) => {
  await mockUnrelatedEndpointsSafely(context);

  // --- Alice logs in and loads the overview screen. ---
  await mockLoginAs(context, ALICE);
  await mockAuthMeAs(context, ALICE);
  await context.route("**/api/v1/portfolios/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overviewBody(ALICE_TOTAL)),
    });
  });
  await context.route("**/api/v1/auth/logout", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/login");
  await page.getByTestId("login-email").fill(ALICE.email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("overview-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("overview-total-value")).toContainText(`${ALICE_TOTAL_SHOWN} EUR`);

  // --- Alice logs out, on this same tab. ---
  await logOut(page);
  await expect(page).toHaveURL(/\/login$/);

  // --- Bob logs in, on the same tab/device. His own overview response is
  // deliberately delayed — see this file's own top-level note on why. ---
  await mockLoginAs(context, BOB);
  await mockAuthMeAs(context, BOB);
  await context.unroute("**/api/v1/portfolios/overview*");
  await context.route("**/api/v1/portfolios/overview*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, BOB_OVERVIEW_DELAY_MS));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overviewBody(BOB_TOTAL)),
    });
  });

  await page.getByTestId("login-email").fill(BOB.email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();

  // The discriminating check. A fixed wall-clock buffer here would be racy
  // against this environment's own load (this repo's own recorded lesson: a
  // load-dependent wait must never stand in for an event-based sync) — and a
  // retrying assertion like `toHaveCount(0)` resolves the instant its
  // condition is true, including on its very *first* check straight after
  // `click()`, before React has had any chance to render at all, which would
  // trivially "pass" without ever having looked at the moment that matters.
  // Anchoring on `overview-screen` becoming visible instead ties the check to
  // a real event: `OverviewRoute`'s `<section>` and its `useQuery`'s first
  // read of the cache commit in the very same React render pass, so the
  // instant the section exists, whatever `useQuery` first read (a surviving
  // cache entry, or nothing) has already painted — deterministically,
  // regardless of how long the login/guard round trip actually took.
  await expect(page.getByTestId("overview-screen")).toBeVisible({ timeout: 10_000 });
  // A plain, one-shot `.count()` read — deliberately **not**
  // `expect(locator).toHaveCount(0)`, which is a *retrying* assertion that
  // waits for the condition to become true at any point inside its own
  // timeout and succeeds the moment it does. Since Alice's total is only
  // ever transient here (Bob's own fetch genuinely replaces it once it
  // resolves, bug or no bug), a retrying "eventually 0" assertion would
  // pass either way — it cannot tell "never appeared" from "appeared, then
  // went away on its own". A single, non-retrying snapshot, taken the
  // instant `overview-screen` exists, is what actually discriminates.
  expect(await page.getByText(`${ALICE_TOTAL_SHOWN} EUR`).count()).toBe(0);

  // Eventually, once Bob's own (delayed) fetch resolves, his own total
  // appears — proving the assertion above was a real, discriminating result
  // and not simply "nothing is ever rendered in this environment".
  await expect(page.getByTestId("overview-total-value")).toContainText(`${BOB_TOTAL} EUR`, {
    timeout: BOB_OVERVIEW_DELAY_MS + 5_000,
  });
  await expect(page.getByTestId("overview-total-value")).not.toContainText(
    `${ALICE_TOTAL_SHOWN} EUR`,
  );
});

const AUTH_ME_AFTER_LOGOUT_DELAY_MS = 1_500;

/**
 * MEDIUM-1 (security review): `AppShell.tsx`'s
 * logout `onSettled` navigated to `/login` but never called
 * `queryClient.clear()` — the one call site this file's own top-level note
 * says the retired purge machinery left behind at *login* and the global
 * 401 handler, but not at logout. `queryClient` is a module-scope singleton
 * that survives the client-side `/login` navigation with no reload, so a
 * browser Back after an explicit logout re-entered the authenticated shell
 * and painted the previous session's still-cached `["auth","me"]` and
 * `["portfolios","overview",...]` entries — both `gcTime: Infinity` —
 * before the guard's own background revalidation (`revalidateIfStale`) had
 * any chance to observe the session was already dead server-side.
 *
 * The discriminating technique mirrors the test above: `auth/me`'s
 * post-logout response is deliberately delayed. With the fix
 * (`queryClient.clear()` on logout), the guard has nothing cached to
 * resolve `ensureQueryData` from, so it *blocks* on the delayed fetch —
 * `OverviewRoute` cannot mount, and Alice's total cannot appear, for the
 * entire delay window. Without the fix, the guard resolves synchronously
 * from the surviving cache entry, `OverviewRoute` mounts immediately, and
 * its own `useQuery` reads the equally-surviving overview entry — painting
 * Alice's total well before the delayed `auth/me` response ever lands. A
 * one-shot, non-retrying check taken right after `goBack()` is what
 * discriminates (the same "cannot tell 'never appeared' from 'appeared,
 * then went away'" reasoning the test above documents applies here too).
 */
test("logging out, then pressing Back, never re-enters the authenticated shell with the previous session's figures (MEDIUM-1)", async ({
  page,
  context,
}) => {
  await mockUnrelatedEndpointsSafely(context);
  await mockLoginAs(context, ALICE);
  await mockAuthMeAs(context, ALICE);
  await context.route("**/api/v1/portfolios/overview*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overviewBody(ALICE_TOTAL)),
    });
  });
  await context.route("**/api/v1/auth/logout", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/login");
  await page.getByTestId("login-email").fill(ALICE.email);
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("overview-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("overview-total-value")).toContainText(`${ALICE_TOTAL_SHOWN} EUR`);

  await logOut(page);
  await expect(page).toHaveURL(/\/login$/);

  // The session is genuinely dead server-side from here on — every probe
  // after logout gets a delayed 401, never Alice's identity again.
  await context.unroute("**/api/v1/auth/me");
  await context.route("**/api/v1/auth/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, AUTH_ME_AFTER_LOGOUT_DELAY_MS));
    await route.fulfill({
      status: 401,
      contentType: "application/problem+json",
      body: JSON.stringify({ title: "Unauthorized", status: 401 }),
    });
  });

  await page.goBack();
  // One-shot, non-retrying — see this test's own top-level note on why a
  // retrying `toHaveCount(0)` cannot discriminate here.
  expect(await page.getByText(`${ALICE_TOTAL_SHOWN} EUR`).count()).toBe(0);

  // Anti-vacuity: the guard's own delayed probe does eventually resolve
  // (401), landing back on /login — proving the check above inspected a
  // real blocked-guard window, not an environment where nothing renders.
  await expect(page).toHaveURL(/\/login$/, {
    timeout: AUTH_ME_AFTER_LOGOUT_DELAY_MS + 5_000,
  });
});
