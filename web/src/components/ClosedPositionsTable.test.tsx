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
import { describe, expect, it, vi } from "vitest";
import type { ClosedPositionResponse, RealizedGainResponse } from "../lib/api-client.js";
import { CLOSED_POSITIONS_COPY } from "../lib/copy/closed-positions.js";
import { HOLDINGS_COPY } from "../lib/copy/holdings.js";
import { ClosedPositionsTable } from "./ClosedPositionsTable.js";

/**
 * UR-42/UR-44/UR-46/AC-329. `ClosedPositionsCardList.test.tsx` mirrors every one of these — same
 * data, same formatters, different markup.
 *
 * The `@tanstack/react-virtual` mock is `HoldingsTable.test.tsx`'s, for its
 * reason verbatim: jsdom has no layout engine, so the real virtualiser
 * measures a zero-size rect and renders **zero** rows regardless of fixture
 * size. The genuine windowing is a browser property and is proven in e2e; this
 * mock renders every row so each row's own content can be asserted here.
 */
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 64, key: index })),
    getTotalSize: () => count * 64,
    measureElement: () => undefined,
  }),
  useWindowVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 64, key: index })),
    getTotalSize: () => count * 64,
    measureElement: () => undefined,
    options: { scrollMargin: 0 },
  }),
}));

const PORTFOLIO_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function gain(overrides: Partial<RealizedGainResponse> = {}): RealizedGainResponse {
  return {
    portfolioId: PORTFOLIO_A,
    tradeDate: "2024-03-14",
    quantitySold: "12",
    gainBase: { amount: "250.00", currency: "EUR", provenance: { derivedFrom: [] } },
    gainNative: { amount: "270.00", currency: "USD", provenance: { derivedFrom: [] } },
    fxComponentBase: { amount: "-20.00", currency: "EUR", provenance: { derivedFrom: [] } },
    proceedsBase: { amount: "1250.00", currency: "EUR", provenance: { derivedFrom: [] } },
    ...overrides,
  };
}

function closedPosition(overrides: Partial<ClosedPositionResponse> = {}): ClosedPositionResponse {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    kind: "SHARE",
    displayName: "Nokia Oyj",
    hasIcon: false,
    currency: "EUR",
    totalRealizedGainBase: { amount: "250.00", currency: "EUR", provenance: { derivedFrom: [] } },
    totalRealizedGainNative: { amount: "270.00", currency: "USD", provenance: { derivedFrom: [] } },
    totalFxComponentBase: { amount: "-20.00", currency: "EUR", provenance: { derivedFrom: [] } },
    totalDisposedCostBasisBase: {
      amount: "1000.00",
      currency: "EUR",
      provenance: { derivedFrom: [] },
    },
    realizedGains: [gain()],
    ...overrides,
  };
}

async function renderTable(
  closedPositions: readonly ClosedPositionResponse[],
  portfolioNameById?: ReadonlyMap<string, string>,
): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <Tooltip.Provider delayDuration={200}>
            <ClosedPositionsTable
              closedPositions={closedPositions}
              portfolioNameById={portfolioNameById}
            />
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
  await screen.findByTestId("closed-positions-table");
}

