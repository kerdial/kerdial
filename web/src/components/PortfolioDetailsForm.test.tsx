import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { PortfolioSummary } from "../lib/api-client.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { MESSAGE_TABLE } from "../lib/problem-messages.js";
import { PortfolioDetailsForm } from "./PortfolioDetailsForm.js";

/**
 * `PortfolioDetailsForm.test.tsx` — **was `PortfolioNameForm.test.tsx`**
 * (`portfolio-details` PD-T10; FR-453 at the UI layer, FR-455,
 * FR-457, FR-476, A-1).
 *
 * The two properties that are *correctness* rather than polish, and that a
 * looser suite would miss:
 *
 * 1. **Only dirty fields reach the `PATCH` body.** The server's schema is
 *    `z.strictObject` + "at least one field", so a key the user never touched
 *    is a silent overwrite and an empty body is a `400`. Both failure modes are
 *    invisible to a test that only asserts "a request was made".
 * 2. **The `PATCH` precedes the icon write, and a failed icon write leaves the
 *    field edits committed.** That ordering is the whole of A-1's accepted
 *    non-atomicity; asserted here on call order, not inferred from the code.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    createPortfolio: vi.fn(),
    updatePortfolio: vi.fn(),
    setPortfolioIcon: vi.fn(),
    deletePortfolioIcon: vi.fn(),
  };
});

const mocked = vi.mocked(apiClient);
const { ApiError } = apiClient;

const PORTFOLIO_ID = "11111111-1111-1111-1111-111111111111";

function portfolio(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    id: PORTFOLIO_ID,
    name: "Compte principal",
    transactionCount: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    broker: "Boursorama",
    description: "PEA long terme",
    accentColor: "CHART_2",
    hasIcon: false,
    archived: false,
    ...overrides,
  };
}

function pngBytes(widthPx: number, heightPx: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, widthPx);
  view.setUint32(20, heightPx);
  return bytes;
}

function renderForm(mode: "create" | "edit", row?: PortfolioSummary) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const onIconWritten = vi.fn();
  const result = render(
    (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PortfolioDetailsForm
          mode={mode}
          {...(row !== undefined ? { portfolio: row } : {})}
          onSaved={onSaved}
          onCancel={onCancel}
          onIconWritten={onIconWritten}
        />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { ...result, onSaved, onCancel, onIconWritten };
}

async function pickIcon(file: File): Promise<void> {
  fireEvent.change(screen.getByTestId("portfolio-icon-file-input"), { target: { files: [file] } });
  await waitFor(() => {
    expect(screen.queryByTestId("portfolio-icon-facts")).not.toBeNull();
  });
}

function submit(): void {
  fireEvent.submit(screen.getByTestId("portfolio-name-form"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<PortfolioDetailsForm> — the four optional controls", () => {
  it("prefills all four from the row, each with its own clear affordance (FR-453)", () => {
    renderForm("edit", portfolio({ hasIcon: true }));

    expect(screen.getByTestId("portfolio-name-input")).toHaveValue("Compte principal");
    expect(screen.getByTestId("portfolio-broker-input")).toHaveValue("Boursorama");
    expect(screen.getByTestId("portfolio-description-input")).toHaveValue("PEA long terme");
    // The accent's clear affordance is « Aucune », an option of the group, not
    // a separate reset button.
    expect(screen.getByLabelText(PORTFOLIO_COPY.accentNone)).not.toBeChecked();
    expect(screen.getByLabelText(PORTFOLIO_COPY.accentChart2)).toBeChecked();
    // The icon's is « Supprimer l'icône », offered only because `hasIcon`.
    expect(screen.getByTestId("portfolio-icon-remove")).toBeInTheDocument();
  });

  it("renders the field error inside the label that wraps the input", async () => {
    // The structural reading two shipped suites depend on: the kit's
    // `<Input>` puts its message outside the `<label>`, which is why this form
    // is hand-styled. A rename must not quietly change that.
    renderForm("create");
    fireEvent.change(screen.getByTestId("portfolio-name-input"), { target: { value: "   " } });
    submit();

    await waitFor(() => {
      const label = screen.getByTestId("portfolio-name-input").closest("label");
      expect(label?.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(mocked.createPortfolio).not.toHaveBeenCalled();
  });
});

describe("<PortfolioDetailsForm> — create sends one request (FR-455)", () => {
  it("omits untouched optional fields and carries the icon in the same POST", async () => {
    mocked.createPortfolio.mockResolvedValue(portfolio({ hasIcon: true }));
    const { onSaved } = renderForm("create");

    fireEvent.change(screen.getByTestId("portfolio-name-input"), { target: { value: "CTO" } });
    fireEvent.click(screen.getByLabelText(PORTFOLIO_COPY.accentChart4));
    await pickIcon(new File([pngBytes(64, 64)], "logo.png", { type: "image/png" }));
    submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocked.createPortfolio).toHaveBeenCalledTimes(1);
    const body = mocked.createPortfolio.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["accentColor", "icon", "name"]);
    expect(body["accentColor"]).toBe("CHART_4");
    // The **sniffed** type, not the browser's guess from the extension.
    expect(body["icon"]).toMatchObject({ declaredContentType: "image/png" });
    // No second request: the icon routes are not touched on the create path.
    expect(mocked.setPortfolioIcon).not.toHaveBeenCalled();
  });
});

describe("<PortfolioDetailsForm> — edit sends only what changed (FR-457)", () => {
  it("disables submit when nothing is dirty, so the `{}` body is unreachable", () => {
    renderForm("edit", portfolio());
    expect(screen.getByTestId("portfolio-name-form-submit")).toBeDisabled();
  });

  it("sends exactly the dirty keys, and `null` for a field the user emptied", async () => {
    mocked.updatePortfolio.mockResolvedValue(portfolio({ broker: null }));
    const { onSaved } = renderForm("edit", portfolio());

    fireEvent.change(screen.getByTestId("portfolio-broker-input"), { target: { value: "" } });
    expect(screen.getByTestId("portfolio-name-form-submit")).toBeEnabled();
    submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocked.updatePortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, { broker: null });
  });

  it("a field typed into and restored is not dirty, and does not reach the body", async () => {
    mocked.updatePortfolio.mockResolvedValue(portfolio({ name: "Autre" }));
    renderForm("edit", portfolio());

    const description = screen.getByTestId("portfolio-description-input");
    fireEvent.change(description, { target: { value: "PEA long terme modifié" } });
    fireEvent.change(description, { target: { value: "PEA long terme" } });
    fireEvent.change(screen.getByTestId("portfolio-name-input"), { target: { value: "Autre" } });
    submit();

    await waitFor(() => expect(mocked.updatePortfolio).toHaveBeenCalled());
    expect(mocked.updatePortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, { name: "Autre" });
  });

  it("an icon-only edit issues no PATCH at all", async () => {
    mocked.deletePortfolioIcon.mockResolvedValue(undefined);
    const { onSaved, onIconWritten } = renderForm("edit", portfolio({ hasIcon: true }));

    fireEvent.click(screen.getByTestId("portfolio-icon-remove"));
    submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocked.updatePortfolio).not.toHaveBeenCalled();
    expect(mocked.deletePortfolioIcon).toHaveBeenCalledWith(PORTFOLIO_ID);
    // The list invalidation alone leaves the mounted <img> showing the
    // removed bitmap, so the version bump is the other required half.
    expect(onIconWritten).toHaveBeenCalledTimes(1);
  });
});

describe("<PortfolioDetailsForm> — the edit path is sequential, and not atomic (A-1)", () => {
  it("issues the PATCH before the icon write", async () => {
    const order: string[] = [];
    mocked.updatePortfolio.mockImplementation(async () => {
      order.push("patch");
      return portfolio({ name: "Renommé" });
    });
    mocked.setPortfolioIcon.mockImplementation(async () => {
      order.push("icon");
      return {
        portfolioId: PORTFOLIO_ID,
        contentType: "image/png" as const,
        byteLength: 24,
        widthPx: 64,
        heightPx: 64,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    });
    const { onSaved } = renderForm("edit", portfolio());

    fireEvent.change(screen.getByTestId("portfolio-name-input"), { target: { value: "Renommé" } });
    await pickIcon(new File([pngBytes(64, 64)], "logo.png", { type: "image/png" }));
    submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(order).toEqual(["patch", "icon"]);
  });

  it("a failed icon write keeps the form open, reports on the icon field, and leaves the field edit committed", async () => {
    mocked.updatePortfolio.mockResolvedValue(portfolio({ name: "Renommé" }));
    mocked.setPortfolioIcon.mockRejectedValue(
      new ApiError(422, { title: "Unreadable", code: "PORTFOLIO_ICON_UNREADABLE" }),
    );
    const { onSaved } = renderForm("edit", portfolio());

    fireEvent.change(screen.getByTestId("portfolio-name-input"), { target: { value: "Renommé" } });
    await pickIcon(new File([pngBytes(64, 64)], "logo.png", { type: "image/png" }));
    submit();

    const error = await screen.findByTestId("portfolio-icon-error");
    // The specific refusal, worded by the same object the instrument code uses.
    expect(error.textContent).toContain(MESSAGE_TABLE["PORTFOLIO_ICON_UNREADABLE"]!.text);
    // …and the honest half: the row edit *did* persist.
    expect(error.textContent).toContain(PORTFOLIO_COPY.iconFailed);
    expect(mocked.updatePortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, { name: "Renommé" });
    // The dialog does not close: `onSaved` is what closes it.
    expect(onSaved).not.toHaveBeenCalled();
  });
});
