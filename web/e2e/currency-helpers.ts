import { expect, type Page } from "@playwright/test";

/**
 * Selects a currency code in a `CurrencySelect` slot.
 *
 * Every currency field this suite drives is a `<select>` rather than the free-
 * text `<input maxLength={3}>` it used to be: the instrument-create dialog's
 * listing currency since IC-13, and the transaction form's slots
 * (`currency-input`, `target-currency-input`; the withholding's has since
 * gone) since T-1 of the transaction-time/fee/currency-dropdown cycle. `Locator.fill`
 * throws outright on a `<select>`, so every call site that used to fill one of
 * those testids goes through here instead.
 *
 * Waits for the option to exist before selecting it. `GET /currencies`
 * resolves *after* the dialog has already mounted, and the select structurally
 * cannot accept a value absent from its own option list (IC-13) — which also
 * makes this a strictly stronger interaction than `fill` was, since `fill`
 * accepted any string the UI would never have offered.
 *
 * Requires the spec's setup to have registered `mockCurrencies` (`./mocks.js`)
 * *before* the app navigates: a route registered after `CurrencySelect`'s own
 * query has fired intercepts nothing, and the select is then left with only
 * its placeholder option.
 */
export async function selectCurrency(page: Page, testId: string, code: string): Promise<void> {
  const select = page.getByTestId(testId);
  await expect(select.locator("option", { hasText: code })).toHaveCount(1);
  await select.selectOption(code);
}
