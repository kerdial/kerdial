#!/usr/bin/env bash
#
# Canonical Playwright e2e runner — the ONE command to trust for `web/e2e`.
#
# Why a container: WebKit (the `iPhone 14` project) cannot run bare on this
# host — `~/.cache/ms-playwright` has no `webkit-*` build and installing one
# is not reliable here (three WebKit-only failures were root-caused in
# exactly this image). A bare `pnpm test:e2e` on this
# host therefore reports ~66 spurious `browserType.launch: Executable doesn't
# exist` failures plus a handful of Desktop Chrome failures caused by the dev
# service worker reaching the real network, and is NOT a valid baseline. The
# official image pins the same Playwright version as `web/package.json`
# (1.61.1) and ships all three browser builds, so it reproduces CI.
#
# This script exists because the previous cycle ran the container ad hoc and
# never wrote the invocation down — a single canonical, exit-code-preserving
# verification command per gate type, rather than one hand-written per
# dispatch. Exit code is the Playwright exit code, never a pipeline's.
#
# Usage:
#   scripts/e2e-container.sh                       # full suite, both projects
#   scripts/e2e-container.sh --project="Desktop Chrome"
#   scripts/e2e-container.sh e2e/overview-holdings.spec.ts --workers=1
#   scripts/e2e-container.sh web/e2e/overview-holdings.spec.ts   # also fine
#
# Arguments are forwarded verbatim to `playwright test`. Playwright runs with
# `web/` as its cwd, but its positional filters are substring matches against
# each spec's full path, so BOTH `e2e/foo.spec.ts` and the repo-relative
# `web/e2e/foo.spec.ts` select the
# same tests. Verified, not assumed — no path rewriting is needed here.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE="mcr.microsoft.com/playwright:v1.61.1-noble"

# The vite dev server resolves `@kerdial/*` workspace imports through each
# package's exports map into its `dist/`. On a genuinely clean checkout those
# do not exist and EVERY spec fails at `page.goto("/")` with a resolver 500 —
# a failure mode this repo has hit against the CI `e2e` job before.
# Fail loudly and early rather than reporting 160 mystery failures.
missing_dist=()
for pkg in core/api-contracts core/decimal; do
  [[ -d "$REPO_ROOT/$pkg/dist" ]] || missing_dist+=("$pkg/dist")
done
if ((${#missing_dist[@]} > 0)); then
  echo "e2e-container.sh: missing workspace build output: ${missing_dist[*]}" >&2
  echo "e2e-container.sh: run 'pnpm build' first — the vite dev server resolves" >&2
  echo "e2e-container.sh: @kerdial/* imports through dist/, and without it every" >&2
  echo "e2e-container.sh: spec fails at page.goto with a resolver 500." >&2
  exit 2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "e2e-container.sh: image $IMAGE not present locally; pulling..." >&2
  docker pull "$IMAGE" || exit 2
fi

# The repo is mounted at its own absolute path so pnpm's symlinked virtual
# store (node_modules/.pnpm, in-repo) resolves identically inside and out.
# Run as the invoking uid/gid so test-results/ does not come back root-owned;
# that leaves no /etc/passwd entry, hence the explicit writable HOME.
docker run --rm --ipc=host \
  -u "$(id -u):$(id -g)" \
  -v "$REPO_ROOT":"$REPO_ROOT" \
  -w "$REPO_ROOT/web" \
  -e HOME=/tmp/pwhome \
  -e CI="${CI:-}" \
  "$IMAGE" \
  bash -c '
    set -uo pipefail
    mkdir -p /tmp/pwhome/bin

    # playwright.config.ts starts the dev server with `pnpm exec vite`, but the
    # image ships npm/corepack and no pnpm, and enabling corepack needs network.
    # This shim covers the only form the config uses (`pnpm exec <cmd> …`) so
    # neither playwright.config.ts nor package.json has to be changed to make
    # the container work — the config stays byte-identical to what CI runs.
    cat > /tmp/pwhome/bin/pnpm <<"SHIM"
#!/bin/bash
if [ "$1" = "exec" ]; then shift; exec "$@"; fi
exec npx "$@"
SHIM
    chmod +x /tmp/pwhome/bin/pnpm

    export PATH="/tmp/pwhome/bin:$PWD/node_modules/.bin:$PATH"
    exec node_modules/.bin/playwright test "$@"
  ' _ "$@"

exit $?
