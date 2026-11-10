import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@kerdial/core-decimal";
import {
  valuePortfolio,
  resolvePrice,
  resolveMarketRate,
  UnresolvablePriceError,
  UnresolvableRateError,
  type FxRatePoint,
  type PricePoint,
} from "./valuation.js";
import type { HoldingState } from "./pmp.js";
// The AC21 valuation-half known-answer (the non-EUR portfolio total) is the
// single source of truth in the T-29 fixtures; this file consumes those inputs
// and expected totals rather than re-declaring the numbers (T-29).
import {
  VALUATION_STATE,
  VALUATION_PRICES,
  VALUATION_FX,
  VALUATION_DATE,
  VALUATION_EXPECTED,
} from "./__fixtures__/known-answers/index.js";

/**
 * Known-answer and property tests for `valuePortfolio` / `resolvePrice`
 * (T-28). Pure and DB-free: every case is an array literal in, an exact
 * `Decimal` out — no fixtures on disk, no seeding, no database.
 *
 * Base-currency totals are hand-derived in the comments and asserted **exactly**
 * (`.equals`), not merely within the AC's 0.01% tolerance — the tolerance exists
 * for the hand-calculation comparison, not as a licence to lose internal
 * precision (NFR-12). All the figures here are terminating decimals, so an exact
 * assertion is achievable and strictly stronger.
 *
 * Each fixture was proven to FAIL against a wrong implementation before being
 * kept — see the per-test comments and the T-28 handoff notes:
 *  - the non-EUR total breaks if the FX rate is dropped or a transaction rate is
 *    used instead of the valuation-date market rate;
 *  - the manual-NAV FUND case breaks if `instrument_price_daily` is allowed to
 *    win over a same-date manual NAV (precedence inverted);
 *  - the Saturday case breaks if the resolver looks ahead (picks Monday) or
 *    returns a gap instead of carrying Friday forward via LOCF.
 */

const d = (s: string): Decimal => new Decimal(s);

const holding = (instrumentId: string, quantity: string): HoldingState => ({
  instrumentId,
  quantity: d(quantity),
  // Cost-basis fields are irrelevant to mark-to-market valuation; set to plausible
  // values so the input is a well-formed HoldingState.
  costBasisBase: d("0"),
  pmpUnitBase: d("0"),
  costBasisNative: d("0"),
  pmpUnitNative: d("0"),
  nativeCurrencyMixed: false,
});

describe("resolvePrice — manual-first precedence, LOCF, never look-ahead", () => {
  it("AC12: a FUND with only a manually entered NAV resolves to that value, not a blocked result", () => {
    const prices: PricePoint[] = [
      {
        instrumentId: "fund-1",
        observedOn: "2026-03-16",
        price: d("142.5"),
        currency: "EUR",
        sourceKey: "manual",
        origin: "MANUAL",
      },
    ];
    const resolved = resolvePrice(prices, "fund-1", "2026-03-16");
    expect(resolved).toBeDefined();
    expect(resolved?.price.equals(d("142.5"))).toBe(true);
    expect(resolved?.origin).toBe("MANUAL");
    // No automated series exists for this FUND — resolution must not block on it.
    expect(resolved?.sourceKey).toBe("manual");
  });

  it("manual overrides instrument_price_daily on the same date (FR-23) — an inverted precedence would fail here", () => {
    const prices: PricePoint[] = [
      {
        instrumentId: "fund-1",
        observedOn: "2026-03-16",
        price: d("100.00"), // automated close — must LOSE to the manual NAV
        currency: "EUR",
        sourceKey: "provider",
        origin: "DAILY",
      },
      {
        instrumentId: "fund-1",
        observedOn: "2026-03-16",
        price: d("142.5"), // manual NAV — must WIN (FR-23 override)
        currency: "EUR",
        sourceKey: "manual",
        origin: "MANUAL",
      },
    ];
    const resolved = resolvePrice(prices, "fund-1", "2026-03-16");
    expect(resolved?.price.equals(d("142.5"))).toBe(true);
    expect(resolved?.origin).toBe("MANUAL");
  });

  it("a strictly-newer daily close wins over a stale manual NAV (never carry a stale override forward)", () => {
    const prices: PricePoint[] = [
      {
        instrumentId: "eq-1",
        observedOn: "2026-03-13", // Friday manual override
        price: d("90"),
        currency: "USD",
        sourceKey: "manual",
        origin: "MANUAL",
      },
      {
        instrumentId: "eq-1",
        observedOn: "2026-03-16", // Monday automated close — strictly newer
        price: d("95"),
        currency: "USD",
        sourceKey: "provider",
        origin: "DAILY",
      },
    ];
    const resolved = resolvePrice(prices, "eq-1", "2026-03-17");
    expect(resolved?.price.equals(d("95"))).toBe(true);
    expect(resolved?.origin).toBe("DAILY");
  });

  it("never looks ahead: a price published after the valuation date is ignored", () => {
    const prices: PricePoint[] = [
      {
        instrumentId: "eq-1",
        observedOn: "2026-03-13",
        price: d("90"),
        currency: "USD",
        sourceKey: "provider",
        origin: "DAILY",
      },
      {
        instrumentId: "eq-1",
        observedOn: "2026-03-16", // AFTER the valuation date below — must be ignored
        price: d("999"),
        currency: "USD",
        sourceKey: "provider",
        origin: "DAILY",
      },
    ];
    const resolved = resolvePrice(prices, "eq-1", "2026-03-14");
    expect(resolved?.price.equals(d("90"))).toBe(true);
    expect(resolved?.observedOn).toBe("2026-03-13");
  });

  it("returns undefined when nothing was published on or before the valuation date", () => {
    const prices: PricePoint[] = [
      {
        instrumentId: "eq-1",
        observedOn: "2026-03-16",
        price: d("90"),
        currency: "USD",
        sourceKey: "provider",
        origin: "DAILY",
      },
    ];
    expect(resolvePrice(prices, "eq-1", "2026-03-15")).toBeUndefined();
    expect(resolvePrice(prices, "other", "2026-03-16")).toBeUndefined();
  });
});

