import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { CashBlockResponse, HoldingResponse } from "../lib/api-client.js";
import { computeAllocation } from "../lib/allocation.js";
import { allocationInputOf } from "../lib/cash-position.js";
import { HoldingsTable } from "./HoldingsTable.js";

/**
 * UR-12 (AC124/AC126/
 * AC128). `HoldingsCardList.test.tsx` mirrors every one of these — same
 * data, same `positions.ts`/`allocation.ts` formatters, different markup.
 *
 * UR-42: `<HoldingsTable>` renders a real `<Link>` ("holding-open-instrument"),
 * so this suite needs a mounted `RouterProvider` — the same minimal in-test
 * router `InstrumentTable.test.tsx` already establishes for the identical
 * reason.
 *
 * `@tanstack/react-virtual`'s real `useVirtualizer` measures the scroll
 * container's `getBoundingClientRect()` to decide which rows are "near the
 * scrollport" — jsdom has no layout engine, so that always reports a
 * zero-size rect and the real virtualizer renders **zero** rows here
 * regardless of fixture size (jsdom also has no `ResizeObserver`, which is
 * how the real implementation would otherwise recover once mounted). This
 * is a `jsdom` limitation, not a `HoldingsTable` behaviour under test — the
 * component's *genuine* windowing (fewer DOM rows than a large fixture's
 * holding count) is already proven against a real browser by
 * `overview-holdings.spec.ts`'s "windows the DOM" test. The mock below
 * renders every row unconditionally so this file can assert each row's own
 * content and props instead.
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

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchInstrumentHistoryStatus: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

function holding(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    kind: "SHARE",
    displayName: "Apple Inc",
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "10",
    currency: "USD",
    pmp: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
    costBasis: { amount: "1000.00", currency: "USD", provenance: { derivedFrom: [] } },
    currentPrice: { amount: "110.00", currency: "USD", provenance: { derivedFrom: [] } },
    currentValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
    unrealizedGainLoss: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
    realizedGains: [],
    ...overrides,
  };
}

/**
 * `async`, and awaits `"holdings-table"` before returning: `RouterProvider`
 * resolves its initial route match asynchronously even for a memory router
 * mounted at `"/"` with no data loader of its own (the same behaviour
 * `InstrumentTable.test.tsx`'s own first assertion — `await
 * screen.findAllByTestId(...)` — already works around). Encapsulating the
 * wait here, once, means every call site below keeps its own synchronous
 * `screen.getByTestId(...)` assertions afterward, unchanged in what they
 * assert — only the render helper itself became async.
 */
async function renderTable(
  holdings: readonly HoldingResponse[],
  onEnterPrice?: (h: HoldingResponse) => void,
  onAddTransaction?: (h: HoldingResponse) => void,
): Promise<void> {
  const allocation = computeAllocation({
    holdings: holdings.map((h) => ({
      instrumentId: h.instrumentId,
      kind: h.kind,
      currentValue: h.currentValue,
    })),
    totalValue: { amount: "1100.00", currency: "USD", provenance: { derivedFrom: [] } },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <QueryClientProvider client={queryClient}>
          <Tooltip.Provider delayDuration={200}>
            <HoldingsTable
              holdings={holdings}
              allocation={allocation}
              onEnterPrice={onEnterPrice}
              onAddTransaction={onAddTransaction}
            />
          </Tooltip.Provider>
        </QueryClientProvider>
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render((<RouterProvider router={router} />) as ReactElement);
  await screen.findByTestId("holdings-table");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
    status: "PENDING",
    requestedFrom: null,
    earliestBackfilledDate: null,
    latestBackfilledDate: null,
    lastQuoteAt: null,
    latestPriceDate: null,
  });
});

