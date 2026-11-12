#!/usr/bin/env node
/**
 * `kerdial-mcp` — the stdio entrypoint. stdout carries MCP protocol frames and
 * nothing else; every diagnostic goes to stderr, and none of them contains the
 * token or the Authorization header.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError } from "./config.js";
import { createKerdialMcpServer, loadConfig, type KerdialConfig } from "./index.js";

function writeError(line: string): void {
  process.stderr.write(`kerdial-mcp: ${line}\n`);
}

let config: KerdialConfig;
try {
  config = loadConfig(process.env, process.argv.slice(2));
} catch (err) {
  writeError(err instanceof ConfigError ? err.message : "could not read the configuration");
  process.exit(2);
}

const server = createKerdialMcpServer(config, { log: (line) => process.stderr.write(`${line}\n`) });
await server.connect(new StdioServerTransport());
