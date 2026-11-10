import { z } from "zod";

/**
 * `POST /auth/login`'s request body. Deliberately minimal (no `zDecimal`
 * fields exist on this endpoint) but still Zod, matching the validation
 * approach used across the whole API surface.
 *
 * Security review finding L4: without an upper bound, an attacker can send
 * an arbitrarily large `password` (limited only by Fastify's default body
 * limit, ~1 MiB) and force a full Argon2id verification over that entire
 * value — Argon2's own cost scales with input size, so this is a real
 * CPU/memory amplification vector, not merely a validation nicety. `email`
 * is capped at the longest an RFC 5321 address can be (320: 64 local-part +
 * `@` + 255 domain); `password` at a generous but bounded 256 — far beyond
 * any real passphrase, while still foreclosing the amplification.
 */
export const loginBodySchema = z.object({
  email: z.string().min(1, "email is required").max(320, "email is too long"),
  password: z.string().min(1, "password is required").max(256, "password is too long"),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
