import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `ci-release` CR-6 (L10, FR-492/AC-420) — the extraction contract
 * `release.yml` depends on, exercised through the CLI rather than an exported
 * function, because the release workflow runs it as a process and it is the
 * **exit code** that decides whether a release is created.
 *
 * Four behaviours, each one a way the release notes can go wrong:
 *
 * 1. **Section present** — the body is emitted verbatim, heading excluded, up
 *    to the next `## v…` heading. This is L10's "hand-written section above the
 *    generated list".
 * 2. **Section absent** — empty stdout, exit **0**. Not a failure: FR-492 only
 *    promises the section "when the version has a corresponding section", and a
 *    release whose notes are purely generated is a normal release. An exit 1
 *    here would block the release workflow's last step over nothing.
 * 3. **Prerelease vs release discrimination, both directions** — `0.2.0` must
 *    **not** match `## v0.2.0-rc.1`, and `0.2.0-rc.1` must match its own
 *    heading. A naive `^##\s+v0\.2\.0\b` matches `## v0.2.0-rc.1` (`\b` sits
 *    happily between `0` and `-`), so a release candidate's notes would be
 *    published as the final release's — silently, and only visible after the
 *    Release exists.
 * 4. **Two headings for one version** — exit **2** with the version named. A
 *    file with two `## v0.1.0` headings has no single answer to "what is this
 *    version's section", and guessing the first one would publish half the
 *    notes without a word.
 *
 * The default-file case is here too: it is the proof that the `## v0.2.0`
 * heading in `docs/release-notes.md` actually makes the first public
 * release's section extractable, which no fixture can show.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "release-notes-section.ts");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(tsx, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function fixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  const file = join(dir, "release-notes.md");
  writeFileSync(file, contents, "utf8");
  return file;
}

const twoSections = `# Release notes

Intro prose.

---

## v0.2.0 — 2026-10-01

Second release's note.

### A sub-heading stays inside the span

More prose.

## v0.1.0 — unreleased

First release's note.

## Not a version heading, and therefore not a boundary

Still inside v0.1.0.
`;

describe("release-notes-section", () => {
  it("prints the section body verbatim, heading excluded, up to the next version heading", () => {
    const file = fixture(twoSections);
    const result = run(["0.2.0", "--file", file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Second release's note.\n\n### A sub-heading stays inside the span\n\nMore prose.\n",
    );
  });

  it("runs the last section to EOF and does not stop at a non-version `##` heading", () => {
    const file = fixture(twoSections);
    const result = run(["0.1.0", "--file", file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "First release's note.\n\n## Not a version heading, and therefore not a boundary\n\nStill inside v0.1.0.\n",
    );
  });

  it("exits 0 with empty stdout when the version has no section", () => {
    const file = fixture(twoSections);
    const result = run(["9.9.9", "--file", file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not let a release version match its own prerelease heading", () => {
    const file = fixture(`# Release notes

---

## v0.2.0-rc.1 — 2026-10-01

Candidate notes, not the release's.
`);

    expect(run(["0.2.0", "--file", file])).toMatchObject({ status: 0, stdout: "" });
    expect(run(["0.2.0-rc.1", "--file", file])).toMatchObject({
      status: 0,
      stdout: "Candidate notes, not the release's.\n",
    });
  });

  it("exits 2 and names the version when one version has two headings", () => {
    const file = fixture(`# Release notes

---

## v0.1.0 — unreleased

One.

## v0.1.0 — also unreleased

Two.
`);
    const result = run(["0.1.0", "--file", file]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("0.1.0");
  });

  it("reads docs/release-notes.md by default and finds the v0.2.0 section, breaking change first", () => {
    const result = run(["0.2.0"]);

    expect(result.status).toBe(0);
    expect(result.stdout.startsWith("### Breaking: upgrading from 0.1.x\n")).toBe(true);
    expect(result.stdout).toContain("### First public release");
  });
});

// =====================================================================
// CR-10 (GATE, tester-authored) — edge cases beyond CR-6's own six:
// regex-metacharacter version strings, a
// file with no version heading at all, a heading with trailing free text,
// CRLF line endings, and invalid version arguments.
// =====================================================================
describe("release-notes-section — CR-10 edge cases", () => {
  it("a version that is a prefix of another version's heading does not match it (1.0.0-rc.1 vs ## v1.0.0-rc.10)", () => {
    // The escaped-regex + negative-lookahead contract
    // (`(?![\w.\-])`) is exactly what stops `rc.1` matching inside `rc.10` —
    // a naive `\b`-bounded match would not catch this because `\b` sits
    // between a digit and nothing at the string's own end, but a *substring*
    // match (no anchoring at all) would wrongly hit here. This pins the
    // stricter contract, not just the simpler rc.1-vs-0.2.0 case CR-6 covers.
    const file = fixture(`# Release notes

---

## v1.0.0-rc.10 — 2026-10-01

The tenth candidate's notes.
`);
    const forRc1 = run(["1.0.0-rc.1", "--file", file]);
    expect(forRc1.status).toBe(0);
    expect(forRc1.stdout).toBe("");

    const forRc10 = run(["1.0.0-rc.10", "--file", file]);
    expect(forRc10.status).toBe(0);
    expect(forRc10.stdout).toBe("The tenth candidate's notes.\n");
  });

  it("a file with only the intro and no ## v heading at all exits 0 with empty output", () => {
    const file = fixture(`# Release notes

User-facing behaviour changes that need a decision, a warning, or a manual step.

---

## Not a version heading — a plain feature section, the pre-CR-6 shape

Some prose that predates any \`## v\` heading existing in the file at all.
`);
    const result = run(["0.1.0", "--file", file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("a heading with extra free text after the date is still a valid boundary", () => {
    const file = fixture(`# Release notes

---

## v0.3.0 — 2026-10-01 (delayed one day for a hotfix)

Section content survives the extra trailing text on its own heading.

## v0.2.0 — 2026-09-20

Older section.
`);
    const result = run(["0.3.0", "--file", file]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Section content survives the extra trailing text on its own heading.\n",
    );
  });

  it("CRLF line endings: the section is still extracted and the CR is not left dangling in the body", () => {
    const crlf = [
      "# Release notes",
      "",
      "---",
      "",
      "## v0.4.0 — 2026-11-01",
      "",
      "CRLF body line one.",
      "CRLF body line two.",
      "",
      "## v0.3.0 — 2026-10-01",
      "",
      "Older, also CRLF.",
      "",
    ].join("\r\n");
    const file = fixture(crlf);
    const result = run(["0.4.0", "--file", file]);

    expect(result.status).toBe(0);
    // The script splits on /\r?\n/, so the body must be plain LF-joined, with
    // no trailing \r glued onto the last content line.
    expect(result.stdout).toBe("CRLF body line one.\nCRLF body line two.\n");
    expect(result.stdout).not.toContain("\r");
  });

  it("an invalid version argument with a leading v is rejected with a non-zero exit and a message", () => {
    const file = fixture("# Release notes\n\n---\n\n## v0.1.0 — unreleased\n\nBody.\n");
    const result = run(["v0.1.0", "--file", file]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("v0.1.0");
    expect(result.stderr.toLowerCase()).toContain("semver");
  });

  it("an invalid, incomplete version argument (missing the patch component) is rejected with a non-zero exit", () => {
    const file = fixture("# Release notes\n\n---\n\n## v0.1.0 — unreleased\n\nBody.\n");
    const result = run(["0.1", "--file", file]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("0.1");
  });
});
