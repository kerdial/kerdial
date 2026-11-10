import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * **Workspace `@kerdial/*` imports resolve to `src/`, not `dist/`.**
 *
 * Every workspace package declares `main: "./dist/index.js"`, so without this
 * a test importing `@kerdial/api-contracts` reads the *built* copy. Mutating
 * the source and re-running then passes **green**, because the mutation is
 * invisible until someone remembers `pnpm --filter … run build`. That is not a
 * hypothetical: it was recorded three times — once earlier in this repo's
 * history, and twice more in the FT-48 gate's first run and its re-gate — each
 * time caught only because a tester happened to be looking. **A red-confirm
 * that silently passes is worse
 * than no red-confirm, because it is filed as evidence.**
 *
 * The map is **derived from `pnpm-workspace.yaml` and each package's own
 * `package.json`, never transcribed** — the Dockerfile-package gate and knip's
 * old `paths` map are both instances of a gate carrying its own stale copy of a
 * source-of-truth list, and a hand-written alias table here would be the third:
 * it would silently stop covering a package the moment the workspace grew,
 * which is exactly the failure this map exists to prevent.
 *
 * Production builds are untouched — `tsc -b` still compiles package-to-package
 * through `dist/`, and the Docker image build is unaffected. This changes what
 * *Vitest* resolves, and nothing else.
 */
function workspaceSourceAliases(): Record<string, string> {
  const raw = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const entries = [...raw.matchAll(/^\s*-\s*"?([^"\n]+?)"?\s*$/gm)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  if (entries.length === 0) {
    throw new Error("pnpm-workspace.yaml yielded no package entries — the parse is broken");
  }
  const dirs = entries.flatMap((entry) => {
    if (!entry.endsWith("/*")) return [entry];
    const parent = entry.slice(0, -2);
    const parentPath = join(REPO_ROOT, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${parent}/${d.name}`);
  });

  const aliases: Record<string, string> = {};
  for (const dir of dirs) {
    const manifestPath = join(REPO_ROOT, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const { name, exports } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      exports?: Record<string, unknown>;
    };
    if (name === undefined || !name.startsWith("@kerdial/")) continue;
    // Subpath exports first: a longer specifier must not be swallowed by the
    // bare-name alias. `platform/test-support` is the only one today, and it is
    // read off its own manifest rather than assumed.
    for (const subpath of Object.keys(exports ?? {})) {
      if (subpath === ".") continue;
      const file = join(REPO_ROOT, dir, "src", `${subpath.replace(/^\.\//, "")}.ts`);
      if (existsSync(file)) aliases[`${name}/${subpath.replace(/^\.\//, "")}`] = file;
    }
    const entry = join(REPO_ROOT, dir, "src", "index.ts");
    if (existsSync(entry)) aliases[name] = entry;
  }
  if (Object.keys(aliases).length === 0) {
    throw new Error("no @kerdial/* source entry points found — the alias derivation is broken");
  }
  return aliases;
}

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  // `api`'s NestJS controllers/guards (T-40) rely on `emitDecoratorMetadata`
  // (`design:paramtypes`) for constructor-based dependency injection.
  // Vitest's default esbuild transform strips decorators but does not
  // implement `emitDecoratorMetadata` at all, which silently produces
  // `undefined` for every DI-resolved constructor parameter at test time
  // (a real `tsc -b` build is unaffected — this is purely a Vitest-transform
  // gap). `unplugin-swc` swaps in `@swc/core`'s TS transform, which does
  // support decorator metadata, for every test file — safe repo-wide since
  // `api` is the only package using decorators (grep confirms this).
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        // `react: { runtime: "automatic" }` matches `web/tsconfig.json`'s
        // `"jsx": "react-jsx"` (React 19's no-`import React`-needed JSX
        // transform, T-42) — needed for `web/src`'s `.test.tsx` component
        // tests (T-43); harmless for every other package's plain `.ts` test
        // file (there is no JSX to transform there either way).
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          react: { runtime: "automatic" },
        },
        keepClassNames: true,
        target: "es2022",
      },
      module: { type: "es6" },
    }),
  ],
  test: {
    include: [
      "core/**/src/**/*.test.ts",
      "platform/**/src/**/*.test.ts",
      "market/**/src/**/*.test.ts",
      "ledger/**/src/**/*.test.ts",
      "valuation/**/src/**/*.test.ts",
      "importer/**/src/**/*.test.ts",
      "api/**/src/**/*.test.ts",
      "tools/**/src/**/*.test.ts",
      // T-43: web/src component tests (Vitest + @testing-library/react), not
      // Playwright e2e (web's other test suite, unaffected). See
      // `environmentMatchGlobs` below for why these need `jsdom` while every
      // other suite above stays on the default `node` environment.
      "web/src/**/*.test.tsx",
      // Security review F3 (T-43): non-component `web/src` tests (e.g. the
      // ESLint-fixture proof for the `web/src/**` no-restricted-syntax
      // block) — no JSX/DOM involved, so plain `node`, same as every other
      // package's `.test.ts`.
      "web/src/**/*.test.ts",
      // ci-release CR-6: the release-notes extractor lives beside the other
      // root-level tooling scripts and is the first of them with a test.
      // Without this line the file is collected by nothing — `test:main`
      // would never run it, which is the vacuous-coverage shape.
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/__fixtures__/**"],
    // Testcontainers pulls a Postgres image on a cold cache and starts a
    // real container; give it room before the suite is marked as hung.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // `web/src`'s `.test.tsx` component tests are the only DOM-rendering
    // suite in the repo — every other package's tests are Node/Testcontainers/
    // Supertest and would be needlessly slower (and, for a couple, outright
    // wrong — e.g. any `platform/db` suite touching real sockets) under a
    // jsdom global default. Scoping `jsdom` to `web/src/**/*.test.tsx` only,
    // rather than flipping the global `environment`, keeps every other
    // suite's environment unchanged.
    environmentMatchGlobs: [["web/src/**/*.test.tsx", "jsdom"]],
    setupFiles: ["web/src/test/setup-vitest.ts"],
    // With TEST_SHARED_PG=1 (the root test scripts, hence CI)
    // this boots ONE shared Postgres and pre-migrates a template database;
    // suites using @kerdial/platform-test-support then clone per-suite
    // databases from it instead of each booting a container. Without the
    // env it is a no-op — a narrow `npx vitest run x.test.ts` is unaffected.
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
