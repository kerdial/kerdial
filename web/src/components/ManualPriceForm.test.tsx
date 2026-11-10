import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import { manualPriceCloseError, ManualPriceForm } from "./ManualPriceForm.js";

/**
 * UR-14 (AC103/AC105/
 * AC129). Covers this form's own client-side validation, the AC129
 * single-date pre-check (exactly one extra request per distinct date, the
 * replace-warning only for an existing **manual** point, and its explicitly
 * advisory copy), and the two manual-price error codes rendering via
 * `messageForError` without silently failing or closing.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    postManualPricePoint: vi.fn(),
    listInstrumentPrices: vi.fn(),
    fetchCurrencies: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);
const { ApiError } = apiClient;

const INSTRUMENT_ID = "22222222-2222-2222-2222-222222222222";

function renderForm(): { onSaved: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    (
      <QueryClientProvider client={queryClient}>
        <ManualPriceForm
          instrumentId={INSTRUMENT_ID}
          defaultCurrency="EUR"
          onSaved={onSaved}
          onCancel={onCancel}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onSaved, onCancel };
}

async function waitForCurrencyOptions(): Promise<void> {
  await waitFor(() =>
    expect(
      screen.getByTestId("manual-price-currency-select").querySelectorAll("option").length,
    ).toBeGreaterThan(1),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.fetchCurrencies.mockResolvedValue([
    { code: "EUR", name: "Euro", minorUnit: 2 },
    { code: "USD", name: "Dollar américain", minorUnit: 2 },
  ]);
  mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
});

describe("manualPriceCloseError — client-side mirror of the server's close validation", () => {
  it("requires a non-empty value", () => {
    expect(manualPriceCloseError("")).toBe("Le cours est obligatoire.");
  });

  it("rejects a non-decimal value", () => {
    expect(manualPriceCloseError("abc")).toBe("Le cours doit être un nombre décimal valide.");
  });

  it("rejects a non-positive value", () => {
    expect(manualPriceCloseError("0")).toBe("Le cours doit être strictement positif.");
    expect(manualPriceCloseError("-5")).toBe("Le cours doit être strictement positif.");
  });

  it("rejects more than MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES (18) fractional digits", () => {
    expect(manualPriceCloseError(`1.${"1".repeat(19)}`)).toMatch(/18 décimales/);
  });

  it("accepts a valid positive decimal with <= 18 fractional digits", () => {
    expect(manualPriceCloseError("42.50")).toBeUndefined();
    expect(manualPriceCloseError(`1.${"1".repeat(18)}`)).toBeUndefined();
  });
});

describe("<ManualPriceForm> — the native date/currency/close fields (FR-132/AC123)", () => {
  it('renders a native <input type="date"> for priceDate', () => {
    renderForm();
    expect(screen.getByTestId("manual-price-date-input")).toHaveAttribute("type", "date");
  });

  it("states unconditionally that a date already in use is replaced, not duplicated", () => {
    renderForm();
    expect(screen.getByTestId("manual-price-upsert-note")).toHaveTextContent(/remplace/);
  });

  it("close field validation blocks submission and never calls postManualPricePoint", async () => {
    renderForm();
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("manual-price-close-input"), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    await waitFor(() =>
      expect(screen.getByText("Le cours doit être un nombre décimal valide.")).toBeInTheDocument(),
    );
    expect(mockedApiClient.postManualPricePoint).not.toHaveBeenCalled();
  });
});

describe("<ManualPriceForm> — AC129: the single-date replace-warning pre-check", () => {
  it("issues exactly one request scoped to the exact date being checked, and warns only when a MANUAL point already exists for it", async () => {
    mockedApiClient.listInstrumentPrices.mockResolvedValue([
      {
        priceDate: "2026-08-01",
        close: "40.00",
        currency: "EUR",
        sourceKey: "manual",
        origin: "MANUAL",
      },
    ]);
    renderForm();
    await waitForCurrencyOptions();

    fireEvent.change(screen.getByTestId("manual-price-date-input"), {
      target: { value: "2026-08-01" },
    });

    await waitFor(() => expect(screen.getByTestId("manual-price-replace-warning")).toBeVisible());
    expect(screen.getByTestId("manual-price-replace-warning")).toHaveTextContent(
      "Une valeur existe déjà pour cette date et sera remplacée.",
    );
    // Honestly advisory — never claims a server-side guarantee.
    expect(screen.getByTestId("manual-price-replace-warning")).toHaveTextContent(/indicative/);

    // AC129: exactly one request scoped to *that* date — not zero (it must
    // fire), not more than one (repeated renders for the same date must not
    // re-issue it). The default `priceDate` (today) also fires its own,
    // separately scoped pre-check when the form first mounts — that is a
    // different date, so it is a different, independent request.
    const callsForTargetDate = mockedApiClient.listInstrumentPrices.mock.calls.filter(
      ([, params]) => (params as { from?: string })?.from === "2026-08-01",
    );
    expect(callsForTargetDate).toHaveLength(1);
    expect(callsForTargetDate[0]).toEqual([
      INSTRUMENT_ID,
      { from: "2026-08-01", to: "2026-08-01" },
      expect.anything(),
    ]);
  });

  it("does not warn when only an AUTOMATED point exists for that date — the upsert would not overwrite it", async () => {
    mockedApiClient.listInstrumentPrices.mockResolvedValue([
      {
        priceDate: "2026-08-01",
        close: "40.00",
        currency: "EUR",
        sourceKey: "eod-provider",
        origin: "AUTOMATED",
      },
    ]);
    renderForm();
    await waitForCurrencyOptions();

    fireEvent.change(screen.getByTestId("manual-price-date-input"), {
      target: { value: "2026-08-01" },
    });

    await waitFor(() => expect(mockedApiClient.listInstrumentPrices).toHaveBeenCalled());
    expect(screen.queryByTestId("manual-price-replace-warning")).not.toBeInTheDocument();
  });

  it("no manual point for that date: no warning at all", async () => {
    mockedApiClient.listInstrumentPrices.mockResolvedValue([]);
    renderForm();
    await waitForCurrencyOptions();

    fireEvent.change(screen.getByTestId("manual-price-date-input"), {
      target: { value: "2026-08-02" },
    });

    await waitFor(() => expect(mockedApiClient.listInstrumentPrices).toHaveBeenCalled());
    expect(screen.queryByTestId("manual-price-replace-warning")).not.toBeInTheDocument();
  });
});

describe("<ManualPriceForm> — AC105: manual-price error codes render via messageForError, never silently fail or close", () => {
  it("MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED renders its mapped French message and does not call onSaved", async () => {
    mockedApiClient.postManualPricePoint.mockRejectedValueOnce(
      new ApiError(429, { code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED" }),
    );
    const { onSaved } = renderForm();
    await waitForCurrencyOptions();

    fireEvent.change(screen.getByTestId("manual-price-close-input"), { target: { value: "42.5" } });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("manual-price-submit-error")).toHaveTextContent(
        /nombre maximal de prix saisis manuellement/,
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("MANUAL_PRICE_POINT_SCALE_EXCEEDED renders its mapped French message and does not call onSaved", async () => {
    mockedApiClient.postManualPricePoint.mockRejectedValueOnce(
      new ApiError(400, { code: "MANUAL_PRICE_POINT_SCALE_EXCEEDED" }),
    );
    const { onSaved } = renderForm();
    await waitForCurrencyOptions();

    fireEvent.change(screen.getByTestId("manual-price-close-input"), { target: { value: "42.5" } });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("manual-price-submit-error")).toHaveTextContent(/décimales/),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("never renders the server's own detail/title text (French mapped copy only)", async () => {
    mockedApiClient.postManualPricePoint.mockRejectedValueOnce(
      new ApiError(429, {
        code: "MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED",
        detail: "at most 500000 manual price points per tenant",
      }),
    );
    renderForm();
    await waitForCurrencyOptions();
    fireEvent.change(screen.getByTestId("manual-price-close-input"), { target: { value: "42.5" } });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("manual-price-submit-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("manual-price-submit-error")).not.toHaveTextContent(
      "at most 500000 manual price points per tenant",
    );
  });
});

describe("<ManualPriceForm> — a successful submission", () => {
  it("calls postManualPricePoint with the form's values and instrumentId, never sourceKey, and calls onSaved", async () => {
    mockedApiClient.postManualPricePoint.mockResolvedValueOnce({
      priceDate: "2026-08-01",
      close: "42.5",
      currency: "EUR",
      sourceKey: "manual",
      origin: "MANUAL",
    });
    const { onSaved } = renderForm();
    await waitForCurrencyOptions();

    fireEvent.change(screen.getByTestId("manual-price-date-input"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByTestId("manual-price-close-input"), { target: { value: "42.5" } });
    fireEvent.click(screen.getByTestId("manual-price-submit"));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.postManualPricePoint).toHaveBeenCalledWith(
      {
        instrumentId: INSTRUMENT_ID,
        priceDate: "2026-08-01",
        close: "42.5",
        currency: "EUR",
      },
      expect.anything(),
    );
  });
});
