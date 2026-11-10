import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import supertest from "supertest";
import { createDb, type Db } from "@kerdial/platform-db";
import { startMigratedPostgres, type MigratedPostgres } from "@kerdial/platform-test-support";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { HEALTH_CACHE_TTL_MS, INDICATOR_STATE_UNKNOWN } from "./health.js";

/**
 * SH-32 (FR-42/FR-48/FR-49, AC-34) — `GET /health`
 * against a real Postgres.
 *
 * This suite builds its own clients rather than using `test-support/test-app.ts`
 * because two of its acceptance criteria are about the *driver*, not the app:
 * the round-trip count needs `postgres.js`'s `debug` hook (which counts queries
 * as they go on the wire, not calls into a mock), and the forced-failure case
 * needs a client pointed at a port nothing is listening on — a genuinely
 * unreachable database, not a stubbed rejection.
 *
 * **`ops_indicator` now comes from migration `0033`** (`SH-34`, Batch J). This
 * suite used to create the table itself, with its shape copied by
 * hand, because the migration did not exist; that local DDL is gone and the
 * real migration is what these tests read. The two cases that need the table
 * *absent* (the pre-Batch-J deployment shape, and a `42501` with no grant)
 * drop or revoke it explicitly and restore it afterwards, so what they assert
 * is still the real classification path rather than a fixture's.
 */

interface QueryCounter {
  opsIndicatorQueries: number;
}

