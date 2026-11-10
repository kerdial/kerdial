import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as allocationLib from "../lib/allocation.js";
import * as apiClient from "../lib/api-client.js";
import type {
  HoldingResponse,
  HoldingsResponse,
  OverviewResponse,
  PerformanceResponse,
  PortfolioSummary,
} from "../lib/api-client.js";
import { resolvePresetRange } from "../lib/period-presets.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { PORTFOLIO_DETAIL_TABS, PortfolioDetailView } from "./PortfolioDetailView.js";

/**
 * UR-15 (AC90-AC93,
 * AC132-AC135). Renders `PortfolioDetailView` directly (this file's own
 * router-agnostic export) — see that component's own doc comment for why:
 * `PortfolioDetailRoute` (the router-bound wrapper) reads
 * `portfolioDetailRoute.useParams()/.useSearch()/.useNavigate()`, none of
 * which a plain component test can supply without standing up a full
 * `RouterProvider`, exactly the reason `HoldingsRoute.test.tsx` never needed
 * this split (that route has no params/search of its own).
 *
 * UR-42: `HoldingsTable`/`HoldingsCardList` (reused unchanged by this view's
 * own Positions tab) now render a real `<Link>` ("holding-open-instrument"),
 * so both render harnesses below wrap in a *minimal* `RouterProvider` — the
 * same lightweight in-test router `InstrumentTable.test.tsx` establishes —
 * distinct from, and much smaller than, the full app router this file's own
 * header explains it otherwise avoids.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchPortfolios: vi.fn(),
    fetchPortfolioOverview: vi.fn(),
    fetchPortfolioHoldings: vi.fn(),
    fetchPortfolioPerformance: vi.fn(),
    // Spied (never actually called by this component) so AC90/AC91's
    // negative assertion — the workspace uses the scoped `:id/*` reads,
    // never the combined ones — has something to assert against.
    fetchOverview: vi.fn(),
    fetchHoldings: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    listInstrumentPrices: vi.fn(),
    // CA-19: the « Espèces » tab's only read, plus the two cash-account
    // writes its dialogs make.
    fetchPortfolioCash: vi.fn(),
    createCashAccount: vi.fn(),
    patchCashAccount: vi.fn(),
    fetchCurrencies: vi.fn(),
    // `portfolio-details` PD-T11: the header's `onIconWritten` seam is driven
    // through the real edit dialog, so the one write that seam hangs off has
    // to be mockable.
    deletePortfolioIcon: vi.fn(),
  };
});

vi.mock("../lib/allocation.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/allocation.js")>("../lib/allocation.js");
  return { ...actual, computeAllocation: vi.fn(actual.computeAllocation) };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedAllocation = vi.mocked(allocationLib);

const PORTFOLIO_ID = "11111111-1111-1111-1111-111111111111";

function portfolioSummary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    id: PORTFOLIO_ID,
    name: "Compte principal",
    transactionCount: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    broker: null,
    description: null,
    accentColor: null,
    hasIcon: false,
    archived: false,
    ...overrides,
  };
}

function valuedAmount(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] as const } };
}

function overviewResponse(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    from: "2025-08-15",
    to: "2026-08-15",
    totalValue: valuedAmount("5000.00"),
    unrealizedGainLoss: valuedAmount("500.00"),
    return: {
      twr: { available: false, reason: "insufficient history" },
      mwr: { converged: false, reason: "did not converge" },
    },
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "7",
    portfolioCount: 1,
    ...overrides,
  };
}

function holding(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    kind: "FUND",
    displayName: "Fonds A",
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "10",
    currency: "EUR",
    pmp: valuedAmount("100.00"),
    costBasis: valuedAmount("1000.00"),
    currentPrice: valuedAmount("110.00"),
    currentValue: valuedAmount("1100.00"),
    unrealizedGainLoss: valuedAmount("100.00"),
    realizedGains: [],
    ...overrides,
  };
}

function holdingsResponse(overrides: Partial<HoldingsResponse> = {}): HoldingsResponse {
  return {
    asOfDate: "2026-08-15",
    holdings: [holding()],
    totalValue: valuedAmount("1100.00"),
    totalUnrealizedGainLoss: valuedAmount("100.00"),
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "3",
    portfolioCount: 1,
    ...overrides,
  };
}

function performanceResponse(overrides: Partial<PerformanceResponse> = {}): PerformanceResponse {
  return {
    from: "2025-08-15",
    to: "2026-08-15",
    return: {
      twr: {
        available: true,
        cumulative: "0.0842",
        annualised: "0.081",
        rangeDays: 365,
        subPeriodCount: 12,
      },
      mwr: { converged: true, rate: "0.079", method: "newton", iterations: 6 },
    },
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

/** Minimal in-test router, solely so `<Link to="/instruments/$instrumentId">` (UR-42) can resolve `useLinkProps` — see this file's own header. */
function renderWithMinimalRouter(component: () => ReactElement): void {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/", component }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

/**
 * The two window props `PortfolioDetailRoute` normally computes
 * (`rangeSearchControl`). This suite renders the **view**, which does not
 * navigate, so the callbacks are inert and the window is simply `1Y`'s.
 */
const RESOLVED_1Y = resolvePresetRange("1Y");
const NO_CUSTOM = { onOpen: () => {}, onChange: () => {} };

function renderView(overrides: Partial<Parameters<typeof PortfolioDetailView>[0]> = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithMinimalRouter(() => (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={200}>
        <PortfolioDetailView
          portfolioId={PORTFOLIO_ID}
          range="1Y"
          resolvedRange={RESOLVED_1Y}
          custom={NO_CUSTOM}
          tab="overview"
          onRangeChange={() => {}}
          onTabChange={() => {}}
          {...overrides}
        />
      </Tooltip.Provider>
    </QueryClientProvider>
  ));
}

/** As {@link renderView}, but hands the `QueryClient` back so a test can spy on its invalidation calls (CA-19's assertion — "by spying on the query client, not by re-fetch timing"). */
function renderViewWithClient(overrides: Partial<Parameters<typeof PortfolioDetailView>[0]> = {}): {
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithMinimalRouter(() => (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={200}>
        <PortfolioDetailView
          portfolioId={PORTFOLIO_ID}
          range="1Y"
          resolvedRange={RESOLVED_1Y}
          custom={NO_CUSTOM}
          tab="overview"
          onRangeChange={() => {}}
          onTabChange={() => {}}
          {...overrides}
        />
      </Tooltip.Provider>
    </QueryClientProvider>
  ));
  return { queryClient };
}

/** Interactive re-render harness: lets a test actually click a tab button and observe the resulting panel, mirroring how `PortfolioDetailRoute` wires `tab`/`onTabChange` together via the router. */
function renderInteractive(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [tab, setTab] = useState<Parameters<typeof PortfolioDetailView>[0]["tab"]>("overview");
    return (
      <PortfolioDetailView
        portfolioId={PORTFOLIO_ID}
        range="1Y"
        resolvedRange={RESOLVED_1Y}
        custom={NO_CUSTOM}
        tab={tab}
        onRangeChange={() => {}}
        onTabChange={setTab}
      />
    );
  }
  renderWithMinimalRouter(() => (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={200}>
        <Harness />
      </Tooltip.Provider>
    </QueryClientProvider>
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(false);
  mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
    status: "NONE",
    requestedFrom: null,
    earliestBackfilledDate: null,
    latestBackfilledDate: null,
    lastQuoteAt: null,
    latestPriceDate: null,
  });
  mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
  mockedApiClient.fetchPortfolios.mockResolvedValue([portfolioSummary()]);
  mockedApiClient.fetchPortfolioOverview.mockResolvedValue(overviewResponse());
  mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(holdingsResponse());
  mockedApiClient.fetchPortfolioPerformance.mockResolvedValue(performanceResponse());
  mockedApiClient.fetchPortfolioCash.mockResolvedValue(cashResponse());
  mockedApiClient.fetchCurrencies.mockResolvedValue([]);
});

