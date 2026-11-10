import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_PRESET_DEFAULTS, type RatePreset } from "@kerdial/api-contracts";
import { parseDecimalString } from "@kerdial/core-decimal";
import * as apiClient from "../lib/api-client.js";
import { ratePresetsQueryOptions } from "../lib/queries.js";
import { RateChips } from "./RateChips.js";

/**
 * The « + » mini-form (`transaction-dialog-refresh` TDR-T9, FR-658, R-11):
 * driven through the chip row that opens it, inside an enclosing `<form>`, the
 * way the transaction drawer hosts it.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchRatePresets: vi.fn(), saveRatePresets: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

function Chips() {
  const presets = useQuery(ratePresetsQueryOptions()).data?.items;
  return (
    <RateChips
      rubrique="BROKERAGE"
      fieldLabel="Courtage"
      presets={presets}
      availability="enabled"
      base={parseDecimalString("100")}
      fieldCurrency="EUR"
      selectedLabel={null}
      onApply={() => {}}
    />
  );
}

function renderInForm(): { onSubmit: ReturnType<typeof vi.fn> } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  render(
    <QueryClientProvider client={queryClient}>
      <form onSubmit={onSubmit}>
        <Chips />
        <button type="submit">Enregistrer</button>
      </form>
    </QueryClientProvider>,
  );
  return { onSubmit };
}

async function openAddForm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("rate-chip-add-BROKERAGE"));
  expect(screen.getByTestId("rate-chip-new-BROKERAGE")).toBeInTheDocument();
}

function type(field: "label" | "rate" | "minimum", value: string): void {
  fireEvent.change(screen.getByTestId(`rate-chip-new-${field}-BROKERAGE`), { target: { value } });
}

function fieldError(field: "label" | "rate" | "minimum"): string | null {
  const input = screen.getByTestId(`rate-chip-new-${field}-BROKERAGE`);
  return input.closest(".k-field")?.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchRatePresets.mockResolvedValue({ items: RATE_PRESET_DEFAULTS });
  mockedApiClient.saveRatePresets.mockImplementation((list) => Promise.resolve(list));
});

describe("RatePresetAddForm — the « + » mini-form (FR-658)", () => {
  it("is not a <form>, and its focus starts on the label", async () => {
    renderInForm();
    await openAddForm();
    const group = screen.getByTestId("rate-chip-new-BROKERAGE");
    expect(group.closest("form")?.querySelectorAll("form")).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByTestId("rate-chip-new-label-BROKERAGE"));
  });

  it("Enter in any of its inputs never submits the enclosing form (R-11)", async () => {
    const { onSubmit } = renderInForm();
    await openAddForm();
    for (const field of ["label", "rate", "minimum"] as const) {
      const input = screen.getByTestId(`rate-chip-new-${field}-BROKERAGE`);
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a duplicate label (case-insensitive) shows a field error and issues no PUT", async () => {
    renderInForm();
    await openAddForm();
    type("label", "saxo");
    type("rate", "0.2");
    fireEvent.click(screen.getByTestId("rate-chip-new-submit-BROKERAGE"));
    expect(fieldError("label")).toBe("Ce libellé existe déjà pour ce champ");
    expect(mockedApiClient.saveRatePresets).not.toHaveBeenCalled();
  });

  it("a rate of 0 shows a field error and issues no PUT", async () => {
    renderInForm();
    await openAddForm();
    type("label", "Test");
    type("rate", "0");
    fireEvent.click(screen.getByTestId("rate-chip-new-submit-BROKERAGE"));
    expect(fieldError("rate")).not.toBeNull();
    expect(fieldError("label")).toBeNull();
    expect(mockedApiClient.saveRatePresets).not.toHaveBeenCalled();
  });

  it("a valid add issues one PUT with the full list, the item after the rubrique's last, and shows the pill — without applying it", async () => {
    renderInForm();
    await openAddForm();
    type("label", "Test");
    type("rate", "0.2");
    type("minimum", "1");
    fireEvent.click(screen.getByTestId("rate-chip-new-submit-BROKERAGE"));

    await waitFor(() =>
      expect(screen.getByTestId("rate-chip-BROKERAGE-2")).toHaveTextContent(
        "Test 0.2 % · min 1 EUR",
      ),
    );
    expect(mockedApiClient.saveRatePresets).toHaveBeenCalledTimes(1);
    const expected: RatePreset[] = [
      RATE_PRESET_DEFAULTS[0]!,
      RATE_PRESET_DEFAULTS[1]!,
      { rubrique: "BROKERAGE", label: "Test", rate: "0.2", minimum: "1" },
      RATE_PRESET_DEFAULTS[2]!,
      RATE_PRESET_DEFAULTS[3]!,
    ];
    expect(mockedApiClient.saveRatePresets.mock.calls[0]?.[0]).toEqual({ items: expected });
    expect(screen.queryByTestId("rate-chip-new-BROKERAGE")).not.toBeInTheDocument();
    expect(screen.getByTestId("rate-chip-BROKERAGE-2")).toHaveAttribute("aria-pressed", "false");
  });

  it("« Annuler » closes it with no request", async () => {
    renderInForm();
    await openAddForm();
    type("label", "Test");
    fireEvent.click(screen.getByTestId("rate-chip-new-cancel-BROKERAGE"));
    expect(screen.queryByTestId("rate-chip-new-BROKERAGE")).not.toBeInTheDocument();
    expect(mockedApiClient.saveRatePresets).not.toHaveBeenCalled();
  });

  it("a failed PUT keeps the mini-form open with an error", async () => {
    mockedApiClient.saveRatePresets.mockRejectedValue(new Error("network"));
    renderInForm();
    await openAddForm();
    type("label", "Test");
    type("rate", "0.2");
    fireEvent.click(screen.getByTestId("rate-chip-new-submit-BROKERAGE"));
    expect(await screen.findByTestId("rate-chip-new-error-BROKERAGE")).toBeInTheDocument();
    expect(screen.getByTestId("rate-chip-new-BROKERAGE")).toBeInTheDocument();
  });
});
