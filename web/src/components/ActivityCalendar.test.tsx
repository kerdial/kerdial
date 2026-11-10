import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TransactionCalendar } from "../lib/api-client.js";
import { THOUSANDS_SEPARATOR } from "../lib/figure-format.js";
import { ActivityCalendar, formatCount, monthBounds } from "./ActivityCalendar.js";

/**
 * `ActivityCalendar`. The grid's own mechanics (gap fill,
 * heat bands, preview vs. selection) are `DividendCalendar.test.tsx`'s subject
 * through the shared `HeatCalendar`; this file pins what makes this one the
 * *activity* calendar: which figure tones the cells under each measure, that
 * the detail line always carries both, and the hand-off into the ledger.
 *
 * Three months: January is the busiest by count (4 small trades), March the
 * largest by volume (one 5 000 trade), so the two measures rank them the
 * other way round — a fixture that would pass under either measure proves
 * nothing about the toggle.
 */
const CALENDAR: TransactionCalendar = {
  baseCurrency: "EUR",
  total: { count: 6, volumeBase: "5620" },
  years: [
    { period: "2025", count: 5, volumeBase: "5400" },
    { period: "2026", count: 1, volumeBase: "220" },
  ],
  months: [
    { period: "2025-01", count: 4, volumeBase: "400" },
    { period: "2025-03", count: 1, volumeBase: "5000" },
    { period: "2026-02", count: 1, volumeBase: "220" },
  ],
};

function cell(period: string): HTMLElement {
  const node = document.querySelector(
    `[data-testid="activity-calendar-cell"][data-period="${period}"]`,
  );
  if (!(node instanceof HTMLElement)) throw new Error(`no cell for ${period}`);
  return node;
}

function renderCalendar(measure: "count" | "volume" = "count") {
  const onMeasureChange = vi.fn();
  const onOpenMonth = vi.fn();
  render(
    <ActivityCalendar
      calendar={CALENDAR}
      measure={measure}
      onMeasureChange={onMeasureChange}
      onOpenMonth={onOpenMonth}
    />,
  );
  return { onMeasureChange, onOpenMonth };
}

describe("monthBounds — a month's first and last day, leap years included, no Number()", () => {
  it.each([
    ["2024-02", "2024-02-01", "2024-02-29"],
    ["2025-02", "2025-02-01", "2025-02-28"],
    ["2025-12", "2025-12-01", "2025-12-31"],
    ["2026-04", "2026-04-01", "2026-04-30"],
  ])("%s spans %s → %s", (period, from, to) => {
    expect(monthBounds(period)).toEqual({ from, to });
  });
});

describe("formatCount — the app's own thousands separator", () => {
  it("groups with the narrow no-break space the figures use, and leaves a small count alone", () => {
    expect(formatCount(1234)).toBe(`1${THOUSANDS_SEPARATOR}234`);
    expect(formatCount(42)).toBe("42");
  });
});

describe("<ActivityCalendar> — the measure chooses the tone, not the information", () => {
  it("tones by count by default: January (4 trades) is the darkest, March (one big trade) the lightest", () => {
    renderCalendar("count");
    expect(cell("2025-01")).toHaveAttribute("data-heat", "5");
    expect(cell("2025-03")).toHaveAttribute("data-heat", "2");
    expect(cell("2025-01")).toHaveAttribute("aria-label", "Janvier 2025 : 4 transactions");
    expect(screen.getByTestId("activity-calendar-unit")).toHaveTextContent("transactions");
    // The year column carries years[]'s own count.
    const totals = new Map(
      screen
        .getAllByTestId("activity-calendar-year-total")
        .map((node) => [node.getAttribute("data-year"), node.textContent ?? ""]),
    );
    expect(totals.get("2025")).toBe("5");
    expect(totals.get("2026")).toBe("1");
  });

  it("tones by volume when asked: the ranking flips, the unit names the base currency, the year column is the year's volume", () => {
    renderCalendar("volume");
    expect(cell("2025-03")).toHaveAttribute("data-heat", "5");
    expect(cell("2025-01")).toHaveAttribute("data-heat", "1");
    expect(cell("2025-03").getAttribute("aria-label")).toMatch(/^Mars 2025 : 5.000\.00 EUR$/);
    expect(screen.getByTestId("activity-calendar-unit")).toHaveTextContent("volume · EUR");
    const total2025 = screen
      .getAllByTestId("activity-calendar-year-total")
      .find((node) => node.getAttribute("data-year") === "2025");
    expect(total2025?.textContent).toMatch(/^5.400\.00$/);
  });

  it("the toggle reports the other measure to the parent and never flips itself", () => {
    const { onMeasureChange } = renderCalendar("count");
    fireEvent.click(screen.getByRole("radio", { name: "Montant" }));
    expect(onMeasureChange).toHaveBeenCalledWith("volume");
    // Controlled: the tone is still the count's until the parent re-renders.
    expect(cell("2025-01")).toHaveAttribute("data-heat", "5");
  });

  it("the detail line opens on the latest month with BOTH figures, previews on hover, and hands the month's bounds to the ledger", () => {
    const { onOpenMonth } = renderCalendar("count");
    const detail = screen.getByTestId("activity-calendar-detail");
    expect(detail).toHaveTextContent("Février 2026");
    expect(screen.getByTestId("activity-calendar-detail-count")).toHaveTextContent("1 transaction");
    expect(screen.getByTestId("activity-calendar-detail-volume")).toHaveTextContent("220.00 EUR");

    fireEvent.mouseEnter(cell("2025-01"));
    expect(detail).toHaveTextContent("Janvier 2025");
    expect(screen.getByTestId("activity-calendar-detail-count")).toHaveTextContent(
      "4 transactions",
    );
    expect(screen.getByTestId("activity-calendar-detail-volume")).toHaveTextContent("400.00 EUR");

    fireEvent.click(screen.getByTestId("activity-calendar-open-month"));
    expect(onOpenMonth).toHaveBeenCalledWith({ from: "2025-01-01", to: "2025-01-31" });
  });

  it("draws the gap months empty and announced, with the activity vocabulary", () => {
    renderCalendar();
    expect(cell("2025-02").tagName).toBe("SPAN");
    expect(cell("2025-02")).toHaveAttribute("data-heat", "0");
    expect(cell("2025-02")).toHaveTextContent("aucune transaction");
    expect(screen.getByTestId("activity-calendar-table").tagName).toBe("TABLE");
  });
});
