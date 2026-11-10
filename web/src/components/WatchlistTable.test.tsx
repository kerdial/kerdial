import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { WatchlistRow } from "../lib/api-client.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { EMPTY_STATE_COPY } from "../lib/empty-states.js";
import { WatchlistTable, sparklineData } from "./WatchlistTable.js";

/**
 * `<WatchlistTable>` — UR-48,
 * UR-49, UR-54(b), UR-57, FR-344, FR-345, FR-346, FR-354, FR-357.
 *
 * Every fetcher on the api-client barrel that this tree could reach is mocked,
 * because the sharpest assertion in this file is a **negative** one: FR-357's
 * row sparkline is fed from the row's own embedded series, so rendering N rows
 * must cost **zero** requests. `<InstrumentPriceSparkline>` would have fetched
 * `GET /instruments/:id/prices` with a per-window page cap — up to 4N cheap
 * reads, ~800 at the 200-row cap — which is the fan-out FR-362 rejects arriving
 * through the back door. Every absence assertion below is paired with a
 * positive one (the shape actually rendered), so "nothing was called" cannot
 * pass because nothing rendered.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchWatchlist: vi.fn(),
    fetchWatchedInstrumentIds: vi.fn(),
    fetchHoldings: vi.fn(),
    listInstrumentPrices: vi.fn(),
    listInstrumentPriceWindow: vi.fn(),
    fetchInstrument: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    patchWatchlistItem: vi.fn(),
    postWatchlistItem: vi.fn(),
    deleteWatchlistItem: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);

const APPLE = "11111111-1111-4111-8111-111111111111";
const SAP = "22222222-2222-4222-8222-222222222222";

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
    targetPrice: "250.00",
    note: "surveiller le T3",
    currentPrice: valued("198.20"),
    dayChange: "1.20",
    dayChangePercent: "0.0061",
    metrics: {
      unusableSeries: false,
      periodReturns: { "1Y": "0.1234", "3M": "-0.0456" },
      fiftyTwoWeek: {
        high: "220.00",
        low: "150.00",
        highDate: "2026-07-01",
        lowDate: "2025-10-02",
        distanceFromHigh: "-0.0991",
      },
      maxDrawdown: { fraction: "-0.25", peakDate: "2026-07-01", troughDate: "2026-08-01" },
      annualisedVolatility: "0.31",
    },
    series: [
      { date: "2026-08-01", close: "180.00" },
      { date: "2026-08-15", close: "190.00" },
      { date: "2026-09-01", close: "198.20" },
    ],
    ...overrides,
  };
}

interface RenderOptions {
  readonly rows?: readonly WatchlistRow[];
  readonly window?: string;
  readonly watchedIds?: ReadonlySet<string>;
  /** Renders the table as the screen does while `GET /watchlist/ids` is still in flight — `watchedIds` genuinely `undefined`, which a defaulted option object cannot express. */
  readonly watchedIdsUnknown?: boolean;
}

