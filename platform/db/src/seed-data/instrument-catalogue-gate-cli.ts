/**
 * `pnpm instrument-catalogue-gate` — a thin CLI over
 * `validateSeededInstruments`, wired into `scripts/verify.sh`'s static gate
 * lane beside `no-floats-schema-gate` (IR-19,
 * DD32).
 *
 * Thin on purpose: every rule lives in the validator, which is pure and has
 * its own negative fixture per rule. All this file does is load the dataset
 * module and turn violations into an exit code. It takes an optional module
 * path (default: the sibling `instrument-catalogue.ts`) so the test suite can
 * observe **both** exit codes against checked-in fixture catalogues rather
 * than infer them.
 *
 * It loads a module and nothing else — no `fs`, no network. The validator's
 * own no-I/O property (AC-20) is asserted against
 * `instrument-catalogue-gate.ts`'s source text, not this file's.
 */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatSeedViolations, validateSeededInstruments } from "./instrument-catalogue-gate.js";

const explicitTarget = process.argv[2];
const targetUrl =
  explicitTarget === undefined
    ? new URL("./instrument-catalogue.js", import.meta.url)
    : pathToFileURL(resolve(explicitTarget));
const target = fileURLToPath(targetUrl);

let loaded: unknown;
try {
  loaded = (await import(targetUrl.href)) as unknown;
} catch (error) {
  // A missing dataset is a **failure**, not a no-op. While IR-19 shipped ahead
  // of IR-20 this branch exited 0 so the not-yet-written file would not fail
  // the build; IR-20 has since landed the dataset, and leaving the branch in
  // would mean an accidentally deleted `instrument-catalogue.ts` made this
  // whole verify lane silently pass.
  console.error(`instrument-catalogue-gate: could not load ${target}: ${String(error)}`);
  process.exit(1);
}

const exported = (loaded as { SEEDED_INSTRUMENTS?: unknown }).SEEDED_INSTRUMENTS;
if (!Array.isArray(exported)) {
  console.error(`instrument-catalogue-gate: ${target} does not export a SEEDED_INSTRUMENTS array.`);
  process.exit(1);
}

const rows: readonly unknown[] = exported;
const violations = validateSeededInstruments(rows);

if (violations.length > 0) {
  console.error(
    `instrument-catalogue-gate: found ${violations.length} violation(s) across ${rows.length} seeded instrument row(s) in ${target}:\n${formatSeedViolations(violations)}\n\nEvery seeded row must carry first-party evidence (source URL, retrieval date, verified name), a valid ISIN check digit, a curated MIC, a seeded currency, a unique UUID and a unique (isin, exchange_mic) — and no sector or industry at all (FR-16–FR-19, AC-19).`,
  );
  process.exit(1);
}

console.log(
  `instrument-catalogue-gate: ${rows.length} seeded instrument row(s) in ${target} satisfy all 11 rules.`,
);
