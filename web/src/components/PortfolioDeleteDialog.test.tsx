import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import * as calcEpoch from "../lib/calc-epoch.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { PortfolioDeleteDialog } from "./PortfolioDeleteDialog.js";

/**
 * `PortfolioDeleteDialog`'s type-to-confirm gating (the button stays disabled
 * for a near-match, case-mismatch, untrimmed variants) and its
 * offline-disabled behaviour. A3/locked OQ-P4.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  // `security-transfer` FR-580: the linked-transfer read the dialog makes.
  return { ...actual, deletePortfolio: vi.fn(), listTransactions: vi.fn() };
});

// F2 (`TransactionForm.test.tsx`'s exact precedent): wraps the *real*
// `invalidateAndVerifyCalcEpoch` by default — every test below except the
// dedicated stale-notice one exercises the real vacuous-`verified:true` path
// (nothing cached under either prefix in this isolated `QueryClient` can ever
// be "stale").
vi.mock("../lib/calc-epoch.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/calc-epoch.js")>("../lib/calc-epoch.js");
  return { ...actual, invalidateAndVerifyCalcEpoch: vi.fn(actual.invalidateAndVerifyCalcEpoch) };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedCalcEpoch = vi.mocked(calcEpoch);
const { ApiError } = apiClient;

const PORTFOLIO: apiClient.PortfolioSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Compte Principal",
  transactionCount: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  broker: null,
  description: null,
  accentColor: null,
  hasIcon: false,
  archived: false,
};

function renderDialog(portfolio: apiClient.PortfolioSummary = PORTFOLIO): {
  queryClient: QueryClient;
  onOpenChange: ReturnType<typeof vi.fn>;
  onDeleted: ReturnType<typeof vi.fn>;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onDeleted = vi.fn();
  render(
    (
      <QueryClientProvider client={queryClient}>
        <PortfolioDeleteDialog
          open
          onOpenChange={onOpenChange}
          portfolio={portfolio}
          onDeleted={onDeleted}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { queryClient, onOpenChange, onDeleted };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.listTransactions.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("PortfolioDeleteDialog — type-to-confirm gating (locked OQ-P4/A3)", () => {
  it("the confirm button is disabled for an empty input", () => {
    renderDialog();
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeDisabled();
  });

  it("stays disabled for a near-match", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeDisabled();
  });

  it("stays disabled for a case-mismatch", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "compte principal" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeDisabled();
  });

  it("enables on an exact match", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeEnabled();
  });

  it("A3: enables on an untrimmed variant — the typed value is trimmed before comparison", () => {
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "  Compte Principal  " },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeEnabled();
  });

  it("LOW-2 (security review): enables for a legacy, pre-trim-schema portfolio whose stored name carries surrounding whitespace, when the user types the name without it", () => {
    renderDialog({
      ...PORTFOLIO,
      // A row written before `portfolioNameSchema`'s `.trim()` (D11) existed
      // — the stored name itself carries whitespace the HTTP boundary would
      // reject today, but which this already-persisted row can still have.
      name: "  Compte Principal  ",
    });
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeEnabled();
  });

  it("LOW-2: stays disabled for a legacy whitespace-padded name if the typed value doesn't otherwise match", () => {
    renderDialog({ ...PORTFOLIO, name: "  Compte Principal  " });
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeDisabled();
  });

  it("itemises the transaction count in the warning copy", () => {
    renderDialog();
    expect(screen.getByTestId("portfolio-delete-warning")).toHaveTextContent("4 transaction(s)");
  });
});

/** Mirrors `use-online-status.test.tsx`'s own technique — `navigator.onLine` as a stubbed getter, since `useOnlineStatus` (not `onlineManager`, a separate TanStack Query-only signal) drives this dialog's own disabled/`title` state. */
function defineNavigatorOnLine(getValue: () => boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: getValue });
}

/**
 * **AR-28 / ADR-0013 policy 2 — "audit retained, and said out loud"**.
 *
 * The itemised warning is deliberately silent about the audit trail, and stays so. What was missing is the qualification
 * beside it: a user reasonably reads "delete portfolio" as erasure, while a
 * complete JSONB copy of every destroyed transaction remains in
 * `transaction_revision` for the life of the tenant.
 */
