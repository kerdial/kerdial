import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import type { MarketRuntime } from "@kerdial/market-composition";
import { createUser } from "@kerdial/platform-auth";
import {
  cashAccount,
  instrument,
  instrumentPriceDaily,
  portfolio,
  tenant,
} from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * `scpi` cycle, SC-T3 — **AC-512** (FR-623): for a tenant with no SCPI, every
 * aggregate body is byte-identical before and after the feature.
 *
 * **How "before" is known.** The golden bodies under
 * `__fixtures__/scpi-non-regression/` were captured by running **this same
 * file**, unchanged, against a throwaway export of the branch
 * point (before migration `0074`) with `SCPI_NON_REGRESSION_CAPTURE_DIR` set.
 * That mode writes the bodies and then fails on purpose, so a capture can
 * never be mistaken for a pass. Without the variable — always, in CI — the
 * bodies are compared to the goldens.
 *
 * **Deliberate recapture — `portfolio-cash`, PC-T11 (AC-589, FR-696).** Four
 * bodies were recaptured through the same capture mode on
 * `feature/portfolio-cash` after `0078` (cash in every total and in V(d),
 * PC-L1/PC-L11); every changed field is explained by the fixture's cash. The
 * EUR account holds 20000 − 3200 (the four BUYs: 500 + 1600 + 500 + 600) +
 * 12.5 + (13 − 3.9) = 16821.6 EUR at rate 1; holdings are 611 + 1663 + 523.5 +
 * 637.2 = 3434.7.
 *   - `overview`: `totalValue.amount` 3434.7 → 20256.3 (= 3434.7 + 16821.6);
 *     the additive `cash` block (`totalBase` 16821.6, one EUR line); MWR rate
 *     −0.971915… → 0.026157… (`bisection`/54 → `newton`/5): the only flow is
 *     the 20000 deposit on 2024-01-02 and the opening on 2024-01-01 is 0, so
 *     the rate is (terminal / 20000)^(365/180) − 1 and the terminal now
 *     includes the cash. Provenance, unrealised gain, day change unchanged.
 *   - `holdings`, `portfolio-holdings`: `totalValue.amount` 3434.7 → 20256.3
 *     and the same `cash` block; no holding row moves.
 *   - `value-series`: 180 of 182 `value`s rise by exactly the pre-flow cash
 *     of their date (`cash_value_base`): 0 on 01-01..01-02, 20000 on 01-03,
 *     17900 on 01-04, 16800 on 01-05..03-15, 16812.5 on 03-16..06-14, 16821.6
 *     on 06-15..06-30 (last point 20256.3 = the overview total);
 *     `netContributions` and provenance unchanged.
 * `catalogue-export`, `dividends`, `instruments`, `quote-refresh-counts` are
 * still the pre-`0074` captures, byte-equal.
 *
 * **Deliberate recapture.** `overview` only: the unavailable
 * TWR gains `"reasonCode":"ZERO_INVESTED_BASE"` before its unchanged
 * `reason` (the fixture's opening day has a zero invested base). Nothing else
 * in any body moved — checked by text replacement against the old golden.
 *
 * **Raw text, never re-serialised objects**: a key added, dropped or reordered
 * (the conditional SCPI attribute keys, a widened enum echoed somewhere) shows
 * up as a different string. The one substitution is today's ISO date, which
 * `GET /portfolios/holdings` stamps as `asOfDate` (it takes no date
 * parameter) — replaced by a placeholder in both the golden and the live body,
 * as text. The catalogue export (SC-T11) adds a second: its manifest's
 * `exportedAt` instant is the read's own clock, so the value is replaced by a
 * placeholder the same way.
 *
 * The fixture is deterministic by construction: fixed ids and timestamps for
 * every catalogue/portfolio row the bodies echo, fixed past dates for every
 * price and transaction (all ≥ 400 days old, so the stale-price flag cannot
 * flip with the calendar), EUR only (no FX feed). Transactions go through the
 * real `POST /transactions` path, sequentially.
 *
 * Allocation has no route of its own: the web computes it from
 * `/portfolios/holdings` and `/portfolios/:id/holdings`, both pinned here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(here, "__fixtures__", "scpi-non-regression");
const CAPTURE_DIR = process.env["SCPI_NON_REGRESSION_CAPTURE_DIR"];

const TENANT = "00000000-0000-7000-8000-000000512001";
const USER = "00000000-0000-7000-8000-000000512002";
const EMAIL = "scpi-ac512@example.com";
const PASSWORD = "correct horse battery staple ac512";
const PORTFOLIO = "00000000-0000-7000-8000-000000512011";
const CASH_EUR = "00000000-0000-7000-8000-000000512021";

const FIXED_AT = new Date("2024-01-01T00:00:00.000Z");
/** In every fixture display name, so the instrument list can be filtered to exactly them. */
const MARKER = "NRGFIX";

const SHARE = "00000000-0000-7000-8000-000000512101";
const ETF = "00000000-0000-7000-8000-000000512102";
const FUND_AUTO = "00000000-0000-7000-8000-000000512103";
const FUND_MANUAL = "00000000-0000-7000-8000-000000512104";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The two textual substitutions — see the header. */
function normalise(raw: string): string {
  return raw
    .replace(/"exportedAt": "[^"]*"/g, '"exportedAt": "<exportedAt>"')
    .split(todayIsoDate())
    .join("<today>");
}

describe("scpi — non-SCPI response bodies are byte-identical to the pre-feature build (AC-512)", () => {
  let testApp: TestApp;
  let session: { sid: string; csrf: string };
  const quoteRefreshEnqueued: string[] = [];

  /** A producer-shaped runtime with no provider at all: only the on-demand refresh's enqueue is observed. */
  const runtime: MarketRuntime = {
    discovery: { search: async () => [] },
    scheduler: {
      enqueueQuoteRefresh: async ({ instrumentId }: { instrumentId: string }) => {
        quoteRefreshEnqueued.push(instrumentId);
        return `job-${quoteRefreshEnqueued.length}`;
      },
      enqueueInstrumentBackfill: async () => null,
    } as unknown as MarketRuntime["scheduler"],
    enqueueBackfill: async () => {},
    async start() {},
    async stop() {},
  };

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function get(path: string) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
  }

  function post(path: string, body: Record<string, unknown> = {}) {
    return server()
      .post(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`, `${CSRF_COOKIE_NAME}=${session.csrf}`])
      .set(CSRF_HEADER_NAME, session.csrf)
      .send(body);
  }

  async function write(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await post(path, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  beforeAll(async () => {
    testApp = await startTestApp({ marketRuntime: runtime });
    const { ownerDb } = testApp;

    await ownerDb.insert(tenant).values({ id: TENANT });
    await createUser(testApp.db, { id: USER, tenantId: TENANT, email: EMAIL, password: PASSWORD });
    await ownerDb.insert(portfolio).values({
      id: PORTFOLIO,
      tenantId: TENANT,
      name: "AC-512 fixture",
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    });
    await ownerDb.insert(cashAccount).values({
      id: CASH_EUR,
      tenantId: TENANT,
      portfolioId: PORTFOLIO,
      name: "Compte EUR",
      currency: "EUR",
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    });

    const listed = (
      id: string,
      kind: "SHARE" | "ETF" | "FUND",
      symbol: string,
      exchangeMic: string,
      quotePolicy: "AUTO" | "MANUAL_ONLY",
    ) => ({
      id,
      kind,
      displayName: `${MARKER} ${kind} ${symbol}`,
      listingCurrency: "EUR",
      exchangeMic,
      symbol,
      primaryIdentifier: "SYMBOL" as const,
      quotePolicy,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    });
    await ownerDb
      .insert(instrument)
      .values([
        listed(SHARE, "SHARE", "NRGSHR", "XPAR", "AUTO"),
        listed(ETF, "ETF", "NRGETF", "XETR", "AUTO"),
        listed(FUND_AUTO, "FUND", "NRGFDA", "XPAR", "AUTO"),
        listed(FUND_MANUAL, "FUND", "NRGFDM", "XPAR", "MANUAL_ONLY"),
      ]);

    const closes: [string, string, string][] = [
      [SHARE, "2024-01-02", "50.00"],
      [SHARE, "2024-03-28", "55.25"],
      [SHARE, "2024-06-28", "61.10"],
      [ETF, "2024-01-02", "80.00"],
      [ETF, "2024-03-28", "78.40"],
      [ETF, "2024-06-28", "83.15"],
      [FUND_AUTO, "2024-01-02", "100.00"],
      [FUND_AUTO, "2024-06-28", "104.70"],
    ];
    await ownerDb.insert(instrumentPriceDaily).values(
      closes.map(([instrumentId, priceDate, close]) => ({
        instrumentId,
        priceDate,
        closeRaw: new Decimal(close),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD" as const,
      })),
    );

    session = await loginAs(server(), EMAIL, PASSWORD);

    await write(`/api/v1/instruments/${FUND_MANUAL}/prices`, {
      priceDate: "2024-01-04",
      close: "200.00",
      currency: "EUR",
    });
    await write(`/api/v1/instruments/${FUND_MANUAL}/prices`, {
      priceDate: "2024-05-31",
      close: "212.40",
      currency: "EUR",
    });

    const base = { portfolioId: PORTFOLIO, currency: "EUR", cashAccountId: CASH_EUR };
    await write("/api/v1/transactions", {
      ...base,
      kind: "DEPOSIT",
      tradeDate: "2024-01-02",
      amount: "20000",
    });
    for (const [instrumentId, tradeDate, quantity, unitPrice] of [
      [SHARE, "2024-01-03", "10", "50"],
      [ETF, "2024-01-03", "20", "80"],
      [FUND_AUTO, "2024-01-04", "5", "100"],
      [FUND_MANUAL, "2024-01-04", "3", "200"],
    ] as const) {
      await write("/api/v1/transactions", {
        ...base,
        kind: "BUY",
        instrumentId,
        tradeDate,
        quantity,
        unitPrice,
      });
    }
    await write("/api/v1/transactions", {
      ...base,
      kind: "DIVIDEND",
      instrumentId: SHARE,
      tradeDate: "2024-03-15",
      amount: "12.50",
    });
    await write("/api/v1/transactions", {
      ...base,
      kind: "DIVIDEND",
      instrumentId: SHARE,
      tradeDate: "2024-06-14",
      amount: "13.00",
      withholding: { amount: "3.90" },
    });
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  }, 30_000);

  /** Each read the AC names, by golden file name. */
  const READS: readonly (readonly [string, string])[] = [
    ["overview", "/api/v1/portfolios/overview?from=2024-01-01&to=2024-06-30"],
    ["holdings", "/api/v1/portfolios/holdings"],
    ["portfolio-holdings", `/api/v1/portfolios/${PORTFOLIO}/holdings`],
    ["value-series", "/api/v1/portfolios/value-series?from=2024-01-01&to=2024-06-30"],
    ["instruments", `/api/v1/instruments?query=${MARKER}&limit=100`],
    ["dividends", "/api/v1/dividends/summary"],
    // `scpi` SC-T11: the catalogue export of a tenant with no SCPI — the two
    // attribute keys are emitted only when set, so the body cannot move.
    ["catalogue-export", "/api/v1/exports/instruments"],
  ];

  async function liveBodies(): Promise<Map<string, string>> {
    const bodies = new Map<string, string>();
    for (const [name, path] of READS) {
      const response = await get(path);
      expect(response.status, `${name}: ${response.text}`).toBe(200);
      bodies.set(name, normalise(response.text));
    }
    const refresh = await post("/api/v1/market-data/quote-refresh");
    expect(refresh.status, refresh.text).toBe(202);
    // `requestId`/`bucket` are minted per request; the counts are the contract.
    bodies.set(
      "quote-refresh-counts",
      JSON.stringify({
        heldInstruments: refresh.body.heldInstruments,
        enqueued: refresh.body.enqueued,
      }),
    );
    return bodies;
  }

  it("is a non-trivial fixture — the comparison below cannot pass on empty bodies", async () => {
    const overview = await get("/api/v1/portfolios/overview?from=2024-01-01&to=2024-06-30");
    expect(overview.status).toBe(200);
    expect(new Decimal(overview.body.totalValue.amount).greaterThan(0)).toBe(true);
    const holdings = await get("/api/v1/portfolios/holdings");
    expect(holdings.body.holdings).toHaveLength(4);
    const dividends = await get("/api/v1/dividends/summary");
    expect(dividends.body.total.grossBase).toBe("25.5");
  });

  it("every body equals its golden (pre-0074, four recaptured for portfolio-cash), as raw text", async () => {
    const bodies = await liveBodies();

    if (CAPTURE_DIR !== undefined && CAPTURE_DIR !== "") {
      mkdirSync(CAPTURE_DIR, { recursive: true });
      for (const [name, body] of bodies) {
        writeFileSync(join(CAPTURE_DIR, `${name}.body.txt`), body);
      }
      throw new Error(
        `capture mode: ${bodies.size} goldens written to ${CAPTURE_DIR}, nothing compared`,
      );
    }

    expect([...bodies.keys()]).toHaveLength(READS.length + 1);
    for (const [name, body] of bodies) {
      const golden = readFileSync(join(GOLDEN_DIR, `${name}.body.txt`), "utf8");
      expect(body, name).toBe(golden);
    }
    // Every held kind is routed for this tenant, so the on-demand refresh
    // enqueued every held instrument — the count the golden also carries.
    expect(new Set(quoteRefreshEnqueued)).toEqual(new Set([SHARE, ETF, FUND_AUTO, FUND_MANUAL]));
  });
});
