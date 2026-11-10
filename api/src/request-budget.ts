import {
  DEFAULT_IMPORT_LIMITS,
  KERDIAL_CSV_LIMITS,
  KERDIAL_JSON_LIMITS,
  type ImportLimits,
} from "@kerdial/importer";
import type { KerdialLimitSets } from "./imports/import-limits.tokens.js";

/**
 * The two request-shaped budgets a self-hosted deployment has to be
 * able to move without a rebuild: how long a request may run, and how long
 * the import pipeline may spend writing inside one.
 *
 * ## Why these became configurable
 *
 * They were compile-time constants with test-only overrides, sized against a
 * CI runner: `HANDLER_TIMEOUT_MS`/`CONNECTION_TIMEOUT_MS`/`REQUEST_TIMEOUT_MS`
 * at 30 s (`app.ts`), and `IMPORT_APPLY_DEADLINE_MS` at 25 s
 * (`@kerdial/importer`'s `limits.ts`, sized by GATE-1's 309-row/6.9 s
 * measurement). On the Synology deployment the same import runs several times
 * slower, and rows started coming back as `APPLY_NOT_ATTEMPTED`. The other
 * half of the fix removes the quadratic term that made that likely; this half means the
 * operator of a slow box does not need a rebuild to buy headroom.
 *
 * ## The relation between the two is the point
 *
 * The apply deadline exists **only** to sit under the handler timeout, so that
 * a slow import returns a complete, honest summary of a partial import instead
 * of a socket hang-up with no record of what landed. Two independent knobs
 * would let an operator break that with arithmetic — which is why
 * {@link resolveRequestBudget} derives the deadline from the timeout by
 * default and refuses, at boot, any explicit pair that does not leave
 * {@link APPLY_DEADLINE_HEADROOM_MS} between them.
 *
 * Every value is refused rather than clamped. A clamped misconfiguration runs
 * with a number the operator never chose and never sees; a refused one is a
 * container that does not start, with the variable named in the message.
 *
 * ## Three sets, not one
 *
 * Since `portfolio-export-import` there are **three** import limit sets behind
 * this one timeout — the Portfolio-Performance routes', the Kerdial
 * transactions route's and the Kerdial catalogue route's — and this file
 * resolves all three. The security review's M1 was that it resolved the first
 * and `api-runtime.ts` passed only that one, so the two new routes kept a
 * compile-time 25 000 ms deadline under whatever timeout the operator set.
 * {@link assertDeadlinesUnderCeiling} is the guard that makes the next such
 * omission a boot failure instead of a socket that closes first.
 */

/** Raises the whole per-request timeout triple (`handlerTimeout`, `connectionTimeout`, `requestTimeout`/`headersTimeout`). */
export const HTTP_TIMEOUT_ENV_VAR = "HTTP_TIMEOUT_MS";

/** Overrides the derived apply deadline. Rarely needed: raising {@link HTTP_TIMEOUT_ENV_VAR} moves it too. */
export const IMPORT_APPLY_DEADLINE_ENV_VAR = "IMPORT_APPLY_DEADLINE_MS";

/** Transaction rows per import write transaction and per portfolio recompute. */
export const IMPORT_APPLY_CHUNK_ROWS_ENV_VAR = "IMPORT_APPLY_CHUNK_ROWS";

/** The shipped per-request timeout, unchanged from the constant it replaced. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * How far below the handler timeout the apply deadline sits. At the default
 * timeout this makes the deadline 25 000 ms — the exact value
 * `IMPORT_APPLY_DEADLINE_MS` shipped as, so the default deployment's behaviour
 * is unchanged by this file existing.
 *
 * It is the time the request needs *after* the last row is written: building
 * the response's per-row array, serialising it, and getting it onto the
 * socket. 5 s is generous for that and cheap to leave.
 */
export const APPLY_DEADLINE_HEADROOM_MS = 5_000;

const HTTP_TIMEOUT_MIN_MS = 5_000;
const HTTP_TIMEOUT_MAX_MS = 600_000;

/**
 * The smallest apply deadline this file will hand out, and the reason a
 * timeout that leaves less than this after {@link APPLY_DEADLINE_HEADROOM_MS}
 * is refused outright rather than given a token deadline.
 *
 * Exported for `app.ts`'s own guard (F2), which states the same
 * rule at the point the deadlines are *consumed* — and needs this number to say
 * where the rule stops applying: a handler timeout leaving less than this is
 * one `resolveRequestBudget` never produces, so an app built with one is a
 * socket-behaviour fixture rather than a deployment.
 */
export const APPLY_DEADLINE_MIN_MS = 1_000;
const APPLY_CHUNK_ROWS_MIN = 1;
const APPLY_CHUNK_ROWS_MAX = 1_000;

/** What {@link resolveRequestBudget} decided, ready to hand to `buildApp`. */
export interface RequestBudget {
  /** `handlerTimeout`, `connectionTimeout` and `requestTimeout`/`headersTimeout`, which this app always sets to one value. */
  readonly httpTimeoutMs: number;
  /** `DEFAULT_IMPORT_LIMITS` with the two apply tunables resolved from env. */
  readonly importLimits: ImportLimits;
  /**
   * `DEFAULT_KERDIAL_LIMIT_SETS` with the same two apply tunables resolved the
   * same way (security review M1).
   *
   * **This member exists because its absence was a bug, not because a third
   * limit set wanted a home.** `api-runtime.ts` passed `importLimits` and no
   * `kerdialLimits`, so the two Kerdial routes ran on the module constants and
   * their `applyDeadlineMs` stayed 25 000 whatever `HTTP_TIMEOUT_MS` said. At
   * `HTTP_TIMEOUT_MS=20000` that is a deadline *past* the socket: the request
   * the deadline exists to keep honest is exactly the one it no longer bounds,
   * and the operator who lowered the timeout gets the socket hang-up the whole
   * mechanism is there to avoid.
   *
   * The catalogue set has no `applyChunkRows` — its chunk is counted in
   * entities and no env var moves it — so only the deadline travels there; the
   * Kerdial CSV set takes both, because it runs the same `applyImport` with the
   * same per-chunk recompute {@link IMPORT_APPLY_CHUNK_ROWS_ENV_VAR} exists for.
   */
  readonly kerdialLimits: KerdialLimitSets;
}

