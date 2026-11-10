import { ProviderRateLimited, ProviderUnavailable } from "@kerdial/market-ports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpYahooSourceFetcher } from "./http-fetcher.js";

/**
 * Exercises `HttpYahooSourceFetcher`'s HTTP-status-to-taxonomy mapping
 * against a stubbed `global.fetch` — **no live network call**.
 * `YahooQuoteProvider`'s own tests inject a fixture-backed fake
 * `YahooSourceFetcher` instead and never touch this class at all; this file
 * is the only place the real fetcher's own transport logic is exercised
 * (mirrors `ecb`'s `http-fetcher.test.ts`, T-15).
 */
describe("HttpYahooSourceFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps HTTP 429 to ProviderRateLimited, carrying the Retry-After header as retryAfterSeconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "12" } })),
    );

    const fetcher = new HttpYahooSourceFetcher();
    const error = await fetcher.fetchSearch("AAPL").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRateLimited);
    expect((error as ProviderRateLimited).retryAfterSeconds).toBe(12);
  });

  it("maps HTTP 429 with no Retry-After header to ProviderRateLimited with retryAfterSeconds undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));

    const fetcher = new HttpYahooSourceFetcher();
    const error = await fetcher
      .fetchChart("AAPL", { kind: "latest" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRateLimited);
    expect((error as ProviderRateLimited).retryAfterSeconds).toBeUndefined();
  });

  it("maps a 5xx response to ProviderUnavailable for fetchSearch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    const fetcher = new HttpYahooSourceFetcher();
    await expect(fetcher.fetchSearch("AAPL")).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("maps a 5xx response to ProviderUnavailable for fetchChart", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const fetcher = new HttpYahooSourceFetcher();
    await expect(fetcher.fetchChart("AAPL", { kind: "latest" })).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
  });

  it("maps a thrown network error to ProviderUnavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed: getaddrinfo ENOTFOUND")),
    );

    const fetcher = new HttpYahooSourceFetcher();
    await expect(fetcher.fetchChart("AAPL", { kind: "latest" })).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
  });

  it("passes a 404 body through for fetchChart (Yahoo's own not-found signal for this endpoint)", async () => {
    const notFoundBody = '{"chart":{"result":null,"error":{"code":"Not Found","description":"x"}}}';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(notFoundBody, { status: 404 })));

    const fetcher = new HttpYahooSourceFetcher();
    await expect(fetcher.fetchChart("NOTASYMBOL", { kind: "latest" })).resolves.toBe(notFoundBody);
  });

  it("passes a 400 body through for fetchChart (Yahoo's own out-of-range signal for this endpoint)", async () => {
    const badRequestBody =
      '{"chart":{"result":null,"error":{"code":"Bad Request","description":"x"}}}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(badRequestBody, { status: 400 })),
    );

    const fetcher = new HttpYahooSourceFetcher();
    await expect(
      fetcher.fetchChart("AAPL", { kind: "history", from: "1900-01-01", to: "1900-01-02" }),
    ).resolves.toBe(badRequestBody);
  });

  it("returns the response body text on a 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"quotes":[]}')));

    const fetcher = new HttpYahooSourceFetcher();
    await expect(fetcher.fetchSearch("AAPL")).resolves.toBe('{"quotes":[]}');
  });

  it("sends a browser-shaped User-Agent header on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"quotes":[]}'));
    vi.stubGlobal("fetch", fetchMock);

    const fetcher = new HttpYahooSourceFetcher();
    await fetcher.fetchSearch("AAPL");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("User-Agent")).toMatch(/Mozilla/);
  });
});
