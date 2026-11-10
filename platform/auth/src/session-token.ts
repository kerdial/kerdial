import { createHash, randomBytes } from "node:crypto";

/**
 * Session tokens — 256 bits from `crypto.randomBytes`,
 * stored **hashed** (SHA-256) in `session.token_hash`, never in plaintext.
 * `token` is the value sent to the client as the `sid` cookie (cookie
 * issuance itself is T-40); this module only owns generating it and hashing
 * it consistently on both the issuing and verifying sides.
 */
export interface IssuedSessionToken {
  /** The raw token — hand this to the caller (cookie value), never store it. */
  readonly token: string;
  /** SHA-256 of `token`, the only form ever written to `session.token_hash`. */
  readonly tokenHash: Buffer;
}

/** Generates a new 256-bit session token and its SHA-256 hash. */
export function issueSessionToken(): IssuedSessionToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

/** SHA-256 of a session token — the only thing ever compared against `session.token_hash`. */
export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
