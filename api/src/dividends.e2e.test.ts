import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Decimal } from "@kerdial/core-decimal";
import { createUser } from "@kerdial/platform-auth";
import {
  instrument,
  instrumentIcon,
  tenant,
  transaction,
  transactionPosting,
  type Db,
} from "@kerdial/platform-db";
import {
  MAX_DIVIDEND_INSTRUMENTS_PER_VIEW,
  expandPostings,
  type ExpandableTransaction,
} from "@kerdial/ledger";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * DS-4 — `GET /dividends/summary` over real HTTP, through the real
 * `app_web` role, against the worked fixture.
 *
 * **Its own tenants, its own file, and not one `POST /instruments`.**
 * `transactions.e2e.test.ts` sits at the exact 30/hour instrument-create rate
 * cap on its own tenant, so every instrument below is inserted
 * directly through `ownerDb` — the pattern
 * `market-data-quote-refresh.e2e.test.ts` and
 * `instrument-history-reload.e2e.test.ts` already use — and
 * no `POST /instruments` call is made at all, on any tenant.
 *
 * **The transactions do go through `POST /transactions`, sequentially**, so the
 * postings this endpoint reads are produced by the real write path rather than
 * hand-written. That is safe at any length: checked against
 * `transactions/write-throttle.interceptor.ts`'s own doc comment before the
 * fixture loop was written, that throttle is a **concurrency** cap
 * (`maxConcurrentPerTenant: 2`), never a rate cap — a caller that awaits each
 * write before firing the next can never trip it.
 *
 * Every expected figure is the worked example's own hand-computed value, restated here with
 * its arithmetic and in `serializeDecimal`'s wire form (`"60"`, never
 * `"60.000000000000"`, A7) — the same numbers DS-2 proved at the service
 * layer, now asserted through the live route.
 */

const tenantA = "00000000-0000-7000-8000-00000266000a";
const tenantB = "00000000-0000-7000-8000-00000266000b";
const tenantCosted = "00000000-0000-7000-8000-00000266000c";
const tenantCapped = "00000000-0000-7000-8000-00000266000d";

const PASSWORD = "correct horse battery staple dividends";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

/** The response, all-time, combined — the worked example, field for field. */
const FIXTURE_TOTAL = { grossBase: "192.59", withholdingBase: "13.851" };

