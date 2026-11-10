import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Import-vocabulary containment gate — csv-import IMP-3, risk RC7.
 *
 * OD-6(a) requires the Portfolio Performance parsing logic to sit behind a
 * format-neutral importer interface "so that additional formats can be added
 * later". An interface makes that claim; only a scan can check it. This gate
 * fails if any of the eleven format literals appears outside the one directory
 * allowed to contain them.
 *
 * ## Three anti-vacuity properties, each answering a recorded incident here
 *
 * **1. It strips nothing — not comments, not strings, not anything.** The
 * acceptance criterion forbids stripping line comments with a bare
 * `/\/\/.*$/`, because that pattern matches the `//` inside `https://` and
 * discards the rest of the line; three gates in this repository were blind to
 * every line containing a URL, and appending
 * `const DOC = "https://…"; <real violation>` to a scanned file left one of
 * them green. The strongest available answer to "do not strip comments wrongly"
 * is not to strip at all, so this gate scans raw file text: a literal inside a
 * `//` comment, inside a block comment, or after a URL on the same line is a
 * hit exactly like one in code. The fixtures prove all three, including the
 * URL-then-violation line the criterion names by shape.
 *
 * (The cost of this choice is real and is accepted: a scanned file cannot
 * *mention* a format label even in prose. `src/pipeline/plan.ts`'s own header
 * says so, so a future author is told before they hit the gate.)
 *
 * **2. It asserts a positive floor, not only an absence.** "Zero violations" is
 * indistinguishable from "this scan reached no files", which is this
 * repository's recorded twelve-time failure. {@link scanForFormatVocabulary}
 * therefore reports `filesScanned` and `literalsFound` alongside `hits`, and
 * the CLI fails unless the scan reached at least
 * {@link MIN_CONTAINMENT_FILES} files **and** an independent scan of the format
 * directory found **all eleven** literals — which it does by construction,
 * since six of them are that module's `Type`-label table and five are its
 * header tables.
 *
 * **3. A match is bounded, so the gate cannot be dodged by concatenation and
 * cannot fire on an unrelated English identifier.** A literal counts only when
 * the characters immediately around it are not letters, digits or underscores.
 * `formatToParts` (a real `Intl` call in `locale.ts`) is therefore not a hit,
 * while `"Parts"`, `Parts;` and `[Parts]` all are. The tests pin both
 * directions; without the negative one the boundary rule could be widened to
 * uselessness and nothing would notice.
 *
 * ## Two literal sets since `portfolio-export-import`
 *
 * There are now two import formats, so there are two scans of each kind:
 * {@link IMPORT_FORMAT_LITERALS} over the Portfolio-Performance module, and
 * {@link KERDIAL_FORMAT_LITERALS} over the Kerdial transactions CSV module. The
 * containment targets are the same for both — the neutral layer must carry
 * neither format's vocabulary — and each set gets its **own** positive floor,
 * because a single scan over the union could report "no hits" without saying
 * which of the two formats is actually contained.
 *
 * ## Scope
 *
 * The caller passes the targets; they are fixed as `importer/src/types.ts` and
 * `importer/src/pipeline/**`. Deliberately **not** scanned:
 * `importer/src/formats/portfolio-performance/**` (the one module allowed to
 * know the format), `importer/src/__fixtures__/**` (the corpus *is* the
 * vocabulary) and `importer/src/fixture-integrity.test.ts` (it asserts the
 * fixture's French type counts by name, and must keep doing so — a containment
 * gate that forces an existing assertion to derive its expected value from the
 * table under test replaces a real check with a tautology, which is how a prior
 * cycle in this repo produced eight assertions that stayed green while two map
 * entries were swapped).
 */

/**
 * The eleven original literals — six `Type` labels and five column
 * headers — plus the two transfer labels `security-transfer` adds and the
 * interest label `cash-interest` adds, fourteen in
 * all. Written here, in the gate, and nowhere else outside the format module:
 * this file is not scanned by itself. `Intérêts` is the NFC spelling (one
 * precomposed codepoint per accent), the same bytes the format module's table
 * holds; `Intérêts débiteurs` needs no entry of its own, since the boundary
 * rule already makes it a hit on `Intérêts`. `Frais` is a column header and,
 * since `portfolio-cash`, a `Type` label too: its one entry
 * already guards both, so it is not listed twice.
 */
export const IMPORT_FORMAT_LITERALS = [
  "Achat",
  "Vente",
  "Dépôt",
  "Retrait",
  "Dividendes",
  "Distribution (Entrante)",
  "Transfert (Sortant)",
  "Transfert (Entrant)",
  "Intérêts",
  "Valeur",
  "Parts",
  "Frais",
  "Impôts / Taxes",
  "Symbole boursier",
] as const;

