/**
 * The "swap-diff" integration test for AC16 (T-16): "swapping the configured quote provider... causes no
 * change to any stored transaction, portfolio, or performance-calculation
 * code path." Two **test-double** `QuoteProvider` implementations serving an
 * identical price series through different adapter identities run through
 * the same ingestion + valuation flow; the resulting holding-state and TWR
 * outputs are diffed and must be empty.
 *
 * **Why this flow is a minimal stand-in, not `core/domain`'s real
 * `replayPositions`/`computePmp`/`valuePortfolio`/`computeTwr`.** T-16
 * depends only on T-13 and T-15 — the calculation engine (T-24–T-28),
 * transaction recording (T-19), and valuation materialisation (T-30) do not
 * exist yet. By design, those functions take plain
 * already-loaded arrays and return plain results with zero I/O or provider
 * coupling — which is exactly what makes AC16 "trivially true": there is
 * nowhere in that layer for a provider identity to leak into. The minimal
 * `runIngestionAndValuationFlow` below (fetch a daily history from whichever
 * `QuoteProvider` it is given, multiply by a fixed quantity to get a
 * holding-state-shaped market-value series, then a plain TWR calculation
 * over that series) demonstrates the identical property with the same
 * assertion shape this test will still use once T-24–T-30 land: diff the
 * outputs of two provider configurations and assert the diff is empty. No
 * provider name appears anywhere in this file — both
 * doubles are generic fixtures.
 */
import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";
import type { PriceObservation } from "../types.js";
import type { QuoteProvider } from "../quote-provider.js";
import {
  ConfigurableQuoteProvider,
  KNOWN_QUOTE_SYMBOL,
  QUOTE_HISTORY_FROM,
  QUOTE_HISTORY_TO,
} from "./quote-provider-fixture.js";

/** A fixed holding size — the only "transaction" this minimal flow needs, since T-19's real transaction ledger does not exist yet. */
const HELD_QUANTITY = new Decimal("10");

interface HoldingStatePoint {
  readonly date: string;
  readonly marketValue: Decimal;
}

interface ValuationResult {
  readonly holdingStates: readonly HoldingStatePoint[];
  readonly twr: Decimal;
}

/**
 * The minimal "ingestion + valuation flow" this test exercises identically
 * against two provider configurations. "Ingestion" is a direct
 * `fetchDailyHistory` call (the real ingestion scheduler, T-33, is out of
 * scope); "valuation" is `quantity × close` per day (a `holding_state`-shaped
 * market-value series) plus a plain two-point TWR (`V_end / V_start - 1`,
 * the TWR building block with no external flows to link
 * across, since this fixture has none).
 */
async function runIngestionAndValuationFlow(provider: QuoteProvider): Promise<ValuationResult> {
  const history: readonly PriceObservation[] = await provider.fetchDailyHistory(
    KNOWN_QUOTE_SYMBOL,
    QUOTE_HISTORY_FROM,
    QUOTE_HISTORY_TO,
  );

  const holdingStates = history.map((observation) => ({
    date: observation.priceDate,
    marketValue: HELD_QUANTITY.times(observation.close),
  }));

  const first = holdingStates[0]!.marketValue;
  const last = holdingStates[holdingStates.length - 1]!.marketValue;
  const twr = last.dividedBy(first).minus(1);

  return { holdingStates, twr };
}

describe("swap-diff integration test — swapping the QuoteProvider changes nothing downstream (AC16)", () => {
  it("two providers serving an identical price series under different identities produce a byte-identical holding-state and TWR result", async () => {
    const providerA = new ConfigurableQuoteProvider("OK", "test-double-a");
    const providerB = new ConfigurableQuoteProvider("OK", "test-double-b");

    // Prove this is a genuine swap of provider *identity*, not two handles
    // on the same instance — the raw observations' sourceKey must differ.
    const [rawA] = await providerA.fetchLatest([KNOWN_QUOTE_SYMBOL]);
    const [rawB] = await providerB.fetchLatest([KNOWN_QUOTE_SYMBOL]);
    expect(rawA!.sourceKey).not.toBe(rawB!.sourceKey);

    const resultA = await runIngestionAndValuationFlow(providerA);
    const resultB = await runIngestionAndValuationFlow(providerB);

    // The calculation outputs themselves carry no provider-specific branch:
    // diffing them (Decimal-exact, via toString(), never Number()) is empty.
    expect(
      resultA.holdingStates.map((point) => ({
        date: point.date,
        marketValue: point.marketValue.toString(),
      })),
    ).toEqual(
      resultB.holdingStates.map((point) => ({
        date: point.date,
        marketValue: point.marketValue.toString(),
      })),
    );
    expect(resultA.twr.toString()).toBe(resultB.twr.toString());
  });
});
