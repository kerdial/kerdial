import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderMalformedResponse } from "@kerdial/market-ports";
import { describe, expect, it } from "vitest";
import { parseDailyXml } from "./parse-xml.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__", "ecb");
const DAILY_FIXTURE = readFileSync(join(fixturesDir, "eurofxref-daily-fixture.xml"), "utf8");

describe("parseDailyXml", () => {
  it("parses a real ECB eurofxref-daily.xml shape: dated outer Cube + currency/rate Cube leaves", () => {
    const snapshot = parseDailyXml(DAILY_FIXTURE);

    expect(snapshot.date).toBe("2024-01-10");
    expect(snapshot.rates.get("USD")).toBe("1.0850");
    expect(snapshot.rates.get("JPY")).toBe("160.50");
    expect(snapshot.rates.get("GBP")).toBe("0.8590");
    expect(snapshot.rates.get("CHF")).toBe("0.9410");
    expect(snapshot.rates.size).toBe(4);
  });

  it("has no RUB entry — matches ECB's real current feed shape (suspended since 2022-03-01)", () => {
    const snapshot = parseDailyXml(DAILY_FIXTURE);
    expect(snapshot.rates.has("RUB")).toBe(false);
  });

  it("throws ProviderMalformedResponse when no dated <Cube time=...> element is present", () => {
    expect(() => parseDailyXml("<gesmes:Envelope></gesmes:Envelope>")).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("throws ProviderMalformedResponse when a dated Cube has no currency/rate entries", () => {
    expect(() => parseDailyXml("<Cube><Cube time='2024-01-10'></Cube></Cube>")).toThrow(
      ProviderMalformedResponse,
    );
  });

  it("throws ProviderMalformedResponse on an entirely non-XML body", () => {
    expect(() => parseDailyXml("<html>not ecb</html>")).toThrow(ProviderMalformedResponse);
  });
});
