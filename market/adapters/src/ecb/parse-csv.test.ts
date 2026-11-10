import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderMalformedResponse } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./parse-csv.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "ecb");
const HIST_FIXTURE = readFileSync(join(fixturesDir, "sdw-exr-fixture.csv"), "utf8");

const HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE";
function row(currency: string, date: string, value: string, denominator = "EUR"): string {
  return `EXR.D.${currency}.${denominator}.SP00.A,D,${currency},${denominator},SP00,A,${date},${value}`;
}
function body(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("parseHistoricalCsv", () => {
  it("pivots the series-grouped rows into one row per date, date-ascending", () => {
    const table = parseHistoricalCsv(HIST_FIXTURE);

    expect([...table.currencies].sort()).toEqual(["CHF", "GBP", "JPY", "RUB", "USD"]);
    expect(table.rows.map((r) => r.date)).toEqual([
      "1999-01-04",
      "2022-02-28",
      "2022-03-01",
      "2022-03-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
      "2024-01-08",
      "2024-01-09",
      "2024-01-10",
    ]);
  });

  it("leaves a currency out of a date it has no row for", () => {
    const table = parseHistoricalCsv(HIST_FIXTURE);
    const row20240109 = table.rows.find((r) => r.date === "2024-01-09");
    expect(row20240109?.values.has("RUB")).toBe(false);
    expect(row20240109?.values.get("USD")).toBe("1.0940");
  });

  it("skips a row with an empty value — how the API reports a day the currency was not published", () => {
    const table = parseHistoricalCsv(
      body(
        row("USD", "1999-12-30", "1.0046"),
        row("USD", "1999-12-31", ""),
        row("GBP", "1999-12-31", ""),
      ),
    );
    expect(table.rows.map((r) => r.date)).toEqual(["1999-12-30"]);
    expect(table.rows[0]?.values.get("USD")).toBe("1.0046");
  });

  it("keeps published values verbatim as strings (no float coercion)", () => {
    const table = parseHistoricalCsv(HIST_FIXTURE);
    const r = table.rows.find((candidate) => candidate.date === "2024-01-10");
    expect(r?.values.get("JPY")).toBe("160.50");
  });

  it("reads an empty body — the API's answer for a range with no observation — as an empty table", () => {
    expect(parseHistoricalCsv("")).toEqual({ currencies: [], rows: [] });
    expect(parseHistoricalCsv("\n\n")).toEqual({ currencies: [], rows: [] });
    expect(parseHistoricalCsv(`${HEADER}\n`)).toEqual({ currencies: [], rows: [] });
  });

  it("locates columns by header name, not position", () => {
    const table = parseHistoricalCsv(
      "OBS_VALUE,TIME_PERIOD,CURRENCY_DENOM,CURRENCY\n1.0850,2024-01-10,EUR,USD\n",
    );
    expect(table.rows[0]?.values.get("USD")).toBe("1.0850");
  });

  it("throws ProviderMalformedResponse on the old eurofxref-hist.csv shape", () => {
    expect(() => parseHistoricalCsv("Date,USD,GBP\n2024-01-10,1.0850,0.8590\n")).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("throws ProviderMalformedResponse on a row whose cell count differs from the header's", () => {
    expect(() =>
      parseHistoricalCsv(body("EXR.D.USD.EUR.SP00.A,D,USD,EUR,2024-01-10,1.08")),
    ).toThrow(ProviderMalformedResponse);
  });

  it("throws ProviderMalformedResponse on a quoted field", () => {
    expect(() => parseHistoricalCsv(body(row("USD", "2024-01-10", '"1.0850"')))).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("throws ProviderMalformedResponse on a rate not quoted against EUR", () => {
    expect(() => parseHistoricalCsv(body(row("USD", "2024-01-10", "1.0850", "GBP")))).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("throws ProviderMalformedResponse on an unparseable currency or date", () => {
    expect(() => parseHistoricalCsv(body(row("usd", "2024-01-10", "1.0850")))).toThrow(
      ProviderMalformedResponse,
    );
    expect(() => parseHistoricalCsv(body(row("USD", "2024-01", "1.0850")))).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("throws ProviderMalformedResponse on a value that is not a plain decimal numeral", () => {
    for (const value of ["1.0e2", "NaN", "N/A", "-1.08"]) {
      expect(() => parseHistoricalCsv(body(row("USD", "2024-01-10", value)))).toThrow(
        ProviderMalformedResponse,
      );
    }
  });

  it("throws ProviderMalformedResponse on the same currency twice on one date", () => {
    expect(() =>
      parseHistoricalCsv(
        body(row("USD", "2024-01-10", "1.0850"), row("USD", "2024-01-10", "1.09")),
      ),
    ).toThrow(ProviderMalformedResponse);
  });
});
