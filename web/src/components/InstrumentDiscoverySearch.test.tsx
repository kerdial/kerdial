import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { InstrumentDiscoverySearch } from "./InstrumentDiscoverySearch.js";

/**
 * IC-14's own acceptance criteria
 * (AC-6, AC-7, NFR-1). This cycle's binding rule 2 requires a
 * **red-confirmed** call-count assertion for the debounce and a genuine
 * `AbortSignal.aborted` assertion for the supersede case — both below.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, searchInstrumentDiscovery: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);
const { ApiError } = apiClient;

function renderSearch(onSelect = vi.fn()): { onSelect: typeof onSelect } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <InstrumentDiscoverySearch kind="SHARE" onSelect={onSelect} />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onSelect };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.searchInstrumentDiscovery.mockResolvedValue([]);
});

describe("<InstrumentDiscoverySearch> — debounce (AC-6)", () => {
  it("several rapid keystrokes fire only one search, for the final committed value — not one per keystroke", async () => {
    renderSearch();
    const input = screen.getByTestId("instrument-discovery-search-input");

    fireEvent.change(input, { target: { value: "T" } });
    fireEvent.change(input, { target: { value: "To" } });
    fireEvent.change(input, { target: { value: "Tot" } });
    fireEvent.change(input, { target: { value: "Total" } });
    fireEvent.change(input, { target: { value: "TotalEnergies" } });

    // RED-CONFIRM: immediately after the burst, the debounce has not
    // committed yet — this is what proves a genuine debounce rather than
    // merely "eventually only one call happens to appear in the assertion
    // window below" (this suite's own red-confirm discipline).
    expect(mockedApiClient.searchInstrumentDiscovery).not.toHaveBeenCalled();

    await waitFor(
      () => expect(mockedApiClient.searchInstrumentDiscovery).toHaveBeenCalledTimes(1),
      { timeout: 1_000 },
    );
    expect(mockedApiClient.searchInstrumentDiscovery).toHaveBeenCalledWith(
      "SHARE",
      "TotalEnergies",
      expect.any(AbortSignal),
    );
  });

  it("a query shorter than 3 characters never fires a search", async () => {
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TO" },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mockedApiClient.searchInstrumentDiscovery).not.toHaveBeenCalled();
  });
});

describe("<InstrumentDiscoverySearch> — supersede/abort (NFR-1)", () => {
  it("RED-CONFIRM: a superseded in-flight request's own AbortSignal is genuinely aborted", async () => {
    const captured: { query: string; signal: AbortSignal }[] = [];
    let resolveFirst: (() => void) | undefined;
    mockedApiClient.searchInstrumentDiscovery.mockImplementation(
      (_kind: string, query: string, signal?: AbortSignal) => {
        captured.push({ query, signal: signal as AbortSignal });
        if (query === "Total") {
          return new Promise((resolve) => {
            resolveFirst = () => resolve([]);
          });
        }
        return Promise.resolve([]);
      },
    );

    renderSearch();
    const input = screen.getByTestId("instrument-discovery-search-input");

    fireEvent.change(input, { target: { value: "Total" } });
    await waitFor(() => expect(captured).toHaveLength(1), { timeout: 1_000 });
    expect(captured[0]?.signal.aborted).toBe(false);

    // Supersede before the first ever resolves — a genuinely new query key.
    fireEvent.change(input, { target: { value: "TotalEnergies" } });
    await waitFor(() => expect(captured).toHaveLength(2), { timeout: 1_000 });

    // The FIRST request's own signal must now be aborted — not merely
    // ignored/superseded in UI state, the real network-level signal.
    await waitFor(() => expect(captured[0]?.signal.aborted).toBe(true), { timeout: 1_000 });
    expect(captured[1]?.signal.aborted).toBe(false);

    resolveFirst?.();
  });
});

describe("<InstrumentDiscoverySearch> — error cases (AC-7)", () => {
  it("DISCOVERY_PROVIDER_RATE_LIMITED renders its own calm message", async () => {
    mockedApiClient.searchInstrumentDiscovery.mockRejectedValue(
      new ApiError(429, { code: "DISCOVERY_PROVIDER_RATE_LIMITED" }),
    );
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TotalEnergies" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("instrument-discovery-error")).toHaveTextContent(
      "Trop de recherches",
    );
  });

  it("DISCOVERY_PROVIDER_UNAVAILABLE renders a distinct calm message", async () => {
    mockedApiClient.searchInstrumentDiscovery.mockRejectedValue(
      new ApiError(503, { code: "DISCOVERY_PROVIDER_UNAVAILABLE" }),
    );
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TotalEnergies" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("instrument-discovery-error")).toHaveTextContent(
      "momentanément indisponible",
    );
  });

  it("DISCOVERY_PROVIDER_MALFORMED renders a message distinct from both the rate-limit and unavailable ones", async () => {
    mockedApiClient.searchInstrumentDiscovery.mockRejectedValue(
      new ApiError(502, { code: "DISCOVERY_PROVIDER_MALFORMED" }),
    );
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TotalEnergies" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-error")).toBeInTheDocument(),
    );
    const text = screen.getByTestId("instrument-discovery-error").textContent;
    expect(text).not.toContain("Trop de recherches");
    expect(text).not.toContain(
      "momentanément indisponible — saisie manuelle possible.".slice(0, 10),
    );
  });

  it("retry: false — a rate-limited discovery search is never silently retried", async () => {
    mockedApiClient.searchInstrumentDiscovery.mockRejectedValue(
      new ApiError(429, { code: "DISCOVERY_PROVIDER_RATE_LIMITED" }),
    );
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TotalEnergies" },
    });
    await waitFor(() => expect(mockedApiClient.searchInstrumentDiscovery).toHaveBeenCalledTimes(1));
    // Give ample time for any retry attempt to have fired.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mockedApiClient.searchInstrumentDiscovery).toHaveBeenCalledTimes(1);
  });

  it("empty results render a calm, distinct message (not an error)", async () => {
    mockedApiClient.searchInstrumentDiscovery.mockResolvedValue([]);
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TotalEnergies" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("instrument-discovery-error")).not.toBeInTheDocument();
  });
});

describe("<InstrumentDiscoverySearch> — selection", () => {
  it("clicking a result calls onSelect with the full candidate and the query that produced it", async () => {
    mockedApiClient.searchInstrumentDiscovery.mockResolvedValue([
      {
        providerSymbol: "TTE.PA",
        tickerSymbol: null,
        displayName: "TotalEnergies SE",
        listingCurrency: "EUR",
        exchangeHint: { code: "PAR", suggestedMic: "XPAR" },
        matchQuality: "PROBABLE",
      },
    ]);
    const { onSelect } = renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "TotalEnergies" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-result")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("instrument-discovery-result"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "TotalEnergies SE", providerSymbol: "TTE.PA" }),
      "TotalEnergies",
    );
  });
});

/**
 * IR-10 (FR-3,
 * FR-7) — the candidate row shows the **mapped** sector's French label. `web`
 * maps nothing: it renders the code through `sectorDisplayLabel` (the single-site rule: the
 * one code-to-text site in `web`), so a provider string appearing here would be
 * a regression this asserts against directly.
 */
