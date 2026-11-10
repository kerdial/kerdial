import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";

/**
 * `copy/portfolios.ts` — the Portefeuilles list, the workspace and its cash
 * accounts.
 *
 * The list screen and its row figures, the per-portfolio workspace with its
 * five tabs, the create/edit/delete dialogs, the cash tab and the two cash
 * dialogs, and the dashboard's portfolio cards.
 *
 * **`deleteWarning` is itemised on purpose and stays that way.** It names every category of data destroyed, carries the
 * transaction count, states the action is irreversible — and never claims
 * forensic erasure, because the audit trail survives the portfolio. Reworded
 * casually, it becomes either a lie or a shrug.
 *
 * **The « Verrouillé » rows are not decoration either.** A cash account's
 * currency is immutable for the row's whole lifetime (OD-2), so the rename
 * dialog shows it locked rather than as a disabled input — the copy is what
 * says why.
 */
export type PortfolioCopyKey =
  // --- the list screen
  | "screenTitle"
  | "screenSubtitle"
  | "createPortfolio"
  | "loadingPortfolios"
  | "portfoliosPanel"
  | "rowValue"
  | "rowDayChange"
  | "rowDayChangeUnavailable"
  | "rowTwr"
  | "rowFigures"
  | "rowTransactions"
  | "rowCreatedAt"
  | "open"
  | "delete"
  // --- the workspace
  | "notFound"
  | "backToPortfolios"
  | "breadcrumb"
  | "breadcrumbPortfolios"
  | "detailSubtitle"
  | "loadingOverview"
  | "overviewPanel"
  | "tabsLabel"
  // --- the overview tab
  | "performance"
  | "seeDetail"
  | "loadingPerformance"
  | "performancePanel"
  | "twrCumulative"
  | "mwr"
  | "unavailable"
  | "from"
  | "to"
  | "subPeriods"
  | "mwrMethod"
  | "loadingAllocation"
  | "allocationPanel"
  | "allocation"
  | "allocationByAssetClass"
  | "unreconciled"
  | "refresh"
  | "topPositions"
  | "allPositions"
  | "miniAsset"
  | "miniQuantity"
  | "miniValue"
  | "miniWeight"
  // --- the performance tab and its blocks
  | "twr"
  | "twrCumulated"
  | "twrAnnualised"
  | "twrRangeDays"
  | "mwrRate"
  | "mwrMethodShort"
  | "mwrIterations"
  // --- the stat strip and the positions tab
  | "totalValue"
  | "costBasis"
  | "unrealized"
  | "loadingPositions"
  | "positionsPanel"
  // --- create / edit / delete
  | "createDialogTitle"
  | "editDialogTitle"
  | "createDialogDescription"
  | "editDialogDescription"
  | "nameField"
  | "createSubmit"
  | "editSubmit"
  | "edit"
  // --- the four presentation fields (`portfolio-details`, FR-475)
  | "brokerField"
  | "brokerPlaceholder"
  | "descriptionField"
  | "descriptionPlaceholder"
  | "accentField"
  | "accentNone"
  | "accentChart1"
  | "accentChart2"
  | "accentChart3"
  | "accentChart4"
  | "accentChart5"
  | "accentChart6"
  | "iconField"
  | "iconConstraints"
  | "iconChooseFile"
  | "iconReady"
  | "iconRemove"
  | "iconRemoveConfirm"
  | "iconRemoveCancel"
  | "iconNone"
  | "iconKept"
  | "iconFailed"
  | "deleteConfirm"
  | "deleteWarning"
  | "deleteAuditNotice"
  | "deleteLinkedTransfersNotice"
  | "deleteConfirmPrompt"
  | "deleteCalcEpochStale"
  // --- the cash tab
  | "loadingCash"
  | "cashPanel"
  | "cashArchivedBadge"
  | "cashOverdrawnBadge"
  | "cashUnarchive"
  | "cashArchive"
  | "cashEmptyTitle"
  | "cashEmptyExplanation"
  | "createCashAccount"
  | "cashAccountCountOne"
  | "cashAccountCountMany"
  | "cashAllArchived"
  | "cashArchivedGroup"
  | "cashHide"
  | "cashShow"
  | "cashArchivedExplanation"
  // --- the cash dialogs
  | "cashCreateDialogTitle"
  | "cashRenameDialogTitle"
  | "cashCreateDialogDescription"
  | "cashRenameDialogDescription"
  | "cashNameField"
  | "cashCurrencyField"
  | "cashLockedCurrency"
  | "cashLockedTag"
  | "cashCreateSubmit"
  | "cashRenameSubmit"
  | "cashUnarchiveDialogTitle"
  | "cashArchiveDialogTitle"
  | "cashArchiveDialogDescription"
  | "cashUnarchiveExplanation"
  | "cashArchiveExplanation"
  // --- the cash-account picker
  | "pickerNeedsPortfolio"
  | "pickerNeedsCurrency"
  | "pickerLoadError"
  | "pickerEmptyInCurrency"
  | "pickerEmpty"
  | "pickerCreateInCurrency"
  // --- the dashboard cards
  | "cardTotalValue"
  | "cardUnrealized"
  | "cardsPanelTitle"
  | "cardsSeeAll"
  // --- portfolio archive
  | "archivedBadge"
  | "archivePortfolio"
  | "unarchivePortfolio"
  | "archiveDialogTitle"
  | "archiveDialogExplanation"
  | "archivedGroup"
  | "archivedSuffix"
  | "allArchived"
  | "allArchivedLink";

