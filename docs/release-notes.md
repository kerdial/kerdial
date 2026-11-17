# Release notes

User-facing changes that someone running a Kerdial instance needs to know about: new behaviour, anything
that needs a decision or a manual step, and breaking changes. Each release on GitHub carries its section
from this file above the generated list of changes.

---

## v0.4.1

### Shorter exposure bars

On the dashboard's « Exposition » card, the « Pays » and « Secteur » bars no longer list every country or
sector. With more than six, the five largest are named and the rest is summed into « Autres »; with six
or fewer, all are named. Crypto-assets now show as their own « Crypto » segment there instead of counting
as « Non classé »: a sector or a country says nothing of them, so « Non classé » is now only what is
really left to classify. The percentages are unchanged, and each bar still adds up to the whole portfolio.

This is a display change only. The AI-assistant tools and the export are unchanged: `get_allocation`
still returns every sector and country, and still counts crypto-assets in `UNCLASSIFIED`.

No manual step.

## v0.4.0

### Sector and country weights for ETFs, funds and SCPI

An ETF or a fund is rarely in one sector or one country. You can now enter, by hand, how it splits: in the
instrument's « Modifier » dialog, « Pondérations par secteur » and « Pondérations par pays » take several
rows, each a sector or a country and a percentage. ETFs and funds take both; an SCPI takes countries only;
shares, crypto-assets and indices take none (a share keeps its single sector and domicile). Each weight is
above 0 and at most 100 with at most two decimals, a sector or country appears once, and the total is at
most 100. Whatever is left below 100 % stays « Non classé »: the weights are never scaled up to 100.
Countries are picked from a searchable list of country names in French, which « Pays du siège social »
now uses too.

The exposure breakdown by sector and by country splits a weighted instrument's value across its weights.
Cash now shows as its own « Liquidités » segment there, and a note says when some figures come from
weights you entered by hand. Weights are always yours: Kerdial does not fetch them from a data provider.
The instruments list and the instrument's page show the weights too.

A single sector on an ETF or a fund now counts as that sector at 100 %. The database migration applied
on upgrade converts the ETFs and funds that already had a sector accordingly: until now they counted as
« Non classé » in the breakdown by sector, and now they count in their sector. No manual step.

**AI assistants.** `get_allocation` with `by=sector` or `by=country` applies the same weights, and a
weighted holding counts in each of its buckets in `holdingCount`. The country `basis` gains a fifth
value, `WEIGHTED`, next to `DOMICILE`, `LISTING`, `MIXED` and `NONE`: a client that switches on `basis`
must handle it. `get_holdings` relays each position's `sectorWeights` and `countryWeights`. See
[docs/mcp.md](mcp.md).

**Export and import.** The catalogue export (JSON) carries the weights, as the optional keys
`sectorWeights` and `countryWeights` on an instrument; the format version does not change, and an ETF or
a fund is no longer exported with a `sectorCode`. A file exported by this version and imported into an
older version of Kerdial is imported except for each instrument that carries weights: that instrument
alone is rejected (`MALFORMED_VALUE`, « Unrecognized key »), together with its hand-entered prices, its
icon and its watchlist row, and the other instruments import normally. The details are in
[import-export-format.md](import-export-format.md).

## v0.3.0

### Read-only access for AI assistants

You can now let an AI assistant such as Claude Code or Claude Desktop read your portfolios and answer
questions about your holdings, returns, allocation, transactions, dividends, cash and watchlist. In
« Mon compte », the new card « Accès pour assistants IA » creates a personal access token (your current
password is asked; 90-day expiry by default, up to 10 active tokens each); a small MCP server, built from
this repository and run on your own computer, gives the assistant eight read-only tools and five
ready-made prompts. [docs/mcp.md](mcp.md) explains the set-up step by step.

It is off until you create a token. A token can only read portfolio data — all of the household's, not
only yours — and cannot change anything, export, import or reach the administration. Be aware that
whatever the assistant reads leaves your instance and is sent to the assistant's provider under its own
terms; revoking a token stops further access but cannot recall what was sent. Changing your password, or
an administrator resetting it, revokes all your tokens. Kerdial still gives no investment advice: the
tools return facts, and any analysis is the assistant's.

