import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { cashAccount, instrument, portfolio, tenant } from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `cash-interest` cycle, CI-T7 — **AC-529** (FR-642) and **AC-523**.
 *
 * **AC-529.** For a tenant with no INTEREST row, the two bodies the cycle
 * touched and the `scpi` goldens do not already pin — the Activité calendar
 * (`GET /transactions/calendar`) and the Kerdial CSV export
 * (`GET /exports/transactions`) — are byte-identical to the pre-feature build.
 * Overview, holdings, value-series, the list, Dividendes and allocation stay
 * pinned by `scpi-non-regression.e2e.test.ts`, re-run unmodified.
 *
 * **How "before" is known.** The goldens under
 * `__fixtures__/cash-interest-non-regression/` were captured by running **this
 * same file**, unchanged, in a throwaway worktree at the branch
 * point (before migration `0075`) with `CASH_INTEREST_NON_REGRESSION_CAPTURE_DIR`
 * set. That mode writes the bodies and then fails on purpose, so a capture can
 * never be mistaken for a pass; the AC-523 case is skipped there (the old
 * build has no INTEREST to post). Without the variable the bodies are compared
 * to the goldens.
 *
 * **Raw text, never re-serialised objects**: a key, a kind bucket or a CSV
 * column added, dropped or reordered shows up as a different string. Neither
 * body carries a clock-derived value, so there is no substitution.
 *
 * The fixture is deterministic by construction: fixed ids and timestamps for
 * every catalogue/portfolio row, fixed past dates for every transaction, EUR
 * only (no FX feed). Transactions go through the real `POST /transactions`
 * path, sequentially, so `seq` — the export's tie-break — is fixed too.
 *
 * **AC-523** runs last on purpose: it adds the tenant's first INTEREST row (with
 * a withholding) and asserts `GET /dividends/summary` is byte-equal to the same
 * tenant's body just before it — the summary reads `t.kind = 'DIVIDEND'` only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(here, "__fixtures__", "cash-interest-non-regression");
const CAPTURE_DIR = process.env["CASH_INTEREST_NON_REGRESSION_CAPTURE_DIR"];
const CAPTURING = CAPTURE_DIR !== undefined && CAPTURE_DIR !== "";

const TENANT = "00000000-0000-7000-8000-000000529001";
const USER = "00000000-0000-7000-8000-000000529002";
const EMAIL = "cash-interest-ac529@example.com";
const PASSWORD = "correct horse battery staple ac529";
const PORTFOLIO = "00000000-0000-7000-8000-000000529011";
const CASH_EUR = "00000000-0000-7000-8000-000000529021";
const LIVRET = "00000000-0000-7000-8000-000000529022";

const FIXED_AT = new Date("2024-01-01T00:00:00.000Z");

const SHARE = "00000000-0000-7000-8000-000000529101";
const ETF = "00000000-0000-7000-8000-000000529102";

/** The two reads AC-529 adds goldens for, by golden file name. */
const READS: readonly (readonly [string, string])[] = [
  ["calendar", "/api/v1/transactions/calendar"],
  ["transactions-export", "/api/v1/exports/transactions"],
];

