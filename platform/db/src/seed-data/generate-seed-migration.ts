/**
 * Generates `migrations/0002_seed_currencies.sql` from the checked-in
 * `ISO_4217_CURRENCIES` list in this directory. Run via
 * `pnpm --filter @kerdial/platform-db run db:seed:generate` whenever
 * `iso-4217-currencies.ts` changes, so the migration and its source data
 * never drift apart (NFR-13).
 *
 * Not a `drizzle-kit`-tracked schema migration (no table shape changes) —
 * this is a plain data-seed SQL file, numbered to run after the schema
 * migration that creates `currency` (0001).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ISO_4217_CURRENCIES } from "./iso-4217-currencies.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "..", "migrations", "0002_seed_currencies.sql");

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main(): void {
  const lines = [
    "-- Generated from platform/db/src/seed-data/iso-4217-currencies.ts",
    "-- by platform/db/src/seed-data/generate-seed-migration.ts. Do not hand-edit —",
    "-- edit the source list and regenerate instead.",
    "--",
    "-- Seeds `currency` from the ISO 4217 active-currency list (NFR-13).",
    "-- `ON CONFLICT DO NOTHING` makes this migration safely",
    "-- re-runnable against a database that already has these rows.",
    'INSERT INTO "currency" ("code", "name", "minor_unit", "is_active") VALUES',
    ISO_4217_CURRENCIES.map(
      (c, i) =>
        `  (${sqlStringLiteral(c.code)}, ${sqlStringLiteral(c.name)}, ${c.minorUnit}, true)${
          i === ISO_4217_CURRENCIES.length - 1 ? "" : ","
        }`,
    ).join("\n"),
    'ON CONFLICT ("code") DO NOTHING;',
    "",
  ];
  writeFileSync(outFile, lines.join("\n"), "utf8");
  console.log(`Wrote ${ISO_4217_CURRENCIES.length} currency rows to ${outFile}`);
}

main();
