import { randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "@kerdial/platform-db";
import { rootLogger } from "@kerdial/platform-logging";
import { DB } from "../db/db.tokens.js";

/**
 * (MEDIUM-3, owner decision 2026-09-19) — the **one-time
 * first-run setup token**, and the boot line that publishes it.
 *
 * The finding: `POST /auth/setup` is public by construction (there is no
 * account to authenticate against yet), so a freshly migrated instance
 * belongs to whoever reaches it first. The docs already say "claim it before
 * you expose it"; this is the control that stops a scanner winning the race
 * even when the origin is reachable — the caller must also present a secret
 * only someone who can read the API's own log (or set its environment) has.
 *
 * **Where the value comes from.** `SETUP_TOKEN`, when it is set and
 * non-empty — the scripted first-run escape hatch, so a stack can be claimed
 * without scraping a log. Otherwise 32 random bytes, base64url, generated
 * once per process at module construction. There is deliberately **no
 * persistence**: a restart mints a new token, which is correct for a secret
 * whose whole lifetime is "until the operator claims the instance", and it
 * means nothing on disk has to be shredded afterwards.
 *
 * **Why the log line is safe, and why it is a `msg`.**
 * `platform/logging`'s `REDACT_PATHS` censors *field paths* — `password`,
 * `email`, `sid`, `cookie`, … — and its allow-list drops *field names* it
 * does not know. Neither touches the message text, so the token travels in
 * `msg` and arrives intact. That is also why it is not a new allow-listed
 * field: adding `setup_token` to `LOG_FIELD_ALLOWLIST` would make a secret a
 * first-class, machine-readable log field for every future call site, and
 * the one line that needs it is this one.
 *
 * **It is printed only while the instance is unclaimed.** A provisioned
 * instance logs nothing at all: the token would then be a secret for a route
 * that answers `409` to everyone, and a log line naming a secret is a
 * liability once it buys nothing.
 */

/** DI token for the resolved setup token — a `string`, so it needs a symbol of its own (the `DB`/`CSRF_SECRET` precedent). */
export const SETUP_TOKEN = Symbol("SETUP_TOKEN");

/** The `SETUP_TOKEN` override's env var name — read here and nowhere else. */
export const SETUP_TOKEN_ENV_VAR = "SETUP_TOKEN";

/** 32 bytes, the same entropy a session token carries (`platform/auth`'s `session-token.ts`); base64url so it survives a copy-paste out of a terminal. */
const GENERATED_TOKEN_BYTES = 32;

/**
 * The operator-supplied token, or a fresh random one.
 *
 * Blank is treated as unset (`platform/db`'s N7 lesson: "set but empty" is
 * the normal not-configured shape in compose, not a typo) — an empty token
 * would otherwise be compared against an empty field and let everyone
 * through, which is the one failure mode this must not have.
 */
export const SETUP_TOKEN_MIN_LENGTH = 16;

export function resolveSetupToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SETUP_TOKEN_ENV_VAR];
  if (configured !== undefined && configured.trim() !== "") {
    // A short operator-chosen token is guessable inside the unclaimed window:
    // the length check in `setupTokenMatches` tells a caller how long it is,
    // and the per-IP backoff has no hard lockout (~3 guesses/min/IP, more
    // across IPs and rotated emails). Refuse to boot rather than run with a
    // 4-character pin (hardening confirm pass, 2026-09-19, F1).
    if (configured.length < SETUP_TOKEN_MIN_LENGTH) {
      throw new Error(
        `[api] refusing to boot: ${SETUP_TOKEN_ENV_VAR} is ${configured.length} characters; it must be at least ${SETUP_TOKEN_MIN_LENGTH} (or unset, to have one generated and printed at boot)`,
      );
    }
    return configured;
  }
  return randomBytes(GENERATED_TOKEN_BYTES).toString("base64url");
}

/**
 * Constant-time comparison of the presented token against the expected one.
 *
 * `timingSafeEqual` throws on buffers of different lengths, so the lengths
 * are compared first and a mismatch returns early. That leaks the token's
 * length and nothing else, which is the standard trade every implementation
 * of this makes: the length of a 32-byte random value tells an attacker
 * nothing it does not already know from this file.
 */
export function setupTokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The exact prefix of the boot line, so the docs' `grep 'setup token'` and the tests both have one thing to match. */
export const SETUP_TOKEN_LOG_PREFIX = "first-run setup token (required by POST /auth/setup): ";

/**
 * Announces the token at boot, once, and only on an unclaimed instance.
 *
 * `OnApplicationBootstrap` rather than a constructor or `OnModuleInit`: Nest
 * runs every module's `onModuleInit` to completion before any module's
 * `onApplicationBootstrap` (`MarketRuntimeModule`'s own doc comment records
 * the same ordering), so by the time this runs the app is fully wired and
 * the line lands in the same startup log an operator is already reading.
 *
 * A failure of the read is logged and swallowed. `setup_needed()` is
 * installed by migration `0065`, so the only way this throws is a database
 * that is unreachable or unmigrated — and neither is a reason for the
 * process to refuse to serve `/health`, which is precisely what an operator
 * needs at that moment.
 */
@Injectable()
export class SetupTokenAnnouncer implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SETUP_TOKEN) private readonly token: string,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let needsSetup: boolean;
    try {
      // The same `SECURITY DEFINER` read `GET /auth/setup` publishes — a
      // plain count as `app_web` would return zero rows on *any* instance
      // (D-2), so the token would be printed on every boot forever.
      const rows = (await this.db.execute(
        sql`select setup_needed() as "needsSetup"`,
      )) as unknown as { needsSetup: boolean }[];
      needsSetup = rows[0]?.needsSetup === true;
    } catch (error) {
      rootLogger().error("api: could not read setup_needed() at boot; no setup token announced", {
        component: "api",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!needsSetup) return;

    rootLogger().info(`${SETUP_TOKEN_LOG_PREFIX}${this.token}`, { component: "api" });
  }
}
