import { expect, test } from "@playwright/test";
import {
  EMAIL,
  PASSWORD,
  mockAuthenticatedSession,
  mockLoginFailure,
  mockLoginSuccess,
  mockOverview,
} from "./mocks.js";

/**
 * T-42's first acceptance criterion: "The login screen
 * successfully authenticates against T-40's endpoints and redirects to the
 * app shell; an incorrect login shows an inline error, no redirect." (FR-44)
 */
test.describe("login screen (FR-44)", () => {
  test("correct credentials redirect into the app shell", async ({ page }) => {
    await mockLoginSuccess(page);
    await mockAuthenticatedSession(page);
    await mockOverview(page);

    await page.goto("/login");
    await page.getByTestId("login-email").fill(EMAIL);
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();

    // T-45's period selector always carries a `?range=` search param (the
    // default preset, `DEFAULT_PERIOD_PRESET_ID`) — no longer the bare `/`
    // T-42's placeholder screen redirected to.
    await expect(page).toHaveURL(/\/\?range=1Y$/);
    await expect(page.getByTestId("overview-screen")).toBeVisible();
    await expect(page.getByTestId("login-error")).not.toBeVisible();
  });

  test("incorrect credentials show an inline error and never redirect", async ({ page }) => {
    await mockLoginFailure(page);

    await page.goto("/login");
    await page.getByTestId("login-email").fill(EMAIL);
    await page.getByTestId("login-password").fill("wrong-password");
    await page.getByTestId("login-submit").click();

    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page.getByTestId("login-error")).toHaveText(
      "Adresse e-mail ou mot de passe incorrect.",
    );
    await expect(page).toHaveURL(/\/login$/);
  });
});
