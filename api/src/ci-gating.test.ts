import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CI_YML = join(here, "..", "..", ".github", "workflows", "ci.yml");
const VERIFY_SH = join(here, "..", "..", "scripts", "verify.sh");
const WORKFLOWS_DIR = join(here, "..", "..", ".github", "workflows");

/**
 * The `needs:` list in `ci.yml` that decides what can block a merge.
 *
 * **Why this test exists.** The rule lived in prose only: the since-moved
 * `publish-image` job's doc comment said "Every job above is listed; adding a
 * new one means adding it here too, or the publish silently stops being gated
 * by it", and nothing enforced it. A rule that lives only in a comment is this
 * repo's recorded "vacuous green" shape: the failure is silent, and it presents
 * as a green merge rather than as a missing check. `ci-complete` (the single
 * required status check on `main`) has the same exposure and a worse blast
 * radius: a gating job missing from its `needs` cannot fail a PR at all.
 *
 * Since the `ci-release` cycle `ci.yml` is pull-request-only, and since L19
 * (owner decision, 2026-09-22) there is no `main`-push workflow at all: the two
 * workflow files are `ci.yml` (pull request) and `release.yml` (a `vX.Y.Z` tag).
 *
 * **Placement.** This gates a repo-root CI artifact, not api behaviour, and
 * belongs in the `tools/deploy-tests` package proposed for
 * exactly this class of test — alongside `tools/deploy-tests`'s
 * `compose-stack.test.ts`/`dockerfile-packages.test.ts`, which carry the
 * same apology. It sits here to follow the existing precedent rather than
 * inventing that package as a side effect of an unrelated change; a later cleanup is
 * to move all four together.
 *
 * Parsed with targeted regex rather than a YAML library because the repo has no
 * YAML dependency and `compose-stack.test.ts` already established that shape for
 * the same reason.
 */
function readCi(): string {
  return readFileSync(CI_YML, "utf8");
}

/**
 * Every top-level job key.
 *
 * **Two defects, one fix.** The pattern was `/^ {2}([a-z][a-z0-9-]*):$/`,
 * which is not YAML's idea of a key but this repository's current habit: a job
 * called `test_main`, `E2E` or `build:  # the long pole` simply did not exist
 * as far as every test in this file was concerned. It therefore did not have to
 * appear in `ci-complete`'s `needs`, did not have to declare `timeout-minutes`,
 * and could hold a write scope — with every test green. The regex below accepts
 * the keys YAML accepts here, including a trailing comment.
 *
 * The second half is the one that matters: **a key this function cannot read
 * must fail, not vanish.** Inside `jobs:` every line indented exactly two
 * spaces is a job key or a comment; the count of parsed keys is therefore
 * compared with the count of two-space, non-comment lines, and the next
 * unreadable spelling (`Weird Job:`, a quoted key, a key with a dot) reddens
 * this comparison instead of quietly shrinking the gating set. The finding's
 * own suggested probe — counting `^ {2}\S+:` lines — would not have caught
 * `  Weird Job:` either, because `\S+` stops at the space.
 */
