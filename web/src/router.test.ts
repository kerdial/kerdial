import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `router.test.ts` — UR-15.
 *
 * **Binding rule: no route in `router.tsx` ever declares a `loader` key.**
 * `createAppRouter` sets `defaultPreload: "intent"`, so a route `loader`
 * would run on mere `<Link>` hover — a hover that fanned out
 * `:id/overview`/`:id/holdings`/`:id/performance` (or any other budgeted
 * read) would burn the shared `valuationReadBudget`/`cheapReadBudget`
 * invisibly, on a navigation that may never even happen. All data fetching
 * in this app lives in route components' own `useQuery` calls instead.
 *
 * A source-text assertion, not a runtime one: `createRoute`'s own type
 * signature does not forbid a `loader` property, so this is enforced by
 * scanning the file for the literal `loader:` key — the same
 * `readFileSync`-based source-text convention
 * `figure-format-sole-importer.test.ts`/`lint-no-restricted-syntax.test.ts`
 * already use elsewhere in this repo, rather than importing every
 * `createRoute` call's runtime options object (which TanStack Router does
 * not expose for inspection after the fact).
 *
 * Every subsequent route task in this cycle (UR-19's `/activity`, UR-26+'s
 * `/instruments`/`/instruments/$instrumentId`, UR-30's `/controls`) relies on
 * this one test, not a copy of its own.
 */

const here = dirname(fileURLToPath(import.meta.url));
const routerSourcePath = join(here, "router.tsx");

/** Strips comments the same way `figure-format-sole-importer.test.ts` does, so a doc comment describing this very rule (this file's own header, or `router.tsx`'s own) can never trip a naive substring search. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** A `loader` object key, however it is spaced — `loader:` or `loader :`, never a false match on a longer identifier (e.g. `loaderFoo:`) or a string that merely contains the substring. */
const LOADER_KEY_PATTERN = /(?<![\w$])loader\s*:/;

describe("router.tsx never declares a route loader", () => {
  it("contains no `loader:` key anywhere in its route definitions", () => {
    const source = stripComments(readFileSync(routerSourcePath, "utf8"));
    // Positive companions first — the real route file, with the
    // `defaultPreload` setting the rule above exists for, so "no match"
    // cannot mean "nothing was scanned".
    expect(source).toContain("createRoute");
    expect(source).toContain("defaultPreload");
    expect(LOADER_KEY_PATTERN.test(source)).toBe(false);
  });
});

/**
 * `dividend-screen` DS-7.
 *
 * The acceptance criterion asks for the malformed-URL degradation to be
 * proved by **rendering** the route. It cannot be, and the reason is a recorded
 * property of this repo rather than a shortcut: `router.tsx` reaches
 * `AppShell.tsx` -> `UpdateToast.tsx` -> `virtual:pwa-register/react`, a
 * Vite-only virtual module that fails at *transform* time under `vitest` —
 * before any `vi.mock` could intercept it. Five existing suites
 * (`PrimaryNav.test.tsx`, `MobileNav.test.tsx`, `AccountMenu.test.tsx`,
 * `QuickSearch.test.tsx`, `PortfolioCardsPanel.test.tsx`) each record the same
 * constraint and each work around it by building their own in-test router.
 *
 * So the chain is proved in two links, with **no copy of the validator
 * anywhere**: this file asserts by source text that `dividendsRoute` maps all
 * three search params through `search-params.ts`'s shipped primitives (which
 * degrade to `undefined` and never throw — `search-params.test.ts` proves
 * that), and `DividendsView.test.tsx` feeds those primitives' real output into
 * the real view and asserts it lands on the all-time default with no error
 * state.
 */
describe("dividendsRoute reuses the shipped search-param primitives (DS-7)", () => {
  it("validates from/to with asIsoDate and portfolio with asUuid — no fourth validator shape", () => {
    const source = stripComments(readFileSync(routerSourcePath, "utf8"));
    const route = source.slice(source.indexOf("export const dividendsRoute"));
    expect(route).toContain('path: "/dividends"');
    expect(route).toContain('from: asIsoDate(search["from"])');
    expect(route).toContain('to: asIsoDate(search["to"])');
    expect(route).toContain('portfolio: asUuid(search["portfolio"])');
    // Cardinality guard: the slice above must have found the route at all — an
    // `indexOf` miss would return the whole file and could still contain the
    // three lines from some other route, so pin that this slice starts where
    // it should and is not the entire source.
    expect(route.startsWith("export const dividendsRoute")).toBe(true);
    expect(route.length).toBeLessThan(source.length);
  });
});

/**
 * The ledger filters panel's three new search params, proved the
 * same two-link way `dividendsRoute` is above (and for the identical recorded
 * reason: `router.tsx` cannot be imported under `vitest`). This file asserts by
 * source text that `activityRoute` maps them through `search-params.ts`'s
 * shipped primitives — `search-params.test.ts` proves those degrade to
 * `undefined` and never throw — and `ActivityView.test.tsx` feeds their real
 * output into the real view.
 *
 * The **coupling** is the part worth pinning rather than merely reading: a
 * `gross_amount` bound without a currency is a 422 from
 * `GET /transactions` (`TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY`), so a
 * bookmarked `?minAmount=100` with no `currency=` must not survive validation
 * and reach the request.
 */
describe("activityRoute validates the filters panel's params", () => {
  it("maps currency through asCurrencyCode and both bounds through asDecimalAmount", () => {
    const source = stripComments(readFileSync(routerSourcePath, "utf8"));
    const route = source.slice(source.indexOf("export const activityRoute"));
    expect(route).toContain('path: "/activity"');
    expect(route).toContain('const currency = asCurrencyCode(search["currency"])');
    expect(route).toContain(
      'minAmount: currency === undefined ? undefined : asDecimalAmount(search["minAmount"])',
    );
    expect(route).toContain(
      'maxAmount: currency === undefined ? undefined : asDecimalAmount(search["maxAmount"])',
    );
    // Same cardinality guard the dividends case documents: an `indexOf` miss
    // returns the whole file, which could satisfy the lines above from
    // somewhere else entirely.
    expect(route.startsWith("export const activityRoute")).toBe(true);
    expect(route.length).toBeLessThan(source.length);
  });
});
