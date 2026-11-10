import { Writable } from "node:stream";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { createLogger, setRootLoggerForTest } from "@kerdial/platform-logging";
import { deferred, waitUntil } from "@kerdial/platform-test-support";
import { buildApp } from "./app.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { SETUP_TOKEN_ENV_VAR, SETUP_TOKEN_LOG_PREFIX } from "./auth/setup-token.js";
import { rawCookieValue } from "./test-support/http.js";

/**
 * T-89 — the HTTP-level
 * suite for `GET`/`POST /auth/setup`: AC-355, AC-357–AC-362.
 *
 * **Six databases, one per describe, deliberately.** `startTestApp()` hands out an independent
 * migrated database per call (a template clone under `TEST_SHARED_PG=1`), and
 * this suite needs that: first-run setup is defined only against an instance
 * with no `app_user` row at all, so a describe that provisions one cannot
 * share a database with a describe whose subject is the empty state. The
 * recorded trap is specific — "an earlier `it()` in the same file already
 * seeded the state the mutation was supposed to disturb" is one of the three
 * ways a red-confirm fails to redden without the assertion being unsound, and
 * AC-355's whole subject is what happens on an instance nobody has claimed
 * yet.
 *
 * **The two concurrency shapes are not interchangeable**. AC-355
 * is a *burst*: two genuinely concurrent `POST`s, proving the FR-401 advisory
 * lock inside `provision_account`. AC-362 is a *sustained sequential walk*:
 * one request at a time, each awaited, proving `withLoginRateLimit`'s per-IP
 * backoff. A concurrency cap can never fire on the second shape and a rate cap
 * would ruin the first, so neither test substitutes for the other — this is
 * this repo's own recorded "rate cap vs concurrency cap look identical to a
 * burst test" lesson, written as two tests with two different constructions.
 *
 * **AC-355 must still see `[200, 409]`, never a `429`**.
 * `POST /auth/setup` now carries the anonymous public-write caps
 * (`publicWritePerClientThrottleInterceptor`, and an outer
 * instance-wide one beside it), whose per-client ceiling of 2 was chosen *by*
 * this test: two genuinely concurrent setups **from one address** — which is
 * what these two are, both arriving from the test process's own socket — are
 * exactly what it admits, so the FR-401 advisory lock stays the thing that
 * decides the loser. A third concurrent call would be refused, which is
 * the point of the cap and is proven in
 * `public-write-throttle.e2e.test.ts` rather than here.
 *
 * **AC-355's burst is a rendezvous at the database, not a timing hope.**
 * Two `Promise.all`ed `POST`s are *not* by themselves a race:
 * `provisionAccount` awaits ~40-100 ms of Argon2id hashing before its single,
 * sub-millisecond `select provision_account(...)`, so the two statements
 * essentially never overlap and the suite stayed green 5/5 with the FR-401
 * advisory lock deleted. The test therefore parks both requests *inside* the
 * function before letting either finish: the owner client holds
 * `LOCK TABLE tenant IN ACCESS EXCLUSIVE MODE` in an open transaction, and
 * the barrier is released only once `pg_stat_activity` shows *both* backends
 * waiting on a lock. The timing is then gone from the assertion entirely.
 *
 * **The barrier is taken on `tenant`, and it has to be.**
 * It used to be `app_user`, whose `ACCESS SHARE` the emptiness check needs.
 * `provisionAccount` now reads `setup_needed()` *before* it hashes (so a
 * public call against a provisioned instance costs no Argon2id), and that
 * read touches `app_user` too — an `app_user` barrier therefore parked both
 * requests one statement *before* `provision_account`, where the rendezvous
 * poller cannot see them (their `query` is the pre-check) and where releasing
 * the barrier would hand the race back to timing. `tenant` is touched by
 * nothing on this path except `provision_account`'s own first `INSERT`, which
 * sits **after** the FR-401 advisory lock and after the emptiness check. So
 * the two backends park exactly where they must: the winner on the `tenant`
 * lock holding the advisory lock, the loser on the advisory lock — and with
 * the advisory lock deleted, both on the `tenant` lock, past an emptiness
 * check that (correctly, at that instant) found nothing. Both shapes report
 * `wait_event_type = 'Lock'` with `provision_account` as the top-level query,
 * which is what the poller counts.
 *
 * **Red-confirms actually observed** (2026-09-19, this worktree):
 *  - AC-355 — `PERFORM pg_advisory_xact_lock(4277075, 0);` commented out of
 *    `platform/db/migrations/0065_account-setup-guard-functions.sql`, nothing
 *    else touched: both parked requests pass the emptiness check together
 *    when the barrier lifts, and this test failed **3 runs out of 3** with
 *    `expected [ 200, 200 ] to strictly equal [ 200, 409 ]`. Restored
 *    byte-identically, green 3 runs out of 3. (The earlier construction —
 *    the same two `POST`s with no barrier — passed 5/5 against that same
 *    mutation; the rendezvous is what makes this a regression detector.)
 *  - AC-357 — `setup_needed()` replaced by `(select count(*) from app_user)
 *    = 0` (D-2's trap): the describe below whose user is seeded **directly**
 *    kept answering `needsSetup: true` (`expected true to be false`).
 *  - AC-358 — the `55000` arm of `auth.controller.ts`'s `setupFailureFor`
 *    re-pointed at `500`: the second setup answered `500` and this suite
 *    reddened with `expected 500 to be 409`.
 *  - the `NEW_PASSWORD_MIN_LENGTH` floor — lowered to 7 in `setup.schema.ts`:
 *    the seven-character body was accepted and the 400 assertion reddened.
 */

