import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  INSTRUMENT_ID,
  mockAuthenticatedSession,
  mockHoldings,
  mockInstrumentById,
  mockInstrumentHistoryStatus,
  mockInstrumentPrices,
  mockPortfolios,
} from "./mocks.js";

/**
 * GATE-3 (EW-T16): the country picker in the real instrument dialog — the
 * part jsdom cannot see. Escape inside a Radix dialog, the ARIA contract in a
 * real accessibility tree, a real pointer hitting an option, and the 390 px
 * layout (AC-637, AC-638, AC-639, NFR-101). The host is the « Pays du siège
 * social » field of the « Modifier » dialog.
 *
 * AC-638's automated accessibility scan is NOT run: the repository carries no
 * scanner dependency and EW-L9 rules out adding one in this batch. The ARIA
 * contract is asserted attribute by attribute instead, through Playwright's
 * accessibility-aware locators.
 */

const DOMICILE_LABEL = "Pays du siège social";

async function openDomicilePicker(page: Page): Promise<Locator> {
  await mockAuthenticatedSession(page);
  await mockPortfolios(page);
  await mockHoldings(page);
  await mockInstrumentHistoryStatus(page);
  await mockInstrumentPrices(page);
  await mockInstrumentById(page, [
    {
      id: INSTRUMENT_ID,
      kind: "SHARE",
      displayName: "Exemple Industries",
      listingCurrency: "EUR",
      isin: "FR0000000001",
      symbol: "EXI",
    },
  ]);
  await page.goto(`/instruments/${INSTRUMENT_ID}`);
  await page.getByTestId("instrument-detail-edit").click();
  await expect(editDialog(page)).toBeVisible();
  return page.getByRole("combobox", { name: DOMICILE_LABEL });
}

function editDialog(page: Page): Locator {
  return page.getByTestId("instrument-detail-edit-dialog");
}

/** The text of the option the combobox's `aria-activedescendant` points at, or `null`. */
async function activeOptionText(combobox: Locator): Promise<string | null> {
  return combobox.evaluate((input) => {
    const id = input.getAttribute("aria-activedescendant");
    return id === null ? null : (document.getElementById(id)?.textContent ?? null);
  });
}

test("AC-637: keyboard only — type, arrow, Enter selects; Escape closes the list and not the dialog; Tab keeps the choice", async ({
  page,
}) => {
  const combobox = await openDomicilePicker(page);
  // Focused programmatically: no pointer event anywhere in this test.
  await combobox.focus();
  await page.keyboard.type("ja");
  await expect(combobox).toHaveAttribute("aria-expanded", "true");
  expect(await activeOptionText(combobox)).toBeNull();

  for (let step = 0; step < 10 && (await activeOptionText(combobox)) !== "Japon"; step++) {
    await page.keyboard.press("ArrowDown");
  }
  expect(await activeOptionText(combobox)).toBe("Japon");
  await page.keyboard.press("Enter");
  await expect(combobox).toHaveValue("Japon");
  await expect(combobox).toHaveAttribute("aria-expanded", "false");
  await expect(editDialog(page)).toBeVisible();

  // Re-opened, moved onto another country, then Escape: the list closes, the
  // dialog stays, and the moved-onto country is not committed.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  expect(await activeOptionText(combobox)).not.toBe("Japon");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(editDialog(page)).toBeVisible();
  await expect(combobox).toHaveValue("Japon");

  await page.keyboard.press("Tab");
  await expect(combobox).not.toBeFocused();
  await expect(combobox).toHaveValue("Japon");
  await expect(editDialog(page)).toBeVisible();
});

