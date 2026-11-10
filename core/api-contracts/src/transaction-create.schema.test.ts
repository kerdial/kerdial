import { describe, expect, it } from "vitest";
import {
  TRANSACTION_REFERENCE_MAX_LENGTH,
  createTransactionBodySchema,
  transactionReferenceEditSchema,
} from "./transaction-create.schema.js";

/**
 * **FT-16 (`fee-tax-breakdown`, Batch C) — the
 * three `superRefine` rules the settlement pair adds, and AC-278's captured
 * pre-cycle body.**
 *
 * One test per rule, and **each asserts the issue path by name**. That is not
 * decoration: `web/src/lib/transaction-form-payload.ts`'s
 * `ISSUE_PATH_TO_FIELD` routes a rejection onto a form control *by this
 * path*, and this repo has a recorded finding (F2, security review, T-44)
 * of a schema issue landing in the wrong field's error slot — a rule that
 * fires with the right message on the wrong path is invisible in the UI.
 *
 * `web/src/lib/tester-schema-parity.test.ts` proves the *other* half — that
 * `api` validates against this same object, over a corpus that now includes
 * both new fields. This file is about what the rules say; that one is about
 * who says it.
 */

const PORTFOLIO_ID = "11111111-1111-4111-8111-111111111111";
const INSTRUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT_INSTRUMENT_ID = "33333333-3333-4333-8333-333333333333";
const CASH_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_CASH_ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";

/** The dotted issue paths of a rejection, sorted — the exact shape `ISSUE_PATH_TO_FIELD` is keyed on. */
function issuePaths(payload: Record<string, unknown>): string[] {
  const result = createTransactionBodySchema.safeParse(payload);
  expect(result.success, `expected ${JSON.stringify(payload)} to be rejected`).toBe(false);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join(".")).sort();
}

/** A fiat-settled BUY that is valid on every *other* rule, so a rejection below can only be the rule under test. */
function buy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "BUY",
    portfolioId: PORTFOLIO_ID,
    tradeDate: "2026-01-15",
    instrumentId: INSTRUMENT_ID,
    quantity: "10",
    unitPrice: "150.00",
    currency: "USD",
    cashAccountId: CASH_ACCOUNT_ID,
    ...extra,
  };
}

/** An asset-settled BUY — FR-236's shape, which carries no principal cash leg at all. */
function settledBuy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "BUY",
    portfolioId: PORTFOLIO_ID,
    tradeDate: "2026-01-15",
    instrumentId: INSTRUMENT_ID,
    quantity: "0.02",
    settlement: { instrumentId: SETTLEMENT_INSTRUMENT_ID, amount: "1" },
    ...extra,
  };
}

/** A CURRENCY_EXCHANGE valid on every other rule — FR-235's kind. */
function exchange(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "CURRENCY_EXCHANGE",
    portfolioId: PORTFOLIO_ID,
    tradeDate: "2026-01-15",
    amount: "1000",
    currency: "USD",
    cashAccountId: CASH_ACCOUNT_ID,
    targetCurrency: "EUR",
    targetCashAccountId: TARGET_CASH_ACCOUNT_ID,
    exchangeRate: "0.92",
    ...extra,
  };
}

