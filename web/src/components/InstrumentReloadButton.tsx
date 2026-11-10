import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HistoryStatusResponse } from "../lib/api-client.js";
import { instrumentHistoryReloadMutationOptions } from "../lib/queries.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { messageForError } from "../lib/problem-messages.js";
import { Button } from "./ui/index.js";

/**
 * IB13 (FR-193, AC-15/AC-21) — **the** reload affordance:
 * `POST /instruments/:id/history-reload`, rendered as one button.
 *
 * **One component, four call sites, never four implementations** — re-derived
 * 2026-09-10 by grepping for `<InstrumentReloadButton`, because the count in
 * this comment had gone stale twice over: it named `InstrumentTable`, which
 * dropped the affordance when its whole row became an anchor, and it did not
 * name the detail screen, where the control went instead. The four are:
 *
 *  - `InstrumentCardList` (the Instruments screen, mobile — on every catalogue
 *    row, and on a default-view row whose history status is `FAILED`;
 *    `showReloadAffordance` is the shared predicate);
 *  - `InstrumentDetailView` (one instrument, unconditional — there is no
 *    per-row predicate to apply to a screen showing one row);
 *  - `ControlsTable.tsx`'s shared `ControlRowActions` (Contrôles, both
 *    breakpoints, the same `FAILED` condition). Contrôles' own header used to
 *    record that it had no « relancer l'import » row action because nothing
 *    existed behind one; the endpoint now exists, and this is the action that
 *    absence was blocking;
 *  - `WatchlistTable.tsx`'s shared `WatchlistRowActions` (Suivi, both
 *    breakpoints — `watchlist` FR-345), unconditional and with
 *    `historyStatus` deliberately `undefined`: that screen fetches no per-row
 *    history status, because a per-row read is exactly the fan-out its design
 *    refuses, and this prop is presentation-only (see it below).
 *
 * **This component is unmodified by the watchlist cycle** — the new surface is
 * a call site, not an edit.
 *
 * **What it does and does not claim.** It offers *one deliberate reload*, now.
 * It promises no automatic retry (NG1 — nothing in this app retries a `FAILED`
 * backfill on its own, and no copy here says otherwise) and reports no failure
 * reason (NG2 — the reason is not stored). The `202` is an *acceptance*, not a
 * completion: the worker writes rows minutes later, so the confirmation says
 * only that the récupération was relancée, and the row's own status badge —
 * refreshed by the mutation's single `["instruments", id, "history-status"]`
 * invalidation, the whole refresh mechanism on list surfaces (IB13, no
 * polling) — is what reports where it actually got to.
 *
 * **Disabled precisely while its own mutation is in flight** (`loading`, which
 * `Button` turns into `disabled` + `aria-busy`), and never on the row's
 * *status*: on a freshly deployed stack every seeded catalogue row starts
 * `PENDING` (IB9), so gating on a non-terminal status would disable the
 * affordance across almost the whole catalogue. A reload requested while a run
 * is genuinely in flight is answered `409 HISTORY_RELOAD_IN_PROGRESS`, which
 * says exactly that in French through {@link messageForError} — the server's
 * own answer, not a guess this component makes from possibly-stale data.
 *
 * Every rejection renders through `messageForError` (never the server's
 * English `title`/`detail`, FR-128/AC120): the 429 cap, the 409, the
 * FUND/INDEX 400, the 503 of an unconfigured deployment, and the 404 that
 * covers "no such instrument" and "another tenant's instrument"
 * indistinguishably (AC-13/AC-14 — the same authorization the backend
 * enforces, reached from this surface with no client-side pre-check that could
 * disagree with it).
 */
export interface InstrumentReloadButtonProps {
  readonly instrumentId: string;
  /**
   * The row's current status, as the caller already read it
   * (`instrumentHistoryStatusQueryOptions`) — `undefined` while that one-shot
   * read is still in flight or has failed. Used for presentation only: a
   * `FAILED` row is the one the Contrôles/Instruments surfaces flag as
   * needing action, so it gets the `soft` emphasis, and the status is echoed
   * on `data-history-status` so a test can bind an assertion to the row's
   * state rather than to its position.
   */
  readonly historyStatus: HistoryStatusResponse | undefined;
  readonly testId?: string;
}

export function InstrumentReloadButton({
  instrumentId,
  historyStatus,
  testId = "instrument-reload",
}: InstrumentReloadButtonProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation(instrumentHistoryReloadMutationOptions(queryClient));
  const failed = historyStatus?.status === "FAILED";

  return (
    <span className="k-inst-reload">
      <Button
        size="sm"
        variant={failed ? "soft" : "ghost"}
        iconLeft="refresh-cw"
        data-testid={testId}
        data-history-status={historyStatus?.status}
        loading={mutation.isPending}
        onClick={() => mutation.mutate(instrumentId)}
      >
        {INSTRUMENT_COPY.reloadHistory}
      </Button>
      {mutation.isError && (
        <span role="alert" data-testid={`${testId}-error`} className="k-inst-reload-note">
          {messageForError(mutation.error).text}
        </span>
      )}
      {mutation.isSuccess && (
        <span role="status" data-testid={`${testId}-accepted`} className="k-inst-reload-note">
          {INSTRUMENT_COPY.reloadAccepted}
        </span>
      )}
    </span>
  );
}
