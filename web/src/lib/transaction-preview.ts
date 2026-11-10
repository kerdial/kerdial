import { Decimal, parseDecimalString } from "@kerdial/core-decimal";

/**
 * The add/edit drawer's live preview.
 *
 * Pure and synchronous: it issues no request, so it cannot be debounced wrong
 * and cannot cost a read per keystroke. That is deliberate, and it is also
 * what makes the whole thing honest — see below.
 *
 * ## What it may claim, and what it may not
 *
 * The rule this module exists to enforce is that **a preview must agree with
 * what the ledger will actually record.** A figure computed with a different
 * convention is worse than no figure: it teaches the user a number the ledger
 * then contradicts, and only on a screen they have already left.
 *
 * Three server conventions are reproduced here, each byte-for-byte:
 *
 * - `grossAmount = quantity × unitPrice`
 *   (`ledger/src/transaction-write-service.ts`, both call sites).
 * - `toBase = (native, rate) => native × rate`
 *   (`ledger/src/posting-expander.ts`, the single definition).
 * - The **fee leg is always negative**, whatever the kind
 *   (`posting-expander.ts`: `txn.feeAmount.negated()`). A fee is money out of
 *   a buy and money out of a sale alike.
 *
 * Everything else is refused rather than approximated:
 *
 * - **There is no "net amount" on the wire** and this does
 *   not invent one. What it reports is the *cash movement*, whose sign follows
 *   the kind, and it says which direction it is rather than printing a bare
 *   magnitude.
 * - **A fee in a different currency cannot be added to the gross.** It carries
 *   its own independently resolved rate (`feeFxRate`), so combining the two
 *   needs two rates and the client has neither. Reported as its own outcome,
 *   not silently dropped from the total.
 * - **Without a user-supplied rate there is no base-currency equivalent.** No
 *   FX read exists anywhere in this product, so the rate the server will pick
 *   is genuinely unknowable here. The preview says the rate is resolved on
 *   save; it does not guess one and it does not quietly omit the line.
 * - **A magnitude is never stated in the wrong unit** (FT-23).
 *   Since `fee-tax-breakdown` phase 1 the ledger records the principal cash
 *   posting in the *settling account's* currency, not the trade's
 *   (`posting-expander.ts`, `emitPrincipalCash`), so for a USD trade settled
 *   from a EUR account this module used to report «−1 500,00 USD» where the
 *   ledger debits −1 380,00 EUR. It now reports the movement in the
 *   settlement currency, or reports `settlement-amount-missing` — the one
 *   thing it may not do is keep printing a figure whose unit the ledger
 *   contradicts. Nothing is derived *here*: in case D4 the form passes the
 *   figure it computed from the user's **own pinned rate** — the same figure
 *   it shows them, and the one the server will store for that rate — and when
 *   no rate has been pinned there is nothing to pass, so the gap is reported
 *   rather than a rate invented to fill it (see the bullet above).
 */

/** Kinds whose cash direction this module is willing to state. */
export type PreviewKind = "BUY" | "SELL";

export interface TransactionPreviewInput {
  readonly kind: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly currency: string;
  readonly feeAmount?: string;
  /** The rate the user typed, if any. Absent means the server will resolve one. */
  readonly fxRateUserInput?: string;
  /**
   * FT-23 (**F5**): the principal cash leg's own currency — the currency
   * of the account the user chose, which since phase 1 need not be the
   * trade's. Absent, or equal to {@link TransactionPreviewInput.currency}, is
   * the degenerate case and every figure below is exactly what it was.
   */
  readonly cashCurrency?: string;
  /** How much of {@link TransactionPreviewInput.cashCurrency} moves. Typed by the user in D3/D5; absent in D4, where the server derives it (L11). */
  readonly cashAmount?: string;
}

/** Why a figure is absent. Rendered as a sentence — never as a blank. */
export type PreviewGap =
  | "incomplete"
  /**
   * **FT-47: `fee-currency-differs`, re-keyed rather than deleted**. The
   * outcome exists because a cost and a gross in different currencies
   * cannot be added, and after L5 that is still reachable — just for a
   * different reason. A cost is denominated by the **settling account** now, so
   * the currencies that disagree are the settlement one and the trade's
   * (D3/D4/D5), not the fee's and the trade's. FT-23 was the phase-1 half of
   * the same repair.
   */
  | "settlement-currency-differs"
  | "rate-resolved-on-save"
  | "kind-has-no-cash-direction"
  /** FT-23: the settlement currency differs but the settled amount is not known yet — the one state where the old code printed the trade-currency magnitude instead. */
  | "settlement-amount-missing";

export interface TransactionPreview {
  /** quantity × unitPrice, in the trade currency. */
  readonly gross?: Decimal;
  readonly fee?: Decimal;
  /**
   * Signed cash movement in {@link TransactionPreview.cashMovementCurrency}:
   * negative for a buy, positive for a sale, with the fee always subtracted.
   */
  readonly cashMovement?: Decimal;
  /**
   * The unit {@link TransactionPreview.cashMovement} is in — the settlement
   * currency when it differs from the trade's, the trade currency otherwise.
   * Always present, including while the movement itself is absent, so a caller
   * cannot render a magnitude without its unit (F5).
   */
  readonly cashMovementCurrency: string;
  readonly cashMovementGap?: PreviewGap;
  /**
   * The trade-currency movement × rate, only ever with a rate the user
   * actually supplied. Deliberately **not** `cashMovement × rate`: the rate is
   * `txn_currency → base` (FR-257(4)), and the ledger's own `amount_base` is
   * `gross × fx_rate` whatever the account is denominated in (FR-234). In the
   * degenerate case the two expressions are the same one.
   */
  readonly baseEquivalent?: Decimal;
  readonly baseEquivalentGap?: PreviewGap;
  readonly rate?: Decimal;
  /** `true` whenever a rate is shown at all — it is only ever the user's own. */
  readonly rateIsUserInput: boolean;
}

