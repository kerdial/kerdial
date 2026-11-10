import { expect, type Page } from "@playwright/test";
import type { TransactionKind } from "@kerdial/api-contracts";
import { familyOf } from "../src/lib/transaction-kind-family.js";

/**
 * The new-transaction drawer's two navigation steps (C-4 edits
 * (1) and (2)) — the only ways the six dialog specs changed
 * how they reach a field.
 */

/**
 * Picks a kind: its family radio first, then its pill. Only the selected
 * family's pills are in the DOM (FR-646), so a pill outside « Titres » is
 * unreachable until its family is chosen. The family is read off the app's
 * own grouping, so the two cannot disagree.
 */
export async function selectKind(page: Page, kind: TransactionKind): Promise<void> {
  await page.getByTestId(`family-tab-${familyOf(kind)}`).click();
  await page.getByTestId(`kind-tab-${kind}`).click();
}

/**
 * Opens « Plus d'options » (FR-650) before a control that moved into it.
 * Idempotent: a `<details>` already open (the settlement block opens it on
 * its own, FR-648) is left open rather than toggled shut.
 */
export async function openMoreOptions(page: Page): Promise<void> {
  const details = page.getByTestId("more-options");
  if ((await details.getAttribute("open")) === null) {
    await page.getByTestId("more-options-summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
}
