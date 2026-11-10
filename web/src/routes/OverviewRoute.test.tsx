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
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as allocationLib from "../lib/allocation.js";
import * as apiClient from "../lib/api-client.js";
import type { HoldingResponse, HoldingsResponse, OverviewResponse } from "../lib/api-client.js";
import { OverviewRoute } from "./OverviewRoute.js";

/**
 * IR-16 (AC127) — the one thing
 * only a route-level test can prove: **`computeAllocation` is called exactly
 * once per render pass**, even now that this screen renders three exposure
 * dimensions. The two new breakdowns are derived *beside* that single call
 * (`computeExposureBreakdown` regroups its units), so switching dimensions
 * must not add an apportionment: two independently-apportioned results could
 * round differently and a bucket could then disagree with the rows beneath it.
 *
 * The same spy-not-inspection proof `HoldingsRoute.test.tsx` and
 * `PortfolioDetailRoute.test.tsx` already carry for their own routes — this
 * file is the third, previously missing, leg of it.
 *
 * `../router.js` is mocked with a factory rather than imported: the real module
 * pulls in `AppShell.tsx` -> `virtual:pwa-register/react`, a Vite-only virtual
 * module with no resolver under Vitest (the same reason
 * `InstrumentDetailRoute.test.tsx` renders its router-agnostic view instead).
 * Only the two hooks this route actually calls are stubbed.
 */
vi.mock("../router.js", () => ({
  overviewRoute: {
    useSearch: () => ({ range: "1Y" }),
    useNavigate: () => vi.fn(),
  },
}));

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchOverview: vi.fn(),
    fetchValueSeries: vi.fn(),
    fetchHoldings: vi.fn(),
    fetchPortfolios: vi.fn(),
    listTransactions: vi.fn(),
    fetchInstrument: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    listInstrumentPrices: vi.fn(),
  };
});

vi.mock("../lib/allocation.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/allocation.js")>("../lib/allocation.js");
  return { ...actual, computeAllocation: vi.fn(actual.computeAllocation) };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedAllocation = vi.mocked(allocationLib);

const SECTOR_A = SECTOR_CODES[0];

function valued(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function holding(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    kind: "SHARE",
    displayName: "Air Liquide S.A.",
    symbol: null,
    sectorCode: SECTOR_A,
    domicileCountry: "FR",
    listingCountry: "FR",
    hasIcon: false,
    quantity: "10",
    currency: "EUR",
    pmp: valued("50.00"),
    costBasis: valued("500.00"),
    currentPrice: valued("60.00"),
    currentValue: valued("600.00"),
    unrealizedGainLoss: valued("100.00"),
    realizedGains: [],
    ...overrides,
  };
}

function holdingsResponse(): HoldingsResponse {
  return {
    asOfDate: "2026-08-15",
    holdings: [
      holding(),
      holding({
        instrumentId: "22222222-2222-2222-2222-222222222222",
        kind: "ETF",
        displayName: "MSCI World UCITS ETF",
        sectorCode: null,
        domicileCountry: "IE",
        listingCountry: "IE",
        hasIcon: false,
        currentValue: valued("400.00"),
      }),
    ],
    totalValue: valued("1000.00"),
    totalUnrealizedGainLoss: valued("100.00"),
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "1",
    portfolioCount: 1,
  };
}

