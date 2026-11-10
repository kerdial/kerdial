import type { PreviewGap } from "../transaction-preview.js";

/**
 * `copy/transactions.ts` — the write surfaces.
 *
 * The create form, the edit form, the live preview and the two drawers that
 * host them. This is the largest table in the catalogue, and deliberately so:
 * `TransactionForm.tsx` alone carried 62 literals, one per field of a form
 * whose shape changes with eight transaction kinds.
 *
 * **Several labels look duplicated and are not.** « Taux de change vers la
 * devise de référence » and « Taux de change épinglé » are two different rates
 * between two different pairs, and the create form's own comment says the copy
 * is what keeps them apart; « Montant réglé » and « Montant réglé (calculé) »
 * differ in whether the user may type. Collapsing either pair to one key would
 * be a copy change disguised as deduplication.
 *
 * **The two hints that differ by one clause are two keys** —
 * `cashAccountHint` ends « — il peut être dans une autre devise » and
 * `cashAccountSameCurrencyHint` does not, because on `CURRENCY_EXCHANGE` the
 * account is pinned to the leg's currency and the longer sentence would be
 * false.
 */
export type TransactionCopyKey =
  // --- the settlement sub-form
  | "cashAmountDebited"
  | "cashAmountCredited"
  | "cashAmountDerived"
  | "cashAmountBackSolve"
  | "cashAmountDerivedHint"
  | "cashAmountBackSolveHint"
  | "cashAmountHint"
  | "impliedSettlementRateUnknown"
  | "impliedSettlementRatePrefix"
  | "impliedSettlementRateSuffix"
  // --- the create form
  | "noPortfolios"
  | "portfolio"
  | "chooseOption"
  | "tradeDate"
  | "tradeTime"
  | "tradeTimeHint"
  | "instrument"
  | "sourceDividendId"
  | "quantity"
  | "settledInAsset"
  | "settledInAssetDescription"
  | "settlementInstrument"
  | "settlementAmount"
  | "settlementPinnedFxRate"
  | "optional"
  | "unitPrice"
  | "currency"
  | "cashAccount"
  | "cashAccountHint"
  | "cashAccountSourceHint"
  | "fxRateToBase"
  | "marketValue"
  | "marketValueHint"
  | "amount"
  | "withholdingSection"
  | "withholdingAmount"
  | "targetCurrency"
  | "targetCashAccount"
  | "targetCashAccountHint"
  | "exchangeRate"
  | "feesSection"
  | "feeAmount"
  | "feeTotal"
  | "feeBreakdownHint"
  | "feeBroker"
  | "feeFx"
  | "feeTax"
  | "feeOther"
  | "referenceOptional"
  | "noteOptional"
  // --- the FEE kind (`portfolio-cash` FR-691)
  | "feeLabel"
  | "feeLabelPlaceholder"
  | "feeInstrumentOptional"
  | "calcEpochStale"
  | "submitCreate"
  // --- the security-transfer entry
  | "transferTab"
  | "destinationPortfolio"
  | "destinationNone"
  | "destinationHint"
  | "transferMarketValueHint"
  // --- the edit form
  | "replaceInstrumentHint"
  | "replaceInstrumentPlaceholder"
  | "currentInstrument"
  | "fxNotEditableHere"
  | "frozenFieldsTitle"
  | "frozenCurrency"
  | "lockedTag"
  | "frozenFieldsExplanation"
  | "targetAmount"
  | "fees"
  | "withholding"
  | "cashAccountSameCurrencyHint"
  | "settlementAmountDerived"
  | "settlementAmountDerivedHint"
  | "note"
  | "reference"
  | "tradeDateRequired"
  | "netBelowZero"
  | "savedToast"
  | "grossAmount"
  | "marketValueRequired"
  | "amountRequired"
  | "transferTargetEditNote"
  // --- the live preview
  | "previewTitle"
  | "previewGross"
  | "previewFee"
  | "previewCashOut"
  | "previewCashIn"
  | "previewBaseEquivalent"
  | "previewRate"
  | "previewRateSource"
  // --- the two drawers and the kind tablist
  | "createDialogTitle"
  | "createDialogDescription"
  | "editDialogTitle"
  | "kindTablist"
  // --- transaction-dialog-refresh: the family picker (FR-643)
  | "familyGroupLabel"
  | "familySecurities"
  | "familyCash"
  | "familyIncome"
  | "familyTransfers"
  // --- transaction-dialog-refresh: the expander (FR-647)
  | "moreOptions";