Each token is limited to 60 requests a minute, and failed token attempts are throttled per client
address; a valid token is never refused by that throttle. If your instance sits behind a reverse proxy,
set `TRUST_PROXY` as the [runbook](deploy-runbook.md#1-exposure-api_bind-and-trust_proxy) describes, or
every client shares the proxy's address and one client's failed attempts count against everyone's.
Only an `Authorization: Bearer` header carrying a Kerdial token (`kdl_pat_…`) is read as a token: a
proxy that forwards its own `Basic` or `Bearer` sign-in header keeps working with browser sessions as
before.

The API also gains a read endpoint, `GET /api/v1/portfolios/allocation?by=` (and
`/portfolios/{id}/allocation?by=`), which splits the current value by instrument, currency, kind, sector
or country, with shares that add up to exactly 100 %.

The database migration applied on upgrade adds the access-token table and changes nothing else. No
manual step.

## v0.2.1

### Cash balances match the bank to the cent

A cash balance is now the sum of movements each settled to the cent (to the currency's own precision,
rounding half up), as a broker settles them. Until now, a trade in a foreign currency settled in a euro
account was carried with all the decimals of `amount × rate`, and only the total was rounded, so after
many trades the balance could drift a few cents away from the bank statement. Quantities, prices and rates
keep their full precision; only the cash movement is rounded. Your transactions are not modified.

The database migration applied on upgrade re-rounds the cash movements already recorded and rebuilds the
balances; the daily value history is recomputed on the next visit. No manual step.

## v0.2.0

### Breaking: upgrading from 0.1.x

The deployed stack is renamed from `portfolio` to `kerdial`: the Docker Compose project, its containers,
its database volume and the default database name. A 0.1.x installation that simply pulls the new compose
file and runs `docker compose up` starts on a **new, empty database** and shows the first-run setup
screen. Your data is not deleted — it is still in the old volume — but it has to be moved across once.

Before upgrading, follow
[Upgrading from 0.1.x (portfolio stack) to 0.2.0](deploy-runbook.md#upgrading-from-01x-portfolio-stack-to-020)
in the deployment runbook (it applies to a Synology NAS as well). Do not complete the first-run setup on the
empty instance. New installations are not affected.

### First public release

Kerdial is a self-hosted portfolio tracker for European investors, published under the AGPL-3.0. It runs as
a single Docker image (`kerdial/kerdial` on Docker Hub) with PostgreSQL, on a PC, a server or a Synology
NAS. The interface is in French.

What it does:

- **Portfolios and transactions.** Several portfolios, valued separately and together. Buys, sells,
  deposits, withdrawals, dividends, reinvested dividends, share distributions, interest on cash, portfolio
  fees, currency exchanges, and transfers of a holding between portfolios. Fees and taxes can be itemised
  per transaction, and a dividend records its withholding tax with the net amount computed.
- **Instruments.** Shares, ETFs, funds (including French OPCVM), crypto-assets and SCPI. Prices come
  automatically from Yahoo Finance; anything no provider covers can be priced by hand.
- **Currencies.** Multi-currency holdings and cash accounts, with ECB exchange rates and the option to pin
  the rate actually applied to a transaction.
- **Cash.** Each portfolio's cash balances count in its value, its allocation and its returns.
- **Figures you can trust.** Exact decimal arithmetic throughout, French weighted-average cost (PMP),
  time-weighted (TWR) and money-weighted (XIRR) returns, and every figure marked as live, manual or carried
  forward so you can see whether it is fresh.
- **Screens.** An overview with a value-and-invested-capital chart and an allocation chart, positions, a
  performance screen that can isolate one portfolio, dividend and activity calendars, and a watchlist.
- **Import and export.** Import a Portfolio Performance CSV export. Export all your data to two files —
  an instrument catalogue (JSON) and a transaction list (CSV) — and import them back; the format is
  documented in [import-export-format.md](import-export-format.md).
- **Several users, one instance.** The first account is created on a setup screen; further accounts are
  created by that administrator for the other members of the household, who see and manage the same
  portfolios.
- **Phone-friendly.** Usable at phone width and installable as a progressive web app.