/**
 * CA-19 — the fifth tab, « Espèces » (FR-160/FR-161, AC-183's UI half).
 *
 * The fixture is deliberately one that would expose RC4 (*"an archived
 * account with a non-zero balance is excluded from the total by a
 * well-meaning filter, and money silently vanishes"*): three EUR accounts,
 * one of them negative, one of them archived-with-a-balance, plus a USD
 * account so the per-currency split has something to keep apart.
 */
const ACTIVE_EUR_ID = "aaaa1111-1111-4111-8111-111111111111";
const NEGATIVE_EUR_ID = "aaaa2222-2222-4222-8222-222222222222";
const ARCHIVED_EUR_ID = "aaaa3333-3333-4333-8333-333333333333";
const USD_ID = "aaaa4444-4444-4444-8444-444444444444";

function cashResponse(
  overrides: Partial<apiClient.PortfolioCashResponse> = {},
): apiClient.PortfolioCashResponse {
  return {
    accounts: [
      {
        id: ACTIVE_EUR_ID,
        name: "Compte courant",
        currency: "EUR",
        archived: false,
        balance: "1000.00",
        isNegative: false,
      },
      {
        id: NEGATIVE_EUR_ID,
        name: "Compte à découvert",
        currency: "EUR",
        archived: false,
        balance: "-50.00",
        isNegative: true,
      },
      {
        id: ARCHIVED_EUR_ID,
        name: "Ancien compte",
        currency: "EUR",
        archived: true,
        balance: "12.00",
        isNegative: false,
      },
      {
        id: USD_ID,
        name: "Compte USD",
        currency: "USD",
        archived: false,
        balance: "250.00",
        isNegative: false,
      },
    ],
    // The server's own rollups. 1000.00 - 50.00 + 12.00 = 962.00 — the
    // archived account's balance is *in* the EUR total, which is the figure
    // RC4 says a presentation filter must not be able to change.
    byCurrency: [
      { currency: "EUR", total: "962.00", accountCount: 3, isNegative: false },
      { currency: "USD", total: "250.00", accountCount: 1, isNegative: false },
    ],
    calcEpoch: "11",
    ...overrides,
  };
}

describe("<PortfolioDetailView> — AC90/AC91: scoped reads, not the combined ones", () => {
  it("renders the workspace name from the cached portfolios list and its own :id/overview figures", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal"),
    );
    expect(screen.getByTestId("portfolio-detail-total-value")).toHaveTextContent("5 000.00 EUR");
    expect(screen.getByTestId("portfolio-detail-unrealized")).toHaveTextContent("500.00 EUR");

    // AC91: the scoped `:id/*` wrappers were called, never the combined ones.
    expect(mockedApiClient.fetchPortfolioOverview).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      expect.anything(),
      expect.anything(),
    );
    expect(mockedApiClient.fetchPortfolioHoldings).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      expect.anything(),
    );
    expect(mockedApiClient.fetchOverview).not.toHaveBeenCalled();
    expect(mockedApiClient.fetchHoldings).not.toHaveBeenCalled();
  });
});

