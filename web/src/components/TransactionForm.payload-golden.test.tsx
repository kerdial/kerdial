import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_PRESET_DEFAULTS } from "@kerdial/api-contracts";
import * as apiClient from "../lib/api-client.js";
import type { CashAccountBalance, CurrencyOption } from "../lib/api-client.js";
import { familyOf } from "../lib/transaction-kind-family.js";
import { TransactionForm } from "./TransactionForm.js";

/**
 * **GATE-G0 — the POST-body goldens of the create form** (`transaction-dialog-refresh`
 * TDR-T0, AC-558).
 *
 * Every case renders the **real** `TransactionForm`, drives it through a fixed
 * input map keyed by test id, clicks the real submit button, and compares
 * `JSON.stringify(createTransaction.mock.calls[0][0])` with a committed golden
 * by **strict string equality, key order included**. The goldens were captured
 * from the form before this cycle changed any of it (the pre-refresh form).
 *
 * **Not vacuous:** a golden of `buildTransactionRequestPayload(values)` alone
 * would be green by construction (that file does not change this cycle). This
 * drives the rendered form, which is where the risk is: a field that stops
 * registering, a picker that stops offering the fixture id, an effect that
 * stops writing `cashCurrency` all change the body.
 *
 * **Only the navigation adapter changes later.** `openKind` and `reveal` are
 * the two seams Batch C rewires (the family click, the « Plus d'options »
 * expander). The input maps are the gate's fixed half and are not edited
 * except where TDR-L11 moves a value (see `TDR_L11_FEE_TOTAL_TYPEABLE`).
 *
 * **Every guard on the submit path passes for these inputs**, so a
 * regression shows as a body diff, never as a silent no-call: the shared Zod
 * resolver (valid UUIDs, positive decimals, `tradeDate` set explicitly because
 * the default is today), `useOnlineStatus` (jsdom is online), the portfolios
 * and cash-account mocks (the pickers *offer* the fixture ids — the drivers
 * wait for the option before choosing it), the settlement effect (the mocked
 * account currency decides `cashCurrency`), and the `disabled` submit
 * (the button is *clicked*, never `fireEvent.submit`, so `disabled` is on the
 * path). When the body never arrives, the failure lists the form's own field
 * errors.
 *
 * **Time (assumption A-3):** `TransactionForm.test.tsx` pins no `TZ`; its
 * trade-time assertions are TZ-agnostic. So every case here leaves « Heure »
 * blank and no golden carries a `tradeTs`.
 *
 * **Capture mode:** `CAPTURE_GOLDENS=<dir>` writes each case's body to
 * `<dir>/<case>.json` and then **fails on purpose**, so a capture run can never
 * pass as a test (precedent: `SCPI_NON_REGRESSION_CAPTURE_DIR` in
 * `api/src/scpi-non-regression.e2e.test.ts`). The `*.after.json` goldens are
 * hand-derived and never captured.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchPortfolios: vi.fn(),
    searchInstruments: vi.fn(),
    createTransaction: vi.fn(),
    fetchPortfolioCash: vi.fn(),
    fetchCurrencies: vi.fn(),
    fetchPortfolioHoldings: vi.fn(),
    // The chips' presets, read on every
    // opening (an unmocked read is the failure path).
    fetchRatePresets: vi.fn(),
    saveRatePresets: vi.fn(),
  };
});

const mockedApiClient = vi.mocked(apiClient);

const GOLDEN_DIR = resolve(process.cwd(), "web/src/__fixtures__/transaction-payload-goldens");
const CAPTURE_DIR = process.env["CAPTURE_GOLDENS"];

/**
 * **TDR-L11's flip.** `true` while the BUY/SELL/DRIP fee area still had the
 * editable « Total des frais » (`fee-amount-input`), i.e. in the pre-refresh form. Batch C
 * (TDR-T10) made that total a read-only `<output>` and set this to `false`:
 * the two *before* cases are skipped (their goldens stay committed as the
 * record of what the old form sent) and only their `*.after.json` pairs gate.
 * The *after* cases ran in both phases — their inputs were typeable before,
 * and the body they produce is the one the new form sends.
 */
