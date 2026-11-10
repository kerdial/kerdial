import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as instrumentsApi from "../lib/api/instruments.js";
import { ApiError } from "../lib/api-client.js";
import { InstrumentDeleteDialog } from "./InstrumentDeleteDialog.js";

// `../lib/api/instruments.js`, not the `api-client.js` barrel: the mutation
// factory under test (`queries/instruments.ts`) imports the function from the
// declaring module, and mocking the re-export leaves that binding untouched.
vi.mock("../lib/api/instruments.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api/instruments.js")>(
    "../lib/api/instruments.js",
  );
  return { ...actual, deleteInstrument: vi.fn() };
});

const mockedApi = vi.mocked(instrumentsApi);

const INSTRUMENT_ID = "11111111-1111-4111-8111-111111111111";

function renderDialog(onDeleted = vi.fn()): { onDeleted: ReturnType<typeof vi.fn> } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <InstrumentDeleteDialog
          open
          onOpenChange={() => {}}
          instrumentId={INSTRUMENT_ID}
          displayName="Novo-Nordisk AS"
          onDeleted={onDeleted}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onDeleted };
}

describe("InstrumentDeleteDialog", () => {
  beforeEach(() => {
    mockedApi.deleteInstrument.mockReset();
  });

  it("names the instrument and what goes with it before anything is destroyed", () => {
    renderDialog();
    expect(screen.getByTestId("instrument-delete-warning")).toHaveTextContent("Novo-Nordisk AS");
    expect(screen.getByTestId("instrument-delete-what-goes")).toHaveTextContent(
      /historique des cours/i,
    );
    expect(screen.getByTestId("instrument-delete-irreversible")).toHaveTextContent(/irréversible/i);
  });

  it("deletes and reports back on confirm", async () => {
    mockedApi.deleteInstrument.mockResolvedValue(undefined);
    const { onDeleted } = renderDialog();

    fireEvent.click(screen.getByTestId("instrument-delete-confirm"));

    await waitFor(() => {
      expect(mockedApi.deleteInstrument).toHaveBeenCalled();
    });
    // The first argument only: react-query v5 hands a `mutationFn` its
    // variables *and* a context object, so a `toHaveBeenCalledWith(id)` here
    // asserts the call shape of the library rather than the id this dialog
    // sends.
    expect(mockedApi.deleteInstrument.mock.calls[0]?.[0]).toBe(INSTRUMENT_ID);
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The refusal is the interesting path: the counts live only in the 409's
   * `params`, and the whole point of the message work is that the reader
   * learns *what* holds the instrument rather than that something does.
   */
  it("states the counted reason when the ledger still references it", async () => {
    mockedApi.deleteInstrument.mockRejectedValue(
      new ApiError(409, {
        title: "Cannot delete",
        code: "INSTRUMENT_DELETE_BLOCKED_BY_LEDGER",
        params: { transactions: 18, postings: 15, holdings: 1, realizedGains: 3 },
      }),
    );
    const { onDeleted } = renderDialog();

    fireEvent.click(screen.getByTestId("instrument-delete-confirm"));

    const error = await screen.findByTestId("instrument-delete-error");
    expect(error).toHaveTextContent("18 transactions");
    expect(error).toHaveTextContent("3 plus-values réalisées");
    // Singular, not "1 positions".
    expect(error).toHaveTextContent("1 position");
    // A refused delete must not navigate away from a screen that still exists.
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("omits a category with nothing in it, rather than saying « 0 »", async () => {
    mockedApi.deleteInstrument.mockRejectedValue(
      new ApiError(409, {
        title: "Cannot delete",
        code: "INSTRUMENT_DELETE_BLOCKED_BY_LEDGER",
        params: { transactions: 2, postings: 0, holdings: 0, realizedGains: 0 },
      }),
    );
    renderDialog();

    fireEvent.click(screen.getByTestId("instrument-delete-confirm"));

    const error = await screen.findByTestId("instrument-delete-error");
    expect(error).toHaveTextContent("2 transactions");
    expect(error.textContent).not.toMatch(/0 /);
  });
});