describe("cash-interest — calendar and CSV export bodies without INTEREST are byte-identical to the pre-feature build (AC-529, AC-523)", () => {
  let testApp: TestApp;
  let session: { sid: string; csrf: string };

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  async function write(body: Record<string, unknown>): Promise<void> {
    const response = await server()
      .post("/api/v1/transactions")
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  async function liveBodies(): Promise<Map<string, string>> {
    const bodies = new Map<string, string>();
    for (const [name, path] of READS) {
      const response = await get(path);
      expect(response.status, `${name}: ${response.text}`).toBe(200);
      bodies.set(name, response.text);
    }
    return bodies;
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    const { ownerDb } = testApp;

    await ownerDb.insert(tenant).values({ id: TENANT });
    await createUser(testApp.db, { id: USER, tenantId: TENANT, email: EMAIL, password: PASSWORD });
    await ownerDb.insert(portfolio).values({
      id: PORTFOLIO,
      tenantId: TENANT,
      name: "AC-529 fixture",
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    });
    await ownerDb.insert(cashAccount).values([
      {
        id: CASH_EUR,
        tenantId: TENANT,
        portfolioId: PORTFOLIO,
        name: "Compte EUR",
        currency: "EUR",
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
      {
        id: LIVRET,
        tenantId: TENANT,
        portfolioId: PORTFOLIO,
        name: "Livret",
        currency: "EUR",
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    ]);
    await ownerDb.insert(instrument).values([
      {
        id: SHARE,
        kind: "SHARE",
        displayName: "CINRG share",
        listingCurrency: "EUR",
        exchangeMic: "XPAR",
        isin: "FR0000529101",
        symbol: "CINSHR",
        primaryIdentifier: "ISIN",
        quotePolicy: "AUTO",
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
      {
        id: ETF,
        kind: "ETF",
        displayName: "CINRG ETF",
        listingCurrency: "EUR",
        exchangeMic: "XETR",
        symbol: "CINETF",
        primaryIdentifier: "SYMBOL",
        quotePolicy: "AUTO",
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    ]);

    session = await loginAs(server(), EMAIL, PASSWORD);

    const eur = { portfolioId: PORTFOLIO, currency: "EUR", cashAccountId: CASH_EUR };
    await write({ ...eur, kind: "DEPOSIT", tradeDate: "2024-01-02", amount: "20000" });
    await write({
      ...eur,
      cashAccountId: LIVRET,
      kind: "DEPOSIT",
      tradeDate: "2024-01-02",
      amount: "5000",
    });
    await write({
      ...eur,
      kind: "BUY",
      instrumentId: SHARE,
      tradeDate: "2024-01-03",
      quantity: "10",
      unitPrice: "50",
      fee: { components: { brokerFee: "4.90", tax: "1.50" } },
    });
    await write({
      ...eur,
      kind: "BUY",
      instrumentId: ETF,
      tradeDate: "2024-01-03",
      quantity: "20",
      unitPrice: "80",
    });
    await write({
      ...eur,
      kind: "DIVIDEND",
      instrumentId: SHARE,
      tradeDate: "2024-03-15",
      amount: "12.50",
    });
    await write({
      ...eur,
      kind: "DIVIDEND",
      instrumentId: SHARE,
      tradeDate: "2024-06-14",
      amount: "13.00",
      withholding: { amount: "3.90" },
    });
    await write({
      ...eur,
      kind: "SELL",
      instrumentId: ETF,
      tradeDate: "2024-06-20",
      quantity: "5",
      unitPrice: "83.15",
      fee: { amount: "1.50" },
    });
    await write({ ...eur, kind: "WITHDRAWAL", tradeDate: "2024-07-01", amount: "750.25" });
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  it("is a non-trivial fixture — the comparison below cannot pass on empty bodies", async () => {
    const list = await get("/api/v1/transactions?limit=100");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(8);
    expect(list.body.items.some((t: { kind: string }) => t.kind === "INTEREST")).toBe(false);

    const bodies = await liveBodies();
    const calendar = bodies.get("calendar")!;
    const csv = bodies.get("transactions-export")!;
    expect(calendar.length).toBeGreaterThan(300);
    expect(csv.length).toBeGreaterThan(1000);
    // The fixture's known figures, as they reach each body.
    expect(csv).toContain("750.25");
    expect(csv).toContain("FR0000529101");
    expect(calendar).toContain('{"period":"2024-07","count":1,"volumeBase":"750.25"}');
    expect(csv.split("\n").filter((line) => line.startsWith("2024-")).length).toBe(8);
  });

  it("every body equals the golden captured before migration 0075, as raw text", async () => {
    const bodies = await liveBodies();

    if (CAPTURING) {
      mkdirSync(CAPTURE_DIR, { recursive: true });
      for (const [name, body] of bodies) {
        writeFileSync(join(CAPTURE_DIR, `${name}.body.txt`), body);
      }
      throw new Error(
        `capture mode: ${bodies.size} goldens written to ${CAPTURE_DIR}, nothing compared`,
      );
    }

    expect([...bodies.keys()]).toHaveLength(READS.length);
    for (const [name, body] of bodies) {
      const golden = readFileSync(join(GOLDEN_DIR, `${name}.body.txt`), "utf8");
      // Sanity guard on the golden itself: an empty or truncated capture
      // cannot make the equality below vacuous.
      expect(golden.length, `${name} golden length`).toBeGreaterThan(200);
      expect(body, name).toBe(golden);
    }
    expect(readFileSync(join(GOLDEN_DIR, "transactions-export.body.txt"), "utf8")).toContain(
      "750.25",
    );
    expect(readFileSync(join(GOLDEN_DIR, "calendar.body.txt"), "utf8")).toContain(
      '{"period":"2024-07","count":1,"volumeBase":"750.25"}',
    );
  });

  it.skipIf(CAPTURING)(
    "AC-523: an INTEREST with a withholding leaves GET /dividends/summary byte-equal",
    async () => {
      const before = await get("/api/v1/dividends/summary");
      expect(before.status).toBe(200);
      expect(before.body.total.grossBase).toBe("25.5");

      await write({
        portfolioId: PORTFOLIO,
        kind: "INTEREST",
        tradeDate: "2024-06-30",
        amount: "120.00",
        currency: "EUR",
        cashAccountId: LIVRET,
        withholding: { amount: "36.00" },
      });
      const list = await get("/api/v1/transactions?limit=100");
      expect(list.body.items.filter((t: { kind: string }) => t.kind === "INTEREST")).toHaveLength(
        1,
      );

      const after = await get("/api/v1/dividends/summary");
      expect(after.status).toBe(200);
      expect(after.text).toBe(before.text);
    },
  );
});
