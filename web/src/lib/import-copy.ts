import {
  TRANSACTION_IMPORT_FILE_TYPES,
  type ImportFileTypeName,
  type ImportRowSourceResponse,
} from "@kerdial/api-contracts";
import { formatIsoDateFr } from "./history-status-copy.js";
import { transactionKindLabel } from "./transaction-kind.js";

/**
 * The French copy the `/import` wizard renders — labels for the five file
 * types, and one sentence per reason code (CI-22).
 *
 * ## Why the reason table is keyed by a bare string
 *
 * `ImportSummaryResponse.byReason` is `Record<string, number>` and
 * `ImportRowOutcomeResponse.reason` is a `string`, deliberately: the closed
 * vocabularies (`IMPORT_SKIP_REASONS`/`IMPORT_REJECT_REASONS`) live in
 * `@kerdial/importer`, a **server-side** package `web` may not import at all
 * (`.dependency-cruiser.cjs`'s `web-no-server-runtime-imports`). So this table
 * is keyed by string and {@link importReasonLabel} falls back to the raw code
 * rather than rendering nothing — a code this table has not caught up with
 * still reaches the user as *something named*, which is the property
 * IMP-AC-13 ("a named reason, never a bare 'invalid row'") is about.
 * `import-copy.drift.test.ts` asserts the table covers the real vocabulary by
 * importing the server-side constants **in a test file only** — the same
 * `api-limits.drift.test.ts` precedent, so a code added server-side without
 * copy here is a red test rather than an English string on screen.
 *
 * **That file's name is corrected here, and the correction is the fix**
 * (F-B, EI-36): this header used to name
 * `import-copy.test.ts`, which had never existed, so the guarantee the
 * paragraph above states was carried by nothing at all. The drift test now
 * exists under the name written above.
 *
 * ## What is deliberately not here
 *
 * The two behavioural notices the UI has to state out loud
 * (`IMPORT_EDITED_ROW_NOTICE`, `IMPORT_MANUAL_ROW_NOTICE`) live in
 * `core/api-contracts`, written by CI-14, and are rendered from there
 * verbatim. Re-typing either sentence here would be exactly the drift that
 * module exists to prevent.
 */

/** Step 1's three cards. NG3: the user always says which file this is — nothing is detected. */
export const IMPORT_FILE_TYPE_LABELS: Readonly<Record<ImportFileTypeName, string>> = {
  ASSETS: "Fichier de titres",
  CASH_ACCOUNT_TRANSACTIONS: "Opérations du compte espèces",
  INVESTMENT_ACCOUNT_TRANSACTIONS: "Opérations du compte-titres",
  // portfolio-export-import: the two Kerdial packages. Labels landed with
  // Batch B1's union widening so the missing-label compile error is answered at once; the
  // wizard cards, `needsDestination()` and the guided sequence are Batch E's (EI-33).
  KERDIAL_TRANSACTIONS: "Kerdial — transactions (CSV)",
  KERDIAL_CATALOGUE: "Kerdial — catalogue (JSON)",
};

export const IMPORT_FILE_TYPE_DESCRIPTIONS: Readonly<Record<ImportFileTypeName, string>> = {
  ASSETS:
    "Le catalogue des titres exporté depuis Portfolio Performance. Il crée les instruments manquants ; il n'écrit aucune opération.",
  CASH_ACCOUNT_TRANSACTIONS:
    "Les mouvements d'espèces : dépôts, retraits et dividendes. Les achats et ventes qu'il contient sont ignorés — le fichier du compte-titres fait foi pour ces lignes.",
  INVESTMENT_ACCOUNT_TRANSACTIONS:
    "Les achats et ventes du compte-titres, avec leurs frais et taxes.",
  KERDIAL_TRANSACTIONS:
    "Le fichier de transactions Kerdial : toutes les opérations de tous les portefeuilles, espèces et titres réunis, une ligne par opération. Il crée les portefeuilles et comptes espèces qu'il nomme.",
  KERDIAL_CATALOGUE:
    "Le catalogue Kerdial : instruments et leurs attributs, icônes, prix manuels, liste de suivi, taux de change saisis, portefeuilles et comptes espèces. Les cours fournis automatiquement ne sont pas importés — ils sont rechargés.",
};

