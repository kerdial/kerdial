# Release notes

User-facing changes that someone running a Kerdial instance needs to know about: new behaviour, anything
that needs a decision or a manual step, and breaking changes. Each release on GitHub carries its section
from this file above the generated list of changes.

---

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
