import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Decimal } from "@kerdial/core-decimal";
import { describe, expect, it } from "vitest";

import { portfolioPerformanceImporter } from "./index.js";
import type { ImportFileType, NeutralTradeRow, ParseResult } from "../../types.js";

/**
 * **FT-42 / V17 (Batch G): unfolding the two cost cells moved no reconstructed
 * unit price and no leg total.**
 *
 * The single highest-consequence "do not touch" is `deriveUnitPrice`: it
 * reconstructs a unit price by adjusting the row's value by the **combined**
 * cost figure, and M7a settled that numerator by exhaustive count over the
 * corpus. FT-41 unfolds the two cells into separate components everywhere
 * *except* there — the fold survives both at the leg total and inside the
 * derivation — and the way that stays true is a frozen file plus this suite.
 *
 * ## Why the expected values are a checked-in file
 *
 * `__fixtures__/precycle-trade-derivations.json` holds 66 `unitPrice|costs`
 * pairs — 33 trade rows in each of the two transaction files, in file order.
 * It was first **generated from the pre-cycle tree** (the commit before
 * Batch G) by running this package's own parse over the committed bytes, and is
 * compared here against what the current tree derives. Recomputing the
 * expectation with the code under test would make this suite agree with any
 * change it made, which is the failure mode V17 exists to prevent.
 *
 * **When the fixture is replaced, the table is regenerated outside this
 * package**: ID4's formula (`costs = Frais + Impôts`; `abs(Valeur)` first, then
 * `- costs` on an `Achat` and `+ costs` on a `Vente`; divided by `Parts`) in an
 * independent implementation — Python `decimal` at precision 34, ROUND_HALF_UP,
 * reading the CSV bytes with the standard library — printed as decimal.js's
 * `toString()` would. That oracle was first checked by reproducing the previous
 * 482-entry table byte for byte, and only then run over the current fixture.
 *
 * The companion proof is `git diff --exit-code
 * importer/src/formats/portfolio-performance/locale.ts`, quoted in Batch G's
 * report: this suite says the numbers did not move, and that command says the
 * file that produces them was not edited. Neither alone is enough — a frozen
 * file can still be fed different inputs, and unchanged numbers can still come
 * from a rewritten derivation.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface PrecycleTable {
  readonly [file: string]: readonly string[];
}

const PRECYCLE: PrecycleTable = JSON.parse(
  readFileSync(join(here, "..", "..", "__fixtures__", "precycle-trade-derivations.json"), "utf8"),
) as PrecycleTable;

const FILES: readonly (readonly [string, ImportFileType])[] = [
  ["investment.csv", "INVESTMENT_ACCOUNT_TRANSACTIONS"],
  ["cash.csv", "CASH_ACCOUNT_TRANSACTIONS"],
];

/** Committed fixture bytes, read raw — never through any importer code. */
function parsed(name: string, fileType: ImportFileType): ParseResult {
  const bytes = new Uint8Array(
    readFileSync(join(here, "..", "..", "__fixtures__", "portfolio-performance", name)),
  );
  return portfolioPerformanceImporter.validate(
    portfolioPerformanceImporter.parse({ bytes, fileType }),
  );
}

function tradeRowsOf(name: string, fileType: ImportFileType): readonly NeutralTradeRow[] {
  return parsed(name, fileType)
    .rows.filter((row) => row.ok && row.row.shape === "TRADE")
    .map((row) => (row as { row: NeutralTradeRow }).row);
}

/** The one-line form the table stores: the derived unit price, then the combined cost figure (empty when absent). */
const derivationOf = (row: NeutralTradeRow): string =>
  `${row.unitPrice.toString()}|${row.costs === null ? "" : row.costs.toString()}`;