/**
 * IMP-9's guided sequence, and the reason it is this order: the titres file
 * creates the instruments the two others refer to, and the espèces file funds
 * the account the compte-titres file spends from. Step 5's « Importer le
 * fichier suivant » walks it; every step remains independently reachable from
 * step 1, so this is a suggestion the UI makes, never a lock.
 */
export const IMPORT_GUIDED_SEQUENCE: readonly ImportFileTypeName[] = [
  "ASSETS",
  "CASH_ACCOUNT_TRANSACTIONS",
  "INVESTMENT_ACCOUNT_TRANSACTIONS",
];

/**
 * FR-556's own order, and a **second** sequence rather than two more entries
 * on the one above.
 *
 * The Portfolio-Performance journey is three files; the Kerdial one is two,
 * and the catalogue goes first because it carries the instruments,
 * portfolios and cash accounts the CSV's rows then refer to. Folding the two
 * into one five-step list would state something FR-556 explicitly denies —
 * that a Kerdial CSV needs a Portfolio-Performance file to have been imported
 * first — and would offer « Importer le fichier suivant » across two formats
 * that have nothing to do with each other.
 *
 * Like {@link IMPORT_GUIDED_SEQUENCE} this is guidance, never a lock: every
 * type stays independently reachable from step 1, and FR-556's "either alone"
 * case is exactly that.
 */
export const KERDIAL_SEQUENCE: readonly ImportFileTypeName[] = [
  "KERDIAL_CATALOGUE",
  "KERDIAL_TRANSACTIONS",
];

/** Every guided sequence, searched in order — a file type belongs to at most one. */
const GUIDED_SEQUENCES: readonly (readonly ImportFileTypeName[])[] = [
  IMPORT_GUIDED_SEQUENCE,
  KERDIAL_SEQUENCE,
];

/**
 * The next file type in **the sequence `current` belongs to**, or `undefined`
 * after that sequence's last entry.
 *
 * Reads the sequence rather than a single list precisely so the two journeys
 * cannot lead into each other — see {@link KERDIAL_SEQUENCE}.
 */
export function nextGuidedFileType(current: ImportFileTypeName): ImportFileTypeName | undefined {
  for (const sequence of GUIDED_SEQUENCES) {
    const at = sequence.indexOf(current);
    if (at >= 0) return sequence[at + 1];
  }
  return undefined;
}

/** The two Portfolio-Performance transaction file types — the only ones the wizard asks a destination for. */
export type ImportTransactionFileTypeName = (typeof TRANSACTION_IMPORT_FILE_TYPES)[number];

/**
 * Whether step 2 (« Destination ») applies to this file type.
 *
 * `true` for the two Portfolio-Performance transaction files and nothing else.
 * It used to be `isTransactionFileType()`, spelled "not `ASSETS`" — a
 * definition that was only ever correct because `ASSETS` was the single
 * destination-less type. The two Kerdial packages are destination-less for a
 * different reason each, and both would have been silently mis-classified by
 * the old spelling: a Kerdial CSV names its portfolio and cash account **per
 * row** (FR-532/FR-533), and a catalogue package carries whole portfolios and
 * has no rows at all. Asking either for one destination would ask for a value
 * nothing reads — which is also why the two Kerdial routes carry no
 * `portfolioId`/`cashAccountId` field on the wire.
 *
 * A type guard as well as a predicate, because the one place that still needs
 * a destination is also the one place that must narrow before calling
 * `importTransactionsFile`.
 */
export function needsDestination(
  fileType: ImportFileTypeName,
): fileType is ImportTransactionFileTypeName {
  return (TRANSACTION_IMPORT_FILE_TYPES as readonly ImportFileTypeName[]).includes(fileType);
}

/** The Kerdial packages — `portfolio-export-import`'s own two file types. */
export function isKerdialFileType(fileType: ImportFileTypeName): boolean {
  return fileType === "KERDIAL_CATALOGUE" || fileType === "KERDIAL_TRANSACTIONS";
}

/**
 * One sentence per reason code. Each names the rule that refused the row, in
 * the present tense, without blaming the user and without promising a retry
 * that will not happen — the register `problem-messages.ts` established.
 */
