import { ApiError } from "../lib/api-client.js";
import { valuationStateIdForError } from "../lib/empty-states.js";
import { messageForError } from "../lib/problem-messages.js";
import { EmptyState, EmptyStateActionButton } from "./EmptyState.js";
import { PriceGapRemedy } from "./PriceGapRemedy.js";

/**
 * `ValuationErrorState.tsx` — UR-36. The error half
 * of the state matrix: `VALUATION_PRICE_UNAVAILABLE`,
 * `VALUATION_FX_RATE_UNAVAILABLE`, `VALUATION_RESPONSE_TOO_LARGE` and the
 * throttled 429, each as **its own labelled panel**, while every sibling panel on the screen keeps rendering (AC134's
 * per-panel isolation rule, which this component inherits by being a panel's
 * content rather than a screen-level branch).
 *
 * **`messageForError` is the only source of "what happened".** Its output
 * becomes `EmptyState`'s `detail`; the catalogue supplies the rest. The
 * server's `detail`/`title` is never rendered here — see `problem-messages.ts`
 * for why that is a requirement (FR-110, FR-128/AC120) and not a preference.
 *
 * **Why the throttle is a state and not a failure.** A 429 means the read was
 * *refused*, not that the data is wrong or gone: nothing was lost and the same
 * request works moments later. That is a materially different thing to tell a
 * user than "la valorisation a échoué", so it gets its own copy **and** the
 * only action in this component — `onRetry`, wired by the hosting screen to
 * its own query's `refetch`. This is a **read** retry; it is unrelated to the
 * backfill retry, which is blocked (no endpoint exists,
 * and no state in this app offers one).
 *
 * **The second action: a named price gap.** When a portfolio-level
 * `VALUATION_PRICE_UNAVAILABLE` names its instrument, `PriceGapRemedy` renders
 * the range, the fiche link and — when the server found the acquisition price —
 * a confirmed one-click manual price. A price gap without that member (older
 * server, single-instrument read) keeps the plain state.
 *
 * **Unmapped errors do not get an invented state.** They fall through to a
 * labelled paragraph carrying `messageForError`'s own generic copy — honest
 * about the panel that failed, without pretending to a diagnosis the catalogue
 * does not have.
 */
export interface ValuationErrorStateProps {
  readonly error: unknown;
  readonly testId: string;
  /** The French name of the panel this error belongs to — what makes it a *labelled* panel rather than an anonymous red line. */
  readonly panelLabel: string;
  /** The hosting query's own `refetch`. Wired only for the throttled state, the one case where retrying is genuinely the right advice. */
  readonly onRetry?: () => void;
}

export function ValuationErrorState({
  error,
  testId,
  panelLabel,
  onRetry,
}: ValuationErrorStateProps) {
  const message = messageForError(error).text;
  const id = valuationStateIdForError(error);

  // A portfolio-level price gap names its instrument; that is what
  // turns « saisissez un cours pour l'instrument concerné » into a link and,
  // when the ledger holds the acquisition price, a one-click remedy.
  const priceGapInstrumentId = error instanceof ApiError ? error.params["instrumentId"] : undefined;
  if (
    id === "valuation-price-unavailable" &&
    error instanceof ApiError &&
    typeof priceGapInstrumentId === "string"
  ) {
    return (
      <EmptyState
        id="valuation-price-unavailable"
        testId={testId}
        detail={`${panelLabel} : ${message}`}
        action={
          <PriceGapRemedy
            error={error}
            instrumentId={priceGapInstrumentId}
            testId={`${testId}-price-gap`}
          />
        }
      />
    );
  }

  if (id === undefined) {
    return (
      <p role="alert" data-testid={testId} className="k-panel-error">
        {panelLabel} : {message}
      </p>
    );
  }

  return (
    <EmptyState
      id={id}
      testId={testId}
      detail={`${panelLabel} : ${message}`}
      action={
        onRetry !== undefined ? (
          <EmptyStateActionButton stateId={id} testId={`${testId}-retry`} onClick={onRetry} />
        ) : undefined
      }
    />
  );
}