describe("PortfolioDeleteDialog — the retained audit trail is disclosed (AR-28)", () => {
  it("states that an audit record survives, in its own line beside the warning", () => {
    renderDialog();

    const notice = screen.getByTestId("portfolio-delete-audit-notice");
    expect(notice).toHaveTextContent("enregistrement d'audit");
    expect(notice).toHaveTextContent("ne signifie pas effacer");

    // Its own element, not folded into the warning — the warning's itemised
    // wording is a recorded design property and this must not have changed it.
    const warning = screen.getByTestId("portfolio-delete-warning");
    expect(warning).not.toBe(notice);
    expect(warning).toHaveTextContent("irréversible");
    expect(warning.textContent ?? "").not.toContain("audit");
  });

  it("promises no account deletion and quotes no backup window — neither exists", () => {
    // ADR-0013's policy 2 asks the dialog to point at full erasure via account
    // deletion, but `DELETE /account` is C23: deferred, not built. And its
    // 2026-08-27 amendment is explicit that a dialog quoting a
    // 30-day encrypted-backup window that no longer exists must not ship.
    // Asserted against the copy constant so the rule holds wherever it renders.
    const notice = PORTFOLIO_COPY.deleteAuditNotice;
    expect(notice).not.toMatch(/compte|account/i);
    expect(notice).not.toMatch(/sauvegarde|backup|30 jours/i);
    expect(notice).not.toMatch(/\d+\s*(jours|days)/i);
  });
});

describe("PortfolioDeleteDialog — offline-disabled behaviour (AC-P8)", () => {
  afterEach(() => defineNavigatorOnLine(() => true));

  it("the confirm button is disabled while offline, even with a matching input", () => {
    defineNavigatorOnLine(() => false);
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeDisabled();
    expect(screen.getByTestId("portfolio-delete-offline-error")).toBeInTheDocument();
  });

  it("re-enables once back online, still gated on a matching name", () => {
    defineNavigatorOnLine(() => false);
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    expect(screen.getByTestId("portfolio-delete-confirm")).toBeDisabled();

    defineNavigatorOnLine(() => true);
    fireEvent(window, new Event("online"));

    expect(screen.getByTestId("portfolio-delete-confirm")).toBeEnabled();
  });
});

describe("PortfolioDeleteDialog — deletion + cache invalidation", () => {
  it("calls deletePortfolio(id), invalidates the list, and closes on success", async () => {
    mockedApiClient.deletePortfolio.mockResolvedValueOnce(undefined);
    const { queryClient, onOpenChange, onDeleted } = renderDialog();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    fireEvent.click(screen.getByTestId("portfolio-delete-confirm"));

    await waitFor(() => expect(mockedApiClient.deletePortfolio).toHaveBeenCalledWith(PORTFOLIO.id));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => call[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(["portfolios", "list"]);
  });

  it("F2 precedent: on verified:false, stays open with the honest notice instead of closing silently", async () => {
    mockedApiClient.deletePortfolio.mockResolvedValueOnce(undefined);
    mockedCalcEpoch.invalidateAndVerifyCalcEpoch.mockResolvedValue({ verified: false });
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    fireEvent.click(screen.getByTestId("portfolio-delete-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-delete-calc-epoch-stale-notice")).toBeInTheDocument(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByTestId("portfolio-delete-calc-epoch-stale-notice-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("409 PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION shows the DRIP-dependency explanation", async () => {
    mockedApiClient.deletePortfolio.mockRejectedValueOnce(
      new ApiError(409, { code: "PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION" }),
    );
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    fireEvent.click(screen.getByTestId("portfolio-delete-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-delete-error")).toHaveTextContent(
        "un autre portefeuille",
      ),
    );
  });

  it("429 ADMISSION_BOUND_EXCEEDED shows the retry message", async () => {
    mockedApiClient.deletePortfolio.mockRejectedValueOnce(
      new ApiError(429, { code: "ADMISSION_BOUND_EXCEEDED" }),
    );
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });
    fireEvent.click(screen.getByTestId("portfolio-delete-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("portfolio-delete-error")).toHaveTextContent(
        "Trop d'opérations simultanées",
      ),
    );
  });
});

