import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * SH-43 — the real-static-tier CSP lane's own Playwright config.
 *
 * A second config rather than a project inside `playwright.config.ts`, because
 * the two lanes differ in the one thing a Playwright config cannot vary per
 * project: the server. The existing suite's `webServer` is `vite dev` on :5173
 * (no CSP header, no Fastify static tier); this one is the **real application**
 * serving the **built** `web/dist` — `api/dist/test-support/e2e-lane-server.js`,
 * which is `buildApp` with `@fastify/static` and SH-23's `onSend` hook, backed
 * by a Testcontainers Postgres.
 *
 * `node api/dist/...`, not `tsx`: Nest's DI reads `design:paramtypes` metadata,
 * which needs `emitDecoratorMetadata` — esbuild does not implement it. `pnpm
 * build` is therefore a prerequisite, as it already is for the `e2e`,
 * `flake-lane` and `dependency-boundaries` jobs.
 *
 * **No retries, even in CI** (unlike `playwright.config.ts`, whose single CI
 * retry is a documented margin against a noisy shared runner): every assertion
 * in this lane is a deterministic header/byte comparison or a service-worker
 * lifecycle wait with its own timeout. A retry here could only ever hide a real
 * regression in the policy or the tier.
 */

const PORT = 41801;
const repoRoot = resolve(import.meta.dirname, "..");

export default defineConfig({
  testDir: "./e2e",
  testMatch: /static-tier-csp\.lane\.spec\.ts$/,
  fullyParallel: false,
  reporter: [["list"]],
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
  },
  webServer: {
    command: "node api/dist/test-support/e2e-lane-server.js",
    cwd: repoRoot,
    // A real static file, not `/`: the SPA fallback only answers a request
    // whose `Accept` includes `text/html`, and the readiness
    // probe sends none — so probing `/` would poll a legitimate 404.
    url: `http://127.0.0.1:${String(PORT)}/index.html`,
    env: {
      NODE_ENV: "test",
      LANE_HOST: "127.0.0.1",
      LANE_PORT: String(PORT),
      LANE_STATIC_ROOT: resolve(repoRoot, "web", "dist"),
    },
    // Never reuse: a leftover server from another lane would have a different
    // static root or a different proxy-trust configuration, and the lane would
    // pass or fail for a reason outside its own run.
    reuseExistingServer: false,
    // Testcontainers may pull `postgres:17-alpine` on a cold cache.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      // Chromium only — see the spec file's header for why (header emission is
      // engine-independent; service-worker fetch interception is not).
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
