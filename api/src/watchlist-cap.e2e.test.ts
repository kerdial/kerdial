import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { createUser } from "@kerdial/platform-auth";
import { instrument, instrumentPriceDaily, tenant, watchlistItem } from "@kerdial/platform-db";
import { MAX_WATCHLIST_ITEMS_PER_TENANT } from "@kerdial/ledger";
import { and, eq } from "drizzle-orm";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * `/watchlist` over real HTTP: the row cap's boundary (AC-337), the idempotent
 * watch/un-watch pair (AC-338) and the degenerate instrument (AC-336) —
 * T-70, R4/R5.
 *
 * **The test shapes here are not interchangeable, and R4 is why.**
 *
 * 1. **AC-337 asserts the `code`, never the status alone.** `POST /watchlist`
 *    answers `429` for *two different facts*: the per-tenant row cap
 *    (`WATCHLIST_TENANT_CAP_EXCEEDED`) and the instance-wide admission bound
 *    (`ADMISSION_BOUND_EXCEEDED`). A status-only assertion passes on either,
 *    so it would pass on a build whose cap never fires at all. Verified by
 *    mutation at T-70: with the cap arm's status changed to `422` the
 *    `code` assertion stayed green while a separate status assertion went red,
 *    which is exactly the split R4 asks for — so the status is asserted *in
 *    addition to*, and never instead of, the code.
 * 2. **AC-337's two calls are SEQUENTIAL**, in one test, in this order. The
 *    write throttle's concurrency cap is 2, so a parallel 200th-and-201st could
 *    be refused by the throttle rather than by the cap and the test would pass
 *    for the wrong reason.
 * 3. **WL-1's scale cases assert 400 *and* the code, and the stored value.**
 *    A 19-fractional-digit `targetPrice` used to reach `numeric(38, 18)`,
 *    round to `0`, trip `watchlist_item_target_price_positive` and surface as
 *    a **500**. A status-only assertion would go green on any
 *    400; the paired positive case (18 digits, read back out of the column)
 *    is what shows the bound is a bound and not a rounding point.
 * 4. **AC-336 asserts the priced and the unpriced row in the SAME response.**
 *    "No data" and "not loaded yet" are the two states a user must be able to
 *    tell apart, so a test that only ever sees the empty one cannot show that
 *    the screen distinguishes them.
 *
 * **Lane:** `pnpm test` (`test:main`). Every assertion here is deterministic —
 * no burst, no timing, no lock. The *throttle* proofs (AC-340), which do race
 * real HTTP, live in `watchlist-throttle.e2e.test.ts` in the flake lane.
 *
 * **Throttle budget.** No `POST /instruments` anywhere (that route's 30/hour
 * rate cap is a shared, per-tenant budget this file must not spend): the
 * catalogue rows are inserted directly as the owner. `POST /watchlist` itself
 * joins **no** rate cap (W-7), which is what makes the 201-call sequence below
 * affordable at all; a dedicated tenant per block keeps the concurrency
 * counters from leaking between `it()` blocks.
 */

const USER_PASSWORD = "correct horse battery staple t70 watchlist cap";

/** Read from `ledger`, never re-typed — a test that hard-codes 200 would keep passing if the cap moved. */
const ROW_CAP = MAX_WATCHLIST_ITEMS_PER_TENANT;

