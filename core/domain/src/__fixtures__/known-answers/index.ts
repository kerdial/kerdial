/**
 * The known-answer fixtures — the single, checked-in source of truth for every
 * hand-calculated TWR / MWR / PMP / realized-gain / FX case (T-29; NFR-4,
 * AC17–AC21, AC41).
 *
 * ## Why this file exists
 *
 * Before T-29 the same numbers were re-declared in each engine's own test file:
 * the USD three-buys-plus-a-sale sequence lived in *both* `pmp.test.ts` and
 * `realized-gains.test.ts`; the AC17 single-buy/sale and the AC18 interim-deposit
 * portfolios lived in *both* `twr.test.ts` and `xirr.test.ts`. Two copies of a
 * hand-calculated number is two chances to edit one and forget the other, and a
 * release gate built on a duplicated fixture cannot claim to be the source of
 * truth. This file is that single source: every case's **input**, its
 * **hand-calculated expected value**, and its **prose derivation** live here
 * once, and the per-engine test files now import these constants rather than
 * re-declaring them (T-29: "exactly one source of truth per case"). NFR-4's "documented" requirement is thereby satisfied by the
 * repository itself — the derivation is inline, both as prose comments and as
 * the `derivation` field on each {@link KnownAnswerCase}.
 *
 * ## The release gate (`known-answers.test.ts`, AC41)
 *
 * {@link ALL_KNOWN_ANSWER_CASES} is consumed by the sibling
 * `known-answers.test.ts` suite, which recomputes every case with the real
 * engine and fails the build if any computed value deviates from its documented
 * expected value by more than **0.01%** ({@link AC_TOLERANCE}). That suite is
 * wired into CI as a blocking release gate. Perturbing any expected value below
 * makes the gate fail — which is exactly the falsification AC41 demands (the
 * whole point of this suite is a gate that *can* fail).
 *
 * ## Pure and DB-free
 *
 * Every case is an in-memory array literal and a `Decimal`. There is no
 * database, no HTTP, no provider, no clock, no filesystem read anywhere in this
 * file or in the suite that consumes it — the `checks()` closures call only the
 * pure engine functions. This file imports nothing but `@kerdial/core-decimal`
 * and its sibling engine modules (`../../pmp.js`, `../../twr.js`, …), matching
 * the `core-domain-purity` regime.
 *
 * ## Location note
 *
 * T-29 names the directory `core/domain/__fixtures__/known-answers/`.
 * It sits under `src/` here (`core/domain/src/__fixtures__/known-answers/`)
 * because the package's `tsc -b` build uses `rootDir: ./src`, and a `src/*.test.ts`
 * file importing a typed module from outside `src` fails with TS6059/TS6307
 * ("not under rootDir"). Placing it under `src/` keeps the `__fixtures__/known-answers/`
 * leaf name (which vitest's and dependency-cruiser's `__fixtures__` glob
 * exclusions both key on, so these data modules are never mistaken
 * for a test suite) while remaining importable by the existing engine test files.
 */
import { Decimal } from "@kerdial/core-decimal";
import { computePmp, replayPositions, type PositionTxn } from "../../pmp.js";
import {
  attributeFx,
  computeRealizedGains,
  type FxAttributionInput,
} from "../../realized-gains.js";
import { classifyFlows, type TransactionKind, type TransactionLeg } from "../../flow-class.js";
import { computeTwr, type TwrFlow, type Valuation } from "../../twr.js";
import { computeXirr, type TerminalValue, type XirrFlow } from "../../xirr.js";
import { valuePortfolio, type FxRatePoint, type PricePoint } from "../../valuation.js";
import { cashBalancesBefore, valueCash, type CashDailyNet } from "../../cash-valuation.js";
import type { HoldingState } from "../../pmp.js";

// ---------------------------------------------------------------------------
// Tolerance and comparison — the 0.01% known-answer bar (NFR-4, AC41).
// ---------------------------------------------------------------------------

/** NFR-4's 0.01% deviation bar, expressed as a fraction (0.0001 = 0.01%). */
export const AC_TOLERANCE = new Decimal("0.0001");

/**
 * True when `actual` is within {@link AC_TOLERANCE} of `expected`. Relative for
 * non-zero expectations; for an expected value of exactly zero (e.g. the native
 * gain on a self-quoted crypto disposal) a relative bar is undefined, so the
 * bar becomes absolute: `|actual| ≤ tolerance`. This is the exact predicate the
 * release gate asserts on every check.
 */
export function withinTolerance(actual: Decimal, expected: Decimal): boolean {
  if (expected.isZero()) return actual.abs().lessThanOrEqualTo(AC_TOLERANCE);
  return actual.minus(expected).abs().dividedBy(expected.abs()).lessThanOrEqualTo(AC_TOLERANCE);
}

// ---------------------------------------------------------------------------
// Case registry shape (consumed by known-answers.test.ts).
// ---------------------------------------------------------------------------

/** One `actual` vs `expected` numeric comparison, checked against the 0.01% bar. */
export interface KnownAnswerCheck {
  readonly label: string;
  readonly actual: Decimal;
  readonly expected: Decimal;
}

/**
 * One documented known-answer case. `checks()` recomputes the actuals with the
 * real engine on every call (pure, no I/O); the release gate asserts each
 * returned `actual` is {@link withinTolerance} of its `expected`. `derivation`
 * carries the hand calculation as prose so the documentation lives with the
 * numbers (NFR-4).
 */
export interface KnownAnswerCase {
  readonly id: string;
  /** The acceptance criterion / architecture rule this case pins. */
  readonly ac: string;
  readonly title: string;
  readonly derivation: string;
  readonly checks: () => readonly KnownAnswerCheck[];
}

const d = (s: string): Decimal => new Decimal(s);

// ---------------------------------------------------------------------------
// Shared builders (also re-used by the per-engine test files).
// ---------------------------------------------------------------------------

/** A single-instrument acquisition in a given native currency (default USD). */
export function buy(args: {
  instrumentId?: string;
  tradeDate: string;
  seq: bigint;
  quantity: string;
  unitPrice: string;
  fxRate: string;
  txnCurrency?: string;
  fee?: { amount: string; fxRate: string; currency: string };
}): PositionTxn {
  return {
    kind: "ACQUISITION",
    instrumentId: args.instrumentId ?? "INST",
    tradeDate: args.tradeDate,
    seq: args.seq,
    quantity: d(args.quantity),
    unitPrice: d(args.unitPrice),
    fxRate: d(args.fxRate),
    txnCurrency: args.txnCurrency ?? "USD",
    ...(args.fee
      ? {
          fee: {
            amount: d(args.fee.amount),
            fxRate: d(args.fee.fxRate),
            currency: args.fee.currency,
          },
        }
      : {}),
  };
}

/** A disposal, optionally carrying a fee leg or the crypto-settlement marker. */
export function sell(args: {
  instrumentId?: string;
  tradeDate: string;
  seq: bigint;
  quantity: string;
  unitPrice: string;
  fxRate: string;
  txnCurrency?: string;
  fee?: { amount: string; fxRate: string; currency: string };
  settlement?: boolean;
}): PositionTxn {
  return {
    kind: "DISPOSAL",
    instrumentId: args.instrumentId ?? "INST",
    tradeDate: args.tradeDate,
    seq: args.seq,
    quantity: d(args.quantity),
    unitPrice: d(args.unitPrice),
    fxRate: d(args.fxRate),
    txnCurrency: args.txnCurrency ?? "USD",
    ...(args.fee
      ? {
          fee: {
            amount: d(args.fee.amount),
            fxRate: d(args.fee.fxRate),
            currency: args.fee.currency,
          },
        }
      : {}),
    ...(args.settlement === true ? { settlement: true } : {}),
  };
}

export const valuation = (date: string, value: string): Valuation => ({ date, value: d(value) });
export const twrFlow = (
  date: string,
  amount: string,
  flowClass: TwrFlow["flowClass"],
): TwrFlow => ({ date, amount: d(amount), flowClass });
export const xirrFlow = (date: string, amount: string): XirrFlow => ({ date, amount: d(amount) });
export const terminalValue = (date: string, value: string): TerminalValue => ({
  date,
  value: d(value),
});
export const holding = (instrumentId: string, quantity: string): HoldingState => ({
  instrumentId,
  quantity: d(quantity),
  // Cost-basis fields are irrelevant to mark-to-market valuation; plausible zeros.
  costBasisBase: d("0"),
  pmpUnitBase: d("0"),
  costBasisNative: d("0"),
  pmpUnitNative: d("0"),
  nativeCurrencyMixed: false,
});

// ===========================================================================
// CASE 1 — Weighted-average PMP sequence (AC19, FR-27, FR-61).
// ===========================================================================