describe("resolveMarketRate — valuation-date market rate via LOCF (OQ-13)", () => {
  it("a base-currency (EUR) holding needs no conversion — rate is exactly 1", () => {
    const rate = resolveMarketRate([], "EUR", "2026-03-16", "EUR");
    expect(rate).toBeDefined();
    expect(rate?.equals(d("1"))).toBe(true);
  });

  it("AC (Saturday): a weekend date carries Friday's rate forward via LOCF, never Monday (look-ahead)", () => {
    const fx: FxRatePoint[] = [
      { currency: "USD", observedOn: "2026-03-13", rate: d("0.92") }, // Friday
      { currency: "USD", observedOn: "2026-03-16", rate: d("0.93") }, // Monday — must NOT be used on Saturday
    ];
    // 2026-03-14 is a Saturday; no rate published. LOCF -> Friday's 0.92.
    const rate = resolveMarketRate(fx, "USD", "2026-03-14", "EUR");
    expect(rate?.equals(d("0.92"))).toBe(true);
  });

  it("returns undefined for a non-base currency with no rate on or before the date", () => {
    const fx: FxRatePoint[] = [{ currency: "USD", observedOn: "2026-03-16", rate: d("0.92") }];
    expect(resolveMarketRate(fx, "USD", "2026-03-15", "EUR")).toBeUndefined();
    expect(resolveMarketRate(fx, "GBP", "2026-03-16", "EUR")).toBeUndefined();
  });
});

