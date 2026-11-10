import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { startTestApp, type TestApp } from "./test-support/test-app.js";

/**
 * Security review finding N1 — behavioral replacement for the
 * inert configuration-only test this file supersedes
 * (`portfolios-overview.e2e.test.ts`'s old "M1 ... enforces a 30s
 * requestTimeout" describe, which only asserted
 * `httpServer.requestTimeout === 30_000`). That assertion stayed green even
 * though `requestTimeout` never actually bounds a slow *handler*: Node's
 * `server.requestTimeout` only bounds the time to receive a complete
 * request, not the time a route handler is left running once the request
 * is fully received (see `app.ts`'s own `CONNECTION_TIMEOUT_MS` doc comment
 * for the full explanation and the raw-Node proof this repo's fix is based
 * on).
 *
 * This suite builds a second, throwaway app (via `buildApp`'s test-only
 * `connectionTimeoutMs`/`registerTestRoutes` options — never used by
 * `main.ts`) with a short `connectionTimeoutMs` and one raw Fastify route
 * that sleeps for a caller-specified duration, bypassing Nest/auth entirely
 * (this is exercising Node/Fastify's own timeout machinery, not this app's
 * business routes). It reuses the shared Testcontainers-backed `db` from
 * `startTestApp()` rather than provisioning a second container — the test
 * route never touches the database, so no new container is needed.
 *
 * Red-confirm: reverting `app.ts` to configure `requestTimeout` instead of
 * `connectionTimeout` (this file's previous state) makes the "socket is
 * destroyed" test below fail — the slow route returns 200 instead of the
 * connection being killed, exactly the false-confidence this rewrite closes.
 */
describe("app.ts — connectionTimeout (N1, security review): behavioral proof, not configuration", () => {
  let testApp: TestApp;
  let shortTimeoutApp: BuiltApp;

  const SHORT_CONNECTION_TIMEOUT_MS = 500;

  beforeAll(async () => {
    testApp = await startTestApp();
    shortTimeoutApp = await buildApp({
      db: testApp.db,
      csrfSecret: "app-timeout-e2e-test-only-secret-app-timeout-e2e-test-only",
      connectionTimeoutMs: SHORT_CONNECTION_TIMEOUT_MS,
      registerTestRoutes: (instance) => {
        instance.get("/__test-only/sleep/:ms", async (request) => {
          const { ms } = request.params as { ms: string };
          const delayMs = Number.parseInt(ms, 10);
          await sleep(delayMs);
          return { slept: delayMs };
        });
      },
    });
  }, 120_000);

  afterAll(async () => {
    await shortTimeoutApp.app.close();
    await testApp.stop();
  }, 30_000);

  it("a handler well within the shortened connectionTimeout still succeeds normally", async () => {
    const response = await supertest(shortTimeoutApp.app.getHttpServer()).get(
      "/__test-only/sleep/10",
    );
    expect(response.status).toBe(200);
    expect(response.body.slept).toBe(10);
  });

  it("a handler that outlives connectionTimeout gets its socket destroyed by Node, not a 200 after the fact", async () => {
    // 3x the configured connectionTimeout — comfortably past it, so this
    // isn't a flaky near-boundary race either way.
    const sleepMs = SHORT_CONNECTION_TIMEOUT_MS * 3;
    await expect(
      supertest(shortTimeoutApp.app.getHttpServer()).get(`/__test-only/sleep/${sleepMs}`),
    ).rejects.toThrow();
  });
});

/**
 * Security review finding F-1 — behavioral proof that `handlerTimeout`
 * closes a gap `connectionTimeout` alone cannot: `connectionTimeout` (like
 * the `requestTimeout` it replaced under N1) is a Node `socket.setTimeout(...)`
 * *inactivity* timer, reset by any read/write on the socket. A client that
 * keeps a request "alive" by continuously trickling bytes — the classic
 * slowloris shape: complete headers, an announced `Content-Length`, then the
 * body dripped in one byte at a time, slower than the handler would ever
 * need but never leaving the socket idle long enough to trip
 * `connectionTimeout` — defeats it no matter how long the request actually
 * takes (see `app.ts`'s `CONNECTION_TIMEOUT_MS` doc comment for the raw-Node
 * proof this is based on: such a client ran past 5 s against a 500 ms
 * `connectionTimeout` without the connection ever being closed).
 * `handlerTimeout` is Fastify's application-level alternative: a fixed
 * wall-clock budget from routing through serialization, not reset by socket
 * activity, so it still fires while the trickle is ongoing.
 *
 * This suite talks to the app over a raw `net.Socket` rather than supertest —
 * supertest/superagent write the whole request body in one call, which
 * can't reproduce a byte-at-a-time trickle.
 *
 * Red-confirm: reverting `app.ts` to omit `handlerTimeout` (configuring only
 * `connectionTimeout`, this suite's pre-F-1 state) makes the "trickling
 * client still gets a 503" test below fail — the request never resolves at
 * all within the test's wait window, exactly the gap this finding closes.
 */
