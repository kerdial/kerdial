# Connecting an AI assistant (MCP, read-only)

Kerdial can let an AI assistant such as Claude Code or Claude Desktop **read** your portfolios, so you
can ask it questions about your holdings, returns, transactions or dividends. It works through two
pieces:

- a **personal access token** that you create in Kerdial — a read-only key to your portfolio data;
- a small **MCP server** (`mcp/` in this repository) that runs on your own computer, next to the
  assistant, and calls your Kerdial instance with that token. MCP (Model Context Protocol) is the
  standard way these assistants plug in tools.

This is not a chat built into Kerdial, not a hosted service, and not a way to change anything: the token
and the server can only read. Kerdial itself never calls an AI provider.

## Before you start: privacy, and what you are agreeing to

**Nothing is exposed until you create a token.** A fresh instance answers every token with `401`; the
feature is off until you create the first token, and off again once every token is revoked or expired.

**Everything the assistant reads leaves your instance.** Kerdial is self-hosted so that your data stays
on your machine. Once you connect an assistant, every answer a tool returns — portfolio names, broker
names and descriptions, holdings, quantities, amounts, prices, returns, transactions, dividends, cash
balances, your watchlist — is handed to the assistant, which sends it to the AI provider behind it (for
Claude, Anthropic) as part of the conversation. What the provider does with it is governed by **that
provider's terms and data policy**, not by Kerdial. Read them before you connect, and check the
settings of your plan (for example whether conversations may be used for training or how long they are
kept).

**Revoking a token stops future access. It cannot recall data already sent.**