describe("createTransactionBodySchema — the settlement pair's superRefine rules (FT-16, FR-255)", () => {
  /**
   * Rule 1, both directions — and they are **not symmetric**, which is the
   * whole content of this test.
   *
   * `transaction_cash_amount_currency_pairing` (migration `0045`) and
   * `#resolveCashLeg`'s `UNPAIRED_WITHOUT_CURRENCY` row are the backstops for
   * the amount-alone direction; this is the per-field 400 in front of them.
   *
   * The currency-alone direction is **accepted here on purpose**: it is D4's
   * own request shape (L11 — the server derives the settled amount from
   * `gross x fx_rate` and *rejects* a supplied one), and D4 is AC-257's write.
   * Whether a given `cashCurrency` means D4 or D3/D5 is decidable only where
   * `tenant.base_currency` is readable (P22), which is not this layer;
   * requiring the amount here would make the feature's own case a 400.
   */
  it("rule 1 — an amount alone is refused on `cashCurrency`, while a currency alone is accepted (D4's shape, L11)", () => {
    // cashAmount alone -> the issue names `cashCurrency`, the missing half.
    expect(issuePaths(buy({ cashAmount: "1380.00" }))).toEqual(["cashCurrency"]);

    // …and the asymmetric half: a currency alone parses, because the server
    // is the only layer that can decide whether it derives the amount or
    // demands it. Asserted as a *success*, so the rule is proven to be
    // one-directional rather than merely untested in this direction.
    expect(createTransactionBodySchema.safeParse(buy({ cashCurrency: "EUR" })).success).toBe(true);

    // The positive companion, so the rejection above is not some *other*
    // rule firing: the identical body with both fields is accepted.
    expect(
      createTransactionBodySchema.safeParse(buy({ cashCurrency: "EUR", cashAmount: "1380.00" }))
        .success,
    ).toBe(true);
    // …and so is the body with neither — omission is the degenerate case
    // (AC-278), not a third rejection.
    expect(createTransactionBodySchema.safeParse(buy()).success).toBe(true);
  });

  /** Rule 2, first half (FR-236). */
  it("rule 2a — cashCurrency is forbidden when settlement is present, and the issue is on `cashCurrency`", () => {
    expect(issuePaths(settledBuy({ cashCurrency: "EUR", cashAmount: "1380.00" }))).toEqual([
      "cashAmount",
      "cashCurrency",
    ]);
    // Isolated, and exactly — a `cashCurrency` alone on a settled BUY is
    // refused on its own path and on no other, since the pairing rule above
    // does not fire in this direction.
    expect(issuePaths(settledBuy({ cashCurrency: "EUR" }))).toEqual(["cashCurrency"]);

    // The positive companion: the same asset-settled BUY without the pair is
    // accepted, so the rejection is the pair and not the shape.
    expect(createTransactionBodySchema.safeParse(settledBuy()).success).toBe(true);
  });

  /** Rule 2, second half (FR-236) — stated separately so each field's own path is asserted. */
  it("rule 2b — cashAmount is forbidden when settlement is present, and the issue is on `cashAmount`", () => {
    expect(issuePaths(settledBuy({ cashAmount: "1380.00" }))).toContain("cashAmount");
    // …and the negative companion for the routing claim: this body puts no
    // issue on the settlement leg's own fields, so the error does not land
    // under the settlement-amount control instead.
    expect(issuePaths(settledBuy({ cashAmount: "1380.00" }))).not.toContain("settlement.amount");
  });

  /**
   * Rule 3, the refusal half (FR-235's client-side twin).
   * `transaction_currency_exchange_cash_leg_pinned` is the guarantee; this is
   * the per-field 400 in front of it.
   */
  it("rule 3a — a CURRENCY_EXCHANGE with a contradicting cashCurrency is rejected on `cashCurrency`", () => {
    expect(issuePaths(exchange({ cashCurrency: "EUR", cashAmount: "1000" }))).toEqual([
      "cashCurrency",
    ]);
    // The amount half of the same rule, on its own path — a contradicting
    // amount with the right currency.
    expect(issuePaths(exchange({ cashCurrency: "USD", cashAmount: "999" }))).toEqual([
      "cashAmount",
    ]);
  });

  /** Rule 3, the acceptance half — the degenerate pair is *not* a rejection. */
  it("rule 3b — a CURRENCY_EXCHANGE carrying the degenerate pair is accepted", () => {
    const result = createTransactionBodySchema.safeParse(
      exchange({ cashCurrency: "USD", cashAmount: "1000" }),
    );

    expect(result.success).toBe(true);
    // Numerically equal, not textually: `1000.00` is the same movement as
    // `1000`, and a client that formats its amounts is not rejected for it.
    expect(
      createTransactionBodySchema.safeParse(
        exchange({ cashCurrency: "USD", cashAmount: "1000.00" }),
      ).success,
    ).toBe(true);
  });
});

