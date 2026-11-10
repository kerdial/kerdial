import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIResponse, type Response } from "@playwright/test";
import {
  CSP_HEADER_VALUE,
  CONTENT_TYPE_OPTIONS_VALUE,
  FRAME_OPTIONS_VALUE,
  PERMISSIONS_POLICY_VALUE,
  REFERRER_POLICY_VALUE,
} from "../../api/src/security-headers.js";
import {
  EMAIL,
  PASSWORD,
  mockAuthenticatedSession,
  mockHolding,
  mockHoldings,
  mockLoginSuccess,
  mockOverview,
  mockPortfolios,
} from "./mocks.js";
import { ICON_ALPHA } from "./icon-bytes.js";
import { SHELL_MOUNT_TIMEOUT_MS } from "./nav-helpers.js";
import { waitForControllingServiceWorker } from "./sw-helpers.js";

/**
 * SH-43 (`self-hosted-deploy` AC-3/AC-6/AC-7/AC-8, FR-4–FR-8) — the
 * **real-static-tier CSP lane**.
 *
 * The gap this lane closes, stated plainly because it invalidated an assumption
 * an earlier locked decision rested on: `web/playwright.config.ts` runs
 * `vite dev` on :5173, so **no existing e2e spec has ever received a
 * `Content-Security-Policy` header or touched the Fastify static tier**. Every
 * CSP assertion in this repo until now was made either against the built files
 * on disk (`tools/csp-dist-gate`) or against an in-process Supertest app
 * (`api/src/security-headers.e2e.test.ts`) — never against a real browser
 * loading the real built bundle from the real server, which is the only place
 * an over-tight policy actually shows up (as a blank page, not a red test).
 *
 * This lane runs against `api/dist/test-support/e2e-lane-server.js`: `buildApp`
 * with `@fastify/static` rooted at the **built** `web/dist` and SH-23's
 * `onSend` hook, on a real socket (see `web/playwright.static-tier.config.ts`).
 *
 * **Chromium only, deliberately.** Header emission is engine-independent, and
 * the one engine-dependent thing here — intercepting the *service worker's own*
 * fetches — is only possible in Chromium (`api-cache-guard.spec.ts` records
 * the same limitation). The `iPhone 14` project's job, responsive rendering
 * parity, is unchanged and stays in the `vite dev` suite.
 *
 * **The service-worker trap this lane is exposed to** (recorded after a flake
 * was mis-diagnosed as slow-render): once a
 * service worker controls the page, its fetch handler runs in a separate
 * context that `page.route` never sees. Every mock below is therefore
 * registered with `context.route`. Unlike the `vite dev` suite, this lane
 * serves the **production** build, whose whole app shell really is precached —
 * so the service worker here genuinely mediates navigation, and a `page.route`
 * mock would silently reach the real API instead.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..");
const builtShell = readFileSync(resolve(repoRoot, "web", "dist", "index.html"), "utf8");

/**
 * Header lookups are case-insensitive, and duplicates are the whole point — so
 * enumerate the raw list, never `headers()[…]` (which lower-cases *and*
 * comma-joins repeats, i.e. destroys the exact evidence AC-4 asks for).
 * `Response.headersArray()` is async and `APIResponse.headersArray()` is not;
 * awaiting both is correct for either.
 */
async function valuesOf(response: Response | APIResponse, name: string): Promise<string[]> {
  const headers = await response.headersArray();
  return headers
    .filter((header) => header.name.toLowerCase() === name.toLowerCase())
    .map((header) => header.value);
}

/**
 * **The allowlist this lane used to carry is gone — the violation is fixed.**
 *
 * On its first run this lane found exactly one violation:
 * `zod@4.4.3`'s `allowsEval` feature probe (`zod/v4/core/util.js`) doing
 * `try { const F = Function; new F(""); } catch { return false; }` to decide
 * whether it may JIT-compile validators. Under `script-src 'self'` the
 * constructor throws and zod falls back to its interpreted path, but Chromium
 * reports a blocked eval for the *attempt* regardless — one
 * `securitypolicyviolation` and one console error on every page load of a
 * correctly configured deployment.
 *
 * It was allowlisted rather than fixed here because the lane's own batch was test-only
 * and the repair is an app-behaviour change. `web/src/zod-jitless.ts` now makes
 * it, with `z.config({ jitless: true })` on `main.tsx`'s first import line —
 * before `@kerdial/api-contracts` is evaluated, which is where the probe was
 * measured to fire. So the assertion below is now an unconditional "no
 * violations at all", which is what it should always have been.
 *
 * Red-confirmed both ways against this lane, not assumed: with the fix, three
 * tests pass and `__cspViolations` is empty; with the `zod-jitless` import
 * commented out and the bundle rebuilt, this test fails with **three**
 * `script-src blocked eval` entries — one per page load in the login journey,
 * which is also the measurement that turns "one per page load" from the
 * issue's claim into an observation.
 *
 * Worth keeping in view: that violation was **invisible to every other check**.
 * `tools/csp-dist-gate` greps the built bundle for `eval`/`new Function`, and
 * the call site survives minification as `const t=Function; new t("")`, which no
 * grep can see. Its recorded verdict — "the bundle contains no
 * `eval`/`new Function`" — is narrower than it reads, and this lane in a real
 * browser under the real header is the only thing that closes the gap.
 */

