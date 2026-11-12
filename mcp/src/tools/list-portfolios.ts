import { z } from "zod";
import { asRecord, defineTool } from "./tool.js";

/** The API's page ceiling. */
const PAGE_SIZE = 100;
/** 5 x 100 = the per-tenant portfolio cap, so a real tenant is never truncated. */
const MAX_PAGES = 5;

/**
 * `GET /portfolios`, every page up to the cap. Archived portfolios are listed
 * with their flag (MCP-L4). There is no per-portfolio base currency: amounts
 * are in the tenant's one base currency, which every valued read states.
 */
export const listPortfolios = defineTool({
  name: "list_portfolios",
  title: "List portfolios",
  description:
    "Lists every portfolio in the Kerdial account: id, name, broker, description, archived flag, transaction count and creation time. Use the ids as portfolioId in the other tools. Archived portfolios are included with archived: true.",
  inputSchema: z.strictObject({}),
  run: async (_args, { client }) => {
    const portfolios: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = asRecord(await client.get("/portfolios", { limit: String(PAGE_SIZE), cursor }));
      const items = Array.isArray(body["items"]) ? body["items"] : [];
      for (const item of items) portfolios.push(project(asRecord(item)));
      const next = body["nextCursor"];
      if (typeof next !== "string") return { portfolios, truncated: false };
      cursor = next;
    }
    return { portfolios, truncated: true };
  },
});

function project(item: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    id: item["id"],
    name: item["name"],
    broker: item["broker"],
    description: item["description"],
    archived: item["archived"],
    transactionCount: item["transactionCount"],
    createdAt: item["createdAt"],
  };
}
