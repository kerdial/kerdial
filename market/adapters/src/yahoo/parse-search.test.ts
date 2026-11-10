import { ProviderMalformedResponse } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { parseSearchResponse } from "./parse-search.js";

describe("parseSearchResponse", () => {
  it("parses quotes[] entries, dropping fields it does not need", () => {
    const body = JSON.stringify({
      quotes: [
        { symbol: "AAPL", quoteType: "EQUITY", shortname: "Apple Inc.", exchange: "NMS" },
        { symbol: "AAPLC.BA", quoteType: "EQUITY" },
      ],
      news: [{ irrelevant: true }],
    });
    const candidates = parseSearchResponse(body);
    expect(candidates).toEqual([
      {
        symbol: "AAPL",
        quoteType: "EQUITY",
        shortName: "Apple Inc.",
        longName: undefined,
        exchange: "NMS",
      },
      {
        symbol: "AAPLC.BA",
        quoteType: "EQUITY",
        shortName: undefined,
        longName: undefined,
        exchange: undefined,
      },
    ]);
  });

  /**
   * IR-8 (DD21): `sector`/`industry` were previously **discarded** here.
   * They are now read with the file's own `typeof … === "string"` +
   * conditional-spread idiom, so "absent", "not a string" and "`null`" all
   * yield a genuinely **absent** property rather than one present with the
   * value `undefined` (`exactOptionalPropertyTypes: true`) — asserted below
   * with `Object.hasOwn`, which `toEqual` cannot distinguish.
   */
  it("carries sector/industry through verbatim when the entry has them", () => {
    const body = JSON.stringify({
      quotes: [
        {
          symbol: "MT.AS",
          quoteType: "EQUITY",
          shortname: "ArcelorMittal",
          exchange: "AMS",
          sector: "Basic Materials",
          sectorDisp: "Basic Materials",
          industry: "Steel",
          industryDisp: "Steel",
        },
      ],
    });
    const [candidate] = parseSearchResponse(body);

    expect(candidate?.sector).toBe("Basic Materials");
    expect(candidate?.industry).toBe("Steel");
    // A12: the `Disp` variants are deliberately not read at all.
    expect(Object.hasOwn(candidate!, "sectorDisp")).toBe(false);
    expect(Object.hasOwn(candidate!, "industryDisp")).toBe(false);
  });

  it.each([
    { label: "absent", entry: {} },
    { label: "null", entry: { sector: null, industry: null } },
    { label: "non-string", entry: { sector: 7, industry: { name: "Steel" } } },
  ])(
    "omits sector/industry entirely when they are $label — not null, not the empty string",
    ({ entry }) => {
      const body = JSON.stringify({
        quotes: [{ symbol: "AAPLC.BA", quoteType: "EQUITY", ...entry }],
      });
      const [candidate] = parseSearchResponse(body);

      expect(Object.hasOwn(candidate!, "sector")).toBe(false);
      expect(Object.hasOwn(candidate!, "industry")).toBe(false);
    },
  );

  it("treats an empty quotes[] array as a legitimate 'no matches' result, not malformed", () => {
    expect(parseSearchResponse(JSON.stringify({ quotes: [] }))).toEqual([]);
  });

  it("rejects an invalid JSON body", () => {
    expect(() => parseSearchResponse("not json")).toThrow(ProviderMalformedResponse);
  });

  it("rejects a body missing the quotes field", () => {
    expect(() => parseSearchResponse(JSON.stringify({ count: 0 }))).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("rejects a quotes[] entry missing symbol", () => {
    const body = JSON.stringify({ quotes: [{ quoteType: "EQUITY" }] });
    expect(() => parseSearchResponse(body)).toThrow(ProviderMalformedResponse);
  });

  it("rejects a quotes[] entry missing quoteType", () => {
    const body = JSON.stringify({ quotes: [{ symbol: "AAPL" }] });
    expect(() => parseSearchResponse(body)).toThrow(ProviderMalformedResponse);
  });
});