function overviewResponse(): OverviewResponse {
  return {
    from: "2025-08-15",
    to: "2026-08-15",
    totalValue: valued("1000.00"),
    unrealizedGainLoss: valued("100.00"),
    return: {
      twr: { available: true, cumulative: "0.10", annualised: "0.10", subPeriodCount: 1 },
      mwr: { converged: true, rate: "0.10", method: "newton", iterations: 3 },
    },
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    portfolioCount: 1,
    calcEpoch: "1",
  };
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
            <OverviewRoute />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios/$portfolioId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

/**
 * The same `window.matchMedia` stub `ActivityView.test.tsx` establishes —
 * jsdom implements neither it nor a layout engine. This screen needs one now
 * that its «Dernières transactions» block mounts the ledger's own two
 * presentations gated on the desktop breakpoint (`RecentTransactionsPanel`);
 * `true` is the desktop table, which is what this file's own subject (the
 * allocation call count) is measured against.
 */
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
  mockedApiClient.fetchOverview.mockResolvedValue(overviewResponse());
  mockedApiClient.fetchValueSeries.mockResolvedValue({
    from: "2025-08-15",
    to: "2026-08-15",
    baseCurrency: "EUR",
    points: [
      { date: "2026-08-14", value: "900.00", netContributions: "800.00" },
      { date: "2026-08-15", value: "1000.00", netContributions: "800.00" },
    ],
  });
  mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse());
  mockedApiClient.fetchPortfolios.mockResolvedValue([]);
  mockedApiClient.listTransactions.mockResolvedValue({
    items: [],
    nextCursor: null,
  } as unknown as Awaited<ReturnType<typeof apiClient.listTransactions>>);
});

describe("<OverviewRoute> — AC127: one computeAllocation call per render pass, three dimensions", () => {
  it("calls computeAllocation once per holdings payload — never once per consumer", async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("exposure-strip")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("exposure-strip-subtotals")).toBeInTheDocument());
    // The hero chart is drawn from the series read, beside the figures.
    await waitFor(() => expect(screen.getByTestId("overview-value-svg")).toBeInTheDocument());
    // The chart's detail line states the invested capital and the gain; there is no tile row.
    expect(screen.getByTestId("overview-value-detail-contributions")).toHaveTextContent(
      "800.00 EUR",
    );
    expect(screen.getByTestId("overview-hero")).toContainElement(
      screen.getByTestId("overview-twr"),
    );

    // Two calls, and the assertion is *which* two: the memo is keyed on the
    // holdings payload, so it evaluates once before the query resolves (the
    // route's pre-existing empty-set pass, `holdings === undefined`) and once
    // on the loaded payload. That two-payload shape is intended, not drift
    // (and `OverviewRoute.tsx`'s own memo comment) — `HoldingsRoute` and
    // `PortfolioDetailView` instead return `undefined` before load and so
    // record exactly one call each. Three consumers read this route's result
    // — `ExposureStrip` (three dimensions), `PositionsPieCard`, and the
    // two breakdowns derived beside it — and none of them adds a call. A
    // per-consumer implementation would show 4+ here, which is exactly what
    // AC127 forbids.
    const holdingCounts = mockedAllocation.computeAllocation.mock.calls.map(
      ([input]) => input.holdings.length,
    );
    expect(holdingCounts).toEqual([0, 2]);
    // The pie is the second card of the row, fed from that same result;
    // the two panels it replaced are gone, not hidden.
    expect(screen.getByTestId("positions-pie-card")).toBeInTheDocument();
    expect(screen.getAllByTestId("positions-pie-row")).toHaveLength(2);
    expect(screen.queryByTestId("top-positions-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("attention-panel")).not.toBeInTheDocument();
  });

  it("draws all three dimensions at once from the one result — a breakdown is a derivation, not an apportionment", async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("exposure-strip-subtotals")).toBeInTheDocument());

    // No dimension control any more — Type, Pays and Secteur are three
    // bars on the same card, all derived beside the single call above.
    expect(screen.queryByRole("radio", { name: "Secteur" })).not.toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-buckets-sector")).toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-buckets-country")).toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-basis")).toBeInTheDocument();
    // Still exactly the two-payload shape: rendering three bars adds nothing.
    expect(
      mockedAllocation.computeAllocation.mock.calls.map(([input]) => input.holdings.length),
    ).toEqual([0, 2]);
  });

  it("renders the ETF's full value in « Non classé » on both new dimensions", async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("exposure-strip-subtotals")).toBeInTheDocument());

    // 600 of 1000 in one classified SHARE, 400 in the ETF.
    expect(
      screen.getByTestId("exposure-strip-bucket-percentage-sector-__NON_CLASSE__"),
    ).toHaveTextContent("40.00%");
    expect(
      screen.getByTestId("exposure-strip-bucket-percentage-country-__NON_CLASSE__"),
    ).toHaveTextContent("40.00%");
    // FR-11's basis, from the route's own breakdown: the one classified
    // holding has a domicile.
    expect(screen.getByTestId("exposure-strip-basis")).toHaveTextContent(
      "Pays du siège social pour toutes les lignes",
    );
  });
});

