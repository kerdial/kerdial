import { ProviderRateLimited, ProviderUnavailable } from "@kerdial/market-ports";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_RESPONSE_MAX_BYTES, fetchWithProviderErrors } from "./provider-transport.js";

/**
 * The response-body cap, and the taxonomy it reports through.
 *
 * Nothing bounded the *size* of a provider response before this: the circuit
 * breaker and the token bucket bound the number of calls. `response.text()`
 * would materialise whatever an upstream sent, which is the amplifier behind
 * every provider-derived string that reaches storage or a log line.
 *
 * Every case here drives the real {@link fetchWithProviderErrors} with `fetch`
 * stubbed, and passes a small `maxBytes` so the cap can be proven without
 * allocating 32 MiB to do it — the constant itself is asserted separately
 * against the largest legitimate response.
 */
const KEY = "yahoo" as const;
const URL_UNDER_TEST = "https://example.invalid/history";

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function respondWith(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  return new Response(streamOf(chunks), { status: 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the transport refuses a response past its byte cap", () => {
  it("returns a body under the cap unchanged, bytes for bytes", async () => {
    const body = "a".repeat(4096);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respondWith([new TextEncoder().encode(body)])),
    );
    await expect(fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 8192 })).resolves.toBe(
      body,
    );
  });

  it("refuses on the STREAM when content-length is absent — the half that actually bounds the allocation", async () => {
    // A hostile server omits the header, or sends chunked. Ten 1 KiB chunks
    // against a 4 KiB cap: the read must stop, not accumulate.
    const chunk = new Uint8Array(1024).fill(65);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respondWith(Array.from({ length: 10 }, () => chunk))),
    );
    const caught: unknown = await fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 4096 })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // The existing taxonomy, so the circuit breaker and `provider_fetch_log`
    // treat it like any other provider failure rather than a new shape.
    expect(caught).toBeInstanceOf(ProviderUnavailable);
    expect(String((caught as Error).message)).toContain("4096-byte response cap");
  });

  it("refuses on a LYING content-length too — a header that undersells an oversized body", async () => {
    const chunk = new Uint8Array(1024).fill(66);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respondWith(
          Array.from({ length: 10 }, () => chunk),
          { "content-length": "10" },
        ),
      ),
    );
    await expect(
      fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 4096 }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("refuses on content-length BEFORE reading, when the header is honest", async () => {
    // The cheap early exit: the stream must never be touched.
    const read = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          read();
        },
      }),
      { status: 200, headers: { "content-length": String(64 * 1024) } },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const caught: unknown = await fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 4096 })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderUnavailable);
    expect(String((caught as Error).message)).toContain("declared a 65536-byte response");
  });

  it("a body exactly AT the cap is accepted — the boundary is inclusive, not off by one", async () => {
    const body = "c".repeat(4096);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respondWith([new TextEncoder().encode(body)])),
    );
    await expect(
      fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 4096 }),
    ).resolves.toHaveLength(4096);
  });

  it("decodes a multi-byte character split across two chunks — the cap did not break UTF-8", async () => {
    // « é » is two bytes; the stream splits it. Per-chunk decoding would
    // produce two replacement characters here.
    const encoded = new TextEncoder().encode("aéb");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respondWith([encoded.slice(0, 2), encoded.slice(2)])),
    );
    await expect(fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 4096 })).resolves.toBe(
      "aéb",
    );
  });

  it("the 429 mapping still precedes the cap — a rate limit is never reported as an oversized body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "12", "content-length": String(64 * 1024) },
          }),
      ),
    );
    const caught: unknown = await fetchWithProviderErrors(KEY, URL_UNDER_TEST, { maxBytes: 4096 })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderRateLimited);
    expect((caught as ProviderRateLimited).retryAfterSeconds).toBe(12);
  });

  it("the default cap clears the largest legitimate response by a wide margin", () => {
    // ECB's statistics API history for all 31 published currencies since
    // 1999 is the biggest body this codebase requests, 12.35 MB
    // measured 2026-10-02 and growing ~450 KB a year. Asserted as a ratio so
    // the constant cannot be quietly lowered under it.
    const ecbHistoricalCsvBytes = 12.35 * 1024 * 1024;
    expect(PROVIDER_RESPONSE_MAX_BYTES).toBeGreaterThan(ecbHistoricalCsvBytes * 2);
    // …and still a hard bound: not so large that "capped" is meaningless.
    expect(PROVIDER_RESPONSE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
