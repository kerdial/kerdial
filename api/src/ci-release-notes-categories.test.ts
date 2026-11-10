import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `ci-release` CR-10 (GATE, tester-authored) — "also worth a test if cheap"
 * item in the dispatch: `.github/release.yml` (L10) parses, its
 * `changelog.categories` list's LAST entry is the mandatory `"*"` catch-all
 * (without it an unlabelled PR is silently absent from the generated notes —
 * the file's own comment names this), and every other category's labels are
 * ones the repository defines.
 *
 * No YAML library is available to `api/` (`pnpm ls yaml`/`js-yaml` both come
 * back empty) and `ci-gating.test.ts` already established regex parsing over
 * adding a dependency for one config file, so this follows the same
 * convention rather than introducing one.
 *
 * The label set is hard-coded (GitHub's default `bug`, `enhancement`,
 * `documentation`, plus `breaking`, `security`, `dependencies`) rather than
 * fetched from GitHub, so the test makes no API call.
 */

const RELEASE_YML = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "release.yml",
);

function readReleaseYml(): string {
  return readFileSync(RELEASE_YML, "utf8");
}

interface Category {
  readonly title: string;
  readonly labels: readonly string[];
}

/**
 * Parses the `changelog.categories` list. Each entry is
 *   - title: <text>
 *     labels: ["a", "b"]
 * possibly preceded by comment lines. Regex rather than a YAML parser, same
 * rationale as `ci-gating.test.ts`.
 */
function parseCategories(source: string): Category[] {
  const categoryRe = /-\s*title:\s*(.+?)\s*\n\s*labels:\s*\[([^\]]*)\]/g;
  const categories: Category[] = [];
  for (const match of source.matchAll(categoryRe)) {
    const title = match[1]!.trim();
    const labels = match[2]!
      .split(",")
      .map((label) => label.trim().replace(/^"(.*)"$/, "$1"))
      .filter((label) => label.length > 0);
    categories.push({ title, labels });
  }
  return categories;
}

/** The labels the repository defines. */
const KNOWN_LABELS: ReadonlySet<string> = new Set([
  "bug",
  "enhancement",
  "documentation",
  "breaking",
  "security",
  "dependencies",
]);

function isKnownLabel(label: string): boolean {
  return label === "*" || KNOWN_LABELS.has(label);
}

describe("ci-release CR-10 — .github/release.yml's changelog categories (L10)", () => {
  it("parses and has a non-empty changelog.categories list", () => {
    const categories = parseCategories(readReleaseYml());
    expect(categories.length).toBeGreaterThan(0);
  });

  it('the last category is the mandatory catch-all labels: ["*"]', () => {
    // Without this, a PR that matches no earlier category is silently absent
    // from the generated release notes — the file's own comment calls this
    // out. "Last" matters as much as "present": GitHub matches categories in
    // order, so a catch-all anywhere but last would swallow everything after
    // it.
    const categories = parseCategories(readReleaseYml());
    const last = categories[categories.length - 1]!;
    expect(last.labels).toEqual(["*"]);
  });

  it("only the last category carries the catch-all, and every other category's labels exist in the repo's label set", () => {
    const categories = parseCategories(readReleaseYml());
    const offenders: string[] = [];
    categories.slice(0, -1).forEach((category) => {
      for (const label of category.labels) {
        if (label === "*") {
          offenders.push(`${category.title}: "*" must only appear in the last category`);
        } else if (!isKnownLabel(label)) {
          offenders.push(`${category.title}: unknown label "${label}"`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });
});