export const IMPORT_REASON_LABELS: Readonly<Record<string, string>> = {
  // --- parse/validate ---
  MALFORMED_ROW: "Ligne mal formée : elle n'a pas le même nombre de colonnes que l'en-tête.",
  MALFORMED_VALUE: "Valeur illisible : une cellule ne respecte pas le format attendu.",
  MISSING_REQUIRED_VALUE: "Une colonne obligatoire pour ce type de ligne est vide.",
  UNSUPPORTED_ROW_TYPE: "Ce type d'opération n'est pas pris en charge par l'import.",
  UNSUPPORTED_LEG: "Ce type d'opération ne peut pas porter ce montant de frais ou de taxes.",
  AMOUNT_NOT_POSITIVE: "Le montant de cette ligne doit être strictement positif.",
  // --- resolution ---
  INSTRUMENT_NOT_RESOLVED: "L'instrument de cette ligne n'a pas pu être identifié.",
  INSTRUMENT_AMBIGUOUS: "Plusieurs instruments correspondent à cette ligne.",
  EXCHANGE_MIC_NOT_RESOLVED: "La place de cotation de ce titre n'a pas pu être déterminée.",
  EXCHANGE_MIC_LOOKUP_UNAVAILABLE:
    "La place de cotation n'a pas pu être recherchée dans cette requête : relancez l'import pour réessayer ces lignes.",
  UNSUPPORTED_ASSET_CLASS: "Ce type d'actif n'est pas géré par l'application.",
  RESOLUTION_NOT_CONFIRMED: "Cette ligne n'a pas été confirmée à l'étape de revue.",
  // --- skips ---
  COVERED_BY_INVESTMENT_FILE:
    "Déjà portée par le fichier du compte-titres, qui fait foi pour cette opération.",
  // `security-transfer` FR-584/ST-13.
  COVERED_BY_TRANSFER_OUT:
    "Cette entrée est déjà enregistrée par le transfert sortant de l'autre portefeuille : elle n'est pas ajoutée une seconde fois.",
  // The second clause is `portfolio-export-import` F-F: a transaction
  // restored from a Kerdial export arrives carrying the fingerprint of the
  // source line it originally came from, so this code can name a row the user
  // restored rather than one they imported here. Saying "importée" alone would
  // send them looking for an import they never ran.
  ALREADY_IMPORTED:
    "Cette ligne a déjà été importée (ou restaurée depuis une sauvegarde) : elle n'est pas ajoutée une seconde fois.",
  INSTRUMENT_ALREADY_EXISTS: "Cet instrument est déjà au catalogue : il n'y a rien à créer.",
  // A marker line, not a bad figure. The copy says what the
  // line is, so the user does not go looking for a number to correct: this row
  // was previously reported as « un montant invalide », and it was the only
  // flagged row in a file where most rows were legitimately skipped.
  ZERO_VALUE_DIVIDEND_MARKER:
    "Ligne de dividende à zéro : un repère d'opération sur titre, sans mouvement d'espèces à importer.",
  // --- apply ---
  APPLY_FAILED: "L'écriture de cette ligne a été refusée.",
  APPLY_NOT_ATTEMPTED:
    "Cette ligne n'a pas été traitée : le temps imparti à l'import était écoulé. Relancez l'import pour la reprendre.",

  // ─── `portfolio-export-import`: the codes a Kerdial package adds ───
  //
  // One entry per **remedy**, not per stage: `PORTFOLIO_CAP_EXCEEDED`,
  // `CASH_ACCOUNT_CAP_EXCEEDED` and `CASH_ACCOUNT_CURRENCY_MISMATCH` are the
  // same literal in the CSV's `IMPORT_REJECT_REASONS` and the catalogue's
  // `CATALOGUE_REJECT_REASONS` (`catalogue-plan.ts` says so out loud), so they
  // get one sentence here, addressed to neither "row" nor "entry" in
  // particular.

  // --- the Kerdial CSV's six (plan/apply) ---
  CASH_ACCOUNT_CURRENCY_MISMATCH:
    "Un compte espèces de ce nom existe déjà dans ce portefeuille, dans une autre devise : la devise d'un compte ne se modifie pas.",
  PORTFOLIO_CAP_EXCEEDED:
    "Le nombre maximal de portefeuilles est atteint : ce portefeuille ne peut pas être créé. Supprimez un portefeuille inutilisé puis relancez l'import.",
  CASH_ACCOUNT_CAP_EXCEEDED:
    "Le nombre maximal de comptes espèces de ce portefeuille est atteint : ce compte ne peut pas être créé.",
  DRIP_SOURCE_NOT_RESOLVED:
    "Le dividende réinvesti par cette ligne est introuvable dans ce fichier : importez le fichier complet plutôt qu'un extrait.",
  SETTLEMENT_INSTRUMENT_NOT_RESOLVED:
    "Le titre remis en paiement de cette acquisition n'a pas pu être identifié : l'opération n'est pas enregistrée comme un simple achat au comptant.",
  CURRENCY_EXCHANGE_RATE_INCONSISTENT:
    "Le montant obtenu ne correspond pas au montant converti au taux indiqué : corrigez l'un des trois.",
  // `security-transfer` — a transfer stated as two rows of one file.
  TRANSFER_SOURCE_NOT_RESOLVED:
    "Le transfert sortant dont cette entrée est la contrepartie est introuvable dans ce fichier, ou a lui-même été refusé : importez le fichier complet plutôt qu'un extrait.",
  TRANSFER_PAIR_INCONSISTENT:
    "Les deux lignes de ce transfert ne concordent pas (titre, date, quantité, valeur, devise ou portefeuille), ou l'une n'a pas de contrepartie : aucune des deux n'est enregistrée.",

  // --- the catalogue's own ---
  CATALOGUE_ENTRY_UNCHANGED:
    "Cette fiche est déjà identique à celle du catalogue : il n'y a rien à écrire.",
  ICON_REJECTED: "L'icône de cette fiche a été refusée : le motif exact figure dans le détail.",
  ICON_CAP_EXCEEDED: "Le nombre maximal d'icônes est atteint : celle-ci n'est pas enregistrée.",
  WATCHLIST_CAP_EXCEEDED:
    "La liste de suivi est pleine : cette valeur n'y est pas ajoutée. Le reste de la fiche, lui, est importé.",
  MANUAL_PRICE_CAP_EXCEEDED:
    "Le nombre maximal de cours saisis à la main est atteint : ceux de cette fiche ne sont pas enregistrés.",
  CURRENCY_UNKNOWN: "Cette devise n'est pas connue de l'application.",
  PROVIDER_MAPPING_CONFLICT:
    "Le symbole de cotation de cette fiche est déjà attribué à un autre titre : un seul titre peut le porter.",
  PRIVATE_INSTRUMENT_UNSUPPORTED:
    "Cette fiche décrit un titre privé, propre à un compte : l'application n'a pas encore de moyen d'en créer.",

  // --- the catalogue's warnings: the entry IS imported ---
  ISIN_CHECK_DIGIT_MISMATCH:
    "Le code ISIN de ce titre ne respecte pas la clé de contrôle ISO 6166 : le titre est importé tel quel, vérifiez ce code.",
};

