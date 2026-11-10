# Kerdial — the application image (SH-27).
#
# One image, two roles: `APP_ROLE=api` serves the SPA *and* `/api/v1/*`;
# `APP_ROLE=worker` runs every pg-boss registration and binds no port
# (a deliberate tradeoff; `api/src/app-role.ts`).
#
# Stage graph:
#
#   manifests ──► deps ──► build ──┐
#            └──► prod-deps ───────┴──► runtime
#
# Three decisions this file exists to hold, none of them re-derivable from the
# file alone:
#
#  1. **`node:22-bookworm-slim`, not alpine, for build *and* runtime.**
#     `argon2` (^0.45.0) ships glibc prebuilds; on musl the prebuild is missing
#     and the install falls back to a source build needing python3/make/g++.
#     Using the same base for both stages also makes the compiled `.node`
#     ABI-compatible by construction. **V4** asserts this *behaviorally* — the
#     runtime stage hashes and verifies a real password through the real
#     `@kerdial/platform-auth` code path below, so a broken prebuild fails
#     the build instead of throwing at the first login in production.
#
#  2. **The production install must not use `--ignore-scripts`** (the
#     corollary that bites) — that skips `argon2`'s prebuild-install script.
#     If it is ever wanted for supply-chain reasons, `pnpm rebuild argon2` has
#     to follow in the same stage, and V4 above is what would catch its
#     absence.
#
#  3. **`pnpm deploy` is not used** (resolves C2/U1). Its file inclusion falls
#     back to `.gitignore` when a package has no `files` field — and `dist/` is
#     gitignored repo-wide with no `files` field anywhere here, so it would
#     silently produce a tree missing every package's build output. Instead:
#     `--prod` install into a clean tree (`prod-deps`, which never sees a
#     source file), plus an explicit copy of each package's `dist/` from
#     `build`. The "fallback that cannot fail", promoted to primary.
#
# Platform: `linux/amd64` only (FR-36). Nothing here is
# arch-specific *except* `argon2`'s prebuild, which is exactly why the platform
# is pinned rather than left to the builder's host.

# ---------------------------------------------------------------------------
# base — the single Node/pnpm layer both install stages and the runtime share.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base

# `npm i -g pnpm@<pinned>` rather than `corepack enable`: corepack's documented
# signing-key rotation breakage makes it a moving part whose own workaround is
# a pinned `npm i -g corepack@latest`. The version is the one
# `package.json`'s `packageManager` field and every CI job already pin — keep
# the three in step.
RUN npm i -g pnpm@9.15.9

WORKDIR /app

# ---------------------------------------------------------------------------
# manifests — every workspace manifest and the lockfile, and nothing else.
#
# Listed one by one on purpose: a `COPY . .` here would rebuild the whole
# dependency install on any source edit, and a glob (`COPY */package.json`)
# does not preserve the directory structure pnpm needs. A new workspace package
# must be added here *and* to `pnpm-workspace.yaml`; if it is forgotten, the
# `deps` install fails on the missing manifest rather than producing a subtly
# incomplete tree.
# ---------------------------------------------------------------------------
FROM base AS manifests

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/
COPY core/api-contracts/package.json core/api-contracts/
COPY core/decimal/package.json core/decimal/
COPY core/domain/package.json core/domain/
COPY core/reference-data/package.json core/reference-data/
COPY importer/package.json importer/
COPY ledger/package.json ledger/
COPY market/adapters/package.json market/adapters/
COPY market/composition/package.json market/composition/
COPY market/ingestion/package.json market/ingestion/
COPY market/ports/package.json market/ports/
COPY platform/auth/package.json platform/auth/
COPY platform/db/package.json platform/db/
COPY platform/logging/package.json platform/logging/
COPY platform/test-support/package.json platform/test-support/
COPY market/test-support/package.json market/test-support/
COPY tools/deploy-tests/package.json tools/deploy-tests/
COPY tools/gates/package.json tools/gates/
COPY valuation/package.json valuation/
COPY web/package.json web/

# ---------------------------------------------------------------------------
# deps — the full (dev included) install the build needs: tsc, vite, tailwind.
# ---------------------------------------------------------------------------
FROM manifests AS deps

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — every package's `dist/`, plus `web/dist`.
#
# `pnpm build` is the root script (`pnpm -r run build`), which is exactly what
# CI runs; pnpm orders it topologically, so `web`'s `vite build` sees its
# workspace dependencies' `dist/` already emitted. The build context excludes
# every `dist/` (see `.dockerignore`), so this stage is the only possible
# source of build output in the final image.
# ---------------------------------------------------------------------------
FROM deps AS build

COPY . .

RUN pnpm build

