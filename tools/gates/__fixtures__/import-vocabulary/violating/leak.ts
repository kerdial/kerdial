// Failing fixture for the import-vocabulary gate. Every line the gate must
// flag is annotated with why, so a reader can tell a deliberate violation from
// an accident. The line numbers below are asserted by the test.

// 1. A URL and a real violation on the SAME line. A gate that strips line
//    comments with a bare `//.*$` matches the `//` inside `https://` and
//    discards everything after it, which would hide the label at the end of
//    the next line. Three gates in this repository were narrowed exactly so.
export const REFERENCE = { docs: "https://example.invalid/pp", label: "Achat" };

// 2. A violation inside a line comment: this gate strips nothing, so the word
//    Vente on this very line is a hit like any other.

// 3. A multi-word column header, in code.
export const WITHHOLDING_COLUMN = "Impôts / Taxes";

// 4. NOT a hit: the boundary rule keeps `formatToParts` clean.
export const NEAR_MISS = "formatToParts";
