import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession, mockHoldings, mockOverview, mockRatePresets } from "./mocks.js";
import { goOffline, goOnline } from "./network.js";

/**
 * ADR-0009 Stage 1 (`AR-20`/`AR-22`): offline becomes **app-shell-only**.
 * The original acceptance criterion this spec proved (T-42's
 * third AC: "the last successfully fetched overview/holdings data still
 * renders, a persistent offline banner is shown with the last-fetch
 * timestamp") depended on `vite.config.ts`'s old `GET /api/v1/**`
 * `NetworkFirst` rule genuinely being able to answer a repeat request from
 * Cache Storage while offline. `/api/v1/**` is now `NetworkOnly` for every
 * method (`AR-20`) — there is no cached response left to answer from — so
 * this banner (`OfflineBanner.tsx`) no longer names a specific reading; it
 * only states the app is offline.
 *
 * What this file still proves: the banner appears/disappears with real
 * connectivity, writes are disabled with an explanation while offline (a
 * concern unrelated to caching — `useOnlineStatus`, not Cache Storage), and
 * the banner's copy does not claim a specific data reading is available.
 * Whether an already-rendered screen keeps showing what was in memory before
 * the connection dropped is incidental React behaviour (nothing here
 * force-unmounts it), not a guarantee this spec asserts any more.
 */
test("offline: the banner states the app is offline (no data-freshness claim), writes are disabled", async ({
  page,
  context,
}) => {
  await mockAuthenticatedSession(page);
  await mockOverview(page, {
    totalValue: { amount: "4200.00", currency: "EUR", provenance: { derivedFrom: [] } },
  });
  await mockHoldings(page);
  await mockRatePresets(page);

  await page.goto("/");
  await expect(page.getByTestId("overview-total-value")).toContainText("4 200.00 EUR");
  await expect(page.getByTestId("offline-banner")).not.toBeVisible();
  await expect(page.getByTestId("new-transaction-button")).toBeEnabled();

  await goOffline(page, context);

  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await expect(page.getByTestId("offline-banner")).toContainText("Hors ligne");
  // The old promise this banner made is gone — it must not claim a specific
  // reading is available (`AR-22`).
  await expect(page.getByTestId("offline-banner")).not.toContainText("données du");

  // The write-action stand-in is disabled, with an explanation, rather than
  // silently allowed to queue — unaffected by this ADR (`useOnlineStatus`,
  // not Cache Storage).
  const newTransactionButton = page.getByTestId("new-transaction-button");
  await expect(newTransactionButton).toBeDisabled();
  await expect(newTransactionButton).toHaveAttribute("title", /hors ligne/i);

  await goOnline(page, context);
  await expect(page.getByTestId("offline-banner")).not.toBeVisible();
  await expect(page.getByTestId("new-transaction-button")).toBeEnabled();
});
