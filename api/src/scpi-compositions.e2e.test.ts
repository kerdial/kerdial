import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketRuntime } from "@kerdial/market-composition";
import { createUser } from "@kerdial/platform-auth";
import { instrument, tenant, transaction, type Db } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `scpi` cycle, independent tester pass — the compositions no per-task test
 * crosses, over real HTTP as the real `app_web` role. Every figure is a
 * hand-computed one (10 parts at 250.00, then a prix de part of 260.00 from
 * 2026-06-01) or an equality with a `MANUAL_ONLY` FUND given the same history
 * (the AC-503 comparand, here through the routes instead of the valuation
 * package). Only past dates and no staleness assertion, so nothing here
 * changes with the calendar.
 *
 * Two apps: one with no `MARKET_RUNTIME` (the ledger compositions) and one
 * with a recording runtime (every entry point that could reach a provider).
 */

const TENANT_A = "00000000-0000-7000-8000-000000511a01";
const TENANT_B = "00000000-0000-7000-8000-000000511a02";
const TENANT_RT = "00000000-0000-7000-8000-000000511a03";
const PASSWORD = "correct horse battery staple scpi compositions";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

/** Replaces each identity string by a placeholder, so an SCPI body and a FUND body can be compared. */
function withoutIdentity(value: unknown, identity: readonly string[]): unknown {
  let text = JSON.stringify(value);
  for (const needle of identity) text = text.split(needle).join("<id>");
  // The comparand FUND has a MIC (XPAR), so a listing country; an unlisted SCPI has none.
  return JSON.parse(
    text
      .replace(/"kind":"(SCPI|FUND)"/g, '"kind":"<kind>"')
      .replace(/"listingCountry":"FR"/g, '"listingCountry":null'),
  );
}

function serverOf(app: TestApp) {
  return supertest(app.built.app.getHttpServer());
}

function client(app: TestApp, session: () => Session) {
  const cookies = (write: boolean) =>
    write
      ? [`${SID_COOKIE_NAME}=${session().sid}`, `${CSRF_COOKIE_NAME}=${session().csrf}`]
      : [`${SID_COOKIE_NAME}=${session().sid}`];
  const send = (method: "post" | "patch" | "delete" | "put", path: string) =>
    serverOf(app)[method](path).set("Cookie", cookies(true)).set(CSRF_HEADER_NAME, session().csrf);
  return {
    get: (path: string) => serverOf(app).get(path).set("Cookie", cookies(false)),
    post: (path: string, body: Record<string, unknown> = {}) => send("post", path).send(body),
    patch: (path: string, body: Record<string, unknown>) => send("patch", path).send(body),
    put: (path: string, body: Record<string, unknown>) => send("put", path).send(body),
    del: (path: string) => send("delete", path),
    upload: (path: string, file: Buffer, mode: string, filename = "kerdial-instruments.json") => {
      const request = serverOf(app)
        .post(path)
        .set("Cookie", cookies(true))
        .set(CSRF_HEADER_NAME, session().csrf)
        .attach("file", file, {
          filename,
          contentType: filename.endsWith(".csv") ? "text/csv" : "application/json",
        })
        .field("mode", mode);
      return request;
    },
  };
}

async function addUser(app: TestApp, tenantId: string, label: string): Promise<Session> {
  await app.ownerDb.insert(tenant).values({ id: tenantId });
  const email = `scpi-comp-${label}-${randomUUID()}@example.com`;
  await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
  return loginAs(serverOf(app), email, PASSWORD);
}