describe("app.ts — handlerTimeout (F-1, security review): bounds a continuously-active, never-idle client", () => {
  let testApp: TestApp;
  let handlerTimeoutApp: BuiltApp;

  const SHORT_HANDLER_TIMEOUT_MS = 500;
  // Deliberately large relative to the test's own duration — isolates the
  // proof to `handlerTimeout`; if this were short too, a pass here wouldn't
  // distinguish "handlerTimeout fixed it" from "connectionTimeout happened
  // to fire anyway".
  const LARGE_CONNECTION_TIMEOUT_MS = 60_000;

  beforeAll(async () => {
    testApp = await startTestApp();
    handlerTimeoutApp = await buildApp({
      db: testApp.db,
      csrfSecret: "app-handler-timeout-e2e-test-only-secret-app-handler-timeout-e2e",
      handlerTimeoutMs: SHORT_HANDLER_TIMEOUT_MS,
      connectionTimeoutMs: LARGE_CONNECTION_TIMEOUT_MS,
      registerTestRoutes: (instance) => {
        instance.post("/__test-only/echo", async (request) => ({
          received: true,
          body: request.body,
        }));
      },
    });
    // The raw `net.Socket` trickle helper below needs a real bound TCP port
    // up front (`app.getHttpServer().address()`) — unlike supertest, which
    // lazily calls `.listen(0)` on first use, this suite talks to the socket
    // directly before any supertest call would have done that for us.
    await handlerTimeoutApp.app.listen(0, "127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await handlerTimeoutApp.app.close();
    await testApp.stop();
  }, 30_000);

  /**
   * Opens a raw socket to `handlerTimeoutApp`, sends a complete request line
   * and headers announcing `contentLength`, then trickles `body` in one
   * character at a time (`perByteDelayMs` apart) — never sending faster than
   * that, and returns whatever the socket has received once either the full
   * response arrives or `maxWaitMs` elapses (whichever first). Leaves the
   * socket open and still trickling past that point when `keepTricklingAfter`
   * is true, so a caller can assert the connection wasn't merely closed out
   * from under the client (which is what `connectionTimeout` would do; this
   * helper is built to distinguish that from `handlerTimeout`'s actual
   * response).
   */
  async function trickleRequest(options: {
    body: string;
    perByteDelayMs: number;
    maxWaitMs: number;
  }): Promise<{ receivedText: string; socketClosed: boolean }> {
    const { body, perByteDelayMs, maxWaitMs } = options;
    const address = handlerTimeoutApp.app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a listening TCP server");
    }

    const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
    socket.setNoDelay(true);
    let receivedText = "";
    let socketClosed = false;
    socket.on("data", (chunk) => {
      receivedText += chunk.toString();
    });
    socket.on("close", () => {
      socketClosed = true;
    });
    socket.on("error", () => {
      // Trickling deliberately never completes the body; a subsequent write
      // after the server has already responded/closed can legitimately
      // ECONNRESET. Assertions below read `receivedText`/`socketClosed`, not
      // this rejection.
    });

    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /__test-only/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
    );

    const deadline = Date.now() + maxWaitMs;
    let sent = 0;
    while (Date.now() < deadline && sent < body.length && receivedText === "" && !socketClosed) {
      socket.write(body[sent] as string);
      sent++;
      await sleep(perByteDelayMs);
    }
    // Give the already-in-flight response, and separately the server's own
    // subsequent socket close, a moment to fully arrive. Gated on
    // `!socketClosed` alone, not also `receivedText === ""`: the response
    // body and the server's TCP close are two distinct events that can land
    // several event-loop ticks apart, so a caller asserting `socketClosed`
    // right after `receivedText` gets populated would otherwise race the
    // close event with almost no margin (CI flake, 2026-08-25 — the loop
    // above exits the instant data arrives, and the old `receivedText === ""`
    // guard here then skipped this wait entirely for exactly that case).
    if (!socketClosed) await sleep(Math.min(perByteDelayMs * 5, 500));

    socket.destroy();
    return { receivedText, socketClosed };
  }

  it("a body sent promptly, well within handlerTimeout, still succeeds normally", async () => {
    const body = JSON.stringify({ hello: "world" });
    const { receivedText } = await trickleRequest({ body, perByteDelayMs: 0, maxWaitMs: 2_000 });
    expect(receivedText).toContain("HTTP/1.1 200");
  });

  it("a client that never leaves the socket idle (continuous trickle) still gets bounded by handlerTimeout, not left hanging", async () => {
    // Comfortably larger than the JSON body below and spaced well under
    // SHORT_HANDLER_TIMEOUT_MS per byte, so the socket is never idle for
    // anywhere near 500ms straight -- if handlerTimeout weren't in play,
    // connectionTimeout's own 60s budget would leave this request hanging
    // for the entire test timeout instead.
    const body = JSON.stringify({ padding: "a".repeat(200) });
    const { receivedText } = await trickleRequest({
      body,
      perByteDelayMs: 40,
      maxWaitMs: 5_000,
    });
    // The response body has already been through this app's own
    // `ProblemJsonExceptionFilter` (RFC 7807 `application/problem+json`),
    // which doesn't surface Fastify's `FST_ERR_HANDLER_TIMEOUT` error code
    // verbatim — asserting on the status and Fastify's own timeout message
    // text is the stable, filter-independent proof that `handlerTimeout` (not
    // some other unrelated 503) is what fired.
    expect(receivedText).toContain("HTTP/1.1 503");
    expect(receivedText).toContain("Request timed out after 500 ms");
  }, 10_000);
});

