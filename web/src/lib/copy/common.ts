/**
 * `copy/common.ts` — the words that belong to no single screen.
 *
 * Everything here is used by more than one surface. A string that only one
 * screen renders belongs in that screen's own module, not here: a shared table
 * is where two screens quietly start meaning different things by the same
 * label, and the fix for "Fermer" appearing twice is not to widen this file
 * but to notice that both dialogs close.
 *
 * The inverse mistake is worse, and it is the one this file exists to prevent:
 * eleven components each writing « Indisponible » is eleven places to change
 * when the translation lands, and eleven chances for one of them to say
 * something slightly different in the meantime.
 */
export type CommonCopyKey =
  | "cancel"
  | "close"
  | "save"
  | "delete"
  | "edit"
  | "rename"
  | "archive"
  | "remove"
  | "clear"
  | "loading"
  | "unavailable"
  | "total"
  | "offlineExplanation";

export const COMMON_COPY = {
  cancel: "Annuler",
  close: "Fermer",
  save: "Enregistrer",
  delete: "Supprimer",
  edit: "Modifier",
  /**
   * The *cash account* rename (`PortfolioDetailCashTab.tsx`) — this key's only
   * consumer since `portfolio-details` PD-T11. A portfolio is no longer merely
   * renamed (`PORTFOLIO_COPY.edit`, « Modifier »), so the superseded
   * `PORTFOLIO_COPY.rename` was deleted rather than left serving a cash
   * account from a portfolio table.
   */
  rename: "Renommer",
  archive: "Archiver",
  remove: "Retirer",
  clear: "Effacer",
  /** U+2026, never three periods — matching every other ellipsis this app already ships. */
  loading: "Chargement…",
  /** *No figure*, said once. Never "N/A", never an empty cell. */
  unavailable: "Indisponible",
  total: "Total",
  /**
   * Why every write affordance is disabled offline (no
   * write is ever queued). It stood as an identical `const OFFLINE_EXPLANATION`
   * in **five** components — `NewTransactionButton`, `NewInstrumentButton`,
   * `AddTransactionEmptyAction`, `PortfolioDeleteDialog`,
   * `CashAccountArchiveDialog` — which is exactly the drift this table exists
   * to remove: five copies is five chances for one to fall out of step, and
   * none of them was wrong yet only because nobody had edited one.
   */
  offlineExplanation:
    "Indisponible hors ligne : les écritures ne sont jamais mises en file d'attente.",
} as const satisfies Readonly<Record<CommonCopyKey, string>>;
