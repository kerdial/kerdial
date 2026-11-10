import { expect, test } from "@playwright/test";
import { gotoAppShell, navigateViaNav } from "./nav-helpers.js";
import { mockAuthenticatedSession, mockOverview } from "./mocks.js";

/**
 * Security review finding F4 (LOW): before the fix, a 401 from
 * *any* query other than the router guard's own `auth/me` probe
 * (`router.tsx`'s `authenticatedRoute.beforeLoad`, which only ever checks
 * `auth/me`) was handled silently — the query simply sat in its error
 * state, with no redirect and no cache purge, leaving the previous
 * session's other cached data on screen with nothing telling the user their
 * session had actually ended server-side.
 *
 * `holdings` is deliberately the query under test here, not `auth/me`: the
 * `authenticatedRoute` guard's own pre-existing `try/catch` +
 * `redirect({ to: "/login" })` already covers a failing `auth/me` fetch —
 * proving *that* path again would not discriminate whether this fix (the
 * `QueryCache`-level `onError` in `main.tsx`) is what did the work, or
 * whether the guard's unrelated, already-existing logic did. `holdings`
 * has no guard of its own; only the new global handler can catch its 401.
 */
test("a 401 from any query (not only the guard's own auth/me probe) redirects to /login, without looping", async ({
  page,
}) => {
  await mockAuthenticatedSession(page);
  await mockOverview(page, {
    totalValue: { amount: "4000.00", currency: "EUR", provenance: { derivedFrom: [] } },
  });
  await page.route("**/api/v1/portfolios/holdings", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Session expired",
        status: 401,
        code: "UNAUTHENTICATED",
      }),
    });
  });

  await gotoAppShell(page);
  await expect(page.getByTestId("overview-total-value")).toContainText("4 000.00 EUR");

  await navigateViaNav(page, "Positions");

  // The holdings query 401s (with TanStack Query's default retries — this is
  // deliberately not short-circuited so the assertion reflects the real
  // default query configuration, not a test-only fast path) and the global
  // `QueryCache` handler redirects — something no route's own guard logic
  // does for a *non*-`auth/me` query.
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

  // No redirect loop: the login screen itself issues no query (`login` is a
  // mutation, never routed through `QueryCache`), so it stays put rather
  // than bouncing back and forth.
  await page.waitForTimeout(1_000);
  await expect(page).toHaveURL(/\/login$/);
});
