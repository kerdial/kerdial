import { z } from "zod";
import { asRecord, defineTool, isoDateSchema, portfolioIdSchema, withoutFieldsIn } from "./tool.js";

/** `GET /dividends/summary`, relayed. */
export const getDividends = defineTool({
  name: "get_dividends",
  title: "Get dividends",
  description:
    "Dividends received (gross and withholding, in the base currency): the total, per instrument, per year and per month, optionally within from/to and for one portfolio. Kerdial records dividends received, not announced ones.",
  inputSchema: z.strictObject({
    portfolioId: portfolioIdSchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  }),
  run: async ({ portfolioId, from, to }, { client }) =>
    withoutFieldsIn(
      asRecord(await client.get("/dividends/summary", { portfolio: portfolioId, from, to })),
      "instruments",
      ["hasIcon"],
    ),
});
