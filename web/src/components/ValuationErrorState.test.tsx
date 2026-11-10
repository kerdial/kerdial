import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as instrumentsApi from "../lib/api/instruments.js";
import { ApiError } from "../lib/api-client.js";
import { ValuationErrorState } from "./ValuationErrorState.js";

// The declaring module, not the barrel — the mutation factory imports from it.
vi.mock("../lib/api/instruments.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api/instruments.js")>(
    "../lib/api/instruments.js",
  );
  return { ...actual, postManualPricePoint: vi.fn() };
});

const mockedApi = vi.mocked(instrumentsApi);

const INSTRUMENT_ID = "11111111-1111-4111-8111-111111111111";

/** The IPO price-gap payload, as `PortfoliosController` answers it. */
function priceGap(withSuggestion: boolean): ApiError {
  return new ApiError(422, {
    title: "Cannot value a holding: no price available",
    code: "VALUATION_PRICE_UNAVAILABLE",
    params: {
      valuationDate: "2021-06-02",
      instrumentId: INSTRUMENT_ID,
      symbol: "NEWCO",
      instrumentName: "Newco SA",
      firstPriceDate: "2021-06-15",
    },
    ...(withSuggestion
      ? { suggestedPrice: { date: "2021-06-01", close: "19.5", currency: "EUR" } }
      : {}),
  });
}

function renderState(error: ApiError): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <ValuationErrorState error={error} testId="perf" panelLabel="Performance" />
      </QueryClientProvider>
    ) as ReactElement,
  );
}

describe("ValuationErrorState — a named price gap", () => {
  beforeEach(() => {
    mockedApi.postManualPricePoint.mockReset();
  });

  it("names the instrument and its range, links its fiche, and offers the trade price", () => {
    renderState(priceGap(true));

    expect(screen.getByTestId("perf-detail")).toHaveTextContent("NEWCO (Newco SA)");
    expect(screen.getByTestId("perf-price-gap-range")).toHaveTextContent("15/06/2021");
    expect(screen.getByTestId("perf-price-gap-range")).toHaveTextContent("02/06/2021");
    expect(screen.getByTestId("perf-price-gap-fiche")).toHaveAttribute(
      "href",
      `/instruments/${INSTRUMENT_ID}`,
    );
    expect(screen.getByTestId("perf-price-gap-use-trade-price")).toHaveTextContent(
      "Utiliser le prix d'achat (19.50 EUR)",
    );
  });

  it("offers no button when the server sent no suggestion", () => {
    renderState(priceGap(false));

    expect(screen.getByTestId("perf-price-gap-fiche")).toBeInTheDocument();
    expect(screen.queryByTestId("perf-price-gap-use-trade-price")).not.toBeInTheDocument();
  });

  it("writes nothing until confirmed, then posts exactly the suggested point", async () => {
    mockedApi.postManualPricePoint.mockResolvedValue({
      priceDate: "2021-06-01",
      close: "19.5",
      currency: "EUR",
      sourceKey: "manual",
      origin: "MANUAL",
    });
    renderState(priceGap(true));

    fireEvent.click(screen.getByTestId("perf-price-gap-use-trade-price"));
    expect(mockedApi.postManualPricePoint).not.toHaveBeenCalled();
    const body = screen.getByTestId("perf-price-gap-confirm-body");
    expect(body).toHaveTextContent("19.50 EUR");
    expect(body).toHaveTextContent("01/06/2021");

    fireEvent.click(screen.getByTestId("perf-price-gap-confirm-submit"));

    await waitFor(() => {
      expect(mockedApi.postManualPricePoint).toHaveBeenCalledTimes(1);
    });
    expect(mockedApi.postManualPricePoint.mock.calls[0]?.[0]).toEqual({
      instrumentId: INSTRUMENT_ID,
      priceDate: "2021-06-01",
      close: "19.5",
      currency: "EUR",
    });
  });

  it("shows a refused write in place, in the dialog", async () => {
    mockedApi.postManualPricePoint.mockRejectedValue(
      new ApiError(429, { title: "limit", code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED" }),
    );
    renderState(priceGap(true));

    fireEvent.click(screen.getByTestId("perf-price-gap-use-trade-price"));
    fireEvent.click(screen.getByTestId("perf-price-gap-confirm-submit"));

    expect(await screen.findByTestId("perf-price-gap-confirm-error")).toHaveTextContent(
      /nombre maximal/i,
    );
    expect(screen.getByTestId("perf-price-gap-confirm")).toBeInTheDocument();
  });
});
