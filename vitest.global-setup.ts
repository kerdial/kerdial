/**
 * Root-level shim, not the implementation: vitest loads globalSetup files
 * through vite-node with ROOT-relative module resolution, so a globalSetup
 * living inside a workspace package cannot resolve that package's own
 * dependencies (pnpm keeps them in the package's node_modules, not the
 * root's). Re-exporting through the package name instead makes vite-node
 * externalize `@kerdial/platform-test-support` (a root devDependency),
 * and Node then resolves its imports natively from the package's own
 * node_modules. The implementation and its rationale live in
 * `platform/test-support/src/global-setup.ts`; like every other
 * `@kerdial/*` import in this repo it resolves through the built `dist/`,
 * so `pnpm build` must have run (same clean-checkout constraint every
 * integration suite already has).
 */
export { default } from "@kerdial/platform-test-support/global-setup";
