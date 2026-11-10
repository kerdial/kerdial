// Passing fixture for the import-vocabulary gate.
//
// The boundary rule's negative case lives here: `formatToParts` is a real
// `Intl.DateTimeFormat` method the format module calls, and an unbounded
// substring search for the quantity column's header would flag it. It must not
// be a hit — a gate that cannot be used without renaming standard library calls
// is a gate that gets switched off.

export const NEAR_MISS_METHOD = "formatToParts";
export const NEAR_MISS_IDENTIFIER = "partsPerRow";

export interface Outcome {
  readonly kind: "IMPORT" | "SKIP" | "REJECT";
}
