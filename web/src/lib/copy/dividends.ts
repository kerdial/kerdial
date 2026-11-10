import { monthName } from "./months.js";

/**
 * `copy/dividends.ts` — the **Dividendes** screen (redesigned
 * as a calendar).
 *
 * Three surfaces share this catalogue: the hero (`DividendHero.tsx` — the
 * total and its three companion figures), the year × month calendar
 * (`DividendCalendar.tsx`) and the ranked payer list (`DividendPayers.tsx`).
 * The calendar's month letters and names moved to `copy/months.ts` when the
 * Activité screen grew a calendar of its own.
 */
export type DividendCopyKey =
  | "screenTitle"
  | "screenSubtitle"
  | "filterPortfolio"
  | "filterAllPortfolios"
  | "loadingDividends"
  | "dividendsPanel"
  | "heroGross"
  | "heroWithholding"
  | "heroPayments"
  | "heroInstruments"
  | "calendarTitle"
  | "calendarUnit"
  | "calendarCaption"
  | "columnYear"
  | "columnTotal"
  | "detailNoPayment"
  | "detailGross"
  | "detailWithholding"
  | "rampLess"
  | "rampMore"
  | "payersTitle"
  | "payersCount"
  | "payersWithholding"
  | "payersCollapse"
  | "listLoading"
  | "listMore"
  | "listMoreLink";

export const DIVIDEND_COPY = {
  screenTitle: "Dividendes",
  screenSubtitle: "Ce que vos positions vous ont versé, par instrument et dans le temps.",
  filterPortfolio: "Portefeuille",
  filterAllPortfolios: "Tous les portefeuilles",
  loadingDividends: "des dividendes",
  dividendsPanel: "Dividendes",
  /** The hero's one large figure. Gross, and named so — LD-1 keeps it that. */
  heroGross: "Dividendes bruts",
  /** Stated as a positive magnitude beside the gross, never subtracted from it (LD-1). */
  heroWithholding: "Retenue à la source",
  heroPayments: "Versements",
  heroInstruments: "Instruments",
  calendarTitle: "Calendrier",
  /** What the cells encode, beside the title: gross, in the base currency the caller appends. */
  calendarUnit: "bruts",
  calendarCaption: "Dividendes bruts par année et par mois",
  /** The row-header column's accessible name — the visible header is empty, the years below it speak for themselves. */
  columnYear: "Année",
  /** The calendar's last column: the year's own total from `years[]`, not a re-sum of its cells. */
  columnTotal: "Total",
  detailNoPayment: "aucun versement",
  detailGross: "bruts",
  detailWithholding: "retenue",
  rampLess: "moins",
  rampMore: "plus",
  payersTitle: "Qui vous paie",
  /** The abbreviation under each payer's gross: « 7 vers. » — the count is `paymentCount`, the server's figure. */
  payersCount: "vers.",
  /** « ret. 32,20 EUR » — the row's withholding, abbreviated because the hero spells the term out with its definition. */
  payersWithholding: "ret.",
  payersCollapse: "Réduire",
  /** `PanelLoading`'s « Chargement … » complement for the selected month's payment list. */
  listLoading: "des versements",
  /** The list's last line when the page has a `nextCursor`: never silently short. */
  listMore: "D'autres versements ce mois-ci —",
  listMoreLink: "voir l'Activité",
} as const satisfies Readonly<Record<DividendCopyKey, string>>;

/** The folded row's label: « 11 autres » / « 1 autre ». */
export function othersCopy(count: number): string {
  return `${String(count)} ${count === 1 ? "autre" : "autres"}`;
}

/** The fold's expand control: « Voir les 11 autres » / « Voir l'autre ». */
export function expandOthersCopy(count: number): string {
  return count === 1 ? "Voir l'autre" : `Voir les ${String(count)} autres`;
}

/** « Versements de mai 2025 » / « Versements d'août 2026 » — the month list's heading, elided before a vowel. The months themselves are `copy/months.ts`'s. */
export function monthListTitle(period: string): string {
  const [year] = period.split("-") as [string, string];
  const name = monthName(period);
  const elide = /^[aeiouy]/i.test(name);
  return `Versements ${elide ? "d'" : "de "}${name} ${year}`;
}
