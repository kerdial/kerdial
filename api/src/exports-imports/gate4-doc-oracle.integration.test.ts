import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstrumentByIsin } from "@kerdial/ledger";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "../auth/cookies.js";
import { loginAs, type SessionCookies } from "../test-support/http.js";
import { startTestApp, type TestApp } from "../test-support/test-app.js";

const PASSWORD = "correct horse battery staple doc-oracle";
const CSV_PATH = "/api/v1/imports/kerdial/transactions";

const PORTFOLIO_NAME = "Portefeuille du migrant";
const EUR_ACCOUNT = "Compte principal";
const USD_ACCOUNT = "Compte USD";

const KNOWN_ISIN = "FRDOCORACL01";
const KNOWN_USD_ISIN = "FRDOCORACL02";
const UNKNOWN_ISIN = "FRZZUNKNOWN1";
const MIC = "XPAR";

const BOM = "﻿";
const CRLF = "\u000D\u000A";

const HEADER = [
  "type",
  "portfolio",
  "date",
  "cash_account",
  "currency",
  "cash_account_currency",
  "note",
  "isin",
  "exchange_mic",
  "unit_price",
  "quantity",
  "gross_amount",
  "fx_rate",
  "broker_fee",
  "trade_tax",
] as const;

function row(cells: Partial<Record<(typeof HEADER)[number], string>>): string {
  return HEADER.map((name) => cells[name] ?? "").join(";");
}

function docDialectFile(): Buffer {
  const rows = [
    row({
      type: "DEPOSIT",
      portfolio: PORTFOLIO_NAME,
      date: "2026-01-05",
      cash_account: EUR_ACCOUNT,
      currency: "EUR",
      cash_account_currency: "EUR",
      note: "#pas un commentaire",
      gross_amount: "1234,56",
    }),
    row({
      type: "BUY",
      portfolio: PORTFOLIO_NAME,
      date: "2026-01-06",
      cash_account: EUR_ACCOUNT,
      currency: "EUR",
      cash_account_currency: "EUR",
      isin: KNOWN_ISIN,
      exchange_mic: MIC,
      quantity: "10",
      unit_price: "100,50",
    }),
    row({
      type: "BUY",
      portfolio: PORTFOLIO_NAME,
      date: "2026-01-07",
      cash_account: EUR_ACCOUNT,
      currency: "EUR",
      cash_account_currency: "EUR",
      isin: UNKNOWN_ISIN,
      exchange_mic: MIC,
      quantity: "1",
      unit_price: "10,00",
    }),
    row({
      type: "SELL",
      portfolio: PORTFOLIO_NAME,
      date: "2026-01-08",
      cash_account: EUR_ACCOUNT,
      currency: "EUR",
      cash_account_currency: "EUR",
      note: "vente-avec-frais",
      isin: KNOWN_ISIN,
      exchange_mic: MIC,
      quantity: "4",
      unit_price: "110,00",
      broker_fee: "1,50",
      trade_tax: "0,30",
    }),
    row({
      type: "BUY",
      portfolio: PORTFOLIO_NAME,
      date: "2026-01-09",
      cash_account: USD_ACCOUNT,
      currency: "USD",
      cash_account_currency: "USD",
      note: "achat-usd-pinned",
      isin: KNOWN_USD_ISIN,
      exchange_mic: MIC,
      quantity: "2",
      unit_price: "500,00",
      fx_rate: "1,0824",
    }),
    "BUY;Portefeuille du migrant;2026-01-10",
  ];
  return Buffer.from(BOM + [HEADER.join(";"), ...rows].join(CRLF) + CRLF, "utf8");
}

interface Harness {
  readonly app: TestApp;
  readonly tenantId: string;
  post(path: string): supertest.Test;
}

