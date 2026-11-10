import * as Tooltip from "@radix-ui/react-tooltip";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioCardsPanel } from "./PortfolioCardsPanel.js";
import * as apiClient from "../lib/api-client.js";
import type { OverviewResponse, PortfolioSummary } from "../lib/api-client.js";
import { DASHBOARD_PORTFOLIO_CARD_LIMIT } from "./PortfolioCardsPanel.js";

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchPortfolios: vi.fn(), fetchPortfolioOverview: vi.fn() };
});

const mocked = vi.mocked(apiClient);

const PORTFOLIO_ID = "d7d8678d-3dd1-4475-baca-af4ced55194a";

function overview(): OverviewResponse {
  const valued = (amount: string) => ({
    amount,
    currency: "EUR",
    provenance: { derivedFrom: ["AUTOMATED" as const] },
  });
  return {
    from: "2026-06-15",
    to: "2026-09-15",
    totalValue: valued("19662.02"),
    unrealizedGainLoss: valued("2798.14"),
    return: {
      twr: {
        available: true,
        cumulative: "0.1",
        annualised: null,
        rangeDays: 92,
        subPeriodCount: 1,
      },
      mwr: { converged: true, rate: "0.1", method: "newton", iterations: 2 },
    },
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "1",
    portfolioCount: 1,
  };
}

function renderPanel(presetId: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          {/* The card's « Plus/moins-value » label is a JargonTerm tooltip. */}
          <Tooltip.Provider>
            <PortfolioCardsPanel
              range={{ from: "2026-06-15", to: "2026-09-15" }}
              presetId={presetId}
            />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios/$portfolioId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

/**
 * `portfolio-details` PD-T11: the fixture the *fallback* branch is asserted
 * against — every one of the four new fields explicitly unset, which is what
 * G2 ("a portfolio with none of them set looks exactly as it does today") is a
 * claim about. Re-pointed, never loosened to "a tile of some kind renders".
 */
function portfolioSummary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    id: PORTFOLIO_ID,
    name: "CTO",
    transactionCount: 111,
    createdAt: "2026-09-08T12:34:15.311Z",
    broker: null,
    description: null,
    accentColor: null,
    hasIcon: false,
    archived: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchPortfolios.mockResolvedValue([portfolioSummary()]);
  mocked.fetchPortfolioOverview.mockResolvedValue(overview());
});

describe("<PortfolioCardsPanel> — a card opens its portfolio on the dashboard's own window", () => {
  it("carries the selected preset into the card link, never a hard-coded 1Y", async () => {
    renderPanel("3M");
    const link = await screen.findByTestId("portfolio-card-name");
    expect(link).toHaveAttribute("href", `/portfolios/${PORTFOLIO_ID}?range=3M&tab=overview`);
  });

  it("still opens on 1Y when that is what the dashboard shows", async () => {
    renderPanel("1Y");
    const link = await screen.findByTestId("portfolio-card-name");
    expect(link).toHaveAttribute("href", `/portfolios/${PORTFOLIO_ID}?range=1Y&tab=overview`);
  });
});

