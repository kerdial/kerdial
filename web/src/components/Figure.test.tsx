import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Figure, type ValuedAmount } from "./Figure.js";

/**
 * T-43 acceptance criteria, verified one-to-one below.
 * `Figure.tsx`'s own doc header explains the `ValuedAmount`/formatter seams
 * this suite assumes.
 */

function valuedAmount(
  overrides: Partial<ValuedAmount["provenance"]> = {},
  amount = "1234.5",
): ValuedAmount {
  return {
    amount,
    currency: "EUR",
    provenance: {
      derivedFrom: ["AUTOMATED"],
      ...overrides,
    },
  };
}

/**
 * `Figure` renders a bare `Tooltip.Root`/`Trigger` — the single
 * `Tooltip.Provider` lives at the app root (`AppShell.tsx`), not per-`Figure`
 * (security review). Every test below except the one deliberately
 * proving that (the "Tooltip.Provider lives at the app root" suite) renders
 * through this ancestor instead of a bare `render`, so a test adding a
 * tooltip-worthy provenance field (`priceSource`/`priceAsOf`/
 * `fxRateObservedOn`) later never silently breaks on a missing provider.
 */
function renderWithProvider(ui: ReactElement) {
  return render(<Tooltip.Provider delayDuration={200}>{ui}</Tooltip.Provider>);
}

describe("<Figure> — manual-data badge (AC29 positive/negative)", () => {
  it('renders the "M" badge when derivedFrom includes MANUAL_PRICE', () => {
    renderWithProvider(
      <Figure value={valuedAmount({ derivedFrom: ["MANUAL_PRICE"] })} scale={2} />,
    );
    expect(screen.getByTestId("figure-badge-manual")).toBeInTheDocument();
  });

  it("renders no manual-data badge when derivedFrom is only AUTOMATED", () => {
    renderWithProvider(<Figure value={valuedAmount({ derivedFrom: ["AUTOMATED"] })} scale={2} />);
    expect(screen.queryByTestId("figure-badge-manual")).not.toBeInTheDocument();
  });
});

describe("<Figure> — pinned-FX badge (AC51, FR-65)", () => {
  it("renders the pin badge when fxSource is USER_PINNED", () => {
    renderWithProvider(
      <Figure
        value={valuedAmount({ derivedFrom: ["PINNED_FX"], fxSource: "USER_PINNED" })}
        scale={2}
      />,
    );
    expect(screen.getByTestId("figure-badge-pinned-fx")).toBeInTheDocument();
  });

  it("renders no pin badge when fxSource is PROVIDER", () => {
    renderWithProvider(
      <Figure
        value={valuedAmount({ derivedFrom: ["AUTOMATED"], fxSource: "PROVIDER" })}
        scale={2}
      />,
    );
    expect(screen.queryByTestId("figure-badge-pinned-fx")).not.toBeInTheDocument();
  });

  // Security review F1 (T-43): the aggregation case, mirroring the manual-
  // data aggregate test above. `aggregateStaleness` (valuation/src/holdings-
  // valuation.ts) only carries `priceAsOf`/`priceIsStale` up to a portfolio
  // total's provenance — `fxSource` is dropped — so a total derived from one
  // user-pinned-FX holding has `fxSource: undefined` and signals the pin
  // *only* via the merged `derivedFrom` set carrying `PINNED_FX` (`PINNED_FX`
  // has exactly two producers, `buildFxFlags` and `mapFxRateSourceToFlags`,
  // both gated identically on `"USER_PINNED"` — holdings-valuation.ts:372
  // and :389 — so this is a safe, not a loosened, condition).
  it("renders the pin badge for an aggregate figure: derivedFrom has PINNED_FX but fxSource is undefined", () => {
    renderWithProvider(<Figure value={valuedAmount({ derivedFrom: ["PINNED_FX"] })} scale={2} />);
    expect(screen.getByTestId("figure-badge-pinned-fx")).toBeInTheDocument();
  });

  // Carry-forward from T-43's review (T-44): the negative
  // case for `mapFxRateSourceToFlags` (holdings-valuation.ts:389), the
  // *second* PINNED_FX producer — proves it is gated identically to
  // `buildFxFlags`, not merely documented as such. `CARRIED_FX` (a plain
  // LOCF carry-forward) must not, by itself, be mistaken for a pin.
  it("renders no pin badge when fxSource is PROVIDER even though derivedFrom carries CARRIED_FX", () => {
    renderWithProvider(
      <Figure
        value={valuedAmount({ derivedFrom: ["CARRIED_FX"], fxSource: "PROVIDER" })}
        scale={2}
      />,
    );
    expect(screen.queryByTestId("figure-badge-pinned-fx")).not.toBeInTheDocument();
  });
});

