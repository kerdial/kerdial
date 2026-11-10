import { render, screen, within } from "@testing-library/react";
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
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  InstrumentTable,
  historyThroughText,
  priceFreshnessDetail,
  priceFreshnessInstantText,
  priceFreshnessText,
  type InstrumentRowData,
} from "./InstrumentTable.js";
import { InstrumentCardList } from "./InstrumentCardList.js";
import type { HistoryStatusResponse } from "../lib/api-client.js";

/**
 * UR-27. `@tanstack/react-virtual`'s real `useVirtualizer` reports a
 * zero-size scroll container under jsdom (no layout engine), so it would
 * render zero rows regardless of fixture size — the same limitation
 * `HoldingsTable.test.tsx` documents and works around with the identical
 * mock (every row rendered unconditionally, so this file can assert each
 * row's own content).
 *
 * `<InstrumentTable>` renders a real `<Link>` (`instrument-open-detail`),
 * so this suite needs a mounted `RouterProvider` — the same minimal
 * in-test router `PortfolioCardsPanel.test.tsx` already establishes for the
 * identical reason. It also renders `<Figure>` for a held row's last price,
 * so it needs the ancestor `Tooltip.Provider` the app root supplies
 * (`Figure.tsx`'s own "Tooltip.Provider lives at the app root" note).
 *
 * The status-**dot** suite below: the negative half
 * of "never a coloured row fill" is asserted directly, by rendering the five
 * shipped statuses side by side and proving the rows are identical while only
 * the dots differ.
 */
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 56, key: index })),
    getTotalSize: () => count * 56,
    measureElement: () => undefined,
  }),
  useWindowVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 56, key: index })),
    getTotalSize: () => count * 56,
    measureElement: () => undefined,
    options: { scrollMargin: 0 },
  }),
}));

function row(overrides: Partial<InstrumentRowData> = {}): InstrumentRowData {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    heldState: "held",
    detail: {
      id: "11111111-1111-1111-1111-111111111111",
      kind: "SHARE",
      displayName: "Apple Inc",
      listingCurrency: "USD",
      exchangeMic: "XNAS",
      isin: "US0378331005",
      symbol: "AAPL",
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
    },
    detailError: undefined,
    historyStatus: {
      status: "COMPLETE",
      requestedFrom: null,
      earliestBackfilledDate: "2025-01-01",
      latestBackfilledDate: "2026-08-01",
      // A bookmark five weeks behind a quote that landed today — the
      // exact shape the bug produced in the live deployment (NOV priced
      // 2026-09-07 under a bookmark of 2026-09-01), so the fixture itself
      // fails if one date is ever rendered for the other again.
      lastQuoteAt: "2026-09-07T10:44:43Z",
      latestPriceDate: "2026-09-07",
    },
    historyStatusError: undefined,
    ...overrides,
  };
}

function renderTable(rows: readonly InstrumentRowData[], selectedInstrumentId?: string): void {
  renderInRouter(() => <InstrumentTable rows={rows} selectedInstrumentId={selectedInstrumentId} />);
}

function renderInRouter(component: () => ReactElement): void {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/instruments/$instrumentId" }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider delayDuration={200}>
          <RouterProvider router={router} />
        </Tooltip.Provider>
      </QueryClientProvider>
    ) as ReactElement,
  );
}

