import type { MouseEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WATCHLIST_COPY } from "../lib/copy/watchlist.js";
import { messageForError } from "../lib/problem-messages.js";
import {
  unwatchInstrumentMutationOptions,
  watchInstrumentMutationOptions,
} from "../lib/queries.js";
import { Button, IconButton } from "./ui/index.js";

/**
 * `<WatchToggle>` — watch / un-watch one instrument
 * (decision W-6; FR-371–
 * FR-375).
 *
 * **It fetches nothing.** `watched` is derived by the *caller* from
 * `watchedInstrumentIdsQueryOptions()` (`GET /watchlist/ids`, one cheap read of
 * ≤ 200 ids), mounted once per screen and looked up per row —
 * `watchedIds.has(instrumentId)`, the O(1) bounded-set pattern
 * `deriveHeldState` already establishes (`lib/queries/instrument-set.ts:85-93`).
 * A toggle that read its own state would turn one read per screen into one per
 * row, and `InstrumentResponse` gains no `watched` field either (the reason:
 * `hasIcon`'s required-second-parameter shape means a third such field is
 * an edit to five call sites, a `@ts-expect-error` pin, the wire type, the
 * OpenAPI assertions and the e2e mocks — all on the response surface AC-347
 * puts under a zero-assertions-modified gate).
 *
 * ## `"unknown"` is a third state, not a default of `false`
 *
 * While the ids query has produced no data — loading **or** error — the caller
 * passes `"unknown"`, and this control renders **disabled**, with an accessible
 * name that says the state is not known. It never renders « Suivre », which
 * would be a false claim about a row that may already be watched. `POST` is
 * idempotent server-side, so a wrong-direction *click* is harmless; the
 * **label** is the thing that must not lie, which is why the disabled state is
 * asserted on the accessible name and not merely on `disabled`.
 *
 * ## One glyph, two tones
 *
 * `eye` — already in the registry and already in
 * `lib/icon-registry-pin.test.ts`'s by-value pin. Watched vs not-watched is
 * expressed through `<IconButton>`'s existing `variant`, **not** a second
 * glyph: `eye-off` is not registered, and adding a name would mean editing
 * `Icon.tsx` *and* that pin test for a state a tone already carries.
 */
export interface WatchToggleProps {
  readonly instrumentId: string;
  /**
   * `true`/`false` once the caller's ids read has answered; `"unknown"` while
   * it has not — see this component's own doc comment for why that third state
   * exists rather than defaulting to `false`.
   */
  readonly watched: boolean | "unknown";
  readonly testId?: string;
  /**
   * The mobile instrument card shows the state as words, not a
   * lone eye — the same button, the same handler, its label made visible.
   */
  readonly showLabel?: boolean;
}

export function WatchToggle({
  instrumentId,
  watched,
  testId = "watch-toggle",
  showLabel = false,
}: WatchToggleProps) {
  const queryClient = useQueryClient();
  const watch = useMutation(watchInstrumentMutationOptions(queryClient));
  const unwatch = useMutation(unwatchInstrumentMutationOptions(queryClient));

  const pending = watch.isPending || unwatch.isPending;
  const failure = watch.error ?? unwatch.error;

  const label =
    watched === "unknown"
      ? WATCHLIST_COPY.watchStateUnknown
      : watched
        ? WATCHLIST_COPY.watchRemove
        : WATCHLIST_COPY.watchAdd;

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    // Both list surfaces render this inside a row whose own affordance is a
    // link; stopping propagation here keeps a click on the toggle from also
    // being read as "open the row".
    event.stopPropagation();
    if (watched === "unknown") return;
    if (watched) {
      unwatch.mutate(instrumentId);
      return;
    }
    watch.mutate({ instrumentId });
  };

  return (
    <span className="k-wl-toggle">
      {showLabel ? (
        <Button
          iconLeft="eye"
          variant={watched === true ? "soft" : "ghost"}
          size="sm"
          data-testid={testId}
          data-watched={watched === "unknown" ? "unknown" : String(watched)}
          aria-pressed={watched === "unknown" ? undefined : watched}
          disabled={watched === "unknown" || pending}
          onClick={toggle}
        >
          {label}
        </Button>
      ) : (
        <IconButton
          icon="eye"
          // The accessible name IS the state (never a colour, never a tone): the
          // three labels are distinct strings, and « Suivre » is unreachable
          // while the state is unknown.
          label={label}
          // `soft` for a watched row, `plain` for one that is not — the tone
          // reinforces the label rather than replacing it.
          variant={watched === true ? "soft" : "plain"}
          size="sm"
          data-testid={testId}
          data-watched={watched === "unknown" ? "unknown" : String(watched)}
          aria-pressed={watched === "unknown" ? undefined : watched}
          disabled={watched === "unknown" || pending}
          onClick={toggle}
        />
      )}
      {failure !== null && failure !== undefined && (
        <span role="alert" data-testid={`${testId}-error`} className="k-wl-toggle-note">
          {/* Never the server's own English `title`/`detail` (FR-128/AC120):
              the 429 cap, the 404 and the throttle all reach the user through
              `problem-messages.ts`'s French table, which names the watchlist
              cap's own number from `api-limits.ts`. */}
          {messageForError(failure).text}
        </span>
      )}
    </span>
  );
}
