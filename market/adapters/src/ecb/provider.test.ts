import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DataGap, ProviderMalformedResponse, SymbolNotFound } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { EUR_RUB_SUSPENDED_FROM } from "./currencies.js";
import type { EcbSourceFetcher } from "./http-fetcher.js";
import { EcbFxRateProvider } from "./provider.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "ecb");
const HIST_FIXTURE = readFileSync(join(fixturesDir, "sdw-exr-fixture.csv"), "utf8");
const DAILY_FIXTURE = readFileSync(join(fixturesDir, "eurofxref-daily-fixture.xml"), "utf8");
/** Verbatim ECB statistics API responses (captured 2026-10-02) — see `parse-csv.realshape.test.ts`'s header, and the full-range describe block at the end of this file. */
const REAL_SHAPE_HIST_FIXTURE = readFileSync(join(fixturesDir, "sdw-exr-realshape.csv"), "utf8");

/**
 * A fixture-backed fake {@link EcbSourceFetcher} — this is how every test in
 * this file avoids the live ECB network. No test
 * in this file constructs `HttpEcbSourceFetcher`.
 */
class FixtureFetcher implements EcbSourceFetcher {
  async fetchHistoricalCsv(): Promise<string> {
    return HIST_FIXTURE;
  }
  async fetchDailyXml(): Promise<string> {
    return DAILY_FIXTURE;
  }
}

function provider(): EcbFxRateProvider {
  return new EcbFxRateProvider(new FixtureFetcher());
}

describe("EcbFxRateProvider — capabilities", () => {
  it("declares EUR as base and the 29 pairs ECB still publishes — not the retired HRK and BGN, nor the suspended RUB", () => {
    const capabilities = provider().capabilities();
    expect(capabilities.key).toBe("ecb");
    expect(capabilities.baseCurrency).toBe("EUR");
    expect(capabilities.publishedPairs).toContainEqual({ base: "EUR", quote: "USD" });
    for (const retired of ["HRK", "BGN", "RUB"]) {
      expect(capabilities.publishedPairs).not.toContainEqual({ base: "EUR", quote: retired });
    }
    expect(capabilities.publishedPairs.length).toBe(29);
  });

  it("still serves a retired currency's history up to its retirement", async () => {
    const observations = await new EcbFxRateProvider({
      fetchHistoricalCsv: async () =>
        [
          "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
          "EXR.D.BGN.EUR.SP00.A,D,BGN,EUR,SP00,A,2025-12-30,1.9558",
          "EXR.D.BGN.EUR.SP00.A,D,BGN,EUR,SP00,A,2025-12-31,1.9558",
        ].join("\n"),
      fetchDailyXml: async () => DAILY_FIXTURE,
    }).fetchDailyRates([{ base: "EUR", quote: "BGN" }], "2025-12-01", "2025-12-31");
    expect(observations.map((o) => o.rateDate)).toEqual(["2025-12-30", "2025-12-31"]);
  });
});

describe("EcbFxRateProvider — direction inversion (R12)", () => {
  it("inverts ECB's EUR-base publication direction: '1 EUR = 160.50 JPY' is stored/returned as EUR-per-JPY, not JPY-per-EUR", async () => {
    const [observation] = await provider().fetchDailyRates(
      [{ base: "EUR", quote: "JPY" }],
      "2024-01-10",
      "2024-01-10",
    );

    expect(observation).toBeDefined();
    expect(observation!.base).toBe("EUR");
    expect(observation!.quote).toBe("JPY");
    // ECB published "1 EUR = 160.50 JPY". The canonical direction
    // (amount_base = amount_quote × rate) requires
    // rate = EUR per 1 JPY = 1 / 160.50 ≈ 0.0062305..., not 160.50 itself.
    const rate = observation!.rate;
    expect(rate.toFixed(10)).toBe("0.0062305296");
    // The two orientations must differ by far more than a factor of two —
    // 160.50 vs ~0.00623 — so an accidental non-inversion cannot pass this
    // test silently: the test asserts the actual numeric direction, not
    // just that a rate exists.
    const ecbRawValue = 160.5;
    expect(ecbRawValue / rate.toNumber()).toBeGreaterThan(2);
  });

  it("also inverts a near-1.0 pair (EUR/USD) correctly, verified against an exact known figure", async () => {
    const [observation] = await provider().fetchDailyRates(
      [{ base: "EUR", quote: "USD" }],
      "2024-01-10",
      "2024-01-10",
    );
    // ECB "1 EUR = 1.0850 USD" -> stored rate = 1 / 1.0850.
    expect(observation!.rate.toFixed(10)).toBe("0.9216589862");
  });
});

