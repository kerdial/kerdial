import { resolve } from "node:path";
import {
  checkDocSections,
  checkDuplicateHeadings,
  formatViolations,
  readMarkdownFiles,
} from "./index.js";

/**
 * Takes one or more directories (default `docs`). `docs/*.md` is numbered
 * `## N.` and cited by number. Each rule is a no-op where its precondition does
 * not hold, so both run over every directory given: the numbering check ignores
 * a document with no numbered headings, and the duplicate check ignores one
 * with no repeated heading.
 *
 * Non-recursive per directory — the directories are flat and naming them is
 * what makes the scope reviewable.
 */
const docsDirs = (process.argv.length > 2 ? process.argv.slice(2) : ["docs"]).map((dir) =>
  resolve(dir),
);
const files = docsDirs.flatMap((dir) => readMarkdownFiles(dir));
const violations = [...checkDocSections(files), ...checkDuplicateHeadings(files)];

if (violations.length > 0) {
  console.error(
    `doc-sections-gate: ${violations.length} problem(s) in ${docsDirs.join(", ")}:\n${formatViolations(violations)}\n\nNumbered sections are cited by number. A clean merge renumbered this runbook once already, and a merge *resolution* left two copies of one heading in an append-only file.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `doc-sections-gate: ${files.length} file(s) in ${docsDirs.join(", ")} — section numbering contiguous, every §N reference resolves, no heading duplicated within a file.`,
  );
}