describe("<PortfolioCardsPanel> — portfolio-details: the tile, the broker line, and what stays off a card", () => {
  it("renders the wallet fallback and no <img> at all when the portfolio has no icon (G2, FR-468)", async () => {
    renderPanel("1Y");

    const box = await screen.findByTestId("portfolio-icon-box");
    expect(box).toHaveClass("k-pf-tile");
    expect(screen.queryByTestId("portfolio-icon-image")).toBeNull();
    // G2 is about the *emitted* attributes: no accent attribute, no inline
    // style, so the tile keeps its current ground and glyph byte for byte.
    expect(box.getAttribute("data-accent")).toBeNull();
    expect(box.getAttribute("style")).toBeNull();
  });

  it("renders the uploaded bytes from the token-free id-only route when there is an icon (FR-468)", async () => {
    mocked.fetchPortfolios.mockResolvedValue([portfolioSummary({ hasIcon: true })]);

    renderPanel("1Y");

    const img = await screen.findByTestId("portfolio-icon-image");
    expect(img).toHaveAttribute("src", `/api/v1/portfolios/${PORTFOLIO_ID}/icon`);
  });

  it("AC-408 — the card link's accessible name is string-identical with and without an icon, and the tile box does not move", async () => {
    // One literal, asserted against **both** branches in the same run: that is
    // what "string-identical" means here, rather than two eyeballed strings.
    const ACCESSIBLE_NAME = "CTO";

    renderPanel("1Y");
    const bare = await screen.findByTestId("portfolio-card-name");
    // Two computations of the same property, deliberately: jest-dom's
    // `toHaveAccessibleName` and testing-library's own accessible-name *query*
    // (`getByRole`'s `name`, an exact full-string match), the second tied back
    // to the very element the surface's test id names.
    expect(bare).toHaveAccessibleName(ACCESSIBLE_NAME);
    expect(screen.getByRole("link", { name: ACCESSIBLE_NAME })).toBe(bare);
    const bareBoxClass = screen.getByTestId("portfolio-icon-box").className;
    cleanup();

    mocked.fetchPortfolios.mockResolvedValue([
      portfolioSummary({
        hasIcon: true,
        broker: "Boursorama",
        description: "Le PEA de long terme.",
        accentColor: "CHART_3",
      }),
    ]);
    renderPanel("1Y");
    const dressed = await screen.findByTestId("portfolio-card-name");

    // Not merely "the icon happens to be aria-hidden": the broker line *is*
    // rendered in this branch (asserted below) and still contributes nothing,
    // because it sits outside the `<Link>` — the same pattern
    // `BaseCurrencyBadge` already follows on this surface. An exact-match
    // query would fail if either the icon or the broker joined the name.
    expect(dressed).toHaveAccessibleName(ACCESSIBLE_NAME);
    expect(screen.getByRole("link", { name: ACCESSIBLE_NAME })).toBe(dressed);
    expect(screen.getByTestId("portfolio-card-broker")).toHaveTextContent("Boursorama");

    // No layout shift between the two branches: the same `.k-pf-tile` box is
    // the host either way, and the `<img>` that replaces the glyph carries
    // that box's own intrinsic size, so nothing reflows when the bytes land
    // (or fail to). The browser-level proof is PD-T12's AC-409.
    const dressedBox = screen.getByTestId("portfolio-icon-box");
    expect(dressedBox.className).toBe(bareBoxClass);
    const img = screen.getByTestId("portfolio-icon-image");
    expect(img).toHaveAttribute("width", "44");
    expect(img).toHaveAttribute("height", "44");
  });

  it("FR-470/FR-471/SD-1 — the broker line renders on the card, the description never does", async () => {
    mocked.fetchPortfolios.mockResolvedValue([
      portfolioSummary({ broker: "Degiro", description: "Ne doit pas s'afficher ici." }),
    ]);

    renderPanel("1Y");

    expect(await screen.findByTestId("portfolio-card-broker")).toHaveTextContent("Degiro");
    expect(screen.queryByText("Ne doit pas s'afficher ici.")).toBeNull();
  });

  it("FR-470 — an unset broker renders nothing at all, not a placeholder", async () => {
    renderPanel("1Y");

    await screen.findByTestId("portfolio-card-name");
    expect(screen.queryByTestId("portfolio-card-broker")).toBeNull();
  });

  it("FR-472/PD-15 — a set accent rides on the tile as a custom property, never as a literal colour", async () => {
    mocked.fetchPortfolios.mockResolvedValue([portfolioSummary({ accentColor: "CHART_5" })]);

    renderPanel("1Y");

    const box = await screen.findByTestId("portfolio-icon-box");
    expect(box).toHaveAttribute("data-accent", "CHART_5");
    expect(box.getAttribute("style")).toBe("--k-pf-accent: var(--chart-5);");
  });

  it("FR-467/NFR-53 — a 12-card dashboard with 5 iconed portfolios mounts exactly 5 <img> elements", async () => {
    const total = DASHBOARD_PORTFOLIO_CARD_LIMIT;
    const iconed = 5;
    mocked.fetchPortfolios.mockResolvedValue(
      Array.from({ length: total }, (_, index) =>
        portfolioSummary({
          id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          name: `Portefeuille ${index}`,
          hasIcon: index < iconed,
        }),
      ),
    );

    renderPanel("1Y");

    await waitFor(() => expect(screen.getAllByTestId("portfolio-card")).toHaveLength(total));
    // Two-sided, the standing rule for a volume assertion. The `<img>` is the
    // *only* thing in this component that can issue an icon byte request —
    // there is no `useQuery`, no `HEAD` and no `new Image()` anywhere in
    // `PortfolioIconTile` — so the element count **is** the request count,
    // and `hasIcon` (carried on the one `["portfolios","list"]` read every
    // surface already mounts) is what keeps a bare portfolio at zero.
    expect(screen.getAllByTestId("portfolio-icon-image")).toHaveLength(iconed);
    expect(screen.getAllByTestId("portfolio-icon-box")).toHaveLength(total);
    expect(iconed).toBeLessThan(total);
    // The bound is the panel's own: never more than 12 cards, so never more
    // than 12 icon requests, whatever the tenant's portfolio count is.
    expect(total).toBe(DASHBOARD_PORTFOLIO_CARD_LIMIT);
  });
});

