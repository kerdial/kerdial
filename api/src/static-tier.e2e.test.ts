import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@kerdial/platform-auth";
import { tenant } from "@kerdial/platform-db";
import { buildApp, type BuiltApp } from "./app.js";
import { CSRF_COOKIE_NAME, SID_COOKIE_NAME } from "./auth/cookies.js";
import { startTestApp } from "./test-support/test-app.js";
import { loginAs } from "./test-support/http.js";

/**
 * SH-21 (FR-1–FR-3, AC-1, **V2**) — the static tier through
 * the real route table.
 *
 * **AC-1 without Docker, deliberately.** AC-1 is written as `docker compose up`,
 * which needs the image (Batch H) and the compose file (Batch I); neither exists
 * at this commit. What AC-1 is *about* — the SPA and `/api/v1/*` served by the
 * **same** Fastify instance on the **same** port, with no separate static
 * service — is a property of `buildApp`, and that is what this suite proves: one
 * app object, one server, both surfaces answered. The image-level restatement is
 * GATE-5's.
 *
 * The bundle is a temp fixture rather than a real `web/dist`: `web/dist` is a
 * gitignored build artifact, and making the API suite depend on a web build would
 * be a worse test, not a stricter one. What must not be faked is the *serving* —
 * that is real `@fastify/static` against real files on disk.
 */

const SPA_SHELL =
  "<!doctype html><html><head><title>portfolio</title></head><body>spa</body></html>";
