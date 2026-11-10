/**
 * Vitest setup for `web/src`'s `.test.tsx` component tests (T-43) — extends
 * `expect` with `@testing-library/jest-dom`'s DOM matchers
 * (`toBeInTheDocument`, etc.) and registers RTL's `afterEach(cleanup)`.
 *
 * Wired in globally via root `vitest.config.ts`'s `setupFiles` — Vitest has
 * no per-glob `setupFiles` short of the larger `test.projects` restructuring
 * (deliberately not done here; security review F4, T-43, is a minimal fix,
 * not a Vitest config rearchitecture), so this module still loads once for
 * every one of the repo's ~130 non-`web` test files too, not only the
 * `jsdom`-scoped ones (`environmentMatchGlobs` in `vitest.config.ts`).
 * Correction of a previous claim here: importing `@testing-library/jest-
 * dom/vitest` alone actually is inert elsewhere (it only calls
 * `expect.extend(...)`) but the previous version of this file *also*
 * unconditionally imported `@testing-library/react` and registered a real
 * `afterEach(cleanup)` for every one of those ~130 files — not inert, just
 * a harmless no-op *call* (nothing was ever mounted there to clean up), at
 * the cost of loading `@testing-library/react`'s whole module graph
 * (react-dom, scheduler, …) on every worker regardless of environment. The
 * `typeof document !== "undefined"` guard below skips that import/
 * registration entirely outside `jsdom` (every non-`web` suite, and any
 * environment `document` genuinely is `undefined` in), which is the cheap
 * fix; restructuring onto `test.projects` for a fully separate `jsdom`
 * project (and moving `setupFiles` there) is the more thorough fix but is
 * out of this finding's scope.
 */
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  // RTL's automatic afterEach-cleanup registration only fires when it
  // detects a global `afterEach` (Vitest's `globals: true`); this repo's
  // other suites rely on explicit imports (`import { describe, it } from
  // "vitest"`, no globals), so the same convention is kept here and cleanup
  // is wired explicitly instead — otherwise a component rendered by one
  // test would still be attached to `document.body` in the next.
  afterEach(cleanup);
}
