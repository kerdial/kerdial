/**
 * Generates `migrations/0037_seed_instrument_catalogue.sql` from the checked-in
 * `SEEDED_INSTRUMENTS` list in this directory. Run via
 * `pnpm --filter @kerdial/platform-db run db:seed:generate:instruments`
 * whenever `instrument-catalogue.ts` (the seed source data) changes, so the
 * migration and its source data never drift apart — IR-21
 * (DD33/DD34).
 *
 * Not a `drizzle-kit`-tracked schema migration (no table shape changes) — this
 * is a plain data-seed SQL file, numbered to run after the migration that adds
 * `domicile_country` (0035), in exactly the shape
 * `generate-market-calendar-seed-migration.ts` established for
 * `market_calendar`.
 *
 * Two differences from that sibling, both deliberate:
 *
 * 1. **It validates before it writes.** `validateSeededInstruments` runs first
 *    and a single violation exits non-zero with **nothing written**, so a bad
 *    row can never reach a migration file even if `pnpm
 *    instrument-catalogue-gate` were skipped.
 * 2. **The emit step is a pure exported function.** `renderInstrumentCatalogueSeedSql`
 *    is what the regeneration drift test re-runs over the current dataset to
 *    compare byte-for-byte against the checked-in `0037` — which is what makes a
 *    dataset/SQL count mismatch, or a hand-edit of the generated file, fail the
 *    build (AC-18). The `main()` call is therefore behind the
 *    `process.argv[1]` entrypoint guard `migrate-main.ts` uses, so importing
 *    this module never writes a file.
 *
 * Both the dataset module and the output path are overridable on the command
 * line (`… generate-instrument-catalogue-seed-migration.ts [dataset.ts]
 * [out.sql]`), in the `instrument-catalogue-gate-cli.ts` idiom and for the same
 * reason: the test suite observes **both** exit codes against checked-in
 * fixture catalogues, writing to a temp path, rather than inferring them.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatSeedViolations, validateSeededInstruments } from "./instrument-catalogue-gate.js";
import { SEEDED_INSTRUMENTS, type SeededInstrument } from "./instrument-catalogue.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The checked-in migration this generator owns. Same path from `src/` and `dist/`. */
export const INSTRUMENT_SEED_MIGRATION_FILE = join(
  here,
  "..",
  "..",
  "migrations",
  "0037_seed_instrument_catalogue.sql",
);

/**
 * The inserted columns, in order. Everything absent from this list is absent
 * from the seed **on purpose**:
 *
 * - `owner_tenant_id` ⇒ NULL ⇒ shared catalogue (D-17);
 * - `sector_code` / `industry_label` ⇒ NULL (FR-17/AC-21 — another party's
 *   classification output does not ship; the gate's rule 11 rejects the mere
 *   presence of such a key on a row);
 * - `figi` ⇒ NULL (NG10 — the column exists and stays unwritten);
 * - `status`, `created_at`, `updated_at` ⇒ their column defaults.
 */
const SEED_COLUMNS = [
  "id",
  "kind",
  "display_name",
  "listing_currency",
  "exchange_mic",
  "isin",
  "symbol",
  "primary_identifier",
  "quote_policy",
  "domicile_country",
] as const;

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The pure emit step: dataset in, SQL text out. No I/O, no clock, no
 * randomness — the row `id`s are hard-coded UUIDv7 literals in the dataset
 * (DD33) precisely so this function is deterministic and the drift test below
 * is possible.
 */