function tryParse(raw: string | undefined): Decimal | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return parseDecimalString(trimmed);
  } catch {
    // A half-typed number is the normal state of a field being filled in, not
    // an error to report. The figure is simply not available yet.
    return undefined;
  }
}

function isPreviewKind(kind: string): kind is PreviewKind {
  return kind === "BUY" || kind === "SELL";
}

export function computeTransactionPreview(input: TransactionPreviewInput): TransactionPreview {
  const quantity = tryParse(input.quantity);
  const unitPrice = tryParse(input.unitPrice);
  const fee = tryParse(input.feeAmount);
  const rate = tryParse(input.fxRateUserInput);

  // `quantity × unitPrice` — the server's own expression, not a re-derivation.
  const gross =
    quantity === undefined || unitPrice === undefined ? undefined : quantity.times(unitPrice);

  // FT-23 / F5. The comparison is trimmed for the reason `posting-expander.ts`
  // trims it: `char(3)` values are three characters in practice, and a
  // mis-compare here would route a degenerate row down the settlement branch —
  // the same class of silent error, one layer up.
  const settlementCurrency = (input.cashCurrency ?? "").trim();
  const settlementDiffers =
    settlementCurrency !== "" && settlementCurrency !== input.currency.trim();

  /**
   * **FT-47.** The cost is in the settling account's currency (L5) and the
   * gross is in the trade's, so on a D3/D4/D5 row the two cannot be added and
   * the *trade-currency* movement cannot be stated at all. On a D1/D2 row they
   * are the same currency and it can, exactly as before — which is why this
   * says nothing when the settlement currency matches, cost or no cost.
   */
  const costCurrencyDiffersFromTrade = fee !== undefined && settlementDiffers;

  // The trade-currency movement: what this module has always computed, kept
  // whole because it is still the honest input to the base-currency figure
  // (`amount_base = gross × fx_rate`, unchanged by phase 1 — FR-234/FR-240).
  let tradeMovement: Decimal | undefined;
  let tradeMovementGap: PreviewGap | undefined;

  if (gross === undefined) {
    tradeMovementGap = "incomplete";
  } else if (!isPreviewKind(input.kind)) {
    // Deposits, withdrawals, dividends, DRIP and currency exchange each move
    // money by their own rules; this module does not model them and says so
    // rather than showing a buy's arithmetic under another name.
    tradeMovementGap = "kind-has-no-cash-direction";
  } else if (costCurrencyDiffersFromTrade) {
    tradeMovementGap = "settlement-currency-differs";
  } else {
    // BUY: money out, gross and fee both. SELL: money in, less the fee.
    const feeOut = fee ?? new Decimal(0);
    tradeMovement = input.kind === "BUY" ? gross.plus(feeOut).negated() : gross.minus(feeOut);
  }

  const settledAmount = tryParse(input.cashAmount);

  let cashMovement = tradeMovement;
  let cashMovementGap = tradeMovementGap;
  const cashMovementCurrency = settlementDiffers ? settlementCurrency : input.currency;

  if (settlementDiffers) {
    cashMovement = undefined;
    cashMovementGap = undefined;
    // **The cost can always be added here now** (FT-47). It is denominated by
    // the settling account (L5), which is the currency this branch is
    // computing in — so the "the fee is in some third currency" case that used
    // to guard this addition is not merely unreached, it is unrepresentable.
    // Its counterpart survives on the *trade-currency* movement above, where
    // the mismatch is real.
    if (gross === undefined) {
      cashMovementGap = "incomplete";
    } else if (!isPreviewKind(input.kind)) {
      cashMovementGap = "kind-has-no-cash-direction";
    } else if (settledAmount === undefined) {
      // D3/D5 with nothing typed yet. The trade-currency magnitude is right
      // here and *wrong by a currency*, which is the whole of F5.
      cashMovementGap = "settlement-amount-missing";
    } else {
      const feeOut = fee ?? new Decimal(0);
      cashMovement =
        input.kind === "BUY" ? settledAmount.plus(feeOut).negated() : settledAmount.minus(feeOut);
    }
  }

  let baseEquivalent: Decimal | undefined;
  let baseEquivalentGap: PreviewGap | undefined;

  if (tradeMovement === undefined) {
    baseEquivalentGap = tradeMovementGap;
  } else if (rate === undefined) {
    baseEquivalentGap = "rate-resolved-on-save";
  } else {
    baseEquivalent = tradeMovement.times(rate);
  }

  return {
    gross,
    fee,
    cashMovement,
    cashMovementCurrency,
    cashMovementGap,
    baseEquivalent,
    baseEquivalentGap,
    rate,
    rateIsUserInput: rate !== undefined,
  };
}
