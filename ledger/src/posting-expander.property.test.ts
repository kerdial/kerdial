import { Decimal } from "@kerdial/core-decimal";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  expandPostings,
  principalImpliedRate,
  type ExpandableTransaction,
} from "./posting-expander.js";

/**
 * T-21's second acceptance criterion — the stated invariant: "postings sum-to-zero per transaction in base currency
 * **only up to the fee/tax legs**, which are genuine value leakage."
 *
 * ## What is asserted, and one documented departure from the one-line wording
 *
 * The invariant is commonly stated as the single line
 * `Σ amount_base (postings) = -(fee_base + tax_base)`. That form is exactly
 * true for BUY, SELL, DRIP and CURRENCY_EXCHANGE, and it is asserted verbatim
 * for them below. It **cannot** hold for DEPOSIT, WITHDRAWAL or DIVIDEND,
 * because those transactions move value across the portfolio boundary and
 * their counterparty is outside the ledger: the same T-21 acceptance criterion
 * two bullets down requires a DEPOSIT to produce *exactly one* CASH posting,
 * so a deposit of 2 500 EUR necessarily sums to +2 500, not to 0. (A
 * balancing contra-leg is not representable either — `posting_leg` is
 * `POSITION | CASH`, and a second CASH leg would corrupt the cash balance
 * T-30 materialises from these very rows.) The two criteria cannot both hold
 * literally; this is reported in the T-21 hand-off rather than reconciled
 * silently.
 *
 * The general form asserted here for **every** kind is the one that is both
 * true and non-vacuous:
 *
 *     Σ amount_base = Σ EXTERNAL + Σ INCOME − fee_base − tax_base
 *
 * which is equivalent to `Σ over INTERNAL legs = 0` — the real content of
 * that invariant. That is a strong statement: it catches a flipped sign on
 * any trade leg, an FX rate applied to one side of a trade but not the other,
 * a settlement disposal priced at the wrong rate, and a currency exchange
 * whose two legs do not carry the same base value. It is asserted at **full
 * `Decimal` precision** (`isZero()`, not a tolerance), over quantities with up
 * to 18 decimal places — NFR-12/AC53's bar.
 *
 * ## The generator is checked for coverage
 *
 * A property test that only ever generated DEPOSITs would pass while proving
 * nothing, so every generated shape records a label and the suite asserts
 * afterwards that all of them — every kind, the asset-settled BUY, the
 * withholding case, fee-bearing transactions and (from phase 1 of
 * `fee-tax-breakdown`) the cross-currency-settled shapes D3/D4/D5 — were
 * actually produced.
 *
 * ## Phase 1's division, and what it does *not* cost
 *
 * `fee-tax-breakdown` phase 1 lets a cash account settle a trade in its own
 * currency, and the expander's cross-currency branch divides —
 * `fx_rate_applied = amount_base / amount_native`. **Read before trusting the
 * arithmetic below** (both earlier stages had
 * no shell to do it with): a known low-severity latent defect is *"the sum-to-zero
 * invariant is exact only up to input magnitude — `zDecimal` bounds neither
 * operand of `amountBase = native × rate`"*. Its substance: `zDecimal` is a
 * shape check with no magnitude bound, so the reachable input space is bounded
 * only by the columns, and a product needing more than `precision: 34`
 * significant digits is silently inexact in memory — but every realistic error
 * it measures is `<= 2e-18` against a stored scale of 12, so the write discards
 * it and no stored value moves.
 *
 * **Phase 1 does not change that status, and the reason is specific rather than
 * "the change is small":**
 *
 * - The digit budget is a budget over *products entering a sum*. The division adds
 *   an operation but **no product and no summand**: its single consumer is
 *   `fx_rate_applied`, and not one assertion in this file reads that field
 *   except through the per-posting rate identity below — from which the
 *   cross-currency principal leg is exempted, for the reason F1 states. So
 *   `(3+3)+(18+9) = 33` against `precision: 34` stands unchanged.
 * - `amount_base` is `gross_amount × fx_rate` in **both** branches, the same
 *   expression of the same two stored numbers, so the values every sum below
 *   adds up are literally the same values as before phase 1.
 * - What phase 1 *does* widen the unbounded-`zDecimal` defect's surface by one leg: a quotient can
 *   overflow `fx_rate_applied`'s `numeric(28,12)` for extreme operands exactly
 *   as `CURRENCY_EXCHANGE`'s target leg already can (`posting-expander.ts:334`,
 *   shipped). That is the unbounded-`zDecimal` defect reaching one more
 *   column, not a new class of defect, and it is recorded here rather than
 *   filed as a phase-1 regression.
 */

const INSTRUMENT_A = "00000000-0000-7000-8000-0000002100a1";
const INSTRUMENT_B = "00000000-0000-7000-8000-0000002100b2";

/**
 * Digit strings, so every generated `Decimal` comes from an exact decimal
 * literal — never from a float.
 *
 * The length is drawn **first**, then that many digits. The obvious
 * spelling — `fc.array(digit, { minLength: 1, maxLength })` — biases array
 * length hard toward the short end: measured over 2000 samples at
 * `maxLength: 18`, it produced lengths 1..12 and **never once reached 18**.
 * So this file's headline claim — the invariant asserted "over quantities
 * with up to 18 decimal places — NFR-12/AC53's bar" — was aspirational
 * rather than exercised, for as long as it has been written down. Drawing the
 * length explicitly reaches 18 on ~7% of samples. `generatorWidth` below
 * pins that, so the claim cannot quietly stop being true again.
 */
const digits = (maxLength: number): fc.Arbitrary<string> =>
  fc
    .integer({ min: 1, max: maxLength })
    .chain((length) =>
      fc.array(fc.integer({ min: 0, max: 9 }), { minLength: length, maxLength: length }),
    )
    .map((chosen) => chosen.join(""));

/**
 * The generator digit budget.
 *
 * Every assertion below is an **exact** `isZero()` over sums of
 * `amount × rate` products, and `Decimal` carries `precision: 34`
 * (`core/decimal`). So the generators must not produce a pair whose product
 * needs more significant digits than that, or the test reports a precision
 * artefact as an invariant violation.
 *
 * The bound is **marginal, not per-pair**: a sum mixes products from
 * different legs, so the widest possible term (largest integer part) and the
 * narrowest (smallest fractional part) can co-occur in one sum. The span to
 * budget is therefore
 *
 *     (AMOUNT_INT + RATE_INT) + (AMOUNT_FRAC + RATE_FRAC)
 *       = (3 + 3) + (18 + 9) = 33
 *
 * — 33, leaving one digit of headroom for a carry out of the addition.
 *
 * The previous ranges were 6+18 and 5+12, a worst-case span of **41** digits
 * against a 34-digit budget, which made every unseeded 1000-run pass a coin
 * flip: `seed: 1374383954` failed at run 952 on `DIVIDEND` with
 * `grossAmount 110000`, `fxRate 91000`, `withholdingAmount 1e-12`,
 * a withholding rate of `1e-12` (then a stored column) — where `10010000000 + (-1e-24)` rounds to
 * `10010000000` and the leakage check returns `1e-24` rather than zero. That
 * is not a counterexample to the sum-to-zero invariant; it is a pair the arithmetic
 * cannot represent.
 *
 * What was given up, and what was not:
 *
 * - **Amount keeps its full 18 dp** — NFR-12/AC53's bar, and the crypto
 *   precision `NUMERIC(38,18)` exists for, is the claim this file's header
 *   makes and it is preserved exactly.
 * - **Rate narrows from 12 dp to 9 dp.** `NUMERIC(28,12)` is the column
 *   scale, but the FX-rate requirement is only `>= 8 dp` of an FX rate
 *   (display is 6), so 9 dp still exercises more scale than the system
 *   promises. Narrowing the rate rather than the amount spends the budget on
 *   the bound that is actually acceptance-criteria'd.
 * - The integer widths fall from 6/5 to 3/3. `generatorWidth` below asserts
 *   the ranges are still genuinely exercised, so this cannot silently decay
 *   into "narrow it until nothing interesting is generated".
 */
/**
 * The runs are **seeded**. An unseeded 1000-run search that can fail
 * on some paths does not fail reproducibly — it burns a CI run and trains the
 * reader to re-run rather than investigate, which is the opposite of this
 * repo's "verify locally, never push to iterate" rule.
 *
 * This is the seed that exposed the old ranges, failing at run 952 of 1000.
 * It is kept for provenance, but note what it does **not** prove: fixing
 * `digits` above changed the generation path, so this seed no longer replays
 * that exact counterexample. The load-bearing guard is
 * `the generator digit budget fits Decimal's 34-digit precision`, which pins
 * the corners arithmetically instead of hoping a search stumbles on them.
 *
 * Measured while fixing the digit budget, over the 5 seeds 1/2/3/7/42: the earlier
 * ranges fail 4 of 5 (the widened `digits` reaches the overflowing values far
 * more often than the original did), and the ranges below pass 7 of 7
 * including this seed and 999983.
 */
