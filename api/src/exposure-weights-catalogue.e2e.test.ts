import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidIsinCheckDigit } from "@kerdial/api-contracts";
import { Decimal } from "@kerdial/core-decimal";
import { createInstrumentByIsin } from "@kerdial/ledger";
import { createUser } from "@kerdial/platform-auth";
import { instrument, instrumentPriceDaily, tenant } from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { eq } from "drizzle-orm";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * Hand-authored and exported catalogue files, through the real
 * `POST /imports/kerdial/catalogue` and `GET /exports/instruments` routes
 * (FR-742, FR-743, FR-747): each refusal case is one entry among valid ones,
 * and the export of one installation imports into a second, separate one with
 * the same allocation.
 */

const PASSWORD = "a-test-only-passphrase-weights-catalogue";
const PRICE_DATE = "2026-01-05";

type Body = Record<string, unknown>;
const w = (code: string, weight: unknown) => ({ code, weight });

async function addUser(app: TestApp, label: string): Promise<SessionCookies> {
  const tenantId = randomUUID();
  const email = `ewcat-${label}-${randomUUID()}@example.com`;
  await app.ownerDb.insert(tenant).values({ id: tenantId });
  await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
  return loginAs(supertest(app.built.app.getHttpServer()), email, PASSWORD);
}

