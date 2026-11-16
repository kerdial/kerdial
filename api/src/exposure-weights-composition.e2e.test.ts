import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@kerdial/core-decimal";
import { createKerdialMcpServer, loadConfig, type ToolName } from "@kerdial/mcp";
import { createUser } from "@kerdial/platform-auth";
import {
  instrument,
  instrumentExposureWeight,
  instrumentPriceDaily,
  tenant,
} from "@kerdial/platform-db";
import { cash, seedCashAccountsForPortfolio } from "@kerdial/platform-test-support";
import { eq } from "drizzle-orm";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * Independent composition checks for the exposure weights (FR-719..FR-747):
 * the chains no single task's suite crosses, over real HTTP with the app on
 * the real `app_web` role. Own tenants, instruments and closes inserted as the
 * owner (no `POST /instruments` budget spent, no provider reached).
 */

const PASSWORD = "a-test-only-passphrase-weights-composition";
const PRICE_DATE = "2026-01-05";

type Body = Record<string, unknown>;
type Pairs = readonly (readonly [string, string])[];
type Pair = { code: string; weight: string };

const wire = (pairs: Pairs): Pair[] => pairs.map(([code, weight]) => ({ code, weight }));

interface Harness {
  readonly app: TestApp;
  server(): ReturnType<typeof supertest>;
  get(path: string, as: SessionCookies, token?: string): supertest.Test;
  write(
    method: "post" | "patch" | "delete",
    path: string,
    body: object | undefined,
    as: SessionCookies,
  ): supertest.Test;
  addUser(label: string): Promise<SessionCookies & { tenantId: string }>;
}

function harness(app: TestApp): Harness {
  const server = () => supertest(app.built.app.getHttpServer());
  return {
    app,
    server,
    get: (path, as, token) => {
      const request = server().get(path);
      return token === undefined
        ? request.set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`])
        : request.set("Authorization", `Bearer ${token}`);
    },
    write: (method, path, body, as) => {
      const request = server()
        [method](path)
        .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`, `${CSRF_COOKIE_NAME}=${as.csrf}`])
        .set(CSRF_HEADER_NAME, as.csrf);
      return body === undefined ? request : request.send(body);
    },
    addUser: async (label) => {
      const tenantId = randomUUID();
      const email = `ewc-${label}-${randomUUID()}@example.com`;
      await app.ownerDb.insert(tenant).values({ id: tenantId });
      await createUser(app.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
      return { ...(await loginAs(server(), email, PASSWORD)), tenantId };
    },
  };
}

const etfBase = {
  primaryIdentifier: "SYMBOL" as const,
  quotePolicy: "AUTO" as const,
  listingCurrency: "EUR",
  exchangeMic: "XPAR",
};

async function insertPriced(
  app: TestApp,
  rows: readonly {
    id: string;
    kind: "ETF" | "SHARE";
    name: string;
    symbol: string;
    close: string;
    sector?: string;
    domicile?: string;
  }[],
): Promise<void> {
  await app.ownerDb.insert(instrument).values(
    rows.map((r) => ({
      ...etfBase,
      id: r.id,
      kind: r.kind,
      displayName: r.name,
      symbol: r.symbol,
      ...(r.sector !== undefined && { sectorCode: r.sector as never }),
      ...(r.domicile !== undefined && { domicileCountry: r.domicile }),
    })),
  );
  await app.ownerDb.insert(instrumentPriceDaily).values(
    rows.map((r) => ({
      instrumentId: r.id,
      priceDate: PRICE_DATE,
      closeRaw: new Decimal(r.close),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD" as const,
    })),
  );
}