function jobNames(source: string): string[] {
  const jobsAt = source.indexOf("\njobs:\n");
  expect(jobsAt, "ci.yml must have a top-level `jobs:` block").toBeGreaterThan(-1);
  const jobs = source.slice(jobsAt);
  const names = [...jobs.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):(?:\s*#.*)?$/gm)].map(
    (m) => m[1] as string,
  );
  const keyLines = [...jobs.matchAll(/^ {2}(?!#)\S.*$/gm)].map((m) => m[0]);
  expect(
    names,
    `every job key must be parseable: ${keyLines.length} key-shaped lines, ${names.length} parsed (${keyLines.join(" | ")})`,
  ).toHaveLength(keyLines.length);
  return names;
}

/**
 * The `on:` block, from the trigger key to the next top-level key. Sliced
 * rather than grepped whole-file because every `push`/`pull_request` word in
 * this file's prose would otherwise answer "which events trigger this".
 */
function onBlock(source: string): string {
  const start = source.indexOf("\non:\n");
  expect(start, "ci.yml must have a top-level `on:` block").toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const firstLineEnd = rest.indexOf("\n") + 1;
  const next = rest.slice(firstLineEnd).search(/^[a-z][A-Za-z0-9_-]*:/m);
  return next === -1 ? rest : rest.slice(0, firstLineEnd + next);
}

/** The `needs:` list of one job, as written. */
function needsOf(source: string, job: string): string[] {
  const start = source.indexOf(`\n  ${job}:\n`);
  expect(start, `ci.yml must define a \`${job}\` job`).toBeGreaterThan(-1);
  // Up to the next top-level job, or end of file.
  const rest = source.slice(start + 1);
  // Same key shape as {@link jobNames}, or a job named `test_main` would
  // not end the previous job's block and `needs:` would be read from the wrong
  // one.
  const nextJob = rest.slice(1).search(/^ {2}[A-Za-z_][A-Za-z0-9_-]*:(?:\s*#.*)?$/m);
  const block = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
  const needsAt = block.indexOf("\n    needs:\n");
  if (needsAt === -1) return [];
  const afterNeeds = block.slice(needsAt + "\n    needs:\n".length);
  const entries: string[] = [];
  for (const line of afterNeeds.split("\n")) {
    const match = /^ {6}- ([a-z][a-z0-9-]*)\s*$/.exec(line);
    if (match === null) break;
    entries.push(match[1] as string);
  }
  return entries;
}

// =====================================================================
// `pnpm verify` and `ci.yml` must gate on the same set of scripts.
// =====================================================================

/**
 * The `pnpm` script a shell command invokes, or `null` if it invokes none.
 *
 * Both files spell the same gate several ways — `pnpm build`,
 * `pnpm run test:main -- --reporter=default`,
 * `pnpm --filter "@kerdial/web..." run build` — so the comparison is done on
 * the **script name** rather than the command text. Anything else would need a
 * hand-maintained translation table between the two files, which is one more
 * thing to drift and therefore self-defeating.
 *
 * `pnpm exec …` deliberately returns `null`: it runs a binary, not a declared
 * script. In `ci.yml` the only uses are `playwright install*`, which is
 * environment setup rather than a gate. `verify.sh` used to invoke `eslint`
 * and `prettier` that way and now calls `pnpm lint` / `pnpm format:check`
 * instead — the same thing, spelled the way this comparison can see.
 *
 * That is a blind spot — a gate added as a bare `pnpm exec` would be invisible
 * to the set comparisons — so it is **gated rather than merely documented**:
 * `neither file hides a gate behind \`pnpm exec\`` allows only Playwright
 * browser installation and fails on anything else, naming the offending line.
 * A caveat in a comment is exactly what nobody reads before adding a step.
 */
function pnpmScriptOf(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  // `verify.sh` prefixes two steps with `env TEST_SHARED_PG=1`.
  while (tokens.length > 0 && (tokens[0] === "env" || /^[A-Z_][A-Z0-9_]*=/.test(tokens[0]!))) {
    tokens.shift();
  }
  if (tokens.shift() !== "pnpm") return null;
  // `--filter <pkg>` narrows the scope but not the script — `pnpm build` and
  // `pnpm --filter "@kerdial/web..." run build` are the same gate.
  while (tokens[0]?.startsWith("-")) {
    const flag = tokens.shift()!;
    if (!flag.includes("=") && tokens.length > 0 && !tokens[0]!.startsWith("-")) tokens.shift();
  }
  if (tokens[0] === "exec") return null;
  if (tokens[0] === "run") tokens.shift();
  const script = tokens.shift();
  return script === undefined || script.startsWith("-") ? null : script;
}

/** The block of `ci.yml` belonging to one top-level job. */
function jobBlock(source: string, job: string): string {
  const start = source.indexOf(`\n  ${job}:\n`);
  expect(start, `ci.yml must define a \`${job}\` job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextJob = rest.slice(1).search(/^ {2}[A-Za-z_][A-Za-z0-9_-]*:(?:\s*#.*)?$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

/**
 * One step of a job, from its `- name:` to the next one — *not* to the end of
 * the file.
 *
 * The failure-cleanup assertions below once sliced `source.indexOf("- name: …")`
 * to EOF, so every one of them was really "this string appears somewhere at or
 * after that step". Deleting the whole cleanup step's body and leaving its
 * `env:` in a later step would have kept them green. The bound is the next
 * six-space `- name:`, which is how every step in both workflow files is
 * written.
 *
 * Pass a job block rather than the whole file when a step name repeats across
 * jobs (`changes` and `static` both run the doc-sections gate).
 */
function stepBlock(source: string, stepName: string): string {
  const at = source.indexOf(`- name: ${stepName}`);
  expect(at, `no step named "${stepName}"`).toBeGreaterThan(-1);
  const rest = source.slice(at);
  const next = rest.slice(1).search(/^ {6}- name:/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * Every `pnpm` script `ci.yml` runs in a gating job, in the order it runs them.
 *
 * `ci-complete` is excluded for the reason {@link NON_GATING} gives: it is the
 * aggregate doing the gating rather than a gate, so it does not belong in a
 * parity comparison with a local pre-push script.
 */
function pnpmScriptsIn(block: string): string[] {
  const scripts: string[] = [];
  for (const line of block.split("\n")) {
    const match = /^\s*run:\s+(pnpm\s.*)$/.exec(line);
    if (match === null) continue;
    const script = pnpmScriptOf(match[1]!);
    if (script !== null) scripts.push(script);
  }
  return scripts;
}

function ciGateScripts(source: string): string[] {
  return jobNames(source)
    .filter((job) => !NON_GATING.has(job))
    .flatMap((job) => pnpmScriptsIn(jobBlock(source, job)));
}

/** Every `pnpm` script `verify.sh` runs, in order, as declared by its own `step` calls. */
function verifyGateScripts(source: string): string[] {
  const scripts: string[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*step\s+"[^"]*"\s+(.*)$/.exec(line);
    if (match === null) continue;
    const script = pnpmScriptOf(match[1]!);
    if (script !== null) scripts.push(script);
  }
  return scripts;
}

/**
 * Jobs that are not themselves gates: `ci-complete` is the aggregate doing the
 * gating. It is the only entry since the `ci-release` cycle — `publish-image`
 * was the other one, and it left this file when `ci.yml` lost its `push:`
 * trigger (the workflow it moved to is itself gone under L19).
 *
 * **`changes` is deliberately not in this set**. It runs no gate
 * itself, but it decides whether the three that do are allowed to skip, so a
 * `changes` that failed or disappeared must fail the pull request exactly like
 * a missing test job — which is what its membership of `ci-complete`'s `needs`
 * buys, and what the verdict body below checks first of all.
 */
const NON_GATING = new Set(["ci-complete"]);

describe("ci.yml — what can actually block a merge", () => {
  it("ci-complete needs every gating job — a job missing here cannot fail a PR", () => {
    const source = readCi();
    const gating = jobNames(source).filter((job) => !NON_GATING.has(job));
    expect(gating.length).toBeGreaterThan(0);
    expect([...needsOf(source, "ci-complete")].sort()).toEqual([...gating].sort());
  });

  it("ci.yml triggers on pull_request only — no push trigger, no per-job event guard", () => {
    // History in two steps. Originally a `main` push re-ran the whole suite
    // (~49 billed minutes proving twice what the PR had just proved), so the
    // gating jobs became `pull_request`-only via a per-job `if:` and
    // `publish-image` carried the complement. The `ci-release` cycle finished
    // the job: the `push:` trigger is gone, a `publish.yml` took over the `main`
    // push, and every per-job event guard went with it. L19 then deleted that
    // file too — a merge to `main` now runs no workflow at all.
    //
    // Two silent regressions are pinned here. A `push:` key creeping back into
    // `on:` re-runs the whole PR bill on the merge commit. A leftover per-job
    // `if: github.event_name == …` under a PR-only trigger is dead weight that
    // reads as a gate — and, on the wrong event, would skip the job entirely.
    const source = readCi();
    const on = onBlock(source);
    expect(on, "ci.yml must still trigger on pull_request").toMatch(/^ {2}pull_request:$/m);
    expect(
      on,
      "ci.yml must not trigger on push — only a vX.Y.Z tag runs a workflow outside a PR",
    ).not.toMatch(/^ {2}push:$/m);
    expect(source).not.toContain("github.event_name == 'pull_request'");
    expect(source).not.toContain("github.event_name == 'push'");
  });

  it("ci-complete runs even when a dependency fails, or it reports pending instead of failing", () => {
    // Without `if: always()` the job inherits the default "all needs succeeded"
    // condition and is *skipped* on failure. A skipped required check reads as
    // pending, so the PR looks unfinished rather than broken — and nobody is
    // told why.
    const source = readCi();
    const start = source.indexOf("\n  ci-complete:\n");
    const block = source.slice(start, start + 400);
    expect(block).toContain("if: always()");
  });

  it("ci-complete accepts a skipped gate only on a docs-only pull request, and says so in those words", () => {
    // The rule before L14: every gating job runs on every PR that triggers this
    // workflow, so a skip means a `needs` edge broke or a job was disabled —
    // the silent de-gating this whole file exists to catch. L14 adds exactly
    // one exception, and it is conditional on another job's output rather than
    // on a hard-coded job name: when `changes` reports `code=false` the three
    // gates are *required* to be skipped, and anything else still fails.
    //
    // Each half is pinned separately, because the dangerous edit is dropping
    // the condition and keeping the tolerance — which would read as "skipped is
    // fine" for every pull request.
    const source = readCi();
    const block = jobBlock(source, "ci-complete");

    // The condition itself: the tolerance is reached only through `CODE`.
    expect(block, "the docs-only exception must be conditional on the changes job").toContain(
      'if [ "$CODE" = "false" ]',
    );
    expect(block).toContain("CODE: ${{ needs.changes.outputs.code }}");
    // ...and under it, `skipped` is required of every gate, not merely allowed.
    expect(block).toMatch(/grep -v '=skipped\$'/);
    expect(block).toContain("docs-only PR — code gates skipped by design");
    // The code path is unchanged: `success` or the job fails.
    expect(block).toMatch(/grep -v '=success\$'/);
    // `changes` decides which of the two rules applies, so its own result is
    // checked before either — a failed `changes` must not be able to buy the
    // tolerance by leaving `CODE` empty.
    expect(block).toContain('if [ "$changes_result" != "success" ]');
  });

  it("every gating job is conditioned on the changes job, and changes itself is not conditioned on anything", () => {
    // The other half of L14: the `if:` that does the skipping. A gate that lost
    // its `needs: changes` edge would evaluate `needs.changes.outputs.code` to
    // the empty string — never `'true'` — and would therefore skip on *every*
    // pull request while `ci-complete` still accepted it on a docs-only one.
    const source = readCi();
    const gates = jobNames(source).filter((job) => job !== "changes" && !NON_GATING.has(job));
    expect(gates.sort()).toEqual(["build", "static", "test-main"]);
    for (const job of gates) {
      const block = jobBlock(source, job);
      expect(block, `${job} must run only when there is code to gate`).toContain(
        "if: needs.changes.outputs.code == 'true'",
      );
      // `needs:` is written both ways in this file (`needs: changes` for a
      // single dependency, a list for two), so both are read here.
      const declared = new Set(needsOf(source, job));
      const inline = /^ {4}needs: (\w[\w-]*)$/m.exec(block);
      if (inline !== null) declared.add(inline[1] as string);
      expect(
        [...declared],
        `${job} must depend on changes, or its \`if:\` reads an empty output and it skips always`,
      ).toContain("changes");
    }
    expect(jobBlock(source, "changes")).not.toContain("needs:");
  });

  it("the classifier reads both halves of a rename, or a code file moved into docs/ skips every gate", () => {
    // The MEDIUM. The files API returns **one** entry per renamed file, whose
    // `filename` is the *new* path; the old one is `previous_filename`. Reading
    // `filename` alone made `git mv tools/gates/src/doc-sections/cli.ts
    // docs/old.ts` a docs-only pull request: every gate skipped, `CI
    // complete` green, mergeable without a review.
    const classify = stepBlock(
      jobBlock(readCi(), "changes"),
      "Classify the pull request's changed files",
    );
    expect(classify, "the jq expression must emit the previous path too").toContain(
      "previous_filename",
    );
    expect(classify).toContain(".[] | .filename, (.previous_filename // empty)");
  });

  it("the classifier proves its file list is complete before concluding docs-only", () => {
    // The files endpoint caps at 3000 entries and truncates in silence, so a
    // long pull request's code files can simply be absent from the answer. The
    // count is compared with the pull request's own `changed_files`, and the
    // cap itself is refused, both into `code=true` with a warning.
    const classify = stepBlock(
      jobBlock(readCi(), "changes"),
      "Classify the pull request's changed files",
    );
    // The API read itself, not the word `changed_files` — which also appears in
    // the comment that explains it, and a comment is not a check.
    expect(classify, "the step must read the pull request's own changed_files").toContain(
      'declared="$(gh api "repos/$REPO/pulls/$PR" --jq .changed_files)"',
    );
    // Two refusals: the counts disagree (something is missing from the list),
    // and the cap itself (at 3000 the count can agree and still be truncated).
    expect(classify).toMatch(/elif \[ "\$listed" != "\$declared" \]; then/);
    expect(classify).toMatch(/elif \[ "\$listed" -ge 3000 \]; then/);
    // Fail-safe direction: both branches warn, naming both numbers, and neither
    // reaches `code=false` — a warning that still classified docs-only would be
    // the whole defect with a log line in front of it.
    const mismatchAt = classify.indexOf('elif [ "$listed" != "$declared" ]');
    const elseAt = classify.indexOf("\n          else\n", mismatchAt);
    expect(elseAt).toBeGreaterThan(mismatchAt);
    const branches = classify.slice(mismatchAt, elseAt);
    const warnings = branches.split("\n").filter((line) => line.includes("::warning::"));
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning, "a truncation warning must name both numbers").toMatch(
        /\$listed file\(s\).*changed_files=\$declared/,
      );
    }
    expect(branches, "and must not set code=false").not.toContain("code=false");
  });

  it("the docs-section gate runs on docs-only pull requests, inside the changes job", () => {
    // Previously `pnpm doc-sections-gate` lived only in `static`, which is
    // skipped on a docs-only pull request — so the gate that reads `docs/*.md`
    // never ran on the pull requests that change them, and the §-numbering
    // break surfaced on the next code pull request instead.
    const changes = jobBlock(readCi(), "changes");
    expect(pnpmScriptsIn(changes), "the changes job must run the docs gate").toContain(
      "doc-sections-gate",
    );
    const gate = stepBlock(
      changes,
      "Check docs/*.md section numbering on a docs-only pull request, where the static job does not run",
    );
    expect(gate).toContain("run: pnpm doc-sections-gate");
    expect(
      gate,
      "it must run on the docs-only path only — a code PR gets it from static",
    ).toContain("if: steps.classify.outputs.code == 'false'");
    // It needs a checkout and an install to run at all, both on the same guard,
    // and the job's timeout must cover them (it was 5 minutes for an API call).
    for (const step of [
      "Check out the repository (docs-only pull request)",
      "Set up node and pnpm (docs-only pull request)",
    ]) {
      expect(stepBlock(changes, step)).toContain("if: steps.classify.outputs.code == 'false'");
    }
    expect(changes).toMatch(/^ {4}timeout-minutes: 10$/m);
  });

  it("ci.yml carries no paths-ignore — a path-filtered workflow never reports, and CI complete is required", () => {
    // The defect that made this whole rule necessary: with
    // `paths-ignore` a docs-only pull request produced *no run*, so the
    // required `CI complete` check stayed "Expected" and the PR could not be
    // merged at all. The filtering lives in the `changes` job now. `onBlock`
    // rather than the whole file, because the corrected comment explains the
    // mechanism in prose.
    expect(onBlock(readCi())).not.toContain("paths-ignore");
  });

  it("the workflow still gates on pull_request, or none of the above runs at all", () => {
    expect(readCi()).toMatch(/^ {2}pull_request:$/m);
  });
});