/**
 * Every `POST /auth/setup` in this file now carries a
 * `setupToken`, so the suite needs to know what the app under test will
 * accept.
 *
 * **Via `SETUP_TOKEN`, not via a hook into the built app.** The env var is
 * the *shipped* override (the scripted first-run path an operator uses),
 * `setup-token.ts` reads it at provider construction, and every app
 * `startTestApp()` builds in this file therefore holds exactly this value.
 * Exposing the resolved token on `BuiltApp` would have been a second,
 * test-only way in — a surface that exists only to be asserted against, and
 * one the deployed process would not have.
 *
 * The one describe that must see the *generated* token deletes the variable
 * for its own app and reads the real thing out of the boot log instead,
 * which is the only construction that can prove the logged value is the
 * value the route accepts.
 */
const FIXED_SETUP_TOKEN = "fixed-setup-token-for-the-api-suite";

beforeAll(() => {
  process.env[SETUP_TOKEN_ENV_VAR] = FIXED_SETUP_TOKEN;
});

afterAll(() => {
  delete process.env[SETUP_TOKEN_ENV_VAR];
});

/** Extracts one raw `Set-Cookie` line (with its attributes) by cookie name. */
function rawCookie(setCookie: readonly string[] | undefined, name: string): string | undefined {
  return setCookie?.find((cookie) => cookie.startsWith(`${name}=`));
}

/**
 * The attribute half of a `Set-Cookie` line — everything after `name=value`,
 * normalised for order-independent comparison. AC-360 asks whether
 * `POST /auth/setup` issues *the same cookies* `POST /auth/login` does; the
 * values necessarily differ (different sessions), the attributes must not.
 */
function cookieAttributes(raw: string | undefined): string[] {
  if (raw === undefined) return ["<missing>"];
  return raw
    .split(";")
    .slice(1)
    .map((part) => part.trim())
    .sort();
}

async function countRows(app: TestApp, table: "tenant" | "app_user"): Promise<number> {
  const rows =
    table === "tenant"
      ? await app.ownerClient`select count(*)::int as n from "tenant"`
      : await app.ownerClient`select count(*)::int as n from "app_user"`;
  return (rows[0] as { n: number }).n;
}

