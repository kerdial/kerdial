/**
 * What the UI is allowed to say about the sample instrument catalogue — IR-23
 * (FR-22, AC-25, AC-26, NG6).
 *
 * The catalogue itself is `platform/db/src/seed-data/instrument-catalogue.ts`,
 * which `web` cannot read: no `web` -> `platform/db` dependency exists, and
 * `web-no-server-runtime-imports` permits `core/*` only. So the two figures the
 * footnote states live here, and
 * `web/src/lib/instrument-catalogue-notice.drift.test.ts` binds them to the
 * dataset's own `INSTRUMENT_CATALOGUE_COMPILED_ON` and row count — the
 * `web/src/lib/currency-scale.drift.test.ts` idiom, for the identical reason: a
 * hand-maintained mirror is only honest while something fails when it drifts.
 *
 * **Neutral by construction (NG6).** The catalogue is a static sample, not any
 * index's membership: there is no membership-refresh mechanism, nothing names an
 * index (AC-25, asserted repo-wide by
 * `index-membership-containment.test.ts`), and the compilation date is on the
 * surface precisely so a user never reads the snapshot as live.
 *
 * Deliberately framework-free (no `zod` import), for the reason `sector.ts`'s
 * and `country.ts`'s headers both state.
 */

/**
 * The catalogue's as-of date, ISO-8601 — `INSTRUMENT_CATALOGUE_COMPILED_ON`'s
 * `web`-visible mirror. Rendered through `formatIsoDateFr`, never spelled out
 * pre-formatted here: the French presentation of a date is `web`'s business,
 * the date itself is the dataset's.
 */
export const INSTRUMENT_CATALOGUE_AS_OF = "2026-08-22";

/**
 * How many instruments the catalogue holds. The footnote states it as « ~51 »,
 * and the drift test pins it to the dataset's actual length — an approximate
 * figure still has to be approximately right, and a claim about a row count
 * that nothing checks is exactly the sort of copy this project has had to walk
 * back before.
 */
export const INSTRUMENT_CATALOGUE_SIZE = 51;
