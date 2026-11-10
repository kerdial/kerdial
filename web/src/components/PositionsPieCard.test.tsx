import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HoldingResponse, HoldingsResponse } from "../lib/api-client.js";
import { computeAllocation } from "../lib/allocation.js";
import { OVERVIEW_COPY } from "../lib/copy/overview.js";
import { Decimal } from "@kerdial/core-decimal";
import { formatUnitsAsPercentage } from "../lib/allocation.js";
import { allocationInputOf, CASH_ROW_ID } from "../lib/cash-position.js";
import {
  POSITIONS_PIE_LEGEND_ROWS,
  POSITIONS_PIE_MIN_NAMED,
  POSITIONS_PIE_MIN_SHARE_PERCENT,
  PositionsPieCard,
  legendRows,
  pieSlices,
  sliceCode,
} from "./PositionsPieCard.js";

/**
 * `PositionsPieCard` — the dashboard's positions pie. What is pinned:
 * every share is the **apportioned** one (`units`/`percentageText` from the
 * real `computeAllocation`, never re-derived), the order is largest first, the
 * tail below the 2 % bar is one « Autres positions » segment whose share is
 * the exact sum of its rows' units, and the two honest absences (no holdings;
 * no reconcilable total) are stated rather than drawn.
 *
 * The ring is the legend: the arcs carry the code (ticker, else
 * monogram) and the icon, hovering an arc puts the details in the centre, and
 * an arc is the link to the instrument the legend row used to be. The legend
 * rows are still in the DOM (visually hidden) and still the text read here.
 */

