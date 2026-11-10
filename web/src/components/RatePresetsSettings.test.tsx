import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_PRESET_DEFAULTS, type RatePreset } from "@kerdial/api-contracts";
import { parseDecimalString } from "@kerdial/core-decimal";
import * as apiClient from "../lib/api-client.js";
import { ApiError } from "../lib/api-client.js";
import { ratePresetsQueryOptions } from "../lib/queries.js";
import { RateChips } from "./RateChips.js";
import { RatePresetsSettings } from "./RatePresetsSettings.js";

/**
 * « Taux prédéfinis » on « Mon compte » (`transaction-dialog-refresh`
 * TDR-T12, FR-665). Rendered beside a Courtage chip row reading
 * the same query key, the way the dialog does, so "the dialog's cached list
 * shows it" is asserted on a rendered pill rather than on the cache alone.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchRatePresets: vi.fn(), saveRatePresets: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

function DialogChips() {
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

const LEDGER_KEY = ["transactions", "list"] as const;

function renderCard(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A ledger read already in the cache: a preset save must leave it alone (FR-659).
  queryClient.setQueryData(LEDGER_KEY, { items: [] });
  render(
    <QueryClientProvider client={queryClient}>
      <RatePresetsSettings />
      <DialogChips />
    </QueryClientProvider>,
  );
  return queryClient;
}

function typeInto(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function addPreset(rubrique: string, label: string, rate: string, minimum = ""): void {
  typeInto(`rate-preset-new-label-${rubrique}`, label);
  typeInto(`rate-preset-new-rate-${rubrique}`, rate);
  typeInto(`rate-preset-new-minimum-${rubrique}`, minimum);
  fireEvent.click(screen.getByTestId(`rate-preset-new-submit-${rubrique}`));
}

function fieldError(testId: string): string | null {
  return (
    screen.getByTestId(testId).closest(".k-field")?.querySelector('[role="alert"]')?.textContent ??
    null
  );
}

function rowLabels(rubrique: string): string[] {
  return within(screen.getByTestId(`rate-preset-group-${rubrique}`))
    .queryAllByTestId(/^rate-preset-row-/)
    .map((row) => row.querySelector("span span")?.textContent ?? "");
}

function sentList(call = 0): readonly RatePreset[] {
  const list = mockedApiClient.saveRatePresets.mock.calls[call]?.[0];
  if (list === undefined) throw new Error(`no PUT #${call}`);
  return list.items;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchRatePresets.mockResolvedValue({ items: RATE_PRESET_DEFAULTS });
  mockedApiClient.saveRatePresets.mockImplementation((list) => Promise.resolve(list));
});

describe("<RatePresetsSettings> — « Taux prédéfinis » (FR-665)", () => {
  it("lists the seeded lines grouped by rubrique, with the rate and the minimum", async () => {
    renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    expect(rowLabels("BROKERAGE")).toEqual(["Fortuneo", "Saxo"]);
    expect(rowLabels("TAX")).toEqual(["TTF"]);
    expect(rowLabels("WITHHOLDING")).toEqual(["PFU"]);
    expect(screen.getByTestId("rate-preset-row-BROKERAGE-1")).toHaveTextContent("Saxo0.08 %min 2");
    expect(screen.getByTestId("rate-preset-group-BROKERAGE")).toHaveAccessibleName("Courtage");
    expect(screen.getByTestId("rate-preset-group-WITHHOLDING")).toHaveAccessibleName(
      "Retenue à la source",
    );
  });

  it("adding « Test » 0.2 % min 1 in Courtage issues one PUT carrying the whole list in order, and the dialog's chips show it", async () => {
    const queryClient = renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    addPreset("BROKERAGE", "Test", "0.2", "1");
    expect(mockedApiClient.saveRatePresets).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("rate-presets-save"));
    await screen.findByTestId("rate-presets-saved");
    expect(mockedApiClient.saveRatePresets).toHaveBeenCalledTimes(1);
    expect(sentList()).toEqual([
      { rubrique: "BROKERAGE", label: "Fortuneo", rate: "0.35" },
      { rubrique: "BROKERAGE", label: "Saxo", rate: "0.08", minimum: "2" },
      { rubrique: "BROKERAGE", label: "Test", rate: "0.2", minimum: "1" },
      { rubrique: "TAX", label: "TTF", rate: "0.4" },
      { rubrique: "WITHHOLDING", label: "PFU", rate: "30" },
    ]);
    expect(screen.getByTestId("rate-chip-BROKERAGE-2")).toHaveTextContent("Test 0.2 % · min 1 EUR");
    // FR-659: nothing on the ledger side is invalidated or refetched.
    expect(queryClient.getQueryState(LEDGER_KEY)?.isInvalidated).toBe(false);
    expect(mockedApiClient.fetchRatePresets).toHaveBeenCalledTimes(1);
  });

  it("up/down reorders within the rubrique, and the PUT carries that order", async () => {
    renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    expect(screen.getByTestId("rate-preset-up-BROKERAGE-0")).toBeDisabled();
    expect(screen.getByTestId("rate-preset-down-BROKERAGE-1")).toBeDisabled();
    expect(screen.getByTestId("rate-preset-down-BROKERAGE-0")).toHaveAccessibleName(
      "Descendre Fortuneo",
    );
    fireEvent.click(screen.getByTestId("rate-preset-down-BROKERAGE-0"));
    expect(rowLabels("BROKERAGE")).toEqual(["Saxo", "Fortuneo"]);

    fireEvent.click(screen.getByTestId("rate-presets-save"));
    await waitFor(() => expect(mockedApiClient.saveRatePresets).toHaveBeenCalledTimes(1));
    expect(sentList().map((preset) => preset.label)).toEqual(["Saxo", "Fortuneo", "TTF", "PFU"]);
  });

  it("deleting all four and saving issues {items: []}, and the list stays empty", async () => {
    renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    fireEvent.click(screen.getByTestId("rate-preset-delete-BROKERAGE-0"));
    fireEvent.click(screen.getByTestId("rate-preset-delete-BROKERAGE-0"));
    fireEvent.click(screen.getByTestId("rate-preset-delete-TAX-0"));
    fireEvent.click(screen.getByTestId("rate-preset-delete-WITHHOLDING-0"));
    fireEvent.click(screen.getByTestId("rate-presets-save"));
    await screen.findByTestId("rate-presets-saved");
    expect(mockedApiClient.saveRatePresets).toHaveBeenCalledTimes(1);
    expect(mockedApiClient.saveRatePresets.mock.calls[0]?.[0]).toEqual({ items: [] });
    expect(screen.getByTestId("rate-preset-empty-BROKERAGE")).toBeInTheDocument();
    expect(screen.getByTestId("rate-preset-empty-TAX")).toBeInTheDocument();
    expect(screen.getByTestId("rate-preset-empty-WITHHOLDING")).toBeInTheDocument();
  });

  it("a duplicate label is a field error and issues no PUT", async () => {
    renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    addPreset("BROKERAGE", " fortuneo ", "0.5");
    expect(fieldError("rate-preset-new-label-BROKERAGE")).toBe(
      "Ce libellé existe déjà pour ce champ",
    );
    expect(rowLabels("BROKERAGE")).toEqual(["Fortuneo", "Saxo"]);
    // The same label in another rubrique is not a duplicate.
    addPreset("TAX", "Fortuneo", "0.1");
    expect(rowLabels("TAX")).toEqual(["TTF", "Fortuneo"]);
    expect(mockedApiClient.saveRatePresets).not.toHaveBeenCalled();
  });

  it("a 7th preset in a rubrique is a field error, is not listed, and issues no PUT", async () => {
    renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    for (const label of ["C", "D", "E", "F"]) addPreset("BROKERAGE", label, "0.1");
    expect(rowLabels("BROKERAGE")).toEqual(["Fortuneo", "Saxo", "C", "D", "E", "F"]);

    addPreset("BROKERAGE", "G", "0.1");
    expect(fieldError("rate-preset-new-label-BROKERAGE")).toBe("Six taux au maximum pour ce champ");
    expect(rowLabels("BROKERAGE")).toHaveLength(6);
    expect(mockedApiClient.saveRatePresets).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("rate-presets-save"));
    await waitFor(() => expect(mockedApiClient.saveRatePresets).toHaveBeenCalledTimes(1));
    expect(sentList().filter((preset) => preset.rubrique === "BROKERAGE")).toHaveLength(6);
  });

  it("an edited rate is validated, canonicalised, and changes no ledger query", async () => {
    const queryClient = renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    fireEvent.click(screen.getByTestId("rate-preset-edit-BROKERAGE-0"));
    expect(screen.getByTestId("rate-preset-edit-rate-BROKERAGE-0")).toHaveValue("0.35");
    typeInto("rate-preset-edit-rate-BROKERAGE-0", "0");
    fireEvent.click(screen.getByTestId("rate-preset-edit-done-BROKERAGE-0"));
    expect(fieldError("rate-preset-edit-rate-BROKERAGE-0")).toBe(
      "Un taux supérieur à 0 et au plus 100, avec 4 décimales au plus (ex. 0.35)",
    );
    typeInto("rate-preset-edit-rate-BROKERAGE-0", "0.500");
    fireEvent.click(screen.getByTestId("rate-preset-edit-done-BROKERAGE-0"));
    expect(screen.getByTestId("rate-preset-row-BROKERAGE-0")).toHaveTextContent("0.5 %");

    fireEvent.click(screen.getByTestId("rate-presets-save"));
    await screen.findByTestId("rate-presets-saved");
    expect(sentList()[0]).toEqual({ rubrique: "BROKERAGE", label: "Fortuneo", rate: "0.5" });
    expect(queryClient.getQueryState(LEDGER_KEY)?.isInvalidated).toBe(false);
  });

  it("a 400 from the server shows the banner in place and keeps the edits", async () => {
    mockedApiClient.saveRatePresets.mockRejectedValue(new ApiError(400, {}));
    renderCard();
    await screen.findByTestId("rate-preset-row-BROKERAGE-0");
    addPreset("BROKERAGE", "Test", "0.2", "1");
    fireEvent.click(screen.getByTestId("rate-presets-save"));
    expect(await screen.findByTestId("rate-presets-error")).toHaveTextContent(
      "Cette requête n'est pas valide. Vérifiez les informations saisies.",
    );
    expect(rowLabels("BROKERAGE")).toEqual(["Fortuneo", "Saxo", "Test"]);
    expect(screen.queryByTestId("rate-presets-saved")).not.toBeInTheDocument();
  });
});
