import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA, type VitePWAOptions } from "vite-plugin-pwa";

/**
 * ADR-0009 Stage 1 (`AR-20`): the service worker caches **static assets
 * only**. `/api/v1/**` is `NetworkOnly` for every method — GET included, no
 * exceptions — so no authenticated (or unauthenticated) API response is ever
 * written into Cache Storage. This removes the reproduced HIGH-1 cross-tenant
 * cache-leak class (a `NetworkFirst` fallback serving a
 * previous tenant's cached holdings) rather than mitigating it: an
 * uncacheable response has nothing for a fallback to ever serve.
 *
 * This supersedes the previous service-worker design (a `NetworkFirst`
 * `GET /api/v1/**` rule with three GET-specific `NetworkOnly` carve-outs for
 * `/auth/*`, `/instruments/discovery`, `/instruments/:id/history-status`, and
 * a `GET /currencies` exception kept on `NetworkFirst`) — all of that is
 * deleted, not narrowed: with no general caching rule left, there is nothing
 * left to carve exceptions out of, and `GET /currencies` is no longer
 * special-cased either.
 *
 * Declared explicitly for every method (rather than relying on an unmatched
 * request simply passing through the service worker untouched) so a future,
 * broader-matching runtime-caching rule can never accidentally shadow this
 * one — see `web/e2e/sw-network-only.spec.ts` (non-GET) and
 * `web/e2e/api-cache-guard.spec.ts`
 * (GET, widened to the whole `/api/v1` surface) for the behavioural proof.
 */
const apiNetworkOnlyRuntimeCaching: NonNullable<VitePWAOptions["workbox"]>["runtimeCaching"] = (
  ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
).map((method) => ({
  urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
    sameOrigin && url.pathname.startsWith("/api/v1/"),
  method,
  handler: "NetworkOnly" as const,
}));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // skipWaiting is not automatic; a toast offers
      // 'Nouvelle version disponible — recharger' — `registerType: "prompt"`
      // plus `injectRegister: null` (we call `useRegisterSW` from
      // `virtual:pwa-register/react` ourselves, in `UpdateToast.tsx`, instead
      // of the plugin's own auto-injected registration script) is what makes
      // that toast possible: nothing here ever calls `skipWaiting()` except
      // the user's own click on the toast's "recharger" button.
      registerType: "prompt",
      injectRegister: null,
      // Registers a real (generateSW-built) service worker under `vite dev`
      // too, not only a production build — the SW behavioural tests
      // (`web/e2e/sw-network-only.spec.ts`) run against the same dev server
      // as every other Playwright spec (`playwright.config.ts`'s `webServer`).
      devOptions: { enabled: true },
      manifest: {
        name: "Kerdial",
        short_name: "Kerdial",
        description: "Suivi de portefeuille multi-devises",
        lang: "fr",
        dir: "ltr",
        start_url: "/",
        display: "standalone",
        // The design's app ground (--paper-100) for both, so the splash screen
        // and the browser chrome are continuous with the first painted screen
        // instead of flashing a dark slab the product never shows again.
        background_color: "#F6F4F0",
        theme_color: "#F6F4F0",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          {
            src: "/icons/icon-192-maskable.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precaches the built app shell (HTML/JS/CSS/fonts) with revision
        // hashing — the default `generateSW` glob.
        globPatterns: ["**/*.{js,css,html,woff,woff2}"],
        navigateFallback: "/index.html",
        // Never precache/navigate-fallback an API call itself.
        navigateFallbackDenylist: [/^\/api\//],
        // ADR-0009 Stage 1 (`AR-20`): the entire previous rule set — the
        // `/api/v1/auth/**` GET exception, the discovery/history-status GET
        // exception, and the general `GET /api/v1/**` `NetworkFirst` rule
        // (with its `api-get-cache` name, `maxEntries`/`maxAgeSeconds`
        // expiration, and the exclusion predicates that qualified it) — is
        // deleted, not narrowed. `apiNetworkOnlyRuntimeCaching` above is the
        // one remaining `/api/v1/**` rule, for every method.
        runtimeCaching: [...apiNetworkOnlyRuntimeCaching],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin `/api` in dev too (matches the production topology: one container serves both the SPA and `/api`),
      // so the app never needs CORS handling.
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
