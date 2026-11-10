import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { MESSAGE_TABLE } from "../lib/problem-messages.js";
import type { PickState } from "../lib/icon-pick.js";
import { PortfolioIconField, iconIntentOf } from "./PortfolioIconField.js";

/**
 * `PortfolioIconField.test.tsx` — `portfolio-details` PD-T10 (FR-453 at the UI layer, FR-460, FR-461).
 *
 * The field is controlled by the form, so the harness below owns the same two
 * pieces of state the form does — that is what makes the intent assertions
 * about the real component rather than about a stub.
 */

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

function Harness({ hasIcon }: { hasIcon: boolean }) {
  const [pick, setPick] = useState<PickState>({ kind: "none" });
  const [removeRequested, setRemoveRequested] = useState(false);
  return (
    <>
      <PortfolioIconField
        hasIcon={hasIcon}
        pick={pick}
        onPickChange={setPick}
        removeRequested={removeRequested}
        onRemoveRequestedChange={setRemoveRequested}
      />
      <output data-testid="intent">{iconIntentOf(pick, removeRequested).kind}</output>
    </>
  );
}

function renderField(hasIcon = false) {
  return render((<Harness hasIcon={hasIcon} />) as ReactElement);
}

async function pick(file: File): Promise<void> {
  fireEvent.change(screen.getByTestId("portfolio-icon-file-input"), {
    target: { files: [file] },
  });
  await waitFor(() => {
    expect(
      screen.queryByTestId("portfolio-icon-facts") ??
        screen.queryByTestId("portfolio-icon-rejected"),
    ).not.toBeNull();
  });
}

describe("<PortfolioIconField>", () => {
  it("shows the facts panel — and constructs no blob:/data: URL, in source or in the DOM", async () => {
    const { container } = renderField();
    await pick(new File([pngBytes(128, 64)], "logo.png", { type: "image/png" }));

    const facts = screen.getByTestId("portfolio-icon-facts").textContent!;
    expect(facts).toContain("logo.png");
    expect(facts).toContain("PNG");
    expect(facts).toContain("128 × 64 px");
    expect(facts).toContain(PORTFOLIO_COPY.iconReady);
    expect(screen.getByTestId("intent")).toHaveTextContent("set");

    // `img-src 'self'` admits neither scheme, so a preview cannot render —
    // the facts panel is the substitute, not a fallback for one that failed.
    const srcs = Array.from(container.querySelectorAll("[src]")).map((el) =>
      el.getAttribute("src"),
    );
    expect(srcs.filter((src) => src?.startsWith("blob:") || src?.startsWith("data:"))).toEqual([]);
  });

  it("refuses an unsupported file with the server's own sentence, and asks for nothing", async () => {
    renderField();
    const gif = new Uint8Array(32);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    await pick(new File([gif], "anim.gif", { type: "image/gif" }));

    expect(screen.getByTestId("portfolio-icon-rejected").textContent).toContain(
      MESSAGE_TABLE["PORTFOLIO_ICON_UNSUPPORTED_FORMAT"]!.text,
    );
    expect(screen.getByTestId("intent")).toHaveTextContent("keep");
  });

  it("offers removal only when there is an icon, and confirms before intending it", () => {
    renderField(false);
    expect(screen.queryByTestId("portfolio-icon-remove")).toBeNull();
    expect(screen.getByTestId("portfolio-icon-state")).toHaveTextContent(PORTFOLIO_COPY.iconNone);

    renderField(true);
    fireEvent.click(screen.getByTestId("portfolio-icon-remove"));
    expect(screen.getByTestId("portfolio-icon-remove-confirm")).toHaveTextContent(
      PORTFOLIO_COPY.iconRemoveConfirm,
    );
    expect(screen.getAllByTestId("intent").at(-1)).toHaveTextContent("remove");

    fireEvent.click(screen.getByTestId("portfolio-icon-remove-cancel"));
    expect(screen.getAllByTestId("intent").at(-1)).toHaveTextContent("keep");
  });

  it("a file picked after a removal request is a change of mind, not both writes", async () => {
    renderField(true);
    fireEvent.click(screen.getByTestId("portfolio-icon-remove"));
    await pick(new File([pngBytes(32, 32)], "new.png", { type: "image/png" }));
    expect(screen.getByTestId("intent")).toHaveTextContent("set");
    expect(screen.queryByTestId("portfolio-icon-remove-confirm")).toBeNull();
  });
});