/**
 * A documented, hand-calculated sequence of buys of a **USD-denominated**
 * instrument at different prices and different stored FX rates, in a EUR-base
 * portfolio, then a partial sale. Exercises AC19 (weighted-average PMP), FR-61
 * (EUR PMP derived from the per-transaction stored rate), and the rule that
 * PMP per unit is unchanged by a sale. This is the single copy of the sequence that
 * both `pmp.test.ts` and `realized-gains.test.ts` (Case 2) consume.
 *
 *   Buy 1: 10 @ 100 USD, fx 0.90
 *     cost_base   = 10×100×0.90 = 900   (running 900)
 *     cost_native = 10×100      = 1000  (running 1000)
 *     qty 10 · pmp_base 900/10 = 90 · pmp_native 1000/10 = 100
 *   Buy 2: 10 @ 120 USD, fx 0.80
 *     cost_base   += 10×120×0.80 = 960  → 1860
 *     cost_native += 10×120      = 1200 → 2200
 *     qty 20 · pmp_base 1860/20 = 93 · pmp_native 2200/20 = 110
 *   Buy 3: 20 @ 90 USD, fx 0.95
 *     cost_base   += 20×90×0.95 = 1710  → 3570
 *     cost_native += 20×90      = 1800  → 4000
 *     qty 40 · pmp_base 3570/40 = 89.25 · pmp_native 4000/40 = 100
 *   Sell: 10 @ 110 USD, fx 0.85  (PMP unchanged by a sale)
 *     pmp_base at sale = 89.25 · cost_base   −= 89.25×10 = 892.5 → 2677.5
 *     pmp_native at sale = 100 · cost_native −= 100×10   = 1000  → 3000
 *     qty 30 · pmp_base 2677.5/30 = 89.25 · pmp_native 3000/30 = 100
 */
export const PMP_FX_SEQUENCE: readonly PositionTxn[] = [
  buy({ tradeDate: "2024-01-02", seq: 1n, quantity: "10", unitPrice: "100", fxRate: "0.90" }),
  buy({ tradeDate: "2024-02-05", seq: 2n, quantity: "10", unitPrice: "120", fxRate: "0.80" }),
  buy({ tradeDate: "2024-03-11", seq: 3n, quantity: "20", unitPrice: "90", fxRate: "0.95" }),
  sell({ tradeDate: "2024-04-09", seq: 4n, quantity: "10", unitPrice: "110", fxRate: "0.85" }),
];

/** Expected running EUR PMP after each of the three acquisitions. */
export const PMP_FX_EXPECTED_PMP_BASE_AFTER_EACH_BUY = ["90", "93", "89.25"] as const;

/** Expected final holding after the partial sale. */
export const PMP_FX_EXPECTED_FINAL_HOLDING = {
  quantity: "30",
  costBasisBase: "2677.5",
  pmpUnitBase: "89.25",
  costBasisNative: "3000",
  pmpUnitNative: "100",
} as const;

/** Expected realized gain on the sale (Case 2 / AC20). */
export const PMP_FX_EXPECTED_REALIZED = {
  quantitySold: "10",
  gainBase: "42.5",
  gainNative: "100",
  fxComponentBase: "-46.75",
  /** Weighted-average acquisition rate implied by the two cost bases. */
  acqRate: "0.8925",
} as const;

const pmpCase: KnownAnswerCase = {
  id: "pmp-weighted-average",
  ac: "AC19",
  title: "Weighted-average PMP over three buys of a USD instrument, then a partial sale",
  derivation:
    "Buy 10@100 fx0.90 → pmp 90; buy 10@120 fx0.80 → pmp 93; buy 20@90 fx0.95 → pmp 89.25; " +
    "sell 10@110 fx0.85 leaves pmp 89.25 (unchanged by a sale), qty 30, cost_base 2677.5.",
  checks() {
    const timeline = replayPositions(PMP_FX_SEQUENCE);
    const acquisitions = timeline.filter((e) => e.txn.kind === "ACQUISITION");
    const checks: KnownAnswerCheck[] = acquisitions.map((event, i) => ({
      label: `pmp_base after buy ${i + 1}`,
      actual: event.after.costBasisBase.dividedBy(event.after.quantity),
      expected: d(PMP_FX_EXPECTED_PMP_BASE_AFTER_EACH_BUY[i]!),
    }));
    const h = computePmp(timeline)[0]!;
    checks.push(
      {
        label: "final quantity",
        actual: h.quantity,
        expected: d(PMP_FX_EXPECTED_FINAL_HOLDING.quantity),
      },
      {
        label: "final cost_basis_base",
        actual: h.costBasisBase,
        expected: d(PMP_FX_EXPECTED_FINAL_HOLDING.costBasisBase),
      },
      {
        label: "final pmp_unit_base",
        actual: h.pmpUnitBase,
        expected: d(PMP_FX_EXPECTED_FINAL_HOLDING.pmpUnitBase),
      },
      {
        label: "final cost_basis_native",
        actual: h.costBasisNative,
        expected: d(PMP_FX_EXPECTED_FINAL_HOLDING.costBasisNative),
      },
      {
        label: "final pmp_unit_native",
        actual: h.pmpUnitNative,
        expected: d(PMP_FX_EXPECTED_FINAL_HOLDING.pmpUnitNative),
      },
    );
    return checks;
  },
};

// ===========================================================================
// CASE 2 — Realized gain on a sale (AC20, FR-28, FR-30).
// ===========================================================================

/**
 * The realized gain on the sale of {@link PMP_FX_SEQUENCE} — same sequence, so
 * the PMP-at-sale is the one already hand-verified above.
 *
 *   pmp_base at sale   = 3570 / 40 = 89.25
 *   acq_rate           = 3570 / 4000 = 0.8925   (weighted-avg acquisition rate)
 *   Sell 10 @ 110 USD, fx 0.85:
 *     proceeds_native = 10 × 110       = 1100
 *     proceeds_base   = 1100 × 0.85    = 935
 *     gain_base       = 935 − 89.25×10 = 42.5
 *     gain_native     = 1100 − 100×10  = 100
 *     fx_component    = 42.5 − 100×0.8925 = −46.75
 *       (the USD fell from the 0.8925 average acquisition rate to 0.85 at sale,
 *        an FX loss of 46.75 offsetting an 89.25 EUR asset gain — the two sum to
 *        the 42.5 total, which is the whole point of FR-30's separate FX line)
 */
const realizedGainCase: KnownAnswerCase = {
  id: "realized-gain",
  ac: "AC20",
  title: "Realized gain = proceeds − PMP × qty_sold, with a separate FX line (FR-30)",
  derivation:
    "Sell 10@110 fx0.85 against pmp 89.25: proceeds_base 935, gain_base 42.5, gain_native 100, " +
    "fx_component 42.5 − 100×0.8925 = −46.75 (asset gain 89.25 EUR + FX loss 46.75 = 42.5).",
  checks() {
    const g = computeRealizedGains(replayPositions(PMP_FX_SEQUENCE))[0]!;
    return [
      {
        label: "quantity_sold",
        actual: g.quantitySold,
        expected: d(PMP_FX_EXPECTED_REALIZED.quantitySold),
      },
      { label: "gain_base", actual: g.gainBase, expected: d(PMP_FX_EXPECTED_REALIZED.gainBase) },
      {
        label: "gain_native",
        actual: g.gainNative,
        expected: d(PMP_FX_EXPECTED_REALIZED.gainNative),
      },
      {
        label: "fx_component_base",
        actual: g.fxComponentBase,
        expected: d(PMP_FX_EXPECTED_REALIZED.fxComponentBase),
      },
    ];
  },
};

// ===========================================================================
// CASE 3 — FX attribution over a range (AC21, FR-30).
// ===========================================================================

/**
 * A non-EUR (USD) holding with a documented FX rate history, no flows, so the
 * whole base return is the start-to-end value change. Pins the *convention*:
 * the native return is converted at the **opening** rate
 * 0.90, not the closing 0.85.
 *
 *   V_native(start) 1000 USD, rate(start) 0.90 → V_base(start) 900
 *   V_native(end)   1200 USD, rate(end)   0.85 → V_base(end)   1020
 *   total_base_return = 1020 − 900 − 0           = 120
 *   asset_return_base = (1200 − 1000 − 0) × 0.90 = 180   (opening rate — closing
 *                                                          would give 170)
 *   fx_return_base    = 120 − 180                = −60
 */
export const FX_ATTRIBUTION_INPUT: FxAttributionInput = {
  valueBaseStart: d("900"),
  valueBaseEnd: d("1020"),
  valueNativeStart: d("1000"),
  valueNativeEnd: d("1200"),
  flowsBase: d("0"),
  flowsNative: d("0"),
  rateStart: d("0.90"),
};

export const FX_ATTRIBUTION_EXPECTED = {
  totalBaseReturn: "120",
  assetReturnBase: "180",
  fxReturnBase: "-60",
} as const;

const fxAttributionCase: KnownAnswerCase = {
  id: "fx-attribution",
  ac: "AC21",
  title: "FX attribution: native return at the opening rate, residual to FX",
  derivation:
    "V_base 900→1020 (total 120); asset = (1200−1000)×0.90 = 180 at the opening rate (closing " +
    "0.85 would give 170); fx = 120 − 180 = −60; asset + fx = total, exactly.",
  checks() {
    const a = attributeFx(FX_ATTRIBUTION_INPUT);
    return [
      {
        label: "total_base_return",
        actual: a.totalBaseReturn,
        expected: d(FX_ATTRIBUTION_EXPECTED.totalBaseReturn),
      },
      {
        label: "asset_return_base",
        actual: a.assetReturnBase,
        expected: d(FX_ATTRIBUTION_EXPECTED.assetReturnBase),
      },
      {
        label: "fx_return_base",
        actual: a.fxReturnBase,
        expected: d(FX_ATTRIBUTION_EXPECTED.fxReturnBase),
      },
    ];
  },
};