async function portfolioWith(
  h: Harness,
  as: SessionCookies,
  name: string,
  deposit: string,
  buys: readonly [instrumentId: string, quantity: string, unitPrice: string][],
): Promise<string> {
  const created = await h.write("post", "/api/v1/portfolios", { name }, as);
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await seedCashAccountsForPortfolio(h.app.ownerDb, id);
  const txns: Body[] = [
    { kind: "DEPOSIT", tradeDate: "2026-01-02", amount: deposit },
    ...buys.map(([instrumentId, quantity, unitPrice]) => ({
      kind: "BUY",
      instrumentId,
      tradeDate: PRICE_DATE,
      quantity,
      unitPrice,
    })),
  ];
  for (const t of txns) {
    const response = await h.write(
      "post",
      "/api/v1/transactions",
      { ...t, portfolioId: id, currency: "EUR", cashAccountId: cash(id, "EUR") },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }
  return id;
}

interface AllocBody {
  total: string;
  basis?: string;
  sharesAvailable: boolean;
  buckets: { key: string; value: string; sharePercent: string | null; holdingCount: number }[];
}
const brief = (a: AllocBody) =>
  a.buckets.map((b) => [b.key, b.value, b.sharePercent, b.holdingCount] as const);

describe("exposure weights — compositions over real HTTP (MCP relay, no stale read)", () => {
  let app: TestApp;
  let h: Harness;
  let ada: SessionCookies & { tenantId: string };
  let bob: SessionCookies & { tenantId: string };
  let mcp: Client;
  let token: string;
  const ids = {
    etf: randomUUID(),
    shareB: randomUUID(),
    etfCash: randomUUID(),
    etfFan: randomUUID(),
    shareFan: randomUUID(),
  };

  async function connect(secret: string, baseUrl: string): Promise<Client> {
    const mcpServer = createKerdialMcpServer(
      loadConfig({ KERDIAL_URL: baseUrl, KERDIAL_TOKEN: secret }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: "ew-composition", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }
  async function viaMcp(name: ToolName, args: Body = {}): Promise<Body> {
    const result = await mcp.callTool({ name, arguments: args });
    expect(result.isError === true, JSON.stringify(result.content)).toBe(false);
    return (result.structuredContent ?? {}) as Body;
  }
  async function rest(path: string, as = ada): Promise<Body> {
    const response = await h.get(path, as, as === ada ? token : undefined);
    expect(response.status, path).toBe(200);
    return response.body as Body;
  }

  beforeAll(async () => {
    app = await startTestApp();
    h = harness(app);
    ada = await h.addUser("ada");
    bob = await h.addUser("bob");
    await app.built.app.listen(0, "127.0.0.1");
    const { port } = app.built.app.getHttpServer().address() as AddressInfo;
    const minted = await h.write(
      "post",
      "/api/v1/auth/tokens",
      { label: "ewc", expiresInDays: 30, currentPassword: PASSWORD },
      ada,
    );
    expect(minted.status).toBe(201);
    token = minted.body.secret as string;
    mcp = await connect(token, `http://127.0.0.1:${port}`);
    await insertPriced(app, [
      { id: ids.etf, kind: "ETF", name: "EWC chain ETF", symbol: "EWCCHN", close: "6000" },
      {
        id: ids.shareB,
        kind: "SHARE",
        name: "EWC share B",
        symbol: "EWCSHB",
        close: "4000",
        sector: "FINANCE",
        domicile: "FR",
      },
      { id: ids.etfCash, kind: "ETF", name: "EWC cash ETF", symbol: "EWCCSH", close: "6000" },
      { id: ids.etfFan, kind: "ETF", name: "EWC fan ETF", symbol: "EWCFAN", close: "1000" },
      {
        id: ids.shareFan,
        kind: "SHARE",
        name: "EWC fan share",
        symbol: "EWCFSH",
        close: "500",
        sector: "SANTE",
        domicile: "DE",
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    await mcp?.close();
    await app.stop();
  }, 30_000);

  it("PATCH -> holdings -> allocation (combined and per portfolio) -> MCP agree after each of three writes, including a clear and a one-bucket 100 % set", async () => {
    const portfolioId = await portfolioWith(h, ada, "EWC chain", "10000", [
      [ids.etf, "1", "6000"],
      [ids.shareB, "1", "4000"],
    ]);
    const put = (body: object) =>
      h.write("patch", `/api/v1/instruments/${ids.etf}/exposure-weights`, body, ada);

    async function observe(expect_: {
      sector: Pairs;
      country: Pairs;
      basis: string;
      sectorWeights: Pairs | undefined;
      countryWeights: Pairs | undefined;
    }): Promise<void> {
      const holdingsPaths = [
        "/api/v1/portfolios/holdings",
        `/api/v1/portfolios/${portfolioId}/holdings`,
      ];
      for (const path of holdingsPaths) {
        const body = await rest(path);
        const line = (body["holdings"] as Body[]).find((x) => x["instrumentId"] === ids.etf);
        expect(line?.["sectorWeights"], path).toEqual(
          expect_.sectorWeights === undefined ? undefined : wire(expect_.sectorWeights),
        );
        expect(line?.["countryWeights"], path).toEqual(
          expect_.countryWeights === undefined ? undefined : wire(expect_.countryWeights),
        );
        const mcpHoldings = await viaMcp(
          "get_holdings",
          path.includes(portfolioId) ? { portfolioId } : {},
        );
        const mcpLine = (mcpHoldings["holdings"] as Body[]).find(
          (x) => x["instrumentId"] === ids.etf,
        );
        expect(mcpLine?.["sectorWeights"], `mcp ${path}`).toEqual(line?.["sectorWeights"]);
        expect(mcpLine?.["countryWeights"], `mcp ${path}`).toEqual(line?.["countryWeights"]);
      }
      const detail = await h.get(`/api/v1/instruments/${ids.etf}`, ada);
      expect(detail.body.sectorWeights).toEqual(
        expect_.sectorWeights === undefined ? undefined : wire(expect_.sectorWeights),
      );
      for (const by of ["sector", "country"] as const) {
        for (const scope of ["", `/${portfolioId}`]) {
          const path = `/api/v1/portfolios${scope === "" ? "" : scope}/allocation?by=${by}`;
          const api = (await rest(path)) as unknown as AllocBody;
          const viaTool = await viaMcp("get_allocation", {
            by,
            ...(scope === "" ? {} : { portfolioId }),
          });
          expect(viaTool, `mcp ${path}`).toEqual(api);
          expect(
            brief(api).map(([k, v, s]) => [k, v, s]),
            path,
          ).toEqual(
            (by === "sector" ? expect_.sector : expect_.country).map(([k, v]) => [
              k,
              v.split("|")[0],
              v.split("|")[1],
            ]),
          );
          expect(api.total).toBe("10000");
          if (by === "country") expect(api.basis, path).toBe(expect_.basis);
        }
      }
    }

    // Prime every read before any weight exists: nothing may be served stale after.
    await observe({
      sector: [
        ["FINANCE", "4000|40.00"],
        ["UNCLASSIFIED", "6000|60.00"],
      ],
      country: [
        ["FR", "4000|40.00"],
        ["UNCLASSIFIED", "6000|60.00"],
      ],
      basis: "DOMICILE",
      sectorWeights: undefined,
      countryWeights: undefined,
    });

    // 1: two dimensions, remainders kept as « unclassified » (never renormalised).
    const first = await put({
      sectorWeights: wire([
        ["TECHNOLOGIE", "55.55"],
        ["SANTE", "20.05"],
      ]),
      countryWeights: wire([
        ["LU", "70.50"],
        ["DE", "29.50"],
      ]),
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await observe({
      sector: [
        ["FINANCE", "4000|40.00"],
        ["TECHNOLOGIE", "3333|33.33"],
        ["SANTE", "1203|12.03"],
        ["UNCLASSIFIED", "1464|14.64"],
      ],
      country: [
        ["LU", "4230|42.30"],
        ["FR", "4000|40.00"],
        ["DE", "1770|17.70"],
      ],
      basis: "MIXED",
      sectorWeights: [
        ["TECHNOLOGIE", "55.55"],
        ["SANTE", "20.05"],
      ],
      countryWeights: [
        ["LU", "70.50"],
        ["DE", "29.50"],
      ],
    });

    // 2: clear sectors with [], replace the country set; the old buckets must vanish at once.
    const second = await put({ sectorWeights: [], countryWeights: wire([["DE", "100"]]) });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    await observe({
      sector: [
        ["FINANCE", "4000|40.00"],
        ["UNCLASSIFIED", "6000|60.00"],
      ],
      country: [
        ["DE", "6000|60.00"],
        ["FR", "4000|40.00"],
      ],
      basis: "MIXED",
      sectorWeights: undefined,
      countryWeights: [["DE", "100.00"]],
    });

    // 3: a single sector at 100 reads as that sector, with no « unclassified ».
    const third = await put({ sectorWeights: wire([["ENERGIE", "100"]]) });
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    await observe({
      sector: [
        ["ENERGIE", "6000|60.00"],
        ["FINANCE", "4000|40.00"],
      ],
      country: [
        ["DE", "6000|60.00"],
        ["FR", "4000|40.00"],
      ],
      basis: "MIXED",
      sectorWeights: [["ENERGIE", "100.00"]],
      countryWeights: [["DE", "100.00"]],
    });
  });

  it("weights x cash: positive cash and an overdraft keep CASH its own last bucket, never weighted, shares summing to 100.00 (server numbers pinned for the web parity test)", async () => {
    await h.write(
      "patch",
      `/api/v1/instruments/${ids.etfCash}/exposure-weights`,
      {
        countryWeights: wire([
          ["US", "60"],
          ["JP", "25"],
          ["GB", "10"],
        ]),
        sectorWeights: wire([["TECHNOLOGIE", "100"]]),
      },
      ada,
    );
    const funded = await portfolioWith(h, ada, "EWC funded", "10000", [[ids.etfCash, "1", "6000"]]);
    const overdrawn = await portfolioWith(h, ada, "EWC overdrawn", "1000", [
      [ids.etfCash, "1", "6000"],
    ]);

    const fundedCountry = (await rest(
      `/api/v1/portfolios/${funded}/allocation?by=country`,
    )) as unknown as AllocBody;
    expect(brief(fundedCountry)).toEqual([
      ["US", "3600", "36.00", 1],
      ["JP", "1500", "15.00", 1],
      ["GB", "600", "6.00", 1],
      ["UNCLASSIFIED", "300", "3.00", 1],
      ["CASH", "4000", "40.00", 0],
    ]);
    const fundedSector = (await rest(
      `/api/v1/portfolios/${funded}/allocation?by=sector`,
    )) as unknown as AllocBody;
    expect(brief(fundedSector)).toEqual([
      ["TECHNOLOGIE", "6000", "60.00", 1],
      ["CASH", "4000", "40.00", 0],
    ]);

    const od = (await rest(
      `/api/v1/portfolios/${overdrawn}/allocation?by=country`,
    )) as unknown as AllocBody;
    // total = 6000 - 5000 = 1000; the ETF is 600 %, the overdraft -500 %.
    expect(od.total).toBe("1000");
    expect(brief(od)).toEqual([
      ["US", "3600", "360.00", 1],
      ["JP", "1500", "150.00", 1],
      ["GB", "600", "60.00", 1],
      ["UNCLASSIFIED", "300", "30.00", 1],
      ["CASH", "-5000", "-500.00", 0],
    ]);
    const shares = od.buckets.reduce(
      (acc, b) => acc.plus(new Decimal(b.sharePercent!)),
      new Decimal(0),
    );
    expect(shares.toString()).toBe("100");
    const odSector = (await rest(
      `/api/v1/portfolios/${overdrawn}/allocation?by=sector`,
    )) as unknown as AllocBody;
    expect(brief(odSector)).toEqual([
      ["TECHNOLOGIE", "6000", "600.00", 1],
      ["CASH", "-5000", "-500.00", 0],
    ]);
  });

  it("tenant fan-out: one weighted ETF held in two portfolios — combined allocation equals the per-portfolio buckets summed, one merged holding", async () => {
    await h.write(
      "patch",
      `/api/v1/instruments/${ids.etfFan}/exposure-weights`,
      {
        countryWeights: wire([
          ["US", "33.33"],
          ["JP", "33.33"],
          ["GB", "33.33"],
        ]),
      },
      bob,
    );
    const p1 = await portfolioWith(h, bob, "EWC fan 1", "10000", [
      [ids.etfFan, "1", "1000"],
      [ids.shareFan, "2", "500"],
    ]);
    const p2 = await portfolioWith(h, bob, "EWC fan 2", "10000", [[ids.etfFan, "2", "1000"]]);
    const read = async (path: string) => (await rest(path, bob)) as unknown as AllocBody;
    const all = await read("/api/v1/portfolios/allocation?by=country");
    const a1 = await read(`/api/v1/portfolios/${p1}/allocation?by=country`);
    const a2 = await read(`/api/v1/portfolios/${p2}/allocation?by=country`);

    expect(all.total).toBe(new Decimal(a1.total).plus(a2.total).toString());
    const sumPer = (key: string) =>
      [a1, a2].reduce(
        (acc, a) => acc.plus(a.buckets.find((b) => b.key === key)?.value ?? "0"),
        new Decimal(0),
      );
    for (const key of ["US", "JP", "GB", "DE", "UNCLASSIFIED", "CASH"]) {
      expect(all.buckets.find((b) => b.key === key)?.value ?? "0", key).toBe(
        sumPer(key).toString(),
      );
    }
    const sharesAll = all.buckets.reduce(
      (acc, b) => acc.plus(new Decimal(b.sharePercent!)),
      new Decimal(0),
    );
    expect(sharesAll.toString()).toBe("100");
    // The ETF is one merged holding on the combined read: its buckets count it once.
    const combinedHoldings = await rest("/api/v1/portfolios/holdings", bob);
    const etfLines = (combinedHoldings["holdings"] as Body[]).filter(
      (x) => x["instrumentId"] === ids.etfFan,
    );
    expect(etfLines).toHaveLength(1);
    expect(all.buckets.find((b) => b.key === "US")?.holdingCount).toBe(1);
    expect(a1.buckets.find((b) => b.key === "US")?.holdingCount).toBe(1);
    expect(a2.buckets.find((b) => b.key === "US")?.holdingCount).toBe(1);
  });
});

describe("exposure weights — races, deletion and the provider door (real HTTP, app_web)", () => {
  let app: TestApp;
  let h: Harness;
  let ada: SessionCookies & { tenantId: string };
  let bob: SessionCookies & { tenantId: string };

  const setA = {
    sectorWeights: wire([
      ["TECHNOLOGIE", "60"],
      ["FINANCE", "40"],
    ]),
    countryWeights: wire([["US", "100"]]),
  };
  const setB = {
    sectorWeights: wire([["SANTE", "10"]]),
    countryWeights: wire([
      ["JP", "50"],
      ["DE", "30.5"],
      ["FR", "0.01"],
    ]),
  };

  async function storedOf(id: string) {
    const rows = await app.ownerDb
      .select()
      .from(instrumentExposureWeight)
      .where(eq(instrumentExposureWeight.instrumentId, id));
    const norm = (key: "sectorCode" | "countryCode") =>
      rows
        .filter((r) => r.origin === "MANUAL" && r[key] !== null)
        .map((r) => ({ code: r[key] as string, weight: new Decimal(r.weight).toFixed(2) }))
        .sort((a, b) => a.code.localeCompare(b.code));
    return { sector: norm("sectorCode"), country: norm("countryCode") };
  }
  const sortedWire = (items: Pair[]) =>
    items
      .map((i) => ({ code: i.code, weight: Number(i.weight).toFixed(2) }))
      .sort((a, b) => a.code.localeCompare(b.code));
  const whole = (set: typeof setA) => ({
    sector: sortedWire(set.sectorWeights),
    country: sortedWire(set.countryWeights),
  });

  beforeAll(async () => {
    app = await startTestApp();
    h = harness(app);
    ada = await h.addUser("race-ada");
    bob = await h.addUser("race-bob");
    // Pre-warm: every pooled connection the race will use has served a request.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => h.get("/api/v1/portfolios", i % 2 === 0 ? ada : bob)),
    );
  }, 180_000);

  afterAll(async () => {
    await app.stop();
  }, 30_000);

  async function newEtf(name: string, symbol: string): Promise<string> {
    const id = randomUUID();
    await app.ownerDb.insert(instrument).values({
      ...etfBase,
      id,
      kind: "ETF",
      displayName: name,
      symbol,
    });
    return id;
  }

  it("racing PATCHes from two sessions: after every round the stored sets are exactly one whole request, never a union, never a 500", async () => {
    const id = await newEtf("EWC race ETF", "EWCRCE");
    const path = `/api/v1/instruments/${id}/exposure-weights`;
    const outcomes = { A: 0, B: 0 };
    for (let round = 0; round < 40; round++) {
      const calls =
        round % 2 === 0
          ? [
              h.write("patch", path, setA, ada),
              h.write("patch", path, setB, bob),
              h.write("patch", path, setA, bob),
            ]
          : [
              h.write("patch", path, setB, ada),
              h.write("patch", path, setA, bob),
              h.write("patch", path, setB, bob),
            ];
      const responses = await Promise.all(calls.map((c) => c.then((r) => r)));
      for (const r of responses) expect(r.status, JSON.stringify(r.body)).toBe(200);
      const stored = await storedOf(id);
      const isA = JSON.stringify(stored) === JSON.stringify(whole(setA));
      const isB = JSON.stringify(stored) === JSON.stringify(whole(setB));
      expect(isA || isB, `round ${round}: ${JSON.stringify(stored)}`).toBe(true);
      if (isA) outcomes.A += 1;
      else outcomes.B += 1;
      // The API read agrees with the table.
      const detail = await h.get(`/api/v1/instruments/${id}`, ada);
      expect(sortedWire(detail.body.sectorWeights as Pair[])).toEqual(stored.sector);
      expect(sortedWire(detail.body.countryWeights as Pair[])).toEqual(stored.country);
    }
    // Both requests do win sometimes (otherwise the race never interleaved the order).
    expect(outcomes.A).toBeGreaterThan(0);
    expect(outcomes.B).toBeGreaterThan(0);
  });

  it("deleting a weighted instrument cascades its rows (no orphan), the next holdings read is 200; a held weighted instrument is a 409 and keeps its weights", async () => {
    const free = await newEtf("EWC deletable ETF", "EWCDEL");
    const held = await newEtf("EWC held ETF", "EWCHLD");
    await app.ownerDb.insert(instrumentPriceDaily).values({
      instrumentId: held,
      priceDate: PRICE_DATE,
      closeRaw: new Decimal("100"),
      currency: "EUR",
      sourceKey: "yahoo",
      quality: "EOD",
    });
    for (const id of [free, held]) {
      const r = await h.write("patch", `/api/v1/instruments/${id}/exposure-weights`, setA, ada);
      expect(r.status).toBe(200);
    }
    await portfolioWith(h, ada, "EWC delete", "1000", [[held, "1", "100"]]);
    expect(await storedOf(free)).toEqual(whole(setA));

    const del = await h.write("delete", `/api/v1/instruments/${free}`, undefined, ada);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const orphans = await app.ownerClient`
      SELECT count(*)::int AS n FROM instrument_exposure_weight WHERE instrument_id = ${free}::uuid`;
    expect(orphans[0]!["n"]).toBe(0);
    expect((await h.get(`/api/v1/instruments/${free}`, ada)).status).toBe(404);
    const holdings = await h.get("/api/v1/portfolios/holdings", ada);
    expect(holdings.status).toBe(200);
    const alloc = await h.get("/api/v1/portfolios/allocation?by=country", ada);
    expect(alloc.status).toBe(200);

    const blocked = await h.write("delete", `/api/v1/instruments/${held}`, undefined, ada);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("INSTRUMENT_DELETE_BLOCKED_BY_LEDGER");
    expect(await storedOf(held)).toEqual(whole(setA));
  });

  it("provider door: a hand-inserted PROVIDER row is invisible to the instrument reads, holdings, allocation and the catalogue export, and a MANUAL write neither touches nor trips on it", async () => {
    const withManual = await newEtf("EWC provider beside manual", "EWCPRM");
    const providerOnly = await newEtf("EWC provider only", "EWCPRO");
    for (const id of [withManual, providerOnly]) {
      await app.ownerDb.insert(instrumentPriceDaily).values({
        instrumentId: id,
        priceDate: PRICE_DATE,
        closeRaw: new Decimal("1000"),
        currency: "EUR",
        sourceKey: "yahoo",
        quality: "EOD",
      });
    }
    const manual = await h.write(
      "patch",
      `/api/v1/instruments/${withManual}/exposure-weights`,
      {
        countryWeights: wire([["US", "100"]]),
      },
      ada,
    );
    expect(manual.status).toBe(200);
    await app.ownerDb.insert(instrumentExposureWeight).values([
      {
        instrumentId: withManual,
        origin: "PROVIDER",
        countryCode: "FR",
        weight: new Decimal("100"),
      },
      {
        instrumentId: withManual,
        origin: "PROVIDER",
        sectorCode: "ENERGIE",
        weight: new Decimal("100"),
      },
      {
        instrumentId: providerOnly,
        origin: "PROVIDER",
        countryCode: "FR",
        weight: new Decimal("100"),
      },
      {
        instrumentId: providerOnly,
        origin: "PROVIDER",
        sectorCode: "ENERGIE",
        weight: new Decimal("100"),
      },
    ] as never);
    const portfolioId = await portfolioWith(h, ada, "EWC provider door", "5000", [
      [withManual, "1", "1000"],
      [providerOnly, "1", "1000"],
    ]);

    for (const path of [
      `/api/v1/instruments/${withManual}`,
      `/api/v1/instruments/${providerOnly}`,
    ]) {
      const body = (await h.get(path, ada)).body as Body;
      if (path.endsWith(withManual)) {
        expect(body["countryWeights"]).toEqual(wire([["US", "100.00"]]));
      } else {
        expect(Object.hasOwn(body, "countryWeights")).toBe(false);
      }
      expect(Object.hasOwn(body, "sectorWeights")).toBe(false);
    }
    const list = (await h.get("/api/v1/instruments?query=EWC%20provider", ada)).body
      .items as Body[];
    expect(list.find((i) => i["id"] === providerOnly)?.["countryWeights"]).toBeUndefined();
    expect(list.find((i) => i["id"] === withManual)?.["countryWeights"]).toEqual(
      wire([["US", "100.00"]]),
    );

    const holdings = (await h.get(`/api/v1/portfolios/${portfolioId}/holdings`, ada)).body
      .holdings as Body[];
    expect(
      holdings.find((x) => x["instrumentId"] === providerOnly)?.["countryWeights"],
    ).toBeUndefined();
    expect(
      holdings.find((x) => x["instrumentId"] === providerOnly)?.["sectorWeights"],
    ).toBeUndefined();
    const country = (await h.get(`/api/v1/portfolios/${portfolioId}/allocation?by=country`, ada))
      .body as AllocBody;
    expect(brief(country)).toEqual([
      ["US", "1000", "20.00", 1],
      ["UNCLASSIFIED", "1000", "20.00", 1],
      ["CASH", "3000", "60.00", 0],
    ]);
    const sector = (await h.get(`/api/v1/portfolios/${portfolioId}/allocation?by=sector`, ada))
      .body as AllocBody;
    expect(brief(sector).map(([k]) => k)).toEqual(["UNCLASSIFIED", "CASH"]);

    const exported = await h
      .get("/api/v1/exports/instruments", ada)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    const doc = JSON.parse((exported.body as Buffer).toString("utf8")) as { instruments: Body[] };
    const entry = (name: string) => doc.instruments.find((i) => i["displayName"] === name)!;
    expect(entry("EWC provider beside manual")["countryWeights"]).toEqual(wire([["US", "100.00"]]));
    expect(Object.hasOwn(entry("EWC provider beside manual"), "sectorWeights")).toBe(false);
    expect(Object.hasOwn(entry("EWC provider only"), "countryWeights")).toBe(false);
    expect(Object.hasOwn(entry("EWC provider only"), "sectorWeights")).toBe(false);

    // A MANUAL write onto the very bucket a PROVIDER row holds is not a duplicate, and leaves it.
    const overlap = await h.write(
      "patch",
      `/api/v1/instruments/${withManual}/exposure-weights`,
      {
        countryWeights: wire([["FR", "50"]]),
      },
      ada,
    );
    expect(overlap.status, JSON.stringify(overlap.body)).toBe(200);
    const providerRows = await app.ownerClient`
      SELECT count(*)::int AS n FROM instrument_exposure_weight
      WHERE instrument_id = ${withManual}::uuid AND origin = 'PROVIDER'`;
    expect(providerRows[0]!["n"]).toBe(2);
  });
});
