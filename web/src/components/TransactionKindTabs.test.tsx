import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIND_FAMILIES } from "../lib/transaction-kind-family.js";
import { TransactionFormDialog } from "./TransactionFormDialog.js";
import {
  mockedApiClient,
  renderForm,
  renderedControlIds,
  resetHarness,
  selectKind,
} from "./transaction-form-test-harness.js";

/**
 * `transaction-dialog-refresh` TDR-T5 (FR-643..FR-646, AC-532..AC-534): the
 * type picker — four family radios over the selected family's pills — and the
 * remembered last kind, driven through the real `TransactionForm`.
 *
 * Split out of `TransactionForm.test.tsx` (AC-559 step (1)): the kind-switch
 * and tab cases that file held live here, rewritten where the falsified
 * "ten tabs in one strip" assumption made them say
 * something no longer true.
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

const LAST_KIND_KEY = "kerdial:transaction-dialog:last-kind";

beforeEach(resetHarness);

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderReady(): Promise<void> {
  renderForm();
  await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
}

function familyRadio(family: string): HTMLInputElement {
  return screen.getByTestId(`family-tab-${family}`) as HTMLInputElement;
}

/** The pills currently rendered, by kind code, in DOM order. */
function renderedPills(): string[] {
  return screen
    .getAllByRole("tab")
    .map((tab) => (tab.getAttribute("data-testid") ?? "").replace("kind-tab-", ""));
}

function selectedPill(): string | undefined {
  return screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.getAttribute("data-testid")
    ?.replace("kind-tab-", "");
}

describe("TransactionKindTabs — four families over filtered pills (AC-532)", () => {
  it("shows « Titres », « Espèces », « Revenus », « Transferts » in that order, as one labelled radiogroup", async () => {
    await renderReady();
    const group = screen.getByRole("radiogroup", { name: "Famille d'opération" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("data-testid"))).toEqual([
      "family-tab-SECURITIES",
      "family-tab-CASH",
      "family-tab-INCOME",
      "family-tab-TRANSFERS",
    ]);
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Titres",
      "Espèces",
      "Revenus",
      "Transferts",
    ]);
    // One radio group (one name): what gives a browser's arrow keys "move and
    // select" within it, and one Tab stop for the row (NFR-84).
    expect(new Set(radios.map((radio) => (radio as HTMLInputElement).name)).size).toBe(1);
    expect(familyRadio("SECURITIES")).toBeChecked();
  });

  it.each([
    ["SECURITIES", ["BUY", "SELL", "SHARE_DISTRIBUTION"], ["Achat", "Vente", "Actions gratuites"]],
    // portfolio-cash (AC-587): « Frais de portefeuille » is the last pill; the
    // family still opens on « Dépôt ».
    [
      "CASH",
      ["DEPOSIT", "WITHDRAWAL", "CURRENCY_EXCHANGE", "FEE"],
      ["Dépôt", "Retrait", "Change", "Frais de portefeuille"],
    ],
    ["INCOME", ["DIVIDEND", "INTEREST", "DRIP"], ["Dividende", "Intérêt", "Réinvestissement"]],
    ["TRANSFERS", ["TRANSFER_OUT"], ["Transfert de titres"]],
  ])(
    "%s shows exactly its own pills, in order, and selects the first",
    async (family, kinds, labels) => {
      await renderReady();
      fireEvent.click(familyRadio(family));
      expect(familyRadio(family)).toBeChecked();
      expect(renderedPills()).toEqual(kinds);
      expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(labels);
      expect(selectedPill()).toBe(kinds[0]);
      // The pills sit in the labelled tablist the specs address (FR-646).
      const tablist = screen.getByRole("tablist", { name: "Type de transaction" });
      expect(within(tablist).getAllByRole("tab")).toHaveLength(kinds.length);
      expect(screen.getAllByRole("tab").every((tab) => tab.className === "k-ov-kind")).toBe(true);
    },
  );

  it("no icon in either row (N8): no <svg> or <img> in the radiogroup or the tablist, on any family", async () => {
    await renderReady();
    for (const { family } of KIND_FAMILIES) {
      fireEvent.click(familyRadio(family));
      for (const row of [screen.getByRole("radiogroup"), screen.getByRole("tablist")]) {
        expect(row.querySelectorAll("svg, img")).toHaveLength(0);
      }
    }
  });

  // Moved from TransactionForm.test.tsx « the security-transfer tab (TR-20) ».
  it("is one tab, « Transfert de titres » — and TRANSFER_IN is never offered as one (OD-4 (a))", async () => {
    await renderReady();
    fireEvent.click(familyRadio("TRANSFERS"));
    expect(screen.getByTestId("kind-tab-TRANSFER_OUT")).toHaveTextContent("Transfert de titres");
    // On no family, not only the one the form opened on.
    for (const { family } of KIND_FAMILIES) {
      fireEvent.click(familyRadio(family));
      expect(screen.queryByTestId("kind-tab-TRANSFER_IN")).not.toBeInTheDocument();
    }
  });

  // Moved from TransactionForm.test.tsx « the « Intérêt » tab », and rewritten
  // over KIND_FAMILIES (I-2): "ten tabs in all" in one strip is false by
  // design. The intent — « Intérêt » right after « Dividende » — is kept.
  it("« Intérêt » is the pill after « Dividende », in « Revenus »", async () => {
    await renderReady();
    selectKind("DIVIDEND");
    const tabs = renderedPills();
    expect(tabs).toEqual(KIND_FAMILIES.find((entry) => entry.family === "INCOME")?.kinds);
    expect(tabs.indexOf("INTEREST")).toBe(tabs.indexOf("DIVIDEND") + 1);
    expect(screen.getByTestId("kind-tab-INTEREST")).toHaveTextContent("Intérêt");
  });
});