function renderTable(options: RenderOptions = {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <WatchlistTable
          rows={options.rows ?? [row()]}
          window={options.window ?? "1Y"}
          watchedIds={
            options.watchedIdsUnknown === true
              ? undefined
              : (options.watchedIds ?? new Set([APPLE, SAP]))
          }
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<WatchlistTable> — one row per watched instrument (UR-48/UR-49)", () => {
  it("renders the identity, the price with its provenance, and every figure the row carries", async () => {
    renderTable({ window: "3M" });

    expect(await screen.findAllByTestId("watchlist-table-row")).toHaveLength(1);
    expect(screen.getByTestId("watchlist-display-name")).toHaveTextContent("Apple Inc");
    // The name opens the instrument's own analysis screen and carries
    // the window along; the eye link is what still opens the catalogue detail.
    expect(screen.getByTestId("watchlist-display-name")).toHaveAttribute(
      "href",
      `/watchlist/${APPLE}?window=3M`,
    );
    expect(screen.getByTestId("watchlist-row-chart")).toHaveAttribute(
      "href",
      `/watchlist/${APPLE}?window=3M`,
    );
    expect(screen.getByTestId("watchlist-row-chart")).toHaveAccessibleName("Analyser Apple Inc");
    // The « Type » and « Position » columns left the row, the
    // 52-week range and the editor — they are the analysis
    // screen's, not the list's. The target stays, read-only.
    expect(screen.queryByTestId("watchlist-kind")).not.toBeInTheDocument();
    expect(screen.queryByTestId("watchlist-position")).not.toBeInTheDocument();
    expect(screen.queryByTestId("watchlist-fifty-two-week")).not.toBeInTheDocument();
    expect(screen.queryByTestId("watchlist-edit-open")).not.toBeInTheDocument();
    expect(screen.getByTestId("watchlist-target")).toHaveTextContent("250.00 USD");
    // FR-344: the last price renders through `<Figure>`, which is also where
    // the freshness/provenance treatment comes from — no second vocabulary.
    expect(screen.getByTestId("watchlist-last-price")).toHaveTextContent("198.20 USD");
    // The header declares seven columns and the count footer states the one
    // row — cardinality before the per-cell checks above mean anything.
    expect(screen.getByTestId("watchlist-table-header").children).toHaveLength(7);
    expect(screen.getByTestId("watchlist-table-count")).toHaveTextContent("1 instrument suivi");
  });

  it("reads the SELECTED window's return, not a fixed one (one key per screen state)", async () => {
    renderTable({ window: "3M" });
    await screen.findByTestId("watchlist-table-row");
    // -0.0456 as a percentage, with the true minus `figure-format.ts`
    // substitutes — the 1Y value (+12.34 %) must not be what shows.
    expect(screen.getByTestId("watchlist-period-return")).toHaveTextContent("4.56");
    expect(screen.getByTestId("watchlist-period-return")).not.toHaveTextContent("12.34");
    expect(screen.getByTestId("watchlist-period-return")).toHaveAttribute("data-sign", "loss");
  });

  it("states an unavailable metric as unavailable — never « 0 % » (W-10/AC-331)", async () => {
    renderTable({
      window: "5Y",
      rows: [
        row({
          dayChangePercent: undefined,
          targetPrice: null,
          metrics: { unusableSeries: false, periodReturns: {} },
        }),
      ],
    });
    await screen.findByTestId("watchlist-table-row");

    for (const testId of [
      "watchlist-period-return",
      "watchlist-day-change",
      "watchlist-distance-from-high",
    ]) {
      const cell = screen.getByTestId(testId);
      expect(cell).toHaveTextContent(WATCHLIST_COPY.unavailable);
      // The failure this guards: a `?? 0` anywhere on the path would render a
      // figure the server declined to produce.
      expect(cell.textContent ?? "").not.toContain("0,00");
      expect(cell).not.toHaveAttribute("data-sign");
    }
    // Positive companion: the row itself rendered, with the price it does have.
    expect(screen.getByTestId("watchlist-last-price")).toHaveTextContent("198.20 USD");
    // An unset target is a dash on the row — the sentence is the
    // analysis screen's editor's.
    expect(screen.getByTestId("watchlist-target")).toHaveTextContent(
      WATCHLIST_COPY.targetPriceNone,
    );
  });

  it("carries a sign-aware French label beside every tinted figure — visually hidden on the one-line row, still read aloud (UR-57)", async () => {
    renderTable();
    await screen.findByTestId("watchlist-table-row");

    const dayLabel = screen.getByTestId("watchlist-day-change-label");
    expect(dayLabel).toHaveTextContent(WATCHLIST_COPY.changeGain);
    expect(dayLabel).toHaveClass("k-visually-hidden");
    expect(screen.getByTestId("watchlist-day-change")).toHaveAttribute("data-sign", "gain");
    // The trend icon replaces the visible word, so direction is still not
    // colour-only: `<DeltaValue showIcon>` draws it inside the cell.
    expect(screen.getByTestId("watchlist-day-change").querySelector("svg")).not.toBeNull();
    // A fall says so in words, and the words come from the sign of the **raw
    // decimal**, never from sniffing the formatted text.
    expect(screen.getByTestId("watchlist-distance-from-high-label")).toHaveTextContent(
      WATCHLIST_COPY.changeLoss,
    );
    expect(screen.getByTestId("watchlist-distance-from-high")).toHaveAttribute("data-sign", "loss");
  });

  it("renders the row's own un-watch toggle, and the reload + open-instrument actions behind the ⋯ menu (FR-345/FR-374)", async () => {
    renderTable();
    await screen.findByTestId("watchlist-table-row");

    const toggle = screen.getByTestId("watchlist-row-watch");
    expect(toggle).toHaveAttribute("data-watched", "true");
    expect(toggle).toHaveAccessibleName(WATCHLIST_COPY.watchRemove);

    // Closed by default: a menu that rendered its items always would be the
    // four-control cell this change removes, only hidden.
    expect(screen.queryByTestId("watchlist-row-menu")).not.toBeInTheDocument();
    const trigger = screen.getByTestId("watchlist-row-menu-trigger");
    expect(trigger).toHaveAccessibleName("Actions pour Apple Inc");
    fireEvent.click(trigger);

    const menu = screen.getByTestId("watchlist-row-menu");
    expect(menu).toHaveAttribute("role", "menu");
    expect(screen.getByTestId("watchlist-row-reload")).toHaveTextContent(
      INSTRUMENT_COPY.reloadHistory,
    );
    expect(screen.getByTestId("watchlist-row-open")).toHaveAttribute(
      "href",
      `/instruments/${APPLE}`,
    );

    // Escape closes it — a real unmount, not a hidden subtree.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("watchlist-row-menu")).not.toBeInTheDocument();
  });

  it("offers no reload in an SCPI row's ⋯ menu, and keeps it in a SHARE row's", async () => {
    renderTable({
      rows: [row(), row({ instrumentId: SAP, kind: "SCPI", displayName: "Corum Origin" })],
    });
    const [share, scpi] = await screen.findAllByTestId("watchlist-table-row");

    fireEvent.click(within(scpi!).getByTestId("watchlist-row-menu-trigger"));
    expect(within(scpi!).getByTestId("watchlist-row-menu")).toBeInTheDocument();
    expect(within(scpi!).getByTestId("watchlist-row-open")).toBeInTheDocument();
    expect(within(scpi!).queryByTestId("watchlist-row-reload")).not.toBeInTheDocument();

    fireEvent.click(within(share!).getByTestId("watchlist-row-menu-trigger"));
    expect(within(share!).getByTestId("watchlist-row-reload")).toHaveTextContent(
      INSTRUMENT_COPY.reloadHistory,
    );
  });

  it("passes the toggle's UNKNOWN state through when the ids read has no data", async () => {
    renderTable({ watchedIdsUnknown: true });
    await screen.findByTestId("watchlist-table-row");

    const toggle = screen.getByTestId("watchlist-row-watch");
    expect(toggle).toHaveAccessibleName(WATCHLIST_COPY.watchStateUnknown);
    expect(toggle).not.toHaveAccessibleName(WATCHLIST_COPY.watchAdd);
  });
});

