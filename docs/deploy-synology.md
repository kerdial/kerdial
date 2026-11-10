# Deploying on a Synology NAS

The companion to `docs/deploy-runbook.md`: that page is the bring-up and exposure procedure for _any_
host, this one is what is specific to DSM. Read both. Nothing here changes the stack — the compose
file is deployed unchanged (that was a design constraint, `deploy/docker-compose.yml` header), and
every check in the runbook applies verbatim.

> **A NAS already running 0.1.x (or 0.0.x)** must not just pull 0.2.0: the stack was renamed from
> `portfolio` to `kerdial`, and the new compose file starts on a new, empty database volume. Follow the
> runbook's
> [Upgrading from 0.1.x (portfolio stack) to 0.2.0](deploy-runbook.md#upgrading-from-01x-portfolio-stack-to-020)
> in the stack folder, `/volume1/docker/kerdial` (§1), after one `sudo -i` — a root shell, so the
> `docker` calls inside `$( … )` and the dump files written into the stack folder need no `sudo` of
> their own. §4's "Upgrading" bullet is for upgrades from 0.2.0 on.

## 0. What the NAS must have

| Requirement                                                                                                                  | Why                                                                                                                                                                                                 | How to check                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **x86-64 CPU** (Intel/AMD — the "+" models: DS224+, DS423+, DS923+, DS1522+, DS920+, DS720+, DS220+ …)                       | the image is published `linux/amd64` **only** (runbook §2). On a Realtek/ARM model (`j`, `play`, most non-plus models) it does not start                                                            | `uname -m` over SSH → must print `x86_64`                           |
| **DSM 7.2 or later** with the **Container Manager** package installed                                                        | that is where Docker Engine and `docker compose` v2 come from                                                                                                                                       | Package Center → Installed                                          |
| **≥ 4 GB RAM** recommended                                                                                                   | `postgres` + `api` + `worker` idle around 1 GB; the worker's history backfills spike above that. 2 GB works but swaps                                                                                | Control Panel → Info Center                                         |
| **SSH enabled**                                                                                                              | the procedure runs `docker compose` from a shell — the Container Manager GUI cannot run `--wait`, and its Project screen does not reliably read `.env`                                              | Control Panel → Terminal & SNMP → Enable SSH service                |
| **Outbound HTTPS** from containers                                                                                           | `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` (image), ECB (`www.ecb.europa.eu`, `data-api.ecb.europa.eu`), Yahoo (market data)                                                                                                                                              | if the DSM firewall is on, outbound is allowed by default           |

Docker on DSM runs as root and your DSM account is not in a `docker` group, so every `docker` command
below is `sudo docker …`. `sudo -i` once at the start is fine.

## 1. Files on the NAS

Container Manager creates a `docker` shared folder on install; the stack lives in a subfolder of it.
Only two files are needed — the compose file and the filled-in `.env` — both copied from `deploy/`:

```bash
sudo -i
mkdir -p /volume1/docker/kerdial && cd /volume1/docker/kerdial
# copy deploy/docker-compose.yml and deploy/.env.example here (scp from your machine, or File Station upload)
cp .env.example .env && chmod 600 .env
vi .env
```

Fill `.env` exactly as `.env.example` says, with these NAS-specific values (runbook §1 is the
three-row table this is one row of — "a reverse proxy on another machine"):

| Variable                                                                          | Value on the NAS                                    | Note                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_IMAGE`                                                                       | `docker.io/kerdial/kerdial:<X.Y.Z>`         | **pin** a release version (runbook §2); the Docker Hub repository is public, so the NAS pulls anonymously. `latest` also works, but moves with every release                                                                       |
| `POSTGRES_SUPERUSER_PASSWORD`, `APP_WEB_PASSWORD`, `APP_INGEST_PASSWORD`, `CSRF_SECRET` | fresh `openssl rand -hex 24` each                   | a fresh volume gets a fresh superuser password; `migrate` applies the two app passwords on every run                                                                                                                                                       |
| `API_BIND`                                                                        | `0.0.0.0`                                           | the proxy is on **another** machine, so the port must be LAN-reachable. `127.0.0.1` (the default) reads as "no port mapping" from the LAN                                                                                                                  |
| `TRUST_PROXY`                                                                     | the nginx machine's LAN address, e.g. `192.168.1.12` | **one** address, never `true` and never a broad CIDR; give that machine a fixed address (DHCP reservation). This is what makes the per-IP login throttle see the real client instead of nginx                                                             |
| `API_PORT`                                                                        | `3000`                                              | free on a stock DSM (DSM itself is 5000/5001). Any other free port works — then use it in nginx's upstream                                                                                                                                                  |
| `COOKIE_SECURE`                                                                   | leave it (`true`)                                   | TLS terminates at nginx, so the `Secure` cookies are right. `false` is only for a LAN-only plain-http instance, which this is not                                                                                                                           |
| `SETUP_TOKEN`                                                                     | leave it blank                                      | the api prints a token in its log at each start while the instance is unclaimed (§2). Set one only to claim from a script                                                                                                                                  |
| `HTTP_TIMEOUT_MS`                                                                 | `120000`                                            | **set it on a NAS.** The 30 s default was sized on a developer machine; a NAS is slow enough that a large CSV import hits it and reports rows as _« Cette ligne n'a pas été traitée »_. Raising it raises the import's own deadline with it — runbook §5 |

No `PROXY_TOPOLOGY` and no `PROXY_ADDRESS`: those variables no longer exist. An
`.env` that still carries them is harmless — the app does not read them — but tidy it.

Two DSM consequences of publishing on `0.0.0.0`:

- **The DSM firewall does not filter Docker's published ports** — Docker inserts its rules in the
  `DOCKER` chain, consulted before the `INPUT` chain DSM's GUI manages. A DSM firewall rule "deny 3000"
  does nothing. Defence in depth, if wanted, is an iptables `DOCKER-USER` rule restricting `3000` to
  the nginx machine, added by a boot-time Task Scheduler script (root) — and it is never the control
  (runbook §1, rule 3).
- **Anything on the LAN can read `/health` and the SPA shell** at `http://<nas>:3000`. That is by
  design (runbook §1, "two things that look like bugs"): every `/api/v1` route still 401s, `postgres`
  is not published, and a browser cannot log in over plain HTTP while `COOKIE_SECURE` is `true`.

The database lives in the **named volume** `kerdial_pgdata`, which DSM stores under
`/volume1/@docker/volumes/`. Do not replace it with a bind-mount to a shared folder: DSM owns the
uid/gid of every share it creates and the `postgres` container cannot write there — the reason the
compose file uses a named volume in the first place. Back the volume up by dumping the database
(runbook §3), not by copying that directory.

## 2. Bring-up — fresh (no data to carry over), then claim it

```bash
cd /volume1/docker/kerdial
docker compose up -d --wait          # 0 only when postgres → migrate → worker → api all came up
docker compose ps                    # api/worker/postgres healthy, migrate Exited (0)
docker compose logs api | grep 'trust proxy'   # trust proxy: "<nginx address>" — X-Forwarded-For is honoured from that hop/peer
curl -s http://127.0.0.1:3000/health           # {"status":"ok","db":"ok",…}
```

The first `up` pulls ~ 400 MB (`postgres:17` + the app image) and the `migrate` step then applies
every migration on an empty volume — allow a few minutes on a NAS. `--wait` blocks until the whole
chain is healthy; if it exits non-zero, `docker compose logs migrate` is the place to look, and `api`
was deliberately never started (runbook §0).

**Claim the instance now.** With `API_BIND=0.0.0.0` the origin is LAN-reachable the moment `api` is
healthy, and `POST /auth/setup` is public by construction until the first account exists. What
protects the claim in that window is the one-time setup token, so read it and use it straight away:

```bash
docker compose logs api | grep 'setup token' | tail -1
# first-run setup token (required by POST /auth/setup): <43 characters>
```

Then open the app — through nginx once §3 is in place, or `http://<nas>:3000` from a browser on the
LAN with `COOKIE_SECURE=false` set _for that one step only_ — and fill « Créer le compte
administrateur »: e-mail, mot de passe, devise de base (asked once, for the whole household),
and the token. `tail -1` matters: every api start while unclaimed prints a fresh
token and only the last one is valid. Confirm it took:

```bash
curl -s http://127.0.0.1:3000/api/v1/auth/setup | grep -o '"needsSetup":[a-z]*'   # "needsSetup":false
```

The scripted fallback — set `SETUP_TOKEN` in `.env` instead of reading it from the log — is the same
public endpoint the setup screen calls (runbook §0):

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…","baseCurrency":"EUR","setupToken":"'"$SETUP_TOKEN"'"}'
```

Further household members are created from « Utilisateurs » in the app, in the same tenant, with no
currency to choose. There is no scripted lock-out recovery for the sole instance admin — the only
route left is a manual `UPDATE app_user SET password_hash = …` as the Postgres superuser.

If you are **moving** an existing deployment's database onto the NAS instead of starting fresh,
adapt the runbook's §3 dump/restore procedure — restore into this compose stack's own `postgres`
service before running `migrate`, rather than into a scratch database.

## 3. Exposure: nginx on the other machine

The session and CSRF cookies are `Secure` (`COOKIE_SECURE=true`), so **the app is used over HTTPS
through nginx**; a browser at `http://<nas>:3000` cannot log in (runbook §1). TLS, the certificate
and the hostname are the nginx machine's business; this repository ships nothing for that.

**What nginx must do:**

1. connect to the NAS from the address written in `TRUST_PROXY` — a fixed one;
2. **append** `X-Forwarded-For` (never replace it) and be **exactly one** hop between the browser and
   the api — no CDN, no tunnel, no second proxy in front (a second hop means the trusted peer is no
   longer adjacent to the client, and `TRUST_PROXY` would then have to name a hop count instead);
3. pass `Host`, and send `X-Forwarded-Proto https` so the app knows the outer scheme.

One upstream block:

```nginx
location / {
    proxy_pass         http://<nas LAN IP>:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Real-IP         $remote_addr;
}
```

Caddy does all three by default (`reverse_proxy <nas LAN IP>:3000`); Traefik too, with its default
`forwardedHeaders` behaviour.

**Verify — three checks:**

1. **The trust line**: `docker compose logs api | grep 'trust proxy'` reads
   `trust proxy: "<nginx address>"`. `none` means `TRUST_PROXY` is blank in `.env`.
2. **Login works at `https://<host>`** and stays logged in across a page reload (the `Secure`
   cookies were set and sent — if the page keeps returning to « Connexion », nginx is not terminating
   TLS on the origin the browser sees).
3. **The throttle sees the client, not nginx.** From a phone or a second machine, submit one wrong
   password at `https://<host>`; then on the NAS:

   ```bash
   docker compose exec -T postgres psql -U postgres -d kerdial -Atc \
     "select ip, attempted_at from login_attempt order by attempted_at desc limit 1"
   ```

   The `ip` must be that device's address (on the LAN: its LAN address; from outside: its public
   one) — **not** the nginx machine's. If it is nginx's, `X-Forwarded-For` is not being sent, or
   `TRUST_PROXY` names the wrong machine, and every client would share one backoff bucket — and
   one sign-in concurrency bucket of 2 (runbook §1).

