# Deployment runbook

Deployment is self-hosted Docker (ADR-0014, made terminal by ADR-0016). **This project ships the
application only.** TLS termination, certificates, ACME, the domain and the reverse proxy itself are
operator-owned, outside this repository — the app listens on plain HTTP, behind your own proxy or
directly on your LAN.

This page is the operator's procedure: upgrading from 0.1.x (just below), bring-up (§0), the two
exposure knobs (§1), the published image and how a release is cut (§2), the manual dump/restore (§3),
one data check (§4), slow hardware (§5) and the memory ceilings (§6).

> **Running 0.1.x? Read "Upgrading from 0.1.x (portfolio stack) to 0.2.0" below before you pull
> 0.2.0.** The stack was renamed, and the 0.2.0 compose file starts on a new, empty database volume
> until you move your data across. Nothing is deleted, but the app opens on the first-run setup
> screen instead of your portfolios.

> **There is no scheduled backup.** Kerdial does not back itself up. Keep a copy with the app's own
> export (the « Importer » screen) or with the manual database dump in §3.

## Upgrading from 0.1.x (portfolio stack) to 0.2.0

0.2.0 renames the deployed stack from `portfolio` to `kerdial`: the compose project (`name: kerdial`),
therefore its containers (`kerdial-api-1`, …) and its database volume (`kerdial_pgdata`), and the
default database (`POSTGRES_DB=kerdial`). Compose derives the volume name from the project name, so a
0.1.x install that simply pulls the new compose file and runs `docker compose up` gets a **fresh,
empty volume** next to the old one — the app comes up asking for a first-run setup, and your data is
still sitting, untouched, in the old project's `pgdata` volume. Do not claim that empty instance; move
the data across with the procedure below instead. (Already did it, and see the setup screen? Nothing
is lost: follow the procedure from step 1; step 3 removes that empty volume.)

It is §3's dump and restore, run once, from the old stack into the new one. Allow a few minutes of
downtime. Run every command from the stack folder, the directory that holds the stack's
`docker-compose.yml` and `.env`: `deploy/` in a checkout, `/volume1/docker/kerdial` on a Synology NAS.
**On the NAS, `sudo -i` once before starting** (as `docs/deploy-synology.md` §1 does), so that every
`docker` call — including the ones inside `$( … )` — and every `>` redirect into the stack folder runs
as root. **Do not `source` or `set -a; .` the `.env` into your shell** at any point: a variable
exported in the shell overrides the `.env` file for every later `docker compose` call, and the
commands below read the database name and superuser from inside each container precisely so that they
never need it.

**Which installs this is for: 0.1.0 and later.** A 0.0.x install is a `portfolio` stack too, but its
data may predate a migration 0.1.0 introduced. Upgrade it in place to 0.1.2 first — set
`APP_IMAGE=docker.io/kerdial/kerdial:0.1.2` in `.env`, then `docker compose pull && docker compose up
-d --wait` — and come back here once it runs. If that `up` fails, the most likely cause is this refusal (the
same one stops step 5 below if you skip the in-place upgrade), which
`docker compose logs migrate | grep 'cause: PostgresError'` prints with your count in place of `N`:

```
cause: PostgresError: 0079_net-dividend: N transaction(s) still carry a withholding (withholding_amount IS NOT NULL); delete them before migrating -- the withholding currency, rate and account columns are dropped and would change the meaning of those rows
```

It asks you to **delete every transaction that still records a withholding tax** — dividends, in
practice. From 0.1.0 a withholding is one amount in the settling account's currency, and the columns
the old rows depend on are dropped, so the migration refuses rather than reinterpret them. Nothing has
been changed by the refusal — the migrations run in one transaction. Put `APP_IMAGE` back to your
0.0.x version and `docker compose -p portfolio up -d --wait`; list the rows, write them down, delete
them in the app, then retry 0.1.2 and re-enter them there:

```bash
docker compose -p portfolio exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select trade_date, kind, withholding_amount from transaction
    where withholding_amount is not null order by trade_date"'
```

**1. Back up on the old stack, and count what you are moving.** Address the old stack by its project
name — that works whichever compose file is in the directory. Its `postgres` must be running; if it is
not (you stopped it, or a first try at 0.2.0 did), start it alone with
`docker compose -p portfolio up -d --wait postgres`. That also works with either compose file, provided
`.env` still has its 0.1.x `APP_IMAGE` and `POSTGRES_DB` (`portfolio` unless you changed it): if you
already edited them, put the old values back first — step 3 is where they change, and the rollback
copy below is taken from this `.env`.

```bash
OLD=portfolio                       # the 0.1.x compose project name
TS="$(date -u +%Y%m%dT%H%M%SZ)"
cp docker-compose.yml "docker-compose.0.1.yml"; cp .env ".env.0.1"   # for a rollback, see below

docker compose -p "$OLD" exec -T postgres sh -c \
  'pg_dumpall --globals-only --no-role-passwords -U "$POSTGRES_USER"' > "globals-${TS}.sql"
docker compose -p "$OLD" exec -T postgres sh -c \
  'pg_dump -Fc --exclude-schema=pgboss -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "data-${TS}.dump"

COUNTS="select 'transaction', count(*) from transaction union all
        select 'portfolio',   count(*) from portfolio   union all
        select 'instrument',  count(*) from instrument  order by 1"
docker compose -p "$OLD" exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$COUNTS\"" | tee "counts-before-${TS}.txt"
```

