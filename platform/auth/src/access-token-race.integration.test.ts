import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { createDb, tenant, type Db } from "@kerdial/platform-db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_TOKEN_MAX_ACTIVE, issueAccessToken } from "./access-token.js";
import { createUser, login } from "./auth-service.js";

/**
 * MCP-L3 under real contention: the cap of ten active tokens per user holds
 * when several creates for one user race on separate connections. One racing
 * pair at nine active tokens can pass by scheduling luck without the row lock
 * that serialises the count and the insert, so this runs several rounds of
 * four racers, each over its own warmed `app_web` connection, and demands
 * exactly one winner and exactly ten active rows every time.
 */
describe("platform/auth — the active-token cap under concurrent creates (MCP-L3)", () => {
  const ROUNDS = 8;
  const RACERS = 4;
  const tenantId = "00000000-0000-7000-8000-0000019d0000";
  const password = "a-test-only-passphrase";

  let pg: MigratedPostgres;
  let clients: postgres.Sql[];
  let dbs: Db[];

  const userOf = (round: number): string =>
    `00000000-0000-7000-8000-0000019d${String(round + 1).padStart(4, "0")}`;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    clients = Array.from({ length: RACERS }, () => postgres(pg.appWebUri, { max: 1 }));
    dbs = clients.map((client) => createDb(client));
    await pg.ownerDb.insert(tenant).values({ id: tenantId });
    for (let round = 0; round < ROUNDS; round += 1) {
      await createUser(pg.ownerDb, {
        id: userOf(round),
        tenantId,
        email: `racer-${round}@example.com`,
        password,
      });
    }
    // Warm every connection before any race: a lazy connection would start its create late.
    await Promise.all(clients.map((client) => client`select 1`));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(clients?.map((client) => client.end({ timeout: 5 })) ?? []);
    await pg?.stop();
  }, 30_000);

  it("four simultaneous creates at nine active tokens: exactly one wins, in every one of eight rounds", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const userId = userOf(round);
      const session = await login(dbs[0]!, { email: `racer-${round}@example.com`, password });
      const sessionId = session!.sessionId;
      const create = (db: Db) =>
        issueAccessToken(db, { tenantId, userId, sessionId, label: "racer", expiresInDays: 30 });
      for (let i = 0; i < ACCESS_TOKEN_MAX_ACTIVE - 1; i += 1) {
        expect((await create(dbs[0]!)).ok, `round ${round} setup ${i}`).toBe(true);
      }

      const results = await Promise.all(dbs.map((db) => create(db)));

      expect(
        results.filter((result) => result.ok),
        `round ${round}`,
      ).toHaveLength(1);
      expect(
        results.filter((result) => !result.ok),
        `round ${round}`,
      ).toEqual(Array.from({ length: RACERS - 1 }, () => ({ ok: false, reason: "LIMIT_REACHED" })));
      const [active] = await pg.ownerClient<{ n: number }[]>`
        SELECT count(*)::int AS n FROM personal_access_token
         WHERE user_id = ${userId} AND revoked_at IS NULL
      `;
      expect(active!.n, `round ${round}`).toBe(ACCESS_TOKEN_MAX_ACTIVE);
    }
  }, 180_000);
});
