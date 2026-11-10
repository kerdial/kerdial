/**
 * `copy/instruments.ts` — the instrument fiche and everything that writes to it.
 *
 * `InstrumentDetailView.tsx`, the manual-price form and its dialog, the price
 * point table, the sparkline's caveats, the classification correction form, and
 * the history-reload button that appears on two screens.
 *
 * **What is deliberately NOT here.** « Secteur détaillé » is a *label*; the
 * industry string it shows is the provider's own and is rendered as received,
 * never translated (NFR-4) — same for `status` and the primary
 * identifier. `sector-display.ts` and `country-display.ts` already own their
 * « Non classé » / « Non renseigné » fallbacks (AC-5) and keep them.
 *
 * **`quotePolicy` was on that list and should not have been.**
 * It is not a provider string: it is this product's own two-valued enum, and
 * the Instruments list has always shown it in French through
 * `InstrumentTable.tsx`'s `priceSourceLabel` (« Saisie manuelle » /
 * « Automatique »). Only the fiche printed the raw `MANUAL_ONLY` token, so the
 * note was describing one screen while the other already contradicted it. The
 * fiche now calls the same helper; the wire token stays reachable as
 * `data-quote-policy`, exactly as on the mobile card list. What A7/NFR-4
 * protects — identifiers and provider text — is untouched.
 *
 * **« Pays de cotation » and « Pays du siège social » are two keys on purpose**
 * (AC-11): `listingCountry` is derived server-side from the MIC and
 * `domicileCountry` is the issuer's own. They differ for Airbus, Stellantis,
 * STMicroelectronics, ArcelorMittal and EssilorLuxottica, and one merged
 * « pays » label would silently pick one.
 */
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";

