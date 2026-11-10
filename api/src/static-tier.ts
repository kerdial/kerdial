import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
// SH-23 moved this helper (Fastify's `request.url` carries the query string;
// both the predicate below and the path-aware `Cache-Control` rules are about
// the path alone) into `security-headers.ts`, so the two layers can never
// disagree about what "the path" of a request is.
import { pathOfUrl } from "./security-headers.js";

/**
 * SH-21 (`self-hosted-deploy` FR-1–FR-3, AC-1/AC-2) — the
 * **static tier**: the built SPA (`web/dist`) served from the *same* Fastify
 * instance, on the same port, as `/api/v1/*`: the
 * "same-container static tier"; there is no second static-file service and no
 * static-file role in the reverse proxy (which is owner-operated and out of
 * scope entirely — spec NG11).
 *
 * **Why a wildcard route rather than `setNotFoundHandler`.** The SPA
 * fallback was first specified as a `setNotFoundHandler`, and that is the shape
 * this file started from. Fastify permits exactly **one** not-found handler per
 * prefix, and Nest already installs its own during `app.init()`
 * (`routes-resolver.js`'s `registerNotFoundHandler` → `FastifyAdapter#
 * setNotFoundHandler`) — that handler is what turns an unknown path into a
 * `NotFoundException` and therefore into this API's problem+json 404 body.
 * Verified directly against the pinned Fastify: a second registration throws
 * *"Not found handler already set for Fastify instance with prefix: '/'"*, so
 * taking the not-found seam for the SPA would either crash `init()` or displace
 * the problem+json 404 the existing suites assert. A `GET`/`HEAD` wildcard route
 * that **delegates** via `reply.callNotFound()` keeps both behaviours: the SPA
 * gets its fallback, and everything the SPA must not swallow still reaches
 * Nest's handler unchanged (this is check **V2** — assert the 404 *body
 * shape*, not merely that the fallback works).
 *
 * The four conditions under which a request is answered with `index.html`
 * (unchanged by the mechanism above):
 *
 *  1. method is `GET` or `HEAD` — never a mutating verb, which is why the
 *     wildcard route registers only those two methods and a `POST /whatever`
 *     still falls through to problem+json;
 *  2. the path is not under the API namespace (`/api/v1`, FR-3's sole API
 *     namespace);
 *  3. the path is not {@link HEALTH_PATH} — the health endpoint (FR-9, a later
 *     task) must answer as itself, and must not silently start returning
 *     `index.html` with a 200 the moment this tier is wired, which would make a
 *     container healthcheck pass while the app was broken;
 *  4. `Accept` includes `text/html` — a browser navigating a client-side route
 *     gets the SPA, while an API client that asked for JSON gets the
 *     problem+json 404 it can actually parse, rather than an HTML page with a
 *     misleading 200.
 *
 * **These routes are deliberately unauthenticated, and that is not a hole in the
 * `AuthGuard`.** `@fastify/static`'s routes and the fallback below are raw
 * Fastify routes: they never enter Nest's DI graph, so the global guard
 * (`app.module.ts`) does not apply to them — the same property `registerTestRoutes`
 * documents as a hazard for an API route is the *requirement* here, since a
 * browser must be able to fetch the shell and its bundle before it has a session
 * to authenticate with. What they serve is a build artifact identical for every
 * tenant; no tenant data reaches a client through this tier, which continues to
 * come only from `/api/v1/*` behind the guard. The one thing that must stay true
 * is that the tier never answers *for* an API path — condition 2 above, and V2's
 * assertion.
 *
 * One consequence worth stating because a test depends on it: `auth.e2e.test.ts`'s
 * AC32 sweep asserts that every route in `BuiltApp.routes` is 401 without a
 * session, so a suite that registers this tier would sweep public asset routes
 * and fail. `test-support/test-app.ts` therefore defaults `staticRoot` to `null`;
 * the tier is opted into, per suite.
 */

/** FR-3's sole API namespace, matching `buildApp`'s `setGlobalPrefix("api/v1")`. */
const API_PREFIX = "/api/v1";

/**
 * The FR-9 health endpoint path. Excluded from the SPA fallback
 * *before* that endpoint exists so wiring it later cannot be shadowed by this
 * tier — an `index.html` 200 on `/health` would be a container healthcheck that
 * passes for the wrong reason.
 */
const HEALTH_PATH = "/health";

/** The env var the image uses to point at the SPA bundle when it is not at the workspace-relative default. */
export const WEB_DIST_ENV_VAR = "WEB_DIST_DIR";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * `api/src` (vitest) and `api/dist` (production) are both exactly two levels
 * below the workspace root, and runtime stage copies each
 * package's `dist/` **plus `web/dist`** preserving that layout — so one relative
 * path is correct in the repo and in the image. {@link WEB_DIST_ENV_VAR}
 * overrides it for any layout that differs.
 */
export const DEFAULT_WEB_DIST_ROOT = join(moduleDir, "..", "..", "web", "dist");

/**
 * Resolves the SPA root, or `null` when there is nothing to serve.
 *
 * `null` is the normal, deliberate outcome for a plain `pnpm test` checkout and
 * for every existing API suite: `web/dist` is a build artifact and is
 * gitignored, so requiring it would make the whole API suite depend on a web
 * build. FR-1 is about the *image*, where the Dockerfile copies `web/dist` in — and the
 * image smoke test (Batch H/GATE-5) is what proves it is there. Presence is
 * keyed on `index.html` rather than the directory: an empty or half-copied
 * directory would otherwise register a static tier that can serve nothing while
 * reporting itself configured.
 */
export function resolveWebDistRoot(explicitRoot?: string | null): string | null {
  if (explicitRoot === null) return null;
  const candidate = explicitRoot ?? process.env[WEB_DIST_ENV_VAR]?.trim() ?? DEFAULT_WEB_DIST_ROOT;
  const root = candidate === "" ? DEFAULT_WEB_DIST_ROOT : candidate;
  return existsSync(join(root, "index.html")) ? root : null;
}

/** The SPA fallback's four conditions, as one predicate so a test can drive it directly. */
export function shouldServeSpaShell(request: {
  readonly method: string;
  readonly path: string;
  readonly accept: string | undefined;
}): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.path === API_PREFIX || request.path.startsWith(`${API_PREFIX}/`)) return false;
  if (request.path === HEALTH_PATH) return false;
  return (request.accept ?? "").toLowerCase().includes("text/html");
}

/**
 * Registers `@fastify/static` at `/` plus the SPA fallback. Must run before
 * `app.init()`/`instance.ready()`, which lock the router.
 *
 * `wildcard: false` is load-bearing twice over: it is choice,
 * and it is what leaves the `/*` route below registrable at all — with
 * `wildcard: true` the plugin registers its own `GET /*` and Fastify rejects the
 * second one as a duplicate.
 */
export async function registerStaticTier(instance: FastifyInstance, root: string): Promise<void> {
  await instance.register(fastifyStatic, {
    root,
    wildcard: false,
    index: ["index.html"],
    // The SPA shell is the fallback for unknown paths, so a directory listing
    // would only ever expose the bundle's own layout.
    list: false,
  });

  instance.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const serve = shouldServeSpaShell({
        method: request.method,
        path: pathOfUrl(request.url),
        accept: request.headers.accept,
      });
      // `callNotFound` hands the request to Nest's own not-found handler — the
      // one that produces this API's problem+json 404 (V2).
      if (!serve) return reply.callNotFound();
      return reply.sendFile("index.html");
    },
  });
}
