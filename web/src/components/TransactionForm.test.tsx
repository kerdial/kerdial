import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// FR-T1/T-3: the create form's own resolver already validates against
// `createTransactionBodySchema`; imported here as well so the trade-time
// assertions can state what the *shared* schema makes of the derived
// `tradeTs` — the same schema `api` validates `POST /transactions` with.
import { createTransactionBodySchema, isoInstantAsDate } from "@kerdial/api-contracts";
import * as apiClient from "../lib/api-client.js";
import * as calcEpoch from "../lib/calc-epoch.js";
import {
  BASE_CURRENCY,
  buildTransactionRequestPayload,
  defaultTransactionFormValues,
  transferMarketValuePrefill,
  type TransactionFormValues,
} from "./TransactionForm.js";
import {
  ASSET_SETTLEMENT_TESTIDS,
  ESSENTIAL_TESTIDS,
  MORE_OPTIONS_TESTIDS,
  SETTLEMENT_TESTIDS,
} from "../lib/transaction-form-layout.js";
import {
  CASH_ACCOUNT_ID,
  CURRENCIES,
  INSTRUMENT_ID,
  OTHER_PORTFOLIO_ID,
  PORTFOLIO_ID,
  SECOND_USD_ACCOUNT_ID,
  SETTLEMENT_INSTRUMENT_ID,
  TARGET_CASH_ACCOUNT_ID,
  ARCHIVED_EUR_ACCOUNT_ID,
  cashAccount,
  cashResponse,
  choosePortfolio,
  fieldErrorText,
  markArchivedInCache,
  mockedApiClient,
  offeredAccountIds,
  optionPairs,
  pickInstrument,
  renderForm,
  resetHarness,
  selectCashAccount,
  selectCurrency,
  selectKind,
} from "./transaction-form-test-harness.js";

/**
 * T-44's five acceptance criteria, verified below (a
 * companion Playwright suite, `web/e2e/transaction-form.spec.ts`, proves
 * AC1/AC2 across the desktop/`iPhone 14` viewport projects — this file
 * covers the form's own validation/shape logic once, in jsdom, the way
 * `Figure.test.tsx` covers T-43's component logic).
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return {
    ...actual,
    fetchPortfolios: vi.fn(),
    searchInstruments: vi.fn(),
    createTransaction: vi.fn(),
    // CA-20: `CashAccountPicker`'s only read. Mocked here rather than in a
    // shared harness so each test can vary the account fixture (archived,
    // sole match, none in the currency) directly.
    fetchPortfolioCash: vi.fn(),
    createCashAccount: vi.fn(),
    // FR-T3/T-1: the four currency fields are `CurrencySelect`s now, and a
    // native `<select>` silently ignores a change to a value it carries no
    // `<option>` for — so this list is what makes every currency interaction
    // below able to happen at all.
    fetchCurrencies: vi.fn(),
    // `security-transfer` FR-576: the transfer tab's prefill read — the
    // source portfolio's own holdings.
    fetchPortfolioHoldings: vi.fn(),
    // The chips' presets, read on every
    // opening (an unmocked read is the failure path).
    fetchRatePresets: vi.fn(),
    saveRatePresets: vi.fn(),
  };
});
// `vi.mock` is hoisted per test file, so the mock above is declared here and
// in each suite split out of this one; the harness reads it via `vi.mocked`.

// The fixtures, render helper and drivers live in
// `transaction-form-test-harness.tsx` (AC-559 step (1)), shared with the
// suites split out of this file.

/**
 * F2 (security review, T-45, MEDIUM): wraps the *real*
 * `invalidateAndVerifyCalcEpoch` by default (so every pre-existing test
 * below, none of which cares about calcEpoch verification, keeps exercising
 * the real vacuous-`verified:true` path this isolated `QueryClient` always
 * takes — there is nothing cached under either prefix to ever be "stale").
 * Only the dedicated test below overrides it, to drive the
 * `calcEpochNotVerified` UI branch deterministically without needing real
 * query-cache staleness.
 */
vi.mock("../lib/calc-epoch.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/calc-epoch.js")>("../lib/calc-epoch.js");
  return { ...actual, invalidateAndVerifyCalcEpoch: vi.fn(actual.invalidateAndVerifyCalcEpoch) };
});

const mockedCalcEpoch = vi.mocked(calcEpoch);

beforeEach(resetHarness);

/** The eleven kinds with a form (FR-643's pills), in tab order. */
const LAYOUT_KINDS = [
  "BUY",
  "SELL",
  "SHARE_DISTRIBUTION",
  "DEPOSIT",
  "WITHDRAWAL",
  "CURRENCY_EXCHANGE",
  "FEE",
  "DIVIDEND",
  "INTEREST",
  "DRIP",
  "TRANSFER_OUT",
] as const;

describe("buildTransactionRequestPayload — the per-kind wire shape (pure, no rendering)", () => {
  function values(overrides: Partial<TransactionFormValues>): TransactionFormValues {
    return { ...defaultTransactionFormValues(), ...overrides };
  }

  it("BUY (fiat-settled): instrumentId/quantity/unitPrice/currency, no settlement object", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "BUY",
        instrumentId: INSTRUMENT_ID,
        quantity: "10",
        unitPrice: "100",
        currency: "USD",
      }),
    );
    expect(body["kind"]).toBe("BUY");
    expect(body["instrumentId"]).toBe(INSTRUMENT_ID);
    expect(body["unitPrice"]).toBe("100");
    expect(body["currency"]).toBe("USD");
    expect(body["settlement"]).toBeUndefined();
  });

  // AC52/FR-66: a single payload carries the instrument *and* the settlement
  // leg — there is no second "enter a sell" step/payload anywhere.
  it("BUY (asset-settled, AC52): a single payload with instrument + settlement, no unitPrice/currency", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "BUY",
        instrumentId: INSTRUMENT_ID,
        quantity: "1.5",
        settlementEnabled: true,
        settlementInstrumentId: SETTLEMENT_INSTRUMENT_ID,
        settlementAmount: "0.05",
      }),
    );
    expect(body["instrumentId"]).toBe(INSTRUMENT_ID);
    expect(body["settlement"]).toEqual({
      instrumentId: SETTLEMENT_INSTRUMENT_ID,
      amount: "0.05",
    });
    expect(body["unitPrice"]).toBeUndefined();
    expect(body["currency"]).toBeUndefined();
  });

  // AC48/FR-59: no instrument field anywhere in the payload.
  it("CURRENCY_EXCHANGE: amount/currency/targetCurrency/exchangeRate, no instrument key at all", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "CURRENCY_EXCHANGE",
        amount: "500",
        currency: "USD",
        targetCurrency: "EUR",
        exchangeRate: "0.92",
      }),
    );
    expect(body["amount"]).toBe("500");
    expect(body["targetCurrency"]).toBe("EUR");
    expect("instrumentId" in body).toBe(false);
  });

  // The cashless kind. What it *omits* is the assertion — a
  // `cashAccountId` on this body is a per-field 400 from the shared schema,
  // so the builder must not set the key at all.
  it("SHARE_DISTRIBUTION: instrument/quantity/market value, and no cash-leg key of any kind", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "SHARE_DISTRIBUTION",
        portfolioId: PORTFOLIO_ID,
        instrumentId: INSTRUMENT_ID,
        quantity: "3",
        amount: "503.40",
        currency: "EUR",
        // Typed while the form was on another kind, and deliberately not
        // carried over: switching kinds must not smuggle an account onto a
        // body that forbids one.
        cashAccountId: CASH_ACCOUNT_ID,
        cashCurrency: "EUR",
        cashAmount: "503.40",
      }),
    );
    expect(body["kind"]).toBe("SHARE_DISTRIBUTION");
    expect(body["instrumentId"]).toBe(INSTRUMENT_ID);
    expect(body["quantity"]).toBe("3");
    expect(body["amount"]).toBe("503.40");
    expect(body["currency"]).toBe("EUR");
    expect("cashAccountId" in body).toBe(false);
    expect("cashCurrency" in body).toBe(false);
    expect("cashAmount" in body).toBe(false);
    expect("unitPrice" in body).toBe(false);
    expect("fee" in body).toBe(false);
    // …and the body the builder produced really is one the shared schema
    // accepts, rather than one this test merely describes.
    expect(createTransactionBodySchema.safeParse(body).success).toBe(true);
  });

  // DEPOSIT's keys plus DIVIDEND's withholding. The
  // builder has no `never` check, so an INTEREST with no arm would post only
  // the common keys — this is the assertion that stands in for one.
  it("INTEREST: amount/currency/account plus the withholding when set, and no instrument key", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "INTEREST",
        portfolioId: PORTFOLIO_ID,
        amount: "100.00",
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT_ID,
        withholdingAmount: "30.00",
      }),
    );
    expect(body["kind"]).toBe("INTEREST");
    expect(body["amount"]).toBe("100.00");
    expect(body["currency"]).toBe("EUR");
    expect(body["cashAccountId"]).toBe(CASH_ACCOUNT_ID);
    // The amount is the whole withholding.
    expect(body["withholding"]).toEqual({ amount: "30.00" });
    expect("instrumentId" in body).toBe(false);
    expect(createTransactionBodySchema.safeParse(body).success).toBe(true);
  });

  // AC-587: the builder has no `never` check, so a FEE
  // with no arm would post only the common keys. The instrument is a
  // reference, sent only when one was chosen.
  it("FEE: amount/currency/account/note, and the instrument reference only when chosen", () => {
    const fee = (instrumentId: string): Record<string, unknown> =>
      buildTransactionRequestPayload(
        values({
          kind: "FEE",
          portfolioId: PORTFOLIO_ID,
          amount: "12.50",
          currency: "EUR",
          cashAccountId: CASH_ACCOUNT_ID,
          note: "Frais de garde T3",
          instrumentId,
          // Typed on another kind, and not carried over: a FEE has no
          // withholding leg.
          withholdingAmount: "3.00",
        }),
      );
    const withoutInstrument = fee("");
    expect(withoutInstrument["kind"]).toBe("FEE");
    expect(withoutInstrument["amount"]).toBe("12.50");
    expect(withoutInstrument["currency"]).toBe("EUR");
    expect(withoutInstrument["cashAccountId"]).toBe(CASH_ACCOUNT_ID);
    expect(withoutInstrument["note"]).toBe("Frais de garde T3");
    expect("instrumentId" in withoutInstrument).toBe(false);
    expect("withholding" in withoutInstrument).toBe(false);
    expect(createTransactionBodySchema.safeParse(withoutInstrument).success).toBe(true);

    const withInstrument = fee(INSTRUMENT_ID);
    expect(withInstrument["instrumentId"]).toBe(INSTRUMENT_ID);
    expect(createTransactionBodySchema.safeParse(withInstrument).success).toBe(true);
  });

  // The user's own reference — one key, set for every kind, and
  // omitted rather than sent empty when the field was never filled.
  it("reference: carried for every kind, trimmed, and omitted entirely when blank", () => {
    const withReference = buildTransactionRequestPayload(
      values({ kind: "DEPOSIT", amount: "1000", currency: "EUR", reference: "  ORD-42  " }),
    );
    expect(withReference["reference"]).toBe("ORD-42");

    // A kind at the other extreme of the per-kind table — the reference takes
    // part in none of those rules, so it travels on this body identically.
    const onADistribution = buildTransactionRequestPayload(
      values({
        kind: "SHARE_DISTRIBUTION",
        portfolioId: PORTFOLIO_ID,
        instrumentId: INSTRUMENT_ID,
        quantity: "3",
        amount: "503.40",
        currency: "EUR",
        reference: "AVIS-2026-06-08",
      }),
    );
    expect(onADistribution["reference"]).toBe("AVIS-2026-06-08");
    expect(createTransactionBodySchema.safeParse(onADistribution).success).toBe(true);

    // Untouched: `undefined`, never `""` — an empty string is a value the
    // schema would then have to strip, and the default form must submit
    // byte-for-byte what it submitted before this field existed.
    const untouched = buildTransactionRequestPayload(
      values({ kind: "DEPOSIT", amount: "1000", currency: "EUR" }),
    );
    expect(untouched["reference"]).toBeUndefined();
  });

  it("DEPOSIT: amount/currency only, no fee key at all", () => {
    const body = buildTransactionRequestPayload(
      values({ kind: "DEPOSIT", amount: "1000", currency: "EUR" }),
    );
    expect(body["amount"]).toBe("1000");
    expect("fee" in body).toBe(false);
    expect("instrumentId" in body).toBe(false);
  });

  // F2 (security review, T-44): the settlement leg can now
  // pin its own rate — previously typed and RHF-retained, but never read by
  // this builder at all, so it silently never reached the API despite the
  // server's own `settlementBodySchema` supporting it.
  it("BUY (asset-settled): settlement.fxRateUserInput is included when filled", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "BUY",
        instrumentId: INSTRUMENT_ID,
        quantity: "0.02",
        settlementEnabled: true,
        settlementInstrumentId: SETTLEMENT_INSTRUMENT_ID,
        settlementAmount: "1",
        settlementFxRateUserInput: "42000",
      }),
    );
    expect(body["settlement"]).toEqual({
      instrumentId: SETTLEMENT_INSTRUMENT_ID,
      amount: "1",
      fxRateUserInput: "42000",
    });
  });

  it("BUY (asset-settled): settlement.fxRateUserInput is omitted (not an empty string) when left blank", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "BUY",
        instrumentId: INSTRUMENT_ID,
        quantity: "0.02",
        settlementEnabled: true,
        settlementInstrumentId: SETTLEMENT_INSTRUMENT_ID,
        settlementAmount: "1",
      }),
    );
    expect((body["settlement"] as Record<string, unknown>)["fxRateUserInput"]).toBeUndefined();
  });

  // Adjacent check (F2): the non-settlement BUY path is completely
  // unaffected — it still emits the fiat `fxRateUserInput` exactly as
  // before this fix.
  it("BUY (fiat-settled) still emits fxRateUserInput exactly as before", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "BUY",
        instrumentId: INSTRUMENT_ID,
        quantity: "10",
        unitPrice: "100",
        currency: "USD",
        fxRateUserInput: "0.92",
      }),
    );
    expect(body["fxRateUserInput"]).toBe("0.92");
    expect(body["settlement"]).toBeUndefined();
  });

  // Adjacent check (F2): DEPOSIT/WITHDRAWAL/DIVIDEND (no settlement concept
  // at all) are unaffected by the settlement-leg fix.
  it.each(["DEPOSIT", "WITHDRAWAL"] as const)(
    "%s still emits amount/currency/fxRateUserInput exactly as before",
    (kind) => {
      const body = buildTransactionRequestPayload(
        values({ kind, amount: "1000", currency: "USD", fxRateUserInput: "0.92" }),
      );
      expect(body["amount"]).toBe("1000");
      expect(body["fxRateUserInput"]).toBe("0.92");
      expect("settlement" in body).toBe(false);
    },
  );

  it("DIVIDEND still emits amount/currency/fxRateUserInput/withholding exactly as before", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "DIVIDEND",
        instrumentId: INSTRUMENT_ID,
        amount: "50",
        currency: "USD",
        fxRateUserInput: "0.92",
      }),
    );
    expect(body["amount"]).toBe("50");
    expect(body["fxRateUserInput"]).toBe("0.92");
    expect("settlement" in body).toBe(false);
  });

  /**
   * **FR-223's load-bearing claim, and the one an empty object would break.**
   *
   * An untouched form must send **no `fee` key at all** — and, when a total is
   * entered but the breakdown is not, no `components` key either. Not `{}`:
   * `costComponentsSchema` rejects an all-absent object by design ("at least
   * one component when present"), so an empty object would 400 every
   * unitemised entry. That is what "an unitemised entry costs exactly what it
   * costs today" rests on.
   */
  it("an untouched fee section sends no fee key, and a bare total sends no components key", () => {
    const untouched = buildTransactionRequestPayload(
      values({
        kind: "SELL",
        instrumentId: INSTRUMENT_ID,
        quantity: "1",
        unitPrice: "1",
        currency: "EUR",
        feeAmount: "",
      }),
    );
    expect(untouched["fee"]).toBeUndefined();

    const totalOnly = buildTransactionRequestPayload(
      values({
        kind: "SELL",
        instrumentId: INSTRUMENT_ID,
        quantity: "1",
        unitPrice: "1",
        currency: "EUR",
        feeAmount: "9.90",
      }),
    );
    expect(totalOnly["fee"]).toEqual({ amount: "9.90" });
    // On the key by name, not on the whole object: `toEqual` above would also
    // pass for `{ amount, components: undefined }`, which serialises away but
    // would not survive a refactor to an explicit `{}`.
    expect(Object.keys(totalOnly["fee"] as object)).not.toContain("components");
  });

  /**
   * FR-260: this was "a lone fee account still opens the fee leg (CA-11)". The
   * account control is gone (L6), so what opens a leg now is a total **or** any
   * component — and a component alone is the shape FR-213 exists for, since the
   * total is then their exact sum and a caller cannot restate it wrongly.
   */
  it("a component alone opens the fee leg, with no total restated beside it", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "SELL",
        instrumentId: INSTRUMENT_ID,
        quantity: "1",
        unitPrice: "1",
        currency: "EUR",
        feeTax: "3.60",
      }),
    );
    expect(body["fee"]).toEqual({ components: { tax: "3.60" } });
    expect(Object.keys(body["fee"] as object)).not.toContain("amount");
  });

  /** FR-223: every one of the four names reaches the wire under its own key, and only the ones typed do. */
  it("sends exactly the components that were filled in, under the four wire names", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "BUY",
        instrumentId: INSTRUMENT_ID,
        quantity: "1",
        unitPrice: "1",
        currency: "EUR",
        feeBrokerFee: "9.90",
        feeFxFee: "2.50",
        feeTax: "3.60",
        feeOther: "",
      }),
    );
    expect(body["fee"]).toEqual({
      components: { brokerFee: "9.90", fxFee: "2.50", tax: "3.60" },
    });
  });
});

