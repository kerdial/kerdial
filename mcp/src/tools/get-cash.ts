import { z } from "zod";
import { asRecord, defineTool, portfolioIdSchema, portfolioPath } from "./tool.js";

/**
 * With a portfolio: `GET /portfolios/:id/cash` (per-account balances). Without
 * one: the `cash` block of the combined holdings read — there is no tenant-wide
 * account route, and a per-portfolio fan-out would spend the token's rate
 * budget on a large account.
 */
export const getCash = defineTool({
  name: "get_cash",
  title: "Get cash",
  description:
    "Cash balances. With portfolioId: every cash account with its balance and per-currency totals. Without: the combined cash per currency with its base-currency value (accounts that cannot be converted are listed as unconverted).",
  inputSchema: z.strictObject({ portfolioId: portfolioIdSchema.optional() }),
  run: async ({ portfolioId }, { client }) => {
    if (portfolioId !== undefined) {
      return asRecord(await client.get(portfolioPath(portfolioId, "cash")));
    }
    const holdings = asRecord(await client.get(portfolioPath(undefined, "holdings")));
    return {
      scope: "all",
      asOfDate: holdings["asOfDate"],
      cash: holdings["cash"],
      note: "Per-account balances need a portfolioId.",
    };
  },
});
