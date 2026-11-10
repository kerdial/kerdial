import { randomUUID } from "node:crypto";
import supertest from "supertest";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Decimal, toDecimalString } from "@kerdial/core-decimal";
import { cashAccount, tenant, transaction, withTenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import {
  FxRateResolver,
  TransactionAmountNotPositiveError,
  TransactionArgumentError,
  TransactionWriteService,
  createInstrumentByIsin,
  createInstrumentBySymbol,
} from "@kerdial/ledger";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * T-38 — `/transactions/*` endpoints, most notably AC53's
 * full-stack round-trip test (the "definitive test"
 * the spec singles out).
 */

const tenantA = "00000000-0000-7000-8000-0000003800a0";
const aliceId = "00000000-0000-7000-8000-0000003800a1";
const aliceEmail = "alice-transactions-t38@example.com";
const alicePassword = "correct horse battery staple transactions";

describe("api — /transactions/* endpoints (T-38)", () => {
  let testApp: TestApp;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: { sid: string }) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function post(
    path: string,
    body: Record<string, unknown>,
    session: { sid: string; csrf: string },
  ) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function patch(
    path: string,
    body: Record<string, unknown>,
    session: { sid: string; csrf: string },
  ) {
    return server()
      .patch(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  function del(path: string, session: { sid: string; csrf: string }) {
    return server()
      .delete(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    await testApp.ownerDb.insert(tenant).values([{ id: tenantA }]);
    await createUser(testApp.db, {
      id: aliceId,
      tenantId: tenantA,
      email: aliceEmail,
      password: alicePassword,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  async function alice(): Promise<{ sid: string; csrf: string }> {
    return loginAs(server(), aliceEmail, alicePassword);
  }

  async function createPortfolio(session: { sid: string; csrf: string }): Promise<string> {
    const response = await post("/api/v1/portfolios", { name: `T-38 ${randomUUID()}` }, session);
    expect(response.status).toBe(201);
    // CA-9: every fiat-settled write in this suite names the cash account its
    // money moved through (FR-156). Seeded out of band — the cash-account HTTP
    // routes are Batch C of this cycle, not Batch B.
    await seedCashAccountsForPortfolio(testApp.ownerDb, response.body.id);
    return response.body.id;
  }

  /**
   * **Fixture instruments are created through the service
   * layer, not `POST /instruments`.**
   *
   * The budget arithmetic once written down here is historical
   * since ADR-0016 retired the 30/hour `POST /instruments` rate cap:
   * this file's helpers used to make **exactly 30** of them on Alice's tenant
   * before the FT-18 block (measured by walking the file), and arrival 31 was
   * a deterministic 429 on whatever create happened to be next, which is how
   * the `order=desc` case broke a CI run — the failure pointed at an
   * unrelated, unchanged test.
   *
   * **Not one of these creates is about the create endpoint.** Every one is
   * fixture setup for a `/transactions/*` case, and `instruments.e2e.test.ts`
   * owns the endpoint's own coverage. So the whole 30 moved off HTTP onto
   * `ledger`'s own `createInstrumentByIsin`/`createInstrumentBySymbol`
   * — the same functions `instruments.controller.ts` calls, so the row shape
   * cannot drift from what the endpoint would have written.
   *
   * `session` is kept in the signature, unused: `instrument` is shared
   * reference data with no `tenant_id`, so a fixture
   * instrument was never tenant-scoped — and keeping the parameter means the
   * ~30 call sites read unchanged, which keeps this diff about the budget
   * rather than about churn.
   *
   * **Not acceptable, and not done: raising the production cap.** It is a
   * security control sized deliberately.
   */
  async function createShareInstrument(
    _session: { sid: string; csrf: string },
    isin: string,
    currency = "EUR",
  ): Promise<string> {
    const row = await createInstrumentByIsin(testApp.ownerDb, {
      kind: "SHARE",
      isin,
      exchangeMic: "XPAR",
      listingCurrency: currency,
      displayName: `T-38 share ${isin}`,
    });
    return row.id;
  }

  async function createCryptoInstrument(
    _session: { sid: string; csrf: string },
    symbol: string,
  ): Promise<string> {
    const row = await createInstrumentBySymbol(testApp.ownerDb, {
      kind: "CRYPTO",
      symbol,
      listingCurrency: "USD",
      displayName: `T-38 crypto ${symbol}`,
    });
    return row.id;
  }

  /** Every decimal-shaped field in a `TransactionResponse` — asserted to be `typeof "string"` (or `null`), never a JSON number, per NFR-12/AC53. */
  const DECIMAL_FIELDS = [
    "quantity",
    "unitPrice",
    "grossAmount",
    "targetAmount",
    "feeAmount",
    "withholdingAmount",
    "fxRate",
    "fxRateUserInput",
  ] as const;

  function assertDecimalFieldsAreStrings(body: Record<string, unknown>): void {
    for (const field of DECIMAL_FIELDS) {
      const value = body[field];
      expect(value === null || typeof value === "string", `${field} must be a string or null`).toBe(
        true,
      );
    }
  }

  describe("POST /transactions — all seven kinds, plus the asset-settled BUY (FR-6..FR-10, FR-59, FR-66)", () => {
    it("records every kind, deriving the money leg and rejecting nothing that should succeed", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131609");

      const buy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-03-01",
          quantity: "10",
          unitPrice: "60",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(buy.status).toBe(201);
      expect(buy.body.grossAmount).toBe("600");
      expect(buy.body.fxRateSource).toBe("IMPLIED_BASE");
      assertDecimalFieldsAreStrings(buy.body);

      const sell = await post(
        "/api/v1/transactions",
        {
          kind: "SELL",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-03-05",
          quantity: "4",
          unitPrice: "65",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
          fee: { amount: "1.50" },
        },
        session,
      );
      expect(sell.status).toBe(201);
      assertDecimalFieldsAreStrings(sell.body);

      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-03-06",
          amount: "2500",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(deposit.status).toBe(201);
      assertDecimalFieldsAreStrings(deposit.body);

      const withdrawal = await post(
        "/api/v1/transactions",
        {
          kind: "WITHDRAWAL",
          portfolioId,
          tradeDate: "2024-03-07",
          amount: "100",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(withdrawal.status).toBe(201);
      assertDecimalFieldsAreStrings(withdrawal.body);

      const dividend = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-03-08",
          amount: "50",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
          withholding: { amount: "7.50" },
        },
        session,
      );
      expect(dividend.status).toBe(201);
      assertDecimalFieldsAreStrings(dividend.body);

      const drip = await post(
        "/api/v1/transactions",
        {
          kind: "DRIP",
          portfolioId,
          instrumentId: share,
          sourceDividendId: dividend.body.id,
          tradeDate: "2024-03-08",
          quantity: "0.5",
          unitPrice: "70",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(drip.status).toBe(201);
      assertDecimalFieldsAreStrings(drip.body);

      const exchange = await post(
        "/api/v1/transactions",
        {
          kind: "CURRENCY_EXCHANGE",
          portfolioId,
          tradeDate: "2024-03-09",
          amount: "1000",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
          targetCurrency: "USD",
          targetCashAccountId: cash(portfolioId, "USD"),
          exchangeRate: "1.08",
        },
        session,
      );
      expect(exchange.status).toBe(201);
      expect(exchange.body.targetAmount).toBe("1080");
      assertDecimalFieldsAreStrings(exchange.body);

      // CA-21: the four per-leg cash-account columns are on the **response**,
      // not only accepted on the request. `TransactionEditForm`'s pickers
      // cannot preselect a leg's current account without them — which is what
      // makes CD12 behaviour 3 ("the archived, currently-attributed account
      // stays offered") implementable at the edit entry point at all.
      //
      // Asserted here against the exact ids posted above, per kind, so a
      // mapper that echoed the same id into every slot would fail:
      expect(exchange.body.cashAccountId).toBe(cash(portfolioId, "EUR"));
      expect(exchange.body.targetCashAccountId).toBe(cash(portfolioId, "USD"));
      expect(exchange.body.cashAccountId).not.toBe(exchange.body.targetCashAccountId);
      // …and the negative companion, on a row that genuinely has no such leg:

      // FR-260: `feeCashAccountId` was asserted on three of these rows until
      // Removed it from the response — a cost leaves the settling
      // account, so the row names none of its own. The cost itself is still
      // asserted, on the row that has one.
      expect(sell.body.feeAmount).not.toBeNull();
      expect(Object.keys(sell.body)).not.toContain("feeCashAccountId");
      expect(Object.keys(sell.body)).not.toContain("feeCurrency");
      expect(sell.body.targetCashAccountId).toBeNull();
      // The withholding is one amount; none of its old companions is on the wire.
      for (const dropped of [
        "withholdingCurrency",
        "whtCashAccountId",
        "whtFxRate",
        "whtFxRateSource",
        "whtFxRateProviderKey",
        "whtFxRateObservedOn",
        "whtFxRateUserInput",
      ]) {
        expect(Object.keys(dividend.body)).not.toContain(dropped);
      }
      expect(dividend.body.withholdingAmount).toBe("7.5");
      expect(deposit.body.cashAccountId).toBe(cash(portfolioId, "EUR"));
      expect(deposit.body.feeAmount).toBeNull();

      // FR-66/AC52: an asset-settled BUY. First acquire some ETH normally so
      // the settlement leg (paying in ETH) has something to dispose of.
      const eth = await createCryptoInstrument(session, "T38ETH");
      const btc = await createCryptoInstrument(session, "T38BTC");
      const buyEth = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: eth,
          tradeDate: "2024-03-10",
          quantity: "5",
          unitPrice: "1000",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(buyEth.status).toBe(201);

      const settledBuy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: btc,
          tradeDate: "2024-03-11",
          quantity: "0.1",
          settlement: { instrumentId: eth, amount: "1", fxRateUserInput: "1000" },
        },
        session,
      );
      expect(settledBuy.status).toBe(201);
      expect(settledBuy.body.txnCurrency).toBeNull();
      expect(settledBuy.body.txnSettlementInstrumentId).toBe(eth);
      expect(settledBuy.body.grossAmount).toBe("1");
      // FR-157/CA-21: an asset-settled principal leg moves no cash, so the
      // response carries no principal account — the fact
      // `TransactionEditForm` reads to know it must render **no** principal
      // picker for this row, rather than one that could only ever 400.
      expect(settledBuy.body.cashAccountId).toBeNull();
      assertDecimalFieldsAreStrings(settledBuy.body);
    });

    // portfolio-cash (AC-567's DTO half, AC-587, G-17): a FEE may
    // name an instrument as a reference. The shared instrument-forbid branch
    // of the create schema names no kind, so a missing FEE exclusion there
    // makes this 201 a 400 — the assertion that would catch it is the status.
    it("records a FEE with and without an instrument reference, and GET round-trips the reference", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000138356");

      const referenced = await post(
        "/api/v1/transactions",
        {
          kind: "FEE",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-03-12",
          amount: "12.50",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
          note: "Frais de garde",
        },
        session,
      );
      expect(referenced.status).toBe(201);
      expect(referenced.body.kind).toBe("FEE");
      expect(referenced.body.grossAmount).toBe("12.5");
      assertDecimalFieldsAreStrings(referenced.body);

      const reread = await get(`/api/v1/transactions/${referenced.body.id}`, session);
      expect(reread.status).toBe(200);
      expect(reread.body.instrumentId).toBe(share);
      expect(reread.body.quantity).toBeNull();
      expect(reread.body.cashAccountId).toBe(cash(portfolioId, "EUR"));

      const bare = await post(
        "/api/v1/transactions",
        {
          kind: "FEE",
          portfolioId,
          tradeDate: "2024-03-12",
          amount: "3.00",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(bare.status).toBe(201);
      expect(bare.body.instrumentId).toBeNull();
    });
  });

  describe("AC53 — full-stack decimal round-trip (the definitive test)", () => {
    const FIXED_QUANTITY = "1.234567890123456789";
    const FIXED_FX_RATE = "0.12345678";

    /** Reads a `transaction` row directly via the ORM, bypassing the API entirely — the other half of AC53's two-hop assertion. */
    async function readViaOrm(id: string) {
      return withTenant(testApp.db, tenantA, async (tx) => {
        const [row] = await tx.select().from(transaction).where(eq(transaction.id, id));
        return row;
      });
    }

    it("a crypto BUY with an 18dp quantity and an 8dp pinned FX rate round-trips byte-identically via the ORM and via GET /transactions", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const crypto = await createCryptoInstrument(session, "T38AC53");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: crypto,
          tradeDate: "2024-04-01",
          quantity: FIXED_QUANTITY,
          unitPrice: "50000",
          // A non-base currency so the pinned fxRateUserInput is actually the
          // rate stored — a base-currency trade would store IMPLIED_BASE's
          // literal `1` regardless of what is pinned.
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: FIXED_FX_RATE,
        },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.quantity).toBe(FIXED_QUANTITY);
      expect(created.body.fxRate).toBe(FIXED_FX_RATE);
      expect(created.body.fxRateSource).toBe("USER_PINNED");

      // Hop 1: direct ORM read, bypassing the API.
      const ormRow = await readViaOrm(created.body.id);
      expect(ormRow).toBeDefined();
      expect(toDecimalString(ormRow!.quantity!)).toBe(FIXED_QUANTITY);
      expect(toDecimalString(ormRow!.fxRate)).toBe(FIXED_FX_RATE);

      // Hop 2: via GET /transactions/:id, through the API.
      const getOne = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(getOne.status).toBe(200);
      expect(getOne.body.quantity).toBe(FIXED_QUANTITY);
      expect(getOne.body.fxRate).toBe(FIXED_FX_RATE);

      // Hop 3: via GET /transactions (filtered), through the API.
      const list = await get(
        `/api/v1/transactions?portfolio=${portfolioId}&instrument=${crypto}`,
        session,
      );
      expect(list.status).toBe(200);
      const found = list.body.items.find((item: { id: string }) => item.id === created.body.id);
      expect(found).toBeDefined();
      expect(found.quantity).toBe(FIXED_QUANTITY);
      expect(found.fxRate).toBe(FIXED_FX_RATE);
    });

    /** Digit strings, so every generated `Decimal` comes from an exact decimal literal — never from a float (mirrors `ledger`'s own `posting-expander.property.test.ts`). */
    const digits = (maxLength: number): fc.Arbitrary<string> =>
      fc
        .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength })
        .map((chosen) => chosen.join(""));

    /** Exactly `length` digits — for the FX rate's fixed 8dp fractional part. */
    const exactDigits = (length: number): fc.Arbitrary<string> =>
      fc
        .array(fc.integer({ min: 0, max: 9 }), { minLength: length, maxLength: length })
        .map((chosen) => chosen.join(""));

    /** A positive quantity with up to 18 fractional digits — the crypto `NUMERIC(38,18)` precision NFR-12/AC53 requires. */
    const quantity18dpArb: fc.Arbitrary<string> = fc
      .tuple(digits(6), digits(18))
      .map(([whole, fraction]) => `${whole}.${fraction}`)
      .filter((value) => new Decimal(value).greaterThan(0));

    /** A positive FX rate with exactly 8 fractional digits (fixed example: "0.12345678, 8 dp"). */
    const fxRate8dpArb: fc.Arbitrary<string> = fc
      .tuple(fc.integer({ min: 0, max: 99 }), exactDigits(8))
      .map(([whole, fraction]) => `${whole}.${fraction}`)
      .filter((value) => new Decimal(value).greaterThan(0));

    it("property: random 18dp quantities and 8dp FX rates round-trip with zero drift, at every hop", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const crypto = await createCryptoInstrument(session, "T38PROP");

      await fc.assert(
        fc.asyncProperty(quantity18dpArb, fxRate8dpArb, async (quantityStr, fxRateStr) => {
          // The canonical (trailing-zero-trimmed) form is what every layer
          // is expected to echo back — `Decimal`'s own normalisation, not
          // the raw generated digits (a generated "5.000" is the same
          // value as "5", and every hop here is expected to say so).
          const canonicalQuantity = toDecimalString(new Decimal(quantityStr));
          const canonicalFxRate = toDecimalString(new Decimal(fxRateStr));

          const created = await post(
            "/api/v1/transactions",
            {
              kind: "BUY",
              portfolioId,
              instrumentId: crypto,
              tradeDate: "2024-04-02",
              quantity: quantityStr,
              unitPrice: "1",
              currency: "USD",
              cashAccountId: cash(portfolioId, "USD"),
              fxRateUserInput: fxRateStr,
            },
            session,
          );
          expect(created.status).toBe(201);
          expect(created.body.quantity).toBe(canonicalQuantity);
          expect(created.body.fxRate).toBe(canonicalFxRate);

          const ormRow = await readViaOrm(created.body.id);
          expect(toDecimalString(ormRow!.quantity!)).toBe(canonicalQuantity);
          expect(toDecimalString(ormRow!.fxRate)).toBe(canonicalFxRate);

          const getOne = await get(`/api/v1/transactions/${created.body.id}`, session);
          expect(getOne.status).toBe(200);
          expect(getOne.body.quantity).toBe(canonicalQuantity);
          expect(getOne.body.fxRate).toBe(canonicalFxRate);
        }),
        { numRuns: 20 },
      );
    }, 120_000);
  });

  describe("PATCH /transactions/:id/fx-rate is the only endpoint that can change fx_rate (FR-57, FR-64, AC47)", () => {
    it("a plain PATCH /transactions/:id body naming fxRate is rejected (400), and the stored rate is unchanged", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000442204", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-05-01",
          quantity: "3",
          unitPrice: "100",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.9",
        },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.fxRate).toBe("0.9");

      const rejected = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { fxRate: "0.5", note: "trying to sneak an fx change through the generic edit" },
        session,
      );
      expect(rejected.status).toBe(400);
      expect(rejected.headers["content-type"]).toContain("application/problem+json");
      expect(rejected.body.code).toBe("TRANSACTION_FX_EDIT_FORBIDDEN");

      // Never silently applied: re-reading proves the rate is untouched, not
      // merely that the HTTP call itself was rejected.
      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.status).toBe(200);
      expect(reread.body.fxRate).toBe("0.9");
      expect(reread.body.note).not.toBe("trying to sneak an fx change through the generic edit");
    });

    it("PATCH /transactions/:id/fx-rate is the endpoint that actually changes fx_rate (FR-64/AC50)", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000442212", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-05-02",
          quantity: "3",
          unitPrice: "100",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.9",
        },
        session,
      );
      expect(created.status).toBe(201);

      const corrected = await patch(
        `/api/v1/transactions/${created.body.id}/fx-rate`,
        { fxRate: "0.95" },
        session,
      );
      expect(corrected.status).toBe(200);
      expect(corrected.body.fxRate).toBe("0.95");
      expect(corrected.body.fxRateSource).toBe("USER_PINNED");

      // A plain PATCH still cannot follow up with a second FX change.
      const stillRejected = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { fxRate: "0.5" },
        session,
      );
      expect(stillRejected.status).toBe(400);

      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.body.fxRate).toBe("0.95");
    });

    it("PATCH txnCurrency is rejected (400), same code as an FX-leg field, and the stored currency is untouched", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      // EUR — the tenant's own base currency (IMPLIED_BASE, no provider
      // lookup needed), so this scenario needs no `fxRateUserInput` pin to
      // succeed, unlike this file's other USD-denominated scenarios.
      const share = await createShareInstrument(session, "FR0000131856", "EUR");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-08",
          quantity: "3",
          unitPrice: "100",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { txnCurrency: "USD" },
        session,
      );
      expect(attempt.status).toBe(400);
      expect(attempt.body.code).toBe("TRANSACTION_FX_EDIT_FORBIDDEN");

      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.body.txnCurrency).toBe("EUR");
      // The frozen EUR/IMPLIED_BASE rate must stay exactly as resolved —
      // never silently reinterpreted as a USD rate.
      expect(reread.body.fxRate).toBe(created.body.fxRate);
      expect(reread.body.fxRateSource).toBe("IMPLIED_BASE");
    });
    it("PATCH tradeDate is accepted (D1) and keeps the frozen fxRate and its observation date", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131898", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-07-01",
          quantity: "3",
          unitPrice: "100",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.93",
        },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.fxRate).toBe("0.93");

      // D1: a date change keeps the stored rate verbatim and
      // calls no resolver. Previously this was a 400 (NEW-1).
      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { tradeDate: "2024-06-28" },
        session,
      );
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(200);

      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.status).toBe(200);
      expect(reread.body.tradeDate).toBe("2024-06-28");
      expect(reread.body.fxRate).toBe("0.93");
      expect(reread.body.fxRateObservedOn).toBe(created.body.fxRateObservedOn);
    });
    it("PATCHing an asset-settled BUY's settlement asset (BTC -> DOGE) is rejected (400), not silently applied against BTC's frozen rate", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const eth = await createCryptoInstrument(session, "T38ETH2");
      const btc = await createCryptoInstrument(session, "T38BTC2");
      const doge = await createCryptoInstrument(session, "T38DOGE2");

      // Acquire some BTC first (fiat-settled) so the settlement leg below has
      // something to dispose of.
      const buyBtc = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: btc,
          tradeDate: "2024-07-01",
          quantity: "1",
          unitPrice: "50000",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.9",
        },
        session,
      );
      expect(buyBtc.status).toBe(201);

      const settledBuy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: eth,
          tradeDate: "2024-07-02",
          quantity: "2",
          settlement: { instrumentId: btc, amount: "0.1", fxRateUserInput: "50000" },
        },
        session,
      );
      expect(settledBuy.status).toBe(201);
      expect(settledBuy.body.txnSettlementInstrumentId).toBe(btc);
      expect(settledBuy.body.fxRate).toBe("50000");

      // Before NEW-2: this PATCH returned 200, swapping the settlement asset
      // to DOGE while `fxRate` stayed BTC's 50000.
      const attempt = await patch(
        `/api/v1/transactions/${settledBuy.body.id}`,
        { txnSettlementInstrumentId: doge },
        session,
      );
      expect(attempt.status).toBe(400);
      expect(attempt.headers["content-type"]).toContain("application/problem+json");
      expect(attempt.body.code).toBe("TRANSACTION_FX_EDIT_FORBIDDEN");

      const reread = await get(`/api/v1/transactions/${settledBuy.body.id}`, session);
      expect(reread.status).toBe(200);
      expect(reread.body.txnSettlementInstrumentId).toBe(btc);
      expect(reread.body.fxRate).toBe("50000");
    });
  });

  describe("DELETE /transactions/:id (AC9)", () => {
    it("returns success and a subsequent GET returns 404", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-05-10",
          amount: "500",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const deleted = await del(`/api/v1/transactions/${created.body.id}`, session);
      expect(deleted.status).toBe(204);

      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.status).toBe(404);
      expect(reread.body.code).toBe("TRANSACTION_NOT_FOUND");
    });
  });

  describe("GET /transactions filters (portfolio/instrument/from/to, individually and in combination)", () => {
    it("filters correctly on each parameter alone and combined", async () => {
      const session = await alice();
      const portfolioX = await createPortfolio(session);
      const portfolioY = await createPortfolio(session);
      const instrumentX = await createShareInstrument(session, "FR0000442295", "EUR");
      const instrumentY = await createShareInstrument(session, "FR0000131708", "EUR");

      async function buy(
        portfolioId: string,
        instrumentId: string,
        tradeDate: string,
      ): Promise<string> {
        const response = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId,
            tradeDate,
            quantity: "1",
            unitPrice: "10",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
          },
          session,
        );
        expect(response.status).toBe(201);
        return response.body.id;
      }

      const t1 = await buy(portfolioX, instrumentX, "2024-01-05");
      const t2 = await buy(portfolioX, instrumentY, "2024-02-05");
      const t3 = await buy(portfolioY, instrumentX, "2024-03-05");

      const byPortfolio = await get(`/api/v1/transactions?portfolio=${portfolioX}`, session);
      expect(byPortfolio.status).toBe(200);
      expect(byPortfolio.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [t1, t2].sort(),
      );

      const byInstrument = await get(`/api/v1/transactions?instrument=${instrumentX}`, session);
      expect(byInstrument.body.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [t1, t3].sort(),
      );

      const byRange = await get("/api/v1/transactions?from=2024-02-01&to=2024-02-28", session);
      expect(byRange.body.items.map((i: { id: string }) => i.id)).toEqual([t2]);

      const combined = await get(
        `/api/v1/transactions?portfolio=${portfolioX}&instrument=${instrumentX}&from=2024-01-01&to=2024-01-31`,
        session,
      );
      expect(combined.body.items.map((i: { id: string }) => i.id)).toEqual([t1]);
    });
  });

  describe("GET /transactions?order=desc (FR-264)", () => {
    it("desc is newest-first over HTTP, the default stays ascending, limit bounds the newest slice, and garbage is a 400", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);

      // DEPOSITs, not BUYs — deliberately. `order` sorts the transaction
      // table by (trade_date, seq, id) regardless of kind, and when this file's
      // shared tenant ran at exactly the (since retired) 30/hour
      // `POST /instruments` rate cap, one more create here 429'd describe C's
      // first `createCryptoInstrument` — which is how this test originally
      // broke CI. A kind that needs no instrument keeps the ordering assertion
      // identical either way.
      async function deposit(tradeDate: string): Promise<string> {
        const response = await post(
          "/api/v1/transactions",
          {
            kind: "DEPOSIT",
            portfolioId,
            tradeDate,
            amount: "100",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
          },
          session,
        );
        expect(response.status).toBe(201);
        return response.body.id;
      }

      // Written out of date order, so insertion order cannot fake the pass.
      const feb = await deposit("2024-02-05");
      const jan = await deposit("2024-01-05");
      const mar = await deposit("2024-03-05");

      const descending = await get(
        `/api/v1/transactions?portfolio=${portfolioId}&order=desc`,
        session,
      );
      expect(descending.status).toBe(200);
      expect(descending.body.items.map((i: { id: string }) => i.id)).toEqual([mar, feb, jan]);

      // The default is untouched — the ledger keeps reading forward (asc), so
      // Activité's existing pagination contract is unchanged by this param.
      const defaultOrder = await get(`/api/v1/transactions?portfolio=${portfolioId}`, session);
      expect(defaultOrder.body.items.map((i: { id: string }) => i.id)).toEqual([jan, feb, mar]);

      // The read the Aperçu block actually makes: newest N in ONE request.
      const newestOnly = await get(
        `/api/v1/transactions?portfolio=${portfolioId}&order=desc&limit=1`,
        session,
      );
      expect(newestOnly.body.items.map((i: { id: string }) => i.id)).toEqual([mar]);

      // Validated enum, not a pass-through into SQL: anything else is a 400.
      const garbage = await get(
        `/api/v1/transactions?portfolio=${portfolioId}&order=sideways`,
        session,
      );
      expect(garbage.status).toBe(400);
      expect(garbage.body.errors.some((e: { field: string }) => e.field === "order")).toBe(true);
    });
  });

  describe("PATCH rejects a non-positive quantity/amount", () => {
    it("PATCH quantity:-1000000 is rejected (400), and the stored quantity is untouched", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131807");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-01",
          quantity: "10",
          unitPrice: "50",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { quantity: "-1000000" },
        session,
      );
      expect(attempt.status).toBe(400);
      expect(attempt.headers["content-type"]).toContain("application/problem+json");

      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.body.quantity).toBe("10");
    });
  });

  describe("write-path domain errors are mapped, never a raw 500", () => {
    it("(a) PATCHing in a fee amount on a kind that carries no fee leg (a DIVIDEND; a BUY can now gain one) is a 422 TRANSACTION_EDIT_NOT_EXPRESSIBLE with an actionable message — and the row is untouched", async () => {
      // F4 (security review) guards `feeCurrency` the
      // same way it guards every FX-leg field, and drops it from
      // `editTransactionBodySchema` entirely — so the specific "fee amount
      // + fee currency, but no fee_fx_rate" shape this finding's exploit
      // originally described is no longer reachable via this endpoint at
      // all (F4 closes it as a side effect). What remains reachable, and
      // still needs this mapping, is a `feeAmount` added on its own to a
      // transaction with no pre-existing fee leg.
      //
      // (Adding a fee to a BUY later became reachable, so this test now
      // exercises a DIVIDEND, the shape that still refuses.)
      //
      // **The error contract this asserts has moved twice, and this test is the
      // record of putting it back.** Originally `expandPostings` refused it
      // (no `fee_fx_rate` was ever resolved for the row) →
      // `422 TRANSACTION_EDIT_NOT_EXPRESSIBLE`, whose French message
      // (`web/src/lib/problem-messages.ts`) says *"supprimez puis recréez la
      // transaction"* — accurate and actionable. CA-2's
      // `transaction_fee_amount_currency_pairing` CHECK then began refusing
      // the `UPDATE` first, as a bare `23514` that F3's branch could only map
      // to `400 TRANSACTION_INVALID_SHAPE` — *"les informations saisies sont
      // incohérentes"*, which is **wrong**: the input is fine, the endpoint
      // simply cannot express adding a fee (`feeCurrency` could not be supplied
      // at all, and `fee_fx_rate` was refused by
      // `trg_transaction_fx_immutable` outside `correctFxRate` — both columns
      // are gone entirely since `0049`, so the sentence above is
      // why this test exists and not a description of today's schema). This
      // path is
      // UI-reachable — `web/src/components/TransactionEditForm.tsx` offers
      // `feeAmount` on BUY/SELL/DRIP/DIVIDEND/CURRENCY_EXCHANGE.
      //
      // CA-10's `#reconcileCashAccounts` now refuses it in the **service**,
      // before the `UPDATE` reaches the database, with
      // `TransactionCashLegNotAddableError` → the original 422. Both halves
      // are asserted below: the code, and that the row did not move.
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131815");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-02",
          amount: "20",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { feeAmount: "1.50" },
        session,
      );
      expect(attempt.status).toBe(422);
      expect(attempt.headers["content-type"]).toContain("application/problem+json");
      expect(attempt.body.code).toBe("TRANSACTION_EDIT_NOT_EXPRESSIBLE");

      // And the row is untouched — the whole edit was refused before the
      // `UPDATE`, which is the half of this finding a status-code assertion
      // alone would miss. Every column the refused edit could plausibly have
      // half-written is checked, not only `feeAmount`.
      const after = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(after.status).toBe(200);
      expect(after.body.feeAmount).toBeNull();
      // FR-260: `feeCurrency` used to stand beside it. The
      // components are the columns a half-written cost edit could now touch,
      // so they are what is checked in its place.
      expect(after.body.brokerFeeAmount).toBeNull();
      expect(after.body.taxAmount).toBeNull();
      expect(after.body.quantity).toBe(created.body.quantity);
      expect(after.body.grossAmount).toBe(created.body.grossAmount);
      expect(after.body.updatedAt).toBe(created.body.updatedAt);
    });

    it("(b) OverSellError: deleting a BUY a later SELL draws on is a 409, not a 500", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131823");

      const buy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-03",
          quantity: "4",
          unitPrice: "40",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(buy.status).toBe(201);

      const sell = await post(
        "/api/v1/transactions",
        {
          kind: "SELL",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-04",
          quantity: "3",
          unitPrice: "45",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(sell.status).toBe(201);

      const attempt = await del(`/api/v1/transactions/${buy.body.id}`, session);
      expect(attempt.status).toBe(409);
      expect(attempt.body.code).toBe("TRANSACTION_INSUFFICIENT_QUANTITY");

      // Rolled back entirely: the BUY still exists.
      const reread = await get(`/api/v1/transactions/${buy.body.id}`, session);
      expect(reread.status).toBe(200);
    });

    it("(c) a nonexistent instrumentId on a BUY/DIVIDEND is a clean 404, not a raw FK-violation 500", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const nonexistentInstrumentId = randomUUID();

      const buy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: nonexistentInstrumentId,
          tradeDate: "2024-06-05",
          quantity: "1",
          unitPrice: "10",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(buy.status).toBe(404);
      expect(buy.body.code).toBe("INSTRUMENT_NOT_FOUND");

      const dividend = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId,
          instrumentId: nonexistentInstrumentId,
          tradeDate: "2024-06-05",
          amount: "10",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(dividend.status).toBe(404);
      expect(dividend.body.code).toBe("INSTRUMENT_NOT_FOUND");
    });

    it("(c) PATCH instrumentId to a nonexistent id is a clean 404, not a raw FK-violation 500", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131831");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-06",
          quantity: "1",
          unitPrice: "10",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { instrumentId: randomUUID() },
        session,
      );
      expect(attempt.status).toBe(404);
      expect(attempt.body.code).toBe("INSTRUMENT_NOT_FOUND");
    });
  });

  describe("a per-kind shape/sign CHECK violation is distinguished from the FX-immutability trigger", () => {
    it("PATCH <a DEPOSIT> {instrumentId: <real uuid>} is a 400 shape error, not the 409 FX-immutable code", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131849");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-06-07",
          amount: "500",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { instrumentId: share },
        session,
      );
      expect(attempt.status).toBe(400);
      expect(attempt.body.code).toBe("TRANSACTION_INVALID_SHAPE");
      expect(attempt.body.code).not.toBe("TRANSACTION_FX_LEG_IMMUTABLE");
    });
  });

  describe("sourceDividendId cannot be changed via PATCH", () => {
    it("a PATCH naming sourceDividendId alongside a valid field applies the valid field and silently drops sourceDividendId", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131864");

      const dividend = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-10",
          amount: "20",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(dividend.status).toBe(201);

      const drip = await post(
        "/api/v1/transactions",
        {
          kind: "DRIP",
          portfolioId,
          instrumentId: share,
          sourceDividendId: dividend.body.id,
          tradeDate: "2024-06-10",
          quantity: "0.2",
          unitPrice: "100",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(drip.status).toBe(201);
      expect(drip.body.sourceDividendId).toBe(dividend.body.id);

      const otherDividend = await post(
        "/api/v1/transactions",
        {
          kind: "DIVIDEND",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-06-11",
          amount: "5",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(otherDividend.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${drip.body.id}`,
        { note: "re-pointing at a different dividend", sourceDividendId: otherDividend.body.id },
        session,
      );
      // Not rejected — sourceDividendId is simply not a field this schema
      // recognises any more, so it is dropped, not applied.
      expect(attempt.status).toBe(200);
      expect(attempt.body.note).toBe("re-pointing at a different dividend");
      expect(attempt.body.sourceDividendId).toBe(dividend.body.id);
    });
  });

  describe("the tenant table grant is column-scoped", () => {
    it("app_web can read tenant.base_currency (the factory path still works) but not tenant.created_at", async () => {
      // The ordinary path: every POST above already proves
      // `transaction-write-service.factory.ts`'s `tenant.base_currency` read
      // works end-to-end. This proves the narrower grant, not the table-wide
      // one it replaced: a raw SELECT of a column outside the grant is
      // rejected at the database, as `app_web`. (`status` was the probe column
      // until a migration dropped it; `created_at` is outside the grant the same way.)
      const rejected = await testApp.db
        .execute(sql`select created_at from "tenant" limit 1`)
        .catch((err: unknown) => err);
      expect(rejected).toBeInstanceOf(Error);
      const cause = (rejected as Error).cause;
      const pgMessage = cause instanceof Error ? cause.message : (rejected as Error).message;
      expect(pgMessage).toMatch(/permission denied/i);

      const allowed = await testApp.db.execute(sql`select base_currency from "tenant" limit 1`);
      expect(Array.isArray(allowed)).toBe(true);
    });
  });

  describe("grossAmount cannot be set directly on a quantity-priced transaction", () => {
    it("PATCH grossAmount alone on a BUY is rejected (400), not silently desyncing the cash leg from cost basis", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131872");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-07-03",
          quantity: "10",
          unitPrice: "50",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.grossAmount).toBe("500");

      // The original repro: before this fix, this returned 200 and moved the
      // cash leg to 0.000000000001 while cost basis (quantity x unitPrice)
      // stayed 500.
      const attempt = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { grossAmount: "0.000000000001" },
        session,
      );
      expect(attempt.status).toBe(400);
      expect(attempt.headers["content-type"]).toContain("application/problem+json");
      expect(attempt.body.code).toBe("TRANSACTION_GROSS_AMOUNT_NOT_EDITABLE");

      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.body.grossAmount).toBe("500");
    });

    it("editing quantity alone recomputes grossAmount server-side (quantity x unitPrice), never independently drifting", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const share = await createShareInstrument(session, "FR0000131880");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-07-04",
          quantity: "10",
          unitPrice: "50",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const edited = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { quantity: "20" },
        session,
      );
      expect(edited.status).toBe(200);
      expect(edited.body.quantity).toBe("20");
      // Byte-consistent with what a fresh POST of quantity: 20, unitPrice: 50
      // would produce.
      expect(edited.body.grossAmount).toBe("1000");
    });
  });

  describe("a settlement-priced BUY reconciles grossAmount/unitPrice the other way round from a fiat-priced trade", () => {
    async function seedSettledBuy(
      session: { sid: string; csrf: string },
      portfolioId: string,
    ): Promise<{ eth: string; btc: string; id: string }> {
      const eth = await createCryptoInstrument(session, `T38ETHA${randomUUID().slice(0, 6)}`);
      const btc = await createCryptoInstrument(session, `T38BTCA${randomUUID().slice(0, 6)}`);
      const buyBtc = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: btc,
          tradeDate: "2024-07-06",
          quantity: "1",
          unitPrice: "50000",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.9",
        },
        session,
      );
      expect(buyBtc.status).toBe(201);

      const settledBuy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: eth,
          tradeDate: "2024-07-07",
          quantity: "2",
          settlement: { instrumentId: btc, amount: "0.1", fxRateUserInput: "60000" },
        },
        session,
      );
      expect(settledBuy.status).toBe(201);
      expect(settledBuy.body.grossAmount).toBe("0.1");
      expect(settledBuy.body.unitPrice).toBe("0.05");
      return { eth, btc, id: settledBuy.body.id };
    }

    it("editing quantity re-derives unitPrice and leaves grossAmount (the real BTC amount disposed) untouched — before this fix, gross was silently rewritten", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const { id } = await seedSettledBuy(session, portfolioId);

      const edited = await patch(`/api/v1/transactions/${id}`, { quantity: "2.5" }, session);
      expect(edited.status).toBe(200);
      expect(edited.body.grossAmount).toBe("0.1");
      expect(edited.body.unitPrice).toBe("0.04");
    });

    it("editing grossAmount (the legitimate correction for this row shape) is accepted (200) and re-derives unitPrice — before this fix, this was a 400", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const { id } = await seedSettledBuy(session, portfolioId);

      const edited = await patch(`/api/v1/transactions/${id}`, { grossAmount: "0.12" }, session);
      expect(edited.status).toBe(200);
      expect(edited.body.grossAmount).toBe("0.12");
      expect(edited.body.unitPrice).toBe("0.06");
    });

    it("editing unitPrice directly is rejected (400) — it is derived, never independently settable, on a settlement-priced row", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const { id } = await seedSettledBuy(session, portfolioId);

      const attempt = await patch(`/api/v1/transactions/${id}`, { unitPrice: "999" }, session);
      expect(attempt.status).toBe(400);
      expect(attempt.headers["content-type"]).toContain("application/problem+json");
      expect(attempt.body.code).toBe("TRANSACTION_UNIT_PRICE_NOT_EDITABLE");

      const reread = await get(`/api/v1/transactions/${id}`, session);
      expect(reread.body.unitPrice).toBe("0.05");
      expect(reread.body.grossAmount).toBe("0.1");
    });
  });

  describe("editing instrumentId to equal the row's own settlement instrument is rejected", () => {
    it("PATCH {instrumentId: <settlement instrument>} on an asset-settled BUY is rejected (400), not silently accepted with net free units at zero cost basis", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const eth = await createCryptoInstrument(session, "T38ETHC");
      const btc = await createCryptoInstrument(session, "T38BTCC");

      const buyBtc = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: btc,
          tradeDate: "2024-07-08",
          quantity: "1",
          unitPrice: "50000",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: "0.9",
        },
        session,
      );
      expect(buyBtc.status).toBe(201);

      const settledBuy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: eth,
          tradeDate: "2024-07-09",
          quantity: "1",
          settlement: { instrumentId: btc, amount: "0.01", fxRateUserInput: "60000" },
        },
        session,
      );
      expect(settledBuy.status).toBe(201);

      const attempt = await patch(
        `/api/v1/transactions/${settledBuy.body.id}`,
        { instrumentId: btc },
        session,
      );
      expect(attempt.status).toBe(400);
      expect(attempt.headers["content-type"]).toContain("application/problem+json");
      expect(attempt.body.code).toBe("TRANSACTION_SELF_SETTLED");

      const reread = await get(`/api/v1/transactions/${settledBuy.body.id}`, session);
      expect(reread.body.instrumentId).toBe(eth);
    });
  });

  describe("a service-layer domain error maps to 400, never a raw 500", () => {
    /**
     * The other eight assertion sites. Until the fix they
     * threw a bare `TypeError`, which `mapTransactionWriteError` has no branch
     * for and cannot get one, so a rejection the service had diagnosed
     * precisely was answered `500`.
     *
     * The spy is used for a reason worth stating: **every one of the nine
     * is shadowed by the DTO over HTTP.** `createTransactionBodySchema`
     * rejects a same-currency CURRENCY_EXCHANGE at `:523-524`, a malformed
     * currency at `currencyCodeSchema`, a bad `tradeDate` at its own
     * validator. That is defence in depth working as designed, and it is also
     * why the mapper branch cannot be reached through a well-formed request —
     * the callers that reach it are the importer (covered by
     * `apply.failure-message.test.ts`) and any future internal caller. So the
     * spy is not a shortcut around a reachable path; it is the only way to
     * assert the boundary this mapping exists for.
     */
    it("PATCH /transactions/:id surfaces TRANSACTION_ARGUMENT_INVALID as 400 for a rejected argument, where it used to be a 500", async () => {
      const session = await alice();
      const portfolioId = await createPortfolio(session);

      // A DEPOSIT, deliberately: this file sits at exactly the 30/hour
      // instrument-create cap, so a new case must not POST /instruments.
      const created = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-07-06",
          amount: "250",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      const spy = vi
        .spyOn(TransactionWriteService.prototype, "editTransaction")
        .mockRejectedValueOnce(
          new TransactionArgumentError("currency must be a 3-letter ISO code, got: usd"),
        );
      try {
        const attempt = await patch(
          `/api/v1/transactions/${created.body.id}`,
          { note: "trigger the spy" },
          session,
        );
        expect(attempt.status).toBe(400);
        expect(attempt.headers["content-type"]).toContain("application/problem+json");
        expect(attempt.body.code).toBe("TRANSACTION_ARGUMENT_INVALID");
        // The message is this codebase's own and names the argument, which is
        // the whole reason it may be forwarded as `detail` at all.
        expect(attempt.body.detail).toContain("must be a 3-letter ISO code");
      } finally {
        spy.mockRestore();
      }
    });

    it("PATCH /transactions/:id surfaces TRANSACTION_AMOUNT_NOT_POSITIVE as 400 — the specialisation keeps its own code, not its base class's, so the branch order is pinned", async () => {
      // `TransactionAmountNotPositiveError extends TransactionArgumentError`.
      // If the generic branch were ever moved above the
      // specific one, every non-positive amount would silently start
      // answering `TRANSACTION_ARGUMENT_INVALID` and lose its `field`. That
      // reordering is invisible by reading either branch alone.
      const session = await alice();
      const portfolioId = await createPortfolio(session);
      const created = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2024-07-07",
          amount: "250",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(created.status).toBe(201);

      expect(new TransactionAmountNotPositiveError("feeAmount", "-1")).toBeInstanceOf(
        TransactionArgumentError,
      );

      const spy = vi
        .spyOn(TransactionWriteService.prototype, "editTransaction")
        .mockRejectedValueOnce(new TransactionAmountNotPositiveError("feeAmount", "-1"));
      try {
        const attempt = await patch(
          `/api/v1/transactions/${created.body.id}`,
          { note: "trigger the spy" },
          session,
        );
        expect(attempt.status).toBe(400);
        expect(attempt.headers["content-type"]).toContain("application/problem+json");
        expect(attempt.body.code).toBe("TRANSACTION_AMOUNT_NOT_POSITIVE");
      } finally {
        spy.mockRestore();
      }
    });
  });
  /**
   * **FT-18 (Batch C) —
   * phase 1 over HTTP: AC-257, AC-258 per kind, AC-269, AC-278.**
   *
   * The capability, stated once: a transaction denominated in one currency can
   * now be settled from a cash account denominated in another. Everything
   * below is that sentence at the real `POST /transactions` boundary — the
   * layer the service-level suites (`transaction-write-service.cash-leg-create`,
   * `transaction-edit-cash-leg`) cannot reach, because the wire contract
   * (`createTransactionBodySchema`, the controller's forwarding, the response
   * DTO) sits between them and it is what FT-16/FT-17 changed.
   *
   * **Rates are pinned with `fxRateUserInput` throughout.** `api`'s
   * `NotConfiguredFxRateProvider` resolves nothing, so a pinned rate is how
   * every existing cross-currency case in this file already works — and it
   * makes the settled figures hand-checkable: `1 500,00 USD x 0,92 =
   * 1 380,00 EUR` is AC-264's own worked example.
   */
  describe("FT-18 — a transaction settled from an account in another currency (AC-257, AC-258, AC-269, AC-278)", () => {
    /** AC-264's rate. Pinned, so `cash_amount` is hand-computable and no provider is involved. */
    const PINNED_RATE = "0.92";

    /**
     * **A tenant of its own.** Originally because the (since retired)
     * 30/hour per-tenant `POST /instruments` rate cap left Alice only 4
     * creates by this point; running this block as Alice would have 429'd
     * partway through and reported it as a failed acceptance criterion —
     * exactly the kind of infrastructural noise that gets an AC quietly
     * deleted. Kept: a second tenant still gives it its own write
     * concurrency slice, and isolates it from every future addition above.
     */
    const tenantB = "00000000-0000-7000-8000-0000003800b0";
    const bobId = "00000000-0000-7000-8000-0000003800b1";
    const bobEmail = "bob-transactions-ft18@example.com";
    const bobPassword = "correct horse battery staple settlement";

    beforeAll(async () => {
      await testApp.ownerDb.insert(tenant).values([{ id: tenantB }]);
      await createUser(testApp.db, {
        id: bobId,
        tenantId: tenantB,
        email: bobEmail,
        password: bobPassword,
      });
    }, 60_000);

    async function bob(): Promise<{ sid: string; csrf: string }> {
      return loginAs(server(), bobEmail, bobPassword);
    }

    /**
     * A portfolio holding **exactly** the accounts named — not the six
     * `CASH_FIXTURE_CURRENCIES` this suite's own `createPortfolio` seeds.
     * AC-257's premise is "exactly one cash account, in EUR", and a portfolio
     * that also holds a USD account would satisfy the write for the wrong
     * reason.
     */
    async function portfolioWithAccounts(
      session: { sid: string; csrf: string },
      currencies: readonly string[],
    ): Promise<string> {
      const response = await post("/api/v1/portfolios", { name: `FT-18 ${randomUUID()}` }, session);
      expect(response.status).toBe(201);
      await seedCashAccountsForPortfolio(testApp.ownerDb, response.body.id, currencies);
      return response.body.id;
    }

    /**
     * The portfolio's **only** cash account, read out of band — and the
     * assertion that it is the only one is part of AC-257's premise, not
     * setup noise.
     *
     * A freshly created portfolio already holds exactly one EUR account
     * (`portfolio-service.ts`'s `INITIAL_CASH_ACCOUNT`), which is precisely
     * the situation the user reported: one account, in the base currency,
     * and a trade in another. So that case seeds **nothing** — seeding would
     * add a second EUR account and quietly change the premise.
     */
    async function theOnlyCashAccountOf(portfolioId: string): Promise<{
      id: string;
      currency: string;
    }> {
      const rows = await testApp.ownerDb
        .select({ id: cashAccount.id, currency: cashAccount.currency })
        .from(cashAccount)
        .where(eq(cashAccount.portfolioId, portfolioId));
      expect(rows, "AC-257's premise is a portfolio with exactly one cash account").toHaveLength(1);
      return { id: rows[0]!.id, currency: rows[0]!.currency.trim() };
    }

    /** The currencies of every cash account this portfolio holds, read out of band. */
    async function accountCurrenciesOf(portfolioId: string): Promise<string[]> {
      const rows = await testApp.ownerDb
        .select({ currency: cashAccount.currency })
        .from(cashAccount)
        .where(eq(cashAccount.portfolioId, portfolioId));
      return rows.map((row) => row.currency.trim()).sort();
    }

    describe("AC-257 — a portfolio whose only cash account is EUR settles a USD trade from it", () => {
      it("a portfolio with EXACTLY ONE cash account, in EUR, accepts a BUY of 10 AAPL at 150,00 USD settled from it", async () => {
        const session = await bob();
        // Nothing seeded: the portfolio's own initial EUR account is the one
        // and only account, exactly as a real new portfolio has it.
        const portfolioId = await portfolioWithAccounts(session, []);
        const aapl = await createShareInstrument(session, "US0378331005", "USD");

        // The premise, asserted rather than assumed — and asserted *before*
        // the write, so "no USD account exists" is a fact about the portfolio
        // the write ran against.
        const account = await theOnlyCashAccountOf(portfolioId);
        expect(account.currency).toBe("EUR");
        expect(await accountCurrenciesOf(portfolioId)).toEqual(["EUR"]);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: aapl,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: account.id,
            // D4's request shape (L11): the account's own denomination, and
            // **no** settled amount — the server derives it from the rate.
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.txnCurrency).toBe("USD");
        expect(created.body.grossAmount).toBe("1500");
        expect(created.body.cashAccountId).toBe(account.id);
        // The two new response fields, against hand-written literals:
        // 1 500,00 x 0,92 = 1 380,00 (AC-264).
        expect(created.body.cashCurrency).toBe("EUR");
        expect(created.body.cashAmount).toBe("1380");

        // The row persists — read back through the real GET, not out of the
        // POST's own response body.
        const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
        expect(reread.status).toBe(200);
        expect(reread.body.cashCurrency).toBe("EUR");
        expect(reread.body.cashAmount).toBe("1380");

        // …and no USD account came into existence to make it work: still
        // exactly one account, still EUR.
        expect(await accountCurrenciesOf(portfolioId)).toEqual(["EUR"]);
        expect((await theOnlyCashAccountOf(portfolioId)).id).toBe(account.id);
      });
    });

    /**
     * **AC-258 — six kinds, each asserted individually.** Not a loop over a
     * list: a loop whose list went empty would report six passes' worth of
     * green having run nothing, which is this project's most-recorded failure
     * mode. Each kind is settled from a **EUR** account against a **USD**
     * transaction (D4), in a portfolio holding both, so each `it` proves the
     * capability for its own kind and nothing else.
     */
    /**
     * AC-277's "at the API boundary" layer, actually at the
     * API boundary.
     *
     * AC-277 requires the claim *"asserted at the API boundary **and**,
     * independently, by reading the row back … so neither layer is trusted
     * alone"*. Both layers were inside `ledger`:
     * `transaction-edit-service.integration.test.ts:850`'s layer 1 is
     * `service.editTransaction(...)`'s return value (whose comment calls it
     * "the API boundary") and layer 2 is the DB read-back. `grep -n "AC-277"
     * api/` returned nothing — so two layers were asserted, both on the same
     * side of the HTTP boundary, which is the thing AC-277's "neither layer
     * alone" wording exists to prevent.
     *
     * The behaviour was never in doubt: the tester wrote and ran this
     * exact sequence by hand and it passed. It was a **test-placement** gap,
     * and the scratch test was reverted rather than committed. This is it,
     * committed.
     *
     * **The instrument is created out of band, on purpose.** This block
     * already spends 23 `POST /instruments` of bob's 30-per-hour budget, and
     * that headroom is a known open concern, so a case that needs an
     * instrument but is not *about* instrument creation should not spend an
     * API create.
     */
    describe("AC-277 — a D4 quantity edit re-derives cash_amount, over HTTP", () => {
      it("PATCH {quantity} moves gross_amount and cash_amount together, at the pinned rate, read back through GET", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, []);
        const account = await theOnlyCashAccountOf(portfolioId);
        expect(account.currency).toBe("EUR");

        // A USD-listed instrument, inserted directly — see this describe's
        // doc comment for why this one does not go through the API.
        const instrumentId = randomUUID();
        await testApp.ownerDb.execute(
          sql`INSERT INTO instrument (id, kind, display_name, listing_currency, symbol, primary_identifier, quote_policy)
              VALUES (${instrumentId}, 'SHARE', 'AC-277 AAPL', 'USD', ${`AC277${instrumentId.slice(0, 8)}`}, 'SYMBOL', 'AUTO')`,
        );

        // D4: a USD trade settled from the EUR account at the pinned rate.
        const created = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: account.id,
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );
        expect(created.status).toBe(201);
        expect(created.body.grossAmount).toBe("1500");
        expect(created.body.cashCurrency).toBe("EUR");
        // 1 500,00 x 0,92
        expect(created.body.cashAmount).toBe("1380");

        // The edit AC-277 is about: only `quantity` changes.
        const edited = await patch(
          `/api/v1/transactions/${created.body.id}`,
          { quantity: "8" },
          session,
        );
        expect(edited.status).toBe(200);
        // 8 x 150,00 = 1 200,00 …
        expect(edited.body.grossAmount).toBe("1200");
        // … and 1 200,00 x 0,92 = 1 104,00. The settled figure is re-derived
        // rather than left at 1 380: that is the whole claim.
        expect(edited.body.cashAmount).toBe("1104");
        expect(edited.body.cashCurrency).toBe("EUR");

        // Layer 2, and now genuinely independent of layer 1: a fresh HTTP read
        // rather than the mutating call's own response body.
        const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
        expect(reread.status).toBe(200);
        expect(reread.body.grossAmount).toBe("1200");
        expect(reread.body.cashAmount).toBe("1104");

        // The invariant behind the two literals, stated as a ratio so it
        // cannot be satisfied by two numbers that merely happen to match the
        // expectations above: cash / gross is the pinned rate, exactly.
        expect(
          new Decimal(String(reread.body.cashAmount))
            .dividedBy(new Decimal(String(reread.body.grossAmount)))
            .toString(),
        ).toBe(PINNED_RATE);
        expect(reread.body.fxRate).toBe(PINNED_RATE);
      });
    });

    describe("AC-258 — the write succeeds for each kind against a differently-denominated account", () => {
      it("BUY", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US58933Y1055", "USD");

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        expect(created.body.cashAmount).toBe("1380");
      });

      it("SELL", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US4592001014", "USD");

        const bought = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-10",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "USD"),
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );
        expect(bought.status).toBe(201);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "SELL",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "4",
            unitPrice: "160.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        // 4 x 160,00 = 640,00 USD; 640,00 x 0,92 = 588,80 EUR.
        expect(created.body.cashAmount).toBe("588.8");
      });

      it("DIVIDEND", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US7427181091", "USD");

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "DIVIDEND",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            amount: "50.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        // 50,00 x 0,92 = 46,00.
        expect(created.body.cashAmount).toBe("46");
      });

      it("DRIP", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US2546871060", "USD");

        const dividend = await post(
          "/api/v1/transactions",
          {
            kind: "DIVIDEND",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-14",
            amount: "50.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "USD"),
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );
        expect(dividend.status).toBe(201);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "DRIP",
            portfolioId,
            instrumentId: share,
            sourceDividendId: dividend.body.id,
            tradeDate: "2026-01-15",
            quantity: "0.5",
            unitPrice: "100.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        // 0,5 x 100,00 = 50,00 USD; 50,00 x 0,92 = 46,00 EUR.
        expect(created.body.cashAmount).toBe("46");
      });

      it("DEPOSIT", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "DEPOSIT",
            portfolioId,
            tradeDate: "2026-01-15",
            amount: "1000.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        expect(created.body.cashAmount).toBe("920");
      });

      it("WITHDRAWAL", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "WITHDRAWAL",
            portfolioId,
            tradeDate: "2026-01-15",
            amount: "1000.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        expect(created.body.cashAmount).toBe("920");
      });

      /**
       * AC-258's paired half, FR-235: a CURRENCY_EXCHANGE's settlement figures
       * are **pinned to the degenerate pair by the database**. Asserted by
       * moving a real, committed row out of that shape with an out-of-band
       * `UPDATE` — bypassing the write service and the schema entirely, so the
       * refusal is proven to be the constraint and not a guard in front of it
       * — and by name, once per constraint.
       */
      it("a CURRENCY_EXCHANGE whose settlement figures contradict its own is refused BY THE DATABASE, by constraint name", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "CURRENCY_EXCHANGE",
            portfolioId,
            tradeDate: "2026-01-15",
            amount: "1000.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            targetCurrency: "USD",
            targetCashAccountId: cash(portfolioId, "USD"),
            exchangeRate: "1.08",
          },
          session,
        );
        expect(created.status).toBe(201);

        // (a) a settlement currency that is not the transaction's own.
        const currencyMoved = await testApp.ownerClient
          .unsafe(`update "transaction" set cash_currency = 'USD' where id = $1`, [created.body.id])
          .then(() => "committed")
          .catch((err: unknown) => err);
        expect(currencyMoved).not.toBe("committed");
        expect((currencyMoved as { constraint_name?: string }).constraint_name).toBe(
          "transaction_currency_exchange_cash_leg_pinned",
        );

        // (b) …and a settled amount that is not the gross.
        const amountMoved = await testApp.ownerClient
          .unsafe(`update "transaction" set cash_amount = 999 where id = $1`, [created.body.id])
          .then(() => "committed")
          .catch((err: unknown) => err);
        expect(amountMoved).not.toBe("committed");
        expect((amountMoved as { constraint_name?: string }).constraint_name).toBe(
          "transaction_cash_degenerate_equals_gross",
        );

        // The positive companion: the row as written **is** the degenerate
        // pair, so the two refusals above are refusals of a change, not of
        // the row.
        const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
        expect(reread.body.cashCurrency).toBe("EUR");
        expect(reread.body.cashAmount).toBe("1000");
      });

      it("a CURRENCY_EXCHANGE body carrying the degenerate pair is accepted", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "CURRENCY_EXCHANGE",
            portfolioId,
            tradeDate: "2026-01-15",
            amount: "1000.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            targetCurrency: "USD",
            targetCashAccountId: cash(portfolioId, "USD"),
            exchangeRate: "1.08",
            cashCurrency: "EUR",
            cashAmount: "1000.00",
          },
          session,
        );

        expect(created.status).toBe(201);
        expect(created.body.cashCurrency).toBe("EUR");
        expect(created.body.cashAmount).toBe("1000");
      });
    });

    /**
     * **AC-269 at the HTTP boundary.** The claim is that phase 1 resolves no
     * *additional* FX rate: three legs before, three legs after. Counted on a
     * spy over the real `FxRateResolver.prototype.resolve` and compared **to
     * each other**, never against a literal — a literal would encode today's
     * leg count and would have to be edited by whoever added a fourth
     * resolution, which is exactly the change this assertion exists to catch.
     */
    it("AC-269 — one write resolves the same number of FX rates in D2, D4 and D5", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD", "CHF"]);
      const share = await createShareInstrument(session, "US0231351067", "USD");

      async function resolveCallsFor(body: Record<string, unknown>): Promise<number> {
        const spy = vi.spyOn(FxRateResolver.prototype, "resolve");
        try {
          const created = await post("/api/v1/transactions", body, session);
          expect(created.status, JSON.stringify(body)).toBe(201);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      }

      const common = {
        kind: "BUY",
        portfolioId,
        instrumentId: share,
        quantity: "10",
        unitPrice: "150.00",
        currency: "USD",
        fxRateUserInput: PINNED_RATE,
      };

      // D2 — `A = T ≠ B`: a USD trade off a USD account (today's world).
      const d2 = await resolveCallsFor({
        ...common,
        tradeDate: "2026-01-12",
        cashAccountId: cash(portfolioId, "USD"),
      });
      // D4 — `A = B ≠ T`: the same trade off the EUR account.
      const d4 = await resolveCallsFor({
        ...common,
        tradeDate: "2026-01-13",
        cashAccountId: cash(portfolioId, "EUR"),
        cashCurrency: "EUR",
      });
      // D5 — `A ≠ T ≠ B`: the same trade off a CHF account, whose settled
      // amount is an independent broker figure and must be supplied.
      const d5 = await resolveCallsFor({
        ...common,
        tradeDate: "2026-01-14",
        cashAccountId: cash(portfolioId, "CHF"),
        cashCurrency: "CHF",
        cashAmount: "1320.00",
      });

      expect(d4).toBe(d2);
      expect(d5).toBe(d2);
      // …and the spy actually observed something: three equal zeros would
      // satisfy the two assertions above while proving nothing.
      expect(d2).toBeGreaterThan(0);
    });

    /**
     * **AC-278 over HTTP.** The body is the first `post("/api/v1/transactions",
     * …)` of this file's own *"records every kind, deriving the money leg and
     * rejecting nothing that should succeed"* — byte-for-byte, only the three
     * runtime identifiers substituted. It must still succeed, and must produce
     * the **degenerate** row: settlement currency = `txn_currency`, settled
     * amount = the gross. That is what makes the importer, every other e2e
     * fixture and `load/`'s HTTP paths byte-compatible without a single edit.
     */
    it("AC-278 — the captured pre-cycle body still succeeds and produces the degenerate row", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR"]);
      // A distinct ISIN from the captured test's own `FR0000131609`:
      // `instrument` is a tenant-shared catalogue, so re-creating that ISIN
      // would be a 409. The **body** is what AC-278 is about, and every
      // literal in it below is that test's, byte for byte.
      const share = await createShareInstrument(session, "FR0000442303");

      const buy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2024-03-01",
          quantity: "10",
          unitPrice: "60",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );

      expect(buy.status).toBe(201);
      expect(buy.body.grossAmount).toBe("600");
      expect(buy.body.fxRateSource).toBe("IMPLIED_BASE");
      // The degenerate case, both fields — equal to the transaction's own,
      // never `null` (a `null` pair means the row moved no cash at all).
      expect(buy.body.cashCurrency).toBe(buy.body.txnCurrency);
      expect(buy.body.cashAmount).toBe(buy.body.grossAmount);
      expect(buy.body.cashCurrency).toBe("EUR");
      expect(buy.body.cashAmount).toBe("600");

      // FT-9's snapshot discipline, at the fields this boundary can see: the
      // stored posting row for this transaction, compared against the
      // pre-cycle expectation for a D1 BUY of 600,00 EUR at rate 1 — one CASH
      // posting for the money leg, in the transaction's own currency, at its
      // own rate. (The full byte-identity snapshot over every emitted posting
      // is `ledger/src/posting-expander.degenerate-byte-identity.test.ts`.)
      const postings = await testApp.ownerClient.unsafe<
        { currency: string; amount_native: string; amount_base: string; fx_rate_applied: string }[]
      >(
        `select currency, amount_native, amount_base, fx_rate_applied
           from transaction_posting where transaction_id = $1 and leg = 'CASH' order by seq`,
        [buy.body.id],
      );
      expect(postings).toHaveLength(1);
      expect(postings[0]!.currency.trim()).toBe("EUR");
      expect(new Decimal(postings[0]!.amount_native).toString()).toBe("-600");
      expect(new Decimal(postings[0]!.amount_base).toString()).toBe("-600");
      expect(new Decimal(postings[0]!.fx_rate_applied).toString()).toBe("1");
    });

    /**
     * The wire contract's error surface, one test per code. FT-17 asserts the
     * status/code mapping as a unit (`write-error.mapper.test.ts`); this
     * asserts that each one is actually **reachable over HTTP** with that
     * status — a mapping nothing can reach is a mapping that never runs.
     */
    describe("the settlement rejections, over HTTP, one code each", () => {
      it("400 CASH_AMOUNT_NOT_ACCEPTED — a settled amount supplied for D4, which derives it (L11)", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US38141G1040", "USD");

        const rejected = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "EUR",
            cashAmount: "1380.00",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(rejected.status).toBe(400);
        expect(rejected.headers["content-type"]).toContain("application/problem+json");
        expect(rejected.body.code).toBe("CASH_AMOUNT_NOT_ACCEPTED");
        expect(rejected.body.detail).toContain("DERIVED_IN_BASE_CURRENCY");
      });

      it("400 CASH_AMOUNT_REQUIRED — a third currency (D3/D5), whose settled amount nothing on the row can derive", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD", "CHF"]);
        const share = await createShareInstrument(session, "US6541061031", "USD");

        const rejected = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "CHF"),
            cashCurrency: "CHF",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(rejected.status).toBe(400);
        expect(rejected.body.code).toBe("CASH_AMOUNT_REQUIRED");

        // The positive companion: the identical body carrying the figure is
        // accepted, so the rejection is the missing amount and nothing else.
        const accepted = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "CHF"),
            cashCurrency: "CHF",
            cashAmount: "1320.00",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );
        expect(accepted.status).toBe(201);
        expect(accepted.body.cashCurrency).toBe("CHF");
        expect(accepted.body.cashAmount).toBe("1320");
      });

      /**
       * **The implied-rate overflow, over HTTP.** The settlement pair is well formed, both
       * figures are positive and the database would take the row — what cannot
       * be done is derive a `fx_rate_applied` that fits `numeric(28,12)`.
       * Unguarded this reached `regeneratePostings` and raised a bare `22003`
       * with no mapper entry: a 500 for a user input problem.
       */
      it("422 IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE — a settled amount so small the implied rate cannot be stored", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD", "CHF"]);
        // A fresh ISIN: every test in this file owns one, because
        // `createShareInstrument` asserts a 201 and a second create of the same
        // ISIN for the same tenant is a 409 — which is how this test failed
        // once, green in isolation and red in the file.
        const share = await createShareInstrument(session, "US88160R1014", "USD");

        // 100 at 150,00 USD = 15 000,00 USD gross; at the pinned rate that is
        // 13 200,00 of base value, and settling it from 1e-12 CHF — the
        // smallest figure `numeric(38,12)` can hold — implies 1,32e16, one
        // digit past what `fx_rate_applied` stores. The magnitudes have to be
        // extreme to reach it, which is why it survived to production and why
        // the bound is a guard rather than a validation the user meets daily.
        const body = {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "100",
          unitPrice: "150.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "CHF"),
          cashCurrency: "CHF",
          fxRateUserInput: PINNED_RATE,
        } as const;

        const rejected = await post(
          "/api/v1/transactions",
          { ...body, cashAmount: "0.000000000001" },
          session,
        );

        // 422, not 400: the three CASH_AMOUNT_* refusals say "this endpoint
        // derives that figure"; this one says the figure it implies does not
        // fit.
        expect(rejected.status).toBe(422);
        expect(rejected.headers["content-type"]).toContain("application/problem+json");
        expect(rejected.body.code).toBe("IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE");
        expect(rejected.body.detail).toContain("cashAmount");
        // The response body carries the actionable bound and
        // learns the caller nothing about the schema's internal shape — the
        // policy `problem-json.filter.ts` states for the `23514` path.
        expect(rejected.body.detail).not.toMatch(/numeric\(/);
        expect(rejected.body.detail).not.toMatch(/transaction_posting\./);
        // Never the SQLSTATE, and never the generic shape code — the two
        // outcomes this branch exists to replace.
        expect(rejected.body.detail).not.toMatch(/22003/);
        expect(rejected.body.code).not.toBe("TRANSACTION_INVALID_SHAPE");

        // The positive companion on the identical body: a settled amount inside
        // the bound is accepted, so the refusal is the magnitude and nothing
        // else about this request.
        const accepted = await post(
          "/api/v1/transactions",
          { ...body, cashAmount: "13200.00" },
          session,
        );
        expect(accepted.status).toBe(201);

        // …and the edit path refuses it too, on a row that is already valid:
        // the merged gross is what the bound is measured against.
        const edited = await patch(
          `/api/v1/transactions/${accepted.body.id as string}`,
          { cashAmount: "0.000000000001" },
          session,
        );
        expect(edited.status).toBe(422);
        expect(edited.body.code).toBe("IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE");
      });

      /**
       * **FT-39 / AC-232, AC-233, AC-235 — the itemisation over HTTP.**
       *
       * The figures are AC-232's: broker 9,90 + FX 2,50 + tax
       * 3,60, summing by hand to **16,00** — worked here, not by the
       * implementation's own formula.
       */
      it("AC-232: three components persist individually and total exactly 16,00, readable back one by one", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US4581401001", "EUR");

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "100.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            fee: {
              components: {
                brokerFee: "9.90",
                fxFee: "2.50",
                tax: "3.60",
              },
            },
          },
          session,
        );

        expect(created.status).toBe(201);
        // Each one independently, not as an object comparison — a mapper that
        // wrote the same figure into every column would pass that.
        expect(created.body.brokerFeeAmount).toBe("9.9");
        expect(created.body.fxFeeAmount).toBe("2.5");
        expect(created.body.taxAmount).toBe("3.6");
        expect(created.body.otherCostAmount).toBeNull();
        // The total the client never sent — derived from the components, so
        // the arithmetic is the server's and the database's, never the
        // caller's.
        expect(created.body.feeAmount).toBe("16");

        // …and read back on its own GET, since a create response can echo what
        // it was handed rather than what it stored.
        const fetched = await get(`/api/v1/transactions/${created.body.id as string}`, session);
        expect(fetched.status).toBe(200);
        expect(fetched.body.taxAmount).toBe("3.6");
        expect(fetched.body.feeAmount).toBe("16");
      });

      it("AC-233: a zero component and a negative one are each rejected; omitting it succeeds with the column null", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR"]);
        const share = await createShareInstrument(session, "US7134481081", "EUR");
        const body = (components: Record<string, string>) => ({
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "10",
          unitPrice: "100.00",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
          fee: { components },
        });

        // Each separately — one test covering both could pass on a guard that
        // caught only one sign.
        const zero = await post("/api/v1/transactions", body({ brokerFee: "0" }), session);
        expect(zero.status).toBe(400);
        expect(zero.body.detail ?? "").toContain("brokerFee");

        const negative = await post("/api/v1/transactions", body({ brokerFee: "-1.00" }), session);
        expect(negative.status).toBe(400);
        expect(negative.body.detail ?? "").toContain("brokerFee");

        // FR-213's other direction: omitted is the only spelling of "not
        // charged", and it stores NULL rather than zero.
        const omitted = await post("/api/v1/transactions", body({ tax: "3.60" }), session);
        expect(omitted.status).toBe(201);
        expect(omitted.body.brokerFeeAmount).toBeNull();
        expect(omitted.body.taxAmount).toBe("3.6");
        expect(omitted.body.feeAmount).toBe("3.6");
      });

      it("a total contradicting its components is refused per-field by the shared schema, before the service sees it", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR"]);
        const share = await createShareInstrument(session, "US00206R1023", "EUR");

        const rejected = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "100.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            fee: {
              amount: "18.00",
              components: { brokerFee: "9.90", tax: "3.60" },
            },
          },
          session,
        );
        expect(rejected.status).toBe(400);
        // The shared object catches it first, so the caller gets a per-field
        // issue rather than the service's own named error — both exist, and
        // this asserts which one the wire actually produces.
        expect(rejected.body.detail ?? "").toContain("fee.amount");
      });

      it("AC-234: a component outside the closed vocabulary is rejected per-field, and all four valid names are accepted in the same run", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR"]);
        const share = await createShareInstrument(session, "US30303M1027", "EUR");
        const feeWith = (components: Record<string, string>) => ({ components });

        const invented = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "100.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            fee: feeWith({ stampDuty: "1.00" }),
          },
          session,
        );
        // Rejected, never silently dropped — `costComponentsSchema` is a
        // `strictObject`, which is the whole mechanism (A9: the vocabulary is
        // the column set plus this schema, not a Postgres enum).
        expect(invented.status).toBe(400);

        // Paired with all four valid names in the same run, so the rejection is
        // proven to be vocabulary enforcement and not a broken parser.
        const accepted = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-16",
            quantity: "10",
            unitPrice: "100.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            fee: feeWith({
              brokerFee: "1.00",
              fxFee: "3.00",
              tax: "4.00",
              other: "5.00",
            }),
          },
          session,
        );
        expect(accepted.status).toBe(201);
        expect(accepted.body.feeAmount).toBe("13");
        expect(accepted.body.otherCostAmount).toBe("5");
      });

      it("AC-235: a DIVIDEND still refuses a cost leg, and its withholding is untouched", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR"]);
        const share = await createShareInstrument(session, "US1912161007", "EUR");

        const rejected = await post(
          "/api/v1/transactions",
          {
            kind: "DIVIDEND",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            amount: "50.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            fee: {
              components: { tax: "3.60" },
            },
          },
          session,
        );
        // V13 still holds: a dividend's tax is its **withholding** leg, which
        // is one amount in the settling account's currency.
        expect(rejected.status).toBe(400);
        expect(rejected.body.detail ?? "").toContain("fee");

        const withWithholding = await post(
          "/api/v1/transactions",
          {
            kind: "DIVIDEND",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            amount: "50.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            withholding: { amount: "7.50" },
          },
          session,
        );
        expect(withWithholding.status).toBe(201);
        expect(withWithholding.body.withholdingAmount).toBe("7.5");
        // The row shape is unchanged: no component was invented for it.
        expect(withWithholding.body.taxAmount).toBeNull();
      });

      it("a legacy componentless row returns all four as null with its total populated", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR"]);
        const share = await createShareInstrument(session, "US8636671013", "EUR");

        const created = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "100.00",
            currency: "EUR",
            cashAccountId: cash(portfolioId, "EUR"),
            fee: { amount: "17.00" },
          },
          session,
        );
        expect(created.status).toBe(201);
        expect(created.body.feeAmount).toBe("17");
        for (const field of ["brokerFeeAmount", "fxFeeAmount", "taxAmount", "otherCostAmount"]) {
          expect(created.body[field]).toBeNull();
        }
      });

      it("400 CASH_ACCOUNT_CURRENCY_MISMATCH — a declared cashCurrency the named account does not have", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US5949181045", "USD");

        const rejected = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            // The account is EUR; the body claims the leg settled in USD.
            cashAccountId: cash(portfolioId, "EUR"),
            cashCurrency: "USD",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(rejected.status).toBe(400);
        expect(rejected.body.code).toBe("CASH_ACCOUNT_CURRENCY_MISMATCH");
      });

      /**
       * FT-17: a *schema* rejection is unchanged in kind — a 400 with a
       * per-field `errors` entry, `parseOrThrow`'s own shape, and **no new
       * problem type**. Asserted for the one case the schema can decide by
       * itself: a settled amount with no currency.
       */
      it("400 VALIDATION_ERROR with a per-field issue — a settled amount with no currency is a schema rejection, not a new problem type", async () => {
        const session = await bob();
        const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
        const share = await createShareInstrument(session, "US64110L1061", "USD");

        const rejected = await post(
          "/api/v1/transactions",
          {
            kind: "BUY",
            portfolioId,
            instrumentId: share,
            tradeDate: "2026-01-15",
            quantity: "10",
            unitPrice: "150.00",
            currency: "USD",
            cashAccountId: cash(portfolioId, "EUR"),
            cashAmount: "1380.00",
            fxRateUserInput: PINNED_RATE,
          },
          session,
        );

        expect(rejected.status).toBe(400);
        expect(rejected.headers["content-type"]).toContain("application/problem+json");
        expect(rejected.body.code).toBe("VALIDATION_ERROR");
        expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual([
          "cashCurrency",
        ]);
      });
    });

    /**
     * FT-17's end-to-end half: `cashCurrency`/`cashAmount` are **editable**,
     * because `cashAccountId` is and the composite FK `0046` re-points pairs
     * the two. Neither is in `GUARDED_FX_EDIT_FIELDS`, so this is a `200`
     * rather than the `400 TRANSACTION_FX_EDIT_FORBIDDEN` the four *other*
     * currency fields get — which is the whole of FD8.
     */
    it("an edit re-pointing the principal leg to a differently-denominated account is accepted end to end", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
      const share = await createShareInstrument(session, "US8835561023", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "10",
          unitPrice: "150.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fxRateUserInput: PINNED_RATE,
        },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.cashCurrency).toBe("USD");
      expect(created.body.cashAmount).toBe("1500");

      const edited = await patch(
        `/api/v1/transactions/${created.body.id}`,
        {
          cashAccountId: cash(portfolioId, "EUR"),
          cashCurrency: "EUR",
          cashAmount: "1380.00",
        },
        session,
      );

      expect(edited.status).toBe(200);
      expect(edited.body.cashAccountId).toBe(cash(portfolioId, "EUR"));
      expect(edited.body.cashCurrency).toBe("EUR");
      expect(edited.body.cashAmount).toBe("1380");

      // Read back, so the change is proven persisted rather than echoed.
      const reread = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reread.body.cashCurrency).toBe("EUR");
      expect(reread.body.cashAmount).toBe("1380");
      // …and the trade's own currency is untouched: this is a settlement
      // change, not an FX-leg one (FD8).
      expect(reread.body.txnCurrency).toBe("USD");
      expect(reread.body.fxRate).toBe("0.92");
    });

    /**
     * **The stale-cash-amount refusal at the API boundary** — FR-254's third
     * trigger, which an earlier edit table had dropped and which only
     * `TransactionEditForm` guarded. The service-level proof lives in
     * `ledger/src/transaction-edit-service.integration.test.ts`; this asserts
     * the half that matters to a caller who is not the browser: the HTTP
     * status, the code, and that the title states the *right* cause.
     *
     * CHF -> GBP deliberately: both are neither the transaction's USD nor the
     * base EUR, so this is a D3/D5 -> D3/D5 move that no recompute rule covers
     * and no CHECK objects to.
     */
    it("re-denominating a settlement without a new figure is 400 CASH_AMOUNT_STALE, and the request carrying one is 200", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD", "CHF", "GBP"]);
      const share = await createShareInstrument(session, "US9497461015", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "10",
          unitPrice: "150.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "CHF"),
          cashCurrency: "CHF",
          cashAmount: "1342.50",
          fxRateUserInput: PINNED_RATE,
        },
        session,
      );
      expect(created.status).toBe(201);
      expect(created.body.cashCurrency).toBe("CHF");
      expect(created.body.cashAmount).toBe("1342.5");

      const refused = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { cashAccountId: cash(portfolioId, "GBP"), cashCurrency: "GBP" },
        session,
      );

      expect(refused.status).toBe(400);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.body.code).toBe("CASH_AMOUNT_STALE");
      // The title, not only the code: one code now covers two triggers, and
      // before this fix the single title told a caller re-denominating a leg
      // that their edit "moves the gross amount" — which it does not.
      expect(refused.body.title).toContain("settling currency");
      expect(refused.body.title).not.toContain("gross amount");
      expect(refused.body.detail).toContain("from CHF to GBP");

      // Nothing landed.
      const untouched = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(untouched.body.cashCurrency).toBe("CHF");
      expect(untouched.body.cashAmount).toBe("1342.5");
      expect(untouched.body.cashAccountId).toBe(cash(portfolioId, "CHF"));

      // The same edit carrying the broker's GBP figure is accepted — the
      // incomplete edit was refused, not the edit.
      const accepted = await patch(
        `/api/v1/transactions/${created.body.id}`,
        {
          cashAccountId: cash(portfolioId, "GBP"),
          cashCurrency: "GBP",
          cashAmount: "1180.00",
        },
        session,
      );
      expect(accepted.status).toBe(200);
      const reloaded = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reloaded.body.cashCurrency).toBe("GBP");
      expect(reloaded.body.cashAmount).toBe("1180");
      expect(reloaded.body.cashAccountId).toBe(cash(portfolioId, "GBP"));
    });

    /**
     * **The account-currency mismatch at the API boundary.** With a figure
     * supplied, the stale-amount refusal above is satisfied and the request reaches the account
     * reconciliation, where the currency no longer matches the account still
     * named on the row. That used to reach Postgres as a `23503` on
     * `transaction_cash_account_fk` — unmapped, not in
     * `CLIENT_CAUSED_FK_CONSTRAINTS`, so a **500** whose log line carried the
     * whole `UPDATE` and its bound parameters. It must be a named 400.
     */
    it("a cash_currency change that contradicts the named account is a 400, never a 500", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD", "CHF", "GBP"]);
      const share = await createShareInstrument(session, "US1667641005", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "10",
          unitPrice: "150.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "CHF"),
          cashCurrency: "CHF",
          cashAmount: "1342.50",
          fxRateUserInput: PINNED_RATE,
        },
        session,
      );
      expect(created.status).toBe(201);

      const refused = await patch(
        `/api/v1/transactions/${created.body.id}`,
        // No `cashAccountId`: the CHF account stays named, the currency moves.
        { cashCurrency: "GBP", cashAmount: "1180.00" },
        session,
      );

      expect(refused.status).toBe(400);
      expect(refused.status).not.toBe(500);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.body.code).toBe("CASH_ACCOUNT_CURRENCY_MISMATCH");
      // The body is the domain's answer, never the database's: no constraint
      // name, no SQL, no bound parameters.
      expect(JSON.stringify(refused.body)).not.toContain("transaction_cash_account_fk");
      expect(JSON.stringify(refused.body)).not.toContain("23503");
      expect(JSON.stringify(refused.body)).not.toContain('update "transaction"');

      const untouched = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(untouched.body.cashCurrency).toBe("CHF");
      expect(untouched.body.cashAmount).toBe("1342.5");
    });

    /**
     * **AC-248's API-boundary half**.
     *
     * AC-248 asks for the sum rule "asserted at the **API boundary** and,
     * independently, at the database boundary". Both shipped assertions were at
     * the *service* layer (`transaction-edit-service.integration.test.ts`) and
     * the *database* layer (a `23514` naming
     * `transaction_cost_components_sum_to_fee_amount`), so the mapping
     * `CostComponentsInvalidError -> 400 COST_COMPONENTS_INVALID` was exercised
     * by no test on the PATCH path at all. The only HTTP assertion was the
     * **create** case in `cash-account-qe-journeys.e2e.test.ts`.
     *
     * The gate recorded AC-248 as "met in substance" — the rule *is* enforced
     * and proven twice, just not at the layer the AC names. The regression that
     * nothing would have caught: a PATCH whose merged components contradict the
     * merged total answering `500`, or `TRANSACTION_INVALID_SHAPE` with no
     * field for the form to act on.
     */
    it("a PATCH editing one component without its total is 400 COST_COMPONENTS_INVALID", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
      const share = await createShareInstrument(session, "US7170811035", "USD");

      const created = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "10",
          unitPrice: "150.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "USD"),
          fee: { components: { brokerFee: "7.14", tax: "4.30" } },
          fxRateUserInput: PINNED_RATE,
        },
        session,
      );
      expect(created.status).toBe(201);
      // The total was derived from the components, not supplied.
      expect(created.body.feeAmount).toBe("11.44");

      // One component moves and the stored total stays, so the merged pair
      // disagrees. AC-248 asks for a rejection, not a repair.
      const refused = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { taxAmount: "5.30" },
        session,
      );

      expect(refused.status).toBe(400);
      expect(refused.status).not.toBe(500);
      expect(refused.headers["content-type"]).toContain("application/problem+json");
      expect(refused.body.code).toBe("COST_COMPONENTS_INVALID");
      // Not the generic shape code, which is the outcome this mapping exists to
      // replace — it gives the form no field to attach the message to.
      expect(refused.body.code).not.toBe("TRANSACTION_INVALID_SHAPE");
      // The field the caller has to act on, and both figures.
      expect(refused.body.detail).toContain("12.44");
      expect(refused.body.detail).toContain("11.44");

      // Nothing landed.
      const untouched = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(untouched.body.feeAmount).toBe("11.44");
      expect(untouched.body.taxAmount).toBe("4.3");

      // …and the same edit carrying an agreeing total is accepted, so the
      // refusal is the contradiction and nothing else about the request.
      const accepted = await patch(
        `/api/v1/transactions/${created.body.id}`,
        { taxAmount: "5.30", feeAmount: "12.44" },
        session,
      );
      expect(accepted.status).toBe(200);
      const reloaded = await get(`/api/v1/transactions/${created.body.id}`, session);
      expect(reloaded.body.feeAmount).toBe("12.44");
      expect(reloaded.body.taxAmount).toBe("5.3");
    });

    /**
     * FR-258's read-side contract, all three shapes in one test, because "the
     * field exists" and "the field is populated" are different claims and only
     * asserting one of them is how a `null` gets mistaken for a degenerate
     * settlement.
     */
    it("the response carries both fields populated for a cross-currency row, populated-and-equal for a degenerate one, and null/null for an asset-settled one", async () => {
      const session = await bob();
      const portfolioId = await portfolioWithAccounts(session, ["EUR", "USD"]);
      const share = await createShareInstrument(session, "US02079K3059", "USD");
      const eth = await createCryptoInstrument(session, "FT18ETH");
      const btc = await createCryptoInstrument(session, "FT18BTC");

      const crossCurrency = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: share,
          tradeDate: "2026-01-15",
          quantity: "10",
          unitPrice: "150.00",
          currency: "USD",
          cashAccountId: cash(portfolioId, "EUR"),
          cashCurrency: "EUR",
          fxRateUserInput: PINNED_RATE,
        },
        session,
      );
      expect(crossCurrency.status).toBe(201);
      expect(crossCurrency.body.cashCurrency).toBe("EUR");
      expect(crossCurrency.body.cashAmount).toBe("1380");
      // …and it genuinely differs from the transaction's own figures, which is
      // what FR-258 makes the detail panel branch on.
      expect(crossCurrency.body.cashCurrency).not.toBe(crossCurrency.body.txnCurrency);
      expect(crossCurrency.body.cashAmount).not.toBe(crossCurrency.body.grossAmount);

      const degenerate = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2026-01-15",
          amount: "500.00",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(degenerate.status).toBe(201);
      expect(degenerate.body.cashCurrency).toBe("EUR");
      expect(degenerate.body.cashAmount).toBe("500");
      expect(degenerate.body.cashCurrency).toBe(degenerate.body.txnCurrency);
      expect(degenerate.body.cashAmount).toBe(degenerate.body.grossAmount);

      const buyEth = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: eth,
          tradeDate: "2026-01-14",
          quantity: "5",
          unitPrice: "1000",
          currency: "EUR",
          cashAccountId: cash(portfolioId, "EUR"),
        },
        session,
      );
      expect(buyEth.status).toBe(201);

      const assetSettled = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId,
          instrumentId: btc,
          tradeDate: "2026-01-15",
          quantity: "0.1",
          settlement: { instrumentId: eth, amount: "1", fxRateUserInput: "1000" },
        },
        session,
      );
      expect(assetSettled.status).toBe(201);
      // FR-236: it moved no cash, so there is no settlement currency and no
      // settled amount — `null`, not the degenerate pair.
      expect(assetSettled.body.cashCurrency).toBeNull();
      expect(assetSettled.body.cashAmount).toBeNull();
      expect(assetSettled.body.cashAccountId).toBeNull();
    });
  });

  /**
   * **`cash-interest` CI-T2 — AC-519 (HTTP half) and AC-520** (C-4, C-6, C-7, F-A1).
   * A tenant of its own, for the reason FT-18's
   * block gives, and because the concurrency case below must serialise on
   * *this* tenant's advisory lock and nobody else's.
   *
   * P (spec fixture): a portfolio whose « Livret » EUR account received a
   * DEPOSIT of 1000.00.
   */
  describe("cash-interest — INTEREST shape refusals over HTTP, edit, kind refusal, delete, concurrency (AC-519, AC-520)", () => {
    const tenantC = "00000000-0000-7000-8000-0000003800c0";
    const carolId = "00000000-0000-7000-8000-0000003800c1";
    const carolEmail = "carol-transactions-interest@example.com";
    const carolPassword = "correct horse battery staple interest";

    beforeAll(async () => {
      await testApp.ownerDb.insert(tenant).values([{ id: tenantC }]);
      await createUser(testApp.db, {
        id: carolId,
        tenantId: tenantC,
        email: carolEmail,
        password: carolPassword,
      });
    }, 60_000);

    async function carol(): Promise<{ sid: string; csrf: string }> {
      return loginAs(server(), carolEmail, carolPassword);
    }

    async function newAccount(
      session: { sid: string; csrf: string },
      portfolioId: string,
      name: string,
      currency: string,
    ): Promise<string> {
      const response = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name, currency },
        session,
      );
      expect(response.status).toBe(201);
      return response.body.id as string;
    }

    /** P: « Livret » (EUR) with its DEPOSIT 1000.00, plus a second EUR and a USD account for the re-point and cross-currency cases. */
    async function portfolioP(session: { sid: string; csrf: string }): Promise<{
      portfolioId: string;
      livret: string;
      other: string;
      usd: string;
    }> {
      const created = await post("/api/v1/portfolios", { name: `AC-520 ${randomUUID()}` }, session);
      expect(created.status).toBe(201);
      const portfolioId = created.body.id as string;
      const livret = await newAccount(session, portfolioId, "Livret", "EUR");
      const other = await newAccount(session, portfolioId, "Livret bis", "EUR");
      const usd = await newAccount(session, portfolioId, "Compte USD", "USD");
      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2026-01-01",
          amount: "1000.00",
          currency: "EUR",
          cashAccountId: livret,
        },
        session,
      );
      expect(deposit.status).toBe(201);
      return { portfolioId, livret, other, usd };
    }

    function interestBody(
      portfolioId: string,
      livret: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        kind: "INTEREST",
        portfolioId,
        tradeDate: "2026-07-01",
        amount: "100.00",
        currency: "EUR",
        cashAccountId: livret,
        ...extra,
      };
    }

    async function transactionCount(portfolioId: string): Promise<number> {
      const [row] = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from "transaction" where portfolio_id = ${portfolioId}::uuid`;
      return row!.n;
    }

    async function postingsOfAccount(accountId: string): Promise<number> {
      const [row] = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from transaction_posting where cash_account_id = ${accountId}::uuid`;
      return row!.n;
    }

    /** The postings of one transaction as `[flow_class, amount_native, cash_account_id]`, in emission order. */
    async function postingsOf(id: string): Promise<[string, string, string | null][]> {
      const rows = await testApp.ownerClient<
        { flowClass: string; amount: string; account: string | null }[]
      >`
        select flow_class::text as "flowClass",
               amount_native::numeric(38, 2)::text as amount,
               cash_account_id::text as account
          from transaction_posting
         where transaction_id = ${id}::uuid
         order by seq`;
      return rows.map((row) => [row.flowClass, row.amount, row.account]);
    }

    /** INTEREST gross 100.00 / withholding 30.00 EUR, both legs on « Livret ». */
    async function createWithheld(
      session: { sid: string; csrf: string },
      p: { portfolioId: string; livret: string },
    ): Promise<string> {
      const created = await post(
        "/api/v1/transactions",
        interestBody(p.portfolioId, p.livret, {
          withholding: { amount: "30.00" },
        }),
        session,
      );
      expect(created.status).toBe(201);
      return created.body.id as string;
    }

    it("AC-519: each refused INTEREST body is a 4xx that creates nothing — and a DEPOSIT carrying a withholding is refused at the API layer (C-4)", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const before = await transactionCount(p.portfolioId);
      expect(before).toBe(1);

      const refused: readonly [string, Record<string, unknown>][] = [
        ["no cash account", { ...interestBody(p.portfolioId, p.livret), cashAccountId: undefined }],
        ["amount 0", interestBody(p.portfolioId, p.livret, { amount: "0" })],
        ["amount negative", interestBody(p.portfolioId, p.livret, { amount: "-10.00" })],
        ["an instrument", interestBody(p.portfolioId, p.livret, { instrumentId: randomUUID() })],
        ["a quantity", interestBody(p.portfolioId, p.livret, { quantity: "3" })],
        ["a unit price", interestBody(p.portfolioId, p.livret, { unitPrice: "1.00" })],
        [
          "a fee",
          interestBody(p.portfolioId, p.livret, {
            fee: { amount: "1.00", cashAccountId: p.livret },
          }),
        ],
        [
          "withholding equal to the gross",
          interestBody(p.portfolioId, p.livret, {
            withholding: { amount: "100.00" },
          }),
        ],
        [
          "withholding above the gross",
          interestBody(p.portfolioId, p.livret, {
            withholding: { amount: "100.01" },
          }),
        ],
        [
          // The old currency / account / rate keys are gone from the wire.
          "a withholding still naming a currency",
          interestBody(p.portfolioId, p.livret, {
            withholding: { amount: "30.00", currency: "EUR" },
          }),
        ],
        [
          "a DEPOSIT with a withholding",
          {
            kind: "DEPOSIT",
            portfolioId: p.portfolioId,
            tradeDate: "2026-07-01",
            amount: "100.00",
            currency: "EUR",
            cashAccountId: p.livret,
            withholding: { amount: "30.00" },
          },
        ],
      ];
      for (const [label, body] of refused) {
        const response = await post("/api/v1/transactions", body, session);
        expect(response.status, label).toBeGreaterThanOrEqual(400);
        expect(response.status, label).toBeLessThan(500);
      }
      // The "below the principal cash amount" comparison is the service's,
      // and the refusal names its field — equal and above alike.
      for (const label of ["withholding equal to the gross", "withholding above the gross"]) {
        const body = refused.find(([l]) => l === label)![1];
        const response = await post("/api/v1/transactions", body, session);
        expect(response.status, label).toBe(400);
        expect(response.body.code, label).toBe("TRANSACTION_ARGUMENT_INVALID");
        expect(response.body.detail, label).toContain("withholding.amount");
        expect(response.body.detail, label).toMatch(/below|less|strictly/i);
      }
      // A key the wire no longer speaks is a per-field VALIDATION_ERROR, not a silent strip.
      const stale = await post(
        "/api/v1/transactions",
        refused.find(([l]) => l === "a withholding still naming a currency")![1],
        session,
      );
      expect(stale.status).toBe(400);
      expect(stale.body.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(stale.body)).toContain("currency");

      expect(await transactionCount(p.portfolioId)).toBe(before);
    });

    it("AC-520: PATCH grossAmount keeps the stored withholding and account (merged values); the postings follow", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);

      const edited = await patch(`/api/v1/transactions/${id}`, { grossAmount: "120.00" }, session);
      expect(edited.status).toBe(200);
      expect(new Decimal(edited.body.grossAmount).equals(new Decimal("120"))).toBe(true);
      expect(new Decimal(edited.body.withholdingAmount).equals(new Decimal("30"))).toBe(true);
      expect(edited.body.cashAccountId).toBe(p.livret);
      expect(await postingsOf(id)).toEqual([
        ["INCOME", "120.00", p.livret],
        ["TAX", "-30.00", p.livret],
      ]);
    });

    it("AC-520: PATCH cashAccountId re-points the principal leg; PATCH withholdingAmount edits the TAX leg; null removes it", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);

      const repointed = await patch(
        `/api/v1/transactions/${id}`,
        { cashAccountId: p.other },
        session,
      );
      expect(repointed.status).toBe(200);
      expect(repointed.body.cashAccountId).toBe(p.other);
      expect(await postingsOf(id)).toEqual([
        ["INCOME", "100.00", p.other],
        ["TAX", "-30.00", p.other], // The TAX leg follows the settling account
      ]);

      const rewithheld = await patch(
        `/api/v1/transactions/${id}`,
        { withholdingAmount: "40.00" },
        session,
      );
      expect(rewithheld.status).toBe(200);
      expect(await postingsOf(id)).toEqual([
        ["INCOME", "100.00", p.other],
        ["TAX", "-40.00", p.other],
      ]);

      const removed = await patch(
        `/api/v1/transactions/${id}`,
        { withholdingAmount: null },
        session,
      );
      expect(removed.status).toBe(200);
      expect(removed.body.withholdingAmount).toBeNull();
      expect(await postingsOf(id)).toEqual([["INCOME", "100.00", p.other]]);
    });

    it("AC-520: tradeDate is editable on an INTEREST (was refused for every kind, C-6), and an INTEREST that carries no withholding may be given one", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const plain = await post(
        "/api/v1/transactions",
        interestBody(p.portfolioId, p.livret),
        session,
      );
      expect(plain.status).toBe(201);

      const redated = await patch(
        `/api/v1/transactions/${plain.body.id}`,
        { tradeDate: "2026-07-02" },
        session,
      );
      expect(redated.status, JSON.stringify(redated.body)).toBe(200);
      expect(redated.body.tradeDate).toBe("2026-07-02");

      const added = await patch(
        `/api/v1/transactions/${plain.body.id}`,
        { withholdingAmount: "5.00" },
        session,
      );
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body.withholdingAmount).toBe("5");
      expect(await postingsOf(plain.body.id)).toEqual([
        ["INCOME", "100.00", p.livret],
        ["TAX", "-5.00", p.livret],
      ]);
    });

    it("PATCH naming a retired withholding field is 400 TRANSACTION_FX_EDIT_FORBIDDEN per field, never a silent 200", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);
      for (const field of [
        "withholdingCurrency",
        "whtCashAccountId",
        "whtFxRate",
        "whtFxRateSource",
        "whtFxRateUserInput",
      ]) {
        const refused = await patch(`/api/v1/transactions/${id}`, { [field]: "USD" }, session);
        expect(refused.status, field).toBe(400);
        expect(refused.body.code, field).toBe("TRANSACTION_FX_EDIT_FORBIDDEN");
        expect(refused.body.errors, field).toEqual([
          { field, message: expect.stringContaining("no longer exists") },
        ]);
      }
      const reread = await get(`/api/v1/transactions/${id}`, session);
      expect(reread.body.withholdingAmount).toBe("30");
    });

    it("AC-520: a merged withholding at or above the merged gross is 400 TRANSACTION_ARGUMENT_INVALID naming withholdingAmount, row unchanged", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);

      for (const body of [
        { withholdingAmount: "100.00" }, // = the stored gross
        { grossAmount: "25.00" }, // below the stored withholding
      ]) {
        const refused = await patch(`/api/v1/transactions/${id}`, body, session);
        expect(refused.status, JSON.stringify(body)).toBe(400);
        expect(refused.body.code).toBe("TRANSACTION_ARGUMENT_INVALID");
        expect(refused.body.detail).toContain("withholdingAmount");
      }
      expect(await postingsOf(id)).toEqual([
        ["INCOME", "100.00", p.livret],
        ["TAX", "-30.00", p.livret],
      ]);
    });

    it("AC-520 / F-A1: a PATCH naming kind is 400 TRANSACTION_KIND_NOT_EDITABLE — alone or beside a real edit — and the row is unchanged", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);

      // `{kind, note}` first: before F-A1 it was a silent 200 that dropped the kind (C-7).
      for (const body of [{ kind: "DEPOSIT", note: "x" }, { kind: "DEPOSIT" }]) {
        const refused = await patch(`/api/v1/transactions/${id}`, body, session);
        expect(refused.status, JSON.stringify(body)).toBe(400);
        expect(refused.body.code).toBe("TRANSACTION_KIND_NOT_EDITABLE");
        expect(refused.body.detail).toContain("supprimez puis recréez la transaction");
      }
      const reread = await get(`/api/v1/transactions/${id}`, session);
      expect(reread.body.kind).toBe("INTEREST");
      expect(reread.body.note).toBeNull();
    });

    it("AC-520: DELETE removes the row and every one of its postings, with one DELETE revision", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);
      expect(await postingsOf(id)).toHaveLength(2);

      const deleted = await del(`/api/v1/transactions/${id}`, session);
      expect(deleted.status).toBe(204);
      expect(await postingsOf(id)).toEqual([]);
      const reread = await get(`/api/v1/transactions/${id}`, session);
      expect(reread.status).toBe(404);
      const revisions = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from transaction_revision
         where transaction_id = ${id}::uuid and revision_kind = 'DELETE'`;
      expect(revisions[0]!.n).toBe(1);
    });

    it("QE: an INTEREST naming a cash account of another portfolio or another tenant is refused and creates nothing", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const q = await portfolioP(session); // same tenant, another portfolio
      const aliceSession = await alice();
      const alicePortfolio = await post(
        "/api/v1/portfolios",
        { name: `QE ${randomUUID()}` },
        aliceSession,
      );
      expect(alicePortfolio.status).toBe(201);
      const foreign = await newAccount(
        aliceSession,
        alicePortfolio.body.id as string,
        "Etranger",
        "EUR",
      );

      const before = await transactionCount(p.portfolioId);
      const refused: readonly [string, Record<string, unknown>][] = [
        ["principal in another portfolio", interestBody(p.portfolioId, q.livret)],
        ["principal in another tenant", interestBody(p.portfolioId, foreign)],
      ];
      for (const [label, body] of refused) {
        const response = await post("/api/v1/transactions", body, session);
        expect(response.status, label).toBeGreaterThanOrEqual(400);
        expect(response.status, label).toBeLessThan(500);
      }
      expect(await transactionCount(p.portfolioId)).toBe(before);
      expect(await postingsOfAccount(q.livret)).toBe(1); // only Q's own DEPOSIT leg

      // The same refusal on the edit path: re-pointing at a foreign account.
      const id = await createWithheld(session, p);
      for (const body of [{ cashAccountId: q.livret }, { cashAccountId: foreign }]) {
        const edit = await patch(`/api/v1/transactions/${id}`, body, session);
        expect(edit.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(edit.status).toBeLessThan(500);
      }
      expect(await postingsOf(id)).toEqual([
        ["INCOME", "100.00", p.livret],
        ["TAX", "-30.00", p.livret],
      ]);
    });

    it("QE: PATCH withholdingAmount null leaves the row's withholding NULL; DELETE bumps calc_epoch; ?kind=INTEREST filters", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);
      const epoch = async (): Promise<bigint> => {
        const [row] = await testApp.ownerClient<{ e: string }[]>`
          select calc_epoch::text as e from portfolio where id = ${p.portfolioId}::uuid`;
        return BigInt(row!.e);
      };

      const listed = await get(
        `/api/v1/transactions?portfolio=${p.portfolioId}&kind=INTEREST`,
        session,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([id]);

      const cleared = await patch(
        `/api/v1/transactions/${id}`,
        { withholdingAmount: null },
        session,
      );
      expect(cleared.status).toBe(200);
      const [row] = await testApp.ownerClient<
        { amount: string | null }[]
      >`select withholding_amount::text as amount
          from "transaction" where id = ${id}::uuid`;
      expect(row).toMatchObject({ amount: null });
      expect(await postingsOf(id)).toEqual([["INCOME", "100.00", p.livret]]);

      const before = await epoch();
      expect((await del(`/api/v1/transactions/${id}`, session)).status).toBe(204);
      expect(await postingsOf(id)).toEqual([]);
      expect(await epoch()).toBeGreaterThan(before);
    });

    it("AC-520: two parallel PATCHes on the same tenant both succeed, serialised, and the postings match the last write", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);
      // Pre-warm: open the app's pooled connections before the race, so the
      // two PATCHes below are not serialised by lazy connection setup alone.
      await Promise.all([
        get(`/api/v1/transactions/${id}`, session),
        get(`/api/v1/transactions/${id}`, session),
      ]);

      const [first, second] = await Promise.all([
        patch(`/api/v1/transactions/${id}`, { grossAmount: "150.00" }, session),
        patch(`/api/v1/transactions/${id}`, { grossAmount: "160.00" }, session),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const reread = await get(`/api/v1/transactions/${id}`, session);
      const finalGross = new Decimal(reread.body.grossAmount);
      expect(["150", "160"]).toContain(finalGross.toString());
      const postings = await postingsOf(id);
      expect(postings).toEqual([
        ["INCOME", finalGross.toFixed(2), p.livret],
        ["TAX", "-30.00", p.livret],
      ]);
      // Exactly one UPDATE revision per PATCH: neither write was lost.
      const revisions = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from transaction_revision
         where transaction_id = ${id}::uuid and revision_kind = 'UPDATE'`;
      expect(revisions[0]!.n).toBe(2);
    });

    it("QE: INTEREST beside a security transfer — the carried cost ignores it, and INTEREST and TRANSFER_OUT racing on one tenant both land", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const dest = await post("/api/v1/portfolios", { name: `QE dest ${randomUUID()}` }, session);
      expect(dest.status).toBe(201);
      const share = (
        await createInstrumentBySymbol(testApp.ownerDb, {
          kind: "CRYPTO",
          symbol: `QEI${randomUUID().slice(0, 8)}`,
          listingCurrency: "EUR",
          displayName: "QE interest coin",
        })
      ).id;
      const buy = await post(
        "/api/v1/transactions",
        {
          kind: "BUY",
          portfolioId: p.portfolioId,
          instrumentId: share,
          tradeDate: "2026-02-01",
          quantity: "10",
          unitPrice: "50",
          currency: "EUR",
          cashAccountId: p.livret,
        },
        session,
      );
      expect(buy.status, JSON.stringify(buy.body)).toBe(201);
      // An INTEREST before the transfer date and one racing it: the carried
      // cost is PMP 4 x 50, whatever interest the portfolio earned around it.
      expect(
        (await post("/api/v1/transactions", interestBody(p.portfolioId, p.livret), session)).status,
      ).toBe(201);
      const transferBody = (day: number) => ({
        kind: "TRANSFER_OUT",
        portfolioId: p.portfolioId,
        destinationPortfolioId: dest.body.id,
        instrumentId: share,
        tradeDate: `2026-03-0${day}`,
        quantity: "1",
        amount: "52.00",
        currency: "EUR",
      });
      // Pre-warm the app's pooled connections, so the writes below truly overlap.
      await Promise.all([
        get("/api/v1/transactions?limit=1", session),
        get("/api/v1/transactions?limit=1", session),
      ]);
      // Five rounds of one INTEREST racing one TRANSFER_OUT: a lock-order
      // inversion between the two paths is a window, so one round proves little.
      for (let day = 1; day <= 5; day++) {
        const [racedInterest, racedTransfer] = await Promise.all([
          post(
            "/api/v1/transactions",
            interestBody(p.portfolioId, p.livret, { tradeDate: `2026-03-0${day}` }),
            session,
          ),
          post("/api/v1/transactions", transferBody(day), session),
        ]);
        expect(racedInterest.status, JSON.stringify(racedInterest.body)).toBe(201);
        expect(racedTransfer.status, JSON.stringify(racedTransfer.body)).toBe(201);
      }

      const legs = await get(
        `/api/v1/transactions?kind=TRANSFER_IN&portfolio=${dest.body.id}&limit=10`,
        session,
      );
      expect(legs.body.items).toHaveLength(5);
      for (const leg of legs.body.items) {
        expect(new Decimal(leg.transferCostBase).toString()).toBe("50");
      }
      const interests = await get(
        `/api/v1/transactions?kind=INTEREST&portfolio=${p.portfolioId}`,
        session,
      );
      expect(interests.body.items).toHaveLength(6);
      for (const row of interests.body.items) expect(row.instrumentId).toBeNull();
    });

    it("QE: deleting a portfolio that holds INTEREST rows removes the rows, every posting and the cash accounts", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);
      expect(await postingsOf(id)).toHaveLength(2);

      expect((await del(`/api/v1/portfolios/${p.portfolioId}`, session)).status).toBe(204);

      expect(await postingsOf(id)).toEqual([]);
      expect(await transactionCount(p.portfolioId)).toBe(0);
      const [accounts] = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from cash_account where portfolio_id = ${p.portfolioId}::uuid`;
      expect(accounts!.n).toBe(0);
      expect((await get(`/api/v1/transactions/${id}`, session)).status).toBe(404);
    });

    it("QE: an archived portfolio still takes an INTEREST, exactly as it takes a DEPOSIT (AC-481's rule)", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const archive = await patch(
        `/api/v1/portfolios/${p.portfolioId}`,
        { archived: true },
        session,
      );
      expect(archive.status).toBe(200);
      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId: p.portfolioId,
          tradeDate: "2026-07-01",
          amount: "5.00",
          currency: "EUR",
          cashAccountId: p.livret,
        },
        session,
      );
      const interest = await post(
        "/api/v1/transactions",
        interestBody(p.portfolioId, p.livret),
        session,
      );
      expect(deposit.status).toBe(201);
      expect(interest.status, JSON.stringify(interest.body)).toBe(201);
    });

    it("QE: an archived cash account refuses a new INTEREST as it refuses a DEPOSIT, yet keeps its history editable", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      const id = await createWithheld(session, p);
      const archived = await patch(
        `/api/v1/portfolios/${p.portfolioId}/cash-accounts/${p.livret}`,
        { archived: true },
        session,
      );
      expect(archived.status).toBe(200);

      const depositRefusal = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId: p.portfolioId,
          tradeDate: "2026-07-01",
          amount: "5.00",
          currency: "EUR",
          cashAccountId: p.livret,
        },
        session,
      );
      expect(depositRefusal.status).toBeGreaterThanOrEqual(400);
      const before = await transactionCount(p.portfolioId);
      const principal = await post(
        "/api/v1/transactions",
        interestBody(p.portfolioId, p.livret),
        session,
      );
      expect(principal.status).toBe(depositRefusal.status);
      expect(principal.body.code).toBe(depositRefusal.body.code);
      expect(await transactionCount(p.portfolioId)).toBe(before);

      // The existing row, attributed to the now-archived account, stays editable.
      const edited = await patch(
        `/api/v1/transactions/${id}`,
        { note: "toujours editable" },
        session,
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    });

    it("QE: interest is cash, not a contribution — net contributions exclude it, cash counts it net of the withholding, no holding appears", async () => {
      const session = await carol();
      const p = await portfolioP(session);
      await createWithheld(session, p);
      const series = await get(
        `/api/v1/portfolios/${p.portfolioId}/value-series?from=2026-06-29&to=2026-07-03`,
        session,
      );
      expect(series.status).toBe(200);
      const byDate = new Map<string, string>(
        series.body.points.map((pt: { date: string; netContributions: string }) => [
          pt.date,
          pt.netContributions,
        ]),
      );
      // Only the 1000.00 DEPOSIT: the interest never moves it, before or after 07-01.
      for (const date of ["2026-06-29", "2026-07-02", "2026-07-03"]) {
        expect(byDate.get(date), date).toBe("1000");
      }
      const cashRead = await get(`/api/v1/portfolios/${p.portfolioId}/cash`, session);
      expect(cashRead.status).toBe(200);
      expect(cashRead.body.accounts.find((a: { id: string }) => a.id === p.livret).balance).toBe(
        "1070",
      );
      expect(
        cashRead.body.byCurrency.find((c: { currency: string }) => c.currency === "EUR").total,
      ).toBe("1070");
      const holdings = await get(`/api/v1/portfolios/${p.portfolioId}/holdings`, session);
      expect(holdings.status).toBe(200);
      expect(holdings.body.items ?? holdings.body.holdings ?? []).toHaveLength(0);
    });
  });

  describe("portfolio-cash — FEE shape refusals over HTTP, merged-value edit, refused fields, delete, concurrency (AC-567, AC-568)", () => {
    const tenantD = "00000000-0000-7000-8000-0000003800d0";
    const daveId = "00000000-0000-7000-8000-0000003800d1";
    const daveEmail = "dave-transactions-fee@example.com";
    const davePassword = "correct horse battery staple portfolio fee";

    let shareA: string;
    let shareB: string;

    beforeAll(async () => {
      await testApp.ownerDb.insert(tenant).values([{ id: tenantD }]);
      await createUser(testApp.db, {
        id: daveId,
        tenantId: tenantD,
        email: daveEmail,
        password: davePassword,
      });
      // Service-layer fixtures, as `createShareInstrument` explains: no `POST /instruments`.
      const session = await dave();
      shareA = await createShareInstrument(session, "FRPCT2000001");
      shareB = await createShareInstrument(session, "FRPCT2000002");
    }, 60_000);

    async function dave(): Promise<{ sid: string; csrf: string }> {
      return loginAs(server(), daveEmail, davePassword);
    }

    async function newAccount(
      session: { sid: string; csrf: string },
      portfolioId: string,
      name: string,
    ): Promise<string> {
      const response = await post(
        `/api/v1/portfolios/${portfolioId}/cash-accounts`,
        { name, currency: "EUR" },
        session,
      );
      expect(response.status).toBe(201);
      return response.body.id as string;
    }

    /** P: « Courant » (EUR) with its DEPOSIT 1000.00, plus a second EUR account for the re-point case. */
    async function portfolioP(session: {
      sid: string;
      csrf: string;
    }): Promise<{ portfolioId: string; courant: string; other: string }> {
      const created = await post("/api/v1/portfolios", { name: `AC-568 ${randomUUID()}` }, session);
      expect(created.status).toBe(201);
      const portfolioId = created.body.id as string;
      const courant = await newAccount(session, portfolioId, "Courant");
      const other = await newAccount(session, portfolioId, "Courant bis");
      const deposit = await post(
        "/api/v1/transactions",
        {
          kind: "DEPOSIT",
          portfolioId,
          tradeDate: "2026-01-01",
          amount: "1000.00",
          currency: "EUR",
          cashAccountId: courant,
        },
        session,
      );
      expect(deposit.status).toBe(201);
      return { portfolioId, courant, other };
    }

    function feeBody(
      portfolioId: string,
      courant: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        kind: "FEE",
        portfolioId,
        tradeDate: "2026-07-01",
        amount: "25.00",
        currency: "EUR",
        cashAccountId: courant,
        ...extra,
      };
    }

    async function createFee(
      session: { sid: string; csrf: string },
      p: { portfolioId: string; courant: string },
    ): Promise<string> {
      const created = await post(
        "/api/v1/transactions",
        feeBody(p.portfolioId, p.courant),
        session,
      );
      expect(created.status).toBe(201);
      return created.body.id as string;
    }

    async function transactionCount(portfolioId: string): Promise<number> {
      const [row] = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from "transaction" where portfolio_id = ${portfolioId}::uuid`;
      return row!.n;
    }

    /** The postings of one transaction as `[leg, flow_class, amount_native, cash_account_id]`, in emission order. */
    async function postingsOf(id: string): Promise<[string, string, string, string | null][]> {
      const rows = await testApp.ownerClient<
        { leg: string; flowClass: string; amount: string; account: string | null }[]
      >`
        select leg::text as leg,
               flow_class::text as "flowClass",
               amount_native::numeric(38, 2)::text as amount,
               cash_account_id::text as account
          from transaction_posting
         where transaction_id = ${id}::uuid
         order by seq`;
      return rows.map((row) => [row.leg, row.flowClass, row.amount, row.account]);
    }

    async function balanceOf(
      session: { sid: string; csrf: string },
      portfolioId: string,
      accountId: string,
    ): Promise<string> {
      const read = await get(`/api/v1/portfolios/${portfolioId}/cash`, session);
      expect(read.status).toBe(200);
      return read.body.accounts.find((a: { id: string }) => a.id === accountId).balance as string;
    }

    it("AC-567: each refused FEE body is a 4xx naming its own field (or the BUY's instrument 404) and creates nothing; DEPOSIT/WITHDRAWAL with a fee are still refused", async () => {
      const session = await dave();
      const p = await portfolioP(session);
      const before = await transactionCount(p.portfolioId);
      expect(before).toBe(1);

      // [label, body, status, code, the per-field issue the DTO must name (null: not a DTO refusal)]
      const refused: readonly [string, Record<string, unknown>, number, string, string | null][] = [
        [
          "no cash account",
          { ...feeBody(p.portfolioId, p.courant), cashAccountId: undefined },
          400,
          "VALIDATION_ERROR",
          "cashAccountId",
        ],
        [
          "amount 0",
          feeBody(p.portfolioId, p.courant, { amount: "0" }),
          400,
          "VALIDATION_ERROR",
          "amount",
        ],
        [
          "amount negative",
          feeBody(p.portfolioId, p.courant, { amount: "-10.00" }),
          400,
          "VALIDATION_ERROR",
          "amount",
        ],
        [
          "a quantity",
          feeBody(p.portfolioId, p.courant, { quantity: "3" }),
          400,
          "VALIDATION_ERROR",
          "quantity",
        ],
        [
          "a unit price",
          feeBody(p.portfolioId, p.courant, { unitPrice: "1.00" }),
          400,
          "VALIDATION_ERROR",
          "unitPrice",
        ],
        [
          "a fee",
          feeBody(p.portfolioId, p.courant, { fee: { amount: "1.00" } }),
          400,
          "VALIDATION_ERROR",
          "fee",
        ],
        [
          "a withholding",
          feeBody(p.portfolioId, p.courant, {
            withholding: { amount: "1.00" },
          }),
          400,
          "VALIDATION_ERROR",
          "withholding",
        ],
        [
          // The existing rule, as a BUY with a bogus instrument gets it.
          "an instrument that does not exist",
          feeBody(p.portfolioId, p.courant, { instrumentId: randomUUID() }),
          404,
          "INSTRUMENT_NOT_FOUND",
          null,
        ],
        ...(["DEPOSIT", "WITHDRAWAL"] as const).map(
          (kind): [string, Record<string, unknown>, number, string, string | null] => [
            `a ${kind} with a fee`,
            feeBody(p.portfolioId, p.courant, { kind, fee: { amount: "1.00" } }),
            400,
            "VALIDATION_ERROR",
            "fee",
          ],
        ),
      ];
      for (const [label, body, status, code, field] of refused) {
        const response = await post("/api/v1/transactions", body, session);
        expect(response.status, label).toBe(status);
        expect(response.body.code, label).toBe(code);
        if (field !== null) {
          expect(
            response.body.errors.map((e: { field: string }) => e.field),
            label,
          ).toContain(field);
        }
      }

      expect(await transactionCount(p.portfolioId)).toBe(before);
    });

    it("AC-568: merged-value edit of amount, account, note and the instrument reference (set, changed, cleared); one FEE leg throughout, never a POSITION leg", async () => {
      const session = await dave();
      const p = await portfolioP(session);
      const id = await createFee(session, p);
      expect(await postingsOf(id)).toEqual([["CASH", "FEE", "-25.00", p.courant]]);

      const amount = await patch(`/api/v1/transactions/${id}`, { grossAmount: "30.00" }, session);
      expect(amount.status).toBe(200);
      expect(new Decimal(amount.body.grossAmount).equals(new Decimal("30"))).toBe(true);
      expect(amount.body.cashAccountId).toBe(p.courant);
      expect(await postingsOf(id)).toEqual([["CASH", "FEE", "-30.00", p.courant]]);
      expect(await balanceOf(session, p.portfolioId, p.courant)).toBe("970");

      const account = await patch(
        `/api/v1/transactions/${id}`,
        { cashAccountId: p.other },
        session,
      );
      expect(account.status).toBe(200);
      expect(new Decimal(account.body.grossAmount).equals(new Decimal("30"))).toBe(true);
      expect(await postingsOf(id)).toEqual([["CASH", "FEE", "-30.00", p.other]]);
      expect(await balanceOf(session, p.portfolioId, p.courant)).toBe("1000");

      const note = await patch(`/api/v1/transactions/${id}`, { note: "Droits de garde" }, session);
      expect(note.status).toBe(200);
      expect(note.body.note).toBe("Droits de garde");
      expect(note.body.cashAccountId).toBe(p.other);
      expect(new Decimal(note.body.grossAmount).equals(new Decimal("30"))).toBe(true);

      for (const [instrumentId, label] of [
        [shareA, "set"],
        [shareB, "changed"],
        [null, "cleared"],
      ] as const) {
        const edited = await patch(`/api/v1/transactions/${id}`, { instrumentId }, session);
        expect(edited.status, label).toBe(200);
        const reread = await get(`/api/v1/transactions/${id}`, session);
        expect(reread.body.instrumentId, label).toBe(instrumentId);
        expect(reread.body.note, label).toBe("Droits de garde");
        expect(reread.body.quantity, label).toBeNull();
        expect(await postingsOf(id), label).toEqual([["CASH", "FEE", "-30.00", p.other]]);
      }

      // A non-null change is existence-checked like any other kind's.
      const bogus = await patch(
        `/api/v1/transactions/${id}`,
        { instrumentId: randomUUID() },
        session,
      );
      expect(bogus.status).toBe(404);
      expect(bogus.body.code).toBe("INSTRUMENT_NOT_FOUND");
    });

    it("AC-568: kind, an added fee or withholding, and a quantity or unit price are each refused with their own code, row unchanged", async () => {
      const session = await dave();
      const p = await portfolioP(session);
      const id = await createFee(session, p);

      const refused: readonly [Record<string, unknown>, number, string][] = [
        [{ kind: "WITHDRAWAL" }, 400, "TRANSACTION_KIND_NOT_EDITABLE"],
        [{ feeAmount: "1.00" }, 422, "TRANSACTION_EDIT_NOT_EXPRESSIBLE"],
        [{ withholdingAmount: "1.00" }, 400, "TRANSACTION_ARGUMENT_INVALID"], // Only a DIVIDEND/INTEREST carries one
        [{ quantity: "3" }, 400, "TRANSACTION_INVALID_SHAPE"],
        [{ unitPrice: "1.00" }, 400, "TRANSACTION_INVALID_SHAPE"],
      ];
      for (const [body, status, code] of refused) {
        const response = await patch(`/api/v1/transactions/${id}`, body, session);
        expect(response.status, JSON.stringify(body)).toBe(status);
        expect(response.body.code, JSON.stringify(body)).toBe(code);
        if ("withholdingAmount" in body) {
          expect(response.body.detail).toContain("withholdingAmount");
          expect(response.body.detail).toContain("FEE");
        }
      }

      const reread = await get(`/api/v1/transactions/${id}`, session);
      expect(reread.body.kind).toBe("FEE");
      expect(reread.body.tradeDate).toBe("2026-07-01");
      expect(reread.body.feeAmount).toBeNull();
      expect(reread.body.withholdingAmount).toBeNull();
      expect(reread.body.quantity).toBeNull();
      expect(reread.body.unitPrice).toBeNull();
      expect(await postingsOf(id)).toEqual([["CASH", "FEE", "-25.00", p.courant]]);
    });

    it("AC-568: DELETE removes the row and its posting and restores the balance (975 -> 1000)", async () => {
      const session = await dave();
      const p = await portfolioP(session);
      const id = await createFee(session, p);
      expect(await balanceOf(session, p.portfolioId, p.courant)).toBe("975");

      const deleted = await del(`/api/v1/transactions/${id}`, session);
      expect(deleted.status).toBe(204);
      expect(await postingsOf(id)).toEqual([]);
      expect((await get(`/api/v1/transactions/${id}`, session)).status).toBe(404);
      expect(await transactionCount(p.portfolioId)).toBe(1);
      expect(await balanceOf(session, p.portfolioId, p.courant)).toBe("1000");
    });

    it("AC-568: two parallel PATCHes on the same tenant both succeed, serialised, and the posting and balance match the last write", async () => {
      const session = await dave();
      const p = await portfolioP(session);
      const id = await createFee(session, p);
      // Pre-warm: open the app's pooled connections before the race, so the
      // two PATCHes below are not serialised by lazy connection setup alone.
      await Promise.all([
        get(`/api/v1/transactions/${id}`, session),
        get(`/api/v1/transactions/${id}`, session),
      ]);

      const [first, second] = await Promise.all([
        patch(`/api/v1/transactions/${id}`, { grossAmount: "40.00" }, session),
        patch(`/api/v1/transactions/${id}`, { grossAmount: "50.00" }, session),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const reread = await get(`/api/v1/transactions/${id}`, session);
      const finalGross = new Decimal(reread.body.grossAmount);
      expect(["40", "50"]).toContain(finalGross.toString());
      const postings = await postingsOf(id);
      expect(postings).toHaveLength(1);
      expect(postings[0]!.slice(0, 2)).toEqual(["CASH", "FEE"]);
      expect(new Decimal(postings[0]![2]).negated().equals(finalGross)).toBe(true);
      expect(
        new Decimal(await balanceOf(session, p.portfolioId, p.courant)).equals(
          new Decimal("1000").minus(finalGross),
        ),
      ).toBe(true);
      // Exactly one UPDATE revision per PATCH: neither write was lost.
      const revisions = await testApp.ownerClient<{ n: number }[]>`
        select count(*)::int as n from transaction_revision
         where transaction_id = ${id}::uuid and revision_kind = 'UPDATE'`;
      expect(revisions[0]!.n).toBe(2);
    });
  });
});
