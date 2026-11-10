import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "../lib/api-client.js";
import type { CashAccountBalance, PortfolioCashResponse } from "../lib/api-client.js";
import { CashAccountPicker } from "./CashAccountPicker.js";

/**
 * `CashAccountPicker`'s own suite — **new with FT-20**
 * (FR-257(1)(2), AC-280).
 *
 * The component shipped with CA-20 carrying no test file of its own: both
 * entry points tested it through *their* forms (`TransactionForm.test.tsx`,
 * `TransactionEditForm.test.tsx`), which is why "the existing tests still
 * pass" is not available as evidence for the change FT-20 makes. This file is
 * that missing baseline, and it covers: all
 * five of CD12's behaviours at `filterByCurrency: true`, and the four the prop
 * does not touch asserted **again** at `false` — a mode that silently dropped
 * behaviour 3 or 5 is the recorded failure class for a picker that gains a
 * mode (RC6), and only asserting both modes catches it.
 */

vi.mock("../lib/api-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api-client.js")>("../lib/api-client.js");
  return { ...actual, fetchPortfolioCash: vi.fn(), createCashAccount: vi.fn() };
});

const mockedApiClient = vi.mocked(apiClient);

const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
const EUR_ACCOUNT_ID = "cacacaca-0001-4000-8000-000000000001";
const SECOND_EUR_ACCOUNT_ID = "cacacaca-0002-4000-8000-000000000002";
const USD_ACCOUNT_ID = "cacacaca-0003-4000-8000-000000000003";
const ARCHIVED_EUR_ACCOUNT_ID = "cacacaca-0004-4000-8000-000000000004";

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

function cashResponse(accounts: readonly CashAccountBalance[]): PortfolioCashResponse {
  return { accounts, byCurrency: [], calcEpoch: "1" };
}

/**
 * The default fixture: **one** EUR account, **one** USD account, **one**
 * archived EUR account.
 *
 * The single-account-per-currency shape is deliberate: it makes behaviour 5's
 * prefill live in *both* modes at once (one EUR match while filtering; one
 * account is never the whole pool unfiltered, so the unfiltered prefill has to
 * be driven by its own fixture below). Tests that need "two match" say so.
 */
const ACCOUNTS: readonly CashAccountBalance[] = [
  cashAccount({ id: EUR_ACCOUNT_ID, name: "Compte courant EUR", currency: "EUR" }),
  cashAccount({ id: USD_ACCOUNT_ID, name: "Compte USD", currency: "USD" }),
  cashAccount({
    id: ARCHIVED_EUR_ACCOUNT_ID,
    name: "Ancien EUR",
    currency: "EUR",
    archived: true,
  }),
];

interface MountOptions {
  readonly currency?: string;
  readonly portfolioId?: string;
  readonly value?: string;
  readonly accounts?: readonly CashAccountBalance[];
  /** Deliberately `undefined` in the "the default is `true`" test — the prop is then never passed at all. */
  readonly filterByCurrency?: boolean;
  readonly prefillSoleMatch?: boolean;
}

/** Mounts the picker as a controlled field, echoing `onChange` back into `value` exactly as both real parents do. */
function mountPicker(options: MountOptions = {}): { onChange: ReturnType<typeof vi.fn> } {
  mockedApiClient.fetchPortfolioCash.mockResolvedValue(cashResponse(options.accounts ?? ACCOUNTS));
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Harness() {
    return (
      <CashAccountPicker
        label="Compte espèce"
        portfolioId={options.portfolioId ?? PORTFOLIO_ID}
        currency={options.currency ?? "EUR"}
        value={options.value ?? ""}
        onChange={onChange}
        testId="picker"
        {...(options.filterByCurrency === undefined
          ? {}
          : { filterByCurrency: options.filterByCurrency })}
        {...(options.prefillSoleMatch === undefined
          ? {}
          : { prefillSoleMatch: options.prefillSoleMatch })}
      />
    );
  }

  render(
    (
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    ) as ReactElement,
  );
  return { onChange };
}