describe("<WatchlistTable> — the sparkline costs nothing (FR-357)", () => {
  it("draws the row's embedded series and issues NO request of any kind", async () => {
    renderTable({ rows: [row(), row({ instrumentId: SAP, displayName: "SAP SE" })] });
    await screen.findAllByTestId("watchlist-table-row");

    // Positive first: two rows, two shapes, each with an accessible name.
    const trends = screen.getAllByTestId("watchlist-trend");
    expect(trends).toHaveLength(2);
    expect(trends[0]?.querySelector("svg")?.getAttribute("aria-label") ?? "").toContain(
      "Apple Inc",
    );
    expect(trends[0]?.querySelector("polyline")).not.toBeNull();

    // The negative half, and the point of this file's mock: **no** price read,
    // no instrument read, no watchlist read. A row that mounted
    // `<InstrumentPriceSparkline>`/`instrumentPriceWindowQueryOptions` instead
    // would fire up to 4 cheap reads per row.
    expect(mocked.listInstrumentPriceWindow).not.toHaveBeenCalled();
    expect(mocked.listInstrumentPrices).not.toHaveBeenCalled();
    expect(mocked.fetchInstrument).not.toHaveBeenCalled();
    expect(mocked.fetchInstrumentHistoryStatus).not.toHaveBeenCalled();
    expect(mocked.fetchWatchlist).not.toHaveBeenCalled();
    expect(mocked.fetchWatchedInstrumentIds).not.toHaveBeenCalled();
  });

  it("says a one-point series is too short rather than drawing a degenerate line", async () => {
    renderTable({ rows: [row({ series: [{ date: "2026-09-01", close: "198.20" }] })] });
    await screen.findByTestId("watchlist-table-row");

    expect(screen.getByTestId("watchlist-trend")).toHaveTextContent(WATCHLIST_COPY.seriesTooShort);
    expect(screen.getByTestId("watchlist-trend").querySelector("svg")).toBeNull();
  });
});

