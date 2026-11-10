#!/usr/bin/env bash
# One-shot local bring-up: Postgres container → migrations → app_web password
# → dev tenant/user seed → API + web dev servers (detached). Idempotent —
# safe to re-run; each step no-ops when already done. See docs/run-local.md
# for the full walkthrough and what will/won't work locally.
#
# Overridable env:
#   PG_CONTAINER   container name           (default: kerdial-pg)
#   PG_PORT        host port for Postgres   (default: 55432)
#   PG_SUPER_PASS  postgres superuser pass  (default: dev — local only!)
#   APP_WEB_PASS   app_web role password    (default: dev — local only!)
#   DEV_USER_EMAIL / DEV_USER_PASSWORD      seeded login (default dev@localhost / devdevdev)
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-kerdial-pg}"
PG_PORT="${PG_PORT:-55432}"
PG_SUPER_PASS="${PG_SUPER_PASS:-dev}"
APP_WEB_PASS="${APP_WEB_PASS:-dev}"
APP_INGEST_PASS="${APP_INGEST_PASS:-dev}"
# A STABLE local secret, deliberately not randomly generated. The CSRF token is
# HMAC(CSRF_SECRET, sessionId), so a fresh secret on every API restart silently
# invalidates the csrf_token cookie of every already-logged-in browser — while
# the sid cookie keeps validating against the database, so you stay "logged in"
# and every save fails with "CSRF token missing or invalid" until you log out
# and back in. Local-dev value only; production supplies a real secret.
DEV_CSRF_SECRET="${DEV_CSRF_SECRET:-dev-local-csrf-secret-not-for-production}"
export DEV_USER_EMAIL="${DEV_USER_EMAIL:-dev@localhost}"
export DEV_USER_PASSWORD="${DEV_USER_PASSWORD:-devdevdev}"

SUPER_URL="postgres://postgres:${PG_SUPER_PASS}@localhost:${PG_PORT}/postgres"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== 1/4 Postgres container (${PG_CONTAINER}, host port ${PG_PORT})"
if [ "$(docker ps -q -f "name=^${PG_CONTAINER}$")" ]; then
  echo "   already running."
elif [ "$(docker ps -aq -f "name=^${PG_CONTAINER}$")" ]; then
  docker start "${PG_CONTAINER}" >/dev/null
  echo "   restarted existing container."
else
  docker run -d --name "${PG_CONTAINER}" \
    -e POSTGRES_PASSWORD="${PG_SUPER_PASS}" \
    -p "${PG_PORT}:5432" postgres:17 >/dev/null
  echo "   created."
fi

echo "   waiting for Postgres to accept connections..."
for _ in $(seq 1 30); do
  if docker exec "${PG_CONTAINER}" pg_isready -U postgres -q; then break; fi
  sleep 1
done
docker exec "${PG_CONTAINER}" pg_isready -U postgres -q || {
  echo "Postgres did not become ready" >&2
  exit 1
}

echo "== 2/4 Migrations (drizzle-kit migrate)"
(cd "${REPO_ROOT}/platform/db" && DATABASE_URL="${SUPER_URL}" pnpm exec drizzle-kit migrate)

echo "== 3/4 app_web + app_ingest role passwords"
# ALTER ROLE requires a literal — the value is interpolated into the SQL text.
# Local-dev-only credentials; production role provisioning is T-2/T-3's job.
# `app_ingest` is what the in-process history-backfill worker connects as
# (INGESTION_DATABASE_URL below); without it the worker is inert and instrument
# creation never fetches EOD history.
docker exec "${PG_CONTAINER}" psql -U postgres -q \
  -c "ALTER ROLE app_web WITH PASSWORD '${APP_WEB_PASS}'"
docker exec "${PG_CONTAINER}" psql -U postgres -q \
  -c "ALTER ROLE app_ingest WITH PASSWORD '${APP_INGEST_PASS}'"

echo "== 4/4 Dev tenant + user seed"
(cd "${REPO_ROOT}" && DATABASE_URL="${SUPER_URL}" pnpm exec tsx scripts/seed-dev-user.ts)

# API + web dev servers are long-running, so — unlike steps 1-4 — they're
# started detached (setsid + disown) rather than in this script's own
# foreground: a script that block on them here would never reach "Done."
# Idempotent like the rest of this file: an already-listening port is left
# alone rather than double-started, so re-running dev-up.sh after this point
# is still a no-op for whichever half is already up.
mkdir -p "${REPO_ROOT}/.dev-logs"

echo "== 5/5 API + web dev servers"
if lsof -i ":3000" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "   api already listening on :3000, leaving it alone."
else
  (cd "${REPO_ROOT}" && pnpm --filter @kerdial/api build)
  DATABASE_URL="postgres://app_web:${APP_WEB_PASS}@localhost:${PG_PORT}/postgres" \
  INGESTION_DATABASE_URL="postgres://app_ingest:${APP_INGEST_PASS}@localhost:${PG_PORT}/postgres" \
  CSRF_SECRET="${DEV_CSRF_SECRET}" \
  setsid node "${REPO_ROOT}/api/dist/main.js" >"${REPO_ROOT}/.dev-logs/api.log" 2>&1 <&- &
  disown
  echo "   started (pid $!), logging to .dev-logs/api.log"
fi

if lsof -i ":5173" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "   web already listening on :5173, leaving it alone."
else
  (cd "${REPO_ROOT}/web" && setsid pnpm dev >"${REPO_ROOT}/.dev-logs/web.log" 2>&1 <&-) &
  disown
  echo "   started (pid $!), logging to .dev-logs/web.log"
fi

cat <<EOF

Done. API on :3000, web on :5173 (proxies /api -> :3000) — both running
detached; tail .dev-logs/{api,web}.log, kill via their pid or
'lsof -ti:3000,:5173 | xargs kill'. Full detail in docs/run-local.md.

Login: ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}
EOF