export const PORTFOLIO_COPY = {
  screenTitle: "Portefeuilles",
  screenSubtitle: "Vos portefeuilles et ce qu'ils contiennent.",
  createPortfolio: "Créer un portefeuille",
  loadingPortfolios: "des portefeuilles",
  portfoliosPanel: "Portefeuilles",
  rowValue: "Valeur",
  rowDayChange: "Variation du jour",
  rowDayChangeUnavailable: "Clôture précédente inconnue pour au moins une position",
  rowTwr: "TWR",
  rowFigures: "Chiffres",
  rowTransactions: "Transactions",
  rowCreatedAt: "Créé le",
  open: "Ouvrir",
  delete: "Supprimer",

  notFound: "Portefeuille introuvable.",
  backToPortfolios: "Retour aux portefeuilles",
  breadcrumb: "Fil d'Ariane",
  breadcrumbPortfolios: "Mes portefeuilles",
  detailSubtitle: "Valorisation, positions et performance.",
  loadingOverview: "de la vue d'ensemble",
  overviewPanel: "Vue d'ensemble",
  tabsLabel: "Sections du portefeuille",

  performance: "Performance",
  seeDetail: "Voir le détail",
  loadingPerformance: "de la performance",
  performancePanel: "Performance",
  twrCumulative: "TWR cumulé",
  mwr: "MWR",
  unavailable: "Indisponible",
  from: "Du",
  to: "Au",
  subPeriods: "Sous-périodes",
  mwrMethod: "Méthode MWR",
  loadingAllocation: "de la répartition",
  allocationPanel: "Répartition",
  allocation: "Répartition",
  allocationByAssetClass: "Répartition par classe d'actifs",
  unreconciled: "Somme non réconciliée",
  refresh: "Actualiser",
  topPositions: "Principales positions",
  allPositions: "Voir toutes les positions",
  miniAsset: "Actif",
  miniQuantity: "Quantité",
  miniValue: "Valeur",
  miniWeight: "Poids",

  twr: "TWR",
  twrCumulated: "Cumulée",
  twrAnnualised: "Annualisée",
  twrRangeDays: "Période (jours)",
  mwrRate: "Taux",
  mwrMethodShort: "Méthode",
  mwrIterations: "Itérations",

  totalValue: "Valeur totale",
  costBasis: "Coût d'acquisition",
  unrealized: "+/− latente",
  loadingPositions: "des positions",
  positionsPanel: "Positions",

  createDialogTitle: "Nouveau portefeuille",
  editDialogTitle: "Modifier le portefeuille",
  createDialogDescription: "Donnez un nom à ce nouveau portefeuille.",
  editDialogDescription: "Modifiez les informations de « {name} ».",
  nameField: "Nom du portefeuille",
  createSubmit: "Créer le portefeuille",
  editSubmit: "Enregistrer",
  edit: "Modifier",

  brokerField: "Banque ou courtier",
  brokerPlaceholder: "Boursorama, Degiro, …",
  descriptionField: "Description",
  descriptionPlaceholder: "À quoi sert ce portefeuille ?",
  accentField: "Couleur d'accent",
  accentNone: "Aucune",
  /**
   * **The six labels below are hue words for a *slot* the token file owns, and
   * that is the point** (PD-3, A-6). The stored value is `CHART_1`…`CHART_6`,
   * never a hue: if `kerdial.css` ever re-points `--chart-3` from lilac to
   * something else, the obligation to re-word moves *here*, to one copy table,
   * instead of to every stored row. Read the six `--chart-N` declarations in
   * `web/src/styles/kerdial.css` before editing one of these.
   */
  accentChart1: "Turquoise",
  accentChart2: "Abricot",
  accentChart3: "Lilas",
  accentChart4: "Ciel",
  accentChart5: "Citron",
  accentChart6: "Encre",
  iconField: "Icône du portefeuille",
  /*
   * The three ceilings, **interpolated from the constants** rather than typed
   * as digits (`api-limits.ts`'s own rule), and deliberately the **instrument**
   * constants: FR-460 holds a portfolio icon to exactly the same 256 KiB /
   * 512 px / PNG-or-JPEG rules, and `setPortfolioIconBodySchema` *is*
   * `setInstrumentIconBodySchema` by identity on the server (PD-13). A
   * portfolio-specific pair of numbers here would be the one place the two
   * could disagree. `INSTRUMENT_COPY.iconConstraints`' own note records why no
   * formatter is involved (both values are under 999) and why the unit stays
   * « Ko ».
   */
  iconConstraints: `PNG ou JPEG, ${INSTRUMENT_ICON_MAX_BYTES / 1024} Ko maximum, ${INSTRUMENT_ICON_MAX_PIXELS} × ${INSTRUMENT_ICON_MAX_PIXELS} pixels maximum`,
  iconChooseFile: "Choisir une image",
  iconReady: "Prête à être enregistrée",
  iconRemove: "Supprimer l'icône",
  iconRemoveConfirm: "Supprimer l'icône de ce portefeuille ? Cette action est définitive.",
  iconRemoveCancel: "Conserver l'icône",
  iconNone: "Aucune icône pour ce portefeuille.",
  iconKept: "Icône actuelle conservée.",
  iconFailed: "Les informations ont été enregistrées, mais l'icône n'a pas pu l'être.",
  deleteConfirm: "Supprimer définitivement",
  /** Itemised, counted, irreversible, and silent about the audit trail that survives. */
  deleteWarning:
    "Le portefeuille « {name} », ses {count} transaction(s), ses soldes de trésorerie, ses positions, ses plus-values réalisées et son historique de valorisation seront définitivement supprimés. Cette action est irréversible.",
  /**
   * **AR-28 / ADR-0013 policy 2 — "audit retained, and said out loud"**
   *
   * `deleteWarning` above stays itemised, counted and irreversible, and stays
   * silent about the audit trail — that is a deliberate property that
   * this does not disturb. The disclosure is its own
   * line because it is a *different* fact: what survives, not what is
   * destroyed, and a reader who has just been told "définitivement supprimés"
   * needs the qualification separated rather than buried in the same sentence.
   *
   * **It deliberately does not offer account deletion as the way to erase
   * fully.** ADR-0013's policy 2 says the confirmation should point at it, but
   * `DELETE /account` is C23 — deferred, not built — and copy promising a
   * feature that does not exist is worse than copy that stops at the truth.
   * When C23 ships, this line gains that sentence; the ADR's clause is what
   * that work must satisfy.
   *
   * **And no backup window.** ADR-0013's 2026-08-27 amendment
   * is explicit: a dialog quoting a 30-day encrypted-backup window that no
   * longer exists must not ship. Phase 1 takes no backups, so there is no
   * bound to state and this says nothing about one.
   */
  deleteAuditNotice:
    "Un enregistrement d'audit des transactions supprimées est conservé pour l'intégrité du journal : « supprimer » ne signifie pas effacer cette trace.",
  /** `security-transfer` FR-580 (OD-7 (c)): shown only when this portfolio holds a leg of a linked transfer. */
  deleteLinkedTransfersNotice:
    "Les transferts liés à d'autres portefeuilles seront conservés dans ceux-ci, sans lien.",
  deleteConfirmPrompt: "Tapez « {name} » pour confirmer",
  deleteCalcEpochStale: "Portefeuille supprimé, chiffres non rafraîchis — actualisez.",

  loadingCash: "des comptes espèces",
  cashPanel: "Espèces",
  cashArchivedBadge: "Archivé",
  cashOverdrawnBadge: "Découvert",
  cashUnarchive: "Désarchiver",
  cashArchive: "Archiver",
  cashEmptyTitle: "Aucun compte espèce",
  cashEmptyExplanation:
    "Un compte espèce enregistre les mouvements d'argent de ce portefeuille dans une seule devise : dépôts, retraits, produits de vente, frais. Créez-en un pour commencer.",
  createCashAccount: "Créer un compte espèce",
  /** The count is the server's own `accountCount`, archived rows included — which is why the sentence says so. */
  cashAccountCountOne: "{count} compte dans ce total, comptes archivés inclus.",
  cashAccountCountMany: "{count} comptes dans ce total, comptes archivés inclus.",
  cashAllArchived:
    "Tous les comptes de cette devise sont archivés. Leur solde reste compté ci-dessus.",
  cashArchivedGroup: "Comptes archivés ({count})",
  cashHide: "Masquer",
  cashShow: "Afficher",
  cashArchivedExplanation:
    "Un compte archivé n'est plus proposé à la saisie. Ses écritures sont conservées et son solde reste compté dans le total de sa devise.",

  cashCreateDialogTitle: "Nouveau compte espèce",
  cashRenameDialogTitle: "Renommer le compte espèce",
  cashCreateDialogDescription:
    "Donnez un nom à ce compte et choisissez sa devise. La devise est définitive.",
  cashRenameDialogDescription:
    "Choisissez un nouveau nom pour « {name} ». Sa devise ne change pas.",
  cashNameField: "Nom du compte",
  cashCurrencyField: "Devise",
  cashLockedCurrency: "Devise :",
  cashLockedTag: "Verrouillé",
  cashCreateSubmit: "Créer le compte",
  cashRenameSubmit: "Renommer le compte",
  cashUnarchiveDialogTitle: "Désarchiver le compte espèce",
  cashArchiveDialogTitle: "Archiver le compte espèce",
  cashArchiveDialogDescription: "« {name} » ({currency})",
  cashUnarchiveExplanation:
    "Ce compte redeviendra proposé lors de la saisie d'une transaction. Rien d'autre ne change.",
  cashArchiveExplanation:
    "Ce compte ne sera plus proposé lors de la saisie d'une transaction. Ses écritures sont conservées et son solde continue d'être compté dans le total de sa devise.",

  pickerNeedsPortfolio: "Choisissez d'abord un portefeuille.",
  pickerNeedsCurrency: "Indiquez d'abord la devise de cette opération.",
  pickerLoadError: "Les comptes espèces de ce portefeuille n'ont pas pu être chargés.",
  /**
   * FR-257(2): the *filtered* copy names the currency because an account in
   * another one genuinely cannot be attributed to this leg; the unfiltered
   * copy must not, because after phase 1 that is no longer true and it would
   * be the last place in the product still asserting a removed constraint.
   */
  pickerEmptyInCurrency: "Aucun compte espèce en {currency} dans ce portefeuille.",
  pickerEmpty: "Aucun compte espèce dans ce portefeuille.",
  pickerCreateInCurrency: "Créer un compte en {currency}",

  cardTotalValue: "Valeur totale",
  cardUnrealized: "+/− latente",
  cardsPanelTitle: "Portefeuilles",
  cardsSeeAll: "Voir tous les portefeuilles",

  /**
   * portfolio-archive (PA-L1, PA-L3, PA-L5, PA-L9). Archiving is a display
   * flag only: the explanation must never suggest the portfolio leaves a
   * figure — it stays in every total, series and ledger (FR-599, FR-601).
   */
  archivedBadge: "Archivé",
  archivePortfolio: "Archiver le portefeuille",
  unarchivePortfolio: "Désarchiver",
  archiveDialogTitle: "Archiver le portefeuille",
  archiveDialogExplanation:
    "« {name} » ne sera plus proposé dans les listes de choix ni sur l'aperçu. Il reste compté dans tous les totaux, performances, dividendes et dans l'activité, et vous pourrez toujours y enregistrer des opérations.",
  archivedGroup: "Archivés ({count})",
  archivedSuffix: "(archivé)",
  allArchived: "Tous vos portefeuilles sont archivés",
  allArchivedLink: "Voir les portefeuilles",
} as const satisfies Readonly<Record<PortfolioCopyKey, string>>;
