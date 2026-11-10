import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESSENTIAL_TESTIDS } from "../lib/transaction-form-layout.js";
import {
  CASH_ACCOUNT_ID,
  INSTRUMENT_ID,
  TARGET_CASH_ACCOUNT_ID,
  choosePortfolio,
  mockedApiClient,
  pickInstrument,
  renderForm,
  resetHarness,
  selectCashAccount,
  selectCurrency,
  selectKind,
} from "./transaction-form-test-harness.js";

/**
 * `transaction-dialog-refresh` TDR-T6 (FR-647..FR-651, AC-535, AC-537..AC-539):
 * the one « Plus d'options » expander, driven through the real
 * `TransactionForm`. Which control sits where, per kind, is the AC-536 table
 * in `TransactionForm.test.tsx`; this file is the expander's behaviour.
 *
 * **jsdom does not hide a closed `<details>`' content from focus**, which a
 * browser does — that is the whole reason RHF's own `shouldFocusError` cannot
 * reach a field in there. `refuseFocusInClosedDetails` puts the
 * browser's rule back for the cases about focus, so they prove the form opens
 * the expander *before* focusing, rather than passing on jsdom's leniency.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchPortfolios: vi.fn(),
    searchInstruments: vi.fn(),
    createTransaction: vi.fn(),
    fetchPortfolioCash: vi.fn(),
    createCashAccount: vi.fn(),
    fetchCurrencies: vi.fn(),
    fetchPortfolioHoldings: vi.fn(),
    // The chips' presets, read on every
    // opening (an unmocked read is the failure path).
    fetchRatePresets: vi.fn(),
    saveRatePresets: vi.fn(),
  };
});

beforeEach(resetHarness);

afterEach(() => {
  vi.restoreAllMocks();
});

function expander(): HTMLDetailsElement {
  return screen.getByTestId("more-options") as HTMLDetailsElement;
}

function insideExpander(testId: string): boolean {
  return expander().contains(screen.getByTestId(testId));
}

/** A browser's rule, which jsdom lacks: nothing inside a closed `<details>` (other than its summary) takes focus. */
function refuseFocusInClosedDetails(): void {
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    const closed = this.closest("details:not([open])");
    if (closed !== null && this.parentElement !== closed) return;
    focus.call(this, options);
  });
}

/**
 * The form's Tab sequence as a browser walks it: every focusable control in
 * document order, minus what a closed `<details>` hides (its summary stays).
 */
function tabSequence(): string[] {
  const form = screen.getByTestId("transaction-form");
  return Array.from(form.querySelectorAll<HTMLElement>("input, select, textarea, button, summary"))
    .filter((element) => {
      if ((element as HTMLInputElement).disabled) return false;
      const closed = element.closest("details:not([open])");
      return closed === null || element.parentElement === closed;
    })
    .filter((element) => {
      // One stop per radio group: the checked radio.
      const radio = element as HTMLInputElement;
      return radio.type !== "radio" || radio.checked;
    })
    .map((element) => element.getAttribute("data-testid") ?? element.tagName.toLowerCase());
}

async function renderReady(): Promise<void> {
  renderForm();
  await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
}

/** A valid BUY up to the submit: 10 Apple at 100 USD from the USD account (no settlement difference). */
async function fillValidBuy(): Promise<void> {
  await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
  fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
  fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
  await selectCurrency("currency-input", "USD");
  await choosePortfolio();
  await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
}

function submittedBody(): Record<string, unknown> {
  const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
  return payload as Record<string, unknown>;
}

describe("« Plus d'options » — one closed native expander (FR-647, AC-535)", () => {
  it("is one <details>, closed on opening, whose summary reads « Plus d'options »", async () => {
    await renderReady();
    const details = expander();
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    expect(details.firstElementChild).toBe(screen.getByTestId("more-options-summary"));
    expect(screen.getByTestId("more-options-summary")).toHaveTextContent("Plus d'options");
    expect(screen.getAllByTestId("more-options")).toHaveLength(1);
  });

  it("BUY: « Réglé en actif », Référence, Note, Taux vers l'EUR, Frais de change, Autres frais are in the DOM, inside it", async () => {
    await renderReady();
    for (const testId of [
      "settlement-toggle",
      "reference-input",
      "note-input",
      "fx-rate-user-input",
      "fee-fx-input",
      "fee-other-input",
    ]) {
      expect(insideExpander(testId)).toBe(true);
    }
  });

  it("BUY: Tab from the last essential reaches the summary, never Référence, while it is closed", async () => {
    await renderReady();
    await waitFor(() => expect(screen.getByTestId("rate-chip-add-TAX")).toBeInTheDocument());
    const sequence = tabSequence();
    const essentials = ESSENTIAL_TESTIDS.BUY.filter((id) => sequence.includes(id));
    const lastEssential = sequence.indexOf(essentials[essentials.length - 1] ?? "");
    // Between the last essential (Taxes) and the summary: only Taxes' « + »
    // — its « TTF » chip is disabled while there is no base (FR-655).
    expect(sequence.slice(lastEssential + 1, sequence.indexOf("more-options-summary"))).toEqual([
      "rate-chip-add-TAX",
    ]);
    for (const hidden of ["reference-input", "note-input", "settlement-toggle", "fee-fx-input"]) {
      expect(sequence).not.toContain(hidden);
    }

    fireEvent.click(screen.getByTestId("more-options-summary"));
    expect(expander().open).toBe(true);
    expect(tabSequence()).toContain("reference-input");
  });

  /**
   * AC-562 (TDR-T10): with a base typed, each cost field is followed by its
   * chips and its « + », then the summary and the buttons. « Total des frais »
   * is an `<output>` — on screen, never a tab stop.
   */
  it("AC-562 BUY: Courtage, its chips, « + », Taxes, its chip, « + », the summary, the buttons — the total is no tab stop", async () => {
    await renderReady();
    await fillValidBuy();
    await waitFor(() => expect(screen.getByTestId("rate-chip-BROKERAGE-0")).toBeEnabled());
    fireEvent.change(screen.getByTestId("fee-broker-input"), { target: { value: "1" } });
    expect(screen.getByTestId("fee-total")).toBeInTheDocument();

    const sequence = tabSequence();
    expect(sequence[0]).toBe("family-tab-SECURITIES");
    expect(sequence.indexOf("kind-tab-BUY")).toBeLessThan(sequence.indexOf("portfolio-select"));
    const from = sequence.indexOf("fee-broker-input");
    expect(sequence.slice(from)).toEqual([
      "fee-broker-input",
      "rate-chip-BROKERAGE-0",
      "rate-chip-BROKERAGE-1",
      "rate-chip-add-BROKERAGE",
      "fee-tax-input",
      "rate-chip-TAX-0",
      "rate-chip-add-TAX",
      "more-options-summary",
      "transaction-form-cancel",
      "transaction-form-submit",
    ]);
    expect(screen.getByTestId("fee-total").tagName).toBe("OUTPUT");
    expect(screen.getByTestId("fee-total").tabIndex).toBe(-1);
  });

  it("opens and closes on its summary, and is closed again on a fresh mount (not remembered)", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("more-options-summary"));
    expect(expander().open).toBe(true);
    fireEvent.click(screen.getByTestId("more-options-summary"));
    expect(expander().open).toBe(false);

    fireEvent.click(screen.getByTestId("more-options-summary"));
    expect(expander().open).toBe(true);
    // A kind switch is not a new opening of the dialog: it stays as the user left it.
    selectKind("DEPOSIT");
    expect(expander().open).toBe(true);
  });
});

