import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { LedgerFilterBar, type LedgerFilters } from "./LedgerFilterBar.js";

/**
 * UR-19 (FR-132/AC123, AC140).
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchPortfolios: vi.fn(), searchInstruments: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

function renderBar(
  filters: LedgerFilters = {},
  mode: "ledger" | "income" = "ledger",
): { onChange: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  const { container } = render(
    (
      <QueryClientProvider client={queryClient}>
        <LedgerFilterBar filters={filters} onChange={onChange} mode={mode} />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onChange, container };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchPortfolios.mockResolvedValue([
    {
      id: "p-1",
      name: "Compte principal",
      transactionCount: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
      broker: null,
      description: null,
      accentColor: null,
      hasIcon: false,
      archived: false,
    },
  ]);
  mockedApiClient.searchInstruments.mockResolvedValue([]);
});

describe("<LedgerFilterBar> — native controls (FR-132/AC123)", () => {
  it("renders a native <select> for portfolio, native date inputs, and a native <select> for type", async () => {
    renderBar();
    await waitFor(() =>
      expect(screen.getByTestId("ledger-filter-portfolio").querySelectorAll("option")).toHaveLength(
        2,
      ),
    );
    expect(screen.getByTestId("ledger-filter-portfolio").tagName).toBe("SELECT");
    expect(screen.getByTestId("ledger-filter-from")).toHaveAttribute("type", "date");
    expect(screen.getByTestId("ledger-filter-to")).toHaveAttribute("type", "date");
    expect(screen.getByTestId("ledger-filter-type").tagName).toBe("SELECT");
  });

  it("the instrument filter is a debounced text search — the one documented native-control exception", () => {
    renderBar();
    expect(screen.getByTestId("ledger-filter-instrument-search")).toHaveAttribute("type", "text");
  });
});

describe("<LedgerFilterBar> — filter changes", () => {
  it("selecting a portfolio calls onChange with the merged filter set", async () => {
    const { onChange } = renderBar({ from: "2026-01-01" });
    await waitFor(() =>
      expect(screen.getByTestId("ledger-filter-portfolio").querySelectorAll("option")).toHaveLength(
        2,
      ),
    );
    fireEvent.change(screen.getByTestId("ledger-filter-portfolio"), { target: { value: "p-1" } });
    expect(onChange).toHaveBeenCalledWith({ from: "2026-01-01", portfolio: "p-1" });
  });

  it("changing the type <select> calls onChange with the selected TransactionKind", () => {
    const { onChange } = renderBar();
    fireEvent.change(screen.getByTestId("ledger-filter-type"), { target: { value: "DIVIDEND" } });
    expect(onChange).toHaveBeenCalledWith({ type: "DIVIDEND" });
  });

  // cash-interest AC-521; portfolio-cash AC-581 for FEE.
  it.each([
    ["INTEREST", "Intérêt"],
    ["FEE", "Frais de portefeuille"],
  ] as const)(
    "the type filter lists %s as « %s », and choosing it filters on that kind",
    (kind, label) => {
      const { onChange } = renderBar();
      const options = Array.from(
        (screen.getByTestId("ledger-filter-type") as HTMLSelectElement).options,
      ).map((option) => [option.value, option.text]);
      expect(options).toContainEqual([kind, label]);
      fireEvent.change(screen.getByTestId("ledger-filter-type"), { target: { value: kind } });
      expect(onChange).toHaveBeenCalledWith({ type: kind });
    },
  );

  it("Tout effacer calls onChange with an empty object", () => {
    const { onChange } = renderBar({ portfolio: "p-1", type: "BUY" });
    fireEvent.click(screen.getByTestId("ledger-filter-reset"));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it("selecting an instrument search result calls onChange with the instrument id, then shows a clearable chip", async () => {
    mockedApiClient.searchInstruments.mockResolvedValue([
      {
        id: "i-1",
        kind: "SHARE",
        displayName: "Exemple SA",
        listingCurrency: "EUR",
        isin: null,
        exchangeMic: null,
        symbol: null,
      },
    ]);
    const { onChange } = renderBar();
    fireEvent.change(screen.getByTestId("ledger-filter-instrument-search"), {
      target: { value: "Exemple" },
    });
    await waitFor(
      () => expect(screen.getByTestId("ledger-filter-instrument-result")).toBeInTheDocument(),
      {
        timeout: 2000,
      },
    );
    fireEvent.click(screen.getByTestId("ledger-filter-instrument-result"));
    expect(onChange).toHaveBeenCalledWith({ instrument: "i-1" });
  });

  it("an already-selected instrument renders a chip with a Effacer button that clears it", () => {
    const { onChange } = renderBar({ instrument: "i-1" });
    expect(screen.getByTestId("ledger-filter-instrument-selected")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ledger-filter-instrument-clear"));
    expect(onChange).toHaveBeenCalledWith({ instrument: undefined });
  });
});

describe("<LedgerFilterBar> — the active strip", () => {
  it("shows no strip at all when nothing is applied", () => {
    renderBar();
    expect(screen.queryByTestId("ledger-filter-active")).not.toBeInTheDocument();
  });

  it("renders one removable chip per applied filter, resolving names where it has them", async () => {
    renderBar({
      portfolio: "p-1",
      instrument: "i-1",
      from: "2026-01-01",
      to: "2026-08-01",
      type: "DRIP",
    });
    await waitFor(() =>
      expect(screen.getByTestId("ledger-filter-chip-portfolio")).toHaveTextContent(
        "Portefeuille : Compte principal",
      ),
    );
    expect(screen.getByTestId("ledger-filter-chip-instrument")).toHaveTextContent(
      "Instrument : i-1",
    );
    expect(screen.getByTestId("ledger-filter-chip-from")).toHaveTextContent("Depuis le 01/01/2026");
    expect(screen.getByTestId("ledger-filter-chip-to")).toHaveTextContent("Jusqu'au 01/08/2026");
    // The locked short label, the same string the row badge carries.
    expect(screen.getByTestId("ledger-filter-chip-type")).toHaveTextContent(
      "Type : Réinvestissement",
    );
  });

  it("removing a chip clears exactly that filter and leaves the rest applied", () => {
    const { onChange } = renderBar({ portfolio: "p-1", from: "2026-01-01", type: "BUY" });
    fireEvent.click(
      within(screen.getByTestId("ledger-filter-chip-from")).getByRole("button", {
        name: /retirer le filtre/i,
      }),
    );
    expect(onChange).toHaveBeenCalledWith({ portfolio: "p-1", from: undefined, type: "BUY" });
  });

  /**
   * The filters panel's three have no control on this bar, and
   * that is exactly why they must be chipped here — a filter narrowing the
   * ledger with its only control behind a closed drawer is the "applied but
   * invisible" case the strip exists to prevent.
   */
  it("chips the panel-only filters too — currency and both amount bounds", () => {
    renderBar({ currency: "EUR", minAmount: "100", maxAmount: "250.50" });
    expect(screen.getByTestId("ledger-filter-chip-currency")).toHaveTextContent("Devise : EUR");
    // The currency is repeated on the amount chips: « Montant min : 100 »
    // alone would read as a base-currency figure, which is precisely the
    // cross-currency comparison this filter cannot make.
    expect(screen.getByTestId("ledger-filter-chip-min-amount")).toHaveTextContent(
      "Montant min : 100 EUR",
    );
    expect(screen.getByTestId("ledger-filter-chip-max-amount")).toHaveTextContent(
      "Montant max : 250.50 EUR",
    );
  });

  it("removing the currency chip clears both bounds with it — a bound outliving its scope is a 422", () => {
    const { onChange } = renderBar({ currency: "EUR", minAmount: "100", maxAmount: "250" });
    fireEvent.click(
      within(screen.getByTestId("ledger-filter-chip-currency")).getByRole("button", {
        name: /retirer le filtre/i,
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      currency: undefined,
      minAmount: undefined,
      maxAmount: undefined,
    });
  });

  it("removing one amount chip leaves the currency and the other bound applied", () => {
    const { onChange } = renderBar({ currency: "EUR", minAmount: "100", maxAmount: "250" });
    fireEvent.click(
      within(screen.getByTestId("ledger-filter-chip-min-amount")).getByRole("button", {
        name: /retirer le filtre/i,
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      currency: "EUR",
      minAmount: undefined,
      maxAmount: "250",
    });
  });

  it("income mode chips only the two filters that actually scope that view", () => {
    renderBar(
      { portfolio: "p-1", type: "BUY", from: "2026-01-01", currency: "EUR", minAmount: "100" },
      "income",
    );
    expect(screen.getByTestId("ledger-filter-chip-from")).toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-chip-portfolio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-chip-type")).not.toBeInTheDocument();
    // `incomeTotalsQueryOptions` reads from/to and nothing else, so chipping
    // the panel's filters here would claim a scoping that never happened.
    expect(screen.queryByTestId("ledger-filter-chip-currency")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-chip-min-amount")).not.toBeInTheDocument();
  });
});

describe("<LedgerFilterBar>: AC140's honesty note is gone with the limitation it described", () => {
  it("renders no page-scope apology next to the Type control", () => {
    renderBar();
    expect(screen.getByTestId("ledger-filter-type")).toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-type-honesty-note")).not.toBeInTheDocument();
  });

  /**
   * The copy, not only the test id — reworded rather than deleted, the note
   * would keep making the same three false claims under a different id.
   * `GET /transactions?kind=` exists, and the type filter is the ledger's.
   */
  it("no rendered text still claims the type filter is page-scoped or that the server has none", () => {
    const { container } = renderBar();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/déjà chargées/i);
    expect(text).not.toMatch(/côté serveur/i);
    expect(text).not.toMatch(/historique complet/i);
  });
});

