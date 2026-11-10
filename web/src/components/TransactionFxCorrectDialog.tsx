import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Decimal, parseDecimalString } from "@kerdial/core-decimal";
import { correctTransactionFxRate, type TransactionResponse } from "../lib/api-client.js";
import { invalidatePortfolioDerivedFigures } from "../lib/invalidate-derived.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { TRANSACTION_DETAIL_COPY } from "../lib/copy/transaction-detail.js";
import { messageForError } from "../lib/problem-messages.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { Button, Dialog, Icon, Input } from "./ui/index.js";
import { LedgerAmount } from "./LedgerAmount.js";
import { BASE_CURRENCY } from "./TransactionForm.js";

/**
 * `<TransactionFxCorrectDialog>` — UR-21 (FR-106/FR-108, AC100), restyled in the Kerdial skin to the
 * design's 468px centred modal.
 *
 * > ⚠ **AMENDED (2026-08-17).**
 * > AC142: states explicitly that the fee and withholding FX legs
 * > cannot be corrected here (or anywhere) — `PATCH /transactions/:id/fx-rate`
 * > takes `{fxRate}` only, and corrects the **principal** leg exclusively.
 *
 * A **distinct** action from `TransactionEditDialog`/`TransactionEditForm` —
 * a different button in the transaction detail drawer,
 * never conflated in the same submit path: this dialog's own `useMutation`
 * calls `correctTransactionFxRate` (`PATCH .../fx-rate`) exclusively, never
 * the general `editTransaction` (`PATCH /transactions/:id`) wrapper. It is a
 * modal, not a right-side panel, so it does not contend with the detail
 * drawer for the single right-side panel slot.
 *
 * Same invalidation convention and no-optimistic-update rule as every other
 * ledger mutation: mutate -> await -> invalidate.
 *
 * ## What the endpoint does not take
 *
 * There is no **source** selector and no **note** field beside the new
 * rate. `correctFxRateBodySchema` is `{ fxRate }` and nothing else: the server
 * stamps the source itself (`USER_PINNED`) and records the correction in the
 * transaction's revision trail. Rendering inputs whose values would be
 * silently dropped on the way to the API would be worse than not offering
 * them, so they are not offered, and the modal says what is recorded instead.
 */
export interface TransactionFxCorrectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly transaction: TransactionResponse | undefined;
}

function tryParseDecimal(raw: string): Decimal | undefined {
  try {
    return parseDecimalString(raw);
  } catch {
    return undefined;
  }
}

/**
 * `amount_base = amount_native × fx_rate` — the
 * server's own conversion (`ledger/src/posting-expander.ts`'s
 * `toBase = (native, rate) => native.times(rate)`), applied here identically
 * rather than re-derived, exactly as `lib/income-totals.ts` already does for
 * the income presets.
 *
 * Returns `undefined` — and the row simply does not render — whenever either
 * side fails to parse. A correction preview that guesses is worse than one
 * that is absent.
 */
export function convertToBase(amount: string | null, rate: string): string | undefined {
  if (amount === null) return undefined;
  const parsedAmount = tryParseDecimal(amount);
  const parsedRate = tryParseDecimal(rate);
  if (parsedAmount === undefined || parsedRate === undefined) return undefined;
  return parsedAmount.times(parsedRate).toString();
}

