import { randomUUID } from "node:crypto";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderCircuitOpenError, type MarketRuntime } from "@kerdial/market-composition";
import {
  ProviderMalformedResponse,
  ProviderRateLimited,
  ProviderUnavailable,
  type ProviderSymbolMatch,
} from "@kerdial/market-ports";
import { PROVIDER_SECTOR_TO_CODE } from "@kerdial/core-reference-data";
import { tenant } from "@kerdial/platform-db";
import { createUser } from "@kerdial/platform-auth";
import { startTestApp, type TestApp } from "./test-support/test-app.js";
import { SID_COOKIE_NAME } from "./auth/cookies.js";
import { loginAs } from "./test-support/http.js";

/**
 * IC-11 — `GET /instruments/discovery`: candidate-shape mapping, DD8's full
 * error-mapping table (each row asserted on **both** HTTP status and the
 * machine-readable `code` — AC-7), the route-shadowing behavioral proof, the
 * `MARKET_RUNTIME === null` degraded case, and the per-tenant rate cap (DD7;
 * its concurrency sibling was retired by ADR-0016). Each scenario logs in as a
 * **freshly created tenant/user** so the per-tenant rate budget never bleeds
 * across unrelated assertions in this same file.
 */

type DiscoverySearchFn = MarketRuntime["discovery"]["search"];

function fakeMarketRuntime(search: DiscoverySearchFn): MarketRuntime {
  return {
    discovery: { search },
    scheduler: null,
    enqueueBackfill: async () => {},
    async start() {},
    async stop() {},
  };
}

/**
 * The provider's own label for a Kerdial code, **read out of
 * `PROVIDER_SECTOR_TO_CODE` at run time rather than spelled out here**: FR-2
 * allows that vocabulary to appear as text only in
 * `core/reference-data/src/sector.ts` and `market/adapters` (where captured
 * payloads live), and `classification-vocabulary-containment.test.ts` enforces
 * it repo-wide, this file included.
 */
function providerLabelFor(code: string): string {
  const entry = Object.entries(PROVIDER_SECTOR_TO_CODE).find(([, mapped]) => mapped === code);
  if (entry === undefined) throw new Error(`no provider label maps to ${code}`);
  return entry[0];
}

/** The provider label that maps to ENERGIE, and the code it maps to. */
const ENERGY_CODE = "ENERGIE";
const ENERGY_LABEL = providerLabelFor(ENERGY_CODE);

const SHARE_CANDIDATE: ProviderSymbolMatch = {
  providerSymbol: "TTE.PA",
  displayName: "TotalEnergies SE",
  currency: "EUR",
  matchQuality: "PROBABLE",
  providerExchangeCode: "PAR",
  // IR-10 (`instrument-reference-data`): the provider's own classification
  // labels, which the DTO maps (sector) and passes through (industry) for a
  // SHARE query only.
  providerSectorLabel: ENERGY_LABEL,
  providerIndustryLabel: "Oil & Gas Integrated",
};

/** Same candidate, with a provider sector `PROVIDER_SECTOR_TO_CODE` does not know (FR-3). */
const UNMAPPED_SECTOR_CANDIDATE: ProviderSymbolMatch = {
  ...SHARE_CANDIDATE,
  providerSectorLabel: "Widget Conglomerates",
};

const CRYPTO_CANDIDATE: ProviderSymbolMatch = {
  providerSymbol: "bitcoin",
  displayName: "Bitcoin",
  currency: "USD",
  matchQuality: "EXACT",
  tickerSymbol: "BTC",
  // Deliberately set even though a CRYPTO query must emit neither field —
  // an omission the mapper has to make, not one the fixture makes for it.
  providerSectorLabel: ENERGY_LABEL,
  providerIndustryLabel: "Oil & Gas Integrated",
};

/**
 * F-5 (security review): the exact shape a real adapter's HTTP transport
 * produces — `yahoo/http-fetcher.ts`'s `fetchSearch` builds
 * `ProviderUnavailable`'s own `message` from the literal upstream URL it
 * just called, query string (this tenant's own search text) included.
 * `URL_LEAK_MARKER` stands in for that query string here.
 */
const URL_LEAK_MARKER = "URL-LEAK-MARKER-f5b2b6";

