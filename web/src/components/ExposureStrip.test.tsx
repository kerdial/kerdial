import { render, screen } from "@testing-library/react";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
import { computeAllocation } from "../lib/allocation.js";
import { allocationInputOf, exposureHoldingsOf } from "../lib/cash-position.js";
import {
  computeExposureBreakdown,
  countryClassifier,
  sectorClassifier,
} from "../lib/exposure-breakdown.js";
import type { HoldingResponse, HoldingsResponse } from "../lib/api-client.js";
import { ExposureStrip } from "./ExposureStrip.js";

/**
 * `ExposureStrip` — three stacked bars, Type · Pays · Secteur, shown at
 * once. What is pinned: no control to switch dimensions, every segment's width
 * is the apportioned share and its text is `percentageText` verbatim, « Non
 * classé » is the grey token on both classified dimensions, the country basis
 * is stated under its bar only, and the two `computeAllocation` guards
 * suppress the whole card with one note.
 */

function valued(amount: string, currency = "EUR") {
  return { amount, currency, provenance: { derivedFrom: [] } };
}

function holding(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    kind: "SHARE",
    displayName: "Air Liquide S.A.",
    symbol: null,
    sectorCode: SECTOR_CODES[0],
    domicileCountry: "FR",
    listingCountry: "FR",
    hasIcon: false,
    quantity: "10",
    currency: "EUR",
    pmp: valued("50.00"),
    costBasis: valued("500.00"),
    currentPrice: valued("60.00"),
    currentValue: valued("600.00"),
    unrealizedGainLoss: valued("100.00"),
    realizedGains: [],
    ...overrides,
  };
}

function response(holdings: readonly HoldingResponse[], total: string): HoldingsResponse {
  return {
    asOfDate: "2026-09-24",
    holdings,
    totalValue: valued(total),
    totalUnrealizedGainLoss: valued("0"),
    cash: { totalBase: "0", currency: "EUR", isNegative: false, unconverted: [], byCurrency: [] },
    calcEpoch: "1",
    portfolioCount: 1,
  };
}

function renderStrip(data: HoldingsResponse) {
  // The routes' own input: the holdings plus the « Liquidités » row when the
  // cash block is non-zero.
  const allocation = computeAllocation(allocationInputOf(data));
  return render(
    <ExposureStrip
      allocation={allocation}
      sectorBreakdown={computeExposureBreakdown(
        allocation,
        exposureHoldingsOf(data.holdings),
        sectorClassifier,
      )}
      countryBreakdown={computeExposureBreakdown(
        allocation,
        exposureHoldingsOf(data.holdings),
        countryClassifier,
      )}
    />,
  );
}

const TWO = response(
  [
    holding(),
    holding({
      instrumentId: "22222222-2222-2222-2222-222222222222",
      kind: "ETF",
      displayName: "MSCI World UCITS ETF",
      sectorCode: null,
      domicileCountry: "IE",
      listingCountry: "IE",
      currentValue: valued("400.00"),
    }),
  ],
  "1000.00",
);