/**
 * How many backends of *this suite's own database* are parked on a lock
 * inside `provision_account` — the rendezvous signal AC-355's barrier waits
 * for.
 *
 * `datname = current_database()` is not optional: under `TEST_SHARED_PG=1`
 * every suite in the run shares one Postgres instance, so an unfiltered
 * `pg_stat_activity` would count somebody else's blocked backend. `query`
 * carries the *top-level* statement even while execution is suspended inside
 * the plpgsql body, so it identifies the two requests precisely; the poller's
 * own row is excluded by `pid`, and every idle pooled connection (the barrier
 * transaction included) reports `wait_event_type = 'Client'` rather than
 * `'Lock'`.
 *
 * With the FR-401 advisory lock present the two backends wait on two
 * different things — one on the relation lock (it holds the advisory lock and
 * wants to read `app_user`), the other on the advisory lock — and without it
 * both wait on the relation lock. `wait_event_type = 'Lock'` is what both
 * shapes have in common, which is what makes this predicate work for the
 * green *and* the red.
 */
async function countBlockedInProvisionAccount(client: TestApp["ownerClient"]): Promise<number> {
  const rows = await client`
    select count(*)::int as n
      from pg_stat_activity
     where datname = current_database()
       and pid <> pg_backend_pid()
       and wait_event_type = 'Lock'
       and query like '%provision_account%'
  `;
  return (rows[0] as { n: number }).n;
}

describe("api — AC-355: two concurrent POST /auth/setup on one empty instance", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  it("produces exactly one 200 and one 409, and exactly one tenant and one user", async () => {
    // Warm-up, and the precondition in one: four concurrent public reads open
    // several pooled `app_web` connections before the race (so the two `POST`s
    // below reach Postgres without first paying a cold TLS/auth handshake),
    // and every one of them must report an unclaimed instance.
    // `test-app.ts:109`'s `max: 20` is what makes this safe:
    // `withLoginRateLimit` holds two connections per attempt, this test holds
    // two attempts at once, and both of those attempts sit blocked on the
    // barrier below while still holding theirs.
    const warmups = await Promise.all([
      server().get("/api/v1/auth/setup"),
      server().get("/api/v1/auth/setup"),
      server().get("/api/v1/auth/setup"),
      server().get("/api/v1/auth/setup"),
    ]);
    expect(warmups.map((r) => r.status)).toStrictEqual([200, 200, 200, 200]);
    expect(warmups.map((r) => r.body.needsSetup)).toStrictEqual([true, true, true, true]);
    expect([
      await countRows(testApp, "tenant"),
      await countRows(testApp, "app_user"),
    ]).toStrictEqual([0, 0]);

    // The barrier (retargeted at `tenant` — see this file's
    // header). `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` conflicts with the
    // `ROW EXCLUSIVE` that `provision_account`'s `INSERT INTO tenant` takes,
    // which is the first statement of the function's write half and sits
    // after both the advisory lock and the emptiness check — so both requests
    // are standing inside the function when the lock is lifted. It is taken
    // on the owner client (superuser, `BYPASSRLS`) and held in an open
    // transaction; the `postgres.js` pool hands the polling query below and
    // the later row counts their own connections, so nothing here deadlocks
    // against the held one.
    const lockTaken = deferred<void>();
    const barrierReleased = deferred<void>();
    const barrier = testApp.ownerClient.begin(async (tx) => {
      await tx`lock table "tenant" in access exclusive mode`;
      lockTaken.resolve();
      await barrierReleased.promise;
    });
    // Racing against `barrier` rather than awaiting `lockTaken` alone: a
    // failure to take the lock would otherwise hang here until the test
    // timeout instead of reporting the Postgres error.
    await Promise.race([lockTaken.promise, barrier]);

    // Two *different* emails, so a `23505` on the global unique email index
    // can never be mistaken for the `409` the lock produces, and
    // so the two attempts take different `withLoginRateLimit` advisory-lock
    // keys (`0x4c524c`, hashed on the email — a different namespace from
    // `provision_account`'s `4277075`) and really do run in parallel.
    const responses = Promise.all([
      server().post("/api/v1/auth/setup").send({
        email: "race-one@example.com",
        password: "race-one-passphrase",
        baseCurrency: "EUR",
        setupToken: FIXED_SETUP_TOKEN,
      }),
      server().post("/api/v1/auth/setup").send({
        email: "race-two@example.com",
        password: "race-two-passphrase",
        baseCurrency: "USD",
        setupToken: FIXED_SETUP_TOKEN,
      }),
    ]);
    // Awaited below, after the barrier lifts; this only keeps a transport-level
    // rejection from being reported as an unhandled rejection in the meantime.
    void responses.catch(() => undefined);

    // Wait for both to be parked. 10s is a bound on the rendezvous, not on the
    // race: it sits well under the 15s `statement_timeout` `platform/db`'s
    // client factory applies (`platform/db/src/client.ts`), so a parked
    // statement can never be cancelled out from under the barrier. The barrier
    // is released whether or not the rendezvous was reached, so a failure here
    // fails an assertion instead of hanging the suite's teardown.
    let blocked = 0;
    const parked = await waitUntil(
      async () => {
        blocked = await countBlockedInProvisionAccount(testApp.ownerClient);
        return blocked >= 2;
      },
      10_000,
      50,
    );

    barrierReleased.resolve();
    await barrier;
    const [first, second] = await responses;

    expect(
      parked,
      `expected both POST /auth/setup backends to be blocked inside provision_account within 10s; last saw ${blocked}`,
    ).toBe(true);

    // The multiset, not "at least one 409": both-succeeded and both-failed are
    // the two failures this gate exists to catch, and only an exact multiset
    // rejects both.
    expect([first.status, second.status].sort((a, b) => a - b)).toStrictEqual([200, 409]);

    const loser = first.status === 409 ? first : second;
    const winner = first.status === 200 ? first : second;
    expect(loser.body.code).toBe("SETUP_ALREADY_DONE");
    expect(winner.body).toStrictEqual({
      tenantId: expect.any(String),
      userId: expect.any(String),
    });

    expect([
      await countRows(testApp, "tenant"),
      await countRows(testApp, "app_user"),
    ]).toStrictEqual([1, 1]);
  }, 60_000);
});

