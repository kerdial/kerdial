import { ProviderMalformedResponse } from "@kerdial/market-ports";
import type { CurrencyCode, IsoDate } from "@kerdial/market-ports";
import { ECB_BASE_CURRENCY, ECB_PROVIDER_KEY } from "./currencies.js";

/**
 * One published date of the ECB history, parsed. `values` holds only the
 * currencies that actually published a rate that day: the statistics API
 * either has no row for a currency on a date it did not publish, or a row
 * with an empty `OBS_VALUE` (TARGET closing days such as 1999-12-31 or
 * 2012-05-01 — 1728 such rows across the 31 live currencies, checked
 * 2026-10-02), and this parser drops both the same way, so a
 * missing currency for a given date is indistinguishable from "never asked
 * for" at this layer — {@link import("./provider.js").EcbFxRateProvider} is
 * the layer that decides what a gap means (LOCF for a cross-rate leg, or an
 * omitted date for a direct pair).
 */
export interface EcbHistoricalRow {
  readonly date: IsoDate;
  readonly values: ReadonlyMap<CurrencyCode, string>;
}

/** The parsed history — {@link EcbHistoricalRow.date}-ascending, per this port's date-ascending contract. */
export interface EcbHistoricalTable {
  readonly currencies: readonly CurrencyCode[];
  readonly rows: readonly EcbHistoricalRow[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SOURCE = "ECB statistics API csvdata";

/** The columns this parser reads, located by name in the header — the API's own column order is not something to depend on. */
const REQUIRED_COLUMNS = ["CURRENCY", "CURRENCY_DENOM", "TIME_PERIOD", "OBS_VALUE"] as const;

function malformed(message: string): ProviderMalformedResponse {
  return new ProviderMalformedResponse(ECB_PROVIDER_KEY, `${SOURCE}: ${message}`);
}

/**
 * Parses the ECB statistics API's `csvdata` body for the `EXR` dataflow:
 * a header row naming the columns — with `detail=dataonly`,
 * `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE`
 * — then one row per currency per published date, grouped by series rather
 * than by date. Each `OBS_VALUE` is ECB's own EUR-base convention
 * ("1 EUR = <value> <CURRENCY>"), or empty for a day the currency was not
 * published (skipped, as `eurofxref-hist.csv`'s `N/A` used to be). The rows
 * are pivoted back into one row per date, date-ascending.
 *
 * An **empty body is an empty table**, not an error: the API answers a range
 * with no observation in it with `200` and no body at all (not even the
 * header), and the provider turns "no rows" into a `DataGap`. Every other
 * shape that does not match — a header missing a required column, a quoted
 * field, a row with the wrong cell count, a denominator other than EUR, an
 * unparseable currency, date or value, or the same currency twice on one
 * date — is a {@link ProviderMalformedResponse}: this is "the provider
 * changed its response shape," never silently coerced or skipped (no
 * provider DTO leaks).
 */
export function parseHistoricalCsv(csv: string): EcbHistoricalTable {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { currencies: [], rows: [] };

  if (lines.some((line) => line.includes('"'))) {
    // `dataonly` has no free-text column; a quoted field means the request
    // shape changed and a comma split would misalign every column after it.
    throw malformed("unexpected quoted field");
  }

  const header = lines[0]!.split(",").map((cell) => cell.trim());
  const index = Object.fromEntries(
    REQUIRED_COLUMNS.map((column) => [column, header.indexOf(column)]),
  ) as Record<(typeof REQUIRED_COLUMNS)[number], number>;
  const missing = REQUIRED_COLUMNS.filter((column) => index[column] < 0);
  if (missing.length > 0) {
    throw malformed(`header row lacks ${missing.join(", ")}: "${lines[0]}"`);
  }

  const byDate = new Map<IsoDate, Map<CurrencyCode, string>>();
  const currencies: CurrencyCode[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length !== header.length) {
      throw malformed(`row has ${cells.length} cells, header has ${header.length}: "${line}"`);
    }
    const currency = cells[index.CURRENCY]!;
    const denominator = cells[index.CURRENCY_DENOM]!;
    const date = cells[index.TIME_PERIOD]!;
    const raw = cells[index.OBS_VALUE]!;

    if (!CURRENCY_PATTERN.test(currency)) {
      throw malformed(`unparseable currency in row: "${line}"`);
    }
    if (denominator !== ECB_BASE_CURRENCY) {
      throw malformed(`rate not quoted against ${ECB_BASE_CURRENCY}: "${line}"`);
    }
    if (!DATE_PATTERN.test(date)) {
      throw malformed(`unparseable date in row: "${line}"`);
    }
    if (raw === "") continue;
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      throw malformed(`unparseable rate for ${currency} on ${date}: "${raw}"`);
    }

    const values = byDate.get(date) ?? new Map<CurrencyCode, string>();
    if (values.has(currency)) {
      throw malformed(`${currency} appears twice on ${date}`);
    }
    values.set(currency, raw);
    byDate.set(date, values);
    if (!currencies.includes(currency)) currencies.push(currency);
  }

  const rows: EcbHistoricalRow[] = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, values]) => ({ date, values }));
  return { currencies, rows };
}