export const TRANSACTION_COPY = {
  cashAmountDebited: "Montant débité du compte",
  cashAmountCredited: "Montant crédité sur le compte",
  /** `{amount}` is one of the two labels above — the form picks the direction, this table does not. */
  cashAmountDerived: "{amount} (calculé)",
  cashAmountBackSolve: "{amount} d'après votre relevé (optionnel)",
  cashAmountDerivedHint:
    "Calculé : montant brut × taux de change. Ce montant est déduit du taux, jamais saisi — c'est le taux qui est enregistré.",
  cashAmountBackSolveHint:
    "Renseigne le taux de change ci-dessus par calcul inverse. Le montant lui-même n'est pas envoyé.",
  cashAmountHint: "Le montant réellement débité ou crédité sur ce compte, dans sa devise.",
  impliedSettlementRateUnknown:
    "Taux implicite de règlement : disponible dès que le montant brut et le montant réglé sont connus.",
  impliedSettlementRatePrefix: "Taux implicite de règlement : 1 {currency} =",
  impliedSettlementRateSuffix: "{currency} (calculé)",

  noPortfolios:
    "Aucun portefeuille disponible. Créez-en un dans « Portefeuilles » avant d'enregistrer une transaction.",
  portfolio: "Portefeuille",
  chooseOption: "— Choisir —",
  tradeDate: "Date de l'opération",
  tradeTime: "Heure de l'opération",
  tradeTimeHint: "Optionnel — sans heure, seule la date est enregistrée.",
  instrument: "Instrument",
  sourceDividendId: "Dividende source (id)",
  quantity: "Quantité",
  settledInAsset: "Réglé en actif",
  settledInAssetDescription:
    "Règlement crypto-à-crypto : l'achat est payé avec un autre actif détenu, pas en devise (FR-66).",
  settlementInstrument: "Instrument de règlement",
  settlementAmount: "Montant réglé",
  settlementPinnedFxRate: "Taux de change épinglé",
  optional: "Optionnel.",
  unitPrice: "Prix unitaire",
  currency: "Devise",
  cashAccount: "Compte espèce",
  cashAccountHint:
    "Le compte débité ou crédité par cette opération — il peut être dans une autre devise.",
  cashAccountSourceHint: "Le compte débité, dans la devise source.",
  fxRateToBase: "Taux de change vers la devise de référence",
  marketValue: "Valeur de marché",
  marketValueHint:
    "Ce que valaient les actions attribuées à cette date. Aucun mouvement d'espèces : le prix de revient total reste inchangé.",
  amount: "Montant",
  withholdingSection: "Retenue à la source (optionnel)",
  withholdingAmount: "Montant retenu",
  targetCurrency: "Devise cible",
  targetCashAccount: "Compte espèce cible",
  targetCashAccountHint: "Le compte crédité dans la devise cible — indépendant du compte source.",
  exchangeRate: "Taux de change",
  feesSection: "Frais (optionnel)",
  feeAmount: "Montant des frais",
  /** `transaction-dialog-refresh` FR-653: the read-only sum of the four components on BUY/SELL/DRIP — displayed, never sent. */
  feeTotal: "Total des frais",
  feeBreakdownHint: "Facultatif. Si vous détaillez, le total est la somme des lignes saisies.",
  feeBroker: "Courtage",
  feeFx: "Frais de change",
  feeTax: "Taxes",
  feeOther: "Autres frais",
  referenceOptional: "Référence (optionnel)",
  noteOptional: "Note (optionnel)",
  /** `portfolio-cash` FR-691: a FEE's `note`, essential on that kind — what the charge was. */
  feeLabel: "Libellé",
  feeLabelPlaceholder: "Frais de garde T3",
  /** The FEE's optional instrument reference (PC-L14), under « Plus d'options ». */
  feeInstrumentOptional: "Instrument concerné (optionnel)",
  calcEpochStale: "Écriture enregistrée, chiffres non rafraîchis — actualisez.",
  submitCreate: "Enregistrer la transaction",

  transferTab: "Transfert de titres",
  destinationPortfolio: "Portefeuille de destination",
  destinationNone: "Aucun — les titres quittent Kerdial",
  destinationHint:
    "Choisissez le portefeuille qui reçoit les titres : l'entrée y est enregistrée avec leur coût de revient. Laissez vide si les titres quittent Kerdial.",
  transferMarketValueHint:
    "Préremplie avec le dernier cours connu × la quantité, et modifiable : c'est la valeur enregistrée. Le coût de revient transféré est calculé à part.",

  replaceInstrumentHint: "Laissez vide pour conserver l'instrument actuel.",
  replaceInstrumentPlaceholder: "Rechercher un autre instrument",
  currentInstrument: "Actuel",
  fxNotEditableHere:
    "Les taux de change ne sont pas modifiables ici : changer la date conserve le taux enregistré. Utilisez l'action « Corriger le change » pour corriger le taux du montant principal.",
  frozenFieldsTitle: "Champs figés",
  frozenCurrency: "Devise :",
  savedToast: "Transaction enregistrée",
  netBelowZero: "Le net serait négatif : la retenue ne peut pas dépasser le montant brut.",
  lockedTag: "Verrouillé",
  frozenFieldsExplanation:
    "Une devise erronée se corrige en supprimant la transaction et en la ressaisissant, pour que le taux de change soit résolu à nouveau.",
  targetAmount: "Montant cible",
  fees: "Frais",
  withholding: "Retenue à la source",
  cashAccountSameCurrencyHint: "Le compte débité ou crédité par cette opération.",
  settlementAmountDerived: "Montant réglé (calculé)",
  settlementAmountDerivedHint:
    "Ce compte est dans la devise de valorisation : le montant est déduit du montant brut et du taux figé, et recalculé à l'enregistrement. Il ne se saisit pas.",
  note: "Note",
  reference: "Référence",
  tradeDateRequired: "Saisissez la date de l'opération.",
  grossAmount: "Montant brut",
  marketValueRequired: "Saisissez la valeur de marché.",
  amountRequired: "Saisissez le montant.",
  transferTargetEditNote:
    "Cette entrée de titres est liée à un transfert sortant : seules sa note et sa référence sont modifiables ici. La quantité et la valeur se modifient sur le transfert d'origine.",

  previewTitle: "Aperçu",
  previewGross: "Montant brut",
  previewFee: "Frais",
  previewCashOut: "Montant à payer",
  previewCashIn: "Montant reçu",
  previewBaseEquivalent: "Équivalent en devise de base",
  previewRate: "Taux appliqué",
  /** Follows the rate, leading separator included: a typed rate is a claim, not an observation. */
  previewRateSource: " · saisi par vous",

  createDialogTitle: "Nouvelle transaction",
  createDialogDescription:
    "Achat, vente, dépôt, retrait, dividende, réinvestissement, change ou transfert de titres.",
  editDialogTitle: "Modifier la transaction",
  kindTablist: "Type de transaction",

  familyGroupLabel: "Famille d'opération",
  familySecurities: "Titres",
  familyCash: "Espèces",
  familyIncome: "Revenus",
  familyTransfers: "Transferts",
  moreOptions: "Plus d'options",
} as const satisfies Readonly<Record<TransactionCopyKey, string>>;