export function TransactionFxCorrectDialog({
  open,
  onOpenChange,
  transaction,
}: TransactionFxCorrectDialogProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [fxRate, setFxRate] = useState("");

  const mutation = useMutation({
    mutationFn: (rate: string) => {
      if (transaction === undefined) throw new Error("no transaction selected");
      return correctTransactionFxRate(transaction.id, rate);
    },
    networkMode: "always",
    // Mutate -> await -> invalidate, no optimistic
    // update — AC100's own effect (PMP/unrealized gain/realized gain
    // recompute) is proven by the invalidated reads refetching, never by
    // this dialog guessing the new figures itself.
    onSuccess: async () => {
      await Promise.all([
        invalidatePortfolioDerivedFigures(queryClient, { epochWillAdvance: true }),
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
      setFxRate("");
      onOpenChange(false);
    },
  });

  function closeAndReset(nextOpen: boolean): void {
    if (!nextOpen) {
      setFxRate("");
      mutation.reset();
    }
    onOpenChange(nextOpen);
  }

  const trimmedRate = fxRate.trim();
  const canSubmit = online && trimmedRate !== "" && !mutation.isPending;

  function submit(): void {
    if (!canSubmit) return;
    mutation.mutate(trimmedRate);
  }

  const currentBase =
    transaction === undefined
      ? undefined
      : convertToBase(transaction.grossAmount, transaction.fxRate);
  const nextBase =
    transaction === undefined || trimmedRate === ""
      ? undefined
      : convertToBase(transaction.grossAmount, trimmedRate);

  return (
    <Dialog
      open={open}
      onClose={() => closeAndReset(false)}
      title={TRANSACTION_DETAIL_COPY.fxCorrectTitle}
      description={TRANSACTION_DETAIL_COPY.fxCorrectDescription}
      variant="modal"
      width={468}
      footer={
        transaction === undefined ? undefined : (
          <>
            <Button
              variant="ghost"
              data-testid="transaction-fx-correct-cancel"
              onClick={() => closeAndReset(false)}
            >
              {COMMON_COPY.cancel}
            </Button>
            <Button
              variant="primary"
              data-testid="transaction-fx-correct-submit"
              disabled={!canSubmit}
              onClick={submit}
            >
              {TRANSACTION_DETAIL_COPY.fxCorrectSubmit}
            </Button>
          </>
        )
      }
    >
      <div data-testid="transaction-fx-correct-dialog" className="k-ov-body">
        {transaction && (
          <form
            data-testid="transaction-fx-correct-form"
            className="k-ov-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {/* The correction recomputes derived figures, and
                the modal says so before it is committed, not after. */}
            <div
              className="k-banner k-banner-warn"
              data-testid="transaction-fx-correct-recompute-warning"
            >
              <Icon name="alert-triangle" size="sm" />
              <p>{TRANSACTION_DETAIL_COPY.fxCorrectRecomputeWarning}</p>
            </div>

            {/* AC139/AC142: stated unconditionally, not only when fee/
                withholding legs happen to be present on this particular
                transaction — this dialog only ever corrects one leg, full
                stop. */}
            <div
              data-testid="transaction-fx-correct-scope-note"
              className="k-banner k-banner-neutral"
            >
              <Icon name="info" size="sm" />
              <p>{TRANSACTION_DETAIL_COPY.fxCorrectScopeNote}</p>
            </div>

            <section className="k-ov-section">
              <h3 className="k-ov-section-title">
                {TRANSACTION_DETAIL_COPY.fxCorrectSectionTitle}
              </h3>
              <dl className="k-ov-rows">
                <div className="k-ov-row">
                  <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.grossAmount}</dt>
                  <dd className="k-ov-row-value" data-testid="transaction-fx-correct-gross">
                    <LedgerAmount
                      amount={transaction.grossAmount}
                      currency={transaction.txnCurrency}
                    />
                  </dd>
                </div>
                <div className="k-ov-row">
                  <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.fxCorrectCurrentRate}</dt>
                  <dd className="k-ov-row-value" data-testid="transaction-fx-correct-current-rate">
                    <LedgerAmount amount={transaction.fxRate} currency={null} kind="fxRate" />
                  </dd>
                </div>
                <div className="k-ov-row">
                  <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.fxSource}</dt>
                  <dd
                    className="k-ov-row-value"
                    data-testid="transaction-fx-correct-current-source"
                  >
                    {transaction.fxRateSource}
                  </dd>
                </div>
                {transaction.fxRateObservedOn !== null && (
                  <div className="k-ov-row">
                    <dt className="k-ov-row-label">{TRANSACTION_DETAIL_COPY.fxObservedOn}</dt>
                    <dd
                      className="k-ov-row-value"
                      data-testid="transaction-fx-correct-current-observed-on"
                    >
                      {formatIsoDateFr(transaction.fxRateObservedOn)}
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            <Input
              label={TRANSACTION_DETAIL_COPY.fxCorrectNewRate}
              hint={fill(TRANSACTION_DETAIL_COPY.fxCorrectNewRateHint, {
                from: transaction.txnCurrency ?? TRANSACTION_DETAIL_COPY.fxCorrectUnitFallback,
                to: BASE_CURRENCY,
              })}
              numeric
              autoFocus
              data-testid="transaction-fx-correct-rate-input"
              value={fxRate}
              onChange={(event) => setFxRate(event.target.value)}
            />

            {nextBase !== undefined && (
              <div className="k-ov-total" data-testid="transaction-fx-correct-converted">
                <span className="k-ov-total-label">
                  {TRANSACTION_DETAIL_COPY.fxCorrectConverted}
                </span>
                <span className="k-ov-restated">
                  {currentBase !== undefined && (
                    <span
                      className="k-ov-restated-old"
                      data-testid="transaction-fx-correct-converted-old"
                    >
                      <LedgerAmount amount={currentBase} currency={BASE_CURRENCY} />
                    </span>
                  )}
                  <span
                    className="k-ov-total-value"
                    data-testid="transaction-fx-correct-converted-new"
                  >
                    <LedgerAmount amount={nextBase} currency={BASE_CURRENCY} />
                  </span>
                </span>
              </div>
            )}

            {mutation.isError && (
              <div
                role="alert"
                className="k-banner k-banner-loss"
                data-testid="transaction-fx-correct-submit-error"
              >
                <Icon name="circle-alert" size="sm" />
                <p>{messageForError(mutation.error).text}</p>
              </div>
            )}

            {!online && (
              <div
                role="alert"
                className="k-banner k-banner-neutral"
                data-testid="transaction-fx-correct-offline-error"
              >
                <Icon name="info" size="sm" />
                <p>{COMMON_COPY.offlineExplanation}</p>
              </div>
            )}
          </form>
        )}
      </div>
    </Dialog>
  );
}