describe("<InstrumentTable> — UR-27", () => {
  it("renders one row per entry, with name/kind/MIC/currency/quote-policy/held-state/market-data-status/action", async () => {
    renderTable([row()]);
    expect(await screen.findAllByTestId("instrument-table-row")).toHaveLength(1);
    expect(screen.getByTestId("instrument-name")).toHaveTextContent("Apple Inc");
    expect(screen.getByTestId("instrument-symbol")).toHaveTextContent("AAPL");
    // The type chip renders the locked asset-class label (`asset-class.ts`),
    // not the raw wire kind — which is also what keeps the colour identical to
    // every other chip/legend for the same class.
    expect(screen.getByTestId("instrument-kind")).toHaveTextContent("Action");
    expect(screen.getByTestId("instrument-mic")).toHaveTextContent("XNAS");
    expect(screen.getByTestId("instrument-currency")).toHaveTextContent("USD");
    // There used to be two dates here and the bookmark column has since gone
    // (2026-09-08): what is left is the observation. It is formatted in the
    // viewer's zone (it renders an instant), so it is asserted against that
    // same formatter rather than a hard-coded day the runner's timezone could
    // move.
    const freshness = screen.getByTestId("instrument-price-freshness");
    expect(freshness).toHaveTextContent(
      new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" }).format(
        new Date("2026-09-07T10:44:43Z"),
      ),
    );
    expect(freshness.getAttribute("title")).toMatch(
      /^Dernier cours reçu le \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/,
    );
    expect(screen.getByTestId("instrument-history-badge")).toHaveTextContent("Complet");
    // The full, audited sentence stays reachable rather than being truncated
    // into a narrow column.
    expect(screen.getByTestId("instrument-market-data-status")).toHaveAttribute(
      "title",
      "Historique disponible depuis le 01/01/2025.",
    );
    // The row IS the link now — there is no « Voir » cell. Asserted on the
    // row element itself, and paired below with the absence of the cells this
    // table deliberately dropped.
    expect(screen.getByTestId("instrument-table-row")).toHaveAttribute(
      "href",
      "/instruments/11111111-1111-1111-1111-111111111111",
    );
  });

  it("drops the four columns a list was the wrong place for, and the second label beside the name", async () => {
    renderTable([row()]);
    await screen.findByTestId("instrument-table-row");

    // Absence assertions, each paired with a positive companion in the test
    // above (the row rendered, and the columns that DID survive carry their
    // values) — so "not in the document" cannot pass because nothing rendered.
    expect(screen.queryByTestId("instrument-quote-policy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-coverage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-held-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-open-detail")).not.toBeInTheDocument();
    // The backfill resume bookmark, off the list since 2026-09-08 — it is an
    // operator fact about one instrument, and the detail screen still states
    // it. `InstrumentCardList` keeps it, as it keeps the three above: a card
    // has vertical room and never scrolls sideways.
    expect(screen.queryByTestId("instrument-history-through")).not.toBeInTheDocument();

    // The header is the other half: eight columns, and none of the four
    // removed names survives in it.
    const header = screen.getByTestId("instrument-table-header");
    expect(header.children).toHaveLength(8);
    expect(header).not.toHaveTextContent("Source du cours");
    expect(header).not.toHaveTextContent("Couverture");
    expect(header).not.toHaveTextContent("Action");
    expect(header).toHaveTextContent("Instrument");
    expect(header).toHaveTextContent("Dernier cours");
    expect(header).toHaveTextContent("Historique");
    // The earlier guarantee survives the removal: the one date column left is
    // the observation and says so, and « Mise à jour » — the label that used
    // to stand for the bookmark — is gone from the header entirely.
    expect(header).toHaveTextContent("Cours du");
    expect(header).not.toHaveTextContent("Hist. jusqu'au");
    expect(header).not.toHaveTextContent("Mise à jour");
  });

  it("mounts no reload button, because a button inside the row anchor would be invalid HTML that swallows its own clicks", async () => {
    renderTable([row({ historyStatus: { status: "FAILED" } as never })]);
    await screen.findByTestId("instrument-table-row");
    expect(screen.queryByTestId("instrument-reload")).not.toBeInTheDocument();
    // Positive companion: the FAILED row really did render, and its badge says
    // so — without this, "no reload button" would also hold for an empty table.
    expect(screen.getByTestId("instrument-history-badge")).toHaveTextContent("Échec");
  });

  it("renders no symbol span when symbol is null — never a broken-looking column", async () => {
    renderTable([
      row({
        detail: {
          ...row().detail!,
          symbol: null,
        },
      }),
    ]);
    await screen.findByTestId("instrument-table-row");
    expect(screen.queryByTestId("instrument-symbol")).not.toBeInTheDocument();
  });

  it("renders a historical (sold-out) row without a held-state label — the filter above the table carries that distinction now", async () => {
    renderTable([row({ heldState: "historical" })]);
    // The row renders (positive companion) and carries no second label.
    expect(await screen.findByTestId("instrument-name")).toHaveTextContent("Apple Inc");
    expect(screen.queryByTestId("instrument-held-state")).not.toBeInTheDocument();
  });

  it("renders a loading placeholder, never a blank cell, while detail has not resolved yet", async () => {
    renderTable([row({ detail: undefined })]);
    expect(await screen.findByTestId("instrument-name")).toHaveTextContent("…");
    expect(screen.getByTestId("instrument-kind")).toHaveTextContent("—");
  });

  it("renders the held instrument's last price from the caller's cached holdings, and — for a historical row — nothing at all", async () => {
    renderTable([
      row({
        instrumentId: "held",
        lastPrice: {
          amount: "198.20",
          currency: "USD",
          provenance: { derivedFrom: ["AUTOMATED"] },
        },
      }),
      row({ instrumentId: "sold-out", heldState: "historical" }),
    ]);
    const cells = await screen.findAllByTestId("instrument-last-price");
    expect(cells[0]).toHaveTextContent("198.20 USD");
    expect(cells[1]).toHaveTextContent("—");
  });

  it("highlights exactly the row matching selectedInstrumentId (the sel search param)", async () => {
    renderTable([row({ instrumentId: "a" }), row({ instrumentId: "b" })], "b");
    const rows = await screen.findAllByTestId("instrument-table-row");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
  });
});