describe("GATE-4 doc oracle", () => {
  let harness: Harness;

  beforeAll(async () => {
    const app = await startTestApp();
    const server = (): ReturnType<typeof supertest> => supertest(app.built.app.getHttpServer());
    const tenantId = randomUUID();
    const email = `doc-oracle-${randomUUID()}@example.com`;
    await app.ownerDb.insert(tenant).values([{ id: tenantId }]);
    await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    const session: SessionCookies = await loginAs(server(), email, PASSWORD);

    await createInstrumentByIsin(app.db, {
      kind: "SHARE",
      isin: KNOWN_ISIN,
      exchangeMic: MIC,
      listingCurrency: "EUR",
      displayName: "Doc Oracle SA",
    });
    await createInstrumentByIsin(app.db, {
      kind: "SHARE",
      isin: KNOWN_USD_ISIN,
      exchangeMic: MIC,
      listingCurrency: "USD",
      displayName: "Doc Oracle Inc.",
    });

    harness = {
      app,
      tenantId,
      post: (path: string) =>
        server()
          .post(path)
          .set("Cookie", [
            `${SID_COOKIE_NAME}=${session.sid}`,
            `${CSRF_COOKIE_NAME}=${session.csrf}`,
          ])
          .set(CSRF_HEADER_NAME, session.csrf),
    };
  }, 180_000);

  afterAll(async () => {
    await harness.app.stop();
  }, 60_000);

  function upload(mode: "DRY_RUN" | "APPLY"): supertest.Test {
    return harness
      .post(CSV_PATH)
      .attach("file", docDialectFile(), { filename: "mon-tableur.csv", contentType: "text/csv" })
      .field("mode", mode);
  }

  it("DRY_RUN reports four importable rows and names the two rejects", async () => {
    const response = await upload("DRY_RUN");

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(4);
    expect(response.body.rejected).toBe(2);
    expect(response.body.byReason["INSTRUMENT_NOT_RESOLVED"]).toBe(1);
    expect(response.body.byReason["MALFORMED_ROW"]).toBe(1);
  });

  it("APPLY writes exactly the four valid rows and creates a bare portfolio/accounts", async () => {
    const response = await upload("APPLY");

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(4);
    expect(response.body.rejected).toBe(2);

    const portfolios = await harness.app.ownerClient`
      SELECT name, broker, description FROM "portfolio" WHERE tenant_id = ${harness.tenantId}::uuid`;
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0]!["name"]).toBe(PORTFOLIO_NAME);
    expect(portfolios[0]!["broker"]).toBeNull();
    expect(portfolios[0]!["description"]).toBeNull();

    const accounts = await harness.app.ownerClient`
      SELECT name, currency FROM "cash_account"
      WHERE tenant_id = ${harness.tenantId}::uuid ORDER BY name`;
    expect(
      accounts.map((one) => `${String(one["name"])}:${String(one["currency"])}`).sort(),
    ).toEqual([`${EUR_ACCOUNT}:EUR`, `${USD_ACCOUNT}:USD`].sort());

    const transactionRows = await harness.app.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${harness.tenantId}::uuid`;
    expect(transactionRows[0]!["n"]).toBe(4);
  });

  it("the note starting with '#' is stored verbatim, never treated as a comment", async () => {
    const rows = await harness.app.ownerClient`
      SELECT note FROM "transaction"
      WHERE tenant_id = ${harness.tenantId}::uuid AND kind = 'DEPOSIT'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["note"]).toBe("#pas un commentaire");
  });

  it("the SELL row's fee total is derived as the sum of its stated components", async () => {
    const rows = await harness.app.ownerClient`
      SELECT fee_amount, broker_fee_amount, tax_amount
      FROM "transaction"
      WHERE tenant_id = ${harness.tenantId}::uuid AND note = 'vente-avec-frais'`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!["fee_amount"])).toBeCloseTo(1.8, 9);
    expect(Number(rows[0]!["broker_fee_amount"])).toBeCloseTo(1.5, 9);
    expect(Number(rows[0]!["tax_amount"])).toBeCloseTo(0.3, 9);
  });

  it("the USD row's fx_rate is stored as USER_PINNED, never re-derived", async () => {
    const rows = await harness.app.ownerClient`
      SELECT fx_rate, fx_rate_source
      FROM "transaction"
      WHERE tenant_id = ${harness.tenantId}::uuid AND note = 'achat-usd-pinned'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["fx_rate_source"]).toBe("USER_PINNED");
    expect(Number(rows[0]!["fx_rate"])).toBeCloseTo(1.0824, 9);
  });

  it("re-submitting the very same file a second time skips every row already written", async () => {
    const before = await harness.app.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${harness.tenantId}::uuid`;

    const second = await upload("APPLY");
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(0);
    expect(second.body.skipped).toBe(4);
    expect(second.body.byReason["ALREADY_IMPORTED"]).toBe(4);

    const after = await harness.app.ownerClient`
      SELECT count(*)::int AS n FROM "transaction" WHERE tenant_id = ${harness.tenantId}::uuid`;
    expect(after[0]!["n"]).toBe(before[0]!["n"]);
  });
});
