import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `ci-release` CR-10 (GATE, tester-authored) — "GHCR sweep as a test". L6
 * stops GHCR publishing; the cycle listed every reference that had to change.
 * This is the automated version of that grep: `ghcr.io` must not remain a
 * *literal* anywhere in the swept surface.
 *
 * **Scope, exactly as specified in the CR-10 dispatch:** `.github/**`,
 * `deploy/**`, `Dockerfile`, `README.md`, top-level `docs/*.md` only,
 * `scripts/**`, `tools/deploy-tests/src/**`.
 *
 * `git ls-files` rather than a filesystem walk: it is gitignore-aware (skips
 * `node_modules`, `dist`) with no extra exclusion list to maintain, and it is
 * exactly what a contributor's own `grep -rn` would see committed. A single
 * `*` in a git pathspec crosses `/` (unlike a shell glob), so `docs/*.md`
 * fetched through the pathspec directly would wrongly include
 * `docs/licenses/*.md` — the filter below is applied
 * in JS instead, against the flat `docs` listing.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function gitLsFiles(...pathspecs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line.length > 0);
}

function sweptFiles(): string[] {
  const direct = gitLsFiles(
    ".github",
    "deploy",
    "Dockerfile",
    "README.md",
    "scripts",
    "tools/deploy-tests/src",
  );
  const topLevelDocs = gitLsFiles("docs").filter((path) => /^docs\/[^/]+\.md$/.test(path));
  return [...direct, ...topLevelDocs].sort();
}

describe("ci-release CR-10 — GHCR sweep (L6: Docker Hub only, GHCR left in place but no longer referenced)", () => {
  it("the swept file set is exactly what the dispatch specifies (regression pin, so a scope shrink is visible)", () => {
    const files = sweptFiles();
    // Pinned by relative path so a rename or an added/removed doc surfaces
    // here rather than silently narrowing what the sweep below covers.
    expect(files).toContain(".github/workflows/ci.yml");
    // `.github/workflows/publish.yml` was pinned here too until L19 deleted it
    // — nothing is built or published on a merge to `main` any more.
    expect(files).toContain(".github/workflows/release.yml");
    expect(files).toContain(".github/release.yml");
    expect(files).toContain("Dockerfile");
    expect(files).toContain("README.md");
    expect(files).toContain("deploy/docker-compose.yml");
    expect(files).toContain("deploy/.env.example");
    expect(files).toContain("docs/deploy-runbook.md");
    expect(files).toContain("docs/deploy-synology.md");
    expect(files).toContain("tools/deploy-tests/src/dockerfile-packages.test.ts");
  });

  it("no ghcr.io literal remains anywhere in the swept surface", () => {
    const hits: string[] = [];
    for (const relPath of sweptFiles()) {
      const contents = readFileSync(join(repoRoot, relPath), "utf8");
      contents.split("\n").forEach((line, index) => {
        if (line.includes("ghcr.io")) {
          hits.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
