import { describe, expect, it } from "vitest";
import type { ValuedAmount } from "../components/Figure.js";
import { computeAllocation } from "./allocation.js";
import { buildHoldingsMap, type HoldingsMapHolding } from "./holdings-map.js";

function amount(value: string, currency = "EUR"): ValuedAmount {
  return { amount: value, currency, provenance: { derivedFrom: [] } };
}

interface Fixture extends HoldingsMapHolding {
  readonly kind: string;
  readonly currentValue: ValuedAmount;
}

function holding(
  instrumentId: string,
  value: string,
  unrealized: string,
  costBasis: string,
  currency = "EUR",
): Fixture {
  return {
    instrumentId,
    displayName: `Nom ${instrumentId}`,
    kind: "SHARE",
    currentValue: amount(value, currency),
    unrealizedGainLoss: amount(unrealized),
    costBasis: amount(costBasis),
  };
}

function mapOf(holdings: readonly Fixture[], total: string, currency = "EUR") {
  const allocation = computeAllocation({
    holdings: holdings.map((h) => ({
      instrumentId: h.instrumentId,
      kind: h.kind,
      currentValue: h.currentValue,
    })),
    totalValue: amount(total, currency),
  });
  return buildHoldingsMap({ holdings, allocation });
}

describe("buildHoldingsMap — area is the share, colour is the P&L bucket", () => {
  const holdings = [
    holding("a", "50", "12", "38"), // +31.6 % -> gain-strong
    holding("b", "30", "-1", "31"), // -3.2 %  -> loss
    holding("c", "20", "0", "20"), // exactly flat
  ];

  it("sizes each tile in proportion to the row's own apportioned percentage", () => {
    const tiles = mapOf(holdings, "100");
    const byId = new Map(tiles.map((tile) => [tile.instrumentId, tile]));
    const areaOf = (id: string) => {
      const tile = byId.get(id)!;
      return tile.width * tile.height;
    };
    // 50/30/20 of a 100x100 percent box.
    expect(areaOf("a")).toBeCloseTo(5000, 6);
    expect(areaOf("b")).toBeCloseTo(3000, 6);
    expect(areaOf("c")).toBeCloseTo(2000, 6);
  });

  it("prints allocation.ts's own percentage string — never a re-derived one", () => {
    const tiles = mapOf(holdings, "100");
    expect(tiles.map((tile) => tile.percentageText).sort()).toEqual(["20.00%", "30.00%", "50.00%"]);
  });

  it("buckets the tone from the same ratio the printed unrealised percentage uses", () => {
    const tiles = mapOf(holdings, "100");
    const byId = new Map(tiles.map((tile) => [tile.instrumentId, tile]));
    expect(byId.get("a")!.tone).toBe("gain-strong");
    expect(byId.get("a")!.unrealizedPercentageText).toBe("31.58%");
    expect(byId.get("b")!.tone).toBe("loss");
    expect(byId.get("c")!.tone).toBe("flat");
  });

  it("paints a position with no cost basis as « non mesurable », never as flat", () => {
    const tiles = mapOf([holding("a", "50", "0", "0"), holding("b", "50", "5", "45")], "100");
    const byId = new Map(tiles.map((tile) => [tile.instrumentId, tile]));
    expect(byId.get("a")!.tone).toBe("unknown");
    expect(byId.get("a")!.unrealizedPercentageText).toBeUndefined();
    // Still a full-size tile: its *share* is known, only its return is not.
    expect(byId.get("a")!.width * byId.get("a")!.height).toBeCloseTo(5000, 6);
  });

  it("drops a row whose own percentage allocation.ts suppressed — no tile sized by a guess", () => {
    // A currency mismatch on one row: `allocation.ts` suppresses that row's
    // percentage and its `units`, so the map cannot honestly size it.
    const tiles = mapOf(
      [holding("a", "50", "5", "45"), holding("b", "50", "5", "45", "USD")],
      "100",
    );
    expect(tiles.map((tile) => tile.instrumentId)).toEqual(["a"]);
  });

  it("returns no tiles at all when the total itself is unavailable", () => {
    expect(mapOf(holdings, "0")).toEqual([]);
  });

  it("drops an allocation row with no matching holding rather than defaulting one", () => {
    const allocation = computeAllocation({
      holdings: [
        { instrumentId: "a", kind: "SHARE", currentValue: amount("50") },
        { instrumentId: "ghost", kind: "SHARE", currentValue: amount("50") },
      ],
      totalValue: amount("100"),
    });
    const tiles = buildHoldingsMap({ holdings: [holding("a", "50", "5", "45")], allocation });
    expect(tiles.map((tile) => tile.instrumentId)).toEqual(["a"]);
  });

  it("hides a small tile's text instead of ellipsising it into nothing", () => {
    const many = [
      holding("big", "970", "10", "960"),
      ...Array.from({ length: 30 }, (_unused, index) =>
        holding(`small-${index}`, "1", "0.05", "0.95"),
      ),
    ];
    const tiles = mapOf(many, "1000");
    const byId = new Map(tiles.map((tile) => [tile.instrumentId, tile]));
    expect(byId.get("big")!.showLabel).toBe(true);
    expect(byId.get("big")!.showDetail).toBe(true);
    expect(byId.get("small-0")!.showLabel).toBe(false);
    expect(byId.get("small-0")!.showDetail).toBe(false);
  });
});
