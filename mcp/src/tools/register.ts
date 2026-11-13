import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KerdialError, toolErrorText } from "../errors.js";
import { PROMPTS } from "../prompts.js";
import { getAllocation } from "./get-allocation.js";
import { getCash } from "./get-cash.js";
import { getDividends } from "./get-dividends.js";
import { getHoldings } from "./get-holdings.js";
import { getPerformance } from "./get-performance.js";
import { getTransactions } from "./get-transactions.js";
import { getWatchlist } from "./get-watchlist.js";
import { listPortfolios } from "./list-portfolios.js";
import type { KerdialTool, ToolContext } from "./tool.js";

/** Exactly these eight, and no write tool of any kind (MCP-N1). */
const TOOLS: readonly KerdialTool[] = [
  listPortfolios,
  getHoldings,
  getPerformance,
  getAllocation,
  getTransactions,
  getDividends,
  getWatchlist,
  getCash,
];

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer, context: ToolContext, host: string): void {
  for (const tool of TOOLS) {
    // No outputSchema: the bodies are the API's, relayed, and `structuredContent`
    // is accepted without one (SDK 1.32.2).
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...READ_ONLY },
      },
      async (args) => {
        try {
          const payload = await tool.run(args, context);
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: { ...payload },
          };
        } catch (err) {
          const text =
            err instanceof KerdialError
              ? toolErrorText(err.failure, host)
              : `kerdial-mcp failed unexpectedly while running ${tool.name}.`;
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    );
  }
}

export function registerPrompts(server: McpServer): void {
  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      (args) => ({
        messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
      }),
    );
  }
}
