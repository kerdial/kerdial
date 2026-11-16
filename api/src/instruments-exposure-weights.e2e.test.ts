import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidIsinCheckDigit } from "@kerdial/api-contracts";
import { createUser } from "@kerdial/platform-auth";
import { instrument, instrumentExposureWeight, tenant } from "@kerdial/platform-db";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs, type SessionCookies } from "./test-support/http.js";

/**
 * EW-T10 / EW-T11 (GATE-2) — `PATCH /instruments/:id/exposure-weights` and the
 * weight sets on `InstrumentResponse`, over real HTTP, with the app connected
 * as the real **`app_web`** role (`test-app.ts`). Every invariant the one
 * writer holds is pinned here through the route: the set round trip (AC-617),
 * one request per distinct refusal code with the stored set read back
 * unchanged (AC-618), atomicity across dimensions (AC-619), the kind gate for
 * every kind and dimension (AC-620), nothing else writes a weight (AC-621),
 * the domicile route's charset rule (AC-642), shared-catalogue reads across
 * tenants (AC-648(a)) and the single-sector refusal on a sector-weighted kind
 * (AC-651, EW-L18). The race is the ledger suite's; the token refusal is
 * `token-auth.e2e.test.ts`'s sweep over every non-GET route.
 */

const PASSWORD = "correct horse battery staple exposure weights";

