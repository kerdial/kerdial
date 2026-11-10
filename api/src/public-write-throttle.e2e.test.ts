import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { deferred, waitUntil } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import {
  PUBLIC_WRITE_INSTANCE_PROBLEM_CODE,
  PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE,
  PUBLIC_WRITE_MAX_CONCURRENT_PER_CLIENT,
  PUBLIC_WRITE_PROBLEM_CODE,
} from "./common/public-write-throttle.interceptor.js";
import { SETUP_TOKEN_ENV_VAR } from "./auth/setup-token.js";

/**
 * The cap, and what it is keyed on — the
 * **anonymous concurrency caps** on the two public write routes, proven as
 * concurrency properties rather than asserted as configuration.
 *
 * The finding closed: `POST /auth/login` and `POST /auth/setup` each run
 * Argon2id (64 MiB, ~100 ms) while holding two pooled connections —
 * `withLoginRateLimit`'s own transaction plus the attempt's — and nothing
 * bounded how many anonymous callers could be doing that at once.
 *
 * The finding closed: that cap was keyed on the session's tenant, and
 * neither route ever has a session, so **every** anonymous caller shared one
 * `"__no_session__"` bucket of 2 — one client with two logins in flight
 * answered every other client `429`. The bucket is now `request.ip`, with a
 * second, outer, instance-wide bucket of
 * {@link PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE} so that many addresses still
 * cannot exhaust the pool.
 *
 * ## The construction, and why it is deterministic enough for `test:main`
 *
 * A concurrency cap only refuses a request while others are *still in
 * flight*, and nothing about `Promise.all` forces that overlap — this
 * repo has recorded twice that a burst test
 * without a barrier measures the scheduler, not the cap. So the overlap is
 * forced at the database, the way AC-355's rendezvous is:
 *
 *  1. the owner client takes `LOCK TABLE "login_attempt" IN ACCESS EXCLUSIVE
 *     MODE` and holds it in an open transaction;
 *  2. public writes are dispatched and **park inside their handlers** —
 *     `withLoginRateLimit`'s first read is a `SELECT` over `login_attempt`,
 *     which that lock conflicts with — holding their interceptor slots for as
 *     long as the test wants;
 *  3. the test polls `pg_stat_activity` until every one of them is actually
 *     blocked, so the next request is dispatched against an observed state
 *     rather than a hoped-for one;
 *  4. a refused request never touches the database, which is what makes its
 *     `429` exact rather than likely — and, symmetrically, an *admitted* one
 *     is proven admitted by the blocked-backend count going up, not by a
 *     status code that a refusal could also produce.
 *
 * Distinct emails throughout: `withLoginRateLimit` takes a per-email advisory
 * lock *before* the `login_attempt` read, so two requests for the same email
 * would serialise there — the second would never reach the table lock and the
 * poll would never see it.
 *
 * ## Addresses
 *
 * The app under test is built with `trustProxy: 1` (one forwarding hop, the
 * shape docs/deploy-runbook.md §1 tells an operator to configure — never a
 * blanket `true`), so `X-Forwarded-For` is what `request.ip` resolves to and a
 * single test process can act as several clients. That is also the only
 * honest way to test this: without it every request in one process shares one
 * socket address and the per-client bucket cannot be told from the old
 * instance-wide one.
 *
 * ## Red-confirms actually observed
 *
 * Recorded on the tests they belong to. The ones that remove a refusal
 * present as `socket hang up` after 30 s rather than as a status mismatch: an
 * unrefused request parks on the barrier like the others and is eventually
 * reaped by the app's own connection timeout. Loud, slow, and unambiguous —
 * but worth knowing before reading a failure of this file as an
 * infrastructure problem.
 */
const PER_CLIENT_CAP = PUBLIC_WRITE_MAX_CONCURRENT_PER_CLIENT;
const INSTANCE_CAP = PUBLIC_WRITE_MAX_CONCURRENT_INSTANCE;
const PASSWORD = "correct horse battery staple public write throttle";
const FIXED_SETUP_TOKEN = "fixed-setup-token-for-the-public-write-suite";

/** TEST-NET-3 (RFC 5737) addresses — one per simulated client. Enough to fill the instance bucket `PER_CLIENT_CAP` at a time, plus one spare that is always fresh. */
const ADDRESSES = Array.from(
  { length: Math.ceil(INSTANCE_CAP / PER_CLIENT_CAP) + 1 },
  (_unused, index) => `203.0.113.${String(10 + index)}`,
);
const CLIENT_A = ADDRESSES[0]!;
const CLIENT_B = ADDRESSES[1]!;
const CLIENT_C = ADDRESSES[2]!;