test("AC-638: the combobox pattern in the real accessibility tree", async ({ page }) => {
  const combobox = await openDomicilePicker(page);
  // `getByRole(..., { name })` above already proves the name comes from the label.
  await expect(combobox).toHaveAttribute("aria-autocomplete", "list");
  await expect(combobox).toHaveAttribute("aria-expanded", "false");

  await combobox.focus();
  await page.keyboard.type("j");
  await expect(combobox).toHaveAttribute("aria-expanded", "true");
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expect(combobox).toHaveAttribute("aria-controls", (await listbox.getAttribute("id")) ?? "");
  const childRoles = await listbox.evaluate((element) =>
    Array.from(element.children, (child) => child.getAttribute("role")),
  );
  expect(childRoles.length).toBeGreaterThan(1);
  expect(new Set(childRoles)).toEqual(new Set(["option"]));

  const status = page.getByTestId("instrument-classification-domicile-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText(`${childRoles.length} résultats`);

  await page.keyboard.press("ArrowDown");
  const first = listbox.getByRole("option").first();
  await expect(combobox).toHaveAttribute(
    "aria-activedescendant",
    (await first.getAttribute("id")) ?? "",
  );
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  const second = listbox.getByRole("option").nth(1);
  await expect(combobox).toHaveAttribute(
    "aria-activedescendant",
    (await second.getAttribute("id")) ?? "",
  );
  await expect(first).toHaveAttribute("aria-selected", "false");

  await page.keyboard.type("zzz");
  await expect(status).toHaveText("Aucun pays ne correspond");
  await expect(page.getByTestId("instrument-classification-domicile-empty")).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(combobox).toHaveAttribute("aria-expanded", "false");
});

test("an option is hit by a real pointer: nothing covers it, and the click commits it", async ({
  page,
}) => {
  const combobox = await openDomicilePicker(page);
  await combobox.click();
  await page.keyboard.type("fra");
  const france = page.getByRole("option", { name: "France", exact: true });
  await france.scrollIntoViewIfNeeded();
  const box = await france.boundingBox();
  if (box === null) throw new Error("« France » is not rendered");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const hit = await france.evaluate((option, point) => {
    const top = document.elementFromPoint(point.x, point.y);
    return top !== null && option.contains(top);
  }, centre);
  expect(hit, "the element at the option's centre is not the option").toBe(true);

  await page.mouse.click(centre.x, centre.y);
  await expect(combobox).toHaveValue("France");
  await expect(editDialog(page)).toBeVisible();
});

test.describe("AC-639: at 390 px", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "iPhone 14", "a phone-width claim");
  });

  test("the open list stays inside the viewport, scrolls inside itself, has 44 px rows, and the dialog still scrolls to its actions", async ({
    page,
  }) => {
    const combobox = await openDomicilePicker(page);
    await combobox.click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    // Opened right under the field the user just tapped: its first rows are on
    // screen, not pushed outside the dialog's scrolling box.
    await expect(listbox.getByRole("option").first()).toBeInViewport();
    const innerWidth = await page.evaluate(() => window.innerWidth);

    const box = await listbox.boundingBox();
    if (box === null) throw new Error("the list is not rendered");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(innerWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      innerWidth,
    );

    const list = await listbox.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrolls: element.scrollHeight > element.clientHeight,
      shortestRow: Math.min(
        ...Array.from(element.children, (row) => row.getBoundingClientRect().height),
      ),
    }));
    expect(["auto", "scroll"]).toContain(list.overflowY);
    expect(list.scrolls).toBe(true);
    expect(list.shortestRow).toBeGreaterThanOrEqual(44);

    // The longest name, measured by its text (a Range), not by the row's box:
    // a row keeps the list's width while unbreakable text overflows it.
    const longest = listbox.getByRole("option", {
      name: "Îles mineures éloignées des États-Unis",
    });
    await longest.scrollIntoViewIfNeeded();
    const textFits = await longest.evaluate((option) => {
      const range = document.createRange();
      range.selectNodeContents(option);
      const rects = Array.from(range.getClientRects());
      const list = option.parentElement?.getBoundingClientRect();
      return (
        list !== undefined &&
        rects.length > 0 &&
        rects.every((rect) => rect.left >= list.left && rect.right <= list.right)
      );
    });
    expect(textFits).toBe(true);

    // The dialog around the open list still scrolls to its own actions.
    const submit = page.getByTestId("instrument-classification-submit");
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    await expect(page.getByRole("listbox")).toBeVisible();
  });
});
