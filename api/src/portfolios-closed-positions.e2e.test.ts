import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { createUser } from "@kerdial/platform-auth";
import { cash, seedCashAccounts } from "@kerdial/platform-test-support";
import {
  instrument,
  instrumentPriceDaily,
  portfolio,
  tenant,
  transaction,
  type Db,
} from "@kerdial/platform-db";
import {
  MAX_CLOSED_POSITIONS_PER_VIEW,
  MAX_SALE_LOTS_PER_CLOSED_POSITION,
} from "@kerdial/valuation";
import { and, eq } from "drizzle-orm";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * **T-55 — Batch C's release gate** for the `closed-positions` cycle. This is where **AC-319 and
 * AC-320 get their official, spec-worded verification**: the spec frames both
 * around a `GET` read, and this file is the first place they are exercised as
 * one — through the real Nest/Fastify stack, the real interceptors, the real
 * response schema, against a real Postgres.
 *
 * Also gated here: AC-321 (multi-episode), AC-322 in both directions (including
 * CP-4's cross-portfolio trap), AC-326 (the response caps, at their **exact**
 * boundaries and on **both** routes), AC-327 (the throttle, in the shape that
 * distinguishes a concurrency cap from a rate cap) and AC33 (another tenant's
 * portfolio id is a 404).
 *
 * ## Why the fixtures are seeded through the database rather than over HTTP
 *
 * The subject here is the **read** surface. The arithmetic fixtures are T-47's
 * own, transcribed through T-52 (`valuation/src/closed-positions-valuation.
 * integration.test.ts`) together with their hand calculations — they pin
 * specific stored `fx_rate` values (0.90, 0.75, 0.85, 0.95, and a deliberate 0)
 * that `POST /transactions` resolves for itself and would not accept as given.
 * Same choice, same reason, as the Batch B suite: the write path is proven in
 * its own suites, and every expected figure below is still the hand-derived
 * one, never a capture of this path's own output.
 *
 * The cap fixtures are seeded that way for a second reason. T-51's own
 * out-of-scope note says the exact-boundary proof needs 1000/1001 **real** rows,
 * and `responseCapOverrides` is deliberately unreachable over HTTP (the
 * `dividends.controller.ts` precedent). So the fixtures below really do build
 * 1001 closed positions and 1001 sale lots and run them through the **shipped**
 * constants — no override, no mocked engine, no fabricated error.
 */

/** ISO `YYYY-MM-DD` for today, UTC — what both new routes use as their `asOfDate`. Every fixture below therefore trades in the past. */
const TODAY = new Date().toISOString().slice(0, 10);