These are §3's two artifacts — the globals and the data dump without `pgboss` — and the same rules
apply: run as the superuser, and the files are unencrypted copies of the whole database. Check both
are non-empty (`ls -l globals-*.sql data-*.dump`) before going on. The rollback copies are good even
if the directory already held the 0.2.0 compose file: the rollback names the project with `-p`.

**2. Stop the old stack, keeping its volume.**

```bash
docker compose -p "$OLD" down       # never -v: the old volume is your fallback until step 6
```

**3. Switch the directory to 0.2.0 and start only the new `postgres`.** Replace
`docker-compose.yml` with the 0.2.0 file (`git pull` in a checkout; copy `deploy/docker-compose.yml`
of the release on a NAS). In `.env`, keep every secret exactly as it is — `POSTGRES_SUPERUSER`,
`POSTGRES_SUPERUSER_PASSWORD`, `APP_WEB_PASSWORD`, `APP_INGEST_PASSWORD`, `CSRF_SECRET` — and change
two lines:

```bash
APP_IMAGE=docker.io/kerdial/kerdial:0.2.0
POSTGRES_DB=kerdial
```

The restore needs an **empty** new volume. Check whether a 0.2.0 stack already ran here — you started
0.2.0 before reading this, or this is a retry after a rollback:

```bash
docker compose config | head -n 1   # must print: name: kerdial
docker volume ls -q --filter label=com.docker.compose.project=kerdial \
                    --filter label=com.docker.compose.volume=pgdata
```

If the second command prints a name, that volume holds the empty instance (or a half-restored one),
and step 4 would collide with its roles and tables. Unless you entered real data into that new
instance, remove it:

```bash
docker compose down -v              # the kerdial project only — see below
```

`down -v` acts on the project the compose file names — `kerdial`, which the `config` line just
confirmed — and removes only the volumes that project declares. The old volume belongs to project
`portfolio`, which this command never names, so it cannot be reached from here.

Then bring up the database alone, so nothing migrates an empty schema before the restore:

```bash
docker compose up -d --wait postgres
docker compose ps                   # kerdial-postgres-1 healthy, and nothing else
```

**4. Restore into the new stack's database** — §3's "The restore", aimed at the compose stack's own
`postgres` instead of a scratch container. The globals dump carries `CREATE ROLE` for the superuser,
and the new container already created that role when it initialised its volume; with
`ON_ERROR_STOP` the duplicate would abort the whole file, so those two lines are filtered out:

```bash
SU="$(docker compose exec -T postgres printenv POSTGRES_USER)"
grep -vE "^(CREATE|ALTER) ROLE \"?${SU}\"?[ ;]" "globals-${TS}.sql" |
  docker compose exec -T postgres sh -c \
    'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d postgres'
docker compose exec -T postgres sh -c \
  'pg_restore --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "data-${TS}.dump"
```

The database already exists (the container created `kerdial` from `POSTGRES_DB`), so there is no
`CREATE DATABASE` step, and `pg_restore` lands every object with its original owner and grants —
never `--no-owner`/`--no-privileges`, for the reason §3 gives.

**5. Start the rest, then check login and figures.**

```bash
docker compose up -d --wait         # migrate → worker → api, the usual chain
```

**If this exits non-zero**, `docker compose logs migrate` says why. `api` and `worker` were never
started, the old volume has not been touched, and **Rollback** below puts you back on the old stack. A
database from 0.0.x stops here on the `0079_net-dividend` refusal — see "Which installs this is for".
Otherwise:

```bash
docker compose logs migrate | grep pgboss   # "pgboss schema CREATED, owned by app_ingest"

docker compose exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$COUNTS\"" > "counts-after-${TS}.txt"
diff "counts-before-${TS}.txt" "counts-after-${TS}.txt" && echo "counts identical"
curl -s http://127.0.0.1:3000/api/v1/auth/setup | grep -o '"needsSetup":[a-z]*'   # use your API_PORT
```

`migrate` brings the restored schema up to 0.2.0, recreates `pgboss` and re-applies the two app
passwords — exactly the job §3 gives it after any restore. In the `curl`, replace `3000` with the
`API_PORT` from your `.env` if you changed it; no output at all means the wrong port, not a pass.
`needsSetup` must be **`false`**: `true` means the api is looking at an empty database, and the
restore did not land where you think. Then log in with your usual account and check that the
portfolios and their figures are the ones you had. If `$COUNTS` is no longer in your shell (a new
terminal), re-run its assignment from step 1.

**6. Clean up — later.** Delete the plaintext dumps and copies as soon as the new stack is
confirmed: `rm -f globals-*.sql data-*.dump counts-*.txt`. Keep the old volume for **a week** of
normal use, then remove it — by its compose labels, which name exactly the old project's database
volume and nothing else:

```bash
OLD=portfolio
docker volume ls -q --filter "label=com.docker.compose.project=$OLD" \
                    --filter label=com.docker.compose.volume=pgdata    # check: exactly one name
docker volume rm $(docker volume ls -q --filter "label=com.docker.compose.project=$OLD" \
                                       --filter label=com.docker.compose.volume=pgdata)
rm -f docker-compose.0.1.yml .env.0.1
```

**Rollback**, at any point before step 6: the old volume was never touched. Stop the new stack and
start the old one from the copies saved in step 1 (`.env.0.1` keeps the 0.1.x database name and
image):

```bash
docker compose down                 # the new kerdial stack; its volume stays behind
docker compose -p "$OLD" -f docker-compose.0.1.yml --env-file .env.0.1 up -d --wait
```

The new stack's volume is left behind on purpose — it may be what you want to inspect. **A retry must
start from an empty one**: when you come back to step 3, its check finds this volume and has you remove
it with `docker compose down -v` first.