describe("TransactionKindTabs — selection (FR-644, AC-533)", () => {
  it("clicking « Revenus » selects « Dividende » and renders DIVIDEND; then « Intérêt » renders INTEREST with no instrument", async () => {
    await renderReady();
    fireEvent.click(familyRadio("INCOME"));

    expect(selectedPill()).toBe("DIVIDEND");
    expect(screen.getByTestId("instrument-picker-search")).toBeInTheDocument();
    expect(screen.getByTestId("amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("withholding-amount-input")).toBeInTheDocument();
    expect(screen.queryByTestId("quantity-input")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("kind-tab-INTEREST"));
    expect(selectedPill()).toBe("INTEREST");
    expect(familyRadio("INCOME")).toBeChecked();
    expect(screen.queryByTestId("instrument-picker-search")).not.toBeInTheDocument();
    expect(screen.getByTestId("amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("withholding-amount-input")).toBeInTheDocument();
  });

  it("focus stays on the family radio after choosing it (NFR-84)", async () => {
    await renderReady();
    const income = familyRadio("INCOME");
    income.focus();
    fireEvent.click(income);
    // The same node, still focused: the row is not re-mounted by the switch.
    expect(familyRadio("INCOME")).toBe(income);
    expect(document.activeElement).toBe(income);
  });

  it("a value typed in a field the two kinds share survives a kind switch, within and across families", async () => {
    await renderReady();
    selectKind("DEPOSIT");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "1000" } });
    fireEvent.change(screen.getByTestId("trade-date-input"), { target: { value: "2026-03-12" } });

    selectKind("WITHDRAWAL");
    expect(screen.getByTestId("amount-input")).toHaveValue("1000");

    selectKind("INTEREST");
    expect(screen.getByTestId("amount-input")).toHaveValue("1000");
    expect(screen.getByTestId("trade-date-input")).toHaveValue("2026-03-12");
  });

  // Moved from TransactionForm.test.tsx « the « Intérêt » tab »; FEE is
  // portfolio-cash AC-584 (its « Libellé » leaves the expander on FEE only).
  it.each([
    ["INTEREST", "withholding-amount-input"],
    ["FEE", "instrument-picker-search"],
  ] as const)(
    "choosing « Dépôt » after %s restores DEPOSIT's form unchanged",
    async (other, ownControl) => {
      await renderReady();
      selectKind("DEPOSIT");
      const depositControls = renderedControlIds();
      expect(depositControls).not.toContain(ownControl);

      selectKind(other);
      expect(renderedControlIds()).toContain(ownControl);

      selectKind("DEPOSIT");
      expect(renderedControlIds()).toEqual(depositControls);
    },
  );
});

describe("TransactionKindTabs — the remembered last kind (FR-645, AC-534)", () => {
  /** The real drawer, opened and closed by a parent — so closing unmounts the form (Radix mounts `Content` only while open). */
  function DialogHarness(): ReactElement {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
          reopen
        </button>
        <TransactionFormDialog open={open} onOpenChange={setOpen} />
      </>
    );
  }

  function renderDialog(): void {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <DialogHarness />
      </QueryClientProvider>,
    );
  }

  it("close on « Vente », reopen: « Titres » and « Vente » are selected — on a fresh mount", async () => {
    renderDialog();
    await screen.findByTestId("transaction-form");
    selectKind("SELL");
    // Recorded at selection time, not at submit.
    expect(window.localStorage.getItem(LAST_KIND_KEY)).toBe("SELL");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "7" } });

    fireEvent.click(screen.getByTestId("transaction-form-cancel"));
    await waitFor(() => expect(screen.queryByTestId("transaction-form")).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId("reopen"));
    await screen.findByTestId("transaction-form");
    expect(familyRadio("SECURITIES")).toBeChecked();
    expect(selectedPill()).toBe("SELL");
    expect(screen.getByTestId("unit-price-input")).toBeInTheDocument();
    // A real remount: the quantity typed before closing is gone.
    expect(screen.getByTestId("quantity-input")).toHaveValue("");
  });

  it("a family change is remembered too, as the kind it selected", async () => {
    await renderReady();
    fireEvent.click(familyRadio("CASH"));
    expect(window.localStorage.getItem(LAST_KIND_KEY)).toBe("DEPOSIT");
  });

  it.each([["TRANSFER_IN"], ["NOPE"], [""]])(
    "a stored %j opens on « Achat » in « Titres »",
    async (stored) => {
      window.localStorage.setItem(LAST_KIND_KEY, stored);
      await renderReady();
      expect(familyRadio("SECURITIES")).toBeChecked();
      expect(selectedPill()).toBe("BUY");
    },
  );

  it("a stored known kind opens on it, family included", async () => {
    window.localStorage.setItem(LAST_KIND_KEY, "INTEREST");
    await renderReady();
    expect(familyRadio("INCOME")).toBeChecked();
    expect(selectedPill()).toBe("INTEREST");
  });

  it("a throwing localStorage (private mode) still opens on « Achat », and selection still works", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await renderReady();
    expect(selectedPill()).toBe("BUY");

    selectKind("DIVIDEND");
    expect(selectedPill()).toBe("DIVIDEND");
    expect(screen.getByTestId("withholding-amount-input")).toBeInTheDocument();
  });
});