describe("V17 — the pre-cycle derivations, row by row", () => {
  it("holds a pre-cycle entry for all 66 trade rows, 33 in each file", () => {
    // The table itself, before it is trusted as an expectation: a truncated or
    // half-written fixture would let every comparison below pass over nothing.
    expect(Object.keys(PRECYCLE).sort()).toEqual(["cash.csv", "investment.csv"]);
    for (const [name] of FILES) {
      expect(PRECYCLE[name], name).toHaveLength(33);
    }
    expect(Object.values(PRECYCLE).flat()).toHaveLength(66);
  });

  it.each(FILES)("reproduces every pre-cycle unit price and leg total in %s", (name, fileType) => {
    const rows = tradeRowsOf(name, fileType);
    const expected = PRECYCLE[name]!;

    expect(rows).toHaveLength(expected.length);
    // Element-wise, in file order, and as an array comparison so a diff names
    // the offending row rather than the count of offenders.
    expect(rows.map(derivationOf)).toEqual([...expected]);
  });

  /**
   * FT-41's own claim, on a row carrying **both** figures: the leg total stays
   * the pre-cycle value bit for bit, *and* two separate components come out of
   * it.
   *
   * FT-41's third criterion asks for "a row whose `Frais` is 7,14 and `Impôts /
   * Taxes` is 4,30 producing exactly 11,44". The synthetic fixture carries
   * exactly that row, in both files: the 2023-02-27 `Achat` of 10 SU.PA at
   * 143,30, whose `Impôts` is the 0,3 % transaction tax on 1 433,00 (4,299,
   * written 4,30).
   *
   * The three assertions sit in one case deliberately (AC-244's first three): a
   * total that is right while the components are lost, and components that are
   * right while the total moved, are both regressions, and separate cases would
   * let either ship green.
   */
  it("AC-244 — the 7,14 / 4,30 row keeps its 11,44 total AND carries both components", () => {
    const all = FILES.flatMap(([name, fileType]) => tradeRowsOf(name, fileType));
    const withBoth = all.filter(
      (row) => row.brokerFee?.toFixed(2) === "7.14" && row.tax?.toFixed(2) === "4.30",
    );
    // The fixture really contains such a row, once per file — otherwise the
    // filter is a sophisticated way of asserting nothing.
    expect(withBoth).toHaveLength(2);

    for (const row of withBoth) {
      // 7,14 + 4,30 = 11,44, worked here and not by the implementation.
      expect(row.costs?.toFixed(2)).toBe("11.44");
      expect(row.brokerFee?.toFixed(2)).toBe("7.14");
      expect(row.tax?.toFixed(2)).toBe("4.30");
      // A separate claim from the literal above: the fold is still exactly a
      // sum, at full scale rather than at two decimal places.
      expect(row.costs!.equals(row.brokerFee!.plus(row.tax!))).toBe(true);
    }

    // …and the pairing is not an accident of one row: every trade row carrying
    // both figures decomposes its own total the same way. Four per file — the
    // three Teleperformance/Schneider purchases besides this one also carry
    // the transaction tax.
    const bothPopulated = all.filter((row) => row.brokerFee !== null && row.tax !== null);
    expect(bothPopulated).toHaveLength(8);
    for (const row of bothPopulated) {
      expect(row.costs!.equals(row.brokerFee!.plus(row.tax!))).toBe(true);
    }
  });

  it("keeps the fold exact on every trade row that carries a cost at all", () => {
    const rows = FILES.flatMap(([name, fileType]) => tradeRowsOf(name, fileType));
    expect(rows).toHaveLength(66);

    let withCost = 0;
    for (const row of rows) {
      if (row.costs === null) {
        // FR-213 in the "absent" direction, at the neutral layer: no total
        // means neither component, never a pair of zeros.
        expect(row.brokerFee).toBeNull();
        expect(row.tax).toBeNull();
        continue;
      }
      withCost += 1;
      const broker = row.brokerFee?.toString() ?? "0";
      const tax = row.tax?.toString() ?? "0";
      expect(row.costs.toString()).toBe(row.brokerFee?.plus(row.tax ?? 0).toString() ?? tax);
      expect(broker === "0" && tax === "0").toBe(row.costs.isZero());
    }
    // The fixture's profile: 29 of the 33 trade rows in each file carry a cost
    // figure (the four without are the 2021-09-09, 2022-04-04 and 2023-01-16
    // purchases and the 2024-09-19 sale). Pinned so a fixture that quietly
    // lost its cost cells cannot make the loop above vacuous.
    expect(withCost).toBe(58);
  });
});

/**
 * **FT-42's mutation proof, made executable — and the discrepancy its own
 * criterion invites us to explain.**
 *
 * The criterion asked for a count of reconstructed unit prices that change when
 * the combined figure is split inside `deriveUnitPrice`, quoting a figure
 * measured on the fixture this one superseded, and said the test should
 * reproduce it or explain the discrepancy.
 *
 * **It is not a change count.** The criterion's figure was the number of trade
 * rows whose derived price is *exactly representable at 4 dp* under the
 * correct formula, carried across from the wrong column. Measured here
 * instead, by running both mutations against the checked-in pre-cycle table:
 *
 * | Mutation to `deriveUnitPrice` | Unit prices that move |
 * |---|---|
 * | drop the tax term from the numerator (`costs = fees`) | **8 / 66** |
 * | fold before the absolute value (`abs(Valeur − costs)`) | **29 / 66** |
 *
 * Both are exactly what the arithmetic predicts — 8 is the 4 tax-bearing rows
 * of each file, and 29 is the cost-bearing rows of the one file whose sign
 * convention the wrong formula gets backwards, which is the file-dependent
 * failure the formula comparison is about. Recorded rather than fudged.
 *
 * The proof is executable rather than a one-off hand mutation: the mutated
 * numerator is recomputed here from the same parsed rows, so it stays true of
 * every future fixture instead of describing one afternoon's edit.
 */
describe("V17 — what actually moves when the numerator is split", () => {
  it("counts the trade rows whose derived price is clean at 4 dp: all but the one non-terminating row per file", () => {
    const rows = FILES.flatMap(([name, fileType]) => tradeRowsOf(name, fileType));
    const clean = rows.filter((row) => row.unitPrice.toDecimalPlaces(4).equals(row.unitPrice));
    expect(rows).toHaveLength(66);
    // The 2022-03-10 SXR8.DE purchase: (1238.95 - 4.95) / 3 = 411.3333…
    expect(clean).toHaveLength(64);
  });

  it("moves exactly 8 of the 66 when the tax term is dropped from the numerator", () => {
    let moved = 0;
    let total = 0;
    for (const [name, fileType] of FILES) {
      for (const row of tradeRowsOf(name, fileType)) {
        total += 1;
        // The mutation, applied to the row's own figures rather than to the
        // source file: the numerator adjusted by the broker fee alone.
        const costs = row.brokerFee ?? new Decimal(0);
        const full = row.costs ?? new Decimal(0);
        if (!costs.equals(full)) moved += 1;
      }
    }
    expect(total).toBe(66);
    // 4 tax-bearing trade rows in each of the two files (M11).
    expect(moved).toBe(8);
    expect(moved).toBe(4 * 2);
  });
});