describe("api — SCPI compositions across the ledger and valuation routes (no provider runtime)", () => {
  let app: TestApp;
  let ownerDb: Db;
  let sessionA: Session;
  let sessionB: Session;
  let a: ReturnType<typeof client>;
  let b: ReturnType<typeof client>;

  let scpi: string;
  let fund: string;
  let pScpi: string;
  let pFund: string;
  let pScpi2: string;

  async function newPortfolio(name: string): Promise<string> {
    const created = await a.post("/api/v1/portfolios", { name });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    await seedCashAccountsForPortfolio(ownerDb, id);
    return id;
  }

  async function record(body: Record<string, unknown>): Promise<void> {
    const written = await a.post("/api/v1/transactions", body);
    expect(written.status, written.text).toBe(201);
  }

  const buyBody = (portfolioId: string, instrumentId: string) => ({
    kind: "BUY",
    portfolioId,
    instrumentId,
    tradeDate: "2026-01-05",
    quantity: "10",
    unitPrice: "250",
    currency: "EUR",
    cashAccountId: cash(portfolioId, "EUR"),
  });

  beforeAll(async () => {
    app = await startTestApp();
    ownerDb = app.ownerDb;
    sessionA = await addUser(app, TENANT_A, "a");
    sessionB = await addUser(app, TENANT_B, "b");
    a = client(app, () => sessionA);
    b = client(app, () => sessionB);

    // The SCPI goes through the real create route; the comparand FUND is
    // MANUAL_ONLY by direct insert (the create path makes a FUND AUTO since ADR-0018).
    const created = await a.post("/api/v1/instruments", {
      kind: "SCPI",
      isin: "FR0014SCPIJ7",
      symbol: "CORUMCMP",
      listingCurrency: "EUR",
      displayName: "Corum Origin",
      managementCompany: "Corum AM",
      subscriptionFeePct: "8.5",
    });
    expect(created.status, created.text).toBe(201);
    scpi = created.body.id as string;
    fund = randomUUID();
    await ownerDb.insert(instrument).values({
      id: fund,
      kind: "FUND",
      displayName: "Manual fund comparand",
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      symbol: "CMPFUND",
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
    });

    pScpi = await newPortfolio("SCPI portfolio");
    pFund = await newPortfolio("FUND portfolio");
    pScpi2 = await newPortfolio("SCPI second portfolio");
    for (const portfolioId of [pScpi, pFund, pScpi2]) {
      await record({
        kind: "DEPOSIT",
        portfolioId,
        tradeDate: "2026-01-02",
        amount: "10000",
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      });
    }
    await record(buyBody(pScpi, scpi));
    await record(buyBody(pFund, fund));
  }, 180_000);

  afterAll(async () => {
    await app.stop();
  }, 30_000);

  it("a held SCPI with no price is the same 422 as a MANUAL_ONLY FUND with no price, suggestion included, on every figure route", async () => {
    for (const route of ["holdings", "overview"] as const) {
      const s = await a.get(`/api/v1/portfolios/${pScpi}/${route}`);
      const f = await a.get(`/api/v1/portfolios/${pFund}/${route}`);
      expect(s.status, `${route}: ${s.text}`).toBe(422);
      expect(s.body.code).toBe("VALUATION_PRICE_UNAVAILABLE");
      expect(s.body.suggestedPrice).toEqual({ date: "2026-01-05", close: "250", currency: "EUR" });
      expect(withoutIdentity(s.body, [scpi, "Corum Origin", "CORUMCMP"])).toEqual(
        withoutIdentity(f.body, [fund, "Manual fund comparand", "CMPFUND"]),
      );
    }
    const series = await a.get(
      `/api/v1/portfolios/${pScpi}/value-series?from=2026-01-01&to=2026-02-01`,
    );
    expect(series.status).toBe(422);
    expect(series.body.code).toBe("VALUATION_PRICE_UNAVAILABLE");
  });

  it("manual prices, a distribution, then every figure route: 2500 then 2600, MANUAL_PRICE, equal to the FUND's apart from identity", async () => {
    for (const instrumentId of [scpi, fund]) {
      for (const [priceDate, close] of [
        ["2026-01-05", "250.00"],
        ["2026-06-01", "260.00"],
      ]) {
        const priced = await a.post(`/api/v1/instruments/${instrumentId}/prices`, {
          priceDate,
          close,
          currency: "EUR",
        });
        expect(priced.status, priced.text).toBe(201);
      }
    }
    for (const [portfolioId, instrumentId] of [
      [pScpi, scpi],
      [pFund, fund],
    ] as const) {
      await record({
        kind: "DIVIDEND",
        portfolioId,
        instrumentId,
        tradeDate: "2026-03-31",
        amount: "12.50",
        currency: "EUR",
        cashAccountId: cash(portfolioId, "EUR"),
      });
    }

    const holdings = await a.get(`/api/v1/portfolios/${pScpi}/holdings`);
    expect(holdings.status, holdings.text).toBe(200);
    expect(holdings.body.holdings).toHaveLength(1);
    const [held] = holdings.body.holdings;
    expect(held.kind).toBe("SCPI");
    expect(held.quantity).toBe("10");
    expect(held.currentValue.amount).toBe("2600");
    expect(held.currentValue.provenance.derivedFrom).toContain("MANUAL_PRICE");
    expect(held.unrealizedGainLoss.amount).toBe("100");

    // LOCF on the Performance series: holdings 2500 between the two prix de
    // part, 2600 from the second — plus the cash (portfolio-cash PC-L1): the
    // 7 500 the 10 000 deposit left after the BUY, and the 12.50 distribution
    // dated 03-31 from 04-01 on.
    const series = await a.get(
      `/api/v1/portfolios/${pScpi}/value-series?from=2026-01-01&to=2026-07-01`,
    );
    expect(series.status, series.text).toBe(200);
    const valueOn = (date: string) =>
      (series.body.points as { date: string; value: string }[]).find((p) => p.date === date)?.value;
    expect(valueOn("2026-03-01")).toBe("10000");
    expect(valueOn("2026-06-01")).toBe("10112.5");
    expect(valueOn("2026-06-30")).toBe("10112.5");

    // The whole of each route's body is the FUND's, apart from identity.
    for (const route of [
      "holdings",
      "overview",
      "value-series?from=2026-01-01&to=2026-07-01",
      "closed-positions",
    ]) {
      const s = await a.get(`/api/v1/portfolios/${pScpi}/${route}`);
      const f = await a.get(`/api/v1/portfolios/${pFund}/${route}`);
      expect(s.status, `${route}: ${s.text}`).toBe(200);
      expect(withoutIdentity(s.body, [scpi, pScpi, "Corum Origin", "CORUMCMP"]), route).toEqual(
        withoutIdentity(f.body, [fund, pFund, "Manual fund comparand", "CMPFUND"]),
      );
    }
  });

  it("a security transfer carries the SCPI's cost, not its prix de part; a SELL of the whole transferred position closes it with the hand-computed gain", async () => {
    // 4 of the 10 parts (bought at 250.00) go to the second portfolio; the 1 040 market value on the row is NOT the carried cost.
    await record({
      kind: "TRANSFER_OUT",
      portfolioId: pScpi,
      destinationPortfolioId: pScpi2,
      instrumentId: scpi,
      tradeDate: "2026-07-01",
      quantity: "4",
      amount: "1040",
      currency: "EUR",
    });
    const target = await a.get(`/api/v1/portfolios/${pScpi2}/holdings`);
    expect(target.status, target.text).toBe(200);
    expect(target.body.holdings).toHaveLength(1);
    expect(target.body.holdings[0].quantity).toBe("4");
    expect(target.body.holdings[0].costBasis.amount).toBe("1000");
    expect(target.body.holdings[0].currentValue.amount).toBe("1040");
    const source = await a.get(`/api/v1/portfolios/${pScpi}/holdings`);
    expect(source.body.holdings[0].quantity).toBe("6");
    expect(source.body.holdings[0].costBasis.amount).toBe("1500");

    await record({
      kind: "SELL",
      portfolioId: pScpi2,
      instrumentId: scpi,
      tradeDate: "2026-08-01",
      quantity: "4",
      unitPrice: "260",
      currency: "EUR",
      cashAccountId: cash(pScpi2, "EUR"),
    });
    const closed = await a.get(`/api/v1/portfolios/${pScpi2}/closed-positions`);
    expect(closed.status, closed.text).toBe(200);
    expect(closed.body.closedPositions).toHaveLength(1);
    expect(closed.body.closedPositions[0].kind).toBe("SCPI");
    // 4 x (260 - 250), on the carried cost of 1000.
    expect(closed.body.closedPositions[0].totalRealizedGainBase.amount).toBe("40");
    expect(closed.body.closedPositions[0].totalDisposedCostBasisBase.amount).toBe("1000");
    const after = await a.get(`/api/v1/portfolios/${pScpi2}/holdings`);
    expect(after.body.holdings).toEqual([]);
  });

  it("archiving the portfolio holding the SCPI moves no tenant-wide figure, and the instrument cannot be deleted while the ledger references it", async () => {
    const before = await a.get("/api/v1/portfolios/holdings");
    expect(before.status, before.text).toBe(200);
    const archived = await a.patch(`/api/v1/portfolios/${pScpi}`, { archived: true });
    expect(archived.status, archived.text).toBe(200);
    const after = await a.get("/api/v1/portfolios/holdings");
    expect(after.body).toEqual(before.body);
    expect(after.body.holdings.map((h: { kind: string }) => h.kind)).toContain("SCPI");

    const blocked = await a.del(`/api/v1/instruments/${scpi}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("INSTRUMENT_DELETE_BLOCKED_BY_LEDGER");
    // The counts are the ledger's own, not the foreign-key fallback's (which names none).
    expect(blocked.body.params).toMatchObject({ holdings: 1, realizedGains: 1 });
    expect(blocked.body.params.transactions).toBeGreaterThan(0);
    expect((await a.get(`/api/v1/instruments/${scpi}`)).status).toBe(200);
  });

  it("the distribution reaches Dividendes like the FUND's", async () => {
    const s = await a.get(`/api/v1/dividends/summary?portfolio=${pScpi}`);
    const f = await a.get(`/api/v1/dividends/summary?portfolio=${pFund}`);
    expect(s.status, s.text).toBe(200);
    expect(s.body.total).toEqual({ grossBase: "12.5", withholdingBase: "0" });
    expect(s.body.months).toEqual([{ period: "2026-03", grossBase: "12.5", withholdingBase: "0" }]);
    expect(withoutIdentity(s.body, [scpi, pScpi, "Corum Origin", "CORUMCMP"])).toEqual(
      withoutIdentity(f.body, [fund, pFund, "Manual fund comparand", "CMPFUND"]),
    );
  });

  it("an unreferenced SCPI can be deleted (204) and is then gone, its dedupe key free again", async () => {
    const created = await a.post("/api/v1/instruments", {
      kind: "SCPI",
      symbol: "DELETEME",
      listingCurrency: "EUR",
      displayName: "Unreferenced SCPI",
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    const priced = await a.post(`/api/v1/instruments/${id}/prices`, {
      priceDate: "2026-01-05",
      close: "100.00",
      currency: "EUR",
    });
    expect(priced.status).toBe(201);

    const removed = await a.del(`/api/v1/instruments/${id}`);
    expect(removed.status, removed.text).toBe(204);
    expect((await a.get(`/api/v1/instruments/${id}`)).status).toBe(404);
    const again = await a.post("/api/v1/instruments", {
      kind: "SCPI",
      symbol: "DELETEME",
      listingCurrency: "EUR",
      displayName: "Unreferenced SCPI again",
    });
    expect(again.status, again.text).toBe(201);
  });

  it("PATCH scpi-attributes by a tenant that holds nothing of the instrument is accepted and visible to the first tenant (shared catalogue, S-2)", async () => {
    const seen = await b.get(`/api/v1/instruments/${scpi}`);
    expect(seen.status, seen.text).toBe(200);
    const edited = await b.patch(`/api/v1/instruments/${scpi}/scpi-attributes`, {
      managementCompany: "Edited by tenant B",
    });
    expect(edited.status, edited.text).toBe(200);
    const [stored] = await ownerDb.select().from(instrument).where(eq(instrument.id, scpi));
    expect(stored!.managementCompany).toBe("Edited by tenant B");
    expect((await a.get(`/api/v1/instruments/${scpi}`)).body.managementCompany).toBe(
      "Edited by tenant B",
    );
  });

  it("kind strings are exact: a lower-case scpi is a 400 on create, on the list filter and on discovery; a padded code is canonicalised and dedupes", async () => {
    for (const result of [
      await a.post("/api/v1/instruments", {
        kind: "scpi",
        symbol: "LOWERKIND",
        listingCurrency: "EUR",
        displayName: "x",
      }),
      await a.get("/api/v1/instruments?kind=scpi"),
      await a.get("/api/v1/instruments/discovery?kind=scpi&query=corum"),
    ]) {
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("VALIDATION_ERROR");
    }

    const padded = await a.post("/api/v1/instruments", {
      kind: "SCPI",
      symbol: "  pad code  ",
      listingCurrency: "EUR",
      displayName: "Padded code",
    });
    expect(padded.status, padded.text).toBe(201);
    expect(padded.body.symbol).toBe("PAD CODE");
    const again = await a.post("/api/v1/instruments", {
      kind: "SCPI",
      symbol: "pad code",
      listingCurrency: "EUR",
      displayName: "Padded code again",
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INSTRUMENT_DUPLICATE_SYMBOL");
  });
});

describe("api — every API entry point that could reach a provider stays silent for an SCPI (recording MARKET_RUNTIME)", () => {
  const calls = {
    backfill: [] as { instrumentId: string; kind: string }[],
    instrumentBackfill: [] as string[],
    quoteRefresh: [] as string[],
    reload: [] as string[],
  };
  let app: TestApp;
  let session: Session;
  let c: ReturnType<typeof client>;
  let scpi: string;
  let share: string;

  const runtime = {
    discovery: { search: async () => [] },
    scheduler: {
      enqueueQuoteRefresh: async ({ instrumentId }: { instrumentId: string }) => {
        calls.quoteRefresh.push(instrumentId);
        return "job";
      },
      enqueueInstrumentBackfill: async ({ instrumentId }: { instrumentId: string }) => {
        calls.instrumentBackfill.push(instrumentId);
        return "job";
      },
    },
    enqueueBackfill: async (_db: unknown, params: { instrumentId: string; kind: string }) => {
      calls.backfill.push({ instrumentId: params.instrumentId, kind: params.kind });
    },
    requestBackfillReload: async (...args: unknown[]) => {
      calls.reload.push(JSON.stringify(args));
      throw new Error("a reload must never be requested for an SCPI");
    },
    async start() {},
    async stop() {},
  } as unknown as MarketRuntime;

  beforeAll(async () => {
    app = await startTestApp({ marketRuntime: runtime });
    session = await addUser(app, TENANT_RT, "rt");
    c = client(app, () => session);
    const created = await c.post("/api/v1/instruments", {
      kind: "SCPI",
      isin: "FR0014SCPIG3",
      listingCurrency: "EUR",
      displayName: "Runtime SCPI",
    });
    expect(created.status, created.text).toBe(201);
    scpi = created.body.id as string;
    const control = await c.post("/api/v1/instruments", {
      kind: "SHARE",
      isin: "FR0014SCPIE8",
      exchangeMic: "XPAR",
      listingCurrency: "EUR",
      displayName: "Runtime control share",
    });
    expect(control.status, control.text).toBe(201);
    share = control.body.id as string;
  }, 180_000);

  afterAll(async () => {
    await app.stop();
  }, 30_000);

  it("Portfolio Performance CSV rows naming the SCPI's ISIN resolve to it: the assets row is skipped as already known, the BUY books onto the SCPI, nothing is created or searched, no enqueue names it", async () => {
    const BOM = "\uFEFF";
    const assetsHeader =
      "ISIN;WKN;Symbole boursier;Nom du titre;Devise;Note;Total Expense Ratio (TER);Assets under Management;Vendor;Acquisition Fee (percentage);Management Fee (percentage)";
    const assets = Buffer.from(
      `${BOM}${assetsHeader}\r\nFR0014SCPIG3;;CORUMX;Corum Origin PP;EUR;;;;;;\r\n`,
    );
    for (const mode of ["DRY_RUN", "APPLY"]) {
      const known = await c
        .upload("/api/v1/imports/instruments", assets, mode, "assets.csv")
        .field("resolutions", "[]");
      expect(known.status, known.text).toBe(200);
      expect(known.body).toMatchObject({
        imported: 0,
        skipped: 1,
        rejected: 0,
        byReason: { INSTRUMENT_ALREADY_EXISTS: 1 },
        discoveryCallsIssued: 0,
      });
    }

    const created = await c.post("/api/v1/portfolios", { name: "pp csv on an SCPI" });
    expect(created.status, created.text).toBe(201);
    const portfolioId = created.body.id as string;
    await seedCashAccountsForPortfolio(app.ownerDb, portfolioId);
    const header =
      "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note";
    const trades = Buffer.from(
      `${BOM}${header}\r\n2026-01-05T10:00;Achat;-2500,00;EUR;;;;;;10;FR0014SCPIG3;;;Corum Origin PP;buy\r\n`,
    );
    const send = (mode: string) =>
      c
        .upload("/api/v1/imports/transactions", trades, mode, "trades.csv")
        .field("fileType", "INVESTMENT_ACCOUNT_TRANSACTIONS")
        .field("portfolioId", portfolioId)
        .field("cashAccountId", cash(portfolioId, "EUR"));
    const dry = await send("DRY_RUN");
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body).toMatchObject({ imported: 1, rejected: 0, discoveryCallsIssued: 0 });
    const apply = await send("APPLY");
    expect(apply.status, apply.text).toBe(200);
    expect(apply.body).toMatchObject({ imported: 1, rejected: 0, applyFailed: 0 });

    const booked = await app.ownerDb
      .select({ instrumentId: transaction.instrumentId, kind: transaction.kind })
      .from(transaction)
      .where(eq(transaction.portfolioId, portfolioId));
    expect(booked.filter((row) => row.kind === "BUY").map((row) => row.instrumentId)).toEqual([
      scpi,
    ]);
    const sameIsin = await app.ownerDb
      .select({ id: instrument.id })
      .from(instrument)
      .where(eq(instrument.isin, "FR0014SCPIG3"));
    expect(sameIsin).toEqual([{ id: scpi }]);
    expect(calls.backfill.filter((x) => x.instrumentId === scpi)).toEqual([]);
    expect(calls.instrumentBackfill).not.toContain(scpi);
  });

  it("history reload and provider-mapping repair for an SCPI are 400 INSTRUMENT_NOT_BACKFILLABLE and enqueue nothing", async () => {
    const reload = await c.post(`/api/v1/instruments/${scpi}/history-reload`);
    expect(reload.status, reload.text).toBe(400);
    expect(reload.body.code).toBe("INSTRUMENT_NOT_BACKFILLABLE");

    const mapped = await c.put(`/api/v1/instruments/${scpi}/provider-mapping`, {
      providerSymbol: "CORUM.PA",
    });
    expect(mapped.status, mapped.text).toBe(400);
    expect(mapped.body.code).toBe("INSTRUMENT_NOT_BACKFILLABLE");
    expect(calls.reload).toEqual([]);
  });

  it("watching an SCPI succeeds with no backfill and shows its manual price; the control share watched alongside does enqueue (the spy is alive)", async () => {
    const watched = await c.post("/api/v1/watchlist", { instrumentId: scpi });
    expect(watched.status, watched.text).toBe(200);
    expect(calls.backfill.filter((x) => x.instrumentId === scpi)).toEqual([]);
    expect(calls.instrumentBackfill).not.toContain(scpi);

    expect((await c.post("/api/v1/watchlist", { instrumentId: share })).status).toBe(200);
    expect(calls.backfill.filter((x) => x.instrumentId === share).length).toBeGreaterThan(0);

    const priced = await c.post(`/api/v1/instruments/${scpi}/prices`, {
      priceDate: "2026-06-01",
      close: "260.00",
      currency: "EUR",
    });
    expect(priced.status, priced.text).toBe(201);
    const list = await c.get("/api/v1/watchlist");
    expect(list.status, list.text).toBe(200);
    const row = (list.body.rows as { instrumentId: string; currentPrice?: unknown }[]).find(
      (r) => r.instrumentId === scpi,
    );
    expect(row?.currentPrice).toMatchObject({
      amount: "260",
      provenance: { derivedFrom: ["MANUAL_PRICE"] },
    });
  });

  it("a catalogue file written by the pre-feature build (before migration 0074) gets the outcome it got there: the same four fixture rows refused for a missing ISIN, the rest unchanged", async () => {
    // Measured twice, on a clean pre-feature build and here: the dry-run body is byte-identical.
    // (The fixture's SHARE/ETF/FUND rows carry a symbol and a MIC but no ISIN, so they are refused as before.)
    const golden = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "__fixtures__",
        "scpi-non-regression",
        "catalogue-export.body.txt",
      ),
      "utf8",
    ).replace("<exportedAt>", "2026-10-01T00:00:00.000Z");
    expect(golden).not.toContain('"SCPI"');

    const dry = await c.upload("/api/v1/imports/kerdial/catalogue", Buffer.from(golden), "DRY_RUN");
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body).toMatchObject({
      rowCount: 56,
      imported: 1,
      skipped: 51,
      rejected: 4,
      byReason: { MISSING_REQUIRED_VALUE: 4, CATALOGUE_ENTRY_UNCHANGED: 51 },
      applyFailed: 0,
    });
    const refusals = (dry.body.entries as { outcome: string; message: string }[]).filter(
      (entry) => entry.outcome === "REJECT",
    );
    expect(refusals.map((entry) => entry.message)).toEqual([
      "a SHARE instrument is identified by its ISIN and its exchange MIC, and this entry is missing one of the two",
      "a ETF instrument is identified by its ISIN and its exchange MIC, and this entry is missing one of the two",
      "a FUND instrument is identified by its ISIN and its exchange MIC, and this entry is missing one of the two",
      "a FUND instrument is identified by its ISIN and its exchange MIC, and this entry is missing one of the two",
    ]);
  });

  it("an SCPI catalogue import enrols no backfill for the SCPI, restores its identity, attributes, domicile and manual price, and is unchanged on re-import; a control SHARE in the same file is enrolled", async () => {
    const entry = (identity: object, extra: object = {}) => ({
      identity,
      private: false,
      listingCurrency: "EUR",
      displayName: "Catalogue entry",
      primaryIdentifier: "ISIN",
      quotePolicy: "MANUAL_ONLY",
      status: "ACTIVE",
      manualPrices: [{ priceDate: "2026-01-05", close: "250.00", currency: "EUR" }],
      ...extra,
    });
    const document = {
      schemaVersion: 1,
      generator: "scpi-tester",
      exportedAt: "2026-09-24T10:00:00Z",
      baseCurrency: "EUR",
      iconsIncluded: false,
      instruments: [
        entry(
          { kind: "SCPI", isin: "FR0014SCPIC2", symbol: "CORUMCAT" },
          {
            displayName: "Catalogue SCPI",
            managementCompany: "Corum",
            subscriptionFeePct: "8.5",
            domicileCountry: "FR",
            watchlist: { note: "from the file" },
          },
        ),
        entry(
          { kind: "SHARE", isin: "US88160R1014", exchangeMic: "XNAS" },
          { displayName: "Catalogue control share", listingCurrency: "USD", quotePolicy: "AUTO" },
        ),
      ],
      portfolios: [],
      fxRatesUser: [],
    };
    const upload = () =>
      c.upload("/api/v1/imports/kerdial/catalogue", Buffer.from(JSON.stringify(document)), "APPLY");

    const first = await upload();
    expect(first.status, first.text).toBe(200);
    expect(first.body.rejected).toBe(0);
    expect(first.body.applyFailed).toBe(0);

    const list = await c.get("/api/v1/instruments?kind=SCPI&limit=100");
    const imported = (list.body.items as Record<string, unknown>[]).find(
      (i) => i["symbol"] === "CORUMCAT",
    );
    expect(imported).toMatchObject({
      kind: "SCPI",
      isin: "FR0014SCPIC2",
      exchangeMic: null,
      primaryIdentifier: "ISIN",
      quotePolicy: "MANUAL_ONLY",
      managementCompany: "Corum",
      subscriptionFeePct: "8.50",
      domicileCountry: "FR",
    });
    const importedId = imported!["id"] as string;
    const detail = await c.get(`/api/v1/instruments/${importedId}`);
    expect(detail.body).toEqual(imported);
    const prices = await c.get(
      `/api/v1/instruments/${importedId}/prices?from=2026-01-01&to=2026-02-01`,
    );
    expect(JSON.stringify(prices.body)).toContain('"close":"250"');

    expect(calls.backfill.filter((x) => x.instrumentId === importedId)).toEqual([]);
    expect(calls.backfill.some((x) => x.kind === "SHARE")).toBe(true);

    const second = await upload();
    expect(second.status, second.text).toBe(200);
    expect(second.body.applyFailed).toBe(0);
    expect(second.body.rejected).toBe(0);
    const relist = await c.get("/api/v1/instruments?kind=SCPI&limit=100");
    expect(
      (relist.body.items as Record<string, unknown>[]).filter((i) => i["symbol"] === "CORUMCAT"),
    ).toHaveLength(1);

    // An SCPI entry that names a provider mapping is refused; nothing about it is written.
    document.instruments[0] = entry(
      { kind: "SCPI", symbol: "MAPPEDSCPI" },
      {
        primaryIdentifier: "SYMBOL",
        providerMapping: { providerKey: "yahoo", providerSymbol: "MAPPED.PA" },
      },
    );
    const mapped = await upload();
    expect(mapped.status, mapped.text).toBe(200);
    expect(mapped.body.byReason).toMatchObject({ MALFORMED_VALUE: 1 });
    const after = await c.get("/api/v1/instruments?kind=SCPI&limit=100");
    expect((after.body.items as Record<string, unknown>[]).map((i) => i["symbol"])).not.toContain(
      "MAPPEDSCPI",
    );
  });

  // The PATCH refuses a sector or an industry on an SCPI, and the export never
  // emits either for an SCPI — even a row that carries one from before the fix —
  // so the tenant's own export of that SCPI re-imports (G7).
  it("an SCPI refuses a sector through PATCH classification, and survives export then import (G7)", async () => {
    const created = await c.post("/api/v1/instruments", {
      kind: "SCPI",
      symbol: "SECTORSCPI",
      listingCurrency: "EUR",
      displayName: "SCPI with a sector",
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    // In the export: an SCPI is exported when the tenant watches it.
    expect((await c.post("/api/v1/watchlist", { instrumentId: id })).status).toBe(200);
    const attributed = await c.patch(`/api/v1/instruments/${id}/scpi-attributes`, {
      managementCompany: "Sofidy",
      subscriptionFeePct: "10",
    });
    expect(attributed.status, attributed.text).toBe(200);

    const classified = await c.patch(`/api/v1/instruments/${id}/classification`, {
      sectorCode: "FINANCE",
      industryLabel: "Immobilier",
    });
    expect(classified.status, classified.text).toBe(400);
    expect(classified.body.code).toBe("INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE");
    expect((await c.get(`/api/v1/instruments/${id}`)).body).toMatchObject({
      sectorCode: null,
      industryLabel: null,
    });

    // A row written before the fix: the export must still leave the pair out.
    await app.ownerDb
      .update(instrument)
      .set({ sectorCode: "FINANCE", industryLabel: "Immobilier" })
      .where(eq(instrument.id, id));

    const exported = await c.get("/api/v1/exports/instruments");
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("SECTORSCPI");

    expect((await c.del(`/api/v1/instruments/${id}`)).status).toBe(204);
    const reimport = await c.upload(
      "/api/v1/imports/kerdial/catalogue",
      Buffer.from(exported.text),
      "APPLY",
    );
    expect(reimport.status, reimport.text).toBe(200);
    expect(reimport.body.rejected).toBe(0);
    expect(reimport.body.applyFailed).toBe(0);
    const list = await c.get("/api/v1/instruments?kind=SCPI&limit=100");
    const restored = (list.body.items as Record<string, unknown>[]).find(
      (i) => i["symbol"] === "SECTORSCPI",
    );
    expect(restored).toMatchObject({
      kind: "SCPI",
      managementCompany: "Sofidy",
      subscriptionFeePct: "10.00",
      sectorCode: null,
      industryLabel: null,
    });
  });
});