const PROPERTY_SEED = 1374383954;

/**
 * A minor unit finer than any figure these generators produce (they reach
 * 31 decimals, far past the columns' 12), which makes the per-movement
 * rounding the identity: the properties in this file are about the **structure** of
 * the expansion. The rounding layer has its own properties in
 * `posting-expander.cash-rounding.test.ts`.
 */
const noRounding = (): number => 1000;

const AMOUNT_INT_DIGITS = 3;
const AMOUNT_FRAC_DIGITS = 18;
const RATE_INT_DIGITS = 3;
const RATE_FRAC_DIGITS = 9;

/** A positive amount with up to 18 dp — the crypto precision `NUMERIC(38,18)` exists for. */
const positiveAmount: fc.Arbitrary<Decimal> = fc
  .tuple(digits(AMOUNT_INT_DIGITS), digits(AMOUNT_FRAC_DIGITS))
  .map(([whole, fraction]) => new Decimal(`${whole}.${fraction}`))
  .filter((value) => value.greaterThan(0));

/** A positive FX rate with up to 9 dp — inside `NUMERIC(28,12)`'s scale, above the `>= 8 dp` floor. */
const positiveRate: fc.Arbitrary<Decimal> = fc
  .tuple(digits(RATE_INT_DIGITS), digits(RATE_FRAC_DIGITS))
  .map(([whole, fraction]) => new Decimal(`${whole}.${fraction}`))
  .filter((value) => value.greaterThan(0));

const currency = fc.constantFrom("EUR", "USD", "GBP", "JPY", "CHF");
const rateSource = fc.constantFrom("USER_PINNED" as const, "PROVIDER" as const);

interface GeneratedTransaction {
  readonly row: ExpandableTransaction;
  /** Describes the generated shape, so the suite can prove the generator covers all of them. */
  readonly label: string;
}

const feeLeg = fc.option(
  fc.record({ amount: positiveAmount, currency, rate: positiveRate, source: rateSource }),
  { nil: null },
);

// A withholding is one amount — denominated by the settling account and
// carried at the principal's implied rate, so it has no currency/rate/source.
const withholdingLeg = fc.option(fc.record({ amount: positiveAmount }), { nil: null });

type OptionalLeg = { amount: Decimal; currency: string; rate: Decimal; source: string } | null;
type OptionalWithholding = { amount: Decimal } | null;

/**
 * CA-6/AC-189: the four per-leg cash accounts every generated row carries.
 *
 * They are fixed ids rather than generated values on purpose. The property
 * this file states is about *amounts* summing to zero, and `cash_account_id`
 * participates in no arithmetic anywhere — so attribution is added as fixture
 * data (every generated row is now realistically attributed, the shape the
 * database requires from `0039` on) without a single assertion changing. If
 * adding them had made any sum-to-zero assertion move, that would itself have
 * been the finding.
 */
const PRINCIPAL_ACCOUNT = "00000000-0000-7000-8000-0000000ac001";
const TARGET_ACCOUNT = "00000000-0000-7000-8000-0000000ac002";

function withLegs(
  base: Omit<
    ExpandableTransaction,
    | "feeAmount"
    | "feeCurrency"
    | "feeFxRate"
    | "feeFxRateSource"
    | "feeCashAccountId"
    | "withholdingAmount"
    // 0047's four cost components, supplied below rather than by each
    // generator — they are absent on every fixture this factory builds today,
    // and FT-32's itemised generators set them explicitly.
    | "brokerFeeAmount"
    | "fxFeeAmount"
    | "taxAmount"
    | "otherCostAmount"
  >,
  fee: OptionalLeg,
  withholding: OptionalWithholding,
): ExpandableTransaction {
  return {
    ...base,
    feeAmount: fee?.amount ?? null,
    // Nested with the leg it belongs to, exactly like the leg's own rate: an
    // account cannot be present for a leg that is not.
    // 0047's components stay absent here; FT-32 adds the itemised generators.
    brokerFeeAmount: null,
    fxFeeAmount: null,
    taxAmount: null,
    otherCostAmount: null,
    withholdingAmount: withholding?.amount ?? null,
  };
}

/** Common columns every generated row shares; the per-kind arbitraries below override what they need. */
const skeleton = {
  instrumentId: null,
  quantity: null,
  txnCurrency: null,
  txnSettlementInstrumentId: null,
  targetCurrency: null,
  targetAmount: null,
  cashAccountId: PRINCIPAL_ACCOUNT,
  targetCashAccountId: null,
  // Phase 1's principal-cash denomination. NULL here is the asset-settled
  // shape; every fiat generator below sets both, degenerately by default and
  // independently in the D3/D4/D5 generators.
  cashCurrency: null,
  cashAmount: null,
} satisfies Partial<ExpandableTransaction>;

/**
 * The degenerate settlement mirror (cases D1/D2) — `cash_currency =
 * txn_currency` and `cash_amount = gross_amount`, which is what
 * `transaction_cash_degenerate_equals_gross` forces and what every writer
 * produces today. A generator that set only one of the two would build a row
 * `transaction_cash_amount_currency_pairing` refuses.
 */
const degenerateCash = (
  txnCurrency: string,
  grossAmount: Decimal,
): Pick<ExpandableTransaction, "cashCurrency" | "cashAmount"> => ({
  cashCurrency: txnCurrency,
  cashAmount: grossAmount,
});

/**
 * The D3/D4/D5 shapes: a settlement currency that is **not** the trade's, with
 * a `cash_amount` deliberately unrelated to `gross_amount`. Nothing ties the
 * two once the currencies differ — `cash_amount` is what the broker actually
 * debited, and that is precisely the row
 * `transaction_cash_degenerate_equals_gross`'s `IS DISTINCT FROM` disjunct
 * stops applying to. Generated as a record and filtered as a whole (the idiom
 * `currencyExchange` below already uses for its own two-currency constraint).
 */
/**
 * **FT-32 (phase 2).** A cost split: two to four components, and the
 * `fee_amount` total they must sum to — the shape
 * `transaction_cost_components_sum_to_fee_amount` enforces, so a generated row
 * is one the database would accept.
 *
 * The total is computed from the parts rather than generated beside them, for
 * the reason the constraint exists: a generator that drew both independently
 * would spend most of its runs on rows the database refuses, and the property
 * would silently be testing almost nothing.
 */
const itemisedCosts = fc
  .record({
    brokerFeeAmount: fc.option(positiveAmount, { nil: null }),
    fxFeeAmount: fc.option(positiveAmount, { nil: null }),
    taxAmount: fc.option(positiveAmount, { nil: null }),
    otherCostAmount: fc.option(positiveAmount, { nil: null }),
  })
  .filter((components) => Object.values(components).some((amount) => amount !== null))
  .map((components) => ({
    components,
    total: Object.values(components).reduce(
      (sum: Decimal, amount) => (amount === null ? sum : sum.plus(amount)),
      new Decimal(0),
    ),
  }));

const crossCurrencySettlement = fc
  .record({ txnCurrency: currency, cashCurrency: currency, cashAmount: positiveAmount })
  .filter((generated) => generated.cashCurrency !== generated.txnCurrency);

