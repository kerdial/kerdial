import * as Tooltip from "@radix-ui/react-tooltip";
import { render, screen } from "@testing-library/react";
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
import type { HoldingResponse } from "../lib/api-client.js";
import { historyStatusTone } from "../lib/history-status-badge.js";
import { ControlsTable } from "./ControlsTable.js";
import {
  classifyControlRow,
  controlCoverageText,
  controlDataStatus,
  controlHistoryBadge,
  controlLastAvailableText,
  controlRequestedFromText,
  controlSignalText,
  countControlJobs,
  type ControlRowData,
} from "../lib/control-rows.js";

/**
 * UR-30..UR-32. Same
 * `@tanstack/react-virtual` jsdom workaround `InstrumentTable.test.tsx`/
 * `HoldingsTable.test.tsx` already use (real `useVirtualizer` reports a
 * zero-size scroll container under jsdom).
 */
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 48, key: index })),
    getTotalSize: () => count * 48,
    measureElement: () => undefined,
  }),
}));

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

function row(overrides: Partial<ControlRowData> = {}): ControlRowData {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    heldState: "held",
    detail: undefined,
    detailError: undefined,
    historyStatus: {
      status: "COMPLETE",
      requestedFrom: null,
      earliestBackfilledDate: "2025-01-01",
      latestBackfilledDate: "2026-08-01",
      lastQuoteAt: null,
      latestPriceDate: null,
    },
    historyStatusError: undefined,
    holding: holding(),
    ...overrides,
  };
}

/**
 * `async`, and awaits `"controls-table"` before returning: `RouterProvider`
 * resolves its initial route match asynchronously even for a memory router
 * mounted at `"/"` with no data loader of its own (`HoldingsTable.test.tsx`'s
 * own `renderTable` doc comment records the same fact and fix).
 */
async function renderTable(
  rows: readonly ControlRowData[],
  onEnterPrice?: (h: HoldingResponse) => void,
): Promise<void> {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ControlsTable rows={rows} onEnterPrice={onEnterPrice} />,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/portfolios" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The single `Tooltip.Provider` lives at the app root (`AppShell.tsx`), so a
  // component mounted on its own needs one here: the jargon hints this surface
  // renders go through Radix exactly as `<Figure>` does, and
  // Radix throws on first render without an ancestor provider rather than
  // degrading quietly.
  render(
    (
      <Tooltip.Provider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Tooltip.Provider>
    ) as ReactElement,
  );
  await screen.findByTestId("controls-table");
}

describe("classifyControlRow — the single derivation both presentations read (FR-120)", () => {
  it("a held row needing manual price entry is Action requise, regardless of history-status", () => {
    const r = row({
      holding: holding({
        currentPrice: {
          amount: "0.00",
          currency: "USD",
          provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
        },
      }),
    });
    expect(classifyControlRow(r)).toBe("action-requise");
  });

  it("a FAILED backfill is Action requise, even with no current holding", () => {
    const r = row({
      holding: undefined,
      heldState: "historical",
      historyStatus: {
        status: "FAILED",
        requestedFrom: null,
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
        lastQuoteAt: null,
        latestPriceDate: null,
      },
    });
    expect(classifyControlRow(r)).toBe("action-requise");
  });

  it("PENDING/IN_PROGRESS (not otherwise flagged) is En cours", () => {
    for (const status of ["PENDING", "IN_PROGRESS"] as const) {
      const r = row({
        historyStatus: {
          status,
          requestedFrom: null,
          earliestBackfilledDate: null,
          latestBackfilledDate: null,
          lastQuoteAt: null,
          latestPriceDate: null,
        },
      });
      expect(classifyControlRow(r)).toBe("en-cours");
    }
  });

  it("COMPLETE is Information", () => {
    expect(classifyControlRow(row())).toBe("information");
  });

  it("NONE is Information — terminal, never 'en cours' (FR-117, D9 precedent)", () => {
    const r = row({
      historyStatus: {
        status: "NONE",
        requestedFrom: null,
        earliestBackfilledDate: null,
        latestBackfilledDate: null,
        lastQuoteAt: null,
        latestPriceDate: null,
      },
    });
    expect(classifyControlRow(r)).toBe("information");
  });
});

