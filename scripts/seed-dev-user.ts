/**
 * Local-development seed: creates the dev tenant and one login-able user, and
 * — with `--reset-password` — re-hashes an existing user's password.
 *
 * Why this exists, now that a signup path does. The first-run setup screen
 * (`/login` when `GET /auth/setup` answers `needsSetup: true`, FR-395/FR-405)
 * is the **normal** way to create the first account, and an instance admin
 * provisions every later one from « Utilisateurs ». This script is the two
 * cases that screen cannot serve (NG9):
 *
 *   1. the from-scratch / CI path — a fresh database, no browser, one command
 *      (`scripts/dev-up.sh`'s step 4/4 calls exactly this, with no flags);
 *   2. the sole instance admin's own lock-out recovery — the product has no
 *      password-reset-by-email (FR-46 is still deferred) and no peer who could
 *      reset it, so `--reset-password` is the only way back in (FR-425/FR-437).
 *
 * It uses the real `@kerdial/platform-auth` `hashPassword`/`createUser`
 * (Argon2id, same parameters as production) rather than hand-inserting a hash,
 * so the seeded credentials behave exactly like real ones. The seeded user is
 * an **instance admin** (`is_instance_admin = true`, FR-439), so a fresh local
 * environment reaches « Utilisateurs » without going through the setup screen.
 *
 * Idempotent: re-running against a database that already has the tenant/user
 * reports that fact and exits 0 instead of failing.
 *
 * Usage (see docs/run-local.md — normally invoked via scripts/dev-up.sh):
 *   DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres \
 *   DEV_USER_EMAIL=you@example.com DEV_USER_PASSWORD=... \
 *   pnpm exec tsx scripts/seed-dev-user.ts
 *
 *   # lock-out recovery: re-hash an existing user's password, create nothing
 *   DATABASE_URL=... DEV_USER_PASSWORD=the-new-one \
 *   pnpm exec tsx scripts/seed-dev-user.ts --reset-password you@example.com
 *
 * **DATABASE_URL must be the postgres superuser.** Not `app_owner`: `app_user`
 * is `ENABLE`+`FORCE` RLS with a single policy granted `TO app_web`
 * (`0007_auth-and-rls.sql`), so an `app_owner` connection has no applicable
 * policy and its `INSERT` fails the `WITH CHECK` with *"new row violates
 * row-level security policy for table app_user"* — measured directly on a
 * migrated database, 2026-09-19, not reasoned from the policy text. The same
 * is why `--reset-password` updates through the raw superuser client handle:
 * the superuser is the one role that both bypasses RLS and does not need
 * `app_web`'s session-variable contract. `app_web` itself deliberately cannot
 * create tenants at all.
 */
import { createDb, createPostgresClient } from "@kerdial/platform-db";
import { createUser, hashPassword } from "@kerdial/platform-auth";

const DEV_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";

/**
 * `--reset-password <email>` or nothing. Deliberately a hand-rolled two-token
 * read rather than a parser: the default path must stay exactly what it was
 * (LD-9/AC-392 — `dev-up.sh` passes no arguments and must not change
 * behaviour), so an unrecognised argument is an error rather than something
 * that could silently re-route the create path.
 */
function parseResetPasswordEmail(argv: readonly string[]): string | undefined {
  const args = argv.slice(2);
  if (args.length === 0) return undefined;
  if (args[0] !== "--reset-password" || args.length !== 2) {
    throw new Error("seed-dev-user: usage: [--reset-password <email>]");
  }
  return args[1];
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("seed-dev-user: DATABASE_URL is required");

  const resetEmail = parseResetPasswordEmail(process.argv);

  const email = process.env["DEV_USER_EMAIL"] ?? "dev@localhost";
  const password = process.env["DEV_USER_PASSWORD"];
  if (!password) throw new Error("seed-dev-user: DEV_USER_PASSWORD is required (pick one)");

  const client = createPostgresClient(databaseUrl);
  const db = createDb(client);

  if (resetEmail !== undefined) {
    // Recovery only: no `tenant` insert, no `createUser`, nothing created. The
    // `RETURNING` is what distinguishes "updated" from "no such user" — a bare
    // UPDATE reports zero rows the same way it reports success.
    //
    // **The revocation is part of the same transaction.**
    // Rotating the hash used to leave every session of that account live, so
    // whoever the recovery was aimed at — a stolen laptop, a shared browser,
    // an attacker with the old password — stayed signed in with a cookie the
    // new password has no bearing on. The admin reset route has revoked the
    // target's sessions since `0065` (now an RLS-scoped UPDATE); this
    // path is the one reset that does not go through it, and it does the same. One transaction, so an
    // interrupted run can never leave the new hash stored with the old
    // sessions still valid.
    const passwordHash = await hashPassword(password);
    const outcome = await client.begin(async (tx) => {
      const updated = await tx`
        UPDATE app_user SET password_hash = ${passwordHash} WHERE email = ${resetEmail}
        RETURNING id
      `;
      if (updated.length === 0) return undefined;
      const revoked = await tx`
        UPDATE session SET revoked_at = now()
         WHERE user_id = ${updated[0]!["id"] as string} AND revoked_at IS NULL
        RETURNING id
      `;
      return { revoked: revoked.length };
    });
    if (outcome === undefined) {
      console.error(`seed-dev-user: no such user ${resetEmail} — nothing was changed.`);
      process.exitCode = 1;
    } else {
      console.log(
        `seed-dev-user: reset the password of ${resetEmail}, revoked ${String(outcome.revoked)} session(s).`,
      );
    }
    await client.end();
    return;
  }

  await client`
    INSERT INTO tenant (id)
    VALUES (${DEV_TENANT_ID})
    ON CONFLICT (id) DO NOTHING
  `;

  const existing = await client`
    SELECT 1 FROM app_user WHERE tenant_id = ${DEV_TENANT_ID}::uuid AND email = ${email}
  `;
  if (existing.length > 0) {
    console.log(`seed-dev-user: user ${email} already exists — nothing to do.`);
  } else {
    await createUser(db, {
      id: DEV_USER_ID,
      tenantId: DEV_TENANT_ID,
      email,
      password,
      isInstanceAdmin: true,
    });
    console.log(`seed-dev-user: created tenant ${DEV_TENANT_ID} user ${email}.`);
  }

  await client.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