/**
 * **AC-278, the parse half.** The body below is copied byte-for-byte out of
 * `api/src/transactions.e2e.test.ts`'s
 * *"records every kind, deriving the money leg and rejecting nothing that
 * should succeed"* — the first `post("/api/v1/transactions", …)` in that
 * test, the fiat BUY. Only the three runtime identifiers (`portfolioId`,
 * `instrumentId`, `cashAccountId`) are substituted, because they are minted
 * per run there; every literal and the key order are that test's.
 *
 * The other half of AC-278 — the same body over real HTTP, producing a
 * degenerate row whose postings match FT-9's pre-cycle snapshot — is
 * `api/src/transactions.e2e.test.ts`'s own FT-18 case, since neither the
 * service nor the snapshot is reachable from this package.
 */
describe("createTransactionBodySchema — AC-278: the pre-cycle body still parses, to the degenerate case", () => {
  const PRE_CYCLE_BUY_BODY = {
    kind: "BUY",
    portfolioId: PORTFOLIO_ID,
    instrumentId: INSTRUMENT_ID,
    tradeDate: "2024-03-01",
    quantity: "10",
    unitPrice: "60",
    currency: "EUR",
    cashAccountId: CASH_ACCOUNT_ID,
  } as const;

  it("parses unchanged and carries neither settlement field — omission is the degenerate case", () => {
    const result = createTransactionBodySchema.safeParse(PRE_CYCLE_BUY_BODY);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Not `toBeUndefined()` on one field: both keys must be absent, because
    // "the schema defaulted one of them" is exactly the way a byte-identical
    // row stops being byte-identical.
    expect(result.data).not.toHaveProperty("cashCurrency");
    expect(result.data).not.toHaveProperty("cashAmount");
    // …and the body really did reach the settlement rules: the same body
    // with a lone `cashAmount` is rejected, so the two assertions above are
    // not passing because the fields are unknown keys being stripped.
    expect(
      createTransactionBodySchema.safeParse({ ...PRE_CYCLE_BUY_BODY, cashAmount: "600" }).success,
    ).toBe(false);
  });
});

/**
 * **SHARE_DISTRIBUTION — the 8th kind's shape rules.**
 *
 * Its `superRefine` block is unusual in that most of it is `forbid(...)`: what
 * makes a cashless distribution cashless is the set of fields it refuses, and
 * each refusal has a database `CHECK` behind it
 * (`transaction_share_distribution_shape`, migration `0056`). So the rejections
 * below are the substance of the kind, not edge cases around it — and, as
 * everywhere else in this file, each asserts the **issue path by name**,
 * because `ISSUE_PATH_TO_FIELD` routes the 400 onto a control by that path.
 */
describe("createTransactionBodySchema — SHARE_DISTRIBUTION, the cashless kind", () => {
  /** Valid on every rule, so a rejection below can only be the rule under test. */
  function distribution(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: "SHARE_DISTRIBUTION",
      portfolioId: PORTFOLIO_ID,
      tradeDate: "2026-06-08",
      instrumentId: INSTRUMENT_ID,
      quantity: "3",
      amount: "503.40",
      currency: "EUR",
      ...extra,
    };
  }

  it("accepts the instrument, the count and the market value — and nothing else is required", () => {
    const result = createTransactionBodySchema.safeParse(distribution());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe("SHARE_DISTRIBUTION");
    expect(result.data.quantity?.toFixed(0)).toBe("3");
    expect(result.data.amount?.toFixed(2)).toBe("503.40");
    // No account, and — unlike every other fiat kind — that is not an omission.
    expect(result.data).not.toHaveProperty("cashAccountId");
  });

  it("requires each of the four fields the kind is made of, each on its own path", () => {
    expect(issuePaths({ ...distribution(), instrumentId: undefined })).toEqual(["instrumentId"]);
    expect(issuePaths({ ...distribution(), quantity: undefined })).toEqual(["quantity"]);
    expect(issuePaths({ ...distribution(), amount: undefined })).toEqual(["amount"]);
    expect(issuePaths({ ...distribution(), currency: undefined })).toEqual(["currency"]);
  });

  it("refuses a cash account, a settlement currency and a settled amount — no money moves", () => {
    // The rule that would otherwise be inherited: every other kind *requires*
    // `cashAccountId`, and this one forbids it. Getting that backwards is the
    // failure this asserts against.
    expect(issuePaths(distribution({ cashAccountId: CASH_ACCOUNT_ID }))).toEqual(["cashAccountId"]);
    expect(issuePaths(distribution({ cashCurrency: "EUR", cashAmount: "503.40" }))).toEqual([
      "cashAmount",
      "cashCurrency",
    ]);
  });

  it("refuses a unit price, a cost leg, a withholding leg and a currency-exchange target", () => {
    expect(issuePaths(distribution({ unitPrice: "167.80" }))).toEqual(["unitPrice"]);
    expect(issuePaths(distribution({ fee: { amount: "1.20" } }))).toEqual(["fee"]);
    expect(
      issuePaths(
        distribution({
          withholding: { amount: "1.20" },
        }),
      ),
    ).toEqual(["withholding"]);
    expect(issuePaths(distribution({ targetCurrency: "USD", exchangeRate: "1.1" }))).toEqual([
      "exchangeRate",
      "targetCurrency",
    ]);
  });

  it("keeps F1/T-38's positivity: a zero or negative market value is refused on `amount`", () => {
    expect(issuePaths(distribution({ amount: "0" }))).toEqual(["amount"]);
    expect(issuePaths(distribution({ amount: "-503.40" }))).toEqual(["amount"]);
  });
});

