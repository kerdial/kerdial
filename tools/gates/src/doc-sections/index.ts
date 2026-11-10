import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * **Numbered sections in `docs/*.md` are load-bearing, and a clean merge can
 * renumber them silently.**
 *
 * `chore/retire-backup-pipeline` replaced the runbook's §11 and §12 with a
 * single new §11. A branch open at the same time had appended a new section to
 * the end of the same file. One side edited the middle, the other appended —
 * no overlapping hunks, so **git reported no conflict** and produced a runbook
 * whose §11 was followed by §13. A cross-reference then pointed at that §13, a
 * number that existed only because of the collision.
 *
 * A textual conflict is a question git knows to ask. This class is silent:
 * nothing failed, nothing was red, and the only signal was a human counting.
 * This gate is that count, run mechanically.
 *
 * **Numbering spans heading levels.** `deploy-runbook.md` numbers `## 0.` and
 * `## 1.` at depth 2, then `### 2.` … `### 10.` at depth 3, then `## 11.` at
 * depth 2 again. The sequence is the document's, not any one level's, so
 * headings are collected in file order across `##` and `###` alike — a check
 * scoped to one level would have missed the very renumber that prompted this.
 *
 * What the gate buys is that an accidental renumber becomes visible *in the
 * commit that causes it*, which is the cheapest moment to correct anything that
 * cites a section by number.
 */
export interface SectionViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: "NON_CONTIGUOUS" | "DANGLING_REFERENCE" | "DUPLICATE_HEADING";
  readonly detail: string;
}

interface NumberedHeading {
  readonly number: number;
  readonly line: number;
  readonly text: string;
}

/**
 * Duplicate headings — **and the verdict on them, the part worth reading.**
 *
 * This gate scanned `docs/*.md` only. While it was being written, its
 * own scenario recurred in this repo's own append-only engineering log (since
 * retired): two branches appended entries before the same anchor, and
 * resolving the rebase revealed that the other branch had also promoted that
 * anchor from `### Considered and not recorded (project)` to `## `. A naive
 * resolution left **two copies of the heading**, caught only by a human
 * reading the merged file.
 *
 * **Decided: worth a check, and here is why git's own signal is not enough.**
 * The numbering check's argument was that "a textual conflict is a question
 * git knows to ask; this class is silent". That recurrence was sharper still:
 * git *did* raise a conflict, and the duplicate was introduced **by the
 * resolution**. So the two events are different — the conflict is a question,
 * the bad resolution is a silent answer to it — and only the second is what
 * this check sees. An append-only file edited by concurrent sessions is exactly
 * where that happens.
 *
 * **It is a different rule, not a wider glob.** An append-only log is not
 * numbered `## N.`, so the contiguity half is a no-op there; what applies is
 * duplicate heading *text*. Both rules run over every document given, and each
 * is a no-op where its precondition does not hold — a document with no numbered
 * headings is out of scope for one, a document with no repeated heading is out
 * of scope for the other.
 */
