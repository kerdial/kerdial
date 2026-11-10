import type { HistoryStatusResponse } from "./api-client.js";

/**
 * `history-status-copy.ts` — UR-11.
 *
 * Pure move out of `InstrumentHistoryStatus.tsx`: `TERMINAL_STATUSES`
 * (including `NONE`, which is terminal because polling cannot observe its
 * transition — see the set's own comment — never revisited by this move),
 * `formatIsoDateFr` and `statusMessage` moved here
 * **verbatim** — no behaviour change — so a future surface (the Operations
 * screen, UR-30; the Instruments list, UR-27) can reuse the exact same
 * rendering copy without mounting a second, independent
 * `InstrumentHistoryStatus` polling lifecycle per row (L3/L4: that
 * component owns a `refetchInterval` and a per-*instance* 2-minute poll
 * ceiling — N rows would mean N independent pollers with N ceilings, which
 * is exactly the pattern this extraction exists to close). Those surfaces
 * issue a **one-shot** `instrumentHistoryStatusQueryOptions` read instead
 * and render through the functions below.
 *
 * `InstrumentHistoryStatus.tsx` itself now imports these instead of defining
 * them — its own polling behaviour, three stop conditions, and 2-minute
 * per-instance ceiling are otherwise unchanged.
 */

export const TERMINAL_STATUSES = new Set<HistoryStatusResponse["status"]>([
  "COMPLETE",
  "FAILED",
  // F-3 (security review). **Membership
  // unchanged; the reasoning corrected** (`instrument-catalogue-backfill`
  // finding 3, IB13): the original argument was "nothing ever
  // creates a state row for an instrument that does not already have one", and
  // that is now false — IB9's migration-time seeding creates `PENDING` rows
  // for the whole catalogue at install, and IB1's reload creates one for any
  // instrument a user asks to reload. What is still true is the property this
  // set actually needs: **polling cannot observe the transition**, because
  // every one of those creations is caused by something outside this
  // component's poll (a migration, or a user action whose own mutation
  // invalidates `["instruments", id, "history-status"]` directly — IB13's one
  // invalidation, which is what makes the transition visible without a poller
  // for it). Re-polling a `NONE` on a hope would be a fan-out with no event to
  // wait for.
  "NONE",
]);

export function isTerminalStatus(status: HistoryStatusResponse["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * `"2026-08-15"` -> `"15/08/2026"` — plain string manipulation (no numeric
 * parsing, so `web/src`'s "no bare `Number()`/`.toFixed()`" lint rule has
 * nothing to catch here — there is no number to convert or format, only a
 * rearrangement of an already-validated ISO date string).
 */
export function formatIsoDateFr(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * The exact French copy, one string per status, plus
 * `"NONE"`'s own honest string (F-3/F-7, security review — the
 * original copy predates this fix and does not enumerate a `"NONE"`-specific copy;
 * see `InstrumentHistoryStatus.tsx`'s own (pre-move) doc comment for why
 * `"NONE"` is no longer treated as "not finished yet" and therefore needs
 * one).
 */
export function statusMessage(data: HistoryStatusResponse): string {
  switch (data.status) {
    case "COMPLETE":
      return data.earliestBackfilledDate !== null
        ? `Historique disponible depuis le ${formatIsoDateFr(data.earliestBackfilledDate)}.`
        : "Historique disponible.";
    case "FAILED":
      // UR-36 honesty fix (the blocked
      // register). This string previously promised that "une nouvelle
      // tentative aura lieu automatiquement" — which is **false**: nothing
      // retries a `FAILED` backfill on its own, and the internal reconcile job
      // explicitly skips it (`market/ingestion/src/instrument-backfill-job.ts:806-810`).
      // The original copy predates that finding; UR-36's own AC
      // ("no empty/error state implies a capability that is blocked") is
      // the newer, higher-precedence rule, and `empty-state-copy-audit.test.ts`
      // enforces it here too.
      //
      // **Finding 1 (`instrument-catalogue-backfill`, IB13):** that
      // reasoning used to rest on there being no route that could ever retry
      // one. A later change built one (`POST /instruments/:id/history-reload`), so one clause of
      // the old argument is now false and is corrected here in the same edit
      // as the copy. Both halves that still hold are kept and still hold: **no
      // automatic retry** (NG1 — the reload is a deliberate user action, never
      // something this app does on its own) and **no failure reason** (NG2 —
      // it is not stored, so it cannot be shown). The added sentence names
      // where the control actually lives rather than assuming one is adjacent:
      // this string also renders on the holdings rows and the creation dialog,
      // neither of which mounts `InstrumentReloadButton`.
      //
      // It used to say « depuis la liste des instruments ». That stopped being
      // true when the desktop table dropped its action column (the whole row
      // became the link to the detail screen, and a button inside an anchor is
      // invalid HTML), and the reload moved to the instrument's own page. The
      // sentence now names *that* page, which is the one destination every
      // surface rendering this string can reach and which mounts the control
      // unconditionally — the mobile card list and Contrôles still carry their
      // own buttons, so pointing at the instrument page is a floor, not a
      // detour.
      return (
        "La récupération de l'historique s'est arrêtée en échec ; la cause n'est pas conservée " +
        "par l'application. Vous pouvez relancer la récupération depuis la fiche de l'instrument."
      );
    case "NONE":
      return "Aucune récupération automatique de l'historique n'a été demandée pour cet instrument.";
    case "PENDING":
    case "IN_PROGRESS":
      return "Historique des cours en cours de récupération — cela peut prendre quelques minutes.";
  }
}

/**
 * IR-14 (OD-9(a); FR-26/
 * FR-27, AC-31/AC-32) — the best-effort disclosure sentence.
 *
 * **The date comes from `earliestBackfilledDate` and from nowhere else.** Not
 * from `BACKFILL_YEARS`, not from `requestedFrom`, not from a constant: what
 * the app holds is what the provider actually had, and for a company that
 * listed in 2014 that is 2014 no matter what a 20-year window asked for
 * (AC-31, the `ENX.PA` class). Which is also why **no copy anywhere states a
 * history length** — a "20 ans d'historique" claim would be false for every
 * instrument younger than the window, and
 * `routes/instrument-history-disclosure.test.tsx` greps `web/src/**` for
 * exactly that claim rather than trusting this comment.
 *
 * Predecessor splices are deliberately **not** annotated (OD-9(a): there is no
 * data source for splice points), and this sentence deliberately does not
 * claim the series is the named entity's own trading history — only that data
 * is available from that date.
 *
 * When nothing has been retrieved yet the sentence becomes a calm statement of
 * that fact rather than a blank line: the card must always say something.
 */
export function availableSinceMessage(data: HistoryStatusResponse): string {
  return data.earliestBackfilledDate !== null
    ? `Données disponibles depuis le ${formatIsoDateFr(data.earliestBackfilledDate)}.`
    : "Aucune donnée de cours n'est disponible pour le moment.";
}

/**
 * The same "en cours" copy shown while loading and on a fetch failure alike
 * (AC-16) — never a raw error, never a silently blank state.
 */
export const LOADING_OR_FAILED_MESSAGE =
  "Historique des cours en cours de récupération — cela peut prendre quelques minutes.";