describe("<PortfolioCardsPanel> — portfolio-archive: archived portfolios get no card", () => {
  function many(count: number, archived: boolean, prefix: string): PortfolioSummary[] {
    return Array.from({ length: count }, (_, index) =>
      portfolioSummary({
        id: `${prefix}-${String(index)}`,
        name: `${archived ? "Archivé" : "Actif"} ${String(index)}`,
        archived,
      }),
    );
  }

  it("AC-483 — 13 active + 2 archived shows 12 cards, none archived, and no read for an archived one", async () => {
    // Archived first in list order, so a filter applied after the cap would show them.
    mocked.fetchPortfolios.mockResolvedValue([...many(2, true, "arc"), ...many(13, false, "act")]);
    renderPanel("1Y");

    await waitFor(() => expect(screen.getAllByTestId("portfolio-card")).toHaveLength(12));
    const names = screen.getAllByTestId("portfolio-card-name").map((link) => link.textContent);
    expect(names.some((name) => name?.startsWith("Archivé") === true)).toBe(false);
    expect(screen.getByTestId("portfolio-cards-see-all")).toBeInTheDocument();
    const readIds = mocked.fetchPortfolioOverview.mock.calls.map((call) => call[0]);
    expect(readIds.some((id) => id.startsWith("arc-"))).toBe(false);
  });

  it("AC-483 — 3 active + 1 archived shows 3 cards and no see-all link", async () => {
    mocked.fetchPortfolios.mockResolvedValue([...many(3, false, "act"), ...many(1, true, "arc")]);
    renderPanel("1Y");

    await waitFor(() => expect(screen.getAllByTestId("portfolio-card")).toHaveLength(3));
    expect(screen.queryByTestId("portfolio-cards-see-all")).toBeNull();
  });

  it("AC-484 — every portfolio archived shows the all-archived line with a link, not onboarding", async () => {
    mocked.fetchPortfolios.mockResolvedValue(many(2, true, "arc"));
    renderPanel("1Y");

    expect(await screen.findByTestId("portfolio-cards-all-archived")).toHaveTextContent(
      "Tous vos portefeuilles sont archivés",
    );
    expect(screen.getByTestId("portfolio-cards-all-archived-link")).toHaveAttribute(
      "href",
      "/portfolios",
    );
    expect(screen.queryByTestId("portfolio-cards-empty")).toBeNull();
    expect(screen.queryByTestId("portfolio-card")).toBeNull();
    expect(mocked.fetchPortfolioOverview).not.toHaveBeenCalled();
  });

  it("AC-484 — zero portfolios still shows the onboarding state", async () => {
    mocked.fetchPortfolios.mockResolvedValue([]);
    renderPanel("1Y");

    expect(await screen.findByTestId("portfolio-cards-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-cards-all-archived")).toBeNull();
  });
});

describe("card figures are always stacked, cards share the row height", () => {
  // jsdom applies no author stylesheet (PD-15's precedent in
  // PortfoliosRoute.test.tsx), so the owner's decision is stateable only by
  // reading the rule: a `flex-wrap: wrap` row put « Valeur totale » and
  // « +/− latente » side by side whenever both fit, and cards in one row
  // ended up one or two lines tall depending on the figures' width.
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../styles/screens/portfolios.css"),
    "utf8",
  );

  it("the figures block is a column, never a wrapping row", () => {
    const rule = /\.k-pf-card-figures\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("flex-direction: column");
    expect(rule?.[1]).not.toContain("flex-wrap");
  });

  it("the card fills its grid cell and pins the freshness line to the bottom", () => {
    const item = /\.k-pf-cards > li\s*\{([^}]*)\}/.exec(css);
    expect(item?.[1]).toContain("display: flex");
    const card = /\.k-pf-cards > li > \.k-card\s*\{([^}]*)\}/.exec(css);
    expect(card?.[1]).toContain("flex: 1 1 auto");
    const freshness = /\.k-pf-freshness\s*\{([^}]*)\}/.exec(css);
    expect(freshness?.[1]).toContain("margin-top: auto");
  });
});

describe("<PortfolioCardsPanel> — portfolio-cash: the card's total includes cash and says so (AC-579)", () => {
  it("states « Liquidités » with its value under a total that includes it, and no line for zero cash", async () => {
    const base = overview();
    mocked.fetchPortfolioOverview.mockResolvedValue({
      ...base,
      totalValue: { ...base.totalValue, amount: "975.00" },
      cash: {
        totalBase: "975.00",
        currency: "EUR",
        isNegative: false,
        unconverted: ["USD"],
        byCurrency: [],
      },
    });
    renderPanel("1Y");
    const cash = await screen.findByTestId("portfolio-card-cash");
    expect(cash).toHaveTextContent("Liquidités");
    expect(cash).toHaveTextContent("975.00 EUR");
    expect(screen.getByTestId("portfolio-card-value")).toHaveTextContent("975.00 EUR");
    expect(screen.getByTestId("portfolio-card-cash-unconverted")).toHaveTextContent(
      "taux indisponible : USD",
    );
  });

  it("shows no « Liquidités » line when the portfolio holds no cash", async () => {
    renderPanel("1Y");
    await screen.findByTestId("portfolio-card-value");
    expect(screen.queryByTestId("portfolio-card-cash")).not.toBeInTheDocument();
  });
});