function send(app: TestApp, as: SessionCookies) {
  const server = () => supertest(app.built.app.getHttpServer());
  return {
    get: (path: string) =>
      server()
        .get(path)
        .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`]),
    post: (path: string, body: object) =>
      server()
        .post(path)
        .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`, `${CSRF_COOKIE_NAME}=${as.csrf}`])
        .set(CSRF_HEADER_NAME, as.csrf)
        .send(body),
    patch: (path: string, body: object) =>
      server()
        .patch(path)
        .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`, `${CSRF_COOKIE_NAME}=${as.csrf}`])
        .set(CSRF_HEADER_NAME, as.csrf)
        .send(body),
    upload: (file: Buffer, mode: "DRY_RUN" | "APPLY") =>
      server()
        .post("/api/v1/imports/kerdial/catalogue")
        .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`, `${CSRF_COOKIE_NAME}=${as.csrf}`])
        .set(CSRF_HEADER_NAME, as.csrf)
        .attach("file", file, {
          filename: "kerdial-instruments.json",
          contentType: "application/json",
        })
        .field("mode", mode)
        .field("resolutions", "[]"),
    exportCatalogue: async (): Promise<{ text: string; doc: { instruments: Body[] } }> => {
      const response = await server()
        .get("/api/v1/exports/instruments")
        .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`])
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(response.status).toBe(200);
      const text = (response.body as Buffer).toString("utf8");
      return { text, doc: JSON.parse(text) as { instruments: Body[] } };
    },
  };
}

function entry(identity: Body, extra: Body = {}, scpi = false): Body {
  return {
    identity,
    private: false,
    listingCurrency: "EUR",
    displayName: `EWCAT ${String(identity["isin"] ?? identity["symbol"])}`,
    primaryIdentifier: identity["isin"] === undefined ? "SYMBOL" : "ISIN",
    quotePolicy: scpi ? "MANUAL_ONLY" : "AUTO",
    status: "ACTIVE",
    manualPrices: [],
    ...extra,
  };
}

function document(instruments: readonly Body[]): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generator: "kerdial-tester",
      exportedAt: "2026-11-16T10:00:00Z",
      baseCurrency: "EUR",
      iconsIncluded: false,
      instruments,
      portfolios: [],
      fxRatesUser: [],
    }),
    "utf8",
  );
}

describe("exposure weights — a hand-authored catalogue file over HTTP (FR-743, FR-747(b)(d))", () => {
  let app: TestApp;
  let ada: SessionCookies;

  beforeAll(async () => {
    app = await startTestApp();
    ada = await addUser(app, "hand");
  }, 180_000);
  afterAll(async () => {
    await app.stop();
  }, 30_000);

  const isin = (suffix: string) => `IE0EW${suffix.padEnd(7, "0")}`;
  const etf = (suffix: string, extra: Body) =>
    entry({ kind: "ETF", isin: isin(suffix), exchangeMic: "XPAR" }, extra);

  async function weightsOfIsin(code: string) {
    const rows = await app.ownerClient`
      SELECT w.sector_code, w.country_code, w.weight::text AS weight, w.origin::text AS origin, i.sector_code AS own_sector
      FROM instrument i LEFT JOIN instrument_exposure_weight w ON w.instrument_id = i.id
      WHERE i.isin = ${code} ORDER BY w.sector_code, w.country_code`;
    return rows;
  }

  it("each bad entry is refused alone with its own index and rule; every valid entry, whatever its kind, imports with its sets; the legacy single sector reads as 100 %", async () => {
    const entries: Body[] = [
      /* 0 */ etf("OK1", { countryWeights: [w("US", "60.00"), w("JP", "25"), w("GB", "10.5")] }),
      /* 1 */ etf("SUM105", { countryWeights: [w("US", "60.00"), w("JP", "45.00")] }),
      /* 2 */ etf("DUP", { countryWeights: [w("US", "10.00"), w("US", "20.00")] }),
      /* 3 */ etf("ZZ", { countryWeights: [w("ZZ", "10.00")] }),
      /* 4 */ etf("LOWER", { countryWeights: [w("fr", "10.00")] }),
      /* 5 */ entry(
        { kind: "SHARE", isin: isin("SHR"), exchangeMic: "XPAR" },
        { countryWeights: [w("FR", "100")] },
      ),
      /* 6 */ entry(
        { kind: "CRYPTO", symbol: "EWCATBTC" },
        { sectorWeights: [w("FINANCE", "100")] },
      ),
      /* 7 */ entry({ kind: "INDEX", symbol: "EWCATIDX" }, { countryWeights: [w("FR", "100")] }),
      /* 8 */ entry(
        { kind: "SCPI", isin: isin("SCPI1") },
        { sectorWeights: [w("SANTE", "50")] },
        true,
      ),
      /* 9 */ etf("EMPTY", { sectorWeights: [] }),
      /* 10 */ etf("COMMA", { countryWeights: [w("US", "60,00")] }),
      /* 11 */ etf("NUM", { countryWeights: [w("US", 60)] }),
      /* 12 */ entry(
        { kind: "FUND", isin: isin("FUND1"), exchangeMic: "XPAR" },
        { sectorWeights: [w("FINANCE", "40")] },
      ),
      /* 13 */ entry(
        { kind: "SCPI", isin: isin("SCPI2") },
        { countryWeights: [w("FR", "80"), w("DE", "20")] },
        true,
      ),
      /* 14 */ etf("ZERO", { countryWeights: [w("US", "0")] }),
      /* 15 */ etf("OVER", { countryWeights: [w("US", "100.01")] }),
      /* 16 */ etf("THREEDP", { countryWeights: [w("US", "12.345")] }),
      /* 17 */ etf("LEGACY", { sectorCode: "ENERGIE" }),
      /* 18 */ etf("THIRDS", {
        sectorWeights: [w("FINANCE", "33.33"), w("SANTE", "33.33"), w("ENERGIE", "33.34")],
      }),
      /* 19 */ etf("BOTH", { sectorCode: "ENERGIE", sectorWeights: [w("SANTE", "10")] }),
      /* 20 */ etf("UNKSEC", { sectorWeights: [w("NOPE", "10")] }),
      /* 21 */ etf("TOTSEC", { sectorWeights: [w("FINANCE", "60"), w("SANTE", "41")] }),
    ];
    const file = document(entries);
    const dry = await send(app, ada).upload(file, "DRY_RUN");
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    const apply = await send(app, ada).upload(file, "APPLY");
    expect(apply.status, JSON.stringify(apply.body)).toBe(200);
    expect(apply.body.applyFailed).toBe(0);

    const refused = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 20, 21];
    const rejectedAt = (apply.body.entries as { index: number; outcome: string }[])
      .filter((e) => e.outcome === "REJECT")
      .map((e) => e.index)
      .sort((a, b) => a - b);
    expect(rejectedAt).toEqual(refused);
    expect(apply.body.rejected).toBe(refused.length);
    expect(apply.body.imported).toBe(entries.length - refused.length);
    expect(dry.body.rejected).toBe(refused.length);

    // Nothing of a refused entry exists; every valid one does, with its sets.
    for (const suffix of [
      "SUM105",
      "DUP",
      "ZZ",
      "LOWER",
      "EMPTY",
      "COMMA",
      "NUM",
      "ZERO",
      "OVER",
      "THREEDP",
      "UNKSEC",
      "TOTSEC",
      "SHR",
      "SCPI1",
    ]) {
      const rows = await app.ownerClient`SELECT 1 FROM instrument WHERE isin = ${isin(suffix)}`;
      expect(rows.length, suffix).toBe(0);
    }
    const ok = await weightsOfIsin(isin("OK1"));
    expect(ok.map((r) => [r["country_code"], r["weight"]])).toEqual([
      ["GB", "10.50"],
      ["JP", "25.00"],
      ["US", "60.00"],
    ]);
    const fund = await weightsOfIsin(isin("FUND1"));
    expect(fund.map((r) => [r["sector_code"], r["weight"]])).toEqual([["FINANCE", "40.00"]]);
    const scpi = await weightsOfIsin(isin("SCPI2"));
    expect(scpi.map((r) => [r["country_code"], r["weight"]])).toEqual([
      ["DE", "20.00"],
      ["FR", "80.00"],
    ]);
    const legacy = await weightsOfIsin(isin("LEGACY"));
    expect(legacy.map((r) => [r["sector_code"], r["weight"], r["own_sector"]])).toEqual([
      ["ENERGIE", "100.00", null],
    ]);
    const thirds = await weightsOfIsin(isin("THIRDS"));
    expect(thirds.map((r) => r["weight"]).sort()).toEqual(["33.33", "33.33", "33.34"]);
    const both = await weightsOfIsin(isin("BOTH"));
    expect(both.map((r) => [r["sector_code"], r["weight"]])).toEqual([["SANTE", "10.00"]]);
    for (const row of [...ok, ...fund, ...scpi, ...legacy, ...thirds, ...both]) {
      expect(row["origin"]).toBe("MANUAL");
    }
  });

  it("re-applying the same file changes nothing; a file with a different set replaces only the dimension it names", async () => {
    const base = etf("REAPPLY", {
      sectorWeights: [w("FINANCE", "50")],
      countryWeights: [w("US", "70")],
    });
    expect((await send(app, ada).upload(document([base]), "APPLY")).status).toBe(200);
    const again = await send(app, ada).upload(document([base]), "APPLY");
    expect(again.body.imported).toBe(0);
    expect(again.body.skipped).toBe(1);
    const replaced = await send(app, ada).upload(
      document([etf("REAPPLY", { countryWeights: [w("DE", "30")] })]),
      "APPLY",
    );
    expect(replaced.body.imported).toBe(1);
    const rows = await weightsOfIsin(isin("REAPPLY"));
    expect(rows.map((r) => [r["sector_code"], r["country_code"], r["weight"]])).toEqual([
      ["FINANCE", null, "50.00"],
      [null, "DE", "30.00"],
    ]);
  });
});

describe("exposure weights — export of one installation imported into a second, then the same allocation (FR-742, FR-743)", () => {
  let source: TestApp;
  let target: TestApp;
  let sa: SessionCookies;
  let ta: SessionCookies;
  let n = 0;
  function nextIsin(): string {
    n += 1;
    const body = `ZZEWRT${String(n).padStart(5, "0")}`;
    for (let d = 0; d <= 9; d++) if (isValidIsinCheckDigit(`${body}${d}`)) return `${body}${d}`;
    throw new Error("no check digit");
  }

  beforeAll(async () => {
    source = await startTestApp();
    target = await startTestApp();
    sa = await addUser(source, "src");
    ta = await addUser(target, "tgt");
  }, 240_000);
  afterAll(async () => {
    await source.stop();
    await target.stop();
  }, 60_000);

  it("the API-written sets (incl. a converted one-sector-100 ETF and an SCPI country set) survive export -> import, and both allocations are equal", async () => {
    const api = send(source, sa);
    const created: Record<string, { id: string; isin: string }> = {};
    for (const [key, kind] of [
      ["etf", "ETF"],
      ["fund", "FUND"],
      ["scpi", "SCPI"],
      ["one", "ETF"],
    ] as const) {
      const code = nextIsin();
      const body =
        kind === "SCPI"
          ? { kind, isin: code, listingCurrency: "EUR", displayName: `EWRT ${key}` }
          : {
              kind,
              isin: code,
              exchangeMic: "XPAR",
              listingCurrency: "EUR",
              displayName: `EWRT ${key}`,
            };
      // The HTTP create route refuses a sectorCode on an ETF; the ledger creation path (importer, discovery) takes it.
      const id =
        key === "one"
          ? (
              await createInstrumentByIsin(source.db, {
                kind: "ETF",
                isin: code,
                exchangeMic: "XPAR",
                listingCurrency: "EUR",
                displayName: `EWRT ${key}`,
                sectorCode: "TECHNOLOGIE",
              })
            ).id
          : await (async () => {
              const r = await api.post("/api/v1/instruments", body);
              expect(r.status, JSON.stringify(r.body)).toBe(201);
              return r.body.id as string;
            })();
      created[key] = { id, isin: code };
      const watched = await api.post("/api/v1/watchlist", { instrumentId: id });
      expect(watched.status).toBe(200);
    }
    expect(
      (
        await api.patch(`/api/v1/instruments/${created["etf"]!.id}/exposure-weights`, {
          sectorWeights: [w("FINANCE", "30.00"), w("SANTE", "20.5")],
          countryWeights: [w("US", "60"), w("JP", "25"), w("GB", "10")],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.patch(`/api/v1/instruments/${created["fund"]!.id}/exposure-weights`, {
          sectorWeights: [w("ENERGIE", "100")],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.patch(`/api/v1/instruments/${created["scpi"]!.id}/exposure-weights`, {
          countryWeights: [w("FR", "75"), w("DE", "25")],
        })
      ).status,
    ).toBe(200);
    const one = await api.get(`/api/v1/instruments/${created["one"]!.id}`);
    expect(one.body.sectorWeights).toEqual([w("TECHNOLOGIE", "100.00")]);
    expect(one.body.sectorCode ?? null).toBeNull();

    const exported = await api.exportCatalogue();
    for (const e of exported.doc.instruments) {
      // No legacy sectorCode on a kind that carries sector weights (FR-747(d)).
      if (e["identity"] && ["ETF", "FUND"].includes((e["identity"] as Body)["kind"] as string)) {
        expect(Object.hasOwn(e, "sectorCode")).toBe(false);
      }
    }

    const imported = await send(target, ta).upload(Buffer.from(exported.text, "utf8"), "APPLY");
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(imported.body.rejected).toBe(0);
    expect(imported.body.applyFailed).toBe(0);

    // Same buys in both installations, same closes.
    async function place(app: TestApp, as: SessionCookies): Promise<string> {
      const client = send(app, as);
      const created2 = await client.post("/api/v1/portfolios", { name: "EWRT" });
      const pid = created2.body.id as string;
      await seedCashAccountsForPortfolio(app.ownerDb, pid);
      const dep = await client.post("/api/v1/transactions", {
        kind: "DEPOSIT",
        portfolioId: pid,
        tradeDate: "2026-01-02",
        amount: "20000",
        currency: "EUR",
        cashAccountId: cash(pid, "EUR"),
      });
      expect(dep.status, JSON.stringify(dep.body)).toBe(201);
      for (const key of ["etf", "fund", "scpi", "one"]) {
        const [row] = await app.ownerDb
          .select({ id: instrument.id })
          .from(instrument)
          .where(eq(instrument.isin, created[key]!.isin));
        await app.ownerDb.insert(instrumentPriceDaily).values({
          instrumentId: row!.id,
          priceDate: PRICE_DATE,
          closeRaw: new Decimal("1000"),
          currency: "EUR",
          sourceKey: "yahoo",
          quality: "EOD",
        });
        const buy = await client.post("/api/v1/transactions", {
          kind: "BUY",
          portfolioId: pid,
          instrumentId: row!.id,
          tradeDate: PRICE_DATE,
          quantity: "2",
          unitPrice: "1000",
          currency: "EUR",
          cashAccountId: cash(pid, "EUR"),
        });
        expect(buy.status, JSON.stringify(buy.body)).toBe(201);
      }
      return pid;
    }
    const sp = await place(source, sa);
    const tp = await place(target, ta);
    for (const by of ["sector", "country"]) {
      const a = (await send(source, sa).get(`/api/v1/portfolios/${sp}/allocation?by=${by}`))
        .body as Body;
      const b = (await send(target, ta).get(`/api/v1/portfolios/${tp}/allocation?by=${by}`))
        .body as Body;
      expect(b["buckets"], by).toEqual(a["buckets"]);
      expect(b["total"], by).toBe(a["total"]);
      expect(b["basis"], by).toEqual(a["basis"]);
    }
    const sectorBuckets = (
      (await send(target, ta).get(`/api/v1/portfolios/${tp}/allocation?by=sector`)).body as {
        buckets: { key: string; value: string }[];
      }
    ).buckets;
    // The converted ETF reads as its sector at 100 %: 2000 in TECHNOLOGIE, none unclassified from it.
    expect(sectorBuckets.find((b) => b.key === "TECHNOLOGIE")?.value).toBe("2000");
    expect(sectorBuckets.find((b) => b.key === "ENERGIE")?.value).toBe("2000");
  });
});