describe("<Figure> — AC29's negative clause, concretely on a crypto figure", () => {
  it("a CoinGecko-sourced crypto figure derived solely from AUTOMATED renders no badge at all", () => {
    renderWithProvider(
      <Figure
        value={valuedAmount({ derivedFrom: ["AUTOMATED"], priceSource: "coingecko" })}
        kind="quantity"
      />,
    );
    const figure = screen.getByTestId("figure");
    expect(figure.querySelector("[data-testid^='figure-badge-']")).toBeNull();
  });
});

describe("<Figure> — manual/pinned vs delayed badge treatments are structurally distinct", () => {
  it("renders different testids, classNames, and glyphs for manual vs delayed", () => {
    const { container: manualContainer } = renderWithProvider(
      <Figure value={valuedAmount({ derivedFrom: ["MANUAL_PRICE"] })} scale={2} />,
    );
    const { container: delayedContainer } = renderWithProvider(
      <Figure value={valuedAmount({ derivedFrom: ["DELAYED_QUOTE"] })} scale={2} />,
    );

    const manualBadge = manualContainer.querySelector('[data-testid="figure-badge-manual"]');
    const delayedBadge = delayedContainer.querySelector('[data-testid="figure-badge-delayed"]');
    expect(manualBadge).not.toBeNull();
    expect(delayedBadge).not.toBeNull();

    // Structurally distinct: different testid, different className (colour),
    // different textContent (glyph) — never the same badge markup reused
    // with only a colour swap, so this is a real structural difference, not
    // a coincidental one.
    expect(manualBadge!.getAttribute("data-testid")).not.toBe(
      delayedBadge!.getAttribute("data-testid"),
    );
    expect(manualBadge!.className).not.toBe(delayedBadge!.className);
    expect(manualBadge!.textContent).not.toBe(delayedBadge!.textContent);
    expect(manualBadge!.getAttribute("aria-label")).not.toBe(
      delayedBadge!.getAttribute("aria-label"),
    );
  });

  // Reviewer quality note: a bare `<span aria-label>` is not reliably
  // announced by assistive tech (a `span` has no implicit ARIA role, so
  // several browser/AT combinations never expose its `aria-label` at all).
  // Every badge needs `role="img"` so the label is exposed regardless.
  it('every badge exposes role="img" so its aria-label is reliably announced', () => {
    renderWithProvider(
      <Figure
        value={valuedAmount({
          derivedFrom: ["MANUAL_PRICE", "DELAYED_QUOTE", "PINNED_FX"],
        })}
        scale={2}
      />,
    );
    expect(screen.getByTestId("figure-badge-manual")).toHaveAttribute("role", "img");
    expect(screen.getByTestId("figure-badge-delayed")).toHaveAttribute("role", "img");
    expect(screen.getByTestId("figure-badge-pinned-fx")).toHaveAttribute("role", "img");
  });

  it("both badges can render simultaneously without merging into one element", () => {
    renderWithProvider(
      <Figure value={valuedAmount({ derivedFrom: ["MANUAL_PRICE", "DELAYED_QUOTE"] })} scale={2} />,
    );
    expect(screen.getByTestId("figure-badge-manual")).toBeInTheDocument();
    expect(screen.getByTestId("figure-badge-delayed")).toBeInTheDocument();
  });
});

describe("<Figure> — priceIsStale amber treatment is independent of the badge set", () => {
  it("applies the amber treatment class when priceIsStale is true", () => {
    renderWithProvider(
      <Figure value={valuedAmount({ derivedFrom: ["AUTOMATED"], priceIsStale: true })} scale={2} />,
    );
    const valueNode = screen.getByTestId("figure").firstElementChild;
    // The class name moved onto the token layer (`k-figure-stale`,
    // which resolves to --warn-700). The assertion's intent is unchanged: a
    // stale price gets its own visual treatment, distinct from the badge set.
    expect(valueNode?.className).toMatch(/k-figure-stale/);
  });
});