---

## 0. Bring-up

Everything below assumes the stack is up. This is how.

```bash
cd deploy
cp .env.example .env          # then fill it in — the comments in the file, and §1 for the two exposure knobs
$EDITOR .env
docker compose up -d --wait
```

`docker compose up -d --wait` returns **0 only when the whole chain has come up**, and it is a chain,
not a race:

```
postgres healthy  →  migrate exits 0  →  worker healthy  →  api healthy
```

There is no proxy service to order after `api` — yours, if any, is outside this stack. A **failed migration leaves `api` never started at all**: not "started and unhealthy",
not "serving against an unmigrated schema". `docker compose up --wait` exits non-zero, `docker compose
ps -a` shows `api  Created`, and nothing is listening on the published port. That is the safety
property on purpose — fix the migration and re-run.

### The two exposure knobs

`API_BIND` (which interface the api port is published on) and `TRUST_PROXY` (whether, and from
whom, forwarded client addresses are believed) are plain settings in `.env`. §1 has the three-row
table; pick your row before the first `docker compose up`. The compose file publishes
`"${API_BIND:-127.0.0.1}:${API_PORT:-3000}:3000"` and contains no literal address, so the same file
serves every layout.

### What `migrate` does, and why it needs the superuser

The one-shot `migrate` service is the only thing that connects as `POSTGRES_SUPERUSER`. It applies
every pending migration, re-asserts the `pgboss` schema, and then sets the `app_web` / `app_ingest`
passwords from `.env`. It needs the superuser because migration `0007` is what *creates*
`app_owner` — a role cannot run the migration that creates it — and because `0007` deliberately creates
the application roles with no credentials. It is idempotent: re-running it applies nothing new and
re-applies the same passwords.

The `pgboss` line is the odd one out and exists for restores: a restored database has no
`pgboss` schema (any dump of this database excludes it, §3) and cannot get one from a migration (its journal restores
with `0031` already marked applied) or from the application (`app_ingest` holds no database-level
`CREATE`). Without this step the worker would exit with `schema "pgboss" does not exist` and the stack
would never come up. On an ordinary bring-up it is a no-op and says `pgboss schema already present`.

Changing `APP_WEB_PASSWORD` / `APP_INGEST_PASSWORD` later is safe; the next `docker compose up`
re-applies them. Changing `POSTGRES_SUPERUSER_PASSWORD` after the volume is initialised is **not** —
the volume already holds the old one.

### Re-initialising from scratch

```bash
docker compose down -v        # DESTROYS the database volume
docker compose up -d --wait
```

You get a freshly initialised, freshly migrated database with no host-path assumption anywhere: the
data lives in a **named Docker volume**, never a bind-mounted host directory. That is what makes the
identical file work on a PC and on a Synology NAS, whose DSM owns the uid/gid of every share it
creates.

### Checking it came up

```bash
docker compose ps                      # api/worker/postgres healthy; migrate Exited (0)
docker compose logs api | head         # the one trust line — see §1
curl -s http://127.0.0.1:${API_PORT}/health | jq .
```

`GET /health` is unauthenticated, outside `/api/v1`, and carries no tenant data. `status` is `"ok"`
whenever the database is reachable — **regardless of indicator state**, so a provider having a bad
night never flaps the API. A `BREACHED` indicator is reported, never fatal. A database failure gives
`{"status":"degraded","db":"unreachable"}` and **still answers 200**: the payload is the signal, not
the status code.

Indicator states are `OK`, `BREACHED`, or **`UNKNOWN`**. `UNKNOWN` means *no observation exists* — not
"fine". The worker's ops-indicator sweep writes the three table-backed indicators
(`ingestionStaleness`, `deadLetterDepth`, `circuitBreaker`) every five minutes; each reads `UNKNOWN`
until the first sweep has run, and a worker that is not running leaves them there rather than showing
a healthy value nobody computed.

There is no backup indicator: the stack takes no scheduled backups, so there is nothing for one to
report.

The whole payload is computed at most once per 5 seconds and served from an in-process cache, so
polling `/health` — including from a monitoring system — cannot become a load source.

**Claim the instance before you expose it, and verify the claim.** `POST /api/v1/auth/setup` is
public by construction — on a freshly migrated database there is no account to authenticate against
— so the first caller to reach it becomes the instance admin and gets the tenant. Everything §1
sets up is about *who may reach this origin*, and none of it applies to a fresh, unclaimed instance.
What "before exposure" means depends on `API_BIND`:

- `API_BIND=127.0.0.1` (the default): the port is loopback-only until a proxy publishes it, so
  complete the first-run setup screen on `http://127.0.0.1:${API_PORT}` **before** the proxy
  publishes this origin.
- `API_BIND=0.0.0.0`: the origin is LAN-reachable the moment `docker compose up -d --wait` returns,
  so there is no loopback window and **no scripted way to claim it before that first moment** — bind
  `127.0.0.1` for the first bring-up, complete the setup screen (or the scripted claim below) against
  `http://127.0.0.1:${API_PORT}`, confirm the claim (below), *then* set `API_BIND=0.0.0.0` in `.env`
  and `docker compose up -d --wait` again — compose recreates only the `api` container, and the
  instance is already claimed by the time it becomes LAN-reachable.

**The setup screen asks for a one-time token**, so claiming it through the browser needs one
more step than it used to. The api prints the token once per start-up, and only while the instance
is unclaimed:

```bash
docker compose logs api | grep 'setup token' | tail -1
# first-run setup token (required by POST /auth/setup): 8Zc…43-character value
```

Three things about that line. `tail -1` matters: every api start while the instance is unclaimed
prints a fresh token and only the last one is valid — an older one answers `403` and counts as a
failed login attempt for the email you typed. Claim with **one** api container running: each
would mint its own token and the claim would land on whichever one the proxy picks. No line at all means the api could not read `setup_needed()` at boot (database
unreachable) — fix the database and restart the api. An operator-chosen `SETUP_TOKEN` (`.env`, at
least 16 characters) is printed the same way, so treat it as a throwaway.

Nothing persists it: `docker compose restart api` mints a new one and prints that instead. To choose
the value rather than read it — a scripted bring-up, or a claim you want to script from another
host — add `SETUP_TOKEN=…` to the api's environment in `.env` before bringing the stack up. Either
way a wrong token is a `403` counted as a failed attempt by the login rate limiter, so a scanner
guessing at it earns the same escalating backoff a scanner guessing passwords does.

**Scripted claim, no browser**, once `SETUP_TOKEN` is set: `POST /api/v1/auth/setup` is the same
public endpoint the setup screen calls, so a plain `curl` claims the instance exactly as the browser
would —

```bash
curl -s -X POST http://127.0.0.1:${API_PORT}/api/v1/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…","baseCurrency":"EUR","setupToken":"'"$SETUP_TOKEN"'"}'
```

In both cases confirm the instance is no longer claimable before anything else can reach it:

```bash
curl -s http://127.0.0.1:${API_PORT}/api/v1/auth/setup | jq .needsSetup   # must be false
```

A `true` on a published origin is a land grab waiting to happen, and there is no route that
un-claims an instance.

---

## 1. Exposure: `API_BIND` and `TRUST_PROXY`

**These two are independent, and only one of them is about exposing the app.** The api always
listens on a plain HTTP port; whether and where that port is reachable is `API_BIND` alone — there
is no reverse proxy in this stack and none is required (§0 above). Putting nginx/Caddy/Traefik in
front of that port, with your own TLS and domain, is entirely your setup, outside this repository.

`TRUST_PROXY` is a second, optional dial that does **not** affect exposure at all. It only tells the
api whether to trust an `X-Forwarded-For` header for the per-client login-throttle bucket (§ below).
Blank — what compose uses when `.env` does not set it; `.env.example` ships `1`, the first row of the
table below — and the app works exactly the same whether or not you put a proxy in front; the only cost is that the login throttle then sees every client behind that proxy as one
shared address, which the two rows below spell out.

Two settings in `.env`, read at bring-up — change one and run `docker compose up -d --wait` again.
The four-layer proxy exposure control that used to live here (`PROXY_TOPOLOGY`, a derived
`API_BIND`, a per-request peer monitor, a deploy-time probe) was retired by ADR-0016: it
guarded an internet-exposed, cross-host topology that a self-hosted household instance does not run.

| Your setup | `API_BIND` | `TRUST_PROXY` | `COOKIE_SECURE` |
| --- | --- | --- | --- |
| a reverse proxy on this machine (Caddy/nginx on the NAS, TLS there) | `127.0.0.1` | `1` | `true` |
| no proxy, LAN only, plain `http://` | `0.0.0.0` | blank | `false` |
| a reverse proxy on another machine | `0.0.0.0` | that machine's address | `true` |

- **`API_BIND`** is the interface Docker publishes the port on. `127.0.0.1` means nothing off this
  host can reach the api at all — only a proxy on the same machine. `0.0.0.0` publishes on every
  interface.
- **`TRUST_PROXY`** is what lets the per-IP login throttle see the *real* client behind a proxy:
  `1` trusts exactly one forwarding hop, an address or CIDR trusts that peer only. Blank means
  trust nothing — `request.ip` is the socket peer, which is right when nothing forwards for the api.
  **Never `true`**: that trusts every hop, so any client picks its own address and the throttle is
  inert. And never set it when no proxy is in front — with a direct LAN publish, hop-count trust makes
  the connecting client its own trusted hop, which is the same hole.
- **`COOKIE_SECURE`** is `true` unless you run plain `http://` with no TLS anywhere; see the
  bullet below.

The api prints one line at start-up saying what it resolved:

```bash
docker compose logs api | grep 'trust proxy'
# trust proxy: none — request.ip is the socket peer (TRUST_PROXY unset)
# trust proxy: 1 — X-Forwarded-For is honoured from that hop/peer (TRUST_PROXY)
```

If you run a proxy, it must set `X-Forwarded-For` (Caddy and nginx `proxy_set_header
X-Forwarded-For $proxy_add_x_forwarded_for;` both do), or every client shares the proxy's address
and one attacker's backoff locks everyone out.

**What "every client shares the proxy's address" actually costs**. Two controls key on the
client address, and both collapse into one shared bucket when the api cannot see it: the per-IP
half of the login backoff (a failed sign-in adds a growing delay for *every* device behind the
proxy — the per-email lockout is unaffected, it never keys on an address), and the concurrency cap
on `POST /auth/login` + `POST /auth/setup`, which allows 2 in flight **per client address** and 8
across the whole instance. With `TRUST_PROXY` blank behind a proxy, one device with two sign-ins in
flight uses up the only bucket there is and everyone else is answered `429` until it finishes. Set
`TRUST_PROXY` to your proxy (the table above) and each device gets its own 2. Nothing outside these
two controls depends on the address — there is no per-IP allow/deny list to configure, and no
proxy-level rate limit is required for this.

