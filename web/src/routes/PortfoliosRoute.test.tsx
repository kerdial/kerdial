import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { OverviewResponse, PortfolioSummary } from "../lib/api-client.js";
import { DASHBOARD_PORTFOLIO_CARD_LIMIT } from "../components/PortfolioCardsPanel.js";
import { PortfoliosRoute } from "./PortfoliosRoute.js";

/**
 * `PortfoliosRoute.test.tsx` — the bounded first-N figures and the
 * base-currency badge, on the screen that owns them.
 *
 * The two properties this file exists to hold, both of which a plain "the
 * figures render" test would miss:
 *
 * 1. **The fan-out is bounded and read-per-row.** With more portfolios than
 *    `DASHBOARD_PORTFOLIO_CARD_LIMIT`, exactly that many *distinct*
 *    `:id/overview` reads are issued — never one per portfolio, never zero —
 *    and `fetchPortfolioHoldings` is never called at all. (The concurrency
 *    half of the property — peak overlap 1 — is a request-volume e2e,
 *    `e2e/portfolios-list-request-volume.spec.ts`; jsdom cannot observe
 *    in-flight overlap through mocked promises.)
 * 2. **No figure is rendered that the response did not supply.** `dayChange`
 *    is optional on the wire (FR-263): an absent one must render the honest
 *    absence, never a zero. A row whose read failed says so.
 *
 * The badge fixture deliberately uses `"CHF"`, not `"EUR"`: a hardcoded
 * literal — the exact failure the verdict rules out — would still pass an
 * `"EUR"` assertion.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchPortfolios: vi.fn(),
    fetchPortfolioOverview: vi.fn(),
    fetchPortfolioHoldings: vi.fn(),
    // `portfolio-details` PD-T11: the row's `onIconWritten` seam is driven
    // through the real edit dialog, so the one write it hangs off has to be
    // mockable.
    deletePortfolioIcon: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);

function portfolioIdFor(index: number): string {
  return `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/**
 * `portfolio-details` PD-T11: the four new fields are **explicitly unset**
 * here, which is what makes every assertion below a claim about the *fallback*
 * branch rather than about "a tile of some kind" (G2 —
 * "a portfolio with none of the four fields set looks exactly as it does
 * today"). Set-branch cases pass `overrides`.
 */
function portfolios(count: number, overrides: Partial<PortfolioSummary> = {}): PortfolioSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: portfolioIdFor(index),
    name: `Portefeuille ${index}`,
    transactionCount: index,
    createdAt: "2026-01-01T00:00:00.000Z",
    broker: null,
    description: null,
    accentColor: null,
    hasIcon: false,
    archived: false,
    ...overrides,
  }));
}

function valued(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    from: "2025-09-03",
    to: "2026-09-03",
    totalValue: valued("12345.67"),
    unrealizedGainLoss: valued("345.67"),
    return: { twr: { available: true, cumulative: "0.1234" }, mwr: { converged: false } },
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "7",
    portfolioCount: 1,
    ...overrides,
  };
}

/** The router guard's `["auth","me"]` entry — the badge's only source (`BaseCurrencyBadge`). */
function seedCurrentUser(queryClient: QueryClient, baseCurrency: string): void {
  queryClient.setQueryData(["auth", "me"], {
    tenantId: "t-1",
    userId: "u-1",
    email: "someone@example.test",
    baseCurrency,
    // `account-setup` FR-419 — on the real wire, so on the fixture too.
    isInstanceAdmin: false,
  });
}

/**
 * A memory-history router, because every row renders `<Link>`s. `baseCurrency`
 * primes the router guard's `["auth","me"]` entry before the first render —
 * the only thing `BaseCurrencyBadge` reads, and never fetched by it.
 */