/** A fiat BUY / SELL / DRIP: instrument leg, cash leg, optional fee. */
const fiatTrade = (kind: "BUY" | "SELL" | "DRIP"): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      quantity: positiveAmount,
      unitPrice: positiveAmount,
      txnCurrency: currency,
      fxRate: positiveRate,
      fxRateSource: rateSource,
      fee: feeLeg,
    })
    .map((generated) => ({
      label: `${kind}${generated.fee ? "+fee" : ""}`,
      row: withLegs(
        {
          ...skeleton,
          kind,
          instrumentId: INSTRUMENT_A,
          quantity: generated.quantity,
          // As the write service derives it: the money leg cannot
          // disagree with the instrument leg.
          grossAmount: generated.quantity.times(generated.unitPrice),
          txnCurrency: generated.txnCurrency,
          ...degenerateCash(generated.txnCurrency, generated.quantity.times(generated.unitPrice)),
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        generated.fee,
        null,
      ),
    }));

/**
 * The same trade settled from an account in a **third** currency — cases
 * D3/D4/D5 (`fee-tax-breakdown` phase 1, FR-239/FR-245). Only the principal
 * cash leg's `currency`/`amount_native`/`fx_rate_applied` move; `amount_base`
 * is `gross × fx_rate` exactly as above, which is why every sum below is
 * unaffected and only the per-posting rate identity needs F1's exemption.
 */
const crossSettledFiatTrade = (kind: "BUY" | "SELL" | "DRIP"): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      quantity: positiveAmount,
      unitPrice: positiveAmount,
      settlement: crossCurrencySettlement,
      fxRate: positiveRate,
      fxRateSource: rateSource,
      fee: feeLeg,
    })
    .map((generated) => ({
      label: `${kind}/cross-currency-settled${generated.fee ? "+fee" : ""}`,
      row: withLegs(
        {
          ...skeleton,
          kind,
          instrumentId: INSTRUMENT_A,
          quantity: generated.quantity,
          grossAmount: generated.quantity.times(generated.unitPrice),
          txnCurrency: generated.settlement.txnCurrency,
          cashCurrency: generated.settlement.cashCurrency,
          cashAmount: generated.settlement.cashAmount,
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        generated.fee,
        null,
      ),
    }));

/**
 * FR-66/AC52's asset-settled BUY: "2 ETH paying 0.1 BTC", one row, two POSITION
 * legs.
 *
 * **It generates no cost** (forced by dropping the fee columns). Such a row
 * moves no cash (FR-236), so after L5 it names no account for a cost to be
 * denominated by — the write path refuses one and `expandPostings` cannot emit
 * one. Generating the shape would be generating a row the database cannot hold,
 * and the property would fail on data that does not exist rather than on a
 * defect.
 */
const assetSettledBuy: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    quantity: positiveAmount,
    settlementAmount: positiveAmount,
    fxRate: positiveRate,
    fxRateSource: rateSource,
  })
  .map((generated) => ({
    label: "BUY/asset-settled",
    row: withLegs(
      {
        ...skeleton,
        kind: "BUY",
        instrumentId: INSTRUMENT_A,
        quantity: generated.quantity,
        grossAmount: generated.settlementAmount,
        txnSettlementInstrumentId: INSTRUMENT_B,
        // FR-157: an asset-settled principal moved no cash, so it names no
        // account — the fee leg on the same row still may, and `withLegs`
        cashAccountId: null,
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      // No cost: this row moves no cash, so after L5 it names no account for
      // one to be denominated by.
      null,
      null,
    ),
  }));

const cashMovement = (kind: "DEPOSIT" | "WITHDRAWAL"): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      amount: positiveAmount,
      txnCurrency: currency,
      fxRate: positiveRate,
      fxRateSource: rateSource,
    })
    .map((generated) => ({
      label: kind,
      row: withLegs(
        {
          ...skeleton,
          kind,
          grossAmount: generated.amount,
          txnCurrency: generated.txnCurrency,
          ...degenerateCash(generated.txnCurrency, generated.amount),
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        null,
        null,
      ),
    }));

/** A DEPOSIT/WITHDRAWAL landing in an account denominated in another currency — case D3/D5. */
const crossSettledCashMovement = (
  kind: "DEPOSIT" | "WITHDRAWAL",
): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      amount: positiveAmount,
      settlement: crossCurrencySettlement,
      fxRate: positiveRate,
      fxRateSource: rateSource,
    })
    .map((generated) => ({
      label: `${kind}/cross-currency-settled`,
      row: withLegs(
        {
          ...skeleton,
          kind,
          grossAmount: generated.amount,
          txnCurrency: generated.settlement.txnCurrency,
          cashCurrency: generated.settlement.cashCurrency,
          cashAmount: generated.settlement.cashAmount,
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        null,
        null,
      ),
    }));

const dividend: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    amount: positiveAmount,
    txnCurrency: currency,
    fxRate: positiveRate,
    fxRateSource: rateSource,
    withholding: withholdingLeg,
  })
  .map((generated) => ({
    label: `DIVIDEND${generated.withholding ? "+wht" : ""}`,
    row: withLegs(
      {
        ...skeleton,
        kind: "DIVIDEND",
        instrumentId: INSTRUMENT_A,
        grossAmount: generated.amount,
        txnCurrency: generated.txnCurrency,
        ...degenerateCash(generated.txnCurrency, generated.amount),
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      null,
      generated.withholding,
    ),
  }));

/**
 * **The 8th kind: a cashless share distribution.**
 *
 * Every absence in this generator is a database `CHECK`
 * (`transaction_share_distribution_shape`) rather than a simplification: no
 * `cash_account_id`, no `cash_currency`/`cash_amount`, no cost leg and no
 * withholding leg — which is why `withLegs` is called with `null, null` and
 * why `cashAccountId` is overridden away from the skeleton's default. A row
 * carrying any of them is not a row the database can hold, so generating one
 * would test data that cannot exist.
 *
 * `grossAmount` is the distribution's **market value** and it is deliberately
 * a free, positive figure unrelated to the quantity: the point of the property
 * below is that the postings sum to zero *whatever* that value is, because it
 * reaches no leg.
 */
const shareDistribution: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    quantity: positiveAmount,
    marketValue: positiveAmount,
    txnCurrency: currency,
    fxRate: positiveRate,
    fxRateSource: rateSource,
  })
  .map((generated) => ({
    label: "SHARE_DISTRIBUTION",
    row: withLegs(
      {
        ...skeleton,
        kind: "SHARE_DISTRIBUTION",
        instrumentId: INSTRUMENT_A,
        quantity: generated.quantity,
        grossAmount: generated.marketValue,
        txnCurrency: generated.txnCurrency,
        // No settling account and no settled amount: this kind moves no cash,
        // and `0056` exempts it from the two totality CHECKs for exactly that
        // reason.
        cashAccountId: null,
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      null,
      null,
    ),
  }));

/**
 * A security transfer's leg — `TRANSFER_OUT` (source) or `TRANSFER_IN`
 * (target), `security-transfer`. The same cashless
 * row shape as {@link shareDistribution} (`0070`'s two shape CHECKs force the
 * cash columns, the fee and the withholding NULL), but here `grossAmount` —
 * the market value — **does** reach the leg: one POSITION leg of `∓q` worth
 * `∓gross_amount`, classified EXTERNAL.
 */
const securityTransfer = (
  kind: "TRANSFER_OUT" | "TRANSFER_IN",
): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      quantity: positiveAmount,
      marketValue: positiveAmount,
      txnCurrency: currency,
      fxRate: positiveRate,
      fxRateSource: rateSource,
    })
    .map((generated) => ({
      label: kind,
      row: withLegs(
        {
          ...skeleton,
          kind,
          instrumentId: INSTRUMENT_A,
          quantity: generated.quantity,
          grossAmount: generated.marketValue,
          txnCurrency: generated.txnCurrency,
          cashAccountId: null,
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        null,
        null,
      ),
    }));

/**
 * A dividend paid in one currency into an account denominated in another —
 * case D3/D5 on the INCOME leg. The withholding leg is **unchanged** in phase 1
 * (L12): it keeps its own currency and its own stored rate, so it is still
 * covered by the unexempted half of the rate identity below, which is what
 * makes the exemption's "principal cash posting specifically" wording testable.
 */
const crossSettledDividend: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    amount: positiveAmount,
    settlement: crossCurrencySettlement,
    fxRate: positiveRate,
    fxRateSource: rateSource,
    withholding: withholdingLeg,
  })
  .map((generated) => ({
    label: `DIVIDEND/cross-currency-settled${generated.withholding ? "+wht" : ""}`,
    row: withLegs(
      {
        ...skeleton,
        kind: "DIVIDEND",
        instrumentId: INSTRUMENT_A,
        grossAmount: generated.amount,
        txnCurrency: generated.settlement.txnCurrency,
        cashCurrency: generated.settlement.cashCurrency,
        cashAmount: generated.settlement.cashAmount,
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      null,
      generated.withholding,
    ),
  }));

/**
 * **The 11th kind (`cash-interest`): interest earned on cash.**
 * DEPOSIT's row shape (no instrument) plus DIVIDEND's optional withholding
 * leg; the principal is INCOME, the withholding TAX. Generated with and
 * without a withholding, same-currency and cross-currency-settled.
 */
const interest: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    amount: positiveAmount,
    txnCurrency: currency,
    fxRate: positiveRate,
    fxRateSource: rateSource,
    withholding: withholdingLeg,
  })
  .map((generated) => ({
    label: `INTEREST${generated.withholding ? "+wht" : ""}`,
    row: withLegs(
      {
        ...skeleton,
        kind: "INTEREST",
        grossAmount: generated.amount,
        txnCurrency: generated.txnCurrency,
        ...degenerateCash(generated.txnCurrency, generated.amount),
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      null,
      generated.withholding,
    ),
  }));

/** An INTEREST paid in one currency into an account denominated in another — case D3/D5 on the INCOME leg. */
const crossSettledInterest: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    amount: positiveAmount,
    settlement: crossCurrencySettlement,
    fxRate: positiveRate,
    fxRateSource: rateSource,
    withholding: withholdingLeg,
  })
  .map((generated) => ({
    label: `INTEREST/cross-currency-settled${generated.withholding ? "+wht" : ""}`,
    row: withLegs(
      {
        ...skeleton,
        kind: "INTEREST",
        grossAmount: generated.amount,
        txnCurrency: generated.settlement.txnCurrency,
        cashCurrency: generated.settlement.cashCurrency,
        cashAmount: generated.settlement.cashAmount,
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      null,
      generated.withholding,
    ),
  }));

/**
 * **The 12th kind (`portfolio-cash`): a standalone portfolio
 * fee.** WITHDRAWAL's row shape (one negative cash leg), classified `FEE`, so
 * its principal posting sits inside the leakage term. Generated with and
 * without an instrument *reference* (PC-L14: it emits no POSITION posting),
 * same-currency and cross-currency-settled.
 */
const portfolioFee = (crossCurrency: boolean): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      amount: positiveAmount,
      txnCurrency: currency,
      settlement: crossCurrencySettlement,
      fxRate: positiveRate,
      fxRateSource: rateSource,
      instrumentId: fc.option(fc.constant(INSTRUMENT_A), { nil: null }),
    })
    .map((generated) => ({
      label: `FEE${crossCurrency ? "/cross-currency-settled" : ""}${generated.instrumentId === null ? "" : "+instrument"}`,
      row: withLegs(
        {
          ...skeleton,
          kind: "FEE",
          instrumentId: generated.instrumentId,
          grossAmount: generated.amount,
          ...(crossCurrency
            ? {
                txnCurrency: generated.settlement.txnCurrency,
                cashCurrency: generated.settlement.cashCurrency,
                cashAmount: generated.settlement.cashAmount,
              }
            : {
                txnCurrency: generated.txnCurrency,
                ...degenerateCash(generated.txnCurrency, generated.amount),
              }),
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        null,
        null,
      ),
    }));

const currencyExchange: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    amount: positiveAmount,
    txnCurrency: currency,
    targetCurrency: currency,
    exchangeRate: positiveRate,
    fxRate: positiveRate,
    fxRateSource: rateSource,
    fee: feeLeg,
  })
  .filter((generated) => generated.targetCurrency !== generated.txnCurrency)
  .map((generated) => ({
    label: `CURRENCY_EXCHANGE${generated.fee ? "+fee" : ""}`,
    row: withLegs(
      {
        ...skeleton,
        kind: "CURRENCY_EXCHANGE",
        grossAmount: generated.amount,
        txnCurrency: generated.txnCurrency,
        // FR-235/L3: `transaction_currency_exchange_cash_leg_pinned` makes the
        // degenerate case a database fact for this kind, so there is no
        // cross-currency CURRENCY_EXCHANGE shape to generate.
        ...degenerateCash(generated.txnCurrency, generated.amount),
        targetCurrency: generated.targetCurrency,
        targetCashAccountId: TARGET_ACCOUNT,
        targetAmount: generated.amount.times(generated.exchangeRate),
        fxRate: generated.fxRate,
        fxRateSource: generated.fxRateSource,
      },
      generated.fee,
      null,
    ),
  }));

