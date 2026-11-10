import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindSubtotals } from "./KindSubtotals.js";

describe("<KindSubtotals> — UR-12", () => {
  it("renders nothing when subtotals is empty (allocation.ts's own suppression contract)", () => {
    const { container } = render(<KindSubtotals subtotals={[]} testIdPrefix="test" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one row per kind subtotal, kind-labelled only (no sector/region wording)", () => {
    render(
      <KindSubtotals
        subtotals={[
          { kind: "SHARE", percentageText: "60.00%" },
          { kind: "ETF", percentageText: "40.00%" },
        ]}
        testIdPrefix="holdings-summary"
      />,
    );
    const rows = screen.getAllByTestId("holdings-summary-kind-subtotal-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("SHARE");
    expect(rows[0]).toHaveTextContent("60.00%");
    expect(rows[1]).toHaveTextContent("ETF");
    expect(rows[1]).toHaveTextContent("40.00%");
  });

  it("scopes its data-testid root to the given prefix — two instances of the same data never collide", () => {
    render(
      <>
        <KindSubtotals
          subtotals={[{ kind: "SHARE", percentageText: "100.00%" }]}
          testIdPrefix="a"
        />
        <KindSubtotals
          subtotals={[{ kind: "SHARE", percentageText: "100.00%" }]}
          testIdPrefix="b"
        />
      </>,
    );
    expect(screen.getByTestId("a-kind-subtotals")).toBeInTheDocument();
    expect(screen.getByTestId("b-kind-subtotals")).toBeInTheDocument();
  });

  it("labels the « Liquidités » line through the class chip, in --class-cash, with its signed share", () => {
    render(
      <KindSubtotals
        subtotals={[
          { kind: "SHARE", percentageText: "133.33%" },
          { kind: "CASH", percentageText: "\u221233.33%" },
        ]}
        testIdPrefix="holdings-summary"
      />,
    );
    const rows = screen.getAllByTestId("holdings-summary-kind-subtotal-row");
    expect(rows[1]).toHaveTextContent("Liquidités");
    expect(rows[1]).toHaveTextContent("\u221233.33%");
    expect(rows[1]!.querySelector<HTMLElement>(".k-class-chip-dot")?.style.background).toBe(
      "var(--class-cash)",
    );
    // The instrument kinds keep their wire code.
    expect(rows[0]).toHaveTextContent("SHARE");
  });
});