describe("<PortfolioDetailView> — AC132: total cost basis summed client-side from every holding's own costBasis", () => {
  it("sums costBasis.amount across holdings, never a re-derived or server-supplied total", async () => {
    mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          holding({ instrumentId: "a", costBasis: valuedAmount("600.00") }),
          holding({ instrumentId: "b", costBasis: valuedAmount("400.00") }),
        ],
        totalValue: valuedAmount("1000.00"),
      }),
    );
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-cost-basis")).toHaveTextContent("1 000.00 EUR"),
    );
  });

  it("renders — (never a wrong figure) when one holding's costBasis fails to parse, but still sums the others", async () => {
    mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(
      holdingsResponse({
        holdings: [
          holding({ instrumentId: "a", costBasis: valuedAmount("600.00") }),
          holding({ instrumentId: "b", costBasis: valuedAmount("not-a-number") }),
        ],
        totalValue: valuedAmount("1000.00"),
      }),
    );
    renderView();
    // sumDecimalAmounts (positions.ts) treats an unparseable row as a zero
    // contribution rather than blanking the whole total — the same
    // defensive stance AC125's identical helper already takes on the
    // Positions screen; this workspace reuses that helper unchanged.
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-cost-basis")).toHaveTextContent("600.00 EUR"),
    );
  });
});

// (owner, option 1) supersedes AC135's "verbatim": the code
// picks a French line, the English reason sits behind the hint.
describe("<PortfolioDetailView> — TWR/MWR unavailable read as French lines", () => {
  it("maps the reason codes to French and keeps the English diagnostic out of the figure", async () => {
    mockedApiClient.fetchPortfolioOverview.mockResolvedValue(
      overviewResponse({
        return: {
          twr: {
            available: false,
            reasonCode: "ZERO_INVESTED_BASE",
            reason: "TWR sub-period starting 2025-10-16 has an invested base of zero",
          },
          mwr: {
            converged: false,
            reasonCode: "NO_ROOT_IN_BRACKET",
            reason: "NPV has the same sign",
          },
        },
      }),
    );
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-twr-unavailable")).toHaveTextContent(
        "Non calculable : aucun capital investi",
      ),
    );
    const mwr = screen.getByTestId("portfolio-detail-mwr-unavailable");
    expect(mwr).toHaveTextContent("Non calculable pour ces flux");
    expect(mwr.textContent ?? "").not.toContain("NPV");
  });
});

describe("<PortfolioDetailView> — freshness copy carries no wall-clock recalculation claim", () => {
  it("renders the fetch time, no 'Version <calcEpoch>', and never the word 'recalcul'", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-freshness")).toHaveTextContent(
        "Données récupérées à",
      ),
    );
    // The response's own `calcEpoch` is "3" in this fixture and no surface
    // renders it since 2026-09-08. Asserted on the *label*, not on the digit:
    // a fetch clock legitimately contains digits of its own.
    expect(screen.getByTestId("portfolio-detail-freshness").textContent ?? "").not.toMatch(
      /version/i,
    );
    // The fetched-at clock (if present) is explicitly the *fetch* time, not
    // a claimed *recalculation* time — this assertion is the negative half:
    // the word "recalcul" never appears anywhere in this component's output.
    expect(document.body).not.toHaveTextContent(/recalcul/i);
  });
});

describe("<PortfolioDetailView> — « Liquidités » (portfolio-cash FR-689, AC-579, AC-580)", () => {
  const cash = {
    totalBase: "975.00",
    currency: "EUR",
    isNegative: false,
    unconverted: [],
    byCurrency: [],
  };

  it("AC-580: the stat strip states the cash inside the total, and the Aperçu tab's allocation carries its share", async () => {
    mockedApiClient.fetchPortfolioOverview.mockResolvedValue(
      overviewResponse({ totalValue: valuedAmount("2075.00"), cash }),
    );
    mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(
      holdingsResponse({ totalValue: valuedAmount("2075.00"), cash }),
    );
    renderView({ tab: "overview" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-cash")).toHaveTextContent("975.00 EUR"),
    );
    expect(screen.getByTestId("portfolio-detail-cash")).toHaveTextContent("Liquidités");
    expect(screen.getByTestId("portfolio-detail-total-value")).toHaveTextContent("2 075.00 EUR");
    // 1100 of the fund and 975 of cash over 2075: 53.01 % and 46.99 %.
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-tab-panel-overview")).toHaveTextContent(
        "Liquidités46.99%",
      ),
    );
  });

  it("AC-579: a cash-only portfolio shows its balance, and the Positions tab still points to « Espèces »", async () => {
    mockedApiClient.fetchPortfolioOverview.mockResolvedValue(
      overviewResponse({ totalValue: valuedAmount("975.00"), cash }),
    );
    mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(
      holdingsResponse({ holdings: [], totalValue: valuedAmount("975.00"), cash }),
    );
    renderView({ tab: "positions" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-total-value")).toHaveTextContent("975.00 EUR"),
    );
    expect(screen.getByTestId("portfolio-detail-cash")).toHaveTextContent("975.00 EUR");
    expect(await screen.findByTestId("portfolio-detail-positions-empty")).toHaveTextContent(
      "« Espèces »",
    );
  });
});

