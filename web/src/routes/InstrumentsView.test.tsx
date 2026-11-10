import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import type {
  HoldingResponse,
  HoldingsResponse,
  InstrumentDetailResponse,
  TransactionResponse,
} from "../lib/api-client.js";
import { cheapReadBudget } from "../lib/request-budget.js";
import { InstrumentsView, type InstrumentsSearchState } from "./InstrumentsView.js";

/**
 * UR-26/UR-27. Necessary supporting plumbing beyond UR-27's stated file list: the
 * router-agnostic view (`ActivityView.tsx`'s identical UR-19 precedent —
 * `InstrumentsRoute.tsx` reads `instrumentsRoute.useSearch()`, which pulls
 * in `router.js` -> `AppShell.tsx` -> `virtual:pwa-register/react`, not
 * resolvable under plain `vitest`).
 *
 * `<InstrumentsView>` renders real `<Link>`s (`InstrumentTable`/
 * `InstrumentCardList`'s own `instrument-open-detail`), so this suite needs
 * a mounted `RouterProvider` — the same minimal in-test router
 * `PortfolioCardsPanel.test.tsx` already establishes. Since then it also
 * renders `<Figure>` for a held row's last price, so it needs the ancestor
 * `Tooltip.Provider` the app root supplies (`Figure.tsx`'s own note).
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchHoldings: vi.fn(),
    listTransactions: vi.fn(),
    fetchInstrument: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    listInstrumentCatalogue: vi.fn(),
    requestInstrumentHistoryReload: vi.fn(),
    // `watchlist` FR-371/W-6: this screen mounts one
    // `GET /watchlist/ids` read, from which each row's `<WatchToggle>` derives
    // its own state. Stubbed here so no unmocked fetch leaves this suite —
    // an **addition** to the mock; no assertion in this file moved (AC-347).
    fetchWatchedInstrumentIds: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);

/**
 * Same stub `HoldingsRoute.test.tsx` already establishes for
 * `useMediaQuery`'s `window.matchMedia` call — jsdom implements neither.
 * This suite stubs `false` (mobile, `InstrumentCardList`) rather than
 * `true`: `InstrumentTable`'s real `@tanstack/react-virtual` reports a
 * zero-size scroll container under jsdom (no layout engine) and would
 * render zero rows regardless of fixture size (`InstrumentTable.test.tsx`'s
 * own documented mock works around this for that file specifically) —
 * `InstrumentCardList` is deliberately never virtualised,
 * so it needs no such workaround and is what this suite's own data-assembly/
 * filtering assertions actually exercise.
 */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function holdingsResponse(holdings: readonly HoldingResponse[]): HoldingsResponse {
  return {
    asOfDate: "2026-08-15",
    holdings,
    totalValue: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
    totalUnrealizedGainLoss: { amount: "0", currency: "EUR", provenance: { derivedFrom: [] } },
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "1",
    portfolioCount: 1,
  };
}

function holding(instrumentId: string, overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId,
    kind: "SHARE",
    displayName: `Held ${instrumentId}`,
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "10",
    currency: "USD",
    pmp: { amount: "1", currency: "USD", provenance: { derivedFrom: [] } },
    costBasis: { amount: "10", currency: "USD", provenance: { derivedFrom: [] } },
    currentPrice: { amount: "1", currency: "USD", provenance: { derivedFrom: [] } },
    currentValue: { amount: "10", currency: "USD", provenance: { derivedFrom: [] } },
    unrealizedGainLoss: { amount: "0", currency: "USD", provenance: { derivedFrom: [] } },
    realizedGains: [],
    ...overrides,
  };
}

