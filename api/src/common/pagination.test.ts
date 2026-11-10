import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  buildCursorPage,
  decodeOffsetCursor,
  encodeOffsetCursor,
  parsePageLimit,
} from "./pagination.js";

describe("pagination — cursor pagination shared by every T-37 list endpoint", () => {
  describe("parsePageLimit", () => {
    it("defaults to DEFAULT_PAGE_LIMIT when omitted", () => {
      expect(parsePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    });

    it("parses a valid positive integer", () => {
      expect(parsePageLimit("5")).toBe(5);
    });

    it("clamps to MAX_PAGE_LIMIT", () => {
      expect(parsePageLimit("1000")).toBe(MAX_PAGE_LIMIT);
    });

    it.each(["0", "-1", "abc", "1.5", ""])("rejects %j with a 400 problem+json", (raw) => {
      expect(() => parsePageLimit(raw)).toThrow(HttpException);
    });
  });

  describe("encodeOffsetCursor / decodeOffsetCursor", () => {
    it("round-trips an offset", () => {
      expect(decodeOffsetCursor(encodeOffsetCursor(42))).toBe(42);
    });

    it("decodes undefined (no cursor) to 0", () => {
      expect(decodeOffsetCursor(undefined)).toBe(0);
    });

    it("rejects an arbitrary string this module never issued", () => {
      expect(() => decodeOffsetCursor("not-a-real-cursor")).toThrow(HttpException);
    });

    it("rejects a well-formed base64url token whose decoded content is not this module's own shape", () => {
      const forged = Buffer.from("id:some-uuid", "utf8").toString("base64url");
      expect(() => decodeOffsetCursor(forged)).toThrow(HttpException);
    });

    // F7 (security review, T-37): an offset large enough to
    // overflow `Number.isSafeInteger`, or merely absurdly large, must never
    // reach a `LIMIT`/`OFFSET` query unrejected — either shape is a 400
    // problem+json, not a 500 from whatever downstream driver chokes on it.
    it("rejects a decoded offset that overflows Number.isSafeInteger", () => {
      const forged = Buffer.from("offset:99999999999999999999999999999", "utf8").toString(
        "base64url",
      );
      expect(() => decodeOffsetCursor(forged)).toThrow(HttpException);
    });

    it("rejects a decoded offset above the 1e6 hard cap even though it is a safe integer", () => {
      const forged = Buffer.from("offset:1000001", "utf8").toString("base64url");
      expect(() => decodeOffsetCursor(forged)).toThrow(HttpException);
    });

    it("accepts a decoded offset at exactly the 1e6 hard cap", () => {
      const forged = Buffer.from("offset:1000000", "utf8").toString("base64url");
      expect(decodeOffsetCursor(forged)).toBe(1_000_000);
    });
  });

  describe("buildCursorPage", () => {
    it("returns nextCursor null when fewer than limit+1 rows were fetched (last page)", () => {
      const page = buildCursorPage(["a", "b"], 0, 5);
      expect(page.items).toEqual(["a", "b"]);
      expect(page.nextCursor).toBeNull();
    });

    it("slices to limit and returns a non-null nextCursor when limit+1 rows were fetched", () => {
      const page = buildCursorPage(["a", "b", "c"], 0, 2);
      expect(page.items).toEqual(["a", "b"]);
      expect(page.nextCursor).not.toBeNull();
      expect(decodeOffsetCursor(page.nextCursor!)).toBe(2);
    });

    it("advances the offset correctly across successive pages", () => {
      const first = buildCursorPage(["a", "b", "c"], 0, 2);
      const secondOffset = decodeOffsetCursor(first.nextCursor!);
      const second = buildCursorPage(["c"], secondOffset, 2);
      expect(second.items).toEqual(["c"]);
      expect(second.nextCursor).toBeNull();
    });
  });
});
