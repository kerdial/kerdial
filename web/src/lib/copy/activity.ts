/**
 * `copy/activity.ts` — the **Activité** screen and its ledger.
 *
 * The journal itself, its two filter surfaces (the inline bar and the 368px
 * panel), the transaction table and its mobile card list, the income totals
 * panel, the dashboard's recent-transactions card, and the portfolio
 * workspace's Activité tab.
 *
 * **This screen is allowed to call itself a journal**, and that is precisely
 * why its copy is not in the same module as the Contrôles screen's:
 * `controls-copy-audit.test.ts` bans « journal » on Contrôles, where it would
 * imply the change-log FR-123/AC115 says does not exist. Here it is a plain
 * and accurate description of a chronological list of transactions.
 */
export type ActivityCopyKey =
  // --- the screen
  | "screenTitle"
  | "screenSubtitle"
  | "openFilters"
  | "viewTabs"
  | "loadingLedger"
  | "ledgerPanel"
  | "noMatchingTransactions"
  | "clearAll"
  | "nextPage"
  // --- income totals
  | "loadingIncome"
  | "incomePanel"
  | "windowNotFullyLoaded"
  | "windowTruncated"
  | "windowLabel"
  | "dividendsReceived"
  | "fees"
  | "feesHint"
  | "taxes"
  | "withholding"
  // --- the ledger table and cards
  | "columnDate"
  | "columnType"
  | "columnAsset"
  | "columnQuantity"
  | "columnUnitPrice"
  | "columnGrossAmount"
  | "columnFees"
  | "columnPortfolio"
  | "columnActions"
  | "rowWithholding"
  | "openDetail"
  | "cardFees"
  | "cardWithholding"
  // --- the filters, shared by the bar and the panel
  | "filterPortfolio"
  | "filterAllPortfolios"
  | "filterType"
  | "filterAllTypes"
  | "filterFrom"
  | "filterTo"
  | "filterInstrument"
  | "filterClearInstrument"
  | "filterInstrumentPlaceholder"
  | "activeFilters"
  | "removeFilter"
  // --- the panel only
  | "panelTitle"
  | "panelDescription"
  | "panelClose"
  | "panelReset"
  | "panelApply"
  | "filterCurrency"
  | "filterCurrencyHint"
  | "filterAllCurrencies"
  | "amountBounds"
  | "amountBoundsInCurrency"
  | "amountBoundsNeedCurrency"
  | "amountBoundsNote"
  | "amountMin"
  | "amountMax"
  // --- the dashboard card and the workspace tab
  | "recentTransactions"
  | "openLedger"
  | "loadingRecent"
  | "tabTitle"
  | "transactionCount"
  | "openPortfolioActivity"
  // --- the calendar tab
  | "loadingCalendar"
  | "calendarPanel"
  | "calendarTitle"
  | "calendarUnitCount"
  | "calendarUnitVolume"
  | "calendarCaption"
  | "measureLabel"
  | "measureCount"
  | "measureVolume"
  | "columnYear"
  | "columnTotal"
  | "detailNoTransaction"
  | "detailVolume"
  | "openMonthInLedger"
  | "rampLess"
  | "rampMore";

