import type { ReactNode } from "react";
import {
  EMPTY_STATE_COPY,
  EXPECTED_BADGE_LABEL,
  UNEXPECTED_BADGE_LABEL,
  type EmptyStateId,
} from "../lib/empty-states.js";

/**
 * `EmptyState.tsx` — UR-36 (FR-110/FR-113/FR-122, AC105/AC114). The single shared presentation for
 * every empty/error state in the app: **title, explanation, primary action**,
 * exactly three parts.
 *
 * **Copy is never passed in as a string.** The only content prop is `id`, and
 * title/explanation/expectation are read from `empty-states.ts`'s catalogue.
 * That inversion is the whole point: it makes "each of the twelve states
 * renders its own explanation" true by construction rather than by review,
 * and it gives `empty-state-copy-audit.test.ts` **one** table to audit instead
 * of nine screens' worth of inline JSX. A screen that wants a state it has not
 * written copy for cannot compile.
 *
 * **`detail` is the one free-text slot, and it is not free.** It exists for
 * error-shaped states, where *what happened* comes from `messageForError`
 * (UR-6) at render time. Callers pass `messageForError(err).text` — never
 * `err.message`, never the server's `detail`/`title` (English, technical;
 * FR-110/FR-128). `ValuationErrorState.tsx` is the only production caller
 * that fills it, and it does exactly that.
 *
 * **"Whether it is expected" is rendered, not implied.** The catalogue's
 * `expected` flag becomes an explicit French badge — "Situation normale" /
 * "Anomalie" — because a user cannot tell a first-use empty list from a
 * silently failed read by tone alone, and that distinction is one of the three
 * questions every state must answer.
 *
 * **Never an empty container.** Title and explanation always render (they come
 * from the catalogue, which has no empty strings — asserted in
 * `empty-states.test.ts`), so the AC's "no state renders an empty table or bare
 * container as its only content" cannot be violated by a state that goes
 * through this component.
 */
export interface EmptyStateProps {
  readonly id: EmptyStateId;
  /**
   * The state's own test id on the hosting screen. Kept caller-supplied
   * (rather than derived from `id`) because several screens render the same
   * state in different panels — e.g. `read-throttled` can be the dashboard's
   * overview panel or the Positions read — and each needs its own stable
   * handle for its own suite.
   */
  readonly testId: string;
  /** *What happened*, for error-shaped states only: `messageForError(err).text`. Never a raw payload or the server's `detail`. */
  readonly detail?: string;
  /** The primary action, when one genuinely exists. The label belongs to the catalogue (`actionLabel`); the behaviour belongs to the screen. */
  readonly action?: ReactNode;
}

export function EmptyState({ id, testId, detail, action }: EmptyStateProps) {
  const copy = EMPTY_STATE_COPY[id];

  return (
    <div
      data-testid={testId}
      data-empty-state={id}
      // An unexpected state is an alert; an expected one is a status. Both are
      // announced — a silently-rendered empty region is precisely what FR-110
      // exists to prevent — but only the abnormal one interrupts.
      role={copy.expected ? "status" : "alert"}
      className={`rounded border p-4 ${copy.expected ? "k-empty-expected" : "k-empty-unexpected"}`}
    >
      <div className="k-empty-head">
        <p data-testid={`${testId}-title`} className="k-empty-title">
          {copy.title}
        </p>
        <span
          data-testid={`${testId}-expectation`}
          className={`rounded px-1.5 py-0.5 text-xs ${
            copy.expected ? "k-empty-badge-expected" : "k-empty-badge-unexpected"
          }`}
        >
          {copy.expected ? EXPECTED_BADGE_LABEL : UNEXPECTED_BADGE_LABEL}
        </span>
      </div>

      {detail !== undefined && (
        <p data-testid={`${testId}-detail`} className="k-empty-detail">
          {detail}
        </p>
      )}

      <p data-testid={`${testId}-explanation`} className="k-empty-explanation">
        {copy.explanation}
      </p>

      {action !== undefined && (
        <div data-testid={`${testId}-action`} className="k-empty-action">
          {action}
        </div>
      )}
    </div>
  );
}

export interface EmptyStateActionButtonProps {
  /** The state this action resolves — its catalogue `actionLabel` is the button's label, so no screen ever hand-writes one. */
  readonly stateId: EmptyStateId;
  readonly testId: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Shown as the disabled reason — the same `title`+`sr-only` pairing `NewTransactionButton.tsx` already uses for its offline explanation. */
  readonly disabledReason?: string;
}

/**
 * The button form of an empty state's primary action. Screens whose action is
 * a navigation pass a plain `<a>` as `action` instead — several of the hosting
 * views are deliberately router-agnostic (`PortfolioDetailView.tsx`'s own
 * header explains why `<Link>` is unusable there), so this component makes no
 * routing assumption at all.
 *
 * Renders **nothing** for a state the catalogue gives no `actionLabel`: the
 * absence of an action on `ingestion-in-progress` (nothing to do but wait) is
 * a deliberate statement, and this component enforces it rather
 * than letting a screen invent a label locally.
 */
export function EmptyStateActionButton({
  stateId,
  testId,
  onClick,
  disabled = false,
  disabledReason,
}: EmptyStateActionButtonProps) {
  const label = EMPTY_STATE_COPY[stateId].actionLabel;
  if (label === undefined) return null;

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        aria-describedby={disabled && disabledReason !== undefined ? `${testId}-reason` : undefined}
        title={disabled ? disabledReason : undefined}
        className="k-btn k-btn-soft k-btn-sm"
        onClick={onClick}
      >
        {label}
      </button>
      {disabled && disabledReason !== undefined && (
        <p id={`${testId}-reason`} className="k-visually-hidden">
          {disabledReason}
        </p>
      )}
    </>
  );
}
