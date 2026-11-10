import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { ApiError, type DividendSummary } from "../lib/api-client.js";
import { asIsoDate, asUuid } from "../lib/search-params.js";
import { dividendSummaryQueryOptions } from "../lib/queries.js";
import { DividendsView } from "./DividendsView.js";

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchDividendSummary: vi.fn(),
    fetchPortfolios: vi.fn(),
    listTransactions: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);

/**
 * `DividendsView.test.tsx` — DS-8
 * (AC-283,
 * AC-284, AC-285, AC-286, AC-295, AC-296).
 *
 * Renders the **view**, not the route: `DividendsView` is router-agnostic by
 * design, so this suite never imports `router.js` and never has to resolve
 * `virtual:pwa-register/react`. It still needs a router in the tree, because
 * `PageHeader` renders `<Link>`s.
 *
 * The fixture below is the worked example, verbatim, wire-formatted — the same X/Y/Z
 * figures the ledger integration suite and the API e2e suite already prove at
 * their own layers, so a disagreement between this screen and the number the
 * server computed shows up as a failure here rather than as a support question.
 */
const AIR_LIQUIDE = "11111111-1111-4111-8111-111111111111";
const APPLE = "22222222-2222-4222-8222-222222222222";
const BOUYGUES = "33333333-3333-4333-8333-333333333333";
const PORTFOLIO_P1 = "44444444-4444-4444-8444-444444444444";

function summary(overrides: Partial<DividendSummary> = {}): DividendSummary {
  return {
    baseCurrency: "EUR",
    from: null,
    to: null,
    portfolioId: null,
    total: { grossBase: "192.59", withholdingBase: "13.851" },
    instruments: [
      // Server order: `grossBase` descending, ties by `instrumentId`.
      {
        instrumentId: APPLE,
        displayName: "Apple Inc.",
        symbol: "AAPL",
        hasIcon: false,
        grossBase: "92.34",
        withholdingBase: "13.851",
        paymentCount: 1,
      },
      {
        instrumentId: BOUYGUES,
        displayName: "Bouygues",
        symbol: null,
        hasIcon: false,
        grossBase: "60",
        withholdingBase: "0",
        paymentCount: 1,
      },
      {
        instrumentId: AIR_LIQUIDE,
        displayName: "Air Liquide",
        symbol: "AI",
        hasIcon: false,
        grossBase: "40.25",
        withholdingBase: "0",
        paymentCount: 5,
      },
    ],
    years: [
      { period: "2019", grossBase: "25.5", withholdingBase: "0" },
      { period: "2020", grossBase: "7.25", withholdingBase: "0" },
      { period: "2024", grossBase: "159.84", withholdingBase: "13.851" },
    ],
    months: [
      { period: "2019-01", grossBase: "10", withholdingBase: "0" },
      { period: "2019-03", grossBase: "15.5", withholdingBase: "0" },
      { period: "2020-02", grossBase: "7.25", withholdingBase: "0" },
      { period: "2024-06", grossBase: "159.84", withholdingBase: "13.851" },
    ],
    ...overrides,
  };
}

interface RenderOptions {
  readonly from?: string;
  readonly to?: string;
  readonly portfolio?: string;
  readonly onSearchChange?: (next: unknown) => void;
}