describe("<TransactionForm> — one component renders every kind (AC1's structural precondition)", () => {
  /**
   * **AC-536 — the layout oracle, one row per kind** (`transaction-dialog-refresh`
   * FR-649/FR-650). Walks the rendered form and asserts,
   * for every control: that it is one the oracle names for this kind (the set,
   * both directions — so a control appearing on the wrong kind is a red row),
   * and that it sits in the oracle's zone, inside or outside « Plus d'options ».
   *
   * Absorbs three earlier field-set cases (AC-559): "defaults to BUY and shows
   * the instrument/quantity/unit-price/currency fields" (the BUY row; the
   * opening kind itself is `TransactionKindTabs.test.tsx`'s), "renders
   * «Référence (optionnel)» for every kind" (`reference-input` is in every row,
   * and its label is asserted below), and the CD12 "%s renders exactly its own
   * picker slots" matrix (every picker slot is a control in the set, and the
   * retired `fee-cash-account-input` is in no row).
   */
  it.each(LAYOUT_KINDS)(
    "AC-536 %s: every control is the oracle's, in the oracle's zone",
    async (kind) => {
      renderForm();
      await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
      selectKind(kind);

      const form = screen.getByTestId("transaction-form");
      const expander = screen.getByTestId("more-options");
      const controls = Array.from(
        form.querySelectorAll<HTMLElement>("input, select, textarea"),
      ).filter((control) => !(control.getAttribute("data-testid") ?? "").startsWith("family-tab-"));
      const ids = controls.map((control) => control.getAttribute("data-testid"));

      expect([...ids].sort()).toEqual(
        [...ESSENTIAL_TESTIDS[kind], ...MORE_OPTIONS_TESTIDS[kind]].sort(),
      );
      for (const testId of ESSENTIAL_TESTIDS[kind]) {
        expect(expander.contains(screen.getByTestId(testId)), `${testId} is essential`).toBe(false);
      }
      for (const testId of MORE_OPTIONS_TESTIDS[kind]) {
        expect(expander.contains(screen.getByTestId(testId)), `${testId} is in the expander`).toBe(
          true,
        );
      }
      expect(screen.getByLabelText("Référence (optionnel)")).toBe(
        screen.getByTestId("reference-input"),
      );
      expect(screen.queryByTestId("fee-cash-account-input")).not.toBeInTheDocument();
    },
  );

  // The two conditional groups of the oracle, in their zone when they appear.
  it("AC-536: « Réglé en actif »'s three inputs appear inside the expander, and swap the price block out of the essentials (TDR-L14)", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settlement-toggle"));
    const expander = screen.getByTestId("more-options");
    for (const testId of ASSET_SETTLEMENT_TESTIDS) {
      expect(expander.contains(screen.getByTestId(testId))).toBe(true);
    }
    for (const testId of [
      "unit-price-input",
      "currency-input",
      "cash-account-input",
      "fx-rate-user-input",
    ]) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
  });

  it.each(["BUY", "SELL", "DRIP", "DEPOSIT", "WITHDRAWAL", "FEE", "DIVIDEND", "INTEREST"] as const)(
    "AC-536 %s: the settlement block, when it appears, is inside the expander (C-1 for DIVIDEND/INTEREST)",
    async (kind) => {
      renderForm();
      await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
      selectKind(kind);
      await selectCurrency("currency-input", "USD");
      await choosePortfolio();
      await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

      const block = await screen.findByTestId("settlement-fields");
      expect(screen.getByTestId("more-options").contains(block)).toBe(true);
      const blockIds = Array.from(block.querySelectorAll("input")).map((input) =>
        input.getAttribute("data-testid"),
      );
      expect(blockIds.length).toBeGreaterThan(0);
      for (const id of blockIds) expect(SETTLEMENT_TESTIDS).toContain(id);
    },
  );

  // portfolio-cash AC-584 / FR-691: the oracle row above places the controls;
  // this is what they read — « Libellé » is the `note`, with its placeholder,
  // the picker says it is optional, and there is no fee area.
  it("AC-584 FEE: « Libellé » is the note with its placeholder, the instrument is optional, no fee area", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("FEE");

    const label = screen.getByLabelText("Libellé");
    expect(label).toBe(screen.getByTestId("note-input"));
    expect(label).toHaveAttribute("placeholder", "Frais de garde T3");
    expect(screen.queryByLabelText("Note (optionnel)")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("more-options")).getByText("Instrument concerné (optionnel)"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Frais (optionnel)")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fee-total")).not.toBeInTheDocument();
  });

  // AC48: the negative half — CURRENCY_EXCHANGE structurally omits the
  // instrument-selection field, it is not merely left blank.
  it("CURRENCY_EXCHANGE renders no instrument field at all", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    expect(screen.queryByTestId("instrument-picker-search")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-picker-selected")).not.toBeInTheDocument();
    expect(screen.getByTestId("amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("target-currency-input")).toBeInTheDocument();
    expect(screen.getByTestId("exchange-rate-input")).toBeInTheDocument();
  });

  it("toggling BUY's settlement checkbox swaps unitPrice/currency for settlement instrument/amount fields", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    expect(screen.getByTestId("unit-price-input")).toBeInTheDocument();
    expect(screen.queryByTestId("settlement-amount-input")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settlement-toggle"));

    expect(screen.queryByTestId("unit-price-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("settlement-amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("settlement-instrument-picker-search")).toBeInTheDocument();
  });
});

/**
 * Deleting the tenant's
 * last portfolio is a permitted, newly-reachable state (FR-P7) — this proves
 * the picker renders an honest empty-state message instead of a bare
 * `<select>` with only the placeholder option once `portfoliosQuery.data`
 * resolves to `[]`.
 */
describe("<TransactionForm> — portfolio-select empty state", () => {
  it("shows an honest empty-state message instead of the select when there are zero portfolios", async () => {
    mockedApiClient.fetchPortfolios.mockResolvedValueOnce([]);
    renderForm();

    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("portfolio-select-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("portfolio-select")).not.toBeInTheDocument();
  });

  it("still shows the ordinary select once at least one portfolio exists (contrast)", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    expect(screen.getByTestId("portfolio-select")).toBeInTheDocument();
    expect(screen.queryByTestId("portfolio-select-empty")).not.toBeInTheDocument();
  });
});

describe("<TransactionForm> — portfolio-archive: the source picker", () => {
  async function archiveInFetch(ids: readonly string[]): Promise<void> {
    const base = await apiClient.fetchPortfolios();
    mockedApiClient.fetchPortfolios.mockResolvedValue(
      base.map((p) => (ids.includes(p.id) ? { ...p, archived: true } : p)),
    );
  }

  it("AC-486: an archived portfolio is not offered when nothing is selected", async () => {
    await archiveInFetch([OTHER_PORTFOLIO_ID]);
    renderForm();
    await waitFor(() =>
      expect(optionPairs("portfolio-select").map(([value]) => value)).toContain(PORTFOLIO_ID),
    );
    expect(optionPairs("portfolio-select").map(([value]) => value)).toEqual(["", PORTFOLIO_ID]);
    expect(screen.queryByText("Tous vos portefeuilles sont archivés")).toBeNull();
  });

  it("AC-487: the selected portfolio, once archived, stays listed once, suffixed, and selected", async () => {
    const { queryClient } = renderForm();
    await choosePortfolio(OTHER_PORTFOLIO_ID);

    markArchivedInCache(queryClient, OTHER_PORTFOLIO_ID);

    await waitFor(() =>
      expect(optionPairs("portfolio-select")).toContainEqual([
        OTHER_PORTFOLIO_ID,
        "Compte secondaire (archivé)",
      ]),
    );
    expect(
      optionPairs("portfolio-select").filter(([value]) => value === OTHER_PORTFOLIO_ID),
    ).toHaveLength(1);
    expect(screen.getByTestId("portfolio-select")).toHaveValue(OTHER_PORTFOLIO_ID);
  });

  it("every portfolio archived: the select keeps its placeholder and says why, not the no-portfolio banner", async () => {
    await archiveInFetch([PORTFOLIO_ID, OTHER_PORTFOLIO_ID]);
    renderForm();

    expect(await screen.findByText("Tous vos portefeuilles sont archivés")).toBeInTheDocument();
    expect(optionPairs("portfolio-select").map(([value]) => value)).toEqual([""]);
    expect(screen.queryByTestId("portfolio-select-empty")).not.toBeInTheDocument();
  });
});

/**
 * Security review finding LOW-2: before the debounce, every
 * keystroke in the instrument picker's search input fired its own
 * `GET /instruments?query=` immediately — uncancellable in practice, and
 * (this component's own key detail) each keystroke's differing `query` is
 * itself a distinct `queryKey` (`instrumentSearchQueryOptions`), so it wrote
 * one *separate* `api-get-cache` entry per keystroke rather than superseding
 * the previous one. 250ms of no further typing is what now actually commits
 * a search.
 */
describe("<TransactionForm> — the instrument search input is debounced", () => {
  it("several rapid keystrokes fire only one search, for the final committed value — not one per keystroke", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());

    const input = screen.getByTestId("instrument-picker-search");
    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.change(input, { target: { value: "Ap" } });
    fireEvent.change(input, { target: { value: "App" } });
    fireEvent.change(input, { target: { value: "Appl" } });
    fireEvent.change(input, { target: { value: "Apple" } });

    // Immediately after the burst, the debounce has not committed yet —
    // still zero calls (the strongest, most direct proof this is a genuine
    // debounce and not merely "eventually only one call happens to appear
    // in the assertion window below").
    expect(mockedApiClient.searchInstruments).not.toHaveBeenCalled();

    // 250ms of no further typing later, exactly one search fires, and only
    // for the last value actually typed.
    await waitFor(() => expect(mockedApiClient.searchInstruments).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
    });
    expect(mockedApiClient.searchInstruments).toHaveBeenCalledWith(
      "Apple",
      expect.any(AbortSignal),
    );
  });
});