describe("api — GET /health (SH-32)", () => {
  let pg: MigratedPostgres;
  let ownerClient: postgres.Sql;
  /** DDL-only, notice-silenced: `drop table if exists` emits a NOTICE on every cleanup otherwise. */
  let ddlClient: postgres.Sql;
  let appWebSql: postgres.Sql;
  let appWebDb: Db;
  const counter: QueryCounter = { opsIndicatorQueries: 0 };
  const builtApps: BuiltApp[] = [];
  const clients: postgres.Sql[] = [];

  async function build(options: {
    readonly db?: Db;
    readonly staticRoot?: string | null;
    readonly healthCacheTtlMs?: number | undefined;
  }): Promise<BuiltApp> {
    const built = await buildApp({
      db: options.db ?? appWebDb,
      csrfSecret: randomBytes(32).toString("hex"),
      staticRoot: options.staticRoot ?? null,
      healthCacheTtlMs: options.healthCacheTtlMs,
    });
    builtApps.push(built);
    return built;
  }

  function server(built: BuiltApp): supertest.Agent {
    return supertest(built.app.getHttpServer());
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    ownerClient = pg.ownerClient;
    ddlClient = postgres(pg.ownerUri, { max: 1, onnotice: () => undefined });

    // `debug` is `postgres.js`'s own per-query hook: it fires once per statement
    // actually sent to the server, which is what makes "exactly one round-trip"
    // a counted fact rather than an assertion about a TTL constant.
    appWebSql = postgres(pg.appWebUri, {
      max: 20,
      debug: (_connection, query) => {
        if (query.includes("ops_indicator")) counter.opsIndicatorQueries += 1;
      },
    });
    appWebDb = createDb(appWebSql);
  }, 180_000);

  afterEach(async () => {
    for (const built of builtApps.splice(0)) await built.app.close();
    for (const client of clients.splice(0)) await client.end({ timeout: 5 });
    counter.opsIndicatorQueries = 0;
    // Undo whatever the case just run did to migration `0033`'s table, without
    // ever re-creating it: the two negative cases *hide* it (rename) or
    // *revoke* its grant rather than dropping it, precisely so the object every
    // other test reads is the migration's own and not a fixture's.
    await ddlClient`alter table if exists ops_indicator_sh32_hidden rename to ops_indicator`;
    await ddlClient`grant select on ops_indicator to app_web`;
    await ddlClient`delete from ops_indicator`;
  });

  afterAll(async () => {
    await appWebSql?.end({ timeout: 5 });
    await ddlClient?.end({ timeout: 5 });
    await pg?.stop();
  });

  describe("AC-34 — 200, unauthenticated, outside /api/v1", () => {
    it("answers 200 with the full payload and no credentials of any kind", async () => {
      const built = await build({});
      const response = await server(built).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(response.body.db).toBe("ok");
      expect(Object.keys(response.body.indicators).sort()).toEqual([
        "circuitBreaker",
        "deadLetterDepth",
        "ingestionStaleness",
      ]);
      // SH-34's grant, checked from the reader's side and on a pristine
      // migrated database — this is the first case in the file, so nothing has
      // touched the table yet. "never been swept" is only reachable when the
      // `select` actually succeeded; a migration missing `GRANT SELECT ... TO
      // app_web` would say "no SELECT grant" here instead, and every indicator
      // would be `UNKNOWN` for the wrong reason (Batch I's hand-off note).
      expect(response.body.indicators.ingestionStaleness.detail).toContain(
        "this condition has never been swept",
      );
    });

    it("is not under /api/v1 — the prefixed path is not a route at all", async () => {
      const built = await build({});
      const response = await server(built).get("/api/v1/health");
      expect(response.status).toBe(404);
      // ...and it is the API's own problem+json 404, i.e. it reached Nest.
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });

    it("carries SH-23's no-store and the CSP, like every other response", async () => {
      const built = await build({});
      const response = await server(built).get("/health");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    });

    it("is not shadowed by the SPA fallback — a browser Accept: text/html still gets JSON", async () => {
      // The exact failure `static-tier.ts` excluded `/health` from the fallback
      // to prevent, now that there is a real endpoint to shadow: an index.html
      // 200 here would be a container healthcheck passing while the app is
      // broken.
      const root = await mkdtemp(join(tmpdir(), "health-static-"));
      await writeFile(join(root, "index.html"), "<!doctype html><title>spa</title>", "utf8");
      const built = await build({ staticRoot: root });

      const response = await server(built).get("/health").set("Accept", "text/html");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body.db).toBe("ok");
    });
  });

  describe("indicators", () => {
    it("with no ops_indicator table at all (a deployment behind on migrations) every indicator is UNKNOWN and status is still ok", async () => {
      // `42P01`, reached by hiding the real table rather than by dropping and
      // re-creating one: what is asserted here is `health.ts`'s classification
      // of *the server's own answer*, and an object this test built itself
      // could drift from migration `0033`'s.
      await ddlClient`alter table ops_indicator rename to ops_indicator_sh32_hidden`;
      const built = await build({});
      const response = await server(built).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(response.body.db).toBe("ok");
      for (const key of ["ingestionStaleness", "deadLetterDepth", "circuitBreaker"]) {
        expect(response.body.indicators[key].state).toBe(INDICATOR_STATE_UNKNOWN);
        expect(response.body.indicators[key].detail).toContain("ops_indicator does not exist");
      }
    });

    it("reads real rows once the table exists, and one BREACHED indicator leaves status ok", async () => {
      await ownerClient`
        insert into ops_indicator (indicator_key, state, observed_at, first_breached_at, detail)
        values
          ('ingestionStaleness', 'BREACHED', '2026-08-19T09:00:00Z', '2026-08-19T08:00:00Z', 'newest quote as_of older than 14h'),
          ('deadLetterDepth', 'OK', '2026-08-19T09:00:00Z', null, null)
      `;

      const built = await build({});
      const response = await server(built).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("ok");
      expect(response.body.indicators.ingestionStaleness).toEqual({
        state: "BREACHED",
        observedAt: "2026-08-19T09:00:00.000Z",
        detail: "newest quote as_of older than 14h",
      });
      expect(response.body.indicators.deadLetterDepth.state).toBe("OK");
      // The condition the sweep did not write is UNKNOWN, not OK.
      expect(response.body.indicators.circuitBreaker.state).toBe(INDICATOR_STATE_UNKNOWN);
    });

    it("a table with no SELECT grant for app_web is reported as such, and the database is still ok", async () => {
      // Deliberately revoked — this is what migration `0033` would look like
      // from here if it had created the table and forgotten the
      // `GRANT SELECT ... TO app_web`. `platform/db`'s own SH-34 suite proves
      // the migration really does carry it, connecting as the real role.
      await ddlClient`revoke select on ops_indicator from app_web`;
      const built = await build({});
      const response = await server(built).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.db).toBe("ok");
      expect(response.body.indicators.circuitBreaker.detail).toContain("no SELECT grant");
    });
  });

  describe("forced database failure (AC-34's companion case)", () => {
    it("is degraded/unreachable and STILL 200", async () => {
      // A real unreachable database: port 1 on loopback, where nothing listens.
      const deadSql = postgres("postgres://app_web:nobody@127.0.0.1:1/nothing", {
        max: 1,
        connect_timeout: 2,
        idle_timeout: 1,
        onnotice: () => undefined,
      });
      clients.push(deadSql);
      const built = await build({ db: createDb(deadSql) });

      const response = await server(built).get("/health");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("degraded");
      expect(response.body.db).toBe("unreachable");
      for (const key of ["ingestionStaleness", "deadLetterDepth", "circuitBreaker"]) {
        expect(response.body.indicators[key].state).toBe(INDICATOR_STATE_UNKNOWN);
      }
    }, 30_000);
  });

  describe("the 5-second cache, counted on the wire", () => {
    it("25 concurrent requests inside one window cost exactly one ops_indicator round-trip", async () => {
      const built = await build({});
      // Bind the ephemeral port up front. Supertest lazily calls `listen(0)` on
      // the first request that finds no address, and 25 requests fired in the
      // same tick all find none — 25 concurrent `listen` calls on one
      // `http.Server`, which resets the connections rather than testing
      // anything. One agent over one already-listening server.
      const httpServer = built.app.getHttpServer() as import("node:http").Server;
      await new Promise<void>((resolve) => {
        httpServer.listen(0, resolve);
      });
      const agent = supertest(httpServer);

      // Warm nothing: the very first request is part of the burst, so the count
      // below includes the read the burst itself provoked.
      const responses = await Promise.all(Array.from({ length: 25 }, () => agent.get("/health")));

      for (const response of responses) expect(response.status).toBe(200);
      expect(counter.opsIndicatorQueries).toBe(1);
    });

    it("a request past the window does pay for a second round-trip — the cache expires, it does not freeze", async () => {
      // A short, test-only TTL so this observes expiry without waiting out the
      // real 5 s window (`buildApp`'s `healthCacheTtlMs`, the same test seam
      // `connectionTimeoutMs` uses).
      const built = await build({ healthCacheTtlMs: 50 });

      await server(built).get("/health");
      expect(counter.opsIndicatorQueries).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await server(built).get("/health");

      expect(counter.opsIndicatorQueries).toBe(2);
    });

    it("an app built with no override takes the production TTL — two sequential requests still cost one", async () => {
      // Guards the wiring, not the constant: `buildApp` must actually pass the
      // designed TTL through when nothing overrides it.
      const built = await build({});
      await server(built).get("/health");
      await server(built).get("/health");
      expect(counter.opsIndicatorQueries).toBe(1);
      expect(HEALTH_CACHE_TTL_MS).toBe(5_000);
    });
  });
});
