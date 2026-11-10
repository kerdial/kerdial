#!/usr/bin/env bash
#
# `pnpm verify` — everything CI gates on, locally.
#
# **Why this exists.** Every CI run is billed on this private repo — tens of
# minutes per pull request, summed over its jobs — so the recorded rule is
# "verify locally, never push to iterate". That rule was
# unenforceable while the steps lived only in `ci.yml`: you had to remember all
# of them, in order, including one trap that silently inverts a result (see
# `unused-exports-gate` below). Two failures on 2026-08-21 came from exactly
# that gap — a PR merged red, and a cross-PR interaction no single PR's checks
# could see.
#
# **Run it on a branch rebased onto `origin/main`.** The interaction class this
# catches is "my change is fine, main's change is fine, together they break" —
# one branch deleted a test that another branch's new gate needed, and no run
# ever had both.
# Rebasing first is what makes this script see the merge result rather than just
# your own diff. `--check-base` enforces that.
#
# ## Gate parity with ci.yml
#
# This file used to claim it ran the gates "in `ci.yml`'s `gates` job order",
# and it ran neither all of them nor in that order. Three were missing outright
# — `csp-dist-gate`, `test:e2e:test-proxy` (since retired), `test:e2e:static-tier` — so a
# developer could run this to completion, read `ALL PASSED`, push, and still
# fail CI on a gate they had no local way to run. That is the exact mirror of
# the catalogue gate running locally but not in CI, and fixing one direction
# while leaving the other left the invariant "local and CI gate on the same set"
# still false.
#
# **The set is now enforced, not asserted in prose.**
# `api/src/ci-gating.test.ts` parses this file and `ci.yml` and compares the two
# sets of `pnpm` scripts in both directions. A gate added to either file and not
# the other fails that test by name. Without such a check this recurs on the
# next gate added — which is how it recurred the first time.
#
# **Order deliberately diverges in one place.** It is written down here because
# the next person aligning the two files needs to tell intent from drift, and
# drift is what the 2026-08-21 double failure was. The parity test carries the
# same list, so a second divergence fails until it is written down too:
#
#   1. `check:sparkline-chunk` runs **first** in `ci.yml`'s gate sequence,
#      where its `web/dist` input arrives, and **seventh** here. Local order is
#      chosen for feedback speed instead: build, typecheck, lint, format, then
#      the static gates — a type error should not wait behind a gzip-size
#      measurement.
#
# `known-answers` used to be listed here as a second divergence, as a separate
# CI job. The `ci-release` cycle folded that job into `static` as a step of its
# own name, which is what that gate actually needs (a named,
# independently visible release gate), so the two lanes now agree on it.
#
# **CI runs no web/ test at all** — no browser test (`ci-release` L1/L7) and,
# since L18, none of the `web/src` vitest suites either: the
# `test:web` step below is the only place they run.
# **CI runs no browser test at all** (`ci-release` L1/L7): neither the pull
# request workflow nor the release workflow installs Playwright or runs
# `test:e2e*`. A full `pnpm verify` is therefore the **only** pre-merge browser
# coverage that exists — nothing downstream re-runs it, and nothing will catch
# afterwards what `--fast` skipped here.
#
# **CI no longer builds the image either** (owner decision 2026-09-22, spec
# L19): the pull-request image gate is gone and so is the `main`-push publish.
# `image:build` below is therefore the **only** Dockerfile build before a
# release tag — the next one after it is `release.yml`'s, which pushes what it
# builds. A broken Dockerfile that gets past a `--fast` run surfaces at release
# time, in the workflow that publishes. The published-image verification stays
# CI-only by nature: it needs a registry.
#
# **`--fast` is not a substitute for a full run.** It skips the flake lane, both
# e2e lanes and the `image:build` step, which is where a cross-feature interaction
# becomes visible — a Batch B
# of the `cash-accounts` cycle was green under `--fast` and produced 19 e2e
# failures from one unspecified product gap. Never advance a release gate on a
# `--fast` run.
#
# Usage:
#   pnpm verify                  # everything
#   pnpm verify --fast           # skip the slow lanes (e2e x2, flake, image:build)
#   pnpm verify --check-base     # also fail if not rebased onto origin/main
#
set -uo pipefail