const TDR_L11_FEE_TOTAL_TYPEABLE = false;

const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PORTFOLIO_ID = "1a1a1a1a-1111-4111-8111-1111111111aa";
const USD_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_USD_ACCOUNT_ID = "5b5b5b5b-5555-4555-8555-555555555bbb";
const EUR_ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
const INSTRUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT_INSTRUMENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_DIVIDEND_ID = "77777777-7777-4777-8777-777777777777";
const TRADE_DATE = "2026-03-12";

/** The instrument each picker search returns, by the id the input map asks for. */
const INSTRUMENTS: Record<string, { displayName: string; symbol: string }> = {
  [INSTRUMENT_ID]: { displayName: "Apple Inc", symbol: "AAPL" },
  [SETTLEMENT_INSTRUMENT_ID]: { displayName: "Bitcoin", symbol: "BTC" },
};

function cashAccount(overrides: Partial<CashAccountBalance> & { id: string }): CashAccountBalance {
  return {
    name: "Compte",
    currency: "EUR",
    archived: false,
    balance: "0",
    isNegative: false,
    ...overrides,
  };
}

const CASH_ACCOUNTS: CashAccountBalance[] = [
  cashAccount({ id: USD_ACCOUNT_ID, name: "Compte USD", currency: "USD", balance: "1000" }),
  cashAccount({ id: SECOND_USD_ACCOUNT_ID, name: "Réserve USD", currency: "USD" }),
  cashAccount({ id: EUR_ACCOUNT_ID, name: "Compte EUR", currency: "EUR" }),
];

const CURRENCIES: CurrencyOption[] = [
  { code: "EUR", name: "Euro", minorUnit: 2 },
  { code: "USD", name: "Dollar américain", minorUnit: 2 },
  { code: "GBP", name: "Livre sterling", minorUnit: 2 },
];

type Kind =
  | "BUY"
  | "SELL"
  | "DRIP"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "DIVIDEND"
  | "INTEREST"
  | "CURRENCY_EXCHANGE"
  | "SHARE_DISTRIBUTION"
  | "TRANSFER_OUT"
  | "FEE";

interface GoldenCase {
  /** File stem under `GOLDEN_DIR`. */
  readonly name: string;
  readonly kind: Kind;
  /** Test id → value, **in drive order** (string keys keep insertion order). */
  readonly inputs: Readonly<Record<string, string>>;
  /** Figures the golden must carry verbatim — the sanity guard's proof the capture is this case's body. */
  readonly figures: readonly string[];
  readonly skip?: boolean;
}

// ---------------------------------------------------------------------------
// The navigation adapter — the only half Batch C rewires.
// ---------------------------------------------------------------------------

/** In the pre-refresh form the kind control was a flat tab strip; since TDR-T5 only the selected family's pills are rendered (FR-646), so the family radio is clicked first. */
function openKind(kind: Kind): void {
  fireEvent.click(screen.getByTestId(`family-tab-${familyOf(kind)}`));
  fireEvent.click(screen.getByTestId(`kind-tab-${kind}`));
}

/** In the pre-refresh form nothing is hidden behind an expander (a closed `<details>` does not stop jsdom input events). */
function reveal(_testId: string): void {}

// ---------------------------------------------------------------------------
// Drivers: how each test id is filled. Each one waits for the value to be
// *offered* where a control can silently ignore a value it has no option for.
// ---------------------------------------------------------------------------

const CURRENCY_SELECTS = new Set(["currency-input", "target-currency-input"]);
const ACCOUNT_PICKERS = new Set(["cash-account-input", "target-cash-account-input"]);
const INSTRUMENT_PICKERS = new Set(["instrument-picker", "settlement-instrument-picker"]);
const PLAIN_SELECTS = new Set(["portfolio-select", "destination-portfolio-select"]);

