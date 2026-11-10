import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeriodSelector } from "./PeriodSelector.js";
import {
  CUSTOM_RANGE_ID,
  PERIOD_PRESETS,
  WATCHLIST_PERIOD_PRESETS,
} from "../lib/period-presets.js";

const INERT = { onOpen: () => {}, onChange: () => {} };

/**
 * The control's two new behaviours: the custom option is opt-in, and an
 * invalid window is refused here rather than by the server.
 */
describe("PeriodSelector", () => {
  it("offers no custom option unless the caller passes one — Suivi is unchanged", () => {
    render(
      (
        <PeriodSelector selected="1Y" onSelect={() => {}} presets={WATCHLIST_PERIOD_PRESETS} />
      ) as ReactElement,
    );
    expect(screen.queryByTestId(`period-option-${CUSTOM_RANGE_ID}`)).toBeNull();
    expect(screen.queryByTestId("period-custom")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(WATCHLIST_PERIOD_PRESETS.length);
  });

  it("adds the custom option after the presets when the caller opts in", () => {
    render((<PeriodSelector selected="1Y" onSelect={() => {}} custom={INERT} />) as ReactElement);
    expect(screen.getAllByRole("button")).toHaveLength(PERIOD_PRESETS.length + 1);
    expect(screen.getByTestId(`period-option-${CUSTOM_RANGE_ID}`)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Not selected: no date fields, so the header does not grow for a window
    // nobody asked for.
    expect(screen.queryByTestId("period-custom")).toBeNull();
  });

  it("clicking «Perso.» calls onOpen and selects nothing itself", () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(
      (
        <PeriodSelector selected="MAX" onSelect={onSelect} custom={{ ...INERT, onOpen }} />
      ) as ReactElement,
    );
    fireEvent.click(screen.getByTestId(`period-option-${CUSTOM_RANGE_ID}`));
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The route writes the window; this control never resolves CUSTOM itself,
    // so `onSelect` — which would drop both bounds — must not fire.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reveals the two bounds, prefilled, when CUSTOM is the selected id", () => {
    render(
      (
        <PeriodSelector
          selected={CUSTOM_RANGE_ID}
          onSelect={() => {}}
          custom={{ ...INERT, from: "2019-11-08", to: "2020-02-14" }}
        />
      ) as ReactElement,
    );
    expect(screen.getByTestId(`period-option-${CUSTOM_RANGE_ID}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("period-custom-from")).toHaveValue("2019-11-08");
    expect(screen.getByTestId("period-custom-to")).toHaveValue("2020-02-14");
  });

  it("sends both bounds on every edit, so one coherent window is written", () => {
    const onChange = vi.fn();
    render(
      (
        <PeriodSelector
          selected={CUSTOM_RANGE_ID}
          onSelect={() => {}}
          custom={{ ...INERT, onChange, from: "2019-11-08", to: "2020-02-14" }}
        />
      ) as ReactElement,
    );
    fireEvent.change(screen.getByTestId("period-custom-to"), { target: { value: "2021-06-18" } });
    expect(onChange).toHaveBeenCalledWith({ from: "2019-11-08", to: "2021-06-18" });
  });

  it("states a reversed window on the field the reader must move", () => {
    render(
      (
        <PeriodSelector
          selected={CUSTOM_RANGE_ID}
          onSelect={() => {}}
          custom={{ ...INERT, from: "2026-01-01", to: "2025-01-01" }}
        />
      ) as ReactElement,
    );
    expect(screen.getByText("La date de début doit précéder la date de fin.")).toBeInTheDocument();
  });

  it("says nothing while a bound is still empty", () => {
    render(
      (
        <PeriodSelector
          selected={CUSTOM_RANGE_ID}
          onSelect={() => {}}
          custom={{ ...INERT, from: "2026-01-01" }}
        />
      ) as ReactElement,
    );
    expect(screen.getByTestId("period-custom-to")).toHaveValue("");
    // `incomplete` has no message at all — nothing on screen carries the
    // error class, and neither field is marked invalid.
    expect(document.querySelector(".k-field-error")).toBeNull();
    expect(document.querySelector(".k-input-shell-error")).toBeNull();
  });
});