/** Falls back to the raw code, never to nothing — see this file's header. */
export function importReasonLabel(code: string): string {
  return IMPORT_REASON_LABELS[code] ?? code;
}

/**
 * What a catalogue package's sections are called in French.
 *
 * Keyed by string and not by a union, for this file's own header reason: the
 * keys are the **export's** section names (`CatalogueExportCounts`, server
 * side), `ImportSummaryResponse.sections` is a `Record<string, number>`, and
 * `web` may not import the module that declares them. A section this table has
 * not caught up with still reaches the user as *something named*, exactly as an
 * unknown reason code does.
 *
 * `ImportEntryOutcomeResponse.section` is a three-member subset of the same
 * keys, so it reads the same table — a second one would be two names for
 * « instruments ».
 */
export const CATALOGUE_SECTION_LABELS: Readonly<Record<string, string>> = {
  instruments: "titres",
  portfolios: "portefeuilles",
  cashAccounts: "comptes espèces",
  icons: "icônes",
  manualPrices: "cours saisis à la main",
  watchlistItems: "valeurs suivies",
  fxRatesUser: "taux de change saisis",
};

/** Falls back to the raw section name, never to nothing — see {@link CATALOGUE_SECTION_LABELS}. */
export function catalogueSectionLabel(section: string): string {
  return CATALOGUE_SECTION_LABELS[section] ?? section;
}

