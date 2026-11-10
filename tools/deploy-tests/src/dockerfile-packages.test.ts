import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `platform/logging` (SH-38) once landed without being added to the root
 * `Dockerfile`, and the application image stopped building — discovered only when
 * Batch K needed to build it. Nothing on the branch could have caught it at the
 * time: the only image build was a `main`-only publish job, so the first signal
 * would have been a failed publish *after* merge. That is no longer the shape of
 * CI — see the note on image builds below — but it is why this gate exists.
 *
 * The Dockerfile lists every package one by one on purpose (a glob would defeat
 * layer caching and hide a missing manifest), so the list needs a gate that
 * fails when the workspace grows and the list does not.
 *
 * This is the static half. It cannot prove the image builds — only a real build
 * does that — but it fails on the specific omission that broke it, in the fast
 * suite, on the branch.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * **These are PARSED from `pnpm-workspace.yaml`, never transcribed from it.**
 *
 * They used to be two hand-written `as const` arrays under a comment claiming
 * they were "`pnpm-workspace.yaml`'s globs, resolved against what is actually on
 * disk". They were not — they were a *copy*, and a copy of a list is exactly the
 * thing this file exists to forbid one directory further down.
 *
 * The `csv-import` cycle proved the cost. `importer` was added to
 * `pnpm-workspace.yaml` and to the Dockerfile it was not; this gate, whose own
 * header promises it "fails when the workspace grows and the list does not",
 * stayed green through fifteen commits and eight full `pnpm verify` runs,
 * because the workspace grew in the file it does not read. The image then failed
 * to build with `TS2307: Cannot find module '@kerdial/api-contracts'` — the
 * `platform/logging` omission's exact shape, in the gate written for it.
 *
 * A gate that carries its own copy of the set it is checking cannot see the
 * change that matters. Reading the manifest costs one `readFileSync` and removes
 * the whole class.
 */
function readWorkspaceGlobs(): { readonly globParents: string[]; readonly literalDirs: string[] } {
  const raw = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const entries = [...raw.matchAll(/^\s*-\s*"?([^"\n]+?)"?\s*$/gm)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  if (entries.length === 0) {
    throw new Error("pnpm-workspace.yaml yielded no package entries — the parse is broken");
  }
  const globParents: string[] = [];
  const literalDirs: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith("/*")) globParents.push(entry.slice(0, -2));
    else literalDirs.push(entry);
  }
  return { globParents, literalDirs };
}

/**
 * **Does a branch that adds a workspace package have to build the image before
 * merge?** An earlier decision answered no, on this gate's own evidence — an image build
 * per branch would cost minutes to re-check what a millisecond assertion covers.
 * `ci-release` L9 superseded that and made every pull request build the image;
 * **L19 (owner decision, 2026-09-22) withdrew L9 again**, so no workflow builds
 * an image before a `vX.Y.Z` tag. The classes that decision left uncovered — a broken
 * source `COPY`, a build-stage ordering fault, a source-only change that pulls a
 * new package into the runtime closure — are caught by `pnpm image:build` inside
 * a full local `pnpm verify`, and otherwise at release time.
 *
 * **This file is unaffected, and stays the fast half.** The question that
 * decision was really deciding was whether a real build was *required* to catch
 * the missing-package class; it is not, and this parse still fails on that class in
 * milliseconds, on the branch, before any Docker daemon is involved. Its own
 * blind spot was the opposite one: the gate used to carry a transcribed copy of
 * `pnpm-workspace.yaml`'s globs and went blind exactly when the workspace grew
 * (the `csv-import` cycle, above). It parses the manifest now, and it is
 * red-confirmed against the real shape: adding a `core/probe266` package with a
 * `workspace:` dependency and no `COPY` line fails this suite with
 * `Dockerfile's manifests stage is missing: core/probe266`. The suite runs under
 * `tools/**` in `pnpm test:main`, so it is in every local `verify` and every CI
 * shard already.
 */
const { globParents: WORKSPACE_GLOB_PARENTS, literalDirs: WORKSPACE_LITERAL_DIRS } =
  readWorkspaceGlobs();

/**
 * The two entrypoint packages. `APP_ROLE=api` runs `api/dist/main.js`;
 * `APP_ROLE=worker` runs `market/composition/dist/worker-main.js`.
 */
