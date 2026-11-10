import * as Tooltip from "@radix-ui/react-tooltip";
import { render, screen, waitFor } from "@testing-library/react";
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
import { ApiError } from "../lib/api-client.js";
import type { HoldingResponse, HoldingsResponse } from "../lib/api-client.js";
import { ControlsRoute } from "./ControlsRoute.js";

/**
 * UR-30..UR-32 **MODIFY + MERGE**. No search
 * params (`ControlsRoute.tsx`'s own doc comment), so — like
 * `HoldingsRoute.test.tsx` — this file mounts the route directly, wrapped
 * only in a minimal `RouterProvider` (needed because `ControlsTable`/
 * `ControlsCardList` render real `<Link>`s), never the full app router.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchHoldings: vi.fn(),
    listTransactions: vi.fn(),
    fetchInstrument: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    listInstrumentPrices: vi.fn(),
    fetchOverview: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);

const HELD_ID = "11111111-1111-1111-1111-111111111111";

function holding(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId: HELD_ID,
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
    ...overrides,
  };
}

function holdingsResponse(overrides: Partial<HoldingsResponse> = {}): HoldingsResponse {
  return {
    asOfDate: "2026-08-15",
    holdings: [holding()],
    totalValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
    totalUnrealizedGainLoss: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
    cash: { totalBase: "0", currency: "USD", isNegative: false, unconverted: [], byCurrency: [] },
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

function renderRoute(queryClient?: QueryClient): QueryClient {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={client}>
          <Tooltip.Provider delayDuration={200}>
            <ControlsRoute />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(false); // mobile -> ControlsCardList, deliberately never virtualised
  mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
  mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
    Promise.resolve({
      id,
      kind: "SHARE",
      displayName: `Instrument ${id}`,
      listingCurrency: "USD",
      exchangeMic: "XNAS",
      isin: null,
      symbol: null,
      figi: null,
      primaryIdentifier: "ISIN",
      quotePolicy: "AUTO",
      status: "ACTIVE",
      sectorCode: null,
      industryLabel: null,
      domicileCountry: null,
      listingCountry: null,
      hasIcon: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
    status: "COMPLETE",
    requestedFrom: null,
    earliestBackfilledDate: "2025-01-01",
    latestBackfilledDate: "2026-08-01",
    lastQuoteAt: null,
    latestPriceDate: null,
  });
  mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
});

describe("<ControlsRoute> — aggregation and grouping", () => {
  it("renders the held instrument in the grouped list, sourced from the same instrument-set derivation as UR-26", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-card-list")).toBeInTheDocument());
    expect(screen.getByText("Apple Inc")).toBeInTheDocument();
  });

  it("shows the reassuring empty-group copy for Action requise when nothing needs it", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-card-list")).toBeInTheDocument());
    const actionRequiseEmpty = screen
      .getAllByTestId("controls-group-empty")
      .find((el) => el.getAttribute("data-bucket") === "action-requise");
    expect(actionRequiseEmpty).toBeDefined();
  });

  it("shows the explicit empty state (not a blank screen) when there are zero instruments", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse({ holdings: [] }));
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("controls-card-list")).not.toBeInTheDocument();
  });

  it("the truncated note appears only once the transaction scan hits its page cap, honestly labelling a partial sweep", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse({ holdings: [] }));
    let pageNumber = 0;
    mockedApiClient.listTransactions.mockImplementation(async () => {
      const cursor = `cursor-${pageNumber}`;
      pageNumber += 1;
      return { items: [], nextCursor: cursor };
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-truncated-note")).toBeInTheDocument(), {
      timeout: 10_000,
    });
    expect(screen.getByTestId("controls-truncated-note")).toHaveTextContent(
      "Historique analysé partiellement",
    );
  });
});

describe("<ControlsRoute> — UR-31 freshness signal (FR-121/AC113)", () => {
  it("shows the fetch time and no valuation version at all", async () => {
    // The « Valorisation / version <n> » tile went on 2026-09-08: the response
    // still carries `calcEpoch: "7"` and no tile renders it. The freshness
    // signal is the fetch clock beside where it used to be.
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse({ calcEpoch: "7" }));
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("controls-fetched-at").textContent ?? "").toMatch(/\d{1,2}:\d{2}/),
    );
    expect(screen.queryByTestId("controls-freshness")).not.toBeInTheDocument();
    // Asserted on the label, not on the digit: the surviving tiles are a clock
    // and three counts, all of which legitimately carry digits.
    const strip = screen.getByTestId("controls-strip").textContent ?? "";
    expect(strip).not.toMatch(/version/i);
    expect(strip).not.toContain("Valorisation");
  });
});

describe("<ControlsRoute> — UR-14 reuse: 'Saisir un cours' opens the same ManualPriceDialog", () => {
  it("opens the dialog with the clicked holding's identity", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          holding({
            currentPrice: {
              amount: "0.00",
              currency: "USD",
              provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
            },
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("control-enter-price")).toBeInTheDocument());
    screen.getByTestId("control-enter-price").click();
    await waitFor(() => expect(screen.getByTestId("manual-price-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("manual-price-instrument-identity")).toHaveTextContent("Apple Inc");
  });
});

describe("<ControlsRoute> — UR-32 error surfacing (FR-122/AC114)", () => {
  it("own live reads: a holdings-read failure renders through messageForError, never the server's raw detail", async () => {
    mockedApiClient.fetchHoldings.mockRejectedValue(
      new ApiError(422, { code: "VALUATION_RESPONSE_TOO_LARGE", detail: "too many holdings" }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("controls-holdings-error")).toHaveTextContent(
        /dépasse la taille maximale/,
      ),
    );
    expect(screen.getByTestId("controls-holdings-error")).not.toHaveTextContent(
      "too many holdings",
    );
  });

  it("surfaces a VALUATION_* error cached from another screen's overview/holdings/performance read, without itself re-issuing that read", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Simulates a 422 already sitting in the cache from another screen (e.g.
    // the Dashboard's own `["portfolios","overview","combined",...]` read) —
    // `prefetchQuery` never throws; it stores the error state, exactly what a
    // real failed background query would leave behind.
    await queryClient.prefetchQuery({
      queryKey: ["portfolios", "overview", "combined", null, null],
      queryFn: () => Promise.reject(new ApiError(422, { code: "VALUATION_PRICE_UNAVAILABLE" })),
    });

    renderRoute(queryClient);
    await waitFor(() =>
      expect(screen.getByTestId("controls-derived-errors")).toHaveTextContent(
        /prix nécessaire à cette valorisation n'est pas disponible/,
      ),
    );
    // Never re-issued by this screen itself.
    expect(mockedApiClient.fetchOverview).not.toHaveBeenCalled();
  });

  it("a 429 on the screen's own fan-out (history-status reads) shows an explicit throttled-state message, never blank or crashed", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    mockedApiClient.fetchInstrumentHistoryStatus.mockRejectedValue(
      new ApiError(429, { code: "ADMISSION_BOUND_EXCEEDED" }),
    );
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("controls-card-list")).toHaveTextContent(
        /Trop de requêtes simultanées/,
      ),
    );
    // Never a blank/crashed screen — the instrument row itself still rendered.
    expect(screen.getByText("Apple Inc")).toBeInTheDocument();
  });

  /**
   * The three banner treatments: price unavailable is **loss**,
   * FX rate unavailable is **warn**, a genuine 429 is **neutral**. Asserted on
   * the rendered class because the tone *is* the requirement — a banner
   * carrying the right words in the wrong colour fails the AC.
   */
  it("gives an unavailable price the loss treatment and an unavailable FX rate the warn treatment", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await queryClient.prefetchQuery({
      queryKey: ["portfolios", "overview", "combined", null, null],
      queryFn: () => Promise.reject(new ApiError(422, { code: "VALUATION_PRICE_UNAVAILABLE" })),
    });
    await queryClient.prefetchQuery({
      queryKey: ["portfolios", "performance", "combined"],
      queryFn: () => Promise.reject(new ApiError(422, { code: "VALUATION_FX_RATE_UNAVAILABLE" })),
    });

    renderRoute(queryClient);
    await waitFor(() => expect(screen.getAllByTestId("controls-derived-error")).toHaveLength(2));
    const banners = screen.getAllByTestId("controls-derived-error");
    const priceBanner = banners.find((el) => /prix nécessaire/.test(el.textContent ?? ""));
    const fxBanner = banners.find((el) => /taux de change nécessaire/.test(el.textContent ?? ""));
    expect(priceBanner).toHaveClass("k-banner-loss");
    expect(fxBanner).toHaveClass("k-banner-warn");
  });

  it("gives a genuine 429 on the screen's own fan-out the neutral rate-limited banner", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    mockedApiClient.fetchInstrumentHistoryStatus.mockRejectedValue(
      new ApiError(429, { code: "ADMISSION_BOUND_EXCEEDED" }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-rate-limited")).toBeInTheDocument());
    const banner = screen.getByTestId("controls-rate-limited");
    expect(banner).toHaveClass("k-banner-neutral");
    expect(banner).toHaveTextContent(/Trop de requêtes simultanées/);
    // No countdown is claimed: `ApiError` carries no `Retry-After`, so the
    // banner states the situation and the audited copy's own advice, nothing
    // more (this route's own doc comment records why).
    expect(banner.textContent ?? "").not.toMatch(/\d+\s*s/);
  });
});

