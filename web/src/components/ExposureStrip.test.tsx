import { render, screen } from "@testing-library/react";
import { SECTOR_CODES } from "@kerdial/core-reference-data";
import { describe, expect, it } from "vitest";
import { computeAllocation } from "../lib/allocation.js";
import { allocationInputOf, exposureHoldingsOf } from "../lib/cash-position.js";
import {
  CASH,
  UNCLASSIFIED,
  computeExposureBreakdown,
  countryDimension,
  sectorDimension,
} from "../lib/exposure-breakdown.js";
import { OTHER } from "../lib/exposure-display.js";
import { securitiesAllocationInputOf } from "../lib/exposure-scope.js";
import type { HoldingResponse, HoldingsResponse } from "../lib/api-client.js";
import { ExposureStrip } from "./ExposureStrip.js";

/**
 * `ExposureStrip` — three stacked bars, Type · Pays · Secteur, shown at
 * once. What is pinned: no control to switch dimensions, every segment's width
 * is the apportioned share and its text is `percentageText` verbatim, « Non
 * classé » is the grey token on both classified dimensions, « Liquidités » is
 * its own bucket in the cash token there, the country basis is stated under
 * its bar only, hand-entered weights carry their note, and the two
 * `computeAllocation` guards suppress the whole card with one note.
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
  // …and the securities' own apportionment, which the two breakdowns regroup.
  const securities = computeAllocation(securitiesAllocationInputOf(data));
  return render(
    <ExposureStrip
      allocation={allocation}
      sectorBreakdown={computeExposureBreakdown(
        securities,
        exposureHoldingsOf(data.holdings),
        sectorDimension,
      )}
      countryBreakdown={computeExposureBreakdown(
        securities,
        exposureHoldingsOf(data.holdings),
        countryDimension,
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

  it("titles the Pays and Secteur bars with what they break down, and puts no sentence under any bar", () => {
    renderStrip(TWO);
    for (const dimension of ["sector", "country"] as const) {
      expect(screen.getByTestId(`exposure-strip-${dimension}-scope`)).toHaveTextContent(
        "actions, ETF et fonds",
      );
    }
    expect(screen.queryByTestId("exposure-strip-kind-scope")).not.toBeInTheDocument();
    // Nothing but the title, the bar and the legend in each dimension.
    const strip = screen.getByTestId("exposure-strip");
    expect(strip.querySelector(".ov-note")).toBeNull();
    expect(strip.textContent ?? "").not.toMatch(/siège social|cotation|saisie/i);
    expect(strip.textContent ?? "").not.toMatch(/FR-\d|#\d/);
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
    // The country bar breaks down the securities alone: no cash there, and
    // the one share is all of it.
    expect(
      screen.queryByTestId(`exposure-strip-bucket-percentage-country-${CASH}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`exposure-strip-bucket-percentage-country-${UNCLASSIFIED}`),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("exposure-strip-bucket-percentage-country-FR")).toHaveTextContent(
      "100.00%",
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

function withCashBlock(data: HoldingsResponse, totalBase: string): HoldingsResponse {
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

function legendLabels(dimension: "sector" | "country"): readonly string[] {
  return Array.from(
    screen
      .getByTestId(`exposure-strip-buckets-${dimension}`)
      .querySelectorAll(`[data-testid='exposure-strip-${dimension}-label']`),
    (label) => label.textContent ?? "",
  );
}

function barSegments(dimension: "sector" | "country") {
  return screen
    .getAllByTestId("exposure-strip-segment")
    .filter((s) => s.closest(`[data-testid='exposure-strip-${dimension}']`) !== null);
}

const ETF_ID = "33333333-3333-3333-3333-333333333333";

function etf(overrides: Partial<HoldingResponse> = {}): HoldingResponse {
  return holding({
    instrumentId: ETF_ID,
    kind: "ETF",
    displayName: "World Equity UCITS ETF",
    sectorCode: null,
    domicileCountry: "IE",
    listingCountry: "IE",
    ...overrides,
  });
}

const CRYPTO_HOLDING = holding({
  instrumentId: "99999999-9999-9999-9999-999999999999",
  kind: "CRYPTO",
  displayName: "Bitcoin",
  sectorCode: null,
  domicileCountry: null,
  listingCountry: null,
});

describe("<ExposureStrip> — Pays and Secteur break down shares, ETFs and funds only", () => {
  it("leaves cash and crypto out of both bars and shares the securities over their own total", () => {
    // SHARE 500 (FR) + unweighted ETF 300 + crypto 100 + cash 100 = 1 000.
    // Of the 800 of securities: 62.50 / 37.50 — not 50 / 30 of the portfolio.
    renderStrip(
      withCashBlock(
        response(
          [
            holding({ currentValue: valued("500.00") }),
            etf({ currentValue: valued("300.00") }),
            { ...CRYPTO_HOLDING, currentValue: valued("100.00") },
          ],
          "1000.00",
        ),
        "100.00",
      ),
    );
    expect(legendLabels("country")).toEqual(["France", "Non classé"]);
    expect(legendLabels("sector")).toHaveLength(2);
    for (const dimension of ["sector", "country"] as const) {
      expect(legendLabels(dimension).at(-1)).toBe("Non classé");
      expect(
        screen.getByTestId(`exposure-strip-bucket-percentage-${dimension}-${UNCLASSIFIED}`),
      ).toHaveTextContent("37.50%");
      expect(
        screen.queryByTestId(`exposure-strip-bucket-percentage-${dimension}-${CASH}`),
      ).not.toBeInTheDocument();
      expect(barSegments(dimension).map((s) => s.style.width)).toEqual(["62.5%", "37.5%"]);
    }
    expect(screen.getByTestId("exposure-strip-bucket-percentage-country-FR")).toHaveTextContent(
      "62.50%",
    );
    // The type bar still shows the whole portfolio.
    expect(screen.getByTestId("exposure-strip-percentage-SHARE")).toHaveTextContent("50.00%");
    expect(screen.getByTestId("exposure-strip-percentage-CRYPTO")).toHaveTextContent("10.00%");
    expect(screen.getByTestId("exposure-strip-subtotals")).toHaveTextContent("Liquidités");
  });

  it("leaves an SCPI out too, even one with country weights", () => {
    renderStrip(
      response(
        [
          holding({ currentValue: valued("500.00") }),
          holding({
            instrumentId: "55555555-5555-5555-5555-555555555555",
            kind: "SCPI",
            sectorCode: null,
            domicileCountry: null,
            listingCountry: null,
            currentValue: valued("500.00"),
            countryWeights: [{ code: "DE", weight: "100.00" }],
          }),
        ],
        "1000.00",
      ),
    );
    expect(legendLabels("country")).toEqual(["France"]);
    expect(screen.getByTestId("exposure-strip-bucket-percentage-country-FR")).toHaveTextContent(
      "100.00%",
    );
  });

  it("says there is nothing to break down, in place of both bars, when no share, ETF or fund is held", () => {
    renderStrip(
      withCashBlock(
        response([{ ...CRYPTO_HOLDING, currentValue: valued("600.00") }], "1000.00"),
        "400.00",
      ),
    );
    for (const dimension of ["sector", "country"] as const) {
      expect(screen.getByTestId(`exposure-strip-${dimension}-empty`)).toHaveTextContent(
        "Aucune action, aucun ETF ni fonds en portefeuille.",
      );
      expect(screen.queryByTestId(`exposure-strip-buckets-${dimension}`)).not.toBeInTheDocument();
    }
    // The type bar is unaffected.
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByTestId("exposure-strip-percentage-CRYPTO")).toHaveTextContent("60.00%");
  });
});

describe("<ExposureStrip> — hand-entered weights", () => {
  it("splits a weighted ETF across its countries and says nothing about it under the bar", () => {
    renderStrip(
      response(
        [
          holding(),
          etf({
            currentValue: valued("400.00"),
            countryWeights: [
              { code: "US", weight: "60.00" },
              { code: "JP", weight: "40.00" },
            ],
            sectorWeights: [{ code: SECTOR_CODES[1], weight: "50.00" }],
          }),
        ],
        "1000.00",
      ),
    );
    expect(legendLabels("country")).toEqual(["France", "États-Unis", "Japon"]);
    expect(screen.getByTestId("exposure-strip-bucket-percentage-country-US")).toHaveTextContent(
      "24.00%",
    );
    expect(
      screen.getByTestId(`exposure-strip-bucket-percentage-sector-${UNCLASSIFIED}`),
    ).toHaveTextContent("20.00%");
    expect(screen.getByTestId("exposure-strip").querySelector(".ov-note")).toBeNull();
  });

  it("AC-631: an unweighted ETF alone is « Non classé » in full on both bars, with no note, placeholder or pending wording", () => {
    renderStrip(response([etf({ currentValue: valued("1000.00") })], "1000.00"));
    for (const dimension of ["sector", "country"] as const) {
      expect(legendLabels(dimension)).toEqual(["Non classé"]);
      expect(
        screen.getByTestId(`exposure-strip-bucket-percentage-${dimension}-${UNCLASSIFIED}`),
      ).toHaveTextContent("100.00%");
    }
    const text = screen.getByTestId("exposure-strip").textContent ?? "";
    expect(text).not.toMatch(/bientôt|à venir|en attente|chargement/i);
    expect(screen.getByTestId("exposure-strip").querySelector("[aria-busy='true']")).toBeNull();
  });
});

describe("<ExposureStrip> — short legends: « Autres » on the sector and country bars", () => {
  it("names five countries of seven, then « Autres », then « Non classé »", () => {
    const codes = ["FR", "US", "DE", "JP", "GB", "CH", "IT"];
    const sharesByCountry = codes.map((code, index) =>
      holding({
        instrumentId: `00000000-0000-0000-0000-00000000000${String(index)}`,
        domicileCountry: code,
        listingCountry: code,
        // 70, 60, …, 10: 280 in all.
        currentValue: valued(`${String((codes.length - index) * 10)}.00`),
      }),
    );
    // + unweighted ETF 120 = 400 of securities.
    renderStrip(response([...sharesByCountry, etf({ currentValue: valued("120.00") })], "400.00"));
    expect(legendLabels("country").slice(-2)).toEqual(["Autres", "Non classé"]);
    expect(legendLabels("country")).toHaveLength(7);
    // CH 20 + IT 10 of 400.
    expect(
      screen.getByTestId(`exposure-strip-bucket-percentage-country-${OTHER}`),
    ).toHaveTextContent("7.50%");
    expect(
      screen.getByTestId(`exposure-strip-bucket-percentage-country-${UNCLASSIFIED}`),
    ).toHaveTextContent("30.00%");
  });
});
