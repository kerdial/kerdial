import { z } from "zod";
import { asRecord, defineTool, withoutFieldsIn } from "./tool.js";

/**
 * The window presets `GET /watchlist` accepts. A copy, since this package
 * imports no workspace package: the source of truth is
 * `WATCHLIST_WINDOW_PRESETS` in `valuation/src/watchlist-valuation.ts`.
 */
const WATCHLIST_WINDOWS = ["3M", "6M", "YTD", "1Y", "3Y", "5Y"] as const;

/**
 * `GET /watchlist?window=`, relayed. A row's `note` is the user's own free
 * text, so it follows the same switch as transaction notes (MCP-L5).
 */
export const getWatchlist = defineTool({
  name: "get_watchlist",
  title: "Get watchlist",
  description:
    "Watched instruments with price, day change, period returns, 52-week range, drawdown and a price series over the window (3M, 6M, YTD, 1Y, 3Y or 5Y; default 1Y). Notes are omitted unless the server was started with KERDIAL_MCP_INCLUDE_NOTES=1.",
  inputSchema: z.strictObject({
    window: z
      .enum(WATCHLIST_WINDOWS)
      .optional()
      .describe("The series window preset; the API default is 1Y."),
  }),
  run: async ({ window }, { client, includeNotes }) => {
    const body = withoutFieldsIn(asRecord(await client.get("/watchlist", { window })), "rows", [
      "hasIcon",
      ...(includeNotes ? [] : ["note"]),
    ]);
    return { ...body, notesIncluded: includeNotes };
  },
});