FAST=0
CHECK_BASE=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --check-base) CHECK_BASE=1 ;;
    *) echo "verify: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

# **`--fast` cannot clear a change to the e2e specs themselves.**
#
# The header above already forbids advancing on `--fast`, and this repo's own
# history records it twice. Batch H was committed on
# `--fast` anyway; the e2e lane's next run — the FT-48 release
# gate — found two HIGH defects immediately, both in specs Batch H had itself
# edited, both deterministic, neither flake. The rule was written down and
# enforced by nothing, so this refuses the combination outright rather than
# printing another warning nobody reads.
#
# Scope is deliberately narrow: only a change to `web/e2e/**` trips it. Editing
# a spec and then skipping the only lane that runs it is not a slow-lane
# trade-off, it is not running the thing you just changed. Every other use of
# `--fast` is untouched and still legitimate.
if [ "$FAST" -eq 1 ]; then
  # Working tree + index, plus anything already committed on this branch, so it
  # fires whether the edit is uncommitted, staged, or two commits back.
  #
  # The base is the **closest** of `main` and `origin/main`, not a preferred
  # one. This guard's own first real use got that wrong: nothing in this repo is
  # pushed, so `origin/main` sat ten commits stale, and preferring it made the
  # guard diff against a base predating another branch's merge — it then blamed
  # this branch for an e2e spec somebody else had already landed on `main`.
  # A false refusal teaches people to work around the guard, which is how it
  # ends up as unenforced as the prose it replaced.
  base=""
  for candidate in main origin/main; do
    found=$(git merge-base HEAD "$candidate" 2>/dev/null) || continue
    # Keep whichever base is further along; an older one only re-reports commits
    # that are already merged.
    if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$found" 2>/dev/null; then
      base=$found
    fi
  done
  changed=$(
    {
      git diff --name-only HEAD 2>/dev/null
      [ -n "$base" ] && git diff --name-only "$base"...HEAD 2>/dev/null
    } | sort -u
  )
  if printf '%s\n' "$changed" | grep -q '^web/e2e/'; then
    printf '\033[31mverify: --fast refused\033[0m\n' >&2
    printf 'This change touches web/e2e/**, and --fast skips all three e2e lanes —\n' >&2
    printf 'so it would skip the only lane that runs the specs you edited.\n\n' >&2
    printf 'Touched:\n' >&2
    printf '%s\n' "$changed" | grep '^web/e2e/' | sed 's/^/  /' >&2
    printf '\nRun the full lane:   pnpm verify\n' >&2
    printf 'Or just that lane:   pnpm test:e2e\n' >&2
    printf 'Free :5173 and :3000 first, or the run measures a stale dev server.\n' >&2
    exit 2
  fi
fi