describe("EcbFxRateProvider — cross rates via EUR", () => {
  it("derives USD/GBP as EUR/GBP ÷ EUR/USD at resolution time", async () => {
    const [observation] = await provider().fetchDailyRates(
      [{ base: "USD", quote: "GBP" }],
      "2024-01-10",
      "2024-01-10",
    );
    // On 2024-01-10: EUR/USD raw=1.0850 -> eurPerUSD = 1/1.0850;
    // EUR/GBP raw=0.8590 -> eurPerGBP = 1/0.8590.
    // USD/GBP = eurPerGBP / eurPerUSD = 1.0850 / 0.8590.
    const expected = 1.085 / 0.859;
    expect(observation!.base).toBe("USD");
    expect(observation!.quote).toBe("GBP");
    expect(Number(observation!.rate.toFixed(10))).toBeCloseTo(expected, 9);
  });

  it("uses LOCF per leg — never look-ahead — when one leg has a genuine single-day gap the other leg does not", async () => {
    // Fixture: on 2024-01-08, GBP is N/A but USD=1.0925 is published. The
    // most recent PRIOR GBP value is 2024-01-05's 0.8600 — using
    // 2024-01-09's 0.8620 instead would be look-ahead and must not happen.
    const [observation] = await provider().fetchDailyRates(
      [{ base: "USD", quote: "GBP" }],
      "2024-01-08",
      "2024-01-08",
    );
    const expected = 1.0925 / 0.86; // USD(2024-01-08) / GBP-carried-forward-from(2024-01-05)
    expect(observation!.rateDate).toBe("2024-01-08");
    expect(Number(observation!.rate.toFixed(10))).toBeCloseTo(expected, 9);
  });

  it("does not include the cross-derived pair when only the two EUR legs are fetched — nothing is persisted beyond what was actually fetched", async () => {
    const eurLegsOnly = await provider().fetchDailyRates(
      [
        { base: "EUR", quote: "USD" },
        { base: "EUR", quote: "GBP" },
      ],
      "2024-01-10",
      "2024-01-10",
    );

    expect(eurLegsOnly).toHaveLength(2);
    expect(eurLegsOnly.every((observation) => observation.base === "EUR")).toBe(true);
    expect(
      eurLegsOnly.some((observation) => observation.base === "USD" && observation.quote === "GBP"),
    ).toBe(false);

    // The cross pair is only ever produced by an explicit request for it —
    // a separate call, demonstrating it is derived on demand, not a side
    // effect of fetching the EUR-base legs.
    const crossOnly = await provider().fetchDailyRates(
      [{ base: "USD", quote: "GBP" }],
      "2024-01-10",
      "2024-01-10",
    );
    expect(crossOnly).toHaveLength(1);
    expect(crossOnly[0]!.base).toBe("USD");
    expect(crossOnly[0]!.quote).toBe("GBP");
  });
});