describe("controlSignalText — combines provenance and history-status signals honestly", () => {
  it("prefixes the manual-pricing reason when the row needs one", () => {
    const r = row({
      holding: holding({
        currentPrice: {
          amount: "0.00",
          currency: "USD",
          provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
        },
      }),
    });
    expect(controlSignalText(r)).toContain("Cours à saisir manuellement");
  });

  it("never mentions manual pricing for a row that does not need it", () => {
    expect(controlSignalText(row())).not.toContain("Cours à saisir manuellement");
  });
});

describe("the history badge — one tone map, shared with the Instruments list", () => {
  it("assigns complete = gain, in progress = brand, pending = warn, failed = loss", () => {
    // Asserted against an independently written literal rather than against
    // the map itself, so a future edit to the map has to be a deliberate edit
    // here too.
    //
    // The map now lives in `lib/history-status-badge.ts`. Instruments
    // and Contrôles were built in parallel and each wrote its own copy;
    // they happened to agree, but two copies are one edit away from not
    // agreeing, so they were hoisted into one module. This assertion is the
    // reason that hoist is safe to make.
    const shipped = Object.fromEntries(
      (["COMPLETE", "IN_PROGRESS", "PENDING", "FAILED", "NONE"] as const).map((status) => [
        status,
        historyStatusTone(status),
      ]),
    );
    expect(shipped).toEqual({
      COMPLETE: "gain",
      IN_PROGRESS: "brand",
      PENDING: "warn",
      FAILED: "loss",
      NONE: "neutral",
    });
  });

  it("states an unresolved read as loading and a failed read as unavailable, never as a status the response never reported", () => {
    expect(controlHistoryBadge(row({ historyStatus: undefined }))).toEqual({
      label: "Chargement…",
      tone: "neutral",
    });
    expect(
      controlHistoryBadge(row({ historyStatus: undefined, historyStatusError: new Error("x") })),
    ).toEqual({ label: "Indisponible", tone: "neutral" });
  });
});

describe("the data-status badge and the three date columns", () => {
  it("flags a row needing manual pricing as a loss, a healthy priced row as a gain, and a sold-out row as neutral", () => {
    expect(controlDataStatus(row())).toEqual({ label: "Cours à jour", tone: "gain" });
    expect(
      controlDataStatus(
        row({
          holding: holding({
            currentPrice: {
              amount: "0.00",
              currency: "USD",
              provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
            },
          }),
        }),
      ),
    ).toEqual({ label: "Cours à saisir", tone: "loss" });
    expect(controlDataStatus(row({ holding: undefined, heldState: "historical" }))).toEqual({
      label: "Non valorisé",
      tone: "neutral",
    });
  });

  it("renders exactly one wire field per column, and an em dash where the response carries none", () => {
    const r = row({
      historyStatus: {
        status: "COMPLETE",
        requestedFrom: "2024-06-30",
        earliestBackfilledDate: "2025-01-01",
        latestBackfilledDate: "2026-08-01",
        lastQuoteAt: null,
        latestPriceDate: null,
      },
    });
    expect(controlCoverageText(r)).toBe("01/01/2025");
    expect(controlRequestedFromText(r)).toBe("30/06/2024");
    expect(controlLastAvailableText(r)).toBe("01/08/2026");
    expect(controlRequestedFromText(row())).toBe("—");
  });
});

describe("countControlJobs — the strip's counts and the progress bar's numerator", () => {
  it("counts failed, running, and settled reads over the rows the screen actually has", () => {
    const counts = countControlJobs([
      row({ instrumentId: "a" }),
      row({
        instrumentId: "b",
        historyStatus: {
          status: "FAILED",
          requestedFrom: null,
          earliestBackfilledDate: null,
          latestBackfilledDate: null,
          lastQuoteAt: null,
          latestPriceDate: null,
        },
      }),
      row({
        instrumentId: "c",
        historyStatus: {
          status: "IN_PROGRESS",
          requestedFrom: null,
          earliestBackfilledDate: null,
          latestBackfilledDate: null,
          lastQuoteAt: null,
          latestPriceDate: null,
        },
      }),
      // Still in flight: neither resolved nor errored, so not yet "checked" —
      // this is what makes the footer bar's numerator a real one.
      row({ instrumentId: "d", historyStatus: undefined }),
      row({ instrumentId: "e", historyStatus: undefined, historyStatusError: new Error("x") }),
    ]);
    expect(counts).toEqual({ failed: 1, running: 1, checked: 4 });
  });
});