### Three rules that do not depend on your row

1. **Never publish the `postgres` port.** Every client of it is on the compose network.
2. **Do not attach third-party containers to this compose network.** Containers on it reach
   `api:3000` directly, bypassing the published port and the loopback bind entirely.
3. **A firewall rule is defence in depth, never the control.** `API_BIND` is.

### Two things that look like bugs and are not

- **Pointing a browser straight at `http://<app host>:${API_PORT}` cannot log in** unless you set
  `COOKIE_SECURE=false` in `.env`. By default the session and CSRF cookies are `Secure`, so a
  browser will not send or store them over plain HTTP and the app is usable only through your TLS
  proxy. That default is fail-closed, not a defect. Set `false` only for a LAN-only instance that
  nothing outside your network can reach; it re-enables plain-http log-in and nothing else.
- **With `API_BIND=0.0.0.0`, `/health` and the SPA shell are reachable from the LAN without
  authentication.** That is by design (`/health` is a healthcheck; the shell is public and holds no
  secrets). Every `/api/v1` route still returns 401 without a session.

---

## 2. The published image

One image is published, to **Docker Hub** (`docker.io/kerdial/kerdial`), `linux/amd64` only. It is
the whole application in one artifact — `APP_ROLE=api` or `APP_ROLE=worker` picks which half a
container runs — and it runs as `node`, uid 1000. Three tags, all written by the same single event —
a pushed `vX.Y.Z` git tag:

| Tag | Written by | What it means |
|---|---|---|
| `X.Y.Z` | a pushed `vX.Y.Z` git tag | one release, immutable |
| `X.Y` | the same, final releases only | the newest patch of that minor |
| `latest` | the same, final releases only | **the newest release** |

**An image exists only for a release.** Nothing is built or pushed by a pull request or by a merge
to `main` — the release workflow is the only publisher there is, and there is no moving development
tag. If you find any tag on Docker Hub other than the three above, it is not maintained and nothing
should pin it.

`latest` is written only by a release. **Pin `X.Y.Z` in `.env` for a deployment that does not move.**

Playwright runs in no workflow at all, and neither does a Docker build: a full local `pnpm verify`
before the pull request is the only browser coverage and the only Dockerfile build there is until the
release workflow runs.

The image carries `org.opencontainers.image.source`, `.licenses=AGPL-3.0-only`, `.revision` (the
commit) and `.version` (the release version). To see what a running deployment is actually on:

```bash
docker image inspect docker.io/kerdial/kerdial:latest \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

### Cutting a release

1. Run the **full** `pnpm verify` locally — not `--fast`. No workflow runs Playwright anywhere, so
   this is the only browser run the release gets.
2. In `docs/release-notes.md`, replace `unreleased` in that version's heading with the date
   (`## v0.2.0 — 2026-11-30`). The release workflow puts that section, verbatim, above the generated
   list. Optionally add a fresh `## vX.Y.Z — unreleased` heading above it to start collecting notes
   for the next version.
3. Merge to `main`. Nothing runs on the merge — no image is built and none is published — so there is
   no workflow to wait for.
4. Tag that merge commit with a **lightweight** tag — no `-a`, no `-m` — and push it; pushing the tag
   is the release trigger, and the only one. An annotated tag makes `github.sha` the tag object rather
   than the commit, and the ancestry guard then fails with a 404 on a perfectly good release:

   ```bash
   git tag v0.2.0 <merge commit> && git push origin v0.2.0
   ```

   Creating the release from the GitHub web UI ("Draft a new release" → publish) works too: publishing
   it pushes the tag, which is the same trigger. The workflow then **updates** that Release in place —
   its title, its body (the hand-written section plus the generated list replace whatever was typed in
   the UI) and the prerelease flag — once the image is pushed and verified. Do not expect text typed in
   the UI to survive.

5. The release workflow then runs, in this order: check the tag is SemVer **and that its commit is on
   `main`** → read your hand-written section out of `docs/release-notes.md` → build the image → verify
   it locally → push `X.Y.Z`, `X.Y` and `latest` → pull them back **anonymously** and verify them
   again → create the GitHub Release, with your hand-written section above the auto-generated list of
   merged pull requests. The Release is deliberately last, so nothing announces a version whose image
   is not there.

   The first two happen in jobs that hold no credential; only the build-and-publish job has the
   Docker Hub token, and it installs no dependencies at all.

A prerelease tag (`v0.2.0-rc.1`) publishes `0.2.0-rc.1` alone and marks its Release as a prerelease:
`latest` and `X.Y` never move onto a release candidate.

### When a release run fails

- **Malformed tag** (`v1.2`, `v1.2.3+build`, `0.1.0` — no `v`): the run fails at the very first step,
  before anything is built or pushed, and nothing needs undoing. Delete the tag and re-tag:

  ```bash
  git push --delete origin v1.2 && git tag -d v1.2
  ```

- **Tag on a commit that is not on `main`** (a branch tip, an unpushed commit): the same, one step
  later, and for the same reason — a release is cut from a commit that went through a pull request.
  The message names the commit and what the compare API said about it. Merge the work first, then tag
  the merge commit.
- **Failure up to and including the verification of the pushed image**: the run deletes the tags it
  pushed — **and only those**. Each tag is deleted only if the digest Docker Hub currently serves for
  it is the digest this very run pushed; a `latest` or `X.Y` still pointing at the previous release is
  left alone and the log carries a warning naming the tag and the digest found. (Before this check,
  a failure during the *local* verification — nothing pushed at all — deleted the previous release's
  `latest`, which broke `docker compose pull` for every stack on the compose default.) Deletion is
  best effort either way and it is stated as such — the image may stay reachable by digest — but the
  tags an operator can address are gone. Fix, delete the git tag, re-tag.