describe("<HoldingsTable> — Instrument column renders displayName, not the raw instrumentId", () => {
  it("renders the instrument's displayName", async () => {
    await renderTable([holding({ displayName: "Fonds Prudent Manuel" })]);
    expect(screen.getByTestId("holding-display-name")).toHaveTextContent("Fonds Prudent Manuel");
  });

  it("never renders the raw instrumentId as the instrument label", async () => {
    const h = holding({
      instrumentId: "99999999-9999-4999-8999-999999999999",
      displayName: "Fonds Prudent Manuel",
    });
    await renderTable([h]);
    expect(screen.getByTestId("holding-display-name")).not.toHaveTextContent(h.instrumentId);
  });

  it("renders the kind badge alongside the display name", async () => {
    await renderTable([holding({ kind: "ETF" })]);
    expect(screen.getByTestId("holding-kind")).toHaveTextContent("ETF");
  });
});

describe("<HoldingsTable> — allocation % column (AC117, sourced from the allocation prop, never recomputed)", () => {
  it("a single holding allocates 100.00%", async () => {
    await renderTable([holding()]);
    expect(screen.getByTestId("holding-allocation-percentage")).toHaveTextContent("100.00%");
  });

  it("renders — when the allocation's own guard blanks this row (never a thrown error)", async () => {
    // Mismatched currency vs. the fixture's own totalValue (USD) -> blanked.
    await renderTable([
      holding({
        currentValue: { amount: "1100.00", currency: "EUR", provenance: { derivedFrom: [] } },
      }),
    ]);
    expect(screen.getByTestId("holding-allocation-percentage")).toHaveTextContent("—");
  });

  it("renders the kind roll-up as a subtotal footer, from the same allocation prop (no second algorithm)", async () => {
    await renderTable([holding({ instrumentId: "a", kind: "SHARE" })]);
    expect(screen.getByTestId("holdings-table-kind-subtotals")).toBeInTheDocument();
    expect(screen.getByTestId("holdings-table-kind-subtotal-row")).toHaveTextContent("SHARE");
    expect(screen.getByTestId("holdings-table-kind-subtotal-row")).toHaveTextContent("100.00%");
  });
});

describe("<HoldingsTable> — AC124: unrealized P&L amount and percentage", () => {
  it("renders both the amount (via <Figure>) and the percentage", async () => {
    await renderTable([
      holding({
        unrealizedGainLoss: { amount: "100.00", currency: "USD", provenance: { derivedFrom: [] } },
        costBasis: { amount: "1000.00", currency: "USD", provenance: { derivedFrom: [] } },
      }),
    ]);
    const cell = screen.getByTestId("holding-unrealized-gain-loss");
    expect(cell).toHaveTextContent("100.00 USD");
    expect(screen.getByTestId("holding-unrealized-gain-loss-percentage")).toHaveTextContent(
      "10.00%",
    );
  });

  it("renders — (never 0% or ∞) when costBasis is zero", async () => {
    await renderTable([
      holding({ costBasis: { amount: "0", currency: "USD", provenance: { derivedFrom: [] } } }),
    ]);
    expect(screen.getByTestId("holding-unrealized-gain-loss-percentage")).toHaveTextContent("—");
  });
});

