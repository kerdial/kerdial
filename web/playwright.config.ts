import { defineConfig, devices } from "@playwright/test";

// WebKit's `navigator.onLine` is wrong on some Linux hosts, and
// this pin is what makes it right.
//
// WebKit takes connectivity from GLib's `GNetworkMonitor`, which picks a
// backend by priority at startup. When NetworkManager is running on the DBus
// system bus, GLib picks its `networkmanager` backend — and on a host whose
// interfaces NetworkManager does not actually manage (a cloud VM on
// systemd-networkd, a container with a stub NM), that backend reports "no
// connectivity" for the entire browser process. Measured on this repo's
// development host, `about:blank`, no `setOffline` anywhere:
//
//     GIO_USE_NETWORK_MONITOR=networkmanager   baseline=false  setOffline(false)=false
//     GIO_USE_NETWORK_MONITOR=netlink          baseline=true   setOffline(false)=true
//     GIO_USE_NETWORK_MONITOR=base             baseline=true   setOffline(false)=true
//
// Note the third column: it was not merely a wrong startup value, it was
// unrecoverable — `setOffline(false)` could not clear it, so the `iPhone 14`
// project ran its whole suite against an app that correctly believed it was
// offline (43 of 50 failures in one gate run), while the eight specs that
// *test* offline behaviour passed for the wrong reason, having gone offline
// from an already-offline baseline.
//
// `netlink` rather than `base`: `base` hardcodes "always available", which
// would make the baseline assertion in `e2e/network.ts` a tautology. `netlink`
// reads the host's actual routes, so it still reports a genuinely disconnected
// machine — and it is the backend GitHub's runners already fall through to,
// having no NetworkManager, which is why CI never saw this (in CI,
// `portfolio-crud › create a portfolio` and `transaction-form › AC1` both pass
// on `iPhone 14`, impossible if that project believed it was offline). Pinning
// it makes local and CI resolve the same backend instead of two different ones.
//
// `??=`, so an operator debugging a network-monitor problem can still override
// it from the environment. Chromium is unaffected either way: it uses its own
// netlink-based `NetworkChangeNotifier`, not GLib.
process.env["GIO_USE_NETWORK_MONITOR"] ??= "netlink";

/**
 * T-1 acceptance: "Wire ... Playwright (desktop + `iPhone 14` viewport
 * project) as test runners with empty smoke tests."
 */
