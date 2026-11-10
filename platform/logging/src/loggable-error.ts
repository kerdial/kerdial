/**
 * **The one error class whose `message` is data, not a sentence.**
 *
 * `platform/logging`'s own header states FR-33 as an absolute: *a monetary or
 * position value must never reach log output*. The field allow-list in
 * `logger.ts` is what implements that for structured fields. It cannot help
 * with a *string* that a caller has already assembled, and one error class
 * assembles a very particular string: `drizzle-orm` wraps every failed query in
 * a `DrizzleQueryError` whose message is
 *
 * ```
 * Failed query: <the full SQL>
 * params: <every bound parameter>
 * ```
 *
 * For any write path in this system those bound parameters are quantities,
 * prices and amounts — and `recomputeAndInvalidate` replays a whole portfolio,
 * so they are not even limited to the row that failed. One connection fault
 * while writing therefore puts a portfolio's worth of monetary values on
 * stdout, through a logger whose stated invariant forbids exactly that.
 *
 * This is deliberately **not** "an error message might contain a number". The
 * allow-list already accepts that risk for ordinary messages, and it is the
 * right trade: a message this codebase wrote about a bad argument is worth far
 * more in a log than it costs. This class is a different order of thing, and it
 * is the only one treated specially.
 *
 * **Recognised by the two literals its own constructor writes**, not by
 * `instanceof`. `platform/logging` does not depend on `drizzle-orm` and must
 * not start — it is imported by every package including `web`-adjacent ones —
 * and a cross-package `instanceof` is fragile against duplicate copies of a
 * dependency in a pnpm tree anyway. Matching the shape it emits is both looser
 * and more honest: anything that looks like a dumped query and its parameters
 * is withheld, whoever threw it.
 *
 * Lifted from `importer/src/pipeline/apply.ts`, which arrived at this exact
 * subtraction independently. Two call sites reasoning about
 * one hazard separately is how one of them ends up not reasoning about it —
 * which is the hazard here: the filter's comment names this hazard and then logs
 * the message anyway.
 */

/** Long enough for a real message, short enough that a pathological one cannot flood a log line. */
export const LOG_DETAIL_MAX_CHARS = 300;

const WITHHELD = "[the failed query and its bound parameters are withheld]";

/**
 * The class name always survives, so a withheld line still tells *what*
 * happened — it is a redaction, never a silence.
 */
export function loggableErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return `a non-Error value of type ${typeof error} was thrown`;
  }
  const className = error.constructor.name === "" ? error.name : error.constructor.name;
  const carriesBoundParameters =
    error.message.includes("Failed query:") || error.message.includes("params:");
  return carriesBoundParameters
    ? `${className}: ${WITHHELD}`
    : `${className}: ${error.message.slice(0, LOG_DETAIL_MAX_CHARS)}`;
}
