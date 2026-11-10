const FR_SHORT_DATE = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeZone: "UTC" });

/**
 * An ISO `YYYY-MM-DD` date as the French short form the ledger already uses
 * (`10/09/2026`), so a date range beside a table never shows two calendars on
 * one screen. Falls back to the raw string when the input does not parse.
 */
export function formatFrenchShortDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? FR_SHORT_DATE.format(parsed) : isoDate;
}

/**
 * The **date** of an ISO-8601 *instant* (`2026-09-19T08:00:39Z`), in the same
 * French short form — `account-setup` UR-71's « Création » and « Dernière
 * connexion » columns.
 *
 * Only the date, deliberately. `GET /admin/users` answers UTC seconds, this
 * screen carries no timezone marker, and a bare `08:00` would be wrong by the
 * reader's own offset for most readers — a figure the data does not support.
 * The date itself is read in UTC (`FR_SHORT_DATE`'s own `timeZone`), so the
 * rendering does not drift with the machine that renders it.
 *
 * Falls back to the raw string when the input does not parse, like its
 * sibling above: a malformed timestamp must not blank a row.
 */
export function formatFrenchShortDateFromInstant(isoInstant: string): string {
  const parsed = new Date(isoInstant);
  return Number.isFinite(parsed.getTime()) ? FR_SHORT_DATE.format(parsed) : isoInstant;
}
