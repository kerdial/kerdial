import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseDecimalString } from "@kerdial/core-decimal";
import type { SuggestedManualPrice } from "@kerdial/api-contracts";
import type { ApiError } from "../lib/api-client.js";
import { resolveMinorUnit } from "../lib/currency-scale.js";
import { tryFormatAmount } from "../lib/figure-format.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { messageForError, priceGapInstrumentLabel } from "../lib/problem-messages.js";
import { postManualPricePointMutationOptions } from "../lib/queries.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { PRICE_GAP_COPY } from "../lib/copy/price-gap.js";
import { Button, Dialog } from "./ui/index.js";

/**
 * `PriceGapRemedy`. What a portfolio-level
 * `VALUATION_PRICE_UNAVAILABLE` lets the reader *do*, under the state
 * `ValuationErrorState` already renders: the instrument, its unpriceable
 * range, a link to its fiche, and — when the server found one — « Utiliser le
 * prix d'achat (…) ».
 *
 * The button never writes on its own (owner decision D2): it opens a
 * confirmation stating the exact date, price and currency, and only « Enregistrer
 * ce cours » posts it, through the same `POST /instruments/:id/prices` mutation
 * the fiche's manual-price form uses — so the same derived-figure invalidation
 * runs (`invalidatePortfolioDerivedFigures`), which refetches the failed read.
 * A refusal stays in the dialog, in place.
 *
 * A plain `<a>` for the fiche, for the reason `PortfolioDetailActivityTab`
 * records: several hosting views are router-agnostic, and `<Link>` throws
 * without a mounted router.
 */
export interface PriceGapRemedyProps {
  readonly error: ApiError;
  readonly instrumentId: string;
  readonly testId: string;
}

/**
 * The amount exactly as it will be written, grouped for display: at least the
 * currency's minor unit, and never fewer decimals than the value carries — the
 * confirmation must not round what the POST sends.
 */
function formatSuggestedPrice(suggested: SuggestedManualPrice): string | undefined {
  const scale = Math.max(
    resolveMinorUnit(suggested.currency),
    parseDecimalString(suggested.close).decimalPlaces(),
  );
  const amount = tryFormatAmount("monetary", suggested.close, scale);
  return amount === undefined ? undefined : `${amount} ${suggested.currency}`;
}

export function PriceGapRemedy({ error, instrumentId, testId }: PriceGapRemedyProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation(postManualPricePointMutationOptions(queryClient));

  const { params } = error;
  const instrument = priceGapInstrumentLabel(params);
  const from = typeof params["valuationDate"] === "string" ? params["valuationDate"] : undefined;
  const first = typeof params["firstPriceDate"] === "string" ? params["firstPriceDate"] : undefined;
  const suggested = error.suggestedPrice;
  const price = suggested !== undefined ? formatSuggestedPrice(suggested) : undefined;

  return (
    <div data-testid={testId} className="k-empty-note">
      {instrument !== undefined && (
        <p data-testid={`${testId}-instrument`}>
          {fill(PRICE_GAP_COPY.instrument, { instrument })}
        </p>
      )}
      {from !== undefined && (
        <p data-testid={`${testId}-range`}>
          {first !== undefined
            ? fill(PRICE_GAP_COPY.rangeUntilFirstPrice, {
                from: formatIsoDateFr(from),
                first: formatIsoDateFr(first),
              })
            : fill(PRICE_GAP_COPY.rangeNoPriceAtAll, { from: formatIsoDateFr(from) })}
        </p>
      )}
      <p className="k-empty-action">
        <a
          href={`/instruments/${instrumentId}`}
          data-testid={`${testId}-fiche`}
          className="k-btn k-btn-secondary k-btn-sm"
        >
          {PRICE_GAP_COPY.openInstrument}
        </a>
        {suggested !== undefined && price !== undefined && (
          <Button
            variant="primary"
            size="sm"
            data-testid={`${testId}-use-trade-price`}
            onClick={() => {
              mutation.reset();
              setConfirming(true);
            }}
          >
            {fill(PRICE_GAP_COPY.useTradePrice, { price })}
          </Button>
        )}
      </p>

      {suggested !== undefined && price !== undefined && (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={PRICE_GAP_COPY.confirmTitle}
          description={fill(PRICE_GAP_COPY.confirmBody, {
            instrument: instrument ?? "",
            price,
            date: formatIsoDateFr(suggested.date),
          })}
          descriptionTestId={`${testId}-confirm-body`}
          testId={`${testId}-confirm`}
          footer={
            <>
              <Button
                variant="ghost"
                data-testid={`${testId}-confirm-cancel`}
                onClick={() => setConfirming(false)}
              >
                {COMMON_COPY.cancel}
              </Button>
              <Button
                variant="primary"
                data-testid={`${testId}-confirm-submit`}
                disabled={!online}
                loading={mutation.isPending}
                onClick={() =>
                  mutation.mutate(
                    {
                      instrumentId,
                      priceDate: suggested.date,
                      close: suggested.close,
                      currency: suggested.currency,
                    },
                    { onSuccess: () => setConfirming(false) },
                  )
                }
              >
                {PRICE_GAP_COPY.confirm}
              </Button>
            </>
          }
        >
          <p>{PRICE_GAP_COPY.confirmEditable}</p>
          {mutation.isError && (
            <p role="alert" className="k-pf-error" data-testid={`${testId}-confirm-error`}>
              {messageForError(mutation.error).text}
            </p>
          )}
          {!online && (
            <p role="alert" className="k-pf-error">
              {COMMON_COPY.offlineExplanation}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
