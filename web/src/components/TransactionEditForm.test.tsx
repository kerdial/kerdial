import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { TransactionResponse } from "../lib/api-client.js";
import * as invalidateDerived from "../lib/invalidate-derived.js";
import {
  buildTransactionEditBody,
  defaultTransactionEditFormValues,
  EDITABLE_FIELDS_BY_KIND,
  TransactionEditForm,
} from "./TransactionEditForm.js";
// The real guarded-field list, from the schema `PATCH /transactions/:id`
// validates with — the same cross-package import `tester-schema-parity.test.ts`
// makes, and for the same reason: a proxy for a rule drifts from the rule.
import { GUARDED_FX_EDIT_FIELDS } from "../../../api/src/transactions/transactions.schema.js";

/**
 * UR-20 (FR-105/FR-108/
 * FR-110, AC98/AC99). KEEP AS-IS.
 */
vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    editTransaction: vi.fn(),
    searchInstruments: vi.fn(),
    // CA-21: `CashAccountPicker`'s only read, at the **second** entry point.
    fetchPortfolioCash: vi.fn(),
    createCashAccount: vi.fn(),
    // With the principal slot's currency filter off, the inline creation
    // dialog no longer pins a currency — it offers the shared `CurrencySelect`,
    // whose one read is this.
    fetchCurrencies: vi.fn(),
  };
});

vi.mock("../lib/invalidate-derived.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/invalidate-derived.js")>(
    "../lib/invalidate-derived.js",
  );
  return {
    ...actual,
    invalidatePortfolioDerivedFigures: vi.fn(actual.invalidatePortfolioDerivedFigures),
  };
});

const mockedApiClient = vi.mocked(apiClient);
const mockedInvalidateDerived = vi.mocked(invalidateDerived);
const { ApiError } = apiClient;

const PORTFOLIO_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_PORTFOLIO_ID = "1a1a1a1a-1111-4111-8111-1111111111aa";
/**
 * CA-21's mandatory fixture. `ARCHIVED_EUR_ID` is the account the edited
 * transaction is **already attributed to**, and it is archived — the exact
 * state CD12 behaviour 3 exists for, and the one this project's record says a
 * shared picker silently drops on its second mount. Every picker test in this
 * file mounts it.
 */
const ARCHIVED_EUR_ID = "6a6a6a6a-6666-4666-8666-666666666aaa";
const ACTIVE_EUR_ID = "66666666-6666-4666-8666-666666666666";
const ACTIVE_USD_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_USD_ID = "5b5b5b5b-5555-4555-8555-555555555bbb";

function cashAccount(
  overrides: Partial<apiClient.CashAccountBalance> & { id: string },
): apiClient.CashAccountBalance {
  return {
    name: "Compte",
    currency: "EUR",
    archived: false,
    balance: "0",
    isNegative: false,
    ...overrides,
  };
}

function cashResponse(
  accounts?: readonly apiClient.CashAccountBalance[],
): apiClient.PortfolioCashResponse {
  const resolved = accounts ?? [
    cashAccount({ id: ARCHIVED_EUR_ID, name: "Ancien EUR", currency: "EUR", archived: true }),
    cashAccount({ id: ACTIVE_EUR_ID, name: "Compte EUR", currency: "EUR" }),
    cashAccount({ id: ACTIVE_USD_ID, name: "Compte USD", currency: "USD" }),
    cashAccount({ id: SECOND_USD_ID, name: "Réserve USD", currency: "USD" }),
  ];
  return { accounts: resolved, byCurrency: [], calcEpoch: "1" };
}

/** The option ids a picker slot currently offers, placeholder excluded. */
function offeredAccountIds(testId: string): string[] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options)
    .map((option) => option.value)
    .filter((value) => value !== "");
}

/** The option *labels* a slot offers — used to prove the « (archivé) » marking, not merely the id's presence. */
function offeredAccountLabels(testId: string): string[] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.options)
    .filter((option) => option.value !== "")
    .map((option) => option.textContent ?? "");
}

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    portfolioId: PORTFOLIO_ID,
    kind: "BUY",
    tradeDate: "2026-08-01",
    tradeTs: "2026-08-01T10:00:00.000Z",
    seq: "1",
    instrumentId: "22222222-2222-2222-2222-222222222222",
    quantity: "10",
    unitPrice: "100.00",
    grossAmount: "1000.00",
    txnCurrency: "EUR",
    txnSettlementInstrumentId: null,
    targetCurrency: null,
    targetAmount: null,
    feeAmount: null,
    withholdingAmount: null,
    sourceDividendId: null,
    // CA-21: the default fixture's principal leg is attributed to the
    // **archived** account, so every test in this file that mounts the edit
    // form mounts the archived case — a picker suite with zero archived
    // fixtures would prove nothing about CA-21.
    cashAccountId: ARCHIVED_EUR_ID,
    targetCashAccountId: null,
    cashCurrency: null,
    cashAmount: null,
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    fxRate: "1",
    fxRateSource: "IMPLIED_BASE",
    fxRateProviderKey: null,
    fxRateObservedOn: null,
    fxRateUserInput: null,
    note: null,
    reference: null,
    transferLinkedTransactionId: null,
    transferLinkedPortfolioId: null,
    transferCostBase: null,
    transferCostNative: null,
    transferCostCurrency: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderForm(t: TransactionResponse = transaction()): {
  queryClient: QueryClient;
  onSaved: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    (
      <QueryClientProvider client={queryClient}>
        <TransactionEditForm transaction={t} onSaved={onSaved} onCancel={onCancel} />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { queryClient, onSaved, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiClient.searchInstruments.mockResolvedValue([]);
  mockedApiClient.fetchPortfolioCash.mockResolvedValue(cashResponse());
  mockedApiClient.fetchCurrencies.mockResolvedValue([
    { code: "EUR", name: "Euro", minorUnit: 2 },
    { code: "USD", name: "Dollar américain", minorUnit: 2 },
    { code: "CHF", name: "Franc suisse", minorUnit: 2 },
  ]);
});

/** Waits for the picker's own read to resolve into rendered options. */
async function waitForPickerOptions(testId: string): Promise<void> {
  await waitFor(() => expect(offeredAccountIds(testId).length).toBeGreaterThan(0));
}

describe("EDITABLE_FIELDS_BY_KIND — L9's explicit per-kind table, all eight kinds", () => {
  it("SHARE_DISTRIBUTION offers exactly the fields the 0056 shape CHECK leaves it", () => {
    // The exact set, not merely contains/not-contains: this kind shipped with
    // NO entry at all, so the drawer offered it zero fields —
    // an omission a contains-style assertion on another kind never sees.
    expect(EDITABLE_FIELDS_BY_KIND["SHARE_DISTRIBUTION"]).toEqual([
      "instrumentId",
      "quantity",
      "note",
      "reference",
      "tradeDate",
      "tradeTime",
    ]);
  });

  it("SHARE_DISTRIBUTION never offers a field the server guard refuses", () => {
    for (const forbidden of [
      "unitPrice",
      "grossAmount",
      "feeAmount",
      "withholdingAmount",
      "cashAccountId",
      "cashCurrency",
      "cashAmount",
      "targetAmount",
      "targetCashAccountId",
    ]) {
      expect(EDITABLE_FIELDS_BY_KIND["SHARE_DISTRIBUTION"]).not.toContain(forbidden);
    }
  });

  it("a DEPOSIT never includes quantity, unitPrice, or grossAmount", () => {
    expect(EDITABLE_FIELDS_BY_KIND["DEPOSIT"]).not.toContain("quantity");
    expect(EDITABLE_FIELDS_BY_KIND["DEPOSIT"]).not.toContain("unitPrice");
    expect(EDITABLE_FIELDS_BY_KIND["DEPOSIT"]).not.toContain("grossAmount");
  });

  it("a WITHDRAWAL never includes quantity, unitPrice, or grossAmount", () => {
    expect(EDITABLE_FIELDS_BY_KIND["WITHDRAWAL"]).not.toContain("quantity");
    expect(EDITABLE_FIELDS_BY_KIND["WITHDRAWAL"]).not.toContain("unitPrice");
  });

  it("BUY/SELL/DRIP never include grossAmount or targetAmount, but do include quantity/unitPrice", () => {
    for (const kind of ["BUY", "SELL", "DRIP"] as const) {
      expect(EDITABLE_FIELDS_BY_KIND[kind]).not.toContain("grossAmount");
      expect(EDITABLE_FIELDS_BY_KIND[kind]).not.toContain("targetAmount");
      expect(EDITABLE_FIELDS_BY_KIND[kind]).toContain("quantity");
      expect(EDITABLE_FIELDS_BY_KIND[kind]).toContain("unitPrice");
    }
  });

  it("DIVIDEND offers its gross and withholding but never a fee, quantity or unitPrice", () => {
    expect(EDITABLE_FIELDS_BY_KIND["DIVIDEND"]).toContain("grossAmount");
    expect(EDITABLE_FIELDS_BY_KIND["DIVIDEND"]).not.toContain("feeAmount");
    expect(EDITABLE_FIELDS_BY_KIND["DIVIDEND"]).toContain("withholdingAmount");
    expect(EDITABLE_FIELDS_BY_KIND["DIVIDEND"]).not.toContain("quantity");
    expect(EDITABLE_FIELDS_BY_KIND["DIVIDEND"]).not.toContain("unitPrice");
  });

  it("BUY/SELL/DRIP/DIVIDEND have no instrument field, FEE and SHARE_DISTRIBUTION keep theirs", () => {
    for (const kind of ["BUY", "SELL", "DRIP", "DIVIDEND"]) {
      expect(EDITABLE_FIELDS_BY_KIND[kind], kind).not.toContain("instrumentId");
    }
    expect(EDITABLE_FIELDS_BY_KIND["FEE"]).toContain("instrumentId");
    expect(EDITABLE_FIELDS_BY_KIND["SHARE_DISTRIBUTION"]).toContain("instrumentId");
  });

  it("INTEREST offers exactly its gross, its withholding and its account — never an instrument, a price or a fee (cash-interest I-9)", () => {
    // The exact set: the table is not exhaustive by type, so a missing entry
    // would give the drawer zero fields (that class of bug).
    expect(EDITABLE_FIELDS_BY_KIND["INTEREST"]).toEqual([
      "grossAmount",
      "withholdingAmount",
      "cashAccountId",
      "cashCurrency",
      "cashAmount",
      "note",
      "reference",
      "tradeDate",
      "tradeTime",
    ]);
  });

  it("CURRENCY_EXCHANGE includes targetAmount but never instrumentId/quantity/unitPrice/grossAmount", () => {
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).toContain("targetAmount");
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).not.toContain("instrumentId");
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).not.toContain("quantity");
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).not.toContain("unitPrice");
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).not.toContain("grossAmount");
  });

  /**
   * **Tightened, not relaxed.** This asserted "no editable field's
   * *name* matches /currency|tradeDate|fxRate/", which was a proxy for the
   * real rule and stopped being a correct one when `cashCurrency` became
   * editable — deliberately, per FD8: it carries no resolved rate,
   * so `editTransactionBodySchema` keeps it **out** of `GUARDED_FX_EDIT_FIELDS`
   * precisely so a leg can be re-pointed to an account in another currency.
   *
   * The replacement asserts against `GUARDED_FX_EDIT_FIELDS` **itself**,
   * imported from the schema the API validates with, so this can no longer
   * pass or fail on a name's spelling: any field the server actually refuses
   * is refused here, and a new guarded field added there is caught here with
   * no edit.
   */
  it("no kind but the two transfer kinds, INTEREST and FEE offers grossAmount, and none offers ANY field PATCH /transactions/:id guards (N1)", () => {
    // Non-vacuity: the imported list is the real one and is not empty.
    expect(GUARDED_FX_EDIT_FIELDS.length).toBeGreaterThan(0);
    expect(GUARDED_FX_EDIT_FIELDS).toContain("txnCurrency");
    // The date is no longer guarded, so it is editable (D1: the stored rate stays).
    expect(GUARDED_FX_EDIT_FIELDS).not.toContain("tradeDate" as never);

    for (const [kind, fields] of Object.entries(EDITABLE_FIELDS_BY_KIND)) {
      // A transfer's market value is the one
      // `grossAmount` a user types and may correct (FR-578); N1 holds for
      // every other kind.
      // `cash-interest` AC-520: so is an interest's gross, and
      // And a fee's amount.
      // And a dividend's gross (C8).
      if (
        kind !== "TRANSFER_OUT" &&
        kind !== "TRANSFER_IN" &&
        kind !== "INTEREST" &&
        kind !== "FEE" &&
        kind !== "DIVIDEND"
      ) {
        expect(fields, kind).not.toContain("grossAmount" as never);
      }
      for (const guarded of GUARDED_FX_EDIT_FIELDS) {
        expect(fields, `${guarded} is guarded by the API and must never be editable`).not.toContain(
          guarded as never,
        );
      }
    }
    // …and the one currency-shaped field that IS editable is editable on
    // purpose: FD8 keeps `cashCurrency` out of the guarded set so a leg can be
    // re-pointed across currencies. Stated here so the pair of facts
    // sits in one place.
    expect(GUARDED_FX_EDIT_FIELDS).not.toContain("cashCurrency" as never);
    expect(EDITABLE_FIELDS_BY_KIND["BUY"]).toContain("cashCurrency");
  });
});