function optionValues(testId: string): string[] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.value);
}

async function chooseOption(testId: string, value: string): Promise<void> {
  await waitFor(() => expect(optionValues(testId)).toContain(value));
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
  expect(screen.getByTestId(testId)).toHaveValue(value);
}

async function pickInstrument(testId: string, instrumentId: string): Promise<void> {
  const instrument = INSTRUMENTS[instrumentId];
  if (instrument === undefined) throw new Error(`no instrument fixture for ${instrumentId}`);
  mockedApiClient.searchInstruments.mockResolvedValueOnce([
    {
      id: instrumentId,
      kind: "EQUITY",
      displayName: instrument.displayName,
      listingCurrency: "USD",
      isin: null,
      exchangeMic: null,
      symbol: instrument.symbol,
    },
  ]);
  fireEvent.change(screen.getByTestId(`${testId}-search`), {
    target: { value: instrument.displayName },
  });
  await waitFor(() => expect(screen.getByTestId(`${testId}-results`)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("option", { name: new RegExp(instrument.displayName) }));
  await waitFor(() => expect(screen.getByTestId(`${testId}-selected`)).toBeInTheDocument());
}

async function fillField(testId: string, value: string): Promise<void> {
  reveal(testId);
  if (testId === "portfolio-select") {
    await chooseOption(testId, value);
    await waitFor(() => expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalled());
  } else if (PLAIN_SELECTS.has(testId) || CURRENCY_SELECTS.has(testId)) {
    await chooseOption(testId, value);
  } else if (ACCOUNT_PICKERS.has(testId)) {
    await chooseOption(testId, value);
  } else if (INSTRUMENT_PICKERS.has(testId)) {
    await pickInstrument(testId, value);
  } else if (testId === "settlement-toggle") {
    const toggle = screen.getByTestId(testId) as HTMLInputElement;
    if (toggle.checked !== (value === "on")) fireEvent.click(toggle);
    expect(toggle.checked).toBe(value === "on");
  } else {
    fireEvent.change(screen.getByTestId(testId), { target: { value } });
    expect(screen.getByTestId(testId)).toHaveValue(value);
  }
}

// ---------------------------------------------------------------------------
// The fixed input set. Every number is a string; every id is a valid UUID.
// ---------------------------------------------------------------------------

/** The head every case starts with: the portfolio (so the account pickers load) and an explicit date. */
const HEAD = { "portfolio-select": PORTFOLIO_ID, "trade-date-input": TRADE_DATE } as const;

function buyInputs(
  unitPrice: string,
  fee: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...HEAD,
    "instrument-picker": INSTRUMENT_ID,
    "quantity-input": "12",
    "unit-price-input": unitPrice,
    "currency-input": "USD",
    "cash-account-input": USD_ACCOUNT_ID,
    "fx-rate-user-input": "0.9175",
    ...fee,
  };
}

function currencyExchangeInputs(fee: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...HEAD,
    "amount-input": "500.00",
    "currency-input": "USD",
    "cash-account-input": USD_ACCOUNT_ID,
    "target-currency-input": "EUR",
    "target-cash-account-input": EUR_ACCOUNT_ID,
    "exchange-rate-input": "0.9180",
    ...fee,
  };
}

