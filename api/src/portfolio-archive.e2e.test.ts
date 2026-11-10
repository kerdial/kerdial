import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { instrument, portfolio, tenant, transaction, type Db } from "@kerdial/platform-db";
import { createInstrumentBySymbol } from "@kerdial/ledger";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { and, eq } from "drizzle-orm";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `portfolio-archive` PA-T3 — the **release gate**:
 * archiving is a display-only flag, so no server figure moves (AC-478, AC-480),
 * writes into an archived portfolio are accepted (AC-481) and an explicit
 * `?portfolio=` filter still returns its rows (AC-482).
 *
 * **Its own tenant**, and its instruments are inserted directly rather than
 * through `POST /instruments`, so it spends none of any tenant's
 * instrument-create budget (the `transactions.e2e` lesson). EUR only, manual
 * prices only: no FX and no provider call can make a capture differ.
 *
 * The fixture is chosen so that dropping **either** portfolio from a
 * tenant-wide read would move at least one number: both hold an open position,
 * the one archived also carries the dividend and the closed position.
 */

const TENANT = "00000000-0000-7000-8000-0000007490a0";
const PASSWORD = "correct horse battery staple archive";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

/** AC-480's unfiltered tenant-wide reads. */
const FIGURE_READS = [
  "/api/v1/portfolios/overview",
  "/api/v1/portfolios/holdings",
  "/api/v1/portfolios/closed-positions",
  "/api/v1/portfolios/value-series",
  "/api/v1/dividends/summary",
  "/api/v1/transactions",
  "/api/v1/transactions/calendar",
] as const;

const encoder = new TextEncoder();
const TRANSACTION_HEADER =
  "Date;Type;Valeur;Devise de l'opération;Montant brut;Montant brut en devise;Taux de change;Frais;Impôts / Taxes;Parts;ISIN;WKN;Symbole boursier;Nom du titre;Note";
/** No blank or format codepoint is ever written literally in this file (this repo's standing rule). */
const BOM = "﻿";
const CRLF = "\u000D\u000A";

