import * as Tooltip from "@radix-ui/react-tooltip";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardKpiStrip } from "./DashboardKpiStrip.js";
import type { ValuedAmount } from "./Figure.js";
import type { HoldingResponse, HoldingsResponse, OverviewResponse } from "../lib/api-client.js";

/** UR-41, the dashboard's top summary. */

function valued(amount: string, currency = "EUR"): ValuedAmount {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function holding(id: string, costBasis: string): HoldingResponse {
  return {
    instrumentId: id,
    kind: "SHARE",
    displayName: `Titre ${id}`,
    symbol: null,
    sectorCode: null,
    domicileCountry: null,
    listingCountry: null,
    hasIcon: false,
    quantity: "1",
    currency: "EUR",
    pmp: valued("1"),
    costBasis: valued(costBasis),
    currentPrice: valued("1"),
    currentValue: valued("1"),
    unrealizedGainLoss: valued("0"),
    realizedGains: [],
  };
}

function holdings(rows: readonly HoldingResponse[]): HoldingsResponse {
  return {
    asOfDate: "2026-08-18",
    holdings: rows,
    totalValue: valued("1000"),
    totalUnrealizedGainLoss: valued("100"),
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "42",
    portfolioCount: 1,
  };
}

function overview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    from: "2026-01-01",
    to: "2026-08-18",
    totalValue: valued("1000"),
    unrealizedGainLoss: valued("100"),
    return: {
      twr: {
        available: true,
        cumulative: "0.10",
        annualised: null,
        rangeDays: 200,
        subPeriodCount: 3,
      },
      mwr: { converged: true, rate: "0.09", method: "newton", iterations: 4 },
    },
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "42",
    portfolioCount: 1,
    ...overrides,
  };
}

function renderStrip(node: React.ReactElement) {
  return render(<Tooltip.Provider>{node}</Tooltip.Provider>);
}

