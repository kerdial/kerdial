import { boolean, date, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * `market_calendar` — by assumption, "a static
 * checked-in dataset covering Euronext Paris and NYSE/NASDAQ sessions and
 * holidays, and the TARGET closing-day calendar for FX, refreshed manually
 * once a year." Shared reference data: no `tenant_id`.
 *
 * `calendar_key` is a free-text identifier rather than an enum so a new
 * calendar can be seeded without a migration — `'XPAR'`/`'XNYS'`/`'XNAS'`
 * (ISO 10383 MICs, matching `instrument.exchange_mic`) plus `'TARGET'`
 * (not a MIC — the Eurosystem's own FX-settlement closing-day calendar,
 * OQ-13).
 *
 * Only exception days are seeded (`is_open = false`): a date's absence from
 * this table means "ordinary weekday session" by convention, so the table
 * stays a small, hand-auditable list of holidays rather than a full
 * 10-year calendar of every trading day. This is deliberate: a
 * stale/incomplete calendar as causing benign over-polling (a market-hours
 * check treats an unlisted holiday as an ordinary open day), never wrong
 * price/FX data — so the cheap failure mode is the one an incomplete seed
 * produces.
 */
export const marketCalendar = pgTable(
  "market_calendar",
  {
    calendarKey: text("calendar_key").notNull(),
    sessionDate: date("session_date").notNull(),
    isOpen: boolean("is_open").notNull(),
    label: text("label"), // e.g. 'Good Friday' — human-readable, not consumed by logic
  },
  (table) => [primaryKey({ columns: [table.calendarKey, table.sessionDate] })],
);