- **Failure after the image was pushed and verified** (notes assembly, Release creation): the tags
  stay, and they are correct — they were just verified. Re-run the failed job; it creates the missing
  Release. Do not re-tag.

### One-time setup

The Docker Hub organisation `kerdial` and the repository `kerdial/kerdial`, **public**; a Docker Hub
access token (never the account password); and two GitHub repository secrets, `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` (*Settings → Secrets and variables → Actions*). Without **both**, the release
workflow fails in this repository, with a notice naming them — a fork, which has nothing to publish,
ends green instead and publishes nothing.

**A tag ruleset on `v*`.** Pushing a `vX.Y.Z` tag is the release trigger, so whoever may create such a
tag may publish `latest`. The workflow checks what it can — the tag is SemVer and its commit is on
`main` — but no workflow can gate the creation of its own trigger. That is a repository setting:

> *Settings → Rules → Rulesets → New ruleset → New tag ruleset* → name it (`release tags`), set
> **Enforcement status** to *Active*, under **Target tags** add the pattern `v*`, and tick
> **Restrict creations**. Leave the bypass list to the repository owner (and nothing else).

With it, a collaborator with write access can still merge to `main` but cannot cut a release.

**Optional, stronger: a `release` Environment with required reviewers.** *Settings → Environments →
New environment* named `release`, tick **Required reviewers** and add yourself. Adding
`environment: release` to the `release` job of `.github/workflows/release.yml` then pauses every
release run until a reviewer approves it, and lets the Docker Hub secrets live on that environment
rather than on the repository. It is **not** wired up today: with the tag ruleset above, the only
person who can trigger a release is the only person who could approve it, so the click buys nothing
until there is a second maintainer. That is the trigger for turning it on.

**The Docker Hub repository is public**, so the target device pulls anonymously and holds no registry
credential at all. CI proves that on every release: it logs out of `docker.io` before pulling back
the tags it just pushed. If that pull is refused, the error message says which of the two causes it
is — a Docker Hub rate limit (429, transient and shared between hosted runners,
re-run the job later) or a repository that is still private (*Docker Hub → kerdial/kerdial → Settings
→ Make public*).

---

## 3. Taking a copy of the database, and restoring one — by hand

Kerdial takes no scheduled backup. The simplest copy is the app's own export (the « Importer »
screen), which writes your data to two files that import back into an empty installation. What
follows is the other way: a manual copy of the whole database, and how to restore it.

### The dump

Two artifacts, and **"a copy" is the pair**, not either one: the globals carry the roles every policy
and grant in the data dump refers to.

```bash
cd deploy
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# Roles, without their passwords — the `migrate` step re-applies those from `.env`, and a dump that
# carried password hashes would be a credential in a file that gets copied around.
docker compose exec -T postgres \
  pg_dumpall --globals-only --no-role-passwords -U "$POSTGRES_SUPERUSER" > "globals-${TS}.sql"

# The data, custom format, WITHOUT the pgboss schema — that is queue state, the worker rebuilds it,
# and it is excluded deliberately (see `migrate-main.ts` for what depends on this).
docker compose exec -T postgres \
  pg_dump -Fc --exclude-schema=pgboss -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" > "data-${TS}.dump"
```

As the **superuser**, not as an application role: every tenant table is `FORCE ROW LEVEL SECURITY`,
`pg_dump` sets `row_security = off` for its own session, and Postgres then throws rather than write a
silently partial dump. `app_backup` — a login role with `BYPASSRLS` and nothing else — existed to make
that dump possible for a lesser identity; migration `0045` dropped it, so the superuser is the
only identity that can do this today.

Both files are **unencrypted** and hold every position and price in the database. Whatever you do with
them next — a second disk, a NAS share, cloud storage — that is the part the retired pipeline used to
do with `age` and `rclone`, and it is now yours to do deliberately.

### The restore

Order is fixed: **globals, then create the database, then `pg_restore`.** Ownership and grants *are*
the security model here, so `--no-owner`/`--no-privileges` is never acceptable — a restore that lands
every object owned by the restoring user, with policies referencing roles that do not exist, is not a
restore. The bootstrap superuser below is called `drill` on purpose: the globals contain
`CREATE ROLE postgres`, and a cluster whose own superuser is `postgres` collides with it.

```bash
docker run -d --name drill-pg -e POSTGRES_USER=drill -e POSTGRES_PASSWORD=drill \
  -p 55432:5432 postgres:17
until docker exec drill-pg pg_isready -U drill -q; do sleep 1; done

docker cp "globals-${TS}.sql" drill-pg:/tmp/globals.sql
docker cp "data-${TS}.dump"   drill-pg:/tmp/data.dump

docker exec drill-pg psql -U drill -d postgres -v ON_ERROR_STOP=1 -f /tmp/globals.sql
docker exec drill-pg psql -U drill -d postgres -c 'CREATE DATABASE kerdial'
docker exec drill-pg pg_restore --exit-on-error --dbname kerdial --username drill /tmp/data.dump
```

A restored database is missing exactly two things a fresh volume gets for free, and **both are the
`migrate` step's job** — do not provision either by hand:

- the role passwords, because the globals dump carries none; and
- the **`pgboss` schema**, because the data dump excludes it and no migration can put it back: the
  restored `drizzle.__drizzle_migrations` journal already marks migration `0031` applied, and
  drizzle's migrator compares against the *newest* journal row, so `0031` is skipped. Without this step the worker exits 1 with
  `schema "pgboss" does not exist` and `api` exits 1 with `pg-boss is not installed`, having never
  bound its port.