describe('<LedgerFilterBar> — mode="income" (found during UR-35\'s product-acceptance-gate walkthrough)', () => {
  it("renders only the Du/Au date controls — no portfolio, instrument or type", async () => {
    renderBar({}, "income");
    expect(screen.getByTestId("ledger-filter-from")).toBeInTheDocument();
    expect(screen.getByTestId("ledger-filter-to")).toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-portfolio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-instrument-search")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-type")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-type-honesty-note")).not.toBeInTheDocument();
  });

  it("reset in income mode clears only from/to", () => {
    const { onChange } = renderBar({ from: "2026-01-01", to: "2026-08-01" }, "income");
    fireEvent.click(screen.getByTestId("ledger-filter-reset"));
    expect(onChange).toHaveBeenCalledWith({ from: undefined, to: undefined });
  });

  it("ledger mode (the default) is unaffected — every control still renders", () => {
    renderBar();
    expect(screen.getByTestId("ledger-filter-portfolio")).toBeInTheDocument();
    expect(screen.getByTestId("ledger-filter-type")).toBeInTheDocument();
  });
});

describe("<LedgerFilterBar> — portfolio-archive: the portfolio filter", () => {
  beforeEach(() => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      {
        id: "p-1",
        name: "Compte principal",
        transactionCount: 4,
        createdAt: "2026-01-01T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
        archived: false,
      },
      {
        id: "p-2",
        name: "Ancien PEA",
        transactionCount: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
        archived: true,
      },
    ]);
  });

  function optionPairs(): [string, string][] {
    const select = screen.getByTestId("ledger-filter-portfolio") as HTMLSelectElement;
    return Array.from(select.options).map((option) => [option.value, option.text]);
  }

  it("AC-486: an archived portfolio is not an option when the filter is empty or another portfolio", async () => {
    for (const filters of [{}, { portfolio: "p-1" }]) {
      renderBar(filters);
      await waitFor(() => expect(optionPairs().map(([value]) => value)).toContain("p-1"));
      expect(optionPairs().map(([value]) => value)).toEqual(["", "p-1"]);
      cleanup();
    }
  });

  it("AC-487 / PA-L10: a filter preset to it lists it once, suffixed, selected — and the chip keeps the plain name", async () => {
    renderBar({ portfolio: "p-2" });
    await waitFor(() => expect(optionPairs()).toContainEqual(["p-2", "Ancien PEA (archivé)"]));
    expect(optionPairs().filter(([value]) => value === "p-2")).toHaveLength(1);
    expect(screen.getByTestId("ledger-filter-portfolio")).toHaveValue("p-2");
    expect(screen.getByTestId("ledger-filter-chip-portfolio")).toHaveTextContent(
      /^Portefeuille : Ancien PEA/,
    );
    expect(screen.getByTestId("ledger-filter-chip-portfolio")).not.toHaveTextContent("archivé");
  });
});