const CASES: readonly GoldenCase[] = [
  {
    name: "buy",
    kind: "BUY",
    inputs: {
      ...buyInputs("187.25", {}),
      "reference-input": "ORD-4411",
      "note-input": "Golden BUY",
    },
    figures: ["187.25", "ORD-4411"],
  },
  {
    name: "sell",
    kind: "SELL",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "quantity-input": "4",
      "unit-price-input": "203.10",
      "currency-input": "USD",
      "cash-account-input": USD_ACCOUNT_ID,
      "fx-rate-user-input": "0.9210",
    },
    figures: ["203.10"],
  },
  {
    name: "drip",
    kind: "DRIP",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "source-dividend-id-input": SOURCE_DIVIDEND_ID,
      "quantity-input": "0.35",
      "unit-price-input": "190.40",
      "currency-input": "USD",
      "cash-account-input": USD_ACCOUNT_ID,
    },
    figures: ["190.40", SOURCE_DIVIDEND_ID],
  },
  {
    name: "deposit",
    kind: "DEPOSIT",
    inputs: {
      ...HEAD,
      "amount-input": "1500.00",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
    },
    figures: ["1500.00"],
  },
  {
    name: "withdrawal",
    kind: "WITHDRAWAL",
    inputs: {
      ...HEAD,
      "amount-input": "320.45",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
    },
    figures: ["320.45"],
  },
  {
    name: "dividend",
    kind: "DIVIDEND",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "amount-input": "18.60",
      "currency-input": "USD",
      "cash-account-input": USD_ACCOUNT_ID,
      "fx-rate-user-input": "0.9190",
    },
    figures: ["18.60"],
  },
  {
    name: "interest",
    kind: "INTEREST",
    inputs: {
      ...HEAD,
      "amount-input": "4.12",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
    },
    figures: ["4.12"],
  },
  {
    name: "currency-exchange",
    kind: "CURRENCY_EXCHANGE",
    inputs: currencyExchangeInputs({}),
    figures: ["500.00", "0.9180"],
  },
  {
    name: "share-distribution",
    kind: "SHARE_DISTRIBUTION",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "quantity-input": "3",
      "amount-input": "561.75",
      "currency-input": "USD",
      "fx-rate-user-input": "0.9165",
    },
    figures: ["561.75"],
  },
  {
    name: "transfer-out",
    kind: "TRANSFER_OUT",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "quantity-input": "2",
      "amount-input": "374.50",
      "currency-input": "USD",
      "destination-portfolio-select": OTHER_PORTFOLIO_ID,
    },
    figures: ["374.50", OTHER_PORTFOLIO_ID],
  },
  {
    name: "buy-asset-settled",
    kind: "BUY",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "quantity-input": "0.02",
      "settlement-toggle": "on",
      "settlement-instrument-picker": SETTLEMENT_INSTRUMENT_ID,
      "settlement-amount-input": "0.0031",
      "settlement-fx-rate-user-input": "65000",
    },
    figures: ["0.0031", SETTLEMENT_INSTRUMENT_ID],
  },
  {
    name: "buy-fee-components",
    kind: "BUY",
    inputs: buyInputs("150.20", { "fee-broker-input": "9.90", "fee-tax-input": "3.60" }),
    figures: ["150.20", "9.90", "3.60"],
  },
  {
    name: "buy-fee-total-only",
    kind: "BUY",
    inputs: buyInputs("151.30", { "fee-amount-input": "2.50" }),
    figures: ["151.30", "2.50"],
    skip: !TDR_L11_FEE_TOTAL_TYPEABLE,
  },
  {
    name: "buy-fee-total-and-components",
    kind: "BUY",
    inputs: buyInputs("152.40", {
      "fee-amount-input": "13.50",
      "fee-broker-input": "9.90",
      "fee-tax-input": "3.60",
    }),
    figures: ["152.40", "13.50", "9.90", "3.60"],
    skip: !TDR_L11_FEE_TOTAL_TYPEABLE,
  },
  {
    // The Portfolio Performance reference row — a USD gross
    // at a pinned rate into the EUR (base) account, the withholding in EUR.
    // The body carries `withholding: { amount }` and nothing else of it.
    name: "dividend-withholding",
    kind: "DIVIDEND",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "amount-input": "3.65",
      "currency-input": "USD",
      "cash-account-input": EUR_ACCOUNT_ID,
      "fx-rate-user-input": "0.9237",
      "withholding-amount-input": "0.51",
    },
    figures: ["3.65", "0.9237", "0.51"],
  },
  {
    name: "interest-withholding",
    kind: "INTEREST",
    inputs: {
      ...HEAD,
      "amount-input": "4.12",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
      "withholding-amount-input": "1.24",
    },
    figures: ["4.12", "1.24"],
  },
  {
    // TDR-T7 (O-1): only the retenue amount is typed. That is the
    // whole withholding. The inputs are `TransactionForm.test.tsx`'s case, so
    // the golden's `withholding` member is the string that test pins (below).
    name: "dividend-withholding-defaults",
    kind: "DIVIDEND",
    inputs: {
      ...HEAD,
      "instrument-picker": INSTRUMENT_ID,
      "amount-input": "100.00",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
      "withholding-amount-input": "30.00",
    },
    figures: ["100.00", "30.00"],
  },
  {
    // The INTEREST twin (it holds on both kinds), with the retenue of
    // `TransactionForm.test.tsx`'s DIVIDEND → INTEREST case.
    name: "interest-withholding-defaults",
    kind: "INTEREST",
    inputs: {
      ...HEAD,
      "amount-input": "100.00",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
      "withholding-amount-input": "2.50",
    },
    figures: ["100.00", "2.50"],
  },
  {
    name: "currency-exchange-fee-total",
    kind: "CURRENCY_EXCHANGE",
    inputs: currencyExchangeInputs({ "fee-amount-input": "1.50" }),
    figures: ["500.00", "1.50"],
  },
  {
    name: "currency-exchange-fee-components",
    kind: "CURRENCY_EXCHANGE",
    inputs: currencyExchangeInputs({ "fee-broker-input": "1.00", "fee-fx-input": "0.50" }),
    figures: ["500.00", "1.00", "0.50"],
  },
  {
    name: "currency-exchange-fee-total-and-components",
    kind: "CURRENCY_EXCHANGE",
    inputs: currencyExchangeInputs({
      "fee-amount-input": "1.50",
      "fee-broker-input": "1.00",
      "fee-fx-input": "0.50",
    }),
    figures: ["500.00", "1.50", "1.00", "0.50"],
  },
  {
    // D4: a USD trade settled in the EUR (base) account — the settlement
    // effect writes `cashCurrency: "EUR"` and no `cashAmount` (L11).
    name: "deposit-cross-currency-settlement",
    kind: "DEPOSIT",
    inputs: {
      ...HEAD,
      "amount-input": "1000.00",
      "currency-input": "USD",
      "cash-account-input": EUR_ACCOUNT_ID,
      "fx-rate-user-input": "0.9175",
    },
    figures: ["1000.00", "0.9175", '"cashCurrency":"EUR"'],
  },
  {
    // portfolio-cash AC-584: « Libellé » is the note; no instrument chosen, so
    // no `instrumentId` key at all.
    name: "fee",
    kind: "FEE",
    inputs: {
      ...HEAD,
      "amount-input": "7.50",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
      "note-input": "Frais de garde T3",
    },
    figures: ["7.50", "Frais de garde T3"],
  },
  {
    // The same charge naming its instrument from « Plus d'options » (PC-L14).
    name: "fee-instrument",
    kind: "FEE",
    inputs: {
      ...HEAD,
      "amount-input": "2.40",
      "currency-input": "EUR",
      "cash-account-input": EUR_ACCOUNT_ID,
      "note-input": "Frais de garde AAPL",
      "instrument-picker": INSTRUMENT_ID,
    },
    figures: ["2.40", "Frais de garde AAPL", INSTRUMENT_ID],
  },
];