function parsePositiveInt(
  raw: string | undefined,
  variable: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `[api] refusing to boot: ${variable}=${JSON.stringify(raw)} is not an integer between ` +
        `${String(min)} and ${String(max)}.`,
    );
  }
  return value;
}

/**
 * Reads the three variables above, with the shipped values as defaults, and
 * refuses at boot anything out of range or self-contradictory.
 *
 * Called once, by `api-runtime.ts`, alongside `assertConnectionBudget` and
 * `resolveAdmissionBound` — before any pool is opened and well before
 * `listen()`, for the same reason those two are: a misconfiguration that
 * reaches a served request has already stopped being a configuration error and
 * started being an outage.
 */
export function resolveRequestBudget(
  env: Readonly<Record<string, string | undefined>>,
): RequestBudget {
  const httpTimeoutMs = parsePositiveInt(
    env[HTTP_TIMEOUT_ENV_VAR],
    HTTP_TIMEOUT_ENV_VAR,
    HTTP_TIMEOUT_MIN_MS,
    HTTP_TIMEOUT_MAX_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
  );

  // The ceiling is the timeout minus the headroom, never `DEFAULT_IMPORT_LIMITS`'
  // own 25 000: lowering the timeout must lower the deadline with it, or the
  // deadline stops being a deadline and the socket closes first.
  const applyDeadlineCeilingMs = httpTimeoutMs - APPLY_DEADLINE_HEADROOM_MS;
  if (applyDeadlineCeilingMs < APPLY_DEADLINE_MIN_MS) {
    throw new Error(
      `[api] refusing to boot: ${HTTP_TIMEOUT_ENV_VAR}=${String(httpTimeoutMs)} leaves no apply ` +
        `deadline after the ${String(APPLY_DEADLINE_HEADROOM_MS)} ms response headroom. Raise it to at ` +
        `least ${String(APPLY_DEADLINE_MIN_MS + APPLY_DEADLINE_HEADROOM_MS)}.`,
    );
  }

  const applyDeadlineMs = parsePositiveInt(
    env[IMPORT_APPLY_DEADLINE_ENV_VAR],
    IMPORT_APPLY_DEADLINE_ENV_VAR,
    APPLY_DEADLINE_MIN_MS,
    applyDeadlineCeilingMs,
    applyDeadlineCeilingMs,
  );

  const applyChunkRows = parsePositiveInt(
    env[IMPORT_APPLY_CHUNK_ROWS_ENV_VAR],
    IMPORT_APPLY_CHUNK_ROWS_ENV_VAR,
    APPLY_CHUNK_ROWS_MIN,
    APPLY_CHUNK_ROWS_MAX,
    DEFAULT_IMPORT_LIMITS.applyChunkRows,
  );

  const budget: RequestBudget = {
    httpTimeoutMs,
    importLimits: { ...DEFAULT_IMPORT_LIMITS, applyDeadlineMs, applyChunkRows },
    kerdialLimits: {
      csv: { ...KERDIAL_CSV_LIMITS, applyDeadlineMs, applyChunkRows },
      json: { ...KERDIAL_JSON_LIMITS, applyDeadlineMs },
    },
  };

  assertDeadlinesUnderCeiling(budget, applyDeadlineCeilingMs);
  return budget;
}

/**
 * The boot guard, over **every** set this function hands to `buildApp` rather
 * than over the one it happened to derive first.
 *
 * The derivation above already gives all three the same number, so this loop
 * cannot fail today, and that is the point: it is the assertion that a fourth
 * limit set added later, or one that keeps a hardcoded deadline, is a container
 * that does not start rather than a route whose deadline sits past its own
 * socket. M1 was exactly that — a set that existed, was never resolved, and
 * whose 25 000 ms constant nothing checked against a 20 000 ms timeout.
 *
 * Refused, never clamped, like every other value in this file: a clamped
 * misconfiguration runs with a number the operator never chose.
 */
function assertDeadlinesUnderCeiling(budget: RequestBudget, ceilingMs: number): void {
  const sets: readonly (readonly [string, number])[] = [
    ["Portfolio-Performance", budget.importLimits.applyDeadlineMs],
    ["Kerdial transactions", budget.kerdialLimits.csv.applyDeadlineMs],
    ["Kerdial catalogue", budget.kerdialLimits.json.applyDeadlineMs],
  ];
  for (const [name, deadlineMs] of sets) {
    if (deadlineMs > ceilingMs) {
      throw new Error(
        `[api] refusing to boot: the ${name} import set's apply deadline is ` +
          `${String(deadlineMs)} ms, over the ${String(ceilingMs)} ms left by ` +
          `${HTTP_TIMEOUT_ENV_VAR}=${String(budget.httpTimeoutMs)} minus the ` +
          `${String(APPLY_DEADLINE_HEADROOM_MS)} ms response headroom. A deadline past the ` +
          `socket is not a deadline.`,
      );
    }
  }
}