describe("api — portfolio-archive release gate (AC-478, AC-480, AC-481, AC-482)", () => {
  let testApp: TestApp;
  let ownerDb: Db;
  let session: Session;
  let kept: string;
  let archived: string;
  let shareA: string;
  let shareB: string;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function write(method: "post" | "patch", path: string) {
    return server()
      [method](path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf);
  }

  async function createPortfolio(name: string): Promise<string> {
    const response = await write("post", "/api/v1/portfolios").send({ name });
    expect(response.status).toBe(201);
    const id = response.body.id as string;
    await seedCashAccountsForPortfolio(ownerDb, id);
    return id;
  }

  async function seedShare(label: string): Promise<string> {
    const id = randomUUID();
    await ownerDb.insert(instrument).values({
      id,
      kind: "SHARE",
      displayName: `PA gate ${label}`,
      listingCurrency: "EUR",
      exchangeMic: "XPAR",
      symbol: `PA${label}${id.slice(0, 6)}`,
      primaryIdentifier: "SYMBOL",
      quotePolicy: "MANUAL_ONLY",
    });
    return id;
  }

  async function manualPrice(instrumentId: string, priceDate: string, close: string) {
    const response = await write("post", `/api/v1/instruments/${instrumentId}/prices`).send({
      priceDate,
      close,
      currency: "EUR",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  async function trade(body: Record<string, unknown>) {
    return write("post", "/api/v1/transactions").send({ currency: "EUR", ...body });
  }

  async function trade201(body: Record<string, unknown>) {
    const response = await trade(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response;
  }

  /** The raw response text of every AC-480 read — compared as bytes, never re-serialised. */
  async function captureFigures(): Promise<Record<string, string>> {
    const captured: Record<string, string> = {};
    for (const path of FIGURE_READS) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      captured[path] = response.text;
    }
    return captured;
  }

  async function calcEpochs(): Promise<Record<string, bigint>> {
    const rows = await ownerDb
      .select({ id: portfolio.id, calcEpoch: portfolio.calcEpoch })
      .from(portfolio)
      .where(eq(portfolio.tenantId, TENANT));
    return Object.fromEntries(rows.map((row) => [row.id, row.calcEpoch]));
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    ownerDb = testApp.ownerDb;
    await ownerDb.insert(tenant).values({ id: TENANT });
    const email = `portfolio-archive-${randomUUID()}@example.com`;
    await createUser(testApp.db, { id: randomUUID(), tenantId: TENANT, email, password: PASSWORD });
    session = await loginAs(server(), email, PASSWORD);

    kept = await createPortfolio("PA gate kept");
    archived = await createPortfolio("PA gate archived");
    shareA = await seedShare("A");
    shareB = await seedShare("B");

    await manualPrice(shareA, "2026-09-01", "100");
    await manualPrice(shareA, "2026-10-01", "110");
    await manualPrice(shareB, "2026-09-01", "50");
    await manualPrice(shareB, "2026-10-01", "60");

    const buy = { kind: "BUY", instrumentId: shareA, tradeDate: "2026-09-01", unitPrice: "100" };
    await trade201({ ...buy, portfolioId: kept, quantity: "10", cashAccountId: cash(kept, "EUR") });
    await trade201({
      ...buy,
      portfolioId: archived,
      quantity: "5",
      cashAccountId: cash(archived, "EUR"),
    });
    // A closed position and a dividend, both on the portfolio about to be archived.
    await trade201({
      kind: "BUY",
      portfolioId: archived,
      instrumentId: shareB,
      tradeDate: "2026-09-02",
      quantity: "4",
      unitPrice: "50",
      cashAccountId: cash(archived, "EUR"),
    });
    await trade201({
      kind: "SELL",
      portfolioId: archived,
      instrumentId: shareB,
      tradeDate: "2026-10-01",
      quantity: "4",
      unitPrice: "60",
      cashAccountId: cash(archived, "EUR"),
    });
    await trade201({
      kind: "DIVIDEND",
      portfolioId: archived,
      instrumentId: shareA,
      tradeDate: "2026-09-15",
      amount: "12.00",
      cashAccountId: cash(archived, "EUR"),
    });
  }, 180_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("AC-478/AC-480: archiving one of two funded portfolios leaves every tenant-wide body byte-equal and every calc_epoch equal", async () => {
    const before = await captureFigures();
    const epochsBefore = await calcEpochs();

    // Non-vacuous guard: the captured figures are real, and both portfolios
    // contribute to them, so excluding either would move a number.
    // Known answer: holdings 10 × 110 in the kept portfolio + 5 × 110 in the
    // other = 1650, plus both portfolios' cash (portfolio-cash FR-678, PC-L13 —
    // the archived one's included): kept −1000 (BUY); other −500 − 200 (BUYs)
    // + 240 (SELL) + 12 (DIVIDEND) = −448; 1650 − 1448 = 202.
    const overview = JSON.parse(before["/api/v1/portfolios/overview"]!) as {
      portfolioCount: number;
      totalValue: { amount: string };
      cash: { totalBase: string };
    };
    expect(overview.portfolioCount).toBe(2);
    expect(overview.cash.totalBase).toBe("-1448");
    expect(overview.totalValue.amount).toBe("202");
    const ledger = JSON.parse(before["/api/v1/transactions"]!) as {
      items: { portfolioId: string }[];
    };
    expect(new Set(ledger.items.map((row) => row.portfolioId))).toEqual(new Set([kept, archived]));
    expect(Object.keys(epochsBefore)).toHaveLength(2);

    const archive = await write("patch", `/api/v1/portfolios/${archived}`).send({ archived: true });
    expect(archive.status).toBe(200);
    expect(archive.body.archived).toBe(true);

    const after = await captureFigures();
    for (const path of FIGURE_READS) {
      expect(after[path], path).toBe(before[path]);
    }
    expect(await calcEpochs()).toEqual(epochsBefore);
  });

  it("AC-481: an archived portfolio accepts a BUY, a confirmed CSV import, and a transfer in and out, with the usual statuses", async () => {
    const list = await get("/api/v1/portfolios");
    expect(
      (list.body.items as { id: string; archived: boolean }[]).find((p) => p.id === archived)
        ?.archived,
    ).toBe(true);

    await trade201({
      kind: "BUY",
      portfolioId: archived,
      instrumentId: shareA,
      tradeDate: "2026-10-02",
      quantity: "1",
      unitPrice: "110",
      cashAccountId: cash(archived, "EUR"),
    });

    const transferBody = {
      kind: "TRANSFER_OUT",
      instrumentId: shareA,
      tradeDate: "2026-10-03",
      quantity: "1",
      amount: "110",
    };
    const outOfArchived = await trade201({
      ...transferBody,
      portfolioId: archived,
      destinationPortfolioId: kept,
    });
    expect(typeof outOfArchived.body.transferLinkedTransactionId).toBe("string");
    const intoArchived = await trade201({
      ...transferBody,
      portfolioId: kept,
      destinationPortfolioId: archived,
    });
    expect(typeof intoArchived.body.transferLinkedTransactionId).toBe("string");

    const file = Buffer.from(
      encoder.encode(
        BOM +
          [TRANSACTION_HEADER, "2026-10-04T10:00;Dépôt;100,00;EUR;;;;;;;;;;;pa"].join(CRLF) +
          CRLF,
      ),
    );
    const apply = await write("post", "/api/v1/imports/transactions")
      .field("mode", "APPLY")
      .field("fileType", "CASH_ACCOUNT_TRANSACTIONS")
      .field("portfolioId", archived)
      .field("cashAccountId", cash(archived, "EUR"))
      .attach("file", file, { filename: "upload.csv", contentType: "text/csv" });
    expect(apply.status, JSON.stringify(apply.body)).toBe(200);
    expect(apply.body.imported).toBe(1);
    expect(apply.body.applyFailed).toBe(0);
    expect(apply.body.applyNotAttempted).toBe(0);
  });

  it("AC-481 (tester) — an import's transfer decision naming the archived portfolio lands the TRANSFER_IN there, as for any destination", async () => {
    const symbol = `PAX${randomUUID().slice(0, 5).toUpperCase()}`;
    await createInstrumentBySymbol(ownerDb, {
      kind: "CRYPTO",
      symbol,
      listingCurrency: "EUR",
      displayName: "A coin",
    });
    const source = await createPortfolio("PA import source");
    const file = Buffer.from(
      encoder.encode(
        BOM +
          [
            TRANSACTION_HEADER,
            `2025-01-10T10:00;Achat;1200,00;EUR;;;;;;0,02;;;${symbol};A coin;`,
            `2025-07-09T15:40;Transfert (Sortant);-600,00;EUR;;;;;;0,01;;;${symbol};A coin;`,
          ].join(CRLF) +
          CRLF,
      ),
    );
    const apply = await write("post", "/api/v1/imports/transactions")
      .field("mode", "APPLY")
      .field("fileType", "INVESTMENT_ACCOUNT_TRANSACTIONS")
      .field("portfolioId", source)
      .field("cashAccountId", cash(source, "EUR"))
      .field(
        "transferDestinations",
        JSON.stringify([{ index: 1, portfolioName: "PA gate archived" }]),
      )
      .attach("file", file, { filename: "upload.csv", contentType: "text/csv" });
    expect(apply.status, JSON.stringify(apply.body)).toBe(200);
    expect(apply.body.imported).toBe(2);
    expect(apply.body.applyFailed).toBe(0);

    const intoArchived = await ownerDb
      .select({ id: transaction.id, transferSourceId: transaction.transferSourceId })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, TENANT),
          eq(transaction.kind, "TRANSFER_IN"),
          eq(transaction.portfolioId, archived),
        ),
      );
    const outOfSource = await ownerDb
      .select({ id: transaction.id })
      .from(transaction)
      .where(and(eq(transaction.portfolioId, source), eq(transaction.kind, "TRANSFER_OUT")));
    expect(outOfSource).toHaveLength(1);
    expect(intoArchived.map((leg) => leg.transferSourceId)).toContain(outOfSource[0]!.id);
  });

  it("AC-482: ?portfolio=<archivedId> on the ledger and dividends reads returns that portfolio's rows", async () => {
    const ledger = await get(`/api/v1/transactions?portfolio=${archived}`);
    expect(ledger.status).toBe(200);
    const items = ledger.body.items as { portfolioId: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((row) => row.portfolioId === archived)).toBe(true);

    const dividends = await get(`/api/v1/dividends/summary?portfolio=${archived}`);
    expect(dividends.status).toBe(200);
    // The archived portfolio holds the tenant's only dividend: 12 EUR, one payment.
    expect(dividends.body.portfolioId).toBe(archived);
    expect(dividends.body.total.grossBase).toBe("12");
    expect(dividends.body.instruments).toHaveLength(1);
    expect(dividends.body.instruments[0].instrumentId).toBe(shareA);
  });
});
