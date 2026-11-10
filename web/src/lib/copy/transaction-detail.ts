/**
 * `copy/transaction-detail.ts` — one transaction, read.
 *
 * The detail drawer, its FX disclosure, and the two dialogs it opens: delete,
 * and the FX correction.
 *
 * **One of these strings is a load-bearing refusal, not decoration.** AC139/
 * AC142 require the app to *say* that only the principal leg's rate can be
 * corrected — the absence of a control is not a statement — so
 * `fxCorrectScopeNote` says it. Now neither the fee nor the withholding
 * has a rate of its own (both follow the principal's), and the note says that
 * rather than refusing to correct a rate that no longer exists.
 *
 * `noNetAmount` («no net is shown», LD-1) is gone: a dividend or
 * interest with a withholding now shows its net, `netAmount`.
 */
export type TransactionDetailCopyKey =
  // --- the drawer
  | "delete"
  | "correctFx"
  | "edit"
  | "drawerTitle"
  | "loading"
  | "sectionGeneral"
  | "reference"
  | "kind"
  | "date"
  | "timestamp"
  | "portfolio"
  | "sectionAsset"
  | "openInstrument"
  | "quantity"
  | "unitPrice"
  | "sectionAmounts"
  | "feeTotal"
  | "fee"
  | "withholding"
  | "targetAmount"
  | "grossAmount"
  | "settlementAmount"
  | "impliedSettlementRate"
  | "settlementNote"
  | "netAmount"
  | "sectionFx"
  | "sectionMetadata"
  | "note"
  | "sequence"
  | "createdAt"
  | "updatedAt"
  | "sourceDividend"
  // --- a security transfer's partner and carried cost
  | "transferredTo"
  | "receivedFrom"
  | "transferPartnerLink"
  | "transferCarriedCost"
  | "transferCarriedCostBase"
  // --- the FX disclosure
  | "fxRate"
  | "fxSource"
  | "fxObservedOn"
  | "fxUserInput"
  // --- the delete dialog
  | "deleteTitle"
  | "deleteConfirm"
  | "deleteLead"
  | "deleteWarning"
  | "deleteTransferPair"
  // --- the FX correction dialog
  | "fxCorrectTitle"
  | "fxCorrectDescription"
  | "fxCorrectSubmit"
  | "fxCorrectRecomputeWarning"
  | "fxCorrectScopeNote"
  | "fxCorrectSectionTitle"
  | "fxCorrectCurrentRate"
  | "fxCorrectNewRate"
  | "fxCorrectNewRateHint"
  | "fxCorrectUnitFallback"
  | "fxCorrectConverted";

export const TRANSACTION_DETAIL_COPY = {
  delete: "Supprimer",
  correctFx: "Corriger le change",
  edit: "Modifier",
  drawerTitle: "Détail de la transaction",
  loading: "Chargement…",
  sectionGeneral: "Général",
  reference: "Référence",
  kind: "Type",
  date: "Date",
  timestamp: "Horodatage",
  portfolio: "Portefeuille",
  sectionAsset: "Actif",
  openInstrument: "Voir l'instrument",
  quantity: "Quantité",
  unitPrice: "Prix unitaire",
  sectionAmounts: "Montants",
  /** FR-224/AC-250: an itemised cost shows its parts *and* their total, so the sum is on screen. */
  feeTotal: "Total des frais",
  fee: "Frais",
  withholding: "Retenue à la source",
  targetAmount: "Montant cible",
  grossAmount: "Montant brut",
  settlementAmount: "Montant réglé",
  impliedSettlementRate: "Taux implicite de règlement",
  settlementNote:
    "Le compte espèce est en {currency} : ce montant est celui débité ou crédité sur le compte. Le taux ci-dessus est déduit des deux montants enregistrés, il n'est pas un taux résolu.",
  /** A dividend or interest's settled amount minus its withholding, both in the account's currency. */
  netAmount: "Montant net",
  sectionFx: "Change",
  sectionMetadata: "Métadonnées",
  note: "Note",
  sequence: "Séquence",
  createdAt: "Créée le",
  updatedAt: "Modifiée le",
  sourceDividend: "Dividende source",

  transferredTo: "Transféré vers",
  receivedFrom: "Reçu de",
  transferPartnerLink: "Voir l'autre opération",
  transferCarriedCost: "Coût de revient transféré",
  /** The same cost in the ledger base, shown only when the carried currency is another one. */
  transferCarriedCostBase: "Coût de revient transféré (devise de référence)",

  fxRate: "Taux",
  fxSource: "Source",
  fxObservedOn: "Observé le",
  fxUserInput: "Saisi par l'utilisateur",

  deleteTitle: "Supprimer cette transaction",
  deleteConfirm: "Supprimer la transaction",
  deleteLead: "Cette suppression est définitive",
  deleteWarning:
    "La transaction est retirée du registre, et le prix de revient, les plus-values et la valorisation du portefeuille sont recalculés sans elle.",
  /** FR-579: one confirmation, naming both portfolios — `{source}` is where the units left, `{destination}` where they arrived. */
  deleteTransferPair:
    "Ce transfert sera supprimé des deux portefeuilles : {source} et {destination}.",

  fxCorrectTitle: "Corriger le taux de change",
  fxCorrectDescription: "Taux du montant principal uniquement.",
  fxCorrectSubmit: "Corriger le taux",
  fxCorrectRecomputeWarning:
    "La valorisation et le prix de revient de ce portefeuille seront recalculés à partir de cette transaction.",
  fxCorrectScopeNote:
    "Cette action corrige uniquement le taux de change du montant principal. Les frais et la retenue à la source n'ont pas de taux de change propre : ils sont convertis au taux du montant principal. Le nouveau taux est enregistré comme épinglé par l'utilisateur, avec son auteur, dans l'historique de la transaction.",
  fxCorrectSectionTitle: "Transaction",
  fxCorrectCurrentRate: "Taux actuel",
  fxCorrectNewRate: "Nouveau taux de change",
  /** The direction, spelled out: `{from}` is the trade's currency, `{to}` the base one. */
  fxCorrectNewRateHint: "1 {from} = ___ {to}",
  /** Stands in for `{from}` on a row that carries no currency of its own. */
  fxCorrectUnitFallback: "unité",
  fxCorrectConverted: "Montant converti",
} as const satisfies Readonly<Record<TransactionDetailCopyKey, string>>;