**If nginx ever moves onto the NAS itself** (DSM's built-in reverse proxy, Control Panel → Login
Portal → Advanced → Reverse Proxy, destination `localhost:3000`): `API_BIND=127.0.0.1`,
`TRUST_PROXY=1`, `docker compose up -d --wait` — runbook §1's first row.

## 4. Operating it on DSM

- **Reboots.** Container Manager starts Docker at boot and every service is `restart: unless-stopped`,
  so the stack comes back on its own, in the compose order. DSM's scheduled power-off/on (Control Panel
  → Hardware & Power → Power Schedule) is fine; a scheduled job has no catch-up for a slot missed while
  powered off, so avoid powering off at the hour the daily market-data jobs run.
- **Upgrading.** From 0.1.x to 0.2.0, use the runbook's
  [Upgrading from 0.1.x (portfolio stack) to 0.2.0](deploy-runbook.md#upgrading-from-01x-portfolio-stack-to-020) instead — the stack rename moves the database to a new volume. From 0.2.0 on: edit
  `APP_IMAGE` in `.env` to the new version, then
  `docker compose pull && docker compose up -d --wait`. `migrate` re-runs (idempotent) and the chain
  re-orders itself. Never `docker compose down -v` for an upgrade — that is the re-initialise-from-
  scratch command (runbook §0) and **destroys the database**.
- **Container Manager's GUI** shows the four containers under _Container_ and the image under _Image_;
  it does **not** list a CLI-created stack under _Project_, and stopping/starting containers from the
  GUI ignores the compose dependency chain. Use the shell for lifecycle operations.
- **DSM package updates** that restart Container Manager restart the containers too — expect the
  worker's 25 s drain then a clean come-back; nothing to do.
- **Memory.** The `api` service carries a `mem_limit` of 768 MB and the `worker` one of 512 MB, each
  with a matching V8 heap cap, sized so that an oversized import, export or job ends as a clean
  restart of that one container instead of the NAS's OOM killer choosing a victim — which on a 4 GB
  box is usually `postgres`. The numbers and the
  rule for changing them (keep `mem_limit` strictly above the heap cap) are in runbook §6. Nothing to
  configure; this is here so a restart of `api` during an import reads as designed behaviour rather
  than as a fault.
- **Copies of the database**: runbook §3's dump, on the NAS shell, into a folder that Hyper Backup
  or a second disk then picks up. Not the `@docker/volumes` directory.
- **Logs**: `docker compose logs -f api worker`. The JSON log driver is Docker's default with no
  rotation configured — add `"log-opts": {"max-size": "20m", "max-file": "5"}` to Container Manager's
  Docker daemon settings (`/var/packages/ContainerManager/etc/dockerd.json`, then restart the package)
  if the NAS volume is small.