describe("<DashboardKpiStrip>", () => {
  it("shows the unrealized P&L percentage against the summed cost basis", () => {
    // 100 gain over 800 + 200 = 1000 cost basis = 10.00%.
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={holdings([holding("a", "800"), holding("b", "200")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-unrealized-percentage")).toHaveTextContent("10.00%");
  });

  it("shows — not 0 % and not ∞ when the summed cost basis is zero", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={holdings([holding("a", "0")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    const pct = screen.getByTestId("overview-unrealized-percentage");
    expect(pct).toHaveTextContent("—");
    expect(pct).not.toHaveTextContent("0.00%");
    expect(pct).not.toHaveTextContent("Infinity");
  });

  it("shows — while the holdings read is still in flight, rather than a wrong percentage", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-unrealized-percentage")).toHaveTextContent("—");
  });

  // Owner decision (option 1): the code picks one French line; the
  // English diagnostic is behind the hint, never the figure.
  it("renders an unavailable TWR/MWR as the French line its reasonCode maps to, the English reason behind a hint", () => {
    const twrReason = "TWR sub-period starting 2025-10-16 has an invested base of zero";
    const mwrReason = "NPV has the same sign at both ends of the search bracket";
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          return: {
            twr: { available: false, reasonCode: "ZERO_INVESTED_BASE", reason: twrReason },
            mwr: { converged: false, reasonCode: "NO_ROOT_IN_BRACKET", reason: mwrReason },
          },
        })}
        holdings={holdings([holding("a", "100")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    const twr = screen.getByTestId("overview-twr-unavailable");
    const mwr = screen.getByTestId("overview-mwr-unavailable");
    expect(twr).toHaveTextContent("Non calculable : aucun capital investi");
    expect(mwr).toHaveTextContent("Non calculable pour ces flux");
    expect(twr.textContent ?? "").not.toContain("invested base");
    expect(mwr.textContent ?? "").not.toContain("NPV");
    expect(within(twr).getByRole("button")).toHaveAccessibleName(
      expect.stringContaining(twrReason),
    );
    expect(within(mwr).getByRole("button")).toHaveAccessibleName(
      expect.stringContaining(mwrReason),
    );
  });

  it("reads « Indisponible » for a reason code this build does not know, never the raw reason", () => {
    const reason = "some-unrecognised-future-reason";
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          return: {
            twr: { available: false, reasonCode: "SOMETHING_NEW", reason },
            mwr: { converged: false, reason },
          },
        })}
        holdings={holdings([holding("a", "100")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-twr-unavailable")).toHaveTextContent(/^Indisponible$/);
    expect(screen.getByTestId("overview-mwr-unavailable")).toHaveTextContent(/^Indisponible$/);
  });

  it("states freshness as the fetch time only — no valuation version, no recalculation clock claim", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({ calcEpoch: "1234" })}
        holdings={holdings([holding("a", "100")])}
        dataUpdatedAt={new Date("2026-08-15T14:05:00.000Z").getTime()}
        periodPhrase="sur 1 an"
      />,
    );
    const freshness = screen.getByTestId("overview-freshness");
    // The line survives; what went (2026-09-08) is the epoch it used to lead
    // with — the response still carries `calcEpoch: "1234"` and no surface
    // renders it.
    expect(freshness).toHaveTextContent("Données récupérées à");
    expect(freshness.textContent ?? "").not.toContain("1234");
    expect(freshness.textContent ?? "").not.toContain("version");
    expect(freshness.textContent ?? "").not.toMatch(/recalculé à/i);
    // …and no glossary trigger is left behind on a term that no longer exists.
    expect(screen.queryByTestId("glossary-hint-calcEpoch")).not.toBeInTheDocument();
  });

  it("preserves every historical overview testid the existing e2e suite asserts", () => {
    // FR-126/AC118: those specs must keep passing unchanged. `overview-total-value`
    // alone is asserted 22 times across web/e2e.
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={holdings([holding("a", "100")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    for (const id of [
      "overview-total-value",
      "overview-unrealized-gain-loss",
      "overview-returns",
      "overview-twr",
      "overview-mwr",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("takes the delta chip's sign from the decimal amount, so a flat position is not green", () => {
    // Green is reserved for money coming in, and zero is not money
    // coming in. `deltaSign` now handles a formatted "0.00%" too (the kit fix
    // this screen's review produced, covered by `domain-visuals.test.tsx`);
    // this asserts the screen's own end of the contract — that a flat position
    // reaches the chip as "flat" — independently of which input form it uses.
    renderStrip(
      <DashboardKpiStrip
        overview={overview({ unrealizedGainLoss: valued("0") })}
        holdings={holdings([holding("a", "1000")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    const pct = screen.getByTestId("overview-unrealized-percentage");
    expect(pct).toHaveTextContent("0.00%");
    expect(pct.querySelector("[data-sign]")).toHaveAttribute("data-sign", "flat");
  });

  it("paints a negative unrealized P&L as a loss, never as apricot or a gain", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({ unrealizedGainLoss: valued("-100") })}
        holdings={holdings([holding("a", "1000")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(
      screen.getByTestId("overview-unrealized-percentage").querySelector("[data-sign]"),
    ).toHaveAttribute("data-sign", "loss");
  });

  it("renders the caller's chart in the hero's right column, and no Sharpe tile", () => {
    // The route owns the series read and hands the hero either the
    // chart or that read's own state; the strip never fetches.
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={holdings([holding("a", "100")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
        chart={<span data-testid="chart-stub">courbe</span>}
      />,
    );
    expect(screen.getByTestId("overview-hero-chart")).toContainElement(
      screen.getByTestId("chart-stub"),
    );
    expect(screen.getByTestId("dashboard-kpi-strip").textContent ?? "").not.toMatch(/sharpe/i);
  });

  it("keeps the hero to one column when no chart is handed in", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.queryByTestId("overview-hero-chart")).not.toBeInTheDocument();
  });

  it("AC-580: states the cash inside the total as « Liquidités », with its value", () => {
    // AC-577's H: 975.00 of cash in a 1175.00 total.
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          totalValue: valued("1175.00"),
          cash: {
            totalBase: "975.00",
            currency: "EUR",
            isNegative: false,
            unconverted: [],
            byCurrency: [],
          },
        })}
        holdings={holdings([holding("a", "100")])}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-total-value")).toHaveTextContent("1 175.00 EUR");
    expect(screen.getByTestId("overview-cash")).toHaveTextContent("Liquidités");
    expect(screen.getByTestId("overview-cash-value")).toHaveTextContent("975.00 EUR");
    expect(screen.queryByTestId("overview-cash-unconverted")).not.toBeInTheDocument();
  });

  it("names a currency the server could not convert beside the figure, and shows no line for zero cash", () => {
    const { unmount } = renderStrip(
      <DashboardKpiStrip
        overview={overview({
          cash: {
            totalBase: "80.00",
            currency: "EUR",
            isNegative: false,
            unconverted: ["USD"],
            byCurrency: [],
          },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-cash-unconverted")).toHaveTextContent(
      "taux indisponible : USD",
    );
    unmount();
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.queryByTestId("overview-cash")).not.toBeInTheDocument();
  });
});

describe("DashboardKpiStrip — the day-change tile (FR-263)", () => {
  it("renders the figure when the overview carries one", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          dayChange: {
            amount: "123.45",
            currency: "EUR",
            provenance: { derivedFrom: ["AUTOMATED"] },
          },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-day-change-value")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-day-change-unavailable")).not.toBeInTheDocument();
  });

  it("renders the honest unavailable state — never 0 — when the field is absent", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview()}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-day-change-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-day-change-value")).not.toBeInTheDocument();
  });
});

describe("DashboardKpiStrip — the tiles say what their figures mean (overview usability review, 2026-09-15)", () => {
  it("colours a negative day change as a loss and states it as a percentage of the previous close", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          totalValue: valued("1100"),
          dayChange: {
            amount: "-100",
            currency: "EUR",
            provenance: { derivedFrom: ["AUTOMATED"] },
          },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-day-change-value")).toHaveClass("ov-tile-loss");
    // −100 on a total of 1100: yesterday's close was 1200, so −8.33 %.
    const percentage = screen.getByTestId("overview-day-change-percentage");
    expect(percentage).toHaveTextContent("−8.33%");
    expect(percentage.querySelector("[data-sign]")).toHaveAttribute("data-sign", "loss");
  });

  it("shows no percentage chip when the day change is absent or its previous close is zero", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          totalValue: valued("100"),
          dayChange: { amount: "100", currency: "EUR", provenance: { derivedFrom: ["AUTOMATED"] } },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-day-change-value")).toHaveClass("ov-tile-gain");
    expect(screen.queryByTestId("overview-day-change-percentage")).not.toBeInTheDocument();
  });

  it("tints TWR and MWR by their sign and states the window under each", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          return: {
            twr: {
              available: true,
              cumulative: "-0.05",
              annualised: null,
              rangeDays: 90,
              subPeriodCount: 1,
            },
            mwr: { converged: true, rate: "0.02", method: "newton", iterations: 2 },
          },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 3 mois"
      />,
    );
    expect(screen.getByTestId("overview-twr")).toHaveClass("ov-tile-loss");
    expect(screen.getByTestId("overview-mwr")).toHaveClass("ov-tile-gain");
    expect(screen.getAllByText("sur 3 mois")).toHaveLength(2);
  });

  it("leaves a flat return in ink — zero is never green", () => {
    renderStrip(
      <DashboardKpiStrip
        overview={overview({
          return: {
            twr: {
              available: true,
              cumulative: "0",
              annualised: null,
              rangeDays: 90,
              subPeriodCount: 1,
            },
            mwr: { converged: true, rate: "0.00", method: "newton", iterations: 2 },
          },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    expect(screen.getByTestId("overview-twr")).toHaveClass("ov-tile-flat");
    expect(screen.getByTestId("overview-mwr")).toHaveClass("ov-tile-flat");
  });

  it("puts every figure in the hero — day change, TWR and MWR — and renders no tile row (owner, 2026-09-24)", () => {
    const { container } = renderStrip(
      <DashboardKpiStrip
        overview={overview({
          dayChange: { amount: "5", currency: "EUR", provenance: { derivedFrom: ["AUTOMATED"] } },
        })}
        holdings={undefined}
        dataUpdatedAt={undefined}
        periodPhrase="sur 1 an"
      />,
    );
    const hero = screen.getByTestId("overview-hero");
    expect(hero).toContainElement(screen.getByTestId("overview-day-change"));
    expect(hero).toContainElement(screen.getByTestId("overview-returns"));
    expect(hero).toContainElement(screen.getByTestId("overview-returns-mwr"));
    expect(container.querySelector(".ov-tiles")).toBeNull();
    expect(container.querySelector(".k-stat")).toBeNull();
    // No invested-capital tile: that figure is the chart's detail line.
    expect(screen.queryByTestId("overview-invested")).not.toBeInTheDocument();
    expect(screen.getByTestId("dashboard-kpi-strip").textContent ?? "").not.toMatch(
      /capital investi/i,
    );
  });
});