describe("<OverviewRoute> — portfolio-archive: an archived portfolio leaves the cards, not the screen's other reads", () => {
  it("shows the all-archived line instead of cards, yet the recent-transactions row still names the archived portfolio", async () => {
    const archivedId = "99999999-9999-4999-8999-999999999999";
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      {
        id: archivedId,
        name: "Ancien PEA",
        transactionCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
        archived: true,
      },
    ]);
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          portfolioId: archivedId,
          kind: "BUY",
          tradeDate: "2026-08-01",
          tradeTs: "2026-08-01T10:00:00.000Z",
          seq: "1",
          instrumentId: "22222222-2222-2222-2222-222222222222",
          quantity: "10",
          unitPrice: "100.00",
          grossAmount: "1000.00",
          txnCurrency: "EUR",
          feeAmount: null,
          withholdingAmount: null,
          brokerFeeAmount: null,
          fxFeeAmount: null,
          taxAmount: null,
          otherCostAmount: null,
          fxRate: "1",
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    } as unknown as Awaited<ReturnType<typeof apiClient.listTransactions>>);

    renderRoute();

    expect(await screen.findByTestId("portfolio-cards-all-archived")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-card")).toBeNull();
    // Name lookups are not option lists: the archived name must resolve, never fall back to the id.
    const cell = await screen.findByTestId("transaction-portfolio");
    expect(cell).toHaveTextContent("Ancien PEA");
    expect(cell).not.toHaveTextContent(archivedId);
  });
});

describe("<OverviewRoute> — portfolio-cash AC-576 (UI): the value chart ends on the hero total", () => {
  it("with cash in the total, the series' last point and the hero total are the same figure", async () => {
    const cash = {
      totalBase: "975.00",
      currency: "EUR",
      isNegative: false,
      unconverted: [],
      byCurrency: [],
    };
    mockedApiClient.fetchOverview.mockResolvedValue({
      ...overviewResponse(),
      totalValue: valued("1975.00"),
      cash,
    });
    mockedApiClient.fetchHoldings.mockResolvedValue({
      ...holdingsResponse(),
      totalValue: valued("1975.00"),
      cash,
    });
    // PC-L1: the series includes cash, so its last point is the live total.
    mockedApiClient.fetchValueSeries.mockResolvedValue({
      from: "2025-08-15",
      to: "2026-08-15",
      baseCurrency: "EUR",
      points: [
        { date: "2026-08-14", value: "1900.00", netContributions: "1800.00" },
        { date: "2026-08-15", value: "1975.00", netContributions: "1800.00" },
      ],
    });
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("overview-value-detail-value")).toHaveTextContent("1 975.00 EUR"),
    );
    expect(screen.getByTestId("overview-total-value")).toHaveTextContent("1 975.00 EUR");
    expect(screen.getByTestId("overview-value-detail-value").textContent).toContain(
      screen.getByTestId("overview-total-value").textContent,
    );
    expect(screen.getByTestId("overview-cash-value")).toHaveTextContent("975.00 EUR");
    // The pie carries the « Liquidités » slice from the same one allocation.
    expect(mockedAllocation.computeAllocation.mock.calls.at(-1)![0].holdings).toHaveLength(3);
  });
});
