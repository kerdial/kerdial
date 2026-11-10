import { computeTransactionPreview } from "../lib/transaction-preview.js";
import { PREVIEW_GAP_COPY, TRANSACTION_COPY } from "../lib/copy/transactions.js";
import { LedgerAmount } from "./LedgerAmount.js";

/**
 * The add/edit drawer's live preview.
 *
 * A sunken block: it sits inside a drawer that is already a
 * surface, and the design forbids nesting a second shadowed card.
 *
 * Rendered with `<LedgerAmount>`, not `<Figure>`, and that is a correctness
 * point rather than a convenience one: `<Figure>` exists to disclose
 * *provenance* — whether a figure came from a manual price, a delayed quote, a
 * pinned rate. A preview is arithmetic on what the user has just typed. It has
 * no provenance to disclose, and badging it as though it did would be a claim
 * about data that does not exist yet.
 *
 * The interesting part is what it says when it cannot say a number. Each gap
 * gets a sentence naming the reason, because the alternatives are both worse:
 * a blank row reads as "zero", and omitting the row entirely hides that there
 * is a figure the user might have expected.
 */
export interface TransactionPreviewBlockProps {
  readonly kind: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly currency: string;
  readonly feeAmount?: string;
  readonly fxRateUserInput?: string;
  /** FT-23: the settling account's own currency, and how much of it moves. Passed straight through — the module decides whether they differ. */
  readonly cashCurrency?: string;
  readonly cashAmount?: string;
}

export function TransactionPreviewBlock(props: TransactionPreviewBlockProps) {
  const preview = computeTransactionPreview(props);

  return (
    <section className="k-card k-card-sunken k-card-pad" data-testid="transaction-preview">
      <h3 className="micro-label">{TRANSACTION_COPY.previewTitle}</h3>

      <dl className="tx-preview">
        <div className="tx-preview-row">
          <dt>{TRANSACTION_COPY.previewGross}</dt>
          <dd data-testid="transaction-preview-gross">
            {preview.gross === undefined ? (
              <span className="tx-preview-absent">—</span>
            ) : (
              <LedgerAmount amount={preview.gross.toString()} currency={props.currency} />
            )}
          </dd>
        </div>

        {preview.fee !== undefined && (
          <div className="tx-preview-row">
            <dt>{TRANSACTION_COPY.previewFee}</dt>
            <dd data-testid="transaction-preview-fee">
              {/* FT-47 / L5: a cost is denominated by the settling account, so
                  the fee line is in the settlement currency when there is one
                  and in the trade's otherwise. `props.feeCurrency` used to
                  choose here and is gone with the control. */}
              <LedgerAmount
                amount={preview.fee.toString()}
                currency={props.cashCurrency?.trim() || props.currency}
              />
            </dd>
          </div>
        )}

        <div className="tx-preview-row tx-preview-total">
          <dt>
            {preview.cashMovement?.isNegative() === true
              ? TRANSACTION_COPY.previewCashOut
              : TRANSACTION_COPY.previewCashIn}
          </dt>
          <dd data-testid="transaction-preview-cash">
            {preview.cashMovement === undefined ? (
              <span className="tx-preview-absent" data-testid="transaction-preview-cash-gap">
                {PREVIEW_GAP_COPY[preview.cashMovementGap ?? "incomplete"]}
              </span>
            ) : (
              // F5: the movement's own unit, which since phase 1 is the
              // settling account's currency whenever it differs — never
              // `props.currency` again.
              <LedgerAmount
                amount={preview.cashMovement.abs().toString()}
                currency={preview.cashMovementCurrency}
              />
            )}
          </dd>
        </div>

        <div className="tx-preview-row">
          <dt>{TRANSACTION_COPY.previewBaseEquivalent}</dt>
          <dd data-testid="transaction-preview-base">
            {preview.baseEquivalent === undefined ? (
              <span className="tx-preview-absent" data-testid="transaction-preview-base-gap">
                {PREVIEW_GAP_COPY[preview.baseEquivalentGap ?? "incomplete"]}
              </span>
            ) : (
              <LedgerAmount amount={preview.baseEquivalent.abs().toString()} currency={null} />
            )}
          </dd>
        </div>

        {preview.rate !== undefined && (
          <div className="tx-preview-row">
            <dt>{TRANSACTION_COPY.previewRate}</dt>
            {/* Labelled as the user's own. The design asks for the rate "spelled
                out", and the thing worth spelling out is whose rate it is — a
                typed rate is a claim, not an observation. */}
            <dd data-testid="transaction-preview-rate">
              <LedgerAmount amount={preview.rate.toString()} currency={null} kind="fxRate" />
              <span className="tx-preview-rate-source">{TRANSACTION_COPY.previewRateSource}</span>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