/**
 * Why the preview cannot state a figure, one sentence per reason.
 *
 * Keyed by `PreviewGap` rather than by a string of this table's own, so a new
 * gap in `transaction-preview.ts` is a type error here — the same argument
 * `Icon.tsx`'s REGISTRY makes, and the reason this stayed a separate record
 * when it moved out of `TransactionPreviewBlock.tsx`. Every entry names the
 * *reason*; none substitutes a figure in the wrong unit for the one it cannot
 * compute.
 */
export const PREVIEW_GAP_COPY = {
  incomplete: "Renseignez la quantité et le prix unitaire.",
  // FT-47: re-keyed from `fee-currency-differs`, and the sentence rewritten
  // with it. The old copy blamed the *fee's* devise, which no longer exists as
  // a separate thing — a cost is denominated by the settling account (L5), so
  // what disagrees is the account's currency and the trade's.
  "settlement-currency-differs":
    "Le compte espèce choisi est dans une autre devise que la transaction : les frais y sont prélevés, donc le total dans la devise de la transaction ne peut pas être calculé ici.",
  "rate-resolved-on-save":
    "Le taux de change sera déterminé à l'enregistrement. Saisissez-en un pour voir l'équivalent.",
  "kind-has-no-cash-direction": "Le montant dépend du type de transaction choisi.",
  // FT-23: the same gap treatment as the four above — a sentence naming the
  // reason, never a figure in the trade's currency standing in for one in the
  // account's.
  "settlement-amount-missing":
    "Le compte espèce choisi est dans une autre devise : indiquez le montant réglé pour voir le mouvement.",
} as const satisfies Readonly<Record<PreviewGap, string>>;