// ===========================================================================
// CASE 4 — Crypto-to-crypto settlement (AC52, FR-66).
// ===========================================================================

/**
 * The disposed-BTC leg of "buy 2 ETH paying 0.1 BTC" (FR-66/AC52). BTC is a
 * self-quoted asset (native amount IS its quantity, unit price 1), so the whole
 * EUR gain is the FX/price line and the native gain is exactly zero.
 *
 *   Acquire 1 BTC, rate 40000 → cost_native 1, cost_base 40000, pmp_base 40000
 *   Dispose 0.1 BTC, rate 60000:
 *     proceeds_base = 0.1 × 60000     = 6000
 *     gain_base     = 6000 − 40000×0.1 = 2000   ← against BTC's PMP
 *     gain_native   = 0.1 − 1×0.1      = 0
 *     fx_component  = 2000 − 0×40000   = 2000    (all FX/price)
 *
 * Both legs here are hand-built in the settlement asset's own symbol — a shape
 * `ledger/src/position-replay.ts` never emits (a real acquisition of BTC is in
 * fiat, and its paid-with disposal carries the `settlement` marker). It is kept
 * as the self-quoted arithmetic case; the real projection shape is pinned by
 * CASE 4b below.
 */
export const CRYPTO_SETTLEMENT_INSTRUMENT = "00000000-0000-7000-8000-000000210002";
export const CRYPTO_SETTLEMENT_LEGS: readonly PositionTxn[] = [
  buy({
    instrumentId: CRYPTO_SETTLEMENT_INSTRUMENT,
    tradeDate: "2024-01-10",
    seq: 1n,
    quantity: "1",
    unitPrice: "1",
    fxRate: "40000",
    txnCurrency: "BTC",
  }),
  sell({
    instrumentId: CRYPTO_SETTLEMENT_INSTRUMENT,
    tradeDate: "2024-06-15",
    seq: 2n,
    quantity: "0.1",
    unitPrice: "1",
    fxRate: "60000",
    txnCurrency: "BTC",
  }),
];

export const CRYPTO_SETTLEMENT_EXPECTED = {
  quantitySold: "0.1",
  gainBase: "2000",
  gainNative: "0",
  fxComponentBase: "2000",
} as const;

const cryptoSettlementCase: KnownAnswerCase = {
  id: "crypto-settlement",
  ac: "AC52",
  title: "Realized gain on the disposed BTC of a crypto-to-crypto trade, against BTC's PMP",
  derivation:
    "Acquire 1 BTC @ rate 40000 (pmp 40000); dispose 0.1 BTC @ rate 60000: gain_base " +
    "6000 − 4000 = 2000, gain_native 0 (self-quoted), fx_component 2000 (all price/FX).",
  checks() {
    const g = computeRealizedGains(replayPositions(CRYPTO_SETTLEMENT_LEGS))[0]!;
    return [
      {
        label: "quantity_sold",
        actual: g.quantitySold,
        expected: d(CRYPTO_SETTLEMENT_EXPECTED.quantitySold),
      },
      { label: "gain_base", actual: g.gainBase, expected: d(CRYPTO_SETTLEMENT_EXPECTED.gainBase) },
      {
        label: "gain_native",
        actual: g.gainNative,
        expected: d(CRYPTO_SETTLEMENT_EXPECTED.gainNative),
      },
      {
        label: "fx_component_base",
        actual: g.fxComponentBase,
        expected: d(CRYPTO_SETTLEMENT_EXPECTED.fxComponentBase),
      },
    ];
  },
};

// ===========================================================================
// CASE 4b — A settlement leg beside ordinary fiat SELLs, in the real
// projection shape (AC52/FR-66).
// ===========================================================================

/**
 * BTC bought in USD, then 0.1 BTC spent paying for another asset, then 0.5 BTC
 * sold for USD. The movements are exactly what `ledger/src/position-replay.ts`
 * emits: a fiat USD `ACQUISITION`; the paid-with leg of the crypto-settled BUY
 * as a `DISPOSAL` with `txnCurrency` = the BTC symbol, `unitPrice` 1,
 * `quantity` = the gross BTC amount, `fxRate` = the stored BTC → EUR rate, and
 * `settlement: true`; and a plain fiat `DISPOSAL`.
 *
 * The settlement leg is exempt from the instrument's gain-currency resolution
 * (an owner decision), so the fiat SELL keeps its USD figures and
 * the settlement leg alone is base-collapsed.
 *
 *   Buy 1 BTC @ 40000 USD, rate 0.9:
 *     cost_native = 40000 USD, cost_base = 36000 EUR, pmp_base = 36000
 *   Settlement disposal 0.1 BTC, unit price 1, rate 55000 (BTC → EUR):
 *     proceeds_base = 0.1 × 1 × 55000   = 5500
 *     gain_base     = 5500 − 36000 × 0.1 = 1900
 *     gain_native   = gain_base          = 1900   (no trade currency: base-collapsed)
 *     fx_component  = 0
 *     after: qty 0.9, cost_base 32400, cost_native 36000
 *   SELL 0.5 @ 50000 USD, rate 0.95:
 *     proceeds_native = 0.5 × 50000        = 25000
 *     proceeds_base   = 25000 × 0.95       = 23750
 *     gain_base       = 23750 − 36000 × 0.5 = 5750
 *     gain_native     = 25000 − 40000 × 0.5 = 5000 USD
 *     acq_rate        = 32400 / 36000      = 0.9
 *     fx_component    = 5750 − 5000 × 0.9  = 1250
 */
const SETTLEMENT_LEG_INSTRUMENT = "00000000-0000-7000-8000-000000210004";
export const SETTLEMENT_LEG_MOVEMENTS: readonly PositionTxn[] = [
  buy({
    instrumentId: SETTLEMENT_LEG_INSTRUMENT,
    tradeDate: "2024-01-10",
    seq: 1n,
    quantity: "1",
    unitPrice: "40000",
    fxRate: "0.9",
    txnCurrency: "USD",
  }),
  sell({
    instrumentId: SETTLEMENT_LEG_INSTRUMENT,
    tradeDate: "2024-03-15",
    seq: 2n,
    quantity: "0.1",
    unitPrice: "1",
    fxRate: "55000",
    txnCurrency: "BTC",
    settlement: true,
  }),
  sell({
    instrumentId: SETTLEMENT_LEG_INSTRUMENT,
    tradeDate: "2024-06-15",
    seq: 3n,
    quantity: "0.5",
    unitPrice: "50000",
    fxRate: "0.95",
    txnCurrency: "USD",
  }),
];

export const SETTLEMENT_LEG_EXPECTED = {
  settlement: { gainBase: "1900", gainNative: "1900", fxComponentBase: "0" },
  sell: { gainBase: "5750", gainNative: "5000", fxComponentBase: "1250" },
} as const;

const settlementLegCase: KnownAnswerCase = {
  id: "settlement-leg-beside-fiat-sell",
  ac: "AC52",
  title:
    "A crypto-settlement leg is base-collapsed on its own; the fiat SELL keeps its USD figures",
  derivation:
    "Buy 1 BTC @ 40000 USD rate 0.9 (pmp_base 36000); settlement disposal 0.1 BTC @ rate 55000: " +
    "gain_base 5500 − 3600 = 1900 = gain_native, fx 0; SELL 0.5 @ 50000 USD rate 0.95: gain_base " +
    "23750 − 18000 = 5750, gain_native 25000 − 20000 = 5000, fx 5750 − 5000 × 0.9 = 1250.",
  checks() {
    const [settlement, fiatSell] = computeRealizedGains(replayPositions(SETTLEMENT_LEG_MOVEMENTS));
    const e = SETTLEMENT_LEG_EXPECTED;
    return [
      {
        label: "settlement gain_base",
        actual: settlement!.gainBase,
        expected: d(e.settlement.gainBase),
      },
      {
        label: "settlement gain_native",
        actual: settlement!.gainNative,
        expected: d(e.settlement.gainNative),
      },
      {
        label: "settlement fx_component_base",
        actual: settlement!.fxComponentBase,
        expected: d(e.settlement.fxComponentBase),
      },
      { label: "sell gain_base", actual: fiatSell!.gainBase, expected: d(e.sell.gainBase) },
      { label: "sell gain_native", actual: fiatSell!.gainNative, expected: d(e.sell.gainNative) },
      {
        label: "sell fx_component_base",
        actual: fiatSell!.fxComponentBase,
        expected: d(e.sell.fxComponentBase),
      },
    ];
  },
};

// ===========================================================================
// CASE 5 — Single buy / single sell: TWR == MWR (AC17, FR-25, FR-26).
// ===========================================================================

/**
 * A 10 000 opening deposit funds a buy on 2024-01-01; the position is sold for
 * 11 000 on 2024-12-31 (exactly 365 days — 2024 is a leap year). With no interim
 * external flows and a full-year span, the time-weighted and money-weighted
 * returns must **coincide** at 0.10, computed by the two independent engines.
 *
 *   TWR: one sub-period, r = 11000 / (0 + 10000) − 1 = 0.10.
 *   MWR: −10000 + 11000/(1+r)^(365/365) = 0 ⇒ 1+r = 1.1 ⇒ r = 0.10 (exact).
 */
