import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type {
  HistoryStatusResponse,
  HoldingResponse,
  HoldingsResponse,
  InstrumentDetailResponse,
} from "../lib/api-client.js";
import { InstrumentDetailView } from "./InstrumentDetailView.js";

/**
 * UR-28 (AC108-AC110). Renders `InstrumentDetailView` directly — this file's
 * router-agnostic export — the same split rationale
 * `PortfolioDetailRoute.test.tsx` documents for its own component (no
 * search/params machinery here, but `InstrumentDetailRoute.tsx` still reads
 * `instrumentDetailRoute.useParams()`, which pulls in `router.js` ->
 * `AppShell.tsx` -> `virtual:pwa-register/react`).
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchInstrument: vi.fn(),
    fetchInstrumentHistoryStatus: vi.fn(),
    fetchHoldings: vi.fn(),
    listInstrumentPrices: vi.fn(),
    listInstrumentPriceWindow: vi.fn(),
    listTransactions: vi.fn(),
    postManualPricePoint: vi.fn(),
    updateInstrumentIdentity: vi.fn(),
    updateInstrumentScpiAttributes: vi.fn(),
    fetchCurrencies: vi.fn(),
    // `watchlist` FR-371/W-6: this screen mounts one
    // `GET /watchlist/ids` read, from which each row's `<WatchToggle>` derives
    // its own state. Stubbed here so no unmocked fetch leaves this suite —
    // an **addition** to the mock; no assertion in this file moved (AC-347).
    fetchWatchedInstrumentIds: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);

const INSTRUMENT_ID = "33333333-3333-3333-3333-333333333333";

function instrumentDetail(
  overrides: Partial<InstrumentDetailResponse> = {},
): InstrumentDetailResponse {
  return {
    id: INSTRUMENT_ID,
    kind: "SHARE",
    displayName: "Apple Inc",
    listingCurrency: "USD",
    exchangeMic: "XNAS",
    isin: "US0378331005",
    symbol: "AAPL",
    figi: "BBG000B9XRY4",
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

function holding(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId: INSTRUMENT_ID,
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

function historyStatus(overrides: Partial<HistoryStatusResponse> = {}): HistoryStatusResponse {
  return {
    status: "COMPLETE",
    requestedFrom: "2025-08-15",
    earliestBackfilledDate: "2025-08-16",
    latestBackfilledDate: "2026-08-15",
    // A quote three weeks past the backfill bookmark, so any surface
    // that renders one where the other belongs fails here.
    lastQuoteAt: "2026-09-07T10:44:43Z",
    latestPriceDate: "2026-09-07",
    ...overrides,
  };
}

/**
 * The {from,to} each of the chart's two reads last asked for. Compared
 * against each other rather than against pinned dates: this view passes the
 * real clock down, so the assertion that matters here is that both windows are
 * the *same* one and that a range change moves both.
 */
function lastWindows(): {
  prices: { from: string | undefined; to: string | undefined };
  trades: { from: string | undefined; to: string | undefined };
} {
  const priceCalls = mockedApiClient.listInstrumentPriceWindow.mock.calls;
  const tradeCalls = mockedApiClient.listTransactions.mock.calls;
  const prices = priceCalls[priceCalls.length - 1]?.[1];
  const trades = tradeCalls[tradeCalls.length - 1]?.[0];
  return {
    prices: { from: prices?.from, to: prices?.to },
    trades: { from: trades?.from, to: trades?.to },
  };
}

function renderView(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider delayDuration={200}>
          <InstrumentDetailView instrumentId={INSTRUMENT_ID} />
        </Tooltip.Provider>
      </QueryClientProvider>
    ) as ReactElement,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
  // The lazy chart's own two reads: the price window and the trades
  // overlaid on it. Empty by default — this suite is about the screen around
  // the chart, and `InstrumentPriceSparkline.test.tsx` owns the overlay itself.
  mockedApiClient.listInstrumentPriceWindow.mockResolvedValue({ points: [], truncated: false });
  mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
  mockedApiClient.fetchCurrencies.mockResolvedValue([
    { code: "USD", name: "Dollar américain", minorUnit: 2 },
  ]);
});