describe("<ControlsTable> — grouped rendering", () => {
  it("renders the three group headers with exact counts", async () => {
    await renderTable([
      row({ instrumentId: "a" }),
      row({
        instrumentId: "b",
        holding: holding({
          instrumentId: "b",
          currentPrice: {
            amount: "0.00",
            currency: "USD",
            provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
          },
        }),
      }),
      row({
        instrumentId: "c",
        holding: undefined,
        historyStatus: {
          status: "PENDING",
          requestedFrom: null,
          earliestBackfilledDate: null,
          latestBackfilledDate: null,
          lastQuoteAt: null,
          latestPriceDate: null,
        },
      }),
    ]);

    const headers = screen.getAllByTestId("controls-group-header");
    expect(headers).toHaveLength(3);
    expect(headers[0]).toHaveTextContent("Action requise (1)");
    expect(headers[1]).toHaveTextContent("En cours (1)");
    expect(headers[2]).toHaveTextContent("Information (1)");
  });

  it("shows the honest empty-group copy for a bucket with no members, not a blank section", async () => {
    await renderTable([row()]); // Information only
    const actionRequiseEmpty = screen
      .getAllByTestId("controls-group-empty")
      .find((el) => el.getAttribute("data-bucket") === "action-requise");
    expect(actionRequiseEmpty).toBeDefined();
    expect(actionRequiseEmpty).toHaveTextContent("Rien ne nécessite d'action pour le moment.");
  });

  it("'Voir l'instrument' is a real working link with the exact href", async () => {
    const r = row();
    await renderTable([r]);
    const link = screen.getByTestId("control-open-instrument");
    expect(link).toHaveAttribute("href", `/instruments/${r.instrumentId}`);
  });

  it("'Voir les portefeuilles' appears only for a currently-held row, linking to /portfolios (never a specific /portfolios/$portfolioId — no portfolioId on the wire)", async () => {
    await renderTable([
      row({ heldState: "held" }),
      row({ instrumentId: "hist", heldState: "historical", holding: undefined }),
    ]);
    const links = screen.getAllByTestId("control-open-portfolios");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/portfolios");
  });

  it("'Saisir un cours' invokes onEnterPrice with the holding, only rendered when the row needs manual pricing", async () => {
    const onEnterPrice = vi.fn();
    const h = holding({
      currentPrice: {
        amount: "0.00",
        currency: "USD",
        provenance: { derivedFrom: ["MANUAL_PRICE"], priceQuality: "MANUAL" },
      },
    });
    await renderTable([row({ holding: h }), row({ instrumentId: "healthy" })], onEnterPrice);
    const enterPriceButtons = screen.getAllByTestId("control-enter-price");
    expect(enterPriceButtons).toHaveLength(1);
    enterPriceButtons[0]?.click();
    expect(onEnterPrice).toHaveBeenCalledWith(h);
  });

  it("never mounts InstrumentHistoryStatus.tsx's own polling component", async () => {
    await renderTable([row()]);
    expect(screen.queryByTestId("instrument-history-status")).not.toBeInTheDocument();
  });

  it("AC115: no audit-trail-implying copy anywhere in the rendered output", async () => {
    await renderTable([
      row({ instrumentId: "a" }),
      row({
        instrumentId: "b",
        historyStatus: {
          status: "FAILED",
          requestedFrom: null,
          earliestBackfilledDate: null,
          latestBackfilledDate: null,
          lastQuoteAt: null,
          latestPriceDate: null,
        },
      }),
    ]);
    const text = document.body.textContent ?? "";
    for (const banned of [
      "historique des modifications",
      "journal",
      "audit",
      "révision",
      "qui a modifié",
    ]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it("AC-15 (instrument-catalogue-backfill IB13): a FAILED row shows the reload affordance, a COMPLETE row does not", async () => {
    await renderTable([
      row({
        instrumentId: "failed-row",
        historyStatus: {
          status: "FAILED",
          requestedFrom: null,
          earliestBackfilledDate: null,
          latestBackfilledDate: null,
          lastQuoteAt: null,
          latestPriceDate: null,
        },
      }),
      row({ instrumentId: "healthy-row" }), // default fixture status: COMPLETE
    ]);
    const reloadButtons = screen.getAllByTestId("control-reload-history");
    expect(reloadButtons).toHaveLength(1);
    expect(reloadButtons[0]).toHaveAttribute("data-history-status", "FAILED");
  });
});
