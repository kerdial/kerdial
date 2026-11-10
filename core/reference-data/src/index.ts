/**
 * `@kerdial/core-reference-data` — the curated, hand-maintained reference
 * datasets: exchange MICs (DD10), the Kerdial sector vocabulary, and country
 * labels. Extracted from `@kerdial/api-contracts` (R8's two escalation
 * triggers) once a second and third dataset (`sector.ts`,
 * `country.ts`) joined `exchange-mic.ts` and a first consumer outside `api`/
 * `web` (`market/composition`) appeared.
 *
 * Deliberately **framework-free** — no `zod`, no workspace dependency of any
 * kind — for the reason each module's own header states: `web-no-server-runtime-imports`
 * only allows `core/*` into `web/src`, so this package stays dependency-free
 * and that permission never needs widening. The Zod schemas built over this
 * data (`exchangeMicSchema`, `sectorCodeSchema`) live in
 * `@kerdial/api-contracts`, which depends on this package, never the other
 * way round.
 */
export * from "./exchange-mic.js";
export * from "./sector.js";
export * from "./country.js";
export * from "./instrument-icon.js";
export * from "./portfolio-accent.js";
