/**
 * Static, checked-in `market_calendar` seed data —
 * By assumption: "we seed a `market_calendar` table with Euronext Paris and
 * NYSE/NASDAQ sessions and holidays, and the TARGET closing-day calendar for
 * FX, from a static checked-in dataset, refreshed manually once a year."
 *
 * Only exception (closed) days are listed — see `market-calendar.ts`'s
 * schema comment for why an absent date means "ordinary open weekday" by
 * convention. Refresh this list manually once a year; a stale or
 * incomplete calendar causes benign over-polling, never wrong price/FX
 * data, which is why this is a hand-maintained static list rather than a
 * computed one.
 *
 * `XPAR` — Euronext Paris (ISO 10383 MIC, matches `instrument.exchange_mic`).
 * `XNYS` — NYSE. `XNAS` — NASDAQ (identical US market holiday calendar to
 * XNYS in practice, kept as separate rows per the "NYSE and
 * NASDAQ" wording). `TARGET` — the Eurosystem's own FX-settlement
 * closing-day calendar (OQ-13), not a MIC.
 */
export interface MarketCalendarHoliday {
  readonly calendarKey: "XPAR" | "XNYS" | "XNAS" | "TARGET";
  readonly date: string; // ISO date (YYYY-MM-DD)
  readonly label: string;
}

// Euronext-wide holiday calendar (New Year's Day, Good Friday, Easter
// Monday, Labour Day, Christmas Day, Boxing Day) — also the TARGET2
// closing-day calendar, which is identical for these six dates every year
// ("TARGET's own closing-day calendar governs
// this, not any single member state's holiday calendar").
const EURONEXT_AND_TARGET_HOLIDAYS: ReadonlyArray<{ date: string; label: string }> = [
  // 2024
  { date: "2024-01-01", label: "New Year's Day" },
  { date: "2024-03-29", label: "Good Friday" },
  { date: "2024-04-01", label: "Easter Monday" },
  { date: "2024-05-01", label: "Labour Day" },
  { date: "2024-12-25", label: "Christmas Day" },
  { date: "2024-12-26", label: "Boxing Day" },
  // 2025
  { date: "2025-01-01", label: "New Year's Day" },
  { date: "2025-04-18", label: "Good Friday" },
  { date: "2025-04-21", label: "Easter Monday" },
  { date: "2025-05-01", label: "Labour Day" },
  { date: "2025-12-25", label: "Christmas Day" },
  { date: "2025-12-26", label: "Boxing Day" },
  // 2026
  { date: "2026-01-01", label: "New Year's Day" },
  { date: "2026-04-03", label: "Good Friday" },
  { date: "2026-04-06", label: "Easter Monday" },
  { date: "2026-05-01", label: "Labour Day" },
  { date: "2026-12-25", label: "Christmas Day" },
  { date: "2026-12-26", label: "Boxing Day" },
];

// NYSE/NASDAQ published holiday calendar — identical for both exchanges.
const NYSE_NASDAQ_HOLIDAYS: ReadonlyArray<{ date: string; label: string }> = [
  // 2024
  { date: "2024-01-01", label: "New Year's Day" },
  { date: "2024-01-15", label: "Martin Luther King, Jr. Day" },
  { date: "2024-02-19", label: "Washington's Birthday" },
  { date: "2024-03-29", label: "Good Friday" },
  { date: "2024-05-27", label: "Memorial Day" },
  { date: "2024-06-19", label: "Juneteenth National Independence Day" },
  { date: "2024-07-04", label: "Independence Day" },
  { date: "2024-09-02", label: "Labor Day" },
  { date: "2024-11-28", label: "Thanksgiving Day" },
  { date: "2024-12-25", label: "Christmas Day" },
  // 2025
  { date: "2025-01-01", label: "New Year's Day" },
  { date: "2025-01-20", label: "Martin Luther King, Jr. Day" },
  { date: "2025-02-17", label: "Washington's Birthday" },
  { date: "2025-04-18", label: "Good Friday" },
  { date: "2025-05-26", label: "Memorial Day" },
  { date: "2025-06-19", label: "Juneteenth National Independence Day" },
  { date: "2025-07-04", label: "Independence Day" },
  { date: "2025-09-01", label: "Labor Day" },
  { date: "2025-11-27", label: "Thanksgiving Day" },
  { date: "2025-12-25", label: "Christmas Day" },
  // 2026
  { date: "2026-01-01", label: "New Year's Day" },
  { date: "2026-01-19", label: "Martin Luther King, Jr. Day" },
  { date: "2026-02-16", label: "Washington's Birthday" },
  { date: "2026-04-03", label: "Good Friday" },
  { date: "2026-05-25", label: "Memorial Day" },
  { date: "2026-06-19", label: "Juneteenth National Independence Day" },
  { date: "2026-07-03", label: "Independence Day (observed)" }, // Jul 4 falls on a Saturday
  { date: "2026-09-07", label: "Labor Day" },
  { date: "2026-11-26", label: "Thanksgiving Day" },
  { date: "2026-12-25", label: "Christmas Day" },
];

export const MARKET_CALENDAR_HOLIDAYS: readonly MarketCalendarHoliday[] = [
  ...EURONEXT_AND_TARGET_HOLIDAYS.map((h) => ({ calendarKey: "XPAR" as const, ...h })),
  ...EURONEXT_AND_TARGET_HOLIDAYS.map((h) => ({ calendarKey: "TARGET" as const, ...h })),
  ...NYSE_NASDAQ_HOLIDAYS.map((h) => ({ calendarKey: "XNYS" as const, ...h })),
  ...NYSE_NASDAQ_HOLIDAYS.map((h) => ({ calendarKey: "XNAS" as const, ...h })),
];