/**
 * **`security-transfer` TR-18.** A `TRANSFER_OUT` is the
 * `SHARE_DISTRIBUTION` shape plus one optional field, and a `TRANSFER_IN` is
 * never a request body at all. Every refusal is asserted on its own path,
 * because the web form routes the issue onto a control by that path.
 */
describe("createTransactionBodySchema — TRANSFER_OUT / TRANSFER_IN (security-transfer TR-18)", () => {
  const DESTINATION_ID = "77777777-7777-4777-8777-777777777777";

  /** Valid on every rule, so a rejection below can only be the rule under test. */
  function transferOut(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: "TRANSFER_OUT",
      portfolioId: PORTFOLIO_ID,
      tradeDate: "2025-07-09",
      instrumentId: INSTRUMENT_ID,
      quantity: "0.01",
      amount: "1240.80",
      currency: "EUR",
      ...extra,
    };
  }

  it("accepts a source-only leg and a linked one — the destination is optional (FR-575, OD-4 (a))", () => {
    const alone = createTransactionBodySchema.safeParse(transferOut());
    expect(alone.success).toBe(true);
    if (alone.success) expect(alone.data).not.toHaveProperty("destinationPortfolioId");

    const linked = createTransactionBodySchema.safeParse(
      transferOut({ destinationPortfolioId: DESTINATION_ID }),
    );
    expect(linked.success).toBe(true);
    if (linked.success) expect(linked.data.destinationPortfolioId).toBe(DESTINATION_ID);
  });

  it("requires the instrument, the quantity, the market value and its currency, each on its own path", () => {
    expect(issuePaths({ ...transferOut(), instrumentId: undefined })).toEqual(["instrumentId"]);
    expect(issuePaths({ ...transferOut(), quantity: undefined })).toEqual(["quantity"]);
    expect(issuePaths({ ...transferOut(), amount: undefined })).toEqual(["amount"]);
    expect(issuePaths({ ...transferOut(), currency: undefined })).toEqual(["currency"]);
  });

  it("refuses every field transaction_transfer_out_shape forbids, each on its own path", () => {
    const refusals: [string, Record<string, unknown>][] = [
      ["unitPrice", { unitPrice: "124080" }],
      ["settlement", { settlement: { instrumentId: SETTLEMENT_INSTRUMENT_ID, amount: "1" } }],
      ["cashAccountId", { cashAccountId: CASH_ACCOUNT_ID }],
      ["cashCurrency", { cashCurrency: "EUR" }],
      ["fee", { fee: { amount: "1.20" } }],
      ["withholding", { withholding: { amount: "1.20" } }],
      ["targetCurrency", { targetCurrency: "USD" }],
      ["exchangeRate", { exchangeRate: "1.1" }],
      ["targetCashAccountId", { targetCashAccountId: TARGET_CASH_ACCOUNT_ID }],
      ["sourceDividendId", { sourceDividendId: SETTLEMENT_INSTRUMENT_ID }],
    ];
    for (const [field, extra] of refusals) {
      expect(issuePaths(transferOut(extra)), field).toEqual([field]);
    }
    // `cashAmount` alone also trips the pairing rule on `cashCurrency`; the
    // transfer's own refusal is the one on `cashAmount`.
    expect(issuePaths(transferOut({ cashAmount: "1240.80" }))).toContain("cashAmount");
  });

  it("refuses a destination equal to the source, on `destinationPortfolioId` (FR-577 schema half, AC-459)", () => {
    expect(issuePaths(transferOut({ destinationPortfolioId: PORTFOLIO_ID }))).toEqual([
      "destinationPortfolioId",
    ]);
  });

  it("refuses a destination on every other kind", () => {
    expect(issuePaths(buy({ destinationPortfolioId: DESTINATION_ID }))).toEqual([
      "destinationPortfolioId",
    ]);
  });

  it("refuses kind TRANSFER_IN on `kind`, whatever else the body gets right or wrong", () => {
    // A body that would be a perfectly valid TRANSFER_OUT…
    expect(issuePaths(transferOut({ kind: "TRANSFER_IN" }))).toEqual(["kind"]);
    // …and one that is wrong everywhere else too: the `kind` issue is still
    // raised, since it is the field's own refinement and not an object rule
    // that waits for every other field to parse.
    expect(
      issuePaths({ kind: "TRANSFER_IN", portfolioId: "not-a-uuid", tradeDate: "yesterday" }),
    ).toContain("kind");
  });
});