function transaction(instrumentId: string | null): TransactionResponse {
  return {
    id: `tx-${instrumentId}`,
    portfolioId: "port-1",
    kind: "BUY",
    tradeDate: "2026-01-01",
    tradeTs: null,
    seq: "1",
    instrumentId,
    quantity: "1",
    unitPrice: "1",
    grossAmount: "1",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    fxRateProviderKey: null,
    fxRateObservedOn: null,
    fxRateUserInput: null,
    note: null,
    reference: null,
    transferLinkedTransactionId: null,
    transferLinkedPortfolioId: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function instrumentDetail(
  id: string,
  overrides: Partial<InstrumentDetailResponse> = {},
): InstrumentDetailResponse {
  return {
    id,
    kind: "SHARE",
    displayName: `Instrument ${id}`,
    listingCurrency: "USD",
    exchangeMic: "XNAS",
    isin: null,
    symbol: null,
    figi: null,
    primaryIdentifier: "ISIN",
    quotePolicy: "AUTO",
    status: "ACTIVE",
    sectorCode: null,
    industryLabel: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderView(search: InstrumentsSearchState = {}): {
  onSearchChange: (updater: (prev: InstrumentsSearchState) => InstrumentsSearchState) => void;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let currentSearch = search;
  const onSearchChange = vi.fn(
    (updater: (prev: InstrumentsSearchState) => InstrumentsSearchState) => {
      currentSearch = updater(currentSearch);
    },
  );

  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <InstrumentsView search={currentSearch} onSearchChange={onSearchChange} />,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    (
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider delayDuration={200}>
          <RouterProvider router={router} />
        </Tooltip.Provider>
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onSearchChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(false);
});

describe("<InstrumentsView> — UR-26/UR-27", () => {
  it("renders the held-derived set immediately, and adds a historical (sold-out) row once the scan resolves", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([holding("held-1")]));
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(instrumentDetail(id)),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
      status: "NONE",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      lastQuoteAt: null,
      latestPriceDate: null,
    });
    // The scan resolves only once released — proves the held row renders
    // without waiting for it.
    let releaseScan: (() => void) | undefined;
    mockedApiClient.listTransactions.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseScan = () => resolve({ items: [transaction("sold-out-1")], nextCursor: null });
        }),
    );

    renderView();

    await waitFor(() => expect(screen.getByTestId("instruments-scan-loading")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getAllByTestId(/instrument-(table-row|card)/).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByTestId("instrument-name").map((el) => el.textContent)).toEqual([
      expect.stringContaining("Instrument held-1"),
    ]);

    releaseScan?.();

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(2));
    const names = screen.getAllByTestId("instrument-name").map((el) => el.textContent ?? "");
    expect(names.some((t) => t.includes("held-1"))).toBe(true);
    expect(names.some((t) => t.includes("sold-out-1"))).toBe(true);
    expect(screen.queryByTestId("instruments-scan-loading")).not.toBeInTheDocument();
  });

  it("shows the truncated note only when the scan reports truncated: true", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));
    // A genuinely-advancing cursor on every page (never repeating) so the
    // scan actually reaches its 50-page cap — mirrors `queries.test.ts`'s
    // own AC107-substrate fixture. A closure counter, not a parsed-from-
    // string page number (`web/src`'s no-floats syntactic ban forbids
    // `Number()` call syntax outright, even here).
    let callIndex = 0;
    mockedApiClient.listTransactions.mockImplementation(async () => {
      const pageNumber = callIndex;
      callIndex += 1;
      return {
        items: [transaction(`inst-${pageNumber}`)],
        nextCursor: `cursor-${pageNumber + 1}`,
      };
    });
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(instrumentDetail(id)),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
      status: "NONE",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      lastQuoteAt: null,
      latestPriceDate: null,
    });

    renderView();

    await waitFor(() =>
      expect(screen.getByTestId("instruments-truncated-note")).toBeInTheDocument(),
    );
  });

  it("filters client-side by kind, over the whole derived set", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse([holding("share-1"), holding("etf-1")]),
    );
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(instrumentDetail(id, { kind: id === "etf-1" ? "ETF" : "SHARE" })),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
      status: "NONE",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      lastQuoteAt: null,
      latestPriceDate: null,
    });

    renderView({ kind: "ETF" });

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(1));
    expect(screen.getByTestId("instrument-name")).toHaveTextContent("etf-1");
  });

  it("scpi AC-508: a held SCPI's row reads « SCPI », and « SCPI » is a kind the filter can select", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse([holding("share-1"), holding("scpi-a", { kind: "SCPI" })]),
    );
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(
        instrumentDetail(
          id,
          id === "scpi-a"
            ? {
                kind: "SCPI",
                exchangeMic: null,
                quotePolicy: "MANUAL_ONLY",
                listingCurrency: "EUR",
              }
            : {},
        ),
      ),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue({
      status: "NONE",
      requestedFrom: null,
      earliestBackfilledDate: null,
      latestBackfilledDate: null,
      lastQuoteAt: null,
      latestPriceDate: null,
    });

    renderView({ kind: "SCPI" });

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(1));
    expect(screen.getByTestId("instrument-name")).toHaveTextContent("scpi-a");
    await waitFor(() => expect(screen.getByTestId("instrument-kind")).toHaveTextContent("SCPI"));
    expect(screen.getByRole("option", { name: "SCPI" })).toBeInTheDocument();
  });

  it("shows the no-instruments empty state when the derived set is genuinely empty", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });

    renderView();

    await waitFor(() =>
      expect(screen.getByTestId("instruments-empty-no-instruments")).toBeInTheDocument(),
    );
  });

  it("the 4-up stat strip counts what has resolved, and renders no percentage it cannot compute", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(
      holdingsResponse([holding("auto-1"), holding("manual-1")]),
    );
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(
        instrumentDetail(id, { quotePolicy: id === "manual-1" ? "MANUAL_ONLY" : "AUTO" }),
      ),
    );
    // One COMPLETE, one FAILED — so every tile has a distinguishable answer.
    mockedApiClient.fetchInstrumentHistoryStatus.mockImplementation((id: string) =>
      Promise.resolve({
        status: id === "manual-1" ? ("FAILED" as const) : ("COMPLETE" as const),
        requestedFrom: null,
        earliestBackfilledDate: "2025-01-01",
        latestBackfilledDate: "2026-08-01",
        lastQuoteAt: null,
        latestPriceDate: null,
      }),
    );

    renderView();

    await waitFor(() =>
      expect(screen.getByTestId("instruments-stat-total")).toHaveTextContent("2"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("instruments-stat-coverage")).toHaveTextContent("1 / 2"),
    );
    expect(screen.getByTestId("instruments-stat-manual")).toHaveTextContent("1");
    expect(screen.getByTestId("instruments-stat-attention")).toHaveTextContent("1");
    // Every figure is a count over rows this screen already holds — a
    // "96.4% of instrument-days" figure has no counterpart on this wire, so no
    // percentage is rendered anywhere in the strip.
    expect(screen.getByTestId("instruments-stat-strip").textContent).not.toMatch(/%/);
  });

  it("a stat whose per-row reads have not settled renders `…`, never a `0` that reads as an answer", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([holding("slow-1")]));
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(instrumentDetail(id)),
    );
    // Never resolves — the history read stays in flight for the whole test.
    // TanStack reports `error: null` (not `undefined`) meanwhile, which is the
    // distinction `isPresentError` exists to keep straight; before it, this
    // test read every pending row as settled and got `0 / 1` back.
    mockedApiClient.fetchInstrumentHistoryStatus.mockImplementation(() => new Promise(() => {}));

    renderView();

    // The total is knowable immediately; the two history-derived tiles are not.
    await waitFor(() =>
      expect(screen.getByTestId("instruments-stat-total")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("instruments-stat-coverage")).toHaveTextContent("…");
    expect(screen.getByTestId("instruments-stat-coverage")).not.toHaveTextContent("0");
    expect(screen.getByTestId("instruments-stat-attention")).toHaveTextContent("…");
    expect(screen.getByTestId("instruments-stat-attention")).not.toHaveTextContent("0");
  });
});

