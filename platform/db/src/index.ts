/**
 * `platform/db` — Drizzle schema, migrations, and connection factory.
 *
 * T-5 scope: the `decimalCol` custom column type and the auth & reference
 * schema. Ledger tables (T-6),
 * market/reference-data tables (T-7), RLS policies/roles (T-8), and the
 * tenant-scoped connection factory — `withTenant`/`withFxCorrection`,
 * (T-9) — build on top of this.
 */
export * from "./decimal-column.js";
export * from "./client.js";
export * from "./connection-budget.js";
export * from "./tenant-context.js";
export * from "./pg-error.js";
export * from "./schema/index.js";
// IR-21 — the checked-in sample catalogue `0037` seeds. Exported because the
// **dataset** is the seed marker (DD35: not a column), so any suite asserting
// on the seeded rows — AC-22's cold boot in `market/composition`, the
// template-carries-the-seed check the non-regression sweep rests on — needs the
// same list the migration was generated from, not a copy of its row count.
// Server-side only; no `web` package depends on `platform/db`.
// `SEEDED_INSTRUMENTS` is deliberately NOT re-exported here.
//
// 847 lines of data, 51 third-party `source.url` values and 51 `verifiedName`
// strings were loaded into the `api` and worker runtimes for a dataset **no
// production code path reads**: every consumer outside this package is a test
// file. That is a needless supply-chain fingerprint and a file-read target in
// the production bundle.
//
// The export existed for a good reason — AC-22's cold-boot suite needs
// `createMarketRuntime` from `market/composition` *and* this dataset's row
// count, and mirroring that count by value would have been exactly the drift
// the `instrument-reference-data` cycle spent its effort eliminating — so it
// was the right call at the time and was flagged rather than buried.
//
// It now lives behind the `@kerdial/platform-db/seed-data/instrument-catalogue` subpath, which is
// this package's **test-only entry point** (`package.json`'s `exports` map).
// The count stays bound to the dataset by a test rather than mirrored by
// value: every consumer still reads `SEEDED_INSTRUMENTS.length`.
//
// In-package suites import `./seed-data/instrument-catalogue.js` directly and
// always did.
// IB9 — the `migrate` service's own catalogue-backfill seeding step. Its two
// mirrored values (the kind list, the `requested_from` expression) are
// exported so `market/ingestion` — the one package allowed to see both sides —
// can drift-test them against `BACKFILLABLE_KINDS`/`computeBackfillRequestedFrom`.
// `runMigrations` itself is deliberately **not** re-exported here: it is a
// process entrypoint (`migrate-main.ts` runs on import when it *is* the
// entrypoint), not library surface.
export * from "./seed-backfill-state.js";
