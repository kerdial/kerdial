import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toValuePointSeries } from "../lib/chart-series.js";
import { OVERVIEW_COPY } from "../lib/copy/overview.js";
import { PortfolioValueChart } from "./PortfolioValueChart.js";

/**
 * `PortfolioValueChart` — the hero's value-vs-invested chart. What is
 * pinned: both lines come from the same `Decimal` geometry the Performance
 * chart uses (`buildInvestedCapitalGeometry`), every stated figure renders
 * through `<Figure>` from the point's original decimal string, the detail
 * line names the gain (value − capital investi net) with its sign, and the
 * pointer moves the marker along the x axis.
 */

const POINTS = [
  { date: "2026-01-01", value: "800.00", netContributions: "800.00" },
  { date: "2026-01-02", value: "900.00", netContributions: "800.00" },
  { date: "2026-01-03", value: "1000.00", netContributions: "800.00" },
];

function renderChart(points = POINTS) {
  const value = toValuePointSeries(points).points;
  const contributions = toValuePointSeries(
    points.map((p) => ({ date: p.date, value: p.netContributions })),
  ).points;
  return render(
    <Tooltip.Provider>
      <PortfolioValueChart
        value={value}
        contributions={contributions}
        currency="EUR"
        periodText="01/01/2026 → 03/01/2026"
      />
    </Tooltip.Provider>,
  );
}

describe("<PortfolioValueChart>", () => {
  it("draws the value line, the dashed contributions line and the area under the value, from one geometry", () => {
    renderChart();
    const svg = screen.getByTestId("overview-value-svg");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", expect.stringContaining("3"));
    const value = screen.getByTestId("overview-value-line");
    const contributions = screen.getByTestId("overview-contributions-line");
    expect(contributions).toHaveAttribute("stroke-dasharray");
    expect(value).not.toHaveAttribute("stroke-dasharray");
    expect(value).toHaveAttribute("data-trend", "gain");
    // The area closes on the plot floor under the same points as the line.
    const area = screen.getByTestId("overview-value-area");
    expect(area.getAttribute("points")).toContain(value.getAttribute("points") ?? "∅");
    // The owner's axis (2026-09-24): the data's own range, not zero-based —
    // 800…1000 padded 4 % is 792…1008, so the ticks are 800, 850 … 1 000 and
    // no tick says 0.
    const ticks = screen.getAllByTestId("overview-value-tick").map((t) => t.textContent);
    expect(ticks).toEqual(["800", "850", "900", "950", "1\u202f000"]);
    expect(ticks).not.toContain("0");
  });

  it("states the last point by default — date, valeur, capital investi net and the signed gain — every figure from the decimal string", () => {
    renderChart();
    const detail = screen.getByTestId("overview-value-detail");
    expect(detail).toHaveTextContent("Au 03/01/2026");
    expect(screen.getByTestId("overview-value-detail-value")).toHaveTextContent("1 000.00 EUR");
    expect(screen.getByTestId("overview-value-detail-contributions")).toHaveTextContent(
      "800.00 EUR",
    );
    const gain = screen.getByTestId("overview-value-detail-gain");
    expect(gain).toHaveTextContent("200.00 EUR");
    expect(gain).toHaveAttribute("data-sign", "gain");
    expect(detail).toHaveTextContent(OVERVIEW_COPY.valueChartGain);
    // The period is stated once, in the chart head, where the range used to sit.
    expect(screen.getByTestId("overview-period-range")).toHaveTextContent(
      "01/01/2026 → 03/01/2026",
    );
  });

  it("moves the marker with the pointer and puts the count back on leave", () => {
    renderChart();
    const svg = screen.getByTestId("overview-value-svg");
    // jsdom has no layout; give the plot a width so the x → index step has something to divide by.
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 200, right: 1000, bottom: 200 }) as DOMRect;
    fireEvent.mouseMove(svg, { clientX: 0 });
    expect(screen.getByTestId("overview-value-detail")).toHaveTextContent("Au 01/01/2026");
    expect(screen.getByTestId("overview-value-detail-gain")).toHaveTextContent("0.00 EUR");
    expect(screen.getByTestId("overview-value-detail-gain")).toHaveAttribute("data-sign", "flat");
    fireEvent.mouseLeave(svg);
    expect(screen.getByTestId("overview-value-detail")).toHaveTextContent("Au 03/01/2026");
  });

  it("colours a falling value line as a loss and the gain as a loss when below the money put in", () => {
    renderChart([
      { date: "2026-01-01", value: "1000.00", netContributions: "1000.00" },
      { date: "2026-01-02", value: "900.00", netContributions: "1000.00" },
    ]);
    expect(screen.getByTestId("overview-value-line")).toHaveAttribute("data-trend", "loss");
    expect(screen.getByTestId("overview-value-detail-gain")).toHaveAttribute("data-sign", "loss");
    expect(screen.getByTestId("overview-value-detail-gain")).toHaveTextContent("−100.00 EUR");
  });

  it("renders nothing for an empty series — the caller states the absence", () => {
    const { container } = renderChart([]);
    expect(container.querySelector("svg")).toBeNull();
  });
});
