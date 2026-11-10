/**
 * `copy/watchlist.ts` — the **Suivi** screen and the `<WatchToggle>` it shares
 * with the Instruments surfaces (UR-48–UR-51, UR-53, UR-56, UR-57, NFR-40).
 *
 * Same shape as `copy/closed-positions.ts` and `copy/holdings.ts` — one flat
 * `Key` union plus `as const satisfies Readonly<Record<Key, string>>`, so a
 * missing entry is a type error rather than a blank on screen — and a separate
 * module from them for the reason `copy/index.ts`'s header gives: the module
 * boundary is what lets an audit say something about *this* surface.
 *
 * ## The three sign-aware labels are the whole of UR-57 on this screen
 *
 * {@link WATCHLIST_COPY.changeGain}/`changeLoss`/`changeFlat` sit **beside**
 * every tinted figure the row carries (day change, distance from the 52-week
 * high, the window's return), so direction is never carried by colour alone —
 * the same split `closedPositionResultLabel` already makes for a realised
 * result, and for the same reason: a red figure is invisible to a reader who
 * cannot see red, and a « hausse » label on a fall is worse than no label.
 * `"flat"` covers a genuine zero **and** a figure that could not be read;
 * neither may borrow the word « hausse ».
 *
 * ## What is deliberately not here
 *
 * - **No « Suivre » default for an unknown state.** `watchStateUnknown` is a
 *   distinct string, and it is load-bearing: while
 *   `GET /watchlist/ids` has produced no data, the toggle may not claim the row
 *   is unwatched, because it may already be watched. The label is the thing
 *   that must not lie — the click itself is idempotent and harmless.
 * - **No hint *sentences* here.** `volatility`/`drawdown`/`distanceFromHigh`/
 *   `movingAverage` are four `GLOSSARY_TERM_IDS` entries (T-76), and their
 *   definitions live in `copy/glossary.ts` — the labels below are the *terms*,
 *   the hint beside them resolves the sentence from the one catalogue that
 *   owns definitions. A second wording here is exactly what
 *   `glossary-copy-audit.test.ts` forbids.
 *
 * ## The list row is one line; the words live on the analysis screen
 *
 * Since 2026-09-11 the sign words are **visually hidden** on the list surfaces
 * (`k-visually-hidden`, still read aloud) — `<DeltaValue>`'s trend icon plus
 * the sign carry direction, so colour is still never alone (UR-57) — and the
 * 52-week range, the target/note editor and the reload action left the row for
 * the analysis screen and the ⋯ menu. Every string below is still used; the
 * `column*` names for the two moved figures now label tiles and card terms.
 *
 * ## The analysis screen is one instrument's, by construction
 *
 * Since 2026-09-11 the analysis lives on its own route,
 * `/watchlist/$instrumentId`, reached from the row — so the instrument's name
 * is the screen's heading and no caption has to disambiguate which of 200
 * rows a « Baisse maximale » belongs to. The former all-watched comparison
 * chart and its copy are gone with the panel that hosted them.
 * - **No « performance » or « rendement du portefeuille » wording.** Nothing
 *   on this screen is position-weighted: a watched instrument has no position,
 *   so every figure is a per-unit price fact (FR-348), and the labels say
 *   « cours » and « variation » rather than a portfolio word.
 */
export type WatchlistCopyKey =
  // --- the screen
  | "screenTitle"
  | "screenSubtitle"
  | "loadingWatchlist"
  | "watchlistPanel"
  | "tableRegion"
  | "cardListRegion"
  // --- the header's add affordance (UR-50)
  | "addAction"
  | "addSearchLabel"
  // --- the columns / card terms (UR-48/UR-49)
  | "columnAsset"
  | "columnLastPrice"
  | "columnDayChange"
  | "columnFiftyTwoWeek"
  | "columnDistanceFromHigh"
  | "columnPeriodReturn"
  | "columnTrend"
  | "columnTarget"
  | "columnActions"
  | "rowMenu"
  // --- the sign-aware labels (UR-57)
  | "changeGain"
  | "changeLoss"
  | "changeFlat"
  // --- per-row facts and their honest absences
  | "unavailable"
  | "unusableSeries"
  | "seriesTooShort"
  | "sparklineLabel"
  | "positionHeld"
  | "positionNotHeld"
  | "positionPending"
  | "openInstrument"
  // --- the inline edit (UR-53, FR-341)
  | "targetPriceLabel"
  | "targetPriceEdit"
  | "targetPriceEmpty"
  | "targetPriceNone"
  | "targetSectionTitle"
  | "targetPriceScaleError"
  | "noteLabel"
  | "noteEmpty"
  | "editSave"
  | "editCancel"
  // --- the per-instrument analysis screen and its two chart states (UR-52 as amended 2026-09-11, FR-358, FR-360)
  | "analysisBreadcrumb"
  | "analysisBreadcrumbWatchlist"
  | "analysisRegion"
  | "analysisModeLabel"
  | "analysisModeDetail"
  | "analysisModeDrawdown"
  | "analysisNotWatched"
  | "analysisBackToWatchlist"
  | "analysisLoading"
  | "analysisLoadingChart"
  | "openChart"
  | "detailRangeLabel"
  | "drawdownMax"
  | "drawdownPeriod"
  | "drawdownEmpty"
  | "drawdownPeak"
  // --- the metrics the row summary has no column for (FR-351–FR-353, UR-52)
  | "metricVolatility"
  | "metricMaxDrawdown"
  | "metricDistanceFromHigh"
  | "metricSma50"
  | "metricSma200"
  | "metricPriceVsSma50"
  | "metricPriceVsSma200"
  | "metricPosition"
  // --- watch / un-watch (FR-371–FR-374)
  | "watchAdd"
  | "watchRemove"
  | "watchStateUnknown"
  // --- the footer
  | "countOne"
  | "countMany"
  | "asOf";

