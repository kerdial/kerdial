import { useEffect } from "react";

/**
 * `Escape` closes a popover and stops there — the dialog or drawer behind it
 * stays open. Extracted unchanged from `AssetSearchPopover` (FD-4) so the
 * country picker inside the instrument dialog gets the same behaviour from the
 * same code.
 *
 * This cannot be done from the component's `onKeyDown`. Radix's
 * `DismissableLayer` — which every `Dialog`/drawer in this app is built on —
 * listens for `Escape` on `document` in the **capture** phase, so it sees the
 * key before React has dispatched a single synthetic event (React attaches its
 * own listeners to the root/portal container, both of which are *below*
 * `document`). `event.stopPropagation()` in an `onKeyDown` handler therefore
 * runs too late to stop it, and the dialog closes underneath the popover.
 *
 * A capture listener on `window` is one node earlier in the propagation path
 * than Radix's, so it runs first regardless of mount order. It stops
 * propagation (Radix's listener is never reached) and marks the event handled
 * (`preventDefault`, which Radix also honours) — belt and braces, deliberately,
 * because the ordering above is a property of a third-party module's internals.
 *
 * Scoped twice over, so the dialog's own `Escape` is untouched the rest of the
 * time: the listener exists only while the popover is `open`, and it ignores
 * any event whose target is outside the popover's own subtree (`rootRef`).
 * `close` should be stable across renders (a state setter or a `useCallback`),
 * or the listener is re-attached on every render.
 */
export function useEscapeClosesPopover(
  open: boolean,
  rootRef: { current: HTMLElement | null },
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    function onKeyDownCapture(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof Node) || !root.contains(target)) return;
      event.stopPropagation();
      event.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [open, rootRef, close]);
}