describe("<InstrumentDetailView> — UR-28", () => {
  it("AC108: shows every GET /instruments/:id field and the history status, and no longer the price list", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    expect(await screen.findByTestId("instrument-detail-name")).toHaveTextContent("Apple Inc");
    // The type renders the locked asset-class label (`asset-class.ts`), not
    // the raw wire kind — the same label every chip and legend uses.
    expect(screen.getByTestId("instrument-detail-kind")).toHaveTextContent("Action");
    expect(screen.getByTestId("instrument-detail-display-name")).toHaveTextContent("Apple Inc");
    expect(screen.getByTestId("instrument-detail-mic")).toHaveTextContent("XNAS");
    expect(screen.getByTestId("instrument-detail-currency")).toHaveTextContent("USD");
    expect(screen.getByTestId("instrument-detail-status")).toHaveTextContent("ACTIVE");
    expect(screen.getByTestId("instrument-detail-primary-identifier")).toHaveTextContent("ISIN");
    expect(screen.getByTestId("instrument-detail-symbol")).toHaveTextContent("AAPL");
    expect(screen.getByTestId("instrument-detail-isin")).toHaveTextContent("US0378331005");
    expect(screen.getByTestId("instrument-detail-figi")).toHaveTextContent("BBG000B9XRY4");

    // The full price list is deliberately **not** on this screen: the chart
    // above already shows the same series, and the per-point origin/source
    // rows live in `ManualPriceDialog`'s own mount of the same component.
    expect(screen.queryByTestId("price-point-table")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId("instrument-detail-history-status")).toHaveTextContent(
        "Historique disponible depuis le 16/08/2025.",
      ),
    );
  });

  it("renders a fallback '—' for a null symbol/isin/figi — never a broken-looking field", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(
      instrumentDetail({ symbol: null, isin: null, figi: null }),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    expect(screen.getByTestId("instrument-detail-symbol")).toHaveTextContent("—");
    expect(screen.getByTestId("instrument-detail-isin")).toHaveTextContent("—");
    expect(screen.getByTestId("instrument-detail-figi")).toHaveTextContent("—");
  });

  describe("Contexte portefeuille — held? which portfolios? quantity/value (from cached holdings, zero extra requests)", () => {
    it("says 'détenu actuellement' with an aggregate quantity/value when a matching holding exists", async () => {
      mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
      mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
      mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([holding()]));

      renderView();

      await screen.findByTestId("instrument-detail-name");
      expect(screen.getByTestId("instrument-detail-held-state")).toHaveTextContent(
        "Détenu actuellement",
      );
      expect(screen.getByTestId("instrument-detail-held-quantity")).toBeInTheDocument();
      expect(screen.getByTestId("instrument-detail-held-value")).toBeInTheDocument();
      // FR-116: `HoldingResponse` has no `portfolioId`
      // — this section must say so, never invent a per-portfolio breakdown.
      expect(screen.getByTestId("instrument-detail-portfolio-attribution-note")).toHaveTextContent(
        /ne porte pas d'identifiant de portefeuille/,
      );
    });

    it("says 'non détenu actuellement' with no quantity/value when no matching holding exists", async () => {
      mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
      mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
      mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

      renderView();

      await screen.findByTestId("instrument-detail-name");
      expect(screen.getByTestId("instrument-detail-held-state")).toHaveTextContent(
        "Non détenu actuellement",
      );
      expect(screen.queryByTestId("instrument-detail-held-quantity")).not.toBeInTheDocument();
    });
  });

  describe("AC109: all five history-status values render correctly, NONE terminal (not 'en cours')", () => {
    const cases: ReadonlyArray<[HistoryStatusResponse["status"], string]> = [
      [
        "NONE",
        "Aucune récupération automatique de l'historique n'a été demandée pour cet instrument.",
      ],
      ["PENDING", "Historique des cours en cours de récupération"],
      ["IN_PROGRESS", "Historique des cours en cours de récupération"],
      ["COMPLETE", "Historique disponible depuis le"],
      // UR-36 honesty fix: this copy no longer promises an automatic retry
      // (nothing retries a `FAILED` backfill).
      ["FAILED", "La récupération de l'historique s'est arrêtée en échec"],
    ];

    for (const [status, expectedSubstring] of cases) {
      it(`renders ${status} correctly`, async () => {
        mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
        mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus({ status }));
        mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

        renderView();

        await screen.findByTestId("instrument-detail-name");
        await waitFor(() =>
          expect(screen.getByTestId("instrument-detail-history-status")).toHaveTextContent(
            expectedSubstring,
          ),
        );
        if (status === "NONE") {
          expect(screen.getByTestId("instrument-detail-history-status")).not.toHaveTextContent(
            "en cours",
          );
        }
      });
    }
  });

  it("mounts zero instances of InstrumentHistoryStatus.tsx's own polling component — one-shot query only", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    // One-shot, non-retrying: the polling component's own testid must be
    // structurally absent, checked once against a settled render — not a
    // retrying matcher that could pass on "appeared, then went away".
    expect(screen.queryByTestId("instrument-history-status")).toBeNull();
  });

  it("AC110: manual price entry is reachable directly from this route, via ManualPriceForm", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    expect(screen.queryByTestId("manual-price-form")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("instrument-detail-enter-price"));

    expect(await screen.findByTestId("manual-price-form")).toBeInTheDocument();
  });

  it("a successful save shows a 'Cours enregistré.' notice and does not auto-close the dialog (tester-found gap, UR-35's independent-tester pass)", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));
    mockedApiClient.postManualPricePoint.mockResolvedValue({
      priceDate: "2026-08-01",
      close: "123.45",
      currency: "USD",
      sourceKey: "manual",
      origin: "MANUAL",
    });

    renderView();

    await screen.findByTestId("instrument-detail-name");
    fireEvent.click(screen.getByTestId("instrument-detail-enter-price"));
    await screen.findByTestId("manual-price-form");

    expect(screen.queryByTestId("manual-price-success")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("manual-price-date-input"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByTestId("manual-price-close-input"), {
      target: { value: "123.45" },
    });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    expect(await screen.findByTestId("manual-price-success")).toHaveTextContent(
      "Cours enregistré.",
    );
    expect(screen.getByTestId("manual-price-form")).toBeInTheDocument();
  });

  it("AC116: renders the manual-pricing-requirement note distinctly for MANUAL_ONLY vs AUTO", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(
      instrumentDetail({ quotePolicy: "MANUAL_ONLY" }),
    );
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    // The row used to print the raw `MANUAL_ONLY` enum at the reader.
    // It now shows the same French label the Instruments list uses, and keeps
    // the wire token where it belongs — as a data attribute, not as copy.
    const quotePolicy = screen.getByTestId("instrument-detail-quote-policy");
    expect(quotePolicy).toHaveTextContent("Saisie manuelle");
    expect(quotePolicy.querySelector("[data-quote-policy]")).toHaveAttribute(
      "data-quote-policy",
      "MANUAL_ONLY",
    );
    expect(screen.getByTestId("instrument-detail-manual-pricing-requirement")).toHaveTextContent(
      "nécessite une saisie manuelle",
    );
  });

  it("the history status carries the shared badge, off the one tone map the list uses", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(
      historyStatus({ status: "FAILED" }),
    );
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    const badge = await screen.findByTestId("instrument-detail-history-badge");
    // Failed = loss. The tone comes from `InstrumentTable.tsx`'s
    // `historyStatusTone`, which is also what tints the list's status dot —
    // one map, so the two screens cannot drift.
    expect(badge).toHaveAttribute("data-tone", "loss");
    expect(badge).toHaveTextContent("Échec");
  });

  it("« Dernier cours reçu » is the observation and « Historique jusqu'au » is the bookmark — two rows, never one date for both", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    // The instant renders in the viewer's zone, so it is asserted through the
    // formatter that produces it rather than a hard-coded time the runner's
    // timezone would move.
    expect(await screen.findByTestId("instrument-detail-price-freshness")).toHaveTextContent(
      new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(
        new Date("2026-09-07T10:44:43Z"),
      ),
    );
    expect(screen.getByTestId("instrument-detail-history-latest")).toHaveTextContent("15/08/2026");
  });

  it("falls back to the newest series date when the instrument has no quote row at all (MANUAL_ONLY)", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail({ kind: "FUND" }));
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(
      historyStatus({ status: "NONE", lastQuoteAt: null, latestPriceDate: "2026-09-04" }),
    );
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    expect(await screen.findByTestId("instrument-detail-price-freshness")).toHaveTextContent(
      "04/09/2026",
    );
  });

  it("the four history-status rows the design names all render", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    expect(await screen.findByTestId("instrument-detail-history-requested-from")).toHaveTextContent(
      "15/08/2025",
    );
    expect(screen.getByTestId("instrument-detail-history-earliest")).toHaveTextContent(
      "16/08/2025",
    );
    expect(screen.getByTestId("instrument-detail-history-latest")).toHaveTextContent("15/08/2026");
  });

  it("the price-history card carries a range control, and choosing a shorter range moves the requested window", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    const range = await screen.findByRole("radiogroup", { name: "Période affichée" });
    expect(range).toBeInTheDocument();
    // 1 an is the default, so the mount asks for the explicit 1-year window
    // required here; the control only ever narrows it.
    expect(screen.getByRole("radio", { name: "1A" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "3M" }));
    expect(screen.getByRole("radio", { name: "3M" })).toBeChecked();
  });

  it("a range change re-windows the price series and the trade markers together", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    await screen.findByRole("radiogroup", { name: "Période affichée" });
    // The lazy chart chunk has to have mounted before either read exists.
    await waitFor(() => expect(mockedApiClient.listTransactions).toHaveBeenCalled());

    const oneYear = lastWindows();
    // Both bounds are real ISO days, so the equality below cannot pass by
    // both sides being `undefined`.
    expect(oneYear.prices.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(oneYear.prices.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Both reads ask for the *same* window — that identity is what makes the
    // markers land on the series rather than beside it.
    expect(oneYear.prices).toEqual(oneYear.trades);

    fireEvent.click(screen.getByRole("radio", { name: "3M" }));

    await waitFor(() => {
      const threeMonths = lastWindows();
      expect(threeMonths.prices.from).not.toBe(oneYear.prices.from);
      // …and still the same window on both sides, so a shortened range can
      // never leave the previous range's markers on the new series.
      expect(threeMonths.trades).toEqual(threeMonths.prices);
      expect(threeMonths.prices.to).toBe(oneYear.prices.to);
    });
  });

  it("offers 3A and 5A, and a 5-year selection asks for a 5-year window at a cap that can carry it", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    await screen.findByRole("radiogroup", { name: "Période affichée" });
    await waitFor(() => expect(mockedApiClient.listInstrumentPriceWindow).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "3A" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "5A" }));

    await waitFor(() => {
      const calls = mockedApiClient.listInstrumentPriceWindow.mock.calls;
      const last = calls[calls.length - 1];
      const window = last?.[1];
      // Five whole years back from the same `to` — the window the label
      // claims, not a year the old ceiling would have silently kept.
      // `.map(Number)`, never a bare `Number(...)` call — `web/src`'s
      // no-floats syntactic ban (`eslint.config.mjs`) forbids that shape.
      const [fromYear] = (window?.from ?? "").split("-").map(Number) as [number];
      const [toYear] = (window?.to ?? "").split("-").map(Number) as [number];
      expect(fromYear).toBe(toYear - 5);
      // …and a page cap sized for it. At the 4-page default this read would
      // come back holding ~400 points from 2021 and flagged `truncated`.
      expect(last?.[3]).toBe(15);
    });
  });

  /*
   * The per-point Origin badge and source key (AC104) used to be asserted
   * here, against this screen's own mount of `PricePointTable`. That table is
   * no longer on this screen (the chart above shows the same series, and the
   * list under it was the "full detailed list" this cycle removed), so the
   * claim is asserted where the component actually renders now:
   * `PricePointTable.test.tsx` for the rows themselves, and
   * `ManualPriceDialog.test.tsx` for the surface that mounts them. Deleted
   * rather than moved — both assertions already existed there.
   */

  it("the manual-price modal keeps its decimal-places error state and the replace/audit-trail note", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();

    await screen.findByTestId("instrument-detail-name");
    fireEvent.click(screen.getByTestId("instrument-detail-enter-price"));
    await screen.findByTestId("manual-price-form");

    expect(screen.getByTestId("manual-price-upsert-note")).toHaveTextContent(/remplace/);
    expect(screen.getByTestId("manual-price-upsert-note")).toHaveTextContent(/piste d'audit/);

    fireEvent.change(screen.getByTestId("manual-price-close-input"), {
      target: { value: `1.${"1".repeat(19)}` },
    });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    const closeInput = await screen.findByTestId("manual-price-close-input");
    await waitFor(() => expect(closeInput).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText(/18 décimales/)).toBeInTheDocument();
    expect(mockedApiClient.postManualPricePoint).not.toHaveBeenCalled();
  });
});

