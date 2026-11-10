import { ProviderRateLimited, ProviderUnavailable } from "@kerdial/market-ports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpEcbSourceFetcher } from "./http-fetcher.js";

/**
 * Exercises `HttpEcbSourceFetcher`'s HTTP-status-to-taxonomy mapping
 * against a stubbed `global.fetch` — **no live network call**: tests never
 * depend on ECB being reachable. `EcbFxRateProvider`'s own tests inject a
 * fixture-backed fake `EcbSourceFetcher` instead and never touch this class
 * at all; this file is the only place the real fetcher's own transport logic
 * is exercised.
 */
describe("HttpEcbSourceFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps HTTP 429 to ProviderRateLimited, carrying the Retry-After header as retryAfterSeconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "30" } })),
    );

    const fetcher = new HttpEcbSourceFetcher();
    const error = await fetcher.fetchDailyXml().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRateLimited);
    expect((error as ProviderRateLimited).retryAfterSeconds).toBe(30);
  });

  it("maps HTTP 429 with no Retry-After header to ProviderRateLimited with retryAfterSeconds undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));

    const fetcher = new HttpEcbSourceFetcher();
    const error = await fetcher
      .fetchHistoricalCsv(["USD"], "2024-01-10")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRateLimited);
    expect((error as ProviderRateLimited).retryAfterSeconds).toBeUndefined();
  });

  it("maps a 5xx response to ProviderUnavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    const fetcher = new HttpEcbSourceFetcher();
    await expect(fetcher.fetchDailyXml()).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("maps a thrown network error to ProviderUnavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed: getaddrinfo ENOTFOUND")),
    );

    const fetcher = new HttpEcbSourceFetcher();
    await expect(fetcher.fetchHistoricalCsv(["USD"], "2024-01-10")).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
  });

  it("returns the response body text on a 200", async () => {
    const csv =
      "KEY,CURRENCY,CURRENCY_DENOM,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,USD,EUR,2024-01-10,1.0850\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(csv)));

    const fetcher = new HttpEcbSourceFetcher();
    await expect(fetcher.fetchHistoricalCsv(["USD"], "2024-01-10")).resolves.toBe(csv);
  });

  // History must never again come from `eurofxref-hist.csv`, which is
  // intercepted on the owner's network and answers with fabricated rates.
  it("requests history from the ECB statistics API, scoped to the given currencies and ending on `to`", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(""));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpEcbSourceFetcher().fetchHistoricalCsv(["USD", "GBP"], "2026-10-01");

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin).toBe("https://data-api.ecb.europa.eu");
    expect(url.pathname).toBe("/service/data/EXR/D.GBP+USD.EUR.SP00.A");
    expect(url.searchParams.get("format")).toBe("csvdata");
    expect(url.searchParams.get("detail")).toBe("dataonly");
    expect(url.searchParams.get("startPeriod")).toBe("1999-01-04");
    expect(url.searchParams.get("endPeriod")).toBe("2026-10-01");
    expect(url.href).not.toContain("eurofxref-hist");
  });
});
