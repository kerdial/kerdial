/**
 * `copy/closed-positions.ts` — the Positions screen's **« Clôturées »** tab
 * (UR-45/NFR-4).
 *
 * The instruments this tenant now holds zero of, and what selling out of them
 * realized: `<ClosedPositionsTable>` (desktop), `<ClosedPositionsCardList>`
 * (mobile) and the `<ClosedPositionSaleLots>` disclosure both of them open.
 *
 * Same shape as `copy/holdings.ts` — one flat `Key` union plus
 * `as const satisfies Readonly<Record<Key, string>>`, so a missing entry is a
 * type error rather than a blank on screen — and a **separate module** from it
 * for the reason `copy/index.ts`'s header gives: the module boundary is what
 * lets an audit say something about *this* surface.
 *
 * ## The three result labels are re-declared here, not imported (CP-7)
 *
 * {@link CLOSED_POSITIONS_COPY.resultGain}/`resultLoss`/`resultFlat` are the
 * same three French strings `<RealizedGainsIndicator>` renders for an open
 * holding's realised legs. They are **copied by value on purpose**: that
 * component is under this feature's literal no-change guarantee (UR-44/AC-325
 * — its diff must be zero lines), so extracting its inline literals into a
 * shared constant is exactly the edit this cycle may not make. The copy layer
 * is also where a new string belongs (UR-45), so the duplication is between a
 * catalogued entry here and a pre-existing literal there, not between two
 * catalogues. Collapsing the two is a recorded follow-up chore.
 *
 * ## No « somme des résultats réalisés »
 *
 * There is deliberately no view-level total key (CP-9): the response carries
 * no such figure and summing the rows client-side would put a number on screen
 * the server never computed. The same reason this tab has no 4-up strip.
 */
export type ClosedPositionsCopyKey =
  // --- the panel
  | "loadingClosed"
  | "closedPanel"
  | "tableRegion"
  // --- the three sign-aware result labels (CP-7 — see this file's header)
  | "resultGain"
  | "resultLoss"
  | "resultFlat"
  // --- the table's columns
  | "columnAsset"
  | "columnKind"
  | "columnRealized"
  | "columnReturn"
  | "columnDisposedCostBasis"
  | "columnRealizedNative"
  | "columnFxComponent"
  | "columnActions"
  // --- row actions and the footer
  | "rowMenu"
  | "openInstrument"
  | "openTransactions"
  | "countOne"
  | "countMany"
  // --- the sale-lot disclosure
  | "saleLotsShow"
  | "saleLotsHide"
  | "saleLotsRegion"
  | "lotTradeDate"
  | "lotQuantitySold"
  | "lotGainBase"
  | "lotGainNative"
  | "lotFxComponentBase"
  | "lotProceedsBase"
  | "lotPortfolio"
  | "lotProvenance";

export const CLOSED_POSITIONS_COPY = {
  loadingClosed: "des positions clôturées",
  closedPanel: "Positions clôturées",
  /** The table's own accessible name — the tab label says what the tab is, this says what the region is. */
  tableRegion: "Positions clôturées, par résultat réalisé",

  /**
   * Direction in words as well as in colour (UR-46/AC-329): a realised loss
   * labelled « Plus-value réalisée » reads as a gain that happens to be
   * negative, which is the failure the money-meaning colours exist to
   * prevent — and colour alone fails anyone who cannot see it.
   */
  resultGain: "Plus-value réalisée",
  resultLoss: "Moins-value réalisée",
  /** Neither, or a figure that could not be read: neutral, and never defaulted to the gain label. */
  resultFlat: "Résultat réalisé",

  columnAsset: "Actif",
  columnKind: "Type",
  columnRealized: "Résultat réalisé",
  columnReturn: "Rendement",
  columnDisposedCostBasis: "Coût d'acquisition cédé",
  columnRealizedNative: "Résultat natif",
  /** The FX attribution already carried on the wire — never re-derived here. */
  columnFxComponent: "Dont change",
  columnActions: "Actions",

  rowMenu: "Actions pour {name}",
  openInstrument: "Voir l'instrument",
  openTransactions: "Voir les transactions",
  /**
   * Two forms, not a `{s}` suffix — `HOLDINGS_COPY.countOne`'s own rule.
   *
   * There is no « Saisir un cours » and no « Ajouter une transaction » entry
   * in this file, and both absences are statements: a closed line has no
   * position left to price, and adding a transaction from a row is the one
   * affordance that would stop that row being a closed position.
   */
  countOne: "{count} position clôturée",
  countMany: "{count} positions clôturées",

  saleLotsShow: "Voir le détail des cessions",
  saleLotsHide: "Masquer le détail des cessions",
  saleLotsRegion: "Détail des cessions de {name}",
  lotTradeDate: "Date de cession",
  lotQuantitySold: "Quantité cédée",
  lotGainBase: "Résultat",
  lotGainNative: "Résultat natif",
  lotFxComponentBase: "Dont change",
  lotProceedsBase: "Produit de cession",
  lotPortfolio: "Portefeuille",
  lotProvenance: "Provenance",
} as const satisfies Readonly<Record<ClosedPositionsCopyKey, string>>;