/**
 * F-1 completion (security review) — behavioral proof that
 * `requestTimeout` closes the gap that remains even with `handlerTimeout`
 * (proven above) and `connectionTimeout` (proven at the top of this file)
 * both configured: `handlerTimeout` is **cooperative** (Fastify's own docs:
 * "when it fires, Fastify sends the 503 error response, but the handler's
 * async work continues to run") and does not itself close the underlying
 * socket — a client that keeps trickling request bytes past its own
 * `handlerTimeout`-triggered 503 keeps its connection open indefinitely,
 * never idle long enough to trip `connectionTimeout` either. `requestTimeout`
 * is the one mechanism here that is not cooperative and not socket-inactivity-
 * based: it is a hard deadline on request *receipt* (Node's
 * `server.requestTimeout`, checked by a periodic scan — `connectionsCheckingInterval`,
 * default 30s, shortened here purely so the test doesn't have to wait one out)
 * that fires from the moment the current HTTP message began, unaffected by
 * how recently the client last wrote a byte.
 *
 * This suite isolates that mechanism by cranking `handlerTimeout` and
 * `connectionTimeout` both up to 60s (so neither can explain a result here)
 * and shortening only `requestTimeout` (`requestTimeoutMs`) and the scan
 * interval (`connectionsCheckingIntervalMs`, both test-only overrides — see
 * `BuildAppOptions`'s own doc comments).
 *
 * Red-confirm, two ways:
 * - Omitting `requestTimeout` entirely (this repo's state before this
 *   completion — Fastify's own default, `requestTimeout: 0`/disabled) makes
 *   the "gets its connection closed" test below fail: the trickling client's
 *   connection is never closed within the wait window (the app has no receipt
 *   bound at all — `handlerTimeout`/`connectionTimeout` alone, both proven
 *   above, do not cover this shape).
 * - Configuring `requestTimeout` alone, *without* also pinning `http.headersTimeout`
 *   to the same value (i.e. leaving Node's own unrelated `headersTimeout`
 *   default of 60_000 in place — see `app.ts`'s `CONNECTION_TIMEOUT_MS` doc
 *   comment for the swap mechanics), makes the same test fail the same way:
 *   Node's `checkConnections` finds `headersTimeout (60_000) > requestTimeout (500)`
 *   and swaps them, silently making the *effective* full-request-receipt bound
 *   60s rather than the 500ms configured — the connection survives the test's
 *   3s wait window untouched, exactly the footgun this file's `app.ts` change
 *   closes by always deriving `http.headersTimeout` from the same value.
 */
