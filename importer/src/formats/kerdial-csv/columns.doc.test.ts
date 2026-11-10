import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KERDIAL_COLUMNS, KERDIAL_COLUMN_NAMES, KERDIAL_TYPE_CODES } from "./columns.js";

/**
 * EI-38 / AC-446 — the user document's column tables and its worked example are
 * **the code's own**, checked rather than maintained in parallel.
 *
 * `docs/import-export-format.md` (portfolio repo, French, user-facing) states
 * the CSV format twice over: once as two column tables, once as a complete
 * minimal file. Both are copies of something this package owns —
 * {@link KERDIAL_COLUMNS} and `__fixtures__/kerdial-csv/minimal-tier.csv` — and
 * a copy is exactly the thing that goes stale silently. A column added to the
 * table above and not to the document is a red test here, which is the same
 * anti-drift property `serialize.test.ts` gives the writer's header.
 *
 * **Why a test and not a generator.** The document's tables carry a French
 * gloss and an example per column, which no generator can produce; what is
 * mechanical is the *set* of column names and each one's tier, and that is
 * precisely what is asserted. The prose stays a review item.
 *
 * The cross-reference runs both ways: the document's section 4 names the
 * fixture path, and the fixture's own suite
 * (`pipeline/minimal-tier.integration.test.ts`) names the document section. The
 * fixture file itself carries no citation on purpose — it is a hand-authored
 * spreadsheet migrant's file, and a comment line addressed to a developer would
 * make it stop being one.
 */

const DOC = fileURLToPath(new URL("../../../../docs/import-export-format.md", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../../__fixtures__/kerdial-csv/minimal-tier.csv", import.meta.url),
);

const doc = readFileSync(DOC, "utf8");

/**
 * Every ``` `column_name` `` in the first cell of a table row — the document's
 * tables are the only place a snake_case token is in leading-cell code style,
 * so this reads the two tables without having to locate their headings.
 */
function documentedColumnNames(): string[] {
  const names: string[] = [];
  for (const line of doc.split("\n")) {
    const match = /^\| `([a-z_]+)` \|/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

describe("EI-38 — docs/import-export-format.md states this module's own table", () => {
  it("documents every column, exactly once, and no column that does not exist", () => {
    const documented = documentedColumnNames();
    expect([...documented].sort()).toStrictEqual([...KERDIAL_COLUMN_NAMES].sort());
    // …and each one only once: a duplicated row would make the set comparison
    // above pass while the reader sees two contradictory descriptions.
    expect(new Set(documented).size).toBe(documented.length);
  });

  it("puts the required tiers in section 4 and the optional tier in section 5", () => {
    // The split is the document's own structure — section 4 is "les colonnes
    // obligatoires", section 5 "les colonnes optionnelles" — and it is what
    // makes section 4 the minimal subset FR-546 asks for.
    const sectionFour = doc.slice(doc.indexOf("\n## 4."), doc.indexOf("\n## 5."));
    const sectionFive = doc.slice(doc.indexOf("\n## 5."), doc.indexOf("\n## 6."));
    const required = KERDIAL_COLUMNS.filter((column) => column.tier !== "X").map(
      (column) => column.name,
    );
    const optional = KERDIAL_COLUMNS.filter((column) => column.tier === "X").map(
      (column) => column.name,
    );

    for (const name of required) {
      expect(sectionFour, `required column ${name}`).toContain(`| \`${name}\` |`);
      expect(sectionFive, `required column ${name}`).not.toContain(`| \`${name}\` |`);
    }
    for (const name of optional) {
      expect(sectionFive, `optional column ${name}`).toContain(`| \`${name}\` |`);
      expect(sectionFour, `optional column ${name}`).not.toContain(`| \`${name}\` |`);
    }
  });

  it("states, for every column, exactly the row types the table applies it to", () => {
    // `cash-interest` I-10: a kind added to a column's `appliesTo` and not to
    // that column's row in the document is a reader told the column does not
    // apply. The « S'applique à » cell is the second-to-last one in both
    // tables; its shorthands are the document's own (`toutes`, `toutes sauf …`,
    // `idem` = the row above, `avec \`x\`` = column x's set).
    const allCodes: readonly string[] = KERDIAL_TYPE_CODES;
    const codesIn = (cell: string) => [...cell.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]!);
    const stated = new Map<string, readonly string[]>();
    let previous: readonly string[] = [];
    for (const line of doc.split("\n")) {
      const name = /^\| `([a-z_]+)` \|/.exec(line)?.[1];
      if (name === undefined) continue;
      const cells = line.split("|").slice(1, -1);
      const cell = cells[cells.length - 2]!.trim();
      const reference = /^avec `([a-z_]+)`$/.exec(cell)?.[1];
      const codes =
        cell === "toutes"
          ? allCodes
          : cell.startsWith("toutes sauf ")
            ? allCodes.filter((code) => !codesIn(cell).includes(code))
            : cell === "idem"
              ? previous
              : reference !== undefined
                ? (stated.get(reference) ?? [])
                : codesIn(cell);
      stated.set(name, codes);
      previous = codes;
    }

    for (const column of KERDIAL_COLUMNS) {
      const expected = column.appliesTo === "ALL" ? allCodes : column.appliesTo;
      expect([...(stated.get(column.name) ?? [])].sort(), `column ${column.name}`).toStrictEqual(
        [...expected].sort(),
      );
    }
  });

  it("lists every type code", () => {
    for (const code of KERDIAL_TYPE_CODES) expect(doc).toContain(`| \`${code}\` |`);
  });

  it("reproduces the committed minimal-tier fixture byte for byte", () => {
    // FR-546: section 4's worked example **is** the fixture the round-trip
    // suite imports, not an illustration of it. The fixture is CRLF-terminated
    // (the writer's own line ending) and the document is LF, so the comparison
    // is on the fixture's lines rather than on its bytes — every other
    // difference, including a single changed cell, still reddens.
    const fixture = readFileSync(FIXTURE, "utf8");
    const fixtureLines = fixture.replace(/\r\n/g, "\n").replace(/\n$/, "");

    const fence = /```csv\n([\s\S]*?)```/.exec(doc);
    expect(fence?.[1]).toBeDefined();
    expect(fence![1]!.replace(/\n$/, "")).toBe(fixtureLines);
  });

  it("names the fixture's path, so a reader can find the file the example came from", () => {
    expect(doc).toContain("importer/src/__fixtures__/kerdial-csv/minimal-tier.csv");
  });
});