describe("<PortfolioDetailView> — Positions tab reuses HoldingsTable/HoldingsCardList + computeAllocation, never a second path", () => {
  it("mounts the shared card list (mobile) with the scoped holdings and calls computeAllocation once", async () => {
    renderView({ tab: "positions" });
    await waitFor(() => expect(screen.getByTestId("holdings-card-list")).toBeInTheDocument());
    expect(screen.getByTestId("holding-display-name")).toHaveTextContent("Fonds A");
    expect(mockedAllocation.computeAllocation).toHaveBeenCalledTimes(1);
  });

  it("shows a purposeful empty state, never an empty container, when the portfolio has no holdings", async () => {
    mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(
      holdingsResponse({ holdings: [], totalValue: valuedAmount("0.00") }),
    );
    renderView({ tab: "positions" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-positions-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("holdings-card-list")).not.toBeInTheDocument();
  });
});

describe("<PortfolioDetailView> — Activité tab: real content (transaction count), link wired to /activity (SLICE 4)", () => {
  it("shows the cached transactionCount and a working link to /activity?portfolio=:id", async () => {
    renderView({ tab: "activity" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-transaction-count")).toHaveTextContent("3"),
    );
    const link = screen.getByTestId("portfolio-detail-activity-link");
    expect(link).not.toBeDisabled();
    expect(link).toHaveAttribute("href", `/activity?portfolio=${PORTFOLIO_ID}`);
  });

  it("shows an explicit empty state (not the count panel) when transactionCount is zero", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([portfolioSummary({ transactionCount: 0 })]);
    renderView({ tab: "activity" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-activity-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("portfolio-detail-transaction-count")).not.toBeInTheDocument();
  });
});

describe("<PortfolioDetailView> — Performance tab: TWR/MWR internals", () => {
  it("renders cumulative/annualised/rangeDays/subPeriodCount and rate/method/iterations", async () => {
    renderView({ tab: "performance" });
    await waitFor(() =>
      expect(screen.getByTestId("performance-twr-range-days")).toHaveTextContent("365"),
    );
    expect(screen.getByTestId("performance-twr-sub-period-count")).toHaveTextContent("12");
    expect(screen.getByTestId("performance-mwr-method")).toHaveTextContent("newton");
    expect(screen.getByTestId("performance-mwr-iterations")).toHaveTextContent("6");
  });
});

describe("<PortfolioDetailView> — AC134: a 422 on one panel leaves the others rendered", () => {
  it("a failing :id/performance read does not blank the overview tab's own figures", async () => {
    mockedApiClient.fetchPortfolioPerformance.mockRejectedValue(
      new apiClient.ApiError(422, { code: "VALUATION_FX_RATE_UNAVAILABLE", detail: "n/a" }),
    );
    renderView({ tab: "overview" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-total-value")).toHaveTextContent("5 000.00 EUR"),
    );
  });

  it("switching to the Performance tab shows its own error without affecting the already-rendered header", async () => {
    mockedApiClient.fetchPortfolioPerformance.mockRejectedValue(
      new apiClient.ApiError(422, { code: "VALUATION_FX_RATE_UNAVAILABLE", detail: "n/a" }),
    );
    renderInteractive();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal"),
    );
    fireEvent.click(screen.getByTestId("portfolio-detail-tab-performance"));
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-performance-error")).toBeInTheDocument(),
    );
    // The header (fed by the *overview* query, unaffected by performance's
    // own failure) is still fully rendered.
    expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal");
  });

  it("a failing holdings read leaves the overview figures (fed by a different query) rendered", async () => {
    mockedApiClient.fetchPortfolioHoldings.mockRejectedValue(
      new apiClient.ApiError(422, { code: "VALUATION_RESPONSE_TOO_LARGE", detail: "n/a" }),
    );
    renderView({ tab: "overview" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-total-value")).toHaveTextContent("5 000.00 EUR"),
    );
    expect(screen.getByTestId("portfolio-detail-holdings-error")).toBeInTheDocument();
  });
});

describe("<PortfolioDetailView> — errors go through messageForError, never inline/server copy", () => {
  it("a 422 on :id/overview renders its dedicated French message, never the server's own English detail", async () => {
    mockedApiClient.fetchPortfolioOverview.mockRejectedValue(
      new apiClient.ApiError(422, {
        code: "VALUATION_PRICE_UNAVAILABLE",
        detail: "no price on or before date",
      }),
    );
    renderView({ tab: "overview" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-overview-error")).toHaveTextContent(
        /prix nécessaire à cette valorisation/,
      ),
    );
    expect(screen.getByTestId("portfolio-detail-overview-error")).not.toHaveTextContent(
      "no price on or before date",
    );
  });

  it("a 400 date-range rejection (e.g. DATE_RANGE_TOO_WIDE) still renders through messageForError, not a raw dump", async () => {
    mockedApiClient.fetchPortfolioPerformance.mockRejectedValue(
      new apiClient.ApiError(400, { code: "DATE_RANGE_TOO_WIDE", detail: "span too wide" }),
    );
    renderView({ tab: "performance" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-performance-error")).toHaveTextContent(
        /période sélectionnée est trop étendue/,
      ),
    );
  });
});

describe("<PortfolioDetailView> — AC93: deep link to a nonexistent portfolio", () => {
  it("renders 'Portefeuille introuvable' with a working link back, never a crash or blank screen", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([]);
    mockedApiClient.fetchPortfolioOverview.mockRejectedValue(
      new apiClient.ApiError(404, { code: "PORTFOLIO_NOT_FOUND", detail: "n/a" }),
    );
    mockedApiClient.fetchPortfolioHoldings.mockRejectedValue(
      new apiClient.ApiError(404, { code: "PORTFOLIO_NOT_FOUND", detail: "n/a" }),
    );
    mockedApiClient.fetchPortfolioPerformance.mockRejectedValue(
      new apiClient.ApiError(404, { code: "PORTFOLIO_NOT_FOUND", detail: "n/a" }),
    );
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-not-found")).toBeInTheDocument(),
    );
    expect(screen.getByText("Retour aux portefeuilles")).toBeInTheDocument();
  });
});

