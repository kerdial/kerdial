import { z } from "zod";
import { asRecord, defineTool, portfolioIdSchema, portfolioPath } from "./tool.js";

/** `GET /portfolios[/:id]/allocation?by=`, relayed: the shares are the server's, never derived here. */
export const getAllocation = defineTool({
  name: "get_allocation",
  title: "Get allocation",
  description:
    "Breakdown of the current value by instrument, currency, kind, sector or country, in the base currency: each bucket's value and share of the stated total (sharePercent, two decimals), plus cash. Without portfolioId: all portfolios combined.",
  inputSchema: z.strictObject({
    portfolioId: portfolioIdSchema.optional(),
    by: z.enum(["instrument", "currency", "kind", "sector", "country"]).describe("The grouping."),
  }),
  run: async ({ portfolioId, by }, { client }) =>
    asRecord(await client.get(portfolioPath(portfolioId, "allocation"), { by })),
});