function renderView(options: RenderOptions = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <DividendsView
          from={options.from}
          to={options.to}
          portfolio={options.portfolio}
          today="2026-09-02"
          onSearchChange={options.onSearchChange ?? (() => {})}
        />
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/activity" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The single `Tooltip.Provider` lives at the app root (`AppShell.tsx`), so a
  // component mounted on its own needs one here: the jargon hints this surface
  // renders go through Radix exactly as `<Figure>` does, and
  // Radix throws on first render without an ancestor provider rather than
  // degrading quietly.
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

function rowNames(): string[] {
  return screen.getAllByTestId("dividend-payer-name").map((node) => node.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchPortfolios.mockResolvedValue([]);
  mocked.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
});

describe("<DividendsView> — the four states", () => {
  it("renders the per-panel loading line while the read is in flight, never a page spinner", async () => {
    mocked.fetchDividendSummary.mockReturnValue(new Promise(() => {}));
    renderView();

    const loading = await screen.findByTestId("dividends-loading");
    expect(loading).toHaveTextContent("Chargement des dividendes…");
    expect(screen.queryByTestId("dividend-payers")).not.toBeInTheDocument();
  });

  it("renders the error state with a retry that genuinely re-issues the read", async () => {
    mocked.fetchDividendSummary.mockRejectedValue(
      new ApiError(429, { code: "ADMISSION_BOUND_EXCEEDED" }),
    );
    renderView();

    const state = await screen.findByTestId("dividends-error");
    expect(state).toHaveAttribute("data-empty-state", "read-throttled");
    const callsBefore = mocked.fetchDividendSummary.mock.calls.length;
    fireEvent.click(screen.getByTestId("dividends-error-retry"));
    await waitFor(() =>
      expect(mocked.fetchDividendSummary.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("surfaces the instrument-cap 422 through the same state, and never renders the server's own English detail", async () => {
    // DV6: the server refuses rather than truncating. `ValuationErrorState`
    // maps it through `messageForError`, which never renders the problem
    // document's `detail`/`title` (FR-110/AC120) — so the code name must not
    // appear anywhere on screen.
    mocked.fetchDividendSummary.mockRejectedValue(
      new ApiError(422, {
        code: "DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE",
        detail: "This dividend summary would return 1001 instruments",
        title: "Dividend summary response too large",
      }),
    );
    renderView();

    const state = await screen.findByTestId("dividends-error");
    expect(state.textContent ?? "").not.toContain("DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE");
    expect(state.textContent ?? "").not.toContain("1001 instruments");
    expect(state).toHaveTextContent("Dividendes :");
    // A labelled state with its own French copy, not the bare
    // paragraph carrying the 422 status default this rendered until the fix.
    expect(state).toHaveAttribute("data-empty-state", "valuation-response-too-large");
    expect(state).toHaveTextContent("taille maximale prise en charge");
  });

  /**
   * DV11's refusal, the worst of the two to leave unmapped: it
   * is permanent, it is caused by stored data, and it fires on the all-time
   * DEFAULT view, so the screen is unusable until the transaction is fixed.
   * It gets no catalogued state (none describes a data correction) — so this
   * asserts the other half: the labelled paragraph now carries the code's own
   * French message rather than « Cette opération n'a pas pu aboutir. ».
   */
  it("tells the user the dividend data needs correcting when the tax leg is ambiguous, without echoing identifiers", async () => {
    mocked.fetchDividendSummary.mockRejectedValue(
      new ApiError(422, {
        code: "DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG",
        detail:
          "Instrument 11111111-2222-3333-4444-555555555555 has 1 DIVIDEND posting(s) whose transaction carries a fee_amount",
        title: "Ambiguous dividend tax leg",
      }),
    );
    renderView();

    const state = await screen.findByTestId("dividends-error");
    expect(state).toHaveTextContent("Dividendes :");
    expect(state).toHaveTextContent(/corrigée/);
    expect(state.textContent ?? "").not.toContain("Cette opération n'a pas pu aboutir.");
    // Neither the code, nor the instrument id the problem document carried.
    expect(state.textContent ?? "").not.toContain("DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG");
    expect(state.textContent ?? "").not.toContain("11111111-2222-3333-4444-555555555555");
  });

  it("renders the zero-dividends state, with the reachable action the catalogue names", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(
      summary({
        total: { grossBase: "0", withholdingBase: "0" },
        instruments: [],
        years: [],
        months: [],
      }),
    );
    renderView();

    const state = await screen.findByTestId("dividends-empty");
    expect(state).toHaveAttribute("data-empty-state", "zero-dividends");
    expect(screen.getByTestId("dividends-empty-activity-link")).toHaveAttribute(
      "href",
      "/activity",
    );
    expect(screen.queryByTestId("dividend-payers")).not.toBeInTheDocument();
  });

  it("AC-296's positive companion: a tenant with exactly one dividend renders the payer list, never the empty state", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(
      summary({
        total: { grossBase: "60", withholdingBase: "0" },
        instruments: [
          {
            instrumentId: BOUYGUES,
            displayName: "Bouygues",
            symbol: null,
            hasIcon: false,
            grossBase: "60",
            withholdingBase: "0",
            paymentCount: 1,
          },
        ],
        years: [{ period: "2024", grossBase: "60", withholdingBase: "0" }],
        months: [{ period: "2024-06", grossBase: "60", withholdingBase: "0" }],
      }),
    );
    renderView();

    await screen.findByTestId("dividend-payers");
    expect(screen.queryByTestId("dividends-empty")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("dividend-payer")).toHaveLength(1);
  });

  it("renders the hero, the calendar and the payers from one read — one request", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView();

    await screen.findByTestId("dividend-payers");
    expect(screen.getByTestId("dividend-calendar")).toBeInTheDocument();
    expect(screen.getByTestId("dividend-hero")).toBeInTheDocument();
    // DV4/LD-3(b): one aggregate answers both halves, so there is exactly one
    // request — not one per half, and no client-side scan.
    expect(mocked.fetchDividendSummary).toHaveBeenCalledTimes(1);
  });
});

describe("<DividendsView> — the figures", () => {
  it("AC-283: gross and withholding are two separately-queryable nodes on the same row, and the netted figure appears nowhere", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView();

    await screen.findByTestId("dividend-payers");
    const appleRow = screen
      .getAllByTestId("dividend-payer")
      .find((row) => row.getAttribute("data-instrument-id") === APPLE);
    expect(appleRow).toBeDefined();
    // Read as two keys, not inferred from one.
    expect(within(appleRow!).getByTestId("dividend-payer-gross")).toHaveTextContent("92.34 EUR");
    expect(within(appleRow!).getByTestId("dividend-payer-withholding")).toHaveTextContent(
      "13.85 EUR",
    );
    // 92.34 − 13.851 = 78.489. LD-1: never netted, so it is nowhere on screen.
    expect(screen.getByTestId("dividends-screen").textContent ?? "").not.toContain("78.48");
  });

  it("AC-285: the hero total is the response's own figure, equal to the hand sum 40.25 + 92.34 + 60.00", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView();

    await screen.findByTestId("dividend-payers");
    expect(screen.getByTestId("dividend-total-gross")).toHaveTextContent("192.59 EUR");
    expect(screen.getByTestId("dividend-total-withholding")).toHaveTextContent("13.85 EUR");
  });

  it("AC-286: with no period selected the request carries no date predicate at all, and a >5-year-old row still counts", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView();

    await screen.findByTestId("dividend-payers");
    // The all-time default is the *absence* of a bound — not a wide window.
    // A `1Y`-defaulting control would have sent one and dropped rows 1/2/4.
    expect(mocked.fetchDividendSummary).toHaveBeenCalledWith(
      { from: undefined, to: undefined, portfolio: undefined },
      expect.anything(),
    );
    // Row 1 (2019-01-15) is in the shown total: 2019 is a chart bucket and the
    // combined total is the all-time one, not a trailing-window one.
    expect(screen.getByTestId("dividend-total-gross")).toHaveTextContent("192.59 EUR");
    expect(
      screen.getAllByTestId("dividend-calendar-year").map((row) => row.getAttribute("data-year")),
    ).toContain("2019");
  });

  it("AC-284 as amended: the list is the server's gross-descending order over the non-monotonic fixture, and there is no sort control", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView();

    await screen.findByTestId("dividend-payers");
    expect(rowNames()).toEqual(["Apple Inc.", "Bouygues", "Air Liquide"]);
    // The French-collated name order (Air Liquide → Apple Inc. → Bouygues) is
    // neither this order nor its reverse, so a component that re-sorted by
    // name, or by a differently-ordered fixture's insertion order, fails here.
    expect(screen.queryByTestId("dividends-sort-name")).toBeNull();
    expect(screen.queryByTestId("dividends-sort-gross")).toBeNull();
  });

  it("counts payments per instrument, and the hero's count is their sum — an integer partition, not a money re-sum", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView();

    await screen.findByTestId("dividend-payers");
    const airLiquide = screen
      .getAllByTestId("dividend-payer")
      .find((row) => row.getAttribute("data-instrument-id") === AIR_LIQUIDE);
    expect(within(airLiquide!).getByTestId("dividend-payer-count")).toHaveTextContent("5");
    // 1 + 1 + 5: each DIVIDEND row has exactly one instrument, so the
    // per-instrument distinct counts partition the payments.
    expect(screen.getByTestId("dividend-payment-count")).toHaveTextContent("7");
    expect(screen.getByTestId("dividend-instrument-count")).toHaveTextContent("3");
    // No footer row, no « Total » label: the hero is the total.
    expect(screen.queryByTestId("dividend-table-total")).toBeNull();
  });
});

