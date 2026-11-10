import type { ZodType } from "zod";
import { problemException, type ProblemFieldError } from "./problem.js";

/**
 * Parses `input` against `schema`, throwing a 400 `problem+json` response on
 * failure. Shared helper so every controller — `AuthController`
 * and, later, T-37/T-38/T-39's — validates its Zod DTOs the same way and
 * produces the same error shape.
 *
 * The body carries both a single joined-string `detail` (T-40's original
 * shape, kept for backward compatibility with anything only reading that
 * field) and a structured `errors` array, one entry per Zod issue with its
 * own field path and message — T-37's AC12: "rejects a
 * malformed one ... with a per-field problem+json error."
 */

/**
 * **The response is bounded, because the request is not**.
 *
 * `z.strictObject` makes the number of reported failures *caller-controlled*:
 * one 35 KB body of 3 000 junk keys is a single `unrecognized_keys` issue, and
 * fanning it out per key (below) used to re-attach that issue's own
 * key-enumerating message — length O(N) — to each of N entries. Joining those
 * into `detail` is then O(N²): measured 234 MB of response body and 833 ms of
 * blocking CPU for that 35 KB request, and an uncaught
 * `RangeError: Invalid string length` at ~94 KB, still 10× under
 * `REQUEST_BODY_LIMIT_BYTES`. The write throttles are *concurrency* caps, not
 * rate caps, so two such requests in flight saturate the event loop for every
 * tenant.
 *
 * Two bounds, therefore, and they are the reason this file has any constants:
 * the entry count, and the total `detail` length. Both truncate with an
 * explicit count rather than silently, so a caller with 3 000 bad keys is told
 * so instead of being handed the first twenty and left to infer the rest.
 */
const MAX_FIELD_ERRORS = 20;
const MAX_DETAIL_CHARS = 2_000;

/**
 * **`unrecognized_keys`, expanded to one entry per key** (AC-236, RF8).
 *
 * A `z.strictObject` reports every unknown key of one object in a **single**
 * issue whose `path` is the object's — `fee`, not `fee.currency` — with the
 * offending names in `keys`. That is enough to reject and not enough to act on:
 * the caller is told "something about `fee`" and has to guess which field to
 * remove, and the web form's own path->field table cannot route it to a slot.
 *
 * So the issue is expanded here, one `ProblemFieldError` per key, at the path
 * the key actually occupies. It is done at this boundary rather than in the
 * schema because it is a *reporting* concern — the schema's job is to refuse
 * the body, which it already does.
 *
 * Each entry names **only its own key**. Zod's own
 * `issue.message` enumerates all of them, which is the right message for one
 * issue and the wrong one to repeat N times; the field path already carries
 * which key this entry is about, so the message states the rule, not the list.
 */
function fieldErrorsFor(
  issue: {
    readonly path: readonly PropertyKey[];
    readonly message: string;
    readonly code?: string;
  },
  limit: number,
): ProblemFieldError[] {
  const base = issue.path.join(".");
  const keys = (issue as { readonly keys?: readonly string[] }).keys;
  if (issue.code === "unrecognized_keys" && keys !== undefined && keys.length > 0) {
    return keys.slice(0, limit).map((key) => ({
      field: base === "" ? key : `${base}.${key}`,
      message: `Unrecognized key: ${JSON.stringify(key)}`,
    }));
  }
  return [{ field: base || "(body)", message: issue.message }];
}

/**
 * How many entries this issue *would* contribute, without building them.
 *
 * Counted rather than materialised so the honest total can be reported while
 * only `MAX_FIELD_ERRORS` entries are ever allocated — at the 1 MB body limit
 * a top-level `strictObject` sees ~80 000 unknown keys, and a `flatMap` that
 * builds all of them to keep twenty is the same class of waste this issue is
 * about, one order down.
 */
function fieldErrorCountFor(issue: {
  readonly code?: string;
  readonly keys?: readonly string[];
}): number {
  const keys = issue.keys;
  return issue.code === "unrecognized_keys" && keys !== undefined && keys.length > 0
    ? keys.length
    : 1;
}

/**
 * Builds at most `MAX_FIELD_ERRORS` entries, stopping as soon as the cap is
 * reached, and appends one synthetic entry naming how many were dropped. The
 * count is the honest total, not the capped one — **no silent caps**: a
 * truncated list that does not say it was truncated reads as the whole set of
 * problems with the request.
 */
function boundedErrorsFor(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
    readonly code?: string;
  }[],
): { readonly errors: readonly ProblemFieldError[]; readonly total: number } {
  const total = issues.reduce((sum, issue) => sum + fieldErrorCountFor(issue), 0);
  const kept: ProblemFieldError[] = [];
  for (const issue of issues) {
    if (kept.length >= MAX_FIELD_ERRORS) break;
    for (const entry of fieldErrorsFor(issue, MAX_FIELD_ERRORS - kept.length)) {
      kept.push(entry);
    }
  }
  if (total <= MAX_FIELD_ERRORS) return { errors: kept, total };
  const dropped = total - kept.length;
  return {
    errors: [
      ...kept,
      {
        field: "(truncated)",
        message: `and ${dropped} further validation ${dropped === 1 ? "error" : "errors"} not listed (${total} in total)`,
      },
    ],
    total,
  };
}

/**
 * Joins the bounded entries into `detail` and then bounds *that* too — a
 * single Zod message is not length-limited (a long enum, a long key name), so
 * capping the entry count alone does not cap the string.
 */
function boundDetail(errors: readonly ProblemFieldError[], total: number): string {
  const detail = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
  if (detail.length <= MAX_DETAIL_CHARS) return detail;
  return `${detail.slice(0, MAX_DETAIL_CHARS)}… (${total} validation ${total === 1 ? "error" : "errors"}, truncated)`;
}

/**
 * **A NUL byte is refused here, once, for every text field**.
 * Postgres cannot store U+0000 in `text`/`varchar` (`22021`), so a NUL that
 * passed the schema used to reach the `INSERT` and surface as a 500. Checked
 * on the *parsed* value rather than added to each `z.string()`: every body
 * goes through this function, so no schema can forget it, and a value that
 * already passed its schema is bounded by that schema's own limits.
 *
 * Returns the path of the first string holding a NUL, or `null`.
 */
function firstNulPath(value: unknown, path: readonly PropertyKey[] = []): string | null {
  if (typeof value === "string") {
    return value.includes("\u0000") ? path.join(".") || "(body)" : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = firstNulPath(item, [...path, index]);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const found = firstNulPath(item, [...path, key]);
      if (found !== null) return found;
    }
  }
  return null;
}

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const { errors, total } = boundedErrorsFor(result.error.issues);
    const detail = boundDetail(errors, total);
    throw problemException(400, {
      title: "Request validation failed",
      code: "VALIDATION_ERROR",
      detail,
      errors,
    });
  }
  const nulField = firstNulPath(result.data);
  if (nulField !== null) {
    const message = "must not contain a NUL character";
    throw problemException(400, {
      title: "Request validation failed",
      code: "VALIDATION_ERROR",
      detail: `${nulField}: ${message}`,
      errors: [{ field: nulField, message }],
    });
  }
  return result.data;
}
