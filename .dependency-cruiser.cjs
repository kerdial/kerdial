/**
 * dependency-cruiser config — the module-boundary harness for T-1, finalized
 * by T-15 once a real adapter (`market/adapters/ecb`) exists to prove the
 * rule against.
 *
 * Declares the architecture's module-boundary rules:
 *
 *   - `ledger`    must not import `market/adapters`
 *   - `valuation` must not import `market/adapters`
 *   - `api`       must not import `market/adapters`
 *   - `api`       must not import `market/ingestion` (WL-3)
 *   - `valuation` must not import `market/ports` at all
 *   - `web/src`   must not import `api`/`platform`/`market`/`ledger`/`valuation` at runtime
 *
 * T-1 proved the rule text was *live* with a scratch-file import before any
 * real adapter existed. T-15 ("Finalize the
 * dependency-cruiser rule from T-1/T-13: ledger, valuation, api must not
 * import market/adapters") adds the `api` rule (T-1/T-13 only declared the
 * `ledger`/`valuation` halves) and re-runs the same scratch-import proof
 * against the real `market/adapters/ecb` module. T-30
 * (`valuation` materialisation) is what exercises the `market/ports` rule
 * against real code.
 *
 * cicd (T-42..T-45 web/PWA run): `web` was never in the cruise's target list
 * (`core platform market ledger valuation api` only), so `web`'s layer
 * discipline — it must never import `@kerdial/api`/`platform`/`market`/
 * `ledger`/`valuation` at runtime, only `core/*` — was enforced by
 * convention/review only (R6). `web/src` (not `web/e2e`, and not
 * `*.test.ts(x)` files even inside `web/src` — cross-package imports from tests, e.g.
 * `web/src/lib/currency-scale.drift.test.ts`'s relative import of
 * `platform/db`'s seed data, are sanctioned drift-guard fixtures, not a
 * runtime dependency) is now in scope; see `web-no-server-runtime-imports`
 * below and its `pathNot` exceptions in `no-unresolvable` for the two
 * Vite-only specifiers (`vite/client`/`vite-plugin-pwa/*` triple-slash type
 * references, and the `virtual:pwa-register/react` build-time virtual
 * module) that no static resolver can ever resolve — proven not to hide a
 * real violation by a deliberate violating probe, same
 * discipline as the `dist`-exclusion incident below.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      // Without this, an import the resolver cannot resolve simply vanishes
      // from the graph, and every `to:`-matching rule below passes on it by
      // default. That is the failure mode that hid the `dist` exclusion bug
      // (see `options.exclude`): a boundary violation that cannot be resolved
      // is indistinguishable from no violation at all. Fail loudly instead.
      name: "no-unresolvable",
      comment:
        "An import that cannot be resolved is invisible to every module-boundary rule in this file, so it must be an error in its own right.",
      severity: "error",
      from: {},
      to: {
        couldNotResolve: true,
        // Two genuinely unresolvable-by-design specifiers, not a hidden
        // violation: `vite/client`/`vite-plugin-pwa/client`/
        // `vite-plugin-pwa/react` are triple-slash *type-only* references in
        // `web/src/vite-env.d.ts` (no runtime edge — dependency-cruiser's own
        // JSON output tags them `moduleSystem: "tsd"`), and
        // `virtual:pwa-register/react` (`web/src/components/UpdateToast.tsx`)
        // is a Vite build-time virtual module with no file on disk to
        // resolve to; `vite build` (exercised in the `build` job) resolves it
        // via its own plugin pipeline, which no static cruiser emulates.
        // Every other unresolvable import — including a same-shaped scratch
        // probe (`totally-nonexistent-package-xyz`) used to red-confirm this
        // exception isn't a blanket escape hatch — still fails this rule.
        pathNot: ["^vite/client$", "^vite-plugin-pwa/(client|react)$", "^virtual:pwa-register/"],
      },
    },
    {
      name: "web-no-server-runtime-imports",
      comment:
        "web/src must never import api/platform/market/ledger/valuation at runtime — the browser bundle only ever talks to the server over HTTP; only core/* (core/decimal, core/api-contracts, core/domain) is shared, compiled-in code. `web/e2e` is out of this rule's `from` scope entirely (not a cruise entry point — the cruise target list is `web/src`, not `web`), and `*.test.ts(x)` files inside `web/src` are excluded from `from` too: the tester's cross-package TEST imports (e.g. `currency-scale.drift.test.ts`'s relative import of `platform/db`'s ISO 4217 seed, `tester-schema-parity.test.ts`'s relative import of `api`'s own schema) are sanctioned drift-guard fixtures, never bundled by `vite build`, and add no runtime dependency.",
      severity: "error",
      from: { path: "^web/src", pathNot: "\\.test\\.tsx?$" },
      to: { path: "^(api|platform|market|ledger|valuation|importer)($|/)" },
    },
    {
      // csv-import CI-5 ("`importer` may not import **any** `market/*`
      // package"). `adapters-import-confined-to-
      // composition` above only forbids `market/adapters`, so an
      // `importer -> market/composition` or `importer -> market/ports` edge
      // would cruise clean under every other rule in this file. ID1's whole
      // point is that the importer reaches a provider only through
      // `ImportDiscoveryPort`, which `api` binds to `MarketRuntime.discovery`;
      // this rule is what makes that a graph property instead of a review note.
      // Red-confirmed at authoring time with a scratch
      // `importer/src/scratch-probe.ts` importing `@kerdial/market-composition`.
      name: "importer-no-market",
      comment:
        "importer must not import any market/* package — its one provider-facing need arrives through ports.ts's ImportDiscoveryPort, which api implements over MarketRuntime.discovery (ID1).",
      severity: "error",
      from: { path: "^importer" },
      to: { path: "^market/" },
    },
    {
      name: "ledger-no-market-adapters",
      comment:
        "ledger must not import market/adapters — provider identity is confined to the adapters layer.",
      severity: "error",
      from: { path: "^ledger" },
      to: { path: "^market/adapters" },
    },
    {
      name: "valuation-no-market-adapters",
      comment:
        "valuation must not import market/adapters — provider identity is confined to the adapters layer.",
      severity: "error",
      from: { path: "^valuation" },
      to: { path: "^market/adapters" },
    },
    {
      // instrument-create-ux IC-5. `ledger-no-market-adapters`/`valuation-no-market-adapters`/
      // `api-no-market-adapters` above each match only one specific `from` —
      // they would silently pass `api -> market/composition -> market/adapters`,
      // a direct-edge-only loophole ("rule-laundering")
      // (dependency-cruiser matches direct edges, and a transitive re-export
      // through a permitted package would cruise clean under those three rules
      // alone). This rule instead matches every `from` except `market/adapters`
      // and `market/composition` themselves, closing that gap once rather than
      // adding a fourth (fifth, sixth, ...) named exception every time a new
      // consumer package appears. `market/composition` is the sole exception
      // because it *is* the "adapter registry configuration"
      // — the one place outside `market/adapters` itself provider identity is
      // allowed to live.
      name: "adapters-import-confined-to-composition",
      comment:
        "Only market/adapters and market/composition may import market/adapters — closes the direct-edge-only loophole the three from-specific rules above would otherwise leave open for any current or future consumer package.",
      severity: "error",
      from: { pathNot: "^market/(adapters|composition)" },
      to: { path: "^market/adapters" },
    },
    {
      name: "api-no-market-adapters",
      comment:
        "api must not import market/adapters — provider identity is confined to the adapters layer; the API surface sees only market/ports-shaped data via ledger/valuation.",
      severity: "error",
      from: { path: "^api" },
      to: { path: "^market/adapters" },
    },
    {
      // WL-3 (security review). FR-51's
      // forbidden substitution — serving a request path from
      // `market/ingestion`'s cross-tenant fan-out reads
      // (`fetchHeldInstruments`, `fetchWatchedInstruments`,
      // `fetchRefreshPopulation`, each of which scans every tenant's rows
      // through the `app_ingest` pool's `USING (true)` policy) — is guarded by
      // name in `api/src/market-data-quote-refresh.e2e.test.ts`. That guard is
      // a string search over two files; this is the structural half, and it is
      // the one that holds for a file nobody thought to scan: today `api` has
      // no `@kerdial/market-ingestion` dependency at all, and this rule is
      // what makes that a graph property rather than a fact someone has to
      // re-check. `api` reaches ingestion the sanctioned way, through
      // `market/composition`'s `MarketRuntime`, whose barrel re-exports no
      // fan-out function.
      //
      // `api-no-market-adapters`'s shape, deliberately, so the two read as one
      // family. Red-confirmed at authoring time with a scratch
      // `api/src/scratch-probe.ts` importing `@kerdial/market-ingestion`.
      //
      // **Test files are out of the `from` scope**, exactly as they are for
      // `web-no-server-runtime-imports` above and for the same reason. This is
      // not a loophole left open, it is MEASURED existing ground truth (WL-3's
      // own premise — "`api` has no `@kerdial/market-ingestion` dependency"
      // — is true of `dependencies` and false of the manifest as a whole):
      // `@kerdial/market-ingestion` is an `api` **devDependency**
      // (`api/package.json:37`, never a runtime dependency), and five api
      // suites import it to drive the real backfill/reload job end to end
      // (`instrument-history-reload.e2e`, `instrument-provider-mapping.e2e`,
      // `transactions-backfill-trigger.e2e`, `watchlist-gate-d-journey.e2e`,
      // `instruments/history-window.drift`). Those are the tests that prove
      // the trigger contracts; the leak FR-51 is about is a *request path*
      // calling a fan-out read, which is precisely what remains forbidden.
      // `\\.test\\.js$` covers the compiled `api/dist` copies of the same
      // files, which the cruise also walks (see `options.exclude`'s note on
      // why `dist` is deliberately not excluded).
      name: "api-no-market-ingestion",
      comment:
        "api's runtime code must not import market/ingestion — its cross-tenant fan-out reads (fetchHeldInstruments/fetchWatchedInstruments/fetchRefreshPopulation) scan every tenant's rows by design, and serving a request path from one would leak every tenant's holdings or watchlist (FR-51, WL-3). api reaches ingestion only through market/composition's MarketRuntime; test files are excluded, and the package is an api devDependency only.",
      severity: "error",
      from: { path: "^api", pathNot: ["\\.test\\.tsx?$", "\\.test\\.js$"] },
      to: { path: "^market/ingestion" },
    },
    {
      // mcp-readonly MCP-FR-24 / MCP-NFR-4: the MCP server talks to Kerdial over
      // the HTTP API only, so it imports no server-side package — no database,
      // no valuation, no shared type at runtime. A graph property rather than
      // a convention, which is also what keeps the package publishable on its
      // own. The reverse edge (an `api` e2e suite driving the server) is fine.
      name: "mcp-no-repo-imports",
      comment:
        "mcp/ is a standalone HTTP client of the Kerdial API: it must not import any other workspace package (MCP-FR-24, MCP-NFR-4).",
      severity: "error",
      from: { path: "^mcp" },
      to: { path: "^(api|platform|market|ledger|valuation|importer|web|core)($|/)" },
    },
    {
      name: "valuation-no-market-ports",
      comment:
        "valuation must not import market/ports at all — this is what makes 'recomputation never re-fetches an FX rate' a compile-time property.",
      severity: "error",
      from: { path: "^valuation" },
      to: { path: "^market/ports" },
    },
    {
      name: "twr-no-xirr",
      comment:
        "core/domain's TWR engine (twr.ts) must not import the XIRR/MWR engine (xirr.ts, T-27) — TWR and MWR are computed by deliberately disjoint code paths so a shared bug cannot corrupt both identically behind FR-33's labelled pair (AC18). Keyed on the future xirr module path so it is already armed when T-27 lands.",
      severity: "error",
      from: { path: "^core/domain/src/twr\\.ts$" },
      to: { path: "^core/domain/src/xirr\\.ts$" },
    },
    {
      name: "xirr-no-twr",
      comment:
        "The reverse of twr-no-xirr: the XIRR/MWR engine (xirr.ts, T-27) must not import the TWR engine (twr.ts) either. The independence is mutual (AC18).",
      severity: "error",
      from: { path: "^core/domain/src/xirr\\.ts$" },
      to: { path: "^core/domain/src/twr\\.ts$" },
    },
    {
      name: "core-domain-purity",
      comment:
        "core/domain is the pure, DB-free calculation library (D13). It may import core/decimal and nothing else — no platform/db, no market/*, no ledger, no api. This is what keeps PMP/TWR/XIRR testable without a database and unable to reach a provider. Test files are excluded from the cruise, so vitest/fast-check imports are unaffected.",
      severity: "error",
      from: { path: "^core/domain" },
      to: {
        pathNot: ["^core/domain", "^core/decimal", "node_modules"],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // `dist` must NOT be excluded here. Workspace imports written the way
    // developers actually write them (`@kerdial/market-adapters`) resolve
    // through the package `exports` map to `market/adapters/dist/index.js`.
    // While `dist` was excluded, that edge was filtered out of the graph
    // entirely and every module-boundary rule below silently passed on it —
    // proven by probe: a `ledger/src` file importing `@kerdial/market-adapters`
    // by package name cruised clean, while the same import written as a
    // relative path correctly errored. That disabled `ledger-no-market-adapters`,
    // `api-no-market-adapters`, `core-domain-purity`, and `valuation-no-market-ports`
    // — the last being the third FR-57/AC47 enforcement mechanism that T-30 is
    // due to rely on. Found during T-18. Same "gate that cannot fail" class as
    // the (since-retired) license-gate and no-floats defects recorded in the build notes.
    exclude: { path: "(^|/)(__tests__|__fixtures__)(/|$)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