/**
 * FT-32: a trade whose costs are **itemised**, in both settlement shapes.
 *
 * The cross-currency one is the case that matters — there `implied` is a real
 * division and the per-component sum genuinely differs from the aggregate
 * product. The degenerate one is included so the invariant is asserted for the
 * shape where `implied` is `fx_rate` exactly and the two forms agree.
 */
const itemisedFiatTrade = (crossCurrency: boolean): fc.Arbitrary<GeneratedTransaction> =>
  fc
    .record({
      quantity: positiveAmount,
      unitPrice: positiveAmount,
      settlement: crossCurrencySettlement,
      txnCurrency: currency,
      fxRate: positiveRate,
      fxRateSource: rateSource,
      costs: itemisedCosts,
    })
    .map((generated) => {
      const grossAmount = generated.quantity.times(generated.unitPrice);
      const txnCurrency = crossCurrency ? generated.settlement.txnCurrency : generated.txnCurrency;
      return {
        label: `BUY/itemised${crossCurrency ? "/cross-currency-settled" : ""}`,
        row: {
          ...withLegs(
            {
              ...skeleton,
              kind: "BUY" as const,
              instrumentId: INSTRUMENT_A,
              quantity: generated.quantity,
              grossAmount,
              txnCurrency,
              cashCurrency: crossCurrency ? generated.settlement.cashCurrency : txnCurrency,
              cashAmount: crossCurrency ? generated.settlement.cashAmount : grossAmount,
              fxRate: generated.fxRate,
              fxRateSource: generated.fxRateSource,
            },
            // The retired columns still exist and the pairing CHECKs still
            // require them beside a `fee_amount`, so a plausible row carries
            // them — and the expander's component branch must ignore them.
            {
              amount: generated.costs.total,
              currency: txnCurrency,
              rate: generated.fxRate,
              source: generated.fxRateSource,
            },
            null,
          ),
          ...generated.costs.components,
        },
      };
    });

/**
 * An itemised DIVIDEND that also withholds tax at source.
 *
 * The withholding posting is emitted **before** the components, and now
 * both it and the components take the principal leg's implied rate. Both are
 * `flow_class = 'TAX'`, which is why F1's exemption is keyed on position
 * rather than on the class — without this generator that distinction is
 * unreachable and the exemption's comment is unfalsifiable.
 *
 * **Settled degenerately, and that is a narrowing this file has made before.**
 * A cross-currency settlement here makes `implied` a 34-significant-digit
 * quotient, and summing a withholding base of order 1 beside cost bases of
 * order 0,01 then exceeds `Decimal`'s `precision: 34` — the run that found this
 * left a residue of **1e-33** on the exact `isZero()`, a precision artefact and
 * not a defect (the same class was closed earlier by narrowing generators;
 * nothing bounds the operands). The narrowing costs
 * nothing here: the generator still pins the posting order (withholding, then
 * components) that the position-keyed exemption relies on.
 */
const itemisedDividendWithWithholding: fc.Arbitrary<GeneratedTransaction> = fc
  .record({
    amount: positiveAmount,
    txnCurrency: currency,
    fxRate: positiveRate,
    fxRateSource: rateSource,
    withholding: fc.record({ amount: positiveAmount }),
    costs: itemisedCosts,
  })
  .map((generated) => ({
    label: "DIVIDEND/itemised+wht",
    row: {
      ...withLegs(
        {
          ...skeleton,
          kind: "DIVIDEND" as const,
          instrumentId: INSTRUMENT_A,
          grossAmount: generated.amount,
          txnCurrency: generated.txnCurrency,
          cashCurrency: generated.txnCurrency,
          cashAmount: generated.amount,
          fxRate: generated.fxRate,
          fxRateSource: generated.fxRateSource,
        },
        {
          amount: generated.costs.total,
          currency: generated.txnCurrency,
          rate: generated.fxRate,
          source: generated.fxRateSource,
        },
        generated.withholding,
      ),
      ...generated.costs.components,
    },
  }));

const anyTransaction: fc.Arbitrary<GeneratedTransaction> = fc.oneof(
  fiatTrade("BUY"),
  fiatTrade("SELL"),
  fiatTrade("DRIP"),
  assetSettledBuy,
  cashMovement("DEPOSIT"),
  cashMovement("WITHDRAWAL"),
  dividend,
  currencyExchange,
  // The cashless 8th kind — the only generated shape with a single leg.
  shareDistribution,
  // The two transfer legs — one EXTERNAL POSITION leg each.
  securityTransfer("TRANSFER_OUT"),
  securityTransfer("TRANSFER_IN"),
  // cash-interest's 11th kind — DEPOSIT's shape with DIVIDEND's withholding leg.
  interest,
  crossSettledInterest,
  // portfolio-cash's 12th kind — WITHDRAWAL's shape, classified FEE, with an
  // optional instrument reference that emits nothing.
  portfolioFee(false),
  portfolioFee(true),
  // Phase 1's D3/D4/D5 shapes, one per kind that has a principal cash leg.
  crossSettledFiatTrade("BUY"),
  crossSettledFiatTrade("SELL"),
  crossSettledFiatTrade("DRIP"),
  crossSettledCashMovement("DEPOSIT"),
  crossSettledCashMovement("WITHDRAWAL"),
  crossSettledDividend,
  // Phase 2's itemised shapes (FT-32, AC-240).
  itemisedFiatTrade(false),
  itemisedFiatTrade(true),
  // Components **and** a withholding leg on one row. Both carry
  // `flow_class` TAX, and only the components take the implied rate — so this
  // is the shape that tells a position-keyed exemption from a class-keyed one.
  itemisedDividendWithWithholding,
);

