import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `ci-release` CR-6 — extract one version's hand-written section from
 * `docs/release-notes.md`, for `release.yml` to place **above** GitHub's
 * generated notes (L10, FR-492/AC-420).
 *
 *     tsx scripts/release-notes-section.ts <X.Y.Z[-prerelease]> [--file docs/release-notes.md]
 *
 * **Contract**: print everything from the `## v<version>` heading —
 * heading excluded — to the next `^##\s+v` heading or EOF; exit **0 with empty
 * stdout** when the version has no section; exit **2** when one version has two
 * headings.
 *
 * **Why "absent" is exit 0.** FR-492 embeds the section "when the version has a
 * corresponding section". A release with nothing hand-written is ordinary — the
 * generated list stands alone — and failing here would fail the release
 * workflow's last step, after the image is already pushed, over a file that is
 * not wrong.
 *
 * **Why "two headings" is exit 2 and not a best guess.** There is no defensible
 * answer to "which `## v0.1.0` is the section", and picking the first publishes
 * half the notes without saying so. 2 rather than 1 keeps "malformed input"
 * distinguishable from a usage error in the workflow log — the same reason the
 * gate CLIs here separate their exit codes.
 *
 * **Why the heading match is a lookahead and not `\b`.** `\b` matches between
 * `0` and `-`, so `^##\s+v0\.2\.0\b` happily matches `## v0.2.0-rc.1` and a
 * release candidate's notes would be published as the final release's. The
 * character after the version must not continue it: not a word character, not a
 * dot, not a hyphen. A space, an em dash or end-of-line all qualify, which is
 * what keeps the heading's suffix free text (`— unreleased`, `— 2026-10-01`).
 *
 * Boundaries are only `##` headings that start with `v`: a section's own `##`
 * prose heading (this file has several) stays inside the span.
 */

const USAGE =
  "usage: tsx scripts/release-notes-section.ts <X.Y.Z[-prerelease]> [--file docs/release-notes.md]";

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  console.error(`release-notes-section: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): { version: string; file: string } {
  let version: string | undefined;
  let file = "docs/release-notes.md";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--file") {
      const value = argv[i + 1];
      if (value === undefined) fail(`--file needs a path.\n${USAGE}`);
      file = value;
      i += 1;
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}.\n${USAGE}`);
    } else if (version === undefined) {
      version = arg;
    } else {
      fail(`unexpected argument ${arg}.\n${USAGE}`);
    }
  }

  if (version === undefined) fail(`no version given.\n${USAGE}`);
  // The leading `v` belongs to the git tag and to the heading, not to the
  // argument — `release.yml` passes `steps.tag.outputs.version`, which is the
  // tag with the `v` already stripped.
  if (!SEMVER.test(version)) {
    fail(`"${version}" is not a SemVer version (X.Y.Z, optional -prerelease).\n${USAGE}`);
  }
  return { version, file };
}

const { version, file } = parseArgs(process.argv.slice(2));

let contents: string;
try {
  contents = readFileSync(resolve(file), "utf8");
} catch (error) {
  fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
}

const escaped = version.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const headingOfVersion = new RegExp(String.raw`^##\s+v${escaped}(?![\w.\-])`);
const anyVersionHeading = /^##\s+v/;

const lines = contents.split(/\r?\n/);
const starts = lines.flatMap((line, index) => (headingOfVersion.test(line) ? [index] : []));

if (starts.length > 1) {
  fail(
    `docs convention broken in ${file}: version ${version} has ${starts.length} headings (lines ${starts
      .map((index) => index + 1)
      .join(", ")}). One version, one section.`,
  );
}

if (starts.length === 0) {
  // No section for this version: generated notes only. Silence, exit 0.
  process.exit(0);
}

const start = starts[0]!;
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (anyVersionHeading.test(lines[i]!)) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end);
while (body.length > 0 && body[0]!.trim() === "") body.shift();
while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();

if (body.length > 0) process.stdout.write(`${body.join("\n")}\n`);
