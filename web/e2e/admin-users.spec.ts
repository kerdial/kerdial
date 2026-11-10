import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  adminUserFixture,
  mockAdminUsers,
  mockAuthenticatedSession,
  mockCreateTenantUser,
  mockHoldings,
  mockOverview,
  mockPortfolios,
  mockResetUserPassword,
  mockSetupNotNeeded,
} from "./mocks.js";
import { gotoAppShell } from "./nav-helpers.js";

/**
 * `/admin/users` (« Utilisateurs ») — `account-setup` T-99: UR-70's
 * DOM-absence proof at the browser layer, and the two admin flows.
 *
 * **Scoped to what only a browser can prove**, the discipline
 * `watchlist.spec.ts` records. The guard, the list states, the
 * `lastLoginAt === null` copy and the client-side password rules are all
 * already pinned without a browser (`AdminUsersRoute.test.tsx`,
 * `AccountForm.test.tsx`), and the API's own refusals are `admin-users.
 * e2e.test.ts`'s. What is left is what jsdom cannot represent: that the menu
 * entry is genuinely absent from the *rendered page* a non-admin gets, that
 * clicking the entry reaches the screen through the real router, and that the
 * create/reset writes travel over the wire and the list re-reads afterwards.
 *
 * `context.route`, never `page.route`: every `/api/v1/**` request goes
 * through the app's controlling service worker (the documented flake root
 * cause `activity-ledger.spec.ts` records).
 */
const NEW_USER_EMAIL = "second@example.test";
const NEW_PASSWORD = "correct horse battery staple";

/** Every read the app shell itself makes on any authenticated screen, plus this screen's own currency source. */
async function mockShell(context: BrowserContext, isInstanceAdmin: boolean): Promise<void> {
  await mockAuthenticatedSession(context, { isInstanceAdmin });
  await mockOverview(context);
  await mockPortfolios(context);
  await mockHoldings(context);
  // UR-72: the create form's currency list is `GET /auth/setup`'s, the same
  // source the first-run screen uses — so an authenticated screen needs that
  // public probe answered too.
  await mockSetupNotNeeded(context);
}

/**
 * Opens the rail's account menu, wherever the viewport puts it — below 640px
 * the rail is not rendered and the footer lives in the « Plus » drawer
 * (`nav-helpers.ts`'s `logOut` takes the same extra step, for the same
 * reason).
 */
async function openAccountMenu(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 640) {
    await page.getByTestId("mobile-nav-trigger").click();
  }
  await page.getByRole("button", { name: /Compte|@/ }).click();
}