describe("PortfolioDeleteDialog — F1 precedent: the delete mutation is never queued/replayed offline", () => {
  it('is not paused while onlineManager reports offline ("always", not the default "online")', async () => {
    mockedApiClient.deletePortfolio.mockResolvedValueOnce(undefined);
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });

    onlineManager.setOnline(false);
    fireEvent.click(screen.getByTestId("portfolio-delete-confirm"));

    await waitFor(() => expect(mockedApiClient.deletePortfolio).toHaveBeenCalledTimes(1));
  });

  it("never replays on reconnect — exactly one attempt total, offline or not", async () => {
    mockedApiClient.deletePortfolio.mockRejectedValueOnce(new Error("boom"));
    renderDialog();
    fireEvent.change(screen.getByTestId("portfolio-delete-confirm-input"), {
      target: { value: "Compte Principal" },
    });

    onlineManager.setOnline(false);
    fireEvent.click(screen.getByTestId("portfolio-delete-confirm"));
    await waitFor(() => expect(mockedApiClient.deletePortfolio).toHaveBeenCalledTimes(1));

    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedApiClient.deletePortfolio).toHaveBeenCalledTimes(1);
  });
});

/**
 * `security-transfer` TR-21 (FR-580, OD-7 (c)): a portfolio holding
 * a leg of a **linked** transfer can still be deleted — the partner survives,
 * unlinked — and the dialog adds one sentence saying so, only then.
 */
describe("PortfolioDeleteDialog — the linked-transfer sentence (TR-21)", () => {
  function transferRow(transferLinkedTransactionId: string | null): apiClient.TransactionResponse {
    return {
      id: "44444444-4444-4444-8444-444444444444",
      portfolioId: PORTFOLIO.id,
      kind: "TRANSFER_OUT",
      transferLinkedTransactionId,
      transferLinkedPortfolioId: transferLinkedTransactionId === null ? null : PORTFOLIO.id,
    } as apiClient.TransactionResponse;
  }

  it("appears when the portfolio holds a linked leg — asked of the server by portfolio and transfer kinds", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [transferRow(null), transferRow("55555555-5555-4555-8555-555555555555")],
      nextCursor: null,
    });
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-delete-linked-transfers-notice")).toHaveTextContent(
        PORTFOLIO_COPY.deleteLinkedTransfersNotice,
      ),
    );
    expect(mockedApiClient.listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ portfolio: PORTFOLIO.id, kind: "TRANSFER_OUT,TRANSFER_IN" }),
      expect.anything(),
      "background",
    );
  });

  it("does not appear when every transfer leg here is unlinked", async () => {
    mockedApiClient.listTransactions.mockResolvedValue({
      items: [transferRow(null)],
      nextCursor: null,
    });
    const { queryClient } = renderDialog();
    // Settled, not merely issued: the absence below is then the answer, not a
    // render that happened before the answer arrived.
    await waitFor(() =>
      expect(
        queryClient.getQueryState(["transactions", "linked-transfer", PORTFOLIO.id])?.status,
      ).toBe("success"),
    );
    expect(queryClient.getQueryData(["transactions", "linked-transfer", PORTFOLIO.id])).toBe(false);
    expect(
      screen.queryByTestId("portfolio-delete-linked-transfers-notice"),
    ).not.toBeInTheDocument();
  });

  it("keeps reading past a page of unlinked legs, and finds the linked one on the next", async () => {
    mockedApiClient.listTransactions
      .mockResolvedValueOnce({ items: [transferRow(null)], nextCursor: "100" })
      .mockResolvedValueOnce({
        items: [transferRow("55555555-5555-4555-8555-555555555555")],
        nextCursor: null,
      });
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-delete-linked-transfers-notice")).toBeInTheDocument(),
    );
    expect(mockedApiClient.listTransactions).toHaveBeenCalledTimes(2);
  });

  it("is not asked at all for a portfolio with no transaction", async () => {
    renderDialog({ ...PORTFOLIO, transactionCount: 0 });
    expect(screen.getByTestId("portfolio-delete-confirm-input")).toBeInTheDocument();
    expect(mockedApiClient.listTransactions).not.toHaveBeenCalled();
  });
});
