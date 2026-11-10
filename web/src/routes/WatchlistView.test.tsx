import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { ApiError } from "../lib/api-client.js";
import type { WatchlistResponse, WatchlistRow } from "../lib/api-client.js";
import { EMPTY_STATE_COPY } from "../lib/empty-states.js";
import { WATCHLIST_WINDOW_PRESET_IDS } from "../lib/period-presets.js";
import { WatchlistView } from "./WatchlistView.js";

/**
 * `WatchlistView.test.tsx` — the Suivi screen
 * (FR-341, FR-355,
 * FR-357, FR-361, FR-373, UR-47, UR-50, UR-51, UR-53, UR-54, **AC-344**,
 * **AC-345**).
 *
 * Renders the **view**, not the route: `WatchlistView` is router-agnostic by
 * design, so this suite never imports `router.js` and never has to resolve
 * `virtual:pwa-register/react` (`DividendsView.test.tsx`'s own recorded split).
 * It still needs a router in the tree, because `PageHeader` and the rows render
 * `<Link>`s.
 *
 * The two request-shape properties asserted here are the ones the design's
 * arithmetic depends on: **one** `GET /watchlist` per screen state for any
 * number of rows, and **no** per-row read at all (FR-357/FR-362).
 * Since then (2026-09-11) the screen also makes **no holdings read**: the
 * position block moved to the per-instrument analysis screen with the panel,
 * and since then the AC-345 editor cases live in
 * `WatchlistTargetEditor.test.tsx` / `WatchlistAnalysisView.test.tsx`, where
 * the editor now mounts.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchWatchlist: vi.fn(),
    fetchWatchedInstrumentIds: vi.fn(),
    fetchHoldings: vi.fn(),
    postWatchlistItem: vi.fn(),
    patchWatchlistItem: vi.fn(),
    deleteWatchlistItem: vi.fn(),
    listInstrumentPrices: vi.fn(),
    listInstrumentPriceWindow: vi.fn(),
    searchInstruments: vi.fn(),
    fetchInstrument: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    fetchCurrencies: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);

const APPLE = "11111111-1111-4111-8111-111111111111";

function valued(amount: string, currency = "USD") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function row(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    instrumentId: APPLE,
    kind: "SHARE",
    displayName: "Apple Inc",
    hasIcon: false,
    status: "ACTIVE",
    listingCurrency: "USD",
    listingCountry: "US",
    sectorCode: null,
    industryLabel: null,
    domicileCountry: null,
    watchedSince: "2026-01-15",
    targetPrice: null,
    note: null,
    currentPrice: valued("198.20"),
    dayChange: "1.20",
    dayChangePercent: "0.0061",
    metrics: { unusableSeries: false, periodReturns: { "1Y": "0.1234" } },
    series: [
      { date: "2026-08-01", close: "180.00" },
      { date: "2026-09-01", close: "198.20" },
    ],
    ...overrides,
  };
}

function watchlist(rows: readonly WatchlistRow[], preset = "1Y"): WatchlistResponse {
  return {
    asOfDate: "2026-09-10",
    window: { preset, from: "2025-09-10", to: "2026-09-10" },
    rows,
  };
}

function renderView(
  options: { readonly window?: string; readonly onWindowChange?: (next: string) => void } = {},
): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <WatchlistView
          window={options.window ?? "1Y"}
          onWindowChange={options.onWindowChange ?? (() => {})}
        />
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/watchlist/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    (
      <Tooltip.Provider>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Tooltip.Provider>
    ) as ReactElement,
  );
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

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
  mocked.fetchWatchlist.mockResolvedValue(watchlist([row()]));
  mocked.fetchWatchedInstrumentIds.mockResolvedValue({ instrumentIds: [APPLE] });
  mocked.searchInstruments.mockResolvedValue([]);
  mocked.fetchCurrencies.mockResolvedValue([]);
});

describe("WatchlistView — the screen's requests", () => {
  it("makes exactly two reads, one of each, and none per row — and no holdings read since then", async () => {
    mocked.fetchWatchlist.mockResolvedValue(
      watchlist([
        row(),
        row({ instrumentId: "22222222-2222-4222-8222-222222222222", displayName: "SAP SE" }),
      ]),
    );

    renderView();
    await waitFor(() => expect(screen.getAllByTestId("watchlist-table-row")).toHaveLength(2));

    // The arithmetic: one request per screen state, never one per row.
    expect(mocked.fetchWatchlist).toHaveBeenCalledTimes(1);
    expect(mocked.fetchWatchedInstrumentIds).toHaveBeenCalledTimes(1);
    // The position block is the analysis screen's now, so the list
    // no longer joins holdings at all.
    expect(mocked.fetchHoldings).not.toHaveBeenCalled();
    // …and no analysis panel is mounted under the list any more.
    expect(screen.queryByTestId("watchlist-analysis")).not.toBeInTheDocument();
    // FR-357/FR-362: the sparklines are fed from the embedded series, so no
    // price read happens at all — the fan-out `<InstrumentPriceSparkline>`
    // would have caused (up to 4 per row) is absent.
    expect(mocked.listInstrumentPriceWindow).not.toHaveBeenCalled();
    expect(mocked.listInstrumentPrices).not.toHaveBeenCalled();
  });

  it("sends the selected window to the read, and offers exactly the six presets MAX is excluded from", async () => {
    renderView({ window: "3M" });
    await screen.findByTestId("watchlist-table-row");

    expect(mocked.fetchWatchlist.mock.calls[0]?.[0]).toBe("3M");
    // The control's options are the mirrored subset, and `MAX` is not among
    // them: a `MAX` here would either lie about its span or unbound a 200-row
    // read.
    for (const preset of WATCHLIST_WINDOW_PRESET_IDS) {
      expect(screen.getByTestId(`period-option-${preset}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("period-option-MAX")).not.toBeInTheDocument();
    expect(WATCHLIST_WINDOW_PRESET_IDS).toEqual(["3M", "6M", "YTD", "1Y", "3Y", "5Y"]);
  });

  it("hands a window change back to the caller rather than resolving dates itself", async () => {
    const onWindowChange = vi.fn();
    renderView({ onWindowChange });
    await screen.findByTestId("watchlist-table-row");

    fireEvent.click(screen.getByTestId("period-option-6M"));
    expect(onWindowChange).toHaveBeenCalledWith("6M");
  });

  it("mounts exactly one of the table and the card list, never both (F5)", async () => {
    renderView();
    await screen.findByTestId("watchlist-table");
    expect(screen.queryByTestId("watchlist-card-list")).not.toBeInTheDocument();

    // A real unmount, not a DOM removal: the second render must start from an
    // empty container, or `queryByTestId` below would find the first tree's
    // table and pass for the wrong reason.
    cleanup();
    stubMatchMedia(false);
    renderView();
    await screen.findByTestId("watchlist-card-list");
    expect(screen.queryByTestId("watchlist-table")).not.toBeInTheDocument();
  });

  it("reports the read's own refusal in its own panel, with a retry that re-issues it", async () => {
    mocked.fetchWatchlist.mockRejectedValue(
      new ApiError(429, { code: "ADMISSION_BOUND_EXCEEDED" }),
    );

    renderView();
    const error = await screen.findByTestId("watchlist-error");
    expect(error).toHaveAttribute("data-empty-state", "read-throttled");

    const before = mocked.fetchWatchlist.mock.calls.length;
    fireEvent.click(screen.getByTestId("watchlist-error-retry"));
    await waitFor(() => expect(mocked.fetchWatchlist.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("WatchlistView — AC-344's two empty states", () => {
  it("renders `watchlist-empty` with its own copy and an action that opens the add search", async () => {
    mocked.fetchWatchlist.mockResolvedValue(watchlist([]));

    renderView();
    const state = await screen.findByTestId("watchlist-empty");
    expect(state).toHaveAttribute("data-empty-state", "watchlist-empty");
    expect(screen.getByTestId("watchlist-empty-title")).toHaveTextContent(
      EMPTY_STATE_COPY["watchlist-empty"].title,
    );
    // Distinct from the per-row state — AC-344's requirement is that the two
    // read differently, and this is the pair that could have shared copy.
    expect(state.textContent ?? "").not.toContain(EMPTY_STATE_COPY["watchlist-row-no-price"].title);
    // The action is real and reachable: it opens the existing asset-search
    // popover in place, on this screen.
    fireEvent.click(screen.getByTestId("watchlist-empty-add"));
    expect(await screen.findByTestId("watchlist-add-search-search")).toBeInTheDocument();
  });

  it("renders the per-row state, not the empty-list one, for a priceless row", async () => {
    mocked.fetchWatchlist.mockResolvedValue(watchlist([row({ currentPrice: undefined })]));

    renderView();
    expect(await screen.findByTestId("watchlist-row-no-price")).toBeInTheDocument();
    expect(screen.queryByTestId("watchlist-empty")).not.toBeInTheDocument();
  });
});

describe("WatchlistView — the « Ajouter » affordance (UR-50, FR-373)", () => {
  it("watches the instrument the existing popover selected, through POST /watchlist", async () => {
    mocked.searchInstruments.mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "SHARE",
        displayName: "Nestlé",
        listingCurrency: "CHF",
        isin: "CH0038863350",
        exchangeMic: "XSWX",
        symbol: "NESN",
      },
    ]);
    mocked.postWatchlistItem.mockResolvedValue({
      instrumentId: "33333333-3333-4333-8333-333333333333",
      targetPrice: null,
      note: null,
      watchedSince: "2026-09-10",
    });

    renderView();
    await screen.findByTestId("watchlist-table-row");

    fireEvent.click(screen.getByTestId("watchlist-add"));
    fireEvent.change(await screen.findByTestId("watchlist-add-search-search"), {
      target: { value: "nestle" },
    });
    const option = await screen.findByTestId("watchlist-add-search-option", undefined, {
      timeout: 3000,
    });
    fireEvent.click(option);

    await waitFor(() => expect(mocked.postWatchlistItem).toHaveBeenCalledTimes(1));
    expect(mocked.postWatchlistItem.mock.calls[0]?.[0]).toEqual({
      instrumentId: "33333333-3333-4333-8333-333333333333",
    });
    // The write invalidates `["watchlist"]`, so the screen re-reads rather than
    // patching a row in from the acknowledgement.
    await waitFor(() => expect(mocked.fetchWatchlist.mock.calls.length).toBeGreaterThan(1));
  });

  it("surfaces the tenant cap in French, from the mirrored constant", async () => {
    mocked.searchInstruments.mockResolvedValue([
      {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "SHARE",
        displayName: "Nestlé",
        listingCurrency: "CHF",
        isin: null,
        exchangeMic: null,
        symbol: "NESN",
      },
    ]);
    mocked.postWatchlistItem.mockRejectedValue(
      new ApiError(429, { code: "WATCHLIST_TENANT_CAP_EXCEEDED" }),
    );

    renderView();
    await screen.findByTestId("watchlist-table-row");
    fireEvent.click(screen.getByTestId("watchlist-add"));
    fireEvent.change(await screen.findByTestId("watchlist-add-search-search"), {
      target: { value: "nestle" },
    });
    fireEvent.click(
      await screen.findByTestId("watchlist-add-search-option", undefined, { timeout: 3000 }),
    );

    const alert = await screen.findByTestId("watchlist-add-error");
    expect(alert).toHaveTextContent("200");
    expect(alert).toHaveTextContent("instruments suivis");
  });
});
