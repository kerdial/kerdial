/**
 * Async test helpers — the `deferred`/`waitUntil` ten-liners that used to be
 * re-declared per test file across `api`, `ledger`, `valuation` and
 * `market/composition`. Generic (no port types),
 * which is what makes `platform/test-support` the right home.
 */

/** A promise plus its externally-held `resolve` — the standard seam for pausing a code path at an exact point in a test. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Polls `check` every `pollMs` until it returns true or `timeoutMs` elapses; returns whether it ever did. The caller asserts on the result — this never throws. */
export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/** {@link waitUntil}, but failure is an error naming what was being waited for — for suites where a timeout should abort loudly rather than fail an assertion later. */
export async function waitUntilOrThrow(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
  pollMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`waitUntil timed out after ${timeoutMs} ms: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