/**
 * **The user's own reference, on the create side.**
 *
 * The field's definition is mostly a list of things this field is *not*
 * (generated, unique, required, per-kind), so most of what is asserted here is
 * that the schema stays out of the way: a body with no reference is exactly as
 * valid as it was before the column existed, and one with a reference is valid
 * for every kind on the same terms.
 *
 * The two rules it does carry — trimmed, and blank means absent — are asserted
 * against the **database's** notion of blank, not JavaScript's. That difference
 * is the portfolio-name blank-floor finding applied to a new column before
 * it can bite:
 * `String.prototype.trim` leaves U+00A0/U+200B/U+FEFF standing,
 * `transaction_reference_shape` refuses them, and a boundary that disagreed
 * would turn a stray keystroke into a 500 — or, worse, into a reference row
 * that renders blank in the drawer.
 */
/**
 * **`cash-interest` CI-T1 — AC-519's DTO half.** An `INTEREST`
 * is DEPOSIT's shape plus DIVIDEND's optional withholding, which must stay
 * below the gross. Every refusal is asserted on its own path, for the
 * `ISSUE_PATH_TO_FIELD` reason this file's header gives.
 */
describe("createTransactionBodySchema — INTEREST, interest earned on cash (cash-interest)", () => {
  const DIVIDEND_ID = "99999999-9999-4999-8999-999999999999";
  const DESTINATION_ID = "77777777-7777-4777-8777-777777777777";

  /** Valid on every rule, so a rejection below can only be the rule under test. */
  function interest(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: "INTEREST",
      portfolioId: PORTFOLIO_ID,
      tradeDate: "2026-07-01",
      amount: "10.00",
      currency: "EUR",
      cashAccountId: CASH_ACCOUNT_ID,
      ...extra,
    };
  }

  it("accepts the minimal body: a gross, its currency and the account it was paid into", () => {
    const result = createTransactionBodySchema.safeParse(interest());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe("INTEREST");
    expect(result.data.amount?.toFixed(2)).toBe("10.00");
    expect(result.data).not.toHaveProperty("withholding");
  });

  it("accepts a withholding that is one amount, on an INTEREST and on a DIVIDEND", () => {
    expect(
      createTransactionBodySchema.safeParse(
        interest({ amount: "100.00", withholding: { amount: "0.51" } }),
      ).success,
    ).toBe(true);
    const dividend = createTransactionBodySchema.safeParse({
      kind: "DIVIDEND",
      portfolioId: PORTFOLIO_ID,
      instrumentId: DIVIDEND_ID,
      tradeDate: "2026-07-01",
      amount: "3.65",
      currency: "USD",
      cashAccountId: CASH_ACCOUNT_ID,
      fxRateUserInput: "0.9237",
      withholding: { amount: "0.51" },
    });
    expect(dividend.success).toBe(true);
    if (dividend.success) expect(dividend.data.withholding?.amount.toFixed(2)).toBe("0.51");
  });

  it("requires the gross, its currency and the cash account, each on its own path", () => {
    expect(issuePaths({ ...interest(), amount: undefined })).toEqual(["amount"]);
    expect(issuePaths({ ...interest(), currency: undefined })).toEqual(["currency"]);
    expect(issuePaths({ ...interest(), cashAccountId: undefined })).toEqual(["cashAccountId"]);
  });

  it("refuses a zero or negative gross on `amount` (CI-L2: strictly positive)", () => {
    expect(issuePaths(interest({ amount: "0" }))).toEqual(["amount"]);
    expect(issuePaths(interest({ amount: "-10.00" }))).toEqual(["amount"]);
  });

  it("refuses every instrument, trade, exchange and cost field, each on its own path", () => {
    expect(issuePaths(interest({ instrumentId: INSTRUMENT_ID }))).toEqual(["instrumentId"]);
    expect(issuePaths(interest({ quantity: "3" }))).toEqual(["quantity"]);
    expect(issuePaths(interest({ unitPrice: "1.00" }))).toEqual(["unitPrice"]);
    expect(
      issuePaths(interest({ fee: { amount: "1.20", cashAccountId: CASH_ACCOUNT_ID } })),
    ).toEqual(["fee"]);
    expect(
      issuePaths(interest({ settlement: { instrumentId: SETTLEMENT_INSTRUMENT_ID, amount: "1" } })),
    ).toEqual(["settlement"]);
    expect(issuePaths(interest({ sourceDividendId: DIVIDEND_ID }))).toEqual(["sourceDividendId"]);
    expect(issuePaths(interest({ targetCashAccountId: TARGET_CASH_ACCOUNT_ID }))).toEqual([
      "targetCashAccountId",
    ]);
    expect(issuePaths(interest({ targetCurrency: "USD" }))).toEqual(["targetCurrency"]);
    expect(issuePaths(interest({ exchangeRate: "1.1" }))).toEqual(["exchangeRate"]);
    expect(issuePaths(interest({ destinationPortfolioId: DESTINATION_ID }))).toEqual([
      "destinationPortfolioId",
    ]);
  });

  it("refuses the old withholding keys (currency, cashAccountId, fxRateUserInput) with a per-field unrecognized_keys issue", () => {
    for (const key of [
      { currency: "EUR" },
      { cashAccountId: CASH_ACCOUNT_ID },
      { fxRateUserInput: "1.1" },
    ]) {
      const result = createTransactionBodySchema.safeParse(
        interest({ withholding: { amount: "0.51", ...key } }),
      );
      expect(result.success, JSON.stringify(key)).toBe(false);
      if (result.success) continue;
      expect(result.error.issues.map((issue) => issue.code)).toEqual(["unrecognized_keys"]);
      expect(result.error.issues[0]!.path.join(".")).toBe("withholding");
    }
  });

  it("still refuses a withholding on a DEPOSIT — INTEREST's allowance does not leak to it", () => {
    expect(
      issuePaths({
        kind: "DEPOSIT",
        portfolioId: PORTFOLIO_ID,
        tradeDate: "2026-07-01",
        amount: "10.00",
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT_ID,
        withholding: { amount: "3.00" },
      }),
    ).toEqual(["withholding"]);
  });
});