describe("<TransactionEditForm> — form only renders controls for its kind's own editable fields", () => {
  it("a DEPOSIT's form has no quantity/unit-price/instrument controls", () => {
    renderForm(
      transaction({ kind: "DEPOSIT", instrumentId: null, quantity: null, unitPrice: null }),
    );
    expect(screen.queryByTestId("transaction-edit-quantity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-unit-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-instrument-search")).not.toBeInTheDocument();
  });

  it("a BUY's form has quantity/unit-price controls, and no grossAmount control anywhere", () => {
    renderForm();
    expect(screen.getByTestId("transaction-edit-quantity")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-unit-price")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-gross-amount")).not.toBeInTheDocument();
  });

  it("a SHARE_DISTRIBUTION's form offers its five fields, and none the shape CHECK forbids", () => {
    // Previously this kind had no EDITABLE_FIELDS_BY_KIND entry at all, so
    // the drawer rendered zero editable controls — including `reference`,
    // which every other kind can edit.
    renderForm(
      transaction({
        kind: "SHARE_DISTRIBUTION",
        unitPrice: null,
        grossAmount: "503.40",
        quantity: "3",
        cashAccountId: null,
        cashCurrency: null,
        cashAmount: null,
      }),
    );
    expect(screen.getByTestId("transaction-edit-quantity")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-instrument-search")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-reference")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-unit-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-fee-amount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-gross-amount")).not.toBeInTheDocument();
  });

  it("an INTEREST's form offers its gross and its withholding, and no instrument, quantity, price or fee (cash-interest)", () => {
    renderForm(
      transaction({
        kind: "INTEREST",
        instrumentId: null,
        quantity: null,
        unitPrice: null,
        grossAmount: "100.00",
        withholdingAmount: "30.00",
      }),
    );
    expect(screen.getByTestId("transaction-edit-gross-amount")).toBeInTheDocument();
    // The credited amount, labelled as at create — never the transfers' « Valeur de marché ».
    expect(screen.getByLabelText(/^Montant/)).toBe(
      screen.getByTestId("transaction-edit-gross-amount"),
    );
    expect(screen.queryByLabelText(/Valeur de marché/)).not.toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-withholding-amount")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-reference")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-instrument-search")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-quantity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-unit-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-fee-amount")).not.toBeInTheDocument();
  });

  // portfolio-cash (AC-587): the table is not exhaustive by type,
  // so a FEE with no entry would open a drawer with zero fields.
  it("a FEE's form offers its amount, its instrument reference, its account and its note — no quantity, price, fee or withholding", () => {
    renderForm(
      transaction({
        kind: "FEE",
        quantity: null,
        unitPrice: null,
        grossAmount: "12.50",
        note: "Frais de garde T3",
      }),
    );
    expect(screen.getByTestId("transaction-edit-gross-amount")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Montant/)).toBe(
      screen.getByTestId("transaction-edit-gross-amount"),
    );
    expect(screen.getByTestId("transaction-edit-instrument-search")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-cash-account")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-note")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-quantity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-unit-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-fee-amount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-withholding-amount")).not.toBeInTheDocument();
  });
});

/**
 * `security-transfer` TR-21 (OD-6 (a), ND-3 (a), ND-4 (a),
 * ND-5 (b)). A `TRANSFER_IN`'s editable set depends on whether it is still
 * linked to its source — the one row whose set is not a function of its kind.
 */
