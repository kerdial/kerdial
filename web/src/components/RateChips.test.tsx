import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { RATE_PRESET_DEFAULTS, type RatePreset } from "@kerdial/api-contracts";
import { parseDecimalString } from "@kerdial/core-decimal";
import type { ChipAvailability } from "../lib/rate-preset-math.js";
import { RateChips } from "./RateChips.js";

/**
 * `RateChips` in isolation (`transaction-dialog-refresh` TDR-T9,
 * C-13; TDR-L18). The form wiring — typing clears the mark, a base change
 * clears it, the amounts in the body — is `TransactionForm.test.tsx`'s.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, saveRatePresets: vi.fn() };
});

function brokerage(count: number): RatePreset[] {
  return Array.from({ length: count }, (_, index) => ({
    rubrique: "BROKERAGE" as const,
    label: `Courtier ${index + 1}`,
    rate: "0.1",
  }));
}

/** The chips under a plain input, with the mark held the way the form holds it. */
function Harness({
  presets,
  availability = "enabled",
  base = "1723",
}: {
  readonly presets: readonly RatePreset[] | undefined;
  readonly availability?: ChipAvailability;
  readonly base?: string | null;
}) {
  const [value, setValue] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  return (
    <>
      <input data-testid="field" aria-label="Courtage" value={value} readOnly />
      <p id="field-hint">hint</p>
      <RateChips
        rubrique="BROKERAGE"
        fieldLabel="Courtage"
        presets={presets}
        availability={availability}
        base={base === null ? null : parseDecimalString(base)}
        fieldCurrency="EUR"
        selectedLabel={mark}
        hintId="field-hint"
        onApply={(label, next) => {
          setValue(next);
          setMark(label);
        }}
      />
    </>
  );
}

function renderChips(props: Parameters<typeof Harness>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

function chipIds(): string[] {
  return screen
    .queryAllByRole("button")
    .map((button) => button.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith("rate-chip-"));
}

describe("RateChips — what is rendered (TDR-L18, C-13)", () => {
  it("two presets: two chips and « + »", () => {
    renderChips({ presets: brokerage(2) });
    expect(chipIds()).toEqual([
      "rate-chip-BROKERAGE-0",
      "rate-chip-BROKERAGE-1",
      "rate-chip-add-BROKERAGE",
    ]);
    expect(screen.getByTestId("rate-chip-add-BROKERAGE")).toHaveAccessibleName("Ajouter un taux");
  });

  it("five presets: three chips, « Autres (2) », « + »; expanding shows all five inline", () => {
    renderChips({ presets: brokerage(5) });
    expect(chipIds()).toEqual([
      "rate-chip-BROKERAGE-0",
      "rate-chip-BROKERAGE-1",
      "rate-chip-BROKERAGE-2",
      "rate-chip-more-BROKERAGE",
      "rate-chip-add-BROKERAGE",
    ]);
    const more = screen.getByTestId("rate-chip-more-BROKERAGE");
    expect(more).toHaveTextContent("Autres (2)");
    expect(more).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(more);

    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(chipIds().filter((id) => /^rate-chip-BROKERAGE-\d$/.test(id))).toHaveLength(5);
    // Inline, in the same row — no popover.
    expect(screen.getByTestId("rate-chip-BROKERAGE-4").parentElement).toBe(more.parentElement);
  });

  it("zero presets in the rubrique: only « + » (other rubriques' presets are not shown)", () => {
    renderChips({ presets: RATE_PRESET_DEFAULTS.filter((p) => p.rubrique !== "BROKERAGE") });
    expect(chipIds()).toEqual(["rate-chip-add-BROKERAGE"]);
  });

  it("the pill reads the canonical rate with « . », and the minimum in the field's currency (C-6, C-14)", () => {
    renderChips({ presets: RATE_PRESET_DEFAULTS });
    expect(screen.getByTestId("rate-chip-BROKERAGE-0")).toHaveTextContent("Fortuneo 0.35 %");
    expect(screen.getByTestId("rate-chip-BROKERAGE-1")).toHaveTextContent(
      "Saxo 0.08 % · min 2 EUR",
    );
  });

  it("renders nothing while the read is pending", () => {
    renderChips({ presets: undefined });
    expect(chipIds()).toEqual([]);
  });
});

describe("RateChips — apply, mark, clear (FR-654, FR-656, AC-546)", () => {
  it("a click writes the amount and marks the chip; a second click empties the field and clears the mark", () => {
    renderChips({ presets: RATE_PRESET_DEFAULTS });
    const fortuneo = screen.getByTestId("rate-chip-BROKERAGE-0");
    expect(fortuneo).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(fortuneo);

    // 1 723.00 × 0.35 % = 6.0305 → 6.03, half up, `.` decimal mark.
    expect(screen.getByTestId("field")).toHaveValue("6.03");
    expect(fortuneo).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(fortuneo);

    expect(screen.getByTestId("field")).toHaveValue("");
    expect(fortuneo).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking another chip replaces the value and the mark", () => {
    renderChips({ presets: RATE_PRESET_DEFAULTS, base: "100" });
    fireEvent.click(screen.getByTestId("rate-chip-BROKERAGE-0"));
    fireEvent.click(screen.getByTestId("rate-chip-BROKERAGE-1"));
    // 100 × 0.08 % = 0.08 < the 2 minimum.
    expect(screen.getByTestId("field")).toHaveValue("2.00");
    expect(screen.getByTestId("rate-chip-BROKERAGE-0")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("rate-chip-BROKERAGE-1")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("RateChips — disabled and unavailable (FR-655, FR-657, FR-666)", () => {
  it.each(["no-base", "currency-mismatch", "settled-in-asset"] as const)(
    "%s: the chips stay visible, disabled, described by the field's hint; « + » stays usable",
    (availability) => {
      renderChips({ presets: RATE_PRESET_DEFAULTS, availability, base: null });
      for (const id of ["rate-chip-BROKERAGE-0", "rate-chip-BROKERAGE-1"]) {
        expect(screen.getByTestId(id)).toBeDisabled();
        expect(screen.getByTestId(id)).toHaveAttribute("aria-describedby", "field-hint");
      }
      expect(screen.getByTestId("rate-chip-add-BROKERAGE")).toBeEnabled();
    },
  );

  it("presets unavailable: no chip at all, « + » disabled and described by the hint", () => {
    renderChips({ presets: undefined, availability: "presets-unavailable" });
    expect(chipIds()).toEqual(["rate-chip-add-BROKERAGE"]);
    expect(screen.getByTestId("rate-chip-add-BROKERAGE")).toBeDisabled();
    expect(screen.getByTestId("rate-chip-add-BROKERAGE")).toHaveAttribute(
      "aria-describedby",
      "field-hint",
    );
  });

  it("« + » is disabled at six presets in the rubrique, with the cap hint", () => {
    renderChips({ presets: brokerage(6) });
    const add = screen.getByTestId("rate-chip-add-BROKERAGE");
    expect(add).toBeDisabled();
    const hintId = add.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(hintId)).toHaveTextContent("Six taux au maximum pour ce champ");
  });

  it("« + » is enabled at five", () => {
    renderChips({ presets: brokerage(5) });
    expect(screen.getByTestId("rate-chip-add-BROKERAGE")).toBeEnabled();
  });
});