describe("<InstrumentDiscoverySearch> — sector label on a candidate row (IR-10)", () => {
  function candidate(
    overrides: Partial<apiClient.DiscoveryCandidate>,
  ): apiClient.DiscoveryCandidate {
    return {
      providerSymbol: "MT.AS",
      tickerSymbol: null,
      displayName: "ArcelorMittal",
      listingCurrency: "EUR",
      exchangeHint: { code: "AMS", suggestedMic: "XAMS" },
      matchQuality: "EXACT",
      ...overrides,
    };
  }

  async function renderWith(item: apiClient.DiscoveryCandidate): Promise<void> {
    mockedApiClient.searchInstrumentDiscovery.mockResolvedValue([item]);
    renderSearch();
    fireEvent.change(screen.getByTestId("instrument-discovery-search-input"), {
      target: { value: "ArcelorMittal" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("instrument-discovery-result")).toBeInTheDocument(),
    );
  }

  it("renders the French label for a mapped sector code, never the code itself", async () => {
    await renderWith(candidate({ sectorCode: "MATERIAUX", industryLabel: "Steel" }));

    expect(screen.getByTestId("instrument-discovery-result-sector")).toHaveTextContent("Matériaux");
    expect(screen.getByTestId("instrument-discovery-result")).not.toHaveTextContent("MATERIAUX");
  });

  it.each([
    { label: "null (an unmapped provider sector, FR-3)", sectorCode: null },
    { label: "absent (a non-SHARE query, FR-7)", sectorCode: undefined },
  ])("renders no sector element at all when sectorCode is $label", async ({ sectorCode }) => {
    await renderWith(candidate(sectorCode === undefined ? {} : { sectorCode }));

    expect(screen.queryByTestId("instrument-discovery-result-sector")).toBeNull();
  });
});