describe("api — GET /dividends/summary (DS-4)", () => {
  let testApp: TestApp;
  let ownerDb: Db;

  let aliceSession: Session;
  let bobSession: Session;
  let costedSession: Session;
  let cappedSession: Session;

  /** X «Air Liquide» — five payments, three years, two portfolios. */
  let instrumentX: string;
  /** Y «Apple Inc.» — the one USD payment, the fixture's only withholding leg. */
  let instrumentY: string;
  /** Z «Bouygues» — the row whose `"60"` proves A7's no-scale-padding on the wire. */
  let instrumentZ: string;
  /** Tenant B's instrument — the cross-tenant counterparty. */
  let instrumentOther: string;
  let instrumentCosted: string;

  let portfolioP1: string;
  let portfolioP2: string;
  let portfolioCosted: string;

  let instrumentSeq = 0;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: Session) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function post(path: string, body: Record<string, unknown>, session: Session) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  /**
   * A catalogue row written **directly**, never through `POST /instruments` —
   * see this file's header. Symbol-identified and ISIN-less, so it cannot
   * collide with migration `0037`'s seeded large-cap identifiers.
   */
  async function seedInstrument(displayName: string, listingCurrency = "EUR"): Promise<string> {
    instrumentSeq += 1;
    const id = randomUUID();
    await ownerDb.insert(instrument).values({
      id,
      kind: "SHARE",
      displayName,
      listingCurrency,
      exchangeMic: listingCurrency === "USD" ? "XNAS" : "XPAR",
      symbol: `DS4${String(instrumentSeq).padStart(4, "0")}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "AUTO",
    });
    return id;
  }

  async function createPortfolio(session: Session, name: string): Promise<string> {
    const response = await post("/api/v1/portfolios", { name }, session);
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    // CA-9: every fiat-settled write names the cash account its money moved
    // through, and the USD leg of fixture row 6 needs a USD account.
    await seedCashAccountsForPortfolio(ownerDb, id);
    return id;
  }

  async function createUserFor(tenantId: string, email: string): Promise<Session> {
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    return loginAs(server(), email, PASSWORD);
  }

  /** One EUR dividend, over the wire, awaited before the next one fires. */
  async function postEurDividend(
    session: Session,
    portfolioId: string,
    instrumentId: string,
    tradeDate: string,
    amount: string,
  ): Promise<string> {
    const response = await post(
      "/api/v1/transactions",
      {
        kind: "DIVIDEND",
        portfolioId,
        instrumentId,
        tradeDate,
        amount,
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      },
      session,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    ownerDb = testApp.ownerDb;
    await ownerDb
      .insert(tenant)
      .values([{ id: tenantA }, { id: tenantB }, { id: tenantCosted }, { id: tenantCapped }]);

    const suffix = randomUUID();
    aliceSession = await createUserFor(tenantA, `alice-dividends-${suffix}@example.com`);
    bobSession = await createUserFor(tenantB, `bob-dividends-${suffix}@example.com`);
    costedSession = await createUserFor(tenantCosted, `costed-dividends-${suffix}@example.com`);
    cappedSession = await createUserFor(tenantCapped, `capped-dividends-${suffix}@example.com`);

    instrumentX = await seedInstrument("Air Liquide");
    instrumentY = await seedInstrument("Apple Inc.", "USD");
    instrumentZ = await seedInstrument("Bouygues");
    instrumentOther = await seedInstrument("Société Générale");
    instrumentCosted = await seedInstrument("Orange");

    // AC-API-1: exactly one iconed instrument (Apple, for
    // Alice's tenant only), so `hasIcon` is asserted in both states and its
    // tenant scoping is observed in Bob's body. The presence flag never reads
    // the bytes, so the 8-byte PNG signature is all the fixture needs.
    await ownerDb.insert(instrumentIcon).values({
      tenantId: tenantA,
      instrumentId: instrumentY,
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      contentType: "image/png",
      byteLength: 8,
      widthPx: 1,
      heightPx: 1,
      source: "MANUAL",
    });

    portfolioP1 = await createPortfolio(aliceSession, "DS-4 P1");
    portfolioP2 = await createPortfolio(aliceSession, "DS-4 P2");

    // Fixture rows 1, 2, 4, 5 — X in P1, sequentially.
    await postEurDividend(aliceSession, portfolioP1, instrumentX, "2019-01-15", "10.00");
    const row2 = await postEurDividend(
      aliceSession,
      portfolioP1,
      instrumentX,
      "2019-03-20",
      "15.50",
    );
    await postEurDividend(aliceSession, portfolioP1, instrumentX, "2020-02-05", "7.25");
    await postEurDividend(aliceSession, portfolioP1, instrumentX, "2024-06-10", "4.50");

    // Row 3 — the DRIP that reinvests row 2, same instrument, same 15,50, one
    // day later (AC6 requires the `sourceDividendId` link). FR-267 excludes it
    // structurally: its legs classify INTERNAL, so they can never enter an
    // INCOME sum.
    const drip = await post(
      "/api/v1/transactions",
      {
        kind: "DRIP",
        portfolioId: portfolioP1,
        instrumentId: instrumentX,
        sourceDividendId: row2,
        tradeDate: "2019-03-21",
        quantity: "0.5",
        unitPrice: "31.00",
        currency: "EUR",
        cashAccountId: cash(portfolioP1, "EUR"),
      },
      aliceSession,
    );
    expect(drip.status, JSON.stringify(drip.body)).toBe(201);

    // Row 6 — 100,00 USD gross, 15,00 USD withheld, both legs pinned at 0,9234
    // so `amount_base` is 92,34 and −13,851 exactly. The pin is what keeps this
    // suite off any FX provider (`not-configured-providers.ts`: a pinned rate
    // is an early return, the port is never called).
    const usd = await post(
      "/api/v1/transactions",
      {
        kind: "DIVIDEND",
        portfolioId: portfolioP1,
        instrumentId: instrumentY,
        tradeDate: "2024-06-10",
        amount: "100.00",
        currency: "USD",
        cashAccountId: cash(portfolioP1, "USD"),
        fxRateUserInput: "0.923400000000",
        withholding: { amount: "15.00" },
      },
      aliceSession,
    );
    expect(usd.status, JSON.stringify(usd.body)).toBe(201);

    // Rows 7 and 8.
    await postEurDividend(aliceSession, portfolioP2, instrumentX, "2024-06-10", "3.00");
    await postEurDividend(aliceSession, portfolioP1, instrumentZ, "2024-06-10", "60.00");

    // Tenant B's own single dividend — the isolation counterparty.
    const portfolioB = await createPortfolio(bobSession, "DS-4 B");
    await postEurDividend(bobSession, portfolioB, instrumentOther, "2024-06-10", "11.00");

    // DV11's tenant: one ordinary dividend now, made ambiguous out of band by
    // the test that owns that assertion.
    portfolioCosted = await createPortfolio(costedSession, "DS-4 costed");
    await postEurDividend(costedSession, portfolioCosted, instrumentCosted, "2024-06-10", "40.00");
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  /** The whole worked-example body, all-time, combined — hand-computed in advance and restated here with its arithmetic. */
  function fixtureBody(): Record<string, unknown> {
    return {
      baseCurrency: "EUR",
      from: null,
      to: null,
      portfolioId: null,
      total: FIXTURE_TOTAL, // 40,25 + 92,34 + 60,00 = 192,59
      instruments: [
        {
          instrumentId: instrumentY,
          displayName: "Apple Inc.",
          symbol: "DS40002",
          hasIcon: true,
          grossBase: "92.34", // 100,00 x 0,9234
          withholdingBase: "13.851", // 15,00 x 0,9234
          paymentCount: 1,
        },
        {
          instrumentId: instrumentZ,
          displayName: "Bouygues",
          symbol: "DS40003",
          hasIcon: false,
          grossBase: "60", // A7: never "60.000000000000"
          withholdingBase: "0",
          paymentCount: 1,
        },
        {
          instrumentId: instrumentX,
          displayName: "Air Liquide",
          symbol: "DS40001",
          hasIcon: false,
          grossBase: "40.25", // 10,00 + 15,50 + 7,25 + 4,50 + 3,00
          withholdingBase: "0",
          paymentCount: 5,
        },
      ],
      years: [
        { period: "2019", grossBase: "25.5", withholdingBase: "0" }, // 10,00 + 15,50
        { period: "2020", grossBase: "7.25", withholdingBase: "0" },
        { period: "2024", grossBase: "159.84", withholdingBase: "13.851" },
      ],
      months: [
        { period: "2019-01", grossBase: "10", withholdingBase: "0" },
        { period: "2019-03", grossBase: "15.5", withholdingBase: "0" },
        { period: "2020-02", grossBase: "7.25", withholdingBase: "0" },
        { period: "2024-06", grossBase: "159.84", withholdingBase: "13.851" },
      ],
    };
  }

  describe("the 200 body over the wire, every figure a string (AC-282..AC-289)", () => {
    it("returns the whole hand-computed shape for the all-time default, with no calcEpoch", async () => {
      const response = await get("/api/v1/dividends/summary", aliceSession);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // The full payload, compared as a whole rather than field-spotted: the
      // DRIP (row 3) is in the database and contributes to none of it, which is
      // FR-267's exclusion proved on the wire.
      expect(response.body).toEqual(fixtureBody());
      expect(response.body).not.toHaveProperty("calcEpoch");
    });

    it("AC-286 — the unselected default really is all-time: the 2019-01-15 payment is in it", async () => {
      const response = await get("/api/v1/dividends/summary", aliceSession);

      expect(response.status).toBe(200);
      const months = response.body.months as { period: string; grossBase: string }[];
      expect(months.map((row) => row.period)).toContain("2019-01");
      // A 1Y-defaulting control (the failure reusing `resolveReturnWindow`
      // would produce) drops rows 1, 2 and 4 and reports X at 7,50.
      const airLiquide = (
        response.body.instruments as { instrumentId: string; grossBase: string }[]
      ).find((row) => row.instrumentId === instrumentX);
      expect(airLiquide?.grossBase).toBe("40.25");
      expect(airLiquide?.grossBase).not.toBe("7.5");
    });

    it("AC-287 — one request, and from/to bounds the instruments AND both bucket arrays together", async () => {
      const response = await get(
        "/api/v1/dividends/summary?from=2024-01-01&to=2024-12-31",
        aliceSession,
      );

      expect(response.status).toBe(200);
      expect(response.body.from).toBe("2024-01-01");
      expect(response.body.to).toBe("2024-12-31");
      expect(response.body.total).toEqual({ grossBase: "159.84", withholdingBase: "13.851" });
      // X in 2024 = 4,50 (P1) + 3,00 (P2) = 7,50.
      const instruments = response.body.instruments as {
        instrumentId: string;
        grossBase: string;
      }[];
      expect(instruments.find((row) => row.instrumentId === instrumentX)?.grossBase).toBe("7.5");
      expect(response.body.years).toEqual([
        { period: "2024", grossBase: "159.84", withholdingBase: "13.851" },
      ]);
      expect(response.body.months).toEqual([
        { period: "2024-06", grossBase: "159.84", withholdingBase: "13.851" },
      ]);
    });

    it("AC-289 — three year buckets and four month buckets, 2021-2023 and 2019-02 absent", async () => {
      const response = await get("/api/v1/dividends/summary", aliceSession);

      // Length first, separately from the values: a bucket folded into its
      // neighbour keeps every remaining value plausible but changes the count.
      expect(response.body.years).toHaveLength(3);
      expect(response.body.months).toHaveLength(4);
      const monthPeriods = (response.body.months as { period: string }[]).map((row) => row.period);
      expect(monthPeriods).not.toContain("2019-02");
    });
  });

  describe("AC-288 — ?portfolio= narrows, it does not relabel (LD-5)", () => {
    it("P1 gives X strictly less than the combined figure; P2 gives X alone", async () => {
      const combined = await get("/api/v1/dividends/summary", aliceSession);
      const p1 = await get(`/api/v1/dividends/summary?portfolio=${portfolioP1}`, aliceSession);

      expect(p1.status).toBe(200);
      expect(p1.body.portfolioId).toBe(portfolioP1);
      const p1X = (p1.body.instruments as { instrumentId: string; grossBase: string }[]).find(
        (row) => row.instrumentId === instrumentX,
      );
      // X in P1 = 10,00 + 15,50 + 7,25 + 4,50 = 37,25, strictly below 40,25 —
      // asserted as an inequality, so some other subset still fails.
      expect(p1X?.grossBase).toBe("37.25");
      expect(new Decimal(p1X?.grossBase ?? "0").lessThan(new Decimal("40.25"))).toBe(true);
      expect(p1.body.total).toEqual({ grossBase: "189.59", withholdingBase: "13.851" });
      expect(
        new Decimal(String((p1.body.total as { grossBase: string }).grossBase)).lessThan(
          new Decimal(String((combined.body.total as { grossBase: string }).grossBase)),
        ),
      ).toBe(true);

      const p2 = await get(`/api/v1/dividends/summary?portfolio=${portfolioP2}`, aliceSession);
      expect(p2.status).toBe(200);
      expect(p2.body.instruments).toEqual([
        {
          instrumentId: instrumentX,
          displayName: "Air Liquide",
          symbol: "DS40001",
          hasIcon: false,
          grossBase: "3",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });

    it("a portfolio id this tenant does not own is the empty shape, never a 404", async () => {
      const response = await get(
        `/api/v1/dividends/summary?portfolio=${randomUUID()}`,
        aliceSession,
      );

      expect(response.status).toBe(200);
      expect(response.body.instruments).toEqual([]);
      expect(response.body.total).toEqual({ grossBase: "0", withholdingBase: "0" });
      // Still labelled, which a `min(base_currency)` over nothing would not be.
      expect(response.body.baseCurrency).toBe("EUR");
    });
  });

  describe("auth and tenancy", () => {
    it("401 without a session cookie", async () => {
      const response = await server().get("/api/v1/dividends/summary");

      expect(response.status).toBe(401);
    });

    it("tenant B's dividend never appears in tenant A's response, and vice versa", async () => {
      const asA = await get("/api/v1/dividends/summary", aliceSession);
      const asB = await get("/api/v1/dividends/summary", bobSession);

      // A's body is compared against its own fixture-only expected shape, not
      // merely checked for the absence of one id.
      expect(asA.body).toEqual(fixtureBody());
      expect(
        (asA.body.instruments as { instrumentId: string }[]).map((row) => row.instrumentId),
      ).not.toContain(instrumentOther);

      expect(asB.status).toBe(200);
      expect(asB.body.instruments).toEqual([
        {
          instrumentId: instrumentOther,
          displayName: "Société Générale",
          symbol: "DS40004",
          hasIcon: false,
          grossBase: "11",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
      expect(asB.body.total).toEqual({ grossBase: "11", withholdingBase: "0" });
    });
  });

  describe("the error table, over HTTP", () => {
    it("a malformed `from` is a 400 VALIDATION_ERROR problem+json, never a 500", async () => {
      const response = await get("/api/v1/dividends/summary?from=not-a-date", aliceSession);

      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("VALIDATION_ERROR");
      // Every reported entry is about `from` and nothing else — the regex and
      // the real-calendar-date refinement both fire here, so this is a
      // field-scope assertion rather than an entry count.
      const fields = (response.body.errors as { field: string }[]).map((entry) => entry.field);
      expect(fields.length).toBeGreaterThan(0);
      expect(new Set(fields)).toEqual(new Set(["from"]));
    });

    it("`from` after `to` is the same 400 VALIDATION_ERROR, not a bespoke code", async () => {
      const response = await get(
        "/api/v1/dividends/summary?from=2024-12-31&to=2024-01-01",
        aliceSession,
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("a non-uuid `portfolio` is a 400, not an empty 200 that silently ignored the filter", async () => {
      const response = await get("/api/v1/dividends/summary?portfolio=P1", aliceSession);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("positive companion — the costed tenant's dividend summarises normally before it is made ambiguous", async () => {
      const response = await get("/api/v1/dividends/summary", costedSession);

      expect(response.status).toBe(200);
      expect(response.body.instruments).toEqual([
        {
          instrumentId: instrumentCosted,
          displayName: "Orange",
          symbol: "DS40005",
          hasIcon: false,
          grossBase: "40",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });

    it("DV11 — a DIVIDEND carrying a fee_amount refuses the whole request with 422 DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG", async () => {
      // Written out of band, because no API path can produce this shape: the
      // shared create schema's `forbid(data.fee, "fee", …)` rejects a cost leg
      // on a DIVIDEND, and `TransactionCashLegNotAddableError` blocks the edit
      // path. `fee_amount` is itemised entirely as `tax_amount` because
      // `transaction_cost_components_sum_to_fee_amount` requires the total.
      //
      // **Since migration `0059` the database refuses it too**,
      // so the constraint is dropped for this one write and restored straight
      // after. That is not a workaround for the CHECK — it is the scenario:
      // `transaction_dividend_shape` is `NOT VALID`, so it stops new writes and
      // leaves a **legacy row** (one written before `0059`) exactly where it is.
      // A deployment migrated over such a row still serves this request, and
      // this 422 is the only thing standing between it and a silently-wrong
      // «Retenue à la source» figure. The guard is load-bearing, not redundant.
      await ownerDb.execute(
        sql`ALTER TABLE "transaction" DROP CONSTRAINT "transaction_dividend_shape"`,
      );
      try {
        await ownerDb
          .update(transaction)
          .set({ feeAmount: new Decimal("2.00"), taxAmount: new Decimal("2.00") })
          .where(eq(transaction.tenantId, tenantCosted));
      } finally {
        await ownerDb.execute(
          sql`ALTER TABLE "transaction" ADD CONSTRAINT "transaction_dividend_shape" CHECK ("transaction"."kind" <> 'DIVIDEND' OR (
        "transaction"."instrument_id" IS NOT NULL
        AND "transaction"."quantity" IS NULL
        AND "transaction"."unit_price" IS NULL
        AND "transaction"."target_currency" IS NULL
        AND "transaction"."target_amount" IS NULL
        AND "transaction"."source_dividend_id" IS NULL
        AND "transaction"."fee_amount" IS NULL
      )) NOT VALID`,
        );
      }

      const response = await get("/api/v1/dividends/summary", costedSession);

      expect(response.status).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG");
      // Refused as a whole — never a figure with the ambiguous leg quietly
      // summed into «Retenue à la source», and never a partial body.
      expect(response.body).not.toHaveProperty("instruments");
    });
  });

  /**
   * DS-11 (release gate) — AR-5's HTTP-level half. Every other guard in the
   * error table has an HTTP-level assertion in this file; this one did not,
   * because `dividends.controller.ts`'s own doc comment records it as
   * *deliberately* absent from the mapped-error table — it falls through to
   * `ProblemJsonExceptionFilter`'s generic 500, the honest status for
   * "this deployment's stored data disagrees with itself", never a 4xx that
   * would tell the caller to fix their request.
   *
   * `dividend-summary-service.integration.test.ts`'s own "AR-5" describe block
   * proves the guard fires at the service layer, on `tenantMislabelled`, the
   * same out-of-band-relabel shape used here: `trg_transaction_posting_base_
   * currency_fill` is `BEFORE INSERT` only, so a relabelling `UPDATE` (the only
   * path a stored mismatch can occur through) is the one way to reach it. This
   * closes the gap the ledger-level proof cannot see on its own — what a real
   * client actually receives — and pins the response shape a future change to
   * `ProblemJsonExceptionFilter` or an accidental new 4xx mapping would break.
   */
  describe("DS-11 — AR-5 over HTTP: a relabelled posting is a 500, not a figure in an unknown unit", () => {
    const tenantMislabelled = "00000000-0000-7000-8000-00000266000e";
    let mislabelledSession: Session;
    let instrumentMislabelled: string;

    beforeAll(async () => {
      await ownerDb.insert(tenant).values({ id: tenantMislabelled });
      const suffix = randomUUID();
      mislabelledSession = await createUserFor(
        tenantMislabelled,
        `mislabelled-dividends-${suffix}@example.com`,
      );
      instrumentMislabelled = await seedInstrument("Danone");
      const portfolioId = await createPortfolio(mislabelledSession, "DS-11 mislabelled");
      await postEurDividend(
        mislabelledSession,
        portfolioId,
        instrumentMislabelled,
        "2024-06-10",
        "20.00",
      );
    }, 60_000);

    it("positive companion — the correctly-labelled dividend summarises normally first", async () => {
      const response = await get("/api/v1/dividends/summary", mislabelledSession);

      expect(response.status).toBe(200);
      expect(response.body.instruments).toEqual([
        {
          instrumentId: instrumentMislabelled,
          displayName: "Danone",
          symbol: "DS40006",
          hasIcon: false,
          grossBase: "20",
          withholdingBase: "0",
          paymentCount: 1,
        },
      ]);
    });

    it("is a 500 application/problem+json, with no internal detail, once the posting disagrees with tenant.base_currency", async () => {
      await ownerDb
        .update(transactionPosting)
        .set({ baseCurrency: "USD" })
        .where(eq(transactionPosting.tenantId, tenantMislabelled));

      const response = await get("/api/v1/dividends/summary", mislabelledSession);

      expect(response.status).toBe(500);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      // The filter's own "no internal detail leaked" claim (problem-json.filter.ts),
      // asserted at the wire rather than only read from its source: the exact
      // generic body, nothing from `DividendBaseCurrencyMismatchError`'s own
      // message (the currency codes, "AR-5", "base_currency") rides along.
      expect(response.body).toEqual({
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
      });
      const wire = JSON.stringify(response.body);
      expect(wire).not.toContain("base_currency");
      expect(wire).not.toContain("AR-5");
      expect(wire).not.toContain("USD");
    });
  });

  /**
   * DV6 — the instrument cap **refuses**, it never truncates: a
   * truncated `instruments[]` would make `total` disagree with the rows shown
   * (G5). Proved at the real, shipped cap rather than through DS-1's test-only
   * override, because the override is deliberately unreachable from the route
   * — the boundary this test walks is the one a client can actually reach.
   *
   * The fixture is one instrument per dividend, `MAX + 1` of them, with the
   * last one's payment a month later: so the *same* fixture answers `200` at
   * exactly the cap (bounded by `?to=`) and `422` one instrument past it.
   */
  describe("DV6 — the instrument cap, at the boundary, over HTTP", () => {
    const AT_CAP_DATE = "2024-01-15";
    const OVER_CAP_DATE = "2024-02-15";

    beforeAll(async () => {
      const portfolioId = await createPortfolio(cappedSession, "DS-4 capped");
      const cashAccountId = cash(portfolioId, "EUR");

      const instruments: Array<typeof instrument.$inferInsert> = [];
      const rows: Array<typeof transaction.$inferInsert> = [];
      const postings: Array<typeof transactionPosting.$inferInsert> = [];

      for (let i = 0; i <= MAX_DIVIDEND_INSTRUMENTS_PER_VIEW; i++) {
        const instrumentId = randomUUID();
        instruments.push({
          id: instrumentId,
          kind: "SHARE",
          displayName: `DS-4 cap ${i}`,
          listingCurrency: "EUR",
          exchangeMic: "XPAR",
          symbol: `DS4CAP${String(i).padStart(5, "0")}`,
          primaryIdentifier: "SYMBOL",
          quotePolicy: "AUTO",
        });
        const row: typeof transaction.$inferInsert = {
          id: randomUUID(),
          tenantId: tenantCapped,
          baseCurrency: "EUR",
          portfolioId,
          kind: "DIVIDEND",
          tradeDate: i === MAX_DIVIDEND_INSTRUMENTS_PER_VIEW ? OVER_CAP_DATE : AT_CAP_DATE,
          tradeTs: null,
          seq: BigInt(i + 1),
          instrumentId,
          quantity: null,
          unitPrice: null,
          grossAmount: new Decimal("1.00"),
          txnCurrency: "EUR",
          cashCurrency: "EUR",
          cashAmount: new Decimal("1.00"),
          cashAccountId,
          targetCashAccountId: null,
          txnSettlementInstrumentId: null,
          targetCurrency: null,
          targetAmount: null,
          feeAmount: null,
          withholdingAmount: null,
          sourceDividendId: null,
          fxRate: new Decimal(1),
          fxRateSource: "IMPLIED_BASE",
        };
        rows.push(row);
        postings.push(...postingRowsFor(row));
      }

      for (const batch of chunk(instruments, 500)) {
        await ownerDb.insert(instrument).values(batch);
      }
      for (const batch of chunk(rows, 500)) {
        await ownerDb.insert(transaction).values(batch);
      }
      for (const batch of chunk(postings, 500)) {
        await ownerDb.insert(transactionPosting).values(batch);
      }
    }, 180_000);

    it("serves exactly MAX_DIVIDEND_INSTRUMENTS_PER_VIEW instruments", async () => {
      const response = await get(`/api/v1/dividends/summary?to=${AT_CAP_DATE}`, cappedSession);

      expect(response.status, JSON.stringify(response.body).slice(0, 400)).toBe(200);
      expect(response.body.instruments).toHaveLength(MAX_DIVIDEND_INSTRUMENTS_PER_VIEW);
      expect(response.body.total).toEqual({
        grossBase: String(MAX_DIVIDEND_INSTRUMENTS_PER_VIEW),
        withholdingBase: "0",
      });
    }, 60_000);

    it("refuses one instrument past it with 422 DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE, never a truncated array", async () => {
      const response = await get("/api/v1/dividends/summary", cappedSession);

      expect(response.status).toBe(422);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.code).toBe("DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE");
      expect(response.body).not.toHaveProperty("instruments");
    }, 60_000);
  });

  /**
   * `scpi` cycle, SC-T7 — AC-506 (FR-617): an SCPI distribution is a plain
   * DIVIDEND. No SCPI-specific code path exists, so everything here is either
   * a hand-computed figure or an equality with a SHARE / another SCPI. Its own
   * tenant; SCPI rows inserted directly like every instrument in this file.
   */
  describe("scpi — distributions are plain dividends (AC-506)", () => {
    const tenantScpi = "00000000-0000-7000-8000-00000777000a";
    let scpiSession: Session;
    let scpiA: string;
    let portfolioA: string;

    async function seedScpi(
      displayName: string,
      attributes: { managementCompany: string | null; subscriptionFeePct: string | null },
    ): Promise<string> {
      instrumentSeq += 1;
      const id = randomUUID();
      await ownerDb.insert(instrument).values({
        id,
        kind: "SCPI",
        displayName,
        listingCurrency: "EUR",
        exchangeMic: null,
        symbol: `SCPIDV${String(instrumentSeq).padStart(4, "0")}`,
        primaryIdentifier: "SYMBOL",
        quotePolicy: "MANUAL_ONLY",
        managementCompany: attributes.managementCompany,
        subscriptionFeePct:
          attributes.subscriptionFeePct === null
            ? null
            : new Decimal(attributes.subscriptionFeePct),
      });
      return id;
    }

    /** A USD distribution with a distinct withholding leg, both pinned at 0,9234 (no FX provider). */
    async function postUsdDividendWithWithholding(
      portfolioId: string,
      instrumentId: string,
    ): Promise<void> {
      const response = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId,
          instrumentId,
          tradeDate: "2026-04-15",
          amount: "100.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.923400000000",
          withholding: { amount: "15.00" },
        },
        scpiSession,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }

    /** A per-portfolio summary with the instrument's and portfolio's identity taken out — what "equal apart from identity" compares. */
    async function summaryWithoutIdentity(portfolioId: string): Promise<unknown> {
      const response = await get(`/api/v1/dividends/summary?portfolio=${portfolioId}`, scpiSession);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const instruments = response.body.instruments as Record<string, unknown>[];
      expect(instruments).toHaveLength(1);
      return {
        ...response.body,
        portfolioId: "<portfolio>",
        instruments: instruments.map(
          ({ instrumentId: _id, displayName: _name, symbol: _symbol, ...rest }) => rest,
        ),
      };
    }

    beforeAll(async () => {
      await ownerDb.insert(tenant).values({ id: tenantScpi });
      scpiSession = await createUserFor(tenantScpi, `scpi-dividends-${randomUUID()}@example.com`);
      scpiA = await seedScpi("SCPI-A distributions", {
        managementCompany: "Corum Asset Management",
        subscriptionFeePct: "8.50",
      });
      portfolioA = await createPortfolio(scpiSession, "AC-506 SCPI-A");
      await postEurDividend(scpiSession, portfolioA, scpiA, "2026-03-31", "12.50");
      await postEurDividend(scpiSession, portfolioA, scpiA, "2026-06-30", "12.50");
    }, 120_000);

    it("two 12.50 EUR distributions: SCPI-A's gross total is exactly 25.00, in the March and June cells and no other month", async () => {
      const response = await get(`/api/v1/dividends/summary?portfolio=${portfolioA}`, scpiSession);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // The wire form carries no scale padding (A7): "25" is 25.00 exactly.
      expect(response.body.instruments).toEqual([
        {
          instrumentId: scpiA,
          displayName: "SCPI-A distributions",
          symbol: expect.stringMatching(/^SCPIDV/),
          hasIcon: false,
          grossBase: "25",
          withholdingBase: "0",
          paymentCount: 2,
        },
      ]);
      expect(response.body.months).toEqual([
        { period: "2026-03", grossBase: "12.5", withholdingBase: "0" },
        { period: "2026-06", grossBase: "12.5", withholdingBase: "0" },
      ]);
      expect(response.body.total).toEqual({ grossBase: "25", withholdingBase: "0" });

      // The tenant-wide view says the same about SCPI-A.
      const combined = await get("/api/v1/dividends/summary", scpiSession);
      const scpiARow = (
        combined.body.instruments as { instrumentId: string; grossBase: string }[]
      ).find((row) => row.instrumentId === scpiA);
      expect(scpiARow?.grossBase).toBe("25");
    });

    it("a distribution with withholding and a pinned FX rate summarises on an SCPI exactly as on a SHARE", async () => {
      const scpiW = await seedScpi("SCPI withholding", {
        managementCompany: null,
        subscriptionFeePct: null,
      });
      const shareW = await seedInstrument("SHARE withholding");
      const portfolioScpi = await createPortfolio(scpiSession, "AC-506 SCPI withholding");
      const portfolioShare = await createPortfolio(scpiSession, "AC-506 SHARE withholding");
      await postUsdDividendWithWithholding(portfolioScpi, scpiW);
      await postUsdDividendWithWithholding(portfolioShare, shareW);

      const scpiSummary = await summaryWithoutIdentity(portfolioScpi);
      expect(scpiSummary).toEqual(await summaryWithoutIdentity(portfolioShare));
      // And the figures are the hand-computed ones: 100,00 and 15,00 USD at 0,9234.
      expect((scpiSummary as { total: unknown }).total).toEqual({
        grossBase: "92.34",
        withholdingBase: "13.851",
      });
    });

    it("two SCPI with identical rows but different attributes produce Dividendes responses equal apart from identity", async () => {
      const scpiC = await seedScpi("SCPI-C", {
        managementCompany: "Corum Asset Management",
        subscriptionFeePct: "8.50",
      });
      const scpiD = await seedScpi("SCPI-D", {
        managementCompany: "Sofidy",
        subscriptionFeePct: "10.00",
      });
      const portfolioC = await createPortfolio(scpiSession, "AC-506 SCPI-C");
      const portfolioD = await createPortfolio(scpiSession, "AC-506 SCPI-D");
      for (const [portfolioId, instrumentId] of [
        [portfolioC, scpiC],
        [portfolioD, scpiD],
      ] as const) {
        await postEurDividend(scpiSession, portfolioId, instrumentId, "2026-03-31", "12.50");
        await postEurDividend(scpiSession, portfolioId, instrumentId, "2026-06-30", "12.50");
      }

      expect(await summaryWithoutIdentity(portfolioC)).toEqual(
        await summaryWithoutIdentity(portfolioD),
      );
    });

    /**
     * The withholding is one amount, denominated by the settling
     * account. The Portfolio Performance reference dividend: 3.65 USD gross at
     * 0.9237 settled on an EUR account is 3.371505 EUR, and 0.51 EUR withheld.
     */
    describe("net dividend", () => {
      const WIRE_DROPPED = [
        "withholdingCurrency",
        "whtCashAccountId",
        "whtFxRate",
        "whtFxRateSource",
        "whtFxRateProviderKey",
        "whtFxRateObservedOn",
        "whtFxRateUserInput",
      ] as const;

      function patch(path: string, body: Record<string, unknown>, session: Session) {
        return server()
          .patch(path)
          .set("Cookie", [
            `${SID_COOKIE_NAME}=${session.sid}`,
            `${CSRF_COOKIE_NAME}=${session.csrf}`,
          ])
          .set(CSRF_HEADER_NAME, session.csrf)
          .send(body);
      }

      async function postPpDividend(portfolioId: string, instrumentId: string, withheld: string) {
        return post(
          "/api/v1/transactions",
          {
            kind: "DIVIDEND",
            portfolioId,
            instrumentId,
            tradeDate: "2026-04-15",
            amount: "3.65",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: "0.9237",
            withholding: { amount: withheld },
          },
          scpiSession,
        );
      }

      it("the PP reference dividend is a 201, reads back withholdingAmount 0.51 and no wht* keys, and the summary shows gross 3.371505 / withholding 0.51", async () => {
        const usdShare = await seedInstrument("PP reference", "USD");
        const portfolioId = await createPortfolio(scpiSession, "net-dividend PP");
        const created = await postPpDividend(portfolioId, usdShare, "0.51");
        expect(created.status, JSON.stringify(created.body)).toBe(201);

        const reread = await get(`/api/v1/transactions/${created.body.id as string}`, scpiSession);
        expect(reread.status).toBe(200);
        expect(reread.body.withholdingAmount).toBe("0.51");
        expect(reread.body.cashAmount).toBe("3.371505");
        for (const dropped of WIRE_DROPPED) expect(Object.keys(reread.body)).not.toContain(dropped);

        const summary = await get(
          `/api/v1/dividends/summary?portfolio=${portfolioId}`,
          scpiSession,
        );
        expect(summary.status, JSON.stringify(summary.body)).toBe(200);
        // Gross and withholding, never the net and never 0.
        expect(summary.body.total).toEqual({ grossBase: "3.371505", withholdingBase: "0.51" });
      });

      it("a withholding at or above the principal cash amount is refused on create, naming withholding.amount", async () => {
        const usdShare = await seedInstrument("PP refused", "USD");
        const portfolioId = await createPortfolio(scpiSession, "net-dividend refused");
        // 3.65 USD settles as 3.371505 EUR: the cash amount, not the 3.65 gross, is the bound.
        for (const withheld of ["3.371505", "4.00"]) {
          const refused = await postPpDividend(portfolioId, usdShare, withheld);
          expect(refused.status, withheld).toBe(400);
          expect(refused.headers["content-type"]).toContain("application/problem+json");
          expect(refused.body.code).toBe("TRANSACTION_ARGUMENT_INVALID");
          expect(refused.body.detail).toContain("withholding.amount");
          expect(refused.body.detail).toMatch(/below|less|strictly/i);
        }
      });

      it("an EDIT raising the withholding to the cash amount or above is refused with a 4xx problem+json, row unchanged", async () => {
        const usdShare = await seedInstrument("PP edit", "USD");
        const portfolioId = await createPortfolio(scpiSession, "net-dividend edit");
        const created = await postPpDividend(portfolioId, usdShare, "0.51");
        expect(created.status).toBe(201);
        const id = created.body.id as string;

        for (const withheld of ["3.371505", "9.00"]) {
          const refused = await patch(
            `/api/v1/transactions/${id}`,
            { withholdingAmount: withheld },
            scpiSession,
          );
          expect(refused.status, withheld).toBeGreaterThanOrEqual(400);
          expect(refused.status, withheld).toBeLessThan(500);
          expect(refused.headers["content-type"]).toContain("application/problem+json");
          expect(refused.body.detail).toContain("withholdingAmount");
        }
        const reread = await get(`/api/v1/transactions/${id}`, scpiSession);
        expect(reread.body.withholdingAmount).toBe("0.51");
      });
    });
  });
});

/**
 * `seed-fixture.ts`'s own `toExpandable`, local to this file the same way
 * `dividend-summary-service.integration.test.ts` keeps its copy: `load` is not
 * an `api` dependency, and this is a fixture concern rather than a shared one.
 */
function toExpandable(row: typeof transaction.$inferInsert): ExpandableTransaction {
  return {
    kind: row.kind,
    instrumentId: row.instrumentId ?? null,
    quantity: row.quantity ?? null,
    grossAmount: row.grossAmount,
    txnCurrency: row.txnCurrency ?? null,
    txnSettlementInstrumentId: row.txnSettlementInstrumentId ?? null,
    targetCurrency: row.targetCurrency ?? null,
    targetAmount: row.targetAmount ?? null,
    cashAccountId: row.cashAccountId ?? null,
    targetCashAccountId: row.targetCashAccountId ?? null,
    cashCurrency: row.cashCurrency ?? null,
    cashAmount: row.cashAmount ?? null,
    brokerFeeAmount: row.brokerFeeAmount ?? null,
    fxFeeAmount: row.fxFeeAmount ?? null,
    taxAmount: row.taxAmount ?? null,
    otherCostAmount: row.otherCostAmount ?? null,
    feeAmount: row.feeAmount ?? null,
    withholdingAmount: row.withholdingAmount ?? null,
    fxRate: row.fxRate,
    fxRateSource: row.fxRateSource,
  };
}

/** This suite's rows settle in EUR only; production reads the minor unit from the `currency` table. */
const testMinorUnitOf = (): number => 2;

/** The **real** expander over a hand-built row — the cap fixture's postings are produced the way every production write produces them, never hand-written. */
function postingRowsFor(
  row: typeof transaction.$inferInsert,
): Array<typeof transactionPosting.$inferInsert> {
  return expandPostings(toExpandable(row), testMinorUnitOf).map((draft) => ({
    id: randomUUID(),
    tenantId: row.tenantId,
    baseCurrency: row.baseCurrency,
    transactionId: row.id,
    portfolioId: row.portfolioId,
    ...draft,
  }));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