const ASSET_JS = "console.log('bundle');\n";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("api — static tier (SH-21: FR-1–FR-3, AC-1, V2)", () => {
  let bundleRoot: string;
  let testApp: Awaited<ReturnType<typeof startTestApp>>;
  /** A second app on the same database with the tier disabled — the pre-SH-21 control. */
  let noStaticApp: BuiltApp;
  /** A real session, so AC-1's "the API answers too" half is a real 200, not a 401. */
  let sessionCookies: string[];

  const tenantId = "00000000-0000-7000-8000-000000521001";
  const userId = "00000000-0000-7000-8000-000000521002";
  const email = "sh21-static-tier@example.test";
  const password = "sh21 static tier correct horse battery staple";

  function server(): ReturnType<typeof supertest> {
    return supertest(testApp.built.app.getHttpServer());
  }

  beforeAll(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "sh21-web-dist-"));
    await writeFile(join(bundleRoot, "index.html"), SPA_SHELL, "utf8");
    await mkdir(join(bundleRoot, "assets"), { recursive: true });
    await writeFile(join(bundleRoot, "assets", "app-abc123.js"), ASSET_JS, "utf8");

    testApp = await startTestApp({ staticRoot: bundleRoot });
    noStaticApp = await buildApp({
      db: testApp.db,
      csrfSecret: "sh21-no-static-control",
      staticRoot: null,
    });

    await testApp.ownerDb.insert(tenant).values({ id: tenantId });
    await createUser(testApp.db, { id: userId, tenantId, email, password });
    const { sid, csrf } = await loginAs(server(), email, password);
    sessionCookies = [`${SID_COOKIE_NAME}=${sid}`, `${CSRF_COOKIE_NAME}=${csrf}`];
  }, 180_000);

  afterAll(async () => {
    await noStaticApp?.app.close();
    await testApp?.stop();
    await rm(bundleRoot, { recursive: true, force: true });
  }, 60_000);

  describe("AC-1 — one instance, one port, both surfaces", () => {
    it("serves the SPA shell at / and the API under /api/v1 from the same server", async () => {
      expect(testApp.built.staticRoot).toBe(bundleRoot);

      const shell = await server().get("/").set("Accept", BROWSER_ACCEPT);
      expect(shell.status).toBe(200);
      expect(shell.headers["content-type"]).toContain("text/html");
      expect(shell.text).toContain("spa");

      // The same `app.getHttpServer()` — not a second listener, not a proxy.
      const api = await server().get("/api/v1/currencies").set("Cookie", sessionCookies);
      expect(api.status).toBe(200);
      expect(api.headers["content-type"]).toContain("application/json");
    });

    it("serves a hashed asset by its real path, from disk", async () => {
      const asset = await server().get("/assets/app-abc123.js");
      expect(asset.status).toBe(200);
      expect(asset.text).toBe(ASSET_JS);
      expect(asset.headers["content-type"]).toContain("javascript");
    });

    it("a deep client-side route gets the shell, not a 404 — the SPA fallback", async () => {
      for (const path of ["/portfolios", "/portfolios/1234/transactions", "/settings/currencies"]) {
        const response = await server().get(path).set("Accept", BROWSER_ACCEPT);
        expect(response.status).toBe(200);
        expect(response.text).toContain("spa");
      }
    });

    it("HEAD on a client-side route is the same decision as GET", async () => {
      const response = await server().head("/portfolios").set("Accept", BROWSER_ACCEPT);
      expect(response.status).toBe(200);
    });

    it("the fallback route itself is registered for GET and HEAD only — the first of two guards", () => {
      // Both layers are checked, deliberately. `shouldServeSpaShell` rejects a
      // mutating verb *and* the route is only registered for the two safe ones;
      // without this assertion, widening the route's method list changes nothing
      // observable (the predicate still refuses), so the narrower registration
      // would be free to rot. Verified by mutation: adding POST/DELETE to the
      // route left every behavioural test in this file green.
      const wildcardMethods = testApp.built.routes
        .filter((route) => route.path === "/*")
        .map((route) => route.method)
        .sort();
      expect(wildcardMethods).toStrictEqual(["GET", "HEAD"]);
    });

    it("a missing asset under a real-looking path is a 404, never the shell", async () => {
      // No `Accept: text/html` — this is how a browser fetches a script/style,
      // and returning `index.html` with a 200 here is the classic SPA-fallback
      // defect that turns a bad build into a silent white screen.
      const response = await server().get("/assets/does-not-exist.js").set("Accept", "*/*");
      expect(response.status).toBe(404);
      expect(response.text).not.toContain("spa");
    });
  });

  describe("V2 — unknown /api/v1/* keeps the existing problem+json 404", () => {
    it("an unknown API path is problem+json, with the same body shape as before the static tier", async () => {
      const response = await server().get("/api/v1/definitely-not-a-route");
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      // The shape `problem.ts`/`ProblemJsonExceptionFilter` already produced for
      // an unknown route before the static tier: RFC 9457 `type`/`title`/`status`.
      expect(response.body).toMatchObject({ type: "about:blank", status: 404 });
      expect(typeof response.body.title).toBe("string");
      expect(response.text).not.toContain("spa");
    });

    it("…even when the client asks for HTML — an API path is never SPA territory", async () => {
      const response = await server()
        .get("/api/v1/definitely-not-a-route")
        .set("Accept", BROWSER_ACCEPT);
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.text).not.toContain("spa");
    });

    it("the tier changes nothing about a known API route's own 401/404 behaviour", async () => {
      // An authenticated route with no session: still the API's 401, not the shell.
      const unauthorized = await server().get("/api/v1/portfolios").set("Accept", BROWSER_ACCEPT);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers["content-type"]).toContain("application/problem+json");
    });

    it("byte-for-byte the same 404 body with the tier on and off", async () => {
      const withTier = await server().get("/api/v1/definitely-not-a-route");
      const withoutTier = await supertest(noStaticApp.app.getHttpServer()).get(
        "/api/v1/definitely-not-a-route",
      );
      expect(withoutTier.status).toBe(404);
      expect(withTier.body).toStrictEqual(withoutTier.body);
    });
  });

  describe("SPA fallback vs JSON 404, distinguished by Accept", () => {
    it("an unknown non-API path with Accept: application/json is problem+json, not the shell", async () => {
      const response = await server().get("/portfolios").set("Accept", "application/json");
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.text).not.toContain("spa");
    });

    it("a request with no Accept header at all does not get the shell", async () => {
      const response = await server().get("/portfolios").set("Accept", "");
      expect(response.status).toBe(404);
      expect(response.text).not.toContain("spa");
    });

    it("a mutating verb on an unknown path is problem+json, never the shell", async () => {
      const post = await server().post("/portfolios").set("Accept", BROWSER_ACCEPT);
      expect(post.status).toBe(404);
      expect(post.headers["content-type"]).toContain("application/problem+json");
      expect(post.text).not.toContain("spa");

      const del = await server().delete("/anything").set("Accept", BROWSER_ACCEPT);
      expect(del.status).toBe(404);
      expect(del.headers["content-type"]).toContain("application/problem+json");
      expect(del.text).not.toContain("spa");
    });

    it("/health answers as itself, never with the shell — a healthcheck must not pass on an HTML 200", async () => {
      const response = await server().get("/health").set("Accept", BROWSER_ACCEPT);
      // SH-32 wired the real endpoint (this assertion was `404` while FR-9 was
      // still a later task). The invariant is unchanged and is the whole reason
      // this tier excluded `/health` before there was anything to exclude: a
      // browser `Accept: text/html` must not turn the healthcheck's own path
      // into an `index.html` 200 that a container healthcheck would accept.
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.text).not.toContain("spa");
      expect(JSON.parse(response.text)).toMatchObject({ db: expect.any(String) });
    });
  });

  describe("the tier is public by design; the API is not", () => {
    it("the shell and its assets are served with no session — a browser has none yet", async () => {
      const shell = await server().get("/").set("Accept", BROWSER_ACCEPT);
      const asset = await server().get("/assets/app-abc123.js");
      expect([shell.status, asset.status]).toStrictEqual([200, 200]);
    });

    it("…and registering it made no /api/v1 route public", async () => {
      // The narrow version of AC32's sweep, re-run here because the static tier is
      // what added unauthenticated routes to this app: every *API* route must
      // still refuse a request with no session.
      // `account-setup` AC-364: the two first-run setup routes join
      // `POST /auth/login` as deliberate exclusions — both are `@Public()`
      // (FR-395/FR-397), so demanding a 401 from them would be asserting the
      // opposite of what the feature specifies. `GET /auth/setup` is
      // parameterless, so the `:`-filter below does **not** already cover it
      // (checked by reading, and by watching this sweep fail without the
      // exclusion); Fastify's auto-registered `HEAD` twin needs naming too.
      const publicByDesign = new Set([
        "POST /api/v1/auth/login",
        "GET /api/v1/auth/setup",
        "HEAD /api/v1/auth/setup",
        "POST /api/v1/auth/setup",
      ]);
      const apiRoutes = testApp.built.routes.filter(
        (route) =>
          route.path.startsWith("/api/v1/") &&
          !publicByDesign.has(`${route.method} ${route.path}`) &&
          !route.path.includes(":"),
      );
      expect(apiRoutes.length).toBeGreaterThan(0);
      for (const route of apiRoutes) {
        const method = route.method.toLowerCase() as "get" | "head" | "post" | "patch" | "delete";
        const request = server()[method](route.path);
        const response =
          route.method === "GET" || route.method === "HEAD"
            ? await request
            : await request.send({});
        expect(response.status, `${route.method} ${route.path} with no session`).toBe(401);
      }
    });
  });

  describe("no bundle ⇒ no tier (the pre-SH-21 app, which every other suite runs)", () => {
    it("staticRoot null serves no shell and keeps the plain 404", async () => {
      expect(noStaticApp.staticRoot).toBeNull();
      const response = await supertest(noStaticApp.app.getHttpServer())
        .get("/")
        .set("Accept", BROWSER_ACCEPT);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain("spa");
    });

    it("…and still routes the API — the guard answers, so the router is intact", async () => {
      // Deliberately unauthenticated: this control app shares the database but
      // not the session cookie's issuing app, and a 401 from the global
      // `AuthGuard` is proof the request reached a real route rather than a
      // not-found.
      const response = await supertest(noStaticApp.app.getHttpServer()).get("/api/v1/portfolios");
      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
    });
  });

  describe("the existing response-header contract still applies to static responses", () => {
    it("the shell carries the app's security headers (SH-23 owns CSP and path-aware caching)", async () => {
      const response = await server().get("/").set("Accept", BROWSER_ACCEPT);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    });
  });
});
