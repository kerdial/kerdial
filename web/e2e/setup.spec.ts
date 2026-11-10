import { expect, test } from "@playwright/test";
import {
  EMAIL,
  PASSWORD,
  mockAuthenticatedSession,
  mockLoginSuccess,
  mockOverview,
  mockSetupNeeded,
  mockSetupNotNeeded,
  mockSetupSuccess,
} from "./mocks.js";

/**
 * `account-setup` AC-366/AC-367/AC-368 — the first-run setup screen, in
 * `login.spec.ts`'s shape and against the same route-mocked contract (no
 * Postgres behind this suite; every body below is the real DTO, see
 * `mocks.ts`'s header).
 *
 * The three claims, and why each is written the way it is:
 *
 * - **AC-366** — the probe decides which form renders, and the two answers
 *   are tested in both directions. Absence is always paired with a positive
 *   assertion, so neither case can pass against a screen that rendered
 *   nothing at all.
 * - **AC-367** — a successful `POST /auth/setup` logs the caller straight in
 *   (LD-6 (a)): the destination is `/`, not `/login`.
 * - **AC-368** — the confirm-mismatch block is proven by a **pair**: the
 *   blocked submission's request count, and then a *valid* submission in the
 *   same test whose count must be exactly 1. A bare
 *   `expect(count).toBe(0)` right after a click is this project's own
 *   recorded vacuous assertion — it passes just as well when the click never
 *   reached the button. Counting is done with `page.on("request")`, never a
 *   second `route()` handler: a second handler would take precedence over
 *   the fulfilling one (last registered wins) and change the behaviour it is
 *   supposed to be observing.
 */
const SETUP_PASSWORD = "correct horse battery staple";
/**
 * The fourth field, the one-time setup token. `mockSetupSuccess` fulfils any
 * body, so the value is irrelevant to the mock and load-bearing only for the form:
 * the field is `required`, and these specs are the only place the whole
 * screen is filled the way an operator fills it.
 */
const SETUP_TOKEN = "the-token-from-the-api-log";

test.describe("first-run setup screen (FR-405–FR-407)", () => {
  test("a fresh instance renders the setup form instead of the login form, EUR pre-selected", async ({
    page,
  }) => {
    await mockSetupNeeded(page);

    await page.goto("/login");

    await expect(page.getByTestId("setup-email")).toBeVisible();
    await expect(page.getByTestId("setup-password-confirm")).toBeVisible();
    // The first-run screen asks for the one-time token too.
    await expect(page.getByTestId("setup-token")).toBeVisible();
    // UR-65: EUR, although the mocked list starts at CHF.
    await expect(page.getByTestId("setup-base-currency")).toHaveValue("EUR");
    // FR-405's exclusivity, in the direction this test owns.
    expect(await page.getByTestId("login-email").count()).toBe(0);
    expect(await page.getByTestId("login-submit").count()).toBe(0);
  });

  test("an already-configured instance renders the ordinary login form", async ({ page }) => {
    // Registration order (this project's recorded Playwright trap: the
    // last-registered matching handler wins). `mockLoginSuccess` registers
    // `mockSetupNotNeeded` itself, and this explicit call **after** it is
    // what a spec would need if a broader `/api/v1/auth/` handler had been
    // registered in between — stated here because every other spec in this
    // suite inherits the fixture silently.
    await mockLoginSuccess(page);
    await mockAuthenticatedSession(page);
    await mockOverview(page);
    await mockSetupNotNeeded(page);

    await page.goto("/login");

    await expect(page.getByTestId("login-email")).toBeVisible();
    expect(await page.getByTestId("setup-email").count()).toBe(0);

    // The login form is not merely present, it still works — so "the setup
    // form is absent" cannot be passing against a broken screen.
    await page.getByTestId("login-email").fill(EMAIL);
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/\?range=1Y$/);
  });

  test("a successful setup logs straight in and lands on / (LD-6)", async ({ page }) => {
    await mockSetupNeeded(page);
    await mockSetupSuccess(page);
    await mockAuthenticatedSession(page);
    await mockOverview(page);

    await page.goto("/login");
    await page.getByTestId("setup-email").fill("first@example.com");
    await page.getByTestId("setup-token").fill(SETUP_TOKEN);
    await page.getByTestId("setup-password").fill(SETUP_PASSWORD);
    await page.getByTestId("setup-password-confirm").fill(SETUP_PASSWORD);
    await page.getByTestId("setup-submit").click();

    await expect(page).toHaveURL(/\/\?range=1Y$/);
    await expect(page.getByTestId("overview-screen")).toBeVisible();
  });

  test("a confirmation mismatch never reaches the network — and the same form submits exactly once when it matches (AC-368)", async ({
    page,
  }) => {
    await mockSetupNeeded(page);
    await mockSetupSuccess(page);
    await mockAuthenticatedSession(page);
    await mockOverview(page);

    let postCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/v1/auth/setup")) {
        postCount += 1;
      }
    });

    await page.goto("/login");
    await page.getByTestId("setup-email").fill("first@example.com");
    await page.getByTestId("setup-token").fill(SETUP_TOKEN);
    await page.getByTestId("setup-password").fill(SETUP_PASSWORD);
    await page.getByTestId("setup-password-confirm").fill(`${SETUP_PASSWORD}-typo`);
    await page.getByTestId("setup-submit").click();

    // Anchored on a rendered effect of the click, not on a wall-clock wait:
    // the inline mismatch error only exists because the submit handler ran
    // and refused. Only then is the count meaningful.
    await expect(page.getByText("Les deux mots de passe ne sont pas identiques.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(postCount).toBe(0);

    // The pairing. If the block above had leaked, this would be the *second*
    // POST and the count would be 2.
    await page.getByTestId("setup-password-confirm").fill(SETUP_PASSWORD);
    await page.getByTestId("setup-submit").click();

    await expect(page).toHaveURL(/\/\?range=1Y$/);
    expect(postCount).toBe(1);
  });
});
