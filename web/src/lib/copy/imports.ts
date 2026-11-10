/**
 * `copy/imports.ts` — the **Importer** wizard's own chrome.
 *
 * The four steps, the counts strip, the proposal editor and the row-outcome
 * table.
 *
 * **The import *vocabulary* is not here and must not move here.**
 * `web/src/lib/import-copy.ts` keys French copy by the reason codes the
 * importer package defines, and `import-copy.drift.test.ts` imports those real
 * closed vocabularies by relative path to assert the table covers every one —
 * so a code added server-side is a red test rather than an uppercase
 * identifier on a French screen. That coupling is the point of that file; this
 * one holds the step labels, headings and buttons around it, which are coupled
 * to nothing.
 */
import { KERDIAL_JSON_MAX_FILE_BYTES } from "../api-limits.js";

export type ImportCopyKey =
  // --- the screen and the type step
  | "screenTitle"
  | "screenSubtitle"
  | "chooseType"
  // --- `portfolio-export-import`: the two « Exporter » actions
  | "exportTitle"
  | "exportExplanation"
  | "exportCatalogue"
  | "exportTransactions"
  | "exportCeiling"
  | "exportCatalogueWithoutIcons"
  // --- the destination step
  | "destinationTitle"
  | "destinationExplanation"
  | "portfolio"
  | "chooseOption"
  | "cashAccount"
  | "cashAccountHint"
  | "changeType"
  | "continue"
  // --- the file step
  | "fileExplanation"
  | "fileInputLabel"
  | "back"
  | "analyse"
  // --- the review and result steps
  | "proposalsTitle"
  | "proposalsExplanation"
  // --- `security-transfer` FR-583: where a transfer's units went
  | "transferDecisionsTitle"
  | "transferDecisionsExplanation"
  | "transferDestination"
  | "transferDestinationNone"
  | "transferDestinationNew"
  | "transferNewPortfolioName"
  | "transferNewPortfolioNameInvalid"
  | "unimportedRows"
  | "changeFile"
  | "confirmImport"
  | "nextFile"
  | "importAnother"
  // --- the Kerdial catalogue's own review/result surfaces
  | "catalogueSectionsTitle"
  | "catalogueSectionsExplanation"
  | "noEntriesToReport"
  | "entryColumnEntry"
  | "warningsTitle"
  | "warningsExplanation"
  | "warningsTruncated"
  // --- the remainder of a file the apply deadline cut short
  | "continueImport"
  | "continueImportExplanation"
  | "continueImportProgress"
  | "continueImportStop"
  | "continueImportStopRequested"
  | "continueImportNoProgress"
  | "continueImportRunCap"
  // --- the counts strip
  | "rowsImported"
  | "rowsSkipped"
  | "rowsRejected"
  | "applyShortfall"
  | "reasonBreakdown"
  // --- the proposal editor
  | "noProposals"
  | "columnLine"
  | "columnSecurity"
  | "columnKind"
  | "columnExchange"
  | "columnOrigin"
  | "alreadyCatalogued"
  | "invalidExchangeMic"
  // --- the row-outcome table
  | "noRowsToReport"
  | "outcomeColumnLine"
  | "outcomeColumnResult"
  | "outcomeColumnReason"
  | "outcomeSkipped"
  | "outcomeRejected"
  | "rowsTruncated";

