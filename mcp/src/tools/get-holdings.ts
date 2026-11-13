import { z } from "zod";
import { asRecord, defineTool, portfolioIdSchema, portfolioPath, withoutFieldsIn } from "./tool.js";

/** `GET /portfolios/:id/holdings` or the combined `GET /portfolios/holdings`, relayed. */
export const getHoldings = defineTool({
  name: "get_holdings",
  title: "Get holdings",
  description:
    "Current positions with quantity, cost basis, price, value and unrealised gain, plus the cash block and the total value, as of today. Without portfolioId: all portfolios combined (one line per instrument). Amounts are decimal strings next to their currency.",
  inputSchema: z.strictObject({ portfolioId: portfolioIdSchema.optional() }),
  run: async ({ portfolioId }, { client }) =>
    withoutFieldsIn(
      asRecord(await client.get(portfolioPath(portfolioId, "holdings"))),
      "holdings",
      ["hasIcon"],
    ),
});
