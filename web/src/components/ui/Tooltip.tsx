import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * The de-jargoning affordance: one short sentence, at the point of use.
 *
 * The rule: "Kerdial never asks the reader to already know a term it
 * uses." The *content* of those explanations is `lib/copy/glossary.ts`; this is the mechanism.
 *
 * Built on Radix, and it relies on the single `Tooltip.Provider` already
 * mounted at the app root (`AppShell.tsx`) rather than mounting its own — a
 * provider per tooltip never coordinates hover delays with its neighbours,
 * which matters as soon as a virtualised table renders a column of them. That
 * reasoning is `Figure.tsx`'s, and it applies unchanged here.
 *
 * **`children` must be focusable.** `Trigger asChild` clones the child and
 * attaches its handlers to it; a bare `<span>`/`<dt>`/`<th>` is not in the tab
 * order, so the tooltip would open on hover and be unreachable by keyboard —
 * shipped, and invisible in every test that only checks the text. Every
 * production caller goes through `GlossaryHint.tsx`, which supplies a real
 * `<button>` precisely so that cannot happen once; `Figure.tsx` wraps its own
 * figure span and reaches focus through Radix's own trigger semantics, which
 * is why it keeps using `RadixTooltip` directly rather than this wrapper.
 */
export interface TooltipProps {
  readonly label: ReactNode;
  readonly placement?: "top" | "bottom";
  /** `data-testid` on the tooltip *content* — the only handle a test has on a portalled node. */
  readonly contentTestId?: string;
  /** Must be focusable — see this component's own note. */
  readonly children: ReactNode;
}

export function Tooltip({ label, placement = "top", contentTestId, children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={placement}
          sideOffset={6}
          className="k-tooltip"
          data-testid={contentTestId}
        >
          {label}
          <RadixTooltip.Arrow className="k-tooltip-arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
