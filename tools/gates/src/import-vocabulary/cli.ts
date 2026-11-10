import { join, resolve } from "node:path";
import {
  formatHits,
  IMPORT_FORMAT_LITERALS,
  KERDIAL_FORMAT_LITERALS,
  MIN_CONTAINMENT_FILES,
  MIN_FORMAT_FILES,
  MIN_KERDIAL_FORMAT_FILES,
  scanForFormatVocabulary,
} from "./index.js";

/**
 * `pnpm import-vocabulary-gate` — csv-import RC7, extended by
 * `portfolio-export-import` to the Kerdial format.
 *
 * **Two scans per format**, and the gate fails if any of them is unhappy,
 * because a containment scan alone cannot tell "clean" from "blind":
 *
 *  - **Containment** over `src/types.ts` and `src/pipeline/**`: zero hits of
 *    either format's literals, and at least `MIN_CONTAINMENT_FILES` files
 *    actually read.
 *  - **Positive floor**, once per format: all eleven Portfolio-Performance
 *    literals found under `src/formats/portfolio-performance/**`, and every
 *    Kerdial literal found under `src/formats/kerdial-csv/**`, each over at
 *    least its own minimum file count.
 *
 * **Why the second format needs its own floor rather than a widened set.** A
 * single scan over the union would report "no hits in the neutral layer"
 * without saying *which* format's vocabulary is contained — and the property
 * this gate exists to assert is per format, since each one's parsing logic is
 * supposed to be confined to its own module.
 *
 * Every cardinality is printed on success, so a scan that stops seeing its
 * subject is legible in the CI log rather than reading as "no violations" —
 * the same posture `instrument-catalogue-gate` takes with its "51 seeded rows"
 * line. **The file counts on that line are load-bearing evidence**: a change
 * that widens the gate must raise them, and one that blinds it lowers them.
 */

const packageRoot = resolve(process.argv[2] ?? "importer");
const containmentTargets = [
  join(packageRoot, "src", "types.ts"),
  join(packageRoot, "src", "pipeline"),
];
const formatTarget = join(packageRoot, "src", "formats", "portfolio-performance");
const kerdialTarget = join(packageRoot, "src", "formats", "kerdial-csv");

const failures: string[] = [];

/** One format's pair of scans: containment over the neutral layer, positive floor over its own module. */
function checkFormat(params: {
  readonly label: string;
  readonly literals: readonly string[];
  readonly target: string;
  readonly minFormatFiles: number;
}): { readonly containmentFiles: number; readonly floorFiles: number; readonly found: number } {
  const containment = scanForFormatVocabulary(containmentTargets, params.literals);
  const floor = scanForFormatVocabulary([params.target], params.literals);
  const missing = params.literals.filter((literal) => !floor.literalsFound.includes(literal));

  if (containment.hits.length > 0) {
    failures.push(
      `found ${containment.hits.length} ${params.label} literal(s) outside ${params.target}:\n${formatHits(containment.hits)}\n\nThe neutral layer must carry no format column name and no format type label (IMP-3, OD-6(a)).`,
    );
  }

  if (missing.length > 0) {
    failures.push(
      `the ${params.label} positive floor failed: ${missing.length} of ${params.literals.length} literal(s) were NOT found in ${params.target} — ${missing.map((literal) => `"${literal}"`).join(", ")}. Either the format module stopped carrying them, or this gate can no longer see what it is meant to scan.`,
    );
  }

  if (floor.filesScanned.length < params.minFormatFiles) {
    failures.push(
      `the ${params.label} positive-floor scan reached only ${floor.filesScanned.length} file(s) (minimum ${params.minFormatFiles}) under ${params.target}.`,
    );
  }

  if (containment.filesScanned.length < MIN_CONTAINMENT_FILES) {
    failures.push(
      `the ${params.label} containment scan reached only ${containment.filesScanned.length} file(s) (minimum ${MIN_CONTAINMENT_FILES}) under ${containmentTargets.join(", ")} — "no violations" from a scan that sees nothing is not a pass.`,
    );
  }

  return {
    containmentFiles: containment.filesScanned.length,
    floorFiles: floor.filesScanned.length,
    found: floor.literalsFound.length,
  };
}

const portfolioPerformance = checkFormat({
  label: "Portfolio Performance",
  literals: IMPORT_FORMAT_LITERALS,
  target: formatTarget,
  minFormatFiles: MIN_FORMAT_FILES,
});

const kerdial = checkFormat({
  label: "Kerdial CSV",
  literals: KERDIAL_FORMAT_LITERALS,
  target: kerdialTarget,
  minFormatFiles: MIN_KERDIAL_FORMAT_FILES,
});

if (failures.length > 0) {
  console.error(`import-vocabulary-gate:\n${failures.join("\n\n")}`);
  process.exitCode = 1;
} else {
  const scannedFiles = portfolioPerformance.containmentFiles + kerdial.containmentFiles;
  console.log(
    `import-vocabulary-gate: ${scannedFiles} neutral-layer file scan(s) carry 0 of the ` +
      `${IMPORT_FORMAT_LITERALS.length} + ${KERDIAL_FORMAT_LITERALS.length} format literals; ` +
      `all ${portfolioPerformance.found} are present across ${portfolioPerformance.floorFiles} file(s) in ${formatTarget}, ` +
      `and all ${kerdial.found} are present across ${kerdial.floorFiles} file(s) in ${kerdialTarget}.`,
  );
}