describe("<PortfolioDetailView> — rename/delete reachable from the workspace, reusing the existing dialogs unchanged", () => {
  it("opens the same PortfolioFormDialog (rename mode) the list uses", async () => {
    renderView();
    // Waits for the *resolved* name, not merely the element's presence: the
    // heading renders a "…" placeholder from the very first paint (before
    // `fetchPortfolios` resolves), and the rename/delete buttons are
    // `disabled` until `portfolio` itself resolves — clicking too early
    // would silently no-op on a disabled button.
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal"),
    );
    fireEvent.click(screen.getByTestId("portfolio-detail-rename-button"));
    expect(await screen.findByTestId("portfolio-form-dialog")).toBeVisible();
  });

  it("opens the same PortfolioDeleteDialog the list uses", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal"),
    );
    fireEvent.click(screen.getByTestId("portfolio-detail-delete-button"));
    expect(await screen.findByTestId("portfolio-delete-dialog")).toBeVisible();
  });
});

describe("<PortfolioDetailView> — CA-19: the fifth tab, « Espèces »", () => {
  it("PORTFOLIO_DETAIL_TABS gains exactly one entry, and the label is « Espèces »", async () => {
    expect(PORTFOLIO_DETAIL_TABS).toEqual([
      "overview",
      "positions",
      "activity",
      "performance",
      "cash",
    ]);
    renderView({ tab: "cash" });
    expect(await screen.findByTestId("portfolio-detail-tab-cash")).toHaveTextContent("Espèces");
  });

  it("renders real content — per-account rows grouped by currency, with the server's own per-currency totals", async () => {
    renderView({ tab: "cash" });

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-tab-panel-cash")).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getAllByTestId("cash-currency-group")).toHaveLength(2));

    const totals = screen.getAllByTestId("cash-currency-total");
    // AC-180's own rule, at the UI: EUR and USD are separate figures, never
    // summed together. Both are asserted, so the split cannot pass by there
    // being only one.
    expect(totals[0]).toHaveTextContent("962.00 EUR");
    expect(totals[1]).toHaveTextContent("250.00 USD");
  });

  it("RC4 — the archived account's balance is in the per-currency total, and the total is the server's figure, not a re-sum of the visible rows", async () => {
    renderView({ tab: "cash" });
    await waitFor(() => expect(screen.getAllByTestId("cash-currency-group")).toHaveLength(2));

    // The two *visible* active EUR rows sum to 950.00. The rendered total is
    // 962.00 — i.e. it includes the archived account's 12.00, which is the
    // only way this assertion can pass and the exact money-vanishes failure
    // RC4 names.
    const eurTotal = screen.getAllByTestId("cash-currency-total")[0];
    expect(eurTotal).toHaveTextContent("962.00 EUR");
    expect(eurTotal).not.toHaveTextContent("950.00");
    // …and the count says so out loud rather than leaving a reader to wonder
    // why three accounts produce two rows.
    expect(screen.getAllByTestId("cash-currency-account-count")[0]).toHaveTextContent(
      "3 comptes dans ce total, comptes archivés inclus.",
    );
  });

  it("AC-183 (UI half) — the negative account renders with a distinct treatment and a positive sibling in the same view does not", async () => {
    renderView({ tab: "cash" });
    await waitFor(() =>
      expect(screen.getAllByTestId("cash-account-row").length).toBeGreaterThan(0),
    );

    const rows = screen.getAllByTestId("cash-account-row");
    const negative = rows.find((row) => row.dataset["accountId"] === NEGATIVE_EUR_ID);
    const positive = rows.find((row) => row.dataset["accountId"] === ACTIVE_EUR_ID);

    // Both in the same render pass — that pairing is what proves the
    // treatment is per account rather than global.
    expect(negative?.dataset["negative"]).toBe("true");
    expect(positive?.dataset["negative"]).toBe("false");
    expect(negative?.querySelector('[data-testid="cash-account-negative-badge"]')).not.toBeNull();
    expect(positive?.querySelector('[data-testid="cash-account-negative-badge"]')).toBeNull();
    expect(negative?.querySelector('[data-testid="cash-account-balance"]')?.className).toContain(
      "k-pf-loss",
    );
    expect(
      positive?.querySelector('[data-testid="cash-account-balance"]')?.className,
    ).not.toContain("k-pf-loss");
  });

  it("archived accounts sit in a visibly separate, collapsed group — never mixed into a currency group's rows", async () => {
    renderView({ tab: "cash" });
    await waitFor(() => expect(screen.getByTestId("cash-archived-group")).toBeInTheDocument());

    // Collapsed: the archived row is genuinely not mounted (a conditional
    // mount, not a CSS hide — see the tab component's own note on the
    // `<details>` hazard).
    const visibleIds = screen
      .getAllByTestId("cash-account-row")
      .map((row) => row.dataset["accountId"]);
    expect(visibleIds).toContain(ACTIVE_EUR_ID);
    expect(visibleIds).not.toContain(ARCHIVED_EUR_ID);

    fireEvent.click(screen.getByTestId("cash-archived-toggle"));

    const expandedRow = screen
      .getAllByTestId("cash-account-row")
      .find((row) => row.dataset["accountId"] === ARCHIVED_EUR_ID);
    expect(expandedRow).toBeDefined();
    expect(expandedRow?.dataset["archived"]).toBe("true");
    expect(
      expandedRow?.querySelector('[data-testid="cash-account-archived-badge"]'),
    ).not.toBeNull();
    // The group says plainly that the balance still counts, so a user reading
    // only this panel is not left to infer that archiving hid money.
    expect(screen.getByTestId("cash-archived-explanation")).toHaveTextContent(/solde reste compté/);
  });

  it("a portfolio with no cash account renders a real create affordance, never an empty container", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(
      cashResponse({ accounts: [], byCurrency: [] }),
    );
    renderView({ tab: "cash" });

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-cash-empty")).toBeInTheDocument(),
    );
    // The affordance is a working button that opens the real dialog — the bar
    // `PortfolioDetailView.tsx`'s own doc comment sets for every tab.
    fireEvent.click(screen.getByTestId("cash-account-create-button"));
    expect(await screen.findByTestId("cash-account-form-dialog")).toBeVisible();
    expect(screen.getByTestId("cash-account-name-input")).toBeInTheDocument();
  });

  it("renaming a cash account triggers the cash-only invalidation, never the full derived set", async () => {
    mockedApiClient.patchCashAccount.mockResolvedValue({
      id: ACTIVE_EUR_ID,
      name: "Compte renommé",
      currency: "EUR",
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const { queryClient } = renderViewWithClient({ tab: "cash" });
    await waitFor(() =>
      expect(screen.getAllByTestId("cash-account-row").length).toBeGreaterThan(0),
    );

    const row = screen
      .getAllByTestId("cash-account-row")
      .find((r) => r.dataset["accountId"] === ACTIVE_EUR_ID)!;
    fireEvent.click(row.querySelector('[data-testid="cash-account-rename-button"]')!);
    expect(await screen.findByTestId("cash-account-form-dialog")).toBeVisible();

    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.change(screen.getByTestId("cash-account-name-input"), {
      target: { value: "Compte renommé" },
    });
    fireEvent.submit(screen.getByTestId("cash-account-form"));

    await waitFor(() =>
      expect(mockedApiClient.patchCashAccount).toHaveBeenCalledWith(PORTFOLIO_ID, ACTIVE_EUR_ID, {
        name: "Compte renommé",
      }),
    );
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    const invalidated = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidated).toEqual([["portfolios", "cash", PORTFOLIO_ID]]);
    expect(invalidated).not.toContainEqual(["portfolios", "overview"]);
    expect(invalidated).not.toContainEqual(["portfolios", "holdings"]);
  });

  it("archiving sends { archived: true } and un-archiving sends { archived: false } — one field per request", async () => {
    mockedApiClient.patchCashAccount.mockResolvedValue({
      id: ACTIVE_EUR_ID,
      name: "Compte courant",
      currency: "EUR",
      archived: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    renderView({ tab: "cash" });
    await waitFor(() =>
      expect(screen.getAllByTestId("cash-account-row").length).toBeGreaterThan(0),
    );

    const row = screen
      .getAllByTestId("cash-account-row")
      .find((r) => r.dataset["accountId"] === ACTIVE_EUR_ID)!;
    fireEvent.click(row.querySelector('[data-testid="cash-account-archive-button"]')!);
    expect(await screen.findByTestId("cash-account-archive-dialog")).toBeVisible();
    // The copy names what survives — archiving destroys nothing (OD-5(c)).
    expect(screen.getByTestId("cash-account-archive-explanation")).toHaveTextContent(
      /écritures sont conservées/,
    );
    fireEvent.click(screen.getByTestId("cash-account-archive-confirm"));

    await waitFor(() =>
      expect(mockedApiClient.patchCashAccount).toHaveBeenCalledWith(PORTFOLIO_ID, ACTIVE_EUR_ID, {
        archived: true,
      }),
    );

    // The other direction, from the archived group.
    fireEvent.click(screen.getByTestId("cash-archived-toggle"));
    const archivedRow = screen
      .getAllByTestId("cash-account-row")
      .find((r) => r.dataset["accountId"] === ARCHIVED_EUR_ID)!;
    fireEvent.click(archivedRow.querySelector('[data-testid="cash-account-archive-button"]')!);
    expect(await screen.findByTestId("cash-account-archive-dialog")).toBeVisible();
    fireEvent.click(screen.getByTestId("cash-account-archive-confirm"));

    await waitFor(() =>
      expect(mockedApiClient.patchCashAccount).toHaveBeenCalledWith(PORTFOLIO_ID, ARCHIVED_EUR_ID, {
        archived: false,
      }),
    );
  });

  /**
   * OD-4(d), asserted as a test rather than left to review: no string on this
   * tab — nor in any dialog it opens — may imply cash can be moved between
   * accounts. A user with two EUR accounts genuinely cannot do it this cycle.
   *
   * OD-5(c) gets the same treatment: archive is the only lifecycle action, and
   * there is no `DELETE` route for a "Supprimer" button to call.
   */
  it("no copy anywhere on this tab implies a transfer (OD-4) or a delete (OD-5)", async () => {
    renderView({ tab: "cash" });
    await waitFor(() =>
      expect(screen.getAllByTestId("cash-account-row").length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByTestId("cash-archived-toggle"));

    const panel = screen.getByTestId("portfolio-detail-tab-panel-cash");
    const text = panel.textContent ?? "";
    // Positive companion first — the panel really did render its content, so
    // "no match" cannot mean "nothing was scanned".
    expect(text).toContain("Compte courant");
    expect(text).toContain("Ancien compte");
    expect(text).not.toMatch(/transf[ée]r/i);
    expect(text).not.toMatch(/déplacer|deplacer/i);
    expect(text).not.toMatch(/supprimer/i);
    expect(text).not.toMatch(/virement/i);
  });
});

/**
 * The `transférer|déplacer|transfer` grep CA-19 asks for, run over this
 * task's own new/changed source files rather than over rendered output — the
 * two catch different things (a string behind a branch no fixture reaches is
 * invisible to the render assertion above).
 */
describe("CA-19 — OD-4(d) copy constraint, at the source level", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CASH_UI_FILES = [
    "../components/portfolio-detail/PortfolioDetailCashTab.tsx",
    "../components/CashAccountFormDialog.tsx",
    "../components/CashAccountArchiveDialog.tsx",
    "../components/CashAccountPicker.tsx",
  ].map((relativePath) => join(here, relativePath));

  /** Comments are stripped first: these files' own doc comments necessarily *name* the forbidden capability in order to explain why it is forbidden — the same discrimination `empty-state-copy-audit.test.ts` documents. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("finds zero transfer/move wording in their rendered strings", () => {
    for (const file of CASH_UI_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      // Positive companion first — the stripped file really is one of the
      // cash UI files, so "no match" cannot mean "nothing was scanned".
      expect(stripped, `${file} must be a cash UI file`).toContain("CashAccount");
      expect(stripped, `${file} must not imply a transfer`).not.toMatch(
        /transf[ée]r|déplacer|deplacer/i,
      );
    }
  });

  it("finds no delete affordance either — OD-5 is archive-only, and there is no route to call", () => {
    for (const file of CASH_UI_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      expect(stripped, `${file} must not offer a delete`).not.toMatch(/Supprimer/);
      expect(stripped, `${file} must not call a delete endpoint`).not.toMatch(/deleteCashAccount/);
    }
  });
});

describe("<PortfolioDetailView> — portfolio-details: the workspace header's tile, broker line and description", () => {
  it("renders the wallet fallback and no <img> for a portfolio with none of the four fields set (G2, FR-469)", async () => {
    renderView();

    const box = await screen.findByTestId("portfolio-icon-box");
    expect(box).toHaveClass("k-pf-tile");
    expect(screen.queryByTestId("portfolio-icon-image")).toBeNull();
    expect(box.getAttribute("data-accent")).toBeNull();
    expect(box.getAttribute("style")).toBeNull();
    expect(screen.queryByTestId("portfolio-detail-broker")).toBeNull();
    expect(screen.queryByTestId("portfolio-detail-description")).toBeNull();
  });

  it("FR-469/FR-470/FR-471 — an iconed portfolio renders its bytes, its broker line and — here only — its description", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      portfolioSummary({
        hasIcon: true,
        broker: "Boursorama",
        description: "Le PEA de long terme.\nDeuxième ligne.",
        accentColor: "CHART_1",
      }),
    ]);

    renderView();

    const img = await screen.findByTestId("portfolio-icon-image");
    expect(img).toHaveAttribute("src", `/api/v1/portfolios/${PORTFOLIO_ID}/icon`);
    expect(screen.getByTestId("portfolio-detail-broker")).toHaveTextContent("Boursorama");
    expect(screen.getByTestId("portfolio-detail-description")).toHaveTextContent(
      "Le PEA de long terme.",
    );
    expect(screen.getByTestId("portfolio-icon-box")).toHaveAttribute("data-accent", "CHART_1");
    // The standing property, unchanged by the new header block: the
    // heading is the name and nothing else.
    expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal");
  });

  it("AC-408 — the detail heading's accessible name is string-identical with and without an icon, and the tile box does not move", async () => {
    // One literal, asserted against **both** branches in the same run.
    const ACCESSIBLE_NAME = "Compte principal";

    renderView();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent(ACCESSIBLE_NAME),
    );
    const bare = screen.getByTestId("portfolio-detail-name");
    expect(bare).toHaveAccessibleName(ACCESSIBLE_NAME);
    expect(screen.getByRole("heading", { level: 1, name: ACCESSIBLE_NAME })).toBe(bare);
    const bareBoxClass = screen.getByTestId("portfolio-icon-box").className;
    cleanup();

    mockedApiClient.fetchPortfolios.mockResolvedValue([
      portfolioSummary({
        hasIcon: true,
        broker: "Boursorama",
        description: "Le PEA de long terme.",
        accentColor: "CHART_1",
      }),
    ]);
    renderView();
    const dressed = await screen.findByTestId("portfolio-icon-image");
    const heading = screen.getByTestId("portfolio-detail-name");

    // The tile, the broker line and the description are all rendered in this
    // branch, and none of them joins the heading's name: the tile is
    // `aria-hidden`, and the other two are siblings of the heading, not
    // content of it — the header's existing pattern (`BaseCurrencyBadge` sits
    // beside the `<h1>` too), matched rather than replaced. An exact-match
    // role query would fail if any of the three had joined.
    expect(heading).toHaveAccessibleName(ACCESSIBLE_NAME);
    expect(screen.getByRole("heading", { level: 1, name: ACCESSIBLE_NAME })).toBe(heading);
    expect(screen.getByTestId("portfolio-detail-broker")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-detail-description")).toBeInTheDocument();

    // No layout shift between the branches: the same `.k-pf-tile` box hosts
    // both, and the `<img>` carries that box's own intrinsic size.
    expect(screen.getByTestId("portfolio-icon-box").className).toBe(bareBoxClass);
    expect(dressed).toHaveAttribute("width", "44");
    expect(dressed).toHaveAttribute("height", "44");
  });

  it("the header's edit button is labelled « Modifier », not « Renommer »", async () => {
    renderView();

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal"),
    );
    expect(screen.getByTestId("portfolio-detail-rename-button")).toHaveTextContent("Modifier");
    expect(screen.getByTestId("portfolio-detail-rename-button")).not.toHaveTextContent("Renommer");
  });

  it("a successful icon write bumps this header's iconVersion, which is what re-requests the bytes", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([portfolioSummary({ hasIcon: true })]);
    mockedApiClient.deletePortfolioIcon.mockResolvedValue(undefined);

    renderView();

    // Make the bump *observable*: `PortfolioIconTile` remembers a load failure
    // keyed `${portfolioId}@${iconVersion}`, so a tile that has failed comes
    // back **only** if the version actually moved. Without the seam wired the
    // `<img>` would stay gone — and in a real browser the same missing bump is
    // what leaves replaced bytes stale (`no-store` governs caches, not a
    // mounted element's already-decoded bitmap).
    fireEvent.error(await screen.findByTestId("portfolio-icon-image"));
    expect(screen.queryByTestId("portfolio-icon-image")).toBeNull();

    fireEvent.click(screen.getByTestId("portfolio-detail-rename-button"));
    await screen.findByTestId("portfolio-form-dialog");
    fireEvent.click(screen.getByTestId("portfolio-icon-remove"));
    fireEvent.click(screen.getByTestId("portfolio-name-form-submit"));

    await waitFor(() =>
      expect(mockedApiClient.deletePortfolioIcon).toHaveBeenCalledWith(PORTFOLIO_ID),
    );
    expect(await screen.findByTestId("portfolio-icon-image")).toBeInTheDocument();
  });
});

/**
 * portfolio-archive FR-598/FR-599, AC-489/AC-490.
 *
 * `setPortfolioArchived` is the **real** client call here (the module mock
 * spreads the actual exports and does not replace it), so every request it
 * makes reaches the recorded `fetch` below — the count and the body asserted
 * are what would go on the wire, not what a mock was called with. Every other
 * read on this screen is a mocked function, so the recorder sees only writes.
 */
describe("<PortfolioDetailView> — portfolio-archive: badge, archive dialog, immediate un-archive", () => {
  interface RecordedRequest {
    readonly url: string;
    readonly method: string;
    readonly body: string | undefined;
  }
  let requests: RecordedRequest[];

  /** Records each request; a PATCH flips what the next list read returns, as the server would. */
  function stubRecordingFetch(): void {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url: String(input), method: init?.method ?? "GET", body });
        const archived = (JSON.parse(body ?? "{}") as { archived?: boolean }).archived === true;
        const next = portfolioSummary({ archived });
        mockedApiClient.fetchPortfolios.mockResolvedValue([next]);
        return Promise.resolve(
          new Response(JSON.stringify(next), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
  }

  beforeEach(stubRecordingFetch);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC-490 — archive opens the dialog; cancel sends nothing; confirm sends one PATCH {archived:true}, list key only, and the page shows the archived state", async () => {
    const { queryClient } = renderViewWithClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent("Compte principal"),
    );
    expect(screen.queryByTestId("portfolio-detail-archived-badge")).toBeNull();
    const archiveButton = screen.getByTestId("portfolio-detail-archive-button");
    expect(archiveButton).toHaveTextContent("Archiver le portefeuille");

    fireEvent.click(archiveButton);
    const dialog = await screen.findByTestId("portfolio-archive-dialog");
    // FR-599: the dialog states the portfolio stays in every figure.
    expect(screen.getByTestId("portfolio-archive-explanation")).toHaveTextContent(
      "Il reste compté dans tous les totaux",
    );
    expect(dialog).toHaveTextContent("Compte principal");

    fireEvent.click(screen.getByTestId("portfolio-archive-cancel"));
    await waitFor(() => expect(screen.queryByTestId("portfolio-archive-dialog")).toBeNull());
    expect(requests).toEqual([]);

    fireEvent.click(screen.getByTestId("portfolio-detail-archive-button"));
    await screen.findByTestId("portfolio-archive-dialog");
    fireEvent.click(screen.getByTestId("portfolio-archive-confirm"));

    expect(await screen.findByTestId("portfolio-detail-archived-badge")).toHaveTextContent(
      "Archivé",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toMatch(new RegExp(`/portfolios/${PORTFOLIO_ID}$`));
    expect(requests[0]?.body).toBe('{"archived":true}');
    expect(screen.queryByTestId("portfolio-archive-dialog")).toBeNull();
    expect(screen.getByTestId("portfolio-detail-unarchive-button")).toHaveTextContent(
      "Désarchiver",
    );
    // The badge sits beside the heading, never inside it.
    expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent(/^Compte principal$/);
    // PA-L2: the list key only — no figure query is invalidated.
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["portfolios", "list"],
    ]);
  });

  it("AC-489 — an archived portfolio shows the badge and « Désarchiver »; un-archive is immediate and puts it back in the pickers", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValue([portfolioSummary({ archived: true })]);
    const { queryClient } = renderViewWithClient();

    expect(await screen.findByTestId("portfolio-detail-archived-badge")).toHaveTextContent(
      "Archivé",
    );
    expect(screen.getByTestId("portfolio-detail-name")).toHaveTextContent(/^Compte principal$/);
    expect(screen.queryByTestId("portfolio-detail-archive-button")).toBeNull();
    const fetchesBefore = mockedApiClient.fetchPortfolios.mock.calls.length;

    fireEvent.click(screen.getByTestId("portfolio-detail-unarchive-button"));

    await waitFor(() => expect(screen.queryByTestId("portfolio-detail-archived-badge")).toBeNull());
    expect(screen.queryByTestId("portfolio-archive-dialog")).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.body).toBe('{"archived":false}');
    expect(mockedApiClient.fetchPortfolios.mock.calls.length).toBeGreaterThan(fetchesBefore);
    expect(screen.getByTestId("portfolio-detail-archive-button")).toHaveTextContent(
      "Archiver le portefeuille",
    );
    // Back in the cards panel and every picker: both read this refetched list
    // and keep exactly the rows `archived !== true`.
    const refetched = queryClient.getQueryData<PortfolioSummary[]>(["portfolios", "list"]) ?? [];
    expect(refetched.filter((p) => p.archived !== true).map((p) => p.id)).toEqual([PORTFOLIO_ID]);
    expect(portfolioSelectOptions(refetched, "")).toEqual([
      { value: PORTFOLIO_ID, label: "Compte principal" },
    ]);
  });
});
