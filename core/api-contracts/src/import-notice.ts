/**
 * The two import behaviours the UI has to state out loud, because in both
 * cases the user's natural expectation is the opposite of what the system does
 * (CI-14).
 *
 * They live here, in `core/api-contracts`, for the reason
 * `instrument-catalogue-notice.ts`'s header already records: `web` may import
 * `core/*` and nothing else (`.dependency-cruiser.cjs`'s
 * `web-no-server-runtime-imports`), and the behaviour these sentences describe
 * is decided in `platform/db`'s schema and `importer`'s apply loop — neither of
 * which `web` can read. Naming the strings here is what stops Batch E (CI-22)
 * inventing its own wording for a rule it cannot see.
 *
 * Deliberately framework-free (no `zod` import), like every other constant
 * module in this package.
 */

/**
 * An imported transaction keeps its `import_fingerprint` when it is
 * edited, so re-importing the original file **skips** the edited row rather
 * than restoring it. The decision, and the reason it is stated rather than
 * silently accepted, are recorded on `transaction.importFingerprint` itself.
 *
 * **The third sentence comes from `portfolio-export-import`**, and it is a
 * clause on this same rendered sentence rather than a notice of its own: the
 * Kerdial export carries `import_fingerprint` verbatim, so a restored row
 * arrives already attached to the source line it came from — including in an
 * installation that never imported that source file. The skip rule therefore
 * applies to restored rows too, which is the one thing a user could not have
 * guessed from the first two sentences.
 *
 * French, present tense, no exclamation — the surrounding wizard copy's
 * register.
 */
export const IMPORT_EDITED_ROW_NOTICE =
  "Une transaction importée puis modifiée reste rattachée à sa ligne d'origine : " +
  "réimporter le même fichier ne la restaure pas, la ligne est ignorée. " +
  "Pour repartir de la valeur du fichier, supprimez la transaction puis réimportez. " +
  "Ce rattachement est conservé par l'export : une transaction restaurée depuis une sauvegarde " +
  "reste rattachée à sa ligne d'origine, même si ce fichier n'a jamais été importé ici.";

/**
 * A hand-entered transaction carries no fingerprint at all,
 * so it can neither block an import nor be recognised by one — importing a file
 * that contains the same trade will write a second row.
 */
export const IMPORT_MANUAL_ROW_NOTICE =
  "Une transaction saisie à la main n'est jamais reconnue par un import : " +
  "si le fichier contient la même opération, elle sera ajoutée une seconde fois.";
