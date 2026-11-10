import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type {
  MwrResponse,
  OverviewResponse,
  PerformanceResponse,
  PortfolioSummary,
  TwrResponse,
} from "../lib/api-client.js";
import { resolvePresetRange } from "../lib/period-presets.js";
import { PerformanceView } from "./PerformanceView.js";

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchOverview: vi.fn(),
    fetchPortfolioPerformance: vi.fn(),
    fetchPortfolioValueSeries: vi.fn(),
    fetchPortfolios: vi.fn(),
    fetchValueSeries: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);

function overview(twr: TwrResponse, mwr: MwrResponse): OverviewResponse {
  return {
    from: "2025-08-21",
    to: "2026-08-21",
    totalValue: { amount: "1000.00", currency: "EUR", provenance: { derivedFrom: [] } },
    unrealizedGainLoss: { amount: "10.00", currency: "EUR", provenance: { derivedFrom: [] } },
    return: { twr, mwr },
    calcEpoch: "7",
  } as unknown as OverviewResponse;
}

interface RenderOptions {
  readonly onSelectRange?: () => void;
  /** The `?portfolio=` the route validated, when the screen is scoped. */
  readonly portfolio?: string;
  readonly onSelectPortfolio?: (id: string | undefined) => void;
}

/** The per-portfolio figures, `GET /portfolios/:id/performance`'s own shape. */
function performance(twr: TwrResponse, mwr: MwrResponse): PerformanceResponse {
  return { from: "2025-08-21", to: "2026-08-21", return: { twr, mwr } };
}

const PORTFOLIO_A = "11111111-1111-4111-8111-111111111111";
const PORTFOLIO_B = "22222222-2222-4222-8222-222222222222";

function summary(id: string, name: string, archived = false): PortfolioSummary {
  return {
    id,
    name,
    transactionCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    broker: null,
    description: null,
    accentColor: null,
    hasIcon: false,
    archived,
  };
}

/**
 * Renders the **view**, not the route: `PerformanceView` is router-agnostic by
 * design, so this suite never imports `router.js` and never has to resolve
 * `virtual:pwa-register/react`. It still needs a router in the tree, because
 * `PageHeader` renders `<Link>`s.
 */
async function renderRoute(options: RenderOptions = {}): Promise<void> {
  const onSelectRange = options.onSelectRange ?? vi.fn();
  const onSelectPortfolio = options.onSelectPortfolio ?? vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <PerformanceView
          selectedRange="1Y"
          resolvedRange={resolvePresetRange("1Y")}
          custom={{ onOpen: () => {}, onChange: () => {} }}
          onSelectRange={onSelectRange}
          portfolio={options.portfolio}
          onSelectPortfolio={onSelectPortfolio}
        />
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    (
      <QueryClientProvider client={client}>
        <Tooltip.Provider>
          <RouterProvider router={router} />
        </Tooltip.Provider>
      </QueryClientProvider>
    ) as ReactElement,
  );
  await screen.findByTestId("performance-screen");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchPortfolios.mockResolvedValue([
    summary(PORTFOLIO_A, "PEA"),
    summary(PORTFOLIO_B, "Ancien CTO", true),
  ]);
  // Every test needs the chart's own reads to resolve to *something*; the ones
  // about the chart override these.
  mockedApiClient.fetchValueSeries.mockResolvedValue({
    from: "2025-08-21",
    to: "2026-08-21",
    baseCurrency: "EUR",
    points: [
      { date: "2025-08-21", value: "1000.00", netContributions: "900.00" },
      { date: "2025-08-22", value: "1100.00", netContributions: "900.00" },
    ],
  });
});