describe("<TransactionForm> — FX-rate direction label (AC3, R12 mitigation)", () => {
  it('shows "1 USD = ___ EUR" once the transaction currency differs from the base currency', async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    expect(screen.queryByTestId("fx-direction-label")).not.toBeInTheDocument();

    await selectCurrency("currency-input", "USD");

    expect(screen.getByTestId("fx-direction-label")).toHaveTextContent(
      `1 USD = ___ ${BASE_CURRENCY}`,
    );
  });

  it("shows no direction label when the transaction currency is already the base currency", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await selectCurrency("currency-input", BASE_CURRENCY);
    expect(screen.queryByTestId("fx-direction-label")).not.toBeInTheDocument();
  });

  it("CURRENCY_EXCHANGE's own rate shows the currency -> targetCurrency direction, not the base currency", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    await selectCurrency("currency-input", "USD");
    await selectCurrency("target-currency-input", "GBP");
    expect(screen.getByTestId("fx-direction-label")).toHaveTextContent("1 USD = ___ GBP");
  });
});

describe("<TransactionForm> — touch targets and inputmode", () => {
  // The 44px floor is the kit's, not a utility class per call site:
  // `.k-btn` sets `min-height: var(--tap-target)` unconditionally
  // (components.css), so carrying `k-btn` *is* carrying the touch target, and
  // a button that opted out would have to stop being a `<Button>` first.
  it("the submit/cancel buttons are kit buttons, which carry the >=44px touch target", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    expect(screen.getByTestId("transaction-form-submit").className).toMatch(/\bk-btn\b/);
    expect(screen.getByTestId("transaction-form-cancel").className).toMatch(/\bk-btn\b/);
  });

  it('numeric decimal fields use inputMode="decimal"', async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    expect(screen.getByTestId("quantity-input")).toHaveAttribute("inputmode", "decimal");
    expect(screen.getByTestId("unit-price-input")).toHaveAttribute("inputmode", "decimal");
  });
});

describe("<TransactionForm> — validation is the same Zod schema the API validates against (T-44 shared-schema requirement)", () => {
  // Guard/wrong-field-rejection red-confirm: a BUY submitted with no
  // quantity must be rejected with the *same* message
  // `createTransactionBodySchema`'s own superRefine produces server-side —
  // not a hand-rolled client message that could drift from it.
  it("rejects a BUY missing quantity with the schema's own message, and never calls createTransaction", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() =>
      expect(screen.getByText(/quantity is required for a BUY/)).toBeInTheDocument(),
    );
    expect(mockedApiClient.createTransaction).not.toHaveBeenCalled();
  });

  it("submits successfully once every required BUY field is filled, and invalidates/closes on success", async () => {
    const { onSubmitted } = renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      kind: "BUY",
      portfolioId: PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      quantity: "10",
      unitPrice: "100",
      currency: "USD",
      cashAccountId: CASH_ACCOUNT_ID,
    });
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  // F2 (security review, T-45, MEDIUM).
  it("when calcEpoch cannot be verified fresh, the dialog stays open with an honest notice — not a silent clean-success close", async () => {
    mockedCalcEpoch.invalidateAndVerifyCalcEpoch
      .mockResolvedValueOnce({ verified: false }) // overview
      .mockResolvedValueOnce({ verified: true }); // holdings

    const { onSubmitted } = renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("calc-epoch-stale-notice")).toHaveTextContent(
        "Écriture enregistrée, chiffres non rafraîchis — actualisez.",
      ),
    );
    // The write succeeded — never treated as a submission error.
    expect(screen.queryByTestId("submit-error")).not.toBeInTheDocument();
    // Not a clean, silent close: the dialog does not close on its own.
    expect(onSubmitted).not.toHaveBeenCalled();
    // Resubmitting the same (already-saved) values is no longer possible —
    // the submit/cancel controls are replaced by the acknowledgment button.
    expect(screen.queryByTestId("transaction-form-submit")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("calc-epoch-stale-notice-close"));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("calc-epoch-stale-notice")).not.toBeInTheDocument();
  });

  // AC52/FR-66 at the component level: a single submission, not two.
  it("submits a crypto-to-crypto BUY as one call carrying both the instrument and settlement legs", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Wrapped Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.02" } });
    fireEvent.click(screen.getByTestId("settlement-toggle"));
    await pickInstrument(
      "settlement-instrument-picker",
      SETTLEMENT_INSTRUMENT_ID,
      "Bitcoin",
      "BTC",
    );
    fireEvent.change(screen.getByTestId("settlement-amount-input"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("portfolio-select"), { target: { value: PORTFOLIO_ID } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      kind: "BUY",
      instrumentId: INSTRUMENT_ID,
      settlement: { instrumentId: SETTLEMENT_INSTRUMENT_ID, amount: "1" },
    });
  });

  // AC48 at the submission level (complementing the structural-omission
  // rendering test above): a CURRENCY_EXCHANGE actually succeeds end to end.
  it("submits a CURRENCY_EXCHANGE successfully with no instrument field anywhere", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "500" } });
    await selectCurrency("currency-input", "USD");
    await selectCurrency("target-currency-input", "EUR");
    fireEvent.change(screen.getByTestId("exchange-rate-input"), { target: { value: "0.92" } });
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
    await selectCashAccount("target-cash-account-input", TARGET_CASH_ACCOUNT_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      kind: "CURRENCY_EXCHANGE",
      amount: "500",
      cashAccountId: CASH_ACCOUNT_ID,
      targetCurrency: "EUR",
      // AC-176: the two accounts are independent, and this body proves they
      // are carried independently rather than collapsed into one field.
      targetCashAccountId: TARGET_CASH_ACCOUNT_ID,
      exchangeRate: "0.92",
    });
    expect(payload as Record<string, unknown>).not.toHaveProperty("instrumentId");
  });
});

/**
 * CA-20 — `CashAccountPicker` at the **create** entry point.
 *
 * CD12's five behaviours, each its own test rather than inferred from one
 * happy-path render, plus the per-kind slot matrix and the F2 error-routing
 * regression class. `TransactionEditForm.test.tsx` re-tests all five at the
 * **edit** entry point independently — RC6: this project has already shipped
 * a shared component that worked from one mount site and silently did nothing
 * from the second, and per-task coverage of one site is exactly what failed to
 * catch it.
 */