describe("<Figure> — malformed amount never blanks the route (security review F2)", () => {
  // `parseDecimalString` (@kerdial/core-decimal) throws a `RangeError` on
  // "Infinity"/"NaN"/exponential notation — reachable today from an
  // unguarded server-side Decimal division with no runtime response
  // validation in front of it. An uncaught render-time throw would blank the
  // *entire* route via the router's CatchBoundary (one bad figure taking
  // down a whole page of otherwise-good ones), so `Figure` must catch it
  // locally and degrade to a single "unavailable" cell.
  it('renders an em dash with aria-label "Valeur indisponible" instead of throwing, for amount: "Infinity"', () => {
    renderWithProvider(
      <Figure value={valuedAmount({ derivedFrom: ["AUTOMATED"] }, "Infinity")} scale={2} />,
    );
    const figure = screen.getByTestId("figure");
    expect(figure.textContent).toContain("—");
    expect(screen.getByLabelText("Valeur indisponible")).toBeInTheDocument();
  });

  it("a malformed sibling figure does not prevent a valid Figure from rendering (scoped failure)", () => {
    renderWithProvider(
      <div>
        <Figure value={valuedAmount({ derivedFrom: ["AUTOMATED"] }, "NaN")} scale={2} />
        <Figure value={valuedAmount()} scale={2} />
      </div>,
    );
    expect(screen.getByLabelText("Valeur indisponible")).toBeInTheDocument();
    expect(screen.getByText("1 234.50 EUR")).toBeInTheDocument();
  });

  // Carry-forward from T-43's review (T-44): a genuinely
  // malformed amount is still swallowed into the "—" placeholder (the test
  // above), but it must not be *silent* — a DEV-only `console.warn` fires so
  // a developer can see it during local/dev testing.
  it("warns via console.warn (DEV only) when an amount fails to format", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderWithProvider(
        <Figure value={valuedAmount({ derivedFrom: ["AUTOMATED"] }, "NaN")} scale={2} />,
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("<Figure>");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("<Figure> — a bad scale fails loudly instead of silently em-dashing (T-43 review carry-forward)", () => {
  it("throws (does not render an em dash) when scale is not an integer", () => {
    expect(() => renderWithProvider(<Figure value={valuedAmount()} scale={1.5} />)).toThrow(
      RangeError,
    );
  });

  it("throws when scale is negative", () => {
    expect(() => renderWithProvider(<Figure value={valuedAmount()} scale={-1} />)).toThrow(
      RangeError,
    );
  });

  it("throws when scale is null (a caller bug, not a hostile server value)", () => {
    expect(() =>
      renderWithProvider(<Figure value={valuedAmount()} scale={null as unknown as number} />),
    ).toThrow(RangeError);
  });

  it("does not throw for a non-monetary kind even with a bad scale (scale is ignored there)", () => {
    expect(() =>
      renderWithProvider(
        <Figure value={valuedAmount()} kind="quantity" scale={null as unknown as number} />,
      ),
    ).not.toThrow();
  });
});

describe("<Figure> — Tooltip.Provider lives at the app root (AppShell), not per-Figure", () => {
  // Reviewer quality note (T-45 consumes this next, in a virtualised table):
  // a `Tooltip.Provider` instantiated per-`<Figure>` means per-cell hover
  // delays never coordinate with each other. `Figure` renders a bare
  // `Tooltip.Root`/`Trigger` and now *requires* an ancestor
  // `Tooltip.Provider` — `AppShell.tsx` supplies the single, app-wide one;
  // tests supply their own (`renderWithProvider`) since RTL never mounts
  // `AppShell`.
  it("renders a figure with tooltip-worthy provenance given an ancestor Tooltip.Provider", () => {
    renderWithProvider(
      <Figure
        value={valuedAmount({ derivedFrom: ["AUTOMATED"], priceSource: "euronext" })}
        scale={2}
      />,
    );
    expect(screen.getByTestId("figure")).toBeInTheDocument();
  });

  // Carry-forward from T-43's review (T-44): this fixture has
  // no tooltip-worthy field at all (`derivedFrom: ["AUTOMATED"]`, no
  // `priceSource`/`priceAsOf`/`fxRateObservedOn`) — proving the missing-
  // Provider throw fires unconditionally, not only for fixtures whose
  // provenance happens to be tooltip-worthy (before this fix, `Tooltip.Root`
  // was only mounted when `buildTooltipLines` returned a non-empty array, so
  // this exact fixture would have rendered successfully with no throw at
  // all).
  it("throws without an ancestor Tooltip.Provider, regardless of the fixture's provenance", () => {
    expect(() => render(<Figure value={valuedAmount()} scale={2} />)).toThrow(/TooltipProvider/);
  });
});

describe("<Figure> — formats exclusively via @kerdial/core-decimal (T-4)", () => {
  it("renders the shared formatter's output, not a re-implemented rounding", () => {
    renderWithProvider(<Figure value={valuedAmount()} scale={2} />);
    // formatMonetary(new Decimal("1234.5"), 2) === "1234.50" — proves the
    // component actually calls through to T-4's formatter rather than
    // rendering the raw wire string verbatim.
    expect(screen.getByTestId("figure").textContent).toContain("1\u202f234.50");
  });

  it("AC5 — no local toFixed/Number() call exists in Figure.tsx's own source", () => {
    const sourcePath = resolve(process.cwd(), "web/src/components/Figure.tsx");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/\.toFixed\(/);
    expect(source).not.toMatch(/\bNumber\(/);
  });
});

describe("<Figure> — the aggregate summary tooltip (AR-24, ADR-0010)", () => {
  // Radix `Tooltip.Content` measures itself with `ResizeObserver`, which
  // jsdom does not provide — a minimal inert shim is enough for the content
  // to mount so its text can be asserted.
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const aggregate = (summary: Partial<NonNullable<ValuedAmount["provenance"]["summary"]>>) =>
    valuedAmount({
      derivedFrom: ["MANUAL_PRICE", "CARRIED_FX"],
      priceAsOf: "2026-08-14",
      priceIsStale: false,
      summary: {
        sources: ["ecb", "manual", "yahoo"],
        oldestObservationAt: "2026-08-14",
        newestObservationAt: "2026-08-28",
        staleInputCount: 1,
        manualInputCount: 2,
        pinnedFxPresent: false,
        carriedFxPresent: true,
        leafCount: 12,
        complete: true,
        derivedFrom: ["MANUAL_PRICE", "CARRIED_FX"],
        ...summary,
      },
    });

  it("renders the summary's counted lines instead of a singular source label standing for many inputs", async () => {
    renderWithProvider(<Figure value={aggregate({})} scale={2} />);
    // Radix opens on trigger focus with no hover delay — the jsdom-friendly
    // way to materialise `Tooltip.Content` without a pointer-event shim.
    fireEvent.focus(screen.getByTestId("figure"));
    const tooltip = await screen.findByTestId("figure-tooltip");

    expect(tooltip.textContent).toContain("3 sources : ecb, manual, yahoo");
    expect(tooltip.textContent).toContain("2 saisies manuelles sur 12");
    expect(tooltip.textContent).toContain("1 donnée périmée sur 12");
    expect(tooltip.textContent).toContain("Taux de change reporté depuis le 14/08/2026");
    expect(tooltip.textContent).toContain("Observations du 14/08/2026 au 28/08/2026");
    // The singular leaf line must NOT appear — an aggregate never claims one
    // source for many inputs (the exit criterion this component closes).
    expect(tooltip.textContent).not.toContain("Source : ecb");
  });

  it("a zero count is silence, not '0 sur 12'", async () => {
    renderWithProvider(
      <Figure
        value={aggregate({ staleInputCount: 0, manualInputCount: 0, carriedFxPresent: false })}
        scale={2}
      />,
    );
    fireEvent.focus(screen.getByTestId("figure"));
    const tooltip = await screen.findByTestId("figure-tooltip");

    expect(tooltip.textContent).not.toContain("sur 12");
    expect(tooltip.textContent).not.toContain("périmée");
    expect(tooltip.textContent).not.toContain("reporté");
  });

  it("the badges still key off the merged derivedFrom — the summary changes the tooltip, never the badge rules", () => {
    renderWithProvider(<Figure value={aggregate({})} scale={2} />);
    expect(screen.getByTestId("figure-badge-manual")).toBeInTheDocument();
    expect(screen.queryByTestId("figure-badge-pinned-fx")).not.toBeInTheDocument();
  });
});