/**
 * The restyle's acceptance criterion states it outright: **"Status
 * is a dot, never a row fill; asserted in a test."**
 */
describe("<InstrumentTable> — status is a dot, never a coloured row fill", () => {
  const STATUSES: ReadonlyArray<HistoryStatusResponse["status"]> = [
    "COMPLETE",
    "IN_PROGRESS",
    "PENDING",
    "FAILED",
    "NONE",
  ];

  function rowWithStatus(status: HistoryStatusResponse["status"]): InstrumentRowData {
    return row({
      instrumentId: `inst-${status}`,
      historyStatus: { ...row().historyStatus!, status },
    });
  }

  it("gives each status its own dot tone, off the one shared tone map", async () => {
    renderTable(STATUSES.map(rowWithStatus));
    const dots = await screen.findAllByTestId("instrument-status-dot");
    expect(dots.map((dot) => dot.getAttribute("data-tone"))).toEqual([
      "gain",
      "brand",
      "warn",
      "loss",
      "neutral",
    ]);
  });

  it("leaves the row itself byte-for-byte identical across every status — no fill, no tone, no inline background", async () => {
    renderTable(STATUSES.map(rowWithStatus));
    const rows = await screen.findAllByTestId("instrument-table-row");
    expect(rows).toHaveLength(STATUSES.length);

    // Same class list on every row: the status cannot have reached it.
    const classes = new Set(rows.map((el) => el.className));
    expect([...classes]).toEqual(["k-inst-grid k-inst-row"]);

    for (const el of rows) {
      // Nothing status-derived on the row element itself…
      expect(el.getAttribute("data-tone")).toBeNull();
      expect(el.getAttribute("data-status")).toBeNull();
      // …and no inline background of any kind (the virtualiser owns the only
      // inline style here: position/transform).
      expect(el.style.background).toBe("");
      expect(el.style.backgroundColor).toBe("");
      expect(el.getAttribute("style")).not.toMatch(/background/);
    }
  });

  it("pairs every dot with the same tone on a badge that also says it in words — never colour alone", async () => {
    renderTable(STATUSES.map(rowWithStatus));
    const dots = await screen.findAllByTestId("instrument-status-dot");
    const badges = screen.getAllByTestId("instrument-history-badge");
    expect(badges.map((b) => b.getAttribute("data-tone"))).toEqual(
      dots.map((d) => d.getAttribute("data-tone")),
    );
    expect(badges.map((b) => b.textContent)).toEqual([
      "Complet",
      "En cours",
      "En attente",
      "Échec",
      "Non demandé",
    ]);
  });

  /*
   * AC-15 and AC-21's reload-affordance assertions used to live here. They have
   * MOVED to `InstrumentCardList.test.tsx`, not been deleted: this table no
   * longer mounts `InstrumentReloadButton` at all (the row is an `<a>` now, and
   * a nested `<button>` is invalid HTML that swallows its own clicks), so the
   * Instruments screen applies `showReloadAffordance`'s two-mode rule only in
   * the mobile card list. The detail screen carries an unconditional reload.
   *
   * What this file asserts instead is the absence, above — with the header's
   * eight columns as its positive companion.
   */
});

