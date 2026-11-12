import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./http-client.js";
import { createKerdialMcpServer } from "./server.js";

/**
 * Unit-test wiring: the real server and the SDK's own client over the
 * in-memory transport pair, with `fetch` replaced by a routing stub.
 */

/** Well-formed, never issued, and distinctive enough to scan every output for. */
export const TEST_TOKEN = `kdl_pat_${"0123456789abcdef".repeat(2)}TESTONLY_not_a_real_secret_${"z".repeat(16)}`;

export const TEST_HOST = "kerdial.example";

interface RecordedRequest {
  readonly url: URL;
  readonly init: RequestInit;
}

export type Route = (url: URL) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": status < 400 ? "application/json" : "application/problem+json",
      ...headers,
    },
  });
}

function stubFetch(route: Route): {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (raw, init) => {
      const url = new URL(raw);
      requests.push({ url, init });
      return await route(url);
    },
  };
}

export interface Harness {
  readonly client: Client;
  readonly requests: RecordedRequest[];
  readonly logLines: string[];
  readonly sleeps: number[];
  /** Calls a tool and returns its result, failing the test on a protocol-level error. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown> | undefined;
}

export async function connect(
  route: Route,
  env: Readonly<Record<string, string>> = {},
): Promise<Harness> {
  const config = loadConfig({
    KERDIAL_URL: `https://${TEST_HOST}`,
    KERDIAL_TOKEN: TEST_TOKEN,
    ...env,
  });
  const stub = stubFetch(route);
  const logLines: string[] = [];
  const sleeps: number[] = [];
  const server = createKerdialMcpServer(config, {
    fetch: stub.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logLines.push(line),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "kerdial-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    requests: stub.requests,
    logLines,
    sleeps,
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return {
        isError: result.isError === true,
        text: content.map((item) => item.text ?? "").join(""),
        structured: result.structuredContent as Record<string, unknown> | undefined,
      };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