describe("api — GET/POST /auth/setup on an unclaimed instance (AC-357, AC-359, AC-360, AC-361)", () => {
  let testApp: TestApp;

  const email = "first-owner@example.com";
  const password = "first owner passphrase";

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  // Every `POST /auth/setup` that reaches the rate limiter leaves a
  // `login_attempt` row behind, and `auth.e2e.test.ts` clears them for the
  // same reason: without this, one test's failed attempt imposes the backoff
  // on the next, unrelated test. The AC-362 describe below deliberately does
  // **not** do this — the history is its subject.
  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  let issued: { tenantId: string; userId: string; setCookie: string[] };

  it("AC-357 (first half) — an empty instance reports needsSetup: true and publishes the currency list", async () => {
    const response = await server().get("/api/v1/auth/setup");

    expect(response.status).toBe(200);
    expect(response.body.needsSetup).toBe(true);

    // LD-1: the currency list is this route's own field, so the setup form
    // never needs the session-guarded `GET /currencies`. Asserted as a real,
    // populated reference set (an empty array would satisfy "has a currencies
    // field" while making the screen unusable).
    const currencies = response.body.currencies as { code: string; name: string }[];
    expect(currencies.length).toBeGreaterThan(100);
    expect(currencies).toContainEqual(
      expect.objectContaining({ code: "EUR", name: expect.any(String) }),
    );
  });

  it("FR-397/FR-399 — POST provisions the instance and logs the new owner straight in", async () => {
    const response = await server()
      .post("/api/v1/auth/setup")
      .send({ email, password, baseCurrency: "EUR", setupToken: FIXED_SETUP_TOKEN });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      tenantId: expect.any(String),
      userId: expect.any(String),
    });

    const setCookie = response.headers["set-cookie"] as string[] | undefined;
    expect(rawCookieValue(setCookie, SID_COOKIE_NAME)).toBeDefined();
    expect(rawCookieValue(setCookie, CSRF_COOKIE_NAME)).toBeDefined();

    issued = {
      tenantId: response.body.tenantId as string,
      userId: response.body.userId as string,
      setCookie: setCookie ?? [],
    };
  }, 30_000);

  it("AC-359 — the account the setup path created is the instance admin, read straight from the row", async () => {
    const rows = await testApp.ownerClient`
      select "is_instance_admin" as "isInstanceAdmin", "tenant_id" as "tenantId"
        from "app_user" where "id" = ${issued.userId}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { isInstanceAdmin: boolean }).isInstanceAdmin).toBe(true);
    expect((rows[0] as { tenantId: string }).tenantId).toBe(issued.tenantId);
  });

  it("AC-361 — the returned cookies authenticate GET /auth/me, and the identity matches", async () => {
    const sid = rawCookieValue(issued.setCookie, SID_COOKIE_NAME);
    const response = await server()
      .get("/api/v1/auth/me")
      .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      tenantId: issued.tenantId,
      userId: issued.userId,
      email,
      // FR-396: the base currency the setup body chose really did land on the
      // tenant, not merely pass validation.
      baseCurrency: "EUR",
    });
  });

  it("AC-360 — both cookies carry the same attributes POST /auth/login issues, attribute by attribute", async () => {
    const loginResponse = await server().post("/api/v1/auth/login").send({ email, password });
    expect(loginResponse.status).toBe(200);
    const loginCookies = loginResponse.headers["set-cookie"] as string[] | undefined;

    // Both cookies present on both responses — the comparison below is
    // vacuous if either side is missing, so `cookieAttributes` maps a missing
    // cookie to a sentinel rather than to an empty (and therefore matching)
    // list, and both sides are asserted non-sentinel here.
    for (const name of [SID_COOKIE_NAME, CSRF_COOKIE_NAME]) {
      expect(rawCookie(issued.setCookie, name), `setup ${name}`).toBeDefined();
      expect(rawCookie(loginCookies, name), `login ${name}`).toBeDefined();
    }

    expect(cookieAttributes(rawCookie(issued.setCookie, SID_COOKIE_NAME))).toStrictEqual(
      cookieAttributes(rawCookie(loginCookies, SID_COOKIE_NAME)),
    );
    expect(cookieAttributes(rawCookie(issued.setCookie, CSRF_COOKIE_NAME))).toStrictEqual(
      cookieAttributes(rawCookie(loginCookies, CSRF_COOKIE_NAME)),
    );

    // …and the attributes are the specified ones, not merely equal to each
    // other: two identically-broken cookies would pass the comparison above.
    expect(cookieAttributes(rawCookie(issued.setCookie, SID_COOKIE_NAME))).toStrictEqual(
      expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]),
    );
    expect(cookieAttributes(rawCookie(issued.setCookie, CSRF_COOKIE_NAME))).toStrictEqual(
      expect.arrayContaining(["Secure", "SameSite=Lax", "Path=/"]),
    );
    expect(cookieAttributes(rawCookie(issued.setCookie, CSRF_COOKIE_NAME))).not.toContain(
      "HttpOnly",
    );
  }, 30_000);

  it("AC-357 (second half) — the same instance now reports needsSetup: false", async () => {
    const response = await server().get("/api/v1/auth/setup");
    expect(response.status).toBe(200);
    expect(response.body.needsSetup).toBe(false);
  });
});

describe("api — POST /auth/setup on an instance that already has a user (AC-357, AC-358)", () => {
  let testApp: TestApp;

  const seededTenant = "00000000-0000-7000-8000-00000055a000";
  const seededUser = "00000000-0000-7000-8000-00000055a001";

  beforeAll(async () => {
    testApp = await startTestApp();
    // Seeded **directly**, never through `POST /auth/setup`: AC-357's false
    // state must not depend on this cycle's own write path being correct.
    await testApp.ownerDb.insert(tenant).values([{ id: seededTenant }]);
    await createUser(testApp.db, {
      id: seededUser,
      tenantId: seededTenant,
      email: "already-here@example.com",
      password: "already here passphrase",
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  it("AC-357 — reports needsSetup: false (the D-2 trap: a bare app_web count would say true)", async () => {
    const response = await server().get("/api/v1/auth/setup");
    expect(response.status).toBe(200);
    expect(response.body.needsSetup).toBe(false);
  });

  it("AC-358 — refuses with 409 SETUP_ALREADY_DONE and writes nothing", async () => {
    const before = [await countRows(testApp, "tenant"), await countRows(testApp, "app_user")];

    const response = await server().post("/api/v1/auth/setup").send({
      email: "second-owner@example.com",
      password: "second owner passphrase",
      baseCurrency: "USD",
      setupToken: FIXED_SETUP_TOKEN,
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SETUP_ALREADY_DONE");
    // The status alone would pass if the row had been written and something
    // else answered 409 — the counts are what make this a refusal.
    expect([
      await countRows(testApp, "tenant"),
      await countRows(testApp, "app_user"),
    ]).toStrictEqual(before);
    expect(before).toStrictEqual([1, 1]);
  }, 30_000);
});

describe("api — POST /auth/setup body validation and currency mapping (LD-5, FR-396)", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  afterEach(async () => {
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  it("LD-5 — a seven-character password is refused with a per-field 400, and provisions nothing", async () => {
    // Seven characters, written as a literal rather than derived from
    // `NEW_PASSWORD_MIN_LENGTH`: a length computed from the constant would
    // follow the constant down if someone lowered it, and this assertion
    // would then pass against a schema with the wrong floor. The positive
    // companion below pins the other side — exactly eight is accepted — so
    // the pair says "the floor is 8", not "some floor exists".
    const response = await server().post("/api/v1/auth/setup").send({
      email: "short@example.com",
      password: "7chars!",
      baseCurrency: "EUR",
      setupToken: FIXED_SETUP_TOKEN,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "password", message: expect.stringContaining("8") }),
    );
    expect(await countRows(testApp, "app_user")).toBe(0);
  });

  it("a whitespace-only email and an email with an internal space are both a per-field 400, and provision nothing", async () => {
    // `emailField` is deliberately not RFC validation (a validator stricter
    // than the user's own mail provider is a lockout). It refuses the two
    // shapes that cannot be an address at all, and `" "` reaches `.min(1)` as
    // `""` because `.trim()` runs first — which is also what keeps a padded
    // address from being *stored* padded.
    for (const email of [" ", "a b@x"]) {
      const response = await server().post("/api/v1/auth/setup").send({
        email,
        password: "shape passphrase",
        baseCurrency: "EUR",
        setupToken: FIXED_SETUP_TOKEN,
      });

      expect(response.status, `email ${JSON.stringify(email)}`).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(response.body.errors).toContainEqual(expect.objectContaining({ field: "email" }));
    }
    expect(await countRows(testApp, "app_user")).toBe(0);
  });

  it("FR-396 — a well-formed but unknown currency is 422 UNKNOWN_CURRENCY, and provisions nothing", async () => {
    // Shape is Zod's job, existence is the FK's: `ZZZ` passes
    // `/^[A-Z]{3}$/` and fails `tenant_base_currency_currency_code_fk`, which
    // is the only way to reach the `23503` arm of the mapper.
    const response = await server().post("/api/v1/auth/setup").send({
      email: "unknown-currency@example.com",
      password: "unknown currency passphrase",
      baseCurrency: "ZZZ",
      setupToken: FIXED_SETUP_TOKEN,
    });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("UNKNOWN_CURRENCY");
    expect([
      await countRows(testApp, "tenant"),
      await countRows(testApp, "app_user"),
    ]).toStrictEqual([0, 0]);
  }, 30_000);

  it("LD-5 — exactly eight characters is accepted, and the instance is then claimed", async () => {
    const response = await server().post("/api/v1/auth/setup").send({
      email: "eight@example.com",
      password: "8chars!!",
      baseCurrency: "EUR",
      setupToken: FIXED_SETUP_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(response.body.userId).toEqual(expect.any(String));
    expect(await countRows(testApp, "app_user")).toBe(1);
  }, 30_000);
});

describe("api — AC-362: repeated failed setup attempts from one IP hit the login backoff", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function setup(email: string) {
    return server()
      .post("/api/v1/auth/setup")
      .send({
        email,
        password: `${email} passphrase`,
        baseCurrency: "EUR",
        setupToken: FIXED_SETUP_TOKEN,
      });
  }

  /** `problem.detail` is `retry after <n>ms` — the same string `login()` produces. */
  function retryAfterMs(detail: unknown): number {
    const match = /retry after (\d+)ms/.exec(String(detail));
    if (!match) throw new Error(`no retry-after in detail: ${String(detail)}`);
    return Number(match[1]);
  }

  it("is a rate control, not a concurrency one: a sequential walk of 409s earns a 429 that expires", async () => {
    // **Sequential, one at a time, every call awaited.** That is the whole
    // discrimination: a concurrency cap (this repo has eight of them) can
    // never fire on a walk with one request in flight, so a 429 here can only
    // come from `withLoginRateLimit`. Three different emails, so the shared
    // key is the IP — `login-rate-limit.ts`'s per-email hard lockout is a
    // different mechanism and is not what this reproduces.
    const claimed = await setup("backoff-owner@example.com");
    expect(claimed.status).toBe(200);

    // First failure after the success: the streak is empty, so no backoff yet
    // — it is this 409 that becomes the history the next call is measured
    // against (FR-402: a 409 counts as a failed attempt).
    const firstFailure = await setup("backoff-two@example.com");
    expect(firstFailure.status).toBe(409);
    expect(firstFailure.body.code).toBe("SETUP_ALREADY_DONE");

    const throttled = await setup("backoff-three@example.com");
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("LOGIN_RATE_LIMITED");
    // `LOGIN_BACKOFF_BASE_MS * 2^0` after one consecutive failure: at most a
    // second, and strictly positive.
    const wait = retryAfterMs(throttled.body.detail);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1_000);

    // …and it *expires*, which is what makes it a backoff rather than a
    // block: after the advertised delay the same call is answered by the
    // setup path again (409), not by the limiter.
    await new Promise((resolve) => setTimeout(resolve, wait + 250));
    const afterBackoff = await setup("backoff-three@example.com");
    expect(afterBackoff.status).toBe(409);
    expect(afterBackoff.body.code).toBe("SETUP_ALREADY_DONE");
  }, 60_000);
});

/* =========================================================================
 * The one-time setup token
 * ====================================================================== */

/**
 * **Red-confirms actually observed (2026-09-19, this worktree).**
 *
 *  - `setup-token.ts`'s `setupTokenMatches` made unconditionally `true`
 *    (both arms), nothing else touched: the wrong-token case was accepted
 *    and the three behavioural tests below failed — `expected 200 to be
 *    403`, then `expected 409 to be 403` (the instance had already been
 *    claimed by the first wrong token), then `expected 409 to be 200`.
 *    Restored, green.
 *  - The announcement suppressed (an early `return` before
 *    `rootLogger().info(...)`): this describe's `beforeAll` failed by name
 *    with `Error: no setup-token line was emitted at boot`, taking the whole
 *    describe with it. Restored, green.
 */
describe("api — POST /auth/setup requires the one-time setup token", () => {
  let testApp: TestApp;
  /** Every line the process's logger actually emitted while this describe's app was built. */
  let emitted: string[];
  let restoreLogger: () => void;
  /** Read out of the boot line, not out of the code that produced it. */
  let announcedToken: string;

  /**
   * **The sink is installed before the app is built**, because the line
   * under test is emitted during `buildApp`'s own `app.init()` — a logger
   * swapped in afterwards would see nothing and every assertion below would
   * be about an empty array.
   *
   * **`SETUP_TOKEN` is deleted for this describe**, unlike the rest of the
   * file: the subject here is the *generated* token, and the only way to
   * prove that what the log prints is what the route accepts is to let the
   * process generate one nobody in this file knows and then use the printed
   * value to claim the instance.
   */
  beforeAll(async () => {
    delete process.env[SETUP_TOKEN_ENV_VAR];
    emitted = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        emitted.push(chunk.toString("utf8"));
        callback();
      },
    });
    restoreLogger = setRootLoggerForTest(createLogger({ destination, level: "debug" }));
    testApp = await startTestApp();

    const line = announcementLines(emitted)[0];
    if (line === undefined) throw new Error("no setup-token line was emitted at boot");
    announcedToken = tokenFrom(line);
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
    restoreLogger();
    process.env[SETUP_TOKEN_ENV_VAR] = FIXED_SETUP_TOKEN;
  }, 30_000);

  afterEach(async () => {
    // Every wrong token is a recorded failed attempt (that is the point);
    // left in place it would impose the backoff on the next test.
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  /** The emitted records whose `msg` is the announcement — parsed as JSON, never matched against the raw buffer. */
  function announcementLines(lines: readonly string[]): { level: string; msg: string }[] {
    return lines
      .flatMap((line) => line.split("\n"))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { level: string; msg: string })
      .filter((record) => record.msg.startsWith(SETUP_TOKEN_LOG_PREFIX));
  }

  function tokenFrom(record: { msg: string }): string {
    return record.msg.slice(SETUP_TOKEN_LOG_PREFIX.length);
  }

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function setup(token: string) {
    return server().post("/api/v1/auth/setup").send({
      email: "token-owner@example.com",
      password: "token owner passphrase",
      baseCurrency: "EUR",
      setupToken: token,
    });
  }

  it("announces the token exactly once at boot, at info level, on an unclaimed instance", () => {
    const lines = announcementLines(emitted);
    expect(lines).toHaveLength(1);
    // The level as this project's own logger writes it (`createLogger`
    // formats it as a label, not pino's raw 30) — read off the emitted
    // record, which is the whole point of reading a real line rather than
    // spying on the call: `platform/logging`'s allow-list drops unknown
    // *fields*, and an assertion on what the emitter passed would not see
    // that happen.
    expect(lines[0]!.level).toBe("info");
    // 32 random bytes, base64url: 43 characters, no padding. Asserted as a
    // shape rather than a value — the value is unknown to this file by
    // construction.
    expect(announcedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a wrong token with 403 SETUP_TOKEN_INVALID and provisions nothing", async () => {
    const response = await setup(`${announcedToken}x`.slice(1));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("SETUP_TOKEN_INVALID");
    // The status alone would pass against a route that provisioned the
    // account and then answered 403 — the counts are what make it a refusal.
    expect([
      await countRows(testApp, "tenant"),
      await countRows(testApp, "app_user"),
    ]).toStrictEqual([0, 0]);
    // …and the instance is still claimable, which is the property the
    // refusal exists to preserve.
    const state = await server().get("/api/v1/auth/setup");
    expect(state.body.needsSetup).toBe(true);
  }, 30_000);

  it("counts a wrong token toward the same sequential backoff a 409 earns (AC-362's shape)", async () => {
    // Sequential, every call awaited: the public-write concurrency caps
    // (2 per client address, 8 instance-wide) can never fire with one
    // request in flight, so the 429 below
    // can only come from `withLoginRateLimit` — and it can only come at all
    // if the 403 was *returned* out of `attempt()` rather than thrown
    // through it (which would roll the recorded attempt back).
    const first = await setup("definitely-not-the-token");
    expect(first.status).toBe(403);

    const throttled = await setup("definitely-not-the-token-either");
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("LOGIN_RATE_LIMITED");
    expect(await countRows(testApp, "app_user")).toBe(0);
  }, 30_000);

  it("accepts the token the boot line printed, and that claims the instance", async () => {
    const response = await setup(announcedToken);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      tenantId: expect.any(String),
      userId: expect.any(String),
    });
    expect([
      await countRows(testApp, "tenant"),
      await countRows(testApp, "app_user"),
    ]).toStrictEqual([1, 1]);
  }, 30_000);

  it("announces nothing at boot once the instance is claimed", async () => {
    // A second real app on the *same*, now-provisioned database — the only
    // construction that exercises the boot hook's `setup_needed()` branch in
    // the state that matters. Everything else is `startTestApp`'s own wiring
    // (`staticRoot: null` for the reason that helper documents).
    const before = announcementLines(emitted).length;
    expect(before).toBe(1);

    const second = await buildApp({
      db: testApp.db,
      csrfSecret: "second-app-csrf-secret-for-the-boot-line-test",
      staticRoot: null,
    });
    await second.app.close();

    expect(announcementLines(emitted)).toHaveLength(before);
  }, 60_000);
});