describe("EcbFxRateProvider — a retired currency in a multi-pair call", () => {
  // HRK stopped on 2022-12-30 (Croatia adopted the euro); USD and GBP carry
  // on. GBP also skips 2023-01-03, a single-currency gap.
  const RETIRED_FIXTURE = [
    "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
    "EXR.D.HRK.EUR.SP00.A,D,HRK,EUR,SP00,A,2022-12-29,7.5365",
    "EXR.D.HRK.EUR.SP00.A,D,HRK,EUR,SP00,A,2022-12-30,7.5365",
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2022-12-29,1.0640",
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2022-12-30,1.0666",
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2023-01-02,1.0683",
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2023-01-03,1.0545",
    "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2023-01-04,1.0599",
    "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2022-12-29,0.8840",
    "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2022-12-30,0.8869",
    "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2023-01-02,0.8850",
    "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2023-01-04,0.8830",
  ].join("\n");
  const retired = () =>
    new EcbFxRateProvider({
      fetchHistoricalCsv: async () => RETIRED_FIXTURE,
      fetchDailyXml: async () => DAILY_FIXTURE,
    });
  const datesOf = (
    observations: { quote: string; base: string; rateDate: string }[],
    pair: string,
  ) =>
    observations
      .filter((observation) => `${observation.base}/${observation.quote}` === pair)
      .map((observation) => observation.rateDate);

  it("gives a direct EUR pair only the dates its own currency published, never another currency's later dates", async () => {
    const observations = await retired().fetchDailyRates(
      [
        { base: "EUR", quote: "HRK" },
        { base: "EUR", quote: "USD" },
        { base: "EUR", quote: "GBP" },
      ],
      "2022-12-28",
      "2023-01-10",
    );

    expect(datesOf(observations, "EUR/HRK")).toEqual(["2022-12-29", "2022-12-30"]);
    expect(datesOf(observations, "EUR/USD")).toEqual([
      "2022-12-29",
      "2022-12-30",
      "2023-01-02",
      "2023-01-03",
      "2023-01-04",
    ]);
    // GBP's own gap is not filled by USD's 2023-01-03 row either.
    expect(datesOf(observations, "EUR/GBP")).toEqual([
      "2022-12-29",
      "2022-12-30",
      "2023-01-02",
      "2023-01-04",
    ]);
  });

  it("keeps a cross pair's per-leg LOCF across a single-leg gap, but stops at the earlier leg's last publication", async () => {
    const observations = await retired().fetchDailyRates(
      [
        { base: "USD", quote: "GBP" },
        { base: "USD", quote: "HRK" },
      ],
      "2022-12-28",
      "2023-01-10",
    );

    // 2023-01-03: USD published, GBP carried forward from 2023-01-02.
    expect(datesOf(observations, "USD/GBP")).toEqual([
      "2022-12-29",
      "2022-12-30",
      "2023-01-02",
      "2023-01-03",
      "2023-01-04",
    ]);
    expect(datesOf(observations, "USD/HRK")).toEqual(["2022-12-29", "2022-12-30"]);
  });
});

describe("EcbFxRateProvider — EUR/RUB suspension", () => {
  it("rejects a request touching a date on/after the suspension with SymbolNotFound directing to a manual rate, not a fabricated or zero rate", async () => {
    const error = await provider()
      .fetchDailyRates([{ base: "EUR", quote: "RUB" }], "2022-02-01", EUR_RUB_SUSPENDED_FROM)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SymbolNotFound);
    expect((error as SymbolNotFound).message).toContain("manual rate");
  });

  it("still resolves EUR/RUB for a range entirely before the suspension date (historical backfill remains available)", async () => {
    const [observation] = await provider().fetchDailyRates(
      [{ base: "EUR", quote: "RUB" }],
      "2022-02-28",
      "2022-02-28",
    );
    expect(observation!.rate.toFixed(10)).toBe((1 / 86.5).toFixed(10));
  });

  it("fetchLatestRates always rejects EUR/RUB — 'latest' is inherently today, always past the suspension", async () => {
    await expect(
      provider().fetchLatestRates([{ base: "EUR", quote: "RUB" }]),
    ).rejects.toBeInstanceOf(SymbolNotFound);
  });
});

describe("EcbFxRateProvider — unsupported / unknown pairs", () => {
  it("rejects a currency ECB has never published with SymbolNotFound rather than an empty array", async () => {
    await expect(
      provider().fetchDailyRates([{ base: "EUR", quote: "XAU" }], "2024-01-01", "2024-01-10"),
    ).rejects.toBeInstanceOf(SymbolNotFound);
  });
});

