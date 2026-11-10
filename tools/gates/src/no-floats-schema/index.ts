import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No-floats gate, schema half.
 *
 * NFR-12/AC53 require exact-decimal storage everywhere. This script greps
 * generated SQL (Drizzle migrations, once T-5/T-6/T-7 generate them) for
 * float-ish type names and fails if any are found. The application-code
 * half (an ESLint rule banning `Number()`/`parseFloat()`/`+x`/`Math.*` on
 * the branded `Decimal` type) is built in T-4.
 */
const BANNED_TYPES = ["double precision", "float8", "float4", "float", "real", "money"] as const;

export interface FloatViolation {
  readonly file: string;
  readonly line: number;
  readonly type: string;
  readonly text: string;
}

function bannedTypePattern(type: string): RegExp {
  return new RegExp(`\\b${type.replace(/\s+/g, "\\s+")}\\b`, "i");
}

/**
 * Masks the contents of every single-quoted SQL string literal (handling the
 * `''`-escaped-quote form) with an equal-length run of a neutral character,
 * so a column *type* keyword is never confused with the same word appearing
 * inside string *data* — e.g. a seeded currency name like `'Brazilian Real'`
 * (the ISO 4217 seed data, T-5) must never trip the
 * `real` column-type ban. Length is preserved (not collapsed) so this can't
 * itself accidentally create a new banned-type match by concatenation.
 */
function maskStringLiterals(line: string): string {
  return line.replace(/'(?:[^']|'')*'/g, (match) => "#".repeat(match.length));
}

/** Scans a single SQL file's contents (comments and string literals stripped) for banned type names. */
export function scanSqlForFloats(sql: string, fileLabel = "<inline>"): FloatViolation[] {
  const violations: FloatViolation[] = [];
  const lines = sql.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const withoutStringLiterals = maskStringLiterals(rawLine);
    const withoutLineComment = withoutStringLiterals.replace(/--.*$/, "");
    for (const type of BANNED_TYPES) {
      if (bannedTypePattern(type).test(withoutLineComment)) {
        violations.push({
          file: fileLabel,
          line: index + 1,
          type,
          text: rawLine.trim(),
        });
      }
    }
  });

  return violations;
}

function listSqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listSqlFiles(full));
    } else if (entry.endsWith(".sql")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Scans every `*.sql` file under `dir` (recursively). A missing directory
 * (e.g. before T-5/T-6/T-7 generate any migrations) is not an error — it is
 * treated as zero SQL files, hence zero violations.
 */
export function scanDirectoryForFloats(dir: string): FloatViolation[] {
  const violations: FloatViolation[] = [];
  for (const file of listSqlFiles(dir)) {
    violations.push(...scanSqlForFloats(readFileSync(file, "utf8"), file));
  }
  return violations;
}

export function formatViolations(violations: readonly FloatViolation[]): string {
  return violations
    .map((v) => `  - ${v.file}:${v.line}: banned type "${v.type}" — ${v.text}`)
    .join("\n");
}
