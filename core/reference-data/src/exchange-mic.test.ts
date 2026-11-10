import { describe, expect, it } from "vitest";
import {
  CURATED_EXCHANGE_MICS,
  findMicByCode,
  MIC_UNLISTED_SENTINEL,
  micToLabel,
  PROVIDER_EXCHANGE_CODE_TO_MIC,
} from "./exchange-mic.js";

/**
 * The `exchangeMicSchema` charset-conformance drift test (DD10, NFR-5) lives in
 * `core/api-contracts/src/exchange-mic-schema-drift.test.ts` instead of
 * here — `exchangeMicSchema` is a Zod schema, and this package (like the
 * data it moved from) is deliberately framework-free: `@kerdial/core-reference-data`
 * has no workspace dependencies at all. `core/api-contracts` already depends
 * on this package one-way (`instrument-create.schema.ts` imports
 * `SECTOR_CODES`), so the drift test lives on that same side of the edge
 * rather than creating a `tsc -b` project-reference cycle.
 */

describe("CURATED_EXCHANGE_MICS — shape (DD10, NFR-5)", () => {
  it("contains at minimum Euronext Paris, NYSE, and NASDAQ, each with a non-empty French label (FR-7, decision D3)", () => {
    const byMic = new Map(CURATED_EXCHANGE_MICS.map((exchange) => [exchange.mic, exchange]));

    expect(byMic.get("XPAR")?.label).toBeTruthy();
    expect(byMic.get("XNYS")?.label).toBeTruthy();
    expect(byMic.get("XNAS")?.label).toBeTruthy();
  });

  it("carries no duplicate mic values", () => {
    const mics = CURATED_EXCHANGE_MICS.map((exchange) => exchange.mic);
    expect(new Set(mics).size).toBe(mics.length);
  });
});

describe("findMicByCode() — total function over its input domain", () => {
  it("returns the curated MIC for a mapped provider exchange code", () => {
    expect(findMicByCode("PAR")).toBe("XPAR");
  });

  it("maps the equity provider's `FRA` (Börse Frankfurt — every Morningstar fund line sits there) to XFRA, not Xetra", () => {
    expect(findMicByCode("FRA")).toBe("XFRA");
    expect(findMicByCode("GER")).toBe("XETR");
    expect(micToLabel("XFRA")).toBeTruthy();
  });

  it("returns undefined (never throws) for a code with no mapping", () => {
    expect(() => findMicByCode("NOT-A-REAL-CODE")).not.toThrow();
    expect(findMicByCode("NOT-A-REAL-CODE")).toBeUndefined();
  });

  it("every mapped value in PROVIDER_EXCHANGE_CODE_TO_MIC is itself a curated MIC (no dangling suggestion)", () => {
    const curatedMics = new Set(CURATED_EXCHANGE_MICS.map((exchange) => exchange.mic));
    for (const [code, mic] of Object.entries(PROVIDER_EXCHANGE_CODE_TO_MIC)) {
      expect(curatedMics.has(mic), `"${code}" maps to "${mic}", which is not curated`).toBe(true);
    }
  });

  // F-6 (security review): `code` comes from the provider, verbatim — a
  // plain object literal indexed with an inherited-property name resolves to
  // that inherited value (e.g. `Object.prototype` itself for `"__proto__"`)
  // rather than `undefined`, which is exactly the shape this function's
  // signature promises never to produce.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "returns undefined (never an inherited Object.prototype member) for the prototype-polluting code %j",
    (code) => {
      const result = findMicByCode(code);
      expect(result).toBeUndefined();
      expect(typeof result === "string" || result === undefined).toBe(true);
    },
  );
});

describe("micToLabel() — total function over its input domain", () => {
  it("returns the curated label for a known MIC", () => {
    expect(micToLabel("XPAR")).toBe("Euronext Paris");
  });

  it("returns undefined (never throws) for a MIC not in the curated set", () => {
    expect(() => micToLabel("ZZZZ")).not.toThrow();
    expect(micToLabel("ZZZZ")).toBeUndefined();
  });
});

describe("MIC_UNLISTED_SENTINEL — the 'Autre' escape hatch (FR-9/AC-10, DD11)", () => {
  it("never collides with any real mic value in CURATED_EXCHANGE_MICS", () => {
    const curatedMics = new Set(CURATED_EXCHANGE_MICS.map((exchange) => exchange.mic));
    expect(curatedMics.has(MIC_UNLISTED_SENTINEL)).toBe(false);
  });

  // "does not itself pass exchangeMicSchema" — moved to
  // `core/api-contracts/src/exchange-mic-schema-drift.test.ts` alongside this
  // file's own drift test, for the reason this file's header records.
});
