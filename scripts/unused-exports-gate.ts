import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **The unused-export gate's own subject list is derived, not transcribed.**
 *
 * `pnpm unused-exports-gate` used to be a `&&`-chain of six literal
 * `knip --workspace <path>` invocations in `package.json`, while `knip.jsonc`
 * separately configured the workspaces to gate. Two hand-maintained copies of
 * one set, and nothing compared them — so the failure was **silent and open**:
 * a workspace added to `knip.jsonc` and not to the script is configured,
 * un-run, and reads as covered.
 *
 * That was not hypothetical either. `.` was configured in `knip.jsonc` and
 * absent from the script, so the root workspace had never been gated at all;
 * it passes, which is why nobody noticed. And `ledger` — the package where five
 * dead re-mapping exports later turned up — was in neither, so the gate
 * could not have flagged them.
 *
 * This is the same defect class as the Dockerfile-package gate, which carried
 * its own copy of `pnpm-workspace.yaml`'s globs and went blind exactly when the
 * workspace grew, and as `knip.jsonc`'s `paths` map, which was a
 * 14-entry transcription that bound nothing. Three instances, so the
 * rule is worth stating rather than re-deriving: **a gate that carries its own
 * copy of the set it checks cannot see the change that matters.**
 *
 * Adding a workspace to `knip.jsonc` is now sufficient to have it gated.
 *
 * ---
 *
 * **Two ways this gate read broader than it measured, and what each one is
 * now.** Both were measured while adding `ledger`, and both are the reason the
 * expectation "had `ledger` been in scope, five dead exports would have been a
 * red gate" could not have held.
 *
 * **Finding 1 — knip does not attribute names through `export * from`.** A
 * deliberately dead export in a star-exported module is not reported; rewrite
 * that one line as a named re-export and it is. `ledger/src/index.ts` star-
 * exports 20 modules and `platform/auth/src/index.ts` 4, so those public
 * surfaces are outside the gate.
 *
 * **Decision: the star re-exports stay.** Converting them means enumerating
 * every public symbol of 20 service modules in a second place that every new
 * export must also be added to — trading a *known blindness* for a *known
 * drift*, and drift is the failure this file already records three instances
 * of (the 14-entry `paths` map, the duplicated workspace set, the
 * Dockerfile-package gate). What is not acceptable is the blindness growing
 * quietly, so it is now **pinned by value** in {@link STAR_REEXPORT_BUDGET}:
 * a new `export * from` in a gated entry fails this gate, and the numbers can
 * only be lowered. `ledger` is gated on its internal modules and explicitly
 * not on its public surface — stated here rather than implied by the entry.
 *
 * **Finding 2 — a workspace's own tests count as consumers**, so a dead
 * production export stays green as long as it has a unit test, which in this
 * repository every service function has. That is exactly how `ledger`'s five
 * dead re-mapping functions stayed green.
 *
 * **Decision: they should not count — and `knip --production`, the obvious
 * lever, cannot express it here. Measured 2026-09-07, both ways:**
 *
 *   * `knip --workspace <w> --production --include exports` reports **92**
 *     exports across `market/ingestion` (75) and `importer` (17) alone. Every
 *     one is a false positive: `--workspace` restricts the entry surface to
 *     that workspace, so `market/composition` consuming `market/ingestion`,
 *     and `api` consuming `importer`, are invisible to the run. The mode is
 *     asking "does this package consume its own export in production", which
 *     is not the question.
 *   * the whole-repo run (`knip --production --include exports`, no
 *     `--workspace`) reports **438**, because only 8 of the ~20 workspaces
 *     have an `entry` configured here — every unconfigured one (`api`, `web`,
 *     `core/*`, most of `platform/*`) reports its entire public surface as
 *     unreachable.
 *
 * So the honest state is: a dead production export with a unit test stays
 * green, this gate does not find it, and making it find one requires
 * configuring a production entry surface for **every** workspace first —
 * which is the widening `knip.jsonc`'s header already defers as its own
 * decision, not something to smuggle in behind a flag. Recorded here so the
 * next reader does not re-run those two commands to learn it, and so nobody
 * reads this gate as covering the case: **`unused-exports-gate` finds exports
 * nothing at all imports, not exports only tests import.**
 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * How many `export * from` lines each gated workspace's entry files carry
 * today (finding 1 above). knip cannot attribute individual names
 * through any of them, so every number here is public surface **outside** this
 * gate. Exact match, not a ceiling: converting one to a named re-export must
 * lower the number in the same commit, and adding one must fail.
 */