/**
 * **`portfolio-cash` PC-T1 — AC-567's DTO half.** A `FEE` is
 * WITHDRAWAL's shape with an optional `instrumentId` *reference*. The
 * instrument case is the silent site: the shared else-branch forbids
 * `instrumentId` for every kind it does not name, so a missing FEE exclusion
 * makes every valid FEE-with-instrument a 400.
 */
describe("createTransactionBodySchema — FEE, a standalone portfolio fee (portfolio-cash)", () => {
  const DIVIDEND_ID = "99999999-9999-4999-8999-999999999999";
  const DESTINATION_ID = "77777777-7777-4777-8777-777777777777";

  /** Valid on every rule, so a rejection below can only be the rule under test. */
  function portfolioFee(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: "FEE",
      portfolioId: PORTFOLIO_ID,
      tradeDate: "2026-07-01",
      amount: "10.00",
      currency: "EUR",
      cashAccountId: CASH_ACCOUNT_ID,
      note: "Frais de garde T3",
      ...extra,
    };
  }

  it("accepts the minimal body: an amount, its currency and the account it was debited from", () => {
    const result = createTransactionBodySchema.safeParse(portfolioFee());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe("FEE");
    expect(result.data.amount?.toString()).toBe("10");
    expect(result.data).not.toHaveProperty("instrumentId");
  });

  it("accepts an instrument reference (PC-L14) — the instrument-forbid exclusion", () => {
    const result = createTransactionBodySchema.safeParse(
      portfolioFee({ instrumentId: INSTRUMENT_ID }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.instrumentId).toBe(INSTRUMENT_ID);
  });

  it("requires the amount, its currency and the cash account, each on its own path", () => {
    expect(issuePaths({ ...portfolioFee(), amount: undefined })).toEqual(["amount"]);
    expect(issuePaths({ ...portfolioFee(), currency: undefined })).toEqual(["currency"]);
    expect(issuePaths({ ...portfolioFee(), cashAccountId: undefined })).toEqual(["cashAccountId"]);
  });

  it("refuses a zero or negative amount on `amount`", () => {
    expect(issuePaths(portfolioFee({ amount: "0" }))).toEqual(["amount"]);
    expect(issuePaths(portfolioFee({ amount: "-10.00" }))).toEqual(["amount"]);
  });

  it("refuses every trade, exchange, cost and withholding field, each on its own path", () => {
    expect(issuePaths(portfolioFee({ quantity: "3" }))).toEqual(["quantity"]);
    expect(issuePaths(portfolioFee({ unitPrice: "1.00" }))).toEqual(["unitPrice"]);
    expect(
      issuePaths(portfolioFee({ fee: { amount: "1.20", cashAccountId: CASH_ACCOUNT_ID } })),
    ).toEqual(["fee"]);
    expect(
      issuePaths(
        portfolioFee({
          withholding: { amount: "3.00" },
        }),
      ),
    ).toEqual(["withholding"]);
    expect(
      issuePaths(
        portfolioFee({ settlement: { instrumentId: SETTLEMENT_INSTRUMENT_ID, amount: "1" } }),
      ),
    ).toEqual(["settlement"]);
    expect(issuePaths(portfolioFee({ sourceDividendId: DIVIDEND_ID }))).toEqual([
      "sourceDividendId",
    ]);
    expect(issuePaths(portfolioFee({ targetCashAccountId: TARGET_CASH_ACCOUNT_ID }))).toEqual([
      "targetCashAccountId",
    ]);
    expect(issuePaths(portfolioFee({ targetCurrency: "USD" }))).toEqual(["targetCurrency"]);
    expect(issuePaths(portfolioFee({ exchangeRate: "1.1" }))).toEqual(["exchangeRate"]);
    expect(issuePaths(portfolioFee({ destinationPortfolioId: DESTINATION_ID }))).toEqual([
      "destinationPortfolioId",
    ]);
  });

  it("still refuses an instrument and a fee on a DEPOSIT and a WITHDRAWAL — FEE's allowance does not leak", () => {
    for (const kind of ["DEPOSIT", "WITHDRAWAL"]) {
      expect(issuePaths(portfolioFee({ kind, instrumentId: INSTRUMENT_ID }))).toEqual([
        "instrumentId",
      ]);
      expect(
        issuePaths(portfolioFee({ kind, fee: { amount: "1.20", cashAccountId: CASH_ACCOUNT_ID } })),
      ).toEqual(["fee"]);
    }
  });
});