export type InstrumentCopyKey =
  // --- the fiche
  | "loadingDetail"
  | "detailPanel"
  | "breadcrumb"
  | "breadcrumbInstruments"
  | "enterManualPrice"
  // --- the delete affordance and its dialog
  | "deleteInstrument"
  | "deleteDialogTitle"
  | "deleteWarning"
  | "deleteWhatGoes"
  | "deleteIrreversible"
  | "deleteConfirm"
  | "deleteFailed"
  | "priceHistory"
  | "displayedRange"
  | "loadingChart"
  | "periodSliderFrom"
  | "periodSliderTo"
  | "periodRefineLabel"
  | "identityCard"
  | "displayName"
  | "symbol"
  | "isin"
  | "figi"
  | "exchangeMic"
  | "listingCurrency"
  | "kind"
  | "quotePolicy"
  | "primaryIdentifier"
  | "sector"
  | "industry"
  | "listingCountry"
  | "domicileCountry"
  | "classificationSaved"
  | "editInstrument"
  | "editInstrumentDialogTitle"
  | "editSectionIdentity"
  | "editSectionClassification"
  | "identitySaved"
  | "identityDisplayNameLabel"
  | "identityFigiLabel"
  | "identityFigiPlaceholder"
  | "identityFigiAlreadySetHint"
  | "identitySubmit"
  | "manualPricingRequired"
  | "automaticPricing"
  | "historyStatusCard"
  | "historyRequestedFrom"
  | "historyEarliest"
  | "historyLastQuote"
  | "historyLatest"
  | "portfolioContext"
  | "loadingPortfolioContext"
  | "heldNow"
  | "notHeldNow"
  | "heldQuantity"
  | "heldValue"
  | "noPortfolioAttribution"
  | "manualPriceDialogTitle"
  | "priceSaved"
  // --- the manual-price form
  | "priceDate"
  | "priceDateAlreadyUsedHint"
  | "priceDateTaken"
  | "priceDateTakenCaveat"
  | "price"
  | "priceCurrency"
  | "savePrice"
  // --- the price point table
  | "loading"
  | "noPricePointsInRange"
  | "noPricesInWindow"
  | "columnDate"
  | "columnPrice"
  | "columnOrigin"
  | "columnSource"
  | "carriedForward"
  | "originManual"
  | "originAutomatic"
  // --- the sparkline's caveats
  | "tradesBeforeFirstPrice"
  | "tooManyTrades"
  | "windowIncomplete"
  | "unreadablePrices"
  | "manualPointsLegend"
  // --- the classification form
  | "classificationSector"
  | "classificationDomicile"
  | "classificationDomicilePlaceholder"
  | "classificationDomicileHint"
  | "classificationIndustry"
  | "classificationClear"
  | "classificationSubmit"
  // --- the manual-price dialog (from the holdings surfaces)
  | "lastKnownPrice"
  // --- the reload button, on the Instruments list and on Contrôles
  | "reloadHistory"
  | "reloadAccepted"
  // --- the Instruments list
  | "listPanel"
  | "scanErrorPrefix"
  | "scanLoading"
  | "historyScanTruncated"
  | "catalogueErrorPrefix"
  | "statTracked"
  | "statTrackedHint"
  | "statCoverage"
  | "statCoverageHint"
  | "statManual"
  | "statManualHint"
  | "statAttention"
  | "statAttentionHint"
  | "filterSource"
  | "filterKind"
  | "filterAllKinds"
  | "filterQuery"
  | "filterQueryPlaceholder"
  | "resetFilters"
  | "loadingCatalogue"
  | "catalogueSampleHint"
  | "loadingOwned"
  | "noMatchingInstruments"
  | "firstPage"
  | "nextPage"
  | "countOne"
  | "countMany"
  // --- the mobile card list
  | "cardOpen"
  | "cardDetails"
  | "cardKind"
  | "cardSector"
  | "cardSymbol"
  | "cardExchange"
  | "cardCurrency"
  | "cardPriceSource"
  | "cardQuotedAt"
  | "cardHistoryThrough"
  | "cardCoverage"
  | "cardHeldState"
  // --- creating one
  | "createDialogTitle"
  | "createDialogDescription"
  | "created"
  | "duplicateExists"
  | "useExisting"
  | "duplicateUnresolved"
  | "createKind"
  | "isinSourceHint"
  | "symbolOptional"
  | "classificationFromSearch"
  | "figiOptional"
  | "createFailed"
  | "create"
  | "chooseExchange"
  | "otherExchange"
  | "discoverySearch"
  | "discoveryEmpty"
  // --- the SCPI kind (scpi cycle)
  | "isinOptional"
  | "scpiCode"
  | "scpiCodeHint"
  | "quotePolicyManualFixed"
  | "managementCompany"
  | "subscriptionFeePct"
  | "subscriptionFeePctInput"
  | "editSectionScpi"
  | "scpiAttributesSaved"
  | "enterScpiPrice"
  // --- the asset-search popover
  | "createInstrumentAction"
  | "filterByAssetClass"
  | "searchPlaceholder"
  | "keyboardHintNavigate"
  | "keyboardHintSelect"
  | "noSearchMatch"
  | "noClassMatch"
  | "searching"
  | "resultsLabel"
  // --- the uploaded instrument icon (`instrument-icons`, IK-14; FR-315)
  | "iconManage"
  | "iconAdd"
  | "iconReplace"
  | "iconRemove"
  | "iconRemoveConfirm"
  | "iconConstraints"
  | "iconChooseFile"
  | "iconReady"
  | "iconSaved"
  | "iconRemoved"
  | "iconDialogTitle"
  | "iconNone";