describe("<TransactionForm> — CashAccountPicker at the create entry point (CD12)", () => {
  it("behaviour 1 — portfolio-scoped: no read at all until a portfolio is chosen, then scoped to that id", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());

    // A one-shot read, not a retrying matcher: "never fetched" must not be
    // allowed to pass by having been checked before the fetch would fire.
    expect(screen.getByTestId("cash-account-input")).toBeDisabled();
    expect(screen.getByTestId("cash-account-input-needs-portfolio")).toBeInTheDocument();
    expect(mockedApiClient.fetchPortfolioCash).not.toHaveBeenCalled();

    await choosePortfolio(OTHER_PORTFOLIO_ID);
    expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalledWith(
      OTHER_PORTFOLIO_ID,
      expect.anything(),
    );
    // The negative companion: never the *other* portfolio's id, and never an
    // unscoped call.
    expect(mockedApiClient.fetchPortfolioCash).not.toHaveBeenCalledWith(
      PORTFOLIO_ID,
      expect.anything(),
    );
  });

  /**
   * **Shape-changed by FT-21** (FR-260's one named exception): behaviour 2 no
   * longer holds on the *principal* slot, because FR-257(1) removes its filter
   * — the account now determines the settlement currency. The behaviour itself
   * is unchanged and is re-asserted here on the **fee** slot, which FR-237
   * leaves filtered, in the same render as the principal slot's new one. The
   * component's own five-behaviour baseline is `CashAccountPicker.test.tsx`.
   */
  /**
   * FR-260: asserted on the **fee** slot until FT-44 removed it, then on the
   * withholding slot until that was removed too (a withholding is in the
   * settling account's currency). The filtered slot left on the create form is
   * CURRENCY_EXCHANGE's target leg (FR-235 pins it), so the claim lives there —
   * never on a slot invented to keep the case alive.
   */
  it("behaviour 2 — CURRENCY_EXCHANGE's target leg is currency-filtered and re-filters on a currency change", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    await selectCurrency("target-currency-input", "USD");
    await choosePortfolio();

    // The target slot: USD only.
    await waitFor(() =>
      expect(offeredAccountIds("target-cash-account-input")).toEqual([
        CASH_ACCOUNT_ID,
        SECOND_USD_ACCOUNT_ID,
      ]),
    );

    await selectCurrency("target-currency-input", "EUR");
    await waitFor(() =>
      expect(offeredAccountIds("target-cash-account-input")).toEqual([TARGET_CASH_ACCOUNT_ID]),
    );
  });

  it("behaviour 3 — an archived account is not offered on the create form (nothing is attributed yet), while its active sibling is", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();

    await waitFor(() =>
      expect(offeredAccountIds("cash-account-input")).toContain(TARGET_CASH_ACCOUNT_ID),
    );
    // One-shot read, taken after the positive assertion above has proven the
    // list is populated — so "absent" cannot mean "not loaded yet".
    expect(offeredAccountIds("cash-account-input")).not.toContain(ARCHIVED_EUR_ACCOUNT_ID);
  });

  /**
   * **Shape-changed by FT-21**, then again by FT-44 (FR-260). The principal
   * slot cannot reach this state — it has no filter to leave empty — and the
   * **fee** slot it was re-asserted on is gone with the leg's account, and so is the withholding slot. CURRENCY_EXCHANGE's
   * target leg keeps its filter, so the behaviour is asserted there; the
   * principal slot's own empty state (a portfolio with no cash account at all,
   * copy naming no currency) is the test after it.
   */
  it("behaviour 4 — inline creation when the portfolio has no account in the target leg's currency, and the new account is selected", async () => {
    const NEW_GBP_ID = "77777777-7777-4777-8777-777777777777";
    // The refetch the dialog's own `invalidateCashAccounts` triggers must
    // actually surface the new account — otherwise "selected" would be a value
    // no `<option>` carries, which a native select silently drops. Modelling
    // the refetch here is what makes the final assertion meaningful.
    mockedApiClient.createCashAccount.mockImplementation(async () => {
      mockedApiClient.fetchPortfolioCash.mockResolvedValue(
        cashResponse([
          ...cashResponse().accounts,
          cashAccount({ id: NEW_GBP_ID, name: "Compte GBP", currency: "GBP" }),
        ]),
      );
      return {
        id: NEW_GBP_ID,
        name: "Compte GBP",
        currency: "GBP",
        archived: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
    });
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    await selectCurrency("target-currency-input", "GBP");
    await choosePortfolio();

    await waitFor(() =>
      expect(screen.getByTestId("target-cash-account-input-empty")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("target-cash-account-input-create"));
    expect(await screen.findByTestId("cash-account-form-dialog")).toBeVisible();
    // The currency is pinned, not offered — an account in any other currency
    // could not be attributed to this leg (FR-235 pins its denomination).
    expect(screen.getByTestId("cash-account-locked-currency")).toHaveTextContent("GBP");
    expect(screen.queryByTestId("cash-account-currency-select")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("cash-account-name-input"), {
      target: { value: "Compte GBP" },
    });
    fireEvent.submit(screen.getByTestId("cash-account-form"));

    await waitFor(() =>
      expect(mockedApiClient.createCashAccount).toHaveBeenCalledWith(PORTFOLIO_ID, {
        name: "Compte GBP",
        currency: "GBP",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("target-cash-account-input")).toHaveValue(NEW_GBP_ID),
    );
  });

  it("behaviour 4 on the principal leg — only an empty portfolio empties it, and the copy names no currency (FR-257(2))", async () => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(cashResponse([]));
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();

    await waitFor(() => expect(screen.getByTestId("cash-account-input-empty")).toBeInTheDocument());
    expect(screen.getByTestId("cash-account-input-empty")).toHaveTextContent(
      "Aucun compte espèce dans ce portefeuille.",
    );
    expect(screen.getByTestId("cash-account-input-create")).toHaveTextContent(
      "Créer un compte espèce",
    );
    // The sentence phase 1 removes is nowhere on the form.
    expect(document.body.textContent ?? "").not.toContain("Créer un compte en USD");
  });

  /**
   * **Shape-changed by FT-21**: behaviour 5 is untouched, but on the principal
   * slot "exactly one match" is now counted over the portfolio's whole account
   * list rather than over the leg's currency — so the default three-active
   * fixture preselects nothing, and a single-account portfolio preselects
   * whatever it holds, whatever the leg's currency. Both halves are asserted.
   */
  it("behaviour 5 — three active accounts preselect nothing; a sole account preselects itself, visibly and in the payload", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await waitFor(() => expect(offeredAccountIds("cash-account-input")).toHaveLength(3));
    expect(screen.getByTestId("cash-account-input")).toHaveValue("");

    cleanup();
    vi.clearAllMocks();
    mockedApiClient.fetchPortfolios.mockResolvedValue([
      {
        id: PORTFOLIO_ID,
        name: "Compte principal",
        transactionCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        broker: null,
        description: null,
        accentColor: null,
        hasIcon: false,
        archived: false,
      },
    ]);
    mockedApiClient.createTransaction.mockResolvedValue({});
    mockedApiClient.fetchCurrencies.mockResolvedValue(CURRENCIES);
    // One EUR account and a EUR leg: preselected — and, crucially, preselected
    // *into form state*, which is what the submitted payload below proves. A
    // control that merely displayed a default would submit an empty
    // `cashAccountId`.
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(
      cashResponse([cashAccount({ id: TARGET_CASH_ACCOUNT_ID, name: "Compte EUR" })]),
    );
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await waitFor(() =>
      expect(screen.getByTestId("cash-account-input")).toHaveValue(TARGET_CASH_ACCOUNT_ID),
    );

    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ cashAccountId: TARGET_CASH_ACCOUNT_ID });
    // The settlement is degenerate (EUR account, EUR leg), so the pair is not
    // on the wire at all — AC-278's byte-compatibility, from the UI.
    expect(payload).not.toHaveProperty("cashCurrency");
    expect(payload).not.toHaveProperty("cashAmount");
  });

  /**
   * The F2 regression class (security review, T-44): a schema issue on a
   * nested path landing on the *wrong* field's error slot.
   *
   * FR-260: this used `fee.cashAccountId` — a path that no longer exists
   * — and read the fee picker's slot. The class of bug is
   * unchanged and so is the shape of the test; only the nested path moved, to
   * `fee.components.tax`, which is the deepest one this form can now produce.
   */
  it("a schema error on fee.components.tax highlights that component's own input, never the total's or the principal picker's", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    // Selected explicitly: with FT-21's unfiltered principal slot the
    // portfolio's three active accounts are all offered, so nothing is
    // preselected there any more.
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    // FR-213: a component is absent or positive, and zero is neither.
    fireEvent.change(screen.getByTestId("fee-tax-input"), { target: { value: "0" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    // The component's own slot carries the schema's own message — the
    // *routing* is what this test decides, not the wording.
    await waitFor(() => expect(fieldErrorText("fee-tax-input")).not.toBeNull());
    // Neither the sibling component's slot nor the principal picker's carries
    // an error — the exact half of F2 that a "some error appeared somewhere"
    // assertion misses. (Since TDR-L11 a BUY has no total input to blame.)
    expect(fieldErrorText("fee-broker-input")).toBeNull();
    expect(screen.queryByTestId("fee-amount-input")).not.toBeInTheDocument();
    expect(fieldErrorText("cash-account-input")).toBeNull();
    expect(mockedApiClient.createTransaction).not.toHaveBeenCalled();
  });

  it("CURRENCY_EXCHANGE's two pickers are independent: distinct currencies, distinct offer lists, both carried in the payload", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    await selectCurrency("currency-input", "USD");
    await selectCurrency("target-currency-input", "EUR");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "500" } });
    fireEvent.change(screen.getByTestId("exchange-rate-input"), { target: { value: "0.92" } });
    await choosePortfolio();

    await waitFor(() => expect(offeredAccountIds("cash-account-input")).toHaveLength(2));
    expect(offeredAccountIds("cash-account-input")).toEqual([
      CASH_ACCOUNT_ID,
      SECOND_USD_ACCOUNT_ID,
    ]);
    expect(offeredAccountIds("target-cash-account-input")).toEqual([TARGET_CASH_ACCOUNT_ID]);

    await selectCashAccount("cash-account-input", SECOND_USD_ACCOUNT_ID);
    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      cashAccountId: SECOND_USD_ACCOUNT_ID,
      targetCashAccountId: TARGET_CASH_ACCOUNT_ID,
    });
  });

  /**
   * CA-20's own acceptance criterion: Batch B's four placeholder uuid
   * `<Input>`s are **gone**, replaced by the real picker.
   *
   * Written as positive-and-negative on the *same* four handles, in one
   * assertion each: an "there is no text input" check on its own would pass
   * just as well if the control had disappeared entirely, and an "there is a
   * select" check on its own would pass while a stray text input lingered
   * under a different id.
   */
  it("all three cash-account slots are real pickers — a <select> with options, never the interim uuid <input>", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    await selectCurrency("currency-input", "USD");
    await selectCurrency("target-currency-input", "EUR");
    await choosePortfolio();
    await waitFor(() => expect(offeredAccountIds("cash-account-input")).toHaveLength(2));

    // FR-260: four slots until FT-44. `fee-cash-account-input` is gone with
    // the leg's account, and `withholding-cash-account-input`
    // with the withholding's, so this loop covers the two that remain.
    for (const testId of ["cash-account-input", "target-cash-account-input"]) {
      const control = screen.getByTestId(testId);
      // Positive: it is a `<select>` carrying real, fetched options.
      expect(control.tagName).toBe("SELECT");
      expect((control as HTMLSelectElement).options.length).toBeGreaterThan(1);
      // Negative: not a free-text field any uuid could be typed into.
      expect(control).not.toHaveAttribute("type", "text");
    }
  });

  /**
   * FR-260: the second half read "while its fee picker remains". It does not —
   * FT-44 removed it. The remaining claim is FR-157's, unchanged, and it keeps
   * its positive companion so "no picker" is not satisfied by a form that
   * rendered nothing at all.
   *
   * That an asset-settled BUY can carry no *itemised* cost either is a
   * separate rule, asserted in `ledger`, not here.
   */
  it("a settlement-priced BUY has no principal picker at all (FR-157)", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    // Positive companion first: the fiat BUY *does* have one.
    expect(screen.getByTestId("cash-account-input")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settlement-toggle"));

    expect(screen.queryByTestId("cash-account-input")).not.toBeInTheDocument();
    // …and a cost is still enterable (Courtage, TDR-L11), so the removal was
    // of the account slot and not of the cost.
    expect(screen.getByTestId("fee-broker-input")).toBeInTheDocument();
  });
});

describe("<TransactionForm> — the create mutation is never queued/replayed offline", () => {
  afterEach(() => {
    // `onlineManager` is a module-level singleton shared by every
    // `QueryClient` in the process — leaving it flipped would silently
    // affect every later test file's mutations too.
    onlineManager.setOnline(true);
  });

  async function fillValidBuy(): Promise<void> {
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
  }

  // The direct, deterministic proof of the `networkMode: "always"` fix:
  // `onlineManager.setOnline(false)` is the exact mechanism TanStack Query's
  // default `networkMode: "online"` mutations key off to decide whether to
  // pause — it is independent of this component's own `useOnlineStatus`
  // hook (a separate `navigator.onLine`/window-event signal), so this test
  // is immune to any DOM-event timing and proves the mutation's own
  // configuration rather than the button-disable UI layer (verified
  // separately below/in Playwright).
  it('is not paused while onlineManager reports offline ("always", not the default "online")', async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillValidBuy();

    onlineManager.setOnline(false);
    fireEvent.submit(screen.getByTestId("transaction-form"));

    // With the default `networkMode: "online"`, this mutation would be
    // "paused" — `mutationFn` never called at all until reconnect — so a
    // real regression here manifests as this `waitFor` timing out, not as a
    // wrong value.
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
  });

  // The "replay" half: nothing was paused, so reconnecting fires nothing new.
  it("never replays on reconnect — exactly one attempt total, offline or not", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillValidBuy();

    onlineManager.setOnline(false);
    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));

    onlineManager.setOnline(true);
    // Give any queue-and-replay machinery a real tick to fire before
    // asserting it never did (same pattern `offline-logout.spec.ts` uses at
    // the Playwright layer for the identical class of bug).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("a failed submission is never automatically retried (mutation retry stays 0)", async () => {
    mockedApiClient.createTransaction.mockRejectedValueOnce(new Error("boom"));
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillValidBuy();

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(screen.getByTestId("submit-error")).toBeInTheDocument());
    // A real retry would show up as a second call shortly after the first;
    // give it a real tick before asserting there wasn't one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1);
  });

  /**
   * The banner used to render `mutation.error.message`,
   * which for an `ApiError` *is* the server's `problem.detail` verbatim. This
   * cycle added five error codes whose details are English and carry internal
   * design-doc references, and none of them was in `MESSAGE_TABLE`.
   *
   * The detail below is `CashAmountRequiredError`'s real message, copied from
   * `transaction-write-service.ts` — the exact string a user saw in the French
   * UI on the very path the cycle made routine (pick an account denominated in
   * neither the transaction's currency nor the base, leave the amount blank).
   */
  it.each([
    [
      "CASH_AMOUNT_REQUIRED",
      "cashAmount is required: the settling account is denominated in GBP, which is neither the transaction's USD nor the base EUR. When the settling account is denominated in neither the transaction's currency nor the base currency, how much actually moved is a fact only the contract note carries (cases D3/D5) — it cannot be derived from the row.",
    ],
    [
      "COST_COMPONENTS_INVALID",
      "this BUY's components sum to 12.30 but the supplied total is 99.00 — the two must be equal, exactly. Supply the components alone and the total is their sum.",
    ],
    [
      "CASH_AMOUNT_STALE",
      "Transaction abc is settled in GBP, which is neither its own currency nor the base currency, so its settled amount is an independent figure this edit cannot recompute: this edit moves the settling currency from CHF to GBP. Supply cashAmount in the same request (L16).",
    ],
  ])("a %s failure shows French copy, never the server's raw detail", async (code, detail) => {
    mockedApiClient.createTransaction.mockRejectedValueOnce(
      new apiClient.ApiError(400, { title: "Request refused", code, detail }),
    );
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillValidBuy();

    fireEvent.submit(screen.getByTestId("transaction-form"));

    const banner = await waitFor(() => screen.getByTestId("submit-error"));
    const text = banner.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    // Not the raw detail, and none of its tells: internal doc references,
    // camelCase field names, or the English sentence itself.
    expect(text).not.toContain(detail);
    expect(text).not.toMatch(/design\.md/);
    expect(text).not.toMatch(/cashAmount|feeAmount|D3\/D5/);
    expect(text).not.toMatch(/\bis required\b|\bmust be\b|\bSupply\b/);
  });
});

