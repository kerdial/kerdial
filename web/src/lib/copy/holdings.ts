/**
 * `copy/holdings.ts` — the **Positions** screen and the allocation surfaces.
 *
 * The screen, its table and mobile card list, the dashboard's top-positions
 * card and the exposure strip.
 *
 * **Three "répartition indisponible" sentences, and they are three.** They name
 * three different reasons — the total is not usable, the total cannot be
 * established, the parts do not sum to the total — and `allocation.ts`
 * suppresses the roll-up in each. Merging them into one would replace a stated
 * reason with a shrug, which is the failure this codebase's honesty rules keep
 * naming: a bar of estimated widths, or a message that could mean anything, in
 * place of an admission.
 */
export type HoldingsCopyKey =
  // --- the screen
  | "screenTitle"
  | "screenSubtitle"
  | "refreshQuotes"
  | "loadingPositions"
  | "positionsPanel"
  | "totalValue"
  | "unrealized"
  | "costBasis"
  | "viewTabs"
  | "tabPositions"
  | "tabClosed"
  | "tabAllocation"
  | "allocationByKind"
  | "allocationTotalUnavailable"
  | "allocationUnreconciled"
  // --- the Répartition map
  | "mapRegion"
  | "mapLegendLabel"
  | "mapLegendLoss"
  | "mapLegendFlat"
  | "mapLegendGain"
  | "mapLegendUnknown"
  | "mapShareSuffix"
  | "mapUnrealizedSuffix"
  | "mapEmpty"
  // --- the table and the card list
  | "columnActions"
  | "enterPrice"
  | "rowMenu"
  | "countOne"
  | "countMany"
  | "openInstrument"
  | "addTransaction"
  | "openTransactions"
  | "cardQuantity"
  | "cardAveragePrice"
  | "cardCurrentPrice"
  | "cardAllocation"
  | "cardUnrealized"
  | "cardSortBy"
  | "cardSortAscending"
  | "cardSortDescending"
  // --- the dashboard panels
  | "exposureTotalUnavailable"
  | "exposureUnreconciled";

export const HOLDINGS_COPY = {
  screenTitle: "Positions",
  screenSubtitle: "Toutes vos lignes, valorisées et pondérées.",
  refreshQuotes: "Actualiser les cours",
  loadingPositions: "des positions",
  positionsPanel: "Positions",
  totalValue: "Valeur totale",
  /** U+002B, then U+2212 MINUS SIGN — the mandated glyph, not a hyphen. */
  unrealized: "+/− latente",
  costBasis: "Coût d'acquisition",
  viewTabs: "Vue des positions",
  /**
   * `"Positions"` → `"Ouvertes"` (CP-8): the strip now offers **Ouvertes | Clôturées |
   * Répartition**, and a tab called « Positions » sitting beside a tab called
   * « Clôturées » would read as "positions, and also these other things that
   * are somehow not positions". The **key name is unchanged** so every call
   * site keeps working; only the string a user reads moved.
   *
   * Safe because no test and no e2e spec matches this value *as a tab*: every
   * `"Positions"` match across `web/e2e/` is `getByRole("link", …)` in the
   * primary or mobile nav (whose label is `SHELL_COPY`'s, untouched), and a
   * tab is `role="tab"`. `HOLDINGS_COPY.screenTitle`/`positionsPanel` — the
   * screen's own heading and its error panel's label — are also still
   * « Positions », which is what those specs' page-level assertions read.
   */
  tabPositions: "Ouvertes",
  tabClosed: "Clôturées",
  tabAllocation: "Répartition",
  allocationByKind: "Répartition par type d'actif",
  allocationTotalUnavailable:
    "Répartition indisponible : la valeur totale ne peut pas être établie.",
  allocationUnreconciled: "Somme non réconciliée",
  /** The map's own accessible name — the tab label says what the tab is, this says what the region is. */
  mapRegion: "Carte des positions, par poids et plus-value latente",
  mapLegendLabel: "Couleur : plus-value latente",
  mapLegendLoss: "Perte",
  mapLegendFlat: "Stable",
  mapLegendGain: "Gain",
  /** Named, not omitted: a grey tile means « nothing to measure a return against », not « flat ». */
  mapLegendUnknown: "Non mesurable",
  /** Suffixes for a tile's tooltip, which spells out what the two figures on it are. */
  mapShareSuffix: "du portefeuille",
  mapUnrealizedSuffix: "de plus-value latente",
  mapEmpty: "Aucune ligne pondérable à représenter.",

  columnActions: "Actions",
  enterPrice: "Saisir un cours",
  rowMenu: "Actions pour {name}",
  /** Two forms, not a `{s}` suffix — see `INSTRUMENT_COPY.countOne`. */
  countOne: "{count} position",
  countMany: "{count} positions",
  openInstrument: "Voir l'instrument",
  addTransaction: "Ajouter une transaction",
  openTransactions: "Voir les transactions",
  cardQuantity: "Quantité",
  /** « Prix moyen pondéré » — the abbreviation is the one the table header already uses. */
  cardAveragePrice: "PMP",
  cardCurrentPrice: "Prix actuel",
  cardAllocation: "Alloc.",
  cardUnrealized: "+/− latente",
  /** The card list's sort control (AC-3) — the table sorts from its headers, the cards from this. */
  cardSortBy: "Trier par",
  cardSortAscending: "Croissant",
  cardSortDescending: "Décroissant",

  exposureTotalUnavailable: "Répartition indisponible : la valeur totale n'est pas exploitable.",
  exposureUnreconciled:
    "Répartition indisponible : la somme des positions ne correspond pas au total.",
} as const satisfies Readonly<Record<HoldingsCopyKey, string>>;