/**
 * Step 5's explicit line. `EXCHANGE_MIC_LOOKUP_UNAVAILABLE > 0` means
 * the request ran out of its own discovery budget before every row had its
 * turn — the designed behaviour, and re-running is the designed remedy.
 * Stated because the alternative (reporting the imported count as if it were
 * the whole file) is the dishonest one: it is the difference between
 * "N titres importés" and "N importés, M encore à résoudre".
 */
export const IMPORT_RERUN_HINT =
  "Certaines lignes n'ont pas pu être résolues dans cette requête : le nombre de recherches " +
  "qu'un import peut lancer est limité. Relancez l'import du même fichier pour réessayer " +
  "uniquement ces lignes — celles déjà importées ne le seront pas une seconde fois.";

/**
 * **RF7 (FT-43): the one-time duplicate this release knowingly causes.**
 *
 * A row's idempotency key is a hash over a fixed recipe, and this release added
 * the two cost figures to it — so every key changes, and a file imported before
 * the release no longer matches the keys computed for it now. The first
 * re-import of such a file therefore writes its rows **again**; the one after
 * that dedupes normally, because both sides are then on the new recipe.
 *
 * Stored keys are deliberately **not** rewritten (L8): a backfill would have to
 * re-derive every historical row's cost split from data the row no longer
 * carries. The consequence is accepted, and the revisit trigger is recorded in
 * the release note — the day the user imports a file they care about.
 *
 * **Shown before the user commits, never after.** A notice that appears on the
 * result screen tells someone what already happened to their data, which is not
 * a warning. It sits on the review step, beside the counts, where « Confirmer
 * l'import » is the next thing they will press.
 *
 * It also qualifies {@link IMPORT_RERUN_HINT} above, whose closing promise —
 * "celles déjà importées ne le seront pas une seconde fois" — is exactly the
 * guarantee this release spends once.
 */
export const IMPORT_PP2_REIMPORT_NOTICE =
  "Cette version enregistre le détail des frais et des taxes, ce qui change la signature " +
  "utilisée pour reconnaître une ligne déjà importée. Si ce fichier a déjà été importé " +
  "avant cette mise à jour, ses lignes seront importées une seconde fois : les doublons " +
  "sont à supprimer à la main. Le ré-import suivant du même fichier, lui, ne créera plus " +
  "de doublon.";

/**
 * The `accept=".csv,text/csv"`, enforced rather than merely declared.
 *
 * The `accept` attribute is a *filter hint* on the file dialog and nothing
 * more: the user can switch the dialog to "all files", and a drag-and-drop
 * never consults it at all. So the constraint is checked here too, and a
 * non-matching selection is refused before any request is issued — which is
 * the difference between a wasted 1 MiB upload answered by a 400 and an
 * immediate, local sentence.
 *
 * Matched on the extension **or** the media type, not on both: a CSV exported
 * on Windows frequently arrives as `application/vnd.ms-excel`, and some
 * browsers report an empty `type` for a file dragged from an archive. Refusing
 * a genuine `.csv` because the OS guessed its media type badly would be the
 * worse error of the two.
 */
export const IMPORT_NOT_A_CSV_NOTICE =
  "Ce fichier n'est pas un CSV : l'import n'accepte ici que des fichiers .csv.";

/**
 * The catalogue package's own refusal. A separate sentence rather than a
 * parameterised one: the two say different things (« ce n'est pas un CSV » and
 * « ce n'est pas un JSON ») and a template would have produced a sentence that
 * reads as neither.
 */
export const IMPORT_NOT_A_JSON_NOTICE =
  "Ce fichier n'est pas un JSON : le catalogue Kerdial s'exporte et s'importe en .json.";

const CSV_MEDIA_TYPES: ReadonlySet<string> = new Set(["text/csv", "application/csv"]);
const JSON_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/json", "text/json"]);

export function isCsvFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".csv") || CSV_MEDIA_TYPES.has(file.type.toLowerCase());
}

export function isJsonFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".json") || JSON_MEDIA_TYPES.has(file.type.toLowerCase());
}

