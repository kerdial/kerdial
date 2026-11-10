import { DEFAULT_IMPORT_LIMITS, KERDIAL_CSV_LIMITS, KERDIAL_JSON_LIMITS } from "@kerdial/importer";
import { describe, expect, it } from "vitest";

import { DEFAULT_KERDIAL_LIMIT_SETS } from "./imports/import-limits.tokens.js";
import {
  APPLY_DEADLINE_HEADROOM_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  HTTP_TIMEOUT_ENV_VAR,
  IMPORT_APPLY_CHUNK_ROWS_ENV_VAR,
  IMPORT_APPLY_DEADLINE_ENV_VAR,
  resolveRequestBudget,
} from "./request-budget.js";

/**
 * The boot-time resolution of the two request budgets a self-hosted
 * deployment can move.
 *
 * Every case below reads the *resolved* value, never the constant, and the
 * two that matter are read at **two different settings** — this repo's
 * standing rule for a tunable, and the reason `IMPORT_APPLY_DEADLINE_MS` and
 * `IMPORT_APPLY_CHUNK_ROWS` are passed through `ImportLimits` rather than read
 * from module scope inside the pipeline.
 */
describe("resolveRequestBudget", () => {
  it("resolves the shipped values when nothing is set", () => {
    const budget = resolveRequestBudget({});
    expect(budget.httpTimeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    // The value `IMPORT_APPLY_DEADLINE_MS` shipped as, reached by derivation
    // rather than restated — an unconfigured deployment is byte-for-byte what
    // it was before this file existed.
    expect(budget.importLimits.applyDeadlineMs).toBe(25_000);
    expect(budget.importLimits).toEqual(DEFAULT_IMPORT_LIMITS);
    // The same claim for the two Kerdial sets added here: derived, and
    // identical to the shipped constants when nothing is configured.
    expect(budget.kerdialLimits).toEqual(DEFAULT_KERDIAL_LIMIT_SETS);
  });

  it("moves the apply deadline with the timeout, at two settings", () => {
    const slow = resolveRequestBudget({ [HTTP_TIMEOUT_ENV_VAR]: "120000" });
    expect(slow.httpTimeoutMs).toBe(120_000);
    expect(slow.importLimits.applyDeadlineMs).toBe(120_000 - APPLY_DEADLINE_HEADROOM_MS);

    const fast = resolveRequestBudget({ [HTTP_TIMEOUT_ENV_VAR]: "10000" });
    expect(fast.httpTimeoutMs).toBe(10_000);
    // The half that matters: *lowering* the timeout lowers the deadline too.
    // A deadline left at 25 000 under a 10 000 ms timeout is not a deadline —
    // the socket closes first and the user gets no summary at all.
    expect(fast.importLimits.applyDeadlineMs).toBe(10_000 - APPLY_DEADLINE_HEADROOM_MS);
  });

  /**
   * (security review M1). The two Kerdial routes had a
   * compile-time 25 000 ms deadline that no timeout moved, so an operator who
   * lowered `HTTP_TIMEOUT_MS` got a deadline sitting *past* its own socket —
   * the one failure the whole mechanism exists to prevent.
   *
   * 12 000 ms is chosen because it is a number no set ships with: every
   * assertion below would pass on the shipped constants if it read 30 000.
   */
  it("moves all three import sets' apply deadlines together", () => {
    const budget = resolveRequestBudget({ [HTTP_TIMEOUT_ENV_VAR]: "12000" });
    const ceilingMs = 12_000 - APPLY_DEADLINE_HEADROOM_MS;

    expect(ceilingMs).toBe(7_000);
    expect(budget.importLimits.applyDeadlineMs).toBeLessThanOrEqual(ceilingMs);
    expect(budget.kerdialLimits.csv.applyDeadlineMs).toBeLessThanOrEqual(ceilingMs);
    expect(budget.kerdialLimits.json.applyDeadlineMs).toBeLessThanOrEqual(ceilingMs);

    // Everything else in the two sets is the shipped value: this resolution
    // moves the apply tunables and nothing else, so the 32 MiB / 8 MiB upload
    // ceilings and the entity chunk are untouched by a timeout change.
    expect(budget.kerdialLimits.json.maxFileBytes).toBe(KERDIAL_JSON_LIMITS.maxFileBytes);
    expect(budget.kerdialLimits.json.applyChunkEntities).toBe(
      KERDIAL_JSON_LIMITS.applyChunkEntities,
    );
    expect(budget.kerdialLimits.csv.maxRows).toBe(KERDIAL_CSV_LIMITS.maxRows);

    // The chunk knob reaches the Kerdial CSV route too — it runs the same
    // `applyImport` with the same per-chunk recompute the knob was added for.
    expect(
      resolveRequestBudget({ [IMPORT_APPLY_CHUNK_ROWS_ENV_VAR]: "10" }).kerdialLimits.csv
        .applyChunkRows,
    ).toBe(10);
  });

  it("refuses to boot when the timeout leaves no apply deadline at all", () => {
    // The minimum accepted timeout, which leaves exactly zero after the
    // headroom — so the refusal is the guard's, not the range check's.
    expect(() => resolveRequestBudget({ [HTTP_TIMEOUT_ENV_VAR]: "5000" })).toThrow(
      HTTP_TIMEOUT_ENV_VAR,
    );
  });

  it("takes an explicit apply deadline below the derived ceiling", () => {
    const budget = resolveRequestBudget({
      [HTTP_TIMEOUT_ENV_VAR]: "120000",
      [IMPORT_APPLY_DEADLINE_ENV_VAR]: "30000",
    });
    expect(budget.importLimits.applyDeadlineMs).toBe(30_000);
  });

  it("refuses an apply deadline that does not leave the response headroom", () => {
    expect(() =>
      resolveRequestBudget({
        [HTTP_TIMEOUT_ENV_VAR]: "30000",
        [IMPORT_APPLY_DEADLINE_ENV_VAR]: "29000",
      }),
    ).toThrow(IMPORT_APPLY_DEADLINE_ENV_VAR);
  });

  it("resolves the chunk size at two settings, and refuses a zero", () => {
    expect(
      resolveRequestBudget({ [IMPORT_APPLY_CHUNK_ROWS_ENV_VAR]: "10" }).importLimits.applyChunkRows,
    ).toBe(10);
    expect(
      resolveRequestBudget({ [IMPORT_APPLY_CHUNK_ROWS_ENV_VAR]: "200" }).importLimits
        .applyChunkRows,
    ).toBe(200);
    expect(() => resolveRequestBudget({ [IMPORT_APPLY_CHUNK_ROWS_ENV_VAR]: "0" })).toThrow(
      IMPORT_APPLY_CHUNK_ROWS_ENV_VAR,
    );
  });

  it("refuses a non-integer, an out-of-range timeout, and names the variable each time", () => {
    for (const value of ["abc", "30000.5", "4999", "600001"]) {
      expect(() => resolveRequestBudget({ [HTTP_TIMEOUT_ENV_VAR]: value })).toThrow(
        HTTP_TIMEOUT_ENV_VAR,
      );
    }
  });

  it("treats an empty string as unset, not as zero", () => {
    // Compose writes `HTTP_TIMEOUT_MS=` for a variable the operator left blank
    // in `.env`; refusing to boot on that would be a worse failure than
    // ignoring it.
    expect(resolveRequestBudget({ [HTTP_TIMEOUT_ENV_VAR]: "" }).httpTimeoutMs).toBe(
      DEFAULT_HTTP_TIMEOUT_MS,
    );
  });
});
