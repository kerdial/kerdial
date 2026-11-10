import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "./password.js";

/**
 * T-100 — `scripts/seed-dev-user.ts`
 * end to end, as a real child process against a real migrated database.
 *
 * **Why the script itself and not an extracted function.** What AC-390/AC-391/
 * AC-392 are about is the *script*: its argv parsing, which of the two paths it
 * takes, what it writes, and its exit code. Importing a helper out of it would
 * test everything except that. So this spawns `node --import tsx scripts/seed-dev-user.ts`
 * with `DATABASE_URL` pointed at this suite's own database — the same
 * superuser connection `scripts/dev-up.sh` gives it — and reads the rows back
 * with an independent client.
 *
 * **Why it lives here and not next to the script.** `vitest.config.ts`'s
 * `include` list names package source trees (`platform/**\/src/**\/*.test.ts`
 * among them) and does **not** cover the repo-root `scripts/` directory, so a
 * test file placed beside the script would never be collected — silently,
 * with a clean exit code (the recorded `__fixtures__` trap). `platform/auth`
 * is the package whose `createUser`/`hashPassword` the script's two paths are
 * built on, and whose `verifyPassword` is what makes "the hash really changed
 * to the new password" provable rather than merely "the bytes differ".
 *
 * **The order of the four cases is load-bearing** and they are one `it` each in
 * sequence, sharing one database on purpose: case 2's "already exists" answer
 * is only meaningful after case 1 created the row, and the reset cases are only
 * meaningful against a user that exists. Each case that asserts an absence
 * (nothing created, nothing changed) is paired with a positive count — exactly
 * one tenant and exactly one user, never "no extra rows", which is also what a
 * run against an empty database would report.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const script = join(repoRoot, "scripts", "seed-dev-user.ts");

/** The two ids the script hard-codes; AC-390 asks for the assertions to be against this fixture. */
const DEV_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";
const DEV_EMAIL = "dev@localhost";
const FIRST_PASSWORD = "devdevdev";
const RESET_PASSWORD = "a-brand-new-password";

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