/**
 * The places `verify.sh` and `ci.yml`'s `static` job deliberately differ, each
 * with its reason recorded in `verify.sh`'s own "Gate parity with ci.yml"
 * header section.
 *
 * This list is the point of the exercise, not a suppression. Previously the
 * two files diverged in ways nobody had written down, and `verify.sh`'s comment
 * claimed it ran the gates "in `ci.yml`'s `gates` job order" — so the next
 * person aligning them had no way to tell intent from drift, and drift is what
 * the 2026-08-21 double failure was. A new divergence fails
 * `the two files' gate lanes agree on order` until it is added here *and*
 * explained there.
 *
 * `minimality` below asserts every entry is a real divergence, so this cannot
 * quietly grow into a list that excuses everything.
 */
const DECLARED_DIVERGENCES: Readonly<Record<string, "order" | "verify-only" | "ci-only">> = {
  /** Order: first in ci.yml (where its `web/dist` input arrives), seventh locally (feedback speed). */
  "check:sparkline-chunk": "order",
  // `known-answers` was declared `verify-only` here until the `ci-release`
  // cycle folded the separate `known-answers-gate` job into `static`. It is now
  // a named step in both lanes, in the same relative position, so the
  // declaration went stale and `minimality` would have failed on it — which is
  // what that test is for.
};

/** `build` is a prerequisite every job repeats, not a gate — it is compared as a set member, never for position. */
const NOT_A_GATE_FOR_ORDERING = new Set(["build"]);

/**
 * Scripts `verify.sh` runs that CI runs **nowhere**: the `ci-release` cycle's
 * L1/L7 took the browser lanes out of GitHub Actions entirely, so a full local
 * `pnpm verify` is the only pre-merge browser coverage there is.
 *
 * Asserted rather than excluded, same as above — `the browser lanes are local
 * only` fails if one disappears from `verify.sh` or reappears in `ci.yml`.
 * `--fast` skipping them is a separate, already-gated claim (see the last test
 * in this file).
 */
