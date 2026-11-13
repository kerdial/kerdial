# @kerdial/mcp

A read-only [MCP](https://modelcontextprotocol.io/) server for a Kerdial instance. It runs on your own
computer, started by an AI assistant (Claude Code, Claude Desktop or any client that runs local stdio
servers), and reads your portfolios through Kerdial's HTTP API with a personal access token you create
in Kerdial (« Mon compte » → « Accès pour assistants IA »).

It offers eight read-only tools (`list_portfolios`, `get_holdings`, `get_performance`, `get_allocation`,
`get_transactions`, `get_dividends`, `get_watchlist`, `get_cash`) and five prompts. It cannot change
anything in Kerdial.

**Privacy.** Everything a tool returns is sent by the assistant to its AI provider and leaves your
self-hosted instance, under that provider's terms. Revoking the token stops future access; it cannot
recall what was already sent.

**No investment advice.** The tools return the facts recorded in Kerdial. Any analysis is the
assistant's, and it can be wrong.

The full guide — creating a token, configuring Claude Code and Claude Desktop, the tools, token hygiene
and troubleshooting — is [docs/mcp.md](../docs/mcp.md).

## Build and run

The package is not published to npm and is not part of the Docker image. From a checkout of the
repository (Node.js 22, pnpm 9):

```bash
pnpm install
pnpm --filter "@kerdial/mcp..." build
node /absolute/path/to/kerdial/mcp/dist/main.js
```

The server speaks MCP over stdin/stdout; your assistant starts it, you do not run it by hand except to
see why it refuses a configuration. Started by hand with a valid configuration, it waits silently for
input (Ctrl+C to stop).

## Configuration

Environment variables only (plus `--url <url>`, which overrides `KERDIAL_URL`). A refused setting prints
one line naming the variable and the rule, never its value, and exits with code 2.

| Variable                          | Required | Meaning                                                                                                                      |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `KERDIAL_URL`                     | yes      | The instance's address, e.g. `https://kerdial.example`. A path prefix is kept; no credentials, query string or fragment.     |
| `KERDIAL_TOKEN`                   | yes      | The personal access token (`kdl_pat_…`). Not accepted on the command line.                                                   |
| `KERDIAL_MCP_ALLOW_INSECURE_HTTP` | no       | `1` allows `http://` to a host other than `localhost`, `127.x.x.x` or `[::1]`.                                               |
| `KERDIAL_MCP_INCLUDE_NOTES`       | no       | `1` passes transaction notes and references, and watchlist notes, to the assistant. Default: withheld.                       |
| `KERDIAL_MCP_TIMEOUT_MS`          | no       | Per-request timeout in milliseconds, 1000 to 120000. Default 35000.                                                          |
| `KERDIAL_MCP_DEBUG`               | no       | `1` logs method, path (without query), status and duration of each request to stderr. stdout carries protocol messages only. |

Flags take `1` or `0`.