describe("scripts/seed-dev-user.ts (T-100, Testcontainers, real child process)", () => {
  let pg: MigratedPostgres;
  let owner: postgres.Sql;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    owner = pg.ownerClient;
  }, 120_000);

  afterAll(async () => {
    await pg.stop();
  });

  /**
   * `node --import tsx`, not `pnpm exec tsx`: a package-manager wrapper in
   * between would report *its* exit code, and the non-zero exit is one of the
   * things under test (AC-390's "no such user" arm).
   */
  function runSeed(args: readonly string[], password: string): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: pg.ownerUri, DEV_USER_PASSWORD: password },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function counts(): Promise<{ tenants: number; users: number }> {
    const [row] = await owner`
      SELECT (SELECT count(*) FROM tenant) AS tenants, (SELECT count(*) FROM app_user) AS users
    `;
    return { tenants: Number(row?.["tenants"]), users: Number(row?.["users"]) };
  }

  async function seededUser(): Promise<{ id: string; passwordHash: string; isAdmin: boolean }> {
    const [row] = await owner`
      SELECT id, password_hash, is_instance_admin FROM app_user WHERE email = ${DEV_EMAIL}
    `;
    if (row === undefined)
      throw new Error("no seeded user — the fixture is not in the state the test assumes");
    return {
      id: row["id"] as string,
      passwordHash: row["password_hash"] as string,
      isAdmin: row["is_instance_admin"] as boolean,
    };
  }

  /**
   * Inserts one live session for the seeded user and answers its
   * `revoked_at` on demand —'s fixture. A *live* session
   * (`revoked_at IS NULL`, expiry in the future) is the only shape the
   * finding is about: `--reset-password` used to rotate the hash and leave
   * exactly this row usable, so a stolen cookie survived the recovery the
   * lock-out victim had just performed.
   */
  async function seedLiveSession(id: string, tokenByte: string): Promise<void> {
    await owner`
      INSERT INTO session (id, tenant_id, user_id, token_hash, expires_at)
      VALUES (${id}, ${DEV_TENANT_ID}, ${DEV_USER_ID}, ${Buffer.from(tokenByte, "hex")},
              now() + interval '1 day')
    `;
  }

  async function revokedAtOf(id: string): Promise<Date | null> {
    const [row] = await owner`SELECT revoked_at FROM session WHERE id = ${id}`;
    if (row === undefined) throw new Error(`no session ${id} — the fixture is not as assumed`);
    return row["revoked_at"] as Date | null;
  }

  it("with no flags, creates the dev tenant and one INSTANCE-ADMIN user (AC-391, AC-392)", async () => {
    await expect(counts()).resolves.toEqual({ tenants: 0, users: 0 });

    const run = await runSeed([], FIRST_PASSWORD);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`created tenant ${DEV_TENANT_ID} user ${DEV_EMAIL}`);
    await expect(counts()).resolves.toEqual({ tenants: 1, users: 1 });

    const user = await seededUser();
    expect(user.id).toBe(DEV_USER_ID);
    // FR-439/AC-391 — read off the column, not inferred from the script's output.
    expect(user.isAdmin).toBe(true);
    // A real Argon2id hash of the password that was passed in, not a placeholder.
    await expect(verifyPassword(user.passwordHash, FIRST_PASSWORD)).resolves.toBe(true);
  }, 120_000);

  it("re-run with no flags is a no-op that still exits 0 (AC-392, LD-9)", async () => {
    const before = await seededUser();

    const run = await runSeed([], FIRST_PASSWORD);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`user ${DEV_EMAIL} already exists`);
    await expect(counts()).resolves.toEqual({ tenants: 1, users: 1 });
    // Idempotent means untouched, not merely "no second row": a re-run that
    // re-hashed the same password would also leave the counts at 1/1.
    expect((await seededUser()).passwordHash).toBe(before.passwordHash);
  }, 120_000);

  it("--reset-password updates the existing user's hash, revokes the user's live sessions, and creates nothing (AC-390)", async () => {
    const before = await seededUser();
    const liveSessionId = "00000000-0000-0000-0000-0000000005a1";
    await seedLiveSession(liveSessionId, "5a5a");
    // Live going in, asserted rather than assumed: "revoked afterwards" is
    // vacuous against a row that was already revoked.
    expect(await revokedAtOf(liveSessionId)).toBeNull();

    const run = await runSeed(["--reset-password", DEV_EMAIL], RESET_PASSWORD);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`reset the password of ${DEV_EMAIL}`);
    // The count is reported, not just performed: an operator recovering an
    // account is told how many sessions they just cut.
    expect(run.stdout).toContain("revoked 1 session(s)");
    expect(await revokedAtOf(liveSessionId)).not.toBeNull();

    const after = await seededUser();
    // The discriminating assertion: the stored hash verifies the NEW password
    // and no longer verifies the old one. `not.toBe(before)` alone would also
    // pass for a hash rewritten from the same password (Argon2id salts per
    // call), which is the one outcome a reset must not silently produce.
    expect(after.passwordHash).not.toBe(before.passwordHash);
    await expect(verifyPassword(after.passwordHash, RESET_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(after.passwordHash, FIRST_PASSWORD)).resolves.toBe(false);

    // Nothing created, nothing re-keyed: same row, same ids, same counts.
    expect(after.id).toBe(DEV_USER_ID);
    expect(after.isAdmin).toBe(true);
    await expect(counts()).resolves.toEqual({ tenants: 1, users: 1 });
  }, 120_000);

  it("--reset-password for an unknown email reports it, exits non-zero, changes nothing — not one session either", async () => {
    const before = await seededUser();
    const untouchedSessionId = "00000000-0000-0000-0000-0000000005a2";
    await seedLiveSession(untouchedSessionId, "5b5b");

    const run = await runSeed(["--reset-password", "nobody@example.invalid"], "irrelevant");

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("no such user nobody@example.invalid");
    await expect(counts()).resolves.toEqual({ tenants: 1, users: 1 });
    expect((await seededUser()).passwordHash).toBe(before.passwordHash);
    // The revocation is scoped to the user that was actually reset: a run
    // that matched nobody revokes nobody's sessions.
    expect(await revokedAtOf(untouchedSessionId)).toBeNull();
  }, 120_000);
});