describe("sparklineData — the only decimal→float conversion on this screen", () => {
  it("keeps the series in its own chronological order, past ten points", () => {
    // The failure this pins: `toValuePointSeries` sorts by `date` as a
    // **string**, so a synthetic index (`"0"`, `"1"`, … `"10"`) would order the
    // points 0, 1, 10, 11, 2, … and draw a shape that is not the series. ISO
    // dates sort correctly under the same comparison.
    const series = Array.from({ length: 12 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      close: String(index + 1),
    }));
    expect(sparklineData(series)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("drops a malformed decimal rather than throwing out of a render", () => {
    expect(
      sparklineData([
        { date: "2026-08-01", close: "1" },
        { date: "2026-08-02", close: "NaN" },
        { date: "2026-08-03", close: "3" },
      ]),
    ).toEqual([1, 3]);
  });
});

describe("<WatchlistTable> — a row with no price at all (UR-54(b)/AC-344)", () => {
  it("states the zero-price state in its own words, and still renders the row", async () => {
    renderTable({
      rows: [row({ currentPrice: undefined, dayChangePercent: undefined })],
    });
    await screen.findByTestId("watchlist-table-row");

    const state = await screen.findByTestId("watchlist-row-no-price");
    expect(state).toHaveAttribute("data-empty-state", "watchlist-row-no-price");
    expect(screen.getByTestId("watchlist-row-no-price-title")).toHaveTextContent(
      EMPTY_STATE_COPY["watchlist-row-no-price"].title,
    );
    // Distinct copy from the empty-list state — AC-344's actual requirement.
    expect(state.textContent ?? "").not.toContain(EMPTY_STATE_COPY["watchlist-empty"].title);
    // The row is still a row: the identity and the toggle are there.
    expect(screen.getByTestId("watchlist-display-name")).toHaveTextContent("Apple Inc");
    expect(screen.getByTestId("watchlist-row-watch")).toBeInTheDocument();
  });

  it("does not render that state for a priced row (the positive companion)", async () => {
    renderTable();
    await screen.findByTestId("watchlist-table-row");
    expect(screen.queryByTestId("watchlist-row-no-price")).not.toBeInTheDocument();
    expect(screen.getByTestId("watchlist-last-price")).toHaveTextContent("198.20 USD");
  });

  it("says an unusable series is unusable — a different fact from a short one", async () => {
    renderTable({
      rows: [row({ metrics: { unusableSeries: true, periodReturns: {} } })],
    });
    await screen.findByTestId("watchlist-table-row");
    expect(screen.getByTestId("watchlist-unusable-series")).toHaveTextContent(
      WATCHLIST_COPY.unusableSeries,
    );
  });
});
