/**
 * `search-params.ts` — UR-7 (FR-132/OD-1(c), AC90-AC101).
 *
 * One shared module of hand-written `validateSearch` validators — no `zod`
 * here, mirroring the router's existing style (`router.tsx`'s
 * `overviewRoute`/`loginRoute`, `period-presets.ts`'s `isKnownPresetId`).
 * Every validator below follows that same convention: **an unrecognised/
 * malformed value falls back to a safe default (usually `undefined`) and
 * never throws** — a route's `validateSearch` runs on every navigation
 * (including a hand-edited or bookmarked URL), so a throw here would blank
 * the whole route via the router's `CatchBoundary`.
 *
 * Pagination/filter/selection state that OD-1(c) requires to live in the URL
 * (never `localStorage`/`sessionStorage`) is built out of these four
 * primitives: `asUuid` (portfolio/instrument/tx/sel ids), `asIsoDate`
 * (from/to filters), `asOpaqueCursor` (`cursor`, the server's opaque
 * pagination token), and `asEnum` (closed-set filters like `kind`/`status`).
 *
 * Adds two more for the ledger's filters panel — `asCurrencyCode`
 * and `asDecimalAmount` — for the same reason the four above exist: the panel's
 * `currency`/`minAmount`/`maxAmount` selections travel in the URL, so a
 * hand-edited or bookmarked value has to be shaped before it reaches a request.
 */

/**
 * RFC 4122's canonical 8-4-4-4-12 hex layout, any version — deliberately
 * permissive (not pinned to v4) since this only guards a URL search param
 * shape before it is forwarded as a query/path parameter; the server is the
 * actual authority on whether the id refers to anything.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID-shaped search param, or `undefined` for anything else (wrong type, empty string, malformed). */
export function asUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
}

/**
 * `YYYY-MM-DD`, calendar-valid (rejects e.g. "2024-02-30"), or `undefined`
 * for anything else. `.split("-").map(Number)` — never a bare `Number(x)`
 * call — mirrors `period-presets.ts`'s `shiftMonths` idiom: `web/src`'s
 * repo-wide no-floats syntactic ban (`eslint.config.mjs`) forbids
 * `Number(x)` call syntax outright, but a `Number` *reference* passed to
 * `.map()` never appears as that banned `CallExpression` shape.
 */
export function asIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isCalendarValid =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return isCalendarValid ? value : undefined;
}

/**
 * `cursor`: "pagination lives in the URL" — an opaque,
 * server-issued token, never parsed or constructed client-side, only
 * round-tripped. A non-empty string no longer than 256 characters, else
 * `undefined`. The 256 ceiling exists purely to keep a hand-edited/malicious
 * URL from carrying an unbounded string into a query key/request; it is not
 * a claim about the server's real token format.
 */
const MAX_OPAQUE_CURSOR_LENGTH = 256;

export function asOpaqueCursor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > MAX_OPAQUE_CURSOR_LENGTH) return undefined;
  return value;
}

/**
 * An ISO 4217 code — three uppercase letters, the identical shape
 * `currencyCodeSchema` enforces server-side
 * (`core/api-contracts/src/instrument-create.schema.ts`). Deliberately a
 * *shape* check and not a membership check against `GET /currencies`: this
 * validator runs synchronously inside `validateSearch`, which has no data to
 * consult, and the server is the authority on whether the code names a
 * currency it knows. A lowercase near-match (`"eur"`) is rejected rather than
 * upper-cased — the same "unrecognised means undefined, never a guess"
 * treatment `asEnum` gives its own near-misses.
 */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function asCurrencyCode(value: unknown): string | undefined {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value) ? value : undefined;
}

/**
 * A non-negative amount bound, kept as the **decimal string** it arrived as —
 * never parsed into a number and never re-rendered, so `"100.50"`
 * reaches `GET /transactions?minAmount=` byte-identical to what the URL
 * carried.
 *
 * The accepted shape is `zDecimal`'s own plain-numeral pattern narrowed to the
 * non-negative half that `grossAmountBoundSchema` accepts
 * (`api/src/transactions/transactions.schema.ts`): digits, optionally one
 * decimal point and more digits. Exponential notation, a leading `+`/`-`, a
 * lone `.` and thousands separators are all `undefined` here rather than a 400
 * from the server. The 32-character ceiling is the same "a hand-edited URL must
 * not carry an unbounded string into a request" guard {@link asOpaqueCursor}
 * documents, sized well past the `numeric(30,12)` column behind the filter.
 */
const DECIMAL_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const MAX_DECIMAL_AMOUNT_LENGTH = 32;

export function asDecimalAmount(value: unknown): string | undefined {
  // A hand-edited `?minAmount=500` reaches this validator as a NUMBER: the
  // router's `parseSearch` JSON-parses every value, and only the app's own
  // writes carry the JSON-quoted string form (`?minAmount=%22500%22`). The
  // double already exists by the time we see it, so `String(value)` here is
  // serialisation of the router's parse, not a float parse of ours — and the
  // shortest round-trip string is exact for any hand-typed bound. Everything
  // after (`1e30` → "1e+30", `-5` → "-5", NaN/Infinity) fails the pattern.
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string") return undefined;
  if (text.length === 0 || text.length > MAX_DECIMAL_AMOUNT_LENGTH) return undefined;
  return DECIMAL_AMOUNT_PATTERN.test(text) ? text : undefined;
}

/** A value from a closed, caller-supplied set (e.g. `InstrumentKind`, `HistoryStatusFilter`), or `undefined` for anything else. */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
