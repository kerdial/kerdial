import { ProviderRateLimited, ProviderUnavailable } from "@kerdial/market-ports";
import type { ProviderKey } from "@kerdial/market-ports";

/**
 * The largest response body this transport will materialise, in bytes.
 *
 * **Why a cap at all.** Nothing bounded the *size* of a provider response —
 * the circuit breaker and the token bucket bound the *number* of calls — so
 * `response.text()` would materialise whatever an upstream sent. That is the
 * amplifier behind every unbounded provider-derived string in this codebase:
 * `display_name`, `symbol`, exchange codes, the industry label, and whatever
 * a future adapter field adds. Fixing one log site with a `.slice()` closes
 * one instance; capping here closes the class. It needs a hostile or
 * compromised upstream, or a MITM on TLS — not a low bar — and it is a
 * memory/availability concern rather than a data-integrity one.
 *
 * **Why 32 MiB, sized against the real maximum rather than a round number.**
 * The largest legitimate response this codebase requests is ECB's history
 * from the statistics API (`ecb/http-fetcher.ts`) when one load asks
 * for every published currency — full daily history since 1999-01-04 across
 * 31 currencies, **12.35 MB** measured on 2026-10-02 and growing roughly
 * 450 KB a year, so ~40 more years fit under this cap without anyone
 * revisiting it. A real load usually names one or two currencies (~0.4 MB
 * each). The runner-up is a 10-year daily chart (`BACKFILL_CHUNK_YEARS`), far
 * smaller. 32 MiB is ~2.5x the real maximum and still a hard bound on what one
 * call can allocate.
 */
export const PROVIDER_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/** Per-call knobs — the only things the three adapters' transports differ in. */
export interface ProviderFetchOptions {
  /**
   * Request headers, when the provider needs any. Only `yahoo` does (its
   * browser `User-Agent` workaround — see `yahoo/http-fetcher.ts`); `ecb` issues
   * a plain header-less `GET`, so its calls omit this and
   * `fetch` is invoked with no `RequestInit` at all.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The exact set of statuses whose body is returned rather than mapped to
   * {@link ProviderUnavailable}. Omit it for the default — any 2xx — which is
   * what every endpoint wants except the one that has an error-shaped-body
   * contract of its own (`yahoo`'s `v8/finance/chart`; its fetcher documents
   * why).
   */
  readonly okStatuses?: readonly number[];
  /**
   * Overrides {@link PROVIDER_RESPONSE_MAX_BYTES} for this call. Exists for
   * the tests that prove the cap fires without allocating 32 MiB to do it;
   * no adapter sets it.
   */
  readonly maxBytes?: number;
}

/**
 * The shared transport core of every HTTP adapter in this package: one
 * `GET`, mapped onto the closed provider error taxonomy (no provider DTO
 * leaks). This was once triplicated across `ecb`/`yahoo`/`coingecko`
 * verbatim (`coingecko` has since been retired).
 *
 * The mapping, canonically:
 *
 *   - a thrown `fetch` (DNS failure, connection reset, timeout, ...) ->
 *     {@link ProviderUnavailable}, `cause` stringified into the message;
 *   - HTTP 429 -> {@link ProviderRateLimited}, carrying the provider's own
 *     `Retry-After` as `retryAfterSeconds` when it sent a finite numeric one
 *     (an absent, blank or non-numeric header leaves it `undefined` rather
 *     than inventing a delay). Checked **before** `okStatuses`, so a 429 is
 *     never reachable as an "expected" status;
 *   - any other status outside `okStatuses` (default: any 2xx) ->
 *     {@link ProviderUnavailable}, `"<url> responded with HTTP <status>"`.
 *
 * Body-shape failures (invalid JSON/CSV/XML) are **not** this module's
 * business: each adapter's parsers map those, since only they know the
 * payload shape — and only they hold the symbol/date context needed to tell
 * `SymbolNotFound` from `DataGap` for the statuses an adapter lists in
 * `okStatuses` precisely so their body reaches a parser.
 */
export async function fetchWithProviderErrors(
  providerKey: ProviderKey,
  url: string,
  options: ProviderFetchOptions = {},
): Promise<string> {
  let response: Response;
  try {
    response =
      options.headers === undefined
        ? await fetch(url)
        : await fetch(url, { headers: options.headers });
  } catch (cause) {
    throw new ProviderUnavailable(providerKey, `network error fetching ${url}: ${String(cause)}`);
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterHeader !== null && retryAfterHeader.trim() !== ""
        ? Number(retryAfterHeader)
        : undefined;
    throw new ProviderRateLimited(
      providerKey,
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : undefined,
    );
  }

  const isExpectedStatus =
    options.okStatuses === undefined ? response.ok : options.okStatuses.includes(response.status);
  if (!isExpectedStatus) {
    throw new ProviderUnavailable(providerKey, `${url} responded with HTTP ${response.status}`);
  }

  return readBodyWithinCap(
    providerKey,
    url,
    response,
    options.maxBytes ?? PROVIDER_RESPONSE_MAX_BYTES,
  );
}

/**
 * Reads the body, refusing anything past `maxBytes`.
 *
 * **Both halves are needed, and the second is the load-bearing one.**
 * `content-length` is checked first because it refuses before a single byte
 * is read — but a hostile server can omit it, send a chunked response, or
 * simply lie, so the streaming counter is what actually bounds the
 * allocation. The header check is the cheap early exit, not the control.
 *
 * The refusal is a {@link ProviderUnavailable}: it is already in the closed
 * taxonomy, and it is already what the circuit breaker
 * counts and what `provider_fetch_log` records — so an oversized response
 * trips the same machinery as an outage rather than arriving as a new
 * unhandled shape. Deliberately **not** {@link ProviderMalformedResponse},
 * which means "the body parsed into the wrong shape": nothing here has parsed
 * anything, and the body may well have been perfectly well-formed.
 *
 * `reader.cancel()` on the over-cap path releases the connection instead of
 * leaving the rest of a hostile stream to arrive.
 */
async function readBodyWithinCap(
  providerKey: ProviderKey,
  url: string,
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new ProviderUnavailable(
        providerKey,
        `${url} declared a ${declaredBytes}-byte response, over the ${maxBytes}-byte cap`,
      );
    }
  }

  const body = response.body;
  // No stream to read (a 204, or a runtime that does not expose one) — there
  // is nothing to cap, and `text()` is the only way to get the body at all.
  if (body === null) return response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderUnavailable(
        providerKey,
        `${url} sent more than the ${maxBytes}-byte response cap`,
      );
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // `{ stream: false }` decoding of the whole buffer, so a multi-byte
  // character split across two chunks is decoded correctly — which
  // per-chunk decoding would mangle.
  return new TextDecoder("utf-8").decode(joined);
}
