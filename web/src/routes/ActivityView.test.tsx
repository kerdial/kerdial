import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { TransactionResponse } from "../lib/api-client.js";
import { ActivityView, type ActivitySearchState } from "./ActivityView.js";

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    listTransactions: vi.fn(),
    fetchTransactionCalendar: vi.fn(),
    getTransaction: vi.fn(),
    fetchPortfolios: vi.fn(),
    searchInstruments: vi.fn(),
    fetchInstrument: vi.fn(),
    fetchCurrencies: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);

/**
 * `ActivityView.test.tsx` — **the type filter is server-backed.**
 *
 * The debt this file exists to keep retired: `type` was applied client-side
 * over `data.items` (the currently loaded page), which passed every
 * "the right rows are on screen" assertion while quietly narrowing one page of
 * a ledger rather than the ledger. So the assertions here are about the
 * **request** — what `listTransactions` was called with — not only about what
 * rendered. A regression back to page-local filtering would keep the rendered
 * rows right and drop `kind` from the call.
 *
 * Renders the **view**, not the route (the `DividendsView.test.tsx` precedent):
 * `ActivityView` is router-agnostic, so this suite never imports `router.js`
 * and never has to resolve `virtual:pwa-register/react`. A router is still
 * needed in the tree because `PageHeader` renders `<Link>`s.
 */
const PORTFOLIO = "44444444-4444-4444-8444-444444444444";
const INSTRUMENT = "11111111-1111-4111-8111-111111111111";

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: `tx-${overrides.kind ?? "BUY"}-${overrides.tradeDate ?? "2026-01-01"}`,
    portfolioId: PORTFOLIO,
    kind: "BUY",
    tradeDate: "2026-01-01",
    tradeTs: null,
    seq: "1",
    reference: null,
    transferLinkedTransactionId: null,
    transferLinkedPortfolioId: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    instrumentId: INSTRUMENT,
    quantity: "10",
    unitPrice: "10.00",
    grossAmount: "100.00",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    cashAccountId: null,
    targetCashAccountId: null,
    cashCurrency: "EUR",
    cashAmount: "100.00",
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
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderView(
  search: ActivitySearchState = {},
  opts: { readonly baseCurrency?: string } = {},
): {
  onSearchChange: ReturnType<typeof vi.fn>;
} {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `BaseTotal` labels the income tiles from `/auth/me`'s
  // `baseCurrency`, read from the guard-populated cache (`enabled: false`,
  // never a fetch) — so a test that wants labelled totals seeds the cache the
  // way the router guard does in the app. Deliberately NOT seeded by default:
  // the unseeded case is itself under test (the honest "—", never an "EUR"
  // literal).
  if (opts.baseCurrency !== undefined) {
    client.setQueryData(["auth", "me"], {
      tenantId: "00000000-0000-7000-8000-000000000001",
      userId: "00000000-0000-7000-8000-000000000002",
      email: "user@example.test",
      baseCurrency: opts.baseCurrency,
      // `account-setup` FR-419 — on the real wire, so on the fixture too.
      isInstanceAdmin: false,
    });
  }
  const onSearchChange = vi.fn();
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ActivityView search={search} onSearchChange={onSearchChange} />,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The single `Tooltip.Provider` lives at the app root (`AppShell.tsx`); a
  // labelled income total renders through `<Figure>`, whose provenance
  // tooltip needs it — same wrapping `ControlsTable.test.tsx` documents.
  render(
    (
      <Tooltip.Provider>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Tooltip.Provider>
    ) as ReactElement,
  );
  return { onSearchChange };
}

/** The params object of the most recent `listTransactions` call. */
function lastRequestedParams(): Record<string, unknown> {
  const calls = mocked.listTransactions.mock.calls;
  return (calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined) ?? {};
}

/** The `kind` value of the most recent `listTransactions` call. */
function lastRequestedKind(): unknown {
  return lastRequestedParams()["kind"];
}