describe("<PerformanceView>", () => {
  it("renders both returns when the read supplies them", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview(
        { available: true, cumulative: "0.0734", rangeDays: 365, subPeriodCount: 12 },
        { converged: true, rate: "0.0651", method: "newton", iterations: 4 },
      ),
    );
    await renderRoute();

    await waitFor(() => expect(screen.getByTestId("performance-twr-value")).toBeInTheDocument());
    expect(screen.getByTestId("performance-mwr-value")).toBeInTheDocument();
    expect(screen.queryByTestId("performance-twr-unavailable")).not.toBeInTheDocument();
    expect(screen.queryByTestId("performance-mwr-unavailable")).not.toBeInTheDocument();
  });

  it("states the reason when TWR is unavailable, rather than a bare dash", async () => {
    // The wire carries a `reason` for exactly this. A bare "—" leaves the
    // reader unable to tell "not enough history" from "something is broken",
    // which is the distinction this screen exists to make.
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview(
        {
          available: false,
          reasonCode: "INSUFFICIENT_DATA",
          reason: "computeTwr requires a non-empty valuation series.",
        },
        { converged: true, rate: "0.0651" },
      ),
    );
    await renderRoute();

    const banner = await screen.findByTestId("performance-twr-unavailable");
    // The reason is the French line for its code, not the wire's English.
    expect(banner).toHaveTextContent("Non calculable : historique insuffisant");
    expect(banner.textContent ?? "").not.toContain("computeTwr");
    expect(screen.getByTestId("performance-twr-unavailable-value")).toBeInTheDocument();
    expect(screen.queryByTestId("performance-twr-value")).not.toBeInTheDocument();
  });

  it("states the reason when MWR does not converge", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview(
        { available: true, cumulative: "0.01" },
        {
          converged: false,
          reasonCode: "DID_NOT_CONVERGE",
          reason: "Neither Newton–Raphson nor bisection",
        },
      ),
    );
    await renderRoute();

    const banner = await screen.findByTestId("performance-mwr-unavailable");
    expect(banner).toHaveTextContent("Non calculable : le calcul n'aboutit pas");
    expect(banner.textContent ?? "").not.toContain("Newton");
  });

  it("draws the value chart from the value-series read — and only the euro one, the base-100 card being gone", async () => {
    // made this screen the consumer of `GET /portfolios/value-series`
    // (FR-262); a later change removed its indexed chart and benchmark selector.
    // The read stays, and the value vs. invested-capital card is what draws it.
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    await renderRoute();

    expect(await screen.findByTestId("invested-capital-chart")).toBeInTheDocument();
    expect(screen.queryByTestId("performance-chart-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("performance-chart")).not.toBeInTheDocument();
    expect(screen.queryByTestId("benchmark-selector-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("benchmark-selector-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("performance-no-chart")).not.toBeInTheDocument();
    expect(mockedApiClient.fetchValueSeries).toHaveBeenCalledWith(
      { from: expect.any(String), to: expect.any(String) },
      expect.anything(),
    );
  });

  it("says the period holds no value points instead of drawing an empty frame", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    mockedApiClient.fetchValueSeries.mockResolvedValue({
      from: "2025-08-21",
      to: "2026-08-21",
      baseCurrency: "EUR",
      points: [],
    });
    await renderRoute();

    expect(await screen.findByTestId("performance-series-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("invested-capital-chart")).not.toBeInTheDocument();
  });

  it("shows the method block only for the fields the response actually carried", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    await renderRoute();

    const method = await screen.findByTestId("performance-method");
    // `from`/`to` always arrive; the rest are optional on the wire and must not
    // render as empty rows when absent.
    expect(method).toHaveTextContent("2025-08-21");
    expect(method).not.toHaveTextContent("Sous-périodes");
    expect(method).not.toHaveTextContent("Itérations");
  });

  it("draws the periodic % return chart from the same value-series data, issuing no third read", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    mockedApiClient.fetchValueSeries.mockResolvedValue({
      from: "2025-08-21",
      to: "2026-08-21",
      baseCurrency: "EUR",
      points: [
        { date: "2025-08-21", value: "1000.00", netContributions: "900.00" },
        { date: "2025-09-21", value: "1100.00", netContributions: "900.00" },
      ],
    });
    await renderRoute();

    expect(await screen.findByTestId("performance-period-return-card")).toBeInTheDocument();
    expect(screen.getByTestId("period-return-chart")).toBeInTheDocument();
    expect(mockedApiClient.fetchValueSeries).toHaveBeenCalledTimes(1);
  });

  it("draws the value vs. invested-capital chart from the same read, stating the last date's value, capital and gap", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    mockedApiClient.fetchValueSeries.mockResolvedValue({
      from: "2025-08-21",
      to: "2026-08-21",
      baseCurrency: "EUR",
      points: [
        { date: "2025-08-30", value: "1000.00", netContributions: "900.00" },
        { date: "2025-08-31", value: "1050.00", netContributions: "900.00" },
        { date: "2025-09-01", value: "1650.00", netContributions: "1500.00" },
      ],
    });
    await renderRoute();

    const card = await screen.findByTestId("performance-invested-card");
    expect(card).toHaveTextContent("Valeur et capital investi");
    expect(screen.getByTestId("invested-capital-value-line")).toBeInTheDocument();
    expect(screen.getAllByTestId("invested-capital-contributions-line")).toHaveLength(1);

    // The detail line defaults to the range's last point; the gap is
    // value − contributions, in Decimal, never a float.
    const detail = screen.getByTestId("invested-capital-detail");
    expect(detail).toHaveTextContent("Au 2025-09-01");
    expect(screen.getByTestId("invested-capital-detail-value")).toHaveTextContent("1 650.00 EUR");
    expect(screen.getByTestId("invested-capital-detail-contributions")).toHaveTextContent(
      "1 500.00 EUR",
    );
    expect(screen.getByTestId("invested-capital-detail-gap")).toHaveTextContent("150.00 EUR");

    // One row per month-end (08-31) plus the last day (09-01) — 08-30 is not
    // a month's last point and does not appear.
    const rows = screen.getAllByTestId("invested-capital-row");
    expect(rows.map((row) => row.getAttribute("data-date"))).toEqual(["2025-08-31", "2025-09-01"]);

    expect(mockedApiClient.fetchValueSeries).toHaveBeenCalledTimes(1);
  });

  it("counts an unreadable netContributions decimal and says so, while the value line still draws", async () => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    mockedApiClient.fetchValueSeries.mockResolvedValue({
      from: "2025-08-21",
      to: "2026-08-21",
      baseCurrency: "EUR",
      points: [
        { date: "2025-08-21", value: "1000.00", netContributions: "900.00" },
        { date: "2025-08-22", value: "1100.00", netContributions: "not-a-decimal" },
      ],
    });
    await renderRoute();

    expect(await screen.findByTestId("performance-invested-dropped")).toHaveTextContent(
      "1 valeur(s) illisible(s) du capital investi",
    );
    expect(screen.getByTestId("invested-capital-value-line")).toBeInTheDocument();
    // The missing date's contribution is stated as unavailable, not carried forward.
    expect(screen.getByTestId("invested-capital-detail-contributions")).toHaveTextContent(
      "indisponible",
    );
  });

  it("never fans out per portfolio — one combined overview and one combined series, whatever the range", async () => {
    // `/portfolios/:id/performance` has no combined equivalent, and one call
    // per portfolio through a bound-1 budget is the fan-out FR-101 forbids.
    // adds exactly one read to this screen (the combined value series),
    // not a per-portfolio one.
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    await renderRoute();

    await waitFor(() => expect(mockedApiClient.fetchOverview).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.fetchValueSeries).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.fetchPortfolioPerformance).not.toHaveBeenCalled();
  });
});