describe("app.ts — requestTimeout (F-1 completion, security review): bounds request *receipt* itself, independent of handlerTimeout/connectionTimeout", () => {
  let testApp: TestApp;
  let requestTimeoutApp: BuiltApp;

  const SHORT_REQUEST_TIMEOUT_MS = 500;
  const SHORT_CONNECTIONS_CHECKING_INTERVAL_MS = 100;
  // Deliberately large relative to the test's own duration — isolates the
  // proof to requestTimeout; if either of these were short too, a pass here
  // wouldn't distinguish "requestTimeout fixed it" from "handlerTimeout or
  // connectionTimeout happened to fire anyway".
  const LARGE_HANDLER_TIMEOUT_MS = 60_000;
  const LARGE_CONNECTION_TIMEOUT_MS = 60_000;

  beforeAll(async () => {
    testApp = await startTestApp();
    requestTimeoutApp = await buildApp({
      db: testApp.db,
      csrfSecret: "app-request-timeout-e2e-test-only-secret-app-request-timeout-e2e",
      requestTimeoutMs: SHORT_REQUEST_TIMEOUT_MS,
      connectionsCheckingIntervalMs: SHORT_CONNECTIONS_CHECKING_INTERVAL_MS,
      handlerTimeoutMs: LARGE_HANDLER_TIMEOUT_MS,
      connectionTimeoutMs: LARGE_CONNECTION_TIMEOUT_MS,
      registerTestRoutes: (instance) => {
        instance.post("/__test-only/echo", async (request) => ({
          received: true,
          body: request.body,
        }));
      },
    });
    // Same reason as the `handlerTimeout` suite above — the raw `net.Socket`
    // trickle helper needs a real bound TCP port up front.
    await requestTimeoutApp.app.listen(0, "127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await requestTimeoutApp.app.close();
    await testApp.stop();
  }, 30_000);

  /** Same shape as the `handlerTimeout` suite's own `trickleRequest` above, against `requestTimeoutApp` instead. */
  async function trickleRequest(options: {
    body: string;
    perByteDelayMs: number;
    maxWaitMs: number;
  }): Promise<{ receivedText: string; socketClosed: boolean }> {
    const { body, perByteDelayMs, maxWaitMs } = options;
    const address = requestTimeoutApp.app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a listening TCP server");
    }

    const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
    socket.setNoDelay(true);
    let receivedText = "";
    let socketClosed = false;
    socket.on("data", (chunk) => {
      receivedText += chunk.toString();
    });
    socket.on("close", () => {
      socketClosed = true;
    });
    socket.on("error", () => {
      // Trickling deliberately never completes the body; a subsequent write
      // after the server has already responded/closed can legitimately
      // ECONNRESET. Assertions below read `receivedText`/`socketClosed`, not
      // this rejection.
    });

    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /__test-only/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
    );

    const deadline = Date.now() + maxWaitMs;
    let sent = 0;
    while (Date.now() < deadline && sent < body.length && receivedText === "" && !socketClosed) {
      socket.write(body[sent] as string);
      sent++;
      await sleep(perByteDelayMs);
    }
    // Give the already-in-flight response, and separately the server's own
    // subsequent socket close, a moment to fully arrive. Gated on
    // `!socketClosed` alone, not also `receivedText === ""`: the response
    // body and the server's TCP close are two distinct events that can land
    // several event-loop ticks apart, so asserting `socketClosed` right after
    // `receivedText` gets populated would otherwise race the close event with
    // almost no margin (CI flake, 2026-08-25 — the loop above exits the
    // instant data arrives, and the old `receivedText === ""` guard here then
    // skipped this wait entirely for exactly that case, which is exactly the
    // one this suite's own "gets its connection closed" test below depends
    // on).
    if (!socketClosed) await sleep(Math.min(perByteDelayMs * 5, 500));

    socket.destroy();
    return { receivedText, socketClosed };
  }

  it("a body sent promptly, well within requestTimeout, still succeeds normally", async () => {
    const body = JSON.stringify({ hello: "world" });
    const { receivedText } = await trickleRequest({ body, perByteDelayMs: 0, maxWaitMs: 2_000 });
    expect(receivedText).toContain("HTTP/1.1 200");
  });

  it("a client that never leaves the socket idle (continuous trickle) and never finishes the request gets its connection closed by requestTimeout, not left open indefinitely", async () => {
    // Same trickle shape as the `handlerTimeout` suite's own equivalent test
    // (200-byte padding, 40ms/byte) — comfortably active enough that
    // `connectionTimeout`'s 60s inactivity budget is never in play, and
    // `handlerTimeout`'s own 60s budget never gets a chance to fire either;
    // only `requestTimeout`'s 500ms request-receipt bound explains a result
    // within this test's 3s wait window.
    const body = JSON.stringify({ padding: "a".repeat(200) });
    const { receivedText, socketClosed } = await trickleRequest({
      body,
      perByteDelayMs: 40,
      maxWaitMs: 3_000,
    });
    // Node's own `408 Request Timeout` response (`_http_server.js`'s
    // `requestTimeoutResponse`), not Fastify's `FST_ERR_HANDLER_TIMEOUT` 503 —
    // the stable, filter-independent proof that `requestTimeout` (not
    // `handlerTimeout`) is what fired.
    expect(receivedText).toContain("HTTP/1.1 408");
    expect(socketClosed).toBe(true);
  }, 10_000);
});
