import type { ReactNode } from "react";
import { Icon } from "./Icon.js";
import { IconButton } from "./IconButton.js";

/**
 * A transient confirmation.
 *
 * **Success only.** The rule is unambiguous: validation and business
 * errors always render in place, inside the drawer or modal that owns them,
 * and only a success becomes a toast. The design system's `ToastProps` carries an
 * `error` tone; this implementation deliberately does not, so the wrong
 * treatment cannot be reached from a call site at all rather than being
 * available and discouraged. `state-vocabulary.test.ts` asserts the
 * negative half.
 *
 * `role="status"` rather than `alert`: a success is polite, and an assertive
 * live region interrupts whatever the user is reading to announce that
 * something went right.
 */
export interface ToastProps {
  readonly title: string;
  readonly message?: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
}

export function Toast({ title, message, onDismiss, dismissLabel = "Fermer" }: ToastProps) {
  return (
    <div role="status" aria-live="polite" className="k-toast">
      <Icon name="circle-check" size="md" className="k-toast-icon" />
      <div className="k-toast-text">
        <p className="k-toast-title">{title}</p>
        {message !== undefined ? <p className="k-toast-message">{message}</p> : null}
      </div>
      {onDismiss !== undefined ? (
        <IconButton icon="x" label={dismissLabel} variant="plain" size="sm" onClick={onDismiss} />
      ) : null}
    </div>
  );
}