describe("EcbFxRateProvider — the history request", () => {
  /** Records what the provider asked for; answers with the shared fixture. */
  class RecordingFetcher implements EcbSourceFetcher {
    readonly requests: { currencies: readonly string[]; to: string }[] = [];
    async fetchHistoricalCsv(currencies: readonly string[], to: string): Promise<string> {
      this.requests.push({ currencies, to });
      return HIST_FIXTURE;
    }
    async fetchDailyXml(): Promise<string> {
      return DAILY_FIXTURE;
    }
  }

  it("asks once for exactly the non-EUR legs of every requested pair, through `to`", async () => {
    const fetcher = new RecordingFetcher();
    await new EcbFxRateProvider(fetcher).fetchDailyRates(
      [
        { base: "EUR", quote: "USD" },
        { base: "USD", quote: "GBP" },
      ],
      "2024-01-08",
      "2024-01-10",
    );

    expect(fetcher.requests).toHaveLength(1);
    expect([...fetcher.requests[0]!.currencies].sort()).toEqual(["GBP", "USD"]);
    expect(fetcher.requests[0]!.to).toBe("2024-01-10");
  });

  it("rejects an unsupported currency before any request, so it is never the API's 404 that reports it", async () => {
    const fetcher = new RecordingFetcher();
    await expect(
      new EcbFxRateProvider(fetcher).fetchDailyRates(
        [
          { base: "EUR", quote: "USD" },
          { base: "EUR", quote: "XAU" },
        ],
        "2024-01-01",
        "2024-01-10",
      ),
    ).rejects.toBeInstanceOf(SymbolNotFound);
    expect(fetcher.requests).toHaveLength(0);
  });

  it("turns the API's empty answer for a range with no observation into DataGap", async () => {
    class EmptyFetcher extends RecordingFetcher {
      override async fetchHistoricalCsv(): Promise<string> {
        return "";
      }
    }
    await expect(
      new EcbFxRateProvider(new EmptyFetcher()).fetchDailyRates(
        [{ base: "EUR", quote: "USD" }],
        "2024-01-06",
        "2024-01-07",
      ),
    ).rejects.toBeInstanceOf(DataGap);
  });
});

describe("EcbFxRateProvider — DataGap", () => {
  it("throws DataGap when a supported currency has no published data anywhere in the requested range", async () => {
    // GBP is a real, supported currency; this fixture simply has no rows at
    // all in this range — a genuine data gap, not an unknown symbol.
    await expect(
      provider().fetchDailyRates([{ base: "EUR", quote: "GBP" }], "2000-01-01", "2000-01-05"),
    ).rejects.toBeInstanceOf(DataGap);
  });
});

describe("EcbFxRateProvider — fetchLatestRates (eurofxref-daily.xml)", () => {
  it("returns the inverted latest rate for a direct EUR pair", async () => {
    const [observation] = await provider().fetchLatestRates([{ base: "EUR", quote: "USD" }]);
    expect(observation!.rateDate).toBe("2024-01-10");
    expect(observation!.rate.toFixed(10)).toBe("0.9216589862");
    expect(observation!.sourceKey).toBe("ecb");
  });

  it("derives a cross rate from the same day's snapshot", async () => {
    const [observation] = await provider().fetchLatestRates([{ base: "USD", quote: "GBP" }]);
    const expected = 1.085 / 0.859;
    expect(Number(observation!.rate.toFixed(10))).toBeCloseTo(expected, 9);
  });

  it("rejects a currency absent from today's snapshot with SymbolNotFound", async () => {
    // BGN is a historically-published ECB currency not present in this
    // fixture's daily snapshot (mirrors currencies that drop out of the live
    // feed on euro adoption).
    await expect(
      provider().fetchLatestRates([{ base: "EUR", quote: "BGN" }]),
    ).rejects.toBeInstanceOf(SymbolNotFound);
  });
});

