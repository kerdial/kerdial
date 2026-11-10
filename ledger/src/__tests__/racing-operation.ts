/**
 * Test-only support module (never imported by product code — it lives under
 * `src/__tests__/` for exactly the reason `ledger/tsconfig.json`'s own comment
 * gives that directory: it is this package's test-only scope, excluded from the
 * dependency-cruise). Shared by the two suites that deliberately leave a write
 * in flight to prove a concurrent interleaving:
 * `../portfolio-delete.integration.test.ts` (P-3 items 7a/7b/7c) and
 * `../transaction-write-service.integration.test.ts` (T-30's
 * delete-commits-first race). It is one module rather than a copy in each file
 * because two copies of a subtle promise-timing helper drift, and the next
 * concurrency test to be written needs one obvious thing to reach for.
 */

/** How a racing operation settled, as a value — see {@link startRacing}. */
export type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

/**
 * Starts the racing operation that is **expected to lose** an interleaving and
 * captures how it settles **in the same tick it is started**, returning a
 * `settled()` predicate (for the "still pending while the gate is held" check
 * these tests use to prove the interleaving is real) and an `outcome` promise
 * that never rejects.
 *
 * The same-tick attachment is the whole point, not a style preference. These
 * tests assert on the loser's rejection several `await`s after they release the
 * gate (`await holderDone`/`await done`, then `await deletePromise`), and the
 * loser's rejection is unblocked by exactly the commit those `await`s are
 * waiting for. Whenever the loser's failing read plus its `ROLLBACK`
 * round-trip complete before the winner's own `COMMIT` acknowledgement is read
 * off its (separate) socket — a matter of socket-read ordering, so a coin flip
 * once the machine is loaded by the rest of the suite — the rejection lands
 * while no handler is attached yet, because the `try { await editPromise }` /
 * `await expect(createPromise).rejects` that would have handled it is still one
 * macrotask away. Node then emits `unhandledRejection`; Vitest listens for that
 * event and never for the `rejectionHandled` that follows a moment later when
 * the test does attach its handler, so it reports "Vitest caught 1 unhandled
 * error during the test run" and fails the whole run **with every assertion in
 * it passing** — observed four times as an intermittent
 * `TransactionNotFoundError` out of `#reconcileGrossAmount`/`deleteTransaction`,
 * and reproducible on demand either by running those suites in four concurrent
 * Vitest processes or, deterministically, by adding one macrotask of slack
 * (`await new Promise((r) => setTimeout(r, 250))`) right after the gate is
 * released. Capturing the settlement at creation removes that window entirely:
 * no socket-read order can leave the rejection unobserved.
 *
 * This is a capture, not a swallow. Every caller asserts on the captured
 * outcome through {@link rejectionOf}, so an operation that resolves when it
 * should have rejected, or rejects with the wrong error, fails its test exactly
 * as loudly as it did before. The operations *expected to win* are deliberately
 * left as plain `await`s in those suites: a rejection there is a genuine
 * product failure that must fail the run, never a
 * green-assertions-plus-exit-1 false alarm.
 */
export function startRacing<T>(operation: Promise<T>): {
  settled: () => boolean;
  outcome: Promise<Settled<T>>;
} {
  let hasSettled = false;
  const outcome = operation.then(
    (value): Settled<T> => {
      hasSettled = true;
      return { status: "fulfilled", value };
    },
    (reason: unknown): Settled<T> => {
      hasSettled = true;
      return { status: "rejected", reason };
    },
  );
  return { settled: () => hasSettled, outcome };
}

/**
 * The rejection reason of a captured {@link startRacing} outcome — throws (so
 * the test fails) if the operation resolved instead, exactly as the
 * `throw new Error("expected ... to reject")` inside these tests' own
 * try/catch blocks used to. Callers still assert the error's identity on the
 * returned reason; this only proves *that* it rejected.
 */
export function rejectionOf<T>(outcome: Settled<T>, operationName: string): unknown {
  if (outcome.status !== "rejected") {
    throw new Error(`expected ${operationName} to reject, but it resolved`);
  }
  return outcome.reason;
}