/**
 * The six original `portfolio-export-import` literals — the Kerdial
 * transactions CSV's own unambiguous tokens — plus the one `security-transfer`
 * adds, `transfer_of`, less `withholding_cash_account`, which format v2 retired
 * with its column: six in all. Written here, in the
 * gate, and nowhere else outside its format module.
 *
 * `transfer_of` is the one token this gate names for the transfer columns: one
 * snake_case token per format feature, as `drip_of` is for the reinvestment
 * link, rather than every column of the feature.
 *
 * **Why exactly these six, and why the obvious candidates are missing.**
 *
 *  - The CSV's *generic* column names — `type`, `currency`, `quantity`,
 *    `symbol`, `note` — are **deliberately excluded**. They occur legitimately
 *    all over `pipeline/**` as identifiers and prose, so adding them would make
 *    the gate fire on correct code, and the repair pressure would be to weaken
 *    the boundary rule — which is how a gate becomes useless.
 *  - `import_fingerprint` is **deliberately excluded** as well: it occurs
 *    inside `"transaction_import_fingerprint_key"` in `pipeline/apply.ts`, and
 *    although the boundary rule would not match there (both neighbours are
 *    `_`), depending on that is a trap one refactor away.
 *
 * What makes a safe subset available at all is the boundary rule itself: `_` is
 * a word character, so a `snake_case` token matches only as a whole token, and
 * this codebase is camelCase.
 */
export const KERDIAL_FORMAT_LITERALS = [
  "kerdial-transactions",
  "cash_account_currency",
  "target_cash_account",
  "settlement_symbol",
  "drip_of",
  "transfer_of",
] as const;

/** How many files the containment scan must reach before "no hits" means anything. */
export const MIN_CONTAINMENT_FILES = 3;

/** How many files the positive-floor scan of the format module must reach. */
export const MIN_FORMAT_FILES = 4;

/**
 * How many files the Kerdial positive-floor scan must reach. Its module is
 * `lexer.ts`, `columns.ts`, `index.ts` and `serialize.ts` plus their tests, so
 * four is the same "the module is still there" floor {@link MIN_FORMAT_FILES}
 * is, sized against the module's own non-test file count.
 */
export const MIN_KERDIAL_FORMAT_FILES = 4;

export interface VocabularyHit {
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in characters. */
  readonly column: number;
  readonly literal: string;
  /** The whole source line, trimmed — so a reviewer can see the context the gate saw. */
  readonly excerpt: string;
}

export interface VocabularyScan {
  readonly filesScanned: readonly string[];
  readonly hits: readonly VocabularyHit[];
  /** Which of the scanned literal set occurred at least once, in table order. */
  readonly literalsFound: readonly string[];
}

/** Letters, digits and `_` — the neighbours that make an occurrence part of a longer word instead of a literal. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** TypeScript sources only; the fixture CSVs are data and are not scanned. */
const SCANNED_EXTENSIONS = [".ts", ".tsx"] as const;

function listTypeScriptFiles(target: string): string[] {
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    return SCANNED_EXTENSIONS.some((extension) => target.endsWith(extension)) ? [target] : [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(target).sort()) {
    files.push(...listTypeScriptFiles(join(target, entry)));
  }
  return files;
}

/**
 * Scan every `.ts`/`.tsx` file under `targets` (files or directories) for
 * `literals`, reporting what was found **and what was looked at**.
 *
 * The literal set is a parameter, defaulting to the Portfolio-Performance
 * eleven, because there are now two formats and each one's containment is its
 * own claim: one scan reporting "no hits" over a union of both sets could not
 * say *which* format's vocabulary is contained.
 *
 * Every target must exist: a mistyped or moved path is an error, never an empty
 * scan reported as a pass.
 */
export function scanForFormatVocabulary(
  targets: readonly string[],
  literals: readonly string[] = IMPORT_FORMAT_LITERALS,
): VocabularyScan {
  const filesScanned: string[] = [];
  for (const target of targets) {
    // `statSync` throws ENOENT on a missing path, which is the intended
    // behaviour: a gate that silently scans nothing is the thing this file is
    // about.
    filesScanned.push(...listTypeScriptFiles(target));
  }

  const hits: VocabularyHit[] = [];
  const found = new Set<string>();

  for (const file of filesScanned) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      for (const literal of literals) {
        for (const column of boundedOccurrences(text, literal)) {
          found.add(literal);
          hits.push({
            file,
            line: index + 1,
            column: column + 1,
            literal,
            excerpt: text.trim(),
          });
        }
      }
    });
  }

  return {
    filesScanned,
    hits,
    literalsFound: literals.filter((literal) => found.has(literal)),
  };
}

/** Every 0-based index at which `literal` occurs in `text` with a non-word character on each side. */
function boundedOccurrences(text: string, literal: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(literal, from);
    if (at === -1) return positions;
    from = at + 1;
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + literal.length] ?? "";
    if (WORD_CHARACTER.test(before) || WORD_CHARACTER.test(after)) continue;
    positions.push(at);
  }
}

export function formatHits(hits: readonly VocabularyHit[]): string {
  return hits
    .map((hit) => `  - ${hit.file}:${hit.line}:${hit.column} "${hit.literal}" in: ${hit.excerpt}`)
    .join("\n");
}
