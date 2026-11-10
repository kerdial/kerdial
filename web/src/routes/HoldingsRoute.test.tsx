import * as Tooltip from "@radix-ui/react-tooltip";
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
import * as allocationLib from "../lib/allocation.js";
import * as apiClient from "../lib/api-client.js";
import type { ClosedPositionsResponse, HoldingsResponse } from "../lib/api-client.js";
import { HoldingsRoute } from "./HoldingsRoute.js";

/**
 * UR-12 (AC124/AC125/
 * AC127). The one thing only a route-level test can prove: `computeAllocation`
 * is invoked **once per render pass** (AC127) — a spy, not an inspection —
 * because both the summary strip's kind-exposure/top-concentration and the
 * mounted table/card list's own allocation prop must come from the *same*
 * call, made here in `HoldingsRoute.tsx`, never recomputed by a child.
 *
 * UR-42: `HoldingsTable`/`HoldingsCardList` now render a real `<Link>`
 * ("holding-open-instrument"), so this suite needs a mounted
 * `RouterProvider` — the same minimal in-test router
 * `InstrumentTable.test.tsx`/`HoldingsTable.test.tsx` already establish.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchHoldings: vi.fn(),
    // `closed-positions` CP-6: stubbed so the laziness can be *observed*, not
    // because any pre-existing test invokes it. The query is `enabled` only on
    // the « Clôturées » tab, so every assertion in this file that predates the
    // feature runs with this spy untouched — which is the point of the two
    // tests at the bottom.
    fetchClosedPositions: vi.fn(),
    fetchPortfolios: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    listInstrumentPrices: vi.fn(),
    requestQuoteRefresh: vi.fn(),
  };
});

vi.mock("../lib/allocation.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/allocation.js")>("../lib/allocation.js");
  return { ...actual, computeAllocation: vi.fn(actual.computeAllocation) };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedAllocation = vi.mocked(allocationLib);

function holdingsResponse(overrides: Partial<HoldingsResponse> = {}): HoldingsResponse {
  return {
    asOfDate: "2026-08-15",
    holdings: [
      {
        instrumentId: "11111111-1111-1111-1111-111111111111",
        kind: "SHARE",
        displayName: "Apple Inc",
        symbol: null,
        sectorCode: null,
        domicileCountry: null,
        listingCountry: null,
        hasIcon: false,
        quantity: "10",
        currency: "USD",
        pmp: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
        costBasis: { amount: "1000.00", currency: "USD", provenance: { derivedFrom: [] } },
        currentPrice: { amount: "110.00", currency: "USD", provenance: { derivedFrom: [] } },
        currentValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
        unrealizedGainLoss: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
        realizedGains: [],
      },
    ],
    totalValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
    totalUnrealizedGainLoss: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
    cash: { totalBase: "0", currency: "USD", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "1",
    portfolioCount: 1,
    ...overrides,
  };
}

function closedPositionsResponse(
  overrides: Partial<ClosedPositionsResponse> = {},
): ClosedPositionsResponse {
  return {
    asOfDate: "2026-08-15",
    closedPositions: [
      {
        instrumentId: "22222222-2222-2222-2222-222222222222",
        kind: "SHARE",
        displayName: "Nokia Oyj",
        hasIcon: false,
        currency: "EUR",
        totalRealizedGainBase: {
          amount: "250.00",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
        totalRealizedGainNative: {
          amount: "250.00",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
        totalFxComponentBase: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
        totalDisposedCostBasisBase: {
          amount: "1000.00",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
        realizedGains: [],
      },
    ],
    calcEpoch: "1",
    portfolioCount: 1,
    ...overrides,
  };
}

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function renderRoute(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <Tooltip.Provider delayDuration={200}>
            <HoldingsRoute />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mobile viewport -> `HoldingsCardList` mounts, no `@tanstack/react-virtual`
  // measurement concern (see `HoldingsTable.test.tsx`'s own note on why the
  // desktop table needs a jsdom-specific mock this file avoids entirely).
  stubMatchMedia(false);
  mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
    status: "PENDING",
    requestedFrom: null,
    earliestBackfilledDate: null,
    latestBackfilledDate: null,
    lastQuoteAt: null,
    latestPriceDate: null,
  });
  mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
  mockedApiClient.fetchPortfolios.mockResolvedValue([]);
});

describe("<HoldingsRoute> — AC127: one computeAllocation call per render pass", () => {
  it("calls computeAllocation exactly once once holdings have loaded", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());
    expect(mockedAllocation.computeAllocation).toHaveBeenCalledTimes(1);
  });
});

describe("<HoldingsRoute> — summary strip", () => {
  it("total value renders HoldingsResponse.totalValue exactly, never a re-summed figure", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        totalValue: { amount: "42000.00", currency: "USD", provenance: { derivedFrom: [] } },
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("holdings-total-value")).toHaveTextContent("42 000.00 USD"),
    );
  });

  it("AC125: total cost basis equals the sum of every row's own costBasis.amount", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          {
            instrumentId: "a",
            kind: "SHARE",
            displayName: "A",
            symbol: null,
            sectorCode: null,
            domicileCountry: null,
            listingCountry: null,
            hasIcon: false,
            quantity: "1",
            currency: "USD",
            pmp: { amount: "1", currency: "USD", provenance: { derivedFrom: [] } },
            costBasis: { amount: "600.00", currency: "USD", provenance: { derivedFrom: [] } },
            currentPrice: { amount: "1", currency: "USD", provenance: { derivedFrom: [] } },
            currentValue: { amount: "600.00", currency: "USD", provenance: { derivedFrom: [] } },
            unrealizedGainLoss: { amount: "0", currency: "USD", provenance: { derivedFrom: [] } },
            realizedGains: [],
          },
          {
            instrumentId: "b",
            kind: "SHARE",
            displayName: "B",
            symbol: null,
            sectorCode: null,
            domicileCountry: null,
            listingCountry: null,
            hasIcon: false,
            quantity: "1",
            currency: "USD",
            pmp: { amount: "1", currency: "USD", provenance: { derivedFrom: [] } },
            costBasis: { amount: "400.00", currency: "USD", provenance: { derivedFrom: [] } },
            currentPrice: { amount: "1", currency: "USD", provenance: { derivedFrom: [] } },
            currentValue: { amount: "400.00", currency: "USD", provenance: { derivedFrom: [] } },
            unrealizedGainLoss: { amount: "0", currency: "USD", provenance: { derivedFrom: [] } },
            realizedGains: [],
          },
        ],
        totalValue: { amount: "1000.00", currency: "USD", provenance: { derivedFrom: [] } },
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("holdings-total-cost-basis")).toHaveTextContent("1 000.00 USD"),
    );
  });

  it("top-concentration fills the fourth slot, from the same allocation the table/card list consumes", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    // The 4-up strip is exactly four cells. The fourth was once meant
    // as a cash balance; the slot carries the concentration figure instead
    // and portfolio-cash did not restore the tile (PC-L10) — the cash is a row.
    await waitFor(() =>
      expect(screen.getByTestId("holdings-top-concentration")).toHaveTextContent("100.00%"),
    );
    expect(screen.getByTestId("holdings-summary").children).toHaveLength(4);
  });

  it("AC-580/AC-577: the « Liquidités » row states the cash and its share, the total includes it, the concentration tile ignores it", async () => {
    // H: one 200.00 position and 975.00 of cash, 1175.00 in all.
    const [base] = holdingsResponse().holdings;
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          {
            ...base!,
            currentValue: { amount: "200.00", currency: "USD", provenance: { derivedFrom: [] } },
          },
        ],
        totalValue: { amount: "1175.00", currency: "USD", provenance: { derivedFrom: [] } },
        cash: {
          totalBase: "975.00",
          currency: "USD",
          isNegative: false,
          unconverted: [],
          byCurrency: [],
        },
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("holdings-total-value")).toHaveTextContent("1 175.00 USD"),
    );
    const card = screen
      .getAllByTestId("holding-card")
      .find((c) => c.getAttribute("data-kind") === "CASH")!;
    expect(card.querySelector("[data-testid='holding-display-name']")).toHaveTextContent(
      "Liquidités",
    );
    expect(card.querySelector("[data-testid='holding-current-value']")).toHaveTextContent(
      "975.00 USD",
    );
    expect(card.querySelector("[data-testid='holding-allocation-percentage']")).toHaveTextContent(
      "82.98%",
    );
    // Instruments only, as a share of the cash-inclusive total (C-13): 200/1175.
    expect(screen.getByTestId("holdings-top-concentration")).toHaveTextContent("17.02%");
    expect(mockedAllocation.computeAllocation).toHaveBeenCalledTimes(1);
  });

  it("kind exposure moved behind the Répartition tab, still from that same one allocation", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());

    // Positions is the opening tab, and the roll-up is not on it.
    expect(screen.queryByTestId("holdings-kind-exposure")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Répartition/ }));

    expect(screen.getByTestId("holdings-summary-kind-subtotal-row")).toHaveTextContent("SHARE");
    expect(screen.getByTestId("holdings-summary-kind-subtotal-row")).toHaveTextContent("100.00%");
    // Still one call: the tab reads the route's own allocation, never its own.
    expect(mockedAllocation.computeAllocation).toHaveBeenCalledTimes(1);
  });

  it("the tab leads with the map — one tile per position, sized and coloured from that same allocation", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());
    expect(screen.queryByTestId("holdings-map")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Répartition/ }));

    const tiles = screen.getAllByTestId("holdings-map-tile");
    expect(tiles).toHaveLength(1);
    // The single holding is the whole portfolio, gaining 10 % on a 1000 cost
    // basis — so: the full box, and the strong-gain end of the ramp.
    expect(tiles[0]).toHaveAttribute("data-tone", "gain-strong");
    expect(tiles[0]!.style.width).toBe("100%");
    expect(tiles[0]!.style.height).toBe("100%");
    expect(tiles[0]).toHaveAttribute("href", "/instruments/11111111-1111-1111-1111-111111111111");
    // The bar and its subtotals are still under the map: the map says which
    // positions carry the portfolio, the bar how the weight splits by class.
    expect(screen.getByTestId("holdings-summary-kind-subtotal-row")).toBeInTheDocument();
    // And the map cost no second allocation pass (AC127).
    expect(mockedAllocation.computeAllocation).toHaveBeenCalledTimes(1);
  });

  it("the footer states the result count and no page control — this read is not paginated", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("holdings-card-list-count")).toHaveTextContent("1 position"),
    );
    expect(screen.queryByRole("navigation", { name: /pagination/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/page \d+ sur \d+/i)).not.toBeInTheDocument();
  });
});

describe("<HoldingsRoute> — UR-14: onEnterPrice opens ManualPriceDialog for the clicked holding, the real seam UR-12 left undefined", () => {
  it("clicking 'Saisir un cours' on a MANUAL-quality holding opens the dialog with that holding's identity", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          {
            instrumentId: "33333333-3333-3333-3333-333333333333",
            kind: "FUND",
            displayName: "Fonds Prudent Manuel",
            symbol: null,
            sectorCode: null,
            domicileCountry: null,
            listingCountry: null,
            hasIcon: false,
            quantity: "5",
            currency: "EUR",
            pmp: { amount: "100.00", currency: "EUR", provenance: { derivedFrom: [] } },
            costBasis: { amount: "500.00", currency: "EUR", provenance: { derivedFrom: [] } },
            currentPrice: {
              amount: "110.00",
              currency: "EUR",
              provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
            },
            currentValue: { amount: "550.00", currency: "EUR", provenance: { derivedFrom: [] } },
            unrealizedGainLoss: {
              amount: "50.00",
              currency: "EUR",
              provenance: { derivedFrom: [] },
            },
            realizedGains: [],
          },
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holding-enter-price")).toBeInTheDocument());

    expect(screen.queryByTestId("manual-price-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("holding-enter-price"));

    expect(await screen.findByTestId("manual-price-dialog")).toBeVisible();
    expect(screen.getByTestId("manual-price-instrument-identity")).toHaveTextContent(
      "Fonds Prudent Manuel",
    );
    expect(screen.getByTestId("manual-price-instrument-identity")).toHaveTextContent("FUND");
  });
});

describe("<HoldingsRoute> — « Actualiser les cours » (POST /market-data/quote-refresh)", () => {
  it("requests a refresh of every held instrument and confirms it as queued, never as done", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    mockedApiClient.requestQuoteRefresh.mockResolvedValue({
      requestId: "1e6de6d3-0000-7000-8000-000000000001",
      bucket: "req:1e6de6d3-0000-7000-8000-000000000001",
      heldInstruments: 12,
      enqueued: 12,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("quote-refresh"));

    await waitFor(() => {
      const notice = screen.getByTestId("quote-refresh-notice").textContent ?? "";
      expect(notice).toContain("12 instruments");
      // A `202` is a queued fan-out, not fetched data — the copy must not
      // claim the quotes are already updated (the Devises screen's own rule).
      // Since then it also promises the figures will follow on their own,
      // which is a promise the poll below is what actually keeps.
      expect(notice).toContain("se mettront à jour");
    });
    expect(mockedApiClient.requestQuoteRefresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads the holdings while the refresh lands — the figures update without a manual reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
      mockedApiClient.requestQuoteRefresh.mockResolvedValue({
        requestId: "1e6de6d3-0000-7000-8000-000000000003",
        bucket: "req:1e6de6d3-0000-7000-8000-000000000003",
        heldInstruments: 4,
        enqueued: 4,
      });
      renderRoute();
      await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());
      const readsBeforePress = mockedApiClient.fetchHoldings.mock.calls.length;

      fireEvent.click(screen.getByTestId("quote-refresh"));
      await waitFor(() => expect(screen.getByTestId("quote-refresh-notice")).toBeInTheDocument());

      // The worker writes the prices seconds after the `202`, so the screen
      // has to come back for them. Until then it never did: the mutation set a
      // notice and nothing else, and the figures stayed at their mount-time
      // values for the life of the tab.
      await vi.advanceTimersByTimeAsync(6_000);

      expect(mockedApiClient.fetchHoldings.mock.calls.length).toBeGreaterThan(readsBeforePress);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the window closes — a press does not leave the tab re-reading for ever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
      mockedApiClient.requestQuoteRefresh.mockResolvedValue({
        requestId: "1e6de6d3-0000-7000-8000-000000000004",
        bucket: "req:1e6de6d3-0000-7000-8000-000000000004",
        heldInstruments: 4,
        enqueued: 4,
      });
      renderRoute();
      await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("quote-refresh"));
      await waitFor(() => expect(screen.getByTestId("quote-refresh-notice")).toBeInTheDocument());

      // Well past the 90 s window.
      await vi.advanceTimersByTimeAsync(150_000);
      const settled = mockedApiClient.fetchHoldings.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockedApiClient.fetchHoldings.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says there was nothing to refresh when the tenant holds no instrument", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse({ holdings: [] }));
    mockedApiClient.requestQuoteRefresh.mockResolvedValue({
      requestId: "1e6de6d3-0000-7000-8000-000000000002",
      bucket: "req:1e6de6d3-0000-7000-8000-000000000002",
      heldInstruments: 0,
      enqueued: 0,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("quote-refresh")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("quote-refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("quote-refresh-notice")).toHaveTextContent("rien à actualiser"),
    );
  });

  it("renders the SH-19 429 cap through messageForError instead of a silent no-op", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    mockedApiClient.requestQuoteRefresh.mockRejectedValue(
      new apiClient.ApiError(429, { title: "Too Many Requests" }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("quote-refresh"));

    await waitFor(() => expect(screen.getByTestId("quote-refresh-error")).toBeInTheDocument());
    // Never the server's own English `title`.
    expect(screen.getByTestId("quote-refresh-error")).not.toHaveTextContent("Too Many Requests");
  });
});

/**
 * `closed-positions` UR-41/CP-6. Three properties, each of which a weaker assertion would miss:
 *
 * 1. **The read is genuinely lazy**, not merely lazily *displayed*. Asserting
 *    the panel is absent while « Ouvertes » is active would pass just as
 *    happily against a component that fetches on mount and hides the result;
 *    the assertion below is on the fetcher spy, so only a query that is
 *    actually `enabled: false` satisfies it.
 * 2. **The tab strip is reachable with zero open holdings** — the structural
 *    fix. Before it, the strip lived inside `data.holdings.length > 0`, so the
 *    tenant who had sold out of everything, the one person the « Clôturées »
 *    tab exists for, could not see it.
 * 3. **The count appears only once the read has resolved** — a zero rendered
 *    before the fetch would be a claim ("you have never sold out of anything")
 *    the screen cannot yet back up.
 */
