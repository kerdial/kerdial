/**
 * Generates `migrations/0006_seed_market_calendar.sql` from the checked-in
 * `MARKET_CALENDAR_HOLIDAYS` list in this directory. Run via
 * `pnpm --filter @kerdial/platform-db run db:seed:generate:market-calendar`
 * whenever `market-calendar.ts` (the seed source data) changes, so the
 * migration and its source data never drift apart.
 *
 * Not a `drizzle-kit`-tracked schema migration (no table shape changes) —
 * this is a plain data-seed SQL file, numbered to run after the schema
 * migration that creates `market_calendar` (0005), mirroring the pattern
 * `generate-seed-migration.ts` (T-5) established for `currency`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKET_CALENDAR_HOLIDAYS } from "./market-calendar.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "..", "migrations", "0006_seed_market_calendar.sql");

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function main(): void {
  const lines = [
    "-- Generated from platform/db/src/seed-data/market-calendar.ts",
    "-- by platform/db/src/seed-data/generate-market-calendar-seed-migration.ts.",
    "-- Do not hand-edit — edit the source list and regenerate instead.",
    "--",
    "-- Seeds `market_calendar` from the checked-in Euronext Paris / NYSE /",
    "-- NASDAQ / TARGET holiday dataset.",
    "-- Only exception (closed) days are seeded — `is_open` is always false",
    "-- here; an absent date means 'ordinary open weekday' by convention.",
    "-- `ON CONFLICT DO NOTHING` makes this migration safely re-runnable",
    "-- against a database that already has these rows.",
    'INSERT INTO "market_calendar" ("calendar_key", "session_date", "is_open", "label") VALUES',
    MARKET_CALENDAR_HOLIDAYS.map(
      (h, i) =>
        `  (${sqlStringLiteral(h.calendarKey)}, ${sqlStringLiteral(h.date)}, false, ${sqlStringLiteral(h.label)})${
          i === MARKET_CALENDAR_HOLIDAYS.length - 1 ? "" : ","
        }`,
    ).join("\n"),
    'ON CONFLICT ("calendar_key", "session_date") DO NOTHING;',
    "",
  ];
  writeFileSync(outFile, lines.join("\n"), "utf8");
  console.log(`Wrote ${MARKET_CALENDAR_HOLIDAYS.length} market_calendar rows to ${outFile}`);
}

main();
