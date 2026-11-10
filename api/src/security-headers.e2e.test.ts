import { readdirSync } from "node:fs";
import { join } from "node:path";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NO_CACHE,
  CACHE_CONTROL_NO_STORE,
  CSP_HEADER_VALUE,
  PERMISSIONS_POLICY_VALUE,
} from "./security-headers.js";
import { resolveWebDistRoot } from "./static-tier.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * F11 (security review, T-37, INFO): a minimal, no-heavy-
 * dependency set of response security headers — `app.ts`'s `onSend` hook,
 * not a per-controller concern, so every response (success, 4xx, 5xx alike)
 * carries them.
 *
 * **SH-23** (FR-4–FR-8, AC-3/AC-5/AC-6/AC-7/AC-8)
 * extends this suite rather than replacing it: the API-surface `no-store`
 * guarantee below is *preserved verbatim* — FR-7 says this file is updated, not
 * weakened — and the new blocks add the CSP, the companion headers, the
 * no-HSTS assertion, and path-aware cache rules as they reach
 * a client through the real server.
 *
 * **Rooted at the real `web/dist`, on purpose.** Every other API suite runs with
 * `staticRoot: null` (SH-21's default, so no suite depends on whether the web
 * app happens to have been built). This one is the exception because AC-6/AC-7
 * are assertions about *real artifacts* — the actual hashed file names Vite
 * emits, the actual `sw.js` and `workbox-<hash>.js` `generateSW` emits at the
 * dist root — and a fixture bundle would only prove the fixture. It **fails**
 * rather than skipping when `web/dist` is absent, for the reason SH-22's gate
 * does: a check that goes quiet exactly when there is nothing to check is not a
 * check. Build with `pnpm --filter "@kerdial/web..." run build` (CI's `pnpm
 * build` already does, before the test job).
 */
describe("api — security response headers (F11, SH-23)", () => {
  let testApp: TestApp;
  let webDistRoot: string | null;
  /** A real, content-hashed file name from the real build — never a hardcoded hash, which would rot on the next build. */
  let hashedAssetPath: string;

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  /**
   * How many times a header physically appears on the wire. `response.headers`
   * would fold two `Content-Security-Policy` headers into one comma-joined
   * string, which is precisely the defect AC-4 is about — so the count comes
   * from the raw header list.
   */
  function rawHeaderCount(response: supertest.Response, name: string): number {
    const raw = (response as unknown as { res?: { rawHeaders?: string[] } }).res?.rawHeaders ?? [];
    return raw.filter((entry, index) => index % 2 === 0 && entry.toLowerCase() === name).length;
  }

  beforeAll(async () => {
    webDistRoot = resolveWebDistRoot();
    // Resolved once, here, rather than in the first test: no test in this file
    // may depend on another having run. When there is no build to read, the
    // placeholder makes the very next assertion fail with the reason.
    hashedAssetPath =
      webDistRoot === null
        ? "/assets/__no-real-web-dist__.js"
        : `/assets/${readdirSync(join(webDistRoot, "assets")).find((name) => /-[A-Za-z0-9_-]{8,}\.js$/.test(name)) ?? "__no-hashed-asset__.js"}`;
    testApp = await startTestApp({ staticRoot: webDistRoot });
  }, 120_000);

  afterAll(async () => {
    await testApp.stop();
  }, 30_000);

  it("runs against the real built web/dist — not a fixture, and never silently skipped", () => {
    expect(
      webDistRoot,
      'no built web/dist: run `pnpm --filter "@kerdial/web..." run build` before this suite',
    ).not.toBeNull();
    expect(testApp.built.staticRoot).toBe(webDistRoot);
    expect(hashedAssetPath, "a content-hashed .js under the real web/dist/assets").not.toContain(
      "__no-",
    );
  });

  it("sets X-Content-Type-Options: nosniff on a successful response", async () => {
    const response = await server().get("/api/v1/instruments");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Content-Type-Options: nosniff on an unauthenticated 401 response too", async () => {
    const response = await server().get("/api/v1/instruments");
    expect(response.status).toBe(401);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const response = await server().get("/api/v1/instruments");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  // Security review (cheap note): every response here is
  // authenticated, per-tenant financial data — `Cache-Control: no-store`
  // stops a shared/browser-back-button cache from resurfacing it after
  // logout on a shared machine.
  it("sets Cache-Control: no-store on a successful response", async () => {
    const response = await server().get("/api/v1/instruments");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("sets Cache-Control: no-store on an unauthenticated 401 response too", async () => {
    const response = await server().get("/api/v1/instruments");
    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  describe("SH-23 — the cited CSP, emitted by the application (FR-4, AC-3, AC-7)", () => {
    const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    it("the SPA shell carries the exact FR-4 directive set (AC-3)", async () => {
      const response = await server().get("/").set("Accept", browserAccept);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["content-security-policy"]).toBe(CSP_HEADER_VALUE);
    });

    it("…and exactly one such header reaches the client, direct-to-API (AC-4's direct half)", async () => {
      // The through-the-proxy half of AC-4 is GATE-7's (SH-45): this project has
      // no in-repo competitor for the header, which is what makes "exactly one,
      // from the application" provable here at all.
      const response = await server().get("/").set("Accept", browserAccept);
      expect(rawHeaderCount(response, "content-security-policy")).toBe(1);
      expect(response.headers["content-security-policy"]).not.toContain(", default-src");
    });

    it("every SPA-serving route carries the identical policy — shell, client route, index.html, manifest", async () => {
      for (const path of ["/", "/index.html", "/portfolios", "/manifest.webmanifest"]) {
        const response = await server().get(path).set("Accept", browserAccept);
        expect(response.status, path).toBe(200);
        expect(response.headers["content-security-policy"], path).toBe(CSP_HEADER_VALUE);
      }
    });

    it("/sw.js gets the same policy as every other response (AC-7, FR-8)", async () => {
      // Unblocked by SH-22's U4: the real build's workbox runtime is same-origin
      // (`define(["./workbox-<hash>"])` resolved against `location.href`), every
      // precache entry relative, every runtime route `sameOrigin`-gated — so
      // `worker-src 'self'`/`script-src 'self'` do not break the SW.
      const response = await server().get("/sw.js");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("javascript");
      expect(response.headers["content-security-policy"]).toBe(CSP_HEADER_VALUE);
      expect(rawHeaderCount(response, "content-security-policy")).toBe(1);
    });

    it("the API surface and its error responses carry it too — one hook, every response", async () => {
      const unauthorized = await server().get("/api/v1/instruments");
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers["content-security-policy"]).toBe(CSP_HEADER_VALUE);

      const notFound = await server().get("/api/v1/definitely-not-a-route");
      expect(notFound.status).toBe(404);
      expect(notFound.headers["content-security-policy"]).toBe(CSP_HEADER_VALUE);

      const asset = await server().get(hashedAssetPath);
      expect(asset.status).toBe(200);
      expect(asset.headers["content-security-policy"]).toBe(CSP_HEADER_VALUE);
    });

    it("it is a header, and the shell ships no <meta> CSP that could disagree with it (FR-4)", async () => {
      const response = await server().get("/").set("Accept", browserAccept);
      expect(response.text.toLowerCase()).not.toContain("content-security-policy");
    });
  });

  describe("SH-23 — companion headers and the deliberate absence of HSTS (FR-5, AC-8)", () => {
    it("nosniff, no-referrer and a Permissions-Policy on both surfaces", async () => {
      for (const path of ["/", "/sw.js", "/api/v1/instruments"]) {
        const response = await server().get(path).set("Accept", "*/*");
        expect(response.headers["x-content-type-options"], path).toBe("nosniff");
        expect(response.headers["referrer-policy"], path).toBe("no-referrer");
        expect(response.headers["permissions-policy"], path).toBe(PERMISSIONS_POLICY_VALUE);
      }
    });

    it("no Strict-Transport-Security on any route, directly against the API (AC-8, direct half)", async () => {
      // FR-5 declines HSTS this cycle; TLS termination is owner-operated (NG11).
      // The absence is asserted, not merely untested — the through-the-proxy half
      // of AC-8 belongs to GATE-7 (SH-45).
      for (const path of ["/", "/index.html", "/sw.js", hashedAssetPath, "/api/v1/instruments"]) {
        const response = await server().get(path).set("Accept", "*/*");
        expect(response.headers["strict-transport-security"], path).toBeUndefined();
        expect(rawHeaderCount(response, "strict-transport-security"), path).toBe(0);
      }
    });
  });

  describe("SH-23 — path-aware Cache-Control (FR-6, AC-5, AC-6)", () => {
    it("the API keeps no-store unconditionally, including on 404s and after the static tier exists (AC-5)", async () => {
      for (const path of [
        "/api/v1/instruments",
        "/api/v1/portfolios",
        "/api/v1/currencies",
        "/api/v1/definitely-not-a-route",
      ]) {
        const response = await server().get(path).set("Accept", "*/*");
        expect(response.headers["cache-control"], path).toBe(CACHE_CONTROL_NO_STORE);
      }
    });

    it("/health is no-store before the endpoint exists, so FR-9 cannot inherit a cacheable default", async () => {
      const response = await server().get("/health").set("Accept", "*/*");
      expect(response.headers["cache-control"]).toBe(CACHE_CONTROL_NO_STORE);
    });

    it("a real content-hashed asset is immutable, overriding @fastify/static's own value (AC-6)", async () => {
      const response = await server().get(hashedAssetPath);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe(CACHE_CONTROL_IMMUTABLE);
      // `@fastify/static` sets its own `Cache-Control` (`send`'s `maxAge`); the
      // hook must *replace* it, not append a second, contradictory value.
      expect(rawHeaderCount(response, "cache-control")).toBe(1);
    });

    it("the real root-level workbox chunk is immutable too (the fourth row)", async () => {
      const workbox = readdirSync(webDistRoot as string).find((name) =>
        /^workbox-[^/]+\.js$/.test(name),
      );
      expect(workbox, "a root-level workbox-<hash>.js in the real web/dist").toBeTruthy();
      const response = await server().get(`/${workbox as string}`);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe(CACHE_CONTROL_IMMUTABLE);
    });

    it("the update-discovery path is no-cache: /, /index.html, /sw.js, the manifest (AC-6)", async () => {
      for (const path of ["/", "/index.html", "/sw.js", "/manifest.webmanifest"]) {
        const response = await server().get(path).set("Accept", "text/html,*/*");
        expect(response.status, path).toBe(200);
        expect(response.headers["cache-control"], path).toBe(CACHE_CONTROL_NO_CACHE);
        expect(rawHeaderCount(response, "cache-control"), path).toBe(1);
      }
    });

    it("anything else falls to no-cache, so a new artifact can never inherit immutable", async () => {
      const clientRoute = await server()
        .get("/portfolios/1234")
        .set("Accept", "text/html,application/xhtml+xml");
      expect(clientRoute.status).toBe(200);
      expect(clientRoute.headers["cache-control"]).toBe(CACHE_CONTROL_NO_CACHE);

      const missing = await server().get("/not-a-file.txt").set("Accept", "*/*");
      expect(missing.status).toBe(404);
      expect(missing.headers["cache-control"]).toBe(CACHE_CONTROL_NO_CACHE);
    });
  });
});