describe("<DividendsView> — the selected month's payments", () => {
  it("AC-LIST-1/2: at rest the latest month is selected and listed with one read for exactly that month; hover previews without a request; a click re-scopes the list", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({ portfolio: PORTFOLIO_P1 });

    await screen.findByTestId("dividend-payers");
    const list = await screen.findByTestId("dividend-month-list");
    expect(list).toHaveAttribute("data-period", "2024-06");
    expect(mocked.listTransactions).toHaveBeenCalledTimes(1);
    expect(mocked.listTransactions.mock.calls[0]?.[0]).toEqual({
      kind: "DIVIDEND",
      from: "2024-06-01",
      to: "2024-06-30",
      order: "desc",
      portfolio: PORTFOLIO_P1,
      cursor: undefined,
    });

    const cellOf = (period: string) =>
      document.querySelector(`[data-testid="dividend-calendar-cell"][data-period="${period}"]`)!;
    for (const period of ["2019-01", "2019-03", "2020-02"]) fireEvent.mouseEnter(cellOf(period));
    expect(screen.getByTestId("dividend-calendar-detail")).toHaveTextContent("Février 2020");
    expect(mocked.listTransactions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("dividend-month-list")).toHaveAttribute("data-period", "2024-06");

    fireEvent.click(cellOf("2019-03"));
    await waitFor(() =>
      expect(screen.getByTestId("dividend-month-list")).toHaveAttribute("data-period", "2019-03"),
    );
    expect(mocked.listTransactions).toHaveBeenCalledTimes(2);
    expect(mocked.listTransactions.mock.calls[1]?.[0]).toMatchObject({
      from: "2019-03-01",
      to: "2019-03-31",
    });
  });
});