/** Any heading, at any of the depths the duplicate rule considers. */
const ANY_HEADING = /^(#{2,4})\s+(.*)$/;

/** `## 3. Title` / `### 3. Title` — the number, wherever the document puts it. */
const NUMBERED_HEADING = /^(#{2,3})\s+(\d+)\.\s+(.*)$/;
/** A `§12` or `§2.4` citation. Only the leading integer indexes a section here. */
const SECTION_REFERENCE = /§(\d+)(?:\.\d+)*/g;

export function readMarkdownFiles(dir: string): { file: string; content: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({
      file: entry.name,
      content: readFileSync(join(dir, entry.name), "utf8"),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function numberedHeadings(content: string): NumberedHeading[] {
  const headings: NumberedHeading[] = [];
  content.split("\n").forEach((raw, index) => {
    const match = NUMBERED_HEADING.exec(raw);
    if (match?.[2] !== undefined) {
      headings.push({ number: Number(match[2]), line: index + 1, text: match[3] ?? "" });
    }
  });
  return headings;
}

export function checkDocSections(files: { file: string; content: string }[]): SectionViolation[] {
  const violations: SectionViolation[] = [];

  for (const { file, content } of files) {
    const headings = numberedHeadings(content);
    // A document with no numbered headings is not in scope; one with a single
    // heading is trivially contiguous. Neither is a finding.
    for (let i = 1; i < headings.length; i += 1) {
      const previous = headings[i - 1]!;
      const current = headings[i]!;
      if (current.number !== previous.number + 1) {
        violations.push({
          file,
          line: current.line,
          kind: "NON_CONTIGUOUS",
          detail: `section ${current.number} ("${current.text}") follows section ${previous.number} — expected ${previous.number + 1}. A renumber like this can arrive from a clean merge with no conflict.`,
        });
      }
    }

    // A `§N` reference is NOT checked here: which document it means cannot be
    // decided from this file alone. Second pass, below.
  }

  // Resolving a `§N` to the document it means.
  //
  // Two forms occur here and both are load-bearing: the explicit
  // `deploy-runbook.md §11`, and the prose `runbook §11` — which is the form
  // the runbook's own readers actually use. A `§N` with neither is a reference
  // to its own document.
  //
  // The prose aliases are **derived from the filenames**, never listed: each
  // document contributes the words of its own basename, and a word is usable
  // as an alias only when it belongs to exactly one document. So
  // `deploy-runbook.md` is reachable as "runbook" but not as "deploy" —
  // `deploy-synology.md` shares that word, so it resolves nothing and those
  // lines are left alone rather than guessed at. A hand-written alias table
  // here would be another instance of the stale-copy class, and it would go stale the first time a document was renamed.
  const byFile = new Map(files.map(({ file, content }) => [file, numberedHeadings(content)]));
  const aliasOwners = new Map<string, string[]>();
  for (const { file } of files) {
    for (const word of file.replace(/\.md$/, "").split(/[-_]/)) {
      if (word.length < 3) continue;
      aliasOwners.set(word, [...(aliasOwners.get(word) ?? []), file]);
    }
  }
  const uniqueAlias = new Map(
    [...aliasOwners].flatMap(([word, owners]) => (owners.length === 1 ? [[word, owners[0]!]] : [])),
  );

  for (const { file, content } of files) {
    const ownHeadings = byFile.get(file) ?? [];
    content.split("\n").forEach((raw, index) => {
      for (const match of raw.matchAll(SECTION_REFERENCE)) {
        const referenced = Number(match[1]);
        const before = raw.slice(0, match.index);

        // Explicit filename wins; then the nearest unique alias word; else self.
        const explicit = [...before.matchAll(/([\w-]+\.md)/g)].at(-1)?.[1];
        // Only the word **immediately** before the `§`, and only when it is a
        // standalone word rather than the tail of a hyphenated compound.
        //
        // Both conditions were forced by a real line: "re-run §4" inside a
        // document that was itself §4's own document — a self-reference — was
        // resolved by a looser scan to `run-local.md` instead, because "run"
        // is that document's unique alias word and happens to also be
        // ordinary English. That reported a section that does exist as
        // dangling — a false finding, arriving inside the gate meant to prevent them.
        const trailing = /(^|[^-\w])([A-Za-z]{3,})[\s'’]*$/.exec(before);
        const aliasWord = trailing?.[2]?.toLowerCase();
        const aliasTarget = aliasWord === undefined ? undefined : uniqueAlias.get(aliasWord);
        const targetFile = explicit ?? aliasTarget ?? file;

        const target = byFile.get(targetFile);
        // A document this repo does not hold is out of reach by construction.
        // Skipped rather than reported.
        if (target === undefined || target.length === 0) continue;
        if (ownHeadings.length === 0 && targetFile === file) continue;

        if (!target.some((heading) => heading.number === referenced)) {
          const where = targetFile === file ? "this document" : targetFile;
          violations.push({
            file,
            line: index + 1,
            kind: "DANGLING_REFERENCE",
            detail: `§${referenced} does not exist in ${where} (it has ${target.map((h) => h.number).join(", ")}).`,
          });
        }
      }
    });
  }

  return violations;
}

/**
 * Repeated heading **text** within one file — at any depth, so
 * the real case is caught: the duplicate that prompted this had the same text
 * at `##` and at `###`, which a depth-scoped comparison would have missed for
 * the same reason the numbering check spans levels.
 */
export function checkDuplicateHeadings(
  files: { file: string; content: string }[],
): SectionViolation[] {
  const violations: SectionViolation[] = [];
  for (const { file, content } of files) {
    const seen = new Map<string, number>();
    content.split("\n").forEach((raw, index) => {
      const match = ANY_HEADING.exec(raw);
      if (!match) return;
      // Compared on the text alone, deliberately: promoting a heading from
      // `###` to `##` is exactly how the real duplicate was created, so a key
      // that included the depth would have treated the pair as two different
      // headings.
      const text = match[2]!.trim();
      if (text === "") return;
      const first = seen.get(text);
      if (first === undefined) {
        seen.set(text, index + 1);
        return;
      }
      violations.push({
        file,
        line: index + 1,
        kind: "DUPLICATE_HEADING",
        detail: `heading "${text}" also appears at line ${first} — an append-only file's merge resolution can leave two copies of one anchor`,
      });
    });
  }
  return violations;
}

export function formatViolations(violations: SectionViolation[]): string {
  return violations
    .map(
      (violation) =>
        `  ${violation.file}:${violation.line}  [${violation.kind}] ${violation.detail}`,
    )
    .join("\n");
}