describe("<TransactionEditForm> — a security transfer's two legs (TR-21)", () => {
  const SOURCE_ID = "77777777-7777-4777-8777-777777777777";
  const TARGET_ID = "88888888-8888-4888-8888-888888888888";

  function transferLeg(overrides: Partial<TransactionResponse>): TransactionResponse {
    return transaction({
      kind: "TRANSFER_OUT",
      unitPrice: null,
      quantity: "0.01",
      grossAmount: "1240.8",
      txnCurrency: "EUR",
      cashAccountId: null,
      cashCurrency: null,
      cashAmount: null,
      ...overrides,
    });
  }

  it("a linked target offers exactly its note and reference — no quantity, value or time input exists", () => {
    renderForm(
      transferLeg({
        id: TARGET_ID,
        kind: "TRANSFER_IN",
        portfolioId: OTHER_PORTFOLIO_ID,
        transferLinkedTransactionId: SOURCE_ID,
        transferLinkedPortfolioId: PORTFOLIO_ID,
        transferCostBase: "660",
        transferCostNative: "660",
        transferCostCurrency: "EUR",
      }),
    );
    expect(screen.getByTestId("transaction-edit-note")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-reference")).toBeInTheDocument();
    for (const absent of [
      "transaction-edit-quantity",
      "transaction-edit-gross-amount",
      "transaction-edit-trade-date",
      "transaction-edit-trade-time",
      "transaction-edit-instrument-search",
      "transaction-edit-unit-price",
      "transaction-edit-cash-account",
    ]) {
      expect(screen.queryByTestId(absent), absent).not.toBeInTheDocument();
    }
    expect(screen.getByTestId("transaction-edit-transfer-target-note")).toBeInTheDocument();
  });

  it("the source offers its quantity and its market value, and saving a new value sends grossAmount", async () => {
    mockedApiClient.editTransaction.mockResolvedValue(transferLeg({ grossAmount: "1000" }));
    renderForm(
      transferLeg({
        id: SOURCE_ID,
        transferLinkedTransactionId: TARGET_ID,
        transferLinkedPortfolioId: OTHER_PORTFOLIO_ID,
      }),
    );
    expect(screen.getByTestId("transaction-edit-quantity")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-gross-amount")).toHaveValue("1240.8");
    expect(screen.queryByTestId("transaction-edit-instrument-search")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-transfer-target-note")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("transaction-edit-gross-amount"), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() =>
      expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(SOURCE_ID, {
        grossAmount: "1000",
      }),
    );
  });

  it("an emptied market value blocks the save rather than sending nothing", () => {
    renderForm(transferLeg({ id: SOURCE_ID }));
    fireEvent.change(screen.getByTestId("transaction-edit-gross-amount"), {
      target: { value: "" },
    });
    expect(screen.getByText("Saisissez la valeur de marché.")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-submit")).toBeDisabled();
  });

  it("ND-3 (a): a severed target edits its quantity and value like a standalone row", () => {
    renderForm(
      transferLeg({
        id: TARGET_ID,
        kind: "TRANSFER_IN",
        transferLinkedTransactionId: null,
        transferLinkedPortfolioId: null,
        transferCostBase: "660",
        transferCostNative: "660",
        transferCostCurrency: "EUR",
      }),
    );
    expect(screen.getByTestId("transaction-edit-quantity")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-gross-amount")).toBeInTheDocument();
    // The time of day is editable, the date is not (C4: a transfer's date is its pair's).
    expect(screen.getByTestId("transaction-edit-trade-time")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-trade-date")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-transfer-target-note")).not.toBeInTheDocument();
  });

  it("buildTransactionEditBody drops a linked target's quantity even if it were dirty", () => {
    const linked = transferLeg({ kind: "TRANSFER_IN", transferLinkedTransactionId: SOURCE_ID });
    const values = { ...defaultTransactionEditFormValues(linked), quantity: "0.02", note: "reçu" };
    expect(buildTransactionEditBody(linked, values, { quantity: true, note: true })).toEqual({
      note: "reçu",
    });
    // The same dirty set on a severed target keeps both.
    const severed = { ...linked, transferLinkedTransactionId: null };
    expect(buildTransactionEditBody(severed, values, { quantity: true, note: true })).toEqual({
      quantity: "0.02",
      note: "reçu",
    });
  });
});

describe("buildTransactionEditBody — only dirty fields are ever sent", () => {
  it("returns an empty object when no field is dirty", () => {
    const values = defaultTransactionEditFormValues(transaction());
    expect(buildTransactionEditBody("BUY", values, {})).toEqual({});
  });

  it("includes only the dirty quantity field, converted/trimmed", () => {
    const values = { ...defaultTransactionEditFormValues(transaction()), quantity: "15" };
    expect(buildTransactionEditBody("BUY", values, { quantity: true })).toEqual({ quantity: "15" });
  });

  it("a blanked nullable field sends null, not an empty string", () => {
    const values = { ...defaultTransactionEditFormValues(transaction()), note: "" };
    expect(buildTransactionEditBody("BUY", values, { note: true })).toEqual({ note: null });
  });

  // The reference edits exactly as the note does — trimmed when
  // set, `null` when emptied (never absent, which would mean "leave it alone"),
  // and only when the user actually touched it.
  it("the reference is set trimmed, cleared as null, and left out when untouched", () => {
    const base = defaultTransactionEditFormValues(transaction({ reference: "ORD-41" }));
    expect(base.reference).toBe("ORD-41");

    expect(
      buildTransactionEditBody("BUY", { ...base, reference: "  ORD-42  " }, { reference: true }),
    ).toEqual({ reference: "ORD-42" });
    expect(
      buildTransactionEditBody("BUY", { ...base, reference: "" }, { reference: true }),
    ).toEqual({ reference: null });
    // Untouched: not in the body at all, so a user editing a quantity cannot
    // silently resubmit (or clear) a reference they never looked at.
    expect(
      buildTransactionEditBody("BUY", { ...base, quantity: "15" }, { quantity: true }),
    ).toEqual({ quantity: "15" });
  });

  it("every kind that has an edit form can edit the reference — it belongs to none of the per-kind rules", () => {
    // The per-kind table gates each field, and a reference left out of one
    // kind's row would silently drop from that kind's PATCH body.
    for (const kind of [
      "BUY",
      "SELL",
      "DRIP",
      "DEPOSIT",
      "WITHDRAWAL",
      "DIVIDEND",
      "CURRENCY_EXCHANGE",
    ]) {
      const values = { ...defaultTransactionEditFormValues(transaction()), reference: "ORD-42" };
      expect(buildTransactionEditBody(kind, values, { reference: true })).toEqual({
        reference: "ORD-42",
      });
    }
  });
});

/**
 * Reshaped: the form now holds a date and a time of day, rendered from the
 * stored instant's **local** wall-clock components and recombined on submit with the create form's
 * own expression (`new Date(`${date}T${time}`)`, parsed as local time). The two halves must agree on
 * one timezone convention, so these assert the round-tripped instant, never a raw wire literal.
 */
describe("trade date and time (one body rule, local wall-clock both ways)", () => {
  const WITH_TIME = transaction({ tradeDate: "2026-08-01", tradeTs: "2026-08-01T09:30:00.000Z" });
  const localTime = (iso: string): string => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  it("renders the stored date and the local time of the stored instant", () => {
    const values = defaultTransactionEditFormValues(WITH_TIME);
    expect(values.tradeDate).toBe("2026-08-01");
    expect(values.tradeTime).toBe(localTime("2026-08-01T09:30:00.000Z"));
    expect(defaultTransactionEditFormValues(transaction({ tradeTs: null })).tradeTime).toBe("");
  });

  it("a stored instant, shown in the time control and submitted back as a dirty time, is the same instant", () => {
    const values = defaultTransactionEditFormValues(WITH_TIME);
    const body = buildTransactionEditBody(WITH_TIME, values, { tradeTime: true });
    expect(new Date(body["tradeTs"] as string).getTime()).toBe(
      new Date(`${WITH_TIME.tradeDate}T${values.tradeTime}`).getTime(),
    );
  });

  it("date dirty on a row with a time sends tradeDate and the recombined tradeTs", () => {
    const values = { ...defaultTransactionEditFormValues(WITH_TIME), tradeDate: "2026-03-05" };
    const body = buildTransactionEditBody(WITH_TIME, values, { tradeDate: true });
    expect(Object.keys(body).sort()).toEqual(["tradeDate", "tradeTs"]);
    expect(body["tradeDate"]).toBe("2026-03-05");
    const sent = new Date(body["tradeTs"] as string);
    expect(sent.getFullYear()).toBe(2026);
    expect(sent.getMonth()).toBe(2);
    expect(sent.getDate()).toBe(5);
    expect(
      `${String(sent.getHours()).padStart(2, "0")}:${String(sent.getMinutes()).padStart(2, "0")}`,
    ).toBe(localTime("2026-08-01T09:30:00.000Z"));
  });

  it("time dirty only sends tradeTs, at the entered local time, without tradeDate", () => {
    const values = { ...defaultTransactionEditFormValues(WITH_TIME), tradeTime: "14:37" };
    const body = buildTransactionEditBody(WITH_TIME, values, { tradeTime: true });
    expect(Object.keys(body)).toEqual(["tradeTs"]);
    const sent = new Date(body["tradeTs"] as string);
    expect(sent.getMonth()).toBe(7);
    expect(sent.getDate()).toBe(1);
    expect(sent.getHours()).toBe(14);
    expect(sent.getMinutes()).toBe(37);
  });

  it("date dirty on a row with no time and none entered sends tradeDate only, never an invented time", () => {
    const row = transaction({ tradeTs: null });
    const values = { ...defaultTransactionEditFormValues(row), tradeDate: "2026-03-05" };
    const body = buildTransactionEditBody(row, values, { tradeDate: true });
    expect(body).toEqual({ tradeDate: "2026-03-05" });
    expect("tradeTs" in body).toBe(false);
  });

  it("a time entered on a row that had none sends tradeTs", () => {
    const row = transaction({ tradeTs: null });
    const values = { ...defaultTransactionEditFormValues(row), tradeTime: "08:15" };
    const body = buildTransactionEditBody(row, values, { tradeTime: true });
    expect(Object.keys(body)).toEqual(["tradeTs"]);
    expect(new Date(body["tradeTs"] as string).getHours()).toBe(8);
  });

  it("a time blanked on a row that had one sends tradeTs: null", () => {
    const values = { ...defaultTransactionEditFormValues(WITH_TIME), tradeTime: "" };
    expect(buildTransactionEditBody(WITH_TIME, values, { tradeTime: true })).toEqual({
      tradeTs: null,
    });
  });

  it("a blanked time and a changed date send both: the new day, no time", () => {
    const values = {
      ...defaultTransactionEditFormValues(WITH_TIME),
      tradeDate: "2026-03-05",
      tradeTime: "",
    };
    expect(
      buildTransactionEditBody(WITH_TIME, values, { tradeDate: true, tradeTime: true }),
    ).toEqual({ tradeDate: "2026-03-05", tradeTs: null });
  });

  it("a linked TRANSFER_IN never sends a date or a time", () => {
    const linked = transaction({
      kind: "TRANSFER_IN",
      transferLinkedTransactionId: "77777777-7777-4777-8777-777777777777",
    });
    const values = {
      ...defaultTransactionEditFormValues(linked),
      tradeDate: "2026-03-05",
      tradeTime: "10:00",
    };
    expect(buildTransactionEditBody(linked, values, { tradeDate: true, tradeTime: true })).toEqual(
      {},
    );
  });

  it("a transfer source edits its time but never its date", () => {
    const out = transaction({ kind: "TRANSFER_OUT" });
    const values = {
      ...defaultTransactionEditFormValues(out),
      tradeDate: "2026-03-05",
      tradeTime: "10:00",
    };
    const body = buildTransactionEditBody(out, values, { tradeDate: true, tradeTime: true });
    expect(Object.keys(body)).toEqual(["tradeTs"]);
  });
});

describe("<TransactionEditForm> — date and time controls, amounts by row shape", () => {
  it("renders a date control and a time control in place of the locked date and the datetime-local input", () => {
    renderForm();
    const date = screen.getByTestId("transaction-edit-trade-date");
    const time = screen.getByTestId("transaction-edit-trade-time");
    expect(date).toHaveAttribute("type", "date");
    expect(date).toHaveValue("2026-08-01");
    expect(time).toHaveAttribute("type", "time");
    expect(screen.queryByTestId("transaction-edit-locked-trade-date")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-trade-ts")).not.toBeInTheDocument();
    // The currency lock stays.
    expect(screen.getByTestId("transaction-edit-locked-currency")).toBeInTheDocument();
  });

  it("changing the date sends tradeDate through the PATCH", async () => {
    mockedApiClient.editTransaction.mockResolvedValue(transaction());
    const row = transaction({ tradeTs: null });
    renderForm(row);
    fireEvent.change(screen.getByTestId("transaction-edit-trade-date"), {
      target: { value: "2026-03-05" },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    await waitFor(() =>
      expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(row.id, {
        tradeDate: "2026-03-05",
      }),
    );
  });

  it("a cleared date blocks the save", () => {
    renderForm();
    fireEvent.change(screen.getByTestId("transaction-edit-trade-date"), { target: { value: "" } });
    expect(screen.getByTestId("transaction-edit-submit")).toBeDisabled();
  });

  it("a BUY has no instrument picker", () => {
    renderForm();
    expect(screen.queryByTestId("transaction-edit-instrument-search")).not.toBeInTheDocument();
  });

  it("a settlement-priced BUY offers grossAmount and not unitPrice", () => {
    renderForm(
      transaction({
        txnSettlementInstrumentId: "99999999-9999-4999-8999-999999999999",
        unitPrice: "100",
        cashAccountId: null,
        txnCurrency: null,
      }),
    );
    expect(screen.getByTestId("transaction-edit-gross-amount")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-unit-price")).not.toBeInTheDocument();
  });

  it("a fiat-priced BUY offers unitPrice and not grossAmount", () => {
    renderForm();
    expect(screen.getByTestId("transaction-edit-unit-price")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-gross-amount")).not.toBeInTheDocument();
  });

  it("a DIVIDEND offers gross and withholding, never a fee, and no instrument picker", () => {
    renderForm(
      transaction({
        kind: "DIVIDEND",
        quantity: null,
        unitPrice: null,
        grossAmount: "50.00",
        feeAmount: null,
        withholdingAmount: "7.50",
      }),
    );
    expect(screen.getByTestId("transaction-edit-gross-amount")).toHaveValue("50.00");
    expect(screen.queryByTestId("transaction-edit-fee-amount")).not.toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-withholding-amount")).toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-instrument-search")).not.toBeInTheDocument();
  });

  it("a fee-less DIVIDEND hides the fee field, a fee-less BUY offers it, an asset-settled BUY does not", () => {
    const dividend = transaction({
      kind: "DIVIDEND",
      quantity: null,
      unitPrice: null,
      grossAmount: "50.00",
      feeAmount: null,
    });
    const { unmount } = render(
      (
        <QueryClientProvider client={new QueryClient()}>
          <TransactionEditForm transaction={dividend} onSaved={vi.fn()} onCancel={vi.fn()} />
        </QueryClientProvider>
      ) as ReactElement,
    );
    expect(screen.queryByTestId("transaction-edit-fee-amount")).not.toBeInTheDocument();
    unmount();

    const { unmount: unmountBuy } = render(
      (
        <QueryClientProvider client={new QueryClient()}>
          <TransactionEditForm transaction={transaction()} onSaved={vi.fn()} onCancel={vi.fn()} />
        </QueryClientProvider>
      ) as ReactElement,
    );
    expect(screen.getByTestId("transaction-edit-fee-amount")).toBeInTheDocument();
    unmountBuy();

    renderForm(
      transaction({
        txnSettlementInstrumentId: "99999999-9999-4999-8999-999999999999",
        cashAccountId: null,
        txnCurrency: null,
      }),
    );
    expect(screen.queryByTestId("transaction-edit-fee-amount")).not.toBeInTheDocument();
  });

  it("INTEREST still offers its withholding, and gets a date and a time", () => {
    renderForm(
      transaction({
        kind: "INTEREST",
        instrumentId: null,
        quantity: null,
        unitPrice: null,
        grossAmount: "100.00",
        withholdingAmount: "30.00",
      }),
    );
    expect(screen.getByTestId("transaction-edit-withholding-amount")).toBeInTheDocument();
    expect(screen.getByTestId("transaction-edit-trade-date")).toBeInTheDocument();
  });

  it("a DIVIDEND gross edit sends only grossAmount", async () => {
    const row = transaction({
      kind: "DIVIDEND",
      quantity: null,
      unitPrice: null,
      grossAmount: "50.00",
    });
    mockedApiClient.editTransaction.mockResolvedValue(row);
    renderForm(row);
    fireEvent.change(screen.getByTestId("transaction-edit-gross-amount"), {
      target: { value: "60.00" },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    await waitFor(() =>
      expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(row.id, {
        grossAmount: "60.00",
      }),
    );
  });
});

describe("<TransactionEditForm> — AC98: editing quantity calls PATCH /transactions/:id and invalidates", () => {
  it("submits only the dirty quantity field and invalidates portfolios + transactions on success", async () => {
    mockedApiClient.editTransaction.mockResolvedValue(transaction({ quantity: "20" }));
    const { onSaved } = renderForm();

    fireEvent.change(screen.getByTestId("transaction-edit-quantity"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(
      "44444444-4444-4444-4444-444444444444",
      { quantity: "20" },
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockedInvalidateDerived.invalidatePortfolioDerivedFigures).toHaveBeenCalledWith(
      expect.anything(),
      { epochWillAdvance: true },
    );
  });

  it("the submit button is disabled with no dirty field", () => {
    renderForm();
    expect(screen.getByTestId("transaction-edit-submit")).toBeDisabled();
  });
});

describe("<TransactionEditForm> — AC99: six distinct refusal codes each show the UR-6-mapped message", () => {
  const CASES: readonly string[] = [
    "TRANSACTION_FX_EDIT_FORBIDDEN",
    "TRANSACTION_EDIT_EMPTY",
    "TRANSACTION_GROSS_AMOUNT_NOT_EDITABLE",
    "TRANSACTION_UNIT_PRICE_NOT_EDITABLE",
    "TRANSACTION_EDIT_NOT_EXPRESSIBLE",
    "TRANSACTION_INVALID_SHAPE",
  ];

  it.each(CASES)("%s renders its own inline message, never a raw payload", async (code) => {
    mockedApiClient.editTransaction.mockRejectedValue(
      new ApiError(code === "TRANSACTION_EDIT_NOT_EXPRESSIBLE" ? 422 : 400, {
        title: "rejected",
        code,
        detail: "raw server detail that must never render",
      }),
    );
    renderForm();
    fireEvent.change(screen.getByTestId("transaction-edit-quantity"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("transaction-edit-submit-error")).toBeInTheDocument(),
    );
    const text = screen.getByTestId("transaction-edit-submit-error").textContent ?? "";
    expect(text).not.toContain("raw server detail");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("<TransactionEditForm> — field-level server errors", () => {
  it("a refused date edit renders the message under the date control, focuses it, and keeps the form open", async () => {
    mockedApiClient.editTransaction.mockRejectedValue(
      new ApiError(400, {
        title: "rejected",
        code: "TRANSACTION_TRADE_DATE_IN_FUTURE",
        detail: "raw",
      }),
    );
    const { onSaved } = renderForm();
    fireEvent.change(screen.getByTestId("transaction-edit-trade-date"), {
      target: { value: "2026-03-05" },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    const date = screen.getByTestId("transaction-edit-trade-date");
    await waitFor(() => expect(date).toHaveAttribute("aria-invalid", "true"));
    const message = document.getElementById(date.getAttribute("aria-describedby") ?? "");
    expect(message).toHaveTextContent(/futur/i);
    expect(date).toHaveFocus();
    expect(screen.queryByTestId("transaction-edit-submit-error")).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("an unmapped refusal stays in the banner, which sits above the first field", async () => {
    mockedApiClient.editTransaction.mockRejectedValue(
      new ApiError(400, { title: "rejected", code: "TRANSACTION_INVALID_SHAPE", detail: "raw" }),
    );
    renderForm();
    fireEvent.change(screen.getByTestId("transaction-edit-quantity"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    const banner = await screen.findByTestId("transaction-edit-submit-error");
    const date = screen.getByTestId("transaction-edit-trade-date");
    expect(banner.compareDocumentPosition(date) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an unmapped refusal moves focus to the banner so a scrolled drawer shows it", async () => {
    mockedApiClient.editTransaction.mockRejectedValue(
      new ApiError(400, { title: "rejected", code: "TRANSACTION_INVALID_SHAPE", detail: "raw" }),
    );
    renderForm();
    fireEvent.change(screen.getByTestId("transaction-edit-quantity"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    const banner = await screen.findByTestId("transaction-edit-submit-error");
    await waitFor(() => expect(banner).toHaveFocus());
    expect(banner).toHaveAttribute("tabindex", "-1");
  });

  it("the net-below-zero guard lands on the dirty withholding field", async () => {
    mockedApiClient.editTransaction.mockRejectedValue(
      new ApiError(400, {
        title: "rejected",
        code: "TRANSACTION_ARGUMENT_INVALID",
        detail: "withholdingAmount must be less than the principal cash amount",
      }),
    );
    renderForm(
      transaction({
        kind: "DIVIDEND",
        quantity: null,
        unitPrice: null,
        withholdingAmount: "5.00",
        cashCurrency: "EUR",
      }),
    );
    fireEvent.change(screen.getByTestId("transaction-edit-withholding-amount"), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    const field = screen.getByTestId("transaction-edit-withholding-amount");
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveFocus();
    expect(screen.queryByTestId("transaction-edit-submit-error")).not.toBeInTheDocument();
  });
});

describe("<TransactionEditForm> — non-optimistic", () => {
  it("the pre-mutation cached transaction detail is untouched while the request is still pending", async () => {
    let resolveEdit: (value: TransactionResponse) => void = () => {};
    mockedApiClient.editTransaction.mockReturnValue(
      new Promise((resolve) => {
        resolveEdit = resolve;
      }),
    );

    const original = transaction();
    const { queryClient, onSaved } = renderForm(original);
    queryClient.setQueryData(["transactions", original.id], original);

    fireEvent.change(screen.getByTestId("transaction-edit-quantity"), { target: { value: "999" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    // Mid-flight: the cached detail must still read the pre-mutation value —
    // no optimistic write ever touched it.
    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData(["transactions", original.id])).toEqual(original);
    expect(onSaved).not.toHaveBeenCalled();

    resolveEdit(transaction({ quantity: "999" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

/**
 * CA-21 — `CashAccountPicker` at the **edit** entry point.
 *
 * Every one of CD12's five behaviours is re-tested here **independently**,
 * not inferred from `TransactionForm.test.tsx`'s create-path coverage. RC6:
 * this project's most user-visible defect of a prior cycle was a shared
 * dialog that worked from one entry point and silently did nothing from the
 * second, with every per-task test passing. The component is written to have
 * no per-mount-site branch; that is an argument, and this suite is the proof.
 *
 * Every test here carries an archived-account fixture (the default
 * `transaction()` is attributed to `ARCHIVED_EUR_ID`), because hiding an
 * archived-but-attributed account on this form would silently misrepresent an
 * existing record — and `buildTransactionEditBody` sends only *dirty* fields,
 * so the damage would surface only on the day the user edited an unrelated
 * note.
 */
describe("<TransactionEditForm> — CashAccountPicker at the edit entry point (CD12, RC6)", () => {
  it("behaviour 1 — portfolio-scoped: reads this transaction's own portfolio, never another", async () => {
    renderForm(transaction({ portfolioId: OTHER_PORTFOLIO_ID }));

    await waitFor(() =>
      expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalledWith(
        OTHER_PORTFOLIO_ID,
        expect.anything(),
      ),
    );
    expect(mockedApiClient.fetchPortfolioCash).not.toHaveBeenCalledWith(
      PORTFOLIO_ID,
      expect.anything(),
    );
  });

  /**
   * **Two CD12 cases removed here (FR-260), and the removal is the point.**
   *
   * "behaviour 2 — the fee leg is still currency-filtered" and "the fee slot's
   * inline creation still pins the currency" both exercised the « Compte espèce
   * des frais » picker on this form. **That picker is gone** (FT-44, L5/L6,
   * a cost leaves the settling account, so there is no second
   * account to pick and no currency to pin it to.
   *
   * Retargeting them at the withholding slot would have been the tempting move
   * and the wrong one — and that slot was removed too. The behaviours
   * themselves are not lost: CD12's currency filter and its locked-currency
   * inline creation are still asserted, on CURRENCY_EXCHANGE's target slot, in
   * `TransactionForm.test.tsx`.
   *
   * The case below is what replaces them: the picker is absent, and the field
   * is absent from `EDITABLE_FIELDS_BY_KIND` too — a listed field with no
   * control would advertise an edit nothing can perform.
   */
  it("FT-44 — the fee cash-account picker is gone from the edit form, and from the editable-field table", async () => {
    renderForm(transaction({ feeAmount: "5.00" }));
    await waitFor(() => expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalled());

    expect(screen.queryByTestId("transaction-edit-fee-cash-account")).toBeNull();
    // The fee amount itself is still editable — L9 defers the form, it does not
    // remove the field this one always had.
    expect(screen.getByTestId("transaction-edit-fee-amount")).toBeInTheDocument();

    for (const kind of Object.keys(EDITABLE_FIELDS_BY_KIND)) {
      expect(EDITABLE_FIELDS_BY_KIND[kind]).not.toContain("feeCashAccountId");
    }
    // …and the principal slot is untouched, so the removal was surgical.
    expect(screen.getByTestId("transaction-edit-cash-account")).toBeInTheDocument();
  });

  it("behaviour 3 — THE edit-path case: the archived account this transaction is attributed to is still offered, still selected, and labelled « (archivé) »", async () => {
    renderForm();
    await waitForPickerOptions("transaction-edit-cash-account");

    // Offered…
    expect(offeredAccountIds("transaction-edit-cash-account")).toContain(ARCHIVED_EUR_ID);
    // …labelled…
    expect(offeredAccountLabels("transaction-edit-cash-account")).toContain("Ancien EUR (archivé)");
    // …and actually selected, which is the half a "the option exists" test
    // misses: the defect this guards against blanks the *selection*, not the
    // option list.
    expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(ARCHIVED_EUR_ID);
    // The active sibling is offered without the marking — the positive
    // companion that proves « (archivé) » is per account, not decoration.
    expect(offeredAccountLabels("transaction-edit-cash-account")).toContain("Compte EUR");
  });

  it("behaviour 3, negative half — an archived account this transaction is NOT attributed to is never offered", async () => {
    renderForm(transaction({ cashAccountId: ACTIVE_EUR_ID }));
    await waitForPickerOptions("transaction-edit-cash-account");

    expect(offeredAccountIds("transaction-edit-cash-account")).toContain(ACTIVE_EUR_ID);
    expect(offeredAccountIds("transaction-edit-cash-account")).not.toContain(ARCHIVED_EUR_ID);
  });

  it("behaviour 3, the invariant it protects — opening and closing the form without touching a picker sends no cash-account field at all", async () => {
    mockedApiClient.editTransaction.mockResolvedValue(transaction({ note: "revu" }));
    renderForm();
    await waitForPickerOptions("transaction-edit-cash-account");

    fireEvent.change(screen.getByTestId("transaction-edit-note"), { target: { value: "revu" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    // `toEqual` ignores `undefined` properties, so this is written as an
    // exact-body assertion rather than "cashAccountId is undefined".
    expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(
      "44444444-4444-4444-4444-444444444444",
      { note: "revu" },
    );
  });

  it("behaviour 4 — inline creation is offered when no active account exists in the leg's currency", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(
      cashResponse([
        cashAccount({ id: ARCHIVED_EUR_ID, name: "Ancien EUR", currency: "EUR", archived: true }),
      ]),
    );
    renderForm();

    await waitFor(() =>
      expect(screen.getByTestId("transaction-edit-cash-account-empty")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("transaction-edit-cash-account-create")).toBeInTheDocument();
    // …and the archived, attributed account is *still* selected while that
    // offer is showing: the user is not silently detached from their own row
    // just because nothing active is available.
    expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(ARCHIVED_EUR_ID);
  });

  // QE (independent) — the developer's own "behaviour 4" test above only
  // asserts the create affordance is offered at this SECOND entry point; it
  // never clicks through the dialog. `TransactionForm.test.tsx`'s sibling
  // "behaviour 4" test does the full click -> fill -> submit -> selected
  // round trip at the CREATE entry point. This is exactly the pattern this
  // project's own record calls out as its worst-defect class (RC6): a shared
  // dialog that works from entry point one and silently does nothing from
  // entry point two, because a per-task suite only exercises the entry point
  // its own task added. This test exercises the missing half independently,
  // and additionally checks the created id actually reaches the PATCH body
  // (not merely the picker's displayed value) — the failure mode a
  // dev suite could pass while still dropping the attribution on submit.
  it("QE — inline creation's full round trip ALSO works from the edit-form entry point, and the new id reaches the PATCH body", async () => {
    const NEW_EUR_ID = "99999999-9999-4999-8999-999999999999";
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(
      cashResponse([
        cashAccount({ id: ARCHIVED_EUR_ID, name: "Ancien EUR", currency: "EUR", archived: true }),
      ]),
    );
    mockedApiClient.createCashAccount.mockImplementation(async () => {
      mockedApiClient.fetchPortfolioCash.mockResolvedValue(
        cashResponse([
          cashAccount({ id: ARCHIVED_EUR_ID, name: "Ancien EUR", currency: "EUR", archived: true }),
          cashAccount({ id: NEW_EUR_ID, name: "Nouveau EUR", currency: "EUR" }),
        ]),
      );
      return {
        id: NEW_EUR_ID,
        name: "Nouveau EUR",
        currency: "EUR",
        archived: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
    });
    mockedApiClient.editTransaction.mockResolvedValue(transaction({ cashAccountId: NEW_EUR_ID }));

    renderForm();

    await waitFor(() =>
      expect(screen.getByTestId("transaction-edit-cash-account-create")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("transaction-edit-cash-account-create"));

    expect(await screen.findByTestId("cash-account-form-dialog")).toBeVisible();
    // **Shape-changed**: this slot's filter is gone, so the dialog no
    // longer pins the transaction's currency onto the new account — it offers
    // the choice, which is the whole point of a leg that may be settled in
    // another currency.
    //
    // The locked-currency treatment is asserted on the slots that **do** still
    // filter: `CashAccountPicker.test.tsx` ("pins the currency…") and
    // `TransactionForm.test.tsx`'s behaviour-4 case, on CURRENCY_EXCHANGE's
    // target slot (the withholding slot it named has since been removed).
    // This comment used to say "the fee slot, which keeps its filter (the test
    // below)" — FT-44 removed that slot from this form and there is no test
    // below, so the justification pointed at nothing. The behaviour was
    // never uncovered; only the pointer was wrong, which under AC-253 is itself
    // the defect: a justification exists to be checked.
    const currencySelect = screen.getByTestId("cash-account-currency-select");
    expect(screen.queryByTestId("cash-account-locked-currency")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        Array.from((currencySelect as HTMLSelectElement).options).map((o) => o.value),
      ).toContain("EUR"),
    );
    fireEvent.change(currencySelect, { target: { value: "EUR" } });

    fireEvent.change(screen.getByTestId("cash-account-name-input"), {
      target: { value: "Nouveau EUR" },
    });
    fireEvent.submit(screen.getByTestId("cash-account-form"));

    await waitFor(() =>
      expect(mockedApiClient.createCashAccount).toHaveBeenCalledWith(PORTFOLIO_ID, {
        name: "Nouveau EUR",
        currency: "EUR",
      }),
    );
    // The dialog closes and the picker now shows the freshly created account
    // selected — the same assertion the create-form test makes.
    await waitFor(() =>
      expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(NEW_EUR_ID),
    );

    // The part the developer's "behaviour 4" test never reached: does
    // *submitting the edit form* actually carry the new id to the API, or
    // does the picker merely display a selection the form's own dirty-field
    // tracking never picked up?
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(
      "44444444-4444-4444-4444-444444444444",
      { cashAccountId: NEW_EUR_ID },
    );
  });

  it("behaviour 5 — a sole active match preselects on an unattributed leg, and two or more preselect nothing", async () => {
    // A CURRENCY_EXCHANGE: EUR source (one active account after the archived
    // one is filtered out -> prefill would apply, but the row is already
    // attributed) and a USD target with two candidates.
    renderForm(
      transaction({
        kind: "CURRENCY_EXCHANGE",
        instrumentId: null,
        quantity: null,
        unitPrice: null,
        txnCurrency: "EUR",
        cashAccountId: ARCHIVED_EUR_ID,
        targetCurrency: "USD",
        targetAmount: "1100.00",
        targetCashAccountId: ACTIVE_USD_ID,
      }),
    );
    await waitForPickerOptions("transaction-edit-target-cash-account");

    // Two USD candidates, and the row's own attribution is what is selected —
    // never a prefill overriding it.
    expect(offeredAccountIds("transaction-edit-target-cash-account")).toEqual([
      ACTIVE_USD_ID,
      SECOND_USD_ID,
    ]);
    expect(screen.getByTestId("transaction-edit-target-cash-account")).toHaveValue(ACTIVE_USD_ID);
    // The source leg keeps its archived account (behaviour 3, at the second
    // slot of the same form).
    expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(ARCHIVED_EUR_ID);
  });

  it("re-attributing the principal leg sends exactly that one field, and only that one", async () => {
    mockedApiClient.editTransaction.mockResolvedValue(
      transaction({ cashAccountId: ACTIVE_EUR_ID }),
    );
    renderForm();
    await waitForPickerOptions("transaction-edit-cash-account");

    fireEvent.change(screen.getByTestId("transaction-edit-cash-account"), {
      target: { value: ACTIVE_EUR_ID },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() =>
      expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(
        "44444444-4444-4444-4444-444444444444",
        { cashAccountId: ACTIVE_EUR_ID },
      ),
    );
  });

  /**
   * The per-row gate, not only the per-kind one: an asset-settled BUY has no
   * cash principal leg at all (FR-157), so offering a picker there would offer
   * a guaranteed 400. Its fee leg, if it has one, still does.
   */
  /**
   * FR-260: the second half read "while its fee picker (a real cash leg)
   * remains". FT-44 removed that picker (L5), so the surviving claim is
   * FR-157's — an asset-settled row names no principal cash account — with the
   * fee *amount* standing in as the positive companion, so "no picker" cannot
   * be satisfied by a form that rendered nothing at all.
   */
  it("an asset-settled BUY renders no principal picker, while its cost is still editable", async () => {
    renderForm(
      transaction({
        txnCurrency: null,
        cashAccountId: null,
        txnSettlementInstrumentId: "33333333-3333-4333-8333-333333333333",
        feeAmount: "2.00",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("transaction-edit-fee-amount")).toBeInTheDocument(),
    );

    expect(screen.queryByTestId("transaction-edit-cash-account")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-fee-cash-account")).toBeNull();
    expect(screen.getByTestId("transaction-edit-fee-amount")).toHaveValue("2.00");
  });

  it("a BUY with no fee leg renders no fee picker — this endpoint cannot add a leg the row never had (CA-10)", async () => {
    renderForm();
    await waitForPickerOptions("transaction-edit-cash-account");

    expect(screen.queryByTestId("transaction-edit-fee-cash-account")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-wht-cash-account")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-target-cash-account")).not.toBeInTheDocument();
  });

  // The withholding is denominated by the settling account — no picker
  // of its own, and its amount reads in the account's currency, not the gross's.
  it("a DIVIDEND with a withholding gets no withholding picker, and its amount reads in the settling account's currency", async () => {
    renderForm(
      transaction({
        kind: "DIVIDEND",
        quantity: null,
        unitPrice: null,
        grossAmount: "3.65",
        txnCurrency: "USD",
        cashAccountId: ARCHIVED_EUR_ID,
        cashCurrency: "EUR",
        withholdingAmount: "0.51",
      }),
    );
    await waitForPickerOptions("transaction-edit-cash-account");

    const withholding = screen.getByTestId("transaction-edit-withholding-amount");
    expect(withholding).toHaveValue("0.51");
    expect(withholding.parentElement?.querySelector(".k-input-suffix")?.textContent).toBe("EUR");
    expect(screen.queryByTestId("transaction-edit-wht-cash-account")).toBeNull();
    expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(ARCHIVED_EUR_ID);
  });
});

/**
 * CA-21's own acceptance criterion: DEPOSIT/WITHDRAWAL previously allowed
 * only `note`/`tradeTs`, so this is their **first substantive editable
 * field** — and the criterion says explicitly that a re-render of a disabled
 * control does not satisfy it. Hence: change it, submit, assert the wire body.
 */
describe("<TransactionEditForm> — DEPOSIT/WITHDRAWAL gain their first substantive editable field (CA-21)", () => {
  it.each(["DEPOSIT", "WITHDRAWAL"] as const)(
    "%s: the cash account is editable and the change reaches PATCH /transactions/:id",
    async (kind) => {
      mockedApiClient.editTransaction.mockResolvedValue(transaction({ kind }));
      renderForm(
        transaction({
          kind,
          instrumentId: null,
          quantity: null,
          unitPrice: null,
          txnCurrency: "EUR",
          cashAccountId: ARCHIVED_EUR_ID,
        }),
      );
      await waitForPickerOptions("transaction-edit-cash-account");

      const picker = screen.getByTestId("transaction-edit-cash-account");
      // Not a disabled re-render: it is enabled, it holds the row's own
      // (archived) attribution, and it can be changed.
      expect(picker).not.toBeDisabled();
      expect(picker).toHaveValue(ARCHIVED_EUR_ID);
      expect(screen.getByTestId("transaction-edit-submit")).toBeDisabled();

      fireEvent.change(picker, { target: { value: ACTIVE_EUR_ID } });

      expect(screen.getByTestId("transaction-edit-submit")).not.toBeDisabled();
      fireEvent.click(screen.getByTestId("transaction-edit-submit"));

      await waitFor(() =>
        expect(mockedApiClient.editTransaction).toHaveBeenCalledWith(
          "44444444-4444-4444-4444-444444444444",
          { cashAccountId: ACTIVE_EUR_ID },
        ),
      );
    },
  );

  it("still offers no quantity/unitPrice control on a DEPOSIT — the new field is additive, not a relaxation", () => {
    renderForm(
      transaction({
        kind: "DEPOSIT",
        instrumentId: null,
        quantity: null,
        unitPrice: null,
        cashAccountId: ARCHIVED_EUR_ID,
      }),
    );
    expect(screen.queryByTestId("transaction-edit-quantity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-unit-price")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-instrument-search")).not.toBeInTheDocument();
  });
});

/**
 * The cross-currency row at this, the **second**, entry point.
 *
 * FT-20/FT-21 turned the picker's currency filter off at the create form only,
 * so on a row settled from a differently-denominated account this form filtered
 * the leg's own account out of its own picker: the select blanked and the empty
 * state offered «Créer un compte en USD», the sentence phase 1 removes. That is
 * the RC6 class this file's header is written against, and these tests are the
 * fixture it lacked: both entry points, both ways.
 *
 * The row throughout is AC-264's: BUY 10 AAPL at 150,00 USD (gross 1 500,00),
 * `fxRate` 0,92, settled from a EUR account for 1 380,00 EUR — case **D4**.
 */
describe("<TransactionEditForm> — the settlement pair at the edit entry point", () => {
  const CHF_ACCOUNT_ID = "7c7c7c7c-7777-4777-8777-777777777ccc";

  /** AC-264's D4 row: USD trade, EUR (= base) settling account. */
  function d4Transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
    return transaction({
      quantity: "10",
      unitPrice: "150.00",
      grossAmount: "1500.00",
      txnCurrency: "USD",
      cashAccountId: ACTIVE_EUR_ID,
      cashCurrency: "EUR",
      cashAmount: "1380.00",
      fxRate: "0.92",
      fxRateSource: "USER_PINNED",
      ...overrides,
    });
  }

  /** A D3/D5 row: USD trade, CHF settling account — neither the trade's currency nor the base. */
  function d5Transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
    return d4Transaction({
      cashAccountId: CHF_ACCOUNT_ID,
      cashCurrency: "CHF",
      cashAmount: "1275.00",
      ...overrides,
    });
  }

  function settlementCashResponse() {
    return cashResponse([
      cashAccount({ id: ACTIVE_EUR_ID, name: "Compte EUR", currency: "EUR" }),
      cashAccount({ id: ACTIVE_USD_ID, name: "Compte USD", currency: "USD" }),
      cashAccount({ id: CHF_ACCOUNT_ID, name: "Compte CHF", currency: "CHF" }),
    ]);
  }

  function submittedBody(): Record<string, unknown> {
    const [, body] = mockedApiClient.editTransaction.mock.calls[0] ?? [];
    return body as Record<string, unknown>;
  }

  /**
   * The defect exactly as reported: a portfolio holding **only** the EUR
   * account the row already names. Every assertion is on one render, because
   * "the account is offered" and "the wrong-currency empty state is gone" are
   * two halves of one claim and either alone can pass while the row is
   * unusable.
   */
  it("the reported case: a portfolio holding only the EUR account still offers it, keeps it selected, and shows no « Créer un compte en USD »", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(
      cashResponse([cashAccount({ id: ACTIVE_EUR_ID, name: "Compte EUR", currency: "EUR" })]),
    );
    renderForm(d4Transaction());
    await waitForPickerOptions("transaction-edit-cash-account");

    expect(offeredAccountIds("transaction-edit-cash-account")).toEqual([ACTIVE_EUR_ID]);
    expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(ACTIVE_EUR_ID);
    expect(screen.queryByTestId("transaction-edit-cash-account-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-cash-account-create")).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("Créer un compte en USD");
  });

  it("with a USD sibling present, the attributed EUR account is still the selection — not silently swapped for the trade-currency one", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    renderForm(d4Transaction());
    await waitForPickerOptions("transaction-edit-cash-account");

    expect(offeredAccountIds("transaction-edit-cash-account")).toEqual([
      ACTIVE_EUR_ID,
      ACTIVE_USD_ID,
      CHF_ACCOUNT_ID,
    ]);
    expect(screen.getByTestId("transaction-edit-cash-account")).toHaveValue(ACTIVE_EUR_ID);
  });

  it("D4: the settled amount is shown, read-only and labelled as calculated — never an input", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    renderForm(d4Transaction());

    const derived = (await screen.findByTestId(
      "transaction-edit-cash-amount-derived",
    )) as HTMLInputElement;
    expect(derived.value).toBe("1380.00");
    expect(derived.readOnly).toBe(true);
    expect(document.querySelector(`label[for="${derived.id}"]`)?.textContent).toContain("calculé");
    // The server recomputes it (`#reconcileCashLeg`), so there is no input to
    // send and none is rendered.
    expect(screen.queryByTestId("transaction-edit-cash-amount")).not.toBeInTheDocument();
  });

  /**
   * The read-only D4 field took its `suffix` from the
   * *merged* (post-pick) currency and its `value` from the *stored* amount.
   * Those disagree the moment the picker moves: a CHF-settled row re-pointed to
   * the EUR base account showed "1275.00 EUR" — a figure that is 1 275 CHF, in
   * a unit it is not in. The hint saying it is recalculated on save does not
   * make the unit right.
   */
  it("re-pointing a CHF row to the base account shows the recomputed base figure, not the stored CHF one", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    renderForm(d5Transaction());
    await waitForPickerOptions("transaction-edit-cash-account");

    // Before: a D3/D5 row, so the settled amount is an input carrying the
    // broker's own CHF figure.
    expect((screen.getByTestId("transaction-edit-cash-amount") as HTMLInputElement).value).toBe(
      "1275.00",
    );

    // Re-point to the EUR base account: this becomes D4, so the field turns
    // read-only and derived.
    fireEvent.change(screen.getByTestId("transaction-edit-cash-account"), {
      target: { value: ACTIVE_EUR_ID },
    });

    const derived = (await screen.findByTestId(
      "transaction-edit-cash-amount-derived",
    )) as HTMLInputElement;
    // 1 500,00 USD × 0,92 = 1 380,00 EUR — the product the server will write,
    // from the two factors already on the row.
    expect(derived.value).toBe("1380");
    // The bug: the stored CHF figure under a EUR suffix.
    expect(derived.value).not.toBe("1275.00");
  });

  it("a degenerate row renders no settlement control at all, and an unrelated edit sends exactly what it always did", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    mockedApiClient.editTransaction.mockResolvedValue(transaction());
    renderForm(
      transaction({ cashAccountId: ACTIVE_EUR_ID, cashCurrency: "EUR", cashAmount: "1000.00" }),
    );
    await waitForPickerOptions("transaction-edit-cash-account");

    expect(screen.queryByTestId("transaction-edit-cash-amount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-cash-amount-derived")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("transaction-edit-note"), { target: { value: "revu" } });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));
    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toEqual({ note: "revu" });
  });

  it("re-pointing within the same currency sends the account and nothing else", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(
      cashResponse([
        cashAccount({ id: ACTIVE_EUR_ID, name: "Compte EUR", currency: "EUR" }),
        cashAccount({ id: ARCHIVED_EUR_ID, name: "Second EUR", currency: "EUR" }),
      ]),
    );
    mockedApiClient.editTransaction.mockResolvedValue(d4Transaction());
    renderForm(d4Transaction());
    await waitForPickerOptions("transaction-edit-cash-account");

    fireEvent.change(screen.getByTestId("transaction-edit-cash-account"), {
      target: { value: ARCHIVED_EUR_ID },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    // The leg's denomination did not move, so no second key: the body is what
    // this form sent for a re-point before phase 1 existed.
    expect(submittedBody()).toEqual({ cashAccountId: ARCHIVED_EUR_ID });
  });

  it("re-pointing D4 -> a CHF account asks for the settled amount, blocks the save until it is given, then sends all three fields", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    mockedApiClient.editTransaction.mockResolvedValue(d5Transaction());
    renderForm(d4Transaction());
    await waitForPickerOptions("transaction-edit-cash-account");

    fireEvent.change(screen.getByTestId("transaction-edit-cash-account"), {
      target: { value: CHF_ACCOUNT_ID },
    });

    // The read-only D4 display gives way to a real input, because on this path
    // the server passes a supplied figure through and refuses a stale one.
    const settled = (await screen.findByTestId("transaction-edit-cash-amount")) as HTMLInputElement;
    expect(screen.queryByTestId("transaction-edit-cash-amount-derived")).not.toBeInTheDocument();
    // Prefilled with the stored figure — which now describes the *old*
    // currency, so the form says so and refuses to save on it.
    expect(settled.value).toBe("1380.00");
    expect(screen.getByTestId("transaction-edit-submit")).toBeDisabled();
    expect(screen.getByText(/indiquez le montant réellement débité/i)).toBeInTheDocument();

    fireEvent.change(settled, { target: { value: "1275.00" } });
    await waitFor(() => expect(screen.getByTestId("transaction-edit-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toEqual({
      cashAccountId: CHF_ACCOUNT_ID,
      cashCurrency: "CHF",
      cashAmount: "1275.00",
    });
  });

  /**
   * The server's `CashAmountStaleError` made reachable-but-guided: on a D3/D5
   * row a gross that moves leaves the stored settled amount describing a gross
   * that no longer exists, and `#reconcileCashLeg` rejects the edit by name.
   * Before this fix the form could not satisfy that rule at all — it had no
   * control for the field the error names.
   */
  it("D3/D5: moving the gross requires the settled amount to be restated, and then sends it", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    mockedApiClient.editTransaction.mockResolvedValue(d5Transaction());
    renderForm(d5Transaction());
    await waitForPickerOptions("transaction-edit-cash-account");

    const settled = screen.getByTestId("transaction-edit-cash-amount") as HTMLInputElement;
    expect(settled.value).toBe("1275.00");
    // A note-only edit is untouched by the rule: it is the case where
    // every settlement figure stays byte-identical.
    fireEvent.change(screen.getByTestId("transaction-edit-note"), { target: { value: "revu" } });
    expect(screen.getByTestId("transaction-edit-submit")).toBeEnabled();

    // Moving the quantity moves the gross, and now it is not.
    fireEvent.change(screen.getByTestId("transaction-edit-quantity"), { target: { value: "8" } });
    await waitFor(() => expect(screen.getByTestId("transaction-edit-submit")).toBeDisabled());
    expect(screen.getByText(/montant brut a changé/i)).toBeInTheDocument();

    fireEvent.change(settled, { target: { value: "1020.00" } });
    await waitFor(() => expect(screen.getByTestId("transaction-edit-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toEqual({ note: "revu", quantity: "8", cashAmount: "1020.00" });
  });

  it("CURRENCY_EXCHANGE keeps its filtered picker and never renders a settlement control (FR-235)", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
    renderForm(
      transaction({
        kind: "CURRENCY_EXCHANGE",
        instrumentId: null,
        quantity: null,
        unitPrice: null,
        txnCurrency: "USD",
        targetCurrency: "EUR",
        targetAmount: "920.00",
        cashAccountId: ACTIVE_USD_ID,
        targetCashAccountId: ACTIVE_EUR_ID,
        cashCurrency: "USD",
        cashAmount: "1000.00",
      }),
    );
    await waitForPickerOptions("transaction-edit-cash-account");

    // Filtered: the source leg offers the USD account only.
    expect(offeredAccountIds("transaction-edit-cash-account")).toEqual([ACTIVE_USD_ID]);
    expect(screen.queryByTestId("transaction-edit-cash-amount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transaction-edit-cash-amount-derived")).not.toBeInTheDocument();
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).not.toContain("cashCurrency");
    expect(EDITABLE_FIELDS_BY_KIND["CURRENCY_EXCHANGE"]).not.toContain("cashAmount");
  });

  it("buildTransactionEditBody carries the settlement currency only when the caller states one, and never on CURRENCY_EXCHANGE", () => {
    const values = defaultTransactionEditFormValues(d4Transaction());

    // No change stated -> nothing on the wire, whatever the values hold.
    expect(buildTransactionEditBody("BUY", values, { cashAccountId: true })).toEqual({
      cashAccountId: ACTIVE_EUR_ID,
    });
    // Stated -> both keys.
    expect(buildTransactionEditBody("BUY", values, { cashAccountId: true }, "CHF")).toEqual({
      cashAccountId: ACTIVE_EUR_ID,
      cashCurrency: "CHF",
    });
    // FR-235: the kind table has no `cashCurrency` for a CURRENCY_EXCHANGE, so
    // even a caller that states one cannot put it on the wire.
    expect(
      buildTransactionEditBody("CURRENCY_EXCHANGE", values, { cashAccountId: true }, "CHF"),
    ).toEqual({ cashAccountId: ACTIVE_EUR_ID });
  });
});

/**
 * **`cash-interest` F-A1 safety (CI-T2 step 3).** Since `PATCH
 * /transactions/:id` refuses any body naming `kind` with `400
 * TRANSACTION_KIND_NOT_EDITABLE` — for every kind — the drawer must never send
 * one. Asserted on the body the real form actually submits, for an INTEREST
 * and for a DEPOSIT as the control.
 */
describe("<TransactionEditForm> — the PATCH body never names kind (cash-interest F-A1)", () => {
  function submittedBody(): Record<string, unknown> {
    const [, body] = mockedApiClient.editTransaction.mock.calls[0] ?? [];
    return body as Record<string, unknown>;
  }

  it("an INTEREST edit of its gross and withholding sends both, and no kind", async () => {
    const row = transaction({
      kind: "INTEREST",
      instrumentId: null,
      quantity: null,
      unitPrice: null,
      grossAmount: "100.00",
      withholdingAmount: "30.00",
    });
    mockedApiClient.editTransaction.mockResolvedValue(row);
    renderForm(row);

    fireEvent.change(screen.getByTestId("transaction-edit-gross-amount"), {
      target: { value: "120.00" },
    });
    fireEvent.change(screen.getByTestId("transaction-edit-withholding-amount"), {
      target: { value: "40.00" },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    const body = submittedBody();
    // Non-vacuous: the edit reached the wire …
    expect(body).toEqual({ grossAmount: "120.00", withholdingAmount: "40.00" });
    // … and the kind did not.
    expect(Object.keys(body)).not.toContain("kind");
  });

  it("control: a DEPOSIT's account re-point sends no kind either", async () => {
    const row = transaction({
      kind: "DEPOSIT",
      instrumentId: null,
      quantity: null,
      unitPrice: null,
      cashAccountId: ARCHIVED_EUR_ID,
    });
    mockedApiClient.editTransaction.mockResolvedValue(row);
    renderForm(row);
    await waitForPickerOptions("transaction-edit-cash-account");

    fireEvent.change(screen.getByTestId("transaction-edit-cash-account"), {
      target: { value: ACTIVE_EUR_ID },
    });
    fireEvent.click(screen.getByTestId("transaction-edit-submit"));

    await waitFor(() => expect(mockedApiClient.editTransaction).toHaveBeenCalledTimes(1));
    const body = submittedBody();
    expect(body).toEqual({ cashAccountId: ACTIVE_EUR_ID });
    expect(Object.keys(body)).not.toContain("kind");
  });
});
