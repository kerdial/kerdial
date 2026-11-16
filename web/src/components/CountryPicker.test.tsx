import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CountryPicker } from "./CountryPicker.js";

/**
 * `CountryPicker` in jsdom (FR-737, AC-635/636, the jsdom-visible halves of
 * AC-637/638). Real keyboard focus, Escape inside a Radix dialog, hit-testing
 * and the phone layout belong to `web/e2e/country-picker.spec.ts`.
 */

/** Controlled like a real caller: `onChange` is spied and also drives the value. */
function renderPicker(
  initial: string | null,
  excludedCodes?: ReadonlySet<string>,
): { onChange: ReturnType<typeof vi.fn>; input: HTMLElement } {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <CountryPicker
        label="Pays"
        value={value}
        excludedCodes={excludedCodes}
        testId="country"
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render((<Harness />) as ReactElement);
  return { onChange, input: screen.getByRole("combobox", { name: "Pays" }) };
}

function optionNames(): string[] {
  return screen.queryAllByRole("option").map((option) => option.textContent ?? "");
}

describe("<CountryPicker> — commits only list members (AC-636)", () => {
  it("« Atlantis » then Enter commits nothing and keeps the previous value", () => {
    const { onChange, input } = renderPicker("FR");
    fireEvent.change(input, { target: { value: "Atlantis" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("France");
  });

  it("« Jap » then blur restores the previous value rather than keeping the text", () => {
    const { onChange, input } = renderPicker("FR");
    fireEvent.change(input, { target: { value: "Jap" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("France");
  });

  it("choosing « Japon » stores JP and displays « Japon », never JP", () => {
    const { onChange, input } = renderPicker(null);
    fireEvent.change(input, { target: { value: "japon" } });
    fireEvent.click(screen.getByRole("option", { name: "Japon" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("JP");
    expect(input).toHaveValue("Japon");
  });

  it("an out-of-list XK shows raw, is not an option, and survives open/close untouched", () => {
    const { onChange, input } = renderPicker("XK");
    expect(input).toHaveValue("XK");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(document.querySelector('[data-code="XK"]')).toBeNull();
    fireEvent.blur(input);

    expect(input).toHaveValue("XK");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("<CountryPicker> — options and clearing (FR-737)", () => {
  it("does not offer a code already chosen elsewhere", () => {
    const { input } = renderPicker(null, new Set(["FR"]));
    fireEvent.change(input, { target: { value: "fran" } });

    expect(optionNames()).not.toContain("France");
  });

  it("« Effacer » calls onChange(null) and empties the field", () => {
    const { onChange, input } = renderPicker("FR");
    fireEvent.click(screen.getByRole("button", { name: "Effacer" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(input).toHaveValue("");
  });
});

describe("<CountryPicker> — keyboard and ARIA (AC-637/638, jsdom halves)", () => {
  it("arrows, Home and End move the active option; aria-activedescendant follows it", () => {
    const { input } = renderPicker(null);
    fireEvent.change(input, { target: { value: "ja" } });
    expect(input).not.toHaveAttribute("aria-activedescendant");

    const active = (): string | null | undefined => {
      const id = input.getAttribute("aria-activedescendant");
      return id === null ? null : document.getElementById(id)?.textContent;
    };
    const names = optionNames();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(names[0]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe(names[1]);
    fireEvent.keyDown(input, { key: "End" });
    expect(active()).toBe(names[names.length - 1]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active()).toBe(names[names.length - 2]);
    fireEvent.keyDown(input, { key: "Home" });
    expect(active()).toBe(names[0]);
    expect(screen.getByRole("option", { selected: true }).textContent).toBe(names[0]);
  });

  it("exposes the combobox pattern and announces the count and the empty state", () => {
    const { input } = renderPicker(null);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-autocomplete", "list");

    fireEvent.change(input, { target: { value: "japon" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(screen.getByRole("status")).toHaveTextContent("1 résultat");

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Aucun pays ne correspond");
    expect(screen.getByTestId("country-empty")).toHaveTextContent("Aucun pays ne correspond");
  });
});
