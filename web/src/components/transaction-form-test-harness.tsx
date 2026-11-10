import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { expect, vi } from "vitest";
import { RATE_PRESET_DEFAULTS, type TransactionKind } from "@kerdial/api-contracts";
import * as apiClient from "../lib/api-client.js";
import type {
  CashAccountBalance,
  CurrencyOption,
  PortfolioCashResponse,
} from "../lib/api-client.js";
import { portfoliosQueryOptions } from "../lib/queries.js";
import { familyOf } from "../lib/transaction-kind-family.js";
import { TransactionForm } from "./TransactionForm.js";

/**
 * The create form's shared RTL harness (AC-559): the fixtures, the render helper and the drivers
 * `TransactionForm.test.tsx` and the per-sub-component suites split out of it
 * share. It is not a test file; each suite still declares its own
 * `vi.mock("../lib/api-client.js", …)` (a `vi.mock` is hoisted per test file),
 * and this module reads the mocked functions through `vi.mocked`.
 */

export const mockedApiClient = vi.mocked(apiClient);

export const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_PORTFOLIO_ID = "1a1a1a1a-1111-4111-8111-1111111111aa";
// CA-11/CA-20: every cash-moving leg names
// the account it moved it in (FR-156). Selected through `CashAccountPicker`
// (CA-20 replaced Batch B's interim uuid `<Input>`s), so these ids only ever
// reach the payload by being an option the picker actually offered.
export const CASH_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
export const SECOND_USD_ACCOUNT_ID = "5b5b5b5b-5555-4555-8555-555555555bbb";
export const TARGET_CASH_ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
export const ARCHIVED_EUR_ACCOUNT_ID = "6a6a6a6a-6666-4666-8666-666666666aaa";
export const INSTRUMENT_ID = "22222222-2222-4222-8222-222222222222";
export const SETTLEMENT_INSTRUMENT_ID = "33333333-3333-4333-8333-333333333333";

/**
 * The default cash fixture, chosen so one mount exercises three of CD12's
 * five behaviours at once:
 *
 * - **two active USD accounts** — so the principal picker on a USD leg
 *   preselects nothing and the field stays required (behaviour 5's negative
 *   half);
 * - **one active EUR account** — so a EUR leg *is* preselected (behaviour 5's
 *   positive half);
 * - **one archived EUR account** — offered only when already attributed
 *   (behaviour 3), which on the create form means never.
 */
export function cashAccount(
  overrides: Partial<CashAccountBalance> & { id: string },
): CashAccountBalance {
  return {
    name: "Compte",
    currency: "EUR",
    archived: false,
    balance: "0",
    isNegative: false,
    ...overrides,
  };
}

export function cashResponse(accounts?: readonly CashAccountBalance[]): PortfolioCashResponse {
  const resolved = accounts ?? [
    cashAccount({ id: CASH_ACCOUNT_ID, name: "Compte USD", currency: "USD", balance: "1000" }),
    cashAccount({ id: SECOND_USD_ACCOUNT_ID, name: "Réserve USD", currency: "USD" }),
    cashAccount({ id: TARGET_CASH_ACCOUNT_ID, name: "Compte EUR", currency: "EUR" }),
    cashAccount({
      id: ARCHIVED_EUR_ACCOUNT_ID,
      name: "Ancien EUR",
      currency: "EUR",
      archived: true,
    }),
  ];
  return { accounts: resolved, byCurrency: [], calcEpoch: "1" };
}

/**
 * `GET /currencies`' list, as the four `CurrencySelect`s see it (FR-T3/AC-T3c:
 * one shared `currenciesQueryOptions()` query for all four fields, so one
 * fixture here is the *whole* option surface — the lists cannot drift).
 */
export const CURRENCIES: CurrencyOption[] = [
  { code: "EUR", name: "Euro", minorUnit: 2 },
  { code: "USD", name: "Dollar américain", minorUnit: 2 },
  { code: "GBP", name: "Livre sterling", minorUnit: 2 },
];

/**
 * Picks a currency in one of the four currency dropdowns (FR-T3/T-1 replaced
 * their free-text `<input maxLength={3}>`s with `CurrencySelect`).
 *
 * Waits for the option to actually be offered first, for the same reason
 * `selectCashAccount` does: `fireEvent.change` to a value a native `<select>`
 * has no `<option>` for is a silent no-op, which would otherwise surface much
 * later as an unrelated-looking assertion failure on the submitted payload.
 */
export async function selectCurrency(testId: string, code: string): Promise<void> {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  await waitFor(() =>
    expect(Array.from(select.options).map((option) => option.value)).toContain(code),
  );
  fireEvent.change(select, { target: { value: code } });
}

/** Selects an account in one of the four picker slots. Fails if the option is never offered — which is the point: a test cannot "select" an account the picker filtered out. */
export async function selectCashAccount(testId: string, accountId: string): Promise<void> {
  await waitFor(() => expect(offeredAccountIds(testId)).toContain(accountId));
  fireEvent.change(screen.getByTestId(testId), { target: { value: accountId } });
}

/** The option ids a picker slot currently offers, placeholder excluded. */
export function offeredAccountIds(testId: string): string[] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options)
    .map((option) => option.value)
    .filter((value) => value !== "");
}