/**
 * TDR-L11's *after* goldens, hand-derived: the same BUY with the
 * lone total typed as Courtage, and with the total dropped beside its
 * components. Never captured; `CAPTURE_GOLDENS` does not write them.
 */
const AFTER_CASES: readonly GoldenCase[] = [
  {
    name: "buy-fee-total-only.after",
    kind: "BUY",
    inputs: buyInputs("151.30", { "fee-broker-input": "2.50" }),
    figures: ["151.30", '"fee":{"components":{"brokerFee":"2.50"}}'],
  },
  {
    name: "buy-fee-total-and-components.after",
    kind: "BUY",
    inputs: buyInputs("152.40", { "fee-broker-input": "9.90", "fee-tax-input": "3.60" }),
    figures: ["152.40", '"fee":{"components":{"brokerFee":"9.90","tax":"3.60"}}'],
  },
];

// ---------------------------------------------------------------------------

function renderForm(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    (
      <QueryClientProvider client={queryClient}>
        <TransactionForm onSubmitted={vi.fn()} onCancel={vi.fn()} />
      </QueryClientProvider>
    ) as ReactElement,
  );
}

/** The form's visible field errors, so a body that never arrives says why. */
function visibleAlerts(): string[] {
  return screen.queryAllByRole("alert").map((alert) => {
    const field = alert.closest(".k-field");
    const input = field?.querySelector("[data-testid]")?.getAttribute("data-testid") ?? "?";
    return `${input}: ${alert.textContent ?? ""}`;
  });
}

