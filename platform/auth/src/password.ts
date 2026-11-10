import argon2 from "argon2";

/**
 * Argon2id password hashing (D16): memory 64 MiB,
 * time cost 3, parallelism 1. `argon2` (npm, MIT) does the actual KDF work;
 * this module's job is only to pin the parameters and expose two narrow
 * functions, never a hand-rolled comparison.
 *
 * `memoryCost` is in KiB for the `argon2` package's API — 65536 KiB = 64 MiB.
 */
export const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

/** Hashes `password` into a self-describing PHC-format Argon2id string. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2ID_OPTIONS);
}

/**
 * Verifies `password` against a previously hashed Argon2id string.
 * `argon2.verify` reads the algorithm/parameters back out of `hash` itself
 * (PHC format), so the same parameters are used to verify as were used to
 * hash even if `ARGON2ID_OPTIONS` changes later — and the comparison itself
 * is `argon2`'s own constant-time digest comparison, not a hand-rolled one.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * A fixed Argon2id hash of a placeholder password, computed once and cached.
 * `login()` (auth-service.ts) verifies the supplied password against this
 * when no matching `app_user` row was found, so the expensive Argon2id work
 * always runs — an unknown email does not short-circuit before it and
 * finish measurably faster than a known email with a wrong password would.
 * This is the standard mitigation for user-enumeration via login-response
 * timing (it does not erase every timing signal — the email lookup itself
 * still runs regardless — but it removes the dominant one, the ~100ms
 * Argon2id hash, which is otherwise skipped entirely for an unknown email).
 */
let dummyHashPromise: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("this-password-is-never-a-real-users-password");
  return dummyHashPromise;
}