export const ACTIVITY_COPY = {
  screenTitle: "Activité",
  screenSubtitle: "Le journal complet de vos transactions.",
  openFilters: "Filtres",
  viewTabs: "Vues de l'activité",
  loadingLedger: "du journal",
  ledgerPanel: "Journal des transactions",
  noMatchingTransactions: "Aucune transaction ne correspond aux filtres sélectionnés.",
  clearAll: "Tout effacer",
  nextPage: "Page suivante",

  loadingIncome: "des revenus et frais",
  incomePanel: "Revenus & frais",
  windowNotFullyLoaded: "Période non entièrement chargée",
  /** `{window}` is the already-rendered period label — this table does not format dates. */
  windowTruncated:
    "Trop de transactions sur la période {window} pour être chargées entièrement : aucun total n'est affiché pour ne pas présenter un chiffre incomplet comme définitif. Réduisez la période sélectionnée pour obtenir un total.",
  windowLabel: "Période : {window}",
  dividendsReceived: "Dividendes reçus",
  /** FR-225: « Frais » is the cost less its tax component, « Taxes » is that component. Two tiles that add back up. */
  fees: "Frais",
  /** What « Frais » sums, now that it includes the FEE kind. */
  feesHint:
    "Frais des opérations (courtage, change, autres) et frais de portefeuille (droits de garde, tenue de compte), hors taxes.",
  taxes: "Taxes",
  withholding: "Retenue à la source",

  columnDate: "Date",
  columnType: "Type",
  columnAsset: "Actif",
  columnQuantity: "Quantité",
  columnUnitPrice: "Prix unitaire",
  columnGrossAmount: "Montant brut",
  columnFees: "Frais",
  columnPortfolio: "Portefeuille",
  columnActions: "Actions",
  rowWithholding: "Retenue",
  openDetail: "Voir le détail",
  /** Card-list separators, spacing included: they join two figures on one line. */
  cardFees: " · frais ",
  cardWithholding: " · retenue ",

  filterPortfolio: "Portefeuille",
  filterAllPortfolios: "Tous les portefeuilles",
  filterType: "Type",
  filterAllTypes: "Tous types",
  filterFrom: "Du",
  filterTo: "Au",
  filterInstrument: "Instrument",
  filterClearInstrument: "Effacer l'instrument",
  filterInstrumentPlaceholder: "Rechercher (symbole, ISIN, nom)",
  activeFilters: "Filtres actifs",
  removeFilter: "Retirer le filtre : {filter}",

  panelTitle: "Filtres",
  panelDescription: "Ces filtres s'appliquent au journal entier, pas seulement à la page affichée.",
  panelClose: "Fermer les filtres",
  panelReset: "Réinitialiser",
  panelApply: "Appliquer",
  filterCurrency: "Devise de la transaction",
  filterCurrencyHint:
    "Les lignes réglées en titres n'ont pas de devise : choisir une devise les exclut toutes.",
  filterAllCurrencies: "Toutes devises",
  amountBounds: "Montant brut",
  /** Appended to `amountBounds` once a currency is chosen — an amount bound cannot leave its currency. */
  amountBoundsInCurrency: " (en {currency})",
  amountBoundsNeedCurrency:
    "Choisissez d'abord une devise : les montants ne sont pas convertis, une borne ne vaut que dans la devise de la transaction.",
  amountBoundsNote: "Bornes incluses, sur le montant brut de la transaction, en {currency}.",
  amountMin: "Minimum",
  amountMax: "Maximum",

  recentTransactions: "Dernières transactions",
  openLedger: "Ouvrir le journal",
  loadingRecent: "des dernières transactions",
  tabTitle: "Activité",
  transactionCount: "Transactions enregistrées",
  openPortfolioActivity: "Voir l'activité de ce portefeuille",

  loadingCalendar: "du calendrier",
  calendarPanel: "Calendrier de l'activité",
  calendarTitle: "Calendrier",
  /** What the cells encode, beside the title — one of the two, per the measure toggle; the volume one has the base currency appended by the caller. */
  calendarUnitCount: "transactions",
  calendarUnitVolume: "volume",
  calendarCaption: "Transactions par année et par mois",
  /** The measure toggle's accessible name and its two segments. */
  measureLabel: "Mesure",
  measureCount: "Nombre",
  measureVolume: "Montant",
  /** The row-header column's accessible name — the visible header is empty, the years below it speak for themselves. */
  columnYear: "Année",
  /** The calendar's last column: the year's own figure from `years[]`, not a re-sum of its cells. */
  columnTotal: "Total",
  detailNoTransaction: "aucune transaction",
  /** After the volume figure: « 1 234,00 EUR échangés ». */
  detailVolume: "échangés",
  openMonthInLedger: "Voir dans le journal",
  rampLess: "moins",
  rampMore: "plus",
} as const satisfies Readonly<Record<ActivityCopyKey, string>>;

/** « 4 transactions » / « 1 transaction » — the count with its noun, for the detail line and the cells' accessible names. */
export function transactionsCopy(count: number): string {
  return `${String(count)} ${count === 1 ? "transaction" : "transactions"}`;
}
