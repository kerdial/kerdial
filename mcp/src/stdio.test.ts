import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./test-harness.js";

/**
 * MCP-AC-21 at the process level: the real entrypoint, spawned under `tsx`
 * (no build needed), speaking MCP over stdio. stdout is the protocol channel,
 * so every byte on it must belong to a JSON-RPC frame; the token must appear
 * on neither stream, even with debug diagnostics on and a failing request.
 *
 * Generous timeouts: a cold `tsx` start under on-access virus scanning has been
 * measured in seconds on the development host.
 */

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const MAIN = join(PACKAGE_ROOT, "src", "main.ts");
const TSX_CLI = createRequire(join(PACKAGE_ROOT, "..", "package.json")).resolve("tsx/cli");
const SPAWN_TIMEOUT_MS = 60_000;

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Spawns the server, writes `frames` one per line, waits for `expectedResponses` replies, then closes stdin. */
function runServer(
  env: Readonly<Record<string, string>>,
  frames: readonly object[],
  expectedResponses: number,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, MAIN], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not answer in time; stderr: ${stderr}`));
    }, SPAWN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const responses = stdout.split("\n").filter((line) => line.includes('"id"')).length;
      if (responses >= expectedResponses) child.stdin.end();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
    if (expectedResponses === 0) child.stdin.end();
  });
}

describe("kerdial-mcp over stdio", () => {
  it(
    "MCP-AC-21 — initialize, tools/list and a failing tool call put only JSON-RPC frames on stdout, and the token on neither stream",
    async () => {
      const run = await runServer(
        {
          // Loopback, discard port: the tool call fails fast with a network error.
          KERDIAL_URL: "http://127.0.0.1:9",
          KERDIAL_TOKEN: TEST_TOKEN,
          KERDIAL_MCP_DEBUG: "1",
        },
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "stdio-test", version: "0.0.0" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_holdings", arguments: {} },
          },
        ],
        3,
      );

      const lines = run.stdout.split("\n").filter((line) => line !== "");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const frame of frames) expect(frame["jsonrpc"]).toBe("2.0");

      const byId = new Map(frames.map((frame) => [frame["id"], frame]));
      const init = byId.get(1)?.["result"] as { serverInfo: { name: string } };
      expect(init.serverInfo.name).toBe("kerdial");
      const list = byId.get(2)?.["result"] as { tools: { name: string }[] };
      expect(list.tools).toHaveLength(8);
      const call = byId.get(3)?.["result"] as { isError: boolean; content: { text: string }[] };
      expect(call.isError).toBe(true);
      expect(call.content[0]?.text).toContain("Kerdial at 127.0.0.1:9 is unreachable");

      // Debug is on, so stderr is not empty: the scan below reads a real diagnostic line.
      expect(run.stderr).toContain("GET /portfolios/holdings failed");
      // The one legitimate whole-output scan: a distinctive secret must occur nowhere.
      expect(run.stdout).not.toContain(TEST_TOKEN);
      expect(run.stderr).not.toContain(TEST_TOKEN);
    },
    SPAWN_TIMEOUT_MS + 10_000,
  );

  it(
    "MCP-AC-21 — without KERDIAL_TOKEN the server exits non-zero, names the variable on stderr and writes nothing to stdout",
    async () => {
      const run = await runServer({ KERDIAL_URL: "https://kerdial.example" }, [], 0);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("KERDIAL_TOKEN");
      expect(run.stdout).toBe("");
    },
    SPAWN_TIMEOUT_MS + 10_000,
  );
});