describe("api — /portfolios/{,:id/}closed-positions (T-55, Batch C release gate)", () => {
  let testApp: TestApp;
  let ownerDb: Db;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string, session: { sid: string }) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  /** Monotonic across every tenant in this file — `transaction_tenant_id_seq_key` only needs per-tenant uniqueness, and one counter is one fewer thing to get wrong. */
  let seq = 1n;
  let isinCounter = 0;

  interface Fixture {
    readonly tenantId: string;
    readonly session: { sid: string };
  }

  /**
   * A tenant with its own user and an open session. One per fixture group,
   * because the combined route fans out over **every** portfolio the tenant
   * owns: sharing a tenant between (say) the CP-4 fixture and the
   * 1001-position cap fixture would make each one's assertion depend on the
   * other's rows.
   */
  async function newFixture(label: string): Promise<Fixture> {
    const tenantId = randomUUID();
    const email = `${label}-${randomUUID()}@example.com`;
    const password = "correct horse battery staple closed positions";
    await ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password });
    const session = await loginAs(server(), email, password);
    return { tenantId, session };
  }

  async function newPortfolio(tenantId: string, name: string): Promise<string> {
    const id = randomUUID();
    await ownerDb.insert(portfolio).values({ id, tenantId, name: `${name} ${randomUUID()}` });
    await seedCashAccounts(ownerDb, tenantId, id);
    return id;
  }

  /** One row for the shared `instrument` catalogue. The ISIN is a uniqueness key only — nothing on this path validates its check digit. */
  function instrumentRow(displayName: string, listingCurrency = "EUR") {
    isinCounter += 1;
    return {
      id: randomUUID(),
      kind: "SHARE" as const,
      displayName,
      listingCurrency,
      exchangeMic: "XPAR",
      isin: `CP${String(isinCounter).padStart(10, "0")}`,
      primaryIdentifier: "ISIN" as const,
      quotePolicy: "AUTO" as const,
    };
  }

  async function newInstrument(displayName: string, listingCurrency = "EUR"): Promise<string> {
    const row = instrumentRow(displayName, listingCurrency);
    await ownerDb.insert(instrument).values(row);
    return row.id;
  }

  interface TradeSpec {
    readonly kind: "BUY" | "SELL";
    readonly tenantId: string;
    readonly portfolioId: string;
    readonly instrumentId: string;
    readonly tradeDate: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly currency?: string;
    readonly fxRate?: string;
  }

  /** The same directly-inserted BUY/SELL row `valuation`'s Batch B suite builds — see this file's header for why these bypass `TransactionWriteService`. */
  function tradeRow(spec: TradeSpec) {
    const currency = spec.currency ?? "EUR";
    const gross = new Decimal(spec.quantity).times(spec.unitPrice);
    const s = seq;
    seq += 1n;
    return {
      id: randomUUID(),
      tenantId: spec.tenantId,
      baseCurrency: "EUR",
      portfolioId: spec.portfolioId,
      kind: spec.kind,
      tradeDate: spec.tradeDate,
      seq: s,
      instrumentId: spec.instrumentId,
      quantity: new Decimal(spec.quantity),
      unitPrice: new Decimal(spec.unitPrice),
      grossAmount: gross,
      txnCurrency: currency,
      cashCurrency: currency,
      cashAmount: gross,
      cashAccountId: cash(spec.portfolioId, currency),
      fxRate: new Decimal(spec.fxRate ?? "1"),
      fxRateSource: "IMPLIED_BASE" as const,
    };
  }

  /** Chunked so a 2,000-row fixture stays well under Postgres' 65,535 bind-parameter ceiling. */
  async function insertTrades(specs: readonly TradeSpec[]): Promise<void> {
    const rows = specs.map(tradeRow);
    for (let i = 0; i < rows.length; i += 200) {
      await ownerDb.insert(transaction).values(rows.slice(i, i + 200));
    }
  }

  async function trade(spec: TradeSpec): Promise<void> {
    await insertTrades([spec]);
  }

  async function seedDailyPrice(
    instrumentId: string,
    priceDate: string,
    close: string,
    currency = "EUR",
  ): Promise<void> {
    await ownerDb.insert(instrumentPriceDaily).values({
      instrumentId,
      priceDate,
      closeRaw: new Decimal(close),
      currency,
      sourceKey: "yahoo",
      quality: "EOD",
    });
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    ownerDb = testApp.ownerDb;
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  // ==========================================================================
  // Route shape (FR-331) — mirrors `:id/holdings` / `holdings` exactly.
  // ==========================================================================

  describe("route shape (FR-331)", () => {
    it("GET /portfolios/closed-positions resolves to the combined view, not the :id route with id='closed-positions'", async () => {
      const { session } = await newFixture("routing");
      const response = await get("/api/v1/portfolios/closed-positions", session);
      // A `:id` route reaching `parseIdParam("closed-positions")` would 400.
      expect(response.status).not.toBe(400);
      expect(response.body.code).not.toBe("INVALID_ID");
      expect(response.status).toBe(200);
      expect(response.body.closedPositions).toEqual([]);
      expect(response.body.portfolioCount).toBe(0);
      expect(response.body.asOfDate).toBe(TODAY);
      // `bigint` never reaches JSON as a number.
      expect(typeof response.body.calcEpoch).toBe("string");
    });

    it("AC33 — another tenant's portfolio id is a 404, not a 403", async () => {
      const owner = await newFixture("ac33-owner");
      const stranger = await newFixture("ac33-stranger");
      const portfolioId = await newPortfolio(owner.tenantId, "AC33");

      const mine = await get(`/api/v1/portfolios/${portfolioId}/closed-positions`, owner.session);
      expect(mine.status).toBe(200);

      const theirs = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        stranger.session,
      );
      // Invisible, not merely forbidden.
      expect(theirs.status).toBe(404);
      expect(theirs.body.code).toBe("PORTFOLIO_NOT_FOUND");
    });

    it("rejects a malformed :id with 400 INVALID_ID, exactly as :id/holdings does", async () => {
      const { session } = await newFixture("bad-id");
      const response = await get("/api/v1/portfolios/not-a-uuid/closed-positions", session);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_ID");
    });
  });

  // ==========================================================================
  // AC-319 — the official release gate.
  // ==========================================================================

  /**
   * T-47's `CLOSED_KNOWN_ANSWER`, transcribed through T-52 (see
   * `core/domain/src/closed-positions.test.ts` for the full hand calculation):
   * a USD-listed instrument in a EUR-base portfolio, bought twice at two stored
   * FX rates and sold out in two legs.
   *
   *   Buy  100 @ 10   USD, fx 0.90 → cost_native 1000, cost_base  900
   *   Buy  200 @ 10   USD, fx 0.75 → cost_native 3000, cost_base 2400, pmp_base 8
   *   Sell 100 @ 12   USD, fx 0.85 → gain_base 220, gain_native  200, fx  60, disposed  800
   *   Sell 200 @  9.5 USD, fx 0.95 → gain_base 205, gain_native −100, fx 285, disposed 1600
   *
   *   Σ 425 base · 100 native · 345 fx · 2400 disposed cost basis
   */
  describe("AC-319 (RELEASE GATE) — the hand-computed totals over the wire, and simultaneous absence from holdings", () => {
    let fixture: Fixture;
    let portfolioId: string;
    let instrumentId: string;

    beforeAll(async () => {
      fixture = await newFixture("ac319");
      portfolioId = await newPortfolio(fixture.tenantId, "AC-319");
      instrumentId = await newInstrument("AC-319 known-answer share", "USD");

      for (const spec of [
        {
          kind: "BUY" as const,
          tradeDate: "2024-01-02",
          quantity: "100",
          unitPrice: "10",
          fxRate: "0.90",
        },
        {
          kind: "BUY" as const,
          tradeDate: "2024-02-02",
          quantity: "200",
          unitPrice: "10",
          fxRate: "0.75",
        },
        {
          kind: "SELL" as const,
          tradeDate: "2024-03-01",
          quantity: "100",
          unitPrice: "12",
          fxRate: "0.85",
        },
        {
          kind: "SELL" as const,
          tradeDate: "2024-04-01",
          quantity: "200",
          unitPrice: "9.5",
          fxRate: "0.95",
        },
      ]) {
        await trade({
          ...spec,
          tenantId: fixture.tenantId,
          portfolioId,
          instrumentId,
          currency: "USD",
        });
      }
    }, 60_000);

    it("the four totals match the hand-computed decimal strings exactly, AND the instrument is absent from :id/holdings for the same portfolio", async () => {
      const response = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      expect(response.status).toBe(200);
      expect(response.body.asOfDate).toBe(TODAY);
      expect(response.body.portfolioCount).toBe(1);
      expect(response.body.closedPositions).toHaveLength(1);

      const position = response.body.closedPositions[0];
      expect(position.instrumentId).toBe(instrumentId);

      // Hand-derived in T-47. Exact strings, no tolerance, asserted on the wire
      // representation rather than on a parsed number.
      expect(position.totalRealizedGainBase.amount).toBe("425");
      expect(position.totalRealizedGainNative.amount).toBe("100");
      expect(position.totalFxComponentBase.amount).toBe("345");
      expect(position.totalDisposedCostBasisBase.amount).toBe("2400");
      for (const key of [
        "totalRealizedGainBase",
        "totalRealizedGainNative",
        "totalFxComponentBase",
        "totalDisposedCostBasisBase",
      ] as const) {
        expect(typeof position[key].amount).toBe("string");
      }

      // AC-319's simultaneity clause, in the same test.
      const holdings = await get(`/api/v1/portfolios/${portfolioId}/holdings`, fixture.session);
      expect(holdings.status).toBe(200);
      expect(
        holdings.body.holdings.map((h: { instrumentId: string }) => h.instrumentId),
      ).not.toContain(instrumentId);
      // …and that absence is membership, not an empty response nobody looked at.
      expect(
        response.body.closedPositions.map((p: { instrumentId: string }) => p.instrumentId),
      ).toContain(instrumentId);
    });

    it("labels base figures with the ledger base and the native one with the instrument's listing currency (CP-3/A2)", async () => {
      const response = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      const position = response.body.closedPositions[0];
      expect(position.currency).toBe("USD");
      expect(position.totalRealizedGainBase.currency).toBe("EUR");
      expect(position.totalRealizedGainNative.currency).toBe("USD");
      expect(position.totalFxComponentBase.currency).toBe("EUR");
      expect(position.totalDisposedCostBasisBase.currency).toBe("EUR");
      expect(position.displayName).toBe("AC-319 known-answer share");
      expect(position.kind).toBe("SHARE");
      expect(position.hasIcon).toBe(false);
    });

    it("itemises both legs in wire order, with no eighth field and no server-computed percentage (FR-327/FR-329/FR-330/CP-9)", async () => {
      const response = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      const position = response.body.closedPositions[0];

      expect(position.realizedGains).toHaveLength(2);
      expect(position.realizedGains.map((g: { tradeDate: string }) => g.tradeDate)).toEqual([
        "2024-03-01",
        "2024-04-01",
      ]);
      expect(
        position.realizedGains.map((g: { gainBase: { amount: string } }) => g.gainBase.amount),
      ).toEqual(["220", "205"]);
      expect(Object.keys(position.realizedGains[0])).toEqual([
        "portfolioId",
        "tradeDate",
        "quantitySold",
        "gainBase",
        "gainNative",
        "fxComponentBase",
        "proceedsBase",
      ]);

      expect(Object.keys(position).sort()).toEqual([
        "currency",
        "displayName",
        "hasIcon",
        "instrumentId",
        "kind",
        "realizedGains",
        "totalDisposedCostBasisBase",
        "totalFxComponentBase",
        "totalRealizedGainBase",
        "totalRealizedGainNative",
      ]);
      expect(Object.keys(response.body).sort()).toEqual([
        "asOfDate",
        "calcEpoch",
        "closedPositions",
        "portfolioCount",
      ]);
    });

    // ------------------------------------------------------------------------
    // AC-327 — the throttle. Both halves live here because this is the fixture
    // with enough real work to keep a burst genuinely in flight.
    // ------------------------------------------------------------------------
  });

  // ==========================================================================
  // AC-320 — the official release gate for the degenerate denominator.
  // ==========================================================================

  /**
   * T-47's `DEGENERATE_DENOMINATOR`, transcribed: 50 units acquired at 4 USD
   * with a stored `fx_rate` of exactly 0, so `pmp_unit_base_at_sale` is zero
   * while `cost_basis_native` is not.
   *
   *   Sell 20 @ 6 USD, fx 0.9 → gain_base 108, gain_native 40, fx 108, disposed 0
   *   Sell 30 @ 5 USD, fx 0.8 → gain_base 120, gain_native 30, fx 120, disposed 0
   *   Σ 228 base · 70 native · 228 fx · **0** disposed cost basis
   */
  describe('AC-320 (RELEASE GATE) — a zero disposed cost basis reaches the wire as exactly "0"', () => {
    it("ships the raw zero denominator, never coerced to a fabricated non-zero value", async () => {
      const fixture = await newFixture("ac320");
      const portfolioId = await newPortfolio(fixture.tenantId, "AC-320");
      const instrumentId = await newInstrument("AC-320 degenerate share", "USD");

      for (const spec of [
        {
          kind: "BUY" as const,
          tradeDate: "2024-01-02",
          quantity: "50",
          unitPrice: "4",
          fxRate: "0",
        },
        {
          kind: "SELL" as const,
          tradeDate: "2024-02-02",
          quantity: "20",
          unitPrice: "6",
          fxRate: "0.9",
        },
        {
          kind: "SELL" as const,
          tradeDate: "2024-03-03",
          quantity: "30",
          unitPrice: "5",
          fxRate: "0.8",
        },
      ]) {
        await trade({
          ...spec,
          tenantId: fixture.tenantId,
          portfolioId,
          instrumentId,
          currency: "USD",
        });
      }

      const response = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      expect(response.status).toBe(200);
      const position = response.body.closedPositions.find(
        (p: { instrumentId: string }) => p.instrumentId === instrumentId,
      );
      expect(position).toBeDefined();

      // AC-320's server half in one line: the denominator on the wire is the
      // true figure. Not "0.00", not "1", not omitted, not NaN/Infinity (which
      // JSON cannot carry anyway) — the literal string "0".
      const denominator = position.totalDisposedCostBasisBase.amount;
      expect(denominator).toBe("0");
      expect(typeof denominator).toBe("string");

      // …and the numerator is a real, finite figure, so a client rendering `—`
      // does so because the *ratio* is undefined, not because the server sent
      // it nothing. The `—`-not-`0 %`-not-`∞` rendering itself is T-57/T-60's,
      // deliberately out of scope here.
      expect(position.totalRealizedGainBase.amount).toBe("228");
      expect(position.totalRealizedGainNative.amount).toBe("70");
      expect(position.totalFxComponentBase.amount).toBe("228");

      // The same figure, unchanged, through the combined route.
      const combined = await get("/api/v1/portfolios/closed-positions", fixture.session);
      expect(combined.status).toBe(200);
      const merged = combined.body.closedPositions.find(
        (p: { instrumentId: string }) => p.instrumentId === instrumentId,
      );
      expect(merged.totalDisposedCostBasisBase.amount).toBe("0");
      expect(merged.totalRealizedGainBase.amount).toBe("228");
    });
  });

  // ==========================================================================
  // AC-321 / AC-322 — through the real endpoints.
  // ==========================================================================

  /**
   * T-47's `MULTI_EPISODE`: bought, sold out, bought again, sold out again. One
   * running position, therefore one entry — no episode segmentation anywhere.
   *
   *   Σ 172 base · 40 native · 192 fx · 1700 disposed cost basis, two legs.
   */
  describe("AC-321 — a re-bought-and-re-sold instrument is ONE entry carrying every leg", () => {
    it("returns one closed position whose legs and totals span both episodes", async () => {
      const fixture = await newFixture("ac321");
      const portfolioId = await newPortfolio(fixture.tenantId, "AC-321");
      const instrumentId = await newInstrument("AC-321 multi-episode share", "USD");

      for (const spec of [
        {
          kind: "BUY" as const,
          tradeDate: "2023-01-10",
          quantity: "10",
          unitPrice: "100",
          fxRate: "0.5",
        },
        {
          kind: "SELL" as const,
          tradeDate: "2023-06-10",
          quantity: "10",
          unitPrice: "120",
          fxRate: "0.6",
        },
        {
          kind: "BUY" as const,
          tradeDate: "2024-02-01",
          quantity: "20",
          unitPrice: "80",
          fxRate: "0.75",
        },
        {
          kind: "SELL" as const,
          tradeDate: "2024-09-01",
          quantity: "20",
          unitPrice: "72",
          fxRate: "0.8",
        },
      ]) {
        await trade({
          ...spec,
          tenantId: fixture.tenantId,
          portfolioId,
          instrumentId,
          currency: "USD",
        });
      }

      const response = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      expect(response.status).toBe(200);
      expect(response.body.closedPositions).toHaveLength(1);

      const position = response.body.closedPositions[0];
      expect(position.realizedGains).toHaveLength(2);
      expect(position.realizedGains.map((g: { tradeDate: string }) => g.tradeDate)).toEqual([
        "2023-06-10",
        "2024-09-01",
      ]);
      expect(position.totalRealizedGainBase.amount).toBe("172");
      expect(position.totalRealizedGainNative.amount).toBe("40");
      expect(position.totalFxComponentBase.amount).toBe("192");
      expect(position.totalDisposedCostBasisBase.amount).toBe("1700");
    });
  });

  describe("AC-322 (per-portfolio half) — sold to zero then re-bought in the SAME portfolio", () => {
    it("is absent from closed-positions and present on holdings", async () => {
      const fixture = await newFixture("ac322-same");
      const portfolioId = await newPortfolio(fixture.tenantId, "AC-322 same");
      const instrumentId = await newInstrument("AC-322 re-bought share");
      await seedDailyPrice(instrumentId, "2024-05-01", "70");

      for (const spec of [
        { kind: "BUY" as const, tradeDate: "2024-01-10", quantity: "10", unitPrice: "50" },
        { kind: "SELL" as const, tradeDate: "2024-02-10", quantity: "10", unitPrice: "60" },
        { kind: "BUY" as const, tradeDate: "2024-03-10", quantity: "4", unitPrice: "65" },
      ]) {
        await trade({ ...spec, tenantId: fixture.tenantId, portfolioId, instrumentId });
      }

      const closed = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      const open = await get(`/api/v1/portfolios/${portfolioId}/holdings`, fixture.session);
      expect(closed.status).toBe(200);
      expect(open.status).toBe(200);

      expect(
        closed.body.closedPositions.map((p: { instrumentId: string }) => p.instrumentId),
      ).not.toContain(instrumentId);
      expect(open.body.holdings.map((h: { instrumentId: string }) => h.instrumentId)).toContain(
        instrumentId,
      );
      // NG6: the pre-re-purchase disposal leg is not lost — it stays on the
      // still-open holding, exactly where it already was before this feature.
      expect(
        open.body.holdings.find((h: { instrumentId: string }) => h.instrumentId === instrumentId)
          .realizedGains,
      ).toHaveLength(1);
    });
  });

  describe("AC-322 / CP-4 (the cross-portfolio trap) — closed in A, still open in B", () => {
    it("is absent from GET /portfolios/closed-positions entirely and present as one merged line on GET /portfolios/holdings", async () => {
      const fixture = await newFixture("cp4");
      const portfolioA = await newPortfolio(fixture.tenantId, "CP-4 A");
      const portfolioB = await newPortfolio(fixture.tenantId, "CP-4 B");
      const crossId = await newInstrument("CP-4 cross-portfolio share");
      const soloId = await newInstrument("CP-4 genuinely closed share");
      await seedDailyPrice(crossId, "2024-05-01", "70");
      await seedDailyPrice(soloId, "2024-05-01", "70");

      await insertTrades([
        // X: fully sold in A …
        {
          kind: "BUY",
          tenantId: fixture.tenantId,
          portfolioId: portfolioA,
          instrumentId: crossId,
          tradeDate: "2024-01-10",
          quantity: "10",
          unitPrice: "50",
        },
        {
          kind: "SELL",
          tenantId: fixture.tenantId,
          portfolioId: portfolioA,
          instrumentId: crossId,
          tradeDate: "2024-02-10",
          quantity: "10",
          unitPrice: "60",
        },
        // … and still open in B, same tenant.
        {
          kind: "BUY",
          tenantId: fixture.tenantId,
          portfolioId: portfolioB,
          instrumentId: crossId,
          tradeDate: "2024-01-20",
          quantity: "6",
          unitPrice: "55",
        },
        // A control instrument, closed in A and traded nowhere else, so the
        // absence asserted below is membership and not an empty response.
        {
          kind: "BUY",
          tenantId: fixture.tenantId,
          portfolioId: portfolioA,
          instrumentId: soloId,
          tradeDate: "2024-01-11",
          quantity: "8",
          unitPrice: "20",
        },
        {
          kind: "SELL",
          tenantId: fixture.tenantId,
          portfolioId: portfolioA,
          instrumentId: soloId,
          tradeDate: "2024-02-11",
          quantity: "8",
          unitPrice: "30",
        },
      ]);

      const combinedClosed = await get("/api/v1/portfolios/closed-positions", fixture.session);
      const combinedOpen = await get("/api/v1/portfolios/holdings", fixture.session);
      expect(combinedClosed.status).toBe(200);
      expect(combinedOpen.status).toBe(200);

      // The trap: X is open somewhere, so it is a closed position nowhere.
      expect(
        combinedClosed.body.closedPositions.map((p: { instrumentId: string }) => p.instrumentId),
      ).toEqual([soloId]);
      // …while the open view shows it as exactly one merged line.
      const openLines = combinedOpen.body.holdings.filter(
        (h: { instrumentId: string }) => h.instrumentId === crossId,
      );
      expect(openLines).toHaveLength(1);
      expect(openLines[0].quantity).toBe("6");

      // CP-4 is a *combined*-level membership rule: the per-portfolio route
      // still reports X as closed in A.
      const perPortfolioA = await get(
        `/api/v1/portfolios/${portfolioA}/closed-positions`,
        fixture.session,
      );
      expect(
        perPortfolioA.body.closedPositions
          .map((p: { instrumentId: string }) => p.instrumentId)
          .sort(),
      ).toEqual([crossId, soloId].sort());

      // L5: both tenant-wide responses key off the identical epoch rule, so one
      // freshness check covers the pair.
      expect(combinedClosed.body.calcEpoch).toBe(combinedOpen.body.calcEpoch);
      expect(combinedClosed.body.portfolioCount).toBe(2);
    });
  });

  // ==========================================================================
  // AC-326 — the caps, at their exact boundaries, on both routes.
  // ==========================================================================

  /**
   * Real rows at the real, shipped constants — no `responseCapOverrides` (which
   * is deliberately unreachable over HTTP) and no mocked engine.
   *
   * **Reject, never truncate**, is asserted from both sides: one fixture one
   * past the cap must produce a distinct 4xx with the feature's own code and
   * **no** `closedPositions` array at all, and a second fixture exactly on the
   * cap must produce a 200 carrying the array in full. A truncating
   * implementation fails the first; an implementation that rejects a row too
   * early fails the second.
   */
  describe("AC-326 — the caps reject at 1001 and serve in full at 1000, on BOTH routes", () => {
    /** 1001 catalogue rows, inserted once and reused by both position-count fixtures (they live in different tenants; `instrument` is a shared, tenant-less catalogue). */
    let capInstrumentIds: string[];

    beforeAll(async () => {
      const rows = Array.from({ length: MAX_CLOSED_POSITIONS_PER_VIEW + 1 }, (_, i) =>
        instrumentRow(`cap share ${i}`),
      );
      for (let i = 0; i < rows.length; i += 200) {
        await ownerDb.insert(instrument).values(rows.slice(i, i + 200));
      }
      capInstrumentIds = rows.map((row) => row.id);
    }, 120_000);

    /** One fully-closed round trip per instrument, in one portfolio. */
    function closedRoundTrips(
      tenantId: string,
      portfolioId: string,
      instrumentIds: readonly string[],
    ): TradeSpec[] {
      return instrumentIds.flatMap((instrumentId) => [
        {
          kind: "BUY" as const,
          tenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-01-05",
          quantity: "5",
          unitPrice: "10",
        },
        {
          kind: "SELL" as const,
          tenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2024-02-05",
          quantity: "5",
          unitPrice: "12",
        },
      ]);
    }

    /**
     * `n` one-unit sale lots closing out one instrument in one portfolio.
     *
     * Lot dates cycle through a fixed 300-day window rather than marching
     * forward one per lot: 1001 consecutive days would push the last lots past
     * `todayIsoDate()` (where the routes truncate) as the calendar advances, and
     * a fixture that decays into a different fixture over time is worse than no
     * fixture. Cycling also makes the two portfolios' lot runs genuinely
     * **interleave**, which is what gives CP-10's merged chronological sort
     * something to prove.
     */
    function saleLots(
      tenantId: string,
      portfolioId: string,
      instrumentId: string,
      n: number,
    ): TradeSpec[] {
      const lots: TradeSpec[] = [
        {
          kind: "BUY",
          tenantId,
          portfolioId,
          instrumentId,
          tradeDate: "2020-01-01",
          quantity: String(n),
          unitPrice: "10",
        },
      ];
      for (let i = 0; i < n; i += 1) {
        const date = new Date(Date.UTC(2021, 0, 1));
        date.setUTCDate(date.getUTCDate() + (i % 300));
        lots.push({
          kind: "SELL",
          tenantId,
          portfolioId,
          instrumentId,
          tradeDate: date.toISOString().slice(0, 10),
          quantity: "1",
          unitPrice: "12",
        });
      }
      return lots;
    }

    function expectTooLarge(response: { status: number; body: Record<string, unknown> }): void {
      // A distinct 4xx with this feature's own machine-readable code — never a
      // 500, never the holdings cap's `VALUATION_RESPONSE_TOO_LARGE`, and never
      // a 200 carrying a quietly truncated array.
      expect(response.status).toBe(422);
      expect(response.body["code"]).toBe("CLOSED_POSITIONS_RESPONSE_TOO_LARGE");
      expect(response.body["title"]).toBe("Closed-positions response too large");
      expect(response.body["closedPositions"]).toBeUndefined();
      expect(typeof response.body["detail"]).toBe("string");
    }

    it(`MAX_CLOSED_POSITIONS_PER_VIEW on GET /portfolios/:id/closed-positions — ${MAX_CLOSED_POSITIONS_PER_VIEW + 1} refused, ${MAX_CLOSED_POSITIONS_PER_VIEW} served whole`, async () => {
      const fixture = await newFixture("cap-positions-single");
      const portfolioId = await newPortfolio(fixture.tenantId, "cap positions single");
      await insertTrades(closedRoundTrips(fixture.tenantId, portfolioId, capInstrumentIds));

      const overCap = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      expectTooLarge(overCap);
      expect(overCap.body.detail).toContain(String(MAX_CLOSED_POSITIONS_PER_VIEW + 1));

      // Exactly one instrument's whole round trip removed — the only difference
      // between the refusal above and the success below is that one position.
      await ownerDb
        .delete(transaction)
        .where(
          and(
            eq(transaction.tenantId, fixture.tenantId),
            eq(transaction.instrumentId, capInstrumentIds[0]!),
          ),
        );

      const atCap = await get(
        `/api/v1/portfolios/${portfolioId}/closed-positions`,
        fixture.session,
      );
      expect(atCap.status).toBe(200);
      expect(atCap.body.closedPositions).toHaveLength(MAX_CLOSED_POSITIONS_PER_VIEW);
    }, 300_000);

    it("MAX_CLOSED_POSITIONS_PER_VIEW on GET /portfolios/closed-positions — the MERGED count is what is checked", async () => {
      const fixture = await newFixture("cap-positions-combined");
      const portfolioA = await newPortfolio(fixture.tenantId, "cap positions A");
      const portfolioB = await newPortfolio(fixture.tenantId, "cap positions B");
      const half = Math.floor((MAX_CLOSED_POSITIONS_PER_VIEW + 1) / 2);
      const inA = capInstrumentIds.slice(0, half);
      const inB = capInstrumentIds.slice(half);
      await insertTrades(closedRoundTrips(fixture.tenantId, portfolioA, inA));
      await insertTrades(closedRoundTrips(fixture.tenantId, portfolioB, inB));

      // Neither portfolio alone is anywhere near the cap …
      for (const [portfolioId, expected] of [
        [portfolioA, inA.length],
        [portfolioB, inB.length],
      ] as const) {
        const perPortfolio = await get(
          `/api/v1/portfolios/${portfolioId}/closed-positions`,
          fixture.session,
        );
        expect(perPortfolio.status).toBe(200);
        expect(perPortfolio.body.closedPositions).toHaveLength(expected);
      }

      // … but the merged view is one past it.
      const overCap = await get("/api/v1/portfolios/closed-positions", fixture.session);
      expectTooLarge(overCap);
      expect(overCap.body.detail).toContain(String(MAX_CLOSED_POSITIONS_PER_VIEW + 1));

      await ownerDb
        .delete(transaction)
        .where(
          and(
            eq(transaction.tenantId, fixture.tenantId),
            eq(transaction.instrumentId, inB[inB.length - 1]!),
          ),
        );

      const atCap = await get("/api/v1/portfolios/closed-positions", fixture.session);
      expect(atCap.status).toBe(200);
      expect(atCap.body.closedPositions).toHaveLength(MAX_CLOSED_POSITIONS_PER_VIEW);
      expect(atCap.body.portfolioCount).toBe(2);
    }, 300_000);

    it(`MAX_SALE_LOTS_PER_CLOSED_POSITION on GET /portfolios/:id/closed-positions — ${MAX_SALE_LOTS_PER_CLOSED_POSITION + 1} lots refused, ${MAX_SALE_LOTS_PER_CLOSED_POSITION} served whole`, async () => {
      const fixture = await newFixture("cap-lots-single");
      // Two portfolios rather than one mutated fixture: dropping a lot from a
      // 1001-lot position would leave one unit unsold, which makes the position
      // *open* — a 200 with zero closed positions would then "pass" a
      // carelessly-written at-cap assertion for entirely the wrong reason.
      const overPortfolio = await newPortfolio(fixture.tenantId, "cap lots 1001");
      const atPortfolio = await newPortfolio(fixture.tenantId, "cap lots 1000");
      const overInstrument = await newInstrument("cap lots share (1001)");
      const atInstrument = await newInstrument("cap lots share (1000)");
      await insertTrades(
        saleLots(
          fixture.tenantId,
          overPortfolio,
          overInstrument,
          MAX_SALE_LOTS_PER_CLOSED_POSITION + 1,
        ),
      );
      await insertTrades(
        saleLots(fixture.tenantId, atPortfolio, atInstrument, MAX_SALE_LOTS_PER_CLOSED_POSITION),
      );

      const overCap = await get(
        `/api/v1/portfolios/${overPortfolio}/closed-positions`,
        fixture.session,
      );
      expectTooLarge(overCap);
      // Under CP-5's single shared code, `detail` is what distinguishes the two
      // error classes — for this cap it names the instrument.
      expect(overCap.body.detail).toContain(overInstrument);
      expect(overCap.body.detail).toContain(String(MAX_SALE_LOTS_PER_CLOSED_POSITION + 1));

      const atCap = await get(
        `/api/v1/portfolios/${atPortfolio}/closed-positions`,
        fixture.session,
      );
      expect(atCap.status).toBe(200);
      expect(atCap.body.closedPositions).toHaveLength(1);
      expect(atCap.body.closedPositions[0].realizedGains).toHaveLength(
        MAX_SALE_LOTS_PER_CLOSED_POSITION,
      );
    }, 300_000);

    it("R6 — MAX_SALE_LOTS_PER_CLOSED_POSITION on GET /portfolios/closed-positions, exceeded only in COMBINATION", async () => {
      const over = await newFixture("cap-lots-combined-over");
      const overA = await newPortfolio(over.tenantId, "R6 over A");
      const overB = await newPortfolio(over.tenantId, "R6 over B");
      const overInstrument = await newInstrument("R6 merged-lot share (1001)");
      const inA = Math.floor((MAX_SALE_LOTS_PER_CLOSED_POSITION + 1) / 2);
      const inB = MAX_SALE_LOTS_PER_CLOSED_POSITION + 1 - inA;
      await insertTrades(saleLots(over.tenantId, overA, overInstrument, inA));
      await insertTrades(saleLots(over.tenantId, overB, overInstrument, inB));

      // Neither portfolio alone exceeds the per-position cap …
      for (const [portfolioId, expected] of [
        [overA, inA],
        [overB, inB],
      ] as const) {
        const perPortfolio = await get(
          `/api/v1/portfolios/${portfolioId}/closed-positions`,
          over.session,
        );
        expect(perPortfolio.status).toBe(200);
        expect(perPortfolio.body.closedPositions[0].realizedGains).toHaveLength(expected);
      }

      // … but the merged list is, and the combined route is where R6 says that
      // has to be caught.
      const overCap = await get("/api/v1/portfolios/closed-positions", over.session);
      expectTooLarge(overCap);
      expect(overCap.body.detail).toContain(overInstrument);
      expect(overCap.body.detail).toContain(String(MAX_SALE_LOTS_PER_CLOSED_POSITION + 1));

      // The exactly-at-cap half, in its own tenant so the merge is genuine.
      const at = await newFixture("cap-lots-combined-at");
      const atA = await newPortfolio(at.tenantId, "R6 at A");
      const atB = await newPortfolio(at.tenantId, "R6 at B");
      const atInstrument = await newInstrument("R6 merged-lot share (1000)");
      const halfAt = MAX_SALE_LOTS_PER_CLOSED_POSITION / 2;
      await insertTrades(saleLots(at.tenantId, atA, atInstrument, halfAt));
      await insertTrades(saleLots(at.tenantId, atB, atInstrument, halfAt));

      const atCap = await get("/api/v1/portfolios/closed-positions", at.session);
      expect(atCap.status).toBe(200);
      expect(atCap.body.closedPositions).toHaveLength(1);
      expect(atCap.body.closedPositions[0].realizedGains).toHaveLength(
        MAX_SALE_LOTS_PER_CLOSED_POSITION,
      );
      // CP-10: the merged lots come back chronologically, interleaved across
      // both portfolios rather than concatenated portfolio by portfolio.
      const dates: string[] = atCap.body.closedPositions[0].realizedGains.map(
        (g: { tradeDate: string }) => g.tradeDate,
      );
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBeGreaterThan(1);
    }, 300_000);
  });
});