const LOCAL_ONLY_BY_L7 = ["test:e2e", "test:e2e:static-tier"] as const;

/**
 * `ci-release` L18 (owner decision after the first real run):
 * the `web/src` vitest suites leave the pull-request gate. `test:main`
 * excludes `web/**`, `verify.sh` runs `test:web` instead, and ci.yml runs
 * neither the script nor a `web/**` include anywhere. Asserted below the same
 * way as the browser lanes — a lane that quietly comes back is billed on every
 * PR, a lane that quietly leaves verify.sh is run by nobody.
 */
const LOCAL_ONLY_BY_L18 = ["test:web"] as const;

/**
 * `ci-release` L19 (an image is published only on release): the Docker image
 * build leaves the pull-request gate too.
 * `ci.yml` has no `image-build` job and no image-building step of any kind, the
 * `main`-push publish workflow is deleted, and `release.yml` on a `vX.Y.Z` tag
 * is the only place an image is built or pushed.
 *
 * `image:build` was the one entry of a `CI_EQUIVALENT_VIA_ACTION` table (the
 * local `docker build` against CI's `docker/build-push-action`); that table is
 * gone with the job, and the claim it carried is now the opposite one, asserted
 * by `the image build is local only` below — `verify.sh` runs the script, and
 * no `run:`/`uses:` line in `ci.yml` builds an image. A gate that is nobody's
 * and a gate that quietly comes back are both failures here.
 */
const LOCAL_ONLY_BY_L19 = ["image:build"] as const;

function readVerify(): string {
  return readFileSync(VERIFY_SH, "utf8");
}

/**
 * Every line of a workflow block that would actually build a container image.
 *
 * Comment lines are dropped first, which is the whole point: `ci.yml`'s header
 * explains at length *why* it builds none, naming both spellings
 * (`docker/build-push-action`, `pnpm image:build`), and a comment is not a
 * step. Multi-line `run:` bodies are covered too — a `docker build` three lines
 * inside a script block is not on a `run:` line.
 */
function imageBuildingLines(block: string): string[] {
  return block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => /build-push-action|docker\s+build|docker\s+buildx/.test(line))
    .map((line) => line.trim());
}

/** First occurrence only, order preserved. */
function deduped(scripts: readonly string[]): string[] {
  return [...new Set(scripts)];
}

/**
 * `verify.sh`'s static-gate lane: the steps between the preflight
 * (`build`/`typecheck`/`lint`/`format:check`) and the first test lane. Located
 * structurally rather than by line number so reordering inside the lane does
 * not silently change what is being compared.
 */
function verifyGateLane(source: string): string[] {
  const all = verifyGateScripts(source);
  const after = all.indexOf("format:check");
  const before = all.indexOf("test:main");
  expect(after, "verify.sh must still run format:check").toBeGreaterThan(-1);
  expect(before, "verify.sh must still run test:main").toBeGreaterThan(after);
  return all.slice(after + 1, before);
}

/**
 * `ci.yml`'s static-gate lane: the steps of the `static` job between the
 * preflight (`lint`/`format:check`/`typecheck`) and the timing-sensitive lane.
 * Located structurally, exactly as {@link verifyGateLane} is and for the same
 * reason — before the `ci-release` cycle the lane *was* a whole job (`gates`)
 * and the block was the lane; now it is a span inside a larger job, and a
 * reordering inside it must still be visible to the comparison.
 */
function ciGateLane(source: string): string[] {
  const all = deduped(pnpmScriptsIn(jobBlock(source, "static")));
  const after = all.indexOf("typecheck");
  const before = all.indexOf("test:flake-lane");
  expect(after, "ci.yml's static job must still run typecheck").toBeGreaterThan(-1);
  expect(before, "ci.yml's static job must still run the timing-sensitive lane").toBeGreaterThan(
    after,
  );
  return all.slice(after + 1, before);
}

