import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { CashBlockResponse, HoldingResponse } from "../lib/api-client.js";
import { computeAllocation } from "../lib/allocation.js";
import { allocationInputOf } from "../lib/cash-position.js";
import { HoldingsCardList } from "./HoldingsCardList.js";

function holding(instrumentId: string, displayName: string, value: string): HoldingResponse {
  const money = (amount: string) => ({ amount, currency: "EUR", provenance: { derivedFrom: [] } });
  return {
    instrumentId,
    kind: "SHARE",
    displayName,
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "1",
    currency: "EUR",
    pmp: money("1"),
    costBasis: money("1"),
    currentPrice: money(value),
    currentValue: money(value),
    unrealizedGainLoss: money("0"),
    dayChange: undefined,
    dayChangePercent: undefined,
    realizedGains: [],
  } as HoldingResponse;
}

const names = () => screen.getAllByTestId("holding-display-name").map((el) => el.textContent);

async function renderCards(
  holdings: readonly HoldingResponse[],
  cash?: CashBlockResponse,
  total = "1230",
): Promise<void> {
  const allocation = computeAllocation(
    allocationInputOf({
      holdings,
      totalValue: { amount: total, currency: "EUR", provenance: { derivedFrom: [] } },
      ...(cash === undefined ? {} : { cash }),
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <Tooltip.Provider delayDuration={200}>
            <HoldingsCardList holdings={holdings} allocation={allocation} cash={cash} />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/activity" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
  await screen.findByTestId("holdings-card-list");
}

describe("<HoldingsCardList> — sort control", () => {
  const holdings = [
    holding("b", "Bravo", "200"),
    holding("a", "Alpha", "1000"),
    holding("c", "Charlie", "30"),
  ];

  it("opens on value descending, flips from the direction toggle and re-sorts from the column select", async () => {
    await renderCards(holdings);
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(screen.getByTestId("holdings-card-sort-key")).toHaveValue("value");
    expect(screen.getByTestId("holdings-card-sort-direction")).toHaveTextContent("Décroissant");

    fireEvent.click(screen.getByTestId("holdings-card-sort-direction"));
    expect(names()).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(screen.getByTestId("holdings-card-sort-direction")).toHaveTextContent("Croissant");

    // A text column starts ascending regardless of the previous direction.
    fireEvent.change(screen.getByTestId("holdings-card-sort-key"), { target: { value: "name" } });
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(screen.getByTestId("holdings-card-sort-direction")).toHaveTextContent("Croissant");
  });
});

describe("<HoldingsCardList> — the « Liquidités » card (AC-577)", () => {
  it("shows the same row as the table: 975.00 at 82.98 %, « — » elsewhere, sorted with the positions", async () => {
    await renderCards(
      [holding("a", "Alpha", "200.00")],
      { totalBase: "975.00", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
      "1175.00",
    );
    expect(names()).toEqual(["Liquidités", "Alpha"]);
    const card = screen
      .getAllByTestId("holding-card")
      .find((c) => c.getAttribute("data-kind") === "CASH")!;
    const cell = (id: string) => card.querySelector(`[data-testid='${id}']`)!;
    expect(cell("holding-current-value")).toHaveTextContent("975.00 EUR");
    expect(cell("holding-allocation-percentage").textContent).toBe("82.98%");
    for (const id of [
      "holding-quantity",
      "holding-pmp",
      "holding-current-price",
      "holding-unrealized-gain-loss",
    ]) {
      expect(cell(id).textContent, id).toBe("—");
    }
    // A pmp sort keeps it last in both directions.
    fireEvent.change(screen.getByTestId("holdings-card-sort-key"), { target: { value: "pmp" } });
    expect(names().at(-1)).toBe("Liquidités");
    fireEvent.click(screen.getByTestId("holdings-card-sort-direction"));
    expect(names().at(-1)).toBe("Liquidités");
  });
});
