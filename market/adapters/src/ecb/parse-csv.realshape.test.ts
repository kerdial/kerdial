import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseHistoricalCsv } from "./parse-csv.js";

/**
 * Fidelity regression against the REAL ECB statistics API shape.
 *
 * The other parse-csv tests use hand-authored fixtures, which prove the parser
 * handles the shape we *believe* the API returns. This one pins the shape it
 * actually returns: `sdw-exr-realshape.csv` is the verbatim body of two
 * requests made on 2026-10-02 —
 * `EXR/D.JPY+SEK+USD.EUR.SP00.A?format=csvdata&detail=dataonly` for
 * 1999-01-04 and for 2026-07-21, the second without its header line — not
 * authored by hand.
 *
 * Two real-world details this locks down:
 *
 *  1. Rows are grouped by **series** (currency), then date — not one row per
 *     date as `eurofxref-hist.csv` had it.
 *  2. The values are the same reference rates the old file carried: the
 *     1999-01-04 and 2026-07-21 USD/JPY figures below are the ones the
 *     previous `eurofxref-hist.zip` capture (2026-07-21) held.
 *
 * If ECB changes its format, this test fails and names the reason — far better
 * than the adapter failing on its first real backfill.
 */
const here = dirname(fileURLToPath(import.meta.url));
const realShapeCsv = readFileSync(
  join(here, "..", "..", "__fixtures__", "ecb", "sdw-exr-realshape.csv"),
  "utf8",
);

describe("parseHistoricalCsv — real ECB statistics API shape (captured 2026-10-02)", () => {
  it("reads every requested currency from the real header", () => {
    const table = parseHistoricalCsv(realShapeCsv);
    expect([...table.currencies].sort()).toEqual(["JPY", "SEK", "USD"]);
  });

  it("reads real published values exactly, with no float drift", () => {
    const table = parseHistoricalCsv(realShapeCsv);
    const byDate = new Map(table.rows.map((r) => [r.date, r]));

    // Verbatim from the real response — if these change, the parser is misreading columns.
    expect(byDate.get("2026-07-21")?.values.get("USD")).toBe("1.1418");
    expect(byDate.get("2026-07-21")?.values.get("JPY")).toBe("185.82");
    expect(byDate.get("1999-01-04")?.values.get("USD")).toBe("1.1789");
    expect(byDate.get("1999-01-04")?.values.get("JPY")).toBe("133.73");
    expect(byDate.get("1999-01-04")?.values.get("SEK")).toBe("9.4696");
  });

  it("pivots the series-grouped rows into date-ascending rows", () => {
    const table = parseHistoricalCsv(realShapeCsv);
    expect(table.rows.map((r) => r.date)).toEqual(["1999-01-04", "2026-07-21"]);
    expect(table.rows.every((r) => r.values.size === 3)).toBe(true);
  });
});