function renderScreen(baseCurrency?: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (baseCurrency !== undefined) seedCurrentUser(queryClient, baseCurrency);
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <Tooltip.Provider delayDuration={200}>
            <PortfoliosRoute />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios/$portfolioId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchPortfolios.mockResolvedValue(portfolios(1));
  mocked.fetchPortfolioOverview.mockResolvedValue(overview());
});

describe("the portfolio list's bounded first-N figures", () => {
  it("issues one :id/overview per row for the first N rows only, and never :id/holdings", async () => {
    const total = DASHBOARD_PORTFOLIO_CARD_LIMIT + 3;
    mocked.fetchPortfolios.mockResolvedValue(portfolios(total));

    renderScreen();

    await waitFor(() => expect(screen.getAllByTestId("portfolio-row")).toHaveLength(total));
    await waitFor(() =>
      expect(screen.getAllByTestId("portfolio-row-value")).toHaveLength(
        DASHBOARD_PORTFOLIO_CARD_LIMIT,
      ),
    );

    // Two-sided, the standing rule for a volume assertion: the bound holds
    // AND the reads genuinely fired — never zero, never the fixture's full
    // count. Distinct ids, so a retry loop could not inflate the number
    // either.
    const requestedIds = new Set(
      mocked.fetchPortfolioOverview.mock.calls.map(([portfolioId]) => portfolioId),
    );
    expect(requestedIds.size).toBe(DASHBOARD_PORTFOLIO_CARD_LIMIT);
    expect(mocked.fetchPortfolioOverview).toHaveBeenCalledTimes(DASHBOARD_PORTFOLIO_CARD_LIMIT);
    // The bound must not itself have become "no bound at all".
    expect(DASHBOARD_PORTFOLIO_CARD_LIMIT).toBeLessThan(total);

    // Holdings count and the allocation bar are the dropped half of the
    // verdict, and this is what proves they stayed dropped: a second read
    // per row is exactly the cost the bound exists to avoid.
    expect(mocked.fetchPortfolioHoldings).not.toHaveBeenCalled();

    // The rows past the bound say so rather than showing a blank column.
    expect(screen.getAllByTestId("portfolio-row-figures-not-loaded")).toHaveLength(
      total - DASHBOARD_PORTFOLIO_CARD_LIMIT,
    );
    // …and keep the way to the figures: the detail-screen link.
    expect(screen.getAllByTestId("portfolio-open-link")).toHaveLength(total);
  });

  it("renders value, day change and TWR from the response — with the period note naming the bound", async () => {
    mocked.fetchPortfolioOverview.mockResolvedValue(overview({ dayChange: valued("42.50") }));

    renderScreen();

    const value = await screen.findByTestId("portfolio-row-value");
    expect(value).toHaveTextContent("12 345.67 EUR");
    expect(screen.getByTestId("portfolio-row-day-change")).toHaveTextContent("42.50 EUR");
    expect(screen.getByTestId("portfolio-row-twr")).toHaveTextContent("12.34%");
    expect(screen.getByTestId("portfolios-figures-note")).toHaveTextContent(
      String(DASHBOARD_PORTFOLIO_CARD_LIMIT),
    );
  });

  it("renders an absent dayChange as absence, never as zero (FR-263's optional field)", async () => {
    mocked.fetchPortfolioOverview.mockResolvedValue(overview());

    renderScreen();

    const unavailable = await screen.findByTestId("portfolio-row-day-change-unavailable");
    expect(unavailable).toHaveTextContent("Clôture précédente inconnue");
    expect(screen.getByTestId("portfolio-row-day-change")).not.toHaveTextContent("0.00");
  });

  // One French line from the code; a review saw four
  // lines of English here on a phone.
  it("says an unavailable TWR is unavailable, as the French line for its reason code", async () => {
    mocked.fetchPortfolioOverview.mockResolvedValue(
      overview({
        return: {
          twr: {
            available: false,
            reasonCode: "ZERO_INVESTED_BASE",
            reason: "TWR sub-period starting 2025-10-16 has an invested base of zero",
          },
          mwr: { converged: false },
        },
      }),
    );

    renderScreen();

    const twr = await screen.findByTestId("portfolio-row-twr-unavailable");
    expect(twr).toHaveTextContent("Non calculable : aucun capital investi");
    expect(twr.textContent ?? "").not.toContain("invested base");
  });

  it("a row whose valuation read failed says so, and shows no figures at all", async () => {
    // A bare 503, so the row shows `problem-messages.ts`'s status-class
    // default — the wire's own vocabulary, whatever the code happens to be.
    mocked.fetchPortfolioOverview.mockRejectedValue(new ApiError(503, undefined));

    renderScreen();

    const failed = await screen.findByTestId("portfolio-row-figures-error");
    expect(failed).toHaveAttribute("role", "alert");
    expect(failed.textContent ?? "").not.toBe("");
    expect(screen.queryByTestId("portfolio-row-value")).not.toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-row-twr")).not.toBeInTheDocument();
  });
});