describe("<TransactionForm> — the settlement leg's own pinned rate", () => {
  async function fillSettlementUpTo(step: "instrument" | "rate"): Promise<void> {
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Wrapped Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.02" } });
    fireEvent.click(screen.getByTestId("settlement-toggle"));
    if (step === "instrument") return;
    await pickInstrument(
      "settlement-instrument-picker",
      SETTLEMENT_INSTRUMENT_ID,
      "Bitcoin",
      "BTC",
    );
    fireEvent.change(screen.getByTestId("settlement-amount-input"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("portfolio-select"), { target: { value: PORTFOLIO_ID } });
  }

  it("a pinned settlement rate is included in the submitted payload", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillSettlementUpTo("rate");
    fireEvent.change(screen.getByTestId("settlement-fx-rate-user-input"), {
      target: { value: "42000" },
    });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      settlement: {
        instrumentId: SETTLEMENT_INSTRUMENT_ID,
        amount: "1",
        fxRateUserInput: "42000",
      },
    });
  });

  // The underlying RHF-state half of the fix: not merely "absent from the
  // payload" (already structurally true — the builder never reads
  // `fxRateUserInput` in the settlement branch) but genuinely *cleared*, so
  // it cannot silently reappear if the toggle is flipped back off.
  it("toggling settlement on clears the fiat fxRateUserInput field itself, not only its effect on the payload", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("fx-rate-user-input"), { target: { value: "0.92" } });

    fireEvent.click(screen.getByTestId("settlement-toggle")); // on
    fireEvent.click(screen.getByTestId("settlement-toggle")); // back off

    expect(screen.getByTestId("fx-rate-user-input")).toHaveValue("");
  });

  // The exact bug this finding reports: a fiat rate typed before toggling
  // settlement on must not silently leak into the payload once it does.
  it("toggling settlement on does not leak a previously typed fiat fxRateUserInput into the payload", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Wrapped Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.02" } });
    // Typed while still fiat-settled, *before* the toggle.
    fireEvent.change(screen.getByTestId("fx-rate-user-input"), { target: { value: "0.92" } });

    fireEvent.click(screen.getByTestId("settlement-toggle"));
    await pickInstrument(
      "settlement-instrument-picker",
      SETTLEMENT_INSTRUMENT_ID,
      "Bitcoin",
      "BTC",
    );
    fireEvent.change(screen.getByTestId("settlement-amount-input"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("portfolio-select"), { target: { value: PORTFOLIO_ID } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload as Record<string, unknown>).not.toHaveProperty("fxRateUserInput");
  });

  // A schema-level rejection of the settlement rate must land on *its own*
  // field's error slot — before this fix it was mis-routed to
  // "settlementAmount" instead (F2's `ISSUE_PATH_TO_FIELD` mapping bug).
  it("a schema error on settlement.fxRateUserInput routes to its own field, not settlementAmount", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillSettlementUpTo("rate");
    fireEvent.change(screen.getByTestId("settlement-amount-input"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("settlement-fx-rate-user-input"), {
      target: { value: "-5" },
    });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() =>
      expect(fieldErrorText("settlement-fx-rate-user-input")).toMatch(
        /settlement\.fxRateUserInput must be a positive amount/,
      ),
    );
    expect(fieldErrorText("settlement-amount-input")).toBeNull();
    expect(mockedApiClient.createTransaction).not.toHaveBeenCalled();
  });

  it('shows the settlement asset\'s own direction label ("1 BTC = ___ EUR"), not a currency-pair one', async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await fillSettlementUpTo("instrument");
    expect(screen.queryByTestId("fx-direction-label")).not.toBeInTheDocument();

    await pickInstrument(
      "settlement-instrument-picker",
      SETTLEMENT_INSTRUMENT_ID,
      "Bitcoin",
      "BTC",
    );

    expect(screen.getByTestId("fx-direction-label")).toHaveTextContent(
      `1 BTC = ___ ${BASE_CURRENCY}`,
    );
  });
});

/**
 * T-1 (FR-T3, the
 * four currency dropdowns) and T-2 (FR-T2, the fee-currency mount-time
 * default), with decisions D2 (Option A: prefill once at mount, never
 * re-synced) and D4 (CURRENCY_EXCHANGE mirrors the principal currency).
 */
describe("<TransactionForm> — currency dropdowns, and the fee currency's retirement (FR-T3, L6)", () => {
  const CODES = CURRENCIES.map((currency) => currency.code);

  /** The codes a currency dropdown currently offers, placeholder excluded. */
  function offeredCurrencyCodes(testId: string): string[] {
    const select = screen.getByTestId(testId) as HTMLSelectElement;
    return Array.from(select.options)
      .map((option) => option.value)
      .filter((value) => value !== "");
  }

  // AC-T3a + AC-T3c in one pair per field: a `<select>` (never the old
  // free-text `<input maxLength={3}>`) whose options are the canonical
  // `GET /currencies` list. Both halves are needed — "is a select" alone
  // would pass on an empty select that can express nothing, and "offers the
  // codes" alone would pass on a datalist-backed text input.
  // FR-260: four fields until FT-44 removed the fee-currency dropdown (L6),
  // three once the withholding's was removed too.
  it("both currency fields are selects fed by the one shared GET /currencies list", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");

    for (const testId of ["currency-input", "target-currency-input"]) {
      const control = screen.getByTestId(testId);
      expect(control.tagName).toBe("SELECT");
      expect(control).not.toHaveAttribute("maxlength");
      await waitFor(() => expect(offeredCurrencyCodes(testId)).toEqual(CODES));
    }

    // AC-T3c's "cannot drift" half: two dropdowns, one `currenciesQueryOptions()`
    // cache entry — so exactly one request served all of them.
    expect(mockedApiClient.fetchCurrencies).toHaveBeenCalledTimes(1);
  });

  // AC-T2a, at the level the decision was written: `defaultTransactionFormValues`
  // is where D2's "seeded from the form's initial currency, once, at mount"
  // lives, and `feeCurrency` is asserted *against `currency`*, not against a
  // hard-coded "EUR", so the two cannot be changed apart.
  /**
   * **FR-260 — nine cases removed here, and why that is not a coverage loss.**
   *
   * This block held AC-T2a (defaults + submitted), AC-T2b, AC-T2c, AC-T2d, two
   * AC-T3d cases, a kind-switch-corruption case and a CD12-prefill case. Every
   * one of them asserted something about **the fee currency** — that it
   * defaults from the transaction currency, that an override survives to the
   * payload, that it is not corrupted by a remount, that its default does not
   * trigger a cash-account prefill.
   *
   * **L6 retires the capability all nine protected**, and the user locked that:
   * a cost is denominated by the settling account, so there is no fee currency
   * to default, override, corrupt or prefill against. Keeping the cases would
   * have meant keeping the control; retargeting them at some other currency
   * would have been nine tests pretending to guard a decision that no longer
   * exists. They are deleted, and this case is what stands in their place —
   * it asserts the removal itself, in both directions.
   *
   * The withholding's own currency and account went the same way (a
   * withholding is denominated by the settling account); the case below
   * asserts that removal on both kinds.
   *
   * **One of the nine was wrongly counted among them** (found by
   * the FT-48 gate). The AC-T3d pair read as fee-currency cases, but what they
   * guarded was `CurrencySelect`'s late-loading fallback `<option>` — a branch
   * L6 does not touch and that `currency-input` still reaches, since
   * `defaultTransactionFormValues()` seeds it at mount before the fetch
   * resolves. Deleting them left it untested, red-confirmed: disabling the
   * branch kept 113 files / 1496 tests green. It is now asserted on the
   * component that owns it, in `CurrencySelect.test.tsx`, where it cannot be
   * deleted as collateral to a form-level change again.
   */
  it("FR-223/L6: the fee currency and fee cash-account controls are gone, and no payload carries either", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await choosePortfolio();

    // The fee section still exists — a cost is still enterable (as Courtage
    // since TDR-L11: a BUY has no total input any more).
    expect(screen.getByTestId("fee-broker-input")).toBeInTheDocument();
    // …its two retired controls do not.
    expect(screen.queryByTestId("fee-currency-input")).toBeNull();
    expect(screen.queryByTestId("fee-cash-account-input")).toBeNull();

    fireEvent.change(screen.getByTestId("fee-broker-input"), { target: { value: "5" } });
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    const fee = (payload as Record<string, unknown>)["fee"] as Record<string, unknown>;
    // The positive half: the cost still reaches the API — as a component,
    // with no `amount` (TDR-L11: the server sums).
    expect(fee).toEqual({ components: { brokerFee: "5" } });
    // …and the negative half, on the keys by name rather than on the whole
    // object, so a future addition to `fee` cannot make this pass vacuously.
    expect(Object.keys(fee)).not.toContain("currency");
    expect(Object.keys(fee)).not.toContain("cashAccountId");
    expect(Object.keys(fee)).not.toContain("fxRateUserInput");
  });

  // The withholding is one amount, in the settling account's currency.
  // Asserted per kind (a kind switch can pass on the family's first kind), with
  // the amount field as the positive companion so "absent" cannot mean "the
  // fieldset did not render".
  it.each(["DIVIDEND", "INTEREST"] as const)(
    "%s: the withholding is the amount field alone — no currency or cash-account picker",
    async (kind) => {
      renderForm();
      await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
      selectKind(kind);
      await choosePortfolio();

      expect(screen.getByTestId(`kind-tab-${kind}`)).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("withholding-amount-input")).toBeInTheDocument();
      expect(screen.queryByTestId("withholding-currency-input")).toBeNull();
      expect(screen.queryByTestId("withholding-cash-account-input")).toBeNull();
    },
  );
});

/**
 * T-3 (FR-T1, trade
 * time capture on creation), decision **D1 Option A**: a *second,
 * optional* `type="time"` control beside the untouched `type="date"` one, not
 * a single `datetime-local` replacing both (that is Option B, which was not
 * locked).
 *
 * Every assertion below is deliberately TZ-agnostic: the suite pins no `TZ`,
 * and the whole point of AC-T1b is the *local*-to-UTC conversion, so a
 * hard-coded `"…T13:37:00.000Z"` would encode the CI machine's offset rather
 * than the behaviour. The instant is therefore read back through the local
 * date/time accessors — the same clock the user typed into.
 */
describe("<TransactionForm> — the optional trade-time input (FR-T1/T-3)", () => {
  const TRADE_DATE = "2026-03-12";
  const TRADE_TIME = "14:37";

  function values(overrides: Partial<TransactionFormValues>): TransactionFormValues {
    return { ...defaultTransactionFormValues(), ...overrides };
  }

  function submittedBody(): Record<string, unknown> {
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    return payload as Record<string, unknown>;
  }

  /** The BUY happy path every submission test below shares, minus the two trade-timing fields it is actually about. */
  async function fillValidBuy(): Promise<void> {
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
  }

  // Locked D1 Option A, asserted structurally: the date control is *unchanged*
  // and the time is a second control beside it. Without this, an Option B
  // implementation (one `datetime-local`) could satisfy several of the
  // payload assertions below while contradicting the locked decision.
  it("D1 Option A: the date input is untouched and the time is a separate, optional control — not a datetime-local", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());

    const date = screen.getByTestId("trade-date-input");
    const time = screen.getByTestId("trade-time-input");
    expect(date).toHaveAttribute("type", "date");
    expect(time).toHaveAttribute("type", "time");
    expect(date).not.toBe(time);
    // Nothing on the page is a `datetime-local` — the create form does not
    // borrow the edit form's single-control UX (NG1/D1).
    expect(document.querySelectorAll('input[type="datetime-local"]')).toHaveLength(0);
    // Optional, and blank at mount: an untouched form is still a date-only one.
    expect(time).toHaveValue("");
    expect(time).not.toBeRequired();
  });

  // AC-T1a, at the builder level, plus the "resulting transaction has
  // tradeTs = null" half made checkable here: the shared schema `api`
  // validates `POST /transactions` with parses the very same body, and its
  // output carries no `tradeTs` at all — so there is no instant for the
  // controller to write and the column keeps its `null`.
  it("AC-T1a: no time supplied — tradeDate is sent, tradeTs is not, and the parsed body carries no instant", () => {
    const body = buildTransactionRequestPayload(
      values({
        kind: "DEPOSIT",
        portfolioId: PORTFOLIO_ID,
        tradeDate: TRADE_DATE,
        tradeTime: "",
        amount: "1000",
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT_ID,
      }),
    );
    expect(body["tradeDate"]).toBe(TRADE_DATE);
    expect(body["tradeTs"]).toBeUndefined();

    const parsed = createTransactionBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.tradeTs).toBeUndefined();
  });

  // AC-T1a end to end: the same guarantee through the real form, where the
  // time field is simply never touched — the pre-FR-T1 flow, unchanged.
  it("AC-T1a (submitted): a transaction created with the time field left blank submits no tradeTs", async () => {
    renderForm();
    await fillValidBuy();
    fireEvent.change(screen.getByTestId("trade-date-input"), { target: { value: TRADE_DATE } });
    expect(screen.getByTestId("trade-time-input")).toHaveValue("");

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const body = submittedBody();
    expect(body["tradeDate"]).toBe(TRADE_DATE);
    expect(body["tradeTs"]).toBeUndefined();
  });

  /**
   * AC-T1b: the submitted `tradeTs` resolves to the exact date and time
   * entered, through the local-to-UTC conversion
   * `TransactionEditForm.buildTransactionEditBody` already performs for its
   * own field (`new Date(<local date-time>).toISOString()`).
   *
   * Read back through the local accessors rather than compared to a literal
   * UTC string: that is what "resolves to the time the user entered" means
   * for a user in any timezone, and it cannot pass by accidentally echoing
   * the implementation's own expression.
   */
  it("AC-T1b: date + time submit a tradeTs that parses back to exactly the moment entered", async () => {
    renderForm();
    await fillValidBuy();
    fireEvent.change(screen.getByTestId("trade-date-input"), { target: { value: TRADE_DATE } });
    fireEvent.change(screen.getByTestId("trade-time-input"), { target: { value: TRADE_TIME } });
    expect(screen.getByTestId("trade-time-input")).toHaveValue(TRADE_TIME);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const tradeTs = submittedBody()["tradeTs"];
    expect(typeof tradeTs).toBe("string");
    // FR-T1.3: the wire shape `createTransactionBodySchema.tradeTs`
    // (`isoInstantAsDate`) accepts — a UTC instant, not the `YYYY-MM-DDTHH:mm`
    // the control itself holds.
    expect(tradeTs).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isoInstantAsDate.safeParse(tradeTs).success).toBe(true);

    const instant = new Date(tradeTs as string);
    expect(instant.getFullYear()).toBe(2026);
    expect(instant.getMonth()).toBe(2); // March, zero-based.
    expect(instant.getDate()).toBe(12);
    expect(instant.getHours()).toBe(14);
    expect(instant.getMinutes()).toBe(37);
    expect(instant.getSeconds()).toBe(0);
  });

  /**
   * AC-T1c / NG3: the time has no bearing on FX-rate resolution, which is
   * keyed off `tradeDate` alone (`fx_rate_daily` LOCF,
   * D9/D11 — `FxRateResolver`/`CryptoRateResolver` never read `trade_ts`).
   * The web-level statement of that is: whatever the time field holds, the
   * `tradeDate` the resolver would key off is byte-identical.
   *
   * Anchored to the literal `"2026-03-12"` on *every* side rather than
   * diffing two captured values against each other — a bare "still equals
   * what it was" would pass just as happily if both had become `undefined`.
   * `"00:00"` and `"23:59"` are in the set deliberately: in any non-UTC
   * timezone at least one of them lands the *instant* on a neighbouring UTC
   * day, which is exactly the drift that would silently repin the FX rate if
   * `tradeDate` were ever derived from `tradeTs`.
   */
  it("AC-T1c: tradeDate is identical whatever the time field holds — the FX-relevant field never moves", () => {
    const emitted = ["", "00:00", TRADE_TIME, "23:59"].map((tradeTime) =>
      buildTransactionRequestPayload(
        values({
          kind: "DEPOSIT",
          portfolioId: PORTFOLIO_ID,
          tradeDate: TRADE_DATE,
          tradeTime,
          amount: "1000",
          currency: "EUR",
          cashAccountId: CASH_ACCOUNT_ID,
        }),
      ),
    );

    for (const body of emitted) {
      expect(body["tradeDate"]).toBe("2026-03-12");
    }

    // Not vacuous: the four payloads genuinely differ in `tradeTs` — three
    // distinct instants plus the absent one — so "tradeDate never moved" is
    // a statement about a form that really did change.
    const instants = emitted.map((body) => body["tradeTs"]);
    expect(instants[0]).toBeUndefined();
    expect(new Set(instants).size).toBe(4);
  });
});