/*
 * IR-23 / AC-26's footnote suite lived here and is **removed with the footnote
 * itself** — `InstrumentsView` no longer renders
 * `instruments-catalogue-footnote`, so the three assertions were asserting a
 * DOM node that cannot exist.
 *
 * AC-26 is **not** left unguarded by this. Its two halves were always split:
 * the copy half — "no surface carries copy implying membership tracking of any
 * index" — is a repo-wide source scan in
 * `core/api-contracts/src/index-membership-containment.test.ts`, and that scan
 * is untouched and still green (10/10, and its own matchers re-red-confirmed
 * when this change was made). What is gone is the surface-level half, which
 * asserted provenance copy on a screen that has deliberately stopped carrying
 * it. If the footnote returns, these tests should return with it.
 */

/**
 * IB11/IB12/IB13 (FR-188–FR-193) — catalogue mode (`mode: "catalogue"`).
 * Distinct from UR-26/UR-27's suite above: that one exercises the default
 * `deriveInstrumentSet` row source (unchanged, AC-19), this one exercises the
 * additive `GET /instruments`-backed row source these tests never touch.
 */
function historyStatus(
  overrides: Partial<{
    status: "NONE" | "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";
    requestedFrom: string | null;
    earliestBackfilledDate: string | null;
    latestBackfilledDate: string | null;
  }> = {},
) {
  return {
    status: "NONE" as const,
    requestedFrom: null,
    earliestBackfilledDate: null,
    latestBackfilledDate: null,
    lastQuoteAt: null,
    latestPriceDate: null,
    ...overrides,
  };
}