export const INSTRUMENT_COPY = {
  loadingDetail: "de la fiche instrument",
  detailPanel: "Fiche instrument",
  breadcrumb: "Fil d'Ariane",
  breadcrumbInstruments: "Instruments",
  enterManualPrice: "Saisir un cours manuel",
  // The warning names the categories rather than a single count: the
  // price history is the bulk of it and is the part a reader cannot guess,
  // but the watchlist entry and the manual prices are the ones they would
  // actually miss.
  deleteInstrument: "Supprimer l'instrument",
  deleteDialogTitle: "Supprimer cet instrument ?",
  deleteWarning: "Cet instrument sera supprimé du catalogue, ainsi que tout ce qui s'y rattache.",
  deleteWhatGoes:
    "Sont également supprimés : l'historique des cours, les cours saisis manuellement, l'icône, le suivi et la correspondance avec le fournisseur de données.",
  deleteIrreversible:
    "Cette action est irréversible. L'historique des cours devra être récupéré à nouveau si vous recréez l'instrument.",
  deleteConfirm: "Supprimer définitivement",
  deleteFailed: "La suppression a échoué.",
  priceHistory: "Historique des cours",
  displayedRange: "Période affichée",
  loadingChart: "Chargement du graphique…",
  periodSliderFrom: "Début",
  periodSliderTo: "Fin",
  /** The single-line dual-handle refine control's own label (2026-09-09) — distinct from `displayedRange`, the preset selector's label just above it in the same card. */
  periodRefineLabel: "Affiner",
  identityCard: "Informations sur l'instrument",
  displayName: "Nom affiché",
  symbol: "Symbole",
  isin: "ISIN",
  figi: "FIGI",
  exchangeMic: "Place de cotation",
  listingCurrency: "Devise de cotation",
  kind: "Type",
  quotePolicy: "Politique de cours",
  primaryIdentifier: "Identifiant principal",
  sector: "Secteur",
  industry: "Secteur détaillé",
  listingCountry: "Pays de cotation",
  domicileCountry: "Pays du siège social",
  classificationSaved: "Classification enregistrée.",
  /*
   * One affordance where there were three. « Corriger le secteur ou le
   * pays » and « Modifier le nom ou le FIGI » were two buttons and two dialog
   * titles for what a reader thinks of as one action, and « Gérer l'icône »
   * was a third; the identity and classification forms now stack as two
   * sections of a single dialog (each keeps its own submit and its own
   * confirmation), and the icon moved to the pencil on the badge.
   *
   * So the button says only « Modifier »: it no longer names the fields it
   * reaches, because it reaches all of them, and the two section headings
   * below are what say which is which. The dialog title names the object
   * rather than repeating the verb alone.
   */
  editInstrument: "Modifier",
  editInstrumentDialogTitle: "Modifier l'instrument",
  editSectionIdentity: "Identité",
  editSectionClassification: "Classification",
  identitySaved: "Identité enregistrée.",
  identityDisplayNameLabel: "Nom affiché",
  identityFigiLabel: "FIGI",
  identityFigiPlaceholder: "BBG000BLNNH6",
  /** Shown instead of the FIGI input once one is already stored — fill-once, not correct-or-clear (migration 0061). */
  identityFigiAlreadySetHint:
    "Un FIGI est déjà enregistré pour cet instrument : il ne peut pas être remplacé depuis cet écran.",
  identitySubmit: "Enregistrer",
  manualPricingRequired:
    "Cet instrument nécessite une saisie manuelle du cours : aucune source automatique n'est configurée pour lui.",
  automaticPricing: "Le cours de cet instrument est normalement fourni automatiquement.",
  historyStatusCard: "État de l'historique",
  historyRequestedFrom: "Demandé depuis",
  historyEarliest: "Premier cours disponible",
  /* This said « Dernier cours disponible » for `latestBackfilledDate`,
     which is the backfill resume bookmark — a quote refresh writes a newer
     price and never moves it, so the label was claiming something the value
     could not deliver. The freshness claim now has its own row and its own
     value. */
  historyLastQuote: "Dernier cours reçu",
  historyLatest: "Historique jusqu'au",
  portfolioContext: "Contexte portefeuille",
  loadingPortfolioContext: "du contexte portefeuille",
  heldNow: "Détenu actuellement",
  notHeldNow: "Non détenu actuellement",
  heldQuantity: "Quantité (tous portefeuilles)",
  heldValue: "Valeur (tous portefeuilles)",
  noPortfolioAttribution:
    "Cette réponse ne porte pas d'identifiant de portefeuille : il n'est pas possible d'indiquer ici dans quel(s) portefeuille(s), précisément, cet instrument est détenu.",
  manualPriceDialogTitle: "Saisir un cours manuel",
  priceSaved: "Cours enregistré.",

  priceDate: "Date",
  /** AC129: stated unconditionally — the upsert applies to every date, not only ones the pre-check resolved. */
  priceDateAlreadyUsedHint:
    "Saisir un cours pour une date déjà utilisée remplace la valeur existante pour cette date — il n'y a pas de création distincte. L'ancienne valeur reste conservée dans la piste d'audit.",
  priceDateTaken: "Une valeur existe déjà pour cette date et sera remplacée.",
  /** Rendered under `priceDateTaken`, after a `<br />` — two keys because it is two lines. */
  priceDateTakenCaveat:
    "Cette vérification est indicative : une écriture concurrente reste possible entre la vérification et l'enregistrement.",
  price: "Cours",
  priceCurrency: "Devise",
  savePrice: "Enregistrer",

  loading: "Chargement…",
  /**
   * Two "no prices" sentences, and they are not interchangeable: the table
   * shows the *affichée* range and the chart the *sélectionnée* window. They
   * were two strings before this module existed and stay two here.
   */
  noPricePointsInRange: "Aucun cours disponible pour cet instrument sur la période affichée.",
  noPricesInWindow: "Aucun cours disponible pour cet instrument sur la période sélectionnée.",
  columnDate: "Date",
  columnPrice: "Cours",
  columnOrigin: "Origine",
  columnSource: "Source",
  carriedForward: "(dernier cours applicable)",
  originManual: "Manuel",
  originAutomatic: "Automatique",

  /** `{count}` arrives stringified — the sparkline counts, this table does not. */
  tradesBeforeFirstPrice:
    "{count} opération(s) sont antérieures au premier cours disponible de la période et n'ont pas pu être placées sur le graphique.",
  tooManyTrades:
    "Trop d'opérations sur cette période : seules les premières sont marquées sur le graphique. La liste complète figure sur l'écran Activité.",
  windowIncomplete:
    "Fenêtre incomplète : seule une partie de la période sélectionnée a été chargée. Le graphique ne montre pas l'intégralité de la période.",
  unreadablePrices: "{count} cours illisible(s) ont été écartés du graphique.",
  manualPointsLegend:
    "Les points en losange sont des cours saisis manuellement. Le détail par point figure dans l'historique des cours ci-dessous.",

  classificationSector: "Secteur",
  classificationDomicile: "Pays du siège social",
  /** An example code, not a French word — an ISO 3166-1 alpha-2 placeholder. */
  classificationDomicilePlaceholder: "NL",
  /** `{unknown}` is `country-display.ts`'s own « Non renseigné » label, never a second wording of it. */
  classificationDomicileHint: "Code pays à deux lettres. Laisser vide pour « {unknown} ».",
  classificationIndustry: "Secteur détaillé",
  classificationClear: "Effacer",
  classificationSubmit: "Enregistrer la correction",

  lastKnownPrice: "Dernier cours connu",

  reloadHistory: "Relancer la récupération",
  reloadAccepted: "Récupération relancée.",

  listPanel: "Instruments détenus",
  scanErrorPrefix: "Impossible de vérifier l'historique complet des transactions :",
  scanLoading: "Recherche des instruments déjà vendus…",
  /**
   * The same sentence as `CONTROLS_COPY.truncatedNote`, and the duplication is
   * deliberate: `controls-copy-audit.test.ts` scans `copy/controls.ts` as one
   * of the seven files the Contrôles screen is made of, so that screen's copy
   * cannot be imported from here without moving it out from under its own
   * audit. Two screens, two tables, one wording — checked by eye rather than
   * by import.
   */
  historyScanTruncated:
    "Historique analysé partiellement — les instruments vendus il y a longtemps peuvent manquer.",
  catalogueErrorPrefix: "Impossible de charger le catalogue :",
  statTracked: "Instruments suivis",
  statTrackedHint: "Détenus ou déjà transigés",
  statCoverage: "Couverture des cours",
  statCoverageHint: "Historique complet",
  statManual: "Cours manuel",
  statManualHint: "Aucune source automatique",
  statAttention: "À surveiller",
  statAttentionHint: "Récupération de l'historique en échec",
  filterSource: "Source des instruments",
  filterKind: "Type",
  filterAllKinds: "Tous les types",
  filterQuery: "Recherche",
  filterQueryPlaceholder: "Nom, symbole, ISIN",
  resetFilters: "Réinitialiser les filtres",
  loadingCatalogue: "du catalogue d'instruments",
  /**
   * Provenance **where a seeded row actually reaches a user**,
   * which is the search, not a browse screen.
   *
   * Someone who has just installed the app opens the transaction form, types
   * three letters and gets « Air Liquide », « Airbus » — with nothing saying
   * why those exist. This is the one line that answers it.
   *
   * Names no index (AC-25 still binds), says nothing about membership
   * tracking, and carries no date or count: the drift test binds
   * `INSTRUMENT_CATALOGUE_AS_OF`/`_SIZE` to the dataset, and a figure in this
   * position would be noise beside the thing the user needs to know — that
   * some of these rows shipped with the app rather than being entered by
   * someone.
   */
  catalogueSampleHint:
    "Certains résultats proviennent du catalogue d'exemple livré avec l'application.",
  loadingOwned: "des instruments détenus",
  noMatchingInstruments: "Aucun instrument ne correspond aux filtres sélectionnés.",
  firstPage: "Première page",
  nextPage: "Page suivante",
  /** Two forms rather than a `{s}` slot: a plural is a grammar rule, not a suffix, and the next locale's is not French's. */
  countOne: "{count} instrument affiché",
  countMany: "{count} instruments affichés",

  cardOpen: "Voir",
  /** The mobile card's disclosure for its definition rows. */
  cardDetails: "Détails",
  cardKind: "Type",
  cardSector: "Secteur",
  cardSymbol: "Symbole",
  cardExchange: "Place",
  cardCurrency: "Devise",
  cardPriceSource: "Source du cours",
  /* « Mise à jour » was this card's label for the backfill bookmark,
     which no quote write moves — the two dates are now named for what they
     each are. */
  cardQuotedAt: "Cours du",
  cardHistoryThrough: "Historique jusqu'au",
  cardCoverage: "Couverture",
  cardHeldState: "Détention",

  /** The dialog's title. `SHELL_COPY.newInstrument` is the *button* that opens it — same words, two surfaces, two keys. */
  createDialogTitle: "Nouvel instrument",
  createDialogDescription:
    "Action, ETF, fonds (par ISIN + place de cotation) ou crypto-actif (par symbole).",
  created: "Instrument créé : {name}.",
  duplicateExists: "Cet instrument existe déjà : {name} ({identifier}).",
  useExisting: "Utiliser cet instrument",
  duplicateUnresolved:
    "Cet instrument existe déjà, mais n'a pas pu être localisé automatiquement. Recherchez-le directement dans le champ de recherche.",
  createKind: "Type d'instrument",
  /** Decision D2: the search source never returns an ISIN, so the field staying empty is by design, not a fault. */
  isinSourceHint:
    "La source de recherche ne fournit pas l'ISIN — à saisir manuellement, sauf si vous l'avez déjà tapé dans la recherche.",
  symbolOptional: "Symbole (optionnel)",
  classificationFromSearch: "Classification (source de recherche)",
  figiOptional: "FIGI (optionnel)",
  createFailed: "La création a échoué.",
  create: "Créer",
  chooseExchange: "— Choisir une place de cotation —",
  otherExchange: "Autre — saisir le code MIC",
  discoverySearch: "Rechercher un instrument (nom, symbole, ISIN)…",
  discoveryEmpty: "Aucun résultat — vous pouvez saisir les informations manuellement.",

  /*
   * The SCPI kind (scpi cycle). An SCPI has no listing and no provider: no search, no place de
   * cotation, an optional ISIN with a « Code » standing in when it is empty,
   * and a price the user enters — a « prix de part », not a « cours ».
   */
  isinOptional: "ISIN (facultatif)",
  scpiCode: "Code",
  scpiCodeHint: "Obligatoire si l'ISIN est vide",
  quotePolicyManualFixed: "Saisie manuelle",
  managementCompany: "Société de gestion",
  subscriptionFeePct: "Frais de souscription",
  subscriptionFeePctInput: "Frais de souscription (%)",
  editSectionScpi: "Caractéristiques SCPI",
  scpiAttributesSaved: "Caractéristiques enregistrées.",
  enterScpiPrice: "Saisir un prix de part",

  createInstrumentAction: "Créer un instrument…",
  filterByAssetClass: "Filtrer par classe d'actif",
  searchPlaceholder: "Rechercher (symbole, ISIN, nom)",
  /** Both keep their leading space: they follow an `aria-hidden` glyph on the same line. */
  keyboardHintNavigate: " pour naviguer, ",
  keyboardHintSelect: " pour sélectionner, Échap pour fermer.",
  noSearchMatch: "Aucun instrument ne correspond à cette recherche.",
  noClassMatch: "Aucun instrument de cette classe — élargissez le filtre ou créez l’instrument.",
  searching: "Recherche…",
  resultsLabel: "Instruments trouvés",

  /*
   * The uploaded instrument icon — FR-315/NFR-6 (IK-14). Twelve keys, and they sit in **both**
   * halves of this module by construction: `INSTRUMENT_COPY` is
   * `satisfies Readonly<Record<InstrumentCopyKey, string>>`, so a key added
   * here and not to the union above (or the reverse) is a type error rather
   * than a string that renders as `undefined`.
   *
   * **`iconCard` was the thirteenth and is gone.** It titled the
   * identity card's « Icône de l'instrument » sub-header, and that whole
   * section — heading and « Gérer l'icône » button — was replaced by the
   * pencil chip on the badge. `iconManage` survives as that chip's accessible
   * name and tooltip, so the words a user reads for the action are unchanged;
   * only the section heading, which no longer has a section, is dropped rather
   * than kept as copy nothing renders. `iconDialogTitle` (the same words
   * `iconCard` carried) is untouched — the dialog it titles is the same
   * dialog, reached from a new trigger.
   */
  iconManage: "Gérer l'icône",
  iconAdd: "Ajouter une icône",
  iconReplace: "Remplacer l'icône",
  iconRemove: "Supprimer l'icône",
  iconRemoveConfirm: "Supprimer définitivement cette icône ? L'instrument reprendra ses initiales.",
  /*
   * The three ceilings, **interpolated from the constants** rather than typed
   * as digits (`api-limits.ts`'s own rule: no UI copy hardcodes a cap as a
   * literal). `INSTRUMENT_ICON_MAX_BYTES / 1024` is 256 and
   * `INSTRUMENT_ICON_MAX_PIXELS` is 512, so no thousands separator is involved
   * and this needs none of `problem-messages.ts`'s `frCount` — which is what
   * keeps this catalogue a catalogue rather than a second locale
   * implementation (`fill.ts`'s own header). If either ceiling ever passes 999
   * this string needs a formatter, and that is a deliberate trade recorded
   * here rather than a formatter added speculatively.
   *
   * « Ko » is FR-315's own user-facing wording for 262 144 bytes,
   * which is strictly 256 KiB. Assumption A6: the copy keeps FR-315's
   * string, the constant keeps the binding number. Flagged, not corrected to
   * « Kio ».
   */
  iconConstraints: `PNG ou JPEG, ${INSTRUMENT_ICON_MAX_BYTES / 1024} Ko maximum, ${INSTRUMENT_ICON_MAX_PIXELS} × ${INSTRUMENT_ICON_MAX_PIXELS} pixels maximum`,
  iconChooseFile: "Choisir un fichier",
  /*
   * The verdict line of the facts panel that stands in for a preview: `img-src
   * 'self'` admits neither `blob:` nor `data:`, so `URL.createObjectURL(file)`
   * renders nothing and there is no thumbnail to show (V6, NG7).
   *
   * Text only, and **no « ✓ »**: an early mock-up illustrated this line with
   * U+2713, which `kerdial-tokens/no-inline-icons` reports as an emoji used as
   * UI text (its dingbat range is U+2600–U+27BF) at `error` severity, in every
   * `web/src/**` file including this one. Flagged rather than worked around.
   */
  iconReady: "Prêt à être envoyé",
  iconSaved: "Icône enregistrée.",
  iconRemoved: "Icône supprimée.",
  iconDialogTitle: "Icône de l'instrument",
  iconNone: "Aucune icône — les initiales sont affichées.",
} as const satisfies Readonly<Record<InstrumentCopyKey, string>>;