/**
 * FT-21 (FR-257(3)(4),
 * AC-280's second half): the settled amount, the implied settlement rate, and
 * two different rates on one screen.
 *
 * AC-264's figures are used throughout — BUY 10 AAPL at 150,00 USD
 * (gross 1 500,00 USD), `fx_rate = 0,92`, base EUR, settled from a EUR
 * account for 1 380,00 EUR — so every expectation below is the *ledger's*
 * hand-computed one, written as a literal.
 */
describe("<TransactionForm> — the settlement pair (FT-21, FR-257)", () => {
  const CHF_ACCOUNT_ID = "7c7c7c7c-7777-4777-8777-777777777ccc";

  /** The fixture the settlement cases need: one USD, one EUR (= base, so D4) and one CHF (neither, so D3/D5) account. */
  function settlementCashResponse() {
    return cashResponse([
      cashAccount({ id: CASH_ACCOUNT_ID, name: "Compte USD", currency: "USD" }),
      cashAccount({ id: TARGET_CASH_ACCOUNT_ID, name: "Compte EUR", currency: "EUR" }),
      cashAccount({ id: CHF_ACCOUNT_ID, name: "Compte CHF", currency: "CHF" }),
    ]);
  }

  /** AC-264's BUY, up to (but not including) the cash account: 10 at 150,00 USD, rate 0,92 pinned. */
  async function fillAc264Buy(): Promise<void> {
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "150.00" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    fireEvent.change(screen.getByTestId("fx-rate-user-input"), { target: { value: "0.92" } });
  }

  function submittedBody(): Record<string, unknown> {
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    return payload as Record<string, unknown>;
  }

  beforeEach(() => {
    mockedApiClient.fetchPortfolioCash.mockResolvedValue(settlementCashResponse());
  });

  it("D4 (account in the base currency): submits cashCurrency and no cashAmount at all", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.getByTestId("cash-amount-derived")).toBeInTheDocument());

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));

    const body = submittedBody();
    expect(body["cashCurrency"]).toBe("EUR");
    // L11: the rate is what is submitted. A `cashAmount` here is rejected by
    // the write path *by name* (`CashAmountNotAcceptedError`), so the absence
    // is the requirement — not merely an empty value.
    expect(body["cashAmount"]).toBeUndefined();
    expect(body["fxRateUserInput"]).toBe("0.92");
  });

  it("D3/D5 (account in neither the trade nor the base currency): submits both figures", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", CHF_ACCOUNT_ID);

    const settledInput = await screen.findByTestId("cash-amount-input");
    fireEvent.change(settledInput, { target: { value: "1265.00" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));

    const body = submittedBody();
    expect(body["cashCurrency"]).toBe("CHF");
    expect(body["cashAmount"]).toBe("1265.00");
  });

  it("degenerate (account in the trade currency): submits neither key — AC-278's byte-compatibility, from the UI", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);

    // No settlement fields at all: there is nothing to disclose.
    expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument();

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));

    const body = submittedBody();
    expect("cashCurrency" in body).toBe(false);
    expect("cashAmount" in body).toBe(false);
  });

  it("a settlement that stops differing takes both keys off the wire with it", async () => {
    // The state a "written once, never cleared" implementation gets wrong:
    // the user picks the EUR account, then changes their mind.
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.getByTestId("settlement-fields")).toBeInTheDocument());

    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument());

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));

    const body = submittedBody();
    expect("cashCurrency" in body).toBe(false);
    expect("cashAmount" in body).toBe(false);
  });

  it("the derived figure is labelled as derived AND is not editable — either alone regresses silently", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

    const derived = (await screen.findByTestId("cash-amount-derived")) as HTMLInputElement;
    // 1 500,00 × 0,92 = 1 380,00 — hand-computed (AC-264), not the
    // component's own recomputation.
    await waitFor(() => expect(derived.value).toBe("1380"));
    expect(derived.readOnly).toBe(true);

    // FR-257(3) forbids presenting a derived figure as if the user had entered
    // it: the visible label says so, and the assertion is on the label the
    // field is actually associated with, not on any text on the page.
    const label = document.querySelector(`label[for="${derived.id}"]`);
    expect(label?.textContent ?? "").toContain("calculé");
    // No settled-amount *input* exists in D4 at all — the read-only field is
    // not merely a disabled twin of one.
    expect(screen.queryByTestId("cash-amount-input")).not.toBeInTheDocument();
  });

  it("AC-280 (second half): the implied settlement rate is displayed and equals 1 380,00 / 1 500,00 = 0,92", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

    const disclosure = await screen.findByTestId("implied-settlement-rate");
    // The literal, at the six decimals every rate in this product is shown at.
    await waitFor(() => expect(disclosure).toHaveTextContent("0.920000"));
    expect(disclosure).toHaveTextContent("1 USD =");
    expect(disclosure).toHaveTextContent("EUR");
  });

  it("the implied rate is computed from a typed settled amount too, and says nothing while there is none", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", CHF_ACCOUNT_ID);

    // Nothing typed yet: a sentence, never a rate of 1.
    const disclosure = await screen.findByTestId("implied-settlement-rate");
    expect(disclosure.textContent ?? "").not.toMatch(/\d[.,]\d/);

    // AC-265's CHF figures: 880,00 / 1 000,00 — restated for this trade's own
    // gross, 1 500,00: 1 275,00 / 1 500,00 = 0,85.
    fireEvent.change(screen.getByTestId("cash-amount-input"), { target: { value: "1275.00" } });
    await waitFor(() => expect(disclosure).toHaveTextContent("0.850000"));
  });

  it("FR-257(4): two rates, two distinguishable labels, one screen", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await screen.findByTestId("implied-settlement-rate");

    // The existing FX field keeps its own subject — `txn_currency → base` —
    // and says so; the new disclosure is about the settlement. Neither label
    // may be found twice: one label doing both jobs is exactly what FR-257(4)
    // forbids.
    const referenceRateLabels = screen.getAllByText(/devise de référence/i);
    const settlementRateLabels = screen.getAllByText(/[Tt]aux implicite de règlement/);
    expect(referenceRateLabels).toHaveLength(1);
    expect(settlementRateLabels).toHaveLength(1);
    expect(referenceRateLabels[0]?.textContent).not.toBe(settlementRateLabels[0]?.textContent);
    // And the FX field's own direction hint still reads txn -> base.
    expect(screen.getByTestId("fx-direction-label")).toHaveTextContent("1 USD = ___ EUR");
  });

  it("no new request: changing the principal account fetches nothing more", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await screen.findByTestId("settlement-fields");
    const afterFirstSelection = mockedApiClient.fetchPortfolioCash.mock.calls.length;

    await selectCashAccount("cash-account-input", CHF_ACCOUNT_ID);
    await screen.findByTestId("cash-amount-input");
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument());

    // The settlement currency is read off the list the picker already loaded —
    // three account changes, zero additional reads.
    expect(mockedApiClient.fetchPortfolioCash.mock.calls.length).toBe(afterFirstSelection);
  });

  it("L11's affordance: the statement figure back-solves the rate field, and is never submitted itself", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await screen.findByTestId("cash-amount-derived");

    // The user types what their broker actually debited: 1 365,00 EUR on a
    // 1 500,00 USD gross -> 0,91 exactly.
    fireEvent.change(screen.getByTestId("cash-amount-back-solve"), {
      target: { value: "1365.00" },
    });
    await waitFor(() => expect(screen.getByTestId("fx-rate-user-input")).toHaveValue("0.91"));
    // …and the derived field follows the rate, since that is what the server
    // will do with it.
    await waitFor(() =>
      expect((screen.getByTestId("cash-amount-derived") as HTMLInputElement).value).toBe("1365"),
    );

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const body = submittedBody();
    expect(body["fxRateUserInput"]).toBe("0.91");
    expect(body["cashAmount"]).toBeUndefined();
  });

  it("the preview reports the movement in the account's currency, not the trade's", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

    await waitFor(() =>
      expect(screen.getByTestId("transaction-preview-cash")).toHaveTextContent("EUR"),
    );
    const cash = screen.getByTestId("transaction-preview-cash");
    expect(cash.textContent ?? "").not.toContain("USD");
    // The gross row is still the trade's own figure and currency.
    expect(screen.getByTestId("transaction-preview-gross")).toHaveTextContent("USD");
  });

  it("a DEPOSIT settles the same way, and its label says credited rather than debited", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("DEPOSIT");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "1000.00" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CHF_ACCOUNT_ID);

    const settled = await screen.findByTestId("cash-amount-input");
    expect(document.querySelector(`label[for="${settled.id}"]`)?.textContent).toContain("crédité");
    fireEvent.change(settled, { target: { value: "960.00" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const body = submittedBody();
    expect(body["cashCurrency"]).toBe("CHF");
    expect(body["cashAmount"]).toBe("960.00");
  });

  it("CURRENCY_EXCHANGE keeps a filtered picker and never renders the settlement fields (FR-235)", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "500" } });
    await selectCurrency("currency-input", "USD");
    await selectCurrency("target-currency-input", "EUR");
    await choosePortfolio();

    // Filtered: the source leg offers the USD account only, so a
    // differently-denominated account cannot even be chosen here.
    await waitFor(() => expect(offeredAccountIds("cash-account-input")).toEqual([CASH_ACCOUNT_ID]));
    expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument();
  });

  it("an asset-settled BUY has no principal picker and no settlement fields (FR-236)", async () => {
    renderForm();
    await fillAc264Buy();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await screen.findByTestId("settlement-fields");

    fireEvent.click(screen.getByTestId("settlement-toggle"));

    await waitFor(() => expect(screen.queryByTestId("cash-account-input")).not.toBeInTheDocument());
    expect(screen.queryByTestId("settlement-fields")).not.toBeInTheDocument();
  });
});

/**
 * `security-transfer` TR-20 (FR-575/576/577, AC-458/459/460). One
 * « units out » tab whose destination is optional, a market value prefilled
 * from the source portfolio's last known price, and a destination that can
 * never be the source.
 */
