/**
 * `copy/cash.ts` — the portfolio's cash as it appears **outside** the
 * « Espèces » tab (portfolio-cash FR-685..689): the « Liquidités »
 * display class, its figure beside every total that includes it, and the
 * missing-rate note.
 *
 * The « Espèces » tab and its dialogs keep their own strings in
 * `copy/portfolios.ts`; this table is the one wording for the synthetic
 * « Liquidités » line every other surface shows (PC-L3), so the hero, the
 * cards, the stat strip, the Positions row and the class legends cannot drift
 * apart.
 */
export type CashCopyKey = "label" | "unconverted";

export const CASH_COPY = {
  /** The display class and every figure line — PC-L3's label, sentence case. */
  label: "Liquidités",
  /**
   * PC-L2 / AC-570: the currencies the server excluded for lack of a rate,
   * stated beside the figure so the total is never a silent partial one.
   * `{currencies}` is the ISO codes, comma-separated (`fill.ts`).
   */
  unconverted: "taux indisponible : {currencies}",
} as const satisfies Readonly<Record<CashCopyKey, string>>;