```bash
docker run --rm --network host \
  -e MIGRATE_DATABASE_URL='postgres://drill:drill@127.0.0.1:55432/kerdial' \
  -e APP_WEB_PASSWORD=drill-only -e APP_INGEST_PASSWORD=drill-only \
  docker.io/kerdial/kerdial:latest node /app/platform/db/dist/migrate-main.js
```

`pgboss schema CREATED, owned by app_ingest` is the line that says this really was a restored
database; `already present` means the artifact carried the schema, which is worth knowing before you
go further. Then start `worker` (wait for `/run/worker/ready`) and `api`, in that order — the same
chain compose orders — and log in once against the restored data. `docker rm -f drill-pg drill-worker
drill-api` when done, and delete the decrypted files.

### What to check survived the round trip

```bash
# Roles: app_owner/app_web/app_ingest exist and none of them is BYPASSRLS; app_admin_bypass is
# (it owns migration 0065's SECURITY DEFINER functions and cannot log in); app_backup is NOT back.
docker exec drill-pg psql -U drill -d kerdial -c \
  "select rolname, rolbypassrls, rolcanlogin from pg_roles
    where rolname like 'app\_%' order by 1"

# Every table in public owned by app_owner — zero exceptions.
docker exec drill-pg psql -U drill -d kerdial -c \
  "select r.rolname as owner, count(*) from pg_class c join pg_roles r on r.oid = c.relowner
    where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace group by 1"

# Grants, as the database itself computes them (AC47: app_ingest never writes a transaction).
docker exec drill-pg psql -U drill -d kerdial -c \
  "select has_table_privilege('app_web','transaction','select')      as web_reads_txn,
          has_table_privilege('app_web','transaction','insert')      as web_writes_txn,
          has_table_privilege('app_ingest','transaction','insert')   as ingest_writes_txn,
          has_table_privilege('app_ingest','fx_rate_daily','update') as ingest_upserts_fx"

# RLS still ENABLEd and FORCEd on every tenant table (the roles-and-rls suite's own rule).
docker exec drill-pg psql -U drill -d kerdial -c \
  "select count(*) from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and (not relrowsecurity or not relforcerowsecurity)"
```

Expected: exactly one `rolbypassrls` row — `app_admin_bypass`, with `rolcanlogin = f` — and none for
`app_owner`/`app_web`/`app_ingest`; every table owned by `app_owner`, `web_reads_txn`/`web_writes_txn`/
`ingest_upserts_fx` true, `ingest_writes_txn` **false**, and a zero count on the last query.

### Tear-down

```bash
docker rm -f -v drill-api drill-worker drill-pg
rm -f globals-*.sql data-*.dump      # plaintext copies of the whole database
```

Both artifacts are plaintext copies of every position and price in the database. Remove them the
moment you are done with them.

**On a Synology NAS**, run the same commands from the NAS shell; `docs/deploy-synology.md` covers
what is DSM-specific. To restore into the compose stack's own `postgres` rather than a scratch
container, follow step 4 of "Upgrading from 0.1.x (portfolio stack) to 0.2.0" above, which does
exactly that.

---

## 4. One data check worth running once per deployment

This is not a health check and nothing fails if you skip it. It answers a single question that
`GET /health` cannot, because it is about historical data rather than about the running system.

### Are any stored cost postings orphaned from their transaction's vocabulary?

Migration `0049` retired the fee FX leg's columns and deliberately does **not** re-derive
`transaction_posting`. A row whose cost was denominated in a *third* currency — neither the
transaction's nor the settling account's — therefore keeps a CASH posting whose currency no column of
its parent transaction names any more. The posting is correct and authoritative; what is lost is
the row's ability to explain it, so the transaction detail panel shows less than the cost basis and the «Frais» total do.

Such rows are expected to be rare or absent: most costs are in the transaction's own currency. A
deployment whose history includes third-currency costs may differ, which is the only reason this
query exists. (Since migration `0079` a withholding has no
currency of its own either: its `TAX` posting is in `cash_currency`, so the query no longer names
`withholding_currency`.)

```sql
SELECT p.tenant_id,
       p.portfolio_id,
       p.currency        AS posting_currency,
       t.txn_currency,
       t.id              AS transaction_id,
       t.trade_date
  FROM transaction_posting p
  JOIN "transaction" t ON t.id = p.transaction_id
 WHERE p.leg = 'CASH'
   AND p.flow_class IN ('FEE', 'TAX')
   AND trim(p.currency) NOT IN (
         coalesce(trim(t.txn_currency), ''),
         coalesce(trim(t.cash_currency), ''),
         coalesce(trim(t.target_currency), '')
       )
 ORDER BY t.trade_date;
```

**Expected result: zero rows.**

If it returns rows, the correct response is **to do nothing to the data.** Specifically, do not run a
posting regeneration over them: that would rewrite each cost to the settling account's currency at
the principal's rate, which is a real change of amount — that movement was measured and
pinned as a test. The posting records what actually moved; the row lost the column that named it.

What the rows do tell you is that for those transactions the detail panel and the cost figures will
describe the same cost differently, and that any support question about one of them should be
answered from the posting.

---

## 5. Slow hardware: `HTTP_TIMEOUT_MS`

Skip this section unless you have seen the symptom. It has exactly one:

> **Cette ligne n'a pas été traitée : le temps imparti à l'import était écoulé. Relancez l'import
> pour la reprendre.**

