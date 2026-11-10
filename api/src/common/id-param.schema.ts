import { z } from "zod";
import { problemException } from "./problem.js";

/**
 * Shared `:id` path-param validator — F2 (security review
 * T-37): every `:id` route param used to be passed to the service layer as a
 * raw string. A malformed value (not a UUID at all) reached a `WHERE id = $1`
 * query against a `uuid` column and Postgres's own `22P02 invalid input
 * syntax for type uuid`, surfacing as a raw 500 rather than a per-field 400.
 * Every controller with a `:id` route (`instruments.controller.ts`'s
 * `GET /instruments/:id`, `POST /instruments/:id/prices`,
 * `GET /instruments/:id/prices`) calls this before the id ever reaches a
 * service call.
 *
 * The id comes back lower-cased: Postgres compares `uuid`
 * case-insensitively but returns ids lower-case, so a caller-cased id compared
 * against a returned one in JS (`iconed.has(id)`) silently missed.
 */
const idParamSchema = z.uuid().toLowerCase();

/** How much of a rejected `:id` segment the 400's `detail` echoes back. A valid UUID is 36. */
const MAX_ECHOED_ID_CHARS = 64;

export function parseIdParam(id: string): string {
  const result = idParamSchema.safeParse(id);
  if (!result.success) {
    throw problemException(400, {
      title: "Invalid id",
      code: "INVALID_ID",
      // The segment is echoed for actionability (a caller
      // sees which id it sent), and **bounded** so an arbitrarily long path
      // segment cannot be reflected whole into a response body or a log line.
      // A valid UUID is 36 characters; anything past MAX is already wrong,
      // and the prefix is enough to recognise it.
      detail: `id must be a UUID, got: ${JSON.stringify(id.slice(0, MAX_ECHOED_ID_CHARS))}${
        id.length > MAX_ECHOED_ID_CHARS ? " (truncated)" : ""
      }`,
      errors: [{ field: "id", message: "must be a valid UUID" }],
    });
  }
  return result.data;
}