describe("<InstrumentCardList> — the reload affordance", () => {
  it("offers no reload on an SCPI card even in catalogue mode, and keeps it on a SHARE card", async () => {
    const share = row();
    const scpi = row({
      instrumentId: "33333333-3333-4333-8333-333333333333",
      detail: {
        ...share.detail!,
        id: "33333333-3333-4333-8333-333333333333",
        kind: "SCPI",
        displayName: "Corum Origin",
        exchangeMic: null,
        isin: null,
        symbol: "CORUM",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "MANUAL_ONLY",
      },
    });
    renderInRouter(() => <InstrumentCardList rows={[share, scpi]} reloadOnEveryRow />);

    const [shareCard, scpiCard] = await screen.findAllByTestId("instrument-card");
    expect(within(scpiCard!).getByTestId("instrument-name")).toHaveTextContent("Corum Origin");
    expect(within(scpiCard!).queryByTestId("instrument-reload")).not.toBeInTheDocument();
    expect(within(shareCard!).getByTestId("instrument-reload")).toBeInTheDocument();
  });
});

/**
 * The price-freshness rules, on the pure functions rather than through a render: the
 * two-value preference, the fallback that a `MANUAL_ONLY` instrument depends
 * on, and the two "nothing to show" answers — which are the ones a regression
 * would quietly turn back into the backfill bookmark.
 */
describe("price-freshness copy", () => {
  function status(overrides: Partial<HistoryStatusResponse> = {}): HistoryStatusResponse {
    return {
      status: "COMPLETE",
      requestedFrom: null,
      earliestBackfilledDate: "2025-01-01",
      latestBackfilledDate: "2026-08-01",
      lastQuoteAt: null,
      latestPriceDate: null,
      ...overrides,
    };
  }

  it("prefers the quote instant over the series date, and never falls back to the bookmark", () => {
    const withBoth = status({ lastQuoteAt: "2026-09-07T10:44:43Z", latestPriceDate: "2026-09-04" });
    expect(priceFreshnessInstantText(withBoth)).toBe(
      new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(
        new Date("2026-09-07T10:44:43Z"),
      ),
    );
    expect(priceFreshnessDetail(withBoth)).toMatch(/^Dernier cours reçu le /);
    // The bookmark is 2026-08-01 in this fixture and appears in neither
    // freshness string — the substitution this guards against.
    expect(priceFreshnessText(withBoth)).not.toContain("08");
    expect(historyThroughText(withBoth)).toBe("01/08/2026");
  });

  it("falls back to the newest series date when there is no quote — the only freshness a MANUAL_ONLY instrument has", () => {
    const manualOnly = status({ status: "NONE", latestPriceDate: "2026-09-04" });
    expect(priceFreshnessText(manualOnly)).toBe("04/09/2026");
    expect(priceFreshnessInstantText(manualOnly)).toBe("04/09/2026");
    expect(priceFreshnessDetail(manualOnly)).toBe("Dernier point de série du 04/09/2026");
  });

  it("says so when there is no observation at all, rather than borrowing the backfill bookmark", () => {
    const nothing = status({ latestBackfilledDate: "2026-08-01" });
    expect(priceFreshnessText(nothing)).toBe("—");
    expect(priceFreshnessInstantText(nothing)).toBe("—");
    expect(priceFreshnessDetail(nothing)).toBe("Aucun cours reçu");
  });

  it("answers for a row whose history-status read has not landed (or failed) without inventing a date", () => {
    expect(priceFreshnessText(undefined)).toBe("—");
    expect(priceFreshnessInstantText(undefined)).toBe("—");
    expect(priceFreshnessDetail(undefined)).toBe("Aucun cours reçu");
    expect(historyThroughText(undefined)).toBe("—");
  });
});
