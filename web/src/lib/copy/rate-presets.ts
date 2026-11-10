/**
 * `copy/rate-presets.ts` — the rate chips under Courtage, Taxes and Retenue,
 * and the « + » mini-form that adds one (`transaction-dialog-refresh`:
 * FR-652..FR-658, corrections C-5, C-12, C-13).
 *
 * **The pill text is not here.** « Fortuneo 0.35 % · min 2 EUR » is built from
 * the user's own label and canonical rate by `presetPillLabel`
 * (`rate-preset-math.ts`): a canonical string with `.` as the decimal mark
 * (C-6), never `formatPercentage`, which would round a four-decimal rate.
 *
 * **The four hints say what to do, not what went wrong**: each ends on
 * « saisissez le montant », because typing the amount is always possible — a
 * disabled chip never blocks the field (FR-655, FR-657, FR-666).
 */
export type RatePresetCopyKey =
  | "chipGroupLabel"
  | "chipsNoBaseHint"
  | "chipsCurrencyMismatchHint"
  | "chipsSettledInAssetHint"
  | "presetsUnavailableHint"
  | "presetsCapHint"
  | "chipOverflow"
  | "chipAdd"
  | "addGroupLabel"
  | "addLabel"
  | "addRate"
  | "addMinimum"
  | "addSubmit"
  | "addCancel"
  | "addLabelInvalid"
  | "addLabelDuplicate"
  | "addRateInvalid"
  | "addMinimumInvalid"
  | "settingsTitle"
  | "settingsIntro"
  | "settingsShared"
  | "settingsRubriqueBROKERAGE"
  | "settingsRubriqueTAX"
  | "settingsRubriqueWITHHOLDING"
  | "settingsEmpty"
  | "settingsMinimum"
  | "settingsEdit"
  | "settingsDelete"
  | "settingsMoveUp"
  | "settingsMoveDown"
  | "settingsEditDone"
  | "settingsSave"
  | "settingsSaved"
  | "settingsListInvalid";

export const RATE_PRESET_COPY = {
  chipGroupLabel: "Taux prédéfinis : {field}",
  /** FR-655: no base (quantity × price, or the gross) to apply a rate to yet. */
  chipsNoBaseHint: "Saisissez d'abord le montant",
  /** C-5: the one wording for FR-657 and TDR-L15. */
  chipsCurrencyMismatchHint:
    "Devise du compte différente — saisissez le montant dans la devise du compte",
  /** C-12: an asset-settled BUY has no unit price to apply a rate to. */
  chipsSettledInAssetHint: "Réglé en actif — saisissez le montant",
  /** FR-666 / AC-557: the presets read failed; the field stays typeable. */
  presetsUnavailableHint: "Taux prédéfinis indisponibles — saisissez le montant",
  /** TDR-L18: six presets per field at most. */
  presetsCapHint: "Six taux au maximum pour ce champ",
  /** C-13: presets 4 to 6, revealed inline in the same row. */
  chipOverflow: "Autres ({count})",
  /** The « + » pill's accessible name; its visible text is the glyph. */
  chipAdd: "Ajouter un taux",
  addGroupLabel: "Nouveau taux",
  addLabel: "Libellé",
  addRate: "Taux (%)",
  addMinimum: "Minimum (optionnel)",
  addSubmit: "Ajouter",
  addCancel: "Annuler",
  addLabelInvalid: "Un libellé de 1 à 40 caractères",
  addLabelDuplicate: "Ce libellé existe déjà pour ce champ",
  addRateInvalid: "Un taux supérieur à 0 et au plus 100, avec 4 décimales au plus (ex. 0.35)",
  addMinimumInvalid: "Un montant positif ou nul, avec 2 décimales au plus (ex. 2.00)",
  /** The « Mon compte » card (FR-665). */
  settingsTitle: "Taux prédéfinis",
  /** TDR-L17: a preset is the user's own example, never a tax rule. */
  settingsIntro:
    "Ces taux sont des exemples à adapter à votre situation, jamais des règles fiscales : vérifiez-les auprès de votre courtier.",
  /** O-5: one list per household (tenant), not per sign-in. */
  settingsShared: "Ils sont partagés par tous les comptes du foyer.",
  settingsRubriqueBROKERAGE: "Courtage",
  settingsRubriqueTAX: "Taxes",
  settingsRubriqueWITHHOLDING: "Retenue à la source",
  settingsEmpty: "Aucun taux pour cette rubrique.",
  settingsMinimum: "min {minimum}",
  settingsEdit: "Modifier {label}",
  settingsDelete: "Supprimer {label}",
  settingsMoveUp: "Monter {label}",
  settingsMoveDown: "Descendre {label}",
  settingsEditDone: "Valider",
  /** TDR-D3: one save replaces the whole list. */
  settingsSave: "Enregistrer",
  settingsSaved: "Taux prédéfinis enregistrés.",
  settingsListInvalid: "Corrigez les taux signalés avant d'enregistrer.",
} as const satisfies Readonly<Record<RatePresetCopyKey, string>>;