export const AC17_TWR_SERIES: readonly Valuation[] = [
  valuation("2024-01-01", "0"),
  valuation("2024-12-31", "11000"),
];
export const AC17_TWR_FLOWS: readonly TwrFlow[] = [twrFlow("2024-01-01", "10000", "EXTERNAL")];
export const AC17_MWR_FLOWS: readonly XirrFlow[] = [xirrFlow("2024-01-01", "-10000")];
export const AC17_MWR_TERMINAL: TerminalValue = terminalValue("2024-12-31", "11000");
export const AC17_EXPECTED_RETURN = "0.10";

const twrAc17Case: KnownAnswerCase = {
  id: "twr-single-buy-sell",
  ac: "AC17",
  title: "TWR of a single buy/single sell, no interim flows",
  derivation: "One sub-period: 11000 / (0 + 10000) − 1 = 0.10.",
  checks() {
    const r = computeTwr(AC17_TWR_SERIES, AC17_TWR_FLOWS);
    return [{ label: "cumulative TWR", actual: r.cumulative, expected: d(AC17_EXPECTED_RETURN) }];
  },
};

const mwrAc17Case: KnownAnswerCase = {
  id: "mwr-single-buy-sell",
  ac: "AC17",
  title: "MWR of a single buy/single sell equals the TWR (0.10), computed independently",
  derivation:
    "−10000 + 11000/(1+r)^(365/365) = 0 ⇒ r = 0.10; equals the TWR for this no-interim case.",
  checks() {
    const x = computeXirr(AC17_MWR_FLOWS, AC17_MWR_TERMINAL);
    if (!x.converged) throw new Error("AC17 MWR must converge");
    return [{ label: "MWR rate", actual: x.rate, expected: d(AC17_EXPECTED_RETURN) }];
  },
};

// ===========================================================================
// CASE 6 — Interim deposit: TWR and MWR diverge (AC18, FR-33).
// ===========================================================================

/**
 * Deposits of 1 000 (01-01) then 500 (03-01); portfolio worth 1 900 on 06-01.
 * A rebalancing trade (INTERNAL, 01-15) and a dividend (INCOME, 02-01) are
 * present in the flow list but must **not** split a sub-period — only the two
 * EXTERNAL deposits do. TWR and MWR must **diverge** (proving they are computed
 * independently, not one derived from the other).
 *
 *   TWR — split ONLY at the two EXTERNAL deposits:
 *     SP1 [01-01 → 03-01]: 1200 / (0 + 1000)  = 1.20
 *     SP2 [03-01 → 06-01]: 1900 / (1200 + 500) = 1900/1700
 *     TWR = 1.20 × 1900/1700 − 1 = 0.341176470588235294117647058823529
 *   MWR — ACT/365F day counts from 01-01 (t = 0, 60/365, 152/365):
 *     −1000 − 500/(1+r)^(60/365) + 1900/(1+r)^(152/365) = 0
 *     r = 0.9158930837424906365196718479788190852865  (annualised)
 *     de-annualised over the 152-day range:
 *       (1 + r)^(152/365) − 1 = 0.310962374607095127964094176135225548626
 *   0.310962… < 0.341176…: money-weighting drags the return DOWN because more
 *   capital (1 700) was held during the weaker sub-period. The two are not the
 *   same number, by ~8.9% relative — the whole point of AC18.
 */
export const AC18_TWR_SERIES: readonly Valuation[] = [
  valuation("2024-01-01", "0"),
  valuation("2024-01-15", "1100"), // trade date — present, must NOT be a boundary
  valuation("2024-02-01", "1150"), // dividend date — present, must NOT be a boundary
  valuation("2024-03-01", "1200"),
  valuation("2024-06-01", "1900"),
];
export const AC18_TWR_FLOWS: readonly TwrFlow[] = [
  twrFlow("2024-01-01", "1000", "EXTERNAL"),
  twrFlow("2024-01-15", "0", "INTERNAL"),
  twrFlow("2024-02-01", "30", "INCOME"),
  twrFlow("2024-03-01", "500", "EXTERNAL"),
];
export const AC18_MWR_FLOWS: readonly XirrFlow[] = [
  xirrFlow("2024-01-01", "-1000"),
  xirrFlow("2024-03-01", "-500"),
];
export const AC18_MWR_TERMINAL: TerminalValue = terminalValue("2024-06-01", "1900");
export const AC18_EXPECTED_TWR_CUMULATIVE = "0.341176470588235294117647058823529";
export const AC18_EXPECTED_MWR_RATE = "0.9158930837424906365196718479788190852865";
export const AC18_EXPECTED_MWR_OVER_RANGE = "0.310962374607095127964094176135225548626";

const twrAc18Case: KnownAnswerCase = {
  id: "twr-interim-deposit",
  ac: "AC18",
  title: "TWR with an interim deposit — splits only at the two EXTERNAL deposits",
  derivation:
    "SP1 1200/(0+1000)=1.20; SP2 1900/(1200+500)=1900/1700; TWR = 1.20×1900/1700 − 1 = " +
    "0.341176470588235294117647058823529. INCOME/INTERNAL flows do not split.",
  checks() {
    const r = computeTwr(AC18_TWR_SERIES, AC18_TWR_FLOWS);
    return [
      { label: "cumulative TWR", actual: r.cumulative, expected: d(AC18_EXPECTED_TWR_CUMULATIVE) },
    ];
  },
};

const mwrAc18Case: KnownAnswerCase = {
  id: "mwr-interim-deposit",
  ac: "AC18",
  title: "MWR with an interim deposit — diverges from the TWR (independent computation)",
  derivation:
    "−1000 − 500/(1+r)^(60/365) + 1900/(1+r)^(152/365) = 0 ⇒ r = 0.915893…; de-annualised over " +
    "152 days = 0.310962… < TWR 0.341176…, a ~8.9% relative gap.",
  checks() {
    const x = computeXirr(AC18_MWR_FLOWS, AC18_MWR_TERMINAL);
    if (!x.converged) throw new Error("AC18 MWR must converge");
    const overRange = x.rate.plus(1).pow(new Decimal(152).dividedBy(365)).minus(1);
    return [
      { label: "annualised MWR rate", actual: x.rate, expected: d(AC18_EXPECTED_MWR_RATE) },
      {
        label: "MWR de-annualised over 152 days",
        actual: overRange,
        expected: d(AC18_EXPECTED_MWR_OVER_RANGE),
      },
    ];
  },
};

// ===========================================================================
// CASE 7 — Multiple-root XIRR (R5, AC3).
// ===========================================================================

/**
 * A constructed sign-change sequence with **two** genuine mathematical roots.
 * Dates are exactly 365 days apart each step (t = 0, 1, 2):
 *   NPV(r) = −1000 + 2300·u − 1312.5·u², u = 1/(1+r)
 *          ⇒ x² − 2.3x + 1.3125 = 0, x = 1+r ⇒ x ∈ {1.05, 1.25}
 * Two roots: r = 0.05 AND r = 0.25. R5 forbids returning a *wrong* value; the
 * solver is deterministic (Newton seeded at 0.10 converges to the nearer root,
 * 0.05). The gate pins 0.05; a value near 0.25 or between the two would fail.
 */
export const MULTIPLE_ROOT_FLOWS: readonly XirrFlow[] = [
  xirrFlow("2023-01-01", "-1000"),
  xirrFlow("2024-01-01", "2300"),
  xirrFlow("2024-12-31", "-1312.5"),
];
export const MULTIPLE_ROOT_TERMINAL: TerminalValue = terminalValue("2024-12-31", "0");
export const MULTIPLE_ROOT_EXPECTED_RATE = "0.05";
/** The *other* real root — must NOT be what the solver returns. */
export const MULTIPLE_ROOT_OTHER_ROOT = "0.25";

const multipleRootCase: KnownAnswerCase = {
  id: "xirr-multiple-root",
  ac: "R5",
  title: "Multiple-root XIRR returns the documented deterministic root (0.05), never 0.25",
  derivation:
    "x² − 2.3x + 1.3125 = 0 ⇒ x ∈ {1.05, 1.25} ⇒ r ∈ {0.05, 0.25}. Newton seeded at 0.10 " +
    "converges to the nearer genuine root 0.05.",
  checks() {
    const x = computeXirr(MULTIPLE_ROOT_FLOWS, MULTIPLE_ROOT_TERMINAL);
    if (!x.converged) throw new Error("multiple-root case must converge to a genuine root");
    return [{ label: "solved root", actual: x.rate, expected: d(MULTIPLE_ROOT_EXPECTED_RATE) }];
  },
};

// ===========================================================================
// CASE 8 — Day-count-sensitive ACT/365F (AC4).
// ===========================================================================