/**
 * The same stub `HoldingsRoute.test.tsx`/`InstrumentsView.test.tsx` establish
 * for `useMediaQuery`'s `window.matchMedia` call — jsdom implements neither.
 * `false` (mobile, `TransactionCardList`) rather than `true`: the card list is
 * never virtualised, so it renders every fixture row under jsdom's absent
 * layout engine, and the rows are incidental here anyway — this file's subject
 * is the request.
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

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(false);
  mocked.fetchPortfolios.mockResolvedValue([
    { id: PORTFOLIO, name: "Compte principal", transactionCount: 3, createdAt: "2026-01-01" },
  ] as never);
  mocked.searchInstruments.mockResolvedValue([]);
  mocked.fetchInstrument.mockResolvedValue({
    id: INSTRUMENT,
    displayName: "TotalEnergies",
  } as never);
  mocked.fetchCurrencies.mockResolvedValue([
    { code: "EUR", name: "Euro", minorUnit: 2 },
    { code: "USD", name: "Dollar américain", minorUnit: 2 },
  ] as never);
  mocked.getTransaction.mockResolvedValue(transaction());
  mocked.listTransactions.mockResolvedValue({
    items: [transaction()],
    nextCursor: null,
  });
});

describe("<ActivityView> — the type filter is the server's `kind`, not a page-local narrowing", () => {
  it("sends no kind when no type is selected", async () => {
    renderView();
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    expect(lastRequestedKind()).toBeUndefined();
  });

  it("sends ?kind=<type> when the search state carries one", async () => {
    renderView({ type: "DIVIDEND" });
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    expect(lastRequestedKind()).toBe("DIVIDEND");
  });

  // cash-interest AC-521; portfolio-cash AC-581 for FEE.
  it.each([
    ["INTEREST", "Intérêt"],
    ["FEE", "Frais de portefeuille"],
  ] as const)(
    "the %s filter (« %s ») requests that ?kind and shows only the rows returned",
    async (kind, label) => {
      mocked.listTransactions.mockResolvedValue({
        items: [transaction({ kind, instrumentId: null, tradeDate: "2026-03-03" })],
        nextCursor: null,
      });
      renderView({ type: kind });
      await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
      expect(lastRequestedKind()).toBe(kind);
      await waitFor(() => expect(screen.getAllByTestId("transaction-card")).toHaveLength(1));
      expect(screen.getByTestId("transaction-card")).toHaveTextContent(label);
    },
  );

  it("renders exactly what the server returned — it never filters the page itself", async () => {
    // The server is the filter, so a response is rendered verbatim. A client
    // that still narrowed `items` by `search.type` would drop this row (its
    // kind is BUY while the selected type is SELL) and show an empty state.
    mocked.listTransactions.mockResolvedValue({
      items: [transaction({ kind: "BUY", tradeDate: "2026-02-02" })],
      nextCursor: null,
    });
    renderView({ type: "SELL" });
    await waitFor(() =>
      expect(screen.getAllByTestId(/transaction-(table-row|card)/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("activity-empty-filtered")).not.toBeInTheDocument();
  });

  it("selecting a type in the filter bar puts it in the search state and resets the cursor", async () => {
    const { onSearchChange } = renderView({ cursor: "20" });
    await waitFor(() => expect(screen.getByTestId("ledger-filter-type")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("ledger-filter-type"), { target: { value: "WITHDRAWAL" } });

    expect(onSearchChange).toHaveBeenCalledTimes(1);
    const updater = onSearchChange.mock.calls[0]![0] as (
      prev: ActivitySearchState,
    ) => ActivitySearchState;
    const next = updater({ cursor: "20", type: undefined });
    expect(next.type).toBe("WITHDRAWAL");
    // A cursor computed against the previous filter set has no meaning under
    // a new one — the same rule every other filter change already follows.
    expect(next.cursor).toBeUndefined();
  });
});

describe("<ActivityView> — the ledger's row order", () => {
  it("reads newest-first by default, without the URL carrying a sort", async () => {
    renderView();
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    // The *server's* default is ascending (FR-264 keeps it there for API
    // callers); the screen's is not, and the request is where that shows.
    expect(lastRequestedParams()["order"]).toBe("desc");
  });

  it("honours an explicit ?sort=asc rather than overriding it with the default", async () => {
    renderView({ sort: "asc" });
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    expect(lastRequestedParams()["order"]).toBe("asc");
  });

  it("flips the order from the date header and drops the cursor with it", async () => {
    // The sort control is on the desktop table; the default stub in this file
    // is the mobile card list, which has no column headers at all.
    stubMatchMedia(true);
    const { onSearchChange } = renderView({ cursor: "20" });
    await waitFor(() => expect(screen.getByTestId("transaction-sort-date")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("transaction-sort-date"));

    const updater = onSearchChange.mock.calls[onSearchChange.mock.calls.length - 1]![0] as (
      prev: ActivitySearchState,
    ) => ActivitySearchState;
    const next = updater({ cursor: "20" });
    expect(next.sort).toBe("asc");
    // A new order is a new total order: an offset cursor computed against the
    // old one addresses a different page of a different sequence.
    expect(next.cursor).toBeUndefined();
  });

  it("does not sort the page it was handed — the order is the server's", async () => {
    stubMatchMedia(true);
    // Handed out of date order on purpose: a client-side sort would "fix" this
    // fixture and would be ordering one cursor page against itself.
    mocked.listTransactions.mockResolvedValue({
      items: [
        transaction({ id: "22222222-2222-4222-8222-222222222222", tradeDate: "2026-03-02" }),
        transaction({ id: "33333333-3333-4333-8333-333333333333", tradeDate: "2026-07-09" }),
      ],
      nextCursor: null,
    } as never);
    renderView();

    await waitFor(() => expect(screen.getAllByTestId("transaction-table-row").length).toBe(2));
    const dates = screen.getAllByTestId("transaction-date").map((cell) => cell.textContent);
    expect(dates).toEqual(["02/03/2026", "09/07/2026"]);
  });
});

describe("<ActivityView> — the page-local honesty machinery is gone", () => {
  it("renders no page-scoped count when a type is selected", async () => {
    mocked.listTransactions.mockResolvedValue({
      items: [transaction({ kind: "DIVIDEND" })],
      nextCursor: null,
    });
    renderView({ type: "DIVIDEND" });
    await waitFor(() =>
      expect(screen.getAllByTestId(/transaction-(table-row|card)/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("activity-type-filter-scope")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-filter-type-honesty-note")).not.toBeInTheDocument();
  });

  it("an empty result under a type is the ordinary filtered empty state, not a third page-scoped one", async () => {
    mocked.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    renderView({ type: "SELL" });
    await waitFor(() => expect(screen.getByTestId("activity-empty-filtered")).toBeInTheDocument());
    // AC141's first state is for a genuinely empty, unfiltered tenant — a
    // selected type must never be mistaken for one.
    expect(screen.queryByTestId("activity-empty-no-transactions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("activity-empty-type-filtered")).not.toBeInTheDocument();
  });

  it("an empty result with NO filters at all is still the first-use state", async () => {
    mocked.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    renderView({});
    await waitFor(() =>
      expect(screen.getByTestId("activity-empty-no-transactions")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("activity-empty-filtered")).not.toBeInTheDocument();
  });
});

/**
 * The 368px filters panel. Same discipline as the type-filter block
 * above, for the same reason: `currency` and the two amount bounds are the
 * filters most tempting to approximate client-side, and an approximation over
 * a *cursor-paginated* page passes every "the right rows are on screen"
 * assertion while filtering the page rather than the ledger. So what is
 * asserted is the request, and that a server response is rendered verbatim.
 */
