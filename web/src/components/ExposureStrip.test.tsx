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
  return render(
    <ExposureStrip
      allocation={allocation}
      sectorBreakdown={computeExposureBreakdown(
        allocation,
        exposureHoldingsOf(data.holdings),
        sectorDimension,
      )}
      countryBreakdown={computeExposureBreakdown(
        allocation,
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
    // FR-745: on the classified dimensions the cash is its own « Liquidités »
    // bucket, not « Non classé », so they still sum to 100 %.
    expect(
      screen.getByTestId(`exposure-strip-bucket-percentage-country-${CASH}`),
    ).toHaveTextContent("40.00%");
    expect(
      screen.queryByTestId(`exposure-strip-bucket-percentage-country-${UNCLASSIFIED}`),
    ).not.toBeInTheDocument();
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

describe("<ExposureStrip> — « Liquidités » on the sector and country bars (FR-745, AC-649)", () => {
  it("draws the cash as its own « Liquidités » bucket in the cash token, after « Non classé », on both bars", () => {
    // SHARE 500 (FR) + unweighted ETF 300 + cash 200 = 1 000: 50.00 / 30.00 / 20.00 on both bars.
    renderStrip(
      withCashBlock(
        response(
          [holding({ currentValue: valued("500.00") }), etf({ currentValue: valued("300.00") })],
          "1000.00",
        ),
        "200.00",
      ),
    );
    for (const dimension of ["sector", "country"] as const) {
      expect(legendLabels(dimension).slice(-2)).toEqual(["Non classé", "Liquidités"]);
      expect(
        screen.getByTestId(`exposure-strip-bucket-percentage-${dimension}-${CASH}`),
      ).toHaveTextContent("20.00%");
      expect(
        screen.getByTestId(`exposure-strip-bucket-percentage-${dimension}-${UNCLASSIFIED}`),
      ).toHaveTextContent("30.00%");
      const cash = barSegments(dimension).find((s) => s.getAttribute("data-kind") === CASH);
      expect(cash?.style.background).toBe("var(--class-cash)");
      expect(cash?.style.width).toBe("20%");
    }
  });

  it("shows no « Liquidités » bucket on either bar when the portfolio has no cash", () => {
    renderStrip(TWO);
    for (const dimension of ["sector", "country"] as const) {
      expect(legendLabels(dimension)).not.toContain("Liquidités");
      expect(
        screen.queryByTestId(`exposure-strip-bucket-percentage-${dimension}-${CASH}`),
      ).not.toBeInTheDocument();
    }
  });

  it("negative cash keeps its signed « Liquidités » entry on the country bar, draws no segment, and the bar stays full", () => {
    // SHARE 200 (FR), cash −50, total 150: FR 13 333 units, cash −3 333.
    renderStrip(
      withCashBlock(response([holding({ currentValue: valued("200.00") })], "150.00"), "-50.00"),
    );
    expect(
      screen.getByTestId(`exposure-strip-bucket-percentage-country-${CASH}`),
    ).toHaveTextContent("−33.33%");
    const segments = barSegments("country");
    expect(segments.map((s) => s.getAttribute("data-kind"))).toEqual(["FR"]);
    expect(segments[0]!.style.width).toBe("100%");
  });
});

describe("<ExposureStrip> — hand-entered weights (FR-730, FR-731, AC-627, AC-631)", () => {
  const WEIGHTED_SENTENCE =
    "Répartition par pays saisie manuellement pour toutes les lignes classées";
  const MIXED_SENTENCE = "Pays du siège social lorsqu'il est connu, sinon pays de cotation";
  const MIXED_WEIGHTED_SENTENCE =
    "Pays du siège social, pays de cotation ou répartition saisie manuellement, selon la ligne";
  const NOTE =
    "Pondérations saisies manuellement pour certains instruments — ce ne sont pas des données vérifiées.";

  const countryWeights = [
    { code: "US", weight: "60.00" },
    { code: "JP", weight: "40.00" },
  ];

  it("states the weighted basis, never a domicile sentence, for a portfolio placed by weights only — and notes it on that bar alone", () => {
    renderStrip(response([etf({ currentValue: valued("1000.00"), countryWeights })], "1000.00"));
    expect(screen.getByTestId("exposure-strip-basis").textContent).toBe(WEIGHTED_SENTENCE);
    expect(screen.getByTestId("exposure-strip-weighted-note-country").textContent).toBe(NOTE);
    // The ETF has no sector set: whole in « Non classé » there, and no note.
    expect(screen.queryByTestId("exposure-strip-weighted-note-sector")).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`exposure-strip-bucket-percentage-sector-${UNCLASSIFIED}`),
    ).toHaveTextContent("100.00%");
  });

  it("keeps today's exact MIXED sentence when no weight is involved, with no note anywhere", () => {
    renderStrip(
      response(
        [
          holding(),
          holding({
            instrumentId: "44444444-4444-4444-4444-444444444444",
            domicileCountry: null,
            listingCountry: "DE",
            currentValue: valued("400.00"),
          }),
        ],
        "1000.00",
      ),
    );
    expect(screen.getByTestId("exposure-strip-basis").textContent).toBe(MIXED_SENTENCE);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("says a weighted MIXED in its own words — domicile beside weights", () => {
    renderStrip(
      response([holding(), etf({ currentValue: valued("400.00"), countryWeights })], "1000.00"),
    );
    expect(screen.getByTestId("exposure-strip-basis").textContent).toBe(MIXED_WEIGHTED_SENTENCE);
    expect(screen.getByTestId("exposure-strip-weighted-note-country").textContent).toBe(NOTE);
  });

  it("notes the sector bar when a sector weight set placed a holding", () => {
    renderStrip(
      response(
        [
          etf({
            currentValue: valued("1000.00"),
            sectorWeights: [{ code: SECTOR_CODES[1], weight: "50.00" }],
          }),
        ],
        "1000.00",
      ),
    );
    expect(screen.getByTestId("exposure-strip-weighted-note-sector").textContent).toBe(NOTE);
    expect(screen.queryByTestId("exposure-strip-weighted-note-country")).not.toBeInTheDocument();
  });

  it("AC-631: an unweighted ETF alone is « Non classé » in full on both bars, with no note, placeholder or pending wording", () => {
    renderStrip(response([etf({ currentValue: valued("1000.00") })], "1000.00"));
    for (const dimension of ["sector", "country"] as const) {
      expect(legendLabels(dimension)).toEqual(["Non classé"]);
      expect(
        screen.getByTestId(`exposure-strip-bucket-percentage-${dimension}-${UNCLASSIFIED}`),
      ).toHaveTextContent("100.00%");
    }
    expect(screen.queryByTestId("exposure-strip-basis")).not.toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    const text = screen.getByTestId("exposure-strip").textContent ?? "";
    expect(text).not.toMatch(/bientôt|à venir|en attente|chargement/i);
    expect(screen.getByTestId("exposure-strip").querySelector("[aria-busy='true']")).toBeNull();
  });
});
