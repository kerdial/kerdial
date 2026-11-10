/**
 * `copy/forms.ts` — the shared field controls.
 *
 * The pickers and selectors several screens mount without owning: the currency
 * `<select>`, the instrument picker, the period segmented controls, the
 * custom-range date inputs. Their words belong to the control, not to whichever
 * screen happens to render it — which is the same argument `nav-items.ts`
 * makes for a nav item's label.
 */
export type FormCopyKey = "chooseCurrency" | "change" | "period" | "dateFrom" | "dateTo";

export const FORM_COPY = {
  /** The empty option of `CurrencySelect` — the em dashes are the existing affordance, not decoration. */
  chooseCurrency: "— Choisir une devise —",
  /** Clears an instrument already chosen in `InstrumentPicker`, returning it to search. */
  change: "Changer",
  period: "Période",
  dateFrom: "Du",
  dateTo: "Au",
} as const satisfies Readonly<Record<FormCopyKey, string>>;
