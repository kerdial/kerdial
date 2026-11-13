import { z } from "zod";
import { asRecord, defineTool, isoDateSchema, portfolioIdSchema, withoutFields } from "./tool.js";

/** The API's page ceiling: a larger tool page is two calls (DC-1). */
const API_PAGE_MAX = 100;

/** MCP-L16: 50 rows by default, 200 at most, the API's cursor passed through. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CALLS = Math.ceil(MAX_LIMIT / API_PAGE_MAX);

/** MCP-L5: free text the user wrote; relayed only with KERDIAL_MCP_INCLUDE_NOTES=1. */
const NOTE_FIELDS = ["note", "reference"] as const;

/**
 * `GET /transactions`. The kind vocabulary is the API's: it validates `kind`
 * and its 400 is relayed, so no copy of the list lives here.
 */
export const getTransactions = defineTool({
  name: "get_transactions",
  title: "Get transactions",
  description:
    "Ledger rows (buys, sells, dividends, deposits, fees…) with amounts as decimal strings and their currency. Filters are optional. Returns at most `limit` rows and a nextCursor to pass back as `cursor` for the next page (null when there is none). Notes and user references are omitted unless the server was started with KERDIAL_MCP_INCLUDE_NOTES=1 (notesIncluded says which).",
  inputSchema: z.strictObject({
    portfolioId: portfolioIdSchema.optional(),
    instrumentId: z.uuid().optional().describe("An instrument id, as found in holdings."),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    kind: z
      .array(z.string().regex(/^[A-Z_]{2,32}$/, "must be a transaction kind such as BUY or FEE"))
      .min(1)
      .max(32)
      .optional()
      .describe('Transaction kinds to keep, e.g. ["BUY", "SELL"] or ["FEE"].'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code")
      .optional()
      .describe("The trade's own currency, e.g. EUR."),
    order: z.enum(["asc", "desc"]).optional().describe("Trade-date order; the API default is asc."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe("Rows to return, 1 to 200 (default 50)."),
    cursor: z.string().min(1).max(512).optional().describe("nextCursor from a previous call."),
  }),
  run: async (args, { client, includeNotes }) => {
    const filters = {
      portfolio: args.portfolioId,
      instrument: args.instrumentId,
      from: args.from,
      to: args.to,
      kind: args.kind?.join(","),
      currency: args.currency,
      order: args.order,
    };
    const items: unknown[] = [];
    let cursor = args.cursor;
    let nextCursor: unknown = null;
    for (let call = 0; call < MAX_CALLS && items.length < args.limit; call += 1) {
      const page = asRecord(
        await client.get("/transactions", {
          ...filters,
          limit: String(Math.min(args.limit - items.length, API_PAGE_MAX)),
          cursor,
        }),
      );
      if (Array.isArray(page["items"])) items.push(...page["items"]);
      nextCursor = page["nextCursor"] ?? null;
      if (typeof nextCursor !== "string") break;
      cursor = nextCursor;
    }
    return {
      items: includeNotes ? items : items.map((item) => withoutFields(item, NOTE_FIELDS)),
      nextCursor,
      notesIncluded: includeNotes,
    };
  },
});
