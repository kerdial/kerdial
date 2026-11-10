import { describe, expect, it } from "vitest";
import {
  importableInstrumentKindSchema,
  importInstrumentsFieldsSchema,
  importKerdialFieldsSchema,
} from "./import-request.schema.js";
import { INSTRUMENT_KIND_VALUES } from "./instrument-create.schema.js";

/**
 * `scpi` cycle — AC-511 / FR-622 (SCD-14). The Portfolio Performance
 * CSV importer never creates an SCPI, and the one way a kind reaches its apply
 * pass is the review step's echo-back (`resolutions`). That echo is parsed by
 * the field schemas below, so an SCPI in it must be refused there — a `400
 * VALIDATION_ERROR` at the route — rather than reach `apply`'s defensive
 * throw. Without `importableInstrumentKindSchema`, growing
 * `INSTRUMENT_KIND_VALUES` would have widened this echo silently.
 */
describe("import-request — the review echo never carries an SCPI (AC-511)", () => {
  function resolution(kind: string) {
    return {
      index: 0,
      action: "CREATE",
      kind,
      kindSource: "USER",
      nameSuggestsFund: false,
      exchangeMic: "XPAR",
      micSource: "USER",
      matchQuality: null,
      label: "CORUMO",
    };
  }

  it("the importable kinds are every kind except SCPI", () => {
    expect([...importableInstrumentKindSchema.options]).toEqual(
      INSTRUMENT_KIND_VALUES.filter((kind) => kind !== "SCPI"),
    );
  });

  it("a confirm echoing kind SCPI is refused on the kind field, on both import routes", () => {
    for (const schema of [importInstrumentsFieldsSchema, importKerdialFieldsSchema]) {
      const result = schema.safeParse({
        mode: "APPLY",
        resolutions: JSON.stringify([resolution("SCPI")]),
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
        "resolutions.0.kind",
      ]);
    }
  });

  it("the same confirm with a user-overridden FUND is accepted — the refusal is the kind, not the shape", () => {
    for (const schema of [importInstrumentsFieldsSchema, importKerdialFieldsSchema]) {
      const result = schema.safeParse({
        mode: "APPLY",
        resolutions: JSON.stringify([resolution("FUND")]),
      });
      expect(result.success).toBe(true);
    }
  });
});