on many rows of a CSV import, usually on a NAS or another low-power host. Nothing is lost when it
happens — every row that landed stays landed, and re-running the same file imports exactly the
remainder — but needing three runs to import one file is not the intended experience.

**Why it happens.** One request may run for 30 s (`HTTP_TIMEOUT_MS`), and an import stops writing
5 s before that so it can still return a complete report of what it did rather than having the
socket closed under it. Those numbers were sized against a developer machine. A host several times
slower reaches the line partway through a large file.

**The fix is one variable.** In `.env`:

```dotenv
HTTP_TIMEOUT_MS=120000
```

then `docker compose up -d --wait`. The import's own deadline follows it automatically — it is
always 5 000 ms below this value — so there is nothing else to keep in sync.

| Variable | Default | Change it when |
| --- | --- | --- |
| `HTTP_TIMEOUT_MS` | `30000` | imports report rows as not processed. This is the only one you should normally need. |
| `IMPORT_APPLY_DEADLINE_MS` | `HTTP_TIMEOUT_MS` − 5000 | you want a long request timeout but a *short* import deadline. Must leave the 5 000 ms gap. |
| `IMPORT_APPLY_CHUNK_ROWS` | `50` | essentially never. It is how many rows share one write transaction; lowering it shortens how long a concurrent write to the same portfolio can be made to wait, at the cost of speed. |

Every one of them refuses to boot on a value out of range, naming itself in the message, rather than
running with a number you did not choose. A blank value is "unset", not zero.

**Raising it is not free, and the trade is worth stating.** The timeout is also the bound on how
long one slow or hostile request can occupy a connection, so a longer one means a saturated instance
recovers more slowly. On a self-hosted household instance that is a fair trade; it is the reason
the default is not simply large.

**If it still happens at 120 s**, the import is not merely slow — say so on an issue with the row
count and the container's log lines for the run, rather than raising the number again.

---

## 6. Memory ceilings: `mem_limit` and `NODE_OPTIONS`

You do not need to change these. This section exists so that if you do, you change them together.

The api and the worker services in `deploy/docker-compose.yml` each carry two ceilings:

| Service | `mem_limit` (the container's cgroup: past it, the kernel kills the process) | `NODE_OPTIONS=--max-old-space-size=…` (V8's heap: past it, Node exits with a JS heap out-of-memory error) |
| --- | --- | --- |
| api | `768m` | `512` |
| worker | `512m` | `384` |

**The gap between them is the whole point.** The heap cap is lower, so the process runs out of
*JavaScript* memory first and exits cleanly — `restart: unless-stopped` brings it back, and the log
carries a stack saying what it was doing. Without the gap, the cgroup kills it instead, and on a NAS
the OOM killer does not always choose the container you expected; it frequently chooses postgres.

**Where the api's 768 and 512 come from** (measured, not rounded):

- **84,7 MiB** — the api's idle resident memory, measured with `docker stats --no-stream` on a live
  stack, 2026-09-25.
- **+96–160 MiB** — one import at the 32 MiB file ceiling. The request holds the uploaded file, the
  object graph parsed from it and the validated copy built from that, so peak is roughly three to
  five times the file. At most **one** of these exists at a time: the two Kerdial import routes are
  capped at one concurrent request, and a second gets `429` with `Retry-After` rather than a second
  allocation.
- **+~100 MiB per large catalogue export**, which holds up to 32 MiB of icon data in three
  representations at once. At most **two** exports run at a time, across both export routes; a
  third gets `429` with `Retry-After`.
- **+ a few MiB each** for ordinary requests.

That is ~445 MiB in the worst case (an import and two exports, all at their ceilings at once; ~345
with one export), under the 512 MiB heap. `mem_limit` sits 256 MiB above the heap for the upload and
download buffers, which are *not* JavaScript heap: with both caps, at most 96 MiB of them exist at
once.

**Where the worker's 512 and 384 come from:** its node process measured 147 MiB resident with a
**168 MiB high-water mark** over five days of daily jobs and a weekly gap repair (`VmHWM`,
2026-10-12). It handles no uploads, so the 128 MiB above its heap is ample.

**If you change them:** lower `--max-old-space-size` first on a memory-tight box, and keep
`mem_limit` strictly above it. Both are plain settings in the compose file, not `.env` variables —
edit them there and `docker compose up -d --wait`.

**The two ways an out-of-memory looks**, and what each tells you:

- **A heap out-of-memory — the designed failure.** The container restarts by itself during or just
  after an import, an export or a job, and `docker compose logs api` (or `worker`) shows `JavaScript
  heap out of memory` with a stack. The ceilings worked: the work in flight was larger than this box
  was sized for. Lower the load or raise both numbers together.
- **A cgroup kill — the ceilings were crossed in the wrong order.** The container disappears with
  **no** such message, and `docker inspect <container> --format '{{.State.OOMKilled}} {{.State.ExitCode}}'`
  prints `true 137`. Memory outside the JavaScript heap (upload and download buffers) reached
  `mem_limit` before the heap reached its cap: the gap is too small for what was in flight, or
  something else on the host is competing for memory. Widen the gap — raise `mem_limit`, or lower
  `--max-old-space-size` — rather than raising both.

---

Requirements behind this page: FR-44–FR-46 and AC-36 (the behavioural acceptance criterion),
FR-34–FR-37/AC-30/AC-31 (image publishing), ADR-0014 (why phase 1 is self-hosted at all) and
ADR-0016 (which retired the proxy-trust control §1 replaced).