/**
 * A 182-day span (2024-01-01 → 2024-07-01, a leap year) where the day-count
 * basis moves the annualised rate materially:
 *   ACT/365F: (1+r)^(182/365) = 1.2 ⇒ r = 0.4414432669733904275119054168628645487158
 *   ACT/360 : (1+r)^(182/360) = 1.2 ⇒ r = 0.4342413685743389993844930379311556109631  (−1.6%)
 * The 1.6% gap is ~160× the 0.01% bar, so pinning the ACT/365F value fails
 * outright against an ACT/360 (or 30/360) implementation.
 */
export const DAY_COUNT_FLOWS: readonly XirrFlow[] = [xirrFlow("2024-01-01", "-1000")];
export const DAY_COUNT_TERMINAL: TerminalValue = terminalValue("2024-07-01", "1200");
export const DAY_COUNT_EXPECTED_ACT365F = "0.4414432669733904275119054168628645487158";
/** The ACT/360 value — must be OUTSIDE tolerance (i.e. the divisor is not 360). */
export const DAY_COUNT_ACT360 = "0.4342413685743389993844930379311556109631";

const dayCountCase: KnownAnswerCase = {
  id: "xirr-day-count-act365f",
  ac: "AC4",
  title: "XIRR day count is ACT/365F, not ACT/360 or 30/360",
  derivation:
    "(1+r)^(182/365) = 1.2 ⇒ r = 0.4414432…; ACT/360 would give 0.4342413… (−1.6%, ~160× the bar).",
  checks() {
    const x = computeXirr(DAY_COUNT_FLOWS, DAY_COUNT_TERMINAL);
    if (!x.converged) throw new Error("day-count case must converge");
    return [{ label: "ACT/365F rate", actual: x.rate, expected: d(DAY_COUNT_EXPECTED_ACT365F) }];
  },
};

// ===========================================================================
// CASE 9 — Portfolio valuation, non-EUR total (AC21 valuation half, FR-29).
// ===========================================================================

/**
 * Two holdings — one USD, one EUR — valued on Friday 2026-03-13.
 *   AAPL: 10 × $185.00 = $1,850.00 native; × 0.92 USD/EUR = €1,702.00 base
 *   TTE : 20 × €62.50  = €1,250.00 native; × 1 (EUR)      = €1,250.00 base
 *   total = 1,702.00 + 1,250.00 = €2,952.00
 */
export const VALUATION_STATE: readonly HoldingState[] = [
  holding("AAPL", "10"),
  holding("TTE", "20"),
];
export const VALUATION_PRICES: readonly PricePoint[] = [
  {
    instrumentId: "AAPL",
    observedOn: "2026-03-13",
    price: d("185.00"),
    currency: "USD",
    sourceKey: "provider",
    origin: "DAILY",
  },
  {
    instrumentId: "TTE",
    observedOn: "2026-03-13",
    price: d("62.50"),
    currency: "EUR",
    sourceKey: "provider",
    origin: "DAILY",
  },
];
export const VALUATION_FX: readonly FxRatePoint[] = [
  { currency: "USD", observedOn: "2026-03-13", rate: d("0.92") },
];
export const VALUATION_DATE = "2026-03-13";
export const VALUATION_EXPECTED = {
  totalValueBase: "2952.00",
  aaplValueBase: "1702.00",
  tteValueBase: "1250.00",
} as const;

const valuationCase: KnownAnswerCase = {
  id: "valuation-non-eur-total",
  ac: "AC21",
  title: "Portfolio value in EUR = Σ (native value × valuation-date FX rate)",
  derivation: "AAPL 10×185×0.92 = 1702; TTE 20×62.50×1 = 1250; total 2952.00.",
  checks() {
    const r = valuePortfolio(
      VALUATION_STATE,
      VALUATION_PRICES,
      VALUATION_FX,
      VALUATION_DATE,
      "EUR",
    );
    const aapl = r.holdings.find((h) => h.instrumentId === "AAPL")!;
    const tte = r.holdings.find((h) => h.instrumentId === "TTE")!;
    return [
      {
        label: "total_value_base",
        actual: r.totalValueBase,
        expected: d(VALUATION_EXPECTED.totalValueBase),
      },
      {
        label: "AAPL value_base",
        actual: aapl.valueBase,
        expected: d(VALUATION_EXPECTED.aaplValueBase),
      },
      {
        label: "TTE value_base",
        actual: tte.valueBase,
        expected: d(VALUATION_EXPECTED.tteValueBase),
      },
    ];
  },
};

// ===========================================================================
// CASE 10/11 — FX-direction guard: a EUR-quoted and a USD-quoted case whose
// expected values differ by MORE THAN a factor of two, so an inverted FX rate
// cannot pass the suite (R12).
// ===========================================================================

/**
 * The canonical convention is `amount_base = amount_native × rate`. These
 * two cases hold the SAME native value (1000) and differ only in the FX
 * direction, so a single global rate inversion cannot satisfy both:
 *
 *   EUR-quoted: 100 × €10.00 = €1,000 native; rate 1 (base)      → €1,000 base
 *   USD-quoted: 100 × $10.00 = $1,000 native; rate 0.40 USD/EUR  → €400 base
 *
 * The two documented expected values, 1000 and 400, differ by a factor of 2.5
 * (> 2). If the engine inverted the USD rate (used 1/0.40 = 2.5 instead of
 * 0.40), the USD case would compute €2,500 — nowhere near the documented €400 —
 * so the gate catches the inversion. The >2× separation is asserted directly in
 * the suite so the fixture cannot silently drift to a pair an inversion could
 * pass.
 */
export const FX_DIRECTION_EUR_STATE: readonly HoldingState[] = [holding("EUR-STOCK", "100")];
export const FX_DIRECTION_EUR_PRICES: readonly PricePoint[] = [
  {
    instrumentId: "EUR-STOCK",
    observedOn: "2026-03-13",
    price: d("10.00"),
    currency: "EUR",
    sourceKey: "provider",
    origin: "DAILY",
  },
];
export const FX_DIRECTION_USD_STATE: readonly HoldingState[] = [holding("USD-STOCK", "100")];
export const FX_DIRECTION_USD_PRICES: readonly PricePoint[] = [
  {
    instrumentId: "USD-STOCK",
    observedOn: "2026-03-13",
    price: d("10.00"),
    currency: "USD",
    sourceKey: "provider",
    origin: "DAILY",
  },
];
export const FX_DIRECTION_USD_FX: readonly FxRatePoint[] = [
  { currency: "USD", observedOn: "2026-03-13", rate: d("0.40") },
];
export const FX_DIRECTION_DATE = "2026-03-13";
export const FX_DIRECTION_EUR_EXPECTED = "1000";
export const FX_DIRECTION_USD_EXPECTED = "400";
/** What an inverted USD rate (1/0.40 = 2.5) would wrongly produce. */
export const FX_DIRECTION_USD_IF_INVERTED = "2500";

const fxDirectionEurCase: KnownAnswerCase = {
  id: "fx-direction-eur-quoted",
  ac: "R12",
  title: "FX direction — EUR-quoted holding values to €1,000 (rate 1)",
  derivation: "100 × €10 = €1,000 native; base currency, rate 1 → €1,000 base.",
  checks() {
    const r = valuePortfolio(
      FX_DIRECTION_EUR_STATE,
      FX_DIRECTION_EUR_PRICES,
      [],
      FX_DIRECTION_DATE,
      "EUR",
    );
    return [
      {
        label: "EUR-quoted total_value_base",
        actual: r.totalValueBase,
        expected: d(FX_DIRECTION_EUR_EXPECTED),
      },
    ];
  },
};

const fxDirectionUsdCase: KnownAnswerCase = {
  id: "fx-direction-usd-quoted",
  ac: "R12",
  title: "FX direction — USD-quoted holding values to €400 (rate 0.40), not €2,500 (inverted)",
  derivation:
    "100 × $10 = $1,000 native; × 0.40 USD/EUR = €400 base. An inverted rate (2.5) would give " +
    "€2,500 — caught. €400 vs the EUR case's €1,000 differ by 2.5× (> 2), so no single inversion " +
    "can satisfy both.",
  checks() {
    const r = valuePortfolio(
      FX_DIRECTION_USD_STATE,
      FX_DIRECTION_USD_PRICES,
      FX_DIRECTION_USD_FX,
      FX_DIRECTION_DATE,
      "EUR",
    );
    return [
      {
        label: "USD-quoted total_value_base",
        actual: r.totalValueBase,
        expected: d(FX_DIRECTION_USD_EXPECTED),
      },
    ];
  },
};

// ===========================================================================
// CASE 12–14 — Interest earned on cash (cash-interest AC-514, AC-515, AC-516;
// FR-627, FR-630, FR-631).
// ===========================================================================

/**
 * One cash event as the ledger records it: a kind, a date, and the amount in
 * the direction it moves the portfolio's cash (into the portfolio positive).
 * The fixtures below never hand-pick a flow class: every flow is classified by
 * {@link classifyFlows}, exactly as `transaction_posting.flow_class` is, so a
 * mis-classified `INTEREST` moves these expected values rather than hiding.
 */
interface CashEvent {
  readonly kind: TransactionKind;
  readonly date: string;
  readonly amount: string;
}

/** Every event as a TWR flow, classified; `computeTwr` itself ignores all but `EXTERNAL`. */
function classifiedTwrFlows(events: readonly CashEvent[]): TwrFlow[] {
  return events.map((e) => twrFlow(e.date, e.amount, classifyFlows({ kind: e.kind })));
}

