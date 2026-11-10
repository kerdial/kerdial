# Running the app locally

A local run means: a Postgres container, migrations, a first user, and two
processes. A one-shot script does the database half. There is no self-service
signup, but an instance with no user at all now offers a first-run setup screen
in the browser (§4) — the seed script below stays the from-scratch and
lock-out-recovery path. (Self-hosted Docker deployment is a separate, real
path — see [`deploy-runbook.md`](deploy-runbook.md); this page is dev mode
only.)

## Prerequisites

- Node 22 (`nvm use 22`), pnpm 9, Docker running.
- `pnpm install` done at the repo root.

## 1. Database bring-up (one command)

```bash
pnpm dev:up
```

This runs `scripts/dev-up.sh`, which is idempotent (safe to re-run):

1. Starts (or reuses) a `postgres:17` container named `kerdial-pg` on host port 55432 (a non-default port, so it never collides with an existing local Postgres — override with `PG_PORT`). A dev container left over from before 0.2.0, under the old name, still holds that port: `docker rm -f` it, or point `PG_CONTAINER` at its name to keep its data.
2. Applies all migrations (`drizzle-kit migrate`, `platform/db/migrations/`).
3. Sets a local-only password on the `app_web` role — the RLS-enforced role the
   API must connect as (migrations create the roles; in a deployed stack the
   `migrate` service sets the passwords from `.env`).
4. Seeds the dev tenant and one user via the real Argon2id `createUser`
   (defaults: `dev@localhost` / `devdevdev`). That user is an **instance
   admin**, so « Utilisateurs » is reachable straight away.

Override any default via env: `PG_PORT` (default 55432), `PG_CONTAINER`, `APP_WEB_PASS`,
`DEV_USER_EMAIL`, `DEV_USER_PASSWORD` (see the script header).

## 2. API

```bash
pnpm build
DATABASE_URL=postgres://app_web:dev@localhost:55432/postgres \
INGESTION_DATABASE_URL=postgres://app_ingest:dev@localhost:55432/postgres \
CSRF_SECRET=dev-local-csrf-secret-not-for-production \
node api/dist/main.js
```

**Use a stable `CSRF_SECRET` locally — do not generate a random one per start.**
The CSRF token is `HMAC(CSRF_SECRET, sessionId)`, so a new secret invalidates the
`csrf_token` cookie of every already-logged-in browser. The `sid` cookie keeps
validating against the database, so you stay apparently logged in while every
save fails with "CSRF token missing or invalid" — the fix in that state is to log
out and back in.

`INGESTION_DATABASE_URL` is what enables the in-process history-backfill worker.
Leave it out and instrument creation still works, but no EOD history is ever
fetched (the API logs a warning at boot saying so).

Listens on `:3000`. `DATABASE_URL` and `CSRF_SECRET` are mandatory — the
entrypoint refuses to start without them (no fallback secret, by design).
`TRUST_PROXY` stays unset locally: there is no reverse proxy, so per-IP login
throttling treats everything as one client, which is correct here. A deployment
behind its own proxy sets it; see [`deploy-runbook.md`](deploy-runbook.md).

## 3. Web app

```bash
pnpm --filter @kerdial/web dev
```

Vite on `http://localhost:5173`, proxying `/api` to `:3000` (same-origin, no
CORS — matches the production single-container topology).
Log in with the seeded credentials — `dev@localhost` / `devdevdev` by default,
and that account is an instance admin.

## 4. First run in the browser

After `pnpm dev:up` there is already a user, so `/login` shows the ordinary login
form — and the setup token below never comes into it. On a database that has
**no user at all** — you skipped step 1's seed, or you reset the container —
`/login` renders the **first-run setup screen** instead: `GET /auth/setup` answers
`needsSetup: true`, and the screen asks for an email, a password, a base currency
and the **one-time setup token**. The account it creates is the tenant's first
user and the **instance admin**. That is the normal first-run path, in local dev
and on a real deployment alike; it is offered exactly once, because the second
caller finds `needsSetup: false`.

### The setup token

`POST /auth/setup` is public, so the token is what stops whoever reaches a fresh
instance first from claiming it. The API prints it **once per start-up, and only
while the instance is unclaimed**:

```bash
docker compose logs api | grep 'setup token' | tail -1      # a deployed stack
# first-run setup token (required by POST /auth/setup): 8Zc…43-character value
```

Running the API from a checkout (step 2), the same line goes to the terminal
`node api/dist/main.js` is running in. Nothing persists it: restart the
process and the next line carries a different token.

Set `SETUP_TOKEN` in the API's environment to choose the value instead — so a
scripted bring-up can claim a stack without scraping a log. A wrong token
is a `403` **counted as a failed attempt** by the login rate limiter, so guessing
earns the same escalating backoff a wrong password does.

That "first caller wins" is the whole control, so it carries one operational rule
that matters the moment the origin is not just this machine: **claim the instance
before you expose it.** `POST /auth/setup` is public by construction — it has to
be, there is no account to authenticate against yet — so a freshly migrated
database is claimable by whoever reaches it first. Complete the setup screen (or
seed a user) first, and check that the instance says so before publishing it:

```bash
curl -s http://127.0.0.1:3000/api/v1/auth/setup | jq .needsSetup   # must be false
```

`docs/deploy-runbook.md` §0 repeats the same check for a real deployment.

The seed script is the documented fallback, not a legacy path. Use it when there
is no browser in the loop (CI, a scripted from-scratch database), and use it to
get back in if the sole instance admin is locked out — there is no
password-reset-by-email and no peer who could reset it:

```bash
DATABASE_URL=postgres://postgres:dev@localhost:55432/postgres \
DEV_USER_PASSWORD=the-new-password \
pnpm exec tsx scripts/seed-dev-user.ts --reset-password dev@localhost
```

`DATABASE_URL` must be the **postgres superuser** here (not `app_owner`, and not
`app_web`): `app_user` is FORCE-RLS with its only policy granted to `app_web`, so
no other role can write that table. The flag re-hashes an existing user's
password with the real Argon2id parameters and creates nothing; an unknown email
exits non-zero and changes no row.

## What works locally

Login/logout, the responsive shell and PWA offline behaviour, recording every
transaction kind (with user-pinned FX rates), overview + holdings with
calcEpoch-verified refresh, provenance badges, manual price entry from the
Instruments screen.

**Automated market data** (Yahoo/ECB) needs the worker process,
which steps 1-3 above don't start — `INGESTION_DATABASE_URL` on the API
(step 2) only enables the in-process history backfill that runs on instrument
creation, not the scheduled EOD/FX/gap-repair jobs. To get those locally too,
run the worker directly in a fourth terminal:

```bash
INGESTION_DATABASE_URL=postgres://app_ingest:dev@localhost:55432/postgres \
node market/composition/dist/worker-main.js
```

Without it, `instrument_price_daily` / `fx_rate_daily` stay empty for anything
that isn't manually priced or backfilled on creation.

## Resetting

```bash
docker rm -f kerdial-pg     # then pnpm dev:up again for a clean database
```
