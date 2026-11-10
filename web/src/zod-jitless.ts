import { z } from "zod";

/**
 * Turns off zod's JIT validator compilation in the browser bundle.
 *
 * ## What this fixes
 *
 * `zod@4.4.3` decides whether it may JIT-compile validators with a one-off
 * feature probe (`allowsEval` in `zod/v4/core/util.js`) that does
 * `const F = Function; new F("")` inside a `try`. Under this app's enforced
 * `script-src 'self'` the constructor throws, zod catches it and falls back to
 * its interpreted path — but Chromium reports a blocked `eval` for the
 * *attempt*, whether or not the caller handles the throw. So a correctly
 * configured deployment logged one `securitypolicyviolation` and one console
 * error on **every page load**, which is exactly the kind of permanent noise
 * that trains an operator to ignore the console.
 *
 * Found by SH-43's real-static-tier CSP lane on its first run — nothing
 * in this repo could see it before, because no browser had ever loaded this app
 * under its own enforced policy. It is deliberately **not** fixed by admitting
 * `'unsafe-eval'`: widening the cited directive set to silence a feature probe
 * would weaken a real control for zero behavioural gain.
 *
 * ## Why this is its own module, imported first
 *
 * Ordering is the whole point, and it is measured rather than assumed. The
 * probe fires during **module evaluation of `@kerdial/api-contracts`** — at
 * schema *construction*, not at first parse. Instrumented `new Function` in
 * Node: 0 attempts after importing zod, **1 after importing
 * `@kerdial/api-contracts`**, 0 more on the first `safeParse`. Since ES
 * modules evaluate every import before the importing module's own body,
 * `z.config({ jitless: true })` written inside `main.tsx` would run *after* the
 * schemas were built and the probe had already fired. The same measurement
 * confirms the other half: configuring after construction adds no further
 * attempts, but does not retract the one already made — `allowsEval` is
 * `cached()`, and `jitless` is read inside it.
 *
 * Hence a side-effect module, imported on `main.tsx`'s **first** line, before
 * anything that reaches a schema. There is no import-ordering lint rule in this
 * repo that would reorder it, and `zod-jitless.test.ts` pins the position so a
 * future tidy-up cannot silently move it below the router import.
 *
 * ## Cost
 *
 * zod's interpreted path is what this app has been running on all along — under
 * `script-src 'self'` the JIT was never actually available in the browser, the
 * probe merely failed noisily. So this changes no runtime behaviour in the
 * browser; it only stops asking a question whose answer was already "no". The
 * server is untouched: `jitless` is set here, in `web/src`, not in
 * `core/api-contracts`, so the API keeps zod's compiled path where no CSP
 * applies and repeated-parse throughput is worth having.
 */
z.config({ jitless: true });
