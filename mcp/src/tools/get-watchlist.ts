import { z } from "zod";
import { asRecord, defineTool, withoutFieldsIn } from "./tool.js";

/**
 * `GET /watchlist?window=`, relayed. A row's `note` is the user's own free
 * text, so it follows the same switch as transaction notes (MCP-L5).
 */
export const getWatchlist = defineTool({
  name: "get_watchlist",
  title: "Get watchlist",
  description:
    "Watched instruments with price, day change, period returns, 52-week range, drawdown and a price series over the window (default one year; the API validates the window, e.g. 1M, 6M, 1Y). Notes are omitted unless the server was started with KERDIAL_MCP_INCLUDE_NOTES=1.",
  inputSchema: z.strictObject({
    window: z
      .string()
      .regex(/^[A-Za-z0-9]{1,8}$/, "must be a window preset such as 1Y")
      .optional()
      .describe("The series window preset, e.g. 1Y."),
  }),
  run: async ({ window }, { client, includeNotes }) => {
    const body = withoutFieldsIn(asRecord(await client.get("/watchlist", { window })), "rows", [
      "hasIcon",
      ...(includeNotes ? [] : ["note"]),
    ]);
    return { ...body, notesIncluded: includeNotes };
  },
});
