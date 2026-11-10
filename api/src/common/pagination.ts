import { problemException } from "./problem.js";

/**
 * Cursor pagination — the "cursor pagination on list
 * endpoints" convention, shared by every T-37 list endpoint (`GET
 * /instruments`, `GET /portfolios`).
 *
 * The cursor is an **opaque** base64url token wrapping a plain integer
 * offset into this endpoint's own stable ordering — never a raw database id
 * or row number a client could otherwise infer meaning from. This is
 * intentionally the simplest correct implementation: `GET /instruments`
 * applies it as a real `LIMIT`/`OFFSET` window at the database (`ledger`'s
 * `listInstruments`), and `GET /portfolios` applies it to the already
 * tenant-scoped in-memory array `listPortfolios` (T-17) returns — two
 * different underlying strategies behind the identical `{ items, nextCursor }`
 * response shape.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * F7 (security review, T-37): the largest offset this module
 * will ever decode. A cursor is opaque to the client, but nothing stops a
 * client from forging one — `?cursor=` never touches a signature or a
 * session-bound secret — so a huge digit string (either one that overflows
 * `Number.isSafeInteger`, or merely one absurdly larger than any real page
 * count) must be rejected here, at decode time, rather than reaching a
 * `LIMIT`/`OFFSET` query and failing downstream with whatever 500 the driver
 * produces for an out-of-range parameter.
 */
export const MAX_CURSOR_OFFSET = 1_000_000;

/** Parses a `?limit=` query value, defaulting to {@link DEFAULT_PAGE_LIMIT} and clamping to {@link MAX_PAGE_LIMIT}. Throws a 400 `problem+json` for a non-positive-integer value. */
export function parsePageLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw problemException(400, {
      title: "Invalid limit",
      code: "INVALID_LIMIT",
      detail: `limit must be a positive integer, got: ${JSON.stringify(raw)}`,
    });
  }
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

/** Encodes a plain offset into this endpoint's opaque cursor token. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

/** Decodes a `?cursor=` query value back into an offset — `undefined` (no cursor: the first page) decodes to `0`. Throws a 400 `problem+json` for anything not shaped like a cursor this module itself issued. */
export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;

  const invalid = () =>
    problemException(400, {
      title: "Invalid cursor",
      code: "INVALID_CURSOR",
      detail: `cursor is not a value this endpoint issued: ${JSON.stringify(cursor)}`,
    });

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw invalid();
  }
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw invalid();
  const offset = Number.parseInt(match[1]!, 10);
  // F7: reject anything that overflows safe-integer arithmetic, and
  // anything past MAX_CURSOR_OFFSET even if it is still a safe integer.
  if (!Number.isSafeInteger(offset) || offset > MAX_CURSOR_OFFSET) throw invalid();
  return offset;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Given up to `limit + 1` rows already fetched starting at `offset` (the
 * caller's job — this function never queries anything itself), slices to
 * `limit` items and computes the next cursor: `null` once fewer than
 * `limit + 1` rows come back, i.e. there is nothing more to fetch.
 */
export function buildCursorPage<T>(
  rowsFetchedLimitPlusOne: readonly T[],
  offset: number,
  limit: number,
): CursorPage<T> {
  const hasMore = rowsFetchedLimitPlusOne.length > limit;
  const items = hasMore ? rowsFetchedLimitPlusOne.slice(0, limit) : rowsFetchedLimitPlusOne;
  return { items, nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null };
}