/**
 * The XIRR flow list: only the events {@link classifyFlows} calls `EXTERNAL`,
 * in XIRR's investor-side sign (a deposit is money out of the investor's
 * pocket, so negative — the opposite of {@link TwrFlow}'s convention).
 */
function classifiedXirrFlows(events: readonly CashEvent[]): XirrFlow[] {
  return events
    .filter((e) => classifyFlows({ kind: e.kind }) === "EXTERNAL")
    .map((e) => ({ date: e.date, amount: d(e.amount).negated() }));
}

/**
 * AC-514 — portfolio P: one EUR cash account « Livret », no holdings, a
 * DEPOSIT of 1000 on 2026-01-01, then 10 credited on 2026-07-01.
 *
 * The value series is start-of-day and pre-event (`twr.ts` header; design
 * C-3): an event dated D first shows in `V(D+1)`. So the range ends on
 * **2026-07-02**, not 07-01:
 *
 *   V(2026-01-01) = 0      (before the opening deposit)
 *   V(2026-07-01) = 1000   (the deposit; the 10 is not in yet)
 *   V(2026-07-02) = 1010
 *
 *   INTEREST case — the 10 classifies INCOME, so it opens no sub-period:
 *     boundaries 01-01 → 07-02, one sub-period
 *     r = 1010 / (0 + 1000) − 1 = 0.01           TWR 0.0100, 1 sub-period
 *   DEPOSIT case — the same 10 booked as a DEPOSIT is EXTERNAL and splits:
 *     r1 = 1000 / (0 + 1000) − 1    = 0
 *     r2 = 1010 / (1000 + 10) − 1   = 0
 *     TWR = (1 + 0)(1 + 0) − 1      = 0           TWR 0, 2 sub-periods
 */
const INTEREST_TWR_SERIES: readonly Valuation[] = [
  valuation("2026-01-01", "0"),
  valuation("2026-07-01", "1000"),
  valuation("2026-07-02", "1010"),
];
const INTEREST_TWR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "INTEREST", date: "2026-07-01", amount: "10" },
];
const INTEREST_AS_DEPOSIT_TWR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "DEPOSIT", date: "2026-07-01", amount: "10" },
];

const interestTwrCase: KnownAnswerCase = {
  id: "twr-interest-is-income",
  ac: "AC-514",
  title:
    "TWR of cash interest: INCOME opens no sub-period (1.0000 %), the same credit as a DEPOSIT gives 0",
  derivation:
    "V 01-01 0, 07-01 1000, 07-02 1010 (an event on D shows in V(D+1)). INTEREST is INCOME: one " +
    "sub-period, 1010/(0+1000) − 1 = 0.0100. As a DEPOSIT it is EXTERNAL: 1000/(0+1000) − 1 = 0 " +
    "and 1010/(1000+10) − 1 = 0, TWR 0 over 2 sub-periods.",
  checks() {
    const interest = computeTwr(INTEREST_TWR_SERIES, classifiedTwrFlows(INTEREST_TWR_EVENTS));
    const deposit = computeTwr(
      INTEREST_TWR_SERIES,
      classifiedTwrFlows(INTEREST_AS_DEPOSIT_TWR_EVENTS),
    );
    return [
      { label: "INTEREST cumulative TWR", actual: interest.cumulative, expected: d("0.0100") },
      {
        label: "INTEREST sub-period count",
        actual: new Decimal(interest.subPeriodCount),
        expected: d("1"),
      },
      { label: "DEPOSIT cumulative TWR", actual: deposit.cumulative, expected: d("0") },
      {
        label: "DEPOSIT sub-period count",
        actual: new Decimal(deposit.subPeriodCount),
        expected: d("2"),
      },
    ];
  },
};

/**
 * AC-515 — the same portfolio P over a full year: DEPOSIT 1000 on
 * 2026-01-01, 10 credited on 2026-12-31 (day 364), valued 1010 on 2027-01-01.
 * 2026 is not a leap year, so the terminal is exactly 365 days out (ACT/365F,
 * exponent 1).
 *
 *   INTEREST case — INCOME, so not an external flow:
 *     flows −1000 @ 01-01; terminal +1010 @ 2027-01-01
 *     −1000 + 1010 / (1 + r) = 0  ⇒  r = 0.0100
 *   DEPOSIT case — the 10 is EXTERNAL:
 *     flows −1000 @ 01-01, −10 @ 12-31; terminal +1010 @ 2027-01-01
 *     NPV(0) = −1000 − 10 + 1010 = 0, an exact root ⇒ r = 0
 *     (NPV is strictly decreasing in r for these signs, so 0 is the only root;
 *     `withinTolerance` judges an expected zero absolutely)
 */
const INTEREST_XIRR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "INTEREST", date: "2026-12-31", amount: "10" },
];
const INTEREST_AS_DEPOSIT_XIRR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "DEPOSIT", date: "2026-12-31", amount: "10" },
];
const INTEREST_XIRR_TERMINAL: TerminalValue = terminalValue("2027-01-01", "1010");

const interestXirrCase: KnownAnswerCase = {
  id: "xirr-interest-is-income",
  ac: "AC-515",
  title:
    "XIRR of cash interest: not an external flow (1.0000 %), the same credit as a DEPOSIT gives 0",
  derivation:
    "INTEREST is INCOME, so the only external flow is −1000 @ 2026-01-01: −1000 + 1010/(1+r)^(365/365) " +
    "= 0 ⇒ r = 0.0100. As a DEPOSIT the flows are −1000 and −10 @ 2026-12-31: NPV(0) = −1000 − 10 + " +
    "1010 = 0 ⇒ r = 0.",
  checks() {
    const interest = computeXirr(classifiedXirrFlows(INTEREST_XIRR_EVENTS), INTEREST_XIRR_TERMINAL);
    if (!interest.converged) throw new Error("AC-515 INTEREST XIRR must converge");
    const deposit = computeXirr(
      classifiedXirrFlows(INTEREST_AS_DEPOSIT_XIRR_EVENTS),
      INTEREST_XIRR_TERMINAL,
    );
    if (!deposit.converged) throw new Error("AC-515 DEPOSIT XIRR must converge");
    return [
      { label: "INTEREST XIRR", actual: interest.rate, expected: d("0.0100") },
      { label: "DEPOSIT XIRR", actual: deposit.rate, expected: d("0") },
    ];
  },
};

/**
 * AC-516 — the flow class and sign of each leg of an INTEREST, through
 * {@link classifyFlows}, summed per class:
 *
 *   gross 10.00, no withholding:   PRINCIPAL +10.00 → INCOME
 *     INCOME +10.00 (1 leg) · TAX 0 · EXTERNAL 0 (0 legs)
 *   gross 10.00, withholding 3.00: PRINCIPAL +10.00 → INCOME, WITHHOLDING_TAX −3.00 → TAX
 *     INCOME +10.00 (1 leg) · TAX −3.00 · EXTERNAL 0 (0 legs)
 *
 * An EXTERNAL total of 0 is the point: interest is never a contribution.
 */
interface ClassifiedLeg {
  readonly leg: TransactionLeg;
  readonly amount: string;
}

function interestLegTotals(legs: readonly ClassifiedLeg[]) {
  const total = (cls: string) =>
    legs
      .filter((l) => classifyFlows({ kind: "INTEREST", leg: l.leg }) === cls)
      .reduce((sum, l) => sum.plus(d(l.amount)), new Decimal(0));
  const count = (cls: string) =>
    new Decimal(legs.filter((l) => classifyFlows({ kind: "INTEREST", leg: l.leg }) === cls).length);
  return {
    income: total("INCOME"),
    incomeLegs: count("INCOME"),
    tax: total("TAX"),
    external: total("EXTERNAL"),
    externalLegs: count("EXTERNAL"),
  };
}

const interestFlowClassCase: KnownAnswerCase = {
  id: "flow-class-interest",
  ac: "AC-516",
  title:
    "INTEREST classifies INCOME (+gross) and its withholding TAX (−withholding), never EXTERNAL",
  derivation:
    "Gross 10.00 alone: one INCOME leg +10.00, EXTERNAL 0. Gross 10.00 with withholding 3.00: " +
    "INCOME +10.00 and TAX −3.00, EXTERNAL 0 — the withholding leg is TAX whatever the kind.",
  checks() {
    const plain = interestLegTotals([{ leg: "PRINCIPAL", amount: "10.00" }]);
    const withheld = interestLegTotals([
      { leg: "PRINCIPAL", amount: "10.00" },
      { leg: "WITHHOLDING_TAX", amount: "-3.00" },
    ]);
    return [
      { label: "no withholding: INCOME total", actual: plain.income, expected: d("10.00") },
      { label: "no withholding: INCOME legs", actual: plain.incomeLegs, expected: d("1") },
      { label: "no withholding: TAX total", actual: plain.tax, expected: d("0") },
      { label: "no withholding: EXTERNAL total", actual: plain.external, expected: d("0") },
      { label: "no withholding: EXTERNAL legs", actual: plain.externalLegs, expected: d("0") },
      { label: "withholding: INCOME total", actual: withheld.income, expected: d("10.00") },
      { label: "withholding: INCOME legs", actual: withheld.incomeLegs, expected: d("1") },
      { label: "withholding: TAX total", actual: withheld.tax, expected: d("-3.00") },
      { label: "withholding: EXTERNAL total", actual: withheld.external, expected: d("0") },
      { label: "withholding: EXTERNAL legs", actual: withheld.externalLegs, expected: d("0") },
    ];
  },
};