export function renderInstrumentCatalogueSeedSql(rows: readonly SeededInstrument[]): string {
  const columnList = SEED_COLUMNS.map((column) => `"${column}"`).join(", ");
  const lines = [
    "-- Generated from platform/db/src/seed-data/instrument-catalogue.ts",
    "-- by platform/db/src/seed-data/generate-instrument-catalogue-seed-migration.ts.",
    "-- Do not hand-edit — edit the source list and regenerate instead.",
    "--",
    "-- Seeds `instrument` with the checked-in sample catalogue (IR-21,",
    "-- DD33/DD34/DD35): widely-held",
    "-- European and US large capitalisations, compiled 2026-08-22. A static sample",
    "-- catalogue, not any index's membership, with per-row first-party evidence",
    "-- recorded in the source list.",
    "--",
    "-- Every row is `kind = SHARE`, `primary_identifier = ISIN`, `quote_policy =",
    "-- AUTO`. `owner_tenant_id` is omitted (=> NULL => shared catalogue, D-17), and",
    "-- so are `sector_code`, `industry_label` and `figi`: a company's identifier and",
    "-- country of incorporation are facts from primary sources and may ship, another",
    "-- party's classification output may not (FR-17, AC-21), and `figi` stays",
    "-- unwritten (NG10).",
    "--",
    "-- The conflict clause is deliberately **bare** (DD34). Both unique keys on this",
    "-- table are partial, so naming them for inference would restate their",
    "-- predicates here and duplicate index definitions into a seed; a bare clause",
    "-- covers the primary key and both partial keys at once and makes this migration",
    "-- safely re-runnable against a database that already has these rows.",
    "--",
    "-- This file writes one table and nothing else: no backfill state row, no queue",
    "-- job, no provider call. That is what makes the catalogue's backfill lazy",
    "-- structurally rather than by intention (FR-21, AC-22) — a seeded row nobody",
    "-- holds is invisible to every ingestion lane, which all fan out from held",
    "-- positions. The single-target property is asserted by the regeneration drift",
    "-- test, not just stated here.",
    `INSERT INTO "instrument" (${columnList}) VALUES`,
    rows
      .map(
        (row, index) =>
          `  (${[
            sqlStringLiteral(row.id),
            "'SHARE'",
            sqlStringLiteral(row.displayName),
            sqlStringLiteral(row.listingCurrency),
            sqlStringLiteral(row.exchangeMic),
            sqlStringLiteral(row.isin),
            sqlStringLiteral(row.symbol),
            "'ISIN'",
            "'AUTO'",
            sqlStringLiteral(row.domicileCountry),
          ].join(", ")})${index === rows.length - 1 ? "" : ","}`,
      )
      .join("\n"),
    "ON CONFLICT DO NOTHING;",
    "",
  ];
  return lines.join("\n");
}

async function loadDataset(datasetPath: string | undefined): Promise<readonly SeededInstrument[]> {
  if (datasetPath === undefined) return SEEDED_INSTRUMENTS;

  const targetUrl = pathToFileURL(resolve(datasetPath));
  const target = fileURLToPath(targetUrl);
  let loaded: unknown;
  try {
    loaded = (await import(targetUrl.href)) as unknown;
  } catch (error) {
    console.error(`db:seed:generate:instruments: could not load ${target}: ${String(error)}`);
    process.exit(1);
  }
  const exported = (loaded as { SEEDED_INSTRUMENTS?: unknown }).SEEDED_INSTRUMENTS;
  if (!Array.isArray(exported)) {
    console.error(
      `db:seed:generate:instruments: ${target} does not export a SEEDED_INSTRUMENTS array.`,
    );
    process.exit(1);
  }
  return exported as readonly SeededInstrument[];
}

async function main(): Promise<void> {
  const rows = await loadDataset(process.argv[2]);
  const outFile =
    process.argv[3] === undefined ? INSTRUMENT_SEED_MIGRATION_FILE : resolve(process.argv[3]);

  // The gate runs **first**, and a violation ends the process before
  // `writeFileSync` is reached: a bad row must not be able to reach a migration
  // file even if `pnpm instrument-catalogue-gate` were skipped.
  const violations = validateSeededInstruments(rows);
  if (violations.length > 0) {
    console.error(
      `db:seed:generate:instruments: refusing to write ${outFile} — ${violations.length} violation(s) across ${rows.length} seeded instrument row(s):\n${formatSeedViolations(violations)}`,
    );
    process.exit(1);
  }

  writeFileSync(outFile, renderInstrumentCatalogueSeedSql(rows), "utf8");
  console.log(`Wrote ${rows.length} instrument rows to ${outFile}`);
}

// Runs only when this module *is* the process entrypoint — never on import, the
// same guard `migrate-main.ts` and `worker-main.ts` use. Importing this module
// must not write a migration, because the drift test imports it.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
