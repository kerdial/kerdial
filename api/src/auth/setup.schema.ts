import { z } from "zod";

/**
 * `POST /auth/setup`'s request body (T-87; FR-395–FR-399, LD-5) — first-run onboarding's
 * one and only write.
 *
 * **Why a second password bound instead of reusing `loginBodySchema`'s.**
 * LD-5 is explicit that the two are different questions: `login.schema.ts`'s
 * `1–256` governs *presenting* a credential chosen under whatever rule was in
 * force, and must never gain a floor (that would lock out an existing
 * account); this schema governs *choosing* a new one, so it carries the
 * floor. `loginBodySchema` is therefore deliberately left untouched by this
 * cycle.
 *
 * The 256 ceiling is the same one and the same reason `login.schema.ts:8-15`
 * records (security review finding L4: Argon2id's cost scales with input
 * size, so an unbounded password is a CPU/memory amplification vector), and
 * the 320 email ceiling is the same RFC 5321 maximum.
 */

/** LD-5 — the floor a *newly chosen* password must clear. Shared with `POST /admin/users` (3b) rather than re-typed there. */
export const NEW_PASSWORD_MIN_LENGTH = 8;

/** The same amplification bound `login.schema.ts` documents, so a new password can never be longer than one that can be presented. */
export const NEW_PASSWORD_MAX_LENGTH = 256;

/**
 * The email every write path in this cycle shares — `POST /auth/setup`,
 * `POST /admin/users` (which reuses {@link accountCreationBodySchema} whole)
 * and `PATCH /auth/me`.
 *
 * `.trim()` first, then the bounds, then a shape check. Three
 * deliberate limits:
 *
 *  - **Trimming is a transform, not a rejection**, and it runs before the
 *    length bounds, so `" "` is `""` by the time `.min(1)` sees it and a
 *    surrounding space can never be stored — a stored `" me@example.com "`
 *    is a login nobody can perform, since `login()` looks the address up
 *    verbatim.
 *  - **The shape check is deliberately not RFC validation** and not Zod's
 *    `.email()`: an address the user's own provider accepts and a validator
 *    rejects is a lockout, and this product sends no mail (FR-46 deferred),
 *    so the address is an identifier. What it refuses is the two shapes that
 *    cannot be one: no `@` at all, and internal whitespace.
 *  - The 320 ceiling is the same bound and the same reason `login.schema.ts:18`
 *    records: 64 local-part + `@` + 255 domain.
 */
export const emailField = z
  .string()
  .trim()
  .min(1, "email is required")
  .max(320, "email is too long")
  .refine(
    (value) => value.includes("@") && !/\s/.test(value),
    "email must contain @ and no spaces",
  );

export const newPasswordField = z
  .string()
  .min(NEW_PASSWORD_MIN_LENGTH, `password must be at least ${NEW_PASSWORD_MIN_LENGTH} characters`)
  .max(NEW_PASSWORD_MAX_LENGTH, "password is too long");

/**
 * Shape only — **existence is the foreign key's job, not Zod's**
 * (`tenant_base_currency_currency_code_fk`, mapped to `422 UNKNOWN_CURRENCY`
 * by the handler). A Zod enum over the seeded set would be a second copy of
 * the `currency` table, which is the mirrored-constant failure this repo has
 * recorded repeatedly. Same regex and same message as
 * `core/api-contracts`' `instrument-create.schema.ts:49`.
 */
export const currencyField = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 currency code (uppercase)");

/**
 * The three questions an account is created from, wherever it is created —
 * `POST /auth/setup` (first run) and `POST /admin/users` (FR-422), which is
 * why it is its own schema rather than `setupBodySchema` itself.
 *
 * **It stopped being `setupBodySchema` when the setup token arrived.** The first-run body
 * gained a fourth field (the one-time setup token), and `POST /admin/users`
 * must **not** require it: an authenticated instance admin has already proved
 * far more than a token printed once in a boot log could. Extending the
 * shared schema in place would have made the admin route demand a token
 * nobody has any reason to still hold — so the shared part keeps its own
 * name and {@link setupBodySchema} extends it.
 */
export const accountCreationBodySchema = z.object({
  email: emailField,
  password: newPasswordField,
  baseCurrency: currencyField,
});

/**
 * The one-time first-run setup token (owner decision
 * 2026-09-19) — printed once in the API log at boot while `setup_needed()` is
 * true, or set by the operator as `SETUP_TOKEN`.
 *
 * Bounds only: this field is never compared by Zod, and must not be. The
 * comparison is `timingSafeEqual` against the value the process holds
 * (`setup-token.ts`), and it happens inside the rate-limited attempt so a
 * wrong token costs the caller the same backoff a wrong password does. The
 * 256 ceiling is the same amplification bound `login.schema.ts` records: an
 * unbounded string would be hashed by nothing here, but it would still be
 * parsed, buffered and compared.
 */
export const setupTokenField = z
  .string()
  .min(1, "setup token is required")
  .max(256, "setup token is too long");

export const setupBodySchema = accountCreationBodySchema.extend({
  setupToken: setupTokenField,
});

export type SetupBody = z.infer<typeof setupBodySchema>;