describe("<ControlsRoute> — the design's strip, filled from the read", () => {
  it("fills all four tiles from data the controls read actually returned, never a placeholder figure", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        calcEpoch: "7",
        holdings: [
          holding({
            currentPrice: {
              amount: "0.00",
              currency: "USD",
              provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
            },
          }),
        ],
      }),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
      status: "FAILED",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      lastQuoteAt: null,
      latestPriceDate: null,
    });

    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-card-list")).toBeInTheDocument());

    // 1. When the data was fetched — a time, from TanStack Query's own
    //    `dataUpdatedAt`, not a recalculation claim. (The fifth tile, the
    //    opaque valuation version, went on 2026-09-08.)
    expect(screen.getByTestId("controls-fetched-at").textContent ?? "").toMatch(/\d{1,2}:\d{2}/);
    expect(screen.queryByTestId("controls-freshness")).not.toBeInTheDocument();
    // 2/3/4. Counts over the rows this screen actually has.
    expect(screen.getByTestId("controls-attention-count")).toHaveTextContent("1");
    expect(screen.getByTestId("controls-failed-count")).toHaveTextContent("1");
    expect(screen.getByTestId("controls-running-count")).toHaveTextContent("0");
  });

  it("says '—' rather than a time — or a '…' that would call an error 'loading' — when the holdings read fails", async () => {
    mockedApiClient.fetchHoldings.mockRejectedValue(
      new ApiError(422, { code: "VALUATION_RESPONSE_TOO_LARGE" }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-holdings-error")).toBeInTheDocument());
    const tile = screen.getByTestId("controls-fetched-at");
    expect(tile).toHaveTextContent("—");
    expect(tile.textContent ?? "").not.toContain("…");
  });

  it("renders no footer progress bar once every row's status read has settled — the bar reports real fan-out progress or nothing", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-card-list")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId("control-card")).toHaveTextContent(/Historique disponible/),
    );
    expect(screen.queryByTestId("controls-progress")).not.toBeInTheDocument();
  });
});

describe("<ControlsRoute> — FR-123/AC115: no audit-trail implication", () => {
  it("renders none of the banned audit-log phrases anywhere on the mounted screen", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          holding({
            currentPrice: {
              amount: "0.00",
              currency: "USD",
              provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
            },
          }),
        ],
      }),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
      status: "FAILED",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      lastQuoteAt: null,
      latestPriceDate: null,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("controls-card-list")).toBeInTheDocument());
    const text = (document.body.textContent ?? "").toLowerCase();
    for (const banned of [
      "historique des modifications",
      "journal",
      "audit",
      "révision",
      "qui a modifié",
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});