test.describe("SH-43 — the built web/dist through the real Fastify static tier, under the enforced CSP", () => {
  test("the shell is the built artefact, and it carries exactly one CSP header", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response, "no response for the shell navigation").not.toBeNull();

    // The lane's own "did this actually traverse the tier under test?" check.
    // `vite dev` emits none of these headers and serves a transformed shell, so
    // both halves fail loudly rather than passing against the wrong server.
    expect(await valuesOf(response!, "content-security-policy")).toEqual([CSP_HEADER_VALUE]);
    expect(await response!.text()).toBe(builtShell);

    expect(await valuesOf(response!, "x-content-type-options")).toEqual([
      CONTENT_TYPE_OPTIONS_VALUE,
    ]);
    expect(await valuesOf(response!, "x-frame-options")).toEqual([FRAME_OPTIONS_VALUE]);
    expect(await valuesOf(response!, "referrer-policy")).toEqual([REFERRER_POLICY_VALUE]);
    expect(await valuesOf(response!, "permissions-policy")).toEqual([PERMISSIONS_POLICY_VALUE]);
    // AC-8's direct half, from a browser this time: absence is an assertion.
    expect(await valuesOf(response!, "strict-transport-security")).toEqual([]);
    expect(await valuesOf(response!, "cache-control")).toEqual(["no-cache"]);
  });

  test("a client-side route, /sw.js and a content-hashed asset each carry one CSP and their own Cache-Control", async ({
    page,
  }) => {
    // A route only the SPA fallback can answer: no such file exists in `web/dist`.
    const clientRoute = await page.request.get("/portfolios/does-not-exist-on-disk", {
      headers: { accept: "text/html" },
    });
    expect(clientRoute.status()).toBe(200);
    expect(await valuesOf(clientRoute, "content-security-policy")).toEqual([CSP_HEADER_VALUE]);
    expect(await clientRoute.text()).toBe(builtShell);
    expect(await valuesOf(clientRoute, "cache-control")).toEqual(["no-cache"]);

    // FR-8/AC-7 — the service worker script itself, which a `<meta>` CSP could
    // never cover, on the real `generateSW` output.
    const serviceWorker = await page.request.get("/sw.js");
    expect(serviceWorker.status()).toBe(200);
    expect(await valuesOf(serviceWorker, "content-security-policy")).toEqual([CSP_HEADER_VALUE]);
    expect(await valuesOf(serviceWorker, "cache-control")).toEqual(["no-cache"]);

    // AC-6 — a real content-hashed name out of the real build, discovered from
    // the shell rather than hardcoded (the hash changes on every bundle).
    const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(builtShell)?.[1];
    expect(assetPath, "no hashed asset reference in the built shell").toBeTruthy();
    const asset = await page.request.get(assetPath!);
    expect(asset.status()).toBe(200);
    expect(await valuesOf(asset, "content-security-policy")).toEqual([CSP_HEADER_VALUE]);
    expect(await valuesOf(asset, "cache-control")).toEqual(["public, max-age=31536000, immutable"]);
  });

  test("the login journey renders under the enforced policy, with the real service worker controlling the page and no unexpected CSP violation", async ({
    page,
    context,
  }) => {
    // Recorded by the page itself: `securitypolicyviolation` fires in the
    // document for anything the policy actually blocked. Registered as an init
    // script so it is listening before the bundle's first byte executes.
    await context.addInitScript(() => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
          `${event.violatedDirective} blocked ${event.blockedURI} ` +
            `(source: ${event.sourceFile ?? "?"}:${String(event.lineNumber)}:${String(event.columnNumber)}, sample: ${event.sample ?? "?"})`,
        );
      });
    });

    // `context.route`, never `page.route` — see this file's header.
    await mockLoginSuccess(context);
    await mockAuthenticatedSession(context);
    await mockOverview(context);

    await page.goto("/login");
    await waitForControllingServiceWorker(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await page.getByTestId("login-email").fill(EMAIL);
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/\?range=1Y$/);
    // The shell's first mount in this page (the login screen is outside it),
    // so the shell-mount budget, not the 5s default: this one `expect` timed
    // out once right after the full e2e lane and never alone.
    await expect(page.getByTestId("overview-screen")).toBeVisible({
      timeout: SHELL_MOUNT_TIMEOUT_MS,
    });

    // The point of the lane: the app is not merely served under the policy, it
    // *runs* under it. A widening-needed regression (a `data:` background from
    // a Tailwind utility, a remote runtime import from a workbox bump) shows up
    // here as a violation rather than as a blank screen in production.
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    // No allowlist. Every violation is a failure, including a second
    // eval site in a different file — the thing the old narrow allowlist was
    // written to keep visible.
    expect(violations).toEqual([]);
  });

  /**
   * GATE-3 (IK-16), AC-311's **enforcement** half — the one assertion about
   * this feature that no other lane in the repo can make.
   *
   * `csp-dist-gate` greps the built bundle and `instrument-icon-surfaces.spec.ts`
   * reads `src` attributes under `vite dev`, which emits **no**
   * `Content-Security-Policy` header at all. Neither of them can tell an icon
   * that renders from an icon the policy silently blocks: `img-src 'self'` is
   * the directive the whole same-origin-bytes design (LD-2, FR-303) exists to
   * satisfy, and a blocked subresource is a fallback monogram in production and
   * a green test everywhere else.
   *
   * So: the real built bundle, served by the real Fastify tier, under the real
   * policy, with the real service worker controlling the page — and the icon's
   * bytes decoded off the screen, `naturalWidth` and pixels, with zero
   * `securitypolicyviolation` events. `toBeVisible()` would pass for a blocked
   * image; it is deliberately not used.
   */
  test("an instrument icon decodes under the enforced img-src 'self', with no CSP violation", async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
          `${event.violatedDirective} blocked ${event.blockedURI}`,
        );
      });
    });

    const instrumentId = "c1000000-0000-4000-8000-000000000001";
    const displayName = "Air Liquide";

    // `context.route`, never `page.route` — this lane's service worker really
    // does mediate every request (see the file header).
    await mockAuthenticatedSession(context);
    await mockOverview(context);
    await mockPortfolios(context);
    await mockHoldings(context, {
      holdings: [mockHolding({ instrumentId, displayName, kind: "SHARE", hasIcon: true })],
    });
    await context.route(/\/api\/v1\/instruments\/[^/]+\/icon$/, async (route) => {
      // The real route's own headers, `content-disposition: attachment`
      // included — `instruments.controller.ts`'s `getIcon`.
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(ICON_ALPHA.bytes.byteLength),
          "content-disposition": "attachment",
          "cache-control": "no-store",
        },
        body: ICON_ALPHA.bytes,
      });
    });

    await page.goto("/holdings");
    await waitForControllingServiceWorker(page);
    await expect(page.getByTestId("holdings-screen")).toBeVisible();

    const icon = page.getByTestId("instrument-icon-image");
    await expect(icon).toHaveCount(1);
    // The bytes reached the screen: the decoded bitmap's own dimensions and two
    // of its pixels, read back through an untainted canvas.
    const decoded = await icon.evaluate((element) => {
      const img = element as HTMLImageElement;
      if (img.naturalWidth === 0) return { naturalWidth: 0, naturalHeight: 0, pixels: null };
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context2d = canvas.getContext("2d")!;
      context2d.drawImage(img, 0, 0);
      const at = (x: number): number[] => {
        const data = context2d.getImageData(x, Math.floor(img.naturalHeight / 2), 1, 1).data;
        return [data[0] ?? -1, data[1] ?? -1, data[2] ?? -1];
      };
      return {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        pixels: [at(0), at(img.naturalWidth - 1)],
      };
    });
    expect({ width: decoded.naturalWidth, height: decoded.naturalHeight }).toEqual({
      width: ICON_ALPHA.widthPx,
      height: ICON_ALPHA.heightPx,
    });
    expect(decoded.pixels).toEqual([
      [ICON_ALPHA.left.r, ICON_ALPHA.left.g, ICON_ALPHA.left.b],
      [ICON_ALPHA.right.r, ICON_ALPHA.right.g, ICON_ALPHA.right.b],
    ]);
    // Same-origin path, which is what `img-src 'self'` admits.
    expect(await icon.getAttribute("src")).toBe(`/api/v1/instruments/${instrumentId}/icon`);

    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    expect(violations).toEqual([]);
  });
});
