/**
 * `copy/overview.ts` — the **Aperçu** dashboard.
 *
 * The screen, its hero and KPI tiles, and the positions pie card.
 *
 * **The freshness line is not here, and neither is anything that would let it
 * be written.** `DashboardKpiStrip.tsx` renders `formatFreshnessCopy`, which
 * says « version <calcEpoch> » plus the time the data was *fetched* — never a
 * wall-clock recalculation time, because `calcEpoch` is an opaque counter and
 * `updatedAt` is bumped by a plain rename. `empty-state-copy-audit.test.ts`
 * scans this table for exactly that claim.
 *
 * **« TWR » and « MWR » are abbreviations here on purpose.** They sit in a
 * repeated tile row, each carrying `<StatTile hintTerm>` — the definition
 * itself lives once in `copy/glossary.ts`, never as a second
 * wording here. The Performance screen, which explains them, spells both out
 * in full.
 */
export type OverviewCopyKey =
  | "screenTitle"
  | "screenSubtitle"
  | "loadingOverview"
  | "overviewPanel"
  | "totalValue"
  | "unrealized"
  | "period"
  | "dayChange"
  | "dayChangeHint"
  | "dayChangeUnavailable"
  | "twr"
  | "mwr"
  // --- the hero's value chart and the invested-capital tile
  | "valueChartTitle"
  | "valueChartLabel"
  | "valueChartValue"
  | "valueChartContributions"
  | "valueChartAsOf"
  | "valueChartGain"
  | "loadingSeries"
  | "seriesPanel"
  | "seriesEmpty"
  | "investedTile"
  | "investedGain"
  // --- the positions pie card
  | "positionsPieTitle"
  | "positionsPieDonut"
  | "positionsPieOthers"
  | "positionsPieMore"
  | "positionsPieMoreOne"
  | "positionsPieAll"
  | "positionsPieCountOne"
  | "positionsPieCountMany"
  | "positionsPieEmpty"
  | "positionsPieUnavailable";

export const OVERVIEW_COPY = {
  screenTitle: "Aperçu",
  screenSubtitle: "Vos portefeuilles réunis, sur la période choisie.",
  loadingOverview: "de l'aperçu",
  overviewPanel: "Aperçu",
  totalValue: "Valeur totale",
  unrealized: "Plus/moins-value latente",
  period: "Période",
  dayChange: "Variation du jour",
  dayChangeHint: "Variation de prix depuis la clôture précédente, hors flux",
  /** Absent means at least one holding has no previous close. The tile says so rather than showing a zero. */
  dayChangeUnavailable: "Clôture précédente inconnue pour au moins une position",
  twr: "TWR",
  mwr: "MWR",

  valueChartTitle: "Valeur et capital investi",
  valueChartLabel: "Valeur du portefeuille et capital investi net, {count} jour(s)",
  valueChartValue: "Valeur",
  valueChartContributions: "Capital investi net",
  valueChartAsOf: "Au {date}",
  /** Value minus net contributions: what the money did once it was inside. Never « écart » — the owner's naming. */
  valueChartGain: "gain",
  loadingSeries: "de la courbe",
  seriesPanel: "Courbe de valeur",
  seriesEmpty: "Aucun point de valeur sur cette période.",
  investedTile: "Capital investi net",
  investedGain: "Gain sur capital investi",

  positionsPieTitle: "Répartition des positions",
  positionsPieDonut: "Part de chaque position dans la valeur totale",
  /** The tail beyond the top ten, as one grey segment — a share, not a position, so it links nowhere. */
  positionsPieOthers: "Autres positions",
  /** The legend's folded row — every slice past the eighth, the tail included. */
  positionsPieMore: "{count} autres positions",
  positionsPieMoreOne: "1 autre position",
  positionsPieAll: "Toutes les positions",
  positionsPieCountOne: "{count} position",
  positionsPieCountMany: "{count} positions",
  positionsPieEmpty: "Aucune position détenue.",
  /** `computeAllocation`'s own two guards, in the exposure card's words: no total, or shares that do not reconcile. */
  positionsPieUnavailable: "Répartition indisponible : la valeur totale ne peut pas être établie.",
} as const satisfies Readonly<Record<OverviewCopyKey, string>>;