describe("<ClosedPositionsTable> — the row's figures come from the wire, through <Figure>", () => {
  it("renders every column, in the expected order", async () => {
    await renderTable([closedPosition()]);

    const headers = screen
      .getByTestId("closed-positions-table-header")
      .querySelectorAll('[role="columnheader"]');
    expect([...headers].map((h) => h.textContent)).toEqual([
      CLOSED_POSITIONS_COPY.columnAsset,
      CLOSED_POSITIONS_COPY.columnKind,
      CLOSED_POSITIONS_COPY.columnRealized,
      CLOSED_POSITIONS_COPY.columnReturn,
      CLOSED_POSITIONS_COPY.columnDisposedCostBasis,
      CLOSED_POSITIONS_COPY.columnRealizedNative,
      CLOSED_POSITIONS_COPY.columnFxComponent,
      CLOSED_POSITIONS_COPY.columnActions,
    ]);
  });

  it("renders each figure exactly as the wire carried it", async () => {
    await renderTable([closedPosition()]);

    expect(screen.getByTestId("closed-position-realized")).toHaveTextContent("250.00 EUR");
    expect(screen.getByTestId("closed-position-disposed-cost-basis")).toHaveTextContent(
      "1 000.00 EUR",
    );
    expect(screen.getByTestId("closed-position-realized-native")).toHaveTextContent("270.00 USD");
    // U+2212 MINUS SIGN — `figure-format.ts`'s substitution, never a hyphen.
    expect(screen.getByTestId("closed-position-fx-component")).toHaveTextContent("−20.00 EUR");
  });

  it("AC-320: the return is 250 / 1000, and a zero disposed cost basis renders a dash rather than 0 %", async () => {
    await renderTable([
      closedPosition(),
      closedPosition({
        instrumentId: "33333333-3333-3333-3333-333333333333",
        displayName: "Fonds sans coût",
        totalDisposedCostBasisBase: {
          amount: "0",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
      }),
    ]);

    const cells = screen.getAllByTestId("closed-position-return-percentage");
    expect(cells[0]).toHaveTextContent("25.00%");
    expect(cells[1]).toHaveTextContent("—");
    expect(cells[1]?.textContent ?? "").not.toContain("0.00%");
  });

  it("states the row count and offers no page control — this read is not paginated", async () => {
    await renderTable([closedPosition()]);
    expect(screen.getByTestId("closed-positions-table-count")).toHaveTextContent(
      "1 position clôturée",
    );
    expect(screen.queryByRole("navigation", { name: /pagination/i })).not.toBeInTheDocument();
  });
});

/**
 * AC-329, both directions **in one run**: a suite that asserted only the gain
 * case would be green against a component that hard-coded « Plus-value
 * réalisée », which is precisely the defect `<RealizedGainsIndicator>` was
 * fixed for.
 */
describe("<ClosedPositionsTable> — UR-46/AC-329: direction is in the words, not only the colour", () => {
  it("labels and tints a net gain and a net loss differently, in the same render", async () => {
    await renderTable([
      closedPosition(),
      closedPosition({
        instrumentId: "44444444-4444-4444-4444-444444444444",
        displayName: "Casino Guichard",
        totalRealizedGainBase: {
          amount: "-480.00",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
      }),
    ]);

    const labels = screen.getAllByTestId("closed-position-result-label");
    expect(labels[0]).toHaveTextContent(CLOSED_POSITIONS_COPY.resultGain);
    expect(labels[1]).toHaveTextContent(CLOSED_POSITIONS_COPY.resultLoss);

    const cells = screen.getAllByTestId("closed-position-realized");
    expect(cells[0]).toHaveAttribute("data-sign", "gain");
    expect(cells[1]).toHaveAttribute("data-sign", "loss");
  });

  it("calls a zero result neither a plus-value nor a moins-value", async () => {
    await renderTable([
      closedPosition({
        totalRealizedGainBase: { amount: "0.00", currency: "EUR", provenance: { derivedFrom: [] } },
      }),
    ]);

    expect(screen.getByTestId("closed-position-result-label")).toHaveTextContent(
      CLOSED_POSITIONS_COPY.resultFlat,
    );
    expect(screen.getByTestId("closed-position-realized")).toHaveAttribute("data-sign", "flat");
  });
});

describe("<ClosedPositionsTable> — the row actions, and the two it must not offer", () => {
  it("offers « Voir l'instrument » and « Voir les transactions », and neither pricing nor adding a transaction", async () => {
    await renderTable([closedPosition()]);

    fireEvent.click(screen.getByTestId("closed-position-row-menu-trigger"));

    const menu = screen.getByTestId("closed-position-row-menu");
    expect(menu).toHaveTextContent(CLOSED_POSITIONS_COPY.openInstrument);
    expect(menu).toHaveTextContent(CLOSED_POSITIONS_COPY.openTransactions);
    // There is no position left to price, and adding a transaction from this
    // row is the one affordance that would stop it being a closed position.
    expect(menu).not.toHaveTextContent(HOLDINGS_COPY.enterPrice);
    expect(menu).not.toHaveTextContent(HOLDINGS_COPY.addTransaction);
    expect(screen.queryByTestId("holding-enter-price")).toBeNull();
  });

  it("links the display name and the eye action to the instrument screen", async () => {
    await renderTable([closedPosition()]);

    expect(screen.getByTestId("closed-position-display-name")).toHaveAttribute(
      "href",
      "/instruments/11111111-1111-1111-1111-111111111111",
    );
    expect(screen.getByTestId("closed-position-open-instrument")).toHaveAttribute(
      "href",
      "/instruments/11111111-1111-1111-1111-111111111111",
    );
  });
});

describe("<ClosedPositionsTable> — the sale-lot disclosure is mounted, never CSS-hidden (F5)", () => {
  it("renders nothing of the lot list until the row is expanded, then the real component", async () => {
    await renderTable([closedPosition()], new Map([[PORTFOLIO_A, "PEA"]]));

    // Absent from the DOM, not merely invisible — an assertion jsdom can make
    // truthfully, unlike `not.toBeVisible()` against a CSS-hidden subtree.
    expect(screen.queryByTestId("closed-position-sale-lots")).toBeNull();

    fireEvent.click(screen.getByTestId("closed-position-sale-lots-toggle"));

    expect(screen.getByTestId("closed-position-sale-lots")).toBeInTheDocument();
    expect(screen.getByTestId("closed-lot-trade-date")).toHaveTextContent("2024-03-14");
    expect(screen.getByTestId("closed-lot-portfolio")).toHaveTextContent("PEA");

    fireEvent.click(screen.getByTestId("closed-position-sale-lots-toggle"));
    expect(screen.queryByTestId("closed-position-sale-lots")).toBeNull();
  });
});

describe("<ClosedPositionsTable> — sorting", () => {
  it("orders the money columns by their raw wire amount, not by the rendered text", async () => {
    await renderTable([
      closedPosition({
        instrumentId: "aaaa1111-1111-1111-1111-111111111111",
        displayName: "Petit gain",
        totalRealizedGainBase: { amount: "9.00", currency: "EUR", provenance: { derivedFrom: [] } },
      }),
      closedPosition({
        instrumentId: "bbbb1111-1111-1111-1111-111111111111",
        displayName: "Gros gain",
        totalRealizedGainBase: {
          amount: "1234.50",
          currency: "EUR",
          provenance: { derivedFrom: [] },
        },
      }),
    ]);

    fireEvent.click(screen.getByTestId("closed-sort-realized"));

    // Ascending: 9,00 before 1 234,50. A string sort would put "1234.50" first.
    const names = screen.getAllByTestId("closed-position-display-name").map((el) => el.textContent);
    expect(names).toEqual(["Petit gain", "Gros gain"]);
  });

  it("offers no sort control on « Rendement » — the wire carries no ratio to sort on (FR-327)", async () => {
    await renderTable([closedPosition()]);

    expect(screen.queryByTestId("closed-sort-return")).toBeNull();
    // Every other column does have one, so this is an absence and not a
    // table that simply forgot to be sortable.
    for (const key of [
      "name",
      "kind",
      "realized",
      "disposedCostBasis",
      "realizedNative",
      "fxComponent",
    ]) {
      expect(screen.getByTestId(`closed-sort-${key}`)).toBeInTheDocument();
    }
  });
});