describe("pnpm verify and ci.yml gate on the same set", () => {
  it("every pnpm script ci.yml gates on is also run by verify.sh", () => {
    // First direction: three gates (`csp-dist-gate`, the since-retired
    // `test:e2e:test-proxy`, `test:e2e:static-tier`) were in ci.yml and not
    // here, so `ALL PASSED` locally did not imply a green CI run.
    const ci = new Set(ciGateScripts(readCi()));
    const local = new Set(verifyGateScripts(readVerify()));
    const missingLocally = [...ci].filter((script) => !local.has(script)).sort();
    expect(missingLocally).toEqual([]);
  });

  it("every pnpm script verify.sh runs is also gated on by ci.yml", () => {
    // The other direction, which is the same defect facing the other way: the
    // catalogue gate ran locally but not in CI, so nothing stopped a bad row
    // from a contributor who had not run `pnpm verify`. Fixing one direction
    // and not the other leaves the invariant false.
    const ci = new Set(ciGateScripts(readCi()));
    const local = new Set(verifyGateScripts(readVerify()));
    // Three named carve-outs, each asserted by a test of its own rather than
    // merely subtracted here: the browser lanes ({@link LOCAL_ONLY_BY_L7}), the
    // `web/src` vitest suites ({@link LOCAL_ONLY_BY_L18}) and the image build
    // ({@link LOCAL_ONLY_BY_L19}) — none of which CI runs at all.
    const carved = new Set<string>([
      ...LOCAL_ONLY_BY_L7,
      ...LOCAL_ONLY_BY_L18,
      ...LOCAL_ONLY_BY_L19,
    ]);
    const missingInCi = [...local]
      .filter((script) => !ci.has(script) && !carved.has(script))
      .sort();
    expect(missingInCi).toEqual([]);
  });

  it("the gates reported are actually present locally", () => {
    // Named explicitly as well as covered by the set comparison above: this is
    // the regression pin, and it fails with the gate's own name rather than as
    // a set diff. (The original finding named three; `test:e2e:test-proxy` has since been retired.)
    const local = new Set(verifyGateScripts(readVerify()));
    for (const gate of ["csp-dist-gate", "test:e2e:static-tier"]) {
      expect(local.has(gate), `verify.sh must run ${gate}`).toBe(true);
    }
  });

  it("the two files' gate lanes agree on order, except where a divergence is declared", () => {
    const ciLane = ciGateLane(readCi());
    const localLane = deduped(verifyGateLane(readVerify()));

    const comparable = (scripts: readonly string[]): string[] =>
      scripts.filter(
        (script) => !(script in DECLARED_DIVERGENCES) && !NOT_A_GATE_FOR_ORDERING.has(script),
      );

    // Relative order, not absolute position — the lanes have different
    // prefixes, and only the sequence of shared gates is the claim.
    expect(comparable(localLane)).toEqual(comparable(ciLane));
  });

  it("minimality: every declared divergence is a real one", () => {
    // Without this, `DECLARED_DIVERGENCES` could grow into a list that excuses
    // everything and the order check above would become vacuous — this repo's
    // own recorded "a check that cannot distinguish 'no violations' from 'this
    // check never looked'" shape.
    const ciLane = ciGateLane(readCi());
    const localLane = deduped(verifyGateLane(readVerify()));

    for (const [script, kind] of Object.entries(DECLARED_DIVERGENCES)) {
      const inCi = ciLane.indexOf(script);
      const inLocal = localLane.indexOf(script);
      if (kind === "ci-only") {
        expect(
          inCi,
          `${script} is declared ci-only but is not in ci.yml's gate lane`,
        ).toBeGreaterThan(-1);
        expect(inLocal, `${script} is declared ci-only but IS in verify.sh's gate lane`).toBe(-1);
      } else if (kind === "verify-only") {
        expect(
          inLocal,
          `${script} is declared verify-only but is not in verify.sh's gate lane`,
        ).toBeGreaterThan(-1);
        expect(inCi, `${script} is declared verify-only but IS in ci.yml's gate lane`).toBe(-1);
      } else {
        expect(
          inCi,
          `${script} is declared an order divergence but is not in ci.yml's gate lane`,
        ).toBeGreaterThan(-1);
        expect(
          inLocal,
          `${script} is declared an order divergence but is not in verify.sh's gate lane`,
        ).toBeGreaterThan(-1);
        // The exact test: put this script *back* into the comparison and the
        // two orders must then disagree. Comparing raw indices instead would be
        // near-vacuous, because the two lanes have different prefixes and so
        // almost any script sits at a different absolute index in each.
        //
        // If they agree, the order has since been aligned and the declaration
        // is stale — delete it, and let the order check cover this script for
        // real.
        const withThisOne = (lane: readonly string[]): string[] =>
          lane.filter(
            (candidate) =>
              (candidate === script || !(candidate in DECLARED_DIVERGENCES)) &&
              !NOT_A_GATE_FOR_ORDERING.has(candidate),
          );
        expect(
          withThisOne(ciLane),
          `${script} is in the same relative order in both files — the declaration is stale, remove it`,
        ).not.toEqual(withThisOne(localLane));
      }
    }
  });

  it("the image build is local only — verify.sh runs image:build, no ci.yml step builds an image (L19)", () => {
    // L19 withdrew L9, which had itself reversed an earlier "no image build
    // before merge" rule, so that rule is in force again. Both halves are pinned, because
    // either one alone is a silent failure: a Dockerfile nobody builds before a
    // release tag, or a three-minute build quietly billed on every pull request
    // again.
    const ci = readCi();
    const local = new Set(verifyGateScripts(readVerify()));
    for (const lane of LOCAL_ONLY_BY_L19) {
      expect(local.has(lane), `verify.sh must still run ${lane}`).toBe(true);
    }
    expect(imageBuildingLines(ci), "no step in ci.yml may build an image").toEqual([]);
  });

  it("the browser lanes are local only — no Playwright in ci.yml (L1/L7)", () => {
    // The owner's lock, and the reason `pnpm verify` full is not optional: no
    // workflow runs a browser, so a lane that quietly reappears here would be
    // paid for on every PR, and a lane that quietly leaves verify.sh would be
    // run by nobody at all.
    const ci = readCi();
    const local = new Set(verifyGateScripts(readVerify()));
    for (const lane of LOCAL_ONLY_BY_L7) {
      expect(local.has(lane), `verify.sh must still run ${lane}`).toBe(true);
      expect(ci, `${lane} must not come back to ci.yml`).not.toContain(lane);
    }
    expect(ci.toLowerCase(), "ci.yml must not mention Playwright at all").not.toContain(
      "playwright",
    );
  });

  it("the web/ vitest suites are local only — test:main excludes web/** and verify.sh runs test:web (L18)", () => {
    const ci = readCi();
    const local = new Set(verifyGateScripts(readVerify()));
    // Structural, not textual: ci.yml's own header names the script while
    // explaining why it is absent, so only `run:` lines count.
    const ciRunLines = ci.split("\n").filter((line) => /^\s*run:/.test(line));
    for (const lane of LOCAL_ONLY_BY_L18) {
      expect(local.has(lane), `verify.sh must run ${lane}`).toBe(true);
      expect(
        ciRunLines.filter((line) => line.includes(lane)),
        `${lane} must not be run by any ci.yml step`,
      ).toEqual([]);
      expect(
        ciRunLines.filter((line) => /\bvitest\b/.test(line) && /\bweb\//.test(line)),
        "no ci.yml step may run vitest against web/",
      ).toEqual([]);
    }
    const scripts = (
      JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["test:main"], "test:main must exclude web/**").toContain('--exclude "web/**"');
    expect(scripts["test:web"], "test:web must run exactly the web suites").toBe(
      "vitest run web/src",
    );
  });

  it("neither file hides a gate behind `pnpm exec`, which the comparison cannot see", () => {
    // `pnpmScriptOf` returns null for `pnpm exec …`, so a gate spelled that way
    // is invisible to the two set comparisons above. Rather than leave that as a
    // documented caveat — a caveat is exactly what nobody reads before adding a
    // step — the blind spot is itself gated: only Playwright browser
    // installation may use `pnpm exec`, because it provisions the environment
    // rather than checking anything.
    const permitted = /playwright install(-deps)?\b/;
    const offenders: string[] = [];
    for (const [label, source] of [
      ["ci.yml", readCi()],
      ["verify.sh", readVerify()],
    ] as const) {
      for (const line of source.split("\n")) {
        if (!/\bpnpm\b[^\n]*\bexec\b/.test(line)) continue;
        // Skip prose: comment lines in both a YAML and a shell file start with
        // `#`, and this file's own explanation of the rule would match.
        if (/^\s*#/.test(line)) continue;
        if (permitted.test(line)) continue;
        offenders.push(`${label}: ${line.trim()}`);
      }
    }
    // If this fails, either spell the new gate as a package script or
    // widen `permitted` deliberately and say why.
    expect(offenders).toEqual([]);
  });

  it("verify.sh's header no longer claims it runs ci.yml's gate order", () => {
    // The false claim this test exists for. It read "The static
    // gates, in ci.yml's `gates` job order" while diverging in three places.
    const source = readVerify();
    expect(source).not.toContain("in ci.yml's `gates` job order");
    // ...and it does record the divergences.
    expect(source).toContain("Gate parity with ci.yml");
    for (const script of Object.keys(DECLARED_DIVERGENCES)) {
      expect(source, `verify.sh must explain the ${script} divergence`).toContain(script);
    }
  });

  it("the e2e lanes and the image build are in the slow lane, and the cheap gate is not", () => {
    // `--fast` exists to skip the minutes-long work. A gate that needs a
    // browser, or a whole `docker build`, must sit inside the
    // `if [ "$FAST" -eq 0 ]` block or `--fast` becomes slow; `csp-dist-gate`
    // only greps a built bundle, so it must sit outside it or `--fast` stops
    // covering it.
    const source = readVerify();
    const fastBlockAt = source.indexOf('if [ "$FAST" -eq 0 ]');
    expect(fastBlockAt).toBeGreaterThan(-1);
    const always = source.slice(0, fastBlockAt);
    const slowOnly = source.slice(fastBlockAt);

    expect(always).toContain("pnpm csp-dist-gate");
    for (const lane of ["pnpm test:e2e:static-tier", "pnpm image:build"]) {
      expect(slowOnly, `${lane} costs minutes and belongs in the slow lane`).toContain(lane);
      expect(always).not.toContain(lane);
    }
  });
});

describe("ci-release AC-415/AC-422 — every job is bounded, and nothing in ci.yml can write", () => {
  it("every job declares timeout-minutes (AC-415)", () => {
    // With no `timeout-minutes` anywhere in this file, `apt-get`
    // retrying a dead mirror ran a job to the GitHub 6h platform limit and
    // reported as an opaque cancellation rather than a failure. The bound is
    // per job, so a new job without one reopens exactly that hole — and the
    // bill is per minute.
    const source = readCi();
    const unbounded = jobNames(source).filter(
      (job) => !/^ {4}timeout-minutes: \d+$/m.test(jobBlock(source, job)),
    );
    expect(unbounded).toEqual([]);
  });

  it("no job in ci.yml holds a write scope (AC-422)", () => {
    // The pull-request path publishes nothing and holds no secret — since L19
    // it does not even build an image, so there is nothing here a credential
    // could attach to (FR-497). `packages: write` left with GHCR (L6);
    // `contents: write` belongs to `release.yml`'s `release` job alone, and to
    // nothing else in the repo.
    const source = readCi();
    const writes = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[a-z-]+: write$/.test(line));
    expect(writes).toEqual([]);
  });
});

// =====================================================================
// CR-10 (GATE, tester-authored) — the AC-415/AC-422 checks above only read
// ci.yml. `release.yml` is the other half of `.github/workflows/*.yml` (there
// were three files until L19 deleted the `main`-push publish); the developer's
// own file never opens it, so an unbounded job or a stray write scope there
// would be invisible to everything the previous describe block proves. These tests glob the whole
// directory and reuse the parsing helpers above rather than re-deriving them
// (`jobNames`/`jobBlock` take `source` as a parameter and are not ci.yml-
// specific — only their assertion messages say "ci.yml", which is cosmetic).
// =====================================================================
interface WorkflowFile {
  readonly name: string;
  readonly source: string;
}

function workflowFiles(): WorkflowFile[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(WORKFLOWS_DIR, name), "utf8") }));
}