describe("api — /watchlist: the cap boundary, idempotence and the degenerate instrument", () => {
  let testApp: TestApp;

  interface Session {
    readonly tenantId: string;
    readonly sid: string;
    readonly csrf: string;
  }

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function postWatch(session: Session, body: Record<string, unknown>) {
    return server()
      .post("/api/v1/watchlist")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function deleteWatch(session: Session, instrumentId: string) {
    return server()
      .delete(`/api/v1/watchlist/${instrumentId}`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  function patchWatch(session: Session, instrumentId: string, body: Record<string, unknown>) {
    return server()
      .patch(`/api/v1/watchlist/${instrumentId}`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function getWatchlist(session: Session, query = "") {
    return server()
      .get(`/api/v1/watchlist${query}`)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function getWatchedIds(session: Session) {
    return server()
      .get("/api/v1/watchlist/ids")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  let fixtureCounter = 0;
  /** A shared-catalogue instrument, inserted as the owner — see this file's header on the `POST /instruments` rate cap. */
  async function newInstrument(displayName?: string): Promise<string> {
    fixtureCounter += 1;
    const id = randomUUID();
    await testApp.ownerDb.insert(instrument).values({
      id,
      kind: "CRYPTO",
      displayName: displayName ?? `T-70 fixture ${String(fixtureCounter).padStart(4, "0")}`,
      listingCurrency: "EUR",
      symbol: `T70W${String(fixtureCounter).padStart(6, "0")}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    return id;
  }

  /** One dedicated tenant per block — the write throttle's counters are module singletons keyed by tenant. */
  async function newTenantSession(label: string): Promise<Session> {
    const tenantId = randomUUID();
    const email = `t70-${label}-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: USER_PASSWORD });
    const session = await loginAs(server(), email, USER_PASSWORD);
    return { tenantId, ...session };
  }

  async function watchlistRowCount(tenantId: string): Promise<number> {
    const rows = await testApp.ownerDb
      .select({ instrumentId: watchlistItem.instrumentId })
      .from(watchlistItem)
      .where(eq(watchlistItem.tenantId, tenantId));
    return rows.length;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  /* ===================================================================== *
   * AC-337 — the row cap, rejected and not truncated, asserted on `code`.
   * ===================================================================== */

  describe(`AC-337 — the ${String(ROW_CAP)}-row cap`, () => {
    it(`the ${String(ROW_CAP)}th watch succeeds and the ${String(ROW_CAP + 1)}st is 429 WATCHLIST_TENANT_CAP_EXCEEDED — sequentially, in one test`, async () => {
      const session = await newTenantSession("cap");

      // `ROW_CAP - 1` rows seeded directly, then the boundary crossed over
      // real HTTP: the cap's *enforcement* is what this asserts, and seeding
      // 199 rows through 199 requests would only measure the same INSERT 199
      // times.
      const seeded = await Promise.all(Array.from({ length: ROW_CAP - 1 }, () => newInstrument()));
      await testApp.ownerDb
        .insert(watchlistItem)
        .values(seeded.map((instrumentId) => ({ tenantId: session.tenantId, instrumentId })));
      expect(await watchlistRowCount(session.tenantId)).toBe(ROW_CAP - 1);

      const lastAllowed = await newInstrument();
      const oneTooMany = await newInstrument();

      // The 200th — admitted, and it really wrote a row.
      const allowed = await postWatch(session, { instrumentId: lastAllowed });
      expect(allowed.status).toBe(200);
      expect(await watchlistRowCount(session.tenantId)).toBe(ROW_CAP);

      // The 201st — refused. **The `code` is the assertion** (R4: the write
      // throttle answers 429 on this same route with a different code, so a
      // status-only check cannot tell the two apart).
      const refused = await postWatch(session, { instrumentId: oneTooMany });
      expect(refused.body.code).toBe("WATCHLIST_TENANT_CAP_EXCEEDED");
      // Asserted *in addition*, never instead: see this file's header.
      expect(refused.status).toBe(429);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      // Rejected, **not truncated**: no row was written for the refused add.
      expect(await watchlistRowCount(session.tenantId)).toBe(ROW_CAP);
      const stillAbsent = await testApp.ownerDb
        .select({ instrumentId: watchlistItem.instrumentId })
        .from(watchlistItem)
        .where(
          and(
            eq(watchlistItem.tenantId, session.tenantId),
            eq(watchlistItem.instrumentId, oneTooMany),
          ),
        );
      expect(stillAbsent).toEqual([]);

      // The cap's own exemption (FR-340), in the same test so "429 forever"
      // cannot satisfy the case above: a tenant **at** the cap can still edit
      // an existing row, and can still un-watch and re-watch.
      const edited = await patchWatch(session, lastAllowed, { targetPrice: "42.5" });
      expect(edited.status).toBe(200);
      expect(edited.body.targetPrice).toBe("42.5");
      const rewatched = await postWatch(session, { instrumentId: lastAllowed, note: "kept" });
      expect(rewatched.status).toBe(200);
      expect(await watchlistRowCount(session.tenantId)).toBe(ROW_CAP);

      // …and freeing a slot makes the refused instrument watchable, which is
      // what proves the refusal was about the count and not about that row.
      expect((await deleteWatch(session, seeded[0]!)).status).toBe(204);
      const nowAllowed = await postWatch(session, { instrumentId: oneTooMany });
      expect(nowAllowed.status).toBe(200);
      expect(await watchlistRowCount(session.tenantId)).toBe(ROW_CAP);
    }, 180_000);
  });

  /* ===================================================================== *
   * AC-338 — idempotent watch and un-watch.
   * ===================================================================== */

  describe("AC-338 — watching twice, un-watching twice", () => {
    it("two POSTs for the same instrument leave exactly one row, and both answer 200", async () => {
      const session = await newTenantSession("idempotent-add");
      const instrumentId = await newInstrument();

      const first = await postWatch(session, { instrumentId, note: "first" });
      const second = await postWatch(session, { instrumentId });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // No 201/200 split — a second tab's add *is* a repeat, and no client can
      // act on the difference (FR-375).
      expect(await watchlistRowCount(session.tenantId)).toBe(1);
      // The bare re-watch left the note alone rather than wiping it: an absent
      // key means "leave whatever is stored", which is what makes a re-watch a
      // no-op instead of a silent clear.
      expect(second.body.note).toBe("first");
      expect(second.body.watchedSince).toBe(first.body.watchedSince);
    }, 60_000);

    it("DELETE on an instrument this tenant never watched is 204 with no body, never 404", async () => {
      const session = await newTenantSession("idempotent-remove");
      const instrumentId = await newInstrument();

      const absent = await deleteWatch(session, instrumentId);
      expect(absent.status).toBe(204);
      expect(absent.text).toBe("");

      // And twice over a row that did exist: the second is the same success.
      expect((await postWatch(session, { instrumentId })).status).toBe(200);
      expect((await deleteWatch(session, instrumentId)).status).toBe(204);
      expect((await deleteWatch(session, instrumentId)).status).toBe(204);
      expect(await watchlistRowCount(session.tenantId)).toBe(0);
    }, 60_000);

    it("PATCH on an unwatched instrument is 404 WATCHLIST_ITEM_NOT_FOUND — a PATCH is not a create", async () => {
      const session = await newTenantSession("patch-404");
      const instrumentId = await newInstrument();

      const refused = await patchWatch(session, instrumentId, { note: "not watching this" });
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe("WATCHLIST_ITEM_NOT_FOUND");
      expect(await watchlistRowCount(session.tenantId)).toBe(0);
    }, 60_000);

    it("POST naming an instrument that does not exist is 404 INSTRUMENT_NOT_FOUND", async () => {
      const session = await newTenantSession("add-404");

      const refused = await postWatch(session, { instrumentId: randomUUID() });
      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe("INSTRUMENT_NOT_FOUND");
    }, 60_000);

    it("GET /watchlist/ids reflects the writes, ascending, and is tenant-scoped", async () => {
      const session = await newTenantSession("ids");
      const other = await newTenantSession("ids-other");
      const first = await newInstrument();
      const second = await newInstrument();

      expect((await postWatch(session, { instrumentId: first })).status).toBe(200);
      expect((await postWatch(session, { instrumentId: second })).status).toBe(200);
      expect((await postWatch(other, { instrumentId: first })).status).toBe(200);

      const ids = await getWatchedIds(session);
      expect(ids.status).toBe(200);
      expect(ids.body.instrumentIds).toEqual([first, second].sort());

      // The other tenant watches only what it asked for — the id list is not a
      // cross-tenant read (FR-51).
      const otherIds = await getWatchedIds(other);
      expect(otherIds.body.instrumentIds).toEqual([first]);
    }, 60_000);
  });

  /* ===================================================================== *
   * WL-1 — the target price's scale, over real HTTP against a
   * real `numeric(38, 18)` column. The point of doing it here and not only in
   * the unit suites: the finding *was* a 500, produced by a value that every
   * layer above Postgres accepted, so the proof has to be a real round trip.
   * ===================================================================== */

  describe("WL-1 — a targetPrice beyond the column's scale", () => {
    /** 19 fractional digits: positive as parsed, `0` once `numeric(38, 18)` has rounded it. */
    const NINETEEN_DP = "0.0000000000000000001";
    /** Exactly 18 — the bound, which must still be stored verbatim. */
    const EIGHTEEN_DP = "1.234567890123456789";

    async function storedTargetPrice(
      tenantId: string,
      instrumentId: string,
    ): Promise<string | null> {
      const [row] = await testApp.ownerDb
        .select({ targetPrice: watchlistItem.targetPrice })
        .from(watchlistItem)
        .where(
          and(eq(watchlistItem.tenantId, tenantId), eq(watchlistItem.instrumentId, instrumentId)),
        );
      return row?.targetPrice?.toString() ?? null;
    }

    it("POST is 400, NOT 500, and writes no row", async () => {
      const session = await newTenantSession("scale-post");
      const instrumentId = await newInstrument();

      const refused = await postWatch(session, { instrumentId, targetPrice: NINETEEN_DP });

      expect(refused.status).toBe(400);
      // The status alone would also be satisfied by an unrelated malformed
      // body; the code is what says the request was *understood* and refused.
      expect(refused.body.code).toBe("VALIDATION_ERROR");
      expect(refused.body.detail).toContain("targetPrice");
      expect(await watchlistRowCount(session.tenantId)).toBe(0);
    }, 60_000);

    it("PATCH is 400, NOT 500, and leaves the stored target untouched", async () => {
      const session = await newTenantSession("scale-patch");
      const instrumentId = await newInstrument();

      expect((await postWatch(session, { instrumentId, targetPrice: "100.5" })).status).toBe(200);

      const refused = await patchWatch(session, instrumentId, { targetPrice: NINETEEN_DP });

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("VALIDATION_ERROR");
      // The row the user already had is exactly as it was — a refused edit
      // must not be a partial one.
      expect(await storedTargetPrice(session.tenantId, instrumentId)).toBe("100.5");
    }, 60_000);

    it("18 fractional digits are ACCEPTED and stored VERBATIM, on both write paths", async () => {
      const session = await newTenantSession("scale-bound");
      const instrumentId = await newInstrument();

      const added = await postWatch(session, { instrumentId, targetPrice: EIGHTEEN_DP });
      expect(added.status).toBe(200);
      // On the wire and in the column, byte for byte — the bound is a bound,
      // not a rounding point.
      expect(added.body.targetPrice).toBe(EIGHTEEN_DP);
      expect(await storedTargetPrice(session.tenantId, instrumentId)).toBe(EIGHTEEN_DP);

      const patched = await patchWatch(session, instrumentId, {
        targetPrice: "0.000000000000000001",
      });
      expect(patched.status).toBe(200);
      expect(patched.body.targetPrice).toBe("0.000000000000000001");
      expect(await storedTargetPrice(session.tenantId, instrumentId)).toBe("0.000000000000000001");
    }, 60_000);
  });

  /* ===================================================================== *
   * AC-336 — the degenerate instrument, beside a priced one.
   * ===================================================================== */

  describe("AC-336 — a watched instrument with no price rows renders, with every metric absent", () => {
    it("shows the unpriced and the priced row in the same response, and the unpriced one carries no fabricated zero", async () => {
      const session = await newTenantSession("degenerate");
      // Display names fix the order so the assertions below can
      // index the array rather than search it.
      const bare = await newInstrument("AAA never backfilled");
      const priced = await newInstrument("BBB priced");

      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await testApp.ownerDb.insert(instrumentPriceDaily).values([
        {
          instrumentId: priced,
          priceDate: yesterday,
          closeRaw: new Decimal("100"),
          currency: "EUR",
          sourceKey: "yahoo",
          quality: "EOD",
        },
        {
          instrumentId: priced,
          priceDate: today,
          closeRaw: new Decimal("105"),
          currency: "EUR",
          sourceKey: "yahoo",
          quality: "EOD",
        },
      ]);

      expect((await postWatch(session, { instrumentId: bare })).status).toBe(200);
      expect((await postWatch(session, { instrumentId: priced })).status).toBe(200);

      const response = await getWatchlist(session, "?window=1Y");
      expect(response.status).toBe(200);
      expect(response.body.window).toEqual({
        preset: "1Y",
        from: expect.any(String),
        to: response.body.asOfDate,
      });
      expect(response.body.rows).toHaveLength(2);

      const [unpriced, withPrice] = response.body.rows as Record<string, unknown>[];

      // ---- the priced sibling: real values, in the listing currency --------
      expect(withPrice!["instrumentId"]).toBe(priced);
      const currentPrice = withPrice!["currentPrice"] as Record<string, unknown>;
      expect(currentPrice["amount"]).toBe("105");
      expect(currentPrice["currency"]).toBe("EUR");
      expect(withPrice!["dayChange"]).toBe("5");
      expect(withPrice!["dayChangePercent"]).toBe("0.05");
      // A number on the wire is a **string**, never a JSON number (AC53).
      expect(typeof withPrice!["dayChange"]).toBe("string");

      // ---- the degenerate row: present, and absent everywhere it must be ---
      expect(unpriced!["instrumentId"]).toBe(bare);
      expect(unpriced!["displayName"]).toBe("AAA never backfilled");
      // Every field a client could coerce is **missing**, not `null` and not
      // `0` (AC-331/W-10): `Object.hasOwn`, because `toBeUndefined()` cannot
      // tell an absent key from a present `undefined` one and only the former
      // survives JSON.
      for (const key of ["currentPrice", "dayChange", "dayChangePercent"]) {
        expect(Object.hasOwn(unpriced!, key), `${key} must be absent`).toBe(false);
      }
      const metrics = unpriced!["metrics"] as Record<string, unknown>;
      // The eight window keys are gone entirely — an empty object, never eight
      // nulls and never eight zeroes.
      expect(metrics["periodReturns"]).toEqual({});
      // …and `unusableSeries` is `false`: "there is no series" is a different
      // fact from "the series has a non-positive close", and the copy layer
      // says so differently.
      expect(metrics["unusableSeries"]).toBe(false);
      for (const key of [
        "fiftyTwoWeek",
        "maxDrawdown",
        "annualisedVolatility",
        "sma50",
        "sma200",
        "priceVsSma50",
        "priceVsSma200",
      ]) {
        expect(Object.hasOwn(metrics, key), `metrics.${key} must be absent`).toBe(false);
      }
      expect(unpriced!["series"]).toEqual([]);
      // The row still carries its own identity and its editable fields, which
      // is what "renders" means (FR-346) — a `null` target price is nullable on
      // the wire on purpose, because PATCH needs to distinguish clear from
      // leave-alone.
      expect(unpriced!["targetPrice"]).toBeNull();
      expect(unpriced!["note"]).toBeNull();
      expect(unpriced!["hasIcon"]).toBe(false);
      expect(unpriced!["status"]).toBe("ACTIVE");
      expect(unpriced!["listingCurrency"]).toBe("EUR");
      expect(unpriced!["watchedSince"]).toBe(today);
    }, 120_000);

    it("an unknown ?window= is a 400, and every documented preset is accepted", async () => {
      const session = await newTenantSession("window");

      // `MAX` is a real `period-presets.ts` preset and deliberately not one of
      // this route's: the server's price load is bounded at 5y + 400d, so a
      // `MAX` here would either lie about its span or unbound the read.
      expect((await getWatchlist(session, "?window=MAX")).status).toBe(400);
      expect((await getWatchlist(session, "?window=2W")).status).toBe(400);

      for (const preset of ["3M", "6M", "YTD", "1Y", "3Y", "5Y"]) {
        const response = await getWatchlist(session, `?window=${preset}`);
        expect(response.status, `window=${preset}`).toBe(200);
        expect(response.body.window.preset).toBe(preset);
      }
      // Omitted means 1Y (the default), not "no window".
      const bare = await getWatchlist(session);
      expect(bare.status).toBe(200);
      expect(bare.body.window.preset).toBe("1Y");
    }, 120_000);
  });
});