**What a token can read.** All the portfolio data of the household on this instance — including the
portfolios of the other members who share it, not only your own — through a fixed list of 18 read
endpoints (see [What a token can and cannot reach](#what-a-token-can-and-cannot-reach)).

**What a token cannot do.** It cannot create, change or delete anything. It cannot export your data,
import a file, reach the administration screens, read or change account settings, or create or revoke
tokens. A token created by the instance administrator has no administrator rights.

**Notes and references are withheld by default — by the MCP server, not by Kerdial.** The free-text
note and reference of a transaction, and the note of a watchlist row, are removed by the MCP server
before the assistant sees them, unless you start it with `KERDIAL_MCP_INCLUDE_NOTES=1`. This is a
convenience of the server you run, not a limit of the token: anyone holding the token can call the
Kerdial API directly and read the notes.

**Kerdial provides no investment advice.** The tools return facts recorded in your instance — amounts
exactly as Kerdial stores them, with their currency. Any analysis, summary or opinion is the
assistant's own, and a language model can be wrong: misread a figure, add up amounts in different
currencies, or state something with confidence that the data does not support. Check what matters
against the Kerdial screens.

**Do not mix it with tools that can send data elsewhere.** Portfolio names, descriptions and notes are
text you or a data provider wrote; the assistant reads them as data, but a crafted text could try to
steer it. If the same assistant session also has tools that can send email, post to the web or write
files elsewhere, that text could be used to push your data out through them. Keep the Kerdial server in
sessions without such tools, or approve each of their actions yourself.

## Step 1: create a token

1. In Kerdial, open « Mon compte » and find the card « Accès pour assistants IA ».
2. Click « Créer un jeton ».
3. Fill in:
   - « Nom du jeton » — a name that says where the token will live, e.g. "Claude Desktop – laptop"
     (1 to 60 characters);
   - « Expiration » — 30 days, 90 days (the default), 180 days, 1 year, or « Jamais » (never: the token
     stays valid until you revoke it);
   - « Mot de passe actuel » — your current password, to confirm it is you;
   - tick the box acknowledging that the data will be sent to the assistant's provider.
4. Click « Créer le jeton ». The token is shown **once**: it starts with `kdl_pat_` and is 83 characters
   long. Copy it now (« Copier », or select it and copy by hand if your browser refuses — this happens
   on a plain `http://` address). After « Fermer » it cannot be shown again; if you lose it, revoke it
   and create a new one.

The card lists your tokens with their creation date, expiry, last use and state (« Actif »,
« Expiré », « Révoqué »). You can have at most 10 active tokens; each member of the household manages
their own.

## Step 2: build the MCP server

The server is not published to npm and is not part of the Docker image: you build it from a checkout of
this repository, on the computer where the assistant runs. You need Node.js 22 and pnpm 9.

```bash
git clone https://github.com/kerdial/kerdial.git
cd kerdial
pnpm install
pnpm --filter "@kerdial/mcp..." build
```

The server is now `mcp/dist/main.js`. The assistant starts it with `node` and the **absolute** path to
that file, e.g. `node /home/you/kerdial/mcp/dist/main.js` (on Windows,
`node C:\Users\you\kerdial\mcp\dist\main.js`). After a `git pull`, run the two `pnpm` commands again.

It is configured through environment variables only:

| Variable                          | Required | Meaning                                                                                                                                                                                                                                              |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KERDIAL_URL`                     | yes      | The address you open Kerdial at, e.g. `https://kerdial.example` (a path prefix such as `https://example.net/kerdial` is kept). No user name, password, query string or fragment. Can also be given as `--url <url>` on the command line, which wins. |
| `KERDIAL_TOKEN`                   | yes      | The token from step 1. Environment only: the server refuses a `--token` argument, because command lines show in process listings.                                                                                                                    |
| `KERDIAL_MCP_ALLOW_INSECURE_HTTP` | no       | `1` allows `http://` to a host other than `localhost`, `127.x.x.x` or `[::1]`. Without it such a URL is refused, because the token would cross the network unencrypted.                                                                             |
| `KERDIAL_MCP_INCLUDE_NOTES`       | no       | `1` passes transaction notes and references, and watchlist notes, to the assistant. Default: withheld.                                                                                                                                               |
| `KERDIAL_MCP_TIMEOUT_MS`          | no       | Timeout of each request to Kerdial, in milliseconds, 1000 to 120000. Default 35000.                                                                                                                                                                  |
| `KERDIAL_MCP_DEBUG`               | no       | `1` writes one line per request to the server's error output: method, path without its query, status, duration. Never the token.                                                                                                                     |

The flags take `1` or `0`; anything else is refused. If a setting is wrong, the server writes one line
naming the variable and the rule (never its value) to its error output and exits with code 2; the
assistant then shows the server as failed.

## Step 3: configure your assistant

The examples use `https://kerdial.example` and a placeholder token: put your own address, your own
token, and the absolute path of your checkout.

### Claude Code

Register the server once, for your user (available in all your projects, and kept out of any project
directory):

```bash
read -rs KERDIAL_TOKEN   # paste the token, press Enter; nothing is echoed or kept in shell history
claude mcp add kerdial --scope user \
  -e KERDIAL_URL=https://kerdial.example \
  -e KERDIAL_TOKEN="$KERDIAL_TOKEN" \
  -- node /home/you/kerdial/mcp/dist/main.js
unset KERDIAL_TOKEN
```

The name (`kerdial`) comes before the `-e` options, and `--` separates Claude Code's options from the
command it runs. The token is stored **in plain text** in your Claude Code user configuration (the
command prints which file it modified). Check the result with `claude mcp get kerdial`, and remove it
with `claude mcp remove kerdial --scope user`.

**Alternative: a project `.mcp.json` without the token in it.** Claude Code expands `${VAR}` (and
`${VAR:-default}`) in the `command`, `args` and `env` of a server in an MCP configuration file, so a
`.mcp.json` at the root of a project can name the variable instead of holding the secret:

```json
{
  "mcpServers": {
    "kerdial": {
      "command": "node",
      "args": ["/home/you/kerdial/mcp/dist/main.js"],
      "env": {
        "KERDIAL_URL": "https://kerdial.example",
        "KERDIAL_TOKEN": "${KERDIAL_TOKEN}"
      }
    }
  }
}
```

`KERDIAL_TOKEN` must then be set in the environment you start Claude Code from; if it is missing, Claude
Code warns about the missing variable. Claude Code asks you to approve a server it finds in a project
`.mcp.json` before connecting to it. Never put the token itself in a `.mcp.json`: that file is meant to
be shared and committed.

This was checked against Claude Code 2.1. If your version behaves differently, see
[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Claude Desktop

Claude Desktop reads `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add a `kerdial` entry under `mcpServers` (create the file if it does not exist, or merge into its
existing `mcpServers`):

```json
{
  "mcpServers": {
    "kerdial": {
      "command": "node",
      "args": ["/Users/you/kerdial/mcp/dist/main.js"],
      "env": {
        "KERDIAL_URL": "https://kerdial.example",
        "KERDIAL_TOKEN": "kdl_pat_PASTE_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

On Windows the path is written with doubled backslashes, e.g.
`"C:\\Users\\you\\kerdial\\mcp\\dist\\main.js"`. Put the token value inline: we have not confirmed that
Claude Desktop expands `${VAR}` references in this file, so do not rely on it. This file then holds the
token in plain text — see [Keeping the token safe](#keeping-the-token-safe). Quit Claude Desktop fully
and reopen it so it reads the file again. If `node` is not found, give its absolute path as `command`.
For anything else about this file, check Claude Desktop's own documentation.

### Other MCP clients

Any client that can start a local (stdio) MCP server works: it runs
`node /absolute/path/to/kerdial/mcp/dist/main.js` with `KERDIAL_URL` and `KERDIAL_TOKEN` in the
server's environment. Check your client's documentation for where that goes.

## What the assistant gets: tools

Eight tools, all read-only. Every amount is a decimal string next to its currency code, relayed from
Kerdial unchanged: the server does not round, convert, add up or average anything. Dates are
`YYYY-MM-DD`; ids are the ones `list_portfolios` and the other tools return. Leaving out `portfolioId`
means all portfolios together.

| Tool               | Inputs (all optional unless marked)                                                                                                                                                  | Returns                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_portfolios`  | none                                                                                                                                                                                 | Every portfolio: id, name, broker, description, archived flag, transaction count, creation time. Archived portfolios are included.                                                                                                                                      |
| `get_holdings`     | `portfolioId`                                                                                                                                                                        | Current positions (quantity, cost basis, price, value, unrealised gain), the cash block and the total value, as of today.                                                                                                                                               |
| `get_performance`  | `portfolioId`, `from`, `to`                                                                                                                                                          | Time-weighted and money-weighted returns over the window, and the daily value series (value and net contributions). Without dates, the last year. For all portfolios, also the current total value and cash.                                                            |
| `get_allocation`   | `by` (**required**: `instrument`, `currency`, `kind`, `sector` or `country`), `portfolioId`                                                                                         | The current value split into buckets: each bucket's value and its share of the total (two decimals, summing to 100.00 when the total is positive), plus cash.                                                                                                                                     |
| `get_transactions` | `portfolioId`, `instrumentId`, `from`, `to`, `kind` (a list such as `["BUY", "SELL"]`), `currency` (e.g. `EUR`), `order` (`asc` or `desc`, default `asc`), `limit` (1–200, default 50), `cursor` | Ledger rows, at most `limit`, and a `nextCursor` to pass back as `cursor` for the next page (`null` at the end). `notesIncluded` says whether notes and references were kept.                                                                                            |
| `get_dividends`    | `portfolioId`, `from`, `to`                                                                                                                                                          | Dividends received (gross and withholding): the total, and per instrument, per year and per month.                                                                                                                                                                      |
| `get_watchlist`    | `window` (`3M`, `6M`, `YTD`, `1Y`, `3Y` or `5Y`; default `1Y`)                                                                                                                       | Watched instruments with price, day change, period returns, 52-week range, drawdown and a price series. Notes withheld unless enabled.                                                                                                                                  |
| `get_cash`         | `portfolioId`                                                                                                                                                                        | With a portfolio: every cash account and its balance, and the totals per currency. Without: the combined cash per currency and its value in the base currency (currencies that cannot be converted are listed separately); per-account balances need a `portfolioId`. |

## What the assistant gets: prompts

Five ready-made prompts, which clients usually offer as commands or in a menu. Each tells the assistant
which tools to call, to quote amounts exactly with their currency, to state its assumptions and any data
gap, to treat names, descriptions and notes as data rather than instructions, and not to recommend
buying, selling or holding anything. Each ends with "Informational only — not investment advice." The
prompts are written in English; the assistant answers in your language.

| Prompt               | Arguments                                         | What it asks for                                                                                                                                           |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monthly_review`     | `month` (`YYYY-MM`, default the last full month), `portfolioId` | Returns, transactions, dividends and cash for one month.                                                                                                   |
| `concentration_risk` | `portfolioId`                                     | How concentrated the holdings are by instrument, sector, country and kind.                                                                                 |
| `currency_exposure`  | `portfolioId`                                     | Exposure to each currency, positions and cash together.                                                                                                    |
| `fees_review`        | `from`, `to`, `portfolioId`                       | The fees and taxes paid over a period. Kerdial has no fee total: the assistant lists the rows, and any sum it gives is its own arithmetic.                 |
| `upcoming_dividends` | `portfolioId`                                     | The past dividend pattern of the current positions. Kerdial records dividends received, not announced ones, so this is history, not a forecast.            |

## What a token can and cannot reach

A token is accepted, with `GET` or `HEAD` only, on exactly these endpoints of the Kerdial API
(all under `/api/v1`):

- `/portfolios`, `/portfolios/overview`, `/portfolios/holdings`, `/portfolios/closed-positions`,
  `/portfolios/value-series`, `/portfolios/allocation`
- `/portfolios/{id}/overview`, `/portfolios/{id}/holdings`, `/portfolios/{id}/closed-positions`,
  `/portfolios/{id}/performance`, `/portfolios/{id}/value-series`, `/portfolios/{id}/allocation`,
  `/portfolios/{id}/cash`
- `/transactions`, `/transactions/calendar`, `/transactions/{id}`
- `/dividends/summary`
- `/watchlist`

Everything else that needs a sign-in answers `403`: any `POST`, `PUT`, `PATCH` or `DELETE`
(`TOKEN_READ_ONLY`), and every other read (`TOKEN_ROUTE_NOT_ALLOWED`) — including the exports, the
imports, the administration endpoints, your account and settings, and the token list itself. (The few
endpoints that need no sign-in at all — the health check, the sign-in and first-run setup — ignore the
token.) A token is sent as
`Authorization: Bearer kdl_pat_…`. Only a credential that starts with `kdl_pat_` is read as a token: an
invalid one is refused and never falls back to a browser session, while any other `Authorization`
header — a reverse proxy's own `Basic` or `Bearer` sign-in, for instance — is ignored, and the browser
session decides as usual.

`/portfolios/allocation?by=` and `/portfolios/{id}/allocation?by=` are new with this feature, and also
readable with a normal signed-in session. `by` is required (`instrument`, `currency`, `kind`, `sector`
or `country`).

## Revoking, and what revokes a token for you

- **Revoke** a token from the « Accès pour assistants IA » card (« Révoquer », then confirm). The next
  request with it gets `401`. Revoke at once a token that may have been exposed — a lost or shared
  laptop, a configuration file that was copied or committed.
- **Changing your password revokes all your tokens**, and so does an administrator resetting it. The
  assistants that used them stop working until you create new tokens. Signing out does not revoke
  tokens.
- A token **expires** at the end of the period you chose; it then behaves exactly like a revoked one.
  It is not renewed: create a new one and replace it in the assistant's configuration.

## Keeping the token safe

Treat a token like a password to your whole household's portfolio data.

- **One token per assistant and per computer**, named after it. Then you can see which one was used
  last and revoke one without breaking the others.
- **Choose the shortest expiry you can live with.** 90 days is the default; « Jamais » is possible but
  then only revoking ends it.
- **The token sits in plain text** in the assistant's configuration: your Claude Code user
  configuration, Claude Desktop's `claude_desktop_config.json`, or your shell environment if you use the
  `${KERDIAL_TOKEN}` form. Make those files readable by you only (`chmod 600` on macOS and Linux), and
  keep them out of shared folders and backups you do not control.
- **Never commit it** — not in a `.mcp.json`, a dotfiles repository or a script. If it happens, revoke the
  token; deleting the commit is not enough.
- Prefer `https://`. Over plain `http://` on your network the token travels unencrypted; the server
  refuses that unless you set `KERDIAL_MCP_ALLOW_INSECURE_HTTP=1`.
- **Self-signed certificate?** Give Node.js your certificate authority with `NODE_EXTRA_CA_CERTS`
  (the path to a PEM file) in the server's `env`. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`: it turns
  off certificate checking entirely, so anything on the path could read the token.

## Troubleshooting

When a tool fails, it returns one of the messages below to the assistant (never the token, never a
request path). Ask the assistant to show you the tool's error text.

| Message, or symptom                                                                                         | What it means and what to do                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The Kerdial access token is invalid, expired or revoked. …" (`401`)                                         | The token was mistyped, has expired, was revoked, or every token was revoked by a password change. Kerdial gives the same answer in each case on purpose. Check its state on the card; create a new token and update the configuration.                                                                                                                                              |
| "This access token cannot do that: it is read-only and limited to portfolio reads." (`403`)                  | The request reached an endpoint a token may not use. The eight tools only call allowed endpoints, so this most likely means the MCP server and your Kerdial instance come from different versions: update the checkout to match your instance.                                                                                                                                                                  |
| "No such portfolio or resource (…)." (`404`)                                                                 | The id does not exist on this instance (or was deleted). Call `list_portfolios` for the current ids.                                                                                                                                                                                                                                                                                  |
| "Kerdial refused the request (HTTP 422 VALUATION_PRICE_UNAVAILABLE): …"                                     | A holding has no price on or before today, so its value — and the total — cannot be computed. Kerdial refuses the whole read rather than give a partial total; the message names the instrument and date. The same read fails in the Kerdial screens: price the instrument there. A missing exchange rate gives `VALUATION_FX_RATE_UNAVAILABLE` with the currency.                  |
| "Kerdial refused the request (HTTP 400 …): …"                                                                | An input Kerdial rejected, such as an unknown transaction kind or a date range it does not accept; the message names the field.                                                                                                                                                                                                                                                       |
| "Kerdial is rate-limiting this token (TOKEN_RATE_LIMITED); retry after N s." (`429`)                         | More than 60 requests in a minute with this token. The server already waited and retried once when the wait was 10 seconds or less. Wait, and ask for narrower questions; some tools make several requests (see [Limits](#limits)).                                                                                                                                                  |
| "Kerdial is rate-limiting this token (BEARER_AUTH_THROTTLED); retry after N s." (`429`) | Too many requests with an **invalid** token came from your address: after 30 failures in 10 minutes, every further invalid token from that address is refused this way until the oldest failure is 10 minutes old. A valid token is never refused by it, so the token your assistant sends is wrong: fix it, and the block lifts by itself. If your instance is behind a reverse proxy, read the next row. |
| `BEARER_AUTH_THROTTLED` after a single wrong token | If Kerdial runs behind a reverse proxy and `TRUST_PROXY` is not set, Kerdial sees every client as the proxy's single address, so other clients' failed attempts count against yours and your own mistake is answered `429` instead of `401`. Valid tokens keep working either way. Set `TRUST_PROXY` for your proxy as described in [the runbook](deploy-runbook.md#1-exposure-api_bind-and-trust_proxy) (on a Synology NAS, [deploy-synology.md](deploy-synology.md)). |
| "Kerdial at kerdial.example is unreachable or answered unexpectedly (…)."                                   | The server could not get a usable answer: Kerdial is down or unreachable from this computer (`network error`, `timed out`), `KERDIAL_URL` points at a page that redirects (`unexpected redirect; check KERDIAL_URL` — use the final address, usually with `https://`), or something other than Kerdial answered (`the response is not JSON`). A response over 4 MiB is also refused. |
| The assistant shows the server as failed, or it never appears                                               | The server refused its configuration and exited. Run `node /path/to/kerdial/mcp/dist/main.js` yourself with the same variables: it prints the reason, e.g. "KERDIAL_URL uses plain http:// to a non-loopback host; …" or "KERDIAL_TOKEN is not a Kerdial access token (kdl_pat_…)". With a valid configuration it waits silently for input; stop it with Ctrl+C.                     |

`KERDIAL_MCP_DEBUG=1` adds one line per request (method, path, status, duration) to the server's error
output; where that output appears depends on your client.

## Limits

- **60 requests per minute per token.** `get_performance` makes two requests, `get_transactions` up to
  two, `list_portfolios` up to five; the others one.
- **Page sizes.** `get_transactions` returns at most 200 rows per call (50 by default) — follow
  `nextCursor` for more. `list_portfolios` returns up to 500 portfolios and says `truncated: true` beyond.
  A single response from Kerdial larger than 4 MiB is refused: ask for a shorter period.
- **Today's figures.** Holdings, allocation and cash are as of today; there is no "as of" date input.
- **No forward dividend data.** Kerdial records dividends received, not announced or expected ones.
- **No fee total.** Kerdial lists fee-bearing transactions; it does not compute a total of fees for you.
- **Read-only, always.** There is no tool and no token that can record a transaction or change a
  setting.
