/**
 * A tiny shared helper for every adapter's parser modules
 * (`yahoo/parse-*.ts`) — all of them parse
 * hand-rolled `unknown` JSON, never a schema library (mirrors `ecb`'s choice
 * of a plain regex parser over an XML/DOM dependency, `parse-xml.ts`'s doc
 * comment: the shapes here are small and fixed, and a validation library
 * would be a new dependency requiring `license-gate` clearance for no real
 * benefit).
 *
 * This lived twice — once per JSON-parsing adapter, code-identical — until
 * the adapter-transport dedup.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
