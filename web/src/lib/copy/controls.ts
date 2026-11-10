/**
 * `copy/controls.ts` — the **Contrôles** screen.
 *
 * `ControlsRoute.tsx`, `ControlsTable.tsx` and `ControlsCardList.tsx`, whose
 * strings were inline until this issue.
 *
 * **This module is inside `controls-copy-audit.test.ts`'s file list, and that
 * is the reason it is its own module rather than a section of a shared one.**
 * FR-123/AC115: nothing on this screen may imply a change-log or an
 * edit-history capability, because `transaction_revision` has no `GET` route.
 * The audit enforces that by scanning a hard-coded list of the files this
 * screen is made of — so a screen whose copy moved into a *shared* table would
 * have moved out from under its own audit, and the audit would have stayed
 * green by reading files that no longer contain the copy. The word « journal »
 * is banned here and perfectly fine on the Activité screen, which is exactly
 * why the two cannot share a table.
 */
export type ControlsCopyKey =
  | "screenTitle"
  | "screenSubtitle"
  | "refreshValuation"
  | "instrumentCheckProgress"
  | "dataFetchedAt"
  | "actionRequired"
  | "actionRequiredOutOf"
  | "fetchesFailed"
  | "fetchesRunning"
  | "scanErrorPrefix"
  | "scanLoading"
  | "truncatedNote"
  | "loadingControls"
  | "noInstruments"
  | "openInstrument"
  | "enterPrice"
  | "openPortfolios"
  | "columnInstrument"
  | "columnDataState"
  | "columnCoverageFrom"
  | "columnHistory"
  | "columnRequestedFrom"
  | "columnLastAvailable"
  | "columnSignal"
  | "columnAction";

export const CONTROLS_COPY = {
  screenTitle: "Contrôles",
  screenSubtitle: "L'état des valorisations et des données de marché.",
  refreshValuation: "Rafraîchir la valorisation",
  instrumentCheckProgress: "Vérification des instruments",
  dataFetchedAt: "Données récupérées",
  actionRequired: "Action requise",
  /** `{count}` arrives already stringified — this table counts nothing itself. */
  actionRequiredOutOf: "sur {count} instruments",
  fetchesFailed: "Récupérations en échec",
  fetchesRunning: "Récupérations en cours",
  /** Followed by `messageForError(...).text` — never by the server's own `detail`. */
  scanErrorPrefix: "Impossible de vérifier l'historique complet des transactions :",
  scanLoading: "Recherche des instruments déjà vendus…",
  truncatedNote:
    "Historique analysé partiellement — les instruments vendus il y a longtemps peuvent manquer.",
  loadingControls: "Chargement des contrôles…",
  noInstruments:
    "Aucun instrument à surveiller pour le moment. Cette liste reflète les instruments détenus ou déjà transigés — elle se remplira dès la première transaction.",
  openInstrument: "Voir l'instrument",
  enterPrice: "Saisir un cours",
  openPortfolios: "Voir les portefeuilles",
  columnInstrument: "Instrument",
  columnDataState: "État des données",
  columnCoverageFrom: "Couverture depuis",
  columnHistory: "Historique",
  columnRequestedFrom: "Demandé depuis",
  columnLastAvailable: "Dernière donnée",
  columnSignal: "Signal",
  columnAction: "Action",
} as const satisfies Readonly<Record<ControlsCopyKey, string>>;
