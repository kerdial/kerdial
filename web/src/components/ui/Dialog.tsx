import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { IconButton } from "./IconButton.js";

/**
 * A centred modal, and the right-side drawer that shares its machinery.
 *
 * Built on `@radix-ui/react-dialog`, already a dependency and already the base
 * of every dialog in the app. The design governs appearance and props; Radix
 * governs focus trapping, scroll locking, Esc handling and the ARIA wiring.
 * Reimplementing that to match a prototype would trade behaviour the app
 * depends on for nothing.
 *
 * `variant="drawer"` is the design's right-side panel: 480px for the
 * transaction detail, 520px for add/edit, sliding in over 220ms on the shared
 * easing token. Modal widths are 468px for confirmations and 520px by default.
 *
 * **Only one right-side panel is open at a time** is a rule about the app's
 * state, not about this component — a drawer cannot know what else is open.
 * The call sites own that invariant; this component just makes both
 * shapes available from one place.
 */
export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: ReactNode;
  /** Test handle for the description node — e.g. the manual-price dialog's instrument identity line. */
  readonly descriptionTestId?: string;
  readonly footer?: ReactNode;
  /**
   * Render `children` directly instead of wrapping them in `.k-dialog-body` —
   * for callers whose body is a form component that owns its own
   * `k-dialog-body`/`k-dialog-foot` markup (`PortfolioNameForm`,
   * `InstrumentCreateForm`), or is conditional. The shell (portal, scrim,
   * content, header, close) stays shared either way.
   */
  readonly rawBody?: boolean;
  readonly variant?: "modal" | "drawer";
  /** Width in px. Defaults: 520 modal, 480 drawer. */
  readonly width?: number;
  readonly closeLabel?: string;
  /**
   * Test handle for the panel. The close button gets `${testId}-close`.
   *
   * Added after two screen restyles independently lost an e2e handle to this
   * component and worked around it by composing raw Radix with the kit's
   * classes — which keeps the appearance but forks the behaviour, exactly what
   * one shared primitive exists to prevent. A primitive that cannot be
   * addressed by the test suite will be routed around, so it takes the handle.
   */
  readonly testId?: string;
  /** Test handle for the close button; defaults to `${testId}-close`. */
  readonly closeTestId?: string;
  readonly children?: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  descriptionTestId,
  footer,
  rawBody = false,
  variant = "modal",
  width,
  closeLabel = "Fermer",
  testId,
  closeTestId,
  children,
}: DialogProps) {
  const resolvedWidth = width ?? (variant === "drawer" ? 480 : 520);

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="k-scrim" />
        <RadixDialog.Content
          data-testid={testId}
          className={`k-dialog k-dialog-${variant}`}
          style={{ maxWidth: `${resolvedWidth}px` }}
        >
          <header className="k-dialog-head">
            <div className="k-dialog-heading">
              <RadixDialog.Title className="k-dialog-title">{title}</RadixDialog.Title>
              {description !== undefined ? (
                <RadixDialog.Description
                  data-testid={descriptionTestId}
                  className="k-dialog-description"
                >
                  {description}
                </RadixDialog.Description>
              ) : (
                // Radix warns when `Content` has no `Description`; an explicit
                // opt-out is clearer than a hidden empty node.
                <RadixDialog.Description className="k-visually-hidden">
                  {title}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <IconButton
                icon="x"
                label={closeLabel}
                variant="plain"
                size="sm"
                data-testid={closeTestId ?? (testId === undefined ? undefined : `${testId}-close`)}
              />
            </RadixDialog.Close>
          </header>

          {rawBody ? children : <div className="k-dialog-body">{children}</div>}

          {footer !== undefined ? <footer className="k-dialog-foot">{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