export const IMPORT_COPY = {
  screenTitle: "Importer",
  screenSubtitle:
    "Exporter vos données, ou reprendre un export : un export Kerdial (catalogue puis opérations) ou un export Portfolio Performance (titres, espèces, compte-titres).",
  chooseType: "Choisir ce type",

  exportTitle: "Exporter vos données",
  exportExplanation:
    "Deux fichiers, à conserver ou à réimporter ici : le catalogue (titres, icônes, cours saisis, liste de suivi, portefeuilles, comptes espèces, taux de change saisis) et les opérations.",
  exportCatalogue: "Exporter le catalogue (JSON)",
  exportTransactions: "Exporter les opérations (CSV)",
  /**
   * The stated mitigation, rendered **inline and unconditionally**.
   *
   * A `<a href download>` navigation cannot render a `413 problem+json` as
   * anything but raw JSON on screen, so the remedy is put in front of the user
   * before the failure rather than after it: someone whose catalogue exceeds
   * the ceiling has already read, on this same card, that the icons are what
   * made it big and that there is a link without them. The ceiling is stated in
   * MiB because that is the unit the server's own refusal message uses.
   *
   * **The number is interpolated, never typed** — `api-limits.ts`'s
   * `KERDIAL_JSON_MAX_FILE_BYTES` mirrors `importer`'s own constant and its
   * drift test holds the two equal (OD-6: no UI copy hardcodes a cap).
   */
  exportCeiling: `Le catalogue est limité à ${String(KERDIAL_JSON_MAX_FILE_BYTES / 1024 / 1024)} Mio, et ce sont les icônes qui pèsent. Si l'export est refusé pour cette raison :`,
  exportCatalogueWithoutIcons: "exporter le catalogue sans les icônes",

  destinationTitle: "Où écrire ces opérations ?",
  destinationExplanation:
    "Le portefeuille est le compte-titres ; le compte espèces en fait partie. Choisissez l'un puis l'autre — c'est ce rattachement qui relie les deux.",
  portfolio: "Portefeuille",
  chooseOption: "— Choisir —",
  cashAccount: "Compte espèces",
  cashAccountHint: "Les mouvements d'espèces de ce fichier seront imputés à ce compte.",
  changeType: "Changer de type",
  continue: "Continuer",

  fileExplanation:
    "Sélectionnez le fichier CSV exporté depuis Portfolio Performance. L'analyse n'écrit rien : elle indique ce qui serait importé.",
  fileInputLabel: "Fichier CSV à importer",
  back: "Revenir",
  analyse: "Analyser le fichier",

  proposalsTitle: "Titres à créer",
  proposalsExplanation:
    "Corrigez la nature ou la place de cotation si nécessaire : c'est la valeur affichée ici qui sera enregistrée.",
  /**
   * `security-transfer` FR-583/L4. The file names no destination for the units
   * it moved out, so each row asks; « Aucun » is Step A, a transfer out of
   * Kerdial. The second sentence is R-5's stated remedy: the destination
   * portfolio's own file recognises the arrival only once this one is in.
   */
  transferDecisionsTitle: "Titres transférés : vers quel portefeuille ?",
  transferDecisionsExplanation:
    "Ce fichier ne dit pas où sont allés les titres sortis. Choisissez le portefeuille qui les a reçus — existant ou nouveau — pour enregistrer les deux côtés du transfert, ou laissez « Aucun » s'ils ont quitté Kerdial. Importez ce fichier avant celui du portefeuille de destination : l'entrée des titres y sera alors reconnue.",
  transferDestination: "Portefeuille de destination",
  transferDestinationNone: "Aucun — titres sortis de Kerdial",
  transferDestinationNew: "Nouveau portefeuille…",
  transferNewPortfolioName: "Nom du nouveau portefeuille",
  transferNewPortfolioNameInvalid: "Indiquez un nom de portefeuille.",
  unimportedRows: "Lignes non importées",
  changeFile: "Changer de fichier",
  confirmImport: "Confirmer l'import",
  /** `{type}` is `IMPORT_FILE_TYPE_LABELS`'s own label — never a second name for the same file type. */
  nextFile: "Importer le fichier suivant : {type}",
  importAnother: "Importer un autre fichier",

  catalogueSectionsTitle: "Ce que contient ce fichier",
  /**
   * What the **file carried**, never what was written. The three counts above
   * already say what was written, and a second, subtly different answer to that
   * question is how a summary starts disagreeing with itself — the server's own
   * `sections` field carries the same distinction in its own doc comment.
   */
  catalogueSectionsExplanation:
    "Le décompte du fichier lui-même. Les trois compteurs ci-dessus disent, eux, ce qui a été écrit.",
  noEntriesToReport: "Aucun élément à signaler : tout le contenu de ce fichier a été importé.",
  entryColumnEntry: "Élément",
  /** Warnings are on entries that **are** imported — the copy must not read as a refusal. */
  warningsTitle: "Avertissements",
  warningsExplanation:
    "Ces éléments sont importés, mais méritent une vérification. Ils ne bloquent pas l'import.",
  warningsTruncated:
    "La liste des avertissements a été tronquée : seuls les premiers sont affichés ({count} au total).",

  /**
   * FR-537's designed remedy. The wizard re-posts the file on its own
   * until nothing is left, so the button is what remains after the user
   * stopped it, a request failed, or one of the two safety stops below fired.
   */
  continueImport: "Continuer l'import",
  continueImportExplanation:
    "L'import s'est interrompu avant la fin du fichier. Les lignes déjà écrites le restent : « Continuer l'import » reprend les suivantes et enchaîne les requêtes jusqu'à la fin.",
  /** Both slots arrive pre-formatted (`groupThousands`). `processed` = rows with an outcome, `total` = `rowCount`. */
  continueImportProgress: "Import en cours : {processed} / {total} lignes traitées",
  continueImportStop: "Arrêter",
  continueImportStopRequested:
    "Arrêt demandé : l'import s'arrête dès la fin de la requête en cours, dont les lignes restent écrites.",
  continueImportNoProgress:
    "L'import s'est arrêté : la dernière requête n'a traité aucune ligne de plus que la précédente. Les lignes déjà écrites le restent.",
  /** `{count}` arrives pre-formatted. */
  continueImportRunCap:
    "L'import s'est arrêté par précaution après {count} requêtes enchaînées. Les lignes déjà écrites le restent : « Continuer l'import » reprend les suivantes.",

  rowsImported: "Lignes importées",
  rowsSkipped: "Lignes ignorées",
  rowsRejected: "Lignes rejetées",
  /** Both counts arrive stringified. The last clause is the recovery, and it is the reason this sentence exists at all. */
  applyShortfall:
    "Sur les lignes rejetées, {failed} ont été refusées à l'écriture et {notAttempted} n'ont pas été traitées faute de temps. Les lignes déjà écrites le restent : relancez l'import du même fichier pour reprendre les autres.",
  reasonBreakdown: "Détail par motif",

  noProposals: "Aucun titre à créer depuis ce fichier.",
  columnLine: "Ligne",
  columnSecurity: "Titre",
  columnKind: "Nature",
  columnExchange: "Place de cotation",
  columnOrigin: "Origine",
  /**
   * The per-field message for a hand-typed MIC that fails
   * `exchangeMicSchema`. Says the rule rather than "valeur invalide": the user
   * typed four characters into a box that accepts four characters, so the only
   * useful message is which four.
   */
  invalidExchangeMic:
    "Code MIC invalide : 4 caractères, lettres majuscules ou chiffres (ex. XPAR).",
  alreadyCatalogued: "déjà au catalogue, rien à créer",

  noRowsToReport: "Aucune ligne à signaler : toutes les lignes de ce fichier ont été importées.",
  outcomeColumnLine: "Ligne",
  outcomeColumnResult: "Issue",
  outcomeColumnReason: "Motif",
  outcomeSkipped: "Ignorée",
  outcomeRejected: "Rejetée",
  rowsTruncated:
    "Le détail ligne à ligne a été tronqué : seules les premières lignes concernées sont listées. Les compteurs ci-dessus, eux, portent sur la totalité du fichier.",
} as const satisfies Readonly<Record<ImportCopyKey, string>>;