describe("<ActivityView> — the panel's filters are the server's, over the whole ledger", () => {
  it("sends currency and both bounds when the search state carries them", async () => {
    renderView({ currency: "EUR", minAmount: "100", maxAmount: "2500" });
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    const params = lastRequestedParams();
    expect(params["currency"]).toBe("EUR");
    expect(params["minAmount"]).toBe("100");
    expect(params["maxAmount"]).toBe("2500");
  });

  it("sends none of the three when none is selected", async () => {
    renderView();
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    const params = lastRequestedParams();
    expect(params["currency"]).toBeUndefined();
    expect(params["minAmount"]).toBeUndefined();
    expect(params["maxAmount"]).toBeUndefined();
  });

  it("carries the filters onto page 2 as well — a later page is filtered like the first", async () => {
    renderView({ currency: "EUR", minAmount: "100", cursor: "20" });
    await waitFor(() => expect(mocked.listTransactions).toHaveBeenCalled());
    const params = lastRequestedParams();
    expect(params["cursor"]).toBe("20");
    expect(params["currency"]).toBe("EUR");
    expect(params["minAmount"]).toBe("100");
  });

  it("renders exactly what the server returned — it never narrows items by amount or currency", async () => {
    // Deliberately contradictory: a 5 USD row under a « ≥ 1 000 EUR » filter.
    // Any client-side narrowing by currency or amount would drop it and show
    // the filtered empty state; the server is the filter, so it renders.
    mocked.listTransactions.mockResolvedValue({
      items: [transaction({ grossAmount: "5.00", txnCurrency: "USD" })],
      nextCursor: null,
    });
    renderView({ currency: "EUR", minAmount: "1000" });
    await waitFor(() =>
      expect(screen.getAllByTestId(/transaction-(table-row|card)/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("activity-empty-filtered")).not.toBeInTheDocument();
  });

  it("an empty result under an amount filter is the ordinary filtered empty state, not the first-use one", async () => {
    mocked.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
    renderView({ currency: "EUR", minAmount: "1000000" });
    await waitFor(() => expect(screen.getByTestId("activity-empty-filtered")).toBeInTheDocument());
    expect(screen.queryByTestId("activity-empty-no-transactions")).not.toBeInTheDocument();
  });
});

describe("<ActivityView> — the panel writes the search params, and a reload restores them", () => {
  it("Appliquer writes every panel filter into the search state and resets the cursor", async () => {
    const { onSearchChange } = renderView({ cursor: "20" });
    await waitFor(() => expect(screen.getByTestId("activity-open-filters")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("activity-open-filters"));
    const currency = screen.getByTestId("ledger-filters-panel-currency");
    await waitFor(() => expect(currency.querySelectorAll("option").length).toBeGreaterThan(1));

    fireEvent.change(currency, { target: { value: "USD" } });
    fireEvent.change(screen.getByTestId("ledger-filters-panel-min-amount"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByTestId("ledger-filters-panel-type"), {
      target: { value: "SELL" },
    });
    fireEvent.click(screen.getByTestId("ledger-filters-panel-apply"));

    // The first call is the click on « Filtres » closing the detail drawer.
    const updater = onSearchChange.mock.calls[onSearchChange.mock.calls.length - 1]![0] as (
      prev: ActivitySearchState,
    ) => ActivitySearchState;
    const next = updater({ cursor: "20" });
    expect(next.currency).toBe("USD");
    expect(next.minAmount).toBe("100");
    expect(next.type).toBe("SELL");
    // A cursor computed against the previous filter set means nothing here.
    expect(next.cursor).toBeUndefined();
  });

  it("a reload with the params in the URL restores both the chips and the panel's controls", async () => {
    // This is the reload: `ActivitySearchState` is what `activityRoute`'s
    // `validateSearch` produced from the URL, and nothing else seeds the view.
    renderView({ currency: "EUR", minAmount: "100", maxAmount: "2500", type: "DIVIDEND" });

    await waitFor(() =>
      expect(screen.getByTestId("ledger-filter-chip-currency")).toHaveTextContent("Devise : EUR"),
    );
    expect(screen.getByTestId("ledger-filter-chip-min-amount")).toHaveTextContent(
      "Montant min : 100 EUR",
    );
    expect(screen.getByTestId("ledger-filter-chip-max-amount")).toHaveTextContent(
      "Montant max : 2500 EUR",
    );

    fireEvent.click(screen.getByTestId("activity-open-filters"));
    await waitFor(() =>
      expect(screen.getByTestId("ledger-filters-panel-currency")).toHaveValue("EUR"),
    );
    expect(screen.getByTestId("ledger-filters-panel-min-amount")).toHaveValue("100");
    expect(screen.getByTestId("ledger-filters-panel-max-amount")).toHaveValue("2500");
    expect(screen.getByTestId("ledger-filters-panel-type")).toHaveValue("DIVIDEND");
  });

  it("the inline bar and the panel show the same selection — one source of truth, two shapes", async () => {
    renderView({ type: "DIVIDEND", portfolio: PORTFOLIO });
    await waitFor(() => expect(screen.getByTestId("ledger-filter-type")).toHaveValue("DIVIDEND"));
    fireEvent.click(screen.getByTestId("activity-open-filters"));
    expect(screen.getByTestId("ledger-filters-panel-type")).toHaveValue("DIVIDEND");
    await waitFor(() =>
      expect(screen.getByTestId("ledger-filters-panel-portfolio")).toHaveValue(PORTFOLIO),
    );
  });
});

describe("<ActivityView> — portfolio-archive: the filters panel's portfolio select", () => {
  const ARCHIVED = "0198a000-0000-7000-8000-0000000000aa";

  beforeEach(() => {
    mocked.fetchPortfolios.mockResolvedValue([
      { id: PORTFOLIO, name: "Compte principal", transactionCount: 3, createdAt: "2026-01-01" },
      {
        id: ARCHIVED,
        name: "Ancien PEA",
        transactionCount: 1,
        createdAt: "2026-01-01",
        archived: true,
      },
    ] as never);
  });

  function panelOptions(): [string, string][] {
    const select = screen.getByTestId("ledger-filters-panel-portfolio") as HTMLSelectElement;
    return Array.from(select.options).map((option) => [option.value, option.text]);
  }

  it("AC-486: an archived portfolio is not an option when no portfolio is filtered", async () => {
    renderView();
    await waitFor(() => expect(screen.getByTestId("activity-open-filters")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("activity-open-filters"));
    await waitFor(() => expect(panelOptions().map(([value]) => value)).toContain(PORTFOLIO));
    expect(panelOptions().map(([value]) => value)).toEqual(["", PORTFOLIO]);
  });

  it("AC-487 / PA-L10: preset to it, it is listed once, suffixed, and selected", async () => {
    renderView({ portfolio: ARCHIVED });
    await waitFor(() => expect(screen.getByTestId("activity-open-filters")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("activity-open-filters"));
    await waitFor(() => expect(panelOptions()).toContainEqual([ARCHIVED, "Ancien PEA (archivé)"]));
    expect(panelOptions().filter(([value]) => value === ARCHIVED)).toHaveLength(1);
    expect(screen.getByTestId("ledger-filters-panel-portfolio")).toHaveValue(ARCHIVED);
  });
});

describe("<ActivityView> — only one right-side panel is open at a time", () => {
  it("opening the filters panel closes the transaction detail drawer", async () => {
    const { onSearchChange } = renderView({ tx: transaction().id });
    await waitFor(() => expect(screen.getByTestId("transaction-detail-panel")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("activity-open-filters"));
    expect(screen.getByTestId("ledger-filters-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-detail-panel")).not.toBeInTheDocument();
    // …and it drops `tx`, so Back does not land on a URL whose panel is gone.
    const updater = onSearchChange.mock.calls[0]![0] as (
      prev: ActivitySearchState,
    ) => ActivitySearchState;
    expect(updater({ tx: transaction().id }).tx).toBeUndefined();
  });

  it("opening a transaction's detail closes the filters panel", async () => {
    renderView();
    await waitFor(() =>
      expect(screen.getAllByTestId(/transaction-(table-row|card)/).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByTestId("activity-open-filters"));
    expect(screen.getByTestId("ledger-filters-panel")).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId("transaction-open-detail")[0]!);
    expect(screen.queryByTestId("ledger-filters-panel")).not.toBeInTheDocument();
  });

  it("the income tab offers no way to open it — its totals are scoped by from/to alone", async () => {
    renderView({ view: "income" });
    await waitFor(() => expect(screen.getByTestId("ledger-filter-from")).toBeInTheDocument());
    expect(screen.queryByTestId("activity-open-filters")).not.toBeInTheDocument();
  });
});

describe("income tiles are labelled with the tenant base currency, never a hardcoded EUR", () => {
  it("a CHF tenant's dividend total says CHF — the label comes from /auth/me's baseCurrency", async () => {
    mocked.listTransactions.mockResolvedValue({
      items: [
        transaction({
          kind: "DIVIDEND",
          instrumentId: INSTRUMENT,
          quantity: null,
          unitPrice: null,
          grossAmount: "100.00",
          txnCurrency: "CHF",
          fxRate: "1",
        }),
      ],
      nextCursor: null,
    } as never);
    renderView({ view: "income" }, { baseCurrency: "CHF" });

    const tile = await screen.findByTestId("income-totals-dividends");
    await waitFor(() => expect(tile).toHaveTextContent("CHF"));
    expect(tile).not.toHaveTextContent("EUR");
  });

  it("with no baseCurrency in the auth cache, a total renders the honest placeholder, never EUR", async () => {
    mocked.listTransactions.mockResolvedValue({
      items: [
        transaction({
          kind: "DIVIDEND",
          instrumentId: INSTRUMENT,
          quantity: null,
          unitPrice: null,
          grossAmount: "100.00",
          fxRate: "1",
        }),
      ],
      nextCursor: null,
    } as never);
    renderView({ view: "income" });

    const tile = await screen.findByTestId("income-totals-dividends");
    await waitFor(() => expect(tile).toHaveTextContent("—"));
    expect(tile).not.toHaveTextContent("EUR");
  });
});

describe("<ActivityView> — the « Calendrier » tab", () => {
  const CALENDAR = {
    baseCurrency: "EUR",
    total: { count: 3, volumeBase: "1575" },
    years: [{ period: "2025", count: 3, volumeBase: "1575" }],
    months: [
      { period: "2025-01", count: 2, volumeBase: "1100" },
      { period: "2025-03", count: 1, volumeBase: "475" },
    ],
  };

  /** The params object of the most recent `fetchTransactionCalendar` call. */
  function lastCalendarParams(): Record<string, unknown> {
    const calls = mocked.fetchTransactionCalendar.mock.calls;
    return (calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined) ?? {};
  }

  function nextSearch(onSearchChange: ReturnType<typeof vi.fn>, prev: ActivitySearchState) {
    const updater = onSearchChange.mock.calls.at(-1)![0] as (
      prev: ActivitySearchState,
    ) => ActivitySearchState;
    return updater(prev);
  }

  beforeEach(() => {
    mocked.fetchTransactionCalendar.mockResolvedValue(CALENDAR);
  });

  it("is the third tab, and shows the grid with the filters button — it takes the whole filter set", async () => {
    renderView({ view: "calendar" });
    expect((await screen.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual([
      "Journal",
      "Revenus & frais",
      "Calendrier",
    ]);
    expect(await screen.findByTestId("activity-calendar")).toBeInTheDocument();
    expect(screen.getByTestId("activity-open-filters")).toBeInTheDocument();
    // The ledger's own rows are not mounted beside it — one view at a time.
    expect(screen.queryByTestId(/transaction-(table-row|card)/)).not.toBeInTheDocument();
    expect(mocked.listTransactions).not.toHaveBeenCalled();
  });

  it("sends the ledger's filters to the calendar read — type travels as kind, exactly as on the ledger", async () => {
    renderView({
      view: "calendar",
      type: "BUY",
      portfolio: PORTFOLIO,
      from: "2025-01-01",
      to: "2025-12-31",
      currency: "EUR",
      minAmount: "10",
    });
    await screen.findByTestId("activity-calendar");
    expect(lastCalendarParams()).toEqual({
      portfolio: PORTFOLIO,
      from: "2025-01-01",
      to: "2025-12-31",
      kind: "BUY",
      currency: "EUR",
      minAmount: "10",
    });
  });

  it("the measure toggle rides the URL, and counts by default", async () => {
    const { onSearchChange } = renderView({ view: "calendar" });
    await screen.findByTestId("activity-calendar");
    expect(screen.getByRole("radio", { name: "Nombre" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "Montant" }));
    expect(nextSearch(onSearchChange, { view: "calendar" })).toEqual({
      view: "calendar",
      measure: "volume",
    });
  });

  it("« Voir dans le journal » lands on the ledger tab scoped to that month, with the cursor reset", async () => {
    const { onSearchChange } = renderView({ view: "calendar", cursor: "40", type: "BUY" });
    await screen.findByTestId("activity-calendar");
    // The detail line opens on the latest month, March 2025.
    fireEvent.click(screen.getByTestId("activity-calendar-open-month"));
    expect(nextSearch(onSearchChange, { view: "calendar", cursor: "40", type: "BUY" })).toEqual({
      view: "ledger",
      from: "2025-03-01",
      to: "2025-03-31",
      cursor: undefined,
      type: "BUY",
    });
  });

  it("tells the two empty states apart exactly as the ledger does", async () => {
    mocked.fetchTransactionCalendar.mockResolvedValue({
      ...CALENDAR,
      total: { count: 0, volumeBase: "0" },
      years: [],
      months: [],
    });
    const { onSearchChange } = renderView({ view: "calendar", type: "SELL" });
    fireEvent.click(await screen.findByTestId("activity-calendar-empty-filtered-reset"));
    expect(nextSearch(onSearchChange, { view: "calendar", type: "SELL" }).type).toBeUndefined();

    renderView({ view: "calendar" });
    expect(
      await screen.findByTestId("activity-calendar-empty-no-transactions"),
    ).toBeInTheDocument();
  });
});

/**
 * `security-transfer` TR-21: the detail drawer names a transfer's
 * other leg by its portfolio, links to it, and shows what a receiving leg
 * carried in.
 */
describe("<ActivityView> — a security transfer's detail drawer (TR-21)", () => {
  const WALLET = "55555555-5555-4555-8555-555555555555";
  const SOURCE_LEG = "66666666-6666-4666-8666-666666666666";

  beforeEach(() => {
    mocked.fetchPortfolios.mockResolvedValue([
      { id: PORTFOLIO, name: "Compte principal", transactionCount: 3, createdAt: "2026-01-01" },
      { id: WALLET, name: "Portefeuille froid", transactionCount: 1, createdAt: "2026-01-01" },
    ] as never);
  });

  it("a linked receiving leg reads « Reçu de » its source's portfolio, with a link, and its carried cost", async () => {
    const received = transaction({
      kind: "TRANSFER_IN",
      portfolioId: WALLET,
      unitPrice: null,
      grossAmount: "1240.8",
      transferLinkedTransactionId: SOURCE_LEG,
      transferLinkedPortfolioId: PORTFOLIO,
      transferCostBase: "660",
      transferCostNative: "660",
      transferCostCurrency: "EUR",
    });
    mocked.getTransaction.mockResolvedValue(received);
    renderView({ tx: received.id });

    await waitFor(() =>
      expect(screen.getByTestId("transaction-detail-transfer-partner-portfolio")).toHaveTextContent(
        "Compte principal",
      ),
    );
    expect(screen.getByText("Reçu de")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-detail-transfer-partner-link")).toHaveAttribute(
      "href",
      expect.stringContaining(`tx=${SOURCE_LEG}`),
    );
    // The carried cost, not the 1 240.80 market value.
    expect(screen.getByTestId("transaction-detail-transfer-cost")).toHaveTextContent("660");
    expect(screen.getByTestId("transaction-detail-transfer-cost")).not.toHaveTextContent("1 240");
    // In the base currency already: no second, base-currency row.
    expect(screen.queryByTestId("transaction-detail-transfer-cost-base")).not.toBeInTheDocument();
  });

  it("an unlinked source leg shows no partner and no carried cost", async () => {
    const sent = transaction({ kind: "TRANSFER_OUT", unitPrice: null, grossAmount: "1240.8" });
    mocked.getTransaction.mockResolvedValue(sent);
    renderView({ tx: sent.id });

    await waitFor(() => expect(screen.getByTestId("transaction-detail-kind")).toBeInTheDocument());
    expect(screen.getByTestId("transaction-detail-kind")).toHaveTextContent("Transfert sortant");
    expect(screen.queryByTestId("transaction-detail-transfer-partner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-detail-transfer-cost")).not.toBeInTheDocument();
  });
});