/** Every `<indent>key: write` line in a block, trimmed, regardless of indent depth. */
function writeScopeLines(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z-]+: write$/.test(line));
}

describe("ci-release CR-10 — AC-415/AC-422 across every workflow file, not just ci.yml", () => {
  it("every job in every .github/workflows/*.yml file declares timeout-minutes", () => {
    const files = workflowFiles();
    // Two since L19 (`ci.yml`, `release.yml`) — a floor, not the count, so
    // adding a workflow file does not need an edit here to be swept.
    expect(files.length).toBeGreaterThanOrEqual(2);
    const unbounded: string[] = [];
    for (const { name, source } of files) {
      for (const job of jobNames(source)) {
        if (!/^ {4}timeout-minutes: \d+$/m.test(jobBlock(source, job))) {
          unbounded.push(`${name}:${job}`);
        }
      }
    }
    expect(unbounded).toEqual([]);
  });

  it("the only write scope anywhere in .github/workflows/*.yml is contents: write on release.yml's release job", () => {
    const files = workflowFiles();
    const offenders: string[] = [];
    for (const { name, source } of files) {
      // Workflow-level `permissions:` block, above `jobs:`.
      const jobsAt = source.indexOf("\njobs:\n");
      const topLevel = jobsAt === -1 ? source : source.slice(0, jobsAt);
      for (const line of writeScopeLines(topLevel)) {
        offenders.push(`${name} (workflow-level): ${line}`);
      }

      for (const job of jobNames(source)) {
        const writes = writeScopeLines(jobBlock(source, job));
        if (writes.length === 0) continue;
        if (name === "release.yml" && job === "release") {
          // The one permitted write scope in the whole directory.
          expect(writes, "release.yml's release job must hold exactly contents: write").toEqual([
            "contents: write",
          ]);
          continue;
        }
        for (const write of writes) offenders.push(`${name}:${job}: ${write}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("release.yml carries no paths-ignore and never cancels a run in progress (R5/R6)", () => {
    const source = workflowFiles().find((f) => f.name === "release.yml")!.source;
    // The workflow's own comments mention `paths-ignore` (to say there is
    // none) in prose, so this checks the actual `on:` trigger block only —
    // the same slice `onBlock` extracts for ci.yml — not the whole file.
    expect(
      onBlock(source),
      "a tag push on a docs-only commit must still trigger a release",
    ).not.toContain("paths-ignore");
    expect(source).toMatch(/cancel-in-progress:\s*false/);
  });

  it("release.yml keeps pnpm out of the job that holds the Docker Hub credential", () => {
    // The finding: a full `pnpm install --frozen-lockfile` — every transitive
    // dev dependency's `postinstall`, with lifecycle scripts on — ran in the
    // same job as the plaintext registry token, to run one `tsx` script. The
    // split is only worth having while it holds, so it is read back from the
    // file rather than trusted to the comment that describes it.
    const source = workflowFiles().find((f) => f.name === "release.yml")!.source;
    const credentialJobs = jobNames(source).filter((job) =>
      jobBlock(source, job).includes("secrets."),
    );
    expect(credentialJobs, "exactly one job may reference the registry secrets").toEqual([
      "release",
    ]);
    for (const job of credentialJobs) {
      const block = jobBlock(source, job);
      expect(block, `${job} holds the credential and must not install the workspace`).not.toMatch(
        /\bpnpm\b/,
      );
      expect(block).not.toContain("./.github/actions/setup");
    }
    // ...and the job that does install it holds neither a secret nor a write
    // scope (the latter via the write-scope test above, which permits only
    // `release`).
    const notes = jobBlock(source, "notes");
    expect(notes, "the notes job is the one that installs the workspace").toContain(
      "./.github/actions/setup",
    );
    expect(notes).not.toContain("secrets.");

    // No checkout in this file may leave the job's token in .git/config.
    const checkouts = source.split("\n").filter((line) => line.includes("uses: actions/checkout@"));
    // The key itself, not the comment above it that explains why it is there.
    const persistFalse = source
      .split("\n")
      .filter((line) => /^ +persist-credentials: false$/.test(line));
    expect(persistFalse).toHaveLength(checkouts.length);
  });

  it("release.yml's failure cleanup deletes a tag only on proof it is this run's", () => {
    // The HIGH. `steps.push.conclusion != ''` is *true* for a skipped push and
    // for a failed one, so a failure during the **local** verification — with
    // nothing pushed at all — deleted the previous release's `latest` and `X.Y`
    // from Docker Hub. Two independent conditions now: the push actually
    // succeeded, and the digest the registry serves for that tag is the digest
    // this run pushed.
    const source = workflowFiles().find((f) => f.name === "release.yml")!.source;
    // Bounded at the next step, not at EOF — otherwise each assertion
    // below reads "somewhere in the rest of the file".
    const step = stepBlock(source, "Delete the tags this run pushed (failure only)");
    expect(step).toContain("steps.push.outcome == 'success'");
    expect(step, "the outcome/conclusion confusion must not come back").not.toContain(
      "steps.push.conclusion",
    );
    expect(step).toContain("PUSHED_DIGEST: ${{ steps.push.outputs.digest }}");
    // Both response shapes of the Docker Hub tag API.
    expect(step).toContain(".digest // .images[0].digest // empty");
    expect(step).toMatch(/if \[ "\$current" != "\$PUSHED_DIGEST" \]/);
    // The JWT this step derives is unknown to the runner's masker.
    expect(step).toContain('echo "::add-mask::$jwt"');

    // The digest comparison is only a guard if it *skips* the delete.
    // Position, not mere presence: the `continue` must sit between the
    // mismatch test and the `DELETE`, or the comparison is a log line and the
    // tag is deleted anyway.
    const mismatchAt = step.indexOf('!= "$PUSHED_DIGEST"');
    const deleteAt = step.indexOf("-X DELETE");
    expect(mismatchAt, "the cleanup must compare the digest it pushed").toBeGreaterThan(-1);
    expect(deleteAt, "the cleanup must still delete the tag it proved is its own").toBeGreaterThan(
      mismatchAt,
    );
    expect(
      step.slice(mismatchAt, deleteAt),
      "a mismatched digest must `continue` before the DELETE",
    ).toContain("continue");

    // The Docker Hub repository path is derived from `env.IMAGE`, so a
    // rename of the image cannot leave this step deleting another repository's
    // tags. The literal must be gone from the step, and both URLs use the
    // derived value.
    expect(step, "no second spelling of the image name").not.toContain("kerdial/kerdial");
    expect(step).toContain('repo_path="${IMAGE#docker.io/}"');
    expect(
      [...step.matchAll(/hub\.docker\.com\/v2\/repositories\/([^/]+)\//g)].map((m) => m[1]),
    ).toEqual(["$repo_path", "$repo_path"]);
  });

  it("release.yml's last step updates an existing Release instead of failing on it (v0.0.1 incident)", () => {
    // A Release published from the GitHub UI pushes the tag itself, so the
    // workflow runs with the Release already there. `gh release create` alone
    // then fails after the image is pushed and verified. The step must look
    // first and edit in place.
    const source = readFileSync(join(WORKFLOWS_DIR, "release.yml"), "utf8");
    const step = stepBlock(source, "Create the GitHub Release");
    expect(step).toContain('gh release view "$TAG"');
    expect(step).toContain('gh release edit "$TAG"');
    expect(step).toContain('gh release create "$TAG"');
    expect(step, "the edit path must not re-verify a tag it did not create").not.toMatch(
      /gh release edit[^\n]*--verify-tag/,
    );
  });

  it("release.yml refuses a tag whose commit is not on main", () => {
    // L16. The compare API, not a full clone: `identical` and `behind` are the
    // two shapes a tagged commit on main can take.
    const source = workflowFiles().find((f) => f.name === "release.yml")!.source;
    const guard = jobBlock(source, "guard");
    expect(guard).toContain("compare/main...$SHA");
    // The whole arm, closing parenthesis included: `identical | behind | ahead)`
    // would satisfy a looser match and would accept a tag that never landed.
    expect(guard).toContain("identical | behind)");
    expect(guard, "gh needs a token even for a read").toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("the credential guard tests the username as well as the token", () => {
    // A token without a username made the guard true and then failed inside
    // `login-action` with a message about malformed credentials — the guard's
    // whole job is to make that state legible before anything is attempted.
    //
    // Scoped to the guard step, not to the file. File-scoped, the
    // expression could live in a comment, in a different step, or in a step
    // that no longer decides anything, and this test would still pass.
    //
    // This looped over `publish.yml` and `release.yml` until L19 deleted the
    // former; `release.yml` is now the only file in the repository that holds a
    // registry credential at all, so it is the only one with a guard to check.
    const source = workflowFiles().find((f) => f.name === "release.yml")!.source;
    const guard = stepBlock(source, "Are the Docker Hub credentials configured?");
    expect(guard, "release.yml's credential guard must test both secrets").toContain(
      "run: echo \"enabled=${{ secrets.DOCKERHUB_TOKEN != '' && secrets.DOCKERHUB_USERNAME != '' }}\"",
    );
  });

  it("no workflow runs on a push to a branch — a tag is the only non-pull-request trigger (L19)", () => {
    // The other half of L19, and the half nothing else in this file would
    // catch: the deleted `publish.yml` coming back, under any name. Only the
    // `on:` block is read — both remaining files explain in prose what they do
    // *not* publish, and a comment is not a trigger.
    const offenders: string[] = [];
    for (const { name, source } of workflowFiles()) {
      const branches = /^ {4}branches:.*$/m.exec(onBlock(source));
      if (branches !== null) offenders.push(`${name}: ${branches[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it("ci.yml has no push: trigger of its own — release.yml owns the one push path there is", () => {
    const source = workflowFiles().find((f) => f.name === "ci.yml")!.source;
    expect(onBlock(source)).not.toMatch(/^ {2}push:$/m);
  });
});

describe("ci-release CR-10 — verify.sh is a strict superset of ci.yml's changes/build/static/test-main, and owns the image build outright", () => {
  it("every pnpm script changes/build/static/test-main gate on is also run by verify.sh's gate lane (fresh, independent parse)", () => {
    // Independently re-derives the CI-gating script set from the PR-blocking
    // jobs by name (not reusing ciGateScripts's NON_GATING-based filter, so a
    // bug in that filter cannot hide from this test), and checks it against
    // verify.sh. `changes` joined the list when it gained the docs-section gate: it runs no gate on a code
    // pull request but runs `doc-sections-gate` on a docs-only one, and a job
    // that runs a gate must be inside this parse.
    const ci = readCi();
    const local = new Set(verifyGateScripts(readVerify()));
    const ciScripts = new Set(
      ["changes", "build", "static", "test-main"].flatMap((job) =>
        pnpmScriptsIn(jobBlock(ci, job)),
      ),
    );
    const missingLocally = [...ciScripts].filter((script) => !local.has(script)).sort();
    expect(missingLocally).toEqual([]);
  });

  it("no ci.yml job builds an image and verify.sh runs image:build (per-job parse, so a new job is covered too)", () => {
    // The same L19 claim as above, re-derived per job rather than over the file
    // as a whole: a job added later — one no other test in this file knows the
    // name of — is inside this parse by construction.
    const ci = readCi();
    const local = new Set(verifyGateScripts(readVerify()));
    for (const lane of LOCAL_ONLY_BY_L19) {
      expect(local.has(lane), `verify.sh must run ${lane}`).toBe(true);
    }
    for (const job of jobNames(ci)) {
      expect(imageBuildingLines(jobBlock(ci, job)), `${job} must not build an image`).toEqual([]);
    }
  });

  it("the declared local-only lanes (LOCAL_ONLY_BY_L7, LOCAL_ONLY_BY_L18, LOCAL_ONLY_BY_L19) are the only scripts verify.sh runs that ci.yml legitimately omits", () => {
    const ci = readCi();
    const local = new Set(verifyGateScripts(readVerify()));
    const ciScripts = new Set(ciGateScripts(ci));
    const carved = new Set<string>([
      ...LOCAL_ONLY_BY_L7,
      ...LOCAL_ONLY_BY_L18,
      ...LOCAL_ONLY_BY_L19,
    ]);
    const unexplained = [...local]
      .filter((script) => !ciScripts.has(script) && !carved.has(script))
      .sort();
    expect(unexplained).toEqual([]);
  });
});

// =====================================================================
// L17 — every third-party action is pinned to a commit.
//
// A `uses:` on a tag is a `uses:` on whatever the tag points at *today*. The
// tj-actions/changed-files compromise is the shape: a repointed tag inside
// `docker/metadata-action` or `docker/build-push-action` would run in the same
// job as `docker/login-action`, after it has written the Docker Hub token to
// `~/.docker/config.json`. Nothing in this repository read the pins, so they
// were 0-for-18 without anyone noticing.
//
// Scope is both places a `uses:` can appear here: the workflow files and
// the composite action they all call. `.github/dependabot.yml` keeps the pins
// from rotting — a pin nobody advances is an action nobody patches.
// =====================================================================
const ACTIONS_DIR = join(here, "..", "..", ".github", "actions");

interface UsesSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every composite action under `.github/actions`, as {@link workflowFiles} does for workflows. */
function compositeActionFiles(): WorkflowFile[] {
  return readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: `actions/${entry.name}/action.yml`,
      source: readFileSync(join(ACTIONS_DIR, entry.name, "action.yml"), "utf8"),
    }));
}

/** Every `uses:` line in both file sets, with its 1-based line number. */
function usesSites(): UsesSite[] {
  const sites: UsesSite[] = [];
  for (const { name, source } of [...workflowFiles(), ...compositeActionFiles()]) {
    source.split("\n").forEach((line, index) => {
      const match = /^\s*(?:- )?uses:\s*(\S+)/.exec(line);
      if (match === null) return;
      sites.push({ file: name, line: index + 1, text: match[1] as string });
    });
  }
  return sites;
}

describe("ci-release L17 — third-party actions are pinned to a commit SHA", () => {
  it("every `uses:` of a published action is a 40-hex commit, with its version in a comment", () => {
    // A local action (`./.github/actions/setup`) has no `@ref` and is part of
    // this tree, so it is out of scope by the "has a slash AND an @" rule —
    // which is exactly how the finding phrased it.
    const thirdParty = usesSites().filter(
      (site) => site.text.includes("/") && site.text.includes("@"),
    );
    // Not a vacuous green: if this ever drops to a handful, the glob broke.
    expect(thirdParty.length).toBeGreaterThanOrEqual(10);

    const unpinned = thirdParty
      .filter((site) => !/@[0-9a-f]{40}$/.test(site.text))
      .map((site) => `${site.file}:${site.line}: ${site.text}`);
    expect(unpinned).toEqual([]);
  });

  it("each pin carries the released version beside it, or nobody can tell what it is", () => {
    // The SHA is the security property; the `# vX.Y.Z` is what makes the diff
    // of a Dependabot bump readable and what tells a human whether the pin is
    // two years old. Dependabot writes this comment itself when it updates.
    const undocumented: string[] = [];
    for (const { name, source } of [...workflowFiles(), ...compositeActionFiles()]) {
      source.split("\n").forEach((line, index) => {
        if (!/uses:\s*\S+\/\S+@[0-9a-f]{40}/.test(line)) return;
        if (/@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/.test(line)) return;
        undocumented.push(`${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(undocumented).toEqual([]);
  });

  it(".github/dependabot.yml keeps the pins current, for github-actions only", () => {
    // The other half of L17: a pinned action is a frozen action until something
    // proposes the bump. `npm` is deliberately absent — that would open a pull
    // request per package on a repository whose Actions minutes are paid for,
    // which is a separate decision nobody has taken.
    const source = readFileSync(join(here, "..", "..", ".github", "dependabot.yml"), "utf8");
    expect(source).toMatch(/^ {2}- package-ecosystem: "github-actions"$/m);
    expect(source).toMatch(/^ {4}directory: "\/"$/m);
    expect(source).toMatch(/interval: "weekly"/);
    const ecosystems = [...source.matchAll(/package-ecosystem:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(ecosystems).toEqual(["github-actions"]);
  });
});

// =====================================================================
// What the pull-request workflow must never acquire.
//
// The tests above assert what `ci.yml` *has*. These assert what it must not:
// the previous set passed unchanged if someone added `pull_request_target:`
// beside `pull_request:`, referenced a secret, or widened the workflow-level
// permissions block — three edits that each turn the fork-safe PR path into a
// credential-bearing one, and none of which look alarming in a diff.
// =====================================================================
/** The lines of the top-level `permissions:` block, as written. */
function workflowPermissionLines(source: string): string[] {
  const jobsAt = source.indexOf("\njobs:\n");
  const topLevel = jobsAt === -1 ? source : source.slice(0, jobsAt);
  const at = topLevel.indexOf("\npermissions:\n");
  if (at === -1) return [];
  const after = topLevel.slice(at + "\npermissions:\n".length).split("\n");
  const lines: string[] = [];
  for (const line of after) {
    if (!/^ {2}\S/.test(line)) break;
    lines.push(line);
  }
  return lines;
}

describe("the PR path cannot acquire a secret, a write scope or a fork trigger", () => {
  it("ci.yml does not trigger on pull_request_target", () => {
    // `pull_request_target` runs the *base* branch's workflow with a token and
    // with secrets available, against a fork's code. Adding it beside
    // `pull_request:` passed every test in this file until this one was added, and the
    // "triggers on pull_request only" test above reads as if it covered this.
    const source = readCi();
    expect(onBlock(source), "ci.yml must never trigger on pull_request_target").not.toContain(
      "pull_request_target",
    );
    expect(source, "not anywhere else in the file either").not.toContain("pull_request_target");
  });

  it("ci.yml references no secret at all — that is what makes a fork PR run unchanged (FR-497)", () => {
    // The `secrets` context, not the word: the header's prose says "holds no
    // secret" and must stay sayable. `secrets.` with the dot is the only way to
    // read one.
    const offenders = readCi()
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => line.includes("secrets."));
    expect(offenders).toEqual([]);
  });

  it("ci.yml's workflow-level permissions block is exactly `contents: read`", () => {
    // Read-only at the top, with no job widening it (the write-scope test in
    // the CR-10 block above covers the job level, across every workflow file).
    // A `packages: write` added here would be granted to every job in a
    // workflow that runs a fork's own code.
    expect(workflowPermissionLines(readCi())).toEqual(["  contents: read"]);
  });

  it("release.yml triggers on a tag push only — never on a pull request", () => {
    // It holds the Docker Hub credential — the only file that does since L19
    // deleted `publish.yml`. A `pull_request:` trigger here would hand it to
    // any pull request; `pull_request_target:` would hand it to a fork's. Its
    // write scopes are covered by `the only write scope anywhere in
    // .github/workflows/*.yml …` above rather than asserted twice.
    const source = workflowFiles().find((f) => f.name === "release.yml")!.source;
    const on = onBlock(source);
    expect(on).toMatch(/^ {2}push:$/m);
    expect(on).toMatch(/^ {6}- "v\*"$/m);
    expect(on).not.toContain("pull_request");
    expect(source, "no fork-triggered event anywhere in release.yml").not.toContain(
      "pull_request_target",
    );
  });
});

describe("the shard flag actually reaches vitest", () => {
  // `pnpm run <script> -- --flag` forwards the `--` literally, and vitest's
  // argument parser files everything after `--` under `args['--']`, so a
  // `--shard=` written that way is silently ignored: both matrix jobs run the
  // whole lane, the bill doubles and the wall clock does not move. Found by
  // timing measurements, not by any gate — hence this one.
  it("test-main runs `pnpm run test:main --shard=…` with no `--` separator", () => {
    const block = jobBlock(readCi(), "test-main");
    const runLines = block.split("\n").filter((line) => /^\s*run:/.test(line));
    const shardRuns = runLines.filter((line) => line.includes("--shard="));
    expect(shardRuns, "test-main must run exactly one sharded command").toHaveLength(1);
    const command = shardRuns[0]!;
    expect(command).toMatch(/pnpm run test:main --shard=\$\{\{ matrix\.shard \}\}\/2\b/);
    expect(
      command,
      "a `--` before the flag hands it to vitest's ignored trailing args",
    ).not.toMatch(/test:main\s+--\s/);
  });
});