test.describe("« Utilisateurs » — entry point and admin flows (FR-420–FR-422, FR-424)", () => {
  test("a non-admin's rendered page contains no « Utilisateurs » entry at all (UR-70)", async ({
    page,
    context,
  }) => {
    await mockShell(context, false);

    await gotoAppShell(page);
    await openAccountMenu(page);

    // The pairing: the menu genuinely rendered, and « Mon compte » is in it —
    // so the absence below cannot be passing against a menu that never
    // opened.
    await expect(page.getByTestId("account-link")).toBeVisible();
    await expect(page.getByTestId("logout-button")).toBeVisible();
    // UR-70's exact shape: **count 0**, not `not.toBeVisible()` — the element
    // is absent from the DOM, not hidden by CSS.
    expect(await page.getByTestId("admin-users-link").count()).toBe(0);
  });

  test("an admin reaches the screen from the menu and sees every household user (FR-421)", async ({
    page,
    context,
  }) => {
    await mockShell(context, true);
    await mockAdminUsers(context, () => [
      adminUserFixture(),
      adminUserFixture({
        userId: "00000000-0000-7000-8000-0000000b0001",
        email: NEW_USER_EMAIL,
        createdAt: "2026-09-19T09:30:00Z",
        lastLoginAt: null,
      }),
    ]);

    await gotoAppShell(page);
    await openAccountMenu(page);
    await page.getByTestId("admin-users-link").click();

    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByTestId("admin-users-table")).toBeVisible();
    await expect(page.getByTestId("admin-user-row")).toHaveCount(2);
    // UR-71's explicit state for a `NULL` `last_login_at`.
    await expect(page.getByText("Jamais connecté")).toBeVisible();
  });

  test("creating a household user shows the new row, in the admin's own tenant, once the list is re-read (FR-422)", async ({
    page,
    context,
  }) => {
    const rows = [adminUserFixture()];
    await mockShell(context, true);
    await mockAdminUsers(context, () => rows);
    // Registered after the read, so it wins for `POST` and falls back for
    // `GET` — the two share a URL.
    const created = await mockCreateTenantUser(context, (body) => {
      rows.push(
        adminUserFixture({
          userId: "00000000-0000-7000-8000-0000000c0001",
          email: String(body["email"]),
          createdAt: "2026-09-19T10:00:00Z",
          lastLoginAt: null,
        }),
      );
    });

    await page.goto("/admin/users");
    await expect(page.getByTestId("admin-user-row")).toHaveCount(1);

    await page.getByTestId("admin-create-user-email").fill(NEW_USER_EMAIL);
    await page.getByTestId("admin-create-user-password").fill(NEW_PASSWORD);
    await page.getByTestId("admin-create-user-password-confirm").fill(NEW_PASSWORD);
    await page.getByTestId("admin-create-user-submit").click();

    await expect(page.getByTestId("admin-create-user-success")).toBeVisible();
    // The row itself, from the refetch the invalidation triggered — the
    // write's own response carries two ids and nothing to render.
    await expect(page.getByTestId("admin-user-row")).toHaveCount(2);
    await expect(page.getByText(NEW_USER_EMAIL)).toBeVisible();
    // Same tenant as the admin, and no currency in the body.
    await expect(page.getByTestId("admin-user-row").nth(1)).toHaveAttribute(
      "data-user-id",
      "00000000-0000-7000-8000-0000000c0001",
    );
    expect(created.bodies()).toEqual([{ email: NEW_USER_EMAIL, password: NEW_PASSWORD }]);
  });

  test("resetting a password succeeds and never asks for a current one (FR-424, UR-73)", async ({
    page,
    context,
  }) => {
    const target = adminUserFixture({ email: "locked-out@example.test" });
    await mockShell(context, true);
    await mockAdminUsers(context, () => [target]);
    const reset = await mockResetUserPassword(context);

    await page.goto("/admin/users");
    await expect(page.getByTestId("admin-user-row")).toHaveCount(1);
    await page.getByTestId("admin-user-reset-open").click();

    const form = page.getByTestId("admin-reset-form");
    await expect(form).toBeVisible();
    // The positive half: the two fields UR-73 does ask for.
    await expect(page.getByTestId("admin-reset-password-new")).toBeVisible();
    await expect(page.getByTestId("admin-reset-password-confirm")).toBeVisible();
    // The negative half: genuinely absent from the affordance, not empty —
    // neither a testid nor the attribute a password manager would key on.
    expect(await form.getByTestId("account-password-current").count()).toBe(0);
    expect(await form.locator('input[autocomplete="current-password"]').count()).toBe(0);
    expect(await form.locator('input[type="password"]').count()).toBe(2);

    await page.getByTestId("admin-reset-password-new").fill(NEW_PASSWORD);
    await page.getByTestId("admin-reset-password-confirm").fill(NEW_PASSWORD);
    await page.getByTestId("admin-reset-password-submit").click();

    await expect(page.getByTestId("admin-reset-success")).toBeVisible();
    // Whose password, and a body carrying the one field the route accepts.
    expect(reset.resets()).toEqual([
      { userId: String(target["userId"]), body: { newPassword: NEW_PASSWORD } },
    ]);
  });
});