/**
 * The `accept` hint and the local check, per file type — the catalogue is the
 * one package this screen takes that is not a CSV.
 *
 * Both halves are keyed off the same record so the dialog's filter and the
 * enforced rule cannot disagree; the header of {@link IMPORT_NOT_A_CSV_NOTICE}
 * above records why the enforced half exists at all (the attribute is a hint,
 * and a drag-and-drop never consults it).
 */
export const IMPORT_FILE_ACCEPT: Readonly<Record<ImportFileTypeName, string>> = {
  ASSETS: ".csv,text/csv",
  CASH_ACCOUNT_TRANSACTIONS: ".csv,text/csv",
  INVESTMENT_ACCOUNT_TRANSACTIONS: ".csv,text/csv",
  KERDIAL_TRANSACTIONS: ".csv,text/csv",
  KERDIAL_CATALOGUE: ".json,application/json",
};

export function isAcceptableImportFile(fileType: ImportFileTypeName, file: File): boolean {
  return fileType === "KERDIAL_CATALOGUE" ? isJsonFile(file) : isCsvFile(file);
}

export function importFileRefusalNotice(fileType: ImportFileTypeName): string {
  return fileType === "KERDIAL_CATALOGUE" ? IMPORT_NOT_A_JSON_NOTICE : IMPORT_NOT_A_CSV_NOTICE;
}

/**
 * The stated limitation, said out loud rather than silently emptying the
 * screen. The selected `File` cannot live in the URL, so it lives in component
 * state; a refresh at the revue or résultat step loses it. This is precisely
 * why OD-11(a) chose a route over a modal — a modal loses it on *any*
 * navigation, not only a refresh.
 */
export const IMPORT_FILE_LOST_ON_REFRESH_NOTICE =
  "Le fichier sélectionné n'est pas conservé lors d'un rafraîchissement de la page : " +
  "resélectionnez-le pour reprendre. Rien n'a été écrit — une analyse n'écrit jamais.";

/**
 * The row's own content, rendered as one short French line under its reason.
 *
 * A reason code plus a line number was not enough to act on: « ligne 95 — ce
 * type de ligne n'est pas géré » does not say which holding, and the file has
 * hundreds of rows. This makes the row findable in the user's own export.
 *
 * The server sends {@link ImportRowSourceResponse} **structured** — it cannot
 * format French (the neutral pipeline is barred from knowing any format's
 * vocabulary, and the `import-vocabulary-gate` enforces it), so the rendering
 * is here.
 *
 * Returns `null` rather than an empty string when there is nothing to say, so a
 * caller renders no element at all rather than an empty one. A row rejected at
 * `parse` has no `source` at all — producing no neutral row is exactly what
 * went wrong — and its own message already names the offending cell.
 */
const DIRECTION_LABELS: Readonly<
  Record<NonNullable<ImportRowSourceResponse["direction"]>, string>
> = {
  IN: "entrée",
  OUT: "sortie",
  ACQUIRE: "achat",
  DISPOSE: "vente",
};

/**
 * The three shapes only a Kerdial transactions file produces, named on the line rather than left
 * to be inferred.
 *
 * **Only three of the eight are here, and the omission is the decision.** For
 * the five older shapes the direction label already says what the row is — an
 * « achat » line reads as a trade — and adding a second word would change
 * every existing row's rendering to say what it already said. These three are
 * the ones the older fields describe *wrongly*: a `SETTLED_TRADE` carries
 * `ACQUIRE` and would read as an ordinary cash-settled purchase, a `DRIP`
 * carries `ACQUIRE` too, and a `CURRENCY_EXCHANGE` carries no direction at all
 * and would render as a bare date-and-amount. The wire contract's own note
 * makes the same point: describing one of these as one of the other five would
 * be a false statement about the user's file.
 */
const SHAPE_LABELS: Partial<Readonly<Record<ImportRowSourceResponse["shape"], string>>> = {
  CURRENCY_EXCHANGE: "change",
  SETTLED_TRADE: "achat réglé en titres",
  DRIP: "dividende réinvesti",
  // `cash-interest`: no direction and no instrument, so without a label
  // the row would render as a bare date and amount — indistinguishable from a
  // deposit.
  INTEREST: "intérêts",
  // `portfolio-cash`: no direction either, so without a label a fee would
  // render as a bare date and amount — indistinguishable from a withdrawal.
  FEE: "frais de portefeuille",
};