describe("<InstrumentsView> — catalogue mode (IB11/IB12/IB13)", () => {
  beforeEach(() => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));
    mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    mockedApiClient.fetchInstrument.mockImplementation((id: string) =>
      Promise.resolve(instrumentDetail(id)),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
  });

  it("AC-16/AC-17: shows a catalogue page's rows, a never-held row still carries a price-data status, and walking nextCursor reaches the next page", async () => {
    mockedApiClient.listInstrumentCatalogue.mockImplementation(({ cursor } = {}) =>
      cursor === undefined
        ? Promise.resolve({
            items: [instrumentDetail("cat-1"), instrumentDetail("cat-2")],
            nextCursor: "page-2",
          })
        : Promise.resolve({ items: [instrumentDetail("cat-3")], nextCursor: null }),
    );

    const { onSearchChange } = renderView({ mode: "catalogue" });

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(2));
    // AC-17: `cat-1`/`cat-2` are held/transacted nowhere in this test's
    // fixtures, and the row still renders a price-data status — proving the
    // status column here is independent of `deriveInstrumentSet`.
    expect(screen.getAllByTestId("instrument-held-state").map((el) => el.textContent)).toEqual([
      "Jamais détenu",
      "Jamais détenu",
    ]);
    expect(mockedApiClient.fetchInstrumentHistoryStatus).toHaveBeenCalledWith(
      "cat-1",
      expect.anything(),
    );
    expect(mockedApiClient.fetchInstrumentHistoryStatus).toHaveBeenCalledWith(
      "cat-2",
      expect.anything(),
    );

    // AC-16: a non-null `nextCursor` renders the pagination control; walking
    // it is `onSearchChange` moving `cursor` to the server's own token.
    const nextPage = screen.getByTestId("instruments-catalogue-next-page");
    fireEvent.click(nextPage);
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    const updater = vi.mocked(onSearchChange).mock.calls[0]?.[0] as (
      prev: InstrumentsSearchState,
    ) => InstrumentsSearchState;
    expect(updater({ mode: "catalogue" })).toEqual({ mode: "catalogue", cursor: "page-2" });
  });

  it("held/historical rows in catalogue mode read the same held/transacted membership as the default view", async () => {
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([holding("cat-held")]));
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({
      items: [
        instrumentDetail("cat-held"),
        instrumentDetail("cat-unheld"),
        instrumentDetail("cat-historical"),
      ],
      nextCursor: null,
    });
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [transaction("cat-historical")],
      nextCursor: null,
    });

    renderView({ mode: "catalogue" });

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(3));
    const rows = screen
      .getAllByTestId("instrument-name")
      .map((el, i) => [
        el.textContent,
        screen.getAllByTestId("instrument-held-state")[i]?.textContent,
      ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        [expect.stringContaining("cat-held"), "Détenu"],
        [expect.stringContaining("cat-unheld"), "Jamais détenu"],
        [expect.stringContaining("cat-historical"), "Historique"],
      ]),
    );
  });

  it("AC-20: no footnote claims the catalogue cannot be browsed, because there is no footnote at all", async () => {
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({ items: [], nextCursor: null });

    renderView({ mode: "catalogue" });

    // The screen renders (positive companion) — without it, "no footnote"
    // would also hold for a view that never mounted, which is the absence
    // assertion this repo has recorded a dozen carriers of.
    await waitFor(() => expect(screen.getByTestId("instruments-screen")).toBeInTheDocument());

    // AC-20's claim was that the footnote must not say the catalogue cannot be
    // browsed. Removing the footnote satisfies it in the strongest available
    // way: the false sentence cannot be rendered because no sentence is.
    expect(screen.queryByTestId("instruments-catalogue-footnote")).not.toBeInTheDocument();
    expect(screen.queryByText(/non de liste de vos instruments suivis/)).not.toBeInTheDocument();
  });

  it("AC-19 (explicit): mounting in catalogue mode never renders the stat strip or the 'mine'-mode subtitle", async () => {
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({
      items: [instrumentDetail("cat-1")],
      nextCursor: null,
    });

    renderView({ mode: "catalogue" });

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(1));
    expect(screen.queryByTestId("instruments-stat-strip")).not.toBeInTheDocument();
  });

  it("AC-21: a never-held catalogue row's reload button issues the real request and reports acceptance", async () => {
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({
      items: [instrumentDetail("cat-unheld")],
      nextCursor: null,
    });
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(
      historyStatus({ status: "FAILED" }),
    );
    mockedApiClient.requestInstrumentHistoryReload.mockResolvedValue({
      instrumentId: "cat-unheld",
      status: "PENDING",
      previousStatus: "FAILED",
      requestedFrom: "2006-08-24",
      enqueued: true,
    });

    renderView({ mode: "catalogue" });

    const reloadButton = await waitFor(() => screen.getByTestId("instrument-reload"));
    fireEvent.click(reloadButton);

    await waitFor(() =>
      expect(mockedApiClient.requestInstrumentHistoryReload).toHaveBeenCalledWith("cat-unheld"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("instrument-reload-accepted")).toBeInTheDocument(),
    );
  });

  it("AC-18: peak concurrently in-flight background history-status reads with a full catalogue page never exceeds the shared cheapReadBudget bound (4)", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `cat-budget-${i}`);
    mockedApiClient.listInstrumentCatalogue.mockResolvedValue({
      items: ids.map((id) => instrumentDetail(id)),
      nextCursor: null,
    });

    let current = 0;
    let peak = 0;
    // Deliberately never resolved: with nothing releasing a slot, the real
    // `cheapReadBudget` singleton admits exactly its bound and queues the
    // rest, so the peak is reached deterministically with no manual
    // draining — this is what makes the assertion below non-flaky.
    mockedApiClient.fetchInstrumentHistoryStatus.mockImplementation(
      () =>
        new Promise(() => {
          current += 1;
          peak = Math.max(peak, current);
        }),
    );

    renderView({ mode: "catalogue" });

    await waitFor(() => expect(screen.getAllByTestId("instrument-name")).toHaveLength(ids.length));
    // Let every queued background read actually reach the real
    // `cheapReadBudget` singleton before reading the peak — `useQueries`
    // dispatches the 20 entries across a few microtasks. Nothing in this
    // mock ever resolves, so `current` only rises and settles once every
    // admitted/queued read has been issued; a fixed real-time wait is safe
    // here specifically because of that monotonicity.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // `request-budget.test.ts`'s own case 1 is the generic proof that the
    // shared singleton itself never exceeds its configured bound over 50
    // concurrent acquisitions; this asserts the *screen* actually routes its
    // whole 20-row fan-out through that one real instance (never a second,
    // uncoordinated budget, FR-190) rather than asserting the constant's
    // exact value, which a leaked slot from an unrelated earlier test in
    // this same module-singleton budget (the deliberately-unresolved
    // fixture) can legitimately lower without this property being violated.
    expect(peak).toBeLessThanOrEqual(cheapReadBudget.maxConcurrent);
    // Genuine overlap was actually observed — not a vacuous single-slot
    // budget or a fan-out that never got past 1.
    expect(peak).toBeGreaterThan(1);
  });
});