describe("EcbFxRateProvider — non-positive rate cells (regression, found in T-18)", () => {
  /** A published cell of `0.0000` — admitted by the parsers' `/^\d+(\.\d+)?$/`. */
  class ZeroRateFetcher implements EcbSourceFetcher {
    async fetchHistoricalCsv(): Promise<string> {
      return [
        "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
        "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2024-01-10,0.8590",
        "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-01-10,0.0000",
      ].join("\n");
    }
    async fetchDailyXml(): Promise<string> {
      return DAILY_FIXTURE;
    }
  }

  it("rejects a zero rate rather than inverting it to Infinity", async () => {
    // decimal.js models signed zero, so the original `!value.isPositive()`
    // guard was inert for `0` — `new Decimal("0.0000").isPositive()` is
    // `true`. The zero then reached the EUR-base inversion (`1 / 0`), which
    // yields `Infinity` and would price a transaction off it.
    await expect(
      new EcbFxRateProvider(new ZeroRateFetcher()).fetchDailyRates(
        [{ base: "EUR", quote: "USD" }],
        "2024-01-10",
        "2024-01-10",
      ),
    ).rejects.toBeInstanceOf(ProviderMalformedResponse);
  });

  it("still accepts a normal positive rate from the same code path", async () => {
    const [observation] = await new EcbFxRateProvider(new ZeroRateFetcher()).fetchDailyRates(
      [{ base: "EUR", quote: "GBP" }],
      "2024-01-10",
      "2024-01-10",
    );
    expect(observation!.rate.toFixed(10)).toBe("1.1641443539");
  });
});

/**
 * **One call for the whole history** — SH-5's catch-up asks
 * this adapter for the whole ECB history range in **one**
 * `fetchDailyRates` call. The property under test is that one call spans the
 * file end to end: no per-year chunking, no implicit window cap, both ends of
 * the range returned.
 *
 * Fixture-level, against the **real-shape** statistics API responses
 * captured on 2026-10-02 — the same no-live-network stance as every
 * other test in this file. The remaining half — that the *live*
 * history, at its real size, comes back in one HTTPS `GET` — stays an operational check
 * against the real endpoint; a failure there would mean chunking the fetch,
 * and SH-6 is correct without it either way.
 */
describe("EcbFxRateProvider — the full historical range in one call (SH-5)", () => {
  class RealShapeFetcher implements EcbSourceFetcher {
    async fetchHistoricalCsv(): Promise<string> {
      return REAL_SHAPE_HIST_FIXTURE;
    }
    async fetchDailyXml(): Promise<string> {
      return DAILY_FIXTURE;
    }
  }

  it("serves 1999-01-04 through the file's newest row from a single fetchDailyRates call", async () => {
    const observations = await new EcbFxRateProvider(new RealShapeFetcher()).fetchDailyRates(
      [{ base: "EUR", quote: "USD" }],
      "1999-01-01",
      "2026-07-21",
    );

    const dates = observations.map((observation) => observation.rateDate);
    expect(dates[0]).toBe("1999-01-04");
    expect(dates[dates.length - 1]).toBe("2026-07-21");
    // Both ends carry real inverted rates — a truncated range would drop one.
    expect(observations[0]!.rate.toFixed(10)).toBe((1 / 1.1789).toFixed(10));
    expect(observations[observations.length - 1]!.rate.toFixed(10)).toBe((1 / 1.1418).toFixed(10));
  });

  it("serves a multi-pair catch-up in the same single call, over that same 27-year range", async () => {
    const observations = await new EcbFxRateProvider(new RealShapeFetcher()).fetchDailyRates(
      [
        { base: "EUR", quote: "USD" },
        { base: "EUR", quote: "SEK" },
      ],
      "1999-01-01",
      "2026-07-21",
    );

    for (const quote of ["USD", "SEK"]) {
      const forPair = observations.filter((observation) => observation.quote === quote);
      expect(forPair.map((observation) => observation.rateDate)).toEqual([
        "1999-01-04",
        "2026-07-21",
      ]);
    }
  });
});