async function submittedBody(goldenCase: GoldenCase): Promise<string> {
  renderForm();
  await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
  openKind(goldenCase.kind);
  for (const [testId, value] of Object.entries(goldenCase.inputs)) {
    await fillField(testId, value);
  }
  const submit = screen.getByTestId("transaction-form-submit");
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  try {
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
  } catch {
    throw new Error(
      `createTransaction never called for "${goldenCase.name}" — a guard on the submit path ` +
        `blocked it (a failed gate). Field errors: ${JSON.stringify(visibleAlerts())}`,
    );
  }
  return JSON.stringify(mockedApiClient.createTransaction.mock.calls[0]?.[0]);
}

function readGolden(name: string): string {
  return readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8");
}

/** Rejects a `null`, `{}` or foreign capture: the right kind, the fixture portfolio and date, and this case's own figures. */
function assertSane(goldenCase: GoldenCase, golden: string): void {
  const parsed: unknown = JSON.parse(golden);
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  const body = parsed as Record<string, unknown>;
  expect(Object.keys(body).length).toBeGreaterThanOrEqual(5);
  expect(body["kind"]).toBe(goldenCase.kind);
  expect(body["portfolioId"]).toBe(PORTFOLIO_ID);
  expect(body["tradeDate"]).toBe(TRADE_DATE);
  expect(body["tradeTs"]).toBeUndefined();
  for (const figure of goldenCase.figures) {
    expect(golden).toContain(figure.startsWith('"') ? figure : `"${figure}"`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockedApiClient.fetchPortfolios.mockResolvedValue(
    [
      { id: PORTFOLIO_ID, name: "Compte principal" },
      { id: OTHER_PORTFOLIO_ID, name: "Compte secondaire" },
    ].map((portfolio) => ({
      ...portfolio,
      transactionCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      broker: null,
      description: null,
      accentColor: null,
      hasIcon: false,
      archived: false,
    })),
  );
  mockedApiClient.searchInstruments.mockResolvedValue([]);
  mockedApiClient.createTransaction.mockResolvedValue({} as never);
  mockedApiClient.fetchPortfolioCash.mockResolvedValue({
    accounts: CASH_ACCOUNTS,
    byCurrency: [],
    calcEpoch: "1",
  });
  mockedApiClient.fetchCurrencies.mockResolvedValue(CURRENCIES);
  // The chips' presets (server defaults). No case clicks a chip: every figure
  // here is typed, so the bodies cannot depend on this list.
  mockedApiClient.fetchRatePresets.mockResolvedValue({ items: RATE_PRESET_DEFAULTS });
  // TRANSFER_OUT's prefill read: the source holds nothing, so no prefill
  // competes with the typed market value.
  mockedApiClient.fetchPortfolioHoldings.mockResolvedValue({
    holdings: [],
  } as unknown as Awaited<ReturnType<typeof apiClient.fetchPortfolioHoldings>>);
});

afterEach(() => {
  window.localStorage.clear();
});

describe("GATE-G0 — create-form POST bodies match the pre-refresh goldens (AC-558)", () => {
  it("the fixture directory holds exactly the case list and the two TDR-L11 after files", () => {
    const expected = [...CASES, ...AFTER_CASES].map((goldenCase) => `${goldenCase.name}.json`);
    expect(readdirSync(GOLDEN_DIR).sort()).toEqual(expected.sort());
  });

  it("every kind of the form has a case", () => {
    expect(new Set(CASES.map((goldenCase) => goldenCase.kind))).toEqual(
      new Set<Kind>([
        "BUY",
        "SELL",
        "DRIP",
        "DEPOSIT",
        "WITHDRAWAL",
        "DIVIDEND",
        "INTEREST",
        "CURRENCY_EXCHANGE",
        "SHARE_DISTRIBUTION",
        "TRANSFER_OUT",
        "FEE",
      ]),
    );
  });

  for (const goldenCase of [...CASES, ...AFTER_CASES]) {
    it(`every golden is non-trivial and this case's own body: ${goldenCase.name}`, () => {
      assertSane(goldenCase, readGolden(goldenCase.name));
    });
  }

  for (const goldenCase of CASES) {
    it.skipIf(goldenCase.skip === true)(
      `${goldenCase.name}: the rendered form's body`,
      async () => {
        const body = await submittedBody(goldenCase);
        if (CAPTURE_DIR !== undefined && CAPTURE_DIR !== "") {
          mkdirSync(CAPTURE_DIR, { recursive: true });
          writeFileSync(join(CAPTURE_DIR, `${goldenCase.name}.json`), body);
          throw new Error(
            `capture mode: ${goldenCase.name}.json written to ${CAPTURE_DIR}, nothing compared`,
          );
        }
        expect(body).toBe(readGolden(goldenCase.name));
      },
    );
  }

  // TDR-L11: the after bodies, driven through the components the new
  // form leaves typeable. Live in both phases — see `TDR_L11_FEE_TOTAL_TYPEABLE`.
  for (const goldenCase of AFTER_CASES) {
    it(`${goldenCase.name}: the TDR-L11 after body`, async () => {
      const body = await submittedBody(goldenCase);
      expect(body).toBe(readGolden(goldenCase.name));
    });
  }

  /**
   * TDR-T7: the withholding member of every `*-withholding*` golden is
   * `{ amount }` alone — byte-for-byte the string `TransactionForm.test.tsx`
   * pins on the `-defaults` inputs, two independent observations of one body.
   */
  it("the withholding goldens carry exactly { amount }, as TransactionForm.test.tsx pins", () => {
    const withholding = (name: string): string =>
      JSON.stringify((JSON.parse(readGolden(name)) as Record<string, unknown>)["withholding"]);
    expect(withholding("dividend-withholding")).toBe('{"amount":"0.51"}');
    expect(withholding("interest-withholding")).toBe('{"amount":"1.24"}');
    expect(withholding("dividend-withholding-defaults")).toBe('{"amount":"30.00"}');
    expect(withholding("interest-withholding-defaults")).toBe('{"amount":"2.50"}');
  });

  it("each TDR-L11 after golden differs from its before golden in the fee only", () => {
    const pairs = [
      ["buy-fee-total-only", '{"amount":"2.50"}', '{"components":{"brokerFee":"2.50"}}'],
      [
        "buy-fee-total-and-components",
        '{"amount":"13.50","components":{"brokerFee":"9.90","tax":"3.60"}}',
        '{"components":{"brokerFee":"9.90","tax":"3.60"}}',
      ],
    ] as const;
    for (const [name, beforeFee, afterFee] of pairs) {
      const before = readGolden(name);
      expect(before).toContain(`"fee":${beforeFee}`);
      expect(readGolden(`${name}.after`)).toBe(
        before.replace(`"fee":${beforeFee}`, `"fee":${afterFee}`),
      );
    }
  });
});