# ---------------------------------------------------------------------------
# prod-deps — production dependency closure, installed into a tree that has
# never contained a source file, a devDependency, or a build artefact.
#
# The filter is the app image's actual runtime closure: `@kerdial/api` (the
# `api` role) and `@kerdial/market-composition` (the `worker` role, whose
# entrypoint is `worker-main.js`), each with `...` for its workspace
# dependencies. `web` is deliberately not in it — the SPA ships as built
# static files, so react/tanstack/radix have no business in the runtime tree.
# ---------------------------------------------------------------------------
FROM manifests AS prod-deps

RUN pnpm install --frozen-lockfile --prod \
      --filter "@kerdial/api..." \
      --filter "@kerdial/market-composition..."

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# FR-35. `IMAGE_REVISION` is passed by the CI publish job (SH-29) as the
# commit SHA; a local build that does not pass it says so rather than claiming
# a revision it does not know.
ARG IMAGE_SOURCE="https://github.com/kerdial/kerdial"
ARG IMAGE_REVISION="unknown"
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${IMAGE_REVISION}"

ENV NODE_ENV=production
WORKDIR /app

# The production node_modules (every package's, plus the workspace symlinks)
# and the manifests they resolve through. No source, no devDependency, no pnpm
# binary — nothing in the runtime image needs a package manager.
COPY --from=prod-deps /app ./

# Each workspace package's build output, explicitly. `web/dist` and the api's
# own `dist/` must keep this relative layout: `static-tier.ts`'s
# `DEFAULT_WEB_DIST_ROOT` is `<api dist>/../../web/dist`, which is what makes
# one path correct both in the repo and in the image.
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/core/api-contracts/dist ./core/api-contracts/dist
COPY --from=build /app/core/decimal/dist ./core/decimal/dist
COPY --from=build /app/core/domain/dist ./core/domain/dist
COPY --from=build /app/core/reference-data/dist ./core/reference-data/dist
COPY --from=build /app/importer/dist ./importer/dist
COPY --from=build /app/ledger/dist ./ledger/dist
COPY --from=build /app/market/adapters/dist ./market/adapters/dist
COPY --from=build /app/market/composition/dist ./market/composition/dist
COPY --from=build /app/market/ingestion/dist ./market/ingestion/dist
COPY --from=build /app/market/ports/dist ./market/ports/dist
COPY --from=build /app/platform/auth/dist ./platform/auth/dist
COPY --from=build /app/platform/db/dist ./platform/db/dist
COPY --from=build /app/platform/logging/dist ./platform/logging/dist
COPY --from=build /app/valuation/dist ./valuation/dist
COPY --from=build /app/web/dist ./web/dist

# The migration SQL and its journal travel with the image so the one-shot
# `migrate` service (FR-52 — SH-31 owns the runner and the
# compose wiring) has something to apply. `drizzle-kit` is a devDependency and
# is deliberately *not* in this image; `drizzle-orm/postgres-js/migrator` is a
# production dependency and reads exactly this directory.
COPY platform/db/migrations ./platform/db/migrations

# FR-35 / U5. This project is source-available under AGPL-3.0-only, so the
# licence travelling with the binary is a legal requirement, not hygiene.
COPY LICENSE ./LICENSE

COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# The worker healthcheck target is `test -f /run/worker/ready`,
# written by `worker-main.ts` at uid 1000 — the directory has to exist and be
# writable by that user before the process starts.
RUN mkdir -p /run/worker && chown node:node /run/worker

# Non-root runtime user (an image requirement). `node`
# (uid 1000) already exists in the base image; nothing in either role writes
# under /app.
USER node

# **V4, enforced at build time.** Hashes and verifies a real password through
# the real `@kerdial/platform-auth` path — the same code the login endpoint
# calls — as the unprivileged runtime user, in the final layer. An image whose
# `argon2` prebuild is missing or ABI-mismatched fails the build here instead
# of throwing on the first login attempt in production. Do not weaken this to
# an existence check on the `.node` file: that is precisely the inspection V4
# was written to replace.
RUN cd /app/api \
    && node --input-type=module -e " \
      import { hashPassword, verifyPassword } from '@kerdial/platform-auth'; \
      const hash = await hashPassword('correct horse battery staple'); \
      if (!hash.startsWith('\$argon2id\$')) throw new Error('V4: not an argon2id PHC hash: ' + hash); \
      if (!(await verifyPassword(hash, 'correct horse battery staple'))) throw new Error('V4: verify rejected the correct password'); \
      if (await verifyPassword(hash, 'wrong password')) throw new Error('V4: verify accepted a wrong password'); \
      console.log('V4 ok: argon2id hash+verify, ' + hash.slice(0, 30) + '...'); \
    "

# Metadata only — the port the `api` role listens on inside the container
# (always 0.0.0.0:3000; what limits reachability is the *host* publish,
# `API_BIND` in `deploy/docker-compose.yml`, an operator choice).
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
