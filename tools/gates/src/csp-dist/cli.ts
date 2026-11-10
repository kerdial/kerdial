import { resolve } from "node:path";
import { formatFindings, scanBuiltDist } from "./index.js";

/**
 * `SH-22` — run after a web build: `pnpm --filter @kerdial/web run build && pnpm csp-dist-gate`.
 *
 * Exits non-zero on any finding **and** on a missing build, because a gate that
 * passes when it read nothing is worse than no gate.
 */
const distDir = resolve(process.argv[2] ?? "web/dist");

try {
  const result = scanBuiltDist(distDir);
  if (result.findings.length > 0) {
    console.error(
      `csp-dist-gate: ${result.findings.length} finding(s) against the built output in ${result.distDir} ` +
        `(${result.filesScanned} text files scanned):\n\n${formatFindings(result.findings)}\n\n` +
        `Each finding is a question for a human: a needed CSP widening is flagged back ` +
        `to the analyst, never applied by the developer — the directive set is cited from a prior ` +
        `security review (FR-4).`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `csp-dist-gate: the built output in ${result.distDir} (${result.filesScanned} text files) is ` +
        `compatible with the cited CSP.\nChecked:\n${result.checksRun.map((check) => `  - ${check}`).join("\n")}`,
    );
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