/** The ids the control currently offers, placeholder excluded. */
function offeredIds(): string[] {
  const select = screen.getByTestId("picker") as HTMLSelectElement;
  return Array.from(select.options)
    .map((option) => option.value)
    .filter((value) => value !== "");
}

/** The labels the control currently offers — behaviour 3's « (archivé) » suffix is asserted on these, not on the ids. */
function offeredLabels(): string[] {
  const select = screen.getByTestId("picker") as HTMLSelectElement;
  return Array.from(select.options)
    .filter((option) => option.value !== "")
    .map((option) => option.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CashAccountPicker — CD12's five behaviours with the filter ON (the default)", () => {
  it("behaviour 1 — portfolio-scoped: no read at all without a portfolio, then scoped to that id", async () => {
    mountPicker({ portfolioId: "" });

    // One-shot, not a retrying matcher: "never fetched" must not be able to
    // pass by being checked before the fetch would have fired.
    expect(mockedApiClient.fetchPortfolioCash).not.toHaveBeenCalled();
    expect(screen.getByTestId("picker")).toBeDisabled();
    expect(screen.getByTestId("picker-needs-portfolio")).toBeInTheDocument();

    cleanup();
    mountPicker();
    await waitFor(() =>
      expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalledWith(
        PORTFOLIO_ID,
        expect.anything(),
      ),
    );
  });

  it("behaviour 2 — currency-filtered: a USD leg offers the USD account and not the EUR one", async () => {
    mountPicker({ currency: "USD" });
    await waitFor(() => expect(offeredIds()).toEqual([USD_ACCOUNT_ID]));
    // The positive companion to the exclusion: the EUR account is genuinely in
    // the fixture, it is simply not offered here.
    expect(ACCOUNTS.map((account) => account.id)).toContain(EUR_ACCOUNT_ID);
  });

  it("behaviour 3 — an archived account is offered only when it is the one already attributed, and says so", async () => {
    mountPicker();
    await waitFor(() => expect(offeredIds()).toContain(EUR_ACCOUNT_ID));
    expect(offeredIds()).not.toContain(ARCHIVED_EUR_ACCOUNT_ID);

    cleanup();
    mountPicker({ value: ARCHIVED_EUR_ACCOUNT_ID });
    await waitFor(() => expect(offeredIds()).toContain(ARCHIVED_EUR_ACCOUNT_ID));
    expect(offeredLabels()).toContain("Ancien EUR (archivé)");
  });

  it("behaviour 4 — nothing in this currency: the empty state names the currency and the dialog pins it", async () => {
    mountPicker({ currency: "GBP" });
    await waitFor(() => expect(screen.getByTestId("picker-empty")).toBeInTheDocument());
    expect(screen.getByTestId("picker-empty")).toHaveTextContent(
      "Aucun compte espèce en GBP dans ce portefeuille.",
    );
    expect(screen.getByTestId("picker-create")).toHaveTextContent("Créer un compte en GBP");

    fireEvent.click(screen.getByTestId("picker-create"));
    expect(await screen.findByTestId("cash-account-form-dialog")).toBeVisible();
    // Pinned, not offered: an account in another currency could not be
    // attributed to this leg while the filter is on.
    expect(screen.getByTestId("cash-account-locked-currency")).toHaveTextContent("GBP");
    expect(screen.queryByTestId("cash-account-currency-select")).not.toBeInTheDocument();
  });

  it("behaviour 5 — exactly one match preselects it through onChange; two or more preselect nothing", async () => {
    const { onChange } = mountPicker();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(EUR_ACCOUNT_ID));

    cleanup();
    vi.clearAllMocks();
    const two = mountPicker({
      accounts: [
        ...ACCOUNTS,
        cashAccount({ id: SECOND_EUR_ACCOUNT_ID, name: "Réserve EUR", currency: "EUR" }),
      ],
    });
    await waitFor(() => expect(offeredIds()).toHaveLength(2));
    expect(two.onChange).not.toHaveBeenCalled();
  });
});

