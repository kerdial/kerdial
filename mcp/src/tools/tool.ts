import { z } from "zod";
import type { KerdialClient } from "../http-client.js";

/**
 * One read tool: a strict input schema and a function from validated input to
 * the JSON object the tool returns. Tools relay the API's bodies; the only
 * projections drop UI-only fields and, unless enabled, user notes (MCP-L5).
 * No tool parses, sums, rounds or averages an amount.
 */
export interface ToolContext {
  readonly client: KerdialClient;
  readonly includeNotes: boolean;
}

export type ToolName =
  | "list_portfolios"
  | "get_holdings"
  | "get_performance"
  | "get_allocation"
  | "get_transactions"
  | "get_dividends"
  | "get_watchlist"
  | "get_cash";

export interface KerdialTool {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly run: (args: unknown, context: ToolContext) => Promise<Readonly<Record<string, unknown>>>;
}

/** Binds a tool's `run` to its own schema's output type; the SDK has already validated `args` against it. */
export function defineTool<S extends z.ZodObject>(tool: {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly run: (
    args: z.output<S>,
    context: ToolContext,
  ) => Promise<Readonly<Record<string, unknown>>>;
}): KerdialTool {
  return { ...tool, run: (args, context) => tool.run(tool.inputSchema.parse(args), context) };
}

export const portfolioIdSchema = z.uuid().describe("A portfolio id from list_portfolios.");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date")
  .describe("An ISO date, YYYY-MM-DD.");

/** The API's base path for a portfolio-scoped read, or its combined (all portfolios) counterpart. */
export function portfolioPath(portfolioId: string | undefined, leaf: string): string {
  return portfolioId === undefined
    ? `/portfolios/${leaf}`
    : `/portfolios/${encodeURIComponent(portfolioId)}/${leaf}`;
}

export function asRecord(body: unknown): Readonly<Record<string, unknown>> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A copy of `body` whose array at `key` has `fields` removed from every element. Everything else is untouched. */
export function withoutFieldsIn(
  body: Readonly<Record<string, unknown>>,
  key: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const list = body[key];
  if (!Array.isArray(list)) return body;
  return { ...body, [key]: list.map((item: unknown) => withoutFields(item, fields)) };
}

export function withoutFields(item: unknown, fields: readonly string[]): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy;
}
