// Test-only cross-package import, the shape `api-limits.drift.test.ts`
// established (and `currency-scale.drift.test.ts` before it):
// `.dependency-cruiser.cjs`'s `web-no-server-runtime-imports` rule excludes
// `*.test.ts(x)` from its `from` scope precisely so a drift guard can name
// the file the real constant lives in. Nothing is added to
// `web/package.json`'s `dependencies`, and `vite build` never reaches a
// `.test.ts`.
//
// `import "reflect-metadata"` first, for that file's own recorded reason: the
// `api/src/...` path below reaches NestJS-adjacent modules whose decorators
// evaluate at class-declaration time and consult `Reflect.defineMetadata`.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  RETURN_WINDOW_MAX_SPAN_YEARS as sourceReturnWindowMaxSpanYears,
  RETURN_WINDOW_EPOCH_FLOOR as sourceReturnWindowEpochFloor,
} from "../../../api/src/portfolios/portfolios.schema.js";
import {
  RETURN_WINDOW_MAX_SPAN_YEARS,
  RETURN_WINDOW_EPOCH_FLOOR,
  resolvePresetRange,
} from "./period-presets.js";

/**
 * The guard that was missing.
 *
 * `period-presets.ts` says it mirrors `portfolios.schema.ts`'s window bounds
 * "by value, not by import" (that file's own convention, to avoid a
 * build-time `web` -> `api` dependency). It said so for a month while
 * carrying 15 against the server's 25: the server value was raised and added
 * `api/src/instruments/history-window.drift.test.ts` R3 to catch exactly this
 * class of drift, but R3 compares the two *api* constants and no test watched
 * the web copy. The result was a `MAX` preset resolving ten years short of
 * what the server would have served, with no error anywhere.
 *
 * A claim in a doc comment is not a guarantee. This is.
 */
describe("period-presets mirrors the server's return-window bounds", () => {
  it("RETURN_WINDOW_MAX_SPAN_YEARS equals the server's", () => {
    expect(RETURN_WINDOW_MAX_SPAN_YEARS).toBe(sourceReturnWindowMaxSpanYears);
  });

  it("RETURN_WINDOW_EPOCH_FLOOR equals the server's", () => {
    expect(RETURN_WINDOW_EPOCH_FLOOR).toBe(sourceReturnWindowEpochFloor);
  });

  /**
   * The consequence, stated as behaviour rather than as an integer: `MAX` must
   * reach as far back as the server will accept. A future divergence that
   * somehow satisfied both assertions above would still fail here.
   */
  it("MAX resolves to the widest window the server accepts", () => {
    const today = "2026-09-18";
    const earliestTheServerAccepts = new Date(`${today}T00:00:00.000Z`);
    earliestTheServerAccepts.setUTCFullYear(
      earliestTheServerAccepts.getUTCFullYear() - sourceReturnWindowMaxSpanYears,
    );
    expect(resolvePresetRange("MAX", today)).toEqual({
      from: earliestTheServerAccepts.toISOString().slice(0, 10),
      to: today,
    });
  });
});
