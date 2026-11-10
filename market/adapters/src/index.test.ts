import { describe, expect, it } from "vitest";
import {
  ECB_BASE_CURRENCY,
  ECB_PROVIDER_KEY,
  ECB_PUBLISHED_CURRENCIES,
  EcbFxRateProvider,
  YAHOO_ASSET_KINDS,
  YAHOO_PROVIDER_KEY,
  YahooQuoteProvider,
} from "./index.js";

/**
 * Smoke test for this package's own barrel — the real behavioural coverage
 * lives in `ecb/provider.test.ts`/`yahoo/provider.test.ts` and friends; this
 * just confirms the public surface `market/adapters`' `index.ts` re-exports
 * is reachable from a plain package import (mirroring
 * `market/ports/index.test.ts`'s role).
 */
describe("market/adapters (smoke)", () => {
  it("re-exports the ecb adapter's public surface", () => {
    expect(ECB_PROVIDER_KEY).toBe("ecb");
    expect(ECB_BASE_CURRENCY).toBe("EUR");
    expect(ECB_PUBLISHED_CURRENCIES.length).toBe(32);
    expect(new EcbFxRateProvider().capabilities().key).toBe("ecb");
  });

  it("re-exports the yahoo adapter's public surface", () => {
    expect(YAHOO_PROVIDER_KEY).toBe("yahoo");
    // ADR-0018: FUND joined — Morningstar `0P…` NAV lines.
    expect(YAHOO_ASSET_KINDS).toEqual(["SHARE", "ETF", "INDEX", "CRYPTO", "FUND"]);
    expect(new YahooQuoteProvider().capabilities().key).toBe("yahoo");
  });
});