describe("<TransactionForm> — the security-transfer tab (TR-20)", () => {
  /** `HoldingsResponse` for the source portfolio: 0.05 held, last known price 124 080 EUR. */
  function holdingsWithPrice(amount: string, currency = "EUR") {
    const valued = (value: string) => ({
      amount: value,
      currency,
      provenance: { derivedFrom: [] },
    });
    return {
      asOfDate: "2025-07-09",
      holdings: [
        {
          instrumentId: INSTRUMENT_ID,
          kind: "CRYPTO",
          displayName: "Bitcoin",
          symbol: "BTC",
          sectorCode: null,
          domicileCountry: null,
          listingCountry: null,
          hasIcon: false,
          quantity: "0.05",
          currency,
          pmp: valued("66000"),
          costBasis: valued("3300"),
          currentPrice: valued(amount),
          currentValue: valued("6204"),
          unrealizedGainLoss: valued("2904"),
          realizedGains: [],
        },
      ],
      totalValue: valued("6204"),
      totalUnrealizedGainLoss: valued("2904"),
      calcEpoch: "1",
      portfolioCount: 1,
    } as unknown as Awaited<ReturnType<typeof apiClient.fetchPortfolioHoldings>>;
  }

  beforeEach(() => {
    mockedApiClient.fetchPortfolioHoldings.mockResolvedValue(holdingsWithPrice("124080"));
  });

  async function openTransferTab(): Promise<void> {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("TRANSFER_OUT");
  }

  async function chooseDestination(portfolioId: string): Promise<void> {
    const select = screen.getByTestId("destination-portfolio-select") as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((option) => option.value)).toContain(portfolioId),
    );
    fireEvent.change(select, { target: { value: portfolioId } });
  }

  it("asks for no cash account and no price, and never reads the holdings on any other tab", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await choosePortfolio();
    expect(mockedApiClient.fetchPortfolioHoldings).not.toHaveBeenCalled();

    selectKind("TRANSFER_OUT");
    await waitFor(() =>
      expect(mockedApiClient.fetchPortfolioHoldings).toHaveBeenCalledWith(
        PORTFOLIO_ID,
        expect.anything(),
      ),
    );
    expect(screen.queryByTestId("cash-account-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unit-price-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("destination-portfolio-select")).toBeInTheDocument();
  });

  it("FR-577 client half: the source portfolio is not offered as its own destination", async () => {
    await openTransferTab();
    await choosePortfolio();
    const offered = Array.from(
      (screen.getByTestId("destination-portfolio-select") as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(offered).toEqual(["", OTHER_PORTFOLIO_ID]);
  });

  it("AC-460: the market value is prefilled as quantity × last known price, in the price's currency", async () => {
    await openTransferTab();
    await choosePortfolio();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.01" } });

    // 0.01 × 124 080 = 1 240.8, exactly — not a float product.
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("1240.8"));
    expect(screen.getByTestId("currency-input")).toHaveValue("EUR");

    // It follows the quantity while the user has not touched the value…
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.02" } });
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("2481.6"));
  });

  it("AC-460: what the user types over the prefill is what is submitted, and the prefill never takes it back", async () => {
    await openTransferTab();
    await choosePortfolio();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.01" } });
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("1240.8"));

    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "1000" } });
    // A later quantity change no longer rewrites the edited value.
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.012" } });
    expect(screen.getByTestId("amount-input")).toHaveValue("1000");

    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({ kind: "TRANSFER_OUT", quantity: "0.012", amount: "1000" });
  });

  it("empties an untouched prefill once there is nothing to prefill with, rather than keeping a stale figure", async () => {
    await openTransferTab();
    await choosePortfolio();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.01" } });
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("1240.8"));

    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue(""));
  });

  it("AC-458: a blank destination submits a source-only TRANSFER_OUT — no destination key, no cash leg", async () => {
    await openTransferTab();
    await choosePortfolio();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.01" } });
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("1240.8"));

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      kind: "TRANSFER_OUT",
      portfolioId: PORTFOLIO_ID,
      instrumentId: INSTRUMENT_ID,
      quantity: "0.01",
      amount: "1240.8",
      currency: "EUR",
    });
    expect(payload).not.toHaveProperty("destinationPortfolioId", expect.anything());
    expect(payload).not.toHaveProperty("cashAccountId", expect.anything());
  });

  it("submits the chosen destination with the source leg", async () => {
    await openTransferTab();
    await choosePortfolio();
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.01" } });
    await waitFor(() => expect(screen.getByTestId("amount-input")).toHaveValue("1240.8"));
    await chooseDestination(OTHER_PORTFOLIO_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      kind: "TRANSFER_OUT",
      portfolioId: PORTFOLIO_ID,
      destinationPortfolioId: OTHER_PORTFOLIO_ID,
    });
  });

  it("AC-459 client half: a destination equal to the source is refused before any request, in French", async () => {
    await openTransferTab();
    // Destination first, then the same portfolio as the source — the one path
    // by which the two can meet, since the source is never offered.
    await choosePortfolio(PORTFOLIO_ID);
    await chooseDestination(OTHER_PORTFOLIO_ID);
    await choosePortfolio(OTHER_PORTFOLIO_ID);
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Bitcoin");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.01" } });
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "1240.80" } });
    // The control shows the truth: the source is listed only because it is the value.
    expect(screen.getByTestId("destination-portfolio-select")).toHaveValue(OTHER_PORTFOLIO_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() =>
      expect(fieldErrorText("destination-portfolio-select")).toBe(
        "Le portefeuille de destination doit être différent du portefeuille d'origine.",
      ),
    );
    expect(mockedApiClient.createTransaction).not.toHaveBeenCalled();
  });

  it("portfolio-archive AC-486: an archived portfolio is not offered as a destination", async () => {
    const { queryClient } = renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("TRANSFER_OUT");
    await choosePortfolio();
    markArchivedInCache(queryClient, OTHER_PORTFOLIO_ID);

    await waitFor(() =>
      expect(optionPairs("destination-portfolio-select").map(([value]) => value)).toEqual([""]),
    );
  });

  it("portfolio-archive AC-487: the chosen destination, once archived, stays listed once, suffixed, and selected", async () => {
    const { queryClient } = renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("TRANSFER_OUT");
    await choosePortfolio();
    await chooseDestination(OTHER_PORTFOLIO_ID);

    markArchivedInCache(queryClient, OTHER_PORTFOLIO_ID);

    await waitFor(() =>
      expect(optionPairs("destination-portfolio-select")).toEqual([
        ["", expect.any(String)],
        [OTHER_PORTFOLIO_ID, "Compte secondaire (archivé)"],
      ]),
    );
    expect(screen.getByTestId("destination-portfolio-select")).toHaveValue(OTHER_PORTFOLIO_ID);
  });
});

describe("transferMarketValuePrefill — FR-576's arithmetic, in Decimal", () => {
  it("multiplies exactly, and has nothing to say without a quantity or a readable price", () => {
    const price = { amount: "0.1", currency: "USD" };
    // 3 × 0.1 is 0.30000000000000004 in floating point; here it is 0.3.
    expect(transferMarketValuePrefill("3", price)).toEqual({ amount: "0.3", currency: "USD" });
    expect(transferMarketValuePrefill("", price)).toBeNull();
    expect(transferMarketValuePrefill("0,5", price)).toBeNull();
    expect(transferMarketValuePrefill("3", undefined)).toBeNull();
  });

  it("bounds the product at the twelve decimals gross_amount can store", () => {
    const prefill = transferMarketValuePrefill("0.123456789", {
      amount: "0.987654321",
      currency: "EUR",
    });
    expect(prefill?.amount).toBe("0.121932631113");
  });
});

/**
 * `cash-interest` CI-T4 (AC-525, FR-637): the « Intérêt » tab. DEPOSIT's
 * amount/currency/account block, DIVIDEND's withholding fieldset and copy
 * (C-10), and nothing that names an instrument or a fee.
 */
describe("<TransactionForm> — the « Intérêt » tab (cash-interest AC-525)", () => {
  function interestBody(): Record<string, unknown> {
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    return payload as Record<string, unknown>;
  }

  it("shows date, amount, currency, the cash-account picker and the optional withholding — no instrument, no fee", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("INTEREST");
    expect(screen.getByTestId("trade-date-input")).toBeInTheDocument();
    expect(screen.getByTestId("amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("currency-input")).toBeInTheDocument();
    expect(screen.getByTestId("cash-account-input")).toBeInTheDocument();
    expect(screen.getByText("Retenue à la source (optionnel)")).toBeInTheDocument();
    expect(screen.getByTestId("withholding-amount-input")).toBeInTheDocument();
    expect(screen.queryByTestId("instrument-picker-search")).not.toBeInTheDocument();
    expect(screen.queryByTestId("instrument-picker-selected")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fee-amount-input")).not.toBeInTheDocument();
  });

  it("posts kind INTEREST, the chosen account and the withholding when filled", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("INTEREST");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "12.50" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", SECOND_USD_ACCOUNT_ID);
    fireEvent.change(screen.getByTestId("withholding-amount-input"), { target: { value: "3.75" } });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    const body = interestBody();
    expect(body).toMatchObject({
      kind: "INTEREST",
      portfolioId: PORTFOLIO_ID,
      amount: "12.50",
      currency: "USD",
      cashAccountId: SECOND_USD_ACCOUNT_ID,
    });
    expect(JSON.stringify(body["withholding"])).toBe('{"amount":"3.75"}');
    expect(body["instrumentId"]).toBeUndefined();
    expect(body["fee"]).toBeUndefined();
  });

  it("posts no withholding key when the fieldset is left blank", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("INTEREST");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "12.50" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    // The builder leaves blank keys `undefined`, which JSON drops from the wire.
    expect(interestBody()["withholding"]).toBeUndefined();
    expect(interestBody()["cashAccountId"]).toBe(CASH_ACCOUNT_ID);
  });

  // The "withholding at or above the gross" case lived here while the shared
  // schema compared the two in one currency. That rule moved to
  // `TransactionWriteService` (it compares in the settling account's
  // currency), where the api e2e suites assert the refusal and its field.
});

/**
 * `transaction-dialog-refresh` TDR-T7 (O-1) made the « Retenue » amount alone
 * enough to record a withholding, defaulting its currency and account. A later
 * change removed both: the amount **is** the withholding, in the settling account's
 * currency. The amount-only goldens (`*-withholding-defaults`) are the bodies
 * pinned below, byte for byte.
 */
describe("<TransactionForm> — the withholding is one amount", () => {
  async function dividendInEur(): Promise<void> {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("DIVIDEND");
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "100.00" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
  }

  function body(): Record<string, unknown> {
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    return payload as Record<string, unknown>;
  }

  it("a dividend from the essentials alone: 100.00 EUR with a 30.00 retenue posts { amount }, expander still closed", async () => {
    await dividendInEur();
    fireEvent.change(screen.getByTestId("withholding-amount-input"), {
      target: { value: "30.00" },
    });

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    // As the GATE-G0 `dividend-withholding-defaults` golden.
    expect(JSON.stringify(body()["withholding"])).toBe('{"amount":"30.00"}');
    expect((screen.getByTestId("more-options") as HTMLDetailsElement).open).toBe(false);
  });

  it("no retenue amount: no withholding key", async () => {
    await dividendInEur();

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    // The builder leaves the blank group `undefined`, which JSON drops from the wire.
    expect(body()["withholding"]).toBeUndefined();
    expect(JSON.stringify(body())).not.toContain("withholding");
  });

  it("switching DIVIDEND → INTEREST keeps the typed retenue", async () => {
    await dividendInEur();
    fireEvent.change(screen.getByTestId("withholding-amount-input"), { target: { value: "2.50" } });
    selectKind("INTEREST");

    fireEvent.submit(screen.getByTestId("transaction-form"));

    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    expect(body()).toMatchObject({ kind: "INTEREST" });
    // As the GATE-G0 `interest-withholding-defaults` golden.
    expect(JSON.stringify(body()["withholding"])).toBe('{"amount":"2.50"}');
  });
});

/**
 * `transaction-dialog-refresh` TDR-T10 — the fee area on BUY/SELL/DRIP and the
 * rate chips wired into the form (AC-540..AC-550,
 * AC-557, restated per C-2/C-5/C-6/C-12). Every amount below is the field's
 * wire string (`.` decimal mark); every body assertion is on the `fee` or
 * `withholding` member serialised whole, so a stray `amount` key is red.
 */