describe("the base-currency badge", () => {
  it("shows the tenant base currency off the wire, not a hardcoded EUR", async () => {
    renderScreen("CHF");

    const badge = await screen.findByTestId("portfolio-base-currency");
    expect(badge).toHaveTextContent("CHF");
    expect(badge).toHaveAccessibleName("Devise de base : CHF");
  });

  it("renders no badge at all when the tenant's base currency is not known", async () => {
    renderScreen();

    await screen.findByTestId("portfolio-row");
    expect(screen.queryByTestId("portfolio-base-currency")).not.toBeInTheDocument();
  });
});

describe("portfolio-details — the list row's tile, broker line, and what stays off it", () => {
  it("renders the wallet fallback and no <img> at all for a portfolio with none of the four fields set (G2, FR-468)", async () => {
    renderScreen();

    const box = await screen.findByTestId("portfolio-icon-box");
    expect(box).toHaveClass("k-pf-tile");
    expect(screen.queryByTestId("portfolio-icon-image")).toBeNull();
    // G2 is a claim about the emitted attributes, not about a transparent
    // value being painted: no accent attribute, no inline style.
    expect(box.getAttribute("data-accent")).toBeNull();
    expect(box.getAttribute("style")).toBeNull();
    // …and nothing new appears on the row either.
    expect(screen.queryByTestId("portfolio-broker")).toBeNull();
  });

  it("renders the uploaded bytes from the token-free id-only route when the row has an icon (FR-468)", async () => {
    mocked.fetchPortfolios.mockResolvedValue(portfolios(1, { hasIcon: true }));

    renderScreen();

    const img = await screen.findByTestId("portfolio-icon-image");
    expect(img).toHaveAttribute("src", `/api/v1/portfolios/${portfolioIdFor(0)}/icon`);
  });

  it("AC-408 — the row link's accessible name is string-identical with and without an icon, and the tile box does not move", async () => {
    // One literal, asserted against **both** branches in the same run.
    const ACCESSIBLE_NAME = "Portefeuille 0";

    renderScreen();
    const bare = await screen.findByTestId("portfolio-name");
    expect(bare).toHaveAccessibleName(ACCESSIBLE_NAME);
    expect(screen.getByRole("link", { name: ACCESSIBLE_NAME })).toBe(bare);
    const bareBoxClass = screen.getByTestId("portfolio-icon-box").className;
    cleanup();

    mocked.fetchPortfolios.mockResolvedValue(
      portfolios(1, {
        hasIcon: true,
        broker: "Boursorama",
        description: "Le PEA de long terme.",
        accentColor: "CHART_2",
      }),
    );
    renderScreen();
    const dressed = await screen.findByTestId("portfolio-name");

    // The broker line is rendered in this branch and still contributes
    // nothing, because it sits outside the `<Link>` — the row's existing
    // pattern (`BaseCurrencyBadge` is a sibling of the link too), matched
    // rather than replaced. An exact-match role query would fail if either
    // the icon or the broker had joined the name.
    expect(dressed).toHaveAccessibleName(ACCESSIBLE_NAME);
    expect(screen.getByRole("link", { name: ACCESSIBLE_NAME })).toBe(dressed);
    expect(screen.getByTestId("portfolio-broker")).toHaveTextContent("Boursorama");

    // No layout shift between the branches: the same `.k-pf-tile` box hosts
    // both, and the `<img>` carries that box's own intrinsic size, so the
    // fallback swap moves nothing. The browser-level proof is PD-T12's AC-409.
    expect(screen.getByTestId("portfolio-icon-box").className).toBe(bareBoxClass);
    const img = screen.getByTestId("portfolio-icon-image");
    expect(img).toHaveAttribute("width", "44");
    expect(img).toHaveAttribute("height", "44");
  });

  it("FR-470/FR-471/SD-1 — the broker line renders on the row, the description never does", async () => {
    mocked.fetchPortfolios.mockResolvedValue(
      portfolios(1, { broker: "Degiro", description: "Ne doit pas s'afficher ici." }),
    );

    renderScreen();

    expect(await screen.findByTestId("portfolio-broker")).toHaveTextContent("Degiro");
    expect(screen.queryByText("Ne doit pas s'afficher ici.")).toBeNull();
  });

  it("FR-472/PD-15 — a set accent rides on the tile as a custom property, never as a literal colour", async () => {
    mocked.fetchPortfolios.mockResolvedValue(portfolios(1, { accentColor: "CHART_4" }));

    renderScreen();

    const box = await screen.findByTestId("portfolio-icon-box");
    expect(box).toHaveAttribute("data-accent", "CHART_4");
    expect(box.getAttribute("style")).toBe("--k-pf-accent: var(--chart-4);");
  });

  it("PD-15 — the stylesheet paints that accent as an inset ring, never as the tile's ground", () => {
    // The only place the ring-versus-fill decision is *stateable*: jsdom
    // applies no author stylesheet, and PD-T12's e2e lane does not own this
    // rule. Read from the file, so a rule rewritten into a `background`
    // (the pairing A-4 deliberately declined to validate for contrast) fails
    // here rather than shipping.
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../styles/screens/portfolios.css"),
      "utf8",
    );
    const rule = /\.k-pf-tile\[data-accent\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("box-shadow: inset 0 0 0 2px var(--k-pf-accent, transparent)");
    expect(rule?.[1]).not.toContain("background");
    expect(rule?.[1]).not.toContain("color:");
  });

  it("FR-476 — the row's pencil is labelled « Modifier », not « Renommer »", async () => {
    renderScreen();

    const pencil = await screen.findByTestId("portfolio-rename-button");
    expect(pencil).toHaveAccessibleName("Modifier");
  });

  it("NFR-53 — an icon write bumps only the written row's version, never every mounted tile's", async () => {
    mocked.fetchPortfolios.mockResolvedValue(portfolios(2, { hasIcon: true }));
    mocked.deletePortfolioIcon.mockResolvedValue(undefined);

    renderScreen();

    // Make each row's version *observable*: `PortfolioIconTile` remembers a
    // load failure keyed `${portfolioId}@${iconVersion}`, so a failed tile
    // comes back only if its own version moved. Failing both rows turns "did
    // the bump reach this row?" into a visible yes/no per row.
    await waitFor(() => expect(screen.getAllByTestId("portfolio-icon-image")).toHaveLength(2));
    for (const img of screen.getAllByTestId("portfolio-icon-image")) fireEvent.error(img);
    expect(screen.queryAllByTestId("portfolio-icon-image")).toHaveLength(0);

    fireEvent.click(screen.getAllByTestId("portfolio-rename-button")[0]!);
    await screen.findByTestId("portfolio-form-dialog");
    fireEvent.click(screen.getByTestId("portfolio-icon-remove"));
    fireEvent.click(screen.getByTestId("portfolio-name-form-submit"));

    await waitFor(() => expect(mocked.deletePortfolioIcon).toHaveBeenCalledWith(portfolioIdFor(0)));
    // Exactly one tile came back — the written one. A single screen-wide
    // counter would have remounted both, which on a 12-row screen is one icon
    // write turned into twelve byte requests.
    await waitFor(() => expect(screen.getAllByTestId("portfolio-icon-image")).toHaveLength(1));
    expect(screen.getByTestId("portfolio-icon-image")).toHaveAttribute(
      "src",
      `/api/v1/portfolios/${portfolioIdFor(0)}/icon`,
    );
  });
});

