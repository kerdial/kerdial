import { z } from "zod";
import { asRecord, defineTool, isoDateSchema, portfolioIdSchema, portfolioPath } from "./tool.js";

/**
 * Per portfolio: `GET /portfolios/:id/performance` + `/value-series`.
 * Combined: there is no combined performance route, so the combined
 * `overview` (its return pair, total value and cash) + the combined
 * `value-series`. Two calls either way; nothing is recomputed. The window
 * defaults are the API's.
 */
export const getPerformance = defineTool({
  name: "get_performance",
  title: "Get performance",
  description:
    "Time-weighted and money-weighted returns over a window, with the daily value series (value and net contributions) in the base currency. Without from/to the window is the API's default (the last year). Without portfolioId: all portfolios combined, plus the current total value and cash.",
  inputSchema: z.strictObject({
    portfolioId: portfolioIdSchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  }),
  run: async ({ portfolioId, from, to }, { client }) => {
    const window = { from, to };
    const figures = asRecord(
      await client.get(
        portfolioPath(portfolioId, portfolioId === undefined ? "overview" : "performance"),
        window,
      ),
    );
    const series = asRecord(await client.get(portfolioPath(portfolioId, "value-series"), window));
    return {
      scope: portfolioId === undefined ? "all" : "portfolio",
      ...(portfolioId === undefined ? {} : { portfolioId }),
      from: figures["from"],
      to: figures["to"],
      return: figures["return"],
      valueSeries: {
        baseCurrency: series["baseCurrency"],
        points: series["points"],
        provenance: series["provenance"],
      },
      ...(portfolioId === undefined
        ? { totalValue: figures["totalValue"], cash: figures["cash"] }
        : {}),
    };
  },
});