describe("<HoldingsRoute> — the « Clôturées » tab (UR-41, CP-6)", () => {
  it("does not read closed positions while « Ouvertes » is the active tab, and reads them only once « Clôturées » is activated", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    mockedApiClient.fetchClosedPositions.mockResolvedValue(closedPositionsResponse());

    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());

    // The mechanism check: the holdings read has landed, the screen is fully
    // rendered on its opening tab, and the second valuation read has not been
    // issued at all. It shares one bound-1 budget slot with `fetchHoldings`.
    expect(mockedApiClient.fetchClosedPositions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /Clôturées/ }));

    await waitFor(() => expect(mockedApiClient.fetchClosedPositions).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("closed-positions-card-list")).toBeInTheDocument();
  });

  it("renders the tab strip for a tenant holding nothing — the person the tab is for", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse({ holdings: [] }));
    mockedApiClient.fetchClosedPositions.mockResolvedValue(closedPositionsResponse());

    renderRoute();

    // The `portfolio-no-holdings` state is on the « Ouvertes » panel, and the
    // strip is above it rather than inside its guard.
    await waitFor(() => expect(screen.getByTestId("holdings-empty")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /Ouvertes/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Clôturées/ }));

    expect(await screen.findByTestId("closed-position-card")).toHaveTextContent("Nokia Oyj");
    // And the open-holdings surfaces are gone with the tab, not merely hidden.
    expect(screen.queryByTestId("holdings-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("holdings-summary")).not.toBeInTheDocument();
  });

  it("carries no count on « Clôturées » until its own read resolves", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    let resolveClosed: (value: ClosedPositionsResponse) => void = () => undefined;
    mockedApiClient.fetchClosedPositions.mockReturnValue(
      new Promise<ClosedPositionsResponse>((resolve) => {
        resolveClosed = resolve;
      }),
    );

    renderRoute();
    await waitFor(() => expect(screen.getByTestId("holdings-summary")).toBeInTheDocument());

    // `<Tabs>` renders the count in a `.k-tab-count` span, so "no count" is
    // "the tab's text is exactly its label".
    const closedTab = screen.getByRole("tab", { name: /Clôturées/ });
    expect(closedTab.querySelector(".k-tab-count")).toBeNull();
    // The « Ouvertes » tab does carry one from the very first paint — its read
    // has already landed.
    expect(
      screen.getByRole("tab", { name: /Ouvertes/ }).querySelector(".k-tab-count"),
    ).not.toBeNull();

    fireEvent.click(closedTab);
    await screen.findByTestId("closed-positions-loading");
    expect(screen.getByRole("tab", { name: /Clôturées/ }).querySelector(".k-tab-count")).toBeNull();

    resolveClosed(closedPositionsResponse());

    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /Clôturées/ }).querySelector(".k-tab-count"),
      ).toHaveTextContent("1"),
    );
  });
});

describe("<HoldingsRoute> — errors go through messageForError, never inline/server copy", () => {
  it("a VALUATION_RESPONSE_TOO_LARGE error renders its dedicated French message", async () => {
    mockedApiClient.fetchHoldings.mockRejectedValue(
      new apiClient.ApiError(422, {
        code: "VALUATION_RESPONSE_TOO_LARGE",
        detail: "too many holdings",
      }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("holdings-error")).toHaveTextContent(/dépasse la taille maximale/),
    );
    // Never the server's own English `detail`.
    expect(screen.getByTestId("holdings-error")).not.toHaveTextContent("too many holdings");
  });
});