describe("<PerformanceView> — one portfolio isolated", () => {
  const scopedPoints = [
    { date: "2025-08-21", value: "500.00", netContributions: "400.00" },
    { date: "2025-08-22", value: "520.00", netContributions: "400.00" },
  ];

  beforeEach(() => {
    mockedApiClient.fetchOverview.mockResolvedValue(
      overview({ available: true, cumulative: "0.01" }, { converged: true, rate: "0.01" }),
    );
    mockedApiClient.fetchPortfolioPerformance.mockResolvedValue(
      performance(
        { available: true, cumulative: "0.1234", rangeDays: 365, subPeriodCount: 3 },
        { converged: true, rate: "0.0987", method: "bisection", iterations: 9 },
      ),
    );
    mockedApiClient.fetchPortfolioValueSeries.mockResolvedValue({
      from: "2025-08-21",
      to: "2026-08-21",
      baseCurrency: "EUR",
      points: scopedPoints,
    });
  });

  it("offers « Tous les portefeuilles » plus the tenant's portfolios, archived ones kept only when selected (PA-L10)", async () => {
    await renderRoute();

    const select = (await screen.findByTestId("performance-scope")) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Tous les portefeuilles",
      "PEA",
    ]);
  });

  it("keeps an archived portfolio in the list, suffixed, when it is the one selected", async () => {
    await renderRoute({ portfolio: PORTFOLIO_B });

    const select = (await screen.findByTestId("performance-scope")) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect(select.value).toBe(PORTFOLIO_B);
    expect(Array.from(select.options).map((option) => option.textContent)).toContain(
      "Ancien CTO (archivé)",
    );
  });

  it("hands the chosen id (or undefined for « Tous ») to the route, never writing the URL itself", async () => {
    const onSelectPortfolio = vi.fn();
    await renderRoute({ onSelectPortfolio });
    const select = (await screen.findByTestId("performance-scope")) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2));

    fireEvent.change(select, { target: { value: PORTFOLIO_A } });
    expect(onSelectPortfolio).toHaveBeenLastCalledWith(PORTFOLIO_A);

    fireEvent.change(select, { target: { value: "" } });
    expect(onSelectPortfolio).toHaveBeenLastCalledWith(undefined);
  });

  it("reads the per-portfolio pair for the selected range and never the combined routes", async () => {
    await renderRoute({ portfolio: PORTFOLIO_A });

    await waitFor(() =>
      expect(screen.getByTestId("performance-twr-value")).toHaveTextContent("12.34"),
    );
    expect(screen.getByTestId("performance-mwr-value")).toHaveTextContent("9.87");

    const range = resolvePresetRange("1Y");
    expect(mockedApiClient.fetchPortfolioPerformance).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.fetchPortfolioPerformance).toHaveBeenCalledWith(
      PORTFOLIO_A,
      { from: range.from, to: range.to },
      expect.anything(),
    );
    expect(mockedApiClient.fetchPortfolioValueSeries).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.fetchPortfolioValueSeries).toHaveBeenCalledWith(
      PORTFOLIO_A,
      { from: range.from, to: range.to },
      expect.anything(),
    );
    expect(mockedApiClient.fetchOverview).not.toHaveBeenCalled();
    expect(mockedApiClient.fetchValueSeries).not.toHaveBeenCalled();
  });

  it("draws both charts and the method card from the portfolio's own data", async () => {
    await renderRoute({ portfolio: PORTFOLIO_A });

    await waitFor(() => expect(screen.getByTestId("invested-capital-chart")).toBeInTheDocument());
    // The last point of the *scoped* series, not the combined fixture's 1 100.
    expect(screen.getByTestId("invested-capital-detail")).toHaveTextContent("520.00");
    expect(screen.getByTestId("period-return-chart")).toBeInTheDocument();
    expect(screen.getByTestId("performance-method")).toHaveTextContent("Bissection");
    expect(screen.getByTestId("performance-method")).toHaveTextContent("9");
  });

  it("states why the portfolio's return is unavailable, as the combined view does", async () => {
    mockedApiClient.fetchPortfolioPerformance.mockResolvedValue(
      performance(
        { available: false, reasonCode: "INSUFFICIENT_DATA", reason: "fewer than two points" },
        { converged: false, reasonCode: "NOT_CONVERGED", reason: "no root in bracket" },
      ),
    );
    await renderRoute({ portfolio: PORTFOLIO_A });

    await waitFor(() =>
      expect(screen.getByTestId("performance-twr-unavailable")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("performance-twr-unavailable")).toHaveTextContent(
      "historique insuffisant",
    );
    expect(screen.getByTestId("performance-mwr-unavailable")).toBeInTheDocument();
  });

  it("falls back to the combined view when the id is not one of the tenant's portfolios (AC7)", async () => {
    const unknown = "99999999-9999-4999-8999-999999999999";
    await renderRoute({ portfolio: unknown });

    await waitFor(() => expect(mockedApiClient.fetchOverview).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.fetchValueSeries).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.fetchPortfolioPerformance).not.toHaveBeenCalled();
    expect(mockedApiClient.fetchPortfolioValueSeries).not.toHaveBeenCalled();
    const select = (await screen.findByTestId("performance-scope")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
  });
});