// ===========================================================================
// CASE 15–17 — A standalone portfolio fee (portfolio-cash AC-563, AC-564,
// AC-565; FR-671, PC-L5).
// ===========================================================================

/**
 * AC-563 — portfolio P: one EUR cash account, a DEPOSIT of 1000 on
 * 2026-01-01, then a 10.00 fee on 2026-07-01. Start-of-day, pre-event series
 * (an event on D first shows in V(D+1)), so the range ENDS on **2026-07-02**
 * (C-1): ending it on 07-01 would hide the fee from V and make the FEE and
 * WITHDRAWAL variants indistinguishable (both read −1 % there).
 *
 *   V(2026-01-01) = 0, V(2026-07-01) = 1000, V(2026-07-02) = 990
 *
 *   FEE case — the 10 classifies FEE, so it opens no sub-period:
 *     one sub-period 01-01 → 07-02: r = 990 / (0 + 1000) − 1 = −0.0100
 *   WITHDRAWAL case — the same 10 booked as a WITHDRAWAL is EXTERNAL:
 *     r1 = 1000 / (0 + 1000) − 1 = 0
 *     r2 = 990 / (1000 − 10) − 1 = 0
 *     TWR = (1 + 0)(1 + 0) − 1 = 0, 2 sub-periods
 */
const FEE_TWR_SERIES: readonly Valuation[] = [
  valuation("2026-01-01", "0"),
  valuation("2026-07-01", "1000"),
  valuation("2026-07-02", "990"),
];
const FEE_TWR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "FEE", date: "2026-07-01", amount: "-10" },
];
const FEE_AS_WITHDRAWAL_TWR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "WITHDRAWAL", date: "2026-07-01", amount: "-10" },
];

const feeTwrCase: KnownAnswerCase = {
  id: "twr-fee-is-leakage",
  ac: "AC-563",
  title:
    "TWR of a portfolio fee: FEE opens no sub-period (−1.0000 %), the same debit as a WITHDRAWAL gives 0",
  derivation:
    "V 01-01 0, 07-01 1000, 07-02 990 (an event on D shows in V(D+1); the range ends 07-02, C-1). " +
    "FEE is not EXTERNAL: one sub-period, 990/(0+1000) − 1 = −0.0100. As a WITHDRAWAL it is " +
    "EXTERNAL: 1000/(0+1000) − 1 = 0 and 990/(1000−10) − 1 = 0, TWR 0 over 2 sub-periods. The " +
    "pair is the assertion: with the range ending 07-01 both would read −1 %.",
  checks() {
    const fee = computeTwr(FEE_TWR_SERIES, classifiedTwrFlows(FEE_TWR_EVENTS));
    const withdrawal = computeTwr(FEE_TWR_SERIES, classifiedTwrFlows(FEE_AS_WITHDRAWAL_TWR_EVENTS));
    return [
      { label: "FEE cumulative TWR", actual: fee.cumulative, expected: d("-0.0100") },
      {
        label: "FEE sub-period count",
        actual: new Decimal(fee.subPeriodCount),
        expected: d("1"),
      },
      { label: "WITHDRAWAL cumulative TWR", actual: withdrawal.cumulative, expected: d("0") },
      {
        label: "WITHDRAWAL sub-period count",
        actual: new Decimal(withdrawal.subPeriodCount),
        expected: d("2"),
      },
    ];
  },
};

/**
 * AC-564 — the same portfolio over a full year: DEPOSIT 1000 on 2026-01-01,
 * a 10.00 fee on 2027-01-01 (day 365, 2026 not being a leap year), terminal
 * 990 the same day (exponent 365/365 = 1).
 *
 *   FEE case — not an external flow, so the only flow is −1000 @ 2026-01-01:
 *     −1000 + 990 / (1 + r) = 0  ⇒  r = −0.0100
 *   WITHDRAWAL case — the 10 is EXTERNAL, +10 @ 2027-01-01 (investor side):
 *     NPV(0) = −1000 + 10 + 990 = 0, an exact root ⇒ r = 0
 */
const FEE_XIRR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "FEE", date: "2027-01-01", amount: "-10" },
];
const FEE_AS_WITHDRAWAL_XIRR_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "WITHDRAWAL", date: "2027-01-01", amount: "-10" },
];
const FEE_XIRR_TERMINAL: TerminalValue = terminalValue("2027-01-01", "990");

const feeXirrCase: KnownAnswerCase = {
  id: "xirr-fee-is-leakage",
  ac: "AC-564",
  title:
    "XIRR of a portfolio fee: not an external flow (−1.0000 %), the same debit as a WITHDRAWAL gives 0",
  derivation:
    "FEE is not EXTERNAL, so the only flow is −1000 @ 2026-01-01: −1000 + 990/(1+r)^(365/365) = 0 " +
    "⇒ r = −0.0100. As a WITHDRAWAL the flows are −1000 @ 2026-01-01 and +10 @ 2027-01-01: " +
    "NPV(0) = −1000 + 10 + 990 = 0 ⇒ r = 0.",
  checks() {
    const flows = classifiedXirrFlows(FEE_XIRR_EVENTS);
    // The FEE is among no flow: exactly the deposit remains (asserted below
    // as a check, so a failure here cannot abort collection of the other cases).
    const fee = computeXirr(flows, FEE_XIRR_TERMINAL);
    if (!fee.converged) throw new Error("AC-564 FEE XIRR must converge");
    const withdrawal = computeXirr(
      classifiedXirrFlows(FEE_AS_WITHDRAWAL_XIRR_EVENTS),
      FEE_XIRR_TERMINAL,
    );
    if (!withdrawal.converged) throw new Error("AC-564 WITHDRAWAL XIRR must converge");
    return [
      { label: "FEE XIRR flow count", actual: new Decimal(flows.length), expected: d("1") },
      { label: "FEE XIRR", actual: fee.rate, expected: d("-0.0100") },
      { label: "WITHDRAWAL XIRR", actual: withdrawal.rate, expected: d("0") },
    ];
  },
};

/**
 * AC-565 (the classifier half of C-2) — a FEE's principal leg classifies
 * `FEE`, never `EXTERNAL`, with or without an instrument reference (the
 * classifier reads no instrument at all):
 *
 *   FEE 10.00, PRINCIPAL leg → FEE      FEE legs 1 · EXTERNAL legs 0
 *   WITHDRAWAL 10.00, PRINCIPAL leg → EXTERNAL   (the contrast: same
 *   amount, same sign, opposite class)
 */
const feeFlowClassCase: KnownAnswerCase = {
  id: "flow-class-fee",
  ac: "AC-565",
  title: "FEE classifies FEE on its principal leg, never EXTERNAL (a WITHDRAWAL is EXTERNAL)",
  derivation:
    "classifyFlows({kind: FEE}) = FEE: one FEE leg, zero EXTERNAL legs. The same 10.00 as a " +
    "WITHDRAWAL is one EXTERNAL leg, zero FEE legs — the class, not the amount, is the difference.",
  checks() {
    const count = (kind: TransactionKind, cls: string) =>
      new Decimal(classifyFlows({ kind }) === cls ? 1 : 0);
    return [
      { label: "FEE principal is FEE (legs)", actual: count("FEE", "FEE"), expected: d("1") },
      {
        label: "FEE principal is EXTERNAL (legs)",
        actual: count("FEE", "EXTERNAL"),
        expected: d("0"),
      },
      {
        label: "WITHDRAWAL principal is EXTERNAL (legs)",
        actual: count("WITHDRAWAL", "EXTERNAL"),
        expected: d("1"),
      },
      {
        label: "WITHDRAWAL principal is FEE (legs)",
        actual: count("WITHDRAWAL", "FEE"),
        expected: d("0"),
      },
    ];
  },
};

// ===========================================================================
// CASE 18–20 — Cash in V(d) (portfolio-cash AC-575 pure half; FR-679, FR-683,
// PC-L1, PC-L2).
// ===========================================================================

/**
 * The series of a cash-only portfolio built the way materialise builds it:
 * each event's cash net through {@link cashBalancesBefore} (strictly before
 * each date, pre-flow) and {@link valueCash} (EUR base, so rate 1). Flows are
 * the same events through {@link classifyFlows}.
 */
function cashOnlySeries(events: readonly CashEvent[], dates: readonly string[]): Valuation[] {
  const nets: CashDailyNet[] = events.map((e) => ({
    date: e.date,
    currency: "EUR",
    amount: d(e.amount),
  }));
  const balances = cashBalancesBefore(nets, dates);
  return dates.map((date, i) =>
    valuation(date, valueCash(balances[i] ?? new Map(), [], date, "EUR").totalValueBase.toString()),
  );
}