describe("<HoldingsTable> — AC126: the row carries no secondary data, because there is no expander", () => {
  it("renders no details expander, and none of the data it used to hold", async () => {
    await renderTable([
      holding({
        realizedGains: [
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-03-01",
            quantitySold: "5",
            gainBase: { amount: "42.00", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "50.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "1.00", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "500.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
        ],
      }),
    ]);

    // Positive companion first: the row really rendered, so the absences below
    // are statements about this row and not about an empty table.
    expect(screen.getByTestId("holding-display-name")).toBeInTheDocument();

    // AC126 said secondary data must not sit in the collapsed row. Removing the
    // secondary data satisfies that rather than weakening it — nothing moved
    // *into* the row. Cost basis and history status remain on the instrument
    // detail screen, one click away via the row's own link.
    expect(screen.queryByTestId("holding-details")).not.toBeInTheDocument();
    expect(screen.queryByTestId("holding-cost-basis")).not.toBeInTheDocument();
    expect(screen.queryByTestId("holding-realized-gains")).not.toBeInTheDocument();
    expect(screen.queryByTestId("holding-provenance-detail")).not.toBeInTheDocument();
  });

  it("renders the three money columns without provenance badges or a tooltip trigger", async () => {
    await renderTable([holding()]);

    for (const testId of [
      "holding-current-price",
      "holding-current-value",
      "holding-unrealized-gain-loss",
    ]) {
      const cell = screen.getByTestId(testId);
      // The figure itself is still there and still formatted — this suppresses
      // provenance, it does not bypass `<Figure>` (AC119).
      expect(cell.querySelector("[data-testid='figure']")).not.toBeNull();
      expect(cell.querySelector("[data-testid='figure-badge-manual']")).toBeNull();
      expect(cell.querySelector("[data-testid='figure-badge-delayed']")).toBeNull();
      expect(cell.querySelector("[data-testid='figure-badge-pinned-fx']")).toBeNull();
    }
  });
});

describe("<HoldingsTable> — AC144: the realized-gains indicator (collapsed, no interaction)", () => {
  it("is visible before any click, outside <HoldingDetails>, showing count and aggregate amount", async () => {
    await renderTable([
      holding({
        realizedGains: [
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-03-01",
            quantitySold: "5",
            gainBase: { amount: "42.00", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "50.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "1.00", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "500.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-04-01",
            quantitySold: "2",
            gainBase: { amount: "8.00", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "10.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "0.50", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "80.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
        ],
      }),
    ]);

    const indicator = screen.getByTestId("holding-realized-gains-indicator");
    expect(indicator).toBeVisible();
    // A positive total is a plus-value, and says so — it used to read "Gains
    // réalisés" whatever the sign.
    expect(indicator).toHaveTextContent("Plus-value réalisée (2)");
    expect(indicator).toHaveAttribute("data-sign", "gain");
    // AC144: never JS-float summed — 42.00 + 8.00 exactly, via @kerdial/core-decimal.
    expect(indicator).toHaveTextContent("50.00 EUR");
    // The itemised per-sale list is gone with the expander; this signal is now
    // the only realised-result surface on the row.
    expect(screen.queryByTestId("holding-realized-gains")).not.toBeInTheDocument();
  });

  it("renders — for the aggregate when one entry's gainBase fails to parse, never a wrong or partial figure", async () => {
    await renderTable([
      holding({
        realizedGains: [
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-03-01",
            quantitySold: "5",
            gainBase: { amount: "not-a-number", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "50.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "1.00", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "500.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
        ],
      }),
    ]);

    const indicator = screen.getByTestId("holding-realized-gains-indicator");
    // Unreadable total ⇒ neutral, never a direction invented from a dash.
    expect(indicator).toHaveTextContent("Résultat réalisé (1) : —");
    expect(indicator).toHaveAttribute("data-sign", "flat");
  });

  it("calls a realised loss a moins-value, and tints it as a loss", async () => {
    // The point of the change. A negative total used to read "Gains réalisés
    // (1) : -120.00 EUR" — a loss labelled as a gain, and untinted, which is
    // exactly what the money-meaning colours exist to prevent.
    await renderTable([
      holding({
        realizedGains: [
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-03-01",
            quantitySold: "5",
            gainBase: { amount: "-120.00", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "-150.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "-1.00", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "380.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
        ],
      }),
    ]);

    const indicator = screen.getByTestId("holding-realized-gains-indicator");
    expect(indicator).toHaveTextContent("Moins-value réalisée (1)");
    expect(indicator).toHaveAttribute("data-sign", "loss");
    // The negative half, so the label cannot be right by accident: the gain
    // wording must not survive anywhere in the line.
    expect(indicator).not.toHaveTextContent("Plus-value");
  });

  it("stays neutral when gains and losses net to exactly zero", async () => {
    // `deltaSign`'s zero case, reached through this component: a net-flat
    // result is neither a plus-value nor a moins-value, and painting it green
    // would be the same class of error as painting a loss green.
    await renderTable([
      holding({
        realizedGains: [
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-03-01",
            quantitySold: "5",
            gainBase: { amount: "40.00", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "50.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "500.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
          {
            portfolioId: "22222222-2222-2222-2222-222222222222",
            tradeDate: "2026-04-01",
            quantitySold: "5",
            gainBase: { amount: "-40.00", currency: "EUR", provenance: { derivedFrom: [] } },
            gainNative: { amount: "-50.00", currency: "USD", provenance: { derivedFrom: [] } },
            fxComponentBase: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
            proceedsBase: { amount: "420.00", currency: "EUR", provenance: { derivedFrom: [] } },
          },
        ],
      }),
    ]);

    const indicator = screen.getByTestId("holding-realized-gains-indicator");
    expect(indicator).toHaveTextContent("Résultat réalisé (2)");
    expect(indicator).toHaveAttribute("data-sign", "flat");
  });

  it("renders no indicator at all for a holding with no realized gains", async () => {
    await renderTable([holding({ realizedGains: [] })]);
    expect(screen.queryByTestId("holding-realized-gains-indicator")).not.toBeInTheDocument();
  });
});

describe("<HoldingsTable> — AC128: the manual-price row action", () => {
  it("shows 'Saisir un cours' for a holding whose current price is MANUAL-quality", async () => {
    await renderTable([
      holding({
        currentPrice: {
          amount: "110.00",
          currency: "USD",
          provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
        },
      }),
    ]);
    expect(screen.getByTestId("holding-enter-price")).toBeInTheDocument();
  });

  it("scpi AC-508: a held SCPI priced by hand reaches the same row action, under the same label", async () => {
    const onEnterPrice = vi.fn();
    const scpi = holding({
      kind: "SCPI",
      displayName: "Corum Origin",
      currentPrice: {
        amount: "250.00",
        currency: "EUR",
        provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
      },
    });
    await renderTable([scpi], onEnterPrice);
    const action = screen.getByTestId("holding-enter-price");
    expect(action).toHaveAccessibleName("Saisir un cours");
    action.click();
    expect(onEnterPrice).toHaveBeenCalledWith(scpi);
  });

  it("does not show 'Saisir un cours' for a normal, automated holding", async () => {
    await renderTable([holding()]);
    expect(screen.queryByTestId("holding-enter-price")).not.toBeInTheDocument();
  });

  it("is disabled (a documented placeholder) when no onEnterPrice handler is supplied (UR-14 wires one)", async () => {
    await renderTable([
      holding({
        currentPrice: {
          amount: "110.00",
          currency: "USD",
          provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
        },
      }),
    ]);
    expect(screen.getByTestId("holding-enter-price")).toBeDisabled();
  });

  it("invokes the supplied onEnterPrice handler with the holding, when one is wired", async () => {
    const onEnterPrice = vi.fn();
    const h = holding({
      currentPrice: {
        amount: "110.00",
        currency: "USD",
        provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
      },
    });
    await renderTable([h], onEnterPrice);
    screen.getByTestId("holding-enter-price").click();
    expect(onEnterPrice).toHaveBeenCalledWith(h);
  });

  it("'Voir l'instrument' is a real working link to the instrument detail route, with the exact href (UR-42 — UR-28's route now exists)", async () => {
    const h = holding();
    await renderTable([h]);
    const link = screen.getByTestId("holding-open-instrument");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", `/instruments/${h.instrumentId}`);
    expect(link).not.toHaveAttribute("disabled");
    expect(link).not.toHaveAttribute("title");
  });
});

/**
 * The 56px row, asserted where it is actually decided.
 *
 * The hover rule is unusually specific here: "table rows go to `--paper-50` and
 * **never change size**". That is a CSS property, and jsdom has neither a
 * layout engine nor a stylesheet — `getBoundingClientRect()` returns zeros for
 * every element in this file, so a DOM assertion could not tell a 56px row from
 * a 96px one, let alone catch a `:hover` rule that added two pixels of padding.
 * The stylesheet is therefore read and asserted directly: it is the artefact
 * that carries the rule, and it is checked into this repo beside the component.
 */
const HOLDINGS_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "screens", "holdings.css"),
  "utf8",
);
const KERDIAL_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "kerdial.css"),
  "utf8",
);

/** Every property that would move the row, its neighbours, or its own baseline. */
const GEOMETRY_PROPERTIES = [
  "height",
  "min-height",
  "max-height",
  "width",
  "padding",
  "margin",
  "border",
  "border-width",
  "font",
  "font-size",
  "line-height",
  "gap",
  "display",
  "position",
  "inset",
  "top",
  "bottom",
  "transform",
  "zoom",
  "scale",
];

interface CssBlock {
  readonly selector: string;
  readonly declarations: readonly string[];
}

function blocks(css: string): readonly CssBlock[] {
  // Comments first: one of them mentions `padding` inside a `:hover` discussion,
  // and a rule this test is meant to enforce must not be defeated by prose.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: CssBlock[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(stripped);
  while (match !== null) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    found.push({
      selector,
      declarations: body
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    });
    match = pattern.exec(stripped);
  }
  return found;
}

function propertyOf(declaration: string): string {
  return (declaration.split(":")[0] ?? "").trim();
}

describe("<HoldingsTable> — the row is 56px and hover never resizes it", () => {
  it("`--row-height` is the design's 56px, and the row's data line is exactly that", () => {
    expect(KERDIAL_CSS).toMatch(/--row-height:\s*56px/);

    const rowMain = blocks(HOLDINGS_CSS).filter((b) => b.selector === ".holdings-row-main");
    expect(rowMain).toHaveLength(1);
    expect(rowMain[0]?.declarations).toContain("height: var(--row-height)");
    // Not `min-height`: a minimum is a row that grows, which is the failure the
    // acceptance criterion names.
    expect(rowMain[0]?.declarations.map(propertyOf)).not.toContain("min-height");
  });

  it("every :hover rule on this screen changes colour only — never a geometry property", () => {
    const hoverBlocks = blocks(HOLDINGS_CSS).filter((b) => b.selector.includes(":hover"));
    expect(hoverBlocks.length).toBeGreaterThan(0);

    for (const block of hoverBlocks) {
      for (const declaration of block.declarations) {
        expect(
          GEOMETRY_PROPERTIES,
          `${block.selector} { ${declaration} } would resize the row on hover`,
        ).not.toContain(propertyOf(declaration));
      }
    }
  });

  it("the row's own hover goes to --paper-50 and sets nothing else", () => {
    const rowHover = blocks(HOLDINGS_CSS).filter((b) => b.selector === ".holdings-row:hover");
    expect(rowHover).toHaveLength(1);
    expect(rowHover[0]?.declarations).toEqual(["background: var(--paper-50)"]);
  });

  it("no :focus, :focus-visible or [data-selected] rule resizes the row either", () => {
    const stateful = blocks(HOLDINGS_CSS).filter(
      (b) =>
        b.selector.includes(":focus") ||
        b.selector.includes("[data-selected") ||
        b.selector.includes("[aria-selected"),
    );
    for (const block of stateful) {
      for (const declaration of block.declarations) {
        expect(GEOMETRY_PROPERTIES).not.toContain(propertyOf(declaration));
      }
    }
  });

  it("the rendered row wears the class those rules key off", async () => {
    await renderTable([holding()]);
    const row = screen.getByTestId("holdings-table-row");
    expect(row).toHaveClass("holdings-row");
    expect(row.querySelector(".holdings-row-main")).not.toBeNull();
  });
});

describe("<HoldingsTable> — the row overflow menu", () => {
  it("is closed until its trigger is pressed, then offers the shipped row actions", async () => {
    const h = holding();
    await renderTable([h]);
    expect(screen.queryByTestId("holding-row-menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("holding-row-menu-trigger"));

    const menu = screen.getByTestId("holding-row-menu");
    expect(menu).toHaveAttribute("role", "menu");
    expect(screen.getByTestId("holding-menu-open-instrument")).toHaveAttribute(
      "href",
      `/instruments/${h.instrumentId}`,
    );
    // The ledger, filtered to this instrument — `activityRoute`'s own
    // `instrument` search param, not a fabricated deep link.
    expect(screen.getByTestId("holding-menu-transactions")).toHaveAttribute(
      "href",
      `/activity?instrument=${h.instrumentId}`,
    );
    expect(screen.getByTestId("holding-menu-add-transaction")).toBeInTheDocument();
  });

  it("'Ajouter une transaction' is disabled when no handler is wired", async () => {
    await renderTable([holding()]);
    fireEvent.click(screen.getByTestId("holding-row-menu-trigger"));
    expect(screen.getByTestId("holding-menu-add-transaction")).toBeDisabled();
  });

  it("'Ajouter une transaction' calls the supplied handler with the holding", async () => {
    const onAddTransaction = vi.fn();
    const h = holding();
    await renderTable([h], undefined, onAddTransaction);
    fireEvent.click(screen.getByTestId("holding-row-menu-trigger"));
    fireEvent.click(screen.getByTestId("holding-menu-add-transaction"));
    expect(onAddTransaction).toHaveBeenCalledWith(h);
  });

  it("closes on Escape — the one-panel-at-a-time rule", async () => {
    await renderTable([holding()]);
    fireEvent.click(screen.getByTestId("holding-row-menu-trigger"));
    expect(screen.getByTestId("holding-row-menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("holding-row-menu")).not.toBeInTheDocument();
  });
});

describe("<HoldingsTable> — the footer states the count, and claims no pagination", () => {
  it("counts the rows it was given, with no page-size or page-number control", async () => {
    await renderTable([
      holding({ instrumentId: "a" }),
      holding({ instrumentId: "b" }),
      holding({ instrumentId: "c" }),
    ]);
    expect(screen.getByTestId("holdings-table-count")).toHaveTextContent("3 positions");
    expect(screen.queryByRole("navigation", { name: /pagination/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/page \d+ sur \d+/i)).not.toBeInTheDocument();
  });
});

describe("<HoldingsTable> — the class chip owns the colour", () => {
  it("renders the locked chip for the holding's kind, never a per-screen colour", async () => {
    await renderTable([holding({ kind: "CRYPTO" })]);
    const chip = screen.getByTestId("holding-kind").querySelector(".k-class-chip");
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute("data-kind", "CRYPTO");
    expect(chip?.querySelector(".k-class-chip-dot")).toHaveStyle({
      background: "var(--class-crypto)",
    });
  });
});

describe("<HoldingsTable> — column sorting", () => {
  const money = (amount: string) => ({
    amount,
    currency: "EUR",
    provenance: { derivedFrom: [] },
  });
  const rows = [
    holding({ instrumentId: "i-b", displayName: "Bravo", currentValue: money("200.00") }),
    holding({ instrumentId: "i-a", displayName: "Alpha", currentValue: money("1000.00") }),
    holding({ instrumentId: "i-c", displayName: "Charlie", currentValue: money("30.00") }),
  ];

  function names(): string[] {
    return screen.getAllByTestId("holding-display-name").map((el) => el.textContent ?? "");
  }

  it("opens on value descending and sorts a money column by magnitude, not by its rendered text", async () => {
    await renderTable(rows);
    // AC-3: biggest line first, not the caller's own order.
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);

    fireEvent.click(screen.getByTestId("holdings-sort-value"));
    // 30 < 200 < 1000 — a string sort would have given 1000, 200, 30.
    expect(names()).toEqual(["Charlie", "Bravo", "Alpha"]);

    fireEvent.click(screen.getByTestId("holdings-sort-value"));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("there is no cleared state: a column is always sorted, and another column starts in its natural direction", async () => {
    await renderTable(rows);
    const header = screen.getByTestId("holdings-sort-value");
    fireEvent.click(header);
    fireEvent.click(header);
    fireEvent.click(header);
    expect(names()).toEqual(["Charlie", "Bravo", "Alpha"]);
    // Text starts ascending …
    fireEvent.click(screen.getByTestId("holdings-sort-name"));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    // … a numeric column starts descending (the same "biggest first" reading as the default).
    fireEvent.click(screen.getByTestId("holdings-sort-value"));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("announces the sort on the columnheader, not on the button inside it", async () => {
    await renderTable(rows);
    const cell = screen.getByTestId("holdings-sort-value").closest("[role='columnheader']");
    // The default sort is announced from the first render.
    expect(cell).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByTestId("holdings-sort-value"));
    expect(cell).toHaveAttribute("aria-sort", "ascending");
    // Every other column stays "none" — the state is per-column, not global.
    const nameCell = screen.getByTestId("holdings-sort-name").closest("[role='columnheader']");
    expect(nameCell).toHaveAttribute("aria-sort", "none");
  });

  it("sorts text with French collation", async () => {
    await renderTable(rows);
    fireEvent.click(screen.getByTestId("holdings-sort-name"));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});

describe("HoldingsTable — the day % column (FR-263)", () => {
  it("renders the percentage with its sign tint when the wire carries one, and the honest dash when it does not", async () => {
    await renderTable([
      holding({
        displayName: "Avec Var",
        instrumentId: "22222222-2222-4222-8222-222222222201",
        dayChange: { amount: "40.00", currency: "EUR", provenance: { derivedFrom: ["AUTOMATED"] } },
        dayChangePercent: "0.04",
      }),
      holding({
        displayName: "Sans Var",
        instrumentId: "22222222-2222-4222-8222-222222222202",
      }),
    ]);

    const cells = screen.getAllByTestId("holding-day-change-percentage");
    expect(cells).toHaveLength(2);
    const texts = cells.map((cell) => cell.textContent);
    // formatAmount("percentage", 0.04) — the same formatter the unrealised
    // ratio uses; the absent row is a dash, never « 0 % ».
    expect(texts.some((t) => t !== null && t.includes("4"))).toBe(true);
    expect(texts.some((t) => t === "—")).toBe(true);
  });

  it("the column header sorts on the wire decimal, absent rows last", async () => {
    await renderTable([
      holding({
        displayName: "Down",
        instrumentId: "22222222-2222-4222-8222-222222222211",
        dayChange: { amount: "-10", currency: "EUR", provenance: { derivedFrom: ["AUTOMATED"] } },
        dayChangePercent: "-0.02",
      }),
      holding({
        displayName: "Sans",
        instrumentId: "22222222-2222-4222-8222-222222222212",
      }),
      holding({
        displayName: "Up",
        instrumentId: "22222222-2222-4222-8222-222222222213",
        dayChange: { amount: "10", currency: "EUR", provenance: { derivedFrom: ["AUTOMATED"] } },
        dayChangePercent: "0.03",
      }),
    ]);
    fireEvent.click(screen.getByTestId("holdings-sort-dayChange"));
    const rendered = screen.getAllByTestId("holding-display-name").map((el) => el.textContent);
    // A numeric column starts descending; the absent row is last either way.
    expect(rendered).toEqual(["Up", "Down", "Sans"]);
    fireEvent.click(screen.getByTestId("holdings-sort-dayChange"));
    expect(screen.getAllByTestId("holding-display-name").map((el) => el.textContent)).toEqual([
      "Down",
      "Up",
      "Sans",
    ]);
  });
});

describe("<HoldingsTable> — the « Liquidités » row (AC-577, AC-572)", () => {
  function eur(amount: string) {
    return { amount, currency: "EUR", provenance: { derivedFrom: [] } };
  }

  function cashBlock(totalBase: string, unconverted: readonly string[] = []): CashBlockResponse {
    return {
      totalBase,
      currency: "EUR",
      isNegative: totalBase.startsWith("-"),
      unconverted,
      byCurrency: [],
    };
  }

  /** The route's own wiring: one allocation over the holdings plus the cash row. */
  async function renderWithCash(
    holdings: readonly HoldingResponse[],
    cash: CashBlockResponse,
    total: string,
  ): Promise<void> {
    const allocation = computeAllocation(
      allocationInputOf({ holdings, totalValue: eur(total), cash }),
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
              <HoldingsTable holdings={holdings} allocation={allocation} cash={cash} />
            </Tooltip.Provider>
          </QueryClientProvider>
        ),
      }),
      createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
    ]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render((<RouterProvider router={router} />) as ReactElement);
    await screen.findByTestId("holdings-table");
  }

  const share = holding({
    currency: "EUR",
    pmp: eur("20.00"),
    costBasis: eur("200.00"),
    currentPrice: eur("20.00"),
    currentValue: eur("200.00"),
    unrealizedGainLoss: eur("0"),
  });

  function cashRow(): HTMLElement {
    const row = screen
      .getAllByTestId("holdings-table-row")
      .find((r) => r.querySelector("[data-kind='CASH']") !== null);
    expect(row).toBeDefined();
    return row!;
  }

  it("AC-577 on H: one row valued 975.00 at 82.98 %, « — » in the five columns it has no figure for, first under value-desc", async () => {
    await renderWithCash([share], cashBlock("975.00"), "1175.00");
    const rows = screen.getAllByTestId("holdings-table-row");
    expect(rows).toHaveLength(2);
    // Value descending: 975.00 of cash before the 200.00 holding.
    expect(rows[0]).toBe(cashRow());
    const row = cashRow();
    const cell = (id: string) => row.querySelector(`[data-testid='${id}']`)!;
    expect(cell("holding-display-name")).toHaveTextContent("Liquidités");
    expect(cell("holding-current-value")).toHaveTextContent("975.00 EUR");
    expect(cell("holding-allocation-percentage").textContent).toBe("82.98%");
    for (const id of [
      "holding-quantity",
      "holding-pmp",
      "holding-current-price",
      "holding-day-change-percentage",
      "holding-unrealized-gain-loss",
    ]) {
      expect(cell(id).textContent, id).toBe("—");
    }
    expect(row.querySelector("[data-testid='cash-row-overdrawn']")).toBeNull();
    // A label, a chip in the class colour; no instrument to open.
    expect(row.querySelector(".k-class-chip-dot")).toHaveStyle({
      background: "var(--class-cash)",
    });
    expect(row.querySelector("[data-testid='holding-open-instrument']")).toBeNull();
  });

  it("AC-572: cash -50.00 beside 200.00 carries the overdrawn badge, and the subtotals still reconcile to 150.00", async () => {
    await renderWithCash([share], cashBlock("-50.00"), "150.00");
    const row = cashRow();
    expect(row.querySelector("[data-testid='cash-row-overdrawn']")).toHaveTextContent("Découvert");
    expect(row.querySelector("[data-testid='holding-current-value']")).toHaveTextContent(
      "\u221250.00 EUR",
    );
    const subtotals = screen.getAllByTestId("holdings-table-kind-subtotal-row");
    expect(subtotals.map((r) => r.textContent)).toEqual(["SHARE133.33%", "Liquidités\u221233.33%"]);
  });

  it("AC-570 (UI): a currency without a rate is named on the row", async () => {
    await renderWithCash([share], cashBlock("100.00", ["USD"]), "300.00");
    expect(cashRow().querySelector("[data-testid='cash-row-unconverted']")).toHaveTextContent(
      "taux indisponible : USD",
    );
  });
});
