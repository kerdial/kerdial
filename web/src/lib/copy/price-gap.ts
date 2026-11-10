/**
 * `copy/price-gap.ts` — the remedy under « Valorisation indisponible — cours
 * manquant » when a portfolio-level read names the holding it could not price:
 * which instrument, the unpriceable range, a link to its fiche,
 * and the one-click manual price from the acquisition's own unit price.
 *
 * Nothing here promises an automatic fix. Owner decision D2 (2026-09-28): the
 * price is written **only** after the user confirms, as an ordinary manual
 * point they can correct from the fiche — the confirmation says so.
 *
 * Every figure and date reaches these patterns already formatted (`fill.ts`'s
 * rule): the price through `figure-format.ts`, dates through
 * `formatIsoDateFr`.
 */
export type PriceGapCopyKey =
  | "instrument"
  | "rangeUntilFirstPrice"
  | "rangeNoPriceAtAll"
  | "openInstrument"
  | "useTradePrice"
  | "confirmTitle"
  | "confirmBody"
  | "confirmEditable"
  | "confirm";

export const PRICE_GAP_COPY = {
  instrument: "Instrument concerné : {instrument}",
  rangeUntilFirstPrice:
    "Aucun cours avant le {first}, date du premier cours disponible pour cet instrument : la valorisation échoue dès le {from}.",
  rangeNoPriceAtAll:
    "Aucun cours n'est disponible pour cet instrument, à aucune date : la valorisation échoue dès le {from}.",
  openInstrument: "Ouvrir la fiche de l'instrument",
  /** `{price}` is the formatted amount followed by its currency code, e.g. « 19.50 EUR ». */
  useTradePrice: "Utiliser le prix d'achat ({price})",
  confirmTitle: "Enregistrer un cours manuel ?",
  confirmBody:
    "Un cours manuel sera enregistré pour {instrument} : {price} au {date}, date de votre première acquisition. Rien d'autre n'est modifié.",
  confirmEditable:
    "Il s'agit d'un prix de transaction, pas d'un cours de clôture publié. Vous pourrez le corriger depuis la fiche de l'instrument.",
  confirm: "Enregistrer ce cours",
} as const satisfies Readonly<Record<PriceGapCopyKey, string>>;