export function renderForm(): {
  onSubmitted: () => void;
  onCancel: () => void;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSubmitted = vi.fn();
  const onCancel = vi.fn();
  render(
    (
      <QueryClientProvider client={queryClient}>
        <TransactionForm onSubmitted={onSubmitted} onCancel={onCancel} />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onSubmitted, onCancel, queryClient };
}

/**
 * portfolio-archive AC-487: the form is create-only, so its
 * current-value case arises only when the list refetches with the selected
 * portfolio newly archived — simulated by rewriting the shared list entry.
 */
export function markArchivedInCache(queryClient: QueryClient, portfolioId: string): void {
  queryClient.setQueryData(portfoliosQueryOptions().queryKey, (current) =>
    current?.map((p) => (p.id === portfolioId ? { ...p, archived: true } : p)),
  );
}

/** `[value, label]` of every option a select offers, placeholder included. */
export function optionPairs(testId: string): [string, string][] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options).map((option) => [option.value, option.text]);
}

/**
 * The kind control is the design's type tab strip, not a
 * `<select>` — one `role="tab"` button per kind, writing the same
 * `register("kind")` field the per-kind branches have always watched.
 *
 * `transaction-dialog-refresh` I-3: only the selected family's pills are in
 * the DOM (FR-646), so the family radio is clicked first. On the family the
 * form is already in that click is a no-op (the radio is already checked).
 */
export function selectKind(kind: TransactionKind): void {
  fireEvent.click(screen.getByTestId(`family-tab-${familyOf(kind)}`));
  fireEvent.click(screen.getByTestId(`kind-tab-${kind}`));
}

/**
 * Every control the form renders, by test id — the "same fields" a kind switch
 * must restore. The picker's own handles (`family-tab-`, `kind-tab-`) and the
 * expander's (`more-options`) are not fields (I-3).
 */
export function renderedControlIds(): string[] {
  return Array.from(screen.getByTestId("transaction-form").querySelectorAll("[data-testid]"))
    .map((element) => element.getAttribute("data-testid") ?? "")
    .filter(
      (id) =>
        !id.startsWith("kind-tab-") &&
        !id.startsWith("family-tab-") &&
        !id.startsWith("rate-chip-") &&
        !id.startsWith("more-options"),
    )
    .sort();
}

/** The `<p role="alert">` error renders inside the field's own `.k-field` wrapper (the kit's `<Input>`) — used to prove a schema error routes to the *correct* field's slot (F2 security review), not merely that some error text exists somewhere on the page. */
export function fieldErrorText(inputTestId: string): string | null {
  const input = screen.getByTestId(inputTestId);
  const field = input.closest(".k-field") ?? input.closest("label");
  const alert = field?.querySelector('[role="alert"]');
  return alert?.textContent ?? null;
}

export async function pickInstrument(
  testId: string,
  instrumentId: string,
  displayName: string,
  symbol = "ABC",
): Promise<void> {
  mockedApiClient.searchInstruments.mockResolvedValueOnce([
    {
      id: instrumentId,
      kind: "EQUITY",
      displayName,
      listingCurrency: "USD",
      isin: null,
      exchangeMic: null,
      symbol,
    },
  ]);
  fireEvent.change(screen.getByTestId(`${testId}-search`), { target: { value: displayName } });
  await waitFor(() => expect(screen.getByTestId(`${testId}-results`)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("option", { name: new RegExp(displayName) }));
}

/**
 * The shared `beforeEach` body: every mock back to its default fixture, and
 * `localStorage` cleared (jsdom keeps it across the tests
 * of a file, and since FR-645 the form opens on the last kind selected, so
 * "each test starts on BUY" holds only if every test starts from an empty
 * store).
 */
export function resetHarness(): void {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockedApiClient.fetchPortfolios.mockResolvedValue([
    {
      id: PORTFOLIO_ID,
      name: "Compte principal",
      transactionCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      broker: null,
      description: null,
      accentColor: null,
      hasIcon: false,
      archived: false,
    },
    // A second portfolio exists solely so CD12 behaviour 1's "scoped to *this*
    // id, never the other one" assertion has a real other id to be wrong with.
    {
      id: OTHER_PORTFOLIO_ID,
      name: "Compte secondaire",
      transactionCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      broker: null,
      description: null,
      accentColor: null,
      hasIcon: false,
      archived: false,
    },
  ]);
  mockedApiClient.searchInstruments.mockResolvedValue([]);
  mockedApiClient.createTransaction.mockResolvedValue({});
  mockedApiClient.fetchPortfolioCash.mockResolvedValue(cashResponse());
  mockedApiClient.fetchCurrencies.mockResolvedValue(CURRENCIES);
  // The server's four defaults: « Fortuneo », « Saxo », « TTF », « PFU ».
  mockedApiClient.fetchRatePresets.mockResolvedValue({ items: RATE_PRESET_DEFAULTS });
}

/**
 * Picks the portfolio and waits for the picker's own read to fire.
 *
 * Waits for the *option* first: `fetchPortfolios` having been **called** is
 * not the same as its rows being in the `<select>`, and `fireEvent.change` to
 * a value the select does not yet offer is a silent no-op — which then shows
 * up much later as an unrelated-looking timeout on a cash assertion.
 */
export async function choosePortfolio(portfolioId: string = PORTFOLIO_ID): Promise<void> {
  const select = screen.getByTestId("portfolio-select") as HTMLSelectElement;
  await waitFor(() =>
    expect(Array.from(select.options).map((option) => option.value)).toContain(portfolioId),
  );
  fireEvent.change(select, { target: { value: portfolioId } });
  await waitFor(() => expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalled());
}
