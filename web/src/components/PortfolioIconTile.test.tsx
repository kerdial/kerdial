import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { portfolioIconUrl } from "../lib/api-client.js";
import { PortfolioIconTile } from "./PortfolioIconTile.js";

/**
 * `PortfolioIconTile.test.tsx` — `portfolio-details` PD-T10 (FR-467, FR-468, FR-473, FR-474, NFR-53).
 *
 * The release-gated, network-observed proofs are PD-T12's (AC-411's request
 * volume, AC-403/AC-406's real bytes, AC-409's browser load failure) and the
 * accessible-name equality is PD-T11's AC-408. What is settled here is what
 * jsdom can settle honestly: which elements are in the tree.
 */

const PORTFOLIO_ID = "11111111-1111-1111-1111-111111111111";

function renderTile(props: Partial<Parameters<typeof PortfolioIconTile>[0]> = {}) {
  return render(
    (
      <PortfolioIconTile portfolioId={PORTFOLIO_ID} hasIcon={true} accentColor={null} {...props} />
    ) as ReactElement,
  );
}

describe("<PortfolioIconTile>", () => {
  it("renders no <img> at all when `hasIcon` is false — the request is not suppressed, it is never issuable", () => {
    renderTile({ hasIcon: false });
    // NFR-53/FR-467 as a structural fact: the element that would issue the
    // request is absent, so there is nothing to intercept and no `src` to
    // assert on. PD-T12's AC-411 measures the same claim at the network.
    expect(screen.queryByTestId("portfolio-icon-image")).toBeNull();
    expect(screen.getByTestId("portfolio-icon-box")).toBeInTheDocument();
  });

  it("points the <img> at the token-free, id-only route and names nothing", () => {
    renderTile();
    const img = screen.getByTestId("portfolio-icon-image");
    // Exact string: a `?v=` cache-buster would pass a `toContain` and break
    // the e2e spec's own route interception.
    expect(img.getAttribute("src")).toBe(portfolioIconUrl(PORTFOLIO_ID));
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to the wallet tile when the bytes fail to load, and recovers on the next version", () => {
    const view = renderTile({ iconVersion: 1 });
    fireEvent.error(screen.getByTestId("portfolio-icon-image"));
    expect(screen.queryByTestId("portfolio-icon-image")).toBeNull();

    // The correction: the failure belongs to the bytes that failed, not to
    // the portfolio forever. A bumped version must render an <img> again with
    // no reset effect anywhere.
    view.rerender(
      (
        <PortfolioIconTile
          portfolioId={PORTFOLIO_ID}
          hasIcon={true}
          accentColor={null}
          iconVersion={2}
        />
      ) as ReactElement,
    );
    expect(screen.getByTestId("portfolio-icon-image")).toBeInTheDocument();
  });

  it("emits no accent attribute and no inline style when the accent is unset (G2)", () => {
    renderTile({ hasIcon: false });
    const box = screen.getByTestId("portfolio-icon-box");
    expect(box.hasAttribute("data-accent")).toBe(false);
    expect(box.getAttribute("style")).toBeNull();
  });

  it("applies a set accent as a custom property on the box, never as a literal colour", () => {
    renderTile({ hasIcon: false, accentColor: "CHART_3" });
    const box = screen.getByTestId("portfolio-icon-box");
    expect(box).toHaveAttribute("data-accent", "CHART_3");
    // A `var(...)` reference, so the value stays in `kerdial.css` (L6: no new
    // colour enters the token file, so no contrast re-validation is owed).
    expect(box.style.getPropertyValue("--k-pf-accent")).toBe("var(--chart-3)");
  });
});
