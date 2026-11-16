import { z } from "zod";
import { asRecord, defineTool, portfolioIdSchema, portfolioPath } from "./tool.js";

/** `GET /portfolios[/:id]/allocation?by=`, relayed: the shares are the server's, never derived here. */
export const getAllocation = defineTool({
  name: "get_allocation",
  title: "Get allocation",
  description:
    "Breakdown of the current value by instrument, currency, kind, sector or country, in the base currency: each bucket's value and share of the stated total (sharePercent, two decimals), plus cash. Without portfolioId: all portfolios combined. For sector and country, an instrument with hand-entered weights is split across its buckets, the rest of its value in UNCLASSIFIED; holdingCount then counts it in each bucket. basis (country only) is DOMICILE, LISTING, WEIGHTED, MIXED or NONE; weights are entered by the user, not provider data.",
  inputSchema: z.strictObject({
    portfolioId: portfolioIdSchema.optional(),
    by: z.enum(["instrument", "currency", "kind", "sector", "country"]).describe("The grouping."),
  }),
  run: async ({ portfolioId, by }, { client }) =>
    asRecord(await client.get(portfolioPath(portfolioId, "allocation"), { by })),
});