describe("« Plus d'options » — opens by itself with the settlement block (FR-648, AC-537)", () => {
  it("BUY with a EUR account and a USD trade opens it and shows the settlement block inside", async () => {
    await renderReady();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    expect(expander().open).toBe(false);

    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

    await waitFor(() => expect(expander().open).toBe(true));
    expect(insideExpander("settlement-fields")).toBe(true);
  });

  it("BUY with a EUR/EUR pair stays collapsed", async () => {
    await renderReady();
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    // Give the settlement effect its commit before asserting nothing opened.
    await waitFor(() =>
      expect(screen.getByTestId("cash-account-input")).toHaveValue(TARGET_CASH_ACCOUNT_ID),
    );
    expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument();
    expect(expander().open).toBe(false);
  });

  it("never closes by itself: the settlement block going away leaves it open", async () => {
    await renderReady();
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await waitFor(() => expect(expander().open).toBe(true));

    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument());
    expect(expander().open).toBe(true);
  });
});

describe("« Plus d'options » — opens and focuses on a failed submit inside it (FR-647 (b), AC-538)", () => {
  it("a Référence over 120 characters: opens it, focuses Référence, posts nothing", async () => {
    refuseFocusInClosedDetails();
    await renderReady();
    await fillValidBuy();
    fireEvent.change(screen.getByTestId("reference-input"), { target: { value: "R".repeat(121) } });
    expect(expander().open).toBe(false);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(expander().open).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("reference-input")));
    expect(mockedApiClient.createTransaction).not.toHaveBeenCalled();
  });

  it("a zero « Frais de change » on a BUY: opens it and focuses that component", async () => {
    refuseFocusInClosedDetails();
    await renderReady();
    await fillValidBuy();
    fireEvent.change(screen.getByTestId("fee-fx-input"), { target: { value: "0" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("fee-fx-input")));
    expect(expander().open).toBe(true);
  });

  it("a zero component on a CURRENCY_EXCHANGE: opens it and focuses that component", async () => {
    refuseFocusInClosedDetails();
    await renderReady();
    selectKind("CURRENCY_EXCHANGE");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "500" } });
    await selectCurrency("currency-input", "USD");
    await selectCurrency("target-currency-input", "EUR");
    fireEvent.change(screen.getByTestId("exchange-rate-input"), { target: { value: "0.92" } });
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
    await selectCashAccount("target-cash-account-input", TARGET_CASH_ACCOUNT_ID);
    fireEvent.change(screen.getByTestId("fee-other-input"), { target: { value: "0" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("fee-other-input")));
    expect(expander().open).toBe(true);
  });

  it("an error on an essential field alone leaves it closed", async () => {
    await renderReady();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() =>
      expect(screen.getByText(/quantity is required for a BUY/)).toBeInTheDocument(),
    );
    expect(expander().open).toBe(false);
  });
});

describe("« Plus d'options » — collapsing drops nothing (FR-651, AC-539)", () => {
  it("a Note typed while open, then collapsed, is posted", async () => {
    await renderReady();
    await fillValidBuy();
    fireEvent.click(screen.getByTestId("more-options-summary"));
    fireEvent.change(screen.getByTestId("note-input"), { target: { value: "Ordre au marché" } });
    fireEvent.click(screen.getByTestId("more-options-summary"));
    expect(expander().open).toBe(false);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    expect(submittedBody()["note"]).toBe("Ordre au marché");
  });

  it("a field filled while it was never opened still submits (a hidden field is not a dropped one)", async () => {
    await renderReady();
    await fillValidBuy();
    fireEvent.change(screen.getByTestId("reference-input"), { target: { value: "ORD-7" } });
    fireEvent.change(screen.getByTestId("fee-other-input"), { target: { value: "1.20" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({
      reference: "ORD-7",
      fee: { components: { other: "1.20" } },
    });
    expect(expander().open).toBe(false);
  });
});