/** Dispatches on `query` magic strings so one fake runtime can drive every DD8 row plus the happy-path candidate shapes. */
const mainSearch: DiscoverySearchFn = async ({ kind, query }) => {
  if (query === "RATE_LIMIT_TRIGGER") throw new ProviderRateLimited("yahoo", 3);
  if (query === "UNAVAILABLE_TRIGGER") throw new ProviderUnavailable("yahoo");
  if (query === "MALFORMED_TRIGGER") throw new ProviderMalformedResponse("yahoo");
  if (query === "CIRCUIT_OPEN_TRIGGER") throw new ProviderCircuitOpenError("yahoo");
  if (query === "URL_LEAK_TRIGGER") {
    throw new ProviderUnavailable(
      "yahoo",
      `https://query1.finance.yahoo.com/v1/finance/search?q=${URL_LEAK_MARKER} responded with HTTP 500`,
    );
  }
  if (query === "NO_MATCH_TRIGGER") return [];
  if (query === "UNMAPPED_SECTOR_TRIGGER") return [UNMAPPED_SECTOR_CANDIDATE];
  if (kind === "CRYPTO") return [CRYPTO_CANDIDATE];
  return [SHARE_CANDIDATE];
};

const userPassword = "correct horse battery staple ic11 discovery";

describe("api — GET /instruments/discovery (IC-11)", () => {
  describe("candidate shape, DD8 error mapping, route shadowing (MARKET_RUNTIME present)", () => {
    let testApp: TestApp;

    function server(): ReturnType<typeof supertest> {
      return supertest(testApp.built.app.getHttpServer());
    }

    async function loginNewTenant(label: string): Promise<{ sid: string }> {
      const tenantId = randomUUID();
      const email = `ic11-${label}-${randomUUID()}@example.com`;
      await testApp.ownerDb.insert(tenant).values({ id: tenantId });
      await createUser(testApp.db, {
        id: randomUUID(),
        tenantId,
        email,
        password: userPassword,
      });
      return loginAs(server(), email, userPassword);
    }

    function get(path: string, session: { sid: string }) {
      return server()
        .get(path)
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
    }

    beforeAll(async () => {
      testApp = await startTestApp({ marketRuntime: fakeMarketRuntime(mainSearch) });
    }, 120_000);

    afterAll(async () => {
      await testApp.stop();
    }, 30_000);

    it("AC-1/FR-1/FR-4: a SHARE query returns a candidate with displayName, providerSymbol, and a populated exchangeHint.suggestedMic", async () => {
      const session = await loginNewTenant("share");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=totalenergies",
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      const item = response.body.items[0];
      expect(item.displayName).toBe("TotalEnergies SE");
      expect(item.providerSymbol).toBe("TTE.PA");
      expect(item.exchangeHint).toEqual({ code: "PAR", suggestedMic: "XPAR" });
    });

    it("AC-2/FR-2/FR-3: a CRYPTO query returns a candidate with displayName and tickerSymbol, distinct from the raw coin id", async () => {
      const session = await loginNewTenant("crypto");
      const response = await get(
        "/api/v1/instruments/discovery?kind=CRYPTO&query=bitcoin",
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toHaveLength(1);
      const item = response.body.items[0];
      expect(item.displayName).toBe("Bitcoin");
      expect(item.tickerSymbol).toBe("BTC");
      expect(item.providerSymbol).toBe("bitcoin");
      expect(item.tickerSymbol).not.toBe(item.providerSymbol);
    });

    it("AC-4/FR-4: no response ever includes a bare exchangeMic field — verified structurally", async () => {
      const session = await loginNewTenant("no-exchangemic");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=totalenergies",
        session,
      );
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('exchangeMic":');
      // exchangeHint IS present — only the bare field is forbidden.
      expect(response.body.items[0].exchangeHint).toBeDefined();
    });

    it("IR-10/FR-3: a SHARE response carries the MAPPED Kerdial sector code and the industry label — never the raw provider string", async () => {
      const session = await loginNewTenant("ir10-share-sector");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=totalenergies",
        session,
      );
      expect(response.status).toBe(200);
      const item = response.body.items[0];
      expect(item.sectorCode).toBe(ENERGY_CODE);
      expect(item.industryLabel).toBe("Oil & Gas Integrated");
      expect(JSON.stringify(response.body)).not.toContain(ENERGY_LABEL);
    });

    it("IR-10/FR-3: an unmapped provider sector yields sectorCode: null — never a fallback code, never the raw string", async () => {
      const session = await loginNewTenant("ir10-unmapped-sector");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=UNMAPPED_SECTOR_TRIGGER",
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.items[0].sectorCode).toBeNull();
      expect(JSON.stringify(response.body)).not.toContain("Widget Conglomerates");
    });

    it("IR-10/FR-7: a CRYPTO response carries neither classification field at all — asserted structurally", async () => {
      const session = await loginNewTenant("ir10-crypto-no-sector");
      const response = await get(
        "/api/v1/instruments/discovery?kind=CRYPTO&query=bitcoin",
        session,
      );
      expect(response.status).toBe(200);
      expect(Object.keys(response.body.items[0])).not.toContain("sectorCode");
      expect(Object.keys(response.body.items[0])).not.toContain("industryLabel");
      expect(JSON.stringify(response.body)).not.toContain("sectorCode");
      expect(JSON.stringify(response.body)).not.toContain("industryLabel");
    });

    it("empty results (SymbolNotFound's substance): 200 items: [] — not an error", async () => {
      const session = await loginNewTenant("empty");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=NO_MATCH_TRIGGER",
        session,
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([]);
    });

    describe("DD8 error-mapping table — each row asserted on BOTH status and code (AC-7)", () => {
      it("ProviderRateLimited -> 429 DISCOVERY_PROVIDER_RATE_LIMITED, with Retry-After", async () => {
        const session = await loginNewTenant("dd8-ratelimited");
        const response = await get(
          "/api/v1/instruments/discovery?kind=SHARE&query=RATE_LIMIT_TRIGGER",
          session,
        );
        expect(response.status).toBe(429);
        expect(response.body.code).toBe("DISCOVERY_PROVIDER_RATE_LIMITED");
        expect(response.headers["retry-after"]).toBe("3");
        expect(response.headers["content-type"]).toContain("application/problem+json");
      });

      it("ProviderUnavailable -> 503 DISCOVERY_PROVIDER_UNAVAILABLE", async () => {
        const session = await loginNewTenant("dd8-unavailable");
        const response = await get(
          "/api/v1/instruments/discovery?kind=SHARE&query=UNAVAILABLE_TRIGGER",
          session,
        );
        expect(response.status).toBe(503);
        expect(response.body.code).toBe("DISCOVERY_PROVIDER_UNAVAILABLE");
      });

      it("ProviderCircuitOpenError -> 503 DISCOVERY_PROVIDER_UNAVAILABLE (same code as a plain outage)", async () => {
        const session = await loginNewTenant("dd8-circuitopen");
        const response = await get(
          "/api/v1/instruments/discovery?kind=SHARE&query=CIRCUIT_OPEN_TRIGGER",
          session,
        );
        expect(response.status).toBe(503);
        expect(response.body.code).toBe("DISCOVERY_PROVIDER_UNAVAILABLE");
      });

      it("ProviderMalformedResponse -> 502 DISCOVERY_PROVIDER_MALFORMED", async () => {
        const session = await loginNewTenant("dd8-malformed");
        const response = await get(
          "/api/v1/instruments/discovery?kind=SHARE&query=MALFORMED_TRIGGER",
          session,
        );
        expect(response.status).toBe(502);
        expect(response.body.code).toBe("DISCOVERY_PROVIDER_MALFORMED");
      });
    });

    it("F-5 RED-CONFIRM (security review): the upstream URL/query string in a provider error's own message never reaches the client's detail — the code is unchanged", async () => {
      const session = await loginNewTenant("f5-url-leak");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=URL_LEAK_TRIGGER",
        session,
      );
      expect(response.status).toBe(503);
      // The DD8 code contract is untouched by this fix.
      expect(response.body.code).toBe("DISCOVERY_PROVIDER_UNAVAILABLE");
      // The whole point: neither the query string nor the upstream host
      // ever appears anywhere in the response body.
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(URL_LEAK_MARKER);
      expect(body).not.toContain("query1.finance.yahoo.com");
      expect(body).not.toContain("http");
    });

    it("route-shadowing: /instruments/discovery reaches the discovery handler, never @Get(':id')'s parseIdParam (which would 400 INVALID_ID on a non-UUID path segment)", async () => {
      const session = await loginNewTenant("shadowing");
      const response = await get(
        "/api/v1/instruments/discovery?kind=SHARE&query=totalenergies",
        session,
      );
      // The failure mode a shadowing bug would produce: 400 INVALID_ID.
      expect(response.status).not.toBe(400);
      expect(response.body.code).not.toBe("INVALID_ID");
      // The success mode the discovery handler alone produces:
      expect(response.status).toBe(200);
      expect(response.body.items).toBeDefined();
    });

    it("query validation: fewer than 3 characters is rejected 400 before any provider call", async () => {
      const session = await loginNewTenant("too-short");
      const response = await get("/api/v1/instruments/discovery?kind=SHARE&query=ab", session);
      expect(response.status).toBe(400);
    });

    it("kind is required", async () => {
      const session = await loginNewTenant("missing-kind");
      const response = await get("/api/v1/instruments/discovery?query=totalenergies", session);
      expect(response.status).toBe(400);
    });
  });

  describe("MARKET_RUNTIME null (today's/every existing suite's default) — 503 DISCOVERY_UNAVAILABLE, never a 500", () => {
    let testApp: TestApp;

    function server(): ReturnType<typeof supertest> {
      return supertest(testApp.built.app.getHttpServer());
    }

    beforeAll(async () => {
      testApp = await startTestApp();
      const tenantId = randomUUID();
      await testApp.ownerDb.insert(tenant).values({ id: tenantId });
      await createUser(testApp.db, {
        id: randomUUID(),
        tenantId,
        email: "ic11-null-runtime@example.com",
        password: userPassword,
      });
    }, 120_000);

    afterAll(async () => {
      await testApp.stop();
    }, 30_000);

    it("returns 503 DISCOVERY_UNAVAILABLE", async () => {
      const { sid } = await loginAs(server(), "ic11-null-runtime@example.com", userPassword);

      const response = await server()
        .get("/api/v1/instruments/discovery?kind=SHARE&query=totalenergies")
        .set("Cookie", [`${SID_COOKIE_NAME}=${sid}`]);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("DISCOVERY_UNAVAILABLE");
    });
  });

  describe("throttling (DD7, AC-19) — rate (20/60s) and concurrency (2) are behaviorally distinct", () => {
    let testApp: TestApp;

    function server(): ReturnType<typeof supertest> {
      return supertest(testApp.built.app.getHttpServer());
    }

    /**
     * A fresh tenant/session per test — the rate cap (20/60s) and the
     * concurrency cap (2) are two **independent** per-tenant budgets on the
     * same interceptor stack, so proving each in isolation (rather than
     * reusing one tenant/session for both tests) is what actually keeps
     * "the 21st request is 429'd" from being an artifact of the concurrency
     * test's own earlier requests having already consumed part of that same
     * tenant's rate budget.
     */
    async function loginNewTenant(label: string): Promise<{ sid: string }> {
      const tenantId = randomUUID();
      const email = `ic11-throttle-${label}-${randomUUID()}@example.com`;
      await testApp.ownerDb.insert(tenant).values({ id: tenantId });
      await createUser(testApp.db, {
        id: randomUUID(),
        tenantId,
        email,
        password: userPassword,
      });
      return loginAs(server(), email, userPassword);
    }

    function get(path: string, session: { sid: string }) {
      return server()
        .get(path)
        .set("Cookie", [`${SID_COOKIE_NAME}=${session.sid}`]);
    }

    beforeAll(async () => {
      // A tiny, deterministic per-call delay: not required for the rate test
      // (21 sequential fast requests stay well inside the 60s window
      // regardless), but it is what makes the concurrency test's "3 fired at
      // once, cap 2" race reliable rather than a coin flip — the same
      // "deliberately widen the race window" technique
      // `instruments-backfill-trigger.e2e.test.ts`'s own throttle test uses
      // for `enqueueBackfill`.
      const delayedSearch: DiscoverySearchFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [SHARE_CANDIDATE];
      };
      testApp = await startTestApp({ marketRuntime: fakeMarketRuntime(delayedSearch) });
    }, 120_000);

    afterAll(async () => {
      await testApp.stop();
    }, 30_000);

    it("exceeding 20 requests/60s from one tenant: the 21st gets 429 DISCOVERY_RATE_THROTTLED", async () => {
      const session = await loginNewTenant("rate");
      // Sequential, not concurrent (the concurrency cap of 2 would otherwise
      // 429 far earlier and for the wrong reason) — exactly the distinction
      // DD7 exists to make observable: a *rate* cap binds even though no two
      // of these 21 requests are ever in flight at once.
      const statuses: number[] = [];
      const codes: unknown[] = [];
      for (let i = 0; i < 21; i++) {
        const response = await get(
          `/api/v1/instruments/discovery?kind=SHARE&query=rate-${i}`,
          session,
        );
        statuses.push(response.status);
        codes.push(response.body.code);
      }

      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses[20]).toBe(429);
      expect(codes[20]).toBe("DISCOVERY_RATE_THROTTLED");
    }, 60_000);
  });
});