/**
 * Three correction affordances became one « Modifier » button plus the
 * badge's pencil chip. The chip and its uniqueness across surfaces belong to
 * `InstrumentIconTile.test.tsx`; what is asserted here is the merged dialog:
 * one trigger, two sections, two independent saves, and an overlay that stays
 * open until it is dismissed on purpose.
 */
describe("<InstrumentDetailView> — the merged « Modifier » dialog", () => {
  async function openEditDialog(): Promise<void> {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));

    renderView();
    await screen.findByTestId("instrument-detail-name");
    fireEvent.click(screen.getByTestId("instrument-detail-edit"));
    await screen.findByTestId("instrument-detail-edit-dialog");
  }

  it("is one button on the identity card, and the two it replaced are gone", async () => {
    await openEditDialog();

    const card = screen.getByTestId("instrument-detail-identity");
    // Every *labelled* button on the card: the merged corrector, and nothing
    // else. « Saisir un cours manuel » is in the page header rather than this
    // card and the icon's trigger is now the badge's chip, so this list being
    // one entry is the "3 -> 1" claim itself. The one button dropped by the
    // filter is the glossary hint on the « Politique de cours » row, which
    // is named by `aria-label` and carries no text — asserted here so the
    // filter cannot quietly start hiding something else.
    const cardButtons = [...card.querySelectorAll("button")];
    expect(
      cardButtons
        .filter((b) => (b.textContent ?? "").trim() === "")
        .map((b) => b.className.includes("k-glossary-hint")),
    ).toEqual([true]);
    expect(
      cardButtons.map((b) => (b.textContent ?? "").trim()).filter((text) => text !== ""),
    ).toEqual(["Modifier"]);
    for (const gone of [
      "instrument-detail-correct-classification",
      "instrument-detail-edit-identity",
      "instrument-detail-manage-icon",
      "instrument-detail-classification-dialog",
      "instrument-detail-identity-dialog",
    ]) {
      expect(screen.queryByTestId(gone), `${gone} still exists`).toBeNull();
    }
  });

  it("stacks both forms as two named sections of one overlay", async () => {
    await openEditDialog();

    const dialog = screen.getByTestId("instrument-detail-edit-dialog");
    expect(dialog.textContent).toContain("Modifier l'instrument");

    const identity = screen.getByTestId("instrument-detail-edit-identity-section");
    expect(identity.querySelector("h3")?.textContent).toBe("Identité");
    expect(identity.querySelector('[data-testid="instrument-identity-form"]')).not.toBeNull();

    const classification = screen.getByTestId("instrument-detail-edit-classification-section");
    expect(classification.querySelector("h3")?.textContent).toBe("Classification");
    expect(
      classification.querySelector('[data-testid="instrument-classification-form"]'),
    ).not.toBeNull();

    // Two submits, not one: the two PATCHes stay independent, which is what
    // spares this screen a partial-failure vocabulary.
    expect(screen.getByTestId("instrument-identity-submit")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-classification-submit")).toBeInTheDocument();
  });

  it("stays open after the identity section saves, so the other section can still be reached", async () => {
    mockedApiClient.updateInstrumentIdentity.mockResolvedValue(
      instrumentDetail({ displayName: "Apple Incorporated" }),
    );
    await openEditDialog();

    fireEvent.change(screen.getByTestId("instrument-identity-display-name-input"), {
      target: { value: "Apple Incorporated" },
    });
    fireEvent.click(screen.getByTestId("instrument-identity-submit"));

    // The confirmation renders beside the section that produced it…
    const saved = await screen.findByTestId("instrument-detail-identity-saved");
    expect(saved.textContent).toContain("Identité enregistrée.");
    expect(screen.getByTestId("instrument-detail-edit-identity-section").contains(saved)).toBe(
      true,
    );
    // …and the overlay is still there, with the classification form still
    // mounted — the point of merging them.
    expect(screen.getByTestId("instrument-detail-edit-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("instrument-classification-form")).toBeInTheDocument();
    expect(mockedApiClient.updateInstrumentIdentity).toHaveBeenCalledTimes(1);
  });

  it("closes the whole overlay from a section's « Annuler » — there is no half-open state", async () => {
    await openEditDialog();

    fireEvent.click(screen.getByTestId("instrument-classification-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("instrument-detail-edit-dialog")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("instrument-identity-form")).not.toBeInTheDocument();
  });
});

/**
 * scpi cycle, AC-508 (FR-619). An SCPI's detail shows its two attributes (« Non
 * renseigné » when unset) in place of the sector/industry/listing-country rows,
 * offers « Saisir un prix de part » onto the same `POST /instruments/:id/prices`,
 * has no history-status card, and gets a third « Modifier » section.
 */
describe("<InstrumentDetailView> — an SCPI (AC-508)", () => {
  function scpiDetail(overrides: Partial<InstrumentDetailResponse> = {}): InstrumentDetailResponse {
    return instrumentDetail({
      kind: "SCPI",
      displayName: "Corum Origin",
      listingCurrency: "EUR",
      exchangeMic: null,
      isin: "FR0011526274",
      symbol: null,
      figi: null,
      quotePolicy: "MANUAL_ONLY",
      managementCompany: "Corum Asset Management",
      subscriptionFeePct: "12.00",
      ...overrides,
    });
  }

  async function renderScpi(detail: InstrumentDetailResponse): Promise<void> {
    mockedApiClient.fetchInstrument.mockResolvedValue(detail);
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));
    mockedApiClient.fetchCurrencies.mockResolvedValue([
      { code: "EUR", name: "Euro", minorUnit: 2 },
    ]);
    renderView();
    await screen.findByTestId("instrument-detail-name");
  }

  async function openEditDialog(): Promise<void> {
    fireEvent.click(screen.getByTestId("instrument-detail-edit"));
    await screen.findByTestId("instrument-detail-edit-dialog");
  }

  it("SCPI-A shows both set attributes, the fee as a percentage", async () => {
    await renderScpi(scpiDetail());

    expect(screen.getByTestId("instrument-detail-kind")).toHaveTextContent("SCPI");
    expect(screen.getByTestId("instrument-detail-management-company")).toHaveTextContent(
      "Corum Asset Management",
    );
    expect(screen.getByTestId("instrument-detail-subscription-fee")).toHaveTextContent("12.00%");
  });

  it("SCPI-B shows « Non renseigné » for both unset attributes", async () => {
    await renderScpi(
      scpiDetail({
        isin: null,
        symbol: "CORUMO",
        managementCompany: null,
        subscriptionFeePct: null,
      }),
    );

    expect(screen.getByTestId("instrument-detail-management-company")).toHaveTextContent(
      "Non renseigné",
    );
    expect(screen.getByTestId("instrument-detail-subscription-fee")).toHaveTextContent(
      "Non renseigné",
    );
  });

  it("sector, industry, listing country and the history-status card are absent for an SCPI and present for a SHARE", async () => {
    await renderScpi(scpiDetail());
    for (const gone of [
      "instrument-detail-sector",
      "instrument-detail-industry",
      "instrument-detail-listing-country",
      "instrument-detail-history-status",
    ]) {
      expect(screen.queryByTestId(gone), `${gone} shown for an SCPI`).toBeNull();
    }
    expect(screen.getByTestId("instrument-detail-domicile-country")).toBeInTheDocument();
    cleanup();

    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    renderView();
    await screen.findByTestId("instrument-detail-name");
    for (const shown of [
      "instrument-detail-sector",
      "instrument-detail-industry",
      "instrument-detail-listing-country",
      "instrument-detail-history-status",
    ]) {
      expect(screen.getByTestId(shown)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("instrument-detail-management-company")).toBeNull();
    expect(screen.queryByTestId("instrument-detail-subscription-fee")).toBeNull();
  });

  it("the price action reads « Saisir un prix de part » and one submit issues exactly one POST /instruments/:id/prices", async () => {
    mockedApiClient.postManualPricePoint.mockResolvedValue({
      priceDate: "2026-06-01",
      close: "260.00",
      currency: "EUR",
      sourceKey: "manual",
      origin: "MANUAL",
    });
    await renderScpi(scpiDetail());

    const action = screen.getByTestId("instrument-detail-enter-price");
    expect(action).toHaveTextContent("Saisir un prix de part");
    fireEvent.click(action);
    await screen.findByTestId("manual-price-form");
    expect(screen.getByTestId("instrument-detail-manual-price-dialog")).toHaveTextContent(
      "Saisir un prix de part",
    );

    fireEvent.change(screen.getByTestId("manual-price-date-input"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByTestId("manual-price-close-input"), {
      target: { value: "260.00" },
    });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    await screen.findByTestId("manual-price-success");
    expect(mockedApiClient.postManualPricePoint).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.postManualPricePoint.mock.calls[0]?.[0]).toMatchObject({
      instrumentId: INSTRUMENT_ID,
      priceDate: "2026-06-01",
      close: "260.00",
      currency: "EUR",
    });
  });

  it("a SHARE keeps « Saisir un cours manuel »", async () => {
    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    mockedApiClient.fetchInstrumentHistoryStatus.mockResolvedValue(historyStatus());
    mockedApiClient.fetchHoldings.mockResolvedValue(holdingsResponse([]));
    renderView();

    expect(await screen.findByTestId("instrument-detail-enter-price")).toHaveTextContent(
      "Saisir un cours manuel",
    );
  });

  it("the « Caractéristiques SCPI » edit section is present only for an SCPI, whose classification section keeps only the domicile", async () => {
    await renderScpi(scpiDetail());
    await openEditDialog();

    const section = screen.getByTestId("instrument-detail-edit-scpi-section");
    expect(section.querySelector("h3")?.textContent).toBe("Caractéristiques SCPI");
    expect(screen.getByTestId("instrument-scpi-management-company-input")).toHaveValue(
      "Corum Asset Management",
    );
    expect(screen.getByTestId("instrument-scpi-subscription-fee-input")).toHaveAttribute(
      "type",
      "text",
    );
    expect(screen.queryByTestId("instrument-classification-sector-select")).toBeNull();
    expect(screen.queryByTestId("instrument-classification-industry-input")).toBeNull();
    expect(screen.getByTestId("instrument-classification-domicile-input")).toBeInTheDocument();
    cleanup();

    mockedApiClient.fetchInstrument.mockResolvedValue(instrumentDetail());
    renderView();
    await screen.findByTestId("instrument-detail-name");
    await openEditDialog();
    expect(screen.queryByTestId("instrument-detail-edit-scpi-section")).toBeNull();
    expect(screen.getByTestId("instrument-classification-sector-select")).toBeInTheDocument();
  });

  it("saving one attribute issues one PATCH …/scpi-attributes carrying only that key, and the detail refetches", async () => {
    mockedApiClient.updateInstrumentScpiAttributes.mockResolvedValue(
      scpiDetail({ subscriptionFeePct: "10.00" }),
    );
    await renderScpi(scpiDetail());
    const readsBefore = mockedApiClient.fetchInstrument.mock.calls.length;
    await openEditDialog();

    fireEvent.change(screen.getByTestId("instrument-scpi-subscription-fee-input"), {
      target: { value: "10.00" },
    });
    fireEvent.click(screen.getByTestId("instrument-scpi-attributes-submit"));

    expect(await screen.findByTestId("instrument-detail-scpi-attributes-saved")).toHaveTextContent(
      "Caractéristiques enregistrées.",
    );
    expect(mockedApiClient.updateInstrumentScpiAttributes).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.updateInstrumentScpiAttributes.mock.calls[0]?.[0]).toEqual({
      instrumentId: INSTRUMENT_ID,
      subscriptionFeePct: "10.00",
    });
    await waitFor(() =>
      expect(mockedApiClient.fetchInstrument.mock.calls.length).toBeGreaterThan(readsBefore),
    );
  });

  it("emptying an attribute clears it: the PATCH sends null for that key only", async () => {
    mockedApiClient.updateInstrumentScpiAttributes.mockResolvedValue(
      scpiDetail({ managementCompany: null }),
    );
    await renderScpi(scpiDetail());
    await openEditDialog();

    fireEvent.change(screen.getByTestId("instrument-scpi-management-company-input"), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByTestId("instrument-scpi-attributes-submit"));

    await screen.findByTestId("instrument-detail-scpi-attributes-saved");
    expect(mockedApiClient.updateInstrumentScpiAttributes).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.updateInstrumentScpiAttributes.mock.calls[0]?.[0]).toEqual({
      instrumentId: INSTRUMENT_ID,
      managementCompany: null,
    });
  });
});
