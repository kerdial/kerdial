import { expect, type Page } from "@playwright/test";
import { mockPortfolioCash, type CashAccountFixture } from "./mocks.js";
import type { RoutableTarget } from "./mocks.js";

/**
 * Selects a cash account in `TransactionForm`'s picker slots, so a spec that
 * submits the create form produces a payload `createTransactionBodySchema`
 * accepts (FR-156: every leg that moves cash names the account it moved it
 * in).
 *
 * Without it, submission fails resolver validation and the dialog simply stays
 * open — the exact 19-failure surface CA-25 was opened on.
 *
 * ## What CA-22 changed here, and what it deliberately did not
 *
 * CA-25 wrote this as **one** greppable helper precisely so CA-20's
 * replacement of Batch B's interim uuid `<Input>`s with the real
 * `CashAccountPicker` would be one function body to convert, not 19 scattered
 * `.fill("<uuid>")` calls to find. That is exactly how it went: the body below
 * changed from `Locator.fill` to `Locator.selectOption`, the nine call sites'
 * shape did not change at all, and the only other edit was adding
 * {@link mockCashAccounts} to each spec's own setup (a route registration
 * cannot live inside a gesture — it has to be in place before the picker's
 * query fires).
 *
 * ## Why the legs are named, and never auto-detected
 *
 * Unchanged from CA-25, and still load-bearing. A "select whatever cash
 * picker happens to be on screen" helper would be wrong twice over. It would
 * silently do nothing on a form that renders none — a crypto-settled BUY has
 * no cash principal leg at all (FR-157). The fee and withholding legs once
 * had pickers of their own (`feeCashAccountId`, `withholdingCashAccountId`);
 * both are gone — a cost and a withholding settle on
 * the principal account — so there is no `CashLeg` value for them.
 *
 * Naming the legs also makes each call site state which cash legs its
 * transaction has. `selectOption` throws when the control is not rendered
 * **or when the option is not offered**, so a call naming a leg the current
 * form does not have — or naming one whose currency the picker filtered the
 * fixture out of — fails loudly instead of passing vacuously. That is a
 * strictly stronger guarantee than `fill` gave: `fill` accepted any string.
 */
export type CashLeg = "principal" | "target";

/**
 * The fixture accounts, **keyed by currency** rather than by leg.
 *
 * That re-keying is CA-22's one substantive change to this module's shape,
 * and it is forced by the picker being currency-filtered (CD12 behaviour 2):
 * under the old uuid `<Input>` any id went into any leg, so one constant per
 * leg was enough. Now a EUR leg can only ever be given a EUR account, and
 * this suite's specs use both EUR and USD principal legs — so a single
 * `CASH_ACCOUNT_ID` would have had to be two currencies at once.
 *
 * The `cacacaca-` prefix keeps them disjoint from every uuid this suite
 * already asserts on (`instrument-create.spec.ts` expects
 * `55555555-…`/`66666666-…`/`77777777-…` as *instrument* ids), so no assertion
 * can pass because two different ids happened to be the same literal.
 */
export const CASH_ACCOUNT_IDS = {
  EUR: "cacacaca-0001-4000-8000-000000000001",
  USD: "cacacaca-0002-4000-8000-000000000002",
} as const;

/** A second EUR account, so the EUR principal leg genuinely requires a selection rather than being prefilled (CD12 behaviour 5's negative half) — which is what keeps the `selectOption` below load-bearing instead of decorative. */
export const SECOND_EUR_ACCOUNT_ID = "cacacaca-0003-4000-8000-000000000003";

/** Archived, with a non-zero balance — RC4's fixture: it must stay out of every picker and stay *in* the EUR total on the workspace tab. */
export const ARCHIVED_EUR_ACCOUNT_ID = "cacacaca-0004-4000-8000-000000000004";

/**
 * The shared `GET /portfolios/:id/cash` fixture. EUR: two active
 * (1000.00 + -50.00) plus one archived (12.00) -> 962.00; USD: one active
 * (250.00). The negative EUR account is what gives the workspace tab's
 * AC-183 assertion a real overdrawn row with a positive sibling.
 */
export const CASH_ACCOUNT_FIXTURE: readonly CashAccountFixture[] = [
  {
    id: CASH_ACCOUNT_IDS.EUR,
    name: "Compte courant EUR",
    currency: "EUR",
    archived: false,
    balance: "1000.00",
    isNegative: false,
  },
  {
    id: SECOND_EUR_ACCOUNT_ID,
    name: "Réserve EUR",
    currency: "EUR",
    archived: false,
    balance: "-50.00",
    isNegative: true,
  },
  {
    id: ARCHIVED_EUR_ACCOUNT_ID,
    name: "Ancien compte EUR",
    currency: "EUR",
    archived: true,
    balance: "12.00",
    isNegative: false,
  },
  {
    id: CASH_ACCOUNT_IDS.USD,
    name: "Compte USD",
    currency: "USD",
    archived: false,
    balance: "250.00",
    isNegative: false,
  },
];

/**
 * Registers the picker's own read. Every spec that calls
 * {@link fillCashAccountFields} calls this in its setup, **before** the app
 * navigates — a route registered after the picker's query has already fired
 * intercepts nothing.
 *
 * Takes a `RoutableTarget` so a spec running under a controlling service
 * worker passes its `BrowserContext` (`context.route`, never `page.route` —
 * this repo's recorded flake root cause: `page.route` does not intercept a
 * fetch issued by a controlling service worker's own handler).
 */
export async function mockCashAccounts(
  target: RoutableTarget,
  accounts: readonly CashAccountFixture[] = CASH_ACCOUNT_FIXTURE,
): Promise<void> {
  await mockPortfolioCash(target, accounts);
}

/** Reads the leg's currency straight off the form, so one helper serves a EUR spec and a USD spec without either call site changing. */
const CURRENCY_FIELD_BY_LEG: Record<CashLeg, string> = {
  principal: "currency-input",
  target: "target-currency-input",
};

const PICKER_TESTID_BY_LEG: Record<CashLeg, string> = {
  principal: "cash-account-input",
  target: "target-cash-account-input",
};

/** Selects the named legs' cash accounts. Defaults to the principal leg, the only one most specs have. */
export async function fillCashAccountFields(
  page: Page,
  legs: readonly CashLeg[] = ["principal"],
): Promise<void> {
  for (const leg of legs) {
    const currency = await page.getByTestId(CURRENCY_FIELD_BY_LEG[leg]).inputValue();
    const accountId = CASH_ACCOUNT_IDS[currency as keyof typeof CASH_ACCOUNT_IDS];
    // A spec that introduces a third currency must add it to the fixture
    // above rather than get a silent no-selection here.
    expect(
      accountId,
      `cash-account-helpers: no fixture account for ${currency} (${leg} leg)`,
    ).toBeDefined();
    await page.getByTestId(PICKER_TESTID_BY_LEG[leg]).selectOption(accountId);
  }
}