export function formatImportRowSource(
  source: ImportRowSourceResponse | null | undefined,
): string | null {
  // `== null` on purpose, covering `undefined` as well as `null`: this is wire
  // data, and the field is absent — not null — from any response built before
  // it existed. A `=== null` guard here dereferenced `undefined` and took the
  // whole wizard step down with it, which is how this was found.
  if (source == null) return null;

  const parts: string[] = [];
  if (source.tradeDate !== null) parts.push(formatIsoDateFr(source.tradeDate));
  // `security-transfer`: a transfer's bare direction would read « sortie » —
  // the word a cash withdrawal gets — so it is named by the ledger kind it
  // plans as, through the one label table.
  const shapeLabel =
    source.shape === "TRANSFER"
      ? transactionKindLabel(
          source.direction === "IN" ? "TRANSFER_IN" : "TRANSFER_OUT",
        ).toLowerCase()
      : SHAPE_LABELS[source.shape];
  if (shapeLabel !== undefined) parts.push(shapeLabel);
  else if (source.direction !== null) parts.push(DIRECTION_LABELS[source.direction]);
  if (source.instrument !== null) parts.push(source.instrument);

  // A trade row carries the share count (its money leg is derived) and every
  // other shape carries the money — **except a cashless distribution, which
  // carries both**, because neither figure identifies that row on its own. So
  // the two are rendered independently rather than as an either/or; for every
  // other shape exactly one of them is present, so the line each produces is
  // unchanged.
  //
  // Both are rendered raw rather than through `<Figure>`: this is a diagnostic
  // echo of what the file said, not a figure the app computed, and running it
  // through the monetary renderer would dress an unimported value up as ledger
  // data.
  if (source.quantity !== null) {
    parts.push(`${source.quantity} titre${source.quantity === "1" ? "" : "s"}`);
  }
  if (source.amount !== null) {
    parts.push(source.currency === null ? source.amount : `${source.amount} ${source.currency}`);
  } else if (
    source.quantity === null &&
    source.shape === "INSTRUMENT" &&
    source.currency !== null
  ) {
    parts.push(source.currency);
  }

  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The cross-file skip (OD-1), stated once instead of once per row.
 *
 * On a typical cash-account file this is most of its rows, every one of them
 * saying the same thing. Listing them individually buried the single row
 * that did need attention under hundreds of identical entries, so the server stops
 * sending them and this sentence carries the total instead. The count is the
 * exact one from `summary.byReason` — nothing is estimated or rounded here.
 */
export function coveredByInvestmentFileNotice(count: number): string {
  return (
    `${String(count)} ligne${count > 1 ? "s" : ""} de ce fichier espèces ` +
    `${count > 1 ? "correspondent" : "correspond"} à des opérations déjà portées par le fichier ` +
    `du compte-titres, qui fait foi : ${count > 1 ? "elles ont été ignorées" : "elle a été ignorée"} ` +
    `pour ne pas les compter deux fois. ${count > 1 ? "Elles ne sont pas listées" : "Elle n'est pas listée"} ` +
    `ligne à ligne — il n'y a rien à corriger.`
  );
}

/**
 * The catalogue dry run's statement of what the import does to
 * the shared instrument catalogue: matched rows are rewritten "file wins", and
 * a corrected provider mapping discards the instrument's automated price
 * history. `null` when nothing shared changes.
 */
export function sharedCatalogueImpactNotice(impact: {
  readonly instrumentsModified: number;
  readonly priceHistoriesDiscarded: number;
}): string | null {
  const { instrumentsModified: modified, priceHistoriesDiscarded: discarded } = impact;
  if (modified === 0) return null;
  const head =
    `${String(modified)} instrument${modified > 1 ? "s" : ""} du catalogue partagé ` +
    `${modified > 1 ? "seront modifiés" : "sera modifié"} par cet import`;
  if (discarded === 0) return `${head}.`;
  return (
    `${head}, dont ${String(discarded)} ` +
    `${discarded > 1 ? "perdront leur" : "perdra son"} historique de cours ` +
    `(changement de symbole de cotation).`
  );
}