FAILED=()
step() {
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m✔ %s\033[0m\n' "$name"
  else
    printf '\033[31m✘ %s\033[0m\n' "$name"
    FAILED+=("$name")
  fi
}

if [ "$CHECK_BASE" -eq 1 ]; then
  printf '\n\033[1m▶ base check\033[0m\n'
  git fetch origin --quiet
  if [ -n "$(git rev-list HEAD..origin/main)" ]; then
    behind=$(git rev-list --count HEAD..origin/main)
    printf '\033[31m✘ %s commits behind origin/main — rebase first, or this proves nothing about the merge result\033[0m\n' "$behind"
    exit 1
  fi
  printf '\033[32m✔ up to date with origin/main\033[0m\n'
fi

# Build FIRST, and not merely because the other steps are faster with it.
#
# `knip` resolves cross-package consumers through each package's built `dist/`.
# With no `dist/` it cannot see them and reports ~83 unused exports in
# `market/ingestion` alone — every one of them a false positive. A local run
# without this step therefore *looks* far worse than CI and is worthless for
# triage. CI builds before its gates job, so it never hits this.
# Invoked as the **package scripts ci.yml itself runs** (`pnpm build`, not
# `pnpm -r run build`; `pnpm lint`, not `pnpm exec eslint .`). They were
# already equivalent — `build` *is* `pnpm -r run build`, `lint` *is* `eslint .`
# — but spelling them the same way is what lets `api/src/ci-gating.test.ts`
# compare the two files' gate sets by name instead of through a hand-maintained
# translation table, which would be one more thing to drift.
step "build" pnpm build
step "typecheck" pnpm typecheck
step "lint" pnpm lint
step "format" pnpm format:check

# The static gates. See "Gate parity with ci.yml" above for the three
# deliberate divergences from ci.yml's own ordering and placement.
step "schema numeric gate" pnpm no-floats-schema-gate

# Numbered sections in `docs/*.md` are cited by number, and a clean merge can
# renumber them silently. Pure text, no build input, so it sits with the static gates.
step "doc-sections gate" pnpm doc-sections-gate
# csv-import CI-8 (RC7). Scans `importer/src/types.ts` and
# `importer/src/pipeline/**` for the eleven Portfolio Performance literals, and
# — the half that keeps it from going blind — asserts all eleven are still
# *found* in `importer/src/formats/portfolio-performance/`. Placed here, between
# `doc-sections-gate` and `instrument-catalogue-gate`, and in the same slot in
# `ci.yml`, because `api/src/ci-gating.test.ts` compares the two gate sets and
# verify.sh's header records a 2026-08-21 double failure from exactly that drift.
step "import vocabulary gate" pnpm import-vocabulary-gate
step "instrument catalogue gate" pnpm instrument-catalogue-gate
step "module boundaries" pnpm depcruise
step "unused exports" pnpm unused-exports-gate
step "sparkline chunk budget" pnpm check:sparkline-chunk
# Reads `web/dist`, which the `build` step above produces (`pnpm build`
# includes `@kerdial/web`). The gate fails rather than passing when that
# directory is absent, so a missing build cannot read as a pass.
step "CSP dist gate" pnpm csp-dist-gate
step "known-answer gate" pnpm known-answers

# `TEST_SHARED_PG=1` matches ci.yml: one Postgres container, template-cloned
# per-suite databases.
step "test:main" env TEST_SHARED_PG=1 pnpm test:main
# The web/ vitest suites (component, route and web/src/lib logic tests) left
# the pull-request gate by owner decision (`ci-release` L18):
# `test:main` excludes `web/**`, and this step is the only place they run.
# Always on, `--fast` included — ~30 s of wall, no Postgres.
step "test:web" pnpm test:web

if [ "$FAST" -eq 0 ]; then
  # Serial and isolated, exactly as ci.yml's `flake-lane` runs them — these
  # suites measure timing and fail under parallel load.
  step "flake lane" env TEST_SHARED_PG=1 pnpm test:flake-lane
  # Free :5173 and :3000 before these, or the Playwright webServer attaches to
  # a stale dev server and measures the wrong build.
  step "e2e" pnpm test:e2e
  # The only check in this repo that loads the built bundle in a real browser
  # under the real enforced Content-Security-Policy. `csp-dist-gate` above
  # greps the bundle and cannot see a call site that survives minification as
  # `const t=Function; new t("")` — a real violation was exactly that, so these two
  # are not substitutes for each other.
  step "e2e (static tier CSP)" pnpm test:e2e:static-tier
  # The only Dockerfile build before a release tag (L19: no workflow builds
  # an image on a pull request or on a merge to `main` any more), and
  # `api/src/ci-gating.test.ts` asserts exactly that — `image:build` here, no
  # image-building step in `ci.yml` at all. `tools/deploy-tests`'s static parse is the
  # fast half, in `test:main` above; this is the ~3 minutes that prove the thing
  # actually builds. Docker is already a hard prerequisite here
  # (`TEST_SHARED_PG=1` boots Testcontainers).
  step "image build" pnpm image:build
fi

printf '\n────────────────────────────────────────\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  if [ "$FAST" -eq 1 ]; then
    printf '\033[32mALL PASSED\033[0m (--fast: the flake lane, both e2e lanes and the image:build step were skipped — this does NOT imply a green CI run)\n'
  else
    printf '\033[32mALL PASSED\033[0m\n'
  fi
  exit 0
fi

printf '\033[31mFAILED (%d)\033[0m\n' "${#FAILED[@]}"
for name in "${FAILED[@]}"; do printf '  - %s\n' "$name"; done
exit 1