/** One account per request the widest test parks, plus the one it is refused with. */
const ACCOUNT_COUNT = INSTANCE_CAP + 1;

describe("api — the public-write concurrency caps (POST /auth/login + POST /auth/setup)", () => {
  let testApp: TestApp;
  const emails: string[] = [];

  beforeAll(async () => {
    process.env[SETUP_TOKEN_ENV_VAR] = FIXED_SETUP_TOKEN;
    testApp = await startTestApp({ trustProxy: 1 });
    // Real accounts, in their own tenants, so every request in a burst is a
    // *valid* login: an admitted request then answers 200 and a refused one
    // 429, and the two outcomes cannot be confused with each other the way two
    // flavours of failure could.
    for (let index = 0; index < ACCOUNT_COUNT; index++) {
      const tenantId = randomUUID();
      const email = `public-write-${String(index)}-${randomUUID()}@example.com`;
      await testApp.ownerDb.insert(tenant).values({ id: tenantId });
      await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
      emails.push(email);
    }
  }, 300_000);

  afterAll(async () => {
    await testApp.stop();
    delete process.env[SETUP_TOKEN_ENV_VAR];
  }, 30_000);

  afterEach(async () => {
    // A 429 from an interceptor records nothing, but the admitted logins do;
    // left in place, one test's history would apply the per-IP backoff to the
    // next one.
    await testApp.ownerClient`delete from "login_attempt"`;
  });

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  /** One `POST /auth/login` from `address` — the header is authoritative because the app trusts one hop. */
  function login(email: string, address: string): ReturnType<ReturnType<typeof supertest>["post"]> {
    return server()
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", address)
      .send({ email, password: PASSWORD });
  }

  /** One well-formed `POST /auth/setup` from `address`. On this already-provisioned instance an *admitted* one answers 409; a refused one answers 429. */
  function setup(address: string): ReturnType<ReturnType<typeof supertest>["post"]> {
    return server()
      .post("/api/v1/auth/setup")
      .set("X-Forwarded-For", address)
      .send({
        email: `setup-${randomUUID()}@example.com`,
        password: "a perfectly good passphrase",
        baseCurrency: "EUR",
        setupToken: FIXED_SETUP_TOKEN,
      });
  }

  /**
   * How many backends of *this suite's own database* are parked on a lock
   * inside the rate limiter's `login_attempt` read.
   *
   * `datname = current_database()` is not optional: under `TEST_SHARED_PG=1`
   * every suite shares one Postgres instance, so an unfiltered
   * `pg_stat_activity` would count somebody else's blocked backend. The
   * poller's own row is excluded by `pid`, and every idle pooled connection
   * (the barrier transaction included) reports `wait_event_type = 'Client'`.
   */
  async function countBlockedOnLoginAttempt(): Promise<number> {
    const rows = await testApp.ownerClient`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query like '%login_attempt%'
    `;
    return (rows[0] as { n: number }).n;
  }

  /** The barrier: an owner-role transaction holding the table lock until the returned release is called. */
  async function holdLoginAttemptLock(): Promise<() => Promise<void>> {
    const lockTaken = deferred<void>();
    const released = deferred<void>();
    const transaction = testApp.ownerClient.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE "login_attempt" IN ACCESS EXCLUSIVE MODE`);
      lockTaken.resolve();
      await released.promise;
    });
    // Racing rather than awaiting `lockTaken` alone: a failure to take the
    // lock would otherwise hang until the test timeout instead of reporting
    // the Postgres error.
    await Promise.race([lockTaken.promise, transaction]);
    return async () => {
      released.resolve();
      await transaction;
    };
  }

  /** Blocks until `expected` public writes are observably parked inside their handlers, or fails saying how many it did see. */
  async function awaitParked(expected: number): Promise<void> {
    let blocked = 0;
    const reached = await waitUntil(
      async () => {
        blocked = await countBlockedOnLoginAttempt();
        return blocked >= expected;
      },
      10_000,
      50,
    );
    expect(
      reached,
      `expected ${String(expected)} public-write backends parked on login_attempt within 10s; last saw ${String(blocked)}`,
    ).toBe(true);
  }

  /**
   * Dispatches one login per entry and waits until every one of them is
   * observably parked.
   *
   * The in-flight promise is returned **wrapped in an object**, and that is
   * not a style choice: `await` recursively unwraps thenables, so an `async`
   * function returning the `Promise.all` directly would have its caller's
   * `await` wait for the parked requests themselves — which, by construction,
   * cannot finish until the barrier lifts. (Observed here first: every
   * request sat until the app's 30 s connection timeout destroyed its
   * socket.)
   */
  async function park(
    entries: readonly { readonly email: string; readonly address: string }[],
    alreadyParked = 0,
  ): Promise<{ readonly responses: Promise<{ status: number }[]> }> {
    const parked = Promise.all(entries.map((entry) => login(entry.email, entry.address)));
    void parked.catch(() => undefined);
    await awaitParked(alreadyParked + entries.length);
    return { responses: parked };
  }

  /** The `PER_CLIENT_CAP` logins one address is allowed, all parked. */
  function slotsFor(address: string, offset = 0): { email: string; address: string }[] {
    return Array.from({ length: PER_CLIENT_CAP }, (_unused, index) => ({
      email: emails[offset + index]!,
      address,
    }));
  }

  it(`refuses the ${String(PER_CLIENT_CAP + 1)}th concurrent POST /auth/login from ONE address with 429 ${PUBLIC_WRITE_PROBLEM_CODE}, and admits the first ${String(PER_CLIENT_CAP)}`, async () => {
    // **Red-confirm (2026-09-19, observed, before the per-client key):** the
    // `@UseInterceptors` removed from `POST /auth/login` in
    // `auth.controller.ts`, nothing else touched — with nothing to refuse it,
    // the third request joined the other two on the table lock and the test
    // failed with `socket hang up` after 30 s (the app's own connection
    // timeout reaping a request that never got an answer), rather than with a
    // status mismatch. That is the honest shape of this regression and is
    // recorded as observed rather than as expected. Restored, green.
    const unlock = await holdLoginAttemptLock();
    let third: { status: number; body: Record<string, unknown>; headers: Record<string, string> };
    let admitted: { status: number }[];
    try {
      const { responses } = await park(slotsFor(CLIENT_A));

      third = (await login(emails[PER_CLIENT_CAP]!, CLIENT_A)) as unknown as typeof third;

      // Read *before* the barrier lifts: the refusal has to have happened
      // while the other two were genuinely in flight, which is the whole
      // difference between a concurrency cap and a rate cap.
      expect(third.status).toBe(429);
      expect(third.body["code"]).toBe(PUBLIC_WRITE_PROBLEM_CODE);
      expect(third.body["detail"]).toContain("per client address");
      expect(third.headers["retry-after"]).toBeDefined();
      expect(third.headers["content-type"]).toContain("application/problem+json");

      await unlock();
      admitted = await responses;
    } finally {
      await unlock();
    }

    // …and the two that were admitted really did complete, so "exactly one
    // refused" is not passing against three broken requests.
    expect(admitted.map((response) => response.status)).toStrictEqual(
      Array.from({ length: PER_CLIENT_CAP }, () => 200),
    );
  }, 60_000);

  it("a login from a DIFFERENT address is admitted while one address holds both of its slots", async () => {
    // The whole point of the per-client key, and the one shape that tells a per-address
    // bucket from the instance-wide one it used to be. Proven by the blocked
    // -backend count going from PER_CLIENT_CAP to PER_CLIENT_CAP + 1 *while
    // the barrier is still held* — a refused request would never reach the
    // database, so the count is what discriminates, not the eventual 200.
    //
    // **Red-confirm:** `keyBy: "client-ip"` reverted to `"tenant"` in
    // `public-write-throttle.interceptor.ts` — both addresses are
    // session-less, so they share `__no_session__` and this login is refused.
    const unlock = await holdLoginAttemptLock();
    let fromB: { status: number };
    let fromA: { status: number }[];
    try {
      const { responses } = await park(slotsFor(CLIENT_A));

      const otherClient = login(emails[PER_CLIENT_CAP]!, CLIENT_B);
      void otherClient.catch(() => undefined);
      await awaitParked(PER_CLIENT_CAP + 1);

      await unlock();
      fromB = (await otherClient) as unknown as typeof fromB;
      fromA = await responses;
    } finally {
      await unlock();
    }

    expect(fromB.status).toBe(200);
    expect(fromA.map((response) => response.status)).toStrictEqual(
      Array.from({ length: PER_CLIENT_CAP }, () => 200),
    );
  }, 60_000);

  it("one address's budget is ONE budget shared with POST /auth/setup, not one per route", async () => {
    // The discriminating shape, and the only one that can tell "joined the
    // shared instance" from "got its own instance with the same ceiling":
    // the 429 has to land on the *other* route of the class, from the same
    // address. A burst of three logins would pass either way.
    //
    // **Red-confirm (2026-09-19, observed):** a second, private
    // `new ConcurrencyThrottleInterceptor(...)` wired onto `POST /auth/setup`
    // instead of the shared export — its own bucket was empty, so the setup
    // call was admitted, parked on the same barrier and the test failed with
    // `socket hang up` after 30 s. Same shape as the sibling test's red
    // above, and the same reading: nothing refused a request that had to be
    // refused. Restored, green.
    const unlock = await holdLoginAttemptLock();
    let refused: { status: number; body: Record<string, unknown> };
    try {
      const { responses } = await park(slotsFor(CLIENT_A));

      refused = (await setup(CLIENT_A)) as unknown as typeof refused;

      expect(refused.status).toBe(429);
      expect(refused.body["code"]).toBe(PUBLIC_WRITE_PROBLEM_CODE);

      await unlock();
      await responses;
    } finally {
      await unlock();
    }

    // Nothing was provisioned by the refused call — it never reached the
    // handler, and this instance already has its accounts anyway.
    const rows = await testApp.ownerClient`select count(*)::int as n from "app_user"`;
    expect((rows[0] as { n: number }).n).toBe(ACCOUNT_COUNT);
  }, 60_000);

  it("a POST /auth/setup from a third address is admitted while two logins from one address and one from another are parked", async () => {
    // The same budget read the other way round: the setup is admitted because
    // *its own* address has spent nothing, even though three public writes
    // from two other addresses are in flight. An admitted setup on an
    // already-provisioned instance answers 409 SETUP_ALREADY_DONE from
    // `provision_account`'s FR-401 lock — a status only a request that
    // reached the handler can produce.
    const unlock = await holdLoginAttemptLock();
    let provisioned: { status: number; body: Record<string, unknown> };
    try {
      const { responses } = await park(slotsFor(CLIENT_A));
      const { responses: fromB } = await park(
        [{ email: emails[PER_CLIENT_CAP]!, address: CLIENT_B }],
        PER_CLIENT_CAP,
      );

      const attempt = setup(CLIENT_C);
      void attempt.catch(() => undefined);
      await awaitParked(PER_CLIENT_CAP + 2);

      await unlock();
      provisioned = (await attempt) as unknown as typeof provisioned;
      await responses;
      await fromB;
    } finally {
      await unlock();
    }

    expect(provisioned.status).toBe(409);
    expect(provisioned.body["code"]).toBe("SETUP_ALREADY_DONE");
  }, 60_000);

  it(`refuses the ${String(INSTANCE_CAP + 1)}th concurrent public write with 429 ${PUBLIC_WRITE_INSTANCE_PROBLEM_CODE}, however many addresses they come from`, async () => {
    // The outer bucket: `INSTANCE_CAP` logins parked across
    // `INSTANCE_CAP / PER_CLIENT_CAP` addresses, each address exactly at its
    // own ceiling, then one more from a *fresh* address whose own bucket is
    // empty. Only the instance interceptor can refuse that one, so the code
    // discriminates which of the two caps fired.
    //
    // **Red-confirm:** `publicWriteInstanceThrottleInterceptor` removed from
    // `@UseInterceptors` on `POST /auth/login` — the fresh address's login is
    // admitted, parks on the barrier and the test fails with `socket hang up`
    // after 30 s, the same shape as the other removals here.
    const addresses = ADDRESSES.slice(0, INSTANCE_CAP / PER_CLIENT_CAP);
    const entries = addresses.flatMap((address, index) =>
      slotsFor(address, index * PER_CLIENT_CAP),
    );
    expect(entries).toHaveLength(INSTANCE_CAP);

    const unlock = await holdLoginAttemptLock();
    let refused: { status: number; body: Record<string, unknown>; headers: Record<string, string> };
    let admitted: { status: number }[];
    try {
      const { responses } = await park(entries);

      refused = (await login(
        emails[INSTANCE_CAP]!,
        ADDRESSES[ADDRESSES.length - 1]!,
      )) as unknown as typeof refused;

      expect(refused.status).toBe(429);
      expect(refused.body["code"]).toBe(PUBLIC_WRITE_INSTANCE_PROBLEM_CODE);
      expect(refused.body["detail"]).toContain("instance-wide");
      expect(refused.headers["retry-after"]).toBeDefined();

      await unlock();
      admitted = await responses;
    } finally {
      await unlock();
    }

    expect(admitted.map((response) => response.status)).toStrictEqual(
      Array.from({ length: INSTANCE_CAP }, () => 200),
    );
  }, 120_000);

  it("the same logins issued SEQUENTIALLY from one address all succeed — which is what makes these concurrency caps and not disguised rate caps", async () => {
    const statuses: number[] = [];
    for (const email of emails.slice(0, PER_CLIENT_CAP + 1)) {
      statuses.push((await login(email, CLIENT_A)).status);
    }
    expect(statuses).toStrictEqual(Array.from({ length: PER_CLIENT_CAP + 1 }, () => 200));
  }, 60_000);
});