const RUNTIME_ENTRYPOINTS = ["@kerdial/api", "@kerdial/market-composition"] as const;

interface WorkspacePackage {
  readonly dir: string;
  readonly workspaceDeps: readonly string[];
}

function readWorkspacePackages(): ReadonlyMap<string, WorkspacePackage> {
  const dirs: string[] = [...WORKSPACE_LITERAL_DIRS];
  for (const parent of WORKSPACE_GLOB_PARENTS) {
    for (const child of readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })) {
      if (child.isDirectory()) dirs.push(`${parent}/${child.name}`);
    }
  }

  const byName = new Map<string, WorkspacePackage>();
  for (const dir of dirs) {
    let raw: string;
    try {
      raw = readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8");
    } catch {
      continue; // a glob parent may hold a non-package directory
    }
    const manifest = JSON.parse(raw) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    const workspaceDeps = Object.entries(manifest.dependencies ?? {})
      .filter(([, range]) => range.startsWith("workspace:"))
      .map(([name]) => name);
    byName.set(manifest.name, { dir, workspaceDeps });
  }
  return byName;
}

/** Every workspace package the two entrypoints reach, transitively, at runtime. */
function runtimeClosure(packages: ReadonlyMap<string, WorkspacePackage>): ReadonlySet<string> {
  const reached = new Set<string>();
  const visit = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const dep of packages.get(name)?.workspaceDeps ?? []) visit(dep);
  };
  for (const entrypoint of RUNTIME_ENTRYPOINTS) visit(entrypoint);
  return reached;
}

const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");

function copiedManifestDirs(): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    const dir = /^COPY\s+(\S+)\/package\.json\s/.exec(line.trim())?.[1];
    if (dir !== undefined) dirs.add(dir);
  }
  return dirs;
}

function copiedDistDirs(): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    const dir = /^COPY\s+--from=build\s+\/app\/(\S+)\/dist\s/.exec(line.trim())?.[1];
    if (dir !== undefined) dirs.add(dir);
  }
  return dirs;
}

describe("Dockerfile package lists", () => {
  const packages = readWorkspacePackages();

  it("copies a package.json for every workspace package", () => {
    const copied = copiedManifestDirs();
    const missing = [...packages.values()].map((pkg) => pkg.dir).filter((dir) => !copied.has(dir));

    expect(
      missing,
      `Dockerfile's manifests stage is missing: ${missing.join(", ")}. ` +
        `Add "COPY <dir>/package.json <dir>/" — the pnpm install resolves through it.`,
    ).toEqual([]);
  });

  it("copies the built dist of every package the runtime entrypoints reach", () => {
    const closure = runtimeClosure(packages);
    const copied = copiedDistDirs();
    const missing = [...closure]
      .map((name) => packages.get(name)?.dir)
      .filter((dir): dir is string => dir !== undefined)
      .filter((dir) => !copied.has(dir))
      .sort();

    expect(
      missing,
      `Dockerfile's runtime stage never copies dist for: ${missing.join(", ")}. ` +
        `The image builds and then fails at import time (this is the platform/logging omission's exact shape).`,
    ).toEqual([]);
  });

  it("reaches platform/logging from the entrypoints — the original regression case", () => {
    // Pinned by name: the original omission was a *specific* package silently dropped. A closure
    // that stopped reaching it would make the test above vacuously green.
    expect(runtimeClosure(packages)).toContain("@kerdial/platform-logging");
    expect(copiedDistDirs()).toContain("platform/logging");
    expect(copiedManifestDirs()).toContain("platform/logging");
  });

  it("does not ship dist for packages outside the runtime closure", () => {
    // The `tools/*` gates are devDependencies of the repo, not of the
    // running services. Shipping them would mean the closure is wrong, not that
    // the image is generous.
    const closureDirs = new Set(
      [...runtimeClosure(packages)]
        .map((name) => packages.get(name)?.dir)
        .filter((dir): dir is string => dir !== undefined),
    );
    const unexpected = [...copiedDistDirs()]
      .filter((dir) => dir !== "web") // web/dist is the built SPA the static tier serves
      .filter((dir) => !closureDirs.has(dir));

    expect(
      unexpected,
      `Dockerfile ships dist for non-runtime packages: ${unexpected.join(", ")}`,
    ).toEqual([]);
  });
});
