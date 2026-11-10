import { customType } from "drizzle-orm/pg-core";

/**
 * Small non-numeric Postgres column types Drizzle has no first-class builder
 * for. These are **not** subject to the `decimalCol`-only rule — that rule is scoped to `numeric`/`double precision`/`real` columns
 * only (the "no floats" gate), not to every custom column type.
 */

/**
 * Case-insensitive text, used for `app_user.email` so
 * a lookup by email does not depend on the caller's casing. Requires the
 * `citext` extension, enabled by this schema's first migration.
 */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/**
 * Raw bytes, used for `session.token_hash`: the
 * session token is stored only as its SHA-256 hash, never as plaintext.
 */
export const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
});
