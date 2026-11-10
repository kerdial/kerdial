import { describe, expect, it } from "vitest";
import { toValuePointSeries } from "../lib/chart-series.js";
import { buildInvestedCapitalGeometry } from "./InvestedCapitalChart.js";

/**
 * `buildInvestedCapitalGeometry` — the pure half of the value vs.
 * invested-capital chart. Asserted without a DOM: the zero-inclusive domain,
 * the {1,2,5}×10ⁿ ticks, the gap arithmetic, the break where a contribution
 * is missing, and the month-end sampling the table reads.
 */
function series(points: readonly (readonly [string, string])[]) {
  return toValuePointSeries(points.map(([date, value]) => ({ date, value }))).points;
}

describe("buildInvestedCapitalGeometry", () => {
  it("computes gap = value − contributions in Decimal and drops to a zero-inclusive domain", () => {
    const geometry = buildInvestedCapitalGeometry(
      series([
        ["2026-01-01", "1000.10"],
        ["2026-01-02", "1200.30"],
      ]),
      series([
        ["2026-01-01", "900.00"],
        ["2026-01-02", "900.00"],
      ]),
    );
    expect(geometry.rows.map((row) => row.gap)).toEqual(["100.1", "300.3"]);
    // The lowest tick is zero — the floor is never the smallest value.
    expect(geometry.ticks[0]?.text).toBe("0");
    // 1200.30 / 4 ≈ 300 → snapped to 500 → ticks 0, 500, 1000.
    // U+202F narrow no-break space is the figure formatter's own grouping separator.
    expect(geometry.ticks.map((tick) => tick.text)).toEqual(["0", "500", "1\u202f000"]);
    expect(geometry.trend).toBe("gain");
    // The value line reaches the top of the plot on its maximum.
    expect(geometry.valuePoints).toBe("0,33.36 1000,0");
  });

  it("breaks the contributions line where a date has no readable contribution, never bridging it", () => {
    const geometry = buildInvestedCapitalGeometry(
      series([
        ["2026-01-01", "100"],
        ["2026-01-02", "100"],
        ["2026-01-03", "100"],
      ]),
      series([
        ["2026-01-01", "50"],
        ["2026-01-03", "50"],
      ]),
    );
    expect(geometry.rows[1]?.contributions).toBeUndefined();
    expect(geometry.rows[1]?.gap).toBeUndefined();
    expect(geometry.contributionSegments).toEqual(["0,100", "1000,100"]);
  });

  it("samples the table at each month's last point plus the range's last day", () => {
    const geometry = buildInvestedCapitalGeometry(
      series([
        ["2026-01-30", "1"],
        ["2026-01-31", "1"],
        ["2026-02-01", "1"],
        ["2026-02-02", "1"],
      ]),
      [],
    );
    expect(geometry.tableIndices.map((index) => geometry.rows[index]?.date)).toEqual([
      "2026-01-31",
      "2026-02-02",
    ]);
    expect(geometry.xLabelIndices).toEqual([0, 1, 2, 3]);
  });

  it("a flat all-zero series still yields one tick and a drawable line", () => {
    const geometry = buildInvestedCapitalGeometry(
      series([
        ["2026-01-01", "0"],
        ["2026-01-02", "0"],
      ]),
      series([
        ["2026-01-01", "0"],
        ["2026-01-02", "0"],
      ]),
    );
    expect(geometry.ticks).toHaveLength(1);
    expect(geometry.ticks[0]?.text).toBe("0");
    expect(geometry.trend).toBe("flat");
    expect(geometry.valuePoints).toBe("0,200 1000,200");
  });

  it("a negative net contribution (withdrawals above deposits) extends the domain below zero", () => {
    const geometry = buildInvestedCapitalGeometry(
      series([["2026-01-01", "100"]]),
      series([["2026-01-01", "-50"]]),
    );
    // U+2212, the typographic minus the figure formatter emits.
    expect(geometry.ticks[0]?.text).toBe("\u221250");
    expect(geometry.rows[0]?.gap).toBe("150");
  });

  it("domain: 'data' spans the drawn amounts padded 4 % each side, never reaching down to zero", () => {
    const geometry = buildInvestedCapitalGeometry(
      [
        { date: "2026-01-01", amount: "800.00", value: 800 },
        { date: "2026-01-02", amount: "1000.00", value: 1000 },
      ],
      [{ date: "2026-01-01", amount: "800.00", value: 800 }],
      { domain: "data" },
    );
    // 800…1000 → 792…1008: step 50, ticks 800 … 1 000, and the lowest is not 0.
    expect(geometry.ticks.map((tick) => tick.text)).toEqual([
      "800",
      "850",
      "900",
      "950",
      "1\u202f000",
    ]);
    // 1000 sits 8 above the top of a 216-wide domain: y = 200 − (208/216)·200 ≈ 7.41.
    expect(geometry.valuePoints.split(" ")[1]).toBe("1000,7.41");
    // The default is unchanged: the same points from zero.
    const zeroBased = buildInvestedCapitalGeometry(
      [{ date: "2026-01-01", amount: "800.00", value: 800 }],
      [],
    );
    expect(zeroBased.ticks[0]?.text).toBe("0");
  });
});