/**
 * AC-575 (i) — portfolio P, EUR cash only: DEPOSIT +1000 on 2026-01-01, then
 * 10 of INCOME (an INTEREST credit) on 2026-07-01. V is built from cash, not
 * hand-typed:
 *
 *   V(2026-01-01) = Σ nets < 01-01 = 0
 *   V(2026-07-01) = Σ nets < 07-01 = 1000          (the 10 is not in yet)
 *   V(2026-07-02) = Σ nets < 07-02 = 1000 + 10 = 1010
 *
 *   INCOME opens no sub-period: TWR = 1010 / (0 + 1000) − 1 = 0.0100
 *   AC-563's FEE (−10) instead: V(07-02) = 990, TWR = 990 / 1000 − 1 = −0.0100
 */
const CASH_IN_V_DATES = ["2026-01-01", "2026-07-01", "2026-07-02"] as const;
const CASH_INCOME_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "INTEREST", date: "2026-07-01", amount: "10" },
];
const CASH_FEE_EVENTS: readonly CashEvent[] = [
  { kind: "DEPOSIT", date: "2026-01-01", amount: "1000" },
  { kind: "FEE", date: "2026-07-01", amount: "-10" },
];

const cashInValueTwrCase: KnownAnswerCase = {
  id: "twr-cash-in-value",
  ac: "AC-575",
  title:
    "Cash in V(d): income credited on 07-01 gives V(07-02) = 1010 and TWR 1.0000 %; a FEE instead gives −1.0000 %",
  derivation:
    "Pre-flow cash balances: V(01-01) = 0, V(07-01) = 1000, V(07-02) = 1000 + 10 = 1010. The " +
    "income is not EXTERNAL, so one sub-period: 1010/(0+1000) − 1 = 0.0100. With AC-563's FEE " +
    "−10 the same series ends at 990: 990/(0+1000) − 1 = −0.0100.",
  checks() {
    const income = cashOnlySeries(CASH_INCOME_EVENTS, CASH_IN_V_DATES);
    const fee = cashOnlySeries(CASH_FEE_EVENTS, CASH_IN_V_DATES);
    const incomeTwr = computeTwr(income, classifiedTwrFlows(CASH_INCOME_EVENTS));
    const feeTwr = computeTwr(fee, classifiedTwrFlows(CASH_FEE_EVENTS));
    return [
      { label: "income V(2026-07-01)", actual: income[1]?.value ?? d("-1"), expected: d("1000") },
      { label: "income V(2026-07-02)", actual: income[2]?.value ?? d("-1"), expected: d("1010") },
      { label: "income cumulative TWR", actual: incomeTwr.cumulative, expected: d("0.0100") },
      { label: "FEE V(2026-07-02)", actual: fee[2]?.value ?? d("-1"), expected: d("990") },
      { label: "FEE cumulative TWR", actual: feeTwr.cumulative, expected: d("-0.0100") },
    ];
  },
};

/**
 * AC-575 (ii) — USD 100.00 credited on D = 2026-03-02, EUR base, market rates
 * {D: 0.80, D+2: 0.82} (native→base, EUR per USD):
 *
 *   C(D)   = 0                       (the credit is dated D: pre-flow, not in V(D))
 *   C(D+1) = 100 × 0.80 = 80.00      (no rate on D+1: D's carried forward)
 *   C(D+2) = 100 × 0.82 = 82.00      (re-valued at the day's own rate)
 */
const CASH_USD_NETS: readonly CashDailyNet[] = [
  { date: "2026-03-02", currency: "USD", amount: d("100.00") },
];
const CASH_USD_DATES = ["2026-03-02", "2026-03-03", "2026-03-04"] as const;
const CASH_USD_RATES: readonly FxRatePoint[] = [
  { currency: "USD", observedOn: "2026-03-02", rate: d("0.80") },
  { currency: "USD", observedOn: "2026-03-04", rate: d("0.82") },
];

/** C(d) over {@link CASH_USD_DATES}, plus whether `valueCash` threw (counted, never rethrown). */
function usdCashSeries(rates: readonly FxRatePoint[], nets: readonly CashDailyNet[]) {
  const balances = cashBalancesBefore(nets, CASH_USD_DATES);
  let threw = 0;
  const valued = CASH_USD_DATES.map((date, i) => {
    try {
      return valueCash(balances[i] ?? new Map(), rates, date, "EUR");
    } catch {
      threw += 1;
      return undefined;
    }
  });
  return { valued, threw };
}

const cashFxLocfCase: KnownAnswerCase = {
  id: "cash-fx-locf",
  ac: "AC-575",
  title: "Non-base cash first shows on D+1 at the LOCF market rate, re-valued at each later rate",
  derivation:
    "USD +100 dated D: C(D) = 0 (pre-flow); C(D+1) = 100 × 0.80 = 80.00 (D's rate carried); " +
    "C(D+2) = 100 × 0.82 = 82.00.",
  checks() {
    const { valued, threw } = usdCashSeries(CASH_USD_RATES, CASH_USD_NETS);
    const total = (i: number) => valued[i]?.totalValueBase ?? d("-1");
    return [
      { label: "valueCash throws (count)", actual: new Decimal(threw), expected: d("0") },
      { label: "C(D)", actual: total(0), expected: d("0") },
      { label: "C(D+1)", actual: total(1), expected: d("80.00") },
      { label: "C(D+2)", actual: total(2), expected: d("82.00") },
    ];
  },
};

/**
 * AC-575 (iii) — the same USD 100.00 with the first USD rate on D+2 only:
 *
 *   C(D+1) = 0 with `unconverted = [USD]` — excluded and flagged, no throw
 *   C(D+2) = 100 × 0.82 = 82.00, nothing unconverted
 *
 * (iv) — USD +100 and −100 both dated D (a balance netting to exactly zero)
 * with no USD rate at all: C(D+1) = 0 and nothing unconverted (a zero balance
 * needs no rate).
 */
const cashUnconvertedCase: KnownAnswerCase = {
  id: "cash-unconverted",
  ac: "AC-575",
  title:
    "A cash currency with no rate is excluded and listed as unconverted, never a throw; a zero balance is never unconverted",
  derivation:
    "First USD rate on D+2: C(D+1) = 0, unconverted = [USD]; C(D+2) = 100 × 0.82 = 82.00. " +
    "USD +100 − 100 on D with no rate: balance 0, C(D+1) = 0, unconverted = [].",
  checks() {
    const late = usdCashSeries(
      [{ currency: "USD", observedOn: "2026-03-04", rate: d("0.82") }],
      [...CASH_USD_NETS],
    );
    const zero = usdCashSeries(
      [],
      [...CASH_USD_NETS, { date: "2026-03-02", currency: "USD", amount: d("-100.00") }],
    );
    const lists = (i: number, valued: typeof late.valued, currency: string) =>
      new Decimal(valued[i]?.unconverted.includes(currency) === true ? 1 : 0);
    const count = (i: number, valued: typeof late.valued) =>
      new Decimal(valued[i]?.unconverted.length ?? -1);
    return [
      {
        label: "late rate: valueCash throws (count)",
        actual: new Decimal(late.threw),
        expected: d("0"),
      },
      {
        label: "late rate: unconverted count C(D+1)",
        actual: count(1, late.valued),
        expected: d("1"),
      },
      {
        label: "late rate: USD unconverted C(D+1)",
        actual: lists(1, late.valued, "USD"),
        expected: d("1"),
      },
      {
        label: "late rate: C(D+1)",
        actual: late.valued[1]?.totalValueBase ?? d("-1"),
        expected: d("0"),
      },
      {
        label: "late rate: unconverted count C(D+2)",
        actual: count(2, late.valued),
        expected: d("0"),
      },
      {
        label: "late rate: C(D+2)",
        actual: late.valued[2]?.totalValueBase ?? d("-1"),
        expected: d("82.00"),
      },
      {
        label: "zero balance: valueCash throws (count)",
        actual: new Decimal(zero.threw),
        expected: d("0"),
      },
      {
        label: "zero balance: unconverted count C(D+1)",
        actual: count(1, zero.valued),
        expected: d("0"),
      },
      {
        label: "zero balance: C(D+1)",
        actual: zero.valued[1]?.totalValueBase ?? d("-1"),
        expected: d("0"),
      },
    ];
  },
};

// ===========================================================================
// The registry.
// ===========================================================================

/**
 * Every known-answer case, in documentation order. The release gate
 * (`known-answers.test.ts`) iterates this array and asserts each `checks()`
 * result is within {@link AC_TOLERANCE} of its documented expected value.
 */
export const ALL_KNOWN_ANSWER_CASES: readonly KnownAnswerCase[] = [
  pmpCase,
  realizedGainCase,
  fxAttributionCase,
  cryptoSettlementCase,
  settlementLegCase,
  twrAc17Case,
  mwrAc17Case,
  twrAc18Case,
  mwrAc18Case,
  multipleRootCase,
  dayCountCase,
  valuationCase,
  fxDirectionEurCase,
  fxDirectionUsdCase,
  interestTwrCase,
  interestXirrCase,
  interestFlowClassCase,
  feeTwrCase,
  feeXirrCase,
  feeFlowClassCase,
  cashInValueTwrCase,
  cashFxLocfCase,
  cashUnconvertedCase,
];
