/**
 * The exposure parity fixture (FR-732, AC-628): the portfolios of AC-623,
 * AC-624(a), AC-624(b) and AC-625, and the four basis portfolios of AC-627,
 * described **once**. `exposure-parity.test.ts` runs each through the
 * allocation read and through the web strip's breakdown and asserts the two
 * equal to each other and to the units below.
 *
 * Pure data: no import from the server packages (this module is not a test
 * file, so `web-no-server-runtime-imports` applies to it), no import from the
 * web code either. Bucket keys are the allocation read's: `UNCLASSIFIED` is
 * the strip's « Non classé », `CASH` its « Liquidités ». Fake instruments, round
 * figures; units are integer hundredths of a percent of the total (10 000 =
 * 100 %).
 */

export const PARITY_UNCLASSIFIED = "UNCLASSIFIED";
export const PARITY_CASH = "CASH";

export interface ParityWeight {
  readonly code: string;
  readonly weight: string;
}

export interface ParityHolding {
  readonly id: string;
  readonly kind: "SHARE" | "ETF";
  /** Base-currency value (EUR), as a decimal string. */
  readonly value: string;
  readonly sectorCode?: string;
  readonly domicileCountry?: string;
  readonly sectorWeights?: readonly ParityWeight[];
  readonly countryWeights?: readonly ParityWeight[];
}

export interface ParityPortfolio {
  readonly holdings: readonly ParityHolding[];
  /** Converted cash (EUR); `"0"` for none. */
  readonly cash: string;
}

/** One expected bucket: its key and its units, in display order. */
export type ParityBucket = readonly [key: string, units: string];

export interface ParityCase {
  readonly name: string;
  readonly portfolio: ParityPortfolio;
  readonly dimension: "sector" | "country";
  readonly buckets: readonly ParityBucket[];
}

// AC-623: ETF-A 6 000.00 weighted on both dimensions, SHARE-B 4 000.00 (FR, FINANCE), no cash.
const ETF_A: ParityHolding = {
  id: "etf-a",
  kind: "ETF",
  value: "6000.00",
  countryWeights: [
    { code: "US", weight: "60.00" },
    { code: "JP", weight: "25.00" },
    { code: "GB", weight: "10.00" },
  ],
  sectorWeights: [
    { code: "TECHNOLOGIE", weight: "30.00" },
    { code: "FINANCE", weight: "20.00" },
  ],
};
const SHARE_B: ParityHolding = {
  id: "share-b",
  kind: "SHARE",
  value: "4000.00",
  sectorCode: "FINANCE",
  domicileCountry: "FR",
};
export const AC_623: ParityPortfolio = { holdings: [ETF_A, SHARE_B], cash: "0" };

// AC-624(a): ETF-X 3 333.00 (US 50, JP 30, GB 10), SHARE-Y 6 667.00 domiciled US.
const AC_624_A: ParityPortfolio = {
  holdings: [
    {
      id: "etf-x",
      kind: "ETF",
      value: "3333.00",
      countryWeights: [
        { code: "US", weight: "50.00" },
        { code: "JP", weight: "30.00" },
        { code: "GB", weight: "10.00" },
      ],
    },
    { id: "share-y", kind: "SHARE", value: "6667.00", domicileCountry: "US" },
  ],
  cash: "0",
};

// AC-624(b): ETF-X 5.00 (DE 50, FR 50 — the tie), SHARE-Y 9 995.00 domiciled US.
const AC_624_B: ParityPortfolio = {
  holdings: [
    {
      id: "etf-x",
      kind: "ETF",
      value: "5.00",
      countryWeights: [
        { code: "DE", weight: "50.00" },
        { code: "FR", weight: "50.00" },
      ],
    },
    { id: "share-y", kind: "SHARE", value: "9995.00", domicileCountry: "US" },
  ],
  cash: "0",
};

// AC-625: ETF 4 000.00 (country US 100, no sector set), SHARE 5 000.00 (FR, TECHNOLOGIE), cash 1 000.00.
const AC_625: ParityPortfolio = {
  holdings: [
    {
      id: "etf",
      kind: "ETF",
      value: "4000.00",
      countryWeights: [{ code: "US", weight: "100.00" }],
    },
    {
      id: "share",
      kind: "SHARE",
      value: "5000.00",
      sectorCode: "TECHNOLOGIE",
      domicileCountry: "FR",
    },
  ],
  cash: "1000.00",
};

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "AC-623 country",
    portfolio: AC_623,
    dimension: "country",
    buckets: [
      ["FR", "4000"],
      ["US", "3600"],
      ["JP", "1500"],
      ["GB", "600"],
      [PARITY_UNCLASSIFIED, "300"],
    ],
  },
  {
    name: "AC-623 sector",
    portfolio: AC_623,
    dimension: "sector",
    buckets: [
      ["FINANCE", "5200"],
      ["TECHNOLOGIE", "1800"],
      [PARITY_UNCLASSIFIED, "3000"],
    ],
  },
  {
    name: "AC-624(a) country",
    portfolio: AC_624_A,
    dimension: "country",
    buckets: [
      ["US", "8334"],
      ["JP", "1000"],
      ["GB", "333"],
      [PARITY_UNCLASSIFIED, "333"],
    ],
  },
  {
    name: "AC-624(b) country",
    portfolio: AC_624_B,
    dimension: "country",
    buckets: [
      ["US", "9995"],
      ["DE", "3"],
      ["FR", "2"],
    ],
  },
  {
    name: "AC-625 country",
    portfolio: AC_625,
    dimension: "country",
    buckets: [
      ["FR", "5000"],
      ["US", "4000"],
      [PARITY_CASH, "1000"],
    ],
  },
  {
    name: "AC-625 sector",
    portfolio: AC_625,
    dimension: "sector",
    buckets: [
      ["TECHNOLOGIE", "5000"],
      [PARITY_UNCLASSIFIED, "4000"],
      [PARITY_CASH, "1000"],
    ],
  },
];

export interface BasisCase {
  readonly name: string;
  readonly portfolio: ParityPortfolio;
  readonly basis: string;
}

/** AC-627: the country basis both paths must state. */
export const BASIS_CASES: readonly BasisCase[] = [
  { name: "AC-623 (A by weights, B by domicile)", portfolio: AC_623, basis: "MIXED" },
  { name: "A alone", portfolio: { holdings: [ETF_A], cash: "0" }, basis: "WEIGHTED" },
  {
    // AC-622 as amended: ETF-C has no weights and no stored sector.
    name: "AC-622 (SHARE-B beside an unweighted ETF)",
    portfolio: {
      holdings: [SHARE_B, { id: "etf-c", kind: "ETF", value: "6000.00" }],
      cash: "0",
    },
    basis: "DOMICILE",
  },
  {
    name: "an unweighted ETF alone",
    portfolio: { holdings: [{ id: "etf-c", kind: "ETF", value: "6000.00" }], cash: "0" },
    basis: "NONE",
  },
];
