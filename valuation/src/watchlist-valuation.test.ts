import { Decimal } from "@kerdial/core-decimal";
import type { IsoDate, PricePoint } from "@kerdial/core-domain";
import { describe, expect, it } from "vitest";
import {
  MAX_WATCHLIST_ROWS_PER_VIEW,
  TooManyWatchlistRowsError,
  WATCHLIST_SERIES_MAX_POINTS,
  assembleWatchlist,
  resolveWatchlistWindow,
  watchlistSeriesFromDate,
  type LoadedWatchlistInputs,
  type ValuedWatchlistRow,
} from "./watchlist-valuation.js";

/**
 * `watchlist` — the **pure** half of the
 * watchlist read, driven directly (`assembleWatchlist` is a package-internal
 * export for exactly this). No database: everything asserted here is
 * arithmetic and precedence, and putting it behind Testcontainers would only
 * make the same assertions slower and the failures harder to read. The
 * DB-facing half (three statements, the icon join, the query plan, the
 * serialised size) is `watchlist-valuation.integration.test.ts`.
 *
 * Every fixture ratio **terminates in base 10** (100 → 150, 100 → 105), per
 * R2(a): the metrics here are `+ − × ÷` only, so an exact string match is
 * achievable and is what these assertions use.
 */

type WatchlistItem = LoadedWatchlistInputs["items"][number];

const ASOF = "2026-06-01" as IsoDate;

function item(instrumentId: string, overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    instrumentId,
    targetPrice: null,
    note: null,
    createdAt: new Date("2026-01-15T09:30:00.000Z"),
    kind: "SHARE",
    displayName: `Fixture ${instrumentId}`,
    listingCurrency: "EUR",
    exchangeMic: "XPAR",
    sectorCode: null,
    industryLabel: null,
    domicileCountry: null,
    status: "ACTIVE",
    hasIcon: false,
    ...overrides,
  };
}

function daily(instrumentId: string, date: string, close: string): PricePoint {
  return {
    instrumentId,
    observedOn: date as IsoDate,
    price: new Decimal(close),
    currency: "EUR",
    sourceKey: "yahoo",
    origin: "DAILY",
  };
}

function manual(instrumentId: string, date: string, close: string): PricePoint {
  return {
    instrumentId,
    observedOn: date as IsoDate,
    price: new Decimal(close),
    currency: "EUR",
    sourceKey: "manual",
    origin: "MANUAL",
  };
}

function assemble(
  items: readonly WatchlistItem[],
  prices: readonly PricePoint[],
  window: "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y" = "YTD",
): ReturnType<typeof assembleWatchlist> {
  const priceQualityByKey = new Map<string, "EOD" | "DELAYED" | "REALTIME">();
  for (const point of prices) {
    if (point.origin === "DAILY") {
      priceQualityByKey.set(`${point.instrumentId}|${point.observedOn}`, "EOD");
    }
  }
  return assembleWatchlist(
    { items, prices, priceQualityByKey },
    { tenantId: "tenant-fixture", asOfDate: ASOF, window },
  );
}