describe("<ExposureStrip> — three bars at once", () => {
  it("draws Type, Pays and Secteur together, with no dimension control", () => {
    renderStrip(TWO);
    expect(screen.getByTestId("exposure-strip-kind")).toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-country")).toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-sector")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    // Three bars, each one accessible image named after its dimension.
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.getByRole("img", { name: "Pays" })).toBeInTheDocument();
  });

  it("gives each segment the apportioned share as its width and `percentageText` as its text — 60 % share, 40 % ETF", () => {
    renderStrip(TWO);
    const segments = screen
      .getAllByTestId("exposure-strip-segment")
      .filter((s) => s.closest("[data-testid='exposure-strip-kind']") !== null);
    expect(segments.map((s) => s.style.width)).toEqual(["60%", "40%"]);
    expect(screen.getByTestId("exposure-strip-percentage-SHARE")).toHaveTextContent("60.00%");
    expect(screen.getByTestId("exposure-strip-percentage-ETF")).toHaveTextContent("40.00%");
  });

  it("puts the ETF's whole value in the grey « Non classé » segment on both classified dimensions", () => {
    renderStrip(TWO);
    for (const dimension of ["sector", "country"]) {
      const pct = screen.getByTestId(
        `exposure-strip-bucket-percentage-${dimension}-__NON_CLASSE__`,
      );
      expect(pct).toHaveTextContent("40.00%");
      const segment = screen
        .getAllByTestId("exposure-strip-segment")
        .find(
          (s) =>
            s.getAttribute("data-kind") === "__NON_CLASSE__" &&
            s.closest(`[data-testid='exposure-strip-${dimension}']`) !== null,
        );
      expect(segment?.style.background).toBe("var(--chart-6)");
    }
    expect(screen.getByTestId("exposure-strip-buckets-sector")).toHaveTextContent("Non classé");
  });

  it("states the country basis under the Pays bar only, and never a spec or ticket reference in the copy", () => {
    renderStrip(TWO);
    const basis = screen.getByTestId("exposure-strip-basis");
    expect(basis).toHaveTextContent("Pays du siège social pour toutes les lignes");
    expect(screen.getByTestId("exposure-strip-country")).toContainElement(basis);
    expect(screen.getByTestId("exposure-strip").textContent ?? "").not.toMatch(/FR-\d|#\d/);
  });

  it("says once that the split is unavailable when no total can be established — no bars", () => {
    renderStrip(response([holding()], "0"));
    expect(screen.getByTestId("exposure-strip-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("exposure-strip-segment")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("<ExposureStrip> — the « Liquidités » type-bar segment", () => {
  function withCash(data: HoldingsResponse, totalBase: string): HoldingsResponse {
    return {
      ...data,
      cash: {
        totalBase,
        currency: "EUR",
        isNegative: totalBase.startsWith("-"),
        unconverted: [],
        byCurrency: [],
      },
    };
  }

  function kindBar() {
    return screen
      .getAllByTestId("exposure-strip-segment")
      .filter((s) => s.closest("[data-testid='exposure-strip-kind']") !== null);
  }

  it("AC-578: a « Liquidités » segment in --class-cash, last, and the segments sum to the whole total", () => {
    renderStrip(withCash(response([holding()], "1000.00"), "400.00"));
    const segments = kindBar();
    expect(segments.map((s) => s.getAttribute("data-kind"))).toEqual(["SHARE", "CASH"]);
    expect(segments.map((s) => s.style.width)).toEqual(["60%", "40%"]);
    expect(segments[1]!.style.background).toBe("var(--class-cash)");
    expect(screen.getByTestId("exposure-strip-subtotals")).toHaveTextContent("Liquidités");
    expect(screen.getByTestId("exposure-strip-percentage-CASH")).toHaveTextContent("40.00%");
    // C-13: on the classified dimensions the cash is « Non classé », so they still sum to 100 %.
    expect(
      screen.getByTestId("exposure-strip-bucket-percentage-country-__NON_CLASSE__"),
    ).toHaveTextContent("40.00%");
    expect(screen.getByTestId("exposure-strip-bucket-percentage-country-FR")).toHaveTextContent(
      "60.00%",
    );
  });

  it("AC-572: negative cash keeps its signed legend entry but draws no segment, and the bar stays full", () => {
    renderStrip(
      withCash(response([holding({ currentValue: valued("200.00") })], "150.00"), "-50.00"),
    );
    const segments = kindBar();
    expect(segments.map((s) => s.getAttribute("data-kind"))).toEqual(["SHARE"]);
    expect(segments[0]!.style.width).toBe("100%");
    expect(screen.getByTestId("exposure-strip-percentage-CASH")).toHaveTextContent("\u221233.33%");
  });

  it("AC-573: zero cash yields no « Liquidités » segment or legend entry", () => {
    renderStrip(TWO);
    expect(screen.queryByTestId("exposure-strip-percentage-CASH")).not.toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-subtotals")).not.toHaveTextContent("Liquidités");
  });
});
