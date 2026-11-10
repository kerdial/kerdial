import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LOADING_OR_FAILED_MESSAGE,
  isTerminalStatus,
  statusMessage,
} from "../lib/history-status-copy.js";
import { instrumentHistoryStatusQueryOptions } from "../lib/queries.js";

/**
 * IC-16 — the calm "history en cours" indication, resolved by polling
 * `GET /instruments/:id/history-status`. Decision D9 confines this
 * component's own mount points to exactly two surfaces
 * (`InstrumentCreateDialog.tsx`'s success panel and the holdings row/table),
 * but the component itself carries **no** knowledge of either: its props are
 * `instrumentId` alone — nothing dialog-specific or table-specific, so a
 * future price-history/instrument-detail screen
 * (spec NG9, `[P1-LATER]`) can mount this unchanged.
 *
 * **Whether to mount this component at all for a given instrument (a FUND
 * never gets a backfill, AC-14) is the caller's responsibility, not this
 * component's** — `getInstrumentBackfillStatus`'s own `"NONE"` case
 * (`ledger/src/instrument-backfill-status-service.ts`) is indistinguishable,
 * from this component's point of view, between "not yet requested" (a
 * fresh, still-registering SHARE/ETF/CRYPTO/INDEX) and "never requested at
 * all" (FUND) — only the caller, which already knows the instrument's
 * `kind` from its own create/list response, can tell the two apart.
 *
 * **Poll-stop discipline (this cycle's binding rule: a polling component
 * that never stops is a production hazard — battery/quota/needless load):**
 * `refetchInterval` is a function re-evaluated on every scheduling decision,
 * returning `false` (no further poll) at whichever of these comes first —
 * a terminal status (`COMPLETE`/`FAILED`/`NONE`), the `POLL_CEILING_MS`
 * (2 minutes) elapsed since *this component instance* mounted, or the
 * component unmounting (TanStack Query's own observer lifecycle:
 * `refetchInterval` simply never fires again once this is the query's last
 * active observer and it is torn down — nothing here needs to detect that
 * explicitly).
 *
 * **F-3 (security review): `"NONE"` is terminal, not merely "not finished
 * yet".** Nothing in this system ever creates an `instrument_backfill_state`
 * row for an instrument on its own — a row is only ever inserted by
 * `ensureInstrumentBackfillRequested`, called exactly once, synchronously
 * (`await`ed before the `201` is ever returned), from
 * `InstrumentsController#create`'s own post-commit trigger. So by the time
 * this component's very first poll can possibly run (it only ever mounts
 * after that `201` — the success panel, or a holdings row fetched afterward)
 * either that row already exists (`PENDING` at worst) or it never will:
 * `MARKET_RUNTIME` was `null` at creation time (DD4, permanently no
 * backfill for this app instance), the instrument's `kind` has no backfill
 * route at all (FUND, AC-14 — though the caller is not supposed to
 * mount this component for those in the first place), or the best-effort
 * trigger itself failed and was swallowed (`#triggerInstrumentBackfill`'s own
 * doc comment) — and nothing retries creating a *missing* row: the hourly
 * reconcile sweep (`reconcilePendingInstrumentBackfills`) only re-enqueues
 * rows that already exist and are `PENDING`. Before this fix, every
 * pre-existing holding (every instrument created before migration 0029
 * granted `app_web` the row it would need) polled the full 2-minute ceiling
 * on every single page view for an answer that could never change — a
 * `NONE` this component ever observes is either the whole story or will stay
 * `NONE` forever; either way, more polling cannot help. Paired with F-7's
 * point: `"NONE"` therefore also gets its own honest copy below, distinct
 * from "en cours" — claiming a fetch is in progress when nothing was ever
 * queued is exactly the kind of false status this codebase refuses
 * elsewhere.
 *
 * **UR-11:** the copy
 * this component renders (`statusMessage`/`TERMINAL_STATUSES`) now lives in
 * `../lib/history-status-copy.ts` — a pure
 * move, so a future per-row surface (Operations, Instruments list) can reuse
 * the *copy* without mounting a second instance of this component's own
 * polling *lifecycle* (this component's `refetchInterval`/2-minute ceiling
 * stay exactly as documented above, unchanged by the move). The query itself
 * now also routes through `cheapReadBudget` (`instrumentHistoryStatusQueryOptions`,
 * `../lib/queries.ts`) — the fix for this component's own documented
 * "20 pollers, no client-side cap" fan-out on a realistic 30-holding view
 * (`web/e2e/holdings-history-status-request-volume.spec.ts`).
 */
export interface InstrumentHistoryStatusProps {
  readonly instrumentId: string;
}

const POLL_INTERVAL_MS = 3_000;
/** The 2-minute ceiling, one of the three stop conditions. */
const POLL_CEILING_MS = 120_000;

export function InstrumentHistoryStatus({ instrumentId }: InstrumentHistoryStatusProps) {
  // Captured once, on this component instance's first render — the "2-minute
  // ceiling" is measured from when *this view* started polling, not from
  // the query cache entry's own age (a different view re-mounting later for
  // the same instrument gets its own fresh ceiling).
  const startedAtRef = useRef(Date.now());

  const query = useQuery({
    ...instrumentHistoryStatusQueryOptions(instrumentId),
    refetchInterval: (activeQuery) => {
      const data = activeQuery.state.data;
      if (data !== undefined && isTerminalStatus(data.status)) return false;
      if (Date.now() - startedAtRef.current >= POLL_CEILING_MS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  const message =
    query.data !== undefined
      ? statusMessage(query.data)
      : // Never a raw error, never a silently blank state (AC-16) — while
        // loading, and on a fetch failure alike, the same calm "en cours"
        // copy is shown; the next scheduled poll (bounded by the ceiling
        // above) will resolve it once the endpoint answers.
        LOADING_OR_FAILED_MESSAGE;

  return (
    <div data-testid="instrument-history-status" className="k-inst-note">
      <p role="status">{message}</p>
    </div>
  );
}