describe("<DividendsView> — the period and portfolio filters (LD-5/LD-6, FR-272/FR-273)", () => {
  it("puts the resolved window on the search state, never a preset id (DV9)", async () => {
    const onSearchChange = vi.fn();
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({ onSearchChange });

    await screen.findByTestId("dividend-payers");
    fireEvent.click(screen.getByTestId("dividend-period-option-PREV_2"));
    expect(onSearchChange).toHaveBeenCalledWith({
      from: "2024-01-01",
      to: "2024-12-31",
      portfolio: undefined,
    });
  });

  it("lights the preset the URL's window resolves to, and «Personnalisée…» for one no preset produces", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({ from: "2025-01-01", to: "2025-12-31" });

    await screen.findByTestId("dividend-payers");
    expect(screen.getByTestId("dividend-period-option-PREV_1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("dividend-period-option-ALL")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows one-word tokens but announces the spelled-out period (the compaction's own property)", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    // `renderView` already pins today to 2026-09-02.
    renderView();

    await screen.findByTestId("dividend-payers");
    // Seven spelled-out buttons wrapped this header onto three lines; the
    // visible token is now one word and the sentence moved to the accessible
    // name, which is what keeps the abbreviation from costing anything.
    const all = screen.getByTestId("dividend-period-option-ALL");
    expect(all.textContent).toBe("Tout");
    expect(all).toHaveAttribute("aria-label", "Depuis le début");
    expect(all).toHaveAttribute("title", "Depuis le début");

    const ytd = screen.getByTestId("dividend-period-option-YTD");
    expect(ytd.textContent).toBe("2026");
    // …and "2026" beside "2025" cannot be read as the whole of 2026, because
    // the name says where it starts and that it runs to today.
    expect(ytd).toHaveAttribute("aria-label", "Depuis le 1er janvier 2026");

    expect(screen.getByTestId("dividend-period-option-CUSTOM").textContent).toBe("Perso.");
    expect(screen.getByTestId("dividend-period-option-CUSTOM")).toHaveAttribute(
      "aria-label",
      "Personnalisée…",
    );
  });

  it("reveals the two date fields for a window no preset produces, without the user pressing anything", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({ from: "2024-03-01", to: "2024-06-30" });

    await screen.findByTestId("dividend-payers");
    expect(screen.getByTestId("dividend-period-custom")).toBeInTheDocument();
    expect(screen.getByTestId("dividend-period-option-CUSTOM")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("«Personnalisée…» opens the fields without changing the applied window", async () => {
    const onSearchChange = vi.fn();
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({ onSearchChange });

    await screen.findByTestId("dividend-payers");
    expect(screen.queryByTestId("dividend-period-custom")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dividend-period-option-CUSTOM"));
    expect(screen.getByTestId("dividend-period-custom")).toBeInTheDocument();
    // A preset that resolved to a window of its own would have overwritten the
    // dates a bookmark carried.
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it("sends the portfolio filter through as `portfolio`, and «Tous les portefeuilles» clears it (LD-5)", async () => {
    const onSearchChange = vi.fn();
    mocked.fetchPortfolios.mockResolvedValue([
      {
        id: PORTFOLIO_P1,
        name: "PEA",
        transactionCount: 8,
        createdAt: "2024-01-01T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
        archived: false,
      },
    ]);
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({ onSearchChange });

    await screen.findByTestId("dividend-payers");
    await waitFor(() => expect(screen.getByText("PEA")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("dividends-filter-portfolio"), {
      target: { value: PORTFOLIO_P1 },
    });
    expect(onSearchChange).toHaveBeenCalledWith({
      from: undefined,
      to: undefined,
      portfolio: PORTFOLIO_P1,
    });
  });

  it("threads a selected portfolio into the request itself, not only into the URL", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(
      summary({
        portfolioId: PORTFOLIO_P1,
        total: { grossBase: "189.59", withholdingBase: "13.851" },
      }),
    );
    renderView({ portfolio: PORTFOLIO_P1 });

    await screen.findByTestId("dividend-payers");
    expect(mocked.fetchDividendSummary).toHaveBeenCalledWith(
      { from: undefined, to: undefined, portfolio: PORTFOLIO_P1 },
      expect.anything(),
    );
  });

  describe("portfolio-archive — the portfolio filter", () => {
    const ARCHIVED_ID = "a0000000-0000-4000-8000-0000000000aa";

    beforeEach(() => {
      const base = {
        transactionCount: 8,
        createdAt: "2024-01-01T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
      };
      mocked.fetchPortfolios.mockResolvedValue([
        { ...base, id: PORTFOLIO_P1, name: "PEA", archived: false },
        { ...base, id: ARCHIVED_ID, name: "Ancien CTO", archived: true },
      ]);
      mocked.fetchDividendSummary.mockResolvedValue(summary());
    });

    function filterOptions(): [string, string][] {
      const select = screen.getByTestId("dividends-filter-portfolio") as HTMLSelectElement;
      return Array.from(select.options).map((option) => [option.value, option.text]);
    }

    it("AC-486: an archived portfolio is not an option when the filter is empty or another portfolio", async () => {
      for (const portfolio of [undefined, PORTFOLIO_P1]) {
        renderView(portfolio === undefined ? {} : { portfolio });
        await screen.findByTestId("dividend-payers");
        await waitFor(() =>
          expect(filterOptions().map(([value]) => value)).toContain(PORTFOLIO_P1),
        );
        expect(filterOptions().map(([value]) => value)).toEqual(["", PORTFOLIO_P1]);
        cleanup();
      }
    });

    it("AC-487 / PA-L10: preset to it, it is listed once, suffixed, and selected", async () => {
      renderView({ portfolio: ARCHIVED_ID });
      await screen.findByTestId("dividend-payers");
      await waitFor(() =>
        expect(filterOptions()).toContainEqual([ARCHIVED_ID, "Ancien CTO (archivé)"]),
      );
      expect(filterOptions().filter(([value]) => value === ARCHIVED_ID)).toHaveLength(1);
      expect(screen.getByTestId("dividends-filter-portfolio")).toHaveValue(ARCHIVED_ID);
    });
  });
});

describe("the search-param primitives degrade a hand-edited URL to the all-time default", () => {
  /**
   * DS-7's own acceptance criterion asks for this **rendered**, from the real
   * route. `DividendsRoute.tsx` imports `router.js`, which cannot be loaded
   * under `vitest` at all — `AppShell.tsx` -> `UpdateToast.tsx` ->
   * `virtual:pwa-register/react` fails at *transform* time, before any
   * `vi.mock` could intercept it (this repo's own recorded constraint, cited by
   * five existing suites). So the chain is proved in two links instead, with no
   * copy of the validator anywhere: `router.test.ts` asserts by source text
   * that `dividendsRoute` maps all three params through these exact shipped
   * primitives, and this test feeds those primitives' **real** output into the
   * real view.
   */
  it("renders the unbounded, unfiltered screen for ?from=not-a-date&to=2024-13-45&portfolio=nope", async () => {
    mocked.fetchDividendSummary.mockResolvedValue(summary());
    renderView({
      from: asIsoDate("not-a-date"),
      to: asIsoDate("2024-13-45"),
      portfolio: asUuid("nope"),
    });

    await screen.findByTestId("dividend-payers");
    expect(mocked.fetchDividendSummary).toHaveBeenCalledWith(
      { from: undefined, to: undefined, portfolio: undefined },
      expect.anything(),
    );
    expect(screen.getByTestId("dividend-period-option-ALL")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Nothing blanked and no error boundary content: the screen is on screen.
    expect(screen.getByTestId("dividends-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("dividends-error")).not.toBeInTheDocument();
  });
});

describe("the query key comes from the barrel (DS-6)", () => {
  it("dividendSummaryQueryOptions is importable from lib/queries.js and keys on the params", () => {
    // DS-6's own acceptance criterion: the barrel re-export is exercised by a
    // real import in a later task's test, not merely declared.
    expect(dividendSummaryQueryOptions({ from: "2024-01-01" }).queryKey).toEqual([
      "dividends",
      "summary",
      { from: "2024-01-01" },
    ]);
  });

  it("sets retry: false — this screen's 422s are permanent, and « réessayer n'y changera rien » must not arrive after three silent retries", () => {
    // Asserted the way every sibling factory's own flag is
    // (`lib/queries.test.ts`: `portfolioOverviewQueryOptions`,
    // `transactionsListQueryOptions`, `incomeTotalsQueryOptions`), because it
    // is load-bearing on shipped copy: `DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG`'s
    // message (`problem-messages.ts`) states outright that retrying changes
    // nothing, so the default 3-attempt backoff would delay a sentence that
    // denies retrying is happening — while re-walking the same join each time.
    expect(dividendSummaryQueryOptions().retry).toBe(false);
    expect(dividendSummaryQueryOptions({ portfolio: "p-1" }).retry).toBe(false);
  });
});