const STAR_REEXPORT_BUDGET: Readonly<Record<string, number>> = {
  ledger: 20,
  "platform/auth": 4,
};

function parseKnipConfig(): { workspaces: Record<string, { entry?: string[] }> } {
  const raw = readFileSync(join(REPO_ROOT, "knip.jsonc"), "utf8");
  // `knip.jsonc` is JSONC: line comments and trailing commas. Stripped rather
  // than pulling in a parser — and the result is validated below, so a strip
  // that goes wrong fails loudly instead of yielding an empty list.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const config = JSON.parse(stripped) as {
    workspaces?: Record<string, { entry?: string[] }>;
  };
  const workspaces = config.workspaces ?? {};
  if (Object.keys(workspaces).length === 0) {
    throw new Error(
      "unused-exports-gate: knip.jsonc yielded no workspaces — the parse is broken, and an " +
        "empty list would make this gate pass by checking nothing.",
    );
  }
  return { workspaces };
}

/** Counts `export * from` lines across a workspace's configured, non-glob entry files. */
function countStarReExports(workspace: string, entries: readonly string[]): number {
  const base = workspace === "." ? REPO_ROOT : join(REPO_ROOT, workspace);
  let total = 0;
  for (const entry of entries) {
    if (entry.includes("*")) continue; // globs are not resolved here; see the budget's doc comment
    const file = join(base, entry);
    if (!existsSync(file)) continue;
    total += (readFileSync(file, "utf8").match(/^export \* from /gm) ?? []).length;
  }
  return total;
}

const { workspaces: configured } = parseKnipConfig();
const workspaces = Object.keys(configured);
console.log(`unused-exports-gate: ${workspaces.length} workspace(s) from knip.jsonc`);

const failed: string[] = [];
const problems: string[] = [];

for (const workspace of workspaces) {
  process.stdout.write(`\n▶ knip --workspace ${workspace}\n`);
  try {
    execFileSync("npx", ["knip", "--workspace", workspace], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  } catch {
    failed.push(workspace);
  }

  // Finding 1 — the star-re-export budget. Exact, so the number moves
  // deliberately in both directions.
  const budget = STAR_REEXPORT_BUDGET[workspace];
  const actual = countStarReExports(workspace, configured[workspace]?.entry ?? []);
  if (budget === undefined) {
    if (actual > 0) {
      problems.push(
        `${workspace}: ${actual} \`export * from\` line(s) in its configured entry, and no ` +
          `STAR_REEXPORT_BUDGET entry. knip cannot attribute names through a star re-export, so ` +
          `this is public surface outside the gate — write named re-exports, or record the ` +
          `budget in scripts/unused-exports-gate.ts.`,
      );
    }
  } else if (actual !== budget) {
    problems.push(
      `${workspace}: STAR_REEXPORT_BUDGET says ${budget} \`export * from\` line(s), found ` +
        `${actual}. ${
          actual > budget
            ? "A new star re-export hides every name behind it from this gate."
            : "One was converted — lower the budget in the same commit so the number stays true."
        }`,
    );
  } else if (budget > 0) {
    process.stdout.write(
      `  note: ${budget} star re-export(s) — those modules' public names are NOT gated.\n`,
    );
  }
}

if (failed.length > 0) {
  console.error(
    `\nunused-exports-gate: unused exports in ${failed.length} workspace(s): ${failed.join(", ")}`,
  );
  process.exitCode = 1;
}
if (problems.length > 0) {
  console.error("\nunused-exports-gate: star-re-export budget:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
if (failed.length === 0 && problems.length === 0) {
  console.log(
    `\nunused-exports-gate: no unused exports in ${workspaces.length} workspace(s); ` +
      `star-re-export budgets unchanged.`,
  );
}
