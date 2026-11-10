import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseDecimalString } from "@kerdial/core-decimal";
import type { DividendPeriodBucket } from "../lib/api-client.js";
import {
  DividendCalendar,
  effectiveSelection,
  fillMonthGaps,
  heatStep,
} from "./DividendCalendar.js";

/**
 * `DividendCalendar`.
 *
 * The fixture has four non-empty months across 2019, 2020 and 2024, so
 * the span holds a hole inside a year (2019-02), three whole empty years
 * (2021–2023) and a tail outside the window (2024-07 → 12).
 */
const MONTHS: readonly DividendPeriodBucket[] = [
  { period: "2019-01", grossBase: "10", withholdingBase: "0" },
  { period: "2019-03", grossBase: "15.5", withholdingBase: "0" },
  { period: "2020-02", grossBase: "7.25", withholdingBase: "0" },
  { period: "2024-06", grossBase: "159.84", withholdingBase: "13.851" },
];
const YEARS: readonly DividendPeriodBucket[] = [
  { period: "2019", grossBase: "25.5", withholdingBase: "0" },
  { period: "2020", grossBase: "7.25", withholdingBase: "0" },
  { period: "2024", grossBase: "159.84", withholdingBase: "13.851" },
];

function cell(period: string): HTMLElement {
  const node = document.querySelector(
    `[data-testid="dividend-calendar-cell"][data-period="${period}"]`,
  );
  if (!(node instanceof HTMLElement)) throw new Error(`no cell for ${period}`);
  return node;
}

describe("fillMonthGaps — the zero-fill, provable without rendering (AC-289)", () => {
  it("puts a zero entry where 2019-02 is missing, never merging it into a neighbour", () => {
    const filled = fillMonthGaps(MONTHS.slice(0, 2));
    expect(filled.map((bucket) => bucket.period)).toEqual(["2019-01", "2019-02", "2019-03"]);
    expect(filled[1]).toEqual({ period: "2019-02", grossBase: "0", withholdingBase: "0" });
  });

  it("crosses year boundaries with zero-padded months, so lexical order stays chronological", () => {
    const filled = fillMonthGaps([MONTHS[2]!, MONTHS[3]!]);
    expect(filled).toHaveLength(53); // 2020-02 → 2024-06 inclusive
    expect(filled[0]?.period).toBe("2020-02");
    expect(filled[11]?.period).toBe("2021-01");
    expect(filled.at(-1)?.period).toBe("2024-06");
    expect(
      filled.every((bucket, index, all) => index === 0 || all[index - 1]!.period < bucket.period),
    ).toBe(true);
  });

  it("fills inside the data's own span only, and answers [] for no data at all", () => {
    expect(fillMonthGaps([])).toEqual([]);
    expect(fillMonthGaps([MONTHS[0]!])).toEqual([MONTHS[0]]);
  });
});

describe("heatStep — five bands in Decimal, the maximum darkest, nothing present at zero", () => {
  const max = parseDecimalString("100");
  it.each([
    ["0.01", "1"],
    ["20", "1"],
    ["20.01", "2"],
    ["40", "2"],
    ["60", "3"],
    ["80", "4"],
    ["80.01", "5"],
    ["100", "5"],
  ])("gross %s of max 100 is band %s", (gross, band) => {
    expect(heatStep(parseDecimalString(gross), max)).toBe(band);
  });

  it("gives a present-but-zero bucket band 1, and an all-zero window band 1 rather than dividing by zero", () => {
    expect(heatStep(parseDecimalString("0"), max)).toBe("1");
    expect(heatStep(parseDecimalString("0"), parseDecimalString("0"))).toBe("1");
  });
});

