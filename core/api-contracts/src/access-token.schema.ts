import { z } from "zod";

/**
 * `POST /auth/tokens`' shared contract — ADR-0019; MCP-FR-2, MCP-L2, MCP-L17.
 *
 * One schema at the single writer, read by the web form, so the dialog and the
 * route cannot disagree about what a valid request is (the
 * `rate-presets.schema.ts` precedent). The table carries a structural
 * `char_length(label) BETWEEN 1 AND 60` backstop; trimming and the blank rule
 * live here.
 *
 * **Issue messages never interpolate the label** — it is free text, and a
 * `400` body or a log line must not carry it.
 */

/**
 * Characters, after trimming. The table's CHECK carries the same literal; the
 * web dialog reads it for its label field's `maxLength`.
 */
export const ACCESS_TOKEN_LABEL_MAX = 60;

/** MCP-L2: an expiry of 1..365 days, or `null` for « Jamais ». */
const ACCESS_TOKEN_EXPIRY_MAX_DAYS = 365;

/**
 * The create body: `{ label, expiresInDays, currentPassword }`, strict (an
 * unknown key is a `400`, not silently dropped).
 *
 * `currentPassword` is MCP-L17: creating a token re-authenticates, exactly as
 * `PATCH /auth/me` does, so a hijacked session cannot convert itself into a
 * durable credential. Its bound is the presented-credential 1..256 of the
 * other two re-authenticating routes, with no complexity floor — it is a
 * password being proved, not chosen.
 */
export const accessTokenCreateBodySchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1, "label is required")
    .max(
      ACCESS_TOKEN_LABEL_MAX,
      `label must be at most ${String(ACCESS_TOKEN_LABEL_MAX)} characters`,
    ),
  expiresInDays: z
    .int("expiresInDays must be an integer number of days")
    .min(1, "expiresInDays must be at least 1")
    .max(
      ACCESS_TOKEN_EXPIRY_MAX_DAYS,
      `expiresInDays must be at most ${String(ACCESS_TOKEN_EXPIRY_MAX_DAYS)}`,
    )
    .nullable(),
  currentPassword: z
    .string()
    .min(1, "current password is required")
    .max(256, "current password is too long"),
});
