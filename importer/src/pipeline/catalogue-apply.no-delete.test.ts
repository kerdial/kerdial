import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F-E, as a property rather than a doc comment: **the import never
 * deletes an instrument.**
 *
 * csv-import's own F-B decided this when the guarantee was free — no function
 * existed that could. It is not free any more: `ledger` now ships an instrument
 * delete (MEASURED, `instrument-service.ts`, with `InstrumentDeleteBlockedError`
 * beside it), so the decision has weakened from "the function does not exist" to
 * "this package does not call it", and only a scan can say which.
 *
 * It matters more for the catalogue than for the transaction files: a catalogue
 * entry creates an instrument with **no transaction behind it**, so a partly
 * failed entry leaves exactly the over-created row someone would be tempted to
 * tidy away. `TRANSACTION_FK_HANDLING`'s `NO_DELETE_PATH` entry is "a claim
 * about the product, not about the database" — add a delete on this path and a
 * concurrent transaction write becomes an unmapped foreign-key failure.
 *
 * **This scan replaces `apply.non-regression.integration.test.ts`**, which made
 * the same assertion for the transaction path and is **MEASURED-ABSENT** (the
 * recorded test-diet cycle removed it; `apply.ts`'s own header still cites it).
 * Written as a unit scan rather than an integration test for the reason that
 * file's removal makes obvious: a property about source text should not need a
 * database to be checked.
 *
 * **It strips nothing**, exactly like `import-vocabulary-gate`: a call inside a
 * comment counts, because a commented-out delete is one uncomment away from a
 * real one. The one exclusion is this file itself, named explicitly.
 */

const PIPELINE_DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** The exported name of `ledger`'s instrument delete, and the one token this scan forbids. */
const FORBIDDEN_CALL = "deleteInstrument";

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return entry.isFile() && path.endsWith(".ts") && path !== SELF ? [path] : [];
  });
}

describe("importer — the catalogue write path never deletes an instrument (F-E)", () => {
  it("has no instrument-deleting call anywhere in the pipeline, comments included", () => {
    const files = sourceFilesUnder(PIPELINE_DIR);

    // The positive floor first: "no hits" is indistinguishable from "this scan
    // reached no files", which is this repository's own recorded failure shape.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.some((path) => path.endsWith("catalogue-apply.ts"))).toBe(true);
    expect(statSync(files[0]!).size).toBeGreaterThan(0);

    const hits = files.filter((path) => readFileSync(path, "utf8").includes(FORBIDDEN_CALL));
    expect(hits).toEqual([]);
  });
});