/**
 * The principal cash leg's implied rate, recomputed here from the row's own
 * stored columns.
 *
 * Deliberately an **independent** implementation of the rule rather than an
 * import of the expander's: the whole value of `leakageBase` is that it is
 * computed from the transaction rather than from the postings under test, and
 * importing the function under test would make the cross-check circular.
 */
function impliedPrincipalRate(row: ExpandableTransaction): Decimal {
  if (
    row.cashCurrency === null ||
    row.cashAmount === null ||
    row.cashAmount.isZero() ||
    (row.txnCurrency !== null && row.cashCurrency.trim() === row.txnCurrency.trim())
  ) {
    return row.fxRate;
  }
  return row.grossAmount.times(row.fxRate).dividedBy(row.cashAmount);
}

/** A wider `Decimal` for combining already-rounded figures without a second rounding. */
const WideDecimal = Decimal.clone({ precision: 80 });

/**
 * The fee/tax leakage, taken from the transaction's own stored columns rather
 * than from the postings.
 *
 * **FT-32 — this sums per component, and that is a requirement
 * rather than a style choice.** `Σ(cᵢ × implied) ≠ (Σcᵢ) × implied` at
 * `precision: 34`: `implied` is a division result carrying 34 significant
 * digits, a product with it is generally not exactly representable, and four
 * separately-rounded products do not sum to the single rounded product. The
 * expander emits one posting per component, so a leakage computed as
 * `fee_amount × implied` would make the exact `isZero()` assertion below fail
 * **on precision, not on a defect** — demonstrated in this file's own
 * "the trap" test rather than left as a claim.
 *
 * It stays a genuine cross-check: the operations are the expander's, but the
 * inputs are the row's stored columns, never the postings. Perturb a posting
 * and the property fails — asserted, so the independence is not assumed.
 */
function leakageBase(row: ExpandableTransaction, Num: typeof Decimal = Decimal): Decimal {
  const components = [row.brokerFeeAmount, row.fxFeeAmount, row.taxAmount, row.otherCostAmount];
  const itemised = components.some((amount) => amount !== null);
  const fee = itemised
    ? components.reduce(
        (sum: Decimal, amount) =>
          amount === null ? sum : sum.plus(amount.times(impliedPrincipalRate(row))),
        new Num(0),
      )
    : row.feeAmount === null
      ? new Num(0)
      : new Num(row.feeAmount.times(principalImpliedRate(row)));
  // portfolio-cash (FEE kind): the principal leg *is* a fee, so the gross at
  // the principal rate is leakage too — the same product the expander emits.
  const principalFee = row.kind === "FEE" ? row.grossAmount.times(row.fxRate) : new Num(0);
  const tax =
    row.withholdingAmount === null
      ? new Num(0)
      : row.withholdingAmount.times(impliedPrincipalRate(row));
  return new Num(fee).plus(principalFee).plus(tax);
}

function sumBase(
  postings: readonly { amountBase: Decimal; flowClass: string }[],
  predicate: (flowClass: string) => boolean = () => true,
): Decimal {
  return postings
    .filter((posting) => predicate(posting.flowClass))
    .reduce((total, posting) => total.plus(posting.amountBase), new Decimal(0));
}