let isinCounter = 0;
/** A unique synthetic ISIN (`ZZ` is no ISO 3166 prefix), its check digit found by the shipped validator. */
function nextSyntheticIsin(): string {
  isinCounter += 1;
  const body = `ZZEWGT${String(isinCounter).padStart(5, "0")}`;
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${body}${checkDigit}`;
    if (isValidIsinCheckDigit(candidate)) return candidate;
  }
  throw new Error(`nextSyntheticIsin: no valid check digit for ${body}`);
}

type Weights = readonly { code: string; weight: string }[];

describe("api — PATCH /instruments/:id/exposure-weights and InstrumentResponse weights (EW-T10, GATE-2)", () => {
  let testApp: TestApp;
  let alice: SessionCookies;
  let bob: SessionCookies;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  function write(method: "post" | "patch", path: string, body: unknown, as = alice) {
    return server()
      [method](path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`, `${CSRF_COOKIE_NAME}=${as.csrf}`])
      .set(CSRF_HEADER_NAME, as.csrf)
      .send(body as object);
  }

  function get(path: string, as = alice) {
    return server()
      .get(path)
      .set("Cookie", [`${SID_COOKIE_NAME}=${as.sid}`]);
  }

  function putWeights(id: string, body: unknown) {
    return write("patch", `/api/v1/instruments/${id}/exposure-weights`, body);
  }

  async function create(kind: string, displayName: string): Promise<string> {
    const body =
      kind === "CRYPTO" || kind === "INDEX"
        ? { kind, symbol: `EWG${isinCounter++}${kind}`, listingCurrency: "EUR", displayName }
        : kind === "SCPI"
          ? { kind, isin: nextSyntheticIsin(), listingCurrency: "EUR", displayName }
          : {
              kind,
              isin: nextSyntheticIsin(),
              exchangeMic: "XPAR",
              listingCurrency: "EUR",
              displayName,
            };
    const response = await write("post", "/api/v1/instruments", body);
    expect(response.status, response.text).toBe(201);
    return response.body.id as string;
  }

  /** The stored sets, read through a fresh `GET /instruments/:id` (never the write's own response). */
  async function readBack(id: string, as = alice) {
    const response = await get(`/api/v1/instruments/${id}`, as);
    expect(response.status).toBe(200);
    return {
      sectorWeights: response.body.sectorWeights as Weights | undefined,
      countryWeights: response.body.countryWeights as Weights | undefined,
    };
  }

  async function addUser(label: string): Promise<SessionCookies> {
    const tenantId = randomUUID();
    const email = `ew-${label}-${randomUUID()}@example.com`;
    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: randomUUID(), tenantId, email, password: PASSWORD });
    return loginAs(server(), email, PASSWORD);
  }

  beforeAll(async () => {
    testApp = await startTestApp();
    alice = await addUser("alice");
    bob = await addUser("bob");
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("AC-617: a country set round-trips on the write, the detail and the list, as strings in weight order; [] reads absent again", async () => {
    const id = await create("ETF", "EW AC-617 ETF");
    const set = [
      { code: "JP", weight: "25.00" },
      { code: "US", weight: "60" },
      { code: "GB", weight: "10.0" },
    ];
    const expected = [
      { code: "US", weight: "60.00" },
      { code: "JP", weight: "25.00" },
      { code: "GB", weight: "10.00" },
    ];

    const written = await putWeights(id, { countryWeights: set });
    expect(written.status, written.text).toBe(200);
    expect(written.body.countryWeights).toEqual(expected);
    expect(Object.hasOwn(written.body, "sectorWeights")).toBe(false);

    const detail = await get(`/api/v1/instruments/${id}`);
    expect(detail.body.countryWeights).toEqual(expected);
    expect(Object.hasOwn(detail.body, "sectorWeights")).toBe(false);

    const list = await get(`/api/v1/instruments?query=${encodeURIComponent("EW AC-617 ETF")}`);
    const row = (list.body.items as Record<string, unknown>[]).find((item) => item["id"] === id);
    expect(row?.["countryWeights"]).toEqual(expected);
    expect(Object.hasOwn(row ?? {}, "sectorWeights")).toBe(false);

    const cleared = await putWeights(id, { countryWeights: [] });
    expect(cleared.status).toBe(200);
    expect(Object.hasOwn(cleared.body, "countryWeights")).toBe(false);
    const after = await get(`/api/v1/instruments/${id}`);
    expect(Object.hasOwn(after.body, "countryWeights")).toBe(false);
    expect(Object.hasOwn(after.body, "sectorWeights")).toBe(false);
  });

  describe("AC-618, AC-642: one request per distinct refusal, the stored set unchanged after each", () => {
    let id: string;
    const stored = [{ code: "DE", weight: "40.00" }];

    beforeAll(async () => {
      id = await create("ETF", "EW AC-618 ETF");
      expect((await putWeights(id, { countryWeights: stored })).status).toBe(200);
    });

    it.each([
      [
        "a total of 105",
        {
          countryWeights: [
            { code: "US", weight: "60" },
            { code: "JP", weight: "30" },
            { code: "GB", weight: "15" },
          ],
        },
        "EXPOSURE_WEIGHT_TOTAL_ABOVE_100",
        { field: "countryWeights", index: 2 },
      ],
      [
        "a repeated bucket",
        {
          countryWeights: [
            { code: "US", weight: "30" },
            { code: "US", weight: "30" },
          ],
        },
        "EXPOSURE_WEIGHT_DUPLICATE_BUCKET",
        { field: "countryWeights", index: 1 },
      ],
      [
        "a weight of 100.01",
        { countryWeights: [{ code: "US", weight: "100.01" }] },
        "EXPOSURE_WEIGHT_OUT_OF_RANGE",
        { field: "countryWeights", index: 0 },
      ],
      [
        "an unassigned country ZZ",
        { countryWeights: [{ code: "ZZ", weight: "10" }] },
        "EXPOSURE_WEIGHT_UNKNOWN_BUCKET",
        { field: "countryWeights", index: 0 },
      ],
      [
        "a lower-case country fr",
        { countryWeights: [{ code: "fr", weight: "10" }] },
        "EXPOSURE_WEIGHT_UNKNOWN_BUCKET",
        { field: "countryWeights", index: 0 },
      ],
      [
        "an unknown sector TECH",
        { sectorWeights: [{ code: "TECH", weight: "10" }] },
        "EXPOSURE_WEIGHT_UNKNOWN_BUCKET",
        { field: "sectorWeights", index: 0 },
      ],
    ])("%s → 400 %s", async (_label, body, code, params) => {
      const response = await putWeights(id, body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(code);
      expect(response.body.params).toEqual(params);
      expect(await readBack(id)).toEqual({ sectorWeights: undefined, countryWeights: stored });
    });

    it("a malformed body (a JSON-number weight, an unknown key, no key) is 400 VALIDATION_ERROR", async () => {
      for (const body of [
        { countryWeights: [{ code: "US", weight: 10 }] },
        { countryWeights: [], domicileCountry: "FR" },
        {},
      ]) {
        const response = await putWeights(id, body);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("VALIDATION_ERROR");
      }
      expect(await readBack(id)).toEqual({ sectorWeights: undefined, countryWeights: stored });
    });

    it("FR is accepted (AC-642's write-API half)", async () => {
      const response = await putWeights(id, { countryWeights: [{ code: "FR", weight: "10" }] });
      expect(response.status).toBe(200);
      expect(response.body.countryWeights).toEqual([{ code: "FR", weight: "10.00" }]);
    });

    it("an unknown instrument is 404 INSTRUMENT_NOT_FOUND", async () => {
      const response = await putWeights(randomUUID(), { countryWeights: [] });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("INSTRUMENT_NOT_FOUND");
    });
  });

  it("AC-619: a valid sector set with an invalid country set stores neither; naming only the sector set leaves the country set", async () => {
    const id = await create("FUND", "EW AC-619 fund");
    const sector = [{ code: "FINANCE", weight: "50.00" }];
    const country = [{ code: "FR", weight: "80.00" }];
    expect((await putWeights(id, { sectorWeights: sector, countryWeights: country })).status).toBe(
      200,
    );

    const refused = await putWeights(id, {
      sectorWeights: [{ code: "ENERGIE", weight: "20" }],
      countryWeights: [
        { code: "US", weight: "60" },
        { code: "JP", weight: "30" },
        { code: "GB", weight: "15" },
      ],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("EXPOSURE_WEIGHT_TOTAL_ABOVE_100");
    expect(await readBack(id)).toEqual({ sectorWeights: sector, countryWeights: country });

    const sectorOnly = await putWeights(id, { sectorWeights: [{ code: "ENERGIE", weight: "20" }] });
    expect(sectorOnly.status).toBe(200);
    expect(await readBack(id)).toEqual({
      sectorWeights: [{ code: "ENERGIE", weight: "20.00" }],
      countryWeights: country,
    });
  });

  describe("AC-620: the kind gate, one accept or refuse row per kind and dimension, with valid sets", () => {
    const ids = new Map<string, string>();
    beforeAll(async () => {
      for (const kind of ["ETF", "FUND", "SCPI", "SHARE", "CRYPTO", "INDEX"]) {
        ids.set(kind, await create(kind, `EW AC-620 ${kind}`));
      }
    });

    it.each([
      ["ETF", "sectorWeights", true],
      ["ETF", "countryWeights", true],
      ["FUND", "sectorWeights", true],
      ["FUND", "countryWeights", true],
      ["SCPI", "sectorWeights", false],
      ["SCPI", "countryWeights", true],
      ["SHARE", "sectorWeights", false],
      ["SHARE", "countryWeights", false],
      ["CRYPTO", "sectorWeights", false],
      ["CRYPTO", "countryWeights", false],
      ["INDEX", "sectorWeights", false],
      ["INDEX", "countryWeights", false],
    ] as const)("%s %s: accepted = %s", async (kind, field, accepted) => {
      const set =
        field === "sectorWeights"
          ? [{ code: "INDUSTRIE", weight: "30.00" }]
          : [{ code: "IT", weight: "30.00" }];
      const response = await putWeights(ids.get(kind)!, { [field]: set });
      if (accepted) {
        expect(response.status, response.text).toBe(200);
        expect(response.body[field]).toEqual(set);
      } else {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("EXPOSURE_WEIGHTS_NOT_APPLICABLE");
        expect(response.body.params).toEqual({ field });
        expect(
          Object.hasOwn((await get(`/api/v1/instruments/${ids.get(kind)!}`)).body, field),
        ).toBe(false);
      }
    });
  });

  it("AC-621: creating an ETF and editing its classification writes no weight", async () => {
    const id = await create("ETF", "EW AC-621 ETF");
    const classified = await write("patch", `/api/v1/instruments/${id}/classification`, {
      domicileCountry: "IE",
      industryLabel: "Broad market",
    });
    expect(classified.status, classified.text).toBe(200);
    const rows = await testApp.ownerDb
      .select()
      .from(instrumentExposureWeight)
      .where(eq(instrumentExposureWeight.instrumentId, id));
    expect(rows).toEqual([]);
  });

  it("AC-642 (domicile half, EW-L7): the classification route keeps accepting any two upper-case letters — XK is stored", async () => {
    const id = await create("SHARE", "EW AC-642 share");
    const response = await write("patch", `/api/v1/instruments/${id}/classification`, {
      domicileCountry: "XK",
    });
    expect(response.status, response.text).toBe(200);
    const [row] = await testApp.ownerDb.select().from(instrument).where(eq(instrument.id, id));
    expect(row?.domicileCountry).toBe("XK");
  });

  it("AC-648(a): a set written in one tenant's session is read by another tenant's session (shared catalogue)", async () => {
    const id = await create("ETF", "EW AC-648 ETF");
    const set = [{ code: "CA", weight: "70.00" }];
    expect((await putWeights(id, { countryWeights: set })).status).toBe(200);
    expect(await readBack(id, bob)).toEqual({ sectorWeights: undefined, countryWeights: set });
  });

  it("AC-651 (EW-L18): a single sector on an ETF is refused by the classification route and nothing changes; null is accepted", async () => {
    const id = await create("ETF", "EW AC-651 ETF");
    const sector = [{ code: "TECHNOLOGIE", weight: "100.00" }];
    expect((await putWeights(id, { sectorWeights: sector })).status).toBe(200);

    const refused = await write("patch", `/api/v1/instruments/${id}/classification`, {
      sectorCode: "FINANCE",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE");
    const [row] = await testApp.ownerDb.select().from(instrument).where(eq(instrument.id, id));
    expect(row?.sectorCode).toBeNull();
    expect(await readBack(id)).toEqual({ sectorWeights: sector, countryWeights: undefined });

    const cleared = await write("patch", `/api/v1/instruments/${id}/classification`, {
      sectorCode: null,
    });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.sectorCode).toBeNull();
    expect(cleared.body.sectorWeights).toEqual(sector);
  });
});
