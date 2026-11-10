/**
 * `copy/performance.ts` — the **Performance** screen and its chart.
 *
 * **Every "less than it looks" caveat on this screen is a separate string, and
 * that is the screen's whole design.** A drawn curve cannot say that four
 * points were unreadable, or that a contribution was missing on a date — so
 * each of those is written out. A
 * single « données partielles » would be shorter and would tell the reader
 * nothing they could act on.
 *
 * The two return figures name themselves in full here (« Rendement pondéré par
 * le temps », not « TWR ») because this is the screen that explains them; the
 * portfolio workspace's own strip uses the abbreviations, deliberately.
 *
 * **Their one-sentence definitions are not here.** They were, as `twrHint`/
 * `mwrHint`, in a third wording alongside `PerformanceBlocks.tsx`'s constants
 * and `OVERVIEW_COPY`'s — all three were collapsed into
 * `copy/glossary.ts`, and the tiles here take `hintTerm` instead.
 */
export type PerformanceCopyKey =
  | "screenTitle"
  | "screenSubtitle"
  | "loadingPerformance"
  | "performancePanel"
  // --- the portfolio selector
  | "scopeLabel"
  | "scopeAll"
  | "twr"
  | "mwr"
  | "twrUnavailableBanner"
  | "mwrUnavailableBanner"
  | "methodTitle"
  | "methodCash"
  | "period"
  | "rangeDays"
  | "subPeriods"
  | "annualised"
  | "mwrMethod"
  | "mwrMethodNewton"
  | "mwrMethodBisection"
  | "iterations"
  | "loadingSeries"
  | "seriesPanel"
  | "seriesEmpty"
  | "seriesDropped"
  // --- the periodic return chart
  | "periodReturnTitle"
  | "periodReturnGranularity"
  | "periodReturnGranularityDay"
  | "periodReturnGranularityWeek"
  | "periodReturnGranularityMonth"
  | "periodReturnGranularityYear"
  | "periodReturnLegend"
  | "periodReturnScrollLabel"
  | "periodReturnEmpty"
  | "periodReturnUnavailable"
  | "periodReturnUnavailableCell"
  | "periodReturnTableCaption"
  | "periodReturnColumnPeriod"
  | "periodReturnColumnReturn"
  // --- the value vs. invested-capital chart
  | "investedTitle"
  | "investedValueLabel"
  | "investedContributionsLabel"
  | "investedDefinition"
  | "investedChartLabel"
  | "investedAsOf"
  | "investedGap"
  | "investedUnavailable"
  | "investedDropped"
  | "investedTableCaption"
  | "investedColumnDate"
  | "investedColumnValue"
  | "investedColumnContributions"
  | "investedColumnGap"
  // --- why a return is unavailable, one line per reason code
  | "unavailableZeroBase"
  | "unavailableInsufficientData"
  | "unavailableNoRoot"
  | "unavailableNotConverged"
  | "unavailableNoPortfolio";

export const PERFORMANCE_COPY = {
  screenTitle: "Performance",
  screenSubtitle: "Vos rendements sur la période choisie, et comment ils sont calculés.",
  loadingPerformance: "de la performance",
  performancePanel: "Performance",
  /** The same two strings the Dividendes filter uses, so the two selectors read as one control. */
  scopeLabel: "Portefeuille",
  scopeAll: "Tous les portefeuilles",
  twr: "Rendement pondéré par le temps",
  mwr: "Rendement pondéré par les flux",
  /** Followed by "." or " : <the wire's own reason>." — the reason is server text, rendered verbatim and never switched on. */
  twrUnavailableBanner: "Rendement pondéré par le temps indisponible sur cette période",
  mwrUnavailableBanner: "Rendement pondéré par les flux indisponible sur cette période",
  methodTitle: "Comment ces chiffres sont calculés",
  /** portfolio-cash PC-L1 / O-1: since cash entered V(d), idle cash no longer reads as a loss — say once that it is in. */
  methodCash:
    "Les liquidités de vos comptes espèces font partie de la valeur du portefeuille : elles entrent dans les deux rendements et dans la courbe de valeur.",
  period: "Période",
  rangeDays: "Jours couverts",
  subPeriods: "Sous-périodes",
  annualised: "Annualisé",
  mwrMethod: "Méthode MWR",
  /** Two solver names, not translated: they are the algorithms' own. */
  mwrMethodNewton: "Newton",
  mwrMethodBisection: "Bissection",
  iterations: "Itérations",
  loadingSeries: "de la courbe",
  seriesPanel: "Courbe de valeur",
  seriesEmpty: "Aucun point de valeur sur cette période.",
  seriesDropped: "{count} valeur(s) illisible(s) ont été écartées de la courbe.",

  periodReturnTitle: "Performance par période",
  periodReturnGranularity: "Granularité",
  periodReturnGranularityDay: "Jour",
  periodReturnGranularityWeek: "Semaine",
  periodReturnGranularityMonth: "Mois",
  periodReturnGranularityYear: "Année",
  /** Follows a swatch pair, gain then loss — the two colours the bars use. */
  periodReturnLegend: "Rendement de la période, en %",
  periodReturnScrollLabel: "Graphique du rendement du portefeuille par période",
  periodReturnEmpty: "Pas assez de points de valeur sur cette période pour calculer un rendement.",
  /** Follows "{count} " — see `copy/fill.ts`. */
  periodReturnUnavailable:
    "{count} période(s) sans rendement calculable : le portefeuille n’avait pas encore de valeur au début de la période.",
  periodReturnUnavailableCell: "indisponible",
  periodReturnTableCaption: "Rendement du portefeuille par période",
  periodReturnColumnPeriod: "Période",
  periodReturnColumnReturn: "Rendement",

  investedTitle: "Valeur et capital investi",
  investedValueLabel: "Valeur du portefeuille",
  investedContributionsLabel: "Capital investi net",
  /** The one sentence that says what the dashed line is — and is not. */
  investedDefinition:
    "Capital investi net = dépôts − retraits sur vos comptes espèces depuis l’origine, en {currency}. Les dividendes et les échanges de devises n’en font pas partie.",
  investedChartLabel: "Valeur du portefeuille et capital investi net, {count} jour(s)",
  /** Leads the detail line: « Au 2026-09-17 : … ». */
  investedAsOf: "Au {date}",
  /** Value − net contributions on the same date: what the money did once inside. */
  investedGap: "Écart",
  investedUnavailable: "indisponible",
  investedDropped: "{count} valeur(s) illisible(s) du capital investi ont été écartées.",
  investedTableCaption: "Valeur et capital investi net, dernier jour de chaque mois",
  investedColumnDate: "Date",
  investedColumnValue: "Valeur",
  investedColumnContributions: "Capital investi",
  investedColumnGap: "Écart",
  unavailableZeroBase: "Non calculable : aucun capital investi",
  unavailableInsufficientData: "Non calculable : historique insuffisant",
  unavailableNoRoot: "Non calculable pour ces flux",
  unavailableNotConverged: "Non calculable : le calcul n'aboutit pas",
  unavailableNoPortfolio: "Aucun portefeuille",
} as const satisfies Readonly<Record<PerformanceCopyKey, string>>;