export const WATCHLIST_COPY = {
  screenTitle: "Suivi",
  /** One line, descriptive, never advice — and it states the one fact that distinguishes this screen from Positions: a watched instrument need not be held. */
  screenSubtitle: "Les instruments que vous suivez, détenus ou non, et leurs indicateurs de cours.",
  loadingWatchlist: "de la liste de suivi",
  watchlistPanel: "Suivi",
  tableRegion: "Instruments suivis",
  cardListRegion: "Instruments suivis",

  addAction: "Ajouter",
  /** The existing `<AssetSearchPopover>`'s field label — no new search mechanism. */
  addSearchLabel: "Rechercher un instrument à suivre",

  columnAsset: "Actif",
  columnLastPrice: "Dernier cours",
  columnDayChange: "Variation du jour",
  columnFiftyTwoWeek: "Extrêmes 52 semaines",
  columnDistanceFromHigh: "Écart au plus haut",
  columnPeriodReturn: "Variation sur la période",
  columnTrend: "Tendance",
  columnTarget: "Cours cible",
  columnActions: "Actions",
  /** The ⋯ trigger's accessible name — `HOLDINGS_COPY.rowMenu`'s shape, on this surface. */
  rowMenu: "Actions pour {name}",

  changeGain: "En hausse",
  changeLoss: "En baisse",
  changeFlat: "Sans changement",

  /** The one word for "this figure does not exist" — W-10's absent key, never a zero. */
  unavailable: "Indisponible",
  unusableSeries:
    "Indicateurs non calculables : l'historique de cours contient une valeur nulle ou négative.",
  seriesTooShort: "Historique insuffisant sur la période demandée.",
  sparklineLabel: "Évolution du cours de {name} sur la période affichée",
  positionHeld: "Détenu",
  positionNotHeld: "Non détenu",
  /** While `GET /portfolios/holdings` has not answered: neither « Détenu » nor « Non détenu » is yet a fact. */
  positionPending: "Chargement…",
  openInstrument: "Voir l'instrument",

  targetPriceLabel: "Cours cible",
  targetPriceEdit: "Modifier le cours cible de {name}",
  targetPriceEmpty: "Aucun cours cible",
  /** The row's read-only target cell when none is set: a dash, not a sentence — the sentence is the editor's, on the analysis screen. */
  targetPriceNone: "—",
  /** The analysis screen's editor card (UR-53 relocated). */
  targetSectionTitle: "Cours cible et note",
  /**
   * WL-1 — the inline editor's own refusal, before any `PATCH`.
   * `{max}` is filled from `api-limits.ts`'s mirror of the server constant,
   * never typed as a literal here (this file's own rule for every bound).
   */
  targetPriceScaleError: "Le cours cible ne peut pas comporter plus de {max} décimales.",
  noteLabel: "Note",
  noteEmpty: "Aucune note",
  editSave: "Enregistrer",
  editCancel: "Annuler",

  analysisBreadcrumb: "Fil d'Ariane",
  analysisBreadcrumbWatchlist: "Suivi",
  analysisRegion: "Analyse de l'instrument suivi",
  analysisModeLabel: "Graphique affiché",
  analysisModeDetail: "Détail",
  analysisModeDrawdown: "Baisse",
  /** The deep link's own honest absence: the id is not in this tenant's list (un-watched since, or never watched), so there is no row to analyse. Stated, with a way back — never a blank card. */
  analysisNotWatched: "Cet instrument ne fait pas partie de votre liste de suivi.",
  analysisBackToWatchlist: "Retour au suivi",
  analysisLoading: "de l'analyse",
  analysisLoadingChart: "Chargement du graphique…",
  openChart: "Analyser {name}",
  /** The per-instrument chart's own range control — wider than the screen's, `MAX` included (one instrument, the existing paginated route). */
  detailRangeLabel: "Période du graphique",
  drawdownMax: "Baisse maximale",
  drawdownPeriod: "Du {peak} au {trough}",
  drawdownEmpty: "Historique insuffisant pour tracer la baisse depuis le plus haut.",
  /** The tooltip's second line — the running peak the point is measured against, as a price and never as a recomputed percentage (W-9). */
  drawdownPeak: "Plus haut atteint",

  metricVolatility: "Volatilité annualisée",
  metricMaxDrawdown: "Baisse maximale",
  metricDistanceFromHigh: "Écart au plus haut",
  metricSma50: "Moyenne mobile 50 jours",
  metricSma200: "Moyenne mobile 200 jours",
  metricPriceVsSma50: "Écart à la moyenne 50 jours",
  metricPriceVsSma200: "Écart à la moyenne 200 jours",
  /** FR-354's position-if-held block, as one tile on the analysis screen (relocated from the row 2026-09-11): « Détenu » plus the current value, or « Non détenu ». */
  metricPosition: "Position",

  watchAdd: "Suivre cet instrument",
  watchRemove: "Ne plus suivre cet instrument",
  /**
   * The reason this string exists rather than a defaulted
   * « Suivre »: until `GET /watchlist/ids` answers, the row's state is genuinely
   * unknown, and a control labelled « Suivre » would assert it is not watched.
   */
  watchStateUnknown: "État de suivi inconnu pour le moment",

  countOne: "{count} instrument suivi",
  countMany: "{count} instruments suivis",
  asOf: "Cours arrêtés au {date}",
} as const satisfies Readonly<Record<WatchlistCopyKey, string>>;
