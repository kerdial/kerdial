// F4-style cross-package **test-only** import, the shape
// `api-limits.drift.test.ts` and `currency-scale.drift.test.ts` already
// established here: `.dependency-cruiser.cjs`'s `web-no-server-runtime-imports`
// excludes `*.test.ts(x)` from its `from` scope for exactly this pattern, and
// no runtime dependency on `@kerdial/importer` is added to `web` by it —
// `vite build` never reaches a `.test.ts` file.
//
// **Deep relative paths, not the `@kerdial/importer` barrel**, and for the
// reason `api-limits.drift.test.ts` records for `holdings-valuation.js`: a
// drift guard must name the file the constant actually lives in, so a failure
// says which source moved. There is a second, harder reason here —
// `CATALOGUE_REJECT_REASONS`/`CATALOGUE_SKIP_REASONS` are **not on that
// barrel** (`importer/src/index.ts` publishes `planCatalogue` and its plan type
// and nothing else from that module), and publishing them for this test alone
// would add two exports with no production reader, which is precisely what the
// `unused-exports-gate` exists to refuse.
import { IMPORT_REJECT_REASONS, IMPORT_SKIP_REASONS } from "../../../importer/src/pipeline/plan.js";
import {
  CATALOGUE_REJECT_REASONS,
  CATALOGUE_SKIP_REASONS,
  CATALOGUE_WARNING_CODES,
} from "../../../importer/src/pipeline/catalogue-plan.js";
import { PARSE_REJECT_REASONS } from "../../../importer/src/types.js";
import { describe, expect, it } from "vitest";
import { IMPORT_REASON_LABELS, importReasonLabel } from "./import-copy.js";

/**
 * The drift guard `import-copy.ts`'s own header has claimed since csv-import
 * and which **did not exist** until `portfolio-export-import` EI-36
 * (F-B): the header named `import-copy.test.ts`, no such file was
 * ever committed, and the property it describes — "a reason code added
 * server-side without French copy is a red test rather than an uppercase
 * identifier on a French screen" — was therefore carried by nothing at all.
 *
 * ## What this asserts, and why it is not an evidence test
 *
 * One cross-package coverage claim: **every code in the four closed
 * vocabularies has a sentence in `IMPORT_REASON_LABELS`**. It compares two
 * things that are edited in different packages by different people, which is
 * the kept category the test-diet cycle defines; it does not re-state what the
 * table contains, which would only assert that the file is itself.
 *
 * ## Four vocabularies, not two
 *
 * `portfolio-export-import` added a second pipeline. `plan.ts`'s pair covers
 * transaction rows; `catalogue-plan.ts`'s pair covers catalogue entries, and
 * that module says out loud why it is a separate closed set (one is a taxonomy
 * of *rows* of a transactions file, the other of *entities* of a catalogue).
 * Both already embed `PARSE_REJECT_REASONS`, which is imported here as well so
 * the assertion does not depend on that embedding continuing.
 */

const VOCABULARIES = {
  PARSE_REJECT_REASONS,
  IMPORT_SKIP_REASONS,
  IMPORT_REJECT_REASONS,
  CATALOGUE_SKIP_REASONS,
  CATALOGUE_REJECT_REASONS,
  // Warning codes share the table — same fallback, same guard.
  CATALOGUE_WARNING_CODES,
} as const satisfies Readonly<Record<string, readonly string[]>>;

describe("import-copy — the reason table against the real closed vocabularies", () => {
  it("has a French sentence for every code the importer can emit", () => {
    const missing: string[] = [];
    for (const [name, codes] of Object.entries(VOCABULARIES)) {
      for (const code of codes) {
        if (!Object.hasOwn(IMPORT_REASON_LABELS, code)) missing.push(`${name}.${code}`);
      }
    }
    // Named, not counted: a failure has to say *which* code lost its copy, or
    // the next reader has to diff two lists by hand to find out.
    expect(missing).toEqual([]);
  });

  it("renders a sentence, not the code itself, for every one of them", () => {
    const echoed = Object.values(VOCABULARIES)
      .flat()
      .filter((code) => importReasonLabel(code) === code);
    // The fallback in `importReasonLabel` is deliberate and stays — an unknown
    // code must still reach the user as *something named*. But a **known**
    // vocabulary member falling through to it means the entry is present and
    // empty, or keyed by something other than the code, which the assertion
    // above cannot see.
    expect(echoed).toEqual([]);
  });

  it("falls back to the raw code for a vocabulary this table has never heard of", () => {
    // The negative companion: the guarantee above is coverage of the *known*
    // vocabularies, not a claim that the table is exhaustive over all strings.
    expect(importReasonLabel("A_CODE_FROM_A_LATER_RELEASE")).toBe("A_CODE_FROM_A_LATER_RELEASE");
  });
});
