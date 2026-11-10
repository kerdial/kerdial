import { resolve } from "node:path";
import { formatViolations, scanDirectoryForFloats } from "./index.js";

const targetDir = resolve(process.argv[2] ?? ".");

const violations = scanDirectoryForFloats(targetDir);

if (violations.length > 0) {
  console.error(
    `no-floats-schema-gate: found ${violations.length} float-ish column type(s) in ${targetDir}:\n${formatViolations(violations)}\n\nNo float/real/double precision/money type may appear in generated SQL (NFR-12).`,
  );
  process.exitCode = 1;
} else {
  console.log(`no-floats-schema-gate: no float-ish column types found under ${targetDir}.`);
}