describe("expandPostings — property: postings sum to zero except for the fee/tax legs", () => {
  it("holds for a randomly generated valid transaction of any kind", () => {
    const shapesSeen = new Set<string>();

    fc.assert(
      fc.property(anyTransaction, ({ row, label }) => {
        shapesSeen.add(label);
        const postings = expandPostings(row, noRounding);
        expect(postings.length).toBeGreaterThan(0);

        const leakage = leakageBase(row);
        const total = sumBase(postings);
        const external = sumBase(postings, (flowClass) => flowClass === "EXTERNAL");
        const income = sumBase(postings, (flowClass) => flowClass === "INCOME");

        // The general invariant, at full precision — `isZero()`, never a
        // tolerance, over amounts carrying up to 18 dp.
        //
        // Combined at 80 digits: the withholding is now converted at the
        // principal's implied rate — a 34-significant-digit quotient on a
        // cross-currency-settled row — so adding it to a larger INCOME base at
        // `precision: 34` rounds away its last digits on one side and not the
        // other, a residue of the arithmetic and not of the ledger. Each
        // posting's own product is still rounded exactly as the expander
        // rounds it; only the *sum of those figures* is widened.
        const wideSum = (predicate: (flowClass: string) => boolean) =>
          postings
            .filter((posting) => predicate(posting.flowClass))
            .reduce((sum, posting) => sum.plus(posting.amountBase.toString()), new WideDecimal(0));
        expect(
          wideSum(() => true)
            .minus(wideSum((flowClass) => flowClass === "EXTERNAL"))
            .minus(wideSum((flowClass) => flowClass === "INCOME"))
            .plus(leakageBase(row, WideDecimal))
            .isZero(),
        ).toBe(true);

        // ...which is exactly "every leg with a counterparty inside the
        // portfolio is balanced by it".
        expect(sumBase(postings, (flowClass) => flowClass === "INTERNAL").isZero()).toBe(true);

        // The fee and tax legs are the leakage, and nothing else is.
        expect(
          sumBase(postings, (flowClass) => flowClass === "FEE" || flowClass === "TAX")
            .plus(leakage)
            .isZero(),
        ).toBe(true);

        // The literal one-line form, for the kinds that have no leg crossing
        // the portfolio boundary — see this file's header for the three kinds
        // it cannot cover and why.
        if (external.isZero() && income.isZero()) {
          expect(total.plus(leakage).isZero()).toBe(true);
        }

        // portfolio-cash PC-L14: a FEE's instrument is a reference only — it
        // never yields a POSITION posting.
        if (row.kind === "FEE") {
          expect(postings.every((posting) => posting.leg === "CASH")).toBe(true);
        }
      }),
      { numRuns: 1000, seed: PROPERTY_SEED },
    );

    // The generator actually produced every shape the invariant has to hold
    // for — including the asset-settled and withholding cases. Without this,
    // a generator that quietly only emitted DEPOSITs would pass the property
    // above while proving nothing.
    for (const required of [
      "BUY",
      "BUY+fee",
      "BUY/asset-settled",
      "SELL",
      "SELL+fee",
      "DRIP",
      "DEPOSIT",
      "WITHDRAWAL",
      "DIVIDEND",
      "DIVIDEND+wht",
      "CURRENCY_EXCHANGE",
      "CURRENCY_EXCHANGE+fee",
      // A run that generated no cashless distribution proves
      // nothing about the single-leg branch — the same mechanism as AC-267's
      // and AC-240's below, extended once more.
      "SHARE_DISTRIBUTION",
      // A run that generated neither transfer leg proves
      // nothing about the one branch that emits an EXTERNAL POSITION leg.
      "TRANSFER_OUT",
      "TRANSFER_IN",
      // cash-interest: the 11th kind, with and without its
      // withholding leg, same- and cross-currency-settled.
      "INTEREST",
      "INTEREST+wht",
      "INTEREST/cross-currency-settled",
      "INTEREST/cross-currency-settled+wht",
      // portfolio-cash: the 12th kind, with and without its
      // instrument reference, same- and cross-currency-settled.
      "FEE",
      "FEE+instrument",
      "FEE/cross-currency-settled",
      "FEE/cross-currency-settled+instrument",
      // `fee-tax-breakdown` phase 1, AC-267: a run that generated no
      // cross-currency-settled row proves nothing about the branch phase 1
      // added, and fails here — the same mechanism, extended, not a second one.
      "BUY/cross-currency-settled",
      "SELL/cross-currency-settled",
      "DEPOSIT/cross-currency-settled",
      "DIVIDEND/cross-currency-settled",
      // These two are generated (`crossSettledFiatTrade`
      // covers BUY|SELL|DRIP, `crossSettledCashMovement` covers
      // DEPOSIT|WITHDRAWAL) and were **absent from this list**, so they could
      // have stopped being generated without a single failure. That is the
      // same hole the list exists to close, left open for two of the shapes it
      // was extended for.
      "DRIP/cross-currency-settled",
      "WITHDRAWAL/cross-currency-settled",
      // `fee-tax-breakdown` phase 2, AC-240: a run that generated no itemised
      // row proves nothing about the component loop or about the
      // per-component leakage this file now computes. Same mechanism as
      // AC-267's above, extended — not a second one.
      "BUY/itemised",
      "BUY/itemised/cross-currency-settled",
      // Components beside a withholding leg, the shape that
      // distinguishes F1's position-keyed exemption from a class-keyed one.
      "DIVIDEND/itemised+wht",
    ]) {
      expect([...shapesSeen]).toContain(required);
    }
  });

  it("a cashless distribution expands to one POSITION leg worth exactly zero, and no CASH leg ever", () => {
    /**
     * The 8th kind's own case, stated separately from the general property
     * above because the general one would be satisfied by a *balanced pair* of
     * legs just as well as by the single zero-value leg the kind actually has
     * — and a cash leg carrying ±503,40 balanced against a position leg
     * carrying ∓503,40 would sum to zero while silently capitalising money
     * that never moved and debiting an account that was never named.
     *
     * So this asserts the shape as well as the sum: exactly one posting, on
     * the POSITION leg, `amount_native` and `amount_base` both exactly zero,
     * and **no CASH posting produced for any generated distribution at all**.
     */
    let seen = 0;
    fc.assert(
      fc.property(shareDistribution, ({ row }) => {
        seen += 1;
        const postings = expandPostings(row, noRounding);

        expect(postings).toHaveLength(1);
        const [only] = postings;
        expect(only!.leg).toBe("POSITION");
        expect(postings.filter((posting) => posting.leg === "CASH")).toHaveLength(0);

        // The units arrive in full…
        expect(only!.quantityDelta!.equals(row.quantity!)).toBe(true);
        expect(only!.instrumentId).toBe(row.instrumentId);
        // …and no cash account is named, because none moved (`0039`'s
        // `transaction_posting_cash_leg_has_account`, from the other side).
        expect(only!.cashAccountId).toBeNull();
        expect(only!.currency).toBeNull();

        // **Zero cost contribution**, at full precision — the market value on
        // the row (`gross_amount`, freely generated and positive) reaches
        // neither figure.
        expect(row.grossAmount.greaterThan(0)).toBe(true);
        expect(only!.amountNative.isZero()).toBe(true);
        expect(only!.amountBase.isZero()).toBe(true);

        // In its strongest form: the legs sum to exactly zero with no
        // leakage term at all, and the leg is INTERNAL — so it opens no TWR
        // sub-period and is invisible to XIRR.
        expect(leakageBase(row).isZero()).toBe(true);
        expect(sumBase(postings).isZero()).toBe(true);
        expect(only!.flowClass).toBe("INTERNAL");
      }),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
    // The positive companion: assertions inside a property that generated
    // nothing are the vacuous pass this repository has recorded repeatedly.
    expect(seen).toBe(300);
  });

  it("a transfer leg expands to one EXTERNAL POSITION leg at its market value, and no money leg ever", () => {
    /**
     * Stated separately from the general property for the reason the cashless-distribution
     * case above gives: a balanced pair of legs would satisfy the sum just as
     * well. A transfer moves units and no money, so the shape is asserted:
     * exactly one posting, on the POSITION leg, `∓quantity`, `∓gross_amount`,
     * `∓gross_amount × fx_rate` — the market value, the `SELL` convention —
     * and no CASH posting for any generated leg at all.
     */
    let seen = 0;
    fc.assert(
      fc.property(
        fc.oneof(securityTransfer("TRANSFER_OUT"), securityTransfer("TRANSFER_IN")),
        ({ row }) => {
          seen += 1;
          const postings = expandPostings(row, noRounding);
          expect(postings).toHaveLength(1);
          expect(postings.filter((posting) => posting.leg === "CASH")).toHaveLength(0);
          const [only] = postings;
          const sign = row.kind === "TRANSFER_OUT" ? -1 : 1;
          expect(only!.leg).toBe("POSITION");
          expect(only!.instrumentId).toBe(row.instrumentId);
          expect(only!.cashAccountId).toBeNull();
          expect(only!.currency).toBeNull();
          expect(only!.quantityDelta!.equals(row.quantity!.times(sign))).toBe(true);
          expect(only!.amountNative.equals(row.grossAmount.times(sign))).toBe(true);
          expect(only!.amountBase.equals(row.grossAmount.times(row.fxRate).times(sign))).toBe(true);
          expect(only!.flowClass).toBe("EXTERNAL");
        },
      ),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
    expect(seen).toBe(300);
  });

  it("EXTERNAL is emitted only by DEPOSIT/WITHDRAWAL and the two transfer legs — the property TWR and XIRR both rest on", () => {
    // This read "only by DEPOSIT/WITHDRAWAL" until the
    // two transfer kinds joined the generator, and failed on the first one.
    fc.assert(
      fc.property(anyTransaction, ({ row }) => {
        const external = expandPostings(row, noRounding).filter(
          (posting) => posting.flowClass === "EXTERNAL",
        );
        if (
          row.kind === "DEPOSIT" ||
          row.kind === "WITHDRAWAL" ||
          row.kind === "TRANSFER_OUT" ||
          row.kind === "TRANSFER_IN"
        ) {
          expect(external).toHaveLength(1);
        } else {
          expect(external).toHaveLength(0);
        }
      }),
      { numRuns: 500, seed: PROPERTY_SEED },
    );
  });

  it("every posting's base amount is its native amount at its own copied rate (FR-57, AC47)", () => {
    // **The one documented exception, widened once by phase 1 — finding F1.**
    //
    // It covers the two legs whose base value is carried across *value
    // neutrally* rather than converted at a stored rate, and it asserts that
    // carried value directly instead of through a rate. Both fail the general
    // form for the same two reasons: the rate they carry is an implied
    // quotient and so is not one of the row's three stored rates, and
    // `amount_native × fx_rate_applied` is exactly the equality
    // `posting-expander.ts`'s own `numeric(28,12)` caveat says does not hold.
    //
    //   1. A CURRENCY_EXCHANGE's target leg (shipped) — its base value is the
    //      source leg's, negated.
    //   2. The principal cash leg of a cross-currency-settled row, cases
    //      D3/D4/D5 (`fee-tax-breakdown` phase 1) — its base value is
    //      `±gross_amount × fx_rate`, the same expression of the same two
    //      stored numbers the degenerate branch uses.
    //
    // **Widened in scope, not weakened in strength.** For case 2 the assertion
    // below pins `amount_base` to an exact hand-derived figure *including its
    // sign*, which is strictly more than the general form asked of that
    // posting before phase 1 (that form tied `amount_base` only to
    // `amount_native`, itself now the account's figure). The predicate is
    // deliberately narrow: it names the **principal** cash posting of a row
    // whose `cash_currency` differs from its `txn_currency`, never "any
    // posting whose rate is not in the array" — a fee or withholding leg
    // carrying an unexpected rate still fails, on the same row.
    fc.assert(
      fc.property(anyTransaction, ({ row }) => {
        const postings = expandPostings(row, noRounding);
        // FR-260: `feeFxRate` was the third entry until `0049`.
        // A cost carries the principal's rate now, which the first entry
        // already covers.
        const rates = [row.fxRate.toString()];
        // The principal cash leg is the first CASH posting emitted, for every
        // kind that has one; an asset-settled row has none, and its
        // `cash_currency` is NULL, so the guard below never reaches a fee leg.
        const principalCashSeq = postings.find((posting) => posting.leg === "CASH")?.seq;
        const crossCurrencySettled = row.cashCurrency !== row.txnCurrency;
        // Identified by **position**, not by flow class. The
        // components are the last postings emitted, one per present component,
        // so this is exact — whereas `flowClass === "FEE" || "TAX"` also
        // matches a *withholding* leg, which is emitted earlier and carries its
        // own stored rate. Keying on the class would have asserted a
        // withholding posting against the principal's implied rate on any
        // itemised dividend.
        const componentCount = [
          row.brokerFeeAmount,
          row.fxFeeAmount,
          row.taxAmount,
          row.otherCostAmount,
        ].filter((amount) => amount !== null).length;
        // FR-260: an **unitemised** total is a cost posting on
        // exactly the same terms now — one posting, last in the order, at the
        // principal leg's implied rate. It carried its own stored `fee_fx_rate`
        // until `0049`, which is why it used to fall under the general form and
        // why only itemised rows were counted here.
        const costCount = componentCount > 0 ? componentCount : row.feeAmount === null ? 0 : 1;
        const firstCostSeq = costCount === 0 ? undefined : postings.length - costCount + 1;
        // The withholding is emitted right before the cost postings and
        // is converted at the principal's implied rate, like a cost.
        const withholdingSeq =
          row.withholdingAmount === null ? undefined : postings.length - costCount;
        for (const posting of postings) {
          if (withholdingSeq !== undefined && posting.seq === withholdingSeq) {
            expect(posting.fxRateApplied.toString()).toBe(impliedPrincipalRate(row).toString());
            expect(
              posting.amountBase.minus(posting.amountNative.times(posting.fxRateApplied)).isZero(),
            ).toBe(true);
            continue;
          }
          if (row.kind === "CURRENCY_EXCHANGE" && posting.seq === 2) {
            // The target leg: its base value is the source leg's, negated —
            // value-neutrality, asserted directly rather than through a rate.
            expect(posting.amountBase.plus(postings[0]!.amountBase).isZero()).toBe(true);
            continue;
          }
          if (crossCurrencySettled && posting.seq === principalCashSeq) {
            // The settlement leg: the trade's base value, carried across
            // unchanged by the account's currency — asserted directly, sign
            // and all, rather than through the implied rate.
            const grossBase = row.grossAmount.times(row.fxRate);
            const paysOut =
              row.kind === "BUY" ||
              row.kind === "DRIP" ||
              row.kind === "WITHDRAWAL" ||
              row.kind === "FEE";
            expect(
              posting.amountBase.minus(paysOut ? grossBase.negated() : grossBase).isZero(),
            ).toBe(true);
            continue;
          }
          if (firstCostSeq !== undefined && posting.seq >= firstCostSeq) {
            // **F1's third case, phase 2 (FT-31/FT-32).** A cost posting —
            // itemised or not, identified by its position in the sequence so a
            // withholding leg on the same row is **not** exempted and is still
            // held to the general form — is converted at the *principal leg's
            // implied rate*
            // so on a cross-currency-settled row that rate is a
            // quotient and is not one of the row's three stored rates — the
            // general form's first half is false for the same reason it is
            // false for the two legs above.
            //
            // Its second half is **not** relaxed: `amount_base` here really is
            // `amount_native × fx_rate_applied`, exactly, because that is the
            // product the expander computes. So the exemption removes one
            // assertion and keeps the other, and adds a third the general form
            // could not make — that the rate is the principal leg's own, which
            // is what ties a cost's conversion to the trade it belongs to.
            expect(posting.fxRateApplied.toString()).toBe(impliedPrincipalRate(row).toString());
            expect(
              posting.amountBase.minus(posting.amountNative.times(posting.fxRateApplied)).isZero(),
            ).toBe(true);
            continue;
          }
          // Copied verbatim from one of the parent's three resolved legs...
          expect(rates).toContain(posting.fxRateApplied.toString());
          // ...and applied in the fixed direction.
          expect(
            posting.amountBase.minus(posting.amountNative.times(posting.fxRateApplied)).isZero(),
          ).toBe(true);
        }
      }),
      { numRuns: 500, seed: PROPERTY_SEED },
    );
  });

  /**
   * The two claims F1's exemption block **stated in prose and
   * did not assert**.
   *
   * Both are true: GATE-A verified each by mutation
   * (`toBase(signedAmount, txn.fxRate).plus(1)` in the degenerate branch, and
   * `rate.plus(1)` on the fee leg — each reddens the properties above,
   * `Property failed after 1 tests` / `after 3 tests`). The defect was that
   * nothing *gated* them, so the exemption predicate could be widened later
   * and no test would notice. F1 is **the one named exception to FR-260**,
   * which makes it exactly the thing that must not be able to drift silently.
   *
   * These two cases are the standing guards, not a re-run of that mutation:
   * they assert the exemption's predicate is **narrow** — that it does not
   * reach the shapes it was never meant to cover — and that the equalities it
   * leaves in place are falsifiable rather than vacuous.
   */
  describe("F1's exemption is narrow, and the assertions it leaves in place can fail", () => {
    it("claim 1: a degenerate D1/D2 row is NOT exempt — its principal cash leg is held to the general form, and a wrong amount_base breaks it", () => {
      let seen = 0;
      fc.assert(
        fc.property(fc.oneof(fiatTrade("BUY"), cashMovement("DEPOSIT")), ({ row }) => {
          // The exemption's own predicate, restated: it applies only where the
          // settling account's currency differs from the transaction's. A
          // degenerate row has them equal, so the branch is not taken.
          const crossCurrencySettled =
            row.cashCurrency !== null &&
            row.txnCurrency !== null &&
            row.cashCurrency.trim() !== row.txnCurrency.trim();
          expect(crossCurrencySettled).toBe(false);

          const postings = expandPostings(row, noRounding);
          const principal = postings.find((posting) => posting.leg === "CASH");
          expect(principal).toBeDefined();
          seen += 1;

          // The general form, in full, on a leg the exemption does not cover.
          const rates = [row.fxRate.toString()];
          expect(rates).toContain(principal!.fxRateApplied.toString());
          expect(
            principal!.amountBase
              .minus(principal!.amountNative.times(principal!.fxRateApplied))
              .isZero(),
          ).toBe(true);

          // **And it is falsifiable.** The equality above is the one GATE-A
          // reddened with `.plus(1)` in the expander; asserting it fails for a
          // perturbed `amount_base` is what makes it a check rather than a
          // tautology about two numbers that happen to agree.
          expect(
            principal!.amountBase
              .plus(1)
              .minus(principal!.amountNative.times(principal!.fxRateApplied))
              .isZero(),
          ).toBe(false);
        }),
        { numRuns: 200, seed: PROPERTY_SEED },
      );
      expect(seen).toBeGreaterThan(0);
    });

    it("claim 2: a cost leg's rate is pinned to the principal's implied rate — an unexpected rate breaks it, on the same row", () => {
      let seenCostLegs = 0;
      fc.assert(
        fc.property(itemisedFiatTrade(true), ({ row }) => {
          const postings = expandPostings(row, noRounding);
          const costLegs = postings.filter(
            (posting) => posting.flowClass === "FEE" || posting.flowClass === "TAX",
          );
          if (costLegs.length === 0) return;
          seenCostLegs += costLegs.length;

          const implied = impliedPrincipalRate(row);
          for (const leg of costLegs) {
            // What the exemption asserts of a cost leg — it is not exempted
            // from having a *correct* rate, only from having one of the row's
            // three stored ones.
            expect(leg.fxRateApplied.toString()).toBe(implied.toString());
            // And the prose claim, now an assertion: a leg carrying an
            // unexpected rate does not satisfy it. This is a
            // cross-currency-settled row, so the implied rate is a quotient
            // and `rate.plus(1)` is genuinely a different number.
            expect(leg.fxRateApplied.plus(1).toString()).not.toBe(implied.toString());
            // The second half of the exemption, which is *not* relaxed.
            expect(leg.amountBase.minus(leg.amountNative.times(leg.fxRateApplied)).isZero()).toBe(
              true,
            );
            expect(
              leg.amountBase.minus(leg.amountNative.times(leg.fxRateApplied.plus(1))).isZero(),
            ).toBe(false);
          }
        }),
        { numRuns: 200, seed: PROPERTY_SEED },
      );
      // A run that generated no cost leg at all would satisfy every assertion
      // above vacuously — the same guard the required-label list makes for the
      // property.
      expect(seenCostLegs).toBeGreaterThan(0);
    });
  });

  /**
   * The digit budget's durable half. The random search above can only ever *sample* the
   * generator ranges; this pins the corner cases of the declared digit budget
   * directly, so widening `AMOUNT_*`/`RATE_*_DIGITS` past what `precision: 34`
   * can represent fails here rather than at run 952 of a random search on some
   * future CI run.
   */
  it("the generator digit budget fits Decimal's 34-digit precision — at its own corners", () => {
    const widest = (int: number, frac: number): Decimal =>
      new Decimal(`${"9".repeat(int)}.${"9".repeat(frac)}`);
    const narrowest = (frac: number): Decimal => new Decimal(`0.${"0".repeat(frac - 1)}1`);

    /**
     * The four corner products of an (amount, rate) range pair. A real sum
     * mixes products from different legs — gross, fee, withholding — so the
     * term with the widest integer part and the term with the narrowest
     * fractional part can co-occur, which is why the budget is marginal
     * rather than per-pair.
     */
    const corners = (aInt: number, aFrac: number, rInt: number, rFrac: number): Decimal[] => {
      const amounts = [widest(aInt, aFrac), narrowest(aFrac)];
      const rates = [widest(rInt, rFrac), narrowest(rFrac)];
      return amounts.flatMap((amount) => rates.map((rate) => amount.times(rate)));
    };

    /** Exactly the check every assertion in this file performs: does the sum decompose back to its terms? */
    const sumIsExact = (terms: readonly Decimal[]): boolean =>
      terms
        .reduce(
          (total, term) => total.minus(term),
          terms.reduce((a, b) => a.plus(b), new Decimal(0)),
        )
        .isZero();

    const shipped = corners(
      AMOUNT_INT_DIGITS,
      AMOUNT_FRAC_DIGITS,
      RATE_INT_DIGITS,
      RATE_FRAC_DIGITS,
    );

    // Every individual product is representable...
    for (const product of shipped) {
      expect(product.precision()).toBeLessThanOrEqual(34);
    }
    // ...and so is the widest-span sum of them, which is the property the
    // `isZero()` assertions above actually depend on.
    expect(sumIsExact(shipped)).toBe(true);

    // The negative control — without it this test could not distinguish "the
    // budget fits" from "this check never looked". The ranges this file
    // shipped before the digit budget (6+18 amount, 5+12 rate) span 41 digits and must
    // NOT decompose exactly. If this line ever goes green, the assertion
    // above has stopped having teeth.
    expect(sumIsExact(corners(6, 18, 5, 12))).toBe(false);
  });

  /**
   * The digit budget's other half: the fix must not be "narrow the ranges until nothing
   * interesting is generated". These are the widths the header's claims rest
   * on — 18 dp amounts (NFR-12/AC53) and a multi-digit, >= 8 dp rate.
   */
  it("the generators still reach their declared widths", () => {
    const dpOf = (value: Decimal): number => value.decimalPlaces();
    const intDigitsOf = (value: Decimal): number => value.trunc().abs().toFixed().length;

    const amounts = fc.sample(positiveAmount, { numRuns: 2000, seed: PROPERTY_SEED });
    const rates = fc.sample(positiveRate, { numRuns: 2000, seed: PROPERTY_SEED });

    expect(Math.max(...amounts.map(dpOf))).toBe(AMOUNT_FRAC_DIGITS);
    expect(Math.max(...amounts.map(intDigitsOf))).toBe(AMOUNT_INT_DIGITS);
    expect(Math.max(...rates.map(dpOf))).toBe(RATE_FRAC_DIGITS);
    expect(Math.max(...rates.map(intDigitsOf))).toBe(RATE_INT_DIGITS);

    // The system promises an FX rate carries at least 8 dp; the
    // narrowed range has to stay above that floor, not merely below 34.
    expect(RATE_FRAC_DIGITS).toBeGreaterThanOrEqual(8);
  });
});

/**
 * **FT-32 — the exactness trap, demonstrated rather than described.**
 *
 * The fix (`leakageBase` sums per component) is a requirement
 * rather than an implementer's choice, precisely because the
 * failure it prevents looks like a bug in the expander and is not. These two
 * tests are the capture that keeps the next author from "simplifying" the
 * per-component sum back into `fee_amount × implied`.
 *
 * **What phase 2 does to the unbounded-`zDecimal` defect, read before this file was edited, as
 * FT-32 requires.** It records that `zDecimal` bounds neither operand of
 * `amount_base = native × rate`, so a product can need more than `precision:
 * 34` — LOW because `numeric(38,12)`'s write-side rounding discards every error
 * measured on realistic rows (`≤ 2e-18`, ten orders of magnitude below the
 * stored scale), and material only when both operands carry many integer
 * digits at once.
 *
 * Phase 2 **does** change the arithmetic: where there was one product
 * (`fee_amount × rate`) there are now up to four (`cᵢ × implied`), and
 * `implied` is a quotient carrying the full 34 significant digits rather than a
 * stored rate with at most 16+12. So the *per-product* precision demand goes
 * up. What does not change is that defect's conclusion: each product is still rounded
 * to `numeric(38,12)` on write, each `cᵢ` is a cost — orders of magnitude
 * smaller than a gross — and the sum of four small products cannot need more
 * integer digits than the single product of their total did. The status stays
 * LOW, and the reason is now recorded here rather than re-derived next time.
 */
describe("expandPostings — FT-32: why the leakage is summed per component", () => {
  /**
   * A cross-currency-settled BUY whose implied rate is a non-terminating
   * quotient — `1 234,567 × 1 / 7,77` — with three components whose products
   * round differently one at a time than in aggregate.
   *
   * **The figures are chosen, not arbitrary.** Most combinations do *not* trip
   * the trap: `1 000 / 3` with three equal components, or with 9,90/2,50/3,60,
   * gives the identical result both ways. It takes components whose individual
   * products land on different rounding boundaries, which is exactly why the
   * fix is stated rather than leaving it to be discovered — a developer
   * checking "does this actually matter?" with round numbers concludes it does
   * not.
   */
  function nonTerminatingItemisedRow(): ExpandableTransaction {
    const components = {
      brokerFeeAmount: new Decimal("9.909999"),
      fxFeeAmount: new Decimal("2.5"),
      taxAmount: new Decimal("3.6"),
      otherCostAmount: null,
    };
    return {
      ...withLegs(
        {
          ...skeleton,
          kind: "BUY" as const,
          instrumentId: INSTRUMENT_A,
          quantity: new Decimal("1"),
          grossAmount: new Decimal("1234.567"),
          txnCurrency: "USD",
          cashCurrency: "CHF",
          cashAmount: new Decimal("7.77"),
          fxRate: new Decimal("1"),
          fxRateSource: "USER_PINNED" as const,
        },
        {
          amount: new Decimal("16.009999"),
          currency: "USD",
          rate: new Decimal("1"),
          source: "USER_PINNED",
        },
        null,
      ),
      ...components,
    };
  }

  it("the aggregate form `fee_amount × implied` breaks the exact isZero(), and the per-component sum does not", () => {
    const row = nonTerminatingItemisedRow();
    const postings = expandPostings(row, noRounding);
    const implied = impliedPrincipalRate(row);
    // Non-vacuity: the rate really is a non-terminating quotient carrying the
    // full 34 significant digits, which is the only condition under which the
    // two forms can differ at all.
    expect(implied.toString()).toBe("158.8889317889317889317889317889318");

    const costs = sumBase(postings, (flowClass) => flowClass === "FEE" || flowClass === "TAX");
    const aggregate = row.feeAmount!.times(implied).negated();
    const perComponent = [
      row.brokerFeeAmount,
      row.fxFeeAmount,
      row.taxAmount,
      row.otherCostAmount,
    ].reduce(
      (sum: Decimal, amount) => (amount === null ? sum : sum.minus(amount.times(implied))),
      new Decimal(0),
    );

    // **The trap:** the two differ, at the last digit, with no defect anywhere.
    expect(aggregate.equals(perComponent)).toBe(false);
    // The property's own assertion, both ways round: aggregate fails the exact
    // `isZero()` the file asserts everywhere, per-component passes it.
    expect(costs.minus(aggregate).isZero()).toBe(false);
    expect(costs.minus(perComponent).isZero()).toBe(true);
    // …and `leakageBase` is on the side that passes.
    expect(costs.plus(leakageBase(row)).isZero()).toBe(true);
  });

  it("the leakage is computed from the row and not from the postings — perturbing a posting fails the property", () => {
    // If `leakageBase` were recomputed from the postings it would move with
    // them and the cross-check would be vacuous: this asserts it does not.
    const row = nonTerminatingItemisedRow();
    const postings = expandPostings(row, noRounding);
    const leakage = leakageBase(row);

    // Unperturbed, the invariant holds.
    expect(
      sumBase(postings, (flowClass) => flowClass === "FEE" || flowClass === "TAX")
        .plus(leakage)
        .isZero(),
    ).toBe(true);

    // One posting's base amount moved by the smallest representable step.
    const perturbed = postings.map((posting, index) =>
      index === postings.length - 1
        ? { ...posting, amountBase: posting.amountBase.plus(new Decimal("0.000000000001")) }
        : posting,
    );
    expect(
      sumBase(perturbed, (flowClass) => flowClass === "FEE" || flowClass === "TAX")
        .plus(leakageBase(row))
        .isZero(),
    ).toBe(false);
  });
});