describe("<DividendCalendar> — the chart is the table", () => {
  it("renders one row per year of the span, twelve month columns and a total column, as real table semantics", () => {
    render(<DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />);

    const table = screen.getByTestId("dividend-calendar-table");
    expect(table.tagName).toBe("TABLE");
    expect(within(table).getByText("Dividendes bruts par année et par mois").tagName).toBe(
      "CAPTION",
    );
    // Year head + twelve months + total.
    expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(14);
    expect(
      screen.getAllByTestId("dividend-calendar-year").map((row) => row.getAttribute("data-year")),
    ).toEqual(["2019", "2020", "2021", "2022", "2023", "2024"]);
    expect(table.querySelectorAll('tbody th[scope="row"]')).toHaveLength(6);
    expect(table.querySelector("svg")).toBeNull();
  });

  it("draws 72 cells: four with a figure, the in-span empties as inert announced cells, the post-window tail as outside", () => {
    render(<DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />);

    const cells = screen.getAllByTestId("dividend-calendar-cell");
    expect(cells).toHaveLength(72);
    expect(cells.filter((node) => node.tagName === "BUTTON")).toHaveLength(4);
    expect(cells.filter((node) => node.getAttribute("data-outside") === "true")).toHaveLength(6);
    // 2019-02 is a hole inside the span: present as a cell, empty, and it says so.
    expect(cell("2019-02").tagName).toBe("SPAN");
    expect(cell("2019-02")).toHaveAttribute("data-heat", "0");
    expect(cell("2019-02")).toHaveTextContent("aucun versement");
    // 2024-07 is after the window's last payment: drawn, but not a month to announce.
    expect(cell("2024-07")).toHaveAttribute("aria-hidden", "true");
  });

  it("tones the maximum month 5 and the small ones 1, with 0 reserved for the absent (AC-CAL-3)", () => {
    render(<DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />);

    expect(cell("2024-06")).toHaveAttribute("data-heat", "5");
    expect(cell("2019-01")).toHaveAttribute("data-heat", "1");
    expect(cell("2019-03")).toHaveAttribute("data-heat", "1");
    expect(cell("2020-02")).toHaveAttribute("data-heat", "1");
    for (const node of screen.getAllByTestId("dividend-calendar-cell")) {
      if (node.tagName === "BUTTON") expect(node.getAttribute("data-heat")).not.toBe("0");
      else expect(node).toHaveAttribute("data-heat", "0");
    }
  });

  it("ends each year row with years[]'s own figure — and a gap year with the absent mark, never a zero it invented (AC-CAL-2)", () => {
    render(<DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />);

    const totals = new Map(
      screen
        .getAllByTestId("dividend-calendar-year-total")
        .map((node) => [node.getAttribute("data-year"), node.textContent ?? ""]),
    );
    expect(totals.get("2019")).toBe("25.50");
    expect(totals.get("2020")).toBe("7.25");
    expect(totals.get("2024")).toBe("159.84");
    expect(totals.get("2022")).toBe("—");
  });

  it("opens the detail line on the latest month; hover previews another month and leaving the table puts it back — two figures, never their difference (AC-CAL-4, LD-1)", () => {
    render(<DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />);

    const detail = screen.getByTestId("dividend-calendar-detail");
    expect(detail).toHaveAttribute("aria-live", "polite");
    expect(detail).toHaveTextContent("Juin 2024");
    expect(screen.getByTestId("dividend-calendar-detail-gross")).toHaveTextContent("159.84 EUR");
    expect(screen.getByTestId("dividend-calendar-detail-withholding")).toHaveTextContent(
      "13.85 EUR",
    );
    // 159.84 − 13.851 = 145.989: nowhere.
    expect(detail.textContent ?? "").not.toContain("145.9");
    expect(cell("2024-06")).toHaveAttribute("data-active", "true");
    expect(cell("2024-06")).toHaveAttribute("data-selected", "true");

    fireEvent.mouseEnter(cell("2019-01"));
    expect(detail).toHaveTextContent("Janvier 2019");
    expect(screen.getByTestId("dividend-calendar-detail-gross")).toHaveTextContent("10.00 EUR");
    expect(cell("2019-01")).toHaveAttribute("data-active", "true");
    expect(cell("2024-06")).not.toHaveAttribute("data-active");
    // A preview, not a selection: the ring stays on June.
    expect(cell("2019-01")).not.toHaveAttribute("data-selected");
    expect(cell("2024-06")).toHaveAttribute("data-selected", "true");

    fireEvent.mouseLeave(screen.getByTestId("dividend-calendar-table"));
    expect(detail).toHaveTextContent("Juin 2024");
    expect(cell("2024-06")).toHaveAttribute("data-active", "true");
  });

  it("selects on click and on focus — the ring moves, onSelect fires, and the detail line settles on the selection", () => {
    const onSelect = vi.fn();
    render(
      <DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" onSelect={onSelect}>
        <p data-testid="calendar-child">liste</p>
      </DividendCalendar>,
    );

    fireEvent.click(cell("2019-03"));
    expect(onSelect).toHaveBeenLastCalledWith("2019-03");
    expect(cell("2019-03")).toHaveAttribute("data-selected", "true");
    expect(cell("2019-03")).toHaveAttribute("aria-pressed", "true");
    expect(cell("2024-06")).not.toHaveAttribute("data-selected");
    expect(screen.getByTestId("dividend-calendar-detail")).toHaveTextContent("Mars 2019");

    fireEvent.focus(cell("2020-02"));
    expect(onSelect).toHaveBeenLastCalledWith("2020-02");
    expect(cell("2020-02")).toHaveAttribute("data-selected", "true");
    expect(onSelect).toHaveBeenCalledTimes(2);

    // Hovering never selects: no third call.
    fireEvent.mouseEnter(cell("2019-01"));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(cell("2020-02")).toHaveAttribute("data-selected", "true");

    // The parent's list slot renders inside the card, under the foot.
    expect(screen.getByTestId("dividend-calendar")).toContainElement(
      screen.getByTestId("calendar-child"),
    );
  });

  it("honours a controlled selection, and falls back to the latest month when the pick is not on this grid", () => {
    const { rerender } = render(
      <DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" selected="2019-01" />,
    );
    expect(cell("2019-01")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("dividend-calendar-detail")).toHaveTextContent("Janvier 2019");

    rerender(
      <DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" selected="2031-01" />,
    );
    expect(cell("2024-06")).toHaveAttribute("data-selected", "true");
    expect(effectiveSelection(MONTHS, "2031-01")).toBe("2024-06");
    expect(effectiveSelection(MONTHS, "2019-03")).toBe("2019-03");
    expect(effectiveSelection([], undefined)).toBeUndefined();
  });

  it("names every figure cell for assistive technology, and never puts a tooltip widget in the DOM", () => {
    render(<DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />);

    expect(cell("2019-01")).toHaveAttribute("aria-label", "Janvier 2019 : 10.00");
    expect(cell("2024-06")).toHaveAttribute("aria-label", "Juin 2024 : 159.84");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    // The month headers: a letter for the eye, the name for the ear.
    const table = screen.getByTestId("dividend-calendar-table");
    expect(within(table).getByText("janvier")).toHaveClass("k-visually-hidden");
    expect(within(table).getAllByText("J", { selector: '[aria-hidden="true"]' })).toHaveLength(3);
  });

  it("follows the window: a new months[] moves the rest line to the new latest month instead of a stale pick", () => {
    const { rerender } = render(
      <DividendCalendar years={YEARS} months={MONTHS} baseCurrency="EUR" />,
    );
    fireEvent.mouseEnter(cell("2019-01"));
    expect(screen.getByTestId("dividend-calendar-detail")).toHaveTextContent("Janvier 2019");

    rerender(<DividendCalendar years={[YEARS[1]!]} months={[MONTHS[2]!]} baseCurrency="EUR" />);
    expect(screen.getByTestId("dividend-calendar-detail")).toHaveTextContent("Février 2020");
    expect(screen.getAllByTestId("dividend-calendar-year")).toHaveLength(1);
  });

  it("renders an all-zero month as present (band 1) and an empty window as an empty grid, without dividing by zero", () => {
    const { rerender } = render(
      <DividendCalendar
        years={[{ period: "2024", grossBase: "0", withholdingBase: "5" }]}
        months={[{ period: "2024-06", grossBase: "0", withholdingBase: "5" }]}
        baseCurrency="EUR"
      />,
    );
    expect(cell("2024-06")).toHaveAttribute("data-heat", "1");
    expect(cell("2024-06").tagName).toBe("BUTTON");

    rerender(<DividendCalendar years={[]} months={[]} baseCurrency="EUR" />);
    expect(screen.queryAllByTestId("dividend-calendar-year")).toHaveLength(0);
    expect(screen.getByTestId("dividend-calendar-detail").textContent).toBe("");
  });
});