describe("valuePortfolio — mark-to-market total (AC21 valuation half)", () => {
  it("non-EUR holding: total = Σ (native value × valuation-date FX rate), hand-calc exact", () => {
    // Two holdings, one USD, one EUR, valued on Friday 2026-03-13 — the shared
    // T-29 AC21 valuation fixture.
    //   AAPL: 10 units × $185.00 = $1,850.00 native; × 0.92 USD/EUR = €1,702.00 base
    //   TTE : 20 units × €62.50  = €1,250.00 native; × 1 (EUR)    = €1,250.00 base
    //   total = 1,702.00 + 1,250.00 = €2,952.00
    const result = valuePortfolio(
      VALUATION_STATE,
      VALUATION_PRICES,
      VALUATION_FX,
      VALUATION_DATE,
      "EUR",
    );

    expect(result.totalValueBase.equals(d(VALUATION_EXPECTED.totalValueBase))).toBe(true);
    expect(result.baseCurrency).toBe("EUR");
    expect(result.date).toBe(VALUATION_DATE);

    const aapl = result.holdings.find((h) => h.instrumentId === "AAPL");
    expect(aapl?.valueNative.equals(d("1850.00"))).toBe(true);
    expect(aapl?.valueBase.equals(d(VALUATION_EXPECTED.aaplValueBase))).toBe(true);
    expect(aapl?.rate.equals(d("0.92"))).toBe(true);
    expect(aapl?.currency).toBe("USD");

    const tte = result.holdings.find((h) => h.instrumentId === "TTE");
    expect(tte?.valueBase.equals(d(VALUATION_EXPECTED.tteValueBase))).toBe(true);
    expect(tte?.rate.equals(d("1"))).toBe(true);
  });

  it("AC (Saturday): a Saturday valuation date uses Friday's price and rate via LOCF, not a gap", () => {
    // Friday values only; valued on Saturday 2026-03-14.
    //   AAPL: 10 × $185.00 = $1,850.00 × 0.92 = €1,702.00  (both LOCF'd from Friday)
    const state: HoldingState[] = [holding("AAPL", "10")];
    const prices: PricePoint[] = [
      {
        instrumentId: "AAPL",
        observedOn: "2026-03-13", // Friday
        price: d("185.00"),
        currency: "USD",
        sourceKey: "provider",
        origin: "DAILY",
      },
    ];
    const fx: FxRatePoint[] = [{ currency: "USD", observedOn: "2026-03-13", rate: d("0.92") }];

    const result = valuePortfolio(state, prices, fx, "2026-03-14", "EUR");
    expect(result.totalValueBase.equals(d("1702.00"))).toBe(true);
    const aapl = result.holdings[0];
    expect(aapl?.price.observedOn).toBe("2026-03-13"); // carried forward, not the Saturday date
    expect(aapl?.rate.equals(d("0.92"))).toBe(true);
  });

  it("AC12: a manual-only FUND is valued and does not block on missing automated history", () => {
    const state: HoldingState[] = [holding("fund-1", "100")];
    const prices: PricePoint[] = [
      {
        instrumentId: "fund-1",
        observedOn: "2026-03-13",
        price: d("142.5"),
        currency: "EUR",
        sourceKey: "manual",
        origin: "MANUAL",
      },
    ];
    // No FX series needed (EUR); no automated price series at all.
    const result = valuePortfolio(state, prices, [], "2026-03-13", "EUR");
    // 100 × 142.5 = 14,250.00
    expect(result.totalValueBase.equals(d("14250.0"))).toBe(true);
    expect(result.holdings[0]?.price.origin).toBe("MANUAL");
  });

  it("fails loud (UnresolvablePriceError) when a holding has no price on or before the date", () => {
    const state: HoldingState[] = [holding("AAPL", "10")];
    expect(() => valuePortfolio(state, [], [], "2026-03-13", "EUR")).toThrow(
      UnresolvablePriceError,
    );
  });

  it("fails loud (UnresolvableRateError) when a non-EUR holding has no FX rate on or before the date", () => {
    const state: HoldingState[] = [holding("AAPL", "10")];
    const prices: PricePoint[] = [
      {
        instrumentId: "AAPL",
        observedOn: "2026-03-13",
        price: d("185.00"),
        currency: "USD",
        sourceKey: "provider",
        origin: "DAILY",
      },
    ];
    expect(() => valuePortfolio(state, prices, [], "2026-03-13", "EUR")).toThrow(
      UnresolvableRateError,
    );
  });

  it("an empty portfolio values to exactly zero", () => {
    const result = valuePortfolio([], [], [], "2026-03-13", "EUR");
    expect(result.totalValueBase.equals(d("0"))).toBe(true);
    expect(result.holdings).toHaveLength(0);
  });
});

describe("valuePortfolio — properties", () => {
  it("totalValueBase equals the exact sum of per-holding valueBase (no rounding drift)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[A-Za-z0-9]+$/.test(s)),
            qty: fc.integer({ min: 1, max: 1000 }),
            price: fc.integer({ min: 1, max: 100000 }),
            rate: fc.integer({ min: 1, max: 10000 }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        (rows) => {
          // Deduplicate instrument ids so each holding resolves its own price.
          const seen = new Set<string>();
          const unique = rows.filter((r) => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
          });

          const state: HoldingState[] = unique.map((r) => holding(r.id, String(r.qty)));
          const prices: PricePoint[] = unique.map((r) => ({
            instrumentId: r.id,
            observedOn: "2026-03-13",
            price: d(String(r.price)).dividedBy(100), // cents -> a 2dp price
            currency: "USD",
            sourceKey: "provider",
            origin: "DAILY" as const,
          }));
          const fx: FxRatePoint[] = [
            {
              currency: "USD",
              observedOn: "2026-03-13",
              rate: d(String(rows[0]?.rate ?? 1)).dividedBy(10000),
            },
          ];

          const result = valuePortfolio(state, prices, fx, "2026-03-13", "EUR");
          const summed = result.holdings.reduce((acc, h) => acc.plus(h.valueBase), d("0"));
          expect(result.totalValueBase.equals(summed)).toBe(true);
        },
      ),
    );
  });
});
