import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { InstrumentSummary, PortfolioSummary } from "../lib/api-client.js";
import { QuickSearch } from "./QuickSearch.js";

/**
 * `QuickSearch.test.tsx` — UR-37's own acceptance
 * criteria. Two of the five (the ≥3-character network-level gate and the
 * `cheapReadBudget` peak-concurrency bound) are also proven at the network
 * level in `web/e2e/quick-search.spec.ts` — a jsdom unit test can assert
 * "the mocked function was never called", which is exactly what the first
 * needs, but "asserted with peakConcurrency" (the AC's own wording) means a
 * real intercepted route with real timing, which only Playwright gives.
 *
 * Same in-test-router shape `PortfolioDetailRoute.test.tsx`/
 * `AppShell.test.tsx` already use — `router.tsx` itself cannot be imported
 * under `vitest` (it pulls in `virtual:pwa-register/react`).
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchPortfolios: vi.fn(), searchInstruments: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

function portfolio(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Compte principal",
    transactionCount: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    broker: null,
    description: null,
    accentColor: null,
    hasIcon: false,
    archived: false,
    ...overrides,
  };
}

function instrument(overrides: Partial<InstrumentSummary> = {}): InstrumentSummary {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    kind: "SHARE",
    displayName: "Apple Inc",
    listingCurrency: "USD",
    isin: "US0378331005",
    exchangeMic: "XNAS",
    symbol: "AAPL",
    ...overrides,
  };
}

async function renderOpen(): Promise<{ locationPath: () => string }> {
  const shell = renderShell();
  fireEvent.click(await screen.findByTestId("quick-search-trigger"));
  await screen.findByTestId("quick-search-dialog");
  return shell;
}

function renderShell(): { locationPath: () => string } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <QuickSearch />
        </QueryClientProvider>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/portfolios/$portfolioId",
      component: () => <span data-testid="portfolio-workspace-landed" />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/instruments/$instrumentId",
      component: () => <span data-testid="instrument-detail-landed" />,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
  return { locationPath: () => router.state.location.pathname };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchPortfolios.mockResolvedValue([portfolio()]);
  mockedApiClient.searchInstruments.mockResolvedValue([instrument()]);
});

describe("<QuickSearch> — reachability and dismissal", () => {
  it("is closed by default and issues neither read while closed", async () => {
    renderShell();
    await screen.findByTestId("quick-search-trigger");
    expect(screen.queryByTestId("quick-search-dialog")).not.toBeInTheDocument();
    // Give any accidental eager fetch a chance to fire before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedApiClient.fetchPortfolios).not.toHaveBeenCalled();
    expect(mockedApiClient.searchInstruments).not.toHaveBeenCalled();
  });

  it("opens via the header trigger", async () => {
    await renderOpen();
    expect(screen.getByTestId("quick-search-dialog")).toBeInTheDocument();
  });

  it("opens via ⌘K and via Ctrl+K, from anywhere — a window-level listener, not scoped to a focused element", async () => {
    renderShell();
    await screen.findByTestId("quick-search-trigger");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByTestId("quick-search-dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quick-search-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("quick-search-dialog")).not.toBeInTheDocument(),
    );

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByTestId("quick-search-dialog")).toBeInTheDocument();
  });

  it("closes on Escape — Radix Dialog's own default, not reimplemented", async () => {
    await renderOpen();
    fireEvent.keyDown(screen.getByTestId("quick-search-dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("quick-search-dialog")).not.toBeInTheDocument(),
    );
  });

  it("closes via the explicit close button", async () => {
    await renderOpen();
    fireEvent.click(screen.getByTestId("quick-search-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("quick-search-dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("<QuickSearch> — portfolios (client-side filter over the cached list)", () => {
  it("shows every portfolio on an empty query, from the already-cached list — one fetch, not a palette-only endpoint", async () => {
    await renderOpen();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("quick-search-result-portfolio")).toHaveTextContent(
      "Compte principal",
    );
  });

  it("filters as the user types, case-insensitively", async () => {
    await renderOpen();
    await screen.findByTestId("quick-search-result-portfolio");
    fireEvent.change(screen.getByTestId("quick-search-input"), {
      target: { value: "PRINCIPAL" },
    });
    expect(screen.getByTestId("quick-search-result-portfolio")).toHaveTextContent(
      "Compte principal",
    );
    fireEvent.change(screen.getByTestId("quick-search-input"), { target: { value: "épargne" } });
    expect(screen.getByTestId("quick-search-portfolios-empty")).toBeInTheDocument();
  });

  it("selecting a portfolio result navigates to its workspace and closes the palette", async () => {
    const { locationPath } = await renderOpen();
    const result = await screen.findByTestId("quick-search-result-portfolio");
    fireEvent.click(result);

    await screen.findByTestId("portfolio-workspace-landed");
    expect(locationPath()).toBe(`/portfolios/${portfolio().id}`);
    expect(screen.queryByTestId("quick-search-dialog")).not.toBeInTheDocument();
  });

  it("AC-485 — an archived portfolio's name yields no result; a non-archived sibling still does", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      portfolio({
        id: "22222222-2222-2222-2222-222222222222",
        name: "Compte ancien",
        archived: true,
      }),
      portfolio({ name: "Compte principal" }),
    ]);
    await renderOpen();
    await screen.findByTestId("quick-search-result-portfolio");

    fireEvent.change(screen.getByTestId("quick-search-input"), { target: { value: "ancien" } });
    expect(screen.getByTestId("quick-search-portfolios-empty")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("quick-search-input"), { target: { value: "compte" } });
    const results = screen.getAllByTestId("quick-search-result-portfolio");
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveTextContent("Compte principal");
  });
});

describe("<QuickSearch> — instruments (debounced, background priority, ≥3-alphanumeric gate)", () => {
  it("shows a hint and issues zero requests below the 3-alphanumeric-character floor", async () => {
    await renderOpen();

    fireEvent.change(screen.getByTestId("quick-search-input"), { target: { value: "a_b" } });
    expect(screen.getByTestId("quick-search-instrument-hint")).toBeInTheDocument();

    // Give the debounce window plenty of time to elapse — this is the
    // red-confirm: a query that never clears the gate must never fire.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mockedApiClient.searchInstruments).not.toHaveBeenCalled();
  });

  it("debounces several rapid keystrokes into one committed search, for the final value only", async () => {
    await renderOpen();

    const input = screen.getByTestId("quick-search-input");
    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.change(input, { target: { value: "Ap" } });
    fireEvent.change(input, { target: { value: "App" } });
    fireEvent.change(input, { target: { value: "Appl" } });
    fireEvent.change(input, { target: { value: "Apple" } });

    // RED-CONFIRM: immediately after the burst the debounce has not
    // committed — proves a genuine debounce, not merely "one call happens to
    // be the only one visible by the time the assertion below runs".
    expect(mockedApiClient.searchInstruments).not.toHaveBeenCalled();

    await waitFor(() => expect(mockedApiClient.searchInstruments).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
    });
    expect(mockedApiClient.searchInstruments).toHaveBeenCalledWith(
      "Apple",
      expect.any(AbortSignal),
    );
  });

  it("selecting an instrument result navigates to its detail page and closes the palette", async () => {
    const { locationPath } = await renderOpen();
    fireEvent.change(screen.getByTestId("quick-search-input"), {
      target: { value: "Apple" },
    });

    const result = await screen.findByTestId("quick-search-result-instrument", undefined, {
      timeout: 1_000,
    });
    fireEvent.click(result);

    await screen.findByTestId("instrument-detail-landed");
    expect(locationPath()).toBe(`/instruments/${instrument().id}`);
    expect(screen.queryByTestId("quick-search-dialog")).not.toBeInTheDocument();
  });
});

describe("<QuickSearch> — keyboard-only operation", () => {
  it("ArrowDown/ArrowUp move the active option across both groups, Enter activates it", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      portfolio({ id: "port-1", name: "Alpha" }),
      portfolio({ id: "port-2", name: "Beta" }),
    ]);
    const { locationPath } = await renderOpen();
    await waitFor(() =>
      expect(screen.getAllByTestId("quick-search-result-portfolio")).toHaveLength(2),
    );

    const input = screen.getByTestId("quick-search-input");
    const options = () => screen.getAllByTestId("quick-search-result-portfolio");

    // Index 0 is active by default.
    expect(options()[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(options()[0]).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options()[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(locationPath()).toBe("/portfolios/port-1"));
  });

  it("reflects the active option via aria-activedescendant on the input", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      portfolio({ id: "port-1", name: "Alpha" }),
      portfolio({ id: "port-2", name: "Beta" }),
    ]);
    await renderOpen();
    await waitFor(() =>
      expect(screen.getAllByTestId("quick-search-result-portfolio")).toHaveLength(2),
    );

    const input = screen.getByTestId("quick-search-input");
    expect(input).toHaveAttribute("aria-activedescendant", "quick-search-option-0");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "quick-search-option-1");
  });

  it("ArrowDown/ArrowUp never move past the ends of the combined list", async () => {
    await renderOpen();
    const input = screen.getByTestId("quick-search-input");
    await screen.findByTestId("quick-search-result-portfolio");

    // Only one portfolio result and the instrument group shows its hint (no
    // instrument rows) — a single-item list must stay pinned at index 0.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("quick-search-result-portfolio")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("quick-search-result-portfolio")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("<QuickSearch> — never implies transactions are searchable here", () => {
  it("mentions no transaction-shaped copy anywhere in the open dialog, empty or filled", async () => {
    await renderOpen();
    const dialog = screen.getByTestId("quick-search-dialog");
    const text = (dialog.textContent ?? "").toLowerCase();
    expect(text).not.toContain("transaction");
    expect(text).not.toContain("activité");

    fireEvent.change(screen.getByTestId("quick-search-input"), { target: { value: "zzz-none" } });
    await waitFor(() =>
      expect(screen.getByTestId("quick-search-portfolios-empty")).toBeInTheDocument(),
    );
    const textAfter = (dialog.textContent ?? "").toLowerCase();
    expect(textAfter).not.toContain("transaction");
  });

  it("exposes exactly two result groups — Portefeuilles and Instruments — never a third", async () => {
    await renderOpen();
    const dialog = screen.getByTestId("quick-search-dialog");
    const groups = dialog.querySelectorAll("section[aria-label]");
    const labels = [...groups].map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Portefeuilles", "Instruments"]);
  });
});