describe("CashAccountPicker — the four behaviours the prop does not touch, re-asserted with the filter OFF", () => {
  it("behaviour 1 still holds — still no unscoped read, still disabled without a portfolio", async () => {
    mountPicker({ portfolioId: "", filterByCurrency: false });
    expect(mockedApiClient.fetchPortfolioCash).not.toHaveBeenCalled();
    expect(screen.getByTestId("picker")).toBeDisabled();
    expect(screen.getByTestId("picker-needs-portfolio")).toBeInTheDocument();

    cleanup();
    mountPicker({ filterByCurrency: false });
    await waitFor(() =>
      expect(mockedApiClient.fetchPortfolioCash).toHaveBeenCalledWith(
        PORTFOLIO_ID,
        expect.anything(),
      ),
    );
  });

  /**
   * Behaviour 3, re-asserted at `false` — the behaviour this project's record
   * says gets dropped the moment a picker gains a mode, and the one whose loss
   * would silently blank an attribution on the **edit** form.
   */
  it("behaviour 3 still holds — the attributed archived account is offered, « (archivé) », and its siblings are not", async () => {
    mountPicker({ filterByCurrency: false, value: ARCHIVED_EUR_ACCOUNT_ID, currency: "USD" });
    await waitFor(() => expect(offeredIds()).toContain(ARCHIVED_EUR_ACCOUNT_ID));
    expect(offeredLabels()).toContain("Ancien EUR (archivé)");
    // Not "everything, archived included": only the attributed one comes back.
    expect(offeredIds()).toEqual([EUR_ACCOUNT_ID, USD_ACCOUNT_ID, ARCHIVED_EUR_ACCOUNT_ID]);
  });

  it("behaviour 4 still holds — an empty portfolio still offers creation, with copy that no longer names a currency", async () => {
    mountPicker({ filterByCurrency: false, currency: "USD", accounts: [] });
    await waitFor(() => expect(screen.getByTestId("picker-empty")).toBeInTheDocument());
    expect(screen.getByTestId("picker-empty")).toHaveTextContent(
      "Aucun compte espèce dans ce portefeuille.",
    );
    expect(screen.getByTestId("picker-empty").textContent ?? "").not.toContain("USD");
    expect(screen.getByTestId("picker-create")).toHaveTextContent("Créer un compte espèce");

    fireEvent.click(screen.getByTestId("picker-create"));
    expect(await screen.findByTestId("cash-account-form-dialog")).toBeVisible();
    // FR-257(2): the currency is the user's to choose here — pinning the
    // transaction's currency onto the new account is the constraint phase 1
    // removes.
    expect(screen.getByTestId("cash-account-currency-select")).toBeInTheDocument();
    expect(screen.queryByTestId("cash-account-locked-currency")).not.toBeInTheDocument();
  });

  it("behaviour 5 still holds — a portfolio with a single account preselects it, whatever the leg's currency", async () => {
    const { onChange } = mountPicker({
      filterByCurrency: false,
      currency: "USD",
      accounts: [cashAccount({ id: EUR_ACCOUNT_ID, name: "Compte courant EUR" })],
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(EUR_ACCOUNT_ID));
  });
});

describe("CashAccountPicker — FR-257(1)(2), AC-280's first half", () => {
  /**
   * AC-280's first half, asserted **in one render**: "it offers the EUR
   * account for a USD trade" and "it no longer demands a USD account" are the
   * two halves of the same claim, and either one alone can pass while the
   * capability is still unreachable.
   */
  it("a portfolio holding only a EUR account offers it for a USD leg, and renders no « Créer un compte en USD » state", async () => {
    mountPicker({
      filterByCurrency: false,
      currency: "USD",
      accounts: [cashAccount({ id: EUR_ACCOUNT_ID, name: "Compte courant EUR" })],
    });

    await waitFor(() => expect(offeredIds()).toEqual([EUR_ACCOUNT_ID]));
    expect(screen.queryByTestId("picker-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("picker-create")).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("Créer un compte en USD");
  });

  it("the same portfolio and leg WITH the filter on is the state phase 1 removes — the contrast that makes the assertion above non-vacuous", async () => {
    mountPicker({
      filterByCurrency: true,
      currency: "USD",
      accounts: [cashAccount({ id: EUR_ACCOUNT_ID, name: "Compte courant EUR" })],
    });

    await waitFor(() => expect(screen.getByTestId("picker-empty")).toBeInTheDocument());
    expect(offeredIds()).toEqual([]);
    expect(screen.getByTestId("picker-create")).toHaveTextContent("Créer un compte en USD");
  });

  /**
   * The default matters as much as the opt-out: a silently flipped default
   * would remove the **fee** leg's filter, which FR-237 forbids — phase 1 does
   * not change that leg's FK, so an account in another currency there is a
   * rejected write, not a new capability.
   */
  it("the default is `true` — a picker mounted with no prop at all still filters", async () => {
    mountPicker({ currency: "USD" });
    await waitFor(() => expect(offeredIds()).toEqual([USD_ACCOUNT_ID]));
    expect(offeredIds()).not.toContain(EUR_ACCOUNT_ID);
  });

  it("the leg's currency stops gating the control when the filter is off, and still gates it when on", async () => {
    mountPicker({ filterByCurrency: false, currency: "" });
    await waitFor(() => expect(screen.getByTestId("picker")).toBeEnabled());
    expect(screen.queryByTestId("picker-needs-currency")).not.toBeInTheDocument();
    await waitFor(() => expect(offeredIds()).toEqual([EUR_ACCOUNT_ID, USD_ACCOUNT_ID]));

    cleanup();
    mountPicker({ currency: "" });
    expect(screen.getByTestId("picker-needs-currency")).toBeInTheDocument();
    expect(screen.getByTestId("picker")).toBeDisabled();
  });

  /**
   * The source-text half of FT-20's last acceptance criterion. The rendered
   * assertions above prove what each mode *shows*; this proves the sentence
   * that asserts the removed constraint exists in exactly one place — the
   * filtered branch — so a future edit cannot reintroduce it on the unfiltered
   * path without turning this red.
   *
   * **The scan is split in two, and not weakened.** The four
   * sentences now live in `lib/copy/portfolios.ts`, so that is where their
   * *text* is asserted; the *guard* is still asserted here, against this
   * component, because "the currency-naming copy is the true arm of a
   * `filterByCurrency ?` ternary" is a fact about this file and nowhere else.
   * Scanning only the component would have gone green on a file that no longer
   * contains the strings — which is exactly the failure mode this test exists
   * to prevent, one level up.
   */
  it("« en {currency} » survives only on the filtered path", () => {
    // `process.cwd()`, not `import.meta.url`: these suites run under
    // `environmentMatchGlobs`' jsdom, where `import.meta.url` is not a `file:`
    // URL — the same resolution `LedgerAmount.test.tsx`'s own source scan uses.
    const source = readFileSync(
      resolve(process.cwd(), "web/src/components/CashAccountPicker.tsx"),
      "utf8",
    );
    const catalogue = readFileSync(
      resolve(process.cwd(), "web/src/lib/copy/portfolios.ts"),
      "utf8",
    );

    expect(catalogue).toContain(
      'pickerEmptyInCurrency: "Aucun compte espèce en {currency} dans ce portefeuille."',
    );
    expect(catalogue).toContain('pickerCreateInCurrency: "Créer un compte en {currency}"');
    expect(catalogue).toContain('pickerEmpty: "Aucun compte espèce dans ce portefeuille."');
    expect(catalogue).toContain('createCashAccount: "Créer un compte espèce"');

    // Each currency-naming key is the *true* arm of a `filterByCurrency ?`
    // ternary, so neither can have become unconditional copy again: the guard
    // is asserted to sit immediately before it, not merely somewhere in the
    // file. The only thing allowed between them is the `fill(` that supplies
    // the `{currency}` slot — anything else means the guard moved.
    for (const naming of [
      "PORTFOLIO_COPY.pickerEmptyInCurrency",
      "PORTFOLIO_COPY.pickerCreateInCurrency",
    ]) {
      const guard = source.slice(0, source.indexOf(naming)).lastIndexOf("filterByCurrency");
      expect(guard).toBeGreaterThan(-1);
      expect(source.slice(guard, source.indexOf(naming))).toMatch(
        /^filterByCurrency\s*\?\s*(?:fill\()?\s*$/m,
      );
    }
  });
});