describe("createTransactionBodySchema — the user reference", () => {
  /** The blank `.trim()` alone keeps and the database's floor does not. */
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

  function parsed(payload: Record<string, unknown>): Record<string, unknown> {
    const result = createTransactionBodySchema.safeParse(payload);
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true);
    return result.data as unknown as Record<string, unknown>;
  }

  it("is optional: the same body with and without a reference are both accepted", () => {
    expect(parsed(buy())["reference"]).toBeUndefined();
    expect(parsed(buy({ reference: "ORD-2026-000123/A" }))["reference"]).toBe("ORD-2026-000123/A");
  });

  it("belongs to every kind, and to none of the per-kind rules", () => {
    // The claim that matters for a field declared outside the `superRefine`:
    // no kind forbids it and no kind requires it. A DEPOSIT (no instrument
    // leg) and a SHARE_DISTRIBUTION (no cash leg at all) are the two extremes.
    expect(
      parsed({
        kind: "DEPOSIT",
        portfolioId: PORTFOLIO_ID,
        tradeDate: "2026-01-15",
        amount: "100",
        currency: "EUR",
        cashAccountId: CASH_ACCOUNT_ID,
        reference: "VIR-2026-01-15",
      })["reference"],
    ).toBe("VIR-2026-01-15");
    expect(
      parsed({
        kind: "SHARE_DISTRIBUTION",
        portfolioId: PORTFOLIO_ID,
        tradeDate: "2026-06-08",
        instrumentId: INSTRUMENT_ID,
        quantity: "3",
        amount: "503.40",
        currency: "EUR",
        reference: "AVIS-2026-06-08",
      })["reference"],
    ).toBe("AVIS-2026-06-08");
  });

  it("trims, and turns a blank into absent — including the blanks JavaScript's own trim keeps", () => {
    expect(parsed(buy({ reference: "  ORD-42  " }))["reference"]).toBe("ORD-42");
    expect(parsed(buy({ reference: "" }))["reference"]).toBeUndefined();
    expect(parsed(buy({ reference: "   " }))["reference"]).toBeUndefined();
    // The one a `.trim().min(1)` would have let through, straight into
    // `transaction_reference_shape` as a bare 23514.
    expect(parsed(buy({ reference: ZERO_WIDTH_SPACE }))["reference"]).toBeUndefined();
  });

  it("bounds the length, on its own path, and measures the TRIMMED value", () => {
    expect(
      issuePaths(buy({ reference: "x".repeat(TRANSACTION_REFERENCE_MAX_LENGTH + 1) })),
    ).toEqual(["reference"]);
    // Padding buys no room, and costs none either: the bound is on what is
    // stored, which is what the CHECK measures too.
    const padded = `  ${"y".repeat(TRANSACTION_REFERENCE_MAX_LENGTH)}  `;
    expect(parsed(buy({ reference: padded }))["reference"]).toHaveLength(
      TRANSACTION_REFERENCE_MAX_LENGTH,
    );
  });
});

/**
 * The **edit** side of the same field — `api`'s
 * `editTransactionBodySchema` builds its `reference` out of this — and the one
 * behaviour that differs from the create side is the one that matters on a
 * PATCH: a blank becomes `null` (clear it), not `undefined` (leave it alone).
 */
describe("transactionReferenceEditSchema — clearing versus leaving alone", () => {
  it("maps every database-blank string to null, and keeps a real one trimmed", () => {
    expect(transactionReferenceEditSchema.parse("")).toBeNull();
    expect(transactionReferenceEditSchema.parse("   ")).toBeNull();
    expect(transactionReferenceEditSchema.parse(String.fromCodePoint(0x00a0))).toBeNull();
    expect(transactionReferenceEditSchema.parse("  ORD-42  ")).toBe("ORD-42");
  });

  it("shares one bound with its create twin — not a second copy of the number", () => {
    expect(
      transactionReferenceEditSchema.safeParse("z".repeat(TRANSACTION_REFERENCE_MAX_LENGTH))
        .success,
    ).toBe(true);
    expect(
      transactionReferenceEditSchema.safeParse("z".repeat(TRANSACTION_REFERENCE_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });
});
