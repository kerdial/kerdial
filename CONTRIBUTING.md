# Contributing to Kerdial

Thank you for your interest. Bug reports, questions, ideas and pull requests are all welcome.

## Before you start

- **Questions and ideas** go to [GitHub Discussions](https://github.com/kerdial/kerdial/discussions).
- **Bugs** go to [GitHub Issues](https://github.com/kerdial/kerdial/issues), using the bug report
  template.
- **Larger changes** — a new feature, a new screen, a change to the data model or to how a figure is
  calculated — please open an issue or a discussion first, so we can agree on the approach before you
  spend time on code. Small fixes can go straight to a pull request.
- **Security vulnerabilities** must not be reported publicly; see [SECURITY.md](SECURITY.md).

Kerdial is maintained by one person in their spare time, so reviews may take a while.

## Prerequisites

- **Node.js 22** (the LTS line; `package.json` requires `>=22 <23`).
- **pnpm 9** (`corepack enable` picks up the version pinned in `package.json`).
- **Docker**, running. It is not optional for development: the local database runs in a container, and
  most of the test suite (integration and API tests) starts its own PostgreSQL containers through
  Testcontainers. Without Docker only the unit tests can run.

## Setting up

```bash
pnpm install
pnpm build      # build every package once; type-checking reads the built type declarations
pnpm dev:up     # start PostgreSQL in Docker, apply migrations, seed a development user
```

To run the application itself (API and web app), follow [`docs/run-local.md`](docs/run-local.md).

## Checking your change

One command runs everything the continuous integration checks, plus the browser tests and the Docker
image build that only run locally:

```bash
pnpm verify
```

It builds, type-checks, lints, checks formatting, runs the static checks, the unit and database test
suites, the browser (Playwright) tests and the image build, and ends with `ALL PASSED` or the name of the
step that failed. A full run takes a while. For a quicker loop while you work:

```bash
pnpm verify --fast   # skips the browser tests, the timing-sensitive test lane and the image build
pnpm test:quick      # unit and component tests only, no database
```

Run a full `pnpm verify` before you open a pull request: `--fast` skips the only browser tests the
project has, and refuses to run at all when your change touches `web/e2e/`.

Individual steps, if you need to run one on its own:

```bash
pnpm lint && pnpm format:check
pnpm build && pnpm typecheck   # build first, or typecheck reports missing modules
pnpm test                      # main test lane (needs Docker)
pnpm test:web                  # web app component tests
pnpm known-answers             # hand-calculated return and cost-basis fixtures
```

### Browser tests

The browser tests use Playwright against the web app's development server, with the API mocked in each
test. Install the browsers once:

```bash
pnpm --filter @kerdial/web exec playwright install --with-deps chromium webkit
```

Then:

```bash
pnpm test:e2e                # desktop Chrome and an iPhone 14 viewport
pnpm test:e2e:static-tier    # the built web app (run `pnpm build` first) with its production security headers
```

Ports **5173** and **3000** must both be free: the test run starts its own server on 5173 and refuses to
reuse one, and an API running on 3000 would answer requests the tests expect to be mocked, which makes
unrelated tests fail.

## Rules the code keeps

A pull request that weakens one of these will not be merged, even with every check green:

- **No floating-point money.** `decimal.js` in code, `NUMERIC` in the database, decimals as strings in
  JSON.
- **Tenants are isolated.** Every tenant-owned table has a non-null `tenant_id` with row-level
  security enabled and forced. An instance normally holds one household tenant, and every user the
  admin creates belongs to it and sees the same portfolios.
- **Figures carry their provenance** (live, manual, carried forward) from the database to the screen.
- **Module boundaries hold.** `core/domain` stays pure, with no database access; the allowed
  dependencies are enforced by `pnpm depcruise`.

Tests should prove behaviour: a guard is tested by showing it rejects the bad input, not by asserting
that an option is set.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/), scoped by package where it helps:
`feat(web): …`, `fix(ledger): …`, `docs: …`, `test(api): …`. Mark a breaking change with `!`
(`feat(api)!: …`) and explain it in the body. Keep each commit focused on one change.

## License of contributions

Kerdial is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). By
submitting a contribution you agree that it is licensed under the same terms (inbound = outbound).
There is no contributor licence agreement to sign, and you keep the copyright on your contribution.