describe("<TransactionForm> — Courtage/Taxes, « Total des frais » and the rate chips (TDR-T10)", () => {
  const FORTUNEO = "rate-chip-BROKERAGE-0";
  const SAXO = "rate-chip-BROKERAGE-1";
  const TTF = "rate-chip-TAX-0";
  const PFU = "rate-chip-WITHHOLDING-0";
  const PRESET_LABELS = ["Fortuneo", "Saxo", "TTF", "PFU"];

  function body(): Record<string, unknown> {
    const [payload] = mockedApiClient.createTransaction.mock.calls[0] ?? [];
    return payload as Record<string, unknown>;
  }

  /** Every leaf string of a body — to prove no preset label travels, without a substring over serialised JSON. */
  function leafStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (value === null || typeof value !== "object") return [];
    return Object.values(value).flatMap(leafStrings);
  }

  /** Every key path of a body (`fee.components.brokerFee`) — AC-549's key-set equality. */
  function keyPaths(value: unknown, prefix = ""): string[] {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return [path, ...keyPaths(child, path)];
    });
  }

  /** A BUY in the account's own currency, so the chips are enabled once the base is typed. */
  async function buy(quantity: string, unitPrice: string): Promise<void> {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: quantity } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: unitPrice } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.getByTestId(FORTUNEO)).toBeEnabled());
  }

  async function submitted(): Promise<Record<string, unknown>> {
    fireEvent.submit(screen.getByTestId("transaction-form"));
    await waitFor(() => expect(mockedApiClient.createTransaction).toHaveBeenCalledTimes(1));
    return body();
  }

  /** The text of whatever the field's `aria-describedby` points at. */
  function describedText(element: HTMLElement): string | null {
    const id = element.getAttribute("aria-describedby");
    return id === null ? null : (document.getElementById(id)?.textContent ?? null);
  }

  it("AC-540: « Fortuneo 0.35 % » on 10 × 172.30 writes 6.03, the total reads 6.03, and the body is components only", async () => {
    await buy("10", "172.30");
    fireEvent.click(screen.getByTestId(FORTUNEO));

    expect(screen.getByTestId("fee-broker-input")).toHaveValue("6.03");
    expect(screen.getByTestId("fee-total")).toHaveTextContent("6.03 EUR");
    expect(screen.getByTestId("fee-total").tagName).toBe("OUTPUT");
    // Essential: outside « Plus d'options ».
    expect(screen.getByTestId("more-options").contains(screen.getByTestId("fee-total"))).toBe(
      false,
    );
    const fee = (await submitted())["fee"];
    expect(JSON.stringify(fee)).toBe('{"components":{"brokerFee":"6.03"}}');
  });

  it("AC-543: with « TTF 0.4 % » too, Taxes 6.89, total 12.92, both components and still no amount", async () => {
    await buy("10", "172.30");
    fireEvent.click(screen.getByTestId(FORTUNEO));
    fireEvent.click(screen.getByTestId(TTF));

    expect(screen.getByTestId("fee-tax-input")).toHaveValue("6.89");
    expect(screen.getByTestId("fee-total")).toHaveTextContent("12.92 EUR");
    const fee = (await submitted())["fee"];
    expect(JSON.stringify(fee)).toBe('{"components":{"brokerFee":"6.03","tax":"6.89"}}');
  });

  it("AC-541: « Saxo 0.08 % · min 2 EUR » writes 2.00 on 1 × 100.00 and 8.00 on 100 × 100.00", async () => {
    await buy("1", "100.00");
    fireEvent.click(screen.getByTestId(SAXO));
    expect(screen.getByTestId("fee-broker-input")).toHaveValue("2.00");

    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId(SAXO));
    expect(screen.getByTestId("fee-broker-input")).toHaveValue("8.00");
  });

  it("the total sums the four components, blank as zero, and is hidden while nothing is typed or a component does not parse", async () => {
    await buy("10", "100");
    expect(screen.queryByTestId("fee-total")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("fee-broker-input"), { target: { value: "1.10" } });
    fireEvent.change(screen.getByTestId("fee-fx-input"), { target: { value: "0.20" } });
    fireEvent.change(screen.getByTestId("fee-other-input"), { target: { value: "0.05" } });
    expect(screen.getByTestId("fee-total")).toHaveTextContent("1.35 EUR");
    fireEvent.change(screen.getByTestId("fee-tax-input"), { target: { value: "1,2" } });
    expect(screen.queryByTestId("fee-total")).not.toBeInTheDocument();
  });

  it("AC-544: with no chip clicked a BUY posts no fee, and picking another instrument never touches Taxes", async () => {
    await buy("10", "100");
    fireEvent.click(screen.getByTestId("instrument-picker-change"));
    await pickInstrument("instrument-picker", SETTLEMENT_INSTRUMENT_ID, "TotalEnergies");
    expect(screen.getByTestId("fee-tax-input")).toHaveValue("");
    expect(screen.getByTestId(TTF)).toHaveAttribute("aria-pressed", "false");
    // The builder leaves an absent group `undefined`; JSON drops it from the wire.
    expect(JSON.parse(JSON.stringify(await submitted()))).not.toHaveProperty("fee");
  });

  it("AC-546: typing clears the mark; a click on the marked chip empties the field; a base edit keeps the value and clears the mark", async () => {
    await buy("10", "172.30");
    const chip = screen.getByTestId(FORTUNEO);
    const field = screen.getByTestId("fee-broker-input");

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(field, { target: { value: "6.04" } });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(field).toHaveValue("6.04");

    fireEvent.click(chip);
    expect(field).toHaveValue("6.03");
    fireEvent.click(chip);
    expect(field).toHaveValue("");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(chip);
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "11" } });
    expect(field).toHaveValue("6.03");
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("AC-547: with Quantité empty the chips are disabled and « Saisissez d'abord le montant » describes the field", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await waitFor(() => expect(screen.getByTestId(FORTUNEO)).toBeDisabled());
    expect(screen.getByTestId(TTF)).toBeDisabled();
    for (const testId of ["fee-broker-input", "fee-tax-input"]) {
      expect(describedText(screen.getByTestId(testId))).toBe("Saisissez d'abord le montant");
    }
    expect(screen.getByTestId(FORTUNEO).getAttribute("aria-describedby")).toBe(
      screen.getByTestId("fee-broker-input").getAttribute("aria-describedby"),
    );
  });

  it("AC-548: EUR account, USD trade — chips disabled with the C-5 hint, and a typed Courtage still records", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "USD");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);

    await waitFor(() => expect(screen.getByTestId(FORTUNEO)).toBeDisabled());
    expect(screen.getByTestId(TTF)).toBeDisabled();
    const hint = "Devise du compte différente — saisissez le montant dans la devise du compte";
    expect(describedText(screen.getByTestId("fee-broker-input"))).toBe(hint);
    expect(describedText(screen.getByTestId("fee-tax-input"))).toBe(hint);

    fireEvent.change(screen.getByTestId("fee-broker-input"), { target: { value: "4.50" } });
    expect(JSON.stringify((await submitted())["fee"])).toBe('{"components":{"brokerFee":"4.50"}}');
  });

  it("C-12: an asset-settled BUY disables the chips with « Réglé en actif — saisissez le montant »", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "0.02" } });
    fireEvent.click(screen.getByTestId("settlement-toggle"));
    await waitFor(() => expect(screen.getByTestId(FORTUNEO)).toBeDisabled());
    expect(describedText(screen.getByTestId("fee-broker-input"))).toBe(
      "Réglé en actif — saisissez le montant",
    );
  });

  it("AC-545: DIVIDEND 100.00 EUR « PFU 30 % » writes 30.00 and posts it as the withholding amount, with no preset field", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("DIVIDEND");
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "100.00" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.getByTestId(PFU)).toBeEnabled());
    expect(screen.queryByTestId(FORTUNEO)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(PFU));
    expect(screen.getByTestId("withholding-amount-input")).toHaveValue("30.00");

    const payload = await submitted();
    expect(JSON.stringify(payload["withholding"])).toBe('{"amount":"30.00"}');
    for (const label of PRESET_LABELS) expect(leafStrings(payload)).not.toContain(label);
  });

  it("AC-545: INTEREST 50.00 EUR « PFU 30 % » writes 15.00", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("INTEREST");
    fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "50.00" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await waitFor(() => expect(screen.getByTestId(PFU)).toBeEnabled());
    fireEvent.click(screen.getByTestId(PFU));
    expect(screen.getByTestId("withholding-amount-input")).toHaveValue("15.00");
    expect((await submitted())["withholding"]).toMatchObject({ amount: "15.00" });
  });

  it("AC-549 (unit half): after a chip click the body has exactly the key set of the T0 golden, and no preset label", async () => {
    // The GATE-G0 `buy-fee-total-only.after` inputs, with Courtage from a chip.
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await choosePortfolio();
    fireEvent.change(screen.getByTestId("trade-date-input"), { target: { value: "2026-03-12" } });
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "12" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "151.30" } });
    await selectCurrency("currency-input", "USD");
    await selectCashAccount("cash-account-input", CASH_ACCOUNT_ID);
    fireEvent.change(screen.getByTestId("fx-rate-user-input"), { target: { value: "0.9175" } });
    await waitFor(() => expect(screen.getByTestId(FORTUNEO)).toBeEnabled());
    fireEvent.click(screen.getByTestId(FORTUNEO));

    const payload = await submitted();
    const golden: unknown = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "web/src/__fixtures__/transaction-payload-goldens/buy-fee-total-only.after.json",
        ),
        "utf8",
      ),
    );
    // The wire body: `undefined` members are dropped by the serialisation.
    const wire: unknown = JSON.parse(JSON.stringify(payload));
    expect(keyPaths(wire).sort()).toEqual(keyPaths(golden).sort());
    // 12 × 151.30 = 1 815.60 × 0.35 % = 6.3546 → 6.35.
    expect(JSON.stringify(payload["fee"])).toBe('{"components":{"brokerFee":"6.35"}}');
    for (const label of PRESET_LABELS) expect(leafStrings(payload)).not.toContain(label);
  });

  it("AC-550: CURRENCY_EXCHANGE keeps an editable « Frais » with no chip row, its components in « Plus d'options »", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    await waitFor(() => expect(mockedApiClient.fetchRatePresets).toHaveBeenCalled());
    const total = screen.getByTestId("fee-amount-input");
    expect(total.tagName).toBe("INPUT");
    expect(total).not.toHaveAttribute("readonly");
    expect(screen.getByTestId("more-options").contains(total)).toBe(false);
    expect(
      screen.getByTestId("transaction-form").querySelectorAll('[data-testid^="rate-chip"]'),
    ).toHaveLength(0);
    for (const testId of ["fee-broker-input", "fee-fx-input", "fee-tax-input", "fee-other-input"]) {
      expect(screen.getByTestId("more-options").contains(screen.getByTestId(testId))).toBe(true);
    }
    expect(screen.queryByTestId("fee-total")).not.toBeInTheDocument();
  });

  it("O-2: a total typed on CURRENCY_EXCHANGE does not travel to a BUY", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    selectKind("CURRENCY_EXCHANGE");
    fireEvent.change(screen.getByTestId("fee-amount-input"), { target: { value: "1.50" } });
    selectKind("BUY");
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    // The builder leaves an absent group `undefined`; JSON drops it from the wire.
    expect(JSON.parse(JSON.stringify(await submitted()))).not.toHaveProperty("fee");
  });

  it("AC-557: a failed presets read hides the chips, disables « + », and the dialog still records a typed cost", async () => {
    mockedApiClient.fetchRatePresets.mockRejectedValue(new Error("network"));
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("rate-chip-add-BROKERAGE")).toBeDisabled());
    expect(screen.getByTestId("rate-chip-add-TAX")).toBeDisabled();
    expect(screen.queryByTestId(FORTUNEO)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TTF)).not.toBeInTheDocument();
    expect(describedText(screen.getByTestId("fee-broker-input"))).toBe(
      "Taux prédéfinis indisponibles — saisissez le montant",
    );

    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    fireEvent.change(screen.getByTestId("fee-broker-input"), { target: { value: "2.50" } });
    fireEvent.change(screen.getByTestId("fee-tax-input"), { target: { value: "1.00" } });
    expect(JSON.stringify((await submitted())["fee"])).toBe(
      '{"components":{"brokerFee":"2.50","tax":"1.00"}}',
    );
  });

  it("the presets read is not a derived key: a successful write never refetches it", async () => {
    const { onSubmitted } = renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "100" } });
    await selectCurrency("currency-input", "EUR");
    await choosePortfolio();
    await selectCashAccount("cash-account-input", TARGET_CASH_ACCOUNT_ID);
    await submitted();
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(mockedApiClient.fetchRatePresets).toHaveBeenCalledTimes(1);
  });
});

describe("<TransactionForm> — a kind switch resets the fields the new kind does not show", () => {
  it("BUY → DIVIDEND after quantity and price: « Montant brut » is empty, and back on BUY the two fields are blank", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    await pickInstrument("instrument-picker", INSTRUMENT_ID, "Apple Inc");
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "172.30" } });
    fireEvent.change(screen.getByTestId("fee-broker-input"), { target: { value: "2.50" } });
    // The positive half first: the BUY's own gross is on screen, so the
    // empty state below cannot be a preview that never rendered a figure.
    expect(screen.getByTestId("transaction-preview-gross")).toHaveTextContent("723");

    selectKind("DIVIDEND");
    expect(screen.queryByTestId("quantity-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("transaction-preview-gross")).toHaveTextContent("—");
    expect(screen.getByTestId("transaction-preview-gross")).not.toHaveTextContent("723");
    // A field the DIVIDEND shows survives the switch.
    expect(screen.getByTestId("instrument-picker-selected")).toHaveTextContent("Apple Inc");

    selectKind("BUY");
    expect(screen.getByTestId("quantity-input")).toHaveValue("");
    expect(screen.getByTestId("unit-price-input")).toHaveValue("");
    expect(screen.getByTestId("fee-broker-input")).toHaveValue("");
  });

  it("BUY → SELL keeps quantity and price: both kinds show them", async () => {
    renderForm();
    await waitFor(() => expect(mockedApiClient.fetchPortfolios).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("quantity-input"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("unit-price-input"), { target: { value: "172.30" } });
    selectKind("SELL");
    expect(screen.getByTestId("quantity-input")).toHaveValue("10");
    expect(screen.getByTestId("unit-price-input")).toHaveValue("172.30");
    expect(screen.getByTestId("transaction-preview-gross")).toHaveTextContent("723");
  });
});