function valued(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function holding(
  id: string,
  name: string,
  value: string,
  kind = "SHARE",
  extra: Partial<Pick<HoldingResponse, "symbol" | "hasIcon">> = {},
): HoldingResponse {
  return {
    instrumentId: id,
    kind,
    displayName: name,
    symbol: null,
    hasIcon: false,
    ...extra,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: "FR",
    quantity: "1",
    currency: "EUR",
    pmp: valued("1"),
    costBasis: valued("1"),
    currentPrice: valued(value),
    currentValue: valued(value),
    unrealizedGainLoss: valued("0"),
    realizedGains: [],
  };
}

function response(holdings: readonly HoldingResponse[], total: string): HoldingsResponse {
  return {
    asOfDate: "2026-09-11",
    holdings,
    totalValue: valued(total),
    totalUnrealizedGainLoss: valued("0"),
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "1",
    portfolioCount: 1,
  };
}

/** The routes' own input (`allocationInputOf`): the holdings, plus the « Liquidités » row when the cash block is non-zero. */
function allocationOf(data: HoldingsResponse) {
  return computeAllocation(allocationInputOf(data));
}

function withCash(data: HoldingsResponse, totalBase: string): HoldingsResponse {
  return {
    ...data,
    cash: {
      totalBase,
      currency: "EUR",
      isNegative: totalBase.startsWith("-"),
      unconverted: [],
      byCurrency: [],
    },
  };
}

/**
 * jsdom has no `matchMedia`; the card reads `TABLET_BREAKPOINT_QUERY` to pick
 * the ring's size. `true` is the wide ring — the geometry every
 * expectation below was written against.
 */
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

function renderCard(data: HoldingsResponse | undefined, total = "0") {
  const allocation = allocationOf(data ?? response([], total));
  const client = new QueryClient();
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PositionsPieCard holdings={data} allocation={allocation} />,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
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
  return router;
}

/** The arcs, in drawing order — `DonutAllocation`'s labelled ring gives each one a test id and its slice key. */
function arcs() {
  return screen.getAllByTestId("positions-pie-arc");
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("<PositionsPieCard> — shares are the apportioned ones, largest first", () => {
  it("draws one arc and one legend row per position, ordered by share, with the apportioned percentage and the value", async () => {
    const data = response(
      [
        holding(A, "Small Co", "100.00"),
        holding(B, "Big Co", "600.00"),
        holding(C, "Mid Co", "300.00"),
      ],
      "1000.00",
    );
    renderCard(data);

    await screen.findByTestId("positions-pie-card");
    const names = screen.getAllByTestId("positions-pie-name").map((node) => node.textContent);
    expect(names).toEqual(["Big Co", "Mid Co", "Small Co"]);
    const percents = screen.getAllByTestId("positions-pie-percent").map((node) => node.textContent);
    // `computeAllocation`'s own `percentageText`, verbatim — not a figure this
    // card divided out of the amounts.
    const allocation = allocationOf(data);
    const expected = [B, C, A].map(
      (id) => allocation.rows.find((row) => row.instrumentId === id)?.percentageText,
    );
    expect(percents).toEqual(expected);
    expect(screen.getAllByTestId("positions-pie-value")[0]).toHaveTextContent("600.00 EUR");
    // The ring is one labelled group of named arcs, largest first, and
    // the legend rows are text only — the arcs are the links now.
    const graphic = screen.getByRole("group", { name: OVERVIEW_COPY.positionsPieDonut });
    expect(graphic.querySelectorAll("circle")).toHaveLength(4); // track + 3 arcs
    expect(arcs().map((arc) => arc.getAttribute("data-kind"))).toEqual([B, C, A]);
    expect(screen.getAllByTestId("positions-pie-name")[0]).not.toHaveAttribute("href");
    // The total left the head (it is the hero's figure); the head links
    // to Positions instead.
    expect(screen.queryByTestId("positions-pie-total")).not.toBeInTheDocument();
    expect(screen.getByTestId("positions-pie-link")).toHaveAttribute("href", "/holdings");
  });

  it("makes each position's arc a named link to its instrument, and « Autres » an arc that goes nowhere", async () => {
    // Three positions clear 2 % (40/30/27), two do not (1.5/1.5): three arcs
    // and a two-position tail.
    const holdings = [400, 300, 270, 15, 15].map((value, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        String(value),
      ),
    );
    const total = holdings.reduce((sum, h) => sum + Number.parseInt(h.currentValue.amount, 10), 0);
    const data = response(holdings, String(total));
    const router = renderCard(data);
    await screen.findByTestId("positions-pie-card");

    const allocation = allocationOf(data);
    const first = holdings[0]!;
    const firstPercent = allocation.rows.find(
      (row) => row.instrumentId === first.instrumentId,
    )?.percentageText;
    const link = screen.getByRole("link", { name: `Position 1, ${firstPercent ?? ""}` });
    expect(link).toBe(arcs()[0]);
    expect(link).toHaveAttribute("tabindex", "0");
    // The tail is a share of the total, not a position: no link, still named.
    const others = arcs()[arcs().length - 1]!;
    expect(others).toHaveAttribute("role", "img");
    expect(others.getAttribute("aria-label")).toMatch(OVERVIEW_COPY.positionsPieOthers);
    // Enter on the focused arc navigates, exactly as the legend link did.
    fireEvent.keyDown(link, { key: "Enter" });
    expect(router.state.location.pathname).toBe(`/instruments/${first.instrumentId}`);
  });

  it("labels an arc with the ticker, else the display name's monogram, draws no marker around the ring, and puts the logo in the legend row only where there is one", async () => {
    const data = response(
      [
        holding(A, "Air Liquide", "500.00", "SHARE", { symbol: "AI.PA", hasIcon: true }),
        holding(B, "Big Company Without Ticker", "500.00"),
      ],
      "1000.00",
    );
    renderCard(data);
    await screen.findByTestId("positions-pie-card");

    const slices = screen.getAllByTestId("positions-pie-slice");
    const airLiquide = slices.find((slice) => slice.getAttribute("data-kind") === A)!;
    const bigCo = slices.find((slice) => slice.getAttribute("data-kind") === B)!;
    expect(airLiquide.querySelector(".k-donut-slice-code")).toHaveTextContent("AI.PA");
    expect(bigCo.querySelector(".k-donut-slice-code")).toHaveTextContent("BIG");
    // No code carries the icon, and no marker sits outside the ring
    // either: the ring is arcs and codes, and its box has no marker outset.
    expect(airLiquide.querySelector("img")).toBeNull();
    expect(bigCo.querySelector("img")).toBeNull();
    expect(screen.queryByTestId("positions-pie-marker")).not.toBeInTheDocument();
    expect(screen.getByTestId("positions-pie-box")).toHaveStyle({ width: "240px", padding: "0px" });
    // Codes are decoration: the arc's own name is what is announced.
    expect(airLiquide).toHaveAttribute("aria-hidden", "true");
    // The legend row leads with the logo, and only where there is one —
    // the other row's icon cell is empty, so no request (FR-314).
    const rowIcons = screen.getAllByTestId("positions-pie-row-icon");
    expect(rowIcons[0]!.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining(`/instruments/${A}/icon`),
    );
    expect(rowIcons[1]!.querySelector("img")).toBeNull();
  });

  it("puts the hovered arc's name, apportioned percentage and value in the centre, and the count back on leave", async () => {
    const data = response(
      [
        holding(A, "Air Liquide", "600.00", "SHARE", { symbol: "AI.PA" }),
        holding(B, "Big Co", "400.00"),
      ],
      "1000.00",
    );
    renderCard(data);
    await screen.findByTestId("positions-pie-card");
    const center = () => screen.getByTestId("positions-pie-center");
    expect(center()).toHaveTextContent("2 positions");

    fireEvent.mouseEnter(arcs()[0]!);
    expect(center()).toHaveTextContent("Air Liquide");
    expect(center()).toHaveTextContent(
      allocationOf(data).rows.find((row) => row.instrumentId === A)?.percentageText ?? "∅",
    );
    expect(center()).toHaveTextContent("600.00 EUR");
    // The other arc dims; the active one does not.
    expect(arcs()[1]).toHaveAttribute("data-dimmed", "true");
    expect(arcs()[0]).not.toHaveAttribute("data-dimmed");

    fireEvent.mouseLeave(screen.getByTestId("positions-pie-graphic").parentElement!);
    expect(center()).toHaveTextContent("2 positions");
    expect(arcs()[1]).not.toHaveAttribute("data-dimmed");
  });

  it("AC-PIE2-1: names every position at or above 2 % — 2.00 % included — and folds the rest into one « Autres positions » whose share is the exact sum of units", () => {
    // Thirteen clear the bar (the two 2s are exactly 2.00 %); the one left
    // (1 %) folds.
    const values = [20, 15, 12, 10, 9, 8, 6, 5, 4, 3, 3, 2, 2, 1];
    const holdings = values.map((value, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        String(value),
      ),
    );
    const data = response(holdings, "100");
    const allocation = allocationOf(data);

    const slices = pieSlices(allocation, holdings);
    expect(slices).toHaveLength(14);
    expect(slices.slice(0, 13).map((slice) => slice.label)).toEqual(
      Array.from({ length: 13 }, (_, index) => `Position ${String(index + 1)}`),
    );
    const others = slices[13]!;
    expect(others.label).toBe(OVERVIEW_COPY.positionsPieOthers);
    expect(others.holding).toBeUndefined();
    expect(others.percentText).toBe("1.00%");
    expect(slices.reduce((sum, slice) => sum + slice.percent, 0)).toBeCloseTo(100, 6);
    expect(others.color).toBe("var(--chart-6)");
    expect(POSITIONS_PIE_MIN_SHARE_PERCENT).toBe(2);
  });

  it("AC-PIE2-2: eighty equal positions (1.25 % each) — none clears the bar — still name the three largest by the tie-break, and fold seventy-seven", () => {
    const holdings = Array.from({ length: 80 }, (_, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        "1",
      ),
    );
    const data = response(holdings, "80");
    const slices = pieSlices(allocationOf(data), holdings);
    expect(slices).toHaveLength(POSITIONS_PIE_MIN_NAMED + 1);
    expect(slices.slice(0, 3).map((slice) => slice.label)).toEqual([
      "Position 1",
      "Position 2",
      "Position 3",
    ]);
    expect(slices[3]?.label).toBe(OVERVIEW_COPY.positionsPieOthers);
    expect(slices[3]?.percentText).toBe("96.25%");
  });

  it("AC-PIE2-3: five positions all above 2 % — no « Autres » arc at all", () => {
    const holdings = [30, 25, 20, 15, 10].map((value, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        String(value),
      ),
    );
    const slices = pieSlices(allocationOf(response(holdings, "100")), holdings);
    expect(slices).toHaveLength(5);
    expect(slices.every((slice) => slice.holding !== undefined)).toBe(true);
    expect(slices.some((slice) => slice.color === "var(--chart-6)")).toBe(false);
  });

  it("AC-PIE2-4: twelve equal positions get twelve distinct colours, none the tail's grey", () => {
    const holdings = Array.from({ length: 12 }, (_, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        "1",
      ),
    );
    const slices = pieSlices(allocationOf(response(holdings, "12")), holdings);
    expect(slices).toHaveLength(12);
    const colours = new Set(slices.map((slice) => slice.color));
    expect(colours.size).toBe(12);
    expect(colours.has("var(--chart-6)")).toBe(false);
  });

  it("AC-PIE2-4: past the twelfth arc the palette cycles — no named arc is the tail's grey and no two adjacent arcs share a colour", () => {
    // 24 positions at 4 % and one at 1 %: 24 named through 12 tokens, plus a
    // grey tail between the last named arc and the first.
    const holdings = [
      ...Array.from({ length: 24 }, (_, index) =>
        holding(
          `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
          `Position ${String(index + 1)}`,
          "4",
        ),
      ),
      holding("00000025-0000-4000-8000-000000000000", "Position 25", "1"),
    ];
    const slices = pieSlices(allocationOf(response(holdings, "97")), holdings);
    expect(slices).toHaveLength(25);
    const named = slices.slice(0, 24);
    expect(named.some((slice) => slice.color === "var(--chart-6)")).toBe(false);
    expect(slices[24]?.color).toBe("var(--chart-6)");
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index]?.color).not.toBe(slices[index - 1]?.color);
    }
    expect(named[12]?.color).toBe(named[0]?.color);
  });

  it("AC-PIE2-4: thirteen equal positions with no tail do not close the ring on the colour they opened with", () => {
    const holdings = Array.from({ length: 13 }, (_, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        "1",
      ),
    );
    const slices = pieSlices(allocationOf(response(holdings, "13")), holdings);
    expect(slices).toHaveLength(13);
    const first = slices[0]!;
    const last = slices[12]!;
    expect(last.color).not.toBe(first.color);
    expect(last.color).not.toBe(slices[11]?.color);
    expect(last.color).not.toBe("var(--chart-6)");
  });

  it("leaves a row without a share out of the ring rather than drawing it at zero", () => {
    const data = response(
      [holding(A, "Euro Co", "500.00"), holding(B, "Dollar Co", "500.00", "SHARE")],
      "1000.00",
    );
    const mismatched: HoldingsResponse = {
      ...data,
      holdings: [
        data.holdings[0]!,
        { ...data.holdings[1]!, currentValue: valued("500.00", "USD") },
      ],
    };
    const allocation = allocationOf(mismatched);
    const slices = pieSlices(allocation, mismatched.holdings);
    expect(slices.map((slice) => slice.label)).toEqual(["Euro Co"]);
  });
});

describe("<PositionsPieCard> — the visible legend beside the ring", () => {
  /** `count` equal positions of `each`, ids ordered so the tie-break is the index order. */
  function equal(count: number, each: string) {
    return Array.from({ length: count }, (_, index) =>
      holding(
        `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `Position ${String(index + 1)}`,
        each,
      ),
    );
  }

  it("shows the eight largest slices as rows and folds the rest into one « n autres positions » row whose share is the exact sum", async () => {
    // Ten positions at 10 % each: ten arcs (all clear the bar), nine rows.
    const holdings = equal(10, "100");
    const data = response(holdings, "1000");
    renderCard(data);
    await screen.findByTestId("positions-pie-card");

    expect(arcs()).toHaveLength(10);
    const rows = screen.getAllByTestId("positions-pie-row");
    expect(rows).toHaveLength(POSITIONS_PIE_LEGEND_ROWS + 1);
    const last = rows[rows.length - 1]!;
    expect(last).toHaveClass("ov-pie-row-more");
    expect(last.querySelector("[data-testid='positions-pie-name']")).toHaveTextContent(
      "2 autres positions",
    );
    expect(last.querySelector("[data-testid='positions-pie-percent']")).toHaveTextContent("20.00%");
    // A share of the total, not a position: no value, no link.
    expect(last.querySelector("[data-testid='positions-pie-value']")).toHaveTextContent("");
    expect(last).not.toHaveAttribute("data-selectable");
    // The rows are visible — no `k-visually-hidden` any more.
    expect(screen.getByTestId("positions-pie-legend")).not.toHaveClass("k-visually-hidden");
  });

  it("legendRows: the folded row sums the remaining slices' units — the sub-2 % tail included — and counts their positions", () => {
    // Nine above the bar (10 % … ) plus three tiny ones: 10 slices (9 + Autres),
    // so the legend is 8 rows + one fold standing for slice 9 and the tail.
    const holdings = [
      ...equal(9, "1000"),
      ...equal(3, "10").map((h, i) =>
        holding(`aaaaaaa${String(i)}-0000-4000-8000-000000000000`, `Tiny ${String(i)}`, "10"),
      ),
    ];
    const total = holdings.reduce((sum, h) => sum + Number.parseInt(h.currentValue.amount, 10), 0);
    const data = response(holdings, String(total));
    const slices = pieSlices(allocationOf(data), data.holdings);
    expect(slices).toHaveLength(10);
    const rows = legendRows(slices);
    expect(rows).toHaveLength(POSITIONS_PIE_LEGEND_ROWS + 1);
    const fold = rows[rows.length - 1]!;
    expect(fold.folded).toBe(true);
    expect(fold.kinds).toEqual(slices.slice(POSITIONS_PIE_LEGEND_ROWS).map((s) => s.key));
    // 1 position at 1000 + 3 at 10 = 4 positions behind the fold.
    expect(fold.label).toBe("4 autres positions");
    const expectedUnits = slices
      .slice(POSITIONS_PIE_LEGEND_ROWS)
      .reduce((sum, s) => sum.plus(s.units), new Decimal(0));
    expect(fold.percentText).toBe(formatUnitsAsPercentage(expectedUnits));
  });

  it("lights an arc from its legend row and a row from its arc — one active slice for both", async () => {
    const data = response(
      [
        holding(A, "Air Liquide", "600.00", "SHARE", { symbol: "AI.PA" }),
        holding(B, "Big Co", "400.00"),
      ],
      "1000.00",
    );
    renderCard(data);
    await screen.findByTestId("positions-pie-card");
    const rows = screen.getAllByTestId("positions-pie-row");
    const center = () => screen.getByTestId("positions-pie-center");

    fireEvent.mouseEnter(rows[0]!);
    expect(rows[0]).toHaveAttribute("data-active", "true");
    expect(arcs()[1]).toHaveAttribute("data-dimmed", "true");
    expect(arcs()[0]).not.toHaveAttribute("data-dimmed");
    expect(center()).toHaveTextContent("Air Liquide");
    fireEvent.mouseLeave(rows[0]!);
    expect(rows[0]).not.toHaveAttribute("data-active");
    expect(arcs()[1]).not.toHaveAttribute("data-dimmed");

    fireEvent.mouseEnter(arcs()[1]!);
    expect(rows[1]).toHaveAttribute("data-active", "true");
    expect(rows[0]).not.toHaveAttribute("data-active");
  });

  it("never draws the lilac and sky hues on adjacent arcs — the pair the validator fails", async () => {
    const data = response(equal(12, "100"), "1200");
    renderCard(data);
    await screen.findByTestId("positions-pie-card");
    const strokes = arcs().map((arc) => arc.getAttribute("stroke"));
    const isPair = (a: string | null, b: string | null) =>
      (a === "var(--chart-3)" && b === "var(--chart-4)") ||
      (a === "var(--chart-4)" && b === "var(--chart-3)");
    for (let i = 0; i < strokes.length; i += 1) {
      const next = strokes[(i + 1) % strokes.length];
      expect(isPair(strokes[i] ?? null, next ?? null)).toBe(false);
    }
    // Still twelve distinct tokens, none the tail's grey (AC-PIE2-4 unchanged).
    expect(new Set(strokes).size).toBe(12);
    expect(strokes).not.toContain("var(--chart-6)");
  });
});

describe("sliceCode — the ticker when there is one, else the monogram", () => {
  it("returns the symbol verbatim, and the upper-cased first three letters of the name otherwise", () => {
    expect(sliceCode({ symbol: "AI.PA", displayName: "Air Liquide" })).toBe("AI.PA");
    expect(sliceCode({ symbol: null, displayName: "Air Liquide" })).toBe("AIR");
    expect(sliceCode({ symbol: "", displayName: "lvmh" })).toBe("LVM");
  });
});

describe("<PositionsPieCard> — the two honest absences", () => {
  it("says there is nothing held, and draws no ring, for an empty holdings set", async () => {
    renderCard(response([], "0"));
    expect(await screen.findByTestId("positions-pie-empty")).toHaveTextContent(
      OVERVIEW_COPY.positionsPieEmpty,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByTestId("positions-pie-row")).not.toBeInTheDocument();
  });

  it("says the split is unavailable when no total can be established", async () => {
    // A zero total with a non-zero position: `computeAllocation` refuses to
    // apportion (`totalUnavailable`), so every row's `units` is undefined.
    renderCard(response([holding(A, "Ghost Co", "100.00")], "0"));
    expect(await screen.findByTestId("positions-pie-unavailable")).toHaveTextContent(
      OVERVIEW_COPY.positionsPieUnavailable,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the heading and nothing else while the holdings read is in flight", async () => {
    renderCard(undefined);
    expect(await screen.findByTestId("positions-pie-card")).toBeInTheDocument();
    expect(screen.queryByTestId("positions-pie-total")).not.toBeInTheDocument();
    expect(screen.queryByTestId("positions-pie-empty")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("<PositionsPieCard> — « Liquidités » (AC-578, AC-572)", () => {
  it("AC-578: cash is one named slice in --class-cash, after the positions and never folded", async () => {
    // Twelve positions: past the legend's eight-row fold, with cash the
    // smallest share of all — it must still be its own last row and arc.
    const rows = Array.from({ length: 12 }, (_, i) =>
      holding(`id-${String(i).padStart(2, "0")}`, `Titre ${String(i)}`, "100.00"),
    );
    const data = withCash(response(rows, "1210.00"), "10.00");
    const slices = pieSlices(allocationOf(data), data.holdings, data.cash);
    const last = slices.at(-1)!;
    expect(last.key).toBe(CASH_ROW_ID);
    expect(last.label).toBe("Liquidités");
    expect(last.color).toBe("var(--class-cash)");
    expect(slices.filter((slice) => slice.key === CASH_ROW_ID)).toHaveLength(1);
    const legend = legendRows(slices);
    expect(legend.at(-1)).toMatchObject({ key: CASH_ROW_ID, folded: false });
    expect(legend.find((row) => row.folded)?.kinds).not.toContain(CASH_ROW_ID);

    renderCard(data);
    const drawn = await screen.findAllByTestId("positions-pie-arc");
    const cashArc = drawn.find((arc) => arc.getAttribute("data-kind") === CASH_ROW_ID);
    expect(cashArc).toHaveAttribute("stroke", "var(--class-cash)");
    expect(cashArc).toHaveAccessibleName(/^Liquidités, /);
    const cashRow = screen
      .getAllByTestId("positions-pie-row")
      .find((row) => row.getAttribute("data-kind") === CASH_ROW_ID);
    expect(cashRow).toHaveTextContent("Liquidités");
    expect(cashRow).toHaveTextContent("10.00 EUR");
  });

  it("AC-572: cash -50.00 beside 200.00 of holdings draws no cash arc, and the drawn arcs close the ring", async () => {
    const data = withCash(response([holding(A, "Air Liquide", "200.00")], "150.00"), "-50.00");
    const allocation = allocationOf(data);
    expect(allocation.reconciles).toBe(true);
    const slices = pieSlices(allocation, data.holdings, data.cash);
    expect(slices.map((slice) => slice.key)).not.toContain(CASH_ROW_ID);
    // The ring closes: the drawn percentages sum to exactly the whole circle…
    expect(slices.reduce((sum, slice) => sum + slice.percent, 0)).toBeCloseTo(100, 9);
    // …while the legend keeps the apportioned figure (C-14).
    expect(slices[0]!.percentText).toBe("133.33%");

    renderCard(data);
    const drawn = await screen.findAllByTestId("positions-pie-arc");
    expect(drawn.map((arc) => arc.getAttribute("data-kind"))).toEqual([A]);
  });

  it("AC-573: zero cash adds no slice", () => {
    const data = response([holding(A, "Air Liquide", "200.00")], "200.00");
    const slices = pieSlices(allocationOf(data), data.holdings, data.cash);
    expect(slices.map((slice) => slice.key)).toEqual([A]);
  });

  it("a cash-only tenant gets a ring of « Liquidités », not the « nothing held » note", async () => {
    renderCard(withCash(response([], "500.00"), "500.00"));
    const drawn = await screen.findAllByTestId("positions-pie-arc");
    expect(drawn.map((arc) => arc.getAttribute("data-kind"))).toEqual([CASH_ROW_ID]);
    expect(screen.queryByTestId("positions-pie-empty")).not.toBeInTheDocument();
  });
});