export default defineConfig({
  testDir: "./e2e",
  // SH-43/SH-44: the two new deploy lanes live in this same directory (so they
  // inherit its lint/typecheck scope) but must never run against `vite dev` —
  // they exist precisely *because* it emits no CSP header and never touches the
  // Fastify static tier. It has its own config and its own server:
  // `playwright.static-tier.config.ts`.
  testIgnore: [/\.lane\.spec\.ts$/],
  fullyParallel: true,
  reporter: [["list"]],
  // cicd (T-42..T-45 web/PWA run): four post-`page.reload()` sites
  // (the since-deleted `offline-logout.spec.ts`, plus three sites in the since-deleted
  // `session-purge.spec.ts`/`purge-throws-safety.spec.ts`, retired with the
  // ADR-0009 purge machinery) already
  // had their own `expect(...).toBeVisible({ timeout: 15_000 })`/`toHaveURL`
  // timeouts raised — that is the real, targeted fix
  // for the specific load-dependent race those sites hit locally. This
  // `retries` setting is a separate, CI-only safety margin on top of it: a
  // shared GitHub Actions runner can still be noisier than either a local
  // machine or this sandbox (CPU contention, cold caches), and no fixed
  // timeout is ever provably enough against an unbounded scheduler. A single
  // CI retry masks a real regression far less than a red-herring-flaky PR
  // gate would cost in reviewer trust — and Playwright's own reporter marks
  // a retried-then-passing test as "flaky" (not silently green), so a test
  // that only passes on retry stays visible in the CI summary rather than
  // being hidden by it. No assertion anywhere is weakened, loosened, or
  // removed by this — every `expect(...)` still runs to its own timeout,
  // exactly as many times, with the exact same conditions. Never applies
  // locally (`process.env.CI` is unset outside CI), so this cannot mask
  // anything while iterating on a real regression at the keyboard.
  retries: process.env["CI"] ? 1 : 0,
  // Refuses to run while an API holds :3000 (see the file for the
  // measurements). Config evaluation cannot be async, so the check lives here.
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:5173",
  },
  // LOCAL-MEASUREMENT TRAP — two stale servers, not one.
  //
  // `reuseExistingServer` means a dev server already on :5173 is silently
  // tested instead of this tree. That one is well known. The second is not,
  // and it is the one that cost a day: `vite.config.ts` proxies `/api` to
  // `http://localhost:3000`, so **any API server running locally answers
  // every request no spec happens to mock**. `ui-revamp`'s shell issues
  // `GET /portfolios?limit=100` and `GET /transactions?limit=100` on every
  // authenticated screen, and most specs here predate them and don't mock
  // them. A real API answers those `401`; `src/main.tsx`'s global 401 handler
  // turns any 401 from any query into `queryClient.clear()` +
  // `navigate({ to: "/login" })`; the app leaves the screen under test and
  // every later assertion in the file times out. One unmocked read, ~85 red
  // tests, and the tree is fine.
  //
  // In CI nothing listens on :3000, the proxy 500s, and no redirect fires —
  // so a local run with an API up is testing a different system than CI is.
  // Before trusting any local number here:
  //
  //     ss -ltnp | grep -E ':5173|:3000'    # both must be free
  //
  // Measured on `main` with both clear: 128 passed / 10 skipped /
  // 0 failed, Desktop Chrome, 45s.
  webServer: {
    command: "pnpm exec vite --port 5173 --strictPort",
    url: "http://localhost:5173",
    // Was `!process.env["CI"]`, i.e. reuse anything already on
    // :5173 locally. That silent reuse is the other half of the trap described
    // above, and it is what actually produced a "flaky under parallel
    // workers" reading: whatever a previous (or concurrent, or killed) run left
    // on the port gets tested instead of this tree, and a *dying* leftover
    // server yields a different scattered failure set every time — 131 of 145
    // in one measured instance here, 0 in the seven runs bracketing it.
    //
    // Measured on `main`, Desktop Chrome, this suite, with a server this run
    // owns: 7 runs at the default 4 workers, all 135 passed / 0 failed
    // (60-65s), plus 2 runs at 8 workers, both 135 passed / 0 failed (52s).
    // Default-worker parallelism is not the variable; server provenance is. No
    // `--workers=1` recommendation is needed, and no timeout was raised.
    //
    // `false` also makes local match CI, which never reused a server. The cost
    // is that a developer's own `pnpm dev` on :5173 now fails the run loudly
    // (`--strictPort`) instead of being silently tested in place of this tree.
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iPhone 14",
      use: { ...devices["iPhone 14"] },
      // Pragmatic matrix (2026-09-01): the mobile project used to mirror the
      // whole suite — 169 tests, of which ~120 were byte-identical re-runs of
      // viewport-agnostic flows (form validation copy, API error mapping,
      // cache-guard request counting…). It now runs only the specs with a
      // mobile-specific claim: layout/tier switches, the drawer, offline/PWA
      // behaviour, and one full journey per critical screen as a canary.
      // Desktop Chrome still runs everything. Add a spec here when it asserts
      // something that differs at the mobile tier, not by default.
      testMatch: [
        "**/mobile-parity.spec.ts",
        "**/responsive-nav.spec.ts",
        "**/instruments-screen.spec.ts",
        "**/overview-holdings.spec.ts",
        // The Aperçu hero at 320 px — skipped on Desktop Chrome.
        "**/overview-narrow.spec.ts",
        "**/transaction-form.spec.ts",
        "**/login.spec.ts",
        "**/offline.spec.ts",
        "**/sw-network-only.spec.ts",
        "**/portfolio-crud.spec.ts",
        "**/closed-positions.spec.ts",
        // `watchlist` AC-342/T-77: two of this spec's claims are
        // viewport-specific — the row toggle on the Instruments **card**
        // presentation (the table is the desktop one), and that the Suivi
        // destination is reachable from the "Plus" drawer. Every other test
        // in the file skips itself on this project by `testInfo.project.name`,
        // so the mobile run is those two, not a re-run of the desktop nine.
        "**/watchlist.spec.ts",
      ],
    },
  ],
});