/** The wire's own view of a row — what `JSON.stringify` actually drops (W-10). */
function serialised(row: ValuedWatchlistRow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

describe("assembleWatchlist — the merge of the two price origins (W-3)", () => {
  /**
   * The one place the two sources must be **merged** rather than *resolved*,
   * with manual winning on a shared date — the same precedence `resolvePrice`
   * encodes (`core/domain/valuation.ts:283-289`). Asserted through the YTD
   * return, whose end point *is* the shared date: manual gives
   * `150 / 100 − 1 = 0.5`, and a daily-wins merge would give `0.2`. So this
   * case can only pass for the right reason.
   */
  it("manual wins on a shared date — the YTD return is measured to the manual close, not the daily one", () => {
    const id = "aaaa";
    const view = assemble(
      [item(id)],
      [
        // Before 1 January, so the YTD window is *covered*: the coverage rule asks
        // that the series reach back **past** the window start, not merely
        // into it.
        daily(id, "2025-12-31", "90"),
        daily(id, "2026-01-02", "100"),
        daily(id, "2026-05-01", "110"),
        daily(id, "2026-06-01", "120"),
        manual(id, "2026-06-01", "150"),
      ],
    );

    const row = view.rows[0]!;
    expect(row.metrics.periodReturns["YTD"]?.toString()).toBe("0.5");
    // The series the client charts carries the same merged close — one point
    // per date, never two on 2026-06-01.
    expect(row.series.map((point) => point.date)).toEqual([
      "2026-01-02",
      "2026-05-01",
      "2026-06-01",
    ]);
    expect(row.series.at(-1)?.close.toString()).toBe("150");
  });

  it("the resolved current price follows the same precedence, with MANUAL provenance and the manual source key", () => {
    const id = "bbbb";
    const view = assemble(
      [item(id)],
      [daily(id, "2026-06-01", "120"), manual(id, "2026-06-01", "150")],
    );

    const row = view.rows[0]!;
    expect(row.currentPrice?.amount.toString()).toBe("150");
    expect(row.currentPrice?.currency).toBe("EUR");
    expect(row.currentPrice?.provenance.priceQuality).toBe("MANUAL");
    expect(row.currentPrice?.provenance.priceSource).toBe("manual");
    expect(row.currentPrice?.provenance.derivedFrom).toEqual(["MANUAL_PRICE"]);
    // Freshness is `buildPriceFlags`' own, reused verbatim: a manual point one
    // day old is well inside `MANUAL_STALE_AFTER_DAYS` (FR-344 — no second
    // staleness horizon).
    expect(row.currentPrice?.provenance.priceIsStale).toBe(false);
    expect(row.currentPrice?.provenance.priceAsOf).toBe("2026-06-01");
  });

  it("a strictly newer daily close wins over an older manual NAV — the precedence is by date, not by origin alone", () => {
    const id = "cccc";
    const view = assemble(
      [item(id)],
      [manual(id, "2026-05-01", "150"), daily(id, "2026-06-01", "120")],
    );
    expect(view.rows[0]!.currentPrice?.amount.toString()).toBe("120");
    expect(view.rows[0]!.currentPrice?.provenance.priceQuality).toBe("EOD");
  });
});

describe("assembleWatchlist — bucketing by instrument (W-3)", () => {
  it("each row reads only its own points, with the flat array carrying both instruments interleaved by date", () => {
    const a = "aaaa";
    const b = "bbbb";
    const view = assemble(
      [item(a, { displayName: "Alpha" }), item(b, { displayName: "Beta" })],
      [
        daily(a, "2026-01-02", "100"),
        daily(b, "2026-01-02", "900"),
        daily(a, "2026-03-02", "50"),
        daily(b, "2026-03-02", "1000"),
        daily(a, "2026-06-01", "200"),
        daily(b, "2026-06-01", "800"),
      ],
    );

    const alpha = view.rows.find((row) => row.displayName === "Alpha")!;
    const beta = view.rows.find((row) => row.displayName === "Beta")!;

    expect(alpha.currentPrice?.amount.toString()).toBe("200");
    expect(beta.currentPrice?.amount.toString()).toBe("800");
    // Alpha's 52-week high is its own 200, never Beta's 1000 — the assertion
    // a flat-array scan filtered by the wrong id would fail.
    expect(alpha.metrics.fiftyTwoWeek?.high.toString()).toBe("200");
    expect(beta.metrics.fiftyTwoWeek?.high.toString()).toBe("1000");
    expect(alpha.metrics.maxDrawdown?.fraction.toString()).toBe("-0.5");
    expect(beta.metrics.maxDrawdown?.fraction.toString()).toBe("-0.2");
  });
});

describe("assembleWatchlist — day change (FR-348)", () => {
  it("is the per-unit move against the previous observation, with no quantity anywhere in it", () => {
    const id = "aaaa";
    const view = assemble(
      [item(id)],
      [daily(id, "2026-05-31", "100"), daily(id, "2026-06-01", "105")],
    );

    const row = view.rows[0]!;
    expect(row.dayChange?.toString()).toBe("5");
    expect(row.dayChangePercent?.toString()).toBe("0.05");
  });

  it("is ABSENT — not 0, and not a present-but-null key — when the instrument has exactly one observation", () => {
    const id = "aaaa";
    const view = assemble([item(id)], [daily(id, "2026-06-01", "105")]);

    const row = view.rows[0]!;
    expect(row.dayChange).toBeUndefined();
    expect(row.dayChangePercent).toBeUndefined();
    // W-10 on the wire: the key is gone, so no `Number(x ?? 0)` can fabricate
    // a flat day.
    const wire = serialised(row);
    expect(Object.hasOwn(wire, "dayChange")).toBe(false);
    expect(Object.hasOwn(wire, "dayChangePercent")).toBe(false);
    // The positive companion: the price itself did resolve, so "absent" is
    // about the *previous* observation and not about the row being empty.
    expect(row.currentPrice?.amount.toString()).toBe("105");
  });
});

describe("assembleWatchlist — a watched instrument with zero price rows (FR-346, W-1)", () => {
  /**
   * The load-bearing consequence and W-1's whole reason for existing: this
   * must **return**, never throw. `valuePortfolio` would raise
   * `UnresolvablePriceError` here, which is why nothing on this path calls it.
   */
  it("returns the row successfully with every metric absent, and never throws", () => {
    const id = "aaaa";
    const view = assemble([item(id, { displayName: "Never backfilled" })], []);

    expect(view.rows).toHaveLength(1);
    const row = view.rows[0]!;
    expect(row.displayName).toBe("Never backfilled");
    expect(row.currentPrice).toBeUndefined();
    expect(row.dayChange).toBeUndefined();
    expect(row.series).toEqual([]);
    // Not "unusable" — the series is *empty*, which is a different fact from
    // "a non-positive close made every ratio meaningless" (the non-positive-close guard).
    expect(row.metrics.unusableSeries).toBe(false);
    expect(row.metrics.fiftyTwoWeek).toBeUndefined();
    expect(row.metrics.maxDrawdown).toBeUndefined();
    expect(row.metrics.annualisedVolatility).toBeUndefined();
    expect(row.metrics.sma50).toBeUndefined();
    expect(row.metrics.sma200).toBeUndefined();

    // On the wire, `periodReturns` is an object with **no keys** — the eight
    // window keys carry `undefined`, which `JSON.stringify` drops (W-10).
    // Never eight `null`s, and never eight zeroes.
    const wire = serialised(row);
    expect(obj(wire["metrics"])["periodReturns"]).toEqual({});
    expect(obj(wire["metrics"])["unusableSeries"]).toBe(false);
    expect(Object.hasOwn(obj(wire["metrics"]), "fiftyTwoWeek")).toBe(false);
    expect(Object.hasOwn(wire, "currentPrice")).toBe(false);
  });

  it("renders alongside a priced sibling in the same view — 'no data' and 'not loaded yet' are not the same row", () => {
    const priced = "bbbb";
    const bare = "aaaa";
    const view = assemble(
      [item(priced, { displayName: "Priced" }), item(bare, { displayName: "Bare" })],
      [daily(priced, "2026-05-31", "100"), daily(priced, "2026-06-01", "105")],
    );

    expect(view.rows.map((row) => row.displayName)).toEqual(["Bare", "Priced"]);
    expect(view.rows[0]!.currentPrice).toBeUndefined();
    expect(view.rows[1]!.currentPrice?.amount.toString()).toBe("105");
  });
});

describe("assembleWatchlist — the row cap (FR-365/NFR-39)", () => {
  function manyItems(count: number): WatchlistItem[] {
    return Array.from({ length: count }, (_unused, index) =>
      item(`instrument-${String(index).padStart(4, "0")}`),
    );
  }

  it(`accepts exactly ${String(MAX_WATCHLIST_ROWS_PER_VIEW)} rows`, () => {
    const view = assemble(manyItems(MAX_WATCHLIST_ROWS_PER_VIEW), []);
    expect(view.rows).toHaveLength(MAX_WATCHLIST_ROWS_PER_VIEW);
  });

  it("REJECTS the row past the cap — never a truncated array", () => {
    expect(() => assemble(manyItems(MAX_WATCHLIST_ROWS_PER_VIEW + 1), [])).toThrow(
      TooManyWatchlistRowsError,
    );
    try {
      assemble(manyItems(MAX_WATCHLIST_ROWS_PER_VIEW + 1), []);
      expect.unreachable("the cap must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TooManyWatchlistRowsError);
      expect((err as TooManyWatchlistRowsError).count).toBe(MAX_WATCHLIST_ROWS_PER_VIEW + 1);
      expect((err as TooManyWatchlistRowsError).limit).toBe(MAX_WATCHLIST_ROWS_PER_VIEW);
    }
  });
});

describe("assembleWatchlist — deterministic order", () => {
  it("orders by displayName ascending, case-insensitively, with instrumentId as the tie-break", () => {
    const view = assemble(
      [
        item("id-3", { displayName: "banana" }),
        item("id-1", { displayName: "Apple" }),
        item("id-2", { displayName: "apple" }),
        item("id-0", { displayName: "Cherry" }),
      ],
      [],
    );

    expect(view.rows.map((row) => [row.displayName, row.instrumentId])).toEqual([
      ["Apple", "id-1"],
      ["apple", "id-2"],
      ["banana", "id-3"],
      ["Cherry", "id-0"],
    ]);
  });
});

describe("assembleWatchlist — the window and the wire series", () => {
  it("echoes the resolved window, and the series carries only the selected window's points", () => {
    const id = "aaaa";
    const view = assemble(
      [item(id)],
      [
        // Outside the 3M window *and* before 1 January, so the YTD assertion
        // below has its coverage point.
        daily(id, "2025-12-20", "80"),
        daily(id, "2026-01-02", "100"),
        daily(id, "2026-04-01", "110"),
        daily(id, "2026-06-01", "120"),
      ],
      "3M",
    );

    expect(view.window).toEqual({ preset: "3M", from: "2026-03-01", to: "2026-06-01" });
    expect(view.asOfDate).toBe("2026-06-01");
    // 2026-01-02 is outside the 3M window and is absent from the chart — while
    // the *metrics* still read it (the SMA and the 5Y return are defined by
    // their own lookbacks, not by the screen's).
    expect(view.rows[0]!.series.map((point) => point.date)).toEqual(["2026-04-01", "2026-06-01"]);
    expect(view.rows[0]!.metrics.periodReturns["YTD"]?.toString()).toBe("0.2");
  });

  it("decimates a long series to the point budget (plus W-9's four preserved points at most)", () => {
    const id = "aaaa";
    const prices: PricePoint[] = [];
    // 400 consecutive days ending at `asOfDate`, all inside the 3Y window.
    for (let index = 0; index < 400; index += 1) {
      const date = new Date("2026-06-01T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() - (399 - index));
      prices.push(daily(id, date.toISOString().slice(0, 10), String(100 + index)));
    }
    const view = assemble([item(id)], prices, "3Y");

    const series = view.rows[0]!.series;
    expect(series.length).toBeGreaterThan(1);
    expect(series.length).toBeLessThanOrEqual(WATCHLIST_SERIES_MAX_POINTS + 3);
    // First, last, min and max survive decimation — the property that stops a
    // sparkline contradicting the 52-week-high figure printed beside it.
    expect(series.at(0)?.close.toString()).toBe("100");
    expect(series.at(-1)?.close.toString()).toBe("499");
  });
});

describe("resolveWatchlistWindow / watchlistSeriesFromDate", () => {
  it("resolves every preset by plain UTC calendar arithmetic", () => {
    expect(resolveWatchlistWindow("3M", ASOF).from).toBe("2026-03-01");
    expect(resolveWatchlistWindow("6M", ASOF).from).toBe("2025-12-01");
    expect(resolveWatchlistWindow("YTD", ASOF).from).toBe("2026-01-01");
    expect(resolveWatchlistWindow("1Y", ASOF).from).toBe("2025-06-01");
    expect(resolveWatchlistWindow("3Y", ASOF).from).toBe("2023-06-01");
    expect(resolveWatchlistWindow("5Y", ASOF).from).toBe("2021-06-01");
  });

  it("bounds the price load at 5 years + 400 days below asOfDate", () => {
    // 2021-06-01 minus 400 days.
    expect(watchlistSeriesFromDate(ASOF)).toBe("2020-04-27");
  });
});

/** Local narrowing helper for the parsed-JSON assertions above. */
function obj(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