describe("portfolio-archive — the « Archivés » group", () => {
  const ARCHIVED_ID = "c0000000-0000-4000-8000-000000000000";

  function withArchived(active: number): PortfolioSummary[] {
    // Archived first in the server's name order, so it would be row 0 in a flat list.
    return [
      { ...portfolios(1)[0]!, id: ARCHIVED_ID, name: "Ancien compte", archived: true },
      ...portfolios(active),
    ];
  }

  it("AC-488 — with none archived the group is absent", async () => {
    mocked.fetchPortfolios.mockResolvedValue(portfolios(2));
    renderScreen();

    await waitFor(() => expect(screen.getAllByTestId("portfolio-row")).toHaveLength(2));
    expect(screen.queryByTestId("portfolios-archived-group")).toBeNull();
  });

  it("AC-488 — one archived shows a collapsed « Archivés (1) »; expanding shows its row, badged, linking to its detail", async () => {
    mocked.fetchPortfolios.mockResolvedValue(withArchived(2));
    renderScreen();

    const group = await screen.findByTestId("portfolios-archived-group");
    expect(group).toHaveTextContent("Archivés (1)");
    await waitFor(() => expect(screen.getAllByTestId("portfolio-row")).toHaveLength(2));
    expect(screen.queryByText("Ancien compte")).toBeNull();
    const toggle = screen.getByTestId("portfolios-archived-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const archivedList = screen.getByTestId("portfolios-archived-list");
    const link = await waitFor(() => {
      const found = archivedList.querySelector('[data-testid="portfolio-name"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(link).toHaveTextContent("Ancien compte");
    expect(link.getAttribute("href")).toMatch(new RegExp(`^/portfolios/${ARCHIVED_ID}\\?`));
    expect(
      archivedList.querySelector('[data-testid="portfolio-archived-badge"]'),
    ).toHaveTextContent("Archivé");
    // Active rows carry no badge.
    expect(screen.getAllByTestId("portfolio-archived-badge")).toHaveLength(1);
  });

  it("spends the figures bound on active rows: 12 active + 1 archived issues no read for the archived row", async () => {
    mocked.fetchPortfolios.mockResolvedValue(withArchived(DASHBOARD_PORTFOLIO_CARD_LIMIT));
    renderScreen();

    fireEvent.click(await screen.findByTestId("portfolios-archived-toggle"));
    await waitFor(() =>
      expect(screen.getAllByTestId("portfolio-row")).toHaveLength(
        DASHBOARD_PORTFOLIO_CARD_LIMIT + 1,
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("portfolio-row-value")).toHaveLength(
        DASHBOARD_PORTFOLIO_CARD_LIMIT,
      ),
    );
    const requestedIds = mocked.fetchPortfolioOverview.mock.calls.map(([id]) => id);
    expect(requestedIds).not.toContain(ARCHIVED_ID);
    expect(new Set(requestedIds).size).toBe(DASHBOARD_PORTFOLIO_CARD_LIMIT);
    const archivedList = screen.getByTestId("portfolios-archived-list");
    expect(
      archivedList.querySelector('[data-testid="portfolio-row-figures-not-loaded"]'),
    ).not.toBeNull();
  });
});
